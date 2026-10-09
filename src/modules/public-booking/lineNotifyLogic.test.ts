// 客戶端第 5 批 5-A(C5-M01 / M02 / M04):會員中心 LINE 通知的純邏輯(顯示條件表、parse、稍後再說 7 天)。
import { afterEach, describe, expect, it } from "vitest";

import { parseMemberHome } from "./memberCenterLogic";
import {
  DEFAULT_MEMBER_COMPLETION_MESSAGE,
  DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE,
  parseSubmitResponse,
} from "./bookingSubmitLogic";
import {
  ADD_FRIEND_CARD_BODY,
  addFriendCardTitle,
  addFriendDismissKey,
  BOOKING_SWITCH_DESCRIPTION,
  parseMemberLineNotify,
  parseMemberNotifyPrefs,
  PROMO_SWITCH_VISIBLE,
  readAddFriendDismissed,
  safeAddFriendUrl,
  shouldShowAddFriendCard,
  shouldShowLineNotifySection,
  shouldShowNotFriendNote,
  writeAddFriendDismissed,
  type MemberLineNotify,
} from "./lineNotifyLogic";

const URL_OK = "https://line.me/R/ti/p/%40abc1234";

function ln(over: Partial<MemberLineNotify> = {}): MemberLineNotify {
  return {
    available: true,
    notifyBooking: true,
    friendStatus: "unknown",
    addFriendUrl: URL_OK,
    ...over,
  };
}

describe("C5-M01 ⑧ 提示卡顯示條件(全部成立才顯示)", () => {
  it.each<[string, Partial<MemberLineNotify>, boolean, boolean]>([
    ["全部成立(不確定)", {}, false, true],
    ["全部成立(確定沒加)", { friendStatus: "not_friend" }, false, true],
    ["已加好友 ⇒ 不顯示", { friendStatus: "friend" }, false, false],
    ["店家不能用 LINE 通知 ⇒ 不顯示", { available: false }, false, false],
    ["自己關掉預約通知 ⇒ 不顯示", { notifyBooking: false }, false, false],
    ["沒有加好友網址 ⇒ 不顯示", { addFriendUrl: null }, false, false],
    ["按過稍後再說 ⇒ 不顯示", {}, true, false],
  ])("%s", (_name, over, dismissed, expected) => {
    expect(shouldShowAddFriendCard(ln(over), dismissed)).toBe(expected);
  });

  it("沒有 line_notify(舊版函式)⇒ 不顯示", () => {
    expect(shouldShowAddFriendCard(null, false)).toBe(false);
    const home = parseMemberHome({ state: "ok", member: { name: "王小明" } });
    expect(home && "lineNotify" in home ? home.lineNotify.available : null).toBe(false);
  });

  it("文案:標題帶店名;不承諾預設關的服務前提醒(主腦裁決 #7)", () => {
    expect(addFriendCardTitle("涼風工匠")).toBe("加入「涼風工匠」LINE 好友");
    expect(ADD_FRIEND_CARD_BODY).toBe("預約確認、改時間等消息都會用 LINE 通知您。");
    expect(BOOKING_SWITCH_DESCRIPTION).toBe("預約成立、確認、改時間、取消等通知，以及聯絡人申請。");
  });
});

describe("parse(c5-contract 1-1 / 1-2)", () => {
  it("首頁 line_notify 白名單;多給的欄位(LINE userId)拿不到", () => {
    const home = parseMemberHome({
      state: "ok",
      member: { name: "王小明" },
      line_notify: {
        available: true,
        notify_booking: false,
        friend_status: "not_friend",
        add_friend_url: URL_OK,
        line_user_id: "U-secret",
      },
    });
    expect(home && "lineNotify" in home ? home.lineNotify : null).toEqual({
      available: true,
      notifyBooking: false,
      friendStatus: "not_friend",
      addFriendUrl: URL_OK,
    });
  });

  it("好友狀態看不懂 ⇒ unknown;網址不是 https ⇒ null", () => {
    const r = parseMemberLineNotify({
      available: true,
      friend_status: "weird",
      add_friend_url: "javascript:alert(1)",
    });
    expect(r.friendStatus).toBe("unknown");
    expect(r.addFriendUrl).toBeNull();
    expect(r.notifyBooking).toBe(true);
    expect(safeAddFriendUrl("http://line.me/x")).toBeNull();
    expect(safeAddFriendUrl(" https://lin.ee/abc ")).toBe("https://lin.ee/abc");
    expect(safeAddFriendUrl(123)).toBeNull();
  });

  it("通知偏好:state 不是 ok ⇒ null;ok ⇒ 兩個開關", () => {
    expect(parseMemberNotifyPrefs({ state: "unavailable" })).toBeNull();
    expect(parseMemberNotifyPrefs(null)).toBeNull();
    expect(
      parseMemberNotifyPrefs({
        state: "ok",
        available: true,
        notify_booking: true,
        notify_promo: false,
        friend_status: "friend",
        add_friend_url: null,
      }),
    ).toEqual({
      available: true,
      notifyBooking: true,
      notifyPromo: false,
      friendStatus: "friend",
      addFriendUrl: null,
    });
  });
});

describe("C5-M02 ⑪-1 區塊顯示規則", () => {
  const prefs = (over: Record<string, unknown>) =>
    parseMemberNotifyPrefs({ state: "ok", available: true, ...over });

  it("店家不能用 ⇒ 整塊不顯示", () => {
    expect(shouldShowLineNotifySection(prefs({ available: false }))).toBe(false);
    expect(shouldShowLineNotifySection(null)).toBe(false);
    expect(shouldShowLineNotifySection(prefs({}))).toBe(true);
  });

  it("黃色 ! 只在確定沒加好友時出現(不確定 / 已加入不出現)", () => {
    expect(shouldShowNotFriendNote(prefs({ friend_status: "not_friend" }))).toBe(true);
    expect(shouldShowNotFriendNote(prefs({ friend_status: "unknown" }))).toBe(false);
    expect(shouldShowNotFriendNote(prefs({ friend_status: "friend" }))).toBe(false);
  });

  it("5-B 起顯示「優惠通知」開關(行銷 / 生日禮照開關發送)", () => {
    expect(PROMO_SWITCH_VISIBLE).toBe(true);
  });
});

describe("C5-M01「稍後再說」7 天", () => {
  afterEach(() => window.localStorage.clear());
  const DAY = 24 * 60 * 60 * 1000;

  it("按了之後 7 天內不顯示,滿 7 天再顯示", () => {
    const t0 = Date.UTC(2026, 9, 9, 0, 0, 0);
    expect(readAddFriendDismissed("demo", t0)).toBe(false);
    writeAddFriendDismissed("demo", t0);
    expect(readAddFriendDismissed("demo", t0 + 6 * DAY)).toBe(true);
    expect(readAddFriendDismissed("demo", t0 + 7 * DAY)).toBe(false);
    // 別間店不受影響。
    expect(readAddFriendDismissed("other", t0 + DAY)).toBe(false);
  });

  it("值壞掉 / 時間在未來 ⇒ 再顯示", () => {
    window.localStorage.setItem(addFriendDismissKey("demo"), "abc");
    expect(readAddFriendDismissed("demo")).toBe(false);
    window.localStorage.setItem(addFriendDismissKey("demo"), String(Date.now() + 10 * DAY));
    expect(readAddFriendDismissed("demo")).toBe(false);
  });
});

describe("C5-M04 完成頁保底句(伺服器沒給 completion_message 時)", () => {
  const created = {
    state: "created",
    booking: {
      status: "pending_confirmation",
      start_at: "2026-10-13T02:00:00Z",
      end_at: "2026-10-13T03:00:00Z",
      items: [],
      is_guest: false,
    },
  };

  it("店家能用 LINE 通知 ⇒「店家確認後會用 LINE 通知您。」;否則維持原句", () => {
    const withLine = parseSubmitResponse(created, { lineNotifyAvailable: true });
    const without = parseSubmitResponse(created, { lineNotifyAvailable: false });
    const legacy = parseSubmitResponse(created);
    expect(withLine?.kind === "created" && withLine.booking.completionMessage).toBe(
      DEFAULT_MEMBER_COMPLETION_MESSAGE_LINE,
    );
    expect(without?.kind === "created" && without.booking.completionMessage).toBe(
      DEFAULT_MEMBER_COMPLETION_MESSAGE,
    );
    expect(legacy?.kind === "created" && legacy.booking.completionMessage).toBe(
      DEFAULT_MEMBER_COMPLETION_MESSAGE,
    );
  });

  it("伺服器有給(含店家自訂)⇒ 照伺服器;訪客不受影響", () => {
    const custom = parseSubmitResponse(
      { ...created, completion_message: "我們會盡快聯絡你" },
      { lineNotifyAvailable: true },
    );
    expect(custom?.kind === "created" && custom.booking.completionMessage).toBe("我們會盡快聯絡你");
    const guest = parseSubmitResponse(
      { ...created, booking: { ...created.booking, is_guest: true, phone: "0912345678" } },
      { lineNotifyAvailable: true },
    );
    expect(guest?.kind === "created" && guest.booking.completionMessage).toBe(
      "店家確認後會與您聯絡。",
    );
  });
});
