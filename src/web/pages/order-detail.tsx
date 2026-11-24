import { ArrowLeft, CheckCircle, RefreshCw, Send } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import useSWR from "swr";
import { toast } from "sonner";
import type { OrderRecord } from "@/shared/contracts";
import { apiFetch, swrFetcher } from "@/web/api";
import { CopyButton } from "@/web/components/copy-button";
import { PageHeader } from "@/web/components/page-header";
import { StatusBadge } from "@/web/components/status-badge";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/web/components/ui/card";
import { Loading } from "@/web/components/ui/loading";
import { formatDate, formatMoney } from "@/web/lib/utils";

interface DetailResponse {
  order: OrderRecord;
  payment_events: Array<Record<string, unknown>>;
  notifications: Array<Record<string, unknown> & { attempts_detail?: Array<Record<string, unknown>> }>;
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 break-all text-sm ${mono ? "font-mono text-xs" : ""}`}>{value || "—"}</dd>
    </div>
  );
}

export function OrderDetailPage() {
  const { id = "" } = useParams();
  const { data, isLoading, mutate } = useSWR<DetailResponse>(`/admin-api/orders/${id}`, swrFetcher, { refreshInterval: 5_000 });
  if (isLoading || !data) return <Loading label="正在读取订单" />;
  const order = data.order;
  const paid = order.status === "paid" || order.status === "late_paid";

  function getModeLabel(mode: string) {
    if (mode === "alipay_f2f") return "支付宝当面付";
    if (mode === "alipay_bill" || mode === "business_qr") return "支付宝经营码";
    if (mode === "alipay_transfer" || mode === "transfer") return "支付宝转账模式";
    if (mode === "wxpay_native") return "微信 Native 官方扫码";
    if (mode === "wxpay_hook") return "微信 PC Hook 收款";
    return mode;
  }

  return (
    <>
      <div className="mb-4">
        <Button asChild variant="ghost" size="sm">
          <Link to="/orders">
            <ArrowLeft />返回订单列表
          </Link>
        </Button>
      </div>
      <PageHeader
        title={order.name}
        description={`商户订单号 ${order.out_trade_no}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {!paid ? (
              <Button
                variant="outline"
                onClick={async () => {
                  if (!confirm("确定要手动将该订单标记为已支付吗？这会自动触发商户通知。")) return;
                  await apiFetch(`/admin-api/orders/${id}/mark-paid`, { method: "POST" });
                  toast.success("已手动标记为支付成功");
                  await mutate();
                }}
              >
                <CheckCircle className="size-4" />标记支付
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={async () => {
                const res = await apiFetch<{ matched: boolean }>(`/admin-api/orders/${id}/sync`, { method: "POST" });
                toast.success(res.matched ? "查单命中，订单已入账" : "查单已完成，暂未检测到新入账");
                await mutate();
              }}
            >
              <RefreshCw className="size-4" />立即查单
            </Button>
            <Button
              disabled={!paid}
              onClick={async () => {
                await apiFetch(`/admin-api/orders/${id}/resend`, { method: "POST" });
                toast.success("已加入一次性补发队列");
                await mutate();
              }}
            >
              <Send className="size-4" />补发通知
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-5">
            <div className="text-sm text-muted">商户金额</div>
            <div className="mt-2 text-2xl font-semibold">{formatMoney(order.requested_amount_cents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-sm text-muted">要求实付</div>
            <div className="mt-2 text-2xl font-semibold text-primary">{formatMoney(order.payable_amount_cents)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="text-sm text-muted">订单状态</div>
            <div className="mt-3">
              <StatusBadge status={order.status} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>订单信息</CardTitle>
            <CardDescription>订单过期后仍保留，自动监控在第 7 分钟结束。</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Field label="平台交易号" value={order.trade_no} mono />
              <Field label="商户订单号" value={order.out_trade_no} mono />
              <Field label="支付渠道" value={order.type === "wxpay" ? "微信支付" : "支付宝"} />
              <Field label="收款模式" value={getModeLabel(order.collection_mode)} />
              <Field label="协议版本" value={order.api_version.toUpperCase()} />
              <Field label="创建时间" value={formatDate(order.created_at)} />
              <Field label="收银台过期" value={formatDate(order.expires_at)} />
              <Field label="监控截止" value={formatDate(order.monitor_until)} />
              <Field label="支付时间" value={formatDate(order.paid_at)} />
              <Field
                label="渠道流水号"
                value={order.channel_order_id ?? order.alipay_order_no ?? order.wxpay_transaction_id ?? ""}
                mono
              />
              <Field label="付款人" value={order.buyer} />
              <Field label="客户端 IP" value={order.client_ip} mono />
              <Field label="异步回调地址" value={order.notify_url} mono />
              <Field label="同步返回地址" value={order.return_url ?? ""} mono />
            </dl>
            <div className="mt-5 flex gap-2">
              <CopyButton value={order.trade_no} label="复制平台单号" />
              <CopyButton value={order.out_trade_no} label="复制商户单号" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>支付匹配</CardTitle>
            <CardDescription>各渠道流水全局去重，支出记录不会参与匹配。</CardDescription>
          </CardHeader>
          <CardContent>
            {data.payment_events.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted">尚未匹配到账务流水</div>
            ) : (
              data.payment_events.map((event) => (
                <div key={String(event.id)} className="rounded-md border p-4">
                  <div className="flex items-center justify-between">
                    <Badge variant="success">{String(event.direction || "收入")}</Badge>
                    <span className="font-mono text-sm">{formatMoney(Number(event.amount_cents))}</span>
                  </div>
                  <dl className="mt-4 grid gap-4 sm:grid-cols-2">
                    <Field label="账务流水号" value={String(event.account_log_id ?? "")} mono />
                    <Field label="发生时间" value={formatDate(String(event.occurred_at ?? ""))} />
                    <Field label="转账备注" value={String(event.trans_memo ?? "")} />
                    <Field label="对方账号" value={String(event.other_account ?? "")} />
                  </dl>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>通知投递</CardTitle>
          <CardDescription>首次立即发送，失败后每 60 秒一次，自动任务最多 10 次；手动补发只执行一次。</CardDescription>
        </CardHeader>
        <CardContent>
          {data.notifications.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted">支付成功后会在这里显示通知任务</div>
          ) : (
            <div className="space-y-4">
              {data.notifications.map((job) => (
                <div key={String(job.id)} className="rounded-md border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant={job.status === "succeeded" ? "success" : job.status === "failed" ? "danger" : "outline"}>
                        {String(job.status)}
                      </Badge>
                      {Number(job.manual) ? <Badge variant="primary">手动补发</Badge> : null}
                    </div>
                    <span className="text-xs text-muted">
                      {String(job.attempts)} / {String(job.max_attempts)} 次
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {job.attempts_detail?.map((attempt) => (
                      <div
                        key={String(attempt.id)}
                        className="grid gap-1 border-t pt-2 text-xs sm:grid-cols-[80px_1fr_auto]"
                      >
                        <span>第 {String(attempt.attempt_number)} 次</span>
                        <span className={attempt.error ? "text-destructive" : "text-muted"}>
                          {String(attempt.error ?? attempt.response_body ?? "等待结果")}
                        </span>
                        <span className="text-muted">
                          {formatDate(String(attempt.completed_at ?? attempt.requested_at ?? ""))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
