// 客戶端第 3 批(C3-E03 + 主腦 2026-10-09 小修):預約網址的說明文字逐字比對。
import { describe, expect, it } from "vitest";

import { readSourceWithoutComments } from "@/test/sourceScan";

describe("C3-E03 預約網址文案", () => {
  it("商家設定「預約網址」? 說明:先講用途,再講代碼不能改", () => {
    const src = readSourceWithoutComments("src/modules/merchant/MerchantSettingsPage.tsx");
    expect(src).toContain(
      'help="顧客預約用的專屬連結。客人可以看服務、選時間並送出預約。網址代碼由系統自動產生，目前不開放自行修改。"',
    );
    expect(src).not.toContain("即將開放");
  });

  it("功能頁「預約網址」卡片", () => {
    const src = readSourceWithoutComments("src/routes/ManagePage.tsx");
    expect(src).toContain("顧客預約用的專屬連結。客人可以看服務、選時間並送出預約。");
    expect(src).not.toContain("線上送出預約即將開放");
  });
});
