-- 模組 5:行事曆與預約核心引擎(資料層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\行事曆與預約核心引擎.md
-- 這支 migration 對應規格書第一節 1.1(merchant_business_hours)、1.2(staff_availability_windows)、
-- 1.3(bookings,模組 5/6 共用的預約/訂單單一真相來源)。1.4(merchant_feature_flags 補 UPDATE 政策)
-- 放在下一支 migration(20260916140100)跟功能層一起處理,因為那是政策不是資料表結構。

-- =========================================================================
-- 1.1 merchant_business_hours(商家整體營業時間)— 第一層邊界
-- 新商家不自動塞入任何預設列(規格書 1.1 邊界情況):一列都沒有時,規則 2.1 定義為「這天不可預約」。
-- 這次只支援一天一組時段(不支援午休式多時段),見規格書第七節「module-planner 自行定案」6。
-- =========================================================================
create table public.merchant_business_hours (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  is_closed boolean not null default false,
  open_time time,
  close_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, day_of_week),
  constraint merchant_business_hours_time_shape check (
    (is_closed and open_time is null and close_time is null)
    or (not is_closed and open_time is not null and close_time is not null and open_time < close_time)
  )
);

comment on table public.merchant_business_hours is '商家整體營業時間(對應規格書 1.1),預約系統的最外層邊界(第一層,規則 2.1)。0 代表星期日。新商家不會自動塞入任何一列,查無當天設定一律視為公休/不可預約。這次只支援一天一組時段,不支援跨午夜/一天多時段。';
comment on column public.merchant_business_hours.day_of_week is '0=星期日,1=星期一,...,6=星期六,跟 Postgres extract(dow from ...) 的回傳值一致。';

create trigger merchant_business_hours_set_updated_at
  before update on public.merchant_business_hours
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.2 staff_availability_windows(服務人員個別可預約時段)— 第二層邊界
-- 允許同一天多組時段(例如只想接「10:00-12:00」跟「15:00-18:00」),跟 1.1 刻意不同。
-- 空狀態規則(規則 2.5):完全沒有任何一筆,且 merchant_staff.no_time_slot_limit = false 時,
-- 視為「這個人這次還不可預約」——這條規則在 create_booking(3.3)裡判斷,這張表本身不需要特別欄位。
-- =========================================================================
create table public.staff_availability_windows (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, day_of_week, start_time, end_time),
  constraint staff_availability_windows_time_order check (end_time > start_time)
);

comment on table public.staff_availability_windows is '服務人員個別可預約時段(對應規格書 1.2),預約系統的第二層邊界(規則 2.2)。允許同一天有多組時段。完全沒有任何一筆、且該服務人員 no_time_slot_limit=false 時,視為「這次還不可預約」(規則 2.5),需管理員主動設定或開啟 no_time_slot_limit,不是靠「忘記設定」意外達到相同效果。';

create trigger staff_availability_windows_set_updated_at
  before update on public.staff_availability_windows
  for each row execute function public.set_updated_at();

create index staff_availability_windows_staff_day_idx
  on public.staff_availability_windows (staff_id, day_of_week);

-- =========================================================================
-- 1.3 bookings(預約/訂單共用資料表)—— 本次規劃的核心架構決定
-- 模組 5(行事曆)跟未來模組 6(訂單管理)共用同一張表,不是兩張各自獨立、事後同步的表
-- (2026-09-16 使用者明確確認,見規格書 1.3)。模組 5 這次只使用排程相關欄位跟功能;
-- 模組 6 之後直接 ALTER TABLE 補上金額/付款/紅利點數等欄位,不建第二張表、不做同步機制。
--
-- 六個狀態值(規則 2.9)這次全部定義進 CHECK 約束,但這次只會真的用到
-- accepted/completed/cancelled 三種——其餘三種(pending_reply/pending_confirmation/dispatching)
-- 是預留給未來智慧建單/客戶自助預約/派工流程,這次不會被任何函式觸發。
--
-- 不使用 EXCLUDE USING gist 範圍互斥約束擋雙重預約(規格書 1.3 邊界情況)——因為規則 2.4
-- 「嚴格工時衝突檢查」開關關閉時必須允許重疊,衝突檢查邏輯全部放在 create_booking(3.3)裡判斷,
-- 不能用一個資料庫層級的硬約束一律擋下。
-- =========================================================================
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  staff_id uuid not null references public.merchant_staff(id),
  service_item_id uuid not null references public.service_items(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  customer_name text not null,
  customer_phone text not null,
  customer_email text,
  notes text,
  source text not null default 'manual' check (source in ('manual', 'smart', 'customer')),
  created_by_role text not null check (created_by_role in ('admin', 'agent', 'customer')),
  created_by_user_id uuid references auth.users(id) on delete set null,
  status text not null default 'accepted' check (
    status in (
      'pending_reply',
      'pending_confirmation',
      'dispatching',
      'accepted',
      'completed',
      'cancelled'
    )
  ),
  cancelled_at timestamptz,
  cancelled_reason text,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bookings_end_after_start check (end_at >= start_at)
);

comment on table public.bookings is
  '預約/訂單共用資料表(對應模組5規格書 1.3)。模組5負責排程相關欄位跟功能(時段/服務人員/服務項目/狀態機基礎);
   模組6(訂單管理)之後直接在這張表新增金額/付款狀態/紅利點數等業務欄位,並做清單/篩選 UI,
   不建第二張表、不做同步機制——這是2026-09-16使用者明確確認的架構決定,理由見模組5規格書 1.3。';

comment on column public.bookings.end_at is '建立當下依 service_items.duration_minutes 快照計算寫死,之後服務項目工時異動不會回頭影響已建立的預約。';
comment on column public.bookings.source is '這次只會寫入 manual(手動建單)。smart/customer 是給之後智慧建單、模組 13 客戶端自助預約使用的預留值,現在不會被觸發。';
comment on column public.bookings.status is '狀態機(規則 2.9):pending_reply(待回覆)/pending_confirmation(待確認)/dispatching(派單中)/accepted(已接受)/completed(已完成)/cancelled(已取消)。這次手動建單一律直接進 accepted,只會實際發生 accepted -> completed / accepted -> cancelled 兩種轉換,其餘狀態值只是預留給未來模組的 CHECK 約束骨架,不會被本模組觸發。completed/cancelled 都是終止狀態,不能再轉換。';
comment on column public.bookings.created_by_role is '這次只會是 admin/agent(手動建單者的角色)。customer 是預留給模組 13 客戶自助預約使用。';

create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

create index bookings_staff_id_start_at_idx on public.bookings (staff_id, start_at);
create index bookings_merchant_id_start_at_idx on public.bookings (merchant_id, start_at);
