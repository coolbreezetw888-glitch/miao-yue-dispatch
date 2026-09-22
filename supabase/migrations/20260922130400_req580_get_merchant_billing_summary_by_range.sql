-- 商家端三項調整規格書 §3.6:店家帳務報表時間篩選從單一年/月改成可選區間,最長一年。新增
-- get_merchant_billing_summary_by_range,不改掉原本 get_merchant_billing_summary(p_year, p_month)
-- 的簽章(§3.6:「新增一個接受日期區間的 overload,不是直接改掉原本的簽章」)。
--
-- ⚠️ 動工前已先用 pg_get_functiondef 直接讀取正式環境目前 get_merchant_billing_summary 的完整
-- 最新版本(商家端三項調整規格書 §3.1/§3.2 的 total_revenue_excl_tax/total_tax_amount/
-- estimated_net_margin 改版,已跟本機 migration 20260922111200 對齊,無漂移),在這個版本的基礎上
-- 疊加改寫,不是從舊版本重建。

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

  -- ⚠️ total_monthly_salary_base 維持「目前所有月薪制服務人員的月薪合計」這個固定 snapshot,
  -- 不因為查詢區間橫跨幾個月而乘上月數放大——沿用原本 get_merchant_billing_summary(單一年月版)
  -- 就已經存在的既有設計(那支函式的這個欄位本來就不依查詢的年月變動)。這是延續既有行為的判斷,
  -- 不是這次新裁決,但影響「商家總淨利」卡片在多月區間的數字解讀,請主腦回報時一併提出讓使用者
  -- 確認是否符合預期(如果使用者期待跨月查詢時這個數字也等比例放大,需要另外討論怎麼定義「橫跨
  -- 的月數」)。
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
    'per_staff_breakdown', v_breakdown
  );
end;
$function$;

comment on function public.get_merchant_billing_summary_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6:店家帳務報表區間版本,取代單一年月的 get_merchant_billing_summary(該函式簽章維持不變,供未來如需要單月查詢時繼續使用)。SECURITY DEFINER,檢查 private.can_view_billing,後端加上區間 > 366 天的例外保護。跨月薪資扣款透過 private.compute_staff_payroll_by_range 逐月分別用當月實際天數計算再加總。';

revoke execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) to authenticated;
