import { Suspense, lazy, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import useSWR from "swr";
import { ApiClientError, swrFetcher } from "@/web/api";
import { Loading } from "@/web/components/ui/loading";

const AppShell = lazy(() => import("@/web/components/app-shell").then((m) => ({ default: m.AppShell })));
const CheckoutPage = lazy(() => import("@/web/pages/checkout").then((m) => ({ default: m.CheckoutPage })));
const DashboardPage = lazy(() => import("@/web/pages/dashboard").then((m) => ({ default: m.DashboardPage })));
const DocsPage = lazy(() => import("@/web/pages/docs").then((m) => ({ default: m.DocsPage })));
const KeyCenterPage = lazy(() => import("@/web/pages/keys").then((m) => ({ default: m.KeyCenterPage })));
const LoginPage = lazy(() => import("@/web/pages/login").then((m) => ({ default: m.LoginPage })));
const OrderDetailPage = lazy(() => import("@/web/pages/order-detail").then((m) => ({ default: m.OrderDetailPage })));
const OrdersPage = lazy(() => import("@/web/pages/orders").then((m) => ({ default: m.OrdersPage })));
const SettingsPage = lazy(() => import("@/web/pages/settings").then((m) => ({ default: m.SettingsPage })));
const SetupPage = lazy(() => import("@/web/pages/setup").then((m) => ({ default: m.SetupPage })));
const SystemPage = lazy(() => import("@/web/pages/system").then((m) => ({ default: m.SystemPage })));

function RequireAdmin({ children }: { children: ReactNode }) {
  const { data, error, isLoading, isValidating } = useSWR<{ user: { username: string } }>("/admin-api/me", swrFetcher, { shouldRetryOnError: false });
  if (isLoading || (isValidating && !data)) return <Loading label="正在验证会话" />;
  if (error instanceof ApiClientError && error.status === 401) return <Navigate to="/login" replace />;
  if (error || !data) return <Navigate to="/login" replace />;
  return children;
}

function Home() {
  const { data, isLoading } = useSWR<{ setup_completed: boolean }>("/admin-api/setup/status", swrFetcher);
  if (isLoading) return <Loading />;
  return <Navigate to={data?.setup_completed ? "/dashboard" : "/setup"} replace />;
}

export function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/checkout/:token" element={<CheckoutPage />} />
        <Route element={<RequireAdmin><AppShell /></RequireAdmin>}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/orders" element={<OrdersPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/keys" element={<KeyCenterPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/system" element={<SystemPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
