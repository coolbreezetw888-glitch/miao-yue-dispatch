-- 模組 11:LINE 通知 — 3.4~3.8 LINE 個人帳號綁定碼函式 + 3.19 解除綁定
--
-- ⚠️ 實作偏離規格書之處(對應 20260920160000 schema 檔開頭的說明):
--   1.4/2.7 描述的「唯一索引在有效範圍內生效」用一支共用私有函式
--   private.issue_line_binding_code 的「查詢+重試」邏輯達成,不依賴宣告式的 partial unique index
--   (PostgreSQL 不允許 index predicate 用 now() 這種 STABLE 函式)。

-- =========================================================================
-- 共用私有邏輯:規則 2.7(先讓同目標舊碼失效)+ 產生一組「目前有效範圍內不重複」的 6 碼數字。
-- 只給本檔案底下的 3.4~3.7 呼叫,不對外暴露。
-- =========================================================================
create or replace function private.issue_line_binding_code(
  p_merchant_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_created_by_user_id uuid
)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_expires_at timestamptz := now() + interval '10 minutes';
  v_attempts int := 0;
begin
  -- 規則 2.7:先讓同一個目標「尚未使用且尚未過期」的舊碼立刻失效。
  -- 注意:這支函式的 OUT 參數叫 expires_at,跟資料表欄位同名,plpgsql 預設會讓 OUT 參數
  -- 蓋過裸露的欄位名稱解析,所以這裡一律用 line_binding_codes.expires_at 明確指定資料表欄位,
  -- 避免「set expires_at = now() where ... expires_at > now()」全部被解析成 OUT 參數導致
  -- ambiguous / 邏輯錯誤。
  update public.line_binding_codes
  set expires_at = now()
  where merchant_id = p_merchant_id
    and target_type = p_target_type
    and target_id = p_target_id
    and used_at is null
    and line_binding_codes.expires_at > now();

  loop
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    v_attempts := v_attempts + 1;
    exit when not exists (
      select 1 from public.line_binding_codes lbc
      where lbc.code = v_code and lbc.used_at is null and lbc.expires_at > now()
    );
    if v_attempts > 20 then
      raise exception '暫時無法產生新的綁定碼,請稍後再試';
    end if;
  end loop;

  insert into public.line_binding_codes (
    merchant_id, target_type, target_id, code, expires_at, created_by_user_id
  ) values (
    p_merchant_id, p_target_type, p_target_id, v_code, v_expires_at, p_created_by_user_id
  );

  return query select v_code, v_expires_at;
end;
$$;

comment on function private.issue_line_binding_code(uuid, text, uuid, uuid) is '規則 2.7 共用邏輯:先讓同目標舊碼失效,再產生一組目前有效範圍內不重複的 6 碼數字。只給 3.4~3.7 呼叫。';

-- =========================================================================
-- 3.4 generate_own_admin_line_binding_code(自助,商家管理員)
-- =========================================================================
create or replace function public.generate_own_admin_line_binding_code(p_merchant_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin_id uuid;
begin
  select id into v_admin_id
  from public.merchant_admins
  where merchant_id = p_merchant_id and user_id = auth.uid();

  if v_admin_id is null then
    raise exception '你不是這間商家的管理員' using errcode = '42501';
  end if;

  return query select * from private.issue_line_binding_code(p_merchant_id, 'admin', v_admin_id, auth.uid());
end;
$$;

comment on function public.generate_own_admin_line_binding_code(uuid) is '判斷 5/3.4:商家管理員幫自己產生 LINE 綁定碼,自助不需要額外權限檢查。';

revoke execute on function public.generate_own_admin_line_binding_code(uuid) from public, anon;
grant execute on function public.generate_own_admin_line_binding_code(uuid) to authenticated;

-- =========================================================================
-- 3.5 generate_own_agent_line_binding_code(自助,在職客服)
-- =========================================================================
create or replace function public.generate_own_agent_line_binding_code(p_merchant_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_agent_id uuid;
begin
  select id into v_agent_id
  from public.merchant_agents
  where merchant_id = p_merchant_id and user_id = auth.uid() and status = 'active';

  if v_agent_id is null then
    raise exception '你不是這間商家目前在職的客服' using errcode = '42501';
  end if;

  return query select * from private.issue_line_binding_code(p_merchant_id, 'agent', v_agent_id, auth.uid());
end;
$$;

comment on function public.generate_own_agent_line_binding_code(uuid) is '判斷 5/3.5:在職客服幫自己產生 LINE 綁定碼,自助不需要額外權限檢查——已移除的客服(status<>active)被擋下。';

revoke execute on function public.generate_own_agent_line_binding_code(uuid) from public, anon;
grant execute on function public.generate_own_agent_line_binding_code(uuid) to authenticated;

-- =========================================================================
-- 3.6 generate_staff_line_binding_code(僅商家管理員,對應一之二節第 1 點)
-- =========================================================================
create or replace function public.generate_staff_line_binding_code(p_staff_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;

  if v_merchant_id is null then
    raise exception '找不到這位服務人員';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '只有商家管理員可以幫服務人員產生 LINE 綁定碼' using errcode = '42501';
  end if;

  return query select * from private.issue_line_binding_code(v_merchant_id, 'staff', p_staff_id, auth.uid());
end;
$$;

comment on function public.generate_staff_line_binding_code(uuid) is '判斷 5/一之二節第 1 點/3.6:幫服務人員產生 LINE 綁定碼,沿用模組 3 既有「服務人員異動只有商家管理員能做」的權限邊界,即使客服有 line_notification 權限也被擋下。';

revoke execute on function public.generate_staff_line_binding_code(uuid) from public, anon;
grant execute on function public.generate_staff_line_binding_code(uuid) to authenticated;

-- =========================================================================
-- 3.7 generate_member_line_binding_code(members 權限即可,對應判斷 3/5)
-- =========================================================================
create or replace function public.generate_member_line_binding_code(p_member_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;

  if v_merchant_id is null then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這位會員' using errcode = '42501';
  end if;

  return query select * from private.issue_line_binding_code(v_merchant_id, 'member', p_member_id, auth.uid());
end;
$$;

comment on function public.generate_member_line_binding_code(uuid) is '判斷 3/5/3.7:幫會員產生 LINE 綁定碼,歸在既有 members section_key 底下,不是本模組新增的權限項目。';

revoke execute on function public.generate_member_line_binding_code(uuid) from public, anon;
grant execute on function public.generate_member_line_binding_code(uuid) to authenticated;

-- =========================================================================
-- 3.8 consume_line_binding_code(只給 Webhook / service role 使用)
-- ⚠️ 實作偏離規格書之處:規格書原文寫在 private schema,但 PostgREST 的 API 只暴露
-- config.toml 設定的 schemas([public, graphql_public]),private schema 完全不會出現在
-- PostgREST 路由裡——不管有沒有 grant 給 service_role,Edge Function 用 supabase-js
-- 的 .rpc() 呼叫都打不到 private.* 函式。這個專案既有的「只給 service role 用」函式
-- (例如 record_invited_merchant_agent)全部是放在 public schema、靠 revoke/grant 限制
-- 執行權限,不是放在 private schema——這裡比照同一套既有慣例,改放在 public schema。
-- =========================================================================
create or replace function public.consume_line_binding_code(
  p_code text,
  p_merchant_id uuid,
  p_line_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding public.line_binding_codes;
  v_target_name text;
begin
  select * into v_binding
  from public.line_binding_codes
  where merchant_id = p_merchant_id
    and code = p_code
    and used_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if v_binding.id is null then
    return jsonb_build_object('success', false, 'reason', 'invalid_or_expired');
  end if;

  if v_binding.target_type = 'admin' then
    update public.merchant_admins
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning coalesce(display_name, '商家管理員') into v_target_name;
  elsif v_binding.target_type = 'agent' then
    update public.merchant_agents
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning name into v_target_name;
  elsif v_binding.target_type = 'staff' then
    update public.merchant_staff
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning name into v_target_name;
  elsif v_binding.target_type = 'member' then
    update public.members
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning name into v_target_name;
  end if;

  update public.line_binding_codes
  set used_at = now(), used_by_line_user_id = p_line_user_id
  where id = v_binding.id;

  return jsonb_build_object(
    'success', true,
    'target_type', v_binding.target_type,
    'target_id', v_binding.target_id,
    'target_name', v_target_name
  );
end;
$$;

comment on function public.consume_line_binding_code(text, uuid, text) is '規則 2.8/3.8:比對綁定碼成功後直接覆蓋 line_user_id/line_bound(換帳號直接取代,不需先解除)。只給 line-webhook Edge Function 用 service role 呼叫。';

revoke execute on function public.consume_line_binding_code(text, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_line_binding_code(text, uuid, text) to service_role;

-- =========================================================================
-- 3.19 unbind_line_account(規則 2.8 的反向操作)
-- =========================================================================
create or replace function public.unbind_line_account(p_target_type text, p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_self_user_id uuid;
begin
  if p_target_type not in ('admin', 'agent', 'staff', 'member') then
    raise exception '不支援的綁定目標類型: %', p_target_type;
  end if;

  if p_target_type = 'admin' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_admins where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位管理員';
    end if;
    if not (private.is_merchant_admin(v_merchant_id) or v_self_user_id = auth.uid()) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_admins set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'agent' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_agents where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位客服';
    end if;
    if not (private.is_merchant_admin(v_merchant_id) or v_self_user_id = auth.uid()) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_agents set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'staff' then
    select merchant_id into v_merchant_id from public.merchant_staff where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位服務人員';
    end if;
    -- 判斷 5:服務人員的異動只有商家管理員能做,本人沒有登入帳號,不適用「本人」例外。
    if not private.is_merchant_admin(v_merchant_id) then
      raise exception '只有商家管理員可以解除服務人員的 LINE 綁定' using errcode = '42501';
    end if;
    -- 已經完成 is_merchant_admin 檢查,這是規則 2.9 觸發器明確允許的合法例外路徑
    -- (見 20260920160000 schema 檔對這個觸發器的註解)。旗標是 transaction-local
    -- (set_config 第三參數 true),這個函式呼叫所在的交易結束就自動失效,不會外溢影響
    -- 同一個資料庫連線之後的其他語句。
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
    update public.members set line_user_id = null, line_bound = false where id = p_target_id;
  end if;
end;
$$;

comment on function public.unbind_line_account(text, uuid) is '規則 2.8 反向操作/3.19:解除 LINE 綁定。admin/agent 允許管理員或本人;staff 只允許管理員(對應判斷 5,實際欄位異動透過 line_notifications.bypass_staff_binding_guard 這個 transaction-local 旗標合法放行規則 2.9 觸發器);member 檢查 can_manage_members。';

revoke execute on function public.unbind_line_account(text, uuid) from public, anon;
grant execute on function public.unbind_line_account(text, uuid) to authenticated;
