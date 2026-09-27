-- 模組 12(資料匯入/報表匯出)— SPECS-INDEX #824:CSV 匯入的電話欄位套用 #822 的格式驗證。
-- 對應 migration:supabase/migrations/20260928040000_import_phone_validation.sql。
--
-- 要驗的四件事:
--   A. import_members_batch:「電話」有填且不合格 → 那一列 failed、進 error_report(白話中文、含填的值與
--      正確格式範例),其他列照常成功;留空仍然合法;合法的市話+分機原樣保存。**逐列回報,不整批失敗。**
--   B. 舊髒資料不動:資料庫裡既有的「123」會員(模擬 #822 之前留下的髒資料)一字不改;新 CSV 再送「123」
--      進來,insert_only 不會被當成「重複略過」、upsert_by_phone 也不會拿它去更新髒會員——兩者都是格式錯誤。
--      加上正向對照:合法電話的 upsert 路徑照常運作(證明不是整支函式壞掉才「沒更新」)。
--   C. import_historical_bookings_batch:同一條規則、同樣逐列回報;「缺少客戶電話」跟「格式不正確」是兩個
--      不同的訊息(檢查順序沒有被打亂)。
--   D. 權限衛生(supabase-permission-hygiene 規則 1):兩支匯入函式 create or replace 之後 ACL 沒有被放寬
--      (anon/PUBLIC 沒有 EXECUTE,authenticated 有 → 正向對照);is_valid_taiwan_phone 依然只有
--      service_role(這次呼叫它、沒有動它的權限)。
--
-- 故障注入紀錄(engineer 2026-09-28 實際做過,細節見交付回報):
--   ・在本機 Docker 庫把兩支匯入函式換回上一版(20260924020500 / 20260924040100,沒有格式檢查)
--     → 10/24 轉紅:A1(have (5,0,1):3 碼與 40 碼被建成會員、手機帶分機被當成 A1 的重複略過)、
--     A2/C2(error_report 為空)、A3/C3、A4(have 2)、B1(have (0,0,1):「123」被當成重複略過)、
--     B2(have (1,0,0):拿「123」去更新了會員)、C1(have (4,0))、C4(have 2)。
--     A5/A6/B4/C5/C6/D1~D8 全部仍綠(證明對照組真的分得出「有擋」與「沒擋」)。
--     B3 在舊版下**沒有**轉紅,原因是舊版已經先把 A 段的「A4三碼(123)」建進去,B2 的 limit 1 配到的是那一筆
--     而不是 B 段的髒會員 —— B3 的價值是「新版下髒資料不被碰」的守門,不是故障注入的偵測器,特此註明。
--     重新套用 20260928040000 之後 24/24 全綠。
begin;

select plan(24);

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
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('ec030000-0000-4000-8000-000000000001', 'pgtap-m1203-admin@test.local');

insert into groups (id) values ('ec030000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('ec030000-0000-4000-8000-000000000020', 'ec030000-0000-4000-8000-000000000010',
        '匯入電話格式測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('ec030000-0000-4000-8000-000000000020', 'ec030000-0000-4000-8000-000000000001');

insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('ec030000-0000-4000-8000-000000000041', 'ec030000-0000-4000-8000-000000000020',
   '匯入測試師傅', '0900001203', 'piece_rate');

select pg_temp.test_set_auth('ec030000-0000-4000-8000-000000000001');

-- =========================================================================
-- A. 會員匯入:一批 6 列,3 列合法(含留空)、3 列格式不合格 → 逐列回報
-- =========================================================================
select import_members_batch(
  'ec030000-0000-4000-8000-000000000020',
  'insert_only',
  jsonb_build_array(
    jsonb_build_object('row_number', 1, 'name', 'A1手機帶連字號', 'phone', '0912-345-678'),
    jsonb_build_object('row_number', 2, 'name', 'A2市話帶分機',   'phone', '02-1234-5678#123'),
    jsonb_build_object('row_number', 3, 'name', 'A3沒填電話',     'phone', ''),
    jsonb_build_object('row_number', 4, 'name', 'A4三碼',         'phone', '123'),
    jsonb_build_object('row_number', 5, 'name', 'A5四十碼',       'phone', repeat('0', 40)),
    jsonb_build_object('row_number', 6, 'name', 'A6手機帶分機',   'phone', '0912345678#123')
  )
) \gset opA_

select is(
  (select row(success_rows, failed_rows, skipped_duplicate_rows)::text
   from merchant_bulk_operations where id = :'opA_import_members_batch'::uuid),
  '(3,3,0)',
  'A1 會員匯入:3 列合法成功、3 列格式不合格失敗、0 列略過 —— 逐列回報,不是一列壞整批失敗');

select is(
  (select string_agg(e->>'row_number', ',' order by (e->>'row_number')::int)
   from merchant_bulk_operations o, jsonb_array_elements(o.error_report) e
   where o.id = :'opA_import_members_batch'::uuid),
  '4,5,6',
  'A2 error_report 精準指出第 4、5、6 列(3 碼 / 40 碼 / 手機帶分機),合法的 1~3 列沒有被誤列');

select ok(
  (select e->>'error_message' from merchant_bulk_operations o, jsonb_array_elements(o.error_report) e
   where o.id = :'opA_import_members_batch'::uuid and (e->>'row_number')::int = 4)
  like '「電話」欄位格式不正確(這一列填的是「123」)。%例如 0912345678%例如 02-1234-5678#123%',
  'A3 錯誤訊息是白話中文:講明「電話」欄位、這一列填的是「123」、以及正確格式長什麼樣(手機/市話/分機三個範例)');

select is(
  (select count(*)::int from members
   where merchant_id = 'ec030000-0000-4000-8000-000000000020'
     and name in ('A4三碼', 'A5四十碼', 'A6手機帶分機')),
  0,
  'A4 格式不合格的 3 列一筆都沒有被建成會員(#822 擋了前門、這次把 CSV 後門也關上)');

select is(
  (select phone from members
   where merchant_id = 'ec030000-0000-4000-8000-000000000020' and name = 'A2市話帶分機'),
  '02-1234-5678#123',
  'A5 正向對照:市話 + 分機是合法格式,建成會員而且原樣保存(分機沒被吃掉、分隔符號沒被改寫)');

select ok(
  exists (select 1 from members
          where merchant_id = 'ec030000-0000-4000-8000-000000000020' and name = 'A3沒填電話' and phone is null),
  'A6 正向對照:電話留空的列照常建成會員(#618 之後會員電話是選填,格式檢查只在「有填」時做)');

-- =========================================================================
-- B. 舊髒資料不動 + insert_only / upsert_by_phone 對不合格電話的行為
-- =========================================================================
-- 模擬 #822 之前留下的髒資料:create_member 後端沒有格式檢查(#822 刻意沒動它),所以可以直接建出「123」。
select id from create_member('ec030000-0000-4000-8000-000000000020', '既有髒會員', '123') \gset dirty_member_

select import_members_batch(
  'ec030000-0000-4000-8000-000000000020',
  'insert_only',
  jsonb_build_array(jsonb_build_object('row_number', 1, 'name', 'B1又送123', 'phone', '123'))
) \gset opB1_

select is(
  (select row(success_rows, failed_rows, skipped_duplicate_rows)::text
   from merchant_bulk_operations where id = :'opB1_import_members_batch'::uuid),
  '(0,1,0)',
  'B1 insert_only:CSV 再送「123」進來,是「格式錯誤失敗」而不是「電話重複略過」(格式檢查在找既有會員之前)');

select import_members_batch(
  'ec030000-0000-4000-8000-000000000020',
  'upsert_by_phone',
  jsonb_build_array(jsonb_build_object('row_number', 1, 'name', 'B2想改名', 'phone', '123'))
) \gset opB2_

select is(
  (select row(success_rows, failed_rows, skipped_duplicate_rows)::text
   from merchant_bulk_operations where id = :'opB2_import_members_batch'::uuid),
  '(0,1,0)',
  'B2 upsert_by_phone:CSV 送「123」也是格式錯誤失敗,不會拿它去更新那位髒會員');

select is(
  (select row(name, phone)::text from members where id = :'dirty_member_id'::uuid),
  '(既有髒會員,123)',
  'B3 舊髒資料一字沒動(使用者裁決「舊的髒資料可以不管他」:不清、不改、也不被這次匯入覆寫)');

-- 先記下 A1 那位會員的 id:upsert 之後 update_member 會把 phone 覆寫成 CSV 這次給的寫法(0912345678),
-- 用舊的 phone 字串查會查不到,所以用 id 查。
select id from members
where merchant_id = 'ec030000-0000-4000-8000-000000000020' and name = 'A1手機帶連字號' \gset a1_member_

select import_members_batch(
  'ec030000-0000-4000-8000-000000000020',
  'upsert_by_phone',
  jsonb_build_array(jsonb_build_object('row_number', 1, 'name', 'A1改名成功', 'phone', '0912345678'))
) \gset opB4_

select is(
  (select row(
     (select success_rows from merchant_bulk_operations where id = :'opB4_import_members_batch'::uuid),
     (select name from members where id = :'a1_member_id'::uuid)
   )::text),
  '(1,A1改名成功)',
  'B4 正向對照:合法電話(不帶連字號)照樣配到 A1 那位「0912-345-678」會員並更新成功 —— upsert 路徑沒有被這次改動弄壞');

-- =========================================================================
-- C. 歷史訂單匯入:同一條規則、同樣逐列回報
-- =========================================================================
select import_historical_bookings_batch(
  'ec030000-0000-4000-8000-000000000020',
  jsonb_build_array(
    jsonb_build_object(
      'row_number', 1, 'customer_name', 'C1手機', 'customer_phone', '0955120301',
      'staff_id', 'ec030000-0000-4000-8000-000000000041',
      'start_at', '2024-05-01T10:00:00+08:00', 'status', '已完成', 'final_amount', 1000
    ),
    jsonb_build_object(
      'row_number', 2, 'customer_name', 'C2市話帶括號分機', 'customer_phone', '(02) 1234-5678#99',
      'staff_id', 'ec030000-0000-4000-8000-000000000041',
      'start_at', '2024-05-02T10:00:00+08:00', 'status', '已完成', 'final_amount', 1000
    ),
    jsonb_build_object(
      'row_number', 3, 'customer_name', 'C3三碼', 'customer_phone', '123',
      'staff_id', 'ec030000-0000-4000-8000-000000000041',
      'start_at', '2024-05-03T10:00:00+08:00', 'status', '已完成', 'final_amount', 1000
    ),
    jsonb_build_object(
      'row_number', 4, 'customer_name', 'C4純英文', 'customer_phone', 'abcdefghij',
      'staff_id', 'ec030000-0000-4000-8000-000000000041',
      'start_at', '2024-05-04T10:00:00+08:00', 'status', '已完成', 'final_amount', 1000
    )
  )
) \gset opC_

select is(
  (select row(success_rows, failed_rows)::text
   from merchant_bulk_operations where id = :'opC_import_historical_bookings_batch'::uuid),
  '(2,2)',
  'C1 歷史訂單匯入:2 列合法成功、2 列格式不合格失敗 —— 逐列回報,不整批失敗');

select is(
  (select string_agg(e->>'row_number', ',' order by (e->>'row_number')::int)
   from merchant_bulk_operations o, jsonb_array_elements(o.error_report) e
   where o.id = :'opC_import_historical_bookings_batch'::uuid),
  '3,4',
  'C2 error_report 精準指出第 3、4 列');

select ok(
  (select e->>'error_message' from merchant_bulk_operations o, jsonb_array_elements(o.error_report) e
   where o.id = :'opC_import_historical_bookings_batch'::uuid and (e->>'row_number')::int = 3)
  like '「客戶電話」欄位格式不正確(這一列填的是「123」)。%例如 0912345678%例如 02-1234-5678 或 037-123456%例如 02-1234-5678#123%',
  'C3 錯誤訊息是白話中文:講明「客戶電話」欄位、這一列填的是「123」、以及三種正確格式範例');

select is(
  (select count(*)::int from bookings
   where merchant_id = 'ec030000-0000-4000-8000-000000000020' and customer_name in ('C3三碼', 'C4純英文')),
  0,
  'C4 格式不合格的 2 列一筆訂單都沒有被寫進 bookings(這支函式是直接 insert、不走 create_booking,#822 原本管不到)');

select is(
  (select customer_phone from bookings
   where merchant_id = 'ec030000-0000-4000-8000-000000000020' and customer_name = 'C2市話帶括號分機'),
  '(02) 1234-5678#99',
  'C5 正向對照:「(02) 1234-5678#99」是合法格式(分隔符號不強制、分機 1~6 碼),匯入成功且原樣保存');

-- 檢查順序沒被打亂:沒填電話仍然是既有的「缺少必填欄位」訊息,不是格式錯誤。
select import_historical_bookings_batch(
  'ec030000-0000-4000-8000-000000000020',
  jsonb_build_array(jsonb_build_object(
    'row_number', 1, 'customer_name', 'C6沒填電話', 'customer_phone', '',
    'staff_id', 'ec030000-0000-4000-8000-000000000041',
    'start_at', '2024-05-06T10:00:00+08:00', 'status', '已完成', 'final_amount', 1000
  ))
) \gset opC6_

select ok(
  (select e->>'error_message' from merchant_bulk_operations o, jsonb_array_elements(o.error_report) e
   where o.id = :'opC6_import_historical_bookings_batch'::uuid) = '缺少必填欄位：客戶電話',
  'C6 沒填客戶電話 → 還是既有的「缺少必填欄位：客戶電話」,格式檢查排在非空檢查之後,沒有把兩種錯誤混在一起');

select pg_temp.test_clear_auth();

-- =========================================================================
-- D. 權限衛生:create or replace 之後 ACL 沒有被放寬;is_valid_taiwan_phone 沒有被開權限
-- =========================================================================
select ok(not has_function_privilege('anon', 'public.import_members_batch(uuid, text, jsonb)', 'execute'),
  'D1 import_members_batch:anon 不能呼叫');
select ok(not has_function_privilege('public', 'public.import_members_batch(uuid, text, jsonb)', 'execute'),
  'D2 import_members_batch:PUBLIC 不能呼叫(create or replace 不會自動保留 revoke,所以要再驗一次)');
select ok(not has_function_privilege('anon', 'public.import_historical_bookings_batch(uuid, jsonb)', 'execute'),
  'D3 import_historical_bookings_batch:anon 不能呼叫');
select ok(not has_function_privilege('public', 'public.import_historical_bookings_batch(uuid, jsonb)', 'execute'),
  'D4 import_historical_bookings_batch:PUBLIC 不能呼叫');
select ok(has_function_privilege('authenticated', 'public.import_members_batch(uuid, text, jsonb)', 'execute'),
  'D5 正向對照:authenticated 有 execute(函式內部再用 is_merchant_admin 把關),證明 D1/D2 的查詢方法分得出有/沒有');
select ok(has_function_privilege('authenticated', 'public.import_historical_bookings_batch(uuid, jsonb)', 'execute'),
  'D6 正向對照:authenticated 有 execute,證明 D3/D4 的查詢方法分得出有/沒有');
select ok(not has_function_privilege('authenticated', 'private.is_valid_taiwan_phone(text)', 'execute'),
  'D7 is_valid_taiwan_phone:authenticated 依然不能直接呼叫(這次只是多了兩個 SECURITY DEFINER 呼叫端,沒有動它的權限)');
select ok(has_function_privilege('service_role', 'private.is_valid_taiwan_phone(text)', 'execute'),
  'D8 正向對照:service_role 有 execute');

select * from finish();

rollback;
