-- 模組 4:服務項目管理(資料層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\服務項目管理.md
-- 這支 migration 對應規格書第一節 1.1(service_categories)、1.2(service_items)、
-- 1.3(補齊 merchant_staff_service_items.service_item_id 外鍵,收尾模組 3 的技術債)。

-- =========================================================================
-- 1.1 service_categories(服務分類)
-- 數量無上限,同一商家底下分類名稱不能重複(見規格書 1.1)。
-- =========================================================================
create table public.service_categories (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, name)
);

comment on table public.service_categories is '服務分類(對應規格書 1.1)。數量無上限,由商家自行新增管理。刪除是真刪除,不是軟刪除(規則 2.2),底下服務項目會自動變回未分類(見 service_items.category_id 的 on delete set null)。';

create trigger service_categories_set_updated_at
  before update on public.service_categories
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.2 service_items(服務項目)
-- category_id 允許 NULL(規則 2.1,NULL 代表「未分類」)。
-- duration_minutes 必填但允許填 0(規則 2.4,2026-09-16 使用者修正決策)。
-- 軟刪除(規則 2.3):status 只能透過 UPDATE 改成 'removed',沒有 DELETE 政策(見下一支
-- migration 20260916130100 的 3.2)。
-- =========================================================================
create table public.service_items (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  category_id uuid references public.service_categories(id) on delete set null,
  name text not null,
  price numeric(10, 2) not null check (price >= 0),
  item_type text not null check (item_type in ('primary', 'addon')),
  duration_minutes integer not null check (duration_minutes >= 0),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.service_items is '服務項目(對應規格書 1.2)。category_id 為 NULL 時前端顯示「未分類」(規則 2.1),不建立一筆真實資料代表它。item_type 單選:primary(主要服務)/addon(加價服務)。duration_minutes 必填但允許 0,代表「不額外佔用行事曆時段」(規則 2.4)。下架用軟刪除(status=removed,規則 2.3),沒有 DELETE 政策。';
comment on column public.service_items.category_id is 'NULL 代表「未分類」,分類被刪除時(service_categories 真刪除)這裡自動變回 NULL,服務項目本身資料不受影響(規則 2.1/2.2)。';
comment on column public.service_items.duration_minutes is '單位:分鐘。必填,允許填 0 表示這個服務不額外佔用行事曆時段,不用 NULL 表示不確定(2026-09-16 使用者修正決策,取代原規劃「可留空」草稿,見規則 2.4)。';

create trigger service_items_set_updated_at
  before update on public.service_items
  for each row execute function public.set_updated_at();

create index service_items_merchant_id_idx on public.service_items (merchant_id);
create index service_items_category_id_idx on public.service_items (category_id);

-- =========================================================================
-- 1.3 收尾模組 3 的技術債:merchant_staff_service_items.service_item_id 補上外鍵約束
-- 模組 3 規格書 1.2 節明確記錄「等模組 4 定案服務項目表結構後,由模組 4 的規格書負責補上外鍵約束」。
-- on delete cascade 是防禦性設計:目前 service_items 只做軟刪除,正常情況下不會觸發這個
-- cascade,但保留這個設定以防未來有真正的硬刪除操作(見規格書 1.3 邊界情況)。
-- =========================================================================
alter table public.merchant_staff_service_items
  add constraint merchant_staff_service_items_service_item_id_fkey
  foreign key (service_item_id) references public.service_items(id) on delete cascade;

comment on column public.merchant_staff_service_items.service_item_id is
  '對應 service_items.id,外鍵已於模組 4 補上(原模組 3 migration 註記的待辦已完成)。';
