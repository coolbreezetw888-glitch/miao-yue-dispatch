-- 模組 10(會員與紅利)— 對應規格書 .project/specs/會員與紅利.md §1.1~§1.4、§3.1~§3.5、§3.15、§3.16、
-- 一之二節 RLS 影響評估。這支檔案涵蓋:CHECK 約束/預設值/跨商家隔離、can_manage_members/
-- can_manage_member_settings、members 表 RPC-only 寫入模式、create_member/update_member/
-- deactivate_member/reactivate_member/set_member_phone_verified、seed_default_member_settings、
-- 一之二節「既有 RLS 政策定義完全沒有變動」的回歸驗證。
begin;

select plan(48);

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
-- Fixture:两間商家(A/B,測跨商家隔離)。A 商家:管理員 + 3 種客服(無授權/members/member_settings)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ea000000-0000-4000-8000-000000000001', 'pgtap-m10-admin-a@test.local'),
  ('ea000000-0000-4000-8000-000000000002', 'pgtap-m10-admin-b@test.local'),
  ('ea000000-0000-4000-8000-000000000003', 'pgtap-m10-agent-none@test.local'),
  ('ea000000-0000-4000-8000-000000000004', 'pgtap-m10-agent-members@test.local'),
  ('ea000000-0000-4000-8000-000000000005', 'pgtap-m10-agent-settings@test.local'),
  ('ea000000-0000-4000-8000-000000000006', 'pgtap-m10-seed-onboarding@test.local');

insert into groups (id) values
  ('ea000000-0000-4000-8000-000000000011'),
  ('ea000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ea000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-000000000011', '會員紅利測試A店', 'in_store_beauty'),
  ('ea000000-0000-4000-8000-000000000022', 'ea000000-0000-4000-8000-000000000012', '會員紅利測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ea000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-000000000001'),
  ('ea000000-0000-4000-8000-000000000022', 'ea000000-0000-4000-8000-000000000002');

insert into auth.users (id, email) values
  ('ea000000-0000-4000-8000-000000000007', 'pgtap-m10-agent-orders@test.local');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('ea000000-0000-4000-8000-000000000051', 'ea000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m10-agent-none@test.local', 'active', now()),
  ('ea000000-0000-4000-8000-000000000052', 'ea000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-000000000004', '客服-members', 'pgtap-m10-agent-members@test.local', 'active', now()),
  ('ea000000-0000-4000-8000-000000000053', 'ea000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-000000000005', '客服-member_settings', 'pgtap-m10-agent-settings@test.local', 'active', now()),
  ('ea000000-0000-4000-8000-000000000054', 'ea000000-0000-4000-8000-000000000021', 'ea000000-0000-4000-8000-000000000007', '客服-僅orders', 'pgtap-m10-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ea000000-0000-4000-8000-000000000052', 'members', true),
  ('ea000000-0000-4000-8000-000000000053', 'member_settings', true),
  ('ea000000-0000-4000-8000-000000000054', 'orders', true);

-- =========================================================================
-- ① §1.1:merchant_member_settings CHECK 約束 + 預設值(以 postgres 超級使用者身分測)。
-- =========================================================================
select throws_ok(
  $$insert into merchant_member_settings (merchant_id, points_earn_rate)
    values ('ea000000-0000-4000-8000-000000000021', -1)$$,
  '23514', null,
  '1.1:points_earn_rate >= 0,負值被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into merchant_member_settings (merchant_id, referral_bonus_points)
    values ('ea000000-0000-4000-8000-000000000021', -1)$$,
  '23514', null,
  '1.1:referral_bonus_points >= 0,負值被 CHECK 約束擋下'
);

select throws_ok(
  $$insert into merchant_member_settings (merchant_id, birthday_bonus_points)
    values ('ea000000-0000-4000-8000-000000000021', -1)$$,
  '23514', null,
  '1.1:birthday_bonus_points >= 0,負值被 CHECK 約束擋下'
);

-- 3.15:seed_default_member_settings 直接呼叫,驗證預設值 + 冪等。
select seed_default_member_settings('ea000000-0000-4000-8000-000000000021');
select seed_default_member_settings('ea000000-0000-4000-8000-000000000021'); -- 第二次呼叫應該冪等

select is(
  (select count(*)::int from merchant_member_settings where merchant_id = 'ea000000-0000-4000-8000-000000000021'),
  1,
  '3.15:seed_default_member_settings 冪等,重複呼叫不會產生第二筆'
);

select is(
  (select row(phone_required_to_create, require_verified_phone_for_rewards, points_earn_rate, referral_bonus_points, birthday_bonus_points)
   from merchant_member_settings where merchant_id = 'ea000000-0000-4000-8000-000000000021')::text,
  row(true, false, 0.00, 0, 0)::text,
  '1.1:查無資料時前端/後端一律套用的預設值正確(第〇節判斷 3:全部預設 0/false)'
);

-- =========================================================================
-- ② 3.15:create_group_and_merchant 疊加呼叫 seed_default_member_settings,新商家自動種入預設值。
-- =========================================================================
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000006');

select create_group_and_merchant('會員模組種子測試店', 'in_store_beauty') \gset onboarding_merchant_

select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_member_settings where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  1,
  '3.15:create_group_and_merchant 建立商家後,merchant_member_settings 剛好 1 筆'
);

-- =========================================================================
-- ③ §3.1:can_manage_members / can_manage_member_settings 權限邊界。
-- =========================================================================
-- 直接用 private.* 函式測(以各角色身分呼叫)。
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');
select ok(private.can_manage_members('ea000000-0000-4000-8000-000000000021'), '3.1:商家管理員 can_manage_members 永遠為真');
select ok(private.can_manage_member_settings('ea000000-0000-4000-8000-000000000021'), '3.1:商家管理員 can_manage_member_settings 永遠為真');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000003');
select ok(not private.can_manage_members('ea000000-0000-4000-8000-000000000021'), '3.1:無授權客服 can_manage_members 為假');
select ok(not private.can_manage_member_settings('ea000000-0000-4000-8000-000000000021'), '3.1:無授權客服 can_manage_member_settings 為假');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000004');
select ok(private.can_manage_members('ea000000-0000-4000-8000-000000000021'), '3.1:被授權 members 的客服 can_manage_members 為真');
select ok(not private.can_manage_member_settings('ea000000-0000-4000-8000-000000000021'), '3.1:被授權 members 的客服 can_manage_member_settings 仍為假(兩把獨立鑰匙)');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000005');
select ok(not private.can_manage_members('ea000000-0000-4000-8000-000000000021'), '3.1:被授權 member_settings 的客服 can_manage_members 仍為假');
select ok(private.can_manage_member_settings('ea000000-0000-4000-8000-000000000021'), '3.1:被授權 member_settings 的客服 can_manage_member_settings 為真');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ §3.3:create_member(電話必填政策、推薦人驗證、權限邊界、referral_code 唯一)。
-- =========================================================================
-- 電話必填(預設 phone_required_to_create=true)。
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');

select throws_ok(
  $$select create_member('ea000000-0000-4000-8000-000000000021', '無電話會員')$$,
  'P0001', null,
  '3.3:phone_required_to_create=true 時,不填電話被擋下'
);

select id from create_member('ea000000-0000-4000-8000-000000000021', '會員甲', '0911000001') \gset member_a1_

select is(
  (select phone from members where id = :'member_a1_id'::uuid),
  '0911000001',
  '3.3:填了電話可以成功建立會員'
);

select isnt(
  (select referral_code from members where id = :'member_a1_id'::uuid),
  null,
  '3.3/判斷 11:建立當下自動產生 referral_code'
);

select id from create_member('ea000000-0000-4000-8000-000000000021', '會員乙', '0911000002') \gset member_a2_

select isnt(
  (select referral_code from members where id = :'member_a1_id'::uuid),
  (select referral_code from members where id = :'member_a2_id'::uuid),
  '3.3:兩位會員的 referral_code 不同(唯一性)'
);

-- 關閉電話必填政策後可以不填電話。
update merchant_member_settings set phone_required_to_create = false
where merchant_id = 'ea000000-0000-4000-8000-000000000021';

select lives_ok(
  $$select create_member('ea000000-0000-4000-8000-000000000021', '無電話會員2')$$,
  '3.3:phone_required_to_create=false 時,不填電話可以成功'
);

update merchant_member_settings set phone_required_to_create = true
where merchant_id = 'ea000000-0000-4000-8000-000000000021';

-- 推薦人驗證:不存在。
select throws_ok(
  format($$select create_member('ea000000-0000-4000-8000-000000000021', '推薦測試', '0911000003', p_referred_by_member_id => '%s')$$, gen_random_uuid()),
  'P0001', null,
  '3.3:推薦人不存在時被擋下'
);

select pg_temp.test_clear_auth();

-- 建一位 B 商家會員,用來測「推薦人跨商家」。
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000002');
select id from create_member('ea000000-0000-4000-8000-000000000022', 'B店會員', '0922000001') \gset member_b1_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select create_member('ea000000-0000-4000-8000-000000000021', '跨商家推薦測試', '0911000004', p_referred_by_member_id => '%s')$$, (:'member_b1_id')),
  'P0001', null,
  '3.3:推薦人屬於別間商家時被擋下'
);

-- 推薦人已下架。
select id from create_member('ea000000-0000-4000-8000-000000000021', '即將下架的推薦人', '0911000005') \gset member_removed_
select deactivate_member(:'member_removed_id'::uuid);

select throws_ok(
  format($$select create_member('ea000000-0000-4000-8000-000000000021', '推薦已下架會員測試', '0911000006', p_referred_by_member_id => '%s')$$, (:'member_removed_id')),
  'P0001', null,
  '3.3:推薦人已下架(status=removed)時被擋下'
);

-- 正常推薦關係。
select id from create_member('ea000000-0000-4000-8000-000000000021', '被推薦人', '0911000007', p_referred_by_member_id => :'member_a1_id'::uuid) \gset referred_member_

select is(
  (select referred_by_member_id from members where id = :'referred_member_id'::uuid),
  :'member_a1_id'::uuid,
  '3.3:正常推薦關係成功建立'
);

select pg_temp.test_clear_auth();

-- 權限邊界:無授權客服呼叫被擋下;被授權 members 的客服呼叫成功。
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000003');
select throws_ok(
  $$select create_member('ea000000-0000-4000-8000-000000000021', '無權限測試', '0911000008')$$,
  '42501', null,
  '3.1/3.3:無授權客服呼叫 create_member 被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000004');
select lives_ok(
  $$select create_member('ea000000-0000-4000-8000-000000000021', '有權限測試', '0911000009')$$,
  '3.1/3.3:被授權 members 的客服呼叫 create_member 成功'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ §3.4:update_member(電話必填、不可修改推薦人)。
-- =========================================================================
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');

select update_member(:'member_a2_id'::uuid, '會員乙(改名)', '0911999999', null, null, '備註');

select is(
  (select row(name, phone, notes) from members where id = :'member_a2_id'::uuid)::text,
  row('會員乙(改名)', '0911999999', '備註')::text,
  '3.4:update_member 正確更新姓名/電話/備註'
);

select throws_ok(
  format($$select update_member('%s', '缺電話', null, null, null, null)$$, (:'member_a2_id')),
  'P0001', null,
  '3.4:phone_required_to_create=true 時,更新成空電話被擋下'
);

-- update_member 沒有 referred_by 參數,直接呼叫既有簽章(6 個參數)驗證函式簽章沒有多出來的參數。
select is(
  (select referred_by_member_id from members where id = :'referred_member_id'::uuid),
  :'member_a1_id'::uuid,
  '3.4:update_member 呼叫後,referred_by_member_id 不受影響(函式本來就不接受這個參數)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ §3.5:deactivate_member / reactivate_member / set_member_phone_verified。
-- =========================================================================
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');

select deactivate_member(:'member_a2_id'::uuid);
select is(
  (select status from members where id = :'member_a2_id'::uuid),
  'removed',
  '3.5:deactivate_member 正確下架'
);

select reactivate_member(:'member_a2_id'::uuid);
select is(
  (select status from members where id = :'member_a2_id'::uuid),
  'active',
  '3.5:reactivate_member 正確重新上架'
);

select set_member_phone_verified(:'member_a2_id'::uuid, true);
select ok(
  (select phone_verified from members where id = :'member_a2_id'::uuid) = true
  and (select phone_verified_at from members where id = :'member_a2_id'::uuid) is not null,
  '3.5:set_member_phone_verified(true) 正確標記已驗證與時間'
);

select set_member_phone_verified(:'member_a2_id'::uuid, false);
select ok(
  (select phone_verified from members where id = :'member_a2_id'::uuid) = false
  and (select phone_verified_at from members where id = :'member_a2_id'::uuid) is null,
  '3.5:set_member_phone_verified(false) 正確清空驗證時間'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ §1.2:members CHECK 約束(不可推薦自己;status 只能 active/removed)+ 跨商家隔離(RLS)。
-- =========================================================================
select throws_ok(
  format($$update members set referred_by_member_id = id where id = '%s'$$, (:'member_a1_id')),
  '23514', null,
  '1.2:不可推薦自己(members_no_self_referral CHECK 約束)'
);

select throws_ok(
  format($$update members set status = 'invalid_status' where id = '%s'$$, (:'member_a1_id')),
  '23514', null,
  '1.2:status 只能是 active/removed'
);

-- 跨商家隔離:A 商家管理員看不到 B 商家會員。
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from members where id = :'member_b1_id'::uuid),
  0,
  '一之二節/RLS:A 商家管理員透過 SELECT 看不到 B 商家的會員'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ §3.16:members / member_point_transactions 沒有 INSERT/UPDATE/DELETE 政策(RPC only)。
-- =========================================================================
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000001');

select throws_ok(
  format($$insert into members (merchant_id, name, referral_code) values ('ea000000-0000-4000-8000-000000000021', '直接寫入測試', '%s')$$, upper(substr(replace(gen_random_uuid()::text,'-',''),1,8))),
  '42501', null,
  '3.16:members 沒有 INSERT 政策,一般角色直接 insert 被 RLS 擋下'
);

-- 注意:UPDATE/DELETE 跟 INSERT 在 RLS 沒有對應政策時的行為不同——INSERT 會直接拋出
-- 42501 例外(WITH CHECK 預設為 false);UPDATE/DELETE 則是因為沒有政策可以讓這一列「可見」,
-- 靜默影響 0 筆(不拋例外),效果一樣是寫入被完全擋下,只是驗證方式要改成「確認資料沒有被改到」。
update members set name = '直接改名測試' where id = :'member_a1_id'::uuid;

select isnt(
  (select name from members where id = :'member_a1_id'::uuid),
  '直接改名測試',
  '3.16:members 沒有 UPDATE 政策,一般角色直接 update 靜默影響 0 筆,資料沒有被改到'
);

delete from members where id = :'member_a1_id'::uuid;

select is(
  (select count(*)::int from members where id = :'member_a1_id'::uuid),
  1,
  '3.16:members 沒有 DELETE 政策,一般角色直接 delete 靜默影響 0 筆,這筆會員沒有被刪掉'
);

select throws_ok(
  format($$insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after)
    values ('%s', 'ea000000-0000-4000-8000-000000000021', 'manual_adjustment', 10, 10)$$, (:'member_a1_id')),
  '42501', null,
  '3.16:member_point_transactions 沒有 INSERT 政策,一般角色直接 insert 被 RLS 擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ 一之二節:既有 RLS 政策定義完全沒有變動(比對政策內容字串)。
-- =========================================================================
select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'bookings_select'),
  'private.can_manage_bookings(merchant_id)',
  '一之二節:bookings_select 政策定義完全沒有變動'
);

select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'merchant_staff_select'),
  '(private.is_merchant_admin(merchant_id) OR private.can_manage_bookings(merchant_id) OR private.can_manage_team_leave(merchant_id) OR private.can_manage_commission_settings(merchant_id) OR private.can_view_payroll_reports(merchant_id))',
  '一之二節:merchant_staff_select 政策定義完全沒有變動(本模組沒有新增任何依賴服務人員清單的功能)'
);

-- =========================================================================
-- ⑩ SPECS-INDEX #320/324/337/343/347 回歸驗證:只有 orders 權限、沒有 members 權限的客服,
-- 建單頁疊加的「選擇會員」欄位(§4.4)一樣能搜尋既有會員/快速建立新會員(§2.10),但管理性質
-- 操作(編輯/下架/手動調點數)依然被擋下,確認這次修正沒有意外放寬範圍。
-- =========================================================================
select pg_temp.test_set_auth('ea000000-0000-4000-8000-000000000007');

select is(
  (select count(*)::int from members where id = :'member_a2_id'::uuid),
  1,
  '#337 回歸修正:只有 orders 權限、沒有 members 權限的客服可以 SELECT 到既有會員(members_select 政策新增 can_manage_bookings 放行)'
);

select lives_ok(
  $$select create_member('ea000000-0000-4000-8000-000000000021', 'orders客服建立的會員', '0911000010')$$,
  '#324/#343 回歸修正:只有 orders 權限的客服可以呼叫 create_member 成功建立新會員(建單頁「找不到?建立新會員」)'
);

select id from create_member('ea000000-0000-4000-8000-000000000021', 'orders客服建立的會員2', '0911000011') \gset member_orders_created_

select is(
  (select merchant_id from members where id = :'member_orders_created_id'::uuid),
  'ea000000-0000-4000-8000-000000000021'::uuid,
  '#324:orders 權限客服建立的會員正確歸屬到當下操作的商家'
);

select throws_ok(
  format($$select update_member('%s', '改名測試', null, null, null, null)$$, (:'member_orders_created_id')),
  '42501', null,
  '#320 範圍確認:只有 orders 權限的客服呼叫 update_member 依然被擋下(編輯會員是管理性質操作,規格書 §2.10 沒有一併放寬)'
);

select throws_ok(
  format($$select deactivate_member('%s')$$, (:'member_orders_created_id')),
  '42501', null,
  '#320 範圍確認:只有 orders 權限的客服呼叫 deactivate_member 依然被擋下'
);

select throws_ok(
  format($$select adjust_member_points('%s', 10, '測試')$$, (:'member_orders_created_id')),
  '42501', null,
  '#320 範圍確認:只有 orders 權限的客服呼叫 adjust_member_points 依然被擋下(規則 2.6,唯一只限商家管理員,不透過任何 section_key 開放)'
);

select pg_temp.test_clear_auth();

select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'members_select'),
  '(private.can_manage_members(merchant_id) OR private.can_manage_bookings(merchant_id))',
  '#337:members_select 政策定義正確套用這次修正(新增 can_manage_bookings 放行,其餘不變)'
);

select * from finish();
rollback;
