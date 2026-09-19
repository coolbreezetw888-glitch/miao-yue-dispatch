-- 模組 8:薪資與帳務 — 資料層(第一支:schema)。
-- 對應規格書 .project/specs/薪資與帳務.md §1.1~§1.5。
--
-- 財務謹慎設計(規格書第〇節開頭原則,務必嚴格遵守):`default_commission_rate_percentage`
-- 預設 0(不是任何非零數字)、`leave_type_deduction_rules` 預設 `no_deduction`——這是刻意的設計,
-- 避免在商家還沒設定前就默默套用一個算是憑空生成的比例/金額算給服務人員。

-- =========================================================================
-- 1.1:merchant_payroll_settings(商家層級薪資設定,一商家一列)。
-- 完全比照 merchant_tax_settings(模組 6)的既有設計語言:一商家一列,查無資料時前端/後端
-- 一律套用預設值,沒有 DELETE 政策(查無資料本身就等同「還沒特別設定,套用預設值」)。
-- =========================================================================
create table public.merchant_payroll_settings (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  commission_basis_type text not null default 'gross'
    check (commission_basis_type in ('gross', 'net_of_material_cost')),
  default_commission_rate_percentage numeric(5, 2) not null default 0
    check (default_commission_rate_percentage between 0 and 100),
  pay_days_per_month integer not null default 30
    check (pay_days_per_month between 1 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_payroll_settings is '商家層級薪資設定(模組 8 薪資與帳務 §1.1):一商家一列,查無資料時前端/後端一律套用預設值(commission_basis_type=gross、default_commission_rate_percentage=0、pay_days_per_month=30)。default_commission_rate_percentage 預設 0 是刻意的(第〇節開頭原則)——0% 代表「還沒設定」,不會在商家還沒填任何數字之前,就默默套用一個算是憑空生成的比例算給服務人員。RLS 要求 private.can_manage_commission_settings(merchant_id),沒有 DELETE 政策。';
comment on column public.merchant_payroll_settings.commission_basis_type is '抽成計算基準(判斷 1):gross(服務金額全額,已排除稅金)或 net_of_material_cost(再扣除該筆訂單的料錢成本)。預設 gross——風險最低的預設,不會無故讓抽成基準比商家原本認知的更低(規格書第〇節判斷 1 理由)。';
comment on column public.merchant_payroll_settings.default_commission_rate_percentage is '按件計酬服務人員沒有個別設定 staff_commission_rates 時套用的商家預設抽成比例。預設 0(第〇節開頭原則,不預設任何非零數值)。';
comment on column public.merchant_payroll_settings.pay_days_per_month is '把月薪換算成「一天薪水」時使用的除數(判斷 3),供假別扣款公式的 full_day_rate/percentage_of_day_rate 兩種模式使用。預設 30(台灣勞動慣例常見的月薪折算天數),請主腦跟使用者確認是否符合舊系統實際做法。';

create trigger merchant_payroll_settings_set_updated_at
  before update on public.merchant_payroll_settings
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.2:staff_commission_rates(按件計酬服務人員個人抽成比例覆寫)。
-- 只能替 compensation_type='piece_rate' 的服務人員建立這筆覆寫——這是跨表判斷,CHECK 約束做不到,
-- 落實在 RLS 的 WITH CHECK(見下一支 migration §3.3)。
-- =========================================================================
create table public.staff_commission_rates (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade unique,
  rate_percentage numeric(5, 2) not null check (rate_percentage between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.staff_commission_rates is '針對單一按件計酬服務人員設定的個人抽成比例覆寫(模組 8 §1.2),一人一筆(unique staff_id)。沒有設定的人套用 merchant_payroll_settings.default_commission_rate_percentage。只能替 compensation_type=piece_rate 的服務人員建立(RLS WITH CHECK,§3.3),不是資料庫 CHECK 約束(需要 join 另一張表判斷)。允許 DELETE——移除個人覆寫、恢復套用商家預設值,這不是危險操作(規則 2.10)。';

create trigger staff_commission_rates_set_updated_at
  before update on public.staff_commission_rates
  for each row execute function public.set_updated_at();

create index staff_commission_rates_staff_id_idx on public.staff_commission_rates (staff_id);

-- =========================================================================
-- 1.3:staff_salary_settings(月薪制服務人員薪資設定)。
-- 只能替 compensation_type='monthly_salary' 的服務人員建立(RLS WITH CHECK,§3.4)。
-- =========================================================================
create table public.staff_salary_settings (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade unique,
  monthly_base_salary numeric(10, 2) not null default 0 check (monthly_base_salary >= 0),
  monthly_leave_quota_days numeric(4, 1) check (monthly_leave_quota_days >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.staff_salary_settings is '月薪制服務人員的月薪與月休天數參考值(模組 8 §1.3),一人一筆(unique staff_id)。monthly_leave_quota_days 純參考用,不牽動扣款計算(判斷 4)——實際扣多少錢完全由 leave_type_deduction_rules 的假別扣款公式決定,兩者不互相影響。只能替 compensation_type=monthly_salary 的服務人員建立(RLS WITH CHECK,§3.4)。沒有 DELETE 政策(月薪本來就是每個月薪制服務人員必填的資訊,提供「編輯」就夠)。';
comment on column public.staff_salary_settings.monthly_leave_quota_days is '月休天數,純參考用,不牽動扣款計算(判斷 4)。支援半天單位(如 0.5)是為未來擴充留空間,這次的請假紀錄本身只支援整天,不影響。';

create trigger staff_salary_settings_set_updated_at
  before update on public.staff_salary_settings
  for each row execute function public.set_updated_at();

create index staff_salary_settings_staff_id_idx on public.staff_salary_settings (staff_id);

-- =========================================================================
-- 1.4:leave_type_deduction_rules(假別扣款規則)。
-- 用 cascade 是刻意的(跟模組 7 staff_leave_records.leave_type_id 不用 cascade 的精神不同)——
-- 扣款規則本身是假別的附屬設定,假別真的被硬刪除(目前系統沒有任何路徑會這樣做,只有軟刪除)時,
-- 規則沒有繼續存在的意義。
-- =========================================================================
create table public.leave_type_deduction_rules (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  leave_type_id uuid not null references public.merchant_leave_types(id) on delete cascade unique,
  deduction_mode text not null default 'no_deduction'
    check (deduction_mode in ('no_deduction', 'full_day_rate', 'percentage_of_day_rate', 'fixed_amount_per_day')),
  percentage_value numeric(5, 2) check (percentage_value between 0 and 100),
  fixed_amount_value numeric(10, 2) check (fixed_amount_value >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leave_type_deduction_rules_mode_values_required check (
    (deduction_mode <> 'percentage_of_day_rate' or percentage_value is not null)
    and (deduction_mode <> 'fixed_amount_per_day' or fixed_amount_value is not null)
  )
);

comment on table public.leave_type_deduction_rules is '針對模組 7 每一個假別,設定請這個假的扣款計算模式與數值(模組 8 §1.4),一個假別一筆(unique leave_type_id,on delete cascade——假別是這個規則的擁有者,假別被硬刪除規則就沒有存在意義)。新假別預設沒有這張表的資料列,查無資料一律視為 deduction_mode=no_deduction(不扣款)——理由見判斷 3 開頭原則,不預設任何假別要扣款,商家要扣款要自己明確設定。deduction_mode=percentage_of_day_rate 時 percentage_value 必填、deduction_mode=fixed_amount_per_day 時 fixed_amount_value 必填,由 CHECK 約束在資料庫層面強制(不只靠前端表單驗證)。merchant_id 冗餘存一份,方便 RLS/索引直接用,不用每次 join merchant_leave_types 才能拿到 merchant_id(比照模組 7 staff_leave_records 冗餘設計精神)。沒有 DELETE 政策(查無資料視為 no_deduction,足以表達「這個假別不扣款」)。';
comment on column public.leave_type_deduction_rules.deduction_mode is '四選一(規則 2.7):no_deduction(不扣款)/full_day_rate(扣一天全薪)/percentage_of_day_rate(扣一天薪水的某個百分比)/fixed_amount_per_day(扣固定金額)。哪個假別套用哪個模式、數值填多少,一律由商家自行輸入,系統不提供任何預設非零數值。';

create trigger leave_type_deduction_rules_set_updated_at
  before update on public.leave_type_deduction_rules
  for each row execute function public.set_updated_at();

create index leave_type_deduction_rules_merchant_id_idx on public.leave_type_deduction_rules (merchant_id);

-- =========================================================================
-- 1.5:booking_commission_records(抽成快照紀錄)。
--
-- ⚠️ 跟規格書原文有一處內部矛盾,這裡採用能落實規格書「保留歷史金額紀錄」意圖的寫法(已在
-- 主腦回報時提出待確認):規格書原文 staff_id 欄位同時寫「not null」跟「on delete set null」,
-- 兩者互斥(NOT NULL 欄位不可能被 ON DELETE SET NULL 觸發)。這裡採用「staff_id 可為 null、
-- on delete set null」——因為規格書明確的意圖是「服務人員真的被硬刪除的極端情況,保留這筆歷史
-- 金額紀錄但不再指向特定的人」,這個意圖只有在欄位可為 null 時才能真正落實。
-- =========================================================================
create table public.booking_commission_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade unique,
  staff_id uuid references public.merchant_staff(id) on delete set null,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  commission_basis_type_snapshot text not null
    check (commission_basis_type_snapshot in ('gross', 'net_of_material_cost')),
  commission_base_amount_snapshot numeric(10, 2) not null,
  material_cost_deducted_snapshot numeric(10, 2) not null default 0,
  commission_rate_percentage_snapshot numeric(5, 2) not null
    check (commission_rate_percentage_snapshot between 0 and 100),
  commission_amount numeric(10, 2) not null check (commission_amount >= 0),
  computed_at timestamptz not null default now(),
  recalculated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_commission_records_gross_no_material_deduction check (
    commission_basis_type_snapshot <> 'gross' or material_cost_deducted_snapshot = 0
  )
);

comment on table public.booking_commission_records is '某一筆已完成訂單,主要服務人員實際賺到多少抽成的永久紀錄(模組 8 §1.5)。建立當下寫死計算基準/比例/金額,之後設定異動不影響已經產生的紀錄(規則 2.4,核心規則)——只在 complete_booking() 首次完成訂單時由 compute_booking_commission 寫入一次,唯一能改變既有紀錄的路徑是 recalculate_booking_commission(管理員專屬,§3.8)。只有按件計酬服務人員(compensation_type=piece_rate)才會有這張表的紀錄,月薪制服務人員完全不進這張表。merchant_id 冗餘存一份供 RLS/索引直接使用。staff_id 不用 cascade delete(服務人員被移除是軟刪除,不會觸發這裡;真的被硬刪除的極端情況,on delete set null,保留這筆歷史金額紀錄但不再指向特定的人——見上方 migration 註解,這裡跟規格書原文「not null」的文字有出入,是刻意的修正,已在回報時提出)。沒有 INSERT/UPDATE/DELETE 政策,一律透過 compute_booking_commission(內部)/recalculate_booking_commission 寫入。';
comment on column public.booking_commission_records.material_cost_deducted_snapshot is 'commission_basis_type_snapshot=net_of_material_cost 時,實際扣除的料錢成本總額;gross 時固定 0(方便報表統一顯示「有無扣除成本」),由 CHECK 約束強制。';
comment on column public.booking_commission_records.recalculated_at is 'recalculate_booking_commission(§3.8)手動重算過才有值,沒有值代表這是原始計算結果,方便報表/稽核一眼看出這筆是否被人工調整過。';

create trigger booking_commission_records_set_updated_at
  before update on public.booking_commission_records
  for each row execute function public.set_updated_at();

create index booking_commission_records_staff_id_idx on public.booking_commission_records (staff_id);
create index booking_commission_records_merchant_id_computed_at_idx
  on public.booking_commission_records (merchant_id, computed_at);
