-- 客戶端第 3 批 — 送出預約核心 public.internal_customer_submit_booking(C3-A01~A05、C3-C03、C3-E01、F01~F04)
-- 規格書 .project/specs/客戶端第3批-送出預約與通知店家.md(「零之零」優先)
--
--   A01  check / 唯一索引 / 「只有客人訂單能有 submission id」
--   A03  會員:成功 / 自動接受 / 黑名單待確認 / 未接上(needs_profile、別的 channel、不是客人帳號)
--        訪客:成功(新建未驗證會員)/ 不允許 / 電話格式 / 沒勾同意 / 對到既有會員(不改會員)/ 對到 2 位
--        不指定:依順位挑第一位能排的;同順位取 created_at 最早;slot_taken(被佔、未上架、不會做)
--        too_many_open(第 4 張擋、過期未完成不算、後台建的不算);同 submission_id 重送只有一張;到府店地址必填
--        單價 = 資料庫價格;操作紀錄角色 customer;同意紀錄只有訪客寫
--   A04  「看得到 = 送得出」對照(指定 / 不指定各一天)
--   A05 / F03  回傳格式與哨兵(回應去掉 _internal 後搜不到任何哨兵、服務人員 id、member_id)
--   F01  draft 多塞 unit_price / final_amount / status / member_id / user_id 不影響
--   F04  別家的項目 / 服務人員 / slug
--   C03  客人訂單可以被 staff_confirm_booking / confirm_booking 確認
--   E01  get_my_booking_schedule 多回 source / is_guest_booking
--   並發:pgTAP 環境沒有 dblink(只有一條連線),無法真的開兩個交易同時送;改測「店層級鎖 + 唯一索引」中的唯一索引
--         (A01-5),鎖本身由程式碼審查確認(兩個交易都要先拿同一把 pg_advisory_xact_lock 才會查時段)。
begin;

select plan(68);

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

create temp table c3_ctx as select ((now() at time zone 'Asia/Taipei')::date + 3) as d0;
create function pg_temp.d(n integer) returns date language sql stable as $$ select d0 + n from c3_ctx $$;
create function pg_temp.ts(n integer, t time) returns timestamptz language sql stable as
  $$ select ((select d0 from c3_ctx) + n + t) at time zone 'Asia/Taipei' $$;

create function pg_temp.draft(p_items jsonb, p_staff uuid, p_n integer, p_time text, p_name text,
                              p_address text default null, p_notes text default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', p_items, 'staff_id', p_staff, 'date', to_char(pg_temp.d(p_n), 'YYYY-MM-DD'),
                            'time', p_time, 'name', p_name, 'address', p_address, 'notes', p_notes)
$$;
create function pg_temp.p1(p_qty integer default 1) returns jsonb language sql immutable as
  $$ select jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000081', 'quantity', p_qty)) $$;

-- 送出;把每次的結果存起來給哨兵測試用
create temp table c3_results (label text, result jsonb);
create function pg_temp.sub(p_label text, p_slug text, p_user uuid, p_phone text, p_draft jsonb, p_agree boolean, p_sid uuid)
returns jsonb language plpgsql as $$
declare v jsonb;
begin
  v := public.internal_customer_submit_booking(p_slug, p_user, p_phone, p_draft, p_agree, p_sid);
  insert into c3_results values (p_label, v);
  return v;
end $$;
-- 送出;回 'state:xxx' 或 'sqlstate:hint'
create function pg_temp.sub_err(p_slug text, p_user uuid, p_phone text, p_draft jsonb, p_agree boolean, p_sid uuid)
returns text language plpgsql as $$
declare v jsonb; v_hint text;
begin
  v := public.internal_customer_submit_booking(p_slug, p_user, p_phone, p_draft, p_agree, p_sid);
  insert into c3_results values ('err-path', v);
  return 'state:' || coalesce(v ->> 'state', 'null');
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ':' || coalesce(v_hint, '');
end $$;
-- 試送後回滾(A04 對照用)
create function pg_temp.try_state(p_staff uuid, p_n integer, p_time text)
returns text language plpgsql as $$
declare v_state text;
begin
  begin
    v_state := public.internal_customer_submit_booking('pgtap-c3-shop', null, '0912399999',
      pg_temp.draft(pg_temp.p1(), p_staff, p_n, p_time, '對照客人'), true, gen_random_uuid()) ->> 'state';
    raise exception using errcode = 'P0099', message = coalesce(v_state, 'null');
  exception when sqlstate 'P0099' then
    return sqlerrm;
  end;
end $$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c3000000-0000-4000-8000-000000000001', 'pgtap-c3-admin@test.local', '{}'::jsonb),
  ('c3000000-0000-4000-8000-000000000002', 'pgtap-c3-agent-orders@test.local', '{}'::jsonb),
  ('c3000000-0000-4000-8000-000000000004', 'pgtap-c3-staff-a@test.local', '{}'::jsonb),
  ('c3000000-0000-4000-8000-000000000011', 'line-c3-11@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c3000000-0000-4000-8000-000000000012', 'line-c3-12@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c3000000-0000-4000-8000-000000000013', 'line-c3-13@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c3000000-0000-4000-8000-000000000014', 'line-c3-14@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c3000000-0000-4000-8000-000000000015', 'pgtap-c3-not-customer@test.local', '{}'::jsonb);

insert into groups (id) values ('c3000000-0000-4000-8000-000000000091'), ('c3000000-0000-4000-8000-000000000092');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000091', 'C3到店', 'in_store_beauty', 'pgtap-c3-shop', 'active'),
  ('c3000000-0000-4000-8000-000000000022', 'c3000000-0000-4000-8000-000000000091', 'C3到府', 'on_site_dispatch', 'pgtap-c3-home', 'active'),
  ('c3000000-0000-4000-8000-000000000023', 'c3000000-0000-4000-8000-000000000092', 'C3不收訪客', 'in_store_beauty', 'pgtap-c3-noguest', 'active'),
  ('c3000000-0000-4000-8000-000000000024', 'c3000000-0000-4000-8000-000000000092', 'C3停用', 'in_store_beauty', 'pgtap-c3-off', 'disabled');
insert into merchant_admins (merchant_id, user_id) values
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('c3000000-0000-4000-8000-000000000071', 'c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000002', 'C3客服', '0900300071', 'pgtap-c3-agent-orders@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c3000000-0000-4000-8000-000000000071', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '09:00', '18:00' from generate_series(0, 6) d,
  unnest(array['c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000022',
               'c3000000-0000-4000-8000-000000000023', 'c3000000-0000-4000-8000-000000000024']::uuid[]) m;
insert into merchant_booking_settings (merchant_id, start_time_interval_minutes, min_lead_hours, travel_buffer_minutes, allow_guest_booking) values
  ('c3000000-0000-4000-8000-000000000021', 30, 0, 0, true),
  ('c3000000-0000-4000-8000-000000000022', 30, 0, 0, true),
  ('c3000000-0000-4000-8000-000000000023', 30, 0, 0, false);

insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled)
values ('c3000000-0000-4000-8000-000000000021', '1111111111', vault.create_secret('C3FAKESECRET000000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name) values
  ('c3000000-0000-4000-8000-000000000011', '1111111111', 'U-c3-11', 'LINE11'),
  ('c3000000-0000-4000-8000-000000000012', '1111111111', 'U-c3-12', 'LINE12'),
  ('c3000000-0000-4000-8000-000000000013', '2222222222', 'U-c3-13', 'LINE13'),
  ('c3000000-0000-4000-8000-000000000014', '1111111111', 'U-c3-14', 'LINE14');

insert into merchant_staff (id, merchant_id, name, nickname, phone, is_listed, status, user_id, login_status, auto_accept_booking, display_order) values
  ('c3000000-0000-4000-8000-000000000031', 'c3000000-0000-4000-8000-000000000021', 'C3_SA_REALNAME', '阿明', '0900300031', true, 'active', 'c3000000-0000-4000-8000-000000000004', 'active', false, 1),
  ('c3000000-0000-4000-8000-000000000032', 'c3000000-0000-4000-8000-000000000021', 'C3_SB_REALNAME', '小陳', '0900300032', true, 'active', null, 'not_invited', true, 2),
  ('c3000000-0000-4000-8000-000000000033', 'c3000000-0000-4000-8000-000000000021', 'C3_SC_UNLISTED', null, '0900300033', false, 'active', null, 'not_invited', false, 3),
  ('c3000000-0000-4000-8000-000000000034', 'c3000000-0000-4000-8000-000000000021', 'C3_SD_REMOVED', null, '0900300034', true, 'removed', null, 'not_invited', false, 4),
  ('c3000000-0000-4000-8000-000000000035', 'c3000000-0000-4000-8000-000000000021', 'C3_SE_REALNAME', '只會P2', '0900300035', true, 'active', null, 'not_invited', false, 5),
  ('c3000000-0000-4000-8000-000000000036', 'c3000000-0000-4000-8000-000000000022', 'C3_HOME_STAFF', null, '0900300036', true, 'active', null, 'not_invited', false, 1),
  ('c3000000-0000-4000-8000-000000000037', 'c3000000-0000-4000-8000-000000000023', 'C3_NOGUEST_STAFF', null, '0900300037', true, 'active', null, 'not_invited', false, 1);
update merchant_staff set created_at = now() - interval '10 days' where id = 'c3000000-0000-4000-8000-000000000031';
update merchant_staff set created_at = now() - interval '5 days' where id = 'c3000000-0000-4000-8000-000000000032';
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('c3000000-0000-4000-8000-000000000031', 'staff_calendar_view', true);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select s, d, '09:00', '18:00' from generate_series(0, 6) d,
  unnest(array['c3000000-0000-4000-8000-000000000031', 'c3000000-0000-4000-8000-000000000032', 'c3000000-0000-4000-8000-000000000033',
               'c3000000-0000-4000-8000-000000000034', 'c3000000-0000-4000-8000-000000000035', 'c3000000-0000-4000-8000-000000000036',
               'c3000000-0000-4000-8000-000000000037']::uuid[]) s;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('c3000000-0000-4000-8000-000000000081', 'c3000000-0000-4000-8000-000000000021', 'C3主要P1', 1000, 'primary', 60, 'active'),
  ('c3000000-0000-4000-8000-000000000082', 'c3000000-0000-4000-8000-000000000021', 'C3加購A1', 200, 'addon', 30, 'active'),
  ('c3000000-0000-4000-8000-000000000083', 'c3000000-0000-4000-8000-000000000021', 'C3主要P2', 1500, 'primary', 60, 'active'),
  ('c3000000-0000-4000-8000-000000000084', 'c3000000-0000-4000-8000-000000000022', 'C3到府HP', 2000, 'primary', 60, 'active'),
  ('c3000000-0000-4000-8000-000000000085', 'c3000000-0000-4000-8000-000000000023', 'C3不收訪客P', 800, 'primary', 60, 'active');
insert into merchant_staff_service_items (staff_id, service_item_id) values
  ('c3000000-0000-4000-8000-000000000035', 'c3000000-0000-4000-8000-000000000083');

insert into members (id, merchant_id, name, phone, referral_code, user_id, is_blacklisted, notes) values
  ('c3000000-0000-4000-8000-000000000041', 'c3000000-0000-4000-8000-000000000021', 'C3_MEMBER1_NAME', '0912300041', 'C3REF041', 'c3000000-0000-4000-8000-000000000011', false, null),
  ('c3000000-0000-4000-8000-000000000042', 'c3000000-0000-4000-8000-000000000021', 'C3_MEMBER2_BL', '0912300042', 'C3REF042', 'c3000000-0000-4000-8000-000000000012', true, null),
  ('c3000000-0000-4000-8000-000000000043', 'c3000000-0000-4000-8000-000000000021', 'C3_EXISTING_MEMBER_NAME', '0912300043', 'C3REF043', null, false, 'C3_MEMBER_NOTES_SENTINEL');

-- 既有訂單:SA 在 d1 10:00-11:00、d6 11:00-12:00 忙(後台單,含內部備註哨兵)
insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, notes) values
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000031', pg_temp.ts(1, '10:00'), pg_temp.ts(1, '11:00'),
   'C3_OTHER_CUSTOMER_NAME', '0912300088', 'admin', 'accepted', 'manual', 'C3_INTERNAL_NOTES_SENTINEL'),
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000031', pg_temp.ts(6, '11:00'), pg_temp.ts(6, '12:00'),
   'C3_OTHER_CUSTOMER_NAME', '0912300088', 'admin', 'accepted', 'manual', 'C3_INTERNAL_NOTES_SENTINEL');

-- =========================================================================
-- A01
-- =========================================================================
select lives_ok($$insert into booking_status_change_logs (booking_id, merchant_id, from_status, to_status, actor_name_snapshot, actor_role_snapshot)
  select id, merchant_id, null, status, '客人 測試', 'customer' from bookings where customer_name = 'C3_OTHER_CUSTOMER_NAME' limit 1$$,
  'A01-1 操作紀錄角色可寫 customer');
select throws_ok($$insert into booking_status_change_logs (booking_id, merchant_id, from_status, to_status, actor_name_snapshot, actor_role_snapshot)
  select id, merchant_id, null, status, 'x', 'hacker' from bookings where customer_name = 'C3_OTHER_CUSTOMER_NAME' limit 1$$,
  '23514', null, 'A01-2 操作紀錄角色亂值被拒');
select lives_ok($$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body)
  values ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'booking_created', 't', 'b'),
         ('c3000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), 'customer_booking_created', 't', 'b')$$,
  'A01-3 鈴鐺舊事件與 customer_booking_created 都可寫');
select throws_ok($$insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, customer_submission_id)
  values ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(30, '10:00'), pg_temp.ts(30, '11:00'),
          'x', '0912300077', 'admin', 'accepted', 'manual', gen_random_uuid())$$,
  '23514', null, 'A01-4 後台訂單不能帶 customer_submission_id');
select throws_ok($$insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, customer_submission_id)
  values ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(30, '10:00'), pg_temp.ts(30, '11:00'),
          'x', '0912300077', 'customer', 'pending_confirmation', 'customer', 'c3000000-0000-4000-8000-0000000000f1'),
         ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(31, '10:00'), pg_temp.ts(31, '11:00'),
          'x', '0912300077', 'customer', 'pending_confirmation', 'customer', 'c3000000-0000-4000-8000-0000000000f1')$$,
  '23505', null, 'A01-5 同店同 customer_submission_id 第二列被唯一索引擋');

-- =========================================================================
-- 會員送出
-- =========================================================================
select is(pg_temp.sub('m-ok', 'pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000011', null,
            pg_temp.draft(pg_temp.p1(2), 'c3000000-0000-4000-8000-000000000031', 2, '10:00', '王小明') || '{"unit_price":0,"final_amount":0,"status":"accepted","member_id":"c3000000-0000-4000-8000-000000000043","user_id":"c3000000-0000-4000-8000-000000000012"}'::jsonb,
            true, 'c3000000-0000-4000-8000-0000000000a1') - '_internal',
  jsonb_build_object('state', 'created', 'completion_message', '店家確認後會通知你。', 'booking', jsonb_build_object(
    'status', 'pending_confirmation', 'start_at', pg_temp.ts(2, '10:00'), 'end_at', pg_temp.ts(2, '12:00'),
    'staff_display', '阿明', 'items', jsonb_build_array(jsonb_build_object('name', 'C3主要P1', 'quantity', 2)),
    'address', null, 'phone', null, 'estimated_amount', 2000, 'is_guest', false)),
  'A03-1 會員指定 SA 成功:待確認、顯示暱稱、金額 = 資料庫單價 × 數量、會員不回電話(F01 多塞的鍵被忽略)');
select is((select row(b.member_id, b.customer_phone, b.customer_name, b.source, b.created_by_role, b.created_by_user_id, b.is_guest_booking,
                     b.status, b.final_amount_snapshot::integer, b.member_name_snapshot, b.customer_notes, b.notes)::text
           from bookings b where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000a1'),
  row('c3000000-0000-4000-8000-000000000041'::uuid, '0912300041'::text, '王小明'::text, 'customer'::text, 'customer'::text,
      'c3000000-0000-4000-8000-000000000011'::uuid, false, 'pending_confirmation'::text, 2000::integer, 'C3_MEMBER1_NAME'::text, null::text, null::text)::text,
  'A03-2 寫入:member = 接上的會員、電話 = 會員資料電話、姓名 = 這次填的、source / created_by = customer');
select is((select array_agg(bsi.unit_price_snapshot::integer::text || 'x' || bsi.quantity || '/' || bsi.duration_minutes_snapshot)
           from booking_service_items bsi join bookings b on b.id = bsi.booking_id
           where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000a1'),
  array['1000x2/60'], 'A03-3 / F01 單價快照 = 資料庫價格(draft 的 unit_price 0 無效)');
select is((select l.actor_role_snapshot || '|' || l.actor_name_snapshot || '|' || coalesce(l.from_status, 'null') || '|' || l.to_status
           from booking_status_change_logs l join bookings b on b.id = l.booking_id
           where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000a1'),
  'customer|客人 王小明|null|pending_confirmation', 'A03-4 操作紀錄:角色 customer、「客人 王小明」');
select is((select count(*)::int from customer_policy_consents where merchant_id = 'c3000000-0000-4000-8000-000000000021' and context = 'guest_booking'),
  0, 'A03-5 會員送出不寫同意紀錄');

select is(pg_temp.sub('m-ok', 'pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000011', null,
            pg_temp.draft(pg_temp.p1(2), 'c3000000-0000-4000-8000-000000000031', 2, '10:00', '王小明'), true,
            'c3000000-0000-4000-8000-0000000000a1') - '_internal' ->> 'state',
  'created', 'A03-6 同 submission_id 重送 ⇒ 回原本那張單的結果');
select is((select count(*)::int from bookings where customer_submission_id = 'c3000000-0000-4000-8000-0000000000a1'),
  1, 'A03-7 同 submission_id 重送只有一張');
select is(public.internal_customer_submit_booking('pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000011', null,
            pg_temp.draft(pg_temp.p1(2), 'c3000000-0000-4000-8000-000000000031', 2, '10:00', '王小明'), true,
            'c3000000-0000-4000-8000-0000000000a1') -> '_internal' ->> 'replayed',
  'true', 'A03-8 重送時 _internal.replayed = true(Edge 不再發推播)');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300041',
            pg_temp.draft(pg_temp.p1(2), 'c3000000-0000-4000-8000-000000000031', 2, '10:00', '王小明'), true,
            'c3000000-0000-4000-8000-0000000000a1'),
  '22023:invalid_request', 'A03-9 別人(訪客)拿同一個 submission_id ⇒ 錯誤,不回別人的訂單');

select is(pg_temp.sub('m-auto', 'pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000011', null,
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000032', 2, '14:00', '王小明'), true, gen_random_uuid())
          -> 'booking' ->> 'status',
  'accepted', 'A03-10 指定開了「客戶預約自動接受」的 SB ⇒ 直接成立');
select is((select result ->> 'completion_message' from c3_results where label = 'm-auto'),
  '服務前店家可能會再跟你聯絡確認。', 'A05-1 直接成立且店家沒填會員文字 ⇒ 預設「服務前店家可能會再跟你聯絡確認。」(completion_message 在最外層)');
select is(pg_temp.sub('m-bl', 'pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000012', null,
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000032', 2, '16:00', '黑名單客'), true, gen_random_uuid())
          -> 'booking' ->> 'status',
  'pending_confirmation', 'A03-11 黑名單會員就算指定自動接受的 SB 也是待確認');

select is(pg_temp.sub_err('pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000014', null,
            pg_temp.draft(pg_temp.p1(), null, 3, '10:00', '還沒填資料'), true, gen_random_uuid()),
  'state:not_linked', 'A03-12 還沒接上會員(needs_profile)⇒ not_linked');
select is(pg_temp.sub_err('pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000013', null,
            pg_temp.draft(pg_temp.p1(), null, 3, '10:00', '別的channel'), true, gen_random_uuid()),
  'state:not_linked', 'A03-13 / F04 別店 channel 的客人帳號 ⇒ not_linked');
select is(pg_temp.sub_err('pgtap-c3-shop', 'c3000000-0000-4000-8000-000000000015', null,
            pg_temp.draft(pg_temp.p1(), null, 3, '10:00', '後台帳號'), true, gen_random_uuid()),
  'state:not_linked', 'A03-14 不是客人帳號 ⇒ not_linked');
select is(pg_temp.sub_err('pgtap-c3-home', 'c3000000-0000-4000-8000-000000000011', null,
            jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000084', 'quantity', 1)),
                               'staff_id', null, 'date', to_char(pg_temp.d(3), 'YYYY-MM-DD'), 'time', '10:00', 'name', 'A店客人', 'address', '台北市'),
            true, gen_random_uuid()),
  'state:not_linked', 'A03-15 / F04 A 店的客人拿 B 店 slug(B 店沒有 LINE 登入)⇒ not_linked');

-- =========================================================================
-- 不指定:依順位挑第一位能排的
-- =========================================================================
select is(pg_temp.sub('u-free', 'pgtap-c3-shop', null, '0912300051',
            pg_temp.draft(pg_temp.p1(), null, 4, '10:00', '不指定甲'), true, gen_random_uuid()) -> 'booking' ->> 'staff_display',
  '阿明', 'A03-16 不指定、大家都有空 ⇒ 順位 1 的 SA(完成頁顯示被排到的那位)');
select is(pg_temp.sub('u-busy', 'pgtap-c3-shop', null, '0912300052',
            pg_temp.draft(pg_temp.p1(), null, 1, '10:00', '不指定乙'), true, gen_random_uuid()) -> 'booking' ->> 'staff_display',
  '小陳', 'A03-17 不指定、SA 那時段忙 ⇒ 順位 2 的 SB');
update merchant_staff set display_order = 1 where id = 'c3000000-0000-4000-8000-000000000032';
update merchant_staff set created_at = now() - interval '20 days' where id = 'c3000000-0000-4000-8000-000000000032';
select is(pg_temp.sub('u-tie', 'pgtap-c3-shop', null, '0912300053',
            pg_temp.draft(pg_temp.p1(), null, 5, '10:00', '不指定丙'), true, gen_random_uuid()) -> 'booking' ->> 'staff_display',
  '小陳', 'A03-18 同順位 ⇒ created_at 最早的那位');
update merchant_staff set display_order = 2, created_at = now() - interval '5 days' where id = 'c3000000-0000-4000-8000-000000000032';
update merchant_staff set display_order = 9 where id = 'c3000000-0000-4000-8000-000000000031';
select is(pg_temp.sub('u-order', 'pgtap-c3-shop', null, '0912300054',
            pg_temp.draft(pg_temp.p1(), null, 7, '10:00', '不指定丁'), true, gen_random_uuid()) -> 'booking' ->> 'staff_display',
  '小陳', 'A03-19 順位改變(SA 移到最後)⇒ 改挑 SB,不看單數');
update merchant_staff set display_order = 1 where id = 'c3000000-0000-4000-8000-000000000031';

-- slot_taken
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300055',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000031', 1, '10:00', '撞時段'), true, gen_random_uuid()),
  'state:slot_taken', 'A03-20 指定 SA、時段被佔 ⇒ slot_taken');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300055',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000033', 8, '10:00', '未上架'), true, gen_random_uuid()),
  'state:slot_taken', 'A03-21 指定未上架的服務人員 ⇒ slot_taken');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300055',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000035', 8, '10:00', '不會做'), true, gen_random_uuid()),
  'state:slot_taken', 'A03-22 指定不會做 P1 的服務人員 ⇒ slot_taken');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300055',
            pg_temp.draft(pg_temp.p1(), null, 8, '20:00', '營業外'), true, gen_random_uuid()),
  'state:slot_taken', 'A03-23 不指定、營業時間外 ⇒ slot_taken');

-- =========================================================================
-- 訪客送出
-- =========================================================================
select is(pg_temp.sub('g-new', 'pgtap-c3-shop', null, ' 0912-300-061 ',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000031', 9, '10:00', '新訪客', null, '請按門鈴'), true,
            'c3000000-0000-4000-8000-0000000000b1') - '_internal',
  jsonb_build_object('state', 'created', 'completion_message', '店家確認後會與你聯絡。', 'booking', jsonb_build_object(
    'status', 'pending_confirmation', 'start_at', pg_temp.ts(9, '10:00'), 'end_at', pg_temp.ts(9, '11:00'),
    'staff_display', '阿明', 'items', jsonb_build_array(jsonb_build_object('name', 'C3主要P1', 'quantity', 1)),
    'address', null, 'phone', '0912-300-061', 'estimated_amount', 1000, 'is_guest', true)),
  'A03-24 訪客成功:一律待確認、回訪客填的電話、訪客預設完成頁文字');
select is((select row(b.is_guest_booking, b.member_auto_created, b.created_by_user_id is null, b.customer_notes, m.name, m.phone, m.user_id is null)::text
           from bookings b join members m on m.id = b.member_id where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000b1'),
  row(true, true, true, '請按門鈴'::text, '新訪客'::text, '0912300061'::text, true)::text,
  'A03-25 訪客:新建未驗證會員(member_auto_created)、備註寫 customer_notes');
select is((select l.actor_name_snapshot from booking_status_change_logs l join bookings b on b.id = l.booking_id
           where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000b1'),
  '訪客 新訪客', 'A03-26 操作紀錄「訪客 新訪客」');
select is((select count(*)::int from customer_policy_consents c join bookings b on b.member_id = c.member_id
           where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000b1' and c.context = 'guest_booking'
             and c.phone_normalized = '0912300061' and c.user_id is null and c.privacy_policy_version = '2026-10-08'),
  1, 'A03-27 訪客寫一筆同意紀錄');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300061',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000031', 9, '10:00', '新訪客'), true,
            'c3000000-0000-4000-8000-0000000000b1'),
  'state:created', 'A03-27a 訪客重送:同一支電話(格式不同,正規化後相同)⇒ 回原本那張單');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300062',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000031', 9, '10:00', '新訪客'), true,
            'c3000000-0000-4000-8000-0000000000b1'),
  '22023:invalid_request', 'A03-27b 別的訪客(電話不同)拿同一個 submission_id ⇒ 錯誤,不回別人的訂單');

create temp table c3_mem_before as select updated_at, name, phone, user_id from members where id = 'c3000000-0000-4000-8000-000000000043';
select is(pg_temp.sub('g-exist', 'pgtap-c3-shop', null, '0912300043',
            pg_temp.draft(pg_temp.p1(), null, 9, '14:00', '換個名字'), true, 'c3000000-0000-4000-8000-0000000000b2') ->> 'state',
  'created', 'A03-29 訪客電話對到既有會員 ⇒ 成功');
select is((select row(b.member_id, b.member_auto_created, b.customer_name, b.member_name_snapshot)::text from bookings b
           where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000b2'),
  row('c3000000-0000-4000-8000-000000000043'::uuid, false, '換個名字'::text, 'C3_EXISTING_MEMBER_NAME'::text)::text,
  'A03-30 接上既有會員、不是新建;訂單姓名 = 這次填的');
select ok((select (m.updated_at, m.name, m.phone, m.user_id) is not distinct from (b.updated_at, b.name, b.phone, b.user_id)
           from members m, c3_mem_before b where m.id = 'c3000000-0000-4000-8000-000000000043'),
  'A03-31 既有會員資料一個欄位都沒改');

select is(pg_temp.sub_err('pgtap-c3-noguest', null, '0912300062',
            jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000085', 'quantity', 1)),
                               'staff_id', null, 'date', to_char(pg_temp.d(3), 'YYYY-MM-DD'), 'time', '10:00', 'name', '不收'), true, gen_random_uuid()),
  'state:guest_not_allowed', 'A03-32 店家關閉不登入預約 ⇒ guest_not_allowed');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '電話錯'), true, gen_random_uuid()),
  '22023:invalid_phone', 'A03-33 電話格式錯 ⇒ invalid_phone');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '02-1234-5678#12',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '分機'), true, gen_random_uuid()),
  '22023:invalid_phone', 'A03-34 不收分機');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300063',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '沒勾'), false, gen_random_uuid()),
  '22023:policy_not_agreed', 'A03-35 訪客沒勾同意 ⇒ policy_not_agreed');

-- 對到 2 位會員(唯一索引 #931 之後新資料不會有;暫時拿掉索引模擬舊資料,交易結束回滾)
drop index members_merchant_active_phone_uniq;
insert into members (id, merchant_id, name, phone, referral_code) values
  ('c3000000-0000-4000-8000-000000000044', 'c3000000-0000-4000-8000-000000000021', 'C3_DUP_A', '0912300064', 'C3REF044'),
  ('c3000000-0000-4000-8000-000000000045', 'c3000000-0000-4000-8000-000000000021', 'C3_DUP_B', '0912-300-064', 'C3REF045');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300064',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '兩位'), true, gen_random_uuid()),
  'state:contact_store', 'A03-36 電話對到 2 位會員 ⇒ contact_store');

-- 到府店地址必填
select is(pg_temp.sub_err('pgtap-c3-home', null, '0912300065',
            jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000084', 'quantity', 1)),
                               'staff_id', null, 'date', to_char(pg_temp.d(3), 'YYYY-MM-DD'), 'time', '10:00', 'name', '沒地址', 'address', '  '),
            true, gen_random_uuid()),
  '22023:address_required', 'A03-37 到府店沒填地址 ⇒ address_required');
select is(pg_temp.sub_err('pgtap-c3-home', null, '0912300065',
            jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000084', 'quantity', 1)),
                               'staff_id', null, 'date', to_char(pg_temp.d(3), 'YYYY-MM-DD'), 'time', '10:00', 'name', '有地址', 'address', '台北市測試路 1 號'),
            true, gen_random_uuid()),
  'state:created', 'A03-38 到府店有地址 ⇒ 成功');

-- 草稿格式 / F04
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300066',
            jsonb_build_object('items', jsonb_build_array(jsonb_build_object('service_item_id', 'c3000000-0000-4000-8000-000000000084', 'quantity', 1)),
                               'staff_id', null, 'date', to_char(pg_temp.d(10), 'YYYY-MM-DD'), 'time', '10:00', 'name', '別家項目'), true, gen_random_uuid()),
  '22023:invalid_items', 'A03-39 / F04 別家的服務項目 ⇒ invalid_items');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300066',
            pg_temp.draft(pg_temp.p1(), 'c3000000-0000-4000-8000-000000000036', 10, '10:00', '別家服務人員'), true, gen_random_uuid()),
  '22023:invalid_draft', 'A03-40 / F04 別家的服務人員 ⇒ invalid_draft');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300066',
            pg_temp.draft(pg_temp.p1(21), null, 10, '10:00', '數量21'), true, gen_random_uuid()),
  '22023:invalid_items', 'A03-41 數量 21 ⇒ invalid_items(上限統一 1~20)');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300066',
            jsonb_set(pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '日期錯'), '{date}', '"2026-02-30"'), true, gen_random_uuid()),
  '22023:invalid_draft', 'A03-42 不存在的日期 ⇒ invalid_draft');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300066',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', repeat('長', 51)), true, gen_random_uuid()),
  '22023:invalid_draft', 'A03-43 姓名超過 50 字 ⇒ invalid_draft');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300066',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '沒有id'), true, null),
  '22023:invalid_request', 'A03-44 沒有 submission_id ⇒ invalid_request');
select is(pg_temp.sub_err('pgtap-c3-off', null, '0912300066',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '停用店'), true, gen_random_uuid()),
  'state:unavailable', 'A03-45 停用的店 ⇒ unavailable');
select is(pg_temp.sub_err('pgtap-c3-nope', null, '0912300066',
            pg_temp.draft(pg_temp.p1(), null, 10, '10:00', '不存在'), true, gen_random_uuid()),
  'state:unavailable', 'A03-46 不存在的代碼 ⇒ unavailable');

-- =========================================================================
-- too_many_open(電話 0912300099:2 張未來客人單 + 1 張過期客人單 + 1 張後台單)
-- =========================================================================
insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source) values
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(40, '10:00'), pg_temp.ts(40, '11:00'), 'x', '0912300099', 'customer', 'pending_confirmation', 'customer'),
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(41, '10:00'), pg_temp.ts(41, '11:00'), 'x', '0912-300-099', 'customer', 'accepted', 'customer'),
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(-10, '10:00'), pg_temp.ts(-10, '11:00'), 'x', '0912300099', 'customer', 'pending_confirmation', 'customer'),
  ('c3000000-0000-4000-8000-000000000021', 'c3000000-0000-4000-8000-000000000034', pg_temp.ts(42, '10:00'), pg_temp.ts(42, '11:00'), 'x', '0912300099', 'admin', 'accepted', 'manual');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300099',
            pg_temp.draft(pg_temp.p1(), null, 11, '10:00', '第三張'), true, gen_random_uuid()),
  'state:created', 'A03-47 已有 2 張未完成(過期未完成、後台單不算)⇒ 第 3 張可以');
select is(pg_temp.sub_err('pgtap-c3-shop', null, '0912300099',
            pg_temp.draft(pg_temp.p1(), null, 11, '14:00', '第四張'), true, gen_random_uuid()),
  'state:too_many_open', 'A03-48 第 4 張 ⇒ too_many_open');
select is((select count(*)::int from members where merchant_id = 'c3000000-0000-4000-8000-000000000021' and phone = '0912300099'),
  1, 'A03-49 超過上限時不會多建會員(只有第 3 張那次建的一位)');

-- =========================================================================
-- A04 看得到 = 送得出(d6:SA 11:00-12:00 忙;指定 SA 與不指定各一次;30 分格線全部 48 個時間)
-- =========================================================================
create temp table c3_listed as
select 'staff' as k, jsonb_array_elements_text(private.public_available_slots_at('pgtap-c3-shop', pg_temp.p1(), 'c3000000-0000-4000-8000-000000000031', pg_temp.d(6), 1, now()) -> 'days' -> 0 -> 'times') as t
union all
select 'any', jsonb_array_elements_text(private.public_available_slots_at('pgtap-c3-shop', pg_temp.p1(), null, pg_temp.d(6), 1, now()) -> 'days' -> 0 -> 'times');
select is(
  (select array_agg(g order by g) from (
     select to_char(make_time(h, m, 0), 'HH24:MI') as g from generate_series(0, 23) h, unnest(array[0, 30]) m
   ) x where pg_temp.try_state('c3000000-0000-4000-8000-000000000031', 6, g) = 'created'),
  (select array_agg(t order by t) from c3_listed where k = 'staff'),
  'A04-1 指定 SA:列出的時間全部送得出、沒列出的全部送不出');
select is(
  (select array_agg(g order by g) from (
     select to_char(make_time(h, m, 0), 'HH24:MI') as g from generate_series(0, 23) h, unnest(array[0, 30]) m
   ) x where pg_temp.try_state(null, 6, g) = 'created'),
  (select array_agg(t order by t) from c3_listed where k = 'any'),
  'A04-2 不指定:列出的時間全部送得出、沒列出的全部送不出');
select ok((select count(*) from c3_listed where k = 'staff') > 0 and not exists (select 1 from c3_listed where k = 'staff' and t = '11:00'),
  'A04-3 前置:SA 有可約時間且 11:00 不在清單(對照測試不是空集合)');

-- =========================================================================
-- A05 / F03 哨兵:回應(去掉 _internal)搜不到任何哨兵、服務人員 id、member_id
-- =========================================================================
select is(
  (select array_agg(distinct s order by s) from c3_results r,
     unnest(array['C3_SA_REALNAME', 'C3_SB_REALNAME', 'C3_SC_UNLISTED', 'C3_SD_REMOVED', 'C3_SE_REALNAME',
                  '0900300031', '0900300032', '0900300035', 'C3_OTHER_CUSTOMER_NAME', '0912300088', 'C3_EXISTING_MEMBER_NAME',
                  'C3_MEMBER1_NAME', 'C3_MEMBER2_BL', 'C3_MEMBER_NOTES_SENTINEL', 'C3_INTERNAL_NOTES_SENTINEL', 'C3_DUP_A', 'C3_DUP_B',
                  'c3000000-0000-4000-8000-00000000003', 'c3000000-0000-4000-8000-00000000004', 'c3000000-0000-4000-8000-0000000000a1',
                  '0912300041', '0912300042', 'blacklist', 'member_id', 'staff_id', '_internal']) s
   where (r.result - '_internal')::text like '%' || s || '%'),
  null, 'F03-1 所有回應(成功與各種失敗)都搜不到哨兵 / 服務人員 id / member_id / 會員電話');
select ok((select count(*) from c3_results) >= 20, 'F03-2 前置:哨兵測試涵蓋 20 次以上的回應');
select is(
  (select count(*)::int from c3_results r where r.label = 'u-busy' and (r.result - '_internal')::text like '%阿明%'),
  0, 'F03-3 不指定排到 SB 時,回應不會出現其他服務人員(SA)的名字');
select is(
  (select array_agg(k order by k) from c3_results r, jsonb_object_keys(r.result -> '_internal') k where r.label = 'g-new'),
  array['booking_id', 'merchant_id', 'push_body', 'push_title', 'replayed'],
  'F03-4 _internal 只有 Edge 需要的 5 個鍵(Edge 會刪掉再回給客人)');

-- =========================================================================
-- C03 確認接單沿用既有功能;E01 服務人員端多回 source / is_guest_booking
-- =========================================================================
create temp table c3_ids as
  select (select id from bookings where customer_submission_id = 'c3000000-0000-4000-8000-0000000000b1') as guest_booking,
         (select id from bookings where customer_submission_id = 'c3000000-0000-4000-8000-0000000000a1') as member_booking;
grant select on c3_ids, c3_ctx to authenticated;
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000004');
select is((public.staff_confirm_booking((select guest_booking from c3_ids))) ->> 'status',
  'accepted', 'C03-1 服務人員本人可以確認訪客的線上預約');
select is((select array_agg((e ->> 'source') || '/' || (e ->> 'is_guest_booking') order by e ->> 'start_at')
           from jsonb_array_elements(public.get_my_booking_schedule('c3000000-0000-4000-8000-000000000031', pg_temp.d(9), pg_temp.d(9))) e),
  array['customer/true', 'customer/true'], 'E01-1 get_my_booking_schedule 多回 source、is_guest_booking');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('c3000000-0000-4000-8000-000000000002');
select lives_ok($$select public.confirm_booking((select member_booking from c3_ids))$$,
  'C03-2 有訂單權限的客服可以代確認會員的線上預約');
select pg_temp.test_clear_auth();
select is((select status from bookings where customer_submission_id = 'c3000000-0000-4000-8000-0000000000a1'),
  'accepted', 'C03-3 代確認後狀態 = accepted');
select is((select count(*)::int from user_notifications un join bookings b on b.id = un.booking_id
           where b.customer_submission_id = 'c3000000-0000-4000-8000-0000000000b1' and un.event_type = 'booking_confirmed'),
  2, 'C03-4 服務人員確認客人訂單後,管理員 + 訂單客服照 #986 收到鈴鐺');

select * from finish();
rollback;
