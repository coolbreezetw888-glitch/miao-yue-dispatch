-- 模組 8:薪資與帳務 — recalculate_booking_commission(第四支)。
-- 對應規格書 §3.8、規則 2.6(核心,僅商家管理員)。

create or replace function public.recalculate_booking_commission(
  p_booking_id uuid,
  p_override_rate_percentage numeric default null
)
returns public.booking_commission_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_status text;
  v_subtotal numeric(10, 2);
  v_discount numeric(10, 2);
  v_basis_type text;
  v_default_rate numeric(5, 2);
  v_material_cost numeric(10, 2) := 0;
  v_base_amount numeric(10, 2);
  v_rate numeric(5, 2);
  v_amount numeric(10, 2);
  v_result public.booking_commission_records;
begin
  -- 1. 查 bookings 取得 merchant_id,檢查 private.is_merchant_admin(規則 2.6:不接受客服呼叫,
  -- 即使該客服已經被授權 commission_settings 也一樣被擋下)。
  select b.merchant_id, b.staff_id, b.status, b.subtotal_amount_snapshot, b.discount_amount_snapshot
  into v_merchant_id, v_staff_id, v_status, v_subtotal, v_discount
  from public.bookings b
  where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '重新計算已完成訂單的抽成金額,只有商家管理員可以操作' using errcode = '42501';
  end if;

  -- 2. 防呆:該筆訂單狀態確實是 completed(理論上有抽成紀錄就代表已完成)。
  if v_status <> 'completed' then
    raise exception '只有已完成的訂單才能重新計算抽成';
  end if;

  if not exists (select 1 from public.booking_commission_records where booking_id = p_booking_id) then
    raise exception '這筆訂單目前沒有抽成紀錄,無法重新計算(可能是月薪制服務人員,不適用抽成)';
  end if;

  if p_override_rate_percentage is not null
     and (p_override_rate_percentage < 0 or p_override_rate_percentage > 100) then
    raise exception '指定的抽成比例必須介於 0~100 之間';
  end if;

  -- 3. 重新執行 3.6 步驟 3~6,唯一差異:p_override_rate_percentage 有帶值時直接採用。
  select commission_basis_type, default_commission_rate_percentage
  into v_basis_type, v_default_rate
  from public.merchant_payroll_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_basis_type := 'gross';
    v_default_rate := 0;
  end if;

  v_base_amount := coalesce(v_subtotal, 0) - coalesce(v_discount, 0);

  if v_basis_type = 'net_of_material_cost' then
    select coalesce(sum(amount_snapshot), 0) into v_material_cost
    from public.booking_material_costs
    where booking_id = p_booking_id;

    v_base_amount := v_base_amount - v_material_cost;
  else
    v_material_cost := 0;
  end if;

  v_base_amount := greatest(v_base_amount, 0);

  if p_override_rate_percentage is not null then
    v_rate := p_override_rate_percentage;
  else
    select rate_percentage into v_rate
    from public.staff_commission_rates
    where staff_id = v_staff_id;

    if not found then
      v_rate := v_default_rate;
    end if;
  end if;

  v_amount := round(v_base_amount * v_rate / 100, 2);

  -- 4. 更新既有紀錄,recalculated_at = now()(方便報表/稽核一眼看出這筆是否被人工調整過)。
  update public.booking_commission_records
  set commission_basis_type_snapshot = v_basis_type,
      commission_base_amount_snapshot = v_base_amount,
      material_cost_deducted_snapshot = v_material_cost,
      commission_rate_percentage_snapshot = v_rate,
      commission_amount = v_amount,
      recalculated_at = now()
  where booking_id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.recalculate_booking_commission(uuid, numeric) is '模組 8 §3.8(核心,規則 2.6):手動重新計算某筆已完成訂單的抽成金額,唯一能改變 booking_commission_records 既有紀錄的路徑(規則 2.4)。只有商家管理員可以呼叫(private.is_merchant_admin),即使客服被授權 commission_settings 這個 section_key 也一樣被擋下——對應 ARCHITECTURE 第八節第 6 條「動用金流最終撥款這類特別敏感的環節」的例外情況,不透過 merchant_agent_permissions 開放。p_override_rate_percentage 有帶值時直接採用這個比例(管理員手動指定個案調整),不帶值則沿用目前的設定重算一次。recalculated_at 寫入 now(),方便報表/稽核辨識這筆是否被人工調整過。';

revoke execute on function public.recalculate_booking_commission(uuid, numeric) from public, anon;
grant execute on function public.recalculate_booking_commission(uuid, numeric) to authenticated;
