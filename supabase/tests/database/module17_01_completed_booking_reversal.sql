-- #844 已完成訂單可取消/還原 —— pgTAP module17_01
-- 規格:.project/specs/已完成訂單取消與還原.md v1.2 §十「第 1 段(批次 1)」
-- 對應 migration:20261001090000_req844_completion_reversal_schema.sql
--
-- 第 1 段(批次 1,本檔目前內容):
--   A. 稽核表 booking_completion_reversals:RLS 開啟、只剩 SELECT 政策(to authenticated)、
--      管理員看得到本店看不到別店;只有 orders 鑰匙的客服 0 筆;anon 0 筆;
--      authenticated 直接 INSERT / UPDATE / DELETE → 42501(不是「靜默 0 列」);
--      CHECK(action、空白原因);兩條索引存在;created_at 預設 clock_timestamp()。
--   B. private.log_booking_status_change 五參數版寫入 note(空白 → null);四參數舊版行為不變
--      (直接四參數呼叫不會 42725 not unique、note 為 null);兩個版本 PUBLIC/anon/authenticated
--      都沒有 EXECUTE。
--   C. get_booking_status_change_logs 多回 note;orders 客服也拿得到 note;
--      drop/create 後權限:PUBLIC / anon 沒有、authenticated / service_role 有。
-- 第 2 段(批次 2,20261001090100_req844_completion_reversal_functions.sql):§十 第 4~21 條,
--   D 權限 / IDOR / 參數(含全形空白原因)、E 還原 → 重新完成 + 冪等、F 取消與帳務報表、G 跨月(台北)、
--   H 月薪制 / 警告 / 匯入單、I 點數(足夠、差額與提示、餘額 0、取消先退折抵、還原不退、下架與功能關閉、
--   推薦獎勵、預覽 = 執行結果)、J 中途失敗整筆回滾、K 既有舊函式不變。
--
-- 【第 2 段故障注入(2026-10-01 台北 12:0x,本機容器 create or replace 引擎後跑本檔,已用 db reset 還原)】
--   ④ 把「清 completed_at」移到收回點數之前 → I7 轉紅(提示列出本單完成之前的折抵單)。
--   ⑤ 拿掉取消路徑「先改狀態為 cancelled」→ F1、I11 轉紅(退回備註變成「訂單編輯…」)。
--   ⑥ 把收回點數移到退回折抵之前 → I12、I13、I15 轉紅(先收後退,差額變大)。
--   ⑦ 拿掉 is_merchant_admin 檢查 → D6、D7、D8、D10、D12、D21 轉紅。
--
-- 【故障注入(2026-10-01 實際跑過並還原,結果記在 engineer 回報)】
--   ① 把 anon / authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE 表權限加回去
--      → A5、A6、A10、A13、A14 共 5 條轉紅(UPDATE / DELETE 變成「靜默 0 列」no exception)。
--      A4(INSERT)仍綠:沒有 INSERT 政策時 RLS 本身也回 42501,INSERT 不是靜默,這是預期。
--   ② 五參數版 p_note 加上 `default null`(= 規格字面寫法)→ 本檔在建測試資料的 create_booking
--      就炸「function private.log_booking_status_change(uuid, uuid, unknown, unknown) is not unique」,
--      module6_08 同樣整檔失敗 —— 證明 default 會讓既有四支狀態函式全部壞掉。
--   ③ RLS 政策改成 private.can_manage_bookings → A9 轉紅(orders 客服看得到稽核表)。
begin;

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

select plan(109);

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

-- -------------------------------------------------------------------------
-- 測試資料:一店(管理員甲、orders 客服、無授權客服)、二店(管理員乙)
-- -------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('e8440000-0000-4000-8000-000000000001', 'pgtap-m17-admin1@test.local'),
  ('e8440000-0000-4000-8000-000000000002', 'pgtap-m17-admin2@test.local'),
  ('e8440000-0000-4000-8000-000000000003', 'pgtap-m17-agent-orders@test.local'),
  ('e8440000-0000-4000-8000-000000000004', 'pgtap-m17-agent-none@test.local');

insert into groups (id) values
  ('e8440000-0000-4000-8000-000000000011'),
  ('e8440000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e8440000-0000-4000-8000-000000000021', 'e8440000-0000-4000-8000-000000000011', '反轉稽核測試一店', 'in_store_beauty'),
  ('e8440000-0000-4000-8000-000000000022', 'e8440000-0000-4000-8000-000000000012', '反轉稽核測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e8440000-0000-4000-8000-000000000021', 'e8440000-0000-4000-8000-000000000001', '管理員甲'),
  ('e8440000-0000-4000-8000-000000000022', 'e8440000-0000-4000-8000-000000000002', '管理員乙');

insert into merchant_agents (id, merchant_id, user_id, name, nickname, invited_email, status, activated_at, phone) values
  ('e8440000-0000-4000-8000-000000000031', 'e8440000-0000-4000-8000-000000000021', 'e8440000-0000-4000-8000-000000000003', '客服有訂單鑰匙', '小訂', 'pgtap-m17-agent-orders@test.local', 'active', now(), '0900084401'),
  ('e8440000-0000-4000-8000-000000000032', 'e8440000-0000-4000-8000-000000000021', 'e8440000-0000-4000-8000-000000000004', '客服無授權', null, 'pgtap-m17-agent-none@test.local', 'active', now(), '0900084402');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e8440000-0000-4000-8000-000000000031', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('e8440000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59'),
  ('e8440000-0000-4000-8000-000000000022', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e8440000-0000-4000-8000-000000000041', 'e8440000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30),
  ('e8440000-0000-4000-8000-000000000042', 'e8440000-0000-4000-8000-000000000022', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('e8440000-0000-4000-8000-000000000051', 'e8440000-0000-4000-8000-000000000021', '一店服務人員', '0901084401', true),
  ('e8440000-0000-4000-8000-000000000052', 'e8440000-0000-4000-8000-000000000022', '二店服務人員', '0901084402', true);

insert into payment_methods (id, merchant_id, name) values
  ('e8440000-0000-4000-8000-000000000061', 'e8440000-0000-4000-8000-000000000021', '現場付款'),
  ('e8440000-0000-4000-8000-000000000062', 'e8440000-0000-4000-8000-000000000022', '現場付款');

-- 一店、二店各一張已完成訂單(管理員本人建立 → 確認 → 完成)。
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000001');
select id from create_booking(
  'e8440000-0000-4000-8000-000000000021', 'e8440000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'e8440000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 09:00:00+08', '客戶甲', '0955084401',
  p_payment_method_id => 'e8440000-0000-4000-8000-000000000061'
) \gset booking_a_
select confirm_booking(:'booking_a_id'::uuid);
select complete_booking(:'booking_a_id'::uuid);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000002');
select id from create_booking(
  'e8440000-0000-4000-8000-000000000022', 'e8440000-0000-4000-8000-000000000052',
  jsonb_build_array(jsonb_build_object('service_item_id', 'e8440000-0000-4000-8000-000000000042', 'quantity', 1, 'unit_price', 300)),
  '2026-09-22 09:00:00+08', '客戶乙', '0955084402',
  p_payment_method_id => 'e8440000-0000-4000-8000-000000000062'
) \gset booking_b_
select confirm_booking(:'booking_b_id'::uuid);
select complete_booking(:'booking_b_id'::uuid);
select pg_temp.test_clear_auth();

-- 批次 1 還沒有反轉引擎 ⇒ 稽核列以 postgres 身分(繞過 RLS,等同引擎的 owner 身分)直接放進去。
insert into booking_completion_reversals (
  id, booking_id, merchant_id, action, reason, actor_user_id, actor_name_snapshot,
  original_completed_at, report_month, is_cross_month, commission_amount_reversed,
  points_due, points_recovered, points_shortfall, shortfall_hint
) values
  ('e8440000-0000-4000-8000-000000000091', :'booking_a_id'::uuid, 'e8440000-0000-4000-8000-000000000021',
   'revert_to_accepted', '誤按完成', 'e8440000-0000-4000-8000-000000000001', '管理員甲',
   '2026-09-22 10:00:00+08', '2026-09', true, 120.50, 30, 20, 10, '推薦人目前餘額 5 點'),
  ('e8440000-0000-4000-8000-000000000092', :'booking_b_id'::uuid, 'e8440000-0000-4000-8000-000000000022',
   'cancel_completed', '客戶退單', 'e8440000-0000-4000-8000-000000000002', '管理員乙',
   '2026-09-22 10:00:00+08', '2026-09', true, 0, 0, 0, 0, null);

-- =========================================================================
-- A. 稽核表
-- =========================================================================
select ok(
  (select relrowsecurity from pg_class where oid = 'public.booking_completion_reversals'::regclass),
  'A1:booking_completion_reversals 的 RLS 已開啟'
);

select is(
  (select array_agg(policyname::text || ':' || cmd || ':' || roles::text order by policyname) from pg_policies
   where schemaname = 'public' and tablename = 'booking_completion_reversals'),
  array['booking_completion_reversals_select:SELECT:{authenticated}'],
  'A2:只有一條 SELECT 政策,角色是 authenticated(沒有 INSERT / UPDATE / DELETE 政策)'
);

-- 管理員甲:只看得到本店那筆
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000001');
select is(
  (select array_agg(id::text) from booking_completion_reversals),
  array['e8440000-0000-4000-8000-000000000091'],
  'A3:一店管理員只看得到本店那一筆(看不到二店)'
);

-- A4~A6:管理員本人(最大權限)直接寫表也一律 42501,證明不是「靜默 0 列」。
select throws_ok(
  format($$insert into booking_completion_reversals (booking_id, merchant_id, action, reason, actor_name_snapshot,
           original_completed_at, report_month, is_cross_month)
           values ('%s', 'e8440000-0000-4000-8000-000000000021', 'cancel_completed', '偽造', '偽造者',
                   now(), '2026-10', false)$$, :'booking_a_id'),
  '42501', null,
  'A4 🔴:管理員直接 INSERT 稽核表 → 42501'
);
select throws_ok(
  $$update booking_completion_reversals set reason = '竄改' where id = 'e8440000-0000-4000-8000-000000000091'$$,
  '42501', null,
  'A5 🔴:管理員直接 UPDATE 稽核表 → 42501(是報錯,不是靜默 0 列)'
);
select throws_ok(
  $$delete from booking_completion_reversals where id = 'e8440000-0000-4000-8000-000000000091'$$,
  '42501', null,
  'A6 🔴:管理員直接 DELETE 稽核表 → 42501'
);
select pg_temp.test_clear_auth();

-- 管理員乙:只看得到二店
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000002');
select is(
  (select array_agg(id::text) from booking_completion_reversals),
  array['e8440000-0000-4000-8000-000000000092'],
  'A7:二店管理員只看得到二店那一筆(IDOR:看不到一店)'
);
select is(
  (select count(*)::int from booking_completion_reversals where id = 'e8440000-0000-4000-8000-000000000091'),
  0,
  'A8:二店管理員指定一店稽核列的 id 直接查 → 0 筆'
);
select pg_temp.test_clear_auth();

-- 客服(有 orders 鑰匙)— 稽核表含抽成金額與推薦人餘額,不給
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000003');
select is(
  (select count(*)::int from booking_completion_reversals),
  0,
  'A9 🔴:只有 orders 鑰匙的客服 SELECT 稽核表 → 0 筆(管理員專屬,不是 can_manage_bookings)'
);
select throws_ok(
  $$delete from booking_completion_reversals$$,
  '42501', null,
  'A10:客服直接 DELETE → 42501'
);
select pg_temp.test_clear_auth();

-- 沒有授權的客服
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000004');
select is(
  (select count(*)::int from booking_completion_reversals),
  0,
  'A11:沒有任何鑰匙的客服 → 0 筆'
);
select pg_temp.test_clear_auth();

-- anon
select pg_temp.test_set_auth(null, 'anon');
select is(
  (select count(*)::int from booking_completion_reversals),
  0,
  'A12:anon SELECT → 0 筆(沒有 anon 政策)'
);
select throws_ok(
  $$update booking_completion_reversals set reason = 'x'$$,
  '42501', null,
  'A13:anon 直接 UPDATE → 42501'
);
select pg_temp.test_clear_auth();

select ok(
  not has_table_privilege('authenticated', 'public.booking_completion_reversals', 'insert')
  and not has_table_privilege('authenticated', 'public.booking_completion_reversals', 'update')
  and not has_table_privilege('authenticated', 'public.booking_completion_reversals', 'delete')
  and not has_table_privilege('authenticated', 'public.booking_completion_reversals', 'truncate')
  and not has_table_privilege('anon', 'public.booking_completion_reversals', 'insert')
  and not has_table_privilege('anon', 'public.booking_completion_reversals', 'update')
  and not has_table_privilege('anon', 'public.booking_completion_reversals', 'delete')
  and not has_table_privilege('anon', 'public.booking_completion_reversals', 'truncate'),
  'A14:anon / authenticated 沒有 INSERT / UPDATE / DELETE / TRUNCATE 表權限'
);

-- CHECK 約束(postgres 身分 = 引擎的 owner 身分,也擋得住)
select throws_ok(
  format($$insert into booking_completion_reversals (booking_id, merchant_id, action, reason, actor_name_snapshot,
           original_completed_at, report_month, is_cross_month)
           values ('%s', 'e8440000-0000-4000-8000-000000000021', 'revert_to_accepted', '   ', '管理員甲',
                   now(), '2026-10', false)$$, :'booking_a_id'),
  '23514', null,
  'A15:原因純空白 → CHECK 擋下(連 owner 身分也寫不進去)'
);
select throws_ok(
  format($$insert into booking_completion_reversals (booking_id, merchant_id, action, reason, actor_name_snapshot,
           original_completed_at, report_month, is_cross_month)
           values ('%s', 'e8440000-0000-4000-8000-000000000021', 'revert_to_pending', '原因', '管理員甲',
                   now(), '2026-10', false)$$, :'booking_a_id'),
  '23514', null,
  'A16:action 只接受 revert_to_accepted / cancel_completed'
);

select is(
  (select array_agg(indexname::text order by indexname) from pg_indexes
   where schemaname = 'public' and tablename = 'booking_completion_reversals'
     and indexname <> 'booking_completion_reversals_pkey'),
  array['booking_completion_reversals_booking_id_created_at_idx',
        'booking_completion_reversals_merchant_id_report_month_idx'],
  'A17:索引 (booking_id, created_at)、(merchant_id, report_month) 都在'
);

select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'booking_completion_reversals' and column_name = 'created_at'),
  'clock_timestamp()',
  'A18:created_at 預設 clock_timestamp()(同一交易內連續兩筆不會同一時間)'
);

-- =========================================================================
-- B. log_booking_status_change 五參數版 / 四參數舊版
-- =========================================================================
-- 用管理員甲的身分寫(actor 快照才會是管理員甲);private 函式 authenticated 無法直接呼叫,
-- 所以在 postgres 角色下帶甲的 jwt claims 執行(等同 SECURITY DEFINER 引擎內部 perform)。
select set_config('request.jwt.claims',
  json_build_object('sub', 'e8440000-0000-4000-8000-000000000001', 'role', 'authenticated')::text, true);

select lives_ok(
  format($$select private.log_booking_status_change('%s', 'e8440000-0000-4000-8000-000000000021', 'accepted', 'accepted')$$,
         :'booking_a_id'),
  'B1 🔴:直接用四參數呼叫舊版不會 42725 not unique(五參數版 p_note 沒有 default)'
);
select is(
  (select note from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status = 'accepted' and to_status = 'accepted'),
  null,
  'B2:四參數舊版寫入的 note 仍是 null(行為不變)'
);

select private.log_booking_status_change(:'booking_a_id'::uuid, 'e8440000-0000-4000-8000-000000000021',
                                         'completed', 'accepted', '  誤按完成,客人還沒付款  ');
select is(
  (select note from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status = 'completed' and to_status = 'accepted'),
  '誤按完成,客人還沒付款',
  'B3:五參數版把原因寫進 note(去頭尾空白)'
);
select is(
  (select actor_name_snapshot || '/' || actor_role_snapshot from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status = 'completed' and to_status = 'accepted'),
  '管理員甲/merchant_admin',
  'B4:五參數版的操作者快照與四參數版同一套邏輯'
);

select private.log_booking_status_change(:'booking_a_id'::uuid, 'e8440000-0000-4000-8000-000000000021',
                                         'completed', 'cancelled', '   ');
select is(
  (select note from booking_status_change_logs
   where booking_id = :'booking_a_id'::uuid and from_status = 'completed' and to_status = 'cancelled'),
  null,
  'B5:五參數版原因純空白 → note 存 null(畫面不會出現空的「原因:」)'
);
select set_config('request.jwt.claims', '', true);

select ok(
  not has_function_privilege('public', 'private.log_booking_status_change(uuid, uuid, text, text, text)', 'execute')
  and not has_function_privilege('anon', 'private.log_booking_status_change(uuid, uuid, text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_booking_status_change(uuid, uuid, text, text, text)', 'execute'),
  'B6:五參數版 PUBLIC / anon / authenticated 都沒有 EXECUTE(不能偽造操作紀錄)'
);
select ok(
  not has_function_privilege('public', 'private.log_booking_status_change(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'private.log_booking_status_change(uuid, uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_booking_status_change(uuid, uuid, text, text)', 'execute'),
  'B7:四參數舊版權限維持不變'
);

-- =========================================================================
-- C. get_booking_status_change_logs 多回 note
-- =========================================================================
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000001');
select is(
  (select note from get_booking_status_change_logs(:'booking_a_id'::uuid)
   where from_status = 'completed' and to_status = 'accepted'),
  '誤按完成,客人還沒付款',
  'C1:管理員查操作紀錄拿得到 note'
);
select is(
  (select count(*)::int from get_booking_status_change_logs(:'booking_a_id'::uuid) where note is null),
  5,
  'C2:其他轉換(建立 / 確認 / 完成 / 四參數那筆 / 空白原因那筆)note 都是 null'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000003');
select is(
  (select note from get_booking_status_change_logs(:'booking_a_id'::uuid)
   where from_status = 'completed' and to_status = 'accepted'),
  '誤按完成,客人還沒付款',
  'C3:有 orders 鑰匙的客服也看得到原因(note 只放原因,不放點數)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000002');
select throws_ok(
  format($$select * from get_booking_status_change_logs('%s')$$, :'booking_a_id'),
  '42501', null,
  'C4:drop/create 後跨商家隔離仍在(二店管理員查一店 → 42501)'
);
select pg_temp.test_clear_auth();

select ok(
  not has_function_privilege('public', 'public.get_booking_status_change_logs(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_booking_status_change_logs(uuid)', 'execute'),
  'C5:drop/create 後 PUBLIC / anon 沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.get_booking_status_change_logs(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.get_booking_status_change_logs(uuid)', 'execute'),
  'C6:drop/create 後 authenticated / service_role 有 EXECUTE(與正式庫現況一致)'
);


-- #########################################################################
-- 第 2 段(批次 2):反轉引擎 + 預覽 + 還原/取消兩個入口(§十 第 4~21 條)
-- 對應 migration:20261001090100_req844_completion_reversal_functions.sql
-- 測試資料一律放在獨立的「反轉引擎測試三店」(e8440000-…-0000000000023),不碰第 1 段的一店/二店資料。
-- 時間:完成時間 = 交易開始的 now();跨月判斷與報表月份一律用台北時區(automated-testing skill #933/#934)。
-- 注意:同一交易內 now() 固定,分類帳 created_at(預設 now())同一交易內都相同 ⇒
--   「退回折抵在收回之前」改用 balance_after 串接證明(退回那筆的餘額 − 收回點數 = 收回那筆的餘額);
--   「提示只列本單完成之後的折抵單」用把「之前那張」的折抵分類帳 created_at 往前調一天來製造。
-- #########################################################################

create temporary sequence m17seq;

create function pg_temp.m17_member(p_phone text)
returns uuid language sql security definer as $$
  select r.member_id from private.resolve_booking_member_by_phone('e8440000-0000-4000-8000-000000000023', p_phone) r
  where r.match_count = 1;
$$;

-- 三店建單(電話連結既有會員;每張單排不同天,避免時段衝突)。
create function pg_temp.m17_mk(p_phone text, p_name text, p_redeemed int default 0,
                               p_staff uuid default 'e8440000-0000-4000-8000-000000000251',
                               p_override int default null)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'e8440000-0000-4000-8000-000000000023',
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object(
      'service_item_id', 'e8440000-0000-4000-8000-000000000241', 'quantity', 1, 'unit_price', 1000)),
    p_start_at => timestamptz '2027-03-01 10:00:00+08' + make_interval(days => nextval('pg_temp.m17seq')::int),
    p_customer_name => p_name,
    p_customer_phone => p_phone,
    p_payment_method_id => 'e8440000-0000-4000-8000-000000000261',
    p_points_override => p_override,
    p_points_redeemed => p_redeemed,
    p_points_redeem_member_id => case when p_redeemed > 0 then pg_temp.m17_member(p_phone) end
  );
$$;

create function pg_temp.m17_done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;

create function pg_temp.m17_bal(p_member uuid)
returns int language sql as $$ select points_balance from public.members where id = p_member; $$;

create function pg_temp.m17_cnt(p_booking uuid, p_type text)
returns int language sql as $$
  select count(*)::int from public.member_point_transactions where booking_id = p_booking and transaction_type = p_type;
$$;

grant usage on sequence pg_temp.m17seq to authenticated;
grant execute on function pg_temp.m17_mk(text, text, int, uuid, int), pg_temp.m17_done(uuid), pg_temp.m17_member(text) to authenticated;

-- -------------------------------------------------------------------------
-- 第 2 段 Fixture:三店(管理員丙、orders 客服)、兩位按件服務人員(抽成 10%)、一位月薪服務人員
-- -------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('e8440000-0000-4000-8000-000000000005', 'pgtap-m17-admin3@test.local'),
  ('e8440000-0000-4000-8000-000000000006', 'pgtap-m17-agent3-orders@test.local');

insert into groups (id) values ('e8440000-0000-4000-8000-000000000013');

insert into merchants (id, group_id, name, industry_type) values
  ('e8440000-0000-4000-8000-000000000023', 'e8440000-0000-4000-8000-000000000013', '反轉引擎測試三店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e8440000-0000-4000-8000-000000000023', 'e8440000-0000-4000-8000-000000000005', '管理員丙');

insert into merchant_agents (id, merchant_id, user_id, name, nickname, invited_email, status, activated_at, phone) values
  ('e8440000-0000-4000-8000-000000000233', 'e8440000-0000-4000-8000-000000000023', 'e8440000-0000-4000-8000-000000000006',
   '三店客服', null, 'pgtap-m17-agent3-orders@test.local', 'active', now(), '0900084403');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e8440000-0000-4000-8000-000000000233', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e8440000-0000-4000-8000-000000000023', d, false, '00:00', '23:59' from generate_series(0, 6) d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('e8440000-0000-4000-8000-000000000241', 'e8440000-0000-4000-8000-000000000023', '保養', 1000, 'primary', 30, 'active');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, compensation_type) values
  ('e8440000-0000-4000-8000-000000000251', 'e8440000-0000-4000-8000-000000000023', '三店服務人員', '0901084403', true, 'piece_rate'),
  ('e8440000-0000-4000-8000-000000000252', 'e8440000-0000-4000-8000-000000000023', '即將移除服務人員', '0901084404', true, 'piece_rate'),
  ('e8440000-0000-4000-8000-000000000253', 'e8440000-0000-4000-8000-000000000023', '月薪服務人員', '0901084405', true, 'monthly_salary');

insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('e8440000-0000-4000-8000-000000000251', 'e8440000-0000-4000-8000-000000000241', 'percentage', 10),
  ('e8440000-0000-4000-8000-000000000252', 'e8440000-0000-4000-8000-000000000241', 'percentage', 10);

insert into payment_methods (id, merchant_id, name) values
  ('e8440000-0000-4000-8000-000000000261', 'e8440000-0000-4000-8000-000000000023', '現場付款');

-- 每筆 10 點;100 點 = 10 元、最多 50%;推薦開關開、首次 20 點、後續 5 點。
insert into merchant_member_settings (
  merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
  redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent,
  referral_inviter_reward_enabled, referral_bonus_points, referral_subsequent_bonus_points
) values ('e8440000-0000-4000-8000-000000000023', 'basic', 10, 0, 100, 10, 50, true, 20, 5);

insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('e8440000-0000-4000-8000-000000000201', 'e8440000-0000-4000-8000-000000000023', '還原會員', '0916084201', 'M17R201', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000202', 'e8440000-0000-4000-8000-000000000023', '取消會員', '0916084202', 'M17R202', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000203', 'e8440000-0000-4000-8000-000000000023', '差額會員', '0916084203', 'M17R203', 195, 'active'),
  ('e8440000-0000-4000-8000-000000000204', 'e8440000-0000-4000-8000-000000000023', '歸零會員', '0916084204', 'M17R204', 90, 'active'),
  ('e8440000-0000-4000-8000-000000000205', 'e8440000-0000-4000-8000-000000000023', '折抵取消會員', '0916084205', 'M17R205', 100, 'active'),
  ('e8440000-0000-4000-8000-000000000206', 'e8440000-0000-4000-8000-000000000023', '折抵還原會員', '0916084206', 'M17R206', 100, 'active'),
  ('e8440000-0000-4000-8000-000000000207', 'e8440000-0000-4000-8000-000000000023', '下架會員', '0916084207', 'M17R207', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000208', 'e8440000-0000-4000-8000-000000000023', '功能關閉會員', '0916084208', 'M17R208', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000210', 'e8440000-0000-4000-8000-000000000023', '推薦人甲', '0916084210', 'M17R210', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000212', 'e8440000-0000-4000-8000-000000000023', '推薦人乙', '0916084212', 'M17R212', 0, 'active'),
  ('e8440000-0000-4000-8000-000000000214', 'e8440000-0000-4000-8000-000000000023', '回滾會員', '0916084214', 'M17R214', 100, 'active');
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status, referred_by_member_id) values
  ('e8440000-0000-4000-8000-000000000211', 'e8440000-0000-4000-8000-000000000023', '被推薦甲', '0916084211', 'M17R211', 0, 'active', 'e8440000-0000-4000-8000-000000000210'),
  ('e8440000-0000-4000-8000-000000000213', 'e8440000-0000-4000-8000-000000000023', '被推薦乙', '0916084213', 'M17R213', 0, 'active', 'e8440000-0000-4000-8000-000000000212');

-- 建單 + 完成(全部以管理員丙身分)
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select pg_temp.m17_mk('0916084201', '還原客人') as id \gset rv_
select pg_temp.m17_done(:'rv_id'::uuid);
select pg_temp.m17_mk('0916084202', '取消客人') as id \gset cc_
select pg_temp.m17_done(:'cc_id'::uuid);
select pg_temp.m17_mk('0916084202', '還沒完成的客人') as id \gset acc_
select confirm_booking(:'acc_id'::uuid);
-- 差額情境:折抵在前(完成之前)→ 本單完成 → 折抵在後
select pg_temp.m17_mk('0916084203', '折抵在前', 100) as id \gset kb_
select pg_temp.m17_mk('0916084203', '差額本單') as id \gset sf_
select pg_temp.m17_done(:'sf_id'::uuid);
select pg_temp.m17_mk('0916084203', '折抵在後', 100) as id \gset ka_
-- 餘額剛好 0
select pg_temp.m17_mk('0916084204', '歸零本單') as id \gset z_
select pg_temp.m17_done(:'z_id'::uuid);
select pg_temp.m17_mk('0916084204', '歸零花光', 100) as id \gset zs_
-- 取消 + 折抵:本單折抵 100(餘額 0)→ 完成 +10 → 另一張單折抵 10(餘額 0)
select pg_temp.m17_mk('0916084205', '折抵取消本單', 100) as id \gset rc_
select pg_temp.m17_done(:'rc_id'::uuid);
select pg_temp.m17_mk('0916084205', '折抵取消花光', 10) as id \gset rcs_
-- 還原 + 折抵(還原不退凍結)
select pg_temp.m17_mk('0916084206', '折抵還原本單', 100) as id \gset rr_
select pg_temp.m17_done(:'rr_id'::uuid);
-- 會員下架 / 功能關閉
select pg_temp.m17_mk('0916084207', '下架本單') as id \gset rm_
select pg_temp.m17_done(:'rm_id'::uuid);
select pg_temp.m17_mk('0916084208', '功能關閉本單') as id \gset off_
select pg_temp.m17_done(:'off_id'::uuid);
-- 推薦:被推薦甲第一單(推薦人甲拿首次 20);被推薦乙第一單(推薦人乙拿 20 後花光)
select pg_temp.m17_mk('0916084211', '被推薦甲本單') as id \gset ref1_
select pg_temp.m17_done(:'ref1_id'::uuid);
select pg_temp.m17_mk('0916084213', '被推薦乙本單') as id \gset ref2_
select pg_temp.m17_done(:'ref2_id'::uuid);
select pg_temp.m17_mk('0916084212', '推薦人乙花光', 20) as id \gset ref2s_
-- 回滾情境:折抵 100 + 入帳 10 + 抽成
select pg_temp.m17_mk('0916084214', '回滾本單', 100) as id \gset rb_
select pg_temp.m17_done(:'rb_id'::uuid);
-- 跨月 / 月薪 / 警告 / 匯入 / 冪等
select pg_temp.m17_mk('0916084290', '跨月客人') as id \gset xm_
select pg_temp.m17_done(:'xm_id'::uuid);
select pg_temp.m17_mk('0916084291', '月薪客人', 0, 'e8440000-0000-4000-8000-000000000253') as id \gset mo_
select pg_temp.m17_done(:'mo_id'::uuid);
select pg_temp.m17_mk('0916084292', '警告客人', 0, 'e8440000-0000-4000-8000-000000000252') as id \gset wn_
select pg_temp.m17_done(:'wn_id'::uuid);
select pg_temp.m17_mk('0916084293', '匯入客人') as id \gset im_
select pg_temp.m17_done(:'im_id'::uuid);
select pg_temp.m17_mk('0916084294', '零點客人', 0, 'e8440000-0000-4000-8000-000000000251', 0) as id \gset np_
select pg_temp.m17_done(:'np_id'::uuid);
select pg_temp.test_clear_auth();

-- 「折抵在前」那張的折抵分類帳往前調一天(= 本單完成之前就折抵掉的)。
update member_point_transactions set created_at = now() - interval '1 day'
where booking_id = :'kb_id'::uuid and transaction_type = 'redeem_booking';

-- 匯入單:改成 source='import' 並拿掉抽成(匯入單本來就沒有快照)。
update bookings set source = 'import' where id = :'im_id'::uuid;
delete from booking_commission_records where booking_id = :'im_id'::uuid;

-- 警告情境:服務人員事後被移除且改月薪、抽成被人工重算過(以 service_role 身分繞過欄位保護 trigger)。
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
update merchant_staff set status = 'removed', compensation_type = 'monthly_salary'
where id = 'e8440000-0000-4000-8000-000000000252';
select set_config('request.jwt.claims', '', true);
update booking_commission_records set recalculated_at = now() where booking_id = :'wn_id'::uuid;

-- =========================================================================
-- D. 權限、IDOR、參數檢查(§十 第 4、5 條)
-- =========================================================================
select ok(
  not has_function_privilege('public', 'private.reverse_booking_completion(uuid, text, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'private.reverse_booking_completion(uuid, text, text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'private.reverse_booking_completion(uuid, text, text, boolean)', 'execute'),
  'D1:反轉引擎 PUBLIC / anon / authenticated 都沒有 EXECUTE(只能透過兩個入口)'
);
select ok(
  not has_function_privilege('anon', 'public.revert_completed_booking(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'public.cancel_completed_booking(uuid, text, boolean)', 'execute')
  and not has_function_privilege('anon', 'public.get_completed_booking_reversal_preview(uuid)', 'execute')
  and not has_function_privilege('public', 'public.revert_completed_booking(uuid, text)', 'execute')
  and not has_function_privilege('public', 'public.cancel_completed_booking(uuid, text, boolean)', 'execute')
  and not has_function_privilege('public', 'public.get_completed_booking_reversal_preview(uuid)', 'execute'),
  'D2:三支 public 函式 PUBLIC / anon 沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.revert_completed_booking(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'public.cancel_completed_booking(uuid, text, boolean)', 'execute')
  and has_function_privilege('authenticated', 'public.get_completed_booking_reversal_preview(uuid)', 'execute'),
  'D3:三支 public 函式 authenticated 有 EXECUTE(真正的管理員檢查在函式內)'
);
select ok(
  (select bool_and(p.prosecdef and p.proconfig @> array['search_path=public'])
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('private', 'reverse_booking_completion'), ('public', 'revert_completed_booking'),
                                    ('public', 'cancel_completed_booking'), ('public', 'get_completed_booking_reversal_preview'))),
  'D4:四支函式都是 SECURITY DEFINER 且固定 search_path = public'
);

-- 有訂單鑰匙的客服:三支都 42501,而且對「已完成」與「已確認」的單錯誤訊息一模一樣(不洩漏狀態)
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000006');
select throws_ok(format($$select get_completed_booking_reversal_preview('%s')$$, :'rv_id'),
  '42501', '還原或取消已完成的訂單,只有商家管理員可以操作', 'D5 🔴:客服呼叫預覽 → 42501');
select throws_ok(format($$select revert_completed_booking('%s', '誤按')$$, :'rv_id'),
  '42501', '還原或取消已完成的訂單,只有商家管理員可以操作', 'D6 🔴:客服呼叫還原 → 42501');
select throws_ok(format($$select cancel_completed_booking('%s', '誤按', true)$$, :'rv_id'),
  '42501', '還原或取消已完成的訂單,只有商家管理員可以操作', 'D7 🔴:客服呼叫取消 → 42501');
select throws_ok(format($$select revert_completed_booking('%s', '誤按')$$, :'acc_id'),
  '42501', '還原或取消已完成的訂單,只有商家管理員可以操作',
  'D8:客服對「已確認」的單呼叫 → 同一個 42501 訊息(先擋權限再回報狀態,不洩漏訂單狀態)');
select pg_temp.test_clear_auth();

-- 別店管理員(IDOR)
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000002');
select throws_ok(format($$select get_completed_booking_reversal_preview('%s')$$, :'rv_id'),
  '42501', null, 'D9 🔴:二店管理員查三店訂單的預覽 → 42501(IDOR)');
select throws_ok(format($$select cancel_completed_booking('%s', '惡意取消')$$, :'rv_id'),
  '42501', null, 'D10 🔴:二店管理員取消三店訂單 → 42501(IDOR)');
select pg_temp.test_clear_auth();

-- anon
select pg_temp.test_set_auth(null, 'anon');
select throws_ok(format($$select revert_completed_booking('%s', '誤按')$$, :'rv_id'),
  '42501', null, 'D11:anon 呼叫還原 → 42501(沒有 EXECUTE)');
select pg_temp.test_clear_auth();

select is(
  (select status from bookings where id = :'rv_id'::uuid), 'completed',
  'D12:上面所有被擋下的呼叫都沒有動到訂單'
);

-- 管理員丙:狀態與參數檢查
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select throws_ok(format($$select revert_completed_booking('%s', '誤按')$$, :'acc_id'),
  'P0001', '這筆訂單的狀態已經改變,請重新整理後再試', 'D13:對「已確認」的單還原 → 狀態已改變');
select throws_ok(format($$select cancel_completed_booking('%s', '誤按')$$, :'acc_id'),
  'P0001', '這筆訂單的狀態已經改變,請重新整理後再試', 'D14:對「已確認」的單取消 → 狀態已改變');
select throws_ok(format($$select get_completed_booking_reversal_preview('%s')$$, :'acc_id'),
  'P0001', '這筆訂單的狀態已經改變,請重新整理後再試', 'D15:對「已確認」的單預覽 → 狀態已改變');
select throws_ok(format($$select revert_completed_booking('%s', '')$$, :'rv_id'),
  '22023', '請填寫還原/取消的原因', 'D16:原因空字串 → 擋下');
select throws_ok(format($$select cancel_completed_booking('%s', E'  \t ')$$, :'rv_id'),
  '22023', '請填寫還原/取消的原因', 'D17:原因只有空白與 tab → 擋下');
select throws_ok(format($$select revert_completed_booking('%s', E'　　\n')$$, :'rv_id'),
  '22023', '請填寫還原/取消的原因', 'D17b:原因只有全形空白與換行 → 擋下(btrim 預設只去半形空白)');
select throws_ok(format($$select revert_completed_booking('%s', null)$$, :'rv_id'),
  '22023', '請填寫還原/取消的原因', 'D18:原因 null → 擋下');
select throws_ok(format($$select revert_completed_booking('%s', repeat('字', 501))$$, :'rv_id'),
  '22023', '原因最多 500 個字,目前是 501 個字,請精簡後再送出', 'D19:原因 501 字 → 擋下');
select throws_ok($$select revert_completed_booking('e8440000-0000-4000-8000-0000000009ff', '誤按')$$,
  'P0002', '找不到這筆預約', 'D20:不存在的訂單 → 找不到');
select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from booking_completion_reversals where booking_id = :'rv_id'::uuid), 0,
  'D21:參數錯誤都沒有寫稽核'
);

-- =========================================================================
-- E. 還原完成 → 重新完成(§十 第 6、7 條)+ 冪等
-- =========================================================================
select id as old_rec_id,
       (select count(*)::int from booking_commission_item_records i where i.commission_record_id = r.id) as item_count
from booking_commission_records r where booking_id = :'rv_id'::uuid \gset rv_

select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select (get_staff_commission_summary('e8440000-0000-4000-8000-000000000251',
          extract(year from now() at time zone 'Asia/Taipei')::int,
          extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'total_commission_amount')::numeric as before
\gset staffsum_
select revert_completed_booking(:'rv_id'::uuid, '  誤按完成,客人還沒做  ') as result \gset rv_
select (get_staff_commission_summary('e8440000-0000-4000-8000-000000000251',
          extract(year from now() at time zone 'Asia/Taipei')::int,
          extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'total_commission_amount')::numeric as after_revert
\gset staffsum_
select pg_temp.test_clear_auth();

select is(
  (select status || '/' || coalesce(completed_at::text, 'null') || '/' || coalesce(cancelled_at::text, 'null')
   from bookings where id = :'rv_id'::uuid),
  'accepted/null/null',
  'E1:還原後 status=accepted、completed_at 清空、cancelled_at 不動'
);
select is(
  (select count(*)::int from booking_commission_records where booking_id = :'rv_id'::uuid)
  + (select count(*)::int from booking_commission_item_records where commission_record_id = :'rv_old_rec_id'::uuid),
  0,
  'E2:抽成彙總與明細都刪掉了(明細 cascade)'
);
select is(
  (select action || '/' || reason || '/' || actor_name_snapshot || '/' || commission_amount_reversed::text || '/'
          || jsonb_array_length(commission_record_snapshot -> 'items')::text || '/' || (commission_record_snapshot ->> 'id')
          || '/' || notified::text || '/' || frozen_points_refunded::text
   from booking_completion_reversals where booking_id = :'rv_id'::uuid),
  'revert_to_accepted/誤按完成,客人還沒做/管理員丙/100.00/' || :'rv_item_count' || '/' || :'rv_old_rec_id' || '/false/0',
  'E3:稽核 +1:action、原因(去頭尾空白)、操作者、抽成金額、快照含 items(長度 = 原明細數)與原彙總列、notified=false、退回 0'
);
select is(
  (select report_month || '/' || is_cross_month::text from booking_completion_reversals where booking_id = :'rv_id'::uuid),
  to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM') || '/false',
  'E4:稽核 report_month 用台北時區;本月完成 → 不跨月'
);
select is(
  (select array_agg(from_status || '→' || to_status || ':' || coalesce(note, 'null') order by created_at)
   from booking_status_change_logs where booking_id = :'rv_id'::uuid and from_status = 'completed'),
  array['completed→accepted:誤按完成,客人還沒做'],
  'E5:操作紀錄 +1 筆 completed → accepted,note 只有原因(不含點數 / 餘額)'
);
select is(
  (:'rv_result'::jsonb ->> 'action') || '/' || (:'rv_result'::jsonb -> 'booking' ->> 'status') || '/'
    || (:'rv_result'::jsonb ->> 'commission_amount_reversed') || '/' || (:'rv_result'::jsonb ->> 'is_cross_month'),
  'revert_to_accepted/accepted/100.00/false',
  'E6:回傳 jsonb:action、最新 booking、抽成收回金額、跨月旗標'
);
select is(
  :'staffsum_after_revert'::numeric, :'staffsum_before'::numeric - 100,
  'E7:還原後服務人員報表本月抽成合計少 100'
);

-- 冪等:再按一次還原、再按一次取消 → 狀態已改變,不會重複反轉
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select throws_ok(format($$select revert_completed_booking('%s', '又按一次')$$, :'rv_id'),
  'P0001', '這筆訂單的狀態已經改變,請重新整理後再試', 'E8:同一張單重複按還原 → 狀態已改變');
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from booking_completion_reversals where booking_id = :'rv_id'::uuid)
  || '/' || pg_temp.m17_cnt(:'rv_id'::uuid, 'earn_booking_reversal')
  || '/' || (select count(*)::int from booking_status_change_logs where booking_id = :'rv_id'::uuid and from_status = 'completed'),
  '1/1/1',
  'E9:重複按後稽核、收回分類帳、操作紀錄都仍只有 1 筆(冪等)'
);

-- 重新完成(走既有 complete_booking)
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select complete_booking(:'rv_id'::uuid);
select (get_staff_commission_summary('e8440000-0000-4000-8000-000000000251',
          extract(year from now() at time zone 'Asia/Taipei')::int,
          extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'total_commission_amount')::numeric as after_recomplete
\gset staffsum_
select pg_temp.test_clear_auth();
select ok(
  (select id <> :'rv_old_rec_id'::uuid and commission_amount = 100 from booking_commission_records where booking_id = :'rv_id'::uuid),
  'E10:重新完成寫入新的抽成快照(新的一列,不是被 on conflict 吃掉)'
);
select is(
  :'staffsum_after_recomplete'::numeric, :'staffsum_before'::numeric,
  'E11:重新完成後服務人員報表本月合計回到原值'
);

-- =========================================================================
-- F. 取消已完成訂單:報表跟著變(§十 第 8 條)
-- =========================================================================
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select (s ->> 'total_revenue_excl_tax')::numeric as rev, (s ->> 'total_commission_payout')::numeric as com,
       (select (e ->> 'order_count')::int from jsonb_array_elements(s -> 'per_staff_breakdown') e
        where e ->> 'staff_id' = 'e8440000-0000-4000-8000-000000000251') as cnt
from (select get_merchant_billing_summary('e8440000-0000-4000-8000-000000000023',
        extract(year from now() at time zone 'Asia/Taipei')::int,
        extract(month from now() at time zone 'Asia/Taipei')::int) as s) x \gset bill_before_
select cancel_completed_booking(:'cc_id'::uuid, '客人要求作廢', true) as result \gset cc_
select (s ->> 'total_revenue_excl_tax')::numeric as rev, (s ->> 'total_commission_payout')::numeric as com,
       (select (e ->> 'order_count')::int from jsonb_array_elements(s -> 'per_staff_breakdown') e
        where e ->> 'staff_id' = 'e8440000-0000-4000-8000-000000000251') as cnt
from (select get_merchant_billing_summary('e8440000-0000-4000-8000-000000000023',
        extract(year from now() at time zone 'Asia/Taipei')::int,
        extract(month from now() at time zone 'Asia/Taipei')::int) as s) x \gset bill_after_
select pg_temp.test_clear_auth();

select is(
  (select status || '/' || cancelled_reason || '/' || coalesce(completed_at::text, 'null') || '/' || (cancelled_at is not null)::text
          || '/' || (last_modified_by_user_id = 'e8440000-0000-4000-8000-000000000005')::text
   from bookings where id = :'cc_id'::uuid),
  'cancelled/客人要求作廢/null/true/true',
  'F1:取消後 status=cancelled、cancelled_reason=原因、completed_at 清空、cancelled_at 有值、最後修改者=管理員'
);
select is(
  :'bill_after_rev'::numeric || '/' || :'bill_after_com'::numeric || '/' || :'bill_after_cnt'::int,
  (:'bill_before_rev'::numeric - 1000) || '/' || (:'bill_before_com'::numeric - 100) || '/' || (:'bill_before_cnt'::int - 1),
  'F2:帳務報表本月營收 −1000、抽成支出 −100、該服務人員筆數 −1'
);
select is(
  (select action || '/' || notified::text from booking_completion_reversals where booking_id = :'cc_id'::uuid),
  'cancel_completed/true',
  'F3:稽核 action=cancel_completed、notified = 傳入的開關值(true)'
);
select is(
  (select from_status || '→' || to_status || ':' || note from booking_status_change_logs
   where booking_id = :'cc_id'::uuid and from_status = 'completed'),
  'completed→cancelled:客人要求作廢',
  'F4:操作紀錄 completed → cancelled,note = 原因'
);
select throws_ok(format($$select cancel_booking('%s', '舊入口')$$, :'cc_id'),
  null, null, 'F5:取消後是終止狀態(既有 cancel_booking 不接受已取消)');

-- =========================================================================
-- G. 跨月(§十 第 9 條,台北時區)
-- =========================================================================
-- 完成時間 = 上個月最後一天 23:59(台北)
update bookings
set completed_at = (date_trunc('month', now() at time zone 'Asia/Taipei') - interval '1 minute') at time zone 'Asia/Taipei'
where id = :'xm_id'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select is(
  (select (p ->> 'is_cross_month') || '/' || (p ->> 'months_ago') || '/' || (p ->> 'report_month')
   from get_completed_booking_reversal_preview(:'xm_id'::uuid) p),
  'true/1/' || to_char(date_trunc('month', now() at time zone 'Asia/Taipei') - interval '1 minute', 'YYYY-MM'),
  'G1:上個月最後一天 23:59(台北)完成 → is_cross_month=true、months_ago=1、report_month=上個月'
);
select pg_temp.test_clear_auth();
update bookings
set completed_at = date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei'
where id = :'xm_id'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select is(
  (select (p ->> 'is_cross_month') || '/' || (p ->> 'months_ago') || '/' || (p ->> 'report_month')
   from get_completed_booking_reversal_preview(:'xm_id'::uuid) p),
  'false/0/' || to_char(now() at time zone 'Asia/Taipei', 'YYYY-MM'),
  'G2:本月 1 日 00:00(台北)完成 → 不跨月、months_ago=0'
);
select pg_temp.test_clear_auth();
-- 三個月前完成 → 實際執行,稽核也記跨月
update bookings
set completed_at = (date_trunc('month', now() at time zone 'Asia/Taipei') - interval '3 months' + interval '10 days') at time zone 'Asia/Taipei'
where id = :'xm_id'::uuid;
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select is(
  (select (p ->> 'months_ago') from get_completed_booking_reversal_preview(:'xm_id'::uuid) p), '3',
  'G3:三個月前完成 → months_ago=3'
);
select cancel_completed_booking(:'xm_id'::uuid, '期後作廢');
select pg_temp.test_clear_auth();
select is(
  (select is_cross_month::text || '/' || report_month || '/' || to_char(original_completed_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI')
   from booking_completion_reversals where booking_id = :'xm_id'::uuid),
  'true/' || to_char(date_trunc('month', now() at time zone 'Asia/Taipei') - interval '3 months', 'YYYY-MM') || '/'
    || to_char(date_trunc('month', now() at time zone 'Asia/Taipei') - interval '3 months' + interval '10 days', 'YYYY-MM-DD HH24:MI'),
  'G4:稽核記下跨月、report_month(台北)與原完成時間'
);

-- =========================================================================
-- H. 月薪制、警告、匯入單(§十 第 10、11 條;§七 邊界 6、7、9)
-- =========================================================================
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select is(
  (select (p -> 'commission' ->> 'exists') || '/' || (p -> 'commission' ->> 'amount') || '/' || (p -> 'staff' ->> 'compensation_type_now')
   from get_completed_booking_reversal_preview(:'mo_id'::uuid) p),
  'false/0/monthly_salary',
  'H1:月薪制服務人員的單,預覽 commission.exists=false'
);
select lives_ok(format($$select revert_completed_booking('%s', '月薪誤按')$$, :'mo_id'),
  'H2:月薪制沒有快照,還原不報錯');
select is(
  (select (p ->> 'can_revert') || '/' || (p ->> 'can_cancel') || '/'
          || (select string_agg(w ->> 'code', ',' order by w ->> 'code') from jsonb_array_elements(p -> 'warnings') w)
          || '/' || (p -> 'commission' ->> 'recalculated') || '/' || (p -> 'staff' ->> 'status')
   from get_completed_booking_reversal_preview(:'wn_id'::uuid) p),
  'true/true/commission_recalculated,staff_now_monthly,staff_removed/true/removed',
  'H3:預覽 warnings:服務人員已移除、已改月薪、抽成曾人工重算'
);
select lives_ok(format($$select revert_completed_booking('%s', '服務人員已移除也能還原')$$, :'wn_id'),
  'H4:服務人員已移除的單可以還原(邊界 6)');
select is(
  (select (p ->> 'can_revert') || '/' || (p ->> 'can_cancel') || '/' || (p -> 'blocked_reasons' -> 0 ->> 'code')
          || '/' || jsonb_array_length(p -> 'blocked_reasons')::text
   from get_completed_booking_reversal_preview(:'im_id'::uuid) p),
  'false/true/import_cannot_revert/1',
  'H5:匯入單預覽 can_revert=false、can_cancel=true、blocked_reasons 只有 import_cannot_revert'
);
select throws_ok(format($$select revert_completed_booking('%s', '想還原匯入單')$$, :'im_id'),
  'P0001', '匯入的歷史訂單不能還原,只能取消。如果匯錯了,請取消後重新匯入', 'H6:匯入單還原 → 擋下');
select lives_ok(format($$select cancel_completed_booking('%s', '匯錯了')$$, :'im_id'),
  'H7:匯入單取消 → 成功');
select pg_temp.test_clear_auth();
select is(
  (select coalesce(commission_record_snapshot::text, 'null') || '/' || commission_amount_reversed::text
   from booking_completion_reversals where booking_id = :'mo_id'::uuid),
  'null/0.00',
  'H8:月薪制稽核 commission_record_snapshot=null、commission_amount_reversed=0'
);
select is(
  (select status from bookings where id = :'im_id'::uuid), 'cancelled',
  'H9:匯入單取消後是已取消'
);

-- =========================================================================
-- I. 點數(§十 第 12~19 條)
-- =========================================================================
-- I-1 餘額足夠:還原(第 E 段那張已做;這裡驗分類帳與稽核欄位)、取消(第 F 段那張)
select is(
  (select points_due || '/' || points_recovered || '/' || points_shortfall from booking_completion_reversals where booking_id = :'rv_id'::uuid),
  '10/10/0',
  'I1:還原、餘額足夠 → 應收 10、實收 10、差額 0'
);
select is(
  (select points_due || '/' || points_recovered || '/' || points_shortfall || '/' || referral_due || '/'
          || referral_recovered || '/' || referral_shortfall || '/' || coalesce(referrer_member_id::text, 'null') || '/'
          || coalesce(shortfall_hint, 'null')
   from booking_completion_reversals where booking_id = :'cc_id'::uuid),
  (select (p ->> 'points_due') || '/' || (p ->> 'points_recovered') || '/' || (p ->> 'points_shortfall') || '/'
          || (p ->> 'referral_due') || '/' || (p ->> 'referral_recovered') || '/' || (p ->> 'referral_shortfall') || '/'
          || coalesce(p ->> 'referrer_member_id', 'null') || '/' || coalesce(p ->> 'shortfall_hint', 'null')
   from (select :'cc_result'::jsonb -> 'points' as p) x),
  'I2:取消、餘額足夠 → 稽核 8 個欄位 = RPC 回傳的 points'
);
select is(
  (:'cc_result'::jsonb -> 'points' ->> 'points_recovered') || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000202'),
  '10/0',
  'I3:取消路徑實收 10、會員餘額回到 0'
);

-- I-2 餘額不足(差額):先看預覽,再執行還原
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select get_completed_booking_reversal_preview(:'sf_id'::uuid) as preview \gset sf_
select revert_completed_booking(:'sf_id'::uuid, '差額還原') as result \gset sf_
select pg_temp.test_clear_auth();
select is(
  (:'sf_result'::jsonb -> 'points' ->> 'points_due') || '/' || (:'sf_result'::jsonb -> 'points' ->> 'points_recovered')
    || '/' || (:'sf_result'::jsonb -> 'points' ->> 'points_shortfall') || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000203'),
  '10/5/5/0',
  'I4:餘額只剩 5 → 扣到 0、實收 5、差額 5'
);
select is(
  (select shortfall_hint from booking_completion_reversals where booking_id = :'sf_id'::uuid),
  :'sf_result'::jsonb -> 'points' ->> 'shortfall_hint',
  'I5:shortfall_hint 原封存進稽核表'
);
select ok(
  (select shortfall_hint like '%折抵在後%' from booking_completion_reversals where booking_id = :'sf_id'::uuid),
  'I6:提示列出「本單完成之後」才折抵的那張單'
);
select ok(
  (select shortfall_hint not like '%折抵在前%' from booking_completion_reversals where booking_id = :'sf_id'::uuid),
  'I7 🔴:提示不含「本單完成之前」的折抵單(守 §4.1 第 8 步:收回時 completed_at 還在;故障注入會轉紅)'
);
select is(
  (select (m ->> 'due_expected') || '/' || (m ->> 'shortfall_if_revert') || '/' || (m ->> 'balance')
   from jsonb_array_elements(:'sf_preview'::jsonb -> 'points' -> 'members') m),
  '10/5/5',
  'I8:預覽 = 執行結果(還原):預計應收 10、預計差額 5'
);

-- I-3 餘額剛好 0
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select lives_ok(format($$select cancel_completed_booking('%s', '餘額 0 也要能取消')$$, :'z_id'),
  'I9:會員餘額剛好 0 時取消 → 成功(邊界 18,不撞 points_delta <> 0)');
select pg_temp.test_clear_auth();
select is(
  (select points_due || '/' || points_recovered || '/' || points_shortfall from booking_completion_reversals where booking_id = :'z_id'::uuid)
    || '/' || pg_temp.m17_cnt(:'z_id'::uuid, 'earn_booking_reversal'),
  '10/0/10/0',
  'I10:實收 0、差額 10、沒有新增 earn_booking_reversal 列'
);

-- I-4 取消 + 折抵:先退回凍結再收回
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select get_completed_booking_reversal_preview(:'rc_id'::uuid) as preview \gset rc_
select cancel_completed_booking(:'rc_id'::uuid, '取消並退折抵') as result \gset rc_
select pg_temp.test_clear_auth();
select is(
  (select note from member_point_transactions where booking_id = :'rc_id'::uuid and transaction_type = 'redeem_booking_refund'),
  '訂單取消,退回紅利折抵 100 點',
  'I11 🔴:退回那筆備註是「訂單取消,退回紅利折抵」(守 §4.1 第 7 步:先改狀態再退回;故障注入會轉紅)'
);
select is(
  (select r.balance_after || '/' || v.balance_after || '/' || v.points_delta
   from member_point_transactions r, member_point_transactions v
   where r.booking_id = :'rc_id'::uuid and r.transaction_type = 'redeem_booking_refund'
     and v.booking_id = :'rc_id'::uuid and v.transaction_type = 'earn_booking_reversal'),
  '100/90/-10',
  'I12:先退回(餘額 0 → 100)再收回(100 → 90),balance_after 串接證明順序(同交易 created_at 相同,改用餘額鏈)'
);
select is(
  (select frozen_points_refunded || '/' || points_recovered || '/' || points_shortfall from booking_completion_reversals where booking_id = :'rc_id'::uuid)
    || '/' || (select points_redeemed || '/' || points_redeem_amount_snapshot::int from bookings where id = :'rc_id'::uuid),
  '100/10/0/0/0',
  'I13:稽核 frozen_points_refunded=100、因為先退回所以收得齊(差額 0);訂單折抵歸 0'
);
select is(
  (select (m ->> 'frozen_refund_expected') || '/' || (m ->> 'shortfall_if_cancel') || '/' || (m ->> 'shortfall_if_revert')
          || '/' || (:'rc_preview'::jsonb -> 'points' ->> 'frozen_points') || '/' || (:'rc_preview'::jsonb -> 'points' ->> 'points_due_expected')
   from jsonb_array_elements(:'rc_preview'::jsonb -> 'points' -> 'members') m),
  '100/0/10/100/10',
  'I14:預覽 = 執行結果(取消含折抵):預計退回 100、取消路徑差額 0(還原路徑會是 10)'
);
select is(
  (:'rc_result'::jsonb -> 'points' ->> 'frozen_points_refunded') || '/' || (:'rc_result'::jsonb -> 'points' ->> 'points_shortfall'),
  '100/0',
  'I15:RPC 回傳 frozen_points_refunded=100、差額 0'
);

-- I-5 還原不退凍結
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select revert_completed_booking(:'rr_id'::uuid, '還原保留折抵');
select pg_temp.test_clear_auth();
select is(
  (select points_redeemed::text from bookings where id = :'rr_id'::uuid) || '/' || pg_temp.m17_cnt(:'rr_id'::uuid, 'redeem_booking_refund')
    || '/' || (select frozen_points_refunded from booking_completion_reversals where booking_id = :'rr_id'::uuid)
    || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000206'),
  '100/0/0/0',
  'I16:還原路徑不退凍結:points_redeemed 維持 100、沒有 redeem_booking_refund、稽核退回 0、只收回入帳的 10 點'
);

-- I-6 會員已下架 / 紅利功能關閉 → 照樣收回(本檔沒有多加檢查)
update members set status = 'removed' where id = 'e8440000-0000-4000-8000-000000000207';
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select cancel_completed_booking(:'rm_id'::uuid, '下架會員也要收') as result \gset rm_
select pg_temp.test_clear_auth();
select is(
  (:'rm_result'::jsonb -> 'points' ->> 'points_recovered') || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000207'),
  '10/0',
  'I17:會員已下架 → 照樣收回 10 點'
);
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
update merchant_member_settings set points_feature_enabled = false where merchant_id = 'e8440000-0000-4000-8000-000000000023';
select set_config('request.jwt.claims', '', true);
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select revert_completed_booking(:'off_id'::uuid, '功能關閉也要收') as result \gset off_
select pg_temp.test_clear_auth();
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
update merchant_member_settings set points_feature_enabled = true where merchant_id = 'e8440000-0000-4000-8000-000000000023';
select set_config('request.jwt.claims', '', true);
select is(
  (:'off_result'::jsonb -> 'points' ->> 'points_recovered') || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000208'),
  '10/0',
  'I18:紅利功能關閉 → 照樣收回 10 點'
);

-- I-7 推薦獎勵一併收回
select is(
  pg_temp.m17_bal('e8440000-0000-4000-8000-000000000210') || '/'
    || ((select referral_rewarded_at from members where id = 'e8440000-0000-4000-8000-000000000211') is not null)::text,
  '20/true',
  'I19(前提):被推薦甲第一單完成 → 推薦人甲拿到首次 20 點、被推薦甲已標記'
);
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select cancel_completed_booking(:'ref1_id'::uuid, '推薦單取消') as result \gset ref1_
select pg_temp.test_clear_auth();
select is(
  (:'ref1_result'::jsonb -> 'points' ->> 'referral_due') || '/' || (:'ref1_result'::jsonb -> 'points' ->> 'referral_recovered')
    || '/' || (:'ref1_result'::jsonb -> 'points' ->> 'referrer_member_id') || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000210')
    || '/' || coalesce((select referral_rewarded_at::text from members where id = 'e8440000-0000-4000-8000-000000000211'), 'null'),
  '20/20/e8440000-0000-4000-8000-000000000210/0/null',
  'I20:推薦人甲被全額收回 20 點、被推薦甲的「已領過首次」標記清掉'
);
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select get_completed_booking_reversal_preview(:'ref2_id'::uuid) as preview \gset ref2_
select cancel_completed_booking(:'ref2_id'::uuid, '推薦人沒餘額') as result \gset ref2_
select pg_temp.test_clear_auth();
select is(
  (:'ref2_result'::jsonb -> 'points' ->> 'referral_recovered') || '/' || (:'ref2_result'::jsonb -> 'points' ->> 'referral_shortfall')
    || '/' || ((select referral_rewarded_at from members where id = 'e8440000-0000-4000-8000-000000000213') is not null)::text
    || '/' || ((select shortfall_hint from booking_completion_reversals where booking_id = :'ref2_id'::uuid) like '%推薦人%')::text,
  '0/20/true/true',
  'I21:推薦人乙餘額 0 → 實收 0、差額 20、標記不清、提示含推薦人那一句'
);
select is(
  (:'ref2_preview'::jsonb -> 'points' -> 'referral' ->> 'due_expected') || '/'
    || (:'ref2_preview'::jsonb -> 'points' -> 'referral' ->> 'shortfall_expected') || '/'
    || (:'ref2_preview'::jsonb -> 'points' -> 'referral' ->> 'referrer_name') || '/'
    || (:'ref2_preview'::jsonb -> 'points' -> 'referral' ->> 'referrer_balance'),
  '20/20/推薦人乙/0',
  'I22:預覽 = 執行結果(推薦人差額):預計推薦收回 20、預計差額 20'
);

-- I-8 預覽:本單從來沒有點數交易 → points = null;會員仍列出
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select is(
  (select coalesce(p -> 'points', 'null'::jsonb)::text || '/' || (p -> 'member' ->> 'name' is not null)::text
          || '/' || (p ->> 'revenue_amount')
   from get_completed_booking_reversal_preview(:'np_id'::uuid) p),
  'null/true/1000.00',
  'I23:派 0 點的單(沒有任何點數交易)預覽 points=null;member 仍列出;revenue_amount = 訂單金額'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- J. 中途失敗整筆回滾(§十 第 20 條;邊界 17)
-- =========================================================================
select id as rec_id from booking_commission_records where booking_id = :'rb_id'::uuid \gset rb_
select pg_temp.m17_bal('e8440000-0000-4000-8000-000000000214') as bal,
       (select count(*)::int from member_point_transactions where booking_id = :'rb_id'::uuid) as tx
\gset rb_before_

create function pg_temp.m17_boom() returns trigger language plpgsql as $$
begin
  raise exception '測試用:稽核寫入失敗';
end;
$$;
create trigger m17_boom before insert on booking_completion_reversals
  for each row execute function pg_temp.m17_boom();

select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select throws_ok(format($$select cancel_completed_booking('%s', '會失敗')$$, :'rb_id'),
  'P0001', '測試用:稽核寫入失敗', 'J1:最後一步(寫稽核)失敗 → 整個取消報錯');
select pg_temp.test_clear_auth();
drop trigger m17_boom on booking_completion_reversals;

select is(
  (select status || '/' || (completed_at is not null)::text || '/' || points_redeemed from bookings where id = :'rb_id'::uuid)
    || '/' || (select count(*)::int from booking_commission_records where id = :'rb_rec_id'::uuid)
    || '/' || (select count(*)::int from member_point_transactions where booking_id = :'rb_id'::uuid)
    || '/' || pg_temp.m17_bal('e8440000-0000-4000-8000-000000000214')
    || '/' || (select count(*)::int from booking_status_change_logs where booking_id = :'rb_id'::uuid and from_status = 'completed'),
  'completed/true/100/1/' || :'rb_before_tx' || '/' || :'rb_before_bal' || '/0',
  'J2:整筆回滾:狀態仍已完成、completed_at 還在、折抵沒退、抽成沒刪、分類帳沒有新列、餘額不變、沒有操作紀錄'
);

-- =========================================================================
-- K. 既有舊函式不變(§十 第 21 條;完整回歸見 module5_03)
-- =========================================================================
select pg_temp.test_set_auth('e8440000-0000-4000-8000-000000000005');
select throws_ok(format($$select cancel_booking('%s', '舊入口取消已完成')$$, :'rb_id'),
  null, null, 'K1:既有 cancel_booking 仍然不能取消已完成訂單');
select throws_ok(format($$select complete_booking('%s')$$, :'rb_id'),
  null, null, 'K2:既有 complete_booking 仍然不能重複完成');
select pg_temp.test_clear_auth();
select * from finish();

rollback;
