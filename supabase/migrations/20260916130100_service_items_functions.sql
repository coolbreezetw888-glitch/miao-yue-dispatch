-- 模組 4:服務項目管理(功能/RLS 層)
-- 對應規格書第三節 3.1(private.can_manage_service_items)、3.2(RLS 政策)。

-- =========================================================================
-- 3.1 private.can_manage_service_items(p_merchant_id uuid)
-- 商家管理員永遠可以;客服只有在被開通 service_items 這個 section_key(granted=true)時才可以。
-- 這是本模組所有 RLS 政策的唯一判斷入口(規格書 3.1 邊界情況:不允許任何政策自己另外寫一套
-- 「查 merchant_agent_permissions 是否 granted」的邏輯,避免少寫 status='active' 條件)。
-- =========================================================================
create or replace function private.can_manage_service_items(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'service_items'
        and map.granted = true
    );
$$;

comment on function private.can_manage_service_items(uuid) is '是否能管理該商家的服務項目/服務分類(對應規格書 3.1):商家管理員永遠可以,或是該商家目前有效(status=active)的客服且被開通 service_items 這個 section_key。這是 service_categories/service_items 所有 RLS 政策的唯一判斷入口,不允許另外寫一套判斷邏輯(規則 2.5)。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_manage_service_items(uuid) from public, anon;
grant execute on function private.can_manage_service_items(uuid) to authenticated;

-- =========================================================================
-- 3.2 service_categories / service_items RLS 政策
-- =========================================================================
alter table public.service_categories enable row level security;
alter table public.service_items enable row level security;

-- service_categories:SELECT/INSERT/UPDATE/DELETE 一律要求 can_manage_service_items 為真。
-- 刪除是真刪除(規則 2.2),不算危險操作,允許 DELETE 政策。
create policy service_categories_select on public.service_categories
  for select to authenticated
  using (private.can_manage_service_items(merchant_id));

create policy service_categories_insert on public.service_categories
  for insert to authenticated
  with check (private.can_manage_service_items(merchant_id));

create policy service_categories_update on public.service_categories
  for update to authenticated
  using (private.can_manage_service_items(merchant_id))
  with check (private.can_manage_service_items(merchant_id));

create policy service_categories_delete on public.service_categories
  for delete to authenticated
  using (private.can_manage_service_items(merchant_id));

-- service_items:SELECT/INSERT/UPDATE 一律要求 can_manage_service_items 為真。
-- 沒有 DELETE 政策(規則 2.3,只能軟刪除,透過 UPDATE 把 status 改成 'removed')。
create policy service_items_select on public.service_items
  for select to authenticated
  using (private.can_manage_service_items(merchant_id));

create policy service_items_insert on public.service_items
  for insert to authenticated
  with check (private.can_manage_service_items(merchant_id));

create policy service_items_update on public.service_items
  for update to authenticated
  using (private.can_manage_service_items(merchant_id))
  with check (private.can_manage_service_items(merchant_id));
