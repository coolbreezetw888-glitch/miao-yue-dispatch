-- 對應規格書 .project/specs/帳號登入安全性優化.md 第二節 2.4.1/2.4.2/2.4.3。
-- 6 支 SECURITY DEFINER 函式,授權對象都是 authenticated(呼叫者自己的 JWT 直接打,不透過
-- Edge Function——這幾支都不需要碰 service_role 金鑰,內部自己做權限檢查即可,比照既有
-- update_my_agent_profile/set_agent_permission 等函式的既有慣例)。

-- =========================================================================
-- 2.4.1 request_staff_login_email_change(p_staff_id, p_new_email)
-- =========================================================================
create or replace function public.request_staff_login_email_change(
  p_staff_id uuid,
  p_new_email text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_login_status text;
  v_email text;
begin
  select merchant_id, status, login_status
    into v_merchant_id, v_status, v_login_status
  from public.merchant_staff
  where id = p_staff_id;

  if v_merchant_id is null then
    raise exception '找不到這位服務人員' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'active' or v_login_status <> 'active' then
    raise exception '這位服務人員尚未開通登入,無法設定登入信箱建議' using errcode = 'P0001';
  end if;

  v_email := lower(trim(p_new_email));
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception '信箱格式不正確' using errcode = 'P0001';
  end if;

  -- 邊界情況(2.4.1):重複呼叫直接覆蓋前一筆建議,不留歷史紀錄。
  perform set_config('staff_agent.bypass_pending_login_email_guard', 'on', true);
  update public.merchant_staff
  set pending_admin_login_email = v_email,
      pending_admin_login_email_requested_by = auth.uid(),
      pending_admin_login_email_requested_at = now()
  where id = p_staff_id;
end;
$$;

comment on function public.request_staff_login_email_change(uuid, text) is '對應規格書 2.4.1:商家管理員建議服務人員的新登入信箱。只寫入 pending 欄位,不呼叫任何 Supabase Auth API、不寄出任何信件(規則 2.3.1)。';

revoke all on function public.request_staff_login_email_change(uuid, text) from public, anon;
grant execute on function public.request_staff_login_email_change(uuid, text) to authenticated;

-- =========================================================================
-- 2.4.1 request_agent_login_email_change(p_agent_id, p_new_email)
-- =========================================================================
create or replace function public.request_agent_login_email_change(
  p_agent_id uuid,
  p_new_email text
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_email text;
begin
  select merchant_id, status
    into v_merchant_id, v_status
  from public.merchant_agents
  where id = p_agent_id;

  if v_merchant_id is null then
    raise exception '找不到這位客服' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception '這位客服尚未開通登入,無法設定登入信箱建議' using errcode = 'P0001';
  end if;

  v_email := lower(trim(p_new_email));
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception '信箱格式不正確' using errcode = 'P0001';
  end if;

  update public.merchant_agents
  set pending_admin_login_email = v_email,
      pending_admin_login_email_requested_by = auth.uid(),
      pending_admin_login_email_requested_at = now()
  where id = p_agent_id;
end;
$$;

comment on function public.request_agent_login_email_change(uuid, text) is '對應規格書 2.4.1:商家管理員建議客服的新登入信箱,設計理由完全比照 request_staff_login_email_change。merchant_agents 沒有給 authenticated 的 UPDATE RLS 政策,這裡的 UPDATE 是透過 SECURITY DEFINER 函式擁有者權限執行,不需要額外的欄位保護觸發器。';

revoke all on function public.request_agent_login_email_change(uuid, text) from public, anon;
grant execute on function public.request_agent_login_email_change(uuid, text) to authenticated;

-- =========================================================================
-- 2.4.2 clear_staff_pending_login_email(p_staff_id)
-- =========================================================================
create or replace function public.clear_staff_pending_login_email(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_staff
  where id = p_staff_id;

  if v_merchant_id is null then
    raise exception '找不到這位服務人員' using errcode = 'P0001';
  end if;

  if not (private.is_merchant_admin(v_merchant_id) or private.is_own_staff_row(p_staff_id)) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  perform set_config('staff_agent.bypass_pending_login_email_guard', 'on', true);
  update public.merchant_staff
  set pending_admin_login_email = null,
      pending_admin_login_email_requested_by = null,
      pending_admin_login_email_requested_at = null
  where id = p_staff_id;
end;
$$;

comment on function public.clear_staff_pending_login_email(uuid) is '對應規格書 2.4.2:管理員撤回建議,或服務人員本人套用/忽略建議後清除這筆紀錄。允許管理員本人或服務人員本人呼叫。';

revoke all on function public.clear_staff_pending_login_email(uuid) from public, anon;
grant execute on function public.clear_staff_pending_login_email(uuid) to authenticated;

-- =========================================================================
-- 2.4.2 clear_agent_pending_login_email(p_agent_id)
-- =========================================================================
create or replace function public.clear_agent_pending_login_email(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if v_merchant_id is null then
    raise exception '找不到這位客服' using errcode = 'P0001';
  end if;

  if not (private.is_merchant_admin(v_merchant_id) or private.is_own_agent_row(p_agent_id)) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  update public.merchant_agents
  set pending_admin_login_email = null,
      pending_admin_login_email_requested_by = null,
      pending_admin_login_email_requested_at = null
  where id = p_agent_id;
end;
$$;

comment on function public.clear_agent_pending_login_email(uuid) is '對應規格書 2.4.2:設計理由完全比照 clear_staff_pending_login_email。';

revoke all on function public.clear_agent_pending_login_email(uuid) from public, anon;
grant execute on function public.clear_agent_pending_login_email(uuid) to authenticated;

-- =========================================================================
-- 2.4.3 get_staff_login_email_status(p_staff_id)
-- =========================================================================
create or replace function public.get_staff_login_email_status(p_staff_id uuid)
returns table (
  current_login_email text,
  pending_admin_suggested_email text,
  pending_confirmation_email text,
  pending_confirmation_sent_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_staff
  where id = p_staff_id;

  if v_merchant_id is null then
    raise exception '找不到這位服務人員' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  return query
    select
      u.email::text as current_login_email,
      ms.pending_admin_login_email as pending_admin_suggested_email,
      u.new_email::text as pending_confirmation_email,
      u.email_change_sent_at as pending_confirmation_sent_at
    from public.merchant_staff ms
    left join auth.users u on u.id = ms.user_id
    where ms.id = p_staff_id;
end;
$$;

comment on function public.get_staff_login_email_status(uuid) is '對應規格書 2.4.3:管理員查詢某位服務人員目前實際的登入 email(即時查 auth.users,不是 invited_login_email 那份歷史快照)以及兩種待驗證狀態(規則 2.3.3)。授權給 authenticated(不是只給 service_role),因為這是管理員直接從瀏覽器發起的查詢,內部自己做 is_merchant_admin 檢查。';

revoke all on function public.get_staff_login_email_status(uuid) from public, anon;
grant execute on function public.get_staff_login_email_status(uuid) to authenticated;

-- =========================================================================
-- 2.4.3 get_agent_login_email_status(p_agent_id)
-- =========================================================================
create or replace function public.get_agent_login_email_status(p_agent_id uuid)
returns table (
  current_login_email text,
  pending_admin_suggested_email text,
  pending_confirmation_email text,
  pending_confirmation_sent_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if v_merchant_id is null then
    raise exception '找不到這位客服' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  return query
    select
      u.email::text as current_login_email,
      ma.pending_admin_login_email as pending_admin_suggested_email,
      u.new_email::text as pending_confirmation_email,
      u.email_change_sent_at as pending_confirmation_sent_at
    from public.merchant_agents ma
    left join auth.users u on u.id = ma.user_id
    where ma.id = p_agent_id;
end;
$$;

comment on function public.get_agent_login_email_status(uuid) is '對應規格書 2.4.3:設計理由完全比照 get_staff_login_email_status。';

revoke all on function public.get_agent_login_email_status(uuid) from public, anon;
grant execute on function public.get_agent_login_email_status(uuid) to authenticated;
