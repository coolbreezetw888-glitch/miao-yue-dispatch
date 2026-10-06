-- SPECS-INDEX #987 第 10 批 子批 10-a:權限 / 平台 / 商家 / LINE 綁定類錯誤訊息的半形標點改全形
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md
--
-- 做法(規格 1-3):每支函式的底稿 = 本機套完 20261007120200 之後的 pg_get_functiondef(oid),
-- 除了訊息字串裡「中文旁的半形 , : ; ! ?」改成全形以外逐字保留(空白、換行、註解、屬性都不動)。
-- 半形括號 ( )、斜線 /、金額千分位、時間冒號、% 佔位符一律不動。
-- 「名稱: %」這種冒號後面的半形空白一起拿掉(全形冒號本身就有間距)。
-- 逐字保留的證明:supabase/tests/database/req987_01_fullwidth_messages_a.sql(新訊息換回舊訊息後 md5 = 下方改前指紋)。
--
-- 本支重建 29 支函式;改前指紋 md5(replace(prosrc, E'\r\n', E'\n')):
--   411decc625bfa8511c851a79f76dd323  private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid)
--   7a48f226e54c416c44bdf2717a14656f  private.protect_merchant_staff_line_binding_columns()
--   2ad0942a816ef46aee19435767057e82  private.protect_merchants_group_id_column()
--   1a46e154d9bd17a713273905040ab126  public.apply_industry_preset(p_merchant_id uuid)
--   d8ddf7e75ef0de730ebbfe2fe9f2caea  public.claim_birthday_line_pending(p_limit integer)
--   395131714e9868c8031969a198616f8b  public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)
--   059764bf68379fd6b8c3a6099fc70471  public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)
--   6ef4e51ee50dfc02b376b4101aeeffcb  public.generate_booking_slug(p_name text)
--   f6a721f8162636aac5da383b12b201d9  public.get_agent_login_email_status(p_agent_id uuid)
--   d1f31bcd22bc2d4aa3cd626363f29d0d  public.get_staff_login_email_status(p_staff_id uuid)
--   f318cfcce10dde03e5d203104fc39d90  public.invite_merchant_admin(p_merchant_id uuid, p_user_email text)
--   4f0329f160ee8845de62fd4801f7ea41  public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text)
--   bbcb63917cce8cae564c95046f150cd6  public.platform_purge_merchant_members_and_points(p_merchant_id uuid)
--   1d7b7a29fd87e416b8312686abb72be6  public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)
--   efd6992d544808187dff4579f0753d78  public.platform_set_group_admin(p_group_id uuid, p_user_email text)
--   ea47492b7b627c66004473974ceb83b5  public.prevent_disable_last_active_merchant()
--   650a039fd93bb7cb08683b181a71a503  public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)
--   61799fbc7c2c0296b113d58f3807d422  public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)
--   9c717723e9793d6a4a11647015d0ef3c  public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)
--   9b66ca4aea0df7d482a76a5aef99e175  public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid)
--   aaa2ba2f98909d5eb5ac3b86db3d8fb2  public.unbind_line_account(p_target_type text, p_target_id uuid)
--   10b3c7634d2ac44621e0a7aac2c81367  public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)
--   b1a13483a02bf55a48f3f3cc01f3738a  public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)
--   7275320c204cc55f21f3f9dcb842b197  public.hard_delete_merchant_agent(p_agent_id uuid)
--   b2739c768de7032844a18698b5f30f7a  public.hard_delete_merchant_staff(p_staff_id uuid)
--   b761e892f33f4b4db894f6240bd07ebb  public.remove_merchant_agent(p_agent_id uuid)
--   bd2e31052e121c84439d8e2c5fc1bf7f  public.restore_merchant_agent(p_agent_id uuid)
--   d2f9bf0be420d9e0e0f6a6e73bd84b05  public.request_agent_login_email_change(p_agent_id uuid, p_new_email text)
--   07a93b254c1b87034392039f7c74097e  public.request_staff_login_email_change(p_staff_id uuid, p_new_email text)

-- ===== private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid)
 RETURNS TABLE(code text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      raise exception '暫時無法產生新的綁定碼，請稍後再試';
    end if;
  end loop;

  insert into public.line_binding_codes (
    merchant_id, target_type, target_id, code, expires_at, created_by_user_id
  ) values (
    p_merchant_id, p_target_type, p_target_id, v_code, v_expires_at, p_created_by_user_id
  );

  return query select v_code, v_expires_at;
end;
$function$;

-- private.issue_line_binding_code(p_merchant_id uuid, p_target_type text, p_target_id uuid, p_created_by_user_id uuid):改前 proacl 為 NULL(預設權限);create or replace 不會動到 ACL,這裡刻意不下 grant / revoke(下了反而會把 NULL 變成明確清單)。

-- ===== private.protect_merchant_staff_line_binding_columns()(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION private.protect_merchant_staff_line_binding_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (new.line_user_id is distinct from old.line_user_id
      or new.line_bound is distinct from old.line_bound)
     and auth.role() <> 'service_role'
     -- unbind_line_account(3.19)的服務人員分支是唯一一個「以一般 authenticated 角色執行、
     -- 但已經在函式內部完成 is_merchant_admin 檢查」的合法例外路徑——它會在真的要清空這兩個
     -- 欄位前,用 set_config 短暫打開這個工作階段層級的旗標(transaction-local,語句結束或
     -- transaction 結束就自動失效),不是永久放行。
     and coalesce(current_setting('line_notifications.bypass_staff_binding_guard', true), 'off') <> 'on'
  then
    raise exception '不能透過一般編輯直接變更 LINE 綁定狀態，請透過 LINE 綁定/解除綁定流程操作'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

-- private.protect_merchant_staff_line_binding_columns():改前 proacl 為 NULL(預設權限);create or replace 不會動到 ACL,這裡刻意不下 grant / revoke(下了反而會把 NULL 變成明確清單)。

-- ===== private.protect_merchants_group_id_column()(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION private.protect_merchants_group_id_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.group_id is distinct from old.group_id
     -- 第一道繞道:後台維運 / 未來的 Edge Function 走 service_role。
     and auth.role() <> 'service_role'
     -- 第二道繞道:已經自行完成權限檢查的 SECURITY DEFINER 函式,可在寫入前用 set_config
     -- 短暫打開這個 transaction-local 旗標(目前沒有任何函式使用,先預留,寫法比照
     -- line_notifications.bypass_staff_binding_guard 的既有慣例)。
     and coalesce(current_setting('platform_admin.bypass_merchant_group_guard', true), 'off') <> 'on'
     -- 主要判斷:集團歸屬是平台層級的編制調整,只有超級管理員能做。
     and not private.is_platform_admin()
  then
    raise exception '商家的集團歸屬只能由平台管理員調整，商家管理員不能自行把店搬到其他集團'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

-- private.protect_merchants_group_id_column():改前 proacl 為 NULL(預設權限);create or replace 不會動到 ACL,這裡刻意不下 grant / revoke(下了反而會把 NULL 變成明確清單)。

-- ===== public.apply_industry_preset(p_merchant_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.apply_industry_preset(p_merchant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_industry_type text;
begin
  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if v_industry_type is null then
    raise exception '找不到指定的商家：%', p_merchant_id;
  end if;

  insert into public.merchant_feature_flags (merchant_id, feature_key, enabled)
  select p_merchant_id, ifp.feature_key, ifp.default_enabled
  from public.industry_feature_presets ifp
  where ifp.industry_type = v_industry_type
  on conflict (merchant_id, feature_key) do nothing;
end;
$function$;

revoke execute on function public.apply_industry_preset(p_merchant_id uuid) from anon, authenticated;
grant execute on function public.apply_industry_preset(p_merchant_id uuid) to PUBLIC, service_role;

-- ===== public.claim_birthday_line_pending(p_limit integer)(改 4 則訊息)=====
CREATE OR REPLACE FUNCTION public.claim_birthday_line_pending(p_limit integer DEFAULT 100)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_r record;
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
      c.channel_access_token,
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

    if not coalesce(v_r.line_bound, false) or coalesce(btrim(v_r.line_user_id), '') = '' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_not_bound', line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    if not coalesce(v_r.is_connected, false) or coalesce(btrim(v_r.channel_access_token), '') = '' then
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
      'channel_access_token', v_r.channel_access_token,
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

-- ===== public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.create_group_and_merchant(p_name text, p_industry_type text, p_address text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_intro text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型：%', p_industry_type;
  end if;

  insert into public.groups (group_admin_user_id)
  values (null)
  returning id into v_group_id;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    v_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);
  perform public.seed_default_leave_types(v_merchant_id);
  perform public.seed_default_payroll_settings(v_merchant_id);
  perform public.seed_default_leave_deduction_rules(v_merchant_id);
  perform public.seed_default_member_settings(v_merchant_id);
  perform public.seed_default_line_event_settings(v_merchant_id);
  perform public.seed_default_push_event_settings(v_merchant_id);
  perform public.seed_default_booking_status_colors(v_merchant_id);
  perform public.seed_default_merchant_calendar_state_styles(v_merchant_id);

  return v_merchant_id;
end;
$function$;

revoke execute on function public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) from PUBLIC, anon;
grant execute on function public.create_group_and_merchant(p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) to authenticated, service_role;

-- ===== public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text, p_intro text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_merchant_id uuid;
  v_slug text;
begin
  if v_uid is null then
    raise exception '需要登入才能建立商家' using errcode = '28000';
  end if;

  if not private.is_group_member(p_group_id) then
    raise exception '沒有權限在此集團下新增分店' using errcode = '42501';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception '店名不可為空';
  end if;

  if p_industry_type not in ('on_site_dispatch', 'in_store_beauty') then
    raise exception '不支援的產業類型：%', p_industry_type;
  end if;

  v_slug := public.generate_booking_slug(p_name);

  insert into public.merchants (
    group_id, name, industry_type, address, contact_email, intro, booking_slug
  ) values (
    p_group_id, p_name, p_industry_type, p_address, p_contact_email, p_intro, v_slug
  )
  returning id into v_merchant_id;

  insert into public.merchant_admins (merchant_id, user_id)
  values (v_merchant_id, v_uid);

  perform public.apply_industry_preset(v_merchant_id);
  perform public.seed_default_payment_methods(v_merchant_id);
  perform public.seed_default_leave_types(v_merchant_id);
  perform public.seed_default_payroll_settings(v_merchant_id);
  perform public.seed_default_leave_deduction_rules(v_merchant_id);
  perform public.seed_default_member_settings(v_merchant_id);
  perform public.seed_default_line_event_settings(v_merchant_id);
  perform public.seed_default_push_event_settings(v_merchant_id);
  perform public.seed_default_booking_status_colors(v_merchant_id);
  perform public.seed_default_merchant_calendar_state_styles(v_merchant_id);

  return v_merchant_id;
end;
$function$;

revoke execute on function public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) from PUBLIC, anon;
grant execute on function public.create_merchant_in_group(p_group_id uuid, p_name text, p_industry_type text, p_address text, p_contact_email text, p_intro text) to authenticated, service_role;

-- ===== public.generate_booking_slug(p_name text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.generate_booking_slug(p_name text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_base text;
  v_candidate text;
  v_suffix text;
  -- 系統既有路徑,見 src/App.tsx 的路由清單,新增路由時要回頭補這份清單
  v_reserved text[] := array['app', 'signin', 'signup', 'privacy', 'terms', 'api', 'admin'];
  v_attempts integer := 0;
begin
  v_base := lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9]+', '', 'g'));
  if v_base is null or length(v_base) = 0 then
    v_base := 'shop';
  end if;
  v_base := left(v_base, 20);

  loop
    v_attempts := v_attempts + 1;
    v_suffix := substr(md5(random()::text || clock_timestamp()::text), 1, 6);
    v_candidate := v_base || '-' || v_suffix;

    exit when v_candidate <> all (v_reserved)
      and not exists (select 1 from public.merchants where booking_slug = v_candidate);

    if v_attempts > 20 then
      raise exception '無法產生唯一的預約網址代碼，請稍後再試';
    end if;
  end loop;

  return v_candidate;
end;
$function$;

revoke execute on function public.generate_booking_slug(p_name text) from anon, authenticated;
grant execute on function public.generate_booking_slug(p_name text) to PUBLIC, service_role;

-- ===== public.get_agent_login_email_status(p_agent_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_agent_login_email_status(p_agent_id uuid)
 RETURNS TABLE(current_login_email text, pending_admin_suggested_email text, pending_confirmation_email text, pending_confirmation_sent_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
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
$function$;

revoke execute on function public.get_agent_login_email_status(p_agent_id uuid) from PUBLIC, anon;
grant execute on function public.get_agent_login_email_status(p_agent_id uuid) to authenticated, service_role;

-- ===== public.get_staff_login_email_status(p_staff_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_staff_login_email_status(p_staff_id uuid)
 RETURNS TABLE(current_login_email text, pending_admin_suggested_email text, pending_confirmation_email text, pending_confirmation_sent_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
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
$function$;

revoke execute on function public.get_staff_login_email_status(p_staff_id uuid) from PUBLIC, anon;
grant execute on function public.get_staff_login_email_status(p_staff_id uuid) to authenticated, service_role;

-- ===== public.invite_merchant_admin(p_merchant_id uuid, p_user_email text)(改 3 則訊息)=====
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
  where lower(email) = lower(trim(p_user_email));

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

revoke execute on function public.invite_merchant_admin(p_merchant_id uuid, p_user_email text) from PUBLIC, anon;
grant execute on function public.invite_merchant_admin(p_merchant_id uuid, p_user_email text) to authenticated, service_role;

-- ===== public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text)(改 1 則訊息)=====
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
  where lower(email) = lower(trim(p_user_email));

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

revoke execute on function public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text) from PUBLIC, anon;
grant execute on function public.platform_add_merchant_admin(p_merchant_id uuid, p_user_email text) to authenticated, service_role;

-- ===== public.platform_purge_merchant_members_and_points(p_merchant_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.platform_purge_merchant_members_and_points(p_merchant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  delete from public.member_point_transactions where merchant_id = p_merchant_id;
  delete from public.members where merchant_id = p_merchant_id;
end;
$function$;

revoke execute on function public.platform_purge_merchant_members_and_points(p_merchant_id uuid) from PUBLIC, anon;
grant execute on function public.platform_purge_merchant_members_and_points(p_merchant_id uuid) to authenticated, service_role;

-- ===== public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_group_admin_user_id uuid;
  v_remaining_count integer;
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  select g.group_admin_user_id into v_group_admin_user_id
  from public.merchants m
  join public.groups g on g.id = m.group_id
  where m.id = p_merchant_id;

  if not found then
    raise exception '找不到指定的商家：%', p_merchant_id;
  end if;

  if v_group_admin_user_id is null then
    select count(*) into v_remaining_count
    from public.merchant_admins
    where merchant_id = p_merchant_id
      and user_id <> p_user_id;

    if v_remaining_count = 0 then
      raise exception '移除後這間店會沒有任何人能登入管理，請先新增其他管理員' using errcode = 'P0001';
    end if;
  end if;

  delete from public.merchant_admins
  where merchant_id = p_merchant_id and user_id = p_user_id;
end;
$function$;

revoke execute on function public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) from PUBLIC, anon;
grant execute on function public.platform_remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) to authenticated, service_role;

-- ===== public.platform_set_group_admin(p_group_id uuid, p_user_email text)(改 1 則訊息)=====
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
  where lower(email) = lower(trim(p_user_email));

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
  end if;

  update public.groups set group_admin_user_id = v_user_id where id = p_group_id;
end;
$function$;

revoke execute on function public.platform_set_group_admin(p_group_id uuid, p_user_email text) from PUBLIC, anon;
grant execute on function public.platform_set_group_admin(p_group_id uuid, p_user_email text) to authenticated, service_role;

-- ===== public.prevent_disable_last_active_merchant()(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.prevent_disable_last_active_merchant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_remaining_active integer;
begin
  if new.status = 'disabled' and old.status = 'active' then
    select count(*) into v_remaining_active
    from public.merchants
    where group_id = old.group_id
      and status = 'active'
      and id <> old.id;

    if v_remaining_active = 0 then
      raise exception '集團底下至少要保留一間啟用中商家，無法停用最後一間' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;

revoke execute on function public.prevent_disable_last_active_merchant() from anon, authenticated;
grant execute on function public.prevent_disable_last_active_merchant() to PUBLIC, service_role;

-- ===== public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)(改 3 則訊息)=====
CREATE OR REPLACE FUNCTION public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_group_admin_user_id uuid;
  v_remaining_count integer;
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  select g.group_admin_user_id into v_group_admin_user_id
  from public.merchants m
  join public.groups g on g.id = m.group_id
  where m.id = p_merchant_id;

  if not found then
    raise exception '找不到指定的商家：%', p_merchant_id;
  end if;

  if v_group_admin_user_id is null then
    select count(*) into v_remaining_count
    from public.merchant_admins
    where merchant_id = p_merchant_id
      and user_id <> p_user_id;

    if v_remaining_count = 0 then
      raise exception '移除後這間店會沒有任何人能登入管理，請先新增其他管理員' using errcode = 'P0001';
    end if;
  end if;

  delete from public.merchant_admins
  where merchant_id = p_merchant_id and user_id = p_user_id;
end;
$function$;

revoke execute on function public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) from PUBLIC, anon;
grant execute on function public.remove_merchant_admin(p_merchant_id uuid, p_user_id uuid) to authenticated, service_role;

-- ===== public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
  v_merchant_name text;
  v_service_names text;
  v_staff_name text;
  v_points_earned int;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null or v_booking.merchant_id is distinct from p_merchant_id then
    raise exception '找不到這筆預約，或它不屬於這個商家' using errcode = 'P0002';
  end if;

  select name into v_merchant_name from public.merchants where id = v_booking.merchant_id;

  select string_agg(si.name, '、' order by bsi.created_at)
  into v_service_names
  from public.booking_service_items bsi
  join public.service_items si on si.id = bsi.service_item_id
  where bsi.booking_id = p_booking_id;

  select name into v_staff_name from public.merchant_staff
  where id = v_booking.staff_id and merchant_id = v_booking.merchant_id;

  select sum(points_delta)::int into v_points_earned
  from public.member_point_transactions
  where booking_id = p_booking_id
    and member_id = v_booking.member_id
    and transaction_type in ('earn_booking', 'earn_booking_reversal');

  if v_points_earned is not null and v_points_earned <= 0 then
    v_points_earned := null;
  end if;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'customer_name', coalesce(v_booking.customer_name, ''),
    'booking_date', to_char(v_booking.start_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI'),
    'service_names', coalesce(v_service_names, ''),
    'final_amount', coalesce(trim(to_char(v_booking.final_amount_snapshot, 'FM999999990')), ''),
    'staff_name', coalesce(v_staff_name, ''),
    'member_name', coalesce(v_booking.member_name_snapshot, ''),
    'cancel_reason', coalesce(v_booking.cancelled_reason, ''),
    'points_earned', coalesce(v_points_earned::text, '')
  );
end;
$function$;

revoke execute on function public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid) from PUBLIC, anon, authenticated;
grant execute on function public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid) to service_role;

-- ===== public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_record public.staff_leave_records;
  v_staff_name text;
  v_merchant_name text;
  v_booking_date text;
begin
  select * into v_record from public.staff_leave_records where id = p_staff_leave_record_id;
  if v_record.id is null then
    return '{}'::jsonb;
  end if;

  select ms.name, m.name
  into v_staff_name, v_merchant_name
  from public.merchant_staff ms
  join public.merchants m on m.id = ms.merchant_id
  where ms.id = v_record.staff_id and ms.merchant_id = p_merchant_id;

  if not found then
    raise exception '找不到這筆請假紀錄，或它不屬於這個商家' using errcode = 'P0002';
  end if;

  if v_record.start_date = v_record.end_date then
    v_booking_date := to_char(v_record.start_date, 'YYYY-MM-DD');
  else
    v_booking_date := to_char(v_record.start_date, 'YYYY-MM-DD') || ' 至 ' || to_char(v_record.end_date, 'YYYY-MM-DD');
  end if;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'staff_name', coalesce(v_staff_name, ''),
    'booking_date', coalesce(v_booking_date, ''),
    'leave_type_name', coalesce(v_record.leave_type_name_snapshot, '')
  );
end;
$function$;

revoke execute on function public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid) from PUBLIC, anon, authenticated;
grant execute on function public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid) to service_role;

-- ===== public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid DEFAULT NULL::uuid, p_staff_leave_record_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_connected boolean;
  v_settings public.merchant_line_event_settings;
  v_booking public.bookings;
  v_targets jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_member_bound boolean;
  v_member_name text;
begin
  if p_booking_id is not null and not exists (
    select 1 from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆預約，或它不屬於這個商家' using errcode = 'P0002';
  end if;

  if p_staff_leave_record_id is not null and not exists (
    select 1 from public.staff_leave_records r
    join public.merchant_staff ms on ms.id = r.staff_id
    where r.id = p_staff_leave_record_id and ms.merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆請假紀錄，或它不屬於這個商家' using errcode = 'P0002';
  end if;

  select is_connected into v_is_connected
  from public.merchant_line_configs where merchant_id = p_merchant_id;

  if coalesce(v_is_connected, false) = false then
    return jsonb_build_object(
      'connected', false, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb
    );
  end if;

  select * into v_settings
  from public.merchant_line_event_settings
  where merchant_id = p_merchant_id and event_type = p_event_type;

  if v_settings.id is null or not v_settings.enabled then
    return jsonb_build_object(
      'connected', true, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb
    );
  end if;

  if p_booking_id is not null then
    select * into v_booking from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id;
  end if;

  if v_settings.notify_staff and v_booking.id is not null then
    if v_booking.staff_id is not null
       and not exists (
         select 1 from public.merchant_staff
         where id = v_booking.staff_id and merchant_id = p_merchant_id and status = 'active'
       ) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_inactive')
      );
    elsif v_booking.staff_id is not null
       and not private.staff_calendar_view_allows_notifications(v_booking.staff_id) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_calendar_view_off')
      );
    elsif exists (
      select 1 from public.merchant_staff
      where id = v_booking.staff_id and merchant_id = p_merchant_id and line_bound = true
    ) then
      v_targets := v_targets || jsonb_build_array(jsonb_build_object(
        'type', 'staff', 'id', v_booking.staff_id,
        'name', (select name from public.merchant_staff where id = v_booking.staff_id and merchant_id = p_merchant_id),
        'line_user_id', (select line_user_id from public.merchant_staff where id = v_booking.staff_id and merchant_id = p_merchant_id)
      ));
    else
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'target_not_bound')
      );
    end if;
  end if;

  if v_settings.notify_member and v_booking.id is not null then
    if v_booking.member_id is null then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'member', 'id', null, 'reason', 'no_target')
      );
    else
      select name, line_bound into v_member_name, v_member_bound
      from public.members where id = v_booking.member_id and merchant_id = p_merchant_id;

      if coalesce(v_member_bound, false) then
        v_targets := v_targets || jsonb_build_array(jsonb_build_object(
          'type', 'member', 'id', v_booking.member_id, 'name', v_member_name,
          'line_user_id', (select line_user_id from public.members where id = v_booking.member_id and merchant_id = p_merchant_id)
        ));
      else
        v_skipped := v_skipped || jsonb_build_array(
          jsonb_build_object('type', 'member', 'id', v_booking.member_id, 'reason', 'target_not_bound')
        );
      end if;
    end if;
  end if;

  if v_settings.notify_admin then
    v_targets := v_targets || coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', 'admin', 'id', id, 'name', coalesce(display_name, '商家管理員'), 'line_user_id', line_user_id
      ))
      from public.merchant_admins where merchant_id = p_merchant_id and line_bound = true
    ), '[]'::jsonb);
    v_skipped := v_skipped || coalesce((
      select jsonb_agg(jsonb_build_object('type', 'admin', 'id', id, 'reason', 'target_not_bound'))
      from public.merchant_admins where merchant_id = p_merchant_id and line_bound = false
    ), '[]'::jsonb);
  end if;

  if v_settings.notify_agent then
    v_targets := v_targets || coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', 'agent', 'id', id, 'name', name, 'line_user_id', line_user_id
      ))
      from public.merchant_agents
      where merchant_id = p_merchant_id and status = 'active' and line_bound = true
    ), '[]'::jsonb);
    v_skipped := v_skipped || coalesce((
      select jsonb_agg(jsonb_build_object('type', 'agent', 'id', id, 'reason', 'target_not_bound'))
      from public.merchant_agents
      where merchant_id = p_merchant_id and status = 'active' and line_bound = false
    ), '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'connected', true,
    'event_enabled', true,
    'targets', v_targets,
    'skipped', v_skipped
  );
end;
$function$;

revoke execute on function public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid) from PUBLIC, anon, authenticated;
grant execute on function public.resolve_line_notification_targets(p_merchant_id uuid, p_event_type text, p_booking_id uuid, p_staff_leave_record_id uuid) to service_role;

-- ===== public.unbind_line_account(p_target_type text, p_target_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.unbind_line_account(p_target_type text, p_target_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_self_user_id uuid;
begin
  if p_target_type not in ('admin', 'agent', 'staff', 'member') then
    raise exception '不支援的綁定目標類型：%', p_target_type;
  end if;

  if p_target_type = 'admin' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_admins where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位管理員';
    end if;
    -- ⚠️ 三值邏輯防禦(三個分支寫法刻意完全一致,見 20260924040900 檔頭§「順帶修掉的既有漏洞」):
    --    裸寫 `or v_self_user_id = auth.uid()` 在兩邊都是 NULL 時,該比較的結果是 NULL,
    --    `not (false or NULL)` = NULL,而 `if NULL then` 不成立 → raise 不會觸發、權限檢查被靜默
    --    跳過。不要因為覺得囉唆而把這兩個 is not null 簡化掉。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_admins set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'agent' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_agents where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位客服';
    end if;
    -- ⚠️ 三值邏輯防禦 —— 這一條是真的在修一個既有漏洞:merchant_agents.user_id 是 nullable
    --    (login 尚未註冊的「已邀請」客服就是 NULL)。不要簡化掉這兩個 is not null。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_agents set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'staff' then
    -- 2026-09-24 放寬(使用者裁決「要讓服務人員自己綁定」):原本只允許 private.is_merchant_admin,
    -- 現在加上「本人」。「本人」一律用 auth.uid() 對照 merchant_staff.user_id 判斷,
    -- 完全不信任前端傳來的任何 id —— 前端只能指定「要解除哪一列」,而那一列必須是它自己。
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_staff where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位服務人員';
    end if;

    -- ⚠️ 三值邏輯防禦 —— merchant_staff.user_id 是 nullable(login_status = 'not_invited' 的人
    --    還沒有登入帳號)。不要簡化掉這兩個 is not null。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '只有商家管理員或這位服務人員本人可以解除這個 LINE 綁定' using errcode = '42501';
    end if;

    -- 已經完成權限檢查(管理員 or 本人),這是規則 2.9 觸發器
    -- private.protect_merchant_staff_line_binding_columns 明確允許的合法例外路徑。
    -- 旗標是 transaction-local(set_config 第三參數 true),交易結束就自動失效。
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
    -- SPECS-INDEX #910(2026-09-30,使用者裁決 Q2 = (B) 附帶限制):
    --   ・identity_verified_at / identity_verified_via **清成 null** ⇒ 綁定狀態歸零,
    --     名單上變回「尚未驗證」(2026-10-01 修正用詞,舊標籤是「已建立(未綁定)」;狀態名稱
    --     裡不可以有「綁定」二字,文案唯一來源是 memberIdentityStatus.ts),綁定之後才能觸發的
    --     功能(再行銷通知等)碰不到他。
    --   ・🔴 identity_first_verified_at **刻意不寫進這句 UPDATE** ⇒ 第一次完成驗證的時間永久保留。
    --     使用者原話:「如果真的解除綁定,會員資料、紀錄、加入時間也不該清除(僅是綁定狀態
    --     變回未綁定)」。不要「順手」把它一起清掉 —— 那會讓第二次解除綁定時這個時間永久弄丟。
    --   ・會員本人、訂單紀錄、點數餘額、分類帳全部不動,一筆都不刪。
    update public.members
    set line_user_id = null,
        line_bound = false,
        identity_verified_at = null,
        identity_verified_via = null
    where id = p_target_id;
  end if;
end;
$function$;

revoke execute on function public.unbind_line_account(p_target_type text, p_target_id uuid) from PUBLIC, anon;
grant execute on function public.unbind_line_account(p_target_type text, p_target_id uuid) to authenticated, service_role;

-- ===== public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄：%', p_agent_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  insert into public.merchant_agent_permissions (agent_id, section_key, granted)
  values (p_agent_id, p_section_key, p_granted)
  on conflict (agent_id, section_key)
  do update set granted = excluded.granted, updated_at = now();
end;
$function$;

revoke execute on function public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean) from PUBLIC, anon;
grant execute on function public.set_agent_permission(p_agent_id uuid, p_section_key text, p_granted boolean) to authenticated, service_role;

-- ===== public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到指定的服務人員紀錄：%', p_staff_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  insert into public.merchant_staff_permissions (staff_id, section_key, granted)
  values (p_staff_id, p_section_key, p_granted)
  on conflict (staff_id, section_key)
  do update set granted = excluded.granted, updated_at = now();
end;
$function$;

revoke execute on function public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean) from PUBLIC, anon;
grant execute on function public.set_staff_permission(p_staff_id uuid, p_section_key text, p_granted boolean) to authenticated, service_role;

-- ===== public.hard_delete_merchant_agent(p_agent_id uuid)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.hard_delete_merchant_agent(p_agent_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄' using errcode = 'P0001';
  end if;

  -- 只有該商家管理員能真正刪除(跟 remove_merchant_agent / restore_merchant_agent /
  -- hard_delete_merchant_staff 同一個授權層級)。客服本人也不行——這是不可復原的操作。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  -- 必須先軟移除(status = 'removed')才能真正刪除,不能從在職 / 邀請中直接跳到刪除。
  -- 這是刻意的兩段式防呆:畫面上「真正刪除」按鈕也只出現在已移除的那一列旁邊。
  if v_status <> 'removed' then
    raise exception '只能對已經移除的客服執行真正刪除，請先移除這位客服(軟刪除)，確認不再需要之後再進行真正刪除。'
      using errcode = 'P0001';
  end if;

  -- 全部通過才真的 DELETE——讓 merchant_agent_permissions.agent_id 的 on delete cascade
  -- 自動清掉這位客服的權限開關設定列(唯一一條指向 merchant_agents 的外鍵)。完全不動 auth.users。
  delete from public.merchant_agents where id = p_agent_id;
end;
$function$;

revoke execute on function public.hard_delete_merchant_agent(p_agent_id uuid) from PUBLIC, anon;
grant execute on function public.hard_delete_merchant_agent(p_agent_id uuid) to authenticated, service_role;

-- ===== public.hard_delete_merchant_staff(p_staff_id uuid)(改 4 則訊息)=====
CREATE OR REPLACE FUNCTION public.hard_delete_merchant_staff(p_staff_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_name text;
  v_booking_count int;
  v_assistant_count int;
  v_leave_count int;
  v_commission_count int;
  v_paid_salary_history_count int;
begin
  select merchant_id, status, name into v_merchant_id, v_status, v_name
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到指定的服務人員紀錄' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'removed' then
    raise exception '只能對已經移除的服務人員執行真正刪除，請先移除這位服務人員(軟刪除)，確認不再需要之後再進行真正刪除。' using errcode = 'P0001';
  end if;

  select count(*) into v_booking_count from public.bookings where staff_id = p_staff_id;
  select count(*) into v_assistant_count from public.booking_assistants where staff_id = p_staff_id;
  select count(*) into v_leave_count from public.staff_leave_records where staff_id = p_staff_id;
  select count(*) into v_commission_count from public.booking_commission_records where staff_id = p_staff_id;

  if (v_booking_count + v_assistant_count + v_leave_count + v_commission_count) > 0 then
    raise exception '這位服務人員「%」有歷史紀錄牽連(訂單 %筆、助手身份訂單 %筆、請假紀錄 %筆、抽成紀錄 %筆)，為了保留歷史帳務與訂單資料，無法真正刪除，只能維持「已移除」狀態。',
      v_name, v_booking_count, v_assistant_count, v_leave_count, v_commission_count
      using errcode = 'P0001';
  end if;

  -- 模組 8 §11.4(核心,第五項檢查):曾經領過非 0 月薪的人,即使四項既有檢查都是 0(從未接過
  -- 訂單/請過假),也不能真正刪除——staff_payroll_status_history 是 on delete cascade,真的刪除
  -- 會連帶砍掉過去月份帳務報表依賴的歷史金額紀錄。
  select count(*) into v_paid_salary_history_count
  from public.staff_payroll_status_history
  where staff_id = p_staff_id and monthly_base_salary > 0;

  if v_paid_salary_history_count > 0 then
    raise exception '這位服務人員過去有實際發生過的月薪紀錄(曾經是有薪資的月薪制員工)，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。'
      using errcode = 'P0001';
  end if;

  -- 全部通過(四項既有筆數 + 第五項薪資歷史檢查皆為 0)才真的執行 DELETE——讓既有的
  -- on delete cascade 外鍵自動清掉 merchant_staff_service_items/staff_availability_windows/
  -- staff_availability_overrides/merchant_staff_permissions/staff_service_commission_rates/
  -- staff_salary_settings/staff_payroll_status_history 七張純設定/歷史表的關聯資料,這裡不需要
  -- 手動一張一張 delete。完全不動 auth.users(merchant_staff.user_id 是
  -- references auth.users(id) on delete set null,方向是 auth.users 被刪才影響 merchant_staff,
  -- 不是反過來——硬刪除這一列本來就不會、也不應該去動 auth.users)。
  delete from public.merchant_staff where id = p_staff_id;
end;
$function$;

revoke execute on function public.hard_delete_merchant_staff(p_staff_id uuid) from PUBLIC, anon;
grant execute on function public.hard_delete_merchant_staff(p_staff_id uuid) to authenticated, service_role;

-- ===== public.remove_merchant_agent(p_agent_id uuid)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.remove_merchant_agent(p_agent_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
begin
  select merchant_id into v_merchant_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄：%', p_agent_id;
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  update public.merchant_agents
  set status = 'removed'
  where id = p_agent_id;
end;
$function$;

revoke execute on function public.remove_merchant_agent(p_agent_id uuid) from PUBLIC, anon;
grant execute on function public.remove_merchant_agent(p_agent_id uuid) to authenticated, service_role;

-- ===== public.restore_merchant_agent(p_agent_id uuid)(改 3 則訊息)=====
CREATE OR REPLACE FUNCTION public.restore_merchant_agent(p_agent_id uuid)
 RETURNS merchant_agents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_user_id uuid;
  v_activated_at timestamptz;
  v_invited_email text;
  v_new_status text;
  v_result public.merchant_agents;
begin
  select merchant_id, status, user_id, activated_at, invited_email
  into v_merchant_id, v_status, v_user_id, v_activated_at, v_invited_email
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄';
  end if;

  -- 只有商家管理員能恢復(比照既有 remove_merchant_agent 的授權,恢復跟移除必須是同一個層級的
  -- 權限,否則被移除的客服自己就能把自己恢復回來)。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'removed' then
    raise exception '只有已移除的客服才需要恢復，這位客服目前的狀態不是已移除';
  end if;

  -- 防呆(§(4) 那個極端情況):如果這個商家底下已經有另一筆「還沒被移除」的客服用同一個
  -- 邀請 email,恢復會在列表上出現兩筆同一個人。正常情況不可能發生——
  -- merchant_agents_merchant_user_unique (merchant_id, user_id) where user_id is not null
  -- 這個 partial unique index 不分狀態,同一個 (商家, 登入帳號) 全表只能有一列,而且既有的
  -- record_invited_merchant_agent 重新邀請時是復用舊列而不是插新列。只有在舊列的 auth 帳號被
  -- 刪除(on delete set null 把 user_id 清成 null)之後商家又用同一個 email 邀了新人,才可能
  -- 出現兩列。這種情況擋下來並說清楚該怎麼辦,不要留一個看不懂的重複資料給商家。
  if exists (
    select 1
    from public.merchant_agents ma
    where ma.merchant_id = v_merchant_id
      and ma.id <> p_agent_id
      and ma.status <> 'removed'
      and ma.invited_email = v_invited_email
  ) then
    raise exception '這個邀請 Email(%)目前已經有另一筆使用中的客服紀錄，無法恢復這一筆；如果要改用這一筆，請先移除另一筆',
      v_invited_email;
  end if;

  -- ---------------------------------------------------------------------
  -- 恢復成什麼狀態(⚠️ 這裡跟主腦契約「一律改回 active」有一處刻意調整,理由見檔頭)
  --   ・登入帳號還在、而且確實曾經啟用過(activated_at 有值)→ 'active'
  --     這是最常見的情境(在職過、被誤移除、要恢復),結果跟契約一致。
  --   ・其餘 → 'invited':代表「邀請信寄過但本人從沒設定密碼」,或「登入帳號已經被刪除」。
  --     恢復成 active 會讓畫面顯示「已啟用」但他其實一天都沒登入過,而且
  --     public.mark_agent_active_if_self() 的轉換條件是 status = 'invited',寫成 active 之後
  --     他將來真的去設定密碼登入時那支函式撈不到他,會永遠卡在錯誤狀態。
  --
  -- activated_at 刻意**不**重設:它記錄的是「這個帳號第一次啟用的時間」這個歷史事實,
  -- remove_merchant_agent 當初也沒有清掉它。恢復不該偽造一個新的啟用時間。
  -- invited_at 同理不動(恢復不是重新邀請;真要重新寄邀請信請走 record_invited_merchant_agent,
  -- 那支才會更新 invited_at)。
  -- ---------------------------------------------------------------------
  v_new_status := case
    when v_user_id is not null and v_activated_at is not null then 'active'
    else 'invited'
  end;

  update public.merchant_agents
  set status = v_new_status
  where id = p_agent_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.restore_merchant_agent(p_agent_id uuid) from PUBLIC, anon;
grant execute on function public.restore_merchant_agent(p_agent_id uuid) to authenticated, service_role;

-- ===== public.request_agent_login_email_change(p_agent_id uuid, p_new_email text)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.request_agent_login_email_change(p_agent_id uuid, p_new_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception '這位客服尚未開通登入，無法設定登入信箱建議' using errcode = 'P0001';
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
$function$;

revoke execute on function public.request_agent_login_email_change(p_agent_id uuid, p_new_email text) from PUBLIC, anon;
grant execute on function public.request_agent_login_email_change(p_agent_id uuid, p_new_email text) to authenticated, service_role;

-- ===== public.request_staff_login_email_change(p_staff_id uuid, p_new_email text)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.request_staff_login_email_change(p_staff_id uuid, p_new_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'active' or v_login_status <> 'active' then
    raise exception '這位服務人員尚未開通登入，無法設定登入信箱建議' using errcode = 'P0001';
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
$function$;

revoke execute on function public.request_staff_login_email_change(p_staff_id uuid, p_new_email text) from PUBLIC, anon;
grant execute on function public.request_staff_login_email_change(p_staff_id uuid, p_new_email text) to authenticated, service_role;

