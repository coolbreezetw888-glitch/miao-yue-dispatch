-- 商家端三項調整規格書 §二 2.7.1:純計算輔助函式,不寫入任何資料表,供 compute_booking_commission
-- (插入)、recalculate_booking_commission(先刪明細再插入+更新彙總)兩者共用。

create or replace function private.calculate_booking_staff_commission(p_booking_id uuid, p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_subtotal numeric(10, 2);
  v_discount numeric(10, 2);
  v_basis_type text;
  v_material_cost_total numeric(10, 2) := 0;
  v_raw_total numeric(10, 2) := 0;
  v_item_count int := 0;
  v_items jsonb := '[]'::jsonb;
  v_total_commission_amount numeric(10, 2) := 0;
  v_total_commission_base_amount numeric(10, 2) := 0;
  rec record;
  v_ratio numeric;
  v_effective_subtotal numeric(10, 2);
  v_discount_share numeric(10, 2);
  v_material_cost_share numeric(10, 2);
  v_commission_base numeric(10, 2);
  v_commission_mode text;
  v_commission_value numeric(10, 2);
  v_commission_amount numeric(10, 2);
  v_output_base numeric(10, 2);
begin
  select merchant_id, subtotal_amount_snapshot, discount_amount_snapshot
  into v_merchant_id, v_subtotal, v_discount
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  select commission_basis_type into v_basis_type
  from public.merchant_payroll_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_basis_type := 'gross';
  end if;

  if v_basis_type = 'net_of_material_cost' then
    select coalesce(sum(amount_snapshot), 0) into v_material_cost_total
    from public.booking_material_costs
    where booking_id = p_booking_id;
  else
    v_material_cost_total := 0;
  end if;

  select count(*), coalesce(sum(bsi.unit_price_snapshot * bsi.quantity), 0)
  into v_item_count, v_raw_total
  from public.booking_service_items bsi
  where bsi.booking_id = p_booking_id;

  for rec in
    select bsi.id as booking_service_item_id, bsi.service_item_id, bsi.quantity,
           bsi.unit_price_snapshot, si.name as service_item_name
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = p_booking_id
    order by bsi.created_at
  loop
    if v_raw_total > 0 then
      v_ratio := (rec.unit_price_snapshot * rec.quantity) / v_raw_total;
    else
      v_ratio := 1.0 / greatest(v_item_count, 1);
    end if;

    v_effective_subtotal := coalesce(v_subtotal, 0) * v_ratio;
    v_discount_share := coalesce(v_discount, 0) * v_ratio;
    v_material_cost_share := v_material_cost_total * v_ratio;
    v_commission_base := greatest(v_effective_subtotal - v_discount_share - v_material_cost_share, 0);

    select ssc.commission_mode, ssc.commission_value
    into v_commission_mode, v_commission_value
    from public.staff_service_commission_rates ssc
    where ssc.staff_id = p_staff_id and ssc.service_item_id = rec.service_item_id;

    if not found then
      v_commission_mode := 'percentage';
      v_commission_value := 0;
    end if;

    if v_commission_mode = 'percentage' then
      v_commission_amount := round(v_commission_base * v_commission_value / 100, 2);
      v_output_base := round(v_commission_base, 2);
    else
      v_commission_amount := round(v_commission_value * rec.quantity, 2);
      v_output_base := 0;
    end if;

    v_total_commission_amount := v_total_commission_amount + v_commission_amount;
    v_total_commission_base_amount := v_total_commission_base_amount + v_output_base;

    v_items := v_items || jsonb_build_object(
      'booking_service_item_id', rec.booking_service_item_id,
      'service_item_id', rec.service_item_id,
      'service_item_name', rec.service_item_name,
      'quantity', rec.quantity,
      'commission_mode', v_commission_mode,
      'commission_value', v_commission_value,
      'commission_base_amount', v_output_base,
      'commission_amount', v_commission_amount
    );
  end loop;

  return jsonb_build_object(
    'items', v_items,
    'commission_basis_type', v_basis_type,
    'total_commission_amount', round(v_total_commission_amount, 2),
    'total_commission_base_amount', round(v_total_commission_base_amount, 2),
    'total_material_cost_deducted', round(v_material_cost_total, 2)
  );
end;
$function$;

-- 不對外公開,只給 compute_booking_commission/recalculate_booking_commission 內部呼叫。
revoke all on function private.calculate_booking_staff_commission(uuid, uuid) from public;
revoke all on function private.calculate_booking_staff_commission(uuid, uuid) from anon;
revoke all on function private.calculate_booking_staff_commission(uuid, uuid) from authenticated;
