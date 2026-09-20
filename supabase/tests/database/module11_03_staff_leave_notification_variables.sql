-- 模組 11(LINE 通知)— bug fix(SPECS-INDEX 編號 385)。
-- 對應 20260920160600 migration 新增的 render_staff_leave_notification_variables:staff_leave_created
-- 事件原本沒有對應的變數組裝函式可呼叫,導致實際發送的訊息 {{staff_name}}/{{booking_date}} 沒有
-- 被替換、原樣送給收訊人看到。這支測試涵蓋:變數組裝正確(單日/區間兩種日期格式)、
-- leave_type_name 讀 snapshot 不是即時 join、查無資料回傳空物件不報錯、權限只給 service_role。
begin;

select plan(9);

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
-- Fixture:一間商家、一位服務人員、一個假別、兩筆請假紀錄(單日一筆、跨日一筆)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ee000000-0000-4000-8000-000000000001', 'pgtap-m11c-admin@test.local');

insert into groups (id) values ('ee000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type)
values ('ee000000-0000-4000-8000-000000000021', 'ee000000-0000-4000-8000-000000000011', 'LINE通知請假變數測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name)
values ('ee000000-0000-4000-8000-000000000021', 'ee000000-0000-4000-8000-000000000001', '請假變數測試管理員');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('ee000000-0000-4000-8000-000000000041', 'ee000000-0000-4000-8000-000000000021', '請假變數測試服務人員', '0922000041', true);

insert into merchant_leave_types (id, merchant_id, name)
values ('ee000000-0000-4000-8000-000000000061', 'ee000000-0000-4000-8000-000000000021', '特休');

-- 單日請假(start_date = end_date)。
insert into staff_leave_records (id, staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status)
values (
  'ee000000-0000-4000-8000-000000000071',
  'ee000000-0000-4000-8000-000000000041',
  'ee000000-0000-4000-8000-000000000061',
  '特休',
  '2026-10-01', '2026-10-01',
  'confirmed'
);

-- 跨日請假(start_date <> end_date)。
insert into staff_leave_records (id, staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status)
values (
  'ee000000-0000-4000-8000-000000000072',
  'ee000000-0000-4000-8000-000000000041',
  'ee000000-0000-4000-8000-000000000061',
  '特休',
  '2026-10-03', '2026-10-05',
  'confirmed'
);

-- =========================================================================
-- ① 基本組裝正確(單日)。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001', 'service_role');
select render_staff_leave_notification_variables('ee000000-0000-4000-8000-000000000071'::uuid) as r \gset single_
select pg_temp.test_clear_auth();

select is(:'single_r'::jsonb->>'merchant_name', 'LINE通知請假變數測試店', '單日請假:merchant_name 正確組裝');
select is(:'single_r'::jsonb->>'staff_name', '請假變數測試服務人員', '單日請假:staff_name 正確組裝');
select is(:'single_r'::jsonb->>'booking_date', '2026-10-01', '單日請假(start_date=end_date):booking_date 只顯示單一日期,不帶「至」');
select is(:'single_r'::jsonb->>'leave_type_name', '特休', '單日請假:leave_type_name 正確帶出(讀 leave_type_name_snapshot)');

-- =========================================================================
-- ② 跨日請假:booking_date 顯示成區間格式。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001', 'service_role');
select render_staff_leave_notification_variables('ee000000-0000-4000-8000-000000000072'::uuid) as r \gset range_
select pg_temp.test_clear_auth();

select is(:'range_r'::jsonb->>'booking_date', '2026-10-03 至 2026-10-05', '跨日請假(start_date<>end_date):booking_date 顯示為「起 至 迄」區間格式');

-- =========================================================================
-- ③ leave_type_name 讀 snapshot,不是即時 join:改掉/刪除 merchant_leave_types 的名稱,
-- 已登記的舊紀錄文案仍要維持登記當下的名稱(這是這個 codebase 已經踩過、修過的坑)。
-- =========================================================================
update merchant_leave_types set name = '特休(已改名)' where id = 'ee000000-0000-4000-8000-000000000061';

select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001', 'service_role');
select render_staff_leave_notification_variables('ee000000-0000-4000-8000-000000000071'::uuid) as r \gset renamed_
select pg_temp.test_clear_auth();

select is(:'renamed_r'::jsonb->>'leave_type_name', '特休', 'leave_type_name 讀 leave_type_name_snapshot,merchant_leave_types 改名後舊紀錄的文案仍維持登記當下的名稱(已知坑)');

-- =========================================================================
-- ④ 查無資料時回傳空物件 {},不報錯。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001', 'service_role');
select lives_ok(
  $$select render_staff_leave_notification_variables('00000000-0000-4000-8000-000000000000'::uuid)$$,
  '查無此請假紀錄時不報錯(安靜路徑)'
);
select render_staff_leave_notification_variables('00000000-0000-4000-8000-000000000000'::uuid) as r \gset missing_
select pg_temp.test_clear_auth();

select is(:'missing_r'::text, '{}', '查無此請假紀錄時回傳空物件 {}');

-- =========================================================================
-- ⑤ 權限邊界:只給 service_role,一般 authenticated 角色呼叫被擋下(比照 3.9 既有慣例)。
-- =========================================================================
select pg_temp.test_set_auth('ee000000-0000-4000-8000-000000000001');
select throws_ok(
  $$select render_staff_leave_notification_variables('ee000000-0000-4000-8000-000000000071'::uuid)$$,
  '42501', null,
  'render_staff_leave_notification_variables 不給一般 authenticated 角色呼叫,只給 service_role'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
