-- 模組 1 RLS/規則回歸測試 ①:產業類型鎖定後,無法透過直接 SQL UPDATE 修改(trigger 生效)。
-- 對應 supabase/migrations/20260915100000_merchant_group_schema.sql 的
-- merchants_lock_industry_type trigger(規則 2.1)。
--
-- 刻意直接以 postgres(超級使用者、會略過 RLS)身分下 UPDATE ——這條規則的防線是資料庫 trigger
-- 本身,不是 RLS 政策,所以就算繞過 RLS 也一樣要被擋下來,這樣才能證明「真的鎖住了」,不是只靠
-- 前端不給選、或只靠 RLS 剛好擋住。
--
-- 整份檔案包在 begin/rollback 裡,測試建立的 fixture 資料在檔案結束時全部復原,不會留下任何痕跡。
begin;

select plan(2);

insert into auth.users (id, email)
values ('a0000000-0000-4000-8000-000000000001', 'pgtap-industry-lock@test.local');

insert into groups (id)
values ('a0000000-0000-4000-8000-000000000002');

insert into merchants (id, group_id, name, industry_type)
values (
  'a0000000-0000-4000-8000-000000000003',
  'a0000000-0000-4000-8000-000000000002',
  'pgTAP 測試商家(產業鎖定)',
  'on_site_dispatch'
);

-- 注意:throws_ok 的 4 個參數是 (sql, sqlstate, 預期錯誤訊息或 NULL, description)。
-- 傳 NULL 當第三個參數代表「不比對訊息內容,只比對 sqlstate」——這裡刻意這樣做,避免測試綁死在
-- 中文錯誤訊息的確切字句上,以後調整措辭不會無端弄壞這條測試。
select throws_ok(
  $$update merchants set industry_type = 'in_store_beauty' where id = 'a0000000-0000-4000-8000-000000000003'$$,
  '23514',
  NULL,
  '規則 2.1:直接 UPDATE industry_type 會被 merchants_lock_industry_type trigger 擋下(errcode 23514)'
);

select is(
  (select industry_type from merchants where id = 'a0000000-0000-4000-8000-000000000003'),
  'on_site_dispatch',
  '嘗試修改失敗後,industry_type 仍維持建立時的原值,沒有被部分寫入'
);

select * from finish();

rollback;
