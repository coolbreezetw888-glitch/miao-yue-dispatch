-- 模組 14:服務人員端(功能層,第四支)。
-- 對應規格書 3.4(set_staff_permission)、3.9(seed_default_staff_permissions)、3.19
-- (merchant_staff_permissions RLS)。

-- =========================================================================
-- 3.4 set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)
-- 比照既有 set_agent_permission 的寫法,檢查 is_merchant_admin(該筆服務人員的 merchant_id)
-- (規則 2.11:邀請/權限設定只有商家管理員能做,不透過 merchant_agent_permissions 開放給客服,
-- 因為這次根本沒有替這兩個管理動作註冊任何 section_key)。
-- =========================================================================
create or replace function public.set_staff_permission(
  p_staff_id uuid,
  p_section_key text,
  p_granted boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到指定的服務人員紀錄: %', p_staff_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  insert into public.merchant_staff_permissions (staff_id, section_key, granted)
  values (p_staff_id, p_section_key, p_granted)
  on conflict (staff_id, section_key)
  do update set granted = excluded.granted, updated_at = now();
end;
$$;

comment on function public.set_staff_permission(uuid, text, boolean) is '對應規格書 3.4/規則 2.11:商家管理員逐項開關某位服務人員的自助功能區塊,不透過 merchant_agent_permissions 開放給客服。';

revoke execute on function public.set_staff_permission(uuid, text, boolean) from public, anon;
grant execute on function public.set_staff_permission(uuid, text, boolean) to authenticated;

-- =========================================================================
-- 3.9 seed_default_staff_permissions(p_staff_id uuid)
-- 為指定服務人員的四個 section_key 各建立一筆 merchant_staff_permissions,granted 全部預設
-- true(判斷 1)。on conflict do nothing 確保重複呼叫不會產生重複列/不會覆蓋管理員已經手動調整過
-- 的既有設定。這支函式本身不做權限檢查(呼叫者身份的判斷交給呼叫端——3.11 record_invited_
-- staff_login 只給 service_role 呼叫,已經在更外層的 Edge Function 驗證過管理員身份)。
-- =========================================================================
create or replace function public.seed_default_staff_permissions(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_staff_permissions (staff_id, section_key, granted)
  values
    (p_staff_id, 'staff_calendar_view', true),
    (p_staff_id, 'staff_availability_self_manage', true),
    (p_staff_id, 'staff_payroll_view', true),
    (p_staff_id, 'staff_profile_edit', true)
  on conflict (staff_id, section_key) do nothing;
end;
$$;

comment on function public.seed_default_staff_permissions(uuid) is '對應規格書 3.9/判斷 1:服務人員邀請登入完成當下(不是服務人員建立當下),把四個 section_key 各種入一筆 granted=true 的預設權限。on conflict do nothing,重複呼叫不會產生重複列或覆蓋既有設定。只給 3.11 record_invited_staff_login 內部呼叫(該函式只授權給 service_role),不對前端一般 authenticated 使用者開放直接呼叫。';

revoke all on function public.seed_default_staff_permissions(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_staff_permissions(uuid) to service_role;

-- =========================================================================
-- 3.19 merchant_staff_permissions RLS 政策
-- SELECT 允許管理員(join merchant_staff 判斷 is_merchant_admin)或本人(exists 對應
-- merchant_staff.user_id=auth.uid())。沒有 INSERT/UPDATE 政策——一律透過 3.4/3.9 這兩支
-- SECURITY DEFINER 函式寫入。
-- =========================================================================
create policy merchant_staff_permissions_select on public.merchant_staff_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and (private.is_merchant_admin(ms.merchant_id) or ms.user_id = auth.uid())
    )
  );
