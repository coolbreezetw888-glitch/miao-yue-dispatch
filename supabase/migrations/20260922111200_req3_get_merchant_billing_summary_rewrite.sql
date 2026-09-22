-- 商家端三項調整規格書 §三 3.1/3.2:total_revenue(含稅單一數字)拆成 total_revenue_excl_tax +
-- total_tax_amount;estimated_net_margin 改用未稅營收計算(原本誤用含稅營收,虛增淨利)。

create or replace function public.get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_month_start date;
  v_next_month_start date;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
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

  select coalesce(sum(sss.monthly_base_salary), 0)
  into v_total_salary_base
  from public.merchant_staff ms
  join public.staff_salary_settings sss on sss.staff_id = ms.id
  where ms.merchant_id = p_merchant_id
    and ms.status = 'active'
    and ms.compensation_type = 'monthly_salary';

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
    'per_staff_breakdown', v_breakdown
  );
end;
$function$;
