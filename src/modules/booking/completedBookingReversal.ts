// #844 已完成訂單取消/還原 —— 批次 4 UI 的純邏輯(規格書 .project/specs/已完成訂單取消與還原.md
// §3.3、§3.8、§3.12、§3.13、§五 5.1~5.4、§十 Vitest)。
//
// 為什麼抽成純函式(比照 bookingPointsLogic.ts / ordersPageLogic.ts 的慣例):這個畫面的失敗模式幾乎都是
// 「畫面看起來正常、講的話或數字錯了」——取消路徑文案漏講退款、預計差額拿錯路徑的欄位、匯入單的還原鈕
// 沒灰掉、跨月月份差一個月、原因字數跟後端算法不同(前端說可以、後端擋下)。集中在這裡測。
//
// ⚠️ 這裡只做「體驗層」。真正的邊界(只有管理員、原因必填 / 500 字、狀態必須是已完成、匯入單不能還原)
//    全在後端 private.reverse_booking_completion。
// ⚠️ 會員姓名、推薦人姓名、shortfall_hint 都是**資料**(商家打的字),一律當純文字交給 React 渲染,
//    這裡不組 HTML、不解析連結(v1.2:提示裡沒有訂單 ID,用文字猜是哪張單會猜錯)。

import { isoToTaipeiDateTimeWithSeconds } from "./dateUtils";
import { formatAmount } from "./orderAmount";
import type {
  CompletedBookingReversalAction,
  CompletedBookingReversalPreview,
  CompletedBookingReversalResult,
  ReversalCodeMessage,
} from "./types";

// ---------------------------------------------------------------------------
// 文案(§3.12 / §5.2 第 2 點的定案文案;Vitest 守門:取消路徑必須同時含「抽成」「報表」「退款」)
// ---------------------------------------------------------------------------

/** 子畫面標題列(§5.2)。 */
export const REVERSAL_TITLES: Record<CompletedBookingReversalAction, string> = {
  revert: "還原完成",
  cancel: "取消已完成的訂單",
};

/**
 * 常駐黃色 `!`:按下去會發生什麼(§5.2 第 2 點,使用者釐清 Q8 的定案文案)。
 * 拆成段落讓規格書標粗體的字(「當時」「無法再復原」「但實際退款要另外處理」)加粗;字面跟規格逐字相同。
 */
export const REVERSAL_EXPLANATION_SEGMENTS: Record<CompletedBookingReversalAction, TextSegment[]> =
  {
    revert: [
      {
        text: "這張單會退回「已確認」,可以繼續編輯,之後要再按一次「標記完成」。服務人員抽成與會員紅利會先收回,重新完成時依",
      },
      { text: "當時", strong: true },
      { text: "的設定重新計算。" },
    ],
    cancel: [
      { text: "這張單會變成「已取消」," },
      { text: "無法再復原", strong: true },
      { text: "。系統會自動更新服務人員抽成與帳務報表。" },
      { text: "但實際退款要另外處理", strong: true },
      { text: "——系統沒有退款功能,請自行與客人結清。" },
    ],
  };

/** 同一段說明的純文字版(測試守門、需要字串的地方用)。 */
export const REVERSAL_EXPLANATIONS: Record<CompletedBookingReversalAction, string> = {
  revert: segmentsToText(REVERSAL_EXPLANATION_SEGMENTS.revert),
  cancel: segmentsToText(REVERSAL_EXPLANATION_SEGMENTS.cancel),
};

/** §5.1 / Q4 定案 A:客服(非管理員)看已完成訂單時的常駐 `!`。 */
export const AGENT_CANNOT_REVERSE_NOTE =
  "已完成的訂單只有商家管理員可以還原或取消。如果是誤按完成,請聯絡管理員。";

/** §5.2 第 8 點:取消路徑的通知開關(預設關,Q2 定案 C)。 */
export const CANCEL_NOTIFY_SWITCH = {
  title: "同時發送取消通知(LINE 給客戶、推播給服務人員)",
  description: "這張單的服務已經完成過,通常不需要再通知。打開後會依 LINE / 推播設定發送。",
} as const;

/** §5.4 成功 toast(已經發生的事,過去式)。 */
export const REVERSAL_SUCCESS_TOAST: Record<CompletedBookingReversalAction, string> = {
  revert: "已還原為已確認",
  cancel: "已取消訂單",
};

// ---------------------------------------------------------------------------
// 原因(§3.3):規則跟後端逐字一致
//   後端:btrim(coalesce(p_reason, ''), E' \t\r\n\u3000'),空 → raise;char_length > 500 → raise。
//   char_length 算的是「字元」(code point),JS 的 .length 算的是 UTF-16 單位(emoji 會算 2),
//   所以這裡用 Array.from 數,避免前端說 501、後端說 500 的落差。
// ---------------------------------------------------------------------------

export const REVERSAL_REASON_MAX = 500;

/** 去頭尾的半形空白、tab、換行(\r \n)、全形空白(U+3000)—— 跟後端 btrim 的字元集合一模一樣。 */
export function normalizeReversalReason(raw: string): string {
  return raw.replace(/^[ \t\r\n\u3000]+/, "").replace(/[ \t\r\n\u3000]+$/, "");
}

/** 字數(後端 char_length 的算法)。 */
export function reversalReasonLength(raw: string): number {
  return Array.from(normalizeReversalReason(raw)).length;
}

/** 原因不能送出的白話理由;可以送出回傳 null。 */
export function reversalReasonError(raw: string): string | null {
  const length = reversalReasonLength(raw);
  if (length === 0) return "請先填寫原因";
  if (length > REVERSAL_REASON_MAX) {
    return `原因最多 ${REVERSAL_REASON_MAX} 個字,目前是 ${length} 個字,請精簡後再送出`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 跨月(§3.8 / §5.3)
// ---------------------------------------------------------------------------

/** 'YYYY-MM' → 'YYYY 年 M 月'(後端已依台北時區算好 report_month,這裡只換寫法,不自己算時區)。 */
export function formatReportMonth(reportMonth: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(reportMonth);
  if (!match) return reportMonth;
  return `${match[1]} 年 ${Number(match[2])} 月`;
}

export interface TextSegment {
  text: string;
  /** 粗體(月份、金額、月數、規格書標粗的字)。 */
  strong?: boolean;
}

/**
 * 跨月紅色警告的文案(§3.8),拆成段落讓畫面把月份 / 數字加粗。為什麼寫「可能已經結算」而不是「已經」:
 * 系統沒有發薪紀錄(§〇.2),不能替商家斷言。
 * 沒有抽成(月薪制 / 沒產生)時不講「抽成會少 $0」,只講營收。
 */
export function crossMonthWarningSegments(
  preview: Pick<
    CompletedBookingReversalPreview,
    "report_month" | "months_ago" | "commission" | "revenue_amount"
  >,
  action: CompletedBookingReversalAction,
): TextSegment[] {
  const month = formatReportMonth(preview.report_month);
  const verb = action === "revert" ? "還原" : "取消";
  const commission = Number(preview.commission.amount);
  const hasCommission = preview.commission.exists && commission > 0;
  const segments: TextSegment[] = [
    { text: "這張單是 " },
    { text: month, strong: true },
    { text: " 完成的,已經是 " },
    { text: `${preview.months_ago} 個月前`, strong: true },
    { text: "。那個月的薪資與帳務報表" },
    { text: "可能已經結算發放", strong: true },
    { text: "。" },
    { text: `${verb}之後,` },
    { text: month, strong: true },
    { text: "的" },
  ];
  if (hasCommission) {
    segments.push(
      { text: "服務人員抽成會少 " },
      { text: formatAmount(commission), strong: true },
      { text: "、" },
    );
  }
  segments.push(
    { text: "營收會少 " },
    { text: formatAmount(Number(preview.revenue_amount)), strong: true },
    { text: ",報表數字會跟當時不一樣。請先確認財務端是否需要同步調整。" },
  );
  return segments;
}

export function segmentsToText(segments: TextSegment[]): string {
  return segments.map((s) => s.text).join("");
}

// ---------------------------------------------------------------------------
// 預覽 → 畫面資料(§5.2 第 3~6 點、底部動作列)
// ---------------------------------------------------------------------------

export interface ReversalImpactRow {
  key: string;
  label: string;
  value: string;
}

export interface CompletedBookingReversalView {
  title: string;
  explanation: string;
  /** 同一段說明的分段版(畫面用,粗體照規格)。 */
  explanationSegments: TextSegment[];
  /** 跨月才有(紅色 `!`,放最上面)。 */
  crossMonthSegments: TextSegment[] | null;
  /** 「這次會連帶影響」清單,一列一項。 */
  impactRows: ReversalImpactRow[];
  /** 這個入口的預計差額(會員 + 推薦人);> 0 才顯示黃色 `!`。 */
  expectedShortfall: number;
  /** 後端白話 warnings(服務人員已移除 / 改月薪制 / 抽成曾人工重算)。 */
  warnings: ReversalCodeMessage[];
  /** 只擋這個入口的 blocked_reasons(目前只有匯入單的 import_cannot_revert,只擋還原)。 */
  blockedReasons: ReversalCodeMessage[];
  /** 這個入口能不能執行(不含原因檢查)。 */
  allowed: boolean;
  confirmLabel: string;
  confirmVariant: "primary" | "danger";
}

/** blocked_reasons 的 code → 擋哪個入口。目前只有一種;未知的 code 保守地兩個都擋(交給後端說明)。 */
function blockedReasonApplies(code: string, action: CompletedBookingReversalAction): boolean {
  if (code === "import_cannot_revert") return action === "revert";
  return true;
}

export function buildCompletedBookingReversalView(
  preview: CompletedBookingReversalPreview,
  action: CompletedBookingReversalAction,
): CompletedBookingReversalView {
  const rows: ReversalImpactRow[] = [];

  // 服務人員抽成:「{服務人員名} −$X」;無抽成「無(月薪制/未產生抽成)」。
  const commission = Number(preview.commission.amount);
  rows.push({
    key: "commission",
    label: "服務人員抽成",
    value:
      preview.commission.exists && commission > 0
        ? `${preview.staff?.name ?? "(未知人員)"} −${formatAmount(commission)}`
        : "無(月薪制/未產生抽成)",
  });

  // 會員紅利:每位一列(邊界 19 可能 2 位);沒有入帳整列不顯示。
  for (const m of preview.points?.members ?? []) {
    rows.push({
      key: `member-${m.member_id}`,
      label: "會員紅利",
      value: `${m.name} 預計收回 ${m.due_expected} 點(目前餘額 ${m.balance} 點)`,
    });
  }

  // 推薦獎勵。
  const referral = preview.points?.referral ?? null;
  if (referral && referral.due_expected > 0) {
    rows.push({
      key: "referral",
      label: "推薦獎勵",
      value: `${referral.referrer_name ?? "推薦人"} 預計收回 ${referral.due_expected} 點(目前餘額 ${
        referral.referrer_balance ?? 0
      } 點)`,
    });
  }

  // 折抵點數:取消路徑退回;還原路徑維持凍結(單子還活著)。
  const frozen = preview.points?.frozen_points ?? 0;
  if (frozen > 0) {
    rows.push({
      key: "redeem",
      label: "折抵點數",
      value:
        action === "cancel"
          ? `退回 ${frozen} 點給 ${preview.member?.name ?? "會員"}`
          : `折抵 ${frozen} 點維持不變`,
    });
  }

  rows.push({
    key: "report-month",
    label: "影響報表月份",
    value: `${formatReportMonth(preview.report_month)}(服務人員報表、帳務報表)`,
  });
  rows.push({
    key: "completed-at",
    label: "完成時間",
    value: isoToTaipeiDateTimeWithSeconds(preview.completed_at),
  });

  // 預計差額:還原看 shortfall_if_revert、取消看 shortfall_if_cancel(取消先退折抵,差額可能比較小);
  // 推薦人用同一條路徑的精確欄位(shortfall_expected 是規格的單一欄位,兩路徑不同時以精確版為準)。
  const memberShortfall = (preview.points?.members ?? []).reduce(
    (sum, m) => sum + (action === "revert" ? m.shortfall_if_revert : m.shortfall_if_cancel),
    0,
  );
  const referralShortfall = referral
    ? action === "revert"
      ? (referral.shortfall_if_revert ?? referral.shortfall_expected)
      : (referral.shortfall_if_cancel ?? referral.shortfall_expected)
    : 0;

  const blockedReasons = (preview.blocked_reasons ?? []).filter((r) =>
    blockedReasonApplies(r.code, action),
  );
  const flagAllowed = action === "revert" ? preview.can_revert : preview.can_cancel;
  const verb = action === "revert" ? "還原" : "取消";

  return {
    title: REVERSAL_TITLES[action],
    explanation: REVERSAL_EXPLANATIONS[action],
    explanationSegments: REVERSAL_EXPLANATION_SEGMENTS[action],
    crossMonthSegments: preview.is_cross_month ? crossMonthWarningSegments(preview, action) : null,
    impactRows: rows,
    expectedShortfall: Math.max(memberShortfall, 0) + Math.max(referralShortfall, 0),
    warnings: preview.warnings ?? [],
    blockedReasons,
    allowed: flagAllowed && blockedReasons.length === 0,
    confirmLabel: preview.is_cross_month
      ? `我了解影響,確定${verb}`
      : action === "revert"
        ? "確定還原"
        : "確定取消訂單",
    confirmVariant: action === "revert" ? "primary" : "danger",
  };
}

/**
 * 確認鈕為什麼不能按(skill 二之三:灰掉的按鈕旁一定要說為什麼);可以按回傳 null。
 * 這個入口被擋(匯入單不能還原)優先講,因為填了原因也沒用。
 */
export function reversalConfirmDisabledReason(
  view: Pick<CompletedBookingReversalView, "allowed" | "blockedReasons"> | null,
  reason: string,
): string | null {
  if (!view) return "正在計算連帶影響,請稍候";
  if (!view.allowed) {
    return view.blockedReasons[0]?.message ?? "這筆訂單目前不能執行這個動作";
  }
  return reversalReasonError(reason);
}

/** 預計差額那一條黃色 `!`(§5.2 第 4 點;詳細文案等執行後用 shortfall_hint)。 */
export function expectedShortfallNote(points: number): string {
  return `預計有 ${points} 點收不回來(餘額不足)。執行後會顯示詳細說明與處理方式。`;
}

// ---------------------------------------------------------------------------
// 執行結果(§5.4)
// ---------------------------------------------------------------------------

export interface ReversalShortfallNotice {
  /** 會員 + 推薦人差額合計。 */
  points: number;
  title: string;
  /** shortfall_hint 原文(純文字);萬一後端沒給,用數字講一句。 */
  hint: string;
}

/** 差額 > 0(以執行結果的 points_shortfall / referral_shortfall 為準)才回傳小卡窗內容。 */
export function reversalShortfallNotice(
  result: Pick<CompletedBookingReversalResult, "points">,
): ReversalShortfallNotice | null {
  const p = result.points;
  const total = Math.max(p?.points_shortfall ?? 0, 0) + Math.max(p?.referral_shortfall ?? 0, 0);
  if (total <= 0) return null;
  const hint =
    typeof p.shortfall_hint === "string" && p.shortfall_hint.trim()
      ? p.shortfall_hint
      : `有 ${total} 點因為餘額不足沒有收回。如果要一併追回,請用「手動調整點數」扣除。`;
  return { points: total, title: `有 ${total} 點未能收回`, hint };
}

/** 後端「狀態已經改變」(兩個人同時按、或已經被別人處理過)—— 要請使用者重新整理。 */
export function isReversalStateChangedError(message: string): boolean {
  return message.includes("狀態已經改變");
}

// ---------------------------------------------------------------------------
// 成功後要重抓的查詢(否則畫面會停在舊數字)
// ---------------------------------------------------------------------------

/**
 * 用前綴比對(react-query invalidateQueries 預設 exact: false):
 *   ・["booking-module"]:訂單詳情、紅利已入帳 / 已收回(points-ledger)、訂單列表、行事曆
 *     (day-schedule / bookings-list / card-extras)、操作紀錄(booking-status-change-logs)、金額彙總
 *   ・["members-module", …]:會員頁相關訂單(useMemberRelatedBookings)、會員詳情 / 餘額、點數紀錄、
 *     會員列表、推薦清單 —— 被收回的可能是兩位會員 + 推薦人,不只目前這張單的會員,所以不帶會員 id
 *   ・["payroll-module"]:服務人員抽成彙總、月薪資、帳務報表(含區間版)
 */
export function completedBookingReversalInvalidationKeys(
  bookingId: string,
): readonly (readonly unknown[])[] {
  return [
    ["booking-module", "points-ledger", bookingId],
    ["booking-module", "booking-detail", bookingId],
    ["booking-module", "booking-status-change-logs", bookingId],
    ["booking-module"],
    ["members-module", "related-bookings"],
    ["members-module", "member-detail"],
    ["members-module", "point-history"],
    ["members-module", "members-list"],
    ["members-module", "referrals"],
    ["payroll-module"],
  ];
}

/** 只要有 invalidateQueries 的最小介面(方便 Vitest 用真的 QueryClient 驗)。 */
interface InvalidatingClient {
  invalidateQueries: (filters: {
    queryKey: readonly unknown[];
    predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
  }) => Promise<unknown>;
}

/** 預覽查詢的 key(第二段);成功後這張單已經不是「已完成」,再抓預覽只會拿到「狀態已經改變」。 */
export const REVERSAL_PREVIEW_QUERY_SEGMENT = "completed-reversal-preview";

/** 成功(或「狀態已經改變」)後把相關畫面全部標成過期並重抓;預覽本身除外。 */
export function invalidateAfterCompletedBookingReversal(
  queryClient: InvalidatingClient,
  bookingId: string,
): Promise<unknown[]> {
  return Promise.all(
    completedBookingReversalInvalidationKeys(bookingId).map((queryKey) =>
      queryClient.invalidateQueries({
        queryKey,
        predicate: (query) => query.queryKey[1] !== REVERSAL_PREVIEW_QUERY_SEGMENT,
      }),
    ),
  );
}
