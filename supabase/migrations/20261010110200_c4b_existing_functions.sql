-- 客戶端第 4-B 批(模組 13)— migration 3:改既有函式(多位聯絡人 #1041、K03 第二聯絡人電話)
-- 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先;C4-A02、H02、H04、H06、H10、H11、K03)
-- 介面文件:.project/notes/c4-contract.md 「4-B」章節
--
-- 下面每一支都是「目前資料庫定義(pg_get_functiondef)只改必要的幾行」產生的;權限(proacl)沿用不變
-- (create or replace 不會改 ACL)。唯一改簽名的是 internal_customer_line_login_start(多一個有預設值的參數,
-- 先 drop 舊簽名再建,權限照原本:只給 service_role)。前後指紋見回報。
--
-- 不改:create_booking / update_booking / import_members_batch / preview_booking_points /
--   resolve_booking_member_by_phone(K03 擋重複會員的規則放在它們共同呼叫的 create_member / update_member)。
-- 不改(J03):cancel_booking、staff_cancel_booking、refund_booking_redeem、can_manage_bookings、
--   check_customer_booking_slot、get_public_available_slots、confirm_booking、staff_confirm_booking、
--   resolve_push_recipients、notify_customer_booking_created、internal_customer_cancel_booking、
--   move_booking、update_booking_payment_method。

-- ─── public.internal_customer_line_login_start(C4-H06:多 p_invite_token_hash,存進登入暫存;其他不變)───
drop function if exists public.internal_customer_line_login_start(text, text, text, text, jsonb, text);
create or replace function public.internal_customer_line_login_start(
  p_slug text, p_state_hash text, p_nonce text, p_code_verifier text, p_draft jsonb, p_ip_hash text,
  p_invite_token_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant public.merchants;
  v_cfg public.merchant_line_login_configs;
  v_recent int;
begin
  if p_ip_hash is not null then
    select count(*) into v_recent
    from public.customer_line_login_attempts
    where ip_hash = p_ip_hash and created_at > now() - interval '10 minutes';
    if v_recent >= 30 then
      return jsonb_build_object('status', 'rate_limited');
    end if;
  end if;

  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return jsonb_build_object('status', 'line_login_unavailable');
  end if;
  select * into v_cfg from public.merchant_line_login_configs where merchant_id = v_merchant.id;
  if not found or not v_cfg.enabled then
    return jsonb_build_object('status', 'line_login_unavailable');
  end if;

  if p_invite_token_hash is not null and p_invite_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid_request');
  end if;

  insert into public.customer_line_login_attempts (
    state_hash, merchant_id, channel_id, nonce, code_verifier, draft, ip_hash, expires_at, invite_token_hash
  ) values (
    p_state_hash, v_merchant.id, v_cfg.channel_id, p_nonce, p_code_verifier, p_draft, p_ip_hash,
    now() + interval '10 minutes', p_invite_token_hash
  );

  return jsonb_build_object('status', 'ok', 'channel_id', v_cfg.channel_id);
end;
$$;
comment on function public.internal_customer_line_login_start(text, text, text, text, jsonb, text, text) is 'C2-B01 / C4-H06:Edge Function start 用。檢查 IP 頻率(10 分鐘 30 次)、商家啟用中且有啟用 LINE 登入,寫一列 customer_line_login_attempts(10 分鐘有效)。purpose = invite 時另存邀請碼 SHA-256(不存原文)。只給 service_role。';
revoke execute on function public.internal_customer_line_login_start(text, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.internal_customer_line_login_start(text, text, text, text, jsonb, text, text) to service_role;

-- ─── private.customer_link_state(C4-A02:linked 改看聯絡人表) ───
CREATE OR REPLACE FUNCTION private.customer_link_state(p_merchant_id uuid, p_user_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if exists (select 1 from private.customer_member_of(p_merchant_id, p_user_id)) then
    return 'linked';
  end if;
  return 'needs_profile';
end;
$function$;

-- ─── private.customer_member_of(C4-A02:改查 member_customer_contacts) ───
CREATE OR REPLACE FUNCTION private.customer_member_of(p_merchant_id uuid, p_user_id uuid)
 RETURNS TABLE(member_id uuid, contact_id uuid, is_primary boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.member_id, c.id, c.is_primary
  from public.member_customer_contacts c
  join public.members m on m.id = c.member_id
  where c.merchant_id = p_merchant_id
    and c.user_id = p_user_id
    and p_user_id is not null
    and c.status = 'active'
    and m.status = 'active'
    and m.merchant_id = c.merchant_id
  order by c.created_at, c.id
  limit 1
$function$;

-- ─── public.get_customer_session_state(C4-H11:linked 走聯絡人、第二聯絡人電話、is_primary;新增 join_pending;needs_profile 多 join_request) ───
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
  v_ctx record;
  v_req public.member_contact_requests;
  v_contact_phone text;
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

  select * into v_ctx from private.customer_member_of(v_merchant.id, v_uid);
  if v_ctx.member_id is not null then
    select * into v_member from public.members where id = v_ctx.member_id;
    select c.contact_phone into v_contact_phone from public.member_customer_contacts c where c.id = v_ctx.contact_id;
    return jsonb_build_object(
      'state', 'linked',
      'line_display_name', v_ident.display_name,
      'line_picture_url', v_ident.picture_url,
      'is_primary', v_ctx.is_primary,
      'member', jsonb_build_object('name', v_member.name, 'phone', coalesce(v_contact_phone, v_member.phone), 'address', v_member.address)
    );
  end if;

  select * into v_req from public.member_contact_requests r
  where r.merchant_id = v_merchant.id and r.user_id = v_uid
  order by r.created_at desc, r.id desc
  limit 1;
  if v_req.id is not null and v_req.status = 'pending' and v_req.created_at > now() - interval '7 days' then
    return jsonb_build_object(
      'state', 'join_pending',
      'line_display_name', v_ident.display_name,
      'line_picture_url', v_ident.picture_url,
      'request', jsonb_build_object('id', v_req.id, 'phone', v_req.phone_normalized, 'created_at', v_req.created_at)
    );
  end if;

  return jsonb_build_object(
    'state', 'needs_profile',
    'line_display_name', v_ident.display_name,
    'line_picture_url', v_ident.picture_url,
    'join_request', case
      when v_req.id is not null and v_req.status = 'rejected' and v_req.resolved_at > now() - interval '7 days'
        then jsonb_build_object('status', 'rejected', 'resolved_at', v_req.resolved_at)
      when v_req.id is not null and v_req.status = 'expired' and v_req.resolved_at > now() - interval '7 days'
        then jsonb_build_object('status', 'expired', 'resolved_at', v_req.resolved_at)
      when v_req.id is not null and v_req.status = 'pending'
        then jsonb_build_object('status', 'expired', 'resolved_at', v_req.created_at + interval '7 days')
      else null end
  );
end;
$function$;

-- ─── private.link_customer_to_member(C4-H02:接上 = 新增主要聯絡人;members 由 member_sync_primary 同步。p_line_sub 保留簽名,LINE userId 改由客戶帳號身分表取) ───
CREATE OR REPLACE FUNCTION private.link_customer_to_member(p_member_id uuid, p_user_id uuid, p_line_sub text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if not found then
    raise exception '找不到這位會員。' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.member_customer_contacts c
    where c.member_id = p_member_id and c.status = 'active' and c.user_id <> p_user_id
  ) then
    raise exception '這位會員已經有其他帳號接上。' using errcode = '42501';
  end if;
  if exists (select 1 from public.customer_member_link_blocks b where b.member_id = p_member_id and b.user_id = p_user_id) then
    raise exception '這位會員目前不能自動接上，請聯繫店家。' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.member_customer_contacts c
    where c.member_id = p_member_id and c.status = 'active' and c.user_id = p_user_id
  ) then
    return;
  end if;

  perform private.member_contact_add(p_member_id, p_user_id, true, 'first_login', null);
  perform private.notify_member_line_login_linked(p_member_id);
end;
$function$;

-- ─── public.customer_complete_profile(C4-H02 第一個人 = 主要聯絡人;C4-H04 已有聯絡人 ⇒ 申請;K03 聯絡人電話視同會員電話;封鎖不再限定 user_id 為 null) ───
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
  select m.* into v_linked from public.members m
  where m.id = (select c.member_id from private.customer_member_of(v_merchant.id, v_uid) c);
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
    select * into v_member from public.members m
    where m.id = private.member_id_by_contact_phone(v_merchant.id, v_phone);
  end if;

  if not found then
    -- 新電話 ⇒ 直接相信,沿用 create_member 建會員。姓名空白時用 LINE 顯示名稱。
    v_name := coalesce(v_name, left(nullif(btrim(coalesce(v_ident.display_name, '')), ''), 50), 'LINE 會員');
    begin
      v_new := private.create_member_as_customer_flow(v_merchant.id, v_name, v_phone);
    exception when others then
      -- 🔴 不把 create_member 的原文帶出去(撞號時原文會帶出別的會員姓名,C2-F06)。
      raise exception '系統忙碌，請稍後再試一次。' using errcode = 'P0001', hint = 'retry';
    end;

    perform private.member_contact_add(v_new.id, v_uid, true, 'first_login', null);

    v_member_id_for_consent := v_new.id;
    v_result := jsonb_build_object('state', 'linked', 'created', true);
  elsif exists (select 1 from public.customer_member_link_blocks b
                where b.member_id = v_member.id and b.user_id = v_uid) then
    -- [c2-relink] 店家解除過「這個客戶帳號 ↔ 這位會員」⇒ 這個帳號不能自動接回;跟 phone_taken 同一個回應(不帶任何會員資料)。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', 'phone_taken');
  elsif not exists (select 1 from public.member_customer_contacts c
                    where c.member_id = v_member.id and c.status = 'active') then
    -- 零之二 第 1 點:既有會員還沒有客戶帳號接上 ⇒ 直接接上(+ 鈴鐺)。
    perform private.link_customer_to_member(v_member.id, v_uid, v_ident.line_sub);
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked', 'existing', true);
  elsif exists (select 1 from public.member_customer_contacts c
               where c.member_id = v_member.id and c.status = 'active' and c.user_id = v_uid) then
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked');
  else
    -- 零之二 第 1 點:已經有別的客戶帳號接上 ⇒ 不取代。回應不帶任何會員資料(C2-F06)。
    -- [c4b] C4-H04:改成送出加入申請(join_pending);那位會員待處理申請已滿 5 筆 ⇒ phone_taken。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', private.member_contact_request_create(v_member.id, v_uid, v_phone));
  end if;

  -- 9. 每次呼叫都寫一筆同意紀錄(也是 Q6 的計數來源)。
  insert into public.customer_policy_consents (
    merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
  ) values (
    v_merchant.id, v_uid, v_member_id_for_consent, v_phone, 'line_login', v_policy_enabled, v_policy_hash, '2026-10-08'
  );

  return v_result;
end;
$function$;

-- ─── public.internal_customer_submit_booking(C4-H11:會員身分走 customer_member_of;客人電話 = 下單聯絡人自己的電話優先;訪客電話是聯絡人電話 ⇒ 掛那位會員) ───
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

-- ─── public.unbind_line_account(C4-H11:member 分支多清掉全部聯絡人 + 全部封鎖;其他分支不變) ───
CREATE OR REPLACE FUNCTION public.unbind_line_account(p_target_type text, p_target_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_self_user_id uuid;
begin
  if p_target_type not in ('admin', 'agent', 'staff', 'member') then
    raise exception '不支援的綁定目標類型：%', p_target_type;
  end if;

  if p_target_type = 'admin' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_admins where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位管理員';
    end if;
    -- ⚠️ 三值邏輯防禦(三個分支寫法刻意完全一致,見 20260924040900 檔頭§「順帶修掉的既有漏洞」):
    --    裸寫 `or v_self_user_id = auth.uid()` 在兩邊都是 NULL 時,該比較的結果是 NULL,
    --    `not (false or NULL)` = NULL,而 `if NULL then` 不成立 → raise 不會觸發、權限檢查被靜默
    --    跳過。不要因為覺得囉唆而把這兩個 is not null 簡化掉。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_admins set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'agent' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_agents where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位客服';
    end if;
    -- ⚠️ 三值邏輯防禦 —— 這一條是真的在修一個既有漏洞:merchant_agents.user_id 是 nullable
    --    (login 尚未註冊的「已邀請」客服就是 NULL)。不要簡化掉這兩個 is not null。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_agents set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'staff' then
    -- 2026-09-24 放寬(使用者裁決「要讓服務人員自己綁定」):原本只允許 private.is_merchant_admin,
    -- 現在加上「本人」。「本人」一律用 auth.uid() 對照 merchant_staff.user_id 判斷,
    -- 完全不信任前端傳來的任何 id —— 前端只能指定「要解除哪一列」,而那一列必須是它自己。
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_staff where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位服務人員';
    end if;

    -- ⚠️ 三值邏輯防禦 —— merchant_staff.user_id 是 nullable(login_status = 'not_invited' 的人
    --    還沒有登入帳號)。不要簡化掉這兩個 is not null。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '只有商家管理員或這位服務人員本人可以解除這個 LINE 綁定' using errcode = '42501';
    end if;

    -- 已經完成權限檢查(管理員 or 本人),這是規則 2.9 觸發器
    -- private.protect_merchant_staff_line_binding_columns 明確允許的合法例外路徑。
    -- 旗標是 transaction-local(set_config 第三參數 true),交易結束就自動失效。
    perform set_config('line_notifications.bypass_staff_binding_guard', 'on', true);
    update public.merchant_staff set line_user_id = null, line_bound = false where id = p_target_id;
    perform set_config('line_notifications.bypass_staff_binding_guard', 'off', true);

  elsif p_target_type = 'member' then
    select merchant_id into v_merchant_id from public.members where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位會員';
    end if;
    if not private.can_manage_members(v_merchant_id) then
      raise exception '沒有權限管理這位會員' using errcode = '42501';
    end if;
    -- SPECS-INDEX #910(2026-09-30,使用者裁決 Q2 = (B) 附帶限制):
    --   ・identity_verified_at / identity_verified_via **清成 null** ⇒ 綁定狀態歸零,
    --     名單上變回「尚未驗證」(2026-10-01 修正用詞,舊標籤是「已建立(未綁定)」;狀態名稱
    --     裡不可以有「綁定」二字,文案唯一來源是 memberIdentityStatus.ts),綁定之後才能觸發的
    --     功能(再行銷通知等)碰不到他。
    --   ・🔴 identity_first_verified_at **刻意不寫進這句 UPDATE** ⇒ 第一次完成驗證的時間永久保留。
    --     使用者原話:「如果真的解除綁定,會員資料、紀錄、加入時間也不該清除(僅是綁定狀態
    --     變回未綁定)」。不要「順手」把它一起清掉 —— 那會讓第二次解除綁定時這個時間永久弄丟。
    --   ・會員本人、訂單紀錄、點數餘額、分類帳全部不動,一筆都不刪。
    --   ・[c2] C2-H02(使用者 Q3):同時清 user_id ⇒ 客戶端 LINE 登入一起斷開,客人下次登入要重新填電話。
    --   ・[c2-relink] 被解除的客戶帳號記進封鎖表 ⇒ 這個帳號之後填同一支電話不會自動接回(回 phone_taken);
    --     別的 LINE 帳號照常可以接上。店家用 allow_member_customer_relink 撤銷。
    insert into public.customer_member_link_blocks (member_id, user_id, merchant_id, created_by_user_id)
    select m.id, m.user_id, m.merchant_id, auth.uid()
    from public.members m
    where m.id = p_target_id and m.user_id is not null
    on conflict (member_id, user_id) do nothing;
    -- [c4b] C4-H11:清掉這位會員所有聯絡人並全部封鎖。
    perform 1 from public.members where id = p_target_id for update;
    insert into public.customer_member_link_blocks (member_id, user_id, merchant_id, created_by_user_id)
    select c.member_id, c.user_id, c.merchant_id, auth.uid()
    from public.member_customer_contacts c
    where c.member_id = p_target_id and c.status = 'active'
    on conflict (member_id, user_id) do nothing;
    update public.member_customer_contacts
       set status = 'removed', is_primary = false, removed_at = now(), removed_by_user_id = auth.uid(), removed_via = 'unbind'
     where member_id = p_target_id and status = 'active';
    update public.members
    set line_user_id = null,
        line_bound = false,
        identity_verified_at = null,
        identity_verified_via = null,
        user_id = null
    where id = p_target_id;
  end if;
end;
$function$;

-- ─── private.resolve_guest_member(K03:聯絡人電話 ⇒ 掛那位會員,不另建) ───
CREATE OR REPLACE FUNCTION private.resolve_guest_member(p_merchant_id uuid, p_phone text, p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text := private.normalize_phone(p_phone);
  v_count int;
  v_id uuid;
  v_new public.members;
begin
  if v_phone is null then
    raise exception '請填寫電話。' using errcode = '22023', hint = 'invalid_phone';
  end if;

  select count(*), min(m.id::text)::uuid into v_count, v_id
  from public.members m
  where m.merchant_id = p_merchant_id and m.status = 'active' and private.normalize_phone(m.phone) = v_phone;

  if v_count = 0 then
    v_id := private.member_id_by_contact_phone(p_merchant_id, v_phone);
    if v_id is not null then
      v_count := 1;
    end if;
  end if;

  if v_count = 1 then
    return v_id;   -- 不改任何欄位(#912 / #931)
  elsif v_count >= 2 then
    raise exception '這支電話對到多位會員，請聯絡店家。' using errcode = 'P0001', hint = 'multiple_members';
  end if;

  v_new := private.create_member_as_customer_flow(p_merchant_id, p_name, v_phone);
  return v_new.id;
end;
$function$;

-- ─── public.create_member(K03:撞到會員的聯絡人電話 ⇒ 擋 phone_is_member_contact) ───
CREATE OR REPLACE FUNCTION public.create_member(p_merchant_id uuid, p_name text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_birthday date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_referred_by_member_id uuid DEFAULT NULL::uuid, p_tier_id uuid DEFAULT NULL::uuid)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_referral_code text;
  v_attempt int := 0;
  v_result public.members;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
  v_constraint_name text;
begin
  if not (private.can_manage_members(p_merchant_id) or private.can_manage_bookings(p_merchant_id)) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除(電話這次只當查詢索引,不是必填欄位,見 #614/§10.2)。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)「把 #827 一起修掉」):
  -- 會員電話的格式檢查。規則本體沿用 #822 的 private.is_valid_taiwan_phone(跟 create_booking /
  -- update_booking / 兩支匯入函式同一條規則,不另外寫第二套正規表示式)。
  -- 🔴 必須排在下面 #931 唯一性檢查的**前面**:格式明顯不對的電話應該拿到「格式不正確」這個精準訊息,
  --    而不是先被拿去跟既有會員比對(髒電話正規化之後可能剛好撞到別人,訊息就會完全誤導)。
  -- 電話留空維持合法(#618 之後會員電話是選填),所以是 `p_phone is not null` 才檢查。
  -- 🟢 2026-09-30 唯讀核對:正式庫 119 筆有填電話的會員**全部通過**這條規則(不合格 0 筆),
  --    所以現在補上檢查不會弄壞任何存量資料,也不需要先清資料。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):同商家 + 同一支電話只能有一位 active 會員。
  -- 只比對 status = 'active'(使用者明確裁決:已下架的同號紀錄不擋新建,因為它看不見卻擋得住)。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用這一筆；如果真的是不同的人，請改填另一支電話', v_conflict_name;
    end if;
  end if;

  perform private.assert_phone_not_member_contact(p_merchant_id, p_phone, null);

  if p_referred_by_member_id is not null then
    if not exists (
      select 1 from public.members
      where id = p_referred_by_member_id
        and merchant_id = p_merchant_id
        and status = 'active'
    ) then
      raise exception '找不到指定的推薦人，或推薦人不屬於這間商家/已被下架';
    end if;
  end if;

  -- #615:會員分級。有指定 p_tier_id 時,必須屬於同一商家且 status='active'。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = p_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級，或不屬於這間商家/已下架';
    end if;
  end if;

  loop
    v_referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.members (
        merchant_id, name, phone, email, birthday, notes,
        referred_by_member_id, referral_code, created_by_user_id, tier_id
      ) values (
        p_merchant_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_email, '')), ''), p_birthday, p_notes,
        p_referred_by_member_id, v_referral_code, auth.uid(), p_tier_id
      )
      returning * into v_result;
      exit;
    exception when unique_violation then
      -- SPECS-INDEX #931:先分辨是哪一個約束撞到。不分辨的話,電話撞號會被當成推薦碼撞號,
      -- 重試 5 次之後丟出「產生推薦碼失敗」這個完全誤導的訊息(見本節開頭的說明)。
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'members_merchant_active_phone_uniq' then
        -- 走到這裡代表是併發:上面的事前檢查通過時那一筆還沒 commit。
        -- 重新查一次姓名(這是新的一個敘述,拿到新的 snapshot,所以看得到對方剛 commit 的那一列)。
        select m.name into v_conflict_name
        from public.members m
        where m.merchant_id = p_merchant_id
          and m.status = 'active'
          and private.normalize_phone(m.phone) = v_normalized_phone
        limit 1;

        raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用這一筆；如果真的是不同的人，請改填另一支電話',
          coalesce(v_conflict_name, '(同一時間剛好有人用這支電話建立了會員)');
      end if;

      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise exception '產生推薦碼失敗，請重新再試一次';
      end if;
    end;
  end loop;

  return v_result;
end;
$function$;

-- ─── public.update_member(K03:改成別的會員的聯絡人電話 ⇒ 擋) ───
CREATE OR REPLACE FUNCTION public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid DEFAULT NULL::uuid, p_address text DEFAULT NULL::text)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的兩個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
  v_address text;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)):會員電話的格式檢查,規則與擺放順序的理由
  -- 跟 create_member 那一段完全相同(格式檢查一定要排在唯一性檢查前面)。
  -- ⚠️ 既有的髒電話依使用者裁決不主動清;但只要客服進來編輯這位會員,就會被要求先把電話改正確
  --    (跟 update_booking 對舊訂單的既有處理方式一致)。正式庫目前不合格 0 筆,所以實際上沒有人會遇到。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):改電話時不可以撞到同商家**另一位** active 會員。
  -- `m.id <> p_member_id` 這個排除條件缺一不可 —— 沒有它的話,客服只是進來改個姓名錯字、
  -- 電話原封不動,也會被自己那一列擋下來。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用那一筆；如果真的是不同的人，請改填另一支電話', v_conflict_name;
    end if;
  end if;

  perform private.assert_phone_not_member_contact(v_merchant_id, p_phone, p_member_id);

  -- #615:會員分級,同 create_member 的驗證邏輯。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = v_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級，或不屬於這間商家/已下架';
    end if;
  end if;

  if p_address is not null then
    v_address := nullif(btrim(p_address), '');
    if char_length(coalesce(v_address, '')) > 200 then
      raise exception '地址最多 200 字。' using errcode = '22023', hint = 'invalid_address';
    end if;
  end if;

  update public.members set
    name = btrim(p_name),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    birthday = p_birthday,
    notes = p_notes,
    tier_id = p_tier_id,
    address = case when p_address is null then address else v_address end
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

-- ─── public.reactivate_member(K03:電話已是別的會員的聯絡人電話 ⇒ 不能重新上架) ───
CREATE OR REPLACE FUNCTION public.reactivate_member(p_member_id uuid)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_phone text;
  v_normalized_phone text;
  v_conflict_name text;
begin
  -- 原本只 select merchant_id,這次多取 phone(唯一性檢查要用)。
  select merchant_id, phone into v_merchant_id, v_phone
  from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  -- SPECS-INDEX #931(2026-09-30):重新上架等於讓這一列變成 active,所以要跟「其他 active 會員」
  -- 比對電話。`m.id <> p_member_id` 不可省(否則自己也會被算進去)。
  v_normalized_phone := private.normalize_phone(v_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '不能重新上架：這位會員的電話現在已經有另一位使用中的會員：%。同一間商家底下，一支電話只能有一位會員 —— 請先把其中一邊的電話改掉(或把那一位下架)，再重新上架這一位', v_conflict_name;
    end if;
  end if;

  perform private.assert_phone_not_member_contact(v_merchant_id, v_phone, p_member_id);

  update public.members set status = 'active' where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

-- ─── public.get_members_by_phone(K03:聯絡人電話也比對,多回 matched_contact_phone) ───
CREATE OR REPLACE FUNCTION public.get_members_by_phone(p_merchant_id uuid, p_phone text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- SPECS-INDEX #929:兩個門檻寫成具名常數,不要散在 SQL 裡 —— 以後要調整只會有一個地方。
  c_min_digits constant int := 4;
  c_max_results constant int := 20;
  v_normalized_phone text;
  v_result jsonb;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的客戶' using errcode = '42501';
  end if;

  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is null then
    -- 邊界情況(§10.2.1):電話為空字串/格式不完整(客服可能還在輸入中途),直接回傳空陣列,
    -- 不報錯。
    return '[]'::jsonb;
  end if;

  -- SPECS-INDEX #929 門檻①:少於 c_min_digits 位數字時,跟「還在輸入中途」一樣回空陣列。
  -- 不報錯 —— 客服本來就是一個字一個字打進來的,每打一個字都跳一次錯誤訊息只會很吵。
  if length(v_normalized_phone) < c_min_digits then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'member_id', t.member_id,
        'name', t.name,
        'phone', t.phone,
        'last_booking_date', t.last_booking_date,
        'is_blacklisted', t.is_blacklisted,
        'blacklist_reason', t.blacklist_reason,
        -- SPECS-INDEX #936(2026-10-01):點選候選時要把地址帶進建單表單,但 members 沒有地址欄位
        -- ⇒ 取「這位會員在**本商家**最近一筆有填地址的訂單」的地址;沒有就是 null(前端不動欄位)。
        'last_booking_address', t.last_booking_address,
        'matched_contact_phone', t.matched_contact_phone
      )
      -- 🔴 jsonb_agg 自己的 order by 要跟下面子查詢的 order by 一致,否則「截斷之後留下哪 20 筆」
      --    跟「這 20 筆在畫面上的順序」會是兩套規則,看起來像 bug。
      order by t.exact_match_first, t.last_booking_date desc nulls last, t.name, t.member_id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      m.id as member_id,
      m.name,
      m.phone,
      m.is_blacklisted,
      m.blacklist_reason,
      case when starts_with(private.normalize_phone(m.phone), v_normalized_phone) then null else (
        select c.contact_phone from public.member_customer_contacts c
        where c.member_id = m.id and c.merchant_id = m.merchant_id and c.status = 'active'
          and starts_with(c.contact_phone, v_normalized_phone)
        order by (c.contact_phone = v_normalized_phone) desc, c.created_at, c.id
        limit 1
      ) end as matched_contact_phone,
      -- 0 = 電話完全相等,1 = 只是前綴相符。完全相等的永遠排第一,所以「打完整支號碼」時
      -- 那位會員不可能被 c_max_results 切掉(見檔頭門檻②的說明)。
      case when private.normalize_phone(m.phone) = v_normalized_phone or exists (select 1 from public.member_customer_contacts c where c.member_id = m.id and c.merchant_id = m.merchant_id and c.status = 'active' and c.contact_phone = v_normalized_phone) then 0 else 1 end as exact_match_first,
      (
        select max(b.start_at)
        from public.bookings b
        where b.member_id = m.id
      ) as last_booking_date,
      -- SPECS-INDEX #936:只取**本商家**(b.merchant_id = p_merchant_id)的訂單地址。
      -- 🔴 這個 merchant_id 條件不能拿掉:transfer_members_to_merchant 會把會員搬到別的商家,
      --    那位會員的舊訂單仍然掛在舊商家底下 —— 不加這條,新商家的客服就會在候選清單裡
      --    看到舊商家那邊的客戶地址(跨商家資料外洩,對照 module12_01 的同類斷言)。
      (
        select b.customer_address
        from public.bookings b
        where b.member_id = m.id
          and b.merchant_id = p_merchant_id
          and nullif(btrim(coalesce(b.customer_address, '')), '') is not null
        order by b.start_at desc, b.created_at desc, b.id
        limit 1
      ) as last_booking_address
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.status = 'active'
      -- SPECS-INDEX #929:從「完全相等」改成「前綴相符」。
      -- 用 starts_with() 而不是 `like v_normalized_phone || '%'`:normalize_phone 只會留下數字,
      -- 所以理論上不可能出現 % 或 _ 這種 LIKE 萬用字元,但 starts_with 從根本上就不需要跳脫,
      -- 少一個「哪天正規化規則改了就變成注入面」的隱患。
      and (starts_with(private.normalize_phone(m.phone), v_normalized_phone) or exists (select 1 from public.member_customer_contacts c where c.member_id = m.id and c.merchant_id = m.merchant_id and c.status = 'active' and starts_with(c.contact_phone, v_normalized_phone)))
    order by
      case when private.normalize_phone(m.phone) = v_normalized_phone or exists (select 1 from public.member_customer_contacts c where c.member_id = m.id and c.merchant_id = m.merchant_id and c.status = 'active' and c.contact_phone = v_normalized_phone) then 0 else 1 end,
      (select max(b.start_at) from public.bookings b where b.member_id = m.id) desc nulls last,
      m.name,
      m.id
    limit c_max_results
  ) t;

  return v_result;
end;
$function$;

-- ─── private.customer_booking_view(C4-H10:booked_by) ───
CREATE OR REPLACE FUNCTION private.customer_booking_view(p_booking bookings, p_now timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'booked_by', case
      when p_booking.source = 'customer' and p_booking.created_by_user_id is not null and p_booking.member_id is not null
           and (select count(distinct c.user_id) from public.member_customer_contacts c where c.member_id = p_booking.member_id) >= 2
        then (select i.display_name
              from public.member_customer_contacts c
              join public.customer_line_identities i on i.user_id = c.user_id
              where c.member_id = p_booking.member_id and c.user_id = p_booking.created_by_user_id
              order by c.created_at desc
              limit 1)
      else null end,
    'can_cancel', private.customer_can_cancel(p_booking, p_now),
    'cancel_deadline_at', case when p_booking.status in ('pending_confirmation', 'accepted')
                               then p_booking.start_at - make_interval(hours => v_hours) else null end,
    'cancelled_at', p_booking.cancelled_at
  );
end;
$function$;

-- ─── public.customer_get_member_home(C4-C01:pending_contact_requests 真實值) ───
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
    'pending_contact_requests', case when v_ctx.is_primary then (
      select count(*)::integer from public.member_contact_requests r
      where r.member_id = v_ctx.member_id and r.status = 'pending' and r.created_at > now() - interval '7 days'
    ) else 0 end
  );
end;
$function$;

-- ─── public.customer_get_profile(C4-E01:me.contact_phone 真實值) ───
CREATE OR REPLACE FUNCTION public.customer_get_profile(p_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'contact_phone', case when v_ctx.is_primary then null else (
        select c.contact_phone from public.member_customer_contacts c where c.id = v_ctx.contact_id
      ) end
    ),
    'can_edit', v_ctx.is_primary
  );
end;
$function$;

-- ─── public.internal_customer_line_login_consume(C4-H06:多回 invite_token_hash;login_expired 時帶 purpose:invite) ───
CREATE OR REPLACE FUNCTION public.internal_customer_line_login_consume(p_state_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.customer_line_login_attempts;
  v_draft jsonb;
  v_slug text;
begin
  -- 單次有效:先鎖住、標成已使用、同時把 draft 清掉(個資不留在資料庫),再判斷是否過期。
  select * into v_row
  from public.customer_line_login_attempts
  where state_hash = p_state_hash
  for update;

  if not found then
    -- 偽造 / 已被清理的 state:不回任何店家資訊。
    return jsonb_build_object('status', 'login_expired');
  end if;

  select booking_slug into v_slug from public.merchants where id = v_row.merchant_id;

  if v_row.consumed_at is not null then
    -- [c2-qa] 已用過(例如重新整理 callback 頁):回 slug 讓前端顯示「回店家首頁」。
    return jsonb_build_object('status', 'login_expired', 'slug', v_slug)
      || case when v_row.invite_token_hash is not null then jsonb_build_object('purpose', 'invite') else '{}'::jsonb end;
  end if;

  v_draft := v_row.draft;
  update public.customer_line_login_attempts
     set consumed_at = now(), draft = null
   where state_hash = p_state_hash;

  if v_row.expires_at <= now() then
    return jsonb_build_object('status', 'login_expired', 'slug', v_slug)
      || case when v_row.invite_token_hash is not null then jsonb_build_object('purpose', 'invite') else '{}'::jsonb end;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'merchant_id', v_row.merchant_id,
    'slug', v_slug,
    'channel_id', v_row.channel_id,
    'nonce', v_row.nonce,
    'code_verifier', v_row.code_verifier,
    'draft', v_draft
  ) || case when v_row.invite_token_hash is not null
            then jsonb_build_object('invite_token_hash', v_row.invite_token_hash) else '{}'::jsonb end;
end;
$function$;

