-- 模組 1:商家與集團管理 — 主腦最終複查後的補強(非重新設計,規模很小)
-- 對應規格書 3.1、3.6，修正 Supabase security advisor 掃出的兩項提醒。

-- =========================================================================
-- 補強 1:is_merchant_admin / is_group_member 只給 RLS 政策內部呼叫用(規格書 3.1 講得很清楚
-- 是「刻意設計的擴充口」，不是公開 API)，但放在 public schema 會被 PostgREST 自動曝光成
-- /rest/v1/rpc/is_merchant_admin 這種可直接呼叫的端點(advisor: authenticated_security_definer_function_executable)。
-- 搬進 private schema——這個 schema 不在 Supabase 專案的 API 曝光清單(db-schemas)裡，
-- PostgREST 就不會幫它建路由；schema-qualified 呼叫(private.xxx(...))在 RLS 政策、
-- 其他 SQL 函式內部完全正常運作，不影響任何現有行為。
-- create_group_and_merchant / create_merchant_in_group / get_merchant_admin_users 維持在 public，
-- 這三個本來就是設計給前端直接呼叫的 RPC，不受影響。
-- =========================================================================

create schema if not exists private;
-- 只給 authenticated 用(RLS 政策以 authenticated 角色執行時需要 USAGE 才能解析 private.xxx 這個識別字)，
-- 不給 anon，也不需要给 anon —— 這兩個函式本來就假設呼叫者已登入。
grant usage on schema private to authenticated;

create or replace function private.is_merchant_admin(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from public.merchant_admins ma
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
    )
    or exists (
      select 1
      from public.merchants m
      join public.groups g on g.id = m.group_id
      where m.id = p_merchant_id
        and g.group_admin_user_id = auth.uid()
    );
$$;

comment on function private.is_merchant_admin(uuid) is '目前登入者是否為該商家的管理員(含集團管理者自動取得的權限,規則 2.4)。只給 RLS 政策/本模組內部函式呼叫，刻意放在 private schema 避免被 PostgREST 曝光成 API(對應主腦複查補強項目 1)。';

create or replace function private.is_group_member(p_group_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    exists (
      select 1
      from public.groups g
      where g.id = p_group_id
        and g.group_admin_user_id = auth.uid()
    )
    or exists (
      select 1
      from public.merchant_admins ma
      join public.merchants m on m.id = ma.merchant_id
      where m.group_id = p_group_id
        and ma.user_id = auth.uid()
    );
$$;

comment on function private.is_group_member(uuid) is '目前登入者是否為該集團的集團管理者,或該集團底下任一間商家的管理員(規則 2.5)。只給 RLS 政策/本模組內部函式呼叫，刻意放在 private schema(對應主腦複查補強項目 1)。';

revoke execute on function private.is_merchant_admin(uuid) from public, anon;
revoke execute on function private.is_group_member(uuid) from public, anon;
grant execute on function private.is_merchant_admin(uuid) to authenticated;
grant execute on function private.is_group_member(uuid) to authenticated;

-- 把所有原本呼叫 public.is_merchant_admin / public.is_group_member 的地方改成呼叫 private.* 版本。
-- 用 ALTER POLICY 只改 USING/WITH CHECK 運算式，不動政策名稱/角色，維持跟 3.6 一致的「疊加式」設計。

alter policy groups_select on public.groups
  using (private.is_group_member(id));

alter policy merchants_select on public.merchants
  using (private.is_merchant_admin(id));

alter policy merchants_update on public.merchants
  using (private.is_merchant_admin(id))
  with check (private.is_merchant_admin(id));

alter policy merchant_admins_select on public.merchant_admins
  using (private.is_merchant_admin(merchant_id));

alter policy merchant_feature_flags_select on public.merchant_feature_flags
  using (private.is_merchant_admin(merchant_id));

alter policy merchant_logos_admin_insert on storage.objects
  with check (
    bucket_id = 'merchant-logos'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

alter policy merchant_logos_admin_update on storage.objects
  using (
    bucket_id = 'merchant-logos'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  )
  with check (
    bucket_id = 'merchant-logos'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

alter policy merchant_logos_admin_delete on storage.objects
  using (
    bucket_id = 'merchant-logos'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

-- create_merchant_in_group(3.3)內部呼叫的權限檢查改成 private.is_group_member。
-- CREATE OR REPLACE 不會重置既有的 GRANT/REVOKE 設定，函式本身「只給 authenticated、anon 不行」的
-- 授權狀態維持不變，不需要重新下 grant/revoke。
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

  return v_merchant_id;
end;
$$;

-- get_merchant_admin_users(5.4)內部呼叫的權限檢查改成 private.is_merchant_admin。
create or replace function public.get_merchant_admin_users(p_merchant_id uuid)
returns table (
  id uuid,
  merchant_id uuid,
  user_id uuid,
  email text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限查看此商家的管理員名單' using errcode = '42501';
  end if;

  return query
    select ma.id, ma.merchant_id, ma.user_id, u.email::text, ma.created_at
    from public.merchant_admins ma
    join auth.users u on u.id = ma.user_id
    where ma.merchant_id = p_merchant_id
    order by ma.created_at asc;
end;
$$;

-- 舊的 public.is_merchant_admin / public.is_group_member 已經沒有任何政策或函式依賴，可以安全移除，
-- 避免同時存在兩份容易搞混、也避免 public 版本繼續被 advisor 標記。
drop function if exists public.is_merchant_admin(uuid);
drop function if exists public.is_group_member(uuid);

-- =========================================================================
-- 補強 2:industry_feature_presets 啟用了 RLS 卻完全沒有政策，導致連 authenticated 都讀不到
-- (advisor: rls_enabled_no_policy)。這張表是通用參考資料(產業 -> 預設功能對照表)，
-- 不含任何特定商家的機密內容，開放「唯讀」給所有登入使用者沒有安全疑慮；
-- 寫入依然只透過 apply_industry_preset() 或未來模組 2 的專屬管理介面，不開放 INSERT/UPDATE/DELETE。
-- =========================================================================
create policy industry_feature_presets_select on public.industry_feature_presets
  for select
  to authenticated
  using (true);
