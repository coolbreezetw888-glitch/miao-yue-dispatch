-- 模組 14:服務人員端(功能層,第二支)。
-- 對應規格書第三節 3.1(is_merchant_staff)、3.5(is_own_staff_row)、3.6(has_own_staff_permission)、
-- 3.7(can_self_manage_availability)、3.8(can_view_staff_own_payroll)。
--
-- 這五支是本模組所有自助功能函式共用的最底層守門判斷(規則 2.4/2.9 的落地基礎),之後任何新增
-- 函式如果需要判斷「這是不是本人」/「本人有沒有被開通某個功能」,一律呼叫這裡的函式,不能自己
-- 重新寫一次查詢條件。

-- =========================================================================
-- 3.5 private.is_own_staff_row(p_staff_id uuid)
-- 核心必測(規則 2.4/2.9):必須同時檢查 status='active' 且 login_status='active',
-- 任一個不符合都回傳 false——這是規則 2.9 要求的最底層守門判斷。
-- =========================================================================
create or replace function private.is_own_staff_row(p_staff_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.merchant_staff ms
    where ms.id = p_staff_id
      and ms.user_id = auth.uid()
      and ms.status = 'active'
      and ms.login_status = 'active'
  );
$$;

comment on function private.is_own_staff_row(uuid) is '對應規格書 3.5(核心,規則 2.4/2.9):目前登入者是不是這一筆 merchant_staff 紀錄本人,且該紀錄目前 status=active 且 login_status=active(任一不符合都回傳 false)。本模組所有自助功能函式共用的最底層守門判斷,不能自己重新寫一次查詢條件。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.is_own_staff_row(uuid) from public, anon;
grant execute on function private.is_own_staff_row(uuid) to authenticated;

-- =========================================================================
-- 3.1 private.is_merchant_staff(p_merchant_id uuid)
-- 比照 private.is_merchant_agent 的既有寫法,查詢條件跟 3.5 相同的兩個 active 條件
-- (對應規則 2.9 第 2 點),供 3.2 疊加 merchants_select 使用。
-- =========================================================================
create or replace function private.is_merchant_staff(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id
      and ms.user_id = auth.uid()
      and ms.status = 'active'
      and ms.login_status = 'active'
  );
$$;

comment on function private.is_merchant_staff(uuid) is '對應規格書 3.1/規則 2.9 第 2 點:目前登入者是不是該商家「目前有效且已開通登入」的服務人員(status=active 且 login_status=active,任一不符合都回傳 false)。用於 merchants_select RLS 疊加(3.2)。只給 RLS 政策呼叫,不對外暴露。';

revoke execute on function private.is_merchant_staff(uuid) from public, anon;
grant execute on function private.is_merchant_staff(uuid) to authenticated;

-- =========================================================================
-- 3.6 private.has_own_staff_permission(p_staff_id uuid, p_section_key text)
-- =========================================================================
create or replace function private.has_own_staff_permission(p_staff_id uuid, p_section_key text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_own_staff_row(p_staff_id)
    and exists (
      select 1
      from public.merchant_staff_permissions msp
      where msp.staff_id = p_staff_id
        and msp.section_key = p_section_key
        and msp.granted = true
    );
$$;

comment on function private.has_own_staff_permission(uuid, text) is '對應規格書 3.6:private.is_own_staff_row(p_staff_id) 為真,且 merchant_staff_permissions 有一筆 staff_id=p_staff_id and section_key=p_section_key and granted=true 的紀錄,才回傳 true。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.has_own_staff_permission(uuid, text) from public, anon;
grant execute on function private.has_own_staff_permission(uuid, text) to authenticated;

-- =========================================================================
-- 3.7 private.can_self_manage_availability(p_staff_id uuid)
-- 對應規則 2.2:僅按件計酬服務人員能自助調整可預約時段/休假,即使被開通
-- staff_availability_self_manage,月薪制服務人員一律回傳 false。
-- =========================================================================
create or replace function private.can_self_manage_availability(p_staff_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.has_own_staff_permission(p_staff_id, 'staff_availability_self_manage')
    and exists (
      select 1 from public.merchant_staff ms
      where ms.id = p_staff_id and ms.compensation_type = 'piece_rate'
    );
$$;

comment on function private.can_self_manage_availability(uuid) is '對應規格書 3.7/規則 2.2:private.has_own_staff_permission(p_staff_id, ''staff_availability_self_manage'') 且該服務人員 compensation_type=''piece_rate''。月薪制服務人員即使 granted=true 也回傳 false。只給本模組內部函式/既有排班函式疊加呼叫,不對外暴露。';

revoke execute on function private.can_self_manage_availability(uuid) from public, anon;
grant execute on function private.can_self_manage_availability(uuid) to authenticated;

-- =========================================================================
-- 3.8 private.can_view_staff_own_payroll(p_staff_id uuid)
-- 獨立命名(不是直接複用 3.6),讓 3.17 疊加既有報表函式時語意清楚(「服務人員自己查自己」
-- 這個分支專用的判斷),不影響既有的 private.can_view_payroll_reports(商家管理員/客服視角)。
-- =========================================================================
create or replace function private.can_view_staff_own_payroll(p_staff_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select private.has_own_staff_permission(p_staff_id, 'staff_payroll_view');
$$;

comment on function private.can_view_staff_own_payroll(uuid) is '對應規格書 3.8:服務人員自己查自己抽成/薪資報表的權限判斷,獨立命名不影響既有 private.can_view_payroll_reports(商家管理員/客服視角)。只給既有報表函式疊加呼叫,不對外暴露。';

revoke execute on function private.can_view_staff_own_payroll(uuid) from public, anon;
grant execute on function private.can_view_staff_own_payroll(uuid) to authenticated;
