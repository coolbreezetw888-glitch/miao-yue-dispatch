-- 建單表單細節修正規格書第二節:customer_address 欄位必填驗證(依產業類型)。
-- 對應驗收要求「pgTAP:到府派工產業建單/編輯不填地址被擋下;到店服務產業不受影響;
-- 舊資料 customer_address 是 null 不出錯」。
--
-- 情境布置:兩間商家——「地址測試派工商家」(on_site_dispatch,需要地址)、
-- 「地址測試到店商家」(in_store_beauty,不需要地址),各一位服務人員、一項服務、
-- 週二(day_of_week=2)09:00-18:00 營業,服務人員 no_time_slot_limit=true(不受個人時段限制,
-- 避免這份測試檔案的斷言被無關的時段邊界規則干擾)。
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
  ('ba000000-0000-4000-8000-000000000001', 'pgtap-m5addr-admin@test.local');

insert into groups (id) values
  ('ba000000-0000-4000-8000-000000000010'),
  ('ba000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('ba000000-0000-4000-8000-000000000020', 'ba000000-0000-4000-8000-000000000010', '地址測試派工商家', 'on_site_dispatch'),
  ('ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000011', '地址測試到店商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ba000000-0000-4000-8000-000000000020', 'ba000000-0000-4000-8000-000000000001'),
  ('ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('ba000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00'),
  ('ba000000-0000-4000-8000-000000000021', 2, false, '09:00', '18:00');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('ba000000-0000-4000-8000-000000000030', 'ba000000-0000-4000-8000-000000000020', '到府清潔', 800, 'primary', 60),
  ('ba000000-0000-4000-8000-000000000031', 'ba000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('ba000000-0000-4000-8000-000000000040', 'ba000000-0000-4000-8000-000000000020', '派工師傅', null, true),
  ('ba000000-0000-4000-8000-000000000041', 'ba000000-0000-4000-8000-000000000021', '到店設計師', null, true);

select pg_temp.test_set_auth('ba000000-0000-4000-8000-000000000001');

-- ① 到府派工商家:不填地址(p_customer_address 完全不傳,用預設值 null),建單應被擋下。
select throws_ok(
  $$select create_booking(
    'ba000000-0000-4000-8000-000000000020', 'ba000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶一', '0911100001'
  )$$,
  'P0001', NULL,
  '規格書第二節:到府派工商家建單不填地址,被擋下'
);

-- ② 到府派工商家:地址只有空白字元,一樣視為沒填,應被擋下。
select throws_ok(
  format(
    $$select create_booking(
      'ba000000-0000-4000-8000-000000000020', 'ba000000-0000-4000-8000-000000000040',
      jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
      '客戶一', '0911100001', null, null, '{}'::uuid[], '{}'::uuid[], '   '
    )$$
  ),
  'P0001', NULL,
  '規格書第二節:到府派工商家建單地址只有空白字元,一樣視為沒填,被擋下'
);

-- ③ 到府派工商家:有填地址,建單應該成功,且地址正確存入(btrim 過)。
select id from create_booking(
  'ba000000-0000-4000-8000-000000000020', 'ba000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  '客戶一', '0911100001', null, null, '{}'::uuid[], '{}'::uuid[], '  台北市中正區忠孝東路一段1號  '
) \gset dispatch_

select is(
  (select customer_address from bookings where id = :'dispatch_id'::uuid),
  '台北市中正區忠孝東路一段1號',
  '規格書第二節:到府派工商家有填地址,建單成功且地址正確存入(前後空白已 trim)'
);

-- ④ 到店服務商家:完全不填地址,建單應該成功(不受影響)。
select lives_ok(
  $$select create_booking(
    'ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶二', '0911100002'
  )$$,
  '規格書第二節:到店服務商家建單不填地址,不受影響,建立成功'
);

-- ⑤ 到店服務商家:那筆預約的 customer_address 應該是 null(沒有被塞進奇怪的預設值)。
select id from create_booking(
  'ba000000-0000-4000-8000-000000000021', 'ba000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 11:00:00+08',
  '客戶三', '0911100003'
) \gset beauty_

select is(
  (select customer_address from bookings where id = :'beauty_id'::uuid),
  null,
  '規格書第二節:到店服務商家不填地址時,customer_address 正確存成 null'
);

-- ⑥ 編輯(update_booking):到府派工商家,把地址改成空白,應該被擋下(後端不能只靠前端擋)。
select throws_ok(
  format(
    $$select update_booking(
      '%s', 'ba000000-0000-4000-8000-000000000040',
      jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
      '客戶一', '0911100001', null, null, '{}'::uuid[], '{}'::uuid[], ''
    )$$,
    :'dispatch_id'::text
  ),
  'P0001', NULL,
  '規格書第二節:到府派工商家編輯時把地址清空,一樣被擋下'
);

-- ⑦ 編輯(update_booking):到府派工商家,改成有效地址,應該成功並正確更新。
select lives_ok(
  format(
    $$select update_booking(
      '%s', 'ba000000-0000-4000-8000-000000000040',
      jsonb_build_array(jsonb_build_object('service_item_id','ba000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
      '客戶一', '0911100001', null, null, '{}'::uuid[], '{}'::uuid[], '台北市大安區'
    )$$,
    :'dispatch_id'::text
  ),
  '規格書第二節:到府派工商家編輯時改成有效地址,更新成功'
);

select is(
  (select customer_address from bookings where id = :'dispatch_id'::uuid),
  '台北市大安區',
  '規格書第二節:編輯後 customer_address 正確更新'
);

-- ⑧ 舊資料相容性:模擬「這支 migration 上線前就存在」的舊預約列(customer_address 是 null),
--    直接查詢/讀取不會出錯(欄位本身 nullable,不會因為舊資料沒有這個值而報錯)。
-- bookings 表沒有開放給 authenticated 角色的 INSERT 政策(規則 3.2:一律透過 create_booking/
-- update_booking 寫入),這裡先切回 postgres 超級使用者身分才能直接塞入這筆模擬舊資料的 fixture,
-- 跟本檔案其餘測試改用函式呼叫、不直接寫表的方式刻意不同。
select pg_temp.test_clear_auth();

insert into bookings (
  id, merchant_id, staff_id, start_at, end_at,
  customer_name, customer_phone, created_by_role, status
) values (
  'ba000000-0000-4000-8000-000000000099', 'ba000000-0000-4000-8000-000000000020',
  'ba000000-0000-4000-8000-000000000040', now(), now() + interval '30 minutes',
  '舊資料客戶', '0911199999', 'admin', 'accepted'
);

select is(
  (select customer_address from bookings where id = 'ba000000-0000-4000-8000-000000000099'::uuid),
  null,
  '規格書第二節/驗收②:舊資料(migration 上線前建立、沒有 customer_address 值)查詢正常,customer_address 是 null 不出錯'
);

-- ⑨ private.industry_requires_customer_address 判斷邏輯本身正確(不透過建單流程,直接測函式)。
select is(
  private.industry_requires_customer_address('on_site_dispatch'),
  true,
  'private.industry_requires_customer_address(on_site_dispatch) 回傳 true'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
