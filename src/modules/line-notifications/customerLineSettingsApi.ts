// 客戶端第 5 批(C5-K02 / Q01 / Q02):「通知客人」設定的資料存取。介面:.project/notes/c5-contract.md(甲)。
// 權限在資料庫函式裡擋(private.can_manage_line_notification:管理員 + 有 LINE 通知權限的客服);
// 每月上限另一支函式,只有管理員(5-B)。本月額度走 Edge `line-quota-status`(5-B)。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

import {
  parseCustomerLineSettings,
  parseLineQuotaStatus,
  type CustomerLineSettings,
  type LineQuotaStatus,
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
  /** 5-B:服務前幾小時提醒。 */
  reminderHoursBefore?: number;
}

export function toServerPatch(patch: CustomerLineSettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(patch.switches ?? {}) };
  if (patch.reminderHoursBefore !== undefined) {
    out["reminder_hours_before"] = patch.reminderHoursBefore;
  }
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

/**
 * 5-B(C5-Q01):每月客人通知上限。只有商家管理員能改(資料庫擋 42501);null = 不限制。
 * 回傳改完之後的設定(同 get_customer_line_settings)。
 */
export async function setCustomerLineMonthlyCap(
  merchantId: string,
  monthlyCap: number | null,
): Promise<CustomerLineSettings> {
  const { data, error } = await rpc()("set_customer_line_monthly_cap", {
    p_merchant_id: merchantId,
    p_monthly_cap: monthlyCap,
  });
  if (error) throw error;
  return parseCustomerLineSettings(data);
}

export const lineQuotaStatusQueryKey = (merchantId: string) =>
  ["line-notifications-module", "line-quota-status", merchantId] as const;

/**
 * 5-B(C5-Q02):本月 LINE 官方帳號用量 + 秒約自己的分類統計。不回 token。
 * Edge `line-quota-status` 叫不到(部署 / 網路問題)⇒ 退回資料庫 `get_customer_line_usage`
 * (只有秒約自己的統計;plan_limit / used 當成查不到)。兩個都失敗才算錯誤。
 */
export async function fetchLineQuotaStatus(merchantId: string): Promise<LineQuotaStatus> {
  const { data, error } = await supabase.functions.invoke("line-quota-status", {
    body: { merchant_id: merchantId },
  });
  if (!error) return parseLineQuotaStatus(data);
  const usage = await rpc()("get_customer_line_usage", { p_merchant_id: merchantId });
  if (usage.error) throw error;
  const u = (usage.data ?? {}) as Record<string, unknown>;
  return parseLineQuotaStatus({
    plan_limit: null,
    used: null,
    by_category: u["by_category"],
    blocked_until: u["blocked_until"],
  });
}

export function useLineQuotaStatus(
  merchantId: string | null | undefined,
  enabled: boolean,
): UseQueryResult<LineQuotaStatus> {
  return useQuery({
    queryKey: lineQuotaStatusQueryKey(merchantId ?? ""),
    queryFn: () => fetchLineQuotaStatus(merchantId as string),
    enabled: Boolean(merchantId) && enabled,
    // 每打開一次頁面查一次就好(LINE 用量 API 不用一直打)。
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}
