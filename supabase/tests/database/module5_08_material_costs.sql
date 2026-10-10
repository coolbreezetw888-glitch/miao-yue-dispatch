-- 建單功能擴充規格書 2.3/決策記錄 4:料錢成本兩層權限(商家開關 material_cost_enabled +
-- material_costs section_key 客服授權)、建單/編輯時的開關驗證。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

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
values ('b8000000-0000-4000-8000-000000000040', 'b8000000-0000-4000-8000-000000000020', '服務人員', '0901000101', true);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('b8000000-0000-4000-8000-000000000051', 'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-m5x-agent-none@test.local', 'active', now(), '0900000101'),
  ('b8000000-0000-4000-8000-000000000052', 'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000003', '客服-料錢成本', 'pgtap-m5x-agent-mc@test.local', 'active', now(), '0900000102');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('b8000000-0000-4000-8000-000000000052', 'material_costs', true);

select pg_temp.test_set_auth('b8000000-0000-4000-8000-000000000001');

-- ① 商家管理員新增一個料錢成本品項。
insert into material_cost_items (id, merchant_id, name, amount)
values ('b8000000-0000-4000-8000-000000000060', 'b8000000-0000-4000-8000-000000000020', '染劑', 200);
-- SPECS-INDEX #604(2026-09-23 批次修正,機械性補參數,不改變測試本身要驗證的邏輯):
-- create_booking 新建訂單付款方式改為必填,下面既有的 create_booking/update_booking 呼叫
-- 補上 p_payment_method_id。
insert into payment_methods (id, merchant_id, name) values ('95d19684-2b7d-52a2-891d-d9df3c541bcf', 'b8000000-0000-4000-8000-000000000020', '現場付款');


-- ② 功能關閉時(查無資料視為關閉,規格書 2.3 第一層:預設值關閉),create_booking 帶入料錢成本
--    品項應該被擋下。
select throws_ok(
  $$select create_booking(
    'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b8000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶一', '0977000001', null, null, '{}',
    '[{"material_cost_item_id":"b8000000-0000-4000-8000-000000000060","quantity":1}]'::jsonb
  , p_payment_method_id => '95d19684-2b7d-52a2-891d-d9df3c541bcf')$$,
  'P0001', null,
  '規格書 2.3:material_cost_enabled 查無資料視為關閉,帶入料錢成本品項時被擋下'
);

-- ③ 明確關閉 material_cost_enabled,同樣應該被擋下。
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
values ('b8000000-0000-4000-8000-000000000020', 'material_cost_enabled', false);

select throws_ok(
  $$select create_booking(
    'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
    jsonb_build_array(jsonb_build_object('service_item_id','b8000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
    '客戶二', '0977000002', null, null, '{}',
    '[{"material_cost_item_id":"b8000000-0000-4000-8000-000000000060","quantity":1}]'::jsonb
  , p_payment_method_id => '95d19684-2b7d-52a2-891d-d9df3c541bcf')$$,
  'P0001', null,
  '規格書 2.3:material_cost_enabled 明確關閉時,帶入料錢成本品項被擋下'
);

-- ④ 開啟功能後,商家管理員建單帶入料錢成本品項應該成功,且金額有正確快照。
update merchant_feature_flags set enabled = true
where merchant_id = 'b8000000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';

select id from create_booking(
  'b8000000-0000-4000-8000-000000000020', 'b8000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','b8000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 10:00:00+08',
  '客戶三', '0977000003', null, null, '{}',
  '[{"material_cost_item_id":"b8000000-0000-4000-8000-000000000060","quantity":1}]'::jsonb
, p_payment_method_id => '95d19684-2b7d-52a2-891d-d9df3c541bcf') \gset booking_

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
      jsonb_build_array(jsonb_build_object('service_item_id','b8000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 11:00:00+08',
      '客戶四', '0977000004', null, null, '{}',
      '[{"material_cost_item_id":"%1$s","quantity":1},{"material_cost_item_id":"%1$s","quantity":1}]'::jsonb
    , p_payment_method_id => '95d19684-2b7d-52a2-891d-d9df3c541bcf')$$,
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
    jsonb_build_array(jsonb_build_object('service_item_id','b8000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 12:00:00+08',
    '客戶五', '0977000005', null, null, '{}',
    '[{"material_cost_item_id":"b8000000-0000-4000-8000-000000000060","quantity":1}]'::jsonb
  , p_payment_method_id => '95d19684-2b7d-52a2-891d-d9df3c541bcf')$$,
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
    jsonb_build_array(jsonb_build_object('service_item_id','b8000000-0000-4000-8000-000000000030','quantity',1,'unit_price',100)), '2026-09-22 13:00:00+08',
    '客戶六', '0977000006', null, null, '{}',
    '[{"material_cost_item_id":"b8000000-0000-4000-8000-000000000060","quantity":1}]'::jsonb
  , p_payment_method_id => '95d19684-2b7d-52a2-891d-d9df3c541bcf')$$,
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
