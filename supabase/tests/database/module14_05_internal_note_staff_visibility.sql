-- 模組 6 × 模組 14:內部備註逐單對服務人員隱藏(SPECS-INDEX #850~#859)。
-- 規格書:.project/specs/內部備註對服務人員隱藏.md 第 6.1 節。
--
-- 🔴 這一支是整批改動裡**唯一能證明「不是只在前端藏」**的自動化測試。
-- 服務人員端是手機瀏覽器直打 Supabase(publishable key),只要 get_my_booking_schedule 的回應
-- 裡帶著那段備註文字,服務人員按 F12 → Network 就看得到。所以驗收的對象是「這支函式回傳什麼」,
-- 不是「畫面上有沒有畫出來」。這裡直接斷言函式回傳的 jsonb。
--
-- 刻意開新檔案而不是加在 module14_02 裡:那個檔案第 11 行是 `select plan(48);`,
-- 加測試就得同步改那個數字,一漏改整個檔案會失敗(規格書 6.1 節的提醒)。
--
-- 【故障注入驗證(2026-09-30 實際跑過並還原,照 automated-testing skill「怎麼確認測試不是假的」)】
--   把本機測試庫的 get_my_booking_schedule 換回遮蔽前的版本(直接 psql 套用
--   supabase/migrations/20260921120000_staff_portal_my_booking_schedule.sql,不開新 migration):
--     → 16 條裡**剛好 3 條轉紅**,而且是應該紅的那 3 條:
--         #7  「旗標為 true 時 notes 是 JSON null」        have: 不給服務人員看的內部備註 / want: null
--         #8  「整包 JSON 回應的原文裡搜不到那段備註文字」  ← 資安核心那一條
--         #12 「協助人員同待遇,assistant 那一段也被遮成 null」  ← union 第二段
--     → 兩條反向對照(#9「沒隱藏的備註原文仍然在」、#5/#6「旗標 false 時等於原文」)**仍然綠**,
--       證明它們不是「永遠綠的假測試」。
--     → 還原(重新套用 20260930010100)之後 85 檔 / 1963 條全綠。
--
-- 📌 這個檔案自己重新定義 test_set_auth / test_clear_auth 兩個 helper(不用 \ir include),
--    照 automated-testing skill 的既有慣例:supabase test db 是把每個 .sql 獨立丟給 psql,
--    共用 helper 檔案會被誤判成「沒有 plan() 的測試檔」而報錯。

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

select plan(16);

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
-- Fixture:一間商家、一位管理員、兩位服務人員(P=主要 / A=協助)。
-- 兩位都開通 staff_calendar_view,show_member_info 不是這支的重點,一律 false。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1450000-0000-4000-8000-000000000001', 'pgtap-m14e-admin@test.local'),
  ('e1450000-0000-4000-8000-000000000002', 'pgtap-m14e-staff-p@test.local'),
  ('e1450000-0000-4000-8000-000000000003', 'pgtap-m14e-staff-a@test.local');

insert into groups (id) values ('e1450000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e1450000-0000-4000-8000-000000000020', 'e1450000-0000-4000-8000-000000000010', '內部備註隱藏測試店', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id)
values ('e1450000-0000-4000-8000-000000000020', 'e1450000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e1450000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('e1450000-0000-4000-8000-000000000030', 'e1450000-0000-4000-8000-000000000020', '到府服務', 500, 'primary', 60);

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, no_time_slot_limit, show_member_info, phone) values
  ('e1450000-0000-4000-8000-000000000040', 'e1450000-0000-4000-8000-000000000020', 'e1450000-0000-4000-8000-000000000002', '服務人員P(主要)', 'piece_rate', 'active', 'active', now(), true, false, '0900000201'),
  ('e1450000-0000-4000-8000-000000000041', 'e1450000-0000-4000-8000-000000000020', 'e1450000-0000-4000-8000-000000000003', '服務人員A(協助)', 'piece_rate', 'active', 'active', now(), true, false, '0900000202');

insert into merchant_staff_permissions (staff_id, section_key, granted)
select s.id, 'staff_calendar_view', true
from (values
  ('e1450000-0000-4000-8000-000000000040'::uuid),
  ('e1450000-0000-4000-8000-000000000041'::uuid)
) as s(id);

insert into payment_methods (id, merchant_id, name)
values ('e1450000-0000-4000-8000-000000000050', 'e1450000-0000-4000-8000-000000000020', '現場付款');

-- =========================================================================
-- 用真正的 create_booking 建單(以管理員身份),不手動 insert bookings ——
-- 這樣才順便驗到 #852 的新參數真的寫得進去。
-- 三筆都是 P 主要 + A 協助,差別只在旗標:
--   bookingVisible : 旗標不帶(預期 false)
--   bookingHidden  : 旗標帶 true
--   bookingExplicit: 旗標明確帶 false
-- =========================================================================
select pg_temp.test_set_auth('e1450000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'e1450000-0000-4000-8000-000000000020',
  p_staff_id => 'e1450000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1450000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-10 10:00:00+08',
  p_customer_name => '客戶一',
  p_customer_phone => '0911000001',
  p_customer_address => '測試地址一號',
  p_notes => '看得到的內部備註',
  p_assistant_staff_ids => array['e1450000-0000-4000-8000-000000000041'::uuid],
  p_payment_method_id => 'e1450000-0000-4000-8000-000000000050'
) \gset bookingVisible_

select id from create_booking(
  p_merchant_id => 'e1450000-0000-4000-8000-000000000020',
  p_staff_id => 'e1450000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1450000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-11 10:00:00+08',
  p_customer_name => '客戶二',
  p_customer_phone => '0911000002',
  p_customer_address => '測試地址二號',
  p_notes => '不給服務人員看的內部備註',
  p_assistant_staff_ids => array['e1450000-0000-4000-8000-000000000041'::uuid],
  p_payment_method_id => 'e1450000-0000-4000-8000-000000000050',
  p_hide_notes_from_staff => true
) \gset bookingHidden_

select id from create_booking(
  p_merchant_id => 'e1450000-0000-4000-8000-000000000020',
  p_staff_id => 'e1450000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1450000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-12 10:00:00+08',
  p_customer_name => '客戶三',
  p_customer_phone => '0911000003',
  p_customer_address => '測試地址三號',
  p_notes => '明確不隱藏的內部備註',
  p_assistant_staff_ids => array['e1450000-0000-4000-8000-000000000041'::uuid],
  p_payment_method_id => 'e1450000-0000-4000-8000-000000000050',
  p_hide_notes_from_staff => false
) \gset bookingExplicit_

-- ── #850 / #852:欄位預設值與寫入 ────────────────────────────────────────────
select is(
  (select hide_notes_from_staff from bookings where id = :'bookingVisible_id'),
  false,
  '#850:create_booking 不帶 p_hide_notes_from_staff 時,欄位是 false(預設服務人員看得到)'
);

select is(
  (select hide_notes_from_staff from bookings where id = :'bookingHidden_id'),
  true,
  '#852:create_booking 帶 true 時真的寫進 hide_notes_from_staff'
);

select is(
  (select hide_notes_from_staff from bookings where id = :'bookingExplicit_id'),
  false,
  '#852:create_booking 明確帶 false 時,欄位是 false'
);

-- ── #858:客服/商家管理員永遠看得到,旗標不影響他 ─────────────────────────────
select is(
  (select notes from bookings where id = :'bookingHidden_id'),
  '不給服務人員看的內部備註',
  '#858:旗標為 true 時,以商家管理員身份直讀 bookings 仍然看得到原文(否則他沒辦法取消勾選)'
);

select pg_temp.test_clear_auth();

-- ── #856(回歸):旗標沒開 → 服務人員看得到原文 ───────────────────────────────
-- 🔴 這一條是規格書 #856 的本體。這個行為從 2026-09-21 就存在,但在這次之前**完全沒有測試
--    在保護它** —— module14_02 測了 customer_name / is_member / role_in_booking,就是沒測 notes。
select pg_temp.test_set_auth('e1450000-0000-4000-8000-000000000002'); -- P(主要服務人員)

select is(
  (
    select e ->> 'notes'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingVisible_id'
  ),
  '看得到的內部備註',
  '#856:旗標為 false(不帶)時,get_my_booking_schedule 回傳的 notes 等於原文'
);

select is(
  (
    select e ->> 'notes'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingExplicit_id'
  ),
  '明確不隱藏的內部備註',
  '#856:旗標明確為 false 時同樣回傳原文'
);

-- ── #851:旗標打開 → notes 是 null,而且整段文字不能出現在回應的任何地方 ──────────
select is(
  (
    select e -> 'notes'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingHidden_id'
  ),
  'null'::jsonb,
  '#851:旗標為 true 時,主要服務人員拿到的 notes 是 JSON null'
);

-- 🔴 這一條才是真正的資安斷言:不是「那個欄位是 null」,而是**整包回應的原文裡搜不到那段文字**。
-- 只斷言欄位的話,哪天有人在別的欄位(例如某個摘要字串)不小心把備註帶出去,測試會照樣綠。
select ok(
  position('不給服務人員看的內部備註' in
    get_my_booking_schedule('e1450000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)::text
  ) = 0,
  '#851(資安核心):旗標為 true 時,整包 JSON 回應的原文裡搜不到那段備註文字'
);

-- 同一包回應裡,沒有隱藏的那兩筆備註**必須**還在(反向對照:證明上一條不是因為函式壞掉才搜不到)。
select ok(
  position('看得到的內部備註' in
    get_my_booking_schedule('e1450000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)::text
  ) > 0,
  '反向對照:同一包回應裡沒有隱藏的那筆備註原文仍然在(不是函式整個壞掉)'
);

-- ── #858:服務人員不能直讀 bookings(確認這次沒有意外放寬 bookings_select)────────
select is(
  (select count(*) from bookings),
  0::bigint,
  '#858:以服務人員身份直接 select bookings 一筆都撈不到(bookings_select 沒有被放寬)'
);

select pg_temp.test_clear_auth();

-- ── #858 / 主腦裁決 T4:協助人員同待遇 ──────────────────────────────────────────
-- union 兩段(primary / assistant)很容易只改到一段,所以協助人員要單獨測一次。
select pg_temp.test_set_auth('e1450000-0000-4000-8000-000000000003'); -- A(協助)

select is(
  (
    select e ->> 'role_in_booking'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000041'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingHidden_id'
  ),
  'assistant',
  '前提確認:A 在這筆訂單上的身份是 assistant(走 union 的第二段)'
);

select is(
  (
    select e -> 'notes'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000041'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingHidden_id'
  ),
  'null'::jsonb,
  '主腦裁決 T4:協助人員同待遇 —— 旗標為 true 時 assistant 那一段也被遮成 null'
);

select is(
  (
    select e ->> 'notes'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000041'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingVisible_id'
  ),
  '看得到的內部備註',
  'T4 反向:旗標為 false 時,協助人員一樣看得到原文'
);

select pg_temp.test_clear_auth();

-- ── #857:編輯訂單不能把隱藏設定靜默清掉 ────────────────────────────────────────
-- 🔴 這是整批改動裡唯一會造成真實資安後果的 bug:update_booking 是**無條件覆寫**,
--    前端漏帶參數 → 後端拿 default false → 原本藏起來的備註,編輯一次就自動公開,
--    **不報錯、畫面上也看不出來**。
select pg_temp.test_set_auth('e1450000-0000-4000-8000-000000000001');

-- (1) 帶 true 之後再帶一次 true → 還是 true(正常編輯流程:前端每次都帶現值)
select update_booking(
  p_booking_id => :'bookingHidden_id',
  p_staff_id => 'e1450000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1450000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-11 11:00:00+08',
  p_customer_name => '客戶二',
  p_customer_phone => '0911000002',
  p_customer_address => '測試地址二號',
  p_notes => '不給服務人員看的內部備註',
  p_assistant_staff_ids => array['e1450000-0000-4000-8000-000000000041'::uuid],
  p_payment_method_id => 'e1450000-0000-4000-8000-000000000050',
  p_hide_notes_from_staff => true
);

select is(
  (select hide_notes_from_staff from bookings where id = :'bookingHidden_id'),
  true,
  '#857:編輯時帶著現值 true 送出 → 旗標維持 true'
);

-- (2) 🔴 明確記錄「漏帶參數會發生什麼」:旗標被清成 false。
-- 這一條**不是**在說後端有 bug —— 主腦裁決 T7 就是沿用既有的「呼叫端每次都要帶」語意
-- (跟 p_notes / p_member_id 完全一致,不製造「一半覆寫一半增量」的混亂)。
-- 這條測試的價值是把這個**已知且刻意的**危險行為釘在檔案裡:哪天有人想把前端那行
-- `p_hide_notes_from_staff: input.hideNotesFromStaff ?? false` 改成「有值才帶」的寫法,
-- 這條測試會提醒他後端沒有在替他兜底。真正的防線在前端 + Vitest(#857,
-- src/modules/booking/bookingFormHideNotes.test.tsx / bookingHideNotesRpc.test.ts)。
select update_booking(
  p_booking_id => :'bookingHidden_id',
  p_staff_id => 'e1450000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1450000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-11 11:00:00+08',
  p_customer_name => '客戶二',
  p_customer_phone => '0911000002',
  p_customer_address => '測試地址二號',
  p_notes => '不給服務人員看的內部備註',
  p_assistant_staff_ids => array['e1450000-0000-4000-8000-000000000041'::uuid],
  p_payment_method_id => 'e1450000-0000-4000-8000-000000000050'
);

select is(
  (select hide_notes_from_staff from bookings where id = :'bookingHidden_id'),
  false,
  '#857(已知且刻意的語意,T7):漏帶 p_hide_notes_from_staff 時後端採用 default false —— 所以呼叫端一定要每次帶值'
);

select pg_temp.test_clear_auth();

-- ── 6.3 節邊界 2:取消勾選之後,服務人員下次載入就立刻看得到 ──────────────────────
select pg_temp.test_set_auth('e1450000-0000-4000-8000-000000000002'); -- P

select is(
  (
    select e ->> 'notes'
    from jsonb_array_elements(get_my_booking_schedule('e1450000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
    where (e ->> 'id') = :'bookingHidden_id'
  ),
  '不給服務人員看的內部備註',
  '邊界 2:旗標從 true 變回 false 之後,服務人員立刻又看得到原文(沒有任何快取殘留在資料層)'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
