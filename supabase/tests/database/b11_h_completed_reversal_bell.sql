-- SPECS-INDEX #997 第 11 批 H:已完成訂單被取消 / 被還原 ⇒ 站內鈴鐺給其他管理員與有訂單管理權限的在職客服
-- migration 20261007140500_b11_h_completed_reversal_bell.sql;規格 .project/specs/改掛會員與預設文案全形-第11批.md §15.7
--
-- Fixture(一店):管理員 A(操作者)、管理員 B;客服 C(orders)、D(沒有 orders)、E(orders 但已移除)、
--   F(orders、跟 B 同一個帳號);1 位已開通登入的服務人員 S。二店:管理員 X(跨商家,不該收到)。
-- 【故障注入(engineer 回報有記錄,做完已還原)】
--   ① 管理員段拿掉「排除操作者本人」⇒ 1-2 轉紅;② 客服段拿掉「不是同店管理員」⇒ 1-4 轉紅;
--   ③ 鈴鐺寫進引擎而不是包裝 ⇒ req987_03 與本檔 9-1 轉紅。
begin;

select plan(37);

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
  ('b1170000-0000-4000-8000-000000000001', 'pgtap-b11h-adminA@test.local'),
  ('b1170000-0000-4000-8000-000000000002', 'pgtap-b11h-adminB@test.local'),
  ('b1170000-0000-4000-8000-000000000003', 'pgtap-b11h-agentC@test.local'),
  ('b1170000-0000-4000-8000-000000000004', 'pgtap-b11h-agentD@test.local'),
  ('b1170000-0000-4000-8000-000000000005', 'pgtap-b11h-agentE@test.local'),
  ('b1170000-0000-4000-8000-000000000006', 'pgtap-b11h-staffS@test.local'),
  ('b1170000-0000-4000-8000-000000000007', 'pgtap-b11h-adminX@test.local');

insert into groups (id) values
  ('b1170000-0000-4000-8000-000000000011'),
  ('b1170000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000011', '#997 H 一店', 'in_store_beauty'),
  ('b1170000-0000-4000-8000-000000000022', 'b1170000-0000-4000-8000-000000000012', '#997 H 二店', 'in_store_beauty');
insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('b1170000-0000-4000-8000-000000000025', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000001', '管理員甲'),
  ('b1170000-0000-4000-8000-000000000026', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000002', '管理員乙'),
  ('b1170000-0000-4000-8000-000000000027', 'b1170000-0000-4000-8000-000000000022', 'b1170000-0000-4000-8000-000000000007', '二店管理員');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('b1170000-0000-4000-8000-000000000033', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000003', '客服C', 'pgtap-b11h-agentC@test.local', 'active', now(), '0900997133'),
  ('b1170000-0000-4000-8000-000000000034', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000004', '客服D', 'pgtap-b11h-agentD@test.local', 'active', now(), '0900997134'),
  ('b1170000-0000-4000-8000-000000000035', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000005', '客服E', 'pgtap-b11h-agentE@test.local', 'removed', now(), '0900997135'),
  ('b1170000-0000-4000-8000-000000000036', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000002', '客服F兼管理員乙', 'pgtap-b11h-adminB@test.local', 'active', now(), '0900997136');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('b1170000-0000-4000-8000-000000000033', 'orders', true),
  ('b1170000-0000-4000-8000-000000000034', 'service_items', true),
  ('b1170000-0000-4000-8000-000000000035', 'orders', true),
  ('b1170000-0000-4000-8000-000000000036', 'orders', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('b1170000-0000-4000-8000-000000000040', 'b1170000-0000-4000-8000-000000000021', '洗髮', 500, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('b1170000-0000-4000-8000-000000000050', 'b1170000-0000-4000-8000-000000000021', '現金');
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('b1170000-0000-4000-8000-000000000060', 'b1170000-0000-4000-8000-000000000021', 'b1170000-0000-4000-8000-000000000006', '服務人員S', 'piece_rate', 'active', 'active', now(), '0900997160');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('b1170000-0000-4000-8000-000000000060', 'staff_calendar_view', true);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'b1170000-0000-4000-8000-000000000060', d::smallint, '00:00', '24:00' from generate_series(0, 6) d;
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'b1170000-0000-4000-8000-000000000021', d, false, '00:00', '23:59' from generate_series(0, 6) d;

create sequence pg_temp.b11hseq;
grant usage on sequence pg_temp.b11hseq to authenticated;

-- 建一張「已完成」訂單(A 建立 → 確認 → 完成);每張日子往後一天:第 n 張 = 2027/03/(1+n) 10:00(台北)。
create function pg_temp.b11h_done(p_name text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from public.create_booking(
    p_merchant_id => 'b1170000-0000-4000-8000-000000000021',
    p_staff_id => 'b1170000-0000-4000-8000-000000000060',
    p_service_items => jsonb_build_array(jsonb_build_object(
      'service_item_id', 'b1170000-0000-4000-8000-000000000040', 'quantity', 1, 'unit_price', 500)),
    p_start_at => timestamptz '2027-03-01 10:00:00+08' + make_interval(days => nextval('pg_temp.b11hseq')::int),
    p_customer_name => p_name,
    p_customer_phone => '0955997100',
    p_customer_address => '台北市保密路 9 號',
    p_payment_method_id => 'b1170000-0000-4000-8000-000000000050'
  );
  perform public.confirm_booking(v_id);
  perform public.complete_booking(v_id);
  return v_id;
end;
$$;
grant execute on function pg_temp.b11h_done(text) to authenticated;

-- 收件人清單(target_type:target_id),依 target_id 排序
create function pg_temp.b11h_targets(p_booking uuid, p_event text)
returns text[] language sql as $$
  select coalesce(array_agg(target_type || ':' || target_id::text order by target_id::text), array[]::text[])
  from public.user_notifications where booking_id = p_booking and event_type = p_event;
$$;

select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000001');
select pg_temp.b11h_done('客戶一號') as id \gset b1_
select pg_temp.b11h_done('客戶二號') as id \gset b2_
select pg_temp.b11h_done('客戶三號') as id \gset b3_
select pg_temp.b11h_done('客戶四號') as id \gset b4_
select pg_temp.b11h_done('匯入五號') as id \gset b5_
select pg_temp.b11h_done('匯入六號') as id \gset b6_
select pg_temp.b11h_done('客戶七號') as id \gset b7_
select pg_temp.test_clear_auth();

update bookings set source = 'import' where id in (:'b5_id'::uuid, :'b6_id'::uuid);
delete from booking_commission_records where booking_id in (:'b5_id'::uuid, :'b6_id'::uuid);
-- 客戶名空白 ⇒ 內文寫「未填姓名」(b3)
update bookings set customer_name = '  ' where id = :'b3_id'::uuid;

-- 先清掉建單 / 確認 / 完成過程中可能寫入的鈴鐺,之後只看本項的新列
delete from user_notifications where merchant_id = 'b1170000-0000-4000-8000-000000000021';

-- =========================================================================
-- 1. A 還原 b1 ⇒ B、C 各 1 列;A、D、E、服務人員、二店 0 列;B 帳號只 1 列(F 不重寫)
-- =========================================================================
select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000001');
select public.revert_completed_booking(:'b1_id'::uuid, E'客戶打錯\n要改時間\t再說') ->> 'action' as a \gset rv1_
select pg_temp.test_clear_auth();

select is(
  pg_temp.b11h_targets(:'b1_id'::uuid, 'booking_completed_reverted'),
  array['admin:b1170000-0000-4000-8000-000000000026', 'agent:b1170000-0000-4000-8000-000000000033'],
  '1-1 還原:管理員 B(admin)與客服 C(agent)各收到一則'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b1_id'::uuid and user_id = 'b1170000-0000-4000-8000-000000000001'),
  0, '1-2 操作者本人 A 不收'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b1_id'::uuid
     and user_id in ('b1170000-0000-4000-8000-000000000004', 'b1170000-0000-4000-8000-000000000005')),
  0, '1-3 沒有 orders 的客服 D、已移除的客服 E 不收'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b1_id'::uuid and user_id = 'b1170000-0000-4000-8000-000000000002'),
  1, '1-4 B 同時是 orders 客服 F ⇒ 只收一則(以管理員身分)'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b1_id'::uuid
     and (target_type = 'staff' or user_id = 'b1170000-0000-4000-8000-000000000006')),
  0, '1-5 服務人員不收'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b1_id'::uuid
     and (user_id = 'b1170000-0000-4000-8000-000000000007' or merchant_id <> 'b1170000-0000-4000-8000-000000000021')),
  0, '1-6 別店管理員不收;每列 merchant_id 都是本店'
);

-- =========================================================================
-- 2. 標題 / 內文逐字
-- =========================================================================
select is(
  (select array_agg(distinct title) from user_notifications where booking_id = :'b1_id'::uuid),
  array['已完成訂單被還原'], '2-1 還原標題'
);
select is(
  (select array_agg(distinct body) from user_notifications where booking_id = :'b1_id'::uuid),
  array['管理員甲 將 2027/03/02 10:00「客戶一號」的已完成訂單還原為已確認。原因：客戶打錯 要改時間 再說'],
  '2-2 還原內文:姓名、台北時間、客戶名、原因(換行 / tab 變一個空白)'
);
select ok(
  (select bool_and(body not like '%0955997100%' and body not like '%保密路%' and body not like '%500%')
   from user_notifications where booking_id = :'b1_id'::uuid),
  '2-3 內文不含電話 / 地址 / 金額'
);
select is(:'rv1_a'::text, 'revert_to_accepted'::text, '2-4 還原回傳值照舊(引擎結果原樣回傳)');

-- =========================================================================
-- 3. A 取消 b2(通知開關關)、b3(開關開)⇒ 一樣發
-- =========================================================================
select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000001');
select public.cancel_completed_booking(:'b2_id'::uuid, repeat('一', 59) || '二三', false) ->> 'action' as a \gset cc2_
select public.cancel_completed_booking(:'b3_id'::uuid, '客人不要了', true) ->> 'action' as a \gset cc3_
select pg_temp.test_clear_auth();

select is(
  pg_temp.b11h_targets(:'b2_id'::uuid, 'booking_completed_cancelled'),
  array['admin:b1170000-0000-4000-8000-000000000026', 'agent:b1170000-0000-4000-8000-000000000033'],
  '3-1 取消(開關關):B、C 各一則'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b2_id'::uuid),
  2, '3-2 取消(開關關):總共只有兩則(A、D、E、服務人員都沒有)'
);
select is(
  (select array_agg(distinct title) from user_notifications where booking_id = :'b2_id'::uuid),
  array['已完成訂單被取消'], '3-3 取消標題'
);
select is(
  (select array_agg(distinct body) from user_notifications where booking_id = :'b2_id'::uuid),
  array['管理員甲 將 2027/03/03 10:00「客戶二號」的已完成訂單取消。原因：' || repeat('一', 59) || '二三'],
  '3-4 取消內文:61 字原因 ⇒ 完整寫入(第 21 批 #1019 起不再截到 60 字;原本是前 60 字 + …)'
);
select is(
  pg_temp.b11h_targets(:'b3_id'::uuid, 'booking_completed_cancelled'),
  array['admin:b1170000-0000-4000-8000-000000000026', 'agent:b1170000-0000-4000-8000-000000000033'],
  '3-5 取消(開關開):一樣是 B、C 各一則'
);
select is(
  (select count(*)::int from user_notifications where booking_id = :'b3_id'::uuid and event_type <> 'booking_completed_cancelled'),
  0, '3-6 資料庫不寫 booking_cancelled(那則由前端推播另發)'
);
select is(
  (select array_agg(distinct body) from user_notifications where booking_id = :'b3_id'::uuid),
  array['管理員甲 將 2027/03/04 10:00「未填姓名」的已完成訂單取消。原因：客人不要了'],
  '3-7 客戶名空白 ⇒「未填姓名」'
);

-- =========================================================================
-- 4. 客服 C 呼叫 ⇒ 42501,沒有新增
-- =========================================================================
select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000003');
select throws_ok(format($$select public.revert_completed_booking(%L, '客服亂按')$$, :'b4_id'), '42501', NULL,
  '4-1 客服還原 ⇒ 42501');
select throws_ok(format($$select public.cancel_completed_booking(%L, '客服亂按', false)$$, :'b4_id'), '42501', NULL,
  '4-2 客服取消 ⇒ 42501');
select pg_temp.test_clear_auth();
select is((select count(*)::int from user_notifications where booking_id = :'b4_id'::uuid), 0, '4-3 客服被擋 ⇒ 沒有鈴鐺');

-- =========================================================================
-- 5. 第二次還原(狀態已改)⇒ 原錯誤,沒有新增
-- =========================================================================
select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000001');
select throws_ok(format($$select public.revert_completed_booking(%L, '再按一次')$$, :'b1_id'), 'P0001',
  '這筆訂單的狀態已經改變，請重新整理後再試', '5-1 第二次還原 ⇒ 原錯誤');
select throws_ok(format($$select public.cancel_completed_booking(%L, '再取消', false)$$, :'b2_id'), 'P0001',
  '這筆訂單的狀態已經改變，請重新整理後再試', '5-2 第二次取消 ⇒ 原錯誤');
select pg_temp.test_clear_auth();
select is((select count(*)::int from user_notifications where booking_id = :'b1_id'::uuid), 2, '5-3 b1 仍只有兩則');
select is((select count(*)::int from user_notifications where booking_id = :'b2_id'::uuid), 2, '5-4 b2 仍只有兩則');

-- =========================================================================
-- 6. 匯入單:取消正常發;還原原錯誤、沒有新增
-- =========================================================================
select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000001');
select public.cancel_completed_booking(:'b5_id'::uuid, '匯錯了', false) ->> 'action' as a \gset cc5_
select throws_ok(format($$select public.revert_completed_booking(%L, '想還原匯入單')$$, :'b6_id'), 'P0001',
  '匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入', '6-1 匯入單還原 ⇒ 原錯誤');
select pg_temp.test_clear_auth();
select is(
  pg_temp.b11h_targets(:'b5_id'::uuid, 'booking_completed_cancelled'),
  array['admin:b1170000-0000-4000-8000-000000000026', 'agent:b1170000-0000-4000-8000-000000000033'],
  '6-2 匯入單取消 ⇒ 正常發'
);
select is((select count(*)::int from user_notifications where booking_id = :'b6_id'::uuid), 0, '6-3 匯入單還原被擋 ⇒ 沒有鈴鐺');

-- =========================================================================
-- 7. 回滾:讓 helper 失敗(CHECK 暫時改回不含新值)⇒ 整筆回滾
-- =========================================================================
alter table public.user_notifications drop constraint user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check check (
  event_type in ('booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day', 'booking_confirmed')) not valid;  -- not valid:測試前面寫的新事件列不擋,新寫入照樣擋
select pg_temp.test_set_auth('b1170000-0000-4000-8000-000000000001');
select throws_ok(format($$select public.revert_completed_booking(%L, '要失敗')$$, :'b7_id'), '23514', NULL,
  '7-1 鈴鐺寫入失敗 ⇒ 還原整筆失敗');
select pg_temp.test_clear_auth();
alter table public.user_notifications drop constraint user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check check (
  event_type in ('booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day', 'booking_confirmed',
                 'booking_completed_cancelled', 'booking_completed_reverted'));
select is((select status from bookings where id = :'b7_id'::uuid), 'completed', '7-2 回滾後訂單仍是 completed');
select is((select count(*)::int from booking_completion_reversals where booking_id = :'b7_id'::uuid), 0, '7-3 回滾後稽核表沒有新列');

-- =========================================================================
-- 8. ACL / CHECK
-- =========================================================================
select ok(not has_function_privilege('anon', 'private.notify_completed_booking_reversal(uuid)', 'execute'),
  '8-1 anon 對 helper 沒有 EXECUTE');
select ok(not has_function_privilege('authenticated', 'private.notify_completed_booking_reversal(uuid)', 'execute'),
  '8-2 authenticated 對 helper 沒有 EXECUTE');
select is(
  (select array[prosecdef::text, coalesce(proconfig::text, 'NULL'), coalesce(proacl::text, 'NULL')]
   from pg_proc where oid = 'private.notify_completed_booking_reversal(uuid)'::regprocedure),
  array['true', '{search_path=public}', '{postgres=X/postgres}'],
  '8-3 helper:security definer、search_path=public、只有 postgres 能執行(service_role 也沒有)'
);
select is(
  (select array[array_to_string(proacl, ' '), prosecdef::text, proconfig::text]
   from pg_proc where oid = 'public.revert_completed_booking(uuid, text)'::regprocedure),
  array['postgres=X/postgres authenticated=X/postgres service_role=X/postgres', 'true', '{search_path=public}'],
  '8-4 revert_completed_booking:anon 沒有、authenticated / service_role 有;security definer、search_path 不變'
);
select is(
  (select array[array_to_string(proacl, ' '), prosecdef::text, proconfig::text]
   from pg_proc where oid = 'public.cancel_completed_booking(uuid, text, boolean)'::regprocedure),
  array['postgres=X/postgres authenticated=X/postgres service_role=X/postgres', 'true', '{search_path=public}'],
  '8-5 cancel_completed_booking:anon 沒有、authenticated / service_role 有;security definer、search_path 不變'
);
select is(
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'user_notifications_event_type_check'),
  $c$CHECK ((event_type = ANY (ARRAY['booking_created'::text, 'booking_cancelled'::text, 'booking_updated'::text, 'booking_reminder_next_day'::text, 'booking_confirmed'::text, 'booking_completed_cancelled'::text, 'booking_completed_reverted'::text])))$c$,
  '8-6 CHECK 剛好 7 個值(仍不收 test)'
);

-- =========================================================================
-- 9. 引擎沒動
-- =========================================================================
select is(
  (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
   where oid = 'private.reverse_booking_completion(uuid, text, text, boolean)'::regprocedure),
  'b5499e10fd2524dc96b032fb8829210d',
  '9-1 private.reverse_booking_completion 指紋 = 動工前正式庫實查值(引擎一字不改)'
);

select * from finish();
rollback;
