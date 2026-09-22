// 對應規格書 .project/specs/人員與權限管理.md §8.3:
// 「測試:Vitest(涵蓋合法格式、少於/多於 10 碼、非 09 開頭、含非數字字元等邊界情況)」。
// 對應 .project/SPECS-INDEX.md #595、#596。
import { describe, it, expect } from "vitest";
import { isValidTaiwanMobilePhone, TW_MOBILE_PHONE_REGEX } from "./validation";

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
    expect(TW_MOBILE_PHONE_REGEX.test("0912345678")).toBe(
      isValidTaiwanMobilePhone("0912345678"),
    );
  });
});
