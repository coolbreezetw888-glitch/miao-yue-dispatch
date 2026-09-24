// 模組 11(LINE 通知)—「我的 LINE 綁定」卡片的純判斷邏輯。
//
// ⚠️ 為什麼這幾個函式一定要抽出來、而不是寫在元件裡:
// 2026-09-24 線上真的發生過「雙重身分的人完全進不去服務人員端」的故障
// (見 src/modules/staff-portal/staffSelfAccessLogic.ts 檔頭的完整記錄),根因就是這種
// 「該顯示哪一種狀態 / 該不該放行」的判斷寫死在元件裡,沒有辦法單獨測試,只能等使用者回報。
// 從那次之後,本專案把「這類狀態判斷必須抽成純函式 + 單元測試」訂成硬要求。
//
// 這個檔案放在模組 11(LINE 通知)底下、而不是服務人員端模組底下,因為 LINE 綁定的領域知識
// 屬於模組 11:兩張卡片(line-notifications/MyLineBindingCard 給管理員/客服,
// staff-portal/MyStaffLineBindingCard 給服務人員)共用同一套狀態機、同一組加好友連結規則、
// 同一組錯誤訊息規則,不應該各自維護一份。

import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

/**
 * 「我的 LINE 綁定」卡片一次只會處於這五種狀態之一。
 *
 *  loading                —— 還在查詢,什麼按鈕都不該出現(fail-closed)
 *  no_access              —— 查不到「我」在這間商家的那一列,或商家資訊查詢被後端擋下(42501)
 *  merchant_not_connected —— 商家還沒完成 LINE 串接,產生綁定碼沒有意義,不顯示按鈕
 *  unbound                —— 可以按「產生綁定碼」
 *  bound                  —— 已綁定,可以按「解除綁定」
 */
export type LineBindingViewState =
  "loading" | "no_access" | "merchant_not_connected" | "unbound" | "bound";

export interface LineBindingViewStateInput {
  /** 「我自己那一列」的綁定狀態是否還在查詢中。 */
  bindingStatusLoading: boolean;
  /**
   * 我自己那一列的 line_bound(merchant_staff / merchant_admins / merchant_agents 都有這個欄位)。
   * 查詢已結束但拿不到那一列時傳 null —— 會被判定成 no_access,而不是「未綁定」。
   */
  lineBound: boolean | null;
  /** 商家 LINE 官方帳號公開資訊(get_merchant_line_bot_public_info)是否還在查詢中。 */
  merchantInfoLoading: boolean;
  /** 商家 LINE 官方帳號公開資訊查詢失敗(最典型的是後端 42501:我不是這間商家的在職成員)。 */
  merchantInfoFailed: boolean;
  /** get_merchant_line_bot_public_info 回傳的 is_connected;還沒拿到結果時傳 null。 */
  merchantConnected: boolean | null;
}

/**
 * 決定卡片要顯示哪一種狀態。
 *
 * 判斷順序刻意是這樣,每一條都有理由:
 *   1. 自己那一列還在查 → loading。連「我到底綁沒綁」都不知道時顯示任何按鈕都可能是錯的。
 *   2. 已經綁定 → bound,而且「不等」商家資訊查詢。已綁定時畫面只需要一顆「解除綁定」按鈕,
 *      解除綁定跟商家有沒有串接完全無關(商家事後解除串接,服務人員一樣有權把自己的綁定拿掉),
 *      所以不該因為商家資訊查詢慢或失敗就讓使用者卡在載入中。
 *   3. 查不到自己那一列(lineBound === null 且已經查完)→ no_access。fail-closed:
 *      這種情況代表「我不是這間商家的在職成員」或查詢出錯,不該給一顆按下去必定失敗的按鈕。
 *   4. 之後才輪到商家端的判斷:還在查 → loading;被擋下/失敗 → no_access;
 *      已串接 → unbound(可以產生綁定碼);沒串接 → merchant_not_connected。
 *   5. 全部都不符合(既沒載入中、也沒失敗、也沒拿到資料)→ 退回 loading,絕不預設成 unbound。
 */
export function resolveLineBindingViewState(
  input: LineBindingViewStateInput,
): LineBindingViewState {
  if (input.bindingStatusLoading) return "loading";
  if (input.lineBound === true) return "bound";
  if (input.lineBound === null) return "no_access";

  if (input.merchantInfoLoading) return "loading";
  if (input.merchantInfoFailed) return "no_access";
  if (input.merchantConnected === true) return "unbound";
  if (input.merchantConnected === false) return "merchant_not_connected";

  return "loading";
}

/**
 * 用 LINE 官方帳號的 basic id 組出加好友連結。
 *
 * 官方帳號的 basic id 在 LINE 後台是以 `@` 開頭顯示的(例如 `@miaoyue`),但欄位裡實際存的
 * 可能有 `@`、也可能沒有(取決於商家從哪裡複製過來)。這裡一律先把開頭的 `@` 去掉再補一個,
 * 避免產生 `https://line.me/R/ti/p/@@miaoyue` 這種點進去找不到帳號的壞連結。
 * 拿不到有效的 basic id 時回傳 null,由呼叫端決定要顯示什麼替代文字。
 */
export function buildLineAddFriendUrl(lineBotBasicId: string | null | undefined): string | null {
  if (typeof lineBotBasicId !== "string") return null;
  const withoutAt = lineBotBasicId.trim().replace(/^@+/, "");
  if (withoutAt.length === 0) return null;
  return `https://line.me/R/ti/p/@${withoutAt}`;
}

/** 綁定碼剩餘時間的顯示格式(m:ss)。已經過期時顯示 0:00,不顯示負數。 */
export function formatBindingCodeCountdown(msRemaining: number): string {
  const safeMs = Number.isFinite(msRemaining) ? msRemaining : 0;
  const totalSeconds = Math.max(0, Math.floor(safeMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * 資料庫層的原始錯誤訊息裡,一看就知道「不該給使用者看」的特徵。
 * 我們自己 raise 的訊息全部是中文白話句(例如「你不是這間商家目前在職、且已開通登入的服務人員」),
 * 這些特徵字串只會出現在 PostgREST/Postgres/網路層自己產生的訊息裡。
 */
const RAW_DATABASE_MESSAGE_PATTERNS: RegExp[] = [
  /permission denied/i,
  /does not exist/i,
  /violates .*constraint/i,
  /SQLSTATE/i,
  /\bJWT\b/i,
  /^DETAIL:/i,
  /Failed to fetch/i,
];

/** 中文字(含常用擴充區)—— 用來判斷這句話是不是我們自己寫的白話訊息。 */
const CJK_PATTERN = /[㐀-䶿一-鿿]/;

/**
 * 把錯誤轉成「可以直接顯示給使用者」的白話中文。
 *
 * 規則(刻意跟 src/lib/authErrorMessages.ts 相反,理由寫清楚以免之後有人統一成同一套):
 *   ・authErrorMessages 處理的是 Supabase Auth 回傳的**英文**訊息,那邊的原則是「查不到對照就
 *     原樣顯示英文」,因為那些訊息本身就是使用者可能需要的線索(例如密碼長度不足)。
 *   ・這裡處理的是**我們自己寫的資料庫函式**丟出來的訊息,它們本來就已經是中文白話句,直接顯示
 *     是最好的。真正需要攔下來的,是「不是我們寫的那些」——PostgREST 的 permission denied、
 *     函式不存在、網路層的 Failed to fetch 等等。那些對使用者完全沒有意義,一律換成 fallback。
 *
 * 判斷方式:沒有任何中文字 → 一定不是我們寫的,換掉;或命中原始訊息特徵 → 換掉。
 */
export function toFriendlyLineBindingErrorMessage(err: unknown, fallback: string): string {
  const raw = getErrorMessage(err, "").trim();
  if (raw.length === 0) return fallback;
  if (!CJK_PATTERN.test(raw)) return fallback;
  if (RAW_DATABASE_MESSAGE_PATTERNS.some((pattern) => pattern.test(raw))) return fallback;
  return raw;
}
