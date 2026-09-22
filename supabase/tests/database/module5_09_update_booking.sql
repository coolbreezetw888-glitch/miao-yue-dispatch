-- 建單功能擴充規格書 4.9/3.5/決策記錄 6:update_booking(編輯已建立訂單)。
-- 重點驗證:①可編輯狀態限制 ②排除自己原本時段不誤判衝突 ③跟自己另一筆真衝突時段仍要擋下
-- ④不改變 status ⑤重新驗證跟 create_booking 一致(這裡挑邊界規則做代表性驗證,完整規則清單已
-- 在 module5_01/02/07/08 對 create_booking 覆蓋過,共用同一支 private.validate_booking_selection)。
begin;

select plan(11);

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
  ('b9000000-0000-4000-8000-000000000001', 'pgtap-m5x-admin@test.local'),
  ('b9000000-0000-4000-8000-000000000002', 'pgtap-m5x-other-admin@test.local');

insert into groups (id) values
  ('b9000000-0000-4000-8000-000000000011'),
  ('b9000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('b9000000-0000-4000-8000-000000000021', 'b9000000-0000-4000-8000-000000000011', '編輯測試商家', 'in_store_beauty'),
  ('b9000000-0000-4000-8000-000000000023', 'b9000000-0000-4000-8000-000000000012', '不相干的另一間商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('b9000000-0000-4000-8000-000000000021', 'b9000000-0000-4000-8000-000000000001'),
  ('b9000000-0000-4000-8000-000000000023', 'b9000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('b9000000-0000-4000-8000-000000000021', 2, false, '09:00', '18:00');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('b9000000-0000-4000-8000-000000000031', 'b9000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30),
  ('b9000000-0000-4000-8000-000000000032', 'b9000000-0000-4000-8000-000000000021', '剪髮', 500, 'primary', 60);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('b9000000-0000-4000-8000-000000000041', 'b9000000-0000-4000-8000-000000000021', '服務人員甲', '0901000101', true);
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('b9000000-0000-4000-8000-000000000042', 'b9000000-0000-4000-8000-000000000021', '服務人員乙', '0901000102', true);

select pg_temp.test_set_auth('b9000000-0000-4000-8000-000000000001');

-- 建立第一筆預約(10:00-10:30,pending_confirmation)。
select id from create_booking(
  'b9000000-0000-4000-8000-000000000021', 'b9000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  '客戶甲', '0988000001'
) \gset booking_

-- ① 規則 3.5 第 2 點:編輯時服務項目/時段/客戶資料都能改,改完重新算出正確的 end_at。
select is(
  (
    select end_at
    from update_booking(
      :'booking_id'::uuid, 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
      '客戶甲(改名)', '0988000009'
    )
  ),
  '2026-09-22 11:00:00+08'::timestamptz,
  '規則 3.5:編輯後改成 60 分鐘的服務項目,end_at 正確重新計算為 11:00'
);

-- ② 驗證客戶資料真的被改掉。
select is(
  (select customer_name from bookings where id = :'booking_id'::uuid),
  '客戶甲(改名)',
  '規則 3.5:編輯後客戶姓名正確更新'
);

-- ③ 規則 3.5 第 5 點:編輯不會改變 status(還是 pending_confirmation)。
select is(
  (select status from bookings where id = :'booking_id'::uuid),
  'pending_confirmation',
  '規則 3.5 第 5 點:update_booking 不會改變 status 欄位'
);

-- ④ 規則 3.5 第 3 點核心情境:把時段延後 10 分鐘(10:00-11:00 改成 10:10-11:10),
--    只是跟自己原本的時段重疊,不應該被誤判成衝突,應該要成功。
select lives_ok(
  format(
    $$select update_booking(
      '%s', 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 10:10:00+08',
      '客戶甲(延後)', '0988000009'
    )$$,
    :'booking_id'::text
  ),
  '規則 3.5 第 3 點:編輯只是把自己的時段延後,不會因為跟自己原本的紀錄重疊而被誤判成衝突'
);

-- ⑤ 對照組:建立第二筆真正不相干的預約(乙師傅,14:00-14:30),然後把第一筆改到跟它真正重疊的
--    時段,應該要被擋下(證明 exclude 只排除自己,不是關掉所有衝突檢查)。
select id from create_booking(
  'b9000000-0000-4000-8000-000000000021', 'b9000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 14:00:00+08',
  '客戶乙', '0988000002'
) \gset second_

select throws_ok(
  format(
    $$select update_booking(
      '%s', 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 14:00:00+08',
      '客戶甲(衝突)', '0988000009'
    )$$,
    :'booking_id'::text
  ),
  'P0001', null,
  '規則 3.5 第 3 點:編輯排除的只有自己,跟「另一筆真正的預約」時段重疊仍然被擋下'
);

-- ⑥ 規則 2.1 邊界檢查在編輯時依然生效:改到 08:00(早於商家 09:00 開店),應該被擋下。
select throws_ok(
  format(
    $$select update_booking(
      '%s', 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 08:00:00+08',
      '客戶甲', '0988000009'
    )$$,
    :'booking_id'::text
  ),
  'P0001', null,
  '規則 3.5/2.1:編輯時依然套用商家營業時間邊界檢查'
);

-- ⑦ 規則 3.5 第 1 點:completed 狀態不能編輯。
select confirm_booking(:'second_id'::uuid);
select complete_booking(:'second_id'::uuid);

select throws_ok(
  format(
    $$select update_booking(
      '%s', 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 15:00:00+08',
      '客戶乙', '0988000002'
    )$$,
    :'second_id'::text
  ),
  'P0001', null,
  '規則 3.5 第 1 點:已完成的預約不能編輯'
);

-- ⑧ 規則 3.5 第 1 點:cancelled 狀態不能編輯。
select id from create_booking(
  'b9000000-0000-4000-8000-000000000021', 'b9000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 16:00:00+08',
  '客戶丙', '0988000003'
) \gset third_

select cancel_booking(:'third_id'::uuid, '測試取消');

select throws_ok(
  format(
    $$select update_booking(
      '%s', 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 16:30:00+08',
      '客戶丙', '0988000003'
    )$$,
    :'third_id'::text
  ),
  'P0001', null,
  '規則 3.5 第 1 點:已取消的預約不能編輯'
);

select pg_temp.test_clear_auth();

-- ⑨ 無權限的另一間商家管理員不能編輯別人商家的預約。
select pg_temp.test_set_auth('b9000000-0000-4000-8000-000000000002');

select throws_ok(
  format(
    $$select update_booking(
      '%s', 'b9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','b9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:10:00+08',
      '不相干的管理員嘗試編輯', '0988000009'
    )$$,
    :'booking_id'::text
  ),
  '42501', null,
  '無權限的商家管理員不能編輯別人商家的預約'
);

select pg_temp.test_clear_auth();

-- ⑩ 規則 3.5 第 4 點:編輯後關聯表整批重寫,確認舊的 booking_service_items 資料已經被換掉
--    (不是疊加,是刪除重建)。
select pg_temp.test_set_auth('b9000000-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from booking_service_items where booking_id = :'booking_id'::uuid),
  1,
  '規則 3.5 第 4 點:編輯後 booking_service_items 是整批重寫,只留下最新選取的 1 筆,不是疊加'
);

-- ⑪ 確認最新那筆確實是最後一次編輯選的服務項目(id 32,剪髮)。
select is(
  (select service_item_id from booking_service_items where booking_id = :'booking_id'::uuid),
  'b9000000-0000-4000-8000-000000000032'::uuid,
  '規則 3.5 第 4 點:重寫後的 booking_service_items 內容正確反映最後一次編輯的選擇'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
