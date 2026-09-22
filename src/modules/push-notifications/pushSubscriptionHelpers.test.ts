// 模組 15(服務人員推播通知)§7.2:usePushSubscription 用到的純函式測試。

import { describe, expect, it } from "vitest";
import {
  findMatchingSubscription,
  shouldBlockIosNonStandalone,
  urlBase64ToUint8Array,
} from "./pushSubscriptionHelpers";

describe("urlBase64ToUint8Array", () => {
  it("正確轉換一組已知的 base64url 字串", () => {
    // "hello" 的 base64 是 aGVsbG8=,base64url 版本(padding 移除、+/ 換成 -/_)是 aGVsbG8。
    const result = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(result)).toEqual([104, 101, 108, 108, 111]); // "hello" 的 char codes
  });

  it("正確處理含 - 和 _ 字元的 base64url 字串", () => {
    // 標準 base64 "+" -> base64url "-","/" -> "_"。這裡驗證轉換後長度/內容合理,不拋錯。
    const result = urlBase64ToUint8Array("BFg_if7Gen_q313Y3lRXBIdntbLU80t1njSXCDe6DQI");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("findMatchingSubscription", () => {
  const subs = [
    { id: "1", endpoint: "https://fcm.example/a" },
    { id: "2", endpoint: "https://fcm.example/b" },
  ];

  it("找到相符的 endpoint 時回傳那一筆", () => {
    expect(findMatchingSubscription(subs, "https://fcm.example/b")).toEqual(subs[1]);
  });

  it("currentEndpoint 是 null 時回傳 null", () => {
    expect(findMatchingSubscription(subs, null)).toBeNull();
  });

  it("找不到相符的 endpoint 時回傳 null", () => {
    expect(findMatchingSubscription(subs, "https://fcm.example/not-exist")).toBeNull();
  });
});

describe("shouldBlockIosNonStandalone(第六節規則 3)", () => {
  it("iOS Safari 且非獨立視窗模式 → 擋下(true)", () => {
    expect(shouldBlockIosNonStandalone(true, false)).toBe(true);
  });

  it("iOS Safari 且已經是獨立視窗模式 → 不擋(false)", () => {
    expect(shouldBlockIosNonStandalone(true, true)).toBe(false);
  });

  it("不是 iOS Safari → 不擋,不論是否 standalone", () => {
    expect(shouldBlockIosNonStandalone(false, false)).toBe(false);
    expect(shouldBlockIosNonStandalone(false, true)).toBe(false);
  });
});
