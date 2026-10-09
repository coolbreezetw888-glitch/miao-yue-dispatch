// 客戶端第 2 批(C2-B02):LINE 登入回來的頁面 `/auth/line/callback`(所有商家共用同一個網址)。
//
// 做的事(順序不能變):
//   1. 讀網址上的 code / state / error,**馬上用 history.replaceState 把參數清掉**
//      (授權碼不留在瀏覽紀錄、也不會因為客人分享網址被別人拿到;C2-F03)。
//   2. 呼叫 Edge Function 的 complete(同一個 state 只送一次:伺服器端也是單次有效)。
//   3. 成功 ⇒ 用「這間店的客戶 client」verifyOtp 建立登入狀態,草稿交給預約頁,回到 /booking/<代碼>。
//      取消 ⇒ 草稿一樣交回,回到 ⑤ 並提示「你取消了 LINE 登入」。
//   4. 回到哪一頁由伺服器回的代碼決定(C2-F04:不收任何前端或網址上的「回去網址」)。
//
// 不套後台外殼、不需要後台登入;畫面只有轉圈 +「正在完成 LINE 登入…」,失敗時顯示原因與「回店家首頁」。

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { AlertNote } from "@/components/patterns";
import { Button } from "@/components/ui/button";

import { completeLineLogin, CustomerAuthError, establishCustomerSession } from "./customerAuthApi";
import { isValidBookingSlug } from "./customerClient";
import {
  LINE_CALLBACK_PATH,
  lineCompleteErrorMessage,
  putPendingDraft,
  readLineCallbackParams,
  recallLoginSlug,
  takePendingDraft,
  takeLoginOrigin,
  type LineCallbackParams,
} from "./customerLoginLogic";
import { INVITE_MISSING_MESSAGE, invitePath, putClaimedInvite } from "./memberContactsLogic";
import { PublicShell, TitleOnlyHeader } from "./PublicBookingChrome";

/**
 * 同一個 state 在這個分頁只送一次(React 開發模式會把 effect 跑兩次;state 在伺服器也是單次有效,
 * 送第二次只會拿到 login_expired)。
 */
const sentStates = new Set<string>();

/**
 * 這次載入讀到的參數。React 開發模式可能把元件初始化跑兩次,第二次網址已經被清掉了,
 * 所以讀到的值記在這裡給第二次用。
 */
let captured: LineCallbackParams | null = null;

/** 讀參數並立刻清掉網址(在第一次 render 前就做,不等 effect)。 */
function captureAndClearParams(): LineCallbackParams {
  if (window.location.search || window.location.hash) {
    captured = readLineCallbackParams(window.location.search);
    window.history.replaceState(window.history.state, "", LINE_CALLBACK_PATH);
  }
  return captured ?? { code: null, state: null, error: null };
}

type ViewState = { kind: "working" } | { kind: "failed"; message: string; slug: string | null };

export default function LineLoginCallbackPage() {
  const navigate = useNavigate();
  const [params] = useState(captureAndClearParams);
  const [view, setView] = useState<ViewState>({ kind: "working" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // 這次的參數已經拿到元件裡了,模組層的暫存清掉(同一次載入裡再進來這頁不會拿到舊的)。
    captured = null;
    const state = params.state;
    if (!state) {
      setView({
        kind: "failed",
        message: lineCompleteErrorMessage("login_expired"),
        slug: recallLoginSlug(),
      });
      return;
    }
    if (sentStates.has(state)) return;
    sentStates.add(state);
    // C4-B02:這次是不是從會員中心登入頁出發(拿一次就清掉)。
    const origin = takeLoginOrigin();

    void (async () => {
      try {
        const result = await completeLineLogin({
          state,
          code: params.code,
          error: params.error,
        });
        if (!isValidBookingSlug(result.slug)) throw new CustomerAuthError("invalid_response");
        const fromMemberCenter = origin === "member_center";
        if (result.status === "ok") {
          await establishCustomerSession(result.slug, result.tokenHash, result.verifyType);
          putPendingDraft(result.slug, { draft: result.draft, outcome: "logged_in" });
        } else {
          putPendingDraft(result.slug, { draft: result.draft, outcome: "cancelled" });
        }
        // C4-H06 / H07(c4-contract B4-4):從聯絡人邀請落地頁出發
        //   登入成功 ⇒ 伺服器已把邀請保留給這個 LINE 帳號 ⇒ 回邀請頁勾同意、填電話(選填)、按「加入」;
        //   在 LINE 按取消 ⇒ 邀請碼已經不在伺服器,不能自動重試 ⇒「請重新打開邀請連結再試一次。」
        if (result.invite) {
          takePendingDraft(result.slug);
          if (result.status === "ok") {
            putClaimedInvite(result.slug, result.invite.valid);
            navigate(invitePath(result.slug), { replace: true });
          } else {
            setView({ kind: "failed", message: INVITE_MISSING_MESSAGE, slug: result.slug });
          }
          return;
        }
        // C4-B03:沒有草稿(⑦-3 加入會員 / 會員中心登入)⇒ 登入成功一律到會員中心首頁;
        //   在 LINE 按取消 ⇒ 從會員中心出發的回會員中心登入頁,其他回 ①。有草稿的流程不變(回預約頁 ⑤ / ⑥)。
        const toMemberCenter =
          result.draft === null && (result.status === "ok" || fromMemberCenter);
        navigate(toMemberCenter ? `/booking/${result.slug}/me` : `/booking/${result.slug}`, {
          replace: true,
        });
      } catch (err) {
        const code = err instanceof CustomerAuthError ? err.code : null;
        const fromInvite = err instanceof CustomerAuthError && err.fromInvite;
        const serverSlug =
          err instanceof CustomerAuthError && err.slug && isValidBookingSlug(err.slug)
            ? err.slug
            : null;
        // LINE 那邊沒成功(line_error)但伺服器還回了草稿 ⇒ 直接回 ⑤,提示「LINE 登入沒有成功」,資料不用重填。
        if (serverSlug !== null && err instanceof CustomerAuthError && err.draft) {
          putPendingDraft(serverSlug, { draft: err.draft, outcome: "failed" });
          navigate(`/booking/${serverSlug}`, { replace: true });
          return;
        }
        setView({
          kind: "failed",
          message: fromInvite ? INVITE_MISSING_MESSAGE : lineCompleteErrorMessage(code),
          slug: serverSlug ?? recallLoginSlug(),
        });
      }
    })();
  }, [navigate, params]);

  return (
    <PublicShell header={<TitleOnlyHeader title="LINE 登入" />}>
      {view.kind === "working" ? (
        <div
          className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 text-center"
          data-testid="line-callback-working"
          role="status"
        >
          <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden="true" />
          <p className="text-[15px] text-foreground">正在完成 LINE 登入…</p>
        </div>
      ) : (
        <div
          className="mx-auto mt-6 flex max-w-sm flex-col gap-4"
          data-testid="line-callback-failed"
        >
          <AlertNote tone="danger">{view.message}</AlertNote>
          {view.slug ? (
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="w-full"
              onClick={() => navigate(`/booking/${view.slug}`, { replace: true })}
            >
              回店家首頁
            </Button>
          ) : (
            // 不知道是哪一間店(例:網址上的 state 是假的或不完整)⇒ 至少告訴客人下一步怎麼做。
            <p
              className="text-center text-sm leading-relaxed text-muted-foreground"
              data-testid="line-callback-no-shop"
            >
              {"請回到店家給您的預約連結重新操作。"}
            </p>
          )}
        </div>
      )}
    </PublicShell>
  );
}
