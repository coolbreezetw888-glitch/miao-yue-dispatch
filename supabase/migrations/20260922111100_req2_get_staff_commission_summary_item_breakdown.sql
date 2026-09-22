-- 商家端三項調整規格書 §二 2.7.5:師傅報表用,補上逐項明細 item_breakdown,拿掉單一比例欄位
-- commission_rate_percentage(改用 item_breakdown 前端自行組裝),新增 legacy_rate_percentage
-- 專門處理改版前的舊制紀錄(commission_rate_percentage_snapshot 不是 null 時才有值)。

create or replace function public.get_staff_commission_summary(p_staff_id uuid, p_year integer, p_month integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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
$function$;
