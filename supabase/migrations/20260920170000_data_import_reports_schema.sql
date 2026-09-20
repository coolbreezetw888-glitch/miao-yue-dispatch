-- 模組 12:資料匯入/報表匯出(含產業轉移機制)— 資料層(第一支:schema)。
-- 對應規格書 .project/specs/資料匯入與報表匯出.md §1.1~§1.3、§3.9。
--
-- ⚠️ 實作前查證(見規格書 1.3 警語):已用 docker exec 進本地 supabase_db 容器直接查詢
-- pg_get_constraintdef 確認 bookings.source 目前的完整約束定義為:
--   bookings_source_check: CHECK ((source = ANY (ARRAY['manual'::text, 'smart'::text, 'customer'::text])))
-- 這支 migration 用 DROP CONSTRAINT + ADD CONSTRAINT 的方式擴充成新增 'import' 這個允許值，
-- 不整張表重建，既有資料列(全部是 manual/smart/customer)完全不受影響。

-- =========================================================================
-- 1.1:merchant_bulk_operations(批次操作紀錄)。
-- =========================================================================
create table public.merchant_bulk_operations (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  operation_type text not null
    check (operation_type in ('member_import', 'historical_booking_import', 'industry_transfer_members')),
  write_mode text check (write_mode in ('insert_only', 'upsert_by_phone')),
  related_merchant_id uuid references public.merchants(id) on delete set null,
  status text not null default 'completed' check (status in ('completed', 'rolled_back')),
  total_rows integer not null default 0,
  success_rows integer not null default 0,
  failed_rows integer not null default 0,
  skipped_duplicate_rows integer not null default 0,
  error_report jsonb not null default '[]'::jsonb,
  pre_operation_snapshot jsonb not null default '{}'::jsonb,
  column_mapping jsonb,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  rolled_back_by_user_id uuid references auth.users(id) on delete set null
);

comment on table public.merchant_bulk_operations is '模組 12 §1.1:每一次批次匯入(會員/歷史訂單)或產業轉移操作的執行結果紀錄,是本模組所有危險操作的稽核與復原依據。merchant_id 是這次操作「歸屬」的商家——會員/歷史訂單匯入就是該商家本身;產業轉移則是來源商家(搬出資料的那一方),related_merchant_id 記錄目標商家。';
comment on column public.merchant_bulk_operations.write_mode is '只有 member_import 使用(規則 2.5),其餘類型為 null。';
comment on column public.merchant_bulk_operations.related_merchant_id is '只有 industry_transfer_members 使用,記錄目標商家(搬入資料的那一方)。';
comment on column public.merchant_bulk_operations.skipped_duplicate_rows is 'member_import 在 insert_only 模式下,偵測到電話重複而略過的筆數(規則 2.5)。';
comment on column public.merchant_bulk_operations.error_report is '陣列,每筆 {row_number, raw_data, error_message},記錄失敗的資料列跟原因。';
comment on column public.merchant_bulk_operations.pre_operation_snapshot is '復原所需的「操作前狀態」,結構依 operation_type 不同,詳見規則 2.7。';
comment on column public.merchant_bulk_operations.column_mapping is '這次匯入使用的欄位對應設定,純粹留存供之後追查用,industry_transfer_members 不使用。';

create index merchant_bulk_operations_merchant_id_created_at_idx
  on public.merchant_bulk_operations (merchant_id, created_at);

alter table public.merchant_bulk_operations enable row level security;

create policy merchant_bulk_operations_select on public.merchant_bulk_operations
  for select to authenticated
  using (private.is_merchant_admin(merchant_id));

comment on policy merchant_bulk_operations_select on public.merchant_bulk_operations is '模組 12 §3.9:只有商家管理員能查看這間商家的批次操作歷史。沒有 INSERT/UPDATE/DELETE 政策——一律透過 SECURITY DEFINER 函式寫入(3.1/3.4/3.5/3.6)。';

-- =========================================================================
-- 1.2:merchant_bulk_operation_items(批次操作明細,復原用)。append-only。
-- =========================================================================
create table public.merchant_bulk_operation_items (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references public.merchant_bulk_operations(id) on delete cascade,
  entity_table text not null check (entity_table in ('members', 'bookings', 'member_point_transactions')),
  entity_id uuid not null,
  action text not null check (action in ('created', 'updated')),
  created_at timestamptz not null default now()
);

comment on table public.merchant_bulk_operation_items is '模組 12 §1.2:記錄某個批次實際動到哪些資料列,是一鍵復原能精準只還原這個批次動過的資料、不影響其他資料的關鍵依據。append-only,沒有 UPDATE/DELETE 政策,復原時的判斷邏輯是額外查詢對應的資料表本身，不是修改這張表。';

create index merchant_bulk_operation_items_operation_id_idx
  on public.merchant_bulk_operation_items (operation_id);

alter table public.merchant_bulk_operation_items enable row level security;

create policy merchant_bulk_operation_items_select on public.merchant_bulk_operation_items
  for select to authenticated
  using (
    private.is_merchant_admin((
      select merchant_id from public.merchant_bulk_operations where id = operation_id
    ))
  );

comment on policy merchant_bulk_operation_items_select on public.merchant_bulk_operation_items is '模組 12 §3.9:只有商家管理員能查看對應批次的明細。沒有 INSERT/UPDATE/DELETE 政策。';

-- =========================================================================
-- 1.3:bookings 擴充——歷史訂單匯入專用欄位(擴充模組 5/6 既有表，不新建表)。
-- =========================================================================
alter table public.bookings
  add column service_description_snapshot text;

comment on column public.bookings.service_description_snapshot is '模組 12 §1.3:歷史訂單匯入專用的服務內容自由文字說明。一般透過 create_booking/update_booking 建立的訂單這個欄位永遠是 null。詳情頁顯示邏輯:有 booking_service_items 就照既有方式顯示逐項清單;沒有但這個欄位有值,顯示這段文字(並標註「歷史匯入紀錄」)。';

alter table public.bookings drop constraint bookings_source_check;
alter table public.bookings add constraint bookings_source_check
  check (source in ('manual', 'smart', 'customer', 'import'));

comment on column public.bookings.source is '模組 12 §1.3 擴充:新增 import(歷史訂單匯入)。manual(手動建單)/smart/customer 是既有值;import 一律由 import_historical_bookings_batch 寫入，方便之後任何報表/畫面辨識「這是匯入的歷史紀錄，不是這次系統上線後真正發生的訂單」。';
