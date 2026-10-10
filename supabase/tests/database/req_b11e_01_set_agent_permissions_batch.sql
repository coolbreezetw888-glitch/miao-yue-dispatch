-- 第 11 批 E(#992,2026-10-07):public.set_agent_permissions 一次寫入多把客服權限、失敗全退。
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §11.7、§11.10 pgTAP 1~6。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(27);

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
--   1 A 店管理員 / 2 A 店客服(被設定的對象)/ 3 A 店服務人員 / 4 B 店管理員
-- =========================================================================
insert into auth.users (id, email) values
  ('b11e0000-0000-4000-8000-000000000001', 'pgtap-b11e-admin-a@test.local'),
  ('b11e0000-0000-4000-8000-000000000002', 'pgtap-b11e-agent-a@test.local'),
  ('b11e0000-0000-4000-8000-000000000003', 'pgtap-b11e-staff-a@test.local'),
  ('b11e0000-0000-4000-8000-000000000004', 'pgtap-b11e-admin-b@test.local');

insert into groups (id) values
  ('b11e0000-0000-4000-8000-000000000010'),
  ('b11e0000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('b11e0000-0000-4000-8000-000000000020', 'b11e0000-0000-4000-8000-000000000010', 'B11E A 店', 'in_store_beauty'),
  ('b11e0000-0000-4000-8000-000000000021', 'b11e0000-0000-4000-8000-000000000011', 'B11E B 店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('b11e0000-0000-4000-8000-000000000020', 'b11e0000-0000-4000-8000-000000000001'),
  ('b11e0000-0000-4000-8000-000000000021', 'b11e0000-0000-4000-8000-000000000004');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('b11e0000-0000-4000-8000-000000000052', 'b11e0000-0000-4000-8000-000000000020',
   'b11e0000-0000-4000-8000-000000000002', '客服甲', '0900110502', 'pgtap-b11e-agent-a@test.local', 'active');

insert into merchant_staff (id, merchant_id, user_id, name, phone) values
  ('b11e0000-0000-4000-8000-000000000041', 'b11e0000-0000-4000-8000-000000000020',
   'b11e0000-0000-4000-8000-000000000003', '服務人員甲', '0900110503');

-- 既有一列(material_costs = false、updated_at 刻意設成很久以前),用來驗「已存在的列被更新」。
insert into merchant_agent_permissions (agent_id, section_key, granted, updated_at) values
  ('b11e0000-0000-4000-8000-000000000052', 'material_costs', false, '2020-01-01 00:00+00');

create function pg_temp.perm(p_key text) returns boolean language sql as $$
  select granted from public.merchant_agent_permissions
  where agent_id = 'b11e0000-0000-4000-8000-000000000052' and section_key = p_key;
$$;

create function pg_temp.perm_snapshot() returns text language sql as $$
  select coalesce(string_agg(section_key || '=' || granted::text, ',' order by section_key), '')
  from public.merchant_agent_permissions
  where agent_id = 'b11e0000-0000-4000-8000-000000000052';
$$;

-- =========================================================================
-- 1. 商家管理員一次存 3 筆 ⇒ 3 列都寫入;已存在的列被更新、updated_at 變動
-- =========================================================================
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000001');

select lives_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"material_costs","granted":true},
      {"section_key":"commission_settings","granted":true},
      {"section_key":"team_leave","granted":true}]'::jsonb)$$,
  '1:商家管理員一次存 3 筆 ⇒ 成功'
);

select pg_temp.test_clear_auth();

select is(pg_temp.perm_snapshot(), 'commission_settings=true,material_costs=true,team_leave=true',
  '1:3 列都寫入、值正確');
select ok(
  (select updated_at > '2020-01-01 00:00+00'::timestamptz from merchant_agent_permissions
   where agent_id = 'b11e0000-0000-4000-8000-000000000052' and section_key = 'material_costs'),
  '1:已存在的列(material_costs)被更新、updated_at 變動'
);
select is(
  (select count(*)::int from merchant_agent_permissions
   where agent_id = 'b11e0000-0000-4000-8000-000000000052' and section_key = 'material_costs'),
  1,
  '1:已存在的列沒有被重複插入'
);

-- 一起關閉(同一個方向的 false)
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"team_leave","granted":false},
      {"section_key":"material_costs","granted":false},
      {"section_key":"commission_settings","granted":false}]'::jsonb)$$,
  '1:一起關閉 3 筆 ⇒ 成功'
);
select pg_temp.test_clear_auth();
select is(pg_temp.perm_snapshot(), 'commission_settings=false,material_costs=false,team_leave=false',
  '1:3 列都改成 false');

-- =========================================================================
-- 2. 原子性:3 筆裡第 3 筆格式錯 ⇒ raise,而且前 2 筆也沒寫入
-- =========================================================================
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"material_costs","granted":true},
      {"section_key":"members","granted":true},
      {"section_key":"member_points","granted":"yes"}]'::jsonb)$$,
  '22023', '權限變更的格式不正確。',
  '2:第 3 筆 granted 不是 boolean ⇒ 整批擋下'
);
select pg_temp.test_clear_auth();
select is(pg_temp.perm_snapshot(), 'commission_settings=false,material_costs=false,team_leave=false',
  '2:原子性:前 2 筆也沒有寫入(material_costs 仍是 false、members 沒有新增列)');

-- 寫入途中真的失敗(不是格式檢查擋下)也要整批回滾:用一個暫時的 trigger 讓第 2 筆的 insert 爆掉。
create function pg_temp.b11e_fail_on_members() returns trigger language plpgsql as $f$
begin
  if new.section_key = 'members' then
    raise exception 'pgTAP 故意讓這一筆寫入失敗';
  end if;
  return new;
end;
$f$;
create trigger b11e_fail_on_members before insert or update on public.merchant_agent_permissions
  for each row execute function pg_temp.b11e_fail_on_members();

select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"material_costs","granted":true},
      {"section_key":"members","granted":true},
      {"section_key":"team_leave","granted":true}]'::jsonb)$$,
  'P0001', 'pgTAP 故意讓這一筆寫入失敗',
  '2:寫入途中第 2 筆失敗 ⇒ 整批擋下'
);
select pg_temp.test_clear_auth();
select is(pg_temp.perm_snapshot(), 'commission_settings=false,material_costs=false,team_leave=false',
  '2:原子性:寫入途中失敗,第 1 筆(material_costs)也一起回滾');
drop trigger b11e_fail_on_members on public.merchant_agent_permissions;

-- =========================================================================
-- 3. 格式:同一 key 兩次 / 空陣列 / 不是陣列 / 超過 30 筆 / 空白 key / null ⇒ raise
-- =========================================================================
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"members","granted":true},{"section_key":"members","granted":false}]'::jsonb)$$,
  '22023', '同一個權限不能在一次變更裡出現兩次。',
  '3:同一個 section_key 出現兩次 ⇒ 擋下'
);
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052', '[]'::jsonb)$$,
  '22023', '權限變更的格式不正確，一次要有 1 到 30 筆。',
  '3:空陣列 ⇒ 擋下'
);
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '{"section_key":"members","granted":true}'::jsonb)$$,
  '22023', '權限變更的格式不正確。',
  '3:不是陣列(單一物件)⇒ 擋下'
);
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    (select jsonb_agg(jsonb_build_object('section_key', 'k' || g, 'granted', true))
     from generate_series(1, 31) g))$$,
  '22023', '權限變更的格式不正確，一次要有 1 到 30 筆。',
  '3:超過 30 筆 ⇒ 擋下'
);
select lives_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    (select jsonb_agg(jsonb_build_object('section_key', 'pgtap_k' || g, 'granted', false))
     from generate_series(1, 30) g))$$,
  '3:剛好 30 筆 ⇒ 放行(邊界)'
);
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"  ","granted":true}]'::jsonb)$$,
  '22023', '權限變更的格式不正確。',
  '3:section_key 是空白 ⇒ 擋下'
);
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052', null)$$,
  '22023', '權限變更的格式不正確。',
  '3:p_changes 是 null ⇒ 擋下'
);
select pg_temp.test_clear_auth();
delete from merchant_agent_permissions
where agent_id = 'b11e0000-0000-4000-8000-000000000052' and section_key like 'pgtap_k%';

-- =========================================================================
-- 4. 非該商家管理員 ⇒ 42501,資料不變
-- =========================================================================
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000004');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"members","granted":true}]'::jsonb)$$,
  '42501', '沒有權限執行此操作，僅限該商家管理員使用',
  '4:另一家商家的管理員 ⇒ 42501(跨商家擋下)'
);
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"members","granted":true}]'::jsonb)$$,
  '42501', '沒有權限執行此操作，僅限該商家管理員使用',
  '4:客服本人不能幫自己開權限 ⇒ 42501'
);
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-000000000052',
    '[{"section_key":"members","granted":true}]'::jsonb)$$,
  '42501', '沒有權限執行此操作，僅限該商家管理員使用',
  '4:同商家的服務人員 ⇒ 42501'
);
select pg_temp.test_clear_auth();
select is(pg_temp.perm_snapshot(), 'commission_settings=false,material_costs=false,team_leave=false',
  '4:三種被擋下的身分都沒有改到任何資料');

-- =========================================================================
-- 5. 找不到客服 ⇒ 既有訊息
-- =========================================================================
select pg_temp.test_set_auth('b11e0000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.set_agent_permissions('b11e0000-0000-4000-8000-0000000000ff',
    '[{"section_key":"members","granted":true}]'::jsonb)$$,
  'P0001', '找不到指定的客服紀錄：b11e0000-0000-4000-8000-0000000000ff',
  '5:找不到客服 ⇒ 沿用 set_agent_permission 的訊息'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- 6. ACL / 函式屬性 / 舊函式保留
-- =========================================================================
select ok(not has_function_privilege('anon', 'public.set_agent_permissions(uuid, jsonb)', 'execute'),
  '6:anon 沒有 EXECUTE');
select ok(has_function_privilege('authenticated', 'public.set_agent_permissions(uuid, jsonb)', 'execute'),
  '6:authenticated 有 EXECUTE');
select ok(
  not exists (
    select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.oid = 'public.set_agent_permissions(uuid, jsonb)'::regprocedure
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'
  ),
  '6:PUBLIC 沒有 EXECUTE'
);
select ok(
  (select prosecdef and proconfig = array['search_path=public'] from pg_proc
   where oid = 'public.set_agent_permissions(uuid, jsonb)'::regprocedure),
  '6:SECURITY DEFINER + search_path 固定成 public'
);
select is(
  (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
   where oid = 'public.set_agent_permission(uuid, text, boolean)'::regprocedure),
  '5a3cb8cf43d4a62cb0305da8f2a6245b',
  '6:舊的 set_agent_permission 仍存在且本體沒動(md5 不變)'
);

select * from finish();
rollback;
