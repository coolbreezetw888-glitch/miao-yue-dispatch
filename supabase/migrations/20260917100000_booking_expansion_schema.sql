-- 模組 5 擴充:建單功能擴充(資料層,第一支)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\建單功能擴充.md
-- 這支 migration 對應規格書 2.1(booking_service_items,先建新表,不動 bookings.service_item_id)、
-- 2.2(booking_assistants)、2.3(material_cost_items、booking_material_costs)。
--
-- 刻意分成獨立一支:2.1 的破壞性搬遷(drop bookings.service_item_id)放到下一支
-- migration(20260917100100)獨立處理,任何一步出問題比較容易單獨排查(規格書七、建議實作順序 1-2)。
-- 這支只新增資料表,不動既有 bookings 表結構,執行風險最低。

-- =========================================================================
-- 2.1 booking_service_items(預約 x 服務項目多對多關聯表)
-- 取代原本 bookings.service_item_id 單一外鍵(規格書 2.1、決策記錄 1:不分主副、全部平等)。
-- duration_minutes_snapshot 是建立/編輯當下依 service_items.duration_minutes 的快照值,
-- 之後服務項目工時異動不會回頭影響已建立的預約(規格書 2.1)。
-- =========================================================================
create table public.booking_service_items (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  service_item_id uuid not null references public.service_items(id),
  duration_minutes_snapshot integer not null check (duration_minutes_snapshot >= 0),
  created_at timestamptz not null default now(),
  unique (booking_id, service_item_id)
);

comment on table public.booking_service_items is '預約 x 服務項目多對多關聯(對應規格書 2.1,取代原 bookings.service_item_id 單一外鍵)。不分主副,全部平等(決策記錄 1)。duration_minutes_snapshot 是建立/編輯當下的工時快照,之後服務項目工時異動不會回頭影響已建立的預約。只能透過 create_booking/update_booking 寫入(規則 3.2),沒有 INSERT/UPDATE/DELETE 政策。';
comment on column public.booking_service_items.duration_minutes_snapshot is '建立(或編輯)當下依 service_items.duration_minutes 的快照值,end_at = start_at + Σ(這個欄位)。';

create index booking_service_items_booking_id_idx on public.booking_service_items (booking_id);
create index booking_service_items_service_item_id_idx on public.booking_service_items (service_item_id);

-- =========================================================================
-- 2.2 booking_assistants(預約 x 助手服務人員多對多關聯表)
-- 一筆預約除了 bookings.staff_id(主要服務人員,欄位不變),可以額外指派 0 到多位助手
-- (規格書 2.2,決策記錄 2/3)。助手不能跟主要服務人員是同一人——這條用程式邏輯擋下
-- (private.validate_booking_selection,見下一支 migration),不用資料庫層 CHECK 約束
-- (CHECK 無法查詢同一列以外的關聯資料,見規格書 2.2 表結構說明)。
-- =========================================================================
create table public.booking_assistants (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  staff_id uuid not null references public.merchant_staff(id),
  created_at timestamptz not null default now(),
  unique (booking_id, staff_id)
);

comment on table public.booking_assistants is '預約 x 助手服務人員多對多關聯(對應規格書 2.2,決策記錄 2)。助手看到的訂單內容跟主要服務人員完全同步(同一筆 bookings 紀錄),且助手要完整比照主要服務人員套用所有排程驗證規則(邊界+衝突+跨商家電話比對)。助手不能跟主要服務人員是同一人,這條在 create_booking/update_booking 內用程式邏輯擋下。只能透過 create_booking/update_booking 寫入(規則 3.2),沒有 INSERT/UPDATE/DELETE 政策。';

create index booking_assistants_booking_id_idx on public.booking_assistants (booking_id);
create index booking_assistants_staff_id_idx on public.booking_assistants (staff_id);

-- =========================================================================
-- 2.3 material_cost_items(商家自訂的料錢成本品項清單)
-- 比照模組 4 service_items 的既有模式類推(規格書 2.3)。只有「名稱+金額」兩個欄位
-- (比照模組 4 服務項目最初版本的簡化做法,規格書「本模組明確不做的事」)。
-- 軟刪除(status='removed'),不算危險操作,不需要 JSON 備份(規則 3.1)。
-- =========================================================================
create table public.material_cost_items (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  amount numeric(10, 2) not null check (amount >= 0),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.material_cost_items is '商家自訂的料錢成本品項清單(對應規格書 2.3):這次服務會用掉的材料/物料成本,名稱+金額。不等於訂單金額計算,只記錄成本本身(規格書「本模組明確不做的事」)。整個功能預設關閉,見 merchant_feature_flags 的 material_cost_enabled(規則 4.7)。軟刪除(status=removed),不算危險操作(規則 3.1)。';

create trigger material_cost_items_set_updated_at
  before update on public.material_cost_items
  for each row execute function public.set_updated_at();

create index material_cost_items_merchant_id_idx on public.material_cost_items (merchant_id);

-- =========================================================================
-- 2.3 booking_material_costs(預約 x 料錢成本品項關聯表)
-- amount_snapshot 是建立/編輯當下的金額快照(比照 booking_service_items 的快照策略)。
-- =========================================================================
create table public.booking_material_costs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  material_cost_item_id uuid not null references public.material_cost_items(id),
  amount_snapshot numeric(10, 2) not null,
  created_at timestamptz not null default now(),
  unique (booking_id, material_cost_item_id)
);

comment on table public.booking_material_costs is '預約 x 料錢成本品項關聯(對應規格書 2.3)。amount_snapshot 是建立/編輯當下的金額快照,之後品項金額異動不會回頭影響已建立的預約。同一筆預約裡同一個品項只能選一次(unique 約束)。只能透過 create_booking/update_booking 寫入(規則 3.2),沒有 INSERT/UPDATE/DELETE 政策。';

create index booking_material_costs_booking_id_idx on public.booking_material_costs (booking_id);
create index booking_material_costs_material_cost_item_id_idx on public.booking_material_costs (material_cost_item_id);
