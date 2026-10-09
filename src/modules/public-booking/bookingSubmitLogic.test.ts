// 客戶端第 3 批:送出結果解析、失敗畫面對照、完成頁格式(C3-A05 / C3-D05 / C3-D06,零之零)。
import { describe, expect, it } from "vitest";

import {
  completionKind,
  DEFAULT_GUEST_COMPLETION_MESSAGE,
  DEFAULT_MEMBER_COMPLETION_MESSAGE,
  externalBrowserUrl,
  formatSubmittedItems,
  formatSubmittedStart,
  isLineInAppBrowser,
  newSubmissionId,
  parseSubmitResponse,
  SUBMIT_INVALID_HINTS,
  SUBMIT_REJECT_STATES,
  submitFailureView,
  toSubmitInvalidHint,
} from "./bookingSubmitLogic";

const created = (booking: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  state: "created",
  booking: {
    status: "pending_confirmation",
    start_at: "2026-10-13T02:00:00Z",
    end_at: "2026-10-13T04:00:00Z",
    staff_display: "阿明",
    items: [
      { name: "室內機清洗", quantity: 2 },
      { name: "室外機清洗", quantity: 1 },
    ],
    address: "台北市信義區松仁路 58 號",
    estimated_amount: 6200,
    is_guest: false,
    ...booking,
  },
  // c3-contract 1-2:completion_message 在最外層。
  completion_message: "我們會盡快確認。",
  ...extra,
});

describe("parseSubmitResponse(C3-A05)", () => {
  it("created:白名單欄位、會員不帶電話、完成頁文字", () => {
    const r = parseSubmitResponse(
      created({ phone: "0912345678", member_id: "SENTINEL", staff_id: "SENTINEL" }),
    );
    expect(r).toEqual({
      kind: "created",
      booking: {
        status: "pending_confirmation",
        startAt: "2026-10-13T02:00:00Z",
        endAt: "2026-10-13T04:00:00Z",
        staffDisplay: "阿明",
        items: [
          { name: "室內機清洗", quantity: 2 },
          { name: "室外機清洗", quantity: 1 },
        ],
        address: "台北市信義區松仁路 58 號",
        phone: null,
        estimatedAmount: 6200,
        isGuest: false,
        completionMessage: "我們會盡快確認。",
      },
    });
    expect(JSON.stringify(r)).not.toContain("SENTINEL");
  });

  it("訪客:帶電話;completion_message 沒給 ⇒ 保底預設句(會員待確認 / 會員已成立 / 訪客各自)", () => {
    const guest = parseSubmitResponse(
      created({ is_guest: true, phone: "0912-345-678" }, { completion_message: null }),
    );
    expect(guest?.kind === "created" && guest.booking.phone).toBe("0912-345-678");
    expect(guest?.kind === "created" && guest.booking.completionMessage).toBe(
      DEFAULT_GUEST_COMPLETION_MESSAGE,
    );
    const member = parseSubmitResponse(created({}, { completion_message: "   " }));
    expect(member?.kind === "created" && member.booking.completionMessage).toBe(
      DEFAULT_MEMBER_COMPLETION_MESSAGE,
    );
    const accepted = parseSubmitResponse(
      created({ status: "accepted" }, { completion_message: undefined }),
    );
    expect(accepted?.kind === "created" && accepted.booking.completionMessage).toBe(
      "服務前店家可能會再跟您聯絡確認。",
    );
  });

  it("只讀最外層的 completion_message(booking 裡的不算)", () => {
    const r = parseSubmitResponse(
      created({ completion_message: "裡面" }, { completion_message: "外層文字" }),
    );
    expect(r?.kind === "created" && r.booking.completionMessage).toBe("外層文字");
  });

  it("每一種業務 state 都轉成 rejected", () => {
    for (const state of SUBMIT_REJECT_STATES) {
      expect(parseSubmitResponse({ state })).toEqual({ kind: "rejected", state });
    }
  });

  it("看不懂的回應 ⇒ null", () => {
    expect(parseSubmitResponse(null)).toBeNull();
    expect(parseSubmitResponse({ state: "weird" })).toBeNull();
    expect(parseSubmitResponse({ state: "created" })).toBeNull();
    expect(parseSubmitResponse(created({ status: "completed" }))).toBeNull();
    expect(parseSubmitResponse(created({ start_at: "not a date" }))).toBeNull();
  });
});

describe("submitFailureView(C3-D05)", () => {
  const ctx = { lineLoginEnabled: true };
  it("逐字對照", () => {
    expect(submitFailureView("slot_taken", ctx).message).toBe(
      "這個時段剛剛被約走了，請重新選一個時間。",
    );
    expect(submitFailureView("too_many_open", ctx)).toMatchObject({
      message: "您目前已有 3 筆尚未完成的預約，請等服務完成後再預約，或直接聯絡店家。",
      showContacts: true,
    });
    expect(submitFailureView("contact_store", ctx)).toMatchObject({
      message: "這支電話需要店家協助處理，請直接聯絡店家。",
      showContacts: true,
    });
    expect(submitFailureView("bot_check_failed", ctx)).toMatchObject({
      message: "安全檢查沒有通過，請重新整理後再試一次。",
      showContacts: true,
    });
    expect(submitFailureView("unavailable", ctx).message).toContain("這間店目前暫停線上預約");
    expect(submitFailureView("rate_limited", ctx).message).toBe("操作太頻繁，請稍後再試。");
    expect(submitFailureView("network", ctx).message).toBe(
      "送出時發生問題，請稍後再試。您填的資料沒有遺失。",
    );
  });

  it("不開放不登入:有 LINE 登入 ⇒ LINE 登入按鈕;沒有 ⇒ 聯絡按鈕", () => {
    for (const code of ["guest_not_allowed", "guest_unavailable"] as const) {
      expect(submitFailureView(code, { lineLoginEnabled: true })).toMatchObject({
        message: "這家店目前不開放不登入預約。",
        showLineLogin: true,
        showContacts: false,
      });
      expect(submitFailureView(code, { lineLoginEnabled: false })).toMatchObject({
        showLineLogin: false,
        showContacts: true,
      });
    }
  });

  it("c3-contract 1-4:400 的 hint 依代碼顯示對應句子", () => {
    expect(submitFailureView("invalid_phone", ctx).message).toContain("請填 0 開頭的電話");
    expect(submitFailureView("policy_not_agreed", ctx).message).toBe(
      "請先勾選同意，才能送出預約。",
    );
    expect(submitFailureView("address_required", ctx).message).toBe(
      "到府服務要填服務地址，請回上一步填寫。",
    );
    expect(submitFailureView("duration_too_long", ctx)).toMatchObject({ showContacts: true });
    expect(submitFailureView("invalid_request", ctx).message).toBe(
      "送出時發生問題，請稍後再試。您填的資料沒有遺失。",
    );
    expect(toSubmitInvalidHint("no_primary_item")).toBe("no_primary_item");
    expect(toSubmitInvalidHint("weird")).toBe("invalid_request");
    expect(toSubmitInvalidHint(null)).toBe("invalid_request");
  });

  it("句子全形標點、不含英文代碼", () => {
    const codes = [
      ...SUBMIT_REJECT_STATES,
      ...SUBMIT_INVALID_HINTS,
      "network",
      "server_error",
      "bot_check_error",
    ] as const;
    for (const code of codes) {
      const msg = submitFailureView(code, ctx).message;
      expect(msg).not.toMatch(/[,!?:;()]/);
      expect(msg).not.toMatch(/[a-z_]{4,}/);
    }
  });
});

describe("完成頁格式(C3-D06)", () => {
  it("⑦-1 / ⑦-2 / ⑦-3", () => {
    expect(completionKind({ isGuest: false, status: "pending_confirmation" })).toBe(
      "member_pending",
    );
    expect(completionKind({ isGuest: false, status: "accepted" })).toBe("member_accepted");
    expect(completionKind({ isGuest: true, status: "pending_confirmation" })).toBe("guest");
  });

  it("時間用台北時區:10月13日（二）10:00", () => {
    expect(formatSubmittedStart("2026-10-13T02:00:00Z")).toBe("10月13日（二）10:00");
    // 台北跨日
    expect(formatSubmittedStart("2026-10-12T16:30:00Z")).toBe("10月13日（二）00:30");
  });

  it("項目 × 數量", () => {
    expect(
      formatSubmittedItems([
        { name: "室內機清洗", quantity: 2 },
        { name: "室外機清洗", quantity: 1 },
      ]),
    ).toBe("室內機清洗 ×2、室外機清洗 ×1");
  });
});

describe("其他", () => {
  it("submission_id 是 uuid 格式、每次不同", () => {
    const a = newSubmissionId();
    const b = newSubmissionId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("LINE 內建瀏覽器判斷與 openExternalBrowser 網址", () => {
    expect(
      isLineInAppBrowser(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Line/14.1.0",
      ),
    ).toBe(true);
    expect(isLineInAppBrowser("Mozilla/5.0 (iPhone) Safari/604.1")).toBe(false);
    expect(externalBrowserUrl("https://miao-yue-dispatch.vercel.app/booking/shop-1#x")).toBe(
      "https://miao-yue-dispatch.vercel.app/booking/shop-1?openExternalBrowser=1",
    );
  });
});
