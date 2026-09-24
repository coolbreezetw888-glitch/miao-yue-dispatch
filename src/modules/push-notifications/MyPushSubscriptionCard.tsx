// 模組 15 擴充 §7.2:管理員/客服用的薄包裝,自己解析身份後把 targetType/targetId 交給
// §7.1 的 PushSubscriptionCard。做法完全比照模組 11 的 MyLineBindingCard:
//   useCurrentMerchant() 拿 merchantId → useCurrentMerchantRole() 拿角色 → getVerifiedUser()
//   拿 userId → 查出自己在 merchant_admins / merchant_agents 的那一列 id。
//
// ⚠️ 刻意新增一支只回 selfId 的窄 hook(useMyPushTargetId),**不**借用模組 11 的
//    useMyLineBindingStatus —— 那支函式綁著 LINE 綁定狀態的語意,借用它會造成兩個模組的隱性耦合
//    (規格書 §7.2 明文寫了這一點)。
//
// ⚠️ 雙重身份的重要細節(§7.2):useCurrentMerchantRole() 的優先權是 admin > agent > staff。
//    所以同時是客服與服務人員的人,在 ManagePage 會拿到 agent、在 HomePage(服務人員端)則由
//    useActiveMyStaffRecord 直接查自己的 merchant_staff 列拿到 staff —— 兩邊各自正確。
//    HomePage 維持明確傳 targetType="staff",不要改成用 useCurrentMerchantRole。

import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { useCurrentMerchant } from "@/modules/merchant/context";
import { useCurrentMerchantRole } from "@/modules/staff-agent/context";

import { PushSubscriptionCard } from "./PushSubscriptionCard";
import { PUSH_TARGET_TYPE_LABELS } from "./types";

/** 只回「我在這間商家的那一列 id」,不夾帶任何其他模組的語意。 */
async function fetchMyPushTargetId(
  merchantId: string,
  role: "admin" | "agent",
  userId: string,
): Promise<string | null> {
  const table = role === "admin" ? "merchant_admins" : "merchant_agents";
  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("merchant_id", merchantId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

// 刻意**不 export** —— 只有這個檔案用得到。export 出去會讓 ESLint 的
// react-refresh/only-export-components 多噴一個 warning(這個專案的基準是「warning 不增加」),
// 而且這支 hook 的語意很窄,沒有給別人用的理由。
function useMyPushTargetId(
  merchantId: string | null | undefined,
  role: "admin" | "agent" | null,
  userId: string | null | undefined,
) {
  return useQuery({
    queryKey: ["push-notifications-module", "my-push-target-id", merchantId, role, userId],
    queryFn: () =>
      fetchMyPushTargetId(merchantId as string, role as "admin" | "agent", userId as string),
    enabled: Boolean(merchantId) && Boolean(role) && Boolean(userId),
  });
}

export function MyPushSubscriptionCard() {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;
  const { data: role } = useCurrentMerchantRole();

  const { data: user } = useQuery({
    queryKey: ["push-notifications-module", "verified-user"],
    queryFn: () => getVerifiedUser(),
  });
  const userId = user?.id ?? null;

  // 角色不是 admin/agent 時回傳 null(完全比照 MyLineBindingCard 的 bindingRoleForQuery 寫法)。
  const pushRoleForQuery = role === "admin" || role === "agent" ? role : null;
  const { data: targetId } = useMyPushTargetId(merchantId, pushRoleForQuery, userId);

  if (!merchantId || pushRoleForQuery === null || !targetId) return null;

  return (
    <PushSubscriptionCard
      merchantId={merchantId}
      targetType={pushRoleForQuery}
      targetId={targetId}
      targetLabel={PUSH_TARGET_TYPE_LABELS[pushRoleForQuery]}
      merchantName={merchant?.name ?? null}
    />
  );
}
