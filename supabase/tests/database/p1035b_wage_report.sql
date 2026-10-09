-- SPECS-INDEX #1035 彈性計薪 B 批(日薪／時薪制)— 店家報表(PB-B01)
-- migration 20261010170100_req1035b_wage_functions.sql
-- 規格書:母版 .project/specs/彈性計薪.md PB-B01、第七節 PT(B)。
--
--   B1 沒有日薪／時薪人員的店:total_wage_payout = 0、wage_feature_used = false、淨利 = 原算法(營收 − 料錢 − 抽成 − 月薪實發 − 獎金)、
--      月薪 / 抽成兩種明細列的鍵跟改版前完全一樣(沒有多出工資相關鍵)
--   B2 有的店:total_wage_payout = 每位(含區間內已移除的)PB-R04 合計;淨利 = 原算法 − 工資;
--      日薪／時薪列 net_pay / commission_amount / bonus_amount = null,另帶 wage_amount / worked_minutes / work_days
--   B3 不是完整月份:工資照算(按天),淨利照舊 null;區間含今天 ⇒ wage_includes_estimate = true
begin;

select plan(16);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

insert into auth.users (id, email) values
  ('f1035d00-0000-4000-8000-000000000001', 'pgtap-1035b-rpt-w@test.local'),
  ('f1035d00-0000-4000-8000-000000000002', 'pgtap-1035b-rpt-z@test.local');
insert into groups (id) values
  ('f1035d00-0000-4000-8000-000000000011'),
  ('f1035d00-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1035d00-0000-4000-8000-000000000020', 'f1035d00-0000-4000-8000-000000000011', '#1035B 報表店', 'on_site_dispatch'),
  ('f1035d00-0000-4000-8000-000000000021', 'f1035d00-0000-4000-8000-000000000012', '#1035B 沒工資店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f1035d00-0000-4000-8000-000000000020', 'f1035d00-0000-4000-8000-000000000001', 'W 店主'),
  ('f1035d00-0000-4000-8000-000000000021', 'f1035d00-0000-4000-8000-000000000002', 'Z 店主');
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '09:00', '18:00'
from unnest(array['f1035d00-0000-4000-8000-000000000020'::uuid, 'f1035d00-0000-4000-8000-000000000021'::uuid]) m,
     generate_series(0, 6) d;
insert into merchant_staff (id, merchant_id, name, compensation_type, status, phone) values
  ('f1035d00-0000-4000-8000-000000000040', 'f1035d00-0000-4000-8000-000000000020', '時薪H', 'hourly_wage', 'active', '0900103740'),
  ('f1035d00-0000-4000-8000-000000000041', 'f1035d00-0000-4000-8000-000000000020', '日薪X(月中離職)', 'daily_wage', 'active', '0900103741'),
  ('f1035d00-0000-4000-8000-000000000042', 'f1035d00-0000-4000-8000-000000000020', '月薪M', 'monthly_salary', 'active', '0900103742'),
  ('f1035d00-0000-4000-8000-000000000043', 'f1035d00-0000-4000-8000-000000000020', '抽成P', 'piece_rate', 'active', '0900103743'),
  ('f1035d00-0000-4000-8000-000000000044', 'f1035d00-0000-4000-8000-000000000021', '月薪ZM', 'monthly_salary', 'active', '0900103744'),
  ('f1035d00-0000-4000-8000-000000000045', 'f1035d00-0000-4000-8000-000000000021', '抽成ZP', 'piece_rate', 'active', '0900103745'),
  -- 主腦裁決 M1:改制S 3/10 以前是時薪制(180),3/10 起改成月薪制(月底是月薪 ⇒ 母體用月薪列出)
  ('f1035d00-0000-4000-8000-000000000046', 'f1035d00-0000-4000-8000-000000000020', '改制S', 'monthly_salary', 'active', '0900103746');
insert into staff_salary_settings (staff_id, monthly_base_salary) values
  ('f1035d00-0000-4000-8000-000000000042', 30000),
  ('f1035d00-0000-4000-8000-000000000044', 26000);
insert into staff_wage_settings (staff_id, merchant_id, wage_amount) values
  ('f1035d00-0000-4000-8000-000000000040', 'f1035d00-0000-4000-8000-000000000020', 180),
  ('f1035d00-0000-4000-8000-000000000041', 'f1035d00-0000-4000-8000-000000000020', 1200),
  ('f1035d00-0000-4000-8000-000000000046', 'f1035d00-0000-4000-8000-000000000020', 180);
-- 時段:H 每天 10:00~12:00(120 分);X 每天 09:00~10:00
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'f1035d00-0000-4000-8000-000000000040', d, '10:00', '12:00' from generate_series(0, 6) d;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'f1035d00-0000-4000-8000-000000000041', d, '09:00', '10:00' from generate_series(0, 6) d;
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'f1035d00-0000-4000-8000-000000000046', d, '10:00', '12:00' from generate_series(0, 6) d;

-- 歷史往前挪:全部人從 2025-01-01 起就是目前狀態;X 在 2026-03-15 00:00(台北)離職
delete from staff_payroll_status_history
where merchant_id in ('f1035d00-0000-4000-8000-000000000020', 'f1035d00-0000-4000-8000-000000000021') and effective_to is not null;
update staff_payroll_status_history set effective_from = '2025-01-01 00:00+08'
where merchant_id in ('f1035d00-0000-4000-8000-000000000020', 'f1035d00-0000-4000-8000-000000000021');
update staff_payroll_status_history set effective_to = '2026-03-15 00:00+08'
where staff_id = 'f1035d00-0000-4000-8000-000000000041';
insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary, effective_from, wage_amount)
values ('f1035d00-0000-4000-8000-000000000041', 'f1035d00-0000-4000-8000-000000000020', 'daily_wage', 'removed', 0, '2026-03-15 00:00+08', 1200);
-- merchant_staff.status 直接改(不觸發 sync 以外的流程;sync 看到值跟目前那列相同,不會再開新列)
update merchant_staff set status = 'removed' where id = 'f1035d00-0000-4000-8000-000000000041';
-- 改制S:2025-01-01 ~ 2026-03-10 時薪制、之後月薪制(目前那列)
update staff_payroll_status_history set effective_from = '2026-03-10 00:00+08'
where staff_id = 'f1035d00-0000-4000-8000-000000000046';
insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary, effective_from, effective_to, wage_amount)
values ('f1035d00-0000-4000-8000-000000000046', 'f1035d00-0000-4000-8000-000000000020', 'hourly_wage', 'active', 0,
        '2025-01-01 00:00+08', '2026-03-10 00:00+08', 180);

-- 兩家店各一張已完成的單(營收,讓淨利不是 0)
insert into bookings (merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status, completed_at,
                      subtotal_amount_snapshot, final_amount_snapshot) values
  ('f1035d00-0000-4000-8000-000000000020', 'f1035d00-0000-4000-8000-000000000043', '2026-03-10 13:00+08', '2026-03-10 14:00+08',
   '王', '0955103700', 'admin', 'completed', '2026-03-10 14:00+08', 50000, 50000),
  ('f1035d00-0000-4000-8000-000000000021', 'f1035d00-0000-4000-8000-000000000045', '2026-03-10 13:00+08', '2026-03-10 14:00+08',
   '王', '0955103700', 'admin', 'completed', '2026-03-10 14:00+08', 40000, 40000);

-- 預期值(直接算):H 3 月 31 天 × 120 分 × 180 / 60 = 31 × 360 = 11,160;X 3/1~3/14 共 14 天 × 1,200 = 16,800
create function pg_temp.formula_net(r jsonb) returns numeric language sql as $$
  select (r ->> 'total_revenue_excl_tax')::numeric - (r ->> 'total_material_cost')::numeric
       - (r ->> 'total_commission_payout')::numeric
       - ((r ->> 'total_monthly_salary_base')::numeric - (r ->> 'total_monthly_salary_deduction')::numeric)
       - (r ->> 'total_monthly_bonus')::numeric;
$$;

-- =========================================================================
-- B1 沒有日薪／時薪人員的店
-- =========================================================================
select pg_temp.test_set_auth('f1035d00-0000-4000-8000-000000000002');
create temp table rz on commit drop as
  select public.get_merchant_billing_summary_by_range('f1035d00-0000-4000-8000-000000000021', '2026-03-01', '2026-03-31') as r;
reset role;
select is(
  (select concat_ws('/', r ->> 'total_wage_payout', r ->> 'wage_feature_used', r ->> 'wage_includes_estimate') from rz),
  '0.00/false/false', 'B1 沒有日薪／時薪人員:工資 0、wage_feature_used = false、不含今天'
);
select is(
  (select (r ->> 'estimated_net_margin')::numeric = pg_temp.formula_net(r) from rz), true,
  'B1 淨利 = 原算法(沒有多減任何東西)'
);
select is(
  (select array_agg(distinct k order by k) from rz, jsonb_array_elements(r -> 'per_staff_breakdown') e, jsonb_object_keys(e) k),
  array['bonus_amount', 'commission_amount', 'compensation_type', 'is_active_as_of', 'net_pay', 'order_count', 'staff_id', 'staff_name'],
  'B1 月薪 / 抽成明細列的鍵跟改版前一樣(沒有工資相關鍵)'
);

-- =========================================================================
-- B2 有日薪／時薪人員的店(完整月份)
-- =========================================================================
select pg_temp.test_set_auth('f1035d00-0000-4000-8000-000000000001');
create temp table rw on commit drop as
  select public.get_merchant_billing_summary_by_range('f1035d00-0000-4000-8000-000000000020', '2026-03-01', '2026-03-31') as r;
create temp table rp on commit drop as
  select public.get_merchant_billing_summary_by_range('f1035d00-0000-4000-8000-000000000020', '2026-03-02', '2026-03-03') as r;
create temp table rt on commit drop as
  select public.get_merchant_billing_summary_by_range('f1035d00-0000-4000-8000-000000000020',
    (now() at time zone 'Asia/Taipei')::date - 1, (now() at time zone 'Asia/Taipei')::date) as r;
reset role;

select is((select (r ->> 'total_wage_payout')::numeric from rw), 31200::numeric,
  'B2 工資合計 = H 11,160 + 月中離職的 X 16,800(離職後的日子不算)+ 改制S 3/1~3/9 共 9 天 × 360 = 3,240');
select is((select (r ->> 'wage_feature_used')::boolean from rw), true, 'B2 wage_feature_used = true');
select is(
  (select (r ->> 'estimated_net_margin')::numeric = pg_temp.formula_net(r) - 31200 from rw), true,
  'B2 淨利 = 原算法 − 工資'
);
select is(
  (select concat_ws('/', e ->> 'compensation_type', coalesce(e ->> 'net_pay', 'null'), coalesce(e ->> 'commission_amount', 'null'),
                    coalesce(e ->> 'bonus_amount', 'null'), e ->> 'wage_amount', e ->> 'worked_minutes', e ->> 'work_days', e ->> 'wage_missing')
   from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e where e ->> 'staff_name' = '時薪H'),
  'hourly_wage/null/null/null/11160/3720/31/false',
  'B2 時薪列:沒有實發 / 抽成 / 獎金,帶工資、上工分鐘、上工天數'
);
select is(
  (select concat_ws('/', e ->> 'compensation_type', e ->> 'is_active_as_of', e ->> 'wage_amount', e ->> 'work_days')
   from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e where e ->> 'staff_name' like '日薪X%'),
  'daily_wage/false/16800/14',
  'M1 月底已離職的 X 另加一列(已離職),帶工資'
);
select is(
  (select concat_ws('/', e ->> 'compensation_type', (coalesce(e ->> 'net_pay', 'null') <> 'null')::text, e ->> 'wage_amount', e ->> 'work_days')
   from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e where e ->> 'staff_name' = '改制S'),
  'monthly_salary/true/3240/9',
  'M1 中途改制的 S 維持一列(月薪列),同一列多帶這段區間的工資'
);
select is(
  (select sum((e ->> 'wage_amount')::numeric) from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e),
  (select (r ->> 'total_wage_payout')::numeric from rw),
  'M1 明細工資加總 = 日薪／時薪支出合計'
);
select is(
  (select count(*) from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e)::int,
  (select count(distinct e ->> 'staff_id') from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e)::int,
  'M1 明細裡 staff_id 不重複'
);
select is(
  (select array_agg(distinct k order by k) from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e, jsonb_object_keys(e) k
   where e ->> 'compensation_type' in ('monthly_salary', 'piece_rate') and e ->> 'staff_name' <> '改制S'),
  array['bonus_amount', 'commission_amount', 'compensation_type', 'is_active_as_of', 'net_pay', 'order_count', 'staff_id', 'staff_name'],
  'B2 同一店的月薪 / 抽成列輸出不變'
);
select is(
  (select (e ->> 'commission_amount')::numeric from rw, jsonb_array_elements(r -> 'per_staff_breakdown') e where e ->> 'staff_name' = '抽成P'),
  0::numeric, 'B2 抽成列照舊走抽成分支'
);

-- =========================================================================
-- B3 不是完整月份 / 含今天
-- =========================================================================
select is(
  (select concat_ws('/', r ->> 'total_wage_payout', coalesce(r ->> 'estimated_net_margin', 'null'), r ->> 'salary_applicable') from rp),
  '3840.00/null/false', 'B3 不是完整月份:工資照算(H 2 天 720 + X 2 天 2,400 + S 2 天 720),淨利照舊 null'
);
select is((select (r ->> 'wage_includes_estimate')::boolean from rt), true, 'B3 區間含今天 ⇒ wage_includes_estimate = true');
select is(
  (select (r ->> 'total_wage_payout')::numeric from rt),
  (select (private.compute_staff_wage_by_range('f1035d00-0000-4000-8000-000000000040',
     (now() at time zone 'Asia/Taipei')::date - 1, (now() at time zone 'Asia/Taipei')::date) ->> 'total_pay')::numeric),
  'B3 含今天:合計 = H 昨天(未結算即時算)+ 今天(預估)'
);

select * from finish();
rollback;
