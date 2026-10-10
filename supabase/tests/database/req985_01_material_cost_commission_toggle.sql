-- SPECS-INDEX #985 第 8 批(2026-10-07):料錢影響服務人員抽成開關 + 順手修「保留原有料錢品項」
-- migration 20261007110000_req985_material_cost_commission_setting_rpcs.sql
--           20261007110100_req985_keep_existing_material_cost_items.sql
-- 規格書 .project/specs/料錢是否影響抽成開關-第8批.md 8-5 / 8-6 / 8-7、第八節。
--
--   ①~⑥    ACL:兩支 RPC 對 public / anon 無 EXECUTE、authenticated 有
--   ⑦~⑬    8-5 讀取:查無設定列 ⇒ 關閉;管理員 / 料錢客服 / 抽成客服可讀且 can_edit 正確;
--            無鑰匙客服、服務人員、別家管理員、未登入 ⇒ 42501
--   ⑭~㉒   8-6 寫入:料錢客服(只有料錢鑰匙)、無鑰匙客服、服務人員、別家管理員、未登入 ⇒ 42501;
--            null ⇒ 拒絕;查無列時新增;抽成客服可寫;只動 commission_basis_type
--   ㉓~㉘   引擎未動:範例 A / B / C 開關開與關各完成一筆,抽成與快照數字 = 規格書第五節
--   ㉙~㉛   快照制:開啟時完成 ⇒ 切關閉後快照不變 ⇒ 手動重算 ⇒ 變不扣料錢
--   ㉜~㊵   順手修:編輯訂單時原有料錢品項已下架 / 功能已關 ⇒ 服務人員與管理員都能存、快照保留;
--   ㊶㊷    #986 第 9 批補釘:只放寬「這一筆訂單原本就有」的已下架品項(別張單的不行、拿掉後再加回不行);
--            新加的品項照舊檢查(功能關、已下架、別家品項);新建訂單照舊檢查
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(42);

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

-- ── Fixture ───────────────────────────────────────────────────────────────
--   使用者:01 A 店管理員 / 02 客服(只有料錢成本管理)/ 03 客服(只有抽成與薪資設定)/
--           04 客服(沒有鑰匙)/ 05 服務人員 P(可以自己下單)/ 06 B 店管理員
insert into auth.users (id, email) values
  ('f9850000-0000-4000-8000-000000000001', 'pgtap-r985-admin@test.local'),
  ('f9850000-0000-4000-8000-000000000002', 'pgtap-r985-agent-mc@test.local'),
  ('f9850000-0000-4000-8000-000000000003', 'pgtap-r985-agent-cs@test.local'),
  ('f9850000-0000-4000-8000-000000000004', 'pgtap-r985-agent-none@test.local'),
  ('f9850000-0000-4000-8000-000000000005', 'pgtap-r985-staff@test.local'),
  ('f9850000-0000-4000-8000-000000000006', 'pgtap-r985-adminB@test.local');

insert into groups (id) values
  ('f9850000-0000-4000-8000-000000000011'),
  ('f9850000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f9850000-0000-4000-8000-000000000020', 'f9850000-0000-4000-8000-000000000011', '#985 A 店', 'on_site_dispatch'),
  ('f9850000-0000-4000-8000-000000000021', 'f9850000-0000-4000-8000-000000000012', '#985 B 店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f9850000-0000-4000-8000-000000000020', 'f9850000-0000-4000-8000-000000000001', '店主甲'),
  ('f9850000-0000-4000-8000-000000000021', 'f9850000-0000-4000-8000-000000000006', '店主乙');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9850000-0000-4000-8000-000000000022', 'f9850000-0000-4000-8000-000000000020', 'f9850000-0000-4000-8000-000000000002', '料錢客服', 'pgtap-r985-agent-mc@test.local', 'active', now(), '0900985022'),
  ('f9850000-0000-4000-8000-000000000023', 'f9850000-0000-4000-8000-000000000020', 'f9850000-0000-4000-8000-000000000003', '抽成客服', 'pgtap-r985-agent-cs@test.local', 'active', now(), '0900985023'),
  ('f9850000-0000-4000-8000-000000000024', 'f9850000-0000-4000-8000-000000000020', 'f9850000-0000-4000-8000-000000000004', '無鑰匙客服', 'pgtap-r985-agent-none@test.local', 'active', now(), '0900985024');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9850000-0000-4000-8000-000000000022', 'material_costs', true),
  ('f9850000-0000-4000-8000-000000000023', 'commission_settings', true),
  ('f9850000-0000-4000-8000-000000000024', 'orders', true);

-- 服務項目:S1 3000(40%)、S2 2000(40%)、S3 1000(固定 300)、S4 400(40%)、S5 800(管理員 / 服務人員編輯用)。
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9850000-0000-4000-8000-000000000031', 'f9850000-0000-4000-8000-000000000020', 'S1', 3000, 'primary', 60),
  ('f9850000-0000-4000-8000-000000000032', 'f9850000-0000-4000-8000-000000000020', 'S2', 2000, 'primary', 60),
  ('f9850000-0000-4000-8000-000000000033', 'f9850000-0000-4000-8000-000000000020', 'S3', 1000, 'primary', 30),
  ('f9850000-0000-4000-8000-000000000034', 'f9850000-0000-4000-8000-000000000020', 'S4', 400, 'primary', 30),
  ('f9850000-0000-4000-8000-000000000035', 'f9850000-0000-4000-8000-000000000020', 'S5', 800, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9850000-0000-4000-8000-000000000050', 'f9850000-0000-4000-8000-000000000020', '現金');
-- 料錢:M500、M600、M_old(之後下架)、M_new(新加用)、M_off(已下架,新加用)、B 店的 MB。
insert into material_cost_items (id, merchant_id, name, amount, status) values
  ('f9850000-0000-4000-8000-000000000060', 'f9850000-0000-4000-8000-000000000020', 'M500', 500, 'active'),
  ('f9850000-0000-4000-8000-000000000061', 'f9850000-0000-4000-8000-000000000020', 'M600', 600, 'active'),
  ('f9850000-0000-4000-8000-000000000062', 'f9850000-0000-4000-8000-000000000020', 'M_old', 120, 'active'),
  ('f9850000-0000-4000-8000-000000000063', 'f9850000-0000-4000-8000-000000000020', 'M_new', 80, 'active'),
  ('f9850000-0000-4000-8000-000000000064', 'f9850000-0000-4000-8000-000000000020', 'M_off', 90, 'removed'),
  ('f9850000-0000-4000-8000-000000000065', 'f9850000-0000-4000-8000-000000000021', 'MB', 70, 'active');
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('f9850000-0000-4000-8000-000000000020', 'material_cost_enabled', true),
  ('f9850000-0000-4000-8000-000000000021', 'material_cost_enabled', true);

-- 服務人員 P:按件計酬、可以自己下單、後台編輯無時段限制(建單不用布置時段)。
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone, can_create_edit_orders, show_member_info) values
  ('f9850000-0000-4000-8000-000000000040', 'f9850000-0000-4000-8000-000000000020', 'f9850000-0000-4000-8000-000000000005', '服務人員P', 'piece_rate', 'active', 'active', now(), true, '0900985040', true, true);
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9850000-0000-4000-8000-000000000040', 'staff_calendar_view', true);
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('f9850000-0000-4000-8000-000000000040', 'f9850000-0000-4000-8000-000000000031', 'percentage', 40),
  ('f9850000-0000-4000-8000-000000000040', 'f9850000-0000-4000-8000-000000000032', 'percentage', 40),
  ('f9850000-0000-4000-8000-000000000040', 'f9850000-0000-4000-8000-000000000033', 'fixed_amount', 300),
  ('f9850000-0000-4000-8000-000000000040', 'f9850000-0000-4000-8000-000000000034', 'percentage', 40);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9850000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

-- 管理員建單:服務項目用原價、數量 1。
create function pg_temp.mk(p_items uuid[], p_materials uuid[], p_start timestamptz)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9850000-0000-4000-8000-000000000020',
    p_staff_id => 'f9850000-0000-4000-8000-000000000040',
    p_service_items => (
      select jsonb_agg(jsonb_build_object('service_item_id', si.id, 'quantity', 1, 'unit_price', si.price))
      from public.service_items si where si.id = any(p_items)
    ),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955985000',
    p_customer_address => '台北市測試路 85 號',
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end,
    p_payment_method_id => 'f9850000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid[], uuid[], timestamptz) to authenticated;

create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;
grant execute on function pg_temp.done(uuid) to authenticated;

create function pg_temp.rec(p_booking uuid)
returns text language sql as $$
  select commission_amount::text || '/' || material_cost_deducted_snapshot::text || '/' || commission_basis_type_snapshot
  from public.booking_commission_records where booking_id = p_booking;
$$;

-- =========================================================================
-- ①~⑥ ACL
-- =========================================================================
select ok(not has_function_privilege('anon', 'public.get_material_cost_commission_setting(uuid)', 'execute'), '① 讀取 RPC:anon 沒有 EXECUTE');
select ok(not has_function_privilege('anon', 'public.set_material_cost_affects_commission(uuid, boolean)', 'execute'), '② 寫入 RPC:anon 沒有 EXECUTE');
select ok(has_function_privilege('authenticated', 'public.get_material_cost_commission_setting(uuid)', 'execute'), '③ 讀取 RPC:authenticated 有 EXECUTE');
select ok(has_function_privilege('authenticated', 'public.set_material_cost_affects_commission(uuid, boolean)', 'execute'), '④ 寫入 RPC:authenticated 有 EXECUTE');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'public.get_material_cost_commission_setting(uuid)'::regprocedure and a.grantee = 0),
  0, '⑤ 讀取 RPC:public 沒有 EXECUTE');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
   where p.oid = 'public.set_material_cost_affects_commission(uuid, boolean)'::regprocedure and a.grantee = 0),
  0, '⑥ 寫入 RPC:public 沒有 EXECUTE');

-- =========================================================================
-- ⑦~⑬ 8-5 讀取(A 店此時沒有 merchant_payroll_settings 列)
-- =========================================================================
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select is(public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020'),
  '{"affects_commission": false, "can_edit": true}'::jsonb, '⑦ 管理員:查無設定列 ⇒ 關閉、可以改');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000002');
select is(public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020'),
  '{"affects_commission": false, "can_edit": false}'::jsonb, '⑧ 只有料錢鑰匙的客服:看得到、不能改');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000003');
select is(public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020'),
  '{"affects_commission": false, "can_edit": true}'::jsonb, '⑨ 只有抽成鑰匙的客服:看得到、可以改');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000004');
select throws_ok($$select public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020')$$,
  '42501', '沒有權限查看這間商家的料錢設定', '⑩ 沒有鑰匙的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000005');
select throws_ok($$select public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020')$$,
  '42501', '沒有權限查看這間商家的料錢設定', '⑪ 服務人員 ⇒ 42501');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000006');
select throws_ok($$select public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020')$$,
  '42501', '沒有權限查看這間商家的料錢設定', '⑫ 別家商家管理員 ⇒ 42501');
select pg_temp.test_clear_auth();
set local role anon;
select throws_ok($$select public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020')$$,
  '42501', NULL, '⑬ 未登入(anon)⇒ 42501');
reset role;

-- =========================================================================
-- ⑭~㉒ 8-6 寫入
-- =========================================================================
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000002');
select throws_ok($$select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true)$$,
  '42501', '只有商家管理員或有「抽成與薪資設定」權限的人可以修改這個開關', '⑭ 只有料錢鑰匙的客服不能改 ⇒ 42501(不擴權)');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000004');
select throws_ok($$select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true)$$,
  '42501', '只有商家管理員或有「抽成與薪資設定」權限的人可以修改這個開關', '⑮ 沒有鑰匙的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000005');
select throws_ok($$select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true)$$,
  '42501', '只有商家管理員或有「抽成與薪資設定」權限的人可以修改這個開關', '⑯ 服務人員 ⇒ 42501');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000006');
select throws_ok($$select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true)$$,
  '42501', '只有商家管理員或有「抽成與薪資設定」權限的人可以修改這個開關', '⑰ 別家商家管理員 ⇒ 42501');
select pg_temp.test_clear_auth();
set local role anon;
select throws_ok($$select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true)$$,
  '42501', NULL, '⑱ 未登入(anon)⇒ 42501');
reset role;
select is((select count(*)::int from merchant_payroll_settings where merchant_id = 'f9850000-0000-4000-8000-000000000020'),
  0, '⑲ 上面被擋的寫入一筆都沒寫進去(仍然查無設定列)');

select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select throws_ok($$select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', null)$$,
  '22023', '請指定要開啟或關閉', '⑳ p_enabled 為 null ⇒ 拒絕');
select is(public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true),
  '{"affects_commission": true}'::jsonb, '㉑ 管理員開啟(查無列 ⇒ 新增)回傳新值');
select pg_temp.test_clear_auth();
create temp table r985_created on commit drop as
  select created_at from merchant_payroll_settings where merchant_id = 'f9850000-0000-4000-8000-000000000020';
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000003');
select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', false);
select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', true);
select pg_temp.test_clear_auth();
select is(
  (select mps.commission_basis_type || '/' || (mps.created_at = c.created_at)::text
   from merchant_payroll_settings mps, r985_created c
   where mps.merchant_id = 'f9850000-0000-4000-8000-000000000020'),
  'net_of_material_cost/true', '㉒ 抽成鑰匙客服可以改;只動 commission_basis_type(created_at 不變)');

-- =========================================================================
-- ㉓~㉘ 引擎未動:範例 A / B / C(規格書第五節)。此時開關 = 開啟。
-- =========================================================================
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000031'::uuid], array['f9850000-0000-4000-8000-000000000060'::uuid], '2036-06-01 09:00+08') as id \gset ao_
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000032'::uuid, 'f9850000-0000-4000-8000-000000000033'::uuid], array['f9850000-0000-4000-8000-000000000060'::uuid], '2036-06-01 11:00+08') as id \gset bo_
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000034'::uuid], array['f9850000-0000-4000-8000-000000000061'::uuid], '2036-06-01 14:00+08') as id \gset co_
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000031'::uuid], array['f9850000-0000-4000-8000-000000000060'::uuid], '2036-06-02 09:00+08') as id \gset ac_
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000032'::uuid, 'f9850000-0000-4000-8000-000000000033'::uuid], array['f9850000-0000-4000-8000-000000000060'::uuid], '2036-06-02 11:00+08') as id \gset bc_
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000034'::uuid], array['f9850000-0000-4000-8000-000000000061'::uuid], '2036-06-02 14:00+08') as id \gset cc_
select pg_temp.done(:'ao_id'::uuid);
select pg_temp.done(:'bo_id'::uuid);
select pg_temp.done(:'co_id'::uuid);
select public.set_material_cost_affects_commission('f9850000-0000-4000-8000-000000000020', false);
select pg_temp.done(:'ac_id'::uuid);
select pg_temp.done(:'bc_id'::uuid);
select pg_temp.done(:'cc_id'::uuid);
select pg_temp.test_clear_auth();

select is(pg_temp.rec(:'ao_id'::uuid), '1000.00/500.00/net_of_material_cost', '㉓ 範例 A 開啟:抽成 1,000、快照扣料錢 500');
select is(pg_temp.rec(:'ac_id'::uuid), '1200.00/0.00/gross', '㉔ 範例 A 關閉:抽成 1,200、快照扣料錢 0');
select is(pg_temp.rec(:'bo_id'::uuid), '966.67/500.00/net_of_material_cost', '㉕ 範例 B 開啟:合計 966.67(固定 300 不受影響)');
select is(pg_temp.rec(:'bc_id'::uuid), '1100.00/0.00/gross', '㉖ 範例 B 關閉:合計 1,100');
select is(pg_temp.rec(:'co_id'::uuid), '0.00/600.00/net_of_material_cost', '㉗ 範例 C 開啟:料錢比訂單貴 ⇒ 抽成 0');
select is(pg_temp.rec(:'cc_id'::uuid), '160.00/0.00/gross', '㉘ 範例 C 關閉:抽成 160');

-- =========================================================================
-- ㉙~㉛ 快照制
-- =========================================================================
select is(pg_temp.rec(:'ao_id'::uuid), '1000.00/500.00/net_of_material_cost', '㉙ 切到關閉之後,開啟時完成的那筆快照不變');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select is((select public.get_material_cost_commission_setting('f9850000-0000-4000-8000-000000000020') ->> 'affects_commission'),
  'false', '㉚ 讀取 RPC 反映目前設定 = 關閉');
select public.recalculate_booking_commission(:'ao_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.rec(:'ao_id'::uuid), '1200.00/0.00/gross', '㉛ 管理員手動重算 ⇒ 套用目前設定(不扣料錢)');

-- =========================================================================
-- ㉜~㊵ 順手修:原有料錢品項維持原值
-- =========================================================================
-- e1:管理員建單,帶 M_old(快照 120);之後商家把 M_old 改價 999 並下架。
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000035'::uuid], array['f9850000-0000-4000-8000-000000000062'::uuid], '2036-07-01 10:00+08') as id \gset e1_
select pg_temp.test_clear_auth();
update material_cost_items set status = 'removed', amount = 999 where id = 'f9850000-0000-4000-8000-000000000062';

create function pg_temp.sup(p_booking uuid, p_name text)
returns jsonb language sql as $$
  select public.staff_update_booking(
    p_booking_id => p_booking,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9850000-0000-4000-8000-000000000035','quantity',1,'unit_price',800)),
    p_start_at => '2036-07-01 10:00+08',
    p_customer_name => p_name,
    p_customer_phone => '0955985000',
    p_customer_address => '台北市測試路 85 號',
    p_payment_method_id => 'f9850000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.sup(uuid, text) to authenticated;

create function pg_temp.aup(p_booking uuid, p_materials uuid[])
returns uuid language sql as $$
  select id from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'f9850000-0000-4000-8000-000000000040',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9850000-0000-4000-8000-000000000035','quantity',1,'unit_price',800)),
    p_start_at => '2036-07-01 10:00+08',
    p_customer_name => '林小姐(管理員改)',
    p_customer_phone => '0955985000',
    p_customer_address => '台北市測試路 85 號',
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end,
    p_payment_method_id => 'f9850000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.aup(uuid, uuid[]) to authenticated;

select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000005');
select lives_ok(format($$select pg_temp.sup(%L, '林小姐(服務人員改1)')$$, :'e1_id'), '㉜ 原有料錢品項已下架 ⇒ 服務人員仍然能編輯這筆訂單');
select pg_temp.test_clear_auth();
select is(
  (select string_agg(material_cost_item_id::text || ':' || amount_snapshot::text, ',') from booking_material_costs where booking_id = :'e1_id'::uuid)
  || '/' || (select customer_name from bookings where id = :'e1_id'::uuid),
  'f9850000-0000-4000-8000-000000000062:120.00/林小姐(服務人員改1)', '㉝ 料錢品項與原金額快照保留(不吃改價後的 999),其他欄位有更新');

update merchant_feature_flags set enabled = false
where merchant_id = 'f9850000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000005');
select lives_ok(format($$select pg_temp.sup(%L, '林小姐(服務人員改2)')$$, :'e1_id'), '㉞ 商家關掉料錢成本功能 ⇒ 服務人員仍然能編輯(原有料錢保留)');
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select lives_ok(format($$select pg_temp.aup(%L, array['f9850000-0000-4000-8000-000000000062'::uuid])$$, :'e1_id'),
  '㉟ 商家端同樣情境(功能關 + 品項下架、原樣帶回)也能存');
select throws_ok(format($$select pg_temp.aup(%L, array['f9850000-0000-4000-8000-000000000062'::uuid, 'f9850000-0000-4000-8000-000000000063'::uuid])$$, :'e1_id'),
  'P0001', '這間商家尚未開啟料錢成本功能，無法選用料錢成本品項', '㊱ 功能關閉時「新加」品項照舊擋下');
select pg_temp.test_clear_auth();
update merchant_feature_flags set enabled = true
where merchant_id = 'f9850000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';
select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select throws_ok(format($$select pg_temp.aup(%L, array['f9850000-0000-4000-8000-000000000062'::uuid, 'f9850000-0000-4000-8000-000000000064'::uuid])$$, :'e1_id'),
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㊲ 「新加」已下架品項照舊擋下');
select throws_ok(format($$select pg_temp.aup(%L, array['f9850000-0000-4000-8000-000000000065'::uuid])$$, :'e1_id'),
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㊳ 別家商家的品項照舊擋下');
select throws_ok(
  $$select pg_temp.mk(array['f9850000-0000-4000-8000-000000000035'::uuid], array['f9850000-0000-4000-8000-000000000062'::uuid], '2036-07-02 10:00+08')$$,
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㊴ 新建訂單用已下架品項照舊擋下(不受放寬影響)');
select throws_ok(format($$select pg_temp.aup(%L, array['f9850000-0000-4000-8000-000000000062'::uuid, 'f9850000-0000-4000-8000-000000000062'::uuid])$$, :'e1_id'),
  'P0001', '同一個料錢成本品項不能在同一筆預約裡選取兩次', '㊵ 原有品項重複選取照舊擋下');
select pg_temp.test_clear_auth();

-- ㊶㊷ #986 第 9 批補釘(第 8 批 QA 建議):放寬只限「這一筆訂單原本就有」的已下架品項。
create function pg_temp.aup2(p_booking uuid, p_materials uuid[], p_start timestamptz)
returns uuid language sql as $$
  select id from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'f9850000-0000-4000-8000-000000000040',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9850000-0000-4000-8000-000000000035','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '林小姐(管理員改)',
    p_customer_phone => '0955985000',
    p_customer_address => '台北市測試路 85 號',
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end,
    p_payment_method_id => 'f9850000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.aup2(uuid, uuid[], timestamptz) to authenticated;

select pg_temp.test_set_auth('f9850000-0000-4000-8000-000000000001');
select pg_temp.mk(array['f9850000-0000-4000-8000-000000000035'::uuid], '{}'::uuid[], '2036-07-05 10:00+08') as id \gset e2_
select throws_ok(format($$select pg_temp.aup2(%L, array['f9850000-0000-4000-8000-000000000062'::uuid], '2036-07-05 10:00+08')$$, :'e2_id'),
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㊶ 訂單 A 上的已下架品項,加進訂單 B 照舊擋下');
select pg_temp.aup2(:'e1_id'::uuid, '{}'::uuid[], '2036-07-01 10:00+08');
select throws_ok(format($$select pg_temp.aup2(%L, array['f9850000-0000-4000-8000-000000000062'::uuid], '2036-07-01 10:00+08')$$, :'e1_id'),
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㊷ 已下架品項從訂單拿掉後再加回來照舊擋下');
select pg_temp.test_clear_auth();

select * from finish();
rollback;
