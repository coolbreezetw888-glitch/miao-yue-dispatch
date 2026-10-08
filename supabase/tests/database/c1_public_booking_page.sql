-- 客戶端第 1 批 — C1-C01 public.get_public_booking_page + C1-F02 哨兵字串測試(兩支公開函式都驗)
-- 規格書 .project/specs/客戶端第1批-公開預約頁.md
--
--   C01-1~4   not_found / unavailable 只回 status;代碼大小寫 / 空白
--   C01-5~8   白名單:最上層 / merchant / booking_settings / service_items / staff 物件的 key 完全等於清單
--   C01-9~14  內容規則:公告開才給內容、只列上架中的項目、只列上架 + 在職的服務人員、暱稱優先、
--             primary_service_item_ids(沒對應 = null、有對應只列主要項目)、預設設定值
--   F02-1~4   以 anon 呼叫 C01、C02(指定 / 不指定)把回傳轉成文字,逐一搜尋哨兵字串與內部 id ⇒ 都搜不到
--   A06       誰會出現在「選服務人員」(由 primary_service_item_ids + C02 驗證)
begin;

select plan(23);

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

create temp table c1_ctx as select ((now() at time zone 'Asia/Taipei')::date + 3) as d0;
grant select on c1_ctx to anon;

-- =========================================================================
-- Fixture(哨兵字串照規格 C1-F02 第 1 點)
-- =========================================================================
insert into auth.users (id, email) values
  ('c1b00000-0000-4000-8000-000000000001', 'pgtap-c1page-staff-user@test.local'),
  ('c1b00000-0000-4000-8000-000000000002', 'pgtap-c1page-admin@test.local');

insert into groups (id) values ('c1b00000-0000-4000-8000-000000000011'), ('c1b00000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type, booking_slug, address, phone, intro, contact_email,
                       theme_preset, announcement_enabled, announcement_content, line_friend_url, status) values
  ('c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000011', '哨兵測試店', 'on_site_dispatch',
   'pgtap-c1page-ok', '台北市測試路 1 號', '0223456789', '店家簡介<script>alert(1)</script>', 'sentinel-merchant@example.com',
   'ocean', false, 'SENTINEL_ANNOUNCEMENT_OFF', 'https://lin.ee/pgtap', 'active'),
  ('c1b00000-0000-4000-8000-000000000022', 'c1b00000-0000-4000-8000-000000000012', 'SENTINEL_OTHER_SHOP', 'in_store_beauty',
   'pgtap-c1page-other', null, null, null, null, null, true, '別家公告', null, 'active'),
  ('c1b00000-0000-4000-8000-000000000023', 'c1b00000-0000-4000-8000-000000000012', 'SENTINEL_DISABLED_SHOP', 'in_store_beauty',
   'pgtap-c1page-off', '停用店地址', '0911111111', null, null, null, false, null, null, 'active');
-- 停用(要先有另一間啟用中的店,才不會被「最後一間」保護擋下)
update merchants set status = 'disabled' where id = 'c1b00000-0000-4000-8000-000000000023';
insert into merchant_admins (merchant_id, user_id) values
  ('c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'c1b00000-0000-4000-8000-000000000021'::uuid, d, false, '09:00', '18:00' from generate_series(0, 6) d;
insert into merchant_booking_settings (merchant_id, min_lead_hours) values ('c1b00000-0000-4000-8000-000000000021', 0);
-- 客戶端第 2 批 C2-C01:LINE 登入設定(Channel ID 是哨兵,不能出現在公開回應);會員政策關閉時內容也不能出現
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled)
values ('c1b00000-0000-4000-8000-000000000021', '9876543210', 'c1b00000-0000-4000-8000-0000000000f1', 'zz99', true);
insert into merchant_member_settings (merchant_id, policy_enabled, policy_content)
values ('c1b00000-0000-4000-8000-000000000021', false, 'SENTINEL_POLICY_OFF')
on conflict (merchant_id) do update set policy_enabled = false, policy_content = 'SENTINEL_POLICY_OFF';

insert into service_categories (id, merchant_id, name) values
  ('c1b00000-0000-4000-8000-000000000041', 'c1b00000-0000-4000-8000-000000000021', '乙分類'),
  ('c1b00000-0000-4000-8000-000000000042', 'c1b00000-0000-4000-8000-000000000021', '甲分類'),
  ('c1b00000-0000-4000-8000-000000000043', 'c1b00000-0000-4000-8000-000000000021', '只有下架項目的分類');
insert into service_items (id, merchant_id, category_id, name, description, price, item_type, duration_minutes, status, created_at) values
  ('c1b00000-0000-4000-8000-000000000051', 'c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000041', '主要一', '說明一', 1500, 'primary', 60, 'active', now() - interval '3 hours'),
  ('c1b00000-0000-4000-8000-000000000052', 'c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000042', '主要二', null, 800, 'primary', 30, 'active', now() - interval '2 hours'),
  ('c1b00000-0000-4000-8000-000000000053', 'c1b00000-0000-4000-8000-000000000021', null, '加購一', null, 200, 'addon', 15, 'active', now() - interval '1 hour'),
  ('c1b00000-0000-4000-8000-000000000054', 'c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000043', 'SENTINEL_REMOVED_ITEM', null, 100, 'primary', 30, 'removed', now()),
  ('c1b00000-0000-4000-8000-000000000055', 'c1b00000-0000-4000-8000-000000000022', null, '別家項目', null, 100, 'primary', 30, 'active', now());

insert into merchant_staff (id, merchant_id, user_id, name, nickname, phone, is_listed, status, line_user_id, invited_login_email,
                            advance_booking_days, no_time_slot_limit, unlimited_backend_edit, auto_accept_booking, avatar_url, intro, created_at) values
  ('c1b00000-0000-4000-8000-000000000031', 'c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000001',
   'SENTINEL_STAFF_REALNAME', '阿明', '0900111222', true, 'active', 'SENTINEL_LINE_UID', 'sentinel-staff@example.com',
   0, false, true, true, 'https://example.com/a.png', '服務人員簡介', now() - interval '2 hours'),
  ('c1b00000-0000-4000-8000-000000000032', 'c1b00000-0000-4000-8000-000000000021', null,
   '小陳本名可顯示', '  ', '0900162102', true, 'active', null, null, null, false, false, false, null, null, now() - interval '1 hour'),
  ('c1b00000-0000-4000-8000-000000000033', 'c1b00000-0000-4000-8000-000000000021', null,
   '未上架本名', 'SENTINEL_UNLISTED', '0900162103', false, 'active', null, null, null, false, false, false, null, null, now()),
  ('c1b00000-0000-4000-8000-000000000034', 'c1b00000-0000-4000-8000-000000000021', null,
   'SENTINEL_REMOVED_STAFF', null, '0900162104', true, 'removed', null, null, null, false, false, false, null, null, now()),
  ('c1b00000-0000-4000-8000-000000000035', 'c1b00000-0000-4000-8000-000000000021', null,
   '只會主要一', null, '0900162105', true, 'active', null, null, null, false, false, false, null, null, now() + interval '1 hour');
-- 阿明:對應「主要一 + 加購一 + 下架項目」⇒ primary_service_item_ids 只列主要一;小陳:沒有對應 ⇒ null
-- 只會主要一:對應主要一 ⇒ 選「主要一 + 主要二」時不能指定他,只選「主要一 + 加購一」時可以
insert into merchant_staff_service_items (staff_id, service_item_id) values
  ('c1b00000-0000-4000-8000-000000000031', 'c1b00000-0000-4000-8000-000000000051'),
  ('c1b00000-0000-4000-8000-000000000031', 'c1b00000-0000-4000-8000-000000000052'),
  ('c1b00000-0000-4000-8000-000000000031', 'c1b00000-0000-4000-8000-000000000053'),
  ('c1b00000-0000-4000-8000-000000000031', 'c1b00000-0000-4000-8000-000000000054'),
  ('c1b00000-0000-4000-8000-000000000035', 'c1b00000-0000-4000-8000-000000000051');
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select s, d, '09:00', '18:00' from generate_series(0, 6) d,
  unnest(array['c1b00000-0000-4000-8000-000000000031', 'c1b00000-0000-4000-8000-000000000032',
               'c1b00000-0000-4000-8000-000000000035']::uuid[]) s;

-- 同一時段一張既有訂單(客戶姓名 / 內部備註是哨兵)
insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, notes, customer_notes, customer_address, created_by_role)
values ('c1b00000-0000-4000-8000-000000000021', 'c1b00000-0000-4000-8000-000000000031',
        ((select d0 from c1_ctx) + time '10:00') at time zone 'Asia/Taipei',
        ((select d0 from c1_ctx) + time '11:00') at time zone 'Asia/Taipei',
        'SENTINEL_CUSTOMER', '0955162199', 'SENTINEL_NOTE', 'SENTINEL_NOTE', 'SENTINEL_CUSTOMER 地址', 'admin');

-- =========================================================================
-- C01 not_found / unavailable
-- =========================================================================
select is(public.get_public_booking_page('pgtap-no-such-slug-c1'), '{"status": "not_found"}'::jsonb, 'C01-1 代碼不存在 ⇒ 只有 status = not_found');
select is(public.get_public_booking_page('pgtap-c1page-off'), '{"status": "unavailable"}'::jsonb, 'C01-2 停用商家 ⇒ 只有 status = unavailable');
select is(public.get_public_booking_page(null), '{"status": "not_found"}'::jsonb, 'C01-3 代碼 null ⇒ not_found');
select is(public.get_public_booking_page('  PGTAP-C1PAGE-OK ') ->> 'status', 'ok', 'C01-4 代碼轉小寫、去頭尾空白');

-- =========================================================================
-- C01 白名單(key 完全等於清單,多一個少一個都會紅)
-- =========================================================================
create temp table c1_page as select public.get_public_booking_page('pgtap-c1page-ok') as r;

select is((select array_agg(k order by k) from c1_page, jsonb_object_keys(r) k),
          array['booking_settings', 'categories', 'merchant', 'service_items', 'staff', 'status'],
          'C01-5 最上層 key');
select is((select array_agg(k order by k) from c1_page, jsonb_object_keys(r -> 'merchant') k),
          array['address', 'announcement', 'industry_type', 'intro', 'line_friend_url', 'logo_url', 'name', 'phone',
                'theme_custom_color', 'theme_preset'],
          'C01-6 merchant 物件 key');
select is((select array_agg(k order by k) from c1_page, jsonb_object_keys(r -> 'booking_settings') k),
          array['allow_guest_booking', 'is_on_site', 'line_login_enabled', 'member_policy'],
          'C01-7 booking_settings 只有四個 key(第 2 批加 line_login_enabled / member_policy;不回傳 min_lead_hours / travel_buffer / 間隔 / Channel ID)');
select is((select array_agg(distinct k order by k) from c1_page, jsonb_array_elements(r -> 'service_items') e, jsonb_object_keys(e) k)
          || (select array_agg(distinct k order by k) from c1_page, jsonb_array_elements(r -> 'staff') e, jsonb_object_keys(e) k)
          || (select array_agg(distinct k order by k) from c1_page, jsonb_array_elements(r -> 'categories') e, jsonb_object_keys(e) k),
          array['category_id', 'description', 'duration_minutes', 'id', 'item_type', 'name', 'price',
                'avatar_url', 'display_name', 'id', 'intro', 'primary_service_item_ids',
                'id', 'name'],
          'C01-8 service_items / staff / categories 物件 key');

-- =========================================================================
-- C01 內容規則
-- =========================================================================
select ok((select r -> 'merchant' -> 'announcement' = 'null'::jsonb from c1_page), 'C01-9 公告關閉 ⇒ announcement = null');
select is((select array_agg(e ->> 'name' order by ord) from c1_page, jsonb_array_elements(r -> 'service_items') with ordinality as t(e, ord)),
          array['主要一', '主要二', '加購一'], 'C01-10 只列上架中的項目,依建立時間排序');
select is((select array_agg(e ->> 'name' order by ord) from c1_page, jsonb_array_elements(r -> 'categories') with ordinality as t(e, ord)),
          array['乙分類', '甲分類'], 'C01-11 分類依名稱排序、只列底下有上架中項目的分類');
select is((select array_agg(e ->> 'display_name' order by ord) from c1_page, jsonb_array_elements(r -> 'staff') with ordinality as t(e, ord)),
          array['阿明', '小陳本名可顯示', '只會主要一'],
          'C01-12 只列上架 + 在職的服務人員;有暱稱用暱稱、暱稱空白用本名');
select is((select jsonb_agg(e -> 'primary_service_item_ids' order by ord) from c1_page, jsonb_array_elements(r -> 'staff') with ordinality as t(e, ord)),
          '[["c1b00000-0000-4000-8000-000000000051", "c1b00000-0000-4000-8000-000000000052"], null, ["c1b00000-0000-4000-8000-000000000051"]]'::jsonb,
          'C01-13 primary_service_item_ids:只列上架中的主要項目;沒有任何對應 = null');
select is((select r -> 'booking_settings' from c1_page),
          '{"is_on_site": true, "allow_guest_booking": true, "line_login_enabled": true, "member_policy": null}'::jsonb,
          'C01-14 到府 + 允許不登入預約預設 true + LINE 登入已啟用 + 會員政策關閉 ⇒ null');

-- 公告開啟才給內容
update merchants set announcement_enabled = true where id = 'c1b00000-0000-4000-8000-000000000021';
select is(public.get_public_booking_page('pgtap-c1page-ok') -> 'merchant' ->> 'announcement', 'SENTINEL_ANNOUNCEMENT_OFF',
          'C01-15 公告開啟 ⇒ 給公告內容');
update merchants set announcement_enabled = false where id = 'c1b00000-0000-4000-8000-000000000021';

-- =========================================================================
-- A06 / B06:誰可以被指定
-- =========================================================================
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1page-ok', '[{"service_item_id":"c1b00000-0000-4000-8000-000000000051","quantity":1},{"service_item_id":"c1b00000-0000-4000-8000-000000000052","quantity":1}]', 'c1b00000-0000-4000-8000-000000000035', %L, 1)$$,
         (select d0 from c1_ctx)),
  'P0002', '這位服務人員目前無法預約，請改選其他服務人員或「不指定」', 'A06-1 有設對應但缺一個主要項目 ⇒ 不能指定');
select lives_ok(
  format($$select public.get_public_available_slots('pgtap-c1page-ok', '[{"service_item_id":"c1b00000-0000-4000-8000-000000000051","quantity":1},{"service_item_id":"c1b00000-0000-4000-8000-000000000053","quantity":1}]', 'c1b00000-0000-4000-8000-000000000035', %L, 1)$$,
         (select d0 from c1_ctx)),
  'A06-2 只缺加購項目的對應 ⇒ 可以指定');
select throws_ok(
  format($$select public.get_public_available_slots('pgtap-c1page-ok', '[{"service_item_id":"c1b00000-0000-4000-8000-000000000051","quantity":1}]', 'c1b00000-0000-4000-8000-000000000033', %L, 1)$$,
         (select d0 from c1_ctx)),
  'P0002', '這位服務人員目前無法預約，請改選其他服務人員或「不指定」', 'A06-3 未上架 ⇒ 不能指定');

-- =========================================================================
-- F02 哨兵字串:以 anon 呼叫,回傳整包轉文字後搜尋
-- =========================================================================
create temp table c1_resp (label text, body text);
grant all on c1_resp to anon;
select pg_temp.test_set_auth('c1b00000-0000-4000-8000-000000000001', 'anon');
insert into c1_resp values
  ('page', public.get_public_booking_page('pgtap-c1page-ok')::text),
  ('slots_any', public.get_public_available_slots('pgtap-c1page-ok',
     '[{"service_item_id":"c1b00000-0000-4000-8000-000000000051","quantity":1},{"service_item_id":"c1b00000-0000-4000-8000-000000000053","quantity":2}]',
     null, (select d0 from c1_ctx), 7)::text),
  ('slots_staff', public.get_public_available_slots('pgtap-c1page-ok',
     '[{"service_item_id":"c1b00000-0000-4000-8000-000000000051","quantity":1}]',
     'c1b00000-0000-4000-8000-000000000031', (select d0 from c1_ctx), 7)::text),
  ('disabled', public.get_public_booking_page('pgtap-c1page-off')::text),
  ('not_found', public.get_public_booking_page('pgtap-c1page-nope')::text);
select pg_temp.test_clear_auth();

create temp table c1_needles as
select unnest(array[
  'SENTINEL_STAFF_REALNAME', '0900111222', 'SENTINEL_LINE_UID', 'sentinel-staff@example.com',
  'sentinel-merchant@example.com', 'SENTINEL_ANNOUNCEMENT_OFF', 'SENTINEL_REMOVED_ITEM', 'SENTINEL_UNLISTED',
  'SENTINEL_CUSTOMER', 'SENTINEL_NOTE', 'SENTINEL_OTHER_SHOP', 'SENTINEL_REMOVED_STAFF', 'SENTINEL_DISABLED_SHOP',
  'c1b00000-0000-4000-8000-000000000021',           -- merchants.id
  'c1b00000-0000-4000-8000-000000000011',           -- group_id
  'c1b00000-0000-4000-8000-000000000001',           -- 服務人員 user_id
  'c1b00000-0000-4000-8000-000000000054',           -- 下架項目 id
  'c1b00000-0000-4000-8000-000000000033',           -- 未上架服務人員 id
  'pgtap-c1page-ok',                                -- booking_slug 本身也不需要回傳
  'unlimited_backend_edit', 'auto_accept_booking', 'advance_booking_days', 'no_time_slot_limit',
  'min_lead_hours', 'travel_buffer', 'created_at', 'updated_at', 'contact_email', 'user_id', 'line_bound',
  -- 第 2 批 C2-C01:Channel ID、Vault id、末 4 碼、關閉中的會員政策內容
  '9876543210', 'c1b00000-0000-4000-8000-0000000000f1', 'zz99', 'SENTINEL_POLICY_OFF', 'channel'
]) as needle;

select is(
  (select array_agg(needle order by needle) from c1_needles n, c1_resp r where r.label = 'page' and strpos(r.body, n.needle) > 0),
  null, 'F02-1 C01 回傳搜不到任何哨兵字串 / 內部 id / 內部欄位名');
select is(
  (select array_agg(needle order by needle) from c1_needles n, c1_resp r where r.label = 'slots_any' and strpos(r.body, n.needle) > 0),
  null, 'F02-2 C02(不指定)回傳搜不到任何哨兵字串 / id');
select is(
  (select array_agg(needle order by needle) from c1_needles n, c1_resp r where r.label = 'slots_staff' and strpos(r.body, n.needle) > 0)
  , null, 'F02-3 C02(指定)回傳搜不到任何哨兵字串 / id(也不含被指定的人的 id)');
select is(
  (select array_agg(body order by label) from c1_resp where label in ('disabled', 'not_found')),
  array['{"status": "unavailable"}', '{"status": "not_found"}'], 'F02-4 停用 / 不存在:回應原文只有 status');
-- 對照:被搜的東西確實存在於資料庫(不是因為沒填才搜不到)
select ok(
  (select count(*) from merchant_staff where line_user_id = 'SENTINEL_LINE_UID' and phone = '0900111222' and user_id is not null) = 1
  and (select strpos(body, '阿明') > 0 and strpos(body, '"announcement": null') > 0 from c1_resp where label = 'page')
  and (select not ((body::jsonb -> 'days' -> 0 -> 'times') ? '10:00') and ((body::jsonb -> 'days' -> 0 -> 'times') ? '11:00')
         from c1_resp where label = 'slots_staff'),
  'F02-5 對照組:哨兵資料確實存在;指定阿明時被訂走的 10:00 不列、11:00 有列');

select * from finish();
rollback;
