import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, getSetting, type AppDatabase } from "../src/server/db";

let directory = "";
const opened: AppDatabase[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

function seedLegacyLayer(path: string, layer: number) {
  const database = new Database(path);
  database.exec(`
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
  `);
  database.query("INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
  database.query("INSERT INTO settings(key, value_json, is_secret, updated_at) VALUES ('transfer_link_layer', ?, 0, ?)")
    .run(JSON.stringify(layer), new Date().toISOString());
  database.close();
}

describe("database settings migrations", () => {
  it("maps the old five-layer numbering to the retained three layers once", () => {
    directory = mkdtempSync(join(tmpdir(), "apuspay-db-test-"));
    const cases: Array<readonly [number, number]> = [[5, 1], [4, 2], [3, 3], [2, 3], [1, 3]];
    for (const [legacy, expected] of cases) {
      const path = join(directory, `legacy-${legacy}.sqlite`);
      seedLegacyLayer(path, legacy);
      const database = createDatabase(path);
      expect(getSetting(database, "transfer_link_layer", 0)).toBe(expected);
      expect(database.query("SELECT 1 FROM schema_migrations WHERE version = 2").get()).not.toBeNull();
      database.close();

      const reopened = createDatabase(path);
      opened.push(reopened);
      expect(getSetting(reopened, "transfer_link_layer", 0)).toBe(expected);
    }
  });

  it("uses the verified HTTPS layer for new databases", () => {
    directory = mkdtempSync(join(tmpdir(), "apuspay-db-test-"));
    const database = createDatabase(join(directory, "fresh.sqlite"));
    opened.push(database);
    expect(getSetting(database, "transfer_link_layer", 0)).toBe(2);
  });

  it("adds wxpay_transaction_id unique index and per-channel amount_reservations on legacy v3 databases", () => {
    directory = mkdtempSync(join(tmpdir(), "apuspay-db-v6-"));
    const path = join(directory, "legacy-v3.sqlite");
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE admin_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, ip TEXT NOT NULL DEFAULT '', user_agent TEXT NOT NULL DEFAULT '');
      CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, is_secret INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
      CREATE TABLE orders (
        id TEXT PRIMARY KEY, trade_no TEXT NOT NULL UNIQUE, pid TEXT NOT NULL, api_version TEXT NOT NULL,
        out_trade_no TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'alipay', name TEXT NOT NULL,
        requested_amount_cents INTEGER NOT NULL, payable_amount_cents INTEGER NOT NULL, collection_mode TEXT NOT NULL,
        notify_url TEXT NOT NULL, return_url TEXT, param TEXT NOT NULL DEFAULT '', client_ip TEXT NOT NULL DEFAULT '',
        checkout_token TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
        monitor_until TEXT NOT NULL, paid_at TEXT, alipay_account_log_id TEXT UNIQUE, alipay_order_no TEXT,
        wxpay_transaction_id TEXT, channel_order_id TEXT, channel_qr_payload TEXT, buyer TEXT NOT NULL DEFAULT '',
        raw_request_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE amount_reservations (
        id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount_cents INTEGER NOT NULL UNIQUE,
        reserved_until TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE notification_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, attempt_number INTEGER NOT NULL, requested_at TEXT NOT NULL);
    `);
    const now = new Date().toISOString();
    for (const v of [1, 2, 3]) {
      raw.query("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(v, now);
    }
    raw.close();

    const upgraded = createDatabase(path);
    opened.push(upgraded);
    const indexes = upgraded.query("PRAGMA index_list(orders)").all() as Array<{ name: string; unique: number }>;
    expect(indexes.some((idx) => idx.name === "idx_orders_wxpay_tx_unique" && idx.unique === 1)).toBe(true);
    const orderCols = (upgraded.query("PRAGMA table_info(orders)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(orderCols).toContain("upstream_closed_at");
    const resCols = (upgraded.query("PRAGMA table_info(amount_reservations)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(resCols).toContain("channel");
  });
});
