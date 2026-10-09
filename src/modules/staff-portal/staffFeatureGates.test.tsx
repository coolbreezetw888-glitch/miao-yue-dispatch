// SPECS-INDEX #1025 功能開關 第 3 批 FG3-T01(vitest):服務人員細部功能的畫面規則。
//
//   ・appLayoutLogic:登入端讀取中 / 關 / 開;雙重身分「能不能切過去」;服務人員分頁籤依細部功能隱藏
//   ・staffSectionFeatureStatus:跟資料庫 has_own_staff_permission 同一套疊加規則
//   ・StaffPortalClosedNotice:只有一句話 + 登出,不提秒約、不提開通(F8)
//   ・StaffListPage 編輯欄位:登入端 / 新增編輯訂單關時對應開關不顯示(值保留,T9)
//   ・StaffPermissionsPage:細部功能關 ⇒ 那一列不顯示;沒關的照常

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staffSectionFeatureStatus } from "@/modules/merchant/features";
import {
  STAFF_PORTAL_CLOSED_MESSAGE,
  STAFF_TABS,
  filterStaffTabsByFeatures,
  hasUsableStaffRecord,
  resolveStaffPortalGate,
} from "@/routes/appLayoutLogic";

const featureState = vi.hoisted(() => ({ map: {} as Record<string, boolean | undefined> }));

vi.mock("@/modules/merchant/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/merchant/features")>()),
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => featureState.map[key],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

const fetchMerchantStaffMock = vi.fn();
const fetchStaffPermissionsMock = vi.fn();
vi.mock("@/modules/staff-agent/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/staff-agent/api")>()),
  fetchMerchantStaff: (...args: unknown[]) => fetchMerchantStaffMock(...args),
}));
vi.mock("@/modules/staff-portal/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/staff-portal/api")>()),
  fetchStaffPermissions: (...args: unknown[]) => fetchStaffPermissionsMock(...args),
  setStaffPermission: vi.fn(),
}));
vi.mock("@/modules/merchant/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/merchant/context")>()),
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1" }, isLoading: false }),
}));
vi.mock("@/modules/staff-agent/RequireMerchantAdmin", () => ({
  RequireMerchantAdmin: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const { StaffPortalClosedNotice } = await import("./StaffPortalClosedNotice");
const { isStaffBooleanFieldVisible } =
  await import("@/modules/staff-agent/staffFeatureFieldVisibility");
const { default: StaffPermissionsPage } =
  await import("@/modules/staff-agent/StaffPermissionsPage");

const ALL_ON = {
  staff_portal: true,
  staff_order_editing: true,
  staff_self_availability: true,
  staff_self_payroll: true,
};

beforeEach(() => {
  featureState.map = { ...ALL_ON };
  fetchMerchantStaffMock.mockReset().mockResolvedValue([
    {
      id: "staff-1",
      merchant_id: "merchant-1",
      name: "阿哲",
      login_status: "active",
      status: "active",
      compensation_type: "piece_rate",
    },
  ]);
  fetchStaffPermissionsMock.mockReset().mockResolvedValue([]);
});

afterEach(() => cleanup());

describe("appLayoutLogic(FG3-U01)", () => {
  it("登入端:讀取中 / 關 / 開", () => {
    expect(resolveStaffPortalGate(undefined)).toBe("loading");
    expect(resolveStaffPortalGate(false)).toBe("closed");
    expect(resolveStaffPortalGate(true)).toBe("open");
  });

  it("雙重身分能不能切到服務人員端:要有服務人員紀錄 而且 登入端開著(讀取中也不能)", () => {
    expect(hasUsableStaffRecord(true, true)).toBe(true);
    expect(hasUsableStaffRecord(true, false)).toBe(false);
    expect(hasUsableStaffRecord(true, undefined)).toBe(false);
    expect(hasUsableStaffRecord(false, true)).toBe(false);
  });

  it("服務人員分頁籤:排休 / 薪資關(或還不知道)⇒ 對應分頁籤不顯示;個人資料、行事曆永遠在", () => {
    const labels = (f: Parameters<typeof filterStaffTabsByFeatures>[1]) =>
      filterStaffTabsByFeatures(STAFF_TABS, f).map((t) => t.label);
    expect(labels({ selfAvailability: true, selfPayroll: true })).toEqual([
      "個人資料",
      "行事曆",
      "休假設定",
      "薪資報表",
    ]);
    expect(labels({ selfAvailability: false, selfPayroll: true })).toEqual([
      "個人資料",
      "行事曆",
      "薪資報表",
    ]);
    expect(labels({ selfAvailability: true, selfPayroll: undefined })).toEqual([
      "個人資料",
      "行事曆",
      "休假設定",
    ]);
  });
});

describe("staffSectionFeatureStatus(跟資料庫 has_own_staff_permission 同一套)", () => {
  const status = (map: Record<string, boolean | undefined>, section: string) =>
    staffSectionFeatureStatus((k) => map[k], section);

  it("登入端關 ⇒ 四種 section 全部 false;讀取中 ⇒ undefined", () => {
    for (const s of [
      "staff_calendar_view",
      "staff_availability_self_manage",
      "staff_payroll_view",
      "staff_profile_edit",
    ]) {
      expect(status({ ...ALL_ON, staff_portal: false }, s)).toBe(false);
      expect(status({}, s)).toBeUndefined();
    }
  });

  it("細部功能只影響自己那一項", () => {
    const noAvail = { ...ALL_ON, staff_self_availability: false };
    expect(status(noAvail, "staff_availability_self_manage")).toBe(false);
    expect(status(noAvail, "staff_calendar_view")).toBe(true);
    expect(status(noAvail, "staff_payroll_view")).toBe(true);
    const noPay = { ...ALL_ON, staff_self_payroll: false };
    expect(status(noPay, "staff_payroll_view")).toBe(false);
    expect(status(noPay, "staff_profile_edit")).toBe(true);
  });
});

describe("StaffPortalClosedNotice(F8)", () => {
  it("只顯示固定一句話 + 登出;不提秒約、不提開通", async () => {
    const onSignOut = vi.fn();
    render(<StaffPortalClosedNotice onSignOut={onSignOut} />);
    const card = screen.getByTestId("staff-portal-closed");
    expect(card).toHaveTextContent("這間店目前沒有開放服務人員登入，請聯絡店家管理員。");
    expect(STAFF_PORTAL_CLOSED_MESSAGE).toBe("這間店目前沒有開放服務人員登入，請聯絡店家管理員。");
    expect(card.textContent).not.toMatch(/秒約|開通|方案|價格/);
    await userEvent.setup().click(screen.getByRole("button", { name: "登出" }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("StaffListPage 編輯欄位(FG3-U02)", () => {
  const f = (staffPortal: boolean, staffOrderEditing: boolean, onlineBooking = true) => ({
    staffPortal,
    staffOrderEditing,
    onlineBooking,
  });
  it("登入端關 ⇒ 新增編輯訂單、顯示會員資料不顯示;商家後台確認後直接接單照常(F9)", () => {
    expect(isStaffBooleanFieldVisible("can_create_edit_orders", f(false, true))).toBe(false);
    expect(isStaffBooleanFieldVisible("show_member_info", f(false, true))).toBe(false);
    expect(isStaffBooleanFieldVisible("direct_accept_after_merchant_confirm", f(false, true))).toBe(
      true,
    );
    expect(isStaffBooleanFieldVisible("unlimited_backend_edit", f(false, true))).toBe(true);
  });
  it("登入端開、新增編輯訂單關 ⇒ 只藏新增編輯訂單", () => {
    expect(isStaffBooleanFieldVisible("can_create_edit_orders", f(true, false))).toBe(false);
    expect(isStaffBooleanFieldVisible("show_member_info", f(true, false))).toBe(true);
  });
  it("全開 ⇒ 都顯示;線上預約關 ⇒ 只藏線上預約那兩個(⚠️6 不變)", () => {
    expect(isStaffBooleanFieldVisible("can_create_edit_orders", f(true, true))).toBe(true);
    expect(isStaffBooleanFieldVisible("auto_accept_booking", f(true, true, false))).toBe(false);
    expect(isStaffBooleanFieldVisible("can_create_edit_orders", f(true, true, false))).toBe(true);
  });
});

describe("StaffPermissionsPage(FG3-U02)", () => {
  async function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/app/staff/staff-1/permissions"]}>
          <Routes>
            <Route path="/app/staff/:staffId/permissions" element={<StaffPermissionsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByText("行事曆檢視");
  }

  it("全開 ⇒ 四項都在", async () => {
    await renderPage();
    expect(screen.getByText("可預約時段/休假自助調整")).toBeInTheDocument();
    expect(screen.getByText("抽成/薪資報表檢視")).toBeInTheDocument();
  });

  it("自己排休關 ⇒ 沒有「可預約時段/休假自助調整」;薪資關 ⇒ 沒有「抽成/薪資報表檢視」;其他照常", async () => {
    featureState.map = { ...ALL_ON, staff_self_availability: false, staff_self_payroll: false };
    await renderPage();
    expect(screen.queryByText("可預約時段/休假自助調整")).toBeNull();
    expect(screen.queryByText("抽成/薪資報表檢視")).toBeNull();
    expect(screen.getByText("個人資料編輯")).toBeInTheDocument();
  });
});
