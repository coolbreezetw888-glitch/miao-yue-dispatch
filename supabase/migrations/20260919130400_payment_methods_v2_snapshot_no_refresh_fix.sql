-- 模組 9(支付方式)v2 — 主腦複查抓到的邏輯漏洞修正。
-- 對應規格書 .project/specs/支付方式.md(v2)§2.4「編輯不變動原則」的同一種精神,
-- 修正 20260919130100_payment_methods_v2_functions.sql 的一個實作疏失。
--
-- **問題**:private.validate_booking_selection 的第 6 步、update_booking_payment_method,
-- 只要 p_payment_method_id 不是 null,一律無條件重新查詢 payment_methods.name 當作快照文字。
-- 編輯表單(CalendarPage.tsx)本來就會把訂單原本的 payment_method_id 帶入表單,客服如果根本
-- 沒有去動付款方式欄位、只改了別的欄位(例如客戶電話),送出的 p_payment_method_id 會跟訂單
-- 原本已經存的值完全一樣——但因為無條件重新查詢,商家事後把這個付款方式改名字,
-- payment_method_name_snapshot 就會被無條件洗成新名字,違反使用者「訂單歷史都必須保留當初的
-- 結果,不應該跟著改動」的核心要求。update_booking_payment_method 有完全相同的問題。
--
-- **修正邏輯**:如果這是編輯既有訂單(p_exclude_booking_id / p_booking_id 不是 null)、且這個
-- payment_method_id 剛好就是這筆訂單目前已經存的值(客服沒有主動更換付款方式),直接沿用既有的
-- payment_method_name_snapshot,不重新查詢 payment_methods.name。只有「新建立」或「客服主動選了
-- 不同的付款方式」這兩種情況,才查詢目前的名稱當作新快照。
--
-- **這跟 duration_minutes_snapshot「每次都重新查詢」的既有做法不是同一種性質**:工時快照是拿去
-- 做排程運算的值,重新查詢是為了確保排程正確;付款方式名稱是純顯示值,跟金額快照(§2.4 編輯
-- 不變動原則)是同一種精神,不能比照 duration_minutes_snapshot 的做法。
--
-- 兩支函式的參數簽章都沒有變動,直接用 create or replace 即可(比照 20260919130300 的既有修正
-- migration 慣例,不修改已套用的原始 migration 檔案本體,另開一支修正檔案)。

-- =========================================================================
-- private.validate_booking_selection——只改第 6 步,其餘 1~5 步完全比照原檔案不動。
-- =========================================================================
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

  -- 6. 付款方式(模組 9 v2,2026-09-19 主腦複查修正快照被意外洗新的問題):必須屬於這間商家。
  --    **關鍵修正**:如果這是編輯既有訂單(p_exclude_booking_id 不是 null)、且這個
  --    payment_method_id 剛好就是這筆訂單目前已經存的值(客服沒有主動更換付款方式),
  --    直接沿用既有的 payment_method_name_snapshot,不重新查詢 payment_methods.name——
  --    避免商家事後把這個付款方式改名字,連帶讓「沒有主動變更付款方式」的編輯動作意外把
  --    歷史訂單的顯示名稱洗成新名字,違反使用者明確要求的「訂單歷史不受商家事後異動影響」。
  --    這跟金額快照(§2.4 編輯不變動原則)是同一種精神,不能比照 duration_minutes_snapshot
  --    「每次都重新查詢」的做法(工時快照是拿去做排程運算的值,付款方式名稱是純顯示值,
  --    兩者性質不同)。
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

comment on function private.validate_booking_selection(uuid, uuid, jsonb, timestamptz, uuid[], uuid[], uuid, boolean, integer, uuid) is '對應規則 3.5 第 7 點,模組 9 v2 新增付款方式驗證:create_booking/update_booking 共用的驗證邏輯。新增 p_payment_method_id(必須屬於這間商家,且 status=active,或編輯既有訂單時維持原值即使已下架也放行)+ out payment_method_name(快照文字來源)。其餘邏輯(服務項目/主要人員/助手/料錢成本/自訂工時)完全不動。p_exclude_booking_id 傳 null 代表 create_booking(新建),傳實際 booking id 代表 update_booking(編輯,排除自己原本的時段,也是付款方式下架例外的判斷依據)。修正紀錄(2026-09-19,主腦複查):編輯既有訂單且 payment_method_id 維持原值時,沿用既有 payment_method_name_snapshot,不重新查詢 payment_methods.name——避免商家事後改名連帶洗掉沒有主動變更付款方式的歷史訂單顯示文字(見 20260919130400 修正 migration)。只有新建立或客服主動選了不同的付款方式,才查詢目前名稱當作新快照。只給本模組內部函式呼叫,不對外暴露。';

-- =========================================================================
-- public.update_booking_payment_method——同樣的修正,參數簽章不變。
-- =========================================================================
create or replace function public.update_booking_payment_method(
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
    -- 修正(2026-09-19,主腦複查):如果這個 payment_method_id 剛好就是這筆訂單目前已存的值,
    -- 沿用既有快照文字,不重新查詢目前名稱(理由同 private.validate_booking_selection)。
    select payment_method_name_snapshot into v_payment_method_name
    from public.bookings
    where id = p_booking_id and payment_method_id = p_payment_method_id;

    if v_payment_method_name is null then
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

comment on function public.update_booking_payment_method(uuid, uuid) is '對應模組 9 v2:單獨更新一筆預約的付款方式(FK+快照兩欄一起寫),不需要傳服務項目/金額等其餘欄位。權限/狀態限制跟 update_booking 一致。傳 null 代表清空成「尚未設定」。目前秒約內部前端沒有任何頁面呼叫這支(CalendarPage 走完整的 update_booking),保留純粹是模組獨立性的對外介面,供之後其他模組(例如未來的客戶端付款頁)直接複用。修正紀錄(2026-09-19,主腦複查):p_payment_method_id 維持這筆訂單原值時,沿用既有 payment_method_name_snapshot,不重新查詢 payment_methods.name(見 20260919130400 修正 migration),避免商家事後改名連帶洗掉沒有主動變更付款方式的歷史訂單顯示文字。';
