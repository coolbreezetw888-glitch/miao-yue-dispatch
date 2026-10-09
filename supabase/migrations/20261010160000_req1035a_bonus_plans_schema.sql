-- SPECS-INDEX #1035 彈性計薪 A 批(月薪加獎金)— migration 1:資料(PA-D01~D03)
-- 規格書:母版 .project/specs/彈性計薪.md 第三節 PA-D、第四節 PX-01。
--
--   PA-D01  staff_bonus_plans(獎金方案;「刪除」= archived,歷史月份可能還在用)
--   PA-D02  staff_bonus_plan_versions(方案版本,effective_month = 從哪個月起生效;rules 只能由
--           public.save_staff_bonus_plan 驗證後寫入)
--   PA-D03  staff_bonus_assignments(月薪人員 → 方案,一人一列)+ staff_payroll_status_history.bonus_plan_id
--           + private.sync_staff_payroll_status_history 多比 bonus_plan_id
--           + private.get_staff_payroll_status_as_of 多回 bonus_plan_id(回傳型別改變 ⇒ drop + create)
--
-- 🔴 三張新表:RLS 開、0 policy、revoke all from anon, authenticated —— 只走 SECURITY DEFINER 函式
--    (migration 2:20261010160100_req1035a_bonus_functions.sql)。
-- 🔴 改寫既有函式一律以「最後一個定義它的 migration」本體為底,只動必要段落:
--    sync_staff_payroll_status_history ← 20260922150100(指紋 13269ce2ed415127da8acbe41376affc)
--    get_staff_payroll_status_as_of    ← 20260922150300(指紋 efa9422413b046a88f8bd72e5988b8f0)
-- 🔴 B 批(日薪/時薪)之後還會再改這兩支(多一欄 wage_amount),到時要以本 migration 的版本為底。

-- =========================================================================
-- PA-D01 獎金方案
-- =========================================================================
create table public.staff_bonus_plans (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 30),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 同一間店「使用中」的方案名稱不能重複(不分大小寫、忽略前後空白);封存的可以同名。
create unique index staff_bonus_plans_active_name_uidx
  on public.staff_bonus_plans (merchant_id, lower(btrim(name)))
  where status = 'active';
create index staff_bonus_plans_merchant_idx on public.staff_bonus_plans (merchant_id);

alter table public.staff_bonus_plans enable row level security;
revoke all on table public.staff_bonus_plans from anon, authenticated;

-- =========================================================================
-- PA-D02 方案版本
-- =========================================================================
create table public.staff_bonus_plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.staff_bonus_plans (id) on delete cascade,
  -- 冗餘,方便依商家查(由函式寫入時跟著方案的 merchant_id 走)。
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  effective_month date not null
    check (effective_month = date_trunc('month', effective_month)::date),
  rules jsonb not null check (jsonb_typeof(rules) = 'array'),
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, effective_month)
);

create index staff_bonus_plan_versions_merchant_idx on public.staff_bonus_plan_versions (merchant_id);

alter table public.staff_bonus_plan_versions enable row level security;
revoke all on table public.staff_bonus_plan_versions from anon, authenticated;

-- =========================================================================
-- PA-D03-1 指派(一人一列;plan_id null = 不給獎金)
-- =========================================================================
create table public.staff_bonus_assignments (
  staff_id uuid primary key references public.merchant_staff (id) on delete cascade,
  merchant_id uuid not null references public.merchants (id) on delete cascade,
  plan_id uuid null references public.staff_bonus_plans (id),
  updated_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index staff_bonus_assignments_plan_idx on public.staff_bonus_assignments (plan_id);
create index staff_bonus_assignments_merchant_idx on public.staff_bonus_assignments (merchant_id);

alter table public.staff_bonus_assignments enable row level security;
revoke all on table public.staff_bonus_assignments from anon, authenticated;

-- =========================================================================
-- PA-D03-2 歷史欄位(不加 fk ⚠️:方案封存不刪,但避免日後清理時卡住歷史)。
-- 既有歷史列 = null(= 當時沒有獎金,正確),不需要搬資料。
-- =========================================================================
alter table public.staff_payroll_status_history add column bonus_plan_id uuid null;

-- =========================================================================
-- PA-D03-3 private.sync_staff_payroll_status_history 改版
--   改前本體 = 20260922150100(逐字),只動四處:
--     ① declare 多兩個變數 v_bonus_plan_id / v_current_bonus_plan_id
--     ② 多讀 staff_bonus_assignments.plan_id(沒有列 ⇒ null)
--     ③「值不同才開新一列」多比 bonus_plan_id
--     ④ insert 多寫 bonus_plan_id
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
  v_current_id uuid;
  v_current_compensation_type text;
  v_current_status text;
  v_current_monthly_base_salary numeric(10, 2);
  v_current_bonus_plan_id uuid;
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

  select id, compensation_type, status, monthly_base_salary, bonus_plan_id
  into v_current_id, v_current_compensation_type, v_current_status, v_current_monthly_base_salary,
       v_current_bonus_plan_id
  from public.staff_payroll_status_history
  where staff_id = p_staff_id and effective_to is null;

  -- 如果沒有目前生效中的紀錄,或四個欄位任一個跟目前生效中的紀錄不同:結算舊區間、開新區間。
  -- 如果四個欄位都跟目前生效中的紀錄完全相同:不做任何事(避免無意義的雜訊列)。
  if v_current_id is null
     or v_current_compensation_type is distinct from v_compensation_type
     or v_current_status is distinct from v_status
     or v_current_monthly_base_salary is distinct from v_monthly_base_salary
     or v_current_bonus_plan_id is distinct from v_bonus_plan_id
  then
    if v_current_id is not null then
      update public.staff_payroll_status_history
      set effective_to = v_now
      where id = v_current_id;
    end if;

    insert into public.staff_payroll_status_history (
      staff_id, merchant_id, compensation_type, status, monthly_base_salary,
      effective_from, is_backfill_seed, bonus_plan_id
    ) values (
      p_staff_id, v_merchant_id, v_compensation_type, v_status, v_monthly_base_salary,
      v_now, p_is_backfill_seed, v_bonus_plan_id
    );
  end if;
end;
$$;

-- ACL 跟改前一樣(create or replace 不會改 ACL;這裡重申一次,內容與 20260922150100 相同)。
revoke execute on function private.sync_staff_payroll_status_history(uuid, boolean) from public, anon;
grant execute on function private.sync_staff_payroll_status_history(uuid, boolean) to authenticated;

-- 新 trigger:指派異動(新增 / 改方案 / 刪除)都同步一次歷史。
create function private.staff_bonus_assignments_sync_payroll_status_history()
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

revoke all on function private.staff_bonus_assignments_sync_payroll_status_history() from public, anon, authenticated;

create trigger staff_bonus_assignments_sync_payroll_status_history
  after insert or update of plan_id or delete on public.staff_bonus_assignments
  for each row execute function private.staff_bonus_assignments_sync_payroll_status_history();

-- =========================================================================
-- PA-D03-4 private.get_staff_payroll_status_as_of 多回一欄 bonus_plan_id
--   回傳型別改變 ⇒ 必須 drop + create。
--   呼叫者(2026-10-09 本機 pg_proc 全掃 prosrc):private.compute_staff_payroll、
--   private.compute_staff_payroll_by_range、private.get_merchant_monthly_salary_base_as_of、
--   public.get_merchant_billing_summary、public.get_merchant_billing_summary_by_range ——
--   全部是 `select * into <record>` 或依欄位名取值(s.existed / s.compensation_type …),
--   多一欄不影響;PL/pgSQL 呼叫沒有 pg_depend,drop 不會連帶刪掉它們。pgTAP p1035a_bonus_plans 逐支呼叫一次。
--   改前本體 = 20260922150300(逐字),只動:回傳欄位、declare 多一個變數、三個分支多帶 bonus_plan_id。
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
  bonus_plan_id uuid
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
  v_is_estimated boolean := false;
  v_existed boolean := false;
begin
  -- 1. 先查「effective_from <= p_as_of 且(effective_to is null 或 effective_to > p_as_of)」的
  -- 那一筆——剛好覆蓋 p_as_of 這個時間點,找到就直接回傳,is_estimated=false、existed=true。
  select h.compensation_type, h.status, h.monthly_base_salary, h.bonus_plan_id
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
    v_is_estimated := false;
    v_existed := true;
  else
    -- 2. 查無覆蓋的紀錄時,查這個人「最早一筆」歷史紀錄。
    select h.compensation_type, h.status, h.monthly_base_salary, h.is_backfill_seed, h.effective_from,
           h.bonus_plan_id
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
  return next;
end;
$$;

revoke all on function private.get_staff_payroll_status_as_of(uuid, timestamptz) from public, anon, service_role;
grant execute on function private.get_staff_payroll_status_as_of(uuid, timestamptz) to authenticated;
