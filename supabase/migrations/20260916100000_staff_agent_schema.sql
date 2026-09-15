-- 模組 3:人員與權限管理(資料層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\人員與權限管理.md
-- 這支 migration 對應規格書第一節(1.1-1.4)資料表、3.1(private.is_merchant_agent)、
-- 3.10(merchants_select 疊加)、3.11(RLS 政策)。

-- =========================================================================
-- 1.1 merchant_staff(服務人員/師傅)
-- 多對多:同一人可能同時是多間商家的服務人員(見規格書 1.1 說明),所以不是 user_id 一對一,
-- 而是每一列代表「某個人在某間商家」的一份人員名錄資料。user_id 這次多半為 NULL(規則 2.2)。
-- =========================================================================
create table public.merchant_staff (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  nickname text,
  phone text,
  contact_email text,
  avatar_url text,
  intro text,
  is_listed boolean not null default false,
  line_bound boolean not null default false,
  line_user_id text,
  status text not null default 'active' check (status in ('active', 'removed')),
  -- 1.1.1 權限功能開關:這次只存值,不連動任何邏輯(見規格書 1.1.1 邊界情況)。
  advance_booking_days integer,
  booking_window_min_days integer
    check (booking_window_min_days is null or (booking_window_min_days between 3 and 180)),
  booking_window_max_days integer
    check (booking_window_max_days is null or (booking_window_max_days between 3 and 180)),
  no_time_slot_limit boolean not null default false,
  unlimited_backend_edit boolean not null default false,
  direct_accept_after_merchant_confirm boolean not null default false,
  auto_accept_booking boolean not null default false,
  show_member_info boolean not null default false,
  google_calendar_sync_enabled boolean not null default false,
  can_create_edit_orders boolean not null default false,
  can_upload_construction_photos boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_staff_booking_window_range check (
    booking_window_min_days is null
    or booking_window_max_days is null
    or booking_window_min_days <= booking_window_max_days
  )
);

comment on table public.merchant_staff is '服務人員/師傅(對應規格書 1.1)。多對多:同一人可同時服務多間商家。這次不開放登入(規則 2.2),user_id 多半為 NULL,保留欄位為未來認領帳號流程鋪路。';
comment on column public.merchant_staff.contact_email is '對外聯絡 email,跟登入 email(若未來有)是兩回事,比照模組 1 規則 2.3。';
comment on column public.merchant_staff.status is '軟刪除欄位(規則 2.8):active/removed,移除一律改成 removed,不做真刪除。';

-- 只在 user_id 有值時要求 (merchant_id, user_id) 唯一,避免同一人被重複加進同一商家兩次;
-- user_id 為 NULL 時不受此限制(可能同一商家有多筆姓名相同、都還沒綁帳號的人員資料)。
create unique index merchant_staff_merchant_user_unique
  on public.merchant_staff (merchant_id, user_id)
  where user_id is not null;

create trigger merchant_staff_set_updated_at
  before update on public.merchant_staff
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.2 merchant_staff_service_items(服務人員 x 服務項目關聯)
-- service_item_id 這次刻意不加外鍵約束——模組 4 的 service_items 表還不存在,等模組 4 定案後
-- 由模組 4 的規格書負責補上外鍵約束(見規格書 1.2 邊界情況/第七節待處理事項 2)。
-- =========================================================================
create table public.merchant_staff_service_items (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  service_item_id uuid not null,
  created_at timestamptz not null default now(),
  unique (staff_id, service_item_id)
);

comment on table public.merchant_staff_service_items is '服務人員 x 服務項目關聯(對應規格書 1.2)。service_item_id 刻意不加外鍵,等模組 4 定案 service_items 表結構後補上,見規格書第七節待處理事項 2。';

-- =========================================================================
-- 1.3 merchant_agents(客服人員)
-- 多對多,同樣理由(沿用同一套設計語言,成本不高,見規格書 1.3 說明)。
-- =========================================================================
create table public.merchant_agents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  nickname text,
  phone text,
  contact_email text,
  invited_email text not null,
  status text not null default 'invited' check (status in ('invited', 'active', 'removed')),
  invited_at timestamptz not null default now(),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_agents is '客服人員(對應規格書 1.3)。需要登入帳號。狀態機見規則 2.7:invited(邀請信已寄出/查無帳號剛送出邀請)、active(已能登入)、removed(已移除,軟刪除)。';
comment on column public.merchant_agents.invited_email is '邀請當下輸入的 email,獨立存一份,不透過 auth.users 反查,避免對方之後自己改登入 email 導致對不上邀請紀錄(規格書 1.3)。';

create unique index merchant_agents_merchant_user_unique
  on public.merchant_agents (merchant_id, user_id)
  where user_id is not null;

create trigger merchant_agents_set_updated_at
  before update on public.merchant_agents
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.4 merchant_agent_permissions(客服後台功能權限)
-- 比照模組 1 merchant_feature_flags 的既有設計語言(feature_key + enabled + unique),
-- 不做強制白名單(見規格書 1.4:section_key 初稿清單只是前端自動完成用,之後陸續補齊)。
-- =========================================================================
create table public.merchant_agent_permissions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.merchant_agents(id) on delete cascade,
  section_key text not null,
  granted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agent_id, section_key)
);

comment on table public.merchant_agent_permissions is '客服後台功能權限(對應規格書 1.4)。刻意排除 agent_management(客服管理本身)這個 section_key——客服不能設定其他客服的權限,這件事永遠只有商家管理員能做,靠 RLS(3.11)限定只有商家管理員能寫入整張表落實,不是靠應用層檢查某個 section_key。';

create trigger merchant_agent_permissions_set_updated_at
  before update on public.merchant_agent_permissions
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 3.1 private.is_merchant_agent(p_merchant_id uuid)
-- 對應規則 2.9 第 1 點:務必包含 status = 'active' 條件,移除後的客服呼叫這支函式一律得到 false。
-- =========================================================================
create or replace function private.is_merchant_agent(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.merchant_agents ma
    where ma.merchant_id = p_merchant_id
      and ma.user_id = auth.uid()
      and ma.status = 'active'
  );
$$;

comment on function private.is_merchant_agent(uuid) is '目前登入者是否為該商家「目前有效」的客服(status=active,對應規則 2.9 第 1 點,已移除的客服一律回傳 false)。只給 RLS 政策/本模組內部函式呼叫,不對外暴露。';

revoke execute on function private.is_merchant_agent(uuid) from public, anon;
grant execute on function private.is_merchant_agent(uuid) to authenticated;

-- =========================================================================
-- 3.10 merchants_select 疊加 is_merchant_agent,讓客服登入後透過既有的
-- fetchAccessibleMerchants()/useGroupMerchants() 自然看到自己被指派的商家,不用另開一套查詢邏輯。
-- 目前 merchants_select 的判斷式(模組 2 疊加後)是:
--   private.is_merchant_admin(id) or private.is_platform_admin()
-- 這裡疊加第三個分支,政策名稱/數量不變。
-- 刻意不疊加 merchants_update——客服不能改商家設定,只讀不寫(規格書 3.10 邊界情況)。
-- =========================================================================
alter policy merchants_select on public.merchants
  using (
    private.is_merchant_admin(id)
    or private.is_platform_admin()
    or private.is_merchant_agent(id)
  );

-- =========================================================================
-- 3.11 RLS 政策
-- =========================================================================
alter table public.merchant_staff enable row level security;
alter table public.merchant_staff_service_items enable row level security;
alter table public.merchant_agents enable row level security;
alter table public.merchant_agent_permissions enable row level security;

-- merchant_staff:SELECT/INSERT/UPDATE 一律要求 is_merchant_admin(merchant_id) 為真。
-- 沒有 DELETE 政策——只能軟刪除(status='removed'),見規則 2.8,前端呼叫 remove_merchant_staff
-- 實際上是一般 UPDATE(見規格書 3.4),不需要真刪除。
create policy merchant_staff_select on public.merchant_staff
  for select to authenticated
  using (private.is_merchant_admin(merchant_id));

create policy merchant_staff_insert on public.merchant_staff
  for insert to authenticated
  with check (private.is_merchant_admin(merchant_id));

create policy merchant_staff_update on public.merchant_staff
  for update to authenticated
  using (private.is_merchant_admin(merchant_id))
  with check (private.is_merchant_admin(merchant_id));

-- merchant_staff_service_items:規格書 3.11 沒有明列這張表(只列了 merchant_staff/merchant_agents/
-- merchant_agent_permissions),但這張表同樣啟用了 RLS,不補政策的話會連商家管理員自己都讀不到
-- (rls_enabled_no_policy,模組 1 踩過的坑)。比照 merchant_staff 的判斷邏輯,透過 join 回
-- merchant_staff.merchant_id 檢查 is_merchant_admin——這是工程師依規格書設計精神補上的必要政策,
-- 不是規格書明列項目,已在回報中向主腦/使用者說明。允許 SELECT/INSERT/DELETE(沒有 UPDATE,
-- 因為每一列只代表「有沒有勾選這個服務項目」,勾掉是刪除整列,不是更新內容)。
create policy merchant_staff_service_items_select on public.merchant_staff_service_items
  for select to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id and private.is_merchant_admin(ms.merchant_id)
    )
  );

create policy merchant_staff_service_items_insert on public.merchant_staff_service_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id and private.is_merchant_admin(ms.merchant_id)
    )
  );

create policy merchant_staff_service_items_delete on public.merchant_staff_service_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id and private.is_merchant_admin(ms.merchant_id)
    )
  );

-- merchant_agents:SELECT 允許 is_merchant_admin(merchant_id) 或 user_id = auth.uid()
-- (讓客服自己能讀到自己的紀錄,包含被移除後的狀態,對應規則 2.9 邊界情況)。
-- 沒有 INSERT/UPDATE 政策——一律透過 3.6/3.7/3.8 的 SECURITY DEFINER 函式寫入,
-- 不對前端開放直接 INSERT/UPDATE 這張表(比照模組 2 對 merchant_admins 的既有做法)。
create policy merchant_agents_select on public.merchant_agents
  for select to authenticated
  using (
    private.is_merchant_admin(merchant_id)
    or user_id = auth.uid()
  );

-- merchant_agent_permissions:SELECT 允許 is_merchant_admin(對應商家) 或該客服本人
-- (透過 join merchant_agents 確認 user_id = auth.uid())。
-- 沒有 INSERT/UPDATE 政策——只透過 3.9 的 set_agent_permission() 函式寫入。
create policy merchant_agent_permissions_select on public.merchant_agent_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.merchant_agents ag
      where ag.id = agent_id
        and (private.is_merchant_admin(ag.merchant_id) or ag.user_id = auth.uid())
    )
  );
