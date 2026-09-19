-- 獨立小 migration:修正 material_cost_items 的 SELECT 政策(跟模組 9 v2 payment_methods 是
-- 同一種問題的既有缺口,使用者當面要求一併修正,但邏輯上是分開的兩件事,故拆成獨立檔案,
-- 方便之後追蹤是哪個問題的修正)。
--
-- 問題:material_cost_items 的 SELECT 政策目前只放行 private.can_manage_material_costs
-- (material_costs section_key),但「建單時選擇既有料錢成本品項」只需要 orders 權限即可
-- (create_booking/update_booking 本來就是這樣設計的),只有 orders 權限、沒有 material_costs
-- 權限的客服,建單表單目前會因為讀不到 material_cost_items 而看不到清單——跟模組 9 v2
-- payment_methods 表原本的設計缺口是同一種問題(§4 已修正的結論)。
--
-- 修法:SELECT 政策改成同時放行 can_manage_bookings(orders 權限)或 can_manage_material_costs
-- (material_costs 權限),INSERT/UPDATE 政策維持只允許 can_manage_material_costs 不變。
drop policy if exists material_cost_items_select on public.material_cost_items;

create policy material_cost_items_select on public.material_cost_items
  for select to authenticated
  using (private.can_manage_bookings(merchant_id) or private.can_manage_material_costs(merchant_id));
