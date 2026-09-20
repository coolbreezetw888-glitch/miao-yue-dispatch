import { Link, Route, Routes } from "react-router-dom";

import Landing from "@/routes/index";
import AppLayout from "@/routes/AppLayout";
import HomePage from "@/routes/HomePage";
import ManagePage from "@/routes/ManagePage";
import SignIn from "@/routes/signin";
import SignUp from "@/routes/signup";
import Privacy from "@/routes/privacy";
import Terms from "@/routes/terms";
import { CurrentMerchantProvider } from "@/modules/merchant/context";
import OnboardingPage from "@/modules/merchant/OnboardingPage";
import NewMerchantPage from "@/modules/merchant/NewMerchantPage";
import MerchantSettingsPage from "@/modules/merchant/MerchantSettingsPage";
import { PlatformAdminGuard } from "@/modules/platform-admin/PlatformAdminGuard";
import MerchantsOverviewPage from "@/modules/platform-admin/MerchantsOverviewPage";
import MerchantDetailPage from "@/modules/platform-admin/MerchantDetailPage";
import IndustryPresetsPage from "@/modules/platform-admin/IndustryPresetsPage";
import StaffListPage from "@/modules/staff-agent/StaffListPage";
import AgentListPage from "@/modules/staff-agent/AgentListPage";
import AgentPermissionsPage from "@/modules/staff-agent/AgentPermissionsPage";
import AgentInviteCompletePage from "@/modules/staff-agent/AgentInviteCompletePage";
import StaffInviteCompletePage from "@/modules/staff-portal/StaffInviteCompletePage";
import MyAvailabilityPage from "@/modules/staff-portal/MyAvailabilityPage";
import MyPayrollPage from "@/modules/staff-portal/MyPayrollPage";
import StaffPermissionsPage from "@/modules/staff-agent/StaffPermissionsPage";
import ServiceItemsPage from "@/modules/service-items/ServiceItemsPage";
import BusinessHoursPage from "@/modules/booking/BusinessHoursPage";
import CalendarPage from "@/modules/booking/CalendarPage";
import MaterialCostsPage from "@/modules/booking/MaterialCostsPage";
import PaymentMethodsPage from "@/modules/booking/PaymentMethodsPage";
import OrdersPage from "@/modules/booking/OrdersPage";
import LeaveTypesPage from "@/modules/scheduling/LeaveTypesPage";
import LeaveRecordsPage from "@/modules/scheduling/LeaveRecordsPage";
import SchedulingOverviewPage from "@/modules/scheduling/SchedulingOverviewPage";
import PayrollSettingsPage from "@/modules/payroll/PayrollSettingsPage";
import BillingReportPage from "@/modules/payroll/BillingReportPage";
import StaffReportPage from "@/modules/payroll/StaffReportPage";
import MembersListPage from "@/modules/members/MembersListPage";
import MemberDetailPage from "@/modules/members/MemberDetailPage";
import MemberSettingsPage from "@/modules/members/MemberSettingsPage";
import LineSettingsPage from "@/modules/line-notifications/LineSettingsPage";
import LineEventSettingsPage from "@/modules/line-notifications/LineEventSettingsPage";
import LineLogsPage from "@/modules/line-notifications/LineLogsPage";
import LineMarketingPage from "@/modules/line-notifications/LineMarketingPage";
import ImportWizardPage from "@/modules/data-tools/ImportWizardPage";
import ImportHistoryPage from "@/modules/data-tools/ImportHistoryPage";
import ReportExportCenterPage from "@/modules/data-tools/ReportExportCenterPage";
import IndustryTransferWizardPage from "@/modules/data-tools/IndustryTransferWizardPage";

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <CurrentMerchantProvider>
      <Routes>
        <Route path="/" element={<Landing />} />
        {/* 後台導覽外殼(跨模組共用外殼):/app/* 底下的路由統一套用 AppLayout(品牌列 +
            底部 3 個分頁籤:首頁/功能/行事曆),取代原本每個 /app/* 路由各自平行、各自手刻
            頂端列的寫法。例外(維持獨立全螢幕流程,不套外殼,見規格書「例外」一節):
            /app/onboarding、/app/agent-invite-complete、/app/staff-invite-complete(模組 14
            服務人員端規格書 4.8,完全比照 agent-invite-complete 的既有做法)。/app/new-merchant 這個獨立表單流程
            也維持現狀不套外殼(規格書明講「細節不強制,由工程師視畫面觀感決定」)。
            /app/settings 沒有另外的權限守衛包裝,行為跟改版前一致(沿用既有 MerchantSettingsPage,
            「功能」分頁籤的卡片本身已經只對 isAdmin 顯示這個入口)。 */}
        <Route element={<AppLayout />}>
          <Route path="/app" element={<HomePage />} />
          <Route path="/app/manage" element={<ManagePage />} />
          <Route path="/app/settings" element={<MerchantSettingsPage />} />
          <Route path="/app/calendar" element={<CalendarPage />} />
          <Route path="/app/orders" element={<OrdersPage />} />
          <Route path="/app/staff" element={<StaffListPage />} />
          <Route path="/app/staff/:staffId/permissions" element={<StaffPermissionsPage />} />
          <Route path="/app/agents" element={<AgentListPage />} />
          <Route path="/app/agents/:agentId/permissions" element={<AgentPermissionsPage />} />
          <Route path="/app/my-availability" element={<MyAvailabilityPage />} />
          <Route path="/app/my-payroll" element={<MyPayrollPage />} />
          <Route path="/app/service-items" element={<ServiceItemsPage />} />
          <Route path="/app/business-hours" element={<BusinessHoursPage />} />
          <Route path="/app/material-costs" element={<MaterialCostsPage />} />
          <Route path="/app/payment-methods" element={<PaymentMethodsPage />} />
          <Route path="/app/leave-types" element={<LeaveTypesPage />} />
          <Route path="/app/leave-records" element={<LeaveRecordsPage />} />
          <Route path="/app/scheduling" element={<SchedulingOverviewPage />} />
          <Route path="/app/payroll-settings" element={<PayrollSettingsPage />} />
          <Route path="/app/billing-report" element={<BillingReportPage />} />
          <Route path="/app/staff-report" element={<StaffReportPage />} />
          <Route path="/app/members" element={<MembersListPage />} />
          <Route path="/app/members/:id" element={<MemberDetailPage />} />
          <Route path="/app/member-settings" element={<MemberSettingsPage />} />
          <Route path="/app/line-settings" element={<LineSettingsPage />} />
          <Route path="/app/line-events" element={<LineEventSettingsPage />} />
          <Route path="/app/line-logs" element={<LineLogsPage />} />
          <Route path="/app/line-marketing" element={<LineMarketingPage />} />
          <Route path="/app/data-import" element={<ImportWizardPage />} />
          <Route path="/app/data-import/history" element={<ImportHistoryPage />} />
          <Route path="/app/reports" element={<ReportExportCenterPage />} />
          <Route path="/app/industry-transfer" element={<IndustryTransferWizardPage />} />
        </Route>
        <Route path="/app/onboarding" element={<OnboardingPage />} />
        <Route path="/app/new-merchant" element={<NewMerchantPage />} />
        <Route path="/app/agent-invite-complete" element={<AgentInviteCompletePage />} />
        <Route path="/app/staff-invite-complete" element={<StaffInviteCompletePage />} />
        <Route
          path="/platform-admin"
          element={
            <PlatformAdminGuard>
              <MerchantsOverviewPage />
            </PlatformAdminGuard>
          }
        />
        <Route
          path="/platform-admin/merchants/:id"
          element={
            <PlatformAdminGuard>
              <MerchantDetailPage />
            </PlatformAdminGuard>
          }
        />
        <Route
          path="/platform-admin/industry-presets"
          element={
            <PlatformAdminGuard>
              <IndustryPresetsPage />
            </PlatformAdminGuard>
          }
        />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/signup" element={<SignUp />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </CurrentMerchantProvider>
  );
}
