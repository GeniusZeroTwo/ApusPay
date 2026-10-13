import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import type { AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { sha256 } from "../src/server/security";
import { configuredDatabase } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(): Promise<AccountLogPage> { return { pageNo: 1, pageSize: 2000, totalSize: 0, details: [], traceId: "" }; }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("admin session and CSRF", () => {
  it("requires authentication and a matching CSRF token and Origin", async () => {
    ({ database } = configuredDatabase());
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    database.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', 'unused', ?, ?)").run(userId, now, now);
    database.query(`
      INSERT INTO sessions(id, user_id, token_hash, expires_at, created_at, last_seen_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, '', '')
    `).run(crypto.randomUUID(), userId, sha256("session-token"), new Date(Date.now() + 60_000).toISOString(), now, now);
    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });
    const payload = JSON.stringify({ v1_enabled: false, transfer_link_layer: 2, payment_poll_interval_seconds: 2 });
    expect((await app.request("http://localhost/admin-api/settings")).status).toBe(401);

    const baseHeaders = { cookie: "apuspay_session=session-token; apuspay_csrf=csrf-token", "content-type": "application/json" };
    expect((await app.request("http://localhost/admin-api/settings", { method: "PUT", headers: baseHeaders, body: payload })).status).toBe(403);
    expect((await app.request("http://localhost/admin-api/settings", { method: "PUT", headers: { ...baseHeaders, "x-csrf-token": "csrf-token", origin: "https://evil.example" }, body: payload })).status).toBe(403);
    const accepted = await app.request("http://localhost/admin-api/settings", { method: "PUT", headers: { ...baseHeaders, "x-csrf-token": "csrf-token", origin: "http://localhost" }, body: payload });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { settings: { transfer_link_layer: number; payment_poll_interval_seconds: number } };
    expect(acceptedBody.settings.transfer_link_layer).toBe(2);
    expect(acceptedBody.settings.payment_poll_interval_seconds).toBe(2);

    const invalid = await app.request("http://localhost/admin-api/settings", {
      method: "PUT",
      headers: { ...baseHeaders, "x-csrf-token": "csrf-token", origin: "http://localhost" },
      body: JSON.stringify({ transfer_link_layer: 4 }),
    });
    expect(invalid.status).toBe(400);

    const invalidPollInterval = await app.request("http://localhost/admin-api/settings", {
      method: "PUT",
      headers: { ...baseHeaders, "x-csrf-token": "csrf-token", origin: "http://localhost" },
      body: JSON.stringify({ payment_poll_interval_seconds: 1.5 }),
    });
    expect(invalidPollInterval.status).toBe(400);
  });

  it("handles login, me, and logout for both /login and /auth/login routes", async () => {
    ({ database } = configuredDatabase());
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const { createPasswordHash } = await import("../src/server/auth");
    const hash = await createPasswordHash("admin-secret-password");
    database.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)").run(userId, hash, now, now);

    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });

    // 1. Wrong password returns 401 INVALID_CREDENTIALS, not AUTH_REQUIRED
    const badLoginRes = await app.request("http://localhost/admin-api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    expect(badLoginRes.status).toBe(401);
    const badLoginBody = await badLoginRes.json() as { error: string; message: string };
    expect(badLoginBody.error).toBe("INVALID_CREDENTIALS");
    expect(badLoginBody.message).toBe("用户名或密码错误");

    // 2. Successful login via /admin-api/login
    const loginRes = await app.request("http://localhost/admin-api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin-secret-password" }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { ok: boolean; username: string; user: { username: string }; csrf_token: string };
    expect(loginBody.ok).toBe(true);
    expect(loginBody.username).toBe("admin");
    expect(loginBody.user.username).toBe("admin");
    expect(loginBody.csrf_token).toBeTruthy();

    const setCookies = loginRes.headers.get("set-cookie") ?? "";
    expect(setCookies).toContain("apuspay_session=");
    expect(setCookies).toContain("apuspay_csrf=");

    // Extract cookies for subsequent requests
    const sessionMatch = setCookies.match(/apuspay_session=([^;]+)/);
    const csrfMatch = setCookies.match(/apuspay_csrf=([^;]+)/);
    expect(sessionMatch).toBeTruthy();
    expect(csrfMatch).toBeTruthy();
    const cookieHeader = `apuspay_session=${sessionMatch![1]}; apuspay_csrf=${csrfMatch![1]}`;

    // 3. GET /admin-api/me works
    const meRes = await app.request("http://localhost/admin-api/me", {
      headers: { cookie: cookieHeader },
    });
    expect(meRes.status).toBe(200);
    const meBody = await meRes.json() as { authenticated: boolean; username: string; user: { username: string } };
    expect(meBody.authenticated).toBe(true);
    expect(meBody.username).toBe("admin");
    expect(meBody.user.username).toBe("admin");

    // 4. GET /admin-api/auth/me also works
    const authMeRes = await app.request("http://localhost/admin-api/auth/me", {
      headers: { cookie: cookieHeader },
    });
    expect(authMeRes.status).toBe(200);

    // 5. GET /admin-api/system and /admin-api/docs work
    const sysRes = await app.request("http://localhost/admin-api/system", {
      headers: { cookie: cookieHeader },
    });
    expect(sysRes.status).toBe(200);
    const sysBody = await sysRes.json() as { ready: boolean; bun_version: string };
    expect(typeof sysBody.bun_version).toBe("string");

    const docsRes = await app.request("http://localhost/admin-api/docs", {
      headers: { cookie: cookieHeader },
    });
    expect(docsRes.status).toBe(200);
    const docsBody = await docsRes.json() as { base_url: string; pid: string };
    expect(docsBody.pid).toBe("1000000001");

    // 6. POST /admin-api/logout clears session
    const logoutRes = await app.request("http://localhost/admin-api/logout", {
      method: "POST",
      headers: { cookie: cookieHeader },
    });
    expect(logoutRes.status).toBe(200);
  });

  it("rate limits brute force login attempts per target without global lockout", async () => {
    ({ database } = configuredDatabase());
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const { createPasswordHash } = await import("../src/server/auth");
    const hash = await createPasswordHash("admin-secret-password");
    database.query("INSERT INTO admin_users(id, username, password_hash, created_at, updated_at) VALUES (?, 'admin', ?, ?, ?)").run(userId, hash, now, now);

    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });

    for (let i = 0; i < 5; i++) {
      const res = await app.request("http://localhost/admin-api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "attacker_target", password: "wrong-password" }),
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt on attacker_target is rate-limited (429)
    const rateLimited = await app.request("http://localhost/admin-api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "attacker_target", password: "wrong-password" }),
    });
    expect(rateLimited.status).toBe(429);

    // Legitimate admin can still log in without being locked out
    const adminLogin = await app.request("http://localhost/admin-api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin-secret-password" }),
    });
    expect(adminLogin.status).toBe(200);
  });
});
