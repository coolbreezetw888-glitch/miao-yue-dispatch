-- 模組 6(行事曆與預約核心引擎)— SPECS-INDEX #822:建單「客戶電話」格式驗證 + 分機號碼支援。
-- 對應 migration:supabase/migrations/20260927010000_normalize_phone_extension.sql。
--
-- 三件事都要驗:
--   A. private.normalize_phone 在「#」處截斷;**而且**對不帶分機的輸入行為完全沒變(正向對照,
--      沒有這組對照的話,「截斷」那條就算函式整個壞掉也可能剛好是綠的)。
--   B. private.is_valid_taiwan_phone 的規則表(跟 src/lib/validation.test.ts 用同一組例子,兩層規則
--      必須逐字對應)+ 內部函式的 EXECUTE 權限(supabase-permission-hygiene 規則 1)。
--   C. 端到端:create_booking / update_booking 擋格式錯誤、放行「市話 + 分機」並原樣保存;
--      get_members_by_phone / get_customer_related_bookings 帶分機也配得到(這是 #822 一定要一起修的
--      那條:以前分機會讓正規化後多出幾碼,永遠配不到)。
--
-- 故障注入紀錄(engineer 2026-09-27 實際做過,細節見交付回報):
--   ・在本機 Docker 庫把 normalize_phone 換回舊版(沒有 split_part 截斷)→ A1/A2/A8/C1/C10/C11 共 6 條轉紅,
--     A3~A7/A9 與 B/C 其餘正向對照全部仍綠(證明對照組真的分得出「截斷」與「沒截斷」);
--     `supabase db reset --local` 還原後 31/31 全綠。
begin;

select plan(31);

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
-- A. private.normalize_phone:在 # 處截斷 + 正向對照
-- =========================================================================
select is(private.normalize_phone('02-1234-5678#123'), '0212345678',
  'A1 帶分機:在 # 處截斷,只留分機前的號碼(以前會變成 0212345678123)');
select is(private.normalize_phone('0212345678#1234'), '0212345678',
  'A2 不帶分隔符號、只帶分機:一樣截斷');
select is(private.normalize_phone('0912-345-678'), '0912345678',
  'A3 正向對照:不帶分機時行為跟以前一樣(去掉連字號)');
select is(private.normalize_phone('(02) 1234 5678'), '0212345678',
  'A4 正向對照:括號/空白照樣去掉');
select is(private.normalize_phone('0912345678'), '0912345678',
  'A5 正向對照:純數字原樣回傳');
select is(private.normalize_phone(null), null,
  'A6 NULL → NULL(代表不比對)');
select is(private.normalize_phone(''), null,
  'A7 空字串 → NULL');
select is(private.normalize_phone('#123'), null,
  'A8 只有分機、沒有號碼 → NULL(不能拿分機去配別人的號碼)');
select is(private.normalize_phone('abc'), null,
  'A9 純英文 → NULL');

-- =========================================================================
-- B. private.is_valid_taiwan_phone:規則表 + ACL
-- =========================================================================
-- B1/B2 用「列出不符合預期的值」的寫法:一旦有值被誤擋/漏擋,diagnostic 會直接印出是哪一個。
select is(
  (select string_agg(v, ', ' order by v)
   from unnest(array[
     -- 手機
     '0912345678', '0900000000',
     -- 市話:使用者給的 13 個區碼逐一驗算(2 碼區碼+8 碼 / 2 碼區碼+7 碼 / 3 碼區碼+6 碼 / 4 碼區碼+5 碼)
     '0212345678', '0412345678', '0712345678',
     '031234567', '051234567', '061234567', '081234567',
     '037123456', '049123456', '089123456',
     '082312345', '082612345', '083612345',
     -- 分隔符號不強制
     '0912-345-678', '0912 345 678', '02-1234-5678', '(02) 1234-5678', '037-123456', '  0912345678  ',
     -- 市話 + 分機
     '0212345678#1234', '02-1234-5678#123', '037-123456#1'
   ]) v
   where not private.is_valid_taiwan_phone(v)),
  null,
  'B1 所有合法例子都通過(有列出來的就是被誤擋的)');

select is(
  (select string_agg(v, ', ' order by v)
   from unnest(array[
     -- 正式庫實查到的髒資料型態
     '123', repeat('0', 40), repeat('0912345678', 4),
     -- 空 / 非數字
     '', '   ', 'abcdefghij', '電話', '0912abc678',
     -- 手機碼數不對
     '091234567', '09123456789',
     -- 市話碼數不對
     '02123456', '02123456789',
     -- 不是 0 開頭 / 第二碼不在規則內 / 國碼
     '1234567890', '0012345678', '0112345678', '+886912345678',
     -- 分機位置或內容不對
     '0912345678#123', '0212345678#', '0212345678#12a', '#123', '0212345678#1234567'
   ]) v
   where private.is_valid_taiwan_phone(v)),
  null,
  'B2 所有不合法例子都被擋(有列出來的就是漏擋的)');

select is(private.is_valid_taiwan_phone(null), false,
  'B3 NULL → false(是否允許留空由呼叫端決定)');
select is(private.is_valid_taiwan_phone('0912345678'), true,
  'B4 正向對照:單獨叫一次確認函式會回 true');

select ok(not has_function_privilege('anon', 'private.is_valid_taiwan_phone(text)', 'execute'),
  'B5 is_valid_taiwan_phone:anon 不能直接呼叫');
select ok(not has_function_privilege('authenticated', 'private.is_valid_taiwan_phone(text)', 'execute'),
  'B6 is_valid_taiwan_phone:authenticated 不能直接呼叫(只由 SECURITY DEFINER 的 RPC 內部呼叫)');
select ok(not has_function_privilege('public', 'private.is_valid_taiwan_phone(text)', 'execute'),
  'B7 is_valid_taiwan_phone:PUBLIC 不能直接呼叫');
select ok(has_function_privilege('service_role', 'private.is_valid_taiwan_phone(text)', 'execute'),
  'B8 正向對照:service_role 有 execute(證明 B5~B7 的查詢方法分得出「有/沒有權限」)');

-- =========================================================================
-- C. 端到端:fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('f8220000-0000-4000-8000-000000000001', 'pgtap-m6-phone-admin@test.local');

insert into groups (id) values ('f8220000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('f8220000-0000-4000-8000-000000000021', 'f8220000-0000-4000-8000-000000000011', '客戶電話格式測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('f8220000-0000-4000-8000-000000000021', 'f8220000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f8220000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f8220000-0000-4000-8000-000000000031', 'f8220000-0000-4000-8000-000000000021', '洗髮', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('f8220000-0000-4000-8000-000000000041', 'f8220000-0000-4000-8000-000000000021', '服務人員', '0901000101', true);

insert into payment_methods (id, merchant_id, name) values
  ('f8220000-0000-4000-8000-000000000071', 'f8220000-0000-4000-8000-000000000021', '現場付款');

select pg_temp.test_set_auth('f8220000-0000-4000-8000-000000000001');

-- 會員存的是「不帶分機」的市話(客服平常就是這樣存的)。
select id from create_member('f8220000-0000-4000-8000-000000000021', '市話會員', '02-1234-5678') \gset landline_member_

select ok(
  exists (
    select 1 from jsonb_array_elements(get_members_by_phone('f8220000-0000-4000-8000-000000000021', '02-1234-5678#123')) elem
    where (elem ->> 'member_id')::uuid = :'landline_member_id'::uuid
  ),
  'C1 get_members_by_phone:建單頁輸入「帶分機」的電話,配得到存成 02-1234-5678 的會員(#822 的主角)');

select ok(
  exists (
    select 1 from jsonb_array_elements(get_members_by_phone('f8220000-0000-4000-8000-000000000021', '0212345678')) elem
    where (elem ->> 'member_id')::uuid = :'landline_member_id'::uuid
  ),
  'C2 正向對照:不帶分機、不帶分隔符號照樣配得到');

select ok(
  not exists (
    select 1 from jsonb_array_elements(get_members_by_phone('f8220000-0000-4000-8000-000000000021', '0212345679')) elem
    where (elem ->> 'member_id')::uuid = :'landline_member_id'::uuid
  ),
  'C3 負向對照:號碼差一碼就配不到(證明 C1/C2 不是「什麼都配得到」)');

-- C4~C7:create_booking 擋格式錯誤。
select throws_like(
  $$select create_booking(
      p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '格式錯誤', p_customer_phone => '123',
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071')$$,
  '%客戶電話格式不正確%',
  'C4 create_booking:3 碼被擋下(正式庫實查到的髒資料型態)');

select throws_like(
  $$select create_booking(
      p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '格式錯誤', p_customer_phone => repeat('0', 40),
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071')$$,
  '%客戶電話格式不正確%',
  'C5 create_booking:40 碼被擋下(正式庫實查到的髒資料型態)');

select throws_like(
  $$select create_booking(
      p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '格式錯誤', p_customer_phone => 'abcdefghij',
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071')$$,
  '%客戶電話格式不正確%',
  'C6 create_booking:純英文被擋下');

select throws_like(
  $$select create_booking(
      p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '格式錯誤', p_customer_phone => '091234567',
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071')$$,
  '%客戶電話格式不正確%',
  'C7 create_booking:09 開頭只有 9 碼被擋下');

-- C8:市話 + 分機建單成功,而且原樣保存(create_booking 只 btrim,不改寫格式)。
select id from create_booking(
  p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_staff_id => 'f8220000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '市話分機客戶', p_customer_phone => '02-1234-5678#123',
  p_payment_method_id => 'f8220000-0000-4000-8000-000000000071',
  p_member_id => :'landline_member_id'::uuid
) \gset ext_booking_

select is(
  (select customer_phone from bookings where id = :'ext_booking_id'::uuid),
  '02-1234-5678#123',
  'C8 create_booking:市話 + 分機建單成功,customer_phone 原樣保存(分機沒有被吃掉)');

select lives_ok(
  $$select create_booking(
      p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 11:00:00+08', p_customer_name => '手機客戶', p_customer_phone => '0912-345-678',
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071')$$,
  'C9 正向對照:帶連字號的手機建單成功(分隔符號不強制)');

-- C10/C11:訂單詳情頁「相關訂單」查詢(get_customer_related_bookings)也走 normalize_phone。
-- 這間店只有 C8 那筆是 02 的電話,所以配到的數量就是 1;C9 那筆是 0912 不會混進來。
select is(
  (select count(*)::int from get_customer_related_bookings(
     p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_customer_phone => '0212345678')),
  1,
  'C10 get_customer_related_bookings:用不帶分機的電話,能找到存成「02-1234-5678#123」的訂單');

select is(
  (select count(*)::int from get_customer_related_bookings(
     p_merchant_id => 'f8220000-0000-4000-8000-000000000021', p_customer_phone => '02-1234-5678#999')),
  1,
  'C11 get_customer_related_bookings:分機不同也視為同一位客戶(分機不參與比對)');

-- C12~C14:update_booking 同一條規則。
select throws_like(
  format($f$select update_booking(
      p_booking_id => %L, p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '市話分機客戶', p_customer_phone => '123',
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071', p_member_id => %L)$f$,
    :'ext_booking_id', :'landline_member_id'),
  '%客戶電話格式不正確%',
  'C12 update_booking:改成 3 碼被擋下');

select lives_ok(
  format($f$select update_booking(
      p_booking_id => %L, p_staff_id => 'f8220000-0000-4000-8000-000000000041',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f8220000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
      p_start_at => '2026-12-15 10:00:00+08', p_customer_name => '市話分機客戶', p_customer_phone => '037-123456',
      p_payment_method_id => 'f8220000-0000-4000-8000-000000000071', p_member_id => %L)$f$,
    :'ext_booking_id', :'landline_member_id'),
  'C13 正向對照:update_booking 改成 9 碼市話(苗栗 037)成功');

select is(
  (select customer_phone from bookings where id = :'ext_booking_id'::uuid),
  '037-123456',
  'C14 update_booking:改後的市話原樣保存');

select pg_temp.test_clear_auth();

select * from finish();
rollback;
