// 模組 3:人員與權限管理 — 第五節「對外介面」的實作
// 其他模組要判斷「目前使用者在這間店是管理員還是客服」「客服有沒有被開放某個功能區塊」
// 「這間店有哪些服務人員/客服」,一律 import 這個檔案匯出的 hooks,不要自己 import supabase
// client 直接查 merchant_staff/merchant_agents/merchant_agent_permissions 這幾張表。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { getVerifiedUser } from "@/lib/auth-guard";
import { useCurrentMerchant } from "@/modules/merchant/context";
import {
  amIMerchantAdmin,
  fetchAgentLoginEmailStatus,
  fetchMyAgentRow,
  fetchMyStaffRow,
  fetchStaffLoginEmailStatus,
  type LoginEmailStatus,
} from "./api";
import type { MerchantAgent, MerchantRole, MerchantStaff } from "./types";

/** 5.1 對外介面:回傳目前使用者在指定商家的角色('admin' | 'agent' | 'staff' | null)。
 * 判斷順序(模組 14 服務人員端規格書規則 2.10 擴充):先問 am_i_merchant_admin(是就是 admin,
 * 管理員角色優先),不是的話再查自己是否有一筆 status='active' 的 merchant_agents 紀錄
 * (是就是 agent),都不是的話再查自己是否有一筆 status='active' 且 login_status='active' 的
 * merchant_staff 紀錄(是就是 staff),都不是則為 null(代表這個人跟這間店完全無關,理論上不會
 * 發生在已經能存取到這間商家的情境下)。同一個人身兼多重角色時,一律顯示較高權限角色對應的完整
 * 既有介面,不會被限縮成服務人員的受限視角(規則 2.10 理由)。 */
export function useMerchantRole(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantRole> {
  return useQuery({
    queryKey: ["staff-agent-module", "merchant-role", merchantId],
    queryFn: async (): Promise<MerchantRole> => {
      const isAdmin = await amIMerchantAdmin(merchantId as string);
      if (isAdmin) return "admin";

      const user = await getVerifiedUser();
      if (!user) return null;

      const agentRow = await fetchMyAgentRow(merchantId as string, user.id);
      if (agentRow && agentRow.status === "active") return "agent";

      const staffRow = await fetchMyStaffRow(merchantId as string, user.id);
      if (staffRow && staffRow.status === "active" && staffRow.login_status === "active") {
        return "staff";
      }

      return null;
    },
    enabled: Boolean(merchantId),
    staleTime: 60_000,
  });
}

/** 目前操作中商家的角色,4.5 AppShell/各頁面最常見的用法,不用每個地方自己組 merchantId。 */
export function useCurrentMerchantRole(): UseQueryResult<MerchantRole> {
  const { merchant } = useCurrentMerchant();
  return useMerchantRole(merchant?.id ?? null);
}

/** 5.2 對外介面:回傳目前使用者(如果是客服)是否被開放某個功能區塊。
 * 不是客服身份時回傳 null,代表「不適用這個判斷,以商家管理員邏輯為準,不應該被這個 hook 擋住」
 * (規格書 5.2 明確定義的語意)。 */
export function useAgentPermission(sectionKey: string): UseQueryResult<boolean | null> {
  const { merchant } = useCurrentMerchant();
  const merchantId = merchant?.id ?? null;

  return useQuery({
    queryKey: ["staff-agent-module", "agent-permission", merchantId, sectionKey],
    queryFn: async (): Promise<boolean | null> => {
      const user = await getVerifiedUser();
      if (!user) return null;

      const agentRow = await fetchMyAgentRow(merchantId as string, user.id);
      if (!agentRow || agentRow.status !== "active") return null; // 不是這間店的有效客服

      const { data, error } = await supabase
        .from("merchant_agent_permissions")
        .select("granted")
        .eq("agent_id", agentRow.id)
        .eq("section_key", sectionKey)
        .maybeSingle();
      if (error) throw error;

      return data?.granted ?? false;
    },
    enabled: Boolean(merchantId),
    staleTime: 30_000,
  });
}

/** 對應規格書「首頁外殼與主題色優化」1.2:首頁個人資料卡片用,讀取目前登入者自己在指定商家的
 * merchant_agents 那一列(含新增的 job_title 欄位)。只有呼叫端(HomePage)確認目前使用者角色是
 * agent 時才需要 enabled=true,不是 agent 時不會真的發出查詢。 */
export function useMyAgentProfile(
  merchantId: string | null | undefined,
  userId: string | null | undefined,
  enabled: boolean,
): UseQueryResult<MerchantAgent | null> {
  return useQuery({
    queryKey: ["staff-agent-module", "my-agent-profile", merchantId, userId],
    queryFn: () => fetchMyAgentRow(merchantId as string, userId as string),
    enabled: enabled && Boolean(merchantId) && Boolean(userId),
  });
}

/** 5.3 對外介面:回傳某商家目前有效(status='active')的服務人員名單,唯讀。 */
export function useMerchantStaffList(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantStaff[]> {
  return useQuery({
    queryKey: ["staff-agent-module", "staff-list", merchantId],
    queryFn: async (): Promise<MerchantStaff[]> => {
      const { data, error } = await supabase
        .from("merchant_staff")
        .select("*")
        .eq("merchant_id", merchantId as string)
        .eq("status", "active")
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MerchantStaff[];
    },
    enabled: Boolean(merchantId),
  });
}

/** 5.4 對外介面:回傳某商家目前有效(status='active')的客服名單,唯讀。 */
export function useMerchantAgentList(
  merchantId: string | null | undefined,
): UseQueryResult<MerchantAgent[]> {
  return useQuery({
    queryKey: ["staff-agent-module", "agent-list", merchantId],
    queryFn: async (): Promise<MerchantAgent[]> => {
      const { data, error } = await supabase
        .from("merchant_agents")
        .select("*")
        .eq("merchant_id", merchantId as string)
        .eq("status", "active")
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as MerchantAgent[];
    },
    enabled: Boolean(merchantId),
  });
}

// =========================================================================
// 對應規格書(帳號登入安全性優化)2.4.3/2.5.3:管理員視角查詢某位服務人員/客服目前實際的
// 登入信箱狀態,給人員管理頁的登入信箱欄位/徽章用。只在已開通登入時才需要查(呼叫端自行控制
// enabled),避免對還沒開通登入的人白跑一趟(get_staff_login_email_status 內部也會擋下)。
// =========================================================================
export function useStaffLoginEmailStatus(
  staffId: string | null | undefined,
  enabled: boolean,
): UseQueryResult<LoginEmailStatus> {
  return useQuery({
    queryKey: ["staff-agent-module", "staff-login-email-status", staffId],
    queryFn: () => fetchStaffLoginEmailStatus(staffId as string),
    enabled: enabled && Boolean(staffId),
    staleTime: 15_000,
  });
}

export function useAgentLoginEmailStatus(
  agentId: string | null | undefined,
  enabled: boolean,
): UseQueryResult<LoginEmailStatus> {
  return useQuery({
    queryKey: ["staff-agent-module", "agent-login-email-status", agentId],
    queryFn: () => fetchAgentLoginEmailStatus(agentId as string),
    enabled: enabled && Boolean(agentId),
    staleTime: 15_000,
  });
}
