-- 模組 8:薪資與帳務 — 報表查詢函式(第五支)。
-- 對應規格書 §3.9/§3.10/§3.11、規則 2.8。
--
-- private.compute_staff_payroll:§3.10 的核心計算邏輯抽成一支不做權限檢查的內部函式,
-- 讓 get_staff_monthly_payroll_summary(3.10)跟 get_merchant_billing_summary(3.11)都能直接複用,
-- 不透過 RPC 呼叫 RPC、不重複做權限檢查(規格書 §3.11 第 5 點明講的做法)。

-- =========================================================================
-- 規則 2.8:月薪報表請假天數計算。查詢邏輯抽成 private.compute_staff_payroll,不對外暴露。
-- 讀取的是 leave_type_id(關聯到目前的扣款規則),不是 leave_type_name_snapshot——扣款規則是
-- 即時計算(判斷 7),套用假別「目前」的扣款規則,不是請假當下的規則快照。leave_type_name
-- 顯示則用假別「目前」名稱(get_staff_monthly_payroll_summary 3.10 明講),這跟模組 7 請假紀錄
-- 本身「名稱」用快照的原則刻意不同,兩者互不衝突。
-- =========================================================================
create or replace function private.compute_staff_payroll(
  p_staff_id uuid,
  p_year int,
  p_month int
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_month_start date;
  v_month_end date;
  v_pay_days int;
  v_base_salary numeric(10, 2);
  v_quota_days numeric(4, 1);
  v_details jsonb := '[]'::jsonb;
  v_total_deduction numeric(10, 2) := 0;
  v_total_leave_days numeric(6, 1) := 0;
  rec record;
  v_day_rate numeric(14, 4);
  v_deduction numeric(10, 2);
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;

  -- 1. 查 staff_salary_settings,查無資料視為 monthly_base_salary=0。
  select monthly_base_salary, monthly_leave_quota_days
  into v_base_salary, v_quota_days
  from public.staff_salary_settings
  where staff_id = p_staff_id;

  if not found then
    v_base_salary := 0;
    v_quota_days := null;
  end if;

  select pay_days_per_month into v_pay_days
  from public.merchant_payroll_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_pay_days := 30;
  end if;

  v_day_rate := case when v_pay_days > 0 then v_base_salary / v_pay_days else 0 end;

  -- 2. 規則 2.8:依假別分組,計算該年月的重疊天數(跨月只算重疊部分,同假別同月多筆加總)。
  for rec in
    select
      mlt.id as leave_type_id,
      mlt.name as leave_type_name,
      coalesce(ldr.deduction_mode, 'no_deduction') as deduction_mode,
      ldr.percentage_value,
      ldr.fixed_amount_value,
      sum(
        greatest(
          (least(slr.end_date, v_month_end) - greatest(slr.start_date, v_month_start) + 1),
          0
        )
      ) as overlap_days
    from public.staff_leave_records slr
    join public.merchant_leave_types mlt on mlt.id = slr.leave_type_id
    left join public.leave_type_deduction_rules ldr on ldr.leave_type_id = slr.leave_type_id
    where slr.staff_id = p_staff_id
      and slr.status = 'confirmed'
      and slr.start_date <= v_month_end
      and slr.end_date >= v_month_start
    group by mlt.id, mlt.name, ldr.deduction_mode, ldr.percentage_value, ldr.fixed_amount_value
  loop
    if rec.overlap_days <= 0 then
      continue;
    end if;

    v_deduction := case rec.deduction_mode
      when 'no_deduction' then 0
      when 'full_day_rate' then round(v_day_rate * rec.overlap_days, 2)
      when 'percentage_of_day_rate' then
        round(v_day_rate * coalesce(rec.percentage_value, 0) / 100 * rec.overlap_days, 2)
      when 'fixed_amount_per_day' then round(coalesce(rec.fixed_amount_value, 0) * rec.overlap_days, 2)
      else 0
    end;

    v_details := v_details || jsonb_build_object(
      'leave_type_id', rec.leave_type_id,
      'leave_type_name', rec.leave_type_name,
      'days', rec.overlap_days,
      'deduction_mode', rec.deduction_mode,
      'deduction_amount', v_deduction
    );

    v_total_deduction := v_total_deduction + v_deduction;
    v_total_leave_days := v_total_leave_days + rec.overlap_days;
  end loop;

  -- 3. net_pay 不會是負數,超過月薪基本額時額外標記異常旗標(不是靜默把負數藏起來)。
  return jsonb_build_object(
    'monthly_base_salary', v_base_salary,
    'details', v_details,
    'total_deduction_amount', v_total_deduction,
    'net_pay', greatest(v_base_salary - v_total_deduction, 0),
    'over_deduction_warning', v_total_deduction > v_base_salary,
    'monthly_leave_quota_days', v_quota_days,
    'total_leave_days', v_total_leave_days
  );
end;
$$;

comment on function private.compute_staff_payroll(uuid, int, int) is '模組 8 §3.10 核心計算邏輯(規則 2.8):某位月薪制服務人員在某年月的請假扣款明細與淨額。不做權限檢查(呼叫端 get_staff_monthly_payroll_summary/get_merchant_billing_summary 各自負責檢查),避免重複實作/重複查詢。net_pay 用 greatest(...,0) 確保不會是負數,over_deduction_warning 標記扣款金額是否已超過月薪基本額。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll(uuid, int, int) from public, anon;
grant execute on function private.compute_staff_payroll(uuid, int, int) to authenticated;

-- =========================================================================
-- 3.9:get_staff_commission_summary(p_staff_id uuid, p_year int, p_month int)。
-- 師傅報表用,按件計酬服務人員。回傳該年月完成訂單日期(bookings.start_at)落在該年月的所有
-- booking_commission_records 明細 + 總計 + 該月以助手身份參與的訂單筆數(規則 2.5 參考資訊)。
-- =========================================================================
create or replace function public.get_staff_commission_summary(
  p_staff_id uuid,
  p_year int,
  p_month int
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_month_start date;
  v_next_month_start date;
  v_details jsonb;
  v_total_orders int;
  v_total_amount numeric(10, 2);
  v_assistant_count int;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_view_payroll_reports(v_merchant_id) then
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_next_month_start := v_month_start + interval '1 month';

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'booking_id', b.id,
      'order_date', b.start_at,
      'customer_name', b.customer_name,
      'commission_base_amount', bcr.commission_base_amount_snapshot,
      'commission_rate_percentage', bcr.commission_rate_percentage_snapshot,
      'commission_amount', bcr.commission_amount,
      'recalculated', bcr.recalculated_at is not null
    ) order by b.start_at), '[]'::jsonb),
    count(*)::int,
    coalesce(sum(bcr.commission_amount), 0)
  into v_details, v_total_orders, v_total_amount
  from public.booking_commission_records bcr
  join public.bookings b on b.id = bcr.booking_id
  where bcr.staff_id = p_staff_id
    and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  select count(*)::int into v_assistant_count
  from public.booking_assistants ba
  join public.bookings b on b.id = ba.booking_id
  where ba.staff_id = p_staff_id
    and b.status = 'completed'
    and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  return jsonb_build_object(
    'details', v_details,
    'total_orders', v_total_orders,
    'total_commission_amount', v_total_amount,
    'assistant_booking_count', v_assistant_count
  );
end;
$$;

comment on function public.get_staff_commission_summary(uuid, int, int) is '模組 8 §3.9:師傅報表(按件計酬)用,回傳某服務人員某年月(依訂單 start_at 判斷月份)的抽成明細清單+總計,以及該月以助手身份參與的訂單筆數(規則 2.5,只給參考,不影響任何金額)。SECURITY DEFINER,檢查 private.can_view_payroll_reports。';

revoke execute on function public.get_staff_commission_summary(uuid, int, int) from public, anon;
grant execute on function public.get_staff_commission_summary(uuid, int, int) to authenticated;

-- =========================================================================
-- 3.10:get_staff_monthly_payroll_summary(p_staff_id uuid, p_year int, p_month int)。
-- 師傅報表用,月薪制服務人員。權限檢查後直接複用 private.compute_staff_payroll。
-- =========================================================================
create or replace function public.get_staff_monthly_payroll_summary(
  p_staff_id uuid,
  p_year int,
  p_month int
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_view_payroll_reports(v_merchant_id) then
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
  end if;

  return private.compute_staff_payroll(p_staff_id, p_year, p_month);
end;
$$;

comment on function public.get_staff_monthly_payroll_summary(uuid, int, int) is '模組 8 §3.10:師傅報表(月薪制)用,某位服務人員某年月的請假扣款明細與淨額(規則 2.8)。SECURITY DEFINER,檢查 private.can_view_payroll_reports 後直接複用 private.compute_staff_payroll。';

revoke execute on function public.get_staff_monthly_payroll_summary(uuid, int, int) from public, anon;
grant execute on function public.get_staff_monthly_payroll_summary(uuid, int, int) to authenticated;

-- =========================================================================
-- 3.11:get_merchant_billing_summary(p_merchant_id uuid, p_year int, p_month int)。
-- 店家端帳務報表用。per_staff_breakdown 的抽成金額/訂單筆數,跟 total_commission_payout 一樣
-- 用 booking_commission_records.computed_at 當月份基準(內部總計一致性考量,見主腦回報時附帶
-- 提出的待確認事項),不是用訂單日期——理由跟 total_commission_payout 相同(規格書 §3.11 第 3
-- 點:抽成算在實際完成的那個月,比較符合「這個月商家實際要付出去多少抽成」的帳務概念),
-- 這樣每位服務人員的抽成金額加總才會等於 total_commission_payout。order_count(該月訂單筆數)
-- 則統一用 bookings.start_at 落在該年月且 status=completed 判斷(不分計酬類型),是「這個月做了
-- 幾單」的業績量參考,跟金額基準是兩件事。
-- =========================================================================
create or replace function public.get_merchant_billing_summary(
  p_merchant_id uuid,
  p_year int,
  p_month int
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_month_start date;
  v_next_month_start date;
  v_total_revenue numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_total_salary_deduction numeric(10, 2) := 0;
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_next_month_start := v_month_start + interval '1 month';

  -- 1. total_revenue:含稅、商家實際收到的總金額,跟抽成基準刻意排除稅金的口徑不同。
  select coalesce(sum(b.final_amount_snapshot), 0)
  into v_total_revenue
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  -- 2. total_material_cost:該年月完成訂單的料錢成本加總。
  select coalesce(sum(bmc.amount_snapshot), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  -- 3. total_commission_payout:用 computed_at(抽成實際產生的月份),不是訂單日期。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and bcr.computed_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  -- 4. total_monthly_salary_base:所有 active 且 compensation_type=monthly_salary 的服務人員
  -- monthly_base_salary 加總。
  select coalesce(sum(sss.monthly_base_salary), 0)
  into v_total_salary_base
  from public.merchant_staff ms
  join public.staff_salary_settings sss on sss.staff_id = ms.id
  where ms.merchant_id = p_merchant_id
    and ms.status = 'active'
    and ms.compensation_type = 'monthly_salary';

  -- 5/7. 逐位 active 服務人員:月薪制複用 private.compute_staff_payroll 累加扣款總額,
  -- 按件計酬另外彙整 per_staff_breakdown 的抽成金額(用 computed_at 基準,見上方說明)。
  for rec in
    select ms.id, ms.name, ms.compensation_type
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id
      and ms.status = 'active'
    order by ms.name
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
      and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

    if rec.compensation_type = 'monthly_salary' then
      v_payroll := private.compute_staff_payroll(rec.id, p_year, p_month);
      v_total_salary_deduction := v_total_salary_deduction
        + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'net_pay', v_payroll -> 'net_pay',
        'commission_amount', null
      );
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
        and bcr.computed_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  -- 6. estimated_net_margin:概估毛利,不含房租/水電等其他營運成本,不是完整財務損益表。
  return jsonb_build_object(
    'total_revenue', v_total_revenue,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin',
      v_total_revenue - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction),
    'per_staff_breakdown', v_breakdown
  );
end;
$$;

comment on function public.get_merchant_billing_summary(uuid, int, int) is '模組 8 §3.11:店家端帳務報表,某商家某年月的營收/成本/抽成/薪資/概估毛利彙整。estimated_net_margin 明確只是概估毛利,不含房租水電等其他營運成本。SECURITY DEFINER,檢查 private.can_view_billing。';

revoke execute on function public.get_merchant_billing_summary(uuid, int, int) from public, anon;
grant execute on function public.get_merchant_billing_summary(uuid, int, int) to authenticated;
