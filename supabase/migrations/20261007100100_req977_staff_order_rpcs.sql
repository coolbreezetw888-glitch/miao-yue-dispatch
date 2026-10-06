-- SPECS-INDEX #977 第 7 批(2026-10-07):「服務人員新增編輯訂單」開關生效 —— 第 2 支(服務人員專用 RPC)。
-- 規格書 .project/specs/服務人員新增編輯訂單-第7批.md 第三節 3-0、3-3、3-4、3-5。
-- 主腦 2026-10-07 決定:先照 A1(已完成訂單服務人員不能取消 / 還原);待裁決 B 由使用者裁決採 B2
-- (開關時段只給「可以自己下單」+ 按件計酬 + 排班自助權限的人,月薪制不能自己開關時段);料錢在服務人員模式不顯示、編輯保留原值(本檔的建單 / 改單 RPC 都**沒有**料錢參數)。
--
-- 共通規則(3-0):
--   ・SECURITY DEFINER + search_path public;revoke public, anon;grant authenticated(private helper 全部收回)。
--   ・第一步檢查身分(auth.uid() null ⇒「請先登入」42501)。
--   ・找不到訂單 / 別人的單 / 別家商家 / 開關沒開 ⇒ 一律同一句「沒有權限操作這筆訂單」(42501),不透露訂單存不存在。
--     協助人員(目前在職且已開通登入)給清楚原因「只有這筆訂單的主要服務人員可以…」(比照第 4 批 staff_confirm_booking)。
--   ・先不鎖列讀主要服務人員做權限判斷;通過後才交給既有函式(既有函式自己會鎖列 / 檢查狀態)。
--   ・寫入類:驗證 → set_config('miaoyue.staff_order_actor', 自己的 staff id, true) → 呼叫既有函式
--     → set_config(…, '', true) 清掉 → 回傳精簡結果。**一律不回傳整列 bookings**(會帶出內部備註等欄位)。
--   ・既有函式中途丟錯 ⇒ 整個交易回滾,交易內的標記也一起消失(set_config 第三個參數 true = 交易內有效)。
--
-- ⚠️ 本檔沒有任何資料寫入或刪除(只有 create function / grant / revoke)。

-- =========================================================================
-- 內部 helper:確認呼叫者是這張單的「可以自己下單的主要服務人員」,回傳這張單(只在函式內部用,不對外)。
-- =========================================================================
create or replace function private.staff_order_own_booking(p_booking_id uuid, p_action text)
returns public.bookings
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_booking public.bookings;
begin
  if v_uid is null then
    raise exception '請先登入' using errcode = '42501';
  end if;

  -- 先不鎖列(避免任何登入者都能對別人的訂單下 for update 造成排隊)。
  select * into v_booking from public.bookings b where b.id = p_booking_id;

  if v_booking.id is null
     or not exists (
       select 1 from public.merchant_staff ms
       where ms.id = v_booking.staff_id and ms.merchant_id = v_booking.merchant_id
     )
     or not private.staff_order_self_ok(v_booking.staff_id) then
    -- 協助人員看得到這張單(行事曆上標「協助」),給他一句看得懂的原因;
    -- 只限「目前在職且已開通登入」的協助人員,其他人一律落到下面同一句(不透露訂單存在)。
    if v_booking.id is not null and exists (
      select 1
      from public.booking_assistants ba
      join public.merchant_staff ms on ms.id = ba.staff_id
      where ba.booking_id = p_booking_id
        and ms.user_id = v_uid
        and ms.status = 'active'
        and ms.login_status = 'active'
    ) then
      raise exception '只有這筆訂單的主要服務人員可以%', p_action using errcode = '42501';
    end if;
    raise exception '沒有權限操作這筆訂單' using errcode = '42501';
  end if;

  return v_booking;
end;
$function$;

comment on function private.staff_order_own_booking(uuid, text) is 'SPECS-INDEX #977 第 7 批:staff_ 包裝 RPC 共用的身分檢查。呼叫者必須是這張單的主要服務人員本人且 staff_order_self_ok;協助人員給清楚原因,其餘一律「沒有權限操作這筆訂單」。只在函式內部用。';

revoke execute on function private.staff_order_own_booking(uuid, text) from public, anon, authenticated;

-- =========================================================================
-- 3-3 ① 建單 / 編輯畫面的選項(服務人員讀不到商家的服務項目 / 付款方式 / 稅金 / 營業時間表 ⇒ 改由這支提供)
-- =========================================================================
create or replace function public.staff_get_booking_form_options(p_staff_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_staff_name text;
  v_industry_type text;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if not private.staff_order_self_ok(p_staff_id) then
    raise exception '沒有權限新增或編輯預約' using errcode = '42501';
  end if;

  select ms.merchant_id, ms.name into v_merchant_id, v_staff_name
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  select m.industry_type into v_industry_type
  from public.merchants m
  where m.id = v_merchant_id;

  -- 不回傳任何客戶、會員、其他服務人員資料;料錢(主腦決定 C:服務人員模式不顯示)也不回。
  return jsonb_build_object(
    'staff_id', p_staff_id,
    'staff_name', v_staff_name,
    'industry_type', v_industry_type,
    'service_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', si.id,
        'name', si.name,
        'price', si.price,
        'duration_minutes', si.duration_minutes,
        'category_id', si.category_id
      ) order by si.created_at, si.id)
      from public.service_items si
      where si.merchant_id = v_merchant_id and si.status = 'active'
    ), '[]'::jsonb),
    'service_categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', sc.id, 'name', sc.name) order by sc.name, sc.id)
      from public.service_categories sc
      where sc.merchant_id = v_merchant_id
    ), '[]'::jsonb),
    'payment_methods', coalesce((
      select jsonb_agg(jsonb_build_object('id', pm.id, 'name', pm.name) order by pm.created_at, pm.id)
      from public.payment_methods pm
      where pm.merchant_id = v_merchant_id and pm.status = 'active'
    ), '[]'::jsonb),
    'tax_settings', (
      select jsonb_build_object('tax_mode', ts.tax_mode, 'tax_value', ts.tax_value)
      from public.merchant_tax_settings ts
      where ts.merchant_id = v_merchant_id
    ),
    'business_hours', coalesce((
      select jsonb_agg(jsonb_build_object('day_of_week', bh.day_of_week, 'is_closed', bh.is_closed)
                       order by bh.day_of_week)
      from public.merchant_business_hours bh
      where bh.merchant_id = v_merchant_id
    ), '[]'::jsonb)
  );
end;
$function$;

comment on function public.staff_get_booking_form_options(uuid) is 'SPECS-INDEX #977 第 7 批:服務人員(可以自己下單者)建單 / 編輯畫面的選項:上架服務項目、分類、上架付款方式、稅金設定、每週營業時間(只有是否公休)、產業別、自己的姓名。不含客戶 / 會員 / 其他服務人員 / 料錢。';

-- =========================================================================
-- 3-3 ② 編輯畫面要帶入的這張單現值(只限自己是主要服務人員、待確認 / 已確認)
-- =========================================================================
create or replace function public.staff_get_booking_for_edit(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_b public.bookings;
begin
  v_b := private.staff_order_own_booking(p_booking_id, '編輯這筆訂單');

  if v_b.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能編輯，請重新整理';
  end if;

  return jsonb_build_object(
    'id', v_b.id,
    'merchant_id', v_b.merchant_id,
    'staff_id', v_b.staff_id,
    'status', v_b.status,
    'start_at', v_b.start_at,
    'end_at', v_b.end_at,
    'customer_name', v_b.customer_name,
    'customer_phone', v_b.customer_phone,
    'customer_email', v_b.customer_email,
    'customer_address', v_b.customer_address,
    'customer_notes', v_b.customer_notes,
    -- 內部備註被設成「不讓服務人員看到」⇒ 不回原文,只回 notes_hidden(前端據此不顯示內部備註欄)。
    'notes', case when v_b.hide_notes_from_staff then null else v_b.notes end,
    'notes_hidden', v_b.hide_notes_from_staff,
    'custom_total_amount_enabled', v_b.custom_total_amount_enabled,
    'custom_total_amount', v_b.custom_total_amount,
    'discount_enabled', v_b.discount_enabled,
    'discount_mode', v_b.discount_mode,
    'discount_value', v_b.discount_value,
    'tax_enabled', v_b.tax_enabled,
    'tax_mode_snapshot', v_b.tax_mode_snapshot,
    'tax_value_snapshot', v_b.tax_value_snapshot,
    'payment_method_id', v_b.payment_method_id,
    'payment_method_name_snapshot', v_b.payment_method_name_snapshot,
    'custom_duration_enabled', v_b.custom_duration_enabled,
    'custom_duration_minutes', v_b.custom_duration_minutes,
    'member_id', v_b.member_id,
    'member_name_snapshot', v_b.member_name_snapshot,
    'points_planned', v_b.points_planned,
    'points_planned_auto', v_b.points_planned_auto,
    'points_planned_overridden', v_b.points_planned_overridden,
    'points_redeemed', v_b.points_redeemed,
    'points_redeem_amount_snapshot', v_b.points_redeem_amount_snapshot,
    'service_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'service_item_id', bsi.service_item_id,
        'name', coalesce(si.name, '(已刪除的服務項目)'),
        'quantity', bsi.quantity,
        'unit_price_snapshot', bsi.unit_price_snapshot
      ) order by bsi.id)
      from public.booking_service_items bsi
      left join public.service_items si on si.id = bsi.service_item_id
      where bsi.booking_id = v_b.id
    ), '[]'::jsonb),
    -- 協助人員只回姓名(唯讀顯示「由商家指派」),不回 id。
    'assistant_names', coalesce((
      select jsonb_agg(coalesce(ms.name, '(已刪除的人員)') order by ms.name)
      from public.booking_assistants ba
      left join public.merchant_staff ms on ms.id = ba.staff_id
      where ba.booking_id = v_b.id
    ), '[]'::jsonb)
  );
end;
$function$;

comment on function public.staff_get_booking_for_edit(uuid) is 'SPECS-INDEX #977 第 7 批:主要服務人員本人(可以自己下單者)編輯畫面要帶入的訂單現值。hide_notes_from_staff = true 時 notes 回 null + notes_hidden = true。協助人員只回姓名。料錢不回。';

-- =========================================================================
-- 3-3 ③ 可預約時間清單(包 list_staff_bookable_start_times)
-- =========================================================================
create or replace function public.staff_list_my_bookable_start_times(
  p_staff_id uuid,
  p_date date,
  p_duration_minutes integer,
  p_exclude_booking_id uuid default null
)
returns text[]
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_result text[];
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if not private.staff_order_self_ok(p_staff_id) then
    raise exception '沒有權限新增或編輯預約' using errcode = '42501';
  end if;
  if p_exclude_booking_id is not null and not exists (
    select 1 from public.bookings b
    where b.id = p_exclude_booking_id and b.staff_id = p_staff_id
  ) then
    raise exception '沒有權限操作這筆訂單' using errcode = '42501';
  end if;

  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;

  perform set_config('miaoyue.staff_order_actor', p_staff_id::text, true);
  v_result := public.list_staff_bookable_start_times(
    v_merchant_id, p_staff_id, p_date, p_duration_minutes, p_exclude_booking_id
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  return v_result;
end;
$function$;

comment on function public.staff_list_my_bookable_start_times(uuid, date, integer, uuid) is 'SPECS-INDEX #977 第 7 批:服務人員本人(可以自己下單者)查自己這天能約的起點。內部用交易內標記呼叫 list_staff_bookable_start_times,結果原樣回傳。';

-- =========================================================================
-- 3-3 ④ 紅利預覽(包 preview_booking_points;會員一律由後端決定,不接受前端傳)
-- =========================================================================
create or replace function public.staff_preview_booking_points(
  p_staff_id uuid,
  p_booking_id uuid,
  p_customer_phone text,
  p_service_items jsonb,
  p_custom_total_amount_enabled boolean,
  p_custom_total_amount numeric,
  p_discount_enabled boolean,
  p_discount_mode text,
  p_discount_value numeric,
  p_tax_enabled boolean,
  p_tax_mode text,
  p_tax_value numeric
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_member_id uuid;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  if not private.staff_order_self_ok(p_staff_id) then
    raise exception '沒有權限新增或編輯預約' using errcode = '42501';
  end if;

  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;

  -- 編輯模式:必須是自己主要的單;會員 = 這張單現有的會員(服務人員不能補掛 / 換會員)。新增模式:null。
  if p_booking_id is not null then
    select b.member_id into v_member_id
    from public.bookings b
    where b.id = p_booking_id and b.staff_id = p_staff_id and b.merchant_id = v_merchant_id;
    if not found then
      raise exception '沒有權限操作這筆訂單' using errcode = '42501';
    end if;
  end if;

  perform set_config('miaoyue.staff_order_actor', p_staff_id::text, true);
  v_result := public.preview_booking_points(
    v_merchant_id, p_booking_id, v_member_id, p_customer_phone, p_service_items,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  return v_result;
end;
$function$;

comment on function public.staff_preview_booking_points(uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) is 'SPECS-INDEX #977 第 7 批:服務人員本人建單 / 編輯畫面的紅利預覽。會員由後端決定(新增 = 依電話;編輯 = 這張單現有的會員)。已知:跟客服一樣,打任意電話可知道是不是會員與可折抵點數(前提是商家開了「顯示會員資料」)。';

-- =========================================================================
-- 3-4 ① 建單
-- =========================================================================
create or replace function public.staff_create_booking(
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamp with time zone,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
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
  p_points_override integer default null,
  p_points_redeemed integer default 0,
  p_points_redeem_member_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_b public.bookings;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  -- 主要服務人員固定是自己(裁決 3):p_staff_id 必須是登入者本人那一列,而且可以自己下單。
  if not private.staff_order_self_ok(p_staff_id) then
    raise exception '沒有權限新增預約' using errcode = '42501';
  end if;

  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;

  perform set_config('miaoyue.staff_order_actor', p_staff_id::text, true);
  -- 協助人員一律空陣列(裁決 4)、料錢一律空陣列(主腦決定 C)、會員一律 null(由 create_booking 依電話
  -- 自動連結 / 建立,跟後台新增模式一樣)、內部備註一律「服務人員看得到」。
  -- 狀態由 create_booking 既有的第 4 批邏輯決定(商家後台確認後直接接單 ⇒ accepted,否則 pending_confirmation)。
  v_b := public.create_booking(
    p_merchant_id => v_merchant_id,
    p_staff_id => p_staff_id,
    p_service_items => p_service_items,
    p_start_at => p_start_at,
    p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone,
    p_customer_email => p_customer_email,
    p_notes => p_notes,
    p_assistant_staff_ids => '{}'::uuid[],
    p_material_cost_item_ids => '{}'::uuid[],
    p_customer_address => p_customer_address,
    p_customer_notes => p_customer_notes,
    p_custom_total_amount_enabled => p_custom_total_amount_enabled,
    p_custom_total_amount => p_custom_total_amount,
    p_discount_enabled => p_discount_enabled,
    p_discount_mode => p_discount_mode,
    p_discount_value => p_discount_value,
    p_tax_enabled => p_tax_enabled,
    p_tax_mode => p_tax_mode,
    p_tax_value => p_tax_value,
    p_payment_method_id => p_payment_method_id,
    p_custom_duration_enabled => p_custom_duration_enabled,
    p_custom_duration_minutes => p_custom_duration_minutes,
    p_member_id => null,
    p_hide_notes_from_staff => false,
    p_points_override => p_points_override,
    p_points_redeemed => p_points_redeemed,
    p_points_redeem_member_id => p_points_redeem_member_id
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  -- 只回建單成功提示(buildBookingCreatedToast)需要的欄位,不回整列。
  return jsonb_build_object(
    'id', v_b.id,
    'merchant_id', v_b.merchant_id,
    'status', v_b.status,
    'member_id', v_b.member_id,
    'member_name_snapshot', v_b.member_name_snapshot,
    'member_auto_created', v_b.member_auto_created,
    'final_amount_snapshot', v_b.final_amount_snapshot,
    'points_planned', v_b.points_planned,
    'points_redeemed', v_b.points_redeemed,
    'points_redeem_amount_snapshot', v_b.points_redeem_amount_snapshot
  );
end;
$function$;

comment on function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid) is 'SPECS-INDEX #977 第 7 批:服務人員本人(可以自己下單者)建自己的單。沒有商家 / 其他服務人員 / 協助人員 / 會員 / 隱藏備註 / 料錢參數;內部呼叫 create_booking(created_by_role = staff)。只回傳成功提示需要的欄位。';

-- =========================================================================
-- 3-4 ② 編輯(主要服務人員不能換、協助人員 / 會員 / 隱藏備註 / 料錢一律保留現值)
-- =========================================================================
create or replace function public.staff_update_booking(
  p_booking_id uuid,
  p_service_items jsonb,
  p_start_at timestamp with time zone,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
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
  p_points_override integer default null,
  p_points_redeemed integer default null,
  p_points_override_reset boolean default false,
  p_points_redeem_member_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner public.bookings;
  v_cur public.bookings;
  v_assistants uuid[];
  v_materials uuid[];
  v_b public.bookings;
begin
  v_owner := private.staff_order_own_booking(p_booking_id, '編輯這筆訂單');

  -- 已確認是自己的單 ⇒ 鎖自己的單,防「客服同時改了協助人員 / 換了主要服務人員」。
  select * into v_cur
  from public.bookings b
  where b.id = p_booking_id and b.staff_id = v_owner.staff_id
  for update;
  if not found then
    raise exception '這筆訂單的服務人員已變更，請重新整理' using errcode = '42501';
  end if;

  -- 裁決 4:既有協助人員原樣保留(不接受前端傳)。
  select coalesce(array_agg(ba.staff_id order by ba.staff_id), '{}'::uuid[]) into v_assistants
  from public.booking_assistants ba
  where ba.booking_id = p_booking_id;

  -- 主腦決定 C:料錢保留原值(update_booking 對既有品項沿用原本的金額快照)。
  select coalesce(array_agg(bmc.material_cost_item_id order by bmc.material_cost_item_id), '{}'::uuid[])
  into v_materials
  from public.booking_material_costs bmc
  where bmc.booking_id = p_booking_id;

  perform set_config('miaoyue.staff_order_actor', v_cur.staff_id::text, true);
  v_b := public.update_booking(
    p_booking_id => p_booking_id,
    p_staff_id => v_cur.staff_id,
    p_service_items => p_service_items,
    p_start_at => p_start_at,
    p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone,
    p_customer_email => p_customer_email,
    -- 內部備註被藏起來時,服務人員看不到原文,前端送什麼都不採用 ⇒ 用現值(不然會被清空)。
    p_notes => case when v_cur.hide_notes_from_staff then v_cur.notes else p_notes end,
    p_assistant_staff_ids => v_assistants,
    p_material_cost_item_ids => v_materials,
    p_customer_address => p_customer_address,
    p_customer_notes => p_customer_notes,
    p_custom_total_amount_enabled => p_custom_total_amount_enabled,
    p_custom_total_amount => p_custom_total_amount,
    p_discount_enabled => p_discount_enabled,
    p_discount_mode => p_discount_mode,
    p_discount_value => p_discount_value,
    p_tax_enabled => p_tax_enabled,
    p_tax_mode => p_tax_mode,
    p_tax_value => p_tax_value,
    p_payment_method_id => p_payment_method_id,
    p_custom_duration_enabled => p_custom_duration_enabled,
    p_custom_duration_minutes => p_custom_duration_minutes,
    -- 會員維持現值(服務人員不能補掛 / 換會員);隱藏備註旗標維持現值。
    p_member_id => v_cur.member_id,
    p_hide_notes_from_staff => v_cur.hide_notes_from_staff,
    p_points_override => p_points_override,
    p_points_redeemed => p_points_redeemed,
    p_points_override_reset => p_points_override_reset,
    p_points_redeem_member_id => p_points_redeem_member_id
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  return jsonb_build_object(
    'id', v_b.id,
    'merchant_id', v_b.merchant_id,
    'status', v_b.status,
    'start_at', v_b.start_at,
    'staff_id', v_b.staff_id
  );
end;
$function$;

comment on function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid) is 'SPECS-INDEX #977 第 7 批:主要服務人員本人(可以自己下單者)編輯自己的單。主要服務人員、協助人員、會員、隱藏備註旗標、料錢一律保留現值;內部備註被藏起來時保留原文。內部呼叫 update_booking。';

-- =========================================================================
-- 3-4 ③ 取消 / ④ 標記完成
-- =========================================================================
create or replace function public.staff_cancel_booking(p_booking_id uuid, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner public.bookings;
  v_b public.bookings;
begin
  v_owner := private.staff_order_own_booking(p_booking_id, '取消這筆訂單');

  perform set_config('miaoyue.staff_order_actor', v_owner.staff_id::text, true);
  v_b := public.cancel_booking(p_booking_id, p_reason);
  perform set_config('miaoyue.staff_order_actor', '', true);

  return jsonb_build_object('id', v_b.id, 'merchant_id', v_b.merchant_id, 'status', v_b.status);
end;
$function$;

comment on function public.staff_cancel_booking(uuid, text) is 'SPECS-INDEX #977 第 7 批:主要服務人員本人(可以自己下單者)取消自己的單(只限待確認 / 已確認,狀態由 cancel_booking 檢查)。回傳 {id, merchant_id, status}。';

create or replace function public.staff_complete_booking(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner public.bookings;
  v_b public.bookings;
begin
  v_owner := private.staff_order_own_booking(p_booking_id, '標記完成');

  perform set_config('miaoyue.staff_order_actor', v_owner.staff_id::text, true);
  v_b := public.complete_booking(p_booking_id);
  perform set_config('miaoyue.staff_order_actor', '', true);

  return jsonb_build_object('id', v_b.id, 'merchant_id', v_b.merchant_id, 'status', v_b.status);
end;
$function$;

comment on function public.staff_complete_booking(uuid) is 'SPECS-INDEX #977 第 7 批:主要服務人員本人(可以自己下單者)把自己已確認的單標記完成(狀態由 complete_booking 檢查)。回傳 {id, merchant_id, status}。';

-- =========================================================================
-- 3-4 ⑤ 拖拉改時間(只改時間、不能轉派:被拖的 / 目標 / 預期服務人員都固定是自己)
-- =========================================================================
create or replace function public.staff_move_booking(
  p_booking_id uuid,
  p_target_start_at timestamp with time zone,
  p_expected_start_at timestamp with time zone
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_owner public.bookings;
  v_result jsonb;
begin
  v_owner := private.staff_order_own_booking(p_booking_id, '移動這筆訂單');

  perform set_config('miaoyue.staff_order_actor', v_owner.staff_id::text, true);
  v_result := public.move_booking(
    p_booking_id, v_owner.staff_id, v_owner.staff_id, p_target_start_at, p_expected_start_at, v_owner.staff_id
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  -- 不把 move_booking 回傳的整列 booking 原樣丟出去:booking 只留 id / merchant_id。
  return jsonb_build_object(
    'mode', v_result -> 'mode',
    'booking', jsonb_build_object(
      'id', v_result -> 'booking' -> 'id',
      'merchant_id', v_result -> 'booking' -> 'merchant_id'
    ),
    'previous', jsonb_build_object(
      'start_at', v_result -> 'previous' -> 'start_at',
      'end_at', v_result -> 'previous' -> 'end_at',
      'staff_id', v_result -> 'previous' -> 'staff_id'
    ),
    'next', jsonb_build_object(
      'start_at', v_result -> 'next' -> 'start_at',
      'end_at', v_result -> 'next' -> 'end_at',
      'staff_id', v_result -> 'next' -> 'staff_id'
    ),
    'time_changed', v_result -> 'time_changed',
    'staff_changed', v_result -> 'staff_changed'
  );
end;
$function$;

comment on function public.staff_move_booking(uuid, timestamptz, timestamptz) is 'SPECS-INDEX #977 第 7 批:主要服務人員本人(可以自己下單者)拖拉自己的單改時間(只改時間、不能轉派)。p_expected_start_at 跟現況不符 ⇒ move_booking 回 40001。回傳不含整列 booking。';

-- =========================================================================
-- 3-4 ⑥ 開關自己的時段(方案 B2)。商家端選單只用 set,所以不另做 clear。
--   B2 的條件 = staff_order_self_ok + can_self_manage_availability;後者本來就是 set_staff_day_override
--   既有的放行條件 ⇒ 這裡先用 staff_slot_toggle_ok 擋(給一致的錯誤訊息),通過後**直接**呼叫既有函式,
--   不需要交易內標記,set_staff_day_override 也不用改。
-- =========================================================================
create or replace function public.staff_set_my_slot(
  p_staff_id uuid,
  p_date date,
  p_start_time time without time zone,
  p_end_time time without time zone,
  p_is_available boolean
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_conflicts integer;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  -- 只能開關自己的時段(裁決 3):p_staff_id 必須是登入者本人那一列、可以自己下單,
  -- 而且(方案 B2)是按件計酬 + 有排班自助權限。月薪制一律擋。
  if not private.staff_slot_toggle_ok(p_staff_id) then
    raise exception '沒有權限設定這位服務人員的可預約狀態' using errcode = '42501';
  end if;

  v_conflicts := public.set_staff_day_override(p_staff_id, p_date, p_start_time, p_end_time, p_is_available);

  return v_conflicts;
end;
$function$;

comment on function public.staff_set_my_slot(uuid, date, time, time, boolean) is 'SPECS-INDEX #977 第 7 批(方案 B2):服務人員本人(可以自己下單 + 按件計酬 + 排班自助權限)開 / 關自己某一段時間(單日例外),回傳衝突的既有預約筆數(只提示不擋)。';

-- =========================================================================
-- 3-5 通知權限(line-notify-dispatch / push-notify-dispatch 原本的檢查不通過時才會再問這支)
-- =========================================================================
create or replace function public.can_staff_dispatch_booking_notification(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_event_type text
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_staff_id uuid;
  v_status text;
begin
  if auth.uid() is null or p_booking_id is null or p_merchant_id is null then
    return false;
  end if;

  select b.staff_id, b.status into v_staff_id, v_status
  from public.bookings b
  where b.id = p_booking_id and b.merchant_id = p_merchant_id;
  if not found then
    return false;
  end if;

  -- 呼叫者必須是這張單的主要服務人員本人、可以自己下單、服務人員紀錄屬於這間商家。
  if not private.staff_order_self_ok(v_staff_id)
     or not exists (
       select 1 from public.merchant_staff ms
       where ms.id = v_staff_id and ms.merchant_id = p_merchant_id
     ) then
    return false;
  end if;

  -- 事件要跟訂單現況相符(降低重複觸發)。
  return case p_event_type
    when 'booking_created' then v_status <> 'cancelled'
    when 'booking_updated' then v_status <> 'cancelled'
    when 'booking_cancelled' then v_status = 'cancelled'
    when 'booking_completed' then v_status = 'completed'
    else false
  end;
end;
$function$;

comment on function public.can_staff_dispatch_booking_notification(uuid, uuid, text) is 'SPECS-INDEX #977 第 7 批:Edge Function(line-notify-dispatch / push-notify-dispatch)用呼叫者身分問的第二道放行:呼叫者是這張單的主要服務人員本人且可以自己下單,而且事件符合訂單現況。其他一律 false。';

-- =========================================================================
-- ACL(supabase-permission-hygiene 規則 1):服務人員端前端 / Edge Function 要呼叫的,留 authenticated。
-- =========================================================================
revoke execute on function public.staff_get_booking_form_options(uuid) from public, anon;
grant execute on function public.staff_get_booking_form_options(uuid) to authenticated, service_role;

revoke execute on function public.staff_get_booking_for_edit(uuid) from public, anon;
grant execute on function public.staff_get_booking_for_edit(uuid) to authenticated, service_role;

revoke execute on function public.staff_list_my_bookable_start_times(uuid, date, integer, uuid) from public, anon;
grant execute on function public.staff_list_my_bookable_start_times(uuid, date, integer, uuid) to authenticated, service_role;

revoke execute on function public.staff_preview_booking_points(uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) from public, anon;
grant execute on function public.staff_preview_booking_points(uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) to authenticated, service_role;

revoke execute on function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid) from public, anon;
grant execute on function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid) to authenticated, service_role;

revoke execute on function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid) from public, anon;
grant execute on function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid) to authenticated, service_role;

revoke execute on function public.staff_cancel_booking(uuid, text) from public, anon;
grant execute on function public.staff_cancel_booking(uuid, text) to authenticated, service_role;

revoke execute on function public.staff_complete_booking(uuid) from public, anon;
grant execute on function public.staff_complete_booking(uuid) to authenticated, service_role;

revoke execute on function public.staff_move_booking(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.staff_move_booking(uuid, timestamptz, timestamptz) to authenticated, service_role;

revoke execute on function public.staff_set_my_slot(uuid, date, time, time, boolean) from public, anon;
grant execute on function public.staff_set_my_slot(uuid, date, time, time, boolean) to authenticated, service_role;

revoke execute on function public.can_staff_dispatch_booking_notification(uuid, uuid, text) from public, anon;
grant execute on function public.can_staff_dispatch_booking_notification(uuid, uuid, text) to authenticated, service_role;
