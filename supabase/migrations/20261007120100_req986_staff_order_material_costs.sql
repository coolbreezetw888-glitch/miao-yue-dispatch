-- SPECS-INDEX #986 第 9 批(2026-10-07,使用者裁決「7批-C 推翻:服務人員建單 / 編輯要看得到、改得了料錢」、
-- 服務項目描述、服務人員端拖拉間隔)。規格:.project/specs/使用者裁決小項與第7批調整-第9批.md 3-1、3-3、3-4。
--
-- 重建 4 支服務人員包裝 RPC。底稿 = 本機套完全部 migration(含第 8 批 20261007110200)後的
-- pg_get_functiondef,逐字保留;新增段落包在「[req986-batch9 begin] … [req986-batch9 end]」之間,
-- 另外只改了幾行註解 / 一個參數值(pgTAP req986_01 把段落拿掉、這幾行換回原文後,指紋必須等於改前)。
--   改前指紋(md5(replace(prosrc, E'\r\n', E'\n'))):
--     staff_get_booking_form_options  8d8cfd4b0a2f4f079c0f406ccfe087ae
--     staff_get_booking_for_edit      c1b32819db641ed937acceb8f0b81020
--     staff_create_booking            e919014463059cc4e992346f8e22bef8
--     staff_update_booking            e0e56ecfb266aac0f4ceb1cc411b54ad
--
-- ① staff_get_booking_form_options:多回 material_cost_enabled、material_cost_items(總開關開著才有,
--    本店上架品項 id / name / amount)、start_time_interval_minutes(5 / 10 / 15 / 30,其餘 ⇒ 30)、
--    服務項目每筆多 description。仍然不回任何客戶 / 會員 / 其他服務人員資料。
-- ② staff_get_booking_for_edit:多回 material_costs(這張單目前的料錢,含已下架品項 is_active = false)。
-- ③ staff_create_booking / staff_update_booking:新增最後一個參數 p_material_cost_item_ids uuid[] default null。
--    改參數清單 ⇒ 先 drop 舊簽章再 create(只用 create or replace 會多出一支同名 overload,
--    PostgREST 會報「無法選擇函式」)。drop / create / revoke / grant / comment 都在這一支 migration 裡,不留空窗。
--    舊前端不帶新參數:建單 = 不帶料錢、改單 = 維持原料錢,跟第 7 批一樣。
--    料錢檢查全部沿用 create_booking / update_booking → private.validate_booking_selection(不寫第二套)。
-- 抽成計算(calculate_booking_staff_commission / compute_booking_commission / recalculate_booking_commission /
-- complete_booking)一行都不動;料錢是否影響抽成照第 8 批「料錢影響服務人員抽成」開關。

-- =========================================================================
-- ① staff_get_booking_form_options
-- =========================================================================
CREATE OR REPLACE FUNCTION public.staff_get_booking_form_options(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_staff_name text;
  v_industry_type text;
  -- [req986-batch9 begin] #986 第 9 批:料錢總開關、建單時間間隔。
  v_material_enabled boolean;
  v_start_interval integer;
  -- [req986-batch9 end]
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

  -- [req986-batch9 begin] #986 第 9 批(9-1、9-2、9-11):
  --   ・料錢成本總開關(merchant_feature_flags.material_cost_enabled,查無 = false)。
  --   ・建單時間間隔(merchant_booking_settings;查無或不在 5 / 10 / 15 / 30 之內 ⇒ 30)。
  --     服務人員讀不到 merchant_booking_settings 的 RLS,不放寬,用這支 RPC 給。
  select coalesce(bool_or(ff.enabled), false) into v_material_enabled
  from public.merchant_feature_flags ff
  where ff.merchant_id = v_merchant_id and ff.feature_key = 'material_cost_enabled';

  select mbs.start_time_interval_minutes into v_start_interval
  from public.merchant_booking_settings mbs
  where mbs.merchant_id = v_merchant_id;
  if v_start_interval is null or v_start_interval not in (5, 10, 15, 30) then
    v_start_interval := 30;
  end if;
  -- [req986-batch9 end]
  -- 不回傳任何客戶、會員、其他服務人員資料。料錢:#986 第 9 批推翻主腦決定 C,總開關開著才回本店上架品項(名稱、金額)。
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
        -- [req986-batch9 begin] #986 第 9 批(9-9):服務項目描述(建單「選擇項目」整頁顯示)。
        , 'description', si.description
        -- [req986-batch9 end]
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
    -- [req986-batch9 begin] #986 第 9 批:料錢(9-1、9-2)與建單時間間隔(9-11)。
    , 'material_cost_enabled', v_material_enabled
    , 'material_cost_items', case when v_material_enabled then coalesce((
        select jsonb_agg(jsonb_build_object('id', mci.id, 'name', mci.name, 'amount', mci.amount)
                         order by mci.created_at, mci.id)
        from public.material_cost_items mci
        where mci.merchant_id = v_merchant_id and mci.status = 'active'
      ), '[]'::jsonb) else '[]'::jsonb end
    , 'start_time_interval_minutes', v_start_interval
    -- [req986-batch9 end]
  );
end;
$function$;

comment on function public.staff_get_booking_form_options(uuid) is 'SPECS-INDEX #977 第 7 批 / #986 第 9 批:服務人員(可以自己下單者)建單 / 編輯畫面的選項:上架服務項目(含描述)、分類、上架付款方式、稅金設定、每週營業時間(只有是否公休)、產業別、自己的姓名、料錢成本總開關與本店上架料錢品項(開關關著 ⇒ 空陣列)、建單時間間隔(5 / 10 / 15 / 30,其餘 ⇒ 30)。不含客戶 / 會員 / 其他服務人員。';

revoke execute on function public.staff_get_booking_form_options(uuid) from public, anon;
grant execute on function public.staff_get_booking_form_options(uuid) to authenticated, service_role;

-- =========================================================================
-- ② staff_get_booking_for_edit
-- =========================================================================
CREATE OR REPLACE FUNCTION public.staff_get_booking_for_edit(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- [req986-batch9 begin] #986 第 9 批(9-2):這張單目前的料錢。name 取品項目前名稱(已刪除 ⇒ 固定字);
    --   is_active = 品項仍上架。金額一律回訂單上的快照 amount_snapshot。
    , 'material_costs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'material_cost_item_id', bmc.material_cost_item_id,
        'name', coalesce(mci.name, '(已刪除的料錢品項)'),
        'amount_snapshot', bmc.amount_snapshot,
        'is_active', coalesce(mci.status = 'active', false)
      ) order by bmc.created_at, bmc.id)
      from public.booking_material_costs bmc
      left join public.material_cost_items mci on mci.id = bmc.material_cost_item_id
      where bmc.booking_id = v_b.id
    ), '[]'::jsonb)
    -- [req986-batch9 end]
  );
end;
$function$;

comment on function public.staff_get_booking_for_edit(uuid) is 'SPECS-INDEX #977 第 7 批 / #986 第 9 批:主要服務人員本人(可以自己下單者)編輯畫面要帶入的訂單現值。hide_notes_from_staff = true 時 notes 回 null + notes_hidden = true。協助人員只回姓名。料錢回 material_costs(品項 id、目前名稱、訂單金額快照、是否仍上架)。';

revoke execute on function public.staff_get_booking_for_edit(uuid) from public, anon;
grant execute on function public.staff_get_booking_for_edit(uuid) to authenticated, service_role;

-- =========================================================================
-- ③ staff_create_booking(drop 舊簽章 + create 新簽章)
-- =========================================================================
drop function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid);

CREATE OR REPLACE FUNCTION public.staff_create_booking(p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT 0, p_points_redeem_member_id uuid DEFAULT NULL::uuid, p_material_cost_item_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 協助人員一律空陣列(裁決 4)、料錢用前端傳的值(#986 第 9 批;null = 不帶)、會員一律 null(由 create_booking 依電話
  -- 自動連結 / 建立,跟後台新增模式一樣)、內部備註一律「服務人員看得到」。
  -- 狀態由 create_booking 既有的第 4 批邏輯決定(商家後台確認後直接接單 ⇒ accepted,否則 pending_confirmation)。
  -- [req986-batch9 begin] #986 第 9 批(9-1):料錢品項是否屬於這間商家、是否上架、總開關是否開著、不可重複,
  --   全部交給 create_booking → private.validate_booking_selection 既有檢查(不寫第二套)。
  -- [req986-batch9 end]
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
    p_material_cost_item_ids => coalesce(p_material_cost_item_ids, '{}'::uuid[]),
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

comment on function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, uuid[]) is 'SPECS-INDEX #977 第 7 批 / #986 第 9 批:服務人員本人(可以自己下單者)建自己的單。沒有商家 / 其他服務人員 / 協助人員 / 會員 / 隱藏備註參數;料錢 p_material_cost_item_ids(null = 不帶),檢查沿用 validate_booking_selection。內部呼叫 create_booking(created_by_role = staff)。只回傳成功提示需要的欄位。';

revoke execute on function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, uuid[]) from public, anon;
grant execute on function public.staff_create_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, uuid[]) to authenticated, service_role;

-- =========================================================================
-- ③ staff_update_booking(drop 舊簽章 + create 新簽章)
-- =========================================================================
drop function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid);

CREATE OR REPLACE FUNCTION public.staff_update_booking(p_booking_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT NULL::integer, p_points_override_reset boolean DEFAULT false, p_points_redeem_member_id uuid DEFAULT NULL::uuid, p_material_cost_item_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- [req986-batch9 begin] #986 第 9 批(9-2):前端有帶料錢(非 null;空陣列 = 全部拿掉)⇒ 用前端的值;
  --   null ⇒ 維持這張單現有料錢(= 第 7 批行為,舊前端照樣可用)。
  --   檢查全部交給 update_booking → private.validate_booking_selection(第 8 批:這張單原本就有的品項
  --   不被下架 / 總開關擋,新加的照舊檢查)。不寫第二套。
  if p_material_cost_item_ids is not null then
    v_materials := p_material_cost_item_ids;
  end if;
  -- [req986-batch9 end]
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

comment on function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, uuid[]) is 'SPECS-INDEX #977 第 7 批 / #986 第 9 批:主要服務人員本人(可以自己下單者)編輯自己的單。主要服務人員、協助人員、會員、隱藏備註旗標一律保留現值;內部備註被藏起來時保留原文。料錢 p_material_cost_item_ids:null = 維持現有料錢,非 null(含空陣列)= 用前端的值,檢查沿用 validate_booking_selection。內部呼叫 update_booking。';

revoke execute on function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, uuid[]) from public, anon;
grant execute on function public.staff_update_booking(uuid, jsonb, timestamptz, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, uuid[]) to authenticated, service_role;
