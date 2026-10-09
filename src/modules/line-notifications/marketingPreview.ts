// 客戶端第 5 批 5-B(C5-P01):再行銷通知「會用掉幾則」的純邏輯。
// 資料來源:preview_line_marketing_recipients(p_merchant_id, p_member_ids)(甲,c5-contract 5-B 段)。
// 規則在資料庫(跟 Edge line-send-marketing 一致):黑名單 0 則;有聯絡人 ⇒ 每位「優惠通知開著、有這間店 LINE 身分、
// 不是已知非好友」的聯絡人各 1 則;沒有聯絡人的舊綁定碼會員 1 則(已知非好友除外)。前端只負責顯示。

export interface LineMarketingPreview {
  /** 至少有 1 人收得到的會員數。 */
  memberCount: number;
  /** 總則數(= 會用掉的官方帳號額度)。 */
  messageCount: number;
  /** 每位會員收得到幾人(member_id → 人數)。 */
  perMember: Map<string, number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export function parseLineMarketingPreview(raw: unknown): LineMarketingPreview {
  const r = isRecord(raw) ? raw : {};
  const perMember = new Map<string, number>();
  if (Array.isArray(r["members"])) {
    for (const m of r["members"]) {
      if (isRecord(m) && typeof m["member_id"] === "string") {
        perMember.set(m["member_id"], nonNegInt(m["recipient_count"]));
      }
    }
  }
  return {
    memberCount: nonNegInt(r["member_count"]),
    messageCount: nonNegInt(r["message_count"]),
    perMember,
  };
}

/** 名單每一列:「可收到 X 人」。不知道(還在算 / 算失敗)⇒ null(不顯示)。 */
export function formatReachableCount(count: number | undefined): string | null {
  if (count === undefined) return null;
  return `可收到 ${count} 人`;
}

/** 確認窗主句(C5-P01 規格原句)。 */
export function formatMarketingConfirmText(memberCount: number, messageCount: number): string {
  return `即將發送給 ${memberCount} 位會員，共 ${messageCount} 則訊息（會用掉 ${messageCount} 則官方帳號額度），確定要送出嗎？`;
}

/** 選了但收不到的會員(關掉優惠通知 / 沒加好友 / 黑名單)。0 ⇒ null(不顯示)。 */
export function formatUnreachableNote(selectedCount: number, memberCount: number): string | null {
  const n = selectedCount - memberCount;
  if (n <= 0) return null;
  return `另外 ${n} 位會員目前沒有人收得到（關掉了優惠通知、沒加 LINE 好友或是黑名單），不會發送。`;
}

export const MARKETING_NOBODY_NOTE =
  "選到的會員目前都收不到（關掉了優惠通知、沒加 LINE 好友或是黑名單），不會發送任何訊息。";
export const MARKETING_PREVIEW_FAILED_NOTE =
  "暫時算不出這次會用掉幾則官方帳號額度（每位收得到的聯絡人 1 則），仍然可以發送。";
