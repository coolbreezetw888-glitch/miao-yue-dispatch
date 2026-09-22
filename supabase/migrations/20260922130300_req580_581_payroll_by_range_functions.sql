-- 商家端三項調整規格書 §3.6(店家帳務報表)+ 服務人員端規格書 §15.2(個人薪資報表比照辦理)。
-- 時間篩選從單一年/月改成可選區間,最長一年,後端查詢加上區間上限保護(超過一年直接擋下,不只
-- 靠前端擋)。這支 migration 新增三支函式,全部用「新增 _by_range overload,不改掉原本按年月
-- 查詢的簽章」的做法(§3.6 建議做法),避免影響其他還在用原本簽章的呼叫端(商家管理員視角的
-- StaffReportPage.tsx 這次明確不在範圍內,繼續用原本的年/月函式,見服務人員端規格書 §15.2 第 4 點)。
--
-- ⚠️ 動工前已先讀取正式環境目前 get_staff_monthly_payroll_summary/get_staff_commission_summary/
-- get_merchant_billing_summary 的完整最新版本(用 pg_get_functiondef 直接查正式環境,不是只看本機
-- migration 檔案,避免本機檔案跟正式環境有漂移风险),在這個版本的基礎上疊加/新增。

-- =========================================================================
-- 1. private.compute_staff_payroll_by_range:比照 private.compute_staff_payroll(規則 2.7/2.8),
-- 但接受任意日期區間。跨月時,依區間內實際涵蓋的每個月份分別計算「當月實際天數」(呼叫
-- private.get_days_in_month)再加總,不是整個區間套用同一個天數去算(§3.6 明確要求)。
--
-- ⚠️ 財務判斷(建議主腦跟使用者確認,已直接裁決但不是唯一合理答案):monthly_base_salary/
-- monthly_leave_quota_days 這兩個欄位維持「單月快照值」,不因為查詢區間跨越多個月份就乘上月數
-- 放大——這是延續 get_merchant_billing_summary 原本 total_monthly_salary_base 的既有設計精神
-- (那支函式的 total_monthly_salary_base 本來就不是依查詢的月份計算,而是「目前所有月薪制服務
-- 人員的月薪合計」這個固定snapshot,不因為查詢單一月還是一整年而改變)。只有 total_deduction_amount/
-- total_leave_days/net_pay 這三個數字會真的隨查詢區間長度而變動(因為它們是「這段期間實際請了
-- 多少假、扣多少錢」)。如果使用者期待「查一整年,月薪基本額應該顯示一整年 12 個月的加總」,
-- 這裡需要改成乘上區間內涵蓋的月份數,屬於認知落差,請主腦提出讓使用者確認。
-- =========================================================================
create or replace function private.compute_staff_payroll_by_range(
  p_staff_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_base_salary numeric(10, 2);
  v_quota_days numeric(4, 1);
  v_details jsonb := '[]'::jsonb;
  v_total_deduction numeric(10, 2) := 0;
  v_total_leave_days numeric(6, 1) := 0;
  rec record;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  select monthly_base_salary, monthly_leave_quota_days
  into v_base_salary, v_quota_days
  from public.staff_salary_settings
  where staff_id = p_staff_id;

  if not found then
    v_base_salary := 0;
    v_quota_days := null;
  end if;

  -- 逐月份 × 逐假別計算重疊天數與扣款,day_rate 依各月實際天數分別計算(不是整個區間套用同一個
  -- 天數),再依 leave_type 加總成單一份明細,回傳形狀跟 private.compute_staff_payroll 一致。
  for rec in
    with months as (
      select gs::date as month_start
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    month_bounds as (
      select
        m.month_start,
        (m.month_start + interval '1 month - 1 day')::date as month_end,
        greatest(m.month_start, p_start_date) as clip_start,
        least((m.month_start + interval '1 month - 1 day')::date, p_end_date) as clip_end,
        private.get_days_in_month(
          extract(year from m.month_start)::int, extract(month from m.month_start)::int
        ) as pay_days
      from months m
    ),
    per_month_leave as (
      select
        mlt.id as leave_type_id,
        mlt.name as leave_type_name,
        coalesce(ldr.deduction_mode, 'no_deduction') as deduction_mode,
        ldr.percentage_value,
        ldr.fixed_amount_value,
        greatest(
          (least(slr.end_date, mb.clip_end) - greatest(slr.start_date, mb.clip_start) + 1), 0
        ) as overlap_days,
        case when mb.pay_days > 0 then v_base_salary / mb.pay_days else 0 end as day_rate
      from month_bounds mb
      join public.staff_leave_records slr
        on slr.staff_id = p_staff_id
        and slr.status = 'confirmed'
        and slr.start_date <= mb.clip_end
        and slr.end_date >= mb.clip_start
      join public.merchant_leave_types mlt on mlt.id = slr.leave_type_id
      left join public.leave_type_deduction_rules ldr on ldr.leave_type_id = slr.leave_type_id
    ),
    per_row_deduction as (
      select
        leave_type_id, leave_type_name, deduction_mode, overlap_days,
        case deduction_mode
          when 'no_deduction' then 0
          when 'full_day_rate' then round(day_rate * overlap_days, 2)
          when 'percentage_of_day_rate' then round(day_rate * coalesce(percentage_value, 0) / 100 * overlap_days, 2)
          when 'fixed_amount_per_day' then round(coalesce(fixed_amount_value, 0) * overlap_days, 2)
          else 0
        end as deduction_amount
      from per_month_leave
      where overlap_days > 0
    )
    select
      leave_type_id, leave_type_name, deduction_mode,
      sum(overlap_days) as days,
      sum(deduction_amount) as deduction_amount
    from per_row_deduction
    group by leave_type_id, leave_type_name, deduction_mode
  loop
    v_details := v_details || jsonb_build_object(
      'leave_type_id', rec.leave_type_id,
      'leave_type_name', rec.leave_type_name,
      'days', rec.days,
      'deduction_mode', rec.deduction_mode,
      'deduction_amount', rec.deduction_amount
    );

    v_total_deduction := v_total_deduction + rec.deduction_amount;
    v_total_leave_days := v_total_leave_days + rec.days;
  end loop;

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

comment on function private.compute_staff_payroll_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:比照 private.compute_staff_payroll,但接受任意日期區間。跨月時逐月份分別用 private.get_days_in_month 算 day_rate 再加總(不是整區間套用同一天數)。⚠️ monthly_base_salary/monthly_leave_quota_days 維持單月快照值,不因區間跨月而放大,詳見函式上方註解的待確認事項。後端已加上區間 > 366 天的例外保護。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll_by_range(uuid, date, date) from public, anon;
grant execute on function private.compute_staff_payroll_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- 2. get_staff_monthly_payroll_summary_by_range:師傅報表/服務人員自助薪資報表(月薪制)用的
-- 區間版本。權限檢查跟原本的 get_staff_monthly_payroll_summary 完全一致(管理員/被授權客服/
-- 本人皆可)。
-- =========================================================================
create or replace function public.get_staff_monthly_payroll_summary_by_range(
  p_staff_id uuid,
  p_start_date date,
  p_end_date date
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

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
  end if;

  return private.compute_staff_payroll_by_range(p_staff_id, p_start_date, p_end_date);
end;
$$;

comment on function public.get_staff_monthly_payroll_summary_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:師傅報表(月薪制)區間版本,取代單一年月的 get_staff_monthly_payroll_summary,不改掉原本簽章(那支繼續給商家管理員視角 StaffReportPage.tsx 使用,這支目前只給服務人員自助頁面 MyPayrollPage.tsx 使用)。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll。';

revoke execute on function public.get_staff_monthly_payroll_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_staff_monthly_payroll_summary_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- 3. get_staff_commission_summary_by_range:師傅報表/服務人員自助薪資報表(按件計酬)用的區間
-- 版本,邏輯比照 get_staff_commission_summary,只是把 where b.start_at 落在單一年月的條件改成
-- 落在 [p_start_date, p_end_date] 區間(含 p_end_date 整天)。
-- =========================================================================
create or replace function public.get_staff_commission_summary_by_range(
  p_staff_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_details jsonb;
  v_total_orders int;
  v_total_amount numeric(10, 2);
  v_gross_amount numeric(10, 2);
  v_assistant_count int;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'booking_id', b.id,
      'order_date', b.start_at,
      'customer_name', b.customer_name,
      'commission_base_amount', bcr.commission_base_amount_snapshot,
      'commission_amount', bcr.commission_amount,
      'recalculated', bcr.recalculated_at is not null,
      'legacy_rate_percentage', bcr.commission_rate_percentage_snapshot,
      'item_breakdown', coalesce((
        select jsonb_agg(jsonb_build_object(
          'service_item_name', bcir.service_item_name_snapshot,
          'quantity', bcir.quantity_snapshot,
          'commission_mode', bcir.commission_mode_snapshot,
          'commission_value', bcir.commission_value_snapshot,
          'commission_amount', bcir.commission_amount
        ) order by bcir.created_at)
        from public.booking_commission_item_records bcir
        where bcir.commission_record_id = bcr.id
      ), '[]'::jsonb)
    ) order by b.start_at), '[]'::jsonb),
    count(*)::int,
    coalesce(sum(bcr.commission_amount), 0),
    coalesce(sum(b.final_amount_snapshot), 0)
  into v_details, v_total_orders, v_total_amount, v_gross_amount
  from public.booking_commission_records bcr
  join public.bookings b on b.id = bcr.booking_id
  where bcr.staff_id = p_staff_id
    and b.start_at >= v_range_start
    and b.start_at < v_range_end;

  select count(*)::int into v_assistant_count
  from public.booking_assistants ba
  join public.bookings b on b.id = ba.booking_id
  where ba.staff_id = p_staff_id
    and b.status = 'completed'
    and b.start_at >= v_range_start
    and b.start_at < v_range_end;

  return jsonb_build_object(
    'details', v_details,
    'total_orders', v_total_orders,
    'total_commission_amount', v_total_amount,
    'assistant_booking_count', v_assistant_count,
    'total_amount', v_gross_amount
  );
end;
$$;

comment on function public.get_staff_commission_summary_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:師傅報表(按件計酬)區間版本,取代單一年月的 get_staff_commission_summary,不改掉原本簽章。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll,後端加上區間 > 366 天的例外保護。';

revoke execute on function public.get_staff_commission_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_staff_commission_summary_by_range(uuid, date, date) to authenticated;
