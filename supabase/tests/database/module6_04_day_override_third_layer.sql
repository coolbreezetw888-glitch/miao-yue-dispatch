-- 模組 6(訂單管理,第二批)§5.3:單日例外第三層疊加規則——**本模組風險最高的部分**。
--
-- 這份測試檔案分成兩大段,對應規格書 §5.3 第 4 點/§8 明講的優先順序:
--   ①(第一段,PART A)「無例外時逐格判斷與模組 5 原本的整段範圍判斷結果完全等價」的安全網。
--     這段測試案例刻意仿照 module5_01_create_booking_boundaries.sql 的邊界情境(商家營業時間/
--     服務人員時段/unlimited_backend_edit/no_time_slot_limit 各種組合),**在完全沒有任何
--     staff_availability_overrides 資料的前提下**驗證 create_booking 的成功/失敗結果。
--     這段測試在 engineer 把第三層邏輯正式接進 private.check_staff_booking_slot **之前**先寫好、
--     先確認在「舊版(逐格判斷邏輯改寫前)」的程式碼下全數通過,做為修改前的基準;
--     接著把第三層邏輯接進去之後,**重新跑這同一份檔案**(內容完全不改),必須繼續全數通過,
--     這就是「無例外時結果完全一致」的具體驗證方式(見檔案開頭 PART A 註解)。
--   ②(第二段,PART B)有單日例外時,第三層正確覆蓋前兩層交集結果,以及 unlimited_backend_edit
--     覆寫例外優先於第三層、跨半小時格子的部分失敗會整筆擋下且指出具體時段。
--
-- 情境布置(PART A):一間商家「單日例外第三層測試商家」,週二 09:00-18:00 營業,週三公休。
-- 服務人員 A:週二可預約時段只有 10:00-11:00(比營業時間窄),no_time_slot_limit=false,
-- unlimited_backend_edit=false。服務人員 B:跟 A 相同設定,但 unlimited_backend_edit=true。
-- 服務人員 C:no_time_slot_limit=true,完全沒有設定 staff_availability_windows。
-- 服務項目「服務」90 分鐘,用來製造橫跨 3 個半小時格子的預約(10:00-11:30),
-- 驗證「多格子只要有一格不合格,整筆擋下」在無例外情況下依然成立(等價性延伸到多格情境)。
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
  ('c4000000-0000-4000-8000-000000000001', 'pgtap-m6b-t3-admin@test.local');

insert into groups (id) values ('c4000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000010', '單日例外第三層測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values
  ('c4000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00'),
  ('c4000000-0000-4000-8000-000000000020', 3, true, null, null);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c4000000-0000-4000-8000-000000000030', 'c4000000-0000-4000-8000-000000000020', '短服務', 500, 'primary', 60),
  ('c4000000-0000-4000-8000-000000000031', 'c4000000-0000-4000-8000-000000000020', '長服務', 800, 'primary', 90);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('c4000000-0000-4000-8000-000000000040', 'c4000000-0000-4000-8000-000000000020', '服務人員A', null, false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c4000000-0000-4000-8000-000000000040', 2, '10:00', '11:30');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('c4000000-0000-4000-8000-000000000041', 'c4000000-0000-4000-8000-000000000020', '服務人員B(不限)', null, false, true);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('c4000000-0000-4000-8000-000000000042', 'c4000000-0000-4000-8000-000000000020', '服務人員C(無時段限制)', null, true, false);

-- 服務人員 D/E:專門給 A7/A8 多格子情境用,避免跟服務人員 A 既有的 A1 那筆 10:00-11:00 預約重疊
-- (strict_conflict_check 預設開啟,同一位服務人員時段重疊會被規則 2.4 擋下,那是另一條規則,
-- 不是這裡要測的邊界規則,用獨立的服務人員避免兩條規則互相干擾)。時段設定跟服務人員 A 相同
-- (10:00-11:30)。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('c4000000-0000-4000-8000-000000000043', 'c4000000-0000-4000-8000-000000000020', '服務人員D', null, false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c4000000-0000-4000-8000-000000000043', 2, '10:00', '11:30');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit)
values ('c4000000-0000-4000-8000-000000000044', 'c4000000-0000-4000-8000-000000000020', '服務人員E', null, false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values ('c4000000-0000-4000-8000-000000000044', 2, '10:00', '11:30');

-- PART B 專用的服務人員 F/G/H/I,窗口設定跟 A/D/E 相同(10:00-11:30),各自獨立不互相干擾。
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('c4000000-0000-4000-8000-000000000045', 'c4000000-0000-4000-8000-000000000020', '服務人員F', null, false, false),
  ('c4000000-0000-4000-8000-000000000046', 'c4000000-0000-4000-8000-000000000020', '服務人員G', null, false, false),
  ('c4000000-0000-4000-8000-000000000047', 'c4000000-0000-4000-8000-000000000020', '服務人員H', null, false, false),
  ('c4000000-0000-4000-8000-000000000048', 'c4000000-0000-4000-8000-000000000020', '服務人員I', null, false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('c4000000-0000-4000-8000-000000000045', 2, '10:00', '11:30'),
  ('c4000000-0000-4000-8000-000000000046', 2, '10:00', '11:30'),
  ('c4000000-0000-4000-8000-000000000047', 2, '10:00', '11:30'),
  ('c4000000-0000-4000-8000-000000000048', 2, '10:00', '11:30');

-- PART B 專用:30 分鐘服務項目,方便剛好對齊單一半小時格子測試。
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('c4000000-0000-4000-8000-000000000032', 'c4000000-0000-4000-8000-000000000020', '半小時服務', 300, 'primary', 30);

-- 用來檢查錯誤訊息具體內容(throws_ok 的既有慣例只比對 sqlstate,不比對訊息文字,見
-- automated-testing SKILL 的既有踩坑記錄;這裡另外包一支小工具,專門驗證 §5.3 第 3 點
-- 「錯誤訊息要具體指出是哪個時段」這件事有沒有真的做到)。
create function pg_temp.capture_error(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end;
$$;

select pg_temp.test_set_auth('c4000000-0000-4000-8000-000000000001');

-- =========================================================================
-- PART A:無例外時,逐格判斷與模組 5 原本整段範圍判斷結果完全等價。
-- =========================================================================

-- A1. 規則 2.1+2.2:落在商家營業時間跟服務人員時段內(10:00-11:00),應該成功。
select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'A1客戶', '0921000001'
  )$$,
  'PART A1:落在商家營業時間跟服務人員時段內,建立成功(無例外)'
);

-- A2. 規則 2.2:12:00-13:00 落在商家營業時間內,但超出服務人員時段(10:00-11:30),應該被擋下。
select throws_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 12:00:00+08',
    'A2客戶', '0921000002'
  )$$,
  'P0001', null,
  'PART A2:超出服務人員可預約時段,被擋下(無例外)'
);

-- A3. 規則 2.1:08:00 早於商家開店時間(09:00),應該被擋下。
select throws_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 08:00:00+08',
    'A3客戶', '0921000003'
  )$$,
  'P0001', null,
  'PART A3:早於商家營業時間,被擋下(無例外)'
);

-- A4. 規則 2.1:週三公休,應該被擋下。
select throws_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-23 10:00:00+08',
    'A4客戶', '0921000004'
  )$$,
  'P0001', null,
  'PART A4:當天公休,被擋下(無例外)'
);

-- A5. 規則 2.3:服務人員 B(unlimited_backend_edit=true)08:00(超出商家營業時間)應該成功。
select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 08:00:00+08',
    'A5客戶', '0921000005'
  )$$,
  'PART A5:unlimited_backend_edit=true,跳過邊界檢查,建立成功(無例外)'
);

-- A6. 規則 2.5:服務人員 C(no_time_slot_limit=true,完全沒設定時段)只受商家營業時間限制,應該成功。
select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000042',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'A6客戶', '0921000006'
  )$$,
  'PART A6:no_time_slot_limit=true 時只受商家營業時間限制,建立成功(無例外)'
);

-- A7. 多格子情境(等價性延伸):90 分鐘服務(橫跨 3 個半小時格子:10:00-11:30),
--     服務人員A的時段剛好是 10:00-11:30,3 個格子全部合格,應該成功。
select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000043',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'A7客戶', '0921000007'
  )$$,
  'PART A7:跨 3 個半小時格子,全部落在服務人員時段內,建立成功(無例外)'
);

-- A8. 多格子情境對照組:90 分鐘服務從 10:30 開始(10:30-12:00),最後一格(11:30-12:00)
--     超出服務人員時段(10:00-11:30),即使前兩格合格,整筆也應該被擋下
--     (等價性延伸:模組 5 原本的整段判斷本來就會擋下這種「只有一部分超出」的情況)。
select throws_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000044',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:30:00+08',
    'A8客戶', '0921000008'
  )$$,
  'P0001', null,
  'PART A8:跨格子預約只有一部分超出服務人員時段,整筆被擋下(無例外,等價於原本整段判斷)'
);

-- =========================================================================
-- PART B:有單日例外時,第三層正確覆蓋前兩層交集結果;unlimited_backend_edit 優先於第三層;
-- 跨半小時格子的部分失敗會整筆擋下且指出具體時段(§5.3 第 2、3 點)。
-- =========================================================================

-- B1(開啟例外):服務人員F,08:00-08:30 原本超出商家營業時間(09:00 開始)也超出服務人員時段
--    (10:00-11:30),先開啟這個時段的例外,應該讓原本不可預約的格子變成可預約。
select set_staff_day_override('c4000000-0000-4000-8000-000000000045', '2026-09-22', '08:00', '08:30', true);

select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000045',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 08:00:00+08',
    'B1客戶', '0921000101'
  )$$,
  'PART B1:開啟例外後,原本超出商家營業時間與服務人員時段的格子變成可預約,建立成功'
);

-- B2(關閉例外):服務人員G,10:00-10:30 原本落在商家營業時間跟服務人員時段內(應該可預約),
--    先關閉這個時段的例外,應該讓原本可預約的格子變成不可預約。
select set_staff_day_override('c4000000-0000-4000-8000-000000000046', '2026-09-22', '10:00', '10:30', false);

select throws_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000046',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'B2客戶', '0921000102'
  )$$,
  'P0001', null,
  'PART B2:關閉例外後,原本可預約的格子變成不可預約,建立被擋下'
);

-- B2 對照組:清除例外後,恢復成原本可預約的狀態。
select clear_staff_day_override('c4000000-0000-4000-8000-000000000046', '2026-09-22', '10:00', '10:30');

select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000046',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'B2對照客戶', '0921000103'
  )$$,
  'PART B2 對照組:clear_staff_day_override 清除例外後,恢復成原本可預約的狀態,建立成功'
);

-- B3(unlimited_backend_edit 優先於第三層,§5.3 第 2 點):服務人員B(unlimited_backend_edit=true),
--    先關閉 10:00-10:30 的例外,理論上這一格應該不可預約,但因為 unlimited_backend_edit=true,
--    整組邊界檢查(含第三層)都被跳過,應該仍然建立成功。
select set_staff_day_override('c4000000-0000-4000-8000-000000000041', '2026-09-22', '10:00', '10:30', false);

select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000041',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000032','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'B3客戶', '0921000104'
  )$$,
  'PART B3:unlimited_backend_edit=true 優先於第三層,即使該格已設定臨時關閉,仍建立成功'
);

-- B4(跨格子部分失敗整筆擋下,§5.3 第 3 點):服務人員H,90 分鐘服務(10:00-11:30,橫跨 3 格),
--    只關閉中間那一格(10:30-11:00),應該整筆被擋下,且錯誤訊息具體指出是 10:30-11:00 這個時段。
select set_staff_day_override('c4000000-0000-4000-8000-000000000047', '2026-09-22', '10:30', '11:00', false);

select throws_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000047',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'B4客戶', '0921000105'
  )$$,
  'P0001', null,
  'PART B4:跨格子預約中間一格已設定臨時關閉,整筆被擋下'
);

select ok(
  pg_temp.capture_error($$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000047',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    'B4客戶重試', '0921000106'
  )$$) like '%10:30%11:00%',
  'PART B4:錯誤訊息具體指出是哪個時段不可預約(10:30 到 11:00)'
);

-- B5(開啟例外讓多格子預約超出原本窗口範圍成功):服務人員I,90 分鐘服務從 10:30 開始
--    (10:30-12:00),原本窗口只到 11:30,最後一格(11:30-12:00)超出窗口。先開啟 11:30-12:00
--    這個時段的例外,應該讓整筆(3 格全部合格)建立成功。
select set_staff_day_override('c4000000-0000-4000-8000-000000000048', '2026-09-22', '11:30', '12:00', true);

select lives_ok(
  $$select create_booking(
    'c4000000-0000-4000-8000-000000000020', 'c4000000-0000-4000-8000-000000000048',
    jsonb_build_array(jsonb_build_object('service_item_id','c4000000-0000-4000-8000-000000000031','quantity',1,'unit_price',100)), '2026-09-22 10:30:00+08',
    'B5客戶', '0921000107'
  )$$,
  'PART B5:開啟例外讓原本超出服務人員時段的最後一格變成可預約,跨格子預約整筆建立成功'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
