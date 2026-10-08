-- 客戶端第 5-A 批(LINE 通知客人)— 函式、trigger、排程
-- 規格:.project/specs/客戶端第5批-LINE通知與綁定.md(零之零定案優先;這支只做 5-A)。
--
-- 內容:
--   ① 讀設定 / 預設範本 / 好友狀態等小工具(private)
--   ② C5-S01 private.enqueue_customer_line(唯一寫入口;失敗只 warning,絕不影響呼叫端)
--   ③ C5-S02 bookings trigger bookings_enqueue_customer_line(+ C5-S06 客人單通知店家這邊)
--   ④ C5-N01~N08 補充:cancel_completed_booking 多一句(管理員勾「通知」時才發)
--   ⑤ C5-R01 收件人、C5-S05 internal_claim / prepare / finish、C5-F01/F02 internal_set_line_friendship
--   ⑥ C5-M03 客人開關、customer_get_member_home、C5-M04 get_public_booking_page / 完成頁預設句
--   ⑦ C5-K01 resolve_line_notification_targets 拿掉 notify_member 段、C5-K02 設定函式、C5-K03 發送記錄、C5-F03 聯絡人卡
--   ⑧ C5-S04 排程(每分鐘、Vault 密鑰 customer_line_cron_secret)+ 待發清單 30 天清理
--
-- 不改的函式(指紋不變):create_booking、update_booking、move_booking、confirm_booking、staff_confirm_booking、
-- cancel_booking、staff_cancel_booking、complete_booking、revert_completed_booking、internal_customer_submit_booking、
-- internal_customer_cancel_booking、update_booking_payment_method、check_customer_booking_slot、member_sync_primary、
-- customer_member_of、consume_line_binding_code、render_booking_notification_variables。
-- 「會被交易內刪索引的測試打到的輔助函式要寫 plpgsql」(skill 已知坑)⇒ 本檔新函式一律 plpgsql。

-- =========================================================================
-- ① 小工具
-- =========================================================================

-- 店家「通知客人」設定(沒有列 ⇒ 預設值;預設值跟表的 column default 一致,pgTAP 有比對)。
create or replace function private.customer_line_settings(p_merchant_id uuid)
returns public.merchant_customer_line_settings
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.merchant_customer_line_settings;
begin
  select * into v from public.merchant_customer_line_settings s where s.merchant_id = p_merchant_id;
  if not found then
    v.merchant_id := p_merchant_id;
    v.on_submitted := true;
    v.on_scheduled_by_store := false;
    v.on_confirmed := true;
    v.on_rescheduled := true;
    v.on_cancelled_by_store := true;
    v.on_cancelled_by_customer := true;
    v.on_reminder := false;
    v.on_completed := false;
    v.on_contact_events := true;
    v.reminder_hours_before := 24;
    v.monthly_cap := null;
    v.templates := '{}'::jsonb;
    v.quota_blocked_until := null;
    v.quota_warned_month := null;
  end if;
  return v;
end;
$$;
revoke all on function private.customer_line_settings(uuid) from public, anon, authenticated, service_role;

-- 某種客人通知的開關。
create or replace function private.customer_line_kind_enabled(p_settings public.merchant_customer_line_settings, p_kind text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  return coalesce(case p_kind
    when 'customer_submitted' then p_settings.on_submitted
    when 'customer_scheduled_by_store' then p_settings.on_scheduled_by_store
    when 'customer_confirmed' then p_settings.on_confirmed
    when 'customer_rescheduled' then p_settings.on_rescheduled
    when 'customer_cancelled_by_store' then p_settings.on_cancelled_by_store
    when 'customer_cancelled_by_customer' then p_settings.on_cancelled_by_customer
    when 'customer_reminder' then p_settings.on_reminder
    when 'customer_completed' then p_settings.on_completed
    when 'customer_contact_request' then p_settings.on_contact_events
    when 'customer_contact_removed' then p_settings.on_contact_events
    when 'customer_contact_request_resolved' then p_settings.on_contact_events
    else false
  end, false);
end;
$$;
revoke all on function private.customer_line_kind_enabled(public.merchant_customer_line_settings, text) from public, anon, authenticated, service_role;

-- C5-N13 範本代碼(順序 = 後台顯示順序)。
create or replace function private.customer_line_template_codes()
returns text[]
language plpgsql
immutable
set search_path = public
as $$
begin
  return array[
    'submitted_pending', 'submitted_accepted', 'scheduled_by_store', 'confirmed', 'rescheduled',
    'cancelled_by_store', 'cancelled_by_customer', 'reminder', 'completed',
    'contact_request', 'contact_removed', 'contact_approved', 'contact_rejected'
  ];
end;
$$;
revoke all on function private.customer_line_template_codes() from public, anon, authenticated, service_role;

-- C5-N13 預設文案(全形標點;到府產業「時間獨立一行」的地方多「（預計抵達時間）」⚠️)。
create or replace function private.customer_line_default_templates(p_is_on_site boolean)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  t text := case when coalesce(p_is_on_site, false) then '{{booking_time}}（預計抵達時間）' else '{{booking_time}}' end;
begin
  return jsonb_build_object(
    'submitted_pending',
      '「{{merchant_name}}」已收到你的預約：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '店家確認後會再用 LINE 通知你。' || E'\n' || '查看預約：{{member_center_url}}',
    'submitted_accepted',
      '「{{merchant_name}}」預約成功：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '服務人員：{{staff_name}}' || E'\n' || '查看或取消：{{member_center_url}}',
    'scheduled_by_store',
      '「{{merchant_name}}」已為你安排預約：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '查看預約：{{member_center_url}}',
    'confirmed',
      '「{{merchant_name}}」已確認你的預約：' || E'\n' || '{{booking_date}} ' || t || E'\n'
      || '服務人員：{{staff_name}}' || E'\n' || '查看或取消：{{member_center_url}}',
    'rescheduled',
      '「{{merchant_name}}」調整了你的預約時間：' || E'\n' || '原本：{{old_booking_date}} {{old_booking_time}}' || E'\n'
      || '改為：{{booking_date}} ' || t || E'\n' || '如果時間不方便，請聯絡店家：{{merchant_phone}}',
    'cancelled_by_store',
      '「{{merchant_name}}」取消了你 {{booking_date}} {{booking_time}} 的預約。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}',
    'cancelled_by_customer',
      '你們在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。',
    'reminder',
      '提醒你：{{booking_day_word}} ' || t || ' 在「{{merchant_name}}」有預約。' || E'\n' || '{{service_items}}' || E'\n'
      || '查看預約：{{member_center_url}}',
    'completed',
      '謝謝你今天光臨「{{merchant_name}}」！' || E'\n' || '查看紀錄：{{member_center_url}}',
    'contact_request',
      '{{contact_name}} 申請成為你在「{{merchant_name}}」會員的聯絡人，請到會員中心同意或拒絕：{{member_center_url}}',
    'contact_removed',
      '你已不是「{{merchant_name}}」會員「{{member_name}}」的聯絡人，之後不會再收到這位會員的預約通知。',
    'contact_approved',
      '你已成為「{{merchant_name}}」會員「{{member_name}}」的聯絡人，可以到會員中心查看預約：{{member_center_url}}',
    'contact_rejected',
      '你申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。有問題請聯絡店家：{{merchant_phone}}'
  );
end;
$$;
revoke all on function private.customer_line_default_templates(boolean) from public, anon, authenticated, service_role;

-- 店家能不能用 LINE 通知客人(C5-M01 available):已接上官方帳號 + 至少一種預約通知開著。
create or replace function private.customer_line_notify_available(p_merchant_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_connected boolean;
  s public.merchant_customer_line_settings;
begin
  select c.is_connected into v_connected from public.merchant_line_configs c where c.merchant_id = p_merchant_id;
  if not coalesce(v_connected, false) then
    return false;
  end if;
  s := private.customer_line_settings(p_merchant_id);
  return s.on_submitted or s.on_scheduled_by_store or s.on_confirmed or s.on_rescheduled
      or s.on_cancelled_by_store or s.on_cancelled_by_customer or s.on_reminder or s.on_completed;
end;
$$;
revoke all on function private.customer_line_notify_available(uuid) from public, anon, authenticated, service_role;

-- 加好友網址(C5-M01 ⚠️):官方帳號 @ID 優先(@ 網址編碼成 %40),沒有用 merchants.line_friend_url,都沒有 null。
create or replace function private.customer_line_add_friend_url(p_merchant_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_basic text;
  v_url text;
begin
  select btrim(c.line_bot_basic_id) into v_basic from public.merchant_line_configs c where c.merchant_id = p_merchant_id;
  if v_basic is not null and v_basic ~ '^@?[A-Za-z0-9._-]{1,40}$' then
    return 'https://line.me/R/ti/p/' || case when left(v_basic, 1) = '@' then '%40' || substr(v_basic, 2) else v_basic end;
  end if;
  select nullif(btrim(m.line_friend_url), '') into v_url from public.merchants m where m.id = p_merchant_id;
  return v_url;
end;
$$;
revoke all on function private.customer_line_add_friend_url(uuid) from public, anon, authenticated, service_role;

-- 好友狀態:friend / not_friend / unknown(沒有列)。
create or replace function private.customer_line_friend_status(p_merchant_id uuid, p_line_user_id text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v boolean;
begin
  if p_line_user_id is null then
    return 'unknown';
  end if;
  select f.is_friend into v from public.customer_line_friendships f
  where f.merchant_id = p_merchant_id and f.line_user_id = p_line_user_id;
  if not found then
    return 'unknown';
  end if;
  return case when v then 'friend' else 'not_friend' end;
end;
$$;
revoke all on function private.customer_line_friend_status(uuid, text) from public, anon, authenticated, service_role;

-- 客戶帳號在這間店「目前 LINE 登入 channel」的 LINE userId;channel 不同 / 沒有身分 ⇒ null(C5-R01 ⚠️)。
create or replace function private.customer_line_user_id_for(p_merchant_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_sub text;
begin
  select i.line_sub into v_sub
  from public.customer_line_identities i
  join public.merchant_line_login_configs c on c.merchant_id = p_merchant_id and c.channel_id = i.line_channel_id
  where i.user_id = p_user_id;
  return v_sub;
end;
$$;
revoke all on function private.customer_line_user_id_for(uuid, uuid) from public, anon, authenticated, service_role;

-- C5-S02「是誰做的」:customer / staff / store。
-- customer = 客戶帳號(app_metadata.account_type);staff = 這間店 merchant_staff 本人且不是這間店的管理員 / 集團管理員 / 在職客服;
-- 其他(含 null)= store。服務人員端操作另外由 trigger 看交易內 GUC miaoyue.staff_order_actor 判斷(優先)。
create or replace function private.booking_actor_kind(p_merchant_id uuid, p_user_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    return 'store';
  end if;
  if exists (
    select 1 from auth.users u
    where u.id = p_user_id and coalesce(u.raw_app_meta_data ->> 'account_type', '') = 'customer'
  ) then
    return 'customer';
  end if;
  if exists (select 1 from public.merchant_staff ms where ms.merchant_id = p_merchant_id and ms.user_id = p_user_id)
     and not exists (select 1 from public.merchant_admins ma where ma.merchant_id = p_merchant_id and ma.user_id = p_user_id)
     and not exists (
       select 1 from public.merchants m join public.groups g on g.id = m.group_id
       where m.id = p_merchant_id and g.group_admin_user_id = p_user_id
     )
     and not exists (
       select 1 from public.merchant_agents ag
       where ag.merchant_id = p_merchant_id and ag.user_id = p_user_id and ag.status = 'active'
     ) then
    return 'staff';
  end if;
  return 'store';
end;
$$;
revoke all on function private.booking_actor_kind(uuid, uuid) from public, anon, authenticated, service_role;

-- =========================================================================
-- ② C5-S01 唯一寫入口
-- =========================================================================
create or replace function private.enqueue_customer_line(
  p_kind text,
  p_merchant_id uuid,
  p_booking_id uuid,
  p_member_id uuid,
  p_subject_user_id uuid,
  p_payload jsonb,
  p_send_after timestamptz default now(),
  p_dedupe_key text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connected boolean;
  s public.merchant_customer_line_settings;
  v_store_event text;
  v_processing_id uuid;
  v_key text;
begin
  begin
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
$$;
revoke all on function private.enqueue_customer_line(text, uuid, uuid, uuid, uuid, jsonb, timestamptz, text) from public, anon, authenticated, service_role;

-- =========================================================================
-- ③ C5-S02 bookings trigger
-- =========================================================================
create or replace function private.tg_bookings_enqueue_customer_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connected boolean;
  v_staff_guc text;
  v_actor_kind text;
  v_actor uuid;
  v_pending constant text[] := array['pending_confirmation', 'pending_reply', 'dispatching'];
begin
  -- 沒接上官方帳號的店(目前全部)直接結束:對既有操作沒有額外負擔。
  select c.is_connected into v_connected from public.merchant_line_configs c where c.merchant_id = new.merchant_id;
  if not coalesce(v_connected, false) then
    return null;
  end if;
  if new.source = 'import' then
    return null;  -- ⚠️ 匯入的單一律不發
  end if;

  begin
    v_staff_guc := coalesce(current_setting('miaoyue.staff_order_actor', true), '');

    if tg_op = 'INSERT' then
      v_actor := new.created_by_user_id;
      v_actor_kind := case
        when v_staff_guc <> '' or new.created_by_role = 'staff' then 'staff'
        when new.created_by_role = 'customer' then 'customer'
        else 'store' end;

      if new.source = 'customer' then
        perform private.enqueue_customer_line('store_booking_created', new.merchant_id, new.id, new.member_id, null,
          jsonb_build_object('actor_kind', v_actor_kind), now(), 'store_created:' || new.id);
        if new.member_id is not null then
          perform private.enqueue_customer_line('customer_submitted', new.merchant_id, new.id, new.member_id, v_actor,
            jsonb_build_object('initial_status', new.status, 'actor_kind', v_actor_kind), now(), 'submitted:' || new.id);
        end if;
      elsif new.source in ('manual', 'smart')
            and new.member_id is not null
            and (new.status = any (v_pending) or new.status = 'accepted') then
        perform private.enqueue_customer_line('customer_scheduled_by_store', new.merchant_id, new.id, new.member_id, v_actor,
          jsonb_build_object('initial_status', new.status, 'actor_kind', v_actor_kind), now(), 'scheduled:' || new.id);
      end if;
      return null;
    end if;

    -- UPDATE
    v_actor := new.last_modified_by_user_id;
    v_actor_kind := case when v_staff_guc <> '' then 'staff' else private.booking_actor_kind(new.merchant_id, v_actor) end;

    if new.status is distinct from old.status then
      -- 狀態一變:同一張單還沒發的提醒列作廢(5-B 的提醒排程會重新排)。
      update public.customer_line_outbox o
      set status = 'skipped', last_error = 'stale', processed_at = now()
      where o.booking_id = new.id and o.kind = 'customer_reminder' and o.status = 'pending';

      if old.status = any (v_pending) and new.status = 'accepted' then
        if new.member_id is not null then
          perform private.enqueue_customer_line('customer_confirmed', new.merchant_id, new.id, new.member_id, v_actor,
            jsonb_build_object('actor_kind', v_actor_kind), now(), 'confirmed:' || new.id);
        end if;
      elsif (old.status = any (v_pending) or old.status = 'accepted') and new.status = 'cancelled' then
        if v_actor_kind = 'customer' then
          perform private.enqueue_customer_line('store_booking_cancelled', new.merchant_id, new.id, new.member_id, v_actor,
            jsonb_build_object('actor_kind', v_actor_kind), now(), 'store_cancelled:' || new.id);
          if new.member_id is not null then
            perform private.enqueue_customer_line('customer_cancelled_by_customer', new.merchant_id, new.id, new.member_id, v_actor,
              jsonb_build_object('actor_kind', v_actor_kind, 'actor_user_id', v_actor), now(), 'cancelled:' || new.id);
          end if;
        elsif new.member_id is not null then
          perform private.enqueue_customer_line('customer_cancelled_by_store', new.merchant_id, new.id, new.member_id, v_actor,
            jsonb_build_object('actor_kind', v_actor_kind), now(), 'cancelled:' || new.id);
        end if;
      end if;
      -- 舊狀態 completed(已完成被取消 / 還原)一律不在這裡發(C5-N01~N08 補充)。
    end if;

    if new.start_at is distinct from old.start_at
       and (new.status = any (v_pending) or new.status = 'accepted')
       and new.member_id is not null
       and v_actor_kind <> 'staff' then  -- #986:服務人員改單 / 拖拉不通知客人
      perform private.enqueue_customer_line('customer_rescheduled', new.merchant_id, new.id, new.member_id, v_actor,
        jsonb_build_object('old_start_at', old.start_at, 'actor_kind', v_actor_kind),
        now() + interval '3 minutes', 'rescheduled:' || new.id);
    end if;
  exception when others then
    raise warning 'tg_bookings_enqueue_customer_line 失敗(%)', sqlstate;
  end;
  return null;
end;
$$;
revoke all on function private.tg_bookings_enqueue_customer_line() from public, anon, authenticated, service_role;

drop trigger if exists bookings_enqueue_customer_line on public.bookings;
create trigger bookings_enqueue_customer_line
  after insert or update of status, start_at on public.bookings
  for each row execute function private.tg_bookings_enqueue_customer_line();

-- =========================================================================
-- ④ cancel_completed_booking:管理員打開「通知」才發(使用者 #844 Q2);只多一句 perform。
-- =========================================================================
create or replace function public.cancel_completed_booking(p_booking_id uuid, p_reason text, p_notify_requested boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
begin
  -- p_notify_requested 只用來寫稽核表 notified(管理員的選擇);LINE / 推播由前端在成功後依開關非同步發送(§4.4、§4.5)。
  v_result := private.reverse_booking_completion(p_booking_id, 'cancelled', p_reason, coalesce(p_notify_requested, false));
  -- 第 11 批 H:不論 p_notify_requested,同一交易寫站內鈴鐺給其他管理員與有訂單管理權限的在職客服;失敗整筆回滾。
  perform private.notify_completed_booking_reversal(p_booking_id);
  -- 客戶端第 5 批 C5-N05 補充:管理員打開「通知」時才通知客人(trigger 看到舊狀態 completed 不發)。
  perform private.enqueue_customer_line('customer_cancelled_by_store', b.merchant_id, b.id, b.member_id, null, jsonb_build_object('actor_kind', 'store', 'from_completed', true), now(), 'cancelled:' || b.id) from public.bookings b where b.id = p_booking_id and b.member_id is not null and coalesce(p_notify_requested, false);
  return v_result;
end;
$function$;

-- =========================================================================
-- ⑤ 收件人、領取、準備、結束、好友狀態
-- =========================================================================

-- C5-R01 預約類通知的收件人(發送當下才算)。只給內部用(prepare 呼叫)。
-- 回 { recipients:[{to, target_type:'member', target_id, target_user_id, contact_id}], skipped:[{target_type, target_id, target_user_id, reason}] }
create or replace function private.resolve_customer_line_recipients(p_outbox_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  b public.bookings;
  m public.members;
  c record;
  v_recipients jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_has_contacts boolean;
  v_exclude uuid;
  v_to text;
begin
  select * into o from public.customer_line_outbox where id = p_outbox_id;
  if not found or o.booking_id is null then
    return jsonb_build_object('recipients', v_recipients, 'skipped', v_skipped);
  end if;
  select * into b from public.bookings where id = o.booking_id and merchant_id = o.merchant_id;
  if not found or b.member_id is null then
    return jsonb_build_object('recipients', v_recipients,
      'skipped', jsonb_build_array(jsonb_build_object('target_type', 'member', 'target_id', null, 'target_user_id', null, 'reason', 'no_target')));
  end if;
  select * into m from public.members where id = b.member_id and merchant_id = o.merchant_id;
  if not found then
    return jsonb_build_object('recipients', v_recipients,
      'skipped', jsonb_build_array(jsonb_build_object('target_type', 'member', 'target_id', null, 'target_user_id', null, 'reason', 'no_target')));
  end if;

  if o.kind = 'customer_cancelled_by_customer' then
    v_exclude := nullif(o.payload ->> 'actor_user_id', '')::uuid;
  end if;

  v_has_contacts := exists (
    select 1 from public.member_customer_contacts x
    where x.member_id = m.id and x.merchant_id = o.merchant_id and x.status = 'active'
  );

  if v_has_contacts then
    for c in
      select x.* from public.member_customer_contacts x
      where x.member_id = m.id and x.merchant_id = o.merchant_id and x.status = 'active'
        and (
          x.is_primary
          -- 下單的聯絡人也收(第 4 批第八節);訪客單只通知主要聯絡人(Q4=A);第二聯絡人沒下這張單不收 ⚠️
          or (not b.is_guest_booking and b.created_by_user_id is not null and x.user_id = b.created_by_user_id)
        )
        and (v_exclude is null or x.user_id <> v_exclude)
      order by x.is_primary desc, x.created_at, x.id
    loop
      if not c.notify_booking then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'target_type', 'member', 'target_id', m.id, 'target_user_id', c.user_id, 'reason', 'customer_opted_out'));
        continue;
      end if;
      v_to := private.customer_line_user_id_for(o.merchant_id, c.user_id);
      if v_to is null then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'target_type', 'member', 'target_id', m.id, 'target_user_id', c.user_id, 'reason', 'target_not_bound'));
        continue;
      end if;
      if private.customer_line_friend_status(o.merchant_id, v_to) = 'not_friend' then
        v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
          'target_type', 'member', 'target_id', m.id, 'target_user_id', c.user_id, 'reason', 'not_friend'));
        continue;
      end if;
      v_recipients := v_recipients || jsonb_build_array(jsonb_build_object(
        'to', v_to, 'target_type', 'member', 'target_id', m.id, 'target_user_id', c.user_id, 'contact_id', c.id));
    end loop;
  elsif m.line_bound and m.line_user_id is not null then
    -- 舊綁定碼會員:視為兩個開關都開 ⚠️
    if private.customer_line_friend_status(o.merchant_id, m.line_user_id) = 'not_friend' then
      v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
        'target_type', 'member', 'target_id', m.id, 'target_user_id', null, 'reason', 'not_friend'));
    else
      v_recipients := v_recipients || jsonb_build_array(jsonb_build_object(
        'to', m.line_user_id, 'target_type', 'member', 'target_id', m.id, 'target_user_id', null, 'contact_id', null));
    end if;
  else
    v_skipped := v_skipped || jsonb_build_array(jsonb_build_object(
      'target_type', 'member', 'target_id', m.id, 'target_user_id', null, 'reason', 'target_not_bound'));
  end if;

  return jsonb_build_object('recipients', v_recipients, 'skipped', v_skipped);
end;
$$;
revoke all on function private.resolve_customer_line_recipients(uuid) from public, anon, authenticated, service_role;

-- 日期 / 時間格式(台北):10月13日（二）、10:00。
create or replace function private.customer_line_format_date(p_at timestamptz)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v timestamp := p_at at time zone 'Asia/Taipei';
begin
  if p_at is null then
    return '';
  end if;
  return extract(month from v)::int || '月' || extract(day from v)::int || '日（'
    || (array['日', '一', '二', '三', '四', '五', '六'])[extract(dow from v)::int + 1] || '）';
end;
$$;
revoke all on function private.customer_line_format_date(timestamptz) from public, anon, authenticated, service_role;

create or replace function private.customer_line_format_time(p_at timestamptz)
returns text
language plpgsql
immutable
set search_path = public
as $$
begin
  if p_at is null then
    return '';
  end if;
  return to_char(p_at at time zone 'Asia/Taipei', 'HH24:MI');
end;
$$;
revoke all on function private.customer_line_format_time(timestamptz) from public, anon, authenticated, service_role;

-- C5-N13 預約類變數(不含 member_center_url:網址由 Edge 用 PUBLIC_SITE_URL + slug 組)。
-- 不提供金額、地址、內部備註、服務人員本名 / 電話 ⚠️。
create or replace function private.customer_line_booking_variables(p_outbox_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  b public.bookings;
  v_merchant public.merchants;
  v_member_name text;
  v_staff text;
  v_items text;
  v_old timestamptz;
  v_contact text;
begin
  select * into o from public.customer_line_outbox where id = p_outbox_id;
  select * into b from public.bookings where id = o.booking_id and merchant_id = o.merchant_id;
  select * into v_merchant from public.merchants where id = o.merchant_id;
  select mm.name into v_member_name from public.members mm where mm.id = b.member_id and mm.merchant_id = o.merchant_id;
  select coalesce(nullif(btrim(ms.nickname), ''), ms.name) into v_staff
  from public.merchant_staff ms where ms.id = b.staff_id and ms.merchant_id = o.merchant_id;
  select string_agg(si.name || ' ×' || bsi.quantity, '、'
                    order by case when si.item_type = 'primary' then 0 else 1 end, si.created_at, si.id)
  into v_items
  from public.booking_service_items bsi
  join public.service_items si on si.id = bsi.service_item_id
  where bsi.booking_id = b.id;

  v_old := nullif(o.payload ->> 'old_start_at', '')::timestamptz;

  if o.kind = 'customer_cancelled_by_customer' then
    select nullif(btrim(i.display_name), '') into v_contact
    from public.customer_line_identities i where i.user_id = nullif(o.payload ->> 'actor_user_id', '')::uuid;
    v_contact := coalesce(v_contact, '另一位聯絡人');
  end if;

  return jsonb_build_object(
    'member_name', coalesce(v_member_name, ''),
    'merchant_name', coalesce(v_merchant.name, ''),
    'booking_date', private.customer_line_format_date(b.start_at),
    'booking_time', private.customer_line_format_time(b.start_at),
    'old_booking_date', private.customer_line_format_date(v_old),
    'old_booking_time', private.customer_line_format_time(v_old),
    'service_items', coalesce(v_items, ''),
    'staff_name', coalesce(v_staff, ''),
    'merchant_phone', coalesce(btrim(v_merchant.phone), ''),
    'contact_name', coalesce(v_contact, '')
  );
end;
$$;
revoke all on function private.customer_line_booking_variables(uuid) from public, anon, authenticated, service_role;

-- C5-S05 第 1 步:領取到期列(skip locked)。卡在 processing 超過 10 分鐘的先放回 pending(attempts + 1)⚠️。
create or replace function public.internal_claim_customer_line_outbox(p_limit integer default 50)
returns table(id uuid, kind text, merchant_id uuid)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  update public.customer_line_outbox o
  set status = case when o.attempts >= 3 then 'failed' else 'pending' end,
      attempts = o.attempts + 1,
      last_error = 'stuck_processing',
      claimed_at = null,
      processed_at = case when o.attempts >= 3 then now() else null end
  where o.status = 'processing' and o.claimed_at < now() - interval '10 minutes';

  return query
  with picked as (
    select o.id from public.customer_line_outbox o
    where o.status = 'pending' and o.send_after <= now()
    order by o.send_after, o.created_at, o.id
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    for update skip locked
  )
  update public.customer_line_outbox o
  set status = 'processing', claimed_at = now()
  from picked
  where o.id = picked.id
  returning o.id, o.kind, o.merchant_id;
end;
$$;
revoke all on function public.internal_claim_customer_line_outbox(integer) from public, anon, authenticated;
grant execute on function public.internal_claim_customer_line_outbox(integer) to service_role;

-- C5-S05 第 2 步:重新檢查 + 收件人 + 範本 + 變數 + 該店 token。
-- 回 state:send / stale / superseded / skip(安靜結束,不寫記錄)/ not_claimed。
create or replace function public.internal_prepare_customer_line_job(p_outbox_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  b public.bookings;
  v_cfg public.merchant_line_configs;
  s public.merchant_customer_line_settings;
  v_merchant public.merchants;
  v_pending constant text[] := array['pending_confirmation', 'pending_reply', 'dispatching'];
  v_is_store boolean;
  v_store_event text;
  v_resolved jsonb;
  v_recipients jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_template text;
  v_template_code text;
  v_variables jsonb := '{}'::jsonb;
  v_blocked boolean;
  v_base jsonb;
begin
  select * into o from public.customer_line_outbox where id = p_outbox_id;
  if not found or o.status <> 'processing' then
    return jsonb_build_object('state', 'not_claimed');
  end if;

  v_base := jsonb_build_object('outbox_id', o.id, 'kind', o.kind, 'merchant_id', o.merchant_id,
    'booking_id', o.booking_id, 'member_id', o.member_id, 'attempts', o.attempts);

  select * into v_cfg from public.merchant_line_configs where merchant_id = o.merchant_id;
  if not found or not v_cfg.is_connected or nullif(v_cfg.channel_access_token, '') is null then
    return v_base || jsonb_build_object('state', 'skip', 'reason', 'not_configured');
  end if;

  v_is_store := o.kind in ('store_booking_created', 'store_booking_cancelled');
  s := private.customer_line_settings(o.merchant_id);

  -- 5-B 的種類(提醒、完成、聯絡人)這批不發。
  if o.kind in ('customer_reminder', 'customer_completed', 'customer_contact_request',
                'customer_contact_removed', 'customer_contact_request_resolved') then
    return v_base || jsonb_build_object('state', 'skip', 'reason', 'unsupported');
  end if;

  -- 客人那 3 分鐘內店家把那種通知關掉了 ⇒ 安靜結束。
  if not v_is_store and not private.customer_line_kind_enabled(s, o.kind) then
    return v_base || jsonb_build_object('state', 'skip', 'reason', 'event_disabled');
  end if;

  select * into b from public.bookings where id = o.booking_id and merchant_id = o.merchant_id;
  if not found then
    return v_base || jsonb_build_object('state', 'skip', 'reason', 'no_booking');
  end if;

  -- 過時判斷(C5-S05 第 2 點)。
  if o.created_at < now() - interval '6 hours' then
    return v_base || jsonb_build_object('state', 'stale', 'reason', 'stale');
  end if;
  if (o.kind in ('customer_submitted', 'customer_scheduled_by_store') and b.status in ('cancelled', 'completed'))
     or (o.kind = 'customer_confirmed' and b.status <> 'accepted')
     or (o.kind = 'customer_rescheduled' and b.status in ('cancelled', 'completed'))
     or (o.kind in ('customer_cancelled_by_store', 'customer_cancelled_by_customer', 'store_booking_cancelled') and b.status <> 'cancelled') then
    return v_base || jsonb_build_object('state', 'stale', 'reason', 'stale');
  end if;
  if o.kind = 'customer_rescheduled'
     and b.start_at = nullif(o.payload ->> 'old_start_at', '')::timestamptz then
    return v_base || jsonb_build_object('state', 'superseded', 'reason', 'superseded');
  end if;

  select * into v_merchant from public.merchants where id = o.merchant_id;

  if v_is_store then
    -- C5-S06:跟 line-notify-dispatch 同一套(模組 11 範本 + 變數 + 對象;會員對象已在 K01 拿掉)。
    v_store_event := case o.kind when 'store_booking_created' then 'booking_created' else 'booking_cancelled' end;
    v_resolved := public.resolve_line_notification_targets(o.merchant_id, v_store_event, o.booking_id, null);
    if not coalesce((v_resolved ->> 'connected')::boolean, false) or not coalesce((v_resolved ->> 'event_enabled')::boolean, false) then
      return v_base || jsonb_build_object('state', 'skip', 'reason', 'event_disabled');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('to', t ->> 'line_user_id', 'target_type', t ->> 'type',
             'target_id', t ->> 'id', 'target_user_id', null)), '[]'::jsonb)
    into v_recipients
    from jsonb_array_elements(coalesce(v_resolved -> 'targets', '[]'::jsonb)) t
    where t ->> 'type' <> 'member';
    select coalesce(jsonb_agg(jsonb_build_object('target_type', t ->> 'type', 'target_id', t ->> 'id',
             'target_user_id', null, 'reason', t ->> 'reason')), '[]'::jsonb)
    into v_skipped
    from jsonb_array_elements(coalesce(v_resolved -> 'skipped', '[]'::jsonb)) t
    where t ->> 'type' <> 'member';
    select e.message_template into v_template from public.merchant_line_event_settings e
    where e.merchant_id = o.merchant_id and e.event_type = v_store_event;
    v_variables := public.render_booking_notification_variables(o.booking_id, o.merchant_id);
    v_template_code := null;
  else
    v_resolved := private.resolve_customer_line_recipients(o.id);
    v_recipients := coalesce(v_resolved -> 'recipients', '[]'::jsonb);
    v_skipped := coalesce(v_resolved -> 'skipped', '[]'::jsonb);
    v_template_code := case o.kind
      when 'customer_submitted' then
        case when coalesce(o.payload ->> 'initial_status', b.status) = 'accepted' then 'submitted_accepted' else 'submitted_pending' end
      when 'customer_scheduled_by_store' then 'scheduled_by_store'
      when 'customer_confirmed' then 'confirmed'
      when 'customer_rescheduled' then 'rescheduled'
      when 'customer_cancelled_by_store' then 'cancelled_by_store'
      when 'customer_cancelled_by_customer' then 'cancelled_by_customer'
    end;
    v_template := coalesce(
      nullif(btrim(s.templates ->> v_template_code), ''),
      private.customer_line_default_templates(v_merchant.industry_type = 'on_site_dispatch') ->> v_template_code
    );
    v_variables := private.customer_line_booking_variables(o.id);
  end if;

  -- 額度用完停發中 ⇒ 每位收件人都略過(quota_exhausted)。
  v_blocked := s.quota_blocked_until is not null and s.quota_blocked_until > now();
  if v_blocked then
    select v_skipped || coalesce(jsonb_agg(r - 'to' - 'contact_id' || jsonb_build_object('reason', 'quota_exhausted')), '[]'::jsonb)
    into v_skipped from jsonb_array_elements(v_recipients) r;
    v_recipients := '[]'::jsonb;
  end if;

  -- 重試時:已經寫過記錄的對象不再處理(冪等;sent / failed / skipped 都算)。
  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_recipients
  from jsonb_array_elements(v_recipients) r
  where not exists (
    select 1 from public.line_notification_log l
    where l.outbox_id = o.id
      and l.target_type = r ->> 'target_type'
      and l.target_id is not distinct from nullif(r ->> 'target_id', '')::uuid
      and l.target_user_id is not distinct from nullif(r ->> 'target_user_id', '')::uuid
  );
  select coalesce(jsonb_agg(r), '[]'::jsonb) into v_skipped
  from jsonb_array_elements(v_skipped) r
  where not exists (
    select 1 from public.line_notification_log l
    where l.outbox_id = o.id
      and l.target_type = r ->> 'target_type'
      and l.target_id is not distinct from nullif(r ->> 'target_id', '')::uuid
      and l.target_user_id is not distinct from nullif(r ->> 'target_user_id', '')::uuid
  );

  return v_base || jsonb_build_object(
    'state', 'send',
    'log_event_type', case when v_is_store then v_store_event else o.kind end,
    'channel_access_token', v_cfg.channel_access_token,
    'template_code', v_template_code,
    'template', coalesce(v_template, ''),
    'variables', coalesce(v_variables, '{}'::jsonb),
    'slug', v_merchant.booking_slug,
    'recipients', v_recipients,
    'skipped', v_skipped,
    'cap_remaining', null  -- 5-B(C5-Q01)
  );
end;
$$;
revoke all on function public.internal_prepare_customer_line_job(uuid) from public, anon, authenticated;
grant execute on function public.internal_prepare_customer_line_job(uuid) to service_role;

-- C5-S05 第 5 步:回寫結果。p_outcome:sent / skipped / failed / retry / quota_exhausted。
create or replace function public.internal_finish_customer_line_job(p_outbox_id uuid, p_outcome text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  v_err text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
  v_until timestamptz;
  v_month_start timestamptz;
  v_skipped_others integer := 0;
begin
  if p_outcome not in ('sent', 'skipped', 'failed', 'retry', 'quota_exhausted') then
    raise exception '結果代碼不正確。' using errcode = '22023', hint = 'invalid_outcome';
  end if;
  select * into o from public.customer_line_outbox where id = p_outbox_id for update;
  if not found or o.status <> 'processing' then
    return jsonb_build_object('state', 'not_claimed');
  end if;

  if p_outcome = 'retry' then
    if o.attempts >= 3 then
      update public.customer_line_outbox set status = 'failed', last_error = v_err, processed_at = now(), claimed_at = null
      where id = o.id;
      return jsonb_build_object('state', 'failed');
    end if;
    update public.customer_line_outbox
    set status = 'pending', attempts = o.attempts + 1, last_error = v_err, claimed_at = null,
        send_after = now() + case o.attempts when 0 then interval '1 minute' when 1 then interval '5 minutes' else interval '15 minutes' end
    where id = o.id;
    return jsonb_build_object('state', 'retry');
  end if;

  if p_outcome = 'quota_exhausted' then
    -- 停發到下個月 1 日台北 00:00;這間店其他待發列全部略過;管理員鈴鐺(同月一則)。
    v_until := (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month') at time zone 'Asia/Taipei';
    v_month_start := date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
    insert into public.merchant_customer_line_settings (merchant_id, quota_blocked_until)
    values (o.merchant_id, v_until)
    on conflict (merchant_id) do update set quota_blocked_until = excluded.quota_blocked_until, updated_at = now();

    update public.customer_line_outbox
    set status = 'skipped', last_error = 'quota_exhausted', processed_at = now(), claimed_at = null
    where id = o.id;
    update public.customer_line_outbox x
    set status = 'skipped', last_error = 'quota_exhausted', processed_at = now()
    where x.merchant_id = o.merchant_id and x.status = 'pending' and x.id <> o.id;
    get diagnostics v_skipped_others = row_count;

    if not exists (
      select 1 from public.user_notifications n
      where n.merchant_id = o.merchant_id and n.event_type = 'line_quota_exhausted' and n.created_at >= v_month_start
    ) then
      insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
      select ma.user_id, o.merchant_id, 'admin', ma.id, 'line_quota_exhausted', null,
             'LINE 訊息額度已用完',
             'LINE 官方帳號本月訊息額度已用完，這個月的 LINE 通知(包含員工通知)都會發送失敗，下個月 1 日自動恢復。'
      from public.merchant_admins ma
      where ma.merchant_id = o.merchant_id and ma.user_id is not null;
    end if;
    return jsonb_build_object('state', 'quota_exhausted', 'skipped_others', v_skipped_others);
  end if;

  update public.customer_line_outbox
  set status = p_outcome, last_error = v_err, processed_at = now(), claimed_at = null
  where id = o.id;
  return jsonb_build_object('state', p_outcome);
end;
$$;
revoke all on function public.internal_finish_customer_line_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.internal_finish_customer_line_job(uuid, text, text) to service_role;

-- C5-F01 / F02:記好友狀態。比現有 changed_at 舊的事件不覆蓋(LINE 重送 / 亂序)⚠️。回 true = 有寫。
create or replace function public.internal_set_line_friendship(
  p_merchant_id uuid,
  p_line_user_id text,
  p_is_friend boolean,
  p_changed_at timestamptz,
  p_source text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_merchant_id is null or p_is_friend is null or p_changed_at is null
     or p_source is null or p_source not in ('webhook', 'login')
     or p_line_user_id is null or p_line_user_id !~ '^U[0-9a-f]{32}$' then
    return false;
  end if;
  if not exists (select 1 from public.merchants m where m.id = p_merchant_id) then
    return false;
  end if;
  insert into public.customer_line_friendships as f (merchant_id, line_user_id, is_friend, source, changed_at)
  values (p_merchant_id, p_line_user_id, p_is_friend, p_source, p_changed_at)
  on conflict (merchant_id, line_user_id) do update
    set is_friend = excluded.is_friend, source = excluded.source, changed_at = excluded.changed_at, updated_at = now()
    where f.changed_at <= excluded.changed_at;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.internal_set_line_friendship(uuid, text, boolean, timestamptz, text) from public, anon, authenticated;
grant execute on function public.internal_set_line_friendship(uuid, text, boolean, timestamptz, text) to service_role;

-- =========================================================================
-- ⑥ 客人端
-- =========================================================================

-- 這位聯絡人的「LINE 通知」狀態(只給自己;不回 LINE userId)。
create or replace function private.customer_notify_prefs_view(p_merchant_id uuid, p_contact_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c public.member_customer_contacts;
begin
  select * into c from public.member_customer_contacts x where x.id = p_contact_id and x.merchant_id = p_merchant_id;
  return jsonb_build_object(
    'state', 'ok',
    'available', private.customer_line_notify_available(p_merchant_id),
    'notify_booking', coalesce(c.notify_booking, true),
    'notify_promo', coalesce(c.notify_promo, true),
    'friend_status', private.customer_line_friend_status(p_merchant_id, private.customer_line_user_id_for(p_merchant_id, c.user_id)),
    'add_friend_url', private.customer_line_add_friend_url(p_merchant_id)
  );
end;
$$;
revoke all on function private.customer_notify_prefs_view(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.customer_get_notify_prefs(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  return private.customer_notify_prefs_view(v_ctx.merchant_id, v_ctx.contact_id);
end;
$$;
revoke all on function public.customer_get_notify_prefs(text) from public, anon, authenticated;
grant execute on function public.customer_get_notify_prefs(text) to authenticated;

create or replace function public.customer_set_notify_prefs(p_slug text, p_notify_booking boolean, p_notify_promo boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  -- 只改自己那列(身分由 auth.uid() + slug 推出,不收 contact_id);null = 不變。
  update public.member_customer_contacts c
  set notify_booking = coalesce(p_notify_booking, c.notify_booking),
      notify_promo = coalesce(p_notify_promo, c.notify_promo),
      notify_prefs_updated_at = now()
  where c.id = v_ctx.contact_id and c.user_id = v_uid and c.merchant_id = v_ctx.merchant_id and c.status = 'active'
    and (c.notify_booking is distinct from coalesce(p_notify_booking, c.notify_booking)
         or c.notify_promo is distinct from coalesce(p_notify_promo, c.notify_promo));
  return private.customer_notify_prefs_view(v_ctx.merchant_id, v_ctx.contact_id);
end;
$$;
revoke all on function public.customer_set_notify_prefs(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.customer_set_notify_prefs(text, boolean, boolean) to authenticated;

-- C5-M03:會員中心首頁多 line_notify(白名單)。
CREATE OR REPLACE FUNCTION public.customer_get_member_home(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_member public.members;
  v_now timestamptz := now();
  v_next public.bookings;
  v_count integer;
  v_points_enabled boolean;
  v_missing jsonb := '[]'::jsonb;
  v_prefs jsonb;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  select * into v_member from public.members where id = v_ctx.member_id;

  select * into v_next from public.bookings b
  where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
    and b.status not in ('completed', 'cancelled') and b.end_at >= v_now
  order by b.start_at, b.id
  limit 1;

  select count(*)::integer into v_count from public.bookings b
  where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
    and b.status not in ('completed', 'cancelled') and b.end_at >= v_now;

  select coalesce((
    select s.points_feature_enabled from public.merchant_member_settings s where s.merchant_id = v_ctx.merchant_id
  ), true) into v_points_enabled;

  if v_member.birthday is null then
    v_missing := v_missing || '["birthday"]'::jsonb;
  end if;
  if nullif(btrim(coalesce(v_member.email, '')), '') is null then
    v_missing := v_missing || '["email"]'::jsonb;
  end if;
  if nullif(btrim(coalesce(v_member.address, '')), '') is null then
    v_missing := v_missing || '["address"]'::jsonb;
  end if;

  -- 客戶端第 5 批 C5-M01:提示卡要的欄位(白名單)。
  v_prefs := private.customer_notify_prefs_view(v_ctx.merchant_id, v_ctx.contact_id);

  return jsonb_build_object(
    'state', 'ok',
    'member', jsonb_build_object('name', v_member.name, 'is_primary', v_ctx.is_primary, 'missing', v_missing),
    'next_booking', case when v_next.id is null then null else private.customer_booking_view(v_next, v_now) end,
    'upcoming_count', v_count,
    'wallet', jsonb_build_object(
      'points_enabled', v_points_enabled,
      'points_balance', case when v_points_enabled then v_member.points_balance else null end,
      'stored_value', null
    ),
    'pending_contact_requests', case when v_ctx.is_primary then (
      select count(*)::integer from public.member_contact_requests r
      where r.member_id = v_ctx.member_id and r.status = 'pending' and r.created_at > now() - interval '7 days'
    ) else 0 end,
    'line_notify', jsonb_build_object(
      'available', v_prefs -> 'available',
      'notify_booking', v_prefs -> 'notify_booking',
      'friend_status', v_prefs -> 'friend_status',
      'add_friend_url', v_prefs -> 'add_friend_url'
    )
  );
end;
$function$;

-- C5-M04:公開預約頁多 booking_settings.line_notify_available(白名單)。
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
  if v_merchant.status is distinct from 'active' then
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

-- C5-M04:會員預設完成頁文字(店家沒自訂時)。
create or replace function private.default_member_completion_message(p_merchant_id uuid, p_status text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_status = 'accepted' then
    return '服務前店家可能會再跟你聯絡確認。';
  end if;
  if private.customer_line_notify_available(p_merchant_id) and (private.customer_line_settings(p_merchant_id)).on_confirmed then
    return '店家確認後會用 LINE 通知你。';
  end if;
  return '店家確認後會通知你。';
end;
$$;
revoke all on function private.default_member_completion_message(uuid, text) from public, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION private.customer_booking_result(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- [c5] C5-M04:預設句改由 private.default_member_completion_message 決定(只有能用 LINE 通知時才說「用 LINE」)。
      else private.default_member_completion_message(v_b.merchant_id, v_b.status)
    end
  );
end;
$function$;

-- =========================================================================
-- ⑦ 後台
-- =========================================================================

-- C5-K01:拿掉 notify_member 那一段(其他段逐字不變;notify_member 欄位保留不 drop ⚠️)。
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

-- C5-K02 設定卡讀取的形狀。
create or replace function private.customer_line_settings_view(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.merchant_customer_line_settings;
  v_connected boolean;
  v_login boolean;
  v_on_site boolean;
begin
  s := private.customer_line_settings(p_merchant_id);
  select c.is_connected into v_connected from public.merchant_line_configs c where c.merchant_id = p_merchant_id;
  select c.enabled into v_login from public.merchant_line_login_configs c where c.merchant_id = p_merchant_id;
  select m.industry_type = 'on_site_dispatch' into v_on_site from public.merchants m where m.id = p_merchant_id;
  return jsonb_build_object(
    'connected', coalesce(v_connected, false),
    'line_login_enabled', coalesce(v_login, false),
    'is_on_site', coalesce(v_on_site, false),
    'is_admin', private.is_merchant_admin(p_merchant_id),
    'settings', jsonb_build_object(
      'on_submitted', s.on_submitted,
      'on_scheduled_by_store', s.on_scheduled_by_store,
      'on_confirmed', s.on_confirmed,
      'on_rescheduled', s.on_rescheduled,
      'on_cancelled_by_store', s.on_cancelled_by_store,
      'on_cancelled_by_customer', s.on_cancelled_by_customer,
      'on_reminder', s.on_reminder,
      'on_completed', s.on_completed,
      'on_contact_events', s.on_contact_events,
      'reminder_hours_before', s.reminder_hours_before,
      'monthly_cap', s.monthly_cap,
      'quota_blocked_until', s.quota_blocked_until,
      'updated_at', s.updated_at
    ),
    'templates', coalesce(s.templates, '{}'::jsonb),
    'default_templates', private.customer_line_default_templates(coalesce(v_on_site, false)),
    'template_codes', to_jsonb(private.customer_line_template_codes())
  );
end;
$$;
revoke all on function private.customer_line_settings_view(uuid) from public, anon, authenticated, service_role;

create or replace function public.get_customer_line_settings(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_merchant_id is null or not private.can_manage_line_notification(p_merchant_id) then
    raise exception '沒有權限管理這間商家的 LINE 通知設定。' using errcode = '42501', hint = 'forbidden';
  end if;
  return private.customer_line_settings_view(p_merchant_id);
end;
$$;
revoke all on function public.get_customer_line_settings(uuid) from public, anon, authenticated;
grant execute on function public.get_customer_line_settings(uuid) to authenticated;

create or replace function public.update_customer_line_settings(p_merchant_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.merchant_customer_line_settings;
  v_key text;
  v_val jsonb;
  v_code text;
  v_text jsonb;
  v_str text;
  v_templates jsonb;
  v_hours integer;
  v_flags constant text[] := array['on_submitted', 'on_scheduled_by_store', 'on_confirmed', 'on_rescheduled',
    'on_cancelled_by_store', 'on_cancelled_by_customer', 'on_reminder', 'on_completed', 'on_contact_events'];
begin
  if p_merchant_id is null or not private.can_manage_line_notification(p_merchant_id) then
    raise exception '沒有權限管理這間商家的 LINE 通知設定。' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception '設定內容格式不正確。' using errcode = '22023', hint = 'invalid_patch';
  end if;

  insert into public.merchant_customer_line_settings (merchant_id, updated_by_user_id)
  values (p_merchant_id, auth.uid())
  on conflict (merchant_id) do nothing;
  select * into s from public.merchant_customer_line_settings where merchant_id = p_merchant_id for update;
  v_templates := coalesce(s.templates, '{}'::jsonb);

  for v_key, v_val in select * from jsonb_each(p_patch) loop
    if v_key = any (v_flags) then
      if jsonb_typeof(v_val) <> 'boolean' then
        raise exception '設定內容格式不正確。' using errcode = '22023', hint = 'invalid_patch';
      end if;
      case v_key
        when 'on_submitted' then s.on_submitted := (v_val #>> '{}')::boolean;
        when 'on_scheduled_by_store' then s.on_scheduled_by_store := (v_val #>> '{}')::boolean;
        when 'on_confirmed' then s.on_confirmed := (v_val #>> '{}')::boolean;
        when 'on_rescheduled' then s.on_rescheduled := (v_val #>> '{}')::boolean;
        when 'on_cancelled_by_store' then s.on_cancelled_by_store := (v_val #>> '{}')::boolean;
        when 'on_cancelled_by_customer' then s.on_cancelled_by_customer := (v_val #>> '{}')::boolean;
        when 'on_reminder' then s.on_reminder := (v_val #>> '{}')::boolean;
        when 'on_completed' then s.on_completed := (v_val #>> '{}')::boolean;
        when 'on_contact_events' then s.on_contact_events := (v_val #>> '{}')::boolean;
      end case;
    elsif v_key = 'reminder_hours_before' then
      if jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}') !~ '^[0-9]+$' then
        raise exception '提醒時間只能選 2、3、6、12、24 或 48 小時。' using errcode = '22023', hint = 'reminder_hours_invalid';
      end if;
      v_hours := (v_val #>> '{}')::integer;
      if v_hours not in (2, 3, 6, 12, 24, 48) then
        raise exception '提醒時間只能選 2、3、6、12、24 或 48 小時。' using errcode = '22023', hint = 'reminder_hours_invalid';
      end if;
      s.reminder_hours_before := v_hours;
    elsif v_key = 'templates' then
      if jsonb_typeof(v_val) <> 'object' then
        raise exception '設定內容格式不正確。' using errcode = '22023', hint = 'invalid_patch';
      end if;
      for v_code, v_text in select * from jsonb_each(v_val) loop
        if not (v_code = any (private.customer_line_template_codes())) then
          raise exception '沒有這個通知文字。' using errcode = '22023', hint = 'template_code_invalid';
        end if;
        if jsonb_typeof(v_text) = 'null' then
          v_templates := v_templates - v_code;
        elsif jsonb_typeof(v_text) = 'string' then
          v_str := btrim(v_text #>> '{}');
          if v_str = '' then
            v_templates := v_templates - v_code;
          elsif char_length(v_str) > 500 then
            raise exception '通知文字不能超過 500 字。' using errcode = '22023', hint = 'template_too_long';
          else
            v_templates := v_templates || jsonb_build_object(v_code, v_str);
          end if;
        else
          raise exception '設定內容格式不正確。' using errcode = '22023', hint = 'invalid_patch';
        end if;
      end loop;
    else
      -- monthly_cap 也在這裡被擋(5-B 另一支只給管理員的函式)。
      raise exception '設定內容格式不正確。' using errcode = '22023', hint = 'invalid_patch';
    end if;
  end loop;

  update public.merchant_customer_line_settings
  set on_submitted = s.on_submitted,
      on_scheduled_by_store = s.on_scheduled_by_store,
      on_confirmed = s.on_confirmed,
      on_rescheduled = s.on_rescheduled,
      on_cancelled_by_store = s.on_cancelled_by_store,
      on_cancelled_by_customer = s.on_cancelled_by_customer,
      on_reminder = s.on_reminder,
      on_completed = s.on_completed,
      on_contact_events = s.on_contact_events,
      reminder_hours_before = s.reminder_hours_before,
      templates = v_templates,
      updated_by_user_id = auth.uid(),
      updated_at = now()
  where merchant_id = p_merchant_id;

  return private.customer_line_settings_view(p_merchant_id);
end;
$$;
revoke all on function public.update_customer_line_settings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.update_customer_line_settings(uuid, jsonb) to authenticated;

-- C5-K03:發送記錄多欄位 + 分類篩選。換簽章 ⇒ drop + create,revoke / grant 整組重寫(權限衛生規則 1)。
drop function if exists public.get_line_notification_log(uuid, text, integer, integer);
create or replace function public.get_line_notification_log(
  p_merchant_id uuid,
  p_event_type text default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_category text default null
)
returns table(
  id uuid,
  merchant_id uuid,
  event_type text,
  booking_id uuid,
  staff_leave_record_id uuid,
  target_type text,
  target_id uuid,
  target_line_user_id text,
  status text,
  skip_reason text,
  error_detail text,
  rendered_message text,
  attempted_at timestamptz,
  created_by_user_id uuid,
  target_user_id uuid,
  outbox_id uuid,
  target_member_name text,
  target_contact_display_name text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not private.can_manage_line_notification(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的 LINE 發送記錄' using errcode = '42501';
  end if;
  if p_category is not null and p_category not in ('customer', 'store', 'marketing', 'birthday') then
    raise exception '篩選分類不正確。' using errcode = '22023', hint = 'invalid_category';
  end if;

  return query
  select l.id, l.merchant_id, l.event_type, l.booking_id, l.staff_leave_record_id, l.target_type, l.target_id,
         -- 客戶端第 5 批:不給後台客人的 LINE userId。
         case when l.target_type = 'member' then null else l.target_line_user_id end,
         l.status, l.skip_reason, l.error_detail, l.rendered_message, l.attempted_at, l.created_by_user_id,
         l.target_user_id, l.outbox_id,
         case when l.target_type = 'member' then mm.name else null end,
         i.display_name
  from public.line_notification_log l
  left join public.members mm on l.target_type = 'member' and mm.id = l.target_id and mm.merchant_id = l.merchant_id
  left join public.customer_line_identities i on i.user_id = l.target_user_id
  where l.merchant_id = p_merchant_id
    and (p_event_type is null or l.event_type = p_event_type)
    and (p_category is null
         or (p_category = 'customer' and l.event_type like 'customer\_%')
         or (p_category = 'store' and l.event_type in ('booking_created', 'booking_confirmed', 'booking_cancelled', 'booking_completed', 'staff_leave_created'))
         or (p_category = 'marketing' and l.event_type = 'marketing_manual')
         or (p_category = 'birthday' and l.event_type = 'birthday_bonus'))
  order by l.attempted_at desc
  limit greatest(p_limit, 0)
  offset greatest(p_offset, 0);
end;
$$;
revoke all on function public.get_line_notification_log(uuid, text, integer, integer, text) from public, anon, authenticated;
grant execute on function public.get_line_notification_log(uuid, text, integer, integer, text) to authenticated, service_role;

-- C5-F03:聯絡人卡多好友狀態 + 兩個開關(唯讀;不回 LINE userId)。
CREATE OR REPLACE FUNCTION public.list_member_contacts(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found or not private.can_manage_members(v_member.merchant_id) then
    raise exception '沒有權限查看這位會員。' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'line_display_name', i.display_name,
               'line_picture_url', i.picture_url,
               'is_primary', c.is_primary,
               'contact_phone', c.contact_phone,
               'joined_via', c.joined_via,
               'joined_at', c.created_at,
               'last_login_at', i.last_login_at,
               -- [c5] C5-F03
               'line_friend_status', private.customer_line_friend_status(v_member.merchant_id, private.customer_line_user_id_for(v_member.merchant_id, c.user_id)),
               'notify_booking', c.notify_booking,
               'notify_promo', c.notify_promo
             ) order by c.is_primary desc, c.created_at, c.id)
      from public.member_customer_contacts c
      left join public.customer_line_identities i on i.user_id = c.user_id
      where c.member_id = p_member_id and c.status = 'active' and c.merchant_id = v_member.merchant_id
    ), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'line_display_name', i.display_name,
               'phone', r.phone_normalized,
               'created_at', r.created_at
             ) order by r.created_at, r.id)
      from public.member_contact_requests r
      left join public.customer_line_identities i on i.user_id = r.user_id
      where r.member_id = p_member_id and r.status = 'pending' and r.created_at > now() - interval '7 days'
    ), '[]'::jsonb),
    'relink_blocked', exists (select 1 from public.customer_member_link_blocks b where b.member_id = p_member_id),
    -- [c5] C5-F03:沒有聯絡人、用舊綁定碼綁過 LINE 的會員 ⇒ 顯示好友狀態。
    'legacy_line', case
      when v_member.line_bound and v_member.line_user_id is not null and not exists (
        select 1 from public.member_customer_contacts c2
        where c2.member_id = p_member_id and c2.status = 'active' and c2.merchant_id = v_member.merchant_id
      ) then jsonb_build_object('friend_status', private.customer_line_friend_status(v_member.merchant_id, v_member.line_user_id))
      else null end
  );
end;
$function$;

-- =========================================================================
-- ⑧ C5-S04 排程
-- =========================================================================
-- 每分鐘:有到期待發列、而且 Vault 有密鑰時才呼叫(省 Edge 次數;本機沒建密鑰 ⇒ 不呼叫)。
-- 密鑰「值」不出現在這份檔案;上線時主腦建立 Vault customer_line_cron_secret + Edge secret CUSTOMER_LINE_CRON_SECRET(同值)。
select
  cron.schedule(
    'customer-line-dispatch-every-minute',
    '* * * * *',
    $$
    select
      net.http_post(
        url := 'https://wjtbmmnakcriuaqoknsq.supabase.co/functions/v1/customer-line-notify-dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'customer_line_cron_secret')
        ),
        body := '{}'::jsonb
      ) as request_id
    where exists (select 1 from public.customer_line_outbox where status = 'pending' and send_after <= now())
      and exists (select 1 from vault.decrypted_secrets where name = 'customer_line_cron_secret');
    $$
  );

-- 待發清單清理:已結束超過 30 天刪除 ⚠️(純 SQL)。
select
  cron.schedule(
    'customer-line-outbox-prune-daily',
    '47 3 * * *',
    $$ delete from public.customer_line_outbox where status in ('sent', 'skipped', 'failed') and coalesce(processed_at, created_at) < now() - interval '30 days'; $$
  );
