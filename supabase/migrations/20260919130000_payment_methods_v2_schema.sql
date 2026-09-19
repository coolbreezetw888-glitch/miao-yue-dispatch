-- 模組 9:支付方式 v2 — 資料層(第一支:schema)。
-- 對應規格書 .project/specs/支付方式.md(v2,全文取代 v1)§1.1/§1.2/§1.3。
--
-- **v2 全文取代 v1**:使用者當面推翻 v1「系統固定 7 個付款方式代碼,商家只能開關」的方向,
-- 改成「商家可以自己新增/編輯/下架自己的付款方式項目」,比照專案既有的「料錢成本」
-- (material_cost_items)模式。v1 上線至今 merchant_payment_method_settings 是 0 筆資料、
-- 唯一一筆真實預約的 payment_method 也是 null,這次是乾淨的砍掉重建,不需要處理資料回填/相容性。
--
-- 執行前置確認(§1.3 明確要求,已於動工前重新查證正式環境 wjtbmmnakcriuaqoknsq):
--   select distinct payment_method from public.bookings;              -- 只有 null
--   select count(*) from public.merchant_payment_method_settings;     -- 0 筆
-- 兩項查詢結果都跟規格書寫成當下一致,沒有新增真實資料,可以直接照規格書執行這支破壞性遷移。

-- =========================================================================
-- 1. 拿掉 v1 的 CHECK 約束(bookings.payment_method 限定 7 個固定代碼)。
-- =========================================================================
alter table public.bookings drop constraint if exists bookings_payment_method_check;

-- =========================================================================
-- 2. 砍掉 v1 的商家層級開關表(0 筆資料,無需回填)。
-- =========================================================================
drop table if exists public.merchant_payment_method_settings;

-- =========================================================================
-- 3. 建立新表 payment_methods(商家自訂付款方式清單,§1.1)。
-- 命名說明:比照 service_items/material_cost_items 的既有命名慣例——這種「商家自己維護的
-- 清單型」資料表不加 merchant_ 前綴(merchant_ 前綴留給 merchant_business_hours/
-- merchant_tax_settings/merchant_feature_flags 這種「一商家一份設定」的表),表本身用
-- merchant_id 欄位標示歸屬。結構完全比照 material_cost_items,只是欄位內容換成「名稱+說明文字」
-- 而不是「名稱+金額」。
-- =========================================================================
create table public.payment_methods (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.payment_methods is '商家自訂的付款方式清單(模組 9 v2,取代 v1 的固定 7 代碼 + merchant_payment_method_settings 開關表)。比照 material_cost_items 的既有模式:商家自己命名,想新增幾筆都可以,不分「真的收費方式」跟「不收費情境標記」(例如「保固服務」「免費場勘」)兩種類型,資料結構相同。description 是選填的說明文字(例如匯款要顯示的收款帳號)。軟刪除(status=removed),不算危險操作,不需要 JSON 備份。bookings 選用時一律寫入 payment_method_name_snapshot 快照(見 bookings 表調整),商家事後改名/下架不影響已建立訂單的顯示。';

create trigger payment_methods_set_updated_at
  before update on public.payment_methods
  for each row execute function public.set_updated_at();

create index payment_methods_merchant_id_idx on public.payment_methods (merchant_id);

-- =========================================================================
-- 4. bookings 欄位調整:先砍舊欄位(text,原本受 CHECK 約束限制在 7 個固定代碼),
--    再加新欄位(FK + 快照,§1.2)。
-- =========================================================================
alter table public.bookings drop column if exists payment_method;

alter table public.bookings
  add column payment_method_id uuid references public.payment_methods(id),
  add column payment_method_name_snapshot text;

create index bookings_payment_method_id_idx on public.bookings (payment_method_id);

comment on column public.bookings.payment_method_id is '模組 9 v2:指向商家自訂付款方式清單(payment_methods),nullable=尚未設定。顯示一律用 payment_method_name_snapshot,不即時 join 這個外鍵查目前名稱。外鍵不加 on delete 子句(比照 booking_material_costs.material_cost_item_id 參照 material_cost_items(id) 的既有寫法),因為 payment_methods 沒有 DELETE 政策,只能軟刪除,指向的列理論上永遠不會被真的刪除。';
comment on column public.bookings.payment_method_name_snapshot is '模組 9 v2:建立/編輯當下的付款方式名稱快照,商家事後改名/下架不影響這裡已經存的文字。取代 v1 的 payment_method text 欄位。任何畫面顯示訂單的付款方式,一律直接讀這個文字欄位,絕對不要透過 payment_method_id 即時 join payment_methods.name 去顯示。';
