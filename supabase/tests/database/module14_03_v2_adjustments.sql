-- 模組 14(服務人員端)v2 調整 — 對應規格書 .project/specs/服務人員端.md 第十~十二節。
-- 涵蓋:10.2.1(get_my_day_business_hours)、10.3.1(set_staff_day_override/clear_staff_day_override
-- 的 '24:00:00' 邊界值,核心必測)、10.4.2(get_staff_commission_summary 疊加 total_amount)。
-- 規則 2.4(核心必測)對這次新增/修改的函式一體適用。

begin;

select plan(29);

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
-- Fixture:一間商家,一位管理員,兩位服務人員(X=主測試對象/按件計酬,Z=隔離測試對象)。
-- 商家營業時間:星期一(1)09:00-18:00,星期二(2)公休(is_closed=true),星期三(3)完全不設定
-- (不 insert 任何列,測 has_setting=false 分支)。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1430000-0000-4000-8000-000000000001', 'pgtap-m14c-admin@test.local'),
  ('e1430000-0000-4000-8000-000000000002', 'pgtap-m14c-staff-x@test.local'),
  ('e1430000-0000-4000-8000-000000000003', 'pgtap-m14c-staff-z@test.local');

insert into groups (id) values ('e1430000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e1430000-0000-4000-8000-000000000020', 'e1430000-0000-4000-8000-000000000010', '服務人員端v2測試店', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id)
values ('e1430000-0000-4000-8000-000000000020', 'e1430000-0000-4000-8000-000000000001');

-- 2026-11-16 是星期一(dow=1),2026-11-17 是星期二(dow=2),2026-11-18 是星期三(dow=3)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('e1430000-0000-4000-8000-000000000020', 1, false, '09:00', '18:00'),
  ('e1430000-0000-4000-8000-000000000020', 2, true, null, null);
  -- 星期三(3)故意不 insert 任何列,測 has_setting=false 分支。

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('e1430000-0000-4000-8000-000000000030', 'e1430000-0000-4000-8000-000000000020', '到府服務', 1000, 'primary', 60);

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, no_time_slot_limit) values
  ('e1430000-0000-4000-8000-000000000040', 'e1430000-0000-4000-8000-000000000020', 'e1430000-0000-4000-8000-000000000002', '服務人員X', 'piece_rate', 'active', 'active', now(), true),
  ('e1430000-0000-4000-8000-000000000041', 'e1430000-0000-4000-8000-000000000020', 'e1430000-0000-4000-8000-000000000003', '服務人員Z(隔離測試)', 'piece_rate', 'active', 'active', now(), true);

insert into merchant_staff_permissions (staff_id, section_key, granted)
select s.id, k.key, true
from (values
  ('e1430000-0000-4000-8000-000000000040'::uuid),
  ('e1430000-0000-4000-8000-000000000041'::uuid)
) as s(id)
cross join (values
  ('staff_calendar_view'), ('staff_availability_self_manage'), ('staff_payroll_view'), ('staff_profile_edit')
) as k(key);

-- 10.4.2 fixture:50% 抽成比例,gross 基準(預設)。
insert into merchant_payroll_settings (merchant_id, commission_basis_type)
values ('e1430000-0000-4000-8000-000000000020', 'gross');

insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
values ('e1430000-0000-4000-8000-000000000040', 'e1430000-0000-4000-8000-000000000030', 'percentage', 50);

-- =========================================================================
-- 10.2.1:get_my_day_business_hours。
-- =========================================================================
select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000002'); -- X

select is(
  (get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-16'::date) ->> 'has_setting')::boolean,
  true,
  '10.2.1:星期一有設定營業時間,has_setting=true'
);

select is(
  (get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-16'::date) ->> 'is_closed')::boolean,
  false,
  '10.2.1:星期一不是公休'
);

select is(
  get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-16'::date) ->> 'open_time',
  '09:00:00',
  '10.2.1:星期一開店時間正確'
);

select is(
  get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-16'::date) ->> 'close_time',
  '18:00:00',
  '10.2.1:星期一打烊時間正確'
);

select is(
  (get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-17'::date) ->> 'is_closed')::boolean,
  true,
  '10.2.1:星期二公休,is_closed=true'
);

select is(
  (get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-18'::date) ->> 'has_setting')::boolean,
  false,
  '10.2.1:星期三完全沒設定,has_setting=false'
);

select is(
  get_my_day_business_hours('e1430000-0000-4000-8000-000000000040'::uuid, '2026-11-18'::date) ->> 'open_time',
  null,
  '10.2.1:查無設定時 open_time 為 null'
);

select throws_ok(
  $$select get_my_day_business_hours('e1430000-0000-4000-8000-000000000041'::uuid, '2026-11-16'::date)$$,
  '42501', null,
  '規則 2.4(核心必測):X 傳入服務人員 Z 的 staff_id 呼叫 get_my_day_business_hours 被擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 10.3.1(核心必測):set_staff_day_override/clear_staff_day_override 的 '24:00:00' 邊界值。
-- 這是既有函式從沒驗證過的輸入,實測後發現原本的寫法會無限迴圈(time 型別逐格相加在跨過
-- 24:00:00 時回捲成 00:00:00),已在 20260922120000_fix_set_staff_day_override_24h_boundary.sql
-- 修正成用當日分鐘數整數運算,這裡驗證修正後確實正確涵蓋/清除全部 48 格,不多不少。
-- =========================================================================
select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000002'); -- X

select is(
  (select set_staff_day_override('e1430000-0000-4000-8000-000000000040'::uuid, '2026-12-01'::date, '00:00'::time, '24:00'::time, false)),
  0,
  '10.3.1(核心必測):整天排休('' 00:00~24:00 '')正確結束(沒有無限迴圈拖到 pgTAP 逾時失敗),且這天沒有既有預約,衝突筆數 = 0'
);

select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'e1430000-0000-4000-8000-000000000040' and override_date = '2026-12-01'),
  48,
  '10.3.1(核心必測):整天排休正確涵蓋全部 48 個半小時格,不多不少'
);

select is(
  (select min(slot_start_time) from staff_availability_overrides where staff_id = 'e1430000-0000-4000-8000-000000000040' and override_date = '2026-12-01'),
  '00:00:00'::time,
  '10.3.1:第一格是 00:00'
);

select is(
  (select max(slot_start_time) from staff_availability_overrides where staff_id = 'e1430000-0000-4000-8000-000000000040' and override_date = '2026-12-01'),
  '23:30:00'::time,
  '10.3.1:最後一格是 23:30(不是回捲後的 00:00,也沒有漏掉這一格)'
);

select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'e1430000-0000-4000-8000-000000000040' and override_date = '2026-12-01' and is_available = false),
  48,
  '10.3.1:全部 48 格的 is_available 都正確寫入 false'
);

select lives_ok(
  $$select clear_staff_day_override('e1430000-0000-4000-8000-000000000040'::uuid, '2026-12-01'::date, '00:00'::time, '24:00'::time)$$,
  '10.3.1:清除整天排休(''00:00~24:00'')同樣不受邊界值影響,正常執行'
);

select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'e1430000-0000-4000-8000-000000000040' and override_date = '2026-12-01'),
  0,
  '10.3.1(核心必測):清除後 48 格全部歸零,不多不少'
);

-- 回歸測試:一般不涉及 24:00:00 邊界的正常呼叫,行為完全不受這次修正影響。
select is(
  (select set_staff_day_override('e1430000-0000-4000-8000-000000000040'::uuid, '2026-12-02'::date, '09:00'::time, '10:00'::time, false)),
  0,
  '10.3.1 回歸測試:一般時段呼叫(09:00-10:00)仍正常運作'
);

select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'e1430000-0000-4000-8000-000000000040' and override_date = '2026-12-02'),
  2,
  '10.3.1 回歸測試:09:00-10:00 正確展開成 2 個半小時格,沒有因為改成分鐘數運算而算錯一般情況'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- SPECS-INDEX 編號 485(核心必測,品管打回重做修正):get_merchant_day_schedule 合併
-- staff_availability_overrides 的 grp_end 計算修正(20260922120300_fix_get_merchant_day_
-- schedule_24h_boundary.sql)。服務人員標記「整天排休」後(set_staff_day_override 涵蓋
-- 00:00~24:00 全部 48 格),商家管理員視角看到的合併結果必須是 start=00:00/end=24:00 的
-- 單一區間——修正前的真實 bug:原本用 `max(slot_start_time) + interval '30 minutes'` 算
-- grp_end,最後一格是 23:30 時,PostgreSQL 的 time 型別加法在跨過 24:00:00 時會回捲成
-- 00:00:00(不會進位),導致合併結果變成 start=00:00/end=00:00 的零寬度區間,前端
-- CalendarPage.tsx 的 matchedOverride 比對邏輯永遠比對不到,整天排休因此在商家管理員視角
-- 完全「消失」(格線顯示成可預約、下拉選單顯示「新增預約」而不是「例外關閉」)。
-- =========================================================================
select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000002'); -- X 自己標記整天排休

select is(
  (select set_staff_day_override('e1430000-0000-4000-8000-000000000040'::uuid, '2026-12-03'::date, '00:00'::time, '24:00'::time, false)),
  0,
  '485 fixture:X 標記 2026-12-03 整天排休,無既有預約衝突'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000001'); -- 商家管理員視角

select is(
  jsonb_array_length(
    (
      select s -> 'availability_overrides'
      from jsonb_array_elements(get_merchant_day_schedule('e1430000-0000-4000-8000-000000000020'::uuid, '2026-12-03'::date) -> 'staff') s
      where s ->> 'staff_id' = 'e1430000-0000-4000-8000-000000000040'
    )
  ),
  1,
  '485(核心必測):商家管理員視角看到整天排休合併成單一一筆區間(不是碎成多筆或消失)'
);

select is(
  (
    select (s -> 'availability_overrides' -> 0) ->> 'start_time'
    from jsonb_array_elements(get_merchant_day_schedule('e1430000-0000-4000-8000-000000000020'::uuid, '2026-12-03'::date) -> 'staff') s
    where s ->> 'staff_id' = 'e1430000-0000-4000-8000-000000000040'
  ),
  '00:00:00',
  '485(核心必測):合併區間 start_time = 00:00:00'
);

select is(
  (
    select (s -> 'availability_overrides' -> 0) ->> 'end_time'
    from jsonb_array_elements(get_merchant_day_schedule('e1430000-0000-4000-8000-000000000020'::uuid, '2026-12-03'::date) -> 'staff') s
    where s ->> 'staff_id' = 'e1430000-0000-4000-8000-000000000040'
  ),
  '24:00:00',
  '485(核心必測,修正前的真實 bug 這裡會得到 00:00:00 造成零寬度區間):合併區間 end_time 正確等於 24:00:00,不會因為 23:30+30分鐘的 time 型別跨日回捲變成 00:00:00'
);

select is(
  (
    select ((s -> 'availability_overrides' -> 0) ->> 'is_available')::boolean
    from jsonb_array_elements(get_merchant_day_schedule('e1430000-0000-4000-8000-000000000020'::uuid, '2026-12-03'::date) -> 'staff') s
    where s ->> 'staff_id' = 'e1430000-0000-4000-8000-000000000040'
  ),
  false,
  '485:合併區間 is_available = false(整天排休,不可預約),商家管理員視角能正確判斷出「例外關閉」樣式'
);

select pg_temp.test_clear_auth();

-- 回歸測試:一般不跨 24:00 的單一時段合併,行為完全不受這次修正影響。
select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000002');

select is(
  (select set_staff_day_override('e1430000-0000-4000-8000-000000000040'::uuid, '2026-12-04'::date, '09:00'::time, '10:00'::time, false)),
  0,
  '485 回歸測試 fixture:X 標記 2026-12-04 09:00-10:00 休息'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000001');

select is(
  (
    select (s -> 'availability_overrides' -> 0) ->> 'end_time'
    from jsonb_array_elements(get_merchant_day_schedule('e1430000-0000-4000-8000-000000000020'::uuid, '2026-12-04'::date) -> 'staff') s
    where s ->> 'staff_id' = 'e1430000-0000-4000-8000-000000000040'
  ),
  '10:00:00',
  '485 回歸測試:一般不跨 24:00 的合併區間,end_time 計算不受這次修正影響,仍正確等於 10:00:00'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 10.4.2:get_staff_commission_summary 疊加 total_amount。
-- 用一筆有折扣+稅金的完成訂單,證明 total_amount(訂單最終實收金額加總)、
-- commission_base_amount(抽成基準,已扣折扣但不含稅金)、total_commission_amount(抽成金額)
-- 三個數字在有稅金的情境下確實互不相同,不是同一件事。
-- =========================================================================
select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000001'); -- 管理員建單

-- 小計 1000,無折扣,稅金 10% = 100,最終金額 = 1100;抽成基準(gross,扣折扣不扣稅)= 1000;
-- 抽成 50% = 500。三個數字:total_amount=1100、commission_base=1000、total_commission_amount=500,
-- 兩兩都不相同。
select id from create_booking(
  p_merchant_id => 'e1430000-0000-4000-8000-000000000020',
  p_staff_id => 'e1430000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1430000-0000-4000-8000-000000000030','quantity',1,'unit_price',1000)),
  p_start_at => '2026-11-16 10:00:00+08',
  p_customer_name => '客戶一',
  p_customer_phone => '0911000001',
  p_customer_address => '測試地址一號',
  p_tax_enabled => true,
  p_tax_mode => 'percentage',
  p_tax_value => 10
) \gset booking1_
select confirm_booking(:'booking1_id'::uuid);
select complete_booking(:'booking1_id'::uuid);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1430000-0000-4000-8000-000000000002'); -- X 自助查詢

select is(
  (get_staff_commission_summary('e1430000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_amount')::numeric,
  1100::numeric,
  '10.4.2:total_amount 正確等於訂單最終實收金額(final_amount_snapshot)加總 = 1100'
);

select is(
  (get_staff_commission_summary('e1430000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_commission_amount')::numeric,
  500::numeric,
  '10.4.2:total_commission_amount(抽成金額,以扣稅前基準 1000 的 50% 計算)= 500'
);

select ok(
  (get_staff_commission_summary('e1430000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_amount')::numeric
    <> (get_staff_commission_summary('e1430000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_commission_amount')::numeric,
  '10.4.2(規格書要求的必測情境):有稅金時 total_amount 與 total_commission_amount 確實是不同的數字,避免日後誤把兩者當成同一件事'
);

-- 查無完成訂單的月份:total_amount 應為 0,不是 null。
select is(
  (get_staff_commission_summary('e1430000-0000-4000-8000-000000000040'::uuid, 2026, 6) ->> 'total_amount')::numeric,
  0::numeric,
  '10.4.2:查無完成訂單的月份,total_amount 為 0,不是 null'
);

-- 回歸測試:既有的 details/item_breakdown 結構不受這次疊加影響。
select is(
  jsonb_array_length(get_staff_commission_summary('e1430000-0000-4000-8000-000000000040'::uuid, 2026, 11) -> 'details'),
  1,
  '10.4.2 回歸測試:details 陣列筆數不受 total_amount 疊加影響'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
