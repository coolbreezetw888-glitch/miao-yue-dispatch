-- 模組 7:排班與休假管理 — 功能/RLS 層(第二支:functions)。
-- 對應規格書 .project/specs/排班與休假管理.md §2/§3/§4。
--
-- ⚠️ 主腦裁示,跟規格書原文有出入的地方(以這裡為準,見規格書第〇節判斷 5/規則 2.8):
-- 規格書原本規劃「unlimited_backend_edit 開啟時連請假限制也一併跳過」。主腦裁定:**請假限制
-- 不應該被 unlimited_backend_edit 覆寫,不論這個開關是否開啟,只要服務人員當天有 confirmed 的
-- 請假紀錄,一律擋下建單**——請假代表「這個人明確表示這天不會出勤」,是比「後台編輯時段彈性」
-- 更明確的事實陳述,不應該被這個開關悄悄蓋過去。真的要在請假期間安排,正確流程是先呼叫
-- cancel_staff_leave 取消請假紀錄,再正常建單。這個裁示落實在本檔案下方
-- private.check_staff_booking_slot 的疊加位置(移到 v_bypass_bounds 判斷區塊之外)。

-- =========================================================================
-- 3.1:private.can_manage_team_leave(p_merchant_id uuid) / private.can_view_scheduling(p_merchant_id uuid)
-- 完全比照 private.can_manage_bookings 的既有寫法(20260916140100_booking_functions.sql)。
-- =========================================================================
create or replace function private.can_manage_team_leave(p_merchant_id uuid)
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
        and map.section_key = 'team_leave'
        and map.granted = true
    );
$$;

comment on function private.can_manage_team_leave(uuid) is '是否能管理該商家的假別清單(新增/編輯/下架)+ 請假紀錄(新增/取消)(模組 7,規則 2.11):商家管理員永遠可以,或是該商家目前有效的客服且被開通 team_leave 這個 section_key。「建單時因為服務人員請假被擋下」不需要這個權限,那是 orders 權限的範圍(規則 2.11 邊界情況)。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_manage_team_leave(uuid) from public, anon;
grant execute on function private.can_manage_team_leave(uuid) to authenticated;

create or replace function private.can_view_scheduling(p_merchant_id uuid)
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
        and map.section_key = 'scheduling'
        and map.granted = true
    );
$$;

comment on function private.can_view_scheduling(uuid) is '是否能檢視該商家的排班一覽總覽頁(模組 7,規則 2.11):商家管理員永遠可以,或是該商家目前有效的客服且被開通 scheduling 這個 section_key。這是純唯讀總覽的檢視權限,跟 team_leave(有寫入行為的請假/假別管理)是兩把獨立的鑰匙。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.can_view_scheduling(uuid) from public, anon;
grant execute on function private.can_view_scheduling(uuid) to authenticated;

-- =========================================================================
-- 3.2/3.10:merchant_leave_types 的 RLS 政策。比照 payment_methods v2 的既有做法——不包 RPC,
-- 直接開放 RLS INSERT/UPDATE,前端直接呼叫 supabase.from('merchant_leave_types')...。
-- SELECT/INSERT/UPDATE 都要求 private.can_manage_team_leave(merchant_id)。沒有 DELETE 政策
-- (規則 2.10:下架用 status='removed',不算危險操作)。
-- =========================================================================
alter table public.merchant_leave_types enable row level security;

create policy merchant_leave_types_select on public.merchant_leave_types
  for select to authenticated
  using (private.can_manage_team_leave(merchant_id));

create policy merchant_leave_types_insert on public.merchant_leave_types
  for insert to authenticated
  with check (private.can_manage_team_leave(merchant_id));

create policy merchant_leave_types_update on public.merchant_leave_types
  for update to authenticated
  using (private.can_manage_team_leave(merchant_id))
  with check (private.can_manage_team_leave(merchant_id));

-- =========================================================================
-- 3.10:staff_leave_records 的 RLS 政策。這裡選擇比照 bookings/staff_availability_overrides 的
-- 「RPC only」模式,不是比照 payment_methods 的「開放 RLS 直寫」模式——這張表有規則 2.5/2.6
-- 這類跨列驗證邏輯,必須集中在 SECURITY DEFINER 函式裡做,不能讓前端直接寫入繞過驗證。
-- SELECT 要求 private.can_manage_team_leave(private.staff_merchant_id(staff_id))(既有輔助函式,
-- 20260916140100_booking_functions.sql 已建立,繞過 merchant_staff 本身的 RLS)。
-- 沒有 INSERT/UPDATE/DELETE 政策——一律透過 create_staff_leave/cancel_staff_leave 寫入。
-- =========================================================================
alter table public.staff_leave_records enable row level security;

create policy staff_leave_records_select on public.staff_leave_records
  for select to authenticated
  using (private.can_manage_team_leave(private.staff_merchant_id(staff_id)));

-- =========================================================================
-- 3.4:preview_staff_leave_conflicts(p_staff_id uuid, p_start_date date, p_end_date date)。
-- 唯讀預覽,回傳這段期間該服務人員(含以助手身份)所有 status <> 'cancelled' 的預約清單,
-- 供前端在使用者填完表單、送出前先顯示警示清單用(規則 2.6 第 1 點)。
-- create_staff_leave 內部也呼叫這支函式取得衝突筆數,避免同一段判斷邏輯寫兩份。
-- =========================================================================
create or replace function public.preview_staff_leave_conflicts(
  p_staff_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  booking_id uuid,
  start_at timestamptz,
  end_at timestamptz,
  customer_name text,
  service_item_names text[]
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_manage_team_leave(v_merchant_id) then
    raise exception '沒有權限查詢這間商家的請假衝突預覽' using errcode = '42501';
  end if;

  return query
  select
    bb.id,
    bb.start_at,
    bb.end_at,
    bb.customer_name,
    coalesce(
      (select array_agg(si.name order by si.name)
       from public.booking_service_items bsi
       join public.service_items si on si.id = bsi.service_item_id
       where bsi.booking_id = bb.id),
      '{}'
    )
  from (
    select b.id, b.start_at, b.end_at, b.customer_name
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < ((p_end_date + 1)::timestamp at time zone 'Asia/Taipei')
      and b.end_at > (p_start_date::timestamp at time zone 'Asia/Taipei')
    union
    select b.id, b.start_at, b.end_at, b.customer_name
    from public.booking_assistants ba
    join public.bookings b on b.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < ((p_end_date + 1)::timestamp at time zone 'Asia/Taipei')
      and b.end_at > (p_start_date::timestamp at time zone 'Asia/Taipei')
  ) bb
  order by bb.start_at;
end;
$$;

comment on function public.preview_staff_leave_conflicts(uuid, date, date) is '對應規則 2.6 第 1 點/規格書 3.4:回傳某服務人員在 [p_start_date, p_end_date] 這段期間(含以助手身份)所有非取消狀態的預約清單(時間/客戶姓名/服務項目名稱陣列),供前端在送出建立請假紀錄前先顯示警示清單。create_staff_leave 內部也呼叫這支取得衝突筆數,避免重複實作同一段判斷邏輯。SECURITY DEFINER 檢查 private.can_manage_team_leave。';

revoke execute on function public.preview_staff_leave_conflicts(uuid, date, date) from public, anon;
grant execute on function public.preview_staff_leave_conflicts(uuid, date, date) to authenticated;

-- =========================================================================
-- 3.3:create_staff_leave(...)。
-- =========================================================================
create or replace function public.create_staff_leave(
  p_staff_id uuid,
  p_leave_type_id uuid,
  p_start_date date,
  p_end_date date,
  p_notes text default null,
  p_confirm_despite_conflicts boolean default false
)
returns public.staff_leave_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_compensation_type text;
  v_leave_type_name text;
  v_conflict_count int;
  v_result public.staff_leave_records;
begin
  -- 1. 查 merchant_staff 取得 merchant_id/compensation_type,檢查權限。
  select merchant_id, compensation_type
  into v_merchant_id, v_compensation_type
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_manage_team_leave(v_merchant_id) then
    raise exception '沒有權限管理這間商家的請假紀錄' using errcode = '42501';
  end if;

  -- 2. 規則 2.2:只有月薪制服務人員可以登記請假紀錄。
  if v_compensation_type <> 'monthly_salary' then
    raise exception '只有月薪制的服務人員可以登記請假紀錄,請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)';
  end if;

  -- 3. end_date >= start_date(資料表 CHECK 約束也會擋,這裡提前給白話錯誤訊息)。
  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 4. 規則 2.5:同一服務人員的 confirmed 請假區間不能重疊,沒有覆寫例外。
  if exists (
    select 1
    from public.staff_leave_records slr
    where slr.staff_id = p_staff_id
      and slr.status = 'confirmed'
      and daterange(slr.start_date, slr.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception '這位服務人員在這段期間已經有其他請假紀錄,日期區間不能重疊';
  end if;

  -- 5. 規則 2.6:既有預約衝突,警示但不強制擋下——有衝突且沒有確認旗標就擋下並回傳筆數。
  select count(*) into v_conflict_count
  from public.preview_staff_leave_conflicts(p_staff_id, p_start_date, p_end_date);

  if v_conflict_count > 0 and not coalesce(p_confirm_despite_conflicts, false) then
    raise exception '這段期間已經有 % 筆預約,請先確認清單後再登記請假', v_conflict_count;
  end if;

  -- 6. 假別必須屬於同一商家且 status='active'(已下架的假別只留給歷史紀錄快照顯示用)。
  select name into v_leave_type_name
  from public.merchant_leave_types
  where id = p_leave_type_id and merchant_id = v_merchant_id and status = 'active';

  if not found then
    raise exception '找不到這個假別,或已下架';
  end if;

  -- 7. 通過後寫入,status 固定 'confirmed'(這次不做簽核流程,建立即生效)。
  insert into public.staff_leave_records (
    staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, notes, status, created_by_user_id
  ) values (
    p_staff_id, p_leave_type_id, v_leave_type_name, p_start_date, p_end_date, p_notes, 'confirmed', auth.uid()
  )
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.create_staff_leave(uuid, uuid, date, date, text, boolean) is '對應規格書 3.3:建立一筆請假紀錄,逐項檢查權限(team_leave)/計酬類型(規則 2.2)/日期合理性/區間重疊(規則 2.5,無覆寫例外)/既有預約衝突(規則 2.6,p_confirm_despite_conflicts=true 才能在有衝突時放行)/假別必須屬於同商家且上架中。leave_type_name_snapshot 在這裡寫死,之後查詢一律讀這個快照,不重新 join merchant_leave_types(比照模組 9 §234 的教訓)。';

revoke execute on function public.create_staff_leave(uuid, uuid, date, date, text, boolean) from public, anon;
grant execute on function public.create_staff_leave(uuid, uuid, date, date, text, boolean) to authenticated;

-- =========================================================================
-- 3.5:cancel_staff_leave(p_leave_id uuid)。
-- =========================================================================
create or replace function public.cancel_staff_leave(p_leave_id uuid)
returns public.staff_leave_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.staff_leave_records;
begin
  select ms.merchant_id, slr.status
  into v_merchant_id, v_status
  from public.staff_leave_records slr
  join public.merchant_staff ms on ms.id = slr.staff_id
  where slr.id = p_leave_id;

  if not found then
    raise exception '找不到這筆請假紀錄';
  end if;

  if not private.can_manage_team_leave(v_merchant_id) then
    raise exception '沒有權限管理這間商家的請假紀錄' using errcode = '42501';
  end if;

  if v_status <> 'confirmed' then
    raise exception '這筆請假紀錄目前狀態不是「進行中」,無法取消(目前狀態:%)', v_status;
  end if;

  update public.staff_leave_records
  set status = 'cancelled', cancelled_at = now()
  where id = p_leave_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.cancel_staff_leave(uuid) is '對應規格書 3.5:取消一筆請假紀錄(軟刪除,status 改 cancelled,規則 2.10 不算危險操作)。只有目前狀態是 confirmed 的紀錄能取消。要改請假的日期/假別,一律先取消原本這筆再重新登記一筆新的(規則 2.9)。';

revoke execute on function public.cancel_staff_leave(uuid) from public, anon;
grant execute on function public.cancel_staff_leave(uuid) to authenticated;

-- =========================================================================
-- 3.9:新商家建立時自動種入預設假別(事假/病假/特休,第〇節判斷 6)。
-- 比照 seed_default_payment_methods 的既有寫法:放在 public schema,不額外 revoke/grant,
-- 因為前端從未直接把它當 RPC 呼叫,只透過 perform 內部呼叫。
-- =========================================================================
create or replace function public.seed_default_leave_types(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_leave_types (merchant_id, name, description)
  values
    (p_merchant_id, '事假', null),
    (p_merchant_id, '病假', null),
    (p_merchant_id, '特休', null);
end;
$$;

comment on function public.seed_default_leave_types(uuid) is '模組 7 排班與休假管理:新商家建立當下種入三筆預設假別(事假/病假/特休,第〇節判斷 6),商家可以之後自己改名字/加說明文字/下架/新增其他假別,不是鎖死不能動。只在 create_group_and_merchant/create_merchant_in_group 建立商家當下呼叫一次,不做成可重複呼叫的冪等函式(呼叫時機保證這個商家剛建立、不會有既有列)。';

-- =========================================================================
-- 3.9:create_group_and_merchant/create_merchant_in_group 補種子呼叫。
-- ⚠️ 實作警語(重申模組 9 §233 的教訓):以下兩支函式的完整函式主體,是動工前重新讀取
-- 20260919130100_payment_methods_v2_functions.sql(create_group_and_merchant)跟
-- 20260919130300_payment_methods_v2_create_merchant_in_group_fix.sql(create_merchant_in_group,
-- 這是修正過 is_group_member 呼叫路徑之後的正確版本)取得的目前最新版本,只新增一行
-- perform public.seed_default_leave_types(v_merchant_id); 呼叫,其餘完全逐字保留,
-- 不是從舊版本/規格書示意/記憶中重建。兩支函式參數簽章完全不變,用 create or replace 即可。
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
  perform public.seed_default_leave_types(v_merchant_id);

  return v_merchant_id;
end;
$$;

comment on function public.create_group_and_merchant(text, text, text, text, text) is 'Onboarding(4.1)呼叫的 RPC:原子性建立集團+第一間商家+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式+種入模組 7 預設假別,見規格書 3.2、支付方式.md §2、排班與休假管理.md §3.9。';

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
  perform public.seed_default_leave_types(v_merchant_id);

  return v_merchant_id;
end;
$$;

comment on function public.create_merchant_in_group(uuid, text, text, text, text, text) is '新增分店流程(4.4)呼叫的 RPC:檢查規則 2.5 權限後,原子性建立新分店+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式+種入模組 7 預設假別,見規格書 3.3、支付方式.md §2、排班與休假管理.md §3.9。修正紀錄(2026-09-19):20260919130100 這支 migration 重建此函式時誤用了 hardening 之前的舊版本body(呼叫已經被 drop 掉的 public.is_group_member),20260919130300 改回呼叫 private.is_group_member,本次(模組 7)在這個正確版本基礎上補上種子假別呼叫。';
