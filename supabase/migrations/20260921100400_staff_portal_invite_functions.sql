-- 模組 14:服務人員端(功能層,第五支)。
-- 對應規格書 3.11(record_invited_staff_login)、3.12(mark_staff_login_active_if_self)。

-- =========================================================================
-- 3.11 record_invited_staff_login(p_staff_id, p_user_id, p_invited_login_email, p_login_status)
-- 只授權給 service_role(revoke authenticated/anon/public),供 Edge Function
-- invite-merchant-staff 呼叫。更新指定 merchant_staff 那一列的 user_id/invited_login_email/
-- login_status/login_invited_at,p_login_status='active' 時(查無帳號時走邀請信以外、輸入
-- email 已有既有帳號的分支)一併寫入 login_activated_at=now()。成功後緊接著呼叫
-- seed_default_staff_permissions(p_staff_id)——不管是走邀請信還是既有帳號分支,都要種預設權限。
-- 這支函式不做權限檢查(呼叫者身份的判斷已經在 Edge Function 第一步做完,而且只有 service_role
-- 能執行)。
-- =========================================================================
create or replace function public.record_invited_staff_login(
  p_staff_id uuid,
  p_user_id uuid,
  p_invited_login_email text,
  p_login_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_login_status not in ('invited', 'active') then
    raise exception '不合法的登入狀態: %', p_login_status;
  end if;

  if p_user_id is null then
    raise exception 'p_user_id 不可為 null';
  end if;

  update public.merchant_staff
  set user_id = p_user_id,
      invited_login_email = p_invited_login_email,
      login_status = p_login_status,
      login_invited_at = now(),
      login_activated_at = case when p_login_status = 'active' then now() else login_activated_at end
  where id = p_staff_id;

  if not found then
    raise exception '找不到指定的服務人員紀錄: %', p_staff_id;
  end if;

  perform public.seed_default_staff_permissions(p_staff_id);
end;
$$;

comment on function public.record_invited_staff_login(uuid, uuid, text, text) is '對應規格書 3.11:只給 service_role 呼叫,由 Edge Function invite-merchant-staff 寫入邀請結果,並緊接著呼叫 seed_default_staff_permissions 種入預設權限(判斷 1)。';

revoke all on function public.record_invited_staff_login(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_invited_staff_login(uuid, uuid, text, text) to service_role;

-- =========================================================================
-- 3.12 mark_staff_login_active_if_self()
-- 比照既有 mark_agent_active_if_self 的寫法,只能改「自己」的紀錄(用 auth.uid() 比對,
-- 不接受外部傳入參數),不需要額外權限檢查。
-- =========================================================================
create or replace function public.mark_staff_login_active_if_self()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  update public.merchant_staff
  set login_status = 'active', login_activated_at = now()
  where user_id = auth.uid() and login_status = 'invited';
end;
$$;

comment on function public.mark_staff_login_active_if_self() is '對應規格書 3.12:服務人員完成 Supabase 邀請信的設定密碼流程後,轉場頁載入時呼叫,把自己所有 login_status=invited 的紀錄一次改成 active。只能改自己的紀錄,呼叫者無法影響到別人。';

revoke execute on function public.mark_staff_login_active_if_self() from public, anon;
grant execute on function public.mark_staff_login_active_if_self() to authenticated;
