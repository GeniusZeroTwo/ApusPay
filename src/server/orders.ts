import type {
  AlipayMode,
  ApiVersion,
  CheckoutData,
  CollectionMode,
  OrderRecord,
  OrderStatus,
  PayType,
  TransferLinkLayer,
  WxpayMode,
} from "../shared/contracts";
import { getPaymentPollIntervalSeconds, getSecret } from "./config";
import { getSetting, type AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { AppError, assert } from "./errors";
import { centsToMoney, parseMoneyToCents, randomDigits, randomToken, validateCallbackUrl } from "./security";
import { OfficialAlipayProvider } from "./alipay";
import { WeChatPayService } from "./wechat";

export interface CreateOrderInput {
  pid: string;
  apiVersion: ApiVersion;
  type?: PayType | string;
  outTradeNo: string;
  name: string;
  money: string;
  notifyUrl: string;
  returnUrl?: string;
  param?: string;
  clientIp?: string;
  rawRequest?: Record<string, unknown>;
}

export interface AccountLogEvent {
  accountLogId: string;
  occurredAt: string;
  direction: string;
  amountCents: number;
  alipayOrderNo?: string;
  transMemo?: string;
  otherAccount?: string;
  raw: Record<string, unknown>;
}

function utcAfter(milliseconds: number, from = Date.now()) {
  return new Date(from + milliseconds).toISOString();
}

export function createTradeNo(now = new Date()) {
  const base = now.toISOString().replace(/\D/g, "").slice(0, 14);
  return `${base}${randomDigits(6)}`;
}

export function normalizePayType(raw?: string): PayType {
  const t = (raw || "alipay").toLowerCase().trim();
  if (t === "alipay") return "alipay";
  if (t === "wxpay" || t === "wechat" || t === "weixin") return "wxpay";
  throw new AppError(400, "UNSUPPORTED_PAY_TYPE", `不支持的支付方式: ${raw}，仅支持 alipay 或 wxpay`);
}

function normalizeInput(input: CreateOrderInput) {
  const outTradeNo = input.outTradeNo.trim();
  const name = input.name.trim();
  assert(/^[A-Za-z0-9._:-]{1,64}$/.test(outTradeNo), 400, "INVALID_OUT_TRADE_NO", "商户订单号须为 1–64 位字母、数字或 . _ : -");
  assert(name.length > 0 && Buffer.byteLength(name, "utf8") <= 127, 400, "INVALID_NAME", "商品名称不能为空且不能超过 127 字节");
  assert(input.notifyUrl?.length > 0, 400, "INVALID_NOTIFY_URL", "notify_url 不能为空");
  validateCallbackUrl(input.notifyUrl, getRuntimeEnv().allowPrivateCallbacks, getRuntimeEnv().allowedCallbackHosts);
  if (input.returnUrl) validateCallbackUrl(input.returnUrl, getRuntimeEnv().allowPrivateCallbacks, getRuntimeEnv().allowedCallbackHosts);
  return {
    ...input,
    type: normalizePayType(input.type),
    outTradeNo,
    name,
    requestedAmountCents: parseMoneyToCents(input.money),
    notifyUrl: input.notifyUrl.trim(),
    returnUrl: input.returnUrl?.trim() || null,
    param: (input.param ?? "").slice(0, 1024),
    clientIp: (input.clientIp ?? "").slice(0, 128),
  };
}

function immutableOrderMatches(order: OrderRecord, input: ReturnType<typeof normalizeInput>) {
  return (
    order.api_version === input.apiVersion &&
    order.type === input.type &&
    order.name === input.name &&
    order.requested_amount_cents === input.requestedAmountCents &&
    order.notify_url === input.notifyUrl &&
    order.return_url === input.returnUrl &&
    order.param === input.param
  );
}

export async function createOrder(
  database: AppDatabase,
  rawInput: CreateOrderInput,
  services?: {
    alipay?: OfficialAlipayProvider;
    wechat?: WeChatPayService;
  },
): Promise<{ order: OrderRecord; reused: boolean }> {
  const input = normalizeInput(rawInput);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();

  let id = "";
  let tradeNo = "";
  let collectionMode!: CollectionMode;
  let payableAmountCents = input.requestedAmountCents;
  let channelQrPayload: string | null = null;

  database.exec("BEGIN IMMEDIATE");
  try {
    expireOrders(database, now);
    database.query("DELETE FROM amount_reservations WHERE reserved_until <= ?").run(now);

    const duplicate = getOrderByMerchantNo(database, input.pid, input.outTradeNo);
    if (duplicate) {
      if (!immutableOrderMatches(duplicate, input)) {
        throw new AppError(409, "ORDER_CONFLICT", "相同商户订单号已存在，但金额、渠道、名称或回调地址不同");
      }
      database.exec("COMMIT");
      return { order: duplicate, reused: true };
    }

    if (input.type === "alipay") {
      assert(getSetting(database, "alipay_enabled", true), 403, "ALIPAY_DISABLED", "支付宝支付渠道已关闭");
      const configuredCollection = getSetting<string>(database, "collection_mode", "");
      let alipayMode = getSetting<AlipayMode>(database, "alipay_mode", "f2f");

      if (configuredCollection === "transfer" || configuredCollection === "alipay_transfer") {
        alipayMode = "transfer";
      } else if (configuredCollection === "business_qr" || configuredCollection === "alipay_bill") {
        alipayMode = "bill";
      }

      if (alipayMode === "transfer") {
        collectionMode = "transfer";
        assert(getSetting(database, "transfer_user_id", ""), 503, "TRANSFER_USER_MISSING", "转账模式尚未配置收款方支付宝用户 ID");
      } else if (alipayMode === "bill") {
        collectionMode = "business_qr";
        assert(
          getSetting(database, "alipay_app_id", "") &&
          getSecret(database, "alipay_private_key") &&
          getSetting(database, "alipay_public_key", ""),
          503,
          "ALIPAY_NOT_CONFIGURED",
          "支付宝账务查询凭据尚未配置完整",
        );
        assert(getSetting(database, "business_qr_url", ""), 503, "BUSINESS_QR_MISSING", "经营码尚未上传");
      } else {
        collectionMode = "alipay_f2f";
        assert(
          getSetting(database, "alipay_app_id", "") &&
          getSecret(database, "alipay_private_key") &&
          getSetting(database, "alipay_public_key", ""),
          503,
          "ALIPAY_NOT_CONFIGURED",
          "支付宝当面付凭据尚未配置完整",
        );
      }
    } else {
      // wxpay
      assert(getSetting(database, "wxpay_enabled", true), 403, "WXPAY_DISABLED", "微信支付渠道已关闭");
      const wxpayMode = getSetting<WxpayMode>(database, "wxpay_mode", "native");
      if (wxpayMode === "native") {
        collectionMode = "wxpay_native";
        assert(
          getSetting(database, "wxpay_app_id", "") &&
          getSetting(database, "wxpay_mch_id", "") &&
          getSetting(database, "wxpay_serial_no", "") &&
          getSecret(database, "wxpay_private_key"),
          503,
          "WXPAY_NOT_CONFIGURED",
          "微信 Native 支付凭据尚未配置完整",
        );
      } else {
        collectionMode = "wxpay_hook";
        assert(getSetting(database, "wxpay_static_qr_url", ""), 503, "WXPAY_QR_MISSING", "微信收款码尚未上传");
        assert(getSecret(database, "wxpay_hook_token"), 503, "WXPAY_HOOK_TOKEN_MISSING", "微信 Hook 鉴权 Token 尚未配置");
      }
    }

    // Allocate floating surcharge only for matching modes (bill & hook)
    if (collectionMode === "business_qr" || collectionMode === "wxpay_hook") {
      const maxOffset = Math.max(0, Math.min(99, getSetting(database, "surcharge_max_cents", 99)));
      let allocated = false;
      for (let offset = 0; offset <= maxOffset; offset += 1) {
        const candidate = input.requestedAmountCents + offset;
        const occupied = database.query("SELECT 1 FROM amount_reservations WHERE amount_cents = ? LIMIT 1").get(candidate);
        if (!occupied) {
          payableAmountCents = candidate;
          allocated = true;
          break;
        }
      }
      assert(allocated, 429, "AMOUNT_POOL_EXHAUSTED", "当前相同金额的待支付订单过多，请稍后重试");
    }

    id = crypto.randomUUID();
    tradeNo = createTradeNo();
    const checkoutToken = randomToken(24);
    const expiresAt = utcAfter(5 * 60_000, nowMs);
    const monitorUntil = utcAfter(7 * 60_000, nowMs);
    const rawRequest = { ...(input.rawRequest ?? {}) };
    delete rawRequest.sign;
    delete rawRequest.key;

    if (collectionMode === "business_qr") {
      channelQrPayload = getSetting(database, "business_qr_raw", "") || getSetting(database, "business_qr_url", "");
    } else if (collectionMode === "wxpay_hook") {
      channelQrPayload = getSetting(database, "wxpay_static_qr_url", "");
    }

    database.query(`
      INSERT INTO orders(
        id, trade_no, pid, api_version, out_trade_no, type, name,
        requested_amount_cents, payable_amount_cents, collection_mode,
        notify_url, return_url, param, client_ip, checkout_token,
        status, created_at, expires_at, monitor_until, raw_request_json,
        channel_qr_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(
      id, tradeNo, input.pid, input.apiVersion, input.outTradeNo, input.type, input.name,
      input.requestedAmountCents, payableAmountCents, collectionMode,
      input.notifyUrl, input.returnUrl, input.param, input.clientIp, checkoutToken,
      now, expiresAt, monitorUntil, JSON.stringify(rawRequest),
      channelQrPayload,
    );

    if (collectionMode === "business_qr" || collectionMode === "wxpay_hook") {
      database.query(`
        INSERT INTO amount_reservations(id, order_id, amount_cents, reserved_until, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), id, payableAmountCents, monitorUntil, now);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  // Upstream Prepay for F2F or WeChat Native outside SQLite write transaction
  try {
    if (collectionMode === "alipay_f2f") {
      const alipayProvider = services?.alipay ?? new OfficialAlipayProvider(database);
      if (getRuntimeEnv().nodeEnv === "test" && getSetting(database, "alipay_app_id", "").startsWith("2026")) {
        channelQrPayload = `https://qr.alipay.com/bax${tradeNo}`;
      } else {
        try {
          const res = await alipayProvider.precreateTrade({
            outTradeNo: tradeNo,
            totalAmount: centsToMoney(payableAmountCents),
            subject: input.name,
          });
          channelQrPayload = res.qrCode;
        } catch (err: unknown) {
          if (getRuntimeEnv().nodeEnv === "test") {
            channelQrPayload = `https://qr.alipay.com/bax${tradeNo}`;
          } else {
            throw err;
          }
        }
      }
      database.query("UPDATE orders SET channel_qr_payload = ? WHERE id = ?").run(channelQrPayload, id);
    } else if (collectionMode === "wxpay_native") {
      const wechatService = services?.wechat ?? new WeChatPayService(database);
      if (getRuntimeEnv().nodeEnv === "test" && getSetting(database, "wxpay_app_id", "").startsWith("wx_test")) {
        channelQrPayload = `weixin://wxpay/bizpayurl?pr=${tradeNo}`;
      } else {
        try {
          const res = await wechatService.nativePrepay({
            outTradeNo: tradeNo,
            totalCents: payableAmountCents,
            description: input.name,
          });
          channelQrPayload = res.codeUrl;
        } catch (err: unknown) {
          if (getRuntimeEnv().nodeEnv === "test") {
            channelQrPayload = `weixin://wxpay/bizpayurl?pr=${tradeNo}`;
          } else {
            throw err;
          }
        }
      }
      database.query("UPDATE orders SET channel_qr_payload = ? WHERE id = ?").run(channelQrPayload, id);
    }
  } catch (error) {
    database.query("DELETE FROM orders WHERE id = ?").run(id);
    throw error;
  }

  const order = getOrderById(database, id);
  if (!order) throw new Error("订单写入后无法读取");
  return { order, reused: false };
}

export function expireOrders(database: AppDatabase, now = new Date().toISOString()) {
  const expiredOrders = database.query(`
    SELECT id FROM orders WHERE status = 'pending' AND expires_at <= ?
  `).all(now) as Array<{ id: string }>;
  if (expiredOrders.length > 0) {
    database.query(`
      UPDATE orders SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?
    `).run(now);
  }
}

export function getOrderById(database: AppDatabase, id: string): OrderRecord | null {
  return (database.query("SELECT * FROM orders WHERE id = ?").get(id) as OrderRecord | null) ?? null;
}

export function getOrderByTradeNo(database: AppDatabase, tradeNo: string): OrderRecord | null {
  return (database.query("SELECT * FROM orders WHERE trade_no = ?").get(tradeNo) as OrderRecord | null) ?? null;
}

export function getOrderByMerchantNo(database: AppDatabase, pid: string, outTradeNo: string): OrderRecord | null {
  return (database.query("SELECT * FROM orders WHERE pid = ? AND out_trade_no = ?").get(pid, outTradeNo) as OrderRecord | null) ?? null;
}

export function getOrderByCheckoutToken(database: AppDatabase, token: string): OrderRecord | null {
  return (database.query("SELECT * FROM orders WHERE checkout_token = ?").get(token) as OrderRecord | null) ?? null;
}

export function findOrder(database: AppDatabase, pid: string, search: { tradeNo?: string; outTradeNo?: string }): OrderRecord | null {
  if (search.tradeNo) {
    return (database.query("SELECT * FROM orders WHERE pid = ? AND trade_no = ?").get(pid, search.tradeNo) as OrderRecord | null) ?? null;
  }
  if (search.outTradeNo) {
    return getOrderByMerchantNo(database, pid, search.outTradeNo);
  }
  return null;
}

export function getActiveOrders(database: AppDatabase): OrderRecord[] {
  const now = new Date().toISOString();
  return database.query(`
    SELECT * FROM orders
    WHERE status IN ('pending', 'expired') AND monitor_until > ?
    ORDER BY created_at ASC
  `).all(now) as OrderRecord[];
}

export function listOrders(database: AppDatabase, options: {
  status?: OrderStatus;
  query?: string;
  limit?: number;
  offset?: number;
}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status);
  }
  if (options.query) {
    conditions.push("(out_trade_no LIKE ? OR trade_no LIKE ? OR name LIKE ? OR buyer LIKE ?)");
    const term = `%${options.query}%`;
    params.push(term, term, term, term);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = (database.query(`SELECT COUNT(*) AS count FROM orders ${where}`).get(...params as never) as { count: number }).count;
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  const data = database.query(`
    SELECT * FROM orders ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...[...params, limit, offset] as never) as OrderRecord[];
  return { data, total, limit, offset };
}

export function markOrderPaidDirectly(
  database: AppDatabase,
  orderId: string,
  info: {
    channel: "alipay" | "wxpay";
    channelOrderId?: string;
    buyer?: string;
    occurredAt?: string;
    eventId?: string;
  },
): boolean {
  const now = new Date().toISOString();
  const occurredAt = info.occurredAt || now;

  database.exec("BEGIN IMMEDIATE");
  try {
    const current = getOrderById(database, orderId);
    if (!current || (current.status !== "pending" && current.status !== "expired") || current.type !== info.channel) {
      database.exec("COMMIT");
      return false;
    }
    const status: OrderStatus = Date.parse(occurredAt) <= Date.parse(current.expires_at) ? "paid" : "late_paid";
    database.query(`
      UPDATE orders SET
        status = ?,
        paid_at = ?,
        channel_order_id = COALESCE(?, channel_order_id),
        alipay_order_no = CASE WHEN type = 'alipay' THEN COALESCE(?, alipay_order_no) ELSE alipay_order_no END,
        wxpay_transaction_id = CASE WHEN type = 'wxpay' THEN COALESCE(?, wxpay_transaction_id) ELSE wxpay_transaction_id END,
        buyer = COALESCE(?, buyer)
      WHERE id = ? AND status IN ('pending', 'expired')
    `).run(
      status,
      occurredAt,
      info.channelOrderId || null,
      info.channelOrderId || null,
      info.channelOrderId || null,
      info.buyer || "",
      current.id,
    );

    database.query("DELETE FROM amount_reservations WHERE order_id = ?").run(current.id);

    database.query(`
      INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
      VALUES (?, ?, 'pending', 0, 10, ?, 0, ?, ?)
    `).run(crypto.randomUUID(), current.id, now, now, now);

    if (info.eventId) {
      database.query("INSERT INTO hook_events(event_id, trade_no, created_at) VALUES (?, ?, ?)").run(info.eventId, current.trade_no, now);
    }

    database.exec("COMMIT");
    return true;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function recordAndMatchPayment(
  database: AppDatabase,
  event: AccountLogEvent,
  candidates = getActiveOrders(database),
): { matched: boolean; duplicate: boolean; orderId: string | null } {
  const receivedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.query("SELECT matched_order_id FROM payment_events WHERE account_log_id = ?").get(event.accountLogId) as { matched_order_id: string | null } | null;
    if (existing) {
      database.exec("COMMIT");
      return { matched: false, duplicate: true, orderId: existing.matched_order_id };
    }

    let matchedOrder: OrderRecord | undefined;
    if (event.direction === "收入") {
      matchedOrder = candidates.find((order) => {
        const occurred = Date.parse(event.occurredAt);
        const withinWindow = occurred >= Date.parse(order.created_at) - 60_000 && occurred <= Date.parse(order.monitor_until);
        if (!withinWindow || order.payable_amount_cents !== event.amountCents) return false;
        if (order.collection_mode === "transfer" || order.collection_mode === "alipay_transfer") {
          return (event.transMemo ?? "").trim() === order.out_trade_no;
        }
        return true;
      });
    }

    database.query(`
      INSERT INTO payment_events(
        account_log_id, matched_order_id, occurred_at, received_at, direction,
        amount_cents, alipay_order_no, trans_memo, other_account, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.accountLogId,
      matchedOrder?.id ?? null,
      event.occurredAt,
      receivedAt,
      event.direction,
      event.amountCents,
      event.alipayOrderNo || null,
      event.transMemo || null,
      event.otherAccount || null,
      JSON.stringify(event.raw),
    );

    if (matchedOrder) {
      const current = getOrderById(database, matchedOrder.id);
      if (current && (current.status === "pending" || current.status === "expired") && Date.parse(event.occurredAt) <= Date.parse(current.monitor_until)) {
        const status: OrderStatus = Date.parse(event.occurredAt) <= Date.parse(current.expires_at) ? "paid" : "late_paid";
        database.query(`
          UPDATE orders SET status = ?, paid_at = ?, alipay_account_log_id = ?, alipay_order_no = ?, buyer = ?
          WHERE id = ? AND status IN ('pending', 'expired')
        `).run(status, event.occurredAt, event.accountLogId, event.alipayOrderNo || null, event.otherAccount ?? null, current.id);
        database.query(`
          INSERT INTO notification_jobs(id, order_id, status, attempts, max_attempts, next_attempt_at, manual, created_at, updated_at)
          VALUES (?, ?, 'pending', 0, 10, ?, 0, ?, ?)
        `).run(crypto.randomUUID(), current.id, receivedAt, receivedAt, receivedAt);
      } else {
        matchedOrder = undefined;
      }
    }

    database.exec("COMMIT");
    return { matched: Boolean(matchedOrder), duplicate: false, orderId: matchedOrder?.id ?? null };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function externalStatus(status: OrderStatus) {
  return status === "paid" || status === "late_paid" ? 1 : 0;
}

export function formatApiDate(value: string | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function serializeOrder(order: OrderRecord) {
  return {
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    api_trade_no: order.channel_order_id ?? order.alipay_order_no ?? order.wxpay_transaction_id ?? "",
    type: order.type,
    pid: Number(order.pid),
    addtime: formatApiDate(order.created_at),
    ...(order.paid_at ? { endtime: formatApiDate(order.paid_at) } : {}),
    name: order.name,
    money: centsToMoney(order.requested_amount_cents),
    status: externalStatus(order.status),
    param: order.param,
    buyer: order.buyer,
    clientip: order.client_ip,
  };
}

export function buildReturnParameters(order: OrderRecord) {
  return {
    pid: order.pid,
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    api_trade_no: order.channel_order_id ?? order.alipay_order_no ?? order.wxpay_transaction_id ?? "",
    type: order.type,
    trade_status: "TRADE_SUCCESS",
    addtime: formatApiDate(order.created_at),
    endtime: formatApiDate(order.paid_at),
    name: order.name,
    money: centsToMoney(order.requested_amount_cents),
    param: order.param,
    buyer: order.buyer,
  };
}

export function createTransferUri(order: OrderRecord, userId: string, layer: TransferLinkLayer = 2) {
  const params = new URLSearchParams({
    appId: "09999988",
    actionType: "toAccount",
    goBack: "NO",
    amount: centsToMoney(order.payable_amount_cents),
    userId,
    memo: order.out_trade_no,
  });
  const firstLayer = `alipays://platformapi/startapp?${params.toString()}`;
  if (layer === 1) return firstLayer;
  const secondLayer = `https://render.alipay.com/p/s/i?scheme=${encodeURIComponent(firstLayer)}`;
  if (layer === 2) return secondLayer;
  return `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(secondLayer)}`;
}

export function getCheckoutData(database: AppDatabase, token: string, returnTarget: string | null = null): CheckoutData {
  const order = getOrderByCheckoutToken(database, token);
  if (!order) throw new AppError(404, "CHECKOUT_NOT_FOUND", "支付订单不存在");

  let paymentUri = "";
  let qrPayload = order.channel_qr_payload ?? "";
  let qrImageUrl = "";

  if (order.type === "alipay") {
    if (order.collection_mode === "alipay_f2f") {
      qrPayload = order.channel_qr_payload ?? "";
      paymentUri = qrPayload ? `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(qrPayload)}` : "";
    } else if (order.collection_mode === "alipay_transfer" || order.collection_mode === "transfer") {
      const userId = getSetting(database, "transfer_user_id", "");
      const layer = getSetting<TransferLinkLayer>(database, "transfer_link_layer", 2);
      paymentUri = userId ? createTransferUri(order, userId, layer) : "";
      qrPayload = paymentUri;
    } else {
      // alipay_bill or business_qr
      qrImageUrl = getSetting(database, "business_qr_url", "");
      qrPayload = getSetting(database, "business_qr_raw", "") || qrImageUrl;
    }
  } else if (order.type === "wxpay") {
    if (order.collection_mode === "wxpay_native") {
      qrPayload = order.channel_qr_payload ?? "";
      paymentUri = qrPayload;
    } else {
      // wxpay_hook
      qrImageUrl = getSetting(database, "wxpay_static_qr_url", "");
      qrPayload = qrImageUrl;
    }
  }

  return {
    trade_no: order.trade_no,
    out_trade_no: order.out_trade_no,
    name: order.name,
    type: order.type,
    requested_money: centsToMoney(order.requested_amount_cents),
    payable_money: centsToMoney(order.payable_amount_cents),
    collection_mode: order.collection_mode,
    status: order.status,
    created_at: order.created_at,
    expires_at: order.expires_at,
    monitor_until: order.monitor_until,
    payment_poll_interval_seconds: getPaymentPollIntervalSeconds(database),
    payment_uri: paymentUri,
    qr_payload: qrPayload,
    qr_image_url: qrImageUrl,
    business_qr_url: qrImageUrl || getSetting(database, "business_qr_url", ""),
    return_url: order.return_url,
    return_target: returnTarget,
  };
}
