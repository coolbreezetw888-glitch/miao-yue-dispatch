-- 建單與訂單管理介面優化 §十 10.2-10.4(SPECS-INDEX #620):seed 函式、寫入函式、
-- 疊加 create_group_and_merchant/create_merchant_in_group、既有商家回歸補值。
--
-- ⚠️ 動工前查證(重申模組 7/8/9/10/11/15 已記錄的教訓):create_group_and_merchant/
-- create_merchant_in_group 目前「最新」的一份 migration 是 20260922100100_push_notifications_
-- functions.sql(疊加 seed_default_push_event_settings 那一支,timestamp 在本次之前排最後,
-- 之後沒有任何 migration 再動過這兩支函式),下面用 create or replace 在原有基礎上只新增一行
-- perform seed_default_booking_status_colors 呼叫,逐字保留其餘既有的 perform 呼叫順序,不重建。

-- =========================================================================
-- 10.2-1 seed_default_booking_status_colors:新商家建立當下自動種入預設顏色設定。
-- 直接 insert 用資料表本身的 DEFAULT 值(即上一支 migration 量測後的真實色碼),
-- on conflict do nothing 保持冪等,可安全重複呼叫。
-- =========================================================================
create or replace function public.seed_default_booking_status_colors(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_booking_status_colors (merchant_id)
  values (p_merchant_id)
  on conflict (merchant_id) do nothing;
end;
$$;

comment on function public.seed_default_booking_status_colors(uuid) is '10.2:新商家建立時種入 4 個狀態的預設顏色(資料表 DEFAULT 值,即量測後的真實色碼)。冪等,重複呼叫不會產生第二批,也不會覆蓋商家已經自訂過的顏色。';

revoke execute on function public.seed_default_booking_status_colors(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_booking_status_colors(uuid) to service_role, postgres;

-- =========================================================================
-- 10.2-2 疊加 create_group_and_merchant(2026-09-22 查證 20260922100100 版本為目前最新,
-- 只新增最後一行呼叫)。
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
  perform public.seed_default_booking_status_colors(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 10.2-3 疊加 create_merchant_in_group(同上,查證後只新增最後一行呼叫)。
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
  perform public.seed_default_booking_status_colors(v_merchant_id);

  return v_merchant_id;
end;
$function$;

-- =========================================================================
-- 10.4 update_merchant_booking_status_colors:唯一寫入路徑(除了上面的 seed 函式)。
-- =========================================================================
create or replace function public.update_merchant_booking_status_colors(
  p_merchant_id uuid,
  p_pending_confirmation_color text,
  p_accepted_color text,
  p_completed_color text,
  p_cancelled_color text
)
returns public.merchant_booking_status_colors
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result public.merchant_booking_status_colors;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限修改這間商家的訂單狀態顏色設定' using errcode = '42501';
  end if;

  if p_pending_confirmation_color is null or btrim(p_pending_confirmation_color) = '' then
    raise exception '請設定「待確認」狀態的顏色';
  end if;
  if p_accepted_color is null or btrim(p_accepted_color) = '' then
    raise exception '請設定「已確認」狀態的顏色';
  end if;
  if p_completed_color is null or btrim(p_completed_color) = '' then
    raise exception '請設定「已完成」狀態的顏色';
  end if;
  if p_cancelled_color is null or btrim(p_cancelled_color) = '' then
    raise exception '請設定「已取消」狀態的顏色';
  end if;

  insert into public.merchant_booking_status_colors (
    merchant_id, pending_confirmation_color, accepted_color, completed_color, cancelled_color
  ) values (
    p_merchant_id,
    btrim(p_pending_confirmation_color),
    btrim(p_accepted_color),
    btrim(p_completed_color),
    btrim(p_cancelled_color)
  )
  on conflict (merchant_id) do update set
    pending_confirmation_color = excluded.pending_confirmation_color,
    accepted_color = excluded.accepted_color,
    completed_color = excluded.completed_color,
    cancelled_color = excluded.cancelled_color,
    updated_at = now()
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_merchant_booking_status_colors(uuid, text, text, text, text) is '10.4:upsert 一筆 merchant_booking_status_colors。權限比照 §10.3:private.is_merchant_admin 或被授權 orders section_key 的客服(即 private.can_manage_bookings)。這次不做嚴格的 hex 格式 CHECK 約束(§10.1),只擋掉空字串/null,允許商家輸入任意合法 CSS color 字串(rgb()/顏色名稱等)。';

revoke execute on function public.update_merchant_booking_status_colors(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_merchant_booking_status_colors(uuid, text, text, text, text) to authenticated;

-- =========================================================================
-- 回歸補值:既有商家(在本批次上線之前就已建立)沒有 merchant_booking_status_colors,
-- 這裡一次性補齊(比照模組 11/15 既有的 backfill 做法)。
-- =========================================================================
do $$
declare
  v_merchant record;
begin
  for v_merchant in select id from public.merchants loop
    perform public.seed_default_booking_status_colors(v_merchant.id);
  end loop;
end;
$$;
