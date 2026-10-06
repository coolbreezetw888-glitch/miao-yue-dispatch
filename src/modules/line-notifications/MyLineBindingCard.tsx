// 模組 11(LINE 通知)§4.5:「我的 LINE 綁定」個人設定區塊(對外掛載元件,對應判斷 5/§5.3)。
// 顯示目前綁定狀態 + 「產生綁定碼」按鈕(依登入身份是管理員還是客服,分別呼叫 3.4/3.5)+
// 產生後顯示 6 碼數字 + 10 分鐘倒數 + 加好友連結(複用 4.1 已連線時顯示的那組連結)+
// 已綁定時顯示「解除綁定」按鈕(呼叫 3.19)。
//
// 掛載位置:規格書 4.5 說「由 engineer 依實際既有版面決定掛載位置」——這次掛在 ManagePage.tsx
// 的「功能」分頁籤最上方(商家管理員/客服都會經過這個頁面,不需要另外找個人設定選單)。
//
// ⚠️ 2026-09-24 修掉一個從一開始就存在的 bug(客服看不到加好友連結):
//    加好友連結原本是從 fetchMerchantLineConfigStatus(get_merchant_line_config_status)拿的,
//    而那支資料庫函式第一行就是 `if not private.is_merchant_admin(...) then raise 42501`
//    —— 只有商家管理員能呼叫。所以**客服**打開這張卡片時那支查詢必定失敗,lineConfigStatus
//    永遠是 undefined,畫面上永遠顯示「商家尚未完成 LINE 串接測試連線,暫時沒有加好友連結」,
//    即使商家其實早就串好了。客服等於拿到一組綁定碼卻不知道要加哪個官方帳號好友。
//    修法:改用新增的窄函式 get_merchant_line_bot_public_info(migration 20260924040900),
//    它只回傳 is_connected / display_name / line_bot_basic_id 三個公開欄位,允許在職管理員/
//    客服/服務人員呼叫。管理員的行為完全不變(管理員本來也只用到 line_bot_basic_id 這一個欄位;
//    LINE 設定頁 LineSettingsPage 的串接管理資訊仍然走原本的 useMerchantLineConfigStatus,
//    那一支維持管理員專用、一個字都沒改)。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
//   - 「已綁定 / 未綁定」改 StatusTag(二之四);載入中改灰色骨架,不用「載入中⋯」(二之八)。
//   - 「綁定碼已過期」「商家尚未完成 LINE 串接」改成 🟡 常駐 `!`(AlertNote)—— 兩句都屬於
//     「現在的狀態跟使用者以為的不一樣」,不能只用一行灰字帶過(二)。
//   - 🔴「解除綁定」是可逆動作(解除後重新產生綁定碼就能再綁)⇒ 不標紅,用 ② 次要。
//   - 「產生綁定碼」是這張卡片最主要的動作 ⇒ ① 主要;加好友連結長,改成可折行、各佔一行
//     (比照二之六地址那條:長連結並排會被截斷)。綁定碼數字加 tabular-nums。
//
// **只動外觀,不動行為**:產生 / 解除綁定走哪一支 API(依 admin / agent 角色)、倒數計時、
// 「我已經傳送完成,重新檢查」重新查詢、toast 文案全部照舊。

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { AlertNote, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { getVerifiedUser } from "@/lib/auth-guard";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import {
  generateOwnAdminLineBindingCode,
  generateOwnAgentLineBindingCode,
  unbindLineAccount,
  useMerchantLineBotPublicInfo,
  useMyLineBindingStatus,
} from "./api";
import {
  buildLineAddFriendUrl,
  formatBindingCodeCountdown,
  toFriendlyLineBindingErrorMessage,
} from "./lineBindingViewLogic";

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

  const { data: botPublicInfo } = useMerchantLineBotPublicInfo(merchantId);

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
      toast.success("已產生綁定碼，請在 10 分鐘內完成綁定");
    } catch (err) {
      toast.error("產生綁定碼失敗", {
        description: toFriendlyLineBindingErrorMessage(
          err,
          "目前沒辦法產生綁定碼，請稍後再試一次。",
        ),
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handleUnbind() {
    if (!bindingStatus) return;
    setUnbinding(true);
    try {
      await unbindLineAccount(
        bindingRoleForQuery === "admin" ? "admin" : "agent",
        bindingStatus.selfId,
      );
      toast.success("已解除 LINE 綁定");
      setIssuedCode(null);
      await refetchBindingStatus();
    } catch (err) {
      toast.error("解除綁定失敗", {
        description: toFriendlyLineBindingErrorMessage(err, "目前沒辦法解除綁定，請稍後再試一次。"),
      });
    } finally {
      setUnbinding(false);
    }
  }

  if (!merchantId || bindingRoleForQuery === null) return null;

  const msRemaining = issuedCode ? new Date(issuedCode.expiresAt).getTime() - now : 0;
  const codeExpired = issuedCode !== null && msRemaining <= 0;
  const addFriendUrl = buildLineAddFriendUrl(botPublicInfo?.lineBotBasicId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>我的 LINE 綁定</CardTitle>
        <CardDescription>
          綁定後，商家開啟通知時，你可以直接在自己的 LINE 收到訂單/請假相關通知。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">目前綁定狀態</span>
          {bindingLoading ? (
            <Skeleton className="h-5 w-16 rounded-full bg-muted" />
          ) : bindingStatus?.lineBound ? (
            <StatusTag tone="success">已綁定</StatusTag>
          ) : (
            <StatusTag tone="neutral">未綁定</StatusTag>
          )}
        </div>

        {bindingStatus?.lineBound ? (
          // 🔴 可逆動作(解除後重新產生綁定碼就能再綁)⇒ 不標紅,用 ② 次要。
          <Button
            type="button"
            variant="neutral"
            size="card"
            className="self-start"
            disabled={unbinding}
            onClick={handleUnbind}
          >
            {unbinding ? "處理中⋯" : "解除綁定"}
          </Button>
        ) : (
          <div className="flex flex-col gap-3">
            {/* 這張卡片最主要的動作 ⇒ ① 主要(skill 二之三)。 */}
            <Button
              type="button"
              variant="primary"
              size="touch"
              className="self-start"
              disabled={generating}
              onClick={handleGenerate}
            >
              {generating ? "產生中⋯" : "產生綁定碼"}
            </Button>

            {issuedCode && !codeExpired ? (
              <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3.5 py-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  請在 LINE 加好友後，把這組數字當作一則訊息傳送過去完成綁定
                </p>
                <p className="text-2xl font-bold tracking-widest tabular-nums text-foreground">
                  {issuedCode.code}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  剩餘時間 {formatBindingCodeCountdown(msRemaining)}
                </p>
                {addFriendUrl ? (
                  // 連結很長,320px 下必須自成一行、能折行(比照 skill 二之六地址那條)。
                  <a
                    href={addFriendUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block min-w-0 break-all text-xs text-brand hover:underline"
                  >
                    點此加好友：{addFriendUrl}
                  </a>
                ) : (
                  <AlertNote>
                    商家還沒完成 LINE 串接的測試連線，所以這裡暫時沒有加好友連結可以顯示。
                    綁定碼仍然有效，加好友之後一樣可以把它傳過去完成綁定。
                  </AlertNote>
                )}
                {/* 綁定是在 LINE 那邊完成的(Webhook 收到那則訊息才會寫入 line_bound),這個頁面
                    不會自己知道。給一顆「我傳完了」的按鈕重新查一次自己的紀錄,否則使用者傳完
                    訊息回到這個畫面,會看到狀態還是「未綁定」而以為失敗了。
                    ⚠️ 文案與做法刻意跟服務人員端那張卡片(staff-portal/MyStaffLineBindingCard)
                    完全一致——同一件事在不同角色的畫面上行為不一致,之後一定會有人來問。 */}
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="self-start"
                  onClick={() => void refetchBindingStatus()}
                >
                  我已經傳送完成，重新檢查
                </Button>
              </div>
            ) : issuedCode && codeExpired ? (
              <AlertNote>這組綁定碼已經過期，請按「產生綁定碼」重新產生一組。</AlertNote>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
