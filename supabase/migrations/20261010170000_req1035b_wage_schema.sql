-- SPECS-INDEX #1035 彈性計薪 B 批(日薪／時薪制)— migration 1:資料(PB-D01~D04)
-- 規格書:母版 .project/specs/彈性計薪.md 第三節 PB-D、第四節 PX-01。
--
--   PB-D01  merchant_staff / staff_payroll_status_history 的 compensation_type 多兩個值 daily_wage、hourly_wage
--   PB-D02  staff_wage_settings(日薪 = 元/天;時薪 = 元/小時;單位由計酬類型決定)
--   PB-D03  staff_payroll_status_history.wage_amount
--           + private.sync_staff_payroll_status_history 多比 wage_amount
--           + private.get_staff_payroll_status_as_of 多回 wage_amount(回傳型別改變 ⇒ drop + create)
--   PB-D04  staff_work_day_records(每天凍結的上工紀錄)
--
-- 🔴 新表:RLS 開、0 policy、revoke all from anon, authenticated —— 只走 SECURITY DEFINER 函式
--    (migration 2:20261010170100_req1035b_wage_functions.sql)。
-- 🔴 改寫既有函式一律以 A 批上線後的版本為底(20261010160000_req1035a_bonus_plans_schema.sql),只動必要段:
--    sync_staff_payroll_status_history ← 指紋 d3d5655e(正式庫 = 本機)
--    get_staff_payroll_status_as_of    ← 指紋 916323b0(正式庫 = 本機)

-- =========================================================================
-- PB-D01 計酬類型擴充(drop + add,原兩個值逐字保留;預設值不變 = piece_rate)
--   動手前核對:現有值只能是 monthly_salary / piece_rate(正式庫 2026-10-09 唯讀核對:merchant_staff
--   月薪 40 / 抽成 271;歷史 月薪 109 / 抽成 530,沒有其他值)。這裡再擋一次,萬一有其他值就整批停下。
-- =========================================================================
do $$
begin
  if exists (select 1 from public.merchant_staff where compensation_type not in ('monthly_salary', 'piece_rate'))
     or exists (select 1 from public.staff_payroll_status_history where compensation_type not in ('monthly_salary', 'piece_rate')) then
    raise exception '#1035 B 批:compensation_type 出現預期外的值，停止 migration。';
  end if;
end;
$$;

alter table public.merchant_staff drop constraint merchant_staff_compensation_type_check;
alter table public.merchant_staff add constraint merchant_staff_compensation_type_check
  check (compensation_type = any (array['monthly_salary'::text, 'piece_rate'::text, 'daily_wage'::text, 'hourly_wage'::text]));

alter table public.staff_payroll_status_history drop constraint staff_payroll_status_history_compensation_type_check;
alter table public.staff_payroll_status_history add constraint staff_payroll_status_history_compensation_type_check
  check (compensation_type = any (array['monthly_salary'::text, 'piece_rate'::text, 'daily_wage'::text, 'hourly_wage'::text]));

-- =========================================================================
-- PB-D02 費率設定(一人一列;0 policy,只走 public.set_staff_wage)
-- =========================================================================
create table public.staff_wage_settings (
  staff_id uuid primary key references public.merchant_staff (id) on delete cascade,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  wage_amount numeric(10, 2) not null check (wage_amount between 0 and 1000000),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_wage_settings_merchant_idx on public.staff_wage_settings (merchant_id);

alter table public.staff_wage_settings enable row level security;
revoke all on table public.staff_wage_settings from anon, authenticated;

-- =========================================================================
-- PB-D03-1 歷史欄位(既有列 = null;sync 比對時 null 視同 0,不會因為這次加欄位替每個人多開一列)
-- =========================================================================
alter table public.staff_payroll_status_history add column wage_amount numeric(10, 2) null;

-- =========================================================================
-- PB-D03-2 private.sync_staff_payroll_status_history 改版
--   改前本體 = 20261010160000_req1035a_bonus_plans_schema.sql(逐字),只動四處(標「#1035 B 批」):
--     ① declare 多兩個變數 v_wage_amount / v_current_wage_amount
--     ② 多讀 staff_wage_settings.wage_amount(沒有列 ⇒ 0)
--     ③「值不同才開新一列」多比 wage_amount(既有列是 null ⇒ 比對時當 0)
--     ④ insert 多寫 wage_amount
-- =========================================================================
create or replace function private.sync_staff_payroll_status_history(
  p_staff_id uuid,
  p_is_backfill_seed boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_compensation_type text;
  v_status text;
  v_monthly_base_salary numeric(10, 2);
  v_bonus_plan_id uuid;
  v_wage_amount numeric(10, 2);  -- #1035 B 批
  v_current_id uuid;
  v_current_compensation_type text;
  v_current_status text;
  v_current_monthly_base_salary numeric(10, 2);
  v_current_bonus_plan_id uuid;
  v_current_wage_amount numeric(10, 2);  -- #1035 B 批
  -- ⚠️ 用 clock_timestamp()(每次呼叫都會前進的實際時鐘時間),不能用 now()/transaction_timestamp()
  -- ——PL/pgSQL 裡的 now() 在同一個 transaction 內永遠回傳同一個值(transaction 開始的那一刻),
  -- 如果同一個 transaction 內這支函式被呼叫兩次以上(例如同一批 SQL script 先新增服務人員、
  -- 緊接著又設定月薪,這在 pgTAP 測試 fixture 很常見,也不排除未來某個批次流程把多個異動包在同一個
  -- transaction 裡),第二次呼叫要結算「第一次呼叫剛建立」的那筆舊紀錄時,new effective_to 會等於
  -- 那筆舊紀錄自己的 effective_from(同一個 now() 值),違反 CHECK(effective_to > effective_from)。
  -- 在函式一開始只捕捉一次 clock_timestamp(),同一次呼叫內的「結算舊區間」跟「開新區間」共用同一個
  -- 時間點(維持區間緊密相接、沒有空隙),但跨越不同次呼叫時,每次都是真正前進的時鐘時間,不會撞期。
  v_now timestamptz := clock_timestamp();
begin
  -- 查無資料代表這個人已經被硬刪除,直接 return,這是防呆不是預期路徑。
  select merchant_id, compensation_type, status
  into v_merchant_id, v_compensation_type, v_status
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    return;
  end if;

  select monthly_base_salary into v_monthly_base_salary
  from public.staff_salary_settings
  where staff_id = p_staff_id;

  if not found then
    v_monthly_base_salary := 0;
  end if;

  -- #1035 A 批(PA-D03):目前指派的獎金方案(沒有指派列 ⇒ null = 不給獎金)。
  select plan_id into v_bonus_plan_id
  from public.staff_bonus_assignments
  where staff_id = p_staff_id;

  if not found then
    v_bonus_plan_id := null;
  end if;

  -- #1035 B 批(PB-D03):目前的日薪／時薪金額(沒有設定列 ⇒ 0)。
  select wage_amount into v_wage_amount
  from public.staff_wage_settings
  where staff_id = p_staff_id;

  if not found then
    v_wage_amount := 0;
  end if;

  select id, compensation_type, status, monthly_base_salary, bonus_plan_id, wage_amount
  into v_current_id, v_current_compensation_type, v_current_status, v_current_monthly_base_salary,
       v_current_bonus_plan_id, v_current_wage_amount
  from public.staff_payroll_status_history
  where staff_id = p_staff_id and effective_to is null;

  -- 如果沒有目前生效中的紀錄,或任一欄位跟目前生效中的紀錄不同:結算舊區間、開新區間。
  -- 如果全部欄位都跟目前生效中的紀錄完全相同:不做任何事(避免無意義的雜訊列)。
  -- #1035 B 批:wage_amount 是 B 批才加的欄位,之前的歷史列是 null(= 當時沒有設定 = 0),比對時當 0。
  if v_current_id is null
     or v_current_compensation_type is distinct from v_compensation_type
     or v_current_status is distinct from v_status
     or v_current_monthly_base_salary is distinct from v_monthly_base_salary
     or v_current_bonus_plan_id is distinct from v_bonus_plan_id
     or coalesce(v_current_wage_amount, 0) is distinct from v_wage_amount
  then
    if v_current_id is not null then
      update public.staff_payroll_status_history
      set effective_to = v_now
      where id = v_current_id;
    end if;

    insert into public.staff_payroll_status_history (
      staff_id, merchant_id, compensation_type, status, monthly_base_salary,
      effective_from, is_backfill_seed, bonus_plan_id, wage_amount
    ) values (
      p_staff_id, v_merchant_id, v_compensation_type, v_status, v_monthly_base_salary,
      v_now, p_is_backfill_seed, v_bonus_plan_id, v_wage_amount
    );
  end if;
end;
$$;

-- ACL 跟改前一樣(create or replace 不會改 ACL;這裡重申一次,內容與 A 批相同)。
revoke execute on function private.sync_staff_payroll_status_history(uuid, boolean) from public, anon;
grant execute on function private.sync_staff_payroll_status_history(uuid, boolean) to authenticated;

-- 新 trigger:費率異動(新增 / 改金額 / 刪除)都同步一次歷史。
create function private.staff_wage_settings_sync_payroll_status_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.sync_staff_payroll_status_history(old.staff_id);
    return old;
  end if;
  perform private.sync_staff_payroll_status_history(new.staff_id);
  return new;
end;
$$;

revoke all on function private.staff_wage_settings_sync_payroll_status_history() from public, anon, authenticated;

create trigger staff_wage_settings_sync_payroll_status_history
  after insert or update of wage_amount or delete on public.staff_wage_settings
  for each row execute function private.staff_wage_settings_sync_payroll_status_history();

-- =========================================================================
-- PB-D03-3 private.get_staff_payroll_status_as_of 多回一欄 wage_amount
--   回傳型別改變 ⇒ 必須 drop + create。
--   呼叫者(2026-10-09 本機 pg_proc 全掃 prosrc,共 7 支):private.compute_staff_payroll、
--   private.compute_staff_payroll_by_range、private.get_merchant_monthly_salary_base_as_of、
--   private.compute_staff_monthly_bonus、public.get_merchant_billing_summary、
--   public.get_merchant_billing_summary_by_range、public.get_staff_bonus_by_range ——
--   全部是 `select * into <record>` 或依欄位名取值,多一欄不影響;PL/pgSQL 呼叫沒有 pg_depend,
--   drop 不會連帶刪掉它們。pgTAP p1035b_work_days 逐支呼叫一次。
--   改前本體 = 20261010160000(逐字),只動:回傳欄位、declare 多一個變數、三個分支多帶 wage_amount。
--   ACL 照改前:{postgres=X/postgres, authenticated=X/postgres}(drop 後要整組重寫)。
-- =========================================================================
drop function private.get_staff_payroll_status_as_of(uuid, timestamptz);

create function private.get_staff_payroll_status_as_of(p_staff_id uuid, p_as_of timestamptz)
returns table (
  compensation_type text,
  status text,
  monthly_base_salary numeric,
  is_estimated boolean,
  existed boolean,
  bonus_plan_id uuid,
  wage_amount numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_covering record;
  v_earliest record;
  v_compensation_type text;
  v_status text;
  v_monthly_base_salary numeric(10, 2);
  v_bonus_plan_id uuid;
  v_wage_amount numeric(10, 2);  -- #1035 B 批
  v_is_estimated boolean := false;
  v_existed boolean := false;
begin
  -- 1. 先查「effective_from <= p_as_of 且(effective_to is null 或 effective_to > p_as_of)」的
  -- 那一筆——剛好覆蓋 p_as_of 這個時間點,找到就直接回傳,is_estimated=false、existed=true。
  select h.compensation_type, h.status, h.monthly_base_salary, h.bonus_plan_id, h.wage_amount
  into v_covering
  from public.staff_payroll_status_history h
  where h.staff_id = p_staff_id
    and h.effective_from <= p_as_of
    and (h.effective_to is null or h.effective_to > p_as_of)
  limit 1;

  if found then
    v_compensation_type := v_covering.compensation_type;
    v_status := v_covering.status;
    v_monthly_base_salary := v_covering.monthly_base_salary;
    v_bonus_plan_id := v_covering.bonus_plan_id;
    v_wage_amount := coalesce(v_covering.wage_amount, 0);
    v_is_estimated := false;
    v_existed := true;
  else
    -- 2. 查無覆蓋的紀錄時,查這個人「最早一筆」歷史紀錄。
    select h.compensation_type, h.status, h.monthly_base_salary, h.is_backfill_seed, h.effective_from,
           h.bonus_plan_id, h.wage_amount
    into v_earliest
    from public.staff_payroll_status_history h
    where h.staff_id = p_staff_id
    order by h.effective_from asc
    limit 1;

    if not found then
      -- 3. 完全查無任何歷史紀錄(理論上不會發生,11.3 已確保每個人上線時都有種子紀錄,新增的人
      -- 也會被 11.2 的 insert 觸發器種一筆):防呆回傳 existed=false。
      v_existed := false;
      v_is_estimated := false;
    elsif p_as_of < v_earliest.effective_from and v_earliest.is_backfill_seed then
      -- 最早一筆是 is_backfill_seed=true(這個人在機制上線前就已經存在,只是沒有更早的真實
      -- 歷史)且 p_as_of 早於這筆的 effective_from:回傳這筆種子紀錄的欄位值當作估算。
      v_compensation_type := v_earliest.compensation_type;
      v_status := v_earliest.status;
      v_monthly_base_salary := v_earliest.monthly_base_salary;
      v_bonus_plan_id := v_earliest.bonus_plan_id;
      v_wage_amount := coalesce(v_earliest.wage_amount, 0);
      v_is_estimated := true;
      v_existed := true;
    elsif p_as_of < v_earliest.effective_from and not v_earliest.is_backfill_seed then
      -- 最早一筆是 is_backfill_seed=false(這個人是機制上線後才加入商家)且 p_as_of 早於這筆的
      -- effective_from:代表查詢的那個時間點,這個人根本還沒加入這間商家,回傳 existed=false
      -- (不是估算,是「不適用」,呼叫端要把這個人當作「這個月完全不存在」處理)。
      v_existed := false;
      v_is_estimated := false;
    else
      -- 防呆:p_as_of >= 最早一筆的 effective_from,理論上前面的「剛好覆蓋」查詢應該已經命中
      -- (只要 sync 函式維持區間連續不中斷就不會有空隙)。萬一真的落到這裡(資料被外部直接改動
      -- 導致區間出現空隙),保守回傳 existed=false,不假造一個可能誤導報表的數字。
      v_existed := false;
      v_is_estimated := false;
    end if;
  end if;

  compensation_type := v_compensation_type;
  status := v_status;
  monthly_base_salary := v_monthly_base_salary;
  is_estimated := v_is_estimated;
  existed := v_existed;
  bonus_plan_id := v_bonus_plan_id;
  wage_amount := v_wage_amount;
  return next;
end;
$$;

revoke all on function private.get_staff_payroll_status_as_of(uuid, timestamptz) from public, anon, service_role;
grant execute on function private.get_staff_payroll_status_as_of(uuid, timestamptz) to authenticated;

-- =========================================================================
-- PB-D04 上工日紀錄(每天凍結;只記「當天計酬類型是日薪／時薪且在職」的人)
-- =========================================================================
create table public.staff_work_day_records (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  staff_id uuid not null references public.merchant_staff (id) on delete cascade,
  work_date date not null,
  compensation_type text not null check (compensation_type in ('daily_wage', 'hourly_wage')),
  wage_amount numeric(10, 2) not null check (wage_amount between 0 and 1000000),
  shift_minutes int not null check (shift_minutes between 0 and 1440),
  extra_booking_minutes int not null check (extra_booking_minutes between 0 and 1440),
  worked_minutes int not null check (worked_minutes between 0 and 1440),
  is_leave boolean not null default false,
  leave_type_name text null,
  pay_amount numeric(10, 0) not null check (pay_amount >= 0),
  frozen_at timestamptz not null default now(),
  refrozen_reason text null check (refrozen_reason in ('override', 'leave', 'booking', 'manual_job')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (staff_id, work_date)
);

create index staff_work_day_records_merchant_date_idx on public.staff_work_day_records (merchant_id, work_date);

alter table public.staff_work_day_records enable row level security;
revoke all on table public.staff_work_day_records from anon, authenticated;
