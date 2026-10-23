import {
  PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS,
  PAYMENT_POLL_INTERVAL_MAX_SECONDS,
  PAYMENT_POLL_INTERVAL_MIN_SECONDS,
  type AlipayMode,
  type CollectionMode,
  type PublicSettings,
  type TransferLinkLayer,
  type WxpayMode,
} from "../shared/contracts";
import { getSetting, setSetting, type AppDatabase } from "./db";
import { getRuntimeEnv } from "./env";
import { decryptSecret, encryptSecret } from "./security";

export const SECRET_SETTING_KEYS = [
  "alipay_private_key",
  "v1_key",
  "v2_platform_private_key",
  "wxpay_private_key",
  "wxpay_api_v3_key",
  "wxpay_hook_token",
] as const;
export type SecretSettingKey = (typeof SECRET_SETTING_KEYS)[number];

export function getSecret(database: AppDatabase, key: SecretSettingKey) {
  const encrypted = getSetting<string>(database, key, "");
  return encrypted ? decryptSecret(encrypted, getRuntimeEnv().masterKey) : "";
}

export function setSecret(database: AppDatabase, key: SecretSettingKey, value: string) {
  setSetting(database, key, value ? encryptSecret(value, getRuntimeEnv().masterKey) : "", true);
}

export function getPaymentPollIntervalSeconds(database: AppDatabase) {
  const value = getSetting<number>(database, "payment_poll_interval_seconds", PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS);
  return Number.isInteger(value) && value >= PAYMENT_POLL_INTERVAL_MIN_SECONDS && value <= PAYMENT_POLL_INTERVAL_MAX_SECONDS
    ? value
    : PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS;
}

export function getPublicSettings(database: AppDatabase): PublicSettings {
  const v1Key = getSecret(database, "v1_key");
  const alipayMode = getSetting<AlipayMode>(database, "alipay_mode", "f2f");
  const wxpayMode = getSetting<WxpayMode>(database, "wxpay_mode", "native");

  const alipayConfigured = Boolean(
    getSetting(database, "alipay_app_id", "") &&
    getSecret(database, "alipay_private_key") &&
    getSetting(database, "alipay_public_key", ""),
  );

  const wxpayConfigured = wxpayMode === "hook"
    ? Boolean(getSetting(database, "wxpay_static_qr_url", "") && getSecret(database, "wxpay_hook_token"))
    : Boolean(
        getSetting(database, "wxpay_app_id", "") &&
        getSetting(database, "wxpay_mch_id", "") &&
        getSetting(database, "wxpay_serial_no", "") &&
        getSecret(database, "wxpay_private_key"),
      );

  return {
    setup_completed: getSetting(database, "setup_completed", false),
    public_base_url: getSetting(database, "public_base_url", getRuntimeEnv().publicBaseUrl),
    payment_poll_interval_seconds: getPaymentPollIntervalSeconds(database),
    allow_private_callbacks: getRuntimeEnv().allowPrivateCallbacks,

    // Alipay
    alipay_enabled: getSetting(database, "alipay_enabled", true),
    alipay_mode: alipayMode,
    alipay_app_id: getSetting(database, "alipay_app_id", ""),
    alipay_endpoint: getSetting(database, "alipay_endpoint", "https://openapi.alipay.com"),
    alipay_configured: alipayConfigured,
    business_qr_url: getSetting(database, "business_qr_url", ""),
    business_qr_raw: getSetting(database, "business_qr_raw", ""),
    transfer_link_layer: getSetting<TransferLinkLayer>(database, "transfer_link_layer", 2),

    // WeChat Pay
    wxpay_enabled: getSetting(database, "wxpay_enabled", true),
    wxpay_mode: wxpayMode,
    wxpay_app_id: getSetting(database, "wxpay_app_id", ""),
    wxpay_mch_id: getSetting(database, "wxpay_mch_id", ""),
    wxpay_serial_no: getSetting(database, "wxpay_serial_no", ""),
    wxpay_public_key: getSetting(database, "wxpay_public_key", ""),
    wxpay_configured: wxpayConfigured,
    wxpay_static_qr_url: getSetting(database, "wxpay_static_qr_url", ""),
    wxpay_hook_token_configured: Boolean(getSecret(database, "wxpay_hook_token")),

    // EasyPay
    v1_enabled: getSetting(database, "v1_enabled", true),
    v2_enabled: getSetting(database, "v2_enabled", true),
    merchant_pid: getSetting(database, "merchant_pid", ""),
    v1_key_masked: v1Key ? `${v1Key.slice(0, 4)}••••••••${v1Key.slice(-4)}` : "",
    v2_platform_public_key: getSetting(database, "v2_platform_public_key", ""),
    v2_merchant_public_key: getSetting(database, "v2_merchant_public_key", ""),

    // Compatibility
    collection_mode: getSetting<CollectionMode>(database, "collection_mode", "alipay_f2f"),
  };
}

export function isGatewayReady(database: AppDatabase) {
  const settings = getPublicSettings(database);
  if (!settings.setup_completed || !settings.merchant_pid) return false;
  const alipayReady = settings.alipay_enabled && settings.alipay_configured;
  const wxpayReady = settings.wxpay_enabled && settings.wxpay_configured;
  return alipayReady || wxpayReady;
}
