// 模組 8(薪資與帳務)§4.3/§4.4/判斷 10:「匯出這份報表為 CSV」按鈕的純函式邏輯。
// 只把畫面上已經抓到的資料轉成 CSV 字串,不呼叫額外的匯出 API,不建立任何匯出排程/範本系統
// (第〇節判斷 10——這是陽春版本,更完整的報表匯出中心留給模組 12)。

/** 把一格內容轉成安全的 CSV 欄位:含逗號/雙引號/換行時要用雙引號包起來,並把內部雙引號跳脫成
 * 兩個雙引號(RFC 4180 標準做法)。 */
function escapeCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 把一整組列組成完整的 CSV 字串(含 UTF-8 BOM,避免 Excel 開啟中文亂碼)。
 *
 * 為什麼需要這支「沒有表頭概念」的版本:店家報表的 CSV 現在是**兩段不同形狀的表格疊在一起**
 * (上面是兩欄的總計區塊、下面是六欄的人員明細,中間隔一列空白),整份檔案不存在單一表頭,
 * 用 buildCsvContent(headers, rows) 表達不出來。空陣列 `[]` 會輸出一整列空白,就是段落之間的
 * 分隔列。這個格式的取捨與理由見 billingReportDisplay.ts 的 buildBillingCsvSummarySection()。
 */
export function buildCsvContentFromRows(
  rows: Array<Array<string | number | null | undefined>>,
): string {
  return "﻿" + rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

/** 把表頭 + 資料列組成完整的 CSV 字串(含 UTF-8 BOM,避免 Excel 開啟中文亂碼)。 */
export function buildCsvContent(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  return buildCsvContentFromRows([headers, ...rows]);
}

/** 觸發瀏覽器下載 CSV 檔案。純粹的瀏覽器 API 操作,不呼叫任何後端。 */
export function downloadCsv(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
