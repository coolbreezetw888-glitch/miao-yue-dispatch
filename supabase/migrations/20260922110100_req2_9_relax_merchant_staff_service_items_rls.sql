-- 商家端三項調整規格書 §二 2.9(決策4的落地):
-- merchant_staff_service_items 的 SELECT/INSERT/DELETE 政策目前只放行 is_merchant_admin,
-- 這次新增的抽成設定頁需要讓被開通 commission_settings 的客服也能操作「可接服務」開關,
-- 一併放寬到同時允許 can_manage_commission_settings。不影響既有商家管理員的行為(疊加放寬)。

drop policy if exists merchant_staff_service_items_select on public.merchant_staff_service_items;
create policy merchant_staff_service_items_select on public.merchant_staff_service_items
  for select to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and (private.is_merchant_admin(ms.merchant_id) or private.can_manage_commission_settings(ms.merchant_id))
    )
  );

drop policy if exists merchant_staff_service_items_insert on public.merchant_staff_service_items;
create policy merchant_staff_service_items_insert on public.merchant_staff_service_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and (private.is_merchant_admin(ms.merchant_id) or private.can_manage_commission_settings(ms.merchant_id))
    )
  );

drop policy if exists merchant_staff_service_items_delete on public.merchant_staff_service_items;
create policy merchant_staff_service_items_delete on public.merchant_staff_service_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and (private.is_merchant_admin(ms.merchant_id) or private.can_manage_commission_settings(ms.merchant_id))
    )
  );
