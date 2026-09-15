-- 模組 2:超級管理員/平台管理後台(核心層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\超級管理員後台.md
-- 這支 migration 對應規格書 1.1(platform_admins 表結構)、1.2(industry_feature_presets 補 CHECK)、
-- 3.1(private.is_platform_admin)、3.2(public.am_i_platform_admin)。
--
-- 重要:這支 migration 只包含表結構本身，不包含把任何使用者登記為平台管理員的種子資料，
-- 見規則 2.8 —— 種子資料由主腦事後手動用 Supabase 資料庫工具下一次性 SQL 處理，不進版控。

-- =========================================================================
-- 1.1 platform_admins(平台管理員)資料表
-- =========================================================================
create table public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

comment on table public.platform_admins is '平台管理員(超級管理員)名單(對應規格書 1.1)。秒約營運方本人，跨所有集團/商家管理，不受模組 1 的 RLS 權限範圍限制。只有極少數列，不開放任何前端 INSERT/UPDATE/DELETE，新增/移除都走手動 SQL(見規則 2.8)。';
comment on column public.platform_admins.note is '備註用，例如「秒約創辦人」，非必填。';

-- =========================================================================
-- 1.2 industry_feature_presets 補一條 CHECK 約束
-- 模組 1 建表時沒有限制 industry_type 只能是特定值，這裡補上，避免超級管理員後台的表單
-- 打錯字建出一個永遠不會被任何商家用到的孤兒列。加約束前先確認沒有既存的非法值。
-- =========================================================================
do $$
begin
  if exists (
    select 1 from public.industry_feature_presets
    where industry_type not in ('on_site_dispatch', 'in_store_beauty')
  ) then
    raise exception 'industry_feature_presets 已存在不合法的 industry_type 值，需先手動清理才能加上這條 CHECK 約束';
  end if;
end;
$$;

alter table public.industry_feature_presets
  add constraint industry_feature_presets_industry_type_check
  check (industry_type in ('on_site_dispatch', 'in_store_beauty'));

-- =========================================================================
-- 3.1 private.is_platform_admin()
-- 只給 RLS 政策/本模組內部函式呼叫，比照模組 1 的 private.is_merchant_admin/is_group_member，
-- 刻意放在 private schema 避免被 PostgREST 曝光成公開 API 端點。
-- =========================================================================
create or replace function private.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
  );
$$;

comment on function private.is_platform_admin() is '目前登入者是否為平台管理員(超級管理員)。只給 RLS 政策/本模組內部函式呼叫，對應規格書 3.1。';

revoke execute on function private.is_platform_admin() from public, anon;
grant execute on function private.is_platform_admin() to authenticated;

-- =========================================================================
-- 3.2 public.am_i_platform_admin()
-- 對應規則 2.2:給前端呼叫，決定要不要顯示超級管理員後台入口/放行路由。
-- 這只是前端體驗用的路由守衛，不是安全邊界——真正的安全邊界是疊加了 is_platform_admin() 的 RLS 政策。
-- =========================================================================
create or replace function public.am_i_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select private.is_platform_admin();
$$;

comment on function public.am_i_platform_admin() is '對應規則 2.2/3.2:前端呼叫用，回傳目前登入者是否為平台管理員。只回傳呼叫者自己的身份，不洩漏其他使用者資訊。';

-- Postgres 建立函式時預設會額外授權 PUBLIC 執行，anon 是透過 PUBLIC 這個虛擬角色取得權限，
-- 光是 revoke ... from anon 收不掉這層，要連 public 一起 revoke(比照模組 1 對
-- get_merchant_admin_users 的做法，見 20260915100400_merchant_admin_users_lookup.sql)。
revoke execute on function public.am_i_platform_admin() from public, anon;
grant execute on function public.am_i_platform_admin() to authenticated;

-- =========================================================================
-- platform_admins 的 RLS：只開一條 SELECT，且要先是平台管理員才能看到平台管理員名單。
-- 不開放任何前端 INSERT/UPDATE/DELETE 政策(見規則 2.8，新增/移除都走手動 SQL)。
-- =========================================================================
alter table public.platform_admins enable row level security;

create policy platform_admins_select on public.platform_admins
  for select
  to authenticated
  using (private.is_platform_admin());
