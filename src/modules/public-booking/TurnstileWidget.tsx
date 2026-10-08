// 客戶端第 3 批(C3-D04):⑥-4 不登入預約的 Cloudflare Turnstile 元件。
//
// 用法:<TurnstileWidget ref={ref} siteKey=… onStatusChange=… />,按「送出預約」時 `await ref.current.getToken()`。
//   ・每次送出都 reset + execute 拿一個新 token(token 5 分鐘有效、只能驗一次;C3-D04「過期就重新 execute」)。
//   ・大多數人看不到任何東西;Cloudflare 判斷需要時才在這個容器裡出現勾選框
//     (before-interactive-callback ⇒ 畫面加一行「請勾選，確認你不是機器人」)。
//   ・不支援的瀏覽器(unsupported-callback)、腳本載不到、連續失敗 3 次 ⇒ status = "unsupported",
//     由 ⑥-4 換成「這個瀏覽器無法完成安全檢查⋯」畫面。
//
// 🔴 token 只交給呼叫端送到伺服器,不存、不印(C3-F06)。

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { loadTurnstile, TURNSTILE_ACTION, type TurnstileApi } from "./turnstile";

export type TurnstileStatus = "loading" | "ready" | "interactive" | "unsupported";

export interface TurnstileHandle {
  /** 執行一次檢查並等 token。失敗丟 TurnstileTokenError。 */
  getToken: () => Promise<string>;
}

export class TurnstileTokenError extends Error {
  /** error = 這次沒通過(可以再按一次);unsupported = 這個瀏覽器做不到;timeout = 等客人勾選逾時。 */
  readonly code: "error" | "unsupported" | "timeout";
  constructor(code: "error" | "unsupported" | "timeout") {
    super(`turnstile:${code}`);
    this.name = "TurnstileTokenError";
    this.code = code;
  }
}

/** 連續失敗幾次就當作「這個瀏覽器做不到」。 */
export const TURNSTILE_MAX_ERRORS = 3;

interface Pending {
  resolve: (token: string) => void;
  reject: (err: TurnstileTokenError) => void;
}

export const TurnstileWidget = forwardRef<
  TurnstileHandle,
  { siteKey: string; onStatusChange: (status: TurnstileStatus) => void }
>(function TurnstileWidget({ siteKey, onStatusChange }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<TurnstileApi | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const executedRef = useRef(false);
  const errorCountRef = useRef(0);
  const unsupportedRef = useRef(false);
  const statusCb = useRef(onStatusChange);
  statusCb.current = onStatusChange;

  useEffect(() => {
    let cancelled = false;
    statusCb.current("loading");

    function settle(fn: (p: Pending) => void) {
      const p = pendingRef.current;
      pendingRef.current = null;
      if (p) fn(p);
    }
    function markUnsupported() {
      unsupportedRef.current = true;
      statusCb.current("unsupported");
      settle((p) => p.reject(new TurnstileTokenError("unsupported")));
    }

    loadTurnstile()
      .then((api) => {
        if (cancelled || !containerRef.current) return;
        apiRef.current = api;
        const id = api.render(containerRef.current, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          appearance: "interaction-only",
          execution: "execute",
          language: "zh-tw",
          retry: "auto",
          "response-field": false,
          callback: (token: string) => {
            errorCountRef.current = 0;
            statusCb.current("ready");
            settle((p) => p.resolve(token));
          },
          "error-callback": () => {
            errorCountRef.current += 1;
            if (errorCountRef.current >= TURNSTILE_MAX_ERRORS) markUnsupported();
            else {
              statusCb.current("ready");
              settle((p) => p.reject(new TurnstileTokenError("error")));
            }
            // 回 true = 我們自己處理了錯誤(Cloudflare 不再往 console 丟錯)。
            return true;
          },
          "expired-callback": () => {
            // token 過期:下次送出本來就會 reset + execute,不用做什麼。
          },
          "timeout-callback": () => {
            statusCb.current("ready");
            settle((p) => p.reject(new TurnstileTokenError("timeout")));
          },
          "unsupported-callback": () => markUnsupported(),
          "before-interactive-callback": () => statusCb.current("interactive"),
          "after-interactive-callback": () => statusCb.current("ready"),
        });
        if (typeof id !== "string") {
          markUnsupported();
          return;
        }
        widgetIdRef.current = id;
        if (!unsupportedRef.current) statusCb.current("ready");
      })
      .catch(() => {
        if (!cancelled) markUnsupported();
      });

    return () => {
      cancelled = true;
      const api = apiRef.current;
      const id = widgetIdRef.current;
      widgetIdRef.current = null;
      if (api && id) {
        try {
          api.remove(id);
        } catch {
          // 已經被移除了:不影響畫面。
        }
      }
      settle((p) => p.reject(new TurnstileTokenError("error")));
    };
  }, [siteKey]);

  useImperativeHandle(
    ref,
    () => ({
      getToken: () =>
        new Promise<string>((resolve, reject) => {
          const api = apiRef.current;
          const id = widgetIdRef.current;
          if (unsupportedRef.current) {
            reject(new TurnstileTokenError("unsupported"));
            return;
          }
          if (!api || !id) {
            // 腳本還在載入:請客人再按一次(按鈕在 loading 時本來就是停用的,這裡只是保險)。
            reject(new TurnstileTokenError("error"));
            return;
          }
          // 上一次還沒結束的請求一律作廢(避免同一個 token 交給兩次送出)。
          pendingRef.current?.reject(new TurnstileTokenError("error"));
          pendingRef.current = { resolve, reject };
          try {
            if (executedRef.current) api.reset(id);
            executedRef.current = true;
            api.execute(id);
          } catch {
            pendingRef.current = null;
            reject(new TurnstileTokenError("error"));
          }
        }),
    }),
    [],
  );

  // Cloudflare 需要時會在這個容器裡畫出勾選框;平常是空的(interaction-only)。
  return (
    <div ref={containerRef} data-testid="turnstile-container" className="flex justify-center" />
  );
});
