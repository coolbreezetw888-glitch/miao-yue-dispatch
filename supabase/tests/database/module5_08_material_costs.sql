-- 建單功能擴充規格書 2.3/決策記錄 4:料錢成本兩層權限(商家開關 material_cost_enabled +
-- material_costs section_key 客服授權)、建單/編輯時的開關驗證。
begin;

select plan(10);

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
  ('b8000000-0000-4000-8000-000000000001', 'pgtap-m5x-admin@test.local'),
  ('b8000000-0000-4000-8000-000000000002', 'pgtap-m5x-agent-none@test.local'),
  ('b8000000-0000-4000-8000-000000000003', 'pgtap-m5x-agent-mc@test.local');

insert into groups (id) values ('b8000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000010', '料錢成本測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000001');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('b8000000-0000-4000-8000-000000000020', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('b8000000-0000-4000-8000-000000000030', 'b8000000-0000-4000-8000-000000000020', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('b8000000-0000-4000-8000-000000000040', 'b8000000-0000-4000-8000-000000000020', '服務人員', null, true);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('b8000000-0000-4000-8000-000000000051', 'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-m5x-agent-none@test.local', 'active', now()),
  ('b8000000-0000-4000-8000-000000000052', 'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000003', '客服-料錢成本', 'pgtap-m5x-agent-mc@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('b8000000-0000-4000-8000-000000000052', 'material_costs', true);

select pg_temp.test_set_auth('b8000000-0000-4000-8000-000000000001');

-- ① 商家管理員新增一個料錢成本品項。
insert into material_cost_items (id, merchant_id, name, amount)
values ('b8000000-0000-4000-8000-000000000060', 'b8000000-0000-4000-8000-000000000020', '染劑', 200);

-- ② 功能關閉時(查無資料視為關閉,規格書 2.3 第一層:預設值關閉),create_booking 帶入料錢成本
--    品項應該被擋下。
select throws_ok(
  $$select create_booking(
    'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
    array['b8000000-0000-4000-8000-000000000030']::uuid[], '2026-09-22 10:00:00+08',
    '客戶一', '0977000001', null, null, '{}',
    array['b8000000-0000-4000-8000-000000000060']::uuid[]
  )$$,
  'P0001', null,
  '規格書 2.3:material_cost_enabled 查無資料視為關閉,帶入料錢成本品項時被擋下'
);

-- ③ 明確關閉 material_cost_enabled,同樣應該被擋下。
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('b8000000-0000-4000-8000-000000000020', 'material_cost_enabled', false);

select throws_ok(
  $$select create_booking(
    'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
    array['b8000000-0000-4000-8000-000000000030']::uuid[], '2026-09-22 10:00:00+08',
    '客戶二', '0977000002', null, null, '{}',
    array['b8000000-0000-4000-8000-000000000060']::uuid[]
  )$$,
  'P0001', null,
  '規格書 2.3:material_cost_enabled 明確關閉時,帶入料錢成本品項被擋下'
);

-- ④ 開啟功能後,商家管理員建單帶入料錢成本品項應該成功,且金額有正確快照。
update merchant_feature_flags set enabled = true
where merchant_id = 'b8000000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';

select id from create_booking(
  'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
  array['b8000000-0000-4000-8000-000000000030']::uuid[], '2026-09-22 10:00:00+08',
  '客戶三', '0977000003', null, null, '{}',
  array['b8000000-0000-4000-8000-000000000060']::uuid[]
) \gset booking_

select is(
  (select amount_snapshot from booking_material_costs where booking_id = :'booking_id'::uuid),
  200.00,
  '規格書 2.3:開啟功能後建單帶入料錢成本品項成功,amount_snapshot 正確快照品項金額'
);

-- ⑤ 同一筆預約不能重複選同一個料錢成本品項。
select throws_ok(
  format(
    $$select create_booking(
      'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
      array['b8000000-0000-4000-8000-000000000030']::uuid[], '2026-09-22 11:00:00+08',
      '客戶四', '0977000004', null, null, '{}',
      array['%1$s', '%1$s']::uuid[]
    )$$,
    'b8000000-0000-4000-8000-000000000060'
  ),
  'P0001', null,
  '規格書 2.3:同一個料錢成本品項不能在同一筆預約裡選取兩次'
);

-- ⑥ 找不到料錢成本品項(id 不存在,或已下架)應該被擋下。品項先軟刪除。
update material_cost_items set status = 'removed' where id = 'b8000000-0000-4000-8000-000000000060';

select throws_ok(
  $$select create_booking(
    'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
    array['b8000000-0000-4000-8000-000000000030']::uuid[], '2026-09-22 12:00:00+08',
    '客戶五', '0977000005', null, null, '{}',
    array['b8000000-0000-4000-8000-000000000060']::uuid[]
  )$$,
  'P0001', null,
  '規格書 2.3:找不到料錢成本品項(已下架)時被擋下'
);

-- 重新上架,供後面的權限測試使用。
update material_cost_items set status = 'active' where id = 'b8000000-0000-4000-8000-000000000060';

select pg_temp.test_clear_auth();

-- ⑦ 無授權客服(沒有 material_costs)不能新增料錢成本品項。
select pg_temp.test_set_auth('b8000000-0000-4000-8000-000000000002');

select throws_ok(
  $$insert into material_cost_items (merchant_id, name, amount)
    values ('b8000000-0000-4000-8000-000000000020', '無授權客服嘗試新增', 100)$$,
  '42501', null,
  '規則 4.4:無授權 material_costs 的客服不能新增料錢成本品項'
);

-- ⑧ 無授權客服(但有 orders 隱含在 create_booking 需要另外授權,這裡先確認她沒有 orders 也不能建單)
--    ——先確認「勾選既有品項不需要 material_costs 權限,但需要 orders 權限」這件事:
--    這位客服沒有 orders,建單本身就先被 can_manage_bookings 擋下,不是被料錢成本開關擋下。
select throws_ok(
  $$select create_booking(
    'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
    array['b8000000-0000-4000-8000-000000000030']::uuid[], '2026-09-22 13:00:00+08',
    '客戶六', '0977000006', null, null, '{}',
    array['b8000000-0000-4000-8000-000000000060']::uuid[]
  )$$,
  '42501', null,
  '沒有 orders 權限的客服本來就不能建單(跟料錢成本開關無關,先被 can_manage_bookings 擋下)'
);

select pg_temp.test_clear_auth();

-- ⑨ 被授權 material_costs 的客服:可以新增/編輯料錢成本品項。
select pg_temp.test_set_auth('b8000000-0000-4000-8000-000000000003');

select lives_ok(
  $$insert into material_cost_items (merchant_id, name, amount)
    values ('b8000000-0000-4000-8000-000000000020', '被授權客服新增的品項', 150)$$,
  '規則 4.4:被授權 material_costs 的客服可以新增料錢成本品項'
);

-- ⑩ 被授權 material_costs 的客服可以下架(軟刪除)品項。
select lives_ok(
  $$update material_cost_items set status = 'removed'
    where merchant_id = 'b8000000-0000-4000-8000-000000000020' and name = '被授權客服新增的品項'$$,
  '規則 3.1/4.5:被授權 material_costs 的客服可以軟刪除(下架)料錢成本品項'
);

select pg_temp.test_clear_auth();

-- ⑪ 規則 4.5:material_cost_items 沒有 DELETE 政策,真刪除應該 0 筆受影響。
select pg_temp.test_set_auth('b8000000-0000-4000-8000-000000000001');

delete from material_cost_items where id = 'b8000000-0000-4000-8000-000000000060';

select is(
  (select count(*)::int from material_cost_items where id = 'b8000000-0000-4000-8000-000000000060'),
  1,
  '規則 4.5/3.1:material_cost_items 沒有 DELETE 政策,對品項執行 DELETE 沒有真的刪掉'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
