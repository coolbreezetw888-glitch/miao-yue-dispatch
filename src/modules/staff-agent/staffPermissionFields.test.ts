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

describe("STAFF_BOOLEAN_PERMISSION_FIELDS 的說明文字(#883)", () => {
  it("#883 ①:「顯示會員資料」要寫出實際包含哪些內容,尤其是紅利點數餘額", () => {
    const field = fieldByKey("show_member_info");

    expect(field.label).toBe("顯示會員資料");
    // 三個實際欄位(is_member / member_name / member_points_balance)都要用白話講出來。
    expect(field.description).toContain("是不是會員");
    expect(field.description).toContain("會員姓名");
    // 🔴 這是 #883 的重點:點數餘額原本完全沒被提到。
    expect(field.description).toContain("紅利點數餘額");
  });

  it("#883 ①:「顯示會員資料」要寫出「要搭配行事曆檢視一起開」這個前提", () => {
    const field = fieldByKey("show_member_info");

    // get_my_booking_schedule 先檢查 has_own_staff_permission(staff_calendar_view),
    // 再用 show_member_info 決定三個會員欄位 ⇒ 兩個開關都開才看得到。
    // 少寫這個前提,管理員會以為只開這一項就有效。
    expect(field.description).toContain("行事曆檢視");
    expect(field.description).toMatch(/一起開|都開/);
  });

  it("每個開關都要有非空的 label 與 description(避免之後新增開關時忘了寫說明)", () => {
    for (const field of STAFF_BOOLEAN_PERMISSION_FIELDS) {
      expect(field.label.trim().length).toBeGreaterThan(0);
      expect(field.description.trim().length).toBeGreaterThan(0);
      expect(field.type).toBe("boolean");
    }
  });
});
