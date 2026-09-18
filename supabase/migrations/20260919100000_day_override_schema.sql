-- 模組 6:訂單管理(第二批)— 單日例外(開啟/關閉時段)資料表。
-- 對應規格書 §5.1:staff_availability_overrides,半小時格線,只影響「特定那一天」,
-- 疊加在模組 5「商家整體營業時間(第一層)∩ 服務人員每週時段(第二層)」交集判斷之上的第三層。
--
-- **重蹈覆轍風險提醒(這批任務主腦特別交辦)**:這是本次唯一會動到模組 5 排程核心驗證邏輯的異動,
-- 這份 migration 只負責「資料表本身」,先不碰 private.check_staff_booking_slot——依照規格書 §5.3
-- 第 4 點與建議實作順序第 3 點的要求,第三層邏輯要等 pgTAP 先驗證過「無例外時逐格判斷與既有整段
-- 判斷結果完全等價」這個安全網之後,才能正式接進 create_booking/update_booking。

create table public.staff_availability_overrides (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  override_date date not null,
  -- 半小時格線的起點(例如 14:00:00、14:30:00),CHECK 約束強制對齊半小時格線。
  slot_start_time time not null,
  -- true = 這半小時被臨時開啟為可預約(平常公休/沒排時段的那天臨時加班);
  -- false = 這半小時被臨時關閉、不可預約(師傅臨時請假)。
  is_available boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_availability_overrides_half_hour_check check (
    extract(minute from slot_start_time)::int in (0, 30)
    and extract(second from slot_start_time) = 0
  ),
  -- 同一位服務人員同一天同一個半小時格子,只會有一筆例外設定,重複設定時用 upsert 覆蓋舊值。
  constraint staff_availability_overrides_unique unique (staff_id, override_date, slot_start_time)
);

comment on table public.staff_availability_overrides is '對應規格書 §5.1:單日例外(開啟/關閉時段),半小時為單位,只影響服務人員「特定那一天」的可預約狀態,不改動每週固定的 staff_availability_windows 模板。是疊加在模組 5 商家整體營業時間∩服務人員每週時段交集判斷之上的第三層(§5.3),第三層優先權高於前兩層,但低於 unlimited_backend_edit 覆寫例外。一律透過 set_staff_day_override/clear_staff_day_override 這兩支 SECURITY DEFINER 函式寫入,不開放前端直接 INSERT/UPDATE/DELETE(比照 booking_service_items 等關聯表的既有模式)。';

create index staff_availability_overrides_staff_date_idx
  on public.staff_availability_overrides (staff_id, override_date);

-- =========================================================================
-- RLS:歸在 business_hours(§5.4),不是 orders——這本質上是「排程規則設定」性質的操作。
-- 只開 SELECT 政策(比照 booking_service_items/booking_assistants/booking_material_costs 的既有
-- 模式),沒有 staff_availability_overrides 自己的 merchant_id 欄位,沿用既有的
-- private.staff_merchant_id(staff_id) 輔助函式取得 merchant_id 再判斷
-- private.can_manage_business_hours(比照 staff_availability_windows 的既有 RLS 寫法)。
-- 沒有 INSERT/UPDATE/DELETE 政策——一律透過 set_staff_day_override/clear_staff_day_override
-- 這兩支 SECURITY DEFINER 函式寫入,避免前端繞過半小時對齊驗證/既有預約衝突筆數回報邏輯直接寫表。
-- =========================================================================
alter table public.staff_availability_overrides enable row level security;

create policy staff_availability_overrides_select on public.staff_availability_overrides
  for select to authenticated
  using (private.can_manage_business_hours(private.staff_merchant_id(staff_id)));
