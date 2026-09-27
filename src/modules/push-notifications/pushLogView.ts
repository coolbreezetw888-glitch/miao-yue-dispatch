// SPECS-INDEX #778:推播發送記錄頁(PushLogsPage)的純函式。
//
// 為什麼要獨立成一支檔案:這一頁最重要的兩件事 —— ①「為什麼沒發成功」要用白話說明、
// ②「同一個人兩個身份 → 兩列」要讓非工程背景的老闆看得懂 —— 都是可以不開瀏覽器就驗證的
// 純邏輯。放在這裡,Vitest 幾毫秒就能逐條驗完,故障注入也容易做。
//
// 🔴 白話文案的來源只有一個:types.ts 的 PUSH_LOG_SKIP_REASON_LABELS(#734 已寫好、且有一條測試
//    直接讀 migration 的 CHECK 允許值來釘住它)。這裡**不重新設計那五句話**,只負責查表與組合。
//    「他可以怎麼做」的建議(PUSH_LOG_ACTION_HINTS)是這一批新增的補充,獨立成另一張表,
//    不混進 label 表,以免破壞那條「label 表 = CHECK 允許值」的守門測試。

import type { PushNotificationLogRow, PushTargetType } from "./types";
import {
  PUSH_LOG_SKIP_REASON_LABELS,
  PUSH_LOG_STATUS_LABELS,
  PUSH_TARGET_TYPES,
  PUSH_TARGET_TYPE_LABELS,
} from "./types";

// =========================================================================
// 白話說明:跳過原因 → 一句話 + 建議做法
// =========================================================================

/**
 * 「沒發成功的話,他能做什麼」。每一個 skip_reason 一句可以直接照做的建議。
 * ⚠️ 這張表的 key 必須跟 PUSH_LOG_SKIP_REASON_LABELS 一致(有測試釘住),但它**不是**
 *    「資料庫 CHECK 允許值」的鏡像 —— 那個角色由 label 表獨自承擔。
 */
export const PUSH_LOG_ACTION_HINTS: Record<string, string> = {
  event_disabled: "到「推播通知設定」把這個事件的開關打開,之後的通知才會發出去。",
  no_recipient:
    "商家開關是開的,但店裡沒有人把這個事件打開。請要收到通知的人到首頁的「手機推播通知」卡片,把這個事件打開。",
  personal_disabled: "請這位服務人員到自己首頁的「手機推播通知」卡片,把這個事件打開。",
  no_subscription: "請這個人用手機登入秒約,在首頁的「手機推播通知」卡片按「開啟通知」。",
  no_target: "建立或修改這筆訂單時指派服務人員,系統才知道要通知誰。",
};

/** 資料庫寫進來一個 label 表沒有的原因時,畫面上顯示的後綴(讓人一眼看出是系統缺文案,不是他的錯)。 */
export const UNKNOWN_SKIP_REASON_SUFFIX = "(系統還沒有這個原因的說明,請回報給我們)";

/**
 * 跳過原因的白話說明。查不到的話**不吞掉**:回傳原始代碼 + 明確的後綴,讓「資料庫多了新原因、
 * 前端忘了補文案」這種情況在畫面上是顯眼的,而不是一片空白。
 */
export function skipReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const label = PUSH_LOG_SKIP_REASON_LABELS[reason];
  return label ?? `${reason}${UNKNOWN_SKIP_REASON_SUFFIX}`;
}

/** 對應的建議做法;沒有對應建議時回 null(畫面就不顯示那一行)。 */
export function actionHintForSkipReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return PUSH_LOG_ACTION_HINTS[reason] ?? null;
}

// =========================================================================
// 收件人名冊:target_type + target_id → 姓名 / 登入帳號
// =========================================================================

export interface RecipientDirectoryEntry {
  /** 顯示用姓名;空字串不會出現在這裡(呼叫端先清掉)。 */
  name: string;
  /** 登入帳號 id。同一個人兩個身份時,兩列的 userId 相同 —— 這是辨認「同一個人」的唯一可靠依據。 */
  userId: string | null;
}

/** key 一律用 recipientKey() 產生,不要手拼字串。 */
export type RecipientDirectory = Map<string, RecipientDirectoryEntry>;

export function recipientKey(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

function isKnownTargetType(value: string | null): value is PushTargetType {
  return value !== null && (PUSH_TARGET_TYPES as readonly string[]).includes(value);
}

/** 顯示順序 admin → agent → staff(跟鈴鐺的 NOTIFICATION_TARGET_PRIORITY 一致)。 */
const TARGET_ORDER: Record<PushTargetType, number> = { admin: 0, agent: 1, staff: 2 };

// =========================================================================
// 單一收件人那一列的顯示模型
// =========================================================================

export type PushLogOutcome = "sent" | "partially_sent" | "failed" | "skipped" | "unknown";

export interface PushLogRecipientView {
  row: PushNotificationLogRow;
  targetType: PushTargetType | null;
  /** 「商家管理員 / 客服 / 服務人員」;target_type 為 null(整件事在算收件人之前就跳過)時為 null。 */
  roleLabel: string | null;
  /** 名冊查得到才有;查不到(例如客服沒有讀取那張表的權限)就退回只顯示角色。 */
  name: string | null;
  userId: string | null;
  outcome: PushLogOutcome;
  /** 徽章上的字:成功 / 部分成功 / 失敗 / 跳過。 */
  statusLabel: string;
  /** 白話的一句話:跳過原因、或送達幾台裝置、或錯誤內容。 */
  detail: string;
  /** 沒發成功時「他可以怎麼做」;成功的列是 null。 */
  hint: string | null;
}

function outcomeOf(status: string): PushLogOutcome {
  if (
    status === "sent" ||
    status === "partially_sent" ||
    status === "failed" ||
    status === "skipped"
  ) {
    return status;
  }
  return "unknown";
}

/** 這一列(一個收件人)的白話結果描述。 */
export function describeRecipientOutcome(row: PushNotificationLogRow): string {
  const outcome = outcomeOf(row.status);
  switch (outcome) {
    case "skipped":
      return skipReasonLabel(row.skip_reason) ?? "沒有發送(沒有記錄原因)";
    case "sent":
      return `已送到 ${row.device_count} 台裝置`;
    case "partially_sent": {
      const base = `${row.device_count} 台裝置中只有 ${row.success_count} 台送達`;
      return row.error_detail ? `${base}。錯誤內容:${row.error_detail}` : base;
    }
    case "failed": {
      const base =
        row.device_count > 0 ? `${row.device_count} 台裝置都沒有送達` : "沒有任何裝置送達";
      return row.error_detail ? `${base}。錯誤內容:${row.error_detail}` : base;
    }
    default:
      return `未知狀態:${row.status}`;
  }
}

export function toRecipientView(
  row: PushNotificationLogRow,
  directory: RecipientDirectory,
): PushLogRecipientView {
  const targetType = isKnownTargetType(row.target_type) ? row.target_type : null;
  const entry =
    targetType && row.target_id
      ? directory.get(recipientKey(targetType, row.target_id))
      : undefined;
  const outcome = outcomeOf(row.status);
  return {
    row,
    targetType,
    roleLabel: targetType ? PUSH_TARGET_TYPE_LABELS[targetType] : null,
    name: entry?.name ?? null,
    userId: entry?.userId ?? null,
    outcome,
    statusLabel: PUSH_LOG_STATUS_LABELS[row.status] ?? row.status,
    detail: describeRecipientOutcome(row),
    hint: outcome === "sent" ? null : actionHintForSkipReason(row.skip_reason),
  };
}

// =========================================================================
// 把「一個身份一列」的原始記錄,群組成「一個事件一組」
// =========================================================================

export type PushLogGroupSummaryKind = "all_sent" | "partial" | "failed" | "skipped";

export interface PushLogGroupSummary {
  kind: PushLogGroupSummaryKind;
  label: string;
}

/** 同一個人以兩個以上身份出現在同一個事件裡 —— 畫面要把這件事講白。 */
export interface SameUserNote {
  userId: string;
  name: string | null;
  /** 依 admin → agent → staff 排好。 */
  targetTypes: PushTargetType[];
}

export interface PushLogEventGroup {
  /** 代表列的 id(最新那一列),給 React key 用。 */
  key: string;
  /** 群組內最新的一列的時間。 */
  attempted_at: string;
  event_type: string;
  booking_id: string | null;
  rendered_title: string | null;
  rendered_body: string | null;
  /** 依 admin → agent → staff 排好。 */
  recipients: PushLogRecipientView[];
  summary: PushLogGroupSummary;
  sameUserNotes: SameUserNote[];
}

/** 同一分鐘 = 把時間截到分鐘。用 Date 取值而不是字串切片,才不會被時區寫法差異騙(跟鈴鐺同一招)。 */
function minuteBucket(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return `raw:${iso}`;
  return String(Math.floor(time / 60_000));
}

/**
 * 群組 key:同一間店 + 同一筆訂單 + 同一種事件 + 同一分鐘。
 * 為什麼用「同一分鐘」而不是時間完全相等:每一列是各自 insert 的,attempted_at 會差幾毫秒到幾秒。
 * 為什麼不把 target_type 放進 key:放進去就永遠不會合併,整個群組的意義就沒了(有測試釘住)。
 */
export function groupKeyOf(row: PushNotificationLogRow): string {
  return [
    row.merchant_id,
    row.booking_id ?? "no-booking",
    row.event_type,
    minuteBucket(row.attempted_at),
  ].join("|");
}

export function summarizeGroup(recipients: PushLogRecipientView[]): PushLogGroupSummary {
  const outcomes = recipients.map((r) => r.outcome);
  const anyDelivered = outcomes.some((o) => o === "sent" || o === "partially_sent");
  const allSent = outcomes.length > 0 && outcomes.every((o) => o === "sent");
  const anyFailed = outcomes.some((o) => o === "failed" || o === "partially_sent");

  if (allSent) return { kind: "all_sent", label: "全部送達" };
  if (anyDelivered) return { kind: "partial", label: "部分送達" };
  if (anyFailed) return { kind: "failed", label: "發送失敗" };
  return { kind: "skipped", label: "沒有發送" };
}

function collectSameUserNotes(recipients: PushLogRecipientView[]): SameUserNote[] {
  const byUser = new Map<string, SameUserNote>();
  for (const r of recipients) {
    if (!r.userId || !r.targetType) continue;
    const existing = byUser.get(r.userId);
    if (!existing) {
      byUser.set(r.userId, { userId: r.userId, name: r.name, targetTypes: [r.targetType] });
    } else if (!existing.targetTypes.includes(r.targetType)) {
      existing.targetTypes.push(r.targetType);
      if (!existing.name && r.name) existing.name = r.name;
    }
  }
  const notes = [...byUser.values()].filter((n) => n.targetTypes.length > 1);
  for (const note of notes) {
    note.targetTypes.sort((a, b) => TARGET_ORDER[a] - TARGET_ORDER[b]);
  }
  return notes;
}

/**
 * 顯示層群組,資料層一個字都不動。回傳順序「最新的在前」。
 *
 * 為什麼需要它:同一個人在同一間店同時是客服又是服務人員時,一個事件會寫**兩列** log
 * (pushDispatchCore §2.4 明講「一個身份一列」),但他的手機只會響一次(§4.3 endpoint 去重)。
 * 老闆看到「同一筆預約有兩列」會以為系統重複發送。群組起來之後,一組就是「一件事」,
 * 底下每一列是「通知到誰、結果如何」,再用 sameUserNotes 把「這兩列其實是同一個人」講白。
 */
export function groupPushLogRows(
  rows: PushNotificationLogRow[],
  directory: RecipientDirectory,
): PushLogEventGroup[] {
  const groups = new Map<string, PushLogEventGroup>();

  for (const row of rows) {
    const key = groupKeyOf(row);
    const view = toRecipientView(row, directory);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key: row.id,
        attempted_at: row.attempted_at,
        event_type: row.event_type,
        booking_id: row.booking_id,
        rendered_title: row.rendered_title,
        rendered_body: row.rendered_body,
        recipients: [view],
        summary: { kind: "skipped", label: "沒有發送" }, // 下面統一重算
        sameUserNotes: [],
      });
      continue;
    }
    existing.recipients.push(view);
    // 文案在群組內每一列都一樣;只有 event_disabled 那種「還沒算文案就跳過」的列是 null,
    // 所以任何一列有值就補上。
    if (!existing.rendered_title && row.rendered_title)
      existing.rendered_title = row.rendered_title;
    if (!existing.rendered_body && row.rendered_body) existing.rendered_body = row.rendered_body;
    if (new Date(row.attempted_at).getTime() > new Date(existing.attempted_at).getTime()) {
      existing.attempted_at = row.attempted_at;
      existing.key = row.id;
    }
  }

  const result = [...groups.values()];
  for (const group of result) {
    group.recipients.sort((a, b) => {
      const oa = a.targetType ? TARGET_ORDER[a.targetType] : 99;
      const ob = b.targetType ? TARGET_ORDER[b.targetType] : 99;
      return oa - ob;
    });
    group.summary = summarizeGroup(group.recipients);
    group.sameUserNotes = collectSameUserNotes(group.recipients);
  }
  result.sort((a, b) => new Date(b.attempted_at).getTime() - new Date(a.attempted_at).getTime());
  return result;
}

/** 「王小明同時是客服和服務人員,所以有兩列;他的手機只會收到一次。」 */
export function formatSameUserNote(note: SameUserNote): string {
  const who = note.name ?? "同一個人";
  const roles = note.targetTypes.map((t) => PUSH_TARGET_TYPE_LABELS[t]).join("和");
  return `${who}同時是${roles},所以這裡有 ${note.targetTypes.length} 列;他的手機只會收到一次。`;
}
