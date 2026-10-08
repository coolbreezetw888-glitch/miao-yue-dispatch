// 客戶端第 4 批 4-A:會員中心純函式(狀態機、錢包顯示、取消區與期限文字、點數類型對照、⑦ 文案、生日鎖定)。

import { describe, expect, it } from "vitest";

import {
  BIRTHDAY_LOCKED_NOTE,
  cancelAreaView,
  cancelConfirmTitle,
  cancelResultView,
  customerPointTypeLabel,
  formatCancelDeadline,
  formatMemberBookingTime,
  formatPointDelta,
  GUEST_CANCEL_OR_RESCHEDULE_TEXT,
  GUEST_JOIN_MEMBER_TEXT,
  isBirthdayLocked,
  isProfileDirty,
  memberArrivalToast,
  memberBookingStatusView,
  memberCenterPath,
  memberCompletionCancelText,
  memberNavItems,
  missingProfileTitle,
  normalizeCancelDeadlineHours,
  parseCancelResponse,
  parseMemberBooking,
  parseMemberBookingPage,
  parseMemberHome,
  parseMemberProfile,
  parseMemberWalletPage,
  pointEntrySubtitle,
  profileFormFrom,
  profileSaveErrorMessage,
  resolveMemberCenterView,
  toProfileUpdateArgs,
  validateProfileForm,
  walletVisible,
  type MemberBooking,
} from "./memberCenterLogic";

const VIEW = {
  id: "b1",
  start_at: "2026-10-13T02:00:00+00:00",
  end_at: "2026-10-13T03:00:00+00:00",
  status: "pending_confirmation",
  staff_display: "阿明",
  items: [
    { name: "室內機清洗", quantity: 2 },
    { name: "室外機清洗", quantity: 1 },
  ],
  address: "台北市信義區松仁路 58 號",
  customer_name: "王小明",
  customer_notes: null,
  amount: 6200,
  points_redeemed: 0,
  booked_online: true,
  booked_by: null,
  can_cancel: true,
  cancel_deadline_at: "2026-10-12T02:00:00+00:00",
  cancelled_at: null,
};

function booking(overrides: Record<string, unknown> = {}): MemberBooking {
  const b = parseMemberBooking({ ...VIEW, ...overrides });
  if (!b) throw new Error("bad fixture");
  return b;
}

describe("會員中心狀態機(C4-B02 / B03)", () => {
  it("店家停用 / 找不到 / 沒啟用 LINE 登入 ⇒ closed", () => {
    for (const pageStatus of ["not_found", "unavailable"] as const) {
      expect(resolveMemberCenterView({ pageStatus, lineLoginEnabled: true, session: null })).toBe(
        "closed",
      );
    }
    expect(
      resolveMemberCenterView({
        pageStatus: "ok",
        lineLoginEnabled: false,
        session: { state: "anonymous" },
      }),
    ).toBe("closed");
  });

  it("登入狀態:還沒回來 loading / 沒登入 login / 還沒接上 profile / 接上 center", () => {
    const base = { pageStatus: "ok" as const, lineLoginEnabled: true };
    expect(resolveMemberCenterView({ ...base, session: null })).toBe("loading");
    expect(resolveMemberCenterView({ ...base, session: { state: "anonymous" } })).toBe("login");
    expect(
      resolveMemberCenterView({
        ...base,
        session: { state: "needs_profile", lineDisplayName: null, linePictureUrl: null },
      }),
    ).toBe("profile");
    expect(
      resolveMemberCenterView({
        ...base,
        session: { state: "linked", memberName: "王", memberPhone: null, memberAddress: null },
      }),
    ).toBe("center");
  });

  it("4-B(C4-H04):送出加入聯絡人申請、還沒處理 ⇒ join_pending", () => {
    expect(
      resolveMemberCenterView({
        pageStatus: "ok",
        lineLoginEnabled: true,
        session: { state: "join_pending", lineDisplayName: "小李", linePictureUrl: null },
      }),
    ).toBe("join_pending");
  });

  it("4-B(C4-C01):待處理申請數只算主要聯絡人的", () => {
    const raw = {
      state: "ok",
      member: { name: "王", is_primary: true, missing: [] },
      next_booking: null,
      upcoming_count: 0,
      wallet: { points_enabled: false },
      pending_contact_requests: 2,
    };
    expect(parseMemberHome(raw)).toMatchObject({ isPrimary: true, pendingContactRequests: 2 });
    expect(
      parseMemberHome({ ...raw, member: { name: "王", is_primary: false, missing: [] } }),
    ).toMatchObject({ isPrimary: false, pendingContactRequests: 0 });
  });

  it("登入回來的提示:再次登入 vs 這次才加入", () => {
    expect(memberArrivalToast("涼風工匠", false)).toBe("已登入「涼風工匠」會員中心");
    expect(memberArrivalToast("涼風工匠", true)).toBe("已加入「涼風工匠」會員");
  });

  it("網址", () => {
    expect(memberCenterPath("cool-shop")).toBe("/booking/cool-shop/me");
    expect(memberCenterPath("cool-shop", "bookings")).toBe("/booking/cool-shop/me/bookings");
    expect(memberCenterPath("cool-shop", "wallet")).toBe("/booking/cool-shop/me/wallet");
    expect(memberCenterPath("cool-shop", "profile")).toBe("/booking/cool-shop/me/profile");
  });
});

describe("回傳 parse(白名單)", () => {
  it("BookingView:多給的欄位丟掉、pending_reply / dispatching 當待確認", () => {
    const b = parseMemberBooking({ ...VIEW, notes: "內部備註哨兵", status: "dispatching" });
    expect(b).not.toBeNull();
    expect(JSON.stringify(b)).not.toContain("內部備註哨兵");
    expect(b!.status).toBe("pending_confirmation");
    expect(parseMemberBooking({ ...VIEW, status: "pending_reply" })!.status).toBe(
      "pending_confirmation",
    );
    expect(parseMemberBooking({ ...VIEW, id: null })).toBeNull();
    expect(parseMemberBooking({ ...VIEW, start_at: "不是時間" })).toBeNull();
  });

  it("not_linked / channel_mismatch ⇒ not_linked;unavailable 原樣;看不懂 ⇒ null", () => {
    expect(parseMemberHome({ state: "not_linked" })).toEqual({ state: "not_linked" });
    expect(parseMemberHome({ state: "channel_mismatch" })).toEqual({ state: "not_linked" });
    expect(parseMemberBookingPage({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(parseMemberWalletPage({ state: "???" })).toBeNull();
    expect(parseMemberProfile(null)).toBeNull();
  });

  it("首頁:缺的欄位依「生日、地址、Email」;紅利沒開不回餘額", () => {
    const home = parseMemberHome({
      state: "ok",
      member: { name: "王小明", is_primary: true, missing: ["email", "birthday", "x"] },
      next_booking: VIEW,
      upcoming_count: 2,
      wallet: { points_enabled: false, points_balance: 99, stored_value: null },
      pending_contact_requests: 0,
    });
    expect(home).toMatchObject({
      memberName: "王小明",
      missing: ["birthday", "email"],
      upcomingCount: 2,
      wallet: { pointsEnabled: false, pointsBalance: null, storedValueEnabled: false },
    });
  });

  it("我的預約:items / next_cursor / counts", () => {
    const page = parseMemberBookingPage({
      state: "ok",
      items: [VIEW, { bad: true }],
      next_cursor: "2026-09-30T02:00:00+00:00",
      counts: { upcoming: 2, history: 15 },
    });
    expect(page).toMatchObject({
      nextCursor: "2026-09-30T02:00:00+00:00",
      counts: { upcoming: 2, history: 15 },
    });
    expect(page && "items" in page ? page.items : []).toHaveLength(1);
  });

  it("錢包:紅利沒開 ⇒ points null;明細只留 type / delta / 時間 / 訂單摘要", () => {
    expect(parseMemberWalletPage({ state: "ok", points: null, stored_value: null })).toEqual({
      points: null,
      storedValueEnabled: false,
    });
    const w = parseMemberWalletPage({
      state: "ok",
      points: {
        enabled: true,
        balance: 320,
        history: [
          {
            type: "manual_adjustment",
            delta: -100,
            created_at: "2026-09-10T01:00:00Z",
            booking_summary: null,
            note: "店家內部說明哨兵",
          },
        ],
        next_cursor: null,
      },
      stored_value: null,
    });
    expect(JSON.stringify(w)).not.toContain("店家內部說明哨兵");
    expect(w && "points" in w ? w.points?.balance : null).toBe(320);
  });
});

describe("我的預約卡片(C4-C04 / C4-D01)", () => {
  it("狀態標籤", () => {
    expect(memberBookingStatusView("pending_confirmation")).toEqual({
      label: "待確認",
      tone: "warning",
    });
    expect(memberBookingStatusView("accepted")).toEqual({ label: "已確認", tone: "success" });
    expect(memberBookingStatusView("completed")).toEqual({ label: "已完成", tone: "neutral" });
    expect(memberBookingStatusView("cancelled")).toEqual({ label: "已取消", tone: "danger" });
  });

  it("時間:即將到來不帶年份;歷史帶年份(台北時間)", () => {
    expect(formatMemberBookingTime(VIEW.start_at, false)).toBe("10月13日（二）10:00");
    expect(formatMemberBookingTime("2026-10-02T06:00:00Z", true)).toBe("2026年10月2日（五）14:00");
    expect(formatCancelDeadline("2026-10-12T02:00:00+00:00")).toBe("10月12日 10:00");
  });

  it("可以取消 ⇒「10月12日 10:00 以前可以取消」", () => {
    expect(cancelAreaView(booking(), 24)).toEqual({
      kind: "can_cancel",
      text: "10月12日 10:00 以前可以取消",
    });
  });

  it("不能取消、待確認 / 已確認 ⇒「服務前 N 小時內不能線上取消，請直接聯絡店家」", () => {
    expect(cancelAreaView(booking({ can_cancel: false }), 24)).toEqual({
      kind: "contact",
      text: "服務前 24 小時內不能線上取消，請直接聯絡店家",
    });
    expect(cancelAreaView(booking({ can_cancel: false, status: "accepted" }), 48).kind).toBe(
      "contact",
    );
    // N = 0 還不能取消 = 服務已經開始
    expect(cancelAreaView(booking({ can_cancel: false }), 0)).toEqual({
      kind: "contact",
      text: "服務已經開始，不能線上取消，請直接聯絡店家",
    });
  });

  it("已完成 / 已取消 ⇒ 沒有取消區;can_cancel 只看伺服器", () => {
    expect(cancelAreaView(booking({ status: "completed" }), 24).kind).toBe("none");
    expect(cancelAreaView(booking({ status: "cancelled", can_cancel: true }), 24).kind).toBe(
      "none",
    );
  });

  it("取消確認窗標題(逐字)", () => {
    expect(cancelConfirmTitle(booking())).toBe("確定要取消 10月13日（二）10:00 的預約嗎？");
  });

  it("取消期限讀取:不合法 ⇒ 24", () => {
    expect(normalizeCancelDeadlineHours(0)).toBe(0);
    expect(normalizeCancelDeadlineHours(168)).toBe(168);
    expect(normalizeCancelDeadlineHours(169)).toBe(24);
    expect(normalizeCancelDeadlineHours(undefined)).toBe(24);
    expect(normalizeCancelDeadlineHours("12")).toBe(24);
  });
});

describe("取消結果(C4-D06)", () => {
  it("成功 / 已取消 ⇒ 關窗、toast、重讀", () => {
    for (const s of ["cancelled", "already_cancelled"] as const) {
      expect(cancelResultView(s)).toMatchObject({
        closeDialog: true,
        toast: "已取消預約",
        reload: true,
      });
    }
  });
  it("期限過了 ⇒ 說明 + 聯絡按鈕;狀態變了 / 找不到 ⇒ 同一句", () => {
    expect(cancelResultView("deadline_passed")).toMatchObject({
      message: "已經超過可以線上取消的時間，請直接聯絡店家。",
      showContacts: true,
      reload: true,
    });
    expect(cancelResultView("not_cancellable").message).toBe(
      "這筆預約的狀態已經變更，請重新整理後再看看。",
    );
    expect(cancelResultView("not_found").message).toBe(cancelResultView("not_cancellable").message);
  });
  it("not_linked ⇒ 回登入頁;太頻繁 / 斷線 / 500 ⇒ 保留視窗", () => {
    expect(cancelResultView("not_linked")).toMatchObject({ relogin: true });
    expect(cancelResultView("rate_limited")).toMatchObject({
      closeDialog: false,
      message: "操作太頻繁，請稍後再試",
    });
    for (const c of ["network", "server_error"] as const) {
      expect(cancelResultView(c)).toMatchObject({
        closeDialog: false,
        message: "取消時發生問題，請稍後再試。",
      });
    }
  });
  it("Edge 回應:只認列出的 state", () => {
    expect(parseCancelResponse({ state: "cancelled", booking: VIEW })).toBe("cancelled");
    expect(parseCancelResponse({ state: "channel_mismatch" })).toBe("not_linked");
    expect(parseCancelResponse({ state: "invalid_request" })).toBeNull();
    expect(parseCancelResponse("x")).toBeNull();
  });
});

describe("錢包(C4-W01 / W03)", () => {
  it("紅利關掉(也沒有儲值金)⇒ 底部選單沒有「錢包」", () => {
    expect(
      walletVisible({ pointsEnabled: false, pointsBalance: null, storedValueEnabled: false }),
    ).toBe(false);
    expect(
      walletVisible({ pointsEnabled: true, pointsBalance: 0, storedValueEnabled: false }),
    ).toBe(true);
    expect(walletVisible(null)).toBe(false);
    expect(memberNavItems(false).map((i) => i.label)).toEqual(["首頁", "我的預約", "我的資料"]);
    expect(memberNavItems(true).map((i) => i.label)).toEqual([
      "首頁",
      "我的預約",
      "錢包",
      "我的資料",
    ]);
  });

  it("點數類型:客人看到的名稱;推薦類開關打開(隱藏)⇒ 活動贈點", () => {
    const hidden = true;
    expect(customerPointTypeLabel("earn_booking", hidden)).toBe("消費累積");
    expect(customerPointTypeLabel("birthday_bonus", hidden)).toBe("生日禮");
    expect(customerPointTypeLabel("manual_adjustment", hidden)).toBe("店家調整");
    expect(customerPointTypeLabel("redeem", hidden)).toBe("折抵消費");
    expect(customerPointTypeLabel("redeem_booking", hidden)).toBe("折抵消費");
    expect(customerPointTypeLabel("redeem_booking_refund", hidden)).toBe("折抵退回");
    expect(customerPointTypeLabel("earn_booking_reversal", hidden)).toBe("消費點數收回");
    expect(customerPointTypeLabel("referral_bonus", hidden)).toBe("活動贈點");
    expect(customerPointTypeLabel("referral_repeat_bonus", hidden)).toBe("活動贈點");
    expect(customerPointTypeLabel("referral_bonus_reversal", hidden)).toBe("活動點數收回");
    expect(customerPointTypeLabel("some_new_type", hidden)).toBe("點數異動");
  });

  it("點數類型:推薦類開關關掉(顯示)⇒ 推薦獎勵", () => {
    expect(customerPointTypeLabel("referral_bonus", false)).toBe("推薦獎勵");
    expect(customerPointTypeLabel("referral_repeat_bonus", false)).toBe("推薦獎勵");
    expect(customerPointTypeLabel("referral_bonus_reversal", false)).toBe("推薦獎勵收回");
    expect(customerPointTypeLabel("earn_booking", false)).toBe("消費累積");
  });

  it("預設吃 REFERRAL_UI_HIDDEN(目前 true)", () => {
    expect(customerPointTypeLabel("referral_bonus")).toBe("活動贈點");
  });

  it("點數數字與明細第二行", () => {
    expect(formatPointDelta(50)).toBe("+50");
    expect(formatPointDelta(-100)).toBe("\u2212100");
    expect(formatPointDelta(1200)).toBe("+1,200");
    expect(
      pointEntrySubtitle({
        type: "earn_booking",
        delta: 50,
        createdAt: "2026-10-02T08:00:00Z",
        bookingSummary: "10月2日\u3000室內機清洗 ×2",
      }),
    ).toBe("2026年10月2日\u3000室內機清洗 ×2");
    // 點數日期跟訂單日期不同天 ⇒ 兩個都留
    expect(
      pointEntrySubtitle({
        type: "earn_booking",
        delta: 50,
        createdAt: "2026-10-05T08:00:00Z",
        bookingSummary: "10月2日\u3000室內機清洗 ×2",
      }),
    ).toBe("2026年10月5日\u300010月2日\u3000室內機清洗 ×2");
    expect(
      pointEntrySubtitle({
        type: "manual_adjustment",
        delta: 1,
        createdAt: "2026-03-05T01:00:00Z",
        bookingSummary: null,
      }),
    ).toBe("2026年3月5日");
  });
});

describe("首頁提示卡(C4-C02)", () => {
  it("缺的欄位 ⇒ 標題;沒缺 ⇒ null", () => {
    expect(missingProfileTitle(["birthday", "address", "email"])).toBe("補上生日、地址和 Email");
    expect(missingProfileTitle(["email"])).toBe("補上 Email");
    expect(missingProfileTitle(["birthday", "email"])).toBe("補上生日和 Email");
    expect(missingProfileTitle([])).toBeNull();
  });
});

describe("我的資料(C4-E02 / E03,Q3=A 生日鎖定)", () => {
  const profile = parseMemberProfile({
    state: "ok",
    member: { name: "王小明", phone: "0912345678", birthday: null, address: null, email: null },
    me: {
      line_display_name: "小明",
      line_picture_url: null,
      is_primary: true,
      contact_phone: null,
    },
    can_edit: true,
  });
  if (!profile || !("member" in profile)) throw new Error("bad fixture");
  const today = "2026-10-09";

  it("沒有生日 ⇒ 可以第一次填;有生日 ⇒ 鎖定", () => {
    expect(isBirthdayLocked(profile)).toBe(false);
    expect(isBirthdayLocked({ member: { ...profile.member, birthday: "1990-05-01" } })).toBe(true);
  });

  it("鎖定的生日不能改;第一次填:不能未來、不能早於 1900", () => {
    const v = profileFormFrom(profile);
    expect(
      validateProfileForm({ ...v, birthday: "1990-05-01" }, { originalBirthday: null, today }),
    ).toEqual({});
    expect(
      validateProfileForm({ ...v, birthday: "2026-10-10" }, { originalBirthday: null, today })
        .birthday,
    ).toBe("生日不能是未來的日期。");
    expect(
      validateProfileForm({ ...v, birthday: "1899-12-31" }, { originalBirthday: null, today })
        .birthday,
    ).toBe("請選擇正確的生日。");
    expect(
      validateProfileForm(
        { ...v, birthday: "1991-01-01" },
        { originalBirthday: "1990-05-01", today },
      ).birthday,
    ).toBe(BIRTHDAY_LOCKED_NOTE);
    expect(
      validateProfileForm(
        { ...v, birthday: "1990-05-01" },
        { originalBirthday: "1990-05-01", today },
      ).birthday,
    ).toBeUndefined();
  });

  it("姓名必填 1~50、Email 格式、地址 200 字", () => {
    const v = profileFormFrom(profile);
    const ctx = { originalBirthday: null, today };
    expect(validateProfileForm({ ...v, name: "  " }, ctx).name).toBe("請填寫姓名。");
    expect(validateProfileForm({ ...v, name: "王".repeat(51) }, ctx).name).toBe(
      "姓名最多 50 個字。",
    );
    expect(validateProfileForm({ ...v, email: "abc" }, ctx).email).toBeDefined();
    expect(validateProfileForm({ ...v, email: "a@b.co" }, ctx).email).toBeUndefined();
    expect(validateProfileForm({ ...v, address: "地".repeat(201) }, ctx).address).toBeDefined();
  });

  it("有沒有改(去頭尾空白比較);送出:空字串 ⇒ null", () => {
    const v = profileFormFrom(profile);
    expect(isProfileDirty(v, v)).toBe(false);
    expect(isProfileDirty({ ...v, name: " 王小明 " }, v)).toBe(false);
    expect(isProfileDirty({ ...v, address: "台北" }, v)).toBe(true);
    expect(
      toProfileUpdateArgs({ name: " 王小明 ", birthday: "", address: " ", email: "" }),
    ).toEqual({ name: "王小明", birthday: null, address: null, email: null });
  });

  it("儲存被擋 ⇒ 依 hint 的固定句子(不顯示資料庫原文)", () => {
    expect(profileSaveErrorMessage("birthday_locked")).toBe(BIRTHDAY_LOCKED_NOTE);
    expect(profileSaveErrorMessage("invalid_name")).toBe("請填寫姓名（最多 50 字）。");
    expect(profileSaveErrorMessage("whatever")).toBe("儲存失敗，請稍後再試。你填的資料沒有遺失。");
  });

  it("4-A 主要聯絡人才能改;can_edit 沒給時看 is_primary", () => {
    expect(profile.canEdit).toBe(true);
    const second = parseMemberProfile({
      state: "ok",
      member: { name: "公司" },
      me: { is_primary: false },
    });
    expect(second && "canEdit" in second ? second.canEdit : null).toBe(false);
  });
});

describe("完成頁 ⑦ 文案(C4-B04,逐字)", () => {
  it("⑦-1 / ⑦-2 會員:依 N", () => {
    expect(memberCompletionCancelText(24)).toBe(
      "要取消可以在服務前 24 小時以前到會員中心操作；要改時間請取消後重新預約，或聯絡店家。",
    );
    expect(memberCompletionCancelText(0)).toBe(
      "服務開始前都可以到會員中心取消；要改時間請取消後重新預約，或聯絡店家。",
    );
  });
  it("⑦-3 訪客", () => {
    expect(GUEST_JOIN_MEMBER_TEXT).toBe(
      "用 LINE 登入加入會員後，可以在會員中心查看和取消這筆預約。",
    );
    expect(GUEST_CANCEL_OR_RESCHEDULE_TEXT).toBe("要取消或改時間請直接聯絡店家");
  });
});
