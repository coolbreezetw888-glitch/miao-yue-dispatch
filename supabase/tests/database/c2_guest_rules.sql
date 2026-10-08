-- 客戶端第 2 批 — C2-G01 訪客標記、C2-G02 未完成預約張數、C2-G03 訪客自動對到會員
begin;

select plan(16);

insert into auth.users (id, email) values ('c2c00000-0000-4000-8000-000000000001', 'pgtap-c2g-admin@test.local');
insert into groups (id) values ('c2c00000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000011', 'C2 訪客店', 'in_store_beauty', 'pgtap-c2g', 'active'),
  ('c2c00000-0000-4000-8000-000000000022', 'c2c00000-0000-4000-8000-000000000011', 'C2 訪客分店', 'in_store_beauty', 'pgtap-c2g-2', 'active');
insert into merchant_admins (merchant_id, user_id) values ('c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000001');
insert into members (id, merchant_id, name, phone, referral_code) values
  ('c2c00000-0000-4000-8000-000000000041', 'c2c00000-0000-4000-8000-000000000021', '既有會員', '0912-170-441', 'C2GTEST1');
insert into merchant_staff (id, merchant_id, name, phone, status) values
  ('c2c00000-0000-4000-8000-000000000031', 'c2c00000-0000-4000-8000-000000000021', '服務人員一', '0900170431', 'active'),
  ('c2c00000-0000-4000-8000-000000000032', 'c2c00000-0000-4000-8000-000000000022', '服務人員二', '0900170432', 'active');

-- =========================================================================
-- G01
-- =========================================================================
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role)
values ('c2c00000-0000-4000-8000-000000000051', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() + interval '1 day', now() + interval '1 day 1 hour', '甲', '0912170401', 'admin');
select is((select is_guest_booking from bookings where id = 'c2c00000-0000-4000-8000-000000000051'), false, 'G01-1 預設 false');
select throws_ok($$update bookings set is_guest_booking = true where id = 'c2c00000-0000-4000-8000-000000000051'$$, '23514', null,
                 'G01-2 source 不是 customer 時不能標訪客');

-- =========================================================================
-- G02
-- =========================================================================
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, source, status, is_guest_booking, member_id) values
  ('c2c00000-0000-4000-8000-000000000061', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() + interval '1 day', now() + interval '1 day 1 hour', '訪', '0912-170-402', 'customer', 'customer', 'pending_confirmation', true, null),
  ('c2c00000-0000-4000-8000-000000000062', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() + interval '2 day', now() + interval '2 day 1 hour', '訪', '0912170402', 'customer', 'customer', 'accepted', true, null),
  ('c2c00000-0000-4000-8000-000000000063', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() + interval '3 day', now() + interval '3 day 1 hour', '訪', '0912 170 402', 'customer', 'customer', 'pending_reply', true, null),
  -- 已過結束時間但店家忘了按完成 ⇒ 不算
  ('c2c00000-0000-4000-8000-000000000064', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() - interval '3 hour', now() - interval '2 hour', '訪', '0912170402', 'customer', 'customer', 'accepted', true, null),
  -- 後台建的同電話單 ⇒ 不算
  ('c2c00000-0000-4000-8000-000000000065', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() + interval '4 day', now() + interval '4 day 1 hour', '訪', '0912170402', 'admin', 'manual', 'accepted', false, null),
  -- 別家同電話 ⇒ 不算
  ('c2c00000-0000-4000-8000-000000000066', 'c2c00000-0000-4000-8000-000000000022', 'c2c00000-0000-4000-8000-000000000032', now() + interval '4 day', now() + interval '4 day 1 hour', '訪', '0912170402', 'customer', 'customer', 'accepted', true, null),
  -- 會員換了別支電話下的單
  ('c2c00000-0000-4000-8000-000000000067', 'c2c00000-0000-4000-8000-000000000021', 'c2c00000-0000-4000-8000-000000000031', now() + interval '5 day', now() + interval '5 day 1 hour', '會', '0912170499', 'customer', 'customer', 'accepted', false, 'c2c00000-0000-4000-8000-000000000041');

select is(private.customer_open_booking_count('c2c00000-0000-4000-8000-000000000021', '0912170402'), 3, 'G02-1 三張未完成(電話格式不同也對得到)');
update bookings set status = 'cancelled', cancelled_at = now() where id = 'c2c00000-0000-4000-8000-000000000063';
select is(private.customer_open_booking_count('c2c00000-0000-4000-8000-000000000021', '0912170402'), 2, 'G02-2 取消一張 ⇒ 2');
update bookings set status = 'completed', completed_at = now() where id = 'c2c00000-0000-4000-8000-000000000062';
select is(private.customer_open_booking_count('c2c00000-0000-4000-8000-000000000021', '0912170402'), 1, 'G02-3 完成一張 ⇒ 1(過期未完成、後台建的、別家的都不算)');
select is(private.customer_open_booking_count('c2c00000-0000-4000-8000-000000000021', '0912170441', 'c2c00000-0000-4000-8000-000000000041'), 1,
          'G02-4 同會員不同電話也算');
select is(private.customer_open_booking_count('c2c00000-0000-4000-8000-000000000021', null, null), 0, 'G02-5 電話與會員都沒有 ⇒ 0');

-- =========================================================================
-- G03(以未登入身分呼叫,模擬第 3 批的訪客送出)
-- =========================================================================
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(private.resolve_guest_member('c2c00000-0000-4000-8000-000000000021', '0912170441', '亂填'), 'c2c00000-0000-4000-8000-000000000041'::uuid,
          'G03-1 一位 ⇒ 回那位');
select is((select name from members where id = 'c2c00000-0000-4000-8000-000000000041'), '既有會員', 'G03-2 不改既有會員姓名');
create temp table c2g_new as select private.resolve_guest_member('c2c00000-0000-4000-8000-000000000021', '02-2345-0001', '新訪客') as id;
select is((select name || '/' || phone || '/' || coalesce(user_id::text, 'null') || '/' || line_bound || '/' || coalesce(identity_verified_at::text, 'null') || '/' || coalesce(created_by_user_id::text, 'null')
           from members where id = (select id from c2g_new)),
          '新訪客/0223450001/null/false/null/null', 'G03-3 沒有 ⇒ 建一位未驗證會員');
select is(coalesce(current_setting('miaoyue.customer_member_create', true), ''), '', 'G03-4 建完標記已清空');
select ok(not private.can_manage_members('c2c00000-0000-4000-8000-000000000021'), 'G03-5 標記清空後 can_manage_members 回到 false');
select set_config('miaoyue.customer_member_create', 'c2c00000-0000-4000-8000-000000000021', true);
select ok(not private.can_manage_members('c2c00000-0000-4000-8000-000000000022'), 'G03-5b 標記只對同一間商家成立(別家仍是 false)');
select ok(private.can_manage_members('c2c00000-0000-4000-8000-000000000021'), 'G03-5c 對照組:標記那一間是 true');
select set_config('miaoyue.customer_member_create', '', true);
select throws_ok($$select private.resolve_guest_member('c2c00000-0000-4000-8000-000000000021', null, '無電話')$$, '22023', null, 'G03-6 沒電話報錯');
-- ≥2 位:正常情況被唯一索引擋住,這裡暫時拿掉索引模擬髒資料
drop index members_merchant_active_phone_uniq;
insert into members (merchant_id, name, phone, referral_code) values ('c2c00000-0000-4000-8000-000000000021', '重複', '0912170441', 'C2GTEST2');
select throws_ok($$select private.resolve_guest_member('c2c00000-0000-4000-8000-000000000021', '0912170441', '訪')$$, 'P0001',
                 '這支電話對到多位會員，請聯絡店家。', 'G03-7 兩位以上 ⇒ 報錯');

select * from finish();
rollback;
