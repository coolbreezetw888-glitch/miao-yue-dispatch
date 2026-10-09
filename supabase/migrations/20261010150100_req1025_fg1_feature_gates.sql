-- SPECS-INDEX #1025 功能開關 第 1 批(FG-1):三個功能的擋住點(資料庫端,T6:畫面隱藏只是輔助)。
-- 規格書 .project/specs/功能開關.md(第 2 版)FG1-F01、FG1-F02。前置:20261010150000(功能清單、merchant_has_feature)。
--
-- FG1-F01 客戶線上預約(online_booking):
--   新增 private.merchant_public_booking_open = 商家 active 且有 online_booking。
--   get_public_booking_page / get_public_available_slots(本體 private.public_available_slots_at)/
--   internal_customer_submit_booking 原本的「status is distinct from 'active'」分支改看它 ⇒ 回應**逐字相同**
--   (客人看到的仍是「這間店目前暫停線上預約」,不透露店家沒開通 —— X5)。
--   其他有 page_unavailable / status 檢查的客戶端函式這批不改(清單在回報)。
-- FG1-F02 報表匯出中心(report_export)、資料匯入(data_import):
--   private.can_export_reports 再 AND merchant_has_feature(…, 'report_export')(export_orders / members / leave_report、
--   list_report_export_staff、get_staff_commission_summary 的 report_export 分支都經過它)。
--   import_members_batch / import_historical_bookings_batch:權限檢查之後加 feature_disabled 擋。
--   rollback_bulk_operation、get_merchant_bulk_operations 資料庫端不擋(資料保留,重新打開照常可用)。
--
-- 函式本體以「改前的 pg_proc.prosrc」為底,只換規格指定的那一段(其餘逐字不變;ACL、comment 由 create or replace 保留)。
-- 改前 / 改後指紋 md5(replace(prosrc, CRLF, LF)):
--   get_public_booking_page            bc040acb3bb5d5a7d5782ea7fe54998f → 212958ef4e27c263d9776e3481de4442
--   private.public_available_slots_at  b0fddb51808b458e5e3fead6195147f8 → b82d33274b62127a1631453f170a8c00
--   internal_customer_submit_booking   543077d278e1a80826c8c1183a0e4259 → cf4a56395623d8dce1098dd40e8639f6
--   import_members_batch               821a69e8af08ed63ab6ad5f1f80aeeb9 → fe8c3247473de82a9a6604105fd01149
--   import_historical_bookings_batch   b6948b24d5e57cc82057d4b202ce13ec → 75178fc1b757a2b7d95befea554bed2d
--   (get_public_available_slots 本體只呼叫 public_available_slots_at,沒有改:13a8a5afe35a8f8a53ee750826681647)

-- =========================================================================
-- FG1-F01 private.merchant_public_booking_open
-- =========================================================================
create or replace function private.merchant_public_booking_open(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select m.status = 'active' from public.merchants m where m.id = p_merchant_id), false)
    and private.merchant_has_feature(p_merchant_id, 'online_booking');
$$;

comment on function private.merchant_public_booking_open(uuid) is
  'SPECS-INDEX #1025 FG1-F01:客人能不能線上預約這間店 = 商家 active 且平台功能 online_booking 開著。三支客戶端預約函式的「暫停線上預約」分支都看這支。只給內部呼叫。';

revoke execute on function private.merchant_public_booking_open(uuid) from public, anon, authenticated;

-- =========================================================================
-- FG1-F02 private.can_export_reports:再 AND report_export 功能開關
-- =========================================================================
create or replace function private.can_export_reports(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    (
      private.is_merchant_admin(p_merchant_id)
      or exists (
        select 1
        from public.merchant_agents ma
        join public.merchant_agent_permissions map on map.agent_id = ma.id
        where ma.merchant_id = p_merchant_id
          and ma.user_id = auth.uid()
          and ma.status = 'active'
          and map.section_key = 'report_export'
          and map.granted = true
      )
    )
    -- [req1025] FG1-F02:平台功能開關「報表匯出中心」關閉 ⇒ 管理員也不行。
    and private.merchant_has_feature(p_merchant_id, 'report_export');
$$;

comment on function private.can_export_reports(uuid) is
  'SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心的後端權限 = 商家管理員,或 report_export 權限開啟的在職客服。跟前端 RequireReportExportAccess 同一個判斷。SPECS-INDEX #1025 FG1-F02 起再加:平台功能開關 report_export 要開著(管理員也一樣)。';

-- =========================================================================
-- 三支客戶端預約函式 + 兩支匯入函式(改前 prosrc 為底,只換一段)
-- =========================================================================
-- get_public_booking_page:原本「status is distinct from active ⇒ unavailable」改看 merchant_public_booking_open。其餘逐字不變。
CREATE OR REPLACE FUNCTION public.get_public_booking_page(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant public.merchants;
  v_allow_guest boolean;
  v_line_login_enabled boolean;
  v_member_policy text;
  v_cancel_hours integer;
begin
  perform private.enforce_public_rate_limit('public_booking_page');

  select * into v_merchant
  from public.merchants
  where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- [req1025] FG1-F01:商家停用 或 平台關掉「客戶線上預約」⇒ 同一個「暫停線上預約」回應(不透露沒開通)。
  if not private.merchant_public_booking_open(v_merchant.id) then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select s.allow_guest_booking, s.customer_cancel_deadline_hours into v_allow_guest, v_cancel_hours
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
      'member_policy', v_member_policy,
      'customer_cancel_deadline_hours', coalesce(v_cancel_hours, 24),
      -- [c5] C5-M04:店家能不能用 LINE 通知客人(boolean,不回任何官方帳號資料)。
      'line_notify_available', private.customer_line_notify_available(v_merchant.id)
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
$function$;

-- private.public_available_slots_at(get_public_available_slots 的本體):同上,page_unavailable 錯誤(訊息 / errcode / hint)逐字不變。
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
  -- [req1025] FG1-F01:商家停用 或 平台關掉「客戶線上預約」⇒ 同一個「暫停線上預約」回應(不透露沒開通)。
  if not private.merchant_public_booking_open(v_merchant.id) then
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
$function$;

-- internal_customer_submit_booking:同上(重送同一個 submission_id 的冪等回放仍在這個判斷之前,行為不變)。
CREATE OR REPLACE FUNCTION public.internal_customer_submit_booking(p_slug text, p_user_id uuid, p_guest_phone text, p_draft jsonb, p_agree_policy boolean, p_submission_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_contact_id uuid;
  v_contact_phone text;
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

  -- [req1025] FG1-F01:商家停用 或 平台關掉「客戶線上預約」⇒ 同一個「暫停線上預約」回應(不透露沒開通)。
  if not private.merchant_public_booking_open(v_merchant.id) then
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
    select c.member_id, c.contact_id into v_member_id, v_contact_id
    from private.customer_member_of(v_merchant.id, p_user_id) c;
    select * into v_member from public.members m where m.id = v_member_id;
    select cc.contact_phone into v_contact_phone from public.member_customer_contacts cc where cc.id = v_contact_id;
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
    if v_member.id is null or coalesce(v_contact_phone, nullif(btrim(coalesce(v_member.phone, '')), '')) is null then
      return jsonb_build_object('state', 'contact_store');
    end if;
    if private.customer_open_booking_count(v_merchant.id, v_member.phone, v_member.id) >= 3 then
      return jsonb_build_object('state', 'too_many_open');
    end if;
    v_customer_phone := coalesce(v_contact_phone, btrim(v_member.phone));
  else
    perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_merchant.id::text || ':' || v_guest_phone_norm, 0));
    select count(*)::integer, min(m.id::text)::uuid into v_member_count, v_member_id
    from public.members m
    where m.merchant_id = v_merchant.id and m.status = 'active' and private.normalize_phone(m.phone) = v_guest_phone_norm;
    if v_member_count = 0 then
      v_member_id := private.member_id_by_contact_phone(v_merchant.id, v_guest_phone_norm);
      if v_member_id is not null then
        v_member_count := 1;
      end if;
    end if;
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
$function$;

-- import_members_batch:權限檢查之後加資料匯入功能開關(有 [req1025 begin/end] 標記,req987_02 指紋測試會先拿掉這段再比對)。
CREATE OR REPLACE FUNCTION public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_operation_id uuid;
  v_total_rows int;
  v_success_rows int := 0;
  v_failed_rows int := 0;
  v_skipped_rows int := 0;
  v_error_report jsonb := '[]'::jsonb;
  v_snapshot jsonb := '{}'::jsonb;
  v_row jsonb;
  v_idx int;
  v_row_number int;
  v_name text;
  v_phone text;
  v_email text;
  v_birthday date;
  v_notes text;
  v_referrer_value text;
  v_starting_points_text text;
  v_starting_points int;
  v_existing_member_id uuid;
  v_referrer_id uuid;
  v_member public.members;
  v_old_member public.members;
  v_action text;
  v_txn_id uuid;
  -- SPECS-INDEX #931 收尾(2026-10-01):略過重複電話那一列時,要把「跟誰撞」的姓名寫進 error_report。
  v_conflict_name text;
begin
  -- 規則 2.1(核心):只有商家管理員能發動批次匯入，不接受任何客服呼叫。
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '批次匯入/資料搬遷，只有商家管理員可以操作' using errcode = '42501';
  end if;
  -- [req1025 begin] FG1-F02:平台功能開關「資料匯入」關閉 ⇒ 擋下(權限檢查之後、做任何事之前)。
  if not private.merchant_has_feature(p_merchant_id, 'data_import') then
    raise exception '這個功能目前沒有開放。' using errcode = '42501', hint = 'feature_disabled';
  end if;
  -- [req1025 end]

  if p_write_mode not in ('insert_only', 'upsert_by_phone') then
    raise exception '無效的寫入模式：%', p_write_mode;
  end if;

  v_total_rows := jsonb_array_length(p_rows);

  -- 判斷 9:每批匯入上限 2,000 列。
  if v_total_rows > 2000 then
    raise exception '單批匯入最多 2,000 筆資料，這次上傳了 % 筆，請分批匯入', v_total_rows;
  end if;

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, write_mode, total_rows, created_by_user_id
  ) values (
    p_merchant_id, 'member_import', p_write_mode, v_total_rows, auth.uid()
  ) returning id into v_operation_id;

  for v_idx in 0 .. v_total_rows - 1 loop
    v_row := p_rows -> v_idx;
    v_action := null;
    begin
      v_row_number := coalesce((v_row->>'row_number')::int, v_idx + 1);
      v_name := nullif(btrim(coalesce(v_row->>'name', '')), '');
      v_phone := nullif(btrim(coalesce(v_row->>'phone', '')), '');
      v_email := nullif(btrim(coalesce(v_row->>'email', '')), '');
      v_birthday := nullif(v_row->>'birthday', '')::date;
      v_notes := nullif(btrim(coalesce(v_row->>'notes', '')), '');
      v_referrer_value := nullif(btrim(coalesce(v_row->>'referrer_value', '')), '');
      v_starting_points_text := nullif(btrim(coalesce(v_row->>'starting_points_balance', '')), '');
      v_starting_points := case when v_starting_points_text is null then null
                                 else v_starting_points_text::int end;

      -- 規則 2.6 邊界情況：起始點數為負數，這一列視為錯誤，不寫入。
      if v_starting_points is not null and v_starting_points < 0 then
        raise exception '起始點數餘額不可為負數';
      end if;

      -- SPECS-INDEX #824(2026-09-28):電話**有填**才檢查格式(#618 之後會員電話是選填,留空合法)。
      -- 規則本體沿用 #822 的 private.is_valid_taiwan_phone(手機或市話,市話可帶 # 分機,分隔符號不強制)。
      -- 放在「用電話找既有會員」之前:不合格的電話不拿去比對、也不當成「重複略過」,直接讓這一列失敗。
      -- raise 出去會被下面既有的 exception when others 接住 → 這一列算 failed、寫進 error_report,
      -- 其他列不受影響(匯入模組既有的逐列回報慣例)。
      if v_phone is not null and not private.is_valid_taiwan_phone(v_phone) then
        raise exception '「電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)', v_phone;
      end if;

      -- 找既有會員(依正規化後電話比對，只比對這個商家 status=active 的會員)。
      v_existing_member_id := null;
      if private.normalize_phone(v_phone) is not null then
        select id into v_existing_member_id
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and private.normalize_phone(phone) = private.normalize_phone(v_phone)
        limit 1;
      end if;

      -- 推薦人查找(規則 2.5.3)：電話或推薦碼，找不到就留空，不視為錯誤。
      v_referrer_id := null;
      if v_referrer_value is not null then
        select id into v_referrer_id
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and (
            referral_code = upper(v_referrer_value)
            or (private.normalize_phone(phone) is not null
                and private.normalize_phone(phone) = private.normalize_phone(v_referrer_value))
          )
        limit 1;
      end if;

      if v_existing_member_id is not null and p_write_mode = 'insert_only' then
        -- 規則 2.5.1：insert_only 模式下電話重複，直接略過，不修改既有資料。
        v_skipped_rows := v_skipped_rows + 1;

        -- SPECS-INDEX #931 收尾(2026-10-01,品管實測打回):**略過也要留話**。
        -- 之前這個分支只把 v_skipped_rows 加一就結束 ⇒ 那一列既不算成功也不算失敗,error_report
        -- 裡一個字都沒有,商家在結果頁只看到「略過(重複) 1」,永遠不知道是哪一列、跟誰撞、
        -- 那個人叫什麼名字。使用者對 #931 的原話是「要擋下來並指名是誰…不能只說失敗」,
        -- 而這條路徑連「失敗」都沒說。而 insert_only 是匯入精靈的**預設**模式,所以這是常態路徑。
        --
        -- 🔴 為什麼不改成算 failed:success / failed / skipped_duplicate_rows 三個計數的語意是既有的
        --    (結果頁那三格數字、匯入紀錄頁、以及既有的 pgTAP 斷言都吃它們),把略過改成失敗會連帶
        --    改掉畫面與既有測試的期望值。使用者要的是「看得見訊息」,不是「改變計數」⇒ 維持 skipped,
        --    只是**額外**在 error_report 留一筆指名訊息。
        -- 📌 error_report 是 jsonb 陣列、每一筆是 {row_number, raw_data, error_message},前端固定渲染
        --    成「第 N 列:<error_message>」⇒ 沿用同一個結構就自動顯示得出來,不需要動前端一個字。
        --    訊息本身明寫「已略過、沒有新建也沒有修改既有資料」,所以就算它出現在結果頁那塊標題
        --    寫「失敗清單」的區塊裡,商家讀完也不會誤會這一列被寫壞了。
        -- 📌 為什麼不能靠 create_member 內建的 #931 檢查:這個分支在呼叫 create_member **之前**就先
        --    短路了,create_member 那句「這支電話已經有會員:某某某」從匯入這條路徑走不到。
        select m.name into v_conflict_name from public.members m where m.id = v_existing_member_id;
        v_error_report := v_error_report || jsonb_build_array(jsonb_build_object(
          'row_number', v_row_number,
          'raw_data', v_row,
          'error_message', format(
            '這支電話已經有會員：%s —— 這一列已略過，沒有新建，也沒有修改這位既有會員的任何資料。同一間商家底下，一支電話只能有一位會員：如果就是同一位客戶，請把這一列從 CSV 裡移除；如果你本來就是想更新這位既有會員的資料，請改用「電話重複時更新既有會員資料」這個寫入模式重新匯入；如果真的是不同的人，請改填另一支電話',
            v_conflict_name)
        ));
      elsif v_existing_member_id is not null and p_write_mode = 'upsert_by_phone' then
        -- 規則 2.5.2：upsert_by_phone 模式下電話重複，更新既有會員。
        -- 規則 2.7：先記錄復原所需的原始值——只在這個會員這個批次「第一次」被更新時記錄，
        -- 避免同一支電話在 CSV 裡重複出現時，第二次覆蓋掉真正的原始值(邊界情況，規則 2.5)。
        select * into v_old_member from public.members where id = v_existing_member_id;

        -- 注意:v_snapshot 一開始是 '{}'::jsonb，這時候 v_snapshot -> 'members' 會是 SQL NULL，
        -- 直接對 NULL 用 ? 運算子的結果也是 NULL，`if not (NULL)` 在 plpgsql 裡會被當成「不是
        -- true」而整段跳過(不是拋錯，是靜默跳過)——所以一定要先確保 'members' 這個 key 存在，
        -- 是一個貨真價實的 jsonb 物件，才能接著用 ? 判斷「這個會員是不是第一次被記錄」。
        if not (v_snapshot ? 'members') then
          v_snapshot := v_snapshot || jsonb_build_object('members', '{}'::jsonb);
        end if;

        if not (v_snapshot -> 'members' ? v_existing_member_id::text) then
          v_snapshot := jsonb_set(
            v_snapshot,
            array['members', v_existing_member_id::text],
            jsonb_build_object(
              'name', v_old_member.name,
              'phone', v_old_member.phone,
              'email', v_old_member.email,
              'birthday', v_old_member.birthday,
              'notes', v_old_member.notes
            )
          );
        end if;

        -- 2026-09-24 修正(B3):update_member 自從 #615 之後是 7 個參數,第 7 個 p_tier_id
        -- 雖然有 default null,但函式內部是無條件 `tier_id = p_tier_id`,少傳就等於把這位
        -- 既有會員的會員等級清成未分級。CSV 匯入格式本來就沒有「會員等級」這個欄位,
        -- 沿用 v_old_member.tier_id(更新前的現況)才是正確行為。
        v_member := public.update_member(v_existing_member_id, coalesce(v_name, v_old_member.name), v_phone, v_email, v_birthday, v_notes, v_old_member.tier_id);
        insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
          values (v_operation_id, 'members', v_member.id, 'updated');
        v_action := 'updated';
        v_success_rows := v_success_rows + 1;
      else
        -- 查無既有會員：建立新會員，完全複用 create_member(規則 2.2，電話必填政策/推薦人驗證
        -- 沿用既有邏輯，不重新實作)。
        v_member := public.create_member(p_merchant_id, v_name, v_phone, v_email, v_birthday, v_notes, v_referrer_id);
        insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
          values (v_operation_id, 'members', v_member.id, 'created');
        v_action := 'created';
        v_success_rows := v_success_rows + 1;
      end if;

      -- 規則 2.6：起始點數餘額，透過既有的 adjust_member_points 寫入。
      if v_action in ('created', 'updated') and v_starting_points is not null and v_starting_points > 0 then
        perform public.adjust_member_points(v_member.id, v_starting_points, '資料匯入：起始點數餘額');
        -- adjust_member_points 沒有回傳分類帳紀錄本身，這裡另外查一次剛寫入的那一筆，把「真正的
        -- member_point_transactions.id」記錄進明細表(不是 member_id)，讓 rollback_bulk_operation
        -- (3.5)之後能精準判斷「這筆點數異動是不是這個批次自己產生的」。
        select id into v_txn_id
        from public.member_point_transactions
        where member_id = v_member.id
          and transaction_type = 'manual_adjustment'
          and note = '資料匯入：起始點數餘額'
        order by created_at desc, id desc
        limit 1;
        insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
          values (v_operation_id, 'member_point_transactions', v_txn_id, v_action);
      end if;

      v_action := null;
    exception when others then
      v_failed_rows := v_failed_rows + 1;
      v_error_report := v_error_report || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'raw_data', v_row,
        'error_message', sqlerrm
      ));
    end;
  end loop;

  update public.merchant_bulk_operations
  set success_rows = v_success_rows,
      failed_rows = v_failed_rows,
      skipped_duplicate_rows = v_skipped_rows,
      error_report = v_error_report,
      pre_operation_snapshot = v_snapshot
  where id = v_operation_id;

  return v_operation_id;
end;
$function$;

-- import_historical_bookings_batch:同上。
CREATE OR REPLACE FUNCTION public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_operation_id uuid;
  v_total_rows int;
  v_success_rows int := 0;
  v_failed_rows int := 0;
  v_error_report jsonb := '[]'::jsonb;
  v_row jsonb;
  v_idx int;
  v_row_number int;
  v_customer_name text;
  v_customer_phone text;
  v_customer_email text;
  v_customer_address text;
  v_customer_notes text;
  v_staff_id uuid;
  v_start_at timestamptz;
  v_duration_minutes int;
  v_end_at timestamptz;
  v_status_raw text;
  v_status text;
  v_service_description text;
  v_final_amount numeric(10, 2);
  v_subtotal_amount numeric(10, 2);
  v_discount_amount numeric(10, 2);
  v_tax_amount numeric(10, 2);
  v_payment_method text;
  v_member_phone text;
  v_member_id uuid;
  v_member_name text;
  v_booking_id uuid;
begin
  -- 規則 2.1(核心):只有商家管理員能發動批次匯入。
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '批次匯入/資料搬遷，只有商家管理員可以操作' using errcode = '42501';
  end if;
  -- [req1025 begin] FG1-F02:平台功能開關「資料匯入」關閉 ⇒ 擋下(權限檢查之後、做任何事之前)。
  if not private.merchant_has_feature(p_merchant_id, 'data_import') then
    raise exception '這個功能目前沒有開放。' using errcode = '42501', hint = 'feature_disabled';
  end if;
  -- [req1025 end]

  v_total_rows := jsonb_array_length(p_rows);

  if v_total_rows > 2000 then
    raise exception '單批匯入最多 2,000 筆資料，這次上傳了 % 筆，請分批匯入', v_total_rows;
  end if;

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, total_rows, created_by_user_id
  ) values (
    p_merchant_id, 'historical_booking_import', v_total_rows, auth.uid()
  ) returning id into v_operation_id;

  for v_idx in 0 .. v_total_rows - 1 loop
    v_row := p_rows -> v_idx;
    begin
      v_row_number := coalesce((v_row->>'row_number')::int, v_idx + 1);
      v_customer_name := nullif(btrim(coalesce(v_row->>'customer_name', '')), '');
      v_customer_phone := nullif(btrim(coalesce(v_row->>'customer_phone', '')), '');
      v_customer_email := nullif(btrim(coalesce(v_row->>'customer_email', '')), '');
      v_customer_address := nullif(btrim(coalesce(v_row->>'customer_address', '')), '');
      v_customer_notes := nullif(btrim(coalesce(v_row->>'customer_notes', '')), '');
      v_staff_id := nullif(v_row->>'staff_id', '')::uuid;
      v_start_at := nullif(v_row->>'start_at', '')::timestamptz;
      v_duration_minutes := nullif(v_row->>'duration_minutes', '')::int;
      v_service_description := nullif(btrim(coalesce(v_row->>'service_description', '')), '');
      v_payment_method := nullif(btrim(coalesce(v_row->>'payment_method', '')), '');
      v_member_phone := nullif(btrim(coalesce(v_row->>'member_phone', '')), '');

      -- 必填欄位驗證。
      if v_customer_name is null then
        raise exception '缺少必填欄位：客戶姓名';
      end if;
      if v_customer_phone is null then
        raise exception '缺少必填欄位：客戶電話';
      end if;
      -- SPECS-INDEX #824(2026-09-28):客戶電話格式檢查,規則本體沿用 #822 的 private.is_valid_taiwan_phone
      -- (跟 create_booking / update_booking 同一條規則,手機或市話、市話可帶 # 分機、分隔符號不強制)。
      -- raise 出去會被下面既有的 exception when others 接住 → 這一列算 failed、寫進 error_report,
      -- 其他列不受影響(匯入模組既有的逐列回報慣例,不整批失敗)。
      if not private.is_valid_taiwan_phone(v_customer_phone) then
        raise exception '「客戶電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)', v_customer_phone;
      end if;
      if v_staff_id is null then
        raise exception '缺少必填欄位：服務人員';
      end if;
      if v_start_at is null then
        raise exception '缺少必填欄位：預約時間，或時間格式無法辨識';
      end if;
      if nullif(v_row->>'final_amount', '') is null then
        raise exception '缺少必填欄位：訂單金額';
      end if;
      v_final_amount := (v_row->>'final_amount')::numeric(10, 2);
      if v_final_amount < 0 then
        raise exception '訂單金額不可為負數';
      end if;

      -- staff_id 必須是這個商家底下存在的服務人員(3.3 數值對應步驟保證，這裡再次防呆)。
      if not exists (
        select 1 from public.merchant_staff where id = v_staff_id and merchant_id = p_merchant_id
      ) then
        raise exception '指定的服務人員不存在於這個商家';
      end if;

      -- end_at：有工時欄位就用，沒有預設 60 分鐘(規則 2.3/3.4)。
      v_end_at := v_start_at + make_interval(mins => coalesce(v_duration_minutes, 60));

      -- status 正規化(規則 3.4)。
      v_status_raw := lower(btrim(coalesce(v_row->>'status', '')));
      v_status := case
        when v_status_raw in ('completed', '已完成', 'complete') then 'completed'
        when v_status_raw in ('cancelled', '已取消', 'canceled') then 'cancelled'
        else 'completed'
      end;

      -- 選填進階金額欄位：final_amount 是唯一權威金額，subtotal/discount/tax 只是分項顯示。
      --
      -- 2026-09-24(任務 4,使用者裁決:「…如果是舊訂單匯入,在稅金欄位沒有填寫金額就當作總營收
      -- (未稅)去計算。」):折扣/稅金要先解析出來,因為下面反推未稅小計時會用到它們。
      -- 這兩行的內容本身完全沒變,只是從 subtotal 那一行的下面搬到上面。
      v_discount_amount := coalesce(nullif(v_row->>'discount_amount', '')::numeric(10, 2), 0);
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric(10, 2), 0);

      -- 未稅小計(subtotal_amount_snapshot)。這個欄位直接決定帳務報表的
      -- total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
      -- 所以它「含不含稅」這件事必須完全正確。
      v_subtotal_amount := nullif(v_row->>'subtotal_amount', '')::numeric(10, 2);

      if v_subtotal_amount is null then
        if v_tax_amount > 0 then
          -- 稅金有填、小計沒填:依 .project/specs/訂單管理.md §2.3 的四則順序
          -- (final = subtotal − discount + tax)對 subtotal 移項反推:
          --   subtotal = final_amount + discount − tax
          -- 例:CSV 只有「金額 1050 / 稅金 50」(沒有折扣)→ 小計 = 1050 + 0 − 50 = 1000,
          -- 未稅營收算出 1000 而不是 1050,那 50 元稅金不再被算進營收裡。
          v_subtotal_amount := v_final_amount + v_discount_amount - v_tax_amount;

          -- 防呆:反推出負數代表 CSV 這一列本身矛盾(稅金比訂單總金額還大)。不靜默寫入負數
          -- 小計(那會讓報表營收莫名變少還很難查),拋白話錯誤訊息讓這一列進 error_report,
          -- 商家自己去修那一列就好,不影響同一批其他正常的列(這個迴圈是逐列 exception 處理)。
          if v_subtotal_amount < 0 then
            raise exception '稅金金額(%)大於訂單金額(%)，無法推算未稅小計，請確認這一列的金額與稅金欄位',
              v_tax_amount, v_final_amount;
          end if;
        else
          -- 稅金沒填或是 0:完全照使用者裁決原文——總金額直接當未稅營收,不做任何反推。
          v_subtotal_amount := v_final_amount;
        end if;
      end if;

      -- 會員連結(選填，規則 3.4：只比對既有 active 會員，不建立新會員)。
      v_member_id := null;
      v_member_name := null;
      if v_member_phone is not null and private.normalize_phone(v_member_phone) is not null then
        select id, name into v_member_id, v_member_name
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and private.normalize_phone(phone) = private.normalize_phone(v_member_phone)
        limit 1;
      end if;

      -- 注意:bookings.payment_method(text)這個舊欄位在模組 9 v2 已經被拿掉，改成
      -- payment_method_id(外鍵，指向 payment_methods)+ payment_method_name_snapshot(文字快照)。
      -- 歷史匯入的付款方式文字不保證能對應到這個商家「現在」的付款方式清單，比照第一節 1.3
      -- service_description_snapshot 的精神，直接存成文字快照，不嘗試比對/建立 payment_methods
      -- 資料列，payment_method_id 一律留 null。
      insert into public.bookings (
        merchant_id, staff_id, customer_name, customer_phone, customer_email, customer_address,
        customer_notes, start_at, end_at, status, source, created_by_role, created_by_user_id,
        service_description_snapshot, subtotal_amount_snapshot, discount_amount_snapshot,
        tax_amount_snapshot, final_amount_snapshot, payment_method_name_snapshot, member_id,
        member_name_snapshot,
        -- 2026-09-24(任務 1 的根因修正):原本這個 INSERT 完全沒有 completed_at,所以每一筆
        -- 匯入的已完成訂單 completed_at 都是 null(正式環境那 14 筆就是這樣來的)。任務 1 之後
        -- 帳務報表改用「完成時間」分月,不補這一欄就等於每次匯入都繼續製造報表撈不到的資料。
        completed_at
      ) values (
        p_merchant_id, v_staff_id, v_customer_name, v_customer_phone, v_customer_email,
        v_customer_address, v_customer_notes, v_start_at, v_end_at, v_status, 'import', 'admin',
        auth.uid(), v_service_description, v_subtotal_amount, v_discount_amount, v_tax_amount,
        v_final_amount, v_payment_method, v_member_id, v_member_name,
        -- 用 v_start_at 而不是 now():歷史訂單的「完成」發生在服務當天,不是按下匯入按鈕那天。
        -- 用 now() 會把 2024 年的營收整批算進匯入當月。status='cancelled' 維持 null(沒完成過)。
        case when v_status = 'completed' then v_start_at else null end
      ) returning id into v_booking_id;

      insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
        values (v_operation_id, 'bookings', v_booking_id, 'created');

      v_success_rows := v_success_rows + 1;
    exception when others then
      v_failed_rows := v_failed_rows + 1;
      v_error_report := v_error_report || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'raw_data', v_row,
        'error_message', sqlerrm
      ));
    end;
  end loop;

  update public.merchant_bulk_operations
  set success_rows = v_success_rows,
      failed_rows = v_failed_rows,
      error_report = v_error_report
  where id = v_operation_id;

  return v_operation_id;
end;
$function$;
