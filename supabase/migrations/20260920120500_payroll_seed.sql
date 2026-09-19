-- 模組 8:薪資與帳務 — 種子函式 + create_group_and_merchant/create_merchant_in_group 疊加(第六支)。
-- 對應規格書 §3.12。
--
-- ⚠️ 以下兩支函式(create_group_and_merchant/create_merchant_in_group)的完整函式主體,是動工前
-- 用 mcp__claude_ai_Supabase__execute_sql 對正式專案 wjtbmmnakcriuaqoknsq 執行 pg_get_functiondef
-- 取得的(2026-09-20 查證),跟本機 20260919150100_scheduling_leave_functions.sql 裡的版本逐字
-- 相同(已比對確認,20260919150100 之後沒有任何 migration 再動過這兩支函式)。以下逐字保留原本
-- 函式主體,只在既有 seed_default_leave_types 呼叫之後,依序補上兩行新的 perform 呼叫。

-- =========================================================================
-- seed_default_payroll_settings(p_merchant_id uuid):寫入一筆 merchant_payroll_settings
-- (全部採用 §1.1 的預設值),on conflict (merchant_id) do nothing 保持冪等。
-- =========================================================================
create or replace function public.seed_default_payroll_settings(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_payroll_settings (merchant_id)
  values (p_merchant_id)
  on conflict (merchant_id) do nothing;
end;
$$;

comment on function public.seed_default_payroll_settings(uuid) is '模組 8 薪資與帳務:新商家建立當下種入一筆預設薪資設定(§1.1 的預設值:gross/0%/30 天),商家可以之後自己在抽成與薪資設定頁調整。on conflict (merchant_id) do nothing 保持冪等,只在 create_group_and_merchant/create_merchant_in_group 建立商家當下呼叫。';

-- =========================================================================
-- seed_default_leave_deduction_rules(p_merchant_id uuid):為該商家目前所有 merchant_leave_types
-- 各建立一筆 leave_type_deduction_rules(deduction_mode=no_deduction,對應第〇節開頭原則)。
-- 必須在 seed_default_leave_types(模組 7)之後呼叫,才會有假別可以迭代。
-- =========================================================================
create or replace function public.seed_default_leave_deduction_rules(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.leave_type_deduction_rules (merchant_id, leave_type_id, deduction_mode)
  select p_merchant_id, mlt.id, 'no_deduction'
  from public.merchant_leave_types mlt
  where mlt.merchant_id = p_merchant_id
  on conflict (leave_type_id) do nothing;
end;
$$;

comment on function public.seed_default_leave_deduction_rules(uuid) is '模組 8 薪資與帳務:為該商家目前所有假別各建立一筆 no_deduction 的扣款規則(第〇節開頭原則,不預設任何假別要扣款)。必須在 seed_default_leave_types(模組 7)已經種好假別之後呼叫,才會有列可以迭代。on conflict (leave_type_id) do nothing 保持冪等,只在 create_group_and_merchant/create_merchant_in_group 建立商家當下、緊接在 seed_default_leave_types 之後呼叫。';

-- =========================================================================
-- create_group_and_merchant/create_merchant_in_group 補呼叫。逐字保留自
-- 20260919150100_scheduling_leave_functions.sql(已對正式環境核對過,無漂移),只新增
-- 兩行 perform 呼叫,緊接在既有 seed_default_leave_types 之後。
-- =========================================================================
create or replace function public.create_group_and_merchant(
  p_name text,
  p_industry_type text,
  p_address text default null,
  p_contact_email text default null,
  p_intro text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  return v_merchant_id;
end;
$$;

comment on function public.create_group_and_merchant(text, text, text, text, text) is 'Onboarding(4.1)呼叫的 RPC:原子性建立集團+第一間商家+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式+種入模組 7 預設假別+種入模組 8 預設薪資設定與假別扣款規則,見規格書 3.2、支付方式.md §2、排班與休假管理.md §3.9、薪資與帳務.md §3.12。';

create or replace function public.create_merchant_in_group(
  p_group_id uuid,
  p_name text,
  p_industry_type text,
  p_address text default null,
  p_contact_email text default null,
  p_intro text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
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

  return v_merchant_id;
end;
$$;

comment on function public.create_merchant_in_group(uuid, text, text, text, text, text) is '新增分店流程(4.4)呼叫的 RPC:檢查規則 2.5 權限後,原子性建立新分店+登記建立者為管理員+套用產業預設功能+種入模組 9 v2 預設付款方式+種入模組 7 預設假別+種入模組 8 預設薪資設定與假別扣款規則,見規格書 3.3、支付方式.md §2、排班與休假管理.md §3.9、薪資與帳務.md §3.12。';
