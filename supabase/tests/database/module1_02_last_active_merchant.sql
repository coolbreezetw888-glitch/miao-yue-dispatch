-- 模組 1 RLS/規則回歸測試 ②:集團最後一間啟用中商家無法被停用。
-- 對應 supabase/migrations/20260915100000_merchant_group_schema.sql 的
-- merchants_prevent_disable_last_active trigger(規則 2.2)。
begin;

select plan(4);

insert into groups (id)
values ('b0000000-0000-4000-8000-000000000001');

insert into merchants (id, group_id, name, industry_type, status)
values (
  'b0000000-0000-4000-8000-000000000002',
  'b0000000-0000-4000-8000-000000000001',
  '分店 A(集團裡唯一一間)',
  'on_site_dispatch',
  'active'
);

-- ① 集團底下只有這一間啟用中商家時,停用它要被擋下。
select throws_ok(
  $$update merchants set status = 'disabled' where id = 'b0000000-0000-4000-8000-000000000002'$$,
  'P0001',
  NULL,
  '規則 2.2:集團底下只剩一間啟用中商家時,停用它會被 trigger 擋下(errcode P0001)'
);

-- ② 確認擋下之後狀態真的沒有被改掉。
select is(
  (select status from merchants where id = 'b0000000-0000-4000-8000-000000000002'),
  'active',
  '嘗試停用失敗後,商家狀態仍是 active'
);

-- 集團裡再新增第二間啟用中商家,這時候停用第一間應該要成功。
insert into merchants (id, group_id, name, industry_type, status)
values (
  'b0000000-0000-4000-8000-000000000003',
  'b0000000-0000-4000-8000-000000000001',
  '分店 B(新增的第二間)',
  'on_site_dispatch',
  'active'
);

-- ③ 集團裡還有另一間啟用中商家時,停用其中一間應該要成功。
select lives_ok(
  $$update merchants set status = 'disabled' where id = 'b0000000-0000-4000-8000-000000000002'$$,
  '集團底下還有其他啟用中商家時,停用其中一間應該要成功'
);

-- ④ 現在只剩分店 B 是啟用中,再次停用它應該又被擋下(確認規則不是「用過一次就失效」)。
select throws_ok(
  $$update merchants set status = 'disabled' where id = 'b0000000-0000-4000-8000-000000000003'$$,
  'P0001',
  NULL,
  '規則 2.2:分店 A 停用後,分店 B 變成集團底下唯一啟用中商家,一樣不能被停用'
);

select * from finish();

rollback;
