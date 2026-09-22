-- 模組 8(薪資與帳務)規格書 §十一 11.1(SPECS-INDEX #622):新增合併型「生效區間」歷史表
-- staff_payroll_status_history,記錄每位服務人員的 compensation_type/status/monthly_base_salary
-- 三個欄位隨時間變動的完整歷史,供 11.5~11.8 的「查某個時間點的狀態」還原邏輯使用。
--
-- 設計原則(§11.0):三個欄位合併成一張表,不是三張分開的歷史表——任何一個欄位變動就結算舊區間、
-- 開一筆新區間,查詢時只需要一次就拿到當下三個欄位的完整組合,不用處理三條獨立時間軸互相對齊的
-- 問題。這張表完全透過 11.2 的觸發器(SECURITY DEFINER)寫入,沒有 INSERT/UPDATE/DELETE 政策,
-- 比照 booking_commission_records(20260920120000_payroll_billing_schema.sql §1.5)既有的「只能
-- 透過內部函式寫入」設計慣例。

create table public.staff_payroll_status_history (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  compensation_type text not null check (compensation_type in ('monthly_salary', 'piece_rate')),
  status text not null check (status in ('active', 'removed')),
  monthly_base_salary numeric(10, 2) not null default 0,
  -- 預設值用 clock_timestamp() 不是 now()(理由見 11.2 sync_staff_payroll_status_history 函式的
  -- v_now 變數註解):實際寫入一律由該函式明確帶入 effective_from,這裡的預設值只是防禦性欄位
  -- 定義,維持跟函式邏輯一致的時間語意。
  effective_from timestamptz not null default clock_timestamp(),
  effective_to timestamptz,
  is_backfill_seed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint staff_payroll_status_history_effective_range_check
    check (effective_to is null or effective_to > effective_from)
);

comment on table public.staff_payroll_status_history is '模組 8 §11.1:服務人員薪資/身份變動歷史紀錄(合併型生效區間表)。記錄 merchant_staff.compensation_type/status、staff_salary_settings.monthly_base_salary 三個欄位隨時間變動的完整歷史,effective_to is null 代表目前生效中的一筆。is_backfill_seed=true 只有機制上線當下(11.3)一次性回填的種子紀錄才會是 true,之後任何正常異動一律 false,供 11.5 的估算邏輯分辨「上線前就存在只是沒有更早歷史」跟「上線後才加入商家」兩種情況。完全透過 11.2 的觸發器(SECURITY DEFINER)寫入,沒有 INSERT/UPDATE/DELETE 政策。';
comment on column public.staff_payroll_status_history.is_backfill_seed is '§11.0 第 3 點:只有機制上線當下一次性回填(11.3)的起始紀錄是 true,之後任何正常異動(11.2 觸發器產生)一律 false。';
comment on column public.staff_payroll_status_history.effective_to is 'NULL 代表這是目前生效中的一筆,任何時刻每位服務人員最多只有一筆(見下方 partial unique index)。';

-- 保證每位服務人員任何時刻最多只有一筆「目前生效中」的紀錄。
create unique index staff_payroll_status_history_current_uidx
  on public.staff_payroll_status_history (staff_id)
  where effective_to is null;

-- 供「查詢某個時間點 T 落在哪一個區間」使用(11.5)。
create index staff_payroll_status_history_staff_range_idx
  on public.staff_payroll_status_history (staff_id, effective_from, effective_to);

-- RLS:只開放 SELECT,要求 private.can_view_payroll_reports(merchant_id)(模組 8 §3.1 既有函式)。
-- 沒有 INSERT/UPDATE/DELETE 政策——一律透過 11.2 的觸發器(SECURITY DEFINER)寫入。
alter table public.staff_payroll_status_history enable row level security;

create policy staff_payroll_status_history_select on public.staff_payroll_status_history
  for select to authenticated
  using (private.can_view_payroll_reports(merchant_id));
