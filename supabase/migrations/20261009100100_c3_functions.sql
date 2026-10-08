-- 客戶端第 3 批(模組 13)— migration 2:送出預約核心、通知店家、公開函式頻率限制、服務人員順位
-- 規格書:.project/specs/客戶端第3批-送出預約與通知店家.md(「零之零」優先)
-- 介面文件:.project/notes/c3-contract.md
--
-- =========================================================================
-- 新增
-- =========================================================================
--   private.customer_parse_booking_items        C3-A02 服務項目檢查(從 public_available_slots_at 搬出來共用)
--   private.request_client_ip                   C3-G02 從 PostgREST 請求標頭取 IP(cf-connecting-ip → XFF 最後一段)
--   private.enforce_public_rate_limit           C3-G02 公開函式每 IP 10 分鐘 120 次
--   private.customer_link_state                 C3-A03 第 3 步「這位客人有沒有接上這間店」(customer_complete_profile 共用)
--   private.customer_booking_initial_status     C3-A03 第 10 步
--   private.notify_customer_booking_created     C3-C01 鈴鐺(一定發)
--   private.customer_booking_result             C3-A05 回傳格式
--   public.internal_customer_submit_booking     C3-A03 送出核心(只給 service_role)
--   public.move_merchant_staff_order            C3-H02 調整順位
-- =========================================================================
-- 修改(前後指紋見回報)
-- =========================================================================
--   private.public_available_slots_at   只把「項目檢查」那段改成呼叫 customer_parse_booking_items;最遠天數預設 60 → 180
--   private.check_customer_booking_slot 只有最遠天數預設 60 → 180(C3-E04 / Q1)
--   public.get_public_available_slots   sql → plpgsql、stable → volatile,開頭加頻率限制(C3-G02)
--   public.get_public_booking_page      stable → volatile,開頭加頻率限制;服務人員依順位排序(C3-G02 / C3-H01)
--   public.customer_complete_profile    第 2、3 步改呼叫 customer_link_state(行為不變)
--   public.get_my_booking_schedule      每筆多回 source、is_guest_booking(C3-E01;其他欄位與遮蔽不變)
--   public.get_merchant_day_schedule    服務人員欄依順位排序(C3-H04;原本依姓名)
--   public.get_staff_schedule_overview  排班一覽服務人員依順位排序(C3-H04 主腦補充;原本依姓名)
--   public.list_report_export_staff     報表匯出中心服務人員下拉依順位(使用者 Q3-c;原本依姓名)
--   public.get_merchant_billing_summary(_by_range) 帳單報表服務人員明細依順位(主腦裁決;原本依姓名,回傳欄位不變)
--   private.tg_merchant_staff_calendar_live_sync  display_order 變動 ⇒ 只發商家頻道訊號(C3-H02)
--
-- 權限衛生:新函式一律 revoke from public, anon, authenticated;對外只開 move_merchant_staff_order 給 authenticated。
-- 函式本體內不寫註解(md5(prosrc) 指紋比對才穩定),說明寫在函式上方。

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A02 private.customer_parse_booking_items
--   從 private.public_available_slots_at(第 1 批,指紋 db680d94909b7f7b61fb73e27ae98720)「檢查 p_items、
--   算工時、找主要項目」那一段逐字搬出來,多讀一個 price。錯誤訊息 / hint 逐字沿用第 1 批:
--     invalid_items(格式錯、超過 50 筆、不是這間店 active 項目、重複、數量不在 1~20)
--     no_primary_item、invalid_duration(總工時 0)、duration_too_long(超過 24 小時)
--   回傳:items = [{service_item_id, quantity, item_type, duration_minutes, price}](依傳入順序,price 從資料庫讀)
--         duration_minutes = Σ 工時 × 數量;primary_item_ids;items_subtotal = Σ price × 數量
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_parse_booking_items(
  p_merchant_id uuid,
  p_items jsonb,
  out items jsonb,
  out duration_minutes integer,
  out primary_item_ids uuid[],
  out items_subtotal numeric
)
returns record
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_item_id uuid;
  v_qty numeric;
  v_item_type text;
  v_item_minutes integer;
  v_price numeric;
  v_item_ids uuid[] := '{}'::uuid[];
begin
  items := '[]'::jsonb;
  duration_minutes := 0;
  primary_item_ids := '{}'::uuid[];
  items_subtotal := 0;

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

    select si.item_type, si.duration_minutes, si.price into v_item_type, v_item_minutes, v_price
    from public.service_items si
    where si.id = v_item_id and si.merchant_id = p_merchant_id and si.status = 'active';
    if not found then
      raise exception '選擇的服務項目不正確，請重新選擇' using errcode = '22023', hint = 'invalid_items';
    end if;

    v_item_ids := v_item_ids || v_item_id;
    if v_item_type = 'primary' then
      primary_item_ids := primary_item_ids || v_item_id;
    end if;
    duration_minutes := duration_minutes + v_item_minutes * v_qty::integer;
    items_subtotal := items_subtotal + v_price * v_qty;
    items := items || jsonb_build_array(jsonb_build_object(
      'service_item_id', v_item_id,
      'quantity', v_qty::integer,
      'item_type', v_item_type,
      'duration_minutes', v_item_minutes,
      'price', v_price
    ));
  end loop;

  if cardinality(primary_item_ids) = 0 then
    raise exception '請至少選一項主要服務' using errcode = '22023', hint = 'no_primary_item';
  end if;
  if duration_minutes < 1 then
    raise exception '這些服務沒有設定工時，請直接聯絡店家' using errcode = '22023', hint = 'invalid_duration';
  end if;
  if duration_minutes > 1440 then
    raise exception '選的服務太多，請聯絡店家' using errcode = '22023', hint = 'duration_too_long';
  end if;
end;
$$;
revoke execute on function private.customer_parse_booking_items(uuid, jsonb) from public, anon, authenticated;
grant execute on function private.customer_parse_booking_items(uuid, jsonb) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-G02 private.request_client_ip
--   PostgREST 會把請求標頭放進 request.headers(json,小寫 key)。
--   先 cf-connecting-ip(Cloudflare 依實際連線覆寫,客人改不了),再 X-Forwarded-For **最後一段**
--   (客人自己帶的值在前面,代理把它看到的連線 IP 接在最後;同第 2 批 Edge 鐵律,不信第一段)。
--   都沒有 / 不是從 PostgREST 進來(例如 pgTAP、service role 內部呼叫)⇒ null。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.request_client_ip()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_raw text;
  v_headers jsonb;
  v_ip text;
  v_parts text[];
begin
  v_raw := current_setting('request.headers', true);
  if v_raw is null or btrim(v_raw) = '' then
    return null;
  end if;
  begin
    v_headers := v_raw::jsonb;
  exception when others then
    return null;
  end;
  if jsonb_typeof(v_headers) is distinct from 'object' then
    return null;
  end if;

  v_ip := nullif(btrim(coalesce(v_headers ->> 'cf-connecting-ip', '')), '');
  if v_ip is not null then
    return left(v_ip, 100);
  end if;

  v_parts := array(
    select btrim(x)
    from unnest(string_to_array(coalesce(v_headers ->> 'x-forwarded-for', ''), ',')) as x
    where btrim(x) <> ''
  );
  if cardinality(v_parts) > 0 then
    return left(v_parts[cardinality(v_parts)], 100);
  end if;
  return null;
end;
$$;
revoke execute on function private.request_client_ip() from public, anon, authenticated;
grant execute on function private.request_client_ip() to service_role;

-- C3-G02 private.enforce_public_rate_limit:每個 IP、每個 bucket 10 分鐘 120 次。
--   拿不到 IP ⇒ 不限制,只記 notice(不能把所有人算成同一個 IP 一起擋掉)。
--   超過 ⇒ P0001 hint rate_limited「操作太頻繁，請稍後再試」。
--   ⚠️ 超過時是 raise,這次的 +1 會跟著回滾(計數停在上限,之後照樣擋)。
create or replace function private.enforce_public_rate_limit(p_bucket text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ip text;
begin
  v_ip := private.request_client_ip();
  if v_ip is null then
    raise notice 'public rate limit skipped (%): client ip unknown', p_bucket;
    return;
  end if;
  if not private.rate_limit_hit(p_bucket, 'ip:' || v_ip, interval '10 minutes', 120) then
    raise exception '操作太頻繁，請稍後再試' using errcode = 'P0001', hint = 'rate_limited';
  end if;
end;
$$;
revoke execute on function private.enforce_public_rate_limit(text) from public, anon, authenticated;
grant execute on function private.enforce_public_rate_limit(text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A03 第 3 步 private.customer_link_state(第 2 批 customer_complete_profile 第 2、3 步抽出來)
--   line_login_unavailable  這間店沒設定 / 沒啟用 LINE 登入
--   channel_mismatch        這位客人的 LINE channel ≠ 這間店目前的 channel
--   linked                  members.user_id = 這位客人、同店、active
--   needs_profile           其他
--   商家存在 / 啟用由呼叫端判斷。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_link_state(p_merchant_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg public.merchant_line_login_configs;
  v_ident public.customer_line_identities;
begin
  select * into v_cfg from public.merchant_line_login_configs where merchant_id = p_merchant_id;
  if not found or not v_cfg.enabled then
    return 'line_login_unavailable';
  end if;

  select * into v_ident from public.customer_line_identities where user_id = p_user_id;
  if not found or v_ident.line_channel_id is distinct from v_cfg.channel_id then
    return 'channel_mismatch';
  end if;

  if exists (
    select 1 from public.members m
    where m.merchant_id = p_merchant_id and m.user_id = p_user_id and m.status = 'active'
  ) then
    return 'linked';
  end if;
  return 'needs_profile';
end;
$$;
revoke execute on function private.customer_link_state(uuid, uuid) from public, anon, authenticated;
grant execute on function private.customer_link_state(uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 修改的既有函式(由目前資料庫定義只改必要的幾行產生,diff 見回報)
-- ═════════════════════════════════════════════════════════════════════════

-- ─── private.check_customer_booking_slot(C3-E04:最遠可預約天數預設 60 → 180,只改這一個數字)───
CREATE OR REPLACE FUNCTION private.check_customer_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_now timestamp with time zone, p_exclude_booking_id uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     or v_local_date > v_today + coalesce(p_staff.booking_window_max_days, 180) then
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
$function$

;

-- ─── private.public_available_slots_at(C3-A02:項目檢查改呼叫 customer_parse_booking_items;C3-E04:60 → 180)───
CREATE OR REPLACE FUNCTION private.public_available_slots_at(p_slug text, p_items jsonb, p_staff_id uuid, p_from date, p_days integer, p_now timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant public.merchants;
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

  select pi.duration_minutes, pi.primary_item_ids
    into v_duration, v_primary_ids
  from private.customer_parse_booking_items(v_merchant.id, p_items) pi;

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
        and v_date <= v_today + coalesce(st.booking_window_max_days, 180);
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
$function$

;

-- ─── public.get_public_booking_page(C3-G02:volatile + 頻率限制;C3-H01:服務人員依順位排序)───
CREATE OR REPLACE FUNCTION public.get_public_booking_page(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant public.merchants;
  v_allow_guest boolean;
  v_line_login_enabled boolean;
  v_member_policy text;
begin
  perform private.enforce_public_rate_limit('public_booking_page');

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

  -- [c2] C2-C01:有設定且啟用才算啟用。不回 Channel ID / secret。
  select c.enabled into v_line_login_enabled
  from public.merchant_line_login_configs c
  where c.merchant_id = v_merchant.id;

  -- [c2] C2-C06:⑥-2 / ⑥-4 勾選框要顯示商家會員政策(沒開或內容空白 ⇒ null,前端只寫「隱私權政策」)。
  select case when ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null
              then ms.policy_content else null end
    into v_member_policy
  from public.merchant_member_settings ms
  where ms.merchant_id = v_merchant.id;

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
      'is_on_site', v_merchant.industry_type = 'on_site_dispatch',
      'line_login_enabled', coalesce(v_line_login_enabled, false),
      'member_policy', v_member_policy
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
             ) order by st.display_order, st.created_at, st.id)
      from public.merchant_staff st
      where st.merchant_id = v_merchant.id and st.status = 'active' and st.is_listed = true
    ), '[]'::jsonb)
  );
end;
$function$

;

-- ─── public.customer_complete_profile(第 2、3 步改呼叫 private.customer_link_state,行為不變)───
CREATE OR REPLACE FUNCTION public.customer_complete_profile(p_slug text, p_phone text, p_name text, p_agree_policy boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_merchant public.merchants;
  v_cfg public.merchant_line_login_configs;
  v_ident public.customer_line_identities;
  v_linked public.members;
  v_member public.members;
  v_new public.members;
  v_phone text;
  v_name text;
  v_policy_enabled boolean := false;
  v_policy_hash text;
  v_distinct_phones int;
  v_seen boolean;
  v_result jsonb;
  v_member_id_for_consent uuid;
  v_link_state text;
begin
  -- 1. 只給客戶帳號(後台人員的帳號不能拿來當客人)。
  if v_uid is null or not private.is_customer_account() then
    raise exception '這個功能只給用 LINE 登入的客人使用。' using errcode = '42501', hint = 'not_customer';
  end if;

  -- 2. slug → 商家;停用 / 沒啟用 LINE 登入。
  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;
  v_link_state := private.customer_link_state(v_merchant.id, v_uid);
  if v_link_state = 'line_login_unavailable' then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;

  -- 3. 這位客人的 LINE channel 必須等於這間店目前的 channel。
  if v_link_state = 'channel_mismatch' then
    return jsonb_build_object('state', 'channel_mismatch');
  end if;
  select * into v_ident from public.customer_line_identities where user_id = v_uid;

  -- 4. 必須勾選同意。
  if p_agree_policy is not true then
    raise exception '請先勾選同意會員政策與隱私權政策。' using errcode = '22023', hint = 'policy_not_agreed';
  end if;

  select coalesce(ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null, false),
         case when ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null
              then md5(ms.policy_content) else null end
    into v_policy_enabled, v_policy_hash
  from public.merchant_member_settings ms where ms.merchant_id = v_merchant.id;
  v_policy_enabled := coalesce(v_policy_enabled, false);

  -- 同一位客人在同一間店的呼叫排隊處理(避免同時按兩次建出兩筆)。
  perform pg_advisory_xact_lock(hashtextextended('c2_profile:' || v_merchant.id::text || ':' || v_uid::text, 0));

  -- 5. 已經接上這間店的會員 ⇒ 直接回 linked(不重複建立、不改電話)。
  select * into v_linked from public.members
  where merchant_id = v_merchant.id and user_id = v_uid and status = 'active';
  if found then
    insert into public.customer_policy_consents (
      merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
    ) values (
      v_merchant.id, v_uid, v_linked.id, private.normalize_phone(p_phone), 'line_login', v_policy_enabled, v_policy_hash, '2026-10-08'
    );
    return jsonb_build_object('state', 'linked');
  end if;

  -- 7.(零之二 第 3 點)電話:手機或含區碼市話,不收分機。
  if p_phone is null or not private.is_valid_customer_phone(btrim(p_phone)) then
    raise exception '電話格式不正確。手機請填 09 開頭共 10 碼，市話請連同區碼填 9~10 碼，不用填分機。'
      using errcode = '22023', hint = 'invalid_phone';
  end if;
  v_phone := private.normalize_phone(btrim(p_phone));

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and char_length(v_name) > 50 then
    raise exception '姓名最多 50 個字。' using errcode = '22023', hint = 'invalid_name';
  end if;

  -- 零之二 Q6:同一位客人在同一間店 24 小時內最多換 5 支不同電話(用過的電話重送不算新的一支)。
  select count(distinct c.phone_normalized), coalesce(bool_or(c.phone_normalized = v_phone), false)
    into v_distinct_phones, v_seen
  from public.customer_policy_consents c
  where c.user_id = v_uid and c.merchant_id = v_merchant.id and c.context = 'line_login'
    and c.phone_normalized is not null and c.consented_at > now() - interval '24 hours';
  if not v_seen and v_distinct_phones >= 5 then
    return jsonb_build_object('state', 'too_many_attempts');
  end if;

  -- 同一支電話在同一間店排隊處理(兩位客人同時填同一支新電話)。
  perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_merchant.id::text || ':' || v_phone, 0));

  -- 8. 用正規化電話找這間店的 active 會員(members_merchant_active_phone_uniq ⇒ 最多一位)。
  select * into v_member from public.members m
  where m.merchant_id = v_merchant.id and m.status = 'active' and private.normalize_phone(m.phone) = v_phone
  limit 1;

  if not found then
    -- 新電話 ⇒ 直接相信,沿用 create_member 建會員。姓名空白時用 LINE 顯示名稱。
    v_name := coalesce(v_name, left(nullif(btrim(coalesce(v_ident.display_name, '')), ''), 50), 'LINE 會員');
    begin
      v_new := private.create_member_as_customer_flow(v_merchant.id, v_name, v_phone);
    exception when others then
      -- 🔴 不把 create_member 的原文帶出去(撞號時原文會帶出別的會員姓名,C2-F06)。
      raise exception '系統忙碌，請稍後再試一次。' using errcode = 'P0001', hint = 'retry';
    end;

    update public.members
       set user_id = null
     where merchant_id = v_merchant.id and user_id = v_uid and id <> v_new.id;
    update public.members
       set user_id = v_uid,
           line_user_id = v_ident.line_sub,
           line_bound = true,
           identity_verified_at = now(),
           identity_verified_via = 'line',
           identity_first_verified_at = now()
     where id = v_new.id;

    v_member_id_for_consent := v_new.id;
    v_result := jsonb_build_object('state', 'linked', 'created', true);
  elsif v_member.user_id is null
        and exists (select 1 from public.customer_member_link_blocks b
                    where b.member_id = v_member.id and b.user_id = v_uid) then
    -- [c2-relink] 店家解除過「這個客戶帳號 ↔ 這位會員」⇒ 這個帳號不能自動接回;跟 phone_taken 同一個回應(不帶任何會員資料)。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', 'phone_taken');
  elsif v_member.user_id is null then
    -- 零之二 第 1 點:既有會員還沒有客戶帳號接上 ⇒ 直接接上(+ 鈴鐺)。
    perform private.link_customer_to_member(v_member.id, v_uid, v_ident.line_sub);
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked', 'existing', true);
  elsif v_member.user_id = v_uid then
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked');
  else
    -- 零之二 第 1 點:已經有別的客戶帳號接上 ⇒ 不取代。回應不帶任何會員資料(C2-F06)。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', 'phone_taken');
  end if;

  -- 9. 每次呼叫都寫一筆同意紀錄(也是 Q6 的計數來源)。
  insert into public.customer_policy_consents (
    merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
  ) values (
    v_merchant.id, v_uid, v_member_id_for_consent, v_phone, 'line_login', v_policy_enabled, v_policy_hash, '2026-10-08'
  );

  return v_result;
end;
$function$

;

-- ─── public.get_my_booking_schedule(C3-E01:每筆多回 source、is_guest_booking;其他欄位與遮蔽不變)───
CREATE OR REPLACE FUNCTION public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_show_member_info boolean;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_result jsonb;
begin
  -- 1. 規則 2.4(核心必測):必須是本人,且已開通 staff_calendar_view。
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的行事曆' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_calendar_view') then
    raise exception '尚未開通行事曆檢視功能，請洽商家管理員' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 2. 範圍上限(建議 62 天,避免一次查詢範圍過大拖垮效能)。
  if (p_end_date - p_start_date) > 62 then
    raise exception '查詢範圍不能超過 62 天，請分批查詢' using errcode = '22023';
  end if;

  select ms.merchant_id, ms.show_member_info
  into v_merchant_id, v_show_member_info
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  v_range_start := (p_start_date::timestamp) at time zone 'Asia/Taipei';
  v_range_end := ((p_end_date + 1)::timestamp) at time zone 'Asia/Taipei';

  -- 3. 規則 2.5:涵蓋「主要服務人員」與「助手」兩種身份(比照 set_staff_day_override 既有的
  -- 既有預約衝突查詢邏輯,bookings 跟 booking_assistants 兩邊都查)。
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', bb.id,
      'start_at', bb.start_at,
      'end_at', bb.end_at,
      'status', bb.status,
      'role_in_booking', bb.role_in_booking,
      'customer_name', bb.customer_name,
      -- SPECS-INDEX #977(2026-10-06,第 3 批,使用者裁決 H-13):「服務人員是否顯示會員資料」關閉時,
      -- 服務人員只看得到客戶姓名 ⇒ 電話、地址**在這裡就不回傳**(null),不是送出去再讓前端不顯示。
      -- 開啟時照舊。這支是服務人員端唯一會回傳客戶電話 / 地址的出口(盤點表見回報)。
      'customer_phone', case when v_show_member_info then bb.customer_phone else null end,
      'customer_address', case when v_show_member_info then bb.customer_address else null end,
      -- SPECS-INDEX #851:內部備註逐單隱藏(2026-09-30)。旗標為 true 時這裡就是 null,
      -- 回應 JSON 裡**沒有那段文字**,不是「有送出但前端不顯示」。
      -- 🔴 主腦裁決 T1=A:不額外回傳「本來有沒有備註」的布林 —— 那會洩漏「存在性」,
      --    也會讓服務人員端出現「這裡有秘密」的提示,跟這次要藏的初衷相反。
      -- 🔴 主腦裁決 T4:primary 與 assistant 同待遇,所以這裡不判斷 bb.role_in_booking。
      'notes', case when bb.hide_notes_from_staff then null else bb.notes end,
      'customer_notes', bb.customer_notes,
      'source', bb.source,
      'is_guest_booking', bb.is_guest_booking,
      'service_item_names', coalesce(si_agg.names, '[]'::jsonb),
      'final_amount_snapshot', bb.final_amount_snapshot,
      -- 規則 2.6:基本資訊一律回傳,只有 show_member_info=true 時才附上會員專屬欄位;
      -- 沒有連結會員(member_id is null)時這幾項一律是 null,跟關掉開關時的結果一致。
      'is_member', case when v_show_member_info then (bb.member_id is not null) else null end,
      'member_name', case
        when v_show_member_info and bb.member_id is not null then bb.member_name_snapshot
        else null
      end,
      'member_points_balance', case
        when v_show_member_info and bb.member_id is not null then m.points_balance
        else null
      end
    )
    order by bb.start_at
  ), '[]'::jsonb)
  into v_result
  from (
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      b.hide_notes_from_staff,
      b.source, b.is_guest_booking,
      'primary'::text as role_in_booking
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
    union all
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      b.hide_notes_from_staff,
      b.source, b.is_guest_booking,
      'assistant'::text as role_in_booking
    from public.booking_assistants ba
    join public.bookings b on b.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
  ) bb
  left join public.members m on m.id = bb.member_id
  left join lateral (
    select jsonb_agg(si.name order by si.name) as names
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = bb.id
  ) si_agg on true;

  return v_result;
end;
$function$

;

-- ─── public.get_merchant_day_schedule(C3-H04:後台行事曆服務人員欄依順位排序,原本依姓名)───
CREATE OR REPLACE FUNCTION public.get_merchant_day_schedule(p_merchant_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- SPECS-INDEX #977(2026-10-06,第 3 批):後台行事曆的可約時段不再看 no_time_slot_limit
      -- (那個欄位只留給客戶線上預約)。放寬改看 unlimited_backend_edit —— 跟 check_staff_booking_slot
      -- 的後台判斷同一個欄位,畫面才不會出現「格子灰的、送出卻能建」或反過來的落差。
      -- 回傳欄位名稱跟著改成 unlimited_backend_edit(前端行事曆沒有讀這個值,只讀 available_windows)。
      'unlimited_backend_edit', ms.unlimited_backend_edit,
      'available_windows', (
        case
          when coalesce(v_has_hours, false) is false or coalesce(v_is_closed, true) then '[]'::jsonb
          when ms.unlimited_backend_edit then
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
      -- 模組 6 §5.5 第 3 點:這位服務人員這一天的單日例外設定,合併相鄰同值的半小時格子
      -- 成一個個區間(標準的「gaps and islands」分組寫法:偵測跟上一格是否緊鄰且 is_available
      -- 相同,不緊鄰或值不同就視為新的一段,再用累加和當分組鍵)。
      --
      -- 模組 14 v2 品管打回修正(SPECS-INDEX 編號 485):grp_end 改用「當日分鐘數」整數運算
      -- (0~1440)算出後再用 make_time 組回 time 型別,不直接對 time 型別做 `+ interval` 相加
      -- ——time 型別加法在跨過 24:00:00 時會回捲成 00:00:00(不會進位),當最後一格是 23:30
      -- (「整天排休」一定會產生這種情況)時,合併後的區間會變成 start=00:00/end=00:00
      -- (零寬度),前端比對邏輯永遠比對不到,整天排休因此在商家管理員視角完全「消失」。
      -- 這裡的 grp_end_minutes 最大值恰好是 1440(23:30 這格 +30 分鐘),make_time(24,0,0)
      -- 是 PostgreSQL 明確允許的邊界值,已用 execute_sql 實測確認不會拋錯、也不會回捲。
      'availability_overrides', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'start_time', grp_start,
            'end_time', make_time(grp_end_minutes / 60, grp_end_minutes % 60, 0),
            'is_available', grp_is_available
          )
          order by grp_start
        )
        from (
          select min(slot_start_time) as grp_start,
                 (
                   extract(hour from max(slot_start_time))::int * 60
                   + extract(minute from max(slot_start_time))::int
                   + 30
                 ) as grp_end_minutes,
                 is_available as grp_is_available
          from (
            select
              slot_start_time,
              is_available,
              sum(is_new_group) over (order by slot_start_time) as grp_id
            from (
              select
                slot_start_time,
                is_available,
                case
                  when lag(slot_start_time) over (order by slot_start_time) = slot_start_time - interval '30 minutes'
                       and lag(is_available) over (order by slot_start_time) = is_available
                  then 0
                  else 1
                end as is_new_group
              from public.staff_availability_overrides
              where staff_id = ms.id and override_date = p_date
            ) marked
          ) grouped
          group by grp_id, is_available
        ) merged
      ), '[]'::jsonb),
      -- 模組 7(排班與休假管理)§3.7(新增):這位服務人員這一天是否整天請假。查無資料時是
      -- SQL null,前端據此判斷這位服務人員這天是否整天休假。用 leave_type_name_snapshot 快照欄位,
      -- 不重新 join merchant_leave_types 查詢目前名稱(比照模組 9 §234 的教訓)。
      'on_leave', (
        select jsonb_build_object('leave_record_id', slr.id, 'leave_type_name', slr.leave_type_name_snapshot)
        from public.staff_leave_records slr
        where slr.staff_id = ms.id
          and slr.status = 'confirmed'
          and p_date between slr.start_date and slr.end_date
        limit 1
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
      -- SPECS-INDEX #924(2026-10-01):「同一個人」只在**同一集團內**成立,判定條件統一走
      -- private.same_person_staff_ids_in_group()(跟 check_staff_booking_slot 同一支),
      -- 取代原本沒有任何商家/集團過濾、掃整個平台的電話比對。
      'foreign_bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at)
          order by fb.start_at
        )
        from (
          select fb.start_at, fb.end_at
          from public.bookings fb
          where fb.staff_id in (select private.same_person_staff_ids_in_group(ms.id))
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
          union all
          select fb.start_at, fb.end_at
          from public.booking_assistants fba
          join public.bookings fb on fb.id = fba.booking_id
          where fba.staff_id in (select private.same_person_staff_ids_in_group(ms.id))
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
        ) fb
      ), '[]'::jsonb)
    ) as staff_block
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id and ms.status = 'active'
    order by ms.display_order, ms.created_at, ms.id
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
$function$

;

-- ─── private.tg_merchant_staff_calendar_live_sync(C3-H02:display_order 變動只發商家頻道訊號;服務人員端不發)───
CREATE OR REPLACE FUNCTION private.tg_merchant_staff_calendar_live_sync()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone_changed boolean;
  v_merchant_changed boolean;
  v_calendar_changed boolean;
  v_staff_changed boolean;
  v_order_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      begin
        perform private.notify_merchant_calendar_changed(new.merchant_id);
      exception
        when others then
          raise warning 'WarnCalendarLiveSync: %', sqlerrm;
      end;
    end if;
    return null;
  end if;

  if tg_op = 'DELETE' then
    begin
      perform private.notify_merchant_calendar_changed(old.merchant_id);
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
    perform private.notify_calendar_for_phone_peers(old.id, old.merchant_id, old.phone);
    return null;
  end if;

  v_merchant_changed := new.merchant_id is distinct from old.merchant_id;
  begin
    v_phone_changed := private.normalize_phone(new.phone) is distinct from private.normalize_phone(old.phone);
  exception
    when others then
      raise warning 'WarnCalendarLiveSync: %', sqlerrm;
      v_phone_changed := new.phone is distinct from old.phone;
  end;
  v_calendar_changed := v_merchant_changed
    or v_phone_changed
    or new.name is distinct from old.name
    or new.status is distinct from old.status
    or new.unlimited_backend_edit is distinct from old.unlimited_backend_edit;
  v_staff_changed := v_calendar_changed
    or new.can_create_edit_orders is distinct from old.can_create_edit_orders
    or new.show_member_info is distinct from old.show_member_info
    or new.compensation_type is distinct from old.compensation_type;

  v_order_changed := new.display_order is distinct from old.display_order;

  if not v_staff_changed and not v_order_changed then
    return null;
  end if;

  if v_calendar_changed or v_order_changed then
    begin
      perform private.notify_merchant_calendar_changed(new.merchant_id);
      if v_merchant_changed then
        perform private.notify_merchant_calendar_changed(old.merchant_id);
      end if;
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
  end if;

  if v_staff_changed then
    begin
      perform private.notify_staff_schedule_changed(new.id);
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
  end if;

  if v_phone_changed or v_merchant_changed then
    perform private.notify_calendar_for_phone_peers(new.id, old.merchant_id, old.phone);
    perform private.notify_calendar_for_phone_peers(new.id, new.merchant_id, new.phone);
  end if;

  return null;
end;
$function$

;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-G02 public.get_public_available_slots:sql → plpgsql、volatile(要寫入計數);開頭加頻率限制。
--   本體仍是 private.public_available_slots_at(..., now())(那支不計數,測試用)。ACL 不變。
--   ⚠️ volatile 函式 PostgREST 只接受 POST;前端 supabase.rpc() 預設就是 POST(已確認沒有用 { get: true })。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.get_public_available_slots(
  p_slug text,
  p_items jsonb,
  p_staff_id uuid,
  p_from date,
  p_days integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  perform private.enforce_public_rate_limit('public_available_slots');
  return private.public_available_slots_at(p_slug, p_items, p_staff_id, p_from, p_days, now());
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A03 第 10 步 private.customer_booking_initial_status
--   訪客 ⇒ 待確認;黑名單會員 ⇒ 待確認;被排到的主要服務人員開了「客戶預約自動接受」⇒ 已確認(accepted);
--   其他 ⇒ 待確認。direct_accept_after_merchant_confirm 對客人訂單不生效(後台建單專用)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_booking_initial_status(
  p_is_guest boolean,
  p_is_blacklisted boolean,
  p_staff_auto_accept boolean
)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(p_is_guest, true) then 'pending_confirmation'
    when coalesce(p_is_blacklisted, false) then 'pending_confirmation'
    when coalesce(p_staff_auto_accept, false) then 'accepted'
    else 'pending_confirmation'
  end;
$$;
revoke execute on function private.customer_booking_initial_status(boolean, boolean, boolean) from public, anon, authenticated;
grant execute on function private.customer_booking_initial_status(boolean, boolean, boolean) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-C01 private.notify_customer_booking_created(一定發,不看推播開關)
--   收件人(同一個帳號只寫一則,優先順序 管理員 > 客服 > 服務人員):
--     ① 該店管理員(有 user_id)
--     ② 在職、有 user_id、「訂單管理」(orders)權限 granted 的客服
--     ③ 被排到的主要服務人員:在職、已開通登入、有 user_id、staff_calendar_view_allows_notifications(#876)
--   文字(全形標點;姓名去掉換行;不放電話、地址):
--     title  待確認「新的線上預約（待確認）」/ 直接成立「新的線上預約（已成立）」
--     body   客人「王小明」預約 10/13（二）10:00，服務人員：阿明。+(訪客)訪客預約（未登入），請自行與客戶電話確認。
--                                                               +(待確認、非訪客)請確認接單。
--     黑名單:只有管理員 / 客服那幾則多一句「這位客人是黑名單會員，請留意。」
--   服務人員名字用本名(店內的人看,跟 staff_confirm_booking 的鈴鐺一致)。
--   回傳 {title, body}(不含黑名單那句)給 Edge Function 當推播文字(C3-C02 messageOverride)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.notify_customer_booking_created(p_booking_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_b public.bookings;
  v_staff_name text;
  v_blacklisted boolean := false;
  v_local timestamp;
  v_title text;
  v_body text;
  v_body_internal text;
begin
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then
    return null;
  end if;

  select ms.name into v_staff_name from public.merchant_staff ms where ms.id = v_b.staff_id;
  if v_b.member_id is not null then
    select coalesce(m.is_blacklisted, false) into v_blacklisted from public.members m where m.id = v_b.member_id;
    v_blacklisted := coalesce(v_blacklisted, false);
  end if;

  v_local := v_b.start_at at time zone 'Asia/Taipei';
  v_title := case when v_b.status = 'accepted' then '新的線上預約（已成立）' else '新的線上預約（待確認）' end;
  v_body := format(
    '客人「%s」預約 %s（%s）%s，服務人員：%s。',
    regexp_replace(coalesce(nullif(btrim(v_b.customer_name), ''), '未填姓名'), E'\r\n|[\r\n\t]', ' ', 'g'),
    to_char(v_local, 'FMMM/FMDD'),
    (array['日', '一', '二', '三', '四', '五', '六'])[extract(dow from v_local)::integer + 1],
    to_char(v_local, 'HH24:MI'),
    regexp_replace(coalesce(nullif(btrim(v_staff_name), ''), '服務人員'), E'\r\n|[\r\n\t]', ' ', 'g')
  );
  if v_b.is_guest_booking then
    v_body := v_body || '訪客預約（未登入），請自行與客戶電話確認。';
  elsif v_b.status = 'pending_confirmation' then
    v_body := v_body || '請確認接單。';
  end if;
  v_body_internal := v_body || case when v_blacklisted then '這位客人是黑名單會員，請留意。' else '' end;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select distinct on (ma.user_id)
         ma.user_id, v_b.merchant_id, 'admin', ma.id, 'customer_booking_created', v_b.id, v_title, v_body_internal
  from public.merchant_admins ma
  where ma.merchant_id = v_b.merchant_id and ma.user_id is not null
  order by ma.user_id, ma.id;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select distinct on (g.user_id)
         g.user_id, v_b.merchant_id, 'agent', g.id, 'customer_booking_created', v_b.id, v_title, v_body_internal
  from public.merchant_agents g
  where g.merchant_id = v_b.merchant_id
    and g.status = 'active'
    and g.user_id is not null
    and exists (
      select 1 from public.merchant_agent_permissions p
      where p.agent_id = g.id and p.section_key = 'orders' and p.granted = true
    )
    and not exists (
      select 1 from public.user_notifications un
      where un.booking_id = v_b.id and un.event_type = 'customer_booking_created' and un.user_id = g.user_id
    )
  order by g.user_id, g.id;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select ms.user_id, v_b.merchant_id, 'staff', ms.id, 'customer_booking_created', v_b.id, v_title, v_body
  from public.merchant_staff ms
  where ms.id = v_b.staff_id
    and ms.merchant_id = v_b.merchant_id
    and ms.status = 'active'
    and ms.login_status = 'active'
    and ms.user_id is not null
    and private.staff_calendar_view_allows_notifications(ms.id)
    and not exists (
      select 1 from public.user_notifications un
      where un.booking_id = v_b.id and un.event_type = 'customer_booking_created' and un.user_id = ms.user_id
    );

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$$;
revoke execute on function private.notify_customer_booking_created(uuid) from public, anon, authenticated;
grant execute on function private.notify_customer_booking_created(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A05 private.customer_booking_result(零之零 Q5 / Q7 改寫後的格式)
--   {state:'created', booking:{status, start_at, end_at, staff_display, items:[{name, quantity}], address,
--    phone(只有訪客,會員 null), estimated_amount, is_guest}, completion_message}
--   staff_display = 被排到那位的顯示名(暱稱優先,同第 1 批 display_name),不指定也回。
--   completion_message(最外層,跟 state 同層)= 店家自訂(會員 / 訪客分開,有填就照填、不分狀態);沒填 ⇒ 預設句:
--     訪客「店家確認後會與你聯絡。」/ 會員待確認「店家確認後會通知你。」/ 會員直接成立「服務前店家可能會再跟你聯絡確認。」(主腦 10/9 補充)
--   不回:訂單 id、member_id、會員資料、服務人員 id / 本名(有暱稱時)/ 電話、抽成、內部備註、黑名單。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_booking_result(p_booking_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_b public.bookings;
  v_staff_display text;
  v_member_msg text;
  v_guest_msg text;
begin
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('state', 'unavailable');
  end if;

  select coalesce(nullif(btrim(ms.nickname), ''), ms.name) into v_staff_display
  from public.merchant_staff ms where ms.id = v_b.staff_id;

  select s.completion_message_member, s.completion_message_guest into v_member_msg, v_guest_msg
  from public.merchant_booking_settings s where s.merchant_id = v_b.merchant_id;

  return jsonb_build_object(
    'state', 'created',
    'booking', jsonb_build_object(
      'status', v_b.status,
      'start_at', v_b.start_at,
      'end_at', v_b.end_at,
      'staff_display', v_staff_display,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('name', si.name, 'quantity', bsi.quantity)
                         order by case when si.item_type = 'primary' then 0 else 1 end, si.created_at, si.id)
        from public.booking_service_items bsi
        join public.service_items si on si.id = bsi.service_item_id
        where bsi.booking_id = v_b.id
      ), '[]'::jsonb),
      'address', v_b.customer_address,
      'phone', case when v_b.is_guest_booking then v_b.customer_phone else null end,
      'estimated_amount', v_b.final_amount_snapshot,
      'is_guest', v_b.is_guest_booking
    ),
    'completion_message', case
      when v_b.is_guest_booking then coalesce(v_guest_msg, '店家確認後會與你聯絡。')
      when v_member_msg is not null then v_member_msg
      when v_b.status = 'accepted' then '服務前店家可能會再跟你聯絡確認。'
      else '店家確認後會通知你。'
    end
  );
end;
$$;
revoke execute on function private.customer_booking_result(uuid) from public, anon, authenticated;
grant execute on function private.customer_booking_result(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A03 public.internal_customer_submit_booking(只給 service_role;Edge Function customer-booking-submit 呼叫)
--   p_user_id 有值 = 會員送出(Edge 已驗 token 且 app_metadata.account_type = customer);null = 訪客。
--   正常業務結果一律用 state 回傳:created / unavailable / not_linked / guest_not_allowed / slot_taken /
--   too_many_open / contact_store。只有輸入格式錯才 raise(22023 + hint):
--     invalid_request(沒有 submission_id、重送的身分對不上)、invalid_draft、invalid_phone、policy_not_agreed、
--     address_required、invalid_items / no_primary_item / invalid_duration / duration_too_long(同第 1 批);
--     P0001 retry(建會員時剛好撞到別的流程)。
--   回傳多一個 _internal(booking_id、merchant_id、推播文字、replayed),**Edge Function 一定要刪掉再回給客人**。
--   處理順序(規格 C3-A03,「鎖」提前到第 1 步之前:防重送的查詢也要排隊才不會兩個請求同時通過):
--     商家 → 店層級鎖 → 防重送 → 停用 → 身分 → 同意 → 草稿 → 選服務人員(check_customer_booking_slot,
--     不指定依順位 display_order 挑第一位能排的)→ 會員 / 未完成上限 3 → 初始狀態 → 金額 / 派點 → 寫入 →
--     操作紀錄 → 同意紀錄(只有訪客)→ 鈴鐺。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.internal_customer_submit_booking(
  p_slug text,
  p_user_id uuid,
  p_guest_phone text,
  p_draft jsonb,
  p_agree_policy boolean,
  p_submission_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_merchant public.merchants;
  v_is_guest boolean := p_user_id is null;
  v_existing public.bookings;
  v_member public.members;
  v_member_id uuid;
  v_member_count integer;
  v_member_created boolean := false;
  v_guest_phone text;
  v_guest_phone_norm text;
  v_allow_guest boolean;
  v_parsed record;
  v_staff_id uuid;
  v_date date;
  v_time time;
  v_name text;
  v_address text;
  v_notes text;
  v_start timestamptz;
  v_end timestamptz;
  v_now timestamptz := now();
  v_cand public.merchant_staff;
  v_chosen public.merchant_staff;
  v_found boolean := false;
  v_status text;
  v_amount record;
  v_points record;
  v_service_items jsonb;
  v_booking_id uuid;
  v_customer_phone text;
  v_policy_enabled boolean;
  v_policy_hash text;
  v_push jsonb;
begin
  if p_submission_id is null then
    raise exception '送出資料不完整，請重新整理後再試一次。' using errcode = '22023', hint = 'invalid_request';
  end if;
  if p_draft is null or jsonb_typeof(p_draft) <> 'object' then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;

  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    return jsonb_build_object('state', 'unavailable');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('c3_submit:' || v_merchant.id::text, 0));

  select * into v_existing from public.bookings
  where merchant_id = v_merchant.id and customer_submission_id = p_submission_id;
  if found then
    if v_existing.created_by_user_id is distinct from p_user_id
       or v_existing.is_guest_booking is distinct from v_is_guest
       or (v_is_guest and (private.normalize_phone(btrim(coalesce(p_guest_phone, ''))) is null
                           or private.normalize_phone(btrim(coalesce(p_guest_phone, '')))
                              is distinct from private.normalize_phone(v_existing.customer_phone))) then
      raise exception '送出資料不完整，請重新整理後再試一次。' using errcode = '22023', hint = 'invalid_request';
    end if;
    return private.customer_booking_result(v_existing.id)
      || jsonb_build_object('_internal', jsonb_build_object('replayed', true));
  end if;

  if v_merchant.status is distinct from 'active' then
    return jsonb_build_object('state', 'unavailable');
  end if;

  if not v_is_guest then
    if not exists (
         select 1 from auth.users u
         where u.id = p_user_id and coalesce(u.raw_app_meta_data ->> 'account_type', '') = 'customer'
       )
       or private.customer_link_state(v_merchant.id, p_user_id) <> 'linked' then
      return jsonb_build_object('state', 'not_linked');
    end if;
    select * into v_member from public.members m
    where m.merchant_id = v_merchant.id and m.user_id = p_user_id and m.status = 'active'
    order by m.created_at, m.id
    limit 1;
  else
    select s.allow_guest_booking into v_allow_guest
    from public.merchant_booking_settings s where s.merchant_id = v_merchant.id;
    if not coalesce(v_allow_guest, true) then
      return jsonb_build_object('state', 'guest_not_allowed');
    end if;
    if p_guest_phone is null or not private.is_valid_customer_phone(btrim(p_guest_phone)) then
      raise exception '電話格式不正確。手機請填 09 開頭共 10 碼，市話請連同區碼填 9~10 碼，不用填分機。'
        using errcode = '22023', hint = 'invalid_phone';
    end if;
    v_guest_phone := btrim(p_guest_phone);
    v_guest_phone_norm := private.normalize_phone(v_guest_phone);
  end if;

  if p_agree_policy is not true then
    raise exception '請先勾選同意會員政策與隱私權政策。' using errcode = '22023', hint = 'policy_not_agreed';
  end if;

  select * into v_parsed from private.customer_parse_booking_items(v_merchant.id, p_draft -> 'items');

  if jsonb_typeof(p_draft -> 'staff_id') = 'string' then
    if (p_draft ->> 'staff_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
    end if;
    v_staff_id := (p_draft ->> 'staff_id')::uuid;
    if not exists (select 1 from public.merchant_staff ms where ms.id = v_staff_id and ms.merchant_id = v_merchant.id) then
      raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
    end if;
  elsif coalesce(jsonb_typeof(p_draft -> 'staff_id'), 'null') <> 'null' then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;

  if jsonb_typeof(p_draft -> 'date') is distinct from 'string'
     or (p_draft ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_draft -> 'time') is distinct from 'string'
     or (p_draft ->> 'time') !~ '^([01]\d|2[0-3]):[0-5]\d$' then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;
  begin
    v_date := to_date(p_draft ->> 'date', 'YYYY-MM-DD');
    if to_char(v_date, 'YYYY-MM-DD') <> (p_draft ->> 'date') then
      raise exception 'bad date';
    end if;
    v_time := (p_draft ->> 'time')::time;
  exception when others then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end;

  if jsonb_typeof(p_draft -> 'name') is distinct from 'string' then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;
  v_name := btrim(regexp_replace(p_draft ->> 'name', '[\r\n\t]+', ' ', 'g'));
  if char_length(v_name) < 1 or char_length(v_name) > 50 then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;

  if coalesce(jsonb_typeof(p_draft -> 'address'), 'null') not in ('null', 'string')
     or coalesce(jsonb_typeof(p_draft -> 'notes'), 'null') not in ('null', 'string') then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;
  v_address := nullif(btrim(coalesce(p_draft ->> 'address', '')), '');
  v_notes := nullif(btrim(coalesce(p_draft ->> 'notes', '')), '');
  if char_length(coalesce(v_address, '')) > 200 or char_length(coalesce(v_notes, '')) > 500 then
    raise exception '預約資料不正確，請重新操作。' using errcode = '22023', hint = 'invalid_draft';
  end if;
  if private.industry_requires_customer_address(v_merchant.industry_type) and v_address is null then
    raise exception '請填寫服務地址。' using errcode = '22023', hint = 'address_required';
  end if;

  v_start := (v_date + v_time) at time zone 'Asia/Taipei';
  v_end := v_start + make_interval(mins => v_parsed.duration_minutes);

  for v_cand in
    select ms.*
    from public.merchant_staff ms
    where ms.merchant_id = v_merchant.id
      and ms.status = 'active'
      and ms.is_listed = true
      and (v_staff_id is null or ms.id = v_staff_id)
      and private.customer_staff_can_do_items(ms.id, v_parsed.primary_item_ids)
    order by ms.display_order, ms.created_at, ms.id
  loop
    if private.check_customer_booking_slot(v_merchant.id, v_cand, v_start, v_end, v_now, null) is null then
      v_chosen := v_cand;
      v_found := true;
      exit;
    end if;
  end loop;
  if not v_found then
    return jsonb_build_object('state', 'slot_taken');
  end if;

  if not v_is_guest then
    if v_member.id is null or nullif(btrim(coalesce(v_member.phone, '')), '') is null then
      return jsonb_build_object('state', 'contact_store');
    end if;
    if private.customer_open_booking_count(v_merchant.id, v_member.phone, v_member.id) >= 3 then
      return jsonb_build_object('state', 'too_many_open');
    end if;
    v_customer_phone := btrim(v_member.phone);
  else
    perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_merchant.id::text || ':' || v_guest_phone_norm, 0));
    select count(*)::integer, min(m.id::text)::uuid into v_member_count, v_member_id
    from public.members m
    where m.merchant_id = v_merchant.id and m.status = 'active' and private.normalize_phone(m.phone) = v_guest_phone_norm;
    if v_member_count >= 2 then
      return jsonb_build_object('state', 'contact_store');
    end if;
    if private.customer_open_booking_count(v_merchant.id, v_guest_phone, v_member_id) >= 3 then
      return jsonb_build_object('state', 'too_many_open');
    end if;
    if v_member_count = 0 then
      begin
        v_member_id := private.resolve_guest_member(v_merchant.id, v_guest_phone, v_name);
      exception when others then
        raise exception '系統忙碌，請稍後再試一次。' using errcode = 'P0001', hint = 'retry';
      end;
      v_member_created := true;
    end if;
    select * into v_member from public.members where id = v_member_id;
    v_customer_phone := v_guest_phone;
  end if;

  v_status := private.customer_booking_initial_status(
    v_is_guest,
    case when v_is_guest then false else coalesce(v_member.is_blacklisted, false) end,
    coalesce(v_chosen.auto_accept_booking, false)
  );

  select * into v_amount from private.calculate_booking_amount(
    v_parsed.items_subtotal, false, null, false, null, null, false, null, null
  );

  select coalesce(jsonb_agg(jsonb_build_object(
           'service_item_id', e ->> 'service_item_id',
           'quantity', (e ->> 'quantity')::integer,
           'unit_price', (e ->> 'price')::numeric
         )), '[]'::jsonb)
    into v_service_items
  from jsonb_array_elements(v_parsed.items) e;

  select * into v_points from private.compute_booking_planned_points(
    v_merchant.id, v_member.id, v_service_items, v_amount.final_amount, false, false, false
  );

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method_id, payment_method_name_snapshot,
    custom_duration_enabled, custom_duration_minutes,
    member_id, member_name_snapshot,
    hide_notes_from_staff,
    member_auto_created,
    points_planned, points_planned_auto, points_planned_overridden, points_review_required,
    points_planned_breakdown, points_redeemed, points_redeem_amount_snapshot,
    is_guest_booking, customer_submission_id
  ) values (
    v_merchant.id, v_chosen.id, v_start, v_end,
    v_name, v_customer_phone, null, v_address, null, v_notes,
    'customer', 'customer', p_user_id, v_status,
    false, null, v_amount.subtotal_amount,
    false, null, null, v_amount.discount_amount,
    false, null, null, v_amount.tax_amount,
    v_amount.final_amount, null, null,
    false, null,
    v_member.id, v_member.name,
    false,
    v_member_created,
    coalesce(v_points.auto_points, 0), coalesce(v_points.auto_points, 0), false, coalesce(v_points.review_required, false),
    coalesce(v_points.breakdown, '[]'::jsonb), 0, 0,
    v_is_guest, p_submission_id
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select v_booking_id,
         (e ->> 'service_item_id')::uuid,
         (e ->> 'duration_minutes')::integer,
         (e ->> 'quantity')::integer,
         (e ->> 'price')::numeric
  from jsonb_array_elements(v_parsed.items) e;

  insert into public.booking_status_change_logs (
    booking_id, merchant_id, from_status, to_status,
    actor_user_id, actor_name_snapshot, actor_role_snapshot, created_at
  ) values (
    v_booking_id, v_merchant.id, null, v_status,
    p_user_id, case when v_is_guest then '訪客 ' else '客人 ' end || v_name, 'customer', clock_timestamp()
  );

  if v_is_guest then
    select coalesce(ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null, false),
           case when ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null
                then md5(ms.policy_content) else null end
      into v_policy_enabled, v_policy_hash
    from public.merchant_member_settings ms where ms.merchant_id = v_merchant.id;
    insert into public.customer_policy_consents (
      merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
    ) values (
      v_merchant.id, null, v_member.id, v_guest_phone_norm, 'guest_booking', coalesce(v_policy_enabled, false), v_policy_hash, '2026-10-08'
    );
  end if;

  v_push := private.notify_customer_booking_created(v_booking_id);

  return private.customer_booking_result(v_booking_id)
    || jsonb_build_object('_internal', jsonb_build_object(
         'replayed', false,
         'booking_id', v_booking_id,
         'merchant_id', v_merchant.id,
         'push_title', v_push ->> 'title',
         'push_body', v_push ->> 'body'
       ));
end;
$$;
revoke execute on function public.internal_customer_submit_booking(text, uuid, text, jsonb, boolean, uuid) from public, anon, authenticated;
grant execute on function public.internal_customer_submit_booking(text, uuid, text, jsonb, boolean, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C3-H02 public.move_merchant_staff_order(p_staff_id, 'up' | 'down')
--   權限:跟「編輯服務人員資料」同一個門檻 = merchant_staff_update 政策用的
--         private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id)
--         (can_manage_staff = 管理員,或在職且 staff_management 權限 granted 的客服)。
--   範圍:同店、在職的人之間交換(已移除的不參與,已移除的人本身也不能調整)。
--   排序鍵 (display_order, created_at, id);若這間店在職的人有重複順位,先依目前順序重新編號再交換。
--   同店鎖(跟新增服務人員的 trigger 同一把)避免兩人同時按造成順位重複。
--   回傳 {state:'moved'} 或 {state:'edge'}(已經在最上 / 最下,不報錯)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.move_merchant_staff_order(p_staff_id uuid, p_direction text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_merchant_id uuid;
  v_me public.merchant_staff;
  v_other public.merchant_staff;
begin
  if v_uid is null then
    raise exception '請先登入' using errcode = '42501';
  end if;

  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;
  if v_merchant_id is null
     or not (private.is_merchant_admin(v_merchant_id) or private.can_manage_staff(v_merchant_id)) then
    raise exception '沒有權限調整這位服務人員的順位' using errcode = '42501';
  end if;

  if p_direction is null or p_direction not in ('up', 'down') then
    raise exception '調整方向不正確' using errcode = '22023', hint = 'invalid_direction';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('staff_display_order:' || v_merchant_id::text, 0));

  select * into v_me from public.merchant_staff where id = p_staff_id;
  if v_me.status is distinct from 'active' then
    raise exception '已移除的服務人員不能調整順位' using errcode = '22023', hint = 'staff_not_active';
  end if;

  perform set_config('staff_agent.bypass_display_order_guard', 'on', true);

  if exists (
    select 1 from public.merchant_staff ms
    where ms.merchant_id = v_merchant_id and ms.status = 'active'
    group by ms.display_order having count(*) > 1
  ) then
    update public.merchant_staff ms
       set display_order = r.rn
      from (
        select x.id, row_number() over (order by x.display_order, x.created_at, x.id)::integer as rn
        from public.merchant_staff x
        where x.merchant_id = v_merchant_id and x.status = 'active'
      ) r
     where ms.id = r.id and ms.display_order is distinct from r.rn;
    select * into v_me from public.merchant_staff where id = p_staff_id;
  end if;

  if p_direction = 'up' then
    select * into v_other from public.merchant_staff ms
    where ms.merchant_id = v_merchant_id and ms.status = 'active' and ms.id <> v_me.id
      and (ms.display_order, ms.created_at, ms.id) < (v_me.display_order, v_me.created_at, v_me.id)
    order by ms.display_order desc, ms.created_at desc, ms.id desc
    limit 1;
  else
    select * into v_other from public.merchant_staff ms
    where ms.merchant_id = v_merchant_id and ms.status = 'active' and ms.id <> v_me.id
      and (ms.display_order, ms.created_at, ms.id) > (v_me.display_order, v_me.created_at, v_me.id)
    order by ms.display_order, ms.created_at, ms.id
    limit 1;
  end if;

  if v_other.id is null then
    perform set_config('staff_agent.bypass_display_order_guard', 'off', true);
    return jsonb_build_object('state', 'edge');
  end if;

  update public.merchant_staff set display_order = v_other.display_order where id = v_me.id;
  update public.merchant_staff set display_order = v_me.display_order where id = v_other.id;

  perform set_config('staff_agent.bypass_display_order_guard', 'off', true);
  return jsonb_build_object('state', 'moved');
end;
$$;
revoke execute on function public.move_merchant_staff_order(uuid, text) from public, anon;
grant execute on function public.move_merchant_staff_order(uuid, text) to authenticated, service_role;

-- ─── public.get_staff_schedule_overview(C3-H04 主腦補充:排班一覽也是商家端行事曆類畫面,服務人員依順位排序,原本依姓名)───
CREATE OR REPLACE FUNCTION public.get_staff_schedule_overview(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_staff_result jsonb := '[]'::jsonb;
  v_staff record;
  v_days jsonb;
  v_cursor date;
  v_day_of_week smallint;
  v_windows jsonb;
  v_overrides jsonb;
  v_on_leave jsonb;
  v_booking_count int;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  if not private.can_view_scheduling(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的排班一覽' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  for v_staff in
    select id, name, unlimited_backend_edit
    from public.merchant_staff
    where merchant_id = p_merchant_id and status = 'active'
    order by display_order, created_at, id
  loop
    v_days := '[]'::jsonb;
    v_cursor := p_start_date;

    while v_cursor <= p_end_date loop
      v_day_of_week := extract(dow from v_cursor)::smallint;
      v_day_start := (v_cursor::timestamp) at time zone 'Asia/Taipei';
      v_day_end := ((v_cursor + 1)::timestamp) at time zone 'Asia/Taipei';

      -- ①每週固定時段摘要:unlimited_backend_edit=true 標記「不受時段限制」,否則列出
      -- (SPECS-INDEX #977,2026-10-06 第 3 批:改前看 no_time_slot_limit;那個欄位只留給客戶線上預約,
      --  後台的放寬一律看 unlimited_backend_edit,跟 check_staff_booking_slot / 行事曆同一個欄位)
      -- staff_availability_windows 當天(day_of_week)的時段清單(可能是空陣列=未設定)。
      if v_staff.unlimited_backend_edit then
        v_windows := jsonb_build_array(jsonb_build_object('unrestricted', true));
      else
        select coalesce(
          jsonb_agg(
            jsonb_build_object('start_time', saw.start_time, 'end_time', saw.end_time)
            order by saw.start_time
          ),
          '[]'::jsonb
        )
        into v_windows
        from public.staff_availability_windows saw
        where saw.staff_id = v_staff.id and saw.day_of_week = v_day_of_week;
      end if;

      -- ②單日例外區間,合併相鄰同值半小時格子(比照 get_merchant_day_schedule 既有寫法)。
      select coalesce((
        select jsonb_agg(
          jsonb_build_object('start_time', grp_start, 'end_time', grp_end, 'is_available', grp_is_available)
          order by grp_start
        )
        from (
          select min(slot_start_time) as grp_start,
                 max(slot_start_time) + interval '30 minutes' as grp_end,
                 is_available as grp_is_available
          from (
            select
              slot_start_time,
              is_available,
              sum(is_new_group) over (order by slot_start_time) as grp_id
            from (
              select
                slot_start_time,
                is_available,
                case
                  when lag(slot_start_time) over (order by slot_start_time) = slot_start_time - interval '30 minutes'
                       and lag(is_available) over (order by slot_start_time) = is_available
                  then 0
                  else 1
                end as is_new_group
              from public.staff_availability_overrides
              where staff_id = v_staff.id and override_date = v_cursor
            ) marked
          ) grouped
          group by grp_id, is_available
        ) merged
      ), '[]'::jsonb) into v_overrides;

      -- ③是否請假(比照 get_merchant_day_schedule 的 on_leave 寫法,快照名稱)。
      select jsonb_build_object('leave_record_id', slr.id, 'leave_type_name', slr.leave_type_name_snapshot)
      into v_on_leave
      from public.staff_leave_records slr
      where slr.staff_id = v_staff.id
        and slr.status = 'confirmed'
        and v_cursor between slr.start_date and slr.end_date
      limit 1;

      -- ④這天這位服務人員名下(含助手身份)非取消狀態的預約筆數,只給數字不展開明細。
      select count(*) into v_booking_count
      from (
        select b.id
        from public.bookings b
        where b.staff_id = v_staff.id
          and b.merchant_id = p_merchant_id
          and b.status <> 'cancelled'
          and b.start_at < v_day_end
          and b.end_at > v_day_start
        union
        select b.id
        from public.booking_assistants ba
        join public.bookings b on b.id = ba.booking_id
        where ba.staff_id = v_staff.id
          and b.merchant_id = p_merchant_id
          and b.status <> 'cancelled'
          and b.start_at < v_day_end
          and b.end_at > v_day_start
      ) bb;

      v_days := v_days || jsonb_build_array(jsonb_build_object(
        'date', v_cursor,
        'windows', v_windows,
        'overrides', v_overrides,
        'on_leave', v_on_leave,
        'booking_count', v_booking_count
      ));

      v_cursor := v_cursor + 1;
    end loop;

    v_staff_result := v_staff_result || jsonb_build_array(jsonb_build_object(
      'staff_id', v_staff.id,
      'staff_name', v_staff.name,
      'unlimited_backend_edit', v_staff.unlimited_backend_edit,
      'days', v_days
    ));
  end loop;

  return jsonb_build_object(
    'start_date', p_start_date,
    'end_date', p_end_date,
    'staff', v_staff_result
  );
end;
$function$

;

-- ─── public.list_report_export_staff(使用者 Q3-c:後台所有選服務人員的地方都依順位;報表匯出中心下拉改依順位,原本依姓名)───
CREATE OR REPLACE FUNCTION public.list_report_export_staff(p_merchant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not private.can_export_reports(p_merchant_id) then
    raise exception '沒有權限使用這間商家的報表匯出中心' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', ms.id, 'name', ms.name) order by ms.display_order, ms.created_at, ms.id)
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id
      and ms.status = 'active'
  ), '[]'::jsonb);
end;
$function$

;

-- ─── public.get_merchant_billing_summary(使用者 Q3-c / 主腦裁決:帳單報表逐位服務人員依順位,原本依姓名;回傳欄位不變)───
CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month_start date;
  v_next_month_start date;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_as_of timestamptz;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_next_month_start := v_month_start + interval '1 month';
  v_range_start := v_month_start::timestamp at time zone 'Asia/Taipei';
  v_range_end := v_next_month_start::timestamp at time zone 'Asia/Taipei';
  -- 該年月最後一天結束前的那一刻(Asia/Taipei),比照 11.7 compute_staff_payroll 的邊界寫法。
  v_as_of := v_range_end - interval '1 microsecond';

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  --
  -- 2026-09-24(任務 1,使用者裁決「都已完成時間做依據」「完成代表收到錢」):月份基準從
  -- b.start_at(預約發生的時間)改成「完成時間」coalesce(b.completed_at, b.start_at)。
  -- coalesce 的 fallback 只會對「直接 INSERT 出來、沒走 complete_booking 的歷史匯入訂單」
  -- 生效(§2 已回填既有的 14 筆,20260924040100 已修掉根因,這裡是防禦性保留,理由見檔頭)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

  -- 第 11 批 F #993:amount_snapshot 是「單價」,料錢合計 = Σ 單價 × 數量。
  select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持用 bcr.computed_at:已查證它跟該訂單的 completed_at 完全相等(25/25 筆,
  -- max_diff 0.000000 秒),而且 recalculate_booking_commission 不會改動 computed_at
  -- (只改 recalculated_at),所以這已經就是「完成時間」,改成 join bookings 只會白白
  -- 失去 booking_commission_records_merchant_id_computed_at_idx 這個既有索引。詳見檔頭。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8:total_monthly_salary_base 呼叫 private.get_merchant_monthly_salary_base_as_of(11.6)。
  select total_amount, is_estimated
  into v_total_salary_base, v_salary_estimated
  from private.get_merchant_monthly_salary_base_as_of(p_merchant_id, v_as_of);

  -- 2026-09-24(任務 2,使用者裁決「即便這個人離職,紀錄還是存在」):母體從
  -- `where ms.status = 'active'`(現在的狀態)改成「該月月底當時 existed 且 status=active」
  -- ——跟上面 11.6 算基本額用的是同一個 v_as_of、同一組條件,兩邊母體從此必然一致。
  -- ⚠️ 這推翻 §11.9「per_staff_breakdown 維持目前在職名單」的決策記錄,以使用者裁決為準。
  -- compensation_type 也取「那個時間點」的值,不是現在的值(同一個人可能中途改過計酬類型)。
  --
  -- is_active_as_of(2026-09-24 主腦裁決追加):讓前端知道要不要在這一列旁邊顯示「已離職」標籤。
  -- ⚠️ 語意說明(這個欄位名跟它實際的意思有落差,已在回報中提出可改名,讀到這裡請以本註解為準):
  --    它的值是「這個人**目前**是否仍在職」(ms.status = 'active',查詢執行當下的狀態),
  --    **不是**「在 v_as_of 那個時間點是否在職」。
  --    原因:這支函式的母體條件已經是「該月月底當時 existed 且 status=active」,所以「在 as_of
  --    那一刻是否在職」對每一列**恆為 true**,當成旗標毫無資訊量。真正驅動「已離職」標籤的判斷
  --    是「這個人已經離開了,所以你在這張 9 月報表上看到一個現在名單裡沒有的人」——那必須看
  --    目前狀態。若主腦要改名,建議 is_currently_active。
  for rec in
    select ms.id, ms.name, s.compensation_type, (ms.status = 'active') as is_currently_active
    from public.merchant_staff ms
    join lateral private.get_staff_payroll_status_as_of(ms.id, v_as_of) s on true
    where ms.merchant_id = p_merchant_id
      and s.existed
      and s.status = 'active'
    order by ms.display_order, ms.created_at, ms.id
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      v_payroll := private.compute_staff_payroll(rec.id, p_year, p_month);
      v_total_salary_deduction := v_total_salary_deduction
        + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', v_payroll -> 'net_pay',
        'commission_amount', null
      );
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin',
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction),
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    -- 任務 3:按年月查詢本質上就是一個完整月份,固定 true(加上這個欄位只是為了讓兩支
    -- 函式的回傳形狀一致,前端不用分兩套處理)。
    'salary_applicable', true,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count
  );
end;
$function$

;

-- ─── public.get_merchant_billing_summary_by_range(同上;group by 多帶 display_order、created_at 只為排序,回傳欄位不變)───
CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary_by_range(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_salary_applicable boolean;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_estimated_net_margin numeric(10, 2);
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC
  -- 查詢過大區間造成效能問題或撈出超出預期範圍的資料。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- =======================================================================
  -- 任務 3(使用者已回覆「可以」):月薪相關數字只在「完整月份」的查詢下才計算。
  -- 條件:起始日是某個月的 1 號,且結束日是某個月的最後一天(可以跨多個月,2/1–4/30 合法)。
  --   ・p_start_date 是 1 號          → date_trunc('month', p_start_date) = p_start_date
  --   ・p_end_date 是該月最後一天     → p_end_date + 1 天之後就會跨到下個月的 1 號
  -- 這同時消滅一個真的 bug:原本不論區間頭尾是不是完整月份,都用 generate_series 以「月初」
  -- 為單位展開,所以「查 2/15–3/15(29 天)」會收到 2 個整月的月薪基本額,而扣款那一邊
  -- (compute_staff_payroll_by_range)卻是按區間裁切的 → 兩邊口徑不一致,月薪實發沒有意義。
  -- =======================================================================
  v_salary_applicable := (
    p_start_date = date_trunc('month', p_start_date)::date
    and (p_end_date + 1) = date_trunc('month', (p_end_date + 1)::date)::date
  );

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  -- 2026-09-24(任務 1):月份/區間基準從 b.start_at 改成完成時間(理由見檔頭與 §3 的註解)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

  -- 第 11 批 F #993:amount_snapshot 是「單價」,料錢合計 = Σ 單價 × 數量。
  select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持 computed_at(已查證 ≡ completed_at,且事後重算不改它,詳見檔頭)。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8(核心):比照 11.7 的「逐月迴圈」邏輯,對區間內每個月份呼叫 11.6,把每個月份的加總
  -- 結果再加總。只要任一月份任一人用到估算,salary_estimation_applied 就是 true。
  -- 2026-09-24(任務 3):只在 v_salary_applicable 為真時才算;不是完整月份時一律留 null
  -- (不是 0——前端要能分辨「不適用」與「真的是零」)。
  if v_salary_applicable then
    select
      coalesce(sum(gm.total_amount), 0),
      coalesce(bool_or(gm.is_estimated), false)
    into v_total_salary_base, v_salary_estimated
    from generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start)
    cross join lateral private.get_merchant_monthly_salary_base_as_of(
      p_merchant_id,
      ((least((m.month_start + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
        at time zone 'Asia/Taipei') - interval '1 microsecond'
    ) as gm;
  else
    v_total_salary_base := null;
    v_total_salary_deduction := null;
    v_salary_estimated := false;
  end if;

  -- 2026-09-24(任務 2):母體改成「區間內至少有一個月份,在該月的 as_of 時間點 existed 且
  -- status=active」的人——跟上面 11.6 逐月加總用的是同一套 as_of 算式(含 least(..., p_end_date)
  -- 的裁切)與同一組條件,兩邊母體必然一致。compensation_type 取「區間內最後一個當時在職月份」
  -- 的值(同一個人可能中途改過計酬類型;取最後一個月份跟 §11 一貫的「月底當下的值」慣例一致)。
  -- 這同時修掉一個附帶的對不起來:已離職的按件計酬人員,他的抽成一直都被算進
  -- total_commission_payout(那個查詢只看 merchant_id + computed_at,不看人員狀態),卻沒有
  -- 任何一列明細承載它。
  for rec in
    with months as (
      select
        gs::date as month_start,
        ((least((gs + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
          at time zone 'Asia/Taipei') - interval '1 microsecond' as as_of
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    staff_months as (
      select
        ms.id, ms.name, ms.display_order, ms.created_at, m.month_start, s.compensation_type,
        -- is_active_as_of 的來源:merchant_staff.status 是「目前」的狀態(語意說明見單月版註解)。
        (ms.status = 'active') as is_currently_active
      from public.merchant_staff ms
      cross join months m
      join lateral private.get_staff_payroll_status_as_of(ms.id, m.as_of) s on true
      where ms.merchant_id = p_merchant_id
        and s.existed
        and s.status = 'active'
    )
    select
      id,
      name,
      is_currently_active,
      (array_agg(compensation_type order by month_start desc))[1] as compensation_type
    from staff_months
    -- is_currently_active 對同一個 id 只有一個值(它來自 merchant_staff 那一列),放進 group by
    -- 只是為了讓它能被 select,不會讓分組變細。
    group by id, name, is_currently_active, display_order, created_at
    order by display_order, created_at, id
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      if v_salary_applicable then
        -- §3.6:跨月時依區間內實際涵蓋的每個月份分別計算「當月實際天數」再加總,不是整個區間套用
        -- 同一個天數——private.compute_staff_payroll_by_range 內部已經處理這個邏輯。
        v_payroll := private.compute_staff_payroll_by_range(rec.id, p_start_date, p_end_date);
        v_total_salary_deduction := v_total_salary_deduction
          + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', v_payroll -> 'net_pay',
          'commission_amount', null
        );
      else
        -- 任務 3:不是完整月份時,月薪制人員照樣列在明細上(order_count 仍然有意義),
        -- 但 net_pay 回 null,代表「這個區間算不出月薪實發」,不是「實發 0 元」。
        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', null,
          'commission_amount', null
        );
      end if;
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  -- 任務 3:商家總淨利(概估毛利)是「營收 − 料錢 − 抽成 − 月薪實發」,只要月薪那一段算不出來,
  -- 整個數字就沒有意義 → 一律 null,不是拿營收減一減硬湊一個數字出來給商家看。
  if v_salary_applicable then
    v_estimated_net_margin :=
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction);
  else
    v_estimated_net_margin := null;
  end if;

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin', v_estimated_net_margin,
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    'salary_applicable', v_salary_applicable,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count
  );
end;
$function$

;
