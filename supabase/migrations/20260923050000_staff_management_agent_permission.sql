-- 使用者決策(2026-09-23):「服務人員管理」(新增/編輯/移除服務人員、指派可承接的服務項目)開放
-- 成可以用開關授權給客服,不再永遠限定商家管理員——對應新的 merchant_agent_permissions
-- section_key = 'staff_management'。使用者同時明確表示客服管理/LINE 串接設定/行銷通知/資料匯入/
-- 商家設定這五項維持現狀,繼續永遠只給商家管理員,這次不動。
--
-- 「真正刪除」(hard_delete_merchant_staff)刻意不在這次開放範圍內,繼續維持
-- private.is_merchant_admin 的既有檢查——比照 billing/commission_settings 現有的先例(即使整個
-- 區塊開放給客服,特別敏感的操作仍然單獨鎖住只給管理員)。

create or replace function private.can_manage_staff(p_merchant_id uuid)
returns boolean
language sql
stable security definer
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
        and map.section_key = 'staff_management'
        and map.granted = true
    );
$$;

comment on function private.can_manage_staff(uuid) is '判斷目前登入者是否能管理指定商家的服務人員(新增/編輯/軟刪除/指派服務項目)——商家管理員永遠可以,客服要看 merchant_agent_permissions 是否開通 staff_management。不涵蓋硬刪除(hard_delete_merchant_staff 繼續只認 is_merchant_admin)。';

-- merchant_staff:SELECT/INSERT/UPDATE 加上 can_manage_staff 分支,不動既有的其他分支
-- (can_manage_bookings/can_manage_team_leave/can_manage_commission_settings/can_view_payroll_reports/
-- 本人 user_id)。

drop policy if exists merchant_staff_select on public.merchant_staff;
create policy merchant_staff_select on public.merchant_staff
  for select
  using (
    private.is_merchant_admin(merchant_id)
    or private.can_manage_bookings(merchant_id)
    or private.can_manage_team_leave(merchant_id)
    or private.can_manage_commission_settings(merchant_id)
    or private.can_view_payroll_reports(merchant_id)
    or private.can_manage_staff(merchant_id)
    or (user_id = auth.uid())
  );

drop policy if exists merchant_staff_insert on public.merchant_staff;
create policy merchant_staff_insert on public.merchant_staff
  for insert
  with check (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id));

drop policy if exists merchant_staff_update on public.merchant_staff;
create policy merchant_staff_update on public.merchant_staff
  for update
  using (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id))
  with check (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id));

-- merchant_staff_service_items:「指派可承接的服務項目」是服務人員管理的一部分,SELECT/INSERT/
-- DELETE 三個既有政策一樣加上 can_manage_staff 分支,不動既有的 can_manage_commission_settings 分支。

drop policy if exists merchant_staff_service_items_select on public.merchant_staff_service_items;
create policy merchant_staff_service_items_select on public.merchant_staff_service_items
  for select
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = merchant_staff_service_items.staff_id
        and (
          private.is_merchant_admin(ms.merchant_id)
          or private.can_manage_commission_settings(ms.merchant_id)
          or private.can_manage_staff(ms.merchant_id)
        )
    )
  );

drop policy if exists merchant_staff_service_items_insert on public.merchant_staff_service_items;
create policy merchant_staff_service_items_insert on public.merchant_staff_service_items
  for insert
  with check (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = merchant_staff_service_items.staff_id
        and (
          private.is_merchant_admin(ms.merchant_id)
          or private.can_manage_commission_settings(ms.merchant_id)
          or private.can_manage_staff(ms.merchant_id)
        )
    )
  );

drop policy if exists merchant_staff_service_items_delete on public.merchant_staff_service_items;
create policy merchant_staff_service_items_delete on public.merchant_staff_service_items
  for delete
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = merchant_staff_service_items.staff_id
        and (
          private.is_merchant_admin(ms.merchant_id)
          or private.can_manage_commission_settings(ms.merchant_id)
          or private.can_manage_staff(ms.merchant_id)
        )
    )
  );
