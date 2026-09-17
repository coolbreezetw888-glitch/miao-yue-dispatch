-- 模組 5 資料層 CHECK/UNIQUE 約束測試,對應規格書 1.1(merchant_business_hours)、
-- 1.2(staff_availability_windows)、1.3(bookings 六個狀態值的 CHECK 約束)。
-- 直接以 postgres(超級使用者)身分測試約束本身,不透過 RLS——約束是資料完整性的最後一道防線,
-- 就算有人繞過應用層邏輯直接寫 SQL,也要被擋下來。
begin;

select plan(15);

insert into groups (id) values ('b6000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('b6000000-0000-4000-8000-000000000020', 'b6000000-0000-4000-8000-000000000010', '約束測試商家', 'in_store_beauty');

insert into merchant_staff (id, merchant_id, name)
values ('b6000000-0000-4000-8000-000000000040', 'b6000000-0000-4000-8000-000000000020', '約束測試服務人員');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('b6000000-0000-4000-8000-000000000030', 'b6000000-0000-4000-8000-000000000020', '約束測試服務', 100, 'primary', 30);

-- ① 1.1:is_closed=true 但仍給 open_time/close_time,應該被擋下。
select throws_ok(
  $$insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
    values ('b6000000-0000-4000-8000-000000000020', 1, true, '09:00', '18:00')$$,
  '23514', NULL,
  '規格書 1.1:is_closed=true 卻給了 open_time/close_time,被 CHECK 約束擋下'
);

-- ② 1.1:open_time >= close_time,應該被擋下。
select throws_ok(
  $$insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
    values ('b6000000-0000-4000-8000-000000000020', 1, false, '18:00', '09:00')$$,
  '23514', NULL,
  '規格書 1.1:open_time 晚於等於 close_time,被 CHECK 約束擋下'
);

-- ③ 1.1:同一天不能有第二筆(unique(merchant_id, day_of_week))。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('b6000000-0000-4000-8000-000000000020', 1, false, '09:00', '18:00');

select throws_ok(
  $$insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
    values ('b6000000-0000-4000-8000-000000000020', 1, false, '10:00', '20:00')$$,
  '23505', NULL,
  '規格書 1.1:同一天不能重複設定(unique(merchant_id, day_of_week))'
);

-- ④ 1.2:end_time <= start_time,應該被擋下。
select throws_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('b6000000-0000-4000-8000-000000000040', 1, '18:00', '09:00')$$,
  '23514', NULL,
  '規格書 1.2:end_time 早於等於 start_time,被 CHECK 約束擋下'
);

-- ⑤ 1.2:允許同一天多組時段(跟 1.1 刻意不同)。
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('b6000000-0000-4000-8000-000000000040', 1, '09:00', '12:00');

select lives_ok(
  $$insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('b6000000-0000-4000-8000-000000000040', 1, '14:00', '18:00')$$,
  '規格書 1.2:允許同一天有多組不重複的時段(跟 1.1 商家整體營業時間刻意不同)'
);

-- ⑥ 1.3:status 只能是六個定義好的值之一。
select throws_ok(
  format(
    $$insert into bookings (
        merchant_id, staff_id, start_at, end_at,
        customer_name, customer_phone, created_by_role, status
      ) values (
        '%s', '%s', now(), now() + interval '30 minutes',
        '測試客戶', '0900000000', 'admin', 'not_a_real_status'
      )$$,
    'b6000000-0000-4000-8000-000000000020', 'b6000000-0000-4000-8000-000000000040'
  ),
  '23514', NULL,
  '規格書 1.3:status 不在六個定義好的值之內,被 CHECK 約束擋下'
);

-- ⑦ 1.3:六個狀態值本身(包含這次不會被觸發的三個)都必須能存在於 CHECK 約束裡,不需要
--    任何函式觸發,直接 INSERT 驗證約束允許這些值(規格書第七節「新發現」段落明講的驗收標準)。
select lives_ok(
  format(
    $$insert into bookings (
        merchant_id, staff_id, start_at, end_at,
        customer_name, customer_phone, created_by_role, status
      ) values (
        '%s', '%s', now(), now() + interval '30 minutes',
        '測試客戶-待回覆', '0900000001', 'customer', 'pending_reply'
      )$$,
    'b6000000-0000-4000-8000-000000000020', 'b6000000-0000-4000-8000-000000000040'
  ),
  '規格書 1.3/2.9:CHECK 約束允許 pending_reply 這個預留狀態值存在(這次不會被任何函式觸發,但約束要先定義完整)'
);

select lives_ok(
  format(
    $$insert into bookings (
        merchant_id, staff_id, start_at, end_at,
        customer_name, customer_phone, created_by_role, status
      ) values (
        '%s', '%s', now(), now() + interval '30 minutes',
        '測試客戶-派單中', '0900000002', 'customer', 'dispatching'
      )$$,
    'b6000000-0000-4000-8000-000000000020', 'b6000000-0000-4000-8000-000000000040'
  ),
  '規格書 1.3/2.9:CHECK 約束允許 dispatching 這個預留狀態值存在'
);

-- ⑧ 1.3:end_at 不能早於 start_at。
select throws_ok(
  format(
    $$insert into bookings (
        merchant_id, staff_id, start_at, end_at,
        customer_name, customer_phone, created_by_role, status
      ) values (
        '%s', '%s', now(), now() - interval '30 minutes',
        '測試客戶', '0900000003', 'admin', 'accepted'
      )$$,
    'b6000000-0000-4000-8000-000000000020', 'b6000000-0000-4000-8000-000000000040'
  ),
  '23514', NULL,
  '規格書 1.3:end_at 早於 start_at,被 CHECK 約束擋下'
);

-- ⑨ 建單功能擴充 2.1:booking_service_items.duration_minutes_snapshot 不能是負數。
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role, status)
values (
  'b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000020',
  'b6000000-0000-4000-8000-000000000040', now(), now() + interval '30 minutes',
  '約束測試客戶', '0900000010', 'admin', 'pending_confirmation'
);

select throws_ok(
  $$insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
    values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000030', -1)$$,
  '23514', NULL,
  '建單功能擴充 2.1:duration_minutes_snapshot 不能是負數,被 CHECK 約束擋下'
);

-- ⑩ 建單功能擴充 2.1:同一筆預約不能重複選同一個服務項目(unique(booking_id, service_item_id))。
insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000030', 30);

select throws_ok(
  $$insert into booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
    values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000030', 30)$$,
  '23505', NULL,
  '建單功能擴充 2.1:同一筆預約不能重複選同一個服務項目(unique 約束)'
);

-- ⑪ 建單功能擴充 2.2:同一人不能在同一筆預約裡被加派兩次助手(unique(booking_id, staff_id))。
insert into merchant_staff (id, merchant_id, name)
values ('b6000000-0000-4000-8000-000000000041', 'b6000000-0000-4000-8000-000000000020', '約束測試助手');

insert into booking_assistants (booking_id, staff_id)
values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000041');

select throws_ok(
  $$insert into booking_assistants (booking_id, staff_id)
    values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000041')$$,
  '23505', NULL,
  '建單功能擴充 2.2:同一位助手不能在同一筆預約裡被加派兩次(unique 約束)'
);

-- ⑫ 建單功能擴充 2.3:material_cost_items.amount 不能是負數。
select throws_ok(
  format(
    $$insert into material_cost_items (merchant_id, name, amount) values ('%s', '測試料錢品項', -10)$$,
    'b6000000-0000-4000-8000-000000000020'
  ),
  '23514', NULL,
  '建單功能擴充 2.3:material_cost_items.amount 不能是負數,被 CHECK 約束擋下'
);

-- ⑬ 建單功能擴充 2.3:material_cost_items.status 只能是 active/removed。
select throws_ok(
  format(
    $$insert into material_cost_items (merchant_id, name, amount, status) values ('%s', '測試料錢品項2', 10, 'not_a_real_status')$$,
    'b6000000-0000-4000-8000-000000000020'
  ),
  '23514', NULL,
  '建單功能擴充 2.3:material_cost_items.status 不在 active/removed 之內,被 CHECK 約束擋下'
);

-- ⑭ 建單功能擴充 2.3:同一筆預約不能重複選同一個料錢成本品項(unique(booking_id, material_cost_item_id))。
insert into material_cost_items (id, merchant_id, name, amount)
values ('b6000000-0000-4000-8000-000000000060', 'b6000000-0000-4000-8000-000000000020', '約束測試料錢品項', 50);

insert into booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000060', 50);

select throws_ok(
  $$insert into booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    values ('b6000000-0000-4000-8000-000000000050', 'b6000000-0000-4000-8000-000000000060', 50)$$,
  '23505', NULL,
  '建單功能擴充 2.3:同一筆預約不能重複選同一個料錢成本品項(unique 約束)'
);

select * from finish();

rollback;
