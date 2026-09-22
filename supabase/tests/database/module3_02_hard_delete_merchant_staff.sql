-- 對應規格書 .project/specs/服務人員管理優化與硬刪除.md 第三節(需求 1):
-- 服務人員「真正刪除」(硬刪除)§3.3/§3.5,核心必測(pgTAP,不可省略)。
--
-- 動手前已用 pg_get_constraintdef 重新查證正式環境(wjtbmmnakcriuaqoknsq)目前
-- bookings/booking_assistants/staff_leave_records/booking_commission_records 四張表指向
-- merchant_staff.id 的外鍵定義,結果跟規格書 §3.2 完全一致——其中 staff_leave_records
-- 是 on delete cascade、booking_commission_records 是 on delete set null,這兩張資料庫本身
-- 不會擋下刪除,是 hard_delete_merchant_staff() 應用層邏輯的唯一防線,所以下面④⑤兩項
-- 是「最需要驗證的一項」(規格書用語),不能省略。
begin;

select plan(29);

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
-- Fixture:商家 A(admin/agent)+商家 B(admin2,只用來測跨商家隔離跟 403)。
-- 商家 A 底下 7 位服務人員,分別對應規格書 §3.5 的 1-8 項測試情境。
-- =========================================================================
insert into auth.users (id, email) values
  ('aa150000-0000-4000-8000-000000000001', 'pgtap-m3hd-admin-a@test.local'),
  ('aa150000-0000-4000-8000-000000000002', 'pgtap-m3hd-admin-b@test.local'),
  ('aa150000-0000-4000-8000-000000000003', 'pgtap-m3hd-agent@test.local'),
  ('aa150000-0000-4000-8000-000000000004', 'pgtap-m3hd-staff-s6@test.local');

insert into groups (id) values
  ('aa150000-0000-4000-8000-000000000010'),
  ('aa150000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('aa150000-0000-4000-8000-000000000020', 'aa150000-0000-4000-8000-000000000010', '硬刪除測試商家A', 'on_site_dispatch'),
  ('aa150000-0000-4000-8000-000000000021', 'aa150000-0000-4000-8000-000000000011', '硬刪除測試商家B', 'on_site_dispatch');

insert into merchant_admins (merchant_id, user_id) values
  ('aa150000-0000-4000-8000-000000000020', 'aa150000-0000-4000-8000-000000000001'),
  ('aa150000-0000-4000-8000-000000000021', 'aa150000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('aa150000-0000-4000-8000-000000000005', 'aa150000-0000-4000-8000-000000000020', 'aa150000-0000-4000-8000-000000000003', '硬刪除測試客服', 'pgtap-m3hd-agent@test.local', 'active', now(), '0900000101');

-- S1(status=active,①)、S2(removed+有訂單,②)、S3(removed+有助手身份訂單,③)、
-- S4(removed+有請假紀錄,④核心)、S5(removed+有抽成紀錄,⑤核心)、
-- S6(removed+完全乾淨+掛滿六張純設定表,⑥,user_id 指向真實 auth.users 驗證不受影響)、
-- S7(removed+完全乾淨,⑦專門測權限擋下,不會真的被刪除)。
insert into merchant_staff (id, merchant_id, name, status, user_id, phone) values
  ('aa150000-0000-4000-8000-000000000030', 'aa150000-0000-4000-8000-000000000020', 'S1-在職', 'active', null, '0900000101'),
  ('aa150000-0000-4000-8000-000000000031', 'aa150000-0000-4000-8000-000000000020', 'S2-有訂單', 'removed', null, '0900000102'),
  ('aa150000-0000-4000-8000-000000000032', 'aa150000-0000-4000-8000-000000000020', 'S3-有助手訂單', 'removed', null, '0900000103'),
  ('aa150000-0000-4000-8000-000000000033', 'aa150000-0000-4000-8000-000000000020', 'S4-有請假紀錄', 'removed', null, '0900000104'),
  ('aa150000-0000-4000-8000-000000000034', 'aa150000-0000-4000-8000-000000000020', 'S5-有抽成紀錄', 'removed', null, '0900000105'),
  ('aa150000-0000-4000-8000-000000000035', 'aa150000-0000-4000-8000-000000000020', 'S6-乾淨可刪除', 'removed', 'aa150000-0000-4000-8000-000000000004', '0900000106'),
  ('aa150000-0000-4000-8000-000000000036', 'aa150000-0000-4000-8000-000000000020', 'S7-乾淨但只測權限', 'removed', null, '0900000107');

insert into merchant_staff (id, merchant_id, name, status, phone) values
  ('aa150000-0000-4000-8000-000000000040', 'aa150000-0000-4000-8000-000000000021', 'SB1-商家B對照組', 'active', '0900000101');

-- 給 S2 一筆歷史訂單(bookings.staff_id 指向 S2)。
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('aa150000-0000-4000-8000-000000000050', 'aa150000-0000-4000-8000-000000000020', '硬刪除測試服務', 500, 'primary', 60);

insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status) values
  ('aa150000-0000-4000-8000-000000000060', 'aa150000-0000-4000-8000-000000000020', 'aa150000-0000-4000-8000-000000000031', now(), now() + interval '30 minutes', '測試客戶2', '0900000002', 'admin', 'accepted');

-- 給 S3 一筆「以助手身份參與過的訂單」(主要服務人員是 S1,S3 是 booking_assistants)。
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status) values
  ('aa150000-0000-4000-8000-000000000061', 'aa150000-0000-4000-8000-000000000020', 'aa150000-0000-4000-8000-000000000030', now(), now() + interval '30 minutes', '測試客戶3', '0900000003', 'admin', 'accepted');
insert into booking_assistants (booking_id, staff_id) values
  ('aa150000-0000-4000-8000-000000000061', 'aa150000-0000-4000-8000-000000000032');

-- 給 S4 一筆請假紀錄(staff_leave_records.staff_id,FK 是 cascade,資料庫本身不會擋)。
insert into merchant_leave_types (id, merchant_id, name) values
  ('aa150000-0000-4000-8000-000000000051', 'aa150000-0000-4000-8000-000000000020', '硬刪除測試假別');
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date) values
  ('aa150000-0000-4000-8000-000000000033', 'aa150000-0000-4000-8000-000000000051', '硬刪除測試假別', current_date, current_date);

-- 給 S5 一筆抽成快照紀錄(booking_commission_records.staff_id,FK 是 set null,資料庫本身不會擋)。
-- 刻意讓這筆訂單本身的 staff_id 是 S1(不是 S5),只有 booking_commission_records.staff_id
-- 指向 S5——這樣才能確保這項測試真的獨立驗證「commission 紀錄本身」這條檢查,不會被
-- bookings.staff_id 那條檢查(②)意外連帶擋下,失去區分度(兩張表各自要有獨立防線)。
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status) values
  ('aa150000-0000-4000-8000-000000000062', 'aa150000-0000-4000-8000-000000000020', 'aa150000-0000-4000-8000-000000000030', now(), now() + interval '30 minutes', '測試客戶5', '0900000005', 'admin', 'completed');
insert into booking_commission_records (
  booking_id, staff_id, merchant_id, commission_basis_type_snapshot,
  commission_base_amount_snapshot, material_cost_deducted_snapshot,
  commission_rate_percentage_snapshot, commission_amount
) values (
  'aa150000-0000-4000-8000-000000000062', 'aa150000-0000-4000-8000-000000000034', 'aa150000-0000-4000-8000-000000000020',
  'gross', 1000, 0, 10, 100
);

-- 給 S6 掛滿六張「純設定」表(驗證硬刪除後透過 on delete cascade 一併清掉)。
insert into merchant_staff_service_items (staff_id, service_item_id) values
  ('aa150000-0000-4000-8000-000000000035', 'aa150000-0000-4000-8000-000000000050');
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('aa150000-0000-4000-8000-000000000035', 1, '09:00', '18:00');
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('aa150000-0000-4000-8000-000000000035', current_date, '09:00', true);
insert into merchant_staff_permissions (staff_id, section_key) values
  ('aa150000-0000-4000-8000-000000000035', 'staff_calendar_view');
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('aa150000-0000-4000-8000-000000000035', 'aa150000-0000-4000-8000-000000000050', 'percentage', 15);
-- 模組 8 §11.4(2026-09-22 新增第五項檢查後的回歸修正):這裡故意用 0 元(不是原本的 30000),
-- 因為 merchant_staff/staff_salary_settings 現在各掛了一個歷史紀錄觸發器(§11.2),任何非 0
-- 的月薪都會被記進 staff_payroll_status_history,而 §11.4 新增的第五項檢查會擋下「曾經領過
-- 非 0 月薪」的人真正被硬刪除——這裡的測試目的只是驗證 staff_salary_settings 這張表本身會被
-- cascade 清掉(規則⑥),不是要測 §11.4 那條新檢查(那條在 module8_02_payroll_status_history.sql
-- 有專門的核心測試),用 0 元維持 S6 依然能被成功硬刪除的既有行為。
insert into staff_salary_settings (staff_id, monthly_base_salary) values
  ('aa150000-0000-4000-8000-000000000035', 0);

-- =========================================================================
-- 以商家 A 管理員身份執行以下所有測試(除了⑦權限測試會切換身份)。
-- =========================================================================
select pg_temp.test_set_auth('aa150000-0000-4000-8000-000000000001');

-- ① status='active' 的服務人員直接被擋下,不能跳過軟刪除。
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000030')$$,
  'P0001', NULL,
  '①:對 status=active 的服務人員呼叫 hard_delete_merchant_staff 被擋下(errcode P0001)'
);
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000030'),
  1,
  '①:S1 完全不受影響,人員資料還在'
);

-- ② 有歷史訂單(bookings.staff_id)的服務人員被擋下。
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000031')$$,
  'P0001', NULL,
  '②:對 status=removed 但有歷史訂單的服務人員呼叫,被擋下'
);
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000031'),
  1,
  '②:S2 完全不受影響,人員資料還在'
);
select is(
  (select count(*)::int from bookings where staff_id = 'aa150000-0000-4000-8000-000000000031'),
  1,
  '②:S2 的訂單紀錄完全不受影響'
);

-- ③ 有助手身份訂單(booking_assistants.staff_id)的服務人員被擋下。
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000032')$$,
  'P0001', NULL,
  '③:對 status=removed 但有助手身份訂單的服務人員呼叫,被擋下'
);
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000032'),
  1,
  '③:S3 完全不受影響,人員資料還在'
);
select is(
  (select count(*)::int from booking_assistants where staff_id = 'aa150000-0000-4000-8000-000000000032'),
  1,
  '③:S3 的助手身份訂單紀錄完全不受影響'
);

-- ④(最需要驗證的一項)有請假紀錄的服務人員被擋下——staff_leave_records FK 是 cascade,
-- 資料庫本身不會保護,一定要確認是應用層邏輯真的擋住了。
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000033')$$,
  'P0001', NULL,
  '④(核心必測):對 status=removed 但有請假紀錄的服務人員呼叫,被擋下(FK 是 cascade,資料庫本身不會擋)'
);
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000033'),
  1,
  '④(核心必測):S4 完全不受影響,人員資料還在(沒有被 cascade 悄悄砍掉)'
);
select is(
  (select count(*)::int from staff_leave_records where staff_id = 'aa150000-0000-4000-8000-000000000033'),
  1,
  '④(核心必測):S4 的請假紀錄完全不受影響'
);

-- ⑤(最需要驗證的一項)有抽成紀錄的服務人員被擋下——booking_commission_records FK 是
-- set null,資料庫本身不會保護,一定要確認是應用層邏輯真的擋住了。
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000034')$$,
  'P0001', NULL,
  '⑤(核心必測):對 status=removed 但有抽成紀錄的服務人員呼叫,被擋下(FK 是 set null,資料庫本身不會擋)'
);
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000034'),
  1,
  '⑤(核心必測):S5 完全不受影響,人員資料還在'
);
select is(
  (select staff_id from booking_commission_records where booking_id = 'aa150000-0000-4000-8000-000000000062'),
  'aa150000-0000-4000-8000-000000000034'::uuid,
  '⑤(核心必測):S5 的抽成紀錄 staff_id 完全沒被清成 null'
);

-- ⑥ 完全沒有任何歷史紀錄的服務人員(S6),應該成功真正刪除,六張純設定表 cascade 清掉,
-- auth.users 完全不受影響。
select lives_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000035')$$,
  '⑥:對 status=removed 且完全沒有歷史紀錄的服務人員呼叫,成功執行'
);
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:S6 那筆 merchant_staff 紀錄真的消失了'
);
select is(
  (select count(*)::int from merchant_staff_service_items where staff_id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:merchant_staff_service_items 透過 cascade 一併清掉'
);
select is(
  (select count(*)::int from staff_availability_windows where staff_id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:staff_availability_windows 透過 cascade 一併清掉'
);
select is(
  (select count(*)::int from staff_availability_overrides where staff_id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:staff_availability_overrides 透過 cascade 一併清掉'
);
select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:merchant_staff_permissions 透過 cascade 一併清掉'
);
select is(
  (select count(*)::int from staff_service_commission_rates where staff_id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:staff_service_commission_rates 透過 cascade 一併清掉'
);
select is(
  (select count(*)::int from staff_salary_settings where staff_id = 'aa150000-0000-4000-8000-000000000035'),
  0,
  '⑥:staff_salary_settings 透過 cascade 一併清掉'
);

select pg_temp.test_clear_auth();

-- auth.users 沒有開放給 authenticated 角色直接 SELECT(系統 schema,本來就不透過 RLS 曝光),
-- 這裡切回 postgres 超級使用者身份查詢,純粹確認「硬刪除 merchant_staff 完全不動 auth.users」
-- 這個結論本身,不是在測 RLS 邊界。
select is(
  (select count(*)::int from auth.users where id = 'aa150000-0000-4000-8000-000000000004'),
  1,
  '⑥:S6 原本綁定的 auth.users 帳號完全不受影響,依然存在(規格書規則:完全不動 auth.users)'
);

-- =========================================================================
-- ⑦ 非商家管理員呼叫,一律被 403(errcode 42501)擋下,S7 完全不受影響。
-- =========================================================================
select pg_temp.test_set_auth('aa150000-0000-4000-8000-000000000003'); -- 客服(非管理員)
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000036')$$,
  '42501', NULL,
  '⑦:客服(非商家管理員)呼叫被 403 擋下'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000036'),
  1,
  '⑦:客服呼叫被擋下後,S7 完全不受影響'
);

select pg_temp.test_set_auth('aa150000-0000-4000-8000-000000000002'); -- 商家B的管理員
select throws_ok(
  $$select hard_delete_merchant_staff('aa150000-0000-4000-8000-000000000036')$$,
  '42501', NULL,
  '⑦:其他商家的管理員呼叫被 403 擋下'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_staff where id = 'aa150000-0000-4000-8000-000000000036'),
  1,
  '⑦:其他商家管理員呼叫被擋下後,S7 依然完全不受影響'
);

-- =========================================================================
-- ⑧ 硬刪除 S6 之後,同一商家其他服務人員、其他商家的資料完全不受影響。
-- =========================================================================
select is(
  (select count(*)::int from merchant_staff where merchant_id = 'aa150000-0000-4000-8000-000000000020'),
  6,
  '⑧:商家A底下扣掉已刪除的 S6,其餘 6 位服務人員(S1-S5、S7)完全不受影響'
);
select is(
  (select count(*)::int from merchant_staff where merchant_id = 'aa150000-0000-4000-8000-000000000021'),
  1,
  '⑧:商家B的服務人員資料完全不受影響'
);

select * from finish();

rollback;
