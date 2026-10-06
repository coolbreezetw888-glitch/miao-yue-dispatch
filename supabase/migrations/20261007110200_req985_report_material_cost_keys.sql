-- SPECS-INDEX #985 第 8 批 8-8 / 8-11(規格書 .project/specs/料錢是否影響抽成開關-第8批.md)。
-- 使用者 2026-10-07 回答 Q1「料錢一律店家付」⇒ 淨利公式不變,報表只做「透明化」:
--   8-8  店家報表兩支(月份版 / 區間版)尾端加三個資訊鍵:
--          material_cost_affects_commission_now、commission_orders_material_deducted_count、
--          commission_orders_material_not_deducted_count。
--   8-11 服務人員報表兩支(月份版 / 區間版)每筆 detail 加 material_cost_deducted。
-- 以目前本機(= repo 最新底稿)的函式本體為底逐字保留,只加上述內容;既有鍵一個都不改、
-- 權限判斷不動、簽章不變,ACL 重申。改前改後指紋(md5,CRLF→LF):
--   get_merchant_billing_summary: 8fc07eead91a4e06bb536a32c973ff63 → 1f5d530740b9f4e16bbd0aeb720ce6d7
--   get_merchant_billing_summary_by_range: 4d03da5ca1e8b9594c4353b458fc1a99 → 4fa1f54e54e43c8a2c1a58ee1e1a0813
--   get_staff_commission_summary: be135b7ed301e634bdf06c1f71350da0 → f749f986b84b8596479edb227073912b
--   get_staff_commission_summary_by_range: 5d3f1a01088d6f20a6a065fdeeffaee6 → 5c371d111e139731734f1f06dc92e4c4

CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
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
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
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

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

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
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count
  );
end;
$function$;

revoke execute on function public.get_merchant_billing_summary(uuid, integer, integer) from public, anon;
grant execute on function public.get_merchant_billing_summary(uuid, integer, integer) to authenticated;

CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary_by_range(p_merchant_id uuid, p_start_date date, p_end_date date)
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
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
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

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

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
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count
  );
end;
$function$;

revoke execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) to authenticated;

CREATE OR REPLACE FUNCTION public.get_staff_commission_summary(p_staff_id uuid, p_year integer, p_month integer)
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
      -- #985 第 8 批 8-11:這筆抽成先扣掉的料錢(gross 時 = 0,CHECK 已保證)。
      'material_cost_deducted', bcr.material_cost_deducted_snapshot,
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

revoke execute on function public.get_staff_commission_summary(uuid, integer, integer) from public, anon;
grant execute on function public.get_staff_commission_summary(uuid, integer, integer) to authenticated;

CREATE OR REPLACE FUNCTION public.get_staff_commission_summary_by_range(p_staff_id uuid, p_start_date date, p_end_date date)
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
      -- #985 第 8 批 8-11:這筆抽成先扣掉的料錢(gross 時 = 0,CHECK 已保證)。
      'material_cost_deducted', bcr.material_cost_deducted_snapshot,
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

revoke execute on function public.get_staff_commission_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_staff_commission_summary_by_range(uuid, date, date) to authenticated;
