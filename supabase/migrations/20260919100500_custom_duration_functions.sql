-- 模組 6:訂單管理(第二批)— §4.3 自訂工時開關,功能層。
-- 對應規格書 §4.3:建單表單自訂工時開關,`end_at` 直接改用自訂總服務時長計算,真的影響排程佔用
-- 與衝突檢查邊界(含第五節單日例外第三層)。
--
-- **重蹈覆轍風險提醒(主腦交辦時特別強調,先前已經三次在這裡踩過坑)**:create_booking/
-- update_booking/private.validate_booking_selection 這次又要新增參數,一律先
-- `drop function if exists` 舊版本再建立新版本,不能只用 `create or replace` 加在參數清單尾端。
--
-- 設計原則(§4.3 第 2 點):`end_at` 算出來之後,後續所有既有排程驗證(規則 2.1/2.2/2.3/2.4/2.6、
-- 本次的第五節單日例外第三層)全部一律使用這個自訂工時算出來的 [start_at, end_at) 區間去檢查,
-- 跟原本逐項加總算出來的 end_at 走的是完全相同一套驗證邏輯(private.check_staff_booking_slot
-- 完全不需要改動,只是 validate_booking_selection 傳給它的 end_at 這個參數值改變了計算方式)。

-- =========================================================================
-- private.validate_booking_selection:新增 p_custom_duration_enabled/p_custom_duration_minutes
-- 兩個參數,加在既有參數清單最後面(p_exclude_booking_id 之後),不打亂既有呼叫端仍在使用中的
-- 其餘參數位置。回傳型別不變(OUT end_at, items_subtotal)。
-- =========================================================================
drop function if exists private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid);

create function private.validate_booking_selection(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_assistant_staff_ids uuid[],
  p_material_cost_item_ids uuid[],
  p_exclude_booking_id uuid,
  p_custom_duration_enabled boolean,
  p_custom_duration_minutes integer,
  out end_at timestamptz,
  out items_subtotal numeric
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
end;
$$;

comment on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer) is '對應規則 3.5 第 7 點,模組 6 訂單管理 §2.2/§2.4/§4.3 調整:create_booking/update_booking 共用的驗證邏輯。新增 p_custom_duration_enabled/p_custom_duration_minutes(§4.3 裁決 Q3 方向一):開啟時 end_at 直接採用 p_start_at + p_custom_duration_minutes,取代逐項加總結果;算出來的 end_at 之後一律走跟原本完全相同的排程驗證邏輯(規則 2.1/2.2/2.3/2.4/2.6、第五節單日例外第三層),助手也套用同一個自訂後的區間,不網開一面。p_service_items 是 jsonb 陣列,每個元素 {service_item_id, quantity, unit_price}。p_exclude_booking_id 傳 null 代表 create_booking(新建),傳實際 booking id 代表 update_booking(編輯)。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer) from public, anon;
grant execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer) to authenticated;

-- =========================================================================
-- create_booking:破壞性簽章變更——drop 掉舊的 21 參數版本,新增
-- p_custom_duration_enabled/p_custom_duration_minutes 兩個參數,加在既有參數清單最後面。
-- =========================================================================
drop function if exists public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text);

create function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}',
  p_material_cost_item_ids uuid[] default '{}',
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
  p_payment_method text default null,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sel record;
  v_amount record;
  v_created_by_role text;
  v_booking_id uuid;
  v_industry_type text;
  v_result public.bookings;
begin
  -- 1. 權限檢查(規則 2.12 第 2 點)
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限建立這間商家的預約' using errcode = '42501';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;

  -- 建單表單細節修正第二節第 4 點:依商家 industry_type 判斷客戶地址是否必填。
  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 2~7. 共用驗證邏輯(規則 3.5 第 7 點,模組 6 §2.2/§4.3 調整):服務項目/主要人員/助手邊界衝突/
  --      料錢成本開關,並取得 end_at(§4.3:自訂工時開啟時採用自訂值)+ 服務項目小計。
  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null,
    p_custom_duration_enabled, p_custom_duration_minutes
  );

  -- 8. §2.3:金額計算引擎(不信任前端算好的最終金額,依傳入的原始參數重新算一次)。
  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  -- 9. 通過後在同一個交易裡寫入 bookings(狀態改為 pending_confirmation,決策記錄 5)
  --    + 三張關聯表(規格書 4.1 第 8 步)。任何一步失敗,整個函式呼叫(單一交易)rollback。
  --    §4.3 邊界情況:關閉自訂工時開關時,custom_duration_minutes 一律存 null,避免留著舊值
  --    造成混淆——即使呼叫端不小心傳了值進來,這裡也用 case 擋掉。
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method,
    custom_duration_enabled, custom_duration_minutes
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_sel.end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation',
    coalesce(p_custom_total_amount_enabled, false), p_custom_total_amount, v_amount.subtotal_amount,
    coalesce(p_discount_enabled, false), p_discount_mode, p_discount_value, v_amount.discount_amount,
    coalesce(p_tax_enabled, false), p_tax_mode, p_tax_value, v_amount.tax_amount,
    v_amount.final_amount, nullif(btrim(coalesce(p_payment_method, '')), ''),
    coalesce(p_custom_duration_enabled, false),
    case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end
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

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$$;

comment on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer) is '對應訂單管理規格書 §4.1~4.8(含 §4.3 自訂工時):手動建單。新增 p_custom_duration_enabled/p_custom_duration_minutes(§4.3 裁決 Q3 方向一):開啟時 end_at 直接採用自訂總服務時長,取代逐項加總結果,算出來的 end_at 一律走跟原本完全相同的排程驗證邏輯(含第五節單日例外第三層),助手也套用同一個自訂後的區間。關閉時 custom_duration_minutes 一律存 null。其餘邏輯不變:金額計算透過 private.calculate_booking_amount 共用(§2.3),排程驗證透過 private.validate_booking_selection 共用,建立後狀態固定是 pending_confirmation。';

revoke execute on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer) from public, anon;
grant execute on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer) to authenticated;

-- =========================================================================
-- update_booking:同樣的破壞性簽章變更,理由跟 create_booking 完全一致。
-- =========================================================================
drop function if exists public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text);

create function public.update_booking(
  p_booking_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}',
  p_material_cost_item_ids uuid[] default '{}',
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
  p_payment_method text default null,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_industry_type text;
  v_sel record;
  v_amount record;
  v_result public.bookings;
begin
  -- 1. 依 p_booking_id 查出既有的 merchant_id/status,查無資料則報錯。
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  -- 2. 權限檢查,跟建單/確認相同(orders section_key)。
  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  -- 3. 狀態檢查(規則 3.5 第 1 點):只有 pending_confirmation/accepted 能編輯。
  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能編輯,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;

  -- 建單表單細節修正第二節第 4 點:編輯時同樣依商家 industry_type 判斷客戶地址是否必填。
  select industry_type into v_industry_type
  from public.merchants
  where id = v_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 4. 跟 create_booking 完全相同的驗證邏輯,唯一差異是傳入 p_booking_id 排除自己原本的時段
  --    (規則 3.5 第 3 點:所有時段重疊查詢都加上 and b.id <> p_booking_id)。
  select * into v_sel from private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id,
    p_custom_duration_enabled, p_custom_duration_minutes
  );

  -- 5. §2.3/§2.4:金額計算引擎——編輯表單如果沒有動金額相關欄位,傳進來的還是原本 getBooking(id)
  --    帶出的快照值,重新算一次結果自然跟編輯前一模一樣;客服如果主動調整了某個欄位或重新選擇
  --    服務項目,這裡就會依新輸入值重新算出新的快照(§2.4 第 2 點,前端配合原則)。
  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  -- 6. 驗證通過後,同一個交易裡更新主體欄位(不改變 status,規則 3.5 第 5 點)+
  --    整批刪除重寫三張關聯表(規則 3.5 第 4 點,不做增量式差異比對)。
  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_sel.end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    customer_address = nullif(btrim(coalesce(p_customer_address, '')), ''),
    notes = p_notes,
    customer_notes = p_customer_notes,
    custom_total_amount_enabled = coalesce(p_custom_total_amount_enabled, false),
    custom_total_amount = p_custom_total_amount,
    subtotal_amount_snapshot = v_amount.subtotal_amount,
    discount_enabled = coalesce(p_discount_enabled, false),
    discount_mode = p_discount_mode,
    discount_value = p_discount_value,
    discount_amount_snapshot = v_amount.discount_amount,
    tax_enabled = coalesce(p_tax_enabled, false),
    tax_mode_snapshot = p_tax_mode,
    tax_value_snapshot = p_tax_value,
    tax_amount_snapshot = v_amount.tax_amount,
    final_amount_snapshot = v_amount.final_amount,
    payment_method = nullif(btrim(coalesce(p_payment_method, '')), ''),
    custom_duration_enabled = coalesce(p_custom_duration_enabled, false),
    custom_duration_minutes = case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    last_modified_by_user_id = auth.uid(),
    last_modified_at = now()
  where id = p_booking_id;

  delete from public.booking_service_items where booking_id = p_booking_id;
  delete from public.booking_assistants where booking_id = p_booking_id;
  delete from public.booking_material_costs where booking_id = p_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    p_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select p_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select p_booking_id, mci.id, mci.amount
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$$;

comment on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer) is '對應訂單管理規格書 §4.1~4.8/§2.4/§4.3:編輯已建立訂單,一併更新自訂工時開關(§4.3)。**§2.4 編輯不變動原則的關鍵**:這支函式完全不記憶「客服到底有沒有改欄位」,只是單純用呼叫端這次傳入的值重新算一次。其餘邏輯不變:pending_confirmation/accepted 狀態下可用,依商家 industry_type 判斷客戶地址是否必填,排程驗證邏輯透過 private.validate_booking_selection 共用,不會改變 status 欄位。';

revoke execute on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer) from public, anon;
grant execute on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer) to authenticated;
