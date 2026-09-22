-- 模組 6(訂單管理)§9.1(SPECS-INDEX #597):寫入邏輯 + 查詢函式。
--
-- ⚠️ 動工前查證:用 ToolSearch/grep 找出 create_booking/update_booking/confirm_booking/
-- cancel_booking/complete_booking 這 5 支函式目前各自「最新」的一份 migration(依 timestamp
-- 排序,confirm_booking wt cancel_booking 最新版在 20260918100100_booking_detail_expansion_
-- functions.sql;create_booking/update_booking 最新版在 20260920140200_members_booking_overlay.sql;
-- complete_booking 最新版在 20260920140300_members_loyalty_compute.sql,之後沒有任何 migration
-- 再疊加過這 5 支函式),逐字保留原本函式主體,只新增「呼叫 private.log_booking_status_change
-- 寫入一筆操作記錄」這一行,不從舊版本重建、不遺漏既有的 perform 呼叫(重申模組 7/8/9/10/11/15
-- 已經記錄過的教訓)。
--
-- update_booking 這次不需要修改:規格書 §9.1 寫入時機第 5 點提到「update_booking 如果這次編輯
-- 有改變 status,額外寫入一筆」,但實際檢查 update_booking 目前的 UPDATE 語句完全沒有
-- `status = ...` 這一行(status 欄位從建立以來只被 confirm_booking/cancel_booking/complete_booking
-- 這三支專職函式改變),也就是說 update_booking 現在根本不會改變狀態,「如果沒有改變狀態就不寫入」
-- 這個條件永遠成立,不需要額外程式碼就已經符合規格書的行為要求——這裡刻意不去動 update_booking,
-- 避免無謂觸碰一支跟本次需求無關的函式簽章(第五節「模組獨立性」的延伸精神)。

-- =========================================================================
-- 私有輔助函式:計算「目前呼叫者」在這間商家底下的顯示姓名/角色快照,供下面
-- private.log_booking_status_change 呼叫。查詢邏輯沿用 get_booking_actor_names 的既有判斷順序
-- (先查 merchant_admins,查不到再查 merchant_agents),只是目標從「任意一批 user_id」改成
-- 「auth.uid() 這一位」。只給 private.log_booking_status_change 內部呼叫,不對外暴露。
-- =========================================================================
create or replace function private.current_actor_display_name(p_merchant_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (
      select coalesce(
        nullif(btrim(ma.display_name), ''),
        nullif(split_part(u.email::text, '@', 1), ''),
        '管理員'
      )
      from public.merchant_admins ma
      join auth.users u on u.id = ma.user_id
      where ma.merchant_id = p_merchant_id and ma.user_id = auth.uid()
      limit 1
    ),
    (
      select coalesce(nullif(btrim(mag.nickname), ''), mag.name)
      from public.merchant_agents mag
      where mag.merchant_id = p_merchant_id and mag.user_id = auth.uid()
      limit 1
    ),
    '(已移除的人員)'
  );
$$;

comment on function private.current_actor_display_name(uuid) is '模組 6 §9.1:算出目前呼叫者(auth.uid())在這間商家底下的顯示姓名,供 private.log_booking_status_change 寫入 actor_name_snapshot。判斷順序沿用 get_booking_actor_names 既有邏輯(先查 merchant_admins.display_name,查不到再查 merchant_agents.nickname/name),只給內部函式呼叫,不對外暴露。';

revoke execute on function private.current_actor_display_name(uuid) from public, anon, authenticated;

create or replace function private.current_actor_role_snapshot(p_merchant_id uuid)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select case
    when private.is_merchant_admin(p_merchant_id) then 'merchant_admin'
    else 'agent'
  end;
$$;

comment on function private.current_actor_role_snapshot(uuid) is '模組 6 §9.1:目前呼叫者是商家管理員還是客服,供 private.log_booking_status_change 寫入 actor_role_snapshot。這幾支狀態轉換函式本身已經要求 private.can_manage_bookings 通過才能執行到這一步,所以只會是 merchant_admin 或 agent 其中一種,不會是 staff/system(這兩個值保留給未來擴充,見資料表註解)。只給內部函式呼叫,不對外暴露。';

revoke execute on function private.current_actor_role_snapshot(uuid) from public, anon, authenticated;

-- =========================================================================
-- 私有輔助函式:寫入一筆操作記錄。疊加在 create_booking/confirm_booking/cancel_booking/
-- complete_booking 內部,各自在「狀態成功變更之後」呼叫一次。
-- =========================================================================
create or replace function private.log_booking_status_change(
  p_booking_id uuid,
  p_merchant_id uuid,
  p_from_status text,
  p_to_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- created_at 明確用 clock_timestamp()(不是資料表 DEFAULT 的 now()):同一筆訂單在極短時間內
  -- 連續變更多次狀態(例如同一支 Edge Function/pgTAP 測試在同一個交易內連續呼叫
  -- create_booking→confirm_booking→complete_booking)時,now() 在同一個交易裡整個凍結在交易
  -- 開始那一刻,會讓好幾筆操作記錄拿到一模一樣的 created_at,導致「依時間新到舊排序」的顯示順序
  -- 不可靠。這是本專案已經在 SPECS-INDEX #623(staff_payroll_status_history 觸發器)踩過並記錄
  -- 過的同一種坑,這裡直接沿用同一個修法。
  insert into public.booking_status_change_logs (
    booking_id, merchant_id, from_status, to_status,
    actor_user_id, actor_name_snapshot, actor_role_snapshot, created_at
  ) values (
    p_booking_id, p_merchant_id, p_from_status, p_to_status,
    auth.uid(),
    private.current_actor_display_name(p_merchant_id),
    private.current_actor_role_snapshot(p_merchant_id),
    clock_timestamp()
  );
end;
$$;

comment on function private.log_booking_status_change(uuid, uuid, text, text) is '模組 6 §9.1:寫入一筆訂單狀態變更操作記錄,只由 create_booking/confirm_booking/cancel_booking/complete_booking 內部用 perform 呼叫(不對外公開,刻意 revoke 所有角色的 execute 權限,避免被繞過正常流程直接呼叫寫入偽造紀錄)。';

revoke execute on function private.log_booking_status_change(uuid, uuid, text, text) from public, anon, authenticated;

-- =========================================================================
-- create_booking:逐字保留 20260920140200_members_booking_overlay.sql 的函式主體,只在
-- `select * into v_result from public.bookings where id = v_booking_id;` 之前新增一行
-- perform private.log_booking_status_change(...)(from_status=null,代表「建立」這個動作本身)。
-- 簽章完全不變,不需要 drop。
-- =========================================================================
create or replace function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}'::uuid[],
  p_material_cost_item_ids uuid[] default '{}'::uuid[],
  p_customer_address text default null,
  p_customer_notes text default null,
  p_custom_total_amount_enabled boolean default false,
  p_custom_total_amount numeric default null,
  p_discount_enabled boolean default false,
  p_discount_mode text default null,
  p_discount_value numeric default null,
  p_tax_enabled boolean default false,
  p_tax_mode text default null,
  p_tax_value numeric default null,
  p_payment_method_id uuid default null,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null,
  p_member_id uuid default null
)
returns bookings
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_sel record;
  v_amount record;
  v_created_by_role text;
  v_booking_id uuid;
  v_industry_type text;
  v_result public.bookings;
  v_member_name text;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限建立這間商家的預約' using errcode = '42501';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  if p_member_id is not null then
    select name into v_member_name
    from public.members
    where id = p_member_id
      and merchant_id = p_merchant_id
      and status = 'active';

    if not found then
      raise exception '找不到指定的會員,或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
  );

  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method_id, payment_method_name_snapshot,
    custom_duration_enabled, custom_duration_minutes,
    member_id, member_name_snapshot
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_sel.end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation',
    coalesce(p_custom_total_amount_enabled, false), p_custom_total_amount, v_amount.subtotal_amount,
    coalesce(p_discount_enabled, false), p_discount_mode, p_discount_value, v_amount.discount_amount,
    coalesce(p_tax_enabled, false), p_tax_mode, p_tax_value, v_amount.tax_amount,
    v_amount.final_amount, p_payment_method_id, v_sel.payment_method_name,
    coalesce(p_custom_duration_enabled, false),
    case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    p_member_id, v_member_name
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    v_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select v_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select v_booking_id, mci.id, mci.amount
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:建立訂單本身也算一筆操作記錄,
  -- from_status = null 代表「建立」這個動作。
  perform private.log_booking_status_change(v_booking_id, p_merchant_id, null, 'pending_confirmation');

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$function$;

comment on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) is '建立預約(模組 6,逐字沿用既有邏輯)。模組 6 §9.1(SPECS-INDEX #597)新增一行:成功建立後寫入一筆 booking_status_change_logs(from_status=null, to_status=pending_confirmation),代表「建立」這個動作。其餘邏輯(含模組 10 §3.6 的 p_member_id)完全不變。';

-- =========================================================================
-- update_booking:這次不需要改動(見檔案開頭說明:目前完全不會改變 status,永遠不觸發寫入條件),
-- 這裡刻意不重新 create or replace,避免無謂觸碰一支跟本次需求無關的函式。
-- =========================================================================

-- =========================================================================
-- confirm_booking:逐字保留 20260918100100_booking_detail_expansion_functions.sql 的函式主體,
-- 在 update ... returning * into v_result 之後新增一行 perform 呼叫。簽章不變。
-- =========================================================================
create or replace function public.confirm_booking(p_booking_id uuid)
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

  if v_status <> 'pending_confirmation' then
    raise exception '只有「待確認」狀態的預約可以確認,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  update public.bookings
  set status = 'accepted',
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:v_status 是變更前的狀態(pending_confirmation)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'accepted');

  return v_result;
end;
$$;

comment on function public.confirm_booking(uuid) is '對應建單功能擴充規格書 4.8/決策記錄 5:把 pending_confirmation 轉成 accepted。預約詳情資訊擴充與建單備註分類第三節 3.3 點:成功執行時一併寫入 last_modified_by_user_id/last_modified_at。模組 6 §9.1(SPECS-INDEX #597)新增:成功執行時一併寫入一筆 booking_status_change_logs。權限比照建單權限(orders section_key)。已知限制(規格書 2.4):這次不重新驗證時段衝突。不算危險操作,不觸發任何通知。';

-- =========================================================================
-- cancel_booking:逐字保留既有函式主體,新增一行 perform 呼叫。簽章不變。
-- =========================================================================
create or replace function public.cancel_booking(
  p_booking_id uuid,
  p_reason text default null
)
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

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '只有「待確認」或「已確認」狀態的預約可以取消,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'cancelled');

  return v_result;
end;
$$;

comment on function public.cancel_booking(uuid, text) is '對應建單功能擴充規格書 2.4/決策記錄 5 第 4 點:取消預約,可取消狀態是 pending_confirmation 或 accepted。預約詳情資訊擴充與建單備註分類第三節 3.3 點:成功執行時一併寫入 last_modified_by_user_id/last_modified_at。模組 6 §9.1(SPECS-INDEX #597)新增:成功執行時一併寫入一筆 booking_status_change_logs。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查。不算危險操作,不需要 JSON 備份。';

-- =========================================================================
-- complete_booking:逐字保留 20260920140300_members_loyalty_compute.sql 的函式主體(含模組 8
-- compute_booking_commission、模組 10 compute_member_loyalty_points 兩行既有疊加),在
-- `return v_result;` 之前新增一行 perform 呼叫。簽章不變。
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

  -- 模組 8(薪資與帳務)§3.7 既有的一行:訂單成功轉為 completed 之後,計算抽成快照。
  perform public.compute_booking_commission(p_booking_id);

  -- 模組 10(會員與紅利)§3.8 既有的一行:訂單成功轉為 completed 之後,計算會員紅利點數。
  perform public.compute_member_loyalty_points(p_booking_id);

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'completed');

  return v_result;
end;
$$;

comment on function public.complete_booking(uuid) is '把預約標記為完成(模組 6)。模組 8(薪資與帳務)§3.7 疊加呼叫 compute_booking_commission;模組 10(會員與紅利)§3.8 疊加呼叫 compute_member_loyalty_points;模組 6 §9.1(SPECS-INDEX #597)疊加寫入一筆 booking_status_change_logs。三者都在訂單狀態成功轉為 completed 之後、return 之前執行,各自寫各自的表,互不影響、互不覆蓋。簽章/回傳型別/呼叫方式完全不變。';

-- =========================================================================
-- 對外介面:get_booking_status_change_logs(p_booking_id uuid)。
-- =========================================================================
create or replace function public.get_booking_status_change_logs(p_booking_id uuid)
returns table (
  id uuid,
  from_status text,
  to_status text,
  actor_name_snapshot text,
  actor_role_snapshot text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- 這支函式的 RETURNS TABLE 裡也有一個叫 id 的輸出欄位,在 PL/pgSQL 函式主體內會變成一個跟
  -- 資料表欄位同名的區域變數——直接寫 `where id = p_booking_id` 會被誤判成拿這個輸出變數
  -- (目前是 null)去比對,而不是 public.bookings.id,造成「column reference "id" is ambiguous」。
  -- 這裡明確用 b.id 消除歧義(pgTAP 測試 module6_08 已經涵蓋這個情境,重現過這個錯誤再修正)。
  select b.merchant_id into v_merchant_id from public.bookings b where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限查詢這筆預約的操作記錄' using errcode = '42501';
  end if;

  return query
  select l.id, l.from_status, l.to_status, l.actor_name_snapshot, l.actor_role_snapshot, l.created_at
  from public.booking_status_change_logs l
  where l.booking_id = p_booking_id
  order by l.created_at desc;
end;
$$;

comment on function public.get_booking_status_change_logs(uuid) is '模組 6 §9.1(SPECS-INDEX #597):回傳某筆訂單的操作記錄,依時間新到舊排序。權限檢查跟檢視訂單本身一致(private.can_manage_bookings,即 orders section_key),管理員永遠可以,被授權 orders 的客服也可以。';

revoke execute on function public.get_booking_status_change_logs(uuid) from public, anon;
grant execute on function public.get_booking_status_change_logs(uuid) to authenticated;
