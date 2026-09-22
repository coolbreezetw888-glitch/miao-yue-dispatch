-- 商家端三項調整規格書 §二 2.2.3/2.2.4。

-- 2.2.3:commission_rate_percentage_snapshot 不再是「單一比例」,改成 nullable。
-- 舊資料維持原值不變;改版之後新產生的紀錄一律寫 null,實際明細改看下面的新表。
alter table public.booking_commission_records
  alter column commission_rate_percentage_snapshot drop not null;

-- 2.2.4:抽成明細,附屬在彙總紀錄底下。
create table public.booking_commission_item_records (
  id uuid primary key default gen_random_uuid(),
  commission_record_id uuid not null references public.booking_commission_records(id) on delete cascade,
  booking_service_item_id uuid not null references public.booking_service_items(id),
  service_item_name_snapshot text not null,
  quantity_snapshot integer not null check (quantity_snapshot >= 1),
  commission_mode_snapshot text not null check (commission_mode_snapshot in ('percentage', 'fixed_amount')),
  commission_value_snapshot numeric(10, 2) not null,
  commission_base_amount_snapshot numeric(10, 2) not null default 0,
  commission_amount numeric(10, 2) not null check (commission_amount >= 0),
  created_at timestamptz not null default now()
);

comment on table public.booking_commission_item_records is '某筆已完成訂單,單一服務項目的抽成計算明細(需求2、決策8),附屬在 booking_commission_records(彙總紀錄)底下,on delete cascade。service_item_name_snapshot 是計算當下的服務項目名稱快照(比照本專案一貫的快照原則),之後服務項目改名不影響這裡的顯示。commission_mode_snapshot=fixed_amount 時 commission_base_amount_snapshot 固定為 0(固定金額模式的抽成不看基準,只看數量,見規則2.4)。只能透過 compute_booking_commission/recalculate_booking_commission 內部寫入,沒有 INSERT/UPDATE/DELETE 政策(RLS 只開放 SELECT)。';

create index booking_commission_item_records_commission_record_id_idx
  on public.booking_commission_item_records (commission_record_id);

alter table public.booking_commission_item_records enable row level security;
