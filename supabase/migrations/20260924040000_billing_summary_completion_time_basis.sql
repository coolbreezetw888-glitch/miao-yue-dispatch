-- 2026-09-24 使用者裁決修補(帳務報表三合一:完成時間基準 + 離職人員歷史母體 + 月薪只算完整月份)。
--
-- 這一支 migration 同時處理三件事,刻意不拆成三支——因為三件事全部落在
-- get_merchant_billing_summary / get_merchant_billing_summary_by_range 這「同樣的兩支函式」上,
-- 拆開就要把同一支函式連續 create or replace 三次,中間兩個版本永遠不會有人執行到,
-- 只會讓之後看歷史的人搞不清楚哪一版才是真的。
--
-- =========================================================================
-- 【任務 1:報表的三個數字全部改用「完成時間」當基準】
--
-- 使用者裁決原文:
--   「都已完成時間做依據,假設商家想知道當月接單的營收(因為是未完成所以不是已確定的結果),
--     就會用訂單管理去查看。」
--   「完成代表收到錢,若訂單在 9 月但未完成代表他在 9 月還沒收到錢…直到哪個月份按完成才歸在
--     那個月(抽成同理)。」
--   (主腦已明確提醒過「這會讓歷史報表數字變動」,使用者回覆:確定。)
--
-- 原本的寫法(20260922150500_req629):
--   ・營收 / 稅金 → 用 b.start_at(預約發生的時間)
--   ・料錢       → 用 b.start_at
--   ・抽成       → 用 bcr.computed_at
-- 也就是「營收認在預約那個月、抽成認在完成那個月」,同一張報表裡兩種口徑,卡片之間互相矛盾。
-- 這次全部統一成「完成時間」。
--
-- ⚠️【completed_at 資料完整性:動工前已對正式環境(wjtbmmnakcriuaqoknsq)唯讀查證,不是假設】
-- 查詢一(各狀態的 completed_at 分布):
--   status               | 筆數 | completed_at 有值 | 為 null | 其中 source='import'
--   completed            |  40  |        26         |   14    |        14
--   accepted/cancelled/pending_confirmation … 全部 completed_at 為 null(正常,還沒完成)
-- 查詢二(逐筆列出 status='completed' 且 completed_at is null 的 14 筆):
--   14 筆 **全部** source='import'、start_at 落在 2024-01-15 / 2024-03-01 / 2024-03-02,
--   created_at 都是 2026-09-22~23(也就是這批歷史匯入測試資料)。
--
-- 原因已查明(不是資料被外部改壞):
--   ・唯一會把訂單轉成 completed 的一般路徑是 public.complete_booking(),它一律
--     `set status='completed', completed_at = now()`(最新版在
--     20260922160100_req597:407),所以走正常流程的訂單 completed_at 必定有值。
--   ・public.import_historical_bookings_batch(20260920170200:175 起)是**直接 INSERT**
--     `status='completed'`,INSERT 欄位清單裡完全沒有 completed_at → 必定是 null。
--     這就是那 14 筆的來源,也是「舊資料為什麼會有 null」的完整答案。
--
-- 【處理方式:三層一起做,理由見下】
--   (1) 報表查詢一律用 coalesce(b.completed_at, b.start_at) —— 對匯入的歷史訂單來說,
--       start_at 就是「這筆生意實際發生(也就是收到錢)的那一天」,是唯一有意義的近似值。
--       ⚠️ 這裡刻意**不是**「completed_at is null 就排除」——那會讓商家匯入的歷史營收
--       整批從報表上消失,比歸錯月份嚴重得多。
--   (2) §2 對既有的 14 筆做一次性回填 completed_at = start_at,讓這個欄位之後對
--       「所有 status='completed' 的訂單」都可信,不必每個新寫的查詢都記得包 coalesce。
--   (3) 根因修掉:下一支 migration(20260924040100)讓 import_historical_bookings_batch
--       以後 INSERT 時就寫入 completed_at,不再繼續生產 null。
--   (1) 在 (2)(3) 之後看起來多餘,但刻意保留:萬一之後又有人新增一條「直接 INSERT
--       completed 訂單」的路徑,報表會算錯月份而不是靜默漏掉整筆錢。
--
-- ⚠️【抽成維持 bcr.computed_at:已查證,不是照抄主腦的說法】
--   查詢三(比對 booking_commission_records.computed_at 與該訂單的 bookings.completed_at):
--     total_records=25、booking_completed_at_null=0、exactly_equal=25、
--     max_diff_seconds=0.000000、different_month=0
--   → 25 筆全部「完全相等到微秒」。原因:complete_booking() 在同一個交易裡先
--     `completed_at = now()` 再 perform compute_booking_commission(),而
--     booking_commission_records.computed_at 的欄位預設就是 now()——同一個交易裡 now() 是固定值,
--     所以兩者必然是同一個瞬間。
--   另外查證 public.recalculate_booking_commission(20260920120300:96-103):它只更新
--     commission_basis_type_snapshot / commission_base_amount_snapshot /
--     material_cost_deducted_snapshot / commission_rate_percentage_snapshot /
--     commission_amount / recalculated_at,**完全沒有碰 computed_at** → computed_at 寫入後
--     不可變,不會因為事後重算而把抽成搬到別的月份。
--   結論:computed_at ≡ completed_at,維持用 computed_at 是正確的,而且它有既有索引
--   (booking_commission_records_merchant_id_computed_at_idx)可用,不需要改成 join bookings。
--
-- =========================================================================
-- 【任務 2:離職人員的月薪扣款與明細,改用「那個時間點的狀態」】
--
-- 使用者裁決原文:
--   「一樣是留歷史紀錄的概念,即便這個人離職,紀錄還是存在…就好比有發過薪水總要有這個紀錄依據
--     去計算,既然有紀錄怎麼可能跨月就把紀錄刪除了?」
--
-- 原本的缺陷(同一支函式裡兩邊母體不一致):
--   ・月薪基本額卡片 → private.get_merchant_monthly_salary_base_as_of(11.6),它對**全部**
--     merchant_staff(含已移除)逐一問「**那個時間點**是否月薪制且在職」→ 正確。
--   ・月薪扣款 + per_staff_breakdown → `where ms.status = 'active'` → 用的是「**現在**」的狀態。
--   後果:師傅 9 月請假、10/5 離職,11 月查 9 月報表 → 基本額含他的月薪(對),但他 9 月的請假
--   扣款不會被扣、整個人也不出現在明細 → 月薪實發合計多算,明細加總跟卡片永遠對不起來。
--
-- 這次把 per_staff_breakdown 的母體改成跟 11.6 同一套:對該商家全部 merchant_staff 逐一呼叫
-- private.get_staff_payroll_status_as_of,取「該區間內至少有一個月份當時 existed 且 status=active」
-- 的人。⚠️ 這直接推翻 §11.9 那條「per_staff_breakdown 維持目前在職名單,不逐月還原歷史人員名單」
-- 的決策記錄——那條是當初的簡化決定,使用者這次明確要求改成歷史母體,以使用者裁決為準。
--
-- ⚠️【連帶必須修:private.compute_staff_payroll / _by_range 的基本額條件】
-- 這不是順手擴大範圍,是「不修就會讓這次改動當場產生新的對不起來」:
--   20260922150400_req628 的 compute_staff_payroll_by_range(:214-217)取基本額時寫的是
--   `left join lateral private.get_staff_payroll_status_as_of(...) s on s.existed`
--   —— 只看 existed,**沒有**檢查 status='active',也沒有檢查 compensation_type='monthly_salary'。
--   單月版 compute_staff_payroll(:66)同樣只看 `if v_status.existed then`。
--   而 11.6 的卡片那一邊是 `existed and compensation_type='monthly_salary' and status='active'`。
--   在「原本明細只列現在還在職的人」的世界裡這個落差看不出來(離職的人根本不在明細上);
--   這次明細開始列出離職者之後,就會出現「卡片基本額 30000(只認 9 月)、明細 net_pay 60000
--   (9 月+10 月各算一次月薪)」這種一眼就是錯的畫面。
--   所以這次把兩支的基本額取值條件補成跟 11.6 **一字一樣**,讓兩邊永遠同一套定義。
--   ・對「一直在職的月薪制人員」完全沒有任何數字變化(既有測試值不動)。
--   ・附帶修正 get_staff_monthly_payroll_summary / _by_range(個別師傅報表,呼叫同樣這兩支):
--     離職之後的月份不再顯示一筆幽靈月薪。這是連帶的正確化,已在回報中明確提出。
--
-- =========================================================================
-- 【任務 3:月薪只在「選了完整月份」時才計算】
--
-- 主腦提案、使用者回覆「可以」:
--   月薪相關數字只在「完整月份」的查詢下才計算並顯示。自訂任意區間時,營收/料錢/抽成照常顯示,
--   但月薪基本額/月薪扣款/商家總淨利改顯示「需選擇完整月份才能計算」。
--
-- 這順便消滅一個真的 bug:原本 generate_series(date_trunc('month', p_start_date),
-- date_trunc('month', p_end_date), '1 month') 會讓「查 2/15–3/15(29 天)」收到 **2 個月的整月
-- 月薪**(因為 generate_series 是以「月初」為單位展開,2/15 和 3/15 各自被 date_trunc 成 2/1 和
-- 3/1,產生兩個月份),而扣款那一邊(compute_staff_payroll_by_range)卻有按區間裁切 →
-- 基本額用 2 個整月、扣款只用 29 天,兩邊口徑不一致,算出來的月薪實發沒有任何意義。
--
-- 回傳新增欄位:salary_applicable boolean
--   ・true 的條件:p_start_date 是某個月的 1 號,**且** p_end_date 是某個月的最後一天
--     (可以跨多個月,例如 2/1–4/30 合法)。
--   ・false 時:total_monthly_salary_base / total_monthly_salary_deduction /
--     estimated_net_margin,以及明細裡的 net_pay,一律回傳 **null**(不是 0)——前端要能分辨
--     「不適用」與「真的是零」。
--   ・false 時:營收、稅金、料錢、抽成、訂單數照常計算回傳。
--   ・按年月那一支 get_merchant_billing_summary 永遠是完整月份,salary_applicable 固定 true
--     (為了兩支介面一致也加上這個欄位)。
--
-- ⚠️ 欄位命名:主腦的任務描述寫成 `total_salary_deduction`,但既有回傳的實際鍵名是
--    `total_monthly_salary_deduction`(20260922150500:299)。這裡沿用**既有**鍵名,不改名,
--    避免前端既有讀取路徑整批壞掉。已在回報中說明。
-- ⚠️ salary_estimation_applied 在 salary_applicable=false 時回傳 false(不是 null):它是一個
--    「要不要顯示估算警示」的旗標,不是金額。沒有計算月薪自然就沒有用到估算值。
--
-- 【簽章不變】兩支都是 create or replace、參數一字不改,不受「改簽章要先 drop」的限制。
-- 權限設定(revoke/grant)照原樣重新宣告一次,保持意圖明確(supabase-permission-hygiene)。
-- =========================================================================

-- =========================================================================
-- §1 private.compute_staff_payroll / private.compute_staff_payroll_by_range:
--     基本額取值條件補成跟 11.6 一致(existed + status=active + compensation_type=monthly_salary)。
--     除了這個條件,其餘每一行完整照抄 20260922150400_req628 的版本,不動任何其他邏輯。
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

  -- 2026-09-24(任務 2 連帶修正):條件從「只看 existed」補成跟 11.6
  -- (private.get_merchant_monthly_salary_base_as_of)**一字一樣**的三個條件。
  -- 原本只看 existed,導致「已離職的月份」「那個月還是按件計酬的月份」也會算出一筆整月基本額,
  -- 跟商家報表卡片那一邊(11.6 有檢查 status/compensation_type)對不起來。
  if v_status.existed
     and v_status.status = 'active'
     and v_status.compensation_type = 'monthly_salary'
  then
    v_base_salary := coalesce(v_status.monthly_base_salary, 0);
    v_salary_estimated := v_status.is_estimated;
  else
    -- 這個人那個月根本還不存在(機制上線後才加入的服務人員,查入職前的月份)、或那個月已經離職、
    -- 或那個月還不是月薪制:誠實顯示 0,不會被誤標記為估算(§11.5 existed=false 情境同理)。
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

comment on function private.compute_staff_payroll(uuid, int, int) is '模組 8 §3.10 核心計算邏輯(規則 2.8)+ §11.7(核心整合點,2026-09-24 再疊加任務 2 的條件修正):某位月薪制服務人員在某年月的請假扣款明細與淨額。monthly_base_salary 查「該月最後一天結束前的那一刻」的歷史值(private.get_staff_payroll_status_as_of,11.5)。2026-09-24:取值條件從原本「只看 existed」補成跟 private.get_merchant_monthly_salary_base_as_of(11.6)一字一樣的三個條件(existed + status=active + compensation_type=monthly_salary)——原本已離職的月份或那個月還是按件計酬的月份也會算出一筆整月基本額,跟商家帳務報表卡片那一邊對不起來,是這次「明細開始列出離職者」之後會直接被看見的矛盾。回傳的 salary_history_estimated 只在真的用到種子紀錄回推估算時為 true;那個月這個人不存在/已離職/還不是月薪制時,monthly_base_salary=0 且 salary_history_estimated=false(不是估算,是誠實顯示)。monthly_leave_quota_days 維持讀 staff_salary_settings 目前值,不歷史化。不做權限檢查(呼叫端各自負責)。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll(uuid, int, int) from public, anon;
grant execute on function private.compute_staff_payroll(uuid, int, int) to authenticated;

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

  -- §11.7 第 2 點(核心):monthly_base_salary 是「區間內逐月加總」——每個月份取
  -- least(該月最後一天, p_end_date)(對應最後一個月份可能是不完整月份的邊界情況)當時的歷史值,
  -- 逐月加總,不是「目前值 × 總月數」。
  --
  -- 2026-09-24(任務 2 連帶修正):join 條件從 `on s.existed` 補成
  -- `on s.existed and s.status = 'active' and s.compensation_type = 'monthly_salary'`,
  -- 跟 11.6 一字一樣(理由見檔頭「連帶必須修」那一段:否則「9 月在職、10/5 離職」的人查
  -- [9/1,10/31] 會拿到兩個整月的基本額,卡片那一邊卻只認 9 月的一個月)。
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
  ) s on s.existed and s.status = 'active' and s.compensation_type = 'monthly_salary';

  -- 逐月份 × 逐假別計算重疊天數與扣款,day_rate 依各月實際天數分別計算(不是整個區間套用同一個
  -- 天數),分子(月薪)也用該月當時的歷史值(跟上面加總 v_total_base_salary 用同一個時間點與
  -- 同一組條件,避免同一個月份兩處算出不一致的基本額)。
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
      ) s on s.existed and s.status = 'active' and s.compensation_type = 'monthly_salary'
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

comment on function private.compute_staff_payroll_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6/服務人員端規格書 §15.2 + 模組 8 §11.7(核心整合點,2026-09-24 再疊加任務 2 的條件修正):比照 private.compute_staff_payroll,但接受任意日期區間。跨月時逐月份分別用 private.get_days_in_month 算 day_rate 再加總。monthly_base_salary 是「區間內逐月加總」(每個月份取 least(該月最後一天,p_end_date)當時的歷史值)。2026-09-24:兩處取基本額的 lateral join 條件從原本 `on s.existed` 補成 `on s.existed and s.status = active and s.compensation_type = monthly_salary`,跟 private.get_merchant_monthly_salary_base_as_of(11.6)一字一樣——原本「9 月在職、10/5 離職」的人查 [9/1,10/31] 會拿到兩個整月的基本額,而商家報表卡片那一邊只認 9 月一個月,兩邊對不起來。回傳 salary_history_estimated(只要任一月份用到估算就是 true)。後端已加上區間 > 366 天的例外保護。只給模組 8 內部函式呼叫,不對外暴露。';

revoke execute on function private.compute_staff_payroll_by_range(uuid, date, date) from public, anon;
grant execute on function private.compute_staff_payroll_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- §2 一次性回填:status='completed' 但 completed_at 為 null 的舊訂單,completed_at = start_at。
--
-- ⚠️ 依 CLAUDE.md 第九章第 11 點(任何對正式資料庫的寫入前一律先用相同篩選條件跑 SELECT 實際
--    核對內容),動工前已對正式環境 wjtbmmnakcriuaqoknsq 用**完全相同的 where 條件**
--    (status = 'completed' and completed_at is null)逐筆 SELECT 列出過:
--      共 14 筆,source 全部是 'import',start_at 分別落在 2024-01-15 / 2024-03-01 / 2024-03-02,
--      created_at 都是 2026-09-22~23。
--    確認全部是歷史匯入訂單、沒有任何一筆是走 complete_booking 的正常訂單,這個 UPDATE 不會
--    波及真實的營運資料。
--
-- 為什麼是 start_at:對「歷史匯入的已完成訂單」而言,這筆生意在 start_at 那天就已經做完、
-- 錢也在那天收到了(這正是使用者「完成代表收到錢」的定義);匯入動作本身發生在 2026-09,
-- 拿匯入當天當完成時間會把 2024 年的營收全部算進 2026 年 9 月,明顯錯誤。
--
-- 這段刻意寫成 where 條件帶 status='completed':還沒完成的訂單(accepted/pending/cancelled)
-- completed_at 本來就該是 null,一個都不能碰。
-- =========================================================================
update public.bookings
set completed_at = start_at
where status = 'completed'
  and completed_at is null;

-- =========================================================================
-- §3 get_merchant_billing_summary(p_merchant_id, p_year, p_month):單一年月版本。
--     ・營收/稅金/料錢/訂單數 → 改用 coalesce(b.completed_at, b.start_at)(任務 1)
--     ・per_staff_breakdown 母體 → 改成「該月月底當時 existed 且在職」(任務 2)
--     ・新增 salary_applicable,固定 true(任務 3,按年月查詢本來就是完整月份)
-- =========================================================================
create or replace function public.get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_month_start date;
  v_next_month_start date;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_as_of timestamptz;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_next_month_start := v_month_start + interval '1 month';
  v_range_start := v_month_start::timestamp at time zone 'Asia/Taipei';
  v_range_end := v_next_month_start::timestamp at time zone 'Asia/Taipei';
  -- 該年月最後一天結束前的那一刻(Asia/Taipei),比照 11.7 compute_staff_payroll 的邊界寫法。
  v_as_of := v_range_end - interval '1 microsecond';

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  --
  -- 2026-09-24(任務 1,使用者裁決「都已完成時間做依據」「完成代表收到錢」):月份基準從
  -- b.start_at(預約發生的時間)改成「完成時間」coalesce(b.completed_at, b.start_at)。
  -- coalesce 的 fallback 只會對「直接 INSERT 出來、沒走 complete_booking 的歷史匯入訂單」
  -- 生效(§2 已回填既有的 14 筆,20260924040100 已修掉根因,這裡是防禦性保留,理由見檔頭)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  select coalesce(sum(bmc.amount_snapshot), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持用 bcr.computed_at:已查證它跟該訂單的 completed_at 完全相等(25/25 筆,
  -- max_diff 0.000000 秒),而且 recalculate_booking_commission 不會改動 computed_at
  -- (只改 recalculated_at),所以這已經就是「完成時間」,改成 join bookings 只會白白
  -- 失去 booking_commission_records_merchant_id_computed_at_idx 這個既有索引。詳見檔頭。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8:total_monthly_salary_base 呼叫 private.get_merchant_monthly_salary_base_as_of(11.6)。
  select total_amount, is_estimated
  into v_total_salary_base, v_salary_estimated
  from private.get_merchant_monthly_salary_base_as_of(p_merchant_id, v_as_of);

  -- 2026-09-24(任務 2,使用者裁決「即便這個人離職,紀錄還是存在」):母體從
  -- `where ms.status = 'active'`(現在的狀態)改成「該月月底當時 existed 且 status=active」
  -- ——跟上面 11.6 算基本額用的是同一個 v_as_of、同一組條件,兩邊母體從此必然一致。
  -- ⚠️ 這推翻 §11.9「per_staff_breakdown 維持目前在職名單」的決策記錄,以使用者裁決為準。
  -- compensation_type 也取「那個時間點」的值,不是現在的值(同一個人可能中途改過計酬類型)。
  --
  -- is_active_as_of(2026-09-24 主腦裁決追加):讓前端知道要不要在這一列旁邊顯示「已離職」標籤。
  -- ⚠️ 語意說明(這個欄位名跟它實際的意思有落差,已在回報中提出可改名,讀到這裡請以本註解為準):
  --    它的值是「這個人**目前**是否仍在職」(ms.status = 'active',查詢執行當下的狀態),
  --    **不是**「在 v_as_of 那個時間點是否在職」。
  --    原因:這支函式的母體條件已經是「該月月底當時 existed 且 status=active」,所以「在 as_of
  --    那一刻是否在職」對每一列**恆為 true**,當成旗標毫無資訊量。真正驅動「已離職」標籤的判斷
  --    是「這個人已經離開了,所以你在這張 9 月報表上看到一個現在名單裡沒有的人」——那必須看
  --    目前狀態。若主腦要改名,建議 is_currently_active。
  for rec in
    select ms.id, ms.name, s.compensation_type, (ms.status = 'active') as is_currently_active
    from public.merchant_staff ms
    join lateral private.get_staff_payroll_status_as_of(ms.id, v_as_of) s on true
    where ms.merchant_id = p_merchant_id
      and s.existed
      and s.status = 'active'
    order by ms.name
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      v_payroll := private.compute_staff_payroll(rec.id, p_year, p_month);
      v_total_salary_deduction := v_total_salary_deduction
        + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', v_payroll -> 'net_pay',
        'commission_amount', null
      );
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin',
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction),
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    -- 任務 3:按年月查詢本質上就是一個完整月份,固定 true(加上這個欄位只是為了讓兩支
    -- 函式的回傳形狀一致,前端不用分兩套處理)。
    'salary_applicable', true
  );
end;
$function$;

comment on function public.get_merchant_billing_summary(uuid, int, int) is '模組 8 §3.11 + §11.8(2026-09-24 使用者裁決三合一修補):店家端帳務報表,某商家某年月的營收/成本/抽成/薪資/概估毛利彙整。【任務 1】營收/稅金/料錢/訂單數的月份基準從 b.start_at 改成完成時間 coalesce(b.completed_at, b.start_at)(使用者裁決:「都已完成時間做依據」「完成代表收到錢…直到哪個月份按完成才歸在那個月」);抽成維持 bcr.computed_at,因為已查證它跟該訂單的 completed_at 完全相等且事後重算不會改動它。coalesce 的 fallback 只對「直接 INSERT、沒走 complete_booking」的歷史匯入訂單生效,是防禦性保留。【任務 2】per_staff_breakdown 與月薪扣款的母體從「現在 status=active」改成「該月月底當時 existed 且 status=active」,跟 private.get_merchant_monthly_salary_base_as_of(11.6)同一個 as_of、同一組條件,兩邊母體必然一致;compensation_type 也取那個時間點的值。這推翻 §11.9「不逐月還原歷史人員名單」的決策記錄,以使用者裁決「即便這個人離職,紀錄還是存在」為準。【任務 3】回傳新增 salary_applicable,按年月查詢固定 true。estimated_net_margin 明確只是概估毛利,不含房租水電等其他營運成本。SECURITY DEFINER,檢查 private.can_view_billing。';

revoke execute on function public.get_merchant_billing_summary(uuid, int, int) from public, anon;
grant execute on function public.get_merchant_billing_summary(uuid, int, int) to authenticated;

-- =========================================================================
-- §4 get_merchant_billing_summary_by_range(p_merchant_id, p_start_date, p_end_date):
--     ・營收/稅金/料錢/訂單數 → 改用完成時間(任務 1)
--     ・per_staff_breakdown 母體 → 改成「區間內任一月份當時在職」(任務 2)
--     ・新增 salary_applicable;非完整月份時月薪相關數字一律 null(任務 3)
-- =========================================================================
create or replace function public.get_merchant_billing_summary_by_range(
  p_merchant_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path to 'public'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_salary_applicable boolean;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_estimated_net_margin numeric(10, 2);
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC
  -- 查詢過大區間造成效能問題或撈出超出預期範圍的資料。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- =======================================================================
  -- 任務 3(使用者已回覆「可以」):月薪相關數字只在「完整月份」的查詢下才計算。
  -- 條件:起始日是某個月的 1 號,且結束日是某個月的最後一天(可以跨多個月,2/1–4/30 合法)。
  --   ・p_start_date 是 1 號          → date_trunc('month', p_start_date) = p_start_date
  --   ・p_end_date 是該月最後一天     → p_end_date + 1 天之後就會跨到下個月的 1 號
  -- 這同時消滅一個真的 bug:原本不論區間頭尾是不是完整月份,都用 generate_series 以「月初」
  -- 為單位展開,所以「查 2/15–3/15(29 天)」會收到 2 個整月的月薪基本額,而扣款那一邊
  -- (compute_staff_payroll_by_range)卻是按區間裁切的 → 兩邊口徑不一致,月薪實發沒有意義。
  -- =======================================================================
  v_salary_applicable := (
    p_start_date = date_trunc('month', p_start_date)::date
    and (p_end_date + 1) = date_trunc('month', (p_end_date + 1)::date)::date
  );

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  -- 2026-09-24(任務 1):月份/區間基準從 b.start_at 改成完成時間(理由見檔頭與 §3 的註解)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  select coalesce(sum(bmc.amount_snapshot), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持 computed_at(已查證 ≡ completed_at,且事後重算不改它,詳見檔頭)。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8(核心):比照 11.7 的「逐月迴圈」邏輯,對區間內每個月份呼叫 11.6,把每個月份的加總
  -- 結果再加總。只要任一月份任一人用到估算,salary_estimation_applied 就是 true。
  -- 2026-09-24(任務 3):只在 v_salary_applicable 為真時才算;不是完整月份時一律留 null
  -- (不是 0——前端要能分辨「不適用」與「真的是零」)。
  if v_salary_applicable then
    select
      coalesce(sum(gm.total_amount), 0),
      coalesce(bool_or(gm.is_estimated), false)
    into v_total_salary_base, v_salary_estimated
    from generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start)
    cross join lateral private.get_merchant_monthly_salary_base_as_of(
      p_merchant_id,
      ((least((m.month_start + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
        at time zone 'Asia/Taipei') - interval '1 microsecond'
    ) as gm;
  else
    v_total_salary_base := null;
    v_total_salary_deduction := null;
    v_salary_estimated := false;
  end if;

  -- 2026-09-24(任務 2):母體改成「區間內至少有一個月份,在該月的 as_of 時間點 existed 且
  -- status=active」的人——跟上面 11.6 逐月加總用的是同一套 as_of 算式(含 least(..., p_end_date)
  -- 的裁切)與同一組條件,兩邊母體必然一致。compensation_type 取「區間內最後一個當時在職月份」
  -- 的值(同一個人可能中途改過計酬類型;取最後一個月份跟 §11 一貫的「月底當下的值」慣例一致)。
  -- 這同時修掉一個附帶的對不起來:已離職的按件計酬人員,他的抽成一直都被算進
  -- total_commission_payout(那個查詢只看 merchant_id + computed_at,不看人員狀態),卻沒有
  -- 任何一列明細承載它。
  for rec in
    with months as (
      select
        gs::date as month_start,
        ((least((gs + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
          at time zone 'Asia/Taipei') - interval '1 microsecond' as as_of
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    staff_months as (
      select
        ms.id, ms.name, m.month_start, s.compensation_type,
        -- is_active_as_of 的來源:merchant_staff.status 是「目前」的狀態(語意說明見單月版註解)。
        (ms.status = 'active') as is_currently_active
      from public.merchant_staff ms
      cross join months m
      join lateral private.get_staff_payroll_status_as_of(ms.id, m.as_of) s on true
      where ms.merchant_id = p_merchant_id
        and s.existed
        and s.status = 'active'
    )
    select
      id,
      name,
      is_currently_active,
      (array_agg(compensation_type order by month_start desc))[1] as compensation_type
    from staff_months
    -- is_currently_active 對同一個 id 只有一個值(它來自 merchant_staff 那一列),放進 group by
    -- 只是為了讓它能被 select,不會讓分組變細。
    group by id, name, is_currently_active
    order by name
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      if v_salary_applicable then
        -- §3.6:跨月時依區間內實際涵蓋的每個月份分別計算「當月實際天數」再加總,不是整個區間套用
        -- 同一個天數——private.compute_staff_payroll_by_range 內部已經處理這個邏輯。
        v_payroll := private.compute_staff_payroll_by_range(rec.id, p_start_date, p_end_date);
        v_total_salary_deduction := v_total_salary_deduction
          + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', v_payroll -> 'net_pay',
          'commission_amount', null
        );
      else
        -- 任務 3:不是完整月份時,月薪制人員照樣列在明細上(order_count 仍然有意義),
        -- 但 net_pay 回 null,代表「這個區間算不出月薪實發」,不是「實發 0 元」。
        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', null,
          'commission_amount', null
        );
      end if;
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  -- 任務 3:商家總淨利(概估毛利)是「營收 − 料錢 − 抽成 − 月薪實發」,只要月薪那一段算不出來,
  -- 整個數字就沒有意義 → 一律 null,不是拿營收減一減硬湊一個數字出來給商家看。
  if v_salary_applicable then
    v_estimated_net_margin :=
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction);
  else
    v_estimated_net_margin := null;
  end if;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin', v_estimated_net_margin,
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    'salary_applicable', v_salary_applicable
  );
end;
$function$;

comment on function public.get_merchant_billing_summary_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6 + 模組 8 §11.8(2026-09-24 使用者裁決三合一修補):店家帳務報表區間版本。【任務 1】營收/稅金/料錢/訂單數的區間基準從 b.start_at 改成完成時間 coalesce(b.completed_at, b.start_at);抽成維持 bcr.computed_at(已查證 ≡ completed_at 且事後重算不改動它)。【任務 2】per_staff_breakdown 與月薪扣款的母體從「現在 status=active」改成「區間內至少有一個月份、在該月 as_of 時間點 existed 且 status=active」,跟 11.6 逐月加總用同一套 as_of 算式與同一組條件;compensation_type 取區間內最後一個當時在職月份的值。順帶修掉「已離職按件計酬人員的抽成算進總額卻沒有明細列承載」的對不起來。推翻 §11.9 的決策記錄,以使用者裁決為準。【任務 3】新增回傳欄位 salary_applicable boolean:只有「起始日是某月 1 號且結束日是某月最後一天」才是 true;false 時 total_monthly_salary_base / total_monthly_salary_deduction / estimated_net_margin 以及明細裡的 net_pay 一律回傳 null(不是 0,前端要能分辨「不適用」與「真的是零」),營收/稅金/料錢/抽成/訂單數照常計算。這同時消滅原本「查 2/15–3/15 會收到 2 個整月月薪基本額、扣款那邊卻按區間裁切」的跨月重複計算 bug。SECURITY DEFINER,檢查 private.can_view_billing,後端保留區間 > 366 天的例外保護。';

revoke execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) to authenticated;
