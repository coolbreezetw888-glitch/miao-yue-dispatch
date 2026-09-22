-- 模組 8(薪資與帳務)規格書 §十一 11.5(SPECS-INDEX #626,核心)+ 11.6(SPECS-INDEX #627,核心):
-- 查詢某個時間點的薪資/身份狀態(含機制上線前估算邏輯)+ 某商家某時間點「月薪制且在職」人員的
-- 月薪合計。這兩支是 11.7/11.8 改寫既有函式時共用的核心共用函式。

-- =========================================================================
-- 11.5:private.get_staff_payroll_status_as_of(p_staff_id uuid, p_as_of timestamptz)
-- returns table(compensation_type text, status text, monthly_base_salary numeric,
-- is_estimated boolean, existed boolean)。
-- =========================================================================
create or replace function private.get_staff_payroll_status_as_of(
  p_staff_id uuid,
  p_as_of timestamptz
)
returns table (
  compensation_type text,
  status text,
  monthly_base_salary numeric,
  is_estimated boolean,
  existed boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_covering record;
  v_earliest record;
  v_compensation_type text;
  v_status text;
  v_monthly_base_salary numeric(10, 2);
  v_is_estimated boolean := false;
  v_existed boolean := false;
begin
  -- 1. 先查「effective_from <= p_as_of 且(effective_to is null 或 effective_to > p_as_of)」的
  -- 那一筆——剛好覆蓋 p_as_of 這個時間點,找到就直接回傳,is_estimated=false、existed=true。
  select h.compensation_type, h.status, h.monthly_base_salary
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
    v_is_estimated := false;
    v_existed := true;
  else
    -- 2. 查無覆蓋的紀錄時,查這個人「最早一筆」歷史紀錄。
    select h.compensation_type, h.status, h.monthly_base_salary, h.is_backfill_seed, h.effective_from
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
  return next;
end;
$$;

comment on function private.get_staff_payroll_status_as_of(uuid, timestamptz) is '模組 8 §11.5(核心):查詢某位服務人員在某個時間點的計酬類型/在職狀態/月薪。剛好命中歷史區間時 existed=true、is_estimated=false;查詢時間早於機制上線前的種子紀錄時,用種子紀錄回推估算(is_estimated=true、existed=true);查詢時間早於「機制上線後才加入」的服務人員的最早紀錄時,existed=false(那時候這個人還不存在,不是估算)。時間點邊界比照既有 v_range_start/v_range_end(... at time zone Asia/Taipei)的邊界寫法處理時區,呼叫端傳入的 p_as_of 應該是「該月最後一天結束前的那一刻」。只給 11.6/11.7/11.8 內部函式呼叫,不對外暴露。';

revoke execute on function private.get_staff_payroll_status_as_of(uuid, timestamptz) from public, anon;
grant execute on function private.get_staff_payroll_status_as_of(uuid, timestamptz) to authenticated;

-- =========================================================================
-- 11.6:private.get_merchant_monthly_salary_base_as_of(p_merchant_id uuid, p_as_of timestamptz)
-- returns table(total_amount numeric, is_estimated boolean)。
-- =========================================================================
create or replace function private.get_merchant_monthly_salary_base_as_of(
  p_merchant_id uuid,
  p_as_of timestamptz
)
returns table (
  total_amount numeric,
  is_estimated boolean
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_staff record;
  v_status record;
  v_total numeric(10, 2) := 0;
  v_any_estimated boolean := false;
begin
  -- 對這間商家目前所有 merchant_staff(含已移除,因為查詢的是過去某個時間點,那時候可能還是
  -- 在職的)逐一呼叫 11.5 的函式。已經被硬刪除的服務人員不會出現在這裡(11.4 已確保「曾經領過
  -- 非 0 月薪」的人不可能被硬刪除,所以這個加總對「有意義的歷史金額」永遠是完整的)。
  for v_staff in
    select id from public.merchant_staff where merchant_id = p_merchant_id
  loop
    select * into v_status from private.get_staff_payroll_status_as_of(v_staff.id, p_as_of);

    if v_status.existed and v_status.compensation_type = 'monthly_salary' and v_status.status = 'active' then
      v_total := v_total + coalesce(v_status.monthly_base_salary, 0);
      if v_status.is_estimated then
        v_any_estimated := true;
      end if;
    end if;
  end loop;

  total_amount := v_total;
  is_estimated := v_any_estimated;
  return next;
end;
$$;

comment on function private.get_merchant_monthly_salary_base_as_of(uuid, timestamptz) is '模組 8 §11.6(核心):某間商家在某個時間點,所有「月薪制且在職」服務人員的月薪合計,供 11.7/11.8 逐月加總使用。只加總 existed=true 且 compensation_type=monthly_salary 且 status=active 的人;只要加總過程中有任何一筆用到估算值,整體回傳的 is_estimated 就是 true。只給 11.7/11.8 內部函式呼叫,不對外暴露。';

revoke execute on function private.get_merchant_monthly_salary_base_as_of(uuid, timestamptz) from public, anon;
grant execute on function private.get_merchant_monthly_salary_base_as_of(uuid, timestamptz) to authenticated;
