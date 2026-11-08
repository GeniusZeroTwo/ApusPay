import { afterEach, describe, expect, it } from "bun:test";
import { PaymentScanner, type AccountLogPage, type AccountLogProvider } from "../src/server/alipay";
import { setSetting, type AppDatabase } from "../src/server/db";
import { createOrder, getOrderById } from "../src/server/orders";
import { configuredDatabase, orderInput } from "./helpers";

class FakeProvider implements AccountLogProvider {
  calls = 0;
  constructor(public details: Array<Record<string, unknown>> = [], private delay = 0) {}
  async query(input: { pageNo: number; pageSize: number }): Promise<AccountLogPage> {
    this.calls += 1;
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay));
    return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: this.details.length, traceId: "trace-test", details: this.details };
  }
}

let database: AppDatabase | undefined;
afterEach(() => database?.close());

describe("shared payment scanner", () => {
  it("makes zero upstream calls with no active order", async () => {
    ({ database } = configuredDatabase());
    const provider = new FakeProvider();
    const result = await new PaymentScanner(database, provider).scanNow();
    expect(result.status).toBe("skipped");
    expect(provider.calls).toBe(0);
  });

  it("coalesces many orders into one query and stops after they are paid", async () => {
    ({ database } = configuredDatabase());
    const first = (await createOrder(database, orderInput(1))).order;
    const second = (await createOrder(database, orderInput(2))).order;
    const provider = new FakeProvider([
      { account_log_id: "A1", trans_dt: new Date().toISOString(), direction: "收入", trans_amount: (first.payable_amount_cents / 100).toFixed(2), alipay_order_no: "ALI1" },
      { account_log_id: "A2", trans_dt: new Date().toISOString(), direction: "收入", trans_amount: (second.payable_amount_cents / 100).toFixed(2), alipay_order_no: "ALI2" },
    ]);
    const scanner = new PaymentScanner(database, provider);
    const result = await scanner.scanNow();
    expect(provider.calls).toBe(1);
    expect(result.matched).toBe(2);
    expect(getOrderById(database, first.id)?.status).toBe("paid");
    expect(getOrderById(database, second.id)?.status).toBe("paid");
    expect((await scanner.scanNow()).status).toBe("skipped");
    expect(provider.calls).toBe(1);
  });

  it("coalesces concurrent refresh requests into one in-flight scan", async () => {
    ({ database } = configuredDatabase());
    await createOrder(database, orderInput(1));
    const provider = new FakeProvider([], 20);
    const scanner = new PaymentScanner(database, provider);
    await Promise.all([scanner.scanNow("one"), scanner.scanNow("two"), scanner.scanNow("three")]);
    expect(provider.calls).toBe(1);
  });

  it("applies polling interval changes without restarting the scanner", async () => {
    ({ database } = configuredDatabase());
    const order = (await createOrder(database, orderInput(1))).order;
    const provider = new FakeProvider();
    const scanner = new PaymentScanner(database, provider);
    await scanner.scanNow();
    (scanner as unknown as { lastCompletedAt: number }).lastCompletedAt = Date.now() - 2_000;

    setSetting(database, "payment_poll_interval_seconds", 3);
    await scanner.ensureFresh(order);
    expect(provider.calls).toBe(1);

    setSetting(database, "payment_poll_interval_seconds", 1);
    await scanner.ensureFresh(order);
    expect(provider.calls).toBe(2);
  });

  it("does not query after the 10-minute monitor deadline", async () => {
    ({ database } = configuredDatabase());
    const order = (await createOrder(database, orderInput(1))).order;
    database.query("UPDATE orders SET expires_at = ?, monitor_until = ?, status = 'expired' WHERE id = ?").run(
      new Date(Date.now() - 6 * 60_000).toISOString(), new Date(Date.now() - 1).toISOString(), order.id,
    );
    const provider = new FakeProvider();
    expect((await new PaymentScanner(database, provider).scanNow()).status).toBe("skipped");
    expect(provider.calls).toBe(0);
  });

  it("coalesces and rate-limits direct F2F queries in ensureFresh", async () => {
    ({ database } = configuredDatabase());
    setSetting(database, "alipay_mode", "f2f");
    setSetting(database, "collection_mode", "alipay_f2f");
    const order = (await createOrder(database, orderInput(1))).order;
    expect(order.collection_mode).toBe("alipay_f2f");

    let tradeQueries = 0;
    const f2fProvider: AccountLogProvider = {
      async query(input) {
        return { pageNo: input.pageNo, pageSize: input.pageSize, totalSize: 0, traceId: "t", details: [] };
      },
      async queryTrade() {
        tradeQueries += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { success: false };
      },
    };

    const scanner = new PaymentScanner(database, f2fProvider);
    // 5 concurrent + immediate back-to-back ensureFresh calls should coalesce/cooldown to 1 upstream call
    await Promise.all([
      scanner.ensureFresh(order),
      scanner.ensureFresh(order),
      scanner.ensureFresh(order),
    ]);
    await scanner.ensureFresh(order);
    expect(tradeQueries).toBe(1);
  });
});
