-- 修正 20260921170100_login_email_security_functions.sql 的一個真實 bug:
-- get_staff_login_email_status/get_agent_login_email_status 原本寫 `u.new_email`——這是誤把
-- supabase-js User 物件(API 回應 JSON)的欄位名稱,當成資料庫實際欄位名稱。實際在
-- auth.users 這張表裡,存放「待驗證新信箱」的欄位叫 email_change,不是 new_email
-- (`new_email` 只存在於 GoTrue 回傳給前端的 JSON,不是 Postgres 資料表欄位)。
--
-- 用本機完整 Supabase stack 跑 supabase test db --local 時,pgTAP 測試
-- login_email_security_01_request_clear_status.sql 實際呼叫這兩支函式,重現
-- `ERROR: column u.new_email does not exist`,才發現這個 bug——這兩支函式在
-- 20260921170100 建立後從未被實際呼叫過(CREATE FUNCTION 不會驗證 plpgsql 內嵌 SQL 引用的
-- 欄位是否存在,只有真正執行到那段程式碼時才會報錯),所以套用 migration 當下沒有立即出錯。
-- 已確認正式環境(wjtbmmnakcriuaqoknsq)auth.users 也是 email_change 欄位,不是 new_email,
-- 這裡是修正一個真實會在正式環境炸掉的 bug,不是本機環境特有的差異。

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
      nullif(u.email_change, '')::text as pending_confirmation_email,
      u.email_change_sent_at as pending_confirmation_sent_at
    from public.merchant_staff ms
    left join auth.users u on u.id = ms.user_id
    where ms.id = p_staff_id;
end;
$$;

comment on function public.get_staff_login_email_status(uuid) is '對應規格書 2.4.3:管理員查詢某位服務人員目前實際的登入 email(即時查 auth.users,不是 invited_login_email 那份歷史快照)以及兩種待驗證狀態(規則 2.3.3)。授權給 authenticated(不是只給 service_role),因為這是管理員直接從瀏覽器發起的查詢,內部自己做 is_merchant_admin 檢查。2026-09-21 修正:auth.users 存放待驗證新信箱的欄位是 email_change,不是 new_email(new_email 只是 supabase-js User 物件回傳給前端時用的欄位名稱)——用 nullif(..., '''') 是因為 GoTrue 沒有待驗證變更時這個欄位是空字串,不是 null。';

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
      nullif(u.email_change, '')::text as pending_confirmation_email,
      u.email_change_sent_at as pending_confirmation_sent_at
    from public.merchant_agents ma
    left join auth.users u on u.id = ma.user_id
    where ma.id = p_agent_id;
end;
$$;

comment on function public.get_agent_login_email_status(uuid) is '對應規格書 2.4.3:設計理由完全比照 get_staff_login_email_status,同一次修正 email_change 欄位名稱的 bug。';
