-- 模組 10(會員與紅利)/ 模組 6(訂單)— SPECS-INDEX #908 / #909 / #910 / #911 / #912 / #913 /
-- #914 / #929 / #931(規格書 .project/specs/建單自動建立會員與會員兩層狀態.md)。
--
-- 這一檔鎖住的行為:
--   A. #908/#909:members 的三個新欄位與 CHECK/索引真的存在(schema 層)
--   B. #912/#911:建單時自動建立 / 自動連結會員,以及 bookings.member_auto_created
--   C. #913:自動建立那條路徑不會變成「塞髒電話」的新後門
--   D. #914:同一支電話有兩位以上 active 會員時,後端直接 raise(舊資料的安全網)
--   E. #931:同商家 + 同一支電話只能有一位 active 會員(含「指名是誰」的訊息)
--   F. #910:identity_verified_at / _via 的唯一寫入路徑,以及
--      identity_first_verified_at 連解除綁定都不清
--   G. #929:get_members_by_phone 改成前綴比對,以及兩個門檻(最少 4 位數字 / 上限 20 筆)
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;
-- #1051:private 函式已收回 authenticated 執行權;本檔斷言直接以登入者身分呼叫這支輔助函式,在交易內暫時授權(rollback 後失效)。
grant execute on function private.normalize_phone(text) to authenticated;

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

select plan(69);

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
-- Fixture:A 店(主場)+ B 店(跨商家對照,不同集團)
-- =========================================================================
insert into auth.users (id, email) values
  ('f9310000-0000-4000-8000-000000000001', 'pgtap-m10i-admin-a@test.local'),
  ('f9310000-0000-4000-8000-000000000002', 'pgtap-m10i-admin-b@test.local');

insert into groups (id) values
  ('f9310000-0000-4000-8000-000000000011'),
  ('f9310000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('f9310000-0000-4000-8000-000000000021', 'f9310000-0000-4000-8000-000000000011', '自動建會員測試A店', 'in_store_beauty'),
  ('f9310000-0000-4000-8000-000000000022', 'f9310000-0000-4000-8000-000000000012', '自動建會員測試B店', 'in_store_beauty'),
  -- C 店刻意跟 A 店**同一個集團**:transfer_members_to_merchant 要求來源與目標同集團,
  -- 而 B 店是不同集團(它的用途是驗「跨商家不比對電話」)。
  ('f9310000-0000-4000-8000-000000000023', 'f9310000-0000-4000-8000-000000000011', '自動建會員測試C店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('f9310000-0000-4000-8000-000000000021', 'f9310000-0000-4000-8000-000000000001'),
  ('f9310000-0000-4000-8000-000000000022', 'f9310000-0000-4000-8000-000000000002'),
  -- 同一個人同時是 A 店與 C 店的管理員(搬遷要求呼叫者同時是來源+目標的管理員)。
  ('f9310000-0000-4000-8000-000000000023', 'f9310000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9310000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9310000-0000-4000-8000-000000000022', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9310000-0000-4000-8000-000000000031', 'f9310000-0000-4000-8000-000000000021', '洗髮', 1000, 'primary', 30),
  -- 刻意屬於 B 店:用它對 A 店建單會在 validate_booking_selection 被擋下,
  -- 是「建單失敗」最穩定的製造方式(不依賴時段衝突的細節行為)。
  ('f9310000-0000-4000-8000-000000000032', 'f9310000-0000-4000-8000-000000000022', 'B店洗髮', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('f9310000-0000-4000-8000-000000000041', 'f9310000-0000-4000-8000-000000000021', '服務人員', '0901000101', true);

insert into payment_methods (id, merchant_id, name) values
  ('f9310000-0000-4000-8000-000000000071', 'f9310000-0000-4000-8000-000000000021', '現場付款');

-- =========================================================================
-- A. #908/#909:schema 層(欄位、CHECK、索引真的存在)
-- =========================================================================
select has_column('public', 'members', 'identity_verified_at',
  'A1 #908:members 有 identity_verified_at(目前是否已完成身分驗證)');
select has_column('public', 'members', 'identity_verified_via',
  'A2 #908:members 有 identity_verified_via(目前這一段驗證是靠哪一種方式)');
select has_column('public', 'members', 'identity_first_verified_at',
  'A3 #908/#910:members 有 identity_first_verified_at(第一次完成驗證的時間,永不清除)');
select has_column('public', 'bookings', 'member_auto_created',
  'A4 #911:bookings 有 member_auto_created');

select ok(
  exists (
    select 1 from pg_constraint
    where conname = 'members_identity_verified_via_check'
      and conrelid = 'public.members'::regclass
  ),
  'A5 #908:identity_verified_via 有 CHECK 約束(這次只允許 null 或 ''line'')'
);

select ok(
  exists (
    select 1 from pg_class where relname = 'members_identity_verified_at_idx' and relkind = 'i'
  ),
  'A6 #908:名單頁要用的 (merchant_id, identity_verified_at) 索引存在'
);

select ok(
  exists (
    select 1 from pg_class where relname = 'members_merchant_active_phone_uniq' and relkind = 'i'
  ),
  'A7 #931:同商家 + 正規化電話的 partial unique index 存在'
);

-- =========================================================================
-- B. #912/#911:自動建立 / 自動連結
-- =========================================================================
select pg_temp.test_set_auth('f9310000-0000-4000-8000-000000000001');

-- B-1:這支電話在 A 店查無 active 會員 → 自動建立一筆
select id from create_booking(
  p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
  p_staff_id => 'f9310000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 10:00:00+08',
  p_customer_name => '自動建立客戶',
  p_customer_phone => '0912000001',
  p_payment_method_id => 'f9310000-0000-4000-8000-000000000071'
) \gset autocreate_booking_

select is(
  (select member_auto_created from bookings where id = :'autocreate_booking_id'::uuid),
  true,
  'B1 #911/#912:電話查無會員 → member_auto_created = true'
);

select ok(
  (select member_id from bookings where id = :'autocreate_booking_id'::uuid) is not null,
  'B2 #912:訂單已經連結到那一筆自動建立的會員(member_id 不是 null)'
);

select is(
  (select count(*)::int from members
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and private.normalize_phone(phone) = '0912000001'),
  1,
  'B3 #912:members 確實多了一列,而且只有一列'
);

select is(
  (select m.name from members m
    join bookings b on b.member_id = m.id
    where b.id = :'autocreate_booking_id'::uuid),
  '自動建立客戶',
  'B4 #912:自動建立的會員姓名 = 建單表單填的姓名'
);

-- B-2:自動建立的那一列,兩層狀態必須是「尚未驗證」,而且沒有偷偷佔用模組 13 的欄位
select ok(
  (select m.identity_verified_at is null
            and m.identity_verified_via is null
            and m.identity_first_verified_at is null
            and m.line_bound = false
            and m.line_user_id is null
            and m.user_id is null
            and m.status = 'active'
            and m.merchant_id = 'f9310000-0000-4000-8000-000000000021'
     from members m join bookings b on b.member_id = m.id
     where b.id = :'autocreate_booking_id'::uuid),
  'B5 #908/#912:自動建立的會員是「尚未驗證」——三個身分欄位全 null、line_bound=false、user_id 仍然 null(沒有佔用模組 13 的欄位)、status=active、商家正確'
);

-- B-3:source / created_by_role 沒有被誤用成模組 13 的預留值
select is(
  (select row(source, created_by_role)::text from bookings where id = :'autocreate_booking_id'::uuid),
  row('manual', 'admin')::text,
  'B6 #911:source 仍然是 manual、created_by_role 仍然是 admin(沒有誤用 customer/smart 這些預留值)'
);

-- B-4:同一支電話再建一筆單 → 自動**連結**,不新增會員
select id from create_booking(
  p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
  p_staff_id => 'f9310000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 11:00:00+08',
  p_customer_name => '完全不同的姓名',
  p_customer_phone => '0912-000-001',
  p_customer_email => 'should-not-be-written@test.local',
  p_payment_method_id => 'f9310000-0000-4000-8000-000000000071'
) \gset autolink_booking_

select is(
  (select member_auto_created from bookings where id = :'autolink_booking_id'::uuid),
  false,
  'B7 #911/#912:同一支電話(寫法不同,正規化後相同)→ 自動連結,member_auto_created = false'
);

select is(
  (select count(*)::int from members
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and private.normalize_phone(phone) = '0912000001'),
  1,
  'B8 #912/#929:電話格式不同但正規化相同 → 視為同一位,members 筆數不變'
);

select is(
  (select b2.member_id from bookings b2 where b2.id = :'autolink_booking_id'::uuid),
  (select b1.member_id from bookings b1 where b1.id = :'autocreate_booking_id'::uuid),
  'B9 #912:自動連結到的就是第一筆建立的那一位會員'
);

-- B-5:🔴 會員那一筆的姓名/email 不會被建單覆蓋(#931 的完整語意)
select is(
  (select row(m.name, m.email, m.birthday)::text
     from members m join bookings b on b.member_id = m.id
     where b.id = :'autolink_booking_id'::uuid),
  row('自動建立客戶', null::text, null::date)::text,
  'B10 #912/#931:用別的姓名 + 別的 email 建單,會員那一筆的姓名/email/生日**完全沒被改動**'
);

select is(
  (select customer_name from bookings where id = :'autolink_booking_id'::uuid),
  '完全不同的姓名',
  'B11 #931:訂單留這次填的姓名(訂單自己有客戶姓名欄位)'
);

select is(
  (select member_name_snapshot from bookings where id = :'autolink_booking_id'::uuid),
  '自動建立客戶',
  'B12 #912:member_name_snapshot 取的是**會員資料表裡**的姓名,不是表單打的(既有行為不變)'
);

-- B-6:明確帶 p_member_id → 完全照舊,不做任何電話比對
select id from create_member('f9310000-0000-4000-8000-000000000021', '明確指定的會員', '0912000009') \gset explicit_member_

select id from create_booking(
  p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
  p_staff_id => 'f9310000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 12:00:00+08',
  p_customer_name => '電話跟會員不一樣也沒關係',
  p_customer_phone => '0912000001',
  p_payment_method_id => 'f9310000-0000-4000-8000-000000000071',
  p_member_id => :'explicit_member_id'::uuid
) \gset explicit_booking_

select is(
  (select row(member_id, member_auto_created)::text from bookings where id = :'explicit_booking_id'::uuid),
  row(:'explicit_member_id'::uuid, false)::text,
  'B13 #912:明確帶 p_member_id 時完全尊重呼叫端(即使電話對得上另一位會員),member_auto_created = false'
);

-- B-7:同號會員只有 status = 'removed' 一筆 → 當成 0 筆,自動建立新的 active 一筆
select id from create_member('f9310000-0000-4000-8000-000000000021', '已下架的同號會員', '0912000002') \gset removed_member_
select deactivate_member(:'removed_member_id'::uuid);

select id from create_booking(
  p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
  p_staff_id => 'f9310000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 13:00:00+08',
  p_customer_name => '下架後的新客戶',
  p_customer_phone => '0912000002',
  p_payment_method_id => 'f9310000-0000-4000-8000-000000000071'
) \gset removed_case_booking_

select is(
  (select member_auto_created from bookings where id = :'removed_case_booking_id'::uuid),
  true,
  'B14 #912/#931:同號會員只有已下架那一筆 → 當成 0 筆,自動建立新的一筆(已下架的不會被自作主張重新啟用)'
);

select is(
  (select row(status, name)::text from members where id = :'removed_member_id'::uuid),
  row('removed', '已下架的同號會員')::text,
  'B15 #912:已下架那一筆完全沒被改動(status 還是 removed、姓名沒變)'
);

-- B-8:跨商家 —— 同一支電話在 B 店已經是會員,在 A 店建單照樣新建
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('f9310000-0000-4000-8000-000000000002');
select id from create_member('f9310000-0000-4000-8000-000000000022', 'B店的同號會員', '0912000003') \gset b_shop_member_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9310000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
  p_staff_id => 'f9310000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 14:00:00+08',
  p_customer_name => 'A店的同號客戶',
  p_customer_phone => '0912000003',
  p_payment_method_id => 'f9310000-0000-4000-8000-000000000071'
) \gset cross_merchant_booking_

select is(
  (select member_auto_created from bookings where id = :'cross_merchant_booking_id'::uuid),
  true,
  'B16 #912:會員是 per-merchant —— 同一支電話在 B 店已是會員,在 A 店照樣新建一筆(不做跨商家比對)'
);

select isnt(
  (select member_id from bookings where id = :'cross_merchant_booking_id'::uuid),
  :'b_shop_member_id'::uuid,
  'B17 #912:A 店的訂單絕對不會連結到 B 店的會員'
);

-- =========================================================================
-- C. #913:自動建立不會變成「塞髒電話」的新後門
-- =========================================================================
select throws_like(
  $$select create_booking(
      p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
      p_staff_id => 'f9310000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 15:00:00+08', p_customer_name => '髒電話客戶', p_customer_phone => '123',
      p_payment_method_id => 'f9310000-0000-4000-8000-000000000071')$$,
  '%客戶電話格式不正確%',
  'C1 #913:髒電話(123)在「自動建立會員」之前就被 create_booking 的格式檢查擋下'
);

select is(
  (select count(*)::int from members
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and private.normalize_phone(phone) = '123'),
  0,
  'C2 #913:members 一列都沒有多(自動建立不是 #827 的新後門)'
);

-- =========================================================================
-- D. #912 第 7 點:建單失敗不留孤兒會員(同一個交易)
-- =========================================================================
select throws_like(
  $$select create_booking(
      p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
      p_staff_id => 'f9310000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 16:00:00+08', p_customer_name => '孤兒會員測試', p_customer_phone => '0912000777',
      p_payment_method_id => 'f9310000-0000-4000-8000-000000000071')$$,
  '%找不到其中一個服務項目%',
  'D1 #912:用 B 店的服務項目對 A 店建單會失敗(製造一個「自動建會員成功、但建單失敗」的情境)'
);

select is(
  (select count(*)::int from members
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and private.normalize_phone(phone) = '0912000777'),
  0,
  'D2 🔴 #912:建單失敗時,剛剛自動建立的那筆會員一起被 rollback —— 不可能留下孤兒會員'
);

-- =========================================================================
-- E. #931:同商家 + 同一支電話只能有一位 active 會員
-- =========================================================================
select throws_like(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '想搶同一支電話的人', '0912000009')$$,
  '%這支電話已經有會員：明確指定的會員%',
  'E1 #931:同商家同電話再建一位 → 擋下,而且訊息**指名是誰**(不是只說失敗)'
);

select throws_like(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '換個寫法想繞過去', '(09) 12-000-009')$$,
  '%這支電話已經有會員：明確指定的會員%',
  'E2 #931:換一種電話寫法也繞不過去(比對的是 normalize_phone 之後的值)'
);

-- 先造一支「只剩下架紀錄」的電話(0912000002 不能用 —— B-7 那段已經在它底下自動建了一筆 active)。
select id from create_member('f9310000-0000-4000-8000-000000000021', '只剩下架紀錄的人', '0912000004') \gset removed_only_
select deactivate_member(:'removed_only_id'::uuid);

select lives_ok(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '下架號碼可以再建', '0912000004')$$,
  'E3 #931:同號但只有「已下架」那一筆 → 允許新建(使用者明確裁決唯一性只管 active,否則客服會遇到「系統說有會員、名單上卻找不到」)'
);

select lives_ok(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '沒填電話的人甲', null)$$,
  'E4 #931:沒填電話的會員不受唯一性約束(normalize_phone 回 NULL,unique index 裡的 NULL 互不衝突)'
);

select lives_ok(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '沒填電話的人乙', null)$$,
  'E5 #931:第二位沒填電話的會員照樣建得起來(正向對照,證明 E4 不是剛好只能建一筆)'
);

-- update_member:改電話撞到別人 → 擋;只改姓名(電話不變)→ 要能過
select throws_like(
  format(
    $$select update_member(%L::uuid, '改名字順便搶電話', '0912000009', null, null, null)$$,
    (select id from members
      where merchant_id = 'f9310000-0000-4000-8000-000000000021'
        and private.normalize_phone(phone) = '0912000001'
        and status = 'active'
      limit 1)
  ),
  '%這支電話已經有會員：明確指定的會員%',
  'E6 #931:update_member 把電話改成同商家另一位 active 會員的電話 → 擋下並指名是誰'
);

select lives_ok(
  format(
    $$select update_member(%L::uuid, '只是改個姓名錯字', '0912000009', null, null, null)$$,
    :'explicit_member_id'::uuid::text
  ),
  'E7 🔴 #931:客服只改姓名、電話原封不動時**不可以**被自己那一列擋下(m.id <> p_member_id 這個排除條件的守門測試)'
);

-- =========================================================================
-- E 之二. #827:會員電話的格式檢查(使用者裁決 Q5 = (A),繞過畫面直接打 RPC 也擋)
-- =========================================================================
select throws_like(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '髒電話會員', '123')$$,
  '%會員電話格式不正確%',
  'E8 #827:直接打 RPC 用「123」建會員 → 被擋下(這就是 #827 那個後門)'
);

select is(
  (select count(*)::int from members
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and private.normalize_phone(phone) = '123'),
  0,
  'E9 #827:members 一列都沒有多'
);

select throws_like(
  format(
    $$select update_member(%L::uuid, '改成髒電話', '123', null, null, null)$$,
    :'explicit_member_id'::uuid::text
  ),
  '%會員電話格式不正確%',
  'E10 #827:update_member 也擋(繞過畫面把既有會員的電話改成「123」)'
);

select lives_ok(
  $$select create_member('f9310000-0000-4000-8000-000000000021', '市話帶分機的會員', '02-1234-5678#123')$$,
  'E11 #827 正向對照:合法的市話 + # 分機照樣建得起來(證明 E8/E10 不是「什麼都擋」)'
);

-- =========================================================================
-- E 之三. #931 的連帶回歸:reactivate_member 要給白話訊息,不可以吐原生英文錯誤
-- =========================================================================
-- 情境:0912000004 那位被下架 → E3 用同一支電話建了一位新的 active 會員
--      → 現在把原本那位「重新上架」就會撞到唯一索引。
select throws_like(
  format($$select reactivate_member(%L::uuid)$$, :'removed_only_id'::uuid::text),
  '%這位會員的電話現在已經有另一位使用中的會員：下架號碼可以再建%',
  'E12 🔴 #931 連帶回歸:重新上架撞到同號的使用中會員時,給的是**指名是誰**的白話中文,不是 Postgres 原生的英文 duplicate key 錯誤'
);

select is(
  (select status from members where id = :'removed_only_id'::uuid),
  'removed',
  'E13 #931:被擋下來之後那一列還是 removed(檢查發生在 UPDATE 之前)'
);

select id from create_member('f9310000-0000-4000-8000-000000000021', '電話沒被佔走的下架會員', '0912000005') \gset free_removed_
select deactivate_member(:'free_removed_id'::uuid);

select lives_ok(
  format($$select reactivate_member(%L::uuid)$$, :'free_removed_id'::uuid::text),
  'E14 #931 正向對照:電話沒有被別人佔走時,重新上架照樣成功(證明 E12 不是「永遠不能上架」)'
);

-- =========================================================================
-- E 之四. #931 的連帶回歸:transfer_members_to_merchant 要講清楚是哪一筆卡住
-- =========================================================================
select id from create_member('f9310000-0000-4000-8000-000000000021', '要搬走的會員', '0912777001') \gset transfer_src_
select id from create_member('f9310000-0000-4000-8000-000000000021', '搬得過去的會員', '0912777002') \gset transfer_ok_
select id from create_member('f9310000-0000-4000-8000-000000000023', 'C店已有的同號會員', '0912777001') \gset transfer_conflict_

select throws_like(
  format(
    $$select transfer_members_to_merchant(
        'f9310000-0000-4000-8000-000000000021',
        'f9310000-0000-4000-8000-000000000023',
        array[%L]::uuid[])$$,
    :'transfer_src_id'::uuid::text
  ),
  '%要搬過去的會員「要搬走的會員」%C店已有的同號會員%',
  'E15 🔴 #931 連帶回歸:整批搬遷撞到目標商家的同號會員時,訊息同時指名「要搬的是誰」與「跟目標商家的誰撞」,不是原生英文錯誤、也不是只說整批失敗'
);

select is(
  (select merchant_id from members where id = :'transfer_src_id'::uuid),
  'f9310000-0000-4000-8000-000000000021'::uuid,
  'E16 #931:整批拒絕發生在**任何寫入之前** —— 那位會員還留在來源商家,沒有被搬走一半'
);

select lives_ok(
  format(
    $$select transfer_members_to_merchant(
        'f9310000-0000-4000-8000-000000000021',
        'f9310000-0000-4000-8000-000000000023',
        array[%L]::uuid[])$$,
    :'transfer_ok_id'::uuid::text
  ),
  'E17 #931 正向對照:電話不衝突的會員照樣搬得過去(證明 E15 不是「搬遷整個壞掉」)'
);

-- =========================================================================
-- F. #914:同一支電話有兩位以上 active 會員時,後端直接 raise
-- =========================================================================
-- #931 之後新資料不可能造出這個狀態,所以這裡**在交易內** drop 掉那個 unique index 來模擬舊資料。
-- 整份檔案最後 rollback,索引會自動回來;而且這個 drop 只在本交易可見。
-- 這一段刻意放在 E 之後 —— 後面不再有依賴唯一性的斷言。
select pg_temp.test_clear_auth();
drop index public.members_merchant_active_phone_uniq;

insert into members (id, merchant_id, name, phone, referral_code, status) values
  ('f9310000-0000-4000-8000-000000000091', 'f9310000-0000-4000-8000-000000000021', '家人甲', '0912555001', 'PGTAPF91', 'active'),
  ('f9310000-0000-4000-8000-000000000092', 'f9310000-0000-4000-8000-000000000021', '家人乙', '0912-555-001', 'PGTAPF92', 'active');

select pg_temp.test_set_auth('f9310000-0000-4000-8000-000000000001');

select throws_like(
  $$select create_booking(
      p_merchant_id => 'f9310000-0000-4000-8000-000000000021',
      p_staff_id => 'f9310000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9310000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 17:00:00+08', p_customer_name => '兩位候選', p_customer_phone => '0912555001',
      p_payment_method_id => 'f9310000-0000-4000-8000-000000000071')$$,
  '%這支電話底下有 2 位客戶%',
  'F1 #914:同一支電話底下有 2 位 active 會員時,後端直接 raise(不猜是哪一位)'
);

select is(
  (select count(*)::int from bookings
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and customer_name = '兩位候選'),
  0,
  'F2 #914:被擋下來的那次建單,bookings 沒有新增任何一列'
);

select is(
  (select count(*)::int from members
    where merchant_id = 'f9310000-0000-4000-8000-000000000021'
      and private.normalize_phone(phone) = '0912555001'),
  2,
  'F3 #914:members 筆數不變(沒有因為擋下來就多建一位)'
);

-- =========================================================================
-- G. #929:get_members_by_phone 前綴比對 + 兩個門檻
-- =========================================================================
-- 造 21 位 0955 開頭、彼此不同號的會員(21 > 上限 20,用來驗證截斷)。
do $$
declare i int;
begin
  for i in 1 .. 21 loop
    perform public.create_member(
      'f9310000-0000-4000-8000-000000000021',
      '前綴測試會員' || i::text,
      '09551' || lpad(i::text, 5, '0')
    );
  end loop;
end;
$$;

select is(
  jsonb_array_length(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '0955')),
  20,
  'G1 #929:打 4 位前綴就列出候選(前綴比對生效),而且**上限 20 筆**(造了 21 位)'
);

select is(
  jsonb_array_length(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '095')),
  0,
  'G2 #929 門檻①:少於 4 位數字一律回空陣列(不然客服打一個 0 會把整間商家的會員全撈出來)'
);

select is(
  jsonb_array_length(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '0')),
  0,
  'G3 #929 門檻①:只打一個 0 也是空陣列(這就是門檻存在的理由)'
);

select is(
  jsonb_array_length(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '')),
  0,
  'G4 #614 既有行為不變:電話為空字串時回空陣列,不報錯'
);

select is(
  (get_members_by_phone('f9310000-0000-4000-8000-000000000021', '0955100007') -> 0 ->> 'name'),
  '前綴測試會員7',
  'G5 🔴 #929 門檻②的前提:打完整支號碼時,「完全相等」那一筆一定排在第 1 筆(所以上限 20 不可能把正確答案切掉)'
);

select is(
  jsonb_array_length(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '0955100021')),
  1,
  'G6 #929:完整號碼只會對到那一位(前綴比對沒有讓比對變鬆到對不準)'
);

select is(
  jsonb_array_length(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '0955999')),
  0,
  'G7 #929 負向對照:前綴對不上就回空陣列(證明 G1 不是「什麼都列出來」)'
);

select ok(
  not exists (
    select 1 from jsonb_array_elements(get_members_by_phone('f9310000-0000-4000-8000-000000000021', '0912000003')) elem
    where (elem ->> 'member_id')::uuid = :'b_shop_member_id'::uuid
  ),
  'G8 #614 既有行為不變:只在本商家內比對,不會查到別間商家的同號客戶'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- H. #910:identity_verified_at / _via / _first_verified_at 的寫入與清除
-- =========================================================================
select id from members where merchant_id = 'f9310000-0000-4000-8000-000000000021'
  and private.normalize_phone(phone) = '0912000001' and status = 'active' limit 1 \gset bind_member_

-- 綁定碼由 service role 的 line-webhook 消耗,fixture 直接 insert。
insert into line_binding_codes (id, merchant_id, target_type, target_id, code, expires_at) values
  ('f9310000-0000-4000-8000-0000000000a1', 'f9310000-0000-4000-8000-000000000021', 'member', :'bind_member_id'::uuid, '111111', now() + interval '1 hour'),
  ('f9310000-0000-4000-8000-0000000000a2', 'f9310000-0000-4000-8000-000000000021', 'member', :'bind_member_id'::uuid, '222222', now() + interval '1 hour'),
  ('f9310000-0000-4000-8000-0000000000a3', 'f9310000-0000-4000-8000-000000000021', 'member', :'bind_member_id'::uuid, '333333', now() + interval '1 hour');

select ok(
  (consume_line_binding_code('111111', 'f9310000-0000-4000-8000-000000000021', 'U-pgtap-line-1') ->> 'success')::boolean,
  'H1 前置:第一次綁定成功'
);

select ok(
  (select m.identity_verified_at is not null
            and m.identity_verified_via = 'line'
            and m.identity_first_verified_at is not null
            and m.identity_verified_at = m.identity_first_verified_at
            and m.line_bound = true
     from members m where m.id = :'bind_member_id'::uuid),
  'H2 #910:綁定成功 → identity_verified_at 設上、identity_verified_via = ''line''、identity_first_verified_at 同時設上(第一次兩者相同)'
);

select m.identity_first_verified_at as t from members m where m.id = :'bind_member_id'::uuid \gset first_verified_

-- 第二次綁定(換 LINE 帳號,中間沒有解除):兩個時間都不應該被改掉
select ok(
  (consume_line_binding_code('222222', 'f9310000-0000-4000-8000-000000000021', 'U-pgtap-line-2') ->> 'success')::boolean,
  'H3 前置:第二次綁定(換 LINE 帳號)成功'
);

select is(
  (select identity_first_verified_at from members where id = :'bind_member_id'::uuid),
  :'first_verified_t'::timestamptz,
  'H4 #910:第二次綁定不會改掉 identity_first_verified_at(coalesce 有效)'
);

select is(
  (select identity_verified_at from members where id = :'bind_member_id'::uuid),
  :'first_verified_t'::timestamptz,
  'H5 #910:第二次綁定也不會改掉 identity_verified_at(「這一段驗證從何時開始」不該被換手機重綁改掉)'
);

select is(
  (select line_user_id from members where id = :'bind_member_id'::uuid),
  'U-pgtap-line-2',
  'H6 既有行為不變:換帳號直接覆蓋 line_user_id'
);

-- 解除綁定:綁定狀態歸零,但第一次驗證的時間要留著
select pg_temp.test_set_auth('f9310000-0000-4000-8000-000000000001');
select unbind_line_account('member', :'bind_member_id'::uuid);
select pg_temp.test_clear_auth();

select ok(
  (select m.line_bound = false
            and m.line_user_id is null
            and m.identity_verified_at is null
            and m.identity_verified_via is null
     from members m where m.id = :'bind_member_id'::uuid),
  'H7 🔴 #910(使用者裁決 Q2 = B):解除綁定 → line_bound/line_user_id 清掉,identity_verified_at 與 identity_verified_via 也**清成 null**(綁定狀態歸零)'
);

select is(
  (select identity_first_verified_at from members where id = :'bind_member_id'::uuid),
  :'first_verified_t'::timestamptz,
  'H8 🔴 #910(使用者原話「加入時間也不該清除」):解除綁定**絕對不會**動到 identity_first_verified_at'
);

select is(
  (select count(*)::int from members where id = :'bind_member_id'::uuid),
  1,
  'H9 #910:解除綁定不刪除任何資料,會員本人還在名單上'
);

-- 解除之後重新綁定:目前狀態回來,第一次的時間仍然是最初那個
select ok(
  (consume_line_binding_code('333333', 'f9310000-0000-4000-8000-000000000021', 'U-pgtap-line-3') ->> 'success')::boolean,
  'H10 前置:解除之後重新綁定成功'
);

select ok(
  (select m.identity_verified_at is not null
            and m.identity_verified_via = 'line'
            and m.line_bound = true
     from members m where m.id = :'bind_member_id'::uuid),
  'H11 #910:解除之後重新綁定 → identity_verified_at / identity_verified_via 重新寫回來(⚠️ 刻意不斷言「時間比第一次晚」:pgTAP 整份檔案跑在**同一個交易**裡,而 now() 是交易開始時間、全程不變,所以在這裡兩個時間必然相同 —— 那是測試環境的特性,不是程式行為)'
);

select is(
  (select identity_first_verified_at from members where id = :'bind_member_id'::uuid),
  :'first_verified_t'::timestamptz,
  'H12 #910:重新綁定之後 identity_first_verified_at 仍然是**最初那一次**的時間(永不覆寫)'
);

-- 一般的會員編輯路徑不可以碰到這三個欄位
select pg_temp.test_set_auth('f9310000-0000-4000-8000-000000000001');
select update_member(:'bind_member_id'::uuid, '改個名字', '0912000001', null, null, null);
select pg_temp.test_clear_auth();

select ok(
  (select m.identity_verified_at is not null
            and m.identity_verified_via = 'line'
            and m.identity_first_verified_at = :'first_verified_t'::timestamptz
     from members m where m.id = :'bind_member_id'::uuid),
  'H13 #910:update_member(客服編輯會員基本資料)完全不會碰到這三個欄位 —— 客服不可以手動把客戶標成「已驗證」,也不可以把它弄掉'
);

select * from finish();
rollback;
