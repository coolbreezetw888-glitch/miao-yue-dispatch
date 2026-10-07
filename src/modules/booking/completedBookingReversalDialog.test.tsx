// #844 批次 4:預約詳情裡的「還原完成 / 取消訂單」整合測試(規格書 §五 5.1~5.4、§3.7、§3.11、§4.8)。
// 把 BookingDetailDialog 真的 render 起來,api 全部 mock,驗:
//   1. 按鈕顯示條件(只有商家管理員 + 已完成 + 看的是原本那張單;客服看到常駐 `!`)
//   2. 原因必填(空白 / 全形空白不能送)、送出的是去頭尾後的原因
//   3. 跨月紅色警告、warnings、預計差額、匯入單不能還原
//   4. 取消通知預設關;notify 參數照開關送
//   5. 成功後重抓(points-ledger 等)並關閉;差額 > 0 先跳小卡窗、shortfall_hint 純文字顯示
//   6. 「狀態已經改變」⇒ 提示重新整理、回到預約詳情並重抓
//   7. §4.8 / 批次 3 QA 觀察 ①:不是待確認就查紅利分類帳(派點 0 也查)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBooking: vi.fn(),
  getBookingPointsLedger: vi.fn(),
  fetchCompletedBookingReversalPreview: vi.fn(),
  revertCompletedBooking: vi.fn(),
  cancelCompletedBooking: vi.fn(),
  role: { current: "admin" as string | null | undefined },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("./api", () => ({
  getBooking: mocks.getBooking,
  getBookingPointsLedger: mocks.getBookingPointsLedger,
  fetchCompletedBookingReversalPreview: mocks.fetchCompletedBookingReversalPreview,
  revertCompletedBooking: mocks.revertCompletedBooking,
  cancelCompletedBooking: mocks.cancelCompletedBooking,
  cancelBooking: vi.fn(),
  completeBooking: vi.fn(),
  confirmBooking: vi.fn(),
  getCustomerRelatedBookings: vi.fn(async () => []),
}));

vi.mock("./context", () => ({
  useBookingStatusChangeLogs: () => ({ data: [], isLoading: false }),
}));

// #996 第 11 批 K:管理員看已完成訂單時多了「服務人員抽成」區塊;這裡不測它,mock 掉避免真的打 RPC
// (區塊本身的測試在 bookingDetailCommission.test.tsx)。
vi.mock("@/modules/payroll/api", () => ({
  fetchBookingCommissionSummary: vi.fn(async () => ({
    has_record: false,
    commission_amount: null,
    computed_at: null,
    recalculated_at: null,
    staff_name: null,
    staff_is_piece_rate: null,
  })),
  recalculateBookingCommission: vi.fn(),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({
    merchant: { id: "merchant-1", name: "測試商家", industry_type: "in_store_beauty" },
    isLoading: false,
  }),
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: mocks.role.current, isLoading: false }),
  useAgentPermission: () => ({ data: mocks.role.current === "admin" ? null : false }),
}));

vi.mock("@/modules/line-notifications/api", () => ({
  dispatchLineNotification: vi.fn(),
  usePendingLineNotificationPreview: () => ({ refetch: vi.fn() }),
}));

vi.mock("@/modules/line-notifications/ConfirmBookingLineDialog", () => ({
  ConfirmBookingLineDialog: () => null,
}));

import { BookingDetailDialog } from "./BookingDetailDialog";
import type { CompletedBookingReversalPreview } from "./types";

const BOOKING_ID = "booking-1";
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

function booking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    merchant_id: "merchant-1",
    staff_id: "staff-1",
    status: "completed",
    start_at: "2026-09-30T06:00:00Z",
    end_at: "2026-09-30T07:00:00Z",
    custom_duration_enabled: false,
    custom_duration_minutes: null,
    assistants: [],
    createdByName: "客服甲",
    lastModifiedByName: null,
    last_modified_at: null,
    created_at: "2026-09-29T06:00:00Z",
    serviceItems: [{ id: "i-1", name: "清洗", quantity: 1, lineTotal: 1500 }],
    subtotal_amount_snapshot: 1500,
    custom_total_amount_enabled: false,
    discount_enabled: false,
    tax_enabled: false,
    final_amount_snapshot: 1500,
    payment_method_name_snapshot: "現金",
    materialCosts: [],
    customer_name: "王小美",
    customer_phone: "0912345678",
    customer_address: null,
    customer_notes: null,
    notes: null,
    hide_notes_from_staff: false,
    member_id: "m-1",
    member_name_snapshot: "王小美",
    points_planned: 50,
    points_planned_overridden: false,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
    ...overrides,
  };
}

function preview(
  overrides: Partial<CompletedBookingReversalPreview> = {},
): CompletedBookingReversalPreview {
  return {
    booking_id: BOOKING_ID,
    status: "completed",
    source: "manual",
    can_revert: true,
    can_cancel: true,
    blocked_reasons: [],
    staff: {
      id: "staff-1",
      name: "服務人員甲",
      status: "removed",
      compensation_type_now: "piece_rate",
    },
    commission: {
      exists: true,
      amount: "300.00",
      recalculated: false,
      computed_at: "2026-09-30T06:00:00Z",
    },
    completed_at: "2026-09-30T06:00:00Z",
    report_month: "2026-09",
    is_cross_month: true,
    months_ago: 1,
    revenue_amount: "1500.00",
    member: { id: "m-1", name: "王小美", status: "active", balance: 10 },
    points: {
      members: [
        {
          member_id: "m-1",
          name: "王小美",
          status: "active",
          balance: 10,
          due_expected: 50,
          frozen_refund_expected: 0,
          shortfall_if_revert: 40,
          shortfall_if_cancel: 40,
        },
      ],
      points_due_expected: 50,
      frozen_points: 0,
      referral: null,
    },
    warnings: [
      {
        code: "staff_removed",
        message:
          "服務人員「服務人員甲」已經移除。還原後這張單無法編輯或改時間，只能重新完成或取消。",
      },
    ],
    ...overrides,
  };
}

function result(action: "revert" | "cancel", shortfall = 0, hint: string | null = null) {
  return {
    booking: {
      id: BOOKING_ID,
      merchant_id: "merchant-1",
      status: action === "revert" ? "accepted" : "cancelled",
    },
    action: action === "revert" ? "revert_to_accepted" : "cancel_completed",
    commission_amount_reversed: "300.00",
    report_month: "2026-09",
    is_cross_month: true,
    points: {
      points_due: 50,
      points_recovered: 50 - shortfall,
      points_shortfall: shortfall,
      referral_due: 0,
      referral_recovered: 0,
      referral_shortfall: 0,
      referrer_member_id: null,
      shortfall_hint: hint,
      frozen_points_refunded: 0,
    },
  };
}

let queryClient: QueryClient;
let onOpenChange: ReturnType<typeof vi.fn>;
let onChanged: ReturnType<typeof vi.fn>;

function renderDialog() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  onOpenChange = vi.fn();
  onChanged = vi.fn();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <BookingDetailDialog
          bookingId={BOOKING_ID}
          staffNameById={new Map([["staff-1", "服務人員甲"]])}
          open
          onOpenChange={onOpenChange}
          onChanged={onChanged}
          onEdit={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openReversal(label: "還原完成" | "取消訂單") {
  fireEvent.click(await screen.findByRole("button", { name: label }));
  // 預覽載入完成 = 說明的黃色 `!` 出現
  await screen.findByTestId("reversal-explanation");
}

function reasonBox() {
  return screen.getByLabelText(/原因/) as HTMLTextAreaElement;
}

beforeEach(() => {
  mocks.role.current = "admin";
  mocks.getBooking.mockReset().mockResolvedValue(booking());
  mocks.getBookingPointsLedger
    .mockReset()
    .mockResolvedValue({ earnedPoints: 50, reversedPoints: 0, effectivePoints: 50 });
  mocks.fetchCompletedBookingReversalPreview.mockReset().mockResolvedValue(preview());
  mocks.revertCompletedBooking.mockReset().mockResolvedValue(result("revert"));
  mocks.cancelCompletedBooking.mockReset().mockResolvedValue(result("cancel"));
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
});

afterEach(() => cleanup());

describe("§5.1 按鈕顯示條件", () => {
  it("商家管理員 + 已完成:兩顆等寬按鈕「取消訂單」(危險)「還原完成」(次要),沒有客服提示", async () => {
    renderDialog();
    const cancel = await screen.findByRole("button", { name: "取消訂單" });
    const revert = screen.getByRole("button", { name: "還原完成" });
    expect(cancel.className).toMatch(/destructive/);
    expect(revert.className).not.toMatch(/bg-brand/);
    expect(screen.queryByTestId("agent-cannot-reverse-note")).toBeNull();
  });

  it("客服(非管理員)+ 已完成:沒有按鈕,有常駐 `!`", async () => {
    mocks.role.current = "agent";
    renderDialog();
    const note = await screen.findByTestId("agent-cannot-reverse-note");
    expect(note.textContent).toContain("只有商家管理員可以還原或取消");
    expect(screen.queryByRole("button", { name: "取消訂單" })).toBeNull();
    expect(screen.queryByRole("button", { name: "還原完成" })).toBeNull();
  });

  it("角色還在讀取(undefined):按鈕與提示都不顯示(不閃一下錯的東西)", async () => {
    mocks.role.current = undefined;
    renderDialog();
    await screen.findByText("王小美", { selector: "p" });
    expect(screen.queryByRole("button", { name: "還原完成" })).toBeNull();
    expect(screen.queryByTestId("agent-cannot-reverse-note")).toBeNull();
  });

  it("已確認的單:管理員也看不到這兩顆(只有既有的取消預約 / 編輯 / 標記完成)", async () => {
    mocks.getBooking.mockResolvedValue(booking({ status: "accepted" }));
    renderDialog();
    await screen.findByRole("button", { name: "標記完成" });
    expect(screen.queryByRole("button", { name: "還原完成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消訂單" })).toBeNull();
  });
});

describe("§5.2 / §5.3 確認子畫面", () => {
  it("跨月紅色警告在最上面、warnings 與預計差額都顯示;按鈕文字「我了解影響,確定還原」", async () => {
    renderDialog();
    await openReversal("還原完成");
    const cross = screen.getByTestId("reversal-cross-month");
    expect(cross.textContent).toContain("這張單是 2026 年 9 月 完成的，已經是 1 個月前");
    // 跨月是 DOM 裡第一塊 `!`
    const notes = screen.getAllByRole("note");
    expect(notes[0]).toBe(cross);
    expect(screen.getByTestId("reversal-warning-staff_removed").textContent).toContain("已經移除");
    expect(screen.getByTestId("reversal-expected-shortfall").textContent).toContain(
      "預計有 40 點收不回來",
    );
    expect(screen.getByRole("button", { name: "我了解影響，確定還原" })).toBeTruthy();
    // 還原路徑沒有通知開關(§3.7 一律不發)
    expect(screen.queryByText(/同時發送取消通知/)).toBeNull();
  });

  it("同月:沒有紅色警告,按鈕是「確定還原」", async () => {
    mocks.fetchCompletedBookingReversalPreview.mockResolvedValue(
      preview({ is_cross_month: false, months_ago: 0 }),
    );
    renderDialog();
    await openReversal("還原完成");
    expect(screen.queryByTestId("reversal-cross-month")).toBeNull();
    expect(screen.getByRole("button", { name: "確定還原" })).toBeTruthy();
  });

  it("原因空白 / 只有全形空白 ⇒ 確定鈕 disabled + 黃色 `!`「請先填寫原因」;填了才可以按", async () => {
    renderDialog();
    await openReversal("還原完成");
    const confirm = screen.getByRole("button", {
      name: "我了解影響，確定還原",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByTestId("reversal-confirm-disabled-reason").textContent).toContain(
      "請先填寫原因",
    );

    fireEvent.change(reasonBox(), { target: { value: `${IDEOGRAPHIC_SPACE}\n ` } });
    expect(confirm.disabled).toBe(true);

    fireEvent.change(reasonBox(), { target: { value: "  誤按完成\n" } });
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByTestId("reversal-confirm-disabled-reason")).toBeNull();
  });

  it("超過 500 字 ⇒ 不能送,字數顯示紅色", async () => {
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "字".repeat(501) } });
    expect(
      (screen.getByRole("button", { name: "我了解影響，確定還原" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("501 / 500")).toBeTruthy();
  });

  it("§3.13 匯入單:還原的確定鈕灰掉並說明原因(填了原因也一樣)", async () => {
    mocks.fetchCompletedBookingReversalPreview.mockResolvedValue(
      preview({
        source: "import",
        can_revert: false,
        blocked_reasons: [
          {
            code: "import_cannot_revert",
            message: "匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入。",
          },
        ],
      }),
    );
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "匯錯了" } });
    expect(
      (screen.getByRole("button", { name: "我了解影響，確定還原" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("reversal-blocked-import_cannot_revert")).toBeTruthy();
    expect(screen.getByTestId("reversal-confirm-disabled-reason").textContent).toContain(
      "匯入的歷史訂單不能還原",
    );
  });

  it("商家輸入的姓名當純文字顯示(不解析 HTML)", async () => {
    const base = preview();
    mocks.fetchCompletedBookingReversalPreview.mockResolvedValue(
      preview({
        points: {
          ...base.points!,
          members: [{ ...base.points!.members[0]!, name: "<img src=x onerror=alert(1)>" }],
        },
      }),
    );
    const { container } = renderDialog();
    await openReversal("還原完成");
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> 預計收回 50 點/)).toBeTruthy();
    expect(container.ownerDocument.querySelector("img[src='x']")).toBeNull();
  });

  it("預覽失敗:ErrorState(什麼壞了 + 你的資料沒有遺失),可以重試", async () => {
    mocks.fetchCompletedBookingReversalPreview.mockRejectedValueOnce({ message: "網路錯誤" });
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "還原完成" }));
    expect(await screen.findByText("讀不到這次會連帶影響的內容")).toBeTruthy();
    expect(screen.getByText(/你的資料沒有遺失/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重試" }));
    await screen.findByTestId("reversal-explanation");
  });
});

describe("§5.4 送出與成功後", () => {
  it("還原成功:送去頭尾後的原因、toast、關閉全頁層、重抓 points-ledger 等查詢", async () => {
    renderDialog();
    await openReversal("還原完成");
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.change(reasonBox(), { target: { value: `${IDEOGRAPHIC_SPACE} 誤按完成 \n` } });
    fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定還原" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.revertCompletedBooking).toHaveBeenCalledWith(BOOKING_ID, "誤按完成");
    expect(mocks.cancelCompletedBooking).not.toHaveBeenCalled();
    expect(mocks.toast.success).toHaveBeenCalledWith("已還原為已確認");
    // #963:onOpenChange(false) 是 finishReversal 裡同步呼叫的,onChanged 則要等 React 重新渲染後的
    // effect(pendingChangedNotify)才呼叫;這段在 act 之外由 React 排程器跑,先後不固定 ⇒ 要用 waitFor 等。
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const keys = invalidateSpy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["booking-module", "points-ledger", BOOKING_ID]));
    expect(keys).toContain(JSON.stringify(["members-module", "related-bookings"]));
    expect(keys).toContain(
      JSON.stringify(["booking-module", "booking-status-change-logs", BOOKING_ID]),
    );
    expect(keys).toContain(JSON.stringify(["payroll-module"]));
  });

  it("取消:通知開關預設關 ⇒ notify:false;打開 ⇒ notify:true", async () => {
    renderDialog();
    await openReversal("取消訂單");
    const sw = screen.getByRole("switch");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.change(reasonBox(), { target: { value: "客人要求作廢" } });
    fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定取消" }));
    await waitFor(() =>
      expect(mocks.cancelCompletedBooking).toHaveBeenCalledWith(BOOKING_ID, "客人要求作廢", {
        notify: false,
      }),
    );
    expect(mocks.toast.success).toHaveBeenCalledWith("已取消訂單");

    cleanup();
    renderDialog();
    await openReversal("取消訂單");
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(reasonBox(), { target: { value: "客人要求作廢" } });
    fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定取消" }));
    await waitFor(() =>
      expect(mocks.cancelCompletedBooking).toHaveBeenLastCalledWith(BOOKING_ID, "客人要求作廢", {
        notify: true,
      }),
    );
  });

  it("取消路徑的常駐說明同時講「抽成與報表會更新」與「退款要另外處理」", async () => {
    renderDialog();
    await openReversal("取消訂單");
    const text = screen.getByTestId("reversal-explanation").textContent ?? "";
    expect(text).toContain("抽成");
    expect(text).toContain("報表");
    expect(text).toContain("退款");
  });

  it("差額 > 0:先跳小卡窗(標題 + shortfall_hint 原文純文字),按「知道了」才關全頁層並重抓", async () => {
    const hint =
      "應收回 50 點，會員目前只有 10 點，已收回 10 點，差額 40 點未收回。這 40 點是在訂單「2026/10/01 10:00 <b>李客人</b>」折抵掉的。";
    mocks.revertCompletedBooking.mockResolvedValue(result("revert", 40, hint));
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "誤按" } });
    fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定還原" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("有 40 點未能收回")).toBeTruthy();
    expect(within(dialog).getByTestId("reversal-shortfall-hint").textContent).toBe(hint);
    expect(dialog.querySelector("b")).toBeNull();
    expect(dialog.querySelector("a")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "知道了" }));
    });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  async function openShortfallDialog() {
    mocks.revertCompletedBooking.mockResolvedValue(
      result("revert", 40, "應收回 50 點，差額 40 點未收回。"),
    );
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "誤按" } });
    // #963(偶發逾時的根因,2026-10-01 實測重現):小卡窗疊上來時,Radix 的 DismissableLayer 會在 effect 裡
    // 登記新圖層,再發一個事件讓「每一層」重新渲染,重新算誰是最上層、誰才掛 Esc 監聽。這輪重新渲染如果發生在
    // act 之外,就由 React 排程器稍後才跑 ⇒ 中間有一小段空窗:小卡窗已經出現、焦點也在「知道了」,但 Esc
    // 監聽還掛在**下面的全頁層**。這時按 Esc,關掉的是全頁層(onOpenChange(false))而不是小卡窗,
    // finishReversal 不會跑、onChanged 永遠不會被呼叫 ⇒ 原本等 onChanged 的 waitFor(5000) 等到整條測試逾時。
    // 電腦忙時才會撞到(壓力下 250 次約 1~3 次)。
    // 治本:把「送出 → 小卡窗疊上來 → 圖層重新排好」整段包在 act 裡,act 結束前 React 會把這些更新與 effect
    // 全部跑完,按 Esc 時圖層一定已經排好;不需要長時間等待。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定還原" }));
    });
    return screen.getByRole("alertdialog");
  }

  it("QA 打回 1:差額小卡窗開窗後焦點在「知道了」(不是 body),按 Enter 就關", async () => {
    const user = userEvent.setup();
    const dialog = await openShortfallDialog();
    const ack = within(dialog).getByRole("button", { name: "知道了" });
    await waitFor(() => expect(document.activeElement).toBe(ack));
    expect(document.activeElement).not.toBe(document.body);
    await user.keyboard("{Enter}");
    // user-event 的每個事件都包在 act 裡(RTL 的設定),關窗、finishReversal、effect 裡的 onChanged
    // 都會在 keyboard 結束前跑完 ⇒ 不需要等待,直接斷言;壞掉會立刻紅,不會等到逾時。
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("QA 打回 2:按 Esc 也會關(等同「知道了」:關全頁層並重抓一次)", async () => {
    const user = userEvent.setup();
    await openShortfallDialog();
    await user.keyboard("{Escape}");
    // 同上:直接斷言。關掉的必須是小卡窗(走 finishReversal ⇒ onChanged 一次),小卡窗也要真的不見。
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  // 第 11 批 J(#995 J-14 L2):還原 / 取消子畫面原因欄有字 ⇒ Esc 先問放棄;沒字 ⇒ 直接關。
  it("第 11 批 J:原因欄有字 ⇒ Esc 先問「確定放棄這次輸入？」;清空 ⇒ Esc 直接關", async () => {
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "誤按" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(await screen.findByText("確定放棄這次輸入？")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "繼續編輯" }));
    await waitFor(() => expect(screen.queryByText("確定放棄這次輸入？")).toBeNull());
    fireEvent.change(reasonBox(), { target: { value: "  " } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("第 11 批 J × #965:送出成功跳差額小卡窗時原因已存進去 ⇒ 不再算填過(全頁層的關閉走 finishReversal)", async () => {
    // #965 的競態(Esc 在小卡窗剛插入時落到下面的全頁層)jsdom 重現不了;改用「直接觸發全頁層的上方空白條」
    // 走同一條 Esc 路徑:假裝面板上方有 200px,空白條才會畫出來。
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top: 200,
          left: 100,
          width: 400,
          height: 300,
          right: 500,
          bottom: 500,
          x: 100,
          y: 200,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    try {
      await openShortfallDialog();
      const layerStrip = document.querySelector<HTMLElement>("[data-overlay-dismiss-strip]");
      expect(layerStrip).not.toBeNull();
      await act(async () => {
        fireEvent.click(layerStrip!);
      });
      expect(screen.queryByText("確定放棄這次輸入？")).toBeNull();
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    } finally {
      rect.mockRestore();
    }
  });

  it("QA 打回 3:成功後不會再多打一次預覽(onChanged 等子畫面關掉之後才呼叫)", async () => {
    renderDialog();
    await openReversal("還原完成");
    expect(mocks.fetchCompletedBookingReversalPreview).toHaveBeenCalledTimes(1);
    // 模擬呼叫端(OrdersPage refetchAll)讓 ["booking-module"] 整組過期,而且不排除預覽
    onChanged.mockImplementation(() => {
      void queryClient.invalidateQueries({ queryKey: ["booking-module"] });
    });
    fireEvent.change(reasonBox(), { target: { value: "誤按" } });
    // #963:原本是 waitFor(5000) + 固定等 50ms。改成整段送出包在 act 裡:act 結束前,送出 → 關子畫面 →
    // effect 呼叫 onChanged → invalidate 觸發的重抓(如果有)全部已經發生,不用猜要等多久。
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定還原" }));
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(mocks.fetchCompletedBookingReversalPreview).toHaveBeenCalledTimes(1);
  });

  it("QA 打回 4:規格標粗的字有加粗(字面不變)", async () => {
    renderDialog();
    await openReversal("取消訂單");
    const explanation = screen.getByTestId("reversal-explanation");
    const bold = Array.from(explanation.querySelectorAll("strong")).map((b) => b.textContent);
    expect(bold).toEqual(["無法再復原", "但實際退款要另外處理"]);
    const cross = screen.getByTestId("reversal-cross-month");
    expect(Array.from(cross.querySelectorAll("strong")).map((b) => b.textContent)).toContain(
      "可能已經結算發放",
    );
  });

  it("「狀態已經改變」:提示重新整理、回到預約詳情並重抓", async () => {
    mocks.revertCompletedBooking.mockRejectedValue({
      message: "這筆訂單的狀態已經改變，請重新整理後再試",
    });
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "誤按" } });
    fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定還原" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(mocks.toast.error.mock.calls[0]?.[1]?.description).toContain("重新整理");
    // #963:同上,onChanged 在重新渲染後的 effect 才呼叫,要用 waitFor 等。
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // 回到預約詳情(子畫面關掉、全頁層沒關)
    await waitFor(() => expect(screen.queryByTestId("reversal-explanation")).toBeNull());
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("其他失敗:toast 帶後端原因,停在確認畫面、原因保留", async () => {
    mocks.revertCompletedBooking.mockRejectedValue({ message: "原因最多 500 個字" });
    renderDialog();
    await openReversal("還原完成");
    fireEvent.change(reasonBox(), { target: { value: "誤按" } });
    fireEvent.click(screen.getByRole("button", { name: "我了解影響，確定還原" }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith("操作失敗", {
        description: "原因最多 500 個字",
      }),
    );
    expect(screen.getByTestId("reversal-explanation")).toBeTruthy();
    expect(reasonBox().value).toBe("誤按");
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("§4.8 / 批次 3 QA 觀察 ①:紅利分類帳查詢條件", () => {
  it("還原後改單把派點改成 0 的已確認單:仍查分類帳,看得到舊的已收回 / 差額", async () => {
    mocks.getBooking.mockResolvedValue(booking({ status: "accepted", points_planned: 0 }));
    mocks.getBookingPointsLedger.mockResolvedValue({
      earnedPoints: 50,
      reversedPoints: 10,
      effectivePoints: 40,
    });
    renderDialog();
    expect(await screen.findByText("已收回 10 點，差額 40 點未收回")).toBeTruthy();
    expect(mocks.getBookingPointsLedger).toHaveBeenCalledWith(BOOKING_ID);
  });

  it("待確認的單:不查分類帳(一定還沒完成過)", async () => {
    mocks.getBooking.mockResolvedValue(
      booking({ status: "pending_confirmation", points_planned: 0 }),
    );
    renderDialog();
    await screen.findByRole("button", { name: "確認訂單" });
    expect(mocks.getBookingPointsLedger).not.toHaveBeenCalled();
  });
});
