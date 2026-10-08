// 客戶端第 4 批 4-B(#1041):聯絡人純函式(c4-contract 4-B 章節的回傳格式逐條驗)。
import { afterEach, describe, expect, it } from "vitest";

import {
  captureInviteTokenFromLocation,
  clearPendingInvite,
  contactsSectionMode,
  inviteBlockedReason,
  inviteShareText,
  isValidInviteToken,
  lineShareUrl,
  normalizeInviteUrl,
  parseAcceptInviteResult,
  parseCompleteInvite,
  parseCreateInviteResult,
  parseInvitePeek,
  parseMemberContacts,
  parseSetMyPhoneResult,
  peekPendingInvite,
  putClaimedInvite,
  resolveRequestMessage,
  transferPrimaryConfirmText,
} from "./memberContactsLogic";

const TOKEN = "Abc_def-123456789012345678901234";
const ORIGIN = "https://miao-yue-dispatch.vercel.app";

afterEach(() => {
  clearPendingInvite("cool-shop");
  window.history.replaceState(null, "", "/");
});

describe("邀請碼(C4-F04)", () => {
  it("格式:32~128 碼網址安全字元", () => {
    expect(isValidInviteToken(TOKEN)).toBe(true);
    expect(isValidInviteToken("short")).toBe(false);
    expect(isValidInviteToken(`${TOKEN}<`)).toBe(false);
    expect(isValidInviteToken(null)).toBe(false);
  });

  it("網址上的邀請碼:抓下來放記憶體,網址列立刻換成不含邀請碼", () => {
    window.history.replaceState(null, "", `/booking/cool-shop/invite/${TOKEN}`);
    expect(captureInviteTokenFromLocation("cool-shop")).toBe(TOKEN);
    expect(window.location.pathname).toBe("/booking/cool-shop/invite");
    expect(peekPendingInvite("cool-shop")).toEqual({ kind: "token", token: TOKEN });
  });

  it("格式不對 ⇒ 不收,但網址一樣換掉", () => {
    window.history.replaceState(null, "", "/booking/cool-shop/invite/<script>");
    expect(captureInviteTokenFromLocation("cool-shop")).toBeNull();
    expect(window.location.pathname).toBe("/booking/cool-shop/invite");
    expect(peekPendingInvite("cool-shop")).toBeNull();
  });

  it("LINE 登入回來:記下「已保留」不記邀請碼", () => {
    putClaimedInvite("cool-shop", true);
    expect(peekPendingInvite("cool-shop")).toEqual({ kind: "claimed", valid: true });
  });

  it("complete 回應:只有 purpose = invite 才有邀請結果", () => {
    expect(parseCompleteInvite({ purpose: "invite", invite: { state: "valid" } })).toEqual({
      valid: true,
    });
    expect(parseCompleteInvite({ purpose: "invite", invite: { state: "invalid" } })).toEqual({
      valid: false,
    });
    expect(parseCompleteInvite({ status: "ok", draft: null })).toBeNull();
  });
});

describe("邀請(B4)", () => {
  it("建立:網址 = 本站 + path;別的路徑 / 邀請碼格式不對 ⇒ 看不懂", () => {
    const raw = {
      state: "ok",
      invite: { id: "i1", created_at: "2026-10-09T00:00:00Z", expires_at: "2026-10-12T00:00:00Z" },
      path: `/booking/cool-shop/invite/${TOKEN}`,
    };
    expect(parseCreateInviteResult(raw, "cool-shop", ORIGIN)).toEqual({
      state: "ok",
      url: `${ORIGIN}/booking/cool-shop/invite/${TOKEN}`,
      expiresAt: "2026-10-12T00:00:00Z",
    });
    expect(parseCreateInviteResult({ state: "invite_limit" }, "cool-shop", ORIGIN)).toEqual({
      state: "invite_limit",
    });
    expect(
      normalizeInviteUrl(
        `https://evil.example/booking/cool-shop/invite/${TOKEN}`,
        "cool-shop",
        ORIGIN,
      ),
    ).toBe(`${ORIGIN}/booking/cool-shop/invite/${TOKEN}`);
    expect(normalizeInviteUrl(`/booking/other/invite/${TOKEN}`, "cool-shop", ORIGIN)).toBeNull();
    expect(normalizeInviteUrl("/booking/cool-shop/invite/abc", "cool-shop", ORIGIN)).toBeNull();
  });

  it("分享文字逐字 + LINE 官方分享網址(UTF-8 百分比編碼)", () => {
    const text = inviteShareText("涼風工匠", "王小明", "https://x.test/a");
    expect(text).toBe(
      "邀請你成為「涼風工匠」會員「王小明」的聯絡人：https://x.test/a（72 小時內有效）",
    );
    expect(lineShareUrl("a b&c")).toBe("https://line.me/R/share?text=a%20b%26c");
  });

  it("查邀請:valid / invalid;unavailable 當 invalid", () => {
    expect(parseInvitePeek({ state: "valid", merchant_name: "涼風工匠" })).toEqual({
      state: "valid",
      merchantName: "涼風工匠",
    });
    expect(parseInvitePeek({ state: "unavailable" })).toEqual({ state: "invalid" });
    expect(parseInvitePeek({ state: "?" })).toBeNull();
  });

  it("接受邀請:phone_result、額滿、channel 不符 ⇒ not_linked", () => {
    expect(parseAcceptInviteResult({ state: "linked", phone_result: "in_use" })).toEqual({
      state: "linked",
      phoneResult: "in_use",
    });
    expect(parseAcceptInviteResult({ state: "linked" })).toEqual({
      state: "linked",
      phoneResult: "none",
    });
    expect(parseAcceptInviteResult({ state: "contact_limit" })).toEqual({ state: "contact_limit" });
    expect(parseAcceptInviteResult({ state: "channel_mismatch" })).toEqual({ state: "not_linked" });
  });
});

describe("聯絡人清單(B5-1)", () => {
  const base = {
    state: "ok",
    me: { contact_id: "c2", is_primary: false },
    contacts: [
      {
        id: "c2",
        line_display_name: "小李",
        is_primary: false,
        is_me: true,
        contact_phone: "0933",
      },
      {
        id: "c1",
        line_display_name: "小明",
        line_picture_url: "javascript:alert(1)",
        is_primary: true,
        is_me: false,
      },
    ],
    requests: [{ id: "r1", line_display_name: "x" }],
    invites: [{ id: "i1" }],
  };

  it("主要聯絡人排第一;頭像只收 https;第二聯絡人不收申請 / 邀請", () => {
    const view = parseMemberContacts(base)!;
    expect(view.isPrimary).toBe(false);
    expect(view.contacts.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(view.contacts[0]!.linePictureUrl).toBeNull();
    expect(view.requests).toEqual([]);
    expect(view.invites).toEqual([]);
    expect(contactsSectionMode(view)).toBe("secondary");
  });

  it("只有自己一位 ⇒ solo;有申請就不是 solo", () => {
    const solo = parseMemberContacts({
      state: "ok",
      me: { contact_id: "c1", is_primary: true },
      contacts: [{ id: "c1", is_primary: true, is_me: true }],
      requests: [],
      invites: [],
    })!;
    expect(contactsSectionMode(solo)).toBe("solo");
    expect(
      contactsSectionMode({
        ...solo,
        requests: [
          { id: "r", lineDisplayName: "x", linePictureUrl: null, phone: null, createdAt: null },
        ],
      }),
    ).toBe("primary");
    expect(inviteBlockedReason(solo)).toBeNull();
    expect(
      inviteBlockedReason({
        ...solo,
        invites: Array.from({ length: 5 }, (_, i) => ({
          id: `i${i}`,
          createdAt: null,
          expiresAt: null,
        })),
      }),
    ).toContain("同時最多 5 個有效邀請");
  });

  it("看不懂 ⇒ null", () => {
    expect(parseMemberContacts({ state: "not_ok" })).toBeNull();
  });
});

describe("動作結果", () => {
  it("處理申請:approved / rejected 算成功;其他固定句子", () => {
    expect(resolveRequestMessage("approved", true)).toBeNull();
    expect(resolveRequestMessage("rejected", false)).toBeNull();
    expect(resolveRequestMessage("contact_limit", true)).toContain("最多 10 位聯絡人");
    expect(resolveRequestMessage("not_found", true)).toBe(
      "這筆申請已經處理過或已經失效，請重新整理。",
    );
  });

  it("轉移主要逐字(C4-H09)", () => {
    expect(transferPrimaryConfirmText("小李")).toBe(
      "把主要聯絡人轉給 小李 嗎？轉移後只有 小李 可以修改會員資料、管理聯絡人。",
    );
  });

  it("我的電話:ok(+contact_phone)/ phone_in_use", () => {
    expect(parseSetMyPhoneResult({ state: "ok", contact_phone: null })).toEqual({
      state: "ok",
      contactPhone: null,
    });
    expect(parseSetMyPhoneResult({ state: "phone_in_use" })).toEqual({ state: "phone_in_use" });
  });
});
