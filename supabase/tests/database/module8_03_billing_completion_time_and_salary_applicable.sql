-- 2026-09-24 使用者裁決三合一(migration 20260924040000)的回歸測試:
--   任務 1:報表的營收/料錢/訂單數改用「完成時間」當基準,不是預約時間
--   任務 2:離職人員的當月扣款要被算到、而且要出現在明細裡
--   任務 3:月薪只在「選了完整月份」時才計算,非完整月份一律回傳 null(不是 0)
--
-- 【為什麼需要這份測試】
-- 這三件事全都是「同一個數字換了口徑」的改動,錯了不會拋錯、不會有紅字,只會讓商家看到一個
-- 安靜的錯誤金額——這種 bug 最難發現,所以每一條都要有正反兩面的斷言把口徑釘死。
--
-- 【時間軸為什麼要手動改寫】
-- 這份測試用「以 postgres 身分直接改寫 bookings.completed_at / staff_payroll_status_history」
-- 的方式製造精確的時間軸(完全比照 module8_02 §11.5 區塊的既有做法,見該檔案 322 行起的註解)。
-- 理由:complete_booking() 一律寫 completed_at = now()、觸發器一律用 clock_timestamp(),
-- 在同一個測試交易裡不可能自然產生「9 月預約、10 月完成」或「10/5 離職」這種跨月時間軸。
-- 手動改寫之後測試結果完全不依賴測試執行當下的實際時鐘時間,穩定可重現。
begin;

-- 34 → 38:主腦裁決追加 is_active_as_of 旗標(讓前端顯示「已離職」標籤),四條斷言涵蓋
-- 單月版/區間版、已離職/在職、以及非完整月份時旗標仍然正確。
select plan(38);

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
-- Fixture:一間乾淨的獨立商家,避免跟其他測試檔案的資料互相干擾。
-- =========================================================================
insert into auth.users (id, email) values
  ('e8030000-0000-4000-8000-000000000001', 'pgtap-m803-admin@test.local');

insert into groups (id) values ('e8030000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e8030000-0000-4000-8000-000000000020', 'e8030000-0000-4000-8000-000000000010',
        '帳務完成時間基準測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('e8030000-0000-4000-8000-000000000020', 'e8030000-0000-4000-8000-000000000001');

-- 全天營業,避免建單被營業時間擋下。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8030000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e8030000-0000-4000-8000-000000000031', 'e8030000-0000-4000-8000-000000000020', '測試服務', 1000, 'primary', 30);

insert into payment_methods (id, merchant_id, name) values
  ('e8030000-0000-4000-8000-000000000071', 'e8030000-0000-4000-8000-000000000020', '現場付款');

insert into material_cost_items (id, merchant_id, name, amount) values
  ('e8030000-0000-4000-8000-000000000081', 'e8030000-0000-4000-8000-000000000020', '測試耗材', 200);

-- 服務人員 T1:按件計酬,只用來測營收/料錢/訂單數的月份歸屬(任務 1),不牽涉月薪。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type, no_time_slot_limit) values
  ('e8030000-0000-4000-8000-000000000041', 'e8030000-0000-4000-8000-000000000020',
   'T1按件計酬', '0900000801', 'piece_rate', true);

-- 服務人員 T2:月薪 30000,2026-10-05 離職(任務 2 的主角)。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type, no_time_slot_limit) values
  ('e8030000-0000-4000-8000-000000000042', 'e8030000-0000-4000-8000-000000000020',
   'T2月薪已離職', '0900000802', 'monthly_salary', true);

-- 服務人員 T3:月薪 20000,一直在職(對照組,證明名單不是整個壞掉)。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type, no_time_slot_limit) values
  ('e8030000-0000-4000-8000-000000000043', 'e8030000-0000-4000-8000-000000000020',
   'T3月薪在職中', '0900000803', 'monthly_salary', true);

-- -------------------------------------------------------------------------
-- T2 真的把 merchant_staff.status 設成 removed(代表「這個人現在已經離職了」)。
--
-- ⚠️ 順序很重要,不能顛倒:這個 UPDATE 會觸發 merchant_staff_sync_payroll_status_history,
--    自動結算舊區間並開一筆 status=removed 的新區間(時間點是 clock_timestamp(),也就是
--    測試執行當下),那會把下面要手工鋪的時間軸弄亂。所以**先**改 status 讓觸發器跑完,
--    **再**把這個人的歷史整批清掉重鋪成我們要的精確時間軸。
--
-- 這一步是 is_active_as_of 這個旗標能被驗到的前提:如果只鋪歷史而不改 merchant_staff.status,
-- T2 目前仍然是 active,旗標就會是 true,測不出「已離職」那條。
-- -------------------------------------------------------------------------
update merchant_staff set status = 'removed'
where id = 'e8030000-0000-4000-8000-000000000042';

-- -------------------------------------------------------------------------
-- 手動改寫薪資歷史時間軸(postgres 身分,比照 module8_02 的既有做法)。
--   T2:2025-01-01 起月薪 30000 在職 → 2026-10-05 00:00 起 status=removed(離職)
--   T3:2025-01-01 起月薪 20000 在職,一直沒變(effective_to 留 null)
-- 這樣「查 2026-09」時 T2 是在職的(當月月底 as_of 落在第一個區間),
-- 「查 2026-10」時 T2 已經離職(當月月底 as_of 落在 removed 區間)。
-- -------------------------------------------------------------------------
delete from staff_payroll_status_history
where staff_id = 'e8030000-0000-4000-8000-000000000042';

insert into staff_payroll_status_history (
  staff_id, merchant_id, compensation_type, status, monthly_base_salary,
  effective_from, effective_to, is_backfill_seed
) values
  ('e8030000-0000-4000-8000-000000000042', 'e8030000-0000-4000-8000-000000000020',
   'monthly_salary', 'active', 30000,
   '2025-01-01 00:00:00+08'::timestamptz, '2026-10-05 00:00:00+08'::timestamptz, false),
  ('e8030000-0000-4000-8000-000000000042', 'e8030000-0000-4000-8000-000000000020',
   'monthly_salary', 'removed', 30000,
   '2026-10-05 00:00:00+08'::timestamptz, null, false);

update staff_payroll_status_history
set effective_from = '2025-01-01 00:00:00+08'::timestamptz,
    monthly_base_salary = 20000
where staff_id = 'e8030000-0000-4000-8000-000000000043' and effective_to is null;

-- T2 的請假:2026-09-10 ~ 2026-09-12(3 天),假別扣款規則 full_day_rate。
-- 9 月有 30 天 → day_rate = 30000 / 30 = 1000 → 扣款 3 × 1000 = 3000。
insert into merchant_leave_types (id, merchant_id, name) values
  ('e8030000-0000-4000-8000-000000000091', 'e8030000-0000-4000-8000-000000000020', '事假');

insert into leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode) values
  ('e8030000-0000-4000-8000-000000000020', 'e8030000-0000-4000-8000-000000000091', 'full_day_rate');

insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date) values
  ('e8030000-0000-4000-8000-000000000042', 'e8030000-0000-4000-8000-000000000091', '事假',
   '2026-09-10', '2026-09-12');

-- =========================================================================
-- 建立任務 1 的主角訂單:**預約在 9 月、完成在 10 月**。
-- 先正常走 create_booking → confirm → complete(此時 completed_at = now()),
-- 再以 postgres 身分把 completed_at 改寫成 2026-10-05,製造出跨月的時間差。
-- =========================================================================
select pg_temp.test_set_auth('e8030000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'e8030000-0000-4000-8000-000000000020',
  p_staff_id => 'e8030000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8030000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-09-20 10:00:00+08',
  p_customer_name => '九月預約十月完成',
  p_customer_phone => '0955080001',
  p_payment_method_id => 'e8030000-0000-4000-8000-000000000071'
) \gset cross_month_booking_
select confirm_booking(:'cross_month_booking_id'::uuid);
select complete_booking(:'cross_month_booking_id'::uuid);

select pg_temp.test_clear_auth();

-- 料錢成本 200 元(直接 insert:booking_material_costs 沒有 INSERT 政策,一般只能透過
-- create_booking/update_booking 寫入,這裡是 fixture,以 postgres 身分直接塞)。
insert into booking_material_costs (booking_id, material_cost_item_id, amount_snapshot) values
  (:'cross_month_booking_id'::uuid, 'e8030000-0000-4000-8000-000000000081', 200);

-- 關鍵的一步:把「完成時間」搬到 10/5,預約時間仍然留在 9/20。
update bookings set completed_at = '2026-10-05 15:00:00+08'::timestamptz
where id = :'cross_month_booking_id'::uuid;

select pg_temp.test_set_auth('e8030000-0000-4000-8000-000000000001');

-- =========================================================================
-- ① 任務 1(核心必測):同一筆訂單「預約在 9 月、完成在 10 月」→ 要出現在 10 月的報表,
--    不是 9 月。營收 / 料錢 / 訂單數三項都要跟著搬過去。
-- =========================================================================
select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_revenue_excl_tax')::numeric,
  0.00,
  '任務 1(核心):訂單預約在 9/20、完成在 10/5 → 9 月報表的未稅營收是 0.00(使用者裁決:「若訂單在 9 月但未完成代表他在 9 月還沒收到錢」)'
);

select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 10) ->> 'total_revenue_excl_tax')::numeric,
  1000.00,
  '任務 1(核心):同一筆訂單的 1000 元未稅營收出現在 10 月報表(使用者裁決:「直到哪個月份按完成才歸在那個月」)'
);

select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_material_cost')::numeric,
  0.00,
  '任務 1:料錢成本也跟著用完成時間分月 → 9 月是 0.00(原本料錢也是用 start_at,跟營收同一個 bug)'
);

select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 10) ->> 'total_material_cost')::numeric,
  200.00,
  '任務 1:料錢成本 200 元出現在 10 月報表'
);

-- 訂單數(per_staff_breakdown 裡 T1 那一列的 order_count)也要跟著搬。
select is(
  (select (elem ->> 'order_count')::int
   from jsonb_array_elements(
     get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000041'),
  0,
  '任務 1:per_staff_breakdown 的 order_count 也用完成時間分月 → T1 在 9 月是 0 筆'
);

select is(
  (select (elem ->> 'order_count')::int
   from jsonb_array_elements(
     get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 10) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000041'),
  1,
  '任務 1:T1 在 10 月是 1 筆(訂單數跟營收認列在同一個月,報表內部才一致)'
);

-- 區間版本同樣要用完成時間(任務 1 兩支函式都要改到,不能只改單月版)。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-01'::date, '2026-09-30'::date
  ) ->> 'total_revenue_excl_tax')::numeric,
  0.00,
  '任務 1(區間版):[9/1,9/30] 的未稅營收是 0.00,完成時間基準在區間版本一樣生效'
);

select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-10-01'::date, '2026-10-31'::date
  ) ->> 'total_revenue_excl_tax')::numeric,
  1000.00,
  '任務 1(區間版):[10/1,10/31] 的未稅營收是 1000.00'
);

-- =========================================================================
-- ② 任務 2(核心必測):離職人員的當月扣款要被算到、而且要出現在明細裡。
--    T2 在 2026-09 還在職(10/5 才離職),9 月請假 3 天扣 3000。
-- =========================================================================
select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_monthly_salary_base')::numeric,
  50000.00,
  '任務 2:9 月的月薪基本額 = T2(30000,當時還在職)+ T3(20000)= 50000(這一半原本就是對的,靠 11.6 的歷史母體)'
);

select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_monthly_salary_deduction')::numeric,
  3000.00,
  '任務 2(核心):9 月的月薪扣款 = T2 請假 3 天 × (30000/30) = 3000 —— 原本這裡用 ms.status=active 當母體,T2 已離職所以這 3000 會整個漏掉,月薪實發因此多算'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(
      get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
    ) as elem
    where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000042'
  ),
  '任務 2(核心):已離職的 T2 確實出現在 9 月報表的 per_staff_breakdown 裡(使用者裁決:「即便這個人離職,紀錄還是存在…既然有紀錄怎麼可能跨月就把紀錄刪除了?」)'
);

select is(
  (select (elem ->> 'net_pay')::numeric
   from jsonb_array_elements(
     get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000042'),
  27000.00,
  '任務 2:T2 在 9 月的 net_pay = 30000 − 3000 = 27000(明細的數字跟上方卡片的扣款對得起來)'
);

-- 明細加總 vs 卡片:這正是使用者原本抱怨「對不起來」的那件事,直接驗一次。
select is(
  (select sum((elem ->> 'net_pay')::numeric)
   from jsonb_array_elements(
     get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'net_pay' is not null),
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_monthly_salary_base')::numeric
  - (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'total_monthly_salary_deduction')::numeric,
  '任務 2(核心,這是使用者原本的抱怨本身):per_staff_breakdown 的 net_pay 加總 == 卡片的(月薪基本額 − 月薪扣款),兩邊母體一致所以永遠對得起來'
);

-- 反面:查 2026-10(T2 在 10/5 已離職,當月月底 as_of 是 removed)→ T2 不該再出現。
select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 10) ->> 'total_monthly_salary_base')::numeric,
  20000.00,
  '任務 2(反面):查 2026-10 時 T2 已離職(月底 as_of 是 removed)→ 月薪基本額只剩 T3 的 20000'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(
      get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 10) -> 'per_staff_breakdown'
    ) as elem
    where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000042'
  ),
  '任務 2(反面):T2 在 2026-10 的明細裡不出現——「當時在職」是逐月判斷的,不是「離職的人永遠都列出來」'
);

-- -------------------------------------------------------------------------
-- 任務 2 追加(主腦裁決):is_active_as_of —— 讓前端知道要不要顯示「已離職」標籤。
-- ⚠️ 語意是「這個人**目前**是否仍在職」,不是「在查詢期間那一刻是否在職」(後者因為母體條件
--    本身就是「當時在職」,恆為 true,當旗標沒有資訊量)。詳見 migration 內的註解。
-- -------------------------------------------------------------------------
select is(
  (select (elem ->> 'is_active_as_of')::boolean
   from jsonb_array_elements(
     get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000042'),
  false,
  '任務 2(追加 is_active_as_of):T2 出現在 9 月報表的明細裡,但 is_active_as_of = false —— 前端靠這個旗標顯示「已離職」標籤,商家才不會看到一個名單上已經沒有的人卻不知道原因'
);

select is(
  (select (elem ->> 'is_active_as_of')::boolean
   from jsonb_array_elements(
     get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000043'),
  true,
  '任務 2(追加 is_active_as_of):一直在職的 T3 的 is_active_as_of = true(不顯示標籤)'
);

-- 區間版本也要有這個欄位(主腦要求兩支函式都加)。
select is(
  (select (elem ->> 'is_active_as_of')::boolean
   from jsonb_array_elements(
     get_merchant_billing_summary_by_range(
       'e8030000-0000-4000-8000-000000000020', '2026-09-01'::date, '2026-09-30'::date
     ) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000042'),
  false,
  '任務 2(追加 is_active_as_of):區間版本 get_merchant_billing_summary_by_range 也有這個欄位,已離職的 T2 同樣是 false'
);

-- 非完整月份時這個旗標仍然要在(它跟月薪計不計算無關,是人員狀態資訊)。
select is(
  (select (elem ->> 'is_active_as_of')::boolean
   from jsonb_array_elements(
     get_merchant_billing_summary_by_range(
       'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
     ) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000042'),
  false,
  '任務 2(追加 is_active_as_of):非完整月份(月薪欄位是 null)時 is_active_as_of 仍然正確回傳——它是人員狀態資訊,跟月薪算不算得出來無關'
);

-- 這一條釘住 §11.9 那條決策記錄真的被推翻了(原本的斷言是「人數不隨查詢月份改變」)。
select isnt(
  jsonb_array_length(get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'),
  jsonb_array_length(get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 10) -> 'per_staff_breakdown'),
  '任務 2:per_staff_breakdown 的人數**會**隨查詢月份改變(9 月 3 人、10 月 2 人)——明確推翻模組 8 §11.9「維持目前在職名單、不逐月還原歷史人員名單」那條決策記錄,以使用者裁決為準'
);

-- =========================================================================
-- ③ 任務 3(核心必測):月薪只在「選了完整月份」時才計算。
-- =========================================================================
-- 3-a. 完整單月 [9/1,9/30] → salary_applicable=true,而且月薪數字真的有算出來。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-01'::date, '2026-09-30'::date
  ) ->> 'salary_applicable')::boolean,
  true,
  '任務 3:[9/1,9/30] 是完整月份 → salary_applicable = true'
);

select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-01'::date, '2026-09-30'::date
  ) ->> 'total_monthly_salary_base')::numeric,
  50000.00,
  '任務 3:完整月份時月薪基本額照常算出來(50000),不是被這次改動一起擋掉'
);

-- 3-b. 完整跨月 [9/1,10/31] → 仍然是完整月份(可以跨多個月),而且逐月加總正確:
--      9 月 T2(30000)+T3(20000)= 50000,10 月 T2 已離職只有 T3(20000)→ 合計 70000。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-01'::date, '2026-10-31'::date
  ) ->> 'salary_applicable')::boolean,
  true,
  '任務 3:[9/1,10/31] 跨兩個完整月份也算「完整月份」→ salary_applicable = true'
);

select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-01'::date, '2026-10-31'::date
  ) ->> 'total_monthly_salary_base')::numeric,
  70000.00,
  '任務 3:[9/1,10/31] 逐月加總 = 50000(9月:T2+T3)+ 20000(10月:T2已離職只剩T3)= 70000'
);

-- 3-c. 非完整月份 [9/15,10/14] → salary_applicable=false,月薪三項一律 null。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
  ) ->> 'salary_applicable')::boolean,
  false,
  '任務 3(核心):[9/15,10/14] 不是完整月份 → salary_applicable = false'
);

-- ⚠️ 用 jsonb_typeof 而不是 `is null`:這樣才真的分辨得出「JSON null」跟「數字 0」,
--    也就是使用者/前端要求的「要能分辨『不適用』與『真的是零』」。
--    jsonb_typeof 對 JSON null 回傳 'null',對 0 回傳 'number'。
select is(
  jsonb_typeof(get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
  ) -> 'total_monthly_salary_base'),
  'null',
  '任務 3(核心):非完整月份時 total_monthly_salary_base 是 JSON null,**不是** 0(前端要能分辨「不適用」與「真的是零」)'
);

select is(
  jsonb_typeof(get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
  ) -> 'total_monthly_salary_deduction'),
  'null',
  '任務 3(核心):非完整月份時 total_monthly_salary_deduction 是 JSON null,不是 0'
);

select is(
  jsonb_typeof(get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
  ) -> 'estimated_net_margin'),
  'null',
  '任務 3(核心):非完整月份時 estimated_net_margin(商家總淨利)是 JSON null——月薪算不出來,這個數字就沒有意義,不拿營收硬湊一個給商家看'
);

select is(
  (select jsonb_typeof(elem -> 'net_pay')
   from jsonb_array_elements(
     get_merchant_billing_summary_by_range(
       'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
     ) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000043'),
  'null',
  '任務 3(核心):非完整月份時,服務人員明細裡月薪制人員的 net_pay 也是 JSON null,不是 0'
);

-- 3-d. 非完整月份時,營收/稅金/料錢/抽成/訂單數必須照常計算(這是任務 3 最容易做錯的一半:
--      很容易連非月薪的數字一起擋掉)。這個區間涵蓋 10/5(那筆訂單的完成時間)。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
  ) ->> 'total_revenue_excl_tax')::numeric,
  1000.00,
  '任務 3(核心的另一半):非完整月份時營收照常計算(1000.00,那筆訂單 10/5 完成落在這個區間),不是連營收一起變 null'
);

select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
  ) ->> 'total_material_cost')::numeric,
  200.00,
  '任務 3:非完整月份時料錢成本照常計算(200.00)'
);

select is(
  (select (elem ->> 'order_count')::int
   from jsonb_array_elements(
     get_merchant_billing_summary_by_range(
       'e8030000-0000-4000-8000-000000000020', '2026-09-15'::date, '2026-10-14'::date
     ) -> 'per_staff_breakdown'
   ) as elem
   where elem ->> 'staff_id' = 'e8030000-0000-4000-8000-000000000041'),
  1,
  '任務 3:非完整月份時訂單數照常計算(T1 = 1 筆)'
);

-- 3-e. 跨月重複計算的 bug 不再發生(這是任務 3 順便消滅的那個真 bug)。
--      「查 2/15–3/15(29 天)」原本會收到 **2 個月的整月月薪基本額**(generate_series 以月初
--      為單位展開,2/15 和 3/15 各被 date_trunc 成 2/1 和 3/1),而扣款那一邊卻是按區間裁切,
--      兩邊口徑不一致。現在它 salary_applicable=false → 一律 null,不可能再出現那個數字。
--      對照:[2/1,2/28] 是完整月份 → 只算 1 個月 = 50000(T2/T3 從 2025-01-01 就在職)。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-02-15'::date, '2026-03-15'::date
  ) ->> 'salary_applicable')::boolean,
  false,
  '任務 3(跨月重複計算 bug):[2/15,3/15] 不是完整月份 → salary_applicable = false'
);

select is(
  jsonb_typeof(get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-02-15'::date, '2026-03-15'::date
  ) -> 'total_monthly_salary_base'),
  'null',
  '任務 3(跨月重複計算 bug 已消滅):[2/15,3/15](29 天)原本會收到「2 個月的整月月薪基本額」(100000),現在是 null,不可能再算出那個數字'
);

select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-02-01'::date, '2026-02-28'::date
  ) ->> 'total_monthly_salary_base')::numeric,
  50000.00,
  '任務 3(對照組):[2/1,2/28] 是完整月份 → 只算 1 個月的 50000,證明「1 個月就是 1 個月」,不是 2 個月'
);

-- 3-f. 按年月那一支永遠是完整月份,salary_applicable 固定 true(兩支介面一致)。
select is(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) ->> 'salary_applicable')::boolean,
  true,
  '任務 3:按年月那一支 get_merchant_billing_summary 本質上就是完整月份,salary_applicable 固定 true(兩支函式回傳形狀一致,前端不用分兩套處理)'
);

select ok(
  (get_merchant_billing_summary('e8030000-0000-4000-8000-000000000020', 2026, 9) -> 'salary_applicable') is not null,
  '任務 3:salary_applicable 這個 key 在按年月那一支也確實存在(前端防禦寫法是 `?? true`,key 真的要在,否則舊行為會繼續生效)'
);

-- 3-g. 邊界:結束日剛好是 2 月最後一天(閏年/平年都要對)。2026 是平年,2/28 是最後一天。
select is(
  (get_merchant_billing_summary_by_range(
    'e8030000-0000-4000-8000-000000000020', '2026-02-01'::date, '2026-02-27'::date
  ) ->> 'salary_applicable')::boolean,
  false,
  '任務 3(邊界):[2/1,2/27] 結束日不是 2 月最後一天(2026 是平年,最後一天是 2/28)→ salary_applicable = false'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
