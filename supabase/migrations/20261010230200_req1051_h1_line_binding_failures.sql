-- SPECS-INDEX #1051 全面體檢修正(H1-20):LINE 綁定碼輸入錯誤次數限制。
--
-- 同一個 LINE userId × 同一間店:1 小時內輸入錯誤 5 次 ⇒ 第 5 次之後 1 小時內不受理任何綁定碼
-- (含正確的碼),回傳與「代碼無效或已過期」相同的結果,Edge 照舊回同一句話。
-- 計數存在新表 public.line_binding_failures:RLS 開、0 條 policy,anon/authenticated 沒有任何權限,
-- 只由 service_role 專用的 consume_line_binding_code(SECURITY DEFINER)讀寫。
-- consume_line_binding_code 以正式庫現行本體為底,只加計數相關段落;簽章與 ACL 不變。

create table public.line_binding_failures (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  line_user_id text not null,
  attempted_at timestamptz not null default now()
);

comment on table public.line_binding_failures is
  'LINE 綁定碼輸入錯誤紀錄(#1051):同一 LINE 帳號 × 同一店 1 小時內錯 5 次就暫停受理 1 小時。只由 consume_line_binding_code 讀寫,保留 2 小時。';

create index line_binding_failures_lookup_idx
  on public.line_binding_failures (merchant_id, line_user_id, attempted_at);

alter table public.line_binding_failures enable row level security;

revoke all on table public.line_binding_failures from public, anon, authenticated;
grant select, insert, delete on table public.line_binding_failures to service_role;

CREATE OR REPLACE FUNCTION public.consume_line_binding_code(p_code text, p_merchant_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_binding public.line_binding_codes;
  v_target_name text;
  v_line_user_key text := coalesce(p_line_user_id, '');
begin
  -- #1051(H1-20):同一個 LINE 帳號 × 同一間店,1 小時內輸入錯誤 5 次 ⇒ 第 5 次之後 1 小時內不受理
  -- (回覆與「代碼無效或已過期」相同,不透露是否被暫停)。同一組依序處理,避免同時送出時計數不準。
  perform pg_advisory_xact_lock(
    hashtextextended('line_binding_failures:' || coalesce(p_merchant_id::text, '') || ':' || v_line_user_key, 0)
  );

  delete from public.line_binding_failures
  where merchant_id = p_merchant_id
    and line_user_id = v_line_user_key
    and attempted_at < now() - interval '2 hours';

  if exists (
    select 1
    from public.line_binding_failures f
    where f.merchant_id = p_merchant_id
      and f.line_user_id = v_line_user_key
      and f.attempted_at > now() - interval '1 hour'
      and (
        select count(*)
        from public.line_binding_failures g
        where g.merchant_id = f.merchant_id
          and g.line_user_id = f.line_user_id
          and g.attempted_at > f.attempted_at - interval '1 hour'
          and g.attempted_at <= f.attempted_at
      ) >= 5
  ) then
    return jsonb_build_object('success', false, 'reason', 'invalid_or_expired');
  end if;

  select * into v_binding
  from public.line_binding_codes
  where merchant_id = p_merchant_id
    and code = p_code
    and used_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if v_binding.id is null then
    if p_merchant_id is not null then
      insert into public.line_binding_failures (merchant_id, line_user_id)
      values (p_merchant_id, v_line_user_key);
    end if;
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
    -- SPECS-INDEX #908/#910(2026-09-30):這裡是「已完成身分驗證」目前唯一的設上點。
    -- 為什麼這條路徑算得上「本人證明過自己」:綁定碼必須由客人**用他自己的 LINE 帳號**
    -- 傳給商家官方帳號,商家自己做不到 ⇒ 本質上就是本人的主動認領動作(使用者 2026-09-30
    -- 對 Q6 裁決 (A)「算」)。
    -- coalesce 的用意:第二次綁定(換手機、重綁)不該把「這一段驗證是從什麼時候開始的」改掉;
    -- identity_first_verified_at 更嚴格,一旦有值就永遠不再變(解除綁定也不清,見下面那支函式)。
    update public.members
    set line_user_id = p_line_user_id,
        line_bound = true,
        identity_verified_at = coalesce(identity_verified_at, now()),
        identity_verified_via = coalesce(identity_verified_via, 'line'),
        identity_first_verified_at = coalesce(identity_first_verified_at, now())
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
$function$
;

-- create or replace 不會改既有 ACL;這裡重申一次(只給 service_role)。
revoke execute on function public.consume_line_binding_code(text, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_line_binding_code(text, uuid, text) to service_role;
