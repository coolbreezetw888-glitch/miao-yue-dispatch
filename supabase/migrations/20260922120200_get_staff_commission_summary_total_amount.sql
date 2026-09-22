-- 模組 14(服務人員端)v2 §10.4.2:get_staff_commission_summary 疊加 total_amount 欄位。
--
-- 動工前已用 execute_sql 查證正式環境這支函式目前的最新版本(商家端三項調整批次已經改過,
-- 20260922111100_req2_get_staff_commission_summary_item_breakdown.sql 那一版,含
-- can_view_staff_own_payroll 自助檢視分支 + item_breakdown 逐項抽成明細),這次在那個最新版本
-- 基礎上疊加,不是覆蓋掉商家端那批剛加上去的欄位。
--
-- commission_base_amount_snapshot(用來算抽成的基準金額)不等於「訂單原始總額」——依模組 8
-- 規則 2.1,commission_base_amount_snapshot = subtotal_amount_snapshot − discount_amount_snapshot,
-- 已經先排除稅金,如果商家設定 commission_basis_type='net_of_material_cost' 還會再扣掉料錢成本,
-- 不能直接拿它加總充當「訂單總額」。這裡改用 bookings.final_amount_snapshot(訂單最終實收金額
-- 快照,BookingDetailDialog.tsx 顯示「最終金額」用的同一個欄位)加總算出新的 total_amount。
--
-- 除了在既有的 jsonb_build_object 新增一個 key,函式簽章 (uuid, int, int)、既有的
-- details/total_orders/total_commission_amount/assistant_booking_count 四個既有 key、既有查詢邏輯
-- 完全不變,對既有呼叫端(商家管理員的 StaffReportPage.tsx)沒有任何影響。

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
    coalesce(sum(bcr.commission_amount), 0),
    coalesce(sum(b.final_amount_snapshot), 0)
  into v_details, v_total_orders, v_total_amount, v_gross_amount
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
    'assistant_booking_count', v_assistant_count,
    'total_amount', v_gross_amount
  );
end;
$function$;

comment on function public.get_staff_commission_summary(uuid, integer, integer) is '模組 8/14:某位按件計酬服務人員某年月的抽成明細+總計。模組 14 v2 §10.4.2 疊加 total_amount(訂單原始總額,sum(bookings.final_amount_snapshot),跟已經先扣過折扣/可能還扣料錢成本的 total_commission_amount 是不同數字)。權限:商家管理員/客服(can_view_payroll_reports)或服務人員自助查自己(can_view_staff_own_payroll)。';
