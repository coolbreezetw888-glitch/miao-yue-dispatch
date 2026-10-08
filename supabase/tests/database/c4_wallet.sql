-- 客戶端第 4-A 批 — 我的錢包(C4-W01、W02、F02)
-- 規格書 .project/specs/客戶端第4批-會員中心與自己取消.md
--
--   W02-1~3  回傳形狀、只回 type / delta / created_at / booking_summary(不回 note、操作人、推薦對象、balance_after)
--   W02-4    booking_summary「M月D日　項目 ×數量」(主要項目在前、「、」連接、台北時間)
--   W02-5~6  同一個 created_at 的幾筆依「接龍」還原寫入先後(跟 id 排序不同),新的在前
--   W02-7~10 游標分頁:不重複、不漏、同一時間不切開
--   W02-11   紅利關閉 ⇒ points null
--   W02-12   別的會員只看到自己的
--   F02      哨兵:note、推薦對象姓名、member_id 搜不到
begin;

select plan(14);

create function pg_temp.as_customer(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated',
    'app_metadata', json_build_object('account_type', 'customer'))::text, true);
  set local role authenticated;
end;
$$;
create function pg_temp.as_postgres()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;
grant execute on function pg_temp.as_postgres() to authenticated;
create temp table c4w_out (label text, body jsonb);
grant all on c4w_out to authenticated;

insert into auth.users (id, email, raw_app_meta_data) values
  ('c4b00000-0000-4000-8000-000000000011', 'line-c4w-11@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb),
  ('c4b00000-0000-4000-8000-000000000012', 'line-c4w-12@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb);
insert into groups (id) values ('c4b00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c4b00000-0000-4000-8000-000000000021', 'c4b00000-0000-4000-8000-000000000091', 'C4錢包店', 'in_store_beauty', 'pgtap-c4w-shop', 'active');
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c4b00000-0000-4000-8000-000000000021', '4747474747', vault.create_secret('C4WFAKESECRET00000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name) values
  ('c4b00000-0000-4000-8000-000000000011', '4747474747', 'U-c4w-11', 'LINE小明'),
  ('c4b00000-0000-4000-8000-000000000012', '4747474747', 'U-c4w-12', 'LINE別人');
insert into merchant_staff (id, merchant_id, name, phone, is_listed, status, login_status) values
  ('c4b00000-0000-4000-8000-000000000031', 'c4b00000-0000-4000-8000-000000000021', '服務人員甲', '0900600031', true, 'active', 'not_invited');
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('c4b00000-0000-4000-8000-000000000081', 'c4b00000-0000-4000-8000-000000000021', '室內機清洗', 1000, 'primary', 60, 'active'),
  ('c4b00000-0000-4000-8000-000000000082', 'c4b00000-0000-4000-8000-000000000021', '加購除臭', 200, 'addon', 30, 'active');
insert into members (id, merchant_id, name, phone, referral_code, user_id, points_balance) values
  ('c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000021', '王小明', '0912600041', 'C4WREF41', 'c4b00000-0000-4000-8000-000000000011', 70),
  ('c4b00000-0000-4000-8000-000000000042', 'c4b00000-0000-4000-8000-000000000021', 'C4_REFERRAL_TARGET_SENTINEL', '0912600042', 'C4WREF42', 'c4b00000-0000-4000-8000-000000000012', 10);
-- 第 4-B 批:接上 = 聯絡人表(members.user_id = 主要聯絡人)。直接寫 user_id 的 fixture 同步補主要聯絡人列。
insert into member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via)
select merchant_id, id, user_id, true, 'backfill' from members
where user_id is not null and id in ('c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000042');
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, source, member_id) values
  ('c4b00000-0000-4000-8000-0000000000b1', 'c4b00000-0000-4000-8000-000000000021', 'c4b00000-0000-4000-8000-000000000031',
   '2026-10-01 18:30:00+00', '2026-10-01 19:30:00+00', '王小明', '0912600041', 'admin', 'completed', 'manual', 'c4b00000-0000-4000-8000-000000000041');
insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot) values
  ('c4b00000-0000-4000-8000-0000000000b1', 'c4b00000-0000-4000-8000-000000000082', 30, 1, 200),
  ('c4b00000-0000-4000-8000-0000000000b1', 'c4b00000-0000-4000-8000-000000000081', 60, 2, 1000);

-- 分類帳(會員 41):
--   T0(較早)單筆 earn_booking +100(0→100,有訂單、有 note 哨兵)
--   T1 同一時間三筆,寫入順序 f2(+50:100→150)→ f3(−100:150→50)→ f1(+20:50→70);id 排序與寫入順序不同
--   T2..T9 各一筆 manual_adjustment(只是讓分頁有東西,balance 不需連續)
insert into member_point_transactions (id, member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, related_member_id, note, created_at) values
  ('c4b00000-0000-4000-8000-0000000000e0', 'c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000021', 'earn_booking', 100, 100,
   'c4b00000-0000-4000-8000-0000000000b1', null, 'C4_POINT_NOTE_SENTINEL', '2026-09-01 00:00:00+00'),
  ('c4b00000-0000-4000-8000-0000000000f2', 'c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000021', 'referral_bonus', 50, 150,
   null, 'c4b00000-0000-4000-8000-000000000042', 'C4_POINT_NOTE_SENTINEL', '2026-09-02 00:00:00+00'),
  ('c4b00000-0000-4000-8000-0000000000f3', 'c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000021', 'redeem_booking', -100, 50,
   'c4b00000-0000-4000-8000-0000000000b1', null, 'C4_POINT_NOTE_SENTINEL', '2026-09-02 00:00:00+00'),
  ('c4b00000-0000-4000-8000-0000000000f1', 'c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000021', 'manual_adjustment', 20, 70,
   null, null, 'C4_POINT_NOTE_SENTINEL', '2026-09-02 00:00:00+00');
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, note, created_at)
select 'c4b00000-0000-4000-8000-000000000041', 'c4b00000-0000-4000-8000-000000000021', 'manual_adjustment', 1, 70, 'C4_POINT_NOTE_SENTINEL',
       timestamptz '2026-09-03 00:00:00+00' + make_interval(days => n)
from generate_series(0, 7) n;
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, note, created_at) values
  ('c4b00000-0000-4000-8000-000000000042', 'c4b00000-0000-4000-8000-000000000021', 'birthday_bonus', 10, 10, 'OTHER_MEMBER_NOTE', '2026-09-05 00:00:00+00');

select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
insert into c4w_out values ('all', public.customer_get_wallet('pgtap-c4w-shop', null, 50));
select pg_temp.as_postgres();

select is((select array_agg(k order by k) from c4w_out, jsonb_object_keys(body) k where label = 'all'),
          array['points', 'state', 'stored_value'], 'W02-1 最上層 key');
select is((select row(body -> 'points' -> 'enabled', body -> 'points' -> 'balance', body -> 'points' -> 'next_cursor', body -> 'stored_value')::text from c4w_out where label = 'all'),
          row('true'::jsonb, '70'::jsonb, 'null'::jsonb, 'null'::jsonb)::text, 'W02-2 開啟、餘額 70、一頁全回、儲值金 null');
select is((select array_agg(distinct k order by k) from c4w_out, jsonb_array_elements(body -> 'points' -> 'history') e, jsonb_object_keys(e) k where label = 'all'),
          array['booking_summary', 'created_at', 'delta', 'type'], 'W02-3 每筆只有 4 個 key');
select is((select e ->> 'booking_summary' from c4w_out, jsonb_array_elements(body -> 'points' -> 'history') e where label = 'all' and e ->> 'type' = 'earn_booking'),
          '10月2日　室內機清洗 ×2、加購除臭 ×1', 'W02-4 訂單摘要(台北時間 10/2;主要項目在前)');
select is((select jsonb_agg(e -> 'delta') from c4w_out, jsonb_array_elements(body -> 'points' -> 'history') e
           where label = 'all' and (e ->> 'created_at')::timestamptz = '2026-09-02 00:00:00+00'),
          '[20, -100, 50]'::jsonb, 'W02-5 同一時間三筆:依接龍還原,新的在前(+20、−100、+50;不是 id 順序)');
select is((select jsonb_array_length(body -> 'points' -> 'history') from c4w_out where label = 'all'), 12, 'W02-6 共 12 筆(不含別的會員)');

-- 分頁:每頁 3 筆走到底
create temp table c4w_pages (page integer, deltas jsonb, cnt integer, next_cursor text);
grant all on c4w_pages to authenticated;
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
do $$
declare v jsonb; v_cursor timestamptz := null; v_page integer := 0;
begin
  loop
    v_page := v_page + 1;
    v := public.customer_get_wallet('pgtap-c4w-shop', v_cursor, 3) -> 'points';
    insert into c4w_pages values (v_page, v -> 'history', jsonb_array_length(v -> 'history'), v ->> 'next_cursor');
    exit when v -> 'next_cursor' = 'null'::jsonb or v_page > 20;
    v_cursor := (v ->> 'next_cursor')::timestamptz;
  end loop;
end $$;
select pg_temp.as_postgres();
select is((select sum(cnt)::integer from c4w_pages), 12, 'W02-7 分頁走完 12 筆不漏');
select is((select jsonb_agg(e order by p.page, o) from c4w_pages p, jsonb_array_elements(p.deltas) with ordinality t(e, o)),
          (select body -> 'points' -> 'history' from c4w_out where label = 'all'), 'W02-8 分頁串起來 = 一次全拿的順序(不重複)');
select is((select array_agg(cnt order by page) from c4w_pages), array[3, 3, 5, 1], 'W02-9 同一時間三筆不切開(第 3 頁 2 + 3 = 5 筆)');
select is((select next_cursor from c4w_pages order by page desc limit 1), null, 'W02-10 最後一頁 next_cursor null');

insert into merchant_member_settings (merchant_id, points_feature_enabled) values ('c4b00000-0000-4000-8000-000000000021', false);
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000011');
select is(public.customer_get_wallet('pgtap-c4w-shop'), '{"state": "ok", "points": null, "stored_value": null}'::jsonb, 'W02-11 紅利關閉 ⇒ points null');
select pg_temp.as_postgres();
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'c4b00000-0000-4000-8000-000000000021';
select pg_temp.as_customer('c4b00000-0000-4000-8000-000000000012');
insert into c4w_out values ('other', public.customer_get_wallet('pgtap-c4w-shop'));
select pg_temp.as_postgres();
select is((select body -> 'points' -> 'history' from c4w_out where label = 'other'),
          '[{"type": "birthday_bonus", "delta": 10, "created_at": "2026-09-05T00:00:00+00:00", "booking_summary": null}]'::jsonb,
          'W02-12 別的會員只看到自己的分類帳');

select is((select count(*)::integer from c4w_out where body::text ~ 'C4_POINT_NOTE_SENTINEL|OTHER_MEMBER_NOTE|C4_REFERRAL_TARGET_SENTINEL|c4b00000-0000-4000-8000-00000000004|c4b00000-0000-4000-8000-0000000000[ef]'
             and label in ('all')), 0, 'F02-1 錢包搜不到 note、推薦對象姓名 / id、member_id、分類帳 id');
select is((select count(*)::integer from c4w_pages where deltas::text like '%balance%'), 0, 'F02-2 不回 balance_after');

select * from finish();
rollback;
