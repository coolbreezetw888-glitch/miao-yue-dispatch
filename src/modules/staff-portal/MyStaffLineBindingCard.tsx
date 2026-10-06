// 服務人員端「我的 LINE 綁定」卡片(掛在「個人資料」分頁籤 /app,見 src/routes/HomePage.tsx)。
// 2026-09-24 使用者指定:服務人員端第一個分頁籤改成「個人資料」,內容是「個人資料 + LINE 綁定」。
//
// ⚠️ 2026-09-24(第二輪)使用者裁決,原話:
//
//        「B,要讓服務人員自己綁定。」
//
//    所以這張卡片從原本的「唯讀狀態顯示」改成真正可用:服務人員自己按「產生綁定碼」、
//    自己按「解除綁定」,不需要再向商家管理員索取 6 碼。
//
//    這需要後端配合放寬,已由 migration 20260924040900_self_service_line_binding.sql 完成:
//      ・新增 generate_own_staff_line_binding_code(p_merchant_id)
//        —— 刻意不收 staff_id,函式自己用 auth.uid() 解析出「我在這間商家的那一列」,
//           前端沒有辦法幫別人產生綁定碼。
//      ・unbind_line_account 的 staff 分支放寬成「管理員或本人」(本人同樣是後端用 auth.uid()
//        對照 merchant_staff.user_id 判斷,不信任前端傳來的 id)。
//      ・新增 get_merchant_line_bot_public_info(p_merchant_id)
//        —— 只回傳 is_connected / display_name / line_bot_basic_id 三個公開欄位。
//           加好友連結的來源改成這一支,不再需要管理員專用的 get_merchant_line_config_status。
//
// ⚠️ 為什麼還是不直接重用模組 11 既有的 MyLineBindingCard(src/modules/line-notifications/
//    MyLineBindingCard.tsx):那張卡片的 bindingRoleForQuery 只認 'admin' / 'agent',
//    role === 'staff' 時整張卡直接 return null;它查的也是 merchant_admins / merchant_agents
//    那兩張表,服務人員在那裡沒有紀錄。兩張卡片現在共用的是**判斷邏輯與工具函式**
//    (lineBindingViewLogic.ts)跟**資料存取層**(line-notifications/api.ts),不是元件本身——
//    共用該共用的那一層就好,不要為了「重用一個元件」硬塞三種身分的分支進去。
//
// 資料來源:
//   ・綁定狀態 —— 直接用呼叫端(HomePage)已經查好的 merchant_staff 那一列的 line_bound
//     (useActiveMyStaffRecord,select *),零額外查詢。解除綁定/綁定完成後 invalidate
//     staff-portal 自己的 my-staff-record 查詢讓它重新拿一次。
//   ・商家 LINE 串接狀態與加好友連結 —— 模組 11 的 useMerchantLineBotPublicInfo。
//
// ui-v1-full 第 3 批(2026-09-30):套用 ui-overlay-patterns skill。
// 📌 這個檔案不在第 3 批的清單上(它屬於第 1 批的服務人員端),但上面的說明已經寫明
//    「文案與做法刻意跟商家端那張卡片(line-notifications/MyLineBindingCard)完全一致
//    —— 同一件事在不同角色的畫面上行為不一致,之後一定會有人來問」。這一批改了商家端那張,
//    不一起改這張就會立刻不一致,所以一併處理,並在回報裡列出來。
//   - 「已綁定 / 未綁定」改 StatusTag(二之四);載入中改灰色骨架(二之八)。
//   - 「這間商家還沒完成 LINE 串接」「綁定碼已過期」「查不到 LINE 設定狀態」「沒有加好友連結」
//     改成 🟡 常駐 `!`(AlertNote):都屬於「現在的狀態跟使用者以為的不一樣」(二)。
//   - 🔴「解除綁定」是可逆動作 ⇒ 不標紅,用 ② 次要;「產生綁定碼」是這張卡片最主要的動作 ⇒ ① 主要。
//   - 綁定碼數字加 tabular-nums;加好友連結能折行。
//
// **只動外觀,不動行為**:viewState 的五種分支、API 呼叫、倒數計時、重新檢查全部照舊。

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { AlertNote, StatusTag } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import {
  generateOwnStaffLineBindingCode,
  unbindLineAccount,
  useMerchantLineBotPublicInfo,
} from "@/modules/line-notifications/api";
import {
  buildLineAddFriendUrl,
  formatBindingCodeCountdown,
  resolveLineBindingViewState,
  toFriendlyLineBindingErrorMessage,
} from "@/modules/line-notifications/lineBindingViewLogic";
import type { MerchantStaff } from "@/modules/staff-agent/types";

export function MyStaffLineBindingCard({ staff }: { staff: MerchantStaff }) {
  const merchantId = staff.merchant_id;
  const queryClient = useQueryClient();

  const {
    data: botInfo,
    isLoading: botInfoLoading,
    isError: botInfoFailed,
  } = useMerchantLineBotPublicInfo(merchantId);

  const [generating, setGenerating] = useState(false);
  const [unbinding, setUnbinding] = useState(false);
  const [issuedCode, setIssuedCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // 只有真的有一組綁定碼在倒數時才開計時器,沒有就不要每秒重繪整張卡片。
  useEffect(() => {
    if (!issuedCode) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [issuedCode]);

  function refetchMyStaffRecord() {
    return queryClient.invalidateQueries({
      queryKey: ["staff-portal-module", "my-staff-record", merchantId],
    });
  }

  // 該顯示哪一種狀態一律交給純函式判斷(見 lineBindingViewLogic.ts 檔頭:這是 2026-09-24
  // 線上故障之後訂下的硬要求,這類判斷不可以寫在元件裡)。
  // staff 那一列是呼叫端已經查好、必然存在的(HomePage 在 staffRow 為 null 時根本不會渲染這張
  // 卡片),所以 bindingStatusLoading 永遠是 false、lineBound 永遠是布林值。
  const viewState = resolveLineBindingViewState({
    bindingStatusLoading: false,
    lineBound: staff.line_bound === true,
    merchantInfoLoading: botInfoLoading,
    merchantInfoFailed: botInfoFailed,
    merchantConnected: botInfo ? botInfo.isConnected : null,
  });

  const addFriendUrl = buildLineAddFriendUrl(botInfo?.lineBotBasicId);
  const msRemaining = issuedCode ? new Date(issuedCode.expiresAt).getTime() - now : 0;
  const codeExpired = issuedCode !== null && msRemaining <= 0;

  async function handleGenerate() {
    setGenerating(true);
    try {
      const result = await generateOwnStaffLineBindingCode(merchantId);
      setIssuedCode({ code: result.code, expiresAt: result.expiresAt });
      setNow(Date.now());
      toast.success("已產生綁定碼，請在 10 分鐘內完成綁定");
    } catch (err) {
      toast.error("產生綁定碼失敗", {
        description: toFriendlyLineBindingErrorMessage(
          err,
          "目前沒辦法產生綁定碼，請稍後再試一次。持續失敗請聯絡商家管理員。",
        ),
      });
    } finally {
      setGenerating(false);
    }
  }

  async function handleUnbind() {
    setUnbinding(true);
    try {
      await unbindLineAccount("staff", staff.id);
      setIssuedCode(null);
      toast.success("已解除 LINE 綁定");
      await refetchMyStaffRecord();
    } catch (err) {
      toast.error("解除綁定失敗", {
        description: toFriendlyLineBindingErrorMessage(
          err,
          "目前沒辦法解除綁定，請稍後再試一次。持續失敗請聯絡商家管理員。",
        ),
      });
    } finally {
      setUnbinding(false);
    }
  }

  return (
    <Card data-testid="my-staff-line-binding">
      <CardHeader>
        <CardTitle>我的 LINE 綁定</CardTitle>
        <CardDescription>
          綁定後，商家開啟通知時，你可以直接在自己的 LINE 收到新訂單、班表變動等通知。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">目前綁定狀態</span>
          {viewState === "loading" ? (
            <Skeleton className="h-5 w-16 rounded-full bg-muted" />
          ) : viewState === "bound" ? (
            <StatusTag tone="success">已綁定</StatusTag>
          ) : (
            <StatusTag tone="neutral">未綁定</StatusTag>
          )}
        </div>

        {viewState === "bound" ? (
          <div className="flex flex-col gap-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              你的 LINE 已經綁定完成，不需要再做任何設定。如果換了 LINE 帳號、或不想再收到通知，
              可以自己解除綁定；之後想再收通知，重新產生一次綁定碼就好。
            </p>
            {/* 🔴 可逆動作(解除後重新產生綁定碼就能再綁)⇒ 不標紅,用 ② 次要。 */}
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
          </div>
        ) : null}

        {viewState === "loading" ? <Skeleton className="h-16 w-full rounded-md bg-muted" /> : null}

        {viewState === "merchant_not_connected" ? (
          <AlertNote>
            <strong>這間商家還沒完成 LINE 串接。</strong>
            要先由商家管理員把商家的 LINE 官方帳號接上系統，你才能綁定自己的 LINE 收通知。
            請聯絡商家管理員，接好之後再回到這裡就會出現「產生綁定碼」按鈕。
          </AlertNote>
        ) : null}

        {viewState === "no_access" ? (
          <AlertNote>
            目前查不到這間商家的 LINE 設定狀態，暫時沒辦法綁定。請重新整理頁面再試一次，
            持續發生請聯絡商家管理員。
          </AlertNote>
        ) : null}

        {viewState === "unbound" ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3.5 py-3">
              <p className="text-xs font-medium text-foreground">綁定方式(全部自己就能完成)：</p>
              <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>在 LINE 加商家官方帳號為好友(下面有連結)。</li>
                <li>按「產生綁定碼」，會出現一組 6 碼數字，10 分鐘內有效。</li>
                <li>把那 6 碼數字當成一則訊息傳給官方帳號，就完成綁定了。</li>
              </ol>
              {addFriendUrl ? (
                <a
                  href={addFriendUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block min-w-0 break-all text-xs text-brand hover:underline"
                >
                  點此加好友{botInfo?.displayName ? `：${botInfo.displayName}` : ""}
                </a>
              ) : (
                <AlertNote>
                  商家還沒設定官方帳號的加好友連結，請向商家管理員索取官方帳號。
                </AlertNote>
              )}
            </div>

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
                  請把這組數字當作一則訊息傳給官方帳號，完成綁定
                </p>
                <p className="text-2xl font-bold tracking-widest tabular-nums text-foreground">
                  {issuedCode.code}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  剩餘時間 {formatBindingCodeCountdown(msRemaining)}
                </p>
                {/* 綁定是在 LINE 那邊完成的(Webhook 收到訊息才會寫入 line_bound),這個頁面
                    不會自己知道。給一顆「我傳完了」的按鈕重新查一次自己的紀錄,否則使用者傳完
                    訊息回到這個畫面,會看到狀態還是「未綁定」而以為失敗了。 */}
                <Button
                  type="button"
                  variant="neutral"
                  size="card"
                  className="self-start"
                  onClick={() => void refetchMyStaffRecord()}
                >
                  我已經傳送完成，重新檢查
                </Button>
              </div>
            ) : issuedCode && codeExpired ? (
              <AlertNote>這組綁定碼已經過期，請按「產生綁定碼」重新產生一組。</AlertNote>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
