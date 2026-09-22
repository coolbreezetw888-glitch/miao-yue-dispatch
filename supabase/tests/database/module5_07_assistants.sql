-- 建單功能擴充規格書 2.2/決策記錄 2:助手完全比照主要服務人員套用全部驗證規則(邊界+衝突+
-- 跨商家電話比對),助手不能跟主要服務人員是同一人,同一人不能在同一筆預約裡被加派兩次。
begin;

select plan(10);

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

insert into auth.users (id, email) values
  ('b7000000-0000-4000-8000-000000000001', 'pgtap-m5x-admin1@test.local'),
  ('b7000000-0000-4000-8000-000000000002', 'pgtap-m5x-admin2@test.local');

insert into groups (id) values
  ('b7000000-0000-4000-8000-000000000011'),
  ('b7000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000011', '助手測試一店', 'in_store_beauty'),
  ('b7000000-0000-4000-8000-000000000022', 'b7000000-0000-4000-8000-000000000012', '助手測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000001'),
  ('b7000000-0000-4000-8000-000000000022', 'b7000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('b7000000-0000-4000-8000-000000000021', 2, false, '09:00', '18:00'),
  ('b7000000-0000-4000-8000-000000000022', 2, false, '09:00', '18:00');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('b7000000-0000-4000-8000-000000000031', 'b7000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 60),
  ('b7000000-0000-4000-8000-000000000032', 'b7000000-0000-4000-8000-000000000022', '洗髮', 300, 'primary', 60);

-- 一店:主要服務人員(全天可預約),助手 A(個人時段只有 14:00-18:00,比營業時間窄),
-- 助手 B(unlimited_backend_edit=true)。
-- 2026-09-22 補充(對應 .project/SPECS-INDEX.md #595/#596):merchant_staff.phone 改成
-- NOT NULL 之後不能再用 null 佔位,這三位跟跨商家電話比對邏輯無關,給互不相同的佔位電話即可。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b7000000-0000-4000-8000-000000000041', 'b7000000-0000-4000-8000-000000000021', '主要人員', '0900000020', true);
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b7000000-0000-4000-8000-000000000042', 'b7000000-0000-4000-8000-000000000021', '助手A', '0900000021', false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('b7000000-0000-4000-8000-000000000042', 2, '14:00', '18:00');
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('b7000000-0000-4000-8000-000000000043', 'b7000000-0000-4000-8000-000000000021', '助手B(不限)', '0900000022', false, true);

-- 二店:師傅C,電話跟一店的「助手A」不同,跟一店的「跨店助手D」電話字串完全相同,用來測跨商家電話比對
-- (2026-09-22 補充:CHECK 約束生效後不能再用不同格式表示同一號碼,兩邊改成逐字相同的 0933222222)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b7000000-0000-4000-8000-000000000051', 'b7000000-0000-4000-8000-000000000022', '二店師傅C', '0933222222', true);
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b7000000-0000-4000-8000-000000000044', 'b7000000-0000-4000-8000-000000000021', '跨店助手D', '0933222222', true);

-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。用 postgres 超級使用者身分布置(還沒 test_set_auth 任何角色),
-- 避免用「一店管理員」身分插入「二店」的付款方式時被 RLS 擋下。
insert into payment_methods (id, merchant_id, name) values ('777fa5c9-cc5c-5897-859f-53bf7504fe18', 'b7000000-0000-4000-8000-000000000021', '現場付款');
insert into payment_methods (id, merchant_id, name) values ('15c41bd6-3c4e-5823-a33f-9367619ede52', 'b7000000-0000-4000-8000-000000000022', '現場付款');

select pg_temp.test_set_auth('b7000000-0000-4000-8000-000000000001');

-- ① 助手不能跟主要服務人員是同一人。
select throws_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶一', '0911100001', null, null,
    array['b7000000-0000-4000-8000-000000000041']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  'P0001', null,
  '決策記錄 2/3:助手不能跟主要服務人員是同一人'
);

-- ② 同一人不能在同一筆預約裡被加派兩次助手。
select throws_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶二', '0911100002', null, null,
    array['b7000000-0000-4000-8000-000000000042', 'b7000000-0000-4000-8000-000000000042']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  'P0001', null,
  '決策記錄 3:同一位助手不能在同一筆預約裡被加派兩次'
);

-- ③ 決策記錄 2:助手完全比照主要服務人員套用邊界檢查——助手A個人時段只有 14:00-18:00,
--    10:00 的預約超出助手A的可預約時段,即使主要人員完全沒問題,整筆預約也應該被擋下。
select throws_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶三', '0911100003', null, null,
    array['b7000000-0000-4000-8000-000000000042']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  'P0001', null,
  '決策記錄 2:助手個人時段邊界檢查生效,超出助手可預約時段整筆預約被擋下'
);

-- ④ 對照組:同一個 14:00 時段(在助手A時段內),應該建立成功。
select lives_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 14:00:00+08',
    '客戶四', '0911100004', null, null,
    array['b7000000-0000-4000-8000-000000000042']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  '對照組:落在助手個人時段內,主要人員跟助手都通過驗證,建立成功'
);

-- ⑤ 決策記錄 2:助手在這個時段已經有其他預約(不論是主要或助手身份)應該被擋下——
--    助手A(id 42)在 14:00-15:00 已經有上面④那筆預約(她是助手身份),
--    現在幫她排一筆「她是主要服務人員」的重疊時段,應該被擋下。
select throws_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000042',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 14:30:00+08',
    '客戶五', '0911100005'
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  'P0001', null,
  '決策記錄 2 第 4 點:助手A已經以助手身份佔用這個時段,即使這次要排她當主要服務人員,重疊仍被擋下'
);

-- ⑥ 決策記錄 2/2.3:助手 B(unlimited_backend_edit=true,沒有設定任何可預約時段、
--    no_time_slot_limit=false)在商家營業時間內(10:00,主要人員也沒問題)本來應該因為「完全沒設定
--    可預約時段」被規則 2.5 擋下,但因為助手 B 有 unlimited_backend_edit,她自己的邊界檢查
--    (含這條)整組被跳過,整筆預約應該成功——驗證這個覆寫例外是「針對這個人」,不是「針對角色」
--    (規則 2.3 說明:助手跟主要服務人員各自依照自己的 unlimited_backend_edit 設定判斷)。
select lives_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶六', '0911100006', null, null,
    array['b7000000-0000-4000-8000-000000000043']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  '決策記錄 2/2.3:助手 unlimited_backend_edit=true 時,助手自己的邊界檢查(含規則 2.5 無時段設定)被跳過'
);

-- ⑦ 決策記錄 2:跨商家電話比對也要對每一位助手各自檢查——先讓二店師傅C在 2026-09-22 10:00-11:00
--    建立一筆預約。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('b7000000-0000-4000-8000-000000000002');

select lives_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000022', 'b7000000-0000-4000-8000-000000000051',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '二店客戶', '0922000000'
  , p_payment_method_id => '15c41bd6-3c4e-5823-a33f-9367619ede52')$$,
  '二店師傅C建立一筆 10:00-11:00 的預約成功'
);

select pg_temp.test_clear_auth();

-- ⑧ 一店幫「跨店助手D」(電話正規化後跟二店師傅C相同)在同時段安排成助手,應該被擋下
--    (決策記錄 2:跨商家電話比對對每一位助手各自查一次,不遺漏)。
select pg_temp.test_set_auth('b7000000-0000-4000-8000-000000000001');

select throws_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:30:00+08',
    '客戶七', '0911100007', null, null,
    array['b7000000-0000-4000-8000-000000000044']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  'P0001', null,
  '決策記錄 2:跨店助手D電話正規化後跟二店師傅C相同,時段重疊,助手的跨商家電話比對正確擋下'
);

-- ⑨ 對照組:不重疊的時段(15:00),同一位跨店助手D應該可以成功被加派。
select lives_ok(
  $$select create_booking(
    'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 15:00:00+08',
    '客戶八', '0911100008', null, null,
    array['b7000000-0000-4000-8000-000000000044']::uuid[]
  , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
  '對照組:不重疊的時段,跨店助手D的跨商家電話比對通過,建立成功'
);

-- ⑩ 找不到助手(id 不存在或不屬於這間商家)應該被擋下,錯誤訊息白話可讀。
select throws_ok(
  format(
    $$select create_booking(
      'b7000000-0000-4000-8000-000000000021', 'b7000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b7000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 16:00:00+08',
      '客戶九', '0911100009', null, null,
      array['%s']::uuid[]
    , p_payment_method_id => '777fa5c9-cc5c-5897-859f-53bf7504fe18')$$,
    'b7000000-0000-4000-8000-000000000099'
  ),
  'P0001', null,
  '找不到其中一位助手(不存在的 id),整筆預約建立被擋下'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
