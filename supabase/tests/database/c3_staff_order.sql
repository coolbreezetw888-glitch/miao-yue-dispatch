-- 客戶端第 3 批 — C3-H01 服務人員順位 / C3-H02 move_merchant_staff_order / C3-H04 依順位排列 / C3-H05 完成頁文字
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(35);

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
create function pg_temp.order_of(p_merchant uuid) returns text language sql stable security definer as $$
  select string_agg(name, ',' order by display_order, created_at, id) from public.merchant_staff
  where merchant_id = p_merchant and status = 'active' $$;
create function pg_temp.msig(p_merchant uuid) returns int language sql as $$
  select count(*)::int from realtime.messages
  where topic = 'merchant:' || p_merchant::text || ':calendar' and event = 'calendar_changed' $$;
create function pg_temp.ssig(p_staff uuid) returns int language sql as $$
  select count(*)::int from realtime.messages
  where topic = 'staff:' || p_staff::text || ':schedule' and event = 'schedule_changed' $$;
create function pg_temp.reset_sig() returns void language plpgsql as $$
begin
  delete from realtime.messages where topic like 'merchant:%:calendar' or topic like 'staff:%:schedule';
  perform set_config('miaoyue.rt_merchant_notified', '', true);
  perform set_config('miaoyue.rt_merchant_fanned_staff', '', true);
  perform set_config('miaoyue.rt_staff_notified', '', true);
  perform set_config('miaoyue.rt_staff_fanned_out', '', true);
end;
$$;
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
declare v_hint text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ':' || coalesce(v_hint, '');
end $$;

insert into auth.users (id, email) values
  ('c3d00000-0000-4000-8000-000000000001', 'o-admin@test.local'),
  ('c3d00000-0000-4000-8000-000000000002', 'o-agent-staff@test.local'),
  ('c3d00000-0000-4000-8000-000000000003', 'o-agent-hours@test.local'),
  ('c3d00000-0000-4000-8000-000000000004', 'o-other-admin@test.local'),
  ('c3d00000-0000-4000-8000-000000000005', 'o-staff-k1@test.local');
insert into groups (id) values ('c3d00000-0000-4000-8000-000000000091'), ('c3d00000-0000-4000-8000-000000000092');
insert into merchants (id, group_id, name, industry_type, booking_slug) values
  ('c3d00000-0000-4000-8000-000000000021', 'c3d00000-0000-4000-8000-000000000091', 'C3順位店', 'in_store_beauty', 'pgtap-c3-order'),
  ('c3d00000-0000-4000-8000-000000000022', 'c3d00000-0000-4000-8000-000000000092', 'C3別家', 'in_store_beauty', 'pgtap-c3-order2');
insert into merchant_admins (merchant_id, user_id) values
  ('c3d00000-0000-4000-8000-000000000021', 'c3d00000-0000-4000-8000-000000000001'),
  ('c3d00000-0000-4000-8000-000000000022', 'c3d00000-0000-4000-8000-000000000004');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c3d00000-0000-4000-8000-000000000071', 'c3d00000-0000-4000-8000-000000000021', 'c3d00000-0000-4000-8000-000000000002', '人員管理客服', '0900330071', 'o-agent-staff@test.local', 'active'),
  ('c3d00000-0000-4000-8000-000000000072', 'c3d00000-0000-4000-8000-000000000021', 'c3d00000-0000-4000-8000-000000000003', '營業時間客服', '0900330072', 'o-agent-hours@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c3d00000-0000-4000-8000-000000000071', 'staff_management', true),
  ('c3d00000-0000-4000-8000-000000000072', 'business_hours', true),
  ('c3d00000-0000-4000-8000-000000000072', 'orders', true);

-- 不帶 display_order ⇒ trigger 依新增順序 1、2、3、4
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status, user_id, login_status) values
  ('c3d00000-0000-4000-8000-000000000031', 'c3d00000-0000-4000-8000-000000000021', 'K1', '0900330031', true, 'active', 'c3d00000-0000-4000-8000-000000000005', 'active');
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status) values
  ('c3d00000-0000-4000-8000-000000000032', 'c3d00000-0000-4000-8000-000000000021', 'K2', '0900330032', true, 'active');
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status) values
  ('c3d00000-0000-4000-8000-000000000033', 'c3d00000-0000-4000-8000-000000000021', 'K3', '0900330033', true, 'active');
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status) values
  ('c3d00000-0000-4000-8000-000000000034', 'c3d00000-0000-4000-8000-000000000021', 'K4移除', '0900330034', true, 'removed');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('c3d00000-0000-4000-8000-000000000031', 'staff_calendar_view', true);
grant execute on function pg_temp.order_of(uuid) to authenticated;

select is((select array_agg(display_order order by name) from merchant_staff where merchant_id = 'c3d00000-0000-4000-8000-000000000021'),
  array[1, 2, 3, 4], 'H01-1 新增時沒帶順位 ⇒ 自動排在該店最後(含已移除的人)');
select is((select count(*)::int from merchant_staff where display_order is null), 0, 'H01-2 display_order 全部有值(not null)');
select is((select attnotnull from pg_attribute where attrelid = 'public.merchant_staff'::regclass and attname = 'display_order'), true,
  'H01-3 display_order 是 not null');

-- 管理員從前端直接新增 / 直接改順位
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status, display_order) values
  ('c3d00000-0000-4000-8000-000000000035', 'c3d00000-0000-4000-8000-000000000021', 'K5', '0900330035', true, 'active', 1);
select pg_temp.test_clear_auth();
select is((select display_order from merchant_staff where id = 'c3d00000-0000-4000-8000-000000000035'), 5,
  'H01-4 登入者新增時帶了順位也不採用 ⇒ 仍排最後');
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
select is(pg_temp.err($$update public.merchant_staff set display_order = 99 where id = 'c3d00000-0000-4000-8000-000000000031'$$),
  '42501:display_order_protected', 'H01-5 管理員不能直接 PATCH display_order(只能用上下箭頭函式)');
select is(pg_temp.err($$update public.merchant_staff set intro = '改簡介' where id = 'c3d00000-0000-4000-8000-000000000031'$$),
  'ok', 'H01-6 其他欄位照常可以改');
select pg_temp.test_clear_auth();

-- H02 移動
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
select is(public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000032', 'up'), '{"state":"moved"}'::jsonb, 'H02-1 管理員把 K2 往上');
select is(pg_temp.order_of('c3d00000-0000-4000-8000-000000000021'), 'K2,K1,K3,K5', 'H02-2 K2、K1 交換');
select is(public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000032', 'up'), '{"state":"edge"}'::jsonb, 'H02-3 已經在最上面 ⇒ edge,不報錯');
select is(public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000035', 'down'), '{"state":"edge"}'::jsonb, 'H02-4 已經在最下面(已移除的不算)⇒ edge');
select is(public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000033', 'down'), '{"state":"moved"}'::jsonb, 'H02-5 K3 往下(跳過已移除的 K4,跟 K5 換)');
select is(pg_temp.order_of('c3d00000-0000-4000-8000-000000000021'), 'K2,K1,K5,K3', 'H02-6 K3、K5 交換');
select is(pg_temp.err($$select public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000034', 'up')$$),
  '22023:staff_not_active', 'H02-7 已移除的人不能調整');
select is(pg_temp.err($$select public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000031', 'left')$$),
  '22023:invalid_direction', 'H02-8 方向不對 ⇒ 22023');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000002');
select is(public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000031', 'up'), '{"state":"moved"}'::jsonb,
  'H02-9 有「服務人員管理」權限的客服可以調整');
select pg_temp.test_clear_auth();
select is(pg_temp.order_of('c3d00000-0000-4000-8000-000000000021'), 'K1,K2,K5,K3', 'H02-10 K1 回到第一');
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000031', 'down')$$),
  '42501:', 'H02-11 沒有服務人員管理權限的客服 ⇒ 42501');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000031', 'down')$$),
  '42501:', 'H02-12 別家的管理員 ⇒ 42501');
select pg_temp.test_clear_auth();

-- 舊資料有重複順位 ⇒ 先依目前順序重新編號再交換
update merchant_staff set display_order = 1 where id in ('c3d00000-0000-4000-8000-000000000031', 'c3d00000-0000-4000-8000-000000000032', 'c3d00000-0000-4000-8000-000000000035');
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
select is(public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000035', 'up'), '{"state":"moved"}'::jsonb, 'H02-13 有重複順位時仍可移動');
select pg_temp.test_clear_auth();
select is((select count(distinct display_order)::int from merchant_staff where merchant_id = 'c3d00000-0000-4000-8000-000000000021' and status = 'active'),
  4, 'H02-14 移動後在職的人順位不再重複');

-- 即時同步:順位變動只發商家頻道,服務人員端不發
select pg_temp.reset_sig();
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
select public.move_merchant_staff_order('c3d00000-0000-4000-8000-000000000031', 'down');
select pg_temp.test_clear_auth();
select is(pg_temp.msig('c3d00000-0000-4000-8000-000000000021'), 1, 'H02-15 順位變動 ⇒ 商家行事曆訊號 1 則(同交易去重)');
select is(pg_temp.ssig('c3d00000-0000-4000-8000-000000000031'), 0, 'H02-16 順位變動 ⇒ 服務人員端不發訊號');
select is((select array_agg((payload - 'id')::text) from realtime.messages where topic = 'merchant:c3d00000-0000-4000-8000-000000000021:calendar'),
  array['{"v": 1, "reason": "calendar_changed"}'], 'H02-17 訊號不帶任何內容(realtime.send 自己加的 id 以外)');

-- H04 依順位排列:公開預約頁、後台行事曆
update merchant_staff set display_order = case name when 'K3' then 1 when 'K5' then 2 when 'K1' then 3 when 'K2' then 4 else display_order end
where merchant_id = 'c3d00000-0000-4000-8000-000000000021';
select is((select array_agg(e ->> 'display_name') from jsonb_array_elements(public.get_public_booking_page('pgtap-c3-order') -> 'staff') e),
  array['K3', 'K5', 'K1', 'K2'], 'H04-1 公開預約頁服務人員依順位');
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
select is((select array_agg(e ->> 'staff_name') from jsonb_array_elements(public.get_merchant_day_schedule('c3d00000-0000-4000-8000-000000000021', current_date) -> 'staff') e),
  array['K3', 'K5', 'K1', 'K2'], 'H04-2 後台行事曆服務人員欄依順位(原本依姓名)');
select is((select array_agg(e ->> 'name') from jsonb_array_elements(public.list_report_export_staff('c3d00000-0000-4000-8000-000000000021')) e),
  array['K3', 'K5', 'K1', 'K2'], 'H04-4 報表匯出中心服務人員下拉依順位(使用者 Q3-c;原本依姓名)');
select is((select array_agg(e ->> 'staff_name') from jsonb_array_elements(public.get_merchant_billing_summary_by_range('c3d00000-0000-4000-8000-000000000021', make_date(extract(year from (now() at time zone 'Asia/Taipei'))::int, extract(month from (now() at time zone 'Asia/Taipei'))::int, 1), (make_date(extract(year from (now() at time zone 'Asia/Taipei'))::int, extract(month from (now() at time zone 'Asia/Taipei'))::int, 1) + interval '1 month - 1 day')::date) -> 'per_staff_breakdown') e),
  array['K3', 'K5', 'K1', 'K2'], 'H04-5 帳單報表(單月)服務人員明細依順位(主腦裁決;原本依姓名)');
select is((select array_agg(e ->> 'staff_name') from jsonb_array_elements(public.get_merchant_billing_summary_by_range('c3d00000-0000-4000-8000-000000000021',
             (now() at time zone 'Asia/Taipei')::date, (now() at time zone 'Asia/Taipei')::date) -> 'per_staff_breakdown') e),
  array['K3', 'K5', 'K1', 'K2'], 'H04-6 帳單報表(自訂區間)服務人員明細依順位');
select is((select array_agg(k order by k) from jsonb_array_elements(public.get_merchant_billing_summary_by_range('c3d00000-0000-4000-8000-000000000021',
             (now() at time zone 'Asia/Taipei')::date, (now() at time zone 'Asia/Taipei')::date) -> 'per_staff_breakdown') e, jsonb_object_keys(e) k
           -- #1035 A 批 PA-B01:自訂區間版每列多一個 bonus_amount(單月舊版 Q11 不改),比對時排除。
           where e ->> 'staff_name' = 'K3' and k <> 'bonus_amount'),
          (select array_agg(k order by k) from jsonb_array_elements(public.get_merchant_billing_summary_by_range('c3d00000-0000-4000-8000-000000000021', make_date(extract(year from (now() at time zone 'Asia/Taipei'))::int, extract(month from (now() at time zone 'Asia/Taipei'))::int, 1), (make_date(extract(year from (now() at time zone 'Asia/Taipei'))::int, extract(month from (now() at time zone 'Asia/Taipei'))::int, 1) + interval '1 month - 1 day')::date) -> 'per_staff_breakdown') e, jsonb_object_keys(e) k
           where e ->> 'staff_name' = 'K3' and k <> 'bonus_amount'),
  'H04-7 自訂區間版每列欄位跟整個月份查詢一樣(沒有多回 display_order)');
select is((select array_agg(e ->> 'staff_name') from jsonb_array_elements(public.get_staff_schedule_overview('c3d00000-0000-4000-8000-000000000021', current_date, current_date) -> 'staff') e),
  array['K3', 'K5', 'K1', 'K2'], 'H04-3 排班一覽服務人員依順位(原本依姓名)');
select pg_temp.test_clear_auth();

-- H05 店家自訂完成頁文字
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
insert into merchant_booking_settings (merchant_id, completion_message_member, completion_message_guest)
values ('c3d00000-0000-4000-8000-000000000021', E'  我們會盡快確認\n謝謝！  ', E' \n　');
select pg_temp.test_clear_auth();
select is((select row(completion_message_member, completion_message_guest)::text from merchant_booking_settings where merchant_id = 'c3d00000-0000-4000-8000-000000000021'),
  row(E'我們會盡快確認\n謝謝！'::text, null::text)::text, 'H05-1 去頭尾空白(保留中間換行);只有空白 ⇒ null');
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($f$update public.merchant_booking_settings set completion_message_guest = %L where merchant_id = 'c3d00000-0000-4000-8000-000000000021'$f$, repeat('字', 201))),
  '23514:', 'H05-2 超過 200 字被擋');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('c3d00000-0000-4000-8000-000000000003');
select is(pg_temp.err($$update public.merchant_booking_settings set completion_message_member = '客服改的' where merchant_id = 'c3d00000-0000-4000-8000-000000000021'$$),
  '42501:', 'H05-3 有營業時間權限的客服不能改完成頁文字');
select is(pg_temp.err($$update public.merchant_booking_settings set start_time_interval_minutes = 15 where merchant_id = 'c3d00000-0000-4000-8000-000000000021'$$),
  'ok', 'H05-4 同一位客服改建單間隔照常可以');
select pg_temp.test_clear_auth();

insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, is_guest_booking) values
  ('c3d00000-0000-4000-8000-0000000000b1', 'c3d00000-0000-4000-8000-000000000021', 'c3d00000-0000-4000-8000-000000000031', now() + interval '3 days', now() + interval '3 days 1 hour', 'x', '0912330001', 'customer', 'pending_confirmation', 'customer', false),
  ('c3d00000-0000-4000-8000-0000000000b2', 'c3d00000-0000-4000-8000-000000000021', 'c3d00000-0000-4000-8000-000000000031', now() + interval '4 days', now() + interval '4 days 1 hour', 'x', '0912330002', 'customer', 'pending_confirmation', 'customer', true);
select is(array[private.customer_booking_result('c3d00000-0000-4000-8000-0000000000b1') ->> 'completion_message',
                private.customer_booking_result('c3d00000-0000-4000-8000-0000000000b2') ->> 'completion_message'],
  array[E'我們會盡快確認\n謝謝！', '店家確認後會與您聯絡。'], 'H05-5 完成頁文字:會員用店家自訂;訪客沒填 ⇒ 預設句');

select * from finish();
rollback;
