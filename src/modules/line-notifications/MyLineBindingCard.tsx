// 模組 11(LINE 通知)§4.5:「我的 LINE 綁定」個人設定區塊(對外掛載元件,對應判斷 5/§5.3)。
// 顯示目前綁定狀態 + 「產生綁定碼」按鈕(依登入身份是管理員還是客服,分別呼叫 3.4/3.5)+
// 產生後顯示 6 碼數字 + 10 分鐘倒數 + 加好友連結(複用 4.1 已連線時顯示的那組連結)+
// 已綁定時顯示「解除綁定」按鈕(呼叫 3.19)。
//
// 掛載位置:規格書 4.5 說「由 engineer 依實際既有版面決定掛載位置」——這次掛在 ManagePage.tsx
// 的「功能」分頁籤最上方(商家管理員/客服都會經過這個頁面,不需要另外找個人設定選單)。

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { getVerifiedUser } from "@/lib/auth-guard";
import { getErrorMessage } from "@/modules/platform-admin/getErrorMessage";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  fetchMerchantLineConfigStatus,
  generateOwnAdminLineBindingCode,
  generateOwnAgentLineBindingCode,
  unbindLineAccount,
  useMyLineBindingStatus,
} from "./api";

function formatCountdown(msRemaining: number): string {
  const totalSeconds = Math.max(0, Math.floor(msRemaining / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function MyLineBindingCard() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: role } = useCurrentMerchantRole();
  const [userId, setUserId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    void getVerifiedUser().then((user) => {
      if (!cancelled) setUserId(user?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const bindingRoleForQuery = role === "admin" || role === "agent" ? role : null;
  const { data: bindingStatus, isLoading: bindingLoading } = useMyLineBindingStatus(
    merchantId,
    bindingRoleForQuery,
    userId,
  );

  const { data: lineConfigStatus } = useQuery({
    queryKey: ["line-notifications-module", "config-status", merchantId],
    queryFn: () => fetchMerchantLineConfigStatus(merchantId as string),
    enabled: Boolean(merchantId),
  });

  const [generating, setGenerating] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [issuedCode, setIssuedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!issuedCode) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [issuedCode]);

  function refetchBindingStatus() {
    return queryClient.invalidateQueries({
      queryKey: ["line-notifications-module", "my-binding-status", merchantId, role, userId],
    });
  }

  async function handleGenerate() {
    if (!merchantId || bindingRoleForQuery === null) return;
    setGenerating(true);
    try {
      const result =
        bindingRoleForQuery === "admin"
          ? await generateOwnAdminLineBindingCode(merchantId)
          : await generateOwnAgentLineBindingCode(merchantId);
      setIssuedCode({ code: result.code, expiresAt: result.expiresAt });
      setNow(Date.now());
      toast.success("已產生綁定碼,請在 10 分鐘內完成綁定");
    } catch (err) {
      toast.error("產生綁定碼失敗", { description: getErrorMessage(err) });
    } finally {
      setGenerating(false);
    }
  }

  async function handleUnbind() {
    if (!bindingStatus) return;
    setUnbinding(true);
    try {
      await unbindLineAccount(bindingRoleForQuery === "admin" ? "admin" : "agent", bindingStatus.selfId);
      toast.success("已解除 LINE 綁定");
      setIssuedCode(null);
      await refetchBindingStatus();
    } catch (err) {
      toast.error("解除綁定失敗", { description: getErrorMessage(err) });
    } finally {
      setUnbinding(false);
    }
  }

  if (!merchantId || bindingRoleForQuery === null) return null;

  const msRemaining = issuedCode ? new Date(issuedCode.expiresAt).getTime() - now : 0;
  const codeExpired = issuedCode !== null && msRemaining <= 0;
  const addFriendUrl = lineConfigStatus?.lineBotBasicId
    ? `https://line.me/R/ti/p/@${lineConfigStatus.lineBotBasicId}`
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>我的 LINE 綁定</CardTitle>
        <CardDescription>
          綁定後,商家開啟通知時,你可以直接在自己的 LINE 收到訂單/請假相關通知。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">目前綁定狀態</span>
          {bindingLoading ? (
            <span className="text-muted-foreground">載入中⋯</span>
          ) : bindingStatus?.lineBound ? (
            <Badge variant="default">已綁定</Badge>
          ) : (
            <Badge variant="secondary">未綁定</Badge>
          )}
        </div>

        {bindingStatus?.lineBound ? (
          <Button type="button" variant="outline" size="sm" disabled={unbinding} onClick={handleUnbind}>
            {unbinding ? "處理中⋯" : "解除綁定"}
          </Button>
        ) : (
          <div className="space-y-3">
            <Button type="button" size="sm" disabled={generating} onClick={handleGenerate}>
              {generating ? "產生中⋯" : "產生綁定碼"}
            </Button>

            {issuedCode && !codeExpired ? (
              <div className="rounded-md border border-dashed border-border px-3 py-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  請在 LINE 加好友後,把這組數字當作一則訊息傳送過去完成綁定
                </p>
                <p className="text-2xl font-bold tracking-widest text-foreground">{issuedCode.code}</p>
                <p className="text-xs text-muted-foreground">
                  剩餘時間 {formatCountdown(msRemaining)}
                </p>
                {addFriendUrl ? (
                  <a
                    href={addFriendUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-xs text-brand hover:underline"
                  >
                    點此加好友:{addFriendUrl}
                  </a>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    (商家尚未完成 LINE 串接測試連線,暫時沒有加好友連結可以顯示)
                  </p>
                )}
              </div>
            ) : issuedCode && codeExpired ? (
              <p className="text-xs text-muted-foreground">綁定碼已過期,請重新產生。</p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
