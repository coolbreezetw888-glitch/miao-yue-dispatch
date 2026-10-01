-- SPECS-INDEX #972:LINE 通知(及推播共用的變數組裝)跨商家訂單/請假紀錄檢查 — pgTAP
-- 規格書 .project/specs/LINE通知跨商家檢查.md / migration 20261001150000
--
-- 情境:A 商家的管理員/客服拿到 B 商家的訂單編號、請假紀錄編號,透過 Edge Function(service_role)
-- 以 merchant_id = A 呼叫下列函式。資料庫這一層必須擋下(丟錯 P0002),不能把 B 的資料組進 A 的通知:
--   resolve_line_notification_targets / render_booking_notification_variables /
--   render_staff_leave_notification_variables
-- 同商家的正常呼叫結果不變(正向對照)。
--
-- 故障注入(engineer 已做,見回報):
--   F1 拿掉 resolve 開頭的訂單歸屬檢查 → ⑤⑦⑧ 轉紅
--   F2 拿掉 resolve 開頭的請假紀錄歸屬檢查 → ⑥ 轉紅
--   F3 render_booking 拿掉 merchant 比對 → ⑨⑩ 轉紅
--   F4 render_staff_leave 拿掉 ms.merchant_id = p_merchant_id → ⑫ 轉紅
--   F5 resolve 服務人員/會員分支拿掉 merchant_id 條件 → ⑱⑲ 轉紅
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
-- Fixture
--   A 商家(e972..21):LINE 已連線,booking_confirmed 開啟、四種對象全開;
--     管理員甲(已綁)、服務人員 A(已綁、在職、已開通)、會員 A(已綁)、訂單 bkA、請假紀錄 lvA
--   B 商家(e972..22):LINE **未**連線;管理員乙、服務人員 B(已綁)、會員 B(已綁)、訂單 bkB、請假紀錄 lvB
-- =========================================================================
insert into auth.users (id, email) values
  ('e9720000-0000-4000-8000-000000000001', 'pgtap-req972-admin-a@test.local'),
  ('e9720000-0000-4000-8000-000000000002', 'pgtap-req972-admin-b@test.local'),
  ('e9720000-0000-4000-8000-000000000003', 'pgtap-req972-staff-a@test.local');

insert into groups (id) values
  ('e9720000-0000-4000-8000-000000000011'),
  ('e9720000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('e9720000-0000-4000-8000-000000000021', 'e9720000-0000-4000-8000-000000000011', '跨商家檢查A店', 'in_store_beauty'),
  ('e9720000-0000-4000-8000-000000000022', 'e9720000-0000-4000-8000-000000000012', '跨商家檢查B店', 'in_store_beauty');

insert into merchant_admins (id, merchant_id, user_id, display_name, line_bound, line_user_id) values
  ('e9720000-0000-4000-8000-000000000031', 'e9720000-0000-4000-8000-000000000021', 'e9720000-0000-4000-8000-000000000001', '老闆甲', true, 'UadminA972'),
  ('e9720000-0000-4000-8000-000000000032', 'e9720000-0000-4000-8000-000000000022', 'e9720000-0000-4000-8000-000000000002', '老闆乙', true, 'UadminB972');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit, line_bound, line_user_id) values
  ('e9720000-0000-4000-8000-000000000051', 'e9720000-0000-4000-8000-000000000021', 'e9720000-0000-4000-8000-000000000003', '服務人員A', 'active', 'active', '0900097211', true, true, 'UstaffA972'),
  ('e9720000-0000-4000-8000-000000000052', 'e9720000-0000-4000-8000-000000000022', null, '服務人員B', 'active', 'not_invited', '0900097212', true, true, 'UstaffB972');
select seed_default_staff_permissions('e9720000-0000-4000-8000-000000000051');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from generate_series(0, 6) as d,
     unnest(array['e9720000-0000-4000-8000-000000000021'::uuid, 'e9720000-0000-4000-8000-000000000022'::uuid]) as m;
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e9720000-0000-4000-8000-000000000061', 'e9720000-0000-4000-8000-000000000021', '剪髮A', 800, 'primary', 40),
  ('e9720000-0000-4000-8000-000000000062', 'e9720000-0000-4000-8000-000000000022', '剪髮B', 900, 'primary', 40);
insert into payment_methods (id, merchant_id, name) values
  ('e9720000-0000-4000-8000-000000000071', 'e9720000-0000-4000-8000-000000000021', '現場付款A'),
  ('e9720000-0000-4000-8000-000000000072', 'e9720000-0000-4000-8000-000000000022', '現場付款B');
select seed_default_line_event_settings('e9720000-0000-4000-8000-000000000021');
select seed_default_line_event_settings('e9720000-0000-4000-8000-000000000022');
select seed_default_member_settings('e9720000-0000-4000-8000-000000000021');
select seed_default_member_settings('e9720000-0000-4000-8000-000000000022');

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected)
values ('e9720000-0000-4000-8000-000000000021', 'chid', 'secret', 'token-req972', true);
update merchant_line_event_settings
set enabled = true, notify_admin = true, notify_agent = true, notify_staff = true, notify_member = true
where merchant_id = 'e9720000-0000-4000-8000-000000000021'
  and event_type in ('booking_confirmed', 'staff_leave_created');

insert into merchant_leave_types (id, merchant_id, name) values
  ('e9720000-0000-4000-8000-000000000081', 'e9720000-0000-4000-8000-000000000021', '特休A'),
  ('e9720000-0000-4000-8000-000000000082', 'e9720000-0000-4000-8000-000000000022', '特休B');
insert into staff_leave_records (id, staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status) values
  ('e9720000-0000-4000-8000-000000000091', 'e9720000-0000-4000-8000-000000000051', 'e9720000-0000-4000-8000-000000000081', '特休A', '2026-12-01', '2026-12-01', 'confirmed'),
  ('e9720000-0000-4000-8000-000000000092', 'e9720000-0000-4000-8000-000000000052', 'e9720000-0000-4000-8000-000000000082', '特休B', '2026-12-02', '2026-12-02', 'confirmed');

select pg_temp.test_set_auth('e9720000-0000-4000-8000-000000000001');
select id from create_member('e9720000-0000-4000-8000-000000000021', '會員A', '0933097201') \gset memA_
select id from create_booking(
  p_merchant_id => 'e9720000-0000-4000-8000-000000000021',
  p_staff_id => 'e9720000-0000-4000-8000-000000000051',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9720000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-05 10:00:00+08',
  p_customer_name => 'A店客戶',
  p_customer_phone => '0955097201',
  p_member_id => :'memA_id'::uuid,
  p_payment_method_id => 'e9720000-0000-4000-8000-000000000071') \gset bkA_
select id from create_booking(
  p_merchant_id => 'e9720000-0000-4000-8000-000000000021',
  p_staff_id => 'e9720000-0000-4000-8000-000000000051',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9720000-0000-4000-8000-000000000061','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-06 10:00:00+08',
  p_customer_name => 'A店客戶二',
  p_customer_phone => '0955097202',
  p_member_id => :'memA_id'::uuid,
  p_payment_method_id => 'e9720000-0000-4000-8000-000000000071') \gset bkA2_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e9720000-0000-4000-8000-000000000002');
select id from create_member('e9720000-0000-4000-8000-000000000022', '會員B', '0933097202') \gset memB_
select id from create_booking(
  p_merchant_id => 'e9720000-0000-4000-8000-000000000022',
  p_staff_id => 'e9720000-0000-4000-8000-000000000052',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9720000-0000-4000-8000-000000000062','quantity',1,'unit_price',900)),
  p_start_at => '2026-12-05 11:00:00+08',
  p_customer_name => 'B店機密客戶',
  p_customer_phone => '0955097203',
  p_member_id => :'memB_id'::uuid,
  p_payment_method_id => 'e9720000-0000-4000-8000-000000000072') \gset bkB_
select pg_temp.test_clear_auth();

update members set line_bound = true, line_user_id = 'UmemberA972' where id = :'memA_id'::uuid;
update members set line_bound = true, line_user_id = 'UmemberB972' where id = :'memB_id'::uuid;

-- =========================================================================
-- ①~④ 權限衛生(supabase-permission-hygiene 規則 1)+ 舊簽章確實移除
-- =========================================================================
select ok(not has_function_privilege('public', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.resolve_line_notification_targets(uuid,text,uuid,uuid)', 'execute'),
  '① #972 權限衛生:resolve_line_notification_targets 只有 service_role');
select ok(not has_function_privilege('public', 'public.render_booking_notification_variables(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.render_booking_notification_variables(uuid,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.render_booking_notification_variables(uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.render_booking_notification_variables(uuid,uuid)', 'execute'),
  '② #972 權限衛生:新簽章 render_booking_notification_variables(uuid,uuid) 只有 service_role');
select ok(not has_function_privilege('public', 'public.render_staff_leave_notification_variables(uuid,uuid)', 'execute')
      and not has_function_privilege('anon', 'public.render_staff_leave_notification_variables(uuid,uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.render_staff_leave_notification_variables(uuid,uuid)', 'execute')
      and has_function_privilege('service_role', 'public.render_staff_leave_notification_variables(uuid,uuid)', 'execute'),
  '③ #972 權限衛生:新簽章 render_staff_leave_notification_variables(uuid,uuid) 只有 service_role');
select ok(
  to_regprocedure('public.render_booking_notification_variables(uuid)') is null
  and to_regprocedure('public.render_staff_leave_notification_variables(uuid)') is null
  and (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('render_booking_notification_variables', 'render_staff_leave_notification_variables')) = 2
  and (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'render_booking_notification_variables') = 'p_booking_id uuid, p_merchant_id uuid'
  and (select pg_get_function_identity_arguments(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'render_staff_leave_notification_variables') = 'p_staff_leave_record_id uuid, p_merchant_id uuid',
  '④ #972:舊的單參數簽章已移除、各只剩一支,參數名 = Edge Function 送出的 p_booking_id / p_staff_leave_record_id / p_merchant_id(錯了就是 PGRST202)');

-- 以下都以 service_role(= Edge Function)身分呼叫
select pg_temp.test_set_auth('e9720000-0000-4000-8000-000000000001', 'service_role');

-- =========================================================================
-- ⑤~⑧ resolve_line_notification_targets
-- =========================================================================
select throws_ok(
  format($$select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000021', 'booking_confirmed', '%s', null)$$, :'bkB_id'),
  'P0002', null,
  '⑤ #972(核心):A 商家帶 B 商家的訂單編號 → 丟錯,不回任何收件人');
select throws_ok(
  $$select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000021', 'staff_leave_created', null, 'e9720000-0000-4000-8000-000000000092')$$,
  'P0002', null,
  '⑥ #972(核心):A 商家帶 B 商家的請假紀錄編號 → 丟錯');
select throws_ok(
  format($$select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000022', 'booking_confirmed', '%s', null)$$, :'bkA_id'),
  'P0002', null,
  '⑦ #972:檢查排在「是否已連線 LINE」之前 —— B 店(未連線)帶 A 店訂單也丟錯,不是回 connected=false');
select throws_ok(
  $$select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000021', 'booking_confirmed', '00000000-0000-4000-8000-000000000000', null)$$,
  'P0002', null,
  '⑧ #972:不存在的訂單編號同樣丟錯(訊息不區分不存在/別家的)');

select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkA_id'::uuid, null) as r \gset okA_
select is(
  (select array_agg(t->>'line_user_id' order by t->>'line_user_id') from jsonb_array_elements(:'okA_r'::jsonb->'targets') t),
  array['UadminA972', 'UmemberA972', 'UstaffA972'],
  '⑬ #972 正向對照:同商家訂單照常算出管理員/服務人員/會員三位收件人(行為不變)');

select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000021', 'staff_leave_created', null, 'e9720000-0000-4000-8000-000000000091'::uuid) as r \gset okLv_
select is((:'okLv_r'::jsonb->>'event_enabled')::boolean, true,
  '⑭ #972 正向對照:同商家請假紀錄照常通過(不丟錯)');

-- =========================================================================
-- ⑨~⑪ render_booking_notification_variables
-- =========================================================================
select throws_ok(
  format($$select public.render_booking_notification_variables('%s', 'e9720000-0000-4000-8000-000000000021')$$, :'bkB_id'),
  'P0002', null,
  '⑨ #972(核心):用 A 商家組 B 商家訂單的文案變數 → 丟錯(B 的客戶姓名不會進 A 的通知)');
select throws_ok(
  format($$select public.render_booking_notification_variables('%s', null)$$, :'bkA_id'),
  'P0002', null,
  '⑩ #972:p_merchant_id 為 null 也丟錯(fail closed,不會退回成只看訂單編號)');
select is(
  public.render_booking_notification_variables(:'bkA_id'::uuid, 'e9720000-0000-4000-8000-000000000021') ->> 'customer_name',
  'A店客戶',
  '⑪ #972 正向對照:同商家訂單照常組出 customer_name');
select is(
  public.render_booking_notification_variables(:'bkA_id'::uuid, 'e9720000-0000-4000-8000-000000000021') ->> 'staff_name',
  '服務人員A',
  '⑮ #972 正向對照:同商家訂單照常組出 staff_name');

-- =========================================================================
-- ⑫ ⑯ ⑰ render_staff_leave_notification_variables
-- =========================================================================
select throws_ok(
  $$select public.render_staff_leave_notification_variables('e9720000-0000-4000-8000-000000000092', 'e9720000-0000-4000-8000-000000000021')$$,
  'P0002', null,
  '⑫ #972(核心):用 A 商家組 B 商家請假紀錄的文案變數 → 丟錯');
select is(
  public.render_staff_leave_notification_variables('e9720000-0000-4000-8000-000000000091', 'e9720000-0000-4000-8000-000000000021') ->> 'staff_name',
  '服務人員A',
  '⑯ #972 正向對照:同商家請假紀錄照常組出 staff_name');
select is(
  public.render_staff_leave_notification_variables('00000000-0000-4000-8000-000000000000', 'e9720000-0000-4000-8000-000000000021')::text,
  '{}',
  '⑰ #972:查無此請假紀錄維持既有行為回 {}(module11_03 的安靜路徑不變)');

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑱⑲ 順帶修的 merchant_id 條件(縱深防禦):就算資料本身壞掉 —— A 店訂單的服務人員/會員欄位
--     指到 B 店的人 —— 也不會把 B 店服務人員/會員的 line_user_id 算成 A 的收件人。
--     (正常流程 create_booking 會擋,這裡以 postgres 身分直接改資料模擬壞資料。)
-- =========================================================================
alter table bookings disable trigger user;
update bookings
set staff_id = 'e9720000-0000-4000-8000-000000000052', member_id = :'memB_id'::uuid
where id = :'bkA2_id'::uuid;
alter table bookings enable trigger user;

select pg_temp.test_set_auth('e9720000-0000-4000-8000-000000000001', 'service_role');
select public.resolve_line_notification_targets('e9720000-0000-4000-8000-000000000021', 'booking_confirmed', :'bkA2_id'::uuid, null) as r \gset bad_
select pg_temp.test_clear_auth();

select ok(
  not exists (select 1 from jsonb_array_elements(:'bad_r'::jsonb->'targets') t where t->>'line_user_id' = 'UstaffB972')
  and exists (select 1 from jsonb_array_elements(:'bad_r'::jsonb->'skipped') s
              where s->>'type' = 'staff' and s->>'reason' = 'staff_inactive'),
  '⑱ #972 縱深:訂單的服務人員指到別家 → 不算收件人,記為 staff_inactive(視同找不到)');
select ok(
  not exists (select 1 from jsonb_array_elements(:'bad_r'::jsonb->'targets') t where t->>'line_user_id' = 'UmemberB972')
  and exists (select 1 from jsonb_array_elements(:'bad_r'::jsonb->'skipped') s
              where s->>'type' = 'member' and s->>'reason' = 'target_not_bound'),
  '⑲ #972 縱深:訂單的會員指到別家 → 不算收件人,記為 target_not_bound');

-- =========================================================================
-- ⑳ ㉑ ㉒ 前端預覽 preview_line_notification_targets(內部以訂單自己的商家呼叫 resolve)行為不變
-- =========================================================================
select pg_temp.test_set_auth('e9720000-0000-4000-8000-000000000001');
select preview_line_notification_targets(:'bkA_id'::uuid, 'booking_confirmed') as r \gset prev_
select is((:'prev_r'::jsonb->>'has_any_target')::boolean, true,
  '⑳ #972 正向對照:A 店管理員預覽自己訂單的通知對象照常運作');
select throws_ok(
  format($$select preview_line_notification_targets('%s', 'booking_confirmed')$$, :'bkB_id'),
  '42501', null,
  '㉑ 既有行為:A 店管理員預覽 B 店訂單仍被權限檢查擋下');
select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from line_notification_log
   where merchant_id = 'e9720000-0000-4000-8000-000000000021' and booking_id = :'bkB_id'::uuid),
  0,
  '㉒ 資料庫函式全程唯讀:沒有任何 A 商家名下、帶 B 店訂單編號的發送記錄');

select * from finish();
rollback;
