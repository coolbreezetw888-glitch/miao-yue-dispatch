-- 模組 6:訂單管理 — 資料層(第一支):金額快照機制的地基(規格書 §2.1)。
-- 對應規格書 .project/specs/訂單管理.md §2.1:booking_service_items 新增 quantity/
-- unit_price_snapshot;bookings 新增金額彈性三開關(自訂總金額/折扣/稅金)+ 快照欄位 +
-- payment_method;新增 merchant_tax_settings 表。
--
-- 這次刻意不做的部分(留給下一批獨立處理,風險最高、牽動模組 5 排程核心邏輯):
--   - §4.3 自訂工時開關(custom_duration_enabled/custom_duration_minutes 欄位這次不新增)。
--   - §5 開啟/關閉時段(staff_availability_overrides 這次不新增)。
--
-- 安全遷移策略(比照 20260917100100_booking_expansion_data_migration.sql 的既有手法——主腦複查時
-- 特別提醒:正式環境(專案 wjtbmmnakcriuaqoknsq)「涼風工匠」商家已有 2 筆既有 booking_service_items
-- 資料列,unit_price_snapshot 設計成 not null,直接一步到位會因為既有資料列沒有預設值而遷移失敗):
--   1. 這支 migration 只新增 unit_price_snapshot 為「允許 null」的欄位。
--   2. 下一支 migration(20260918110100)負責回填既有資料列的值,驗證無 null 後才
--      alter column set not null。
--   3. quantity 欄位因為有 default 1(常數 default),Postgres 11+ 對「新增欄位同時給常數 default」
--      不需要重寫既有資料列,可以在這支 migration 直接一次到位用 not null default 1。

-- =========================================================================
-- §2.1 booking_service_items 新增 quantity/unit_price_snapshot
-- =========================================================================
alter table public.booking_service_items
  add column quantity integer not null default 1 check (quantity >= 1);

alter table public.booking_service_items
  add column unit_price_snapshot numeric(10, 2);

comment on column public.booking_service_items.quantity is '這個服務項目在這筆訂單裡選了幾份(規格書 §2.1/裁決 Q2),同時影響工時貢獻(§2.2:duration_minutes_snapshot × quantity)與金額貢獻(§2.3:unit_price_snapshot × quantity)。';
comment on column public.booking_service_items.unit_price_snapshot is '建立/編輯當下鎖定的單價快照(規格書 §2.1/§2.4)。create_booking/update_booking 一律直接使用呼叫端傳入的值寫入,不重新查詢 service_items.price——這跟 duration_minutes_snapshot(每次重新查詢,§2.2)刻意不同。這支 migration 先新增成允許 null,下一支 migration(20260918110100)回填既有資料列後才會改成 not null,不要誤以為這是最終狀態。';

-- =========================================================================
-- §2.1 bookings 新增金額彈性三開關(自訂總金額/折扣/稅金)+ 快照欄位 + payment_method。
-- 自訂工時開關(custom_duration_enabled/custom_duration_minutes)刻意不在這支 migration 新增
-- (這次只調整 §2.2 數量對工時的影響,不實作自訂工時開關本身,留給下一批)。
-- =========================================================================
alter table public.bookings
  add column custom_total_amount_enabled boolean not null default false,
  add column custom_total_amount numeric(10, 2),
  add column subtotal_amount_snapshot numeric(10, 2) not null default 0,
  add column discount_enabled boolean not null default false,
  add column discount_mode text,
  add column discount_value numeric(10, 2),
  add column discount_amount_snapshot numeric(10, 2) not null default 0,
  add column tax_enabled boolean not null default false,
  add column tax_mode_snapshot text,
  add column tax_value_snapshot numeric(10, 2),
  add column tax_amount_snapshot numeric(10, 2) not null default 0,
  add column final_amount_snapshot numeric(10, 2) not null default 0,
  add column payment_method text;

alter table public.bookings
  add constraint bookings_custom_total_amount_shape check (
    (custom_total_amount_enabled = false and custom_total_amount is null)
    or (custom_total_amount_enabled = true and custom_total_amount is not null and custom_total_amount >= 0)
  ),
  add constraint bookings_discount_shape check (
    (discount_enabled = false and discount_mode is null and discount_value is null)
    or (
      discount_enabled = true and discount_mode in ('fixed', 'percentage') and discount_value is not null
      and (
        (discount_mode = 'percentage' and discount_value between 0 and 100)
        or (discount_mode = 'fixed' and discount_value >= 0)
      )
    )
  ),
  add constraint bookings_tax_shape check (
    (tax_enabled = false and tax_mode_snapshot is null and tax_value_snapshot is null)
    or (
      tax_enabled = true and tax_mode_snapshot in ('fixed', 'percentage') and tax_value_snapshot is not null
      and (
        (tax_mode_snapshot = 'percentage' and tax_value_snapshot between 0 and 100)
        or (tax_mode_snapshot = 'fixed' and tax_value_snapshot >= 0)
      )
    )
  ),
  add constraint bookings_final_amount_non_negative check (final_amount_snapshot >= 0);

comment on column public.bookings.custom_total_amount_enabled is '自訂總金額開關(規格書 §2.1/§4.4):開啟後用 custom_total_amount 取代逐項小計,作為 §2.3 計算順序步驟 1 的結果。';
comment on column public.bookings.subtotal_amount_snapshot is '§2.3 計算順序步驟 1 的結果(逐項小計或自訂總金額)。';
comment on column public.bookings.discount_amount_snapshot is '§2.3 計算順序步驟 2 實際折抵的金額,不論固定金額或百分比模式,都換算成實際扣除的金額存下來,方便顯示。';
comment on column public.bookings.tax_mode_snapshot is '這筆訂單套用稅金當下,商家 merchant_tax_settings.tax_mode 的快照(裁決 Q5:模式是商家整體統一設定,不可每筆訂單各自選,但要鎖存這筆訂單當時是哪一種模式)。';
comment on column public.bookings.tax_value_snapshot is '這筆訂單套用的稅率/稅額數字,預設帶入商家目前設定,客服可以針對這筆訂單個別調整(裁決 Q5 只鎖定「模式」是商家層級,沒有限制數字不能個別微調)。';
comment on column public.bookings.final_amount_snapshot is '最終金額快照,§2.3 步驟 4 的結果。訂單管理頁列表、詳情頁「最終金額」顯示,一律讀這個欄位。';
comment on column public.bookings.payment_method is '付款方式(規格書 §3.2/裁決 Q10):這次只提供暫時選項「現場付款」當標記用,不加 CHECK 約束限制選項,等模組 9(支付方式)定案實際選項清單再補約束,這次不做任何金流邏輯,也不驗證金額是否真的收到。';

-- =========================================================================
-- §2.1 merchant_tax_settings(商家層級稅金模式統一設定,一商家一列,不存在視為預設值)。
-- 獨立建表,不直接改 merchants 表本身的 RLS(依賴模組:模組 1)。
-- =========================================================================
create table public.merchant_tax_settings (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  tax_mode text not null default 'percentage' check (tax_mode in ('fixed', 'percentage')),
  tax_value numeric(10, 2) not null default 5.00,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint merchant_tax_settings_tax_value_range check (
    (tax_mode = 'percentage' and tax_value between 0 and 100)
    or (tax_mode = 'fixed' and tax_value >= 0)
  )
);

comment on table public.merchant_tax_settings is '商家整體稅金模式統一設定(規格書 §2.1 裁決 Q5):一商家一列,不存在視為預設值(tax_mode=percentage、tax_value=5.00)。RLS 要求 private.can_manage_business_hours(merchant_id),沒有 DELETE 政策——查無資料等同「還沒特別設定,套用預設值」,不需要真的刪除這筆列才能恢復預設值,前端/後端查無資料時一律 fallback 成預設值即可。';
comment on column public.merchant_tax_settings.tax_mode is '稅金模式,商家整體統一設定,不是每筆訂單各自選(裁決 Q5)。要更改模式本身要到商家整體稅金設定頁(§4.7),不是在建單表單上改。';
comment on column public.merchant_tax_settings.tax_value is '預設 5.00(5% 稅率),商家可自行改成別的數字。tax_mode=percentage 時是百分比(0~100),tax_mode=fixed 時是固定金額(>=0)。';

create trigger merchant_tax_settings_set_updated_at
  before update on public.merchant_tax_settings
  for each row execute function public.set_updated_at();

alter table public.merchant_tax_settings enable row level security;

create policy merchant_tax_settings_select on public.merchant_tax_settings
  for select to authenticated
  using (private.can_manage_business_hours(merchant_id));

create policy merchant_tax_settings_insert on public.merchant_tax_settings
  for insert to authenticated
  with check (private.can_manage_business_hours(merchant_id));

create policy merchant_tax_settings_update on public.merchant_tax_settings
  for update to authenticated
  using (private.can_manage_business_hours(merchant_id))
  with check (private.can_manage_business_hours(merchant_id));

-- 沒有 DELETE 政策(規格書 §2.1 明講,查無資料視為預設值,不需要真的刪除)。
