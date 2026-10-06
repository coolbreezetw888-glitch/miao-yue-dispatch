// SPECS-INDEX #873(規格書 .project/specs/副服務人員移除修正.md 二、測試 Vitest 三條):
//   ① 二選一提示不可被 ✕ / 背景 / Esc 關閉;
//   ② 「維持現狀」不呼叫取消(也不呼叫任何還原);
//   ③ 「再加助手」開啟選人流程(行事曆:openEditForm(id, { focusAssistants: true }))。
// 另外鎖住成因修正:從「(協助)」色塊打開的詳情,底部是「移除協助人員」(remove_booking_assistant),
// 不是「取消預約」(cancel_booking);從主卡 / 訂單管理打開的詳情維持原樣。
//
// 【故障注入】把 BookingDetailDialog 的 handleRemoveAssistant 改回呼叫 cancelBooking(整張單取消),
//   本檔「確定移除 → 只呼叫 removeBookingAssistant、不呼叫 cancelBooking」那幾條會轉紅(見回報)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
  cancelBooking: vi.fn(),
  removeBookingAssistant: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("./api", () => ({
  getBooking: mocks.getBooking,
  getBookingPointsLedger: vi.fn(async () => null),
  fetchCompletedBookingReversalPreview: vi.fn(),
  revertCompletedBooking: vi.fn(),
  cancelCompletedBooking: vi.fn(),
  cancelBooking: mocks.cancelBooking,
  removeBookingAssistant: mocks.removeBookingAssistant,
  completeBooking: vi.fn(),
  confirmBooking: vi.fn(),
  getCustomerRelatedBookings: vi.fn(async () => []),
}));

vi.mock("./context", () => ({
  useBookingStatusChangeLogs: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: "merchant-1", name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: "admin", isLoading: false }),
  useAgentPermission: () => ({ data: null }),
}));

vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: vi.fn(),
  usePendingLineNotificationPreview: () => ({ refetch: vi.fn() }),
}));

vi.mock("@/modules/line-notifications/ConfirmBookingLineDialog", () => ({
  ConfirmBookingLineDialog: () => null,
}));

import { BookingDetailDialog } from "./BookingDetailDialog";
import { AssistantRemovedPrompt } from "./assistantRemoval";
import {
  assistantRemovedInfoAfterEdit,
  buildAssistantRemovedMessage,
  type AssistantRemovedInfo,
} from "./assistantRemovalLogic";

const BOOKING_ID = "booking-1";
const STAFF_NAMES = new Map([
  ["staff-main", "主服務人員甲"],
  ["staff-help", "協助人員乙"],
]);

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    merchant_id: "merchant-1",
    staff_id: "staff-main",
    status: "accepted",
    start_at: "2026-10-06T02:00:00Z",
    end_at: "2026-10-06T03:00:00Z",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    assistants: [{ staffId: "staff-help", staffName: "協助人員乙" }],
    createdByName: "客服甲",
    lastModifiedByName: null,
    last_modified_at: null,
    created_at: "2026-10-01T06:00:00Z",
    serviceItems: [{ id: "i-1", name: "剪髮", quantity: 1, lineTotal: 500 }],
    subtotal_amount_snapshot: 500,
    custom_total_amount_enabled: false,
    discount_enabled: false,
    tax_enabled: false,
    final_amount_snapshot: 500,
    payment_method_name_snapshot: "現金",
    materialCosts: [],
    customer_name: "王小美",
    customer_phone: "0912345678",
    customer_address: null,
    customer_notes: null,
    notes: null,
    hide_notes_from_staff: false,
    member_id: null,
    member_name_snapshot: null,
    points_planned: 0,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    ...overrides,
  };
}

const INFO: AssistantRemovedInfo = {
  bookingId: BOOKING_ID,
  assistantNames: ["協助人員乙"],
  primaryName: "主服務人員甲",
};

beforeEach(() => {
  mocks.getBooking.mockReset().mockResolvedValue(booking());
  mocks.cancelBooking.mockReset().mockResolvedValue({ id: BOOKING_ID, merchant_id: "merchant-1" });
  mocks.removeBookingAssistant.mockReset().mockResolvedValue({
    booking_id: BOOKING_ID,
    booking_status: "accepted",
    removed_staff_id: "staff-help",
    removed_staff_name: "協助人員乙",
    primary_staff_id: "staff-main",
    primary_staff_name: "主服務人員甲",
    remaining_assistant_count: 0,
  });
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
});

afterEach(() => cleanup());

// ===========================================================================
describe("文案與判斷(純邏輯)", () => {
  it("提示文案照主腦定稿", () => {
    expect(buildAssistantRemovedMessage(INFO)).toBe(
      "協助人員乙 已從這張訂單移除，主服務人員 主服務人員甲 的訂單維持不變。要再加一位協助人員嗎？",
    );
  });

  it("編輯表單:拿掉一位、沒加新的 ⇒ 要跳提示", () => {
    expect(
      assistantRemovedInfoAfterEdit({
        bookingId: BOOKING_ID,
        originalAssistants: [
          { staffId: "b", staffName: "乙" },
          { staffId: "c", staffName: "丙" },
        ],
        nextAssistantStaffIds: ["c"],
        primaryName: "甲",
      }),
    ).toEqual({ bookingId: BOOKING_ID, assistantNames: ["乙"], primaryName: "甲" });
  });

  it("編輯表單:拿掉一位又加一位(換人)⇒ 不跳", () => {
    expect(
      assistantRemovedInfoAfterEdit({
        bookingId: BOOKING_ID,
        originalAssistants: [{ staffId: "b", staffName: "乙" }],
        nextAssistantStaffIds: ["d"],
        primaryName: "甲",
      }),
    ).toBeNull();
  });

  it("編輯表單:助手沒變 / 只有加人 ⇒ 不跳", () => {
    const base = {
      bookingId: BOOKING_ID,
      originalAssistants: [{ staffId: "b", staffName: "乙" }],
      primaryName: "甲",
    };
    expect(assistantRemovedInfoAfterEdit({ ...base, nextAssistantStaffIds: ["b"] })).toBeNull();
    expect(
      assistantRemovedInfoAfterEdit({ ...base, nextAssistantStaffIds: ["b", "c"] }),
    ).toBeNull();
  });
});

// ===========================================================================
describe("擋流程二選一提示(使用者裁決:須選一個才能繼續)", () => {
  function renderPrompt() {
    const onKeep = vi.fn();
    const onAddAnother = vi.fn();
    render(<AssistantRemovedPrompt info={INFO} onKeep={onKeep} onAddAnother={onAddAnother} />);
    return { onKeep, onAddAnother };
  }

  it("顯示標題、文案、兩顆按鈕,沒有 ✕", () => {
    renderPrompt();
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("已移除協助人員")).toBeInTheDocument();
    expect(within(dialog).getByText(buildAssistantRemovedMessage(INFO))).toBeInTheDocument();
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["維持現狀", "再加助手"]);
  });

  it("按 Esc 關不掉", () => {
    const { onKeep, onAddAnother } = renderPrompt();
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onKeep).not.toHaveBeenCalled();
    expect(onAddAnother).not.toHaveBeenCalled();
  });

  it("點背景關不掉", () => {
    const { onKeep } = renderPrompt();
    const overlay = document.querySelector("[data-state='open']:not([role='alertdialog'])");
    expect(overlay).not.toBeNull();
    fireEvent.pointerDown(overlay!);
    fireEvent.mouseDown(overlay!);
    fireEvent.click(overlay!);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(onKeep).not.toHaveBeenCalled();
  });

  it("「維持現狀」只呼叫 onKeep", () => {
    const { onKeep, onAddAnother } = renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "維持現狀" }));
    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onAddAnother).not.toHaveBeenCalled();
  });

  it("「再加助手」帶這張單的 id 呼叫 onAddAnother", () => {
    const { onKeep, onAddAnother } = renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "再加助手" }));
    expect(onAddAnother).toHaveBeenCalledWith(BOOKING_ID);
    expect(onKeep).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 行事曆那一段的接線(CalendarPage:詳情 → 移除 → 關掉詳情 → 二選一提示 → 維持現狀 / 再加助手)。
// 用一個跟 CalendarPage 同樣接法的小 harness,只差 openEditForm 換成 spy。
function CalendarLikeHarness({
  openedAsAssistantStaffId,
  onOpenEditForm,
}: {
  openedAsAssistantStaffId: string | null;
  onOpenEditForm: (id: string, options?: { focusAssistants?: boolean }) => void;
}) {
  const [open, setOpen] = useState(true);
  const [removed, setRemoved] = useState<AssistantRemovedInfo | null>(null);
  return (
    <>
      <BookingDetailDialog
        bookingId={BOOKING_ID}
        staffNameById={STAFF_NAMES}
        open={open}
        onOpenChange={setOpen}
        onChanged={vi.fn()}
        onEdit={(id) => onOpenEditForm(id)}
        openedAsAssistantStaffId={openedAsAssistantStaffId}
        onAssistantRemoved={setRemoved}
      />
      <AssistantRemovedPrompt
        info={removed}
        onKeep={() => setRemoved(null)}
        onAddAnother={(id) => {
          setRemoved(null);
          onOpenEditForm(id, { focusAssistants: true });
        }}
      />
    </>
  );
}

function renderHarness(openedAsAssistantStaffId: string | null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenEditForm = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CalendarLikeHarness
          openedAsAssistantStaffId={openedAsAssistantStaffId}
          onOpenEditForm={onOpenEditForm}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenEditForm };
}

async function removeViaDetail() {
  fireEvent.click(await screen.findByRole("button", { name: "移除協助人員" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(within(confirm).getByText(/確定要把 協助人員乙 從這張訂單移除嗎/)).toBeInTheDocument();
  fireEvent.click(within(confirm).getByRole("button", { name: "確定移除" }));
  return screen.findByTestId("assistant-removed-prompt");
}

describe("預約詳情:從「(協助)」色塊打開", () => {
  it("底部是「移除協助人員」,沒有「取消預約」,並有常駐 `!` 說明去哪裡取消整張單", async () => {
    renderHarness("staff-help");
    expect(await screen.findByRole("button", { name: "移除協助人員" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "取消預約" })).toBeNull();
    expect(screen.getByTestId("opened-as-assistant-note")).toHaveTextContent(
      "要取消整張訂單，請點主服務人員 主服務人員甲 的卡片",
    );
  });

  it("確定移除 → 只呼叫 removeBookingAssistant(這張單 + 這位),不呼叫 cancelBooking;詳情關掉、跳二選一", async () => {
    renderHarness("staff-help");
    const prompt = await removeViaDetail();
    expect(mocks.removeBookingAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.removeBookingAssistant).toHaveBeenCalledWith(BOOKING_ID, "staff-help");
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    expect(within(prompt).getByText(buildAssistantRemovedMessage(INFO))).toBeInTheDocument();
    // 詳情(全頁層)已經關掉:畫面上只剩提示這一層。
    await waitFor(() => expect(screen.queryByText("預約詳情")).toBeNull());
  });

  it("「維持現狀」:提示關掉,不呼叫取消、不再呼叫任何移除 / 還原,也不開編輯表單", async () => {
    const { onOpenEditForm } = renderHarness("staff-help");
    await removeViaDetail();
    fireEvent.click(screen.getByRole("button", { name: "維持現狀" }));
    await waitFor(() => expect(screen.queryByTestId("assistant-removed-prompt")).toBeNull());
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
    expect(mocks.removeBookingAssistant).toHaveBeenCalledTimes(1);
    expect(onOpenEditForm).not.toHaveBeenCalled();
  });

  it("「再加助手」:打開這張單的編輯表單並要求捲到助手欄位", async () => {
    const { onOpenEditForm } = renderHarness("staff-help");
    await removeViaDetail();
    fireEvent.click(screen.getByRole("button", { name: "再加助手" }));
    expect(onOpenEditForm).toHaveBeenCalledWith(BOOKING_ID, { focusAssistants: true });
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });

  it("提示出現後按 Esc 關不掉", async () => {
    renderHarness("staff-help");
    const prompt = await removeViaDetail();
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.getByTestId("assistant-removed-prompt")).toBeInTheDocument();
  });

  it("移除失敗(40001 畫面過期)→ 紅字 toast、不跳提示", async () => {
    mocks.removeBookingAssistant.mockReset().mockRejectedValue({
      code: "40001",
      message: "這位協助人員已經不在這筆預約上,畫面已重新整理",
    });
    renderHarness("staff-help");
    fireEvent.click(await screen.findByRole("button", { name: "移除協助人員" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "確定移除" }),
    );
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(screen.queryByTestId("assistant-removed-prompt")).toBeNull();
    expect(mocks.cancelBooking).not.toHaveBeenCalled();
  });
});

describe("預約詳情:從主服務人員色塊 / 訂單管理打開(不傳 openedAsAssistantStaffId)", () => {
  it("維持原樣:有「取消預約」,沒有「移除協助人員」", async () => {
    renderHarness(null);
    expect(await screen.findByRole("button", { name: "取消預約" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "移除協助人員" })).toBeNull();
    expect(screen.queryByTestId("opened-as-assistant-note")).toBeNull();
  });
});
