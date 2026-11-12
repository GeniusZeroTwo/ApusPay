import type { LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import type { ApiVersion, OrderRecord } from "../shared/contracts";
import { getSecret } from "./config";
import type { AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError } from "./errors";
import { buildReturnParameters, getOrderById } from "./orders";
import { md5Sign, resolvePublicDestination, rsaSign, validateCallbackUrl } from "./security";

const MAX_CALLBACK_RESPONSE_BYTES = 4_096;
const CALLBACK_TIMEOUT_MS = 10_000;
const activeWorkers = new WeakMap<AppDatabase, NotificationWorker>();

export function notifyNotificationWorker(database: AppDatabase) {
  const worker = activeWorkers.get(database);
  if (worker?.isRunning) {
    queueMicrotask(() => void worker.tick());
  }
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const slice = total + value.byteLength > maxBytes ? value.subarray(0, maxBytes - total) : value;
      chunks.push(slice);
      total += slice.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function pinnedHttpGet(
  targetUrl: string,
  pinnedAddresses: LookupAddress[],
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const isHttps = url.protocol === "https:";
    const normalizedHost = url.hostname.replace(/^\[|\]$/g, "");
    const requestFn = isHttps ? https.request : http.request;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = requestFn(
      url,
      {
        method: "GET",
        agent: false,
        headers: {
          "user-agent": "ApusPay-Bun/1.0 notification",
          accept: "text/plain, */*;q=0.1",
          connection: "close",
        },
        ...(isHttps && isIP(normalizedHost) === 0 ? { servername: normalizedHost } : {}),
        lookup: (_hostname, options, callback) => {
          const opts = typeof options === "object" && options !== null ? (options as { all?: boolean; family?: number }) : {};
          const requestedFamily = typeof options === "number"
            ? (options === 4 || options === 6 ? options : undefined)
            : (opts.family === 4 || opts.family === 6 ? opts.family : undefined);
          const candidates = requestedFamily
            ? pinnedAddresses.filter((entry) => entry.family === requestedFamily)
            : pinnedAddresses;
          if (candidates.length === 0) {
            const err = Object.assign(new Error("ENOTFOUND: no matching address family"), { code: "ENOTFOUND" });
            (callback as (err: NodeJS.ErrnoException | null, addresses: unknown) => void)(err, opts.all ? [] : undefined);
            return;
          }
          if (opts.all) {
            (callback as (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, candidates);
          } else {
            const first = candidates[0]!;
            (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(null, first.address, first.family);
          }
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (total < maxBytes) {
            const take = Math.min(buf.length, maxBytes - total);
            chunks.push(buf.subarray(0, take));
            total += take;
          }
          if (total >= maxBytes) {
            res.destroy();
          }
        });
        res.on("end", () => {
          finish(() => resolve({ status, body: Buffer.concat(chunks, total).toString("utf8") }));
        });
        res.on("close", () => {
          finish(() => resolve({ status, body: Buffer.concat(chunks, total).toString("utf8") }));
        });
        res.on("error", (err) => {
          if (total >= maxBytes) {
            finish(() => resolve({ status, body: Buffer.concat(chunks, total).toString("utf8") }));
          } else {
            finish(() => reject(err));
          }
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy(new Error("通知请求超时"));
    }, timeoutMs);

    req.on("error", (err) => finish(() => reject(err)));
    req.end();
  });
}

interface NotificationJob {
  id: string;
  order_id: string;
  status: "pending" | "processing" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  manual: number;
}

export function signPlatformParameters(
  database: AppDatabase,
  apiVersion: ApiVersion,
  payload: Record<string, unknown>,
) {
  if (apiVersion === "v1") {
    const key = getSecret(database, "v1_key");
    if (!key) throw new AppError(503, "V1_KEY_MISSING", "V1 MD5 密钥尚未配置");
    return { ...payload, sign: md5Sign(payload, key), sign_type: "MD5" };
  }
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const withTimestamp = { ...payload, timestamp };
  const privateKey = getSecret(database, "v2_platform_private_key");
  if (!privateKey) throw new AppError(503, "V2_KEY_MISSING", "V2 平台私钥尚未配置");
  return { ...withTimestamp, sign: rsaSign(withTimestamp, privateKey), sign_type: "RSA" };
}

function toSearchParams(parameters: Record<string, unknown>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  return search;
}

export function buildSignedCallbackUrl(database: AppDatabase, order: OrderRecord, baseUrl: string) {
  const signed = signPlatformParameters(database, order.api_version, buildReturnParameters(order));
  const url = new URL(baseUrl);
  const search = toSearchParams(signed);
  for (const [key, value] of search) url.searchParams.set(key, value);
  return url.toString();
}

export function buildSignedReturnUrl(database: AppDatabase, order: OrderRecord) {
  if (!order.return_url || (order.status !== "paid" && order.status !== "late_paid")) return null;
  try {
    const parsed = new URL(order.return_url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
  } catch {
    return null;
  }
  return buildSignedCallbackUrl(database, order, order.return_url);
}

export function queueManualNotification(database: AppDatabase, orderId: string) {
  const order = getOrderById(database, orderId);
  if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "订单不存在");
  if (order.status !== "paid" && order.status !== "late_paid") {
    throw new AppError(409, "ORDER_NOT_PAID", "只有已支付订单可以补发通知");
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  database.query(`
    INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, 1, ?, 1, ?, ?)
  `).run(id, orderId, now, now, now);
  notifyNotificationWorker(database);
  return id;
}

export class NotificationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private working = false;
  private pendingRetick = false;

  constructor(
    private readonly database: AppDatabase,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    activeWorkers.set(database, this);
    const now = new Date().toISOString();
    this.database.query(`
      UPDATE notification_jobs SET status = 'pending', next_attempt_at = ?, updated_at = ? WHERE status = 'processing'
    `).run(now, now);
  }

  get isRunning() {
    return this.timer !== null;
  }

  start() {
    if (this.timer) return;
    activeWorkers.set(this.database, this);
    this.timer = setInterval(() => void this.tick(), 1_500);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.working) {
      this.pendingRetick = true;
      return;
    }
    this.working = true;
    try {
      do {
        this.pendingRetick = false;
        for (let wave = 0; wave < 4; wave += 1) {
          const batch = this.claimBatch(4);
          if (batch.length === 0) break;
          await Promise.all(batch.map((job) => this.deliver(job)));
        }
      } while (this.pendingRetick);
    } finally {
      this.working = false;
    }
  }

  private claimBatch(limit: number): NotificationJob[] {
    const now = new Date().toISOString();
    const hasPending = this.database.query(`
      SELECT 1 FROM notification_jobs
      WHERE status = 'pending' AND next_attempt_at <= ?
      LIMIT 1
    `).get(now);
    if (!hasPending) return [];

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.database.query(`
        SELECT * FROM notification_jobs
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC LIMIT ?
      `).all(now, limit) as NotificationJob[];
      if (candidates.length === 0) {
        this.database.exec("COMMIT");
        return [];
      }
      const updateStmt = this.database.query(`
        UPDATE notification_jobs SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'
      `);
      const claimed: NotificationJob[] = [];
      for (const job of candidates) {
        if (updateStmt.run(now, job.id).changes > 0) {
          claimed.push(job);
        }
      }
      this.database.exec("COMMIT");
      return claimed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private async deliver(job: NotificationJob) {
    const order = getOrderById(this.database, job.order_id);
    const attemptNumber = job.attempts + 1;
    const requestedAt = new Date().toISOString();
    const attempt = this.database.query(`
      INSERT INTO notification_attempts(job_id, attempt_number, requested_at) VALUES (?, ?, ?) RETURNING id
    `).get(job.id, attemptNumber, requestedAt) as { id: number };

    let responseStatus: number | null = null;
    let responseBody = "";
    let errorMessage = "";
    let acknowledged = false;
    try {
      if (!order) throw new Error("关联订单不存在");
      const runtime = getRuntimeEnv();
      const target = validateCallbackUrl(order.notify_url, runtime.allowPrivateCallbacks, runtime.allowedCallbackHosts);
      const pinnedAddresses = await resolvePublicDestination(target, runtime.allowPrivateCallbacks, runtime.allowedCallbackHosts);
      const signedUrl = buildSignedCallbackUrl(this.database, order, target.toString());

      if (this.fetcher === fetch && pinnedAddresses && pinnedAddresses.length > 0) {
        const pinnedRes = await pinnedHttpGet(signedUrl, pinnedAddresses, CALLBACK_TIMEOUT_MS, MAX_CALLBACK_RESPONSE_BYTES);
        responseStatus = pinnedRes.status;
        responseBody = pinnedRes.body.slice(0, 500);
      } else {
        const response = await this.fetcher(signedUrl, {
          method: "GET",
          redirect: "manual",
          headers: {
            "user-agent": "ApusPay-Bun/1.0 notification",
            accept: "text/plain, */*;q=0.1",
          },
          signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
        });
        responseStatus = response.status;
        responseBody = (await readBoundedText(response, MAX_CALLBACK_RESPONSE_BYTES)).slice(0, 500);
      }
      acknowledged = responseStatus >= 200 && responseStatus < 300 && responseBody.trim() === "success";
      if (!acknowledged) errorMessage = `商户未确认通知（HTTP ${responseStatus}）`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    const completedAt = new Date().toISOString();
    this.database.query(`
      UPDATE notification_attempts SET completed_at = ?, response_status = ?, response_body = ?, error = ? WHERE id = ?
    `).run(completedAt, responseStatus, responseBody || null, errorMessage || null, attempt.id);

    if (acknowledged) {
      this.database.query(`
        UPDATE notification_jobs SET status = 'succeeded', attempts = ?, last_http_status = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `).run(attemptNumber, responseStatus, completedAt, job.id);
      return;
    }

    const exhausted = attemptNumber >= job.max_attempts;
    const nextAttempt = new Date(Date.now() + 60_000).toISOString();
    this.database.query(`
      UPDATE notification_jobs SET status = ?, attempts = ?, next_attempt_at = ?, last_http_status = ?, last_error = ?, updated_at = ? WHERE id = ?
    `).run(exhausted ? "failed" : "pending", attemptNumber, nextAttempt, responseStatus, errorMessage.slice(0, 1_000), completedAt, job.id);
  }
}

export function notificationHistory(database: AppDatabase, orderId: string) {
  const jobs = database.query(`
    SELECT * FROM notification_jobs WHERE order_id = ? ORDER BY created_at DESC
  `).all(orderId) as Array<Record<string, unknown>>;
  if (jobs.length === 0) return [];

  const allAttempts = database.query(`
    SELECT a.*
    FROM notification_attempts a
    JOIN notification_jobs j ON j.id = a.job_id
    WHERE j.order_id = ?
    ORDER BY a.attempt_number ASC
  `).all(orderId) as Array<Record<string, unknown>>;

  const attemptsByJob = new Map<string, Array<Record<string, unknown>>>();
  for (const attempt of allAttempts) {
    const jobId = String(attempt.job_id);
    let list = attemptsByJob.get(jobId);
    if (!list) {
      list = [];
      attemptsByJob.set(jobId, list);
    }
    list.push(attempt);
  }

  return jobs.map((job) => ({
    ...job,
    attempts_detail: attemptsByJob.get(String(job.id)) ?? [],
  }));
}
