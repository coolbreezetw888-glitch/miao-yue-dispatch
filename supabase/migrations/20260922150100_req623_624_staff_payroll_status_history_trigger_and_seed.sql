-- 模組 8(薪資與帳務)規格書 §十一 11.2(SPECS-INDEX #623,核心)+ 11.3(SPECS-INDEX #624):
-- 自動記錄異動的觸發器 + 機制上線當下的起始種子紀錄。
--
-- §11.0 第 2 點:全部改用資料庫觸發器自動記錄,不改任何一個既有的前端/API 寫入呼叫——目前寫入
-- merchant_staff.compensation_type/status、staff_salary_settings.monthly_base_salary 的所有路徑
-- (src/modules/staff-agent/api.ts 的 addMerchantStaff/updateMerchantStaff/removeMerchantStaff/
-- reactivateMerchantStaff、src/modules/payroll/api.ts 的 upsertStaffSalarySettings)全部是直接 RLS
-- 表格寫入,不是透過 RPC,動工前已逐一查證這四個呼叫點,結論是「0 個前端/API 呼叫點需要修改」
-- (見規格書 §11 既有寫入點盤點表)。改成在 merchant_staff/staff_salary_settings 各掛一個
-- AFTER INSERT OR UPDATE 觸發器,兩個觸發器共用同一支核心函式 private.sync_staff_payroll_status_
-- history,不管是哪個欄位、從哪個呼叫點改的,一律自動比對「目前值」跟「目前生效中的那筆歷史紀錄」
-- 是否相同,不同才結算舊區間、開新區間;完全相同(例如只是改了姓名這種無關欄位順帶觸發 UPDATE)
-- 則不動作,不會產生雜訊紀錄。

-- =========================================================================
-- 11.2:private.sync_staff_payroll_status_history(p_staff_id uuid) returns void(SECURITY DEFINER)。
--
-- 實作補充(規格書 §11.3 明講「engineer 可以用先呼叫共用函式產生紀錄、再 UPDATE 剛產生的那幾筆,
-- 或直接在共用函式加一個內部參數控制,依實際 migration 撰寫習慣選擇,只要結果正確即可」):這裡
-- 選擇第二種做法,新增一個有預設值的第二參數 p_is_backfill_seed boolean default false——觸發器
-- 呼叫時完全不帶這個參數(維持規格書原文簽章的呼叫方式,套用預設值 false),只有下面 11.3 的一次性
-- 回填 migration 動作會明確帶入 true。這個參數是純新增、有預設值,不影響規格書原文描述的呼叫方式。
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
  v_current_id uuid;
  v_current_compensation_type text;
  v_current_status text;
  v_current_monthly_base_salary numeric(10, 2);
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

  select id, compensation_type, status, monthly_base_salary
  into v_current_id, v_current_compensation_type, v_current_status, v_current_monthly_base_salary
  from public.staff_payroll_status_history
  where staff_id = p_staff_id and effective_to is null;

  -- 如果沒有目前生效中的紀錄,或三個欄位任一個跟目前生效中的紀錄不同:結算舊區間、開新區間。
  -- 如果三個欄位都跟目前生效中的紀錄完全相同:不做任何事(避免無意義的雜訊列)。
  if v_current_id is null
     or v_current_compensation_type is distinct from v_compensation_type
     or v_current_status is distinct from v_status
     or v_current_monthly_base_salary is distinct from v_monthly_base_salary
  then
    if v_current_id is not null then
      update public.staff_payroll_status_history
      set effective_to = v_now
      where id = v_current_id;
    end if;

    insert into public.staff_payroll_status_history (
      staff_id, merchant_id, compensation_type, status, monthly_base_salary,
      effective_from, is_backfill_seed
    ) values (
      p_staff_id, v_merchant_id, v_compensation_type, v_status, v_monthly_base_salary,
      v_now, p_is_backfill_seed
    );
  end if;
end;
$$;

comment on function private.sync_staff_payroll_status_history(uuid, boolean) is '模組 8 §11.2(核心):比對 merchant_staff.compensation_type/status + staff_salary_settings.monthly_base_salary 目前值跟 staff_payroll_status_history 目前生效中的紀錄,不同才結算舊區間(effective_to)、開新區間;完全相同則不動作。時間點用 clock_timestamp()(不是 now()/transaction_timestamp()),避免同一個 transaction 內連續呼叫兩次時,新的 effective_to 等於舊紀錄自己的 effective_from 而違反 CHECK 約束(理由見函式內 v_now 變數註解)。p_is_backfill_seed 只有 11.3 的一次性回填會帶 true,一般觸發器呼叫沿用預設值 false。只給下面兩個觸發器/11.3 回填呼叫,不對外暴露。';

revoke execute on function private.sync_staff_payroll_status_history(uuid, boolean) from public, anon;
grant execute on function private.sync_staff_payroll_status_history(uuid, boolean) to authenticated;

-- =========================================================================
-- 11.2:merchant_staff / staff_salary_settings 各自的觸發器包裝函式 + 觸發器。
-- ⚠️ 實作警語(規格書明講):兩支觸發函式都要宣告 SECURITY DEFINER——staff_payroll_status_history
-- 完全沒有給 authenticated 角色任何寫入政策,一般權限的呼叫者(商家管理員/客服)透過既有的
-- update merchant_staff / upsert staff_salary_settings 呼叫路徑觸發這個 trigger 時,如果 trigger
-- 函式不是 SECURITY DEFINER,寫入會被 RLS 擋下失敗。
-- =========================================================================
create or replace function private.merchant_staff_sync_payroll_status_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.sync_staff_payroll_status_history(new.id);
  return new;
end;
$$;

comment on function private.merchant_staff_sync_payroll_status_history() is '模組 8 §11.2:merchant_staff 的 compensation_type/status 異動時,自動同步 staff_payroll_status_history。SECURITY DEFINER(理由見上方函式註解)。';

create trigger merchant_staff_sync_payroll_status_history
  after insert or update of compensation_type, status on public.merchant_staff
  for each row execute function private.merchant_staff_sync_payroll_status_history();

create or replace function private.staff_salary_settings_sync_payroll_status_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.sync_staff_payroll_status_history(new.staff_id);
  return new;
end;
$$;

comment on function private.staff_salary_settings_sync_payroll_status_history() is '模組 8 §11.2:staff_salary_settings.monthly_base_salary 異動時,自動同步 staff_payroll_status_history。SECURITY DEFINER(理由見上方函式註解)。';

create trigger staff_salary_settings_sync_payroll_status_history
  after insert or update of monthly_base_salary on public.staff_salary_settings
  for each row execute function private.staff_salary_settings_sync_payroll_status_history();

-- =========================================================================
-- 11.3:機制上線當下的起始種子紀錄。對「這支 migration 執行當下」所有既有的 merchant_staff 紀錄
-- (不分 active/removed,兩種狀態都要有起點)逐一呼叫 sync_staff_payroll_status_history,並把這次
-- 產生的紀錄標記 is_backfill_seed=true。
--
-- 這個動作是一次性的,只在這支 migration 部署當下對「當時已經存在」的服務人員生效——之後(這支
-- migration 之後)才新增的服務人員,走上面 11.2 的一般 insert 觸發路徑,產生的種子紀錄
-- is_backfill_seed 一律是 false(這正是 11.5 估算邏輯要分辨的兩種情況)。
--
-- 在本機/pgTAP 測試環境重新跑 migration 時,這個時間點通常沒有任何既有 merchant_staff 資料
-- (pgTAP 測試資料一律在各自測試檔案的 transaction 裡建立,不會在 migration 套用時就存在),這段
-- 迴圈實際上是 no-op;正式環境套用時(6 位既有服務人員,已於動工前用 SELECT 查證,見本次回報),
-- 才會真的產生 6 筆種子紀錄。
-- =========================================================================
do $$
declare
  v_staff_id uuid;
begin
  for v_staff_id in select id from public.merchant_staff loop
    perform private.sync_staff_payroll_status_history(v_staff_id, true);
  end loop;
end;
$$;
