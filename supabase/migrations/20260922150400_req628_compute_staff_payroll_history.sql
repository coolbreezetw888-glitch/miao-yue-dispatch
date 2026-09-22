-- 模組 8(薪資與帳務)規格書 §十一 11.7(SPECS-INDEX #628,核心整合點):
-- private.compute_staff_payroll / compute_staff_payroll_by_range 改用歷史資料(11.5)。
--
-- ⚠️ 動工前已用 pg_get_functiondef 直接查證正式環境(wjtbmmnakcriuaqoknsq)目前這兩支函式的完整
-- 最新版本,結果分別跟本機 migration 20260922130100(compute_staff_payroll)/20260922130300
-- (compute_staff_payroll_by_range)完全一致,無漂移,在這個版本的基礎上疊加,簽章/回傳形狀
-- (除新增 salary_history_estimated 欄位外)完全不變。
--
-- ⚠️ 財務基礎邏輯判斷,已依主腦指示標註「建議確認」等級(規格書 §11.7 原文):「某個月的月薪基本額,
-- 如果該月中途發生加薪/離職/計酬類型變更,要用哪個時間點的值代表『這個月』」——這次選該月最後一天
-- (月底)當下的值,呼叫端傳入的年月/區間結束日期,一律取「該月最後一天結束前的那一刻」
-- (Asia/Taipei)當作 private.get_staff_payroll_status_as_of 的 p_as_of 參數,不是查詢當下的系統
-- 時間。這不是唯一合理的答案(月初的值、依生效天數比例分攤都是合理的替代方案),已在本次回報中
-- 提出讓主腦/使用者確認,沒有自行認定這是唯一定案。
--
-- monthly_leave_quota_days 維持讀 staff_salary_settings 目前值,不歷史化(這次任務範圍明確排除,
-- 判斷 4 早已定案「純參考,不牽動計算」)。

-- =========================================================================
-- 1. private.compute_staff_payroll(p_staff_id, p_year, p_month):月薪基本額改查「這個年月當時」
-- 的歷史值(該月最後一天結束前的那一刻),不是查 staff_salary_settings 目前值。回傳新增
-- salary_history_estimated 欄位。
-- =========================================================================
create or replace function private.compute_staff_payroll(
  p_staff_id uuid,
  p_year int,
  p_month int
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_month_start date;
  v_month_end date;
  v_as_of timestamptz;
  v_pay_days int;
  v_base_salary numeric(10, 2);
  v_salary_estimated boolean;
  v_status record;
  v_quota_days numeric(4, 1);
  v_details jsonb := '[]'::jsonb;
  v_total_deduction numeric(10, 2) := 0;
  v_total_leave_days numeric(6, 1) := 0;
  rec record;
  v_day_rate numeric(14, 4);
  v_deduction numeric(10, 2);
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  -- 該月最後一天結束前的那一刻(Asia/Taipei),比照既有 v_range_start/v_range_end 邊界寫法。
  v_as_of := ((v_month_start + interval '1 month')::timestamp at time zone 'Asia/Taipei')
    - interval '1 microsecond';

  -- §11.7:月薪基本額改查「這個年月當時」的歷史值(11.5),不是查 staff_salary_settings 目前值。
  select * into v_status from private.get_staff_payroll_status_as_of(p_staff_id, v_as_of);

  if v_status.existed then
    v_base_salary := coalesce(v_status.monthly_base_salary, 0);
    v_salary_estimated := v_status.is_estimated;
  else
    -- 這個人那個月根本還不存在(機制上線後才加入的服務人員,查入職前的月份):誠實顯示 0,
    -- 不會被誤標記為估算(§11.5 existed=false 情境)。
    v_base_salary := 0;
    v_salary_estimated := false;
  end if;

  -- monthly_leave_quota_days 維持讀 staff_salary_settings 目前值,不歷史化(判斷 4,這次任務範圍
  -- 明確排除)。查無資料時自動是 null(select into 找不到列時目標變數自動為 null)。
  select monthly_leave_quota_days into v_quota_days
  from public.staff_salary_settings
  where staff_id = p_staff_id;

  v_pay_days := private.get_days_in_month(p_year, p_month);
  v_day_rate := case when v_pay_days > 0 then v_base_salary / v_pay_days else 0 end;

  -- 2. 規則 2.8:依假別分組,計算該年月的重疊天數(跨月只算重疊部分,同假別同月多筆加總)。
  for rec in
    select
      mlt.id as leave_type_id,
      mlt.name as leave_type_name,
      coalesce(ldr.deduction_mode, 'no_deduction') as deduction_mode,
      ldr.percentage_value,
      ldr.fixed_amount_value,
      sum(
        greatest(
          (least(slr.end_date, v_month_end) - greatest(slr.start_date, v_month_start) + 1),
          0
        )
      ) as overlap_days
    from public.staff_leave_records slr
    join public.merchant_leave_types mlt on mlt.id = slr.leave_type_id
    left join public.leave_type_deduction_rules ldr on ldr.leave_type_id = slr.leave_type_id
    where slr.staff_id = p_staff_id
      and slr.status = 'confirmed'
      and slr.start_date <= v_month_end
      and slr.end_date >= v_month_start
    group by mlt.id, mlt.name, ldr.deduction_mode, ldr.percentage_value, ldr.fixed_amount_value
  loop
    if rec.overlap_days <= 0 then
      continue;
    end if;

    v_deduction := case rec.deduction_mode
      when 'no_deduction' then 0
      when 'full_day_rate' then round(v_day_rate * rec.overlap_days, 2)
      when 'percentage_of_day_rate' then
        round(v_day_rate * coalesce(rec.percentage_value, 0) / 100 * rec.overlap_days, 2)
      when 'fixed_amount_per_day' then round(coalesce(rec.fixed_amount_value, 0) * rec.overlap_days, 2)
      else 0
    end;

    v_details := v_details || jsonb_build_object(
      'leave_type_id', rec.leave_type_id,
      'leave_type_name', rec.leave_type_name,
      'days', rec.overlap_days,
      'deduction_mode', rec.deduction_mode,
      'deduction_amount', v_deduction
    );

    v_total_deduction := v_total_deduction + v_deduction;
    v_total_leave_days := v_total_leave_days + rec.overlap_days;
  end loop;

  -- 3. net_pay 不會是負數,超過月薪基本額時額外標記異常旗標(不是靜默把負數藏起來)。
  return jsonb_build_object(
    'monthly_base_salary', v_base_salary,
    'details', v_details,
    'total_deduction_amount', v_total_deduction,
    'net_pay', greatest(v_base_salary - v_total_deduction, 0),
    'over_deduction_warning', v_total_deduction > v_base_salary,
    'monthly_leave_quota_days', v_quota_days,
    'total_leave_days', v_total_leave_days,
    'salary_history_estimated', v_salary_estimated
  );
end;
$$;

comment on function private.compute_staff_payroll(uuid, int, int) is '模組 8 §3.10 核心計算邏輯(規則 2.8)+ §11.7(核心整合點):某位月薪制服務人員在某年月的請假扣款明細與淨額。monthly_base_salary 改成查「該月最後一天結束前的那一刻」的歷史值(private.get_staff_payroll_status_as_of,11.5),不是查 staff_salary_settings 目前值;回傳新增 salary_history_estimated(該月早於機制上線前用種子紀錄回推估算時為 true;該月早於這位服務人員實際加入商家的時間點時,monthly_base_salary=0 且 salary_history_estimated=false,不是估算,是誠實顯示「那時候還沒有這個人」)。monthly_leave_quota_days 維持讀 staff_salary_settings 目前值,不歷史化。不做權限檢查(呼叫端 get_staff_monthly_payroll_summary/get_merchant_billing_summary 各自負責檢查),避免重複實作/重複查詢。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll(uuid, int, int) from public, anon;
grant execute on function private.compute_staff_payroll(uuid, int, int) to authenticated;

-- =========================================================================
-- 2. private.compute_staff_payroll_by_range(p_staff_id, p_start_date, p_end_date):
-- monthly_base_salary 這個回傳欄位的意義改變——原本是單一快照(目前值),這次改成「區間內逐月
-- 月薪加總」(每個月份取該月最後一天(least(該月最後一天, p_end_date))當時的歷史值)。回傳新增
-- salary_history_estimated(只要任一月份用到估算就是 true)。
-- =========================================================================
create or replace function private.compute_staff_payroll_by_range(
  p_staff_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_quota_days numeric(4, 1);
  v_details jsonb := '[]'::jsonb;
  v_total_deduction numeric(10, 2) := 0;
  v_total_leave_days numeric(6, 1) := 0;
  v_total_base_salary numeric(10, 2) := 0;
  v_salary_estimated boolean := false;
  rec record;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  -- monthly_leave_quota_days 維持讀 staff_salary_settings 目前值,不歷史化(同上,判斷 4)。
  select monthly_leave_quota_days into v_quota_days
  from public.staff_salary_settings
  where staff_id = p_staff_id;

  -- §11.7 第 2 點(核心):monthly_base_salary 改成「區間內逐月加總」——每個月份取
  -- least(該月最後一天, p_end_date)(對應最後一個月份可能是不完整月份的邊界情況)當時的歷史值,
  -- 逐月加總,不是「目前值 × 總月數」。只要任一月份用到估算(private.get_staff_payroll_status_
  -- as_of 回傳 is_estimated=true),整體 salary_history_estimated 就是 true;那個月這個人根本
  -- 還不存在(existed=false)的月份,貢獻 0,不計入估算旗標。
  select
    coalesce(sum(coalesce(s.monthly_base_salary, 0)), 0),
    coalesce(bool_or(coalesce(s.is_estimated, false)), false)
  into v_total_base_salary, v_salary_estimated
  from (
    select
      least((m.month_start + interval '1 month - 1 day')::date, p_end_date) as clip_end
    from generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start)
  ) mc
  left join lateral private.get_staff_payroll_status_as_of(
    p_staff_id,
    ((mc.clip_end + 1)::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond'
  ) s on s.existed;

  -- 逐月份 × 逐假別計算重疊天數與扣款,day_rate 依各月實際天數分別計算(不是整個區間套用同一個
  -- 天數),分子(月薪)也改成該月當時的歷史值(跟上面加總 v_total_base_salary 用同一個時間點,
  -- 透過 month_bounds 的 base_salary_as_of 欄位取得,避免同一個月份重複呼叫兩次計算邏輯不一致)。
  for rec in
    with months as (
      select gs::date as month_start
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    month_clips as (
      select
        m.month_start,
        (m.month_start + interval '1 month - 1 day')::date as month_end,
        greatest(m.month_start, p_start_date) as clip_start,
        least((m.month_start + interval '1 month - 1 day')::date, p_end_date) as clip_end,
        private.get_days_in_month(
          extract(year from m.month_start)::int, extract(month from m.month_start)::int
        ) as pay_days
      from months m
    ),
    month_bounds as (
      select
        mc.*,
        coalesce(s.monthly_base_salary, 0) as base_salary_as_of
      from month_clips mc
      left join lateral private.get_staff_payroll_status_as_of(
        p_staff_id,
        ((mc.clip_end + 1)::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond'
      ) s on s.existed
    ),
    per_month_leave as (
      select
        mlt.id as leave_type_id,
        mlt.name as leave_type_name,
        coalesce(ldr.deduction_mode, 'no_deduction') as deduction_mode,
        ldr.percentage_value,
        ldr.fixed_amount_value,
        greatest(
          (least(slr.end_date, mb.clip_end) - greatest(slr.start_date, mb.clip_start) + 1), 0
        ) as overlap_days,
        case when mb.pay_days > 0 then mb.base_salary_as_of / mb.pay_days else 0 end as day_rate
      from month_bounds mb
      join public.staff_leave_records slr
        on slr.staff_id = p_staff_id
        and slr.status = 'confirmed'
        and slr.start_date <= mb.clip_end
        and slr.end_date >= mb.clip_start
      join public.merchant_leave_types mlt on mlt.id = slr.leave_type_id
      left join public.leave_type_deduction_rules ldr on ldr.leave_type_id = slr.leave_type_id
    ),
    per_row_deduction as (
      select
        leave_type_id, leave_type_name, deduction_mode, overlap_days,
        case deduction_mode
          when 'no_deduction' then 0
          when 'full_day_rate' then round(day_rate * overlap_days, 2)
          when 'percentage_of_day_rate' then round(day_rate * coalesce(percentage_value, 0) / 100 * overlap_days, 2)
          when 'fixed_amount_per_day' then round(coalesce(fixed_amount_value, 0) * overlap_days, 2)
          else 0
        end as deduction_amount
      from per_month_leave
      where overlap_days > 0
    )
    select
      leave_type_id, leave_type_name, deduction_mode,
      sum(overlap_days) as days,
      sum(deduction_amount) as deduction_amount
    from per_row_deduction
    group by leave_type_id, leave_type_name, deduction_mode
  loop
    v_details := v_details || jsonb_build_object(
      'leave_type_id', rec.leave_type_id,
      'leave_type_name', rec.leave_type_name,
      'days', rec.days,
      'deduction_mode', rec.deduction_mode,
      'deduction_amount', rec.deduction_amount
    );

    v_total_deduction := v_total_deduction + rec.deduction_amount;
    v_total_leave_days := v_total_leave_days + rec.days;
  end loop;

  return jsonb_build_object(
    'monthly_base_salary', v_total_base_salary,
    'details', v_details,
    'total_deduction_amount', v_total_deduction,
    'net_pay', greatest(v_total_base_salary - v_total_deduction, 0),
    'over_deduction_warning', v_total_deduction > v_total_base_salary,
    'monthly_leave_quota_days', v_quota_days,
    'total_leave_days', v_total_leave_days,
    'salary_history_estimated', v_salary_estimated
  );
end;
$$;

comment on function private.compute_staff_payroll_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6/服務人員端規格書 §15.2 + 模組 8 §11.7(核心整合點):比照 private.compute_staff_payroll,但接受任意日期區間。跨月時逐月份分別用 private.get_days_in_month 算 day_rate 再加總。⚠️ §11.7 起,monthly_base_salary 改成「區間內逐月加總」(每個月份取 least(該月最後一天,p_end_date)當時的歷史值),取代原本的單月快照值——這是這支函式行為的實質改變,直接回應 #580/#581 當初標註的待確認事項。回傳新增 salary_history_estimated(只要任一月份用到估算就是 true)。後端已加上區間 > 366 天的例外保護。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll_by_range(uuid, date, date) from public, anon;
grant execute on function private.compute_staff_payroll_by_range(uuid, date, date) to authenticated;
