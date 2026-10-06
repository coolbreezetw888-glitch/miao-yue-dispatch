-- SPECS-INDEX #976 第 3 批(2026-10-06):前後端權限不一致收緊(規格書「權限收緊與服務人員開關修正-第3批」第一節)。
-- 原則:後端權限 = 畫面允許的範圍,不多也不少。
--
-- ═══ 表 C-1:稅金與功能開關各歸各的頁面 ════════════════════════════════════════════════
-- 改前:只有「營業時間設定」(business_hours)的客服,資料庫層可以改稅金、改所有功能開關(含料錢總開關)。
-- 改後:
--   ・merchant_tax_settings 寫入(INSERT / UPDATE)只給 can_manage_payment_methods(稅金設定在付款方式管理頁)。
--     讀取(SELECT)= can_manage_payment_methods 或 can_manage_bookings:
--       建單 / 改單表單(CalendarPage 的 useMerchantTaxSettings)要讀商家稅金當預設值,畫面本來就給訂單權限的人看;
--       營業時間頁不顯示稅金 ⇒ 拿掉 business_hours。
--       📌 這裡比改前**多放行**「只有訂單權限」的客服讀稅金(改前他們讀不到,表單會靜默帶入預設 5%,是既有落差)。
--          欄位只有 tax_mode / tax_value 兩個設定值,不含個資。已寫進回報請主腦確認。
--   ・merchant_feature_flags 寫入(INSERT / UPDATE)逐一對應開關所在頁面的權限:
--       strict_conflict_check(嚴格工時衝突檢查,營業時間設定頁)→ can_manage_business_hours
--       material_cost_enabled(料錢功能總開關,料錢成本管理頁)→ can_manage_material_costs
--       其他任何 feature_key → 只有商家管理員(目前沒有任何頁面寫其他 key;產業預設由
--       apply_industry_preset 以 SECURITY DEFINER 寫入,不受這條政策影響)
--     UPDATE 的 using 判斷「改前那一列」、with check 判斷「改後那一列」⇒ 把 strict_conflict_check 那一列的
--     feature_key 改成 material_cost_enabled 也要同時過兩把鑰匙,不會借道。
--     SELECT 不動(建單要讀料錢開關、嚴格衝突;沒有敏感資料)。
--   ・其他頁面的開關(紅利啟用、會員政策、LINE / 推播事件開關、建單時間間隔)盤點後已經各歸各的,本檔不動,
--     盤點表在回報。
--
-- ═══ 表 C-2:服務人員報表資料只給 staff_report ═══════════════════════════════════════════
-- 改前:private.can_view_payroll_reports = can_view_billing or can_view_staff_report
--       ⇒「店家報表」(billing)權限的客服可以直接打 get_staff_commission_summary / get_staff_monthly_payroll_summary
--         (含 _by_range)、讀 booking_commission_records / booking_commission_item_records /
--         staff_payroll_status_history 整列、讀 merchant_staff 整列;畫面上卻只有 staff_report 進得去。
-- 改後:can_view_payroll_reports = can_view_staff_report(管理員包含在內)。函式名稱不改(4 支 RPC + 4 條政策
--       都引用它,改名牽動太大);店家報表的兩支 get_merchant_billing_summary(_by_range)仍只看 can_view_billing,不動。
--       已查:前端沒有任何地方直接讀上述三張表;店家報表頁只呼叫 get_merchant_billing_summary_by_range。
--
-- ═══ 表 C-3:報表匯出中心後端也檢查 report_export ════════════════════════════════════════
-- 改前:匯出中心四種報表直接讀 bookings / members / staff_leave_records / merchant_leave_types /
--       merchant_staff(表層 RLS)+ get_staff_commission_summary,後端**沒有任何地方**看 report_export:
--       ・只有 report_export 的客服:進得去頁面,但四份報表全部是空檔或被跳過(資料讀不到);
--       ・沒有 report_export、但有訂單 / 會員權限的客服:打 API 一樣拿得到同一批資料(那是他們自己頁面的權限)。
-- 改後(畫面怎麼放行,後端就怎麼放行 —— 匯出中心的畫面守衛是「管理員或 report_export」):
--   ・新增 private.can_export_reports(merchant) = 管理員 或 report_export。
--   ・訂單 / 會員 / 請假三份報表與服務人員下拉,改走新的唯讀 SECURITY DEFINER 函式,只回傳 CSV 需要的欄位:
--       export_orders_report / export_members_report / export_leave_report / list_report_export_staff
--     **不**把 report_export 加進 bookings / members 等表層 SELECT 政策 —— 表層政策給的是整列
--     (supabase-permission-hygiene「表層 RLS 的欄位範圍」),會讓匯出權限順便拿到 email、生日、私人備註等。
--     回傳 jsonb(單一值)而不是 setof:不受 PostgREST db.max_rows=1000 截斷,前端不用再分頁迴圈。
--   ・抽成報表跟「服務人員報表」頁共用 get_staff_commission_summary(uuid,int,int)⇒ 允許條件改成
--     「can_view_payroll_reports(= staff_report)或 can_export_reports 或服務人員本人」。
--     _by_range 與 get_staff_monthly_payroll_summary(_by_range)匯出中心沒用到,不加 report_export。
--   ・各報表頁原本的權限(orders / members / team_leave / staff_report)不受影響:他們的頁面走原本的表 / 函式。
--
-- 表 C-4(排班一覽網址)是純前端,不在本檔。

-- =========================================================================
-- C-1 merchant_tax_settings:寫入只給付款方式管理
-- =========================================================================
drop policy if exists merchant_tax_settings_select on public.merchant_tax_settings;
create policy merchant_tax_settings_select on public.merchant_tax_settings
  for select to authenticated
  using (
    private.can_manage_payment_methods(merchant_id)
    or private.can_manage_bookings(merchant_id)
  );

drop policy if exists merchant_tax_settings_insert on public.merchant_tax_settings;
create policy merchant_tax_settings_insert on public.merchant_tax_settings
  for insert to authenticated
  with check (private.can_manage_payment_methods(merchant_id));

drop policy if exists merchant_tax_settings_update on public.merchant_tax_settings;
create policy merchant_tax_settings_update on public.merchant_tax_settings
  for update to authenticated
  using (private.can_manage_payment_methods(merchant_id))
  with check (private.can_manage_payment_methods(merchant_id));

-- =========================================================================
-- C-1 merchant_feature_flags:每個開關只對應它所屬頁面的權限
-- =========================================================================
drop policy if exists merchant_feature_flags_insert on public.merchant_feature_flags;
create policy merchant_feature_flags_insert on public.merchant_feature_flags
  for insert to authenticated
  with check (
    private.is_merchant_admin(merchant_id)
    or (feature_key = 'strict_conflict_check' and private.can_manage_business_hours(merchant_id))
    or (feature_key = 'material_cost_enabled' and private.can_manage_material_costs(merchant_id))
  );

drop policy if exists merchant_feature_flags_update on public.merchant_feature_flags;
create policy merchant_feature_flags_update on public.merchant_feature_flags
  for update to authenticated
  using (
    private.is_merchant_admin(merchant_id)
    or (feature_key = 'strict_conflict_check' and private.can_manage_business_hours(merchant_id))
    or (feature_key = 'material_cost_enabled' and private.can_manage_material_costs(merchant_id))
  )
  with check (
    private.is_merchant_admin(merchant_id)
    or (feature_key = 'strict_conflict_check' and private.can_manage_business_hours(merchant_id))
    or (feature_key = 'material_cost_enabled' and private.can_manage_material_costs(merchant_id))
  );

-- =========================================================================
-- C-2 private.can_view_payroll_reports:只看 staff_report(管理員包含在 can_view_staff_report 裡)
-- 簽章不變(create or replace,ACL 保留;下面仍整組重寫一次)。
-- =========================================================================
create or replace function private.can_view_payroll_reports(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- SPECS-INDEX #976 C-2(2026-10-06):拿掉 can_view_billing。「店家報表」權限只看得到店家報表
  -- (get_merchant_billing_summary 系列,另外用 can_view_billing 檢查),服務人員報表資料只給 staff_report。
  select private.can_view_staff_report(p_merchant_id);
$$;

comment on function private.can_view_payroll_reports(uuid) is 'SPECS-INDEX #976 C-2(2026-10-06):服務人員報表資料(抽成 / 薪資明細 RPC、booking_commission_records 等表層 SELECT)的權限判斷 = can_view_staff_report(管理員或 staff_report 客服)。改前多放行 can_view_billing,已收緊。';

-- RLS 政策會在呼叫者身分下執行這支函式 ⇒ authenticated 必須保有 EXECUTE(比照其他 private.can_* 的既有 ACL)。
revoke execute on function private.can_view_payroll_reports(uuid) from public, anon;
grant execute on function private.can_view_payroll_reports(uuid) to authenticated;

-- =========================================================================
-- C-3 private.can_export_reports:報表匯出中心(管理員或 report_export)
-- =========================================================================
create or replace function private.can_export_reports(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'report_export'
        and map.granted = true
    );
$$;

comment on function private.can_export_reports(uuid) is 'SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心的後端權限 = 商家管理員,或 report_export 權限開啟的在職客服。跟前端 RequireReportExportAccess 同一個判斷。';

revoke execute on function private.can_export_reports(uuid) from public, anon;
grant execute on function private.can_export_reports(uuid) to authenticated;

-- =========================================================================
-- C-3 匯出中心:服務人員下拉(抽成 / 請假兩個分頁共用)
-- 回傳跟 useMerchantStaffList 相同的範圍與順序:這間商家 status='active' 的服務人員,依姓名排序。只給 id / name。
-- =========================================================================
create or replace function public.list_report_export_staff(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not private.can_export_reports(p_merchant_id) then
    raise exception '沒有權限使用這間商家的報表匯出中心' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object('id', ms.id, 'name', ms.name) order by ms.name)
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id
      and ms.status = 'active'
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_report_export_staff(uuid) is 'SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心的服務人員下拉選項(在職服務人員的 id / name,依姓名排序)。權限 private.can_export_reports。唯讀。';

revoke execute on function public.list_report_export_staff(uuid) from public, anon;
grant execute on function public.list_report_export_staff(uuid) to authenticated;

-- =========================================================================
-- C-3 匯出中心:訂單報表
-- 篩選語意跟改前 fetchMerchantBookings(…, { startAt, endAt, status, unpaged }) 相同:
--   start_at >= p_start_at(有帶才篩)、start_at < p_end_at(有帶才篩)、status = p_status(有帶才篩),
--   依 start_at 由早到晚。p_start_at / p_end_at 型別是 timestamptz,前端照舊傳「YYYY-MM-DDTHH:MI:SS」字串,
--   由同一個資料庫連線時區轉換,結果跟改前的 PostgREST 篩選一致。
-- 只回傳 CSV 的 7 個欄位。
-- =========================================================================
create or replace function public.export_orders_report(
  p_merchant_id uuid,
  p_start_at timestamptz default null,
  p_end_at timestamptz default null,
  p_status text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not private.can_export_reports(p_merchant_id) then
    raise exception '沒有權限使用這間商家的報表匯出中心' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', b.id,
        'customer_name', b.customer_name,
        'customer_phone', b.customer_phone,
        'start_at', b.start_at,
        'status', b.status,
        'final_amount_snapshot', b.final_amount_snapshot,
        'source', b.source
      )
      order by b.start_at, b.id
    )
    from public.bookings b
    where b.merchant_id = p_merchant_id
      and (p_start_at is null or b.start_at >= p_start_at)
      and (p_end_at is null or b.start_at < p_end_at)
      and (p_status is null or b.status = p_status)
  ), '[]'::jsonb);
end;
$$;

comment on function public.export_orders_report(uuid, timestamptz, timestamptz, text) is 'SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心「訂單報表」。只回傳 CSV 欄位(id、客戶姓名、客戶電話、預約時間、狀態、訂單金額、來源)。權限 private.can_export_reports。唯讀。';

revoke execute on function public.export_orders_report(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.export_orders_report(uuid, timestamptz, timestamptz, text) to authenticated;

-- =========================================================================
-- C-3 匯出中心:會員報表
-- 範圍跟改前 fetchMerchantMembersList(merchantId, "", true) 相同:這間商家全部會員(不分狀態),依建立時間由新到舊。
-- 只回傳 CSV 的 6 個欄位的原始值(會員類型由前端用 memberIdentityStatusLabel 轉中文,跟名單頁同一份)。
-- =========================================================================
create or replace function public.export_members_report(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not private.can_export_reports(p_merchant_id) then
    raise exception '沒有權限使用這間商家的報表匯出中心' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'name', m.name,
        'phone', m.phone,
        'referral_code', m.referral_code,
        'points_balance', m.points_balance,
        'status', m.status,
        'identity_verified_at', m.identity_verified_at
      )
      order by m.created_at desc, m.id
    )
    from public.members m
    where m.merchant_id = p_merchant_id
  ), '[]'::jsonb);
end;
$$;

comment on function public.export_members_report(uuid) is 'SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心「會員報表」。只回傳 CSV 欄位(姓名、電話、推薦碼、點數餘額、狀態、身分驗證時間)。權限 private.can_export_reports。唯讀。';

revoke execute on function public.export_members_report(uuid) from public, anon;
grant execute on function public.export_members_report(uuid) to authenticated;

-- =========================================================================
-- C-3 匯出中心:請假報表
-- 篩選語意跟改前 fetchStaffLeaveRecords({ staffId, startDateFrom, startDateTo }) 相同:
--   staff_id = p_staff_id(有帶才篩)、end_date >= p_start_date_from、start_date <= p_start_date_to,依 start_date 由新到舊。
-- 📌 改前那支查詢沒有限定商家(靠表層 RLS),同時管理兩間店的人會匯出到另一間店的請假;這裡明確限定這間商家。
-- 姓名對照跟改前前端的做法一致:
--   staff_name = 這間商家「在職」服務人員的姓名(改前用在職名單對照,不在名單上的顯示 id ⇒ 這裡回 null,前端退回 id);
--   leave_type_name = 這間商家全部假別(含已下架)的名稱。
-- =========================================================================
create or replace function public.export_leave_report(
  p_merchant_id uuid,
  p_staff_id uuid default null,
  p_start_date_from date default null,
  p_start_date_to date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not private.can_export_reports(p_merchant_id) then
    raise exception '沒有權限使用這間商家的報表匯出中心' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'staff_id', slr.staff_id,
        'staff_name', case when ms.status = 'active' then ms.name else null end,
        'leave_type_id', slr.leave_type_id,
        'leave_type_name', mlt.name,
        'start_date', slr.start_date,
        'end_date', slr.end_date,
        'status', slr.status,
        'notes', slr.notes
      )
      order by slr.start_date desc, slr.id
    )
    from public.staff_leave_records slr
    join public.merchant_staff ms on ms.id = slr.staff_id
    left join public.merchant_leave_types mlt
      on mlt.id = slr.leave_type_id and mlt.merchant_id = p_merchant_id
    where ms.merchant_id = p_merchant_id
      and (p_staff_id is null or slr.staff_id = p_staff_id)
      and (p_start_date_from is null or slr.end_date >= p_start_date_from)
      and (p_start_date_to is null or slr.start_date <= p_start_date_to)
  ), '[]'::jsonb);
end;
$$;

comment on function public.export_leave_report(uuid, uuid, date, date) is 'SPECS-INDEX #976 C-3(2026-10-06):報表匯出中心「請假報表」。只回傳 CSV 需要的欄位與姓名 / 假別名稱對照。限定這間商家。權限 private.can_export_reports。唯讀。';

revoke execute on function public.export_leave_report(uuid, uuid, date, date) from public, anon;
grant execute on function public.export_leave_report(uuid, uuid, date, date) to authenticated;

-- =========================================================================
-- C-3 get_staff_commission_summary(uuid,int,int):服務人員報表頁與匯出中心共用 ⇒ 多放行 can_export_reports。
-- 以 20260930030000_req878_payroll_reports_terminology_fix.sql 的定義為底,只改權限判斷那一行。
-- =========================================================================
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
grant execute on function public.get_staff_commission_summary(uuid, integer, integer) to service_role;
