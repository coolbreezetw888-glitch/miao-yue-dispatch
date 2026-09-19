// 模組 8(薪資與帳務)§7:CSV 匯出按鈕的純函式驗證——只測「畫面資料 → CSV 字串」的轉換邏輯
// (欄位、逗號跳脫等),不測 downloadCsv(那是純粹的瀏覽器 DOM 操作,沒有邏輯好測)。

import { describe, expect, it } from "vitest";

import { buildCsvContent } from "./csvExport";

describe("buildCsvContent", () => {
  it("正常欄位直接用逗號組合,並帶有 UTF-8 BOM 開頭", () => {
    const csv = buildCsvContent(["姓名", "金額"], [["王小明", 100]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe("﻿姓名,金額\r\n王小明,100");
  });

  it("內容含逗號時,整格用雙引號包起來", () => {
    const csv = buildCsvContent(["備註"], [["這是,有逗號的備註"]]);
    expect(csv).toContain('"這是,有逗號的備註"');
  });

  it("內容含雙引號時,內部雙引號跳脫成兩個雙引號", () => {
    const csv = buildCsvContent(["備註"], [['他說"你好"']]);
    expect(csv).toContain('"他說""你好"""');
  });

  it("內容含換行時,整格用雙引號包起來", () => {
    const csv = buildCsvContent(["備註"], [["第一行\n第二行"]]);
    expect(csv).toContain('"第一行\n第二行"');
  });

  it("null/undefined 一律轉成空字串,不是「null」文字", () => {
    const csv = buildCsvContent(["欄位"], [[null], [undefined]]);
    expect(csv).toBe("﻿欄位\r\n\r\n");
  });

  it("多筆資料列正確用 CRLF 分隔", () => {
    const csv = buildCsvContent(["姓名"], [["甲"], ["乙"], ["丙"]]);
    expect(csv.split("\r\n")).toHaveLength(4);
  });
});
