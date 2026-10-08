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

// #1024 第 22 批:可預約時段清單(預設空;「直接調時間 × 填過資料」那幾條才放一組)。
const w = vi.hoisted(() => ({
  windows: [] as {
    id: string;
    staff_id: string;
    day_of_week: number;
    start_time: string;
    end_time: string;
  }[],
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
  useStaffAvailabilityWindows: () => ({ data: w.windows, isLoading: false }),
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

// 第 11 批 J(#995 J-14 L11):編輯服務人員的「填過資料」接線(服務項目欄位即存,不算)。
describe("第 11 批 J:編輯服務人員 × 填過資料才問放棄", () => {
  function renderWithSpy(staff: MerchantStaff | null, onOpenChange: (o: boolean) => void) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <StaffFormDialog
            merchantId="merchant-1"
            staff={staff}
            open
            onOpenChange={onOpenChange}
            onSaved={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("打開不改 ⇒ Esc 直接關", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithSpy(STAFF, onOpenChange);
    await screen.findByRole("combobox", { name: "計酬類型" });
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("確定放棄這次輸入？")).toBeNull();
  });

  it("改姓名一個字 ⇒ Esc 先問「確定放棄這次輸入？」、不關", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithSpy(STAFF, onOpenChange);
    await user.type(await screen.findByLabelText(/姓名/), "A");
    await user.keyboard("{Escape}");
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("只動即存的服務項目下拉 ⇒ 不算填過,Esc 直接關", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithSpy(STAFF, onOpenChange);
    const trigger = await screen.findByTestId("staff-service-items-trigger");
    await user.click(trigger);
    await user.click(await screen.findByTestId("staff-service-items-option-item-1"));
    await waitFor(() => expect(m.addStaffServiceItem).toHaveBeenCalled());
    // 第一次 Esc 只收起下拉(浮出面板,J-2),視窗不動;第二次才輪到視窗。
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("staff-service-items-content")).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("確定放棄這次輸入？")).toBeNull();
  });
});

describe("#1024 第 22 批:編輯服務人員 × 可預約時段直接調時間也算填過資料", () => {
  afterEach(() => {
    w.windows = [];
  });

  function renderWithSpy(onOpenChange: (o: boolean) => void) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <StaffFormDialog
            merchantId="merchant-1"
            staff={STAFF}
            open
            onOpenChange={onOpenChange}
            onSaved={() => undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("改了某一組的開始時間還沒按「儲存」⇒ Esc 先問放棄;按「還原」後 Esc 直接關", async () => {
    w.windows = [
      {
        id: "w-1",
        staff_id: STAFF.id,
        day_of_week: 1,
        start_time: "09:00:00",
        end_time: "12:00:00",
      },
    ];
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithSpy(onOpenChange);
    const start = await screen.findByLabelText("星期一 09:00 - 12:00的開始時間");
    // 原生時間欄位:用 change 事件直接給新值(jsdom 不支援逐字輸入 time)。
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(start, { target: { value: "10:00" } });
    expect(screen.getByRole("button", { name: "儲存星期一 09:00 - 12:00" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(await screen.findByText("確定放棄這次輸入？")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "繼續編輯" }));
    await waitFor(() => expect(screen.queryByText("確定放棄這次輸入？")).toBeNull());
    await user.click(screen.getByRole("button", { name: "還原星期一 09:00 - 12:00" }));
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("主腦裁決:新增一組跟同一天重疊的時段 ⇒ 擋在畫面上(訊息跟編輯一致),不送出", async () => {
    w.windows = [
      {
        id: "w-1",
        staff_id: STAFF.id,
        day_of_week: 1,
        start_time: "09:00:00",
        end_time: "12:00:00",
      },
    ];
    const { toast } = await import("sonner");
    const user = userEvent.setup();
    renderWithSpy(vi.fn());
    await screen.findByLabelText("星期一 09:00 - 12:00的開始時間");
    // 新增列預設是星期一 09:00–18:00 ⇒ 跟 09:00–12:00 重疊
    await user.click(screen.getByRole("button", { name: "新增時段" }));
    expect(toast.error).toHaveBeenCalledWith(
      "這個時段跟同一天已設定的「09:00–12:00」重疊，請調整時間。",
    );
  });
});
