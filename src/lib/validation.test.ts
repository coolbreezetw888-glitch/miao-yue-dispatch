// 對應規格書 .project/specs/人員與權限管理.md §8.3:
// 「測試:Vitest(涵蓋合法格式、少於/多於 10 碼、非 09 開頭、含非數字字元等邊界情況)」。
// 對應 .project/SPECS-INDEX.md #595、#596。
import { describe, it, expect } from "vitest";
import {
  isValidEmail,
  isValidTaiwanMobilePhone,
  isValidTaiwanPhone,
  TW_MOBILE_PHONE_REGEX,
} from "./validation";

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

// SPECS-INDEX #822:客戶電話(手機或市話皆可)的規則表。規則出處與「為什麼不列舉區碼」見
// validation.ts 對應段落的說明。
describe("isValidTaiwanPhone(客戶電話,手機或市話皆可)", () => {
  it("接受手機:09 開頭共 10 碼", () => {
    expect(isValidTaiwanPhone("0912345678")).toBe(true);
    expect(isValidTaiwanPhone("0900000000")).toBe(true);
  });

  it("接受市話:使用者給的 13 個區碼逐一驗算(0 開頭、第二碼 2~8、共 9~10 碼)", () => {
    // 2 碼區碼 + 8 碼(共 10 碼)
    expect(isValidTaiwanPhone("0212345678")).toBe(true); // 台北
    expect(isValidTaiwanPhone("0412345678")).toBe(true); // 台中
    expect(isValidTaiwanPhone("0712345678")).toBe(true); // 高雄
    // 2 碼區碼 + 7 碼(共 9 碼)
    expect(isValidTaiwanPhone("031234567")).toBe(true); // 桃園/新竹
    expect(isValidTaiwanPhone("051234567")).toBe(true); // 嘉義
    expect(isValidTaiwanPhone("061234567")).toBe(true); // 台南
    expect(isValidTaiwanPhone("081234567")).toBe(true); // 屏東
    // 3 碼區碼 + 6 碼(共 9 碼)
    expect(isValidTaiwanPhone("037123456")).toBe(true); // 苗栗
    expect(isValidTaiwanPhone("049123456")).toBe(true); // 南投
    expect(isValidTaiwanPhone("089123456")).toBe(true); // 台東
    // 4 碼區碼 + 5 碼(共 9 碼)
    expect(isValidTaiwanPhone("082312345")).toBe(true); // 金門
    expect(isValidTaiwanPhone("082612345")).toBe(true); // 烏坵
    expect(isValidTaiwanPhone("083612345")).toBe(true); // 馬祖
  });

  it("分隔符號(連字號/空白/括號)不強制,有沒有都要過", () => {
    expect(isValidTaiwanPhone("0912-345-678")).toBe(true);
    expect(isValidTaiwanPhone("0912 345 678")).toBe(true);
    expect(isValidTaiwanPhone("02-1234-5678")).toBe(true);
    expect(isValidTaiwanPhone("(02) 1234-5678")).toBe(true);
    expect(isValidTaiwanPhone("037-123456")).toBe(true);
    expect(isValidTaiwanPhone("  0912345678  ")).toBe(true);
  });

  it("市話可以接 # 分機", () => {
    expect(isValidTaiwanPhone("0212345678#1234")).toBe(true);
    expect(isValidTaiwanPhone("02-1234-5678#123")).toBe(true);
    expect(isValidTaiwanPhone("037-123456#1")).toBe(true);
  });

  it("擋下:正式庫實查到的髒資料型態(3 碼、40 碼)", () => {
    expect(isValidTaiwanPhone("123")).toBe(false);
    expect(isValidTaiwanPhone("0".repeat(40))).toBe(false);
    expect(isValidTaiwanPhone("0912345678".repeat(4))).toBe(false);
  });

  it("擋下:空字串/純空白(選填欄位留空要放行,由呼叫端先判斷,不是這支的責任)", () => {
    expect(isValidTaiwanPhone("")).toBe(false);
    expect(isValidTaiwanPhone("   ")).toBe(false);
  });

  it("擋下:純英文、中文、夾雜字母", () => {
    expect(isValidTaiwanPhone("abcdefghij")).toBe(false);
    expect(isValidTaiwanPhone("電話")).toBe(false);
    expect(isValidTaiwanPhone("0912abc678")).toBe(false);
  });

  it("擋下:手機少一碼(09 開頭只有 9 碼)、多一碼", () => {
    expect(isValidTaiwanPhone("091234567")).toBe(false);
    expect(isValidTaiwanPhone("09123456789")).toBe(false);
  });

  it("擋下:市話碼數不對(8 碼太短、11 碼太長)", () => {
    expect(isValidTaiwanPhone("02123456")).toBe(false);
    expect(isValidTaiwanPhone("02123456789")).toBe(false);
  });

  it("擋下:不是 0 開頭、或第二碼是 0/1/9 以外規則沒涵蓋的組合", () => {
    expect(isValidTaiwanPhone("1234567890")).toBe(false);
    expect(isValidTaiwanPhone("0012345678")).toBe(false);
    expect(isValidTaiwanPhone("0112345678")).toBe(false);
    expect(isValidTaiwanPhone("+886912345678")).toBe(false);
  });

  it("擋下:分機的位置或內容不對(手機不該有分機、# 後面沒數字、# 後面夾字母、只有分機)", () => {
    expect(isValidTaiwanPhone("0912345678#123")).toBe(false);
    expect(isValidTaiwanPhone("0212345678#")).toBe(false);
    expect(isValidTaiwanPhone("0212345678#12a")).toBe(false);
    expect(isValidTaiwanPhone("#123")).toBe(false);
    expect(isValidTaiwanPhone("0212345678#1234567")).toBe(false); // 分機上限 6 碼
  });

  it("不會把既有的服務人員/客服手機規則放寬(isValidTaiwanMobilePhone 仍然只收手機)", () => {
    expect(isValidTaiwanMobilePhone("0212345678")).toBe(false);
    expect(isValidTaiwanMobilePhone("0912-345-678")).toBe(false);
    expect(isValidTaiwanPhone("0212345678")).toBe(true);
  });
});
