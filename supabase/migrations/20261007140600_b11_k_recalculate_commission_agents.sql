-- =====================================================================
-- SPECS-INDEX #996(第 11 批 K):已完成訂單的「重新計算抽成」按鈕 —— 後端
-- 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §十八 + 檔尾「主腦裁決」
--
-- 底稿 = 正式庫目前版本(2026-10-07 唯讀核對,md5(replace(prosrc,E'\r\n',E'\n'))):
--   public.recalculate_booking_commission(uuid)  改前指紋 25d456a6baeedada5f6396f7f1cf7f0d
--   (= 本機 20261007130200 L2383-2460;ACL postgres / authenticated / service_role,anon 無;comment null)
--   private.calculate_booking_staff_commission   3ed85dc4fb8e51128829e7f521458a79(F 版,本支不動)
--
-- ① recalculate_booking_commission:
--    K-1 權限從 private.is_merchant_admin 改成 private.can_manage_commission_settings(訂單所屬商家)
--        = 商家 / 集團管理員,或同店在職客服且「抽成與薪資設定」(commission_settings)鑰匙開著。
--        依據:#996 使用者裁決「管理員與客服都能用」+ 主腦決定「客服要有抽成與薪資設定權限」
--        ⇒ 推翻模組 8 規則 2.6「只有商家管理員能重算」。
--    K-2 加鎖:先不鎖讀 merchant_id → 權限 → 再 `for update` 鎖訂單列讀狀態與主要服務人員 → 狀態判斷。
--        理由:原本沒有鎖,兩人同時按會各自「刪明細 → 重插明細」留下兩份明細;也沒有跟
--        「還原 / 取消已完成訂單」(同樣鎖 bookings 列)排隊。權限仍在狀態之前(無權限者拿不到狀態、也鎖不到列)。
--    主腦裁決(推翻 §18.10 第 4 點):主要服務人員目前不是抽成制(compensation_type <> 'piece_rate',
--        例如已改月薪;找不到這位服務人員也算)⇒ 擋下「這位服務人員目前不是抽成制，無法重新計算抽成」。
--    其餘本體逐字不動;不加 comment;ACL 原樣重申(結果與現況相同)。
-- ② 新唯讀 RPC public.get_booking_commission_summary(uuid) returns jsonb(K-3):
--    給按鈕顯示「目前抽成」用。只有「抽成與薪資設定」鑰匙的客服讀不到 booking_commission_records
--    (讀取 RLS 要 staff_report),所以另開一支只回總額的 security definer 函式。
--    權限同 ①;找不到訂單與無權限回同一句 42501(不透露訂單存不存在)。不回明細、不回比例。
--    比規格多回 staff_is_piece_rate(前端依主腦裁決:不是抽成制就不顯示按鈕、改灰字)。
-- 只改函式、不改任何資料。
-- =====================================================================

-- ===== ① public.recalculate_booking_commission(p_booking_id uuid) =====
CREATE OR REPLACE FUNCTION public.recalculate_booking_commission(p_booking_id uuid)
 RETURNS booking_commission_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_status text;
  v_commission_record_id uuid;
  v_calc jsonb;
  v_result public.booking_commission_records;
  item jsonb;
begin
  -- 第 11 批 K #996:先不鎖讀商家 → 權限 → 再鎖訂單列讀狀態與主要服務人員(跟還原 / 取消已完成訂單排隊)。
  select b.merchant_id
  into v_merchant_id
  from public.bookings b
  where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_commission_settings(v_merchant_id) then
    raise exception '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作' using errcode = '42501';
  end if;

  select b.staff_id, b.status
  into v_staff_id, v_status
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if v_status <> 'completed' then
    raise exception '只有已完成的訂單才能重新計算抽成';
  end if;

  select id into v_commission_record_id
  from public.booking_commission_records
  where booking_id = p_booking_id;

  if v_commission_record_id is null then
    raise exception '這筆訂單目前沒有抽成紀錄，無法重新計算(可能是月薪制服務人員，不適用抽成)';
  end if;

  -- 第 11 批 K #996(主腦裁決):主要服務人員目前不是抽成制(例如已改月薪)⇒ 不准重算。
  if not exists (
    select 1 from public.merchant_staff ms
    where ms.id = v_staff_id and ms.compensation_type = 'piece_rate'
  ) then
    raise exception '這位服務人員目前不是抽成制，無法重新計算抽成';
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

revoke execute on function public.recalculate_booking_commission(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.recalculate_booking_commission(p_booking_id uuid) to authenticated, service_role;

-- ===== ② public.get_booking_commission_summary(p_booking_id uuid)(新,唯讀)=====
create function public.get_booking_commission_summary(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_found boolean;
  v_amount numeric;
  v_computed_at timestamptz;
  v_recalculated_at timestamptz;
  v_staff_name text;
  v_compensation_type text;
begin
  select b.merchant_id, b.staff_id
  into v_merchant_id, v_staff_id
  from public.bookings b
  where b.id = p_booking_id;
  v_found := found;

  -- 找不到訂單與無權限同一句(不透露訂單存不存在)。
  if not v_found or not coalesce(private.can_manage_commission_settings(v_merchant_id), false) then
    raise exception '沒有權限查看這筆訂單的抽成' using errcode = '42501';
  end if;

  select r.commission_amount, r.computed_at, r.recalculated_at
  into v_amount, v_computed_at, v_recalculated_at
  from public.booking_commission_records r
  where r.booking_id = p_booking_id;

  if not found then
    return jsonb_build_object(
      'has_record', false,
      'commission_amount', null,
      'computed_at', null,
      'recalculated_at', null,
      'staff_name', null,
      'staff_is_piece_rate', null
    );
  end if;

  select ms.name, ms.compensation_type
  into v_staff_name, v_compensation_type
  from public.merchant_staff ms
  where ms.id = v_staff_id;

  return jsonb_build_object(
    'has_record', true,
    'commission_amount', v_amount,
    'computed_at', v_computed_at,
    'recalculated_at', v_recalculated_at,
    'staff_name', v_staff_name,
    'staff_is_piece_rate', coalesce(v_compensation_type = 'piece_rate', false)
  );
end;
$function$;

revoke execute on function public.get_booking_commission_summary(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.get_booking_commission_summary(p_booking_id uuid) to authenticated, service_role;
