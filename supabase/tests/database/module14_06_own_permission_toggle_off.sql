-- 模組 14(服務人員端):SPECS-INDEX #880 —— 「關掉自己的開關」這個方向的覆蓋缺口。
--
-- 🔴🔴🔴 本檔尚未執行過,待階段 J 之後首次執行。 🔴🔴🔴
--   pgTAP 的 fixture 會真的寫進資料庫(雖然最後 rollback,過程中仍是對正式庫的寫入),
--   所以在專案的「階段 J:清空 + 測試/正式環境分家」完成之前**不可以跑**。
--   ⇒ 這個檔案目前**沒有任何一條斷言綠過**,請不要把它當成已驗證的保護網。
--   首次執行的人請一併確認 plan(16) 的數字跟實際斷言數一致(見檔尾的計數清單)。
--
-- ═══ 為什麼要補這一支(QA 在 #871 盤點時抓到的缺口) ═══════════════════════════
-- 現有 pgTAP 對服務人員端的三個自助權限開關,覆蓋得**不對稱**:
--   ・staff_profile_edit  → module14_02_...sql 有明文測「**關掉之後**本人改不了自己資料」
--   ・staff_calendar_view → **只有**「A 拿 B 的 staff_id 去呼叫被擋」(module14_01:145-180)
--   ・staff_payroll_view  → 同上,也只有跨人方向
-- 「A 偷看 B」跟「B 自己的開關被關掉」走的是**函式裡兩行不同的判斷**:
--   get_my_booking_schedule 的第 1 段是 private.is_own_staff_row(擋跨人),
--   第 2 段才是 private.has_own_staff_permission(擋開關關掉)。
-- 只測第 1 段的話,有人哪天把第 2 段整段刪掉、或把 and 寫成 or,現有測試**全部照樣綠**,
-- 後果是「商家管理員把開關關掉了,服務人員還是看得到薪資」—— 商家會認為系統在騙他。
-- 而且「關掉開關」才是商家實際會做的操作,「偷拿別人的 staff_id」是攻擊情境。
--
-- ═══ 刻意開新檔案,不加在 module14_02 裡 ══════════════════════════════════════
-- module14_02 第 11 行是 `select plan(48);`,加斷言就得同步改那個數字,一漏改整個檔案失敗。
-- 而且那支已經在階段 J 之前跑綠過,本檔還沒跑過 —— 混在一起會分不清誰的狀態是什麼。
-- (同樣理由見 module14_05_internal_note_staff_visibility.sql 的檔頭。)
--
-- ═══ 順帶釘住 #878 的用語 ═════════════════════════════════════════════════════
-- 下面四條薪資報表的 throws_ok **明寫期望訊息**「沒有權限查詢這間商家的服務人員報表」,
-- 不是傳 null。這樣一來,如果有人把 migration 20260930030000 的用語改回「師傅」
-- (或任何別的寫法),這四條會直接轉紅。用語守門測試(src/lib/terminologyGuard.test.ts)
-- 擋的是「不要寫錯的詞」,這裡釘的是「正確的詞現在長什麼樣」,兩者互補。
--
-- 📌 本檔自己重新定義 test_set_auth / test_clear_auth 兩個 helper(不用 \ir include),
--    照 automated-testing skill 的既有慣例:supabase test db 是把每個 .sql 獨立丟給 psql,
--    共用 helper 檔案會被誤判成「沒有 plan() 的測試檔」而報錯。

begin;
-- #1051:private 函式已收回 authenticated 執行權;本檔斷言直接以登入者身分呼叫下列輔助函式,在交易內暫時授權(rollback 後失效)。
grant execute on function private.can_view_staff_own_payroll(uuid) to authenticated;
grant execute on function private.has_own_staff_permission(uuid, text) to authenticated;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

select plan(16);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- =========================================================================
-- Fixture:一間商家、一位管理員、兩位服務人員。
--   X = 按件計酬(抽成報表用 get_staff_commission_summary / _by_range)
--   Y = 月薪制  (薪資報表用 get_staff_monthly_payroll_summary / _by_range)
-- 兩位一開始 staff_calendar_view 與 staff_payroll_view **都是開通的**,
-- 測試的流程是「先證明開通時真的查得到」→「管理員關掉」→「證明本人查不到」。
--
-- 🔴 is_own_staff_row 同時要求 status='active' 且 login_status='active',
--    兩個都得設,不然所有斷言都會因為「根本不是本人」而被擋,測不到開關本身。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1460000-0000-4000-8000-000000000001', 'pgtap-m14f-admin@test.local'),
  ('e1460000-0000-4000-8000-000000000002', 'pgtap-m14f-staff-x@test.local'),
  ('e1460000-0000-4000-8000-000000000003', 'pgtap-m14f-staff-y@test.local');

insert into groups (id) values ('e1460000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e1460000-0000-4000-8000-000000000020', 'e1460000-0000-4000-8000-000000000010', '自助權限開關測試店', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id)
values ('e1460000-0000-4000-8000-000000000020', 'e1460000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e1460000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('e1460000-0000-4000-8000-000000000030', 'e1460000-0000-4000-8000-000000000020', '到府服務', 500, 'primary', 60);

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, no_time_slot_limit, show_member_info, phone) values
  ('e1460000-0000-4000-8000-000000000040', 'e1460000-0000-4000-8000-000000000020', 'e1460000-0000-4000-8000-000000000002', '服務人員X(按件)', 'piece_rate', 'active', 'active', now(), true, false, '0900000301'),
  ('e1460000-0000-4000-8000-000000000041', 'e1460000-0000-4000-8000-000000000020', 'e1460000-0000-4000-8000-000000000003', '服務人員Y(月薪)', 'monthly_salary', 'active', 'active', now(), true, false, '0900000302');

insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('e1460000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('e1460000-0000-4000-8000-000000000040', 'staff_payroll_view', true),
  ('e1460000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('e1460000-0000-4000-8000-000000000041', 'staff_payroll_view', true);

insert into payment_methods (id, merchant_id, name)
values ('e1460000-0000-4000-8000-000000000050', 'e1460000-0000-4000-8000-000000000020', '現場付款');

-- X 名下建一筆真實訂單,讓「開通時查得到」這條基準斷言有東西可以數 ——
-- 基準條件如果是「回傳空陣列也算過」,那就證明不了關掉開關之後的差異是開關造成的。
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000001');

select id from create_booking(
  p_merchant_id => 'e1460000-0000-4000-8000-000000000020',
  p_staff_id => 'e1460000-0000-4000-8000-000000000040',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e1460000-0000-4000-8000-000000000030','quantity',1,'unit_price',500)),
  p_start_at => '2026-11-10 10:00:00+08',
  p_customer_name => '客戶一',
  p_customer_phone => '0911000301',
  p_customer_address => '測試地址一號',
  p_payment_method_id => 'e1460000-0000-4000-8000-000000000050'
) \gset bookingX_

select pg_temp.test_clear_auth();

-- =========================================================================
-- 【基準】開關都還開著的時候,本人真的查得到 —— 共 5 條。
-- 這 5 條的作用是「反向對照」:少了它們,下面那些 throws_ok 就算是因為 fixture 打錯、
-- 帳號根本不是本人而被擋,也會照樣綠燈(假性通過)。
-- =========================================================================
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000002'); -- X

select is(
  (select jsonb_array_length(get_my_booking_schedule('e1460000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date))),
  1,
  '基準 1:staff_calendar_view 開通時,X 查自己的行事曆拿到 1 筆'
);

select is(
  (get_staff_commission_summary('e1460000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_orders'),
  '0',
  '基準 2:staff_payroll_view 開通時,X 查自己的抽成報表(單月)拿到正常 payload'
);

select is(
  (get_staff_commission_summary_by_range('e1460000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date) ->> 'total_orders'),
  '0',
  '基準 3:staff_payroll_view 開通時,X 查自己的抽成報表(區間)拿到正常 payload'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000003'); -- Y(月薪制)

select lives_ok(
  $$select get_staff_monthly_payroll_summary('e1460000-0000-4000-8000-000000000041'::uuid, 2026, 11)$$,
  '基準 4:staff_payroll_view 開通時,Y 查自己的薪資報表(單月)不被擋'
);

select lives_ok(
  $$select get_staff_monthly_payroll_summary_by_range('e1460000-0000-4000-8000-000000000041'::uuid, '2026-11-01'::date, '2026-11-30'::date)$$,
  '基準 5:staff_payroll_view 開通時,Y 查自己的薪資報表(區間)不被擋'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 【#880 第一條】管理員關掉 X 的 staff_calendar_view → X 本人也要查不到自己的行事曆。
-- =========================================================================
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000001'); -- 管理員
select set_staff_permission('e1460000-0000-4000-8000-000000000040'::uuid, 'staff_calendar_view', false);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000002'); -- X

select ok(
  not private.has_own_staff_permission('e1460000-0000-4000-8000-000000000040'::uuid, 'staff_calendar_view'),
  '#880-A 前提:關掉之後,底層 has_own_staff_permission(本人, staff_calendar_view) 變成 false'
);

select throws_ok(
  $$select get_my_booking_schedule('e1460000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)$$,
  '42501', '尚未開通行事曆檢視功能，請洽商家管理員',
  '#880-A(核心):關掉自己的 staff_calendar_view 之後,X 查自己的行事曆被擋下(不是只有前端藏起來)'
);

-- 🔴 這一條證明上面那條不是「X 整個帳號壞掉/根本不是本人」造成的:
--    同一個身份、同一個時間點,**還沒被關掉**的薪資報表依然查得到。
select lives_ok(
  $$select get_staff_commission_summary('e1460000-0000-4000-8000-000000000040'::uuid, 2026, 11)$$,
  '#880-A 反向對照:只關掉行事曆那一項,X 的薪資報表不受影響(證明上一條是開關造成的,不是身份判斷)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 【#880 第二條】管理員關掉 staff_payroll_view → 本人也要查不到自己的報表。
-- 按件計酬(X)走 get_staff_commission_summary / _by_range,
-- 月薪制(Y)走 get_staff_monthly_payroll_summary / _by_range —— 四支**都要測**。
-- 🔴 這四支是四份獨立的 SECURITY DEFINER 程式碼,權限檢查那一行是各自複製的,
--    不是共用一個 wrapper。只測一支的話,另外三支被改壞不會有人知道
--    (#878 就是這樣一次要改四支)。
-- =========================================================================
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000001'); -- 管理員
select set_staff_permission('e1460000-0000-4000-8000-000000000040'::uuid, 'staff_payroll_view', false);
select set_staff_permission('e1460000-0000-4000-8000-000000000041'::uuid, 'staff_payroll_view', false);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000002'); -- X

select ok(
  not private.can_view_staff_own_payroll('e1460000-0000-4000-8000-000000000040'::uuid),
  '#880-B 前提:關掉之後,底層 can_view_staff_own_payroll(本人) 變成 false'
);

select throws_ok(
  $$select get_staff_commission_summary('e1460000-0000-4000-8000-000000000040'::uuid, 2026, 11)$$,
  '42501', '沒有權限查詢這間商家的服務人員報表',
  '#880-B(核心):關掉自己的 staff_payroll_view 之後,X 查自己的抽成報表(單月)被擋下'
);

select throws_ok(
  $$select get_staff_commission_summary_by_range('e1460000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)$$,
  '42501', '沒有權限查詢這間商家的服務人員報表',
  '#880-B(核心):關掉自己的 staff_payroll_view 之後,X 查自己的抽成報表(區間)被擋下'
);

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000003'); -- Y(月薪制)

select throws_ok(
  $$select get_staff_monthly_payroll_summary('e1460000-0000-4000-8000-000000000041'::uuid, 2026, 11)$$,
  '42501', '沒有權限查詢這間商家的服務人員報表',
  '#880-B(核心):關掉自己的 staff_payroll_view 之後,Y 查自己的薪資報表(單月)被擋下'
);

select throws_ok(
  $$select get_staff_monthly_payroll_summary_by_range('e1460000-0000-4000-8000-000000000041'::uuid, '2026-11-01'::date, '2026-11-30'::date)$$,
  '42501', '沒有權限查詢這間商家的服務人員報表',
  '#880-B(核心):關掉自己的 staff_payroll_view 之後,Y 查自己的薪資報表(區間)被擋下'
);

-- 反向對照:Y 的 staff_calendar_view 沒被關,所以行事曆還查得到。
select lives_ok(
  $$select get_my_booking_schedule('e1460000-0000-4000-8000-000000000041'::uuid, '2026-11-01'::date, '2026-11-30'::date)$$,
  '#880-B 反向對照:只關掉薪資那一項,Y 的行事曆不受影響'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- 【可逆性】重新開通之後立刻又查得到 —— 證明「關掉」不是把資料弄壞了,
-- 而是一個純粹的權限判斷(商家管理員手滑關錯,打開就好,不需要任何修復動作)。
-- =========================================================================
select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000001'); -- 管理員
select set_staff_permission('e1460000-0000-4000-8000-000000000040'::uuid, 'staff_calendar_view', true);
select set_staff_permission('e1460000-0000-4000-8000-000000000040'::uuid, 'staff_payroll_view', true);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e1460000-0000-4000-8000-000000000002'); -- X

-- 這裡刻意比對訂單 id(不是只數筆數):同時證明「又查得到了」而且「查到的是原來那筆」。
-- jsonb_array_elements 如果回超過一筆,這個子查詢會直接報錯,所以筆數也一起被釘住。
select is(
  (
    select e ->> 'id'
    from jsonb_array_elements(get_my_booking_schedule('e1460000-0000-4000-8000-000000000040'::uuid, '2026-11-01'::date, '2026-11-30'::date)) e
  ),
  :'bookingX_id',
  '可逆性:重新開通 staff_calendar_view 之後,X 立刻又拿到原來那筆訂單(沒有任何殘留狀態)'
);

select is(
  (get_staff_commission_summary('e1460000-0000-4000-8000-000000000040'::uuid, 2026, 11) ->> 'total_orders'),
  '0',
  '可逆性:重新開通 staff_payroll_view 之後,X 立刻又查得到抽成報表'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- plan(16) 的計數清單(改動本檔時請同步維護這份清單與 plan 的數字):
--   基準       5 條(基準 1~5)
--   #880-A     3 條(前提 1 + 核心 1 + 反向對照 1)
--   #880-B     6 條(前提 1 + 核心 4 + 反向對照 1)
--   可逆性     2 條
--   ─────────────────
--   合計      16 條
-- =========================================================================

select * from finish();
rollback;
