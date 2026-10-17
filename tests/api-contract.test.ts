import { afterEach, describe, expect, it } from "bun:test";
import type { AccountLogPage, AccountLogProvider } from "../src/server/alipay";
import { PaymentScanner } from "../src/server/alipay";
import { setSetting, type AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/index";
import { NotificationWorker } from "../src/server/notifications";
import { md5Sign, rsaSign, rsaVerify } from "../src/server/security";
import { configuredDatabase } from "./helpers";

class EmptyProvider implements AccountLogProvider {
  async query(input: { pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: 0, details: [], traceId: "test" };
  }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

function form(parameters: Record<string, string>) {
  return new URLSearchParams(parameters).toString();
}

describe("EasyPay V1 contract", () => {
  it("creates idempotent orders and requires the key for queries", async () => {
    const configured = configuredDatabase("transfer");
    database = configured.database;
    setSetting(database, "transfer_link_layer", 2);
    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });
    const unsigned = {
      pid: "1000000001", type: "alipay", out_trade_no: "V1-ORDER-1",
      notify_url: "https://merchant.example/notify", return_url: "https://merchant.example/return",
      name: "V1 product", money: "1.00", clientip: "203.0.113.10", sign_type: "MD5",
    };
    const signed = { ...unsigned, sign: md5Sign(unsigned, "1234567890abcdef1234567890abcdef") };
    const first = await app.request("http://localhost/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(signed) });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as Record<string, unknown>;
    expect(firstBody.code).toBe(1);
    expect(firstBody.qrcode).toMatch(/^https:\/\/render\.alipay\.com\/p\/s\/i\?scheme=/);
    const secondBody = await (await app.request("http://localhost/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(signed) })).json() as Record<string, unknown>;
    expect(secondBody.trade_no).toBe(firstBody.trade_no);

    const denied = await app.request("http://localhost/api.php?act=order&pid=1000000001&out_trade_no=V1-ORDER-1");
    expect((await denied.json() as { code: number }).code).toBe(-1);
    const query = await app.request("http://localhost/api.php?act=order&pid=1000000001&key=1234567890abcdef1234567890abcdef&out_trade_no=V1-ORDER-1");
    const queryBody = await query.json() as Record<string, unknown>;
    expect(queryBody.code).toBe(1);
    expect(queryBody.status).toBe(0);
    expect(queryBody.out_trade_no).toBe("V1-ORDER-1");
  });
});

describe("EasyPay V2 contract", () => {
  it("verifies merchant requests and signs responses and errors", async () => {
    const configured = configuredDatabase("transfer");
    database = configured.database;
    setSetting(database, "transfer_link_layer", 2);
    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });
    const unsigned = {
      pid: "1000000001", method: "web", type: "alipay", out_trade_no: "V2-ORDER-1",
      notify_url: "https://merchant.example/notify", return_url: "https://merchant.example/return",
      name: "V2 product", money: "2.00", clientip: "203.0.113.10",
      timestamp: String(Math.floor(Date.now() / 1_000)), sign_type: "RSA",
    };
    const signed = { ...unsigned, sign: rsaSign(unsigned, configured.merchant.privateKey) };
    const response = await app.request("http://localhost/api/pay/create", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(signed) });
    const body = await response.json() as Record<string, string | number>;
    expect(body.code).toBe(0);
    expect(body.pay_type).toBe("qrcode");
    expect(body.pay_info).toMatch(/^https:\/\/render\.alipay\.com\/p\/s\/i\?scheme=/);
    expect(rsaVerify(body, configured.platform.publicKey)).toBe(true);

    const queryUnsigned = {
      pid: "1000000001",
      out_trade_no: "V2-ORDER-1",
      timestamp: String(Math.floor(Date.now() / 1_000)),
      sign_type: "RSA",
    };
    const queryResponse = await app.request("http://localhost/api/pay/query", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...queryUnsigned, sign: rsaSign(queryUnsigned, configured.merchant.privateKey) }),
    });
    const queryBody = await queryResponse.json() as Record<string, string | number>;
    expect(queryBody.code).toBe(0);
    expect(queryBody.status).toBe(0);
    expect(queryBody.out_trade_no).toBe("V2-ORDER-1");
    expect(rsaVerify(queryBody, configured.platform.publicKey)).toBe(true);

    const ordersUnsigned = {
      pid: "1000000001", offset: "0", limit: "50",
      timestamp: String(Math.floor(Date.now() / 1_000)), sign_type: "RSA",
    };
    const ordersResponse = await app.request("http://localhost/api/merchant/orders", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form({ ...ordersUnsigned, sign: rsaSign(ordersUnsigned, configured.merchant.privateKey) }),
    });
    const ordersBody = await ordersResponse.json() as Record<string, unknown>;
    expect(Array.isArray(ordersBody.data)).toBe(true);
    expect(rsaVerify(ordersBody, configured.platform.publicKey)).toBe(true);

    const expiredUnsigned = { pid: "1000000001", timestamp: String(Math.floor(Date.now() / 1_000) - 1_000), sign_type: "RSA" };
    const expired = { ...expiredUnsigned, sign: rsaSign(expiredUnsigned, configured.merchant.privateKey) };
    const failed = await app.request("http://localhost/api/merchant/info", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form(expired) });
    const failedBody = await failed.json() as Record<string, string | number>;
    expect(failedBody.code).toBe(1);
    expect(rsaVerify(failedBody, configured.platform.publicKey)).toBe(true);
  });
});

describe("PC WeChat Hook contract", () => {
  it("enforces hook token authentication and matches pending wxpay orders", async () => {
    const configured = configuredDatabase("business_qr");
    database = configured.database;
    const { setSecret } = await import("../src/server/config");
    setSecret(database, "wxpay_hook_token", "test-secret-token");
    setSetting(database, "wxpay_mode", "hook");
    setSetting(database, "wxpay_static_qr_url", "http://localhost/uploads/wechat-qr-test.png");

    const scanner = new PaymentScanner(database, new EmptyProvider());
    const { app } = createApp({ database, scanner, notifications: new NotificationWorker(database, fetch) });

    const { createOrder } = await import("../src/server/orders");
    const { order } = await createOrder(database, {
      pid: "1000000001",
      apiVersion: "v1",
      type: "wxpay",
      outTradeNo: "HOOK-TEST-1",
      name: "Hook item",
      money: "5.00",
      notifyUrl: "https://8.8.8.8/notify",
      returnUrl: "https://8.8.8.8/return",
    });
    expect(order.type).toBe("wxpay");

    // 1. Missing token returns 401
    // 0. GET health check diagnostics
    const getNoToken = await app.request("http://localhost/api/hook/receive");
    expect(getNoToken.status).toBe(200);
    const getNoTokenBody = await getNoToken.json() as Record<string, unknown>;
    expect(getNoTokenBody.status).toBe("pending_auth");

    const getValidToken = await app.request("http://localhost/api/hook/receive?token=test-secret-token");
    expect(getValidToken.status).toBe(200);
    const getValidTokenBody = await getValidToken.json() as Record<string, unknown>;
    expect(getValidTokenBody.status).toBe("ok");

    // 1. Missing token returns 401
    const noToken = await app.request("http://localhost/api/hook/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "wechat", money: "5.00" }),
    });
    expect(noToken.status).toBe(401);

    // 2. Invalid token returns 401
    const badToken = await app.request("http://localhost/api/hook/receive?token=wrong", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "wechat", money: "5.00" }),
    });
    expect(badToken.status).toBe(401);

    // 3. Valid token matches and confirms order (tolerating currency symbol ￥)
    const valid = await app.request("http://localhost/api/hook/receive?token=test-secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "wechat", money: "￥5.00" }),
    });
    expect(valid.status).toBe(200);
    const validBody = await valid.json() as Record<string, unknown>;
    expect(validBody.code).toBe(1);
    expect(validBody.trade_no).toBe(order.trade_no);

    // 4. Order is now paid
    const { getOrderById } = await import("../src/server/orders");
    const updated = getOrderById(database, order.id);
    expect(updated?.status).toBe("paid");

    // 5. The same receipt event must not pay a later order of the same amount
    const { order: replayOrder } = await createOrder(database, {
      pid: "1000000001",
      apiVersion: "v1",
      type: "wxpay",
      outTradeNo: "HOOK-TEST-2",
      name: "Hook item 2",
      money: "6.00",
      notifyUrl: "https://8.8.8.8/notify",
      returnUrl: "https://8.8.8.8/return",
    });
    const firstReceipt = await app.request("http://localhost/api/hook/receive?token=test-secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "wechat", money: "6.00", event_id: "gh_f0a92aa7146c:1001" }),
    });
    expect(firstReceipt.status).toBe(200);
    const firstBody = await firstReceipt.json() as Record<string, unknown>;
    expect(firstBody.code).toBe(1);
    expect(firstBody.trade_no).toBe(replayOrder.trade_no);

    const { order: laterOrder } = await createOrder(database, {
      pid: "1000000001",
      apiVersion: "v1",
      type: "wxpay",
      outTradeNo: "HOOK-TEST-3",
      name: "Hook item 3",
      money: "6.00",
      notifyUrl: "https://8.8.8.8/notify",
      returnUrl: "https://8.8.8.8/return",
    });
    const replay = await app.request("http://localhost/api/hook/receive?token=test-secret-token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "wechat", money: "6.00", event_id: "gh_f0a92aa7146c:1001" }),
    });
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as Record<string, unknown>;
    expect(replayBody.duplicate).toBe(true);
    expect(replayBody.trade_no).toBe(replayOrder.trade_no);
    expect(getOrderById(database, laterOrder.id)?.status).toBe("pending");
  });
});
