-- SPECS-INDEX #962:LINE 通知給服務人員時,要跟推播一樣檢查「是否在職」— pgTAP
-- 規格書 .project/specs/LINE通知服務人員在職檢查.md
--
-- 推播在職條件 = merchant_staff.status = 'active'(另有 login_status / user_id 是「有沒有開通 App 登入」,
-- 不是在職判斷,LINE 不照搬 —— ⑤ 釘住「未開通登入的在職服務人員照收 LINE」)。
-- 沒有佇列:line-notify-dispatch 送出當下才問收件人,所以 ④ 以「同一筆舊訂單、人員移除後再問一次」
-- 證明寄出前會再判斷。
begin;

select plan(22);

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
-- Fixture:一間商家
--   管理員甲、客服乙:LINE 已綁定
--   服務人員丙:已開通登入、權限已種、LINE 已綁定、有推播訂閱(之後會被移除)
--   服務人員丁:尚未開通登入、LINE 已綁定(在職)
--   服務人員戊:已開通登入、權限已種、LINE 未綁定(之後會被移除)
--   會員己:LINE 已綁定
-- =========================================================================
insert into auth.users (id, email) values
  ('e9620000-0000-4000-8000-000000000001', 'pgtap-req962-admin@test.local'),
  ('e9620000-0000-4000-8000-000000000002', 'pgtap-req962-agent@test.local'),
  ('e9620000-0000-4000-8000-000000000003', 'pgtap-req962-staff-bing@test.local'),
  ('e9620000-0000-4000-8000-000000000005', 'pgtap-req962-staff-wu@test.local');

insert into groups (id) values ('e9620000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type)
values ('e9620000-0000-4000-8000-000000000021', 'e9620000-0000-4000-8000-000000000011', '在職檢查測試店', 'in_store_beauty');

insert into merchant_admins (id, merchant_id, user_id, display_name, line_bound, line_user_id)
values ('e9620000-0000-4000-8000-000000000031', 'e9620000-0000-4000-8000-000000000021', 'e9620000-0000-4000-8000-000000000001', '老闆甲', true, 'UadminJia962');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone, line_bound, line_user_id)
values ('e9620000-0000-4000-8000-000000000041', 'e9620000-0000-4000-8000-000000000021', 'e9620000-0000-4000-8000-000000000002', '客服乙', 'pgtap-req962-agent@test.local', 'active', now(), '0900096201', true, 'UagentYi962');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit, line_bound, line_user_id) values
  ('e9620000-0000-4000-8000-000000000051', 'e9620000-0000-4000-8000-000000000021', 'e9620000-0000-4000-8000-000000000003', '服務人員丙', 'active', 'active', '0900096211', true, true, 'UstaffBing962'),
  ('e9620000-0000-4000-8000-000000000052', 'e9620000-0000-4000-8000-000000000021', null, '服務人員丁', 'active', 'not_invited', '0900096212', true, true, 'UstaffDing962'),
  ('e9620000-0000-4000-8000-000000000053', 'e9620000-0000-4000-8000-000000000021', 'e9620000-0000-4000-8000-000000000005', '服務人員戊', 'active', 'active', '0900096213', true, false, null);

select seed_default_staff_permissions('e9620000-0000-4000-8000-000000000051');
select seed_default_staff_permissions('e9620000-0000-4000-8000-000000000053');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e9620000-0000-4000-8000-000000000021', d, false, '00:00', '23:59' from generate_series(0, 6) as d;
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('e9620000-0000-4000-8000-000000000061', 'e9620000-0000-4000-8000-000000000021', '剪髮', 800, 'primary', 40);
insert into payment_methods (id, merchant_id, name)
values ('e9620000-0000-4000-8000-000000000071', 'e9620000-0000-4000-8000-000000000021', '現場付款');
select seed_default_line_event_settings('e9620000-0000-4000-8000-000000000021');
select seed_default_member_settings('e9620000-0000-4000-8000-000000000021');

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected)
values ('e9620000-0000-4000-8000-000000000021', 'chid', 'secret', 'token-req962', true);
update merchant_line_event_settings
set enabled = true, notify_admin = true, notify_agent = true, notify_staff = true, notify_member = true
where merchant_id = 'e9620000-0000-4000-8000-000000000021' and event_type = 'booking_confirmed';

insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type) values
  ('e9620000-0000-4000-8000-000000000021', 'staff', 'e9620000-0000-4000-8000-000000000051', 'booking_created');

select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
select id from create_member('e9620000-0000-4000-8000-000000000021', '會員己', '0933096201') \gset member_
select id from create_booking(
  p_merchant_id => 'e9620000-0000-4000-8000-000000000021',
  p_staff_id => 'e9620000-0000-4000-8000-000000000051',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9620000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-05 10:00:00+08',
  p_customer_name => '在職檢查客戶',
  p_customer_phone => '0955096201',
  p_member_id => :'member_id'::uuid,
  p_payment_method_id => 'e9620000-0000-4000-8000-000000000071') \gset bkbing_
select id from create_booking(
  p_merchant_id => 'e9620000-0000-4000-8000-000000000021',
  p_staff_id => 'e9620000-0000-4000-8000-000000000052',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9620000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-06 10:00:00+08',
  p_customer_name => '在職檢查客戶二',
  p_customer_phone => '0955096202',
  p_payment_method_id => 'e9620000-0000-4000-8000-000000000071') \gset bkding_
select id from create_booking(
  p_merchant_id => 'e9620000-0000-4000-8000-000000000021',
  p_staff_id => 'e9620000-0000-4000-8000-000000000053',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9620000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-07 10:00:00+08',
  p_customer_name => '在職檢查客戶三',
  p_customer_phone => '0955096203',
  p_payment_method_id => 'e9620000-0000-4000-8000-000000000071') \gset bkwu_
select pg_temp.test_clear_auth();

update members set line_bound = true, line_user_id = 'UmemberJi962' where id = :'member_id'::uuid;

-- =========================================================================
-- ① 權限衛生:重建後仍只有 service_role 能呼叫
-- =========================================================================
select ok(not has_function_privilege('authenticated', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and not has_function_privilege('public', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute'),
  '#962 權限衛生:resolve_line_notification_targets 重建後 public/anon/authenticated 都不能呼叫,只有 service_role');

-- =========================================================================
-- ② 在職 → 是收件人(正向對照)
-- =========================================================================
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkbing_id'::uuid, null) as r \gset on_
select ok(exists (select 1 from jsonb_array_elements(:'on_r'::jsonb->'targets') t
                  where t->>'type' = 'staff' and t->>'id' = 'e9620000-0000-4000-8000-000000000051' and t->>'line_user_id' = 'UstaffBing962'),
  '#962(正向對照):在職、已綁 LINE 的服務人員丙是 LINE 收件人');
select ok(exists (
  select 1 from resolve_push_recipients('e9620000-0000-4000-8000-000000000021', 'booking_created', 'e9620000-0000-4000-8000-000000000051')
  where target_type = 'staff'),
  '#962(正向對照):在職的丙也是推播收件人');

-- =========================================================================
-- ③ 管理員移除丙(軟刪除 status = removed,走商家管理員身分的真實寫入路徑)
-- =========================================================================
select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
update merchant_staff set status = 'removed' where id = 'e9620000-0000-4000-8000-000000000051';
select pg_temp.test_clear_auth();
select is((select status from merchant_staff where id = 'e9620000-0000-4000-8000-000000000051'), 'removed',
  '#962 前提:丙已被移除(status = removed)');
select ok((select line_bound from merchant_staff where id = 'e9620000-0000-4000-8000-000000000051'),
  '#962 前提:移除不會自動解除 LINE 綁定(這就是本條要擋的情境)');

-- =========================================================================
-- ④ 已移除 → 不是收件人;同一筆移除前就存在的訂單,寄出當下再問一次一樣被擋
-- =========================================================================
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkbing_id'::uuid, null) as r \gset off_
select ok(not exists (select 1 from jsonb_array_elements(:'off_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#962(核心):已移除但仍綁 LINE 的服務人員丙,不再是 LINE 收件人(訂單是移除前建立的也一樣)');
select ok(exists (select 1 from jsonb_array_elements(:'off_r'::jsonb->'skipped') s
                  where s->>'type' = 'staff' and s->>'id' = 'e9620000-0000-4000-8000-000000000051' and s->>'reason' = 'staff_inactive'),
  '#962 跳過紀錄:丙列入跳過清單,原因 staff_inactive(服務人員已離職或停用)');
select is((select count(*)::int from jsonb_array_elements(:'off_r'::jsonb->'skipped') s where s->>'type' = 'staff'), 1,
  '#962 跳過紀錄:同一位服務人員只記一筆');
select ok(not exists (
  select 1 from resolve_push_recipients('e9620000-0000-4000-8000-000000000021', 'booking_created', 'e9620000-0000-4000-8000-000000000051')
  where target_type = 'staff'),
  '#962 一致性:推播那邊同樣不寄給已移除的丙(LINE 與推播的在職判斷一致)');

-- 其他角色不受影響
select is(
  (select array_agg(t->>'type' order by t->>'type') from jsonb_array_elements(:'off_r'::jsonb->'targets') t),
  array['admin', 'agent', 'member'],
  '#962:其他角色不受影響 —— 商家管理員、客服、會員(客戶)照收');
select ok(exists (select 1 from jsonb_array_elements(:'off_r'::jsonb->'targets') t
                  where t->>'type' = 'admin' and t->>'line_user_id' = 'UadminJia962'),
  '#962:商家管理員的 LINE 收件資訊不變');

-- 前端預覽彈窗跟實際發送一致
select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
select preview_line_notification_targets(:'bkbing_id'::uuid, 'booking_confirmed') as r \gset previewoff_
select pg_temp.test_clear_auth();
select ok(not exists (select 1 from jsonb_array_elements(:'previewoff_r'::jsonb->'targets') t where t->>'type' = 'staff'),
  '#962:商家端「確認訂單前預覽會通知誰」同步不再列出已移除的丙');

-- =========================================================================
-- ⑤ 未開通登入、在職的服務人員丁照收(證明 login_status / user_id 沒有被誤搬進 LINE)
-- =========================================================================
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkding_id'::uuid, null) as r \gset ding_
select ok(exists (select 1 from jsonb_array_elements(:'ding_r'::jsonb->'targets') t
                  where t->>'type' = 'staff' and t->>'id' = 'e9620000-0000-4000-8000-000000000052'),
  '#962 邊界:在職但尚未開通 App 登入(login_status = not_invited、沒有 user_id)的丁,LINE 照收');

-- 丁也被移除 → 不寄(未開通登入的人同樣適用在職檢查)
select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
update merchant_staff set status = 'removed' where id = 'e9620000-0000-4000-8000-000000000052';
select pg_temp.test_clear_auth();
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkding_id'::uuid, null) as r \gset dingoff_
select ok(not exists (select 1 from jsonb_array_elements(:'dingoff_r'::jsonb->'targets') t where t->>'type' = 'staff')
      and exists (select 1 from jsonb_array_elements(:'dingoff_r'::jsonb->'skipped') s
                  where s->>'type' = 'staff' and s->>'reason' = 'staff_inactive'),
  '#962 邊界:未開通登入的丁被移除後也不寄,跳過原因 staff_inactive');

-- =========================================================================
-- ⑥ 原因優先順序
-- =========================================================================
-- 戊在職、未綁 LINE → 照舊 target_not_bound
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkwu_id'::uuid, null) as r \gset wu_
select ok(exists (select 1 from jsonb_array_elements(:'wu_r'::jsonb->'skipped') s
                  where s->>'type' = 'staff' and s->>'reason' = 'target_not_bound'),
  '#962 回歸:在職但未綁 LINE 的戊 → 原因照舊是「對象尚未綁定 LINE」');

-- 戊在職、行事曆檢視關掉 → staff_calendar_view_off(補 #876 當時沒寫的跳過原因)
select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
select set_staff_permission('e9620000-0000-4000-8000-000000000053', 'staff_calendar_view', false);
select pg_temp.test_clear_auth();
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkwu_id'::uuid, null) as r \gset wucal_
select ok(exists (select 1 from jsonb_array_elements(:'wucal_r'::jsonb->'skipped') s
                  where s->>'type' = 'staff' and s->>'reason' = 'staff_calendar_view_off'),
  '#962 跳過紀錄:在職但行事曆檢視關閉 → 原因 staff_calendar_view_off(優先於「未綁定」)');

-- 戊被移除(行事曆檢視仍是關、也未綁)→ 記最根本的 staff_inactive
select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
update merchant_staff set status = 'removed' where id = 'e9620000-0000-4000-8000-000000000053';
select pg_temp.test_clear_auth();
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkwu_id'::uuid, null) as r \gset wuoff_
select is(
  (select array_agg(s->>'reason') from jsonb_array_elements(:'wuoff_r'::jsonb->'skipped') s where s->>'type' = 'staff'),
  array['staff_inactive'],
  '#962 優先順序:已移除 + 行事曆檢視關 + 未綁 → 只記一筆 staff_inactive');

-- =========================================================================
-- ⑦ 復職 → 恢復收件
-- =========================================================================
select pg_temp.test_set_auth('e9620000-0000-4000-8000-000000000001');
update merchant_staff set status = 'active' where id = 'e9620000-0000-4000-8000-000000000051';
select pg_temp.test_clear_auth();
select resolve_line_notification_targets('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkbing_id'::uuid, null) as r \gset back_
select ok(exists (select 1 from jsonb_array_elements(:'back_r'::jsonb->'targets') t
                  where t->>'type' = 'staff' and t->>'id' = 'e9620000-0000-4000-8000-000000000051'),
  '#962:丙復職後恢復為 LINE 收件人');

-- =========================================================================
-- ⑧ 跳過記錄表的 CHECK:新原因寫得進去、亂寫的寫不進去
-- =========================================================================
select lives_ok($$
  insert into line_notification_log (merchant_id, event_type, booking_id, target_type, target_id, status, skip_reason)
  values ('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', null, 'staff', 'e9620000-0000-4000-8000-000000000051', 'skipped', 'staff_inactive')
$$, '#962 跳過記錄:staff_inactive 可以寫進 line_notification_log');
select lives_ok($$
  insert into line_notification_log (merchant_id, event_type, booking_id, target_type, target_id, status, skip_reason)
  values ('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', null, 'staff', 'e9620000-0000-4000-8000-000000000053', 'skipped', 'staff_calendar_view_off')
$$, '#962 跳過記錄:staff_calendar_view_off 可以寫進 line_notification_log');
select throws_ok($$
  insert into line_notification_log (merchant_id, event_type, booking_id, target_type, target_id, status, skip_reason)
  values ('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', null, 'staff', null, 'skipped', 'whatever')
$$, '23514', null, '#962 跳過記錄:CHECK 仍會擋下沒定義的原因');
select lives_ok($$
  insert into line_notification_log (merchant_id, event_type, booking_id, target_type, target_id, status, skip_reason)
  values ('e9620000-0000-4000-8000-000000000021', 'booking_confirmed', null, 'admin', null, 'skipped', 'target_not_bound')
$$, '#962 回歸:既有原因 target_not_bound 仍可寫入');

select * from finish();
rollback;
