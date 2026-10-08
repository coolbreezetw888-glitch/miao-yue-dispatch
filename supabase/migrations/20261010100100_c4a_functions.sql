-- 客戶端第 4-A 批(模組 13)— migration 2:會員中心、我的預約、客人自己取消、錢包、我的資料
-- 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先;本批只做 4-A)
-- 介面文件:.project/notes/c4-contract.md
--
-- =========================================================================
-- 新增
-- =========================================================================
--   private.customer_member_of                 C4-A02 「我的 XX」唯一的身分來源(4-A 暫用 members.user_id;4-B 改查聯絡人表)
--   private.customer_me_context                C4-A02 每支客人函式開頭共用:商家 → 客人帳號 → 接上狀態 → 所屬會員
--   private.customer_cancel_deadline_hours     C4-D01 該店取消期限 N(沒設定 = 24)
--   private.customer_can_cancel                C4-D01 能不能取消(伺服器唯一一份;畫面 can_cancel 與真正取消共用)
--   private.customer_booking_view              C4-A03 會員端預約摘要(白名單逐欄)
--   private.customer_booking_summary_text      C4-W02 點數明細的訂單摘要「10月2日　室內機清洗 ×2」
--   private.customer_point_history_page        C4-W02 點數明細分頁(同一時間的幾筆依實際寫入先後)
--   private.notify_customer_booking_cancelled  C4-D04 鈴鐺(一定發)
--   public.customer_get_member_home            C4-C01
--   public.customer_list_my_bookings           C4-C03
--   public.internal_customer_cancel_booking    C4-D02(只給 service_role;Edge customer-booking-cancel 呼叫)
--   public.customer_get_wallet                 C4-W02
--   public.customer_get_profile                C4-E01
--   public.customer_update_profile             C4-E03
-- =========================================================================
-- 修改(前後指紋見回報)
-- =========================================================================
--   public.get_public_booking_page     booking_settings 多 customer_cancel_deadline_hours(C4-K02);其他不變
--   public.get_customer_session_state  linked 的 member 多 address(C4-E05);其他不變
--
-- 不呼叫、不修改後台 cancel_booking / refund_booking_redeem / can_manage_bookings(指紋不變)。
-- 權限衛生:新函式一律 revoke from public, anon, authenticated;客人函式只再 grant authenticated(函式內再擋
--   is_customer_account);internal_* 只給 service_role;private.* 只給 service_role。
-- 函式本體內不寫註解(md5(prosrc) 指紋比對才穩定),說明寫在函式上方。

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A02 private.customer_member_of(p_merchant_id, p_user_id)
--   回這位客人在這間店所屬的會員(0 或 1 列)。
--   4-A:只查 members.user_id(= 主要聯絡人);contact_id 一律 null、is_primary 一律 true。
--   4-B:改成查 member_customer_contacts(active)且會員 active —— 只改這一支,其他函式不用回頭改。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_member_of(p_merchant_id uuid, p_user_id uuid)
returns table(member_id uuid, contact_id uuid, is_primary boolean)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, null::uuid, true
  from public.members m
  where m.merchant_id = p_merchant_id
    and m.user_id = p_user_id
    and p_user_id is not null
    and m.status = 'active'
  order by m.created_at, m.id
  limit 1
$$;
revoke execute on function private.customer_member_of(uuid, uuid) from public, anon, authenticated;
grant execute on function private.customer_member_of(uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A02 private.customer_me_context(p_slug, p_user_id)
--   每支「我的 XX」函式開頭共用,順序固定:
--     ① slug 找商家;不存在 / 停用 ⇒ unavailable
--     ② p_user_id 必須是客人帳號(auth.users.raw_app_meta_data.account_type = customer)⇒ 否則 not_linked
--     ③ private.customer_link_state:line_login_unavailable ⇒ unavailable(這間店沒有會員中心);
--        channel_mismatch / needs_profile ⇒ not_linked
--     ④ customer_member_of 取會員;找不到 ⇒ not_linked
--   回 1 列:state('ok' / 'unavailable' / 'not_linked')+ merchant_id / member_id / contact_id / is_primary。
--   不收前端傳的 member_id / user_id(public 函式一律傳 auth.uid())。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_me_context(p_slug text, p_user_id uuid)
returns table(state text, merchant_id uuid, member_id uuid, contact_id uuid, is_primary boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant public.merchants;
  v_link text;
  v_member_id uuid;
  v_contact_id uuid;
  v_is_primary boolean;
begin
  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return query select 'unavailable'::text, null::uuid, null::uuid, null::uuid, null::boolean;
    return;
  end if;

  if p_user_id is null or not exists (
       select 1 from auth.users u
       where u.id = p_user_id and coalesce(u.raw_app_meta_data ->> 'account_type', '') = 'customer'
     ) then
    return query select 'not_linked'::text, v_merchant.id, null::uuid, null::uuid, null::boolean;
    return;
  end if;

  v_link := private.customer_link_state(v_merchant.id, p_user_id);
  if v_link = 'line_login_unavailable' then
    return query select 'unavailable'::text, v_merchant.id, null::uuid, null::uuid, null::boolean;
    return;
  end if;
  if v_link <> 'linked' then
    return query select 'not_linked'::text, v_merchant.id, null::uuid, null::uuid, null::boolean;
    return;
  end if;

  select c.member_id, c.contact_id, c.is_primary into v_member_id, v_contact_id, v_is_primary
  from private.customer_member_of(v_merchant.id, p_user_id) c;
  if v_member_id is null then
    return query select 'not_linked'::text, v_merchant.id, null::uuid, null::uuid, null::boolean;
    return;
  end if;

  return query select 'ok'::text, v_merchant.id, v_member_id, v_contact_id, coalesce(v_is_primary, false);
end;
$$;
revoke execute on function private.customer_me_context(text, uuid) from public, anon, authenticated;
grant execute on function private.customer_me_context(text, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-D01 private.customer_cancel_deadline_hours(p_merchant_id):沒有設定列 ⇒ 24(鐵律 8)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_cancel_deadline_hours(p_merchant_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select s.customer_cancel_deadline_hours from public.merchant_booking_settings s where s.merchant_id = p_merchant_id
  ), 24)
$$;
revoke execute on function private.customer_cancel_deadline_hours(uuid) from public, anon, authenticated;
grant execute on function private.customer_cancel_deadline_hours(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-D01 private.customer_can_cancel(b, p_now)(伺服器唯一一份規則)
--   ① 狀態是 pending_confirmation / accepted(跟後台 cancel_booking 一樣)
--   ② p_now < 期限 = b.start_at(目前的開始時間)− N 小時;N = 該店 coalesce(customer_cancel_deadline_hours, 24)
--   ③「訂單屬於這位客人所屬的會員」由呼叫端判斷(本函式不收客人身分)。
--   ④ Q1 = A:不看 source(店家後台建的單、訪客時期掛上的單都可以)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_can_cancel(b public.bookings, p_now timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select b.status in ('pending_confirmation', 'accepted')
     and p_now < b.start_at - make_interval(hours => private.customer_cancel_deadline_hours(b.merchant_id))
$$;
revoke execute on function private.customer_can_cancel(public.bookings, timestamptz) from public, anon, authenticated;
grant execute on function private.customer_can_cancel(public.bookings, timestamptz) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-A03 private.customer_booking_view(p_booking, p_now)(鐵律 2:逐欄 jsonb_build_object)
--   {id, start_at, end_at, status, staff_display, items:[{name, quantity}], address, customer_name, customer_notes,
--    amount, points_redeemed, booked_online, booked_by, can_cancel, cancel_deadline_at, cancelled_at}
--   status:pending_reply / dispatching ⇒ pending_confirmation(客人看都是「待確認」)
--   staff_display:主要服務人員暱稱優先(同第 1 批 display_name);沒有 ⇒ null
--   booked_by:4-A 一律 null(4-B:會員曾有 2 位以上聯絡人時回下單聯絡人的 LINE 顯示名)
--   cancel_deadline_at:狀態是待確認 / 已確認時 = start_at − N 小時,其他 null
--   不回:notes、hide_notes_from_staff、抽成、料錢、付款方式、member_id、customer_phone、黑名單、points_planned、
--         操作紀錄、cancelled_reason、服務人員 id / 本名(有暱稱時)/ 電話、助手。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_booking_view(p_booking public.bookings, p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_staff_display text;
  v_hours integer;
begin
  select coalesce(nullif(btrim(ms.nickname), ''), ms.name) into v_staff_display
  from public.merchant_staff ms where ms.id = p_booking.staff_id;
  v_hours := private.customer_cancel_deadline_hours(p_booking.merchant_id);

  return jsonb_build_object(
    'id', p_booking.id,
    'start_at', p_booking.start_at,
    'end_at', p_booking.end_at,
    'status', case when p_booking.status in ('pending_reply', 'dispatching') then 'pending_confirmation' else p_booking.status end,
    'staff_display', v_staff_display,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('name', si.name, 'quantity', bsi.quantity)
                       order by case when si.item_type = 'primary' then 0 else 1 end, si.created_at, si.id)
      from public.booking_service_items bsi
      join public.service_items si on si.id = bsi.service_item_id
      where bsi.booking_id = p_booking.id
    ), '[]'::jsonb),
    'address', p_booking.customer_address,
    'customer_name', p_booking.customer_name,
    'customer_notes', p_booking.customer_notes,
    'amount', p_booking.final_amount_snapshot,
    'points_redeemed', coalesce(p_booking.points_redeemed, 0),
    'booked_online', p_booking.source = 'customer',
    'booked_by', null,
    'can_cancel', private.customer_can_cancel(p_booking, p_now),
    'cancel_deadline_at', case when p_booking.status in ('pending_confirmation', 'accepted')
                               then p_booking.start_at - make_interval(hours => v_hours) else null end,
    'cancelled_at', p_booking.cancelled_at
  );
end;
$$;
revoke execute on function private.customer_booking_view(public.bookings, timestamptz) from public, anon, authenticated;
grant execute on function private.customer_booking_view(public.bookings, timestamptz) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-W02 private.customer_booking_summary_text(p_booking_id)
--   「M月D日　項目 ×數量」(台北時間;中間全形空白;多個項目用「、」接,主要項目在前);找不到訂單 ⇒ null。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_booking_summary_text(p_booking_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_b public.bookings;
  v_items text;
begin
  if p_booking_id is null then
    return null;
  end if;
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then
    return null;
  end if;
  select string_agg(si.name || ' ×' || bsi.quantity, '、'
                    order by case when si.item_type = 'primary' then 0 else 1 end, si.created_at, si.id)
    into v_items
  from public.booking_service_items bsi
  join public.service_items si on si.id = bsi.service_item_id
  where bsi.booking_id = v_b.id;
  return to_char(v_b.start_at at time zone 'Asia/Taipei', 'FMMM月FMDD日')
         || case when v_items is null then '' else '　' || v_items end;
end;
$$;
revoke execute on function private.customer_booking_summary_text(uuid) from public, anon, authenticated;
grant execute on function private.customer_booking_summary_text(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-W02 private.customer_point_history_page(p_member_id, p_cursor, p_limit)
--   回 {history:[{type, delta, created_at, booking_summary}], next_cursor}
--   排序:created_at 由新到舊;同一個 created_at 的幾筆(同一交易寫入)依 #946 的「接龍」規則還原實際寫入先後
--     (每筆「做之前的餘額」= balance_after − points_delta;最早那筆的「做之前」不等於同組任何一筆的 balance_after),
--     接不起來 ⇒ 依 id;同組內輸出新的在前。balance_after 只拿來排序,不回給客人。
--   分頁:p_cursor = 上一頁回的 next_cursor(只取 created_at < p_cursor);同一個 created_at 不切到兩頁
--     (一頁可能比 p_limit 多幾筆)。p_limit 夾在 1~50。
--   不回:note、created_by_user_id、related_member_id、balance_after、id。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.customer_point_history_page(p_member_id uuid, p_cursor timestamptz, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 30), 1), 50);
  v_cut timestamptz;
  v_next timestamptz;
  v_group_at timestamptz;
  v_ids uuid[];
  v_before integer[];
  v_after integer[];
  v_used boolean[];
  v_chain uuid[];
  v_n integer;
  v_i integer;
  v_j integer;
  v_head integer;
  v_cur_after integer;
  v_found boolean;
  v_out jsonb := '[]'::jsonb;
  v_row public.member_point_transactions;
begin
  select t.created_at into v_cut
  from public.member_point_transactions t
  where t.member_id = p_member_id and (p_cursor is null or t.created_at < p_cursor)
  order by t.created_at desc
  offset v_limit - 1 limit 1;

  if v_cut is not null and exists (
    select 1 from public.member_point_transactions t
    where t.member_id = p_member_id and t.created_at < v_cut
  ) then
    v_next := v_cut;
  end if;

  for v_group_at in
    select distinct t.created_at
    from public.member_point_transactions t
    where t.member_id = p_member_id
      and (p_cursor is null or t.created_at < p_cursor)
      and (v_cut is null or t.created_at >= v_cut)
    order by t.created_at desc
  loop
    select array_agg(t.id order by t.id::text),
           array_agg(t.balance_after - t.points_delta order by t.id::text),
           array_agg(t.balance_after order by t.id::text)
      into v_ids, v_before, v_after
    from public.member_point_transactions t
    where t.member_id = p_member_id and t.created_at = v_group_at;
    v_n := coalesce(array_length(v_ids, 1), 0);
    v_chain := array[]::uuid[];

    if v_n = 1 then
      v_chain := v_ids;
    else
      v_used := array_fill(false, array[v_n]);
      v_head := null;
      for v_i in 1..v_n loop
        if not (v_before[v_i] = any (v_after[1:v_i - 1] || v_after[v_i + 1:v_n])) then
          v_head := v_i;
          exit;
        end if;
      end loop;
      if v_head is not null then
        v_chain := array[v_ids[v_head]];
        v_used[v_head] := true;
        v_cur_after := v_after[v_head];
        loop
          v_found := false;
          for v_j in 1..v_n loop
            if not v_used[v_j] and v_before[v_j] = v_cur_after then
              v_chain := v_chain || v_ids[v_j];
              v_used[v_j] := true;
              v_cur_after := v_after[v_j];
              v_found := true;
              exit;
            end if;
          end loop;
          exit when not v_found;
        end loop;
      end if;
      for v_j in 1..v_n loop
        if not coalesce(v_used[v_j], false) then
          v_chain := v_chain || v_ids[v_j];
        end if;
      end loop;
    end if;

    for v_i in reverse coalesce(array_length(v_chain, 1), 0)..1 loop
      select * into v_row from public.member_point_transactions where id = v_chain[v_i];
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'type', v_row.transaction_type,
        'delta', v_row.points_delta,
        'created_at', v_row.created_at,
        'booking_summary', private.customer_booking_summary_text(v_row.booking_id)
      ));
    end loop;
  end loop;

  return jsonb_build_object('history', v_out, 'next_cursor', v_next);
end;
$$;
revoke execute on function private.customer_point_history_page(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function private.customer_point_history_page(uuid, timestamptz, integer) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-D04 private.notify_customer_booking_cancelled(p_booking_id, p_actor_name)(一定發,不看推播開關)
--   收件人與優先順序沿用 C3-C01(同一個帳號只寫一則,管理員 > 客服 > 服務人員):
--     ① 該店管理員(有 user_id)
--     ② 在職、有 user_id、「訂單管理」(orders)權限 granted 的客服
--     ③ 這張單的主要服務人員:在職、已開通登入、有 user_id、staff_calendar_view_allows_notifications(#876)
--   title「客人取消了預約」
--   body 「客人「王小明」取消了 10/13（二）10:00 的預約，服務人員：阿明。」
--     姓名去換行;不放電話、地址、金額;服務人員名字用本名(店內的人看,跟第 3 批鈴鐺一致)。
--   回傳 {title, body} 給 Edge 當推播文字(C4-D05 messageOverride)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.notify_customer_booking_cancelled(p_booking_id uuid, p_actor_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_b public.bookings;
  v_staff_name text;
  v_local timestamp;
  v_title text := '客人取消了預約';
  v_body text;
begin
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then
    return null;
  end if;

  select ms.name into v_staff_name from public.merchant_staff ms where ms.id = v_b.staff_id;
  v_local := v_b.start_at at time zone 'Asia/Taipei';
  v_body := format(
    '客人「%s」取消了 %s（%s）%s 的預約，服務人員：%s。',
    regexp_replace(coalesce(nullif(btrim(p_actor_name), ''), nullif(btrim(v_b.customer_name), ''), '未填姓名'), E'\r\n|[\r\n\t]', ' ', 'g'),
    to_char(v_local, 'FMMM/FMDD'),
    (array['日', '一', '二', '三', '四', '五', '六'])[extract(dow from v_local)::integer + 1],
    to_char(v_local, 'HH24:MI'),
    regexp_replace(coalesce(nullif(btrim(v_staff_name), ''), '服務人員'), E'\r\n|[\r\n\t]', ' ', 'g')
  );

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select distinct on (ma.user_id)
         ma.user_id, v_b.merchant_id, 'admin', ma.id, 'customer_booking_cancelled', v_b.id, v_title, v_body
  from public.merchant_admins ma
  where ma.merchant_id = v_b.merchant_id and ma.user_id is not null
  order by ma.user_id, ma.id;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select distinct on (g.user_id)
         g.user_id, v_b.merchant_id, 'agent', g.id, 'customer_booking_cancelled', v_b.id, v_title, v_body
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
      where un.booking_id = v_b.id and un.event_type = 'customer_booking_cancelled' and un.user_id = g.user_id
    )
  order by g.user_id, g.id;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select ms.user_id, v_b.merchant_id, 'staff', ms.id, 'customer_booking_cancelled', v_b.id, v_title, v_body
  from public.merchant_staff ms
  where ms.id = v_b.staff_id
    and ms.merchant_id = v_b.merchant_id
    and ms.status = 'active'
    and ms.login_status = 'active'
    and ms.user_id is not null
    and private.staff_calendar_view_allows_notifications(ms.id)
    and not exists (
      select 1 from public.user_notifications un
      where un.booking_id = v_b.id and un.event_type = 'customer_booking_cancelled' and un.user_id = ms.user_id
    );

  return jsonb_build_object('title', v_title, 'body', v_body);
end;
$$;
revoke execute on function private.notify_customer_booking_cancelled(uuid, text) from public, anon, authenticated;
grant execute on function private.notify_customer_booking_cancelled(uuid, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-C01 public.customer_get_member_home(p_slug)
--   {state:'ok', member:{name, is_primary, missing:[birthday, email, address 中空著的]},
--    next_booking: 即將到來最早一筆(C4-A03)| null, upcoming_count,
--    wallet:{points_enabled, points_balance(沒開 ⇒ null), stored_value:null}, pending_contact_requests(4-A 一律 0)}
--   其他 state:unavailable、not_linked。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.customer_get_member_home(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_member public.members;
  v_now timestamptz := now();
  v_next public.bookings;
  v_count integer;
  v_points_enabled boolean;
  v_missing jsonb := '[]'::jsonb;
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
    'pending_contact_requests', 0
  );
end;
$$;
revoke execute on function public.customer_get_member_home(text) from public, anon, authenticated;
grant execute on function public.customer_get_member_home(text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-C03 public.customer_list_my_bookings(p_slug, p_scope, p_cursor, p_limit)
--   範圍:這位客人所屬會員的全部訂單(member_id = 會員;含後台代建、訪客時期掛上的)。
--   upcoming:狀態不是 completed / cancelled 且 end_at >= now(),start_at 由近到遠(同時間依 id)。
--   history :completed、cancelled,或 end_at < now(),start_at 由新到舊(同時間依 id)。
--   分頁:p_cursor = 上一頁回的 next_cursor(upcoming 取 start_at > cursor;history 取 start_at < cursor);
--     同一個 start_at 不切到兩頁(一頁可能比 p_limit 多幾筆)。p_limit 夾在 1~50,預設 20。
--   回 {state:'ok', items:[C4-A03…], next_cursor, counts:{upcoming, history}};p_scope 不對 ⇒ 22023 invalid_scope。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.customer_list_my_bookings(
  p_slug text,
  p_scope text,
  p_cursor timestamptz default null,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_now timestamptz := now();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_cut timestamptz;
  v_next timestamptz;
  v_items jsonb;
  v_up integer;
  v_hist integer;
begin
  if p_scope is null or p_scope not in ('upcoming', 'history') then
    raise exception '查詢範圍不正確，請重新整理後再試一次。' using errcode = '22023', hint = 'invalid_scope';
  end if;
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;

  select count(*) filter (where b.status not in ('completed', 'cancelled') and b.end_at >= v_now)::integer,
         count(*) filter (where b.status in ('completed', 'cancelled') or b.end_at < v_now)::integer
    into v_up, v_hist
  from public.bookings b
  where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id;

  if p_scope = 'upcoming' then
    select b.start_at into v_cut from public.bookings b
    where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
      and b.status not in ('completed', 'cancelled') and b.end_at >= v_now
      and (p_cursor is null or b.start_at > p_cursor)
    order by b.start_at, b.id
    offset v_limit - 1 limit 1;

    if v_cut is not null and exists (
      select 1 from public.bookings b
      where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
        and b.status not in ('completed', 'cancelled') and b.end_at >= v_now
        and b.start_at > v_cut
    ) then
      v_next := v_cut;
    end if;

    select coalesce(jsonb_agg(private.customer_booking_view(b, v_now) order by b.start_at, b.id), '[]'::jsonb)
      into v_items
    from public.bookings b
    where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
      and b.status not in ('completed', 'cancelled') and b.end_at >= v_now
      and (p_cursor is null or b.start_at > p_cursor)
      and (v_cut is null or b.start_at <= v_cut);
  else
    select b.start_at into v_cut from public.bookings b
    where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
      and (b.status in ('completed', 'cancelled') or b.end_at < v_now)
      and (p_cursor is null or b.start_at < p_cursor)
    order by b.start_at desc, b.id desc
    offset v_limit - 1 limit 1;

    if v_cut is not null and exists (
      select 1 from public.bookings b
      where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
        and (b.status in ('completed', 'cancelled') or b.end_at < v_now)
        and b.start_at < v_cut
    ) then
      v_next := v_cut;
    end if;

    select coalesce(jsonb_agg(private.customer_booking_view(b, v_now) order by b.start_at desc, b.id desc), '[]'::jsonb)
      into v_items
    from public.bookings b
    where b.merchant_id = v_ctx.merchant_id and b.member_id = v_ctx.member_id
      and (b.status in ('completed', 'cancelled') or b.end_at < v_now)
      and (p_cursor is null or b.start_at < p_cursor)
      and (v_cut is null or b.start_at >= v_cut);
  end if;

  return jsonb_build_object(
    'state', 'ok',
    'items', v_items,
    'next_cursor', v_next,
    'counts', jsonb_build_object('upcoming', v_up, 'history', v_hist)
  );
end;
$$;
revoke execute on function public.customer_list_my_bookings(text, text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.customer_list_my_bookings(text, text, timestamptz, integer) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-D02 public.internal_customer_cancel_booking(p_slug, p_user_id, p_booking_id)
--   只給 service_role(Edge customer-booking-cancel 已驗 token 且 app_metadata.account_type = customer)。
--   步驟(順序不能變):
--     1. customer_me_context:unavailable / not_linked
--     2. select … for update 鎖訂單列(鎖順序 訂單 → 會員,同 cancel_booking / update_booking / refund_booking_redeem)
--     3. 不存在 / 不是這間店 / 不屬於這位會員 ⇒ not_found(同一個回應,不透露存在與否)
--     4. 已經 cancelled ⇒ already_cancelled(冪等,不再發通知)
--     5. customer_can_cancel 不成立:狀態是待確認 / 已確認(⇒ 期限過了)deadline_passed;其他 not_cancellable
--     6. 更新(欄位與後台 cancel_booking 一致):status、cancelled_at、cancelled_reason = '客人線上取消'、
--        last_modified_by_user_id = p_user_id、last_modified_at
--     7. private.refund_booking_redeem(退回紅利折抵;取消的單不入帳派點,同後台)
--     8. 操作紀錄 actor_role_snapshot = customer、actor_name_snapshot = '客人 ' || 會員姓名(換行換空白、去頭尾空白)、created_at = clock_timestamp()
--     9. 鈴鐺 C4-D04
--    10. {state:'cancelled', booking: C4-A03, _internal:{booking_id, merchant_id, push_title, push_body}}
--        🔴 Edge 一定要刪 _internal。
--   bookings 上的 trigger(updated_at、紅利折抵檢查、服務人員 / 商家行事曆即時同步)跟後台取消一樣會觸發。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.internal_customer_cancel_booking(p_slug text, p_user_id uuid, p_booking_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_b public.bookings;
  v_old_status text;
  v_actor_name text;
  v_push jsonb;
  v_now timestamptz := now();
begin
  select * into v_ctx from private.customer_me_context(p_slug, p_user_id);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;

  if p_booking_id is null then
    return jsonb_build_object('state', 'not_found');
  end if;
  select * into v_b from public.bookings where id = p_booking_id for update;
  if not found or v_b.merchant_id is distinct from v_ctx.merchant_id or v_b.member_id is distinct from v_ctx.member_id then
    return jsonb_build_object('state', 'not_found');
  end if;

  if v_b.status = 'cancelled' then
    return jsonb_build_object('state', 'already_cancelled');
  end if;

  if not private.customer_can_cancel(v_b, v_now) then
    if v_b.status in ('pending_confirmation', 'accepted') then
      return jsonb_build_object('state', 'deadline_passed');
    end if;
    return jsonb_build_object('state', 'not_cancellable');
  end if;

  v_old_status := v_b.status;
  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = '客人線上取消',
      last_modified_by_user_id = p_user_id,
      last_modified_at = now()
  where id = p_booking_id;

  perform private.refund_booking_redeem(p_booking_id);

  select coalesce(nullif(btrim(regexp_replace(m.name, E'[\r\n\t]+', ' ', 'g')), ''),
                  nullif(btrim(regexp_replace(v_b.customer_name, E'[\r\n\t]+', ' ', 'g')), ''), '未填姓名')
    into v_actor_name
  from public.members m where m.id = v_ctx.member_id;

  insert into public.booking_status_change_logs (
    booking_id, merchant_id, from_status, to_status,
    actor_user_id, actor_name_snapshot, actor_role_snapshot, created_at
  ) values (
    p_booking_id, v_b.merchant_id, v_old_status, 'cancelled',
    p_user_id, '客人 ' || v_actor_name, 'customer', clock_timestamp()
  );

  v_push := private.notify_customer_booking_cancelled(p_booking_id, v_actor_name);

  select * into v_b from public.bookings where id = p_booking_id;
  return jsonb_build_object(
    'state', 'cancelled',
    'booking', private.customer_booking_view(v_b, v_now),
    '_internal', jsonb_build_object(
      'booking_id', p_booking_id,
      'merchant_id', v_b.merchant_id,
      'push_title', v_push ->> 'title',
      'push_body', v_push ->> 'body'
    )
  );
end;
$$;
revoke execute on function public.internal_customer_cancel_booking(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.internal_customer_cancel_booking(text, uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-W02 public.customer_get_wallet(p_slug, p_cursor, p_limit)
--   {state:'ok', points:{enabled:true, balance, history:[…], next_cursor} | null(紅利沒開), stored_value:null}
--   範圍:這位會員的分類帳(點數是會員的)。紅利開關 = coalesce(points_feature_enabled, true)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.customer_get_wallet(p_slug text, p_cursor timestamptz default null, p_limit integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_enabled boolean;
  v_balance integer;
  v_page jsonb;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;

  select coalesce((
    select s.points_feature_enabled from public.merchant_member_settings s where s.merchant_id = v_ctx.merchant_id
  ), true) into v_enabled;
  if not v_enabled then
    return jsonb_build_object('state', 'ok', 'points', null, 'stored_value', null);
  end if;

  select m.points_balance into v_balance from public.members m where m.id = v_ctx.member_id;
  v_page := private.customer_point_history_page(v_ctx.member_id, p_cursor, p_limit);

  return jsonb_build_object(
    'state', 'ok',
    'points', jsonb_build_object(
      'enabled', true,
      'balance', v_balance,
      'history', v_page -> 'history',
      'next_cursor', v_page -> 'next_cursor'
    ),
    'stored_value', null
  );
end;
$$;
revoke execute on function public.customer_get_wallet(text, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.customer_get_wallet(text, timestamptz, integer) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-E01 public.customer_get_profile(p_slug)
--   {state:'ok', member:{name, phone, birthday, address, email},
--    me:{line_display_name, line_picture_url, is_primary, contact_phone(4-A 一律 null)}, can_edit: is_primary}
--   會員個資完整顯示(第 2 批零之二)。不回 notes、黑名單、等級、推薦碼、identity_*、line_user_id。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.customer_get_profile(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_member public.members;
  v_ident public.customer_line_identities;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  select * into v_member from public.members where id = v_ctx.member_id;
  select * into v_ident from public.customer_line_identities where user_id = v_uid;

  return jsonb_build_object(
    'state', 'ok',
    'member', jsonb_build_object(
      'name', v_member.name,
      'phone', v_member.phone,
      'birthday', v_member.birthday,
      'address', v_member.address,
      'email', v_member.email
    ),
    'me', jsonb_build_object(
      'line_display_name', v_ident.display_name,
      'line_picture_url', v_ident.picture_url,
      'is_primary', v_ctx.is_primary,
      'contact_phone', null
    ),
    'can_edit', v_ctx.is_primary
  );
end;
$$;
revoke execute on function public.customer_get_profile(text) from public, anon, authenticated;
grant execute on function public.customer_get_profile(text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- C4-E03 public.customer_update_profile(p_slug, p_name, p_birthday, p_address, p_email)
--   只有主要聯絡人能改(否則 22023 not_primary)。只更新 name / birthday / address / email 四欄。
--   姓名:換行 / tab 換成空白、去頭尾空白(含全形空白)後 1~50 字 ⇒ 否則 invalid_name
--   Email:可空;格式同後台 EMAIL_REGEX(src/lib/validation.ts,資料庫版同 login email 函式)、≤ 254 ⇒ invalid_email
--   地址:可空、≤ 200 ⇒ invalid_address
--   生日:可空、不能是未來(台北日期)、不能早於 1900-01-01 ⇒ invalid_birthday;
--         原本已有生日 ⇒ 傳入值必須相同(null 或不同 ⇒ birthday_locked)(Q3 = A)
--   空字串存 null。既有訂單上的姓名不動。不發鈴鐺。
--   回 {state:'ok', member:{name, phone, birthday, address, email}};其他 state:unavailable、not_linked。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.customer_update_profile(
  p_slug text,
  p_name text,
  p_birthday date,
  p_address text,
  p_email text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_member public.members;
  v_name text;
  v_email text;
  v_address text;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  if not v_ctx.is_primary then
    raise exception '只有主要聯絡人可以修改會員資料。' using errcode = '22023', hint = 'not_primary';
  end if;

  v_name := regexp_replace(regexp_replace(coalesce(p_name, ''), E'[\\r\\n\\t]+', ' ', 'g'), '^[\s　]+|[\s　]+$', '', 'g');
  if char_length(v_name) < 1 or char_length(v_name) > 50 then
    raise exception '請填寫姓名（最多 50 字）。' using errcode = '22023', hint = 'invalid_name';
  end if;

  v_email := nullif(btrim(coalesce(p_email, '')), '');
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception '請輸入正確的 Email 格式，例如 name@example.com' using errcode = '22023', hint = 'invalid_email';
  end if;

  v_address := nullif(btrim(coalesce(p_address, '')), '');
  if char_length(coalesce(v_address, '')) > 200 then
    raise exception '地址最多 200 字。' using errcode = '22023', hint = 'invalid_address';
  end if;

  if p_birthday is not null
     and (p_birthday > (now() at time zone 'Asia/Taipei')::date or p_birthday < date '1900-01-01') then
    raise exception '生日日期不正確。' using errcode = '22023', hint = 'invalid_birthday';
  end if;

  select * into v_member from public.members where id = v_ctx.member_id for update;
  if v_member.birthday is not null and p_birthday is distinct from v_member.birthday then
    raise exception '生日填寫後不能自行修改，要更改請聯絡店家。' using errcode = '22023', hint = 'birthday_locked';
  end if;

  update public.members
  set name = v_name,
      birthday = p_birthday,
      address = v_address,
      email = v_email
  where id = v_ctx.member_id
  returning * into v_member;

  return jsonb_build_object(
    'state', 'ok',
    'member', jsonb_build_object(
      'name', v_member.name,
      'phone', v_member.phone,
      'birthday', v_member.birthday,
      'address', v_member.address,
      'email', v_member.email
    )
  );
end;
$$;
revoke execute on function public.customer_update_profile(text, text, date, text, text) from public, anon, authenticated;
grant execute on function public.customer_update_profile(text, text, date, text, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 修改的既有函式(由目前資料庫定義只改必要的幾行產生)
-- ═════════════════════════════════════════════════════════════════════════

-- ─── public.get_public_booking_page(C4-K02:booking_settings 多 customer_cancel_deadline_hours,沒設定 = 24)───
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
      'customer_cancel_deadline_hours', coalesce(v_cancel_hours, 24)
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

-- ─── public.get_customer_session_state(C4-E05:linked 的 member 多 address;其他不變)───
CREATE OR REPLACE FUNCTION public.get_customer_session_state(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_merchant public.merchants;
  v_cfg public.merchant_line_login_configs;
  v_ident public.customer_line_identities;
  v_member public.members;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_customer');
  end if;

  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;
  select * into v_cfg from public.merchant_line_login_configs where merchant_id = v_merchant.id;
  if not found or not v_cfg.enabled then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;

  select * into v_ident from public.customer_line_identities where user_id = v_uid;
  if not found or v_ident.line_channel_id is distinct from v_cfg.channel_id then
    return jsonb_build_object('state', 'channel_mismatch');
  end if;

  select * into v_member from public.members
  where merchant_id = v_merchant.id and user_id = v_uid and status = 'active';
  if found then
    return jsonb_build_object(
      'state', 'linked',
      'line_display_name', v_ident.display_name,
      'line_picture_url', v_ident.picture_url,
      'member', jsonb_build_object('name', v_member.name, 'phone', v_member.phone, 'address', v_member.address)
    );
  end if;

  return jsonb_build_object(
    'state', 'needs_profile',
    'line_display_name', v_ident.display_name,
    'line_picture_url', v_ident.picture_url
  );
end;
$function$;
