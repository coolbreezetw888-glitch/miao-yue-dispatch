-- 模組 8(薪資與帳務)規格書 §十一「服務人員薪資/身份變動歷史紀錄機制」(2026-09-22 新增批次,
-- SPECS-INDEX #622~#631)。核心必測:§11.2(自動記錄觸發器)、§11.4(硬刪除新增薪資歷史檢查)、
-- §11.5(查詢某時間點狀態,含估算邏輯)、§11.7/§11.8(既有函式改用歷史資料,含「調整前後金額
-- 各自正確」「查詢區間橫跨機制上線前用估算」「機制上線後才加入的人查入職前月份誠實顯示不存在」
-- 三種核心情境)。
begin;

select plan(49);

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
-- Fixture:單一測試商家 + 管理員 + 一位完全無授權的客服(測 §11.1 RLS)。
-- =========================================================================
insert into auth.users (id, email) values
  ('e8020000-0000-4000-8000-000000000001', 'pgtap-m802-admin@test.local'),
  ('e8020000-0000-4000-8000-000000000002', 'pgtap-m802-agent-none@test.local');

insert into groups (id) values ('e8020000-0000-4000-8000-000000000011');

-- 兩間商家:merchant 1(021)給①~④(§11.1~§11.4)用;merchant 2(022)是專門給⑤~⑨(§11.5~§11.9,
-- 需要精確操控歷史時間軸的區間彙整測試)用的乾淨商家——刻意跟①~④的服務人員(A/B/C/D)分開,
-- 避免 D(§11.3 測試,is_backfill_seed=true 但 effective_from 是真實測試執行當下的時間,沒有被
-- 手動改寫成過去日期)混進商家層級加總,把 2026-02/08 這種虛構過去月份的查詢污染成「有估算」。
insert into merchants (id, group_id, name, industry_type) values
  ('e8020000-0000-4000-8000-000000000021', 'e8020000-0000-4000-8000-000000000011', '薪資歷史測試店', 'in_store_beauty'),
  ('e8020000-0000-4000-8000-000000000022', 'e8020000-0000-4000-8000-000000000011', '薪資歷史測試店二(§11.5~§11.9專用)', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('e8020000-0000-4000-8000-000000000021', 'e8020000-0000-4000-8000-000000000001'),
  ('e8020000-0000-4000-8000-000000000022', 'e8020000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('e8020000-0000-4000-8000-000000000051', 'e8020000-0000-4000-8000-000000000021', 'e8020000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-m802-agent-none@test.local', 'active', now(), '0900000201');

-- =========================================================================
-- ① §11.1:資料庫結構(CHECK 約束、partial unique index、effective 區間 CHECK、RLS)。這張表
-- 完全沒有 INSERT/UPDATE/DELETE 政策(只能透過 §11.2 的觸發器 SECURITY DEFINER 寫入),所以這裡
-- 用預設連線身分(postgres,bypass RLS)直接測 CHECK 約束本身,不先切換成任何 authenticated 角色
-- ——即使是商家管理員,對這張表也完全沒有寫入政策,直接寫入一律先被 RLS(42501)擋下,還沒機會
-- 走到 CHECK 約束檢查。
-- =========================================================================
select throws_ok(
  $$insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary)
    values (gen_random_uuid(), 'e8020000-0000-4000-8000-000000000021', 'invalid_type', 'active', 0)$$,
  '23514', null,
  '§11.1:compensation_type 只能是 monthly_salary/piece_rate,非法值被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary)
    values (gen_random_uuid(), 'e8020000-0000-4000-8000-000000000021', 'monthly_salary', 'invalid_status', 0)$$,
  '23514', null,
  '§11.1:status 只能是 active/removed,非法值被 CHECK 約束擋下'
);

select throws_ok(
  format(
    $$insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary, effective_from, effective_to)
      values ('%s', 'e8020000-0000-4000-8000-000000000021', 'monthly_salary', 'active', 0, now(), now())$$,
    gen_random_uuid()
  ),
  '23514', null,
  '§11.1:effective_to 必須嚴格晚於 effective_from(相等也不行),被 CHECK 約束擋下'
);

-- 先建一位服務人員(觸發器自動產生一筆目前生效中的歷史紀錄),再手動嘗試插入第二筆「目前生效中」
-- 的紀錄(effective_to is null),應該被 partial unique index 擋下。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000031', 'e8020000-0000-4000-8000-000000000021', '服務人員A(§11.2核心測試)', '0900000301', 'monthly_salary');

select throws_ok(
  format(
    $$insert into staff_payroll_status_history (staff_id, merchant_id, compensation_type, status, monthly_base_salary)
      values ('%s', 'e8020000-0000-4000-8000-000000000021', 'monthly_salary', 'active', 0)$$,
    'e8020000-0000-4000-8000-000000000031'
  ),
  '23505', null,
  '§11.1:partial unique index 正確擋下同一人同時兩筆「目前生效中」的紀錄'
);

select pg_temp.test_clear_auth();

-- RLS:完全沒被開通任何權限的客服看不到這張表;管理員看得到。
select pg_temp.test_set_auth('e8020000-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031'),
  0,
  '§11.1 RLS:完全沒被開通任何權限的客服讀不到 staff_payroll_status_history'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8020000-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031'),
  1,
  '§11.1 RLS:商家管理員(can_view_payroll_reports 涵蓋)能讀到自己商家的 staff_payroll_status_history'
);

-- =========================================================================
-- ② §11.2(核心必測):自動記錄異動的觸發器。沿用①建立的服務人員 A(031),目前應該剛好 1 筆
-- 歷史紀錄(monthly_base_salary=0,is_backfill_seed=false)。
-- =========================================================================
select is(
  (select row(compensation_type, status, monthly_base_salary, is_backfill_seed)
   from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031' and effective_to is null)::text,
  row('monthly_salary', 'active', 0.00, false)::text,
  '§11.2 測試①:新增一位月薪制服務人員(月薪 0)→ 自動產生一筆 is_backfill_seed=false 的起始歷史紀錄'
);

-- 測試②:改月薪 30000 → 5000,確認產生兩筆新紀錄,前一筆被正確結算 effective_to,
-- monthly_base_salary 依序為 0/30000/5000。
insert into staff_salary_settings (staff_id, monthly_base_salary) values ('e8020000-0000-4000-8000-000000000031', 30000);

select is(
  (select monthly_base_salary from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031' and effective_to is null),
  30000.00,
  '§11.2 測試②:設定月薪 30000 後,目前生效中的紀錄正確變成 30000'
);

update staff_salary_settings set monthly_base_salary = 5000 where staff_id = 'e8020000-0000-4000-8000-000000000031';

select is(
  (select monthly_base_salary from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031' and effective_to is null),
  5000.00,
  '§11.2 測試②:改月薪 5000 後,目前生效中的紀錄正確變成 5000'
);

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031'),
  3,
  '§11.2 測試②:總共正確產生 3 筆紀錄(0 → 30000 → 5000),前面兩筆的 effective_to 都已經被結算'
);

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031' and effective_to is not null),
  2,
  '§11.2 測試②:前兩筆(0、30000)都已經被結算 effective_to,不再是目前生效中'
);

-- 測試③:把 compensation_type 從 piece_rate 改成 monthly_salary,確認產生新紀錄且 monthly_base_salary
-- 正確帶入當下 staff_salary_settings 的值。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000032', 'e8020000-0000-4000-8000-000000000021', '服務人員B(計酬類型變更測試)', '0900000302', 'piece_rate');

-- 用 postgres 身分(bypass RLS)先塞一筆「還是 piece_rate 時」就已經存在的 staff_salary_settings
-- (現實中不會透過一般 API 發生,RLS WITH CHECK 會擋下,這裡純粹是製造 fixture,模擬「這個人之前
-- 就曾經是月薪制、留有舊的薪資設定值」的邊界情況)。
select pg_temp.test_clear_auth();
insert into staff_salary_settings (staff_id, monthly_base_salary) values ('e8020000-0000-4000-8000-000000000032', 8000);
select pg_temp.test_set_auth('e8020000-0000-4000-8000-000000000001');

update merchant_staff set compensation_type = 'monthly_salary' where id = 'e8020000-0000-4000-8000-000000000032';

select is(
  (select row(compensation_type, monthly_base_salary)
   from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000032' and effective_to is null)::text,
  row('monthly_salary', 8000.00)::text,
  '§11.2 測試③:計酬類型從 piece_rate 改成 monthly_salary,新紀錄正確帶入當下 staff_salary_settings 的值(8000)'
);

-- 測試④:removed → 產生新紀錄;reactivate → 再產生一筆。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000033', 'e8020000-0000-4000-8000-000000000021', '服務人員C(在職狀態變更測試)', '0900000303', 'piece_rate');

update merchant_staff set status = 'removed' where id = 'e8020000-0000-4000-8000-000000000033';

select is(
  (select status from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000033' and effective_to is null),
  'removed',
  '§11.2 測試④:移除服務人員後,目前生效中的紀錄正確變成 status=removed'
);

update merchant_staff set status = 'active' where id = 'e8020000-0000-4000-8000-000000000033';

select is(
  (select status from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000033' and effective_to is null),
  'active',
  '§11.2 測試④:恢復服務人員後,目前生效中的紀錄正確變回 status=active'
);

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000033'),
  3,
  '§11.2 測試④:total 3 筆(初始 active → removed → active)'
);

-- 測試⑤:改姓名(不在觸發器的 of compensation_type, status 欄位清單內)不會讓觸發器整個被觸發
-- ——這一層是「觸發器只監聽特定欄位」本身的保護,不是函式內部三欄位比對防呆。
select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031'),
  3,
  '§11.2 測試⑤(基準值):改名前,服務人員 A 的歷史紀錄筆數是 3'
);

update merchant_staff set name = '服務人員A(改名測試,不應產生新歷史)' where id = 'e8020000-0000-4000-8000-000000000031';

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031'),
  3,
  '§11.2 測試⑤:改名(不在觸發器的 of compensation_type, status 欄位清單內)後,歷史紀錄筆數維持 3,觸發器根本沒有被觸發'
);

-- 測試⑤-2(核心必測):驗證函式內部「三欄位比對防呆」本身——status 被寫入「跟目前值完全相同」的
-- 值(active → active),這確實會讓觸發器被觸發(status 在 of 清單內,且這一列真的出現在
-- UPDATE 的 SET 子句裡,不管值是否真的改變,Postgres 的 column-list 觸發器就是依「有沒有出現在
-- SET 子句」判斷,不是依「值是否真的不同」判斷),但函式內部應該正確比對出「三欄位都相同」,
-- 不產生新紀錄。⚠️ 這條斷言就是「拿掉三欄位比對防呆(private.sync_staff_payroll_status_history
-- 裡的 if 條件)後應該會 fail」的那一條,已在動工過程中實際把 if 條件暫時改成 if true 之後重跑
-- 這份測試檔案確認 fail,再改回原本的三欄位比對條件確認 pass(細節見本次回報)。
update merchant_staff set status = 'active' where id = 'e8020000-0000-4000-8000-000000000031';

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000031'),
  3,
  '§11.2 測試⑤-2(核心必測):status 被寫入跟目前值相同的 active(觸發器確實被觸發,但函式內部三欄位比對正確判斷「沒有實質變動」),歷史紀錄筆數維持 3,沒有產生無意義的雜訊列'
);

-- =========================================================================
-- ③ §11.3:機制上線當下的起始種子紀錄(is_backfill_seed=true)。直接呼叫
-- private.sync_staff_payroll_status_history(staff_id, true) 模擬一次性回填 migration 動作
-- (實際 migration 的 DO block 就是對每一位既有服務人員各呼叫一次這支函式、帶 true)。
-- =========================================================================
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000034', 'e8020000-0000-4000-8000-000000000021', '服務人員D(§11.3回填模擬)', '0900000304', 'monthly_salary');

-- 先把觸發器自動產生的那筆(is_backfill_seed=false)刪掉,模擬「這支 migration 執行當下,這個人
-- 還沒有任何歷史紀錄」的情境(現實中種子回填一定發生在觸發器/表格都還沒有任何資料的那個時間點,
-- 這裡用刪除+重建模擬同樣的「從零開始」狀態,不影響驗證 is_backfill_seed 參數本身是否正確落地)。
-- 這張表完全沒有 DELETE 政策(同①的說明),要切回 postgres(bypass RLS)身分才能刪得動。
select pg_temp.test_clear_auth();
delete from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000034';
select private.sync_staff_payroll_status_history('e8020000-0000-4000-8000-000000000034', true);
select pg_temp.test_set_auth('e8020000-0000-4000-8000-000000000001');

select is(
  (select row(is_backfill_seed, compensation_type, status, monthly_base_salary)
   from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000034' and effective_to is null)::text,
  row(true, 'monthly_salary', 'active', 0.00)::text,
  '§11.3:直接帶 p_is_backfill_seed=true 呼叫,產生的種子紀錄正確標記 is_backfill_seed=true,欄位值等於當下 merchant_staff/staff_salary_settings 的目前值'
);

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000034'),
  1,
  '§11.3:回填後這個人剛好 1 筆歷史紀錄(起始生效),不是回溯還原的舊資料'
);

-- =========================================================================
-- ④ §11.4(核心必測):硬刪除服務人員,新增薪資歷史檢查。
-- =========================================================================
-- 情境①:status=removed、四項既有檢查皆為 0,但 staff_payroll_status_history 有一筆
-- monthly_base_salary > 0 的紀錄 → 擋下。沿用服務人員 A(031,目前生效中的紀錄是 5000)。
update merchant_staff set status = 'removed' where id = 'e8020000-0000-4000-8000-000000000031';

select throws_ok(
  $$select hard_delete_merchant_staff('e8020000-0000-4000-8000-000000000031')$$,
  'P0001', null,
  '§11.4 情境①(核心必測):曾經領過非 0 月薪的服務人員,即使沒有訂單/請假/抽成紀錄牽連,硬刪除也被擋下'
);

select is(
  (select count(*)::int from merchant_staff where id = 'e8020000-0000-4000-8000-000000000031'),
  1,
  '§11.4 情境①:被擋下後,服務人員 A 的 merchant_staff 紀錄完全不受影響'
);

-- 情境②:status=removed、四項既有檢查皆為 0、staff_payroll_status_history 只有 monthly_base_
-- salary=0 的紀錄 → 成功刪除,且屬於這個人的 staff_payroll_status_history 一併被 cascade 清除。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000035', 'e8020000-0000-4000-8000-000000000021', '服務人員E(§11.4情境②,從未領過薪)', '0900000305', 'piece_rate');
update merchant_staff set status = 'removed' where id = 'e8020000-0000-4000-8000-000000000035';

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000035' and monthly_base_salary > 0),
  0,
  '§11.4 情境②(基準值):服務人員 E 從頭到尾都是按件計酬,歷史紀錄裡沒有任何一筆 monthly_base_salary > 0'
);

select lives_ok(
  $$select hard_delete_merchant_staff('e8020000-0000-4000-8000-000000000035')$$,
  '§11.4 情境②(核心必測):從未領過非 0 月薪的服務人員,四項既有檢查也都是 0,硬刪除成功'
);

select is(
  (select count(*)::int from merchant_staff where id = 'e8020000-0000-4000-8000-000000000035'),
  0,
  '§11.4 情境②:merchant_staff 那一列真的消失了'
);

select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from staff_payroll_status_history where staff_id = 'e8020000-0000-4000-8000-000000000035'),
  0,
  '§11.4 情境②:屬於這個人的 staff_payroll_status_history 紀錄透過 on delete cascade 一併清除'
);

select pg_temp.test_set_auth('e8020000-0000-4000-8000-000000000001');

-- =========================================================================
-- ⑤ §11.5(核心必測):private.get_staff_payroll_status_as_of。用直接手動改寫歷史紀錄的方式
-- (postgres 身分,bypass 一般寫入路徑)製造出精確的「調整前/調整後」時間軸,不依賴測試執行當下
-- 的實際時鐘時間,確保測試結果穩定、可重現。
-- =========================================================================
select pg_temp.test_clear_auth();

-- 服務人員 I(月薪從 30000 調整為 40000,調整時間點是 2026-04-01 00:00 Asia/Taipei)。這裡起
-- I/J/K 全部建在 merchant 2(022,乾淨的獨立商家,見上方 Fixture 說明),避免跟 merchant 1(021)
-- 的 A/B/C/D 混在一起干擾§11.6/§11.8 的商家層級加總。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000036', 'e8020000-0000-4000-8000-000000000022', '服務人員I(§11.5/§11.7歷史區間測試)', '0900000306', 'monthly_salary');

update staff_payroll_status_history
set effective_from = '2025-01-01 00:00:00+08'::timestamptz,
    effective_to = '2026-04-01 00:00:00+08'::timestamptz,
    monthly_base_salary = 30000
where staff_id = 'e8020000-0000-4000-8000-000000000036' and effective_to is null;

insert into staff_payroll_status_history (
  staff_id, merchant_id, compensation_type, status, monthly_base_salary, effective_from, effective_to, is_backfill_seed
) values (
  'e8020000-0000-4000-8000-000000000036', 'e8020000-0000-4000-8000-000000000022', 'monthly_salary', 'active', 40000,
  '2026-04-01 00:00:00+08'::timestamptz, null, false
);

-- 服務人員 J(機制上線種子:2026-07-01 才有第一筆真實歷史,is_backfill_seed=true,月薪 25000)。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000037', 'e8020000-0000-4000-8000-000000000022', '服務人員J(§11.5/§11.7機制上線前估算測試)', '0900000307', 'monthly_salary');

update staff_payroll_status_history
set effective_from = '2026-07-01 00:00:00+08'::timestamptz,
    monthly_base_salary = 25000,
    is_backfill_seed = true
where staff_id = 'e8020000-0000-4000-8000-000000000037' and effective_to is null;

-- 服務人員 K(機制上線後才加入商家,維持觸發器自動產生的「現在」時間點,is_backfill_seed=false)。
insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('e8020000-0000-4000-8000-000000000038', 'e8020000-0000-4000-8000-000000000022', '服務人員K(§11.5機制上線後才加入測試)', '0900000308', 'monthly_salary');
insert into staff_salary_settings (staff_id, monthly_base_salary) values ('e8020000-0000-4000-8000-000000000038', 15000);

select pg_temp.test_set_auth('e8020000-0000-4000-8000-000000000001');

-- 情境 1:剛好命中區間(I 在 2026-02,對應 30000 那個區間)。
select is(
  (select row(compensation_type, status, monthly_base_salary, is_estimated, existed)
   from private.get_staff_payroll_status_as_of('e8020000-0000-4000-8000-000000000036', '2026-02-15 12:00:00+08'::timestamptz))::text,
  row('monthly_salary', 'active', 30000.00, false, true)::text,
  '§11.5 情境 1(核心):剛好覆蓋查詢時間點的紀錄——I 在 2026-02 命中 30000 那一段,existed=true、is_estimated=false'
);

select is(
  (select monthly_base_salary from private.get_staff_payroll_status_as_of('e8020000-0000-4000-8000-000000000036', '2026-05-15 12:00:00+08'::timestamptz)),
  40000.00,
  '§11.5 情境 1:I 在 2026-05(調整後)命中 40000 那一段'
);

-- 情境 2:機制上線前的種子回推估算(J 在 2026-02,早於 J 的 effective_from 2026-07-01,
-- 且 J 的最早一筆是 is_backfill_seed=true)。
select is(
  (select row(monthly_base_salary, is_estimated, existed)
   from private.get_staff_payroll_status_as_of('e8020000-0000-4000-8000-000000000037', '2026-02-15 12:00:00+08'::timestamptz))::text,
  row(25000.00, true, true)::text,
  '§11.5 情境 2(核心):查詢時間早於機制上線種子的 effective_from 時,用種子紀錄回推估算(is_estimated=true、existed=true)'
);

-- 情境 3:機制上線後才加入的人,查入職前的時間點(K 的最早一筆 is_backfill_seed=false,
-- 查詢 2020 年,遠早於 K 的建立時間)。
select is(
  (select existed from private.get_staff_payroll_status_as_of('e8020000-0000-4000-8000-000000000038', '2020-01-01 00:00:00+08'::timestamptz)),
  false,
  '§11.5 情境 3(核心):機制上線後才加入商家的服務人員,查詢入職前的時間點,existed=false(不是估算,是「那時候還沒有這個人」)'
);

select is(
  (select is_estimated from private.get_staff_payroll_status_as_of('e8020000-0000-4000-8000-000000000038', '2020-01-01 00:00:00+08'::timestamptz)),
  false,
  '§11.5 情境 3:existed=false 的情況下,is_estimated 也一定是 false(不會被誤標記為估算)'
);

-- =========================================================================
-- ⑥ §11.6:private.get_merchant_monthly_salary_base_as_of。同一商家、同一時間點,加總所有
-- 「月薪制且在職」的人。
--
-- ⚠️ K(038)這裡刻意不計入 2026-02/2026-08 的期望值:K 的歷史紀錄沒有被手動改寫(維持觸發器
-- 自動產生的「這次測試檔案實際執行當下」那個真實時間點,is_backfill_seed=false),而這次測試
-- 檔案實際執行的時間點是 2026-09-22 前後(比 2026-02/2026-08 這兩個虛構的查詢時間點都晚)——
-- 這正是 §11.5 情境 3「機制上線後才加入的人,查入職前的時間點 existed=false」的同一種情境,只是
-- 這裡換成在「商家層級加總」這一層驗證同樣的排除邏輯正確生效(K 不會被誤算進 2026-02/08 的合計),
-- 下面第三條斷言明確驗證這一點。
-- =========================================================================
select is(
  (select row(total_amount, is_estimated)
   from private.get_merchant_monthly_salary_base_as_of('e8020000-0000-4000-8000-000000000022', '2026-02-15 12:00:00+08'::timestamptz))::text,
  row(55000.00, true)::text,
  '§11.6(核心):2026-02 這個時間點,I(30000,非估算)+ J(25000,估算)= 55000(K 這時候還不存在,不計入),只要有任一人是估算,整體 is_estimated 就是 true'
);

select is(
  (select row(total_amount, is_estimated)
   from private.get_merchant_monthly_salary_base_as_of('e8020000-0000-4000-8000-000000000022', '2026-08-15 12:00:00+08'::timestamptz))::text,
  row(65000.00, false)::text,
  '§11.6:2026-08 這個時間點,I(40000)+ J(25000,已過機制上線種子時間,非估算)= 65000(K 這時候一樣還不存在,不計入),全部都不是估算'
);

-- ⚠️ 這裡刻意用 clock_timestamp()(實際前進的時鐘時間),不能用 now()——now() 在同一個 transaction
-- 內永遠回傳「這個 transaction 開始的那一刻」,會比 K 的觸發器寫入時實際使用的 clock_timestamp()
-- (理由見 §11.2 sync_staff_payroll_status_history 的 v_now 變數註解)更早,導致「查詢現在」這個
-- 對照組意外又把 K 排除掉,失去對照組的意義(這也是這份規格書機制本身選用 clock_timestamp() 而不是
-- now() 的同一個理由,在測試斷言這裡再次驗證一致)。
select is(
  (select total_amount
   from private.get_merchant_monthly_salary_base_as_of('e8020000-0000-4000-8000-000000000022', clock_timestamp()))::numeric,
  80000.00,
  '§11.6(核心,對照組):查詢「現在」這個時間點(K 這時候已經存在),I(40000)+ J(25000)+ K(15000)= 80000,證明 K 不是被永久排除,只是在 2026-02/08 那兩個查詢時間點還不存在'
);

-- =========================================================================
-- ⑦ §11.7(核心必測):private.compute_staff_payroll / compute_staff_payroll_by_range 改用歷史
-- 資料。沿用服務人員 I(調整前後)/J(機制上線前估算)/K(入職前不存在)。
-- =========================================================================
-- 測試 1:調整前/調整後的單一年月,各自顯示正確金額。
select is(
  (private.compute_staff_payroll('e8020000-0000-4000-8000-000000000036', 2026, 2) ->> 'monthly_base_salary')::numeric,
  30000.00,
  '§11.7 測試 1(核心):compute_staff_payroll 查詢調整前的 2026-02,顯示 30000'
);

select is(
  (private.compute_staff_payroll('e8020000-0000-4000-8000-000000000036', 2026, 5) ->> 'monthly_base_salary')::numeric,
  40000.00,
  '§11.7 測試 1(核心):compute_staff_payroll 查詢調整後的 2026-05,顯示 40000'
);

-- 測試 2:區間版本橫跨調整前後,monthly_base_salary 是「調整前月份 × N + 調整後月份 × M」的
-- 正確逐月加總,不是「目前值 × 總月數」(目前值 40000 × 4 個月 = 160000,會是錯誤答案)。
select is(
  (private.compute_staff_payroll_by_range('e8020000-0000-4000-8000-000000000036', '2026-02-01'::date, '2026-05-31'::date) ->> 'monthly_base_salary')::numeric,
  140000.00,
  '§11.7 測試 2(核心):[2/1,5/31] 逐月加總 = 30000(2月)+30000(3月)+40000(4月)+40000(5月) = 140000,不是目前值 40000 × 4 = 160000'
);

select isnt(
  (private.compute_staff_payroll_by_range('e8020000-0000-4000-8000-000000000036', '2026-02-01'::date, '2026-05-31'::date) ->> 'monthly_base_salary')::numeric,
  160000.00,
  '§11.7 測試 2(對照組):明確排除「目前值 × 總月數」這個錯誤答案(160000)'
);

-- 測試 3:查詢區間橫跨機制上線前的月份,salary_history_estimated=true 且金額用種子紀錄回推估算。
select is(
  (private.compute_staff_payroll('e8020000-0000-4000-8000-000000000037', 2026, 2) ->> 'salary_history_estimated')::boolean,
  true,
  '§11.7 測試 3(核心):查詢早於機制上線種子的月份,salary_history_estimated=true'
);

select is(
  (private.compute_staff_payroll_by_range('e8020000-0000-4000-8000-000000000037', '2026-01-01'::date, '2026-08-31'::date) ->> 'salary_history_estimated')::boolean,
  true,
  '§11.7 測試 3(核心):區間版本只要橫跨任一個機制上線前的月份,salary_history_estimated 就是 true'
);

-- 測試 4:機制上線後才加入的服務人員,查入職前的月份,monthly_base_salary=0 且不會被誤標記為
-- salary_history_estimated=true。
select is(
  (private.compute_staff_payroll('e8020000-0000-4000-8000-000000000038', 2020, 1) ->> 'monthly_base_salary')::numeric,
  0::numeric,
  '§11.7 測試 4(核心):K 查詢入職前的 2020 年 1 月,monthly_base_salary 顯示 0'
);

select is(
  (private.compute_staff_payroll('e8020000-0000-4000-8000-000000000038', 2020, 1) ->> 'salary_history_estimated')::boolean,
  false,
  '§11.7 測試 4(核心):K 查詢入職前的月份,salary_history_estimated 正確是 false(不是估算,是誠實顯示不存在)'
);

-- =========================================================================
-- ⑧ §11.8(核心必測):get_merchant_billing_summary / _by_range 的 total_monthly_salary_base
-- 改用歷史資料逐月加總。沿用商家「薪資歷史測試店」+ I/J 兩位已手動改寫歷史時間軸的月薪制服務
-- 人員(這個商家目前沒有任何訂單,total_revenue/commission 相關欄位皆為 0,這裡只驗證
-- total_monthly_salary_base/salary_estimation_applied)。K(038)這裡的查詢時間點(2026-02/08)
-- 都早於它自己的 effective_from(理由同⑥的說明),existed=false,不計入。
-- =========================================================================
select is(
  (get_merchant_billing_summary('e8020000-0000-4000-8000-000000000022', 2026, 2) ->> 'total_monthly_salary_base')::numeric,
  55000.00,
  '§11.8 測試(核心):get_merchant_billing_summary(2026-02)的 total_monthly_salary_base = 30000(I)+25000(J估算)= 55000'
);

select is(
  (get_merchant_billing_summary('e8020000-0000-4000-8000-000000000022', 2026, 2) ->> 'salary_estimation_applied')::boolean,
  true,
  '§11.8 測試(核心):2026-02 查詢涵蓋 J 的估算月份,salary_estimation_applied=true'
);

select is(
  (get_merchant_billing_summary('e8020000-0000-4000-8000-000000000022', 2026, 8) ->> 'total_monthly_salary_base')::numeric,
  65000.00,
  '§11.8 測試(核心):get_merchant_billing_summary(2026-08)的 total_monthly_salary_base = 40000(I)+25000(J)= 65000,全部都不是估算'
);

select is(
  (get_merchant_billing_summary('e8020000-0000-4000-8000-000000000022', 2026, 8) ->> 'salary_estimation_applied')::boolean,
  false,
  '§11.8 測試(核心):2026-08 查詢完全不涉及機制上線前的月份,salary_estimation_applied=false'
);

-- 區間版本(核心必測):[2026-03-01, 2026-05-31] 三個月,逐月加總 I(30000+40000+40000)+
-- J(25000×3,全部都是估算)= 110000 + 75000 = 185000,不是「目前所有月薪制在職人員的月薪合計 ×
-- 固定值」這個原本的做法。
select is(
  (get_merchant_billing_summary_by_range('e8020000-0000-4000-8000-000000000022', '2026-03-01'::date, '2026-05-31'::date) ->> 'total_monthly_salary_base')::numeric,
  185000.00,
  '§11.8 測試(核心,區間版本):[3/1,5/31] 逐月加總 = 110000(I:30000+40000+40000)+75000(J:25000×3估算)= 185000'
);

select is(
  (get_merchant_billing_summary_by_range('e8020000-0000-4000-8000-000000000022', '2026-03-01'::date, '2026-05-31'::date) ->> 'salary_estimation_applied')::boolean,
  true,
  '§11.8 測試(核心,區間版本):這段區間內 J 全部月份都是估算,salary_estimation_applied=true'
);

-- =========================================================================
-- ⑨ §11.9(決策記錄):per_staff_breakdown 維持「目前在職名單」,不逐月還原歷史人員名單——
-- 查詢過去(2026-02)、現在(2026-08)不同月份,in-職名單長度應該一致(都是目前 status=active 的
-- 服務人員數,不會因為查詢的月份不同而增減)。
-- =========================================================================
select is(
  jsonb_array_length(get_merchant_billing_summary('e8020000-0000-4000-8000-000000000022', 2026, 2) -> 'per_staff_breakdown'),
  jsonb_array_length(get_merchant_billing_summary('e8020000-0000-4000-8000-000000000022', 2026, 8) -> 'per_staff_breakdown'),
  '§11.9(決策記錄):per_staff_breakdown 的人數不隨查詢月份改變,維持「目前在職名單」,不逐月還原歷史人員名單'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
