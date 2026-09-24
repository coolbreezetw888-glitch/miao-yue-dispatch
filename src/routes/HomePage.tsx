// 後台導覽外殼「個人資料」分頁籤(路由 /app)。
//
// 2026-09-24 使用者指定:服務人員端這個分頁籤的標籤從「首頁」改成「個人資料」,內容是
// 「個人資料卡片 + LINE 綁定」。路由(/app)本身不變,所以既有的深連結/書籤都還通。
// 分頁籤定義見 appLayoutLogic.ts 的 STAFF_PROFILE_TAB。
//
// 2026-09-24 線上故障修正(載入競態):原本這裡是
//     if (!isStaffView) return <Navigate to="/app/manage" replace />;
// 完全沒有等角色載入完成。merchantRole 還是 undefined 時 isStaffView 就是 false,所以連
// **純服務人員** 都會在角色解出來之前先被彈到 /app/manage,再由 ManagePage 彈回來——使用者看到
// 一次商家端「功能」頁的閃爍,而對沒有客服權限的人而言那一瞬間畫面上就是「目前沒有開放給你的功能」。
// 現在改成先等 isViewResolved(見 AppLayout.tsx / appLayoutLogic.ts),判斷邏輯本身抽成純函式
// resolveHomePageOutcome() 並有單元測試。
//
// 使用者決策(2026-09-23):底部選單拔掉「首頁」分頁籤(商家管理員/客服視角),原本這裡的內容
// 分散出去:
//   - 個人資料卡片(姓名/職位/登入信箱)搬到「功能」頁最上方(見 ManagePage.tsx)。
//   - 「新增分店」搬到「商家設定」頁最下方(見 MerchantSettingsPage.tsx),且沿用該頁本來就有的
//     RequireMerchantAdmin 守衛,不需要另外加角色判斷。
//   - 「目前操作中的商家」那段說明文字(M0 時期的暫時佔位文案)一併拿掉,常駐頂端列的
//     MerchantSwitcher 本來就一直顯示目前商家名稱,這段文字沒有額外資訊。
//
// 這個路由(/app)本身沒有拔掉——服務人員角色的底部選單仍然有「首頁」分頁籤,這個頁面現在
// 專職服務人員自己的個人資料首頁。商家管理員/客服(不論是不是雙重身份選擇切到服務人員端檢視)
// 以外的情況一律導去 /app/manage,不會看到空白或過期的畫面。
//
// isStaffView(見 AppLayout.tsx)同時涵蓋兩種情境:①單純服務人員角色 ②管理員/客服同時也是
// 服務人員、選擇切到服務人員端檢視(見 AppLayout.tsx/MerchantSwitcher.tsx 的雙重身份切換功能)。
// 兩種情境都用同一份服務人員自己的資料(useActiveMyStaffRecord 直接查自己的 merchant_staff 紀錄,
// 不透過角色優先權判斷),畫面完全一致。

import { Navigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

import { useCurrentMerchant } from "@/modules/merchant/context";
import { clearStaffPendingLoginEmail } from "@/modules/staff-agent/api";
// 模組 14(服務人員端)規格書 4.1:個人資料卡片。
import { EditMyStaffProfileDialog } from "@/modules/staff-portal/EditMyStaffProfileDialog";
import { useActiveMyStaffRecord, useMyStaffPermission } from "@/modules/staff-portal/context";
// 模組 15(服務人員推播通知)§7.2:比照模組 11 MyLineBindingCard 的既有做法,掛在服務人員本來
// 就會經過的個人設定區域,不強制新增一個獨立路由。
import { PushSubscriptionCard } from "@/modules/push-notifications/PushSubscriptionCard";
// 2026-09-24 使用者指定:「個人資料」分頁籤要含 LINE 綁定。模組 11 既有的 MyLineBindingCard
// 不能直接重用(它只處理 admin/agent 兩種角色,role==='staff' 時直接 return null),所以在
// 服務人員端模組自己做一張唯讀版的狀態卡片,見該元件開頭的完整說明。
import { MyStaffLineBindingCard } from "@/modules/staff-portal/MyStaffLineBindingCard";

import { useAppLayoutContext } from "./AppLayout";
import { resolveHomePageOutcome } from "./appLayoutLogic";
import { LoginEmailSection, PendingAdminLoginEmailSuggestionCard } from "./ProfileCardShared";

export default function HomePage() {
  const { email, newEmail, isStaffView, isViewResolved } = useAppLayoutContext();
  const { merchant: currentMerchant } = useCurrentMerchant();
  const merchantId = currentMerchant?.id ?? null;

  const { data: staffRow } = useActiveMyStaffRecord(merchantId);
  const { data: canEditStaffProfile } = useMyStaffPermission("staff_profile_edit");
  const queryClient = useQueryClient();
  function refetchStaffProfile() {
    void queryClient.invalidateQueries({
      queryKey: ["staff-portal-module", "my-staff-record", merchantId],
    });
  }

  async function clearStaffPendingSuggestion() {
    if (!staffRow) return;
    await clearStaffPendingLoginEmail(staffRow.id);
    await queryClient.invalidateQueries({
      queryKey: ["staff-portal-module", "my-staff-record", merchantId],
    });
  }

  // 這一段的三個分支邏輯抽成純函式 resolveHomePageOutcome()(見 appLayoutLogic.ts + 對應測試):
  //   loading            —— 角色還沒解出來,先顯示載入中,絕對不能先把人導走(2026-09-24 修正)。
  //   redirect-to-manage —— 商家管理員/客服,而且沒有選擇切到服務人員端:這個路由不是他們的落點。
  //   render-staff-home  —— 往下渲染服務人員自己的個人資料頁。
  const outcome = resolveHomePageOutcome({ isViewResolved, isStaffView });

  if (outcome === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  if (outcome === "redirect-to-manage") {
    return <Navigate to="/app/manage" replace />;
  }

  if (!staffRow) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface">
        <p className="text-sm text-muted-foreground">載入中⋯</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-5 py-10">
      <div className="space-y-4 rounded-2xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Avatar className="h-12 w-12">
              {staffRow.avatar_url ? (
                <img
                  src={staffRow.avatar_url}
                  alt={staffRow.name}
                  className="h-full w-full rounded-full object-cover"
                />
              ) : (
                <AvatarFallback className="bg-brand-soft text-lg font-semibold text-brand">
                  {staffRow.name.slice(0, 1)}
                </AvatarFallback>
              )}
            </Avatar>
            <div>
              <p className="text-lg font-semibold text-foreground">
                {staffRow.name}
                {staffRow.nickname ? `(${staffRow.nickname})` : ""}
              </p>
              <p className="text-sm text-muted-foreground">{staffRow.phone || "服務人員"}</p>
              {staffRow.intro ? (
                <p className="mt-1 text-sm text-muted-foreground">{staffRow.intro}</p>
              ) : null}
            </div>
          </div>
          {canEditStaffProfile ? (
            <EditMyStaffProfileDialog
              merchantId={merchantId as string}
              staff={staffRow}
              trigger={
                <Button variant="outline" size="sm">
                  編輯個人資料
                </Button>
              }
              onSaved={refetchStaffProfile}
            />
          ) : null}
        </div>
        <LoginEmailSection email={email} newEmail={newEmail} />
      </div>

      {/* 2026-09-24 使用者指定:「個人資料」分頁籤 = 個人資料卡片 + LINE 綁定。 */}
      <MyStaffLineBindingCard staff={staffRow} />

      {/* §7.3:2026-09-25「手機推播擴及三種角色」批次 —— props 從 staffId 換成
          targetType/targetId。這裡刻意維持明確傳 targetType="staff",不要改成用
          useCurrentMerchantRole(§7.2 的警語:那會讓同時是客服的人在服務人員端看到客服的卡片)。 */}
      <PushSubscriptionCard
        merchantId={merchantId}
        targetType="staff"
        targetId={staffRow.id}
        targetLabel="服務人員"
        merchantName={currentMerchant?.name ?? null}
      />

      {staffRow.pending_admin_login_email ? (
        <PendingAdminLoginEmailSuggestionCard
          pendingEmail={staffRow.pending_admin_login_email}
          onClear={clearStaffPendingSuggestion}
        />
      ) : null}
    </div>
  );
}
