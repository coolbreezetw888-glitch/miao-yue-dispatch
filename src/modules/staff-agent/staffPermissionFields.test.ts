// 服務人員「權限功能」開關(STAFF_BOOLEAN_PERMISSION_FIELDS)的說明文字測試。
//
// ⚠️ **為什麼這支是「純資料斷言」,不是畫面測試** —— 這個常數唯一的消費端是
// `StaffListPage.tsx:769`(編輯服務人員的全頁層裡那排 SwitchRow),而 `StaffListPage.tsx`
// **沒有自己的畫面測試檔**(同資料夾只有 `staffListLogic.test.ts`,那支測的是純邏輯函式,
// 不渲染這個表單)。為了一句說明文字去把那個很大的全頁層表單整套 mock 起來,成本跟收益不成比例,
// 而且要驗的東西本來就純粹是「這個常數裡的文案對不對」,不涉及任何渲染條件。
//
// 🔴 **所以刻意沒有把這些斷言塞進 `StaffPermissionsPage.test.tsx`** —— 那一頁渲染的是
// `STAFF_PERMISSION_SECTIONS`(四項自助權限,staff-portal/types.ts),**完全不是這個常數**,
// 也不是同一個畫面。硬塞進去會讓那支測試名不副實,之後有人照著那個檔名找東西會找錯地方。
//
// 對應 SPECS-INDEX #883 ①:「顯示會員資料」原本只寫「可以看到預約客戶的會員資料」,
// 沒說「會員資料」包含什麼 —— 而它實際藏著客戶的**紅利點數餘額**。

import { describe, expect, it } from "vitest";

import { STAFF_BOOLEAN_PERMISSION_FIELDS } from "./types";

function fieldByKey(key: string) {
  const field = STAFF_BOOLEAN_PERMISSION_FIELDS.find((f) => f.key === key);
  if (!field) throw new Error(`找不到 key=${key} 的權限開關定義`);
  return field;
}

describe("STAFF_BOOLEAN_PERMISSION_FIELDS 的說明文字(#883 → #977)", () => {
  // 🔴 SPECS-INDEX #977(2026-10-06,第 1 批):使用者 2026-10-02 裁決 H-13 把這個開關重新定義成
  // 「關閉時,服務人員只看得到客戶姓名,電話 / 地址都看不到」,名稱改成「服務人員是否顯示會員資料」,
  // 說明全文照規格書(.project/specs/商家端文案與說明調整-第1批.md 第四節第 5 項)。
  // 原本 #883 的兩條斷言(說明要寫出「紅利點數餘額」、要寫出「搭配行事曆檢視一起開」)是舊定義的期望值,
  // 依規格書第六節第 3 點「修正既有測試的期望值,不可刪測試」改成新定義。
  // ⚠️ 現況程式關閉時仍看得到電話、地址(bug),邏輯修正排在第 3 批;這裡只釘文案。
  it("#977:「服務人員是否顯示會員資料」名稱與新說明(關閉時只看得到客戶姓名)", () => {
    const field = fieldByKey("show_member_info");

    expect(field.label).toBe("服務人員是否顯示會員資料");
    expect(field.description).toBe(
      "關閉時，這位服務人員在自己的預約詳情只看得到客戶姓名，看不到電話、地址等聯絡資料。",
    );
  });

  it("#977:「服務人員是否顯示會員資料」要講清楚關閉時藏的是電話、地址這類聯絡資料", () => {
    const field = fieldByKey("show_member_info");

    expect(field.description).toContain("只看得到客戶姓名");
    expect(field.description).toMatch(/電話、地址/);
  });

  it("每個開關都要有非空的 label 與 description(避免之後新增開關時忘了寫說明)", () => {
    for (const field of STAFF_BOOLEAN_PERMISSION_FIELDS) {
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(field.description.trim().length).toBeGreaterThan(0);
      expect(field.type).toBe("boolean");
    }
  });
});
