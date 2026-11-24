import { afterEach, describe, expect, it } from "bun:test";
import { setSetting, type AppDatabase } from "../src/server/db";
import {
  createTransferUri,
  createOrder,
  externalStatus,
  formatApiDate,
  getActiveOrders,
  getCheckoutData,
  getOrderById,
  markOrderPaidDirectly,
  recordAndMatchPayment,
} from "../src/server/orders";
import { configuredDatabase, orderInput } from "./helpers";

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("order allocation and idempotency", () => {
  it("allocates unique cent amounts transactionally", async () => {
    ({ database } = configuredDatabase());
    const orders = [];
    for (const index of [1, 2, 3]) {
      orders.push((await createOrder(database!, orderInput(index))).order);
    }
    expect(orders.map((order) => order.payable_amount_cents)).toEqual([100, 101, 102]);
    expect(new Set(orders.map((order) => order.payable_amount_cents)).size).toBe(3);
  });

  it("returns an identical duplicate and rejects an immutable conflict", async () => {
    ({ database } = configuredDatabase());
    const first = await createOrder(database, orderInput(1));
    const duplicate = await createOrder(database, orderInput(1));
    expect(duplicate.reused).toBe(true);
    expect(duplicate.order.id).toBe(first.order.id);
    expect(createOrder(database!, { ...orderInput(1), money: "2.00" })).rejects.toThrow(/已存在/);
  });
});

describe("payment state machine", () => {
  it("marks payments in minutes 5-7 as late_paid and deduplicates account logs", async () => {
    ({ database } = configuredDatabase());
    const order = (await createOrder(database, orderInput(1))).order;
    const now = new Date();
    database.query("UPDATE orders SET expires_at = ?, monitor_until = ?, status = 'expired' WHERE id = ?").run(
      new Date(now.getTime() - 60_000).toISOString(),
      new Date(now.getTime() + 5 * 60_000).toISOString(),
      order.id,
    );
    const event = {
      accountLogId: "LOG-1",
      occurredAt: now.toISOString(),
      direction: "收入",
      amountCents: order.payable_amount_cents,
      alipayOrderNo: "ALI-1",
      transMemo: "",
      otherAccount: "buyer@example.com",
      raw: {},
    };
    const result = recordAndMatchPayment(database, event, getActiveOrders(database));
    expect(result.matched).toBe(true);
    expect(getOrderById(database, order.id)?.status).toBe("late_paid");
    expect(recordAndMatchPayment(database, event, getActiveOrders(database)).duplicate).toBe(true);
    expect((database.query("SELECT COUNT(*) AS count FROM notification_jobs").get() as { count: number }).count).toBe(1);
  });

  it("never matches outgoing events", async () => {
    ({ database } = configuredDatabase());
    const order = (await createOrder(database, orderInput(1))).order;
    const result = recordAndMatchPayment(database, {
      accountLogId: "OUT-1", occurredAt: new Date().toISOString(), direction: "支出",
      amountCents: order.payable_amount_cents, alipayOrderNo: "", transMemo: "", otherAccount: "", raw: {},
    }, [order]);
    expect(result.matched).toBe(false);
    expect(getOrderById(database, order.id)?.status).toBe("pending");
  });

  it("requires an exact memo in transfer compatibility mode", async () => {
    ({ database } = configuredDatabase("transfer"));
    const order = (await createOrder(database, orderInput(1))).order;
    expect(order.payable_amount_cents).toBe(100);
    expect(createTransferUri(order, "2088000000000000", 1)).toContain("appId=09999988");
    expect(createTransferUri(order, "2088000000000000", 1)).toContain("memo=ORDER-1");
    const wrong = recordAndMatchPayment(database, {
      accountLogId: "MEMO-WRONG", occurredAt: new Date().toISOString(), direction: "收入",
      amountCents: 100, alipayOrderNo: "", transMemo: "OTHER", otherAccount: "", raw: {},
    }, [order]);
    expect(wrong.matched).toBe(false);
    const correct = recordAndMatchPayment(database, {
      accountLogId: "MEMO-CORRECT", occurredAt: new Date().toISOString(), direction: "收入",
      amountCents: 100, alipayOrderNo: "", transMemo: "ORDER-1", otherAccount: "", raw: {},
    }, [order]);
    expect(correct.matched).toBe(true);
  });

  it("generates every selectable transfer link layer", async () => {
    ({ database } = configuredDatabase("transfer"));
    const order = (await createOrder(database, orderInput(1))).order;
    const layers = {
      1: createTransferUri(order, "2088000000000000", 1),
      2: createTransferUri(order, "2088000000000000", 2),
      3: createTransferUri(order, "2088000000000000", 3),
    };

    expect(new URL(layers[3]).searchParams.get("url")).toBe(layers[2]);
    expect(new URL(layers[2]).searchParams.get("scheme")).toBe(layers[1]);
    expect(createTransferUri(order, "2088000000000000")).toBe(layers[2]);
    expect(layers[2]).toStartWith("https://render.alipay.com/p/s/i?scheme=");
    expect(layers[1]).toContain("appId=09999988");
    expect(layers[1]).toContain("memo=ORDER-1");
  });

  it("returns the configured payment polling interval to checkout", async () => {
    ({ database } = configuredDatabase("transfer"));
    setSetting(database, "payment_poll_interval_seconds", 12);
    const order = (await createOrder(database, orderInput(1))).order;
    expect(getCheckoutData(database, order.checkout_token)?.payment_poll_interval_seconds).toBe(12);
  });

  it("maps expired to unpaid and late paid to paid externally", () => {
    expect(externalStatus("pending")).toBe(0);
    expect(externalStatus("expired")).toBe(0);
    expect(externalStatus("paid")).toBe(1);
    expect(externalStatus("late_paid")).toBe(1);
  });

  it("rejects payments with mismatched channel", async () => {
    ({ database } = configuredDatabase());
    const order = (await createOrder(database, orderInput(1))).order;
    expect(order.type).toBe("alipay");
    const mismatch = markOrderPaidDirectly(database, order.id, {
      channel: "wxpay",
      channelOrderId: "WX-123",
      buyer: "buyer",
    });
    expect(mismatch).toBe(false);
    expect(getOrderById(database, order.id)?.status).toBe("pending");

    const match = markOrderPaidDirectly(database, order.id, {
      channel: "alipay",
      channelOrderId: "ALI-123",
      buyer: "buyer",
    });
    expect(match).toBe(true);
    expect(getOrderById(database, order.id)?.status).toBe("paid");
  });

  it("releases surcharge reservation on recordAndMatchPayment and isolates non-bill orders", async () => {
    ({ database } = configuredDatabase("business_qr"));
    const { setSecret } = await import("../src/server/config");
    setSecret(database, "wxpay_hook_token", "hook-token-123456");
    setSetting(database, "wxpay_mode", "hook");
    setSetting(database, "wxpay_static_qr_url", "http://localhost/uploads/wechat-qr-test.png");

    // 1. Create a wxpay_hook order at 1.00 (100 cents)
    const wxOrder = (await createOrder(database, { ...orderInput(1), type: "wxpay" })).order;
    expect(wxOrder.payable_amount_cents).toBe(100);

    // 2. An Alipay bill event for 100 cents MUST NOT match the wxpay_hook order
    const crossMatch = recordAndMatchPayment(database, {
      accountLogId: "CROSS-LOG-1",
      occurredAt: new Date().toISOString(),
      direction: "收入",
      amountCents: 100,
      alipayOrderNo: "ALI-CROSS",
      transMemo: "",
      otherAccount: "buyer",
      raw: {},
    });
    expect(crossMatch.matched).toBe(false);
    expect(getOrderById(database, wxOrder.id)?.status).toBe("pending");

    // 3. Create an Alipay business_qr order at 2.00 (200 cents), pay it via recordAndMatchPayment,
    // and verify its surcharge reservation slot (200 cents) is immediately freed for the next order
    const aliOrder1 = (await createOrder(database, { ...orderInput(2), money: "2.00" })).order;
    expect(aliOrder1.payable_amount_cents).toBe(200);

    const aliMatch = recordAndMatchPayment(database, {
      accountLogId: "ALI-LOG-200",
      occurredAt: new Date().toISOString(),
      direction: "收入",
      amountCents: 200,
      alipayOrderNo: "ALI-OK-200",
      transMemo: "",
      otherAccount: "buyer",
      raw: {},
    });
    expect(aliMatch.matched).toBe(true);
    expect(getOrderById(database, aliOrder1.id)?.status).toBe("paid");

    const aliOrder2 = (await createOrder(database, { ...orderInput(3), money: "2.00" })).order;
    expect(aliOrder2.payable_amount_cents).toBe(200);

    // 4. Historical bill log 30 seconds before order creation must NOT match (-5s skew limit)
    const aliOrder3 = (await createOrder(database, { ...orderInput(4), money: "3.00" })).order;
    const staleBill = recordAndMatchPayment(database, {
      accountLogId: "STALE-LOG-30S",
      occurredAt: new Date(Date.parse(aliOrder3.created_at) - 30_000).toISOString(),
      direction: "收入",
      amountCents: aliOrder3.payable_amount_cents,
      alipayOrderNo: "ALI-STALE",
      transMemo: "",
      otherAccount: "offline-buyer",
      raw: {},
    });
    expect(staleBill.matched).toBe(false);
    expect(getOrderById(database, aliOrder3.id)?.status).toBe("pending");

    // 5. wxpay_hook paid order retains cooldown so immediate next wxpay order gets +0.01, while Alipay channel pool is independent
    expect(markOrderPaidDirectly(database, wxOrder.id, { channel: "wxpay", channelOrderId: "HOOK-1", buyer: "PC-Hook" })).toBe(true);
    const wxOrderNext = (await createOrder(database, { ...orderInput(5), type: "wxpay", money: "1.00" })).order;
    expect(wxOrderNext.payable_amount_cents).toBe(101);
    const aliIndependent = (await createOrder(database, { ...orderInput(6), type: "alipay", money: "1.00" })).order;
    expect(aliIndependent.payable_amount_cents).toBe(100);
  });

  it("coalesces concurrent F2F order creation, recovers null QR payloads, requires full wxpay_native keys, and guards invalid dates", async () => {
    ({ database } = configuredDatabase("alipay_f2f"));
    setSetting(database, "alipay_mode", "f2f");
    let precreateCalls = 0;
    let capturedTimeout: string | undefined;
    const mockAlipay = {
      precreateTrade: async (input: { outTradeNo: string; timeoutExpress?: string }) => {
        precreateCalls += 1;
        capturedTimeout = input.timeoutExpress;
        await new Promise((r) => setTimeout(r, 40));
        return { qrCode: `https://qr.alipay.com/mock-${input.outTradeNo}` };
      },
    } as never;

    const [resA, resB] = await Promise.all([
      createOrder(database, orderInput(10), { alipay: mockAlipay }),
      createOrder(database, orderInput(10), { alipay: mockAlipay }),
    ]);
    expect(precreateCalls).toBe(1);
    expect(capturedTimeout).toBe("6m");
    expect(resA.order.id).toBe(resB.order.id);
    expect(resA.order.channel_qr_payload).toStartWith("https://qr.alipay.com/mock-");
    expect(resB.order.channel_qr_payload).toBe(resA.order.channel_qr_payload);

    // Simulate crashed order with channel_qr_payload = NULL and verify retry self-heals
    database.query("UPDATE orders SET channel_qr_payload = NULL WHERE id = ?").run(resA.order.id);
    const recovered = await createOrder(database, orderInput(10), { alipay: mockAlipay });
    expect(precreateCalls).toBe(2);
    expect(recovered.order.channel_qr_payload).toStartWith("https://qr.alipay.com/mock-");

    // Malformed occurredAt / paid_at never throws RangeError
    expect(formatApiDate("not-a-valid-date")).toBe("");
    expect(markOrderPaidDirectly(database, resA.order.id, { channel: "alipay", channelOrderId: "ALI-F2F-1", occurredAt: "garbage-date" })).toBe(true);
    expect(formatApiDate(getOrderById(database, resA.order.id)?.paid_at ?? null)).not.toBe("");

    // WeChat Native requires both 32-char APIv3 key and platform public key
    const { setSecret, getPublicSettings } = await import("../src/server/config");
    setSetting(database, "wxpay_mode", "native");
    setSetting(database, "wxpay_app_id", "wx1234567890");
    setSetting(database, "wxpay_mch_id", "1900000109");
    setSetting(database, "wxpay_serial_no", "SERIAL12345");
    setSecret(database, "wxpay_private_key", configuredDatabase().alipay.privateKey);
    expect(getPublicSettings(database).wxpay_configured).toBe(false);
    await expect(createOrder(database, { ...orderInput(11), type: "wxpay" })).rejects.toThrow(/APIv3|尚未配置完整/);

    setSecret(database, "wxpay_api_v3_key", "0123456789abcdef0123456789abcdef");
    setSetting(database, "wxpay_public_key", configuredDatabase().alipay.publicKey);
    expect(getPublicSettings(database).wxpay_configured).toBe(true);
  });
});
