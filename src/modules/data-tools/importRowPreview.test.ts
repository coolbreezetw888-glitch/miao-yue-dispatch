// SPECS-INDEX #824:匯入精靈步驟四「預覽」的電話格式預檢。
// 這份測試釘的是「預覽的判斷要跟後端 import_*_batch 一致」——後端那邊由
// supabase/tests/database/module12_03_import_phone_validation.sql 釘住,兩邊用同一組例子。
//
// 故障注入紀錄(engineer 2026-09-28 實際做過):暫時把 checkImportRowPreview 裡兩段電話格式判斷關掉
// (`if (false && ...)`)→ 5/13 轉紅:「會員:3 碼」「會員:手機帶分機」「歷史訂單:3 碼」「歷史訂單:純英文」
// (症狀都是 expected true to be false)以及「檢查順序:電話格式錯誤排在服務人員之前」
// (拿到的是「服務人員尚未完成對應」),其餘 8 條正向對照仍綠;檔案還原(md5 相同)後 13/13 全綠。
import { describe, expect, it } from "vitest";

import { checkImportRowPreview } from "./importRowPreview";

const validBookingRow = {
  customer_name: "客戶",
  customer_phone: "0912345678",
  staff_id: "00000000-0000-4000-8000-000000000001",
  start_at: "2024-05-01T10:00:00+08:00",
  final_amount: "1000",
};

describe("checkImportRowPreview — 會員匯入", () => {
  it("正向對照:合法手機(帶連字號)→ 看起來會成功", () => {
    expect(checkImportRowPreview("members", { name: "甲", phone: "0912-345-678" })).toEqual({
      ok: true,
    });
  });

  it("正向對照:合法市話 + 分機 → 看起來會成功", () => {
    expect(checkImportRowPreview("members", { name: "甲", phone: "02-1234-5678#123" })).toEqual({
      ok: true,
    });
  });

  it("正向對照:電話留空 → 看起來會成功(#618 之後會員電話是選填,格式檢查只在有填時做)", () => {
    expect(checkImportRowPreview("members", { name: "甲", phone: "" })).toEqual({ ok: true });
    expect(checkImportRowPreview("members", { name: "甲" })).toEqual({ ok: true });
  });

  it("3 碼電話 → 標紅,理由講明是電話格式", () => {
    const r = checkImportRowPreview("members", { name: "甲", phone: "123" });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("電話格式不正確");
    expect(r.reason).toContain("09 開頭共 10 碼");
  });

  it("手機帶分機 → 標紅(分機只接在市話後面)", () => {
    expect(checkImportRowPreview("members", { name: "甲", phone: "0912345678#123" }).ok).toBe(
      false,
    );
  });

  it("既有規則沒被打亂:缺姓名還是「缺少姓名」,而且優先於電話格式", () => {
    expect(checkImportRowPreview("members", { name: "", phone: "123" })).toEqual({
      ok: false,
      reason: "缺少姓名",
    });
  });
});

describe("checkImportRowPreview — 歷史訂單匯入", () => {
  it("正向對照:合法列 → 看起來會成功", () => {
    expect(checkImportRowPreview("historical_bookings", validBookingRow)).toEqual({ ok: true });
  });

  it("正向對照:市話帶括號與分機 → 看起來會成功(分隔符號不強制)", () => {
    expect(
      checkImportRowPreview("historical_bookings", {
        ...validBookingRow,
        customer_phone: "(02) 1234-5678#99",
      }),
    ).toEqual({ ok: true });
  });

  it("3 碼客戶電話 → 標紅,理由講明是客戶電話格式", () => {
    const r = checkImportRowPreview("historical_bookings", {
      ...validBookingRow,
      customer_phone: "123",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("客戶電話格式不正確");
  });

  it("純英文客戶電話 → 標紅", () => {
    expect(
      checkImportRowPreview("historical_bookings", {
        ...validBookingRow,
        customer_phone: "abcdefghij",
      }).ok,
    ).toBe(false);
  });

  it("檢查順序:沒填客戶電話還是「缺少客戶電話」,不是格式錯誤(跟後端同一個順序)", () => {
    expect(
      checkImportRowPreview("historical_bookings", { ...validBookingRow, customer_phone: "" }),
    ).toEqual({
      ok: false,
      reason: "缺少客戶電話",
    });
  });

  it("檢查順序:電話格式錯誤排在「服務人員尚未完成對應」之前(電話先於後面欄位)", () => {
    const r = checkImportRowPreview("historical_bookings", {
      ...validBookingRow,
      customer_phone: "123",
      staff_id: null,
    });
    expect(r.reason).toContain("客戶電話格式不正確");
  });

  it("既有規則沒被打亂:訂單金額缺漏還是原本那句", () => {
    expect(
      checkImportRowPreview("historical_bookings", { ...validBookingRow, final_amount: "" }),
    ).toEqual({ ok: false, reason: "訂單金額缺漏或格式錯誤" });
  });
});
