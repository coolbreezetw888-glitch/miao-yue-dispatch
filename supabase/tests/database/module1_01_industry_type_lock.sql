-- 模組 1 RLS/規則回歸測試 ①:產業類型可以隨時直接 SQL UPDATE 修改。
-- 對應 supabase/migrations/20260923040000_allow_industry_type_change.sql——使用者 2026-09-23
-- 推翻了原本的規則 2.1(建立後鎖定),拿掉了 merchants_lock_industry_type trigger。這份測試
-- 原本是驗證「鎖住」,現在反過來驗證「真的能改」,避免以後有人不小心把鎖定 trigger 加回來
-- 卻沒發現這件事已經被推翻。
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
  'pgTAP 測試商家(產業切換)',
  'on_site_dispatch'
);

select lives_ok(
  $$update merchants set industry_type = 'in_store_beauty' where id = 'a0000000-0000-4000-8000-000000000003'$$,
  '2026-09-23 起 industry_type 不再鎖定:直接 UPDATE 不會被任何 trigger 擋下'
);

select is(
  (select industry_type from merchants where id = 'a0000000-0000-4000-8000-000000000003'),
  'in_store_beauty',
  'UPDATE 後 industry_type 真的變成新值,不是靜默失敗'
);

select * from finish();

rollback;
