// #1035 彈性計薪 A 批(月薪加獎金)— 規則編輯器 / 報表明細的純函式。
// 規格書:母版 .project/specs/彈性計薪.md PA-R01、PA-R04、PA-U02、PA-B03。
//
// 🔴 這裡只做「畫面上要怎麼說」與「送出前的體驗驗證」,真正的驗證與計算一律在資料庫
//    (public.save_staff_bonus_plan / private.bonus_compute_rules)。前端算的數字不能信任,
//    所以這支檔案**不算任何獎金金額**,試算一律呼叫 preview_staff_bonus。
// 這支檔案只依賴 ./types(純型別),Vitest 匯入時不會觸發 supabase 連線。

import type {
  BonusFormulaRule,
  BonusMetric,
  BonusRule,
  BonusRuleKind,
  BonusRuleResult,
  BonusStandardRule,
  BonusStandardRuleKind,
} from "./types";

export const BONUS_RULE_MAX_COUNT = 20;
export const BONUS_RULE_LABEL_MAX = 30;
export const BONUS_PLAN_NAME_MAX = 30;
export const BONUS_THRESHOLD_MAX = 100_000_000;
export const BONUS_AMOUNT_MAX = 1_000_000;

/** 合計超過每月上限(資料庫封頂並回 capped 旗標)時,試算與報表下方那一句。 */
export const BONUS_CAPPED_NOTE = "獎金每月最多 1,000,000 元，超過的部分不計。";

/** 「給什麼」A 批四種(規則組合器)。順序 = 畫面上選項的順序。 */
export const BONUS_RULE_KIND_OPTIONS: ReadonlyArray<{
  value: BonusStandardRuleKind;
  label: string;
}> = [
  { value: "per_order", label: "每單加錢" },
  { value: "per_unit", label: "每份加錢" },
  { value: "percent", label: "業績百分比" },
  { value: "lump_sum", label: "達標給一筆" },
];

/** #1035 C 批 PC-U01:編輯器「給什麼」的選項 = A 批四種 + 自訂公式(進階)。 */
export const BONUS_EDITOR_KIND_OPTIONS: ReadonlyArray<{ value: BonusRuleKind; label: string }> = [
  ...BONUS_RULE_KIND_OPTIONS,
  { value: "formula", label: "自訂公式（進階）" },
];

export const BONUS_RULE_KIND_LABELS: Record<BonusRuleKind, string> = {
  per_order: "每單加錢",
  per_unit: "每份加錢",
  percent: "業績百分比",
  lump_sum: "達標給一筆",
  formula: "自訂公式",
};

// =========================================================================
// #1035 C 批:自訂公式(PC-F01~F03、PC-U01)
//   🔴 前端**不做任何公式求值**(PX-03):檢查與試算一律呼叫資料庫 preview_bonus_formula。
//      這裡只有字數上限、插入欄位的游標處理、旗標的白話說明、存檔按鈕擋不擋。
// =========================================================================

export const BONUS_FORMULA_TEXT_MAX = 300;
/** 每個方案最多幾條公式規則(資料庫同樣擋)。 */
export const BONUS_FORMULA_MAX_COUNT = 5;
/** 公式規則名稱空白時用的名稱 —— 刻意不用公式原文(服務人員看得到規則名稱,看不到公式)。 */
export const BONUS_FORMULA_DEFAULT_LABEL = "自訂公式";

/** 計算結果旗標 → 畫面上的一句話(試算與報表共用)。 */
export const BONUS_FLAG_NOTES: Readonly<Record<string, string>> = {
  division_by_zero: "公式中有除以 0 的情況，該處以 0 計算。",
  overflow: "公式算出的數字太大，這條規則以 0 計算。",
  negative_clamped: "公式算出負數；獎金不會變成扣錢，以 0 計算。",
  capped: BONUS_CAPPED_NOTE,
  sample_items_zero: '用範例數字試算時，數量("…")、業績("…") 以 0 計算。',
};

/** 旗標陣列 → 要顯示的句子(不認得的旗標略過;重複的只出現一次)。 */
export function bonusFlagNotes(flags: readonly string[] | undefined | null): string[] {
  const seen = new Set<string>();
  const notes: string[] = [];
  for (const f of flags ?? []) {
    const note = BONUS_FLAG_NOTES[f];
    if (note && !seen.has(note)) {
      seen.add(note);
      notes.push(note);
    }
  }
  return notes;
}

/** 「插入欄位」小按鈕。insert = 插入的文字;caret = 插入後游標停在插入文字的第幾個字之後。 */
export interface BonusFormulaSnippet {
  label: string;
  insert: string;
  caret: number;
}

export const BONUS_FORMULA_SNIPPETS: readonly BonusFormulaSnippet[] = [
  { label: "完成單數", insert: "完成單數", caret: 4 },
  { label: "完成數量", insert: "完成數量", caret: 4 },
  { label: "業績", insert: "業績", caret: 2 },
  { label: "月薪", insert: "月薪", caret: 2 },
  { label: "請假天數", insert: "請假天數", caret: 4 },
  { label: "IF( , , )", insert: "IF(, , )", caret: 3 },
  { label: "MIN( , )", insert: "MIN(, )", caret: 4 },
  { label: "MAX( , )", insert: "MAX(, )", caret: 4 },
];

/** 數量("服務名稱") / 業績("服務名稱") 的插入文字。 */
/**
 * 服務名稱能不能放進 數量("…") / 業績("…"):名稱裡有引號(半形 " 、全形 ＂、彎引號 “ ”)時,
 * 資料庫會把它當成字串結尾 ⇒ 不讓插入,回提示句;沒問題 ⇒ null。
 */
export function bonusFormulaServiceNameProblem(serviceName: string): string | null {
  if (/["“”＂]/.test(serviceName)) {
    return `「${serviceName}」的名稱裡有引號，公式沒辦法指定這個服務；請先到「服務項目」把名稱裡的引號拿掉。`;
  }
  return null;
}

export function bonusFormulaItemSnippet(
  fn: "數量" | "業績",
  serviceName: string,
): BonusFormulaSnippet {
  const insert = `${fn}("${serviceName}")`;
  return { label: insert, insert, caret: insert.length };
}

/**
 * 在游標(選取範圍)處插入文字:選取的字會被取代;回傳新文字與新游標位置。
 * 插入後超過字數上限 ⇒ 不插入(回傳 null),讓畫面提示「最多 300 字」。
 */
export function insertFormulaSnippet(
  text: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  snippet: BonusFormulaSnippet,
  maxLength: number = BONUS_FORMULA_TEXT_MAX,
): { text: string; caret: number } | null {
  const len = text.length;
  const clamp = (n: number) => Math.min(Math.max(n, 0), len);
  const start = clamp(selectionStart ?? len);
  const end = Math.max(start, clamp(selectionEnd ?? start));
  const next = text.slice(0, start) + snippet.insert + text.slice(end);
  if ([...next].length > maxLength) return null;
  return { text: next, caret: start + snippet.caret };
}

/** 試算「用範例數字」的五個欄位(資料庫 preview_bonus_formula 的 p_sample 只收這五個 key)。 */
export type BonusFormulaSampleKey = "orders" | "units" | "revenue" | "salary" | "leave_days";

const BONUS_FORMULA_SAMPLE_KEYS: readonly BonusFormulaSampleKey[] = [
  "orders",
  "units",
  "revenue",
  "salary",
  "leave_days",
];
const BONUS_FORMULA_SAMPLE_PATTERN = /^\d{1,10}(\.\d{1,4})?$/;

/** 範例數字輸入 → 送給資料庫的物件;任何一格格式不對或超過 10 億 ⇒ null(空白當 0)。 */
export function parseFormulaSample(
  raw: Readonly<Partial<Record<BonusFormulaSampleKey, string>>>,
): Record<BonusFormulaSampleKey, number> | null {
  const out = {} as Record<BonusFormulaSampleKey, number>;
  for (const key of BONUS_FORMULA_SAMPLE_KEYS) {
    const text = (raw[key] ?? "").trim();
    if (text === "") {
      out[key] = 0;
      continue;
    }
    if (!BONUS_FORMULA_SAMPLE_PATTERN.test(text) || Number(text) > 1_000_000_000) return null;
    out[key] = Number(text);
  }
  return out;
}

/** 公式檢查狀態(每條公式規則一個):檢查中 / 可以使用 / 有錯誤。 */
export type BonusFormulaCheckState =
  { status: "checking" } | { status: "ok" } | { status: "error"; message: string };

/**
 * 存檔按鈕要不要擋(PC-U01):公式規則超過 5 條 ⇒ 上限訊息;任何一條公式空白或檢查有錯 ⇒
 * 「第 N 條規則的公式有錯誤，修正後才能存檔。」;都沒問題 ⇒ null。
 * 檢查中不擋(資料庫存檔時會再編譯一次,錯了一樣存不進去)。
 */
export function formulaSaveBlocker(
  drafts: ReadonlyArray<Pick<BonusRuleDraft, "key" | "kind" | "formulaText">>,
  checks: Readonly<Record<string, BonusFormulaCheckState | undefined>>,
): string | null {
  const formulaCount = drafts.filter((d) => d.kind === "formula").length;
  if (formulaCount > BONUS_FORMULA_MAX_COUNT) {
    return `一個方案最多 ${BONUS_FORMULA_MAX_COUNT} 條自訂公式規則。`;
  }
  const badIndex = drafts.findIndex(
    (d) =>
      d.kind === "formula" && (d.formulaText.trim() === "" || checks[d.key]?.status === "error"),
  );
  if (badIndex >= 0) return `第 ${badIndex + 1} 條規則的公式有錯誤，修正後才能存檔。`;
  return null;
}

/** 「達標給一筆」要選用什麼量判斷達標。 */
export const BONUS_METRIC_OPTIONS: ReadonlyArray<{ value: BonusMetric; label: string }> = [
  { value: "orders", label: "完成單數" },
  { value: "units", label: "完成份數" },
  { value: "revenue", label: "業績" },
];

/** 量的單位。 */
export const BONUS_METRIC_UNITS: Record<BonusMetric, string> = {
  orders: "單",
  units: "份",
  revenue: "元",
};

/** 每種「給什麼」固定用的量(lump_sum 由店家自己選)。 */
export function metricForKind(kind: BonusRuleKind, lumpSumMetric: BonusMetric): BonusMetric {
  if (kind === "per_order") return "orders";
  if (kind === "per_unit") return "units";
  if (kind === "percent") return "revenue";
  return lumpSumMetric;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** 數字千分位(最多 2 位小數):100000 → "100,000"。 */
export function formatBonusNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

/** 服務項目名稱清單 → 「A、B」;太多時只列前 3 個。 */
function formatServiceNames(names: readonly string[]): string {
  if (names.length <= 3) return names.join("、");
  return `${names.slice(0, 3).join("、")} 等 ${names.length} 項`;
}

/** describeBonusRule 需要的欄位(數字已經解析好)。 */
export type DescribableBonusRule = Pick<
  BonusStandardRule,
  "kind" | "metric" | "threshold" | "cap" | "amount" | "percent" | "retroactive"
> & { service_item_ids: readonly string[] };

/**
 * PA-U02 每張規則卡下方的白話摘要句。例:
 *   「超過 10 份之後，第 11 份起每份加 300 元」
 *   「業績超過 100,000 元的部分，加 5%」
 *   「這個月完成滿 30 單，加 3,000 元」
 * 有指定服務時前面加「只算「冷氣清洗」：」。
 * serviceNameOf:服務項目 id → 名稱(找不到時回 undefined,摘要就不列那一項)。
 */
export function describeBonusRule(
  rule: DescribableBonusRule,
  serviceNameOf: (id: string) => string | undefined = () => undefined,
): string {
  const names = rule.service_item_ids
    .map((id) => serviceNameOf(id))
    .filter((n): n is string => Boolean(n));
  const prefix =
    rule.service_item_ids.length > 0
      ? names.length > 0
        ? `只算「${formatServiceNames(names)}」：`
        : `只算指定的 ${rule.service_item_ids.length} 項服務：`
      : "";
  return prefix + describeCore(rule);
}

function describeCore(rule: DescribableBonusRule): string {
  const t = rule.threshold;
  const cap = rule.cap;
  if (rule.kind === "per_order" || rule.kind === "per_unit") {
    const unit = rule.kind === "per_order" ? "單" : "份";
    const verb = rule.kind === "per_order" ? "每單" : "每份";
    const amount = `${formatBonusNumber(rule.amount ?? 0)} 元`;
    const startNo = Math.floor(t) + 1;
    if (rule.retroactive) {
      if (cap !== null) {
        return `這個月完成超過 ${formatBonusNumber(t)} ${unit}，第 1～${formatBonusNumber(Math.floor(cap))} ${unit}${verb}都加 ${amount}`;
      }
      return `這個月完成超過 ${formatBonusNumber(t)} ${unit}，整月${verb}都加 ${amount}`;
    }
    if (cap !== null) {
      return `第 ${formatBonusNumber(startNo)}～${formatBonusNumber(Math.floor(cap))} ${unit}，${verb}加 ${amount}`;
    }
    if (t <= 0) return `${verb}加 ${amount}`;
    return `超過 ${formatBonusNumber(t)} ${unit}之後，第 ${formatBonusNumber(startNo)} ${unit}起${verb}加 ${amount}`;
  }
  if (rule.kind === "percent") {
    const pct = `${formatBonusNumber(rule.percent ?? 0)}%`;
    if (rule.retroactive) {
      if (cap !== null) {
        return `這個月業績超過 ${formatBonusNumber(t)} 元，業績 ${formatBonusNumber(cap)} 元以內都加 ${pct}`;
      }
      return `這個月業績超過 ${formatBonusNumber(t)} 元，整月業績都加 ${pct}`;
    }
    if (cap !== null) {
      return `業績 ${formatBonusNumber(t)}～${formatBonusNumber(cap)} 元之間的部分，加 ${pct}`;
    }
    if (t <= 0) return `業績的 ${pct}`;
    return `業績超過 ${formatBonusNumber(t)} 元的部分，加 ${pct}`;
  }
  // lump_sum
  const amount = `${formatBonusNumber(rule.amount ?? 0)} 元`;
  const unit = BONUS_METRIC_UNITS[rule.metric];
  const what =
    rule.metric === "revenue"
      ? (n: string) => `業績滿 ${n} 元`
      : rule.metric === "orders"
        ? (n: string) => `完成滿 ${n} 單`
        : (n: string) => `完成滿 ${n} 份`;
  if (t <= 0) {
    const any =
      rule.metric === "revenue"
        ? "有業績"
        : rule.metric === "orders"
          ? "有完成的單"
          : "有完成的服務";
    if (cap !== null) {
      return `這個月只要${any}、而且不超過 ${formatBonusNumber(cap)} ${unit}，加 ${amount}`;
    }
    return `這個月只要${any}，加 ${amount}`;
  }
  if (cap !== null) {
    return `這個月${what(formatBonusNumber(t))}、而且不超過 ${formatBonusNumber(cap)} ${unit}，加 ${amount}`;
  }
  return `這個月${what(formatBonusNumber(t))}，加 ${amount}`;
}

/**
 * PA-B03 報表明細「算了多少」那一欄。例:
 *   每份:「第 11～13 份，共 3 份」/「完成 8 份，還沒超過門檻」
 *   業績:「業績 15,000 元，計入 3,000 元」
 *   達標:「已達標(完成 13 單)」/「未達標(完成 8 單)」
 */
export function describeBonusRuleResult(result: BonusRuleResult): string {
  // #1035 C 批:自訂公式只說「依自訂公式計算」,不顯示公式原文(服務人員也看得到這一欄);
  //   有旗標時把說明接在後面(例:除以 0)。
  if (result.kind === "formula" || result.metric === null) {
    const notes = bonusFlagNotes(result.flags);
    return notes.length > 0 ? `依自訂公式計算（${notes.join("")}）` : "依自訂公式計算";
  }
  const unit = BONUS_METRIC_UNITS[result.metric];
  const qty = formatBonusNumber(Number(result.quantity));
  if (result.kind === "per_order" || result.kind === "per_unit") {
    if (
      result.range_start !== null &&
      result.range_end !== null &&
      Number(result.counted_quantity) > 0
    ) {
      return `第 ${formatBonusNumber(Number(result.range_start))}～${formatBonusNumber(Number(result.range_end))} ${unit}，共 ${formatBonusNumber(Number(result.counted_quantity))} ${unit}`;
    }
    return `完成 ${qty} ${unit}，還沒超過門檻`;
  }
  if (result.kind === "percent") {
    if (Number(result.counted_quantity) > 0) {
      return `業績 ${qty} 元，計入 ${formatBonusNumber(Number(result.counted_quantity))} 元`;
    }
    return `業績 ${qty} 元，還沒超過門檻`;
  }
  const what = result.metric === "revenue" ? `業績 ${qty} 元` : `完成 ${qty} ${unit}`;
  return result.achieved ? `已達標（${what}）` : `未達標（${what}）`;
}

/** 方案卡片上「目前規則摘要一行」:第一條規則的名稱,多條時加「等 N 條」。 */
export function summarizeBonusPlanRules(rules: readonly Pick<BonusRule, "label">[]): string {
  if (rules.length === 0) return "還沒有規則";
  const first = rules[0]!.label;
  return rules.length === 1 ? first : `${first}，另有 ${rules.length - 1} 條規則`;
}

// =========================================================================
// 編輯器的草稿(輸入框都是字串)
// =========================================================================

export interface BonusRuleDraft {
  key: string;
  label: string;
  kind: BonusRuleKind;
  /** #1035 C 批:只有「自訂公式」看這個。 */
  formulaText: string;
  /** 只有「達標給一筆」看這個;其他種類由 kind 決定。 */
  lumpSumMetric: BonusMetric;
  serviceItemIds: string[];
  threshold: string;
  cap: string;
  amount: string;
  percent: string;
  retroactive: boolean;
}

let keySeq = 0;
/** 新規則的代號(資料庫規定 ^[a-z0-9-]+$、同一版內唯一)。 */
export function newBonusRuleKey(existing: readonly string[]): string {
  for (;;) {
    keySeq += 1;
    const key = `r-${Date.now().toString(36)}-${keySeq.toString(36)}`;
    if (!existing.includes(key)) return key;
  }
}

export function createBonusRuleDraft(existingKeys: readonly string[]): BonusRuleDraft {
  return {
    key: newBonusRuleKey(existingKeys),
    label: "",
    kind: "per_unit",
    formulaText: "",
    lumpSumMetric: "orders",
    serviceItemIds: [],
    threshold: "0",
    cap: "",
    amount: "",
    percent: "",
    retroactive: false,
  };
}

export function draftFromBonusRule(rule: BonusRule): BonusRuleDraft {
  if (rule.kind === "formula") {
    return {
      key: rule.key,
      label: rule.label,
      kind: "formula",
      formulaText: rule.text,
      lumpSumMetric: "orders",
      serviceItemIds: [],
      threshold: "0",
      cap: "",
      amount: "",
      percent: "",
      retroactive: false,
    };
  }
  return {
    key: rule.key,
    label: rule.label,
    kind: rule.kind,
    formulaText: "",
    lumpSumMetric: rule.kind === "lump_sum" ? rule.metric : "orders",
    serviceItemIds: [...rule.service_item_ids],
    threshold: String(Number(rule.threshold)),
    cap: rule.cap === null ? "" : String(Number(rule.cap)),
    amount: rule.amount === null ? "" : String(Number(rule.amount)),
    percent: rule.percent === null ? "" : String(Number(rule.percent)),
    retroactive: rule.retroactive,
  };
}

export type BonusRuleDraftField = "label" | "threshold" | "cap" | "amount" | "percent" | "formula";

export type BonusRuleDraftResult =
  | { ok: true; rule: BonusRule }
  | { ok: false; errors: Partial<Record<BonusRuleDraftField, string>> };

/** 字串 → 數字;空白 ⇒ null;不是數字或超過 2 位小數 ⇒ NaN。 */
function parseDecimal(raw: string): number | null {
  const text = raw.trim().replace(/,/g, "");
  if (text === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return Number.NaN;
  return Number(text);
}

/**
 * 草稿 → 送給資料庫的規則。這裡的檢查只是體驗(欄位下方紅字),資料庫 PA-F02 會再完整驗一次。
 * 名稱空白時用摘要句當名稱(截到 30 字)。
 */
export function bonusRuleFromDraft(
  draft: BonusRuleDraft,
  serviceNameOf?: (id: string) => string | undefined,
): BonusRuleDraftResult {
  if (draft.kind === "formula") return formulaRuleFromDraft(draft);
  const errors: Partial<Record<BonusRuleDraftField, string>> = {};
  const metric = metricForKind(draft.kind, draft.lumpSumMetric);
  const unit = BONUS_METRIC_UNITS[metric];

  const threshold = parseDecimal(draft.threshold);
  if (threshold === null || Number.isNaN(threshold) || threshold > BONUS_THRESHOLD_MAX) {
    errors.threshold = `請填 0～100,000,000 之間的數字（${unit}），最多 2 位小數。`;
  }
  const cap = parseDecimal(draft.cap);
  if (cap !== null) {
    if (Number.isNaN(cap) || cap > BONUS_THRESHOLD_MAX) {
      errors.cap = "請填 100,000,000 以內的數字，最多 2 位小數；不設上限就留空。";
    } else if (threshold !== null && !Number.isNaN(threshold) && cap <= threshold) {
      errors.cap = "要大於「超過多少後才開始算」。";
    }
  }
  let amount: number | null = null;
  let percent: number | null = null;
  if (draft.kind === "percent") {
    percent = parseDecimal(draft.percent);
    if (percent === null || Number.isNaN(percent) || percent > 100) {
      errors.percent = "請填 0～100 之間的數字，最多 2 位小數。";
    }
  } else {
    amount = parseDecimal(draft.amount);
    if (amount === null || Number.isNaN(amount) || amount > BONUS_AMOUNT_MAX) {
      errors.amount = "請填 0～1,000,000 元之間的數字，最多 2 位小數。";
    }
  }
  const label = draft.label.trim();
  if (label.length > BONUS_RULE_LABEL_MAX) {
    errors.label = `名稱最多 ${BONUS_RULE_LABEL_MAX} 個字。`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const retroactive = draft.kind === "lump_sum" ? false : draft.retroactive;
  const base = {
    kind: draft.kind as BonusStandardRuleKind,
    metric,
    service_item_ids: [...draft.serviceItemIds],
    threshold: threshold as number,
    cap,
    amount,
    percent,
    retroactive,
  };
  const finalLabel = label !== "" ? label : autoBonusRuleLabel(base, serviceNameOf);
  return { ok: true, rule: { key: draft.key, label: finalLabel, ...base } };
}

/**
 * #1035 C 批:自訂公式草稿 → 規則({key, label, kind, text})。只檢查空白與字數(體驗);
 * 語法檢查一律由資料庫 preview_bonus_formula / save_staff_bonus_plan 做。名稱空白 ⇒「自訂公式」。
 */
function formulaRuleFromDraft(draft: BonusRuleDraft): BonusRuleDraftResult {
  const errors: Partial<Record<BonusRuleDraftField, string>> = {};
  const text = draft.formulaText.trim();
  if (text === "") errors.formula = "請輸入公式。";
  else if ([...draft.formulaText].length > BONUS_FORMULA_TEXT_MAX) {
    errors.formula = `公式最多 ${BONUS_FORMULA_TEXT_MAX} 個字。`;
  }
  const label = draft.label.trim();
  if (label.length > BONUS_RULE_LABEL_MAX) {
    errors.label = `名稱最多 ${BONUS_RULE_LABEL_MAX} 個字。`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const rule: BonusFormulaRule = {
    key: draft.key,
    label: label !== "" ? label : BONUS_FORMULA_DEFAULT_LABEL,
    kind: "formula",
    text,
  };
  return { ok: true, rule };
}

/**
 * 名稱空白時自動取的名稱(最多 30 字):摘要句放得下就用整句;放不下先拿掉「只算「…」：」前綴,
 * 還是放不下才截斷並加「…」(避免截在半個字詞上,例如「第 11 份起每」)。
 */
export function autoBonusRuleLabel(
  rule: DescribableBonusRule,
  serviceNameOf?: (id: string) => string | undefined,
): string {
  const full = describeBonusRule(rule, serviceNameOf);
  if (full.length <= BONUS_RULE_LABEL_MAX) return full;
  const core = describeBonusRule({ ...rule, service_item_ids: [] });
  if (core.length <= BONUS_RULE_LABEL_MAX) return core;
  return `${core.slice(0, BONUS_RULE_LABEL_MAX - 1)}…`;
}

/** 一整組草稿 → 規則;任一條有錯 ⇒ 回傳每條的錯誤(索引對應)。 */
export function bonusRulesFromDrafts(
  drafts: readonly BonusRuleDraft[],
  serviceNameOf?: (id: string) => string | undefined,
):
  | { ok: true; rules: BonusRule[] }
  | { ok: false; errorsByIndex: Array<Partial<Record<BonusRuleDraftField, string>>> } {
  const results = drafts.map((d) => bonusRuleFromDraft(d, serviceNameOf));
  if (results.every((r) => r.ok)) {
    return { ok: true, rules: results.map((r) => (r as { ok: true; rule: BonusRule }).rule) };
  }
  return {
    ok: false,
    errorsByIndex: results.map((r) => (r.ok ? {} : r.errors)),
  };
}

/** 草稿目前能不能畫出摘要句(數字都填好了才畫,填到一半就顯示提示)。 */
export function describeBonusRuleDraft(
  draft: BonusRuleDraft,
  serviceNameOf?: (id: string) => string | undefined,
): string | null {
  const result = bonusRuleFromDraft({ ...draft, label: "" }, serviceNameOf);
  if (!result.ok) return null;
  if (result.rule.kind === "formula") return `自訂公式：${result.rule.text}`;
  return describeBonusRule(result.rule, serviceNameOf);
}

/** 「超過多少後才開始算」等欄位的單位文字(隨種類:單 / 份 / 元)。 */
export function bonusDraftUnit(draft: Pick<BonusRuleDraft, "kind" | "lumpSumMetric">): string {
  return BONUS_METRIC_UNITS[metricForKind(draft.kind, draft.lumpSumMetric)];
}

// =========================================================================
// 報表(PA-B02 / PA-B03)顯示條件
// =========================================================================

/** 店家報表「月薪獎金」卡要不要出現:只看函式回傳的 bonus_feature_used(整店沒有任何方案 ⇒ 不出現)。 */
export function shouldShowMonthlyBonusCard(
  summary: { bonus_feature_used?: boolean | undefined } | undefined,
): boolean {
  return summary?.bonus_feature_used === true;
}

/** 服務人員報表「獎金」區塊要不要出現:區間內曾經有方案,或任一月份金額不是 0。 */
export function shouldShowStaffBonusSection(
  bonus:
    | { has_any_plan: boolean; total_amount: number; months: ReadonlyArray<{ amount: number }> }
    | undefined,
): boolean {
  if (!bonus) return false;
  return bonus.has_any_plan || bonus.months.some((m) => Number(m.amount) !== 0);
}

/** "2026-09-01" → "9 月";跨年時(與參考年不同)→ "2025 年 12 月"。 */
export function formatBonusMonthLabel(month: string, referenceYear?: number): string {
  const [y, m] = month.split("-");
  const year = Number(y);
  const mon = Number(m);
  if (referenceYear !== undefined && year !== referenceYear) return `${year} 年 ${mon} 月`;
  return `${mon} 月`;
}

/** 不完整月份那一句:「這幾個月不是完整月份，不計算獎金：9 月、10 月」。 */
export function partialMonthsNotice(partialMonths: readonly string[]): string | null {
  if (partialMonths.length === 0) return null;
  const years = new Set(partialMonths.map((m) => m.slice(0, 4)));
  // 跨年時每個月都帶年份(參考年給 0 ⇒ 一定不同)。
  const ref = years.size === 1 ? Number([...years][0]) : 0;
  return `這幾個月不是完整月份，不計算獎金：${partialMonths.map((m) => formatBonusMonthLabel(m, ref)).join("、")}`;
}

/**
 * 服務人員報表 CSV 的獎金區塊(PX-04:規則名稱會進 CSV ⇒ 一律走 buildCsvContentFromRows 的跳脫)。
 * 沒有任何獎金資料 ⇒ 空陣列(CSV 跟改版前完全一樣)。
 */
export function buildStaffBonusCsvRows(
  bonus:
    | {
        has_any_plan: boolean;
        total_amount: number;
        months: ReadonlyArray<{ month: string; amount: number; rules: readonly BonusRuleResult[] }>;
      }
    | undefined,
): Array<Array<string | number>> {
  if (!shouldShowStaffBonusSection(bonus) || !bonus) return [];
  const rows: Array<Array<string | number>> = [
    [],
    ["獎金月份", "規則名稱", "算了多少", "獎金金額"],
  ];
  for (const month of bonus.months) {
    for (const rule of month.rules) {
      rows.push([
        month.month.slice(0, 7),
        rule.label,
        describeBonusRuleResult(rule),
        Number(rule.amount),
      ]);
    }
  }
  rows.push(["獎金合計", "", "", Number(bonus.total_amount)]);
  return rows;
}
