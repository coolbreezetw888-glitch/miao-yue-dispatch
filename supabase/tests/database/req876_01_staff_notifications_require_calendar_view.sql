-- SPECS-INDEX #876:關掉「行事曆檢視」就不寄推播 / LINE 給該服務人員 — pgTAP
-- 規格書 .project/specs/通知權限與CSV公式注入修正.md 第一章。
--
-- 架構:推播與 LINE 都是「送出那一刻」才呼叫收件人函式(沒有佇列),所以「寄出前再判斷一次」
-- 等同於「收件人函式本身會判斷」—— 下方 ⑥ 以「同一筆訂單、權限關掉後再問一次」證明:
-- 關掉之前已經存在的訂單,之後的提醒 / 異動通知一樣被擋。
begin;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

select plan(33);

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

-- =========================================================================
-- Fixture:一間商家。
--   管理員甲(LINE 已綁定、有推播訂閱)、客服乙(LINE 已綁定、有推播訂閱)
--   服務人員丙:已開通登入(四筆權限由 seed 種成開)、LINE 已綁定、有推播訂閱
--   服務人員丁:尚未邀請登入(沒有任何權限紀錄)、LINE 已綁定
--   服務人員戊:已開通登入但權限紀錄遺失(資料異常情境)、有推播訂閱
--   會員己:LINE 已綁定
-- =========================================================================
insert into auth.users (id, email) values
  ('e8760000-0000-4000-8000-000000000001', 'pgtap-req876-admin@test.local'),
  ('e8760000-0000-4000-8000-000000000002', 'pgtap-req876-agent@test.local'),
  ('e8760000-0000-4000-8000-000000000003', 'pgtap-req876-staff-bing@test.local'),
  ('e8760000-0000-4000-8000-000000000005', 'pgtap-req876-staff-wu@test.local');

insert into groups (id) values ('e8760000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type)
values ('e8760000-0000-4000-8000-000000000021', 'e8760000-0000-4000-8000-000000000011', '通知權限測試店', 'in_store_beauty');

insert into merchant_admins (id, merchant_id, user_id, display_name, line_bound, line_user_id)
values ('e8760000-0000-4000-8000-000000000031', 'e8760000-0000-4000-8000-000000000021', 'e8760000-0000-4000-8000-000000000001', '老闆甲', true, 'UadminJia');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone, line_bound, line_user_id)
values ('e8760000-0000-4000-8000-000000000041', 'e8760000-0000-4000-8000-000000000021', 'e8760000-0000-4000-8000-000000000002', '客服乙', 'pgtap-req876-agent@test.local', 'active', now(), '0900087601', true, 'UagentYi');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit, line_bound, line_user_id) values
  ('e8760000-0000-4000-8000-000000000051', 'e8760000-0000-4000-8000-000000000021', 'e8760000-0000-4000-8000-000000000003', '服務人員丙', 'active', 'active', '0900087611', true, true, 'UstaffBing'),
  ('e8760000-0000-4000-8000-000000000052', 'e8760000-0000-4000-8000-000000000021', null, '服務人員丁', 'active', 'not_invited', '0900087612', true, true, 'UstaffDing'),
  ('e8760000-0000-4000-8000-000000000053', 'e8760000-0000-4000-8000-000000000021', 'e8760000-0000-4000-8000-000000000005', '服務人員戊', 'active', 'active', '0900087613', true, false, null);

-- 丙照真實流程(第一次完成登入)種下四筆 granted=true;丁還沒登入所以沒有;戊刻意不種(紀錄遺失)。
select seed_default_staff_permissions('e8760000-0000-4000-8000-000000000051');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8760000-0000-4000-8000-000000000021', d, false, '00:00', '23:59' from generate_series(0, 6) as d;
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('e8760000-0000-4000-8000-000000000061', 'e8760000-0000-4000-8000-000000000021', '剪髮', 800, 'primary', 40);
insert into payment_methods (id, merchant_id, name)
values ('e8760000-0000-4000-8000-000000000071', 'e8760000-0000-4000-8000-000000000021', '現場付款');
select seed_default_line_event_settings('e8760000-0000-4000-8000-000000000021');
select seed_default_member_settings('e8760000-0000-4000-8000-000000000021');

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected)
values ('e8760000-0000-4000-8000-000000000021', 'chid', 'secret', 'token-req876', true);
update merchant_line_event_settings
set enabled = true, notify_admin = true, notify_agent = true, notify_staff = true, notify_member = true
where merchant_id = 'e8760000-0000-4000-8000-000000000021' and event_type = 'booking_confirmed';

insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type) values
  ('e8760000-0000-4000-8000-000000000021', 'admin', 'e8760000-0000-4000-8000-000000000031', 'booking_created'),
  ('e8760000-0000-4000-8000-000000000021', 'agent', 'e8760000-0000-4000-8000-000000000041', 'booking_created'),
  ('e8760000-0000-4000-8000-000000000021', 'staff', 'e8760000-0000-4000-8000-000000000051', 'booking_created'),
  ('e8760000-0000-4000-8000-000000000021', 'staff', 'e8760000-0000-4000-8000-000000000051', 'booking_reminder_next_day'),
  ('e8760000-0000-4000-8000-000000000021', 'staff', 'e8760000-0000-4000-8000-000000000053', 'booking_created');

select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select id from create_member('e8760000-0000-4000-8000-000000000021', '會員己', '0933087601') \gset member_
select id from create_booking(
  p_merchant_id => 'e8760000-0000-4000-8000-000000000021',
  p_staff_id => 'e8760000-0000-4000-8000-000000000051',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8760000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-05 10:00:00+08',
  p_customer_name => '通知權限客戶',
  p_customer_phone => '0955087601',
  p_member_id => :'member_id'::uuid,
  p_payment_method_id => 'e8760000-0000-4000-8000-000000000071') \gset bking_
select id from create_booking(
  p_merchant_id => 'e8760000-0000-4000-8000-000000000021',
  p_staff_id => 'e8760000-0000-4000-8000-000000000052',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e8760000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-06 10:00:00+08',
  p_customer_name => '通知權限客戶二',
  p_customer_phone => '0955087602',
  p_payment_method_id => 'e8760000-0000-4000-8000-000000000071') \gset bkding_
select pg_temp.test_clear_auth();

update members set line_bound = true, line_user_id = 'UmemberJi' where id = :'member_id'::uuid;

-- =========================================================================
-- ① 權限衛生:新 helper 三個角色都不能直接呼叫;兩支收件人函式 ACL 維持只給 service_role
-- =========================================================================
select ok(not has_function_privilege('anon', 'private.staff_calendar_view_allows_notifications(uuid)', 'execute'),
  '#876 權限衛生:anon 不能呼叫 staff_calendar_view_allows_notifications');
select ok(not has_function_privilege('authenticated', 'private.staff_calendar_view_allows_notifications(uuid)', 'execute'),
  '#876 權限衛生:authenticated 不能呼叫 staff_calendar_view_allows_notifications');
select ok(not has_function_privilege('public', 'private.staff_calendar_view_allows_notifications(uuid)', 'execute'),
  '#876 權限衛生:PUBLIC 不能呼叫 staff_calendar_view_allows_notifications');
select ok(not has_function_privilege('authenticated', 'public.resolve_push_recipients(uuid,text,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.resolve_push_recipients(uuid,text,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.resolve_push_recipients(uuid,text,uuid)', 'execute'),
  '#876 權限衛生:resolve_push_recipients 重建後仍只有 service_role 能呼叫');
select ok(not has_function_privilege('authenticated', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute'),
  '#876 權限衛生:resolve_line_notification_targets 重建後仍只有 service_role 能呼叫');

-- =========================================================================
-- ② 推播:權限開 → 是收件人(正向對照)
-- =========================================================================
select ok(exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_created', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'staff' and target_id = 'e8760000-0000-4000-8000-000000000051'),
  '#876 推播(正向對照):行事曆檢視開著 → 被指派的服務人員丙是收件人');

-- =========================================================================
-- ③ 管理員關掉丙的「行事曆檢視」(走真實的 set_staff_permission)
-- =========================================================================
select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select set_staff_permission('e8760000-0000-4000-8000-000000000051', 'staff_calendar_view', false);
select pg_temp.test_clear_auth();

select ok(not exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_created', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'staff'),
  '#876 推播(核心):行事曆檢視關掉 → 服務人員丙不再是收件人(也就不會寫進站內鈴鐺)');
select ok(not exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_reminder_next_day', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'staff'),
  '#876 推播(核心):隔日提醒排程同樣不再寄給丙(排程是送出當下才問收件人,沒有佇列)');
select ok(exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_created', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'admin' and target_id = 'e8760000-0000-4000-8000-000000000031'),
  '#876 推播:其他角色不受影響 —— 管理員甲照收');
select ok(exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_created', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'agent' and target_id = 'e8760000-0000-4000-8000-000000000041'),
  '#876 推播:其他角色不受影響 —— 客服乙照收');
select ok(
  (select granted from merchant_staff_permissions where staff_id = 'e8760000-0000-4000-8000-000000000051' and section_key = 'staff_calendar_view') = false,
  '#876 前提:關閉確實寫成 granted=false(不是刪掉紀錄)');

-- =========================================================================
-- ④ LINE:同一個「關掉」狀態
-- =========================================================================
select resolve_line_notification_targets('e8760000-0000-4000-8000-000000000021', 'booking_confirmed', :'bking_id'::uuid, null) as r \gset lineoff_

select ok(not exists (select 1 from jsonb_array_elements(:'lineoff_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#876 LINE(核心):行事曆檢視關掉 → 服務人員丙不在 LINE 收件人裡');
-- #962 起改為列入跳過清單,原因寫 staff_calendar_view_off(不是誤導的「未綁定」)
select ok(exists (select 1 from jsonb_array_elements(:'lineoff_r'::jsonb->'skipped') s
                  where s->>'type' = 'staff' and s->>'reason' = 'staff_calendar_view_off')
      and not exists (select 1 from jsonb_array_elements(:'lineoff_r'::jsonb->'skipped') s
                      where s->>'type' = 'staff' and s->>'reason' = 'target_not_bound'),
  '#876/#962 LINE:列入跳過清單,原因是「未開放行事曆檢視」,不寫「未綁定」的假原因誤導商家');
select is(
  (select array_agg(t->>'type' order by t->>'type') from jsonb_array_elements(:'lineoff_r'::jsonb->'targets') t),
  array['admin', 'agent'],
  '#876 LINE:其他角色不受影響 —— 管理員、客服照收(客戶端第 5 批 C5-K01 起會員不再是模組 11 的對象)');

-- 前端「確認訂單前預覽會通知誰」走同一支判斷,要跟實際發送一致
select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select preview_line_notification_targets(:'bking_id'::uuid, 'booking_confirmed') as r \gset previewoff_
select pg_temp.test_clear_auth();
select ok(not exists (select 1 from jsonb_array_elements(:'previewoff_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#876 LINE:商家端的預覽彈窗同步不再列出丙(預覽與實際發送一致)');

-- =========================================================================
-- ⑤ 重新打開 → 之後的通知恢復(不補寄:收件人函式只回「現在」該寄給誰,本來就沒有補寄機制)
-- =========================================================================
select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select set_staff_permission('e8760000-0000-4000-8000-000000000051', 'staff_calendar_view', true);
select pg_temp.test_clear_auth();

select ok(exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_created', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'staff' and target_id = 'e8760000-0000-4000-8000-000000000051'),
  '#876 推播:重新打開行事曆檢視 → 丙恢復為收件人');
select ok(exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_reminder_next_day', 'e8760000-0000-4000-8000-000000000051')
  where target_type = 'staff'),
  '#876 推播:重新打開 → 隔日提醒也恢復');
select resolve_line_notification_targets('e8760000-0000-4000-8000-000000000021', 'booking_confirmed', :'bking_id'::uuid, null) as r \gset lineon_
select ok(exists (select 1 from jsonb_array_elements(:'lineon_r'::jsonb->'targets') t
                  where t->>'type' = 'staff' and t->>'id' = 'e8760000-0000-4000-8000-000000000051' and t->>'line_user_id' = 'UstaffBing'),
  '#876 LINE:重新打開 → 丙恢復為 LINE 收件人');
select is(jsonb_array_length(:'lineon_r'::jsonb->'targets'), 3,
  '#876 LINE:重新打開後三種店家對象都在(數量對照,證明關掉時少的就是丙那一位;C5-K01 起沒有會員)');

-- =========================================================================
-- ⑥ 關掉之前就已經存在的訂單:之後才發生的通知一樣被擋(沒有「已排隊」漏網)
--    同一筆 bking(在權限開著時建立)、權限再關一次,異動 / 提醒的收件人判斷都在送出當下。
-- =========================================================================
select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select set_staff_permission('e8760000-0000-4000-8000-000000000051', 'staff_calendar_view', false);
select pg_temp.test_clear_auth();
select ok(not exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_reminder_next_day',
    (select staff_id from bookings where id = :'bking_id'::uuid))
  where target_type = 'staff'),
  '#876:權限開著時建立的訂單,關掉之後的隔日提醒不會寄給丙');
select resolve_line_notification_targets('e8760000-0000-4000-8000-000000000021', 'booking_confirmed', :'bking_id'::uuid, null) as r \gset lineoff2_
select ok(not exists (select 1 from jsonb_array_elements(:'lineoff2_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#876:權限開著時建立的訂單,關掉之後的 LINE 確認通知不會寄給丙');

-- =========================================================================
-- ⑦ 尚未開通登入的服務人員丁(沒有任何權限紀錄)—— 維持既有行為照收 LINE
-- =========================================================================
select resolve_line_notification_targets('e8760000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkding_id'::uuid, null) as r \gset lineding_
select ok(exists (select 1 from jsonb_array_elements(:'lineding_r'::jsonb->'targets') t
                  where t->>'type' = 'staff' and t->>'id' = 'e8760000-0000-4000-8000-000000000052'),
  '#876 邊界:還沒開通登入、沒有權限紀錄的服務人員丁 → 預設視為開(登入時會被種成開),LINE 照收');
select is((select count(*)::int from merchant_staff_permissions where staff_id = 'e8760000-0000-4000-8000-000000000052'), 0,
  '#876 前提:丁確實一筆權限紀錄都沒有');

-- 管理員在丁登入前就明確關掉 → 不寄
select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select set_staff_permission('e8760000-0000-4000-8000-000000000052', 'staff_calendar_view', false);
select pg_temp.test_clear_auth();
select resolve_line_notification_targets('e8760000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkding_id'::uuid, null) as r \gset linedingoff_
select ok(not exists (select 1 from jsonb_array_elements(:'linedingoff_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#876 邊界:還沒登入的服務人員,管理員明確關掉行事曆檢視 → LINE 不寄');
select ok(exists (select 1 from jsonb_array_elements(:'linedingoff_r'::jsonb->'skipped') s
                  where s->>'type' = 'staff' and s->>'reason' = 'staff_calendar_view_off'),
  '#876/#962 邊界:同上,跳過原因記為「未開放行事曆檢視」');

-- 他之後第一次完成登入:seed 是 on conflict do nothing,不會把管理員的「關」蓋回「開」
select seed_default_staff_permissions('e8760000-0000-4000-8000-000000000052');
select is((select granted from merchant_staff_permissions where staff_id = 'e8760000-0000-4000-8000-000000000052' and section_key = 'staff_calendar_view'), false,
  '#876 邊界:登入時的預設權限種子不會把管理員事先關掉的行事曆檢視蓋回開');
select resolve_line_notification_targets('e8760000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkding_id'::uuid, null) as r \gset linedingseed_
select ok(not exists (select 1 from jsonb_array_elements(:'linedingseed_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#876 邊界:種子跑過之後丁仍然收不到 LINE');

-- =========================================================================
-- ⑧ 已開通登入、但權限紀錄遺失的服務人員戊 —— 跟行事曆同標準(看不到行事曆就不收)
-- =========================================================================
select ok(not exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-000000000021', 'booking_created', 'e8760000-0000-4000-8000-000000000053')
  where target_type = 'staff'),
  '#876 邊界:已開通登入但沒有權限紀錄 → 視為關(與 get_my_booking_schedule 同標準,往安全方向)');

-- =========================================================================
-- ⑨ helper 本身的直接判斷(邊界值)
-- =========================================================================
select ok(not private.staff_calendar_view_allows_notifications('e8760000-0000-4000-8000-0000000000ff'),
  '#876 helper:找不到這位服務人員 → false');
select ok(not private.staff_calendar_view_allows_notifications(null),
  '#876 helper:null → false');
select ok(not private.staff_calendar_view_allows_notifications('e8760000-0000-4000-8000-000000000051'),
  '#876 helper:丙(已登入、granted=false)→ false');

-- 別的權限項目關掉不影響(只有 staff_calendar_view 才算)
select pg_temp.test_set_auth('e8760000-0000-4000-8000-000000000001');
select set_staff_permission('e8760000-0000-4000-8000-000000000051', 'staff_calendar_view', true);
select set_staff_permission('e8760000-0000-4000-8000-000000000051', 'staff_payroll_view', false);
select set_staff_permission('e8760000-0000-4000-8000-000000000051', 'staff_profile_edit', false);
select pg_temp.test_clear_auth();
select ok(private.staff_calendar_view_allows_notifications('e8760000-0000-4000-8000-000000000051'),
  '#876 helper:只關掉其他權限(薪資報表、個人資料編輯)→ 照收通知');

-- 跨商家:另一間店的服務人員權限不會互相影響(判斷只看 staff_id 自己的紀錄)—— 由 resolve 的
-- s.merchant_id = p_merchant_id 既有條件把關,這裡確認換一間不存在的商家問丙得到空集合。
select ok(not exists (
  select 1 from resolve_push_recipients('e8760000-0000-4000-8000-0000000000fe', 'booking_created', 'e8760000-0000-4000-8000-000000000051')),
  '#876:商家不符時沒有任何收件人(既有跨商家隔離維持)');

select * from finish();
rollback;
