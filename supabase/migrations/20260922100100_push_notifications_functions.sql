-- 模組 15:服務人員推播通知 — 3.20 對等的種子函式 + 疊加 create_group_and_merchant/
-- create_merchant_in_group(7.4)、update_push_event_setting(7.9)、
-- get_staff_push_subscription_count(7.5)。
--
-- ⚠️ 實作警語(重申模組 7/8/9/10/11 已記錄的教訓):修改 create_group_and_merchant/
-- create_merchant_in_group 前,已用 pg_get_functiondef 查詢正式環境目前的完整函式主體
-- (2026-09-22 查證,跟 20260920160300 migration 檔案內容一致,確認之後沒有其他 migration
-- 再疊加過),下面是在原有基礎上只新增一行 seed_default_push_event_settings 呼叫,
-- 沒有從舊版本重建、沒有遺漏既有的 perform 呼叫。

-- =========================================================================
-- 7.4-1 seed_default_push_event_settings
-- =========================================================================
create or replace function public.seed_default_push_event_settings(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_push_event_settings (
    merchant_id, event_type, message_title, message_body
  ) values
    (p_merchant_id, 'booking_created', '新訂單通知', '{{booking_date}} {{customer_name}}‧{{service_names}}'),
    (p_merchant_id, 'booking_cancelled', '訂單已取消', '{{booking_date}} {{customer_name}} 的預約已取消'),
    (p_merchant_id, 'booking_updated', '訂單內容異動', '{{booking_date}} {{customer_name}}:{{change_summary}}'),
    (p_merchant_id, 'booking_reminder_next_day', '明天有預約提醒', '{{booking_date}} {{customer_name}}‧{{service_names}}')
  on conflict (merchant_id, event_type) do nothing;
end;
$$;

comment on function public.seed_default_push_event_settings(uuid) is '7.4:新商家建立時種入 4 種事件的預設標題/內文,enabled 一律預設 false(商家自己決定要不要開)。冪等,重複呼叫不會產生第二批。';

revoke execute on function public.seed_default_push_event_settings(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_push_event_settings(uuid) to service_role, postgres;

-- =========================================================================
-- 7.4-2 疊加 create_group_and_merchant(2026-09-22 查證正式環境現有主體,只新增最後一行呼叫)
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
  perform public.seed_default_push_event_settings(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 7.4-3 疊加 create_merchant_in_group(同上,查證後只新增最後一行呼叫)
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
  perform public.seed_default_push_event_settings(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 7.9 update_push_event_setting:方便前端一次呼叫更新一個事件的所有欄位。比照
-- update_line_event_setting 的既有寫法(security invoker,靠既有 RLS 政策把關)。
-- =========================================================================
create or replace function public.update_push_event_setting(
  p_merchant_id uuid,
  p_event_type text,
  p_enabled boolean,
  p_message_title text,
  p_message_body text
)
returns public.merchant_push_event_settings
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row public.merchant_push_event_settings;
begin
  update public.merchant_push_event_settings
  set
    enabled = p_enabled,
    message_title = coalesce(p_message_title, ''),
    message_body = coalesce(p_message_body, '')
  where merchant_id = p_merchant_id and event_type = p_event_type
  returning * into v_row;

  if v_row.id is null then
    raise exception '找不到這個商家的這個推播事件設定(可能尚未種入預設值)' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

comment on function public.update_push_event_setting(uuid, text, boolean, text, text) is '7.9:一次更新一個推播事件的開關/標題/內文。security invoker,真正的權限把關交給 merchant_push_event_settings_update 這個 RLS 政策。';

revoke execute on function public.update_push_event_setting(uuid, text, boolean, text, text) from public, anon;
grant execute on function public.update_push_event_setting(uuid, text, boolean, text, text) to authenticated;

-- =========================================================================
-- 7.5 get_staff_push_subscription_count(p_staff_id uuid)
-- 唯讀,SECURITY DEFINER,檢查 private.is_merchant_admin(透過該服務人員的 merchant_id),
-- 回傳這位服務人員目前有效的訂閱裝置數量(純整數,不含任何 endpoint/金鑰內容)。
-- =========================================================================
create or replace function public.get_staff_push_subscription_count(p_staff_id uuid)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_count int;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if v_merchant_id is null then
    raise exception '找不到這位服務人員' using errcode = 'P0002';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限查看這個商家的服務人員推播開通狀態' using errcode = '42501';
  end if;

  select count(*)::int into v_count
  from public.staff_push_subscriptions
  where staff_id = p_staff_id;

  return v_count;
end;
$$;

comment on function public.get_staff_push_subscription_count(uuid) is '7.5:供服務人員詳情頁疊加顯示「已開通推播裝置數」,只回傳數量,不回傳任何 endpoint/金鑰內容(2.1 邊界情況)。這次先歸類為一般管理員可看的唯讀資訊,不特別限制客服(這裡只是唯讀計數,不是可以繞過驗證的寫入路徑)。';

revoke execute on function public.get_staff_push_subscription_count(uuid) from public, anon;
grant execute on function public.get_staff_push_subscription_count(uuid) to authenticated;

-- =========================================================================
-- 回歸補值:既有商家(在本模組上線之前就已建立)沒有 merchant_push_event_settings,
-- 這裡一次性補齊(比照模組 11 20260920160500_backfill_missing_line_event_settings.sql 的既有做法)。
-- =========================================================================
do $$
declare
  v_merchant record;
begin
  for v_merchant in select id from public.merchants loop
    perform public.seed_default_push_event_settings(v_merchant.id);
  end loop;
end;
$$;
