// SPECS-INDEX #918 / #919 / #920:會員的「兩層狀態」。
// 規格書:.project/specs/建單自動建立會員與會員兩層狀態.md(#908 欄位定義、#918 名單、#919 CSV、#920 詳情頁)
//
// 這個檔案只放「純函式 + 文案常數」,讓三個畫面共用同一套判斷:
//   #918 會員名單的「會員類型」下拉篩選與卡片標籤(MembersListPage.tsx)
//   #919 會員報表 CSV 的「會員類型」欄(data-tools/ReportExportCenterPage.tsx)
//   #920 會員詳情頁的「會員狀態」區塊(MemberDetailPage.tsx)
// 抽出來的理由不是「比較漂亮」,是規格書 §三 #923.3 第 5、6 條明確要求這兩段邏輯要能被
// vitest 測到(元件裡的 inline 判斷測不到)。⇒ 對應測試在 memberIdentityStatus.test.ts。
//
// 🔴 這是「身分」,不是「LINE 通知管道」——兩件事不可以合併判斷。
//    判定「是不是真正的會員」一律看 `members.identity_verified_at is not null`,
//    **絕對不要**改成看 `members.line_bound` 或 `members.phone_verified`:
//      ・`line_bound` 的語意是「這位會員的 LINE 已綁、可以推播」⇒ 那是通知管道的狀態。
//      ・`phone_verified` 的欄位註解自己寫著「純粹的人工標記,不代表真的發過簡訊驗證碼」
//        ⇒ 那是商家自己按的,不是客戶本人證明的。
//    使用者 2026-09-30 明確要求旗標不可以寫死成登入方式(#866「登入方式可能要調整」還懸著),
//    所以這一層判斷刻意跟「用哪一種方式驗的」完全脫鉤。
//
// 📌 `identity_verified_via`(用哪一種方式驗的)**刻意不帶到前端**
//    (SPECS-INDEX #908 備註:「畫面不需要知道」)⇒ 這裡不提供任何對應的文案。

/** 兩層狀態:已完成身分驗證 / 只是被建立起來。一位會員同一時間只會是其中一個(所以在畫面上是 StatusTag)。 */
export type MemberIdentityStatus = "verified" | "unverified";

/**
 * 🔴 畫面文案的**唯一來源**:名單頁的膠囊(#918)、篩選下拉的選項(#918)、報表 CSV 的值(#919)、
 * 詳情頁的膠囊(#920)全部吃這兩個字串。要改文案只改這裡,不要在任何畫面 inline 寫死。
 *
 * 🔴 **2026-09-30 使用者裁決:狀態名稱裡不可以出現「綁定」兩個字。**
 *    原本是「已綁定會員」/「已建立(未綁定)」,改成現在這兩個。
 *    ⚠️ 這不是美化,是避免一個會越來越嚴重的誤導 —— 理由有兩層:
 *      ① 同一個詳情頁下面就有「LINE 綁定」區塊(**通知管道**),狀態名稱再用「綁定」這個動詞,
 *         客服會以為「已綁定會員」= 「LINE 綁好了」,那正是 #908 要避免的事。
 *      ② **#866 已裁決:四種角色全面改成手機簡訊驗證碼登入,而客戶端「登入就算完成驗證」**
 *         ⇒ 未來會有**兩條**驗證路徑(手機簡訊 / LINE 綁定碼)。「綁定」只描述其中一條,
 *         拿它當**整體狀態**的名稱,在 #866 上線後會比現在更混淆。
 *    ⇒ 所以狀態名稱一律用「驗證」這個跟管道無關的詞。
 *    📌 **「LINE 綁定」區塊自己的文字不要跟著改** —— 那裡講的確實就是 LINE 綁定,用詞是對的;
 *       引導客服「請用下面的『LINE 綁定』產生綁定碼」也要保留,那是實際的操作路徑。
 */
export const MEMBER_IDENTITY_STATUS_LABELS: Record<MemberIdentityStatus, string> = {
  verified: "已完成驗證",
  unverified: "尚未驗證",
};

/**
 * 判定一位會員屬於哪一層。
 *
 * 參數刻意收 `string | null | undefined`:
 *   ・`null` = 資料庫裡就是 null(還沒完成身分驗證)。
 *   ・`undefined` = 這份資料還沒帶這個欄位(例如 #908 的 migration 還沒上線,或某個舊的呼叫端
 *     沒有 select 到它)⇒ 一律當成「未驗證」,而不是讓畫面爆掉。這是刻意的保守做法:
 *     把不確定的人當成「尚未驗證」只會少發通知,反過來會誤標成正式會員。
 */
export function memberIdentityStatus(
  identityVerifiedAt: string | null | undefined,
): MemberIdentityStatus {
  return identityVerifiedAt ? "verified" : "unverified";
}

/** 中文白話標籤。#919 的 CSV 直接用這支 —— 🔴 CSV 裡寫中文,不寫時間戳也不寫 true/false。 */
export function memberIdentityStatusLabel(identityVerifiedAt: string | null | undefined): string {
  return MEMBER_IDENTITY_STATUS_LABELS[memberIdentityStatus(identityVerifiedAt)];
}

/** #918 的「會員類型」篩選值。`all` = 不篩。 */
export type MemberIdentityFilter = "all" | MemberIdentityStatus;

/** 下拉選單的固定白名單(順序就是畫面上的順序)。 */
export const MEMBER_IDENTITY_FILTER_OPTIONS: ReadonlyArray<{
  value: MemberIdentityFilter;
  label: string;
}> = [
  { value: "all", label: "全部會員類型" },
  { value: "verified", label: MEMBER_IDENTITY_STATUS_LABELS.verified },
  { value: "unverified", label: MEMBER_IDENTITY_STATUS_LABELS.unverified },
];

/** 給 guardPhantomEmptyChange 的白名單判斷(固定選項 ⇒ 用最嚴格的那一種用法)。 */
export function isMemberIdentityFilter(value: string): value is MemberIdentityFilter {
  return value === "all" || value === "verified" || value === "unverified";
}

/** #918 名單頁的篩選判斷(`visibleMembers` 用)。 */
export function matchesMemberIdentityFilter(
  identityVerifiedAt: string | null | undefined,
  filter: MemberIdentityFilter,
): boolean {
  if (filter === "all") return true;
  return memberIdentityStatus(identityVerifiedAt) === filter;
}

/**
 * #920 詳情頁的小字「(YYYY-MM-DD 完成驗證)」要用的日期。
 *
 * 一律換算成 Asia/Taipei 的日曆日(沿用 booking/dateUtils.ts `isoToTaipeiDateKey` 的既有做法:
 * `en-CA` 這個 locale 的日期格式剛好就是 YYYY-MM-DD)。刻意不 import 那支 ——
 * 這裡只是一行格式化,為它拉一條 members → booking 的模組依賴不值得。
 *
 * 解析不出來的字串回 null,讓呼叫端自己決定要不要顯示,不要在畫面上印出「Invalid Date」。
 */
export function formatIdentityVerifiedDate(
  identityVerifiedAt: string | null | undefined,
): string | null {
  if (!identityVerifiedAt) return null;
  const date = new Date(identityVerifiedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Taipei" });
}
