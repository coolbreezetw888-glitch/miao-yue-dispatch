-- 模組 10(會員與紅利)— SPECS-INDEX #615/#616(規格書 §10.3/§10.4)。
-- 會員分級(merchant_member_tiers)+ 會員黑名單(is_blacklisted/set_member_blacklist_status)。
begin;

select plan(19);

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
-- Fixture:兩間商家(A/B)。A 商家:管理員 + 客服(被授權 members,沒有 member_settings)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ed000000-0000-4000-8000-000000000001', 'pgtap-m10d-admin-a@test.local'),
  ('ed000000-0000-4000-8000-000000000002', 'pgtap-m10d-admin-b@test.local'),
  ('ed000000-0000-4000-8000-000000000003', 'pgtap-m10d-agent-members@test.local');

insert into groups (id) values
  ('ed000000-0000-4000-8000-000000000011'),
  ('ed000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000011', '會員分級黑名單測試A店', 'in_store_beauty'),
  ('ed000000-0000-4000-8000-000000000022', 'ed000000-0000-4000-8000-000000000012', '會員分級黑名單測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000001'),
  ('ed000000-0000-4000-8000-000000000022', 'ed000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ed000000-0000-4000-8000-000000000051', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000003', '客服-members', 'pgtap-m10d-agent-members@test.local', 'active', now(), '0900000101');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ed000000-0000-4000-8000-000000000051', 'members', true);

-- =========================================================================
-- ① §10.3:merchant_member_tiers CHECK 約束/唯一索引/RLS。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');

insert into merchant_member_tiers (id, merchant_id, name, sort_order) values
  ('ed000000-0000-4000-8000-000000000061', 'ed000000-0000-4000-8000-000000000021', '一般會員', 0),
  ('ed000000-0000-4000-8000-000000000062', 'ed000000-0000-4000-8000-000000000021', 'VIP 會員', 1);

select ok(
  (select count(*)::int from merchant_member_tiers where merchant_id = 'ed000000-0000-4000-8000-000000000021') = 2,
  '#615①:商家管理員可以新增會員等級(直接 RLS INSERT,比照 payment_methods 既有模式)'
);

select throws_ok(
  $$insert into merchant_member_tiers (merchant_id, name) values ('ed000000-0000-4000-8000-000000000021', '一般會員')$$,
  '23505', null,
  '#615:同商家同名(且都是 active)的等級被唯一索引擋下'
);

select throws_ok(
  $$insert into merchant_member_tiers (merchant_id, name, status) values ('ed000000-0000-4000-8000-000000000021', '亂填狀態', 'bogus')$$,
  '23514', null,
  '#615:status 只能是 active/removed(CHECK 約束)'
);

-- 只有 members 權限(沒有 member_settings)的客服可以 SELECT 到等級清單(逐一指派時要看得到),
-- 但不能新增/編輯。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000003');

select is(
  (select count(*)::int from merchant_member_tiers where merchant_id = 'ed000000-0000-4000-8000-000000000021'),
  2,
  '#615:只有 members 權限的客服可以 SELECT 到會員等級清單(RLS 同時放行 can_manage_members)'
);

select throws_ok(
  $$insert into merchant_member_tiers (merchant_id, name) values ('ed000000-0000-4000-8000-000000000021', '客服嘗試新增')$$,
  '42501', null,
  '#615:只有 members 權限(沒有 member_settings)的客服不能新增會員等級(等級清單管理歸 member_settings)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② §10.3:create_member/update_member 疊加 p_tier_id 驗證。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');

select id from create_member(
  'ed000000-0000-4000-8000-000000000021', '分級測試會員甲', '0933000001',
  p_tier_id => 'ed000000-0000-4000-8000-000000000062'
) \gset tier_member_

select is(
  (select tier_id from members where id = :'tier_member_id'::uuid),
  'ed000000-0000-4000-8000-000000000062'::uuid,
  '#615②:create_member 正確指派 p_tier_id'
);

select throws_ok(
  format($$select create_member('ed000000-0000-4000-8000-000000000021', '找不到等級測試', '0933000002', p_tier_id => '%s')$$, gen_random_uuid()),
  'P0001', null,
  '#615:create_member 指定不存在的 tier_id 被擋下'
);

-- 跨商家的等級被擋下。
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');
insert into merchant_member_tiers (id, merchant_id, name) values
  ('ed000000-0000-4000-8000-000000000063', 'ed000000-0000-4000-8000-000000000022', 'B店等級');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');

select throws_ok(
  $$select create_member('ed000000-0000-4000-8000-000000000021', '跨商家等級測試', '0933000003', p_tier_id => 'ed000000-0000-4000-8000-000000000063')$$,
  'P0001', null,
  '#615:create_member 指定別間商家的 tier_id 被擋下'
);

-- update_member 重新指派等級(含清空成未分級)。
select update_member(:'tier_member_id'::uuid, '分級測試會員甲', '0933000001', null, null, null, 'ed000000-0000-4000-8000-000000000061');

select is(
  (select tier_id from members where id = :'tier_member_id'::uuid),
  'ed000000-0000-4000-8000-000000000061'::uuid,
  '#615②:update_member 正確重新指派等級'
);

select update_member(:'tier_member_id'::uuid, '分級測試會員甲', '0933000001', null, null, null, null);

select is(
  (select tier_id from members where id = :'tier_member_id'::uuid),
  null::uuid,
  '#615②:update_member 傳 null 正確清空成未分級'
);

-- =========================================================================
-- ③ §10.3:下架某個等級後,既有會員的 tier_id 不受影響(不會被自動清空)。
-- =========================================================================
select update_member(:'tier_member_id'::uuid, '分級測試會員甲', '0933000001', null, null, null, 'ed000000-0000-4000-8000-000000000062');

update merchant_member_tiers set status = 'removed'
where id = 'ed000000-0000-4000-8000-000000000062';

select is(
  (select tier_id from members where id = :'tier_member_id'::uuid),
  'ed000000-0000-4000-8000-000000000062'::uuid,
  '#615③:下架某個等級後,既有會員的 tier_id 不受影響(不會被自動清空為 null)'
);

-- 下架後的等級不能再被新指派給其他會員(create_member 檢查 status=active)。
select throws_ok(
  $$select create_member('ed000000-0000-4000-8000-000000000021', '嘗試指派已下架等級', '0933000004', p_tier_id => 'ed000000-0000-4000-8000-000000000062')$$,
  'P0001', null,
  '#615:已下架的等級不能再被新指派給其他會員'
);

-- =========================================================================
-- ④ §10.4:set_member_blacklist_status。
-- =========================================================================
select id from create_member('ed000000-0000-4000-8000-000000000021', '黑名單測試會員', '0933000005') \gset blacklist_member_

select throws_ok(
  format($$select set_member_blacklist_status('%s', true, null)$$, (:'blacklist_member_id')),
  'P0001', null,
  '#616:列入黑名單時 p_reason 必填,沒填被擋下'
);

select throws_ok(
  format($$select set_member_blacklist_status('%s', true, '')$$, (:'blacklist_member_id')),
  'P0001', null,
  '#616:列入黑名單時 p_reason 為空字串一樣被擋下'
);

select set_member_blacklist_status(:'blacklist_member_id'::uuid, true, '積欠款項未結清');

select ok(
  (select is_blacklisted from members where id = :'blacklist_member_id'::uuid) = true
  and (select blacklist_reason from members where id = :'blacklist_member_id'::uuid) = '積欠款項未結清'
  and (select blacklisted_at from members where id = :'blacklist_member_id'::uuid) is not null,
  '#616④:列入黑名單正確寫入 is_blacklisted/blacklist_reason/blacklisted_at'
);

select set_member_blacklist_status(:'blacklist_member_id'::uuid, false);

select ok(
  (select is_blacklisted from members where id = :'blacklist_member_id'::uuid) = false
  and (select blacklist_reason from members where id = :'blacklist_member_id'::uuid) is null
  and (select blacklisted_at from members where id = :'blacklist_member_id'::uuid) is null
  and (select blacklisted_by_user_id from members where id = :'blacklist_member_id'::uuid) is null,
  '#616④:解除黑名單正確清空 is_blacklisted/blacklist_reason/blacklisted_at/blacklisted_by_user_id'
);

select pg_temp.test_clear_auth();

-- 權限:被授權 members(不需要更高權限)的客服可以操作,對照規則 2.10 精神(不是最高權限敏感操作)。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000003');
select lives_ok(
  format($$select set_member_blacklist_status('%s', true, '客服操作測試')$$, (:'blacklist_member_id')),
  '#616:被授權 members 的客服可以操作黑名單狀態(不像 adjust_member_points 限定管理員)'
);
select pg_temp.test_clear_auth();

-- 跨商家:B 商家管理員不能操作 A 商家的會員黑名單狀態。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');
select throws_ok(
  format($$select set_member_blacklist_status('%s', true, '跨商家測試')$$, (:'blacklist_member_id')),
  '42501', null,
  '#616:B 商家管理員不能操作 A 商家會員的黑名單狀態'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ §10.2.1:get_members_by_phone 正確回傳 is_blacklisted 標記。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');

select ok(
  exists (
    select 1 from jsonb_array_elements(get_members_by_phone('ed000000-0000-4000-8000-000000000021', '0933000005')) elem
    where (elem ->> 'member_id')::uuid = :'blacklist_member_id'::uuid
      and (elem ->> 'is_blacklisted')::boolean = true
  ),
  '#614/#616:get_members_by_phone 正確回傳這位會員目前的 is_blacklisted 標記'
);

select pg_temp.test_clear_auth();

select * from finish();
rollback;
