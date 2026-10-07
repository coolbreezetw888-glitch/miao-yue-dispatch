-- 第 13 批 #1002:同一信箱被第二家商家邀請時,狀態誤變「已啟用」。
-- 規格書:.project/specs/重複邀請未開通帳號狀態錯誤-第13批.md
--
-- 【原因】
-- Edge Function invite-merchant-agent / invite-merchant-staff 原本只用 lookup_user_id_by_email
-- 判斷「這個 email 有沒有 auth 帳號」,有就直接寫 active。但 A 商家寄邀請信時 Supabase 就已經
-- 建好一個「還沒開通」的 auth 帳號,所以 B 商家查到「已有帳號」就誤判成已啟用。
--
-- 【「開通過」的判斷標準(規則 1)】
-- 現有的 invited → active 轉換點是:本人點邀請信連結 → 轉場頁設定密碼成功 → 呼叫
-- mark_agent_active_if_self / mark_staff_login_active_if_self,把本人「所有」invited 紀錄一次轉成 active。
-- 所以用同一個標準判斷「開通過」=
--   (1) email 已確認(auth.users.email_confirmed_at 有值:點過邀請/確認信連結,或自己註冊的帳號),而且
--   (2) 本人在 merchant_agents / merchant_staff 都沒有還停在 invited 的紀錄(轉場頁那一步已經做完)。
-- 為什麼不用「有沒有密碼」:本機實測,點邀請連結那一刻 GoTrue 就會在 encrypted_password 寫入一組值,
-- 沒走完轉場頁的人也「有密碼」,分不出來。
-- 為什麼不用「有沒有 active 紀錄」:被這個 bug 誤寫成 active 的紀錄(正式庫目前有 1 筆)會讓沒開通的人
-- 被當成已開通;看「還有沒有 invited」才不會被髒資料騙。
-- 已知邊界:點過連結、沒設密碼,而且邀請他的商家後來把他移除(紀錄變 removed、沒有 invited 紀錄了)——
-- 這種人會被當成已開通、下一家直接 active;他可以用登入頁「忘記密碼」設定密碼。極少見,不另外處理。
--
-- 本檔內容:
--   §1 新增 public.lookup_auth_account_by_email:只給 service_role,回傳 user_id + 是否已確認 email
--      + 是否已開通,讓 Edge Function 分情況處理。既有 lookup_user_id_by_email 不動
--      (e2e fixture 等其他地方仍在用)。
--   §2 mark_agent_active_if_self / mark_staff_login_active_if_self 改成「兩張表一起轉」。
--      原因:同一個信箱可能 A 商家邀請成客服、B 商家邀請成服務人員。B 重寄邀請信後 A 那封信的連結
--      會失效(Supabase 重寄會換掉驗證碼),對方只會點最新那封、進到其中一個轉場頁;如果轉場頁只轉
--      自己那張表,另一張表的 invited 紀錄就永遠沒有機會變 active。本人設好密碼就代表已經證明掌控
--      這個信箱,所有「寄給這個帳號的邀請」都應該一起生效(規則 4:所有商家都要變已啟用)。
--      兩支函式的 where 條件仍是 user_id = auth.uid(),只能動自己的紀錄。
-- =========================================================================

-- =========================================================================
-- §1 lookup_auth_account_by_email
-- =========================================================================
create or replace function public.lookup_auth_account_by_email(p_email text)
returns table (user_id uuid, email_confirmed boolean, is_activated boolean)
language sql
security definer
stable
set search_path = public
as $$
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
  limit 1;
$$;

comment on function public.lookup_auth_account_by_email(text) is '第 13 批 #1002:查詢 email 對應的 auth 帳號與開通狀態,只給 service_role 呼叫(供 Edge Function invite-merchant-agent / invite-merchant-staff 使用)。email_confirmed=email 已確認(點過連結或自己註冊);is_activated=email 已確認,而且本人在 merchant_agents / merchant_staff 沒有任何還停在 invited 的紀錄(= 轉場頁設定密碼、mark_*_active_if_self 那一步已經做完,跟既有 invited→active 轉換同一個標準)。查不到帳號回 0 列。';

revoke all on function public.lookup_auth_account_by_email(text) from public, anon, authenticated;
grant execute on function public.lookup_auth_account_by_email(text) to service_role;

-- =========================================================================
-- §2a mark_agent_active_if_self:客服轉場頁。原本只轉 merchant_agents,現在一併轉
--     merchant_staff 的 login_status(merchant_staff 有身分欄位保護 trigger,比照
--     mark_staff_login_active_if_self 用 transaction-local 旗標放行,用完馬上關掉)。
-- 簽章、returns、security definer、search_path、權限完全維持原樣。
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

  perform set_config('staff_agent.bypass_staff_identity_guard', 'on', true);
  update public.merchant_staff
  set login_status = 'active', login_activated_at = now()
  where user_id = auth.uid() and login_status = 'invited';
  perform set_config('staff_agent.bypass_staff_identity_guard', 'off', true);
end;
$$;

comment on function public.mark_agent_active_if_self() is '對應規格書 3.8/規則 2.7:客服完成 Supabase 邀請信的設定密碼流程後,轉場頁載入時呼叫,把自己所有 invited 狀態的紀錄一次改成 active。只能改自己的紀錄,呼叫者無法影響到別人。第 13 批 #1002:一併把自己在 merchant_staff 的 login_status=invited 改成 active(同一信箱可能同時被邀成客服與服務人員,重寄邀請後只有最新那封信的連結有效,本人走哪個轉場頁都要讓所有邀請一起生效)。';

revoke execute on function public.mark_agent_active_if_self() from public, anon;
grant execute on function public.mark_agent_active_if_self() to authenticated;

-- =========================================================================
-- §2b mark_staff_login_active_if_self:服務人員轉場頁。原本只轉 merchant_staff,現在一併轉
--     merchant_agents。簽章、returns、security definer、search_path、權限完全維持原樣。
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

  perform set_config('staff_agent.bypass_staff_identity_guard', 'on', true);
  update public.merchant_staff
  set login_status = 'active', login_activated_at = now()
  where user_id = auth.uid() and login_status = 'invited';
  perform set_config('staff_agent.bypass_staff_identity_guard', 'off', true);

  update public.merchant_agents
  set status = 'active', activated_at = now()
  where user_id = auth.uid() and status = 'invited';
end;
$$;

comment on function public.mark_staff_login_active_if_self() is '對應規格書 3.12:服務人員完成 Supabase 邀請信的設定密碼流程後,轉場頁載入時呼叫,把自己所有 login_status=invited 的紀錄一次改成 active。只能改自己的紀錄,呼叫者無法影響到別人。2026-09-24(A3):新增的 merchant_staff_protect_identity_columns trigger 會擋下非管理員對 login_status 的異動,這裡在 update 前後用 transaction-local 旗標 staff_agent.bypass_staff_identity_guard 放行這條已經自行檢查過「只能改自己」的合法路徑。第 13 批 #1002:一併把自己在 merchant_agents 的 status=invited 改成 active(理由同 mark_agent_active_if_self)。';

revoke execute on function public.mark_staff_login_active_if_self() from public, anon;
grant execute on function public.mark_staff_login_active_if_self() to authenticated;
