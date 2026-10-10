-- SPECS-INDEX #1025 功能開關 第 1 批 FG1-T02:三個功能的擋住點(資料庫端,T6)
-- 規格書 .project/specs/功能開關.md(第 2 版)FG1-F01、FG1-F02、FG1-T02。
-- migration 20261010150100_req1025_fg1_feature_gates.sql
--
--   ①  online_booking 關 ⇒ get_public_booking_page / get_public_available_slots / internal_customer_submit_booking
--      回應跟「商家停用」逐字相同(errcode / 訊息 / hint / 回傳 json);打開 ⇒ 不再擋
--   ②  report_export 關 ⇒ 三支 export_* 與 list_report_export_staff 被擋(管理員也一樣);
--      get_staff_commission_summary 的 report_export 分支也關(只有匯出權限的客服被擋;
--      管理員走「服務人員報表」權限照常可看 —— off_impact:畫面上的服務人員報表照常);打開 ⇒ 恢復
--   ③  data_import 關 ⇒ 兩支匯入函式 42501 / feature_disabled / 「這個功能目前沒有開放。」;
--      rollback_bulk_operation、get_merchant_bulk_operations 照常;打開 ⇒ 恢復
--   (打開時原本的 c1、c3、module12、req976 pgTAP 全部照過 ⇒ 行為不變,不在這裡重複)
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

set local client_min_messages = warning;
select plan(25);

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

-- 執行一段 SQL,回傳「result:結果」或「sqlstate|訊息|hint」—— 用來逐字比對兩種情況的回應。
create function pg_temp.try(p_sql text)
returns text language plpgsql as $$
declare
  v text;
  v_state text;
  v_msg text;
  v_hint text;
begin
  execute p_sql into v;
  return 'result:' || coalesce(v, 'null');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_hint = pg_exception_hint;
  return v_state || '|' || v_msg || '|' || coalesce(v_hint, '');
end;
$$;

-- 平台開關(以超級管理員身分呼叫正式的 RPC,不直接改表)。
create function pg_temp.set_feature(p_merchant_id uuid, p_key text, p_enabled boolean)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'f1025200-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);
  perform public.platform_set_merchant_feature(p_merchant_id, p_key, p_enabled);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- ─── Fixture ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('f1025200-0000-4000-8000-000000000001', 'pgtap-1025b-platform@test.local'),
  ('f1025200-0000-4000-8000-000000000002', 'pgtap-1025b-admin-a@test.local'),
  ('f1025200-0000-4000-8000-000000000003', 'pgtap-1025b-agent-export@test.local');
insert into platform_admins (user_id) values ('f1025200-0000-4000-8000-000000000001');
insert into groups (id) values ('f1025200-0000-4000-8000-000000000011');
-- A 店:啟用中;D 店:已停用(拿來當「停用時」的對照組)
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('f1025200-0000-4000-8000-000000000021', 'f1025200-0000-4000-8000-000000000011', '擋住點A店', 'on_site_dispatch', 'pgtap-1025b-a', 'active'),
  ('f1025200-0000-4000-8000-000000000022', 'f1025200-0000-4000-8000-000000000011', '擋住點停用店', 'on_site_dispatch', 'pgtap-1025b-d', 'disabled');
select public.apply_industry_preset('f1025200-0000-4000-8000-000000000021');
select public.apply_industry_preset('f1025200-0000-4000-8000-000000000022');
insert into merchant_admins (merchant_id, user_id) values
  ('f1025200-0000-4000-8000-000000000021', 'f1025200-0000-4000-8000-000000000002');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('f1025200-0000-4000-8000-000000000031', 'f1025200-0000-4000-8000-000000000021', 'f1025200-0000-4000-8000-000000000003',
   '匯出客服', '0900102531', 'pgtap-1025b-agent-export@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f1025200-0000-4000-8000-000000000031', 'report_export', true);
insert into merchant_staff (id, merchant_id, name, compensation_type, status, phone) values
  ('f1025200-0000-4000-8000-000000000041', 'f1025200-0000-4000-8000-000000000021', '服務人員甲', 'piece_rate', 'active', '0900102541');

-- 停用店的三種回應(對照組)
select set_config('test.page_disabled',
  pg_temp.try($$select public.get_public_booking_page('pgtap-1025b-d')::text$$), true);
select set_config('test.slots_disabled',
  pg_temp.try($$select public.get_public_available_slots('pgtap-1025b-d', '[]'::jsonb, null, current_date, 1)::text$$), true);
select set_config('test.submit_disabled',
  pg_temp.try($$select public.internal_customer_submit_booking('pgtap-1025b-d', null, '0912000000', '{}'::jsonb, true,
                  'f1025200-0000-4000-8000-0000000000a1')::text$$), true);

-- ─── ① 客戶線上預約 ────────────────────────────────────────────────────────
select is(current_setting('test.page_disabled'), 'result:{"status": "unavailable"}',
  '①-0a 對照組:停用店的預約頁回 unavailable');
select is(current_setting('test.slots_disabled'), 'P0002|這間店目前暫停線上預約|page_unavailable',
  '①-0b 對照組:停用店查時段 ⇒ P0002 / 這間店目前暫停線上預約 / page_unavailable');
select is(current_setting('test.submit_disabled'), 'result:{"state": "unavailable"}',
  '①-0c 對照組:停用店送出預約 ⇒ state = unavailable');

select pg_temp.set_feature('f1025200-0000-4000-8000-000000000021', 'online_booking', false);
select is(pg_temp.try($$select public.get_public_booking_page('pgtap-1025b-a')::text$$),
  current_setting('test.page_disabled'),
  '①-1 線上預約關 ⇒ get_public_booking_page 回應跟停用店逐字相同');
select is(pg_temp.try($$select public.get_public_available_slots('pgtap-1025b-a', '[]'::jsonb, null, current_date, 1)::text$$),
  current_setting('test.slots_disabled'),
  '①-2 線上預約關 ⇒ get_public_available_slots 的 errcode / 訊息 / hint 跟停用店逐字相同');
select is(pg_temp.try($$select public.internal_customer_submit_booking('pgtap-1025b-a', null, '0912000000', '{}'::jsonb, true,
                         'f1025200-0000-4000-8000-0000000000a2')::text$$),
  current_setting('test.submit_disabled'),
  '①-3 線上預約關 ⇒ internal_customer_submit_booking 回應跟停用店逐字相同');
select is(
  (select count(*)::int from bookings where merchant_id = 'f1025200-0000-4000-8000-000000000021'),
  0, '①-4 線上預約關時沒有任何訂單被建立');

select pg_temp.set_feature('f1025200-0000-4000-8000-000000000021', 'online_booking', true);
select is((public.get_public_booking_page('pgtap-1025b-a') ->> 'status'), 'ok',
  '①-5 重新打開 ⇒ 預約頁回 ok');
select is(pg_temp.try($$select public.get_public_available_slots('pgtap-1025b-a', '[]'::jsonb, null, current_date, 0)::text$$),
  '22023|查詢的日期範圍不正確|invalid_range',
  '①-6 重新打開 ⇒ 查時段通過店家檢查、走到後面的參數檢查(不再是 page_unavailable)');
select isnt(pg_temp.try($$select public.internal_customer_submit_booking('pgtap-1025b-a', null, '0912000000', '{}'::jsonb, true,
                         'f1025200-0000-4000-8000-0000000000a3')::text$$),
  current_setting('test.submit_disabled'),
  '①-7 重新打開 ⇒ 送出預約不再回 unavailable(走到後面的資料檢查)');

-- 停用優先:停用店就算功能開著也照停用(邊界 4)
select is(
  (select enabled from merchant_feature_grants where merchant_id = 'f1025200-0000-4000-8000-000000000022' and feature_key = 'online_booking'),
  true, '①-8 停用店的線上預約功能是開的,但仍回停用畫面(停用優先,①-0a 已驗)');

-- ─── ② 報表匯出中心 ────────────────────────────────────────────────────────
select pg_temp.set_feature('f1025200-0000-4000-8000-000000000021', 'report_export', false);
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000002');
select throws_ok($$select public.export_orders_report('f1025200-0000-4000-8000-000000000021')$$,
  '42501', null, '②-1 報表匯出關 ⇒ 管理員 export_orders_report 被擋');
select throws_ok($$select public.export_members_report('f1025200-0000-4000-8000-000000000021')$$,
  '42501', null, '②-2 報表匯出關 ⇒ 管理員 export_members_report 被擋');
select throws_ok($$select public.export_leave_report('f1025200-0000-4000-8000-000000000021')$$,
  '42501', null, '②-3 報表匯出關 ⇒ 管理員 export_leave_report 被擋');
select throws_ok($$select public.list_report_export_staff('f1025200-0000-4000-8000-000000000021')$$,
  '42501', null, '②-4 報表匯出關 ⇒ 管理員 list_report_export_staff 被擋');
select lives_ok($$select public.get_staff_commission_summary('f1025200-0000-4000-8000-000000000041', 2026, 10)$$,
  '②-5 報表匯出關 ⇒ 管理員仍可看服務人員報表(走 staff_report,不是匯出權限)');
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000003');
select throws_ok($$select public.get_staff_commission_summary('f1025200-0000-4000-8000-000000000041', 2026, 10)$$,
  '42501', null, '②-6 報表匯出關 ⇒ 只有匯出權限的客服不能再用抽成報表');
select throws_ok($$select public.export_orders_report('f1025200-0000-4000-8000-000000000021')$$,
  '42501', null, '②-7 報表匯出關 ⇒ 有匯出權限的客服 export_orders_report 也被擋');
select pg_temp.test_clear_auth();

select pg_temp.set_feature('f1025200-0000-4000-8000-000000000021', 'report_export', true);
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000002');
select lives_ok(
  $$select public.export_orders_report('f1025200-0000-4000-8000-000000000021');
    select public.export_members_report('f1025200-0000-4000-8000-000000000021');
    select public.export_leave_report('f1025200-0000-4000-8000-000000000021');
    select public.list_report_export_staff('f1025200-0000-4000-8000-000000000021')$$,
  '②-8 重新打開 ⇒ 管理員四支都恢復');
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000003');
select lives_ok($$select public.get_staff_commission_summary('f1025200-0000-4000-8000-000000000041', 2026, 10)$$,
  '②-9 重新打開 ⇒ 匯出客服的抽成報表恢復');
select pg_temp.test_clear_auth();

-- ─── ③ 資料匯入 ────────────────────────────────────────────────────────────
-- 先在開著的時候匯一批,留給「關掉後復原照常」用。
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000002');
select set_config('test.op_id', public.import_members_batch(
  'f1025200-0000-4000-8000-000000000021', 'insert_only',
  jsonb_build_array(jsonb_build_object('row_number', 1, 'name', '匯入會員甲', 'phone', '0911102501')))::text, true);
select pg_temp.test_clear_auth();

select pg_temp.set_feature('f1025200-0000-4000-8000-000000000021', 'data_import', false);
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000002');
select is(pg_temp.try($$select public.import_members_batch('f1025200-0000-4000-8000-000000000021', 'insert_only', '[]'::jsonb)::text$$),
  '42501|這個功能目前沒有開放。|feature_disabled',
  '③-1 資料匯入關 ⇒ import_members_batch:42501 / 這個功能目前沒有開放。/ feature_disabled');
select is(pg_temp.try($$select public.import_historical_bookings_batch('f1025200-0000-4000-8000-000000000021', '[]'::jsonb)::text$$),
  '42501|這個功能目前沒有開放。|feature_disabled',
  '③-2 資料匯入關 ⇒ import_historical_bookings_batch 同一句');
select lives_ok($$select * from public.get_merchant_bulk_operations('f1025200-0000-4000-8000-000000000021')$$,
  '③-3 資料匯入關 ⇒ get_merchant_bulk_operations 資料庫端照常');
select lives_ok(format($$select public.rollback_bulk_operation(%L)$$, current_setting('test.op_id')),
  '③-4 資料匯入關 ⇒ rollback_bulk_operation 資料庫端照常(邊界 13)');
select pg_temp.test_clear_auth();

select pg_temp.set_feature('f1025200-0000-4000-8000-000000000021', 'data_import', true);
select pg_temp.test_set_auth('f1025200-0000-4000-8000-000000000002');
select lives_ok(
  $$select public.import_members_batch('f1025200-0000-4000-8000-000000000021', 'insert_only',
      jsonb_build_array(jsonb_build_object('row_number', 1, 'name', '匯入會員乙', 'phone', '0911102502')))$$,
  '③-5 重新打開 ⇒ 匯入恢復');
select pg_temp.test_clear_auth();

select * from finish();
rollback;
