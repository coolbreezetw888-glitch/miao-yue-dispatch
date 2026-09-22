-- 模組 9(支付方式)— SPECS-INDEX #604(規格書 .project/specs/支付方式.md §3.1.1)。
-- 新增預約付款方式改為必填:create_booking 新建不可留空;update_booking 編輯既有訂單維持原值
-- (含原本就是 null)不觸發必填擋下,只有主動改成空值才擋。
begin;

select plan(7);

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
-- Fixture。
-- =========================================================================
insert into auth.users (id, email) values
  ('d9200000-0000-4000-8000-000000000001', 'pgtap-m9req604-admin@test.local');

insert into groups (id) values ('d9200000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('d9200000-0000-4000-8000-000000000021', 'd9200000-0000-4000-8000-000000000011', '付款方式必填測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('d9200000-0000-4000-8000-000000000021', 'd9200000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'd9200000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('d9200000-0000-4000-8000-000000000031', 'd9200000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('d9200000-0000-4000-8000-000000000041', 'd9200000-0000-4000-8000-000000000021', '服務人員', '0901000101', true);

insert into payment_methods (id, merchant_id, name) values
  ('d9200000-0000-4000-8000-000000000061', 'd9200000-0000-4000-8000-000000000021', '現場付款');

select pg_temp.test_set_auth('d9200000-0000-4000-8000-000000000001');

-- =========================================================================
-- ① 新建訂單不選付款方式被擋下,錯誤訊息「請選擇付款方式」。
-- =========================================================================
select throws_ok(
  $$select create_booking(
    p_merchant_id => 'd9200000-0000-4000-8000-000000000021',
    p_staff_id => 'd9200000-0000-4000-8000-000000000041',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
    p_start_at => '2026-12-10 10:00:00+08',
    p_customer_name => '未選付款方式測試',
    p_customer_phone => '0955040001'
  )$$,
  'P0001', null,
  '#604①:新建訂單不選付款方式被擋下(函式內以「請選擇付款方式」為錯誤訊息,見 20260922160600 migration)'
);

-- =========================================================================
-- ② 新建訂單選擇有效付款方式成功。
-- =========================================================================
select id from create_booking(
  p_merchant_id => 'd9200000-0000-4000-8000-000000000021',
  p_staff_id => 'd9200000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
  p_start_at => '2026-12-10 11:00:00+08',
  p_customer_name => '有選付款方式測試',
  p_customer_phone => '0955040002',
  p_payment_method_id => 'd9200000-0000-4000-8000-000000000061'
) \gset booking_with_pm_

select is(
  (select payment_method_id from bookings where id = :'booking_with_pm_id'::uuid),
  'd9200000-0000-4000-8000-000000000061'::uuid,
  '#604②:新建訂單選擇有效付款方式成功,正確寫入'
);

-- =========================================================================
-- ③/④ 既有訂單(payment_method_id 原本是 null,模擬上線前的舊資料,用 postgres 身分直接改)。
-- =========================================================================
select id from create_booking(
  p_merchant_id => 'd9200000-0000-4000-8000-000000000021',
  p_staff_id => 'd9200000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
  p_start_at => '2026-12-10 12:00:00+08',
  p_customer_name => '既有null訂單測試',
  p_customer_phone => '0955040003',
  p_payment_method_id => 'd9200000-0000-4000-8000-000000000061'
) \gset legacy_booking_

select pg_temp.test_clear_auth();
update bookings set payment_method_id = null, payment_method_name_snapshot = null
where id = :'legacy_booking_id'::uuid;
select pg_temp.test_set_auth('d9200000-0000-4000-8000-000000000001');

-- ③ 編輯這筆既有訂單,不改動付款方式欄位(維持 null),其餘欄位正常送出,儲存成功。
select lives_ok(
  format(
    $$select update_booking(
      p_booking_id => '%s',
      p_staff_id => 'd9200000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      p_start_at => '2026-12-10 12:30:00+08',
      p_customer_name => '既有null訂單測試(改時間)',
      p_customer_phone => '0955040003',
      p_payment_method_id => null
    )$$,
    (:'legacy_booking_id')
  ),
  '#604③:編輯既有訂單(payment_method_id 原本是 null)不改動付款方式欄位,其餘欄位正常送出,儲存成功(不被必填規則誤擋)'
);

select is(
  (select payment_method_id from bookings where id = :'legacy_booking_id'::uuid),
  null::uuid,
  '#604③:維持原值放行後,payment_method_id 依然是 null'
);

-- ④ 編輯同一筆訂單,這次主動把付款方式從沒有值改成有值再改回沒有值,應該被擋下。
-- 這一步是前置鋪陳(先改成有值),本身應該要成功——用 lives_ok,不是 throws_ok(先前誤植成
-- throws_ok,邏輯剛好寫反,已修正)。
select lives_ok(
  format(
    $$select update_booking(
      p_booking_id => '%s',
      p_staff_id => 'd9200000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      p_start_at => '2026-12-10 12:30:00+08',
      p_customer_name => '既有null訂單測試',
      p_customer_phone => '0955040003',
      p_payment_method_id => 'd9200000-0000-4000-8000-000000000061'
    )$$,
    (:'legacy_booking_id')
  ),
  '#604④(前置):先主動改成有值,驗證這一步本身會成功(不是本項斷言重點,只是鋪陳下一步「主動改回空值」的情境)'
);

select throws_ok(
  format(
    $$select update_booking(
      p_booking_id => '%s',
      p_staff_id => 'd9200000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      p_start_at => '2026-12-10 12:30:00+08',
      p_customer_name => '既有null訂單測試',
      p_customer_phone => '0955040003',
      p_payment_method_id => null
    )$$,
    (:'legacy_booking_id')
  ),
  'P0001', null,
  '#604④(核心):客服主動把付款方式從有值改回沒有值,被擋下'
);

-- =========================================================================
-- ⑤ 資料匯入建立的訂單(source='import',payment_method_id 為 null)透過 update_booking 編輯
-- 其他欄位,不受影響,儲存成功——用 postgres 身分直接插入一筆 source='import' 的訂單模擬。
-- =========================================================================
select pg_temp.test_clear_auth();

insert into bookings (
  id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone,
  source, created_by_role, status, subtotal_amount_snapshot, final_amount_snapshot
) values (
  'd9200000-0000-4000-8000-000000000091', 'd9200000-0000-4000-8000-000000000021',
  'd9200000-0000-4000-8000-000000000041', '2026-12-11 10:00:00+08', '2026-12-11 10:30:00+08',
  '匯入訂單測試', '0955040004', 'import', 'admin', 'pending_confirmation', 300, 300
);

select pg_temp.test_set_auth('d9200000-0000-4000-8000-000000000001');

select lives_ok(
  $$select update_booking(
    p_booking_id => 'd9200000-0000-4000-8000-000000000091',
    p_staff_id => 'd9200000-0000-4000-8000-000000000041',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','d9200000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
    p_start_at => '2026-12-11 10:00:00+08',
    p_customer_name => '匯入訂單測試(改備註)',
    p_customer_phone => '0955040004',
    p_notes => '客服補充備註',
    p_payment_method_id => null
  )$$,
  '#604⑤:資料匯入建立的訂單(source=import,payment_method_id 原本為 null)透過 update_booking 編輯其他欄位,維持原值放行,不受影響,儲存成功'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
