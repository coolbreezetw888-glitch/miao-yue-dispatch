import { Link, Route, Routes } from "react-router-dom";

import Landing from "@/routes/index";
import AppShell from "@/routes/app";
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
import ServiceItemsPage from "@/modules/service-items/ServiceItemsPage";

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
        <Route path="/app" element={<AppShell />} />
        <Route path="/app/onboarding" element={<OnboardingPage />} />
        <Route path="/app/new-merchant" element={<NewMerchantPage />} />
        <Route path="/app/settings" element={<MerchantSettingsPage />} />
        <Route path="/app/staff" element={<StaffListPage />} />
        <Route path="/app/agents" element={<AgentListPage />} />
        <Route path="/app/agents/:agentId/permissions" element={<AgentPermissionsPage />} />
        <Route path="/app/agent-invite-complete" element={<AgentInviteCompletePage />} />
        <Route path="/app/service-items" element={<ServiceItemsPage />} />
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
