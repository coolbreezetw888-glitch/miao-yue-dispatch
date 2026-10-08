-- 客戶端第 4-B 批(模組 13)— migration 2:多位聯絡人(#1041)新函式
-- 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先;H 區、K03、K04)
-- 介面文件:.project/notes/c4-contract.md 「4-B」章節
--
-- =========================================================================
-- 新增(private:全部 revoke from public, anon, authenticated;只留 service_role)
-- =========================================================================
--   private.contact_user_lock                 同一個客戶帳號在同一間店的聯絡人異動排隊(沿用 c2_profile 的鎖鍵)
--   private.member_sync_primary               members.user_id / line_user_id / line_bound ⇐ 主要聯絡人(Q6)
--   private.member_contact_add                新增聯絡人唯一入口(清掉失效列、上限 10、取消自己的待處理申請)
--   private.member_contact_remove             移除聯絡人(要不要封鎖由呼叫端決定)
--   private.member_id_by_contact_phone        聯絡人電話 ⇒ 會員(K03)
--   private.phone_in_use_elsewhere            電話是不是別的會員的電話 / 聯絡人電話(H08)
--   private.assert_phone_not_member_contact   「新建 / 改電話 / 重新上架會員」撞到別人的聯絡人電話 ⇒ 擋(K03,Q2 = A)
--   private.contact_invite_valid_id           邀請碼雜湊 ⇒ 有效邀請
--   private.notify_member_managers            鈴鐺:管理員 + 有會員權限客服(同 member_line_login_linked 收件人)
--   private.notify_member_contact_joined      鈴鐺「〇〇已加入成為會員「△△」的聯絡人。」
--   private.notify_member_contact_request     鈴鐺 member_contact_request
--   private.member_contact_request_create     H04 送出加入申請
--   private.resolve_contact_request           H05 處理申請(客人版 / 後台版共用)
--   private.expire_member_contact_requests    cron:7 天沒處理 ⇒ expired;清掉過期的邀請保留
-- =========================================================================
-- 新增(public)
-- =========================================================================
--   客人(只 grant authenticated;函式內擋 is_customer_account):
--     customer_cancel_contact_request、customer_create_contact_invite、customer_revoke_contact_invite、
--     customer_accept_contact_invite、customer_list_contacts、customer_resolve_contact_request、
--     customer_remove_contact、customer_leave_member、customer_transfer_primary、customer_set_my_contact_phone
--   anon + authenticated(IP 10 分鐘 30 次):customer_peek_contact_invite
--   後台(只 grant authenticated;函式內擋 can_manage_members):
--     list_member_contacts、merchant_set_primary_contact、merchant_remove_member_contact、
--     merchant_resolve_contact_request、search_members_by_contact_phone
--   service_role:internal_customer_contact_invite_claim
--
-- 鎖順序(避免互相等待):客戶帳號鎖(advisory)→ 會員列 for update → 申請 / 邀請列 for update。
-- 函式本體內不寫註解(md5(prosrc) 指紋比對才穩定),說明寫在函式上方。

-- ═════════════════════════════════════════════════════════════════════════
-- private.contact_user_lock(p_merchant_id, p_user_id)
--   跟 customer_complete_profile 用同一個鎖鍵(c2_profile:店:帳號),同一個帳號在同一間店的
--   「加入 / 申請 / 接受邀請 / 被同意」全部排隊。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.contact_user_lock(p_merchant_id uuid, p_user_id uuid)
returns void
language sql
volatile
security definer
set search_path = public
as $$
  select pg_advisory_xact_lock(hashtextextended('c2_profile:' || p_merchant_id::text || ':' || p_user_id::text, 0));
$$;
revoke execute on function private.contact_user_lock(uuid, uuid) from public, anon, authenticated;
grant execute on function private.contact_user_lock(uuid, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.member_sync_primary(p_member_id)
--   有 active 主要聯絡人 ⇒ members.user_id = 他、line_user_id = 他的 LINE userId、line_bound = true、
--     identity_* 用 coalesce 補(同第 2 批 link_customer_to_member);同店其他會員佔著這個 user_id ⇒ 先清成 null
--     (members_merchant_id_user_id_idx 不分狀態)。
--   沒有 ⇒ user_id / line_user_id 清空、line_bound = false(H10「只有自己一位時退出」)。
--   只在主要聯絡人有變動的流程呼叫(呼叫端已鎖會員列)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.member_sync_primary(p_member_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_member public.members;
  v_user_id uuid;
  v_sub text;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found then
    return;
  end if;
  select c.user_id into v_user_id
  from public.member_customer_contacts c
  where c.member_id = p_member_id and c.is_primary and c.status = 'active';

  if v_user_id is not null then
    select i.line_sub into v_sub from public.customer_line_identities i where i.user_id = v_user_id;
    update public.members
       set user_id = null
     where merchant_id = v_member.merchant_id and user_id = v_user_id and id <> p_member_id;
    update public.members
       set user_id = v_user_id,
           line_user_id = v_sub,
           line_bound = true,
           identity_verified_at = coalesce(identity_verified_at, now()),
           identity_verified_via = coalesce(identity_verified_via, 'line'),
           identity_first_verified_at = coalesce(identity_first_verified_at, now())
     where id = p_member_id;
  else
    update public.members
       set user_id = null,
           line_user_id = null,
           line_bound = false
     where id = p_member_id
       and (user_id is not null or line_user_id is not null or line_bound);
  end if;
end;
$$;
revoke execute on function private.member_sync_primary(uuid) from public, anon, authenticated;
grant execute on function private.member_sync_primary(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.member_contact_add(p_member_id, p_user_id, p_is_primary, p_joined_via, p_contact_phone) returns uuid
--   新增聯絡人的唯一入口。呼叫端要先拿 contact_user_lock、鎖會員列,並先檢查好業務規則;這裡是最後一道防線:
--   1. 這個帳號在這間店「已失效」的聯絡人列(會員被刪除 / 搬到別店)⇒ 標 removed(stale)
--   2. 這個帳號在這間店還是某位會員的 active 聯絡人 ⇒ raise(already_member_elsewhere)
--   3. 會員 active 聯絡人已 10 位 ⇒ raise(contact_limit);要當主要但已有主要 ⇒ raise
--   4. 新增;主要 ⇒ member_sync_primary
--   5. 這個帳號在這間店的待處理申請 ⇒ cancelled;邀請保留列刪掉
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.member_contact_add(
  p_member_id uuid, p_user_id uuid, p_is_primary boolean, p_joined_via text, p_contact_phone text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_member public.members;
  v_id uuid;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found or v_member.status <> 'active' then
    raise exception '找不到這位會員。' using errcode = 'P0002';
  end if;

  update public.member_customer_contacts c
     set status = 'removed', is_primary = false, removed_at = now(), removed_via = 'stale'
   where c.merchant_id = v_member.merchant_id
     and c.user_id = p_user_id
     and c.status = 'active'
     and not exists (
       select 1 from public.members m
       where m.id = c.member_id and m.status = 'active' and m.merchant_id = c.merchant_id
     );

  if exists (
    select 1 from public.member_customer_contacts c
    where c.merchant_id = v_member.merchant_id and c.user_id = p_user_id and c.status = 'active'
  ) then
    raise exception '這個 LINE 已經是這間店另一位會員的聯絡人。' using errcode = 'P0001', hint = 'already_member_elsewhere';
  end if;

  if (select count(*) from public.member_customer_contacts c
      where c.member_id = p_member_id and c.status = 'active') >= 10 then
    raise exception '這位會員的聯絡人已經額滿。' using errcode = 'P0001', hint = 'contact_limit';
  end if;

  if p_is_primary and exists (
    select 1 from public.member_customer_contacts c
    where c.member_id = p_member_id and c.is_primary and c.status = 'active'
  ) then
    raise exception '這位會員已經有主要聯絡人。' using errcode = 'P0001', hint = 'primary_exists';
  end if;

  insert into public.member_customer_contacts (merchant_id, member_id, user_id, is_primary, contact_phone, joined_via)
  values (v_member.merchant_id, p_member_id, p_user_id, p_is_primary,
          case when p_is_primary then null else p_contact_phone end, p_joined_via)
  returning id into v_id;

  if p_is_primary then
    perform private.member_sync_primary(p_member_id);
  end if;

  update public.member_contact_requests
     set status = 'cancelled', resolved_at = now(), resolved_by_role = 'system'
   where merchant_id = v_member.merchant_id and user_id = p_user_id and status = 'pending';
  delete from public.member_contact_invite_claims
   where merchant_id = v_member.merchant_id and user_id = p_user_id;

  return v_id;
end;
$$;
revoke execute on function private.member_contact_add(uuid, uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function private.member_contact_add(uuid, uuid, boolean, text, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.member_contact_remove(p_contact_id, p_actor uuid, p_via text, p_block boolean)
--   標 removed(主要聯絡人也一起取消主要;要換主要由呼叫端先做)。p_block ⇒ 寫 customer_member_link_blocks。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.member_contact_remove(p_contact_id uuid, p_actor uuid, p_via text, p_block boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.member_customer_contacts;
begin
  update public.member_customer_contacts
     set status = 'removed', is_primary = false, removed_at = now(), removed_by_user_id = p_actor, removed_via = p_via
   where id = p_contact_id and status = 'active'
  returning * into v_c;
  if v_c.id is null then
    return;
  end if;
  if p_block then
    insert into public.customer_member_link_blocks (member_id, user_id, merchant_id, created_by_user_id)
    values (v_c.member_id, v_c.user_id, v_c.merchant_id, p_actor)
    on conflict (member_id, user_id) do nothing;
  end if;
end;
$$;
revoke execute on function private.member_contact_remove(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function private.member_contact_remove(uuid, uuid, text, boolean) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.member_id_by_contact_phone(p_merchant_id, p_phone_normalized) returns uuid
--   寫成 plpgsql(不是 language sql):SQL 函式會被內嵌進呼叫端快取的計畫,同一交易內 drop index(pgTAP 模擬舊資料)
--   後計畫沒有失效 ⇒ could not open relation。phone_in_use_elsewhere 同理。
--   這支(已正規化)電話是哪一位 active 會員的 active 聯絡人電話;沒有 ⇒ null。多位時取最早加入的那一列。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.member_id_by_contact_phone(p_merchant_id uuid, p_phone_normalized text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return (
    select c.member_id
    from public.member_customer_contacts c
    join public.members m on m.id = c.member_id
    where c.merchant_id = p_merchant_id
      and c.status = 'active'
      and c.contact_phone = p_phone_normalized
      and p_phone_normalized is not null
      and m.status = 'active'
      and m.merchant_id = c.merchant_id
    order by c.created_at, c.id
    limit 1
  );
end;
$$;
revoke execute on function private.member_id_by_contact_phone(uuid, text) from public, anon, authenticated;
grant execute on function private.member_id_by_contact_phone(uuid, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.phone_in_use_elsewhere(p_merchant_id, p_phone_normalized, p_member_id) returns boolean
--   H08:這支電話是不是這間店「另一位」active 會員的電話,或另一位會員的 active 聯絡人電話。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.phone_in_use_elsewhere(p_merchant_id uuid, p_phone_normalized text, p_member_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
           select 1 from public.members m
           where m.merchant_id = p_merchant_id and m.status = 'active'
             and m.id is distinct from p_member_id
             and private.normalize_phone(m.phone) = p_phone_normalized
         )
      or exists (
           select 1 from public.member_customer_contacts c
           join public.members m on m.id = c.member_id
           where c.merchant_id = p_merchant_id and c.status = 'active'
             and c.contact_phone = p_phone_normalized
             and c.member_id is distinct from p_member_id
             and m.status = 'active' and m.merchant_id = c.merchant_id
         );
end;
$$;
revoke execute on function private.phone_in_use_elsewhere(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.phone_in_use_elsewhere(uuid, text, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.assert_phone_not_member_contact(p_merchant_id, p_phone, p_exclude_member_id)
--   K03(Q2 = A):這支電話是「另一位」會員的聯絡人電話 ⇒ 擋下,提示直接選那位會員(不另建重複會員)。
--   create_member / update_member / reactivate_member 呼叫;create_booking、update_booking(換電話)、
--   會員匯入都經過 create_member / update_member,自動套用。訊息帶會員姓名(跟既有 #931 撞號訊息同一層級,只有後台看得到)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.assert_phone_not_member_contact(p_merchant_id uuid, p_phone text, p_exclude_member_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member_id uuid;
  v_name text;
begin
  v_member_id := private.member_id_by_contact_phone(p_merchant_id, private.normalize_phone(p_phone));
  if v_member_id is null or v_member_id = p_exclude_member_id then
    return;
  end if;
  select m.name into v_name from public.members m where m.id = v_member_id;
  raise exception '這支電話是會員「%」的聯絡人電話，請直接選擇這位會員，不要另外建立新會員。',
    regexp_replace(coalesce(v_name, ''), E'[\r\n\t]+', ' ', 'g')
    using errcode = 'P0001', hint = 'phone_is_member_contact';
end;
$$;
revoke execute on function private.assert_phone_not_member_contact(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.assert_phone_not_member_contact(uuid, text, uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.contact_invite_valid_id(p_merchant_id, p_token_hash) returns uuid
--   有效 = 這間店、沒用過、沒撤銷、沒過期、會員 active 且還在這間店。其他 ⇒ null。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.contact_invite_valid_id(p_merchant_id uuid, p_token_hash text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.id
  from public.member_contact_invites i
  join public.members m on m.id = i.member_id
  where i.token_hash = p_token_hash
    and i.merchant_id = p_merchant_id
    and i.used_at is null
    and i.revoked_at is null
    and i.expires_at > now()
    and m.status = 'active'
    and m.merchant_id = i.merchant_id
$$;
revoke execute on function private.contact_invite_valid_id(uuid, text) from public, anon, authenticated;
grant execute on function private.contact_invite_valid_id(uuid, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- 鈴鐺
--   private.notify_member_managers:收件人同 private.notify_member_line_login_linked
--     (管理員;有「會員管理」權限的在職客服,同帳號已是同店管理員不重寫;服務人員不寫)。
--   private.notify_member_contact_joined:event member_line_login_linked,
--     title「會員新增了聯絡人」、body「〇〇已加入成為會員「△△」的聯絡人。」(〇〇 = LINE 顯示名;去換行)。
--   private.notify_member_contact_request:event member_contact_request,
--     title「有人申請成為會員的聯絡人」、body「有人申請成為會員「△△」的聯絡人。」(不放申請人電話)。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.notify_member_managers(p_member_id uuid, p_event_type text, p_title text, p_body text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if v_merchant_id is null then
    return;
  end if;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select ma.user_id, v_merchant_id, 'admin', ma.id, p_event_type, null, p_title, p_body
  from public.merchant_admins ma
  where ma.merchant_id = v_merchant_id and ma.user_id is not null;

  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select g.user_id, v_merchant_id, 'agent', g.id, p_event_type, null, p_title, p_body
  from public.merchant_agents g
  where g.merchant_id = v_merchant_id
    and g.status = 'active'
    and g.user_id is not null
    and exists (
      select 1 from public.merchant_agent_permissions p
      where p.agent_id = g.id and p.section_key = 'members' and p.granted = true
    )
    and not exists (
      select 1 from public.merchant_admins ma2
      where ma2.merchant_id = v_merchant_id and ma2.user_id = g.user_id
    );
end;
$$;
revoke execute on function private.notify_member_managers(uuid, text, text, text) from public, anon, authenticated;
grant execute on function private.notify_member_managers(uuid, text, text, text) to service_role;

create or replace function private.notify_member_contact_joined(p_member_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_member_name text;
  v_display text;
begin
  select regexp_replace(coalesce(nullif(btrim(m.name), ''), '未填姓名'), E'\r\n|[\r\n\t]', ' ', 'g')
    into v_member_name
  from public.members m where m.id = p_member_id;
  select regexp_replace(coalesce(nullif(btrim(i.display_name), ''), 'LINE 使用者'), E'\r\n|[\r\n\t]', ' ', 'g')
    into v_display
  from public.customer_line_identities i where i.user_id = p_user_id;
  perform private.notify_member_managers(
    p_member_id, 'member_line_login_linked', '會員新增了聯絡人',
    format('%s已加入成為會員「%s」的聯絡人。', coalesce(v_display, 'LINE 使用者'), coalesce(v_member_name, '未填姓名'))
  );
end;
$$;
revoke execute on function private.notify_member_contact_joined(uuid, uuid) from public, anon, authenticated;
grant execute on function private.notify_member_contact_joined(uuid, uuid) to service_role;

create or replace function private.notify_member_contact_request(p_member_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_member_name text;
begin
  select regexp_replace(coalesce(nullif(btrim(m.name), ''), '未填姓名'), E'\r\n|[\r\n\t]', ' ', 'g')
    into v_member_name
  from public.members m where m.id = p_member_id;
  perform private.notify_member_managers(
    p_member_id, 'member_contact_request', '有人申請成為會員的聯絡人',
    format('有人申請成為會員「%s」的聯絡人。', coalesce(v_member_name, '未填姓名'))
  );
end;
$$;
revoke execute on function private.notify_member_contact_request(uuid) from public, anon, authenticated;
grant execute on function private.notify_member_contact_request(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.member_contact_request_create(p_member_id, p_user_id, p_phone_normalized) returns text
--   H04:回 'join_pending' 或 'phone_taken'(這位會員待處理申請已滿 5 筆)。呼叫端已拿 contact_user_lock。
--   同一個帳號同一位會員同一支電話已在等 ⇒ 不重寫、不重發鈴鐺(冪等);否則舊的 ⇒ cancelled,新增一筆 + 鈴鐺。
-- ═════════════════════════════════════════════════════════════════════════
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
  return 'join_pending';
end;
$$;
revoke execute on function private.member_contact_request_create(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.member_contact_request_create(uuid, uuid, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.resolve_contact_request(p_request_id, p_scope_member_id, p_approve, p_actor, p_role) returns jsonb
--   H05 共用核心。p_scope_member_id 不為 null ⇒ 只能處理這位會員的申請(客人版);後台版傳 null(呼叫端已驗權限)。
--   找不到 / 不在範圍 / 不是 pending / 超過 7 天 ⇒ not_found(超過 7 天順手標 expired)。
--   拒絕 ⇒ rejected(不改任何資料)。
--   同意:申請人已是別的會員的 active 聯絡人 ⇒ already_member_elsewhere(申請維持 pending);
--         已經是這位會員的聯絡人 ⇒ 標 approved 回 approved;滿 10 位 ⇒ contact_limit;
--         否則加為第二聯絡人(這位會員沒有主要聯絡人時 = 主要)、contact_phone = 申請電話(跟會員電話不同、
--         也不是別人的電話時)、joined_via = request、鈴鐺「〇〇已加入…」。
-- ═════════════════════════════════════════════════════════════════════════
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
  return jsonb_build_object('state', 'approved');
end;
$$;
revoke execute on function private.resolve_contact_request(uuid, uuid, boolean, uuid, text) from public, anon, authenticated;
grant execute on function private.resolve_contact_request(uuid, uuid, boolean, uuid, text) to service_role;

-- ═════════════════════════════════════════════════════════════════════════
-- private.expire_member_contact_requests()(cron 每小時)
--   pending 超過 7 天 ⇒ expired;過期的邀請保留列刪掉。回改了幾筆申請。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function private.expire_member_contact_requests()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update public.member_contact_requests
     set status = 'expired', resolved_at = now(), resolved_by_role = 'system'
   where status = 'pending' and created_at <= now() - interval '7 days';
  get diagnostics v_count = row_count;
  delete from public.member_contact_invite_claims where expires_at <= now();
  return v_count;
end;
$$;
revoke execute on function private.expire_member_contact_requests() from public, anon, authenticated, service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'member-contact-requests-expire-hourly';
select cron.schedule(
  'member-contact-requests-expire-hourly',
  '41 * * * *',
  $$ select private.expire_member_contact_requests(); $$
);

-- ═════════════════════════════════════════════════════════════════════════
-- 客人函式
-- ═════════════════════════════════════════════════════════════════════════

-- ─── C4-H04 public.customer_cancel_contact_request(p_slug):「改用其他電話」⇒ 取消自己的待處理申請 ───
create or replace function public.customer_cancel_contact_request(p_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_merchant public.merchants;
  v_link text;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return jsonb_build_object('state', 'unavailable');
  end if;
  v_link := private.customer_link_state(v_merchant.id, v_uid);
  if v_link = 'line_login_unavailable' then
    return jsonb_build_object('state', 'unavailable');
  end if;
  if v_link = 'channel_mismatch' then
    return jsonb_build_object('state', 'not_linked');
  end if;
  update public.member_contact_requests
     set status = 'cancelled', resolved_at = now(), resolved_by_user_id = v_uid, resolved_by_role = 'customer'
   where merchant_id = v_merchant.id and user_id = v_uid and status = 'pending';
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.customer_cancel_contact_request(text) from public, anon, authenticated;
grant execute on function public.customer_cancel_contact_request(text) to authenticated;

-- ─── C4-H03 public.customer_create_contact_invite(p_slug)(主要聯絡人)───
--   邀請碼 = 24 bytes 密碼學亂數 → base64url 32 碼;只存 SHA-256。72 小時。
--   滿 10 位聯絡人 ⇒ contact_limit;已有 5 個有效邀請 ⇒ invite_limit。邀請碼只在這次回應出現。
create or replace function public.customer_create_contact_invite(p_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_slug text;
  v_token text;
  v_inv public.member_contact_invites;
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
  if (select count(*) from public.member_customer_contacts c
      where c.member_id = v_ctx.member_id and c.status = 'active') >= 10 then
    return jsonb_build_object('state', 'contact_limit');
  end if;
  if (select count(*) from public.member_contact_invites i
      where i.member_id = v_ctx.member_id and i.used_at is null and i.revoked_at is null and i.expires_at > now()) >= 5 then
    return jsonb_build_object('state', 'invite_limit');
  end if;

  v_token := translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_');
  insert into public.member_contact_invites (merchant_id, member_id, token_hash, created_by_user_id, expires_at)
  values (v_ctx.merchant_id, v_ctx.member_id, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_uid, now() + interval '72 hours')
  returning * into v_inv;

  select booking_slug into v_slug from public.merchants where id = v_ctx.merchant_id;
  return jsonb_build_object(
    'state', 'ok',
    'invite', jsonb_build_object('id', v_inv.id, 'created_at', v_inv.created_at, 'expires_at', v_inv.expires_at),
    'path', '/booking/' || v_slug || '/invite/' || v_token
  );
end;
$$;
revoke execute on function public.customer_create_contact_invite(text) from public, anon, authenticated;
grant execute on function public.customer_create_contact_invite(text) to authenticated;

-- ─── C4-H03 public.customer_revoke_contact_invite(p_slug, p_invite_id)(主要聯絡人)───
create or replace function public.customer_revoke_contact_invite(p_slug text, p_invite_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_id uuid;
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
  update public.member_contact_invites
     set revoked_at = now(), revoked_by_user_id = v_uid
   where id = p_invite_id and member_id = v_ctx.member_id
     and used_at is null and revoked_at is null and expires_at > now()
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('state', 'not_found');
  end if;
  delete from public.member_contact_invite_claims where invite_id = v_id;
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.customer_revoke_contact_invite(text, uuid) from public, anon, authenticated;
grant execute on function public.customer_revoke_contact_invite(text, uuid) to authenticated;

-- ─── C4-H06 public.customer_peek_contact_invite(p_slug, p_token)(anon + authenticated)───
--   同 IP 10 分鐘 30 次(拿不到 IP 不限制,同 enforce_public_rate_limit)。
--   店家不存在 / 停用 / 沒啟用 LINE 登入 ⇒ unavailable;其他一律 valid / invalid + 店名,不回會員任何資料。
create or replace function public.customer_peek_contact_invite(p_slug text, p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_ip text;
  v_merchant public.merchants;
  v_valid boolean := false;
begin
  v_ip := private.request_client_ip();
  if v_ip is not null and not private.rate_limit_hit('c4_invite_peek', 'ip:' || v_ip, interval '10 minutes', 30) then
    raise exception '操作太頻繁，請稍後再試' using errcode = 'P0001', hint = 'rate_limited';
  end if;

  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active'
     or not exists (select 1 from public.merchant_line_login_configs c where c.merchant_id = v_merchant.id and c.enabled) then
    return jsonb_build_object('state', 'unavailable');
  end if;

  if p_token is not null and p_token ~ '^[A-Za-z0-9_-]{32,128}$' then
    v_valid := private.contact_invite_valid_id(v_merchant.id, encode(sha256(convert_to(p_token, 'UTF8')), 'hex')) is not null;
  end if;
  return jsonb_build_object('state', case when v_valid then 'valid' else 'invalid' end, 'merchant_name', v_merchant.name);
end;
$$;
revoke execute on function public.customer_peek_contact_invite(text, text) from public, anon, authenticated;
grant execute on function public.customer_peek_contact_invite(text, text) to anon, authenticated;

-- ─── C4-H06 public.internal_customer_contact_invite_claim(p_merchant_id, p_user_id, p_token_hash)(service_role)───
--   Edge customer-line-login complete(purpose = invite)登入成功後呼叫:邀請有效 ⇒ 保留給這個客戶帳號 30 分鐘。
create or replace function public.internal_customer_contact_invite_claim(p_merchant_id uuid, p_user_id uuid, p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_invite_id uuid;
begin
  if p_merchant_id is null or p_user_id is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or not exists (
       select 1 from auth.users u
       where u.id = p_user_id and coalesce(u.raw_app_meta_data ->> 'account_type', '') = 'customer'
     ) then
    return jsonb_build_object('state', 'invalid');
  end if;
  v_invite_id := private.contact_invite_valid_id(p_merchant_id, p_token_hash);
  if v_invite_id is null then
    delete from public.member_contact_invite_claims where user_id = p_user_id and merchant_id = p_merchant_id;
    return jsonb_build_object('state', 'invalid');
  end if;
  insert into public.member_contact_invite_claims (user_id, merchant_id, invite_id, expires_at)
  values (p_user_id, p_merchant_id, v_invite_id, now() + interval '30 minutes')
  on conflict (user_id, merchant_id) do update
    set invite_id = excluded.invite_id, created_at = now(), expires_at = excluded.expires_at;
  return jsonb_build_object('state', 'valid');
end;
$$;
revoke execute on function public.internal_customer_contact_invite_claim(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.internal_customer_contact_invite_claim(uuid, uuid, text) to service_role;

-- ─── C4-H07 public.customer_accept_contact_invite(p_slug, p_token, p_phone, p_agree_policy)───
--   p_token = 邀請碼原文(客人本來就登入);null ⇒ 用 LINE 登入回來時伺服器保留的邀請(claim)。
--   順序:客戶帳號 → 店家 / channel → 同意 → 電話格式 → 帳號鎖 → 邀請(鎖列、重驗)→ 會員鎖 →
--     已是這位會員聯絡人 ⇒ linked(邀請不消耗)/ 別的會員 ⇒ already_member_elsewhere → 封鎖 ⇒ invalid →
--     10 位 ⇒ contact_limit → 電話(H08)→ 加入(沒有主要聯絡人時 = 主要)→ 邀請標用過 → 同意紀錄 → 鈴鐺。
create or replace function public.customer_accept_contact_invite(p_slug text, p_token text, p_phone text, p_agree_policy boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_merchant public.merchants;
  v_link text;
  v_phone_norm text;
  v_invite_id uuid;
  v_inv public.member_contact_invites;
  v_member public.members;
  v_existing uuid;
  v_contact_phone text;
  v_phone_result text := 'none';
  v_has_primary boolean;
  v_policy_enabled boolean;
  v_policy_hash text;
begin
  if v_uid is null or not private.is_customer_account() then
    raise exception '這個功能只給用 LINE 登入的客人使用。' using errcode = '42501', hint = 'not_customer';
  end if;
  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return jsonb_build_object('state', 'unavailable');
  end if;
  v_link := private.customer_link_state(v_merchant.id, v_uid);
  if v_link = 'line_login_unavailable' then
    return jsonb_build_object('state', 'unavailable');
  end if;
  if v_link = 'channel_mismatch' then
    return jsonb_build_object('state', 'channel_mismatch');
  end if;
  if p_agree_policy is not true then
    raise exception '請先勾選同意會員政策與隱私權政策。' using errcode = '22023', hint = 'policy_not_agreed';
  end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    if not private.is_valid_customer_phone(btrim(p_phone)) then
      raise exception '電話格式不正確。手機請填 09 開頭共 10 碼，市話請連同區碼填 9~10 碼，不用填分機。'
        using errcode = '22023', hint = 'invalid_phone';
    end if;
    v_phone_norm := private.normalize_phone(btrim(p_phone));
  end if;

  perform private.contact_user_lock(v_merchant.id, v_uid);

  if p_token is not null then
    if p_token ~ '^[A-Za-z0-9_-]{32,128}$' then
      v_invite_id := private.contact_invite_valid_id(v_merchant.id, encode(sha256(convert_to(p_token, 'UTF8')), 'hex'));
    end if;
  else
    select cl.invite_id into v_invite_id
    from public.member_contact_invite_claims cl
    where cl.user_id = v_uid and cl.merchant_id = v_merchant.id and cl.expires_at > now();
  end if;
  if v_invite_id is null then
    return jsonb_build_object('state', 'invalid');
  end if;

  select * into v_inv from public.member_contact_invites where id = v_invite_id;
  select * into v_member from public.members where id = v_inv.member_id for update;
  select * into v_inv from public.member_contact_invites where id = v_invite_id for update;
  if v_inv.used_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now()
     or v_inv.merchant_id <> v_merchant.id or v_member.status <> 'active' or v_member.merchant_id <> v_merchant.id then
    return jsonb_build_object('state', 'invalid');
  end if;

  select c.member_id into v_existing from private.customer_member_of(v_merchant.id, v_uid) c;
  if v_existing = v_member.id then
    delete from public.member_contact_invite_claims where user_id = v_uid and merchant_id = v_merchant.id;
    return jsonb_build_object('state', 'linked', 'phone_result', 'none');
  end if;
  if v_existing is not null then
    return jsonb_build_object('state', 'already_member_elsewhere');
  end if;
  if exists (select 1 from public.customer_member_link_blocks b where b.member_id = v_member.id and b.user_id = v_uid) then
    return jsonb_build_object('state', 'invalid');
  end if;
  if (select count(*) from public.member_customer_contacts c
      where c.member_id = v_member.id and c.status = 'active') >= 10 then
    return jsonb_build_object('state', 'contact_limit');
  end if;

  if v_phone_norm is not null then
    perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_merchant.id::text || ':' || v_phone_norm, 0));
    if v_phone_norm = private.normalize_phone(v_member.phone) then
      v_phone_result := 'same_as_member';
    elsif private.phone_in_use_elsewhere(v_merchant.id, v_phone_norm, v_member.id) then
      v_phone_result := 'in_use';
    else
      v_contact_phone := v_phone_norm;
      v_phone_result := 'saved';
    end if;
  end if;

  v_has_primary := exists (
    select 1 from public.member_customer_contacts c
    where c.member_id = v_member.id and c.is_primary and c.status = 'active'
  );
  perform private.member_contact_add(v_member.id, v_uid, not v_has_primary, 'invite', v_contact_phone);
  if not v_has_primary then
    v_phone_result := case when v_phone_result = 'saved' then 'none' else v_phone_result end;
  end if;

  update public.member_contact_invites set used_at = now(), used_by_user_id = v_uid where id = v_invite_id;
  delete from public.member_contact_invite_claims where invite_id = v_invite_id;

  select coalesce(ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null, false),
         case when ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null
              then md5(ms.policy_content) else null end
    into v_policy_enabled, v_policy_hash
  from public.merchant_member_settings ms where ms.merchant_id = v_merchant.id;
  insert into public.customer_policy_consents (
    merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
  ) values (
    v_merchant.id, v_uid, v_member.id, v_phone_norm, 'line_login', coalesce(v_policy_enabled, false), v_policy_hash, '2026-10-08'
  );

  perform private.notify_member_contact_joined(v_member.id, v_uid);
  return jsonb_build_object('state', 'linked', 'phone_result', v_phone_result);
end;
$$;
revoke execute on function public.customer_accept_contact_invite(text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.customer_accept_contact_invite(text, text, text, boolean) to authenticated;

-- ─── C4-H09 public.customer_list_contacts(p_slug)───
--   contact_phone:主要聯絡人看得到第二聯絡人的;第二聯絡人只看得到自己的;主要聯絡人自己那列一律 null。
--   requests / invites 只給主要聯絡人。不回 user_id / LINE userId。
create or replace function public.customer_list_contacts(p_slug text)
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

  return jsonb_build_object(
    'state', 'ok',
    'me', jsonb_build_object('contact_id', v_ctx.contact_id, 'is_primary', v_ctx.is_primary),
    'contacts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id,
               'line_display_name', i.display_name,
               'line_picture_url', i.picture_url,
               'is_primary', c.is_primary,
               'is_me', c.user_id = v_uid,
               'contact_phone', case when c.is_primary then null
                                     when v_ctx.is_primary or c.user_id = v_uid then c.contact_phone
                                     else null end,
               'joined_at', c.created_at
             ) order by c.is_primary desc, c.created_at, c.id)
      from public.member_customer_contacts c
      left join public.customer_line_identities i on i.user_id = c.user_id
      where c.member_id = v_ctx.member_id and c.status = 'active'
    ), '[]'::jsonb),
    'requests', case when v_ctx.is_primary then coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', r.id,
               'line_display_name', i.display_name,
               'line_picture_url', i.picture_url,
               'phone', r.phone_normalized,
               'created_at', r.created_at
             ) order by r.created_at, r.id)
      from public.member_contact_requests r
      left join public.customer_line_identities i on i.user_id = r.user_id
      where r.member_id = v_ctx.member_id and r.status = 'pending' and r.created_at > now() - interval '7 days'
    ), '[]'::jsonb) else '[]'::jsonb end,
    'invites', case when v_ctx.is_primary then coalesce((
      select jsonb_agg(jsonb_build_object('id', iv.id, 'created_at', iv.created_at, 'expires_at', iv.expires_at)
                       order by iv.created_at, iv.id)
      from public.member_contact_invites iv
      where iv.member_id = v_ctx.member_id and iv.used_at is null and iv.revoked_at is null and iv.expires_at > now()
    ), '[]'::jsonb) else '[]'::jsonb end,
    'limits', jsonb_build_object('max_contacts', 10, 'max_invites', 5)
  );
end;
$$;
revoke execute on function public.customer_list_contacts(text) from public, anon, authenticated;
grant execute on function public.customer_list_contacts(text) to authenticated;

-- ─── C4-H05 public.customer_resolve_contact_request(p_slug, p_request_id, p_approve)(主要聯絡人)───
create or replace function public.customer_resolve_contact_request(p_slug text, p_request_id uuid, p_approve boolean)
returns jsonb
language plpgsql
volatile
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
  if not v_ctx.is_primary then
    raise exception '只有主要聯絡人可以管理聯絡人。' using errcode = '22023', hint = 'not_primary';
  end if;
  if p_request_id is null then
    return jsonb_build_object('state', 'not_found');
  end if;
  return private.resolve_contact_request(p_request_id, v_ctx.member_id, p_approve, v_uid, 'customer');
end;
$$;
revoke execute on function public.customer_resolve_contact_request(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.customer_resolve_contact_request(text, uuid, boolean) to authenticated;

-- ─── C4-H10 public.customer_remove_contact(p_slug, p_contact_id)(主要聯絡人移除第二聯絡人 ⇒ 封鎖)───
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
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.customer_remove_contact(text, uuid) from public, anon, authenticated;
grant execute on function public.customer_remove_contact(text, uuid) to authenticated;

-- ─── C4-H10 public.customer_leave_member(p_slug)(自己退出,不封鎖)───
--   主要聯絡人還有其他聯絡人 ⇒ primary_has_others;只有自己 ⇒ 退出後會員回到「沒有聯絡人」(member_sync_primary 清空)。
create or replace function public.customer_leave_member(p_slug text)
returns jsonb
language plpgsql
volatile
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
  perform 1 from public.members where id = v_ctx.member_id for update;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  if v_ctx.is_primary and exists (
    select 1 from public.member_customer_contacts c
    where c.member_id = v_ctx.member_id and c.status = 'active' and c.id <> v_ctx.contact_id
  ) then
    return jsonb_build_object('state', 'primary_has_others');
  end if;
  perform private.member_contact_remove(v_ctx.contact_id, v_uid, 'self', false);
  if v_ctx.is_primary then
    perform private.member_sync_primary(v_ctx.member_id);
  end if;
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.customer_leave_member(text) from public, anon, authenticated;
grant execute on function public.customer_leave_member(text) to authenticated;

-- ─── C4-H10 public.customer_transfer_primary(p_slug, p_contact_id)(主要聯絡人)───
--   先取消自己的主要、再把對方設為主要(對方 contact_phone 清掉,改用會員電話);會員電話不變;同步 members。
create or replace function public.customer_transfer_primary(p_slug text, p_contact_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_target uuid;
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
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' or not v_ctx.is_primary then
    raise exception '只有主要聯絡人可以管理聯絡人。' using errcode = '22023', hint = 'not_primary';
  end if;
  select c.id into v_target from public.member_customer_contacts c
  where c.id = p_contact_id and c.member_id = v_ctx.member_id and c.status = 'active' and not c.is_primary;
  if v_target is null then
    return jsonb_build_object('state', 'not_found');
  end if;
  update public.member_customer_contacts set is_primary = false where id = v_ctx.contact_id;
  update public.member_customer_contacts set is_primary = true, contact_phone = null where id = v_target;
  perform private.member_sync_primary(v_ctx.member_id);
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.customer_transfer_primary(text, uuid) from public, anon, authenticated;
grant execute on function public.customer_transfer_primary(text, uuid) to authenticated;

-- ─── C4-H08 public.customer_set_my_contact_phone(p_slug, p_phone)(第二聯絡人)───
--   空 ⇒ 清掉;跟會員電話相同 ⇒ 存 null;是別的會員的電話 / 聯絡人電話 ⇒ phone_in_use(不加)。
--   QA 低-1:鎖會員列後重讀身分(跟轉移主要同一把鎖),期間被轉成主要 ⇒ primary_uses_member_phone;UPDATE 加 not is_primary 保險。
create or replace function public.customer_set_my_contact_phone(p_slug text, p_phone text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_ctx record;
  v_norm text;
  v_member_phone text;
begin
  if v_uid is null or not private.is_customer_account() then
    return jsonb_build_object('state', 'not_linked');
  end if;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  if v_ctx.is_primary then
    raise exception '主要聯絡人使用會員電話，要更換請聯絡店家。' using errcode = '22023', hint = 'primary_uses_member_phone';
  end if;
  perform 1 from public.members where id = v_ctx.member_id for update;
  select * into v_ctx from private.customer_me_context(p_slug, v_uid);
  if v_ctx.state <> 'ok' then
    return jsonb_build_object('state', v_ctx.state);
  end if;
  if v_ctx.is_primary then
    raise exception '主要聯絡人使用會員電話，要更換請聯絡店家。' using errcode = '22023', hint = 'primary_uses_member_phone';
  end if;
  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    if not private.is_valid_customer_phone(btrim(p_phone)) then
      raise exception '電話格式不正確。手機請填 09 開頭共 10 碼，市話請連同區碼填 9~10 碼，不用填分機。'
        using errcode = '22023', hint = 'invalid_phone';
    end if;
    v_norm := private.normalize_phone(btrim(p_phone));
    perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_ctx.merchant_id::text || ':' || v_norm, 0));
    select private.normalize_phone(m.phone) into v_member_phone from public.members m where m.id = v_ctx.member_id;
    if v_norm = v_member_phone then
      v_norm := null;
    elsif private.phone_in_use_elsewhere(v_ctx.merchant_id, v_norm, v_ctx.member_id) then
      return jsonb_build_object('state', 'phone_in_use');
    end if;
  end if;
  update public.member_customer_contacts set contact_phone = v_norm where id = v_ctx.contact_id and not is_primary;
  return jsonb_build_object('state', 'ok', 'contact_phone', v_norm);
end;
$$;
revoke execute on function public.customer_set_my_contact_phone(text, text) from public, anon, authenticated;
grant execute on function public.customer_set_my_contact_phone(text, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════
-- 後台(C4-K04、C4-H05 ⚠️範圍 第 4 點、C4-K03)
--   權限一律 private.can_manage_members(會員所屬商家),沒權限 42501。回傳不含 user_id / LINE userId。
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.list_member_contacts(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
               'last_login_at', i.last_login_at
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
    'relink_blocked', exists (select 1 from public.customer_member_link_blocks b where b.member_id = p_member_id)
  );
end;
$$;
revoke execute on function public.list_member_contacts(uuid) from public, anon, authenticated;
grant execute on function public.list_member_contacts(uuid) to authenticated;

create or replace function public.merchant_set_primary_contact(p_contact_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_c public.member_customer_contacts;
  v_merchant_id uuid;
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
    return jsonb_build_object('state', 'ok');
  end if;
  update public.member_customer_contacts set is_primary = false
   where member_id = v_c.member_id and is_primary and status = 'active';
  update public.member_customer_contacts set is_primary = true, contact_phone = null where id = v_c.id;
  perform private.member_sync_primary(v_c.member_id);
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.merchant_set_primary_contact(uuid) from public, anon, authenticated;
grant execute on function public.merchant_set_primary_contact(uuid) to authenticated;

-- 店家移除聯絡人(封鎖)。要移除的是主要聯絡人、還有其他聯絡人 ⇒ 一定要帶 p_new_primary_contact_id(同一個視窗先選)。
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
  return jsonb_build_object('state', 'ok');
end;
$$;
revoke execute on function public.merchant_remove_member_contact(uuid, uuid) from public, anon, authenticated;
grant execute on function public.merchant_remove_member_contact(uuid, uuid) to authenticated;

create or replace function public.merchant_resolve_contact_request(p_request_id uuid, p_approve boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select m.merchant_id into v_merchant_id
  from public.member_contact_requests r join public.members m on m.id = r.member_id
  where r.id = p_request_id;
  if v_merchant_id is null or not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這位會員。' using errcode = '42501';
  end if;
  return private.resolve_contact_request(p_request_id, null, p_approve, auth.uid(), 'store');
end;
$$;
revoke execute on function public.merchant_resolve_contact_request(uuid, boolean) from public, anon, authenticated;
grant execute on function public.merchant_resolve_contact_request(uuid, boolean) to authenticated;

-- C4-K03 會員列表搜尋:數字 4 碼以上,聯絡人電話「含有」即符合;最多 50 筆。
create or replace function public.search_members_by_contact_phone(p_merchant_id uuid, p_term text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_digits text;
begin
  if not private.can_manage_members(p_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;
  v_digits := regexp_replace(coalesce(p_term, ''), '[^0-9]', '', 'g');
  if length(v_digits) < 4 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('member_id', t.member_id, 'contact_phone', t.contact_phone) order by t.created_at, t.member_id)
    from (
      select distinct on (c.member_id) c.member_id, c.contact_phone, c.created_at
      from public.member_customer_contacts c
      join public.members m on m.id = c.member_id
      where c.merchant_id = p_merchant_id and c.status = 'active' and c.contact_phone is not null
        and strpos(c.contact_phone, v_digits) > 0
        and m.merchant_id = p_merchant_id
      order by c.member_id, c.created_at
      limit 50
    ) t
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.search_members_by_contact_phone(uuid, text) from public, anon, authenticated;
grant execute on function public.search_members_by_contact_phone(uuid, text) to authenticated;
