-- 模組 8(薪資與帳務)規格書 §十一 11.8(SPECS-INDEX #629,核心,直接對應 #607 當初標註的待確認
-- 事項):get_merchant_billing_summary / get_merchant_billing_summary_by_range 的「月薪基本額
-- 合計」改用歷史資料(11.6)逐月加總,不是用目前所有月薪制在職人員的月薪反推估算。
--
-- ⚠️ 動工前已用 pg_get_functiondef 直接查證正式環境(wjtbmmnakcriuaqoknsq)目前這兩支函式的完整
-- 最新版本,結果分別跟本機 migration 20260922111200(get_merchant_billing_summary)/20260922130400
-- (get_merchant_billing_summary_by_range)完全一致,無漂移,在這個版本的基礎上疊加,簽章/回傳形狀
-- (除新增 salary_estimation_applied 欄位外)完全不變。
--
-- per_staff_breakdown 這個陣列維持現況,不逐月還原歷史人員名單(11.9,決策記錄,不在這支
-- migration 異動範圍內)。get_staff_monthly_payroll_summary/_by_range(呼叫 compute_staff_payroll/
-- _by_range 的 RPC 包裝)不需要修改——它們只是把 11.7 改寫後的 jsonb 原封不動回傳。
-- get_staff_commission_summary/_by_range(按件計酬)完全不受影響。

-- =========================================================================
-- 1. get_merchant_billing_summary(p_merchant_id uuid, p_year int, p_month int):單一年月版本。
-- total_monthly_salary_base 改呼叫 private.get_merchant_monthly_salary_base_as_of(11.6),
-- p_as_of = 該年月最後一天結束前的那一刻(Asia/Taipei)。單月查詢不需要逐月迴圈,直接呼叫一次。
-- =========================================================================
create or replace function public.get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_month_start date;
  v_next_month_start date;
  v_as_of timestamptz;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
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
  -- 該年月最後一天結束前的那一刻(Asia/Taipei),比照 11.7 compute_staff_payroll 的邊界寫法。
  v_as_of := (v_next_month_start::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond';

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  select coalesce(sum(bmc.amount_snapshot), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and b.start_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and b.start_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= (v_month_start::timestamp at time zone 'Asia/Taipei')
    and bcr.computed_at < (v_next_month_start::timestamp at time zone 'Asia/Taipei');

  -- §11.8:total_monthly_salary_base 改呼叫 private.get_merchant_monthly_salary_base_as_of
  -- (11.6),取代原本「目前所有月薪制在職人員的月薪合計」這個固定 snapshot。
  select total_amount, is_estimated
  into v_total_salary_base, v_salary_estimated
  from private.get_merchant_monthly_salary_base_as_of(p_merchant_id, v_as_of);

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

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin',
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction),
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated
  );
end;
$function$;

comment on function public.get_merchant_billing_summary(uuid, int, int) is '模組 8 §3.11 + §11.8:店家端帳務報表,某商家某年月的營收/成本/抽成/薪資/概估毛利彙整。total_monthly_salary_base 改呼叫 private.get_merchant_monthly_salary_base_as_of(11.6),p_as_of=該年月最後一天結束前的那一刻,不再是「目前所有月薪制在職人員的月薪合計」這個固定 snapshot。回傳新增 salary_estimation_applied(查詢區間涵蓋機制上線前的月份時為 true)。estimated_net_margin 明確只是概估毛利,不含房租水電等其他營運成本。SECURITY DEFINER,檢查 private.can_view_billing。';

revoke execute on function public.get_merchant_billing_summary(uuid, int, int) from public, anon;
grant execute on function public.get_merchant_billing_summary(uuid, int, int) to authenticated;

-- =========================================================================
-- 2. get_merchant_billing_summary_by_range(p_merchant_id, p_start_date, p_end_date):
-- total_monthly_salary_base 改成「逐月呼叫 11.6 再加總」,取代原本「目前所有月薪制在職人員的月薪
-- 合計」這個固定 snapshot(這是這支函式行為的實質改變)。
-- =========================================================================
create or replace function public.get_merchant_billing_summary_by_range(
  p_merchant_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path to 'public'
as $function$
declare
  v_range_start timestamp;
  v_range_end timestamp;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
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

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC
  -- 查詢過大區間造成效能問題或撈出超出預期範圍的資料。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and b.start_at >= v_range_start
    and b.start_at < v_range_end;

  select coalesce(sum(bmc.amount_snapshot), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and b.start_at >= v_range_start
    and b.start_at < v_range_end;

  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8(核心):比照 11.7 的「逐月迴圈」邏輯,對區間內每個月份呼叫 11.6(p_as_of=該月最後一天,
  -- least(...,p_end_date)),把每個月份的加總結果再加總,才是最終的 total_monthly_salary_base——
  -- 這是這支函式行為的實質改變,從「單一快照」變成「逐月加總」,直接回應 #607/#580 當初標註的
  -- 待確認事項。只要任一月份任一人用到估算,salary_estimation_applied 就是 true。
  select
    coalesce(sum(gm.total_amount), 0),
    coalesce(bool_or(gm.is_estimated), false)
  into v_total_salary_base, v_salary_estimated
  from generate_series(
    date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
  ) as m(month_start)
  cross join lateral private.get_merchant_monthly_salary_base_as_of(
    p_merchant_id,
    ((least((m.month_start + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
      at time zone 'Asia/Taipei') - interval '1 microsecond'
  ) as gm;

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
      and b.start_at >= v_range_start
      and b.start_at < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      -- §3.6:跨月時依區間內實際涵蓋的每個月份分別計算「當月實際天數」再加總,不是整個區間套用
      -- 同一個天數去算——private.compute_staff_payroll_by_range 內部已經處理這個邏輯。
      v_payroll := private.compute_staff_payroll_by_range(rec.id, p_start_date, p_end_date);
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
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

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

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin',
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction),
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated
  );
end;
$function$;

comment on function public.get_merchant_billing_summary_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6 + 模組 8 §11.8(核心):店家帳務報表區間版本,取代單一年月的 get_merchant_billing_summary(該函式簽章維持不變,供未來如需要單月查詢時繼續使用)。total_monthly_salary_base 改成逐月呼叫 private.get_merchant_monthly_salary_base_as_of(11.6)再加總,取代原本「目前所有月薪制在職人員的月薪合計」這個固定 snapshot——直接回應 #607 當初標註的待確認事項。回傳新增 salary_estimation_applied(只要任一月份任一人用到估算就是 true)。SECURITY DEFINER,檢查 private.can_view_billing,後端加上區間 > 366 天的例外保護。跨月薪資扣款透過 private.compute_staff_payroll_by_range 逐月分別用當月實際天數計算再加總。per_staff_breakdown 維持現況,不逐月還原歷史人員名單(11.9,決策記錄)。';

revoke execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) to authenticated;
