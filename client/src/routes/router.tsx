import { lazy } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { isDemoDataEnabled } from "../demo/mode";
import { AppLayoutRoute, RequireRole, RouteErrorElement } from "../components/RouteGuards";
import { PublicShell } from "../components/layout/PublicShell";

/*
 * Every page is code-split, so a visitor checking a batch from a QR code
 * downloads the verification page and nothing else. The page modules live under
 * `src/pages`; the paths below are the contract between this file and them.
 */

const LandingPage = lazy(() => import("../pages/public/LandingPage"));
const VerifyLookupPage = lazy(() => import("../pages/public/VerifyLookupPage"));
const VerifyResultPage = lazy(() => import("../pages/public/VerifyResultPage"));
const SearchPage = lazy(() => import("../pages/public/SearchPage"));
const ConnectWalletPage = lazy(() => import("../pages/public/ConnectWalletPage"));
const ErrorPage = lazy(() => import("../pages/public/ErrorPage"));
const UnsupportedWalletPage = lazy(() => import("../pages/public/UnsupportedWalletPage"));
const NotFoundPage = lazy(() => import("../pages/public/NotFoundPage"));

const DashboardPage = lazy(() => import("../pages/app/DashboardPage"));
const ProfilePage = lazy(() => import("../pages/app/ProfilePage"));
const NotificationsPage = lazy(() => import("../pages/app/NotificationsPage"));
const ActivityPage = lazy(() => import("../pages/app/ActivityPage"));
const SettingsPage = lazy(() => import("../pages/app/SettingsPage"));

const ProductListPage = lazy(() => import("../pages/app/products/ProductListPage"));
const RegisterProductPage = lazy(() => import("../pages/app/products/RegisterProductPage"));
const ProductDetailPage = lazy(() => import("../pages/app/products/ProductDetailPage"));
const ProductHistoryPage = lazy(() => import("../pages/app/products/ProductHistoryPage"));
const ProductVerifyPage = lazy(() => import("../pages/app/products/ProductVerifyPage"));
const ProductTransferPage = lazy(() => import("../pages/app/products/ProductTransferPage"));
const ProductProcessingPage = lazy(() => import("../pages/app/products/ProductProcessingPage"));
const ProductTransportPage = lazy(() => import("../pages/app/products/ProductTransportPage"));
const ProductSalePage = lazy(() => import("../pages/app/products/ProductSalePage"));

const TransferListPage = lazy(() => import("../pages/app/transfers/TransferListPage"));
const PendingTransfersPage = lazy(() => import("../pages/app/transfers/PendingTransfersPage"));
const TransferDetailPage = lazy(() => import("../pages/app/transfers/TransferDetailPage"));

const ComplianceDashboardPage = lazy(() => import("../pages/app/compliance/ComplianceDashboardPage"));
const ReportsPage = lazy(() => import("../pages/app/compliance/ReportsPage"));
const NewReportPage = lazy(() => import("../pages/app/compliance/NewReportPage"));
const ReportDetailPage = lazy(() => import("../pages/app/compliance/ReportDetailPage"));

const OperationsReconciliationPage = lazy(() => import("../pages/app/OperationsReconciliationPage"));

/** Only a regulator may see the compliance and operations sections. */
const REGULATOR_ONLY = ["REGULATOR"] as const;

/** Registering a batch is a farmer's action. A regulator may do it on their behalf. */
const MAY_REGISTER_PRODUCTS = ["FARMER", "REGULATOR"] as const;

const ERROR_ELEMENT = <RouteErrorElement />;

export const router = createBrowserRouter([
  {
    errorElement: ERROR_ELEMENT,
    element: <PublicShell />,
    children: [
      // While placeholder data is in use the reviewer is treated as already
      // signed in with a wallet connected, so the first thing they see is the
      // product rather than a page asking them to be someone. The landing page
      // stays reachable at /landing, because it is still worth reading.
      isDemoDataEnabled()
        ? { index: true, element: <Navigate to="/app/dashboard" replace /> }
        : { index: true, element: <LandingPage /> },
      { path: "landing", element: <LandingPage /> },
      { path: "verify", element: <VerifyLookupPage /> },
      { path: "verify/:productId", element: <VerifyResultPage /> },
      { path: "search", element: <SearchPage /> },
      { path: "connect", element: <ConnectWalletPage /> },
      { path: "error", element: <ErrorPage /> },
      { path: "auth/unsupported-wallet", element: <UnsupportedWalletPage /> },
    ],
  },
  {
    path: "/app",
    errorElement: ERROR_ELEMENT,
    element: <AppLayoutRoute />,
    children: [
      { index: true, element: <Navigate to="/app/dashboard" replace /> },
      { path: "dashboard", element: <DashboardPage /> },
      { path: "profile", element: <ProfilePage /> },
      { path: "notifications", element: <NotificationsPage /> },
      { path: "activity", element: <ActivityPage /> },
      { path: "settings", element: <SettingsPage /> },

      { path: "products", element: <ProductListPage /> },
      {
        path: "products/register",
        element: (
          <RequireRole roles={MAY_REGISTER_PRODUCTS}>
            <RegisterProductPage />
          </RequireRole>
        ),
      },
      { path: "products/:productId", element: <ProductDetailPage /> },
      { path: "products/:productId/history", element: <ProductHistoryPage /> },
      { path: "products/:productId/verify", element: <ProductVerifyPage /> },
      { path: "products/:productId/transfer", element: <ProductTransferPage /> },
      { path: "products/:productId/processing", element: <ProductProcessingPage /> },
      { path: "products/:productId/transport", element: <ProductTransportPage /> },
      { path: "products/:productId/sale", element: <ProductSalePage /> },

      { path: "transfers", element: <TransferListPage /> },
      { path: "transfers/pending", element: <PendingTransfersPage /> },
      { path: "transfers/:transferId", element: <TransferDetailPage /> },

      {
        path: "compliance",
        element: (
          <RequireRole roles={REGULATOR_ONLY}>
            <ComplianceDashboardPage />
          </RequireRole>
        ),
      },
      {
        path: "compliance/reports",
        element: (
          <RequireRole roles={REGULATOR_ONLY}>
            <ReportsPage />
          </RequireRole>
        ),
      },
      {
        path: "compliance/reports/new",
        element: (
          <RequireRole roles={REGULATOR_ONLY}>
            <NewReportPage />
          </RequireRole>
        ),
      },
      {
        path: "compliance/reports/:reportId",
        element: (
          <RequireRole roles={REGULATOR_ONLY}>
            <ReportDetailPage />
          </RequireRole>
        ),
      },

      {
        path: "operations/reconciliation",
        element: (
          <RequireRole roles={REGULATOR_ONLY}>
            <OperationsReconciliationPage />
          </RequireRole>
        ),
      },
    ],
  },
  {
    path: "*",
    errorElement: ERROR_ELEMENT,
    element: <CatchAllLayout />,
  },
]);

/** The not-found page, inside the public frame so the reader keeps the header. */
function CatchAllLayout() {
  return (
    <PublicShell>
      <NotFoundPage />
    </PublicShell>
  );
}
