// SPECS-INDEX #985 第 8 批 8-11:服務人員報表 / 報表匯出中心 / 服務人員自己看的薪資明細,每筆抽成
// 多一個「扣除料錢」。畫面與 CSV 共用同一組判斷,避免兩邊各寫一份 fallback 之後漂移
// (billingReportDisplay.ts 檔頭記錄過的同一種失敗模式)。
//
// 規則(規格書 8-11):
//   ・畫面:0 顯示「—」(這筆抽成沒有扣料錢);有扣就顯示金額。
//   ・CSV:0 輸出 0(數字欄,方便 Excel 加總)。
//   ・資料庫先上、前端後上的過渡期:舊回應沒有這個 key ⇒ 畫面「—」、CSV 空白(不知道就不要猜成 0)。

import { formatAmount } from "@/modules/booking/orderAmount";

import type { StaffCommissionSummary } from "./types";

export type MaterialCostDeductedFields = Pick<
  StaffCommissionSummary["details"][number],
  "material_cost_deducted"
>;

/** 「扣除料錢」欄的標題(畫面 DetailRow 與兩份 CSV 共用)。 */
export const MATERIAL_COST_DEDUCTED_LABEL = "扣除料錢";

export function materialCostDeductedText(detail: MaterialCostDeductedFields): string {
  const value = detail.material_cost_deducted;
  if (typeof value !== "number" || Number.isNaN(value) || value === 0) return "—";
  return formatAmount(value);
}

export function materialCostDeductedCsvValue(detail: MaterialCostDeductedFields): number | string {
  const value = detail.material_cost_deducted;
  if (typeof value !== "number" || Number.isNaN(value)) return "";
  return value;
}
