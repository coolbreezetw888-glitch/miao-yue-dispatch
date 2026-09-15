-- 模組 3:人員與權限管理(功能層)
-- 對應規格書第三節 3.2(am_i_merchant_admin)、3.3(invite_merchant_admin/remove_merchant_admin)、
-- 3.6(record_invited_merchant_agent)、3.7(remove_merchant_agent)、3.8(mark_agent_active_if_self)、
-- 3.9(set_agent_permission),以及一個規格書沒有明列、Edge Function(3.5)需要的輔助查詢函式。

-- =========================================================================
-- 3.2 public.am_i_merchant_admin(p_merchant_id uuid)
-- 包一層呼叫 private.is_merchant_admin,給前端與 3.5 Edge Function 呼叫(Edge Function 用
-- 呼叫者的 JWT 建立 client 後呼叫這支 RPC 確認權限)。跟 am_i_platform_admin() 同樣的設計精神:
-- 這只是「能不能執行操作」的前端/Edge Function 判斷窗口,不是安全邊界本身。
-- =========================================================================
create or replace function public.am_i_merchant_admin(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select private.is_merchant_admin(p_merchant_id);
$$;

comment on function public.am_i_merchant_admin(uuid) is '對應規格書 3.2:前端與 Edge Function(3.5)呼叫用,回傳目前登入者是否為指定商家的管理員。';

revoke execute on function public.am_i_merchant_admin(uuid) from public, anon;
grant execute on function public.am_i_merchant_admin(uuid) to authenticated;

-- =========================================================================
-- 3.3 invite_merchant_admin / remove_merchant_admin
-- 邏輯完全比照模組 2 的 platform_add_merchant_admin/platform_remove_merchant_admin,
-- 唯一差異是權限檢查條件改成 private.is_merchant_admin(p_merchant_id)(商家管理員自己邀請/移除
-- 另一位管理員,不是超級管理員代客服操作)。
-- =========================================================================
create or replace function public.invite_merchant_admin(
  p_merchant_id uuid,
  p_user_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  if not exists (select 1 from public.merchants where id = p_merchant_id) then
    raise exception '找不到指定的商家: %', p_merchant_id;
  end if;

  -- email 比對時 trim + lower,避免大小寫或前後空白差異造成「明明有帳號卻查不到」的誤判
  -- (沿用模組 2 platform_add_merchant_admin 的既有做法)。
  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_user_email));

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者,請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
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
$$;

comment on function public.invite_merchant_admin(uuid, text) is '對應規格書 3.3/規則 2.3:商家管理員邀請另一位管理員(只能邀請已註冊帳號),查無 email 或已是管理員回傳明確錯誤。';

revoke execute on function public.invite_merchant_admin(uuid, text) from public, anon;
grant execute on function public.invite_merchant_admin(uuid, text) to authenticated;

create or replace function public.remove_merchant_admin(
  p_merchant_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_admin_user_id uuid;
  v_remaining_count integer;
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  select g.group_admin_user_id into v_group_admin_user_id
  from public.merchants m
  join public.groups g on g.id = m.group_id
  where m.id = p_merchant_id;

  if not found then
    raise exception '找不到指定的商家: %', p_merchant_id;
  end if;

  if v_group_admin_user_id is null then
    select count(*) into v_remaining_count
    from public.merchant_admins
    where merchant_id = p_merchant_id
      and user_id <> p_user_id;

    if v_remaining_count = 0 then
      raise exception '移除後這間店會沒有任何人能登入管理,請先新增其他管理員' using errcode = 'P0001';
    end if;
  end if;

  delete from public.merchant_admins
  where merchant_id = p_merchant_id and user_id = p_user_id;
end;
$$;

comment on function public.remove_merchant_admin(uuid, uuid) is '對應規格書 3.3/規則 2.4:商家管理員移除另一位管理員,若移除後該商家會變成無人可管(且集團也沒有集團管理者)則擋下並提示。';

revoke execute on function public.remove_merchant_admin(uuid, uuid) from public, anon;
grant execute on function public.remove_merchant_admin(uuid, uuid) to authenticated;

-- =========================================================================
-- 規格書沒有明列的輔助函式:lookup_user_id_by_email
-- 3.5 Edge Function 需要「查詢某個 email 是否已有 auth.users 帳號」(規則 2.6)。
-- supabase-js 的 Admin API 沒有穩定的 getUserByEmail 方法(只有 listUsers 分頁列舉),
-- 直接用 Admin API 找特定 email 不可靠;比照模組 1/2「auth.users 不能被前端直接查,一律包一層
-- 有權限檢查的函式」的既有原則,寫一個只給 service_role 呼叫的查詢函式,由 Edge Function
-- (已經用 service_role key)呼叫,做法更明確、可測試。這是工程師實作時發現規格書 3.5 沒講清楚
-- 的技術細節,已在回報中向主腦/使用者說明。
-- 這支函式本身不做權限檢查(呼叫者是誰的判斷已經在 Edge Function 第一步做完,而且只有
-- service_role 能執行,前端/一般 authenticated 使用者呼叫不到),比照 3.6 的設計方式。
-- =========================================================================
create or replace function public.lookup_user_id_by_email(p_email text)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from auth.users where lower(email) = lower(trim(p_email));
$$;

comment on function public.lookup_user_id_by_email(text) is '查詢 email 對應的 auth.users id,只給 service_role 呼叫(供 Edge Function invite-merchant-agent 使用),不開放前端/一般登入使用者。';

revoke all on function public.lookup_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.lookup_user_id_by_email(text) to service_role;

-- =========================================================================
-- 3.6 record_invited_merchant_agent
-- 只授權給 service_role,供 3.5 的 Edge Function 呼叫。同一 merchant_id+user_id 已有
-- active/invited 紀錄回傳明確錯誤;已有 removed 舊紀錄則重新啟用(更新既有列,不是插入新列,
-- 保留舊的 merchant_agent_permissions 設定,見規格書 3.6 邊界情況)。
-- 這支函式不做權限檢查(呼叫者是誰的判斷已經在 3.5 Edge Function 第一步做完)。
-- =========================================================================
create or replace function public.record_invited_merchant_agent(
  p_merchant_id uuid,
  p_user_id uuid,
  p_invited_email text,
  p_name text,
  p_nickname text,
  p_phone text,
  p_status text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_id uuid;
  v_existing_status text;
begin
  if p_status not in ('invited', 'active') then
    raise exception '不合法的狀態: %', p_status;
  end if;

  if p_user_id is null then
    raise exception 'p_user_id 不可為 null';
  end if;

  select id, status into v_agent_id, v_existing_status
  from public.merchant_agents
  where merchant_id = p_merchant_id and user_id = p_user_id;

  if found then
    if v_existing_status in ('invited', 'active') then
      raise exception '這個人已經是這間店的客服了' using errcode = 'P0001';
    end if;

    -- 重新啟用舊的 removed 紀錄:更新既有列而不是插入新列,保留舊的權限設定
    -- (merchant_agent_permissions 透過 agent_id 外鍵掛在這個既有的 id 上,不會變成孤兒資料)。
    update public.merchant_agents
    set status = p_status,
        invited_email = p_invited_email,
        name = p_name,
        nickname = p_nickname,
        phone = p_phone,
        invited_at = now(),
        activated_at = case when p_status = 'active' then now() else null end
    where id = v_agent_id;

    return v_agent_id;
  end if;

  insert into public.merchant_agents (
    merchant_id, user_id, invited_email, name, nickname, phone, status, activated_at
  ) values (
    p_merchant_id, p_user_id, p_invited_email, p_name, p_nickname, p_phone, p_status,
    case when p_status = 'active' then now() else null end
  )
  returning id into v_agent_id;

  return v_agent_id;
end;
$$;

comment on function public.record_invited_merchant_agent(uuid, uuid, text, text, text, text, text) is '對應規格書 3.6:只給 service_role 呼叫,由 Edge Function invite-merchant-agent 寫入邀請結果。';

revoke all on function public.record_invited_merchant_agent(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_invited_merchant_agent(uuid, uuid, text, text, text, text, text) to service_role;

-- =========================================================================
-- 3.7 remove_merchant_agent(p_agent_id uuid)
-- 檢查 is_merchant_admin(該筆 merchant_id),通過後軟刪除。
-- =========================================================================
create or replace function public.remove_merchant_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄: %', p_agent_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  update public.merchant_agents
  set status = 'removed'
  where id = p_agent_id;
end;
$$;

comment on function public.remove_merchant_agent(uuid) is '對應規格書 3.7/規則 2.8-2.9:商家管理員移除客服(軟刪除)。移除後 private.is_merchant_agent() 會因為 status 不再是 active 而回傳 false,見規則 2.9。';

revoke execute on function public.remove_merchant_agent(uuid) from public, anon;
grant execute on function public.remove_merchant_agent(uuid) to authenticated;

-- =========================================================================
-- 3.8 mark_agent_active_if_self()
-- 只能改「自己」的紀錄(用 auth.uid() 比對,不接受外部傳入 user_id 參數),不需要額外權限檢查。
-- =========================================================================
create or replace function public.mark_agent_active_if_self()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  update public.merchant_agents
  set status = 'active', activated_at = now()
  where user_id = auth.uid() and status = 'invited';
end;
$$;

comment on function public.mark_agent_active_if_self() is '對應規格書 3.8/規則 2.7:客服完成 Supabase 邀請信的設定密碼流程後,轉場頁載入時呼叫,把自己所有 invited 狀態的紀錄一次改成 active。只能改自己的紀錄,呼叫者無法影響到別人。';

revoke execute on function public.mark_agent_active_if_self() from public, anon;
grant execute on function public.mark_agent_active_if_self() to authenticated;

-- =========================================================================
-- 3.9 set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)
-- 檢查 is_merchant_admin(該筆 merchant_id),通過後 upsert 一筆 merchant_agent_permissions。
-- =========================================================================
create or replace function public.set_agent_permission(
  p_agent_id uuid,
  p_section_key text,
  p_granted boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄: %', p_agent_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  insert into public.merchant_agent_permissions (agent_id, section_key, granted)
  values (p_agent_id, p_section_key, p_granted)
  on conflict (agent_id, section_key)
  do update set granted = excluded.granted, updated_at = now();
end;
$$;

comment on function public.set_agent_permission(uuid, text, boolean) is '對應規格書 3.9:商家管理員逐項開關某位客服能看到/操作哪些後台功能區塊。';

revoke execute on function public.set_agent_permission(uuid, text, boolean) from public, anon;
grant execute on function public.set_agent_permission(uuid, text, boolean) to authenticated;
