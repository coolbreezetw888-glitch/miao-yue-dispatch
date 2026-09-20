// 模組 12(資料匯入與報表匯出)§3.2/§7:CSV 解析與欄位對應的純函式驗證。
// 涵蓋:含逗號/引號/換行的欄位值、BOM 移除、非 UTF-8 內容偵測、欄位對應轉換邏輯、
// buildCsvContent 的既有規則(逐字比照模組 8 csvExport.test.ts 的既有驗證項目)。

import { describe, expect, it } from "vitest";

import { applyColumnMapping, buildCsvContent, CsvEncodingError, parseCsvText } from "./csv";

describe("parseCsvText", () => {
  it("正常解析標題列與資料列", () => {
    const { headers, rows } = parseCsvText("姓名,電話\n王小明,0911000001\n李小華,0922000002");
    expect(headers).toEqual(["姓名", "電話"]);
    expect(rows).toEqual([
      ["王小明", "0911000001"],
      ["李小華", "0922000002"],
    ]);
  });

  it("正確移除 UTF-8 BOM", () => {
    const { headers } = parseCsvText("﻿姓名,電話\n王小明,0911000001");
    expect(headers).toEqual(["姓名", "電話"]);
  });

  it("欄位值含逗號時，用雙引號包起來能正確解析成單一欄位", () => {
    const { rows } = parseCsvText('姓名,備註\n王小明,"這是,有逗號的備註"');
    expect(rows).toEqual([["王小明", "這是,有逗號的備註"]]);
  });

  it("欄位值含雙引號時，兩個連續雙引號正確解析成一個雙引號", () => {
    const { rows } = parseCsvText('姓名,備註\n王小明,"他說""你好"""');
    expect(rows).toEqual([["王小明", '他說"你好"']]);
  });

  it("欄位值含換行時(用雙引號包住)，正確解析成單一欄位而不是拆成兩列", () => {
    const { rows } = parseCsvText('姓名,備註\n王小明,"第一行\n第二行"');
    expect(rows).toEqual([["王小明", "第一行\n第二行"]]);
  });

  it("支援 CRLF 換行", () => {
    const { headers, rows } = parseCsvText("姓名,電話\r\n王小明,0911000001\r\n");
    expect(headers).toEqual(["姓名", "電話"]);
    expect(rows).toEqual([["王小明", "0911000001"]]);
  });

  it("檔案結尾多一個空白換行不會產生一筆全空的資料列", () => {
    const { rows } = parseCsvText("姓名\n王小明\n");
    expect(rows).toEqual([["王小明"]]);
  });

  it("偵測到非 UTF-8 解碼錯誤字元(U+FFFD)時，丟出 CsvEncodingError", () => {
    expect(() => parseCsvText("姓名,電話\n��,0911000001")).toThrow(CsvEncodingError);
  });

  it("正常內容不會誤判為編碼錯誤", () => {
    expect(() => parseCsvText("姓名,電話\n王小明,0911000001")).not.toThrow();
  });
});

describe("applyColumnMapping", () => {
  const headers = ["客戶姓名", "客戶電話", "備註"];
  const rows = [
    ["王小明", "0911000001", "第一次上門"],
    ["李小華", "0922000002", ""],
  ];

  it("依照對應設定，把 CSV 欄位轉成目標欄位物件", () => {
    const result = applyColumnMapping(headers, rows, {
      name: "客戶姓名",
      phone: "客戶電話",
      notes: "備註",
    });
    expect(result).toEqual([
      { name: "王小明", phone: "0911000001", notes: "第一次上門" },
      { name: "李小華", phone: "0922000002", notes: "" },
    ]);
  });

  it("選擇「不對應」(對應值為空字串)的目標欄位，不會出現在結果物件裡", () => {
    const result = applyColumnMapping(headers, rows, { name: "客戶姓名", phone: "" });
    expect(result[0]).toEqual({ name: "王小明" });
  });

  it("目標欄位對應到不存在的 CSV 標題時，該欄位不會出現在結果物件裡(不拋錯)", () => {
    const result = applyColumnMapping(headers, rows, { name: "客戶姓名", email: "不存在的欄位" });
    expect(result[0]).toEqual({ name: "王小明" });
  });

  it("欄位值前後空白會被去除", () => {
    const result = applyColumnMapping(["姓名"], [["  王小明  "]], { name: "姓名" });
    expect(result[0]?.["name"]).toBe("王小明");
  });
});

describe("buildCsvContent(沿用既有規則，逐字比照模組 8 csvExport.test.ts)", () => {
  it("正常欄位直接用逗號組合，並帶有 UTF-8 BOM 開頭", () => {
    const csv = buildCsvContent(["姓名", "金額"], [["王小明", 100]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿姓名,金額\r\n王小明,100");
  });

  it("內容含逗號時，整格用雙引號包起來", () => {
    const csv = buildCsvContent(["備註"], [["這是,有逗號的備註"]]);
    expect(csv).toContain('"這是,有逗號的備註"');
  });

  it("null/undefined 一律轉成空字串", () => {
    const csv = buildCsvContent(["欄位"], [[null], [undefined]]);
    expect(csv).toBe("﻿欄位\r\n\r\n");
  });
});
