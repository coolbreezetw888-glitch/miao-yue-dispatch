-- 模組 1:商家與集團管理
-- 對應規格書第三節 3.2(create_group_and_merchant)、3.3(create_merchant_in_group)、
-- 3.4(apply_industry_preset)、規則 2.7(booking slug 產生規則)。

-- =========================================================================
-- 規則 2.7:預約網址代碼(booking slug)產生與唯一性
-- 只包含英數字與連字號,不能是中文/特殊符號,不能跟系統既有路徑相同,確保唯一。
-- =========================================================================
create or replace function public.generate_booking_slug(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
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
      raise exception '無法產生唯一的預約網址代碼,請稍後再試';
    end if;
  end loop;

  return v_candidate;
end;
$$;

comment on function public.generate_booking_slug(text) is '依店名產生英數字+連字號的預約網址代碼,確保唯一且不與系統路徑衝突,見規則 2.7。';

-- =========================================================================
-- 3.4 套用產業預設功能組合的寫入邏輯
-- 0 筆預設值時應正常執行完成(寫入 0 筆),不應該讓建店流程失敗。
-- =========================================================================
create or replace function public.apply_industry_preset(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_industry_type text;
begin
  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if v_industry_type is null then
    raise exception '找不到指定的商家: %', p_merchant_id;
  end if;

  insert into public.merchant_feature_flags (merchant_id, feature_key, enabled)
  select p_merchant_id, ifp.feature_key, ifp.default_enabled
  from public.industry_feature_presets ifp
  where ifp.industry_type = v_industry_type
  on conflict (merchant_id, feature_key) do nothing;
end;
$$;

comment on function public.apply_industry_preset(uuid) is '依商家的 industry_type 讀取 industry_feature_presets,批次寫入 merchant_feature_flags。目前 industry_feature_presets 是空表,此函式會正常寫入 0 筆,見規格書 1.6/3.4。';

-- =========================================================================
-- 3.2 create_group_and_merchant:原子性建立集團 + 第一間商家
-- ①建立 groups ②建立 merchants ③merchant_admins 插入建立者 ④套用產業預設功能
-- 四件事全部成功才算成功,任何一步失敗全部回滾(單一函式內預設在同一交易中執行)。
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

  return v_merchant_id;
end;
$$;

comment on function public.create_group_and_merchant(text, text, text, text, text) is 'Onboarding(4.1)呼叫的 RPC:原子性建立集團+第一間商家+登記建立者為管理員+套用產業預設功能,見規格書 3.2。';

revoke all on function public.create_group_and_merchant(text, text, text, text, text) from public;
grant execute on function public.create_group_and_merchant(text, text, text, text, text) to authenticated;

-- =========================================================================
-- 3.3 create_merchant_in_group:原子性新增分店
-- 先檢查呼叫者符合規則 2.5(is_group_member 為真),不符合直接回傳錯誤,不建立任何資料。
-- =========================================================================
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

  if not public.is_group_member(p_group_id) then
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

  return v_merchant_id;
end;
$$;

comment on function public.create_merchant_in_group(uuid, text, text, text, text, text) is '新增分店流程(4.4)呼叫的 RPC:檢查規則 2.5 權限後,原子性建立新分店+登記建立者為管理員+套用產業預設功能,見規格書 3.3。';

revoke all on function public.create_merchant_in_group(uuid, text, text, text, text, text) from public;
grant execute on function public.create_merchant_in_group(uuid, text, text, text, text, text) to authenticated;
