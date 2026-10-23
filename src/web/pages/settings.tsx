import {
  CheckCircle2,
  KeyRound,
  QrCode,
  Radio,
  Save,
  Send,
  ShieldAlert,
  TestTube,
  Upload,
  Zap,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  PAYMENT_POLL_INTERVAL_MAX_SECONDS,
  PAYMENT_POLL_INTERVAL_MIN_SECONDS,
  type AlipayMode,
  type PublicSettings,
  type TransferLinkLayer,
  type WxpayMode,
} from "@/shared/contracts";
import { apiFetch, jsonBody, swrFetcher } from "@/web/api";
import { CopyButton } from "@/web/components/copy-button";
import { PageHeader } from "@/web/components/page-header";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Loading } from "@/web/components/ui/loading";
import { Switch } from "@/web/components/ui/switch";
import { Textarea } from "@/web/components/ui/textarea";
import { cn } from "@/web/lib/utils";

interface SettingsData extends PublicSettings {
  transfer_user_id: string;
  alipay_public_key: string;
  has_alipay_private_key: boolean;
  has_v1_key: boolean;
  has_v2_platform_private_key: boolean;
  has_wxpay_private_key: boolean;
  has_wxpay_api_v3_key: boolean;
  has_wxpay_hook_token: boolean;
  wxpay_hook_token?: string;
}

function SettingsForm({ initial, refresh }: { initial: SettingsData; refresh: () => Promise<unknown> }) {
  const [activeTab, setActiveTab] = useState<"alipay" | "wxpay" | "gateway">("alipay");

  // Gateway
  const [baseUrl, setBaseUrl] = useState(initial.public_base_url);
  const [paymentPollInterval, setPaymentPollInterval] = useState(String(initial.payment_poll_interval_seconds));
  const [v1Enabled, setV1Enabled] = useState(initial.v1_enabled);
  const [v2Enabled, setV2Enabled] = useState(initial.v2_enabled);

  // Alipay
  const [alipayEnabled, setAlipayEnabled] = useState(initial.alipay_enabled ?? true);
  const [alipayMode, setAlipayMode] = useState<AlipayMode>(initial.alipay_mode ?? "f2f");
  const [alipayAppId, setAlipayAppId] = useState(initial.alipay_app_id);
  const [alipayEndpoint, setAlipayEndpoint] = useState(initial.alipay_endpoint);
  const [alipayPublicKey, setAlipayPublicKey] = useState(initial.alipay_public_key);
  const [transferUserId, setTransferUserId] = useState(initial.transfer_user_id);
  const [transferLinkLayer, setTransferLinkLayer] = useState<TransferLinkLayer>(initial.transfer_link_layer);
  const [businessQrRaw, setBusinessQrRaw] = useState(initial.business_qr_raw ?? "");

  // WeChat
  const [wxpayEnabled, setWxpayEnabled] = useState(initial.wxpay_enabled ?? true);
  const [wxpayMode, setWxpayMode] = useState<WxpayMode>(initial.wxpay_mode ?? "native");
  const [wxpayAppId, setWxpayAppId] = useState(initial.wxpay_app_id ?? "");
  const [wxpayMchId, setWxpayMchId] = useState(initial.wxpay_mch_id ?? "");
  const [wxpaySerialNo, setWxpaySerialNo] = useState(initial.wxpay_serial_no ?? "");
  const [wxpayPublicKey, setWxpayPublicKey] = useState(initial.wxpay_public_key ?? "");
  const [wxpayPrivateKey, setWxpayPrivateKey] = useState("");
  const [wxpayApiV3Key, setWxpayApiV3Key] = useState("");
  const [wxpayHookToken, setWxpayHookToken] = useState(initial.wxpay_hook_token ?? "");

  useEffect(() => {
    if (initial.wxpay_hook_token !== undefined) {
      setWxpayHookToken(initial.wxpay_hook_token);
    }
  }, [initial.wxpay_hook_token]);

  const [saving, setSaving] = useState(false);
  const [testingAlipay, setTestingAlipay] = useState(false);
  const [testingWechat, setTestingWechat] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/admin-api/settings", {
        method: "PUT",
        ...jsonBody({
          public_base_url: baseUrl,
          payment_poll_interval_seconds: Number(paymentPollInterval),
          v1_enabled: v1Enabled,
          v2_enabled: v2Enabled,

          alipay_enabled: alipayEnabled,
          alipay_mode: alipayMode,
          alipay_app_id: alipayAppId,
          alipay_endpoint: alipayEndpoint,
          alipay_public_key: alipayPublicKey,
          transfer_user_id: transferUserId,
          transfer_link_layer: transferLinkLayer,
          business_qr_raw: businessQrRaw,

          wxpay_enabled: wxpayEnabled,
          wxpay_mode: wxpayMode,
          wxpay_app_id: wxpayAppId,
          wxpay_mch_id: wxpayMchId,
          wxpay_serial_no: wxpaySerialNo,
          wxpay_public_key: wxpayPublicKey,
          wxpay_hook_token: wxpayHookToken,
        }),
      });

      // Save WeChat secrets if entered
      if (wxpayPrivateKey || wxpayApiV3Key) {
        await apiFetch("/admin-api/keys/wxpay/secrets", {
          method: "PUT",
          ...jsonBody({
            private_key: wxpayPrivateKey || undefined,
            api_v3_key: wxpayApiV3Key || undefined,
          }),
        });
        setWxpayPrivateKey("");
      }

      toast.success("配置已成功保存");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存配置失败");
    } finally {
      setSaving(false);
    }
  }

  async function testAlipay() {
    setTestingAlipay(true);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>("/admin-api/channels/test/alipay", { method: "POST" });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "支付宝测试失败");
    } finally {
      setTestingAlipay(false);
    }
  }

  async function testWechat() {
    setTestingWechat(true);
    try {
      const res = await apiFetch<{ ok: boolean; message: string }>("/admin-api/channels/test/wechat", {
        method: "POST",
        ...jsonBody({ mode: wxpayMode }),
      });
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "微信支付测试失败");
    } finally {
      setTestingWechat(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-6">
      {/* Tab Navigation */}
      <div className="flex border-b text-sm font-medium">
        <button
          type="button"
          onClick={() => setActiveTab("alipay")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-5 py-3 transition-colors",
            activeTab === "alipay"
              ? "border-blue-600 text-blue-600 dark:border-blue-400 dark:text-blue-400"
              : "border-transparent text-muted hover:text-foreground",
          )}
        >
          <div className="size-2 rounded-full bg-blue-600" />
          支付宝配置
          {initial.alipay_configured ? (
            <Badge variant="success" className="text-[10px]">已配置</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">未配置</Badge>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("wxpay")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-5 py-3 transition-colors",
            activeTab === "wxpay"
              ? "border-emerald-600 text-emerald-600 dark:border-emerald-400 dark:text-emerald-400"
              : "border-transparent text-muted hover:text-foreground",
          )}
        >
          <div className="size-2 rounded-full bg-emerald-600" />
          微信支付配置
          {initial.wxpay_configured ? (
            <Badge variant="success" className="text-[10px]">已配置</Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">未配置</Badge>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("gateway")}
          className={cn(
            "flex items-center gap-2 border-b-2 px-5 py-3 transition-colors",
            activeTab === "gateway"
              ? "border-primary text-primary"
              : "border-transparent text-muted hover:text-foreground",
          )}
        >
          网关与易支付协议
        </button>
      </div>

      {/* ALIPAY TAB */}
      {activeTab === "alipay" ? (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>支付宝收款模式</CardTitle>
                <CardDescription>推荐当面付（官方接口无并发金额冲突）；也可使用经营码账单流水匹配。</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="alipay-enable-toggle" className="text-xs text-muted">启用支付宝渠道</Label>
                <Switch
                  id="alipay-enable-toggle"
                  checked={alipayEnabled}
                  onCheckedChange={setAlipayEnabled}
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-3">
                <button
                  type="button"
                  onClick={() => setAlipayMode("f2f")}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    alipayMode === "f2f" ? "border-blue-600 bg-blue-50/50 dark:bg-blue-950/20" : "hover:bg-foreground/[0.025]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-semibold text-sm">
                      <Zap className="size-4 text-blue-600" />官方当面付
                    </span>
                    <Badge variant={alipayMode === "f2f" ? "primary" : "outline"}>
                      {alipayMode === "f2f" ? "当前选用" : "首选"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    官方 alipay.trade.precreate 接口生成动态二维码，自动主动查单，无需加价。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setAlipayMode("bill")}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    alipayMode === "bill" ? "border-blue-600 bg-blue-50/50 dark:bg-blue-950/20" : "hover:bg-foreground/[0.025]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-semibold text-sm">
                      <QrCode className="size-4 text-blue-600" />经营码账单
                    </span>
                    <Badge variant={alipayMode === "bill" ? "primary" : "outline"}>
                      {alipayMode === "bill" ? "当前选用" : "备选"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    展示静态经营码，轮询 V3 账务流水，同一时刻分配 +0.01~0.99 浮动金额识别。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setAlipayMode("transfer")}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    alipayMode === "transfer" ? "border-blue-600 bg-blue-50/50 dark:bg-blue-950/20" : "hover:bg-foreground/[0.025]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-semibold text-sm">
                      <Send className="size-4 text-blue-600" />转账备注模式
                    </span>
                    <Badge variant={alipayMode === "transfer" ? "primary" : "outline"}>
                      {alipayMode === "transfer" ? "当前选用" : "兼容"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    生成转账 URI，将商户订单号写入转账 memo，依靠转账流水备注精确对账。
                  </p>
                </button>
              </div>

              {/* Alipay Credentials */}
              <div className="mt-6 space-y-4 border-t pt-5">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">支付宝开放平台凭据 (RSA2)</h3>
                  <Button type="button" variant="outline" size="sm" onClick={testAlipay} disabled={testingAlipay}>
                    <TestTube className="size-3.5 mr-1" />
                    {testingAlipay ? "正在测试..." : "测试连接"}
                  </Button>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="alipay-app-id">支付宝应用 ID (AppID)</Label>
                    <Input
                      id="alipay-app-id"
                      value={alipayAppId}
                      onChange={(e) => setAlipayAppId(e.target.value)}
                      placeholder="例如 2021000000000000"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="alipay-endpoint">支付宝网关地址</Label>
                    <Input
                      id="alipay-endpoint"
                      value={alipayEndpoint}
                      onChange={(e) => setAlipayEndpoint(e.target.value)}
                      placeholder="https://openapi.alipay.com"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="alipay-public-key">支付宝公钥 (SPKI 单行或标准 PEM)</Label>
                  <Textarea
                    id="alipay-public-key"
                    rows={3}
                    className="font-mono text-xs"
                    value={alipayPublicKey}
                    onChange={(e) => setAlipayPublicKey(e.target.value)}
                    placeholder="MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA..."
                  />
                  <p className="text-xs text-muted">请注意：这是支付宝开放平台分配的「支付宝公钥」，而非您生成的「应用公钥」。</p>
                </div>

                <div className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-muted dark:bg-slate-900">
                  <span>应用私钥状态：</span>
                  {initial.has_alipay_private_key ? (
                    <span className="font-medium text-emerald-600">已就绪（保存在内部受密密钥中心）</span>
                  ) : (
                    <span className="font-medium text-destructive">未设置（请在密钥中心生成或导入应用私钥）</span>
                  )}
                </div>

                {alipayMode === "bill" ? (
                  <div className="space-y-3 rounded-lg border p-4">
                    <Label htmlFor="qr-file">上传经营码图片</Label>
                    {initial.business_qr_url ? (
                      <div className="flex items-center gap-3 rounded-md border p-3">
                        <img src={initial.business_qr_url} alt="支付宝经营码" className="size-16 object-contain" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                            <CheckCircle2 className="size-4" />已上传经营码
                          </div>
                          <p className="mt-1 truncate font-mono text-[11px] text-muted">{initial.business_qr_url}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded border border-dashed p-4 text-center text-xs text-muted">尚未上传经营码图片</div>
                    )}
                    <Input
                      id="qr-file"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        const form = new FormData();
                        form.set("file", file);
                        try {
                          const res = await apiFetch<{ url: string }>("/admin-api/settings/qr", { method: "POST", body: form });
                          toast.success("经营码已上传");
                          await refresh();
                        } catch (err: unknown) {
                          toast.error(err instanceof Error ? err.message : "上传失败");
                        }
                      }}
                    />
                  </div>
                ) : null}

                {alipayMode === "transfer" ? (
                  <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="transfer-user-id">收款方支付宝用户 ID</Label>
                      <Input
                        id="transfer-user-id"
                        value={transferUserId}
                        onChange={(e) => setTransferUserId(e.target.value)}
                        placeholder="2088 开头的 16 位数字"
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* WECHAT TAB */}
      {activeTab === "wxpay" ? (
        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardTitle>微信支付收款配置</CardTitle>
                <CardDescription>支持微信商户平台官方 Native 扫码 (APIv3) 或 PC 微信个人挂机 Hook。</CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="wxpay-enable-toggle" className="text-xs text-muted">启用微信支付渠道</Label>
                <Switch
                  id="wxpay-enable-toggle"
                  checked={wxpayEnabled}
                  onCheckedChange={setWxpayEnabled}
                />
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setWxpayMode("native")}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    wxpayMode === "native" ? "border-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/20" : "hover:bg-foreground/[0.025]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-semibold text-sm">
                      <Zap className="size-4 text-emerald-600" />官方 Native APIv3
                    </span>
                    <Badge variant={wxpayMode === "native" ? "success" : "outline"}>
                      {wxpayMode === "native" ? "当前选用" : "首选"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    商户平台直连，使用官方 transactions/native 接口获取 code_url，支持主动查单与回调解密。
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setWxpayMode("hook")}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    wxpayMode === "hook" ? "border-emerald-600 bg-emerald-50/50 dark:bg-emerald-950/20" : "hover:bg-foreground/[0.025]",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-2 font-semibold text-sm">
                      <Radio className="size-4 text-emerald-600" />PC 微信 Hook 模式
                    </span>
                    <Badge variant={wxpayMode === "hook" ? "success" : "outline"}>
                      {wxpayMode === "hook" ? "当前选用" : "免签约"}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-muted">
                    展示个人/静态赞赏码，通过 wechat-hook 客户端抓取 Windows 微信收款通知后自动到账。
                  </p>
                </button>
              </div>

              {wxpayMode === "native" ? (
                <div className="mt-6 space-y-4 border-t pt-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">微信商户平台 APIv3 凭据</h3>
                    <Button type="button" variant="outline" size="sm" onClick={testWechat} disabled={testingWechat}>
                      <TestTube className="size-3.5 mr-1" />
                      {testingWechat ? "正在验证..." : "测试凭据"}
                    </Button>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label htmlFor="wx-app-id">绑定 AppID</Label>
                      <Input
                        id="wx-app-id"
                        value={wxpayAppId}
                        onChange={(e) => setWxpayAppId(e.target.value)}
                        placeholder="wx8888888888888888"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="wx-mch-id">微信商户号 (MchID)</Label>
                      <Input
                        id="wx-mch-id"
                        value={wxpayMchId}
                        onChange={(e) => setWxpayMchId(e.target.value)}
                        placeholder="1900000109"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="wx-serial-no">商户证书序列号</Label>
                      <Input
                        id="wx-serial-no"
                        value={wxpaySerialNo}
                        onChange={(e) => setWxpaySerialNo(e.target.value)}
                        placeholder="1DDE55..."
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="wx-private-key">商户 API 私钥 (apiclient_key.pem)</Label>
                      {initial.has_wxpay_private_key ? (
                        <span className="text-xs text-emerald-600 font-medium">● 私钥已配置（留空保持不变）</span>
                      ) : (
                        <span className="text-xs text-amber-600 font-medium">尚未配置私钥</span>
                      )}
                    </div>
                    <Textarea
                      id="wx-private-key"
                      rows={3}
                      className="font-mono text-xs"
                      value={wxpayPrivateKey}
                      onChange={(e) => setWxpayPrivateKey(e.target.value)}
                      placeholder="-----BEGIN PRIVATE KEY----- ... -----END PRIVATE KEY-----"
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="wx-v3-key">APIv3 密钥 (32 位字符)</Label>
                      {initial.has_wxpay_api_v3_key ? (
                        <span className="text-xs text-emerald-600 font-medium">● APIv3 密钥已配置（留空保持不变）</span>
                      ) : null}
                    </div>
                    <Input
                      id="wx-v3-key"
                      type="password"
                      value={wxpayApiV3Key}
                      onChange={(e) => setWxpayApiV3Key(e.target.value)}
                      placeholder="用于解密微信回调通知的 32 字符密钥"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="wx-public-key">微信支付平台公钥 / 证书 (PEM，推荐配置以验签回调请求头)</Label>
                    <Textarea
                      id="wx-public-key"
                      rows={3}
                      className="font-mono text-xs"
                      value={wxpayPublicKey}
                      onChange={(e) => setWxpayPublicKey(e.target.value)}
                      placeholder="-----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----"
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-6 space-y-4 border-t pt-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">PC 微信 Hook 配置</h3>
                    <Button type="button" variant="outline" size="sm" onClick={testWechat} disabled={testingWechat}>
                      <TestTube className="size-3.5 mr-1" />
                      {testingWechat ? "正在验证..." : "测试配置状态"}
                    </Button>
                  </div>

                  {!initial.wxpay_static_qr_url ? (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-300">
                      ⚠️ <strong>必须上传收款码</strong>：PC Hook 模式需要向买家展示付款二维码，请在下方上传个人收款码或赞赏码。未上传前微信支付渠道将一直判定为「未配置」。
                    </div>
                  ) : null}

                  {wxpayMode !== initial.wxpay_mode ? (
                    <div className="rounded-md border border-blue-500/30 bg-blue-500/10 p-3 text-xs leading-5 text-blue-800 dark:text-blue-300">
                      ℹ️ 您已切换收款模式，完成配置后请记得点击页面最底部的<strong>「保存全部配置」</strong>按钮使更改生效。
                    </div>
                  ) : null}

                  <div className="space-y-3 rounded-lg border p-4">
                    <Label htmlFor="wx-qr-file">上传微信个人/静态收款码</Label>
                    {initial.wxpay_static_qr_url ? (
                      <div className="flex items-center gap-3 rounded-md border p-3">
                        <img src={initial.wxpay_static_qr_url} alt="微信收款码" className="size-16 object-contain" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600">
                            <CheckCircle2 className="size-4" />已上传收款码
                          </div>
                          <p className="mt-1 truncate font-mono text-[11px] text-muted">{initial.wxpay_static_qr_url}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded border border-dashed p-4 text-center text-xs text-muted">尚未上传静态收款码</div>
                    )}
                    <Input
                      id="wx-qr-file"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={async (event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        const form = new FormData();
                        form.set("file", file);
                        try {
                          const res = await apiFetch<{ url: string }>("/admin-api/settings/qr/wechat", { method: "POST", body: form });
                          toast.success("微信收款码已上传");
                          await refresh();
                        } catch (err: unknown) {
                          toast.error(err instanceof Error ? err.message : "上传失败");
                        }
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="wx-hook-token">Hook 鉴权 Token (必填，至少 8 位)</Label>
                      {initial.has_wxpay_hook_token ? (
                        <span className="text-xs text-emerald-600 font-medium">● Token 已受保护</span>
                      ) : (
                        <span className="text-xs text-destructive">未配置（保存时将自动生成）</span>
                      )}
                    </div>
                    <Input
                      id="wx-hook-token"
                      value={wxpayHookToken}
                      onChange={(e) => setWxpayHookToken(e.target.value)}
                      placeholder="PC Hook 客户端请求必须通过 X-Hook-Token 请求头携带此密钥"
                    />
                  </div>

                  <div className="rounded-lg bg-slate-50 p-3 text-xs leading-5 text-muted dark:bg-slate-900">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-slate-800 dark:text-slate-200">Hook 接收接口地址 (填入 PC 客户端)：</p>
                      <CopyButton
                        value={`${(initial.public_base_url || "http://your-domain.com").replace(/\/$/, "")}/api/hook/receive`}
                        label="复制接口地址"
                      />
                    </div>
                    <code className="mt-1 block font-mono text-primary break-all">
                      {(initial.public_base_url || "http://your-domain.com").replace(/\/$/, "")}/api/hook/receive
                    </code>
                    <p className="mt-2">
                      请将上方接口地址与 <code>hook_token</code> 填入 PC 微信 Hook 客户端的 <code>config.properties</code> 中，客户端将通过 <code>X-Hook-Token</code> 请求头安全鉴权（避免 URL 泄露密钥）。
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* GATEWAY & EASYPAY TAB */}
      {activeTab === "gateway" ? (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>公开服务地址与轮询</CardTitle>
              <CardDescription>用于收银台二维码跳转与商户回调构造。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="public-base-url">对外公开根地址 (PUBLIC_BASE_URL)</Label>
                <Input
                  id="public-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://pay.example.com"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="poll-interval">支付轮询间隔 (秒)</Label>
                <Input
                  id="poll-interval"
                  type="number"
                  min={PAYMENT_POLL_INTERVAL_MIN_SECONDS}
                  max={PAYMENT_POLL_INTERVAL_MAX_SECONDS}
                  value={paymentPollInterval}
                  onChange={(e) => setPaymentPollInterval(e.target.value)}
                />
                <p className="text-xs text-muted">有效范围 1–60 秒，默认 5 秒。影响前端查单和后台合并扫账。</p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>易支付 API 协议开关</CardTitle>
              <CardDescription>可分别开启或关闭传统 V1 (MD5) 与 V2 (RSA) 接口。</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-sm">易支付 V1 (MD5 签名)</div>
                  <p className="text-xs text-muted">支持 submit.php / mapi.php / api.php</p>
                </div>
                <Switch checked={v1Enabled} onCheckedChange={setV1Enabled} />
              </div>
              <div className="flex items-center justify-between border-t pt-3">
                <div>
                  <div className="font-semibold text-sm">易支付 V2 (RSA 非对称签名)</div>
                  <p className="text-xs text-muted">支持 /api/pay/create 与平台私钥签名</p>
                </div>
                <Switch checked={v2Enabled} onCheckedChange={setV2Enabled} />
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="flex justify-end gap-3 pt-4">
        <Button type="submit" disabled={saving}>
          <Save className="size-4" />
          {saving ? "正在保存配置..." : "保存全部配置"}
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const { data, isLoading, mutate } = useSWR<SettingsData>("/admin-api/settings", swrFetcher);
  if (isLoading || !data) return <Loading label="正在加载配置" />;

  return (
    <>
      <PageHeader
        title="收款与网关配置"
        description="管理支付宝、微信支付通道参数与对外易支付协议设置。"
      />
      <SettingsForm initial={data} refresh={async () => mutate()} />
    </>
  );
}
