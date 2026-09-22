-- 建單與訂單管理介面優化 §十 10.1-10.4(SPECS-INDEX #620):merchant_booking_status_colors
-- 資料表/預設值/種子函式/權限/update_merchant_booking_status_colors。
begin;

select plan(13);

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

insert into auth.users (id, email) values
  ('c9000000-0000-4000-8000-000000000001', 'pgtap-m6i-admin1@test.local'),
  ('c9000000-0000-4000-8000-000000000002', 'pgtap-m6i-admin2@test.local'),
  ('c9000000-0000-4000-8000-000000000003', 'pgtap-m6i-agent-orders@test.local'),
  ('c9000000-0000-4000-8000-000000000004', 'pgtap-m6i-agent-none@test.local');

insert into groups (id) values
  ('c9000000-0000-4000-8000-000000000011'),
  ('c9000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000011', '顏色設定測試一店', 'in_store_beauty'),
  ('c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000012', '顏色設定測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000001'),
  ('c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c9000000-0000-4000-8000-000000000031', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000003', '客服-orders', 'pgtap-m6i-agent-orders@test.local', 'active', now(), '0900000301'),
  ('c9000000-0000-4000-8000-000000000032', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000004', '客服-無授權', 'pgtap-m6i-agent-none@test.local', 'active', now(), '0900000302');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c9000000-0000-4000-8000-000000000031', 'orders', true);

-- =========================================================================
-- ① §10.1:查無資料時,查詢回傳 0 筆(前端 fallback 成 DEFAULT_BOOKING_STATUS_COLORS)。
-- =========================================================================
select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  0,
  '§10.1:商家還沒特別設定過顏色時,merchant_booking_status_colors 查無資料'
);

-- =========================================================================
-- ② §10.1:資料表 DEFAULT 值是實際量測後的真實色碼(對照 migration 註解記錄的來源)。
-- seed_default_booking_status_colors 只 grant 給 service_role/postgres(§10.2),pgTAP 測試檔案
-- 本身就是用 postgres 連線,直接呼叫不需要額外 test_set_auth。
-- =========================================================================
select lives_ok(
  $$select seed_default_booking_status_colors('c9000000-0000-4000-8000-000000000021')$$,
  '§10.2:seed_default_booking_status_colors(postgres 角色)執行成功'
);

select is(
  (select pending_confirmation_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#ebaa2d',
  '§10.1:pending_confirmation 預設色碼是實測值 #ebaa2d(對應 warn token)'
);

select is(
  (select accepted_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#1c6fd2',
  '§10.1:accepted 預設色碼是實測值 #1c6fd2(對應 brand token)'
);

select is(
  (select completed_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#1ea25d',
  '§10.1:completed 預設色碼是實測值 #1ea25d(對應 cta token)'
);

select is(
  (select cancelled_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#606d7f',
  '§10.1:cancelled 預設色碼是實測值 #606d7f(對應 muted-foreground token)'
);

-- 冪等:重複呼叫不會產生第二筆,也不會覆蓋(這裡先手動改一個值,再呼叫一次 seed,確認值不被蓋回預設)。
update merchant_booking_status_colors set completed_color = '#123456' where merchant_id = 'c9000000-0000-4000-8000-000000000021';
select seed_default_booking_status_colors('c9000000-0000-4000-8000-000000000021');

select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  1,
  '§10.2:重複呼叫 seed_default_booking_status_colors 不會產生第二筆'
);

select is(
  (select completed_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#123456',
  '§10.2:重複呼叫 seed_default_booking_status_colors 不會覆蓋商家已經自訂過的顏色(on conflict do nothing)'
);

-- =========================================================================
-- ③ §10.2:新商家建立時(create_group_and_merchant)自動種好一筆。
-- =========================================================================
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select create_group_and_merchant('顏色設定自動種子測試店', 'in_store_beauty') \gset new_merchant_

select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = :'new_merchant_create_group_and_merchant'::uuid),
  1,
  '§10.2:create_group_and_merchant 建立新商家時自動種入一筆 merchant_booking_status_colors'
);

-- =========================================================================
-- ④ §10.3/§10.4:權限——update_merchant_booking_status_colors。
-- =========================================================================
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000004');

select throws_ok(
  $$select update_merchant_booking_status_colors(
    'c9000000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#444444'
  )$$,
  '42501', null,
  '§10.3/§10.4:沒有 orders 權限的客服不能修改訂單狀態顏色'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select lives_ok(
  $$select update_merchant_booking_status_colors(
    'c9000000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#444444'
  )$$,
  '§10.3/§10.4:被授權 orders 的客服可以修改訂單狀態顏色'
);

select is(
  (select completed_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#333333',
  '§10.4:update_merchant_booking_status_colors 正確 upsert 新的顏色值'
);

select pg_temp.test_clear_auth();

-- §10.3:SELECT 開放給任何看得到訂單的人(private.can_manage_bookings),被授權 orders 的客服
-- 應該讀得到目前的顏色設定(即使不是自己改的)。
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  1,
  '§10.3:被授權 orders 的客服可以 SELECT 到訂單狀態顏色設定'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
