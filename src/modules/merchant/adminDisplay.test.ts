// adminDisplay.ts 的單元測試(2026-09-24)。
// 這些 fallback 規則同時被商家端 MerchantAdminList.tsx 與超級管理員端
// platform-admin/MerchantDetailPage.tsx 兩頁共用,所以「規則會不會漂移」才是這裡真正要釘住的事:
// 資料庫刻意不 coalesce 那三個欄位(否則前端分不出「真的沒填」跟「填了預設字」),null 的處理
// 全靠這幾支函式。
//
// ⚠️ 原本還有一組 describe("adminContactEmailToShow") 的測試(5 條),2026-09-24 使用者裁決
//    「登入和聯絡信箱應該要是一致的」「客服和服務人員應該也是一樣只需要一個 Email 即可」之後,
//    那支函式整個變成死碼已被刪除,對應的測試也一起刪掉。名單上的「Email」欄位從此固定是
//    登入 Email(MerchantAdminUser.email),沒有第二個 Email 需要比較。

import { describe, expect, it } from "vitest";

import {
  ADMIN_PHONE_PLACEHOLDER,
  adminDisplayName,
  adminJobTitle,
  DEFAULT_ADMIN_JOB_TITLE,
} from "./adminDisplay";

describe("adminDisplayName", () => {
  it("有暱稱就直接用暱稱", () => {
    expect(adminDisplayName({ display_name: "王小明", email: "wang@example.com" })).toBe("王小明");
  });

  it("暱稱是 null 時 fallback 成登入 email 的 @ 前半段", () => {
    expect(adminDisplayName({ display_name: null, email: "wang@example.com" })).toBe("wang");
  });

  it("暱稱只有空白時視為沒填,一樣 fallback(不能顯示一整排空白看起來像壞掉)", () => {
    expect(adminDisplayName({ display_name: "   ", email: "wang@example.com" })).toBe("wang");
  });

  it("暱稱前後有空白時會 trim 掉", () => {
    expect(adminDisplayName({ display_name: "  王小明  ", email: "wang@example.com" })).toBe(
      "王小明",
    );
  });

  it("email 沒有 @ 這種異常資料時整串顯示,不會回傳空字串", () => {
    expect(adminDisplayName({ display_name: null, email: "weird-account" })).toBe("weird-account");
  });

  it("email 以 @ 開頭這種異常資料也不會回傳空字串", () => {
    // indexOf("@") === 0,slice(0,0) 會是空字串,所以這裡刻意要求整串顯示。
    expect(adminDisplayName({ display_name: null, email: "@example.com" })).toBe("@example.com");
  });
});

describe("adminJobTitle", () => {
  it("有職位就用職位", () => {
    expect(adminJobTitle({ job_title: "店長" })).toBe("店長");
  });

  it("職位是 null 或空白時 fallback 成「商家管理員」", () => {
    expect(adminJobTitle({ job_title: null })).toBe(DEFAULT_ADMIN_JOB_TITLE);
    expect(adminJobTitle({ job_title: "  " })).toBe(DEFAULT_ADMIN_JOB_TITLE);
  });
});

describe("常數", () => {
  it("fallback 字串維持既有慣例", () => {
    expect(DEFAULT_ADMIN_JOB_TITLE).toBe("商家管理員");
    expect(ADMIN_PHONE_PLACEHOLDER).toBe("未填");
  });
});
