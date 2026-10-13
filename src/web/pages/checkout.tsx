import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  QrCode,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  WalletCards,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import useSWR from "swr";
import { PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS, type CheckoutData } from "@/shared/contracts";
import { swrFetcher } from "@/web/api";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent } from "@/web/components/ui/card";
import { Loading } from "@/web/components/ui/loading";
import { formatDate } from "@/web/lib/utils";

function countdown(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CheckoutPage() {
  const { token = "" } = useParams();
  const [now, setNow] = useState(Date.now());
  const [isChecking, setIsChecking] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState(2);

  const { data, error, isLoading, mutate } = useSWR<CheckoutData>(
    `/public-api/checkout/${encodeURIComponent(token)}`,
    swrFetcher,
    {
      refreshInterval: (latest) => {
        if (latest && (["paid", "late_paid"].includes(latest.status) || Date.parse(latest.monitor_until) <= Date.now())) return 0;
        const baseInterval = (latest?.payment_poll_interval_seconds ?? PAYMENT_POLL_INTERVAL_DEFAULT_SECONDS) * 1_000;
        // 活跃等待期间加快轮询频率到 1.5 秒，确保客户扫码支付后秒级感知并自动跳转
        return Math.min(baseInterval, 1_500);
      },
      refreshWhenHidden: true,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
      shouldRetryOnError: false,
    },
  );

  const isWxPay = data?.type === "wxpay";
  const qrTarget = data?.qr_payload || data?.payment_uri || "";

  const { data: generatedQr } = useSWR(
    qrTarget && !data?.qr_image_url ? ["qr-render", qrTarget, isWxPay ? "green" : "blue"] : null,
    ([, uri]) =>
      QRCode.toDataURL(uri, {
        width: 320,
        margin: 2,
        errorCorrectionLevel: "M",
        color: {
          dark: isWxPay ? "#07c160" : "#1677ff",
          light: "#ffffff",
        },
      }),
  );

  // 1. 本地时钟推进
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const paid = data?.status === "paid" || data?.status === "late_paid";

  // 2. 屏幕防息屏休眠锁 (Screen Wake Lock API)
  // 当等待付款时，阻止移动端或电脑屏幕自动变暗或熄屏睡眠
  useEffect(() => {
    if (paid || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let wakeLock: any = null;
    const requestLock = async () => {
      try {
        if (document.visibilityState === "visible") {
          wakeLock = await (navigator as any).wakeLock.request("screen");
        }
      } catch {
        // 忽略低电量或无权限错误
      }
    };
    void requestLock();
    const handleVis = () => {
      if (document.visibilityState === "visible") {
        void requestLock();
      }
    };
    document.addEventListener("visibilitychange", handleVis);
    return () => {
      document.removeEventListener("visibilitychange", handleVis);
      if (wakeLock) {
        void wakeLock.release().catch(() => {});
      }
    };
  }, [paid]);

  // 3. Web Worker 后台独立心跳（打破移动端/浏览器切后台后的主线程定时器休眠与节流）
  useEffect(() => {
    if (paid || typeof Worker === "undefined" || typeof Blob === "undefined") return;
    let worker: Worker | null = null;
    let workerUrl = "";
    try {
      const code = "setInterval(function() { postMessage('tick'); }, 1500);";
      const blob = new Blob([code], { type: "application/javascript" });
      workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);
      worker.onmessage = () => {
        void mutate();
      };
    } catch {
      // 若受安全策略限制则由外部机制兜底
    }
    return () => {
      if (worker) {
        worker.terminate();
      }
      if (workerUrl) {
        URL.revokeObjectURL(workerUrl);
      }
    };
  }, [paid, mutate]);

  // 4. 休眠看门狗与全生命周期唤醒补偿（pageshow、visibilitychange、focus、触摸感知）
  useEffect(() => {
    if (paid) return;
    let lastTime = Date.now();
    // 监测系统时钟跳变：若两次心跳相隔超过 2.5 秒，说明系统发生过息屏休眠或切后台挂起
    const watchdog = window.setInterval(() => {
      const currentTime = Date.now();
      if (currentTime - lastTime > 2500) {
        // 从休眠中苏醒，立即无延迟强制刷新订单状态
        void mutate();
      }
      lastTime = currentTime;
    }, 500);

    const handleWakeup = () => {
      lastTime = Date.now();
      void mutate();
    };

    document.addEventListener("visibilitychange", handleWakeup);
    window.addEventListener("pageshow", handleWakeup);
    window.addEventListener("focus", handleWakeup);
    window.addEventListener("online", handleWakeup);
    // 移动端切回浏览器通常第一反应是触碰屏幕，触碰即刷
    window.addEventListener("touchstart", handleWakeup, { passive: true });
    window.addEventListener("pointerdown", handleWakeup, { passive: true });

    return () => {
      window.clearInterval(watchdog);
      document.removeEventListener("visibilitychange", handleWakeup);
      window.removeEventListener("pageshow", handleWakeup);
      window.removeEventListener("focus", handleWakeup);
      window.removeEventListener("online", handleWakeup);
      window.removeEventListener("touchstart", handleWakeup);
      window.removeEventListener("pointerdown", handleWakeup);
    };
  }, [paid, mutate]);

  // 5. 支付成功后自动跳转商户（包含倒计时与即时返回）
  useEffect(() => {
    if (!paid || !data?.return_target) return;
    const interval = setInterval(() => {
      setRedirectCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          if (data.return_target && /^https?:\/\//i.test(data.return_target)) {
            window.location.replace(data.return_target);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [paid, data?.return_target]);

  const handleManualCheck = async () => {
    setIsChecking(true);
    try {
      await mutate();
    } finally {
      setTimeout(() => setIsChecking(false), 500);
    }
  };

  if (isLoading) return <Loading label="正在读取支付订单" />;
  if (error || !data) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm text-center">
          <TriangleAlert className="mx-auto size-9 text-destructive" />
          <h1 className="mt-4 text-xl font-semibold">订单不存在</h1>
          <p className="mt-2 text-sm text-muted">链接可能无效，或订单信息无法读取。</p>
        </div>
      </main>
    );
  }

  const checkoutExpired = now >= Date.parse(data.expires_at);
  const monitoringEnded = now >= Date.parse(data.monitor_until);

  if (paid) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md">
          <CardContent className="px-6 py-10 text-center">
            <CheckCircle2 className="mx-auto size-14 text-emerald-500" />
            <Badge className="mt-5" variant={data.status === "late_paid" ? "primary" : "success"}>
              {data.status === "late_paid" ? "迟到支付已确认" : "支付成功"}
            </Badge>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight">已收到 ¥{data.payable_money}</h1>
            <p className="mt-2 text-sm text-muted">订单 {data.out_trade_no} 已完成，商户通知正在后台投递。</p>
            {data.return_target ? (
              <div className="mt-6 space-y-3">
                <p className="text-sm font-medium text-primary">
                  {redirectCountdown > 0 ? `${redirectCountdown} 秒后自动返回商户页面...` : "正在跳转..."}
                </p>
                <Button className="w-full" asChild>
                  <a href={data.return_target} target="_blank" rel="noopener noreferrer">
                    立即返回商户页面<ExternalLink className="size-4" />
                  </a>
                </Button>
              </div>
            ) : null}
            <p className="mt-5 text-xs text-muted">支付结果以商户服务器验签后的异步通知为准。</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (monitoringEnded) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md">
          <CardContent className="px-6 py-10 text-center">
            <Clock3 className="mx-auto size-12 text-destructive" />
            <h1 className="mt-4 text-xl font-semibold">订单确认窗口已结束</h1>
            <p className="mt-2 text-sm leading-6 text-muted">系统未在监控期内匹配到支付。请不要继续付款，并返回商户重新创建订单。</p>
            <div className="mt-6 rounded-md border p-3 text-left text-xs text-muted">
              商户订单号：<span className="font-mono text-foreground">{data.out_trade_no}</span>
            </div>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen px-4 py-8 sm:py-12 bg-slate-50 dark:bg-slate-950">
      <div className="mx-auto max-w-4xl">
        <header className="mb-6 flex items-center justify-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
          <WalletCards className="size-5 text-primary" />ApusPay 安全收银台
        </header>

        <div className="grid gap-6 md:grid-cols-[1fr_320px]">
          <Card className="border shadow-sm">
            <CardContent className="px-5 py-6 sm:px-7">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-semibold text-white ${
                        isWxPay ? "bg-emerald-600" : "bg-blue-600"
                      }`}
                    >
                      {isWxPay ? "微信支付" : "支付宝"}
                    </span>
                    <span className="text-sm font-medium text-muted">{data.name}</span>
                  </div>
                  <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    ¥{data.payable_money}
                  </h1>
                </div>
                <Badge variant={checkoutExpired ? "danger" : "primary"}>
                  {checkoutExpired ? "已过期，正在等待确认" : `剩余 ${countdown(Date.parse(data.expires_at) - now)}`}
                </Badge>
              </div>

              {data.payable_money !== data.requested_money ? (
                <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-sm leading-6 text-amber-950 dark:text-amber-200">
                  <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div>
                    <p className="font-semibold text-amber-900 dark:text-amber-100">
                      请务必严格支付金额：<span className="text-base font-bold text-destructive">¥{data.payable_money}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">
                      为确保系统能自动识别您的订单并立即发货，请按此金额付款，请勿多付或少付。
                    </p>
                  </div>
                </div>
              ) : null}

              {/* QR Code Container */}
              <div className="mt-6 flex flex-col items-center justify-center rounded-xl border bg-white p-6 shadow-inner dark:bg-slate-900">
                {data.qr_image_url ? (
                  <img
                    src={data.qr_image_url}
                    alt={isWxPay ? "微信收款码" : "支付宝收款码"}
                    className="max-h-[260px] max-w-full rounded-lg object-contain"
                  />
                ) : generatedQr ? (
                  <img
                    src={generatedQr}
                    alt={isWxPay ? "微信支付二维码" : "支付宝支付二维码"}
                    className="size-[260px] max-w-full rounded-lg object-contain"
                  />
                ) : (
                  <div className="flex size-[260px] flex-col items-center justify-center text-muted">
                    <Loading label="正在生成二维码" />
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400">
                  <QrCode className="size-4" />
                  {isWxPay ? "请打开微信「扫一扫」识别付款" : "请打开支付宝「扫一扫」识别付款"}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="mt-5 flex flex-col gap-2.5">
                {!isWxPay && data.payment_uri ? (
                  <Button className="w-full bg-blue-600 hover:bg-blue-700 md:hidden" asChild>
                    <a href={data.payment_uri}>
                      <Smartphone className="size-4" />打开支付宝 App 支付<ExternalLink className="size-4" />
                    </a>
                  </Button>
                ) : null}

                <Button variant="outline" className="w-full text-xs" onClick={handleManualCheck} disabled={isChecking}>
                  <RefreshCw className={`mr-1 size-3.5 ${isChecking ? "animate-spin" : ""}`} />
                  {isChecking ? "正在查询支付状态..." : "我已完成支付，立即刷新查单"}
                </Button>
              </div>

              {/* Hint */}
              <div className="mt-5 flex items-start gap-3 rounded-lg bg-slate-100/70 p-3 text-xs leading-5 text-muted dark:bg-slate-900/50">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <p>
                  {isWxPay
                    ? "请使用微信扫描上方二维码完成支付。支付成功后系统将自动识别并跳转发货，无需手动输入备注。"
                    : data.collection_mode === "alipay_transfer"
                    ? `请使用支付宝扫码转账，转账备注请保持为 ${data.out_trade_no}，切勿修改。`
                    : "请使用支付宝扫码支付，付款成功后系统将在数秒内自动确认并跳转。"}
                </p>
              </div>

              {checkoutExpired ? (
                <div className="mt-4 flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs leading-5 text-muted">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                  收银台有效时间已过。如果您已付款，请耐心等待自动确认（监控至 {formatDate(data.monitor_until)}）。如果尚未付款，请返回商户重新下单。
                </div>
              ) : null}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card className="border shadow-sm">
              <CardContent className="px-5 py-5">
                <h2 className="text-sm font-semibold">订单信息</h2>
                <dl className="mt-4 space-y-4">
                  <div>
                    <dt className="text-xs text-muted">商户订单号</dt>
                    <dd className="mt-1 break-all font-mono text-xs font-medium">{data.out_trade_no}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">平台交易号</dt>
                    <dd className="mt-1 break-all font-mono text-xs font-medium">{data.trade_no}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">支付通道</dt>
                    <dd className="mt-1 text-xs font-medium">{isWxPay ? "微信支付" : "支付宝"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">下单时间</dt>
                    <dd className="mt-1 text-xs">{formatDate(data.created_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">确认剩余窗口</dt>
                    <dd className="mt-1 font-mono text-xs font-semibold text-primary">
                      {countdown(Date.parse(data.monitor_until) - now)}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <Card className="border shadow-sm">
              <CardContent className="px-5 py-5 text-xs leading-5 text-muted">
                <p>如支付后页面未及时响应，请点击「立即刷新查单」按钮进行主动同步。</p>
                <p className="mt-2 text-slate-500 dark:text-slate-400">请勿重复付款。如遇问题，请保留支付账单并联系商户客服。</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
