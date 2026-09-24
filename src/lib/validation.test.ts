// 對應規格書 .project/specs/人員與權限管理.md §8.3:
// 「測試:Vitest(涵蓋合法格式、少於/多於 10 碼、非 09 開頭、含非數字字元等邊界情況)」。
// 對應 .project/SPECS-INDEX.md #595、#596。
import { describe, it, expect } from "vitest";
import { isValidEmail, isValidTaiwanMobilePhone, TW_MOBILE_PHONE_REGEX } from "./validation";

describe("isValidTaiwanMobilePhone", () => {
  it("接受合法格式:09 開頭、共 10 碼純數字", () => {
    expect(isValidTaiwanMobilePhone("0912345678")).toBe(true);
    expect(isValidTaiwanMobilePhone("0900000000")).toBe(true);
    expect(isValidTaiwanMobilePhone("0987654321")).toBe(true);
  });

  it("拒絕少於 10 碼", () => {
    expect(isValidTaiwanMobilePhone("091234567")).toBe(false);
  });

  it("拒絕多於 10 碼", () => {
    expect(isValidTaiwanMobilePhone("09123456789")).toBe(false);
  });

  it("拒絕非 09 開頭(例如市話 02 開頭)", () => {
    expect(isValidTaiwanMobilePhone("0223456789")).toBe(false);
  });

  it("拒絕非 09 開頭(08 開頭,跟 09 只差一碼)", () => {
    expect(isValidTaiwanMobilePhone("0812345678")).toBe(false);
  });

  it("拒絕含非數字字元:連字號", () => {
    expect(isValidTaiwanMobilePhone("0912-345-678")).toBe(false);
  });

  it("拒絕含非數字字元:空格", () => {
    expect(isValidTaiwanMobilePhone("0912 345 678")).toBe(false);
  });

  it("拒絕含非數字字元:國際碼加號前綴", () => {
    expect(isValidTaiwanMobilePhone("+886912345678")).toBe(false);
  });

  it("拒絕空字串", () => {
    expect(isValidTaiwanMobilePhone("")).toBe(false);
  });

  it("拒絕歷史測試值(對應正式環境查證發現的既有資料狀況,例如「123」「0900」)", () => {
    expect(isValidTaiwanMobilePhone("123")).toBe(false);
    expect(isValidTaiwanMobilePhone("0900")).toBe(false);
  });

  it("TW_MOBILE_PHONE_REGEX 匯出的正規表示式跟函式邏輯一致(避免兩處各自維護產生落差)", () => {
    expect(TW_MOBILE_PHONE_REGEX.test("0912345678")).toBe(isValidTaiwanMobilePhone("0912345678"));
  });
});

describe("isValidEmail", () => {
  it("接受一般常見的合法格式", () => {
    expect(isValidEmail("name@example.com")).toBe(true);
    expect(isValidEmail("a.b@example.co.uk")).toBe(true);
    expect(isValidEmail("name+tag@example.com")).toBe(true);
    expect(isValidEmail("user_1@mail.example.com.tw")).toBe(true);
  });

  it("拒絕沒有 @ 的字串(客服隨手打 abc 的情境)", () => {
    expect(isValidEmail("abc")).toBe(false);
  });

  it("拒絕 @ 前面沒有內容", () => {
    expect(isValidEmail("@example.com")).toBe(false);
  });

  it("拒絕 @ 後面沒有內容", () => {
    expect(isValidEmail("name@")).toBe(false);
  });

  it("拒絕網域沒有點(不是有效的網域)", () => {
    expect(isValidEmail("name@example")).toBe(false);
  });

  it("拒絕含空白字元(誤把地址整段貼進來的情境)", () => {
    expect(isValidEmail("台北市信義區 1 號")).toBe(false);
    expect(isValidEmail("name @example.com")).toBe(false);
    expect(isValidEmail("name@exa mple.com")).toBe(false);
  });

  it("拒絕有兩個 @", () => {
    expect(isValidEmail("a@b@example.com")).toBe(false);
  });

  it("前後有多餘空白但本體合法時視為合法(送出前會 trim)", () => {
    expect(isValidEmail("  name@example.com  ")).toBe(true);
  });

  it("空字串回 false(「選填欄位留空要放行」由呼叫端自己判斷,不是這支的責任)", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("   ")).toBe(false);
  });
});
