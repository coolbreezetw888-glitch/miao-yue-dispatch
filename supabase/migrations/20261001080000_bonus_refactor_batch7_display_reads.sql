-- 紅利系統重構 批次 7:建單頁紅利區塊 / 訂單詳情 / 會員頁 / 報表卡片 / 建單成功提示框 —— 後端配套。
-- 對應規格書 .project/specs/紅利系統重構.md(v2.3 + 檔尾 v2.4 主腦裁決)§八 批次 7、§3.13、§4.6~§4.11,
-- 以及 v2.4 裁決 21 ①④(②③ 在前端 / 批次 6 migration 本身處理)。
--
-- 【動工前指紋核對】2026-10-01 對正式庫 wjtbmmnakcriuaqoknsq(唯讀)查
--   md5(replace(prosrc, E'\r\n', E'\n')) / 長度:
--   public.get_member_related_bookings(uuid)  7589ec5c941c53d4b6eb007ba4648b44 / 1174(= 規格書 §〇.1b)
--   public.preview_booking_points            正式庫不存在(批次 2 新增、尚未上線),本支以批次 2 的版本為底
--   private.can_manage_members / can_manage_member_points / can_manage_bookings 只呼叫、不修改。
--
-- 這支 migration 做的事:
--   1. preview_booking_points:多回一個鍵 reward_condition_mode —— **只在** ineligible_reason =
--      'reward_condition' 時有值(其餘情況 null)。§4.6 第 1 點的文案「此會員未符合商家設定的核發資格
--      條件(需 {條件})」需要知道條件是什麼,但只有 orders 鑰匙的客服讀不到 merchant_member_settings
--      (判斷 13)。只在「這張單因為這個條件拿不到點」時才給,其餘時候不多洩漏任何設定。主體其餘逐字不變。
--   2. get_member_related_bookings:回傳欄位新增 points_planned / points_redeemed /
--      points_planned_overridden(§3.13);earned_points 語意不變。回傳型別變了 ⇒ drop + create + 重收權限。
--   3. 新增 public.get_merchant_points_feature_enabled(p_merchant_id):v2.4 裁決 21 ①。
--      會員詳情頁原本用 useMerchantMemberSettings 判斷紅利開關,對「只有 members 鑰匙」的客服會因 RLS
--      查無列而靜默變成「開著」。改由這支 SECURITY DEFINER 回傳布林(不放寬表政策)。
--   4. 新增 public.get_booking_points_ledger(p_booking_id):§4.7 訂單詳情「已入帳 N 點 / 已收回」。
--      訂單詳情只需要 orders 鑰匙,但分類帳 member_point_transactions 的 SELECT 要 members 鑰匙;
--      這支只回這一張單的兩個數字,不回任何會員餘額或其他交易。
--   5. merchant_point_formulas:收掉 INSERT/UPDATE/DELETE 直接寫入政策並收回表權限,只留 SELECT
--      (v2.4 裁決 21 ④)。寫入一律走 upsert_member_point_formulas(SECURITY DEFINER,重複檢查 / IDOR /
--      原子性都在裡面)。只拿掉政策而不收回表權限的話,UPDATE/DELETE 會「靜默 0 列」而不是報錯,
--      前端或腳本誤用時看不出來 ⇒ 兩件一起做,直接寫表一律 42501。
--   6. member_birthday_bonus_grants:比照 5,收回 anon / authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE
--      表權限(批次 8 主腦裁決)。這張表本來就只有 SELECT 政策,寫入只走 SECURITY DEFINER 的
--      run_birthday_bonus_grants / mark_birthday_line_result(排程與 service_role),不受影響;
--      收回後直接寫表一律 42501,不再是 UPDATE/DELETE「靜默 0 列」。

-- =========================================================================
-- 1. preview_booking_points(+ reward_condition_mode)
-- =========================================================================
create or replace function public.preview_booking_points(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_member_id uuid,
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
stable
security definer
set search_path = public
as $$
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
      raise exception '找不到這筆預約,或沒有權限查看' using errcode = '42501';
    end if;
  end if;

  -- 2. 功能關閉 ⇒ 只回一個鍵,不洩漏任何設定或會員資訊。
  v_s := private.merchant_member_settings_effective(p_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    return jsonb_build_object('feature_enabled', false);
  end if;

  -- 3. 決定會員(member.resolution)。
  if p_member_id is not null then
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
        v_resolution := 'new';
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
        raise exception '請提供每個服務項目的單價,且不能是負數';
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
      'member_id', case when v_resolution in ('existing', 'given') then v_member_id end,
      'name', case when v_resolution in ('existing', 'given') then v_member_name end,
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
$$;

comment on function public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) is '紅利系統重構 §3.2(v2.3,#842;取代 #917):建單/改單頁的紅利即時預覽,唯讀。權限 = orders 鑰匙(can_manage_bookings);別家商家的 p_booking_id ⇒ 42501;別家/下架/亂填的 p_member_id ⇒ 當成沒有會員(不洩漏存不存在)。新增模式依電話找會員(resolve_booking_member_by_phone,與 create_booking 同一支);找不到 ⇒ resolution=new,以全新會員屬性試算派點、不開放折抵。功能關閉只回 {"feature_enabled": false}。派點一律由 compute_booking_planned_points 計算(與建單同一支引擎),折抵上限由 compute_booking_redeem_limits 計算。批次 7:多回 reward_condition_mode,只在 ineligible_reason = reward_condition 時有值(畫面文案「需 {條件}」用)。不放寬 merchant_member_settings 的 SELECT 政策。';

-- create or replace 不會重設權限;這裡再明確收一次,讓這支 migration 單獨閱讀時權限一目了然。
revoke execute on function public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) from public, anon;
grant execute on function public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) to authenticated;

-- =========================================================================
-- 2. §3.13 get_member_related_bookings(+ points_planned / points_redeemed / points_planned_overridden)
--    主體以正式庫 pg_get_functiondef(指紋 7589ec5c…)為底,只在回傳欄位尾端加三欄。
-- =========================================================================
drop function if exists public.get_member_related_bookings(uuid);

create function public.get_member_related_bookings(p_member_id uuid)
returns table (
  id uuid,
  start_at timestamptz,
  status text,
  final_amount_snapshot numeric,
  service_item_names text[],
  earned_points integer,
  points_planned integer,
  points_redeemed integer,
  points_planned_overridden boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- 同上:RETURNS TABLE 也定義了 id 欄位,查詢 members 表時明確加上別名限定。
  select m.merchant_id into v_merchant_id from public.members m where m.id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  -- 刻意檢查 can_manage_members,不是 can_manage_bookings——這是這支函式存在的核心理由
  -- (一之二節方向二),即使呼叫者只有 orders 權限、沒有 members 權限也一樣被擋下。
  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  return query
    select
      b.id,
      b.start_at,
      b.status,
      b.final_amount_snapshot,
      coalesce(
        (select array_agg(si.name order by si.name)
         from public.booking_service_items bsi
         join public.service_items si on si.id = bsi.service_item_id
         where bsi.booking_id = b.id),
        array[]::text[]
      ) as service_item_names,
      (select t.points_delta
         from public.member_point_transactions t
         where t.booking_id = b.id and t.transaction_type = 'earn_booking'
         limit 1) as earned_points,
      -- 紅利系統重構 §3.13(批次 7):會員詳情頁「相關訂單」每列顯示「預定 / 已入帳 / 折抵」。
      b.points_planned,
      b.points_redeemed,
      b.points_planned_overridden
    from public.bookings b
    where b.member_id = p_member_id
    order by b.start_at desc
    limit 50;
end;
$$;

comment on function public.get_member_related_bookings(uuid) is '模組 10 §3.13(一之二節 RLS 影響評估方向二):回傳指定會員的歷史訂單清單(上限 50 筆,新到舊),含是否已核發紅利點數;紅利系統重構批次 7 加回 points_planned / points_redeemed / points_planned_overridden(預定派點、折抵點數、是否人工設定)。SECURITY DEFINER 繞過 bookings_select,只回傳會員詳情頁需要的欄位,不曝露內部備註等敏感欄位。檢查 can_manage_members,不是 can_manage_bookings。';

revoke execute on function public.get_member_related_bookings(uuid) from public, anon;
grant execute on function public.get_member_related_bookings(uuid) to authenticated;

-- =========================================================================
-- 3. v2.4 裁決 21 ①:會員詳情頁判斷紅利開關用的讀取函式
-- =========================================================================
create or replace function public.get_merchant_points_feature_enabled(p_merchant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- 會員詳情頁本身在 members 鑰匙底下;紅利點數管理頁在 member_points 鑰匙底下。兩把任一即可,
  -- 其他人(只有 orders / billing …)一律 42501 —— 那些頁面各有自己的來源
  -- (建單頁:preview_booking_points.feature_enabled;帳務報表:get_merchant_billing_summary.points_feature_enabled)。
  if not (private.can_manage_members(p_merchant_id) or private.can_manage_member_points(p_merchant_id)) then
    raise exception '沒有權限查看這間商家的紅利點數設定' using errcode = '42501';
  end if;

  -- 查無設定列 ⇒ 預設 true(跟 merchant_member_settings 欄位 DEFAULT、前端 DEFAULT_MERCHANT_MEMBER_SETTINGS、
  -- 報表函式的 points_feature_enabled 一致)。只回一個布林,不回任何其他設定欄位。
  return coalesce(
    (select s.points_feature_enabled from public.merchant_member_settings s where s.merchant_id = p_merchant_id),
    true
  );
end;
$$;

comment on function public.get_merchant_points_feature_enabled(uuid) is '紅利系統重構批次 7(v2.4 裁決 21 ①):回傳商家目前「紅利點數功能」是否開啟。members 或 member_points 鑰匙任一即可呼叫(會員詳情頁用)。存在理由:merchant_member_settings 的 SELECT 政策不放行 members 鑰匙,前端 useMerchantMemberSettings 查無列時會靜默退回預設值 true,只有 members 鑰匙的客服會在功能關閉時看到點數卡片。不放寬表政策,只回一個布林。查無設定列 ⇒ true。';

revoke execute on function public.get_merchant_points_feature_enabled(uuid) from public, anon;
grant execute on function public.get_merchant_points_feature_enabled(uuid) to authenticated;

-- =========================================================================
-- 4. §4.7 訂單詳情「已入帳 / 已收回」
-- =========================================================================
create or replace function public.get_booking_points_ledger(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_earned integer;
  v_reversed integer;
  v_has_earn boolean;
begin
  select b.merchant_id into v_merchant_id from public.bookings b where b.id = p_booking_id;

  -- 跟建單 / 訂單詳情同一把鑰匙(orders)。「不存在」與「別家的」回同一個錯誤,不洩漏存不存在。
  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '找不到這筆預約,或沒有權限查看' using errcode = '42501';
  end if;

  select
    coalesce(sum(t.points_delta) filter (where t.transaction_type = 'earn_booking'), 0)::int,
    coalesce(-sum(t.points_delta) filter (where t.transaction_type = 'earn_booking_reversal'), 0)::int,
    bool_or(t.transaction_type = 'earn_booking')
  into v_earned, v_reversed, v_has_earn
  from public.member_point_transactions t
  where t.booking_id = p_booking_id
    and t.merchant_id = v_merchant_id
    and t.transaction_type in ('earn_booking', 'earn_booking_reversal');

  -- 只回這一張單的入帳 / 收回點數,不回會員餘額、不回其他交易、不回推薦獎勵(那是推薦者的交易)。
  return jsonb_build_object(
    'earned_points', case when coalesce(v_has_earn, false) then v_earned end,
    'reversed_points', v_reversed,
    'effective_points', case when coalesce(v_has_earn, false) then greatest(v_earned - v_reversed, 0) end
  );
end;
$$;

comment on function public.get_booking_points_ledger(uuid) is '紅利系統重構批次 7(§4.7):訂單詳情「已入帳 N 點 / 已收回」用。回傳 {earned_points(本單 earn_booking 加總;從未入帳為 null), reversed_points(本單 earn_booking_reversal 收回點數), effective_points(有效入帳 = 入帳 − 收回,從未入帳為 null)}。權限 = orders 鑰匙(can_manage_bookings);不存在 / 別家訂單同一個 42501。存在理由:分類帳 SELECT 要 members 鑰匙,訂單詳情只需要 orders 鑰匙;只回這張單的三個數字。';

revoke execute on function public.get_booking_points_ledger(uuid) from public, anon;
grant execute on function public.get_booking_points_ledger(uuid) to authenticated;

-- =========================================================================
-- 5. v2.4 裁決 21 ④:merchant_point_formulas 只留 SELECT 政策
-- =========================================================================
drop policy if exists merchant_point_formulas_insert on public.merchant_point_formulas;
drop policy if exists merchant_point_formulas_update on public.merchant_point_formulas;
drop policy if exists merchant_point_formulas_delete on public.merchant_point_formulas;

-- 沒有政策時 UPDATE / DELETE 是「靜默 0 列」不報錯 ⇒ 連表權限一起收,直接寫表一律 42501。
-- upsert_member_point_formulas 是 SECURITY DEFINER(owner 身分),不受影響。
revoke insert, update, delete, truncate on public.merchant_point_formulas from anon, authenticated;

comment on table public.merchant_point_formulas is '紅利系統重構 §1.2(#838):進階模式的派點公式,一列 = 「某個服務項目(service_item_id 為 NULL 代表全部服務項目)每個數量給幾點、單價要達到多少門檻」。個別項目公式優先,「全部服務項目」只套用在沒有自己公式的項目,兩者不相加(第 2 題定案 B,計算規則在 §2.3,不是資料庫約束)。資料庫層只擋「同一個別項目兩條」與「兩條全部」。RLS:SELECT 要 private.can_manage_member_points(規則歸紅利點數管理鑰匙);寫入只能走 public.upsert_member_point_formulas(批次 7 / v2.4 裁決 21 ④ 收掉 INSERT/UPDATE/DELETE 政策並收回 anon/authenticated 的寫入權限)。建單頁不直接讀這張表,走 preview_booking_points。服務項目下架時公式保留,不自動刪除/停用。';

-- =========================================================================
-- 6. 批次 8 主腦裁決:member_birthday_bonus_grants 比照 merchant_point_formulas 收回寫入表權限
-- =========================================================================
-- 只有 SELECT 政策(member_birthday_bonus_grants_select),寫入全部走 SECURITY DEFINER 函式
-- (run_birthday_bonus_grants、mark_birthday_line_result,owner 身分)與 service_role,不受影響。
-- 不收的話 UPDATE / DELETE 是「靜默 0 列」;收了之後直接寫表一律 42501。
revoke insert, update, delete, truncate on public.member_birthday_bonus_grants from anon, authenticated;
