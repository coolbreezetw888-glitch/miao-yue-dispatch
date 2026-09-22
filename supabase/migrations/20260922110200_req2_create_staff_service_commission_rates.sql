-- 商家端三項調整規格書 §二 2.2.1:服務項目層級抽成設定表,取代模組8原本一人一個籠統比例的
-- staff_commission_rates。查無這個組合的紀錄,一律視為 0 元抽成(判斷2,財務保守預設)。

create table public.staff_service_commission_rates (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  commission_mode text not null default 'percentage'
    check (commission_mode in ('percentage', 'fixed_amount')),
  commission_value numeric(10, 2) not null default 0 check (commission_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, service_item_id),
  constraint staff_service_commission_rates_percentage_upper_bound check (
    commission_mode <> 'percentage' or commission_value <= 100
  )
);

comment on table public.staff_service_commission_rates is '針對「服務人員 × 服務項目」設定抽成模式與數值(需求2),取代模組8原本一人一個籠統比例的 staff_commission_rates。commission_mode=percentage 時 commission_value 是 0~100 的百分比;commission_mode=fixed_amount 時 commission_value 是每件/每份固定金額(元/件),不受訂單金額影響。查無這個組合的紀錄,一律視為 0 元抽成(判斷2,財務保守預設)。只能替 compensation_type=piece_rate 的服務人員建立(RLS WITH CHECK,比照原 staff_commission_rates 既有模式)。允許 DELETE(移除設定、恢復成「尚未設定=0元」,不是危險操作)。';

create trigger staff_service_commission_rates_set_updated_at
  before update on public.staff_service_commission_rates
  for each row execute function public.set_updated_at();

create index staff_service_commission_rates_staff_id_idx
  on public.staff_service_commission_rates (staff_id);

alter table public.staff_service_commission_rates enable row level security;
