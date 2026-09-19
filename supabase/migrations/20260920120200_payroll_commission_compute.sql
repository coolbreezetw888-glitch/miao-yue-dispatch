-- 模組 8:薪資與帳務 — compute_booking_commission + complete_booking 疊加(第三支,風險最高)。
-- 對應規格書 §3.6/§3.7、規則 2.1~2.5。
--
-- ⚠️ complete_booking() 的目前完整版本,是動工前用 mcp__claude_ai_Supabase__execute_sql 對正式
-- 專案 wjtbmmnakcriuaqoknsq 執行 `select pg_get_functiondef('public.complete_booking(uuid)'::regprocedure)`
-- 取得的(2026-09-20 查證),跟本機 20260918100100_booking_detail_expansion_functions.sql 裡的版本
-- 逐字相同(已比對確認,20260918100100 之後沒有任何 migration 再動過這支函式)。以下逐字保留原本
-- 函式主體,只新增一行 perform public.compute_booking_commission(p_booking_id); 在狀態成功轉為
-- completed 之後、return 之前。簽章/回傳型別/呼叫方式完全不變。

-- =========================================================================
-- 3.6:compute_booking_commission(p_booking_id uuid)。SECURITY DEFINER,不對外公開給前端
-- 直接呼叫(只由 complete_booking 內部呼叫),明確 revoke 所有角色的 execute 權限(比 seed
-- 類函式更嚴格——這支函式的呼叫時機直接決定規則 2.4「快照建立後不自動重算」是否成立,
-- 如果被外部提前呼叫,可能在訂單真正完成前就把抽成金額鎖死,風險比單純的種子函式更高,
-- 值得多做這一層防護)。
-- =========================================================================
create or replace function public.compute_booking_commission(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_subtotal numeric(10, 2);
  v_discount numeric(10, 2);
  v_compensation_type text;
  v_basis_type text;
  v_default_rate numeric(5, 2);
  v_material_cost numeric(10, 2) := 0;
  v_base_amount numeric(10, 2);
  v_rate numeric(5, 2);
  v_amount numeric(10, 2);
begin
  -- 1. 查 bookings 取得 merchant_id/staff_id/subtotal_amount_snapshot/discount_amount_snapshot。
  select merchant_id, staff_id, subtotal_amount_snapshot, discount_amount_snapshot
  into v_merchant_id, v_staff_id, v_subtotal, v_discount
  from public.bookings
  where id = p_booking_id;

  if not found then
    -- 防呆:理論上呼叫端(complete_booking)已經確認這筆訂單存在,這裡不應該發生。
    return;
  end if;

  -- 2. 只有按件計酬服務人員才產生抽成紀錄(規則 2.3),月薪制直接 return,不寫入任何資料列。
  select compensation_type into v_compensation_type
  from public.merchant_staff
  where id = v_staff_id;

  if v_compensation_type is distinct from 'piece_rate' then
    return;
  end if;

  -- 3. 查 merchant_payroll_settings,查無資料視為預設值(§1.1)。
  select commission_basis_type, default_commission_rate_percentage
  into v_basis_type, v_default_rate
  from public.merchant_payroll_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_basis_type := 'gross';
    v_default_rate := 0;
  end if;

  -- 4. 規則 2.1:抽成基準 = subtotal − discount(已排除稅金),net_of_material_cost 再扣料錢成本,
  -- 結果 < 0 一律以 0 計。
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

  -- 5. 規則 2.2:先查個人覆寫(staff_commission_rates),查無資料才用商家預設值。
  select rate_percentage into v_rate
  from public.staff_commission_rates
  where staff_id = v_staff_id;

  if not found then
    v_rate := v_default_rate;
  end if;

  -- 6. 規則 2.2:抽成金額 = 基準 × 比例,四捨五入到分。
  v_amount := round(v_base_amount * v_rate / 100, 2);

  -- 7. 寫入快照。on conflict (booking_id) do nothing 保護既有紀錄不被覆蓋(規則 2.4)——
  -- 理論上 complete_booking 只會成功轉換一次狀態,這裡是最後一道防線。
  insert into public.booking_commission_records (
    booking_id, staff_id, merchant_id,
    commission_basis_type_snapshot, commission_base_amount_snapshot,
    material_cost_deducted_snapshot, commission_rate_percentage_snapshot,
    commission_amount
  ) values (
    p_booking_id, v_staff_id, v_merchant_id,
    v_basis_type, v_base_amount,
    v_material_cost, v_rate,
    v_amount
  )
  on conflict (booking_id) do nothing;
end;
$$;

comment on function public.compute_booking_commission(uuid) is '模組 8 §3.6(核心):某筆訂單完成當下,計算主要服務人員(bookings.staff_id,不含助手,規則 2.5)的抽成金額並寫入 booking_commission_records 快照。只有 compensation_type=piece_rate 才寫入(規則 2.3),月薪制直接 return。on conflict (booking_id) do nothing 保護既有紀錄不被覆寫(規則 2.4 核心規則)。SECURITY DEFINER,不對外公開,只由 complete_booking() 內部用 perform 呼叫——刻意 revoke 所有角色的 execute 權限(見下方),避免被提前呼叫而在訂單真正完成前就把抽成金額鎖死。';

revoke execute on function public.compute_booking_commission(uuid) from public, anon, authenticated;

-- =========================================================================
-- 3.7:complete_booking() 疊加呼叫 compute_booking_commission(create or replace)。
-- 簽章/回傳型別/呼叫方式完全不變,只在成功把訂單狀態更新為 completed 之後、return 之前,
-- 新增一行 perform 呼叫。以下函式主體逐字保留自 20260918100100_booking_detail_expansion_functions.sql
-- (已用 pg_get_functiondef 對正式環境核對過,無漂移)。
-- =========================================================================
create or replace function public.complete_booking(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以標記完成,目前狀態不允許這個操作';
  end if;

  update public.bookings
  set status = 'completed',
      completed_at = now(),
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 模組 8(薪資與帳務)§3.7 新增的唯一一行:訂單成功轉為 completed 之後,計算抽成快照。
  perform public.compute_booking_commission(p_booking_id);

  return v_result;
end;
$$;

comment on function public.complete_booking(uuid) is '把預約標記為完成(模組 6)。模組 8(薪資與帳務)§3.7 在這裡疊加呼叫 compute_booking_commission(p_booking_id),在訂單狀態成功轉為 completed 之後、return 之前計算並寫入抽成快照(規則 2.4:只在這個時間點寫入一次,之後不自動重算)。簽章/回傳型別/呼叫方式完全不變,其餘邏輯逐字保留自模組 6 既有版本。';
