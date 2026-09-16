-- 模組 5:行事曆與預約核心引擎(功能/RLS 層)
-- 對應規格書第三節 3.1(private.can_manage_business_hours/can_manage_bookings)、
-- private.normalize_phone(規則 2.6 用的輔助函式)、3.3(create_booking)、3.4(cancel_booking)、
-- 3.5(complete_booking)、3.6(get_merchant_day_schedule)、3.7(RLS 政策總覽)、
-- 1.4/規則 2.4(merchant_feature_flags 補 UPDATE 政策)。

-- =========================================================================
-- 3.1 private.can_manage_business_hours(p_merchant_id uuid) / private.can_manage_bookings(p_merchant_id uuid)
-- 比照模組 4 private.can_manage_service_items 的既有寫法:商家管理員永遠可以,
-- 或該商家目前有效(status=active)的客服且被開通對應 section_key。
-- 規則 2.12:business_hours 涵蓋商家整體營業時間 + 服務人員可預約時段 + 嚴格工時衝突檢查開關;
-- orders 涵蓋建立/取消/標記完成預約。
-- =========================================================================
create or replace function private.can_manage_business_hours(p_merchant_id uuid)
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
        and map.section_key = 'business_hours'
        and map.granted = true
    );
$$;

comment on function private.can_manage_business_hours(uuid) is '是否能管理該商家的營業時間/服務人員可預約時段/嚴格工時衝突檢查開關(對應規格書 3.1、規則 2.12 第 1 點):商家管理員永遠可以,或是該商家目前有效的客服且被開通 business_hours 這個 section_key。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_manage_business_hours(uuid) from public, anon;
grant execute on function private.can_manage_business_hours(uuid) to authenticated;

create or replace function private.can_manage_bookings(p_merchant_id uuid)
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
        and map.section_key = 'orders'
        and map.granted = true
    );
$$;

comment on function private.can_manage_bookings(uuid) is '是否能建立/取消/標記完成該商家的預約,以及查詢該商家的行事曆/預約清單(對應規格書 3.1、規則 2.12 第 2 點):商家管理員永遠可以,或是該商家目前有效的客服且被開通 orders 這個 section_key。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_manage_bookings(uuid) from public, anon;
grant execute on function private.can_manage_bookings(uuid) to authenticated;

-- =========================================================================
-- 規格書沒有明列、工程師實作時發現必要的輔助函式:private.staff_merchant_id
-- staff_availability_windows 沒有 merchant_id 欄位,原本規劃直接在 RLS 政策裡 join
-- merchant_staff 表判斷 merchant_id 再呼叫 can_manage_business_hours——但 merchant_staff 自己的
-- SELECT RLS 政策(模組 3)只允許 is_merchant_admin,被開通 business_hours 的「客服」在這個 join
-- 子查詢裡會因為看不到 merchant_staff 那一列而被誤判成「找不到」,導致本來應該放行的客服被錯誤擋下
-- (這是實作時用真實情境測出來、規格書沒有預見到的坑)。修法:比照 private.is_merchant_admin 等
-- 既有函式的做法,包一支 SECURITY DEFINER 函式繞過 merchant_staff 的 RLS 限制,只回傳 merchant_id
-- 這個單一純量值(不洩漏其他欄位),再拿這個 merchant_id 去呼叫 can_manage_business_hours。
-- =========================================================================
create or replace function private.staff_merchant_id(p_staff_id uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select merchant_id from public.merchant_staff where id = p_staff_id;
$$;

comment on function private.staff_merchant_id(uuid) is '回傳指定服務人員所屬的 merchant_id,SECURITY DEFINER 繞過 merchant_staff 本身的 RLS(該表 RLS 只允許 is_merchant_admin,會誤擋被開通 business_hours 的客服),只給 staff_availability_windows 的 RLS 政策內部呼叫,不對外暴露、不回傳除 merchant_id 以外的任何欄位。';

revoke execute on function private.staff_merchant_id(uuid) from public, anon;
grant execute on function private.staff_merchant_id(uuid) to authenticated;

-- =========================================================================
-- 規格書沒有獨立編號、規則 2.6 用的輔助函式:private.normalize_phone
-- 去除所有非數字字元後比對,NULL 或去除後變成空字串一律視為 NULL(不比對)。
-- =========================================================================
create or replace function private.normalize_phone(p_phone text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(regexp_replace(p_phone, '[^0-9]', '', 'g'), '');
$$;

comment on function private.normalize_phone(text) is '正規化電話號碼(規則 2.6):去除所有非數字字元,NULL 或去除後為空字串一律回傳 NULL(代表不比對)。只給本模組內部函式(create_booking/get_merchant_day_schedule)呼叫。已知限制:不處理國碼/分機號差異,見規格書第七節。';

revoke execute on function private.normalize_phone(text) from public, anon;
grant execute on function private.normalize_phone(text) to authenticated;

-- =========================================================================
-- 3.3 create_booking(...)
-- SECURITY DEFINER,public schema。逐條驗證規則 2.1、2.2、2.3、2.4、2.6,通過後以 status='accepted'
-- 插入一筆預約(規則 2.9 第 1 點:手動建單一律直接視為已確定成立,沒有中間態需要跑)。
-- =========================================================================
create or replace function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_item_id uuid,
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_service public.service_items;
  v_staff public.merchant_staff;
  v_end_at timestamptz;
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
  v_conflict_count int;
  v_created_by_role text;
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

  -- 2. 服務項目:必須屬於這間商家、status='active',取得工時算出 end_at(快照,不受之後異動影響)
  select * into v_service
  from public.service_items
  where id = p_service_item_id and merchant_id = p_merchant_id and status = 'active';
  if not found then
    raise exception '找不到這個服務項目,或這個服務項目已下架';
  end if;

  v_end_at := p_start_at + make_interval(mins => v_service.duration_minutes);

  -- 3. 服務人員:必須屬於這間商家、status='active'
  select * into v_staff
  from public.merchant_staff
  where id = p_staff_id and merchant_id = p_merchant_id and status = 'active';
  if not found then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  -- 4. 規則 2.3:unlimited_backend_edit + can_manage_bookings(已在第 1 步驗證過)時跳過邊界檢查
  v_bypass_bounds := v_staff.unlimited_backend_edit;

  if not v_bypass_bounds then
    -- 這次不支援跨午夜的營業時間/預約,起訖必須落在同一個 Asia/Taipei 日曆日,
    -- 避免用「單一天的營業時間設定」去比對橫跨兩天的時段,造成誤判(規格書「本模組明確不做的事」)。
    if date(p_start_at at time zone 'Asia/Taipei') <> date(v_end_at at time zone 'Asia/Taipei') then
      raise exception '這個預約時段跨到隔天,目前系統不支援,請拆成同一天內的時段';
    end if;

    v_day_of_week := extract(dow from (p_start_at at time zone 'Asia/Taipei'))::smallint;
    v_local_start := (p_start_at at time zone 'Asia/Taipei')::time;
    v_local_end := (v_end_at at time zone 'Asia/Taipei')::time;

    -- 規則 2.1:商家整體營業時間邊界
    select true, is_closed, open_time, close_time
    into v_has_hours, v_is_closed, v_open_time, v_close_time
    from public.merchant_business_hours
    where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

    if not found or v_is_closed then
      raise exception '這天不是營業時間,或商家尚未設定這天的營業時間,無法建立預約';
    end if;

    if v_local_start < v_open_time or v_local_end > v_close_time then
      raise exception '這個時段超出商家營業時間(%到%)', v_open_time, v_close_time;
    end if;

    -- 規則 2.2:服務人員個別可預約時段邊界,除非 no_time_slot_limit = true
    if not v_staff.no_time_slot_limit then
      select exists (
        select 1 from public.staff_availability_windows
        where staff_id = p_staff_id
          and day_of_week = v_day_of_week
          and start_time <= v_local_start
          and end_time >= v_local_end
      ) into v_window_ok;

      if not v_window_ok then
        raise exception '這個時段超出這位服務人員可預約的時段設定,或這位服務人員尚未設定可預約時段';
      end if;
    end if;
  end if;

  -- 5. 規則 2.4/2.6:重疊檢查(邊界檢查一律強制執行,只有 2.3 的例外能跳過;重疊檢查則受
  --    strict_conflict_check 開關控制,兩者是獨立的判斷維度)。
  select enabled into v_strict_conflict
  from public.merchant_feature_flags
  where merchant_id = p_merchant_id and feature_key = 'strict_conflict_check';
  if v_strict_conflict is null then
    v_strict_conflict := true; -- 查無資料視為預設開啟(規格書 1.4)
  end if;

  if v_strict_conflict then
    -- 5a. 同商家同一位服務人員(同一筆 merchant_staff.id)是否有時段重疊的未取消預約
    select count(*) into v_conflict_count
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_end_at
      and b.end_at > p_start_at;

    if v_conflict_count > 0 then
      raise exception '這個時段這位服務人員已經有其他預約';
    end if;

    -- 5b. 規則 2.6:跨商家電話比對——系統內所有商家中電話正規化後相同、且不是同一筆
    --     merchant_staff.id 的紀錄,一併檢查是否有時段重疊的未取消預約。
    v_normalized_phone := private.normalize_phone(v_staff.phone);
    if v_normalized_phone is not null then
      select count(*) into v_conflict_count
      from public.bookings b
      join public.merchant_staff ms2 on ms2.id = b.staff_id
      where ms2.id <> p_staff_id
        and private.normalize_phone(ms2.phone) = v_normalized_phone
        and b.status <> 'cancelled'
        and b.start_at < v_end_at
        and b.end_at > p_start_at;

      if v_conflict_count > 0 then
        raise exception '這個時段這位服務人員在另一間店已經有預約';
      end if;
    end if;
  end if;

  -- 6. 通過後寫入,狀態直接是 accepted(規則 2.9 第 1 點)
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, service_item_id, start_at, end_at,
    customer_name, customer_phone, customer_email, notes,
    source, created_by_role, created_by_user_id, status
  ) values (
    p_merchant_id, p_staff_id, p_service_item_id, p_start_at, v_end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''), p_notes,
    'manual', v_created_by_role, auth.uid(), 'accepted'
  )
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.create_booking(uuid, uuid, uuid, timestamptz, text, text, text, text) is '對應規格書 3.3:手動建單。逐條驗證規則 2.1(商家營業時間)、2.2(服務人員時段)、2.3(unlimited_backend_edit 覆寫例外)、2.4(嚴格工時衝突檢查開關)、2.6(跨商家電話比對),通過後以 status=accepted 寫入。這是本模組風險最高、pgTAP 覆蓋最完整的函式。';

revoke execute on function public.create_booking(uuid, uuid, uuid, timestamptz, text, text, text, text) from public, anon;
grant execute on function public.create_booking(uuid, uuid, uuid, timestamptz, text, text, text, text) to authenticated;

-- =========================================================================
-- 3.4 cancel_booking(p_booking_id uuid, p_reason text)
-- 只接受 p_booking_id 一個識別參數,從資料庫內部查出 merchant_id 再做權限檢查
-- (不能讓呼叫端自己傳入 merchant_id,避免偽造商家 id 繞過權限檢查)。
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

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以取消,目前狀態不允許這個操作';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_at = now(), cancelled_reason = p_reason
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.cancel_booking(uuid, text) is '對應規格書 3.4/規則 2.9:取消預約。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查,避免呼叫端偽造商家 id 繞過權限。只有 accepted 狀態能轉成 cancelled。不算危險操作(規則 2.10),不需要 JSON 備份。';

revoke execute on function public.cancel_booking(uuid, text) from public, anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

-- =========================================================================
-- 3.5 complete_booking(p_booking_id uuid)
-- =========================================================================
create or replace function public.complete_booking(p_booking_id uuid)
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

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以標記完成,目前狀態不允許這個操作';
  end if;

  update public.bookings
  set status = 'completed', completed_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.complete_booking(uuid) is '對應規格書 3.5/規則 2.9:標記完成。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查。只有 accepted 狀態能轉成 completed。不算危險操作(規則 2.10),不需要 JSON 備份。';

revoke execute on function public.complete_booking(uuid) from public, anon;
grant execute on function public.complete_booking(uuid) to authenticated;

-- =========================================================================
-- 3.6 get_merchant_day_schedule(p_merchant_id uuid, p_date date)
-- 回傳當天(Asia/Taipei 日曆日)所有 status='active' 服務人員的可預約邊界、本店預約明細、
-- 跨商家占用概況(不洩漏對方客戶/服務項目細節,規則 2.6 第 3 點)。
-- 回傳 jsonb,結構見下方欄位說明,供 4.3 行事曆頁面 / 5.3 對外介面 useMerchantDaySchedule 使用。
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
      -- 本店預約(規則 2.6 第 3 點:完整顯示客戶/服務項目資訊,因為是自家資料)
      'bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', b.id,
            'start_at', b.start_at,
            'end_at', b.end_at,
            'status', b.status,
            'customer_name', b.customer_name,
            'customer_phone', b.customer_phone,
            'notes', b.notes,
            'service_item_id', b.service_item_id,
            'service_item_name', si.name
          )
          order by b.start_at
        )
        from public.bookings b
        join public.service_items si on si.id = b.service_item_id
        where b.staff_id = ms.id
          and b.merchant_id = p_merchant_id
          and b.status <> 'cancelled'
          and b.start_at < v_day_end
          and b.end_at > v_day_start
      ), '[]'::jsonb),
      -- 跨商家占用(規則 2.6 第 3 點:只回傳起訖時間,不回傳對方的客戶/商家細節)
      'foreign_bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at)
          order by fb.start_at
        )
        from public.bookings fb
        join public.merchant_staff fms on fms.id = fb.staff_id
        where fms.id <> ms.id
          and private.normalize_phone(fms.phone) is not null
          and private.normalize_phone(fms.phone) = private.normalize_phone(ms.phone)
          and fb.status <> 'cancelled'
          and fb.start_at < v_day_end
          and fb.end_at > v_day_start
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

comment on function public.get_merchant_day_schedule(uuid, date) is '對應規格書 3.6/5.3:給行事曆總覽頁使用,回傳當天(Asia/Taipei)所有在職服務人員的可預約邊界(規則 2.1 ∩ 2.2 交集)、本店預約明細、跨商家占用概況(不洩漏對方客戶/商家細節,規則 2.6 第 3 點)。回傳 jsonb。';

revoke execute on function public.get_merchant_day_schedule(uuid, date) from public, anon;
grant execute on function public.get_merchant_day_schedule(uuid, date) to authenticated;

-- =========================================================================
-- 3.7 RLS 政策總覽
-- =========================================================================
alter table public.merchant_business_hours enable row level security;
alter table public.staff_availability_windows enable row level security;
alter table public.bookings enable row level security;

-- merchant_business_hours:CRUD 一律要求 can_manage_business_hours。
create policy merchant_business_hours_select on public.merchant_business_hours
  for select to authenticated
  using (private.can_manage_business_hours(merchant_id));

create policy merchant_business_hours_insert on public.merchant_business_hours
  for insert to authenticated
  with check (private.can_manage_business_hours(merchant_id));

create policy merchant_business_hours_update on public.merchant_business_hours
  for update to authenticated
  using (private.can_manage_business_hours(merchant_id))
  with check (private.can_manage_business_hours(merchant_id));

create policy merchant_business_hours_delete on public.merchant_business_hours
  for delete to authenticated
  using (private.can_manage_business_hours(merchant_id));

-- staff_availability_windows:沒有 merchant_id 欄位,透過 private.staff_merchant_id(staff_id)
-- 取得 merchant_id 再判斷 can_manage_business_hours——不能直接 join merchant_staff 表本身
-- (該表 SELECT RLS 只允許 is_merchant_admin,會誤擋被開通 business_hours 的客服,見上方
-- private.staff_merchant_id 的說明)。
create policy staff_availability_windows_select on public.staff_availability_windows
  for select to authenticated
  using (private.can_manage_business_hours(private.staff_merchant_id(staff_id)));

create policy staff_availability_windows_insert on public.staff_availability_windows
  for insert to authenticated
  with check (private.can_manage_business_hours(private.staff_merchant_id(staff_id)));

create policy staff_availability_windows_update on public.staff_availability_windows
  for update to authenticated
  using (private.can_manage_business_hours(private.staff_merchant_id(staff_id)))
  with check (private.can_manage_business_hours(private.staff_merchant_id(staff_id)));

create policy staff_availability_windows_delete on public.staff_availability_windows
  for delete to authenticated
  using (private.can_manage_business_hours(private.staff_merchant_id(staff_id)));

-- bookings:SELECT 要求 can_manage_bookings(merchant_id);沒有 INSERT/UPDATE/DELETE 政策——
-- 一律透過 create_booking/cancel_booking/complete_booking 這幾支 SECURITY DEFINER 函式寫入
-- (規則 2.10:沒有 DELETE 政策,任何角色都不能真刪除一筆預約)。
create policy bookings_select on public.bookings
  for select to authenticated
  using (private.can_manage_bookings(merchant_id));

-- =========================================================================
-- 1.4/規則 2.4:merchant_feature_flags 補上 UPDATE 政策,沿用模組 1 既有的 getFeatureFlag/setFeatureFlag
-- 對外介面,寫入權限比照規則 2.12 第 1 點,歸在 business_hours 這個 section_key 底下。
-- =========================================================================
create policy merchant_feature_flags_update on public.merchant_feature_flags
  for update to authenticated
  using (private.can_manage_business_hours(merchant_id))
  with check (private.can_manage_business_hours(merchant_id));
