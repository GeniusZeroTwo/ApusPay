import { AlipaySdk } from "alipay-sdk";
import type { OrderRecord } from "../shared/contracts";
import { getPaymentPollIntervalSeconds, getSecret } from "./config";
import { audit, getSetting, type AppDatabase } from "./db";
import { AppError } from "./errors";
import { getActiveOrders, markOrderPaidDirectly, recordAndMatchPayment, type AccountLogEvent } from "./orders";
import { parseMoneyToCents } from "./security";
import { WeChatPayService } from "./wechat";

export interface AccountLogPage {
  pageNo: number;
  pageSize: number;
  totalSize: number;
  traceId: string;
  details: Array<Record<string, unknown>>;
}

export interface AccountLogProvider {
  query(input: { startTime: string; endTime: string; pageNo: number; pageSize: number }): Promise<AccountLogPage>;
  precreateTrade?(input: { outTradeNo: string; totalAmount: string; subject: string }): Promise<{ qrCode: string }>;
  queryTrade?(outTradeNo: string): Promise<{ success: boolean; tradeNo?: string; buyerId?: string; tradeStatus?: string; amountCents?: number }>;
  closeTrade?(outTradeNo: string): Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function prepareAlipaySdkPem(value: string) {
  return value.trim();
}

export class OfficialAlipayProvider implements AccountLogProvider {
  private cachedSdk: { key: string; sdk: AlipaySdk } | null = null;

  constructor(private readonly database: AppDatabase) {}

  getSdk(): AlipaySdk {
    const appId = getSetting(this.database, "alipay_app_id", "");
    const privateKey = getSecret(this.database, "alipay_private_key");
    const alipayPublicKey = getSetting(this.database, "alipay_public_key", "");
    if (!appId || !privateKey || !alipayPublicKey) {
      throw new AppError(503, "ALIPAY_NOT_CONFIGURED", "支付宝应用 ID、应用私钥或支付宝公钥尚未配置完整");
    }

    const endpoint = getSetting(this.database, "alipay_endpoint", "https://openapi.alipay.com");
    const cacheKey = `${appId}\n${endpoint}\n${privateKey}\n${alipayPublicKey}`;
    if (this.cachedSdk?.key === cacheKey) {
      return this.cachedSdk.sdk;
    }

    const sdk = new AlipaySdk({
      appId,
      privateKey: prepareAlipaySdkPem(privateKey),
      alipayPublicKey: prepareAlipaySdkPem(alipayPublicKey),
      signType: "RSA2",
      keyType: "PKCS8",
      endpoint,
      timeout: 8_000,
      camelcase: false,
    });
    this.cachedSdk = { key: cacheKey, sdk };
    return sdk;
  }

  async query(input: { startTime: string; endTime: string; pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    const sdk = this.getSdk();
    const result = await sdk.curl<Record<string, unknown>>(
      "GET",
      "/v3/alipay/data/bill/accountlog/query",
      {
        query: {
          start_time: input.startTime,
          end_time: input.endTime,
          page_no: input.pageNo,
          page_size: input.pageSize,
        },
        requestTimeout: 8_000,
      },
    );
    const data = asRecord(result.data);
    return {
      pageNo: Number(data.page_no ?? data.pageNo ?? input.pageNo),
      pageSize: Number(data.page_size ?? data.pageSize ?? input.pageSize),
      totalSize: Number(data.total_size ?? data.totalSize ?? 0),
      details: Array.isArray(data.detail_list) ? data.detail_list.map(asRecord) :
        Array.isArray(data.detailList) ? data.detailList.map(asRecord) : [],
      traceId: result.traceId,
    };
  }

  async precreateTrade(input: { outTradeNo: string; totalAmount: string; subject: string }): Promise<{ qrCode: string }> {
    const sdk = this.getSdk();
    const result = (await sdk.exec("alipay.trade.precreate", {
      bizContent: {
        out_trade_no: input.outTradeNo,
        total_amount: input.totalAmount,
        subject: input.subject.slice(0, 120),
      },
    })) as Record<string, unknown>;
    const qrCode = (result.qr_code ?? result.qrCode ?? "") as string;
    if (!qrCode) {
      throw new AppError(502, "ALIPAY_PRECREATE_FAILED", String(result.sub_msg ?? result.msg ?? "支付宝当面付下单失败"));
    }
    return { qrCode };
  }

  async queryTrade(outTradeNo: string): Promise<{ success: boolean; tradeNo?: string; buyerId?: string; tradeStatus?: string; amountCents?: number }> {
    const sdk = this.getSdk();
    try {
      const result = (await sdk.exec("alipay.trade.query", {
        bizContent: { out_trade_no: outTradeNo },
      })) as Record<string, unknown>;
      const tradeStatus = (result.trade_status ?? result.tradeStatus ?? "") as string;
      const tradeNo = (result.trade_no ?? result.tradeNo ?? "") as string;
      const buyerId = (result.buyer_user_id ?? result.buyerUserId ?? result.buyer_logon_id ?? "") as string;
      const rawTotal = result.total_amount ?? result.totalAmount;
      const amountCents = rawTotal !== undefined && rawTotal !== null && String(rawTotal).trim() !== ""
        ? parseMoneyToCents(String(rawTotal))
        : undefined;
      const success = (tradeStatus === "TRADE_SUCCESS" || tradeStatus === "TRADE_FINISHED") && amountCents !== undefined;
      return { success, tradeNo, buyerId, tradeStatus, amountCents };
    } catch {
      return { success: false };
    }
  }

  async closeTrade(outTradeNo: string): Promise<void> {
    const sdk = this.getSdk();
    await sdk.exec("alipay.trade.close", {
      bizContent: { out_trade_no: outTradeNo },
    }).catch(() => undefined);
  }
}

export function parseAlipayTime(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return new Date(0).toISOString();
  if (/Z$|[+-]\d\d:\d\d$/.test(raw)) return new Date(raw).toISOString();
  return new Date(`${raw.replace(" ", "T")}+08:00`).toISOString();
}

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatShanghai(value: Date) {
  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

async function runWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) return;
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++]!;
      await worker(current);
    }
  });
  await Promise.all(runners);
}

function normalizeEvent(detail: Record<string, unknown>): AccountLogEvent | null {
  const accountLogId = String(detail.account_log_id ?? detail.accountLogId ?? "").trim();
  if (!accountLogId) return null;
  let amountCents: number;
  try {
    amountCents = parseMoneyToCents(String(detail.trans_amount ?? detail.transAmount ?? "0").replace(/^-/, ""));
  } catch {
    return null;
  }
  return {
    accountLogId,
    occurredAt: parseAlipayTime(detail.trans_dt ?? detail.transDt),
    direction: String(detail.direction ?? ""),
    amountCents,
    alipayOrderNo: String(detail.alipay_order_no ?? detail.alipayOrderNo ?? ""),
    transMemo: String(detail.trans_memo ?? detail.transMemo ?? ""),
    otherAccount: String(detail.other_account ?? detail.otherAccount ?? ""),
    raw: detail,
  };
}

export interface ScanResult {
  status: "success" | "skipped";
  activeOrders: number;
  pages: number;
  records: number;
  matched: number;
  traceId: string;
}

export class PaymentScanner {
  private inFlight: Promise<ScanResult> | null = null;
  private lastCompletedAt = 0;
  private lastRetentionPruneAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly orderCheckInFlight = new Map<string, Promise<boolean>>();
  private readonly orderLastCheckedAt = new Map<string, number>();
  private readonly wechat: WeChatPayService;

  constructor(
    private readonly database: AppDatabase,
    private readonly provider: AccountLogProvider = new OfficialAlipayProvider(database),
    wechatService?: WeChatPayService,
  ) {
    this.wechat = wechatService ?? new WeChatPayService(database);
  }

  get lastScanAt() {
    return this.lastCompletedAt;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const pollIntervalMs = getPaymentPollIntervalSeconds(this.database) * 1_000;
      if (getActiveOrders(this.database).length > 0 && Date.now() - this.lastCompletedAt >= pollIntervalMs) {
        void this.scanNow("scheduler").catch((error) => {
          console.error(JSON.stringify({ level: "error", event: "scan_failed", message: error instanceof Error ? error.message : String(error) }));
        });
      }
    }, 1_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async checkDirectOrder(order: OrderRecord): Promise<boolean> {
    const existing = this.orderCheckInFlight.get(order.id);
    if (existing) return existing;

    const task = (async () => {
      try {
        if (order.collection_mode === "alipay_f2f" && this.provider.queryTrade) {
          const query = await this.provider.queryTrade(order.trade_no);
          if (query.success && query.amountCents === order.payable_amount_cents) {
            return markOrderPaidDirectly(this.database, order.id, {
              channel: "alipay",
              channelOrderId: query.tradeNo,
              buyer: query.buyerId,
            });
          }
        } else if (order.collection_mode === "wxpay_native") {
          const query = await this.wechat.queryOrder(order.trade_no);
          if (query.tradeState === "SUCCESS" && query.amountCents === order.payable_amount_cents) {
            return markOrderPaidDirectly(this.database, order.id, {
              channel: "wxpay",
              channelOrderId: query.transactionId,
              buyer: query.payerOpenid,
            });
          }
        }
        return false;
      } catch {
        return false;
      } finally {
        if (this.orderLastCheckedAt.size > 1_024) {
          const oldestKey = this.orderLastCheckedAt.keys().next().value;
          if (oldestKey !== undefined) this.orderLastCheckedAt.delete(oldestKey);
        }
        this.orderLastCheckedAt.set(order.id, Date.now());
        this.orderCheckInFlight.delete(order.id);
      }
    })();

    this.orderCheckInFlight.set(order.id, task);
    return task;
  }

  async ensureFresh(order: OrderRecord) {
    if (!["pending", "expired"].includes(order.status) || Date.parse(order.monitor_until) <= Date.now()) return;

    const pollIntervalMs = getPaymentPollIntervalSeconds(this.database) * 1_000;
    const isDirectMode =
      (order.collection_mode === "alipay_f2f" && Boolean(this.provider.queryTrade)) ||
      order.collection_mode === "wxpay_native";

    // Fast path: direct active query for F2F or WeChat Native with per-order coalescing & cooldown
    if (isDirectMode) {
      const fastCooldownMs = Math.min(1_500, pollIntervalMs);
      if (this.orderCheckInFlight.has(order.id) || Date.now() - (this.orderLastCheckedAt.get(order.id) ?? 0) >= fastCooldownMs) {
        await this.checkDirectOrder(order);
      }
      return;
    }

    if (Date.now() - this.lastCompletedAt < pollIntervalMs) return;
    await Promise.race([
      this.scanNow("order_query"),
      new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
    ]);
  }

  scanNow(reason = "manual") {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performScan(reason).finally(() => {
      this.lastCompletedAt = Date.now();
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private maybePruneHistoricalRows() {
    const nowMs = Date.now();
    if (nowMs - this.lastRetentionPruneAt < 60 * 60_000) return;
    this.lastRetentionPruneAt = nowMs;
    const hookCutoff = new Date(nowMs - 30 * 86_400_000).toISOString();
    const scanCutoff = new Date(nowMs - 7 * 86_400_000).toISOString();
    this.database.query("DELETE FROM hook_events WHERE created_at < ?").run(hookCutoff);
    this.database.query("DELETE FROM scan_runs WHERE started_at < ? AND id NOT IN (SELECT id FROM scan_runs ORDER BY id DESC LIMIT 1000)").run(scanCutoff);
  }

  private async performScan(reason: string): Promise<ScanResult> {
    this.maybePruneHistoricalRows();
    let candidates = getActiveOrders(this.database);
    const startedAt = new Date().toISOString();
    const run = this.database.query(`
      INSERT INTO scan_runs(started_at, status, active_orders) VALUES (?, 'running', ?) RETURNING id
    `).get(startedAt, candidates.length) as { id: number };

    if (candidates.length === 0) {
      const finishedAt = new Date().toISOString();
      this.database.query("UPDATE scan_runs SET status = 'skipped', finished_at = ? WHERE id = ?").run(finishedAt, run.id);
      return { status: "skipped", activeOrders: 0, pages: 0, records: 0, matched: 0, traceId: "" };
    }

    let pages = 0;
    let records = 0;
    let matched = 0;
    let traceId = "";

    // 1. Check F2F orders with bounded concurrency
    if (this.provider.queryTrade) {
      const f2fOrders = candidates.filter((o) => o.collection_mode === "alipay_f2f");
      if (f2fOrders.length > 0) {
        await runWithConcurrency(f2fOrders, 5, async (order) => {
          const ok = await this.checkDirectOrder(order);
          if (ok) matched += 1;
        });
        candidates = getActiveOrders(this.database);
      }
    }

    // 2. Check WeChat Native orders with bounded concurrency
    const wxOrders = candidates.filter((o) => o.collection_mode === "wxpay_native");
    if (wxOrders.length > 0) {
      await runWithConcurrency(wxOrders, 5, async (order) => {
        const ok = await this.checkDirectOrder(order);
        if (ok) matched += 1;
      });
      candidates = getActiveOrders(this.database);
    }

    // 3. Check bill query candidates (business_qr, transfer)
    const billCandidates = candidates.filter((o) => ["business_qr", "transfer", "alipay_bill", "alipay_transfer"].includes(o.collection_mode));
    if (billCandidates.length > 0) {
      try {
        const earliest = Math.min(...billCandidates.map((order) => Date.parse(order.created_at))) - 60_000;
        const startTime = formatShanghai(new Date(earliest));
        const endTime = formatShanghai(new Date());
        const pageSize = 2_000;
        let pageNo = 1;
        let totalSize = Number.POSITIVE_INFINITY;

        while ((pageNo - 1) * pageSize < totalSize) {
          const page = await this.provider.query({ startTime, endTime, pageNo, pageSize });
          pages += 1;
          totalSize = page.totalSize || page.details.length;
          traceId ||= page.traceId;
          records += page.details.length;

          const events = page.details
            .map(normalizeEvent)
            .filter((event): event is AccountLogEvent => Boolean(event))
            .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
          for (const event of events) {
            const result = recordAndMatchPayment(this.database, event, candidates);
            if (result.matched) {
              matched += 1;
              candidates = getActiveOrders(this.database);
              if (candidates.length === 0) break;
            }
          }
          if (candidates.length === 0 || page.details.length < pageSize) break;
          pageNo += 1;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.database.query(`
          UPDATE scan_runs SET status = 'error', finished_at = ?, pages = ?, records = ?, matched = ?, error = ?, trace_id = ? WHERE id = ?
        `).run(new Date().toISOString(), pages, records, matched, message.slice(0, 2_000), traceId || null, run.id);
        throw error;
      }
    }

    const finishedAt = new Date().toISOString();
    this.database.query(`
      UPDATE scan_runs SET status = 'success', finished_at = ?, pages = ?, records = ?, matched = ?, trace_id = ? WHERE id = ?
    `).run(finishedAt, pages, records, matched, traceId || null, run.id);
    audit(this.database, "payment.scan", { details: { reason, pages, records, matched, traceId } });
    return { status: "success", activeOrders: candidates.length, pages, records, matched, traceId };
  }
}
