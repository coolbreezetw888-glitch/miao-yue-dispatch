-- 模組 6(行事曆與預約核心引擎)— SPECS-INDEX #924(2026-10-01,規格書
-- .project/specs/建單自動建立會員與會員兩層狀態.md §12.4):跨店佔用判定只在**同一集團內**成立。
--
-- 使用者裁決(原話):「兩間毫不相關的商家不會有擋單的問題,因為店家之間是完全隔離的,
-- 除非放在同一個集團底下,才會有判斷時段佔用的機制。」
--
-- 這一檔鎖住的行為(規格書 §12.4 pgTAP 至少要有的四條 + 權限):
--   1. 不同集團、同電話服務人員 ⇒ A 店建單**不被** C 店的預約擋;兩支行事曆函式都**不出現**灰格
--   2. 同集團、同電話服務人員 ⇒ 照舊擋下,錯誤訊息逐字等於 §12.7 文案「{角色}「本店姓名」在這個時段…」(主要 / 助手各一條),且**不含**別家店名
--   3. 同集團時兩支行事曆函式**會**出現灰格(該有的保護沒有被一起拿掉)
--   4. 同一間商家內自己的衝突檢查完全不受影響
--   5. 新的輔助函式 private.same_person_staff_ids_in_group 三個角色都沒有 EXECUTE
--
-- Fixture:
--   集團 G1:A 店、B 店(同集團)       集團 G2:C 店(不相關的商家)
--   三店各有一位電話都是 0911222333 的服務人員 sa / sb / sc(sa 有開通登入,用來測服務人員端)
begin;

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

-- 用同一組參數建單,回傳錯誤訊息(成功則回 null)——用來斷言「訊息裡沒有別家店名」。
create function pg_temp.try_create_booking(
  p_merchant_id uuid, p_staff_id uuid, p_service_item_id uuid, p_payment_method_id uuid,
  p_start_at timestamptz
)
returns text language plpgsql as $$
begin
  perform create_booking(
    p_merchant_id => p_merchant_id,
    p_staff_id => p_staff_id,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id', p_service_item_id, 'quantity', 1, 'unit_price', 1000)),
    p_start_at => p_start_at,
    p_customer_name => '跨店測試客戶',
    p_customer_phone => '0922000924',
    p_payment_method_id => p_payment_method_id
  );
  return null;
exception when others then
  return sqlerrm;
end;
$$;
grant execute on function pg_temp.try_create_booking(uuid, uuid, uuid, uuid, timestamptz) to authenticated;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('f9240000-0000-4000-8000-000000000001', 'pgtap-924-admin-a@test.local'),
  ('f9240000-0000-4000-8000-000000000002', 'pgtap-924-admin-b@test.local'),
  ('f9240000-0000-4000-8000-000000000003', 'pgtap-924-admin-c@test.local'),
  ('f9240000-0000-4000-8000-000000000004', 'pgtap-924-staff-sa@test.local');

insert into groups (id) values
  ('f9240000-0000-4000-8000-000000000011'),
  ('f9240000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('f9240000-0000-4000-8000-000000000021', 'f9240000-0000-4000-8000-000000000011', '跨店測試甲集團A店', 'in_store_beauty'),
  ('f9240000-0000-4000-8000-000000000022', 'f9240000-0000-4000-8000-000000000011', '跨店測試甲集團B店', 'in_store_beauty'),
  ('f9240000-0000-4000-8000-000000000023', 'f9240000-0000-4000-8000-000000000012', '跨店測試乙集團C店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('f9240000-0000-4000-8000-000000000021', 'f9240000-0000-4000-8000-000000000001'),
  ('f9240000-0000-4000-8000-000000000022', 'f9240000-0000-4000-8000-000000000002'),
  ('f9240000-0000-4000-8000-000000000023', 'f9240000-0000-4000-8000-000000000003');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from unnest(array[
  'f9240000-0000-4000-8000-000000000021',
  'f9240000-0000-4000-8000-000000000022',
  'f9240000-0000-4000-8000-000000000023'
]::uuid[]) as m, generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9240000-0000-4000-8000-000000000031', 'f9240000-0000-4000-8000-000000000021', 'A店服務', 1000, 'primary', 30),
  ('f9240000-0000-4000-8000-000000000032', 'f9240000-0000-4000-8000-000000000022', 'B店服務', 1000, 'primary', 30),
  ('f9240000-0000-4000-8000-000000000033', 'f9240000-0000-4000-8000-000000000023', 'C店服務', 1000, 'primary', 30);

insert into payment_methods (id, merchant_id, name) values
  ('f9240000-0000-4000-8000-000000000071', 'f9240000-0000-4000-8000-000000000021', '現場付款'),
  ('f9240000-0000-4000-8000-000000000072', 'f9240000-0000-4000-8000-000000000022', '現場付款'),
  ('f9240000-0000-4000-8000-000000000073', 'f9240000-0000-4000-8000-000000000023', '現場付款');

insert into merchant_staff (id, merchant_id, user_id, name, phone, no_time_slot_limit, status, login_status, login_activated_at) values
  ('f9240000-0000-4000-8000-000000000041', 'f9240000-0000-4000-8000-000000000021', 'f9240000-0000-4000-8000-000000000004', 'A店的sa', '0911222333', true, 'active', 'active', now());
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('f9240000-0000-4000-8000-000000000042', 'f9240000-0000-4000-8000-000000000022', 'B店的sb', '0911222333', true),
  ('f9240000-0000-4000-8000-000000000043', 'f9240000-0000-4000-8000-000000000023', 'C店的sc', '0911222333', true),
  -- B 店另一位(電話不同),用來當主要服務人員、把 sb 放在助手位置測助手的訊息
  ('f9240000-0000-4000-8000-000000000044', 'f9240000-0000-4000-8000-000000000022', 'B店的sb2', '0911222444', true);

-- =========================================================================
-- 1. 不同集團:C 店先在 10:00 排了 sc,A 店同一時段排 sa **不被擋**
-- =========================================================================
select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000003');
select lives_ok(
  $$select create_booking(
    p_merchant_id => 'f9240000-0000-4000-8000-000000000023',
    p_staff_id => 'f9240000-0000-4000-8000-000000000043',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9240000-0000-4000-8000-000000000033','quantity',1,'unit_price',1000)),
    p_start_at => '2036-03-10 10:00:00+08',
    p_customer_name => 'C店客戶',
    p_customer_phone => '0922000001',
    p_payment_method_id => 'f9240000-0000-4000-8000-000000000073'
  )$$,
  '前提:C 店(乙集團)在 2036-03-10 10:00 幫 sc 建單成功'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000001');
select is(
  pg_temp.try_create_booking(
    'f9240000-0000-4000-8000-000000000021', 'f9240000-0000-4000-8000-000000000041',
    'f9240000-0000-4000-8000-000000000031', 'f9240000-0000-4000-8000-000000000071',
    '2036-03-10 10:00:00+08'
  ),
  null,
  '1 #924:A 店(甲集團)同一時段幫同電話的 sa 建單成功 —— 不相關集團的 C 店預約不會擋單'
);

select is(
  (
    select jsonb_array_length(s -> 'foreign_bookings')
    from jsonb_array_elements(get_merchant_day_schedule('f9240000-0000-4000-8000-000000000021', '2036-03-10') -> 'staff') s
    where (s ->> 'staff_id')::uuid = 'f9240000-0000-4000-8000-000000000041'
  ),
  0,
  '1 #924:A 店行事曆(get_merchant_day_schedule)sa 那一欄沒有灰格 —— C 店的預約不算跨店佔用'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000004');
select is(
  jsonb_array_length(get_my_day_schedule_state('f9240000-0000-4000-8000-000000000041', '2036-03-10') -> 'foreign_bookings'),
  0,
  '1 #924:服務人員端(get_my_day_schedule_state)sa 自己看也沒有灰格'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000003');
select is(
  (
    select jsonb_array_length(s -> 'foreign_bookings')
    from jsonb_array_elements(get_merchant_day_schedule('f9240000-0000-4000-8000-000000000023', '2036-03-10') -> 'staff') s
    where (s ->> 'staff_id')::uuid = 'f9240000-0000-4000-8000-000000000043'
  ),
  0,
  '1 #924:反方向也成立 —— C 店行事曆 sc 那一欄看不到 A 店的預約'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 2. 同集團:B 店同一時段排 sb ⇒ 被 A 店 sa 那筆擋下,訊息逐字等於規格文案、不含別家店名
-- =========================================================================
select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000002');
select throws_ok(
  $$select create_booking(
    p_merchant_id => 'f9240000-0000-4000-8000-000000000022',
    p_staff_id => 'f9240000-0000-4000-8000-000000000042',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9240000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)),
    p_start_at => '2036-03-10 10:00:00+08',
    p_customer_name => 'B店客戶',
    p_customer_phone => '0922000002',
    p_payment_method_id => 'f9240000-0000-4000-8000-000000000072'
  )$$,
  'P0001',
  '主要服務人員「B店的sb」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員',
  '2 #924/§12.7:同集團 B 店同一時段排同一個人 ⇒ 照舊擋下,訊息逐字等於「主要服務人員「本店姓名」…」'
);

select ok(
  (
    select msg not like '%A店%' and msg not like '%跨店測試%' and msg not like '%0922000924%'
       and msg not like '%跨店測試客戶%' and msg not like '%另一間店%'
    from (select pg_temp.try_create_booking(
      'f9240000-0000-4000-8000-000000000022', 'f9240000-0000-4000-8000-000000000042',
      'f9240000-0000-4000-8000-000000000032', 'f9240000-0000-4000-8000-000000000072',
      '2036-03-10 10:00:00+08'
    ) as msg) t
    where msg is not null
  ),
  '2 #924:錯誤訊息不含別家分店(A 店)店名、客戶姓名 / 電話(資安清單 #17)'
);

-- §12.7:助手身分被擋時,p_role_label 本身已是「助手「姓名」」,訊息不會重複姓名
select throws_ok(
  $$select create_booking(
    p_merchant_id => 'f9240000-0000-4000-8000-000000000022',
    p_staff_id => 'f9240000-0000-4000-8000-000000000044',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9240000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)),
    p_start_at => '2036-03-10 10:00:00+08',
    p_customer_name => 'B店客戶',
    p_customer_phone => '0922000004',
    p_payment_method_id => 'f9240000-0000-4000-8000-000000000072',
    p_assistant_staff_ids => array['f9240000-0000-4000-8000-000000000042']::uuid[]
  )$$,
  'P0001',
  '助手「B店的sb」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員',
  '2 §12.7:同集團衝突發生在助手身上 ⇒ 訊息指出是哪一位助手(本店的人),姓名不重複'
);

-- B 店換到 14:00 就能排(同集團判定只擋真正重疊的時段)
select is(
  pg_temp.try_create_booking(
    'f9240000-0000-4000-8000-000000000022', 'f9240000-0000-4000-8000-000000000042',
    'f9240000-0000-4000-8000-000000000032', 'f9240000-0000-4000-8000-000000000072',
    '2036-03-10 14:00:00+08'
  ),
  null,
  '2 #924:同集團 B 店改排不重疊的 14:00 ⇒ 建單成功'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 3. 同集團時兩支行事曆函式**會**出現灰格(B 店 14:00 那筆),而且不會混進 C 店的預約
-- =========================================================================
select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000001');
select is(
  (
    select jsonb_agg((fb ->> 'start_at')::timestamptz order by (fb ->> 'start_at')::timestamptz)
    from jsonb_array_elements(get_merchant_day_schedule('f9240000-0000-4000-8000-000000000021', '2036-03-10') -> 'staff') s,
         jsonb_array_elements(s -> 'foreign_bookings') fb
    where (s ->> 'staff_id')::uuid = 'f9240000-0000-4000-8000-000000000041'
  ),
  jsonb_build_array('2036-03-10 14:00:00+08'::timestamptz),
  '3 #924:A 店行事曆 sa 那一欄出現同集團 B 店 14:00 的灰格,而且只有這一格(C 店 10:00 那筆不算)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000004');
select is(
  (
    select jsonb_agg((fb ->> 'start_at')::timestamptz order by (fb ->> 'start_at')::timestamptz)
    from jsonb_array_elements(get_my_day_schedule_state('f9240000-0000-4000-8000-000000000041', '2036-03-10') -> 'foreign_bookings') fb
  ),
  jsonb_build_array('2036-03-10 14:00:00+08'::timestamptz),
  '3 #924:服務人員端 sa 自己看也是同一格 —— 兩支行事曆函式的判定一致'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9240000-0000-4000-8000-000000000001');
-- 行事曆顯示灰格的地方,送出一定會被擋(三支函式同一套判定,不會「看起來空的、送出卻被擋」的反面)
select is(
  pg_temp.try_create_booking(
    'f9240000-0000-4000-8000-000000000021', 'f9240000-0000-4000-8000-000000000041',
    'f9240000-0000-4000-8000-000000000031', 'f9240000-0000-4000-8000-000000000071',
    '2036-03-10 14:00:00+08'
  ),
  '主要服務人員「A店的sa」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員',
  '3 #924:A 店在灰格那個時段(14:00)幫 sa 建單 ⇒ 被擋,跟行事曆顯示一致(訊息只講本店的 sa)'
);

select ok(
  (
    select msg not like '%B店%' and msg not like '%跨店測試%' and msg not like '%B店客戶%'
    from (select pg_temp.try_create_booking(
      'f9240000-0000-4000-8000-000000000021', 'f9240000-0000-4000-8000-000000000041',
      'f9240000-0000-4000-8000-000000000031', 'f9240000-0000-4000-8000-000000000071',
      '2036-03-10 14:00:00+08'
    ) as msg) t
    where msg is not null
  ),
  '3 #924/§12.7:A 店被同集團 B 店擋下時,訊息不含 B 店店名、B 店客戶(只出現本店自己的服務人員姓名)'
);

-- =========================================================================
-- 4. 同一間商家內自己的衝突檢查不受影響
-- =========================================================================
select throws_ok(
  $$select create_booking(
    p_merchant_id => 'f9240000-0000-4000-8000-000000000021',
    p_staff_id => 'f9240000-0000-4000-8000-000000000041',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9240000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
    p_start_at => '2036-03-10 10:00:00+08',
    p_customer_name => 'A店第二位客戶',
    p_customer_phone => '0922000003',
    p_payment_method_id => 'f9240000-0000-4000-8000-000000000071'
  )$$,
  'P0001',
  '主要服務人員在這個時段已經有其他預約',
  '4 #924:同一間店、同一位服務人員時段重疊 ⇒ 照舊擋下(自己的衝突檢查不受影響)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 5. 權限:新的輔助函式只給 SECURITY DEFINER 函式內部呼叫(supabase-permission-hygiene 規則 1)
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'private.same_person_staff_ids_in_group(uuid)', 'execute'),
  '5 #924:anon 不能執行 private.same_person_staff_ids_in_group'
);
select ok(
  not has_function_privilege('authenticated', 'private.same_person_staff_ids_in_group(uuid)', 'execute'),
  '5 #924:authenticated 不能執行 private.same_person_staff_ids_in_group'
);

select * from finish();
rollback;
