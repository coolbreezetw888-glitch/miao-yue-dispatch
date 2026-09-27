// 模組 12(資料匯入)— 匯入精靈步驟四「預覽」的逐列預檢(純函式)。
//
// 這裡只是**體驗層**的預檢:讓商家在按下「確認匯入」之前就看到哪幾列會失敗,真正的守門在後端
// import_members_batch / import_historical_bookings_batch(它們逐列 raise → 進 error_report)。
// 所以這裡的每一條規則都必須跟後端一致,不能比後端嚴、也不能比後端鬆——不然預覽會顯示跟送出後
// 實際結果不一樣的狀態(e2e/data-import-members.spec.ts 抓過一次這種不一致)。
//
// SPECS-INDEX #824(2026-09-28):電話格式預檢。規則本體沿用 src/lib/validation.ts 的 isValidTaiwanPhone
// (跟後端 private.is_valid_taiwan_phone 逐字對應),這裡不另外寫正規表示式。
//
// 原本這段邏輯是 ImportWizardPage.tsx 裡的 rowLooksValid(),為了讓它能被 Vitest 單獨測試而抽出來,
// 判斷順序與既有文案完全沒變,只多了電話格式那兩條。

import { isValidTaiwanPhone } from "@/lib/validation";

import type { ImportKind } from "./types";

export interface ImportRowPreviewResult {
  ok: boolean;
  reason?: string;
}

/** 預覽欄位空間有限,這裡用一句精簡版提示;完整的白話說明(含範例)由後端 error_report 提供。 */
export const IMPORT_PHONE_FORMAT_HINT =
  "手機 09 開頭共 10 碼,市話含區碼共 9~10 碼,分機用 # 接在後面";

// ⚠️ 跨模組異動說明(2026-09-22,模組 10 會員與紅利 SPECS-INDEX #618 疊加,由該批次的
// engineer 順手修正,已在回報時提出讓主腦知悉,不是本模組自己的規劃):
// merchant_member_settings.phone_required_to_create 這個開關已經被 #618 移除(電話不再是
// create_member/update_member 的必填欄位,改成純查詢索引,見會員與紅利.md §10.2/§10.6)。
// 原本這裡讀取這個設定值來決定步驟四預覽要不要擋下「缺電話」的資料列,現在後端已經不會再擋,
// 這裡跟著改成一律不要求電話——不然步驟四預覽會顯示跟後端實際驗證邏輯不一致的錯誤訊息。
// 這個常數維持存在(而不是直接刪掉下面的 if 判斷式),是為了在程式碼裡留下清楚的變更紀錄,
// 方便之後模組 12 的維護者一眼看懂「這裡曾經有必填檢查,後來因為模組 10 的決策而移除」。
// (export 是因為 ImportWizardPage 步驟二的模板說明文字也用它顯示「這個商家目前不要求建立會員時必填電話」。)
export const phoneRequiredForMembers = false;

function asTrimmedString(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

/** 回傳這一列在預覽表格「狀態」欄要顯示的結果。importKind 為 null 時沿用歷史訂單的判斷(跟抽出來之前
 * 的 if/else 結構一致;實際上到得了預覽步驟時 importKind 一定已經選好)。 */
export function checkImportRowPreview(
  importKind: ImportKind | null,
  row: Record<string, unknown>,
): ImportRowPreviewResult {
  if (importKind === "members") {
    if (!row["name"]) return { ok: false, reason: "缺少姓名" };
    if (phoneRequiredForMembers && !row["phone"]) {
      return { ok: false, reason: "這個商家要求建立會員時必須填寫電話" };
    }
    // #824:會員電話是選填,留空放行;有填就要符合客戶電話規則(跟後端 import_members_batch 同一個順序)。
    const phone = asTrimmedString(row["phone"]);
    if (phone && !isValidTaiwanPhone(phone)) {
      return { ok: false, reason: `電話格式不正確(${IMPORT_PHONE_FORMAT_HINT})` };
    }
    return { ok: true };
  }
  if (!row["customer_name"]) return { ok: false, reason: "缺少客戶姓名" };
  if (!row["customer_phone"]) return { ok: false, reason: "缺少客戶電話" };
  // #824:客戶電話必填且要符合格式(跟後端 import_historical_bookings_batch 同一個順序:先非空、再格式)。
  if (!isValidTaiwanPhone(asTrimmedString(row["customer_phone"]))) {
    return { ok: false, reason: `客戶電話格式不正確(${IMPORT_PHONE_FORMAT_HINT})` };
  }
  if (!row["staff_id"]) return { ok: false, reason: "服務人員尚未完成對應" };
  if (!row["start_at"] || Number.isNaN(Date.parse(String(row["start_at"])))) {
    return { ok: false, reason: "預約時間格式無法辨識" };
  }
  if (
    row["final_amount"] === undefined ||
    row["final_amount"] === "" ||
    Number.isNaN(Number(row["final_amount"]))
  ) {
    return { ok: false, reason: "訂單金額缺漏或格式錯誤" };
  }
  return { ok: true };
}
