-- 模組 11:LINE 通知 — 3.9 render_booking_notification_variables、3.10 preview_line_notification_targets
-- + 共用的 resolve_line_notification_targets(3.10 邊界情況要求:跟 line-notify-dispatch 判斷「要不要
-- 發」的邏輯完全一致,這裡把共用邏輯抽成一支函式,3.10 跟 Edge Function 都呼叫它,不各自重寫一次)。
--
-- ⚠️ 實作補充(不是偏離,是讓 3.10 的建議真的能落地執行的必要延伸):
--   1. render_booking_notification_variables/resolve_line_notification_targets 原文標示為
--      private.*,但跟 3.8 同樣的理由(PostgREST 只暴露 public/graphql_public schema,
--      private.* 不管有沒有 grant 給 service_role,Edge Function 用 supabase-js .rpc() 都打不到),
--      這裡也改放在 public schema,靠 revoke/grant 限制執行權限,比照 record_invited_merchant_agent
--      既有慣例。
--   2. resolve_line_notification_targets 回傳的「skipped」清單會列出「配置了要通知,但實際解析
--      不到已綁定對象」的每一筆(target_not_bound/no_target),供 line-notify-dispatch 逐筆寫入
--      規則 2.4 第 3 點要求的個別跳過紀錄;3.10 preview_line_notification_targets 只需要
--      「有沒有任何一個會真的收到」的摘要,所以只回傳 targets 精簡欄位(type/name),不外露
--      skipped 細節給前端彈窗用(2.5 的彈窗只需要列出「將會通知誰」)。

-- =========================================================================
-- 共用解析邏輯:回傳這個商家這個事件目前「真的會發送」的對象清單 + 「配置了但解析不到已綁定
-- 對象」的跳過清單。staff/member 分支只在有 p_booking_id 時才有意義(staff_leave_created
-- 沒有 booking,對應 1.2 邊界情況這兩個開關對這個事件本來就隱藏/不適用)。
-- =========================================================================
create or replace function public.resolve_line_notification_targets(
  p_merchant_id uuid,
  p_event_type text,
  p_booking_id uuid default null,
  p_staff_leave_record_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_is_connected boolean;
  v_settings public.merchant_line_event_settings;
  v_booking public.bookings;
  v_targets jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_member_bound boolean;
  v_member_name text;
begin
  select is_connected into v_is_connected
  from public.merchant_line_configs where merchant_id = p_merchant_id;

  if coalesce(v_is_connected, false) = false then
    return jsonb_build_object(
      'connected', false, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb
    );
  end if;

  select * into v_settings
  from public.merchant_line_event_settings
  where merchant_id = p_merchant_id and event_type = p_event_type;

  if v_settings.id is null or not v_settings.enabled then
    return jsonb_build_object(
      'connected', true, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb
    );
  end if;

  if p_booking_id is not null then
    select * into v_booking from public.bookings where id = p_booking_id;
  end if;

  -- 服務人員(booking 事件才有意義)
  if v_settings.notify_staff and v_booking.id is not null then
    if exists (select 1 from public.merchant_staff where id = v_booking.staff_id and line_bound = true) then
      v_targets := v_targets || jsonb_build_array(jsonb_build_object(
        'type', 'staff', 'id', v_booking.staff_id,
        'name', (select name from public.merchant_staff where id = v_booking.staff_id),
        'line_user_id', (select line_user_id from public.merchant_staff where id = v_booking.staff_id)
      ));
    else
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'target_not_bound')
      );
    end if;
  end if;

  -- 會員(booking 事件才有意義)
  if v_settings.notify_member and v_booking.id is not null then
    if v_booking.member_id is null then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'member', 'id', null, 'reason', 'no_target')
      );
    else
      select name, line_bound into v_member_name, v_member_bound
      from public.members where id = v_booking.member_id;

      if coalesce(v_member_bound, false) then
        v_targets := v_targets || jsonb_build_array(jsonb_build_object(
          'type', 'member', 'id', v_booking.member_id, 'name', v_member_name,
          'line_user_id', (select line_user_id from public.members where id = v_booking.member_id)
        ));
      else
        v_skipped := v_skipped || jsonb_build_array(
          jsonb_build_object('type', 'member', 'id', v_booking.member_id, 'reason', 'target_not_bound')
        );
      end if;
    end if;
  end if;

  -- 商家管理員(每一位分別判斷,已綁定的各自進 targets,未綁定的各自進 skipped)
  if v_settings.notify_admin then
    v_targets := v_targets || coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', 'admin', 'id', id, 'name', coalesce(display_name, '商家管理員'), 'line_user_id', line_user_id
      ))
      from public.merchant_admins where merchant_id = p_merchant_id and line_bound = true
    ), '[]'::jsonb);
    v_skipped := v_skipped || coalesce((
      select jsonb_agg(jsonb_build_object('type', 'admin', 'id', id, 'reason', 'target_not_bound'))
      from public.merchant_admins where merchant_id = p_merchant_id and line_bound = false
    ), '[]'::jsonb);
  end if;

  -- 客服(僅在職)
  if v_settings.notify_agent then
    v_targets := v_targets || coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', 'agent', 'id', id, 'name', name, 'line_user_id', line_user_id
      ))
      from public.merchant_agents
      where merchant_id = p_merchant_id and status = 'active' and line_bound = true
    ), '[]'::jsonb);
    v_skipped := v_skipped || coalesce((
      select jsonb_agg(jsonb_build_object('type', 'agent', 'id', id, 'reason', 'target_not_bound'))
      from public.merchant_agents
      where merchant_id = p_merchant_id and status = 'active' and line_bound = false
    ), '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'connected', true,
    'event_enabled', true,
    'targets', v_targets,
    'skipped', v_skipped
  );
end;
$$;

comment on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) is '3.10 邊界情況:preview_line_notification_targets(前端預覽)跟 line-notify-dispatch(實際發送判斷)共用的唯一一份判斷邏輯,避免兩邊分岔造成「彈窗說會通知,結果沒有通知」。只給 authenticated(透過 3.10 的權限包裝)/service_role(Edge Function 直接呼叫)使用。';

revoke execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) from public, anon;
grant execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) to service_role;

-- =========================================================================
-- 3.10 preview_line_notification_targets(前端 2.5 彈窗使用,信任呼叫者身份,自行檢查權限)
-- =========================================================================
create or replace function public.preview_line_notification_targets(p_booking_id uuid, p_event_type text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result jsonb;
  v_simplified jsonb;
begin
  select merchant_id into v_merchant_id from public.bookings where id = p_booking_id;

  if v_merchant_id is null then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限查詢這筆預約的通知對象' using errcode = '42501';
  end if;

  v_result := public.resolve_line_notification_targets(v_merchant_id, p_event_type, p_booking_id, null);

  select coalesce(jsonb_agg(jsonb_build_object('type', t->>'type', 'name', t->>'name')), '[]'::jsonb)
  into v_simplified
  from jsonb_array_elements(v_result->'targets') as t;

  return jsonb_build_object(
    'has_any_target', jsonb_array_length(coalesce(v_result->'targets', '[]'::jsonb)) > 0,
    'targets', v_simplified
  );
end;
$$;

comment on function public.preview_line_notification_targets(uuid, text) is '規則 2.5/3.10:確認訂單前預覽會通知誰,純讀取。回傳格式 {has_any_target, targets:[{type,name}]}。';

revoke execute on function public.preview_line_notification_targets(uuid, text) from public, anon;
grant execute on function public.preview_line_notification_targets(uuid, text) to authenticated;

-- =========================================================================
-- 3.9 render_booking_notification_variables(只給 line-notify-dispatch 使用)
-- =========================================================================
create or replace function public.render_booking_notification_variables(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_merchant_name text;
  v_service_names text;
  v_staff_name text;
  v_points_earned int;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception '找不到這筆預約';
  end if;

  select name into v_merchant_name from public.merchants where id = v_booking.merchant_id;

  select string_agg(si.name, '、' order by bsi.created_at)
  into v_service_names
  from public.booking_service_items bsi
  join public.service_items si on si.id = bsi.service_item_id
  where bsi.booking_id = p_booking_id;

  select name into v_staff_name from public.merchant_staff where id = v_booking.staff_id;

  select points_delta into v_points_earned
  from public.member_point_transactions
  where booking_id = p_booking_id and transaction_type = 'earn_booking'
  order by created_at desc
  limit 1;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'customer_name', coalesce(v_booking.customer_name, ''),
    'booking_date', to_char(v_booking.start_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI'),
    'service_names', coalesce(v_service_names, ''),
    'final_amount', coalesce(trim(to_char(v_booking.final_amount_snapshot, 'FM999999990')), ''),
    'staff_name', coalesce(v_staff_name, ''),
    'member_name', coalesce(v_booking.member_name_snapshot, ''),
    'cancel_reason', coalesce(v_booking.cancelled_reason, ''),
    'points_earned', coalesce(v_points_earned::text, '')
  );
end;
$$;

comment on function public.render_booking_notification_variables(uuid) is '判斷 10/3.9:組裝訂單通知文案要用的變數。缺的欄位一律回傳空字串,不報錯(對應規則 2.4 的安靜精神延伸到變數組裝)。只給 line-notify-dispatch 用 service role 呼叫。';

revoke execute on function public.render_booking_notification_variables(uuid) from public, anon, authenticated;
grant execute on function public.render_booking_notification_variables(uuid) to service_role;

-- =========================================================================
-- 3.14 步驟 1 用的授權檢查小工具:依事件類型決定要檢查 can_manage_bookings 還是
-- can_manage_team_leave。放在 public schema,讓 line-notify-dispatch 用呼叫者 JWT 呼叫。
-- =========================================================================
create or replace function public.can_dispatch_line_notification(p_merchant_id uuid, p_event_type text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_event_type = 'staff_leave_created' then private.can_manage_team_leave(p_merchant_id)
    else private.can_manage_bookings(p_merchant_id)
  end;
$$;

comment on function public.can_dispatch_line_notification(uuid, text) is '3.14 步驟 1:防止任何已登入使用者對不相關的商家/訂單濫發通知呼叫。staff_leave_created 檢查 can_manage_team_leave,其餘事件檢查 can_manage_bookings。';

revoke execute on function public.can_dispatch_line_notification(uuid, text) from public, anon;
grant execute on function public.can_dispatch_line_notification(uuid, text) to authenticated;

-- =========================================================================
-- 3.18 get_line_notification_log(唯讀,分頁)
-- =========================================================================
create or replace function public.get_line_notification_log(
  p_merchant_id uuid,
  p_event_type text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns setof public.line_notification_log
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not private.can_manage_line_notification(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的 LINE 發送記錄' using errcode = '42501';
  end if;

  return query
  select *
  from public.line_notification_log
  where merchant_id = p_merchant_id
    and (p_event_type is null or event_type = p_event_type)
  order by attempted_at desc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$$;

comment on function public.get_line_notification_log(uuid, text, int, int) is '3.18:發送記錄分頁清單,依 attempted_at 新到舊,可選依 event_type 篩選。';

revoke execute on function public.get_line_notification_log(uuid, text, int, int) from public, anon;
grant execute on function public.get_line_notification_log(uuid, text, int, int) to authenticated;
