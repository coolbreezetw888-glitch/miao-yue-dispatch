// 模組 8(薪資與帳務)§7:CSV 匯出按鈕的純函式驗證——只測「畫面資料 → CSV 字串」的轉換邏輯
// (欄位、逗號跳脫等),不測 downloadCsv(那是純粹的瀏覽器 DOM 操作,沒有邏輯好測)。

import { describe, expect, it } from "vitest";

import { buildCsvContent, buildCsvContentFromRows } from "./csvExport";

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

// 2026-09-24 使用者裁決 A:店家報表的 CSV 變成「兩段不同形狀的表格疊在同一個檔案」(上面兩欄的
// 總計區塊、下面六欄的人員明細),中間靠一列空白隔開。空白列是這個格式能被人看懂的關鍵,所以
// 這裡把「空陣列 → 一整列空白」這個行為釘住,不要哪天被當成無意義的空資料順手過濾掉。
describe("buildCsvContentFromRows(沒有單一表頭的 CSV,給總計區塊 + 明細疊在一起用)", () => {
  it("每個陣列輸出一列,一樣帶 UTF-8 BOM 開頭", () => {
    const csv = buildCsvContentFromRows([
      ["報表區間", "2026-09-01 ~ 2026-09-30"],
      ["項目", "金額"],
      ["總營收(未稅)", 2000],
    ]);

    expect(csv).toBe("\uFEFF報表區間,2026-09-01 ~ 2026-09-30\r\n項目,金額\r\n總營收(未稅),2000");
  });

  it("空陣列輸出一整列空白(兩段表格之間的分隔列)", () => {
    const csv = buildCsvContentFromRows([["項目", "金額"], [], ["姓名", "計酬類型"]]);

    expect(csv).toBe("\uFEFF項目,金額\r\n\r\n姓名,計酬類型");
  });

  it("buildCsvContent 就是「第一列當表頭」的這支函式(兩者不會各寫一份跳脫規則)", () => {
    expect(buildCsvContent(["姓名", "金額"], [["王小明", 100]])).toBe(
      buildCsvContentFromRows([
        ["姓名", "金額"],
        ["王小明", 100],
      ]),
    );
  });
});
