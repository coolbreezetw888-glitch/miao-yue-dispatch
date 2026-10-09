-- 客戶端第 5-B 批(LINE 通知客人:費用與延伸)— 函式、trigger、排程
-- 規格:.project/specs/客戶端第5批-LINE通知與綁定.md(零之零定案優先;5-B = N07+N12 提醒、N08 完成、
--       N09~N11 聯絡人通知(S03)、Q01~Q04、P01、P02、K02 上限欄位;Q4 訪客 ⇒ 主要聯絡人)。
--
-- 內容:
--   ① C5-N08 bookings trigger 加「服務完成」(tg_bookings_enqueue_customer_line 換新版本;其他判斷逐字不變)
--   ② C5-N12 服務前提醒排程(每 10 分鐘,純 SQL;22:00~08:00 不寫)
--   ③ C5-S03 聯絡人函式各加一句 enqueue(申請 / 被移除 / 申請結果)+ 聯絡人通知的收件人與變數
--   ④ C5-S05 internal_prepare_customer_line_job 換新版本:不再把 5-B 種類標 skipped;C5-Q01 每月上限
--   ⑤ C5-K02 每月上限(只有管理員)、C5-Q02 本月用量、C5-Q04 80% 鈴鐺
--   ⑥ C5-P01 行銷收件人(候選 / 預覽則數)、C5-P02 生日禮只看主要聯絡人的「優惠通知」
--
-- 不改的函式(指紋不變):create_booking、update_booking、move_booking、confirm_booking、staff_confirm_booking、
-- cancel_booking、staff_cancel_booking、complete_booking、revert_completed_booking、internal_customer_submit_booking、
-- internal_customer_cancel_booking、update_booking_payment_method、check_customer_booking_slot、member_sync_primary、
-- customer_member_of、consume_line_binding_code、render_booking_notification_variables;
-- 5-A 的 enqueue_customer_line、resolve_customer_line_recipients、customer_line_booking_variables、
-- internal_finish_customer_line_job、cancel_completed_booking 也不改。
-- 新函式一律 plpgsql(skill 已知坑:會被交易內刪索引的測試打到的輔助函式不要寫成可內聯的 SQL 函式)。

-- =========================================================================
-- ① C5-N08 bookings trigger:多「服務完成」
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
      -- 狀態一變:同一張單還沒發的提醒列作廢(提醒排程會依新狀態重新判斷)。
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
      elsif new.status = 'completed' and new.member_id is not null
            -- QA #3:完成 → 還原 → 再完成不重複謝謝光臨:這張單已有待發 / 發送中 / 已發的「服務完成」就不再寫
            --       (比照提醒用待發清單歷史判斷;被判過時略過、或發送失敗的不算)。
            and not exists (
              select 1 from public.customer_line_outbox o
              where o.booking_id = new.id and o.kind = 'customer_completed'
                and o.status in ('pending', 'processing', 'sent')) then
        -- [c5b] C5-N08 ⚠️範圍:服務完成(不論誰按完成;店家「服務完成」通知預設關)。
        perform private.enqueue_customer_line('customer_completed', new.merchant_id, new.id, new.member_id, v_actor,
          jsonb_build_object('actor_kind', v_actor_kind), now(), 'completed:' || new.id);
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

-- =========================================================================
-- ② C5-N12 服務前提醒排程(C5-N07)
-- =========================================================================
-- 範圍:已接上官方帳號、「服務前提醒」開著、沒有停發的店;已確認、有會員、不是匯入的單;
--       開始前 N 小時 <= 現在 <= 開始前 1 小時;訂單建立時間早於「開始前 N 小時」(剛約的單不提醒)⚠️。
-- 深夜不寫 ⚠️:台北 22:00~08:00 這段時間整支直接結束;08:00 之後還在範圍內的單才寫。
-- 去重:dedupe_key = 'reminder:<訂單>:<開始時間 UTC>';同一張單同一個開始時間只提醒一次 ——
--       用 customer_line_outbox 既有的列判斷(除了被作廢 skipped/stale 的,任何狀態都算;待發清單保留 30 天,提醒範圍最多 48 小時,足夠)。
--       改了時間 ⇒ key 不同 ⇒ 會再提醒一次新時間。
-- p_now 只給 pgTAP 用固定時間測(鐵律 10:測試入口放 private,不開給任何角色)。
create or replace function private.enqueue_customer_line_reminders_at(p_now timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hour integer := extract(hour from (p_now at time zone 'Asia/Taipei'))::integer;
  r record;
  v_key text;
  v_count integer := 0;
begin
  if p_now is null or v_hour >= 22 or v_hour < 8 then
    return 0;
  end if;

  for r in
    select b.id, b.merchant_id, b.member_id, b.start_at
    from public.merchant_customer_line_settings s
    join public.merchant_line_configs c on c.merchant_id = s.merchant_id and c.is_connected
    join public.bookings b on b.merchant_id = s.merchant_id
    where s.on_reminder
      and (s.quota_blocked_until is null or s.quota_blocked_until <= p_now)
      and b.status = 'accepted'
      and b.member_id is not null
      and b.source <> 'import'
      and b.start_at >= p_now + interval '1 hour'  -- 離服務還有 1 小時以上(含剛好 1 小時,Q2=A「1 小時以上」)
      and b.start_at <= p_now + make_interval(hours => s.reminder_hours_before)
      and b.created_at < b.start_at - make_interval(hours => s.reminder_hours_before)
    order by b.start_at, b.id
  loop
    v_key := 'reminder:' || r.id || ':' || to_char(r.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    if exists (
      select 1 from public.customer_line_outbox o
      where o.booking_id = r.id and o.kind = 'customer_reminder' and o.dedupe_key = v_key
        -- QA #4 / R1:只有「被作廢」的列不算(status = skipped 且 last_error = 'stale',兩個來源都寫這個字串:
        --   trigger 狀態一變時作廢、Edge 判定過時後 internal_finish_customer_line_job(...,'skipped','stale'))。
        --   其他結束狀態(收件人全被略過、店家關提醒、額度用完、上限、推播 4xx 失敗…)都算已經提醒過,
        --   否則每 10 分鐘會重寫一次、4xx 的單還會一直重推。
        and not (o.status = 'skipped' and o.last_error is not distinct from 'stale')
    ) then
      continue;
    end if;
    perform private.enqueue_customer_line('customer_reminder', r.merchant_id, r.id, r.member_id, null,
      jsonb_build_object('start_at', r.start_at), p_now, v_key);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function private.enqueue_customer_line_reminders_at(timestamptz) from public, anon, authenticated, service_role;

create or replace function private.enqueue_customer_line_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  return private.enqueue_customer_line_reminders_at(now());
end;
$$;
revoke all on function private.enqueue_customer_line_reminders() from public, anon, authenticated, service_role;

-- =========================================================================
-- ③ C5-S03 聯絡人通知
-- =========================================================================

-- 聯絡人事件(N09~N11)的收件人(發送當下才算;開關一律看「預約通知」⚠️)。
--   N09 contact_request   ⇒ 這位會員的主要聯絡人(舊綁定碼會員沒有會員中心,不發)
--   N10 contact_removed   ⇒ 被移除的那位(開關看他被移除前那一列)
--   N11 request_resolved  ⇒ 申請人(同意 ⇒ 看他新的聯絡人列;拒絕 ⇒ 他在這間店沒有聯絡人列時視為開著)
create or replace function private.resolve_customer_line_contact_recipients(p_outbox_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  v_member_id uuid;
  v_user uuid;
  v_notify boolean;
  v_to text;
  v_skip text;
begin
  select * into o from public.customer_line_outbox where id = p_outbox_id;
  if not found then
    return jsonb_build_object('recipients', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  select m.id into v_member_id from public.members m where m.id = o.member_id and m.merchant_id = o.merchant_id;
  if v_member_id is null then
    return jsonb_build_object('recipients', '[]'::jsonb,
      'skipped', jsonb_build_array(jsonb_build_object('target_type', 'member', 'target_id', null, 'target_user_id', null, 'reason', 'no_target')));
  end if;

  if o.kind = 'customer_contact_request' then
    select c.user_id, c.notify_booking into v_user, v_notify
    from public.member_customer_contacts c
    where c.member_id = v_member_id and c.merchant_id = o.merchant_id and c.status = 'active' and c.is_primary
    limit 1;
  elsif o.kind = 'customer_contact_removed' then
    v_user := o.subject_user_id;
    select c.notify_booking into v_notify
    from public.member_customer_contacts c
    where c.id = nullif(o.payload ->> 'contact_id', '')::uuid and c.user_id = v_user and c.merchant_id = o.merchant_id;
  elsif o.kind = 'customer_contact_request_resolved' then
    v_user := o.subject_user_id;
    select c.notify_booking into v_notify
    from public.member_customer_contacts c
    where c.merchant_id = o.merchant_id and c.user_id = v_user and c.status = 'active'
    order by c.created_at desc, c.id
    limit 1;
  else
    return jsonb_build_object('recipients', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;

  if v_user is null then
    v_skip := 'target_not_bound';
  elsif not coalesce(v_notify, true) then
    v_skip := 'customer_opted_out';
  else
    v_to := private.customer_line_user_id_for(o.merchant_id, v_user);
    if v_to is null then
      v_skip := 'target_not_bound';
    elsif private.customer_line_friend_status(o.merchant_id, v_to) = 'not_friend' then
      v_skip := 'not_friend';
    end if;
  end if;

  if v_skip is not null then
    return jsonb_build_object('recipients', '[]'::jsonb,
      'skipped', jsonb_build_array(jsonb_build_object('target_type', 'member', 'target_id', v_member_id, 'target_user_id', v_user, 'reason', v_skip)));
  end if;
  return jsonb_build_object(
    'recipients', jsonb_build_array(jsonb_build_object(
      'to', v_to, 'target_type', 'member', 'target_id', v_member_id, 'target_user_id', v_user, 'contact_id', null)),
    'skipped', '[]'::jsonb);
end;
$$;
revoke all on function private.resolve_customer_line_contact_recipients(uuid) from public, anon, authenticated, service_role;

-- 聯絡人事件的範本變數(預約類變數一律空字串;不提供金額 / 地址 / 服務人員資料)。
-- contact_name:N09 = 申請人的 LINE 顯示名(拿不到 ⇒「有一位客人」);其他事件用不到,給空字串。
create or replace function private.customer_line_contact_variables(p_outbox_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  v_merchant public.merchants;
  v_member_name text;
  v_contact text;
begin
  select * into o from public.customer_line_outbox where id = p_outbox_id;
  select * into v_merchant from public.merchants where id = o.merchant_id;
  select mm.name into v_member_name from public.members mm where mm.id = o.member_id and mm.merchant_id = o.merchant_id;
  if o.kind = 'customer_contact_request' then
    select nullif(btrim(i.display_name), '') into v_contact
    from public.customer_line_identities i where i.user_id = o.subject_user_id;
    v_contact := coalesce(v_contact, '有一位客人');
  end if;
  return jsonb_build_object(
    'member_name', coalesce(v_member_name, ''),
    'merchant_name', coalesce(v_merchant.name, ''),
    'booking_date', '',
    'booking_time', '',
    'old_booking_date', '',
    'old_booking_time', '',
    'service_items', '',
    'staff_name', '',
    'merchant_phone', coalesce(btrim(v_merchant.phone), ''),
    'contact_name', coalesce(v_contact, '')
  );
end;
$$;
revoke all on function private.customer_line_contact_variables(uuid) from public, anon, authenticated, service_role;

-- ── N09:有人送出「加入聯絡人」申請 ⇒ 通知主要聯絡人(只多最後一句 perform)──
create or replace function private.member_contact_request_create(p_member_id uuid, p_user_id uuid, p_phone_normalized text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id for update;

  if exists (
    select 1 from public.member_contact_requests r
    where r.merchant_id = v_merchant_id and r.user_id = p_user_id and r.status = 'pending'
      and r.member_id = p_member_id and r.phone_normalized = p_phone_normalized
      and r.created_at > now() - interval '7 days'
  ) then
    return 'join_pending';
  end if;

  update public.member_contact_requests
     set status = case when created_at > now() - interval '7 days' then 'cancelled' else 'expired' end,
         resolved_at = now(),
         resolved_by_role = case when created_at > now() - interval '7 days' then 'customer' else 'system' end,
         resolved_by_user_id = case when created_at > now() - interval '7 days' then p_user_id else null end
   where merchant_id = v_merchant_id and user_id = p_user_id and status = 'pending';

  if (select count(*) from public.member_contact_requests r
      where r.member_id = p_member_id and r.status = 'pending' and r.created_at > now() - interval '7 days') >= 5 then
    return 'phone_taken';
  end if;

  insert into public.member_contact_requests (merchant_id, member_id, user_id, phone_normalized)
  values (v_merchant_id, p_member_id, p_user_id, p_phone_normalized);
  perform private.notify_member_contact_request(p_member_id);
  perform private.enqueue_customer_line('customer_contact_request', v_merchant_id, null, p_member_id, p_user_id, '{}'::jsonb, now(), 'contact_request:' || p_member_id || ':' || p_user_id);
  return 'join_pending';
end;
$$;
revoke execute on function private.member_contact_request_create(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.member_contact_request_create(uuid, uuid, text) to service_role;

-- ── N11 ⚠️範圍:申請被同意 / 拒絕 ⇒ 通知申請人(拒絕、同意各多一句 perform;「早就是聯絡人」那條不發)──
create or replace function private.resolve_contact_request(
  p_request_id uuid, p_scope_member_id uuid, p_approve boolean, p_actor uuid, p_role text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_r public.member_contact_requests;
  v_member public.members;
  v_existing uuid;
  v_phone text;
  v_has_primary boolean;
begin
  select * into v_r from public.member_contact_requests where id = p_request_id;
  if not found or (p_scope_member_id is not null and v_r.member_id <> p_scope_member_id) then
    return jsonb_build_object('state', 'not_found');
  end if;

  perform private.contact_user_lock(v_r.merchant_id, v_r.user_id);
  select * into v_member from public.members where id = v_r.member_id for update;
  select * into v_r from public.member_contact_requests where id = p_request_id for update;

  if v_r.status <> 'pending' then
    return jsonb_build_object('state', 'not_found');
  end if;
  if v_r.created_at <= now() - interval '7 days' or v_member.status <> 'active' or v_member.merchant_id <> v_r.merchant_id then
    update public.member_contact_requests
       set status = 'expired', resolved_at = now(), resolved_by_role = 'system'
     where id = p_request_id;
    return jsonb_build_object('state', 'not_found');
  end if;

  if not coalesce(p_approve, false) then
    update public.member_contact_requests
       set status = 'rejected', resolved_at = now(), resolved_by_user_id = p_actor, resolved_by_role = p_role
     where id = p_request_id;
    perform private.enqueue_customer_line('customer_contact_request_resolved', v_r.merchant_id, null, v_r.member_id, v_r.user_id, jsonb_build_object('approved', false, 'request_id', v_r.id), now(), 'contact_resolved:' || v_r.id);
    return jsonb_build_object('state', 'rejected');
  end if;

  select c.member_id into v_existing from private.customer_member_of(v_r.merchant_id, v_r.user_id) c;
  if v_existing is not null and v_existing <> v_r.member_id then
    return jsonb_build_object('state', 'already_member_elsewhere');
  end if;
  if v_existing = v_r.member_id then
    update public.member_contact_requests
       set status = 'approved', resolved_at = now(), resolved_by_user_id = p_actor, resolved_by_role = p_role
     where id = p_request_id;
    return jsonb_build_object('state', 'approved');
  end if;

  if (select count(*) from public.member_customer_contacts c
      where c.member_id = v_r.member_id and c.status = 'active') >= 10 then
    return jsonb_build_object('state', 'contact_limit');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_r.merchant_id::text || ':' || v_r.phone_normalized, 0));
  v_phone := v_r.phone_normalized;
  if v_phone = private.normalize_phone(v_member.phone)
     or private.phone_in_use_elsewhere(v_r.merchant_id, v_phone, v_r.member_id) then
    v_phone := null;
  end if;

  v_has_primary := exists (
    select 1 from public.member_customer_contacts c
    where c.member_id = v_r.member_id and c.is_primary and c.status = 'active'
  );
  update public.member_contact_requests
     set status = 'approved', resolved_at = now(), resolved_by_user_id = p_actor, resolved_by_role = p_role
   where id = p_request_id;
  perform private.member_contact_add(v_r.member_id, v_r.user_id, not v_has_primary, 'request', v_phone);
  perform private.notify_member_contact_joined(v_r.member_id, v_r.user_id);
  perform private.enqueue_customer_line('customer_contact_request_resolved', v_r.merchant_id, null, v_r.member_id, v_r.user_id, jsonb_build_object('approved', true, 'request_id', v_r.id), now(), 'contact_resolved:' || v_r.id);
  return jsonb_build_object('state', 'approved');
end;
$$;
revoke execute on function private.resolve_contact_request(uuid, uuid, boolean, uuid, text) from public, anon, authenticated;
grant execute on function private.resolve_contact_request(uuid, uuid, boolean, uuid, text) to service_role;

-- ── N10:主要聯絡人移除第二聯絡人 ⇒ 通知被移除的人(只多一句 perform)──
create or replace function public.customer_remove_contact(p_slug text, p_contact_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_c public.member_customer_contacts;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  if not v_ctx.is_primary then
    raise exception '只有主要聯絡人可以管理聯絡人。' using errcode = '22023', hint = 'not_primary';
  end if;
  perform 1 from public.members where id = v_ctx.member_id for update;
  select * into v_c from public.member_customer_contacts
  where id = p_contact_id and member_id = v_ctx.member_id and status = 'active' and not is_primary
  for update;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;
  perform private.member_contact_remove(v_c.id, v_uid, 'primary', true);
  perform private.enqueue_customer_line('customer_contact_removed', v_c.merchant_id, null, v_c.member_id, v_c.user_id, jsonb_build_object('contact_id', v_c.id, 'removed_via', 'primary'), now(), 'contact_removed:' || v_c.id);
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.customer_remove_contact(text, uuid) from public, anon, authenticated;
grant execute on function public.customer_remove_contact(text, uuid) to authenticated;

-- ── N10:店家移除聯絡人 ⇒ 通知被移除的人(主要 / 第二聯絡人兩條路最後共用一句 perform)──
create or replace function public.merchant_remove_member_contact(p_contact_id uuid, p_new_primary_contact_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.member_customer_contacts;
  v_merchant_id uuid;
  v_new uuid;
  v_has_others boolean;
begin
  select * into v_c from public.member_customer_contacts where id = p_contact_id;
  select m.merchant_id into v_merchant_id from public.members m where m.id = v_c.member_id;
  if v_merchant_id is null or not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這位會員。' using errcode = '42501';
  end if;
  perform 1 from public.members where id = v_c.member_id for update;
  select * into v_c from public.member_customer_contacts where id = p_contact_id;
  if v_c.status <> 'active' or v_c.merchant_id <> v_merchant_id then
    return jsonb_build_object('state', 'not_found');
  end if;

  if v_c.is_primary then
    v_has_others := exists (
      select 1 from public.member_customer_contacts c
      where c.member_id = v_c.member_id and c.status = 'active' and c.id <> v_c.id
    );
    if v_has_others then
      if p_new_primary_contact_id is null then
        return jsonb_build_object('state', 'need_new_primary');
      end if;
      select c.id into v_new from public.member_customer_contacts c
      where c.id = p_new_primary_contact_id and c.member_id = v_c.member_id and c.status = 'active' and c.id <> v_c.id;
      if v_new is null then
        return jsonb_build_object('state', 'not_found');
      end if;
    end if;
    perform private.member_contact_remove(v_c.id, auth.uid(), 'store', true);
    if v_new is not null then
      update public.member_customer_contacts set is_primary = true, contact_phone = null where id = v_new;
    end if;
    perform private.member_sync_primary(v_c.member_id);
  else
    perform private.member_contact_remove(v_c.id, auth.uid(), 'store', true);
  end if;
  perform private.enqueue_customer_line('customer_contact_removed', v_c.merchant_id, null, v_c.member_id, v_c.user_id, jsonb_build_object('contact_id', v_c.id, 'removed_via', 'store'), now(), 'contact_removed:' || v_c.id);
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.merchant_remove_member_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merchant_remove_member_contact(uuid, uuid) to authenticated;

-- =========================================================================
-- ④ C5-S05 第 2 步(新版本):5-B 種類照常準備;C5-Q01 每月上限
-- =========================================================================
-- 這間店本月(台北時間)已成功發給客人的則數(只算 customer_*;店家 / 員工、行銷、生日不算)。
create or replace function private.customer_line_month_sent(p_merchant_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
  v integer;
begin
  select count(*)::integer into v
  from public.line_notification_log l
  where l.merchant_id = p_merchant_id
    and l.attempted_at >= v_month_start
    and l.event_type like 'customer\_%'
    and l.status = 'sent';
  return coalesce(v, 0);
end;
$$;
revoke all on function private.customer_line_month_sent(uuid) from public, anon, authenticated, service_role;

-- 回 state:send / stale / superseded / skip(安靜結束,不寫記錄)/ not_claimed。
-- 回應多 cap_remaining:店家有設每月上限時 = 這一則準備時還剩幾則(超過的收件人已移到 skipped / monthly_cap);沒設 ⇒ null。
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
  v_is_store boolean;
  v_is_contact boolean;
  v_store_event text;
  v_resolved jsonb;
  v_recipients jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_template text;
  v_template_code text;
  v_variables jsonb := '{}'::jsonb;
  v_blocked boolean;
  v_base jsonb;
  v_remaining integer;
  v_days integer;
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
  v_is_contact := o.kind in ('customer_contact_request', 'customer_contact_removed', 'customer_contact_request_resolved');
  s := private.customer_line_settings(o.merchant_id);

  -- 客人那 3 分鐘內店家把那種通知關掉了 ⇒ 安靜結束。
  if not v_is_store and not private.customer_line_kind_enabled(s, o.kind) then
    return v_base || jsonb_build_object('state', 'skip', 'reason', 'event_disabled');
  end if;

  -- 建立超過 6 小時還沒發 ⇒ 過時(提醒除外;提醒另外看開始時間)⚠️。
  if o.kind <> 'customer_reminder' and o.created_at < now() - interval '6 hours' then
    return v_base || jsonb_build_object('state', 'stale', 'reason', 'stale');
  end if;

  select * into v_merchant from public.merchants where id = o.merchant_id;

  if v_is_contact then
    -- [c5b] C5-N09~N11:聯絡人事件沒有訂單。
    if not exists (select 1 from public.members m where m.id = o.member_id and m.merchant_id = o.merchant_id) then
      return v_base || jsonb_build_object('state', 'skip', 'reason', 'no_member');
    end if;
    -- 申請通知:發送時申請已經被處理 / 取消 / 過期 ⇒ 過時。
    if o.kind = 'customer_contact_request' and not exists (
      select 1 from public.member_contact_requests r
      where r.member_id = o.member_id and r.merchant_id = o.merchant_id and r.user_id = o.subject_user_id
        and r.status = 'pending' and r.created_at > now() - interval '7 days'
    ) then
      return v_base || jsonb_build_object('state', 'stale', 'reason', 'stale');
    end if;
    v_resolved := private.resolve_customer_line_contact_recipients(o.id);
    v_recipients := coalesce(v_resolved -> 'recipients', '[]'::jsonb);
    v_skipped := coalesce(v_resolved -> 'skipped', '[]'::jsonb);
    v_template_code := case o.kind
      when 'customer_contact_request' then 'contact_request'
      when 'customer_contact_removed' then 'contact_removed'
      else case when coalesce((o.payload ->> 'approved')::boolean, false) then 'contact_approved' else 'contact_rejected' end
    end;
    v_template := coalesce(
      nullif(btrim(s.templates ->> v_template_code), ''),
      private.customer_line_default_templates(v_merchant.industry_type = 'on_site_dispatch') ->> v_template_code
    );
    v_variables := private.customer_line_contact_variables(o.id);
  else
    select * into b from public.bookings where id = o.booking_id and merchant_id = o.merchant_id;
    if not found then
      return v_base || jsonb_build_object('state', 'skip', 'reason', 'no_booking');
    end if;

    -- 過時判斷(C5-S05 第 2 點)。
    if (o.kind in ('customer_submitted', 'customer_scheduled_by_store') and b.status in ('cancelled', 'completed'))
       or (o.kind = 'customer_confirmed' and b.status <> 'accepted')
       or (o.kind = 'customer_rescheduled' and b.status in ('cancelled', 'completed'))
       or (o.kind in ('customer_cancelled_by_store', 'customer_cancelled_by_customer', 'store_booking_cancelled') and b.status <> 'cancelled')
       -- [c5b] N08:完成之後又被還原 / 取消 ⇒ 不發。
       or (o.kind = 'customer_completed' and b.status <> 'completed')
       -- [c5b] N07:提醒時狀態不是已確認、開始時間變了、或已經開始 ⇒ 不發。
       or (o.kind = 'customer_reminder' and (
             b.status <> 'accepted'
             or b.start_at is distinct from nullif(o.payload ->> 'start_at', '')::timestamptz
             or now() >= b.start_at)) then
      return v_base || jsonb_build_object('state', 'stale', 'reason', 'stale');
    end if;
    if o.kind = 'customer_rescheduled'
       and b.start_at = nullif(o.payload ->> 'old_start_at', '')::timestamptz then
      return v_base || jsonb_build_object('state', 'superseded', 'reason', 'superseded');
    end if;

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
      -- C5-R01:預約類收件人(訪客單只通知主要聯絡人 = Q4=A,在 resolve_customer_line_recipients 裡)。
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
        when 'customer_reminder' then 'reminder'
        when 'customer_completed' then 'completed'
      end;
      v_template := coalesce(
        nullif(btrim(s.templates ->> v_template_code), ''),
        private.customer_line_default_templates(v_merchant.industry_type = 'on_site_dispatch') ->> v_template_code
      );
      v_variables := private.customer_line_booking_variables(o.id);
      if o.kind = 'customer_reminder' then
        -- {{booking_day_word}}:發送當下(台北)跟服務日期差幾天 ⇒ 今天 / 明天 / 後天,再遠就寫日期(N=48 小時用得到)⚠️。
        v_days := (b.start_at at time zone 'Asia/Taipei')::date - (now() at time zone 'Asia/Taipei')::date;
        v_variables := v_variables || jsonb_build_object('booking_day_word', case v_days
          when 0 then '今天' when 1 then '明天' when 2 then '後天'
          else private.customer_line_format_date(b.start_at) end);
      end if;
    end if;
  end if;

  -- 重試時:已經寫過記錄的對象不再處理(冪等;sent / failed / skipped 都算)。先做這步,上限才不會把自己算兩次。
  -- 一律保留原本順序(主要聯絡人在前),上限截斷才會截到後面的人。
  select coalesce(jsonb_agg(r order by n), '[]'::jsonb) into v_recipients
  from jsonb_array_elements(v_recipients) with ordinality as x(r, n)
  where not exists (
    select 1 from public.line_notification_log l
    where l.outbox_id = o.id
      and l.target_type = r ->> 'target_type'
      and l.target_id is not distinct from nullif(r ->> 'target_id', '')::uuid
      and l.target_user_id is not distinct from nullif(r ->> 'target_user_id', '')::uuid
  );
  select coalesce(jsonb_agg(r order by n), '[]'::jsonb) into v_skipped
  from jsonb_array_elements(v_skipped) with ordinality as x(r, n)
  where not exists (
    select 1 from public.line_notification_log l
    where l.outbox_id = o.id
      and l.target_type = r ->> 'target_type'
      and l.target_id is not distinct from nullif(r ->> 'target_id', '')::uuid
      and l.target_user_id is not distinct from nullif(r ->> 'target_user_id', '')::uuid
  );

  -- 額度用完停發中 ⇒ 每位收件人都略過(quota_exhausted)。
  v_blocked := s.quota_blocked_until is not null and s.quota_blocked_until > now();
  if v_blocked then
    select v_skipped || coalesce(jsonb_agg(r - 'to' - 'contact_id' || jsonb_build_object('reason', 'quota_exhausted') order by n), '[]'::jsonb)
    into v_skipped from jsonb_array_elements(v_recipients) with ordinality as x(r, n);
    v_recipients := '[]'::jsonb;
  end if;

  -- [c5b] C5-Q01:店家設了「每月客人通知上限」⇒ 本月已發到上限,剩下的收件人略過(monthly_cap)。只管客人通知。
  if not v_is_store and s.monthly_cap is not null then
    v_remaining := greatest(s.monthly_cap - private.customer_line_month_sent(o.merchant_id), 0);
    if jsonb_array_length(v_recipients) > v_remaining then
      select v_skipped || coalesce(jsonb_agg(r - 'to' - 'contact_id' || jsonb_build_object('reason', 'monthly_cap') order by n), '[]'::jsonb)
      into v_skipped
      from jsonb_array_elements(v_recipients) with ordinality as x(r, n)
      where n > v_remaining;
      select coalesce(jsonb_agg(r order by n), '[]'::jsonb)
      into v_recipients
      from jsonb_array_elements(v_recipients) with ordinality as x(r, n)
      where n <= v_remaining;
    end if;
  end if;

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
    'cap_remaining', v_remaining
  );
end;
$$;
revoke all on function public.internal_prepare_customer_line_job(uuid) from public, anon, authenticated;
grant execute on function public.internal_prepare_customer_line_job(uuid) to service_role;

-- =========================================================================
-- ⑤ C5-K02 每月上限 / C5-Q02 本月用量 / C5-Q04 80% 鈴鐺
-- =========================================================================

-- C5-K02:每月客人通知上限(牽涉花錢 ⇒ 只有管理員)⚠️。null = 不設上限(Q3=A 預設)。回同 get_customer_line_settings。
create or replace function public.set_customer_line_monthly_cap(p_merchant_id uuid, p_monthly_cap integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_merchant_id is null or not private.is_merchant_admin(p_merchant_id) then
    raise exception '只有商家管理員可以設定每月客人通知上限。' using errcode = '42501', hint = 'forbidden';
  end if;
  if p_monthly_cap is not null and (p_monthly_cap < 1 or p_monthly_cap > 100000) then
    raise exception '每月上限請填 1 到 100000 之間的整數，或留空代表不限制。' using errcode = '22023', hint = 'monthly_cap_invalid';
  end if;
  insert into public.merchant_customer_line_settings as s (merchant_id, monthly_cap, updated_by_user_id)
  values (p_merchant_id, p_monthly_cap, auth.uid())
  on conflict (merchant_id) do update
    set monthly_cap = excluded.monthly_cap, updated_by_user_id = excluded.updated_by_user_id, updated_at = now();
  return private.customer_line_settings_view(p_merchant_id);
end;
$$;
revoke all on function public.set_customer_line_monthly_cap(uuid, integer) from public, anon, authenticated;
grant execute on function public.set_customer_line_monthly_cap(uuid, integer) to authenticated;

-- C5-Q02:本店本月(台北)LINE 發送統計(本系統記錄;LINE 官方帳號的額度由 Edge line-quota-status 另外查)。
-- 權限同「LINE 通知事件」頁。不回任何 token / LINE userId。
create or replace function public.get_customer_line_usage(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
  s public.merchant_customer_line_settings;
  v_connected boolean;
  v_customer integer;
  v_store integer;
  v_marketing integer;
  v_birthday integer;
begin
  if p_merchant_id is null or not private.can_manage_line_notification(p_merchant_id) then
    raise exception '沒有權限管理這間商家的 LINE 通知設定。' using errcode = '42501', hint = 'forbidden';
  end if;
  s := private.customer_line_settings(p_merchant_id);
  select c.is_connected into v_connected from public.merchant_line_configs c where c.merchant_id = p_merchant_id;
  select
    count(*) filter (where l.event_type like 'customer\_%')::integer,
    count(*) filter (where l.event_type in ('booking_created', 'booking_confirmed', 'booking_cancelled', 'booking_completed', 'staff_leave_created'))::integer,
    count(*) filter (where l.event_type = 'marketing_manual')::integer,
    count(*) filter (where l.event_type = 'birthday_bonus')::integer
  into v_customer, v_store, v_marketing, v_birthday
  from public.line_notification_log l
  where l.merchant_id = p_merchant_id and l.attempted_at >= v_month_start and l.status = 'sent';
  return jsonb_build_object(
    'connected', coalesce(v_connected, false),
    'month', to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM'),
    'by_category', jsonb_build_object(
      'customer', coalesce(v_customer, 0),
      'store', coalesce(v_store, 0),
      'marketing', coalesce(v_marketing, 0),
      'birthday', coalesce(v_birthday, 0)
    ),
    'total_sent', coalesce(v_customer, 0) + coalesce(v_store, 0) + coalesce(v_marketing, 0) + coalesce(v_birthday, 0),
    'cap', s.monthly_cap,
    'blocked_until', case when s.quota_blocked_until > now() then s.quota_blocked_until else null end
  );
end;
$$;
revoke all on function public.get_customer_line_usage(uuid) from public, anon, authenticated;
grant execute on function public.get_customer_line_usage(uuid) to authenticated;

-- C5-Q04:這間店現在要不要查 LINE 額度(每店每小時最多一次 ⚠️)。要 ⇒ 順手記下時間並回 true。
create or replace function public.internal_line_quota_check_due(p_merchant_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_merchant_id is null or not exists (select 1 from public.merchants m where m.id = p_merchant_id) then
    return false;
  end if;
  insert into public.merchant_customer_line_settings (merchant_id) values (p_merchant_id)
  on conflict (merchant_id) do nothing;
  update public.merchant_customer_line_settings
  set quota_checked_at = now()
  where merchant_id = p_merchant_id
    and (quota_checked_at is null or quota_checked_at < now() - interval '1 hour');
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;
revoke all on function public.internal_line_quota_check_due(uuid) from public, anon, authenticated;
grant execute on function public.internal_line_quota_check_due(uuid) to service_role;

-- C5-Q04 ⚠️範圍 第 5 點:LINE 額度用到 80% ⇒ 該店管理員鈴鐺(客服不收 ⚠️);同月一則(本月已發過「用完」也不再發)。
-- 回 true = 這次有發。
create or replace function public.internal_line_quota_warning(p_merchant_id uuid, p_used integer, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month_start timestamptz := date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
  v_month text := to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM');
  v_pct integer;
begin
  if p_merchant_id is null or p_used is null or p_limit is null or p_limit <= 0 or p_used < 0
     or p_used * 5 < p_limit * 4 then
    return false;
  end if;
  if not exists (select 1 from public.merchants m where m.id = p_merchant_id) then
    return false;
  end if;
  insert into public.merchant_customer_line_settings (merchant_id) values (p_merchant_id)
  on conflict (merchant_id) do nothing;
  perform 1 from public.merchant_customer_line_settings where merchant_id = p_merchant_id for update;
  if exists (
    select 1 from public.user_notifications n
    where n.merchant_id = p_merchant_id and n.event_type in ('line_quota_warning', 'line_quota_exhausted')
      and n.created_at >= v_month_start
  ) then
    return false;
  end if;
  v_pct := least(floor(p_used * 100.0 / p_limit)::integer, 100);
  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select ma.user_id, p_merchant_id, 'admin', ma.id, 'line_quota_warning', null,
         'LINE 訊息額度快用完了',
         '本月 LINE 訊息額度已用 ' || v_pct || '%（' || p_used || '／' || p_limit || ' 則）。用完後這個月的 LINE 通知（包含員工通知）都會發送失敗。'
  from public.merchant_admins ma
  where ma.merchant_id = p_merchant_id and ma.user_id is not null;
  update public.merchant_customer_line_settings set quota_warned_month = v_month, updated_at = now()
  where merchant_id = p_merchant_id;
  return true;
end;
$$;
revoke all on function public.internal_line_quota_warning(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.internal_line_quota_warning(uuid, integer, integer) to service_role;

-- =========================================================================
-- ⑥ C5-P01 行銷收件人 / C5-P02 生日禮
-- =========================================================================

-- 行銷候選(原始資料,判斷規則在呼叫端:Edge buildMarketingDispatchPlan、preview_line_marketing_recipients):
--   每位(屬於這間店的)會員:id、name、is_blacklisted、line_bound、
--   line_user_id / legacy_friend_status(只有「沒有聯絡人」的舊綁定碼會員才有值)、
--   contacts:[{ user_id, line_user_id(這間店 LINE 登入 channel 的身分;沒有 ⇒ null), notify_promo, friend_status }]
create or replace function private.line_marketing_candidates(p_merchant_id uuid, p_member_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id,
      'name', m.name,
      'is_blacklisted', coalesce(m.is_blacklisted, false),
      'line_bound', coalesce(m.line_bound, false) and not exists (
        select 1 from public.member_customer_contacts c0
        where c0.member_id = m.id and c0.merchant_id = p_merchant_id and c0.status = 'active'),
      'line_user_id', case when exists (
        select 1 from public.member_customer_contacts c0
        where c0.member_id = m.id and c0.merchant_id = p_merchant_id and c0.status = 'active') then null else m.line_user_id end,
      'legacy_friend_status', private.customer_line_friend_status(p_merchant_id, m.line_user_id),
      'contacts', coalesce((
        select jsonb_agg(jsonb_build_object(
          'user_id', c.user_id,
          'line_user_id', private.customer_line_user_id_for(p_merchant_id, c.user_id),
          'notify_promo', c.notify_promo,
          'friend_status', private.customer_line_friend_status(p_merchant_id, private.customer_line_user_id_for(p_merchant_id, c.user_id))
        ) order by c.is_primary desc, c.created_at, c.id)
        from public.member_customer_contacts c
        where c.member_id = m.id and c.merchant_id = p_merchant_id and c.status = 'active'
      ), '[]'::jsonb)
    ) order by m.id)
    from public.members m
    where m.merchant_id = p_merchant_id and m.id = any (coalesce(p_member_ids, array[]::uuid[]))
  ), '[]'::jsonb);
end;
$$;
revoke all on function private.line_marketing_candidates(uuid, uuid[]) from public, anon, authenticated, service_role;

-- Edge line-send-marketing 用(service_role;回應含 LINE userId,只能給 service role)。
create or replace function public.internal_line_marketing_candidates(p_merchant_id uuid, p_member_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return private.line_marketing_candidates(p_merchant_id, p_member_ids);
end;
$$;
revoke all on function public.internal_line_marketing_candidates(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.internal_line_marketing_candidates(uuid, uuid[]) to service_role;

-- C5-P01 發送前確認窗的則數(權限同行銷:管理員或 line_marketing 客服)。不回 LINE userId。
-- 規則(跟 Edge buildMarketingDispatchPlan 一致):黑名單優先擋;有聯絡人 ⇒ 每位「優惠通知開著、有這間店 LINE 身分、
-- 不是已知非好友」的聯絡人各一則;沒有聯絡人的舊綁定碼會員 ⇒ 一則(已知非好友除外);其他 0 則。
create or replace function public.preview_line_marketing_recipients(p_merchant_id uuid, p_member_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_members jsonb;
begin
  if p_merchant_id is null or not private.can_send_line_marketing(p_merchant_id) then
    raise exception '沒有權限發送這間商家的行銷訊息。' using errcode = '42501', hint = 'forbidden';
  end if;
  if coalesce(array_length(p_member_ids, 1), 0) > 5000 then
    raise exception '一次最多選 5000 位會員。' using errcode = '22023', hint = 'too_many_members';
  end if;
  v_rows := private.line_marketing_candidates(p_merchant_id, p_member_ids);
  select coalesce(jsonb_agg(jsonb_build_object('member_id', x.id, 'recipient_count', x.cnt) order by x.id), '[]'::jsonb)
  into v_members
  from (
    select (m ->> 'id')::uuid as id,
      case
        when coalesce((m ->> 'is_blacklisted')::boolean, false) then 0
        when jsonb_array_length(m -> 'contacts') > 0 then (
          select count(*)::integer from jsonb_array_elements(m -> 'contacts') c
          where coalesce((c ->> 'notify_promo')::boolean, true)
            and nullif(c ->> 'line_user_id', '') is not null
            and coalesce(c ->> 'friend_status', 'unknown') <> 'not_friend')
        when coalesce((m ->> 'line_bound')::boolean, false) and nullif(m ->> 'line_user_id', '') is not null
             and coalesce(m ->> 'legacy_friend_status', 'unknown') <> 'not_friend' then 1
        else 0
      end as cnt
    from jsonb_array_elements(v_rows) m
  ) x;
  return jsonb_build_object(
    'member_count', (select count(*)::integer from jsonb_array_elements(v_members) e where (e ->> 'recipient_count')::integer > 0),
    'message_count', (select coalesce(sum((e ->> 'recipient_count')::integer), 0)::integer from jsonb_array_elements(v_members) e),
    'members', v_members
  );
end;
$$;
revoke all on function public.preview_line_marketing_recipients(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.preview_line_marketing_recipients(uuid, uuid[]) to authenticated;

-- C5-P02:生日禮只發主要聯絡人(members.line_user_id 本來就是主要聯絡人,由 member_sync_primary 同步);
--        主要聯絡人關掉「優惠通知」⇒ 標 skipped_opted_out(點數照發);沒有聯絡人的舊綁定碼會員照舊。
--        只多一段判斷,其他逐字不變(第 987 批全形訊息版本)。
CREATE OR REPLACE FUNCTION public.claim_birthday_line_pending(p_limit integer DEFAULT 100)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_r record;
begin
  -- (a) 認領後超過 30 分鐘還沒回報結果 ⇒ Edge Function 中途中斷。LINE 可能已經送出也可能沒有,
  --     §3.7 第 4 點「不自動重試(避免對同一個人重複發)」⇒ 直接標 failed 讓商家看得到原因。
  update public.member_birthday_bonus_grants
  set line_status = 'failed',
      line_error = '發送過程中斷，系統沒有收到發送結果；為避免重複發送，不會自動重試'
  where line_status = 'pending'
    and line_attempted_at is not null
    and line_attempted_at < now() - interval '30 minutes';

  -- (b) 發點數後超過 7 天都沒發出 LINE(例如 LINE 發送排程當時尚未啟用)⇒ 不再補發過期的生日祝福。
  update public.member_birthday_bonus_grants
  set line_status = 'failed',
      line_error = '超過 7 天仍未發送(當時 LINE 發送排程可能尚未啟用)，為避免過期的生日祝福，不再補發',
      line_attempted_at = now()
  where line_status = 'pending'
    and line_attempted_at is null
    and granted_at < now() - interval '7 days';

  for v_r in
    select
      g.id as grant_id,
      g.merchant_id,
      g.member_id,
      g.points,
      coalesce(m.name, g.member_name_snapshot) as member_name,
      m.line_bound,
      m.line_user_id,
      m.status as member_status,
      mer.status as merchant_status,
      c.is_connected,
      c.channel_access_token,
      s.birthday_line_message,
      mer.name as merchant_name
    from public.member_birthday_bonus_grants g
    join public.members m on m.id = g.member_id
    join public.merchants mer on mer.id = g.merchant_id
    left join public.merchant_line_configs c on c.merchant_id = g.merchant_id
    left join public.merchant_member_settings s on s.merchant_id = g.merchant_id
    where g.line_status = 'pending'
      and g.line_attempted_at is null
    order by g.granted_at, g.id
    limit v_limit
    for update of g skip locked
  loop
    -- v2.4 第 19 條 ③:商家已被平台停用(關店)⇒ 不發 LINE。
    if v_r.merchant_status <> 'active' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_merchant_disabled',
          line_error = '商家已停用，不發送生日 LINE 訊息',
          line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    -- v2.4 第 19 條 ②:發點之後會員被下架 ⇒ 不發 LINE(點數已經發了,不收回)。
    if v_r.member_status <> 'active' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_member_removed',
          line_error = '會員已下架，不發送生日 LINE 訊息(生日點數已照常發放)',
          line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    -- [c5b] C5-P02:主要聯絡人關掉「優惠通知」⇒ 不發 LINE(生日點數照常發放)。
    if exists (
      select 1 from public.member_customer_contacts x
      where x.member_id = v_r.member_id and x.merchant_id = v_r.merchant_id
        and x.status = 'active' and x.is_primary and not x.notify_promo
    ) then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_opted_out',
          line_error = '客人關閉了優惠通知，不發送生日 LINE 訊息（生日點數已照常發放）',
          line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    if not coalesce(v_r.line_bound, false) or coalesce(btrim(v_r.line_user_id), '') = '' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_not_bound', line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    if not coalesce(v_r.is_connected, false) or coalesce(btrim(v_r.channel_access_token), '') = '' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_not_connected', line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    -- 認領:寫 line_attempted_at,狀態仍是 pending,結果由 mark_birthday_line_result 回寫。
    -- 已認領的列不會再被下一次呼叫撈到(條件是 line_attempted_at is null)。
    update public.member_birthday_bonus_grants
    set line_attempted_at = now()
    where id = v_r.grant_id;

    return next jsonb_build_object(
      'grant_id', v_r.grant_id,
      'merchant_id', v_r.merchant_id,
      'member_id', v_r.member_id,
      'line_user_id', v_r.line_user_id,
      'channel_access_token', v_r.channel_access_token,
      'message_template', coalesce(v_r.birthday_line_message, ''),
      'member_name', coalesce(v_r.member_name, ''),
      'points', v_r.points,
      'merchant_name', coalesce(v_r.merchant_name, '')
    );
  end loop;

  return;
end;
$function$;

revoke execute on function public.claim_birthday_line_pending(p_limit integer) from PUBLIC, anon, authenticated;
grant execute on function public.claim_birthday_line_pending(p_limit integer) to service_role;

-- =========================================================================
-- ⑦ 排程:服務前提醒每 10 分鐘寫待發列(純 SQL,不呼叫外部;發送仍由每分鐘的 dispatcher 做)
-- =========================================================================
select
  cron.schedule(
    'customer-line-reminder-enqueue',
    '*/10 * * * *',
    $$ select private.enqueue_customer_line_reminders(); $$
  );
