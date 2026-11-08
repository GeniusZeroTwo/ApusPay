import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppDatabase } from "./db";
import { getSetting } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError } from "./errors";
import { randomToken, secureEqual, sha256 } from "./security";

export const SESSION_COOKIE = "apuspay_session";
export const CSRF_COOKIE = "apuspay_csrf";

export interface AdminUser {
  id: string;
  username: string;
  created_at: string;
}

export interface AuthVariables {
  admin: AdminUser;
}

interface LoginBucket {
  failures: number[];
  blockedUntil: number;
}

const MAX_LOGIN_BUCKETS = 10_000;
const loginBuckets = new Map<string, LoginBucket>();

function pruneLoginBuckets(now: number) {
  if (loginBuckets.size < MAX_LOGIN_BUCKETS) return;
  for (const [key, bucket] of loginBuckets) {
    const activeFailures = bucket.failures.filter((time) => now - time < 15 * 60_000);
    if (activeFailures.length === 0 && bucket.blockedUntil <= now) {
      loginBuckets.delete(key);
    }
  }
  if (loginBuckets.size >= MAX_LOGIN_BUCKETS) {
    const oldestKey = loginBuckets.keys().next().value;
    if (oldestKey !== undefined) loginBuckets.delete(oldestKey);
  }
}

const socketIps = new WeakMap<Request, string>();
const lastSessionPruneAt = new WeakMap<AppDatabase, number>();
const SESSION_PRUNE_INTERVAL_MS = 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;

export function attachSocketIp(request: Request, ip: string | undefined) {
  if (ip) socketIps.set(request, ip);
}

export function clientIp(headers: Headers, rawRequest?: Request) {
  const peerIp = (rawRequest ? socketIps.get(rawRequest) : undefined) ?? "";
  if (getRuntimeEnv().trustProxy) {
    const trustCloudflare = process.env.TRUST_CLOUDFLARE === "1" || process.env.TRUST_CLOUDFLARE?.toLowerCase() === "true";
    const cfIp = trustCloudflare ? headers.get("cf-connecting-ip")?.trim() : null;
    const xff = headers.get("x-forwarded-for");
    const forwardedIp = xff
      ? xff.split(",").map((part) => part.trim()).filter(Boolean).at(-1)
      : null;
    // Prefer rightmost X-Forwarded-For over X-Real-IP so attacker-supplied X-Real-IP cannot spoof IP behind XFF proxies
    return (cfIp || forwardedIp || headers.get("x-real-ip") || peerIp || "").trim().slice(0, 128);
  }
  return peerIp.trim().slice(0, 128);
}

export function setupCompleted(database: AppDatabase) {
  return Boolean(database.query("SELECT 1 FROM admin_users LIMIT 1").get()) && getSetting(database, "setup_completed", false);
}

export function assertOriginAllowed(requestUrl: string, originOrReferer: string | undefined, database: AppDatabase) {
  if (!originOrReferer) return;
  let origin = originOrReferer;
  try {
    origin = new URL(originOrReferer).origin;
  } catch {
    throw new AppError(403, "ORIGIN_REJECTED", "请求来源格式无效");
  }
  const allowed = new Set<string>([new URL(requestUrl).origin]);
  try {
    const configured = getSetting(database, "public_base_url", "");
    if (configured) allowed.add(new URL(configured).origin);
  } catch {
    // An invalid configured public URL is handled by settings validation.
  }
  if (getRuntimeEnv().nodeEnv === "development") {
    try {
      const originUrl = new URL(origin);
      if (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") {
        allowed.add(origin);
      }
    } catch {
      // Ignore malformed origin
    }
  }
  if (!allowed.has(origin)) throw new AppError(403, "ORIGIN_REJECTED", "请求来源不受信任");
}

export function checkLoginRateLimit(key: string) {
  const now = Date.now();
  const bucket = loginBuckets.get(key);
  if (bucket?.blockedUntil && bucket.blockedUntil > now) {
    throw new AppError(429, "LOGIN_RATE_LIMITED", "尝试次数过多，请稍后再试");
  }
}

export function recordLoginFailure(key: string, maxFailures = 5) {
  const now = Date.now();
  pruneLoginBuckets(now);
  const bucket = loginBuckets.get(key) ?? { failures: [], blockedUntil: 0 };
  bucket.failures = bucket.failures.filter((time) => now - time < 15 * 60_000);
  bucket.failures.push(now);
  if (bucket.failures.length >= maxFailures) bucket.blockedUntil = now + 15 * 60_000;
  loginBuckets.set(key, bucket);
}

export function clearLoginFailures(key: string) {
  loginBuckets.delete(key);
}

export async function createPasswordHash(password: string) {
  return Bun.password.hash(password, {
    algorithm: "argon2id",
    memoryCost: 65_536,
    timeCost: 3,
  });
}

export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash, "argon2id");
}

export function createSession(database: AppDatabase, userId: string, headers: Headers, rawRequest?: Request) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + 24 * 60 * 60_000);
  database.query(`
    INSERT INTO sessions(id, user_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    userId,
    sha256(token),
    sha256(csrf),
    expires.toISOString(),
    now.toISOString(),
    now.toISOString(),
    clientIp(headers, rawRequest),
    (headers.get("user-agent") ?? "").slice(0, 512),
  );
  return { token, csrf, expires };
}

export function setAuthCookies(c: Parameters<typeof setCookie>[0], session: ReturnType<typeof createSession>) {
  const reqUrl = (c as { req?: { url?: string } }).req?.url ?? "";
  const forwardedProto = getRuntimeEnv().trustProxy
    ? ((c as { req?: { header?: (n: string) => string | undefined } }).req?.header?.("x-forwarded-proto") ?? "")
    : "";
  const isHttps = reqUrl.startsWith("https://") || forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  const secure = getRuntimeEnv().nodeEnv === "production" ? isHttps : false;
  setCookie(c, SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: session.expires,
  });
  setCookie(c, CSRF_COOKIE, session.csrf, {
    httpOnly: false,
    secure,
    sameSite: "Lax",
    path: "/",
    expires: session.expires,
  });
}

export function clearAuthCookies(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  deleteCookie(c, CSRF_COOKIE, { path: "/" });
  deleteCookie(c, "alimpay_session", { path: "/" });
  deleteCookie(c, "alimpay_csrf", { path: "/" });
}

export function authMiddleware(database: AppDatabase): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE) ?? getCookie(c, "alimpay_session") ?? "";
    if (!token) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    const lastPrune = lastSessionPruneAt.get(database) ?? 0;
    if (nowMs - lastPrune >= SESSION_PRUNE_INTERVAL_MS) {
      lastSessionPruneAt.set(database, nowMs);
      database.query("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    }

    const row = database.query(`
      SELECT u.id, u.username, u.created_at, s.token_hash, s.csrf_hash, s.last_seen_at
      FROM sessions s JOIN admin_users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(token), now) as (AdminUser & { token_hash: string; csrf_hash: string; last_seen_at: string }) | null;
    if (!row) throw new AppError(401, "SESSION_EXPIRED", "登录已过期，请重新登录");

    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      assertOriginAllowed(c.req.url, c.req.header("origin") || c.req.header("referer"), database);
      const csrfHeader = c.req.header("x-csrf-token") ?? "";
      const csrfCookie = getCookie(c, CSRF_COOKIE) ?? getCookie(c, "alimpay_csrf") ?? "";
      const cookieMatches = Boolean(csrfHeader && csrfCookie && secureEqual(csrfHeader, csrfCookie));
      const sessionBoundMatches = !row.csrf_hash || secureEqual(sha256(csrfHeader), row.csrf_hash);
      if (!cookieMatches || !sessionBoundMatches) {
        throw new AppError(403, "CSRF_REJECTED", "CSRF 校验失败，请刷新页面后重试");
      }
    }

    const lastSeenMs = Date.parse(row.last_seen_at);
    if (!Number.isFinite(lastSeenMs) || nowMs - lastSeenMs >= SESSION_TOUCH_INTERVAL_MS) {
      database.query("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, row.token_hash);
    }
    c.set("admin", { id: row.id, username: row.username, created_at: row.created_at });
    await next();
  };
}
