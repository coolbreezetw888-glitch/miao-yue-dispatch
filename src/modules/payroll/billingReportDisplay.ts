// 模組 8(薪資與帳務)— 店家報表頁(BillingReportPage.tsx)的「該顯示數字、還是該顯示說明文字」
// 純判斷邏輯。
//
// ⚠️ 為什麼這幾個判斷一定要抽出來 + 寫單元測試(這是這支檔案存在的唯一理由,請不要把它併回元件):
//
// 這一頁有兩個 2026-09-24 由使用者親自裁決的顯示行為,而且它們的失敗模式**不會讓畫面壞掉、也不會
// 有任何錯誤訊息**,只會讓老闆看到一個看起來完全正常、實際上大錯的數字:
//
//  行為 A(月薪不適用時不能顯示 0)
//    資料庫端在「查詢區間不是完整月份」時,刻意讓月薪基本額/月薪扣款/月薪實發/商家總淨利回傳
//    **null 而不是 0**——就是為了讓前端能分辨「這次算不出來」與「真的是零」。如果哪天有人為了
//    讓型別好看、或為了讓畫面不要出現空白,順手寫了 `?? 0`,商家就會看到「月薪基本額 0 元、
//    商家總淨利 = 營收全額」:一個沒有任何症狀、卻會讓人誤判獲利的假數字。
//    (這個 null 設計同時修掉一個真 bug:查 2/15~3/15 原本會拿到**兩個整月**的月薪基本額,
//     而扣款那一邊卻按區間裁切,兩邊口徑不一致。)
//
//  行為 B(期間內在職、現在已離職的人要標「已離職」)
//    使用者裁決:「一樣是留歷史紀錄的概念,即便這個人離職,紀錄還是存在…既然有紀錄怎麼可能跨月
//    就把紀錄刪除了?」所以明細會列出這些人,那一列必須有標籤,不然商家看到一個名單上早就沒有的
//    人出現在報表裡,會以為系統壞了。
//
// 本專案已經有既有慣例:這類「該顯示哪一種狀態」的判斷一律抽成純函式 + 單元測試,不寫死在元件裡
// (見 src/routes/appLayoutLogic.ts、src/modules/staff-agent/staffListLogic.ts、
//  src/modules/line-notifications/lineBindingViewLogic.ts)。這支檔案只依賴 ./types 這個純型別
// 檔案,不 import 任何會建立 supabase client 的模組,Vitest 匯入時不會觸發連線初始化。

import type { MerchantBillingSummary } from "./types";

/** 月薪相關數字算不出來時顯示的文字。集中成一個常數,讓四張卡片、說明表格欄位、CSV 的用字完全
 * 一致(同一件事在同一頁出現五次,不能有五種說法)。 */
export const SALARY_UNAVAILABLE_TEXT = "需選擇完整月份才能計算";

/** 明細列上「這個人現在已經不在名單上了」的標籤文字。畫面 Badge 跟 CSV 的「在職狀態」欄共用同一
 * 份字串,避免兩邊各寫一次然後哪天只改了一邊。 */
export const RESIGNED_LABEL = "已離職";

/** CSV「在職狀態」欄的另一半。 */
export const EMPLOYED_LABEL = "在職";

/**
 * 一個月薪相關數字的顯示結果。刻意做成兩種 kind 的聯集,而不是「回傳 number | null 讓呼叫端自己
 * 判斷」:呼叫端拿到 `kind: "unavailable"` 時**只能**拿到 text,連要印 0 都印不出來,這樣就不會
 * 有人在元件裡不小心補上 `?? 0`。
 */
export type SalaryDisplay =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "unavailable"; readonly text: string };

/**
 * 行為 A 的核心判斷:這個月薪數字現在該顯示數字,還是該顯示說明文字?
 *
 * 兩個參數**都要看**,不能只看其中一個:
 *   ・salaryApplicable === false → 這次查詢的區間不是完整月份,整組月薪數字都不適用。
 *   ・value === null → 旗標說可以算,但這一格自己沒有值(例如某位月薪制人員的 net_pay 是 null)。
 *     這種情況一樣要顯示說明文字,不能顯示空白或 0。
 *
 * ⚠️ salaryApplicable 的型別是 `boolean | undefined`,而不是 `boolean`,這是如實反映現實而不是
 *    偷懶:summary 在載入中/載入失敗時是 undefined,`summary?.salary_applicable` 也就是
 *    undefined。那條路徑走的是元件的 `isLoading ? … : error ? …` 分支,根本不會進到這些顯示點,
 *    但型別不該為了好看而假裝 summary 一定存在。undefined 一律當成「不能算」處理(fail-closed:
 *    不知道能不能算的時候,顯示說明文字遠比顯示一個數字安全)。
 *
 * ⚠️ 反過來也一樣重要:value === 0 且 salaryApplicable === true 時**必須**回傳 kind: "value"。
 *    「這個月的月薪扣款真的是 0」是完全合法的真實數字,不可以被當成「算不出來」吞掉。
 *    同理,負數(例如商家總淨利 -5000,也就是虧損)也是合法的真實數字。
 */
export function resolveSalaryDisplay(
  salaryApplicable: boolean | undefined,
  value: number | null | undefined,
): SalaryDisplay {
  if (salaryApplicable !== true || value === null || value === undefined) {
    return { kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT };
  }
  return { kind: "value", value };
}

/**
 * 把一個 SalaryDisplay 轉成 SummaryCard 的 `value` prop:能算就是數字,不能算就是 null
 * (SummaryCard 拿到 null 會顯示 unavailableText)。
 *
 * ⚠️ 這裡的 null 跟「值本身是 0」是兩件不同的事,SummaryCard 也是這樣處理的
 *    (`value === null || value === undefined` 才顯示說明文字,0 會正常印成「0 元」)。
 */
export function salaryDisplayValue(display: SalaryDisplay): number | null {
  return display.kind === "value" ? display.value : null;
}

/**
 * 給 SummaryCard 的 `value` prop 用的一步到底版本。這是 resolveSalaryDisplay 的薄包裝,
 * 不是另一套判斷。
 */
export function salaryCardValue(
  salaryApplicable: boolean | undefined,
  value: number | null | undefined,
): number | null {
  return salaryDisplayValue(resolveSalaryDisplay(salaryApplicable, value));
}

/** resolveNetMonthlySalary / resolveNetMargin 只需要 summary 的這幾個欄位。用 Pick 而不是整個
 * MerchantBillingSummary,測試才不用為了測一個減法去編出一整份報表。 */
export type SalarySummaryFields = Pick<
  MerchantBillingSummary,
  "salary_applicable" | "total_monthly_salary_base" | "total_monthly_salary_deduction"
>;

/**
 * 月薪實發合計 = 月薪基本額 − 月薪扣款。
 *
 * 任一邊算不出來(null)整個就算不出來——刻意不用 `?? 0` 補其中一邊,那會算出一個看起來合理、
 * 實際上錯的數字(基本額 null 當 0、扣款有值,實發就變成負數)。
 *
 * summary 可能是 undefined(載入中/載入失敗),這裡如實接受並回傳「算不出來」。
 */
export function resolveNetMonthlySalary(summary: SalarySummaryFields | undefined): SalaryDisplay {
  if (summary === undefined) {
    return { kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT };
  }
  const base = resolveSalaryDisplay(summary.salary_applicable, summary.total_monthly_salary_base);
  const deduction = resolveSalaryDisplay(
    summary.salary_applicable,
    summary.total_monthly_salary_deduction,
  );
  if (base.kind !== "value" || deduction.kind !== "value") {
    return { kind: "unavailable", text: SALARY_UNAVAILABLE_TEXT };
  }
  return { kind: "value", value: base.value - deduction.value };
}

/**
 * 「月薪算不出來」的那段說明文字(解釋為什麼、以及該怎麼做才看得到)要不要出現。
 *
 * 只有在旗標明確是 true 時才不顯示。undefined 走的是載入中分支、畫面根本不會渲染到這裡,
 * 但判斷上跟 resolveSalaryDisplay 保持同一個 fail-closed 方向,不寫成兩種語意。
 */
export function shouldShowSalaryUnavailableNotice(salaryApplicable: boolean | undefined): boolean {
  return salaryApplicable !== true;
}

/** 明細列 / CSV 用得到的欄位。 */
export type StaffBreakdownRow = MerchantBillingSummary["per_staff_breakdown"][number];

/**
 * 明細表「抽成金額 / 月薪淨額」那一欄,月薪制那一半要顯示的文字。
 *
 * 原本寫 `row.net_pay ?? 0` → 區間不是完整月份時會顯示「0 元(淨額)」,這正是使用者裁決要避免的
 * 誤導。按件計酬的抽成不受這個旗標影響,由呼叫端自己處理,不走這支函式。
 */
export function monthlySalaryCellText(
  salaryApplicable: boolean | undefined,
  netPay: number | null | undefined,
): string {
  const display = resolveSalaryDisplay(salaryApplicable, netPay);
  return display.kind === "value" ? `${display.value} 元(淨額)` : display.text;
}

/**
 * CSV「月薪淨額」欄的一格。
 *
 * 月薪算不出來時寫進說明文字,**不留空白格**——CSV 的空白格在 Excel 裡看起來跟 0 很像,會重演
 * 「商家以為這段期間沒有月薪成本」這個誤會。按件計酬的人本來就沒有月薪淨額,維持原本的空字串。
 * 判斷條件跟畫面表格那一欄走同一支 resolveSalaryDisplay,讓畫面跟匯出檔永遠一致。
 */
export function monthlySalaryCsvCell(
  salaryApplicable: boolean | undefined,
  row: Pick<StaffBreakdownRow, "compensation_type" | "net_pay">,
): string | number {
  if (row.compensation_type !== "monthly_salary") {
    return row.net_pay ?? "";
  }
  const display = resolveSalaryDisplay(salaryApplicable, row.net_pay);
  return display.kind === "value" ? display.value : display.text;
}

// =========================================================================
// 行為 B:在職 / 已離職
// =========================================================================

/**
 * 明細表/CSV 的「現在還在職嗎」判斷。
 *
 * is_active_as_of = false 代表「查詢期間在職、但現在已離職」。這種人照樣出現在明細裡(留歷史紀錄,
 * 明細加總才跟上方卡片對得起來),所以需要標籤。
 *
 * 保留這支具名小工具、而不是在三個呼叫點各寫一次 `row.is_active_as_of`:畫面標籤、CSV 欄位、
 * 表格列三處必須是同一個判斷,而且「is_active_as_of=false 代表已離職」這件事需要一個名字才讀得懂。
 */
export function isStillEmployed(row: Pick<StaffBreakdownRow, "is_active_as_of">): boolean {
  return row.is_active_as_of;
}

/** 明細列的名字旁邊要不要出現「已離職」標籤。 */
export function shouldShowResignedBadge(row: Pick<StaffBreakdownRow, "is_active_as_of">): boolean {
  return !isStillEmployed(row);
}

/**
 * CSV「在職狀態」欄的文字。
 *
 * CSV 一定要帶這個資訊:匯出的用途正是「把報表帶離系統」(丟給會計、自己在 Excel 對帳),那個情境
 * 下使用者看不到畫面上的「已離職」標籤,離職人員的數字就跟現職人員混在一起完全無法分辨,等於把
 * 「以為系統出錯」這個困惑原封不動搬到一個更難查證的地方。CSV 沒有版面寬度限制,多一欄成本是 0。
 */
export function employmentStatusCsvText(
  row: Pick<StaffBreakdownRow, "is_active_as_of">,
): typeof EMPLOYED_LABEL | typeof RESIGNED_LABEL {
  return isStillEmployed(row) ? EMPLOYED_LABEL : RESIGNED_LABEL;
}
