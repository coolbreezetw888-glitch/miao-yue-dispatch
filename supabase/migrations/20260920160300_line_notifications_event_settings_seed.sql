-- 模組 11:LINE 通知 — 3.20 seed_default_line_event_settings + 疊加 create_group_and_merchant/
-- create_merchant_in_group。3.16 的讀寫本身直接靠 RLS(20260920160000 已建立 SELECT/UPDATE 政策),
-- 這裡只需要一支「批次更新單一事件」的小函式方便前端一次呼叫更新多個欄位(update_line_event_setting)。
--
-- ⚠️ 實作警語(重申模組 7/8/9/10 已記錄的教訓):修改 create_group_and_merchant/
-- create_merchant_in_group 前,已用 pg_get_functiondef 查詢正式環境目前的完整函式主體
-- (2026-09-20 查證),下面是在原有基礎上只新增一行 seed_default_line_event_settings 呼叫,
-- 沒有從舊版本重建、沒有遺漏既有的 perform 呼叫。

-- =========================================================================
-- 3.20-1 seed_default_line_event_settings
-- =========================================================================
create or replace function public.seed_default_line_event_settings(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_line_event_settings (
    merchant_id, event_type, notify_admin, notify_agent, notify_staff, notify_member, message_template
  ) values
    (p_merchant_id, 'booking_created', true, false, false, false,
     '【{{merchant_name}}】有新的預約:{{customer_name}} 於 {{booking_date}} 預約 {{service_names}},金額 {{final_amount}} 元。'),
    (p_merchant_id, 'booking_confirmed', false, false, true, true,
     '【{{merchant_name}}】您的預約已確認:{{booking_date}}、服務項目:{{service_names}}、服務人員:{{staff_name}}。'),
    (p_merchant_id, 'booking_cancelled', false, false, true, true,
     '【{{merchant_name}}】您的預約已取消:{{booking_date}}、服務項目:{{service_names}}。取消原因:{{cancel_reason}}。'),
    (p_merchant_id, 'booking_completed', false, false, false, true,
     '【{{merchant_name}}】感謝您的光臨!本次服務:{{service_names}},本次獲得 {{points_earned}} 點。'),
    (p_merchant_id, 'staff_leave_created', true, false, false, false,
     '【{{merchant_name}}】{{staff_name}} 登記了一筆請假:{{booking_date}}。')
  on conflict (merchant_id, event_type) do nothing;
end;
$$;

comment on function public.seed_default_line_event_settings(uuid) is '3.20:新商家建立時種入 5 種事件的預設通知對象與文案,enabled 一律預設 false(判斷 3.14 精神,商家自己決定要不要開)。冪等,重複呼叫不會產生第二批。';

revoke execute on function public.seed_default_line_event_settings(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_line_event_settings(uuid) to service_role, postgres;

-- =========================================================================
-- 3.20-2 疊加 create_group_and_merchant(2026-09-20 查證正式環境現有主體,只新增最後一行呼叫)
-- =========================================================================
create or replace function public.create_group_and_merchant(
  p_name text,
  p_industry_type text,
  p_address text default null::text,
  p_contact_email text default null::text,
  p_intro text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    raise exception '不支援的產業類型: %', p_industry_type;
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

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 3.20-3 疊加 create_merchant_in_group(同上,查證後只新增最後一行呼叫)
-- =========================================================================
create or replace function public.create_merchant_in_group(
  p_group_id uuid,
  p_name text,
  p_industry_type text,
  p_address text default null::text,
  p_contact_email text default null::text,
  p_intro text default null::text
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    raise exception '不支援的產業類型: %', p_industry_type;
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

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 3.16 update_line_event_setting:方便前端一次呼叫更新一個事件的所有欄位(比直接開放
-- PostgREST 逐欄位 PATCH 更貼近畫面「一次儲存整張卡片」的操作模式,底層仍然只是一般 UPDATE,
-- 靠既有的 merchant_line_event_settings_update RLS 政策把關,不做額外的權限判斷)。
-- =========================================================================
create or replace function public.update_line_event_setting(
  p_merchant_id uuid,
  p_event_type text,
  p_enabled boolean,
  p_notify_admin boolean,
  p_notify_agent boolean,
  p_notify_staff boolean,
  p_notify_member boolean,
  p_message_template text
)
returns public.merchant_line_event_settings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.merchant_line_event_settings;
begin
  update public.merchant_line_event_settings
  set
    enabled = p_enabled,
    notify_admin = p_notify_admin,
    notify_agent = p_notify_agent,
    notify_staff = p_notify_staff,
    notify_member = p_notify_member,
    message_template = coalesce(p_message_template, '')
  where merchant_id = p_merchant_id and event_type = p_event_type
  returning * into v_row;

  if v_row.id is null then
    raise exception '找不到這個商家的這個通知事件設定(可能尚未種入預設值)' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

comment on function public.update_line_event_setting(uuid, text, boolean, boolean, boolean, boolean, boolean, text) is '3.16:一次更新一個事件的開關/通知對象/文案範本。用 security invoker(不是 definer)——真正的權限把關交給 merchant_line_event_settings_update 這個 RLS 政策,呼叫者自己權限不夠時,底層 UPDATE 會被 RLS 靜默擋下 0 筆,這裡再轉成明確的錯誤訊息。';

revoke execute on function public.update_line_event_setting(uuid, text, boolean, boolean, boolean, boolean, boolean, text) from public, anon;
grant execute on function public.update_line_event_setting(uuid, text, boolean, boolean, boolean, boolean, boolean, text) to authenticated;
