-- 模組 15 擴充:手機推播擴及三種角色 — 函式層
-- 對應規格書 §2.1(裝置登記 upsert)、§2.6、§3.3、§5.1、§6.1 第 5 步、§6.6。
-- 需求編號 #720、#723、#724、#732、#737、#742。
--
-- ⚠️ supabase-permission-hygiene 規則 1:每一支函式都把 revoke/grant 整組寫完,
--    「revoke from public, anon, authenticated」不可以只寫 public, anon。
--    這裡有兩支 drop + create 換簽章/換名的函式(get_staff_push_subscription_count →
--    get_staff_push_status),依規則 1 的「drop function 之後重新 create,一律把 revoke/grant
--    整組重寫一次」處理,不依賴舊簽章的授權。

-- =========================================================================
-- §2.1 upsert_my_push_subscription:裝置登記的唯一寫入管道
--
-- 為什麼需要這一支(而不是前端直接 upsert):push_subscriptions 刻意沒有 UPDATE 政策,
-- 而 §2.1 邊界情況又要求「同一台手機換人登入時 endpoint 不變、主人要改掉」。
-- 兩者只能靠 SECURITY DEFINER 函式同時滿足,推導過程寫在 schema migration 的註解裡。
--
-- §4.1(核心安全規則):這支函式**不收 user_id / target_id 之類的身分參數**,
-- 一律從 auth.uid() 自己解析。前端沒有任何管道可以替別人登記裝置。
-- =========================================================================
create or replace function public.upsert_my_push_subscription(
  p_endpoint text,
  p_p256dh_key text,
  p_auth_key text,
  p_user_agent text default null
)
returns public.push_subscriptions
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.push_subscriptions;
begin
  if v_uid is null then
    raise exception '需要登入才能開啟推播通知' using errcode = '28000';
  end if;
  if p_endpoint is null or length(trim(p_endpoint)) = 0
     or p_p256dh_key is null or length(trim(p_p256dh_key)) = 0
     or p_auth_key is null or length(trim(p_auth_key)) = 0 then
    raise exception '瀏覽器沒有回傳完整的訂閱資訊' using errcode = '22023';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent)
  values (v_uid, p_endpoint, p_p256dh_key, p_auth_key, p_user_agent)
  on conflict (endpoint) do update
    set user_id = excluded.user_id,
        p256dh_key = excluded.p256dh_key,
        auth_key = excluded.auth_key,
        user_agent = excluded.user_agent,
        created_at = now()
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.upsert_my_push_subscription(text, text, text, text) is '§2.1:登記「我目前這台裝置」。on conflict 換主人是刻意的 —— 同一支手機換人登入(例如老闆把舊手機給員工用)時 endpoint 不變但主人變了,不改主人會讓通知送錯人。主人一律是 auth.uid(),函式不收任何身分參數(§4.1)。';

revoke execute on function public.upsert_my_push_subscription(text, text, text, text)
  from public, anon;
grant execute on function public.upsert_my_push_subscription(text, text, text, text)
  to authenticated;

-- =========================================================================
-- §2.6 get_merchant_push_event_enabled_map:商家總開關狀態的「窄窗口」
--
-- 為什麼需要:merchant_push_event_settings 的 RLS 要求 can_manage_push_notification,
-- 服務人員與沒有被開通權限的客服**讀不到**。不開這個窄窗口,他們的個人開關畫面就無法顯示
-- 「商家還沒開這個事件」的提示,只會出現「我明明開了卻收不到」的客訴。
--
-- 這不是新發明:模組 11 的 get_merchant_line_bot_public_info 是一模一樣的做法
-- (管理員專用函式導致客服看不到加好友連結,修法就是另開一支只回公開欄位的窄函式)。
-- 只回 event_type + enabled 兩欄,**不含 message_title / message_body**。
-- =========================================================================
create or replace function public.get_merchant_push_event_enabled_map(p_merchant_id uuid)
returns table (event_type text, enabled boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not exists (
       select 1 from public.merchant_admins a
       where a.merchant_id = p_merchant_id and a.user_id = auth.uid()
     )
     and not exists (
       select 1 from public.merchant_agents g
       where g.merchant_id = p_merchant_id and g.user_id = auth.uid() and g.status = 'active'
     )
     and not exists (
       select 1 from public.merchant_staff s
       where s.merchant_id = p_merchant_id and s.user_id = auth.uid()
         and s.status = 'active' and s.login_status = 'active'
     )
  then
    raise exception '沒有權限查看這個商家的推播事件開關狀態' using errcode = '42501';
  end if;

  return query
    select s.event_type, s.enabled
    from public.merchant_push_event_settings s
    where s.merchant_id = p_merchant_id;
end;
$$;

comment on function public.get_merchant_push_event_enabled_map(uuid) is '§2.6:回傳這間商家 4 種事件的「商家總開關」狀態,只有 event_type + enabled 兩欄,刻意不含通知文案。在職管理員/客服/服務人員三者任一即可呼叫(不要求 can_manage_push_notification),供 §7.4 的個人開關畫面判斷「這一項要不要灰掉」。';

revoke execute on function public.get_merchant_push_event_enabled_map(uuid) from public, anon;
grant execute on function public.get_merchant_push_event_enabled_map(uuid) to authenticated;

-- =========================================================================
-- §3.3 get_staff_push_status:取代 get_staff_push_subscription_count
--
-- 語意變了:裝置登記現在屬於登入帳號,所以「裝置數 > 0」只代表「這個人的手機能收通知」,
-- 不代表「他會收到這間店的訂單通知」——後者要看 push_event_subscriptions。
-- 只顯示裝置數會讓管理員誤判,所以改成回傳兩個值。
-- =========================================================================
drop function if exists public.get_staff_push_subscription_count(uuid);

create or replace function public.get_staff_push_status(p_staff_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_merchant_id uuid;
  v_user_id uuid;
  v_count int;
  v_any_enabled boolean;
begin
  select merchant_id, user_id into v_merchant_id, v_user_id
  from public.merchant_staff where id = p_staff_id;

  if v_merchant_id is null then
    raise exception '找不到這位服務人員' using errcode = 'P0002';
  end if;

  -- 權限維持原樣(§3.3 第 3 點):透過該服務人員的 merchant_id 判斷是不是商家管理員。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限查看這個商家的服務人員推播開通狀態' using errcode = '42501';
  end if;

  -- 沒被邀請登入的服務人員沒有 user_id,裝置一定是 0(§3.3 第 1 點)。
  if v_user_id is null then
    return jsonb_build_object('device_count', 0, 'any_event_enabled', false);
  end if;

  select count(*)::int into v_count
  from public.push_subscriptions where user_id = v_user_id;

  select exists (
    select 1 from public.push_event_subscriptions
    where merchant_id = v_merchant_id
      and target_type = 'staff'
      and target_id = p_staff_id
      and enabled
  ) into v_any_enabled;

  return jsonb_build_object('device_count', v_count, 'any_event_enabled', v_any_enabled);
end;
$$;

comment on function public.get_staff_push_status(uuid) is '§3.3:供服務人員詳情頁顯示推播狀態。回傳 {device_count, any_event_enabled} 兩個值,不回傳任何 endpoint/金鑰/裝置型號。為什麼不是單一整數:新設計下裝置屬於登入帳號,「已開通 2 台」不再等於「他會收到這間店的通知」(他可能四個事件全關),只顯示台數會讓老闆誤判。';

revoke execute on function public.get_staff_push_status(uuid) from public, anon;
grant execute on function public.get_staff_push_status(uuid) to authenticated;

-- =========================================================================
-- §5.1 resolve_push_recipients:把「這個事件要通知誰」收斂成一支資料庫函式
--
-- ⚠️ 這支函式會回傳別人的 user_id,**絕對不能開給前端**。
--    revoke execute from public, anon, authenticated —— 只有 service role 能呼叫,
--    比照既有的 render_booking_notification_variables / resolve_line_notification_targets。
--
-- ⚠️ §4.6 第 1 點:收件人一律從角色表 join 出來(不是直接讀 push_event_subscriptions.target_id
--    就發)。結果:停用/離職/被硬刪除的人,他的訂閱列就算還留在表裡也絕對不會被發送到。
--    這是這個設計天生的安全網,不依賴任何清理動作跑成功。
-- =========================================================================
create or replace function public.resolve_push_recipients(
  p_merchant_id uuid,
  p_event_type text,
  p_booking_staff_id uuid
)
returns table (
  target_type text,
  target_id uuid,
  target_user_id uuid,
  target_name text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  -- 服務人員分支:只有「被指派的那一位」,不是全店服務人員(§4.4 第 1 點)。
  select 'staff'::text, s.id, s.user_id, coalesce(nullif(trim(s.name), ''), '服務人員')
  from public.push_event_subscriptions pes
  join public.merchant_staff s on s.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'staff'
    and pes.event_type = p_event_type
    and pes.enabled
    and p_booking_staff_id is not null
    and s.id = p_booking_staff_id
    and s.merchant_id = p_merchant_id
    and s.status = 'active'
    and s.login_status = 'active'
    and s.user_id is not null

  union all

  -- 管理員分支:這間店的全部管理員,不看訂單指派(§4.4 第 2 點)。管理員沒有 status 欄位,
  -- 存在即有效(§4.6 第 2 點)。
  select 'admin'::text, a.id, a.user_id, coalesce(nullif(trim(a.display_name), ''), '商家管理員')
  from public.push_event_subscriptions pes
  join public.merchant_admins a on a.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'admin'
    and pes.event_type = p_event_type
    and pes.enabled
    and a.merchant_id = p_merchant_id
    and a.user_id is not null

  union all

  -- 客服分支:同上,額外要求 status = 'active'(§4.6 第 2 點)。
  select 'agent'::text, g.id, g.user_id, coalesce(nullif(trim(g.name), ''), '客服')
  from public.push_event_subscriptions pes
  join public.merchant_agents g on g.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'agent'
    and pes.event_type = p_event_type
    and pes.enabled
    and g.merchant_id = p_merchant_id
    and g.status = 'active'
    and g.user_id is not null;
$$;

comment on function public.resolve_push_recipients(uuid, text, uuid) is '§5.1:回傳這個事件的收件人清單(target_type/target_id/target_user_id/target_name)。兩支 Edge Function 共用,不在 TypeScript 裡各自拼 SQL。刻意不去重 —— 同一個 target_user_id 可能因為多重身份出現多次,去重發生在裝置層(§4.3),因為 log 要一個身份一列。只有 service role 能呼叫。';

revoke execute on function public.resolve_push_recipients(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_push_recipients(uuid, text, uuid) to service_role;

-- =========================================================================
-- §5.2 第 3 點 is_staff_event_disabled:被指派的服務人員「自己把這個事件關掉了」
-- 這是 §4.2 第 3 點那一列 skip_reason='personal_disabled' 記錄的判斷依據。
-- 同樣只給 service role。
-- =========================================================================
create or replace function public.is_staff_push_event_disabled(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_event_type text
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.push_event_subscriptions
    where merchant_id = p_merchant_id
      and target_type = 'staff'
      and target_id = p_staff_id
      and event_type = p_event_type
      and enabled = false
  );
$$;

comment on function public.is_staff_push_event_disabled(uuid, uuid, text) is '§4.2 第 3 點 / §5.2 第 3 點:這位被指派的服務人員是不是「有一列 enabled=false 的訂閱」。只有真的自己關掉才回 true(從來沒開通過的人回 false,那種情況不寫 personal_disabled 記錄,避免每筆訂單都在記錄表塞雜訊)。';

revoke execute on function public.is_staff_push_event_disabled(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.is_staff_push_event_disabled(uuid, uuid, text) to service_role;

-- =========================================================================
-- §6.1 第 5 步 get_my_push_identity:呼叫者在這間商家的身份與姓名
-- §4.1:不收任何身分參數,一律從 auth.uid() 自己反查。
-- 優先權 admin > agent > staff,跟 useMerchantRole(模組 3 §5.1)完全一致。
-- =========================================================================
create or replace function public.get_my_push_identity(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
  v_name text;
begin
  if v_uid is null then
    raise exception '需要登入' using errcode = '28000';
  end if;

  select a.id, coalesce(nullif(trim(a.display_name), ''), '商家管理員')
  into v_id, v_name
  from public.merchant_admins a
  where a.merchant_id = p_merchant_id and a.user_id = v_uid
  limit 1;
  if v_id is not null then
    return jsonb_build_object('target_type', 'admin', 'target_id', v_id, 'display_name', v_name);
  end if;

  select g.id, coalesce(nullif(trim(g.name), ''), '客服')
  into v_id, v_name
  from public.merchant_agents g
  where g.merchant_id = p_merchant_id and g.user_id = v_uid and g.status = 'active'
  limit 1;
  if v_id is not null then
    return jsonb_build_object('target_type', 'agent', 'target_id', v_id, 'display_name', v_name);
  end if;

  select s.id, coalesce(nullif(trim(s.name), ''), '服務人員')
  into v_id, v_name
  from public.merchant_staff s
  where s.merchant_id = p_merchant_id and s.user_id = v_uid
    and s.status = 'active' and s.login_status = 'active'
  limit 1;
  if v_id is not null then
    return jsonb_build_object('target_type', 'staff', 'target_id', v_id, 'display_name', v_name);
  end if;

  raise exception '你不是這間商家的管理員/客服/服務人員' using errcode = '42501';
end;
$$;

comment on function public.get_my_push_identity(uuid) is '§6.1 第 5 步:回傳呼叫者在這間商家的 {target_type, target_id, display_name},依 admin > agent > staff 優先權(跟 useMerchantRole 一致)。不收任何身分參數,一律從 auth.uid() 反查(§4.1)。不屬於這間商家 → 42501。';

revoke execute on function public.get_my_push_identity(uuid) from public, anon;
grant execute on function public.get_my_push_identity(uuid) to authenticated;

-- =========================================================================
-- §6.6 count_my_recent_test_pushes:測試推播的頻率限制
-- 回傳「這個人在這間商家最近 60 秒內 event_type='test' 的記錄筆數」。
-- push-send-test 在發送前呼叫它,>= 3 筆就回 429。
-- =========================================================================
create or replace function public.count_my_recent_test_pushes(p_merchant_id uuid)
returns int
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_identity jsonb;
  v_count int;
begin
  -- 身分一律自己解析(§4.1)。不屬於這間商家時 get_my_push_identity 會丟 42501。
  v_identity := public.get_my_push_identity(p_merchant_id);

  select count(*)::int into v_count
  from public.push_notification_log
  where merchant_id = p_merchant_id
    and event_type = 'test'
    and target_type = v_identity ->> 'target_type'
    and target_id = (v_identity ->> 'target_id')::uuid
    and attempted_at > now() - interval '60 seconds';

  return v_count;
end;
$$;

comment on function public.count_my_recent_test_pushes(uuid) is '§6.6:測試推播頻率限制的計數來源。3 次的理由:一次自動(開啟時)+ 兩次手動重試,足夠正常排查;再多就是濫用或誤觸。';

revoke execute on function public.count_my_recent_test_pushes(uuid) from public, anon;
grant execute on function public.count_my_recent_test_pushes(uuid) to authenticated;
