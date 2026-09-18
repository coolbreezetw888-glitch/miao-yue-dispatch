-- 模組 9(支付方式)§1.2(bookings.payment_method CHECK 約束)、
-- §1.3(merchant_payment_method_settings CHECK 約束/唯一約束/RLS 權限邊界/沒有 DELETE 政策)。
begin;

select plan(15);

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
  ('c9000000-0000-4000-8000-000000000001', 'pgtap-m9-admin1@test.local'),
  ('c9000000-0000-4000-8000-000000000002', 'pgtap-m9-admin2@test.local'),
  ('c9000000-0000-4000-8000-000000000003', 'pgtap-m9-agent-none@test.local'),
  ('c9000000-0000-4000-8000-000000000004', 'pgtap-m9-agent-bh@test.local');

insert into groups (id) values
  ('c9000000-0000-4000-8000-000000000011'),
  ('c9000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000011', '支付方式測試一店', 'in_store_beauty'),
  ('c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000012', '支付方式測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000001'),
  ('c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('c9000000-0000-4000-8000-000000000031', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m9-agent-none@test.local', 'active', now()),
  ('c9000000-0000-4000-8000-000000000032', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000004', '客服-營業時間', 'pgtap-m9-agent-bh@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c9000000-0000-4000-8000-000000000032', 'business_hours', true),
  ('c9000000-0000-4000-8000-000000000031', 'orders', true);

-- =========================================================================
-- §1.2 bookings.payment_method CHECK 約束。直接建一筆最小可用的訂單,測試改 payment_method
-- 的合法/不合法值(CHECK 約束是最後一道防線,直接以 postgres 身分測)。
-- =========================================================================
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('c9000000-0000-4000-8000-000000000021', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('c9000000-0000-4000-8000-000000000041', 'c9000000-0000-4000-8000-000000000021', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('c9000000-0000-4000-8000-000000000051', 'c9000000-0000-4000-8000-000000000021', '一店服務人員', null, true);

select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000001');

select id from create_booking(
  'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000051',
  jsonb_build_array(jsonb_build_object('service_item_id', 'c9000000-0000-4000-8000-000000000041', 'quantity', 1, 'unit_price', 300)),
  '2026-09-29 09:00:00+08', '客戶甲', '0955000001'
) \gset booking_a_

select pg_temp.test_clear_auth();

select throws_ok(
  $$update bookings set payment_method = 'bogus_method' where id = '$$ || :'booking_a_id' || $$'$$,
  '23514', null,
  '§1.2:bookings.payment_method 寫入不在 7 個代碼清單內的值,被 CHECK 約束擋下'
);

select lives_ok(
  $$update bookings set payment_method = 'linepay' where id = '$$ || :'booking_a_id' || $$'$$,
  '§1.2:bookings.payment_method 寫入新增的代碼(linepay)可以成功'
);

select lives_ok(
  $$update bookings set payment_method = 'no_payment' where id = '$$ || :'booking_a_id' || $$'$$,
  '§1.2:bookings.payment_method 寫入 no_payment(無支付)可以成功'
);

select lives_ok(
  $$update bookings set payment_method = null where id = '$$ || :'booking_a_id' || $$'$$,
  '§1.2:bookings.payment_method 寫回 null(尚未設定)可以成功'
);

-- =========================================================================
-- §1.3 merchant_payment_method_settings:CHECK 約束(直接以 postgres 身分測)。
-- =========================================================================
select throws_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'bogus_method', true)$$,
  '23514', null,
  '§1.3:merchant_payment_method_settings.payment_method_code 不在 7 個代碼清單內,被 CHECK 約束擋下'
);

select lives_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'linepay', true)$$,
  '§1.3:merchant_payment_method_settings.payment_method_code 是合法代碼可以成功寫入(postgres 身分)'
);

-- §1.3:unique (merchant_id, payment_method_code) 唯一約束擋下重複代碼。
select throws_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'linepay', false)$$,
  '23505', null,
  '§1.3:同商家同代碼重複插入被 unique (merchant_id, payment_method_code) 約束擋下'
);

delete from merchant_payment_method_settings where merchant_id = 'c9000000-0000-4000-8000-000000000021';

-- §1.3:查無資料時,查詢回傳 0 筆(前端/後端據此 fallback:on_site 視為開啟,其餘視為關閉)。
select is(
  (select count(*)::int from merchant_payment_method_settings where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  0,
  '§1.3:商家還沒特別設定過付款方式時,merchant_payment_method_settings 查無資料(前端 fallback 預設值)'
);

-- =========================================================================
-- §1.3 merchant_payment_method_settings:RLS(要求 private.can_manage_business_hours)。
-- =========================================================================
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select throws_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'linepay', true)$$,
  '42501', null,
  '§1.3:無授權 business_hours 的客服不能寫入 merchant_payment_method_settings'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000004');

select lives_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'linepay', true)$$,
  '§1.3:被授權 business_hours 的客服可以寫入 merchant_payment_method_settings'
);

select is(
  (select enabled from merchant_payment_method_settings
    where merchant_id = 'c9000000-0000-4000-8000-000000000021' and payment_method_code = 'linepay'),
  true,
  '§1.3:寫入後查詢得到正確的值'
);

-- 商家把「現場付款」也手動關掉是合法操作,不強制 on_site 恆為開啟(§1.3 邊界情況)。
select lives_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'on_site', false)$$,
  '§1.3:商家可以合法把 on_site(現場付款)也手動關掉,不被強制恆為開啟'
);

select lives_ok(
  $$update merchant_payment_method_settings set enabled = false
    where merchant_id = 'c9000000-0000-4000-8000-000000000021' and payment_method_code = 'linepay'$$,
  '§1.3:被授權 business_hours 的客服可以更新 merchant_payment_method_settings(關閉某選項)'
);

-- §1.3:沒有 DELETE 政策,真刪除不會真的刪掉(比照 merchant_tax_settings 既有慣例)。
delete from merchant_payment_method_settings where merchant_id = 'c9000000-0000-4000-8000-000000000021';

select is(
  (select count(*)::int from merchant_payment_method_settings where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  2,
  '§1.3:merchant_payment_method_settings 沒有 DELETE 政策,執行 DELETE 沒有真的刪掉(仍有 on_site + linepay 兩筆)'
);

select pg_temp.test_clear_auth();

-- 無權限的另一間商家管理員不能寫入別人商家的付款方式設定。
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000002');

select throws_ok(
  $$insert into merchant_payment_method_settings (merchant_id, payment_method_code, enabled)
    values ('c9000000-0000-4000-8000-000000000021', 'atm', true)$$,
  '42501', null,
  '§1.3:無權限的另一間商家管理員不能寫入別人商家的 merchant_payment_method_settings'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
