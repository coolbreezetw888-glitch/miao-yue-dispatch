-- 模組 14:服務人員端(功能層,第八支)。
-- 對應規格書 3.17:get_staff_commission_summary/get_staff_monthly_payroll_summary 疊加自助檢視
-- 分支(判斷 9)。簽章、回傳型別、既有邏輯完全不變,只改權限檢查那一行。
--
-- 動工前已用 execute_sql 查詢正式環境這兩支函式的完整最新版本,確認跟本機 migration 檔案一致。

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

  -- 模組 14 規格書 3.17:疊加服務人員自助檢視分支(規則 2.4 核心必測:傳入別人的 staff_id
  -- 即使自己有 staff_payroll_view 權限也會被 private.can_view_staff_own_payroll 擋下,
  -- 因為 private.is_own_staff_row(p_staff_id) 一定為 false)。
  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
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

comment on function public.get_staff_commission_summary(uuid, int, int) is '模組 8 §3.9/模組 14 §3.17:師傅報表(按件計酬)用,回傳某服務人員某年月(依訂單 start_at 判斷月份)的抽成明細清單+總計,以及該月以助手身份參與的訂單筆數(規則 2.5,只給參考,不影響任何金額)。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll(服務人員自助檢視,判斷 9)。';

revoke execute on function public.get_staff_commission_summary(uuid, int, int) from public, anon;
grant execute on function public.get_staff_commission_summary(uuid, int, int) to authenticated;

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

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
  end if;

  return private.compute_staff_payroll(p_staff_id, p_year, p_month);
end;
$$;

comment on function public.get_staff_monthly_payroll_summary(uuid, int, int) is '模組 8 §3.10/模組 14 §3.17:師傅報表(月薪制)用,某位服務人員某年月的請假扣款明細與淨額(規則 2.8)。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll(服務人員自助檢視,判斷 9)後直接複用 private.compute_staff_payroll。';

revoke execute on function public.get_staff_monthly_payroll_summary(uuid, int, int) from public, anon;
grant execute on function public.get_staff_monthly_payroll_summary(uuid, int, int) to authenticated;
