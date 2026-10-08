-- 客戶端第 2 批(模組 13)— migration 4:QA 打回修正
-- 前提:20261008170000 ~ 20261008170200 已套用。這支沒有任何既有資料的寫入或刪除。
--
-- 1. C2-H01 第 3 點:「用 email 找帳號 → 給權限」的地方一律排除客人帳號(raw_app_meta_data.account_type = customer),
--    當作「找不到帳號」,錯誤訊息跟真的找不到逐字相同。其餘本體逐字不變(CREATE OR REPLACE 保留 ACL 與註解)。
--      public.invite_merchant_admin          商家管理員邀請另一位管理員
--      public.platform_add_merchant_admin    平台幫商家加管理員
--      public.platform_set_group_admin       平台指定集團管理者
--      public.lookup_auth_account_by_email   invite-merchant-agent / invite-merchant-staff 判斷邀請方式
--      public.lookup_user_id_by_email        舊的查詢函式(目前沒有程式呼叫,一併收斂)
-- 2. internal_customer_line_login_consume:那一列還在(過期 / 用過)時,login_expired 也回 slug,
--    讓 callback 頁可以顯示「回店家首頁」;查無此列(偽造的 state)照舊不回 slug。
--
-- 改前指紋(正式庫 wjtbmmnakcriuaqoknsq 2026-10-08 唯讀實查 = 本機):
--   invite_merchant_admin 81ac83f7b752f5ec4b233bb34e753c0f / platform_add_merchant_admin e4d5368af4f98ffb2a1b19252b1775f1
--   platform_set_group_admin 87067aed786e307751f467b989b64cd3 / lookup_auth_account_by_email 7fc88945ad58d65251a6eec7433157af
--   lookup_user_id_by_email a7cd84ea20822be2f5e849deaf253355
--   internal_customer_line_login_consume(本批新增,本機)c04772467515b7e4a8eaa4c8863f2081

-- ----- public.invite_merchant_admin -----
CREATE OR REPLACE FUNCTION public.invite_merchant_admin(p_merchant_id uuid, p_user_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  if not exists (select 1 from public.merchants where id = p_merchant_id) then
    raise exception '找不到指定的商家：%', p_merchant_id;
  end if;

  -- email 比對時 trim + lower,避免大小寫或前後空白差異造成「明明有帳號卻查不到」的誤判
  -- (沿用模組 2 platform_add_merchant_admin 的既有做法)。
  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_user_email))
    -- [c2-qa] 客戶端 LINE 登入的客人帳號一律當作「找不到」(訊息跟真的找不到一樣,不透露是客人帳號)。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer';

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.merchant_admins
    where merchant_id = p_merchant_id and user_id = v_user_id
  ) then
    raise exception '這個人已經是管理員了' using errcode = 'P0001';
  end if;

  insert into public.merchant_admins (merchant_id, user_id)
  values (p_merchant_id, v_user_id);
end;
$function$;

-- ----- public.platform_add_merchant_admin -----
CREATE OR REPLACE FUNCTION public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  if not exists (select 1 from public.merchants where id = p_merchant_id) then
    raise exception '找不到指定的商家：%', p_merchant_id;
  end if;

  -- email 比對時 trim + lower，避免大小寫或前後空白差異造成「明明有帳號卻查不到」的誤判。
  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_user_email))
    -- [c2-qa] 客戶端 LINE 登入的客人帳號一律當作「找不到」(訊息跟真的找不到一樣,不透露是客人帳號)。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer';

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.merchant_admins
    where merchant_id = p_merchant_id and user_id = v_user_id
  ) then
    raise exception '這個人已經是管理員了' using errcode = 'P0001';
  end if;

  insert into public.merchant_admins (merchant_id, user_id)
  values (p_merchant_id, v_user_id);
end;
$function$;

-- ----- public.platform_set_group_admin -----
CREATE OR REPLACE FUNCTION public.platform_set_group_admin(p_group_id uuid, p_user_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_orphan_merchant_count integer;
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  if not exists (select 1 from public.groups where id = p_group_id) then
    raise exception '找不到指定的集團：%', p_group_id;
  end if;

  if p_user_email is null then
    select count(*) into v_orphan_merchant_count
    from public.merchants m
    where m.group_id = p_group_id
      and not exists (
        select 1 from public.merchant_admins ma where ma.merchant_id = m.id
      );

    if v_orphan_merchant_count > 0 then
      raise exception '清空集團管理者後，集團底下會有商家沒有任何人能登入管理，請先為這些商家新增管理員' using errcode = 'P0001';
    end if;

    update public.groups set group_admin_user_id = null where id = p_group_id;
    return;
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_user_email))
    -- [c2-qa] 客戶端 LINE 登入的客人帳號一律當作「找不到」(訊息跟真的找不到一樣,不透露是客人帳號)。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer';

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
  end if;

  update public.groups set group_admin_user_id = v_user_id where id = p_group_id;
end;
$function$;

-- ----- public.lookup_auth_account_by_email -----
CREATE OR REPLACE FUNCTION public.lookup_auth_account_by_email(p_email text)
 RETURNS TABLE(user_id uuid, email_confirmed boolean, is_activated boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    u.id,
    u.email_confirmed_at is not null,
    u.email_confirmed_at is not null
      and not exists (
        select 1 from public.merchant_agents a where a.user_id = u.id and a.status = 'invited'
      )
      and not exists (
        select 1 from public.merchant_staff s where s.user_id = u.id and s.login_status = 'invited'
      )
  from auth.users u
  where lower(u.email) = lower(trim(p_email))
    -- [c2-qa] 客人帳號一律當作查無帳號(邀請客服 / 服務人員不能挑到客人帳號)。
    and coalesce(u.raw_app_meta_data ->> 'account_type', '') <> 'customer'
  limit 1;
$function$;

-- ----- public.lookup_user_id_by_email -----
CREATE OR REPLACE FUNCTION public.lookup_user_id_by_email(p_email text)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from auth.users where lower(email) = lower(trim(p_email))
    -- [c2-qa] 客人帳號一律當作查無帳號。
    and coalesce(raw_app_meta_data ->> 'account_type', '') <> 'customer';
$function$;

-- ----- public.internal_customer_line_login_consume -----
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

  if not found then
    -- 偽造 / 已被清理的 state:不回任何店家資訊。
    return jsonb_build_object('status', 'login_expired');
  end if;

  select booking_slug into v_slug from public.merchants where id = v_row.merchant_id;

  if v_row.consumed_at is not null then
    -- [c2-qa] 已用過(例如重新整理 callback 頁):回 slug 讓前端顯示「回店家首頁」。
    return jsonb_build_object('status', 'login_expired', 'slug', v_slug);
  end if;

  v_draft := v_row.draft;
  update public.customer_line_login_attempts
     set consumed_at = now(), draft = null
   where state_hash = p_state_hash;

  if v_row.expires_at <= now() then
    return jsonb_build_object('status', 'login_expired', 'slug', v_slug);
  end if;

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
comment on function public.internal_customer_line_login_consume(text) is 'C2-B03 第 1、2、11 步:用 state 雜湊找登入暫存。查無此列 ⇒ login_expired(不帶 slug);已用過 / 過期 ⇒ login_expired + slug(讓前端顯示「回店家首頁」,QA 第 2 批);否則標成已使用、draft 清成 null 並回傳。只給 service_role。';
