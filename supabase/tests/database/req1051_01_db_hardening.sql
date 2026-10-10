-- SPECS-INDEX #1051 全面體檢修正(H1):資料庫權限與加固
-- migration 20261010230000 ~ 20261010230300
--
--   A  H1-01 表層權限:anon 對 public/private 表、序列全無權限;authenticated 無 TRUNCATE/REFERENCES/TRIGGER;
--             0 policy 的 4 張表 + 新的綁定碼錯誤紀錄表,authenticated 也無權限
--   B  H1-01 預設權限:在交易內新建表/序列/函式,anon(與 PUBLIC)預設拿不到
--   C  H1-01/H1-02 anon 在 public 只能執行 3 支公開 RPC;prevent_disable_last_active_merchant 沒有人能直接呼叫
--   D  H1-03 private 函式:authenticated 只剩 RLS policy 需要的 28 支;anon / PUBLIC 全部沒有
--   E  H1-04/H1-05 加鎖順序:先驗權限再加鎖(本體靜態檢查)+ 沒權限的人「找不到」與「沒權限」同一句
--   F  H1-06 storage 公開讀取 policy 已移除、改成只看得到自己有權寫入的檔案
--   G  H1-07 真正刪除服務人員:有上工 / 工資 / 獎金紀錄 ⇒ 擋下
--   H  H1-08/H1-09/H1-12 已移除的函式、新索引
--   I  H1-10 金額上限白話訊息
--   J  H1-11 merchants 格式限制
--   K  H1-13 組合字元錯誤訊息只寫碼位
--   L  H1-20 LINE 綁定碼錯誤次數限制
begin;

select plan(58);

create function pg_temp.t_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;
create function pg_temp.t_clear()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
-- 本檔的輔助函式要讓測試角色呼叫(migration 已關掉「新函式預設給 PUBLIC」,這裡明確授權)。
grant execute on function pg_temp.t_auth(uuid, text) to public;
grant execute on function pg_temp.t_clear() to public;

-- 抓錯誤訊息(owner 身分執行)。
create function pg_temp.err_of(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

-- =========================================================================
-- 測試資料:A 店(管理員 A)、B 店(管理員 B = 對 A 店沒有權限的登入者)
-- =========================================================================
insert into auth.users (id, email) values
  ('f1051000-0000-4000-8000-000000000001', 'pgtap-h1-admin-a@test.local'),
  ('f1051000-0000-4000-8000-000000000002', 'pgtap-h1-admin-b@test.local');
insert into groups (id) values ('f1051000-0000-4000-8000-000000000011'), ('f1051000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1051000-0000-4000-8000-000000000021', 'f1051000-0000-4000-8000-000000000011', 'H1 甲店', 'in_store_beauty'),
  ('f1051000-0000-4000-8000-000000000022', 'f1051000-0000-4000-8000-000000000012', 'H1 乙店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('f1051000-0000-4000-8000-000000000021', 'f1051000-0000-4000-8000-000000000001'),
  ('f1051000-0000-4000-8000-000000000022', 'f1051000-0000-4000-8000-000000000002');
insert into merchant_staff (id, merchant_id, name, phone, display_order, status) values
  ('f1051000-0000-4000-8000-000000000031', 'f1051000-0000-4000-8000-000000000021', 'H1 服務人員', '0900105101', 1, 'active'),
  ('f1051000-0000-4000-8000-000000000032', 'f1051000-0000-4000-8000-000000000021', 'H1 已移除日薪', '0900105102', 2, 'removed'),
  ('f1051000-0000-4000-8000-000000000033', 'f1051000-0000-4000-8000-000000000021', 'H1 已移除乾淨', '0900105103', 3, 'removed');
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status) values
  ('f1051000-0000-4000-8000-000000000041', 'f1051000-0000-4000-8000-000000000021', 'f1051000-0000-4000-8000-000000000031',
   '2026-12-01 10:00+08', '2026-12-01 11:00+08', 'H1 客人', '0911105101', 'admin', 'accepted');
insert into members (id, merchant_id, name, referral_code, points_balance) values
  ('f1051000-0000-4000-8000-000000000051', 'f1051000-0000-4000-8000-000000000021', 'H1 會員', 'H1REF0001', 100);
insert into staff_bonus_plans (id, merchant_id, name) values
  ('f1051000-0000-4000-8000-000000000061', 'f1051000-0000-4000-8000-000000000021', 'H1 方案');

-- =========================================================================
-- A  表層權限
-- =========================================================================
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f')
     and has_table_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')),
  0, 'A1 anon 對 public/private 任何表、檢視都沒有表層權限');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind = 'S'
     and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE, SELECT, UPDATE') else false end),
  0, 'A2 anon 對 public/private 任何序列都沒有權限');
select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'private') and c.relkind in ('r', 'p')
     and has_table_privilege('authenticated', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')),
  0, 'A3 authenticated 對任何表都沒有 TRUNCATE / REFERENCES / TRIGGER');
select is(
  (select count(*)::int from unnest(array['public.merchant_line_configs', 'public.line_binding_codes',
                                          'public.line_webhook_events', 'public.push_reminder_dedupe_log',
                                          'public.line_binding_failures']) t
   where has_table_privilege('authenticated', t, 'SELECT, INSERT, UPDATE, DELETE')),
  0, 'A4 0 policy 的 5 張表(含新的綁定碼錯誤紀錄表)authenticated 也沒有任何表層權限');
select ok(
  has_table_privilege('authenticated', 'public.bookings', 'SELECT')
  and has_table_privilege('authenticated', 'public.merchant_business_hours', 'INSERT, UPDATE, DELETE'),
  'A5 一般表 authenticated 的讀寫權限保留(實際範圍仍由 RLS policy 決定)');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.line_binding_failures'::regclass)
  and not exists (select 1 from pg_policy where polrelid = 'public.line_binding_failures'::regclass),
  'A6 line_binding_failures:RLS 開、0 條 policy');

-- =========================================================================
-- B  預設權限(交易內新建,rollback 後消失)
-- =========================================================================
create table public.h1_tmp_default_acl (id int);
create sequence public.h1_tmp_seq;
create function public.h1_tmp_fn() returns int language sql as 'select 1';
create function private.h1_tmp_pfn() returns int language sql as 'select 1';
select ok(
  not has_table_privilege('anon', 'public.h1_tmp_default_acl', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
  and has_table_privilege('authenticated', 'public.h1_tmp_default_acl', 'SELECT'),
  'B1 新建表:anon 預設沒有任何權限(authenticated 照舊,由 RLS 決定範圍)');
select ok(not has_sequence_privilege('anon', 'public.h1_tmp_seq', 'USAGE, SELECT, UPDATE'),
  'B2 新建序列:anon 預設沒有權限');
select ok(
  not has_function_privilege('anon', 'public.h1_tmp_fn()', 'execute')
  and not exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = 'public.h1_tmp_fn()'::regprocedure and a.grantee = 0)
  and has_function_privilege('authenticated', 'public.h1_tmp_fn()', 'execute'),
  'B3 public 新建函式:anon、PUBLIC 預設沒有執行權(要開給訪客必須明確 grant)');
select ok(
  not has_function_privilege('authenticated', 'private.h1_tmp_pfn()', 'execute')
  and not has_function_privilege('anon', 'private.h1_tmp_pfn()', 'execute'),
  'B4 private 新建函式:authenticated / anon 預設都沒有執行權');

-- =========================================================================
-- C  anon 可執行的 public 函式
-- =========================================================================
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname not like 'h1_tmp%' and has_function_privilege('anon', p.oid, 'execute')),
  array['customer_peek_contact_invite', 'get_public_available_slots', 'get_public_booking_page'],
  'C1 anon 在 public 只能執行 3 支刻意公開的 RPC');
select ok(
  not has_function_privilege('anon', 'public.prevent_disable_last_active_merchant()', 'execute')
  and not has_function_privilege('authenticated', 'public.prevent_disable_last_active_merchant()', 'execute'),
  'C2 prevent_disable_last_active_merchant(trigger 函式)沒有人能直接呼叫');
select pg_temp.t_auth(null, 'anon');
select lives_ok($$select public.get_public_booking_page('pgtap-h1-no-such-shop')$$,
  'C3 收緊後 anon 仍可執行公開預約頁');
select lives_ok($$select public.customer_peek_contact_invite('pgtap-h1-no-such-shop', repeat('x', 40))$$,
  'C4 收緊後 anon 仍可執行查看聯絡人邀請');
select throws_ok($$select count(*) from public.merchants$$, '42501', null,
  'C5 anon 直接讀表一律沒有權限');
select pg_temp.t_clear();
select ok(has_function_privilege('anon', 'public.get_public_available_slots(text, jsonb, uuid, date, integer)', 'execute'),
  'C6 收緊後 anon 仍可執行可預約時段');

-- =========================================================================
-- D  private 函式
-- =========================================================================
select is(
  (select array_agg(distinct p.proname::text order by p.proname::text) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname <> 'h1_tmp_pfn' and has_function_privilege('authenticated', p.oid, 'execute')),
  array['booking_merchant_id', 'can_listen_merchant_calendar_topic', 'can_listen_staff_schedule_topic',
        'can_manage_bookings', 'can_manage_business_hours', 'can_manage_commission_settings',
        'can_manage_line_notification', 'can_manage_material_costs', 'can_manage_member_points',
        'can_manage_member_settings', 'can_manage_members', 'can_manage_payment_methods',
        'can_manage_push_notification', 'can_manage_service_items', 'can_manage_staff', 'can_manage_team_leave',
        'can_self_manage_availability', 'can_send_line_marketing', 'can_view_payroll_reports', 'is_group_member',
        'is_merchant_admin', 'is_merchant_agent', 'is_merchant_staff', 'is_own_staff_row', 'is_platform_admin',
        'owns_push_target', 'staff_compensation_type', 'staff_merchant_id'],
  'D1 private 函式:authenticated 只能執行 RLS policy 需要的 28 支');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and (has_function_privilege('anon', p.oid, 'execute')
     or p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))),
  0, 'D2 private 函式:anon、PUBLIC 一支都不能執行');
select ok(
  not has_function_privilege('authenticated', 'private.compute_staff_payroll(uuid, integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.issue_line_binding_code(uuid, text, uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.sync_staff_payroll_status_history(uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'private.get_staff_payroll_status_as_of(uuid, timestamptz)', 'execute'),
  'D3 薪資計算、產生綁定碼、寫入歷史等 private 函式 authenticated 不能直接執行');
select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001');
select throws_ok($$select private.compute_staff_payroll('f1051000-0000-4000-8000-000000000031', 2026, 12)$$,
  '42501', null, 'D4 登入者直接呼叫 private 薪資計算 ⇒ 沒有權限');
select is((select count(*)::int from bookings where merchant_id = 'f1051000-0000-4000-8000-000000000021'), 1,
  'D5 RLS policy 用到的判斷函式仍可執行(管理員照常讀到自己店的訂單)');
select pg_temp.t_clear();

-- =========================================================================
-- E  加鎖順序
-- =========================================================================
select is(
  (select array_agg(v.fn order by v.fn) from (values
     ('public', 'cancel_booking', 'private.can_manage_bookings('),
     ('public', 'complete_booking', 'private.can_manage_bookings('),
     ('public', 'confirm_booking', 'private.can_manage_bookings('),
     ('public', 'update_booking_payment_method', 'private.can_manage_bookings('),
     ('public', 'update_booking', 'private.can_manage_bookings('),
     ('public', 'move_booking', 'private.can_manage_bookings('),
     ('public', 'adjust_member_points', 'private.is_merchant_admin('),
     ('public', 'redeem_member_points', 'private.can_manage_members('),
     ('public', 'archive_staff_bonus_plan', 'private.can_manage_commission_settings('),
     ('private', 'reverse_booking_completion', 'private.is_merchant_admin('),
     ('public', 'cancel_staff_leave', 'private.can_manage_team_leave('),
     ('public', 'restore_merchant_agent', 'private.is_merchant_admin(')
   ) v(sch, fn, perm)
   join pg_namespace n on n.nspname = v.sch
   join pg_proc p on p.pronamespace = n.oid and p.proname = v.fn
   cross join lateral (select regexp_replace(replace(p.prosrc, E'\r\n', E'\n'), '--[^\n]*', '', 'g') as body) b
   where strpos(b.body, v.perm) > 0
     and (strpos(b.body, 'for update') = 0 or strpos(b.body, 'for update') > strpos(b.body, v.perm))),
  array['adjust_member_points', 'archive_staff_bonus_plan', 'cancel_booking', 'cancel_staff_leave', 'complete_booking',
        'confirm_booking', 'move_booking', 'redeem_member_points', 'restore_merchant_agent', 'reverse_booking_completion',
        'update_booking', 'update_booking_payment_method'],
  'E1 12 支函式:第一次 for update 都在權限檢查之後(沒權限的人鎖不到列)');

select pg_temp.t_auth('f1051000-0000-4000-8000-000000000002'); -- 乙店管理員:對甲店沒有權限
select throws_ok($$select public.cancel_booking('f1051000-0000-4000-8000-000000000041')$$,
  '42501', '沒有權限執行此操作', 'E2 沒權限的人取消別店訂單 ⇒ 沒有權限');
select throws_ok($$select public.cancel_booking('f1051000-0000-4000-8000-0000000009ff')$$,
  '42501', '沒有權限執行此操作', 'E3 不存在的訂單 ⇒ 同一句(不透露訂單存不存在)');
select throws_ok($$select public.move_booking('f1051000-0000-4000-8000-000000000041', null, null, null, null, null)$$,
  '42501', '沒有權限執行此操作', 'E4 move_booking 沒權限 ⇒ 沒有權限');
select throws_ok($$select public.adjust_member_points('f1051000-0000-4000-8000-000000000051', 10, '測試')$$,
  '42501', '手動調整會員點數，只有商家管理員可以操作', 'E5 調整別店會員點數 ⇒ 沒有權限');
select throws_ok($$select public.adjust_member_points('f1051000-0000-4000-8000-0000000009ff', 10, '測試')$$,
  '42501', '手動調整會員點數，只有商家管理員可以操作', 'E6 不存在的會員 ⇒ 同一句');
select throws_ok($$select public.redeem_member_points('f1051000-0000-4000-8000-0000000009ff', 10, '測試')$$,
  '42501', '沒有權限管理這間商家的會員', 'E7 兌換:不存在的會員 ⇒ 與沒權限同一句');
select throws_ok($$select public.archive_staff_bonus_plan('f1051000-0000-4000-8000-000000000061')$$,
  '42501', '找不到這個獎金方案，或沒有權限修改。', 'E8 封存別店獎金方案 ⇒ 擋下');
select throws_ok($$select public.revert_completed_booking('f1051000-0000-4000-8000-0000000009ff', '誤按')$$,
  '42501', '還原或取消已完成的訂單，只有商家管理員可以操作', 'E9 還原:不存在的訂單 ⇒ 與沒權限同一句');
select pg_temp.t_clear();

select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001'); -- 甲店管理員:行為不變
select is((select (public.adjust_member_points('f1051000-0000-4000-8000-000000000051', 5, '測試')).points_balance), 105,
  'E10 有權限的管理員調整點數照常(100 + 5)');
select is((select (public.cancel_booking('f1051000-0000-4000-8000-000000000041')).status), 'cancelled',
  'E11 有權限的管理員取消訂單照常');
select throws_ok($$select public.cancel_booking('f1051000-0000-4000-8000-000000000041')$$,
  'P0001', null, 'E12 重讀後的狀態檢查照舊(已取消的單不能再取消)');
select pg_temp.t_clear();

-- =========================================================================
-- F  storage
-- =========================================================================
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage'
     and policyname in ('merchant_logos_public_read', 'staff_avatars_public_read')),
  0, 'F1 兩條「任何人都能列出檔案」的公開讀取 policy 已移除');
select is(
  (select array_agg(policyname::text order by policyname) from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and cmd = 'SELECT'),
  array['merchant_logos_admin_select', 'staff_avatars_admin_select', 'staff_avatars_self_select'],
  'F2 SELECT policy 只剩「自己有權寫入的檔案」三條,而且都只給 authenticated');
insert into storage.objects (bucket_id, name) values
  ('merchant-logos', 'f1051000-0000-4000-8000-000000000021/logo-h1.png'),
  ('merchant-logos', 'f1051000-0000-4000-8000-000000000022/logo-h1.png');
select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001');
select is((select array_agg(name order by name) from storage.objects where bucket_id = 'merchant-logos' and name like 'f1051000%'),
  array['f1051000-0000-4000-8000-000000000021/logo-h1.png'], 'F3 管理員只看得到自己店的 LOGO 檔');
select pg_temp.t_clear();
select pg_temp.t_auth(null, 'anon');
select is((select count(*)::int from storage.objects where bucket_id = 'merchant-logos'), 0, 'F4 訪客列不出任何 LOGO 檔');
select pg_temp.t_clear();

-- =========================================================================
-- G  真正刪除服務人員
-- =========================================================================
insert into staff_work_day_records (merchant_id, staff_id, work_date, compensation_type, wage_amount, shift_minutes,
                                    extra_booking_minutes, worked_minutes, pay_amount)
values ('f1051000-0000-4000-8000-000000000021', 'f1051000-0000-4000-8000-000000000032', '2026-11-01', 'daily_wage',
        1500, 480, 0, 480, 1500);
select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001');
select throws_ok($$select public.hard_delete_merchant_staff('f1051000-0000-4000-8000-000000000032')$$,
  'P0001', '這位服務人員過去有上工、工資或獎金紀錄，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。',
  'G1 有上工紀錄的日薪人員 ⇒ 不能真正刪除');
select pg_temp.t_clear();
insert into staff_bonus_assignments (staff_id, merchant_id, plan_id)
values ('f1051000-0000-4000-8000-000000000033', 'f1051000-0000-4000-8000-000000000021', null);
select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001');
select throws_ok($$select public.hard_delete_merchant_staff('f1051000-0000-4000-8000-000000000033')$$,
  'P0001', '這位服務人員過去有上工、工資或獎金紀錄，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。',
  'G2 有獎金指派紀錄 ⇒ 不能真正刪除');
select pg_temp.t_clear();
delete from staff_bonus_assignments where staff_id = 'f1051000-0000-4000-8000-000000000033';
update staff_payroll_status_history set wage_amount = 1200 where staff_id = 'f1051000-0000-4000-8000-000000000033';
insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary, effective_from, wage_amount)
select 'f1051000-0000-4000-8000-000000000033', 'f1051000-0000-4000-8000-000000000021', 'daily_wage', 'removed', 0,
       '2020-01-01', 1200
where not exists (select 1 from staff_payroll_status_history where staff_id = 'f1051000-0000-4000-8000-000000000033' and wage_amount > 0);
select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001');
select throws_ok($$select public.hard_delete_merchant_staff('f1051000-0000-4000-8000-000000000033')$$,
  'P0001', '這位服務人員過去有上工、工資或獎金紀錄，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。',
  'G3 歷史表有工資 ⇒ 不能真正刪除');
select pg_temp.t_clear();
delete from staff_payroll_status_history where staff_id = 'f1051000-0000-4000-8000-000000000033';
select pg_temp.t_auth('f1051000-0000-4000-8000-000000000001');
select lives_ok($$select public.hard_delete_merchant_staff('f1051000-0000-4000-8000-000000000033')$$,
  'G4 沒有任何帳務歷史的已移除服務人員 ⇒ 照常可以真正刪除');
select pg_temp.t_clear();

-- =========================================================================
-- H  移除的函式、新索引
-- =========================================================================
select ok(to_regprocedure('public.platform_purge_merchant_members_and_points(uuid)') is null,
  'H1 平台批次清除會員與點數的函式已移除');
select ok(to_regprocedure('public.get_merchant_billing_summary(uuid, integer, integer)') is null
          and to_regprocedure('public.get_merchant_billing_summary_by_range(uuid, date, date)') is not null,
  'H2 舊版單月帳務報表函式已移除,區間版保留');
select ok(exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'staff_payroll_status_history'
                    and indexdef like '%(merchant_id, compensation_type)%'),
  'H3 staff_payroll_status_history 有 (merchant_id, compensation_type) 索引');

-- =========================================================================
-- I  金額上限
-- =========================================================================
select is(pg_temp.err_of($$select private.validate_booking_selection('f1051000-0000-4000-8000-000000000021', null,
  '[{"service_item_id":"f1051000-0000-4000-8000-0000000000aa","quantity":1,"unit_price":1000000.01}]'::jsonb,
  now(), null, null, null, false, null, null)$$),
  '服務項目單價太大，請確認是否輸入錯誤。', 'I1 單價超過 1,000,000 ⇒ 白話訊息');
select is(pg_temp.err_of($$select private.validate_booking_selection('f1051000-0000-4000-8000-000000000021', null,
  '[{"service_item_id":"f1051000-0000-4000-8000-0000000000aa","quantity":11,"unit_price":1000000}]'::jsonb,
  now(), null, null, null, false, null, null)$$),
  '訂單金額太大，請確認是否輸入錯誤。', 'I2 逐項小計超過 10,000,000 ⇒ 白話訊息');
select is(pg_temp.err_of($$select * from private.calculate_booking_amount(0, true, 10000000.01, false, null, null, false, null, null)$$),
  '自訂總金額太大，請確認是否輸入錯誤。', 'I3 自訂總金額超過 10,000,000 ⇒ 白話訊息');
select is((select final_amount from private.calculate_booking_amount(0, true, 10000000, false, null, null, false, null, null)),
  10000000::numeric, 'I4 剛好 10,000,000 照常計算');

-- =========================================================================
-- J  merchants 格式限制
-- =========================================================================
select throws_ok($$update merchants set theme_custom_color = 'red' where id = 'f1051000-0000-4000-8000-000000000021'$$,
  '23514', null, 'J1 主題色不是 #RGB / #RRGGBB ⇒ 擋下');
select lives_ok($$update merchants set theme_custom_color = '#1a2B3c' where id = 'f1051000-0000-4000-8000-000000000021'$$,
  'J2 #RRGGBB 照常可存');
select throws_ok($$update merchants set logo_url = 'https://example.com/logo.png' where id = 'f1051000-0000-4000-8000-000000000021'$$,
  '23514', null, 'J3 LOGO 網址不是本專案 Storage ⇒ 擋下');
select lives_ok($$update merchants set logo_url = 'https://wjtbmmnakcriuaqoknsq.supabase.co/storage/v1/object/public/merchant-logos/f1051000-0000-4000-8000-000000000021/logo-1.png' where id = 'f1051000-0000-4000-8000-000000000021'$$,
  'J4 本專案 Storage 的 LOGO 網址照常可存');

-- =========================================================================
-- K  組合字元
-- =========================================================================
select ok(
  (select (r ->> 'ok') = 'false' and (r ->> 'message') like '%U+0301%' and strpos(r ->> 'message', chr(769)) = 0
   from (select private.bonus_formula_compile('f1051000-0000-4000-8000-000000000021', '1 +' || chr(769)) as r) x),
  'K1 公式含組合字元 ⇒ 訊息只寫 U+0301,不放原字元');

-- =========================================================================
-- L  LINE 綁定碼錯誤次數限制(以 owner 身分呼叫,等同 service_role 經 Edge 呼叫)
-- =========================================================================
insert into line_binding_codes (merchant_id, target_type, target_id, code, expires_at) values
  ('f1051000-0000-4000-8000-000000000021', 'member', 'f1051000-0000-4000-8000-000000000051', '510510', now() + interval '10 minutes');
select public.consume_line_binding_code('000001', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess'),
       public.consume_line_binding_code('000002', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess'),
       public.consume_line_binding_code('000003', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess'),
       public.consume_line_binding_code('000004', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess');
select is((public.consume_line_binding_code('000005', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess') ->> 'reason'),
  'invalid_or_expired', 'L1 第 5 次錯誤照常回「代碼無效或已過期」');
select is(public.consume_line_binding_code('510510', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess'),
  jsonb_build_object('success', false, 'reason', 'invalid_or_expired'),
  'L2 錯 5 次之後,連正確的碼也不受理(回覆一樣,不透露被暫停)');
select ok((select used_at is null from line_binding_codes where code = '510510'), 'L3 被擋下時綁定碼沒有被用掉');
select is((public.consume_line_binding_code('510510', 'f1051000-0000-4000-8000-000000000021', 'Uh1other') ->> 'success')::boolean,
  true, 'L4 同一間店的另一個 LINE 帳號不受影響');
update line_binding_codes set used_at = null, used_by_line_user_id = null where code = '510510';
update line_binding_failures set attempted_at = attempted_at - interval '61 minutes' where line_user_id = 'Uh1guess';
select is((public.consume_line_binding_code('510510', 'f1051000-0000-4000-8000-000000000021', 'Uh1guess') ->> 'success')::boolean,
  true, 'L5 超過 1 小時後恢復受理');

select * from finish();
rollback;
