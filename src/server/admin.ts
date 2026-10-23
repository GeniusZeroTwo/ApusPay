import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import {
  PAYMENT_POLL_INTERVAL_MAX_SECONDS,
  PAYMENT_POLL_INTERVAL_MIN_SECONDS,
  type OrderStatus,
  type WxpayMode,
} from "../shared/contracts";
import { OfficialAlipayProvider, type PaymentScanner } from "./alipay";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  assertOriginAllowed,
  authMiddleware,
  checkLoginRateLimit,
  clearAuthCookies,
  clearLoginFailures,
  clientIp,
  createPasswordHash,
  createSession,
  recordLoginFailure,
  setAuthCookies,
  setupCompleted,
  verifyPassword,
  type AuthVariables,
} from "./auth";
import { getPublicSettings, getSecret, isGatewayReady, setSecret } from "./config";
import { audit, getSetting, setSetting, type AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError, assert } from "./errors";
import { notificationHistory, queueManualNotification } from "./notifications";
import { getOrderById, listOrders, markOrderPaidDirectly } from "./orders";
import {
  generateRsaKeyPair,
  randomAlphaNumeric,
  randomMerchantPid,
  sha256,
  validatePrivateKey,
  validatePublicKey,
  toPkcs8PrivateKey,
  toSpkiPublicKey,
} from "./security";
import { WeChatPayService } from "./wechat";

const setupSchema = z.object({
  password: z.string().min(12, "密码至少 12 位").max(128),
  public_base_url: z.string().min(1),
});

const loginSchema = z.object({
  username: z.string().default("admin"),
  password: z.string().min(1).max(128),
});

function validatePublicBaseUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new AppError(400, "INVALID_PUBLIC_URL", "公开地址必须是无账号信息的 HTTP/HTTPS URL");
  }
  return url.toString().replace(/\/$/, "");
}

function taipeiMidnight(daysAgo = 0) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Date.now() - daysAgo * 86_400_000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00+08:00`).toISOString();
}

function shanghaiTime(value: Date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function imageType(buffer: Uint8Array) {
  if (buffer.length >= 8 && Buffer.from(buffer.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", mime: "image/png" };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buffer.length >= 12 && Buffer.from(buffer.subarray(0, 4)).toString() === "RIFF" && Buffer.from(buffer.subarray(8, 12)).toString() === "WEBP") return { ext: "webp", mime: "image/webp" };
  throw new AppError(400, "INVALID_QR_IMAGE", "仅支持真实的 PNG、JPEG 或 WebP 图片");
}

export function createAdminRoutes(database: AppDatabase, scanner: PaymentScanner) {
  const app = new Hono<{ Variables: AuthVariables }>();
  const wechatService = new WeChatPayService(database);

  app.get("/setup/status", (c) => c.json({ setup_completed: setupCompleted(database) }));

  app.post("/setup", async (c) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      if (setupCompleted(database)) throw new AppError(400, "ALREADY_SETUP", "初始设置已完成");
      const json = await c.req.json().catch(() => ({}));
      const parsed = setupSchema.safeParse(json);
      if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "参数错误");
      const url = validatePublicBaseUrl(parsed.data.public_base_url);
      const hash = await createPasswordHash(parsed.data.password);
      const now = new Date().toISOString();
      database.query(`
        INSERT INTO admin_users(id, username, password_hash, created_at, updated_at)
        VALUES (?, 'admin', ?, ?, ?)
      `).run(crypto.randomUUID(), hash, now, now);
      setSetting(database, "setup_completed", true);
      setSetting(database, "public_base_url", url);
      setSetting(database, "merchant_pid", randomMerchantPid());
      setSecret(database, "v1_key", randomAlphaNumeric(32));
      const v2Platform = generateRsaKeyPair();
      const v2Merchant = generateRsaKeyPair();
      setSecret(database, "v2_platform_private_key", v2Platform.privateKey);
      setSetting(database, "v2_platform_public_key", v2Platform.publicKey);
      setSetting(database, "v2_merchant_public_key", v2Merchant.publicKey);

      const alipayKeys = generateRsaKeyPair();
      setSecret(database, "alipay_private_key", alipayKeys.privateKey);
      setSetting(database, "alipay_app_public_key", alipayKeys.publicKey);

      setSecret(database, "wxpay_hook_token", randomAlphaNumeric(32));

      audit(database, "setup.completed", { ip: clientIp(c.req.raw.headers) });
      database.exec("COMMIT");
      return c.json({ ok: true });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });

  const handleLogin = async (c: any) => {
    const ip = clientIp(c.req.raw.headers);
    const json = await c.req.json().catch(() => ({}));
    const parsed = loginSchema.safeParse(json);
    if (!parsed.success) throw new AppError(400, "VALIDATION_FAILED", "用户名或密码格式错误");
    const rateLimitKey = ip ? `${ip}:${parsed.data.username}` : `user:${parsed.data.username}`;
    const accountRateKey = `account:${parsed.data.username}`;
    checkLoginRateLimit(rateLimitKey);
    checkLoginRateLimit(accountRateKey);
    if (ip) checkLoginRateLimit(`ip:${ip}`);
    const user = database.query("SELECT * FROM admin_users WHERE username = ?").get(parsed.data.username) as {
      id: string;
      username: string;
      password_hash: string;
    } | null;
    if (!user || !(await verifyPassword(parsed.data.password, user.password_hash))) {
      recordLoginFailure(rateLimitKey);
      recordLoginFailure(accountRateKey, 20);
      if (ip) recordLoginFailure(`ip:${ip}`);
      audit(database, "auth.login_failed", { ip, details: { username: parsed.data.username } });
      throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码错误");
    }
    clearLoginFailures(rateLimitKey);
    clearLoginFailures(accountRateKey);
    if (ip) clearLoginFailures(`ip:${ip}`);
    const session = createSession(database, user.id, c.req.raw.headers);
    setAuthCookies(c, session);
    audit(database, "auth.login_success", { actor: user.username, ip });
    return c.json({
      ok: true,
      username: user.username,
      user: { username: user.username },
      csrf_token: session.csrf,
    });
  };

  app.post("/login", handleLogin);
  app.post("/auth/login", handleLogin);

  const handleLogout = (c: any) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) database.query("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    clearAuthCookies(c);
    return c.json({ ok: true });
  };

  app.post("/logout", handleLogout);
  app.post("/auth/logout", handleLogout);

  app.use("*", authMiddleware(database));

  const handleMe = (c: any) => {
    const admin = c.get("admin");
    return c.json({
      authenticated: true,
      username: admin.username,
      user: { username: admin.username },
      csrf_token: getCookie(c, CSRF_COOKIE) ?? "",
      gateway_ready: isGatewayReady(database),
    });
  };

  app.get("/me", handleMe);
  app.get("/auth/me", handleMe);

  app.get("/dashboard", (c) => {
    const todayIso = taipeiMidnight(0);
    const active = database.query("SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'expired') AND monitor_until > ?").get(new Date().toISOString()) as { count: number };
    const today = database.query(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(CASE WHEN status IN ('paid', 'late_paid') THEN 1 ELSE 0 END), 0) AS paid_count,
        COALESCE(SUM(CASE WHEN status IN ('paid', 'late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS paid_cents,
        COALESCE(SUM(CASE WHEN type = 'alipay' AND status IN ('paid', 'late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS alipay_cents,
        COALESCE(SUM(CASE WHEN type = 'wxpay' AND status IN ('paid', 'late_paid') THEN requested_amount_cents ELSE 0 END), 0) AS wxpay_cents
      FROM orders WHERE created_at >= ?
    `).get(todayIso) as { count: number; paid_count: number; paid_cents: number; alipay_cents: number; wxpay_cents: number };

    const pending = database.query("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'").get() as { count: number };
    const late = database.query("SELECT COUNT(*) AS count FROM orders WHERE status = 'late_paid'").get() as { count: number };
    const failedNotify = database.query("SELECT COUNT(*) AS count FROM notification_jobs WHERE status = 'failed'").get() as { count: number };
    const lastScan = database.query("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() as never;
    const recentOrders = database.query("SELECT * FROM orders ORDER BY created_at DESC LIMIT 10").all() as never;

    const pub = getPublicSettings(database);
    return c.json({
      today_order_count: today.count,
      today_paid_count: today.paid_count,
      today_paid_cents: today.paid_cents,
      today_alipay_cents: today.alipay_cents,
      today_wxpay_cents: today.wxpay_cents,
      pending_count: pending.count,
      late_paid_count: late.count,
      notify_failed_count: failedNotify.count,
      active_monitors: active.count,
      last_scan: lastScan ?? null,
      recent_orders: recentOrders,
      configured: isGatewayReady(database),
      alipay_configured: pub.alipay_configured,
      wxpay_configured: pub.wxpay_configured,
      collection_mode: pub.collection_mode,
    });
  });

  app.get("/orders", (c) => {
    const status = c.req.query("status") as OrderStatus | undefined;
    if (status && !["pending", "expired", "paid", "late_paid"].includes(status)) {
      throw new AppError(400, "INVALID_STATUS", "订单状态筛选值无效");
    }
    const page = Math.max(1, Number(c.req.query("page") ?? 1));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20)));
    const result = listOrders(database, {
      status,
      query: c.req.query("q")?.trim(),
      limit,
      offset: (page - 1) * limit,
    });
    return c.json({ ...result, page });
  });

  app.get("/orders/:id", (c) => {
    const order = getOrderById(database, c.req.param("id"));
    assert(order, 404, "ORDER_NOT_FOUND", "订单不存在");
    const events = database.query("SELECT * FROM payment_events WHERE matched_order_id = ? ORDER BY id DESC").all(order.id);
    return c.json({ order, payment_events: events, notifications: notificationHistory(database, order.id) });
  });

  app.post("/orders/:id/resend", (c) => {
    const id = queueManualNotification(database, c.req.param("id"));
    audit(database, "notification.manual_queue", {
      actor: c.get("admin").username,
      targetType: "order",
      targetId: c.req.param("id"),
      ip: clientIp(c.req.raw.headers),
    });
    return c.json({ ok: true, job_id: id }, 202);
  });

  app.post("/orders/:id/mark-paid", (c) => {
    const order = getOrderById(database, c.req.param("id"));
    assert(order, 404, "ORDER_NOT_FOUND", "订单不存在");
    markOrderPaidDirectly(database, order.id, {
      channel: order.type,
      channelOrderId: `MANUAL-${Date.now()}`,
      buyer: `admin:${c.get("admin").username}`,
    });
    return c.json({ ok: true });
  });

  app.post("/scans/run", async (c) => {
    const result = await scanner.scanNow("admin");
    return c.json(result);
  });

  app.get("/scans", (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 30)));
    return c.json({ data: database.query("SELECT * FROM scan_runs ORDER BY id DESC LIMIT ?").all(limit) });
  });

  app.get("/settings", (c) => c.json({
    ...getPublicSettings(database),
    transfer_user_id: getSetting(database, "transfer_user_id", ""),
    alipay_public_key: getSetting(database, "alipay_public_key", ""),
    alipay_app_public_key: getSetting(database, "alipay_app_public_key", ""),
    has_alipay_private_key: Boolean(getSecret(database, "alipay_private_key")),
    has_v1_key: Boolean(getSecret(database, "v1_key")),
    has_v2_platform_private_key: Boolean(getSecret(database, "v2_platform_private_key")),
    has_wxpay_private_key: Boolean(getSecret(database, "wxpay_private_key")),
    has_wxpay_api_v3_key: Boolean(getSecret(database, "wxpay_api_v3_key")),
    has_wxpay_hook_token: Boolean(getSecret(database, "wxpay_hook_token")),
    wxpay_hook_token: getSecret(database, "wxpay_hook_token"),
  }));

  app.put("/settings", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const allowed = new Set([
      "public_base_url", "collection_mode", "transfer_user_id",
      "alipay_enabled", "alipay_mode", "alipay_app_id", "alipay_endpoint", "alipay_public_key",
      "wxpay_enabled", "wxpay_mode", "wxpay_app_id", "wxpay_mch_id", "wxpay_serial_no", "wxpay_public_key", "wxpay_static_qr_url",
      "wxpay_hook_token",
      "transfer_link_layer", "payment_poll_interval_seconds", "v1_enabled", "v2_enabled", "business_qr_raw",
    ]);
    for (const key of Object.keys(body)) {
      if (!allowed.has(key)) throw new AppError(400, "UNKNOWN_SETTING", `不支持设置项 ${key}`);
    }

    if (typeof body.public_base_url === "string") setSetting(database, "public_base_url", validatePublicBaseUrl(body.public_base_url));
    if (typeof body.alipay_enabled === "boolean") setSetting(database, "alipay_enabled", body.alipay_enabled);
    if (["f2f", "bill", "transfer"].includes(String(body.alipay_mode))) setSetting(database, "alipay_mode", body.alipay_mode);
    if (typeof body.alipay_app_id === "string") setSetting(database, "alipay_app_id", body.alipay_app_id.trim());
    if (typeof body.alipay_endpoint === "string") {
      const endpoint = new URL(body.alipay_endpoint);
      assert(endpoint.protocol === "https:", 400, "INVALID_ALIPAY_ENDPOINT", "支付宝网关必须使用 HTTPS");
      setSetting(database, "alipay_endpoint", endpoint.toString().replace(/\/$/, ""));
    }
    if (typeof body.alipay_public_key === "string") {
      if (body.alipay_public_key) validatePublicKey(body.alipay_public_key);
      setSetting(database, "alipay_public_key", body.alipay_public_key ? toSpkiPublicKey(body.alipay_public_key) : "");
    }
    if (typeof body.business_qr_raw === "string") setSetting(database, "business_qr_raw", body.business_qr_raw.trim());

    if (typeof body.wxpay_enabled === "boolean") setSetting(database, "wxpay_enabled", body.wxpay_enabled);
    if (["native", "hook"].includes(String(body.wxpay_mode))) setSetting(database, "wxpay_mode", body.wxpay_mode);
    if (typeof body.wxpay_app_id === "string") setSetting(database, "wxpay_app_id", body.wxpay_app_id.trim());
    if (typeof body.wxpay_mch_id === "string") setSetting(database, "wxpay_mch_id", body.wxpay_mch_id.trim());
    if (typeof body.wxpay_serial_no === "string") setSetting(database, "wxpay_serial_no", body.wxpay_serial_no.trim());
    if (typeof body.wxpay_public_key === "string") {
      const trimmedPub = body.wxpay_public_key.trim();
      if (trimmedPub) validatePublicKey(trimmedPub);
      setSetting(database, "wxpay_public_key", trimmedPub ? toSpkiPublicKey(trimmedPub) : "");
    }
    if (typeof body.wxpay_static_qr_url === "string") setSetting(database, "wxpay_static_qr_url", body.wxpay_static_qr_url.trim());
    if (typeof body.wxpay_hook_token === "string") {
      const trimmedToken = body.wxpay_hook_token.trim();
      if (!trimmedToken) {
        if (!getSecret(database, "wxpay_hook_token")) {
          setSecret(database, "wxpay_hook_token", randomAlphaNumeric(32));
        } else {
          throw new AppError(400, "HOOK_TOKEN_REQUIRED", "为保障资金安全，Hook 鉴权 Token 不能为空");
        }
      } else {
        assert(trimmedToken.length >= 8, 400, "INVALID_HOOK_TOKEN", "Hook 鉴权 Token 长度至少为 8 位");
        setSecret(database, "wxpay_hook_token", trimmedToken);
      }
    }

    if (body.collection_mode === "business_qr" || body.collection_mode === "transfer") setSetting(database, "collection_mode", body.collection_mode);
    if (body.transfer_link_layer !== undefined) {
      assert(
        typeof body.transfer_link_layer === "number" && [1, 2, 3].includes(body.transfer_link_layer),
        400,
        "INVALID_TRANSFER_LINK_LAYER",
        "转账链接层级必须为 1–3",
      );
      setSetting(database, "transfer_link_layer", body.transfer_link_layer);
    }
    if (body.payment_poll_interval_seconds !== undefined) {
      assert(
        typeof body.payment_poll_interval_seconds === "number" &&
          Number.isInteger(body.payment_poll_interval_seconds) &&
          body.payment_poll_interval_seconds >= PAYMENT_POLL_INTERVAL_MIN_SECONDS &&
          body.payment_poll_interval_seconds <= PAYMENT_POLL_INTERVAL_MAX_SECONDS,
        400,
        "INVALID_PAYMENT_POLL_INTERVAL",
        `支付轮询间隔必须为 ${PAYMENT_POLL_INTERVAL_MIN_SECONDS}–${PAYMENT_POLL_INTERVAL_MAX_SECONDS} 秒的整数`,
      );
      setSetting(database, "payment_poll_interval_seconds", body.payment_poll_interval_seconds);
    }
    if (typeof body.transfer_user_id === "string") {
      assert(/^\d{8,32}$/.test(body.transfer_user_id) || body.transfer_user_id === "", 400, "INVALID_TRANSFER_USER", "支付宝用户 ID 应为 8–32 位数字");
      setSetting(database, "transfer_user_id", body.transfer_user_id);
    }
    if (typeof body.v1_enabled === "boolean") setSetting(database, "v1_enabled", body.v1_enabled);
    if (typeof body.v2_enabled === "boolean") setSetting(database, "v2_enabled", body.v2_enabled);

    audit(database, "settings.update", { actor: c.get("admin").username, details: { keys: Object.keys(body) } });
    return c.json({ ok: true, settings: getPublicSettings(database) });
  });

  app.post("/settings/qr", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    assert(file instanceof File, 400, "QR_FILE_REQUIRED", "请选择二维码图片");
    assert(file.size > 0 && file.size <= 5 * 1024 * 1024, 400, "QR_FILE_SIZE", "二维码图片必须小于 5MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = imageType(bytes);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
    mkdirSync(getRuntimeEnv().uploadDir, { recursive: true });
    const filename = `business-qr-${hash}.${detected.ext}`;
    await Bun.write(resolve(getRuntimeEnv().uploadDir, filename), bytes);
    const url = `${getSetting(database, "public_base_url", "").replace(/\/$/, "")}/uploads/${filename}`;
    setSetting(database, "business_qr_url", url);
    audit(database, "settings.qr_upload", { actor: c.get("admin").username, details: { filename, mime: detected.mime, size: file.size } });
    return c.json({ ok: true, url });
  });

  app.post("/settings/qr/wechat", async (c) => {
    const body = await c.req.parseBody();
    const file = body.file;
    assert(file instanceof File, 400, "QR_FILE_REQUIRED", "请选择二维码图片");
    assert(file.size > 0 && file.size <= 5 * 1024 * 1024, 400, "QR_FILE_SIZE", "二维码图片必须小于 5MB");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detected = imageType(bytes);
    const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 16);
    mkdirSync(getRuntimeEnv().uploadDir, { recursive: true });
    const filename = `wechat-qr-${hash}.${detected.ext}`;
    await Bun.write(resolve(getRuntimeEnv().uploadDir, filename), bytes);
    const url = `${getSetting(database, "public_base_url", "").replace(/\/$/, "")}/uploads/${filename}`;
    setSetting(database, "wxpay_static_qr_url", url);
    setSetting(database, "wxpay_mode", "hook");
    audit(database, "settings.wxpay_qr_upload", { actor: c.get("admin").username, details: { filename, mime: detected.mime, size: file.size } });
    return c.json({ ok: true, url });
  });

  app.post("/channels/test/alipay", async (c) => {
    try {
      const provider = new OfficialAlipayProvider(database);
      const sdk = provider.getSdk();
      // Try querying or test call
      assert(sdk, 500, "ALIPAY_SDK_FAILED", "无法初始化支付宝 SDK");
      return c.json({ ok: true, message: "支付宝配置及密钥解析正常" });
    } catch (err: unknown) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/channels/test/wechat", async (c) => {
    try {
      const body = await c.req.json<{ mode?: WxpayMode }>().catch(() => ({} as { mode?: WxpayMode }));
      const mode = body.mode || getSetting<WxpayMode>(database, "wxpay_mode", "native");
      if (mode === "hook") {
        const qr = getSetting(database, "wxpay_static_qr_url", "");
        assert(qr, 400, "WXPAY_QR_MISSING", "PC Hook 模式尚未上传微信个人/静态收款码");
        assert(getSecret(database, "wxpay_hook_token"), 400, "WXPAY_HOOK_TOKEN_MISSING", "PC Hook 模式尚未配置鉴权 Token");
        return c.json({ ok: true, message: "PC 微信 Hook 模式已就绪（收款码及 Token 已配置）" });
      }
      wechatService.getCredentials();
      return c.json({ ok: true, message: "微信支付证书及 API 密钥验证通过" });
    } catch (err: unknown) {
      return c.json({ ok: false, message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post("/keys/alipay/generate", (c) => {
    const pair = generateRsaKeyPair();
    setSecret(database, "alipay_private_key", pair.privateKey);
    setSetting(database, "alipay_app_public_key", pair.publicKey);
    audit(database, "keys.alipay_generate", { actor: c.get("admin").username });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey });
  });

  app.put("/keys/alipay/private", async (c) => {
    const body = await c.req.json<{ private_key?: string }>();
    assert(body.private_key, 400, "PRIVATE_KEY_REQUIRED", "应用私钥不能为空");
    validatePrivateKey(body.private_key);
    setSecret(database, "alipay_private_key", toPkcs8PrivateKey(body.private_key));
    audit(database, "keys.alipay_import", { actor: c.get("admin").username });
    return c.json({ ok: true });
  });

  app.post("/keys/alipay/private/reveal", (c) => c.json({ private_key: getSecret(database, "alipay_private_key") }));

  app.put("/keys/wxpay/secrets", async (c) => {
    const body = await c.req.json<{ private_key?: string; api_v3_key?: string; hook_token?: string }>();
    if (body.private_key !== undefined) {
      if (body.private_key) validatePrivateKey(body.private_key);
      setSecret(database, "wxpay_private_key", body.private_key ? toPkcs8PrivateKey(body.private_key) : "");
    }
    if (body.api_v3_key !== undefined) {
      if (body.api_v3_key) {
        assert(body.api_v3_key.length === 32, 400, "INVALID_V3_KEY", "APIv3 Key 必须为 32 位字符串");
      }
      setSecret(database, "wxpay_api_v3_key", body.api_v3_key.trim());
    }
    if (body.hook_token !== undefined) {
      const trimmedToken = body.hook_token.trim();
      assert(trimmedToken.length >= 8, 400, "INVALID_HOOK_TOKEN", "Hook 鉴权 Token 长度至少为 8 位且不能为空");
      setSecret(database, "wxpay_hook_token", trimmedToken);
    }
    audit(database, "keys.wxpay_secrets", { actor: c.get("admin").username });
    return c.json({ ok: true });
  });

  app.post("/keys/v1/regenerate", (c) => {
    const pid = getSetting(database, "merchant_pid", "") || randomMerchantPid();
    const key = randomAlphaNumeric(32);
    setSetting(database, "merchant_pid", pid);
    setSecret(database, "v1_key", key);
    audit(database, "keys.v1_regenerate", { actor: c.get("admin").username });
    return c.json({ pid, key });
  });

  app.post("/keys/v1/reveal", (c) => c.json({
    pid: getSetting(database, "merchant_pid", ""),
    key: getSecret(database, "v1_key"),
  }));

  app.post("/keys/v2/platform/regenerate", (c) => {
    const pair = generateRsaKeyPair();
    setSecret(database, "v2_platform_private_key", pair.privateKey);
    setSetting(database, "v2_platform_public_key", pair.publicKey);
    audit(database, "keys.v2_platform_regenerate", { actor: c.get("admin").username });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey });
  });

  app.post("/keys/v2/merchant/generate", (c) => {
    const pair = generateRsaKeyPair();
    setSetting(database, "v2_merchant_public_key", pair.publicKey);
    audit(database, "keys.v2_merchant_generate", { actor: c.get("admin").username });
    return c.json({ private_key: pair.privateKey, public_key: pair.publicKey, one_time: true });
  });

  app.put("/keys/v2/merchant", async (c) => {
    const body = await c.req.json<{ public_key?: string }>();
    assert(body.public_key, 400, "PUBLIC_KEY_REQUIRED", "商户公钥不能为空");
    validatePublicKey(body.public_key);
    setSetting(database, "v2_merchant_public_key", toSpkiPublicKey(body.public_key));
    audit(database, "keys.v2_merchant_import", { actor: c.get("admin").username });
    return c.json({ ok: true });
  });

  const handlePasswordChange = async (c: Context<{ Variables: AuthVariables }>) => {
    const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { current_password?: string; new_password?: string };
    assert(body.current_password && body.new_password, 400, "PASSWORDS_REQUIRED", "必须填写当前密码与新密码");
    assert(body.new_password.length >= 12, 400, "PASSWORD_TOO_SHORT", "新密码至少 12 位");
    const user = database.query("SELECT * FROM admin_users WHERE id = ?").get(c.get("admin").id) as { password_hash: string } | null;
    assert(user && (await verifyPassword(body.current_password, user.password_hash)), 400, "CURRENT_PASSWORD_INCORRECT", "当前密码不正确");
    const newHash = await createPasswordHash(body.new_password);
    database.query("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?").run(newHash, new Date().toISOString(), c.get("admin").id);
    const currentToken = getCookie(c, SESSION_COOKIE) ?? getCookie(c, "alimpay_session") ?? "";
    if (currentToken) {
      database.query("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(c.get("admin").id, sha256(currentToken));
    } else {
      database.query("DELETE FROM sessions WHERE user_id = ?").run(c.get("admin").id);
    }
    audit(database, "system.password_changed", { actor: c.get("admin").username, ip: clientIp(c.req.raw.headers) });
    return c.json({ ok: true });
  };

  app.post("/system/password", handlePasswordChange);
  app.put("/password", handlePasswordChange);

  app.get("/system", (c) => {
    const pub = getPublicSettings(database);
    const alipayMode = pub.alipay_mode;
    const wxpayMode = pub.wxpay_mode;

    let alipayModeDetail = "官方当面付 (F2F)";
    let activeModeReady = pub.alipay_configured;
    if (alipayMode === "bill") {
      alipayModeDetail = "经营码账单流水匹配（经营码图片）";
      activeModeReady = Boolean(pub.business_qr_url);
    } else if (alipayMode === "transfer") {
      alipayModeDetail = "转账备注匹配（收款方支付宝用户 ID）";
      activeModeReady = Boolean(getSetting(database, "transfer_user_id", ""));
    }

    let wxpayDetail = "微信商户平台官方 Native 扫码 (APIv3)";
    if (wxpayMode === "hook") {
      wxpayDetail = pub.wxpay_static_qr_url
        ? "PC 微信 Hook 模式（收款码已就绪）"
        : "PC 微信 Hook 模式（尚未上传静态收款码）";
    }

    return c.json({
      ready: isGatewayReady(database),
      bun_version: Bun.version,
      database_path: getRuntimeEnv().databasePath,
      data_dir: getRuntimeEnv().dataDir,
      alipay_enabled: pub.alipay_enabled,
      alipay_mode: alipayMode,
      alipay_configured: pub.alipay_configured,
      active_mode_ready: activeModeReady,
      alipay_mode_detail: alipayModeDetail,
      wxpay_enabled: pub.wxpay_enabled,
      wxpay_mode: wxpayMode,
      wxpay_configured: pub.wxpay_configured,
      wxpay_detail: wxpayDetail,
      callbacks_private_allowed: getRuntimeEnv().allowPrivateCallbacks,
    });
  });

  app.get("/docs", (c) => {
    const baseUrl = getSetting(database, "public_base_url", getRuntimeEnv().publicBaseUrl);
    const pid = getSetting(database, "merchant_pid", "");
    return c.json({
      base_url: baseUrl,
      pid,
      pay_type: "alipay,wxpay",
      v1: {
        gateway: `${baseUrl}/submit.php`,
        mapi: `${baseUrl}/mapi.php`,
        api: `${baseUrl}/api.php`,
      },
      v2: {
        submit: `${baseUrl}/api/pay/submit`,
        create: `${baseUrl}/api/pay/create`,
        query: `${baseUrl}/api/pay/query`,
        merchant_info: `${baseUrl}/api/merchant/info`,
        merchant_orders: `${baseUrl}/api/merchant/orders`,
      },
    });
  });

  app.get("/system/audits", (c) => {
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
    return c.json({ data: database.query("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?").all(limit) });
  });

  return app;
}
