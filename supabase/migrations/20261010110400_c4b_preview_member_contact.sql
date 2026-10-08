-- 客戶端第 4-B 批(模組 13)— migration 5:主腦裁決(風險 2,方案 ①)
-- preview_booking_points:新增模式 / 編輯改電話時,電話不是任何會員電話、但是某位會員的第二聯絡人電話
--   ⇒ member.resolution = 'member_contact',帶 member_id、name(不帶 balance;紅利照「沒有會員」算、不開放折抵),
--   讓建單表單提示「請在上方選擇這位會員」。送出仍由 create_member 擋下(Q2 = A)。
-- 不改:resolve_booking_member_by_phone、resolve_edit_booking_member、create_booking、update_booking、
--   staff_preview_booking_points(只是轉呼叫;服務人員拿到的 member_id / name 跟既有 existing 同層級)。
-- 其餘逐字不變(由目前資料庫定義只改三處);權限 / 錯誤訊息不變。

-- ─── public.preview_booking_points ───
CREATE OR REPLACE FUNCTION public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_s public.merchant_member_settings;
  v_booking_member_id uuid;
  v_booking_merchant_id uuid;
  v_resolution text;
  v_member_id uuid;
  v_member_name text;
  v_balance integer;
  v_match_count int;
  v_matched_id uuid;
  v_elem jsonb;
  v_subtotal numeric := 0;
  v_qty int;
  v_unit_price numeric;
  v_item_count int;
  v_found_count int;
  v_amount record;
  v_points record;
  v_rules_configured boolean;
  v_available integer := 0;
  v_frozen integer := 0;
  v_redeem_enabled boolean;
  -- 用純量變數而不是 record:record 沒被賦值時,就算 CASE 走不到那一支,
  -- 引用 v_limits.max_points 也會報「record is not assigned yet」(故障注入時抓到)。
  v_max_points integer := 0;
  v_max_amount numeric := 0;
  v_cap_amount numeric := 0;
  -- SPECS-INDEX #939(第 11 批 A):編輯已連結會員的單、而且改了電話。
  v_phone_changed boolean := false;
begin
  -- 1. 權限:跟建單同一把鑰匙(orders)。p_merchant_id 只拿來「問呼叫者對這間店有沒有權限」,
  --    之後每一筆查詢都硬性帶 merchant_id,不信任呼叫端給的任何其他 id。
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查看這間商家的紅利點數預覽' using errcode = '42501';
  end if;

  -- 編輯模式:訂單必須屬於這間商家。「不存在」跟「別家的」回同一個錯誤,不洩漏存不存在。
  if p_booking_id is not null then
    select b.merchant_id, b.member_id into v_booking_merchant_id, v_booking_member_id
    from public.bookings b
    where b.id = p_booking_id;

    if not found or v_booking_merchant_id is distinct from p_merchant_id then
      raise exception '找不到這筆預約，或沒有權限查看' using errcode = '42501';
    end if;
  end if;

  -- 2. 功能關閉 ⇒ 只回一個鍵,不洩漏任何設定或會員資訊。
  v_s := private.merchant_member_settings_effective(p_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    return jsonb_build_object('feature_enabled', false);
  end if;

  -- 3. 決定會員(member.resolution)。
  -- SPECS-INDEX #939(第 11 批 A):編輯模式**先**問 private.resolve_edit_booking_member
  --   (update_booking 呼叫的是同一支 ⇒「預覽對到誰 = 送出後掛誰」)。這張單原本有會員、而且電話
  --   正規化後跟原本不同 ⇒ 依新電話決定會員(忽略 p_member_id):格式還沒填完 ⇒ phone_incomplete;
  --   1 位 ⇒ existing(就是他);0 位 ⇒ new(儲存時會自動建立);≥ 2 位 ⇒ ambiguous。
  --   沒觸發才走下面原本的 p_member_id 分支(含補掛、已下架的原會員)。
  --   helper 的商家取自訂單本身;上面已確認訂單屬於 p_merchant_id,不能拿別家的單探測會員。
  if p_booking_id is not null then
    select r.phone_changed, r.match_count, r.member_id
    into v_phone_changed, v_match_count, v_matched_id
    from private.resolve_edit_booking_member(p_booking_id, p_customer_phone) r;
    v_phone_changed := coalesce(v_phone_changed, false);
  end if;

  if v_phone_changed then
    if not private.is_valid_taiwan_phone(p_customer_phone) then
      v_resolution := 'phone_incomplete';
    elsif v_match_count = 1 then
      select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
      from public.members m
      where m.id = v_matched_id
        and m.merchant_id = p_merchant_id;
      v_resolution := 'existing';
    elsif v_match_count = 0 then
      v_member_id := private.member_id_by_contact_phone(p_merchant_id, private.normalize_phone(p_customer_phone));
      if v_member_id is not null then
        select m.name into v_member_name from public.members m where m.id = v_member_id and m.merchant_id = p_merchant_id;
        v_resolution := 'member_contact';
      else
        v_resolution := 'new';
      end if;
    else
      v_resolution := 'ambiguous';
    end if;
  elsif p_member_id is not null then
    select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
    from public.members m
    where m.id = p_member_id
      and m.merchant_id = p_merchant_id
      and m.status = 'active';
    if found then
      v_resolution := 'given';
    else
      -- 別家的、已下架的、亂填的 ⇒ 當成沒有會員,不報錯、不洩漏存不存在(#917 IDOR 要求)。
      v_resolution := 'none';
      v_member_id := null;
      v_member_name := null;
      v_balance := null;
    end if;
  elsif p_booking_id is null then
    -- 新增模式:由伺服器依電話找會員,跟 create_booking 用同一支 helper。
    if not private.is_valid_taiwan_phone(p_customer_phone) then
      v_resolution := 'phone_incomplete';
    else
      select r.match_count, r.member_id into v_match_count, v_matched_id
      from private.resolve_booking_member_by_phone(p_merchant_id, p_customer_phone) r;

      if v_match_count = 1 then
        select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
        from public.members m
        where m.id = v_matched_id
          and m.merchant_id = p_merchant_id;
        v_resolution := 'existing';
      elsif v_match_count = 0 then
        v_member_id := private.member_id_by_contact_phone(p_merchant_id, private.normalize_phone(p_customer_phone));
        if v_member_id is not null then
          select m.name into v_member_name from public.members m where m.id = v_member_id and m.merchant_id = p_merchant_id;
          v_resolution := 'member_contact';
        else
          v_resolution := 'new';
        end if;
      else
        v_resolution := 'ambiguous';  -- #931 之後不會發生;當成沒有會員
      end if;
    end if;
  else
    -- 編輯模式且沒給會員 ⇒ 舊的訪客單、沒有補掛(編輯模式後端不依電話比對,§12.7)。
    v_resolution := 'none';
  end if;

  v_rules_configured := case
    when coalesce(v_s.earn_mode, 'basic') = 'advanced' then
      exists (select 1 from public.merchant_point_formulas f where f.merchant_id = p_merchant_id and f.enabled)
    else coalesce(v_s.basic_points_per_order, 0) > 0
  end;

  -- 4./5. 算應付金額 + 呼叫引擎。客服還在填表時(沒選服務項目、格式不對、折扣超過小計…)
  --       回 {"feature_enabled": true, "error": "…"},不要讓前端一直噴 500。
  begin
    if p_service_items is null or jsonb_typeof(p_service_items) <> 'array'
       or jsonb_array_length(p_service_items) = 0 then
      raise exception '請至少選擇一個服務項目';
    end if;

    v_item_count := jsonb_array_length(p_service_items);
    for v_elem in select value from jsonb_array_elements(p_service_items) loop
      if v_elem ->> 'service_item_id' is null then
        raise exception '每個服務項目都必須指定 service_item_id';
      end if;
      v_qty := (v_elem ->> 'quantity')::int;
      if v_qty is null or v_qty < 1 then
        raise exception '服務項目數量必須至少為 1';
      end if;
      v_unit_price := (v_elem ->> 'unit_price')::numeric;
      if v_unit_price is null or v_unit_price < 0 then
        raise exception '請提供每個服務項目的單價，且不能是負數';
      end if;
      -- 跟 validate_booking_selection 的 items_subtotal 同一個算式。
      v_subtotal := v_subtotal + (v_unit_price * v_qty);
    end loop;

    -- 服務項目必須屬於這間商家(不限上架:編輯舊單時可能含已下架項目)。
    select count(*) into v_found_count
    from jsonb_array_elements(p_service_items) as elem
    join public.service_items si
      on si.id = (elem ->> 'service_item_id')::uuid
     and si.merchant_id = p_merchant_id;
    if v_found_count <> v_item_count then
      raise exception '找不到其中一個服務項目';
    end if;

    select * into v_amount from private.calculate_booking_amount(
      v_subtotal,
      p_custom_total_amount_enabled, p_custom_total_amount,
      p_discount_enabled, p_discount_mode, p_discount_value,
      p_tax_enabled, p_tax_mode, p_tax_value
    );

    select * into v_points from private.compute_booking_planned_points(
      p_merchant_id,
      case when v_resolution in ('given', 'existing') then v_member_id else null end,
      p_service_items,
      v_amount.final_amount,
      p_custom_total_amount_enabled,
      p_discount_enabled,
      v_resolution = 'new'
    );
  exception
    when others then
      return jsonb_build_object('feature_enabled', true, 'error', sqlerrm);
  end;

  -- 6. 折抵上限(§2.10)。只有 existing / given 開放('new' 餘額一定是 0)。
  if v_resolution in ('given', 'existing') then
    v_available := coalesce(v_balance, 0);
    -- §〇.4 判斷 22:編輯同一張單、會員也是這張單的會員時,加回本單目前有效凍結
    -- (= −Σ redeem_booking/redeem_booking_refund 的 points_delta,§1.5 淨額定義)。
    if p_booking_id is not null and v_booking_member_id = v_member_id then
      select coalesce(-sum(t.points_delta), 0)::int into v_frozen
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.member_id = v_member_id
        and t.transaction_type in ('redeem_booking', 'redeem_booking_refund');
      v_available := v_available + greatest(v_frozen, 0);
    end if;
  end if;

  v_redeem_enabled := v_resolution in ('given', 'existing')
    and coalesce(v_s.redeem_points_unit, 0) > 0
    and coalesce(v_s.redeem_amount_unit, 0) > 0
    and coalesce(v_s.redeem_max_ratio_percent, 0) > 0;

  if v_redeem_enabled then
    select l.max_points, l.max_amount, l.cap_amount into v_max_points, v_max_amount, v_cap_amount
    from private.compute_booking_redeem_limits(
      v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
      v_amount.final_amount, v_available
    ) l;
  end if;

  -- 7. 回傳。member_id / name / balance 只在 existing / given 時有值。
  return jsonb_build_object(
    'feature_enabled', true,
    'member', jsonb_build_object(
      'resolution', v_resolution,
      'member_id', case when v_resolution in ('existing', 'given', 'member_contact') then v_member_id end,
      'name', case when v_resolution in ('existing', 'given', 'member_contact') then v_member_name end,
      'balance', case when v_resolution in ('existing', 'given') then v_balance end
    ),
    'rules_configured', v_rules_configured,
    'earn_mode', coalesce(v_s.earn_mode, 'basic'),
    'auto_points', v_points.auto_points,
    'review_required', v_points.review_required,
    'eligible', v_points.eligible,
    'ineligible_reason', v_points.ineligible_reason,
    -- 批次 7:只在「因為核發資格條件拿不到點」時才告訴前端是哪一種條件(文案「需 {條件}」用),
    -- 其餘情況一律 null,不多洩漏商家設定。
    'reward_condition_mode', case when v_points.ineligible_reason = 'reward_condition'
                                  then v_s.reward_condition_mode end,
    'breakdown', v_points.breakdown,
    'redeem', jsonb_build_object(
      'enabled', v_redeem_enabled,
      'points_unit', case when v_redeem_enabled then v_s.redeem_points_unit end,
      'amount_unit', case when v_redeem_enabled then v_s.redeem_amount_unit end,
      'max_ratio_percent', case when v_redeem_enabled then v_s.redeem_max_ratio_percent end,
      'payable', v_amount.final_amount,
      'available_points', v_available,
      'max_points', v_max_points,
      -- v2.4 裁決 10:max_amount = max_points 實際可折金額(畫面「最多可折 NT$X」直接用它);
      -- 比例上限另給 cap_amount。
      'max_amount', v_max_amount,
      'cap_amount', v_cap_amount
    )
  );
end;
$function$;
