-- SPECS-INDEX #1019(第 21 批):已完成訂單被取消 / 被還原的鈴鐺內文,原因完整寫入(不再截到 60 字)。
-- migration 20261008130000_req1019_completed_reversal_bell_full_reason.sql。
-- 走真的包裝函式(cancel_completed_booking / revert_completed_booking),由管理員甲操作、管理員乙收通知。
begin;

select plan(9);

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
  ('c1019000-0000-4000-8000-000000000001', 'pgtap-r1019-adminA@test.local'),
  ('c1019000-0000-4000-8000-000000000002', 'pgtap-r1019-adminB@test.local'),
  ('c1019000-0000-4000-8000-000000000006', 'pgtap-r1019-staffS@test.local');

insert into groups (id) values ('c1019000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values
  ('c1019000-0000-4000-8000-000000000021', 'c1019000-0000-4000-8000-000000000011', '#1019 原因完整店', 'in_store_beauty');
insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('c1019000-0000-4000-8000-000000000025', 'c1019000-0000-4000-8000-000000000021', 'c1019000-0000-4000-8000-000000000001', '管理員甲'),
  ('c1019000-0000-4000-8000-000000000026', 'c1019000-0000-4000-8000-000000000021', 'c1019000-0000-4000-8000-000000000002', '管理員乙');
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c1019000-0000-4000-8000-000000000040', 'c1019000-0000-4000-8000-000000000021', '洗髮', 500, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('c1019000-0000-4000-8000-000000000050', 'c1019000-0000-4000-8000-000000000021', '現金');
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('c1019000-0000-4000-8000-000000000060', 'c1019000-0000-4000-8000-000000000021', 'c1019000-0000-4000-8000-000000000006', '服務人員S', 'piece_rate', 'active', 'active', now(), '0900101960');
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'c1019000-0000-4000-8000-000000000060', d::smallint, '00:00', '24:00' from generate_series(0, 6) d;
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'c1019000-0000-4000-8000-000000000021', d, false, '00:00', '23:59' from generate_series(0, 6) d;

create sequence pg_temp.r1019seq;
grant usage on sequence pg_temp.r1019seq to authenticated;

create function pg_temp.r1019_done(p_name text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from public.create_booking(
    p_merchant_id => 'c1019000-0000-4000-8000-000000000021',
    p_staff_id => 'c1019000-0000-4000-8000-000000000060',
    p_service_items => jsonb_build_array(jsonb_build_object(
      'service_item_id', 'c1019000-0000-4000-8000-000000000040', 'quantity', 1, 'unit_price', 500)),
    p_start_at => timestamptz '2027-04-01 10:00:00+08' + make_interval(days => nextval('pg_temp.r1019seq')::int),
    p_customer_name => p_name,
    p_customer_phone => '0955101900',
    p_payment_method_id => 'c1019000-0000-4000-8000-000000000050'
  );
  perform public.confirm_booking(v_id);
  perform public.complete_booking(v_id);
  return v_id;
end;
$$;
grant execute on function pg_temp.r1019_done(text) to authenticated;

-- 500 字原因(上限剛好):前 10 字可辨識 + 490 個「長」+ 最後一字「尾」⇒ 被截的話一定看得出來。
create function pg_temp.r1019_reason_500() returns text language sql as $$
  select '這是很長的取消原因' || repeat('長', 490) || '尾';
$$;
grant execute on function pg_temp.r1019_reason_500() to authenticated;

select pg_temp.test_set_auth('c1019000-0000-4000-8000-000000000001');
select pg_temp.r1019_done('客戶甲') as id \gset b1_
select pg_temp.r1019_done('客戶乙') as id \gset b2_
select pg_temp.r1019_done('客戶丙') as id \gset b3_
select pg_temp.test_clear_auth();
delete from user_notifications where merchant_id = 'c1019000-0000-4000-8000-000000000021';

select is(char_length(pg_temp.r1019_reason_500()), 500, '前提:測試原因剛好 500 字');

-- ① 取消已完成訂單:500 字原因完整寫入
select pg_temp.test_set_auth('c1019000-0000-4000-8000-000000000001');
select public.cancel_completed_booking(:'b1_id'::uuid, pg_temp.r1019_reason_500(), false) ->> 'action' as a \gset c1_
select pg_temp.test_clear_auth();

select is(
  (select body from user_notifications
   where booking_id = :'b1_id'::uuid and event_type = 'booking_completed_cancelled'),
  '管理員甲 將 2027/04/02 10:00「客戶甲」的已完成訂單取消。原因：' || pg_temp.r1019_reason_500(),
  '取消:500 字原因完整寫進鈴鐺內文(不截、不加…)'
);
select ok(
  (select body not like '%…' and body like '%尾' from user_notifications
   where booking_id = :'b1_id'::uuid and event_type = 'booking_completed_cancelled'),
  '取消:內文結尾是原因最後一字,沒有「…」'
);
select is(
  (select array_agg(target_id::text) from user_notifications where booking_id = :'b1_id'::uuid),
  array['c1019000-0000-4000-8000-000000000026'],
  '取消:收件人照舊(只有管理員乙,操作者本人不收)'
);

-- ② 還原為已確認:61 字原因完整寫入
select pg_temp.test_set_auth('c1019000-0000-4000-8000-000000000001');
select public.revert_completed_booking(:'b2_id'::uuid, repeat('還', 60) || '原') ->> 'action' as a \gset r2_
select pg_temp.test_clear_auth();

select is(
  (select body from user_notifications
   where booking_id = :'b2_id'::uuid and event_type = 'booking_completed_reverted'),
  '管理員甲 將 2027/04/03 10:00「客戶乙」的已完成訂單還原為已確認。原因：' || repeat('還', 60) || '原',
  '還原:61 字原因完整寫入(改前是前 60 字 + …)'
);

-- ③ 換行 / tab 照舊換成半形空白(格式不變,內容沒少)
select pg_temp.test_set_auth('c1019000-0000-4000-8000-000000000001');
select public.cancel_completed_booking(:'b3_id'::uuid, '第一行' || E'\r\n' || '第二行' || E'\t' || repeat('字', 70), false) ->> 'action' as a \gset c3_
select pg_temp.test_clear_auth();
select is(
  (select body from user_notifications where booking_id = :'b3_id'::uuid),
  '管理員甲 將 2027/04/04 10:00「客戶丙」的已完成訂單取消。原因：第一行 第二行 ' || repeat('字', 70),
  '換行 / tab ⇒ 半形空白;76 字原因完整寫入'
);

-- ④ 501 字仍被引擎擋下(原因上限沒變)
select pg_temp.test_set_auth('c1019000-0000-4000-8000-000000000001');
select throws_ok(
  format($q$select public.revert_completed_booking(%L::uuid, %L)$q$, :'b3_id', repeat('字', 501)),
  '22023', null,
  '原因 501 字照舊被擋(上限 500 不變)'
);
select pg_temp.test_clear_auth();

-- ⑤ 函式屬性沒變
select is(
  (select row(p.prosecdef, p.proconfig::text, p.proacl::text)::text from pg_proc p
   where p.oid = 'private.notify_completed_booking_reversal(uuid)'::regprocedure),
  row(true, '{search_path=public}', '{postgres=X/postgres}')::text,
  'notify_completed_booking_reversal:SECURITY DEFINER、search_path=public、只有 postgres 能執行(照舊)'
);
select ok(
  (select prosrc not like '%left(v_reason, 60)%' from pg_proc
   where oid = 'private.notify_completed_booking_reversal(uuid)'::regprocedure),
  '函式本體已沒有 60 字截斷'
);

select * from finish();

rollback;
