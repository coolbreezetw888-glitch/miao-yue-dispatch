// 客戶端第 5 批 5-A(C5-K02):「通知客人」設定的資料存取。介面:.project/notes/c5-contract.md(甲)。
// 權限在資料庫函式裡擋(private.can_manage_line_notification:管理員 + 有 LINE 通知權限的客服)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

import {
  parseCustomerLineSettings,
  type CustomerLineSettings,
  type CustomerLineSwitchKey,
  type CustomerLineTemplateCode,
} from "./customerLineSettingsLogic";

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: unknown }>;

function rpc(): UntypedRpc {
  return supabase.rpc.bind(supabase) as unknown as UntypedRpc;
}

export const customerLineSettingsQueryKey = (merchantId: string) =>
  ["line-notifications-module", "customer-line-settings", merchantId] as const;

export async function fetchCustomerLineSettings(merchantId: string): Promise<CustomerLineSettings> {
  const { data, error } = await rpc()("get_customer_line_settings", { p_merchant_id: merchantId });
  if (error) throw error;
  return parseCustomerLineSettings(data);
}

export function useCustomerLineSettings(
  merchantId: string | null | undefined,
): UseQueryResult<CustomerLineSettings> {
  return useQuery({
    queryKey: customerLineSettingsQueryKey(merchantId ?? ""),
    queryFn: () => fetchCustomerLineSettings(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/**
 * 改設定(只送有改的欄位)。templates 裡的值:空字串 = 恢復預設(C5-K02)。
 * 回傳改完之後的設定。
 */
export interface CustomerLineSettingsPatch {
  switches?: Partial<Record<CustomerLineSwitchKey, boolean>>;
  templates?: Partial<Record<CustomerLineTemplateCode, string>>;
}

export function toServerPatch(patch: CustomerLineSettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(patch.switches ?? {}) };
  if (patch.templates && Object.keys(patch.templates).length > 0) {
    out["templates"] = { ...patch.templates };
  }
  return out;
}

export async function updateCustomerLineSettings(
  merchantId: string,
  patch: CustomerLineSettingsPatch,
): Promise<CustomerLineSettings> {
  const { data, error } = await rpc()("update_customer_line_settings", {
    p_merchant_id: merchantId,
    p_patch: toServerPatch(patch),
  });
  if (error) throw error;
  return parseCustomerLineSettings(data);
}
