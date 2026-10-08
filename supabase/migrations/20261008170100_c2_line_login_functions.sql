-- 客戶端第 2 批(模組 13)— migration 2:函式
-- 規格書 .project/specs/客戶端第2批-LINE登入與訪客預約.md(「零之二」優先於本文)
-- 前提:20261008170000_c2_line_login_schema.sql 已套用。
--
-- 內容:
--   共用   private.is_customer_account / private.is_valid_customer_phone
--   C2-A02~A04 商家 LINE 登入設定(set / get_status / set_enabled / delete)
--   C2-F02 Edge Function customer-line-login 專用的 internal_* 函式(只給 service_role)
--   C2-C01 get_public_booking_page 多回傳 line_login_enabled、member_policy
--   C2-C03 customer_complete_profile(零之二:新電話直接建會員、既有未接上會員直接接上、已被別人接上回 phone_taken)
--   C2-C05 get_customer_session_state
--   C2-D03 private.link_customer_to_member(簡化:直接接上)+ 鈴鐺 private.notify_member_line_login_linked
--   C2-G02 private.customer_open_booking_count / C2-G03 private.resolve_guest_member
--   C2-H01 create_group_and_merchant / create_merchant_in_group 擋客戶帳號
--   C2-H02 unbind_line_account 的 member 分支多清 user_id
--   C2-H03 get_member_customer_login_status(會員詳細頁「客戶端登入」那一行)
--   C2-C07 consume_line_binding_code 註解登記新路徑(只改 comment,函式本體不動)
--   C2-C04 清理排程(每小時刪 1 天前的登入暫存)
--
-- 🔴 會員建立沿用 public.create_member(規格 C2-C03 第 8 步、C2-G03:「用內部函式包一層,不要複製一份新的建立邏輯」)。
--    create_member 第一行要求 can_manage_members / can_manage_bookings,客人(或第 3 批的訪客)兩者都不是。
--    做法比照 #977 的 miaoyue.staff_order_actor 先例:private.can_manage_members 多一個「交易內標記」分支,
--    標記只由 private.create_member_as_customer_flow 在呼叫 create_member 前設定、呼叫完立刻清掉;
--    該函式只給 postgres 呼叫(三個角色都 revoke)。沒有標記時這一段先比字串就是 false,行為與改前相同。
--    ⇒ create_member 本體指紋不變(J03「不能變」清單)。
--
-- 改前指紋(正式庫 wjtbmmnakcriuaqoknsq 2026-10-08 唯讀實查 = 本機,沒有漂移;算法 md5(replace(prosrc, CRLF, LF))):
--   public.get_public_booking_page        18c18fd71810ec65b143befb8a2777f4
--   public.create_group_and_merchant      8eaef8206b565566832e2d3fd1eb60c3
--   public.create_merchant_in_group       aec495b38b1a12164cbe14eb3aa07c7a
--   public.unbind_line_account            08f332476de1ffa1957e01cafb01ca6e
--   private.can_manage_members            (見回報)

-- =========================================================================
-- 共用
-- =========================================================================
create or replace function private.is_customer_account()
returns boolean
language sql
stable
set search_path = public
as $$
  -- app_metadata 只有 service role(Edge Function customer-line-login 建帳號時)寫得到,客人自己改不了。
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'account_type') = 'customer', false);
$$;
comment on function private.is_customer_account() is 'C2-C02:目前登入者是不是客戶端 LINE 登入建立的「客戶帳號」(JWT app_metadata.account_type = customer)。';
revoke execute on function private.is_customer_account() from public, anon, authenticated;
grant execute on function private.is_customer_account() to service_role;

create or replace function private.is_valid_customer_phone(p_phone text)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- 零之二 第 3 點:去掉空白、-、括號後只剩數字,0 開頭 9~10 碼(手機 09 開頭 10 碼、市話含區碼);不支援分機。
  -- 同時要通過 private.is_valid_taiwan_phone(create_member 內部會再檢查一次,兩者一致才不會出現「前面放行、建立時失敗」)。
  select coalesce(
    regexp_replace(p_phone, '[[:space:]()-]', '', 'g') ~ '^0[0-9]{8,9}$'
    and private.is_valid_taiwan_phone(p_phone),
    false
  );
$$;
comment on function private.is_valid_customer_phone(text) is 'C2 零之二 第 3 點:客戶端電話格式(手機或含區碼市話,不收分機)。等同 is_valid_taiwan_phone 去掉分機那一種。前端對應:去掉空白 / - / 括號後 ^(09[0-9]{8}|0[2-8][0-9]{7,8})$。';
revoke execute on function private.is_valid_customer_phone(text) from public, anon, authenticated;
grant execute on function private.is_valid_customer_phone(text) to service_role;

-- =========================================================================
-- private.can_manage_members:多一個「客戶端建立會員」的交易內標記分支(見檔頭 🔴)
-- 原本的兩個條件逐字保留。
-- =========================================================================
create or replace function private.can_manage_members(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'members'
        and map.granted = true
    )
  -- [c2 begin] 客戶端第 2 批:客戶端 LINE 登入 / 第 3 批訪客送出要「沿用 create_member 建會員」。
  -- 標記 miaoyue.customer_member_create 只由 private.create_member_as_customer_flow 在同一交易內設定
  -- (值 = 那一間商家的 id),呼叫 create_member 後立刻清掉;只對同一間商家成立。
  -- 沒有標記時這一段先比字串就是 false(不呼叫任何函式),行為與改前相同。
    or coalesce(current_setting('miaoyue.customer_member_create', true), '') = p_merchant_id::text
  -- [c2 end]
    ;
$function$;

-- =========================================================================
-- private.create_member_as_customer_flow:沿用 public.create_member 建會員(客人 / 訪客用)
-- =========================================================================
create or replace function private.create_member_as_customer_flow(p_merchant_id uuid, p_name text, p_phone text)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.members;
begin
  perform set_config('miaoyue.customer_member_create', p_merchant_id::text, true);
  begin
    v_member := public.create_member(p_merchant_id, p_name, p_phone);
  exception when others then
    perform set_config('miaoyue.customer_member_create', '', true);
    raise;
  end;
  perform set_config('miaoyue.customer_member_create', '', true);
  return v_member;
end;
$$;
comment on function private.create_member_as_customer_flow(uuid, text, text) is 'C2-C03 第 8 步 / C2-G03:用 public.create_member 的同一套邏輯(格式、同電話唯一、推薦碼)替客人建會員。只由 customer_complete_profile 與 resolve_guest_member 呼叫;設定 miaoyue.customer_member_create 標記 → 呼叫 create_member → 立刻清掉。';
revoke execute on function private.create_member_as_customer_flow(uuid, text, text) from public, anon, authenticated, service_role;

-- =========================================================================
-- C2-A02 set_merchant_line_login_config
-- =========================================================================
create or replace function public.set_merchant_line_login_config(p_merchant_id uuid, p_channel_id text, p_channel_secret text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.merchant_line_login_configs;
  v_channel_id text := btrim(coalesce(p_channel_id, ''));
  v_secret text := btrim(coalesce(p_channel_secret, ''));
  v_vault_id uuid;
  v_vault_name text;
begin
  -- 🔴 這支函式收到的 secret 永遠不可以出現在任何錯誤訊息或 raise 參數裡(C2-A02 / C2-F01)。
  if auth.uid() is null
     or private.is_customer_account()
     or not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin()) then
    raise exception '只有商家管理員或平台管理員可以設定 LINE 登入。' using errcode = '42501';
  end if;
  if not exists (select 1 from public.merchants where id = p_merchant_id) then
    raise exception '找不到這間商家。' using errcode = 'P0002';
  end if;

  if v_channel_id !~ '^[0-9]{10}$' then
    raise exception 'Channel ID 格式不正確，請貼上 LINE Developers「Basic settings」裡的 10 碼數字。'
      using errcode = '22023', hint = 'invalid_channel_id';
  end if;

  select * into v_cfg from public.merchant_line_login_configs where merchant_id = p_merchant_id for update;

  if v_secret = '' then
    if v_cfg.merchant_id is null then
      raise exception '第一次設定時，請填寫 Channel Secret。'
        using errcode = '22023', hint = 'secret_required';
    end if;
    -- 只改 Channel ID,沿用舊 secret。
    update public.merchant_line_login_configs
       set channel_id = v_channel_id,
           last_login_succeeded_at = case when channel_id = v_channel_id then last_login_succeeded_at else null end,
           linked_oa_status = case when channel_id = v_channel_id then linked_oa_status else null end,
           updated_by_user_id = auth.uid()
     where merchant_id = p_merchant_id;
    return;
  end if;

  if v_secret !~ '^[0-9A-Za-z]{32}$' then
    raise exception 'Channel Secret 格式不正確，應該是 32 碼英文與數字，請到 LINE Developers 重新複製。'
      using errcode = '22023', hint = 'invalid_channel_secret';
  end if;

  v_vault_name := 'line_login_secret:' || p_merchant_id::text;
  if v_cfg.merchant_id is not null then
    v_vault_id := v_cfg.channel_secret_vault_id;
  else
    -- 理論上不會有殘留(刪除設定時一併刪 Vault),防禦:同名殘留就沿用那一筆。
    select id into v_vault_id from vault.secrets where name = v_vault_name;
  end if;

  if v_vault_id is not null and exists (select 1 from vault.secrets where id = v_vault_id) then
    perform vault.update_secret(v_vault_id, v_secret);
  else
    v_vault_id := vault.create_secret(v_secret, v_vault_name, 'C2 客戶端 LINE 登入 Channel Secret');
  end if;

  insert into public.merchant_line_login_configs as c (
    merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, updated_by_user_id
  ) values (
    p_merchant_id, v_channel_id, v_vault_id, right(v_secret, 4), auth.uid()
  )
  on conflict (merchant_id) do update
    set channel_id = excluded.channel_id,
        channel_secret_vault_id = excluded.channel_secret_vault_id,
        channel_secret_last4 = excluded.channel_secret_last4,
        -- 改了 secret ⇒ 要重新驗證設定正確。enabled 不自動關(規格 ⚠️)。
        last_login_succeeded_at = null,
        linked_oa_status = null,
        updated_by_user_id = excluded.updated_by_user_id;
end;
$$;
comment on function public.set_merchant_line_login_config(uuid, text, text) is 'C2-A02:商家管理員或平台管理員設定 LINE Login channel。secret 空白 = 只改 Channel ID 沿用舊 secret(第一次必填)。secret 寫進 Vault(line_login_secret:<merchant_id>),表裡只留末 4 碼;改 Channel ID 或 secret 會清掉 last_login_succeeded_at / linked_oa_status,enabled 不動。錯誤訊息永遠不帶傳入的 secret。';
revoke execute on function public.set_merchant_line_login_config(uuid, text, text) from public, anon;
grant execute on function public.set_merchant_line_login_config(uuid, text, text) to authenticated;

-- =========================================================================
-- C2-A03 get_merchant_line_login_status
-- =========================================================================
create or replace function public.get_merchant_line_login_status(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg public.merchant_line_login_configs;
begin
  if auth.uid() is null
     or private.is_customer_account()
     or not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin()) then
    raise exception '只有商家管理員或平台管理員可以查看 LINE 登入設定。' using errcode = '42501';
  end if;

  select * into v_cfg from public.merchant_line_login_configs where merchant_id = p_merchant_id;

  -- 白名單逐欄,永遠不回 secret 或 Vault id。
  return jsonb_build_object(
    'configured', v_cfg.merchant_id is not null,
    'channel_id', v_cfg.channel_id,
    'channel_secret_masked', case when v_cfg.merchant_id is null then null else '••••' || v_cfg.channel_secret_last4 end,
    'enabled', coalesce(v_cfg.enabled, false),
    'last_login_succeeded_at', v_cfg.last_login_succeeded_at,
    'linked_oa_status', v_cfg.linked_oa_status,
    'callback_path', '/auth/line/callback'
  );
end;
$$;
comment on function public.get_merchant_line_login_status(uuid) is 'C2-A03:後台 LINE 登入設定卡的資料。只回 configured / channel_id / channel_secret_masked(•••• + 末 4 碼)/ enabled / last_login_succeeded_at / linked_oa_status / callback_path。callback 完整網址由前端用目前網站網域 + callback_path 組出(跟 Edge Function 的 PUBLIC_SITE_URL 同一個網域)。';
revoke execute on function public.get_merchant_line_login_status(uuid) from public, anon;
grant execute on function public.get_merchant_line_login_status(uuid) to authenticated;

-- =========================================================================
-- C2-A04 set_merchant_line_login_enabled / delete_merchant_line_login_config
-- =========================================================================
create or replace function public.set_merchant_line_login_enabled(p_merchant_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or private.is_customer_account()
     or not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin()) then
    raise exception '只有商家管理員或平台管理員可以變更 LINE 登入設定。' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception '請指定要啟用或停用。' using errcode = '22023';
  end if;

  update public.merchant_line_login_configs
     set enabled = p_enabled, updated_by_user_id = auth.uid()
   where merchant_id = p_merchant_id;

  if not found and p_enabled then
    raise exception '請先儲存 LINE 登入設定(Channel ID 與 Channel Secret)，才能啟用。'
      using errcode = 'P0002', hint = 'not_configured';
  end if;
end;
$$;
comment on function public.set_merchant_line_login_enabled(uuid, boolean) is 'C2-A04:開關 LINE 登入。沒有設定時不能啟用。停用不影響已接上的會員(members.user_id / line_user_id 保留)。';
revoke execute on function public.set_merchant_line_login_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_merchant_line_login_enabled(uuid, boolean) to authenticated;

create or replace function public.delete_merchant_line_login_config(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vault_id uuid;
begin
  if auth.uid() is null
     or private.is_customer_account()
     or not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin()) then
    raise exception '只有商家管理員或平台管理員可以刪除 LINE 登入設定。' using errcode = '42501';
  end if;

  delete from public.merchant_line_login_configs
   where merchant_id = p_merchant_id
  returning channel_secret_vault_id into v_vault_id;

  if v_vault_id is not null then
    delete from vault.secrets where id = v_vault_id;
  end if;
end;
$$;
comment on function public.delete_merchant_line_login_config(uuid) is 'C2-A04:刪除 LINE 登入設定,一併刪除 Vault 裡的 secret。已接上的會員資料不動。';
revoke execute on function public.delete_merchant_line_login_config(uuid) from public, anon;
grant execute on function public.delete_merchant_line_login_config(uuid) to authenticated;

-- =========================================================================
-- C2-F02 Edge Function 專用(只給 service_role)
-- =========================================================================
create or replace function public.internal_get_line_login_credentials(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg public.merchant_line_login_configs;
  v_secret text;
  v_active boolean;
begin
  select * into v_cfg from public.merchant_line_login_configs where merchant_id = p_merchant_id;
  if not found then
    return null;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_cfg.channel_secret_vault_id;
  select m.status = 'active' into v_active from public.merchants m where m.id = p_merchant_id;
  return jsonb_build_object(
    'channel_id', v_cfg.channel_id,
    'channel_secret', v_secret,
    'enabled', v_cfg.enabled,
    'merchant_active', coalesce(v_active, false)
  );
end;
$$;
comment on function public.internal_get_line_login_credentials(uuid) is 'C2-F02:只給 Edge Function customer-line-login(service role)取 Channel ID / Secret。anon / authenticated 一律沒有執行權限。';
revoke execute on function public.internal_get_line_login_credentials(uuid) from public, anon, authenticated;
grant execute on function public.internal_get_line_login_credentials(uuid) to service_role;

create or replace function public.internal_customer_line_login_start(
  p_slug text, p_state_hash text, p_nonce text, p_code_verifier text, p_draft jsonb, p_ip_hash text
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
  -- 頻率限制:同一個 IP 10 分鐘內最多 30 次(C2-B01 ⚠️)。
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

  insert into public.customer_line_login_attempts (
    state_hash, merchant_id, channel_id, nonce, code_verifier, draft, ip_hash, expires_at
  ) values (
    p_state_hash, v_merchant.id, v_cfg.channel_id, p_nonce, p_code_verifier, p_draft, p_ip_hash,
    now() + interval '10 minutes'
  );

  return jsonb_build_object('status', 'ok', 'channel_id', v_cfg.channel_id);
end;
$$;
comment on function public.internal_customer_line_login_start(text, text, text, text, jsonb, text) is 'C2-B01:Edge Function start 用。檢查 IP 頻率(10 分鐘 30 次)、商家啟用中且有啟用 LINE 登入,寫一列 customer_line_login_attempts(10 分鐘有效)。停用 / 不存在 / 未啟用一律回 line_login_unavailable。只給 service_role。';
revoke execute on function public.internal_customer_line_login_start(text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.internal_customer_line_login_start(text, text, text, text, jsonb, text) to service_role;

create or replace function public.internal_customer_line_login_consume(p_state_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

  if not found or v_row.consumed_at is not null then
    return jsonb_build_object('status', 'login_expired');
  end if;

  v_draft := v_row.draft;
  update public.customer_line_login_attempts
     set consumed_at = now(), draft = null
   where state_hash = p_state_hash;

  if v_row.expires_at <= now() then
    return jsonb_build_object('status', 'login_expired');
  end if;

  select booking_slug into v_slug from public.merchants where id = v_row.merchant_id;

  return jsonb_build_object(
    'status', 'ok',
    'merchant_id', v_row.merchant_id,
    'slug', v_slug,
    'channel_id', v_row.channel_id,
    'nonce', v_row.nonce,
    'code_verifier', v_row.code_verifier,
    'draft', v_draft
  );
end;
$$;
comment on function public.internal_customer_line_login_consume(text) is 'C2-B03 第 1、2、11 步:用 state 雜湊找登入暫存。找不到 / 已用過 / 過期 ⇒ login_expired;否則標成已使用、draft 清成 null 並回傳(回到哪一頁由這裡查 slug,不收前端網址,C2-F04)。只給 service_role。';
revoke execute on function public.internal_customer_line_login_consume(text) from public, anon, authenticated;
grant execute on function public.internal_customer_line_login_consume(text) to service_role;

create or replace function public.internal_customer_line_identity_find(p_channel_id text, p_sub text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('user_id', i.user_id, 'email', u.email)
  from public.customer_line_identities i
  join auth.users u on u.id = i.user_id
  where i.line_channel_id = p_channel_id and i.line_sub = p_sub
    and coalesce(u.raw_app_meta_data ->> 'account_type', '') = 'customer';
$$;
comment on function public.internal_customer_line_identity_find(text, text) is 'C2-C02:用 Channel + LINE userId 找既有客戶帳號(user_id、合成 email)。只給 service_role。';
revoke execute on function public.internal_customer_line_identity_find(text, text) from public, anon, authenticated;
grant execute on function public.internal_customer_line_identity_find(text, text) to service_role;

create or replace function public.internal_customer_line_identity_upsert(
  p_user_id uuid, p_channel_id text, p_sub text, p_display_name text, p_picture_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
  v_type text;
  v_picture text := case when p_picture_url ~ '^https://' then left(p_picture_url, 1000) else null end;
begin
  if coalesce(btrim(p_channel_id), '') = '' or coalesce(btrim(p_sub), '') = '' then
    raise exception 'LINE 身分資料不完整。' using errcode = '22023';
  end if;

  insert into public.customer_line_identities as i (user_id, line_channel_id, line_sub, display_name, picture_url)
  values (p_user_id, p_channel_id, p_sub, left(p_display_name, 100), v_picture)
  on conflict (line_channel_id, line_sub) do update
    set display_name = excluded.display_name,
        picture_url = excluded.picture_url,
        last_login_at = now()
  returning i.user_id into v_user_id;

  select u.email, u.raw_app_meta_data ->> 'account_type' into v_email, v_type
  from auth.users u where u.id = v_user_id;
  if v_type is distinct from 'customer' then
    raise exception '這個登入帳號不是客戶帳號。' using errcode = '42501';
  end if;

  return jsonb_build_object('user_id', v_user_id, 'email', v_email);
end;
$$;
comment on function public.internal_customer_line_identity_upsert(uuid, text, text, text, text) is 'C2-C02 / C2-B03 第 8 步:寫入或更新 customer_line_identities(顯示名稱、頭像只收 https、最後登入時間)。同一個 Channel + sub 已經有帳號時回傳既有的 user_id(Edge Function 會刪掉自己剛建的多餘帳號,處理同時登入兩次的競態)。只給 service_role。';
revoke execute on function public.internal_customer_line_identity_upsert(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.internal_customer_line_identity_upsert(uuid, text, text, text, text) to service_role;

create or replace function public.internal_customer_line_login_succeeded(p_merchant_id uuid, p_channel_id text, p_linked_oa_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.merchant_line_login_configs
     set last_login_succeeded_at = now(),
         linked_oa_status = case when p_linked_oa_status in ('ok', 'not_linked', 'unknown') then p_linked_oa_status else 'unknown' end
   where merchant_id = p_merchant_id and channel_id = p_channel_id;
end;
$$;
comment on function public.internal_customer_line_login_succeeded(uuid, text, text) is 'C2-B03 第 7、8 步:記錄商家「最近一次有客人成功登入」與好友 / 官方帳號連結狀態(只在 Channel ID 沒被改掉時)。只給 service_role。';
revoke execute on function public.internal_customer_line_login_succeeded(uuid, text, text) from public, anon, authenticated;
grant execute on function public.internal_customer_line_login_succeeded(uuid, text, text) to service_role;

-- =========================================================================
-- C2-C01 get_public_booking_page:booking_settings 多 line_login_enabled、member_policy
-- 其餘欄位的值與結構逐字不變。
-- =========================================================================
create or replace function public.get_public_booking_page(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_merchant public.merchants;
  v_allow_guest boolean;
  v_line_login_enabled boolean;
  v_member_policy text;
begin
  select * into v_merchant
  from public.merchants
  where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if v_merchant.status is distinct from 'active' then
    return jsonb_build_object('status', 'unavailable');
  end if;

  select s.allow_guest_booking into v_allow_guest
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
      'member_policy', v_member_policy
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
             ) order by st.created_at, st.id)
      from public.merchant_staff st
      where st.merchant_id = v_merchant.id and st.status = 'active' and st.is_listed = true
    ), '[]'::jsonb)
  );
end;
$function$;

-- =========================================================================
-- C2-D03(零之二簡化版)接上既有會員 + 鈴鐺
-- =========================================================================
create or replace function private.notify_member_line_login_linked(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_name text;
  v_title text := '會員已用 LINE 登入接上';
  v_body text;
begin
  select merchant_id, name into v_merchant_id, v_name from public.members where id = p_member_id;
  if v_merchant_id is null then
    return;
  end if;
  v_body := format('會員「%s」已用 LINE 登入，接上原本的會員資料。',
                   regexp_replace(coalesce(nullif(btrim(v_name), ''), '未填姓名'), E'\r\n|[\r\n\t]', ' ', 'g'));

  -- ① 管理員
  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select ma.user_id, v_merchant_id, 'admin', ma.id, 'member_line_login_linked', null, v_title, v_body
  from public.merchant_admins ma
  where ma.merchant_id = v_merchant_id and ma.user_id is not null;

  -- ② 有「會員管理」權限的在職客服(同帳號已是同店管理員 ⇒ 不重寫)。服務人員不寫。
  insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
  select g.user_id, v_merchant_id, 'agent', g.id, 'member_line_login_linked', null, v_title, v_body
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
comment on function private.notify_member_line_login_linked(uuid) is 'C2 零之二 第 1 點:客人用 LINE 登入接上「既有」會員時,發站內鈴鐺(member_line_login_linked)給該店管理員與有會員管理權限的在職客服(同帳號只一則、服務人員不寫)。新建會員不通知。不發 LINE / 推播。';
revoke execute on function private.notify_member_line_login_linked(uuid) from public, anon, authenticated, service_role;

create or replace function private.link_customer_to_member(p_member_id uuid, p_user_id uuid, p_line_sub text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if not found then
    raise exception '找不到這位會員。' using errcode = 'P0002';
  end if;
  -- 零之二:已經有別的客戶帳號接上 ⇒ 不取代(呼叫端應該先回 phone_taken,這裡是最後一道防線)。
  if v_member.user_id is not null and v_member.user_id <> p_user_id then
    raise exception '這位會員已經有其他帳號接上。' using errcode = '42501';
  end if;

  -- 1. 同商家任何會員(不分狀態)若佔著這個 user_id ⇒ 先清成 null(members_merchant_id_user_id_idx 不分狀態)。
  update public.members
     set user_id = null
   where merchant_id = v_member.merchant_id and user_id = p_user_id and id <> p_member_id;

  -- 2. 接上:原本綁的 LINE 直接取代;identity 三欄用 coalesce。
  -- 4. 姓名、生日、點數、等級、黑名單一律不動(#931、#616)。
  update public.members
     set user_id = p_user_id,
         line_user_id = p_line_sub,
         line_bound = true,
         identity_verified_at = coalesce(identity_verified_at, now()),
         identity_verified_via = coalesce(identity_verified_via, 'line'),
         identity_first_verified_at = coalesce(identity_first_verified_at, now())
   where id = p_member_id;

  perform private.notify_member_line_login_linked(p_member_id);
end;
$$;
comment on function private.link_customer_to_member(uuid, uuid, text) is 'C2-D03(零之二簡化):把客戶帳號直接接上一位「還沒有客戶帳號接上」的既有會員。清掉同店其他會員佔著的同一 user_id → 寫 user_id / line_user_id / line_bound / identity 三欄(coalesce)→ 發鈴鐺。姓名、生日、點數、等級、黑名單不動。只由 customer_complete_profile 呼叫。';
revoke execute on function private.link_customer_to_member(uuid, uuid, text) from public, anon, authenticated, service_role;

-- =========================================================================
-- C2-C03 customer_complete_profile(零之二版)
-- =========================================================================
create or replace function public.customer_complete_profile(p_slug text, p_phone text, p_name text, p_agree_policy boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  select * into v_cfg from public.merchant_line_login_configs where merchant_id = v_merchant.id;
  if not found or not v_cfg.enabled then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;

  -- 3. 這位客人的 LINE channel 必須等於這間店目前的 channel。
  select * into v_ident from public.customer_line_identities where user_id = v_uid;
  if not found or v_ident.line_channel_id is distinct from v_cfg.channel_id then
    return jsonb_build_object('state', 'channel_mismatch');
  end if;

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
  select * into v_linked from public.members
  where merchant_id = v_merchant.id and user_id = v_uid and status = 'active';
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
    -- 新電話 ⇒ 直接相信,沿用 create_member 建會員。姓名空白時用 LINE 顯示名稱。
    v_name := coalesce(v_name, left(nullif(btrim(coalesce(v_ident.display_name, '')), ''), 50), 'LINE 會員');
    begin
      v_new := private.create_member_as_customer_flow(v_merchant.id, v_name, v_phone);
    exception when others then
      -- 🔴 不把 create_member 的原文帶出去(撞號時原文會帶出別的會員姓名,C2-F06)。
      raise exception '系統忙碌，請稍後再試一次。' using errcode = 'P0001', hint = 'retry';
    end;

    update public.members
       set user_id = null
     where merchant_id = v_merchant.id and user_id = v_uid and id <> v_new.id;
    update public.members
       set user_id = v_uid,
           line_user_id = v_ident.line_sub,
           line_bound = true,
           identity_verified_at = now(),
           identity_verified_via = 'line',
           identity_first_verified_at = now()
     where id = v_new.id;

    v_member_id_for_consent := v_new.id;
    v_result := jsonb_build_object('state', 'linked', 'created', true);
  elsif v_member.user_id is null then
    -- 零之二 第 1 點:既有會員還沒有客戶帳號接上 ⇒ 直接接上(+ 鈴鐺)。
    perform private.link_customer_to_member(v_member.id, v_uid, v_ident.line_sub);
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked', 'existing', true);
  elsif v_member.user_id = v_uid then
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked');
  else
    -- 零之二 第 1 點:已經有別的客戶帳號接上 ⇒ 不取代。回應不帶任何會員資料(C2-F06)。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', 'phone_taken');
  end if;

  -- 9. 每次呼叫都寫一筆同意紀錄(也是 Q6 的計數來源)。
  insert into public.customer_policy_consents (
    merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
  ) values (
    v_merchant.id, v_uid, v_member_id_for_consent, v_phone, 'line_login', v_policy_enabled, v_policy_hash, '2026-10-08'
  );

  return v_result;
end;
$$;
comment on function public.customer_complete_profile(text, text, text, boolean) is 'C2-C03(零之二版):⑥-2 送出。只給客戶帳號,一律用 auth.uid() 取身分、slug 取商家,不收會員 id。回傳 state:linked(created / existing 旗標)、phone_taken、too_many_attempts、line_login_unavailable、channel_mismatch;輸入錯誤 raise(hint:not_customer / policy_not_agreed / invalid_phone / invalid_name / retry)。新電話直接建會員(沿用 create_member);既有會員沒人接上就直接接上並發鈴鐺;已被別的客戶帳號接上回 phone_taken(不帶任何會員資料)。24 小時內最多換 5 支電話。姓名不覆蓋既有會員。';
revoke execute on function public.customer_complete_profile(text, text, text, boolean) from public, anon;
grant execute on function public.customer_complete_profile(text, text, text, boolean) to authenticated;

-- =========================================================================
-- C2-C05 get_customer_session_state
-- =========================================================================
create or replace function public.get_customer_session_state(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
      'member', jsonb_build_object('name', v_member.name, 'phone', v_member.phone)
    );
  end if;

  return jsonb_build_object(
    'state', 'needs_profile',
    'line_display_name', v_ident.display_name,
    'line_picture_url', v_ident.picture_url
  );
end;
$$;
comment on function public.get_customer_session_state(text) is 'C2-C05(零之二版):前端打開預約頁 / 登入回來時決定畫面。state:not_customer / line_login_unavailable / channel_mismatch(前端都當未登入)、needs_profile(⑥-2,附自己的 LINE 名稱與頭像)、linked(附自己的會員姓名與電話)。不收 member_id、不回別人的資料。';
revoke execute on function public.get_customer_session_state(text) from public, anon;
grant execute on function public.get_customer_session_state(text) to authenticated;

-- =========================================================================
-- C2-G02 / C2-G03 訪客規則(第 3 批送出函式才會呼叫)
-- =========================================================================
create or replace function private.customer_open_booking_count(p_merchant_id uuid, p_phone text, p_member_id uuid default null)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.source = 'customer'
    and b.status not in ('completed', 'cancelled')
    and b.end_at > now()
    and (
      (private.normalize_phone(p_phone) is not null
        and private.normalize_phone(b.customer_phone) = private.normalize_phone(p_phone))
      or (p_member_id is not null and b.member_id = p_member_id)
    );
$$;
comment on function private.customer_open_booking_count(uuid, text, uuid) is 'C2-G02:客人從客戶端下、還沒完成 / 取消、而且結束時間還沒過的預約張數(同電話或同會員)。後台建的單不算。上限 3 由第 3 批送出函式判斷。';
revoke execute on function private.customer_open_booking_count(uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function private.resolve_guest_member(p_merchant_id uuid, p_phone text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  if v_count = 1 then
    return v_id;   -- 不改任何欄位(#912 / #931)
  elsif v_count >= 2 then
    raise exception '這支電話對到多位會員，請聯絡店家。' using errcode = 'P0001', hint = 'multiple_members';
  end if;

  v_new := private.create_member_as_customer_flow(p_merchant_id, p_name, v_phone);
  return v_new.id;
end;
$$;
comment on function private.resolve_guest_member(uuid, text, text) is 'C2-G03:訪客自動對到會員,語意同後台建單 #912:正規化電話比對同商家 active 會員,1 位回那位(不改欄位)、0 位用 create_member 同一套邏輯建一位未驗證會員、≥2 位報錯。第 3 批送出時才呼叫。';
revoke execute on function private.resolve_guest_member(uuid, text, text) from public, anon, authenticated, service_role;

-- =========================================================================
-- C2-H03 會員詳細頁「客戶端登入」狀態
-- =========================================================================
create or replace function public.get_member_customer_login_status(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member public.members;
  v_last timestamptz;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found or not private.can_manage_members(v_member.merchant_id) then
    raise exception '沒有權限查看這位會員。' using errcode = '42501';
  end if;

  if v_member.user_id is not null then
    select i.last_login_at into v_last from public.customer_line_identities i where i.user_id = v_member.user_id;
  end if;

  return jsonb_build_object(
    'linked', v_member.user_id is not null and v_last is not null,
    'last_login_at', v_last
  );
end;
$$;
comment on function public.get_member_customer_login_status(uuid) is 'C2-H03:會員詳細頁「客戶端登入:已連結(最後登入 …)/ 未連結」。權限 = can_manage_members。只回 linked / last_login_at,不回 LINE userId。';
revoke execute on function public.get_member_customer_login_status(uuid) from public, anon;
grant execute on function public.get_member_customer_login_status(uuid) to authenticated;

-- =========================================================================
-- C2-H01 客戶帳號不能建店(兩支函式只在開頭多一段,其餘逐字不變)
-- =========================================================================
create or replace function public.create_group_and_merchant(p_name text, p_industry_type text, p_address text default null::text, p_contact_email text default null::text, p_intro text default null::text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  -- [c2] C2-H01:客戶端 LINE 登入的客人帳號不能建店。
  if private.is_customer_account() then
    raise exception '客人帳號不能建立商家。' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型：%', p_industry_type;
  end if;

  insert into public.groups (group_admin_user_id)
  values (null)
  returning id into v_group_id;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    v_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);
  perform public.seed_default_leave_types(v_merchant_id);
  perform public.seed_default_payroll_settings(v_merchant_id);
  perform public.seed_default_leave_deduction_rules(v_merchant_id);
  perform public.seed_default_member_settings(v_merchant_id);
  perform public.seed_default_line_event_settings(v_merchant_id);
  perform public.seed_default_push_event_settings(v_merchant_id);
  perform public.seed_default_booking_status_colors(v_merchant_id);
  perform public.seed_default_merchant_calendar_state_styles(v_merchant_id);

  return v_merchant_id;
end;
$function$;

create or replace function public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text default null::text, p_contact_email text default null::text, p_intro text default null::text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_uid uuid := auth.uid();
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  -- [c2] C2-H01:客戶端 LINE 登入的客人帳號不能建店。
  if private.is_customer_account() then
    raise exception '客人帳號不能建立商家。' using errcode = '42501';
  end if;

  if not private.is_group_member(p_group_id) then
    raise exception '沒有權限在此集團下新增分店' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型：%', p_industry_type;
  end if;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    p_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);
  perform public.seed_default_leave_types(v_merchant_id);
  perform public.seed_default_payroll_settings(v_merchant_id);
  perform public.seed_default_leave_deduction_rules(v_merchant_id);
  perform public.seed_default_member_settings(v_merchant_id);
  perform public.seed_default_line_event_settings(v_merchant_id);
  perform public.seed_default_push_event_settings(v_merchant_id);
  perform public.seed_default_booking_status_colors(v_merchant_id);
  perform public.seed_default_merchant_calendar_state_styles(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- C2-H02 unbind_line_account:member 分支多清 user_id(其餘逐字不變)
-- =========================================================================
create or replace function public.unbind_line_account(p_target_type text, p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
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

-- =========================================================================
-- C2-C07 註解登記(函式本體不動,指紋不變)
-- =========================================================================
comment on function public.consume_line_binding_code(text, uuid, text) is '規則 2.8/3.8:比對綁定碼成功後直接覆蓋 line_user_id/line_bound(換帳號直接取代,不需先解除)。只給 line-webhook Edge Function 用 service role 呼叫。SPECS-INDEX #908/#910(2026-09-30):member 分支的同一句 UPDATE 額外寫入「已完成身分驗證」三個欄位 —— identity_verified_at 與 identity_verified_via 用 coalesce(第二次綁定不改「這一段驗證從何時開始」),identity_first_verified_at 也用 coalesce 且**之後永遠不會被任何路徑清掉或覆寫**。這支函式是 identity_verified_at 目前**唯一的設上路徑**(清掉的唯一路徑是 unbind_line_account);未來 #866 改登入方式或模組 13 做出客戶端登入時,新那條路徑也要在 20260930040100 這份 migration 裡登記,並在 members_identity_verified_via_check 加上對應的值。admin/agent/staff 三個分支完全不變(「已完成身分驗證」是會員的兩層狀態,跟內部人員無關)。【客戶端第 2 批 2026-10-08 登記】identity_verified_at 新增兩條設上路徑:public.customer_complete_profile(新電話直接建會員)與 private.link_customer_to_member(接上既有會員),identity_verified_via 一律沿用既有的 ''line''(客戶端登入就是 LINE 身分),所以 check 不用加新值。見 20261008170100_c2_line_login_functions.sql。';

-- =========================================================================
-- C2-C04 清理排程:每小時刪 1 天前的登入暫存
-- =========================================================================
create or replace function private.prune_customer_line_login_attempts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from public.customer_line_login_attempts where created_at < now() - interval '1 day';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
comment on function private.prune_customer_line_login_attempts() is 'C2-C04:刪除 1 天前的 LINE 登入暫存。由 pg_cron customer-line-login-attempts-prune-hourly 每小時呼叫。';
revoke execute on function private.prune_customer_line_login_attempts() from public, anon, authenticated, service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'customer-line-login-attempts-prune-hourly';
select cron.schedule(
  'customer-line-login-attempts-prune-hourly',
  '17 * * * *',
  $$ select private.prune_customer_line_login_attempts(); $$
);
