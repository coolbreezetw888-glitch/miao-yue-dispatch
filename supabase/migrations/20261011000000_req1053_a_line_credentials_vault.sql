-- SPECS-INDEX #1053(全面體檢 B-01):各店 LINE Messaging API 金鑰搬進 Vault — migration A
-- 規格書 .project/specs/LINE金鑰搬Vault.md
--
-- 上線順序固定:這支(A)→ 部署相關 Edge Function → migration B(清空並移除明文欄位)。
-- 這支 A 做的事:
--   R1 merchant_line_configs 加 4 個欄位:channel_secret_vault_id / channel_access_token_vault_id(指向 vault.secrets.id)、
--      channel_secret_last4 / channel_access_token_last4(遮罩用末 4 碼)。原本沒有任何遮罩欄位(遮罩是即時從明文取末 4 碼)。
--   R2 set_merchant_line_credentials 改寫 Vault(名稱 line_messaging_channel_secret:<merchant_id> /
--      line_messaging_access_token:<merchant_id>,名稱不含值),明文欄位不再寫入。
--      權限檢查、錯誤訊息、security definer、search_path、grant/revoke 逐字保留(以正式庫現行本體為底,
--      正式庫指紋 2c6007375b3702a7acea477f37a69c29,與 repo 只差註解)。
--   R3 刪除:merchant_line_configs 加 AFTER DELETE / UPDATE OF vault id 觸發器,一併刪 Vault 兩筆 secret。
--      disconnect_merchant_line(delete 這一列)與商家硬刪的 on delete cascade 都會觸發 ⇒ 不留孤兒 secret。
--      disconnect_merchant_line 本體不需要改。
--   R4 public.internal_get_line_messaging_credentials(p_merchant_id) 只 grant service_role;
--      claim_birthday_line_pending / internal_prepare_customer_line_job 改從 Vault 取 token(介面不變,
--      以正式庫現行本體為底:指紋 6e0ea4423e703362f5eb4868b678b50f / 9f1d7092649774ec48bc4e8763815011)。
--   R6 既有明文逐列寫進 Vault 並填 vault id / 末 4 碼,核對「有明文的列數 = Vault 內容一致的列數」,不符就 raise。
--      明文欄位這一版先保留(只拿掉 not null),舊版 Edge 在換新之前仍讀得到。
--
-- 🔒 本檔任何 raise 都不帶金鑰值。

-- =========================================================================
-- R1 欄位
-- =========================================================================
alter table public.merchant_line_configs add column if not exists channel_secret_vault_id uuid;
alter table public.merchant_line_configs add column if not exists channel_access_token_vault_id uuid;
alter table public.merchant_line_configs add column if not exists channel_secret_last4 text;
alter table public.merchant_line_configs add column if not exists channel_access_token_last4 text;

-- 新版寫入函式不再寫明文 ⇒ 明文欄位先拿掉 not null(migration B 會整欄移除)。
alter table public.merchant_line_configs alter column channel_secret drop not null;
alter table public.merchant_line_configs alter column channel_access_token drop not null;

comment on column public.merchant_line_configs.channel_secret_vault_id is '#1053:指向 vault.secrets.id(Channel Secret)。表裡不存 secret 原文。';
comment on column public.merchant_line_configs.channel_access_token_vault_id is '#1053:指向 vault.secrets.id(Channel Access Token)。表裡不存 token 原文。';
comment on column public.merchant_line_configs.channel_secret_last4 is '#1053:Channel Secret 末 4 碼(遮罩顯示用)。';
comment on column public.merchant_line_configs.channel_access_token_last4 is '#1053:Channel Access Token 末 4 碼(遮罩顯示用)。';

-- #1051 已收回 authenticated;這裡再明確收一次 anon / authenticated(正式庫本來就沒有,屬重申)。
revoke all on table public.merchant_line_configs from anon, authenticated;

-- =========================================================================
-- 內部輔助(private,任何 API 角色都不能直接呼叫;只給本檔的 SECURITY DEFINER 函式用)
-- =========================================================================

-- 寫入 / 更新一筆 Vault secret,回傳 id。既有 id 還在 ⇒ 更新;否則同名殘留 ⇒ 沿用;都沒有 ⇒ 新建。
create or replace function private.line_messaging_vault_upsert(
  p_existing_id uuid, p_name text, p_value text, p_description text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := p_existing_id;
begin
  if v_id is null or not exists (select 1 from vault.secrets where id = v_id) then
    select id into v_id from vault.secrets where name = p_name;
  end if;
  if v_id is not null then
    perform vault.update_secret(v_id, p_value, p_name, p_description);
  else
    v_id := vault.create_secret(p_value, p_name, p_description);
  end if;
  return v_id;
end;
$$;
comment on function private.line_messaging_vault_upsert(uuid, text, text, text) is '#1053:LINE Messaging API 金鑰寫進 Vault(更新或新建),回傳 vault.secrets.id。只給 set_merchant_line_credentials 與搬資料用。';
revoke all on function private.line_messaging_vault_upsert(uuid, text, text, text) from public, anon, authenticated, service_role;

-- 取某店的 access token(從 Vault 解密)。設定不存在或 Vault 讀不到 ⇒ null。
create or replace function private.line_messaging_access_token(p_merchant_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select ds.decrypted_secret
  from public.merchant_line_configs c
  join vault.decrypted_secrets ds on ds.id = c.channel_access_token_vault_id
  where c.merchant_id = p_merchant_id
$$;
comment on function private.line_messaging_access_token(uuid) is '#1053:從 Vault 取某店的 LINE Channel Access Token。只給 claim_birthday_line_pending / internal_prepare_customer_line_job 等 service_role 專用函式在內部呼叫。';
revoke all on function private.line_messaging_access_token(uuid) from public, anon, authenticated, service_role;

-- =========================================================================
-- R3 刪除設定列(解除串接 / 商家硬刪連帶刪除)⇒ 一併刪 Vault;換掉 vault id ⇒ 刪舊的那筆
-- =========================================================================
create or replace function private.merchant_line_configs_cleanup_vault()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from vault.secrets
     where id in (old.channel_secret_vault_id, old.channel_access_token_vault_id);
    return old;
  end if;
  if old.channel_secret_vault_id is distinct from new.channel_secret_vault_id
     and old.channel_secret_vault_id is not null
     and old.channel_secret_vault_id is distinct from new.channel_access_token_vault_id then
    delete from vault.secrets where id = old.channel_secret_vault_id;
  end if;
  if old.channel_access_token_vault_id is distinct from new.channel_access_token_vault_id
     and old.channel_access_token_vault_id is not null
     and old.channel_access_token_vault_id is distinct from new.channel_secret_vault_id then
    delete from vault.secrets where id = old.channel_access_token_vault_id;
  end if;
  return new;
end;
$$;
comment on function private.merchant_line_configs_cleanup_vault() is '#1053:merchant_line_configs 的列被刪(解除串接、商家硬刪連帶刪除)⇒ 刪掉 Vault 兩筆 secret;vault id 被換掉 ⇒ 刪掉舊的那筆。避免 Vault 留下沒有人指向的金鑰。';
revoke all on function private.merchant_line_configs_cleanup_vault() from public, anon, authenticated, service_role;

drop trigger if exists merchant_line_configs_cleanup_vault on public.merchant_line_configs;
create trigger merchant_line_configs_cleanup_vault
  after delete or update of channel_secret_vault_id, channel_access_token_vault_id
  on public.merchant_line_configs
  for each row execute function private.merchant_line_configs_cleanup_vault();

-- =========================================================================
-- R2 set_merchant_line_credentials(簽章、權限檢查、錯誤訊息不變;改寫 Vault)
-- =========================================================================
create or replace function public.set_merchant_line_credentials(
  p_merchant_id uuid,
  p_channel_id text,
  p_channel_secret text,
  p_channel_access_token text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cfg public.merchant_line_configs;
  v_secret text;
  v_token text;
  v_secret_id uuid;
  v_token_id uuid;
begin
  -- 🔴 收到的 secret / token 永遠不可以出現在任何錯誤訊息或 raise 參數裡。
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限設定這間商家的 LINE 串接憑證' using errcode = '42501';
  end if;

  if p_channel_id is null or length(trim(p_channel_id)) = 0 then
    raise exception 'Channel ID 不可為空';
  end if;
  if p_channel_secret is null or length(trim(p_channel_secret)) = 0 then
    raise exception 'Channel Secret 不可為空';
  end if;
  if p_channel_access_token is null or length(trim(p_channel_access_token)) = 0 then
    raise exception 'Channel Access Token 不可為空';
  end if;

  v_secret := trim(p_channel_secret);
  v_token := trim(p_channel_access_token);

  select * into v_cfg from public.merchant_line_configs where merchant_id = p_merchant_id for update;

  v_secret_id := private.line_messaging_vault_upsert(
    v_cfg.channel_secret_vault_id, 'line_messaging_channel_secret:' || p_merchant_id::text,
    v_secret, '#1053 LINE Messaging API Channel Secret');
  v_token_id := private.line_messaging_vault_upsert(
    v_cfg.channel_access_token_vault_id, 'line_messaging_access_token:' || p_merchant_id::text,
    v_token, '#1053 LINE Messaging API Channel Access Token');

  insert into public.merchant_line_configs (
    merchant_id, channel_id, channel_secret_vault_id, channel_access_token_vault_id,
    channel_secret_last4, channel_access_token_last4, is_connected, updated_at
  ) values (
    p_merchant_id, trim(p_channel_id), v_secret_id, v_token_id,
    right(v_secret, 4), right(v_token, 4), false, now()
  )
  on conflict (merchant_id) do update set
    channel_id = excluded.channel_id,
    channel_secret_vault_id = excluded.channel_secret_vault_id,
    channel_access_token_vault_id = excluded.channel_access_token_vault_id,
    channel_secret_last4 = excluded.channel_secret_last4,
    channel_access_token_last4 = excluded.channel_access_token_last4,
    -- 重新填寫憑證後 is_connected 重設為 false,必須重新測試連線才會再度變成 true。
    is_connected = false,
    updated_at = now();
end;
$$;

comment on function public.set_merchant_line_credentials(uuid, text, text, text) is '規則 2.1/3.1:商家管理員設定/更新 LINE 官方帳號憑證,寫入後 is_connected 重設為 false。#1053:secret / token 寫進 Vault(line_messaging_channel_secret:<merchant_id> / line_messaging_access_token:<merchant_id>),表裡只留 Vault id 與末 4 碼;錯誤訊息永遠不帶傳入的值。';

revoke execute on function public.set_merchant_line_credentials(uuid, text, text, text) from public, anon;
grant execute on function public.set_merchant_line_credentials(uuid, text, text, text) to authenticated;

-- =========================================================================
-- get_merchant_line_config_status:遮罩改用末 4 碼欄位(回傳格式不變)
-- =========================================================================
create or replace function public.get_merchant_line_config_status(p_merchant_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_row public.merchant_line_configs;
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的 LINE 串接狀態' using errcode = '42501';
  end if;

  select * into v_row from public.merchant_line_configs where merchant_id = p_merchant_id;

  if v_row.merchant_id is null then
    return jsonb_build_object(
      'is_connected', false,
      'channel_id', null,
      'channel_access_token_masked', null,
      'display_name', null,
      'line_bot_basic_id', null,
      'last_tested_at', null,
      'last_test_result', null
    );
  end if;

  return jsonb_build_object(
    'is_connected', v_row.is_connected,
    'channel_id', v_row.channel_id,
    'channel_access_token_masked', '••••' || v_row.channel_access_token_last4,
    'display_name', v_row.display_name,
    'line_bot_basic_id', v_row.line_bot_basic_id,
    'last_tested_at', v_row.last_tested_at,
    'last_test_result', v_row.last_test_result
  );
end;
$$;

comment on function public.get_merchant_line_config_status(uuid) is '規則 2.1/3.2:回傳遮蔽過的 LINE 串接狀態,查無資料回傳「尚未串接」的預設物件,不報錯。#1053:遮罩取 channel_access_token_last4;secret / 完整 token 永遠不會被讀回前端。';

revoke execute on function public.get_merchant_line_config_status(uuid) from public, anon;
grant execute on function public.get_merchant_line_config_status(uuid) to authenticated;

-- =========================================================================
-- R4 Edge Function 專用:取某店的 Channel Secret + Access Token(只給 service_role)
-- =========================================================================
create or replace function public.internal_get_line_messaging_credentials(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_cfg public.merchant_line_configs;
  v_secret text;
  v_token text;
begin
  select * into v_cfg from public.merchant_line_configs where merchant_id = p_merchant_id;
  if not found then
    return null;
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_cfg.channel_secret_vault_id;
  select decrypted_secret into v_token from vault.decrypted_secrets where id = v_cfg.channel_access_token_vault_id;
  -- 任何一個讀不到 ⇒ 當作「LINE 未設定」,呼叫端走既有分支。
  if nullif(v_secret, '') is null or nullif(v_token, '') is null then
    return null;
  end if;
  return jsonb_build_object('channel_secret', v_secret, 'channel_access_token', v_token);
end;
$$;
comment on function public.internal_get_line_messaging_credentials(uuid) is '#1053:只給 Edge Function(service role)取某店 LINE Messaging API 的 channel_secret / channel_access_token(從 Vault 解密)。沒有設定或 Vault 讀不到 ⇒ null。anon / authenticated 一律沒有執行權限。';
revoke execute on function public.internal_get_line_messaging_credentials(uuid) from public, anon, authenticated;
grant execute on function public.internal_get_line_messaging_credentials(uuid) to service_role;

-- =========================================================================
-- R4 claim_birthday_line_pending(以正式庫現行本體為底,只改 token 來源)
-- =========================================================================
CREATE OR REPLACE FUNCTION public.claim_birthday_line_pending(p_limit integer DEFAULT 100)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_r record;
  v_token text;
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

    -- [req1053] access token 改從 Vault 取;只有已連線的店才去解密。
    v_token := case when coalesce(v_r.is_connected, false)
                    then private.line_messaging_access_token(v_r.merchant_id) end;
    if not coalesce(v_r.is_connected, false) or coalesce(btrim(v_token), '') = '' then
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
      'channel_access_token', v_token,
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
-- R4 internal_prepare_customer_line_job(以正式庫現行本體為底,只改 token 來源)
-- =========================================================================
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
  v_token text;
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
  -- [req1053] access token 改從 Vault 取;讀不到 ⇒ 當作未設定(不吐錯誤原文)。
  if found and v_cfg.is_connected then
    v_token := private.line_messaging_access_token(o.merchant_id);
  end if;
  if nullif(v_token, '') is null then
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
    'channel_access_token', v_token,
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
-- R6 搬資料:既有明文逐列寫進 Vault,填 vault id / 末 4 碼(明文欄位這一版保留)
-- =========================================================================
update public.merchant_line_configs c
   set channel_secret_vault_id = private.line_messaging_vault_upsert(
         null, 'line_messaging_channel_secret:' || c.merchant_id::text,
         btrim(c.channel_secret), '#1053 LINE Messaging API Channel Secret'),
       channel_secret_last4 = right(btrim(c.channel_secret), 4)
 where c.channel_secret_vault_id is null
   and nullif(btrim(c.channel_secret), '') is not null;

update public.merchant_line_configs c
   set channel_access_token_vault_id = private.line_messaging_vault_upsert(
         null, 'line_messaging_access_token:' || c.merchant_id::text,
         btrim(c.channel_access_token), '#1053 LINE Messaging API Channel Access Token'),
       channel_access_token_last4 = right(btrim(c.channel_access_token), 4)
 where c.channel_access_token_vault_id is null
   and nullif(btrim(c.channel_access_token), '') is not null;

-- 核對:有明文的列數 = Vault 解密後跟明文一致的列數(兩種金鑰各核一次),不符就整支 migration 失敗。
do $$
declare
  v_plain_secret integer;
  v_vault_secret integer;
  v_plain_token integer;
  v_vault_token integer;
begin
  select count(*) into v_plain_secret
    from public.merchant_line_configs where nullif(btrim(channel_secret), '') is not null;
  select count(*) into v_vault_secret
    from public.merchant_line_configs c
    join vault.decrypted_secrets ds on ds.id = c.channel_secret_vault_id
   where nullif(btrim(c.channel_secret), '') is not null
     and ds.decrypted_secret = btrim(c.channel_secret)
     and c.channel_secret_last4 = right(btrim(c.channel_secret), 4);

  select count(*) into v_plain_token
    from public.merchant_line_configs where nullif(btrim(channel_access_token), '') is not null;
  select count(*) into v_vault_token
    from public.merchant_line_configs c
    join vault.decrypted_secrets ds on ds.id = c.channel_access_token_vault_id
   where nullif(btrim(c.channel_access_token), '') is not null
     and ds.decrypted_secret = btrim(c.channel_access_token)
     and c.channel_access_token_last4 = right(btrim(c.channel_access_token), 4);

  if v_plain_secret <> v_vault_secret or v_plain_token <> v_vault_token then
    raise exception '#1053 搬資料核對不符:secret 明文 % 列 / Vault % 列;token 明文 % 列 / Vault % 列',
      v_plain_secret, v_vault_secret, v_plain_token, v_vault_token;
  end if;
  raise notice '#1053 搬資料核對通過:secret % 列、token % 列', v_vault_secret, v_vault_token;
end;
$$;
