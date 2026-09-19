-- 模組 9:支付方式 v2 — 功能/RLS 層(第二支:functions)。
-- 對應規格書 .project/specs/支付方式.md(v2)§2/§3/§4。
--
-- **⚠️ 已知風險提醒(專案既有踩坑紀錄,務必遵守,規格書 §1.3 反覆強調)**:
-- create_booking/update_booking/private.validate_booking_selection/update_booking_payment_method
-- 這四支函式的簽章都要調整,一律先 `drop function if exists`(完整列出舊的參數型別清單)再重新
-- `create function`,不能只用 `create or replace`——尤其這次還牽涉到把某個參數的型別從 text
-- 改成 uuid(update_booking_payment_method:p_payment_method text -> p_payment_method_id uuid),
-- PostgreSQL 用「函式名稱+參數型別」當作函式的身分證,型別改變等同建立一個全新的重載函式,
-- 舊版本如果沒有明確 drop,會兩個版本並存,前端呼叫可能打到錯誤的版本。

-- =========================================================================
-- §4:private.can_manage_payment_methods(p_merchant_id uuid)
-- 完全比照 private.can_manage_material_costs 的既有寫法(20260917100200_booking_expansion_functions.sql)。
-- =========================================================================
create or replace function private.can_manage_payment_methods(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'payment_methods'
        and map.granted = true
    );
$$;

comment on function private.can_manage_payment_methods(uuid) is '是否能管理該商家的付款方式清單(模組 9 v2):商家管理員永遠可以,或是該商家目前有效的客服且被開通 payment_methods 這個 section_key。建單/編輯時「選擇既有付款方式」不需要這個權限,只要有 orders 權限即可(見 create_booking/update_booking/validate_booking_selection)。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_manage_payment_methods(uuid) from public, anon;
grant execute on function private.can_manage_payment_methods(uuid) to authenticated;

-- =========================================================================
-- payment_methods 的 RLS 政策(§4)。
-- **2026-09-19 使用者當面推翻此節原本的結論,已定案修正**:「管理付款方式清單(新增/編輯/下架)」
-- 跟「建單時選擇既有付款方式」是兩件不同的事,只有前者需要 payment_methods 權限,後者只要有
-- orders(訂單管理)權限就應該能看到清單並選用,不應該因為沒有 payment_methods 權限就連清單都
-- 看不到。SELECT 政策同時放行 can_manage_bookings(orders 權限)或 can_manage_payment_methods
-- (payment_methods 權限),INSERT/UPDATE 政策維持只允許 can_manage_payment_methods。
-- =========================================================================
alter table public.payment_methods enable row level security;

create policy payment_methods_select on public.payment_methods
  for select to authenticated
  using (private.can_manage_bookings(merchant_id) or private.can_manage_payment_methods(merchant_id));

create policy payment_methods_insert on public.payment_methods
  for insert to authenticated
  with check (private.can_manage_payment_methods(merchant_id));

create policy payment_methods_update on public.payment_methods
  for update to authenticated
  using (private.can_manage_payment_methods(merchant_id))
  with check (private.can_manage_payment_methods(merchant_id));

-- 沒有 DELETE 政策(比照 material_cost_items 既有慣例:軟刪除,不算危險操作但也不做真刪除)。

-- =========================================================================
-- §2:新商家建立當下種入「現場付款」「匯款」兩筆預設付款方式(已定案,使用者確認,不是開放問題)。
-- =========================================================================
create or replace function public.seed_default_payment_methods(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payment_methods (merchant_id, name, description)
  values
    (p_merchant_id, '現場付款', null),
    (p_merchant_id, '匯款', null);
end;
$$;

comment on function public.seed_default_payment_methods(uuid) is '模組 9 v2:新商家建立當下種入兩筆預設付款方式(現場付款/匯款),使用者已確認的定案(不是開放問題)。商家可以之後自己改名字/加說明文字/刪除/下架,不是鎖死不能動。「匯款」預設不帶說明文字——收款帳號是每個商家自己的資訊,系統不該替商家瞎猜或塞入佔位文字混進正式資料,提醒商家「這裡可以填收款帳號」是管理頁輸入框 placeholder 的 UI 層級提示。只在 create_group_and_merchant/create_merchant_in_group 建立商家當下呼叫一次,不做成可重複呼叫的冪等函式(沒有 on conflict,因為呼叫時機保證這個商家剛建立、不會有既有列)。放在 public schema,比照 apply_industry_preset 同樣不額外 revoke/grant,因為前端從未直接把它當 RPC 呼叫,只透過 perform 內部呼叫。';

-- =========================================================================
-- §2:create_group_and_merchant/create_merchant_in_group 補種子呼叫——兩支函式參數簽章完全
-- 不變(只改函式主體內容),用 create or replace 即可,不受上面「drop function if exists」的
-- 規則限制。在 apply_industry_preset 呼叫之後緊接著呼叫 seed_default_payment_methods。
-- =========================================================================
create or replace function public.create_group_and_merchant(
  p_name text,
  p_industry_type text,
  p_address text default null,
  p_contact_email text default null,
  p_intro text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型: %', p_industry_type;
  end if;

  insert into public.groups (group_admin_user_id)
  values (null)
  returning id into v_group_id;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    v_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);

  return v_merchant_id;
end;
$$;

comment on function public.create_group_and_merchant(text, text, text, text, text) is 'Onboarding(4.1)呼叫的 RPC:原子性建立集團+第一間商家+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式,見規格書 3.2、支付方式.md §2。';

create or replace function public.create_merchant_in_group(
  p_group_id uuid,
  p_name text,
  p_industry_type text,
  p_address text default null,
  p_contact_email text default null,
  p_intro text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  if not private.is_group_member(p_group_id) then
    raise exception '沒有權限在此集團下新增分店' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型: %', p_industry_type;
  end if;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    p_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);

  return v_merchant_id;
end;
$$;

comment on function public.create_merchant_in_group(uuid, text, text, text, text, text) is '新增分店流程(4.4)呼叫的 RPC:檢查規則 2.5 權限後,原子性建立新分店+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式,見規格書 3.3、支付方式.md §2。';

-- =========================================================================
-- §3.1:private.validate_booking_selection——新增第 10 個輸入參數 p_payment_method_id uuid、
-- 新增第 3 個輸出參數 out payment_method_name text。舊簽章先明確 drop 再重建(踩坑提醒見檔頭)。
-- 既有的 1~5 步驟(服務項目/主要人員/助手/料錢成本驗證)完全不動,只在最後加上第 6 步。
-- =========================================================================
drop function if exists private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer);

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

  -- 6. 付款方式(模組 9 v2 新增):必須屬於這間商家。放行條件有兩種情況(用 OR 連接):
  --    (a) status='active'(一般情況,含新建與客服主動改選)。
  --    (b) p_exclude_booking_id 不是 null(代表這是 update_booking 編輯既有訂單),而且這個
  --        payment_method_id 剛好就是這筆訂單「目前已經存的值」——即使商家事後已經把它下架,
  --        仍然放行。理由:前端編輯表單的下拉選單本來就會把「這筆訂單原本選的付款方式」保留在
  --        清單裡讓客服看得到(即使它已下架),如果後端不放行,會出現「前端讓你選、後端卻擋下」的
  --        矛盾體驗,而且客服明明沒有要換付款方式,卻被迫因為商家的下架動作卡住存不了檔——這正是
  --        使用者要求「訂單歷史不受商家事後異動影響」精神的延伸(這裡雖然是「還能編輯的訂單」而非
  --        嚴格意義的「歷史訂單」,但保留一致的使用者體驗)。
  if p_payment_method_id is not null then
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
end;
$$;

comment on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) is '對應規則 3.5 第 7 點,模組 9 v2 新增付款方式驗證:create_booking/update_booking 共用的驗證邏輯。新增 p_payment_method_id(必須屬於這間商家,且 status=active,或編輯既有訂單時維持原值即使已下架也放行)+ out payment_method_name(快照文字來源)。其餘邏輯(服務項目/主要人員/助手/料錢成本/自訂工時)完全不動。p_exclude_booking_id 傳 null 代表 create_booking(新建),傳實際 booking id 代表 update_booking(編輯,排除自己原本的時段,也是付款方式下架例外的判斷依據)。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) from public, anon;
grant execute on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) to authenticated;

-- =========================================================================
-- §3.2:create_booking——p_payment_method text 改成 p_payment_method_id uuid(位置不變,仍是
-- 第 20 個參數),呼叫 validate_booking_selection 多傳一個參數,insert 欄位換成
-- payment_method_id/payment_method_name_snapshot 兩欄。其餘邏輯完全不動。
-- =========================================================================
drop function if exists public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer);

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
  p_payment_method_id uuid default null,
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

  -- 2~7. 共用驗證邏輯(規則 3.5 第 7 點,模組 6 §2.2/§4.3 調整、模組 9 v2 新增付款方式驗證):
  --      服務項目/主要人員/助手邊界衝突/料錢成本開關/付款方式,並取得 end_at(§4.3:自訂工時
  --      開啟時採用自訂值)+ 服務項目小計 + 付款方式名稱快照。
  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
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
    final_amount_snapshot, payment_method_id, payment_method_name_snapshot,
    custom_duration_enabled, custom_duration_minutes
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

comment on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer) is '對應訂單管理規格書 §4.1~4.8(含 §4.3 自訂工時)、模組 9 v2:手動建單。p_payment_method_id(第 20 個參數)從 v1 的 text 代碼改成 uuid,指向商家自訂 payment_methods 清單,寫入時同時存 payment_method_id + payment_method_name_snapshot(建立當下的名稱快照,商家事後改名/下架不影響)。其餘邏輯不變:金額計算透過 private.calculate_booking_amount 共用(§2.3),排程驗證透過 private.validate_booking_selection 共用,建立後狀態固定是 pending_confirmation。';

revoke execute on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer) from public, anon;
grant execute on function public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer) to authenticated;

-- =========================================================================
-- §3.2:update_booking——同樣的簽章變更,理由跟 create_booking 完全一致。
-- =========================================================================
drop function if exists public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, text, boolean, integer);

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
  p_payment_method_id uuid default null,
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
  --    (規則 3.5 第 3 點:所有時段重疊查詢都加上 and b.id <> p_booking_id),同時也是模組 9 v2
  --    「維持原付款方式即使已下架仍放行」例外規則的判斷依據。
  select * into v_sel from private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
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
    payment_method_id = p_payment_method_id,
    payment_method_name_snapshot = v_sel.payment_method_name,
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

comment on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer) is '對應訂單管理規格書 §4.1~4.8/§2.4/§4.3、模組 9 v2:編輯已建立訂單,一併更新自訂工時開關(§4.3)與付款方式(p_payment_method_id,uuid,含維持原值即使已下架也放行的例外規則,見 private.validate_booking_selection)。**§2.4 編輯不變動原則的關鍵**:這支函式完全不記憶「客服到底有沒有改欄位」,只是單純用呼叫端這次傳入的值重新算一次。其餘邏輯不變:pending_confirmation/accepted 狀態下可用,依商家 industry_type 判斷客戶地址是否必填,排程驗證邏輯透過 private.validate_booking_selection 共用,不會改變 status 欄位。';

revoke execute on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer) from public, anon;
grant execute on function public.update_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer) to authenticated;

-- =========================================================================
-- §3.3:update_booking_payment_method——輕量的單欄位讀寫介面,p_payment_method text 改成
-- p_payment_method_id uuid。型別改變,一律先 drop 再重建(踩坑提醒見檔頭)。
-- =========================================================================
drop function if exists public.update_booking_payment_method(uuid, text);

create function public.update_booking_payment_method(
  p_booking_id uuid,
  p_payment_method_id uuid default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_payment_method_name text;
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

  if p_payment_method_id is not null then
    -- 跟 private.validate_booking_selection 同樣的放行邏輯:status='active',或是這筆訂單本來
    -- 就已經是這個值(不強制因為商家事後下架而擋下「沒有真的要換」的操作)。
    select name into v_payment_method_name
    from public.payment_methods
    where id = p_payment_method_id
      and merchant_id = v_merchant_id
      and (
        status = 'active'
        or exists (
          select 1 from public.bookings
          where id = p_booking_id and payment_method_id = p_payment_method_id
        )
      );

    if not found then
      raise exception '找不到這個付款方式,或已下架';
    end if;
  else
    v_payment_method_name := null;
  end if;

  update public.bookings
  set payment_method_id = p_payment_method_id,
      payment_method_name_snapshot = v_payment_method_name,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_booking_payment_method(uuid, uuid) is '對應模組 9 v2:單獨更新一筆預約的付款方式(FK+快照兩欄一起寫),不需要傳服務項目/金額等其餘欄位。權限/狀態限制跟 update_booking 一致。傳 null 代表清空成「尚未設定」。目前秒約內部前端沒有任何頁面呼叫這支(CalendarPage 走完整的 update_booking),保留純粹是模組獨立性的對外介面,供之後其他模組(例如未來的客戶端付款頁)直接複用。';

revoke execute on function public.update_booking_payment_method(uuid, uuid) from public, anon;
grant execute on function public.update_booking_payment_method(uuid, uuid) to authenticated;
