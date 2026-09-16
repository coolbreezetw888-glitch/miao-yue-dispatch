// 模組 4:服務項目管理 — 第五節「對外介面」的實作
// 其他模組要查詢「這間店有哪些服務項目/服務分類」「依 id 查單一服務項目」,一律 import 這個檔案
// 匯出的 hooks/函式,不要自己 import supabase client 直接查 service_items/service_categories 這兩張表。

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { fetchMerchantServiceItems, fetchServiceCategories, getServiceItem } from "./api";
import type { ServiceCategory, ServiceItem } from "./types";

/** 5.1 對外介面:回傳某商家目前 status='active' 的服務項目清單,唯讀。
 * 供模組 3(服務人員勾選畫面)、模組 5(行事曆排程用工時)、模組 6(訂單顯示/計算金額)、
 * 模組 13(客戶端預約選項目)直接複用。 */
export function useMerchantServiceItems(
  merchantId: string | null | undefined,
): UseQueryResult<ServiceItem[]> {
  return useQuery({
    queryKey: ["service-items-module", "active-service-items", merchantId],
    queryFn: () => fetchMerchantServiceItems(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/** 5.2 對外介面:回傳某商家目前的服務分類清單,唯讀。 */
export function useMerchantServiceCategories(
  merchantId: string | null | undefined,
): UseQueryResult<ServiceCategory[]> {
  return useQuery({
    queryKey: ["service-items-module", "service-categories", merchantId],
    queryFn: () => fetchServiceCategories(merchantId as string),
    enabled: Boolean(merchantId),
  });
}

/** 5.3 對外介面:非 hook 的單純查詢函式,依 id 查單筆服務項目資料。 */
export { getServiceItem };
