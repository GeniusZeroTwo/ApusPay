import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createAdminRoutes } from "./admin";
import { PaymentScanner } from "./alipay";
import { attachSocketIp, getAttachedSocketIp } from "./auth";
import { getDatabase, type AppDatabase } from "./db";
import { createEasyPayRoutes } from "./easypay";
import { getRuntimeEnv } from "./env";
import { AppError } from "./errors";
import { isGatewayReady } from "./config";
import { NotificationWorker, buildSignedReturnUrl } from "./notifications";
import { getCheckoutData, getOrderByCheckoutToken } from "./orders";

const ASSET_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

const CLIENT_ROOT = resolve(process.cwd(), "dist/client");
let clientRootReady = false;

export interface AppServices {
  database: AppDatabase;
  scanner: PaymentScanner;
  notifications: NotificationWorker;
}

export function createApp(services?: Partial<AppServices>) {
  const database = services?.database ?? getDatabase();
  const scanner = services?.scanner ?? new PaymentScanner(database);
  const notifications = services?.notifications ?? new NotificationWorker(database);
  const app = new Hono();

  app.use("*", secureHeaders({
    xFrameOptions: "DENY",
    xXssProtection: "0",
    referrerPolicy: "strict-origin-when-cross-origin",
    contentSecurityPolicy: getRuntimeEnv().nodeEnv === "production" ? {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    } : undefined,
  }));

  app.use("*", async (c, next) => {
    const started = performance.now();
    const rawReqId = c.req.header("x-request-id") ?? "";
    const requestId = /^[A-Za-z0-9._:-]{1,128}$/.test(rawReqId) ? rawReqId : crypto.randomUUID();
    c.header("x-request-id", requestId);
    await next();
    if (!c.req.path.startsWith("/public-api/checkout/")) {
      const safePath = c.req.path.startsWith("/checkout/") ? "/checkout/[REDACTED]" : c.req.path;
      console.log(JSON.stringify({
        level: "info",
        event: "http_request",
        request_id: requestId,
        method: c.req.method,
        path: safePath,
        status: c.res.status,
        duration_ms: Math.round((performance.now() - started) * 10) / 10,
      }));
    }
  });

  app.use("*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const initialSocketIp = getAttachedSocketIp(c.req.raw);
    const isQrUpload = c.req.path === "/admin-api/settings/qr" || c.req.path === "/admin-api/settings/qr/wechat";
    const maxSize = isQrUpload ? 6 * 1024 * 1024 : 256 * 1024;
    const limiter = bodyLimit({
      maxSize,
      onError: (ctx) => ctx.json({ error: "PAYLOAD_TOO_LARGE", message: "请求体超出大小限制" }, 413),
    });
    return limiter(c, async () => {
      if (initialSocketIp) attachSocketIp(c.req.raw, initialSocketIp);
      await next();
    });
  });

  app.get("/healthz", (c) => c.json({ ok: true, version: "1.0.0", bun: Bun.version }));
  app.get("/readyz", (c) => {
    database.query("SELECT 1").get();
    return c.json({ ready: true, gateway_ready: isGatewayReady(database) });
  });

  app.route("/admin-api", createAdminRoutes(database, scanner));
  app.route("/", createEasyPayRoutes(database, scanner));

  app.get("/public-api/checkout/:token", async (c) => {
    c.header("cache-control", "no-store");
    const initial = getOrderByCheckoutToken(database, c.req.param("token"));
    if (!initial) throw new AppError(404, "CHECKOUT_NOT_FOUND", "支付订单不存在");
    await scanner.ensureFresh(initial).catch(() => undefined);
    const order = getOrderByCheckoutToken(database, c.req.param("token"));
    if (!order) throw new AppError(404, "CHECKOUT_NOT_FOUND", "支付订单不存在");
    const data = getCheckoutData(database, c.req.param("token"), buildSignedReturnUrl(database, order));
    return c.json(data);
  });

  app.get("/uploads/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!/^(business-qr|wechat-qr)-[a-f\d]{16}\.(png|jpg|webp)$/.test(filename)) {
      throw new AppError(404, "FILE_NOT_FOUND", "文件不存在");
    }
    const path = resolve(getRuntimeEnv().uploadDir, filename);
    if (!path.startsWith(`${getRuntimeEnv().uploadDir}${sep}`)) throw new AppError(404, "FILE_NOT_FOUND", "文件不存在");
    const file = Bun.file(path);
    if (!(await file.exists())) throw new AppError(404, "FILE_NOT_FOUND", "文件不存在");
    return new Response(file, {
      headers: {
        "content-type": ASSET_CONTENT_TYPES[extname(filename)] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.notFound(async (c) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "NOT_FOUND", message: "接口不存在" }, 404);
    if (!clientRootReady) {
      if (!existsSync(CLIENT_ROOT)) {
        return c.json({ error: "FRONTEND_NOT_BUILT", message: "前端尚未构建，请在开发环境使用 Vite 端口 5173" }, 404);
      }
      clientRootReady = true;
    }
    let requestPath = "";
    try {
      requestPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.json({ error: "BAD_REQUEST", message: "请求路径格式无效" }, 400);
    }
    const relative = requestPath.replace(/^\/+/, "");
    const candidate = resolve(CLIENT_ROOT, relative || "index.html");
    const ext = extname(candidate).toLowerCase();
    if (ext === ".map") {
      return c.json({ error: "NOT_FOUND", message: "文件不存在" }, 404);
    }
    if (candidate.startsWith(`${CLIENT_ROOT}${sep}`)) {
      const asset = Bun.file(candidate);
      if (await asset.exists()) {
        return new Response(asset, {
          headers: {
            "content-type": ASSET_CONTENT_TYPES[ext] ?? "application/octet-stream",
            "cache-control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }
    }
    const index = Bun.file(resolve(CLIENT_ROOT, "index.html"));
    return new Response(index, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.onError((error, c) => {
    const appError = error instanceof AppError ? error : new AppError(500, "INTERNAL_ERROR", "服务器内部错误");
    if (!(error instanceof AppError)) {
      console.error(JSON.stringify({ level: "error", event: "unhandled_error", message: error.message, stack: error.stack }));
    }
    return c.json({ error: appError.code, message: appError.message, details: appError.details }, appError.status as 400);
  });

  return { app, services: { database, scanner, notifications } };
}

function acquireSingleWriterLock(dataDir: string): () => void {
  const lockPath = resolve(dataDir, ".apuspay.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      closeSync(fd);
      return () => {
        try {
          const holder = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
          if (holder === process.pid) rmSync(lockPath, { force: true });
        } catch {
          // Ignore lock cleanup errors
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const holderPid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isInteger(holderPid) && holderPid > 0 && holderPid !== process.pid) {
          process.kill(holderPid, 0);
          throw new Error(`数据目录 ${dataDir} 已被另一运行中的 ApusPay 进程 (PID ${holderPid}) 占用，禁止多进程并发写库`);
        }
      } catch (probeErr) {
        if ((probeErr as NodeJS.ErrnoException).code !== "ESRCH") {
          if (probeErr instanceof Error && probeErr.message.includes("已被另一运行中")) throw probeErr;
        }
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`无法获取数据目录排他锁: ${lockPath}`);
}

if (import.meta.main) {
  const runtime = getRuntimeEnv();
  const releaseLock = acquireSingleWriterLock(runtime.dataDir);
  const { app, services } = createApp();
  services.scanner.start();
  services.notifications.start();
  const server = Bun.serve({
    hostname: runtime.host,
    port: runtime.port,
    fetch(req, srv) {
      attachSocketIp(req, srv.requestIP(req)?.address);
      return app.fetch(req, srv);
    },
  });
  console.log(JSON.stringify({ level: "info", event: "server_started", url: server.url.toString(), data_dir: runtime.dataDir }));

  const shutdown = () => {
    services.scanner.stop();
    services.notifications.stop();
    releaseLock();
    void server.stop(true);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", releaseLock);
}
