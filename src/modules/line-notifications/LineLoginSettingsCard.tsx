// 客戶端第 2 批(C2-A05):「LINE 登入」設定卡。
// 商家端 /app/line-settings(只有商家管理員進得去)與超管商家詳細頁 /platform-admin/merchants/:id 共用這個元件。
//
//   1. 狀態列:尚未設定 / 已設定，尚未啟用 / 已啟用;已啟用但還沒人成功登入過、或沒連結官方帳號 ⇒ 常駐黃色 `!`。
//   2. Callback URL(唯讀 + 複製)。
//   3. Channel ID、Channel Secret(已設定時只顯示遮罩 +「重新輸入」;不重新輸入就不送出 secret)。
//   4. 「啟用 LINE 登入」開關(沒設定時停用 + 常駐 `!` 說原因)。
//   5. 「刪除設定」(不可逆 ⇒ 危險按鈕 + 確認窗)。
//   6. 最下方「設定步驟說明」⇒ 展開白話步驟。
//
// 🔴 C2-F01:Channel Secret 只進不出。輸入框送出後立刻清空;畫面、網路回應、console 都不會出現原文。
// 📌 這張卡的「儲存設定」用 ② 次要按鈕:LINE 串接設定頁上面已經有一顆 ① 主要按鈕(儲存並測試連線),
//    一頁只能有一顆主要(ui-overlay-patterns 二之三)。

import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  AlertNote,
  CardAlertDialog,
  CardAlertDialogAction,
  CardAlertDialogCancel,
  CardAlertDialogContent,
  CardAlertDialogDescription,
  CardAlertDialogFooter,
  CardAlertDialogHeader,
  CardAlertDialogTitle,
  CardAlertDialogTrigger,
  FieldInput,
  FormField,
  LoadingSkeleton,
  StatusTag,
  SwitchRow,
} from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";

import {
  channelIdError,
  channelSecretError,
  deleteMerchantLineLoginConfig,
  lineLoginStatusQueryKey,
  setMerchantLineLoginConfig,
  setMerchantLineLoginEnabled,
  useMerchantLineLoginStatus,
  type MerchantLineLoginStatus,
} from "./lineLoginApi";

/** 伺服器沒回 callback_url 時的備用值(= 目前網站網域)。 */
function fallbackCallbackUrl(): string {
  return `${window.location.origin}/auth/line/callback`;
}

function StatusLine({ status }: { status: MerchantLineLoginStatus }) {
  if (!status.configured) {
    return <StatusTag tone="neutral">尚未設定</StatusTag>;
  }
  if (!status.enabled) {
    return <StatusTag tone="warning">已設定，尚未啟用</StatusTag>;
  }
  return <StatusTag tone="success">已啟用</StatusTag>;
}

export function LineLoginSettingsCard({ merchantId }: { merchantId: string }) {
  const queryClient = useQueryClient();
  const { data: status, isLoading, isError, refetch } = useMerchantLineLoginStatus(merchantId);

  const [channelId, setChannelId] = useState("");
  const [channelIdTouched, setChannelIdTouched] = useState(false);
  // 🔴 secret 只在這個輸入框的 state 裡停留到按下儲存為止,之後立刻清空。
  const [secret, setSecret] = useState("");
  const [secretTouched, setSecretTouched] = useState(false);
  const [reenterSecret, setReenterSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copyLabel, setCopyLabel] = useState("複製");
  const [stepsOpen, setStepsOpen] = useState(false);

  useEffect(() => {
    if (status) setChannelId(status.channelId ?? "");
  }, [status?.channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  const configured = status?.configured ?? false;
  const secretRequired = !configured;
  const showSecretInput = !configured || reenterSecret;
  const idError = channelIdError(channelId);
  const secretErr = showSecretInput ? channelSecretError(secret, secretRequired) : null;
  const callbackUrl = status?.callbackUrl ?? fallbackCallbackUrl();

  function refresh() {
    return queryClient.invalidateQueries({ queryKey: lineLoginStatusQueryKey(merchantId) });
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setChannelIdTouched(true);
    setSecretTouched(true);
    if (idError || secretErr || saving) return;
    setSaving(true);
    try {
      await setMerchantLineLoginConfig(
        merchantId,
        channelId.trim(),
        showSecretInput ? secret.trim() : "",
      );
      toast.success("已儲存 LINE 登入設定");
      setReenterSecret(false);
      setSecretTouched(false);
      await refresh();
    } catch (err) {
      toast.error("儲存失敗", { description: getErrorMessage(err) });
    } finally {
      // 成功或失敗都清掉,secret 不留在畫面上。
      setSecret("");
      setSaving(false);
    }
  }

  async function handleToggle(next: boolean) {
    setToggling(true);
    try {
      await setMerchantLineLoginEnabled(merchantId, next);
      toast.success(next ? "已啟用 LINE 登入" : "已關閉 LINE 登入");
      await refresh();
    } catch (err) {
      toast.error("切換失敗", { description: getErrorMessage(err) });
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteMerchantLineLoginConfig(merchantId);
      toast.success("已刪除 LINE 登入設定");
      setChannelId("");
      setSecret("");
      setReenterSecret(false);
      setChannelIdTouched(false);
      setSecretTouched(false);
      await refresh();
    } catch (err) {
      toast.error("刪除失敗", { description: getErrorMessage(err) });
    } finally {
      setDeleting(false);
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopyLabel("已複製");
      setTimeout(() => setCopyLabel("複製"), 1500);
    } catch {
      toast.error("複製失敗，請手動選取網址複製");
    }
  }

  return (
    <Card data-testid="line-login-settings-card">
      <CardHeader>
        <CardTitle>LINE 登入</CardTitle>
        <CardDescription>
          讓客人在線上預約頁用 LINE 登入，第一次登入會自動成為會員，之後也能收到 LINE 通知。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {isLoading ? (
          <LoadingSkeleton variant="lines" rows={3} />
        ) : isError || !status ? (
          <div className="flex flex-col gap-2">
            <AlertNote tone="danger">
              讀取 LINE 登入設定失敗，可能是網路不穩，你的資料沒有遺失。
            </AlertNote>
            <Button
              type="button"
              variant="neutral"
              size="card"
              className="self-start"
              onClick={() => void refetch()}
            >
              重新整理
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="line-login-status">
              <span className="text-[13px] font-semibold text-foreground">目前狀態</span>
              <StatusLine status={status} />
            </div>
            {status.configured && status.enabled && !status.lastLoginSucceededAt ? (
              <AlertNote data-testid="line-login-never-succeeded">
                還沒有人成功用 LINE 登入過，建議先用你自己的 LINE 測一次。
              </AlertNote>
            ) : null}
            {status.configured && status.linkedOaStatus === "not_linked" ? (
              <AlertNote data-testid="line-login-oa-not-linked">
                {
                  "這個 LINE 登入沒有連結官方帳號，客人登入後收不到 LINE 通知。請到 LINE Developers 的 Basic settings → Linked LINE Official Account 連結。"
                }
              </AlertNote>
            ) : null}

            <FormField
              label="Callback URL"
              htmlFor={`line-login-callback-${merchantId}`}
              help={
                <>
                  {
                    "把這個網址貼到 LINE Developers → 你的 LINE Login channel → LINE Login 分頁 → Callback URL。"
                  }
                </>
              }
              helpLabel="說明：Callback URL 要貼到哪裡"
            >
              <div className="flex gap-2">
                <FieldInput
                  id={`line-login-callback-${merchantId}`}
                  readOnly
                  value={callbackUrl}
                  className="min-w-0 flex-1 bg-muted/40"
                  data-testid="line-login-callback-url"
                />
                <Button
                  type="button"
                  variant="neutral"
                  size="touch"
                  className="shrink-0 px-4"
                  onClick={() => void handleCopy()}
                >
                  {copyLabel}
                </Button>
              </div>
            </FormField>

            <form onSubmit={handleSave} className="flex flex-col gap-4" noValidate>
              <FormField
                label="Channel ID"
                htmlFor={`line-login-channel-id-${merchantId}`}
                required
                error={channelIdTouched ? idError : null}
              >
                <FieldInput
                  id={`line-login-channel-id-${merchantId}`}
                  inputMode="numeric"
                  autoComplete="off"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  onBlur={() => setChannelIdTouched(true)}
                  data-testid="line-login-channel-id"
                />
              </FormField>

              {showSecretInput ? (
                <FormField
                  label="Channel Secret"
                  htmlFor={`line-login-channel-secret-${merchantId}`}
                  required={secretRequired}
                  error={secretTouched ? secretErr : null}
                >
                  <FieldInput
                    id={`line-login-channel-secret-${merchantId}`}
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    onBlur={() => setSecretTouched(true)}
                    data-testid="line-login-channel-secret"
                  />
                  {configured ? (
                    <p className="text-xs text-muted-foreground">
                      留空 = 沿用原本的 Channel Secret。
                    </p>
                  ) : null}
                </FormField>
              ) : (
                <FormField
                  label="Channel Secret"
                  htmlFor={`line-login-secret-reenter-${merchantId}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="font-mono text-[15px] tabular-nums text-foreground"
                      data-testid="line-login-secret-masked"
                    >
                      {status.channelSecretMasked ?? "已設定"}
                    </span>
                    <Button
                      id={`line-login-secret-reenter-${merchantId}`}
                      type="button"
                      variant="neutral"
                      size="card"
                      onClick={() => setReenterSecret(true)}
                      data-testid="line-login-secret-reenter"
                    >
                      重新輸入
                    </Button>
                  </div>
                </FormField>
              )}

              <Button
                type="submit"
                variant="neutral"
                size="touch"
                className="self-start"
                disabled={saving}
                data-testid="line-login-save"
              >
                {saving ? "儲存中⋯" : "儲存設定"}
              </Button>
            </form>

            <SwitchRow
              title="啟用 LINE 登入"
              description="打開後，客人在預約頁按「確定預約」會看到「用 LINE 登入」。"
              descriptionMode="popover"
              helpLabel="說明：啟用 LINE 登入之後客人會看到什麼"
              checked={status.enabled}
              onCheckedChange={(next) => void handleToggle(next)}
              disabled={!status.configured || toggling}
              titleTestId="line-login-enabled-title"
            >
              {!status.configured ? (
                <AlertNote data-testid="line-login-enable-blocked">
                  請先儲存 Channel ID 與 Channel Secret，才能啟用。
                </AlertNote>
              ) : null}
            </SwitchRow>

            {status.configured ? (
              <CardAlertDialog>
                <CardAlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="danger"
                    size="card"
                    className="self-start"
                    disabled={deleting}
                    data-testid="line-login-delete"
                  >
                    刪除設定
                  </Button>
                </CardAlertDialogTrigger>
                <CardAlertDialogContent>
                  <CardAlertDialogHeader>
                    <CardAlertDialogTitle>確定要刪除 LINE 登入設定嗎？</CardAlertDialogTitle>
                    <CardAlertDialogDescription>
                      {
                        "刪除後客人就不能用 LINE 登入，要重新貼一次 Channel ID 與 Channel Secret 才能恢復。已經登入過的會員資料不會被刪除。"
                      }
                    </CardAlertDialogDescription>
                  </CardAlertDialogHeader>
                  <CardAlertDialogFooter>
                    <CardAlertDialogCancel>取消</CardAlertDialogCancel>
                    <CardAlertDialogAction tone="danger" onClick={() => void handleDelete()}>
                      確定刪除
                    </CardAlertDialogAction>
                  </CardAlertDialogFooter>
                </CardAlertDialogContent>
              </CardAlertDialog>
            ) : null}
          </>
        )}

        <div className="border-t border-border pt-3">
          <button
            type="button"
            className="cursor-pointer text-[13px] text-muted-foreground underline-offset-2 hover:underline"
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen((v) => !v)}
            data-testid="line-login-steps-toggle"
          >
            {stepsOpen ? "收起設定步驟說明" : "設定步驟說明"}
          </button>
          {stepsOpen ? <SetupSteps callbackUrl={callbackUrl} /> : null}
        </div>
      </CardContent>
    </Card>
  );
}

/** 設定步驟(規格書第四節的白話版)。 */
function SetupSteps({ callbackUrl }: { callbackUrl: string }) {
  return (
    <ol
      className="mt-2 list-decimal space-y-2 pl-5 text-[13px] leading-relaxed text-foreground"
      data-testid="line-login-steps"
    >
      <li>
        {
          "到 LINE Developers Console，打開你的官方帳號所在的 Provider（提供者）。LINE 登入一定要建在同一個 Provider 底下，否則客人登入後收不到 LINE 通知；channel 建好後不能搬到別的 Provider。"
        }
      </li>
      <li>
        {
          "在這個 Provider 按 Create a new channel，選「LINE Login」。地區選台灣，App types 勾「Web app」，Channel name 不能有「LINE」字樣（例如「店名會員登入」）。"
        }
      </li>
      <li>
        到這個 channel 的「LINE Login」分頁，把 Callback URL 填成：
        <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
          {callbackUrl}
        </span>
      </li>
      <li>
        {
          "到「Basic settings」→ Linked LINE Official Account → Edit，選你的官方帳號（客人登入時可以順便加好友）。"
        }
      </li>
      <li>
        {
          "在「Basic settings」複製 Channel ID 與 Channel Secret，貼到上面儲存，再打開「啟用 LINE 登入」。"
        }
      </li>
      <li>
        {
          "先用你自己的 LINE 到預約頁走一次。channel 還在「Developing」時，只有 Admin / Tester 能登入；要請別人幫忙測，到「Roles」加 Tester。"
        }
      </li>
      <li>
        {
          "測試沒問題後，把 channel 頂端的狀態從「Developing」改成「Published」，一般客人才能登入（改了就不能改回來）。"
        }
      </li>
    </ol>
  );
}
