-- SPECS-INDEX #1035 彈性計薪 B 批(日薪／時薪制)— 資料、上工時間、凍結與重算
-- migration 20261010170000_req1035b_wage_schema.sql、20261010170100_req1035b_wage_functions.sql
-- 規格書:母版 .project/specs/彈性計薪.md PB-D01~D04、PB-R01~R04、PB-F01~F04、PB-U03、PB-U04、PB-U05、第七節 PT(B)。
--
--   D  check 擴充、新表 RLS / 權限、歷史同步(費率改了開新列、相同值不開)、as_of 回傳型別 + 7 支呼叫者照常執行
--   R  PB-R01:時段 ∩ 營業時間、關閉格、請假、時段外訂單、重疊只算一次、跟場算、取消不算、跨午夜、24:00、
--      公休日、unlimited_backend_edit 不影響;PB-R02:「2 小時 20 分 × 200 = 467」、日薪 0 分鐘 = 0
--   F  凍結:35 天補跑、不覆蓋;改每週範本不變;改那天的格子 / 訂單 / 跟場 / 請假會重算;抽成制不寫
--   W  PB-R04 settled / unsettled / estimated、未來不算
--   P  PB-F01~F04 權限與 IDOR、create_staff_leave 三種可 / 抽成制擋、can_self_manage_availability 擋日薪／時薪、
--      get_completed_booking_reversal_preview 日薪／時薪走「沒有抽成」
--   🔴 日期全部用 2026-03(已經過去的固定日期);歷史列手動往前挪到 2025-01-01,模擬「當時就是日薪／時薪制」。
begin;

select plan(80);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- ── Fixture ───────────────────────────────────────────────────────────────
--   W 店:01 管理員;H 時薪(200)、D 日薪(1500)、PR 抽成(對照)、MS 月薪(請假對照)、PR2 抽成 + 登入(自助開關時段對照)
--   X 店:02 管理員(IDOR 用)
--   營業時間:週一 09:00~18:00、週二公休、週三 00:00~24:00;週四沒設定。
insert into auth.users (id, email) values
  ('f1035c00-0000-4000-8000-000000000001', 'pgtap-1035b-w-admin@test.local'),
  ('f1035c00-0000-4000-8000-000000000002', 'pgtap-1035b-x-admin@test.local'),
  ('f1035c00-0000-4000-8000-000000000003', 'pgtap-1035b-h-staff@test.local'),
  ('f1035c00-0000-4000-8000-000000000004', 'pgtap-1035b-pr2-staff@test.local');
insert into groups (id) values
  ('f1035c00-0000-4000-8000-000000000011'),
  ('f1035c00-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000011', '#1035B 工資店', 'on_site_dispatch'),
  ('f1035c00-0000-4000-8000-000000000021', 'f1035c00-0000-4000-8000-000000000012', '#1035B 別家店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000001', 'W 店主'),
  ('f1035c00-0000-4000-8000-000000000021', 'f1035c00-0000-4000-8000-000000000002', 'X 店主');
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('f1035c00-0000-4000-8000-000000000020', 1, false, '09:00', '18:00'),
  ('f1035c00-0000-4000-8000-000000000020', 2, true, null, null),
  ('f1035c00-0000-4000-8000-000000000020', 3, false, '00:00', '24:00');
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000003', '時薪H', 'hourly_wage', 'active', 'active', now(), '0900103640'),
  ('f1035c00-0000-4000-8000-000000000041', 'f1035c00-0000-4000-8000-000000000020', null, '日薪D', 'daily_wage', 'active', 'not_invited', null, '0900103641'),
  ('f1035c00-0000-4000-8000-000000000042', 'f1035c00-0000-4000-8000-000000000020', null, '抽成PR', 'piece_rate', 'active', 'not_invited', null, '0900103642'),
  ('f1035c00-0000-4000-8000-000000000043', 'f1035c00-0000-4000-8000-000000000020', null, '月薪MS', 'monthly_salary', 'active', 'not_invited', null, '0900103643'),
  ('f1035c00-0000-4000-8000-000000000044', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000004', '抽成PR2', 'piece_rate', 'active', 'active', now(), '0900103644');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f1035c00-0000-4000-8000-000000000040', 'staff_availability_self_manage', true),
  ('f1035c00-0000-4000-8000-000000000044', 'staff_availability_self_manage', true);
insert into merchant_leave_types (id, merchant_id, name) values
  ('f1035c00-0000-4000-8000-000000000060', 'f1035c00-0000-4000-8000-000000000020', '事假');

-- =========================================================================
-- D 資料
-- =========================================================================
select is(
  (select array_agg(pg_get_constraintdef(oid) order by conrelid::regclass::text) from pg_constraint
   where conname in ('merchant_staff_compensation_type_check', 'staff_payroll_status_history_compensation_type_check')),
  array[
    'CHECK ((compensation_type = ANY (ARRAY[''monthly_salary''::text, ''piece_rate''::text, ''daily_wage''::text, ''hourly_wage''::text])))',
    'CHECK ((compensation_type = ANY (ARRAY[''monthly_salary''::text, ''piece_rate''::text, ''daily_wage''::text, ''hourly_wage''::text])))'],
  'D01 兩張表的計酬類型 check 都是四種(原兩種逐字保留在前)'
);
select is(
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'merchant_staff' and column_name = 'compensation_type'),
  '''piece_rate''::text',
  'D01 預設值不變(抽成制)'
);
select throws_ok(
  $$update merchant_staff set compensation_type = 'weekly' where id = 'f1035c00-0000-4000-8000-000000000042'$$,
  '23514', null, 'D01 其他值被 check 擋下'
);
select is(
  (select array_agg(c.relname::text || ':' || c.relrowsecurity::text || ':' ||
                    (select count(*) from pg_policy p where p.polrelid = c.oid)::text order by c.relname)
   from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('staff_wage_settings', 'staff_work_day_records')),
  array['staff_wage_settings:true:0', 'staff_work_day_records:true:0'],
  'D02/D04 新表 RLS 開、0 policy'
);
select ok(
  not has_table_privilege('anon', 'public.staff_wage_settings', 'select')
  and not has_table_privilege('authenticated', 'public.staff_wage_settings', 'select')
  and not has_table_privilege('authenticated', 'public.staff_wage_settings', 'insert')
  and not has_table_privilege('anon', 'public.staff_work_day_records', 'select')
  and not has_table_privilege('authenticated', 'public.staff_work_day_records', 'select')
  and not has_table_privilege('authenticated', 'public.staff_work_day_records', 'update'),
  'D02/D04 anon / authenticated 對新表沒有任何權限'
);
select throws_ok(
  $$insert into staff_wage_settings (staff_id, merchant_id, wage_amount) values ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000020', -1)$$,
  '23514', null, 'D02 金額 < 0 被 check 擋下'
);
select throws_ok(
  $$insert into staff_work_day_records (merchant_id, staff_id, work_date, compensation_type, wage_amount, shift_minutes, extra_booking_minutes, worked_minutes, pay_amount)
    values ('f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000042', '2026-03-02', 'piece_rate', 0, 0, 0, 0, 0)$$,
  '23514', null, 'D04 compensation_type 只能是日薪／時薪'
);

-- 費率 → 歷史同步
insert into staff_wage_settings (staff_id, merchant_id, wage_amount) values
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000020', 200),
  ('f1035c00-0000-4000-8000-000000000041', 'f1035c00-0000-4000-8000-000000000020', 1500);
select is(
  (select array_agg(coalesce(wage_amount::text, 'null') order by effective_from) from staff_payroll_status_history
   where staff_id = 'f1035c00-0000-4000-8000-000000000040'),
  array['0.00', '200.00'],
  'D03 設定時薪 ⇒ 歷史開新一列,wage_amount = 200(新增服務人員那列是 0)'
);
update staff_wage_settings set wage_amount = 200 where staff_id = 'f1035c00-0000-4000-8000-000000000040';
select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'f1035c00-0000-4000-8000-000000000040'),
  2, 'D03 金額相同 ⇒ 不開新列'
);
select is(
  (select count(*)::int from staff_payroll_status_history
   where staff_id = 'f1035c00-0000-4000-8000-000000000042' and wage_amount is not null and wage_amount <> 0),
  0, 'D03 抽成制的人 wage_amount = 0'
);
select ok(
  exists (select 1 from pg_trigger where tgname = 'staff_wage_settings_sync_payroll_status_history' and tgenabled = 'O'),
  'D03 費率 trigger 存在且啟用'
);
select is(
  (select pg_get_function_result('private.get_staff_payroll_status_as_of(uuid, timestamptz)'::regprocedure)),
  'TABLE(compensation_type text, status text, monthly_base_salary numeric, is_estimated boolean, existed boolean, bonus_plan_id uuid, wage_amount numeric)',
  'D03 as_of 多回 wage_amount(放最後,前六欄不變)'
);
select is(
  (select array_to_string(proacl, ',') from pg_proc where oid = 'private.get_staff_payroll_status_as_of(uuid, timestamptz)'::regprocedure),
  'postgres=X/postgres',
  'D03 as_of 只有擁有者可執行(#1051 收回 private 函式的 authenticated 執行權)'
);

-- 歷史往前挪:H、D、PR、MS 從 2025-01-01 起就是現在的狀態(只留最新一列)
delete from staff_payroll_status_history
where staff_id in ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000041',
                   'f1035c00-0000-4000-8000-000000000042', 'f1035c00-0000-4000-8000-000000000043')
  and effective_to is not null;
update staff_payroll_status_history set effective_from = '2025-01-01 00:00+08'
where staff_id in ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000041',
                   'f1035c00-0000-4000-8000-000000000042', 'f1035c00-0000-4000-8000-000000000043');

select is(
  (select wage_amount from private.get_staff_payroll_status_as_of('f1035c00-0000-4000-8000-000000000040', '2026-03-02 12:00+08')),
  200::numeric, 'D03 as_of 回當時的時薪'
);

-- as_of 的 7 支呼叫者照常執行(PL/pgSQL 沒有 pg_depend,drop + create 後要實際呼叫一次)
select lives_ok($$select private.compute_staff_payroll('f1035c00-0000-4000-8000-000000000043', 2026, 3)$$, 'D03 呼叫者 compute_staff_payroll 可執行');
select lives_ok($$select private.compute_staff_payroll_by_range('f1035c00-0000-4000-8000-000000000043', '2026-03-01', '2026-03-31')$$, 'D03 呼叫者 compute_staff_payroll_by_range 可執行');
select lives_ok($$select private.get_merchant_monthly_salary_base_as_of('f1035c00-0000-4000-8000-000000000020', '2026-03-31 23:00+08')$$, 'D03 呼叫者 get_merchant_monthly_salary_base_as_of 可執行');
select lives_ok($$select private.compute_staff_monthly_bonus('f1035c00-0000-4000-8000-000000000043', '2026-03-01')$$, 'D03 呼叫者 compute_staff_monthly_bonus 可執行');
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
select lives_ok($$select public.get_merchant_billing_summary_by_range('f1035c00-0000-4000-8000-000000000020', make_date(2026, 3, 1), (make_date(2026, 3, 1) + interval '1 month - 1 day')::date)$$, 'D03 呼叫者 get_merchant_billing_summary_by_range(整個月份)可執行(#1051:舊版單月函式已移除)');
select lives_ok($$select public.get_merchant_billing_summary_by_range('f1035c00-0000-4000-8000-000000000020', '2026-03-01', '2026-03-31')$$, 'D03 呼叫者 get_merchant_billing_summary_by_range 可執行');
select lives_ok($$select public.get_staff_bonus_by_range('f1035c00-0000-4000-8000-000000000043', '2026-03-01', '2026-03-31')$$, 'D03 呼叫者 get_staff_bonus_by_range 可執行');
reset role;

-- ── 時段與訂單 ───────────────────────────────────────────────────────────
-- H:週一 10:00~12:00 + 12:00~14:00(兩組相接 ⇒ 10:00~14:00;每週時段本身不能重疊,有 trigger 擋);週三 22:00~24:00
-- D:週一 09:00~10:00
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('f1035c00-0000-4000-8000-000000000040', 1, '10:00', '12:00'),
  ('f1035c00-0000-4000-8000-000000000040', 1, '12:00', '14:00'),
  ('f1035c00-0000-4000-8000-000000000040', 3, '22:00', '24:00'),
  ('f1035c00-0000-4000-8000-000000000041', 1, '09:00', '10:00');
-- 2026-03-02(一)H 關 13:30 那一格 ⇒ 時段 10:00~13:30 = 210 分
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('f1035c00-0000-4000-8000-000000000040', '2026-03-02', '13:30', false);

insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status) values
  -- 03-02(一)H 主要 13:00~15:00 ⇒ 跟時段聯集 10:00~15:00 = 300 分,時段外 90 分
  ('f1035c00-0000-4000-8000-000000000070', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000040',
   '2026-03-02 13:00+08', '2026-03-02 15:00+08', '王', '0955103600', 'admin', 'accepted'),
  -- 03-02(一)H 取消的單 ⇒ 不算
  ('f1035c00-0000-4000-8000-000000000071', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000040',
   '2026-03-02 16:00+08', '2026-03-02 17:00+08', '王', '0955103600', 'admin', 'cancelled'),
  -- 03-03(二,公休)PR 主要、H 跟場 10:00~12:20 ⇒ H 140 分(2 小時 20 分)
  ('f1035c00-0000-4000-8000-000000000072', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000042',
   '2026-03-03 10:00+08', '2026-03-03 12:20+08', '王', '0955103600', 'admin', 'accepted'),
  -- 03-11(三)23:00 ~ 03-12(四)01:00 跨午夜
  ('f1035c00-0000-4000-8000-000000000073', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000040',
   '2026-03-11 23:00+08', '2026-03-12 01:00+08', '王', '0955103600', 'admin', 'accepted');
insert into booking_assistants (booking_id, staff_id) values
  ('f1035c00-0000-4000-8000-000000000072', 'f1035c00-0000-4000-8000-000000000040');
-- 03-04(三)H 請假
insert into staff_leave_records (id, staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status) values
  ('f1035c00-0000-4000-8000-000000000080', 'f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000060', '事假', '2026-03-04', '2026-03-04', 'confirmed');

-- =========================================================================
-- R 上工時間與金額
-- =========================================================================
create function pg_temp.wd(p_staff uuid, p_date date) returns text language sql as $$
  select concat_ws('/', shift_minutes, extra_booking_minutes, worked_minutes, is_leave::text, coalesce(leave_type_name, '-'))
  from private.compute_work_day(p_staff, p_date);
$$;

select is(pg_temp.wd('f1035c00-0000-4000-8000-000000000040', '2026-03-02'), '210/90/300/false/-',
  'R01 時段(兩組相接)− 關閉格 = 210;訂單跟時段重疊的 30 分只算一次 ⇒ 聯集 300、時段外 90;取消的單不算');
select is(pg_temp.wd('f1035c00-0000-4000-8000-000000000040', '2026-03-03'), '0/140/140/false/-',
  'R01 公休日時段 0;跟場的單照算(140 分)');
select is(pg_temp.wd('f1035c00-0000-4000-8000-000000000040', '2026-03-04'), '0/0/0/true/事假',
  'R01 請假那天全部 0');
select is(pg_temp.wd('f1035c00-0000-4000-8000-000000000040', '2026-03-11'), '120/0/120/false/-',
  'R01 時段到 24:00(= 1440 分,不回捲);跨午夜的單只算當天那段,落在時段內不重複算');
select is(pg_temp.wd('f1035c00-0000-4000-8000-000000000040', '2026-03-12'), '0/60/60/false/-',
  'R01 跨午夜的單隔天那段(00:00~01:00)算到隔天;營業時間沒設定 ⇒ 時段 0');
update merchant_staff set unlimited_backend_edit = true where id = 'f1035c00-0000-4000-8000-000000000040';
select is(pg_temp.wd('f1035c00-0000-4000-8000-000000000040', '2026-03-02'), '210/90/300/false/-',
  'R01 unlimited_backend_edit 不影響時段');
update merchant_staff set unlimited_backend_edit = false where id = 'f1035c00-0000-4000-8000-000000000040';

select is((private.wage_day_row('f1035c00-0000-4000-8000-000000000040', '2026-03-03') ->> 'pay_amount')::numeric, 467::numeric,
  'R02 時薪:2 小時 20 分 × 200 = 466.67 ⇒ 467(四捨五入到元)');
select is((private.wage_day_row('f1035c00-0000-4000-8000-000000000040', '2026-03-02') ->> 'pay_amount')::numeric, 1000::numeric,
  'R02 時薪:300 分 × 200 = 1000');
select is((private.wage_day_row('f1035c00-0000-4000-8000-000000000041', '2026-03-02') ->> 'pay_amount')::numeric, 1500::numeric,
  'R02 日薪:有上工(60 分)⇒ 一整天 1500');
select is((private.wage_day_row('f1035c00-0000-4000-8000-000000000041', '2026-03-03') ->> 'pay_amount')::numeric, 0::numeric,
  'R02 日薪:0 分鐘 ⇒ 0');
select ok(private.wage_day_row('f1035c00-0000-4000-8000-000000000042', '2026-03-02') is null,
  'R02 抽成制 ⇒ 不計(null)');
select ok(private.wage_day_row('f1035c00-0000-4000-8000-000000000040', '2024-12-31') is null,
  'R02 那天還不是日薪／時薪制(歷史開始之前、非回填種子)⇒ 不計');

-- =========================================================================
-- F 凍結與重算
-- =========================================================================
-- 上面建單 / 請假 / 關格子時 trigger 已經先寫了幾筆(那幾天是過去日),先清掉再驗純粹的排程凍結。
select ok((select count(*) from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040') > 0,
  'F00 新增過去日子的訂單 / 跟場 / 請假 / 關格子 ⇒ trigger 已經先寫入那幾天');
delete from staff_work_day_records;
select is(private.freeze_work_days('2026-03-13'), 70, 'F01 凍結:昨天 + 最近 35 天,H、D 各 35 筆');
select is(private.freeze_work_days('2026-03-13'), 0, 'F01 再跑一次 ⇒ 已存在的不覆蓋、不重寫');
select is(
  (select count(*)::int from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000042'), 0,
  'F01 抽成制不寫上工紀錄'
);
select is(
  (select concat_ws('/', compensation_type, wage_amount, worked_minutes, pay_amount, coalesce(refrozen_reason, '-'))
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-02'),
  'hourly_wage/200.00/300/1000/-',
  'F01 凍結紀錄內容 = 即時算的結果(費率快照 200)'
);

-- 改每週範本(刪掉 H 週三時段)⇒ 已凍結的 03-11 不變
delete from staff_availability_windows where staff_id = 'f1035c00-0000-4000-8000-000000000040' and day_of_week = 3;
select is(
  (select worked_minutes from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-11'),
  120, 'F02 改每週範本 ⇒ 過去已凍結的日子不變'
);
-- 改費率 ⇒ 已凍結的日子不變
update staff_wage_settings set wage_amount = 300 where staff_id = 'f1035c00-0000-4000-8000-000000000040';
select is(
  (select pay_amount from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-02'),
  1000::numeric, 'F02 改費率 ⇒ 過去已凍結的日子不變'
);

-- 改那天的格子(03-02 再關 10:00)⇒ 重算:時段 10:30~13:30、聯集 10:30~15:00 = 270 分,費率仍取當天 200 ⇒ 900
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('f1035c00-0000-4000-8000-000000000040', '2026-03-02', '10:00', false);
select is(
  (select concat_ws('/', worked_minutes, pay_amount, refrozen_reason)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-02'),
  '270/900/override', 'F03 改過去那天的格子 ⇒ 重算(費率仍是那天的 200)'
);
-- 改那天的訂單(結束改 16:00)⇒ 聯集 10:30~16:00 = 330 分 ⇒ 1100
update bookings set end_at = '2026-03-02 16:00+08' where id = 'f1035c00-0000-4000-8000-000000000070';
select is(
  (select concat_ws('/', worked_minutes, extra_booking_minutes, pay_amount, refrozen_reason)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-02'),
  '330/150/1100/booking', 'F04 改過去那天的訂單時間 ⇒ 重算'
);
-- 取消那張單 ⇒ 只剩時段 180 分 ⇒ 600
update bookings set status = 'cancelled' where id = 'f1035c00-0000-4000-8000-000000000070';
select is(
  (select concat_ws('/', worked_minutes, pay_amount)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-02'),
  '180/600', 'F04 取消過去那天的訂單 ⇒ 重算'
);
-- 把 H 從 03-03 的跟場拿掉 ⇒ 0
delete from booking_assistants where booking_id = 'f1035c00-0000-4000-8000-000000000072' and staff_id = 'f1035c00-0000-4000-8000-000000000040';
select is(
  (select concat_ws('/', worked_minutes, pay_amount, refrozen_reason)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-03'),
  '0/0/booking', 'F05 移除跟場 ⇒ 那天重算'
);
-- 把 D 加進 03-03 跟場 ⇒ D 那天變成有上工 ⇒ 1500
insert into booking_assistants (booking_id, staff_id) values
  ('f1035c00-0000-4000-8000-000000000072', 'f1035c00-0000-4000-8000-000000000041');
select is(
  (select concat_ws('/', worked_minutes, pay_amount)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000041' and work_date = '2026-03-03'),
  '140/1500', 'F05 加入跟場 ⇒ 那天重算(日薪有上工就算一天)'
);
-- 取消 03-04 的請假 ⇒ 重算(週三時段已經刪掉 ⇒ 0,不再是請假)
update staff_leave_records set status = 'cancelled', cancelled_at = now() where id = 'f1035c00-0000-4000-8000-000000000080';
select is(
  (select concat_ws('/', is_leave::text, worked_minutes, refrozen_reason)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-04'),
  'false/0/leave', 'F06 取消過去的請假 ⇒ 那天重算'
);
-- 新增過去的請假(03-02)⇒ 那天變請假、0 元
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status) values
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000060', '事假', '2026-03-02', '2026-03-02', 'confirmed');
select is(
  (select concat_ws('/', is_leave::text, leave_type_name, pay_amount, refrozen_reason)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-02'),
  'true/事假/0/leave', 'F06 新增過去的請假 ⇒ 那天重算為請假 0 元'
);
-- 抽成制的人改訂單不會寫紀錄、也不會出錯
update bookings set end_at = '2026-03-03 12:30+08' where id = 'f1035c00-0000-4000-8000-000000000072';
select is(
  (select count(*)::int from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000042'), 0,
  'F07 抽成制主要服務人員的訂單異動 ⇒ 不寫紀錄'
);
select is(
  (select pay_amount from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000041' and work_date = '2026-03-03'),
  1500::numeric, 'F07 同一張單的日薪跟場一起重算(仍 1500)'
);
-- 主腦裁決 M2:只改狀態時,只有「變成取消 / 從取消改回」才重算。
--   03-11(三)已凍結 120 分;週三時段已經刪掉(F02),若被重算會變成只剩訂單 60 分。
update bookings set status = 'completed', completed_at = '2026-03-12 01:00+08' where id = 'f1035c00-0000-4000-8000-000000000073';
select is(
  (select concat_ws('/', worked_minutes, coalesce(refrozen_reason, '-'))
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-11'),
  '120/-', 'M2 過去的單只從 accepted 改成 completed(範本已改)⇒ 凍結紀錄不變'
);
update bookings set status = 'cancelled' where id = 'f1035c00-0000-4000-8000-000000000073';
select is(
  (select concat_ws('/', worked_minutes, refrozen_reason)
   from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-11'),
  '0/booking', 'M2 改成取消 ⇒ 那天重算(時段已刪、單也取消 ⇒ 0)'
);
update bookings set status = 'accepted' where id = 'f1035c00-0000-4000-8000-000000000073';
select is(
  (select worked_minutes from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000040' and work_date = '2026-03-11'),
  60, 'M2 從取消改回 ⇒ 再重算(只剩訂單 23:00~24:00 = 60 分)'
);

select ok(
  (select bool_and(pg_get_triggerdef(t.oid) like '%AFTER%' and t.tgenabled = 'O')
   from pg_trigger t where t.tgname in ('staff_availability_overrides_refreeze_work_day', 'staff_leave_records_refreeze_work_day',
                                         'bookings_refreeze_work_day', 'booking_assistants_refreeze_work_day'))
  and (select count(*) from pg_trigger where tgname in ('staff_availability_overrides_refreeze_work_day', 'staff_leave_records_refreeze_work_day',
                                         'bookings_refreeze_work_day', 'booking_assistants_refreeze_work_day')) = 4,
  'F08 4 支重算 trigger 都是 AFTER、啟用中'
);
select is(
  (select schedule || ' ' || btrim(command) from cron.job where jobname = 'staff-work-day-freeze'),
  '15 16 * * * select private.freeze_work_days();',
  'F08 排程 staff-work-day-freeze:UTC 16:15(台北 00:15)'
);

-- =========================================================================
-- W 區間工資(PB-R04)
-- =========================================================================
select is(
  (select string_agg(d ->> 'date' || ':' || (d ->> 'state'), ',' order by d ->> 'date')
   from jsonb_array_elements(private.compute_staff_wage_by_range('f1035c00-0000-4000-8000-000000000040', '2026-02-05', '2026-02-07') -> 'days') d),
  '2026-02-05:unsettled,2026-02-06:settled,2026-02-07:settled',
  'W01 有凍結紀錄 ⇒ settled;沒有(35 天外)⇒ 即時算 unsettled'
);
select is(
  (select d ->> 'state' from jsonb_array_elements(private.compute_staff_wage_by_range('f1035c00-0000-4000-8000-000000000040',
     private.wage_today() - 1, private.wage_today() + 5) -> 'days') d where (d ->> 'date')::date = private.wage_today()),
  'estimated', 'W02 今天 ⇒ estimated'
);
select is(
  (select count(*)::int from jsonb_array_elements(private.compute_staff_wage_by_range('f1035c00-0000-4000-8000-000000000040',
     private.wage_today() - 1, private.wage_today() + 5) -> 'days') d where (d ->> 'date')::date > private.wage_today()),
  0, 'W03 未來的日子不算'
);
select is(
  (select concat_ws('/', r ->> 'total_pay', r ->> 'work_days', r ->> 'total_worked_minutes')
   from (select private.compute_staff_wage_by_range('f1035c00-0000-4000-8000-000000000041', '2026-03-02', '2026-03-03') r) x),
  '3000/2/210', 'W04 日薪 D:03-02(60 分)+ 03-03(跟場,單改到 12:30 ⇒ 150 分)= 2 天 3000 元'
);

-- =========================================================================
-- P 對外函式權限、請假、自己開關時段、還原預覽
-- =========================================================================
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000002');
select throws_ok($$select public.set_staff_wage('f1035c00-0000-4000-8000-000000000040', 100)$$, '42501', null, 'P01 別家店主不能設定 H 的時薪(IDOR)');
select throws_ok($$select public.list_staff_wages('f1035c00-0000-4000-8000-000000000020')$$, '42501', null, 'P02 別家店主不能列 W 店的工資');
select throws_ok($$select public.get_staff_wage_by_range('f1035c00-0000-4000-8000-000000000040', '2026-03-01', '2026-03-31')$$, '42501', null, 'P03 別家店主不能看 H 的工資');
select throws_ok($$select public.recompute_staff_work_day('f1035c00-0000-4000-8000-000000000040', '2026-03-02')$$, '42501', null, 'P04 別家店主不能重算 H 的上工紀錄');
select throws_ok($$select public.get_staff_wage_by_range('f1035c00-0000-4000-8000-0000000000ff', '2026-03-01', '2026-03-31')$$, '42501',
  '沒有權限查詢這間商家的服務人員報表。', 'L2 查不存在的服務人員也回 42501(跟沒有權限同一句,不透露 id 存不存在)');
reset role;

select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
select throws_ok($$select public.set_staff_wage('f1035c00-0000-4000-8000-000000000042', 100)$$, '22023',
  '只有日薪制或時薪制的服務人員可以設定日薪／時薪金額。', 'P01 抽成制不能設定工資');
select throws_ok($$select public.set_staff_wage('f1035c00-0000-4000-8000-000000000040', 12.345)$$, '22023',
  '金額最多只能到小數點後 2 位。', 'P01 金額超過 2 位小數被擋');
select throws_ok($$select public.set_staff_wage('f1035c00-0000-4000-8000-000000000040', 1000001)$$, '22023',
  '金額要在 0 到 1,000,000 元之間。', 'P01 金額超過上限被擋');
select is((public.set_staff_wage('f1035c00-0000-4000-8000-000000000040', 250) ->> 'wage_amount')::numeric, 250::numeric, 'P01 店主設定時薪 250');
select is(
  (select string_agg(e ->> 'name' || ':' || (e ->> 'wage_amount'), ',' order by e ->> 'staff_id' desc)
   from jsonb_array_elements(public.list_staff_wages('f1035c00-0000-4000-8000-000000000020')) e),
  '日薪D:1500.00,時薪H:250.00', 'P02 列出在職的日薪／時薪人員與金額'
);
select throws_ok($$select public.recompute_staff_work_day('f1035c00-0000-4000-8000-000000000040', (now() at time zone 'Asia/Taipei')::date)$$, '22023',
  '只能重新計算今天以前的日子。', 'P04 今天 / 未來不能手動重算');
select is((public.recompute_staff_work_day('f1035c00-0000-4000-8000-000000000041', '2026-03-02') ->> 'pay_amount')::numeric, 1500::numeric,
  'P04 店主手動重算過去某天');
reset role;
select is(
  (select refrozen_reason from staff_work_day_records where staff_id = 'f1035c00-0000-4000-8000-000000000041' and work_date = '2026-03-02'),
  'manual_job', 'P04 手動重算寫 refrozen_reason = manual_job'
);
select ok(
  (select bool_and(not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p where p.pronamespace = 'private'::regnamespace
     and p.proname in ('wage_today', 'wage_time_minutes', 'wage_multirange_minutes', 'staff_has_wage_history', 'compute_work_day',
                       'wage_day_row', 'refreeze_work_day', 'freeze_work_days', 'wage_dates_of_span', 'compute_staff_wage_by_range',
                       'tg_staff_availability_overrides_refreeze_work_day', 'tg_staff_leave_records_refreeze_work_day',
                       'tg_bookings_refreeze_work_day', 'tg_booking_assistants_refreeze_work_day',
                       'staff_wage_settings_sync_payroll_status_history')),
  'PX-01 新的 private 函式 anon / authenticated 都不能執行'
);
select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                   and p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""')
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('set_staff_wage', 'list_staff_wages', 'get_staff_wage_by_range', 'recompute_staff_work_day'))
  and (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('set_staff_wage', 'list_staff_wages', 'get_staff_wage_by_range', 'recompute_staff_work_day')) = 4,
  'PX-01 4 支對外函式:只有 authenticated 能執行、SECURITY DEFINER、search_path 空'
);

-- 請假:月薪、日薪、時薪可以;抽成制擋
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
select lives_ok($$select public.create_staff_leave('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000060', '2036-05-01', '2036-05-01')$$,
  'U03 時薪制可以登記請假');
select lives_ok($$select public.create_staff_leave('f1035c00-0000-4000-8000-000000000041', 'f1035c00-0000-4000-8000-000000000060', '2036-05-01', '2036-05-01')$$,
  'U03 日薪制可以登記請假');
select lives_ok($$select public.create_staff_leave('f1035c00-0000-4000-8000-000000000043', 'f1035c00-0000-4000-8000-000000000060', '2036-05-01', '2036-05-01')$$,
  'U03 月薪制照舊可以登記請假');
select throws_ok($$select public.create_staff_leave('f1035c00-0000-4000-8000-000000000042', 'f1035c00-0000-4000-8000-000000000060', '2036-05-01', '2036-05-01')$$,
  'P0001', '只有月薪制、日薪制、時薪制的服務人員可以登記請假紀錄，請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)',
  'U03 抽成制照舊擋下');
reset role;

-- 自己開關時段(Q4 = A):時薪 H 有權限也不行;抽成 PR2 有權限可以
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000003');
select is(private.can_self_manage_availability('f1035c00-0000-4000-8000-000000000040'), false,
  'U04 時薪制即使有「可預約時段/休假自助調整」權限也不能自己開關時段');
reset role;
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000004');
select is(private.can_self_manage_availability('f1035c00-0000-4000-8000-000000000044'), true,
  'U04 對照:抽成制有權限可以');
reset role;

-- 還原預覽:日薪的單完成後沒有抽成 ⇒ 走「沒有抽成可撤銷」
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, completed_at) values
  ('f1035c00-0000-4000-8000-000000000074', 'f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000041',
   '2026-03-09 09:00+08', '2026-03-09 10:00+08', '王', '0955103600', 'admin', 'completed', '2026-03-09 10:00+08');
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
select is(
  (select concat_ws('/', r -> 'commission' ->> 'exists', r -> 'staff' ->> 'compensation_type_now',
                    (select count(*) from jsonb_array_elements(r -> 'warnings') w where w ->> 'code' = 'staff_now_monthly'))
   from (select public.get_completed_booking_reversal_preview('f1035c00-0000-4000-8000-000000000074') r) x),
  'false/daily_wage/0', 'U05 日薪制的單:沒有抽成可撤銷、不出現「改成月薪制」警告'
);
reset role;

select * from finish();
rollback;
