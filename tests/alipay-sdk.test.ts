import { createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { AlipaySdk } from "alipay-sdk";
import { OfficialAlipayProvider, prepareAlipaySdkPem } from "../src/server/alipay";
import { setSetting } from "../src/server/db";
import { generateRsaKeyPair } from "../src/server/security";
import { configuredDatabase } from "./helpers";

describe("Alipay SDK key compatibility", () => {
  it("removes trailing PEM whitespace before the SDK formats generated keys", () => {
    const pair = generateRsaKeyPair();
    expect(pair.privateKey.endsWith("\n")).toBe(true);

    const sdk = new AlipaySdk({
      appId: "2026000000000000",
      privateKey: prepareAlipaySdkPem(pair.privateKey),
      alipayPublicKey: prepareAlipaySdkPem(pair.publicKey),
      keyType: "PKCS8",
      signType: "RSA2",
    });

    expect(() => createPrivateKey(sdk.config.privateKey)).not.toThrow();
    expect(() => createPublicKey(sdk.config.alipayPublicKey!)).not.toThrow();
    expect(() => createSign("RSA-SHA256").update("probe").sign(sdk.config.privateKey)).not.toThrow();
  });

  it("syncs custom endpoint to sdk.config.gateway and enforces RSA2 response signature verification", async () => {
    const { database } = configuredDatabase("alipay_f2f");
    const wrongServerKey = generateRsaKeyPair();
    setSetting(database, "alipay_endpoint", "https://openapi-sandbox.dl.alipaydev.com/");
    const provider = new OfficialAlipayProvider(database);
    const sdk = provider.getSdk();
    expect(sdk.config.gateway).toBe("https://openapi-sandbox.dl.alipaydev.com/gateway.do");

    const forgedPayload = JSON.stringify({
      alipay_trade_query_response: {
        code: "10000",
        msg: "Success",
        trade_status: "TRADE_SUCCESS",
        trade_no: "20260001",
        total_amount: "1.00",
      },
      sign: createSign("RSA-SHA256").update('{"code":"10000"}').sign(wrongServerKey.privateKey, "base64"),
    });
    const mockGateway = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(forgedPayload, {
          status: 200,
          headers: { "content-type": "application/json", trace_id: "forged-trace" },
        });
      },
    });
    try {
      sdk.config.gateway = `http://127.0.0.1:${mockGateway.port}/gateway.do`;
      await expect(provider.queryTrade("ORDER-FORGED")).rejects.toThrow(/验签|sign/i);
    } finally {
      await mockGateway.stop(true);
      database.close();
    }
  });
});
