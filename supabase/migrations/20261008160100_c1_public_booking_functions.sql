-- 客戶端第 1 批(模組 13 客戶端)— migration 2:公開預約頁的兩支資料庫函式 + 客戶版時段核心
-- 規格書:.project/specs/客戶端第1批-公開預約頁.md(B 區 C1-B01~B08、C 區 C1-C01 / C1-C02、F 區)
-- 前端接口說明:.project/notes/c1-rpc-contract.md
--
-- =========================================================================
-- 這支 migration 新增的函式(**不修改任何既有函式**)
-- =========================================================================
--   private.customer_slot_range_ok(...)              boolean  營業時間 ∩ 每週時段(支援 no_time_slot_limit)
--   private.check_customer_booking_slot(...)         text     客戶版單一時段判斷(null = 可以約;否則回原因代碼)
--   private.customer_staff_can_do_items(...)         boolean  服務人員會不會做這些主要項目(C1-B06)
--   private.public_available_slots_at(..., p_now)    jsonb    C1-C02 的本體(「現在時間」由呼叫端帶入,只給測試用)
--   public.get_public_available_slots(...)           jsonb    C1-C02 對外版本 = 上一支帶 now()
--   public.get_public_booking_page(p_slug)           jsonb    C1-C01
--
--   ・既有 private.check_staff_booking_slot / private.check_staff_legacy_range /
--     public.list_staff_bookable_start_times 一個字都不改(指紋 migration 前後一樣,見回報)。
--   ・第 3 批的客戶下單函式**必須呼叫同一支 private.check_customer_booking_slot**(規格書第五節)。
--
-- =========================================================================
-- 「複製後改寫」的來源(規格 C1-B01 要求標明來源函式與指紋,之後兩邊要同步)
-- =========================================================================
--   ・private.customer_slot_range_ok 複製自 private.check_staff_legacy_range
--       (指紋 f2e69cea28a870da465547b1d6afd1a9,md5(replace(prosrc, E'\r\n', E'\n')))
--     改寫:① 回傳 boolean 不 raise;② no_time_slot_limit = true 時跳過「每週時段」那一層,
--             營業時間照樣要遵守(#977 第 3 批 migration 20261006130200 記載的原本語意,C1-B03)。
--   ・private.check_customer_booking_slot 的「營業時間 / 每週時段 / 單日例外」逐格迴圈複製自
--     private.check_staff_booking_slot(指紋 47dd66a50d8fde63fd968836b3e2c036)
--     改寫:① 回傳原因代碼不 raise(列清單時不用每格開 exception 子交易,效能);
--           ② unlimited_backend_edit 一律無效(客戶端永遠檢查邊界,C1-B01 差異 1);
--           ③ 不看 strict_conflict_check,一律擋重疊(C1-B01 差異 2 / 主腦裁決 Q2);
--           ④ 重疊比對前後各延長車程緩衝(只限到府產業,C1-B08);
--           ⑤ 多了上架 / 在職 / 所屬商家、最少提前小時、最少提前天數 / 最遠可預約天數(C1-B02/B04/B05)。
--     重疊判斷直接呼叫既有 private.staff_booking_conflict_exists、private.same_person_staff_ids_in_group。
--   ・後台時段核心另有「商家層級店休日 / 特殊休息日」嗎?查證:沒有這種資料表(只有 merchant_business_hours
--     每週設定、服務人員層級的 staff_availability_overrides / staff_leave_records)⇒ 不用新增。
--
-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1)
-- =========================================================================
--   ・private.* 新函式:revoke from public, anon, authenticated;只有擁有者(postgres)與 service_role 能執行。
--   ・兩支 public 函式:revoke from public 後 grant to anon, authenticated, service_role(規格 C 區共同要求)。
--   ・SECURITY DEFINER + set search_path = public;**不新增、不放寬任何表的 RLS**(C1-F01)。
--   ・回傳一律 jsonb_build_object 逐欄組出,沒有 to_jsonb(整列) / row_to_json(整列)(C1-C01 / F02)。
--   ・錯誤訊息只有固定中文句子 + 固定 hint 代碼,不帶任何資料(服務人員名字、其他訂單時間都不會出現)。
--   ・函式本體內不寫註解(套正式庫後 md5(prosrc) 指紋比對才穩定);說明都寫在這個檔頭與各函式上方。
--
-- 用語:一律「服務人員」;錯誤訊息全形標點。

-- ═════════════════════════════════════════════════════════════════════════
-- 1. private.customer_slot_range_ok
--    複製自 private.check_staff_legacy_range(f2e69cea28a870da465547b1d6afd1a9),
--    差別只有:回傳 boolean;p_staff.no_time_slot_limit = true 時不檢查 staff_availability_windows。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_slot_range_ok(
  p_staff public.merchant_staff,
  p_day_of_week smallint,
  p_has_hours boolean,
  p_is_closed boolean,
  p_open_time time,
  p_close_time time,
  p_range_start time,
  p_range_end time
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  v_ok := coalesce(p_has_hours, false)
    and not coalesce(p_is_closed, true)
    and p_range_start >= p_open_time
    and p_range_end <= p_close_time;

  if v_ok and not p_staff.no_time_slot_limit then
    select exists (
      select 1 from public.staff_availability_windows
      where staff_id = p_staff.id
        and day_of_week = p_day_of_week
        and start_time <= p_range_start
        and end_time >= p_range_end
    ) into v_ok;
  end if;

  return coalesce(v_ok, false);
end;
$$;

revoke execute on function private.customer_slot_range_ok(public.merchant_staff, smallint, boolean, boolean, time, time, time, time)
  from public, anon, authenticated;
grant execute on function private.customer_slot_range_ok(public.merchant_staff, smallint, boolean, boolean, time, time, time, time)
  to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. private.check_customer_booking_slot
--    客戶版「這位服務人員、這個時段能不能約」。回傳 null = 可以;否則回原因代碼(只給伺服器內部用,
--    不直接顯示給客人):
--      staff_unavailable  不是這間店 / 已移除 / 未上架(C1-B05)
--      invalid            參數不合理(結束 ≤ 開始、沒有現在時間)
--      lead_time          早於「現在 + 至少提前幾小時」(C1-B04,商家層級,查無設定 = 2)
--      out_of_window      早於「今天 + 最少提前天數」或晚於「今天 + 最遠可預約天數(空值 = 60)」(C1-B02)
--      leave              那天請假(同後台)
--      cross_day          跨日(同後台)
--      override_closed    單日例外「臨時關閉」(同後台)
--      out_of_hours       超出營業時間或每週時段(no_time_slot_limit 只跳過每週時段,C1-B03)
--      conflict           跟這位服務人員(含助手、含同集團他店同一人)未取消的訂單重疊;
--                         到府產業前後各延長車程緩衝(C1-B08)
--    逐格迴圈複製自 private.check_staff_booking_slot(47dd66a50d8fde63fd968836b3e2c036)。
--    p_now:「現在時間」。對外函式一律帶 now();測試直接呼叫這支(或 public_available_slots_at)帶固定值。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.check_customer_booking_slot(
  p_merchant_id uuid,
  p_staff public.merchant_staff,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_now timestamptz,
  p_exclude_booking_id uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_industry text;
  v_lead_hours integer;
  v_buffer_minutes integer;
  v_today date;
  v_local_date date;
  v_day_of_week smallint;
  v_local_start time;
  v_local_end time;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_slot_start time;
  v_check_end time;
  v_grid_start time;
  v_grid_slot time;
  v_elapsed interval;
  v_total interval;
  v_override_is_available boolean;
  v_run_start time;
  v_run_end time;
  v_buffer interval;
begin
  if p_staff.id is null
     or p_staff.merchant_id is distinct from p_merchant_id
     or p_staff.status is distinct from 'active'
     or p_staff.is_listed is distinct from true then
    return 'staff_unavailable';
  end if;

  if p_start_at is null or p_end_at is null or p_now is null or p_end_at <= p_start_at then
    return 'invalid';
  end if;

  select m.industry_type into v_industry
  from public.merchants m
  where m.id = p_merchant_id;

  select s.min_lead_hours, s.travel_buffer_minutes into v_lead_hours, v_buffer_minutes
  from public.merchant_booking_settings s
  where s.merchant_id = p_merchant_id;
  v_lead_hours := coalesce(v_lead_hours, 2);
  v_buffer_minutes := case when v_industry = 'on_site_dispatch' then coalesce(v_buffer_minutes, 0) else 0 end;

  if p_start_at < p_now + make_interval(hours => v_lead_hours) then
    return 'lead_time';
  end if;

  v_today := (p_now at time zone 'Asia/Taipei')::date;
  v_local_date := (p_start_at at time zone 'Asia/Taipei')::date;
  if v_local_date < v_today + coalesce(p_staff.advance_booking_days, 0)
     or v_local_date > v_today + coalesce(p_staff.booking_window_max_days, 60) then
    return 'out_of_window';
  end if;

  if exists (
    select 1
    from public.staff_leave_records slr
    where slr.staff_id = p_staff.id
      and slr.status = 'confirmed'
      and daterange(slr.start_date, slr.end_date, '[]') && daterange(
            date(p_start_at at time zone 'Asia/Taipei'),
            date(p_end_at at time zone 'Asia/Taipei'),
            '[]'
          )
  ) then
    return 'leave';
  end if;

  if date(p_start_at at time zone 'Asia/Taipei') <> date(p_end_at at time zone 'Asia/Taipei') then
    return 'cross_day';
  end if;

  v_day_of_week := extract(dow from (p_start_at at time zone 'Asia/Taipei'))::smallint;
  v_local_start := (p_start_at at time zone 'Asia/Taipei')::time;
  v_local_end := (p_end_at at time zone 'Asia/Taipei')::time;

  select true, is_closed, open_time, close_time
  into v_has_hours, v_is_closed, v_open_time, v_close_time
  from public.merchant_business_hours
  where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

  v_grid_start := v_local_start - make_interval(secs => (extract(epoch from v_local_start) % 1800)::double precision);
  v_elapsed := interval '0 minutes';
  v_total := v_local_end - v_grid_start;
  v_run_start := null;
  v_run_end := null;
  while v_elapsed < v_total loop
    v_grid_slot := v_grid_start + v_elapsed;
    v_slot_start := greatest(v_grid_slot, v_local_start);
    v_check_end := v_grid_start + least(v_elapsed + interval '30 minutes', v_total);

    select is_available into v_override_is_available
    from public.staff_availability_overrides
    where staff_id = p_staff.id
      and override_date = v_local_date
      and slot_start_time = v_grid_slot;

    if found then
      if v_run_start is not null then
        if not private.customer_slot_range_ok(
          p_staff, v_day_of_week, v_has_hours, v_is_closed, v_open_time, v_close_time,
          v_run_start, v_run_end
        ) then
          return 'out_of_hours';
        end if;
        v_run_start := null;
        v_run_end := null;
      end if;

      if not v_override_is_available then
        return 'override_closed';
      end if;
    else
      if v_run_start is null then
        v_run_start := v_slot_start;
      end if;
      v_run_end := v_check_end;
    end if;

    v_elapsed := v_elapsed + interval '30 minutes';
  end loop;

  if v_run_start is not null then
    if not private.customer_slot_range_ok(
      p_staff, v_day_of_week, v_has_hours, v_is_closed, v_open_time, v_close_time,
      v_run_start, v_run_end
    ) then
      return 'out_of_hours';
    end if;
  end if;

  v_buffer := make_interval(mins => v_buffer_minutes);

  if private.staff_booking_conflict_exists(p_staff.id, p_start_at - v_buffer, p_end_at + v_buffer, p_exclude_booking_id) then
    return 'conflict';
  end if;

  if exists (
    select 1
    from private.same_person_staff_ids_in_group(p_staff.id) as other_staff(staff_id)
    where private.staff_booking_conflict_exists(other_staff.staff_id, p_start_at - v_buffer, p_end_at + v_buffer, p_exclude_booking_id)
  ) then
    return 'conflict';
  end if;

  return null;
end;
$$;

revoke execute on function private.check_customer_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function private.check_customer_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, timestamptz, uuid)
  to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. private.customer_staff_can_do_items(C1-A06 規則 2 / C1-B06)
--    這位服務人員在 merchant_staff_service_items 一筆都沒有 ⇒ 什麼都會做;
--    有設定 ⇒ 傳進來的每一個「主要項目」都要在他的對應裡(加購項目不檢查,呼叫端只傳主要項目 id)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_staff_can_do_items(
  p_staff_id uuid,
  p_primary_item_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not exists (
           select 1 from public.merchant_staff_service_items mssi
           where mssi.staff_id = p_staff_id
         )
      or not exists (
           select 1
           from unnest(coalesce(p_primary_item_ids, '{}'::uuid[])) as wanted(item_id)
           where not exists (
             select 1 from public.merchant_staff_service_items mssi
             where mssi.staff_id = p_staff_id
               and mssi.service_item_id = wanted.item_id
           )
         );
$$;

revoke execute on function private.customer_staff_can_do_items(uuid, uuid[]) from public, anon, authenticated;
grant execute on function private.customer_staff_can_do_items(uuid, uuid[]) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. private.public_available_slots_at(C1-C02 本體)
--    p_now = 「現在時間」,只有擁有者 / service_role 能呼叫(pgTAP 用來固定現在時間,驗 C1-B04)。
--    對外的 public.get_public_available_slots **沒有**這個參數(規格 C1-B04 要求)。
--
--    錯誤(errcode / hint 是前端判斷用的固定代碼;訊息只有固定中文句子):
--      P0002 page_not_found      找不到這個預約頁
--      P0002 page_unavailable    這間店目前暫停線上預約
--      P0002 staff_unavailable   指定的服務人員不存在 / 別家 / 已移除 / 未上架 / 不會做這些服務(同一句話)
--      P0002 no_staff_available  不指定,但一個會做這些服務的人都沒有
--      22023 invalid_range       p_from 空值、p_days 不在 1~7
--      22023 invalid_items       p_items 格式錯、超過 50 筆、id 不是這間店上架中的項目、重複、數量不在 1~20
--      22023 no_primary_item     沒有任何主要項目
--      22023 invalid_duration    總工時 = 0(項目都沒設工時)
--      22023 duration_too_long   總工時超過 24 小時
--
--    效能(C1-C02 2 秒門檻):每天只在「營業時間 ∪ 單日例外開啟格」範圍內產生候選起點(不從 00:00 掃到
--    23:55);整天請假 / 超出提前與最遠天數的服務人員那天直接略過;早於「現在 + 至少提前小時」的候選直接略過;
--    「不指定」時同一個時間只要有一人可以就不再問其他人。以上都只是「先略過一定不行的」,
--    每個時段最後一律交給 private.check_customer_booking_slot 判斷,規則只有一份。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.public_available_slots_at(
  p_slug text,
  p_items jsonb,
  p_staff_id uuid,
  p_from date,
  p_days integer,
  p_now timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant public.merchants;
  v_item jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_item_type text;
  v_item_minutes integer;
  v_item_ids uuid[] := '{}'::uuid[];
  v_primary_ids uuid[] := '{}'::uuid[];
  v_duration integer := 0;
  v_step integer;
  v_lead_hours integer;
  v_staff_list public.merchant_staff[];
  v_day_staff public.merchant_staff[];
  v_s public.merchant_staff;
  v_today date;
  v_date date;
  v_dow smallint;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_day_closed boolean;
  v_lo integer;
  v_hi integer;
  v_ov_lo integer;
  v_ov_hi integer;
  v_min_start timestamptz;
  v_minutes integer;
  v_start timestamptz;
  v_times text[];
  v_state text;
  v_days jsonb := '[]'::jsonb;
  v_d integer;
begin
  select * into v_merchant
  from public.merchants
  where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    raise exception '找不到這個預約頁，請向店家確認連結是否正確' using errcode = 'P0002', hint = 'page_not_found';
  end if;
  if v_merchant.status is distinct from 'active' then
    raise exception '這間店目前暫停線上預約' using errcode = 'P0002', hint = 'page_unavailable';
  end if;

  if p_from is null or p_days is null or p_days < 1 or p_days > 7 or p_now is null then
    raise exception '查詢的日期範圍不正確' using errcode = '22023', hint = 'invalid_range';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 50 then
    raise exception '選擇的服務項目不正確，請重新選擇' using errcode = '22023', hint = 'invalid_items';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'service_item_id') is distinct from 'string'
       or jsonb_typeof(v_item -> 'quantity') is distinct from 'number'
       or (v_item ->> 'service_item_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception '選擇的服務項目不正確，請重新選擇' using errcode = '22023', hint = 'invalid_items';
    end if;

    v_item_id := (v_item ->> 'service_item_id')::uuid;
    v_qty := (v_item ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > 20 or v_item_id = any(v_item_ids) then
      raise exception '選擇的服務項目不正確，請重新選擇' using errcode = '22023', hint = 'invalid_items';
    end if;

    select si.item_type, si.duration_minutes into v_item_type, v_item_minutes
    from public.service_items si
    where si.id = v_item_id and si.merchant_id = v_merchant.id and si.status = 'active';
    if not found then
      raise exception '選擇的服務項目不正確，請重新選擇' using errcode = '22023', hint = 'invalid_items';
    end if;

    v_item_ids := v_item_ids || v_item_id;
    if v_item_type = 'primary' then
      v_primary_ids := v_primary_ids || v_item_id;
    end if;
    v_duration := v_duration + v_item_minutes * v_qty::integer;
  end loop;

  if cardinality(v_primary_ids) = 0 then
    raise exception '請至少選一項主要服務' using errcode = '22023', hint = 'no_primary_item';
  end if;
  if v_duration < 1 then
    raise exception '這些服務沒有設定工時，請直接聯絡店家' using errcode = '22023', hint = 'invalid_duration';
  end if;
  if v_duration > 1440 then
    raise exception '選的服務太多，請聯絡店家' using errcode = '22023', hint = 'duration_too_long';
  end if;

  select array_agg(s order by s.id) into v_staff_list
  from public.merchant_staff s
  where s.merchant_id = v_merchant.id
    and s.status = 'active'
    and s.is_listed = true
    and (p_staff_id is null or s.id = p_staff_id)
    and private.customer_staff_can_do_items(s.id, v_primary_ids);

  if v_staff_list is null then
    if p_staff_id is not null then
      raise exception '這位服務人員目前無法預約，請改選其他服務人員或「不指定」' using errcode = 'P0002', hint = 'staff_unavailable';
    end if;
    raise exception '目前沒有可以預約這些服務的服務人員，請聯絡店家或改選其他服務' using errcode = 'P0002', hint = 'no_staff_available';
  end if;

  select s.start_time_interval_minutes, s.min_lead_hours into v_step, v_lead_hours
  from public.merchant_booking_settings s
  where s.merchant_id = v_merchant.id;
  v_step := coalesce(v_step, 30);
  v_lead_hours := coalesce(v_lead_hours, 2);
  v_min_start := p_now + make_interval(hours => v_lead_hours);
  v_today := (p_now at time zone 'Asia/Taipei')::date;

  for v_d in 0 .. p_days - 1 loop
    v_date := p_from + v_d;
    v_times := '{}'::text[];
    v_dow := extract(dow from v_date)::smallint;

    v_has_hours := false;
    v_is_closed := null;
    v_open_time := null;
    v_close_time := null;
    select true, bh.is_closed, bh.open_time, bh.close_time
    into v_has_hours, v_is_closed, v_open_time, v_close_time
    from public.merchant_business_hours bh
    where bh.merchant_id = v_merchant.id and bh.day_of_week = v_dow;
    v_has_hours := coalesce(v_has_hours, false);
    v_day_closed := not v_has_hours or coalesce(v_is_closed, true) or v_open_time is null or v_close_time is null;

    v_day_staff := null;
    if v_date >= v_today then
      select array_agg(st order by st.id) into v_day_staff
      from unnest(v_staff_list) as st
      where v_date >= v_today + coalesce(st.advance_booking_days, 0)
        and v_date <= v_today + coalesce(st.booking_window_max_days, 60);
    end if;

    if v_day_staff is null then
      v_state := 'out_of_range';
    else
      select array_agg(st order by st.id) into v_day_staff
      from unnest(v_day_staff) as st
      where not exists (
        select 1 from public.staff_leave_records slr
        where slr.staff_id = st.id
          and slr.status = 'confirmed'
          and v_date between slr.start_date and slr.end_date
      );

      v_lo := null;
      v_hi := null;
      if not v_day_closed then
        v_lo := (extract(epoch from v_open_time) / 60)::integer;
        v_hi := (extract(epoch from v_close_time) / 60)::integer;
      end if;

      if v_day_staff is not null then
        select min(extract(epoch from o.slot_start_time) / 60)::integer,
               max(extract(epoch from o.slot_start_time) / 60)::integer + 30
        into v_ov_lo, v_ov_hi
        from public.staff_availability_overrides o
        where o.override_date = v_date
          and o.is_available = true
          and o.staff_id = any(select st.id from unnest(v_day_staff) as st);
        if v_ov_lo is not null then
          v_lo := least(coalesce(v_lo, v_ov_lo), v_ov_lo);
          v_hi := greatest(coalesce(v_hi, v_ov_hi), v_ov_hi);
        end if;
      end if;

      if v_day_staff is not null and v_lo is not null then
        v_minutes := ((v_lo + v_step - 1) / v_step) * v_step;
        while v_minutes < 1440 and v_minutes + v_duration <= v_hi loop
          v_start := (v_date::timestamp + make_interval(mins => v_minutes)) at time zone 'Asia/Taipei';
          if v_start >= v_min_start then
            foreach v_s in array v_day_staff loop
              if private.check_customer_booking_slot(
                   v_merchant.id, v_s, v_start, v_start + make_interval(mins => v_duration), p_now, null
                 ) is null then
                v_times := v_times || to_char(make_time(v_minutes / 60, v_minutes % 60, 0), 'HH24:MI');
                exit;
              end if;
            end loop;
          end if;
          v_minutes := v_minutes + v_step;
        end loop;
      end if;

      if cardinality(v_times) > 0 then
        v_state := 'open';
      elsif v_day_closed then
        v_state := 'closed';
      else
        v_state := 'full';
      end if;
    end if;

    v_days := v_days || jsonb_build_array(jsonb_build_object(
      'date', to_char(v_date, 'YYYY-MM-DD'),
      'state', v_state,
      'times', to_jsonb(v_times)
    ));
  end loop;

  return jsonb_build_object(
    'duration_minutes', v_duration,
    'days', v_days
  );
end;
$$;

revoke execute on function private.public_available_slots_at(text, jsonb, uuid, date, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function private.public_available_slots_at(text, jsonb, uuid, date, integer, timestamptz)
  to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. public.get_public_available_slots(C1-C02 對外版本,未登入可呼叫)
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.get_public_available_slots(
  p_slug text,
  p_items jsonb,
  p_staff_id uuid,
  p_from date,
  p_days integer
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select private.public_available_slots_at(p_slug, p_items, p_staff_id, p_from, p_days, now());
$$;

revoke execute on function public.get_public_available_slots(text, jsonb, uuid, date, integer) from public;
grant execute on function public.get_public_available_slots(text, jsonb, uuid, date, integer)
  to anon, authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. public.get_public_booking_page(C1-C01,未登入可呼叫)
--    status = not_found / unavailable 時只回 {"status": ...}。
--    白名單欄位見 .project/notes/c1-rpc-contract.md;排序:分類依名稱(同後台 fetchServiceCategories),
--    項目與服務人員依建立時間(同後台 fetchServiceItems)。分類只列「底下有上架中項目」的。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.get_public_booking_page(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant public.merchants;
  v_allow_guest boolean;
begin
  select * into v_merchant
  from public.merchants
  where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_merchant.status is distinct from 'active' then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select s.allow_guest_booking into v_allow_guest
  from public.merchant_booking_settings s
  where s.merchant_id = v_merchant.id;

  return jsonb_build_object(
    'status', 'ok',
    'merchant', jsonb_build_object(
      'name', v_merchant.name,
      'industry_type', v_merchant.industry_type,
      'logo_url', v_merchant.logo_url,
      'address', v_merchant.address,
      'phone', v_merchant.phone,
      'intro', v_merchant.intro,
      'theme_preset', v_merchant.theme_preset,
      'theme_custom_color', v_merchant.theme_custom_color,
      'announcement', case when v_merchant.announcement_enabled then v_merchant.announcement_content else null end,
      'line_friend_url', v_merchant.line_friend_url
    ),
    'booking_settings', jsonb_build_object(
      'allow_guest_booking', coalesce(v_allow_guest, true),
      'is_on_site', v_merchant.industry_type = 'on_site_dispatch'
    ),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by c.name, c.id)
      from public.service_categories c
      where c.merchant_id = v_merchant.id
        and exists (
          select 1 from public.service_items si
          where si.category_id = c.id and si.merchant_id = v_merchant.id and si.status = 'active'
        )
    ), '[]'::jsonb),
    'service_items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', si.id,
               'category_id', si.category_id,
               'name', si.name,
               'description', si.description,
               'price', si.price,
               'duration_minutes', si.duration_minutes,
               'item_type', si.item_type
             ) order by si.created_at, si.id)
      from public.service_items si
      where si.merchant_id = v_merchant.id and si.status = 'active'
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', st.id,
               'display_name', coalesce(nullif(btrim(st.nickname), ''), st.name),
               'avatar_url', st.avatar_url,
               'intro', st.intro,
               'primary_service_item_ids',
                 case
                   when exists (select 1 from public.merchant_staff_service_items m where m.staff_id = st.id) then
                     coalesce((
                       select jsonb_agg(si.id order by si.created_at, si.id)
                       from public.merchant_staff_service_items m
                       join public.service_items si on si.id = m.service_item_id
                       where m.staff_id = st.id
                         and si.merchant_id = v_merchant.id
                         and si.status = 'active'
                         and si.item_type = 'primary'
                     ), '[]'::jsonb)
                   else null
                 end
             ) order by st.created_at, st.id)
      from public.merchant_staff st
      where st.merchant_id = v_merchant.id and st.status = 'active' and st.is_listed = true
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.get_public_booking_page(text) from public;
grant execute on function public.get_public_booking_page(text) to anon, authenticated, service_role;
