// staffListLogic.ts 的單元測試,目前涵蓋三組邏輯:
//  1. 對應規格書「服務人員管理優化與硬刪除」§2.3:人員名單狀態篩選邏輯。
//  2. 2026-09-24:「預約天數」兩個欄位(最少提前幾天 / 最遠可預約到幾天後)的送出前驗證。
//  3. 2026-09-30 使用者裁決(SPECS-INDEX #846):「尚未開通登入」什麼時候才標黃卡
//     —— 只有這家商家已經有人真的在用登入功能時才標。

import { describe, expect, it } from "vitest";

import {
  countStaffByFilter,
  matchesStaffListFilter,
  merchantUsesStaffLogin,
  shouldMarkPendingLoginAsTodo,
  STAFF_LIST_FILTER_TABS,
  validateStaffBookingDays,
} from "./staffListLogic";
import { DEFAULT_MAX_BOOKING_DAYS_AHEAD, MAX_BOOKING_DAYS_AHEAD_LIMIT } from "./types";

const activeListed = { status: "active", is_listed: true };
const activeUnlisted = { status: "active", is_listed: false };
const removed = { status: "removed", is_listed: true };
const removedUnlisted = { status: "removed", is_listed: false };

describe("matchesStaffListFilter", () => {
  it("「全部」對任何狀態的人員都回傳 true", () => {
    expect(matchesStaffListFilter(activeListed, "all")).toBe(true);
    expect(matchesStaffListFilter(activeUnlisted, "all")).toBe(true);
    expect(matchesStaffListFilter(removed, "all")).toBe(true);
  });

  it("「未上架」只比對 status=active 且 is_listed=false", () => {
    expect(matchesStaffListFilter(activeUnlisted, "unlisted")).toBe(true);
    expect(matchesStaffListFilter(activeListed, "unlisted")).toBe(false);
    // 已移除的人員即使 is_listed=false,也不屬於「未上架」這個分類(移除跟上架狀態是兩回事)。
    expect(matchesStaffListFilter(removedUnlisted, "unlisted")).toBe(false);
  });

  it("「已上架」只比對 status=active 且 is_listed=true", () => {
    expect(matchesStaffListFilter(activeListed, "listed")).toBe(true);
    expect(matchesStaffListFilter(activeUnlisted, "listed")).toBe(false);
    expect(matchesStaffListFilter(removed, "listed")).toBe(false);
  });

  it("「已移除」只比對 status=removed,不管 is_listed 的值", () => {
    expect(matchesStaffListFilter(removed, "removed")).toBe(true);
    expect(matchesStaffListFilter(removedUnlisted, "removed")).toBe(true);
    expect(matchesStaffListFilter(activeListed, "removed")).toBe(false);
  });
});

describe("countStaffByFilter", () => {
  it("「全部」等於未篩選前的完整清單筆數,其餘分類各自正確加總", () => {
    const list = [activeListed, activeListed, activeUnlisted, removed, removedUnlisted];
    const counts = countStaffByFilter(list);
    expect(counts.all).toBe(5);
    expect(counts.listed).toBe(2);
    expect(counts.unlisted).toBe(1);
    expect(counts.removed).toBe(2);
  });

  it("空清單時四個分類都是 0", () => {
    const counts = countStaffByFilter([]);
    expect(counts).toEqual({ all: 0, unlisted: 0, listed: 0, removed: 0 });
  });
});

// 2026-09-24:「預約天數」兩個欄位的送出前驗證。資料庫端這次補上/放寬了 CHECK 約束
// (advance_booking_days >= 0、booking_window_max_days between 1 and 3650),前端要擋在同一個
// 範圍,商家才不會看到資料庫的原始錯誤訊息。這些邊界用測試釘住,不靠人工點畫面試。
describe("validateStaffBookingDays", () => {
  it("兩欄都留空是合法的(各自套用預設值 0 天 / 180 天)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: null }),
    ).toBeNull();
  });

  it("「最少要提前幾天預約」填 0 是合法的(當天就能預約)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: 0, bookingWindowMaxDays: null }),
    ).toBeNull();
  });

  it("「最少要提前幾天預約」填 3 是合法的(至少要提前 3 天才能預約)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: 3, bookingWindowMaxDays: null }),
    ).toBeNull();
  });

  it("「最少要提前幾天預約」填 -1 時擋下來,訊息要提到不能是負數、並告訴商家該填 0", () => {
    const error = validateStaffBookingDays({
      advanceBookingDays: -1,
      bookingWindowMaxDays: null,
    });
    expect(error).toContain("最少要提前幾天預約");
    expect(error).toContain("不能是負數");
    expect(error).toContain("0");
  });

  it("「最少要提前幾天預約」填 -5 這種明顯錯誤的負數也擋下來", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: -5, bookingWindowMaxDays: null }),
    ).not.toBeNull();
  });

  // 2026-09-24 使用者澄清:欄位二的 0 是合法值,意義是「最遠只能約到今天」=只接受當天預約當天
  // 服務(下限因此從 1 放寬成 0)。使用者明講這種設定幾乎不會用到,但要預留可能性,所以要有測試
  // 釘住「0 不能被誤擋」——這正是最容易在之後某次重構裡被改回 1 的地方。
  it("「最遠可以預約到幾天後」填 0 是合法的(最遠只能約到今天=只接受當天預約當天服務)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: 0 }),
    ).toBeNull();
  });

  it("「最遠可以預約到幾天後」填 1 是合法的(最遠只能約到明天)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: 1 }),
    ).toBeNull();
  });

  it("「最遠可以預約到幾天後」填 -1 時擋下來,訊息要告訴商家只接受當天預約該填 0", () => {
    const error = validateStaffBookingDays({
      advanceBookingDays: null,
      bookingWindowMaxDays: -1,
    });
    expect(error).toContain("最遠可以預約到幾天後");
    expect(error).toContain("不能是負數");
    expect(error).toContain("0");
  });

  it("「最遠可以預約到幾天後」填使用者舉例的 365 是合法的(舊的 3~180 約束已放寬)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: 365 }),
    ).toBeNull();
  });

  it("「最遠可以預約到幾天後」剛好等於上限 3650 是合法的(邊界值不能被誤擋)", () => {
    expect(
      validateStaffBookingDays({
        advanceBookingDays: null,
        bookingWindowMaxDays: MAX_BOOKING_DAYS_AHEAD_LIMIT,
      }),
    ).toBeNull();
  });

  it("「最遠可以預約到幾天後」超過上限 3650 時擋下來,並提醒是不是多打了 0", () => {
    const error = validateStaffBookingDays({
      advanceBookingDays: null,
      bookingWindowMaxDays: MAX_BOOKING_DAYS_AHEAD_LIMIT + 1,
    });
    expect(error).toContain(String(MAX_BOOKING_DAYS_AHEAD_LIMIT));
    // 訊息要真的給出「是不是多打了 0」這個提示,不是只印出一個上限數字
    // (assert "0" 會因為 3650 本身含 0 而永遠通過,沒有意義,所以比對提示語本身)。
    expect(error).toContain("多打了");
  });

  it("99999 這種明顯打錯字的值會被擋下來", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: 99999 }),
    ).not.toBeNull();
  });

  it("小數點會被擋下來(資料庫欄位是 integer)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: 1.5, bookingWindowMaxDays: null }),
    ).toContain("整數");
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: 30.5 }),
    ).toContain("整數");
  });

  it("NaN(輸入框內容無法解析成數字)會被擋下來,不會靜默通過", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: Number.NaN, bookingWindowMaxDays: null }),
    ).not.toBeNull();
  });

  it("最少天數大於最遠天數時擋下來(兩欄都有填)", () => {
    const error = validateStaffBookingDays({
      advanceBookingDays: 30,
      bookingWindowMaxDays: 10,
    });
    expect(error).toContain("不能小於");
  });

  it("最少天數等於最遠天數是合法的(剛好只有那一天可以約)", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: 10, bookingWindowMaxDays: 10 }),
    ).toBeNull();
  });

  it("最少 0 + 最遠 0 是合法的——只做當天生意(不需要提前、而且只能約今天)", () => {
    expect(validateStaffBookingDays({ advanceBookingDays: 0, bookingWindowMaxDays: 0 })).toBeNull();
  });

  it("最少 1 + 最遠 0 要擋下來——必須提前 1 天卻又只能約到今天,客戶永遠約不到", () => {
    const error = validateStaffBookingDays({ advanceBookingDays: 1, bookingWindowMaxDays: 0 });
    expect(error).not.toBeNull();
    expect(error).toContain("永遠約不到");
  });

  it("最少留空(=0)+ 最遠 0 是合法的——沒有要求提前,只能約今天", () => {
    expect(
      validateStaffBookingDays({ advanceBookingDays: null, bookingWindowMaxDays: 0 }),
    ).toBeNull();
  });

  it("最遠天數留空時,最少天數超過 180 也要擋下來——留空會套用 180,生效區間是空的", () => {
    const error = validateStaffBookingDays({
      advanceBookingDays: DEFAULT_MAX_BOOKING_DAYS_AHEAD + 20,
      bookingWindowMaxDays: null,
    });
    expect(error).not.toBeNull();
    expect(error).toContain(String(DEFAULT_MAX_BOOKING_DAYS_AHEAD));
  });

  it("最遠天數留空、最少天數剛好等於 180 時是合法的(邊界值不能被誤擋)", () => {
    expect(
      validateStaffBookingDays({
        advanceBookingDays: DEFAULT_MAX_BOOKING_DAYS_AHEAD,
        bookingWindowMaxDays: null,
      }),
    ).toBeNull();
  });
});

// =========================================================================
// 🔴 2026-09-30 使用者裁決(#846):黃卡只在這家真的在用登入功能時才出現。
// 規範見 .claude/skills/ui-overlay-patterns/SKILL.md 二之八末段。
//
// 這組測試要釘住的三件事(每一條都是實機踩過或使用者明確交代的):
//   1. 一位都沒開通 ⇒ 完全不標黃(否則不用登入功能的商家名單永遠整頁黃)。
//   2. 判斷基準是**整份名單**,不是篩選後的那一批 ⇒ 同一份名單餵進去,
//      不管使用者在看哪個分頁,結果都一樣。
//   3. 已移除的人不算進「有沒有人開通」的判斷(他們已經不在職)。
// =========================================================================

/** 測試用的最小名單項目:只有這三個欄位參與黃卡判斷。 */
function staffRow(status: "active" | "removed", loginStatus: "not_invited" | "invited" | "active") {
  return { status, login_status: loginStatus };
}

const pendingActive = staffRow("active", "not_invited");
const invitedActive = staffRow("active", "invited");
const loggedInActive = staffRow("active", "active");
const pendingRemoved = staffRow("removed", "not_invited");
const loggedInRemoved = staffRow("removed", "active");

describe("merchantUsesStaffLogin", () => {
  it("名單裡有在職且已開通登入的人 ⇒ 這家在用登入功能", () => {
    expect(merchantUsesStaffLogin([pendingActive, loggedInActive])).toBe(true);
  });

  it("一個人都沒開通(全部尚未開通)⇒ 這家沒在用登入功能", () => {
    expect(merchantUsesStaffLogin([pendingActive, pendingActive, pendingActive])).toBe(false);
  });

  it("只有「邀請信已寄出」還沒真的開通 ⇒ 仍算沒在用(對方還沒完成設定密碼)", () => {
    expect(merchantUsesStaffLogin([pendingActive, invitedActive])).toBe(false);
  });

  it("🔴 唯一開通登入的那位已經被移除 ⇒ 不算(他已經不在職了)", () => {
    expect(merchantUsesStaffLogin([pendingActive, loggedInRemoved])).toBe(false);
  });

  it("空名單回傳 false,不會炸掉", () => {
    expect(merchantUsesStaffLogin([])).toBe(false);
  });

  it("login_status 是預期外的值時當成沒開通(只認 'active' 這一個)", () => {
    expect(merchantUsesStaffLogin([{ status: "active", login_status: "" }])).toBe(false);
  });
});

describe("shouldMarkPendingLoginAsTodo", () => {
  it("這家已經有人開通 + 這位尚未開通 ⇒ 標黃(這才是真的要去處理)", () => {
    expect(shouldMarkPendingLoginAsTodo(pendingActive, true)).toBe(true);
  });

  it("🔴 這家一位都沒開通 ⇒ 不標黃(選配功能沒在用,名單不該整頁黃)", () => {
    expect(shouldMarkPendingLoginAsTodo(pendingActive, false)).toBe(false);
  });

  it("「邀請信已寄出」不走這條(維持原本的 warning 狀態標籤,不標黃卡)", () => {
    expect(shouldMarkPendingLoginAsTodo(invitedActive, true)).toBe(false);
  });

  it("已經開通登入的人不標黃", () => {
    expect(shouldMarkPendingLoginAsTodo(loggedInActive, true)).toBe(false);
  });

  it("已移除的人不標黃(整張卡是灰的,沒有動作可做)", () => {
    expect(shouldMarkPendingLoginAsTodo(pendingRemoved, true)).toBe(false);
  });
});

describe("黃卡判斷:整份名單 vs 篩選後的那一批(#846 的核心要求)", () => {
  // 一份混合名單:一位已開通(已上架)、一位尚未開通(未上架)。
  const fullList = [
    { status: "active", is_listed: true, login_status: "active" },
    { status: "active", is_listed: false, login_status: "not_invited" },
  ] as const;

  it("🔴 切到「已上架」分頁時,未上架那位的黃卡結果不可以跟著變", () => {
    // 正確做法:一律拿整份名單算 merchantUsesLogin。
    const fromFullList = merchantUsesStaffLogin(fullList);
    const target = fullList[1];

    // 使用者停在「全部」時
    expect(shouldMarkPendingLoginAsTodo(target, fromFullList)).toBe(true);
    // 使用者切到「已上架」時(篩選結果不含 target,但判斷基準沒變)
    expect(shouldMarkPendingLoginAsTodo(target, fromFullList)).toBe(true);
    // 使用者切到「未上架」時
    expect(shouldMarkPendingLoginAsTodo(target, fromFullList)).toBe(true);
  });

  it("反例:若錯誤地拿「未上架」篩選結果去算,結果會翻掉 —— 這就是不能那樣做的原因", () => {
    const unlistedOnly = fullList.filter((s) => matchesStaffListFilter(s, "unlisted"));
    // 篩掉了唯一開通登入的那位 ⇒ 誤判成「這家沒在用登入功能」。
    expect(merchantUsesStaffLogin(unlistedOnly)).toBe(false);
    expect(merchantUsesStaffLogin(fullList)).toBe(true);
  });

  it("整家都沒開通時,每一位尚未開通的人都不標黃(不會出現連續黃卡)", () => {
    const noLoginList = [
      { status: "active", is_listed: true, login_status: "not_invited" },
      { status: "active", is_listed: true, login_status: "not_invited" },
      { status: "active", is_listed: false, login_status: "not_invited" },
      { status: "removed", is_listed: true, login_status: "not_invited" },
    ] as const;
    const usesLogin = merchantUsesStaffLogin(noLoginList);
    expect(usesLogin).toBe(false);
    expect(noLoginList.map((s) => shouldMarkPendingLoginAsTodo(s, usesLogin))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("STAFF_LIST_FILTER_TABS", () => {
  it("四個分類依序為全部/未上架/已上架/已移除", () => {
    expect(STAFF_LIST_FILTER_TABS.map((t) => t.value)).toEqual([
      "all",
      "unlisted",
      "listed",
      "removed",
    ]);
    expect(STAFF_LIST_FILTER_TABS.map((t) => t.label)).toEqual([
      "全部",
      "未上架",
      "已上架",
      "已移除",
    ]);
  });
});
