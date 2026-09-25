-- 服務人員抽成報表「歸月基準 = 完成時間」的回歸測試(SPECS-INDEX #785,
-- 規格書 .project/specs/服務人員報表歸月基準修正.md,對應 migration
-- 20260925020000_staff_commission_summary_completion_time_basis.sql)。
--
-- 【為什麼需要這份測試】
-- #767 這個 bug 能一路漏到 2026-09-25 才被發現,根本原因是:
--   **repo 裡沒有任何一條測試在守「服務人員側」與「商家帳務側」的金額一致性。**
-- 既有那條看起來像跨視角對帳的 e2e(staff-portal-v2.spec.ts)比的是
--   /app/my-payroll(get_staff_commission_summary_by_range)
--   vs /app/staff-report(get_staff_commission_summary)
-- —— 兩個畫面、**同一組函式、同一個歸月基準**,所以它在結構上永遠不可能抓到基準分岔:
-- 兩邊會一起錯、一起相等、一起綠。
-- 這份檔案的第 ⑤ 區塊(跨視角對帳)就是來補這個洞的,它是唯一一條會在
-- 「服務人員側用 A 基準、商家帳務側用 B 基準」時變紅的資料庫斷言。
--
-- 【時間軸為什麼要手動改寫】
-- 比照 supabase/tests/database/module8_03_billing_completion_time_and_salary_applicable.sql
-- 的既有做法(它自己又是比照 module8_02 §11.5):complete_booking() 一律寫 completed_at = now(),
-- booking_commission_records.computed_at 的欄位預設也是 now(),在同一個測試交易裡**不可能**
-- 自然產生「9 月預約、10 月完成」這種跨月時間軸。所以先正常走 create → confirm → complete,
-- 再以 postgres 身分把 completed_at 與 computed_at 改寫成我們要的精確時刻。
-- 🔴 這次跟 module8_03 不同的地方:**要一併改寫 booking_commission_records.computed_at**,
--    因為 #767 的抽成基準用的就是這個欄位,只改 bookings.completed_at 會測不到東西。
-- 改寫之後,測試結果完全不依賴測試執行當下的時鐘時間,穩定可重現。
--
-- 【每一條都是「前提斷言 → 行為斷言」兩段式】
-- 本專案連續抓到兩次「空清單假通過」(scalar subquery 對空集合回傳 NULL,is(NULL, null) 為真),
-- 所以每一組行為斷言前面都先證明「資料真的長成我以為的樣子」。前提斷言不是形式。
begin;

-- 18 條:4 條前提 + 14 條行為/反向。逐條對應規格書 #785 的八個情境。
select plan(18);

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
--   S1:主角(按件計酬)。B1 是他自己接的單 → 產生抽成紀錄;B2 他是助手 → 不產生抽成紀錄。
--   S2:B2 的主責服務人員,只是為了讓 S1 有一個「以助手身份參與」的對象。
-- =========================================================================
insert into auth.users (id, email) values
  ('e8040000-0000-4000-8000-000000000001', 'pgtap-m804-admin@test.local');

insert into groups (id) values ('e8040000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e8040000-0000-4000-8000-000000000020', 'e8040000-0000-4000-8000-000000000010',
        '服務人員抽成歸月基準測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('e8040000-0000-4000-8000-000000000020', 'e8040000-0000-4000-8000-000000000001');

-- 全天營業,避免建單被營業時間擋下(訂單刻意建在過去的日期,create_booking 沒有「不可建立
-- 過去預約」的檢查,已對正式庫 prosrc 逐行查證)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8040000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e8040000-0000-4000-8000-000000000031', 'e8040000-0000-4000-8000-000000000020', '測試服務', 1000, 'primary', 30);

insert into payment_methods (id, merchant_id, name) values
  ('e8040000-0000-4000-8000-000000000071', 'e8040000-0000-4000-8000-000000000020', '現場付款');

-- 不指定欄位 → commission_basis_type 吃預設值 gross(抽成基準 = 小計 − 折扣,不扣稅金/料錢)。
insert into merchant_payroll_settings (merchant_id) values ('e8040000-0000-4000-8000-000000000020');

insert into merchant_staff (id, merchant_id, name, phone, compensation_type, no_time_slot_limit) values
  ('e8040000-0000-4000-8000-000000000041', 'e8040000-0000-4000-8000-000000000020',
   'S1主角按件計酬', '0900000841', 'piece_rate', true),
  ('e8040000-0000-4000-8000-000000000042', 'e8040000-0000-4000-8000-000000000020',
   'S2助手情境用', '0900000842', 'piece_rate', true);

-- 抽成比例:S1 對這個服務項目 20% → 1000 × 20% = 200.00。
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('e8040000-0000-4000-8000-000000000041', 'e8040000-0000-4000-8000-000000000031', 'percentage', 20),
  ('e8040000-0000-4000-8000-000000000042', 'e8040000-0000-4000-8000-000000000031', 'percentage', 10);

-- -------------------------------------------------------------------------
-- 把兩位服務人員的薪資歷史起點往前推到 2025-01-01(比照 module8_03 的既有做法)。
-- 為什麼一定要做這一步:get_merchant_billing_summary 的 per_staff_breakdown 母體是
-- 「該月月底當時 existed 且 status = active」(private.get_staff_payroll_status_as_of)。
-- merchant_staff 的 INSERT 觸發器開出來的歷史區間 effective_from 是「測試執行當下」,
-- 如果不往前推,查 2026-10 的帳務報表時這兩個人會因為「當時還不存在」而整個不在名單裡,
-- 第 ⑤ 區塊的跨視角對帳就會變成拿 null 比 null —— 又是一個「空清單假通過」。
-- -------------------------------------------------------------------------
update staff_payroll_status_history
set effective_from = '2025-01-01 00:00:00+08'::timestamptz
where staff_id in ('e8040000-0000-4000-8000-000000000041', 'e8040000-0000-4000-8000-000000000042')
  and effective_to is null;

-- =========================================================================
-- 建立主角訂單 B1:**預約在 2026-09-20、完成在 2026-10-05**(S1 自己接的單)。
-- =========================================================================
select pg_temp.test_set_auth('e8040000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'e8040000-0000-4000-8000-000000000020',
  p_staff_id => 'e8040000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8040000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-09-20 10:00:00+08',
  p_customer_name => '九月預約十月完成(抽成)',
  p_customer_phone => '0955090001',
  p_payment_method_id => 'e8040000-0000-4000-8000-000000000071'
) \gset b1_
select confirm_booking(:'b1_id'::uuid);
select complete_booking(:'b1_id'::uuid);

-- B2:S2 主責、**S1 當助手**,預約 2026-09-21、完成 2026-10-06。
-- 助手參與的訂單不會產生 S1 的 commission record —— 這正是 #779 必須用
-- coalesce(b.completed_at, b.start_at) 而不是 bcr.computed_at 的原因。
select id from create_booking(
  p_merchant_id => 'e8040000-0000-4000-8000-000000000020',
  p_staff_id => 'e8040000-0000-4000-8000-000000000042',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','e8040000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-09-21 10:00:00+08',
  p_customer_name => '九月預約十月完成(助手)',
  p_customer_phone => '0955090002',
  p_assistant_staff_ids => array['e8040000-0000-4000-8000-000000000041']::uuid[],
  p_payment_method_id => 'e8040000-0000-4000-8000-000000000071'
) \gset b2_
select confirm_booking(:'b2_id'::uuid);
select complete_booking(:'b2_id'::uuid);

select pg_temp.test_clear_auth();

-- -------------------------------------------------------------------------
-- 關鍵的一步:把「完成時間」搬到 10 月,預約時間留在 9 月。
-- 🔴 bookings.completed_at 與 booking_commission_records.computed_at **兩個都要改**:
--    ・completed_at 是 #779(助手筆數)與商家營收的基準
--    ・computed_at  是 #767(抽成)與商家抽成支出的基準
--    只改其中一個,就會人工製造出「兩個基準分岔」的假象,反而測不到真正要測的東西。
-- -------------------------------------------------------------------------
update bookings set completed_at = '2026-10-05 15:00:00+08'::timestamptz where id = :'b1_id'::uuid;
update bookings set completed_at = '2026-10-06 15:00:00+08'::timestamptz where id = :'b2_id'::uuid;

update booking_commission_records set computed_at = '2026-10-05 15:00:00+08'::timestamptz
where booking_id = :'b1_id'::uuid;
update booking_commission_records set computed_at = '2026-10-06 15:00:00+08'::timestamptz
where booking_id = :'b2_id'::uuid;

-- =========================================================================
-- ① 前提斷言:先證明「跨月的資料真的造出來了」。
--    這四條如果紅了,底下十四條全部沒有意義 —— 它們會在一個「根本沒跨月」的資料上
--    互相對照然後一起變綠(典型的假通過)。
-- =========================================================================
select is(
  (select date_trunc('month', start_at at time zone 'Asia/Taipei')
        = date_trunc('month', completed_at at time zone 'Asia/Taipei')
   from bookings where id = :'b1_id'::uuid),
  false,
  '前提①:B1 的預約月份與完成月份確實不同(9 月預約、10 月完成),跨月時間軸造出來了'
);

select is(
  (select count(*)::int from booking_commission_records
   where booking_id = :'b1_id'::uuid
     and date_trunc('month', computed_at at time zone 'Asia/Taipei') = '2026-10-01'::timestamp),
  1,
  '前提②:B1 的抽成紀錄剛好 1 筆,而且 computed_at 已被改寫到 2026-10(#767 用的就是這個欄位)'
);

select is(
  (select count(*)::int from booking_assistants
   where staff_id = 'e8040000-0000-4000-8000-000000000041' and booking_id = :'b2_id'::uuid),
  1,
  '前提③:S1 在 B2 確實有 1 筆「以助手身份參與」的紀錄(#779 要驗的就是這個數字)'
);

select is(
  (select count(*)::int from booking_commission_records
   where booking_id = :'b2_id'::uuid and staff_id = 'e8040000-0000-4000-8000-000000000041'),
  0,
  '前提④:助手(S1)在 B2 **沒有**抽成紀錄 —— 這正是 #779 不能跟 #767 共用 bcr.computed_at 的原因(根本 join 不到)'
);

-- =========================================================================
-- ② #767 核心:抽成算在「按下完成」的那個月,不是預約的那個月。
--    正向 + 反向兩個方向都要驗:只驗正向的話,一個「兩個月都算」的錯誤實作也會通過。
-- =========================================================================
select pg_temp.test_set_auth('e8040000-0000-4000-8000-000000000001');

select is(
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10) ->> 'total_orders')::int,
  1,
  '#767(正向):9/20 預約、10/5 完成的訂單,出現在服務人員 10 月的抽成報表(使用者裁決:「直到哪個月份按完成才歸在那個月」)'
);

select is(
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 9) ->> 'total_orders')::int,
  0,
  '#767(反向):同一筆訂單在服務人員 9 月的抽成報表是 0 筆(使用者裁決:「若訂單在 9 月但未完成代表他在 9 月還沒收到錢」)'
);

select is(
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10) ->> 'total_commission_amount')::numeric,
  200.00,
  '#767:完成當月(10 月)的抽成金額 = 1000 × 20% = 200.00'
);

-- =========================================================================
-- ③ #779:助手參與筆數也用同一個月份口徑(但刻意用不同的欄位,見 migration 註解)。
-- =========================================================================
select is(
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10) ->> 'assistant_booking_count')::int,
  1,
  '#779(正向):B2 完成在 10/6 → S1「以助手身份參與」的筆數算在 10 月'
);

select is(
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 9) ->> 'assistant_booking_count')::int,
  0,
  '#779(反向):B2 預約在 9/21,但 9 月的助手筆數是 0 —— 助手筆數跟抽成用同一個月份口徑,不會一個算 9 月一個算 10 月'
);

-- =========================================================================
-- ④ #780:明細的日期欄位改名 completion_date,且過渡期 order_date 仍然輸出、值相同。
-- =========================================================================
select is(
  jsonb_array_length(get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10) -> 'details'),
  1,
  '前提⑤(#780):完成當月的明細陣列剛好 1 筆 —— 不先證明非空,下面兩條對 details[0] 的斷言會在空陣列上拿到 null 然後假通過'
);

select is(
  to_char(
    ((get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10)
      -> 'details' -> 0 ->> 'completion_date')::timestamptz at time zone 'Asia/Taipei'),
    'YYYY-MM'
  ),
  '2026-10',
  '#780:明細列的 completion_date 顯示的是「完成月份」(2026-10),不是預約月份(2026-09)——欄位名與內容一致'
);

select ok(
  (
    select (elem ? 'order_date') and (elem ->> 'order_date') = (elem ->> 'completion_date')
    from (select get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10)
                 -> 'details' -> 0 as elem) t
  ),
  '#780 過渡期相容欄位:order_date 仍然有輸出,而且值跟 completion_date 完全相同(資料庫先上、前端還是舊版時不會印出 Invalid Date;移除登記為 #783)'
);

-- =========================================================================
-- ⑤ 🔴 跨視角對帳 —— 這是整份檔案最重要的一段。
--    它是**唯一**一條會在「服務人員側與商家帳務側用不同歸月基準」時變紅的斷言,
--    也就是 #767 這個 bug 本身的守門員。
--    既有的「跨視角一致」e2e 比的是同一支函式的兩個畫面,結構上抓不到這件事(見檔頭說明)。
-- =========================================================================
select is(
  (select count(*)::int
   from jsonb_array_elements(
     get_merchant_billing_summary('e8040000-0000-4000-8000-000000000020', 2026, 10) -> 'per_staff_breakdown'
   ) elem
   where elem ->> 'staff_id' = 'e8040000-0000-4000-8000-000000000041'),
  1,
  '前提⑥:商家帳務報表 10 月的 per_staff_breakdown 裡確實找得到 S1 這一列 —— 不先證明,下一條的相等斷言就是拿 null 比 null'
);

select is(
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10) ->> 'total_commission_amount')::numeric,
  (select (elem ->> 'commission_amount')::numeric
   from jsonb_array_elements(
     get_merchant_billing_summary('e8040000-0000-4000-8000-000000000020', 2026, 10) -> 'per_staff_breakdown'
   ) elem
   where elem ->> 'staff_id' = 'e8040000-0000-4000-8000-000000000041'),
  '🔴 #767 核心守門員(跨視角對帳):同一位服務人員、同一個月份,服務人員報表的「抽成合計」必須等於商家帳務報表 per_staff_breakdown 裡他那一列的抽成金額。兩側只要有任何一邊改回別的歸月基準,這一條就會紅'
);

select is(
  (select (elem ->> 'commission_amount')::numeric
   from jsonb_array_elements(
     get_merchant_billing_summary('e8040000-0000-4000-8000-000000000020', 2026, 9) -> 'per_staff_breakdown'
   ) elem
   where elem ->> 'staff_id' = 'e8040000-0000-4000-8000-000000000041'),
  0.00,
  '跨視角對帳(反向):商家帳務報表 9 月的 S1 抽成也是 0 —— 兩側是「一起搬到 10 月」,不是「服務人員側被搬走、商家側留在 9 月」'
);

-- =========================================================================
-- ⑥ 區間版與單月版不可以分岔(兩支函式服務兩個不同的畫面:
--    /app/staff-report 用單月版、/app/my-payroll 用區間版)。
-- =========================================================================
select is(
  (get_staff_commission_summary_by_range(
    'e8040000-0000-4000-8000-000000000041', '2026-10-01'::date, '2026-10-31'::date
  ) ->> 'total_orders')::int,
  1,
  '前提⑦:區間版對「完成月整月」[10/1,10/31] 回傳 1 筆 —— 先證明區間版也查得到,下一條的相等斷言才有意義'
);

select is(
  (get_staff_commission_summary_by_range(
    'e8040000-0000-4000-8000-000000000041', '2026-10-01'::date, '2026-10-31'::date
  ) ->> 'total_commission_amount')::numeric,
  (get_staff_commission_summary('e8040000-0000-4000-8000-000000000041', 2026, 10) ->> 'total_commission_amount')::numeric,
  '#767:區間版與單月版對同一個月回傳完全相同的抽成金額(任何一支漏改,商家管理員頁與服務人員自助頁就會對同一個月給出不同的數字)'
);

select is(
  (get_staff_commission_summary_by_range(
    'e8040000-0000-4000-8000-000000000041', '2026-09-01'::date, '2026-09-30'::date
  ) ->> 'total_orders')::int,
  0,
  '#767(反向,區間版):[9/1,9/30] 是 0 筆 —— 區間版的歸月基準跟單月版一致,沒有一邊改到、一邊漏掉'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
