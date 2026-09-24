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
//  行為 C(抽成是 null 時,畫面跟 CSV 要顯示同一件事)
//    2026-09-24 使用者裁決:抽成 null 一律當 0(「按件計酬的人沒接單時抽成確實就是 0」)。這一條是
//    行為 A 的反面教材而不是重複:同一個 commission_amount,畫面那格寫 `?? 0`、CSV 那格寫 `?? ""`,
//    老闆在畫面看到 0、匯出到 Excel 卻看到空白。抽出純函式的目的不只是「統一成 0」,更是讓
//    「以後有人只改其中一邊」在結構上變困難(見 COMMISSION_FALLBACK 的註解)。
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

// =========================================================================
// 計酬類型的顯示名稱(2026-09-24 使用者要求:「按件計酬」全面改稱「抽成制」)
// =========================================================================

/**
 * 計酬類型在畫面與 CSV 上的中文名稱。
 *
 * 資料庫存的是英文 'monthly_salary' / 'piece_rate',中文字串只存在前端顯示層,所以改名只動這裡。
 * 用 Record<compensation_type, string> 釘住 key:哪天資料庫多一種計酬類型,這裡沒補就會是型別錯誤,
 * 不會默默顯示 undefined。
 */
export const COMPENSATION_TYPE_LABELS: Record<StaffBreakdownRow["compensation_type"], string> = {
  monthly_salary: "月薪制",
  piece_rate: "抽成制",
};

/**
 * 明細表「計酬類型」欄與 CSV 同名欄共用的文字。
 *
 * 抽出來的理由跟下面 commissionCellText / commissionCsvValue 一模一樣:改名前畫面與 CSV 各寫一次
 * `=== "monthly_salary" ? "月薪制" : "按件計酬"`,同一個判斷寫兩份,改名就得改兩處,漏一處就會出現
 * 「畫面叫抽成制、匯出檔叫按件計酬」——沒有錯誤訊息、只有對帳的人看得出不對。現在兩條路徑在結構上
 * 只能從這一支拿字串,想只改一邊得先把函式拆開,不可能「順手」發生。
 */
export function compensationTypeText(row: Pick<StaffBreakdownRow, "compensation_type">): string {
  return COMPENSATION_TYPE_LABELS[row.compensation_type];
}

/**
 * 明細表「抽成金額 / 月薪淨額」那一欄,月薪制那一半要顯示的文字。
 *
 * 原本寫 `row.net_pay ?? 0` → 區間不是完整月份時會顯示「0 元(淨額)」,這正是使用者裁決要避免的
 * 誤導。抽成制的抽成不受這個旗標影響,由呼叫端自己處理,不走這支函式。
 */
export function monthlySalaryCellText(
  salaryApplicable: boolean | undefined,
  netPay: number | null | undefined,
): string {
  const display = resolveSalaryDisplay(salaryApplicable, netPay);
  return display.kind === "value" ? `${display.value} 元(淨額)` : display.text;
}

/**
 * 把一個 SalaryDisplay 轉成「寫進 CSV 的那一格」:能算就是數字(Excel 打開後可以繼續加總),
 * 不能算就是那段說明文字。
 *
 * ⚠️ 這支函式是 CSV 這一側**唯一**一處把「算不出來」翻成使用者看得到的內容的地方,而且它吃的是
 *    resolveSalaryDisplay() 的結果 —— 也就是跟畫面(salaryCardValue → salaryDisplayValue)共用
 *    同一個判斷來源。這是 2026-09-24 第二次踩坑之後定下來的做法:不是「兩邊各自記得要寫一樣的
 *    fallback」,而是讓兩邊在結構上都只能從 resolveSalaryDisplay 拿答案,想只改其中一邊就得先把
 *    函式拆開,不可能「順手」發生(同 COMMISSION_FALLBACK 那一段的理由)。
 */
export function salaryDisplayCsvCell(display: SalaryDisplay): string | number {
  return display.kind === "value" ? display.value : display.text;
}

/**
 * CSV 總計區塊的一格月薪數字。跟畫面 SummaryCard 的 salaryCardValue() 是同一支
 * resolveSalaryDisplay() 的兩個薄包裝,差別只在「算不出來」時畫面回傳 null(交給 SummaryCard 去
 * 印 unavailableText)、CSV 直接把同一段文字寫進格子裡(CSV 沒有元件可以幫忙渲染)。
 */
export function salaryCsvValue(
  salaryApplicable: boolean | undefined,
  value: number | null | undefined,
): string | number {
  return salaryDisplayCsvCell(resolveSalaryDisplay(salaryApplicable, value));
}

/**
 * CSV「月薪淨額」欄的一格。
 *
 * 月薪算不出來時寫進說明文字,**不留空白格**——CSV 的空白格在 Excel 裡看起來跟 0 很像,會重演
 * 「商家以為這段期間沒有月薪成本」這個誤會。抽成制的人本來就沒有月薪淨額,維持原本的空字串。
 * 判斷條件跟畫面表格那一欄走同一支 resolveSalaryDisplay,讓畫面跟匯出檔永遠一致。
 */
export function monthlySalaryCsvCell(
  salaryApplicable: boolean | undefined,
  row: Pick<StaffBreakdownRow, "compensation_type" | "net_pay">,
): string | number {
  if (row.compensation_type !== "monthly_salary") {
    return row.net_pay ?? "";
  }
  return salaryCsvValue(salaryApplicable, row.net_pay);
}

// =========================================================================
// 行為 C:抽成金額是 null 時,畫面跟 CSV 必須顯示同一件事
// =========================================================================

/**
 * 抽成金額(commission_amount)是 null 時要當成多少。
 *
 * ⚠️ 2026-09-24 使用者裁決(選項 A:兩邊統一顯示 0)。理由:「按件計酬的人沒接單時抽成確實就是 0,
 *    那是真實數字,不是『不適用』。」——這一點跟上面行為 A 的月薪剛好相反:月薪的 null 是資料庫刻意
 *    用來表達「這次算不出來」,所以不能補 0;抽成的 null 只是「沒有任何一筆單可以抽」,補 0 就是正解。
 *
 * ⚠️ 這個常數為什麼要存在(這是這一段的重點,不是為了好看):
 *    在此之前,同一個 commission_amount 有兩條路徑各自寫死自己的 fallback ——
 *      ・BillingReportPage.tsx 明細表那一格寫 `row.commission_amount ?? 0`   → 畫面顯示「0 元(抽成)」
 *      ・BillingReportPage.tsx CSV 匯出那一格寫 `row.commission_amount ?? ""` → CSV 是一個空白格
 *    同一位服務人員、同一個欄位,老闆在畫面上看到 0、把報表匯出到 Excel 卻看到空白,而且兩邊都沒有
 *    任何錯誤訊息。會漂移成這樣的根本原因不是誰粗心,而是**結構上允許兩邊各寫一次 fallback**。
 *    所以現在 fallback 只有這一個常數,而且 commissionCellText() 是透過呼叫 commissionCsvValue()
 *    拿數字的 —— 想只改其中一邊,得先把這兩支函式拆開,不可能「順手」發生。
 */
export const COMMISSION_FALLBACK = 0;

/**
 * CSV「抽成金額」欄的一格,也是這個欄位唯一一處把 null 換成 fallback 的地方。
 *
 * 回傳 number(不是字串),Excel 打開後才能繼續加總。
 */
export function commissionCsvValue(row: Pick<StaffBreakdownRow, "commission_amount">): number {
  return row.commission_amount ?? COMMISSION_FALLBACK;
}

/**
 * 明細表「抽成金額 / 月薪淨額」欄,抽成制那一半要顯示的完整文字。
 *
 * 格式 `X 元(抽成)` 跟改動前一模一樣(這次只換「X 怎麼算出來」,沒有動畫面用字)。
 * 數字刻意透過 commissionCsvValue() 取得,而不是自己再寫一次 `?? COMMISSION_FALLBACK`:
 * 只要這兩支函式之一被改壞,單元測試裡那條「兩條路徑對同一個輸入必須一致」的斷言就會紅。
 */
export function commissionCellText(row: Pick<StaffBreakdownRow, "commission_amount">): string {
  return `${commissionCsvValue(row)} 元(抽成)`;
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

// =========================================================================
// CSV 匯出的「總計區塊」(2026-09-24 使用者裁決 A:總計放在同一個 CSV 的最上面)
// =========================================================================

/**
 * 店家報表頁上方那幾張統計卡的標題文字。
 *
 * ⚠️ 為什麼要把畫面上的 label 抽成常數(而不是讓 JSX 和 CSV 各寫一次同樣的中文字):
 *    這次 CSV 要新增的「總計區塊」逐項對應的就是這幾張卡,使用者的要求是「欄位名稱一律沿用畫面
 *    上統計卡的既有文案」。如果兩邊各打一次中文字,哪天有人在畫面上把「總料錢成本」改成別的說法,
 *    匯出檔會留著舊名稱,商家對帳時會以為是兩個不同的東西 —— 這跟本檔案前面那兩次 fallback 漂移
 *    是同一種失敗模式(沒有錯誤訊息、只有人看得出來不對),所以一樣用「共用同一個來源」解掉。
 *
 * 稅金與商家總淨利在畫面上是 <CardTitle> 而不是 SummaryCard,但對商家來說一樣是「上方那一組
 * 統計數字」,所以一起收在這裡。
 */
export const BILLING_SUMMARY_LABELS = {
  revenueExclTax: "總營收(未稅)",
  taxAmount: "稅金小計",
  materialCost: "總料錢成本",
  commissionPayout: "總抽成支出",
  monthlySalaryBase: "月薪基本額合計",
  monthlySalaryDeduction: "月薪扣款合計",
  monthlySalaryNet: "月薪實發合計",
  netMargin: "商家總淨利",
} as const;

/** 總計區塊最上面那一列的欄位名。存成檔案之後,光看檔名不一定分得出是哪一段期間的報表,所以
 * 區間一定要寫進檔案內容裡。 */
export const CSV_PERIOD_LABEL = "報表區間";

/** 總計區塊自己的兩欄標題。 */
export const CSV_SUMMARY_ITEM_HEADER = "項目";
export const CSV_SUMMARY_AMOUNT_HEADER = "金額";

/** 報表區間那一格的文字。格式 `YYYY-MM-DD ~ YYYY-MM-DD`,跟檔名用的起訖日期同一組值。 */
export function formatCsvPeriodText(startDate: string, endDate: string): string {
  return `${startDate} ~ ${endDate}`;
}

/** 總計區塊需要用到的 summary 欄位。用 Pick 而不是整個 MerchantBillingSummary,測試才不用為了測
 * 八列數字去編一整份含明細的報表。 */
export type BillingCsvSummaryFields = Pick<
  MerchantBillingSummary,
  | "total_revenue_excl_tax"
  | "total_tax_amount"
  | "total_material_cost"
  | "total_commission_payout"
  | "salary_applicable"
  | "total_monthly_salary_base"
  | "total_monthly_salary_deduction"
  | "estimated_net_margin"
>;

/** 總計區塊的一個項目:左邊是畫面上那張卡的標題,右邊是數字或「算不出來」的說明文字。 */
export interface BillingCsvSummaryItem {
  readonly label: string;
  readonly value: string | number;
}

/** CSV 的一列(空陣列 = 一整列空白,用來把兩段表格隔開)。 */
export type CsvLine = Array<string | number>;

/**
 * 總計區塊的八個項目。順序刻意跟使用者裁決時列出的順序一致:營收 → 稅金 → 料錢 → 抽成 →
 * 月薪三項 → 商家總淨利,也就是「收進來多少 → 扣掉哪些 → 最後剩多少」的對帳順序
 * (畫面上稅金卡為了版面被排在月薪三張卡之後,但對帳時緊接在營收後面比較好讀)。
 *
 * ⚠️ 月薪四項(基本額/扣款/實發/商家總淨利)在 salary_applicable=false 時寫的是
 *    SALARY_UNAVAILABLE_TEXT,**不是 0、不是空白**。這四格走的是 salaryCsvValue() /
 *    resolveNetMonthlySalary(),跟畫面那四張卡同一個判斷來源 —— 理由見 salaryDisplayCsvCell()
 *    的註解(本專案 2026-09-24 已經因為「畫面與 CSV 各寫一份 fallback」踩過兩次)。
 *
 * ⚠️ 反過來,estimated_net_margin 是負數(虧損,例如 -28000)時要**如實輸出負數**。負數是合法的
 *    真實數字,不是「算不出來」;把虧損吞掉只留空白,比顯示 0 更容易讓老闆誤判。
 */
export function buildBillingCsvSummaryItems(
  summary: BillingCsvSummaryFields,
): BillingCsvSummaryItem[] {
  const salaryApplicable = summary.salary_applicable;
  return [
    { label: BILLING_SUMMARY_LABELS.revenueExclTax, value: summary.total_revenue_excl_tax },
    { label: BILLING_SUMMARY_LABELS.taxAmount, value: summary.total_tax_amount },
    { label: BILLING_SUMMARY_LABELS.materialCost, value: summary.total_material_cost },
    { label: BILLING_SUMMARY_LABELS.commissionPayout, value: summary.total_commission_payout },
    {
      label: BILLING_SUMMARY_LABELS.monthlySalaryBase,
      value: salaryCsvValue(salaryApplicable, summary.total_monthly_salary_base),
    },
    {
      label: BILLING_SUMMARY_LABELS.monthlySalaryDeduction,
      value: salaryCsvValue(salaryApplicable, summary.total_monthly_salary_deduction),
    },
    {
      label: BILLING_SUMMARY_LABELS.monthlySalaryNet,
      // 月薪實發 = 基本額 − 扣款,跟畫面那張卡走同一支 resolveNetMonthlySalary(),不在這裡自己減
      // 一次(自己減就等於又開了一條可以漂移的路徑)。
      value: salaryDisplayCsvCell(resolveNetMonthlySalary(summary)),
    },
    {
      label: BILLING_SUMMARY_LABELS.netMargin,
      value: salaryCsvValue(salaryApplicable, summary.estimated_net_margin),
    },
  ];
}

/**
 * 總計區塊的完整 CSV 列(區間 → 空白列 → 項目/金額標題 → 八個項目 → 空白列)。
 *
 * ⚠️ 這個格式的取捨,以及為什麼刻意長成這樣(請不要在沒有問過使用者的情況下改掉):
 *    把「總計區塊」跟「服務人員明細表」放進同一個 CSV,代表這個檔案裡有**兩種不同形狀的表格**
 *    (上面兩欄、下面六欄),嚴格來說它不再是一份乾淨的、機器可讀的 CSV —— 用程式去 parse 會比較
 *    麻煩,得先跳過前面幾列。
 *    2026-09-24 使用者是在知道這個取捨的情況下選擇 A(總計放同一個檔案的最上面)的,理由是這份
 *    報表的真實用途是「商家用 Excel 打開來對帳」,不是餵給程式;分成兩個檔案或只給明細,反而讓
 *    商家得自己重新加總一次,那正是這次要解決的問題。
 *    所以:**看到這個 CSV「格式怪怪的」不是 bug,是裁決**。真的需要機器可讀的輸出時,請另外開一支
 *    匯出(例如模組 12 的報表匯出中心),不要把這一份改掉。
 *
 * 結尾那一列空白是刻意的:沒有它,總計區塊的最後一項會跟明細的標題列黏在一起,Excel 打開後兩段
 * 表格糊成一片,很難一眼看出「下面換一張表了」。
 */
export function buildBillingCsvSummarySection(
  summary: BillingCsvSummaryFields,
  startDate: string,
  endDate: string,
): CsvLine[] {
  return [
    [CSV_PERIOD_LABEL, formatCsvPeriodText(startDate, endDate)],
    [],
    [CSV_SUMMARY_ITEM_HEADER, CSV_SUMMARY_AMOUNT_HEADER],
    ...buildBillingCsvSummaryItems(summary).map((item): CsvLine => [item.label, item.value]),
    [],
  ];
}
