-- 模組 7(排班與休假管理)— 對應規格書 .project/specs/排班與休假管理.md 全文,
-- 含主腦裁示(取代規格書規則 2.7/2.8 原文):unlimited_backend_edit 不覆寫請假限制。
begin;

select plan(47);

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

-- get_merchant_day_schedule 回傳的 staff 陣列順序是 order by ms.name(依姓名字串排序),不能假設
-- 特定服務人員一定落在固定的陣列 index——這裡改用這支小工具依 staff_id 取出對應的那個區塊。
create function pg_temp.day_schedule_staff_block(p_merchant_id uuid, p_date date, p_staff_id uuid)
returns jsonb language sql as $$
  select elem
  from jsonb_array_elements(public.get_merchant_day_schedule(p_merchant_id, p_date) -> 'staff') elem
  where elem ->> 'staff_id' = p_staff_id::text
  limit 1;
$$;

-- =========================================================================
-- Fixture:兩間商家(A/B,測跨商家隔離)。A 商家:管理員、四位服務人員
-- (X=月薪制/一般、Z=月薪制/unlimited_backend_edit、Y=按件計酬、W=月薪制/用來測 2.6 衝突警示)、
-- 三種客服(無授權/team_leave/scheduling/僅 orders)。
-- =========================================================================
insert into auth.users (id, email) values
  ('d7000000-0000-4000-8000-000000000001', 'pgtap-m7-admin-a@test.local'),
  ('d7000000-0000-4000-8000-000000000002', 'pgtap-m7-admin-b@test.local'),
  ('d7000000-0000-4000-8000-000000000003', 'pgtap-m7-agent-none@test.local'),
  ('d7000000-0000-4000-8000-000000000004', 'pgtap-m7-agent-teamleave@test.local'),
  ('d7000000-0000-4000-8000-000000000005', 'pgtap-m7-agent-scheduling@test.local'),
  ('d7000000-0000-4000-8000-000000000006', 'pgtap-m7-agent-orders@test.local');

insert into groups (id) values
  ('d7000000-0000-4000-8000-000000000011'),
  ('d7000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('d7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000011', '排班休假測試A店', 'in_store_beauty'),
  ('d7000000-0000-4000-8000-000000000022', 'd7000000-0000-4000-8000-000000000012', '排班休假測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('d7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000001'),
  ('d7000000-0000-4000-8000-000000000022', 'd7000000-0000-4000-8000-000000000002');

-- A 店全週營業(00:00-23:59),避免測試日期落在哪個星期幾都要另外處理。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'd7000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('d7000000-0000-4000-8000-000000000031', 'd7000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30);

-- X:月薪制、一般(unlimited_backend_edit=false)——規則 2.7 核心測試用。
-- Z:月薪制、unlimited_backend_edit=true——主腦裁示反轉測試用(即使開啟這個開關,請假仍擋下)。
-- Y:按件計酬——規則 2.2 測試用(不能登記請假)。
-- W:月薪制——規則 2.6 既有預約衝突警示測試用,跟 X/Z/Y 分開避免互相干擾。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit, compensation_type) values
  ('d7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000021', '月薪服務人員X', null, true, false, 'monthly_salary'),
  ('d7000000-0000-4000-8000-000000000042', 'd7000000-0000-4000-8000-000000000021', '按件服務人員Y', null, true, false, 'piece_rate'),
  ('d7000000-0000-4000-8000-000000000043', 'd7000000-0000-4000-8000-000000000021', '月薪服務人員Z(無限制編輯)', null, true, true, 'monthly_salary'),
  ('d7000000-0000-4000-8000-000000000044', 'd7000000-0000-4000-8000-000000000021', '月薪服務人員W(衝突測試)', null, true, false, 'monthly_salary');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('d7000000-0000-4000-8000-000000000051', 'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m7-agent-none@test.local', 'active', now()),
  ('d7000000-0000-4000-8000-000000000052', 'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000004', '客服-team_leave', 'pgtap-m7-agent-teamleave@test.local', 'active', now()),
  ('d7000000-0000-4000-8000-000000000053', 'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000005', '客服-scheduling', 'pgtap-m7-agent-scheduling@test.local', 'active', now()),
  ('d7000000-0000-4000-8000-000000000054', 'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000006', '客服-僅訂單', 'pgtap-m7-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('d7000000-0000-4000-8000-000000000052', 'team_leave', true),
  ('d7000000-0000-4000-8000-000000000053', 'scheduling', true),
  ('d7000000-0000-4000-8000-000000000054', 'orders', true);

-- =========================================================================
-- ① 1.1:merchant_staff.compensation_type CHECK 約束 + 預設值。
-- =========================================================================
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

select throws_ok(
  $$insert into merchant_staff (merchant_id, name, compensation_type)
    values ('d7000000-0000-4000-8000-000000000021', '非法計酬類型測試', 'hourly')$$,
  '23514', null,
  '1.1:compensation_type 只能是 monthly_salary/piece_rate,非法值被 CHECK 約束擋下'
);

insert into merchant_staff (id, merchant_id, name)
values ('d7000000-0000-4000-8000-000000000045', 'd7000000-0000-4000-8000-000000000021', '沒指定計酬類型的服務人員');

select is(
  (select compensation_type from merchant_staff where id = 'd7000000-0000-4000-8000-000000000045'),
  'piece_rate',
  '1.1:不指定 compensation_type 時預設回填為 piece_rate(第〇節判斷 1)'
);

-- =========================================================================
-- ② 1.2:merchant_leave_types CHECK 約束 + 跨商家隔離。
-- =========================================================================
select throws_ok(
  $$insert into merchant_leave_types (merchant_id, name, status)
    values ('d7000000-0000-4000-8000-000000000021', '非法狀態假別', 'archived')$$,
  '23514', null,
  '1.2:merchant_leave_types.status 只能是 active/removed,非法值被擋下'
);

insert into merchant_leave_types (id, merchant_id, name, description) values
  ('d7000000-0000-4000-8000-000000000061', 'd7000000-0000-4000-8000-000000000021', '特休', null),
  ('d7000000-0000-4000-8000-000000000062', 'd7000000-0000-4000-8000-000000000021', '事假', null);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from merchant_leave_types where merchant_id = 'd7000000-0000-4000-8000-000000000021'),
  0,
  '1.2:跨商家隔離——B 店管理員看不到 A 店的假別清單'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ 1.3:staff_leave_records CHECK 約束(end_date >= start_date、status 合法值)。
-- staff_leave_records 沒有 INSERT RLS 政策(規則 3.10:一律透過 create_staff_leave/cancel_staff_leave
-- 這兩支 SECURITY DEFINER 函式寫入),所以這裡改用 test_clear_auth()(還原成 postgres 超級使用者,
-- 略過 RLS)直接測 CHECK 約束本身,不受「這個角色能不能寫入這張表」這件事干擾。
-- =========================================================================
select pg_temp.test_clear_auth();

select throws_ok(
  format(
    $$insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status)
      values ('%1$s', '%2$s', '特休', '2026-09-27', '2026-09-25', 'confirmed')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000061'
  ),
  '23514', null,
  '1.3:end_date 早於 start_date 被 CHECK 約束擋下'
);

select throws_ok(
  format(
    $$insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status)
      values ('%1$s', '%2$s', '特休', '2026-09-25', '2026-09-27', 'pending')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000061'
  ),
  '23514', null,
  '1.3:staff_leave_records.status 只能是 confirmed/cancelled,非法值被擋下(這次不做簽核流程)'
);

select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 規則 2.2:只有月薪制服務人員可以登記請假紀錄。
-- =========================================================================
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

select throws_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-09-25', '2026-09-27')$$,
    'd7000000-0000-4000-8000-000000000042', 'd7000000-0000-4000-8000-000000000061'
  ),
  'P0001', '只有月薪制的服務人員可以登記請假紀錄,請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)',
  '規則 2.2:按件計酬服務人員(Y)呼叫 create_staff_leave 被擋下,錯誤訊息正確'
);

-- =========================================================================
-- ⑤ 規則 2.5:同一人請假區間不可重疊(核心請假紀錄建立測試,X 服務人員後面規則 2.7 會沿用)。
-- =========================================================================
select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-09-25', '2026-09-27', '排班休假測試備註')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000061'
  ),
  '規則 2.5:X 服務人員 9/25~9/27 登記特休成功(無衝突)'
);

select id from staff_leave_records
  where staff_id = 'd7000000-0000-4000-8000-000000000041' and status = 'confirmed'
  order by created_at desc limit 1 \gset leave_x_

select throws_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-09-26', '2026-09-28')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  'P0001', '這位服務人員在這段期間已經有其他請假紀錄,日期區間不能重疊',
  '規則 2.5:與既有 confirmed 請假區間重疊(9/26~9/28 跟 9/25~9/27 重疊)被擋下'
);

select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-09-28', '2026-09-29')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  '規則 2.5:不重疊的區間(9/28~9/29,緊接在 9/25~9/27 之後但不重疊)可以正常登記'
);

select id from staff_leave_records
  where staff_id = 'd7000000-0000-4000-8000-000000000041' and start_date = '2026-09-28' \gset leave_x2_

select cancel_staff_leave(:'leave_x2_id'::uuid);

select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-09-28', '2026-09-29')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  '規則 2.5:已取消(cancelled)的舊紀錄不算重疊,同樣的區間可以重新登記'
);

select id from staff_leave_records
  where staff_id = 'd7000000-0000-4000-8000-000000000041' and start_date = '2026-09-28' and status = 'confirmed'
  \gset leave_x2b_
select cancel_staff_leave(:'leave_x2b_id'::uuid);

select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-09-25', '2026-09-27')$$,
    'd7000000-0000-4000-8000-000000000043', 'd7000000-0000-4000-8000-000000000061'
  ),
  '規則 2.5:不同服務人員(Z)之間互不影響,可以登記跟 X 相同的日期區間'
);

select id from staff_leave_records
  where staff_id = 'd7000000-0000-4000-8000-000000000043' and status = 'confirmed'
  order by created_at desc limit 1 \gset leave_z_

-- =========================================================================
-- ⑥ 規則 2.6:建立請假紀錄時跟既有預約重疊,警示但不強制擋下(用 W 服務人員,避免干擾 X/Z)。
-- =========================================================================
select id from create_booking(
  'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000044',
  jsonb_build_array(jsonb_build_object('service_item_id', 'd7000000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', 300)),
  '2026-10-05 09:00:00+08', '衝突測試客戶', '0955000010'
) \gset conflict_booking_

select is(
  (select count(*)::int from preview_staff_leave_conflicts('d7000000-0000-4000-8000-000000000044', '2026-10-05', '2026-10-06')),
  1,
  '規則 2.6/3.4:preview_staff_leave_conflicts 正確回傳這段期間 1 筆既有預約'
);

select throws_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-10-05', '2026-10-06')$$,
    'd7000000-0000-4000-8000-000000000044', 'd7000000-0000-4000-8000-000000000061'
  ),
  'P0001', '這段期間已經有 1 筆預約,請先確認清單後再登記請假',
  '規則 2.6:有衝突且未帶確認旗標,create_staff_leave 被擋下,訊息附正確筆數'
);

select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-10-05', '2026-10-06', null, true)$$,
    'd7000000-0000-4000-8000-000000000044', 'd7000000-0000-4000-8000-000000000061'
  ),
  '規則 2.6:帶 p_confirm_despite_conflicts=true 後,即使有衝突仍能成功建立請假紀錄'
);

select is(
  (select count(*)::int from preview_staff_leave_conflicts('d7000000-0000-4000-8000-000000000041', '2026-11-01', '2026-11-02')),
  0,
  '規則 2.6:無衝突時 preview_staff_leave_conflicts 回傳空清單(0 筆)'
);

select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-11-01', '2026-11-02')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  '規則 2.6:無衝突時不需要確認旗標也能直接成功登記請假'
);

select id from staff_leave_records
  where staff_id = 'd7000000-0000-4000-8000-000000000041' and start_date = '2026-11-01'
  \gset leave_x3_
select cancel_staff_leave(:'leave_x3_id'::uuid);

-- 6-b:假別必須屬於同商家且 status='active',已下架的假別不能拿來新登記請假。
update merchant_leave_types set status = 'removed' where id = 'd7000000-0000-4000-8000-000000000062';

select throws_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-11-05', '2026-11-06')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  'P0001', '找不到這個假別,或已下架',
  '3.3 第 6 步:已下架的假別不能拿來新登記請假紀錄'
);

update merchant_leave_types set status = 'active' where id = 'd7000000-0000-4000-8000-000000000062';

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ 規則 2.7(核心,對應主腦裁示):請假期間建單一律被擋下,含 unlimited_backend_edit 反轉測試。
-- =========================================================================
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

-- 7-1:X 服務人員(leave_x_,9/25~9/27,假別「特休」)請假期間內建單被擋下,訊息含正確假別名稱。
select throws_ok(
  $$select create_booking(
    'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','d7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
    '2026-09-26 10:00:00+08', '請假期間建單測試客戶', '0955000011'
  )$$,
  'P0001', '主要服務人員這天是休假日(假別:特休),無法預約',
  '規則 2.7 核心:請假期間(9/26,落在 9/25~9/27 內)建單被擋下,錯誤訊息包含正確的假別名稱「特休」'
);

-- 7-2:取消請假紀錄後,同一天可以正常建單。
select cancel_staff_leave(:'leave_x_id'::uuid);

select id from create_booking(
  'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','d7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
  '2026-09-26 10:00:00+08', '取消請假後建單測試客戶', '0955000012'
) \gset booking_after_cancel_

select ok(
  :'booking_after_cancel_id' is not null,
  '規則 2.7:請假紀錄取消後,同一天可以正常建單'
);

-- 7-3:主腦裁示反轉測試——Z 服務人員 unlimited_backend_edit=true,但請假期間(leave_z_,9/25~9/27,
-- 假別「特休」)仍然被擋下,不因為這個開關而被覆寫過去(取代規格書規則 2.7/2.8 原文測試清單第 3 條)。
select throws_ok(
  $$select create_booking(
    'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000043',
    jsonb_build_array(jsonb_build_object('service_item_id','d7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
    '2026-09-26 11:00:00+08', '無限制編輯反轉測試客戶', '0955000013'
  )$$,
  'P0001', '主要服務人員這天是休假日(假別:特休),無法預約',
  '主腦裁示反轉測試(取代規格書規則 2.7 測試清單第 3 條):unlimited_backend_edit=true 的服務人員(Z),請假期間仍然被擋下建單,不受這個開關覆寫'
);

-- 7-4:假別事後改名,已擋下的錯誤訊息維持請假登記當下的舊名字(快照不變性驗證)。
update merchant_leave_types set name = '特休(改名後)' where id = 'd7000000-0000-4000-8000-000000000061';

select throws_ok(
  $$select create_booking(
    'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000043',
    jsonb_build_array(jsonb_build_object('service_item_id','d7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
    '2026-09-26 12:00:00+08', '假別改名快照測試客戶', '0955000014'
  )$$,
  'P0001', '主要服務人員這天是休假日(假別:特休),無法預約',
  '規則 2.7:假別事後改名(特休→特休(改名後))後,check_staff_booking_slot 的錯誤訊息仍維持請假登記當下的舊名字「特休」(快照不變性)'
);

select is(
  pg_temp.day_schedule_staff_block(
    'd7000000-0000-4000-8000-000000000021', '2026-09-26'::date, 'd7000000-0000-4000-8000-000000000043'
  ) -> 'on_leave' ->> 'leave_type_name',
  '特休',
  '3.7:get_merchant_day_schedule 的 on_leave.leave_type_name 也維持快照舊名字「特休」,不受假別改名影響'
);

update merchant_leave_types set name = '特休' where id = 'd7000000-0000-4000-8000-000000000061';

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ 規則 2.9:staff_leave_records 不能編輯,只能新增/取消(檢查 RLS 政策數量/內容)。
-- =========================================================================
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'staff_leave_records'),
  1,
  '規則 2.9:staff_leave_records 只有 1 條 RLS 政策(SELECT),沒有開放 INSERT/UPDATE/DELETE 政策'
);

select is(
  (select array_agg(cmd order by cmd)::text from pg_policies where schemaname = 'public' and tablename = 'staff_leave_records'),
  '{SELECT}',
  '規則 2.9:staff_leave_records 唯一的政策是 SELECT,沒有其他命令類型的政策'
);

-- 用有 team_leave 權限的管理員身分,嘗試繞過 RPC 直接 UPDATE 一筆既有紀錄——RLS 沒有 UPDATE 政策,
-- 應該 0 筆受影響(不是報錯)。
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

update staff_leave_records set notes = '試圖繞過 RPC 直接改備註' where staff_id = 'd7000000-0000-4000-8000-000000000043';

select is(
  (select count(*)::int from staff_leave_records where staff_id = 'd7000000-0000-4000-8000-000000000043' and notes = '試圖繞過 RPC 直接改備註'),
  0,
  '規則 2.9:staff_leave_records 沒有 UPDATE 政策,即使是商家管理員直接下 UPDATE 也是 0 筆受影響,只能透過 cancel_staff_leave 這支 RPC 改狀態'
);

-- =========================================================================
-- ⑨ 規則 2.10:取消請假/假別下架不算危險操作,兩張表都沒有 DELETE 政策。
-- =========================================================================
delete from merchant_leave_types where id = 'd7000000-0000-4000-8000-000000000061';

select is(
  (select count(*)::int from merchant_leave_types where id = 'd7000000-0000-4000-8000-000000000061'),
  1,
  '規則 2.10:merchant_leave_types 沒有 DELETE 政策,執行 DELETE 沒有真的刪掉'
);

delete from staff_leave_records where staff_id = 'd7000000-0000-4000-8000-000000000043';

select ok(
  (select count(*)::int from staff_leave_records where staff_id = 'd7000000-0000-4000-8000-000000000043') > 0,
  '規則 2.10:staff_leave_records 沒有 DELETE 政策,執行 DELETE 沒有真的刪掉'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑩ 規則 2.11:客服權限邊界(team_leave/scheduling 各自獨立)。
-- =========================================================================
-- 無授權客服:不能新增假別、不能呼叫 create_staff_leave/get_staff_schedule_overview。
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000003');

select throws_ok(
  $$insert into merchant_leave_types (merchant_id, name) values ('d7000000-0000-4000-8000-000000000021', '無授權客服嘗試新增假別')$$,
  '42501', null,
  '規則 2.11:無授權客服不能新增假別(merchant_leave_types RLS 擋下)'
);

select throws_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-12-01', '2026-12-02')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  '42501', null,
  '規則 2.11:無授權客服不能呼叫 create_staff_leave'
);

select throws_ok(
  $$select get_staff_schedule_overview('d7000000-0000-4000-8000-000000000021', '2026-09-25', '2026-09-27')$$,
  '42501', null,
  '規則 2.11:無授權客服不能呼叫 get_staff_schedule_overview'
);

select pg_temp.test_clear_auth();

-- 被授權 team_leave 的客服:可以新增假別、可以建立/取消請假,但不能檢視排班一覽(不同的鑰匙)。
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000004');

select lives_ok(
  $$insert into merchant_leave_types (merchant_id, name) values ('d7000000-0000-4000-8000-000000000021', '育嬰假')$$,
  '規則 2.11:被授權 team_leave 的客服可以新增假別'
);

select lives_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-12-01', '2026-12-02')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  '規則 2.11:被授權 team_leave 的客服可以呼叫 create_staff_leave'
);

select id from staff_leave_records
  where staff_id = 'd7000000-0000-4000-8000-000000000041' and start_date = '2026-12-01'
  \gset leave_teamleave_

select lives_ok(
  format($$select cancel_staff_leave('%1$s')$$, :'leave_teamleave_id'),
  '規則 2.11:被授權 team_leave 的客服可以呼叫 cancel_staff_leave'
);

select throws_ok(
  $$select get_staff_schedule_overview('d7000000-0000-4000-8000-000000000021', '2026-09-25', '2026-09-27')$$,
  '42501', null,
  '規則 2.11:被授權 team_leave 但沒有 scheduling 的客服,不能檢視排班一覽(兩把獨立的鑰匙)'
);

select pg_temp.test_clear_auth();

-- 被授權 scheduling 的客服:可以檢視排班一覽,但不能新增假別/建立請假。
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000005');

select lives_ok(
  $$select get_staff_schedule_overview('d7000000-0000-4000-8000-000000000021', '2026-09-25', '2026-09-27')$$,
  '規則 2.11:被授權 scheduling 的客服可以呼叫 get_staff_schedule_overview'
);

select throws_ok(
  $$insert into merchant_leave_types (merchant_id, name) values ('d7000000-0000-4000-8000-000000000021', '排班客服嘗試新增假別')$$,
  '42501', null,
  '規則 2.11:被授權 scheduling 但沒有 team_leave 的客服,不能新增假別'
);

select pg_temp.test_clear_auth();

-- 邊界情況:只有 orders 權限的客服,雖然不能操作請假紀錄本身,但一樣會在行事曆上看到請假、
-- 一樣會被擋下建單(建單這個動作歸 orders 管,不需要額外檢查 team_leave 權限)。
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000006');

select throws_ok(
  $$select create_booking(
    'd7000000-0000-4000-8000-000000000021', 'd7000000-0000-4000-8000-000000000043',
    jsonb_build_array(jsonb_build_object('service_item_id','d7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
    '2026-09-26 13:00:00+08', '僅訂單客服建單測試客戶', '0955000015'
  )$$,
  'P0001', '主要服務人員這天是休假日(假別:特休),無法預約',
  '規則 2.11 邊界情況:只有 orders 權限、沒有 team_leave 權限的客服,建單時一樣會被請假擋下(不需要額外檢查 team_leave)'
);

select throws_ok(
  format(
    $$select create_staff_leave('%1$s', '%2$s', '2026-12-05', '2026-12-06')$$,
    'd7000000-0000-4000-8000-000000000041', 'd7000000-0000-4000-8000-000000000062'
  ),
  '42501', null,
  '規則 2.11:只有 orders 權限的客服不能呼叫 create_staff_leave(管理請假紀錄仍需要 team_leave)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑪ 3.7/3.8:on_leave / 排班一覽彙整正確性,跨商家隔離。
-- =========================================================================
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

-- 9/26 這天 Z 服務人員仍在請假中(leave_z_,9/25~9/27),9/30 沒有請假。
select is(
  (pg_temp.day_schedule_staff_block(
    'd7000000-0000-4000-8000-000000000021', '2026-09-26'::date, 'd7000000-0000-4000-8000-000000000043'
  ) ->> 'on_leave') is not null,
  true,
  '3.7:get_merchant_day_schedule 在請假當天正確回傳 on_leave 物件(非 null)'
);

select is(
  (pg_temp.day_schedule_staff_block(
    'd7000000-0000-4000-8000-000000000021', '2026-09-30'::date, 'd7000000-0000-4000-8000-000000000043'
  ) ->> 'on_leave'),
  null,
  '3.7:get_merchant_day_schedule 在沒有請假的日期,on_leave 回傳 null'
);

select is(
  jsonb_array_length(
    (select value from jsonb_array_elements(get_staff_schedule_overview('d7000000-0000-4000-8000-000000000021', '2026-09-25', '2026-09-27') -> 'staff')
     where value ->> 'staff_id' = 'd7000000-0000-4000-8000-000000000043') -> 'days'
  ),
  3,
  '3.8:get_staff_schedule_overview 回傳的 days 陣列筆數等於查詢區間天數(9/25~9/27 共 3 天)'
);

select is(
  (
    select day_elem -> 'on_leave' ->> 'leave_type_name'
    from jsonb_array_elements(get_staff_schedule_overview('d7000000-0000-4000-8000-000000000021', '2026-09-25', '2026-09-27') -> 'staff') staff_elem,
         jsonb_array_elements(staff_elem.value -> 'days') day_elem
    where staff_elem.value ->> 'staff_id' = 'd7000000-0000-4000-8000-000000000043'
      and day_elem ->> 'date' = '2026-09-26'
  ),
  '特休',
  '3.8:get_staff_schedule_overview 正確彙整出 Z 服務人員 9/26 這天的請假假別名稱「特休」'
);

-- 跨商家隔離:B 店管理員看不到 A 店的排班一覽(RLS/權限檢查擋下)。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000002');

select throws_ok(
  $$select get_staff_schedule_overview('d7000000-0000-4000-8000-000000000021', '2026-09-25', '2026-09-27')$$,
  '42501', null,
  '3.8:跨商家隔離——B 店管理員不能查詢 A 店的排班一覽'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑫ 3.9:新商家建立時自動種入預設假別(事假/病假/特休),create_group_and_merchant/
-- create_merchant_in_group 皆會補呼叫。
-- =========================================================================
select pg_temp.test_set_auth('d7000000-0000-4000-8000-000000000001');

select public.create_group_and_merchant('排班休假種子測試店-群組', 'in_store_beauty') \gset seed_group_merchant_

select is(
  (select count(*)::int from merchant_leave_types where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid),
  3,
  '3.9:create_group_and_merchant 建立商家後,merchant_leave_types 剛好有 3 筆'
);

select is(
  (select count(*)::int from merchant_leave_types
     where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid
       and status = 'active' and name in ('事假', '病假', '特休')),
  3,
  '3.9:種子的三筆分別是「事假」「病假」「特休」,皆為 active'
);

select group_id from merchants where id = :'seed_group_merchant_create_group_and_merchant'::uuid \gset seed_group_

select public.create_merchant_in_group(:'seed_group_group_id'::uuid, '排班休假種子測試店-同集團第二間', 'in_store_beauty') \gset seed_second_merchant_

select is(
  (select count(*)::int from merchant_leave_types where merchant_id = :'seed_second_merchant_create_merchant_in_group'::uuid),
  3,
  '3.9:create_merchant_in_group 建立分店後,merchant_leave_types 也剛好有 3 筆'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
