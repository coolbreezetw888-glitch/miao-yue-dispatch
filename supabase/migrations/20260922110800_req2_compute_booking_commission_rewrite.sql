-- 商家端三項調整規格書 §二 2.7.2:compute_booking_commission 重寫(簽章不變),改用服務項目層級
-- 抽成引擎逐項計算再加總。只由 complete_booking() 內部呼叫,權限維持原樣(CREATE OR REPLACE
-- 不會動到既有的 GRANT/REVOKE)。

create or replace function public.compute_booking_commission(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_compensation_type text;
  v_calc jsonb;
  v_commission_record_id uuid;
  item jsonb;
begin
  select merchant_id, staff_id into v_merchant_id, v_staff_id
  from public.bookings
  where id = p_booking_id;

  if not found then
    return;
  end if;

  select compensation_type into v_compensation_type
  from public.merchant_staff
  where id = v_staff_id;

  if v_compensation_type is distinct from 'piece_rate' then
    return;
  end if;

  v_calc := private.calculate_booking_staff_commission(p_booking_id, v_staff_id);

  insert into public.booking_commission_records (
    booking_id, staff_id, merchant_id,
    commission_basis_type_snapshot, commission_base_amount_snapshot,
    material_cost_deducted_snapshot, commission_rate_percentage_snapshot,
    commission_amount
  ) values (
    p_booking_id, v_staff_id, v_merchant_id,
    v_calc ->> 'commission_basis_type',
    (v_calc ->> 'total_commission_base_amount')::numeric,
    (v_calc ->> 'total_material_cost_deducted')::numeric,
    null,
    (v_calc ->> 'total_commission_amount')::numeric
  )
  on conflict (booking_id) do nothing
  returning id into v_commission_record_id;

  -- 如果因為 on conflict do nothing 沒有真的插入新的一列(理論上不該發生,防呆用),
  -- 直接跳過,不寫入任何明細,避免產生「明細存在但沒有對應彙總」的孤兒資料。
  if v_commission_record_id is null then
    return;
  end if;

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
end;
$function$;
