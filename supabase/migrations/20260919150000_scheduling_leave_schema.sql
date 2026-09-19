-- 模組 7:排班與休假管理 — 資料層(第一支:schema)。
-- 對應規格書 .project/specs/排班與休假管理.md §1.1/§1.2/§1.3。

-- =========================================================================
-- 1.1:merchant_staff 擴充 compensation_type(服務人員計酬類型)。
-- 這是模組 3(人員與權限管理)管的表的擴充欄位,不是本模組專屬概念(規則 2.1)——欄位由本模組
-- 提出/建立,但概念上歸屬服務人員本身,之後模組 8 直接讀這個欄位。
-- ADD COLUMN ... DEFAULT 'piece_rate' 會讓既有唯一一筆真實服務人員資料(商家「涼風工匠」)
-- 自動回填為 'piece_rate'(第〇節判斷 1)。
-- =========================================================================
alter table public.merchant_staff
  add column compensation_type text not null default 'piece_rate'
    check (compensation_type in ('monthly_salary', 'piece_rate'));

comment on column public.merchant_staff.compensation_type is '服務人員計酬類型(模組 7 排班與休假管理提出/建立,概念上歸屬服務人員本身,規則 2.1):monthly_salary(月薪制)/piece_rate(按件計酬)。這次唯一的功能性用途是規則 2.2「只有月薪制服務人員可以登記請假紀錄」的判斷依據。之後模組 8(薪資與帳務)直接讀這個欄位判斷要套用抽成公式還是月薪公式,不透過本模組的對外介面繞一手。預設值/既有資料回填皆為 piece_rate(第〇節判斷 1,對既有資料行為影響最小)。';

-- =========================================================================
-- 1.2:merchant_leave_types(假別)。完全比照 payment_methods(模組 9 v2)/material_cost_items
-- 的既有設計語言:商家自訂清單,name + description(選填)+ status(active/removed 軟刪除)。
-- =========================================================================
create table public.merchant_leave_types (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_leave_types is '商家自訂的請假分類清單(模組 7 排班與休假管理 §1.2)。比照 payment_methods/material_cost_items 的既有模式:商家自己命名,想新增幾筆都可以。軟刪除(status=removed),不算危險操作,不需要 JSON 備份(規則 2.10)。已被請假紀錄引用的假別下架/改名後,既有請假紀錄靠 staff_leave_records.leave_type_name_snapshot 維持顯示不變(比照模組 9 §3.1/§3.2 的付款方式名稱快照教訓,不重新查詢)。';

create trigger merchant_leave_types_set_updated_at
  before update on public.merchant_leave_types
  for each row execute function public.set_updated_at();

create index merchant_leave_types_merchant_id_idx on public.merchant_leave_types (merchant_id);

-- =========================================================================
-- 1.3:staff_leave_records(請假紀錄)。
-- =========================================================================
create table public.staff_leave_records (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  -- 不加 on delete cascade:假別下架後這個 id 仍然有效,比照 bookings.payment_method_id 的既有寫法。
  leave_type_id uuid not null references public.merchant_leave_types(id),
  leave_type_name_snapshot text not null,
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  notes text,
  status text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancelled_at timestamptz,
  created_by_user_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.staff_leave_records is '某位月薪制服務人員在某個日期區間請假的一筆登記(模組 7 排班與休假管理 §1.3)。leave_type_name_snapshot 是建立當下寫死的假別名稱快照,之後假別改名/下架不影響這筆紀錄的顯示——完全比照模組 9 §3.1/§3.2「付款方式名稱快照,絕不重新查詢」的既有教訓。這次不支援編輯既有紀錄的日期/假別(規則 2.9),要修改內容一律先取消(cancel_staff_leave)再重新登記一筆新的。status 只有 confirmed/cancelled 兩種(這次不做簽核流程,建立即生效,第〇節判斷 2)。沒有 DELETE 政策,取消只是軟刪除(status=cancelled),不算危險操作(規則 2.10)。';

comment on column public.staff_leave_records.leave_type_name_snapshot is '建立當下寫死的假別名稱快照,之後查詢一律讀這個欄位,絕對不要重新 join merchant_leave_types 查詢目前名稱(比照模組 9 §234 已經踩過、修過的坑)。';

create trigger staff_leave_records_set_updated_at
  before update on public.staff_leave_records
  for each row execute function public.set_updated_at();

create index staff_leave_records_staff_id_dates_idx
  on public.staff_leave_records (staff_id, start_date, end_date);
