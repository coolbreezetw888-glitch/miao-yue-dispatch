-- SPECS-INDEX #604(規格書 .project/specs/支付方式.md §3.1.1)。
-- 新增預約:付款方式改為必填。create_booking 新建訂單不可留空;update_booking 編輯既有訂單維持
-- 原值(含原本就是 null)不觸發必填擋下,只有主動改成空值才被擋。
--
-- ⚠️ 這項調整推翻了 SPECS-INDEX #205 當初「裁決 Q10:不必填」的既有決定——那是模組 6 規劃階段
-- (付款方式還是單一固定文字選項時)的裁決,使用者這次商家端人工驗收後重新裁決,明確要求改為
-- 必填,2026-09-22 已確認,不用再跟使用者確認。批次匯入例外(#602,資料匯入與報表匯出.md §10.3)
-- 由另一組負責,那條路徑用完全獨立的 import_historical_booking_row 函式,不經過這裡,不受影響。
--
-- 動工前已查證目前套用的最新版本在 20260919130400_payment_methods_v2_snapshot_no_refresh_fix.sql
-- (主腦複查修正付款方式快照被意外洗新的問題)。以下逐字保留那個版本的邏輯,只在第 6 步(付款方式
-- 驗證)最前面新增必填檢查。函式簽章完全不變,直接 create or replace 即可。

create or replace function private.validate_booking_selection(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_assistant_staff_ids uuid[],
  p_material_cost_item_ids uuid[],
  p_exclude_booking_id uuid,
  p_custom_duration_enabled boolean,
  p_custom_duration_minutes integer,
  p_payment_method_id uuid,
  out end_at timestamptz,
  out items_subtotal numeric,
  out payment_method_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_count int;
  v_distinct_count int;
  v_total_minutes int;
  v_found_count int;
  v_item jsonb;
  v_quantity int;
  v_unit_price numeric;
  v_staff public.merchant_staff;
  v_assistant public.merchant_staff;
  v_assistant_id uuid;
  v_material_enabled boolean;
  v_existing_payment_method_id uuid;
begin
  -- 1. 服務項目(§2.1/§4.1):至少選 1 個、結構必須是 jsonb 陣列、不能重複、每個元素的
  --    quantity/unit_price 格式必須正確(§2.4:單價一律信任呼叫端傳入值,這裡只驗證「格式」,
  --    不驗證「是否等於目前的即時價格」)。
  if p_service_items is null or jsonb_typeof(p_service_items) <> 'array' or jsonb_array_length(p_service_items) = 0 then
    raise exception '請至少選擇一個服務項目';
  end if;

  v_item_count := jsonb_array_length(p_service_items);

  select count(*) into v_distinct_count
  from (select distinct (elem ->> 'service_item_id') from jsonb_array_elements(p_service_items) elem) u;
  if v_distinct_count <> v_item_count then
    raise exception '同一個服務項目不能在同一筆預約裡選取兩次';
  end if;

  items_subtotal := 0;
  for v_item in select * from jsonb_array_elements(p_service_items) loop
    if v_item ->> 'service_item_id' is null then
      raise exception '每個服務項目都必須指定 service_item_id';
    end if;

    begin
      v_quantity := (v_item ->> 'quantity')::int;
    exception when others then
      raise exception '服務項目的數量格式不正確,必須是整數';
    end;
    if v_quantity is null or v_quantity < 1 then
      raise exception '服務項目數量必須至少為 1';
    end if;

    begin
      v_unit_price := (v_item ->> 'unit_price')::numeric;
    exception when others then
      raise exception '服務項目的單價格式不正確,必須是數字';
    end;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception '請提供每個服務項目的單價,且不能是負數';
    end if;

    items_subtotal := items_subtotal + (v_unit_price * v_quantity);
  end loop;

  -- §2.2(取代原公式):每個服務項目的工時貢獻 = duration_minutes_snapshot × quantity。
  -- duration_minutes_snapshot 的取得方式不變(每次重新查詢 service_items.duration_minutes,
  -- 跟金額欄位「不重新查詢」刻意不同,見規格書 §2.4 第 3 點)。
  select coalesce(sum(si.duration_minutes * (elem ->> 'quantity')::int), 0), count(*)
  into v_total_minutes, v_found_count
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si
    on si.id = (elem ->> 'service_item_id')::uuid
   and si.merchant_id = p_merchant_id
   and si.status = 'active';

  if v_found_count <> v_item_count then
    raise exception '找不到其中一個服務項目,或這個服務項目已下架';
  end if;

  -- §4.3(裁決 Q3 方向一):自訂工時開關開啟時,直接取代逐項加總結果計算 end_at;
  -- 關閉時沿用 §2.2 既有公式。這是「end_at 怎麼算出來」唯一的分歧點,算出來之後,
  -- 後面所有排程驗證(規則 2.1/2.2/2.3/2.4/2.6、第五節單日例外第三層)一律使用這個 end_at,
  -- 走完全相同一套驗證邏輯(§4.3 第 2 點)。
  if coalesce(p_custom_duration_enabled, false) then
    if p_custom_duration_minutes is null or p_custom_duration_minutes <= 0 then
      raise exception '已開啟自訂工時,請輸入大於 0 的總服務時長(分鐘)';
    end if;
    end_at := p_start_at + make_interval(mins => p_custom_duration_minutes);
  else
    end_at := p_start_at + make_interval(mins => v_total_minutes);
  end if;

  -- 2. 主要服務人員:必須屬於這間商家、status='active'。
  select * into v_staff
  from public.merchant_staff
  where id = p_staff_id and merchant_id = p_merchant_id and status = 'active';
  if not found then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  -- 3. 助手清單(決策記錄 2/3):不能跟主要服務人員是同一人、不能重複指派同一人兩次。
  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    if p_staff_id = any(p_assistant_staff_ids) then
      raise exception '助手不能跟主要服務人員是同一人';
    end if;

    select count(*) into v_distinct_count
    from (select distinct unnest(p_assistant_staff_ids)) u;
    if v_distinct_count <> array_length(p_assistant_staff_ids, 1) then
      raise exception '同一位助手不能在同一筆預約裡被加派兩次';
    end if;
  end if;

  -- 4. 規則 2.1/2.2/2.3/2.4/2.6/第五節第三層:先驗證主要服務人員,再逐一驗證每一位助手
  --    (決策記錄 2)。§4.3 第 3 點:助手的驗證範圍一樣套用這個自訂後的 end_at,不因為是自訂工時
  --    就對助手網開一面。
  perform private.check_staff_booking_slot(
    p_merchant_id, v_staff, p_start_at, end_at, p_exclude_booking_id, '主要服務人員'
  );

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    foreach v_assistant_id in array p_assistant_staff_ids loop
      select * into v_assistant
      from public.merchant_staff
      where id = v_assistant_id and merchant_id = p_merchant_id and status = 'active';
      if not found then
        raise exception '找不到其中一位助手,或這位助手已被移除';
      end if;

      perform private.check_staff_booking_slot(
        p_merchant_id, v_assistant, p_start_at, end_at, p_exclude_booking_id,
        format('助手「%s」', v_assistant.name)
      );
    end loop;
  end if;

  -- 5. 料錢成本(規格書 2.3):帶了品項就必須先確認商家已開啟 material_cost_enabled,
  --    且不能重複選、必須屬於這間商家且 status='active'。
  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    select enabled into v_material_enabled
    from public.merchant_feature_flags
    where merchant_id = p_merchant_id and feature_key = 'material_cost_enabled';

    if coalesce(v_material_enabled, false) is not true then
      raise exception '這間商家尚未開啟料錢成本功能,無法選用料錢成本品項';
    end if;

    select count(*) into v_distinct_count
    from (select distinct unnest(p_material_cost_item_ids)) u;
    if v_distinct_count <> array_length(p_material_cost_item_ids, 1) then
      raise exception '同一個料錢成本品項不能在同一筆預約裡選取兩次';
    end if;

    select count(*) into v_found_count
    from public.material_cost_items
    where id = any(p_material_cost_item_ids) and merchant_id = p_merchant_id and status = 'active';

    if v_found_count <> array_length(p_material_cost_item_ids, 1) then
      raise exception '找不到其中一個料錢成本品項,或已下架';
    end if;
  end if;

  -- 6. 付款方式(模組 9 v2 + SPECS-INDEX #604 疊加必填規則)。
  --    **#604 新增(最前面先判斷)**:p_payment_method_id 是 null 的情況分兩種:
  --      (a) p_exclude_booking_id 是 null(create_booking 新建)→ 一律擋下,必須選擇付款方式。
  --      (b) p_exclude_booking_id 不是 null(update_booking 編輯既有訂單)→ 只有在這筆訂單
  --          「目前已存的 payment_method_id 也是 null」時才放行(客服完全沒有去動這個欄位,
  --          維持原值,即使原值是 null);如果這筆訂單原本已經有值、這次卻被改成 null(客服
  --          主動清空),一樣擋下。
  --    這個檢查通過之後,才進入原本(2026-09-19 主腦複查修正過的)付款方式存在性/狀態驗證,
  --    邏輯完全不變。
  if p_payment_method_id is null then
    if p_exclude_booking_id is null then
      raise exception '請選擇付款方式';
    else
      select payment_method_id into v_existing_payment_method_id
      from public.bookings
      where id = p_exclude_booking_id;

      if v_existing_payment_method_id is not null then
        raise exception '請選擇付款方式';
      end if;
    end if;
  end if;

  --    **關鍵修正(2026-09-19 主腦複查)**:如果這是編輯既有訂單(p_exclude_booking_id 不是 null)、
  --    且這個 payment_method_id 剛好就是這筆訂單目前已經存的值(客服沒有主動更換付款方式),
  --    直接沿用既有的 payment_method_name_snapshot,不重新查詢 payment_methods.name——
  --    避免商家事後把這個付款方式改名字,連帶讓「沒有主動變更付款方式」的編輯動作意外把
  --    歷史訂單的顯示名稱洗成新名字,違反使用者明確要求的「訂單歷史不受商家事後異動影響」。
  if p_payment_method_id is not null then
    if p_exclude_booking_id is not null then
      select payment_method_name_snapshot into payment_method_name
      from public.bookings
      where id = p_exclude_booking_id and payment_method_id = p_payment_method_id;
    end if;

    if payment_method_name is null then
      -- 新建立、或客服主動選了不同的付款方式(不是維持原值)→ 查詢目前的名稱當作新快照。
      select name into payment_method_name
      from public.payment_methods
      where id = p_payment_method_id
        and merchant_id = p_merchant_id
        and (
          status = 'active'
          or (
            p_exclude_booking_id is not null
            and exists (
              select 1 from public.bookings
              where id = p_exclude_booking_id and payment_method_id = p_payment_method_id
            )
          )
        );

      if not found then
        raise exception '找不到這個付款方式,或已下架';
      end if;
    end if;
  end if;
end;
$$;

comment on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) is '對應規則 3.5 第 7 點,模組 9 v2 付款方式驗證 + SPECS-INDEX #604 必填疊加:create_booking/update_booking 共用的驗證邏輯。#604:p_payment_method_id 為 null 時,create_booking(p_exclude_booking_id is null)一律擋下;update_booking 只在這筆訂單目前已存的值也是 null 時放行(維持原值),主動清空才擋下。其餘付款方式驗證邏輯(存在性/狀態/快照不重新整理)完全不動,見 20260919130400 的既有說明。服務項目/主要人員/助手/料錢成本/自訂工時邏輯完全不動。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) from public, anon;
grant execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) to authenticated;
