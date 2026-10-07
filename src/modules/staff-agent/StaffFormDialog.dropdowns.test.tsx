// 第 11 批 G(#994):編輯服務人員的「計酬類型」「服務項目」改下拉。規格書 §14.3~§14.5、§14.7。
//
//   1. 計酬類型是 combobox、名稱「計酬類型」,編輯帶原值;改選後按儲存,updateMerchantStaff 收到新值。
//   2. 幽靈空值 / 不在白名單的值不會洗掉表單值(guardStaffCompensationTypeChange)。
//   3. 服務項目(編輯)是多選下拉,點一列立刻呼叫 addStaffServiceItem(不等儲存)。
//   4. 新增模式:服務項目照舊顯示「請先儲存…」灰字,沒有下拉。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { guardStaffCompensationTypeChange } from "./staffListLogic";
import type { MerchantStaff } from "./types";

const m = vi.hoisted(() => ({
  updateMerchantStaff: vi.fn(),
  addMerchantStaff: vi.fn(),
  fetchStaffServiceItemIds: vi.fn(),
  addStaffServiceItem: vi.fn(),
  removeStaffServiceItem: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./api", () => ({
  updateMerchantStaff: m.updateMerchantStaff,
  addMerchantStaff: m.addMerchantStaff,
  fetchStaffServiceItemIds: m.fetchStaffServiceItemIds,
  addStaffServiceItem: m.addStaffServiceItem,
  removeStaffServiceItem: m.removeStaffServiceItem,
  uploadStaffAvatar: vi.fn(),
}));
vi.mock("@/modules/service-items/context", () => ({
  getServiceItem: vi.fn(async () => null),
  useMerchantServiceItems: () => ({
    data: [
      { id: "item-1", name: "冷氣清洗", price: 1500, category_id: null, status: "active" },
      { id: "item-2", name: "冷氣安裝", price: 3000, category_id: null, status: "active" },
    ],
    isLoading: false,
  }),
  useMerchantServiceCategories: () => ({ data: [] }),
}));
vi.mock("@/modules/booking/context", () => ({
  useStaffAvailabilityWindows: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/modules/line-notifications/StaffLineBindingSection", () => ({
  StaffLineBindingSection: () => null,
}));
vi.mock("@/modules/push-notifications/StaffPushSubscriptionSummary", () => ({
  StaffPushSubscriptionSummary: () => null,
}));

const { StaffFormDialog } = await import("./StaffListPage");

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto["hasPointerCapture"] ??= () => false;
  proto["releasePointerCapture"] ??= () => undefined;
  proto["scrollIntoView"] ??= () => undefined;
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

const STAFF = {
  id: "staff-1",
  merchant_id: "merchant-1",
  name: "王師傅",
  phone: "0912345678",
  compensation_type: "monthly_salary",
  is_listed: true,
  status: "active",
} as unknown as MerchantStaff;

function renderDialog(staff: MerchantStaff | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <StaffFormDialog
          merchantId="merchant-1"
          staff={staff}
          open
          onOpenChange={() => undefined}
          onSaved={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.updateMerchantStaff.mockResolvedValue(undefined);
  m.fetchStaffServiceItemIds.mockResolvedValue(["item-2"]);
  m.addStaffServiceItem.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("第 11 批 G:計酬類型下拉", () => {
  it("是 combobox、名稱「計酬類型」,編輯帶原值「月薪制」;不再是 radiogroup", async () => {
    renderDialog(STAFF);
    const select = await screen.findByRole("combobox", { name: "計酬類型" });
    expect(select).toHaveTextContent("月薪制");
    expect(screen.queryByRole("radiogroup", { name: "計酬類型" })).toBeNull();
  });

  it("改選「抽成制」後按儲存 ⇒ updateMerchantStaff 收到 compensationType: piece_rate", async () => {
    const user = userEvent.setup();
    renderDialog(STAFF);
    await user.click(await screen.findByRole("combobox", { name: "計酬類型" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["抽成制", "月薪制"]);
    await user.click(screen.getByRole("option", { name: "抽成制" }));
    expect(screen.getByRole("combobox", { name: "計酬類型" })).toHaveTextContent("抽成制");
    await user.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(m.updateMerchantStaff).toHaveBeenCalled());
    expect(m.updateMerchantStaff.mock.calls[0]![0]).toBe("staff-1");
    expect(m.updateMerchantStaff.mock.calls[0]![1]).toMatchObject({
      compensationType: "piece_rate",
    });
  });

  it("G-2 白名單:幽靈空值與未知值不會洗掉表單值,合法值照常通過", () => {
    const onChange = vi.fn();
    const guarded = guardStaffCompensationTypeChange(onChange);
    guarded("");
    guarded("hourly");
    expect(onChange).not.toHaveBeenCalled();
    guarded("monthly_salary");
    guarded("piece_rate");
    expect(onChange.mock.calls).toEqual([["monthly_salary"], ["piece_rate"]]);
  });
});

describe("第 11 批 G:服務項目多選下拉", () => {
  it("編輯模式:外框寫已選摘要;點一列立刻呼叫 addStaffServiceItem(不等儲存)", async () => {
    const user = userEvent.setup();
    renderDialog(STAFF);
    const trigger = await screen.findByTestId("staff-service-items-trigger");
    expect(trigger).toHaveAccessibleName("服務項目");
    await waitFor(() =>
      expect(screen.getByTestId("staff-service-items-summary")).toHaveTextContent(
        "已選 1 項：冷氣安裝",
      ),
    );
    await user.click(trigger);
    await user.click(await screen.findByTestId("staff-service-items-option-item-1"));
    expect(m.addStaffServiceItem).toHaveBeenCalledWith("staff-1", "item-1");
    expect(m.updateMerchantStaff).not.toHaveBeenCalled();
    // 清單仍開著
    expect(screen.getByTestId("staff-service-items-content")).toBeInTheDocument();
  });

  it("新增模式:服務項目照舊顯示「請先儲存…」灰字,沒有下拉;計酬類型預設抽成制", async () => {
    renderDialog(null);
    expect(
      await screen.findByText(
        "請先儲存這位服務人員的基本資料，儲存後重新點選「編輯」即可勾選服務項目。",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("staff-service-items-trigger")).toBeNull();
    expect(screen.getByRole("combobox", { name: "計酬類型" })).toHaveTextContent("抽成制");
  });
});
