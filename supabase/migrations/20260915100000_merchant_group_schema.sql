-- 模組 1:商家與集團管理
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\商家與集團管理.md
-- 這支 migration 對應規格書第一節(1.1-1.5)資料表、第二節部分規則(2.1 產業鎖定、2.2 至少保留一間啟用中商家)、
-- 第三節 3.1(共用權限判斷函式)與 3.6(RLS 政策)。

-- =========================================================================
-- 共用工具函式:自動維護 updated_at 欄位
-- =========================================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =========================================================================
-- 1.1 groups(集團)
-- =========================================================================
create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text,
  group_admin_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.groups is '集團(對應規格書 1.1),一個集團底下可以有多間 merchants。group_admin_user_id 可選,不強制填寫。';

create trigger groups_set_updated_at
  before update on public.groups
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.2 merchants(商家/分店)
-- =========================================================================
create table public.merchants (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  name text not null,
  industry_type text not null check (industry_type in ('on_site_dispatch', 'in_store_beauty')),
  logo_url text,
  address text,
  contact_email text,
  intro text,
  theme_preset text,
  theme_custom_color text,
  announcement_enabled boolean not null default false,
  announcement_content text,
  booking_slug text unique,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchants_booking_slug_format check (
    booking_slug is null or booking_slug ~ '^[a-z0-9-]+$'
  )
);

comment on table public.merchants is '商家/分店(對應規格書 1.2)。industry_type 建立後不可修改,見 2.1 的鎖定 trigger。';
comment on column public.merchants.contact_email is '商家對外聯絡信箱,跟登入帳號 auth.users.email 是不同欄位,見規則 2.3,不可互相帶入。';
comment on column public.merchants.industry_type is '建立後鎖定不可修改,見 merchants_lock_industry_type trigger(規則 2.1)。';
comment on column public.merchants.booking_slug is '由 generate_booking_slug() 自動產生,見規則 2.7,本模組不開放前端編輯此欄位。';

create trigger merchants_set_updated_at
  before update on public.merchants
  for each row execute function public.set_updated_at();

-- 規則 2.1:產業模組選定後鎖定不可修改(資料庫層真正擋住,不能只靠前端)
create or replace function public.prevent_industry_type_change()
returns trigger
language plpgsql
as $$
begin
  if new.industry_type is distinct from old.industry_type then
    raise exception '商家建立後 industry_type 不可修改,如需更換產業請開新分店' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger merchants_lock_industry_type
  before update on public.merchants
  for each row execute function public.prevent_industry_type_change();

-- 規則 2.2:分店只能軟刪除,且集團底下至少保留一間啟用中商家
create or replace function public.prevent_disable_last_active_merchant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
      raise exception '集團底下至少要保留一間啟用中商家,無法停用最後一間' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

create trigger merchants_prevent_disable_last_active
  before update of status on public.merchants
  for each row execute function public.prevent_disable_last_active_merchant();

-- =========================================================================
-- 1.3 merchant_admins(商家管理員關聯表)
-- =========================================================================
create table public.merchant_admins (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (merchant_id, user_id)
);

comment on table public.merchant_admins is '商家管理員關聯表(對應規格書 1.3)。本模組只由 RPC 內部寫入第一筆(建立者),新增/移除其他管理員的操作介面屬於模組 3。';

-- =========================================================================
-- 1.4 merchant_feature_flags(功能開關)
-- =========================================================================
create table public.merchant_feature_flags (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  feature_key text not null,
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, feature_key)
);

comment on table public.merchant_feature_flags is '每個商家各項功能大項的開關(對應規格書 1.4)。本模組只搭資料結構,寫入邏輯見 apply_industry_preset(3.4),不做操作介面。';

create trigger merchant_feature_flags_set_updated_at
  before update on public.merchant_feature_flags
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.5 industry_feature_presets(產業預設功能組合)
-- =========================================================================
create table public.industry_feature_presets (
  id uuid primary key default gen_random_uuid(),
  industry_type text not null,
  feature_key text not null,
  default_enabled boolean not null,
  unique (industry_type, feature_key)
);

comment on table public.industry_feature_presets is '產業 -> 預設功能開關對照表(對應規格書 1.5)。本模組只建表,不塞入實際列(見規格書 1.6 的處理方式決議),也不做調整介面——調整介面屬於模組 2(超級管理員後台),見規則 2.8。之後每個模組完成對應功能時,由該模組自己的 migration 補上這裡的列。';

-- =========================================================================
-- 3.1 共用權限判斷函式:is_merchant_admin / is_group_member
-- 刻意設計成擴充口:模組 2 要做「超級管理員無視權限」時,在這裡加一個
-- OR is_platform_admin() 分支即可,不用重寫本模組既有的 RLS 政策。
-- =========================================================================
create or replace function public.is_merchant_admin(p_merchant_id uuid)
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

comment on function public.is_merchant_admin(uuid) is '目前登入者是否為該商家的管理員(含透過集團管理者身分自動取得的權限,見規則 2.4)。供本模組及未來模組 2、3 的 RLS 政策共用呼叫。';

create or replace function public.is_group_member(p_group_id uuid)
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

comment on function public.is_group_member(uuid) is '目前登入者是否為該集團的集團管理者,或該集團底下任一間商家的管理員。供規則 2.5(任一分店管理員都能開新分店)判斷用。';

grant execute on function public.is_merchant_admin(uuid) to authenticated;
grant execute on function public.is_group_member(uuid) to authenticated;

-- =========================================================================
-- 3.6 RLS 政策
-- =========================================================================
alter table public.groups enable row level security;
alter table public.merchants enable row level security;
alter table public.merchant_admins enable row level security;
alter table public.merchant_feature_flags enable row level security;
alter table public.industry_feature_presets enable row level security;

-- groups:SELECT 需 is_group_member;UPDATE 先開放給 group_admin_user_id 本人。
-- 沒有 INSERT/DELETE 政策 —— 一律透過 create_group_and_merchant RPC(security definer)寫入。
create policy groups_select on public.groups
  for select to authenticated
  using (public.is_group_member(id));

create policy groups_update_by_group_admin on public.groups
  for update to authenticated
  using (group_admin_user_id = auth.uid())
  with check (group_admin_user_id = auth.uid());

-- merchants:SELECT/UPDATE 需 is_merchant_admin(id) 為真。
-- 沒有 INSERT 政策 —— 一律透過 3.2/3.3 的 RPC(security definer)寫入。
-- 沒有 DELETE 政策 —— 只能軟刪除(status='disabled'),見規則 2.2。
create policy merchants_select on public.merchants
  for select to authenticated
  using (public.is_merchant_admin(id));

create policy merchants_update on public.merchants
  for update to authenticated
  using (public.is_merchant_admin(id))
  with check (public.is_merchant_admin(id));

-- merchant_admins:SELECT 需 is_merchant_admin(merchant_id)。
-- 沒有 INSERT/UPDATE/DELETE 政策 —— 本模組只透過 RPC 內部寫入,前端不開放直接寫入這張表
-- (未來模組 3 要做新增/移除管理員介面時,再用 CREATE POLICY 疊加,不改本模組既有政策)。
create policy merchant_admins_select on public.merchant_admins
  for select to authenticated
  using (public.is_merchant_admin(merchant_id));

-- merchant_feature_flags:SELECT 需 is_merchant_admin(merchant_id)。
-- 沒有 INSERT/UPDATE/DELETE 政策 —— 寫入只透過 apply_industry_preset()(security definer)。
create policy merchant_feature_flags_select on public.merchant_feature_flags
  for select to authenticated
  using (public.is_merchant_admin(merchant_id));

-- industry_feature_presets:本模組不對前端開放任何政策(SELECT/UPDATE 皆無)。
-- 內部由 apply_industry_preset()(security definer,執行時以函式擁有者身分繞過 RLS)讀取。
-- 前端可調整介面屬於模組 2,屆時由模組 2 自行疊加所需政策(例如 OR is_platform_admin())。
