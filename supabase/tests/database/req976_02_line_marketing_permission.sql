-- SPECS-INDEX #976 第 3 批(2026-10-06):新增「再行銷通知」客服權限(line_marketing)— pgTAP
-- migration 20261006130100_req976_line_marketing_permission.sql
--
--   ①~⑥ private.can_send_line_marketing / public.am_i_allowed_line_marketing:管理員、line_marketing 客服放行;
--        只有 line_notification 的客服、line_marketing=false、已移除的客服、別家商家管理員都擋
--   ⑦~⑪ list_line_marketable_members:有權限拿得到名單(只有已綁定且有效的會員、只有 5 個欄位,沒有 line_user_id);
--        沒權限 42501
--   ⑫~⑬ merchant_member_tiers:line_marketing 客服讀得到等級(依等級挑選名單用);沒權限的讀不到
--   ⑭~⑮ ACL:anon 沒有 EXECUTE;authenticated 有
--   ⑯   既有客服預設關閉:migration 沒有寫入任何 line_marketing 授權列
--
-- 故障注入(engineer 已做,見回報):can_send_line_marketing 拿掉 section_key 判斷(任何在職客服都放行)⇒ ③④⑨⑬ 轉紅
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(16);

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

-- ⑯ 要在建 fixture 之前算:整個資料庫(本機 reset 後只有 migration + seed)不應該有任何 line_marketing 授權列。
select is(
  (select count(*)::int from merchant_agent_permissions where section_key = 'line_marketing'),
  0,
  '⑯ 既有客服預設關閉:migration 沒有自動授權任何客服 line_marketing'
);

insert into auth.users (id, email) values
  ('f9762000-0000-4000-8000-000000000001', 'pgtap-r976b-admin-a@test.local'),
  ('f9762000-0000-4000-8000-000000000002', 'pgtap-r976b-admin-b@test.local'),
  ('f9762000-0000-4000-8000-000000000003', 'pgtap-r976b-marketing@test.local'),
  ('f9762000-0000-4000-8000-000000000004', 'pgtap-r976b-linenotify@test.local'),
  ('f9762000-0000-4000-8000-000000000005', 'pgtap-r976b-off@test.local'),
  ('f9762000-0000-4000-8000-000000000006', 'pgtap-r976b-removed@test.local');

insert into groups (id) values
  ('f9762000-0000-4000-8000-000000000011'),
  ('f9762000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('f9762000-0000-4000-8000-000000000020', 'f9762000-0000-4000-8000-000000000011', '#976 再行銷 A 店', 'in_store_beauty'),
  ('f9762000-0000-4000-8000-000000000021', 'f9762000-0000-4000-8000-000000000012', '#976 再行銷 B 店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('f9762000-0000-4000-8000-000000000020', 'f9762000-0000-4000-8000-000000000001'),
  ('f9762000-0000-4000-8000-000000000021', 'f9762000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9762000-0000-4000-8000-000000000033', 'f9762000-0000-4000-8000-000000000020', 'f9762000-0000-4000-8000-000000000003', '客服再行銷', 'pgtap-r976b-marketing@test.local', 'active', now(), '0900976203'),
  ('f9762000-0000-4000-8000-000000000034', 'f9762000-0000-4000-8000-000000000020', 'f9762000-0000-4000-8000-000000000004', '客服LINE通知', 'pgtap-r976b-linenotify@test.local', 'active', now(), '0900976204'),
  ('f9762000-0000-4000-8000-000000000035', 'f9762000-0000-4000-8000-000000000020', 'f9762000-0000-4000-8000-000000000005', '客服關閉', 'pgtap-r976b-off@test.local', 'active', now(), '0900976205'),
  ('f9762000-0000-4000-8000-000000000036', 'f9762000-0000-4000-8000-000000000020', 'f9762000-0000-4000-8000-000000000006', '客服已移除', 'pgtap-r976b-removed@test.local', 'removed', now(), '0900976206');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9762000-0000-4000-8000-000000000033', 'line_marketing', true),
  ('f9762000-0000-4000-8000-000000000034', 'line_notification', true),
  ('f9762000-0000-4000-8000-000000000035', 'line_marketing', false),
  ('f9762000-0000-4000-8000-000000000036', 'line_marketing', true);

insert into merchant_member_tiers (id, merchant_id, name, sort_order) values
  ('f9762000-0000-4000-8000-000000000060', 'f9762000-0000-4000-8000-000000000020', '金卡', 1);

insert into members (id, merchant_id, name, phone, referral_code, line_bound, line_user_id, status, tier_id, is_blacklisted) values
  ('f9762000-0000-4000-8000-000000000070', 'f9762000-0000-4000-8000-000000000020', '甲已綁定', '0922976270', 'R9762A', true, 'Usecret0001', 'active', 'f9762000-0000-4000-8000-000000000060', false),
  ('f9762000-0000-4000-8000-000000000071', 'f9762000-0000-4000-8000-000000000020', '乙未綁定', '0922976271', 'R9762B', false, null, 'active', null, false),
  ('f9762000-0000-4000-8000-000000000072', 'f9762000-0000-4000-8000-000000000020', '丙已綁定黑名單', '0922976272', 'R9762C', true, 'Usecret0003', 'active', null, true),
  ('f9762000-0000-4000-8000-000000000073', 'f9762000-0000-4000-8000-000000000021', '丁B店', '0922976273', 'R9762D', true, 'Usecret0004', 'active', null, false);

-- =========================================================================
-- ①~⑥ 權限判斷
-- =========================================================================
select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000001');
select ok(am_i_allowed_line_marketing('f9762000-0000-4000-8000-000000000020'), '① 商家管理員:可以使用再行銷通知');

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000003');
select ok(am_i_allowed_line_marketing('f9762000-0000-4000-8000-000000000020'), '② line_marketing 開啟的客服:可以使用');

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000004');
select ok(not am_i_allowed_line_marketing('f9762000-0000-4000-8000-000000000020'), '③ 只有 LINE 通知設定權限的客服:不行(兩把獨立的鑰匙)');

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000005');
select ok(not am_i_allowed_line_marketing('f9762000-0000-4000-8000-000000000020'), '④ line_marketing 明確關閉的客服:不行');

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000006');
select ok(not am_i_allowed_line_marketing('f9762000-0000-4000-8000-000000000020'), '⑤ 已移除的客服(授權列還在):不行');

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000002');
select ok(not am_i_allowed_line_marketing('f9762000-0000-4000-8000-000000000020'), '⑥ 別家商家管理員:對 A 店不行');

-- =========================================================================
-- ⑦~⑪ 可選名單
-- =========================================================================
select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000003');
select is(
  (select jsonb_agg(r ->> 'name' order by r ->> 'name') from jsonb_array_elements(list_line_marketable_members('f9762000-0000-4000-8000-000000000020')) r),
  '["丙已綁定黑名單", "甲已綁定"]'::jsonb,
  '⑦ line_marketing 客服拿得到名單:只有 A 店已綁定 LINE 的有效會員(黑名單照樣列出,由畫面自動排除、Edge Function 再擋一次)'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(list_line_marketable_members('f9762000-0000-4000-8000-000000000020') -> 0) k),
  array['id','is_blacklisted','name','phone','tier_id'],
  '⑧ 名單只有畫面要用的 5 個欄位,不回傳 line_user_id'
);

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000004');
select throws_ok(
  $$select list_line_marketable_members('f9762000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '⑨ 只有 LINE 通知設定權限的客服拿不到名單'
);

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000002');
select throws_ok(
  $$select list_line_marketable_members('f9762000-0000-4000-8000-000000000020')$$,
  '42501', null,
  '⑩ 別家商家管理員拿不到 A 店名單'
);

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000001');
select is(
  jsonb_array_length(list_line_marketable_members('f9762000-0000-4000-8000-000000000020')),
  2,
  '⑪ 商家管理員照舊拿得到名單'
);

-- =========================================================================
-- ⑫~⑬ 會員等級(依等級挑選)
-- =========================================================================
select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000003');
select is(
  (select count(*)::int from merchant_member_tiers where merchant_id = 'f9762000-0000-4000-8000-000000000020'),
  1,
  '⑫ line_marketing 客服讀得到會員等級(依會員等級批量挑選用)'
);

select pg_temp.test_set_auth('f9762000-0000-4000-8000-000000000004');
select is(
  (select count(*)::int from merchant_member_tiers where merchant_id = 'f9762000-0000-4000-8000-000000000020'),
  0,
  '⑬ 沒有 line_marketing(也沒有會員權限)的客服讀不到會員等級'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑭~⑮ ACL
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.am_i_allowed_line_marketing(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.list_line_marketable_members(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.can_send_line_marketing(uuid)', 'execute'),
  '⑭ anon 對三支函式都沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.am_i_allowed_line_marketing(uuid)', 'execute')
  and has_function_privilege('authenticated', 'public.list_line_marketable_members(uuid)', 'execute'),
  '⑮ authenticated 有 EXECUTE(Edge Function 用呼叫者 JWT 呼叫 am_i_allowed_line_marketing)'
);

select * from finish();

rollback;
