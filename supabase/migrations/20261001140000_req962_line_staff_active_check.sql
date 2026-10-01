-- SPECS-INDEX #962:LINE 通知給服務人員時,要跟推播一樣檢查「這位服務人員是否還在職」。
-- 規格書:.project/specs/LINE通知服務人員在職檢查.md
--
-- =========================================================================
-- 推播那邊的在職條件(正式庫 2026-10-01 唯讀取得的最新版本,= migration 20261001100000)
-- =========================================================================
--   resolve_push_recipients 服務人員分支:
--     pes.enabled                       ← 推播「事件訂閱」開關(LINE 有自己的 notify_staff 開關,不適用)
--     s.merchant_id = p_merchant_id      ← 跨商家隔離
--     s.status = 'active'               ← ★ 在職判斷(merchant_staff.status 只有 active / removed 兩種,
--                                           removed = 已移除/離職/停用,見 20260916100000 CHECK)
--     s.login_status = 'active'         ← 「已開通服務人員端登入」;推播要送到 App 裝置所以必須有。
--     s.user_id is not null             ← 同上(有登入帳號)
--     private.staff_calendar_view_allows_notifications(s.id) ← #876,LINE 已有
--   ⇒ LINE 端照搬的「在職」條件 = s.status = 'active'(找不到這位服務人員也算不在職)。
--   ⇒ 跨商家隔離(s.merchant_id = p_merchant_id)不屬於「在職」,本條不擴大範圍;回報主腦另評估。
--   ⇒ 刻意不照搬 login_status / user_id:那兩道是「有沒有開通 App 登入」,不是在職與否。LINE 綁定
--     不需要登入(#876 已查證:尚未開通登入的服務人員也能綁 LINE、照收 LINE),照搬會讓所有未開通
--     登入的在職服務人員突然收不到 LINE。正式庫 2026-10-01 唯讀:merchant_staff 目前 line_bound=true
--     0 位(在職 active 26 位、removed 286 位,全部未綁),本 migration 套上去當下實際收件人不變。
--
-- =========================================================================
-- 寄出前再判斷:同 #876,沒有佇列
-- =========================================================================
--   line-notify-dispatch 在送出當下才呼叫本函式決定收件人(#876 migration 20261001100000 開頭已
--   查證),所以在職檢查加在本函式 = 加在寄出前的同一處;不需要改 Edge Function 的判斷邏輯。
--
-- =========================================================================
-- 跳過紀錄(主腦裁示:小改動可做就做)
-- =========================================================================
--   line_notification_log.skip_reason 是 text + CHECK,擴充 CHECK 即可,不需新表/新頁面:
--     staff_inactive           服務人員已離職/停用(本條新增)
--     staff_calendar_view_off  服務人員未開放行事曆檢視(補 #876 當時沒寫入跳過清單的部分)
--   判斷順序:離職/停用 → 行事曆檢視關閉 → 未綁 LINE;一位服務人員只記一個最根本的原因。
--   訂單沒有指派服務人員(staff_id 為 null)維持原行為(target_not_bound);bookings.staff_id 目前是 NOT NULL,實務上不會發生。
--   前端 LINE 發送記錄頁的白話文字在 src/modules/line-notifications/types.ts。
--
-- ⚠️ supabase-permission-hygiene 規則 1:revoke/grant 整組重寫。
-- ⚠️ 規則 6:改前已對正式庫唯讀取 md5(replace(prosrc, CRLF, LF)):
--      resolve_line_notification_targets de3b500654472be68c2cfd056c4bffa8(= 本機 = 20261001100000 版)
--    本檔所有說明寫在 $$ 之外,函式本體不含註解。
-- ⚠️ 時間戳排在 20261001130000 之後。

alter table public.line_notification_log
  drop constraint line_notification_log_skip_reason_check;
alter table public.line_notification_log
  add constraint line_notification_log_skip_reason_check check (
    skip_reason is null
    or skip_reason in (
      'not_configured', 'event_disabled', 'target_not_bound', 'no_target',
      'staff_inactive', 'staff_calendar_view_off'
    )
  );

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

  if v_settings.notify_staff and v_booking.id is not null then
    if v_booking.staff_id is not null
       and not exists (
         select 1 from public.merchant_staff
         where id = v_booking.staff_id and status = 'active'
       ) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_inactive')
      );
    elsif v_booking.staff_id is not null
       and not private.staff_calendar_view_allows_notifications(v_booking.staff_id) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_calendar_view_off')
      );
    elsif exists (select 1 from public.merchant_staff where id = v_booking.staff_id and line_bound = true) then
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

comment on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) is '3.10 邊界情況:preview_line_notification_targets(前端預覽)跟 line-notify-dispatch(實際發送判斷)共用的唯一一份判斷邏輯,避免兩邊分岔造成「彈窗說會通知,結果沒有通知」。⚠️ 函式內部完全沒有權限檢查,只能給 service_role(Edge Function)直接呼叫,前端一律走有 can_manage_bookings 檢查、且會濾掉 line_user_id 的 preview_line_notification_targets 包裝函式。2026-09-24 安全修補:原本漏掉 revoke authenticated,導致任何登入者都能帶任意 merchant_id 撈走該商家所有管理員/客服的 line_user_id。SPECS-INDEX #876:服務人員分支要求「行事曆檢視」是開的(private.staff_calendar_view_allows_notifications)。SPECS-INDEX #962:服務人員分支另要求在職(merchant_staff.status = active,與 resolve_push_recipients 同一道);不寄的服務人員列入跳過清單,原因依序為 staff_inactive(已離職/停用)、staff_calendar_view_off(未開放行事曆檢視)、target_not_bound(未綁 LINE)。';

revoke execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  to service_role;
