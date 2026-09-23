-- SPECS-INDEX #644:seed 函式、寫入函式、服務人員自助讀取函式,疊加
-- create_group_and_merchant/create_merchant_in_group、既有商家回歸補值。
--
-- ⚠️ 動工前查證:create_group_and_merchant/create_merchant_in_group 目前「最新」的一份 migration
-- 是 20260922160300_req620_merchant_booking_status_colors_functions.sql(疊加
-- seed_default_booking_status_colors 那一支,timestamp 在本次之前排最後,之後沒有任何 migration
-- 再動過這兩支函式),下面用 create or replace 在原有基礎上只新增一行
-- perform seed_default_merchant_calendar_state_styles 呼叫,逐字保留其餘既有的 perform 呼叫順序,
-- 不重建。

-- =========================================================================
-- seed_default_merchant_calendar_state_styles:新商家建立當下自動種入三種狀態的預設顏色。
-- 直接寫死三筆 insert(不是資料表 DEFAULT 值——這張表的 color 欄位沒有 DEFAULT,因為每個
-- state_type 的預設色不同,不能共用同一個欄位層級 DEFAULT),on conflict do nothing 保持冪等,
-- 可安全重複呼叫。三個色碼跟上一支 schema migration 開頭註解說明的選色理由一致。
-- =========================================================================
create or replace function public.seed_default_merchant_calendar_state_styles(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
  values
    (p_merchant_id, 'full_day_leave', '#78716c'),
    (p_merchant_id, 'partial_leave', '#a8a29e'),
    (p_merchant_id, 'cross_store_occupied', '#c2410c')
  on conflict (merchant_id, state_type) do nothing;
end;
$$;

comment on function public.seed_default_merchant_calendar_state_styles(uuid) is 'SPECS-INDEX #644:新商家建立時種入 3 種行事曆排程狀態的預設顏色。冪等,重複呼叫不會產生第二批,也不會覆蓋商家已經自訂過的顏色。';

revoke execute on function public.seed_default_merchant_calendar_state_styles(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_merchant_calendar_state_styles(uuid) to service_role, postgres;

-- =========================================================================
-- 疊加 create_group_and_merchant(2026-09-23 查證 20260922160300 版本為目前最新,只新增最後一行
-- 呼叫)。
-- =========================================================================
create or replace function public.create_group_and_merchant(
  p_name text,
  p_industry_type text,
  p_address text default null::text,
  p_contact_email text default null::text,
  p_intro text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  perform public.seed_default_leave_types(v_merchant_id);
  perform public.seed_default_payroll_settings(v_merchant_id);
  perform public.seed_default_leave_deduction_rules(v_merchant_id);
  perform public.seed_default_member_settings(v_merchant_id);
  perform public.seed_default_line_event_settings(v_merchant_id);
  perform public.seed_default_push_event_settings(v_merchant_id);
  perform public.seed_default_booking_status_colors(v_merchant_id);
  perform public.seed_default_merchant_calendar_state_styles(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 疊加 create_merchant_in_group(同上,查證後只新增最後一行呼叫)。
-- =========================================================================
create or replace function public.create_merchant_in_group(
  p_group_id uuid,
  p_name text,
  p_industry_type text,
  p_address text default null::text,
  p_contact_email text default null::text,
  p_intro text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  perform public.seed_default_leave_types(v_merchant_id);
  perform public.seed_default_payroll_settings(v_merchant_id);
  perform public.seed_default_leave_deduction_rules(v_merchant_id);
  perform public.seed_default_member_settings(v_merchant_id);
  perform public.seed_default_line_event_settings(v_merchant_id);
  perform public.seed_default_push_event_settings(v_merchant_id);
  perform public.seed_default_booking_status_colors(v_merchant_id);
  perform public.seed_default_merchant_calendar_state_styles(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- update_merchant_calendar_state_styles:唯一寫入路徑(除了上面的 seed 函式)。三個顏色一次全部
-- 帶入(比照 update_merchant_booking_status_colors 的既有設計,不支援局部更新單一狀態的顏色),
-- 內部用三次 upsert 完成(這張表是一狀態一列,不能像 booking_status_colors 那樣一次 upsert
-- 單一列搞定)。
-- =========================================================================
create or replace function public.update_merchant_calendar_state_styles(
  p_merchant_id uuid,
  p_full_day_leave_color text,
  p_partial_leave_color text,
  p_cross_store_occupied_color text
)
returns setof public.merchant_calendar_state_styles
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限修改這間商家的行事曆排程狀態顏色設定' using errcode = '42501';
  end if;

  if p_full_day_leave_color is null or btrim(p_full_day_leave_color) = '' then
    raise exception '請設定「全天休假」的顏色';
  end if;
  if p_partial_leave_color is null or btrim(p_partial_leave_color) = '' then
    raise exception '請設定「時段排休」的顏色';
  end if;
  if p_cross_store_occupied_color is null or btrim(p_cross_store_occupied_color) = '' then
    raise exception '請設定「跨店佔用」的顏色';
  end if;

  insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
  values
    (p_merchant_id, 'full_day_leave', btrim(p_full_day_leave_color)),
    (p_merchant_id, 'partial_leave', btrim(p_partial_leave_color)),
    (p_merchant_id, 'cross_store_occupied', btrim(p_cross_store_occupied_color))
  on conflict (merchant_id, state_type) do update set
    color = excluded.color,
    updated_at = now();

  return query
    select * from public.merchant_calendar_state_styles
    where merchant_id = p_merchant_id
    order by state_type;
end;
$$;

comment on function public.update_merchant_calendar_state_styles(uuid, text, text, text) is 'SPECS-INDEX #644:upsert 商家的三筆 merchant_calendar_state_styles(全天休假/時段排休/跨店佔用)。權限比照 merchant_booking_status_colors:private.can_manage_bookings(商家管理員或被授權 orders 的客服)。不做嚴格 hex 格式 CHECK 約束,只擋掉空字串/null。';

revoke execute on function public.update_merchant_calendar_state_styles(uuid, text, text, text) from public, anon;
grant execute on function public.update_merchant_calendar_state_styles(uuid, text, text, text) to authenticated;

-- =========================================================================
-- get_my_calendar_state_styles:服務人員自助讀取自己所屬商家的行事曆排程狀態顏色設定
-- (MyCalendarTimelineView 用)。一般服務人員不符合 can_manage_bookings,無法透過表格本身的
-- RLS SELECT 政策讀到這張表,比照 get_my_day_business_hours 的既有做法,只檢查
-- private.is_own_staff_row,不額外檢查任何 section_key(顏色本身不是敏感資料)。查無資料的
-- state_type 在回傳的 jsonb 裡就不會有對應的 key,前端 fallback 成
-- DEFAULT_CALENDAR_STATE_STYLES(跟 seed 函式的預設色碼逐字一致)。
-- =========================================================================
create or replace function public.get_my_calendar_state_styles(p_staff_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_result jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的行事曆顏色設定' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  select coalesce(jsonb_object_agg(state_type, color), '{}'::jsonb)
  into v_result
  from public.merchant_calendar_state_styles
  where merchant_id = v_merchant_id;

  return v_result;
end;
$function$;

comment on function public.get_my_calendar_state_styles(uuid) is 'SPECS-INDEX #644:服務人員自助查詢自己所屬商家的行事曆排程狀態顏色設定,只檢查 is_own_staff_row。回傳 {state_type: color} 的 jsonb 物件,查無資料的 key 由前端 fallback 成 DEFAULT_CALENDAR_STATE_STYLES。規則 2.4:傳入別人的 staff_id 一律被擋下。';

revoke all on function public.get_my_calendar_state_styles(uuid) from public, anon;
grant execute on function public.get_my_calendar_state_styles(uuid) to authenticated;

-- =========================================================================
-- get_my_day_schedule_state:服務人員自助查詢自己某一天的「全天休假/時段排休/跨店佔用」狀態
-- 明細(MyCalendarTimelineView 用)。這三種狀態目前完全沒有任何管道回傳給服務人員自己
-- (on_leave/foreign_bookings 只存在於 get_merchant_day_schedule,那支函式要求
-- can_manage_bookings,一般服務人員不符合;availability_overrides 雖然服務人員已經可以透過
-- 既有的 fetchMyAvailabilityOverrides 讀到,但這裡一併回傳方便呼叫端一次拿齊三種狀態,不用
-- 額外併發兩支查詢再自己組裝)。
--
-- 查詢邏輯比照 get_merchant_day_schedule 目前最新版本(20260922120300 修正 24:00 跨日回捲 bug
-- 之後的版本)裡「單一服務人員」那個 staff_block 子查詢(on_leave/foreign_bookings 兩段條件
-- 逐字相同),只有 availability_overrides 這段刻意不做「合併相鄰同值半小時格子」聚合(前端這裡
-- 只需要逐格判斷有沒有落在某個 is_available=false 的例外區間內,不需要像商家管理員版本那樣
-- 顯示合併後的區間文字),改成逐列直接回傳每一格的起訖時間,同樣用「當日分鐘數整數相加」算
-- end_time,避免 23:30 那格 +30 分鐘時回捲成 00:00:00(跟 20260922120300 修的是同一種邊界值
-- bug)。
-- =========================================================================
create or replace function public.get_my_day_schedule_state(p_staff_id uuid, p_date date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_on_leave jsonb;
  v_overrides jsonb;
  v_foreign_bookings jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的排程狀態' using errcode = '42501';
  end if;

  v_day_start := (p_date::timestamp) at time zone 'Asia/Taipei';
  v_day_end := ((p_date + 1)::timestamp) at time zone 'Asia/Taipei';

  select jsonb_build_object('leave_record_id', slr.id, 'leave_type_name', slr.leave_type_name_snapshot)
  into v_on_leave
  from public.staff_leave_records slr
  where slr.staff_id = p_staff_id
    and slr.status = 'confirmed'
    and p_date between slr.start_date and slr.end_date
  limit 1;

  -- staff_availability_overrides 一列 = 一個半小時格子(欄位是 slot_start_time,不是
  -- start_time/end_time 區間),這裡逐列直接回傳「這一格的起訖時間」,不做合併(呼叫端只需要
  -- 逐格比對,不需要像商家管理員版本那樣顯示合併後的區間文字)。end_time 用「當日分鐘數整數
  -- 相加」而不是對 time 型別直接 `+ interval`,比照 get_merchant_day_schedule 20260922120300
  -- 已經修過的 24:00 跨日回捲 bug 的同一種算法(23:30 這格 +30 分鐘要算出 24:00:00,不能回捲成
  -- 00:00:00)。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'start_time', o.slot_start_time,
        'end_time', make_time(
          (extract(hour from o.slot_start_time)::int * 60 + extract(minute from o.slot_start_time)::int + 30) / 60,
          (extract(hour from o.slot_start_time)::int * 60 + extract(minute from o.slot_start_time)::int + 30) % 60,
          0
        ),
        'is_available', o.is_available
      )
      order by o.slot_start_time
    ),
    '[]'::jsonb
  )
  into v_overrides
  from public.staff_availability_overrides o
  where o.staff_id = p_staff_id and o.override_date = p_date;

  select coalesce(
    jsonb_agg(jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at) order by fb.start_at),
    '[]'::jsonb
  )
  into v_foreign_bookings
  from (
    select fb.start_at, fb.end_at
    from public.bookings fb
    join public.merchant_staff fms on fms.id = fb.staff_id
    join public.merchant_staff ms on ms.id = p_staff_id
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
    join public.merchant_staff ms on ms.id = p_staff_id
    where fms.id <> ms.id
      and private.normalize_phone(fms.phone) is not null
      and private.normalize_phone(fms.phone) = private.normalize_phone(ms.phone)
      and fb.status <> 'cancelled'
      and fb.start_at < v_day_end
      and fb.end_at > v_day_start
  ) fb;

  return jsonb_build_object(
    'on_leave', v_on_leave,
    'availability_overrides', v_overrides,
    'foreign_bookings', v_foreign_bookings
  );
end;
$function$;

comment on function public.get_my_day_schedule_state(uuid, date) is 'SPECS-INDEX #644:服務人員自助查詢自己某一天的「全天休假/時段排休/跨店佔用」狀態明細,供 MyCalendarTimelineView 渲染用。查詢邏輯逐字比照 get_merchant_day_schedule 目前版本的單一服務人員子查詢(20260922120300 24:00 跨日回捲修正版),只是 availability_overrides 這裡回傳未合併的原始列(呼叫端只需要逐格判斷,不需要合併後的區間文字)。規則 2.4:傳入別人的 staff_id 一律被擋下。';

revoke all on function public.get_my_day_schedule_state(uuid, date) from public, anon;
grant execute on function public.get_my_day_schedule_state(uuid, date) to authenticated;

-- =========================================================================
-- 回歸補值:既有商家(在本批次上線之前就已建立)沒有 merchant_calendar_state_styles,這裡一次性
-- 補齊(比照模組 11/15/#620 既有的 backfill 做法)。
-- =========================================================================
do $$
declare
  v_merchant record;
begin
  for v_merchant in select id from public.merchants loop
    perform public.seed_default_merchant_calendar_state_styles(v_merchant.id);
  end loop;
end;
$$;
