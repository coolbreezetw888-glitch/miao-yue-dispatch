// 模組 12「匯入失敗清單 CSV」的組裝邏輯(原本 inline 在 ImportWizardPage.tsx 的
// handleDownloadFailedRows 裡,SPECS-INDEX #925 為了能被 Vitest 直接驗證而抽出來;行為只改一處,見下)。
//
// 這份檔案的內容是**使用者自己上傳的原始資料**被後端原樣退回(error_report.raw_data),最典型的
// 用途是「下載 → 在 Excel 修正 → 再匯入」。所以兩件事都要成立:
//   ① 公式注入防護:儲存格一律經過 src/lib/csv.ts 的 buildCsvContent(共用 escapeCsvCell)。
//   ② 再匯入不變形:匯入端 parseCsvText 會把防護補上的單引號拿掉(unescapeCsvFormulaGuard)。
//
// #925 唯一的行為改動:原本每一格都先 String(...) 才交給 builder,number(例如起始點數餘額 -100)
// 也被轉成字串 ⇒ 套上公式防護後會變成 '-100(Excel 裡變文字)。規格書第二章規則 3 要求 number
// 型別維持原樣,所以 number 直接傳下去,其餘型別照舊轉字串。
import { buildCsvContent } from "@/lib/csv";

export function buildFailedRowsCsv(rawFailedRows: Record<string, unknown>[]): string {
  const headers = Array.from(new Set(rawFailedRows.flatMap((r) => Object.keys(r))));
  const rows = rawFailedRows.map((r) =>
    headers.map((h) => {
      const v = r[h];
      if (v === undefined || v === null) return "";
      return typeof v === "number" ? v : String(v);
    }),
  );
  return buildCsvContent(headers, rows);
}
