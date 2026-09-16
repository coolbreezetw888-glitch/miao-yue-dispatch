-- 模組 5 規則 2.4(嚴格工時衝突檢查開關)、2.6(跨商家電話號碼比對,不限同集團)。
-- 這是本模組風險最高的部分,對應規格書 3.3 第 5、6 步跟規格書第七節「必測項目」。
--
-- 情境布置:兩間不同商家(不同集團)各自有一位服務人員,電話號碼格式不同但正規化後相同
-- (0912-345-678 vs 0912345678),藉此驗證電話正規化比對邏輯。兩間商家都設定週二整天營業
-- (00:00-23:59,避免邊界檢查干擾,聚焦測試重疊/電話比對本身),服務人員都 no_time_slot_limit=true
-- (不用另外布置 staff_availability_windows)。
begin;

select plan(8);

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
  ('b2000000-0000-4000-8000-000000000001', 'pgtap-m5-store1-admin@test.local'),
  ('b2000000-0000-4000-8000-000000000002', 'pgtap-m5-store2-admin@test.local');

insert into groups (id) values
  ('b2000000-0000-4000-8000-000000000011'),
  ('b2000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type)
values
  ('b2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000011', '一店', 'in_store_beauty'),
  ('b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000012', '二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('b2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000001'),
  ('b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('b2000000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59'),
  ('b2000000-0000-4000-8000-000000000022', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('b2000000-0000-4000-8000-000000000031', 'b2000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 60),
  ('b2000000-0000-4000-8000-000000000032', 'b2000000-0000-4000-8000-000000000022', '洗髮', 300, 'primary', 60);

-- 一店的 A 師傅,電話格式:0912-345-678。二店的 A 師傅(同一人),電話格式:0912345678
-- (正規化後相同)。兩人都 no_time_slot_limit=true,避免另外布置時段。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b2000000-0000-4000-8000-000000000041', 'b2000000-0000-4000-8000-000000000021', 'A師傅(一店)', '0912-345-678', true),
  ('b2000000-0000-4000-8000-000000000042', 'b2000000-0000-4000-8000-000000000022', 'A師傅(二店)', '0912345678', true);

-- 一店另一位師傅 B,電話跟 A 完全不同,用來驗證「電話不同不互相影響」。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b2000000-0000-4000-8000-000000000043', 'b2000000-0000-4000-8000-000000000021', 'B師傅(一店)', '0922-000-000', true);

-- 二店另一位師傅 C,電話為 NULL,用來驗證「任一邊電話為 NULL 一律不比對」。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b2000000-0000-4000-8000-000000000044', 'b2000000-0000-4000-8000-000000000022', 'C師傅(二店,無電話)', null, true);
-- 一店也放一位電話為 NULL 的 D 師傅,對照 C。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('b2000000-0000-4000-8000-000000000045', 'b2000000-0000-4000-8000-000000000021', 'D師傅(一店,無電話)', null, true);

-- ① 一店管理員先幫 A 師傅(一店)建立 2026-09-22 10:00-11:00 的預約。
select pg_temp.test_set_auth('b2000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000041',
    'b2000000-0000-4000-8000-000000000031', '2026-09-22 10:00:00+08',
    '一店客戶', '0933000001'
  )$$,
  '一店管理員幫 A 師傅(一店)建立預約成功'
);

select pg_temp.test_clear_auth();

-- ② 規則 2.6:二店管理員嘗試幫 A 師傅(二店,電話正規化後跟一店 A 師傅相同)建立同時段重疊的預約,
--    strict_conflict_check 預設開啟(查無資料視為 true),應該被擋下,且不透露對方商家/客戶細節。
select pg_temp.test_set_auth('b2000000-0000-4000-8000-000000000002');

select throws_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000042',
    'b2000000-0000-4000-8000-000000000032', '2026-09-22 10:30:00+08',
    '二店客戶', '0933000002'
  )$$,
  'P0001', null,
  '規則 2.6:電話正規化後相同的跨商家服務人員,時段重疊被擋下'
);

-- ③ 不重疊的時段(同一天但錯開,14:00-15:00 跟前一筆 10:00-11:00 不重疊)應該可以正常建立,
--    證明擋下只針對真正重疊的時段(兩間商家都只設定了週二的營業時間,所以刻意留在同一天測試)。
select lives_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000042',
    'b2000000-0000-4000-8000-000000000032', '2026-09-22 14:00:00+08',
    '二店客戶2', '0933000003'
  )$$,
  '規則 2.6:不重疊的時段,建立成功'
);

select pg_temp.test_clear_auth();

-- ④ 規則 2.6:電話不同的兩位服務人員(一店 A vs 一店 B)不互相影響——同商家但不同人,
--    先驗證「同一時段、不同服務人員」不會誤判成衝突。
select pg_temp.test_set_auth('b2000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000043',
    'b2000000-0000-4000-8000-000000000031', '2026-09-22 10:00:00+08',
    '一店客戶B', '0933000004'
  )$$,
  '規則 2.6:電話不同的服務人員,即使同時段,不互相影響,建立成功'
);

-- ⑤ 電話為 NULL 的兩邊(D 師傅 vs C 師傅)不互相比對——先幫 D 師傅建一筆預約。
select lives_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000045',
    'b2000000-0000-4000-8000-000000000031', '2026-09-22 14:00:00+08',
    '一店客戶D', '0933000005'
  )$$,
  '電話為 NULL 的服務人員 D 建立預約成功'
);

select pg_temp.test_clear_auth();

-- ⑥ 二店幫電話同樣是 NULL 的 C 師傅在同一時段建立預約,不應該被擋下(任一邊 NULL 一律不比對)。
select pg_temp.test_set_auth('b2000000-0000-4000-8000-000000000002');

select lives_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000044',
    'b2000000-0000-4000-8000-000000000032', '2026-09-22 14:00:00+08',
    '二店客戶C', '0933000006'
  )$$,
  '規則 2.6:兩邊電話都是 NULL,不比對、不互相影響,建立成功'
);

select pg_temp.test_clear_auth();

-- ⑦ 規則 2.4:把一店的 strict_conflict_check 關閉,同一位師傅(一店 A)同時段應該允許重疊。
update merchant_feature_flags
set enabled = false
where merchant_id = 'b2000000-0000-4000-8000-000000000021' and feature_key = 'strict_conflict_check';

-- 先確認這筆設定真的寫進去(如果原本沒有這筆列,insert 一筆)。
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
select 'b2000000-0000-4000-8000-000000000021', 'strict_conflict_check', false
where not exists (
  select 1 from merchant_feature_flags
  where merchant_id = 'b2000000-0000-4000-8000-000000000021' and feature_key = 'strict_conflict_check'
);

select pg_temp.test_set_auth('b2000000-0000-4000-8000-000000000001');

select lives_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000021', 'b2000000-0000-4000-8000-000000000041',
    'b2000000-0000-4000-8000-000000000031', '2026-09-22 10:00:00+08',
    '一店客戶重疊', '0933000007'
  )$$,
  '規則 2.4:strict_conflict_check 關閉時,同一位服務人員同時段允許重疊'
);

select pg_temp.test_clear_auth();

-- ⑧ 規則 2.4 對照組:二店沒有關閉開關(仍是預設開啟),同一位師傅(二店 A)同時段應該仍被擋下。
select pg_temp.test_set_auth('b2000000-0000-4000-8000-000000000002');

select throws_ok(
  $$select create_booking(
    'b2000000-0000-4000-8000-000000000022', 'b2000000-0000-4000-8000-000000000042',
    'b2000000-0000-4000-8000-000000000032', '2026-09-22 10:30:00+08',
    '二店客戶重疊', '0933000008'
  )$$,
  'P0001', null,
  '規則 2.4 對照組:strict_conflict_check 未關閉(預設開啟)的商家,重疊仍被擋下'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
