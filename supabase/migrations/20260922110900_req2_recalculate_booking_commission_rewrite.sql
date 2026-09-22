-- 商家端三項調整規格書 §二 2.7.3:recalculate_booking_commission 簽章調整,拿掉
-- p_override_rate_percentage(服務項目層級之下,一次重算涉及多個項目、多種模式,沒有單一數字
-- 可以覆寫)。語意改成「依商家目前最新的 staff_service_commission_rates 設定,重新算一次」。

drop function if exists public.recalculate_booking_commission(uuid, numeric);

create function public.recalculate_booking_commission(p_booking_id uuid)
returns public.booking_commission_records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_status text;
  v_commission_record_id uuid;
  v_calc jsonb;
  v_result public.booking_commission_records;
  item jsonb;
begin
  select b.merchant_id, b.staff_id, b.status
  into v_merchant_id, v_staff_id, v_status
  from public.bookings b
  where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '重新計算已完成訂單的抽成金額,只有商家管理員可以操作' using errcode = '42501';
  end if;

  if v_status <> 'completed' then
    raise exception '只有已完成的訂單才能重新計算抽成';
  end if;

  select id into v_commission_record_id
  from public.booking_commission_records
  where booking_id = p_booking_id;

  if v_commission_record_id is null then
    raise exception '這筆訂單目前沒有抽成紀錄,無法重新計算(可能是月薪制服務人員,不適用抽成)';
  end if;

  delete from public.booking_commission_item_records
  where commission_record_id = v_commission_record_id;

  v_calc := private.calculate_booking_staff_commission(p_booking_id, v_staff_id);

  update public.booking_commission_records
  set commission_basis_type_snapshot = v_calc ->> 'commission_basis_type',
      commission_base_amount_snapshot = (v_calc ->> 'total_commission_base_amount')::numeric,
      material_cost_deducted_snapshot = (v_calc ->> 'total_material_cost_deducted')::numeric,
      commission_rate_percentage_snapshot = null,
      commission_amount = (v_calc ->> 'total_commission_amount')::numeric,
      recalculated_at = now()
  where id = v_commission_record_id
  returning * into v_result;

  for item in select * from jsonb_array_elements(v_calc -> 'items')
  loop
    insert into public.booking_commission_item_records (
      commission_record_id, booking_service_item_id, service_item_name_snapshot,
      quantity_snapshot, commission_mode_snapshot, commission_value_snapshot,
      commission_base_amount_snapshot, commission_amount
    ) values (
      v_commission_record_id,
      (item ->> 'booking_service_item_id')::uuid,
      item ->> 'service_item_name',
      (item ->> 'quantity')::integer,
      item ->> 'commission_mode',
      (item ->> 'commission_value')::numeric,
      (item ->> 'commission_base_amount')::numeric,
      (item ->> 'commission_amount')::numeric
    );
  end loop;

  return v_result;
end;
$function$;

-- 重建函式後需要重新補回既有的執行權限(drop function 會一併清掉 GRANT)。
grant execute on function public.recalculate_booking_commission(uuid) to authenticated;
