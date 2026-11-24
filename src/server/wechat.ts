import crypto from "node:crypto";
import { getSecret } from "./config";
import { getSetting, type AppDatabase } from "./db";
import { AppError } from "./errors";
import { getCachedPrivateKey, getCachedPublicKey } from "./security";

const WXPAY_API_TIMEOUT_MS = 8_000;

export interface WeChatPrepayResult {
  codeUrl: string;
}

export interface WeChatQueryResult {
  tradeState: "SUCCESS" | "NOTPAY" | "CLOSED" | "USERPAYING" | "PAYERROR";
  transactionId?: string;
  successTime?: string;
  payerOpenid?: string;
  amountCents?: number;
}

export class WeChatPayService {
  constructor(private readonly database: AppDatabase) {}

  public getCredentials(options?: { requireCallbackKeys?: boolean }) {
    const appId = getSetting(this.database, "wxpay_app_id", "");
    const mchId = getSetting(this.database, "wxpay_mch_id", "");
    const serialNo = getSetting(this.database, "wxpay_serial_no", "");
    const privateKey = getSecret(this.database, "wxpay_private_key");
    const apiV3Key = getSecret(this.database, "wxpay_api_v3_key");
    const publicKey = getSetting(this.database, "wxpay_public_key", "").trim();
    if (!appId || !mchId || !serialNo || !privateKey) {
      throw new AppError(503, "WXPAY_NOT_CONFIGURED", "微信支付 AppID、商户号、证书序列号或商户私钥尚未配置完整");
    }
    if (options?.requireCallbackKeys) {
      if (!apiV3Key || apiV3Key.length !== 32) {
        throw new AppError(503, "WXPAY_API_V3_KEY_MISSING", "微信支付 APIv3 密钥尚未配置或长度不为 32 位");
      }
      if (!publicKey) {
        throw new AppError(503, "WXPAY_PUBLIC_KEY_MISSING", "微信支付平台公钥/证书尚未配置");
      }
    }
    return { appId, mchId, serialNo, privateKey, apiV3Key, publicKey };
  }

  private buildAuthorization(method: string, urlPath: string, body = ""): string {
    const { mchId, serialNo, privateKey } = this.getCredentials();
    const nonce = crypto.randomBytes(16).toString("hex");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(message);
    const signature = sign.sign(getCachedPrivateKey(privateKey), "base64");

    return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
  }

  async nativePrepay(input: {
    outTradeNo: string;
    totalCents: number;
    description: string;
    notifyUrl?: string;
    timeExpire?: string;
  }): Promise<WeChatPrepayResult> {
    const { appId, mchId } = this.getCredentials({ requireCallbackKeys: true });
    const path = "/v3/pay/transactions/native";
    const publicUrl = getSetting(this.database, "public_base_url", "http://localhost");
    const bodyObj = {
      appid: appId,
      mchid: mchId,
      description: input.description.slice(0, 120),
      out_trade_no: input.outTradeNo,
      notify_url: input.notifyUrl || `${publicUrl.replace(/\/$/, "")}/api/pay/wechat/notify`,
      ...(input.timeExpire ? { time_expire: input.timeExpire } : {}),
      amount: {
        total: input.totalCents,
        currency: "CNY",
      },
    };
    const bodyStr = JSON.stringify(bodyObj);
    const auth = this.buildAuthorization("POST", path, bodyStr);

    const res = await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(WXPAY_API_TIMEOUT_MS),
    });

    const resJson = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      throw new AppError(502, "WXPAY_PREPAY_FAILED", String(resJson.message ?? resJson.detail ?? "微信 Native 下单失败"));
    }
    const codeUrl = String(resJson.code_url ?? "");
    if (!codeUrl) {
      throw new AppError(502, "WXPAY_MISSING_CODE_URL", "微信未返回支付二维码链接");
    }
    return { codeUrl };
  }

  async queryOrder(outTradeNo: string): Promise<WeChatQueryResult> {
    const { mchId } = this.getCredentials();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}?mchid=${encodeURIComponent(mchId)}`;
    const auth = this.buildAuthorization("GET", path, "");

    const res = await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: auth,
      },
      signal: AbortSignal.timeout(WXPAY_API_TIMEOUT_MS),
    });

    const resJson = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 404 || resJson.code === "ORDER_NOT_EXIST") {
        return { tradeState: "NOTPAY" };
      }
      throw new AppError(502, "WXPAY_QUERY_FAILED", String(resJson.message ?? "微信订单查询失败"));
    }

    const amountObj = resJson.amount as Record<string, unknown> | undefined;
    const currency = amountObj?.currency;
    if (currency !== undefined && currency !== "CNY") {
      throw new AppError(400, "WXPAY_CURRENCY_MISMATCH", "微信订单币种不匹配");
    }
    const rawTotal = amountObj?.total;
    const amountCents = typeof rawTotal === "number" && Number.isInteger(rawTotal) ? rawTotal : undefined;

    return {
      tradeState: (resJson.trade_state as WeChatQueryResult["tradeState"]) || "NOTPAY",
      transactionId: typeof resJson.transaction_id === "string" ? resJson.transaction_id : undefined,
      successTime: typeof resJson.success_time === "string" ? resJson.success_time : undefined,
      payerOpenid: (resJson.payer as Record<string, unknown>)?.openid as string | undefined,
      amountCents,
    };
  }

  verifyNotificationSignature(headers: Headers, rawBody: string): void {
    const platformPublicKey = getSetting(this.database, "wxpay_public_key", "").trim();
    if (!platformPublicKey) {
      throw new AppError(503, "WXPAY_PUBLIC_KEY_MISSING", "尚未配置微信支付平台公钥或证书，已拒绝未验签回调");
    }

    const timestamp = headers.get("wechatpay-timestamp")?.trim() ?? "";
    const nonce = headers.get("wechatpay-nonce")?.trim() ?? "";
    const signature = headers.get("wechatpay-signature")?.trim() ?? "";
    const serial = headers.get("wechatpay-serial")?.trim() ?? "";
    if (!timestamp || !nonce || !signature) {
      throw new AppError(401, "WXPAY_SIGNATURE_MISSING", "缺少微信支付回调签名头");
    }
    const expectedPlatformSerial = getSetting(this.database, "wxpay_platform_serial", "").trim();
    if (expectedPlatformSerial && serial !== expectedPlatformSerial) {
      throw new AppError(401, "WXPAY_SERIAL_MISMATCH", "微信回调平台证书/公钥序列号不匹配");
    }
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
      throw new AppError(401, "WXPAY_TIMESTAMP_EXPIRED", "微信回调时间戳无效或已过期");
    }

    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    let valid = false;
    try {
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(message, "utf8");
      verifier.end();
      valid = verifier.verify(getCachedPublicKey(platformPublicKey), signature, "base64");
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new AppError(401, "WXPAY_INVALID_SIGNATURE", "微信支付平台签名校验失败");
    }
  }

  async closeOrder(outTradeNo: string): Promise<void> {
    const { mchId } = this.getCredentials();
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(outTradeNo)}/close`;
    const bodyStr = JSON.stringify({ mchid: mchId });
    const auth = this.buildAuthorization("POST", path, bodyStr);

    await fetch(`https://api.mch.weixin.qq.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: auth,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(WXPAY_API_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  decryptNotification(ciphertext: string, nonce: string, associatedData: string): Record<string, unknown> {
    const { apiV3Key } = this.getCredentials();
    if (!apiV3Key || apiV3Key.length !== 32) {
      throw new AppError(500, "WXPAY_KEY_INVALID", "微信 APIv3 Key 长度必须为 32 位");
    }
    if (Buffer.byteLength(nonce, "utf-8") !== 12) {
      throw new AppError(400, "WXPAY_INVALID_NONCE", "微信回调 Nonce 长度无效");
    }

    const cipherBuffer = Buffer.from(ciphertext, "base64");
    if (cipherBuffer.length <= 16) {
      throw new AppError(400, "WXPAY_INVALID_CIPHERTEXT", "微信回调密文长度无效");
    }
    const authTag = cipherBuffer.subarray(cipherBuffer.length - 16);
    const encryptedData = cipherBuffer.subarray(0, cipherBuffer.length - 16);

    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf-8"), Buffer.from(nonce, "utf-8"));
    decipher.setAuthTag(authTag);
    if (associatedData) {
      decipher.setAAD(Buffer.from(associatedData, "utf-8"));
    }

    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return JSON.parse(decrypted.toString("utf-8")) as Record<string, unknown>;
  }
}
