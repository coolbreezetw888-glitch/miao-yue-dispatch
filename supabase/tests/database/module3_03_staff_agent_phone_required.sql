-- 對應規格書 .project/specs/人員與權限管理.md §8.1(服務人員電話必填+格式)/§8.2(客服電話必填+格式)/
-- §8.3(共用驗證邏輯:phone ~ '^09\d{8}$')。對應 .project/SPECS-INDEX.md #595、#596。
--
-- 這份測試驗證資料庫層的 NOT NULL + CHECK 約束本身(前端 src/lib/validation.ts、
-- Edge Function supabase/functions/_shared/phoneValidation.ts 的驗證已有各自的 Vitest 測試,
-- 這裡只測「就算有人繞過應用層邏輯直接寫 SQL,資料庫本身也要擋下來」)。
--
-- 背景:正式環境(wjtbmmnakcriuaqoknsq)套用這批約束前,原本有 5 筆既有測試/空白資料不符合
-- 新格式(3 筆 merchant_staff 完全空白、1 筆 merchant_staff 測試值「123」、1 筆 merchant_agents
-- 測試值「0900」),已由主腦/engineer 人工核對確認都是測試資料後個別處理完畢(3 筆空白的改為
-- status='removed' 停用+補佔位電話滿足約束、2 筆測試值改為合理的佔位測試電話),詳細記錄見
-- migrations/20260922140000_req595_596_staff_agent_phone_not_null_check.sql 開頭註解跟
-- 對應這次的回報記錄,不在這份測試檔案重複列。
begin;

select plan(14);

-- =========================================================================
-- merchant_staff.phone
-- =========================================================================
insert into groups (id) values ('a3300000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('a3300000-0000-4000-8000-000000000020', 'a3300000-0000-4000-8000-000000000010', '電話約束測試商家', 'on_site_dispatch');

-- ① NOT NULL:phone 為 NULL 應被擋下(errcode 23502)。
select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話NULL測試', null)$$,
  '23502', NULL,
  '§8.1:merchant_staff.phone 為 NULL,被 NOT NULL 約束擋下(errcode 23502)'
);

-- ② CHECK:市話格式(02 開頭 + 連字號)應被擋下(errcode 23514)。
select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話市話測試', '02-2345-6789')$$,
  '23514', NULL,
  '§8.1:merchant_staff.phone 是市話格式,被 CHECK 約束擋下(errcode 23514)'
);

-- ③ CHECK:09 開頭但少於 10 碼(9 碼)應被擋下。
select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話少一碼測試', '091234567')$$,
  '23514', NULL,
  '§8.1:merchant_staff.phone 少於 10 碼,被 CHECK 約束擋下'
);

-- ④ CHECK:09 開頭但多於 10 碼(11 碼)應被擋下。
select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話多一碼測試', '09123456789')$$,
  '23514', NULL,
  '§8.1:merchant_staff.phone 多於 10 碼,被 CHECK 約束擋下'
);

-- ⑤ CHECK:非 09 開頭(08 開頭)應被擋下。
select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話非09開頭測試', '0812345678')$$,
  '23514', NULL,
  '§8.1:merchant_staff.phone 非 09 開頭,被 CHECK 約束擋下'
);

-- ⑥ CHECK:含非數字字元(帶括號的國際碼格式)應被擋下。
select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話含符號測試', '+886912345678')$$,
  '23514', NULL,
  '§8.1:merchant_staff.phone 含非數字字元(+886 開頭),被 CHECK 約束擋下'
);

-- ⑦ 正確格式應該成功寫入。
select lives_ok(
  $$insert into merchant_staff (merchant_id, name, phone)
    values ('a3300000-0000-4000-8000-000000000020', '電話正確格式測試', '0912345678')$$,
  '§8.1:merchant_staff.phone 是合法格式(09 開頭共 10 碼數字),成功寫入'
);

-- =========================================================================
-- merchant_agents.phone(§8.2,套用同一套 CHECK 約束)
-- =========================================================================

-- ⑧ NOT NULL:phone 為 NULL 應被擋下。
select throws_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話NULL測試', 'pgtap-m3-phone-null@test.local', null)$$,
  '23502', NULL,
  '§8.2:merchant_agents.phone 為 NULL,被 NOT NULL 約束擋下'
);

-- ⑨ CHECK:市話格式應被擋下。
select throws_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話市話測試', 'pgtap-m3-phone-landline@test.local', '02-2345-6789')$$,
  '23514', NULL,
  '§8.2:merchant_agents.phone 是市話格式,被 CHECK 約束擋下'
);

-- ⑩ CHECK:少於 10 碼應被擋下。
select throws_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話少一碼測試', 'pgtap-m3-phone-short@test.local', '091234567')$$,
  '23514', NULL,
  '§8.2:merchant_agents.phone 少於 10 碼,被 CHECK 約束擋下'
);

-- ⑪ CHECK:多於 10 碼應被擋下。
select throws_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話多一碼測試', 'pgtap-m3-phone-long@test.local', '09123456789')$$,
  '23514', NULL,
  '§8.2:merchant_agents.phone 多於 10 碼,被 CHECK 約束擋下'
);

-- ⑫ CHECK:非 09 開頭應被擋下。
select throws_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話非09開頭測試', 'pgtap-m3-phone-prefix@test.local', '0812345678')$$,
  '23514', NULL,
  '§8.2:merchant_agents.phone 非 09 開頭,被 CHECK 約束擋下'
);

-- ⑬ CHECK:歷史遺留的測試值「0900」(僅 4 碼,對應這次正式環境查證發現的既有資料)應被擋下,
--     證明約束確實能擋住當初導致我們暫緩上約束的那種資料。
select throws_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話舊測試值', 'pgtap-m3-phone-legacy@test.local', '0900')$$,
  '23514', NULL,
  '§8.2:歷史測試值「0900」(僅4碼)這種格式,現在會被 CHECK 約束擋下(對應正式環境查證發現的既有資料狀況)'
);

-- ⑭ 正確格式應該成功寫入。
select lives_ok(
  $$insert into merchant_agents (merchant_id, name, invited_email, phone)
    values ('a3300000-0000-4000-8000-000000000020', '客服電話正確格式測試', 'pgtap-m3-phone-valid@test.local', '0987654321')$$,
  '§8.2:merchant_agents.phone 是合法格式,成功寫入'
);

select * from finish();

rollback;
