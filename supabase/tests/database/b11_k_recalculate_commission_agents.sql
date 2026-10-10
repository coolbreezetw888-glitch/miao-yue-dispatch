-- SPECS-INDEX #996(第 11 批 K):已完成訂單「重新計算抽成」開放給有「抽成與薪資設定」的客服 + 加鎖 +
-- 月薪制擋下(主腦裁決)+ 新唯讀 RPC get_booking_commission_summary。
-- migration 20261007140600_b11_k_recalculate_commission_agents.sql
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §十八 18.7、檔尾「主腦裁決」。
--
--   ①~②    管理員成功(金額依目前比例重算、recalculated_at 有值);有 commission_settings 的在職客服成功
--   ③~⑥    只有 staff_report 的客服 / 有鑰匙但已移除的客服 / 別家管理員 / 別家有鑰匙客服 / 服務人員 ⇒ 42501 逐字
--   ⑦~⑨    權限在狀態之前:無權限者對「已確認」單也只拿到 42501;有權限者才看到狀態訊息
--   ⑩       沒有抽成紀錄(月薪制)⇒ 原訊息
--   ⑪~⑫    主腦裁決:完成後服務人員改成月薪 ⇒「這位服務人員目前不是抽成制，無法重新計算抽成」,抽成紀錄沒被動到
--   ⑬       重算兩次後明細列數 = 服務項目數(不重複)
--   ⑭~㉒    get_booking_commission_summary:管理員 / 有鑰匙客服回總額;月薪單 has_record=false;
--            已改月薪 staff_is_piece_rate=false;無權限、別家、服務人員、訂單不存在 ⇒ 同一句 42501;只回 6 個 key
--   ㉓~㉗    鎖與屬性:本體有 for update 且順序 = 讀商家 → 權限 → 鎖列 → 狀態;ACL;anon 無 EXECUTE;
--            security definer / search_path / volatility
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

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

-- ── Fixture ───────────────────────────────────────────────────────────────
--   使用者:01 A 店管理員 / 02 客服(抽成與薪資設定 + 訂單管理)/ 03 客服(只有服務人員報表 + 訂單管理)/
--           04 客服(有抽成與薪資設定但已移除)/ 05 服務人員 P(有登入)/ 06 B 店管理員 / 07 B 店客服(抽成與薪資設定)
insert into auth.users (id, email) values
  ('f9960000-0000-4000-8000-000000000001', 'pgtap-b11k-admin@test.local'),
  ('f9960000-0000-4000-8000-000000000002', 'pgtap-b11k-agent-cs@test.local'),
  ('f9960000-0000-4000-8000-000000000003', 'pgtap-b11k-agent-report@test.local'),
  ('f9960000-0000-4000-8000-000000000004', 'pgtap-b11k-agent-removed@test.local'),
  ('f9960000-0000-4000-8000-000000000005', 'pgtap-b11k-staff@test.local'),
  ('f9960000-0000-4000-8000-000000000006', 'pgtap-b11k-adminB@test.local'),
  ('f9960000-0000-4000-8000-000000000007', 'pgtap-b11k-agentB@test.local');

insert into groups (id) values
  ('f9960000-0000-4000-8000-000000000011'),
  ('f9960000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f9960000-0000-4000-8000-000000000020', 'f9960000-0000-4000-8000-000000000011', '#996 A 店', 'on_site_dispatch'),
  ('f9960000-0000-4000-8000-000000000021', 'f9960000-0000-4000-8000-000000000012', '#996 B 店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f9960000-0000-4000-8000-000000000020', 'f9960000-0000-4000-8000-000000000001', '店主甲'),
  ('f9960000-0000-4000-8000-000000000021', 'f9960000-0000-4000-8000-000000000006', '店主乙');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9960000-0000-4000-8000-000000000022', 'f9960000-0000-4000-8000-000000000020', 'f9960000-0000-4000-8000-000000000002', '抽成客服', 'pgtap-b11k-agent-cs@test.local', 'active', now(), '0900996022'),
  ('f9960000-0000-4000-8000-000000000023', 'f9960000-0000-4000-8000-000000000020', 'f9960000-0000-4000-8000-000000000003', '報表客服', 'pgtap-b11k-agent-report@test.local', 'active', now(), '0900996023'),
  ('f9960000-0000-4000-8000-000000000024', 'f9960000-0000-4000-8000-000000000020', 'f9960000-0000-4000-8000-000000000004', '已移除客服', 'pgtap-b11k-agent-removed@test.local', 'removed', now(), '0900996024'),
  ('f9960000-0000-4000-8000-000000000025', 'f9960000-0000-4000-8000-000000000021', 'f9960000-0000-4000-8000-000000000007', 'B店抽成客服', 'pgtap-b11k-agentB@test.local', 'active', now(), '0900996025');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9960000-0000-4000-8000-000000000022', 'commission_settings', true),
  ('f9960000-0000-4000-8000-000000000022', 'orders', true),
  ('f9960000-0000-4000-8000-000000000023', 'staff_report', true),
  ('f9960000-0000-4000-8000-000000000023', 'orders', true),
  ('f9960000-0000-4000-8000-000000000024', 'commission_settings', true),
  ('f9960000-0000-4000-8000-000000000025', 'commission_settings', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9960000-0000-4000-8000-000000000031', 'f9960000-0000-4000-8000-000000000020', 'S1', 1000, 'primary', 60),
  ('f9960000-0000-4000-8000-000000000032', 'f9960000-0000-4000-8000-000000000020', 'S2', 500, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('f9960000-0000-4000-8000-000000000050', 'f9960000-0000-4000-8000-000000000020', '現金');

-- 服務人員:P 抽成制(有登入)、M 月薪制、Q 抽成制(完成後改成月薪)。S1 10%、S2 10%。
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone) values
  ('f9960000-0000-4000-8000-000000000040', 'f9960000-0000-4000-8000-000000000020', 'f9960000-0000-4000-8000-000000000005', '服務人員P', 'piece_rate', 'active', 'active', now(), true, '0900996040'),
  ('f9960000-0000-4000-8000-000000000041', 'f9960000-0000-4000-8000-000000000020', null, '服務人員M', 'monthly_salary', 'active', 'not_invited', null, true, '0900996041'),
  ('f9960000-0000-4000-8000-000000000042', 'f9960000-0000-4000-8000-000000000020', null, '服務人員Q', 'piece_rate', 'active', 'not_invited', null, true, '0900996042');
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('f9960000-0000-4000-8000-000000000040', 'f9960000-0000-4000-8000-000000000031', 'percentage', 10),
  ('f9960000-0000-4000-8000-000000000040', 'f9960000-0000-4000-8000-000000000032', 'percentage', 10),
  ('f9960000-0000-4000-8000-000000000042', 'f9960000-0000-4000-8000-000000000031', 'percentage', 10);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9960000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

create function pg_temp.mk(p_staff uuid, p_items uuid[], p_start timestamptz)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9960000-0000-4000-8000-000000000020',
    p_staff_id => p_staff,
    p_service_items => (
      select jsonb_agg(jsonb_build_object('service_item_id', si.id, 'quantity', 1, 'unit_price', si.price))
      from public.service_items si where si.id = any(p_items)
    ),
    p_start_at => p_start,
    p_customer_name => '王先生',
    p_customer_phone => '0955996000',
    p_customer_address => '台北市測試路 96 號',
    p_material_cost_items => null,
    p_payment_method_id => 'f9960000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, uuid[], timestamptz) to authenticated;

create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;
grant execute on function pg_temp.done(uuid) to authenticated;

-- 管理員建單並完成:b1(P, S1)、b2(M, S1, 月薪無紀錄)、b3(Q, S1)、b4(P, S1, 只確認不完成)、b5(P, S1+S2)。
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000001');
select pg_temp.mk('f9960000-0000-4000-8000-000000000040', array['f9960000-0000-4000-8000-000000000031']::uuid[], date_trunc('day', now()) + interval '1 day 9 hours') as b1 \gset
select pg_temp.mk('f9960000-0000-4000-8000-000000000041', array['f9960000-0000-4000-8000-000000000031']::uuid[], date_trunc('day', now()) + interval '1 day 9 hours') as b2 \gset
select pg_temp.mk('f9960000-0000-4000-8000-000000000042', array['f9960000-0000-4000-8000-000000000031']::uuid[], date_trunc('day', now()) + interval '1 day 9 hours') as b3 \gset
select pg_temp.mk('f9960000-0000-4000-8000-000000000040', array['f9960000-0000-4000-8000-000000000031']::uuid[], date_trunc('day', now()) + interval '1 day 12 hours') as b4 \gset
select pg_temp.mk('f9960000-0000-4000-8000-000000000040', array['f9960000-0000-4000-8000-000000000031', 'f9960000-0000-4000-8000-000000000032']::uuid[], date_trunc('day', now()) + interval '1 day 15 hours') as b5 \gset
select pg_temp.done(:'b1'::uuid);
select pg_temp.done(:'b2'::uuid);
select pg_temp.done(:'b3'::uuid);
select public.confirm_booking(:'b4'::uuid);
select pg_temp.done(:'b5'::uuid);
select pg_temp.test_clear_auth();

-- 完成後:P 的 S1 比例 10% → 20%;Q 改成月薪。
update staff_service_commission_rates set commission_value = 20
where staff_id = 'f9960000-0000-4000-8000-000000000040' and service_item_id = 'f9960000-0000-4000-8000-000000000031';
update merchant_staff set compensation_type = 'monthly_salary' where id = 'f9960000-0000-4000-8000-000000000042';

create function pg_temp.amt(p_booking uuid) returns text language sql as $$
  select commission_amount::text || '/' || (recalculated_at is not null)::text
  from public.booking_commission_records where booking_id = p_booking;
$$;

-- =========================================================================
-- ①~② 放行
-- =========================================================================
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000001');
select lives_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'), '① 管理員重算成功');
select pg_temp.test_clear_auth();
select is(pg_temp.amt(:'b1'::uuid), '200.00/true', '① 重算後依目前比例 20%:1000 × 20% = 200.00,recalculated_at 有值');

update staff_service_commission_rates set commission_value = 30
where staff_id = 'f9960000-0000-4000-8000-000000000040' and service_item_id = 'f9960000-0000-4000-8000-000000000031';
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000002');
select lives_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'),
  '② 有「抽成與薪資設定」的在職客服重算成功');
select pg_temp.test_clear_auth();
select is(pg_temp.amt(:'b1'::uuid), '300.00/true', '② 客服重算後依目前比例 30%:1000 × 30% = 300.00');

-- =========================================================================
-- ③~⑥ 擋下(42501 逐字)
-- =========================================================================
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000003');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'),
  '42501', '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作',
  '③ 只有「服務人員報表」的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000004');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'),
  '42501', '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作',
  '④ 有鑰匙但已移除(status <> active)的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000006');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'),
  '42501', '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作',
  '⑤ 別家商家的管理員 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000007');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'),
  '42501', '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作',
  '⑤ 別家商家有「抽成與薪資設定」的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000005');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b1'),
  '42501', '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作',
  '⑥ 服務人員(登入身分只是 staff)⇒ 42501');
select pg_temp.test_clear_auth();
select is(pg_temp.amt(:'b1'::uuid), '300.00/true', '③~⑥ 被擋的呼叫都沒有動到抽成紀錄(仍是 ② 的 300.00)');

-- =========================================================================
-- ⑦~⑨ 權限在狀態之前
-- =========================================================================
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000003');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b4'),
  '42501', '重新計算已完成訂單的抽成金額，只有商家管理員或有「抽成與薪資設定」權限的客服可以操作',
  '⑦ 無權限者對「已確認」的單也只拿到 42501(拿不到狀態資訊)');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000002');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b4'),
  'P0001', '只有已完成的訂單才能重新計算抽成',
  '⑧ 有權限的客服對「已確認」的單 ⇒ 原狀態訊息');
select throws_ok($$select public.recalculate_booking_commission('f9960000-0000-4000-8000-0000000000ff')$$,
  'P0001', '找不到這筆預約',
  '⑨ 訂單不存在 ⇒ 原訊息「找不到這筆預約」');

-- =========================================================================
-- ⑩ 沒有抽成紀錄(月薪制)
-- =========================================================================
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000001');
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b2'),
  'P0001', '這筆訂單目前沒有抽成紀錄，無法重新計算(可能是月薪制服務人員，不適用抽成)',
  '⑩ 月薪制服務人員的單(沒有抽成紀錄)⇒ 原訊息');

-- =========================================================================
-- ⑪~⑫ 主腦裁決:目前不是抽成制 ⇒ 不准重算
-- =========================================================================
select throws_ok(format($$select public.recalculate_booking_commission('%s')$$, :'b3'),
  'P0001', '這位服務人員目前不是抽成制，無法重新計算抽成',
  '⑪ 完成後服務人員改成月薪 ⇒ 擋下,白話訊息');
select pg_temp.test_clear_auth();
select is(pg_temp.amt(:'b3'::uuid), '100.00/false', '⑫ 被擋下後抽成紀錄原封不動(100.00、沒有 recalculated_at)');

-- =========================================================================
-- ⑬ 明細不重複
-- =========================================================================
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000001');
select public.recalculate_booking_commission(:'b5'::uuid);
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000002');
select public.recalculate_booking_commission(:'b5'::uuid);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from booking_commission_item_records i
   join booking_commission_records r on r.id = i.commission_record_id where r.booking_id = :'b5'::uuid),
  2,
  '⑬ 管理員、客服各重算一次後,明細列數 = 服務項目數 2(沒有重複)'
);

-- =========================================================================
-- ⑭~㉒ get_booking_commission_summary
-- =========================================================================
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000001');
select is(
  (select (s ->> 'has_record') || '/' || (s ->> 'commission_amount')::numeric::text || '/' || (s ->> 'staff_name')
          || '/' || (s ->> 'staff_is_piece_rate') || '/' || ((s ->> 'recalculated_at') is not null)::text
          || '/' || ((s ->> 'computed_at') is not null)::text
   from public.get_booking_commission_summary(:'b1'::uuid) s),
  'true/300.00/服務人員P/true/true/true',
  '⑭ 管理員:has_record、目前抽成 300.00、服務人員姓名、是抽成制、兩個時間'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(public.get_booking_commission_summary(:'b1'::uuid)) k),
  array['commission_amount', 'computed_at', 'has_record', 'recalculated_at', 'staff_is_piece_rate', 'staff_name'],
  '⑮ 只回 6 個 key(不回明細、比例)'
);
select is(
  public.get_booking_commission_summary(:'b2'::uuid),
  '{"has_record": false, "commission_amount": null, "computed_at": null, "recalculated_at": null, "staff_name": null, "staff_is_piece_rate": null}'::jsonb,
  '⑯ 月薪單 ⇒ has_record = false,其餘 null'
);
select is(
  (select (s ->> 'has_record') || '/' || (s ->> 'staff_is_piece_rate') from public.get_booking_commission_summary(:'b3'::uuid) s),
  'true/false',
  '⑰ 已改月薪:有紀錄但 staff_is_piece_rate = false(前端不顯示按鈕)'
);
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000002');
select is(
  (public.get_booking_commission_summary(:'b1'::uuid) ->> 'commission_amount')::numeric,
  300.00::numeric,
  '⑱ 有「抽成與薪資設定」的客服讀得到總額'
);
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000003');
select throws_ok(format($$select public.get_booking_commission_summary('%s')$$, :'b1'),
  '42501', '沒有權限查看這筆訂單的抽成', '⑲ 只有「服務人員報表」的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000007');
select throws_ok(format($$select public.get_booking_commission_summary('%s')$$, :'b1'),
  '42501', '沒有權限查看這筆訂單的抽成', '⑳ 別家商家有鑰匙的客服 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000005');
select throws_ok(format($$select public.get_booking_commission_summary('%s')$$, :'b1'),
  '42501', '沒有權限查看這筆訂單的抽成', '㉑ 服務人員 ⇒ 42501');
select pg_temp.test_set_auth('f9960000-0000-4000-8000-000000000001');
select throws_ok($$select public.get_booking_commission_summary('f9960000-0000-4000-8000-0000000000ff')$$,
  '42501', '沒有權限查看這筆訂單的抽成', '㉒ 訂單不存在 ⇒ 跟無權限同一句 42501(不透露存不存在)');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ㉓~㉗ 鎖與屬性
-- =========================================================================
select ok(
  (select position('if not private.can_manage_commission_settings(v_merchant_id)' in s) > 0
      and position('if not private.can_manage_commission_settings(v_merchant_id)' in s) < position('for update;' in s)
      and position('for update;' in s) < position('if v_status <> ''completed'' then' in s)
      and position('select b.merchant_id' || E'\n' || '  into v_merchant_id' in s) < position('if not private.can_manage_commission_settings' in s)
      and position('private.is_merchant_admin' in s) = 0
   from (select replace(prosrc, E'\r\n', E'\n') s from pg_proc where oid = 'public.recalculate_booking_commission(uuid)'::regprocedure) x),
  '㉓ 重算本體:先不鎖讀商家 → 權限(can_manage_commission_settings)→ for update 鎖訂單列 → 狀態判斷;不再用 is_merchant_admin'
);
select is(
  (select string_agg(p.proname || ':' || coalesce(p.proacl::text, 'NULL'), ' | ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('recalculate_booking_commission', 'get_booking_commission_summary')),
  'get_booking_commission_summary:{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres} | '
  || 'recalculate_booking_commission:{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
  '㉔ ACL:兩支都只有 authenticated / service_role(重算與改前相同)'
);
select ok(
  not has_function_privilege('anon', 'public.get_booking_commission_summary(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.recalculate_booking_commission(uuid)', 'execute'),
  '㉕ anon 兩支都沒有 EXECUTE'
);
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || '/' || p.provolatile::text || '/' || coalesce(p.proconfig::text, 'NULL'), ' | ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('recalculate_booking_commission', 'get_booking_commission_summary')),
  'get_booking_commission_summary:true/s/{search_path=public} | recalculate_booking_commission:true/v/{search_path=public}',
  '㉖ 兩支都是 SECURITY DEFINER + search_path=public;摘要是 STABLE、重算是 VOLATILE'
);
select is(
  obj_description('public.recalculate_booking_commission(uuid)'::regprocedure, 'pg_proc'),
  null,
  '㉗ 重算函式沒有加 comment(req987_03 屬性斷言照舊)'
);

select * from finish();
rollback;
