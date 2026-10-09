-- SPECS-INDEX #1049 / #1050(2026-10-10):行事曆格子顯示一致化 + 排程狀態顏色透明度 —— 函式。
-- 規格書:.project/specs/行事曆格子顯示與顏色透明度.md(R6、R9)。
--
-- 動工前正式庫唯讀核對(指紋 = md5(replace(prosrc, CRLF, LF))),跟本機 migration 本體一致,以此為底:
--   2cefa81d423d9a30b70e2f3f1b220512  public.update_merchant_calendar_state_styles(uuid,text,text,text,text)
--   74f11de233387e684a4e2576775fb677  public.seed_default_merchant_calendar_state_styles(uuid)
--   4d09446053dab642e4821ed632c0d75e  public.get_my_calendar_state_styles(uuid)
--
-- 這支 migration:
--   1. seed_default_merchant_calendar_state_styles:多種第 5 列(冪等、不覆蓋自訂;opacity 走欄位預設 100)。
--   2. update_merchant_calendar_state_styles:簽章加 6 個「有預設值 null = 不改」的參數
--      (營業時間外顏色 + 5 個透明度)。選「加具名參數」而不是改成單一 jsonb:舊版前端只傳 5 個參數照樣能呼叫
--      (上線順序不用卡),每個參數的格式檢查也比較直白。改簽章 ⇒ drop + create;security definer、
--      search_path、權限判斷(can_manage_bookings,42501)、revoke public/anon + grant authenticated 全部照舊。
--   3. get_my_calendar_state_styles:多回一個 "opacity" 物件({state_type: 透明度})。原本的 {state_type: 色碼}
--      一個 key 都沒動(舊版前端照樣讀得到顏色);權限判斷 is_own_staff_row 一字不改。
--   4. 新增 get_my_staff_availability_windows(R6):服務人員自己唯讀「自己的每週可預約時段」。
--      原因:staff_availability_windows 的 SELECT 政策 = can_manage_business_hours OR can_self_manage_availability
--      (= 有「自己排休」權限 + 按件計酬)。月薪制、或沒開「自己排休」的服務人員讀到 0 筆 ⇒ 行事曆看不出自己的時段。
--      依規格書不放寬那條 RLS,改用 security definer 唯讀函式,比照 get_my_day_business_hours:
--        ・is_own_staff_row(只能查自己,傳別人的 staff_id ⇒ 42501)
--        ・平台功能開關「服務人員登入端」(staff_portal)大項關 ⇒ 42501「這個功能目前沒有開放。」
--        ・只回 day_of_week / start_time / end_time,不回 id、時間戳或其他欄位。
--
-- ⚠️ 本檔沒有任何資料寫入,沒有新增 / 修改 / 刪除任何 RLS 政策。

-- =========================================================================
-- 1. seed:新商家自動種 5 列
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
    (p_merchant_id, 'cross_store_occupied', '#c2410c'),
    (p_merchant_id, 'staff_available_slot', '#dcfce7'),
    (p_merchant_id, 'outside_business_hours', '#334155')
  on conflict (merchant_id, state_type) do nothing;
end;
$$;

comment on function public.seed_default_merchant_calendar_state_styles(uuid) is 'SPECS-INDEX #644 / #1021 / #1049:新商家建立時種入 5 種行事曆排程狀態的預設顏色(第 5 種 outside_business_hours = #334155 深灰藍),透明度一律走欄位預設 100。冪等,重複呼叫不會產生第二批,也不會覆蓋商家已經自訂過的顏色或透明度。';

revoke execute on function public.seed_default_merchant_calendar_state_styles(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_merchant_calendar_state_styles(uuid) to service_role, postgres;

-- =========================================================================
-- 2. update_merchant_calendar_state_styles:加 6 個有預設值的參數
-- =========================================================================
drop function public.update_merchant_calendar_state_styles(uuid, text, text, text, text);

create function public.update_merchant_calendar_state_styles(
  p_merchant_id uuid,
  p_full_day_leave_color text,
  p_partial_leave_color text,
  p_cross_store_occupied_color text,
  p_staff_available_slot_color text default null,
  p_outside_business_hours_color text default null,
  p_full_day_leave_opacity integer default null,
  p_partial_leave_opacity integer default null,
  p_cross_store_occupied_opacity integer default null,
  p_staff_available_slot_opacity integer default null,
  p_outside_business_hours_opacity integer default null
)
returns setof public.merchant_calendar_state_styles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_available_slot_color text := btrim(p_staff_available_slot_color);
  v_outside_business_hours_color text := btrim(p_outside_business_hours_color);
  v_opacity record;
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
  -- #1021:這一色只收 #RGB / #RRGGBB(前端套 inline style 前還會再檢查一次)。null = 不改。
  if v_staff_available_slot_color is not null
     and v_staff_available_slot_color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' then
    raise exception '「服務人員可預約時段」的色碼格式不正確，請輸入像 #DCFCE7 這樣的色碼';
  end if;
  -- #1049:營業時間外,同上規則。null = 不改。
  if v_outside_business_hours_color is not null
     and v_outside_business_hours_color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' then
    raise exception '「營業時間外」的色碼格式不正確，請輸入像 #334155 這樣的色碼';
  end if;
  -- #1050:透明度 10~100(%)。null = 不改。
  for v_opacity in
    select * from (values
      ('全天休假', p_full_day_leave_opacity),
      ('時段排休', p_partial_leave_opacity),
      ('跨店佔用', p_cross_store_occupied_opacity),
      ('服務人員可預約時段', p_staff_available_slot_opacity),
      ('營業時間外', p_outside_business_hours_opacity)
    ) as t(label, val)
  loop
    if v_opacity.val is not null and (v_opacity.val < 10 or v_opacity.val > 100) then
      raise exception '「%」的透明度要在 10%% 到 100%% 之間', v_opacity.label;
    end if;
  end loop;

  insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
  values
    (p_merchant_id, 'full_day_leave', btrim(p_full_day_leave_color)),
    (p_merchant_id, 'partial_leave', btrim(p_partial_leave_color)),
    (p_merchant_id, 'cross_store_occupied', btrim(p_cross_store_occupied_color))
  on conflict (merchant_id, state_type) do update set
    color = excluded.color,
    updated_at = now();

  if v_staff_available_slot_color is not null then
    insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
    values (p_merchant_id, 'staff_available_slot', v_staff_available_slot_color)
    on conflict (merchant_id, state_type) do update set
      color = excluded.color,
      updated_at = now();
  end if;

  if v_outside_business_hours_color is not null then
    insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
    values (p_merchant_id, 'outside_business_hours', v_outside_business_hours_color)
    on conflict (merchant_id, state_type) do update set
      color = excluded.color,
      updated_at = now();
  end if;

  -- 透明度:只更新有給值的狀態(列一定已經存在:前三色上面剛 upsert;後兩種 seed / 補列都有)。
  update public.merchant_calendar_state_styles s
  set opacity = v.val::smallint,
      updated_at = now()
  from (values
    ('full_day_leave', p_full_day_leave_opacity),
    ('partial_leave', p_partial_leave_opacity),
    ('cross_store_occupied', p_cross_store_occupied_opacity),
    ('staff_available_slot', p_staff_available_slot_opacity),
    ('outside_business_hours', p_outside_business_hours_opacity)
  ) as v(state_type, val)
  where s.merchant_id = p_merchant_id
    and s.state_type = v.state_type
    and v.val is not null
    and s.opacity is distinct from v.val::smallint;

  return query
    select * from public.merchant_calendar_state_styles
    where merchant_id = p_merchant_id
    order by state_type;
end;
$$;

comment on function public.update_merchant_calendar_state_styles(uuid, text, text, text, text, text, integer, integer, integer, integer, integer) is 'SPECS-INDEX #644 / #1021 / #1049 / #1050:upsert 商家的 merchant_calendar_state_styles(全天休假/時段排休/跨店佔用/服務人員可預約時段/營業時間外)與各自的透明度。權限:private.can_manage_bookings(商家管理員或被授權 orders 的客服),否則 42501。前三色只擋空字串/null(#644 原規則);第 4、5 色預設 null = 不改,有給就只收 #RGB / #RRGGBB;5 個透明度預設 null = 不改,有給要在 10~100。';

revoke execute on function public.update_merchant_calendar_state_styles(uuid, text, text, text, text, text, integer, integer, integer, integer, integer) from public, anon;
grant execute on function public.update_merchant_calendar_state_styles(uuid, text, text, text, text, text, integer, integer, integer, integer, integer) to authenticated;

-- =========================================================================
-- 3. get_my_calendar_state_styles:多回 "opacity"
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_my_calendar_state_styles(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result jsonb;
  v_opacity jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的行事曆顏色設定' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  select coalesce(jsonb_object_agg(state_type, color), '{}'::jsonb),
         coalesce(jsonb_object_agg(state_type, opacity), '{}'::jsonb)
  into v_result, v_opacity
  from public.merchant_calendar_state_styles
  where merchant_id = v_merchant_id;

  -- #1050:{state_type: 色碼} 照舊,另外多一個 "opacity": {state_type: 透明度}。
  return v_result || jsonb_build_object('opacity', v_opacity);
end;
$function$;

revoke execute on function public.get_my_calendar_state_styles(p_staff_id uuid) from PUBLIC, anon;
grant execute on function public.get_my_calendar_state_styles(p_staff_id uuid) to authenticated, service_role;

-- =========================================================================
-- 4. 新增 get_my_staff_availability_windows(R6)
-- =========================================================================
create or replace function public.get_my_staff_availability_windows(p_staff_id uuid)
returns table (day_of_week smallint, start_time time, end_time time)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的可預約時段' using errcode = '42501';
  end if;

  if not private.merchant_has_feature(private.staff_merchant_id(p_staff_id), 'staff_portal') then
    raise exception '這個功能目前沒有開放。' using errcode = '42501';
  end if;

  return query
    select w.day_of_week, w.start_time, w.end_time
    from public.staff_availability_windows w
    where w.staff_id = p_staff_id
    order by w.day_of_week, w.start_time;
end;
$function$;

comment on function public.get_my_staff_availability_windows(uuid) is 'SPECS-INDEX #1049(R6):服務人員自己唯讀「自己的每週可預約時段」(行事曆時間軸畫底色用)。staff_availability_windows 的 SELECT 政策只放行可管理營業時間的人、或有「自己排休」權限的按件計酬服務人員;依規格書不放寬該 RLS,改用本函式。只檢查 private.is_own_staff_row(傳別人的 staff_id ⇒ 42501)+ 平台功能開關 staff_portal 大項(關 ⇒ 42501);只回 day_of_week / start_time / end_time。';

revoke execute on function public.get_my_staff_availability_windows(uuid) from public, anon;
grant execute on function public.get_my_staff_availability_windows(uuid) to authenticated, service_role;
