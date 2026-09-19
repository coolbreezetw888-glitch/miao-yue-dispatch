-- 模組 9(支付方式)v2 — 全文取代 v1,對應規格書 .project/specs/支付方式.md(v2)§1~§4/§7/§8.1。
-- 取代舊檔 module9_01_payment_method_settings.sql(測 v1 固定 7 代碼 CHECK 約束跟
-- merchant_payment_method_settings 開關表,v2 已經整批作廢,故直接刪除重寫)。
begin;

select plan(31);

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
-- Fixture:兩間商家(A/B,測跨商家隔離)、A 商家有一位無授權客服/一位被授權 payment_methods 的
-- 客服/一位只有 orders 權限的客服(測 §4 修正:只要有 orders 就看得到清單)。
-- =========================================================================
insert into auth.users (id, email) values
  ('d9000000-0000-4000-8000-000000000001', 'pgtap-m9v2-admin-a@test.local'),
  ('d9000000-0000-4000-8000-000000000002', 'pgtap-m9v2-admin-b@test.local'),
  ('d9000000-0000-4000-8000-000000000003', 'pgtap-m9v2-agent-none@test.local'),
  ('d9000000-0000-4000-8000-000000000004', 'pgtap-m9v2-agent-pm@test.local'),
  ('d9000000-0000-4000-8000-000000000005', 'pgtap-m9v2-agent-orders@test.local');

insert into groups (id) values
  ('d9000000-0000-4000-8000-000000000011'),
  ('d9000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('d9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000011', '支付方式v2測試A店', 'in_store_beauty'),
  ('d9000000-0000-4000-8000-000000000022', 'd9000000-0000-4000-8000-000000000012', '支付方式v2測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('d9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000001'),
  ('d9000000-0000-4000-8000-000000000022', 'd9000000-0000-4000-8000-000000000002');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('d9000000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('d9000000-0000-4000-8000-000000000031', 'd9000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('d9000000-0000-4000-8000-000000000041', 'd9000000-0000-4000-8000-000000000021', 'A店服務人員', null, true);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('d9000000-0000-4000-8000-000000000051', 'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m9v2-agent-none@test.local', 'active', now()),
  ('d9000000-0000-4000-8000-000000000052', 'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000004', '客服-付款方式', 'pgtap-m9v2-agent-pm@test.local', 'active', now()),
  ('d9000000-0000-4000-8000-000000000053', 'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000005', '客服-僅訂單', 'pgtap-m9v2-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('d9000000-0000-4000-8000-000000000052', 'payment_methods', true),
  ('d9000000-0000-4000-8000-000000000053', 'orders', true);

insert into material_cost_items (id, merchant_id, name, amount) values
  ('d9000000-0000-4000-8000-000000000071', 'd9000000-0000-4000-8000-000000000021', 'A店料錢成本品項', 50);

-- =========================================================================
-- ① 商家管理員可以新增付款方式。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000001');

insert into payment_methods (id, merchant_id, name, description) values
  ('d9000000-0000-4000-8000-000000000061', 'd9000000-0000-4000-8000-000000000021', '現場付款', null);

select ok(
  (select count(*)::int from payment_methods where id = 'd9000000-0000-4000-8000-000000000061') = 1,
  '§4:商家管理員可以新增付款方式'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② 沒有被開通 payment_methods 的客服不能新增/編輯付款方式(RLS 擋下)。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000003');

select throws_ok(
  $$insert into payment_methods (merchant_id, name)
    values ('d9000000-0000-4000-8000-000000000021', '無授權客服嘗試新增')$$,
  '42501', null,
  '§4:無授權 payment_methods 的客服不能新增付款方式'
);

-- UPDATE 在 RLS 底下,USING 子句擋掉的是「這個角色看不到這一列」,不是丟出例外——這個角色的
-- SELECT 政策(既沒有 orders 也沒有 payment_methods)本來就看不到 061 這一列,UPDATE 會靜靜地
-- 0 筆受影響,不是報錯。用「切回商家管理員身分,確認名字真的沒被改到」來驗證這個操作沒有生效。
update payment_methods set name = '無授權客服嘗試改名' where id = 'd9000000-0000-4000-8000-000000000061';

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000001');

select is(
  (select name from payment_methods where id = 'd9000000-0000-4000-8000-000000000061'),
  '現場付款',
  '§4:無授權 payment_methods 的客服的 UPDATE 因為 RLS 看不到這一列而 0 筆受影響,名字沒有被改到'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ 被開通 payment_methods 的客服可以新增/編輯/下架/重新上架付款方式。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000004');

select lives_ok(
  $$insert into payment_methods (id, merchant_id, name, description)
    values ('d9000000-0000-4000-8000-000000000062', 'd9000000-0000-4000-8000-000000000021', 'LINE Pay', null)$$,
  '§4:被授權 payment_methods 的客服可以新增付款方式'
);

select lives_ok(
  $$update payment_methods set name = 'LINE Pay(改名後)' where id = 'd9000000-0000-4000-8000-000000000062'$$,
  '§4:被授權 payment_methods 的客服可以編輯付款方式名稱'
);

select lives_ok(
  $$update payment_methods set status = 'removed' where id = 'd9000000-0000-4000-8000-000000000062'$$,
  '§5.1/規則 3.1:被授權 payment_methods 的客服可以下架付款方式'
);

select lives_ok(
  $$update payment_methods set status = 'active' where id = 'd9000000-0000-4000-8000-000000000062'$$,
  '§5.1:被授權 payment_methods 的客服可以重新上架付款方式'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 沒有 DELETE 政策,真刪除沒有真的刪掉(比照 material_cost_items 既有慣例)。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000001');

delete from payment_methods where id = 'd9000000-0000-4000-8000-000000000062';

select is(
  (select count(*)::int from payment_methods where id = 'd9000000-0000-4000-8000-000000000062'),
  1,
  '§4:payment_methods 沒有 DELETE 政策,執行 DELETE 沒有真的刪掉'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 跨商家隔離:B 店管理員看不到、也改不到 A 店的付款方式。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from payment_methods where merchant_id = 'd9000000-0000-4000-8000-000000000021'),
  0,
  '§4:跨商家隔離——B 店管理員查詢 A 店付款方式清單,RLS 過濾後回傳 0 筆'
);

select throws_ok(
  $$insert into payment_methods (merchant_id, name)
    values ('d9000000-0000-4000-8000-000000000021', 'B店管理員嘗試新增')$$,
  '42501', null,
  '§4:跨商家隔離——B 店管理員不能寫入 A 店的付款方式'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ §4 修正重點:只有 orders 權限、沒有 payment_methods 權限的客服,SELECT 得到清單
-- (建單表單要看得到),但不能新增/編輯。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000005');

-- 此時 A 店有兩筆上架中的付款方式(061「現場付款」、062「LINE Pay」,062 要到後面 ⑨ 的測試
-- 才會被下架),所以預期看到 2 筆,不是 1 筆。
select is(
  (select count(*)::int from payment_methods where merchant_id = 'd9000000-0000-4000-8000-000000000021' and status = 'active'),
  2,
  '§4 修正:只有 orders 權限、沒有 payment_methods 權限的客服,可以 SELECT 到付款方式清單'
);

select throws_ok(
  $$insert into payment_methods (merchant_id, name)
    values ('d9000000-0000-4000-8000-000000000021', '僅訂單客服嘗試新增')$$,
  '42501', null,
  '§4 修正:只有 orders 權限的客服不能新增付款方式(管理仍需 payment_methods 權限)'
);

-- 一併驗證 material_cost_items 的同類修正(獨立小 migration):只有 orders 權限、沒有
-- material_costs 權限的客服,一樣可以 SELECT 到料錢成本品項清單。
select is(
  (select count(*)::int from material_cost_items where merchant_id = 'd9000000-0000-4000-8000-000000000021' and status = 'active'),
  1,
  'material_cost_items 同類修正:只有 orders 權限的客服可以 SELECT 到料錢成本品項清單'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ 完全無授權的客服(既沒有 orders 也沒有 payment_methods/material_costs)看不到清單。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000003');

select is(
  (select count(*)::int from payment_methods where merchant_id = 'd9000000-0000-4000-8000-000000000021'),
  0,
  '完全無授權的客服看不到付款方式清單(SELECT 政策兩個條件都不成立)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑧ §2:新商家建立當下自動種入「現場付款」「匯款」兩筆,皆為 active。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000001');

select public.create_group_and_merchant('種子測試店-群組', 'in_store_beauty') \gset seed_group_merchant_

select is(
  (select count(*)::int from payment_methods where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid),
  2,
  '§2:create_group_and_merchant 建立商家後,payment_methods 剛好有兩筆'
);

select is(
  (select count(*)::int from payment_methods
     where merchant_id = :'seed_group_merchant_create_group_and_merchant'::uuid
       and status = 'active' and name in ('現場付款', '匯款')),
  2,
  '§2:種子的兩筆分別是「現場付款」「匯款」,皆為 active'
);

select group_id from merchants where id = :'seed_group_merchant_create_group_and_merchant'::uuid \gset seed_group_

select public.create_merchant_in_group(:'seed_group_group_id'::uuid, '種子測試店-同集團第二間', 'in_store_beauty') \gset seed_second_merchant_

select is(
  (select count(*)::int from payment_methods where merchant_id = :'seed_second_merchant_create_merchant_in_group'::uuid),
  2,
  '§2:create_merchant_in_group 建立分店後,payment_methods 也剛好有兩筆'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ create_booking/update_booking 付款方式驗證與快照邏輯(§3.1/§3.2,最核心的一組測試)。
-- =========================================================================
select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000001');

select id from create_booking(
  'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id', 'd9000000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', 300)),
  '2026-09-29 09:00:00+08', '客戶甲', '0955000001', null, null, '{}', '{}', null, null,
  false, null, false, null, null, false, null, null,
  'd9000000-0000-4000-8000-000000000061'
) \gset booking_a_

select is(
  (select payment_method_id::text from bookings where id = :'booking_a_id'),
  'd9000000-0000-4000-8000-000000000061',
  '§3.2:create_booking 帶 p_payment_method_id 時,bookings.payment_method_id 正確寫入'
);

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_a_id'),
  '現場付款',
  '§3.2:create_booking 正確寫入 payment_method_name_snapshot 快照'
);

-- 核心測試:改掉付款方式名字後,已建立的舊訂單顯示文字(快照)不變。
update payment_methods set name = '現場付款(改名後)' where id = 'd9000000-0000-4000-8000-000000000061';

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_a_id'),
  '現場付款',
  '§7 邊界情況 1(最核心):商家改掉付款方式名字後,已建立的舊訂單 payment_method_name_snapshot 不受影響'
);

-- 傳入已下架的付款方式 id 應該報錯。步驟③最後把 062(LINE Pay)重新上架回 active 了,
-- 這裡先明確下架一次,確保狀態符合這條測試的前提(不要依賴前面步驟殘留的狀態)。
update payment_methods set status = 'removed' where id = 'd9000000-0000-4000-8000-000000000062';

select throws_ok(
  format(
    $$select create_booking(
      'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','d9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      '2026-09-29 10:00:00+08', '客戶乙', '0955000002', null, null, '{}', '{}', null, null,
      false, null, false, null, null, false, null, null, '%1$s'
    )$$,
    'd9000000-0000-4000-8000-000000000062'  -- 剛剛明確下架的 LINE Pay
  ),
  'P0001', null,
  '§8.1 第 5 條:create_booking 傳入已下架的付款方式 id 應該報錯'
);

-- 傳入屬於別間商家(B 店)的付款方式 id 應該報錯(跨商家隔離)。用 postgres 身分(clear auth)
-- 布置這筆 fixture,因為目前的模擬身分(A 店管理員)本來就不該有權限寫入 B 店的付款方式,
-- 布置測試資料不應該受限於「正在測試中的那個角色」的權限範圍。
select pg_temp.test_clear_auth();

insert into payment_methods (id, merchant_id, name) values
  ('d9000000-0000-4000-8000-000000000063', 'd9000000-0000-4000-8000-000000000022', 'B店的付款方式');

select pg_temp.test_set_auth('d9000000-0000-4000-8000-000000000001');

select throws_ok(
  format(
    $$select create_booking(
      'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','d9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      '2026-09-29 11:00:00+08', '客戶丙', '0955000003', null, null, '{}', '{}', null, null,
      false, null, false, null, null, false, null, null, '%1$s'
    )$$,
    'd9000000-0000-4000-8000-000000000063'
  ),
  'P0001', null,
  '§8.1 第 6 條:create_booking 傳入屬於別間商家的付款方式 id 應該報錯(跨商家隔離)'
);

-- 下架 booking_a 目前使用的付款方式,再用 update_booking 維持原值不變——應該仍能成功存檔
-- (§3.1/§7 邊界情況 2 的核心例外規則)。
update payment_methods set status = 'removed' where id = 'd9000000-0000-4000-8000-000000000061';

select lives_ok(
  format(
    $$select update_booking(
      '%1$s', 'd9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','d9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      '2026-09-29 09:00:00+08', '客戶甲(改備註)', '0955000001', null, null, '{}', '{}', null, null,
      false, null, false, null, null, false, null, null, 'd9000000-0000-4000-8000-000000000061'
    )$$,
    :'booking_a_id'
  ),
  '§3.1/§8.1 第 7 條:update_booking 維持原付款方式不變,即使該付款方式已在期間被下架,仍應成功'
);

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_a_id'),
  '現場付款',
  '20260919130400 修正:update_booking 維持原付款方式不變時,沿用既有 payment_method_name_snapshot,不重新查詢目前名稱——即使商家在此期間已經把它改名(前面已改成「現場付款(改名後)」),快照仍維持建立當下的「現場付款」,不能比照 duration_minutes_snapshot 每次重新查詢的做法'
);

-- 改選另一個目前已下架的付款方式(不是這筆訂單原本的值)——應該報錯,「下架的不能拿來新選」。
select throws_ok(
  format(
    $$select update_booking(
      '%1$s', 'd9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','d9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      '2026-09-29 09:00:00+08', '客戶甲', '0955000001', null, null, '{}', '{}', null, null,
      false, null, false, null, null, false, null, null, 'd9000000-0000-4000-8000-000000000062'
    )$$,
    :'booking_a_id'
  ),
  'P0001', null,
  '§8.1 第 8 條:update_booking 改選另一個已下架的付款方式(不是原本的值)應該報錯'
);

-- payment_method_id/payment_method_name_snapshot 可以是 null(留空建單)。
select id from create_booking(
  'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id', 'd9000000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', 300)),
  '2026-09-29 13:00:00+08', '客戶丁', '0955000004'
) \gset booking_noPM_

select is(
  (select (payment_method_id is null and payment_method_name_snapshot is null) from bookings where id = :'booking_noPM_id'),
  true,
  '§8.1 第 9 條:不指定付款方式時,payment_method_id/payment_method_name_snapshot 皆為 null'
);

-- =========================================================================
-- ⑩ 20260919130400 修正:主腦複查抓到的漏洞——編輯訂單時「沒有主動更換付款方式」,快照文字
-- 不應該跟著商家事後改名而被洗新;但如果客服「主動選了不同的付款方式」,快照仍然要正確更新
-- 成新選項目前的名稱(不能因為這次修正而連這個正常情況都擋住)。用獨立的新付款方式布置,
-- 避免跟前面步驟殘留的狀態互相干擾。
-- =========================================================================
insert into payment_methods (id, merchant_id, name, description) values
  ('d9000000-0000-4000-8000-000000000064', 'd9000000-0000-4000-8000-000000000021', '現場付款', null),
  ('d9000000-0000-4000-8000-000000000065', 'd9000000-0000-4000-8000-000000000021', '信用卡', null);

select id from create_booking(
  'd9000000-0000-4000-8000-000000000021', 'd9000000-0000-4000-8000-000000000041',
  jsonb_build_array(jsonb_build_object('service_item_id', 'd9000000-0000-4000-8000-000000000031', 'quantity', 1, 'unit_price', 300)),
  '2026-09-29 15:00:00+08', '客戶戊', '0955000005', null, null, '{}', '{}', null, null,
  false, null, false, null, null, false, null, null,
  'd9000000-0000-4000-8000-000000000064'
) \gset booking_snap_

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_snap_id'),
  '現場付款',
  '20260919130400 修正情境:建單時快照正確寫入「現場付款」'
);

-- 商家把這個付款方式改名(現場付款 → 到店付款)。
update payment_methods set name = '到店付款' where id = 'd9000000-0000-4000-8000-000000000064';

-- 編輯這筆訂單但不改變付款方式選擇(繼續傳同一個 payment_method_id 064),只改客戶姓名。
select lives_ok(
  format(
    $$select update_booking(
      '%1$s', 'd9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','d9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      '2026-09-29 15:00:00+08', '客戶戊(改姓名)', '0955000005', null, null, '{}', '{}', null, null,
      false, null, false, null, null, false, null, null, 'd9000000-0000-4000-8000-000000000064'
    )$$,
    :'booking_snap_id'
  ),
  '20260919130400 修正情境:編輯訂單只改客戶姓名、不改付款方式選擇,應正常存檔成功'
);

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_snap_id'),
  '現場付款',
  '20260919130400 修正情境(本次修正的核心):沒有主動更換付款方式時,payment_method_name_snapshot 仍是建立當下的「現場付款」,沒有被洗成商家改名後的「到店付款」'
);

-- 這次客服「主動選了不同的付款方式」(064 → 065「信用卡」)——這是應該要變動的正常情況,
-- 快照要正確更新成 065 目前的名稱,不能因為上面的修正而連這個都擋住。
select lives_ok(
  format(
    $$select update_booking(
      '%1$s', 'd9000000-0000-4000-8000-000000000041',
      jsonb_build_array(jsonb_build_object('service_item_id','d9000000-0000-4000-8000-000000000031','quantity',1,'unit_price',300)),
      '2026-09-29 15:00:00+08', '客戶戊(改姓名)', '0955000005', null, null, '{}', '{}', null, null,
      false, null, false, null, null, false, null, null, 'd9000000-0000-4000-8000-000000000065'
    )$$,
    :'booking_snap_id'
  ),
  '20260919130400 修正情境:客服主動改選另一個付款方式,應正常存檔成功'
);

select is(
  (select payment_method_name_snapshot from bookings where id = :'booking_snap_id'),
  '信用卡',
  '20260919130400 修正情境:主動更換付款方式時,payment_method_name_snapshot 正確更新成新選項目前的名稱「信用卡」,證明這次修正沒有連正常的更換情境都一併擋住'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
