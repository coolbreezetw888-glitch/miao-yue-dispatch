// 模組 10(會員與紅利)§10.2(SPECS-INDEX #614)起源:掛在模組 6 建單表單(CalendarPage.tsx)
// 「客戶電話」欄位下方的面板。本模組擁有並匯出這個元件,模組 6 只負責掛載(模組獨立性原則)。
//
// ─── 2026-10-01 第二波改版(SPECS-INDEX #915 + #936,規格書 §12.2,以 §十二 為準)──────────────
// 🔴 這個面板**不再決定訂單掛在哪位會員底下**(§12.1):新增訂單時前端一律不帶 p_member_id,
//    由後端 create_booking 用「送出那一刻的電話」完全相等比對,自動連結或自動建立會員(#912)。
//    面板上點選候選,只是「把資料帶進表單」的快捷鍵(#936)。
//    理由:create_booking 對 p_member_id 完全尊重、不比對電話 ⇒ 如果把「點過的那位」送出去,
//    客服先點王小明、再把電話改成李小華的號碼,訂單會掛在王小明底下,紅利發錯人而且沒有警告。
//
// 新增模式下,依「目前電話欄位」分三種狀態(判斷在 memberPhoneMatch.ts,有 vitest):
//   A. 沒有候選         → 完全不顯示(這就是「自動」的體感:什麼都不用按)
//   B. 只有開頭相符     → 「開頭相符的客戶(點一下帶入資料)」+ 候選清單(姓名 / 電話 / 最近消費日)
//                          ⚠️ 不可以再出現「這支電話有既有客戶紀錄」這類字眼 —— 前綴相符不代表同一支電話,
//                             那正是第一波「面板講假話」的來源。
//   C. 電話完全相等     → 一行「將連結既有客戶:{姓名}」(說明,不是按鈕);黑名單 ⇒ 上方常駐 `!`
//                          其餘開頭相符的候選不再列出。
//                          #1013(第 19 批):說明下方仍列出「完全相等的那一位」(同狀態 B 的清單樣式),
//                          點了就帶入資料;之前只有說明文字,客服只能故意少打一碼才帶得進來。
//
// 已移除(#915):「建立正式會員」小卡窗(QuickCreateMemberDialog)與它的成功 toast、
// 「+ 這支電話的新客戶」按鈕(#931 之後同一支電話不允許再建一位)、「清除連結」按鈕
// (使用者裁決不需要不入會的退路)、只掛在點選事件上的黑名單 toast.warning
// (自動流程沒有點擊事件可以掛 ⇒ 改成狀態 C 的常駐 AlertNote)。
//
// 編輯模式(mode="edit",§12.7 第 2 點,使用者裁決「要保留補掛功能」):
//   ・已連結會員的訂單 → 電話沒改時唯讀一行「已連結會員:{姓名}」,不查候選、不能清除。
//     🔴 SPECS-INDEX #939(第 11 批 A):電話改了 ⇒ 後端 update_booking 會依新電話改掛會員(找不到就自動
//     建立),面板依 deriveEditLinkedPanelState 顯示 E0~E4 五種狀態,並在 E2 / E4 常駐 `!` 說明紅利後果
//     (skill 二:「按下去會發生什麼」不能收進 `?`)。E1 點選候選只帶入資料,不設定補掛(那是沒連結的單才用的)。
//   ・沒連結會員的訂單 → 一樣照狀態 A/B/C 顯示候選;**點選** = 帶入資料 + 記為「要補掛的會員」。
//     update_booking 不依電話比對 ⇒ 狀態 C 不能說「將連結」,改成
//     「這支電話是既有客戶:{姓名}(點一下即可連結到這筆訂單)」而且整行可點(效果同點選候選)。
//     點選之後顯示「儲存後會連結到會員:{姓名}」;客服再改電話,CalendarPage 會即時取消補掛,
//     這一行也就跟著消失(送出前 resolveSubmitMemberId 還會再比對一次電話)。
//
// UI 規範(ui-overlay-patterns skill):面板裡**不可以**出現實心主題色按鈕(建單表單唯一的 ① 主要
// 按鈕是「建立預約」);候選清單項目是 44px 的可點列表項,不是按鈕群。
// 🔴 所有姓名 / 電話 / 黑名單原因都用 React 文字插值(自動轉義),不用 dangerouslySetInnerHTML。

import { AlertNote, StatusTag } from "@/components/patterns";
import { isValidTaiwanPhone } from "@/lib/validation";

import { useMembersByPhone } from "./api";
import {
  deriveEditLinkedPanelState,
  derivePhoneMatchPanelState,
  normalizeCustomerPhone,
  relinkConsequenceText,
} from "./memberPhoneMatch";
import type { MemberPhoneMatchCandidate } from "./types";

/** 編輯模式下,這筆訂單目前連結的會員(開啟表單時從 member_id / member_name_snapshot 帶入)。 */
export interface SelectedMember {
  id: string;
  name: string;
}

/** 編輯模式「補掛」時面板要顯示的資料:姓名 + 黑名單狀態(§12.8 第 1 點:點選黑名單客戶補掛後,
 *  黑名單 `!` 不可以消失,所以點選當下就把黑名單資訊一起記下,不依賴候選查詢還在不在)。 */
export interface PendingAttachDisplay {
  name: string;
  isBlacklisted: boolean;
  blacklistReason: string | null;
}

/** 黑名單常駐提醒(狀態 C 與補掛狀態共用同一段,文案只有一份)。 */
function BlacklistNote({ reason }: { reason: string | null }) {
  // skill 二之三 / 三之二:「現在的狀態跟你以為的不一樣」要一直提醒 ⇒ 常駐 `!`,不可收合,
  // 不是 toast(toast 幾秒後就消失,而這位客戶還是在黑名單上)。純警告,不擋單。
  return <AlertNote>這位客戶被列入黑名單{reason ? `：${reason}` : ""}</AlertNote>;
}

function formatLastBookingDate(iso: string | null): string {
  if (!iso) return "尚無消費紀錄";
  const d = new Date(iso);
  return `最近消費 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 開頭相符的候選清單(新增模式狀態 B、補掛、#939 E1 共用同一段)。 */
function CandidateList({
  candidates,
  onApplyCandidate,
}: {
  candidates: MemberPhoneMatchCandidate[];
  onApplyCandidate: (candidate: MemberPhoneMatchCandidate) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-2">
      <p className="mb-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
        開頭相符的客戶(點一下帶入資料)
      </p>
      <ul className="flex flex-col gap-1">
        {candidates.map((c) => (
          <li key={c.memberId}>
            {/* 每一列是 44px 的可點列(觸控目標,skill 一);兩側都是動態文字,都要能折行。
                這是列表項,不是 ① 主要按鈕 —— 沒有實心主題色。 */}
            <button
              type="button"
              className="flex min-h-11 w-full cursor-pointer flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-md bg-background px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onApplyCandidate(c)}
            >
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="break-words">{c.name}</span>
                {c.phone ? (
                  <span className="tabular-nums text-muted-foreground">{c.phone}</span>
                ) : null}
                {c.isBlacklisted ? <StatusTag tone="danger">黑名單</StatusTag> : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatLastBookingDate(c.lastBookingDate)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemberPhoneMatchPanel({
  merchantId,
  phone,
  mode,
  linkedMember,
  pendingAttachMember,
  onApplyCandidate,
  originalPhone = null,
  customerName = "",
  originalRedeemedPoints = 0,
}: {
  merchantId: string;
  phone: string;
  /** "create" = 新增訂單:依電話顯示狀態 A/B/C,點選只帶入資料,會員連結由後端依電話決定。
   *  "edit" = 編輯既有訂單(§12.7):已連結會員 ⇒ 唯讀一行「已連結會員」;沒連結 ⇒ 一樣顯示 A/B/C,
   *  點選(含狀態 C 那一行)= 帶入資料 + 記為儲存時要補掛的會員。 */
  mode: "create" | "edit";
  /** 只在編輯模式使用:這筆訂單目前連結的會員;新增模式傳 null。 */
  linkedMember: SelectedMember | null;
  /** 只在編輯模式使用:客服點選、儲存後要補掛的會員(電話已由 CalendarPage 確認跟表單一致);
   *  新增模式傳 null。 */
  pendingAttachMember: PendingAttachDisplay | null;
  /** 點選候選時呼叫(由建單表單把電話 / 姓名 / 地址帶入欄位;編輯模式另外記為要補掛的會員)。 */
  onApplyCandidate: (candidate: MemberPhoneMatchCandidate) => void;
  /** #939:只在編輯模式使用 —— 這筆訂單載入時的電話(判斷「電話有沒有改」的基準)。 */
  originalPhone?: string | null;
  /** #939:表單目前的客戶姓名(E4「會用這支電話建立新會員:{姓名}」用)。 */
  customerName?: string;
  /** #939:這筆訂單載入時的紅利折抵點數(E2 / E4 後果說明分兩種文案)。 */
  originalRedeemedPoints?: number;
}) {
  const trimmedPhone = phone.trim();
  const isEditLinked = mode === "edit" && linkedMember !== null;
  // #939:已連結會員的單,電話跟原本一樣(正規化後)就不查候選;改了才查(要知道新電話是誰的)。
  const editLinkedPhoneUnchanged =
    isEditLinked &&
    normalizeCustomerPhone(trimmedPhone) !== null &&
    normalizeCustomerPhone(trimmedPhone) === normalizeCustomerPhone(originalPhone);
  // hooks 不能放在條件式後面:不需要查的時候傳 undefined 讓查詢停用(enabled=false),不打 RPC。
  const { data: candidates } = useMembersByPhone(
    editLinkedPhoneUnchanged ? undefined : merchantId,
    trimmedPhone,
  );

  if (mode === "edit" && linkedMember) {
    const linkedLine = (
      <div className="flex min-h-11 items-center rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
        <span className="min-w-0 break-words text-foreground">
          <span className="text-muted-foreground">已連結會員：</span> {linkedMember.name}
        </span>
      </div>
    );
    const editState = deriveEditLinkedPanelState({
      phone: trimmedPhone,
      originalPhone,
      linkedMemberId: linkedMember.id,
      phoneComplete: isValidTaiwanPhone(trimmedPhone),
      candidates,
    });
    if (editState.kind === "unchanged") return linkedLine;
    if (editState.kind === "hidden") return null;
    if (editState.kind === "typing") {
      return (
        <CandidateList candidates={editState.candidates} onApplyCandidate={onApplyCandidate} />
      );
    }
    // E2 / E4:「按下去會發生什麼」⇒ 常駐 `!`,不可收合(skill 二)。
    const consequence = (
      <AlertNote data-testid="member-relink-consequence">
        {relinkConsequenceText(linkedMember.name, originalRedeemedPoints)}
      </AlertNote>
    );
    if (editState.kind === "relink") {
      return (
        <div className="flex flex-col gap-2" data-testid="member-relink-panel">
          {editState.match.isBlacklisted ? (
            <BlacklistNote reason={editState.match.blacklistReason} />
          ) : null}
          <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
            <span className="text-muted-foreground">電話已更改，儲存後這筆訂單會改掛到：</span>
            <span className="break-words text-foreground">{editState.match.name}</span>
          </p>
          {/* #1013(第 19 批):電話打完整時也要能一鍵帶入這位客戶的資料(效果同 E1 點選:只帶入,
              不設定補掛)。之前 E2 只有說明文字,客服得故意少打一碼才點得到。 */}
          <CandidateList candidates={[editState.match]} onApplyCandidate={onApplyCandidate} />
          {consequence}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2" data-testid="member-relink-panel">
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
          <span className="text-muted-foreground">電話已更改，儲存後會用這支電話建立新會員：</span>
          <span className="break-words text-foreground">{customerName.trim()}</span>
        </p>
        {consequence}
      </div>
    );
  }

  if (mode === "edit" && pendingAttachMember) {
    return (
      <div className="flex flex-col gap-2">
        {/* §12.8 第 1 點:點選黑名單客戶補掛之後,提醒跟狀態 C 一樣常駐,不可以因為換了顯示而消失。 */}
        {pendingAttachMember.isBlacklisted ? (
          <BlacklistNote reason={pendingAttachMember.blacklistReason} />
        ) : null}
        <div className="flex min-h-11 items-center rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span className="min-w-0 break-words text-foreground">
            <span className="text-muted-foreground">儲存後會連結到會員：</span>{" "}
            {pendingAttachMember.name}
          </span>
        </div>
      </div>
    );
  }

  const state = derivePhoneMatchPanelState(trimmedPhone, candidates);

  if (state.kind === "hidden") return null;

  if (state.kind === "exact") {
    const { match } = state;
    return (
      <div className="flex flex-col gap-2">
        {match.isBlacklisted ? <BlacklistNote reason={match.blacklistReason} /> : null}
        {mode === "edit" ? (
          // 編輯模式:後端不依電話比對,所以不能說「將連結」;整行可點,效果同點選候選(§12.7)。
          // 仍是列表項樣式,不是 ① 主要按鈕。
          <button
            type="button"
            className="min-h-11 w-full cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-left text-sm leading-relaxed transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onApplyCandidate(match)}
          >
            <span className="text-muted-foreground">這支電話是既有客戶：</span>
            <span className="break-words text-foreground">{match.name}</span>
            <span className="text-muted-foreground">(點一下即可連結到這筆訂單)</span>
          </button>
        ) : (
          <>
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm leading-relaxed">
              <span className="text-muted-foreground">將連結既有客戶：</span>
              <span className="break-words text-foreground">{match.name}</span>
            </p>
            {/* #1013(第 19 批):電話打完整、對到既有客戶時,清單照樣列出這一位,點了就帶入
                (跟打到一半點選完全一樣,走同一個 onApplyCandidate)。不自動帶入:避免蓋掉客服
                已經手動填好的姓名 / 地址。其他只是開頭相符的候選仍不列出。 */}
            <CandidateList candidates={[match]} onApplyCandidate={onApplyCandidate} />
          </>
        )}
      </div>
    );
  }

  return <CandidateList candidates={state.candidates} onApplyCandidate={onApplyCandidate} />;
}
