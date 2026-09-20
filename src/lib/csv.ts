// 模組 12(資料匯入與報表匯出)§3.2:CSV 解析與欄位對應共用工具。
//
// 檢查結果(規格書要求動工前先確認):既有模組(模組 8 payroll/csvExport.ts)已經有一份「陽春版」
// 的 CSV 匯出工具(buildCsvContent/downloadCsv),但那支檔案的檔案開頭註解明講「更完整的報表
// 匯出中心留給模組 12」,而且它完全沒有 CSV「解析」(parseCsv)的能力——這次的匯入精靈需要的
// 是相反方向(讀取使用者上傳的 CSV 檔案),兩者職責不同。規格書 §3.2 本身也明確指定新檔案路徑
// 是 src/lib/csv.ts,不是延伸 payroll 模組內部檔案(那樣會讓報表模組意外依賴資料匯入模組，
// 違反模組獨立性)。因此這裡新增一份共用工具，匯出/下載的部分（buildCsvContent/downloadCsv）
// 刻意跟 payroll/csvExport.ts 維持幾乎相同的實作（RFC 4180 跳脫規則、UTF-8 BOM），但不 import
// 既有檔案，也不強迫既有已經上線、運作正常的匯出按鈕改用這裡（規格書 §3.2 明講不強制重構）。

/** 判斷 8:CSV 必須是 UTF-8 編碼，不自動偵測 Big5 等其他編碼。這個正則抓「明顯的解碼錯誤字元」
 * ——瀏覽器用 TextDecoder('utf-8') 解碼非 UTF-8 內容時，無法正常解碼的位元組會變成
 * U+FFFD(replacement character，顯示成一個菱形問號)，抓到這個字元就代表檔案很可能不是
 * UTF-8。 */
const REPLACEMENT_CHARACTER = "�";

export class CsvEncodingError extends Error {
  constructor() {
    super("這個檔案可能不是 UTF-8 編碼，請確認匯出時選擇「CSV UTF-8(逗號分隔)」格式後重新上傳。");
    this.name = "CsvEncodingError";
  }
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** 把單一 CSV 文字內容解析成 headers + rows（處理引號跳脫、逗號、換行）。抽成獨立函式方便
 * Vitest 直接測字串邏輯，不需要真的建立 File 物件。 */
export function parseCsvText(text: string): ParsedCsv {
  // 移除 UTF-8 BOM（如果有）。
  const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  if (content.includes(REPLACEMENT_CHARACTER)) {
    throw new CsvEncodingError();
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // 忽略，交給接下來的 \n（或單獨的 \r，視為換行）統一處理。
      if (next !== "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
      }
    } else if (char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // 收尾:最後一欄/一列(檔案結尾通常沒有換行符)。
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 過濾掉完全空白的列(常見於檔案結尾多一個換行)。
  const nonEmptyRows = rows.filter((r) => !(r.length === 1 && r[0] === ""));

  const [headers, ...dataRows] = nonEmptyRows;
  return { headers: headers ?? [], rows: dataRows };
}

/** 讀取使用者上傳的 CSV 檔案，回傳 headers + rows。 */
export function parseCsv(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("讀取檔案失敗，請確認檔案沒有毀損後重新上傳。"));
    reader.onload = () => {
      try {
        const text = reader.result as string;
        resolve(parseCsvText(text));
      } catch (err) {
        reject(err);
      }
    };
    // 明確指定 utf-8 解碼；非 UTF-8 內容會在解碼過程中產生 U+FFFD，由 parseCsvText 偵測擋下
    // (判斷 8:不嘗試自動偵測其他編碼)。
    reader.readAsText(file, "utf-8");
  });
}

export type ColumnMapping = Record<string, string>; // { 目標欄位: CSV 標題文字 }

/** 依照使用者設定的欄位對應，把原始的 string[][] 轉換成 {目標欄位: 值}[] 的物件陣列。
 * 對應不到欄位(使用者選「不對應」)或 CSV 該欄位是空字串時，值一律是 undefined/空字串，
 * 由後端函式的必填檢查決定要不要視為錯誤。 */
export function applyColumnMapping(
  headers: string[],
  rows: string[][],
  mapping: ColumnMapping,
): Record<string, string>[] {
  const headerIndex = new Map(headers.map((h, i) => [h, i]));

  return rows.map((row) => {
    const result: Record<string, string> = {};
    for (const [targetField, csvHeader] of Object.entries(mapping)) {
      if (!csvHeader) continue;
      const idx = headerIndex.get(csvHeader);
      if (idx === undefined) continue;
      result[targetField] = (row[idx] ?? "").trim();
    }
    return result;
  });
}

/** 把一格內容轉成安全的 CSV 欄位(RFC 4180)。 */
function escapeCsvCell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 把表頭 + 資料列組成完整的 CSV 字串(含 UTF-8 BOM，避免 Excel 開啟中文亂碼)。 */
export function buildCsvContent(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
): string {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return "﻿" + lines.join("\r\n");
}

/** 觸發瀏覽器下載 CSV 檔案。 */
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
