-- 模組 6(訂單管理)§9.1(SPECS-INDEX #597):預約詳情補「操作記錄」按鈕。
-- 新增 booking_status_change_logs(append-only,沒有 UPDATE/DELETE 政策,比照
-- member_point_transactions/booking_commission_records 分類帳的既有設計精神)。
-- 這裡只建表 + RLS,寫入邏輯(疊加 create_booking/confirm_booking/cancel_booking/
-- complete_booking)、查詢函式 get_booking_status_change_logs 放在下一支 migration。

create table public.booking_status_change_logs (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  -- merchant_id 冗餘存一份,方便 RLS/索引直接用(比照 booking_commission_records.merchant_id/
  -- member_point_transactions.merchant_id 的既有設計精神)。
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  -- 建立訂單當下這一筆的 from_status 為 null,代表「建立」這個動作本身。
  from_status text,
  to_status text not null,
  actor_user_id uuid references auth.users(id) on delete set null,
  -- 操作者姓名快照,對方之後改名/被移除都不影響歷史紀錄的可讀性(比照本專案一路以來
  -- 「操作者/客戶名稱一律快照」的既有慣例)。
  actor_name_snapshot text not null,
  actor_role_snapshot text not null
    check (actor_role_snapshot in ('merchant_admin', 'agent', 'staff', 'system')),
  -- 選填的操作備註,這次先不開放使用者輸入,欄位保留給未來擴充。
  note text,
  created_at timestamptz not null default now()
);

comment on table public.booking_status_change_logs is '模組 6 §9.1(SPECS-INDEX #597):某筆訂單每一次狀態變更的永久明細紀錄,append-only,沒有 UPDATE/DELETE 政策——寫錯了不能修改/刪除原本那筆(比照 member_point_transactions/booking_commission_records 分類帳的既有設計精神)。這張表只記錄「狀態」的變化,不是所有欄位變更的完整稽核軌跡(範圍界定,避免過度設計)。';
comment on column public.booking_status_change_logs.from_status is '建立訂單當下這一筆的 from_status 為 null,代表「建立」這個動作本身。';
comment on column public.booking_status_change_logs.actor_name_snapshot is '操作者姓名快照,對方之後改名/被移除都不影響歷史紀錄的可讀性(比照本專案一路以來「操作者/客戶名稱一律快照」的既有慣例)。';
comment on column public.booking_status_change_logs.actor_role_snapshot is '這次操作者身份涵蓋商家管理員/客服(merchant_admin/agent)。staff 保留給之後如果開放服務人員自主操作訂單時使用(對應 ARCHITECTURE.md 第十節第 14 點的既有掛勾點),這次寫入邏輯不會產生 staff 值。system 保留給之後如果有系統自動觸發的狀態轉換,這次沒有任何路徑會寫入這個值。';
comment on column public.booking_status_change_logs.note is '選填的操作備註,這次先不開放使用者輸入,欄位保留給未來擴充。';

create index booking_status_change_logs_booking_id_created_at_idx
  on public.booking_status_change_logs (booking_id, created_at);
create index booking_status_change_logs_merchant_id_created_at_idx
  on public.booking_status_change_logs (merchant_id, created_at);

alter table public.booking_status_change_logs enable row level security;

-- 只有 SELECT 政策,權限比照檢視訂單本身的邊界(private.can_manage_bookings,即 orders
-- section_key):管理員永遠可以,被授權 orders 的客服也可以。沒有 INSERT/UPDATE/DELETE 政策——
-- 寫入只透過下一支 migration 的 SECURITY DEFINER 函式(疊加在 create_booking/confirm_booking/
-- cancel_booking/complete_booking 內部呼叫),不開放任何角色直接對這張表下 INSERT/UPDATE/DELETE
-- (比照 member_point_transactions 只有 SELECT 政策的既有做法)。
create policy booking_status_change_logs_select on public.booking_status_change_logs
  for select to authenticated
  using (private.can_manage_bookings(merchant_id));
