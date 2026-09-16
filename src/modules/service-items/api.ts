// 模組 4:服務項目管理 — 資料存取層
// 這裡是唯一直接呼叫 supabase.from('service_categories' / 'service_items') 的地方。其他模組不應該
// 直接操作這兩張表(見規格書第五節「對外介面」),一律透過 context.tsx 匯出的 hooks。
//
// 權限檢查已經下沉到 RLS 層(private.can_manage_service_items,規格書 3.1/3.2),前端直接呼叫
// supabase.from(...) 做 CRUD 即可,不需要另外包 SECURITY DEFINER RPC(規格書 3.3)。
//
// 錯誤訊息顯示注意事項(沿用模組 1/3 已經確立的踩坑):`error` 不是真正的 Error 實例,一律用
// `if (error) throw error` 丟出,畫面上用 getErrorMessage() 取訊息。

import { supabase } from "@/integrations/supabase/client";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type { ServiceCategory, ServiceItem, ServiceItemType } from "./types";

// =========================================================================
// 3.3:服務分類 CRUD。
// =========================================================================

/** 回傳某商家目前的服務分類清單。 */
export async function fetchServiceCategories(merchantId: string): Promise<ServiceCategory[]> {
  const { data, error } = await supabase
    .from("service_categories")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ServiceCategory[];
}

export async function addServiceCategory(
  merchantId: string,
  name: string,
): Promise<ServiceCategory> {
  const { data, error } = await supabase
    .from("service_categories")
    .insert({ merchant_id: merchantId, name: name.trim() })
    .select("*")
    .single();
  if (error) throw error;
  return data as ServiceCategory;
}

export async function renameServiceCategory(categoryId: string, name: string): Promise<void> {
  const { error } = await supabase
    .from("service_categories")
    .update({ name: name.trim() })
    .eq("id", categoryId);
  if (error) throw error;
}

/** 規則 2.2:真刪除,不是軟刪除。底下服務項目會因為 on delete set null 自動變回未分類。 */
export async function deleteServiceCategory(categoryId: string): Promise<void> {
  const { error } = await supabase.from("service_categories").delete().eq("id", categoryId);
  if (error) throw error;
}

// =========================================================================
// 3.3 / 3.4:服務項目 CRUD。
// =========================================================================

export interface UpsertServiceItemInput {
  name: string;
  price: number;
  itemType: ServiceItemType;
  durationMinutes: number;
  categoryId: string | null;
}

/** 回傳某商家所有服務項目(含已下架,4.1 畫面自行依 status 篩選/標示)。 */
export async function fetchMerchantServiceItemsAll(merchantId: string): Promise<ServiceItem[]> {
  const { data, error } = await supabase
    .from("service_items")
    .select("*")
    .eq("merchant_id", merchantId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ServiceItem[];
}

/** 3.4:給模組 3 服務人員勾選畫面使用,只回傳 status='active' 的服務項目。 */
export async function fetchMerchantServiceItems(merchantId: string): Promise<ServiceItem[]> {
  const { data, error } = await supabase
    .from("service_items")
    .select("*")
    .eq("merchant_id", merchantId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ServiceItem[];
}

export async function addServiceItem(
  merchantId: string,
  input: UpsertServiceItemInput,
): Promise<ServiceItem> {
  const { data, error } = await supabase
    .from("service_items")
    .insert({
      merchant_id: merchantId,
      name: input.name.trim(),
      price: input.price,
      item_type: input.itemType,
      duration_minutes: input.durationMinutes,
      category_id: input.categoryId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ServiceItem;
}

export async function updateServiceItem(
  itemId: string,
  input: Partial<UpsertServiceItemInput>,
): Promise<void> {
  const payload: TablesUpdate<"service_items"> = {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.price !== undefined ? { price: input.price } : {}),
    ...(input.itemType !== undefined ? { item_type: input.itemType } : {}),
    ...(input.durationMinutes !== undefined ? { duration_minutes: input.durationMinutes } : {}),
    ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
  };
  const { error } = await supabase.from("service_items").update(payload).eq("id", itemId);
  if (error) throw error;
}

/** 規則 2.3:下架採軟刪除(status='removed'),不做真刪除。 */
export async function removeServiceItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from("service_items")
    .update({ status: "removed" })
    .eq("id", itemId);
  if (error) throw error;
}

export async function reactivateServiceItem(itemId: string): Promise<void> {
  const { error } = await supabase
    .from("service_items")
    .update({ status: "active" })
    .eq("id", itemId);
  if (error) throw error;
}

/** 5.3 對外介面:依 id 查單筆服務項目資料。供之後模組 6 訂單建立時查詢金額/工時快照使用。 */
export async function getServiceItem(id: string): Promise<ServiceItem | null> {
  const { data, error } = await supabase
    .from("service_items")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as ServiceItem | null) ?? null;
}
