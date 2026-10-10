import { Suspense, type ReactNode } from "react";
import { Link, Route, Routes } from "react-router-dom";

import { GuardLoading } from "@/components/patterns/GuardLoading";
import { lazyWithReload } from "@/lib/lazyWithReload";
import { CurrentMerchantProvider } from "@/modules/merchant/context";
import { MERCHANT_FEATURE_KEYS } from "@/modules/merchant/features";
import { RequireMerchantFeature } from "@/modules/merchant/RequireMerchantFeature";

// ─── SPECS-INDEX #1054(網站拆檔,體檢 D-03)───────────────────────────────────────────────
// 原本這裡把全站每一頁都直接 import 進來,整個網站被打包成一個約 1.9 MB 的檔案,手機第一次打開要整包
// 下載。改成「用到才下載」:每一頁用 lazyWithReload(React.lazy + 載入失敗自動重新整理一次)載入,
// 同一組的頁面放在 src/routes/pageGroups/ 底下同一支分組檔,打包後每組一個分檔:
//   ・公開頁(publicPages)       ・客人預約端(customerPages)   ・商家後台(merchantPages)
//   ・服務人員端(staffPages)     ・超級管理員(platformAdminPages)
//   ・行事曆(CalendarPage 自己一個分檔;訂單管理頁、服務人員行事曆也用動態 import 拿它的表單)
// 客人打開預約頁只下載主程式 + 客人預約端這一包,不下載後台與超管程式。
// 權限判斷完全沒變:各頁的守門元件(Require*、PlatformAdminGuard、AppLayout 裡的登入檢查)照舊,
// 資料庫照舊擋;拆檔只影響「程式什麼時候下載」。
// 下載中的畫面用既有的 GuardLoading 骨架(跟守門元件「還不知道有沒有權限」時同一個畫面),不新增文字。
const loadPublicPages = () => import("@/routes/pageGroups/publicPages");
const loadCustomerPages = () => import("@/routes/pageGroups/customerPages");
const loadMerchantPages = () => import("@/routes/pageGroups/merchantPages");
const loadStaffPages = () => import("@/routes/pageGroups/staffPages");
const loadPlatformAdminPages = () => import("@/routes/pageGroups/platformAdminPages");
const loadCalendarPage = () => import("@/modules/booking/CalendarPage");

const Landing = lazyWithReload(loadPublicPages, (m) => m.Landing);
const SignIn = lazyWithReload(loadPublicPages, (m) => m.SignIn);
const SignUp = lazyWithReload(loadPublicPages, (m) => m.SignUp);
const ForgotPassword = lazyWithReload(loadPublicPages, (m) => m.ForgotPassword);
const Privacy = lazyWithReload(loadPublicPages, (m) => m.Privacy);
const Terms = lazyWithReload(loadPublicPages, (m) => m.Terms);
const EmailChangeConfirmedPage = lazyWithReload(loadPublicPages, (m) => m.EmailChangeConfirmedPage);
const ResetPasswordPage = lazyWithReload(loadPublicPages, (m) => m.ResetPasswordPage);

const PublicBookingPage = lazyWithReload(loadCustomerPages, (m) => m.PublicBookingPage);
const MemberCenterPage = lazyWithReload(loadCustomerPages, (m) => m.MemberCenterPage);
const ContactInvitePage = lazyWithReload(loadCustomerPages, (m) => m.ContactInvitePage);
const LineLoginCallbackPage = lazyWithReload(loadCustomerPages, (m) => m.LineLoginCallbackPage);

const AppLayout = lazyWithReload(loadMerchantPages, (m) => m.AppLayout);
const HomePage = lazyWithReload(loadMerchantPages, (m) => m.HomePage);
const ManagePage = lazyWithReload(loadMerchantPages, (m) => m.ManagePage);
const OnboardingPage = lazyWithReload(loadMerchantPages, (m) => m.OnboardingPage);
const NewMerchantPage = lazyWithReload(loadMerchantPages, (m) => m.NewMerchantPage);
const MerchantSettingsPage = lazyWithReload(loadMerchantPages, (m) => m.MerchantSettingsPage);
const StaffListPage = lazyWithReload(loadMerchantPages, (m) => m.StaffListPage);
const AgentListPage = lazyWithReload(loadMerchantPages, (m) => m.AgentListPage);
const AgentPermissionsPage = lazyWithReload(loadMerchantPages, (m) => m.AgentPermissionsPage);
const AgentInviteCompletePage = lazyWithReload(loadMerchantPages, (m) => m.AgentInviteCompletePage);
const StaffPermissionsPage = lazyWithReload(loadMerchantPages, (m) => m.StaffPermissionsPage);
const ServiceItemsPage = lazyWithReload(loadMerchantPages, (m) => m.ServiceItemsPage);
const BusinessHoursPage = lazyWithReload(loadMerchantPages, (m) => m.BusinessHoursPage);
const MaterialCostsPage = lazyWithReload(loadMerchantPages, (m) => m.MaterialCostsPage);
const PaymentMethodsPage = lazyWithReload(loadMerchantPages, (m) => m.PaymentMethodsPage);
const OrdersPage = lazyWithReload(loadMerchantPages, (m) => m.OrdersPage);
const LeaveTypesPage = lazyWithReload(loadMerchantPages, (m) => m.LeaveTypesPage);
const LeaveRecordsPage = lazyWithReload(loadMerchantPages, (m) => m.LeaveRecordsPage);
const SchedulingOverviewPage = lazyWithReload(loadMerchantPages, (m) => m.SchedulingOverviewPage);
const PayrollSettingsPage = lazyWithReload(loadMerchantPages, (m) => m.PayrollSettingsPage);
const BillingReportPage = lazyWithReload(loadMerchantPages, (m) => m.BillingReportPage);
const StaffReportPage = lazyWithReload(loadMerchantPages, (m) => m.StaffReportPage);
const MembersListPage = lazyWithReload(loadMerchantPages, (m) => m.MembersListPage);
const MemberDetailPage = lazyWithReload(loadMerchantPages, (m) => m.MemberDetailPage);
const MemberPointsPage = lazyWithReload(loadMerchantPages, (m) => m.MemberPointsPage);
const MemberSettingsPage = lazyWithReload(loadMerchantPages, (m) => m.MemberSettingsPage);
const LineSettingsPage = lazyWithReload(loadMerchantPages, (m) => m.LineSettingsPage);
const LineEventSettingsPage = lazyWithReload(loadMerchantPages, (m) => m.LineEventSettingsPage);
const LineLogsPage = lazyWithReload(loadMerchantPages, (m) => m.LineLogsPage);
const LineMarketingPage = lazyWithReload(loadMerchantPages, (m) => m.LineMarketingPage);
const ImportWizardPage = lazyWithReload(loadMerchantPages, (m) => m.ImportWizardPage);
const ImportHistoryPage = lazyWithReload(loadMerchantPages, (m) => m.ImportHistoryPage);
const ReportExportCenterPage = lazyWithReload(loadMerchantPages, (m) => m.ReportExportCenterPage);
const IndustryTransferWizardPage = lazyWithReload(
  loadMerchantPages,
  (m) => m.IndustryTransferWizardPage,
);
const PushEventSettingsPage = lazyWithReload(loadMerchantPages, (m) => m.PushEventSettingsPage);
const PushLogsPage = lazyWithReload(loadMerchantPages, (m) => m.PushLogsPage);

const CalendarPage = lazyWithReload(loadCalendarPage, (m) => m.default);

const MyAvailabilityPage = lazyWithReload(loadStaffPages, (m) => m.MyAvailabilityPage);
const MyPayrollPage = lazyWithReload(loadStaffPages, (m) => m.MyPayrollPage);
const StaffInviteCompletePage = lazyWithReload(loadStaffPages, (m) => m.StaffInviteCompletePage);

const PlatformAdminGuard = lazyWithReload(loadPlatformAdminPages, (m) => m.PlatformAdminGuard);
const MerchantsOverviewPage = lazyWithReload(
  loadPlatformAdminPages,
  (m) => m.MerchantsOverviewPage,
);
const MerchantDetailPage = lazyWithReload(loadPlatformAdminPages, (m) => m.MerchantDetailPage);
const IndustryPresetsPage = lazyWithReload(loadPlatformAdminPages, (m) => m.IndustryPresetsPage);

/** 後台外殼裡面、跟外殼不同分檔的頁面(行事曆、服務人員端各頁)用這個包一層:
 * 下載中只有內容區顯示骨架,外殼(品牌列、底部分頁籤)維持原樣,不會整頁換成骨架。 */
function InShellSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<GuardLoading />}>{children}</Suspense>;
}

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
      <Suspense fallback={<GuardLoading />}>
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
            <Route
              path="/app/calendar"
              element={
                <InShellSuspense>
                  <CalendarPage />
                </InShellSuspense>
              }
            />
            <Route path="/app/orders" element={<OrdersPage />} />
            <Route path="/app/staff" element={<StaffListPage />} />
            {/* SPECS-INDEX #1025 FG3-U02:平台沒開「服務人員登入端」⇒ 服務人員權限頁整個看不到,導回服務人員名單。 */}
            <Route
              path="/app/staff/:staffId/permissions"
              element={
                <RequireMerchantFeature
                  featureKey={MERCHANT_FEATURE_KEYS.staffPortal}
                  redirectTo="/app/staff"
                >
                  <StaffPermissionsPage />
                </RequireMerchantFeature>
              }
            />
            <Route path="/app/agents" element={<AgentListPage />} />
            <Route path="/app/agents/:agentId/permissions" element={<AgentPermissionsPage />} />
            {/* SPECS-INDEX #1025 FG3-U01:平台沒開「服務人員自己排休」/「服務人員查看自己的抽成薪資」⇒ 導回 /app。
              (登入端整個關掉時由 AppLayout 處理:只顯示一句話 + 登出。) */}
            <Route
              path="/app/my-availability"
              element={
                <RequireMerchantFeature
                  featureKey={MERCHANT_FEATURE_KEYS.staffSelfAvailability}
                  redirectTo="/app"
                >
                  <InShellSuspense>
                    <MyAvailabilityPage />
                  </InShellSuspense>
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/my-payroll"
              element={
                <RequireMerchantFeature
                  featureKey={MERCHANT_FEATURE_KEYS.staffSelfPayroll}
                  redirectTo="/app"
                >
                  <InShellSuspense>
                    <MyPayrollPage />
                  </InShellSuspense>
                </RequireMerchantFeature>
              }
            />
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
            <Route path="/app/member-points" element={<MemberPointsPage />} />
            <Route path="/app/member-settings" element={<MemberSettingsPage />} />
            {/* SPECS-INDEX #1025 FG2-U01:平台沒開通 LINE 通知 / 再行銷通知 / 手機推播通知 ⇒ 設定頁與發送記錄頁
              整個看不到,直接打網址導回功能頁(紀錄資料保留,重新打開看得到)。
              例外:LINE 串接設定頁仍可進入(只剩 LINE 登入設定卡),見下一列。 */}
            {/* LINE 串接設定頁不整頁擋:LINE 通知沒開時頁面只剩「LINE 登入」設定卡(主腦裁決,頁面自己處理)。 */}
            <Route path="/app/line-settings" element={<LineSettingsPage />} />
            <Route
              path="/app/line-events"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.lineNotifications}>
                  <LineEventSettingsPage />
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/line-logs"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.lineNotifications}>
                  <LineLogsPage />
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/line-marketing"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.lineMarketing}>
                  <LineMarketingPage />
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/push-events"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.pushNotifications}>
                  <PushEventSettingsPage />
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/push-logs"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.pushNotifications}>
                  <PushLogsPage />
                </RequireMerchantFeature>
              }
            />
            {/* SPECS-INDEX #1025 FG1-U06:平台沒開通這個功能 ⇒ 整個看不到,直接打網址導回功能頁。 */}
            <Route
              path="/app/data-import"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.dataImport}>
                  <ImportWizardPage />
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/data-import/history"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.dataImport}>
                  <ImportHistoryPage />
                </RequireMerchantFeature>
              }
            />
            <Route
              path="/app/reports"
              element={
                <RequireMerchantFeature featureKey={MERCHANT_FEATURE_KEYS.reportExport}>
                  <ReportExportCenterPage />
                </RequireMerchantFeature>
              }
            />
            <Route path="/app/industry-transfer" element={<IndustryTransferWizardPage />} />
          </Route>
          <Route path="/app/onboarding" element={<OnboardingPage />} />
          <Route path="/app/new-merchant" element={<NewMerchantPage />} />
          <Route path="/app/agent-invite-complete" element={<AgentInviteCompletePage />} />
          <Route path="/app/staff-invite-complete" element={<StaffInviteCompletePage />} />
          {/* 對應規格書(帳號登入安全性優化)2.4.4/3.2.2:登入信箱變更確認頁、忘記密碼重設頁,
            比照 /app/agent-invite-complete 的既有做法,刻意放在 <AppLayout> 巢狀路由之外
            (獨立全螢幕流程,不套用商家切換器/底部分頁籤外殼)。 */}
          <Route path="/app/email-change-confirmed" element={<EmailChangeConfirmedPage />} />
          <Route path="/app/reset-password" element={<ResetPasswordPage />} />
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
          {/* 對應規格書(帳號登入安全性優化)3.2.1:忘記密碼申請頁,公開頁面,跟 /signin、/signup
            同層級,不需要登入狀態。 */}
          <Route path="/forgot-password" element={<ForgotPassword />} />
          {/* 客戶端第 1 批(C1-A01):公開預約頁。不需要登入、不套後台外殼(AppLayout);
            已登入後台的人打開也是客人版畫面,不讀目前操作中的商家。 */}
          <Route path="/booking/:slug" element={<PublicBookingPage />} />
          {/* 客戶端第 4 批(C4-B05):會員中心。分頁之間是一般網址切換。 */}
          <Route path="/booking/:slug/me" element={<MemberCenterPage tab="home" />} />
          <Route path="/booking/:slug/me/bookings" element={<MemberCenterPage tab="bookings" />} />
          <Route path="/booking/:slug/me/wallet" element={<MemberCenterPage tab="wallet" />} />
          <Route path="/booking/:slug/me/profile" element={<MemberCenterPage tab="profile" />} />
          {/* 客戶端第 4 批 4-B(C4-H06):聯絡人邀請落地頁;邀請碼一進來就從網址列拿掉(C4-F04)。 */}
          <Route path="/booking/:slug/invite" element={<ContactInvitePage />} />
          <Route path="/booking/:slug/invite/:token" element={<ContactInvitePage />} />
          {/* 客戶端第 2 批(C2-B02):LINE 登入回來的頁面,所有商家共用。不套後台外殼、不需要後台登入。 */}
          <Route path="/auth/line/callback" element={<LineLoginCallbackPage />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </CurrentMerchantProvider>
  );
}
