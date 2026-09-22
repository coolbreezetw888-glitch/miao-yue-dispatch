-- 商家端三項調整規格書 §二 2.7.4:批量套用抽成,對應批量套用按鈕。用一支資料庫函式一次寫完
-- 全部項目,不是前端迴圈呼叫 N 次個別 upsert,避免半套用狀態。

create or replace function public.batch_apply_staff_service_commission_rates(
  p_staff_id uuid,
  p_service_item_ids uuid[],
  p_commission_mode text,
  p_commission_value numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_compensation_type text;
begin
  select merchant_id, compensation_type into v_merchant_id, v_compensation_type
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_manage_commission_settings(v_merchant_id) then
    raise exception '沒有權限設定這間商家的抽成' using errcode = '42501';
  end if;

  if v_compensation_type <> 'piece_rate' then
    raise exception '只有按件計酬的服務人員可以設定抽成';
  end if;

  if p_commission_mode not in ('percentage', 'fixed_amount') then
    raise exception '抽成模式必須是 percentage 或 fixed_amount';
  end if;

  if p_commission_value < 0 then
    raise exception '抽成數值不可為負數';
  end if;

  if p_commission_mode = 'percentage' and p_commission_value > 100 then
    raise exception '百分比模式下,抽成數值必須介於 0~100 之間';
  end if;

  insert into public.staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
  select p_staff_id, item_id, p_commission_mode, p_commission_value
  from unnest(p_service_item_ids) as item_id
  on conflict (staff_id, service_item_id) do update
    set commission_mode = excluded.commission_mode,
        commission_value = excluded.commission_value;
end;
$function$;

revoke all on function public.batch_apply_staff_service_commission_rates(uuid, uuid[], text, numeric) from public;
revoke all on function public.batch_apply_staff_service_commission_rates(uuid, uuid[], text, numeric) from anon;
grant execute on function public.batch_apply_staff_service_commission_rates(uuid, uuid[], text, numeric) to authenticated;
