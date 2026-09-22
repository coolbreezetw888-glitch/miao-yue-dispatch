-- 模組 5 規則 2.9(bookings 狀態機:合法/非法轉換)、2.10(取消/完成不算危險操作,沒有 DELETE 政策)、
-- 3.4(cancel_booking 只接受 p_booking_id,merchant_id 由資料庫內部查出)、3.5(complete_booking 同理)。
--
-- 2026-09-17 建單功能擴充更新(對應規格書 2.4/決策記錄 5、規則 3.4):
--   - create_booking 建立後狀態改成 pending_confirmation(不再直接是 accepted)。
--   - 新增 confirm_booking:只接受 pending_confirmation,且要有 orders 權限。
--   - complete_booking 只接受 accepted(pending_confirmation 直接呼叫要被擋下,不能跳過確認關卡)。
--   - cancel_booking 放寬成 pending_confirmation/accepted 都能取消,兩種來源狀態各測一次。
begin;

select plan(15);

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
  ('b3000000-0000-4000-8000-000000000001', 'pgtap-m5-admin@test.local'),
  ('b3000000-0000-4000-8000-000000000002', 'pgtap-m5-other-admin@test.local');

insert into groups (id) values
  ('b3000000-0000-4000-8000-000000000011'),
  ('b3000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('b3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-000000000011', '狀態機測試商家', 'in_store_beauty'),
  ('b3000000-0000-4000-8000-000000000023', 'b3000000-0000-4000-8000-000000000012', '不相干的另一間商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('b3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-000000000001'),
  ('b3000000-0000-4000-8000-000000000023', 'b3000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('b3000000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('b3000000-0000-4000-8000-000000000031', 'b3000000-0000-4000-8000-000000000021', '按摩', 800, 'primary', 60);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('b3000000-0000-4000-8000-000000000041', 'b3000000-0000-4000-8000-000000000021', '服務人員', '0901000101', true);

select pg_temp.test_set_auth('b3000000-0000-4000-8000-000000000001');

-- 建立第一筆預約(狀態應直接是 pending_confirmation,決策記錄 5),用 \gset 把 id/status 存成 psql 變數。
select id, status from create_booking(
  'b3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  '客戶甲', '0955000001'
) \gset first_

select is(:'first_status'::text, 'pending_confirmation'::text, '決策記錄 5:手動建單這次改成先進 pending_confirmation 狀態,不再直接進 accepted');

select pg_temp.test_clear_auth();

-- ① 沒有權限的商家管理員(另一間不相干商家的管理員)不能取消/完成/確認別人的預約。
select pg_temp.test_set_auth('b3000000-0000-4000-8000-000000000002');

select throws_ok(
  format($$select cancel_booking('%s', '不相干商家的管理員嘗試取消')$$, :'first_id'::text),
  '42501', null,
  '無權限的商家管理員不能取消別人商家的預約'
);

select throws_ok(
  format($$select complete_booking('%s')$$, :'first_id'::text),
  '42501', null,
  '無權限的商家管理員不能標記完成別人商家的預約'
);

select throws_ok(
  format($$select confirm_booking('%s')$$, :'first_id'::text),
  '42501', null,
  '無權限的商家管理員不能確認別人商家的預約'
);

select pg_temp.test_clear_auth();

-- ② 規則 3.4 第 3 點:不開放跳過中間狀態——pending_confirmation 不能直接標記完成,一定要先確認。
select pg_temp.test_set_auth('b3000000-0000-4000-8000-000000000001');

select throws_ok(
  format($$select complete_booking('%s')$$, :'first_id'::text),
  'P0001', null,
  '規則 3.4:pending_confirmation 不能跳過確認直接標記完成'
);

-- ③ 決策記錄 5:confirm_booking 把 pending_confirmation 轉成 accepted,商家自己的管理員可以操作
--    (包含「自己建立、自己確認」的情境,這裡就是同一位管理員)。
select is(
  (select status from confirm_booking(:'first_id'::uuid)),
  'accepted',
  '決策記錄 5:confirm_booking 正確把 pending_confirmation 轉成 accepted'
);

-- ④ confirm_booking 對已經是 accepted 的預約再呼叫一次應該被擋下(只接受 pending_confirmation)。
select throws_ok(
  format($$select confirm_booking('%s')$$, :'first_id'::text),
  'P0001', null,
  '規則 3.4:已經是 accepted 的預約不能重複確認'
);

-- ⑤ 規則 2.9:accepted -> completed 合法轉換,商家自己的管理員可以標記完成。
select is(
  (select status from complete_booking(:'first_id'::uuid)),
  'completed',
  '規則 2.9:accepted -> completed 合法轉換成功'
);

-- ⑥ 規則 2.9:completed 是終止狀態,不能再取消。
select throws_ok(
  format($$select cancel_booking('%s', '不應該成功')$$, :'first_id'::text),
  'P0001', null,
  '規則 2.9:已完成的預約不能再取消'
);

-- ⑦ 規則 2.9:completed 也不能再標記一次完成。
select throws_ok(
  format($$select complete_booking('%s')$$, :'first_id'::text),
  'P0001', null,
  '規則 2.9:已完成的預約不能重複標記完成'
);

-- ⑧ 決策記錄 5 第 4 點(新行為):另建一筆預約,測試 pending_confirmation -> cancelled 直接取消
--    合法轉換(這是這次擴充放寬的行為,原本只有 accepted 能取消)。
select id, status from create_booking(
  'b3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 14:00:00+08',
  '客戶乙', '0955000002'
) \gset second_

select is(
  (select status from cancel_booking(:'second_id', '客戶臨時取消(待確認階段)')),
  'cancelled',
  '決策記錄 5 第 4 點:pending_confirmation -> cancelled 直接取消成功(新放寬的行為)'
);

-- ⑨ 規則 2.9:cancelled 是終止狀態,不能再標記完成。
select throws_ok(
  format($$select complete_booking('%s')$$, :'second_id'::text),
  'P0001', null,
  '規則 2.9:已取消的預約不能標記完成'
);

-- ⑩ 規則 2.9:cancelled 也不能再取消一次。
select throws_ok(
  format($$select cancel_booking('%s', '重複取消')$$, :'second_id'::text),
  'P0001', null,
  '規則 2.9:已取消的預約不能重複取消'
);

-- ⑪ 對照組:accepted -> cancelled 這條原本就存在的合法轉換,這次擴充後依然要成立
--    (第三筆預約:先確認再取消)。
select id from create_booking(
  'b3000000-0000-4000-8000-000000000021', 'b3000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id','b3000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 16:00:00+08',
  '客戶丙', '0955000003'
) \gset third_

select confirm_booking(:'third_id'::uuid);

select is(
  (select status from cancel_booking(:'third_id', '確認後又取消')),
  'cancelled',
  '對照組:accepted -> cancelled 合法轉換依然成立(原有行為,這次擴充沒有破壞)'
);

-- ⑫ 規則 2.10:bookings 沒有 DELETE 政策,真刪除應該 0 筆受影響(RLS 擋下,不是報錯,是靜默 0 筆)。
delete from bookings where id = :'second_id';

select is(
  (select count(*)::int from bookings where id = :'second_id'::uuid),
  1,
  '規則 2.10:bookings 沒有 DELETE 政策,對已取消的預約執行 DELETE 沒有真的刪掉任何資料'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
