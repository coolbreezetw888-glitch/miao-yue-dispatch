// 紅利系統重構 批次 7(§4.6 建單表單的紅利區塊、§4.11 提示框紅利行,#842/#799/#916)的純邏輯。
// 規格書:.project/specs/紅利系統重構.md §3.2(預覽回傳格式)、§2.5、§2.10、§4.6,檔尾 v2.4 裁決 8~12、21。
//
// 為什麼抽成純函式(比照 bookingCreatedFeedback.ts / ordersPageLogic.ts 的既有慣例):
//   這一區塊的失敗模式幾乎都是「畫面看起來正常、數字或狀態錯了」——功能關閉卻顯示區塊、預覽出錯卻顯示
//   「0 點」、換了電話折抵還留著上一位會員的點數、改單時把客服設的派點洗掉。這些都寫在元件裡測不到,
//   所以集中在這裡,測試在 bookingPointsLogic.test.ts。
//
// ⚠️ 這裡只做「體驗層」:即時換算、先擋明顯錯誤、決定要送什麼參數。**真正的邊界在後端**
//   (create_booking / update_booking 用 compute_booking_planned_points / validate_booking_redeem 重算重驗)。
//
// 🔴 不可以拿 members/previewCalculators 的 computeRedeemExample(它把點數當無限)來算折抵:
//   建單時會員的點數是有限的,要處理「被餘額卡住」(v2.4 裁決 11)——那個情況由後端
//   compute_booking_redeem_limits 算好放在預覽的 redeem.max_points / max_amount,前端直接用。
//
// 🔴 不可以用 useMerchantMemberSettings 判斷紅利開關(判斷 13):只有 orders 鑰匙的客服讀不到設定表,
//   hook 會退回預設值「開著」。這一區塊的開關一律看 preview_booking_points 回傳的 feature_enabled。

import { parseAmountInput } from "@/components/patterns/parseAmountInput";

import { formatAmount } from "./orderAmount";

// ---------------------------------------------------------------------------
// 預覽回傳(§3.2)
// ---------------------------------------------------------------------------

export type PointsMemberResolution =
  "existing" | "new" | "given" | "none" | "phone_incomplete" | "ambiguous";

export interface PointsBreakdownItem {
  mode: "basic" | "advanced";
  name: string | null;
  quantity: number | null;
  unitPrice: number | null;
  formulaName: string | null;
  pointsPerUnit: number | null;
  threshold: number | null;
  points: number;
}

export interface PointsRedeemInfo {
  enabled: boolean;
  pointsUnit: number | null;
  amountUnit: number | null;
  maxRatioPercent: number | null;
  payable: number | null;
  availablePoints: number;
  /** v2.4 裁決 9/11:畫面建議的「最划算點數」——**不是硬上限**(裁決 12)。 */
  maxPoints: number;
  /** v2.4 裁決 10:maxPoints 實際可折的金額(「最多可折 NT$X」直接用它)。 */
  maxAmount: number;
  /** §2.10 第 2 點的比例上限 floor(應付 × 比例 / 100)。驗證「換算金額 ≤ 上限」比的是它。 */
  capAmount: number;
}

export type BookingPointsPreview =
  | { featureEnabled: false }
  | { featureEnabled: true; error: string }
  | {
      featureEnabled: true;
      error: null;
      resolution: PointsMemberResolution;
      memberId: string | null;
      memberName: string | null;
      balance: number | null;
      rulesConfigured: boolean;
      earnMode: "basic" | "advanced";
      autoPoints: number;
      reviewRequired: boolean;
      eligible: boolean;
      ineligibleReason: string | null;
      rewardConditionMode: string | null;
      breakdown: PointsBreakdownItem[];
      redeem: PointsRedeemInfo;
    };

export type BookingPointsPreviewOk = Extract<BookingPointsPreview, { error: null }>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

const RESOLUTIONS: ReadonlySet<string> = new Set([
  "existing",
  "new",
  "given",
  "none",
  "phone_incomplete",
  "ambiguous",
]);

/**
 * 把 preview_booking_points 的 jsonb 轉成前端型別。
 *
 * 🔴 v2.4 裁決 8 ④:回傳 `{feature_enabled: true, error: "…"}` 時**要原樣保留 error**,
 *    讓畫面顯示出來——不可以把缺少的 auto_points 當成 0(那就是「默默變成 0 點」)。
 *    回傳格式不認得時也當成錯誤處理,不是當成 0 點。
 */
export function parseBookingPointsPreview(raw: unknown): BookingPointsPreview {
  const obj = asObject(raw);
  if (!obj) return { featureEnabled: true, error: "紅利點數預覽回傳格式不正確" };
  if (obj["feature_enabled"] === false) return { featureEnabled: false };
  if (typeof obj["error"] === "string" && obj["error"].trim() !== "") {
    return { featureEnabled: true, error: obj["error"] };
  }
  const member = asObject(obj["member"]);
  const resolution = asString(member?.["resolution"]);
  const autoPoints = asNumber(obj["auto_points"]);
  if (!member || !resolution || !RESOLUTIONS.has(resolution) || autoPoints === null) {
    return { featureEnabled: true, error: "紅利點數預覽回傳格式不正確" };
  }
  const redeem = asObject(obj["redeem"]) ?? {};
  const breakdown = Array.isArray(obj["breakdown"]) ? obj["breakdown"] : [];
  return {
    featureEnabled: true,
    error: null,
    resolution: resolution as PointsMemberResolution,
    memberId: asString(member["member_id"]),
    memberName: asString(member["name"]),
    balance: asNumber(member["balance"]),
    rulesConfigured: obj["rules_configured"] === true,
    earnMode: obj["earn_mode"] === "advanced" ? "advanced" : "basic",
    autoPoints,
    reviewRequired: obj["review_required"] === true,
    eligible: obj["eligible"] === true,
    ineligibleReason: asString(obj["ineligible_reason"]),
    rewardConditionMode: asString(obj["reward_condition_mode"]),
    breakdown: breakdown.flatMap((item): PointsBreakdownItem[] => {
      const row = asObject(item);
      if (!row) return [];
      return [
        {
          mode: row["mode"] === "advanced" ? "advanced" : "basic",
          name: asString(row["name"]),
          quantity: asNumber(row["quantity"]),
          unitPrice: asNumber(row["unit_price"]),
          formulaName: asString(row["formula_name"]),
          pointsPerUnit: asNumber(row["points_per_unit"]),
          threshold: asNumber(row["threshold"]),
          points: asNumber(row["points"]) ?? 0,
        },
      ];
    }),
    redeem: {
      enabled: redeem["enabled"] === true,
      pointsUnit: asNumber(redeem["points_unit"]),
      amountUnit: asNumber(redeem["amount_unit"]),
      maxRatioPercent: asNumber(redeem["max_ratio_percent"]),
      payable: asNumber(redeem["payable"]),
      availablePoints: asNumber(redeem["available_points"]) ?? 0,
      maxPoints: asNumber(redeem["max_points"]) ?? 0,
      maxAmount: asNumber(redeem["max_amount"]) ?? 0,
      capAmount: asNumber(redeem["cap_amount"]) ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 區塊要顯示哪一種狀態(§4.6 顯示條件表)
// ---------------------------------------------------------------------------

export type BookingPointsBlockView =
  /** 還不知道功能有沒有開(第一次預覽還沒回來)⇒ 灰色骨架 */
  | "loading"
  /** feature_enabled = false ⇒ 整塊不渲染(不是灰掉) */
  | "hidden"
  /** 預覽回 error / 呼叫失敗 ⇒ 顯示原因,不顯示 0 點 */
  | "error"
  | "phone_incomplete"
  /** none / ambiguous ⇒ 「這筆訂單沒有連結會員,不會派點」 */
  | "no_member"
  /** 新客戶(送出後自動建立):派點照常,不顯示折抵 */
  | "new_member"
  /** existing / given:完整內容 */
  | "member";

export function resolveBookingPointsBlockView(
  preview: BookingPointsPreview | undefined,
  options: { fetchFailed?: boolean } = {},
): BookingPointsBlockView {
  if (!preview) return options.fetchFailed ? "error" : "loading";
  if (!preview.featureEnabled) return "hidden";
  if (preview.error !== null) return "error";
  switch (preview.resolution) {
    case "phone_incomplete":
      return "phone_incomplete";
    case "none":
    case "ambiguous":
      return "no_member";
    case "new":
      return "new_member";
    default:
      return "member";
  }
}

/** 這一區塊目前是否在「派點」(會送 override、要跳人工確認)的狀態。 */
export function blockShowsPoints(view: BookingPointsBlockView): boolean {
  return view === "member" || view === "new_member";
}

// ---------------------------------------------------------------------------
// reason 代碼 → 白話(§4.6 第 1 點)
// ---------------------------------------------------------------------------

/** 「需 {條件}」括號裡的字(reward_condition_mode → 白話)。 */
export const REWARD_CONDITION_REQUIREMENT_TEXT: Record<string, string> = {
  phone_verified: "電話已驗證",
  line_bound: "LINE 已綁定",
  either: "電話已驗證或 LINE 已綁定",
  both: "電話已驗證且 LINE 已綁定",
};

export function describeIneligibleReason(
  reason: string | null,
  resolution: PointsMemberResolution,
  rewardConditionMode: string | null,
): string | null {
  switch (reason) {
    case "reward_condition": {
      if (resolution === "new") return "新客戶尚未完成驗證，依商家設定這筆訂單不派點";
      const requirement = rewardConditionMode
        ? REWARD_CONDITION_REQUIREMENT_TEXT[rewardConditionMode]
        : undefined;
      return requirement
        ? `此會員未符合商家設定的核發資格條件(需 ${requirement})`
        : "此會員未符合商家設定的核發資格條件";
    }
    case "inviter_earning_disabled":
      return "商家設定推薦者不累積紅利";
    case "invitee_earning_disabled":
      return "商家設定被推薦者不累積紅利";
    default:
      return null;
  }
}

/** 進階模式逐項明細的一行字(預覽時用,讀的是這次預覽的計算結果)。 */
export function describeBreakdownItem(item: PointsBreakdownItem): string {
  const name = item.name ?? "(服務項目)";
  if (item.formulaName === null) return `${name}：沒有適用的公式，0 點`;
  if (item.points === 0) {
    return `${name}：公式「${item.formulaName}」單價未達 NT$${item.threshold ?? 0}，0 點`;
  }
  return `${name}：公式「${item.formulaName}」${item.quantity ?? 0} × ${item.pointsPerUnit ?? 0} 點 = ${item.points} 點`;
}

// ---------------------------------------------------------------------------
// 手動修改派點(§2.5 第 3 點、第 13 題)
// ---------------------------------------------------------------------------

export const POINTS_OVERRIDE_MAX = 100_000;
export const POINTS_OVERRIDE_MAX_ERROR = "單筆訂單最多只能設定 100,000 點，請確認是否多打了零";

export type PointsInputResult = { ok: true; value: number } | { ok: false; error: string };

/** v2.4 裁決 22 L3:點數欄位填了小數 / 文字 / 科學記號時,錯誤一律講「只能填整數」
 * (共用的 parseAmountInput 會說「只能填數字和小數點」,對點數欄位是錯的提示)。空白與負數沿用原本的話。 */
export const POINTS_INTEGER_ONLY_ERROR = "只能填整數";

function parsePointsInput(raw: string): { ok: true; value: number } | { ok: false; error: string } {
  const parsed = parseAmountInput(raw, { integerOnly: true, noun: "點數" });
  if (parsed.ok) return parsed;
  const text = raw.trim();
  if (text !== "" && !/^-\d+$/.test(text)) return { ok: false, error: POINTS_INTEGER_ONLY_ERROR };
  return { ok: false, error: parsed.error };
}

export function validatePointsOverride(raw: string): PointsInputResult {
  const parsed = parsePointsInput(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (parsed.value > POINTS_OVERRIDE_MAX) return { ok: false, error: POINTS_OVERRIDE_MAX_ERROR };
  return { ok: true, value: parsed.value };
}

// ---------------------------------------------------------------------------
// 點數折抵(§2.10、第 17 題、v2.4 裁決 8 ③ / 12)
// ---------------------------------------------------------------------------

/**
 * 點數 → 折抵金額,無條件捨去到整數元(第 17 題)。跟後端 private.redeem_points_to_amount 同一個算式:
 * floor(points × amountUnit / pointsUnit)。
 * 用 BigInt 把金額單位的小數放大成整數再算,避免 0.1 這類小數在浮點數下捨去錯一元
 * (例:3 點 × 0.1 / 0.3 用浮點數算會得到 0.9999… ⇒ 0 元,後端 numeric 算是 1 元)。
 */
export function redeemPointsToAmount(
  points: number,
  pointsUnit: number | null,
  amountUnit: number | null,
): number {
  if (!Number.isInteger(points) || points <= 0) return 0;
  if (pointsUnit === null || amountUnit === null || pointsUnit <= 0 || amountUnit <= 0) return 0;
  const [intPart, fracPart = ""] = String(amountUnit).split(".");
  if (!/^\d+$/.test(intPart ?? "") || !/^\d*$/.test(fracPart) || !Number.isInteger(pointsUnit)) {
    // 不是一般十進位寫法(極端的科學記號等)⇒ 退回浮點數算(加一點容差)。
    return Math.floor((points * amountUnit) / pointsUnit + 1e-9);
  }
  const scale = 10n ** BigInt(fracPart.length);
  const amountScaled = BigInt(`${intPart}${fracPart}`);
  return Number((BigInt(points) * amountScaled) / (BigInt(pointsUnit) * scale));
}

/** 換算後至少折得到 1 元的最少點數(錯誤訊息用;跟後端 validate_booking_redeem 同一個找法)。 */
export function minimumPointsForOneDollar(
  pointsUnit: number | null,
  amountUnit: number | null,
): number | null {
  if (pointsUnit === null || amountUnit === null || pointsUnit <= 0 || amountUnit <= 0) return null;
  let p = Math.max(1, Math.floor(pointsUnit / amountUnit) - 1);
  for (
    let guard = 0;
    guard < 1000 && redeemPointsToAmount(p, pointsUnit, amountUnit) < 1;
    guard++
  ) {
    p += 1;
  }
  return p;
}

function formatUnit(n: number | null): string {
  return n === null ? "—" : String(Number(n));
}

export interface RedeemValidation {
  points: number;
  amount: number;
  error: string | null;
  /** 「以 100 點為單位可折得最划算」——輔助說明,不是擋(第 17 題)。 */
  hint: string | null;
}

/**
 * 折抵點數的即時檢查(體驗層)。比的是 v2.4 裁決 12 定的兩件事 + 裁決 8 ③:
 *   ① 點數 ≤ 可用點數(編輯模式的可用點數已含本單凍結,後端預覽算好的)
 *   ② 換算金額 ≤ cap_amount(比例上限)——**不是**拿 max_points 當硬上限(任意點數都收)
 *   ③ 換算後至少 1 元
 * 錯誤文案跟後端 validate_booking_redeem 的意思一致;送出時後端仍會重驗一次。
 */
export function validateRedeemPoints(raw: string, redeem: PointsRedeemInfo): RedeemValidation {
  const parsed = parsePointsInput(raw);
  if (!parsed.ok) return { points: 0, amount: 0, error: parsed.error, hint: null };
  const points = parsed.value;
  const amount = redeemPointsToAmount(points, redeem.pointsUnit, redeem.amountUnit);
  if (points === 0) return { points, amount: 0, error: null, hint: null };

  if (points > redeem.availablePoints) {
    return {
      points,
      amount,
      error: `這位會員目前只有 ${redeem.availablePoints} 點，無法折抵 ${points} 點`,
      hint: null,
    };
  }
  if (amount < 1) {
    const min = minimumPointsForOneDollar(redeem.pointsUnit, redeem.amountUnit);
    return {
      points,
      amount,
      error: `折抵 ${points} 點換算後不到 1 元(目前 ${formatUnit(redeem.pointsUnit)} 點 = ${formatUnit(
        redeem.amountUnit,
      )} 元)${min !== null ? `，至少要使用 ${min} 點才折得到 1 元` : ""}`,
      hint: null,
    };
  }
  if (amount > redeem.capAmount) {
    return {
      points,
      amount,
      error: `本單最多可折抵 ${formatAmount(redeem.capAmount)}(應付金額的 ${
        redeem.maxRatioPercent ?? 0
      }%)，折抵 ${points} 點可折 ${formatAmount(amount)}，已超過上限；建議改成 ${redeem.maxPoints} 點`,
      hint: null,
    };
  }
  const hint =
    redeem.pointsUnit !== null && points % redeem.pointsUnit !== 0
      ? `以 ${redeem.pointsUnit} 點為單位可折得最划算`
      : null;
  return { points, amount, error: null, hint };
}

// ---------------------------------------------------------------------------
// 判斷 24:預覽對到的會員變了 ⇒ 折抵歸零
// ---------------------------------------------------------------------------

/** 預覽對到「哪一位」的識別字。沒有派點狀態(錯誤、功能關閉)時回 null = 不判斷。 */
export function previewMemberKey(preview: BookingPointsPreview | undefined): string | null {
  if (!preview || !preview.featureEnabled || preview.error !== null) return null;
  return `${preview.resolution}:${preview.memberId ?? ""}`;
}

/**
 * 上一次對到的會員跟這一次不同,而且客服已經開了折抵(或填了點數)⇒ 要把折抵關掉、點數清成 0,
 * 並顯示「客戶電話已變更,紅利折抵已重設」。
 * 第一次載入(prev = null)不算變更 —— 編輯模式一打開就有原折抵,不能一開就被清掉。
 */
export function shouldResetRedeemOnMemberChange(
  prevKey: string | null,
  nextKey: string | null,
  redeemActive: boolean,
): boolean {
  if (!redeemActive) return false;
  if (prevKey === null || nextKey === null) return false;
  return prevKey !== nextKey;
}

// ---------------------------------------------------------------------------
// 編輯模式:重算後的提示(§2.4 裁決 11 / 第 6 題)
// ---------------------------------------------------------------------------

export interface OriginalBookingPoints {
  planned: number;
  plannedAuto: number;
  overridden: boolean;
  redeemed: number;
  redeemAmount: number;
}

export function describeEditPointsChange(
  original: OriginalBookingPoints,
  newAuto: number,
): { kind: "auto_changed" | "override_kept"; text: string } | null {
  if (original.overridden) {
    if (newAuto === original.plannedAuto) return null;
    return {
      kind: "override_kept",
      text: `系統建議值已從 ${original.plannedAuto} 點變成 ${newAuto} 點，目前人工設定為 ${original.planned} 點`,
    };
  }
  if (newAuto === original.planned) return null;
  return { kind: "auto_changed", text: `派點數已從 ${original.planned} 點變成 ${newAuto} 點` };
}

// ---------------------------------------------------------------------------
// 送出參數(§3.3 第 6 步、§3.4 第 0-1 步、派工單提醒 1)
// ---------------------------------------------------------------------------

export interface PointsFormState {
  /** 這次預覽的區塊狀態。 */
  view: BookingPointsBlockView;
  overrideEnabled: boolean;
  /** overrideEnabled 時已驗證過的點數;無效時呼叫端不可以送出。 */
  overrideValue: number | null;
  /** 折抵開關這次有沒有出現在畫面上(existing/given 且 redeem.enabled)。 */
  redeemAvailable: boolean;
  redeemEnabled: boolean;
  redeemPoints: number;
  /** v2.4 裁決 22 ①:這次預覽對到的會員 id(existing / given)= 折抵要扣誰的點數。 */
  redeemMemberId: string | null;
}

/** 新增模式:override 只在區塊有在派點、且開了手動修改時才帶;折抵沒開一律 0。 */
export function buildCreatePointsParams(state: PointsFormState): {
  pointsOverride: number | null;
  pointsRedeemed: number;
  pointsRedeemMemberId: string | null;
} {
  const showsPoints = blockShowsPoints(state.view);
  const pointsRedeemed =
    state.view === "member" && state.redeemAvailable && state.redeemEnabled
      ? state.redeemPoints
      : 0;
  return {
    pointsOverride:
      showsPoints && state.overrideEnabled && state.overrideValue !== null
        ? state.overrideValue
        : null,
    pointsRedeemed,
    // v2.4 裁決 22 ①:有折抵才帶「要扣誰」;後端比對不符就擋。
    pointsRedeemMemberId: pointsRedeemed > 0 ? state.redeemMemberId : null,
  };
}

/**
 * 編輯模式(派工單提醒 1):
 *   ・pointsRedeemed:折抵開關有出現 ⇒ 帶表單上的值(開關關 = 0 = 退回);沒出現(功能關閉、會員已下架、
 *     預覽出錯…)⇒ null = 「維持這張單目前的折抵」,不會把客人的點數默默退掉。
 *   ・pointsOverride:**沒改就送 null**(功能關閉時帶值會被後端擋)。只有「這次新開手動修改」或「改了數字」才帶。
 *   ・pointsOverrideReset:原本是人工設定、這次把手動修改關掉(或按了「改用建議值」)⇒ true。
 *   功能關閉(view = hidden)時三個都不動。
 */
export function buildUpdatePointsParams(
  state: PointsFormState,
  original: OriginalBookingPoints,
): {
  pointsOverride: number | null;
  pointsOverrideReset: boolean;
  pointsRedeemed: number | null;
  pointsRedeemMemberId: string | null;
} {
  let pointsOverride: number | null = null;
  let pointsOverrideReset = false;
  if (blockShowsPoints(state.view)) {
    if (original.overridden && !state.overrideEnabled) {
      pointsOverrideReset = true;
    } else if (
      state.overrideEnabled &&
      state.overrideValue !== null &&
      (!original.overridden || state.overrideValue !== original.planned)
    ) {
      pointsOverride = state.overrideValue;
    }
  }
  const pointsRedeemed =
    state.view === "member" && state.redeemAvailable
      ? state.redeemEnabled
        ? state.redeemPoints
        : 0
      : null;
  return {
    pointsOverride,
    pointsOverrideReset,
    pointsRedeemed,
    pointsRedeemMemberId:
      pointsRedeemed !== null && pointsRedeemed > 0 ? state.redeemMemberId : null,
  };
}

/** v2.4 裁決 22 ① (b):預覽還沒跟上目前輸入時,擋送出用的提示。 */
export const POINTS_PREVIEW_STALE_MESSAGE = "紅利點數正在重新計算，請稍候再送出";

/**
 * v2.4 裁決 22 ① (b):預覽不是「目前這份輸入」的結果(debounce 還沒送、正在重查、或畫面上顯示的是上一次的
 * 結果)時,只要這次送出會用到預覽的數字 —— 折抵開著、手動派點開著、或要跳人工確認 —— 就先擋下。
 * 都沒有的話(單純建單、不碰紅利)不用等,後端自己會算派點。
 */
export function isPointsSubmitBlockedByStalePreview(input: {
  previewStale: boolean;
  view: BookingPointsBlockView;
  overrideEnabled: boolean;
  redeemActive: boolean;
  reviewConfirmNeeded: boolean;
}): boolean {
  if (!input.previewStale) return false;
  return (
    input.redeemActive ||
    (input.overrideEnabled && blockShowsPoints(input.view)) ||
    input.reviewConfirmNeeded
  );
}

/** 送出時要不要先跳「人工確認派點」小卡窗(§2.5 第 2 點)。 */
export function needsPointsReviewConfirm(input: {
  view: BookingPointsBlockView;
  customTotalAmountEnabled: boolean;
  discountEnabled: boolean;
}): boolean {
  return blockShowsPoints(input.view) && (input.customTotalAmountEnabled || input.discountEnabled);
}

// ---------------------------------------------------------------------------
// §4.7 訂單詳情的紅利那幾行(只看這張訂單自己的欄位,不看商家目前的功能開關)
// ---------------------------------------------------------------------------

export interface BookingDetailPointsInput {
  status: string;
  points_planned: number;
  points_planned_overridden: boolean;
  points_redeemed: number;
  points_redeem_amount_snapshot: number | string;
  final_amount_snapshot: number | string;
}

export interface BookingDetailPointsLedgerInput {
  /** 本單 earn_booking 加總;從未入帳為 null。 */
  earnedPoints: number | null;
  effectivePoints: number | null;
  reversedPoints: number;
}

// ---------------------------------------------------------------------------
// #844 §4.8「已入帳」看淨額(訂單詳情與會員頁相關訂單共用)
// ---------------------------------------------------------------------------

export interface EarnedPointsInput {
  /** 訂單目前狀態。 */
  status: string;
  /** 入帳毛額(本單 earn_booking 加總);從未入帳為 null。 */
  earned: number | null;
  /** 被收回的點數(正數),沒有為 0。 */
  reversed: number;
  /** 有效入帳 = 入帳 − 收回。 */
  effective: number | null;
}

/**
 * 「已入帳 / 已收回」那一句話。#844 起同一張單可以「完成 → 還原 → 再完成」,也可以完成後取消,
 * 所以不能只看「有沒有一筆 earn_booking」:
 *   ・從未入帳(earned 為 null)⇒ null(不顯示;已取消的單由呼叫端維持「已取消,不入帳」)。
 *   ・已完成且有效入帳 > 0 ⇒「已入帳 {有效} 點」,曾收回過再加「(曾收回 {收回} 點)」。
 *   ・其他(還原後的已確認、取消後的已取消、極少見的「已完成但有效 0」)⇒「已收回 {收回} 點」;
 *     有效 > 0(= 有差額沒收回)再加「,差額 {有效} 點未收回」;已取消的前面加「已取消,」。
 */
export function describeEarnedPoints(input: EarnedPointsInput): string | null {
  if (input.earned === null) return null;
  const effective = Math.max(input.effective ?? 0, 0);
  const reversed = Math.max(input.reversed, 0);
  if (input.status === "completed" && effective > 0) {
    return reversed > 0
      ? `已入帳 ${effective} 點(曾收回 ${reversed} 點)`
      : `已入帳 ${effective} 點`;
  }
  const prefix = input.status === "cancelled" ? "已取消，" : "";
  const shortfall = effective > 0 ? `，差額 ${effective} 點未收回` : "";
  return `${prefix}已收回 ${reversed} 點${shortfall}`;
}

export interface BookingDetailPointsView {
  /** 派點那一組要不要顯示(points_planned > 0 或 points_redeemed > 0)。 */
  show: boolean;
  plannedText: string | null;
  /** 入帳過的單才有(describeEarnedPoints);從未入帳的取消單 =「已取消,不入帳」;其他 null(含查詢中)。 */
  earnedText: string | null;
  /** 「N 點(−$X)」;沒有折抵為 null。 */
  redeemText: string | null;
  /** 實付 = 最終金額 − 折抵金額(只在顯示層相減,§2.11);沒有折抵為 null。 */
  paidAmount: number | null;
}

/**
 * 功能關閉後,歷史訂單當初派過 / 折過的紀錄仍要看得到(那是已經發生的事)⇒ 只看訂單自己的欄位。
 */
export function describeBookingDetailPoints(
  booking: BookingDetailPointsInput,
  ledger: BookingDetailPointsLedgerInput | null,
): BookingDetailPointsView {
  // #844 批次 4(批次 3 QA 觀察 ①):還原後改單把派點改成 0 的單,分類帳上仍有上一輪的入帳 / 收回 / 差額
  // ⇒ 「入帳過」(ledger.earnedPoints 不是 null)也要顯示這一組,不然舊差額會從畫面上消失。
  const hasLedgerHistory = ledger !== null && ledger.earnedPoints !== null;
  const show = booking.points_planned > 0 || booking.points_redeemed > 0 || hasLedgerHistory;
  const redeemAmount = Number(booking.points_redeem_amount_snapshot);
  // #844 §4.8:入帳過的單(含還原後的已確認、取消後的已取消)一律照分類帳講「已入帳 / 已收回 / 差額」。
  let earnedText: string | null = ledger
    ? describeEarnedPoints({
        status: booking.status,
        earned: ledger.earnedPoints,
        reversed: ledger.reversedPoints,
        effective: ledger.effectivePoints,
      })
    : null;
  // v2.4 裁決 22 L2:取消的單不會入帳,講清楚(不然畫面上只剩「預定派點 N 點」,看起來像還會入帳)。
  // 只用在「從來沒入帳過」的取消單;入帳過又被收回的取消單由上面講「已取消,已收回 N 點」。
  if (earnedText === null && booking.status === "cancelled") {
    earnedText = "已取消，不入帳";
  }
  return {
    show,
    plannedText:
      booking.points_planned > 0 || booking.points_planned_overridden || hasLedgerHistory
        ? `${booking.points_planned} 點${booking.points_planned_overridden ? "(人工設定)" : ""}`
        : null,
    earnedText,
    redeemText:
      booking.points_redeemed > 0
        ? `${booking.points_redeemed} 點(−${formatAmount(redeemAmount)})`
        : null,
    paidAmount:
      booking.points_redeemed > 0 ? Number(booking.final_amount_snapshot) - redeemAmount : null,
  };
}
