import crypto from "node:crypto";
import { getSecret } from "./config";
import { getSetting, type AppDatabase } from "./db";
import { AppError } from "./errors";
import { normalizePem } from "./security";

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

  public getCredentials() {
    const appId = getSetting(this.database, "wxpay_app_id", "");
    const mchId = getSetting(this.database, "wxpay_mch_id", "");
    const serialNo = getSetting(this.database, "wxpay_serial_no", "");
    const privateKey = getSecret(this.database, "wxpay_private_key");
    const apiV3Key = getSecret(this.database, "wxpay_api_v3_key");
    if (!appId || !mchId || !serialNo || !privateKey) {
      throw new AppError(503, "WXPAY_NOT_CONFIGURED", "微信支付 AppID、商户号、证书序列号或商户私钥尚未配置完整");
    }
    return { appId, mchId, serialNo, privateKey, apiV3Key };
  }

  private buildAuthorization(method: string, urlPath: string, body = ""): string {
    const { mchId, serialNo, privateKey } = this.getCredentials();
    const nonce = crypto.randomBytes(16).toString("hex");
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;

    const sign = crypto.createSign("RSA-SHA256");
    sign.update(message);
    const signature = sign.sign(privateKey, "base64");

    return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
  }

  async nativePrepay(input: {
    outTradeNo: string;
    totalCents: number;
    description: string;
    notifyUrl?: string;
  }): Promise<WeChatPrepayResult> {
    const { appId, mchId } = this.getCredentials();
    const path = "/v3/pay/transactions/native";
    const publicUrl = getSetting(this.database, "public_base_url", "http://localhost");
    const bodyObj = {
      appid: appId,
      mchid: mchId,
      description: input.description.slice(0, 120),
      out_trade_no: input.outTradeNo,
      notify_url: input.notifyUrl || `${publicUrl.replace(/\/$/, "")}/api/pay/wechat/notify`,
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
    });

    const resJson = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) {
      if (res.status === 404 || resJson.code === "ORDER_NOT_EXIST") {
        return { tradeState: "NOTPAY" };
      }
      throw new AppError(502, "WXPAY_QUERY_FAILED", String(resJson.message ?? "微信订单查询失败"));
    }

    const rawTotal = (resJson.amount as Record<string, unknown> | undefined)?.total;
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
    const timestamp = headers.get("wechatpay-timestamp")?.trim() ?? "";
    const nonce = headers.get("wechatpay-nonce")?.trim() ?? "";
    const signature = headers.get("wechatpay-signature")?.trim() ?? "";
    const platformPublicKey = getSetting(this.database, "wxpay_public_key", "").trim();

    if (timestamp) {
      if (!/^\d{10}$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
        throw new AppError(401, "WXPAY_TIMESTAMP_EXPIRED", "微信回调时间戳无效或已过期");
      }
    }

    if (platformPublicKey) {
      if (!timestamp || !nonce || !signature) {
        throw new AppError(401, "WXPAY_SIGNATURE_MISSING", "缺少微信支付回调签名头");
      }
      const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
      const pem = platformPublicKey.includes("-----BEGIN CERTIFICATE-----")
        ? platformPublicKey
        : normalizePem(platformPublicKey, "public");
      const verifier = crypto.createVerify("RSA-SHA256");
      verifier.update(message, "utf8");
      verifier.end();
      const valid = verifier.verify(crypto.createPublicKey(pem), signature, "base64");
      if (!valid) {
        throw new AppError(401, "WXPAY_INVALID_SIGNATURE", "微信支付平台签名校验失败");
      }
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
    }).catch(() => undefined);
  }

  decryptNotification(ciphertext: string, nonce: string, associatedData: string): Record<string, unknown> {
    const { apiV3Key } = this.getCredentials();
    if (!apiV3Key || apiV3Key.length !== 32) {
      throw new AppError(500, "WXPAY_KEY_INVALID", "微信 APIv3 Key 长度必须为 32 位");
    }

    const cipherBuffer = Buffer.from(ciphertext, "base64");
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
