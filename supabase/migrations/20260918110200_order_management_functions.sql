-- 模組 6:訂單管理 — 功能層。
-- 對應規格書 §2.2(工時加總公式調整,數量對工時的影響)、§2.3(金額計算順序)、
-- §2.4(金額快照寫入時機與編輯不變動原則)、§4.1/4.2/4.4~4.8(建單表單擴充,不含 §4.3 自訂工時)、
-- §3.2(付款方式)、§3.3/§6.3(相關訂單)、§6.1/6.2(對外介面)、七、建議實作順序第 2 點
-- (抽出 private.calculate_booking_amount 共用金額計算邏輯)。
--
-- **重蹈覆轍風險提醒(主腦交辦時特別強調,先前「建單功能擴充」「預約詳情擴充」都踩過這個坑)**:
-- create_booking/update_booking 這次又要新增參數,而且服務項目參數本身的型別也要改變
-- (uuid[] → jsonb,見下方說明)。一律先 drop function if exists 舊版本再建立新版本,不能只用
-- create or replace 加在參數清單尾端——否則正式環境會同時存在新舊兩個簽章版本,呼叫時報 42725
-- (function is not unique)。
--
-- **服務項目參數結構設計選擇(規格書沒有規定確切型別,由 engineer 自行判斷)**:
-- 把原本的 `p_service_item_ids uuid[]` 改成 `p_service_items jsonb`,每個陣列元素是
-- `{"service_item_id": uuid, "quantity": int, "unit_price": numeric}`。
-- 理由:
--   1. 三個平行陣列(ids/quantities/prices)容易因為呼叫端排序不一致而錯位對應到錯誤的項目,
--      是一個容易被忽略、且不會在型別層級被擋下來的資料完整性風險;jsonb 陣列每個元素自帶三個
--      欄位,不存在「排序對不上」的問題。
--   2. 之後如果還要再幫每個服務項目加欄位(例如未來要記錄「這個項目由哪位助手負責」之類的
--      逐項細節),jsonb 結構可以直接加欄位,不需要再新增第四個平行陣列、再一次面臨這裡提醒的
--      「新增參數要 drop function if exists」風險。
--   3. PostgREST/supabase-js 呼叫 jsonb 參數的體驗跟呼叫 uuid[]/text[] 一樣直接(前端傳一般
--      JS 陣列即可,supabase-js 會自動序列化成 jsonb),不需要額外轉換成本。
--
-- **服務項目參數的驗證/信任邊界(呼應規格書 §2.4「後端一律重新驗證,不信任前端」)**:
-- quantity/unit_price 是「客服當下輸入或確認的值」,由 private.validate_booking_selection
-- 驗證格式(quantity 是 >=1 的整數、unit_price 是 >=0 的數字),但**不會**拿去跟
-- service_items.price 目前的即時值比對是否一致——這是 §2.4 明確要求的行為(金額快照欄位一律信任
-- 呼叫端傳入值,不重新查詢覆蓋)。duration_minutes_snapshot 則相反,依 §2.2 規則,每次都重新查詢
-- service_items.duration_minutes,不使用呼叫端傳入的任何工時資訊(呼叫端也確實沒有傳工時)。

-- =========================================================================
-- private.calculate_booking_amount:規格書七、建議實作順序第 2 點建議抽出的共用金額計算函式,
-- create_booking/update_booking 都呼叫這一支,避免兩邊各自維護一份幾乎相同的計算邏輯。
-- 對應 §2.3 計算順序:①小計(自訂總金額或逐項小計)②折扣(固定/百分比,不可超過小計)
-- ③稅金(以折扣後金額為課稅基礎)④最終金額(必須 >= 0)。
-- 用 OUT 參數回傳四個 breakdown 欄位,呼叫端用 `select * into v_amount from
-- private.calculate_booking_amount(...)` 取得,不需要額外定義一個複合型別。
-- =========================================================================
create or replace function private.calculate_booking_amount(
  p_items_subtotal numeric,
  p_custom_total_amount_enabled boolean,
  p_custom_total_amount numeric,
  p_discount_enabled boolean,
  p_discount_mode text,
  p_discount_value numeric,
  p_tax_enabled boolean,
  p_tax_mode text,
  p_tax_value numeric,
  out subtotal_amount numeric,
  out discount_amount numeric,
  out tax_amount numeric,
  out final_amount numeric
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_taxable_base numeric;
begin
  -- ①小計(§2.3 步驟 1):自訂總金額開關開啟時取代逐項小計。
  if coalesce(p_custom_total_amount_enabled, false) then
    if p_custom_total_amount is null then
      raise exception '已開啟自訂總金額,請輸入金額';
    end if;
    subtotal_amount := p_custom_total_amount;
  else
    subtotal_amount := coalesce(p_items_subtotal, 0);
  end if;

  -- ②折扣(§2.3 步驟 2):固定金額或百分比二選一,換算成實際扣除的金額。
  if coalesce(p_discount_enabled, false) then
    if p_discount_mode = 'fixed' then
      discount_amount := coalesce(p_discount_value, 0);
    elsif p_discount_mode = 'percentage' then
      discount_amount := round(subtotal_amount * (coalesce(p_discount_value, 0) / 100), 2);
    else
      raise exception '折扣模式必須是「固定金額」或「百分比」其中一種';
    end if;
  else
    discount_amount := 0;
  end if;

  -- 邊界情況(§2.3):折扣金額不可大於小計,超過就白話報錯擋下。
  if discount_amount > subtotal_amount then
    raise exception '折扣金額不能超過訂單小計';
  end if;

  -- ③稅金(§2.3 步驟 3):以「小計 - 折扣」當課稅基礎,不是以原始小計。
  v_taxable_base := subtotal_amount - discount_amount;
  if coalesce(p_tax_enabled, false) then
    if p_tax_mode = 'fixed' then
      tax_amount := coalesce(p_tax_value, 0);
    elsif p_tax_mode = 'percentage' then
      tax_amount := round(v_taxable_base * (coalesce(p_tax_value, 0) / 100), 2);
    else
      raise exception '稅金模式必須是「比例」或「固定金額」其中一種';
    end if;
  else
    tax_amount := 0;
  end if;

  -- ④最終金額(§2.3 步驟 4):理論上折扣已經在步驟②擋過超額,這裡是最後一道防線。
  final_amount := subtotal_amount - discount_amount + tax_amount;
  if final_amount < 0 then
    raise exception '計算出來的最終金額不能是負數,請確認折扣/稅金設定';
  end if;
end;
$$;

comment on function private.calculate_booking_amount(numeric, boolean, numeric, boolean, text, numeric, boolean, text, numeric) is '對應規格書 §2.3/七、建議實作順序第 2 點:create_booking/update_booking 共用的金額計算引擎,依「小計→折扣→稅金→最終金額」固定順序計算,折扣不可超過小計、最終金額不可為負數。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.calculate_booking_amount(numeric, boolean, numeric, boolean, text, numeric, boolean, text, numeric) from public, anon;
grant execute on function private.calculate_booking_amount(numeric, boolean, numeric, boolean, text, numeric, boolean, text, numeric) to authenticated;

-- =========================================================================
-- private.validate_booking_selection:破壞性簽章變更——p_service_item_ids uuid[] 改成
-- p_service_items jsonb(見本檔案開頭的設計選擇說明),回傳型別從單一 timestamptz 改成
-- OUT (end_at timestamptz, items_subtotal numeric),一次回傳「算出來的結束時間」跟「服務項目
-- 小計」,讓 create_booking/update_booking 不用重複解析一次 p_service_items jsonb。
-- 其餘邏輯(主要人員/助手邊界衝突檢查、料錢成本開關驗證)完全沿用建單功能擴充規格書 3.5 第 7 點
-- 既有版本,不變動。
-- =========================================================================
drop function if exists private.validate_booking_selection(uuid, uuid, uuid[], timestamptz, uuid[], uuid[], uuid);

create function private.validate_booking_selection(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_assistant_staff_ids uuid[],
  p_material_cost_item_ids uuid[],
  p_exclude_booking_id uuid,
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
  -- 跟金額欄位「不重新查詢」刻意不同,見本檔案開頭說明跟規格書 §2.4 第 3 點)。
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

  end_at := p_start_at + make_interval(mins => v_total_minutes);

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

  -- 4. 規則 2.1/2.2/2.3/2.4/2.6:先驗證主要服務人員,再逐一驗證每一位助手(決策記錄 2)。
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

comment on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid) is '對應規則 3.5 第 7 點,模組 6 訂單管理 §2.2/§2.4 調整:create_booking/update_booking 共用的驗證邏輯。p_service_items 是 jsonb 陣列,每個元素 {service_item_id, quantity, unit_price}(型別設計見本檔案開頭說明)。回傳 (end_at, items_subtotal):end_at 依 §2.2 新公式(Σ duration_minutes_snapshot × quantity)算出;items_subtotal 是 Σ(unit_price × quantity),供呼叫端接著送進 private.calculate_booking_amount。quantity/unit_price 只驗證格式,不驗證是否等於目前的即時價格(§2.4)。p_exclude_booking_id 傳 null 代表 create_booking(新建),傳實際 booking id 代表 update_booking(編輯,排除自己原本的時段)。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid) from public, anon;
grant execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid) to authenticated;

-- =========================================================================
-- create_booking:破壞性簽章變更——drop 掉舊的 12 參數版本(p_service_item_ids uuid[] 結尾到
-- p_customer_notes),重新建立新的 21 參數版本:p_service_item_ids 改型別成 p_service_items
-- jsonb(位置不變,第 3 個參數),新增 9 個金額彈性參數,一律加在既有參數清單最後面
-- (不打亂既有呼叫端仍在使用中的其餘參數位置)。
-- =========================================================================
drop function if exists public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text);

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
  p_payment_method text default null
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

  -- 2~7. 共用驗證邏輯(規則 3.5 第 7 點,模組 6 §2.2 調整):服務項目/主要人員/助手邊界衝突/
  --      料錢成本開關,並取得 end_at + 服務項目小計。
  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null
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
  --    預約詳情資訊擴充與建單備註分類第一節:一併寫入 customer_notes(客戶備註)。
  --    模組 6 §2.1/§2.4:一併寫入金額彈性開關 + 快照 breakdown + payment_method。
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_sel.end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation',
    coalesce(p_custom_total_amount_enabled, false), p_custom_total_amount, v_amount.subtotal_amount,
    coalesce(p_discount_enabled, false), p_discount_mode, p_discount_value, v_amount.discount_amount,
    coalesce(p_tax_enabled, false), p_tax_mode, p_tax_value, v_amount.tax_amount,
    v_amount.final_amount, nullif(btrim(coalesce(p_payment_method, '')), '')
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

comment on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text) is '對應訂單管理規格書 §4.1/4.2/4.4~4.8(不含 §4.3 自訂工時,留給下一批):手動建單。p_service_items 改成 jsonb 陣列(每個元素 {service_item_id, quantity, unit_price},取代原本的 p_service_item_ids uuid[],設計理由見本檔案開頭),新增自訂總金額/折扣/稅金三組開關參數與 payment_method。金額計算透過 private.calculate_booking_amount 共用(§2.3),單價/折扣/稅金數字一律直接使用呼叫端傳入值寫入,不重新查詢 service_items.price 或 merchant_tax_settings(§2.4)。其餘邏輯不變:依商家 industry_type 判斷客戶地址是否必填,排程驗證邏輯透過 private.validate_booking_selection 共用,建立後狀態固定是 pending_confirmation(決策記錄 5)。';

revoke execute on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text) from public, anon;
grant execute on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text) to authenticated;

-- =========================================================================
-- update_booking:同樣的破壞性簽章變更,理由跟 create_booking 完全一致。
-- =========================================================================
drop function if exists public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text);

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
  p_payment_method text default null
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
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id
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

comment on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text) is '對應訂單管理規格書 §4.1/4.2/4.4~4.8/§2.4(不含 §4.3 自訂工時):編輯已建立訂單,一併更新金額彈性開關/快照 breakdown/payment_method。**§2.4 編輯不變動原則的關鍵**:這支函式完全不記憶「客服到底有沒有改欄位」,只是單純用呼叫端這次傳入的值重新算一次——前端配合原則是編輯表單一律用 getBooking(id) 既有快照值預先帶入,沒改就會原封不動送回相同的值,金額自然不變;改了就會用新值重新算出新的快照。其餘邏輯不變:pending_confirmation/accepted 狀態下可用,依商家 industry_type 判斷客戶地址是否必填,排程驗證邏輯透過 private.validate_booking_selection 共用,不會改變 status 欄位。';

revoke execute on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text) from public, anon;
grant execute on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text) to authenticated;

-- =========================================================================
-- §3.2/§6.2:update_booking_payment_method——輕量的付款方式讀寫對外介面,供模組 9
-- 接手時直接複用,不需要重新設計欄位,也不用透過完整的 update_booking(不用重新傳服務項目/
-- 金額等一大包參數,只改這一個欄位)。讀取直接沿用 bookings 既有的 SELECT RLS
-- (booking_merchant_id/can_manage_bookings),這裡只需要補寫入路徑。
-- =========================================================================
create or replace function public.update_booking_payment_method(
  p_booking_id uuid,
  p_payment_method text default null
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
    raise exception '已完成或已取消的預約不能修改付款方式,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  update public.bookings
  set payment_method = nullif(btrim(coalesce(p_payment_method, '')), ''),
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_booking_payment_method(uuid, text) is '對應規格書 §3.2/§6.2:單獨更新一筆預約的付款方式,不需要傳服務項目/金額等其餘欄位。權限/狀態限制跟 update_booking 一致(orders section_key,只有 pending_confirmation/accepted 可改),算是一次「異動」,一併寫入 last_modified_by_user_id/last_modified_at。傳 null 代表清空成「尚未設定」。';

revoke execute on function public.update_booking_payment_method(uuid, text) from public, anon;
grant execute on function public.update_booking_payment_method(uuid, text) to authenticated;

-- =========================================================================
-- §3.3/§6.3:get_customer_related_bookings——相關訂單查詢。比對依據:電話正規化後相同
-- (沿用 private.normalize_phone),只在本商家內比對,不做跨商家查詢(§3.3 明講,避免客服看到
-- 其他商家的客戶資料)。電話為 null(正規化後為 null)時回傳空清單,不報錯。
-- =========================================================================
create or replace function public.get_customer_related_bookings(
  p_merchant_id uuid,
  p_customer_phone text,
  p_exclude_booking_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  start_at timestamptz,
  end_at timestamptz,
  status text,
  final_amount_snapshot numeric,
  service_item_names text[]
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_normalized_phone text;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的訂單' using errcode = '42501';
  end if;

  v_normalized_phone := private.normalize_phone(p_customer_phone);
  if v_normalized_phone is null then
    -- 邊界情況(§3.3):客戶電話為 null(或正規化後為空),回傳空清單,不報錯。
    return;
  end if;

  return query
  select
    b.id,
    b.start_at,
    b.end_at,
    b.status,
    b.final_amount_snapshot,
    coalesce((
      select array_agg(si.name order by si.name)
      from public.booking_service_items bsi
      join public.service_items si on si.id = bsi.service_item_id
      where bsi.booking_id = b.id
    ), array[]::text[])
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and private.normalize_phone(b.customer_phone) = v_normalized_phone
    and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
  order by b.start_at desc
  limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

comment on function public.get_customer_related_bookings(uuid, text, uuid, integer) is '對應規格書 §3.3/§6.3:同一位客戶(電話正規化後相同,沿用 private.normalize_phone)在這間商家底下的歷史訂單清單,依時間新到舊排序,預設上限 50 筆,排除呼叫端指定的 p_exclude_booking_id(通常是正在檢視的那一筆本身)。只在本商家內比對,不做跨商家查詢(§3.3 明講,避免客服看到其他商家的客戶資料,跟規則 2.6 的跨商家排程衝突比對是不同用途,不能混用)。電話為 null 或正規化後為空時回傳空清單,不報錯。';

revoke execute on function public.get_customer_related_bookings(uuid, text, uuid, integer) from public, anon;
grant execute on function public.get_customer_related_bookings(uuid, text, uuid, integer) to authenticated;
