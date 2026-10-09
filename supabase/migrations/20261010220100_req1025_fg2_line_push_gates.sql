-- SPECS-INDEX #1025 功能開關 第 2 批(FG-2):LINE 通知 / 再行銷通知 / 手機推播通知的資料庫擋住點(FG2-F01)。
-- 以正式庫現行本體為底(pg_get_functiondef 取出),只插 [req1025 FG2] 標記段;簽章、security definer、
-- search_path、ACL 都不變。改前正式庫指紋(md5(replace(prosrc, CRLF, LF))):
--   public.resolve_line_notification_targets   67f55df55d6b6e3ad039d95b5ad271bc(c5a 版)
--   private.enqueue_customer_line              a59ebff513723554a8a63157eb494e31(c5a 版)
--   private.customer_line_notify_available     9a0cd26152e3692e3f7837af3a92fd9f(c5a 版)
--
-- 涵蓋:
--   ・店家這邊 LINE(line-notify-dispatch、後台確認訂單前的 preview_line_notification_targets、
--     客人單通知店家 store_booking_* 的待發列解析)⇒ resolve_line_notification_targets 回空清單。
--   ・客人 LINE ⇒ enqueue_customer_line 不寫待發列;關掉前已排進去的,由 Edge Function
--     customer-line-notify-dispatch 送出前再檢查一次,標 skipped、last_error = 'feature_disabled'。
--   ・客人會員中心「LINE 通知」區塊 / 加好友提示卡 / 預約完成頁「會用 LINE 通知您」⇒ customer_line_notify_available。
--   ・生日禮、再行銷、推播、測試推播:由各 Edge Function 用 service role 呼叫既有的
--     public.internal_merchant_has_feature(FG-3 已建立,只給 service_role)自己檢查(X7)。
--   ・推播「訂閱 / 取消訂閱裝置」資料庫端不擋(保留裝置,重新開通不用重設)。
-- 不改:private.merchant_has_feature、public.internal_merchant_has_feature、public.resolve_push_recipients。

-- =========================================================================
-- ① 店家這邊 LINE:public.resolve_line_notification_targets
-- =========================================================================
CREATE OR REPLACE FUNCTION public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid DEFAULT NULL::uuid, p_staff_leave_record_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_connected boolean;
  v_settings public.merchant_line_event_settings;
  v_booking public.bookings;
  v_targets jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_member_bound boolean;
  v_member_name text;
begin
  if p_booking_id is not null and not exists (
    select 1 from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆預約，或它不屬於這個商家' using errcode = 'P0002';
  end if;

  if p_staff_leave_record_id is not null and not exists (
    select 1 from public.staff_leave_records r
    join public.merchant_staff ms on ms.id = r.staff_id
    where r.id = p_staff_leave_record_id and ms.merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆請假紀錄，或它不屬於這個商家' using errcode = 'P0002';
  end if;

  -- [req1025 FG2 begin] 平台功能「LINE 通知」沒開 ⇒ 回空清單(不報錯;呼叫端照「沒有對象」處理)。
  -- 放在訂單 / 請假紀錄的歸屬檢查之後:帶別家 id 照樣報 P0002(#972),不因開關改變。
  if not private.merchant_has_feature(p_merchant_id, 'line_notifications') then
    return jsonb_build_object(
      'connected', false, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb,
      'feature_disabled', true
    );
  end if;
  -- [req1025 FG2 end]

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
    select * into v_booking from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id;
  end if;

  if v_settings.notify_staff and v_booking.id is not null then
    if v_booking.staff_id is not null
       and not exists (
         select 1 from public.merchant_staff
         where id = v_booking.staff_id and merchant_id = p_merchant_id and status = 'active'
       ) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_inactive')
      );
    elsif v_booking.staff_id is not null
       and not private.staff_calendar_view_allows_notifications(v_booking.staff_id) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_calendar_view_off')
      );
    elsif exists (
      select 1 from public.merchant_staff
      where id = v_booking.staff_id and merchant_id = p_merchant_id and line_bound = true
    ) then
      v_targets := v_targets || jsonb_build_array(jsonb_build_object(
        'type', 'staff', 'id', v_booking.staff_id,
        'name', (select name from public.merchant_staff where id = v_booking.staff_id and merchant_id = p_merchant_id),
        'line_user_id', (select line_user_id from public.merchant_staff where id = v_booking.staff_id and merchant_id = p_merchant_id)
      ));
    else
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'target_not_bound')
      );
    end if;
  end if;

  -- 客戶端第 5 批 C5-K01:模組 11 的「通知會員」(notify_member)已拿掉,客人通知改走 customer_line_outbox。

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
$function$;

revoke execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) to service_role;

-- =========================================================================
-- ② 客人 LINE:private.enqueue_customer_line(唯一寫入口)
-- =========================================================================
CREATE OR REPLACE FUNCTION private.enqueue_customer_line(p_kind text, p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_subject_user_id uuid, p_payload jsonb, p_send_after timestamp with time zone DEFAULT now(), p_dedupe_key text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_connected boolean;
  s public.merchant_customer_line_settings;
  v_store_event text;
  v_processing_id uuid;
  v_key text;
begin
  begin
    -- [req1025 FG2 begin] 平台功能「LINE 通知」沒開 ⇒ 不寫待發列(客人、店家這邊的客人單通知都不發)
    if not private.merchant_has_feature(p_merchant_id, 'line_notifications') then
      return;
    end if;
    -- [req1025 FG2 end]
    select c.is_connected into v_connected from public.merchant_line_configs c where c.merchant_id = p_merchant_id;
    if not coalesce(v_connected, false) then
      return;
    end if;
    s := private.customer_line_settings(p_merchant_id);
    if s.quota_blocked_until is not null and s.quota_blocked_until > now() then
      return;  -- ⚠️ 額度用完停發中:不寫
    end if;

    if p_kind in ('store_booking_created', 'store_booking_cancelled') then
      -- C5-S06:不看「通知客人」,看模組 11 既有事件設定。
      v_store_event := case p_kind when 'store_booking_created' then 'booking_created' else 'booking_cancelled' end;
      if not exists (
        select 1 from public.merchant_line_event_settings e
        where e.merchant_id = p_merchant_id and e.event_type = v_store_event and e.enabled
      ) then
        return;
      end if;
    elsif not private.customer_line_kind_enabled(s, p_kind) then
      return;
    end if;

    if p_kind = 'customer_rescheduled' then
      -- C5-N04 合併:同一張單已有「待發中(pending)」的改時間列 ⇒ 只把 send_after 往後延,payload(第一次改之前的時間)保留。
      -- (同一張單的改時間由 bookings 列鎖排隊,trigger 在同一交易內跑,不會兩邊同時以為「沒有待發列」。)
      update public.customer_line_outbox o
      set send_after = greatest(o.send_after, coalesce(p_send_after, now()))
      where o.booking_id = p_booking_id and o.merchant_id = p_merchant_id
        and o.kind = 'customer_rescheduled' and o.status = 'pending';
      if found then
        return;
      end if;
      -- QA M1:前一則改時間正在發送(processing)時又改 ⇒ 另寫一則新的待發列(3 分鐘後),之後再改就合併進這則。
      --   dedupe_key 帶發送中那則的 id,不撞「同 key 待發中只能一筆」的唯一索引。
      --   old_start_at 用「這次改之前的時間」(= 發送中那則正要告訴客人的新時間),新的這則就是「剛剛通知的時間 → 最後時間」;
      --   若最後又改回那個時間 ⇒ 發送時 superseded 不發(客人手上那則就是對的)。
      select o.id into v_processing_id from public.customer_line_outbox o
      where o.booking_id = p_booking_id and o.merchant_id = p_merchant_id
        and o.kind = 'customer_rescheduled' and o.status = 'processing'
      order by o.created_at desc, o.id desc
      limit 1;
      v_key := case when v_processing_id is null then p_dedupe_key else p_dedupe_key || ':after:' || v_processing_id end;
      insert into public.customer_line_outbox as o
        (merchant_id, kind, booking_id, member_id, subject_user_id, payload, dedupe_key, send_after)
      values
        (p_merchant_id, p_kind, p_booking_id, p_member_id, p_subject_user_id, coalesce(p_payload, '{}'::jsonb), v_key, coalesce(p_send_after, now()))
      on conflict (dedupe_key) where status in ('pending', 'processing')
      do update set send_after = greatest(o.send_after, excluded.send_after)
        where o.status = 'pending';
    else
      insert into public.customer_line_outbox
        (merchant_id, kind, booking_id, member_id, subject_user_id, payload, dedupe_key, send_after)
      values
        (p_merchant_id, p_kind, p_booking_id, p_member_id, p_subject_user_id, coalesce(p_payload, '{}'::jsonb), p_dedupe_key, coalesce(p_send_after, now()))
      on conflict (dedupe_key) where status in ('pending', 'processing')
      do nothing;
    end if;
  exception when others then
    -- 通知失敗絕不能讓店家確認 / 取消失敗(模組 11 規則 2.4)。訊息不帶任何資料。
    raise warning 'enqueue_customer_line 失敗(%)', sqlstate;
  end;
end;
$function$;

revoke all on function private.enqueue_customer_line(text, uuid, uuid, uuid, uuid, jsonb, timestamptz, text) from public, anon, authenticated, service_role;

-- =========================================================================
-- ③ 客人看得到的「這間店能不能用 LINE 通知您」:private.customer_line_notify_available
-- =========================================================================
CREATE OR REPLACE FUNCTION private.customer_line_notify_available(p_merchant_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_connected boolean;
  s public.merchant_customer_line_settings;
begin
  -- [req1025 FG2 begin] 平台功能「LINE 通知」沒開 ⇒ 當作不能用 LINE 通知客人(會員中心「LINE 通知」區塊、
  -- 加好友提示卡不顯示;完成頁文案不提 LINE;不告訴客人是平台沒開通)。
  if not private.merchant_has_feature(p_merchant_id, 'line_notifications') then
    return false;
  end if;
  -- [req1025 FG2 end]
  select c.is_connected into v_connected from public.merchant_line_configs c where c.merchant_id = p_merchant_id;
  if not coalesce(v_connected, false) then
    return false;
  end if;
  s := private.customer_line_settings(p_merchant_id);
  return s.on_submitted or s.on_scheduled_by_store or s.on_confirmed or s.on_rescheduled
      or s.on_cancelled_by_store or s.on_cancelled_by_customer or s.on_reminder or s.on_completed;
end;
$function$;

revoke all on function private.customer_line_notify_available(uuid) from public, anon, authenticated, service_role;
