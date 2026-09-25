-- 服務人員抽成報表:歸月基準從「預約時間」改成「完成時間」(SPECS-INDEX #767/#779/#780/#782,
-- 規格書 .project/specs/服務人員報表歸月基準修正.md)。
--
-- =========================================================================
-- 【為什麼要改】
-- 2026-09-24 使用者裁決原文:
--   「都已完成的那一刻計算才是正確的,因為完成代表收到錢,若訂單在 9 月但未完成代表他在 9 月
--     還沒收到錢,理當訂單也尚未完成,直到哪個月份按完成才歸在那個月(**抽成同理**)。」
--   (主腦已明確提醒「這會讓歷史報表數字變動」,使用者回覆:確定。)
--
-- 括號裡的「抽成同理」上一批(20260924040000)只做到**商家帳務報表**那一側:
--   get_merchant_billing_summary / _by_range 的營收/稅金/料錢/訂單數改用
--   coalesce(b.completed_at, b.start_at),抽成支出改用 bcr.computed_at。
-- **服務人員這一側的兩支函式沒有跟著改**,還在用 b.start_at。結果是同一筆錢:
--   商家的帳務報表算 10 月、服務人員自己的薪資報表算 9 月。
--   而且商家管理員可以從帳務報表的人員明細直接點「查看明細 →」跳到服務人員報表
--   (BillingReportPage.tsx 的 <Link to="/app/staff-report?staffId=…&year=…&month=…">),
--   於是會看到「帳務報表說張師傅本月抽成 200 元」→ 點下去 →「0 筆訂單」。
--
-- =========================================================================
-- 【#767:抽成主查詢用 bcr.computed_at —— 不是 coalesce(b.completed_at, b.start_at)】
--
-- 🔴 商家那一側的**抽成**(get_merchant_billing_summary_by_range 的 total_commission_payout
--    與 per_staff_breakdown 每人抽成)用的就是 bcr.computed_at。服務人員這一側必須用**完全
--    同一個欄位**,兩邊才會逐筆逐分逐秒對得上。改成 coalesce(b.completed_at, b.start_at) 在
--    絕大多數情況也會相等,但那是「剛好」不是「保證」——只要有任何一條路徑讓兩者分岔,
--    對帳就又壞了,而且更難查。
--
-- 為什麼 bcr.computed_at 可以信(2026-09-25 對正式庫 wjtbmmnakcriuaqoknsq 唯讀複驗,49 筆):
--   total_records=49、booking_completed_at_null=0、from_import=0、
--   computed_ne_completed=0(computed_at 與 completed_at 完全相等到微秒)、diff_month=0。
--   原因:complete_booking() 在**同一個交易**裡先 completed_at = now() 再 perform
--   compute_booking_commission(),而 booking_commission_records.computed_at 欄位預設就是
--   now() —— 同一個交易裡 now() 是固定值。recalculate_booking_commission 完全沒有碰
--   computed_at,所以事後人工重算不會把抽成搬月份。
--   from_import=0 ⇒ 匯入的歷史訂單不會產生 commission record,所以商家那一側為了匯入資料
--   而加的 coalesce(..., b.start_at) 保險,在「抽成」這條路上用不到。
--
-- =========================================================================
-- 【#779:助手參與筆數用 coalesce(b.completed_at, b.start_at) —— 🔴 這不是筆誤】
--
-- 🔴 這一條**刻意**跟 #767 用不同的欄位,請不要「順手統一」成 bcr.computed_at。
--    理由:以助手身份參與的訂單**不會產生 commission record**
--    (supabase/tests/database/module8_01_payroll_billing.sql 早就有這條既有斷言),
--    這個查詢根本 join 不到 booking_commission_records,**沒有 computed_at 可用**。
--    統一成 computed_at 的後果是「助手參與筆數永遠變 0」,而且不會拋錯、只是安靜地少一個數字。
--    這裡用 coalesce(b.completed_at, b.start_at),跟商家那一側的**營收**基準一致;
--    coalesce 的 fallback 在這裡是有意義的,因為匯入的歷史訂單**會**進 bookings。
--
-- =========================================================================
-- 【#780:明細日期欄位 order_date → completion_date,過渡期兩個 key 並存】
--
-- 這個欄位改完之後裝的是「完成時間」,名字卻還叫 order_date(訂單日期)。名字說 A、內容是 B
-- 是最會誤導下一個維護者的一種寫法(他不會去讀 migration 註解,他只會看欄位名)。
--
-- 🔴 但**不可以直接改名**:資料庫 migration 與前端部署(Vercel)不是同一個原子操作。
--    如果 migration 先上、前端還是舊的,前端讀 d.order_date 會拿到 undefined,
--    `new Date(undefined).toLocaleDateString()` 會在畫面上印出「Invalid Date」,CSV 還會多一欄空白。
--    所以這一版**兩個 key 並存、值相同**,兩種部署順序都安全。
--    過渡期欄位的移除已獨立登記成 SPECS-INDEX #783(狀態「待規劃」),前置條件是
--    `grep -rn "order_date" src/` 結果為空。**登記了才不會變成永遠留著**
--    (本專案已有 update_my_agent_profile 這個「過渡期欄位留著沒人收」的前例)。
--
-- =========================================================================
-- 【#782:這次**刻意不**在畫面上加「歷史數字可能變動」的提示 —— 這是決定,不是漏掉】
--
-- 三個理由:
--   1. 使用者已經被明確告知「歷史報表數字會變動」並回覆「確定」,不需要系統再提醒他一次
--      他已經同意的事。
--   2. 🔬 實查正式庫 diff_month = 0 —— **目前沒有任何一筆跨月完成的訂單,這次修完線上一筆
--      數字都不會變**。加一個「數字可能變動」的橫幅去解釋一件實際上沒有發生的事,只會讓商家
--      開始懷疑自己過去看到的數字對不對。
--   3. 真正有效的做法是把畫面與 CSV 的欄位標題改成「完成日期」(#781),讀報表的人自己就看得懂
--      口徑是什麼 —— 這比一個會被關掉、會過時的橫幅有效得多,而且永久有效。
--
-- =========================================================================
-- 【這次動到什麼、沒動到什麼】
--   ・改:get_staff_commission_summary(uuid,int,int)、get_staff_commission_summary_by_range(uuid,date,date)
--   ・不改:函式簽章、參數、權限檢查(can_view_payroll_reports / can_view_staff_own_payroll)、
--           區間 ≤ 366 天與「結束不得早於起始」兩道保護、EXECUTE 權限。
--   ・不改:get_staff_monthly_payroll_summary / _by_range(月薪制不看訂單,實查 b.start_at 出現 0 次)。
--   ・本檔案是 create or replace(簽章不變),既有 ACL 會保留;仍依
--     .claude/skills/supabase-permission-hygiene 規則 1 把 revoke/grant 整組明寫一次,
--     避免之後有人改成 drop+create 時漏掉。
-- =========================================================================

-- =========================================================================
-- 1. get_staff_commission_summary(單月版)
--    基準:2026-09-22 的 20260922120200_get_staff_commission_summary_total_amount.sql
--    (已用 md5(prosrc) 指紋確認與正式庫逐字一致,e81bb305c0a4718fde34026b00287df1)。
-- =========================================================================
create or replace function public.get_staff_commission_summary(p_staff_id uuid, p_year integer, p_month integer)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
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

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
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

comment on function public.get_staff_commission_summary(uuid, integer, integer) is '模組 8/14:某位按件計酬服務人員某年月的抽成明細+總計。2026-09-25(#767/#779/#780):歸月基準從 b.start_at 改成「完成時間」——抽成用 bcr.computed_at(跟商家帳務報表的抽成支出同一個欄位,兩邊逐筆對得上),助手參與筆數用 coalesce(b.completed_at, b.start_at)(助手訂單不產生 commission record,沒有 computed_at 可用,這不是筆誤)。明細日期欄位改名 completion_date,order_date 是過渡期相容欄位(值相同),移除登記為 #783。權限:商家管理員/客服(can_view_payroll_reports)或服務人員自助查自己(can_view_staff_own_payroll)。';

revoke execute on function public.get_staff_commission_summary(uuid, integer, integer) from public, anon;
grant execute on function public.get_staff_commission_summary(uuid, integer, integer) to authenticated;

-- =========================================================================
-- 2. get_staff_commission_summary_by_range(區間版)
--    基準:20260922130300_req580_581_payroll_by_range_functions.sql
--    (md5 指紋 a62d263684b4daef3deb39a8e79d17d3,與正式庫逐字一致)。
--    🔴 兩支必須一起改,而且改法要一模一樣 —— 單月版給商家管理員的
--    /app/staff-report 用,區間版給服務人員自助的 /app/my-payroll 用,
--    任何一支沒改到,兩個畫面就會對同一個月給出不同的數字。
-- =========================================================================
create or replace function public.get_staff_commission_summary_by_range(
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
    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';
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
$$;

comment on function public.get_staff_commission_summary_by_range(uuid, date, date) is '模組 8/14:師傅報表(按件計酬)區間版本。2026-09-25(#767/#779/#780):跟單月版完全一致地改用完成時間當歸月基準——抽成用 bcr.computed_at,助手參與筆數用 coalesce(b.completed_at, b.start_at)(助手訂單不產生 commission record,這不是筆誤)。明細日期欄位改名 completion_date,order_date 是過渡期相容欄位,移除登記為 #783。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll,後端保留區間 > 366 天的例外保護。';

revoke execute on function public.get_staff_commission_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_staff_commission_summary_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- 3. 索引:這次**刻意不加**,決定權留給主腦(#767 規格書明文要求)
--
--    這次的查詢條件變成 `bcr.staff_id = ? and bcr.computed_at between ?`,既有的
--    booking_commission_records_merchant_id_computed_at_idx 是以 merchant_id 開頭,**用不到**。
--    但 2026-09-25 對正式庫實跑 explain 發現:另外還有一個
--    **booking_commission_records_staff_id_idx**(單欄 staff_id),規劃器走的是
--      Index Scan using booking_commission_records_staff_id_idx
--        Index Cond: (staff_id = …)
--        Filter: (computed_at >= … AND computed_at < …)
--    也就是 **staff_id 已經有索引在擋掉絕大多數的列,computed_at 只是走完索引之後的 Filter**。
--    一位服務人員一生的 commission record 數量本來就有限(不會像整店那樣成長),
--    所以再補一個 (staff_id, computed_at) 複合索引的邊際效益很低。
--    ⇒ 這一版**不加**,把決定留給主腦(規格書 #767 明文要求 engineer 只回報 explain、不自行決定)。
--    真的要加的時候是這一行(冪等,本機 db reset 與正式庫都安全):
--      create index if not exists booking_commission_records_staff_id_computed_at_idx
--        on public.booking_commission_records (staff_id, computed_at);
-- =========================================================================
