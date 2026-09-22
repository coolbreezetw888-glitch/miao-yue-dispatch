-- 模組 8(薪資與帳務)規格書 §十 10.1:private.compute_staff_payroll 疊加——day_rate 的分母
-- (「月折算天數」)改成呼叫 private.get_days_in_month(p_year, p_month)動態計算,不再讀取
-- merchant_payroll_settings.pay_days_per_month。這裡的「年月」是這筆薪資報表/扣款計算實際查詢
-- 的年月(呼叫端傳入的 p_year/p_month),不是查詢當下的系統時間。
--
-- ⚠️ 動工前已先讀取正式環境目前這支函式的完整最新版本(跟本機 migration
-- 20260920120400_payroll_reports.sql 的版本完全一致,無漂移),在這個版本的基礎上疊加,公式結構
-- (day_rate = 月薪 / 月折算天數)本身不變,只改「月折算天數」的來源。

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

  -- ⚠️ §十 10.1 調整:「月折算天數」改成依這筆計算實際查詢的年月動態算出,不再讀取
  -- merchant_payroll_settings.pay_days_per_month(該欄位已移除)。
  v_pay_days := private.get_days_in_month(p_year, p_month);

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

comment on function private.compute_staff_payroll(uuid, int, int) is '模組 8 §3.10 核心計算邏輯(規則 2.8):某位月薪制服務人員在某年月的請假扣款明細與淨額。不做權限檢查(呼叫端 get_staff_monthly_payroll_summary/get_merchant_billing_summary 各自負責檢查),避免重複實作/重複查詢。net_pay 用 greatest(...,0) 確保不會是負數,over_deduction_warning 標記扣款金額是否已超過月薪基本額。⚠️ 已於 2026-09-22 調整(§十 10.1):day_rate 的分母(月折算天數)改成呼叫 private.get_days_in_month(p_year, p_month)動態算出,不再讀取 merchant_payroll_settings.pay_days_per_month(欄位已移除)。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll(uuid, int, int) from public, anon;
grant execute on function private.compute_staff_payroll(uuid, int, int) to authenticated;
