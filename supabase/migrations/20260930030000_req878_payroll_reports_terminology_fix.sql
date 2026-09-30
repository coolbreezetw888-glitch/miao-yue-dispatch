-- SPECS-INDEX #878:把使用者看得到的錯誤訊息裡的「師傅」改成「服務人員」。
--
-- ═══ 為什麼一定要開 migration,不能只改歷史檔案 ═════════════════════════════════
-- 「沒有權限查詢這間商家的<某某>報表」這句是 raise exception 的訊息,服務人員/客服在
-- /app/staff-report 與 /app/my-payroll 被擋下時,**會原封不動出現在畫面的紅字裡**。
-- 歷史 migration 已經套用到正式庫,改它的檔案內容對正式庫毫無作用(而且會讓 repo 跟
-- 帳本不一致),所以一律新開一支往後疊加。
--
-- ═══ 使用者的長期硬規則 ═══════════════════════════════════════════════════════
-- 這是跨產業系統(冷氣、美甲、美容、寵物美容、到府清潔…),用語一律「服務人員」。
-- 「師傅」是冷氣業的講法,美甲師看到會覺得這套系統不是給他用的。
-- 守門測試:src/lib/terminologyGuard.test.ts(本次同步延伸到 supabase/migrations/)。
--
-- ═══ 這次重建哪幾支、為什麼是這四支 ═══════════════════════════════════════════
-- 全 repo 的 raise exception 命中共 10 處,但 migration 是依序疊加的,**只有每支函式
-- 最後一次被定義的那一版才是正式庫現在跑的東西**。實查正式庫 pg_proc 確認,目前線上
-- 仍帶著「師傅」的只有這四支(其餘 6 處都是已被後續 migration 覆蓋掉的舊版本):
--   ① public.get_staff_commission_summary(uuid, integer, integer)
--        最後一版 = 20260925020000:116   md5(prosrc) 80867ab77bab7d2239630efeb77488af
--   ② public.get_staff_commission_summary_by_range(uuid, date, date)
--        最後一版 = 20260925020000:224   md5(prosrc) 97e1ff4a23c00ffd90482f79b0b36bc8
--   ③ public.get_staff_monthly_payroll_summary(uuid, int, int)
--        最後一版 = 20260921130000:103   md5(prosrc) 7964ef9763f2e00d4cc7af96f1dd64b4
--   ④ public.get_staff_monthly_payroll_summary_by_range(uuid, date, date)
--        最後一版 = 20260922130300:183   md5(prosrc) c6234ebd700576e4ae24b52c6638f706
-- 被覆蓋掉的 6 處(不需要處理,純歷史):20260920120400:166/237、20260921130000:36、
-- 20260922111100:26、20260922120200:40、20260922130300:227、20260925020000 已含在上面。
--
-- ═══ md5 指紋驗證(supabase-permission-hygiene 規則 6) ═══════════════════════
-- 動手前已用唯讀 SELECT 取正式庫的 md5(pg_proc.prosrc),跟 repo 檔案裡對應的
-- $$…$$ 本體(先把 CRLF 正規化成 LF 再算)逐支比對 —— **四支全部逐字一致**,
-- 上面四個 md5 就是比對通過的值。所以這次可以安全地「以 repo 為正本」重建。
--
-- ═══ 🔴 這次相對於舊版的差異,每支只有兩處 ═══════════════════════════════════
--   1. raise exception 的訊息:'沒有權限查詢這間商家的師傅報表'
--                          → '沒有權限查詢這間商家的服務人員報表'
--      (errcode 42501 不變,前端靠 errcode 判斷,不靠訊息字串比對)
--   2. comment on function 的文字裡「師傅報表」→「服務人員報表」
--      (只有開發者看得到,但這次本來就要重建這支函式,順手一起改)
-- **其餘每一行、包含函式本體裡的中文註解,全部逐字沿用舊版**,沒有任何邏輯變動。
--
-- ═══ 為什麼用 create or replace 而不是 drop + create ═════════════════════════
-- 主腦派工單寫的是「drop 舊簽章 → create → 重寫 revoke/grant」。這次**四支的簽章
-- 完全沒有變動**,所以刻意沿用專案既有慣例的 create or replace(20260925020000、
-- 20260930010100 都是這樣寫),理由:
--   ・drop 會讓正式庫有一瞬間「這支函式不存在」,期間任何呼叫直接 500。
--   ・drop 會連帶處理依賴關係(cascade 風險)。已 grep 確認沒有其他函式/政策呼叫
--     這四支,但沒必要為了形式承擔這個風險。
--   ・supabase-permission-hygiene 規則 1 要求「drop+create 一律重寫 revoke/grant」,
--     本質是「不要讓新函式繼承預設的 PUBLIC EXECUTE」。create or replace 會保留原
--     ACL,不會有這個問題;但為了讓權限狀態在檔案裡看得見、不依賴「原本剛好是對的」,
--     **下面每一支仍然把整組 revoke/grant 明寫一次**(冪等)。
-- ⚠️ revoke 刻意只收 public, anon,**不收 authenticated** —— 這四支是前端登入者要直接
--    呼叫的 RPC,函式內部自己有 can_view_payroll_reports / can_view_staff_own_payroll
--    權限檢查。這跟規則 1「內部輔助函式要連 authenticated 一起收」是不同情境,
--    照舊版一字不動沿用。
--
-- ✅ 套用後請再跑一次指紋驗證,確認 prosrc 只有那一句訊息不同(預期新 md5:
--    ① be733fe6e835af9cfe6de136bca21e26(3399 → 3401 字元)
--    ② 5d3f1a01088d6f20a6a065fdeeffaee6(3106 → 3108 字元)
--    ③ feacebbd9a0946813ea258ab349a9fe9( 453 →  455 字元)
--    ④ a04760ebaee956bb111eea711bea9980( 471 →  473 字元)
--    每支都剛好 +2 字元,因為「師傅」(2 字)換成「服務人員」(4 字)只發生一次。
--    上面這四個 md5 是直接對本檔案的函式本體(CRLF 正規化成 LF)算出來的,
--    套用後線上的 md5 應該一字不差等於它。)

-- =========================================================================
-- 1. public.get_staff_commission_summary(uuid, integer, integer)
--    逐字沿用 20260925020000_staff_commission_summary_completion_time_basis.sql(僅訊息用語與 comment 文字改動,共 1 處)
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

comment on function public.get_staff_commission_summary(uuid, integer, integer) is '模組 8/14:某位按件計酬服務人員某年月的抽成明細+總計。2026-09-25(#767/#779/#780):歸月基準從 b.start_at 改成「完成時間」——抽成用 bcr.computed_at(跟商家帳務報表的抽成支出同一個欄位,兩邊逐筆對得上),助手參與筆數用 coalesce(b.completed_at, b.start_at)(助手訂單不產生 commission record,沒有 computed_at 可用,這不是筆誤)。明細日期欄位改名 completion_date,order_date 是過渡期相容欄位(值相同),移除登記為 #783。權限:商家管理員/客服(can_view_payroll_reports)或服務人員自助查自己(can_view_staff_own_payroll)。';

revoke execute on function public.get_staff_commission_summary(uuid, integer, integer) from public, anon;
grant execute on function public.get_staff_commission_summary(uuid, integer, integer) to authenticated;

-- =========================================================================
-- 2. public.get_staff_commission_summary_by_range(uuid, date, date)
--    逐字沿用 20260925020000_staff_commission_summary_completion_time_basis.sql(僅訊息用語與 comment 文字改動,共 2 處)
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
$$;

comment on function public.get_staff_commission_summary_by_range(uuid, date, date) is '模組 8/14:服務人員報表(按件計酬)區間版本。2026-09-25(#767/#779/#780):跟單月版完全一致地改用完成時間當歸月基準——抽成用 bcr.computed_at,助手參與筆數用 coalesce(b.completed_at, b.start_at)(助手訂單不產生 commission record,這不是筆誤)。明細日期欄位改名 completion_date,order_date 是過渡期相容欄位,移除登記為 #783。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll,後端保留區間 > 366 天的例外保護。';

revoke execute on function public.get_staff_commission_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_staff_commission_summary_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- 3. public.get_staff_monthly_payroll_summary(uuid, int, int)
--    逐字沿用 20260921130000_staff_portal_payroll_overlay.sql(僅訊息用語與 comment 文字改動,共 2 處)
-- =========================================================================
create or replace function public.get_staff_monthly_payroll_summary(
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
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的服務人員報表' using errcode = '42501';
  end if;

  return private.compute_staff_payroll(p_staff_id, p_year, p_month);
end;
$$;

comment on function public.get_staff_monthly_payroll_summary(uuid, int, int) is '模組 8 §3.10/模組 14 §3.17:服務人員報表(月薪制)用,某位服務人員某年月的請假扣款明細與淨額(規則 2.8)。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll(服務人員自助檢視,判斷 9)後直接複用 private.compute_staff_payroll。';

revoke execute on function public.get_staff_monthly_payroll_summary(uuid, int, int) from public, anon;
grant execute on function public.get_staff_monthly_payroll_summary(uuid, int, int) to authenticated;

-- =========================================================================
-- 4. public.get_staff_monthly_payroll_summary_by_range(uuid, date, date)
--    逐字沿用 20260922130300_req580_581_payroll_by_range_functions.sql(僅訊息用語與 comment 文字改動,共 2 處)
-- =========================================================================
create or replace function public.get_staff_monthly_payroll_summary_by_range(
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
begin
  select merchant_id into v_merchant_id from public.merchant_staff where id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的服務人員報表' using errcode = '42501';
  end if;

  return private.compute_staff_payroll_by_range(p_staff_id, p_start_date, p_end_date);
end;
$$;

comment on function public.get_staff_monthly_payroll_summary_by_range(uuid, date, date) is '商家端三項調整規格書 §3.6/服務人員端規格書 §15.2:服務人員報表(月薪制)區間版本,取代單一年月的 get_staff_monthly_payroll_summary,不改掉原本簽章(那支繼續給商家管理員視角 StaffReportPage.tsx 使用,這支目前只給服務人員自助頁面 MyPayrollPage.tsx 使用)。SECURITY DEFINER,檢查 private.can_view_payroll_reports 或 private.can_view_staff_own_payroll。';

revoke execute on function public.get_staff_monthly_payroll_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_staff_monthly_payroll_summary_by_range(uuid, date, date) to authenticated;
