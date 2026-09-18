-- 模組 9:支付方式 — 資料層。對應規格書 .project/specs/支付方式.md §1.2/§1.3。
--
-- §1.2:bookings.payment_method 補 CHECK 約束——模組 6(訂單管理)規格書 §3.2 當時明講
-- 「不加 CHECK 約束,等模組 9 定案實際選項清單再補約束」,現在選項清單定案(§1.1,7 個固定代碼),
-- 補上這條約束。上線前已查證正式環境(專案 wjtbmmnakcriuaqoknsq)現有資料
-- `select distinct payment_method from bookings` 只有 null,沒有例外值,可以直接套用約束。
alter table public.bookings
  add constraint bookings_payment_method_check
  check (payment_method is null or payment_method in
    ('on_site', 'bank_transfer', 'atm', 'linepay', 'jkopay', 'credit_card', 'no_payment'));

comment on column public.bookings.payment_method is '付款方式(規格書模組 9 §1.1/§1.2,取代模組 6 當時「只有 on_site 一個暫時選項、不加約束」的舊備註):七個固定代碼之一或 null,CHECK 約束限制範圍。null 代表「尚未設定」,no_payment 代表「這筆本來就不用收費」(Q2 暫定裁決,兩者顯示文字不同,見 types.ts getPaymentMethodLabel)。實際開放哪些選項給客服選,由 merchant_payment_method_settings 商家層級設定決定,跟這個欄位本身可接受的值範圍是兩件事——商家關掉某個選項不影響舊訂單已經存的值仍然合法。這次完全不驗證是否真的收到款項,純粹是客服人工標記。';

-- =========================================================================
-- §1.3 merchant_payment_method_settings(商家層級「開放哪些付款方式」設定表,Q1/Q3 暫定裁決,
-- 待使用者確認):結構比照 merchant_tax_settings(20260918110000_order_management_schema.sql)
-- 的既有寫法,一商家可以有 0~7 筆列。
-- =========================================================================
create table public.merchant_payment_method_settings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  payment_method_code text not null check (payment_method_code in
    ('on_site', 'bank_transfer', 'atm', 'linepay', 'jkopay', 'credit_card', 'no_payment')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, payment_method_code)
);

comment on table public.merchant_payment_method_settings is '商家層級「開放哪些付款方式」設定(規格書 §1.3,裁決 Q1 暫定方案 B,待使用者確認):一商家可以有 0~7 筆列,查無某代碼的列時視為該選項「未開放」,除了 on_site 之外——on_site 是唯一「查無資料視為預設開放」的例外(裁決 Q3)。RLS 要求 private.can_manage_business_hours(merchant_id),沒有 DELETE 政策,要關閉某個選項寫 enabled=false 即可。';

create trigger merchant_payment_method_settings_set_updated_at
  before update on public.merchant_payment_method_settings
  for each row execute function public.set_updated_at();

alter table public.merchant_payment_method_settings enable row level security;

create policy merchant_payment_method_settings_select on public.merchant_payment_method_settings
  for select to authenticated
  using (private.can_manage_business_hours(merchant_id));

create policy merchant_payment_method_settings_insert on public.merchant_payment_method_settings
  for insert to authenticated
  with check (private.can_manage_business_hours(merchant_id));

create policy merchant_payment_method_settings_update on public.merchant_payment_method_settings
  for update to authenticated
  using (private.can_manage_business_hours(merchant_id))
  with check (private.can_manage_business_hours(merchant_id));

-- 沒有 DELETE 政策(比照 merchant_tax_settings 的既有慣例:查無資料等同「維持預設狀態」,
-- 不需要真的刪除這筆列才能恢復預設值,關閉某選項一律寫 enabled=false)。
