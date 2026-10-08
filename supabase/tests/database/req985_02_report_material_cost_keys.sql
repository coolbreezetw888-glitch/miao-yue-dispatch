-- SPECS-INDEX #985 第 8 批(2026-10-07):報表透明化 8-8 / 8-11
-- migration 20261007110200_req985_report_material_cost_keys.sql
-- 規格書 .project/specs/料錢是否影響抽成開關-第8批.md 第三節、第八節。
--
--   ①~③  店家報表三個新資訊鍵(範例 D:期間中切換 ⇒ 3 / 2;期間判斷用 computed_at)
--   ④~⑥  店家報表既有鍵與「改前函式複製品」逐鍵相等:月份版、區間版、非完整月份、含月薪制人員
--   ⑦~⑩  服務人員報表每筆新鍵 material_cost_deducted;既有鍵與改前複製品相等
--   ⑪     服務人員本人看自己的明細也有新鍵(Q4)
--   ⑥-1   前提斷言:比對資料真的含月薪制人員
--   ⑫     ACL 重申
--
-- 下方 pg_temp.old_* 是 migration 套用前的函式本體(逐字,來源:本機 pg_get_functiondef,
-- 指紋 = 20261001020100 / 20261006130000 / 20260930030000 的底稿),只把名稱改成 pg_temp.old_*。
begin;

select plan(13);

CREATE OR REPLACE FUNCTION pg_temp.old_get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
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

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

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
    'salary_applicable', true,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled
  );
end;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.old_get_merchant_billing_summary_by_range(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
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

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

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
    'salary_applicable', v_salary_applicable,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled
  );
end;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.old_get_staff_commission_summary(p_staff_id uuid, p_year integer, p_month integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_month_start date;
  v_next_month_start date;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_details jsonb;
  v_total_orders int;
  v_total_amount numeric(10, 2);
  v_gross_amount numeric(10, 2);
  v_assistant_count int;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  -- SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心的抽成報表也走這支 ⇒ 允許條件 =
  -- 服務人員報表權限(can_view_payroll_reports,C-2 起只等於 staff_report)或 report_export,或服務人員本人。
  if not (
    private.can_view_payroll_reports(v_merchant_id)
    or private.can_export_reports(v_merchant_id)
    or private.can_view_staff_own_payroll(p_staff_id)
  ) then
    raise exception '沒有權限查詢這間商家的服務人員報表' using errcode = '42501';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_next_month_start := v_month_start + interval '1 month';
  v_range_start := v_month_start::timestamp at time zone 'Asia/Taipei';
  v_range_end := v_next_month_start::timestamp at time zone 'Asia/Taipei';

  -- #767:歸月基準是 bcr.computed_at(抽成快照產生的那一刻 = 按下完成的那一刻),
  -- 跟商家帳務報表的抽成支出用同一個欄位,兩張報表才逐筆對得上。
  -- 排序基準也一起換成 computed_at,跟篩選基準一致,否則「第一筆」的語意會亂掉。
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'booking_id', b.id,
      -- #780:誠實的欄位名(裝的是完成時間)。
      'completion_date', bcr.computed_at,
      -- ⚠️ #780 過渡期相容欄位:值跟 completion_date 完全相同,只是為了讓「資料庫先上、
      --    前端還是舊版」那段時間不會在畫面上印出 Invalid Date。移除已登記為 #783,
      --    前置條件是 `grep -rn "order_date" src/` 為空。**不要在 #783 之前自行拿掉。**
      'order_date', bcr.computed_at,
      'customer_name', b.customer_name,
      'commission_base_amount', bcr.commission_base_amount_snapshot,
      'commission_amount', bcr.commission_amount,
      'recalculated', bcr.recalculated_at is not null,
      'legacy_rate_percentage', bcr.commission_rate_percentage_snapshot,
      'item_breakdown', coalesce((
        select jsonb_agg(jsonb_build_object(
          'service_item_name', bcir.service_item_name_snapshot,
          'quantity', bcir.quantity_snapshot,
          'commission_mode', bcir.commission_mode_snapshot,
          'commission_value', bcir.commission_value_snapshot,
          'commission_amount', bcir.commission_amount
        ) order by bcir.created_at)
        from public.booking_commission_item_records bcir
        where bcir.commission_record_id = bcr.id
      ), '[]'::jsonb)
    ) order by bcr.computed_at), '[]'::jsonb),
    count(*)::int,
    coalesce(sum(bcr.commission_amount), 0),
    coalesce(sum(b.final_amount_snapshot), 0)
  into v_details, v_total_orders, v_total_amount, v_gross_amount
  from public.booking_commission_records bcr
  join public.bookings b on b.id = bcr.booking_id
  where bcr.staff_id = p_staff_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- 🔴 #779:助手參與筆數**刻意**用 coalesce(b.completed_at, b.start_at),不是 bcr.computed_at
  --    —— 助手的訂單不會產生 commission record,這裡根本 join 不到 bcr,沒有 computed_at 可用。
  --    這不是筆誤,請不要順手統一成上面那個欄位(統一的後果是這個數字永遠變 0)。
  select count(*)::int into v_assistant_count
  from public.booking_assistants ba
  join public.bookings b on b.id = ba.booking_id
  where ba.staff_id = p_staff_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  return jsonb_build_object(
    'details', v_details,
    'total_orders', v_total_orders,
    'total_commission_amount', v_total_amount,
    'assistant_booking_count', v_assistant_count,
    'total_amount', v_gross_amount
  );
end;
$function$;

CREATE OR REPLACE FUNCTION pg_temp.old_get_staff_commission_summary_by_range(p_staff_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_details jsonb;
  v_total_orders int;
  v_total_amount numeric(10, 2);
  v_gross_amount numeric(10, 2);
  v_assistant_count int;
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的服務人員報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- #767:跟單月版完全相同的基準(bcr.computed_at),排序也一起換。
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'booking_id', b.id,
      -- #780:誠實的欄位名(裝的是完成時間)。
      'completion_date', bcr.computed_at,
      -- ⚠️ #780 過渡期相容欄位,移除登記為 #783。理由同單月版,不要提前拿掉。
      'order_date', bcr.computed_at,
      'customer_name', b.customer_name,
      'commission_base_amount', bcr.commission_base_amount_snapshot,
      'commission_amount', bcr.commission_amount,
      'recalculated', bcr.recalculated_at is not null,
      'legacy_rate_percentage', bcr.commission_rate_percentage_snapshot,
      'item_breakdown', coalesce((
        select jsonb_agg(jsonb_build_object(
          'service_item_name', bcir.service_item_name_snapshot,
          'quantity', bcir.quantity_snapshot,
          'commission_mode', bcir.commission_mode_snapshot,
          'commission_value', bcir.commission_value_snapshot,
          'commission_amount', bcir.commission_amount
        ) order by bcir.created_at)
        from public.booking_commission_item_records bcir
        where bcir.commission_record_id = bcr.id
      ), '[]'::jsonb)
    ) order by bcr.computed_at), '[]'::jsonb),
    count(*)::int,
    coalesce(sum(bcr.commission_amount), 0),
    coalesce(sum(b.final_amount_snapshot), 0)
  into v_details, v_total_orders, v_total_amount, v_gross_amount
  from public.booking_commission_records bcr
  join public.bookings b on b.id = bcr.booking_id
  where bcr.staff_id = p_staff_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- 🔴 #779:同單月版,助手參與筆數刻意用 coalesce(b.completed_at, b.start_at),不是
  --    bcr.computed_at(助手訂單不進 booking_commission_records)。不要順手統一。
  select count(*)::int into v_assistant_count
  from public.booking_assistants ba
  join public.bookings b on b.id = ba.booking_id
  where ba.staff_id = p_staff_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  return jsonb_build_object(
    'details', v_details,
    'total_orders', v_total_orders,
    'total_commission_amount', v_total_amount,
    'assistant_booking_count', v_assistant_count,
    'total_amount', v_gross_amount
  );
end;
$function$;


-- 只換 auth.uid(),連線角色維持 postgres(改前複製品是 pg_temp 函式,用同一個身分呼叫新舊兩版)。
create function pg_temp.test_set_uid(p_user_id uuid)
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
end;
$$;

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- ── Fixture ───────────────────────────────────────────────────────────────
--   01 A 店管理員 / 05 服務人員 P(按件、可登入)/ 07 月薪制服務人員 M
insert into auth.users (id, email) values
  ('f9851000-0000-4000-8000-000000000001', 'pgtap-r985b-admin@test.local'),
  ('f9851000-0000-4000-8000-000000000005', 'pgtap-r985b-staff@test.local');
insert into groups (id) values ('f9851000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values
  ('f9851000-0000-4000-8000-000000000020', 'f9851000-0000-4000-8000-000000000011', '#985 報表店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f9851000-0000-4000-8000-000000000020', 'f9851000-0000-4000-8000-000000000001', '店主');
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9851000-0000-4000-8000-000000000031', 'f9851000-0000-4000-8000-000000000020', 'S1', 3000, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9851000-0000-4000-8000-000000000050', 'f9851000-0000-4000-8000-000000000020', '現金');
insert into material_cost_items (id, merchant_id, name, amount) values
  ('f9851000-0000-4000-8000-000000000060', 'f9851000-0000-4000-8000-000000000020', 'M500', 500);
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('f9851000-0000-4000-8000-000000000020', 'material_cost_enabled', true);
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone) values
  ('f9851000-0000-4000-8000-000000000040', 'f9851000-0000-4000-8000-000000000020', 'f9851000-0000-4000-8000-000000000005', '服務人員P', 'piece_rate', 'active', 'active', now(), true, '0900985140');
insert into merchant_staff (id, merchant_id, name, compensation_type, status, unlimited_backend_edit, phone, created_at) values
  ('f9851000-0000-4000-8000-000000000041', 'f9851000-0000-4000-8000-000000000020', '服務人員M', 'monthly_salary', 'active', true, '0900985141', now() - interval '400 days');
update merchant_staff set created_at = now() - interval '400 days' where id = 'f9851000-0000-4000-8000-000000000040';
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9851000-0000-4000-8000-000000000040', 'staff_payroll_view', true);
insert into staff_salary_settings (staff_id, monthly_base_salary) values
  ('f9851000-0000-4000-8000-000000000041', 30000);
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('f9851000-0000-4000-8000-000000000040', 'f9851000-0000-4000-8000-000000000031', 'percentage', 40);

create function pg_temp.mk(p_start timestamptz)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9851000-0000-4000-8000-000000000020',
    p_staff_id => 'f9851000-0000-4000-8000-000000000040',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9851000-0000-4000-8000-000000000031','quantity',1,'unit_price',3000)),
    p_start_at => p_start,
    p_customer_name => '王先生',
    p_customer_phone => '0955985100',
    p_customer_address => '台北市測試路 851 號',
    p_material_cost_items => '[{"material_cost_item_id":"f9851000-0000-4000-8000-000000000060","quantity":1}]'::jsonb,
    p_payment_method_id => 'f9851000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(timestamptz) to authenticated;
create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;
grant execute on function pg_temp.done(uuid) to authenticated;

-- 範例 D:開啟時完成 3 筆、切關閉後完成 2 筆(全部在本月);另外一筆開啟時完成、但把完成時間
-- 挪到上個月(期間外,不能被算進本月計數)。訂單的預約時間(start_at)故意放在 2036 年,
-- 所以若計數改用 start_at 判斷期間,本月數字會變 0(故障注入用)。
select pg_temp.test_set_auth('f9851000-0000-4000-8000-000000000001');
select public.set_material_cost_affects_commission('f9851000-0000-4000-8000-000000000020', true);
select pg_temp.mk('2036-08-01 09:00+08') as id \gset d1_
select pg_temp.mk('2036-08-01 11:00+08') as id \gset d2_
select pg_temp.mk('2036-08-01 14:00+08') as id \gset d3_
select pg_temp.mk('2036-08-02 09:00+08') as id \gset d4_
select pg_temp.mk('2036-08-02 11:00+08') as id \gset d5_
select pg_temp.mk('2036-08-03 09:00+08') as id \gset d6_
select pg_temp.done(:'d1_id'::uuid);
select pg_temp.done(:'d2_id'::uuid);
select pg_temp.done(:'d3_id'::uuid);
select pg_temp.done(:'d6_id'::uuid);
select public.set_material_cost_affects_commission('f9851000-0000-4000-8000-000000000020', false);
select pg_temp.done(:'d4_id'::uuid);
select pg_temp.done(:'d5_id'::uuid);
reset role;
update booking_commission_records
set computed_at = date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei' - interval '2 days'
where booking_id = :'d6_id'::uuid;
update bookings
set completed_at = date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei' - interval '2 days'
where id = :'d6_id'::uuid;

-- 本月(台北時間)與區間。
create temp table r985p on commit drop as
select
  extract(year from now() at time zone 'Asia/Taipei')::int as y,
  extract(month from now() at time zone 'Asia/Taipei')::int as m,
  date_trunc('month', now() at time zone 'Asia/Taipei')::date as ms,
  (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month - 1 day')::date as me,
  (now() at time zone 'Asia/Taipei')::date as today;
select y, m, ms, me, today from r985p \gset p_

select pg_temp.test_set_uid('f9851000-0000-4000-8000-000000000001');

-- 新函式結果、改前複製品結果。
create temp table r985n on commit drop as select
  public.get_merchant_billing_summary('f9851000-0000-4000-8000-000000000020', :p_y, :p_m) as bm,
  pg_temp.old_get_merchant_billing_summary('f9851000-0000-4000-8000-000000000020', :p_y, :p_m) as obm,
  public.get_merchant_billing_summary_by_range('f9851000-0000-4000-8000-000000000020', :'p_ms'::date, :'p_me'::date) as br,
  pg_temp.old_get_merchant_billing_summary_by_range('f9851000-0000-4000-8000-000000000020', :'p_ms'::date, :'p_me'::date) as obr,
  public.get_merchant_billing_summary_by_range('f9851000-0000-4000-8000-000000000020', :'p_today'::date - 1, :'p_today'::date + 1) as bp,
  pg_temp.old_get_merchant_billing_summary_by_range('f9851000-0000-4000-8000-000000000020', :'p_today'::date - 1, :'p_today'::date + 1) as obp,
  public.get_staff_commission_summary('f9851000-0000-4000-8000-000000000040', :p_y, :p_m) as sm,
  pg_temp.old_get_staff_commission_summary('f9851000-0000-4000-8000-000000000040', :p_y, :p_m) as osm,
  public.get_staff_commission_summary_by_range('f9851000-0000-4000-8000-000000000040', :'p_ms'::date, :'p_me'::date) as sr,
  pg_temp.old_get_staff_commission_summary_by_range('f9851000-0000-4000-8000-000000000040', :'p_ms'::date, :'p_me'::date) as osr;

create function pg_temp.strip_bill(j jsonb) returns jsonb language sql as $$
  select j - 'material_cost_affects_commission_now' - 'commission_orders_material_deducted_count' - 'commission_orders_material_not_deducted_count';
$$;
-- 客戶端第 3 批(主腦裁決):帳單報表 per_staff_breakdown 改依服務人員順位排序(改前複製品依姓名)⇒
--   比對前兩邊都依 staff_name、staff_id 重新排序,只比內容不比順序(順序由 c3_staff_order H04-5/6 另外測)。
create function pg_temp.norm_bill(j jsonb) returns jsonb language sql as $$
  select case when jsonb_typeof(j -> 'per_staff_breakdown') = 'array' then jsonb_set(j, '{per_staff_breakdown}', coalesce((
    select jsonb_agg(e order by e ->> 'staff_name', e ->> 'staff_id')
    from jsonb_array_elements(j -> 'per_staff_breakdown') e), '[]'::jsonb)) else j end;
$$;
create function pg_temp.strip_staff(j jsonb) returns jsonb language sql as $$
  select jsonb_set(j, '{details}', coalesce((
    select jsonb_agg(e - 'material_cost_deducted' order by ord)
    from jsonb_array_elements(j -> 'details') with ordinality as t(e, ord)), '[]'::jsonb));
$$;

-- =========================================================================
-- ①~⑥ 店家報表 8-8
-- =========================================================================
select is((select bm ->> 'commission_orders_material_deducted_count' || '/' || (bm ->> 'commission_orders_material_not_deducted_count') from r985n),
  '3/2', '① 月份版:範例 D ⇒ 先扣料錢 3 筆、沒扣 2 筆(期間外那筆不算)');
select is((select br ->> 'commission_orders_material_deducted_count' || '/' || (br ->> 'commission_orders_material_not_deducted_count') from r985n),
  '3/2', '② 區間版:同一個月 ⇒ 3 / 2');
select is((select (bm ->> 'material_cost_affects_commission_now') || '/' || (br ->> 'material_cost_affects_commission_now') from r985n),
  'false/false', '③ 目前設定 = 關閉(兩支都回)');
select is((select pg_temp.norm_bill(pg_temp.strip_bill(bm)) = pg_temp.norm_bill(obm) from r985n), true, '④ 月份版:既有鍵與改前複製品逐鍵相等(含月薪制人員)');
select is((select pg_temp.norm_bill(pg_temp.strip_bill(br)) = pg_temp.norm_bill(obr) from r985n), true, '⑤ 區間版(完整月份):既有鍵與改前複製品逐鍵相等');
select is((select (pg_temp.norm_bill(pg_temp.strip_bill(bp)) = pg_temp.norm_bill(obp))::text || '/' || coalesce(bp ->> 'estimated_net_margin', 'null') || '/' || (bp ->> 'salary_applicable') from r985n),
  'true/null/false', '⑥ 區間版(非完整月份):既有鍵相等、淨利照舊是 null');

select is((select count(*)::int from r985n, jsonb_array_elements(bm -> 'per_staff_breakdown') e
           where e ->> 'compensation_type' = 'monthly_salary' and e -> 'net_pay' is not null and e -> 'net_pay' <> 'null'::jsonb),
  1, '⑥-1 前提:比對情境裡真的含月薪制人員(避免空資料假通過)');

-- =========================================================================
-- ⑦~⑪ 服務人員報表 8-11
-- =========================================================================
select is((select string_agg(e ->> 'material_cost_deducted', ',' order by e ->> 'material_cost_deducted' desc) from r985n, jsonb_array_elements(sm -> 'details') e),
  '500.00,500.00,500.00,0.00,0.00', '⑦ 月份版每筆 material_cost_deducted:開啟時 500、關閉時 0');
select is((select string_agg(e ->> 'material_cost_deducted', ',' order by e ->> 'material_cost_deducted' desc) from r985n, jsonb_array_elements(sr -> 'details') e),
  '500.00,500.00,500.00,0.00,0.00', '⑧ 區間版同上');
select is((select pg_temp.strip_staff(sm) = osm from r985n), true, '⑨ 月份版:既有鍵與改前複製品逐鍵相等');
select is((select pg_temp.strip_staff(sr) = osr from r985n), true, '⑩ 區間版:既有鍵與改前複製品逐鍵相等');

-- Q4:服務人員本人看自己的薪資明細也看得到扣除料錢(權限判斷不動,本人原本就能查)。
select pg_temp.test_set_uid('f9851000-0000-4000-8000-000000000005');
select is((select count(*)::int from jsonb_array_elements(public.get_staff_commission_summary('f9851000-0000-4000-8000-000000000040', :p_y, :p_m) -> 'details') e
           where e ? 'material_cost_deducted'),
  5, '⑪ 服務人員本人查自己的明細也有 material_cost_deducted');

-- ⑫ ACL 重申:四支報表函式 anon 沒有 EXECUTE、authenticated 有。
reset role;
select is((select count(*)::int from pg_proc p
           where p.oid in ('public.get_merchant_billing_summary(uuid,integer,integer)'::regprocedure,
                           'public.get_merchant_billing_summary_by_range(uuid,date,date)'::regprocedure,
                           'public.get_staff_commission_summary(uuid,integer,integer)'::regprocedure,
                           'public.get_staff_commission_summary_by_range(uuid,date,date)'::regprocedure)
             and not has_function_privilege('anon', p.oid, 'execute')
             and has_function_privilege('authenticated', p.oid, 'execute')),
  4, '⑫ 四支報表函式:anon 沒有 EXECUTE、authenticated 有');

select * from finish();
rollback;
