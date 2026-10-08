// 客戶端第 2 批:customerLoginLogic 純函式測試。

import { describe, expect, it } from "vitest";

import {
  compactCustomerPhone,
  customerPhoneError,
  isAllowedAuthorizeUrl,
  isValidCustomerPhone,
  lineAvatarText,
  parseBookingDraft,
  parseCompleteProfileResult,
  parseCustomerSessionState,
  peekPendingDraft,
  putPendingDraft,
  readLineCallbackParams,
  safeImageUrl,
  takePendingDraft,
  toServerDraft,
} from "./customerLoginLogic";

describe("零之二第 3 點:電話收手機與市話", () => {
  it.each([
    "0912345678",
    "0912-345-678",
    "0912 345 678",
    "02-1234-5678",
    "(02)2345-6789",
    "（02）2345－6789",
    "037-123456",
    "0823-12345",
  ])("%s ⇒ 合法", (v) => {
    expect(isValidCustomerPhone(v)).toBe(true);
    expect(customerPhoneError(v)).toBeNull();
  });

  it.each([
    "091234567", // 手機少一碼
    "09123456789", // 手機多一碼
    "1912345678",
    "02-1234-5678#123", // 不收分機
    "0123456789",
    "+886912345678",
    "abc",
  ])("%s ⇒ 不合法", (v) => {
    expect(isValidCustomerPhone(v)).toBe(false);
    expect(customerPhoneError(v)).toMatch(/請填 0 開頭的電話/);
  });

  it("空白 ⇒ 請填寫電話", () => {
    expect(customerPhoneError("  ")).toBe("請填寫電話。");
  });

  it("去掉排版符號", () => {
    expect(compactCustomerPhone(" (02) 1234-5678 ")).toBe("0212345678");
  });
});

describe("C2-B04 草稿", () => {
  const good = {
    items: [{ service_item_id: "a", quantity: 2 }],
    staff_id: null,
    date: "2026-10-12",
    time: "10:00:00",
    name: "王小明",
    address: "",
    note: "x",
    extra: "不該留下",
  };

  it("合法草稿:時間截成 HH:MM、多的欄位丟掉", () => {
    expect(parseBookingDraft(good)).toEqual({
      items: [{ service_item_id: "a", quantity: 2 }],
      staff_id: null,
      date: "2026-10-12",
      time: "10:00",
      name: "王小明",
      address: "",
      note: "x",
    });
  });

  it.each([
    ["不是物件", "x"],
    ["沒有項目", { ...good, items: [] }],
    ["數量 0", { ...good, items: [{ service_item_id: "a", quantity: 0 }] }],
    ["日期格式錯", { ...good, date: "10/12" }],
    ["服務人員不是字串", { ...good, staff_id: 3 }],
  ])("%s ⇒ null", (_l, raw) => {
    expect(parseBookingDraft(raw)).toBeNull();
  });

  it("Edge Function 存的是 notes;送出時空白轉 null", () => {
    expect(parseBookingDraft({ ...good, note: undefined, notes: "門口有狗" })?.note).toBe(
      "門口有狗",
    );
    expect(
      toServerDraft({
        items: [{ service_item_id: "a", quantity: 1 }],
        staff_id: null,
        date: "2026-10-12",
        time: "10:00",
        name: "王",
        address: "",
        note: "",
      }),
    ).toEqual({
      items: [{ service_item_id: "a", quantity: 1 }],
      staff_id: null,
      date: "2026-10-12",
      time: "10:00",
      name: "王",
      address: null,
      notes: null,
    });
  });

  it("記憶體交接:拿一次就沒了", () => {
    putPendingDraft("shop", { outcome: "logged_in", draft: null });
    expect(peekPendingDraft("shop")).not.toBeNull();
    expect(takePendingDraft("shop")).toEqual({ outcome: "logged_in", draft: null });
    expect(takePendingDraft("shop")).toBeNull();
  });
});

describe("C2-C05 登入狀態", () => {
  it.each(["not_customer", "line_login_unavailable", "channel_mismatch", "pending_sms", "x"])(
    "%s ⇒ 當沒登入",
    (s) => {
      expect(parseCustomerSessionState({ state: s })).toEqual({ state: "anonymous" });
    },
  );

  it("needs_profile:頭像只收 https", () => {
    expect(
      parseCustomerSessionState({
        state: "needs_profile",
        line_display_name: "小明",
        line_picture_url: "javascript:alert(1)",
      }),
    ).toEqual({ state: "needs_profile", lineDisplayName: "小明", linePictureUrl: null });
  });

  it("linked", () => {
    expect(
      parseCustomerSessionState({ state: "linked", member: { name: "王", phone: "02" } }),
    ).toEqual({ state: "linked", memberName: "王", memberPhone: "02" });
  });

  it("C2-F09 頭像網址", () => {
    expect(safeImageUrl("https://profile.line-scdn.net/a")).toBe("https://profile.line-scdn.net/a");
    expect(safeImageUrl("http://x/a")).toBeNull();
    expect(safeImageUrl("data:image/png;base64,AAA")).toBeNull();
    expect(lineAvatarText("王小明")).toBe("小明");
    expect(lineAvatarText("王小明的 LINE")).toBe("明的");
    expect(lineAvatarText("amy chen")).toBe("A");
    expect(lineAvatarText(null)).toBe("LINE");
  });
});

describe("customer_complete_profile 結果(零之二)", () => {
  it("linked / phone_taken / 其他", () => {
    expect(parseCompleteProfileResult({ state: "linked", existing: true })).toEqual({
      kind: "linked",
      created: false,
      existing: true,
    });
    expect(parseCompleteProfileResult({ state: "phone_taken", member_name: "不該用" })).toEqual({
      kind: "phone_taken",
    });
    expect(parseCompleteProfileResult({ state: "too_many_attempts" })).toEqual({
      kind: "rejected",
      hint: "too_many_attempts",
    });
    expect(parseCompleteProfileResult({ state: "verification_required" })).toBeNull();
  });
});

describe("C2-F04 不開放轉址", () => {
  const origin = "https://miao-yue-dispatch.vercel.app";
  it.each([
    ["https://access.line.me/oauth2/v2.1/authorize?x=1", true],
    [`${origin}/auth/line/callback?code=MOCK&state=s`, true],
    ["http://access.line.me/oauth2/v2.1/authorize", false],
    ["https://access.line.me.evil.example/oauth2/", false],
    ["https://evil.example/auth/line/callback", false],
    [`${origin}/booking/x`, false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("%s ⇒ %s", (url, ok) => {
    expect(isAllowedAuthorizeUrl(url, origin)).toBe(ok);
  });

  it("callback 只讀 code / state / error", () => {
    expect(readLineCallbackParams("?code=c&state=s&return_to=https://evil.example")).toEqual({
      code: "c",
      state: "s",
      error: null,
    });
  });
});
