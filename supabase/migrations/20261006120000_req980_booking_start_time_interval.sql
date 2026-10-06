-- SPECS-INDEX #980 追加(2026-10-06,使用者補充):預約時間不一定以半小時為單位。
-- 商家層級新增設定「建單時間間隔」:5 / 10 / 15 / 30 分鐘,預設 30(既有商家沒有這筆設定 = 30,行為不變)。
--
-- ═══ 1. 新表 public.merchant_booking_settings ══════════════════════════════════════════
-- 為什麼不放 merchant_feature_flags:那張表只有布林 enabled,放不下數字。
-- 為什麼不加在 merchants:merchants 的 UPDATE 政策 / 身分欄位保護 trigger 牽涉集團歸屬(security_audit_03),
-- 為了一個建單設定去動那張表風險不成比例。
-- 讀寫路徑沿用「營業時間設定」頁既有寫法(merchant_business_hours / merchant_feature_flags):
--   ・前端直接 upsert(merchant_id 為主鍵)
--   ・INSERT / UPDATE:private.can_manage_business_hours(跟營業時間、嚴格工時衝突檢查同一把鑰匙)
--   ・SELECT:can_manage_business_hours 或 can_manage_bookings(建單的人也看得到目前間隔)
--   ・沒有 DELETE 政策(要改回 30 就存 30)
--   ・UPDATE 的 with check 跟 using 同一個判斷:把 merchant_id 改成別家 ⇒ 新列要通過別家的權限才行
--     (supabase-permission-hygiene 規則 2;這張表沒有其他身分欄位)
--   ・anon 一律沒有權限
--
-- ═══ 2. public.list_staff_bookable_start_times 依商家間隔產生候選起點 ════════════════════════
-- 簽章不變(create or replace,既有 ACL 原樣保留,下面仍整組重寫一次)。
-- 唯一的改動:候選起點的間隔從固定 30 分鐘改成讀 merchant_booking_settings(查無資料 = 30)。
-- 每一個候選仍逐一交給 private.check_staff_booking_slot 判斷(5 分鐘間隔 = 一天 288 個),不另寫規則。
--
-- ⚠️ 本檔沒有任何資料寫入,只有建表、政策、函式定義。

create table public.merchant_booking_settings (
  merchant_id uuid primary key references public.merchants (id) on delete cascade,
  start_time_interval_minutes smallint not null default 30
    check (start_time_interval_minutes in (5, 10, 15, 30))
);

comment on table public.merchant_booking_settings is 'SPECS-INDEX #980 追加(2026-10-06):商家層級的建單設定。start_time_interval_minutes = 建單時間選單每隔幾分鐘列一個可選的開始時間(5 / 10 / 15 / 30,查無資料視為 30)。給 public.list_staff_bookable_start_times 產生候選起點用;不影響 create_booking / update_booking 的時段判斷(那邊仍以 private.check_staff_booking_slot 為準)。寫入權限 = 營業時間設定(can_manage_business_hours)。';

alter table public.merchant_booking_settings enable row level security;

revoke all on table public.merchant_booking_settings from public, anon;
grant select, insert, update on table public.merchant_booking_settings to authenticated;

create policy merchant_booking_settings_select on public.merchant_booking_settings
  for select to authenticated
  using (
    private.can_manage_business_hours(merchant_id)
    or private.can_manage_bookings(merchant_id)
  );

create policy merchant_booking_settings_insert on public.merchant_booking_settings
  for insert to authenticated
  with check (private.can_manage_business_hours(merchant_id));

create policy merchant_booking_settings_update on public.merchant_booking_settings
  for update to authenticated
  using (private.can_manage_business_hours(merchant_id))
  with check (private.can_manage_business_hours(merchant_id));

-- =========================================================================
-- list_staff_bookable_start_times:候選起點改依商家間隔
-- =========================================================================
create or replace function public.list_staff_bookable_start_times(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_date date,
  p_duration_minutes integer,
  p_exclude_booking_id uuid default null
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.merchant_staff;
  v_minutes integer;
  v_step integer;
  v_start timestamptz;
  v_result text[] := '{}'::text[];
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的可預約時間' using errcode = '42501';
  end if;

  if p_date is null or p_duration_minutes is null or p_duration_minutes < 1 or p_duration_minutes > 1440 then
    raise exception '查詢可預約時間的參數不正確' using errcode = '22023';
  end if;

  if p_exclude_booking_id is not null and not exists (
    select 1 from public.bookings b
    where b.id = p_exclude_booking_id and b.merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆預約' using errcode = '42501';
  end if;

  -- 跟 private.validate_booking_selection 第 2 步同一個條件:屬於這間商家、在職。
  select * into v_staff
  from public.merchant_staff
  where id = p_staff_id and merchant_id = p_merchant_id and status = 'active';
  if not found then
    return v_result;
  end if;

  -- #980 追加:候選起點的間隔 = 商家的「建單時間間隔」(查無設定 = 30 分鐘,跟改版前一樣)。
  select s.start_time_interval_minutes into v_step
  from public.merchant_booking_settings s
  where s.merchant_id = p_merchant_id;
  v_step := coalesce(v_step, 30);

  v_minutes := 0;
  while v_minutes < 1440 loop
    v_start := (p_date::timestamp + make_interval(mins => v_minutes)) at time zone 'Asia/Taipei';
    begin
      -- 🔴 跟 validate_booking_selection 呼叫主要服務人員時**完全相同的參數**(角色標籤只影響錯誤訊息)。
      perform private.check_staff_booking_slot(
        p_merchant_id,
        v_staff,
        v_start,
        v_start + make_interval(mins => p_duration_minutes),
        p_exclude_booking_id,
        '主要服務人員'
      );
      v_result := v_result || to_char(make_time(v_minutes / 60, v_minutes % 60, 0), 'HH24:MI');
    exception
      -- 只吞「規則擋下」(RAISE EXCEPTION 預設 SQLSTATE P0001);其他真正的錯誤照常往外丟。
      when raise_exception then
        null;
    end;
    v_minutes := v_minutes + v_step;
  end loop;

  return v_result;
end;
$$;

comment on function public.list_staff_bookable_start_times(uuid, uuid, date, integer, uuid) is 'SPECS-INDEX #980(2026-10-06):建單 / 改單的時間選單只列出能約的開始時間。依商家「建單時間間隔」(merchant_booking_settings.start_time_interval_minutes,5 / 10 / 15 / 30,查無資料 = 30)產生 p_date(台北日曆日)的候選起點,逐一交給 private.check_staff_booking_slot 試算(區間 = 起點 + p_duration_minutes,參數與 validate_booking_selection 呼叫主要服務人員時相同),沒被擋下的才以 HH:MI 字串回傳 —— 判斷規則全部沿用同一支函式,不另寫一套。權限:private.can_manage_bookings;服務人員須屬於該商家且在職(否則回空陣列);p_exclude_booking_id 須屬於該商家(否則 42501)。唯讀,不寫入任何資料。';

revoke execute on function public.list_staff_bookable_start_times(uuid, uuid, date, integer, uuid) from public, anon;
grant execute on function public.list_staff_bookable_start_times(uuid, uuid, date, integer, uuid) to authenticated;
