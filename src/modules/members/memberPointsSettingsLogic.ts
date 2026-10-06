// 紅利系統重構 批次 6(規格書 .project/specs/紅利系統重構.md §4.1~§4.5):紅利點數管理頁四個分頁的純函式。
//
// 為什麼抽出來:這頁所有「會算數字、會決定要不要顯示什麼」的邏輯都放這裡,元件只負責呈現,
// Vitest 才能逐條驗(分頁顯示條件、標籤切換、一句話預覽、重複偵測、範例試算、生日 7 種狀態標籤)。
//
// 🔴 這裡的「試算」都只是畫面上的範例,**真正的計算一律在資料庫**(private.compute_booking_planned_points、
//    private.compute_booking_redeem_limits)。這裡的算式必須跟那兩支一致(規格書 §〇.3 判斷 5:
//    前端只放簡單算術做即時預覽,真正的邊界在後端),改後端算式時要回來同步這裡。

import {
  parseAmountInput,
  type ParseAmountInputResult,
  type StatusTone,
} from "@/components/patterns";

import type {
  BirthdayLineStatus,
  EarnMode,
  MemberSettingsView,
  MerchantPointFormula,
  PointFormulaServiceItem,
} from "./types";

// =========================================================================
// §4.1 骨架:分頁顯示條件
// =========================================================================

export type PointsSettingsTab = "calc" | "usage" | "referral" | "birthday";

export const POINTS_SETTINGS_TABS: { value: PointsSettingsTab; label: string }[] = [
  { value: "calc", label: "紅利計算" },
  { value: "usage", label: "點數使用" },
  { value: "referral", label: "推薦系統" },
  { value: "birthday", label: "生日獎勵" },
];

/**
 * §4.1 第 4 點 + 權限:四個分頁只在「看得到規則」且「紅利功能開著」時渲染。
 * 讀不到設定(出錯 / 還在載入)時一律不渲染 —— 不能用預設值猜「應該是開著的」。
 */
export function shouldRenderPointsTabs(input: {
  canManagePointsRules: boolean;
  settings: Pick<MemberSettingsView, "points_feature_enabled"> | null | undefined;
}): boolean {
  return input.canManagePointsRules && input.settings?.points_feature_enabled === true;
}

// =========================================================================
// 欄位數字解析(共用)
// =========================================================================

/** 資料庫 integer 的上限:超過會變成 22003 數值溢位,先在前端擋下並給白話。 */
export const MAX_DB_INTEGER = 2147483647;
/** numeric(10,2) 的上限。 */
export const MAX_DB_AMOUNT = 99999999.99;

export function parsePointsField(raw: string): ParseAmountInputResult {
  return parseAmountInput(raw, { integerOnly: true, noun: "點數", max: MAX_DB_INTEGER });
}

export function parseMoneyField(raw: string): ParseAmountInputResult {
  return parseAmountInput(raw, { max: MAX_DB_AMOUNT });
}

/** 「點數 : 金額」兩個比例欄位允許「同時空」(= 不開放折抵),所以空白視為 0。 */
function parseBlankAsZero(
  raw: string,
  parse: (raw: string) => ParseAmountInputResult,
): ParseAmountInputResult {
  return raw.trim() === "" ? { ok: true, value: 0 } : parse(raw);
}

// =========================================================================
// §4.2 紅利計算 — 基本設定
// =========================================================================

/** §4.2 第 2 點:「每滿額累計贈點」開關一開,前兩欄的標籤即時改名。 */
export function basicFieldLabels(tieredEnabled: boolean): {
  pointsPerOrder: string;
  minAmount: string;
} {
  return tieredEnabled
    ? { pointsPerOrder: "每滿額獲得", minAmount: "每滿額消費金額" }
    : { pointsPerOrder: "每筆訂單獲得", minAmount: "最低消費金額" };
}

/**
 * §2.2 基本模式公式(跟 private.compute_booking_planned_points 的基本模式分支一致):
 *   - 每筆訂單獲得 = 0 ⇒ 0(尚未設定)
 *   - 未開累計:base >= 門檻 ⇒ 每筆獲得;否則 0(門檻 0 = 每筆都給)
 *   - 開累計:floor(base / 門檻) × 每滿額獲得(門檻 > 0 由 CHECK 保證)
 */
export function computeBasicPoints(
  base: number,
  rule: { pointsPerOrder: number; minAmount: number; tieredEnabled: boolean },
): number {
  if (rule.pointsPerOrder <= 0) return 0;
  if (rule.tieredEnabled) {
    if (rule.minAmount <= 0) return 0;
    return Math.floor(base / rule.minAmount) * rule.pointsPerOrder;
  }
  return base >= rule.minAmount ? rule.pointsPerOrder : 0;
}

export interface BasicDraft {
  pointsPerOrder: string;
  minAmount: string;
  tieredEnabled: boolean;
}

export interface BasicValidation {
  pointsPerOrder: ParseAmountInputResult;
  minAmount: ParseAmountInputResult;
  /** 累計開啟但門檻是 0(資料庫 CHECK 會擋,前端先講白話)。 */
  tieredNeedsMinAmount: boolean;
  ok: boolean;
}

export const TIERED_NEEDS_MIN_AMOUNT_MESSAGE =
  "開啟「每滿額累計贈點」時，每滿額消費金額要大於 0(否則系統不知道每滿多少要再送一次)";

export function validateBasicDraft(draft: BasicDraft): BasicValidation {
  const pointsPerOrder = parsePointsField(draft.pointsPerOrder);
  const minAmount = parseMoneyField(draft.minAmount);
  const tieredNeedsMinAmount = draft.tieredEnabled && minAmount.ok && minAmount.value <= 0;
  return {
    pointsPerOrder,
    minAmount,
    tieredNeedsMinAmount,
    ok: pointsPerOrder.ok && minAmount.ok && !tieredNeedsMinAmount,
  };
}

// =========================================================================
// §4.2 紅利計算 — 進階公式
// =========================================================================

/** Radix Select 不收空字串 ⇒ 「全部服務項目」用這個值代表 service_item_id = null。 */
export const ALL_SERVICE_ITEMS_VALUE = "__all_service_items__";

export interface FormulaDraft {
  /** 畫面用的穩定 key(新公式還沒有 id)。 */
  key: string;
  /** 已存過的公式才有;新公式為 null。 */
  id: string | null;
  name: string;
  enabled: boolean;
  serviceItemId: string | null;
  minUnitPrice: string;
  pointsPerUnit: string;
}

export function formulaToDraft(formula: MerchantPointFormula): FormulaDraft {
  return {
    key: formula.id,
    id: formula.id,
    name: formula.name,
    enabled: formula.enabled,
    serviceItemId: formula.service_item_id,
    minUnitPrice: String(formula.min_unit_price),
    pointsPerUnit: String(formula.points_per_unit),
  };
}

export function formatNtd(amount: number): string {
  return `NT$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatThreshold(amount: number): string {
  // 截圖格式「單項金額≥2200元」:不加千分位,小數點有才顯示。
  return Number.isInteger(amount) ? String(amount) : String(Number(amount.toFixed(2)));
}

/**
 * §4.2 第 4 點一句話預覽(使用者截圖的格式):
 *   `壁掛分離式 (普通機型) [NT$2,200]: 數量 × 50點 (單項金額≥2200元)`
 *   `全部服務項目: 數量 × 50點 (單項金額≥2200元)`
 *   門檻 0 時省略括號。點數或門檻還沒填好(不是合法數字)時回 null,畫面不顯示半套句子。
 */
export function formulaPreviewSentence(input: {
  item: Pick<PointFormulaServiceItem, "name" | "price"> | null;
  pointsPerUnit: string;
  minUnitPrice: string;
}): string | null {
  const points = parsePointsField(input.pointsPerUnit);
  const threshold = parseMoneyField(input.minUnitPrice);
  if (!points.ok || !threshold.ok) return null;
  const head = input.item ? `${input.item.name} [${formatNtd(input.item.price)}]` : "全部服務項目";
  const tail = threshold.value > 0 ? ` (單項金額≥${formatThreshold(threshold.value)}元)` : "";
  return `${head}: 數量 × ${points.value}點${tail}`;
}

export interface FormulaItemOption {
  value: string;
  label: string;
  disabled: boolean;
  /** 「已有公式」/「(已下架)」這類旁註。 */
  note: string | null;
}

/**
 * §4.2 第 3 點 + 第 5 點 (c):某一張公式卡的服務項目下拉。
 *   - 第一個選項「全部服務項目」;已經有別的公式是「全部」⇒ 變灰 + 「已有公式」
 *   - 上架中的項目,格式 `名稱 (NT$現價)`;已被**別的**公式設過 ⇒ 變灰 + 「已有公式」
 *   - 已下架的項目只在「這張卡自己綁著它」時出現,標「(已下架)」
 *   🔴 自己這張卡目前選的那個值永遠可選(不然下拉會顯示不出目前的值)。
 */
export function formulaItemOptions(
  drafts: Pick<FormulaDraft, "key" | "serviceItemId">[],
  currentKey: string,
  items: PointFormulaServiceItem[],
): FormulaItemOption[] {
  const current = drafts.find((d) => d.key === currentKey);
  const usedByOthers = new Set(
    drafts
      .filter((d) => d.key !== currentKey)
      .map((d) => d.serviceItemId ?? ALL_SERVICE_ITEMS_VALUE),
  );
  const options: FormulaItemOption[] = [
    {
      value: ALL_SERVICE_ITEMS_VALUE,
      label: "全部服務項目",
      disabled: usedByOthers.has(ALL_SERVICE_ITEMS_VALUE),
      note: usedByOthers.has(ALL_SERVICE_ITEMS_VALUE) ? "已有公式" : null,
    },
  ];
  for (const item of items) {
    const isCurrent = current?.serviceItemId === item.id;
    if (item.status === "removed" && !isCurrent) continue;
    const taken = usedByOthers.has(item.id);
    options.push({
      value: item.id,
      label: `${item.name} (${formatNtd(item.price)})`,
      disabled: taken,
      note: item.status === "removed" ? "(已下架)" : taken ? "已有公式" : null,
    });
  }
  return options;
}

/**
 * §4.2 第 6 點:儲存前前端再擋一次重複(萬一兩個分頁同時開)。
 * 回傳第一組重複:被重複的項目名稱 + 先設定它的公式名稱;沒有重複回 null。
 */
export function findDuplicateFormula(
  drafts: Pick<FormulaDraft, "name" | "serviceItemId">[],
  items: Pick<PointFormulaServiceItem, "id" | "name">[],
): { itemLabel: string; formulaName: string } | null {
  const seen = new Map<string, string>();
  for (const draft of drafts) {
    const key = draft.serviceItemId ?? ALL_SERVICE_ITEMS_VALUE;
    const first = seen.get(key);
    if (first !== undefined) {
      const itemLabel =
        draft.serviceItemId === null
          ? "全部服務項目"
          : (items.find((i) => i.id === draft.serviceItemId)?.name ?? "這個服務項目");
      return { itemLabel, formulaName: first };
    }
    seen.set(key, draft.name.trim() || "(未命名)");
  }
  return null;
}

export function duplicateFormulaMessage(dup: { itemLabel: string; formulaName: string }): string {
  return `「${dup.itemLabel}」已被公式「${dup.formulaName}」設定，同一個服務項目只能有一條公式`;
}

/** 新公式預設名稱「公式 N」:N = 目前最大的「公式 k」+ 1(刪掉中間的不會撞名),沒有就用張數 + 1。 */
export function nextFormulaName(drafts: Pick<FormulaDraft, "name">[]): string {
  let max = 0;
  for (const d of drafts) {
    const m = /^公式\s*(\d+)$/.exec(d.name.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `公式 ${Math.max(max, drafts.length) + 1}`;
}

export interface FormulaDraftValidation {
  name: string | null;
  minUnitPrice: ParseAmountInputResult;
  pointsPerUnit: ParseAmountInputResult;
  ok: boolean;
}

export function validateFormulaDraft(draft: FormulaDraft): FormulaDraftValidation {
  const trimmed = draft.name.trim();
  const name =
    trimmed.length === 0
      ? "請填公式名稱"
      : [...trimmed].length > 50
        ? "公式名稱最多 50 個字"
        : null;
  const minUnitPrice = parseMoneyField(draft.minUnitPrice);
  const pointsPerUnit = parsePointsField(draft.pointsPerUnit);
  return { name, minUnitPrice, pointsPerUnit, ok: !name && minUnitPrice.ok && pointsPerUnit.ok };
}

/**
 * 一張公式卡要不要顯示 (b)「這個項目有自己的公式,不吃『全部服務項目』那條。」
 *
 * v2.4 裁決 21 ②(文案不改,只改顯示條件):**這張公式本身開著**、而且**「全部服務項目」那條也開著**才顯示。
 *   ・這張關著 ⇒ 計算引擎根本不會用它(§2.3:停用的個別公式會改吃「全部」那條),再說「不吃全部那條」是錯的。
 *   ・「全部」那條關著 ⇒ 根本沒有東西可以「不吃」,這句話只會讓人困惑。
 */
export function shouldShowOwnFormulaNote(
  draft: Pick<FormulaDraft, "serviceItemId" | "enabled">,
  drafts: Pick<FormulaDraft, "serviceItemId" | "enabled">[],
): boolean {
  return (
    draft.enabled &&
    draft.serviceItemId !== null &&
    drafts.some((d) => d.serviceItemId === null && d.enabled)
  );
}

// =========================================================================
// §4.3 點數使用
// =========================================================================

export interface RedeemDraft {
  pointsUnit: string;
  amountUnit: string;
  maxRatioPercent: string;
}

export const REDEEM_PAIR_MESSAGE =
  "「點數」跟「金額」要一起填(兩個都大於 0)，或兩個都留 0 代表不開放折抵";

export interface RedeemValidation {
  pointsUnit: ParseAmountInputResult;
  amountUnit: ParseAmountInputResult;
  maxRatioPercent: ParseAmountInputResult;
  pairMismatch: boolean;
  ok: boolean;
}

export function validateRedeemDraft(draft: RedeemDraft): RedeemValidation {
  const pointsUnit = parseBlankAsZero(draft.pointsUnit, parsePointsField);
  const amountUnit = parseBlankAsZero(draft.amountUnit, parseMoneyField);
  const maxRatioPercent = parseAmountInput(draft.maxRatioPercent, {
    integerOnly: true,
    noun: "比例",
    max: 100,
  });
  const pairMismatch =
    pointsUnit.ok && amountUnit.ok && pointsUnit.value > 0 !== amountUnit.value > 0;
  return {
    pointsUnit,
    amountUnit,
    maxRatioPercent,
    pairMismatch,
    ok: pointsUnit.ok && amountUnit.ok && maxRatioPercent.ok && !pairMismatch,
  };
}

/**
 * §4.3 即時範例「以目前設定,一筆 NT$1,000 的訂單最多可用 N 點折抵 NT$M」。
 * 算式照 private.compute_booking_redeem_limits(v2.4 主腦裁決第 9~11 條),會員點數當成「夠多」:
 *   ① cap = floor(應付 × 比例 / 100)
 *   ② 換算金額不超過 cap 的最大點數 → 那個點數能折到的最大金額 A
 *   ③ 回「能折到 A 元的最少點數」(不含換不到錢的零頭)
 * 尚未設定(任一為 0)或連 1 元都折不到時回 null。金額單位用「分」整數運算,避免浮點誤差。
 */
export function computeRedeemExample(input: {
  pointsUnit: number;
  amountUnit: number;
  maxRatioPercent: number;
  payable: number;
}): { maxPoints: number; maxAmount: number; capAmount: number } | null {
  const { pointsUnit, amountUnit, maxRatioPercent, payable } = input;
  if (pointsUnit <= 0 || amountUnit <= 0 || maxRatioPercent <= 0) return null;
  const capAmount = Math.floor((Math.max(payable, 0) * maxRatioPercent) / 100);
  if (capAmount < 1) return null;
  const cents = Math.round(amountUnit * 100);
  const toAmount = (points: number) => Math.floor((points * cents) / (pointsUnit * 100));
  let byAmount = Math.ceil(((capAmount + 1) * pointsUnit * 100) / cents) - 1;
  while (byAmount > 0 && toAmount(byAmount) > capAmount) byAmount -= 1;
  const maxAmount = toAmount(byAmount);
  if (maxAmount < 1) return null;
  let maxPoints = Math.ceil((maxAmount * pointsUnit * 100) / cents);
  while (toAmount(maxPoints) < maxAmount) maxPoints += 1;
  return { maxPoints, maxAmount, capAmount };
}

// =========================================================================
// §4.5 生日獎勵
// =========================================================================

export const BIRTHDAY_LINE_MESSAGE_MAX = 1000;

/** 字數照資料庫 char_length 的算法(以「字」計,emoji 算 1 個),不用 JS 的 .length(那會把 emoji 算成 2)。 */
export function countMessageChars(text: string): number {
  return [...text].length;
}

/** §4.5 第 3 點:三個可用變數(中文意思照 skill 二之七三欄說明)。 */
export const BIRTHDAY_TEMPLATE_VARIABLES: { key: string; label: string }[] = [
  { key: "member_name", label: "會員姓名" },
  { key: "points", label: "贈送點數" },
  { key: "merchant_name", label: "商家名稱" },
];

export function birthdaySampleValues(input: {
  merchantName: string;
  points: number | null;
}): Record<string, string> {
  return {
    member_name: "王小明",
    // 還沒填好點數時用 100 當範例,不顯示「0」這種會讓人以為真的送 0 點的值。
    points: String(input.points && input.points > 0 ? input.points : 100),
    merchant_name: input.merchantName,
  };
}

/** 同 Edge Function birthday-line-dispatch 的 renderMessageTemplate:找 {{變數}} 代入,對不到的原樣保留。 */
export function renderBirthdayMessage(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? (values[key] ?? match) : match,
  );
}

/** 生日紀錄「LINE 狀態」標籤顏色(skill 二之四:正常=綠、要處理=黃、結束或略過=灰、出事=紅)。 */
export function birthdayLineStatusTone(status: BirthdayLineStatus): StatusTone {
  switch (status) {
    case "sent":
      return "success";
    case "pending":
      return "warning";
    case "failed":
      return "danger";
    default:
      return "neutral";
  }
}

export function earnModeFromSwitch(advanced: boolean): EarnMode {
  return advanced ? "advanced" : "basic";
}

/** 生日紀錄的時間一律用台北時間顯示(排程本身就是依台北時間跑的)。 */
export function formatTaipeiDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", {
    hour12: false,
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
