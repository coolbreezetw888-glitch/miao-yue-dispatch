-- 模組 10(會員與紅利)— SPECS-INDEX #936(2026-10-01,規格書 §12.2):建單表單點選候選會員時要把
-- 地址帶入,但 members 沒有地址欄位 ⇒ get_members_by_phone 多回傳 last_booking_address
-- (= 這位會員在**本商家**最近一筆有填地址的訂單地址)。
--
-- 這一檔鎖住的行為:
--   1. 取「最近一筆**有填**地址」的訂單(更新的那筆沒填地址就往前找)
--   2. 沒有任何有地址的訂單 ⇒ null
--   3. 🔴 只取本商家的訂單:會員被搬到別的商家後,舊商家那邊訂單的地址不會出現在新商家(跨商家外洩)
--   4. 原本的 6 個 key 都還在(前端既有欄位不受影響)
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(5);

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
-- Fixture:同集團 A 店(主場)、B 店(模擬「會員被搬走之前」的舊商家)
-- =========================================================================
insert into auth.users (id, email) values
  ('f9360000-0000-4000-8000-000000000001', 'pgtap-936-admin-a@test.local');

insert into groups (id) values ('f9360000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('f9360000-0000-4000-8000-000000000021', 'f9360000-0000-4000-8000-000000000011', '地址帶入測試A店', 'on_site_dispatch'),
  ('f9360000-0000-4000-8000-000000000022', 'f9360000-0000-4000-8000-000000000011', '地址帶入測試B店', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id) values
  ('f9360000-0000-4000-8000-000000000021', 'f9360000-0000-4000-8000-000000000001');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('f9360000-0000-4000-8000-000000000041', 'f9360000-0000-4000-8000-000000000021', 'A店服務人員', '0901936001', true),
  ('f9360000-0000-4000-8000-000000000042', 'f9360000-0000-4000-8000-000000000022', 'B店服務人員', '0901936002', true);

insert into members (id, merchant_id, name, phone, referral_code, status) values
  -- 有三筆訂單:最舊的有地址、中間的有地址、最新的沒填地址 ⇒ 應該拿到「中間那筆」
  ('f9360000-0000-4000-8000-000000000051', 'f9360000-0000-4000-8000-000000000021', '有地址的會員', '0936100001', 'PGT93601', 'active'),
  -- 完全沒有訂單
  ('f9360000-0000-4000-8000-000000000052', 'f9360000-0000-4000-8000-000000000021', '沒訂單的會員', '0936100002', 'PGT93602', 'active'),
  -- 已經在 A 店,但名下的訂單全部屬於 B 店(= 用 transfer_members_to_merchant 搬過來的會員)
  ('f9360000-0000-4000-8000-000000000053', 'f9360000-0000-4000-8000-000000000021', '搬過來的會員', '0936100003', 'PGT93603', 'active');

insert into bookings (
  id, merchant_id, staff_id, member_id, start_at, end_at,
  customer_name, customer_phone, customer_address, source, created_by_role, status
) values
  ('f9360000-0000-4000-8000-000000000081', 'f9360000-0000-4000-8000-000000000021', 'f9360000-0000-4000-8000-000000000041',
   'f9360000-0000-4000-8000-000000000051', '2036-01-01 10:00:00+08', '2036-01-01 11:00:00+08',
   '有地址的會員', '0936100001', '最舊的地址', 'manual', 'admin', 'completed'),
  ('f9360000-0000-4000-8000-000000000082', 'f9360000-0000-4000-8000-000000000021', 'f9360000-0000-4000-8000-000000000041',
   'f9360000-0000-4000-8000-000000000051', '2036-02-01 10:00:00+08', '2036-02-01 11:00:00+08',
   '有地址的會員', '0936100001', '台北市信義路 1 號', 'manual', 'admin', 'completed'),
  ('f9360000-0000-4000-8000-000000000083', 'f9360000-0000-4000-8000-000000000021', 'f9360000-0000-4000-8000-000000000041',
   'f9360000-0000-4000-8000-000000000051', '2036-03-01 10:00:00+08', '2036-03-01 11:00:00+08',
   '有地址的會員', '0936100001', '   ', 'manual', 'admin', 'accepted'),
  ('f9360000-0000-4000-8000-000000000084', 'f9360000-0000-4000-8000-000000000022', 'f9360000-0000-4000-8000-000000000042',
   'f9360000-0000-4000-8000-000000000053', '2036-02-15 10:00:00+08', '2036-02-15 11:00:00+08',
   '搬過來的會員', '0936100003', 'B店才知道的地址', 'manual', 'admin', 'completed');

select pg_temp.test_set_auth('f9360000-0000-4000-8000-000000000001');

select is(
  get_members_by_phone('f9360000-0000-4000-8000-000000000021', '0936100001') -> 0 ->> 'last_booking_address',
  '台北市信義路 1 號',
  '1 #936:取最近一筆**有填**地址的訂單(最新那筆只有空白,往前找到 2 月那筆)'
);

select ok(
  (get_members_by_phone('f9360000-0000-4000-8000-000000000021', '0936100002') -> 0) ? 'last_booking_address'
  and (get_members_by_phone('f9360000-0000-4000-8000-000000000021', '0936100002') -> 0 -> 'last_booking_address') = 'null'::jsonb,
  '2 #936:沒有任何訂單的會員 ⇒ key 存在、值是 null(前端就不動地址欄)'
);

select ok(
  (get_members_by_phone('f9360000-0000-4000-8000-000000000021', '0936100003') -> 0 -> 'last_booking_address') = 'null'::jsonb,
  '3 🔴 #936:搬過來的會員,舊商家(B 店)訂單的地址**不會**出現在 A 店的候選裡(跨商家不外洩)'
);

select ok(
  get_members_by_phone('f9360000-0000-4000-8000-000000000021', '0936100003')::text not like '%B店才知道的地址%',
  '3 🔴 #936:整包回傳裡完全找不到 B 店那筆的地址字串'
);

select ok(
  (get_members_by_phone('f9360000-0000-4000-8000-000000000021', '0936100001') -> 0)
    ?& array['member_id', 'name', 'phone', 'last_booking_date', 'is_blacklisted', 'blacklist_reason', 'last_booking_address'],
  '4 #936:原本的 6 個 key 都還在,再多一個 last_booking_address'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
