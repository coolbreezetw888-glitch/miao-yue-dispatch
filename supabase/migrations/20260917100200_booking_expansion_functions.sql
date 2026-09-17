-- 模組 5 擴充:建單功能擴充(功能/RLS 層)
-- 對應規格書 4.4(private.can_manage_material_costs)、4.5(material_cost_items RLS)、
-- 4.6(booking_service_items/booking_assistants/booking_material_costs RLS +
-- private.booking_merchant_id)、規則 3.5 第 7 點(private.validate_booking_selection 共用驗證邏輯)、
-- 4.1(create_booking 簽章擴充)、4.8(confirm_booking)、4.9(update_booking)、2.4/規則 3.4
-- (cancel_booking 放寬)、4.2(get_merchant_day_schedule 調整)。

-- =========================================================================
-- 4.4 private.can_manage_material_costs(p_merchant_id uuid)
-- 比照 private.can_manage_service_items 的既有寫法(規格書 4.4)。
-- =========================================================================
create or replace function private.can_manage_material_costs(p_merchant_id uuid)
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
        and map.section_key = 'material_costs'
        and map.granted = true
    );
$$;

comment on function private.can_manage_material_costs(uuid) is '是否能管理該商家的料錢成本品項清單(對應規格書 2.3 決策記錄 4、4.4):商家管理員永遠可以,或是該商家目前有效的客服且被開通 material_costs 這個 section_key。建單/編輯時「勾選既有品項」不需要這個權限,只要有 orders 權限即可(見 create_booking/update_booking)。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_manage_material_costs(uuid) from public, anon;
grant execute on function private.can_manage_material_costs(uuid) to authenticated;

-- =========================================================================
-- 4.6 private.booking_merchant_id(p_booking_id uuid)
-- booking_service_items/booking_assistants/booking_material_costs 這三張表沒有 merchant_id 欄位,
-- 比照 private.staff_merchant_id 的既有解法(見 20260916140100_booking_functions.sql 的說明),
-- 包一支 SECURITY DEFINER 函式繞過 bookings 表本身的 RLS,只回傳 merchant_id 這個單一純量值。
-- =========================================================================
create or replace function private.booking_merchant_id(p_booking_id uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select merchant_id from public.bookings where id = p_booking_id;
$$;

comment on function private.booking_merchant_id(uuid) is '回傳指定預約所屬的 merchant_id,SECURITY DEFINER 繞過 bookings 本身的 RLS,只給 booking_service_items/booking_assistants/booking_material_costs 的 SELECT 政策內部呼叫,不對外暴露、不回傳除 merchant_id 以外的任何欄位。';

revoke execute on function private.booking_merchant_id(uuid) from public, anon;
grant execute on function private.booking_merchant_id(uuid) to authenticated;

-- =========================================================================
-- private.staff_booking_conflict_exists:某位服務人員在指定時段是否已經有未取消的預約
-- (不論是以「主要服務人員」bookings.staff_id 身份,或「助手」booking_assistants.staff_id 身份)。
-- 決策記錄 2 第 4 點:「助手在這個時段如果已經有其他未取消的預約(不論是以主要服務人員或助手身份)」
-- ——這條規則同時適用於主要服務人員自己(她/他也可能是別筆預約的助手),所以寫成通用函式,
-- 不分主要/助手角色呼叫。p_exclude_booking_id 給 update_booking 編輯時排除自己原本的紀錄用
-- (規則 3.5 第 3 點),create_booking 呼叫時傳 null。
-- =========================================================================
create or replace function private.staff_booking_conflict_exists(
  p_staff_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_booking_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < p_end_at
      and b.end_at > p_start_at
      and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
  ) or exists (
    select 1
    from public.booking_assistants ba
    join public.bookings b on b.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < p_end_at
      and b.end_at > p_start_at
      and (p_exclude_booking_id is null or b.id <> p_exclude_booking_id)
  );
$$;

comment on function private.staff_booking_conflict_exists(uuid, timestamptz, timestamptz, uuid) is '某位服務人員(依 merchant_staff.id)在指定時段是否已經有未取消的預約,同時檢查「主要服務人員」跟「助手」兩種身份(決策記錄 2 第 4 點)。p_exclude_booking_id 給編輯自己時排除原本的紀錄,傳 null 代表不排除(建立新預約時)。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.staff_booking_conflict_exists(uuid, timestamptz, timestamptz, uuid) from public, anon;
grant execute on function private.staff_booking_conflict_exists(uuid, timestamptz, timestamptz, uuid) to authenticated;

-- =========================================================================
-- private.check_staff_booking_slot:對「一位服務人員」(可能是主要服務人員,也可能是某位助手)
-- 執行完整的邊界檢查(規則 2.1/2.2/2.3)+ 衝突檢查(規則 2.4/2.6,含跨商家電話比對)。
-- create_booking/update_booking 對主要服務人員呼叫一次,對每一位助手各自再呼叫一次
-- (決策記錄 2:助手完全比照主要服務人員套用全部驗證規則)。
-- p_role_label 只用來組出白話錯誤訊息,方便使用者一眼看出是哪一位人員的時段有問題
-- (規格書 5.1 第 2 點:「失敗時的錯誤訊息要能清楚指出是哪一位助手的時段有問題」)。
-- =========================================================================
create or replace function private.check_staff_booking_slot(
  p_merchant_id uuid,
  p_staff public.merchant_staff,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_booking_id uuid,
  p_role_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass_bounds boolean;
  v_day_of_week smallint;
  v_local_start time;
  v_local_end time;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_window_ok boolean;
  v_strict_conflict boolean;
  v_normalized_phone text;
begin
  v_bypass_bounds := p_staff.unlimited_backend_edit;

  if not v_bypass_bounds then
    if date(p_start_at at time zone 'Asia/Taipei') <> date(p_end_at at time zone 'Asia/Taipei') then
      raise exception '%的預約時段跨到隔天,目前系統不支援,請拆成同一天內的時段', p_role_label;
    end if;

    v_day_of_week := extract(dow from (p_start_at at time zone 'Asia/Taipei'))::smallint;
    v_local_start := (p_start_at at time zone 'Asia/Taipei')::time;
    v_local_end := (p_end_at at time zone 'Asia/Taipei')::time;

    select true, is_closed, open_time, close_time
    into v_has_hours, v_is_closed, v_open_time, v_close_time
    from public.merchant_business_hours
    where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

    if not found or v_is_closed then
      raise exception '這天不是營業時間,或商家尚未設定這天的營業時間,%無法排定這個時段', p_role_label;
    end if;

    if v_local_start < v_open_time or v_local_end > v_close_time then
      raise exception '%的時段超出商家營業時間(%到%)', p_role_label, v_open_time, v_close_time;
    end if;

    if not p_staff.no_time_slot_limit then
      select exists (
        select 1 from public.staff_availability_windows
        where staff_id = p_staff.id
          and day_of_week = v_day_of_week
          and start_time <= v_local_start
          and end_time >= v_local_end
      ) into v_window_ok;

      if not v_window_ok then
        raise exception '%的時段超出可預約的時段設定,或尚未設定可預約時段', p_role_label;
      end if;
    end if;
  end if;

  select enabled into v_strict_conflict
  from public.merchant_feature_flags
  where merchant_id = p_merchant_id and feature_key = 'strict_conflict_check';
  if v_strict_conflict is null then
    v_strict_conflict := true; -- 查無資料視為預設開啟
  end if;

  if v_strict_conflict then
    if private.staff_booking_conflict_exists(p_staff.id, p_start_at, p_end_at, p_exclude_booking_id) then
      raise exception '%在這個時段已經有其他預約', p_role_label;
    end if;

    v_normalized_phone := private.normalize_phone(p_staff.phone);
    if v_normalized_phone is not null then
      if exists (
        select 1
        from public.merchant_staff ms2
        where ms2.id <> p_staff.id
          and private.normalize_phone(ms2.phone) = v_normalized_phone
          and private.staff_booking_conflict_exists(ms2.id, p_start_at, p_end_at, p_exclude_booking_id)
      ) then
        raise exception '%在這個時段已經在另一間店有預約', p_role_label;
      end if;
    end if;
  end if;
end;
$$;

comment on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) is '對單一位服務人員(主要服務人員或助手皆可)執行規則 2.1/2.2/2.3 邊界檢查 + 2.4/2.6 衝突檢查(含跨商家電話比對)。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次(決策記錄 2)。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) to authenticated;

-- =========================================================================
-- 規則 3.5 第 7 點:private.validate_booking_selection——create_booking/update_booking
-- 共用的驗證邏輯(服務項目檢查+工時加總、主要人員檢查、助手迴圈驗證、料錢成本開關檢查)。
-- 回傳算出來的 end_at,呼叫端(create_booking/update_booking)自己負責實際寫入/改寫三張關聯表。
-- p_exclude_booking_id 是 create_booking 跟 update_booking 唯一的差異來源:create_booking 傳
-- null,update_booking 傳自己的 p_booking_id,讓所有時段重疊查詢排除自己原本的紀錄(規則 3.5 第 3 點)。
-- =========================================================================
create or replace function private.validate_booking_selection(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_item_ids uuid[],
  p_start_at timestamptz,
  p_assistant_staff_ids uuid[],
  p_material_cost_item_ids uuid[],
  p_exclude_booking_id uuid
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_minutes int;
  v_found_count int;
  v_distinct_count int;
  v_end_at timestamptz;
  v_staff public.merchant_staff;
  v_assistant public.merchant_staff;
  v_assistant_id uuid;
  v_material_enabled boolean;
begin
  -- 1. 服務項目(規格書 2.1):至少選 1 個、不能重複、必須屬於這間商家且 status='active'。
  if p_service_item_ids is null or array_length(p_service_item_ids, 1) is null then
    raise exception '請至少選擇一個服務項目';
  end if;

  select count(*) into v_distinct_count
  from (select distinct unnest(p_service_item_ids)) u;
  if v_distinct_count <> array_length(p_service_item_ids, 1) then
    raise exception '同一個服務項目不能在同一筆預約裡選取兩次';
  end if;

  select coalesce(sum(duration_minutes), 0), count(*)
  into v_total_minutes, v_found_count
  from public.service_items
  where id = any(p_service_item_ids) and merchant_id = p_merchant_id and status = 'active';

  if v_found_count <> array_length(p_service_item_ids, 1) then
    raise exception '找不到其中一個服務項目,或這個服務項目已下架';
  end if;

  v_end_at := p_start_at + make_interval(mins => v_total_minutes);

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
    p_merchant_id, v_staff, p_start_at, v_end_at, p_exclude_booking_id, '主要服務人員'
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
        p_merchant_id, v_assistant, p_start_at, v_end_at, p_exclude_booking_id,
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

  return v_end_at;
end;
$$;

comment on function private.validate_booking_selection(uuid, uuid, uuid[], timestamptz, uuid[], uuid[], uuid) is '對應規則 3.5 第 7 點:create_booking/update_booking 共用的驗證邏輯(服務項目多選+工時加總、主要人員與每位助手的邊界/衝突/跨商家電話比對檢查、料錢成本開關檢查)。回傳算出來的 end_at。p_exclude_booking_id 傳 null 代表 create_booking(新建),傳實際 booking id 代表 update_booking(編輯,排除自己原本的時段)。只給本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.validate_booking_selection(uuid, uuid, uuid[], timestamptz, uuid[], uuid[], uuid) from public, anon;
grant execute on function private.validate_booking_selection(uuid, uuid, uuid[], timestamptz, uuid[], uuid[], uuid) to authenticated;

-- =========================================================================
-- 4.1 create_booking(...):破壞性簽章變更(舊簽章移除,重新建立新簽章)。
-- 舊的 4 個 uuid 參數版本(p_merchant_id, p_staff_id, p_service_item_id, p_start_at, ...)
-- 先明確 drop,避免正式環境同時存在新舊兩個重載版本造成混淆(PostgREST 對重載函式呼叫容易出錯)。
-- =========================================================================
drop function if exists public.create_booking(uuid, uuid, uuid, timestamptz, text, text, text, text);

create function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_item_ids uuid[],
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}',
  p_material_cost_item_ids uuid[] default '{}'
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end_at timestamptz;
  v_created_by_role text;
  v_booking_id uuid;
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

  -- 2~7. 共用驗證邏輯(規則 3.5 第 7 點):服務項目/主要人員/助手邊界衝突/料錢成本開關。
  v_end_at := private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_item_ids, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null
  );

  -- 8. 通過後在同一個交易裡寫入 bookings(狀態改為 pending_confirmation,決策記錄 5)
  --    + 三張關聯表(規格書 4.1 第 8 步)。任何一步失敗,整個函式呼叫(單一交易)rollback。
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, notes,
    source, created_by_role, created_by_user_id, status
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''), p_notes,
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation'
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
  select v_booking_id, si.id, si.duration_minutes
  from public.service_items si
  where si.id = any(p_service_item_ids);

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

comment on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]) is '對應建單功能擴充規格書 4.1(破壞性簽章變更,取代原本單一 p_service_item_id 版本):手動建單,服務項目改多選、新增助手清單、新增料錢成本品項清單。驗證邏輯透過 private.validate_booking_selection 共用(規則 3.5 第 7 點)。建立後狀態固定是 pending_confirmation(決策記錄 5),不再直接進 accepted。這是本次擴充風險最高、pgTAP 覆蓋最完整的函式。';

revoke execute on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]) from public, anon;
grant execute on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]) to authenticated;

-- =========================================================================
-- 4.9 update_booking(...):新增,編輯已建立訂單(決策記錄 6)。
-- =========================================================================
create or replace function public.update_booking(
  p_booking_id uuid,
  p_staff_id uuid,
  p_service_item_ids uuid[],
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}',
  p_material_cost_item_ids uuid[] default '{}'
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_end_at timestamptz;
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

  -- 4. 跟 create_booking 完全相同的驗證邏輯,唯一差異是傳入 p_booking_id 排除自己原本的時段
  --    (規則 3.5 第 3 點:所有時段重疊查詢都加上 and b.id <> p_booking_id)。
  v_end_at := private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_item_ids, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id
  );

  -- 5. 驗證通過後,同一個交易裡更新主體欄位(不改變 status,規則 3.5 第 5 點)+
  --    整批刪除重寫三張關聯表(規則 3.5 第 4 點,不做增量式差異比對)。
  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    notes = p_notes
  where id = p_booking_id;

  delete from public.booking_service_items where booking_id = p_booking_id;
  delete from public.booking_assistants where booking_id = p_booking_id;
  delete from public.booking_material_costs where booking_id = p_booking_id;

  insert into public.booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
  select p_booking_id, si.id, si.duration_minutes
  from public.service_items si
  where si.id = any(p_service_item_ids);

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

comment on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]) is '對應建單功能擴充規格書 4.9/決策記錄 6(新增):編輯已建立訂單,pending_confirmation/accepted 狀態下可用,completed/cancelled 一律擋下。驗證邏輯透過 private.validate_booking_selection 跟 create_booking 共用,唯一差異是排除自己原本的時段(規則 3.5 第 3 點)。實作方式是整批刪除重寫三張關聯表,不做增量式差異比對(規則 3.5 第 4 點)。不會改變 status 欄位(規則 3.5 第 5 點)。權限比照建單/確認(orders section_key)。';

revoke execute on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]) from public, anon;
grant execute on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]) to authenticated;

-- =========================================================================
-- 4.8 confirm_booking(p_booking_id uuid):新增,pending_confirmation -> accepted(決策記錄 5)。
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
  set status = 'accepted'
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.confirm_booking(uuid) is '對應建單功能擴充規格書 4.8/決策記錄 5(新增):把 pending_confirmation 轉成 accepted。權限比照建單權限(orders section_key),任何有 orders 權限的人都能操作,同一人建立後馬上自己確認也是允許的操作模式。已知限制(規格書 2.4):這次不重新驗證時段衝突。不算危險操作,不觸發任何通知(規格書「本模組明確不做的事」)。';

revoke execute on function public.confirm_booking(uuid) from public, anon;
grant execute on function public.confirm_booking(uuid) to authenticated;

-- =========================================================================
-- cancel_booking(p_booking_id uuid, p_reason text):放寬可取消狀態(決策記錄 5 第 4 點,
-- 取代原本只接受 accepted 的行為)。complete_booking 邏輯不變(仍只接受 accepted),
-- 這裡只是把錯誤訊息裡的「已接受」措辭改成跟畫面顯示一致的「已確認」(決策記錄 5)。
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
  set status = 'cancelled', cancelled_at = now(), cancelled_reason = p_reason
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.cancel_booking(uuid, text) is '對應建單功能擴充規格書 2.4/決策記錄 5 第 4 點(修改既有函式行為):取消預約,可取消狀態放寬成 pending_confirmation 或 accepted 都可以(原本只有 accepted),即「已完成之前的任何狀態都能取消」。completed/cancelled 兩個終止狀態不變,依然不能再變動。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查,避免呼叫端偽造商家 id 繞過權限。不算危險操作,不需要 JSON 備份。';

revoke execute on function public.cancel_booking(uuid, text) from public, anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

comment on function public.complete_booking(uuid) is '對應規格書 3.5/規則 2.9,建單功能擴充 2.4 第 3 點確認沿用不變:標記完成。只有 accepted 狀態能轉成 completed——也就是說一筆預約要先被 confirm_booking 確認過,才能標記完成,不能從 pending_confirmation 直接跳到 completed(規則 3.4 第 3 點,不開放跳過中間狀態)。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查。不算危險操作,不需要 JSON 備份。';

-- =========================================================================
-- 4.2 get_merchant_day_schedule(...) 調整:
--   1. service_item_name(單一字串)改成 service_items(陣列,每項含 id/name)。
--   2. 把「自己以助手身份參與」的預約也算進這位服務人員的 bookings 陣列,標示 role: 'main'|'assistant'。
--   3. foreign_bookings 同步涵蓋「以助手身份跨商家占用」的情境(決策記錄 2 第 4 點的自然延伸,
--      不然一位師傅只在別間店當「助手」的占用會被本函式漏掉,造成誤判可預約)。
-- =========================================================================
create or replace function public.get_merchant_day_schedule(
  p_merchant_id uuid,
  p_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_day_of_week smallint;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_staff jsonb;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的行事曆' using errcode = '42501';
  end if;

  v_day_of_week := extract(dow from p_date)::smallint;
  v_day_start := (p_date::timestamp) at time zone 'Asia/Taipei';
  v_day_end := ((p_date + 1)::timestamp) at time zone 'Asia/Taipei';

  select true, is_closed, open_time, close_time
  into v_has_hours, v_is_closed, v_open_time, v_close_time
  from public.merchant_business_hours
  where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

  select coalesce(jsonb_agg(staff_block), '[]'::jsonb)
  into v_staff
  from (
    select jsonb_build_object(
      'staff_id', ms.id,
      'staff_name', ms.name,
      'no_time_slot_limit', ms.no_time_slot_limit,
      'available_windows', (
        case
          when coalesce(v_has_hours, false) is false or coalesce(v_is_closed, true) then '[]'::jsonb
          when ms.no_time_slot_limit then
            jsonb_build_array(jsonb_build_object('start_time', v_open_time, 'end_time', v_close_time))
          else coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'start_time', greatest(saw.start_time, v_open_time),
                'end_time', least(saw.end_time, v_close_time)
              )
              order by saw.start_time
            )
            from public.staff_availability_windows saw
            where saw.staff_id = ms.id
              and saw.day_of_week = v_day_of_week
              and saw.start_time < v_close_time
              and saw.end_time > v_open_time
          ), '[]'::jsonb)
        end
      ),
      -- 本店預約(規則 2.6 第 3 點:完整顯示客戶/服務項目資訊,因為是自家資料)。
      -- 同時涵蓋「主要服務人員」跟「助手」兩種身份(4.2 第 2 點),用 role 欄位標示。
      'bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', bb.id,
            'start_at', bb.start_at,
            'end_at', bb.end_at,
            'status', bb.status,
            'customer_name', bb.customer_name,
            'customer_phone', bb.customer_phone,
            'notes', bb.notes,
            'role', bb.role,
            'service_items', coalesce(si_agg.items, '[]'::jsonb)
          )
          order by bb.start_at
        )
        from (
          select b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone, b.notes, 'main'::text as role
          from public.bookings b
          where b.staff_id = ms.id
            and b.merchant_id = p_merchant_id
            and b.status <> 'cancelled'
            and b.start_at < v_day_end
            and b.end_at > v_day_start
          union all
          select b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone, b.notes, 'assistant'::text as role
          from public.booking_assistants ba
          join public.bookings b on b.id = ba.booking_id
          where ba.staff_id = ms.id
            and b.merchant_id = p_merchant_id
            and b.status <> 'cancelled'
            and b.start_at < v_day_end
            and b.end_at > v_day_start
        ) bb
        left join lateral (
          select jsonb_agg(jsonb_build_object('id', si.id, 'name', si.name) order by si.name) as items
          from public.booking_service_items bsi
          join public.service_items si on si.id = bsi.service_item_id
          where bsi.booking_id = bb.id
        ) si_agg on true
      ), '[]'::jsonb),
      -- 跨商家占用(規則 2.6 第 3 點:只回傳起訖時間,不回傳對方的客戶/商家細節)。
      -- 同時涵蓋對方以「主要服務人員」或「助手」身份占用的情境。
      'foreign_bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at)
          order by fb.start_at
        )
        from (
          select fb.start_at, fb.end_at
          from public.bookings fb
          join public.merchant_staff fms on fms.id = fb.staff_id
          where fms.id <> ms.id
            and private.normalize_phone(fms.phone) is not null
            and private.normalize_phone(fms.phone) = private.normalize_phone(ms.phone)
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
          union all
          select fb.start_at, fb.end_at
          from public.booking_assistants fba
          join public.bookings fb on fb.id = fba.booking_id
          join public.merchant_staff fms on fms.id = fba.staff_id
          where fms.id <> ms.id
            and private.normalize_phone(fms.phone) is not null
            and private.normalize_phone(fms.phone) = private.normalize_phone(ms.phone)
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
        ) fb
      ), '[]'::jsonb)
    ) as staff_block
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id and ms.status = 'active'
    order by ms.name
  ) staff_blocks;

  return jsonb_build_object(
    'date', p_date,
    'business_hours', jsonb_build_object(
      'has_setting', coalesce(v_has_hours, false),
      'is_closed', coalesce(v_is_closed, true),
      'open_time', v_open_time,
      'close_time', v_close_time
    ),
    'staff', v_staff
  );
end;
$$;

comment on function public.get_merchant_day_schedule(uuid, date) is '對應規格書 3.6/5.3,建單功能擴充 4.2 調整:給行事曆總覽頁使用,回傳當天(Asia/Taipei)所有在職服務人員的可預約邊界、本店預約明細(含多服務項目陣列、main/assistant 角色標示)、跨商家占用概況(含對方以助手身份占用的情境,不洩漏對方客戶/商家細節)。回傳 jsonb。';

-- =========================================================================
-- 4.5 material_cost_items 的 RLS 政策
-- =========================================================================
alter table public.material_cost_items enable row level security;

create policy material_cost_items_select on public.material_cost_items
  for select to authenticated
  using (private.can_manage_material_costs(merchant_id));

create policy material_cost_items_insert on public.material_cost_items
  for insert to authenticated
  with check (private.can_manage_material_costs(merchant_id));

create policy material_cost_items_update on public.material_cost_items
  for update to authenticated
  using (private.can_manage_material_costs(merchant_id))
  with check (private.can_manage_material_costs(merchant_id));

-- 沒有 DELETE 政策(規則 3.1:軟刪除,不算危險操作但也不做真刪除,比照模組 4 service_items 的既有模式)。

-- =========================================================================
-- 4.6 booking_service_items/booking_assistants/booking_material_costs 的 RLS 政策
-- 只有 SELECT,沒有 INSERT/UPDATE/DELETE(規則 3.2:一律透過 create_booking/update_booking 寫入)。
-- =========================================================================
alter table public.booking_service_items enable row level security;
alter table public.booking_assistants enable row level security;
alter table public.booking_material_costs enable row level security;

create policy booking_service_items_select on public.booking_service_items
  for select to authenticated
  using (private.can_manage_bookings(private.booking_merchant_id(booking_id)));

create policy booking_assistants_select on public.booking_assistants
  for select to authenticated
  using (private.can_manage_bookings(private.booking_merchant_id(booking_id)));

create policy booking_material_costs_select on public.booking_material_costs
  for select to authenticated
  using (private.can_manage_bookings(private.booking_merchant_id(booking_id)));
