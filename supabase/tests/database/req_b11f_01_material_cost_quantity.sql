-- SPECS-INDEX #993 第 11 批 F(2026-10-07):建單 / 編輯訂單的料錢成本改成「數量 − +」與「自訂成本單價」
-- migration 20261007140300_b11_f_material_cost_quantity_and_unit_price.sql
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §十三(13.4 規則、13.7 測試)。
--
--   ①~②    建單 2 項:A ×3 原價、B ×1 自訂單價 12.5 ⇒ 兩列數量 / 單價正確
--   ③~④    編輯:A 數量改 5、單價不送 ⇒ 沿用舊快照(B2 回歸);品項改價後不動料錢再存 ⇒ 快照不變
--   ⑤~⑯    格式錯誤:數量 0 / 1000 / 1.5 / 字串 / 沒帶;單價 −1 / 字串 / 超過上限;同品項兩次;不是陣列;缺 id;id 格式錯
--   ⑰~⑳    已下架:新加 ⇒ 擋;單上既有 ⇒ 可保留、可改數量、可移除
--   ㉑~㉒    功能關閉:新加 ⇒ 擋;既有 ⇒ 保留
--   ㉓~㉕    抽成:net_of_material_cost 扣除額 = Σ 單價 × 數量;gross ⇒ 0;小數單價 round 結果與手算一致
--   ㉖~㉗    店家報表 total_material_cost = Σ 單價 × 數量(月 / 區間兩支)
--   ㉘~㉛    服務人員:staff_create_booking 帶數量 / 單價;staff_update_booking 不帶 ⇒ 數量單價都不變;帶 [] ⇒ 清空;
--            staff_get_booking_for_edit 多回 quantity
--   ㉜~㉝    既有資料:不寫 quantity 的列 = 1;數量 1 的單抽成與改前公式相同(範例 A)
--   ㉞~㊵    權限 / 結構:無 orders 客服 ⇒ 42501;別家品項 ⇒ 擋;沒開權限的服務人員 ⇒ 擋;helper 對 authenticated / anon 無 EXECUTE;
--            四支各只剩 1 個版本且都是新參數;CHECK:料錢數量 0、服務項目數量 1000 ⇒ 23514
--   ㊶~㊻    主腦裁決(防溢位):單一品項小計剛好 1,000,000 可以、多一點擋(有送單價 / 沒送單價兩條路都擋);
--            整張單合計剛好 9,999,999.99 可以、多一點擋;寫入後檢查的 helper 不開放給前端
begin;

select plan(46);

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
--   使用者:01 A 店管理員 / 02 A 店客服(沒有訂單管理)/ 05 服務人員 P(可以自己下單)/
--           07 服務人員 Q(沒開「新增編輯訂單」)
--   服務項目:S1 3000(P 抽 40%)
--   料錢:MA 500、MB 600、MOFF 90(已下架)、MX(B 店)
-- =========================================================================
insert into auth.users (id, email) values
  ('fb11f000-0000-4000-8000-000000000001', 'pgtap-b11f-admin@test.local'),
  ('fb11f000-0000-4000-8000-000000000002', 'pgtap-b11f-agent@test.local'),
  ('fb11f000-0000-4000-8000-000000000005', 'pgtap-b11f-staffP@test.local'),
  ('fb11f000-0000-4000-8000-000000000007', 'pgtap-b11f-staffQ@test.local');

insert into groups (id) values
  ('fb11f000-0000-4000-8000-000000000011'),
  ('fb11f000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('fb11f000-0000-4000-8000-000000000020', 'fb11f000-0000-4000-8000-000000000011', 'b11f A 店', 'on_site_dispatch'),
  ('fb11f000-0000-4000-8000-000000000021', 'fb11f000-0000-4000-8000-000000000012', 'b11f B 店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('fb11f000-0000-4000-8000-000000000020', 'fb11f000-0000-4000-8000-000000000001', '店主甲');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('fb11f000-0000-4000-8000-000000000022', 'fb11f000-0000-4000-8000-000000000020', 'fb11f000-0000-4000-8000-000000000002', '料錢客服', 'pgtap-b11f-agent@test.local', 'active', now(), '0900110022');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('fb11f000-0000-4000-8000-000000000022', 'material_costs', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('fb11f000-0000-4000-8000-000000000031', 'fb11f000-0000-4000-8000-000000000020', 'S1', 3000, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('fb11f000-0000-4000-8000-000000000050', 'fb11f000-0000-4000-8000-000000000020', '現金');
insert into material_cost_items (id, merchant_id, name, amount, status) values
  ('fb11f000-0000-4000-8000-000000000060', 'fb11f000-0000-4000-8000-000000000020', 'MA', 500, 'active'),
  ('fb11f000-0000-4000-8000-000000000061', 'fb11f000-0000-4000-8000-000000000020', 'MB', 600, 'active'),
  ('fb11f000-0000-4000-8000-000000000064', 'fb11f000-0000-4000-8000-000000000020', 'MOFF', 90, 'removed'),
  ('fb11f000-0000-4000-8000-000000000065', 'fb11f000-0000-4000-8000-000000000021', 'MX', 70, 'active');
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('fb11f000-0000-4000-8000-000000000020', 'material_cost_enabled', true),
  ('fb11f000-0000-4000-8000-000000000021', 'material_cost_enabled', true);

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone, can_create_edit_orders, show_member_info) values
  ('fb11f000-0000-4000-8000-000000000040', 'fb11f000-0000-4000-8000-000000000020', 'fb11f000-0000-4000-8000-000000000005', '服務人員P', 'piece_rate', 'active', 'active', now(), true, '0900110040', true, true),
  ('fb11f000-0000-4000-8000-000000000041', 'fb11f000-0000-4000-8000-000000000020', 'fb11f000-0000-4000-8000-000000000007', '服務人員Q', 'piece_rate', 'active', 'active', now(), true, '0900110041', false, true);
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('fb11f000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('fb11f000-0000-4000-8000-000000000041', 'staff_calendar_view', true);
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('fb11f000-0000-4000-8000-000000000040', 'fb11f000-0000-4000-8000-000000000031', 'percentage', 40),
  ('fb11f000-0000-4000-8000-000000000041', 'fb11f000-0000-4000-8000-000000000031', 'percentage', 40);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'fb11f000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

-- 管理員建單:服務項目 S1 原價 × 1,料錢由呼叫端給(jsonb 原樣)。
create function pg_temp.mk(p_materials jsonb, p_start timestamptz)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'fb11f000-0000-4000-8000-000000000020',
    p_staff_id => 'fb11f000-0000-4000-8000-000000000040',
    p_service_items => '[{"service_item_id":"fb11f000-0000-4000-8000-000000000031","quantity":1,"unit_price":3000}]'::jsonb,
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955110000',
    p_customer_address => '台北市測試路 11 號',
    p_material_cost_items => p_materials,
    p_payment_method_id => 'fb11f000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(jsonb, timestamptz) to authenticated;

-- 管理員改單(其餘欄位不變,只換料錢)。
create function pg_temp.up(p_booking uuid, p_materials jsonb)
returns uuid language sql as $$
  select id from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'fb11f000-0000-4000-8000-000000000040',
    p_service_items => '[{"service_item_id":"fb11f000-0000-4000-8000-000000000031","quantity":1,"unit_price":3000}]'::jsonb,
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => '林小姐',
    p_customer_phone => '0955110000',
    p_customer_address => '台北市測試路 11 號',
    p_material_cost_items => p_materials,
    p_payment_method_id => 'fb11f000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.up(uuid, jsonb) to authenticated;

-- 服務人員本人改單(p_materials = null ⇒ 不帶料錢)。
create function pg_temp.sup(p_booking uuid, p_materials jsonb, p_start timestamptz default '2036-07-04 09:00+08')
returns jsonb language sql as $$
  select public.staff_update_booking(
    p_booking_id => p_booking,
    p_service_items => '[{"service_item_id":"fb11f000-0000-4000-8000-000000000031","quantity":1,"unit_price":3000}]'::jsonb,
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955110000',
    p_customer_address => '台北市測試路 11 號',
    p_payment_method_id => 'fb11f000-0000-4000-8000-000000000050',
    p_material_cost_items => p_materials
  );
$$;
grant execute on function pg_temp.sup(uuid, jsonb, timestamptz) to authenticated;

-- 這張單的料錢:「名稱:數量×單價」依名稱排序。
create function pg_temp.mats(p_booking uuid)
returns text language sql as $$
  select coalesce(string_agg(mci.name || ':' || bmc.quantity || 'x' || bmc.amount_snapshot::text, ',' order by mci.name), '')
  from public.booking_material_costs bmc join public.material_cost_items mci on mci.id = bmc.material_cost_item_id
  where bmc.booking_id = p_booking;
$$;
grant execute on function pg_temp.mats(uuid) to authenticated;

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

-- 一段料錢 jsonb 的捷徑:id 後兩碼、數量、單價(null = 不送)。
create function pg_temp.m(p_suffix text, p_qty int, p_price numeric default null)
returns jsonb language sql immutable as $$
  select jsonb_build_object('material_cost_item_id', 'fb11f000-0000-4000-8000-0000000000' || p_suffix, 'quantity', p_qty, 'unit_price', p_price);
$$;
grant execute on function pg_temp.m(text, int, numeric) to authenticated;

-- =========================================================================
-- ①~④ 建單 / 編輯 / 改價後再存
-- =========================================================================
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000001');

select pg_temp.mk(jsonb_build_array(pg_temp.m('60', 3), pg_temp.m('61', 1, 12.5)), '2036-07-01 09:00+08') as id \gset b1_

select is(pg_temp.mats(:'b1_id'::uuid), 'MA:3x500.00,MB:1x12.50', '① 建單:MA ×3 原價 500、MB ×1 自訂單價 12.5');
select is((select sum(amount_snapshot * quantity) from public.booking_material_costs where booking_id = :'b1_id'::uuid),
  1512.50::numeric, '② 這張單料錢合計 = 500×3 + 12.5×1 = 1,512.5');

-- 編輯:MA 改 5 份、單價不送;MB 也不送單價 ⇒ 都沿用這張單原本的單價快照(MB 不能變回現價 600)。
select pg_temp.up(:'b1_id'::uuid, jsonb_build_array(pg_temp.m('60', 5), pg_temp.m('61', 1)));
select is(pg_temp.mats(:'b1_id'::uuid), 'MA:5x500.00,MB:1x12.50', '③ 編輯:數量改 5、單價不送 ⇒ 沿用舊快照(B2 回歸,自訂單價也保留)');

-- 品項改價後,不動料錢再存一次 ⇒ 快照不變。
update public.material_cost_items set amount = 700 where id = 'fb11f000-0000-4000-8000-000000000060';
select pg_temp.up(:'b1_id'::uuid, jsonb_build_array(pg_temp.m('60', 5), pg_temp.m('61', 1)));
select is(pg_temp.mats(:'b1_id'::uuid), 'MA:5x500.00,MB:1x12.50', '④ 品項改價成 700 後再存 ⇒ 單上快照仍是 500');
update public.material_cost_items set amount = 500 where id = 'fb11f000-0000-4000-8000-000000000060';

-- =========================================================================
-- ⑤~⑯ 格式錯誤
-- =========================================================================
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":0}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的數量必須是 1 到 999 的整數', '⑤ 數量 0 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1000}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的數量必須是 1 到 999 的整數', '⑥ 數量 1000 ⇒ 擋(上限 999)');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1.5}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的數量必須是 1 到 999 的整數', '⑦ 數量 1.5 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":"3"}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的數量必須是 1 到 999 的整數', '⑧ 數量是字串 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060"}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的數量必須是 1 到 999 的整數', '⑨ 沒帶數量 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1,"unit_price":-1}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的單價不能是負數，也不能超過 99,999,999.99', '⑩ 單價 −1 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1,"unit_price":"12"}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的單價格式不正確，必須是數字', '⑪ 單價是字串 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1,"unit_price":100000000}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的單價不能是負數，也不能超過 99,999,999.99', '⑫ 單價超過 99,999,999.99 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1},{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":2}]', '2036-07-02 09:00+08')$$,
  'P0001', '同一個料錢成本品項不能在同一筆預約裡選取兩次', '⑬ 同品項兩次 ⇒ 擋(沿用既有訊息)');
select throws_ok($$select pg_temp.mk('{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000060","quantity":1}', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本的格式不正確，必須是清單', '⑭ 不是陣列 ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"quantity":1}]', '2036-07-02 09:00+08')$$,
  'P0001', '每個料錢成本品項都必須指定 material_cost_item_id', '⑮ 缺品項 id ⇒ 擋');
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"not-a-uuid","quantity":1}]', '2036-07-02 09:00+08')$$,
  'P0001', '料錢成本品項的編號格式不正確', '⑯ 品項 id 格式錯 ⇒ 擋');

-- =========================================================================
-- ⑰~⑳ 已下架品項
-- =========================================================================
select throws_ok($$select pg_temp.mk('[{"material_cost_item_id":"fb11f000-0000-4000-8000-000000000064","quantity":1}]', '2036-07-02 09:00+08')$$,
  'P0001', '找不到其中一個料錢成本品項，或已下架', '⑰ 新單加已下架品項 ⇒ 擋');

-- b1 單上的 MB 下架之後:保留 + 改數量 ⇒ 可以;移除 ⇒ 可以。
update public.material_cost_items set status = 'removed' where id = 'fb11f000-0000-4000-8000-000000000061';
select lives_ok(format($$select pg_temp.up(%L::uuid, jsonb_build_array(pg_temp.m('60', 5), pg_temp.m('61', 2)))$$, :'b1_id'),
  '⑱ 單上既有的已下架品項:保留並改數量 ⇒ 可以');
select is(pg_temp.mats(:'b1_id'::uuid), 'MA:5x500.00,MB:2x12.50', '⑲ 已下架品項數量變 2、單價快照 12.5 保留');
select pg_temp.up(:'b1_id'::uuid, jsonb_build_array(pg_temp.m('60', 5)));
select is(pg_temp.mats(:'b1_id'::uuid), 'MA:5x500.00', '⑳ 已下架品項可以移除');
update public.material_cost_items set status = 'active' where id = 'fb11f000-0000-4000-8000-000000000061';

-- =========================================================================
-- ㉑~㉒ 功能關閉
-- =========================================================================
update public.merchant_feature_flags set enabled = false
where merchant_id = 'fb11f000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';
select throws_ok(format($$select pg_temp.up(%L::uuid, jsonb_build_array(pg_temp.m('60', 5), pg_temp.m('61', 1)))$$, :'b1_id'),
  'P0001', '這間商家尚未開啟料錢成本功能，無法選用料錢成本品項', '㉑ 功能關閉:新加品項 ⇒ 擋');
select pg_temp.up(:'b1_id'::uuid, jsonb_build_array(pg_temp.m('60', 4)));
select is(pg_temp.mats(:'b1_id'::uuid), 'MA:4x500.00', '㉒ 功能關閉:單上既有品項可保留(並改數量)');
update public.merchant_feature_flags set enabled = true
where merchant_id = 'fb11f000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';

-- =========================================================================
-- ㉓~㉗ 抽成與店家報表(× 數量)
-- =========================================================================
select public.set_material_cost_affects_commission('fb11f000-0000-4000-8000-000000000020', true);
-- 扣料錢:MA ×3(500)+ MB ×1(12.5)= 1,512.5 ⇒ (3000 − 1512.5) × 40% = 595
select pg_temp.mk(jsonb_build_array(pg_temp.m('60', 3), pg_temp.m('61', 1, 12.5)), '2036-07-03 09:00+08') as id \gset cn_
-- 小數:MB 自訂 33.33 × 3 = 99.99 ⇒ (3000 − 99.99) × 40% = 1160.004 ⇒ round 1160.00
select pg_temp.mk(jsonb_build_array(pg_temp.m('61', 3, 33.33)), '2036-07-03 11:00+08') as id \gset cr_
select pg_temp.done(:'cn_id'::uuid);
select pg_temp.done(:'cr_id'::uuid);
select public.set_material_cost_affects_commission('fb11f000-0000-4000-8000-000000000020', false);
select pg_temp.mk(jsonb_build_array(pg_temp.m('60', 3), pg_temp.m('61', 1, 12.5)), '2036-07-03 14:00+08') as id \gset cg_
select pg_temp.done(:'cg_id'::uuid);

select is(pg_temp.rec(:'cn_id'::uuid), '595.00/1512.50/net_of_material_cost', '㉓ 扣料錢開:扣除額 = Σ 單價 × 數量 = 1,512.5,抽成 595');
select is(pg_temp.rec(:'cg_id'::uuid), '1200.00/0.00/gross', '㉔ 扣料錢關:扣除額 0,抽成 1,200');
select is(pg_temp.rec(:'cr_id'::uuid), '1160.00/99.99/net_of_material_cost', '㉕ 小數單價 33.33 × 3 = 99.99;抽成 round(1160.004, 2) = 1160.00');

-- 店家報表:這間店本月完成的 3 張單料錢 = 1512.5 + 99.99 + 1512.5 = 3124.99
select is(
  (public.get_merchant_billing_summary_by_range('fb11f000-0000-4000-8000-000000000020',
     (now() at time zone 'Asia/Taipei')::date - 1, (now() at time zone 'Asia/Taipei')::date + 1) ->> 'total_material_cost')::numeric,
  3124.99::numeric, '㉖ 區間報表 total_material_cost = Σ 單價 × 數量');
select is(
  (public.get_merchant_billing_summary('fb11f000-0000-4000-8000-000000000020',
     extract(year from now() at time zone 'Asia/Taipei')::int, extract(month from now() at time zone 'Asia/Taipei')::int) ->> 'total_material_cost')::numeric,
  3124.99::numeric, '㉗ 月報表 total_material_cost = Σ 單價 × 數量');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ㉘~㉛ 服務人員端
-- =========================================================================
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000005');
select (public.staff_create_booking(
  p_staff_id => 'fb11f000-0000-4000-8000-000000000040',
  p_service_items => '[{"service_item_id":"fb11f000-0000-4000-8000-000000000031","quantity":1,"unit_price":3000}]'::jsonb,
  p_start_at => '2036-07-04 09:00+08',
  p_customer_name => '自建客人',
  p_customer_phone => '0955110011',
  p_customer_address => '新北市自建路 1 號',
  p_payment_method_id => 'fb11f000-0000-4000-8000-000000000050',
  p_material_cost_items => jsonb_build_array(pg_temp.m('60', 2, 450))
) ->> 'id') as id \gset s1_
select pg_temp.test_clear_auth();
select is(pg_temp.mats(:'s1_id'::uuid), 'MA:2x450.00', '㉘ 服務人員建單:數量 2、自訂單價 450');

-- 品項改價後,服務人員改單不帶料錢 ⇒ 數量、單價都維持(不會變回現價、也不會變回 1)。
update public.material_cost_items set amount = 800 where id = 'fb11f000-0000-4000-8000-000000000060';
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000005');
select pg_temp.sup(:'s1_id'::uuid, null);
select pg_temp.test_clear_auth();
select is(pg_temp.mats(:'s1_id'::uuid), 'MA:2x450.00', '㉙ 服務人員改單不帶料錢(null)⇒ 數量與單價都不變');
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000005');
select is(
  (select jsonb_agg(e - 'name' - 'material_cost_item_id') from jsonb_array_elements(public.staff_get_booking_for_edit(:'s1_id'::uuid) -> 'material_costs') e),
  '[{"quantity": 2, "is_active": true, "amount_snapshot": 450.00}]'::jsonb,
  '㉚ staff_get_booking_for_edit 多回 quantity(單價仍是 amount_snapshot)');
select pg_temp.sup(:'s1_id'::uuid, '[]'::jsonb);
select pg_temp.test_clear_auth();
select is(pg_temp.mats(:'s1_id'::uuid), '', '㉛ 服務人員改單帶 [] ⇒ 清空');
update public.material_cost_items set amount = 500 where id = 'fb11f000-0000-4000-8000-000000000060';

-- =========================================================================
-- ㉜~㉝ 既有資料(數量 1)
-- =========================================================================
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000001');
select pg_temp.mk('[]'::jsonb, '2036-07-05 09:00+08') as id \gset e1_
select pg_temp.test_clear_auth();
-- 模擬 F 之前寫入的列(沒有 quantity 欄位的 insert)。
insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
values (:'e1_id'::uuid, 'fb11f000-0000-4000-8000-000000000060', 500);
select is((select quantity from public.booking_material_costs where booking_id = :'e1_id'::uuid), 1, '㉜ 沒寫 quantity 的列(既有資料)= 1');
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000001');
select public.set_material_cost_affects_commission('fb11f000-0000-4000-8000-000000000020', true);
select pg_temp.done(:'e1_id'::uuid);
select pg_temp.test_clear_auth();
select is(pg_temp.rec(:'e1_id'::uuid), '1000.00/500.00/net_of_material_cost', '㉝ 數量 1 的單抽成與改前公式相同(範例 A:3000 扣 500 × 40% = 1000)');

-- =========================================================================
-- ㉞~㊵ 權限 / 結構
-- =========================================================================
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000002');
select throws_ok($$select pg_temp.mk(jsonb_build_array(pg_temp.m('60', 2, 1)), '2036-07-06 09:00+08')$$,
  '42501', null, '㉞ 沒有訂單管理鑰匙的客服(只有料錢鑰匙)不能建單改料錢');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000001');
select throws_ok($$select pg_temp.mk(jsonb_build_array(pg_temp.m('65', 1)), '2036-07-06 09:00+08')$$,
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㉟ 別家商家的料錢品項 ⇒ 擋(跨商家隔離)');
select pg_temp.test_clear_auth();

-- 服務人員 Q 沒開「新增編輯訂單」⇒ 改 P 的單或自己的單都擋。
select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000007');
select throws_ok(format($$select pg_temp.sup(%L::uuid, jsonb_build_array(pg_temp.m('60', 1, 0)))$$, :'cn_id'),
  '42501', null, '㊱ 服務人員不能改別人的單 / 沒開權限 ⇒ 擋');
select pg_temp.test_clear_auth();

select ok(
  not has_function_privilege('authenticated', 'private.parse_booking_material_cost_items(jsonb)', 'execute')
  and not has_function_privilege('anon', 'private.parse_booking_material_cost_items(jsonb)', 'execute'),
  '㊲ 新 helper 對 authenticated / anon 都沒有 EXECUTE');
select is(
  (select string_agg(p.proname || ':' || (pg_get_function_identity_arguments(p.oid) like '%p_material_cost_items jsonb%')::text, ' ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('create_booking', 'update_booking', 'staff_create_booking', 'staff_update_booking')),
  'create_booking:true staff_create_booking:true staff_update_booking:true update_booking:true',
  '㊳ 四支各只剩 1 個版本,而且都是新參數 p_material_cost_items jsonb(舊 uuid[] 版已 drop)');
select throws_ok($$insert into public.booking_material_costs (booking_id, material_cost_item_id, quantity, amount_snapshot)
  values ('$$ || :'e1_id' || $$', 'fb11f000-0000-4000-8000-000000000061', 0, 10)$$,
  '23514', null, '㊴ 料錢數量 0 ⇒ CHECK 擋');
select throws_ok($$update public.booking_service_items set quantity = 1000 where booking_id = '$$ || :'e1_id' || $$'$$,
  '23514', null, '㊵ 服務項目數量 1000 ⇒ CHECK 擋(F-1 兩邊一起訂 999)');

-- =========================================================================
-- ㊶~㊻ 主腦裁決(防溢位):單一品項小計 ≤ 1,000,000、整張單料錢合計 ≤ 9,999,999.99
-- =========================================================================
insert into public.material_cost_items (id, merchant_id, name, amount, status)
select ('fb11f000-0000-4000-8000-00000000070' || n)::uuid, 'fb11f000-0000-4000-8000-000000000020', 'MT' || n, 1, 'active'
from generate_series(0, 9) n;
-- 10 個品項的 jsonb:前 p_n 個各 1,000,000(單價 1,000,000 × 1),再加一個指定單價的品項。
create function pg_temp.many(p_n int, p_last numeric)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', 'fb11f000-0000-4000-8000-00000000070' || n, 'quantity', 1, 'unit_price', 1000000)), '[]'::jsonb)
         || jsonb_build_array(jsonb_build_object('material_cost_item_id', 'fb11f000-0000-4000-8000-00000000070' || p_n, 'quantity', 1, 'unit_price', p_last))
  from generate_series(0, p_n - 1) n;
$$;
grant execute on function pg_temp.many(int, numeric) to authenticated;

select pg_temp.test_set_auth('fb11f000-0000-4000-8000-000000000001');
select lives_ok($$select pg_temp.mk(jsonb_build_array(pg_temp.m('60', 2, 500000)), '2036-07-08 09:00+08')$$,
  '㊶ 單一品項小計剛好 1,000,000(500,000 × 2)⇒ 可以');
select throws_ok($$select pg_temp.mk(jsonb_build_array(pg_temp.m('60', 2, 500000.01)), '2036-07-08 11:00+08')$$,
  'P0001', '單一料錢小計不能超過 $1,000,000，請調整單價或數量', '㊷ 單一品項小計 1,000,000.02 ⇒ 擋(有送單價,格式檢查就擋)');
-- 沒送單價(用品項現價):寫入後才知道,由 assert helper 擋。MB 現價改 1,001.01 × 999 = 1,000,008.99。
update public.material_cost_items set amount = 1001.01 where id = 'fb11f000-0000-4000-8000-000000000061';
select throws_ok($$select pg_temp.mk(jsonb_build_array(pg_temp.m('61', 999)), '2036-07-08 13:00+08')$$,
  'P0001', '單一料錢小計不能超過 $1,000,000，請調整單價或數量', '㊸ 沒送單價(用現價 1,001.01 × 999)超過 1,000,000 ⇒ 寫入後檢查擋下');
update public.material_cost_items set amount = 600 where id = 'fb11f000-0000-4000-8000-000000000061';
select lives_ok($$select pg_temp.mk(pg_temp.many(9, 999999.99), '2036-07-09 09:00+08')$$,
  '㊹ 整張單料錢合計剛好 9,999,999.99(9 × 1,000,000 + 999,999.99)⇒ 可以');
select throws_ok($$select pg_temp.mk(pg_temp.many(9, 1000000), '2036-07-09 11:00+08')$$,
  'P0001', '這筆訂單的料錢合計不能超過 $9,999,999.99，請調整單價或數量', '㊺ 整張單合計 10,000,000 ⇒ 擋');
select pg_temp.test_clear_auth();
select ok(
  not has_function_privilege('authenticated', 'private.assert_booking_material_cost_limits(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.assert_booking_material_cost_limits(uuid)', 'execute'),
  '㊻ 寫入後檢查的 helper 對 authenticated / anon 都沒有 EXECUTE');

select * from finish();
rollback;
