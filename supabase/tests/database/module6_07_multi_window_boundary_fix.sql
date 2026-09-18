-- 模組 6(訂單管理,第二批)§5.3 修正驗證:主腦複查抓到的真正邏輯漏洞。
--
-- 背景:20260919100200_day_override_third_layer.sql 版本的 private.check_staff_booking_slot,
-- 對「查無單日例外」的格子是逐格獨立檢查「存在某一組 staff_availability_windows 覆蓋這一格」,
-- 而不是要求「整個沒有例外覆蓋的連續區段,必須被同一組時段完整涵蓋」——這導致「同一天有兩組
-- 相鄰時段」(既有系統本來就支援,例如師傅上午 09:00-10:00、下午 10:00-12:00 分兩筆設定)時,
-- 一筆橫跨兩組時段交界的預約(例如 09:30-10:30),即使沒有任何一組時段能單獨涵蓋整段,也會
-- 被誤判通過。20260919100600_day_override_third_layer_multi_window_fix.sql 修正了這個問題。
--
-- 這份測試檔案完全不碰 module6_04_day_override_third_layer.sql(PART A/PART B 維持原樣重新跑,
-- 見 automated-testing 流程,兩份檔案各自獨立驗證,互不干擾),只新增這次修正專屬的情境:
--   1. 橫跨兩組相鄰時段交界的預約,必須被擋下(重現漏洞的具體案例)。
--   2. 完整落在其中一組時段內的預約,必須維持可以成功建立(確認沒有過度修正、連帶擋掉正常情境)。
begin;

select plan(3);

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
  ('c5000000-0000-4000-8000-000000000001', 'pgtap-m6-multiwindow-admin@test.local');

insert into groups (id) values ('c5000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000010', '多組時段交界測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000001');

-- 商家週二 09:00-18:00 營業。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('c5000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c5000000-0000-4000-8000-000000000030', 'c5000000-0000-4000-8000-000000000020', '一小時服務', 500, 'primary', 60);

-- 服務人員週二設定兩組相鄰時段:09:00-10:00、10:00-12:00,中間沒有空檔,也完全沒有設定任何
-- staff_availability_overrides(第三層完全沒有例外資料)——這正是重現步驟要求的情境布置。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('c5000000-0000-4000-8000-000000000040', 'c5000000-0000-4000-8000-000000000020', '服務人員A(雙時段)', null, false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('c5000000-0000-4000-8000-000000000040', 2, '09:00', '10:00'),
  ('c5000000-0000-4000-8000-000000000040', 2, '10:00', '12:00');

select pg_temp.test_set_auth('c5000000-0000-4000-8000-000000000001');

-- 1. 重現步驟本體:09:30-10:30 橫跨兩組相鄰時段的交界,任何一組單獨都不滿足「完整涵蓋這一段」
--    (09:00-10:00 的 end_time=10:00 < 10:30;10:00-12:00 的 start_time=10:00 > 09:30),
--    修正前的漏洞會誤判放行,修正後應該被擋下。
select throws_ok(
  $$select create_booking(
    'c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c5000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 09:30:00+08',
    '交界測試客戶', '0921000201'
  )$$,
  'P0001', null,
  '橫跨兩組相鄰時段交界(09:30-10:30)的預約,修正後應該被擋下'
);

-- 2. 對照組:09:00-10:00 剛好完整落在第一組時段內,應該維持可以成功建立(確認沒有過度修正)。
select lives_ok(
  $$select create_booking(
    'c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c5000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 09:00:00+08',
    '第一組時段對照客戶', '0921000202'
  )$$,
  '完整落在第一組時段內(09:00-10:00)的預約,應該可以成功建立'
);

-- 3. 對照組:10:00-11:00 剛好完整落在第二組時段內,應該維持可以成功建立(確認沒有過度修正)。
select lives_ok(
  $$select create_booking(
    'c5000000-0000-4000-8000-000000000020', 'c5000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c5000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '第二組時段對照客戶', '0921000203'
  )$$,
  '完整落在第二組時段內(10:00-11:00)的預約,應該可以成功建立'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
