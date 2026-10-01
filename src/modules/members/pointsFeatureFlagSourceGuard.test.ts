// 紅利系統重構 批次 7(判斷 13 / v2.4 裁決 21 ①)守門測試:
//   useMerchantMemberSettings 只有在「本來就有 member_settings / member_points 鑰匙」的兩個設定頁可以用來
//   判斷紅利開關。其他頁面用它,只要客服少一把鑰匙,RLS 查無列 ⇒ hook 退回預設值「開著」,
//   功能關閉時畫面反而出現紅利區塊 —— 不會報錯、只有關掉功能 + 換一個權限少的帳號才看得出來。
//   正式庫 2026-10-01 就是這樣(會員詳情頁 + 只有 members 鑰匙的客服,QA 截圖重現),所以用掃原始碼釘住。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../..");

/** 允許呼叫 useMerchantMemberSettings( 的檔案(定義處 + 兩個設定頁 + 它們自己的測試)。 */
const ALLOWED = new Set([
  "modules/members/api.ts",
  "modules/members/MemberPointsPage.tsx",
  "modules/members/MemberPointsPage.test.tsx",
  "modules/members/MemberSettingsPage.tsx",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("useMerchantMemberSettings 只能出現在紅利 / 會員設定頁(判斷 13)", () => {
  it("其他任何檔案都不呼叫它(建單頁、訂單詳情、帳務報表、會員詳情各有自己的 SECURITY DEFINER 來源)", () => {
    const offenders = walk(SRC)
      .map((file) => relative(SRC, file).replace(/\\/g, "/"))
      .filter(
        (rel) =>
          !ALLOWED.has(rel) && rel !== "modules/members/pointsFeatureFlagSourceGuard.test.ts",
      )
      .filter((rel) =>
        /\buseMerchantMemberSettings\s*\(/.test(readFileSync(join(SRC, rel), "utf8")),
      );
    expect(offenders).toEqual([]);
  });

  it("booking/ 與 payroll/ 底下連字樣都不出現在程式碼呼叫裡(§八 批次 7 驗收條件)", () => {
    const files = walk(join(SRC, "modules/booking")).concat(walk(join(SRC, "modules/payroll")));
    for (const file of files) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const code = readFileSync(file, "utf8")
        // 拿掉註解(說明為什麼不能用它的註解是刻意保留的)。
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(code.includes("useMerchantMemberSettings"), relative(SRC, file)).toBe(false);
    }
  });
});
