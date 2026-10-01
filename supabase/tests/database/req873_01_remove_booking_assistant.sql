-- SPECS-INDEX #873(規格書 .project/specs/副服務人員移除修正.md)。
-- 「移除協助人員不該連主服務人員的訂單一起取消」+「主服務人員被移除時協助卡不可殘留」的資料層驗收。
-- 每一條都查表驗最終狀態(bookings 整列指紋、booking_assistants 筆數、行事曆函式的輸出),不是只看 RPC 回傳值。
--
-- 對應 migration:20261001121000_req873_remove_booking_assistant.sql
--   ① public.remove_booking_assistant(p_booking_id, p_staff_id)
--   ② trigger merchant_staff_removed_drop_assistants(主服務人員 active → removed)
--
-- 【故障注入】見回報;做法是把 ① 改回「cancel_booking 整張單」或把 ② 的 trigger 拿掉,
--   本檔對應的斷言會轉紅。復原方式:`npx supabase db reset --local`。
begin;

select plan(48);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- bookings 整列的指紋(排除 updated_at 以外不排除任何欄位;updated_at 若有變也算「動到」)。
create function pg_temp.booking_fp(p_id uuid)
returns text language sql security definer set search_path = public as $$
  select md5(to_jsonb(b)::text) from public.bookings b where b.id = p_id;
$$;

create function pg_temp.assistant_count(p_id uuid)
returns integer language sql security definer set search_path = public as $$
  select count(*)::integer from public.booking_assistants where booking_id = p_id;
$$;

create function pg_temp.has_assistant(p_id uuid, p_staff uuid)
returns boolean language sql security definer set search_path = public as $$
  select exists (select 1 from public.booking_assistants where booking_id = p_id and staff_id = p_staff);
$$;

-- 行事曆(商家端)在某位服務人員那一欄,有沒有某筆訂單的某種角色色塊。
create function pg_temp.calendar_has(p_schedule jsonb, p_staff uuid, p_booking uuid, p_role text)
returns boolean language sql as $$
  select exists (
    select 1
    from jsonb_array_elements(p_schedule -> 'staff') s,
         jsonb_array_elements(s -> 'bookings') bk
    where (s ->> 'staff_id')::uuid = p_staff
      and (bk ->> 'id')::uuid = p_booking
      and bk ->> 'role' = p_role
  );
$$;

-- =========================================================================
-- Fixture:商家 M(管理員、有 orders 權限的客服、沒有權限的客服)、商家 M2(另一位管理員)。
-- M 的服務人員:A、B、C(一般)、P(之後會被移除的主服務人員)、Q(P 單上的協助人員)。
-- 測試日期 2026-10-06(週一),全週營業、服務人員不限時段,讓排班規則不干擾。
-- =========================================================================
\set merchant_m  e8730000-0000-4000-8000-000000000021
\set merchant_m2 e8730000-0000-4000-8000-000000000022
\set user_admin  e8730000-0000-4000-8000-000000000001
\set user_orders e8730000-0000-4000-8000-000000000002
\set user_none   e8730000-0000-4000-8000-000000000003
\set user_admin2 e8730000-0000-4000-8000-000000000004
\set user_staff_a e8730000-0000-4000-8000-000000000005
\set user_staff_b e8730000-0000-4000-8000-000000000006
\set staff_a     e8730000-0000-4000-8000-000000000041
\set staff_b     e8730000-0000-4000-8000-000000000042
\set staff_c     e8730000-0000-4000-8000-000000000043
\set staff_p     e8730000-0000-4000-8000-000000000044
\set staff_q     e8730000-0000-4000-8000-000000000045
\set item_60     e8730000-0000-4000-8000-000000000031
\set pm_cash     e8730000-0000-4000-8000-000000000071

insert into auth.users (id, email) values
  (:'user_admin',  'pgtap-873-admin@test.local'),
  (:'user_orders', 'pgtap-873-agent-orders@test.local'),
  (:'user_none',   'pgtap-873-agent-none@test.local'),
  (:'user_admin2', 'pgtap-873-admin2@test.local'),
  (:'user_staff_a', 'pgtap-873-staff-a@test.local'),
  (:'user_staff_b', 'pgtap-873-staff-b@test.local');

insert into groups (id) values
  ('e8730000-0000-4000-8000-000000000011'),
  ('e8730000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  (:'merchant_m',  'e8730000-0000-4000-8000-000000000011', '873 測試商家', 'in_store_beauty'),
  (:'merchant_m2', 'e8730000-0000-4000-8000-000000000012', '873 另一間商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  (:'merchant_m', :'user_admin'),
  (:'merchant_m2', :'user_admin2');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select :'merchant_m', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  (:'item_60', :'merchant_m', '剪髮 60 分', 500, 'primary', 60);

insert into payment_methods (id, merchant_id, name) values
  (:'pm_cash', :'merchant_m', '現場付款');

-- A、B 有開通登入(服務人員端驗證用);其餘沒有。
insert into merchant_staff (id, merchant_id, user_id, login_status, name, phone, no_time_slot_limit, status) values
  (:'staff_a', :'merchant_m', :'user_staff_a', 'active', '服務人員A', '0900087301', true, 'active'),
  (:'staff_b', :'merchant_m', :'user_staff_b', 'active', '服務人員B', '0900087302', true, 'active');
select seed_default_staff_permissions(s) from unnest(array[:'staff_a', :'staff_b']::uuid[]) as s;
update merchant_staff_permissions set granted = true
where staff_id in (:'staff_a'::uuid, :'staff_b'::uuid) and section_key = 'staff_calendar_view';

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, status) values
  (:'staff_c', :'merchant_m', '服務人員C', '0900087303', true, 'active'),
  (:'staff_p', :'merchant_m', '服務人員P', '0900087304', true, 'active'),
  (:'staff_q', :'merchant_m', '服務人員Q', '0900087305', true, 'active');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('e8730000-0000-4000-8000-000000000051', :'merchant_m', :'user_orders', '客服-有訂單權限', 'pgtap-873-agent-orders@test.local', 'active', now(), '0901087351'),
  ('e8730000-0000-4000-8000-000000000052', :'merchant_m', :'user_none',   '客服-無授權',     'pgtap-873-agent-none@test.local',   'active', now(), '0901087352');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e8730000-0000-4000-8000-000000000051', 'orders', true);

select pg_temp.test_set_auth(:'user_admin');

-- T1:A 主 + B、C 協助,10:00。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 10:00:00+08', '客戶甲', '0988087301',
  p_assistant_staff_ids => array[:'staff_b'::uuid, :'staff_c'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t1_

-- T2:A 主 + B 協助,12:00(取消訂單用)。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 12:00:00+08', '客戶乙', '0988087302',
  p_assistant_staff_ids => array[:'staff_b'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t2_

-- T3:A 主 + B 協助,14:00(之後改成已完成,驗證已完成的單不能移除)。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 14:00:00+08', '客戶丙', '0988087303',
  p_assistant_staff_ids => array[:'staff_b'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t3_

-- T4:P 主 + Q 協助,16:00(待確認;P 被移除後 Q 要一起消失)。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_p'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 16:00:00+08', '客戶丁', '0988087304',
  p_assistant_staff_ids => array[:'staff_q'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t4_

-- T5:P 主 + Q 協助,18:00(之後改成已完成;P 被移除後**不動**)。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_p'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 18:00:00+08', '客戶戊', '0988087305',
  p_assistant_staff_ids => array[:'staff_q'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t5_

-- T6:C 主 + P 協助,20:00(P 是**協助人員**的單不在 trigger 範圍內)。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_c'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 20:00:00+08', '客戶己', '0988087306',
  p_assistant_staff_ids => array[:'staff_p'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t6_

-- T7:P 主 + Q 協助,08:00,先確認(accepted);P 被移除後 Q 也要一起消失。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_p'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 08:00:00+08', '客戶庚', '0988087307',
  p_assistant_staff_ids => array[:'staff_q'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t7_
select confirm_booking(:'t7_id'::uuid);

-- T8:A 主 + B 協助,06:00(改派主服務人員,協助人員要保留)。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 06:00:00+08', '客戶辛', '0988087308',
  p_assistant_staff_ids => array[:'staff_b'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t8_

select pg_temp.test_clear_auth();

-- T3 / T5 直接改成已完成(只為了驗狀態擋下;不走 complete_booking 以免帶入抽成 / 紅利的前置條件)。
update public.bookings set status = 'completed', completed_at = now() where id in (:'t3_id'::uuid, :'t5_id'::uuid);

-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1)
-- =========================================================================
select ok(not has_function_privilege('anon', 'public.remove_booking_assistant(uuid, uuid)', 'execute'),
  '權限:anon 不能呼叫 remove_booking_assistant');
select ok(has_function_privilege('authenticated', 'public.remove_booking_assistant(uuid, uuid)', 'execute'),
  '權限:authenticated 可以呼叫 remove_booking_assistant(函式內部再用 can_manage_bookings 擋)');
select ok(not exists (
    select 1 from pg_proc p, aclexplode(p.proacl) a
    where p.oid = 'public.remove_booking_assistant(uuid, uuid)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  '權限:PUBLIC 沒有 remove_booking_assistant 的 EXECUTE');
select ok(not has_function_privilege('authenticated', 'private.tg_merchant_staff_removed_drop_assistants()', 'execute'),
  '權限:trigger 函式 authenticated 不能呼叫');
select ok(not has_function_privilege('anon', 'private.tg_merchant_staff_removed_drop_assistants()', 'execute'),
  '權限:trigger 函式 anon 不能呼叫');

-- =========================================================================
-- #1 移除協助人員 ⇒ 訂單本身一個欄位都不動、只少一筆協助
-- =========================================================================
select pg_temp.booking_fp(:'t1_id'::uuid) as fp \gset before_t1_
select count(*) as n from public.booking_status_change_logs where booking_id = :'t1_id'::uuid \gset logs_t1_

select pg_temp.test_set_auth(:'user_admin');
select public.remove_booking_assistant(:'t1_id'::uuid, :'staff_b'::uuid) as r \gset rm1_
select pg_temp.test_clear_auth();

select is(pg_temp.booking_fp(:'t1_id'::uuid), :'before_t1_fp',
  '#1 移除協助人員 B 後,T1 整列(狀態 / 時間 / 金額 / 紅利 / 最後修改)完全沒變');
select is((select status from public.bookings where id = :'t1_id'::uuid), 'pending_confirmation',
  '#1 T1 仍是待確認(沒有被取消)');
select is(pg_temp.assistant_count(:'t1_id'::uuid), 1, '#1 T1 協助人員從 2 位變 1 位');
select ok(not pg_temp.has_assistant(:'t1_id'::uuid, :'staff_b'::uuid), '#1 被移除的是 B');
select ok(pg_temp.has_assistant(:'t1_id'::uuid, :'staff_c'::uuid), '#1 另一位協助人員 C 還在');
select is((select count(*) from public.booking_status_change_logs where booking_id = :'t1_id'::uuid), :'logs_t1_n'::bigint,
  '#1 沒有多寫任何一筆狀態變更紀錄(訂單狀態沒變)');
select is((:'rm1_r'::jsonb) ->> 'removed_staff_name', '服務人員B', '#1 回傳被移除的協助人員姓名');
select is((:'rm1_r'::jsonb) ->> 'primary_staff_name', '服務人員A', '#1 回傳主服務人員姓名');
select is(((:'rm1_r'::jsonb) ->> 'remaining_assistant_count')::int, 1, '#1 回傳剩下幾位協助人員');

-- 服務人員端(規格書一-4):被移除的 B 自己的行事曆不再有 T1;主服務人員 A 的還在。
select pg_temp.test_set_auth(:'user_staff_b');
select ok(not exists (
    select 1 from jsonb_array_elements(get_my_booking_schedule(:'staff_b'::uuid, '2026-10-06', '2026-10-06')) e
    where (e ->> 'id')::uuid = :'t1_id'::uuid),
  '#1 服務人員端:B 自己的行事曆不再顯示 T1');
select ok(exists (
    select 1 from jsonb_array_elements(get_my_booking_schedule(:'staff_b'::uuid, '2026-10-06', '2026-10-06')) e
    where (e ->> 'id')::uuid = :'t2_id'::uuid),
  '#1 服務人員端(正向對照):B 在 T2 的協助還在');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth(:'user_staff_a');
select ok(exists (
    select 1 from jsonb_array_elements(get_my_booking_schedule(:'staff_a'::uuid, '2026-10-06', '2026-10-06')) e
    where (e ->> 'id')::uuid = :'t1_id'::uuid),
  '#1 服務人員端:主服務人員 A 的行事曆 T1 還在');
select pg_temp.test_clear_auth();
-- 即時同步(#874)的訊號不在這裡驗:發送端「同一筆交易內去重」,pgTAP 整支檔案是同一筆交易,
-- B 在建 T1 時已經收過一則 ⇒ 這裡永遠不會再多一則。booking_assistants DELETE → 通知那位助手的行為
-- 由 module14_07(#888)與 e2e-local/staff-schedule-live-sync.spec.ts 負責。

-- 行事曆:B 那一欄不再有 T1 的協助卡;A 那一欄的主卡還在;C 的協助卡還在。
select pg_temp.test_set_auth(:'user_admin');
select public.get_merchant_day_schedule(:'merchant_m'::uuid, '2026-10-06') as s \gset cal1_
select pg_temp.test_clear_auth();
select ok(not pg_temp.calendar_has(:'cal1_s'::jsonb, :'staff_b'::uuid, :'t1_id'::uuid, 'assistant'),
  '#1 行事曆:B 那一欄不再顯示 T1 的(協助)卡');
select ok(pg_temp.calendar_has(:'cal1_s'::jsonb, :'staff_a'::uuid, :'t1_id'::uuid, 'main'),
  '#1 行事曆:主服務人員 A 那一欄的 T1 還在');
select ok(pg_temp.calendar_has(:'cal1_s'::jsonb, :'staff_c'::uuid, :'t1_id'::uuid, 'assistant'),
  '#1 行事曆:C 的(協助)卡還在');

-- =========================================================================
-- #2 重複移除 / 拿主服務人員來移除 / 狀態不對
-- =========================================================================
select pg_temp.test_set_auth(:'user_admin');
select throws_ok(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t1_id', :'staff_b'),
  '40001', null, '#2 B 已經不在單上 → 40001(畫面過期)');
select throws_like(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t1_id', :'staff_a'),
  '%主服務人員%', '#2 拿主服務人員 A 來移除 → 擋下');
select throws_like(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t3_id', :'staff_b'),
  '%已完成或已取消%', '#2 已完成的單不能移除協助人員');
select pg_temp.test_clear_auth();
select is(pg_temp.assistant_count(:'t3_id'::uuid), 1, '#2 已完成的 T3 協助人員沒被動');
select is(pg_temp.assistant_count(:'t1_id'::uuid), 1, '#2 擋下之後 T1 協助人員仍是 1 位');

-- =========================================================================
-- #3 權限:沒權限的客服、別家商家管理員、anon 都不能移除
-- =========================================================================
select pg_temp.booking_fp(:'t1_id'::uuid) as fp \gset before3_t1_

select pg_temp.test_set_auth(:'user_none');
select throws_ok(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t1_id', :'staff_c'),
  '42501', null, '#3 沒有 orders 權限的客服 → 42501');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth(:'user_admin2');
select throws_ok(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t1_id', :'staff_c'),
  '42501', null, '#3 別家商家的管理員 → 42501(不能移除他店協助人員)');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('00000000-0000-0000-0000-000000000000', 'anon');
select throws_ok(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t1_id', :'staff_c'),
  '42501', null, '#3 anon → 沒有 EXECUTE 權限');
select pg_temp.test_clear_auth();

select ok(pg_temp.has_assistant(:'t1_id'::uuid, :'staff_c'::uuid), '#3 三次被擋之後 C 仍在 T1 上');
select is(pg_temp.booking_fp(:'t1_id'::uuid), :'before3_t1_fp', '#3 T1 整列沒變');

-- 有 orders 權限的客服可以移除。
select pg_temp.test_set_auth(:'user_orders');
select lives_ok(
  format('select public.remove_booking_assistant(%L::uuid, %L::uuid)', :'t1_id', :'staff_c'),
  '#3 有 orders 權限的客服可以移除協助人員');
select pg_temp.test_clear_auth();
select is(pg_temp.assistant_count(:'t1_id'::uuid), 0, '#3 T1 協助人員全部移除後是 0 位');
select is((select status from public.bookings where id = :'t1_id'::uuid), 'pending_confirmation',
  '#3 協助人員全部移除後 T1 仍是待確認(主服務人員的單還在)');

-- =========================================================================
-- #4 取消訂單 ⇒ 協助卡跟著消失(商家端行事曆)
-- =========================================================================
select pg_temp.test_set_auth(:'user_admin');
select public.get_merchant_day_schedule(:'merchant_m'::uuid, '2026-10-06') as s \gset cal4a_
select cancel_booking(:'t2_id'::uuid);
select public.get_merchant_day_schedule(:'merchant_m'::uuid, '2026-10-06') as s \gset cal4b_
select pg_temp.test_clear_auth();
select ok(pg_temp.calendar_has(:'cal4a_s'::jsonb, :'staff_b'::uuid, :'t2_id'::uuid, 'assistant'),
  '#4 前提:取消前 B 那一欄有 T2 的(協助)卡');
select ok(not pg_temp.calendar_has(:'cal4b_s'::jsonb, :'staff_b'::uuid, :'t2_id'::uuid, 'assistant'),
  '#4 取消訂單後 B 那一欄的(協助)卡消失');
select ok(not pg_temp.calendar_has(:'cal4b_s'::jsonb, :'staff_a'::uuid, :'t2_id'::uuid, 'main'),
  '#4 取消訂單後 A 那一欄的主卡也消失');

-- =========================================================================
-- #5 主服務人員被移除(merchant_staff.status → removed,真實路徑是商家管理員直接 update)
-- =========================================================================
select pg_temp.test_set_auth(:'user_admin');
select public.get_merchant_day_schedule(:'merchant_m'::uuid, '2026-10-06') as s \gset cal5a_
select pg_temp.test_clear_auth();
select ok(pg_temp.calendar_has(:'cal5a_s'::jsonb, :'staff_q'::uuid, :'t4_id'::uuid, 'assistant'),
  '#5 前提:P 被移除前 Q 那一欄有 T4 的(協助)卡');

select pg_temp.booking_fp(:'t4_id'::uuid) as fp \gset before5_t4_

select pg_temp.test_set_auth(:'user_admin');
update public.merchant_staff set status = 'removed' where id = :'staff_p'::uuid;
select public.get_merchant_day_schedule(:'merchant_m'::uuid, '2026-10-06') as s \gset cal5b_
select pg_temp.test_clear_auth();

select is((select status from public.merchant_staff where id = :'staff_p'::uuid), 'removed', '#5 前提:P 已移除');
select is(pg_temp.assistant_count(:'t4_id'::uuid), 0, '#5 P 當主的待確認單 T4:協助人員 Q 一併移除');
select is(pg_temp.assistant_count(:'t7_id'::uuid), 0, '#5 P 當主的已確認單 T7:協助人員 Q 一併移除');
select is(pg_temp.assistant_count(:'t5_id'::uuid), 1, '#5 P 當主的**已完成**單 T5:協助人員不動(歷史 / 抽成)');
select ok(pg_temp.has_assistant(:'t6_id'::uuid, :'staff_p'::uuid), '#5 P 當**協助**的 T6 不在這條規則範圍內,不動');
select is(pg_temp.booking_fp(:'t4_id'::uuid), :'before5_t4_fp', '#5 T4 訂單本身沒變(只刪協助關聯)');
select ok(not pg_temp.calendar_has(:'cal5b_s'::jsonb, :'staff_q'::uuid, :'t4_id'::uuid, 'assistant'),
  '#5 行事曆:Q 那一欄不再殘留 T4 的(協助)卡');
select ok(not pg_temp.calendar_has(:'cal5b_s'::jsonb, :'staff_q'::uuid, :'t7_id'::uuid, 'assistant'),
  '#5 行事曆:Q 那一欄不再殘留 T7 的(協助)卡');

-- 恢復 P 不會把 Q 加回來;再 update 成 removed(沒變)也不會出錯。
update public.merchant_staff set status = 'active' where id = :'staff_p'::uuid;
select is(pg_temp.assistant_count(:'t4_id'::uuid), 0, '#5 恢復 P 不會把協助人員加回來');

-- =========================================================================
-- #6 改派主服務人員(訂單仍有效)⇒ 協助人員保留(規格書一-3 子項)
-- =========================================================================
select pg_temp.test_set_auth(:'user_admin');
select public.move_booking(
  :'t8_id'::uuid, :'staff_a'::uuid, :'staff_c'::uuid,
  '2026-10-06 06:00:00+08', '2026-10-06 06:00:00+08', :'staff_a'::uuid
) is not null as moved \gset
select pg_temp.test_clear_auth();
select is((select staff_id from public.bookings where id = :'t8_id'::uuid), :'staff_c'::uuid, '#6 T8 主服務人員改成 C');
select ok(pg_temp.has_assistant(:'t8_id'::uuid, :'staff_b'::uuid), '#6 改派主服務人員後協助人員 B 保留');

select * from finish();
rollback;
