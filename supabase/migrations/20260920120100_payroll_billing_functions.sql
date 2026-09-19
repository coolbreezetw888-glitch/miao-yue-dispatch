-- 模組 8:薪資與帳務 — 權限函式 + 四張設定表 RLS + booking_commission_records RLS(第二支)。
-- 對應規格書 §3.1~§3.5、§3.13。

-- =========================================================================
-- 3.1:private.can_manage_commission_settings / can_view_billing / can_view_staff_report
-- 完全比照 private.can_manage_team_leave 的既有寫法(20260919150100_scheduling_leave_functions.sql)。
-- =========================================================================
create or replace function private.can_manage_commission_settings(p_merchant_id uuid)
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
        and map.section_key = 'commission_settings'
        and map.granted = true
    );
$$;

comment on function private.can_manage_commission_settings(uuid) is '是否能管理該商家的抽成/薪資/假別扣款設定(模組 8,規則 2.9):商家管理員永遠可以,或是該商家目前有效的客服且被開通 commission_settings 這個 section_key。只給 RLS 政策內部呼叫,不對外暴露。';

revoke execute on function private.can_manage_commission_settings(uuid) from public, anon;
grant execute on function private.can_manage_commission_settings(uuid) to authenticated;

create or replace function private.can_view_billing(p_merchant_id uuid)
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
        and map.section_key = 'billing'
        and map.granted = true
    );
$$;

comment on function private.can_view_billing(uuid) is '是否能檢視該商家的店家端帳務報表(模組 8,規則 2.9):商家管理員永遠可以,或是該商家目前有效的客服且被開通 billing 這個 section_key。只給 RLS 政策/get_merchant_billing_summary 內部呼叫,不對外暴露。';

revoke execute on function private.can_view_billing(uuid) from public, anon;
grant execute on function private.can_view_billing(uuid) to authenticated;

create or replace function private.can_view_staff_report(p_merchant_id uuid)
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
        and map.section_key = 'staff_report'
        and map.granted = true
    );
$$;

comment on function private.can_view_staff_report(uuid) is '是否能檢視該商家的師傅報表(模組 8,規則 2.9):商家管理員永遠可以,或是該商家目前有效的客服且被開通 staff_report 這個 section_key。只給 RLS 政策/get_staff_commission_summary/get_staff_monthly_payroll_summary 內部呼叫,不對外暴露。';

revoke execute on function private.can_view_staff_report(uuid) from public, anon;
grant execute on function private.can_view_staff_report(uuid) to authenticated;

-- private.can_view_payroll_reports:管理員 or 有 billing or 有 staff_report 的 OR 組合,
-- 供 booking_commission_records 的 SELECT 政策共用(不管是從店家帳務報表還是師傅報表查詢,
-- 都要能讀到這張表)。can_view_billing/can_view_staff_report 內部已經各自檢查過
-- is_merchant_admin,這裡直接 OR 兩者即可,不需要再重複檢查一次。
create or replace function private.can_view_payroll_reports(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select private.can_view_billing(p_merchant_id) or private.can_view_staff_report(p_merchant_id);
$$;

comment on function private.can_view_payroll_reports(uuid) is '是否能讀取該商家的抽成快照紀錄(模組 8 §3.1):can_view_billing 或 can_view_staff_report 任一為真即可(兩者內部都已經涵蓋 is_merchant_admin)。只給 booking_commission_records 的 SELECT RLS 政策使用。';

revoke execute on function private.can_view_payroll_reports(uuid) from public, anon;
grant execute on function private.can_view_payroll_reports(uuid) to authenticated;

-- =========================================================================
-- private.staff_compensation_type:比照 private.staff_merchant_id(20260916140100_booking_functions.sql)
-- 的既有寫法,SECURITY DEFINER 繞過 merchant_staff 本身的 RLS。§3.3/§3.4 的 RLS WITH CHECK 需要
-- 判斷「這位服務人員的計酬類型」,如果直接在 WITH CHECK 子查詢裡 join merchant_staff,會用查詢端
-- (被開通 commission_settings 但沒有 orders/team_leave/business_hours 的客服)的身分做 RLS 檢查,
-- 而 merchant_staff 的 SELECT 政策不包含 commission_settings 這把鑰匙,導致這位客服看不到那一列、
-- 被誤判成「找不到」而擋下寫入(比照模組 5/7 已經踩過的同一類坑)。
-- =========================================================================
create or replace function private.staff_compensation_type(p_staff_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select compensation_type from public.merchant_staff where id = p_staff_id;
$$;

comment on function private.staff_compensation_type(uuid) is '回傳指定服務人員的 compensation_type,SECURITY DEFINER 繞過 merchant_staff 本身的 RLS(該表 SELECT 政策不包含 commission_settings 這把鑰匙,會誤擋被開通 commission_settings 的客服)。只給 staff_commission_rates/staff_salary_settings 的 RLS WITH CHECK 內部呼叫,不對外暴露、不回傳除 compensation_type 以外的任何欄位。';

revoke execute on function private.staff_compensation_type(uuid) from public, anon;
grant execute on function private.staff_compensation_type(uuid) to authenticated;

-- =========================================================================
-- 3.2:merchant_payroll_settings 讀寫。比照 merchant_tax_settings 的既有做法,不包 RPC,
-- 直接開放 RLS SELECT/INSERT/UPDATE,前端用 upsert(on conflict (merchant_id) do update)寫入。
-- 沒有 DELETE 政策。
-- =========================================================================
alter table public.merchant_payroll_settings enable row level security;

create policy merchant_payroll_settings_select on public.merchant_payroll_settings
  for select to authenticated
  using (private.can_manage_commission_settings(merchant_id));

create policy merchant_payroll_settings_insert on public.merchant_payroll_settings
  for insert to authenticated
  with check (private.can_manage_commission_settings(merchant_id));

create policy merchant_payroll_settings_update on public.merchant_payroll_settings
  for update to authenticated
  using (private.can_manage_commission_settings(merchant_id))
  with check (private.can_manage_commission_settings(merchant_id));

-- =========================================================================
-- 3.3:staff_commission_rates 讀寫。直接開放 RLS SELECT/INSERT/UPDATE/DELETE
-- (private.can_manage_commission_settings 為真),INSERT/UPDATE 的 WITH CHECK 額外要求
-- 這位服務人員的 compensation_type = 'piece_rate'(規則 1.2 的邊界情況,CHECK 約束做不到的
-- 跨表判斷落實在這裡)。允許 DELETE(移除個人覆寫、恢復套用商家預設值,不是危險操作)。
--
-- 用 private.staff_merchant_id(staff_id) 而不是直接 join merchant_staff 取得 merchant_id——
-- 比照模組 5/7 已經踩過的坑(merchant_staff 本身的 RLS 只允許 is_merchant_admin,直接 join
-- 會讓被開通 commission_settings 的客服因為看不到 merchant_staff 那一列而被誤判成「找不到」)。
-- =========================================================================
alter table public.staff_commission_rates enable row level security;

create policy staff_commission_rates_select on public.staff_commission_rates
  for select to authenticated
  using (private.can_manage_commission_settings(private.staff_merchant_id(staff_id)));

create policy staff_commission_rates_insert on public.staff_commission_rates
  for insert to authenticated
  with check (
    private.can_manage_commission_settings(private.staff_merchant_id(staff_id))
    and private.staff_compensation_type(staff_id) = 'piece_rate'
  );

create policy staff_commission_rates_update on public.staff_commission_rates
  for update to authenticated
  using (private.can_manage_commission_settings(private.staff_merchant_id(staff_id)))
  with check (
    private.can_manage_commission_settings(private.staff_merchant_id(staff_id))
    and private.staff_compensation_type(staff_id) = 'piece_rate'
  );

create policy staff_commission_rates_delete on public.staff_commission_rates
  for delete to authenticated
  using (private.can_manage_commission_settings(private.staff_merchant_id(staff_id)));

-- =========================================================================
-- 3.4:staff_salary_settings 讀寫。直接開放 RLS SELECT/INSERT/UPDATE
-- (private.can_manage_commission_settings 為真),WITH CHECK 要求 compensation_type =
-- 'monthly_salary'。沒有 DELETE 政策。
-- =========================================================================
alter table public.staff_salary_settings enable row level security;

create policy staff_salary_settings_select on public.staff_salary_settings
  for select to authenticated
  using (private.can_manage_commission_settings(private.staff_merchant_id(staff_id)));

create policy staff_salary_settings_insert on public.staff_salary_settings
  for insert to authenticated
  with check (
    private.can_manage_commission_settings(private.staff_merchant_id(staff_id))
    and private.staff_compensation_type(staff_id) = 'monthly_salary'
  );

create policy staff_salary_settings_update on public.staff_salary_settings
  for update to authenticated
  using (private.can_manage_commission_settings(private.staff_merchant_id(staff_id)))
  with check (
    private.can_manage_commission_settings(private.staff_merchant_id(staff_id))
    and private.staff_compensation_type(staff_id) = 'monthly_salary'
  );

-- =========================================================================
-- 3.5:leave_type_deduction_rules 讀寫。直接開放 RLS SELECT/INSERT/UPDATE
-- (private.can_manage_commission_settings 為真),前端用 upsert
-- (on conflict (leave_type_id) do update)。deduction_mode 對應數值必填的檢查已經在
-- schema 那支 migration 用資料表 CHECK 約束(leave_type_deduction_rules_mode_values_required)
-- 落實在資料庫層(呼應規則 2.7,不只靠前端表單驗證,CHECK 約束不受 RLS 影響,任何寫入路徑都會
-- 被檢查到,不需要在 RLS WITH CHECK 重複同一段邏輯)。沒有 DELETE 政策。
-- =========================================================================
alter table public.leave_type_deduction_rules enable row level security;

create policy leave_type_deduction_rules_select on public.leave_type_deduction_rules
  for select to authenticated
  using (private.can_manage_commission_settings(merchant_id));

create policy leave_type_deduction_rules_insert on public.leave_type_deduction_rules
  for insert to authenticated
  with check (private.can_manage_commission_settings(merchant_id));

create policy leave_type_deduction_rules_update on public.leave_type_deduction_rules
  for update to authenticated
  using (private.can_manage_commission_settings(merchant_id))
  with check (private.can_manage_commission_settings(merchant_id));

-- =========================================================================
-- 3.13:booking_commission_records 的 RLS 政策。SELECT 要求 private.can_view_payroll_reports
-- (merchant_id)。沒有 INSERT/UPDATE/DELETE 政策——一律透過 compute_booking_commission
-- (內部,由 complete_booking 觸發)/recalculate_booking_commission 寫入(下一支 migration)。
-- =========================================================================
alter table public.booking_commission_records enable row level security;

create policy booking_commission_records_select on public.booking_commission_records
  for select to authenticated
  using (private.can_view_payroll_reports(merchant_id));
