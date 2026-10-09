-- SPECS-INDEX #1025 功能開關 第三輪 ③:「先調整、按儲存才生效」的兩支一次存多項 RPC
-- migration 20261010200200_req1025_staged_save.sql
--
--   ①  platform_set_merchant_features:非超級管理員 42501;錯誤輸入 22023 / P0002 且整筆不寫;
--      大項 + 細項一次生效;值一樣的不寫紀錄;每項一筆紀錄、同一個備註;回傳改變的項數
--   ②  platform_save_feature_settings:非超級管理員 42501;錯誤輸入整筆不寫;
--      新開商家預設 + 全部商家開關同一個交易;回傳統計;批次紀錄 is_bulk
--   ③  ACL
begin;

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

create function pg_temp.grants_of(p_merchant_id uuid)
returns text language sql stable as $$
  select string_agg(g.feature_key || ':' || g.enabled::text, ',' order by g.feature_key)
  from merchant_feature_grants g where g.merchant_id = p_merchant_id
$$;

insert into auth.users (id, email) values
  ('f1025600-0000-4000-8000-000000000001', 'pgtap-1025c-platform@test.local'),
  ('f1025600-0000-4000-8000-000000000002', 'pgtap-1025c-admin@test.local');
insert into platform_admins (user_id) values ('f1025600-0000-4000-8000-000000000001');
insert into groups (id) values ('f1025600-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values
  ('f1025600-0000-4000-8000-000000000021', 'f1025600-0000-4000-8000-000000000011', '儲存測試A店', 'on_site_dispatch');
select public.apply_industry_preset('f1025600-0000-4000-8000-000000000021');
insert into merchant_admins (merchant_id, user_id) values
  ('f1025600-0000-4000-8000-000000000021', 'f1025600-0000-4000-8000-000000000002');

select set_config('test.before', pg_temp.grants_of('f1025600-0000-4000-8000-000000000021'), true);

-- ─── ① platform_set_merchant_features ────────────────────────────────────
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
      '[{"feature_key":"data_import","enabled":false}]'::jsonb)$$,
  '42501', '只有超級管理員可以調整功能開關。', '①-1 商家管理員對自己店 ⇒ 42501');
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000002', 'anon');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
      '[{"feature_key":"data_import","enabled":false}]'::jsonb)$$,
  '42501', null, '①-2 匿名 ⇒ 權限錯誤');

select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-0000000000ff',
      '[{"feature_key":"data_import","enabled":false}]'::jsonb)$$,
  'P0002', '找不到這間商家。', '①-3 商家不存在 ⇒ P0002');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021', '[]'::jsonb)$$,
  '22023', '沒有要儲存的變更。', '①-4 空清單 ⇒ 22023');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
      '[{"feature_key":"data_import","enabled":false},{"feature_key":"no_such","enabled":false}]'::jsonb)$$,
  '22023', '沒有這個功能。', '①-5 其中一項不在功能清單 ⇒ 22023');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
      '[{"feature_key":"data_import","enabled":false},{"feature_key":"data_import","enabled":true}]'::jsonb)$$,
  '22023', '同一個功能不能出現兩次。', '①-6 同一個功能兩次 ⇒ 22023');
select throws_ok(
  $$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
      '[{"feature_key":"data_import","enabled":"no"}]'::jsonb)$$,
  '22023', '變更內容的格式不正確。', '①-7 enabled 不是布林 ⇒ 22023');
select throws_ok(
  format($$select public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
      '[{"feature_key":"data_import","enabled":false}]'::jsonb, %L)$$, repeat('字', 201)),
  '22023', '備註最多 200 字。', '①-8 備註 201 字 ⇒ 22023');
select pg_temp.test_clear_auth();
select is(pg_temp.grants_of('f1025600-0000-4000-8000-000000000021'), current_setting('test.before'),
  '①-9 上面每一次失敗都沒有寫入任何一項(整筆不寫)');

-- 一次儲存:大項關 + 一個細項關 + 一個不變。
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000001');
select is(
  public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
    '[{"feature_key":"staff_portal","enabled":false},
      {"feature_key":"staff_self_payroll","enabled":false},
      {"feature_key":"data_import","enabled":true}]'::jsonb, '  朋友試用  '),
  2, '①-10 回傳實際改變的項數(值一樣的不算)');
select pg_temp.test_clear_auth();
select is(
  (select string_agg(feature_key || ':' || enabled::text, ',' order by feature_key) from merchant_feature_grants
    where merchant_id = 'f1025600-0000-4000-8000-000000000021'
      and feature_key in ('staff_portal', 'staff_self_payroll', 'staff_order_editing')),
  'staff_order_editing:true,staff_portal:false,staff_self_payroll:false',
  '①-11 大項與細項同時生效;沒送的細項維持原值');
select is(
  (select string_agg(feature_key || ':' || coalesce(old_enabled::text, 'null') || '>' || new_enabled::text || ':' || note
                     || ':' || is_bulk::text, ',' order by feature_key)
     from merchant_feature_grant_logs where merchant_id = 'f1025600-0000-4000-8000-000000000021'),
  'staff_portal:true>false:朋友試用:false,staff_self_payroll:true>false:朋友試用:false',
  '①-12 每項一筆紀錄、同一個備註(去掉前後空白)、不是批次');

-- 大項打開 + 細項打開一起存。
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000001');
select is(
  public.platform_set_merchant_features('f1025600-0000-4000-8000-000000000021',
    '[{"feature_key":"staff_portal","enabled":true},{"feature_key":"staff_self_payroll","enabled":true}]'::jsonb),
  2, '①-13 大項 + 細項一起打開');
select pg_temp.test_clear_auth();
select is(private.merchant_has_feature('f1025600-0000-4000-8000-000000000021', 'staff_self_payroll'), true,
  '①-14 打開後細項實際可用');
select is(pg_temp.grants_of('f1025600-0000-4000-8000-000000000021'), current_setting('test.before'),
  '①-15 回到原本的狀態');

-- ─── ② platform_save_feature_settings ───────────────────────────────────
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.platform_save_feature_settings('[]'::jsonb, '[{"feature_key":"data_import","enabled":false}]'::jsonb)$$,
  '42501', '只有超級管理員可以調整功能開關。', '②-1 商家管理員 ⇒ 42501');
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.platform_save_feature_settings('[]'::jsonb, '[]'::jsonb)$$,
  '22023', '沒有要儲存的變更。', '②-2 兩邊都空 ⇒ 22023');
select throws_ok(
  $$select public.platform_save_feature_settings(
      '[{"industry_type":"on_site_dispatch","feature_key":"data_import","default_enabled":false}]'::jsonb,
      '[{"feature_key":"data_import","enabled":false},{"feature_key":"nope","enabled":false}]'::jsonb)$$,
  '22023', '沒有這個功能。', '②-3 批次裡有一項不在清單 ⇒ 22023');
select throws_ok(
  $$select public.platform_save_feature_settings(
      '[{"industry_type":"beauty","feature_key":"data_import","default_enabled":false}]'::jsonb, '[]'::jsonb)$$,
  '22023', '沒有這個產業。', '②-4 產業不對 ⇒ 22023');
select pg_temp.test_clear_auth();
select is(
  (select default_enabled from industry_feature_presets where industry_type = 'on_site_dispatch' and feature_key = 'data_import'),
  true, '②-5 失敗時新開商家預設也沒有被改(整筆不寫)');
select is(
  (select count(*)::int from merchant_feature_grant_logs where is_bulk), 0, '②-6 失敗時沒有任何批次紀錄');

select count(*)::int as n from merchants \gset all_
select pg_temp.test_set_auth('f1025600-0000-4000-8000-000000000001');
select is(
  public.platform_save_feature_settings(
    '[{"industry_type":"on_site_dispatch","feature_key":"staff_portal","default_enabled":false},
      {"industry_type":"in_store_beauty","feature_key":"staff_portal","default_enabled":true}]'::jsonb,
    '[{"feature_key":"staff_portal","enabled":false}]'::jsonb, '先藏起來'),
  jsonb_build_object('presets_changed', 1, 'merchants_changed', jsonb_build_object('staff_portal', :all_n)),
  '②-7 一次儲存:預設改 1 項(另一項值一樣不算)+ 所有商家關閉,回傳統計');
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchants m where private.merchant_has_feature(m.id, 'staff_portal')),
  0, '②-8 所有商家的登入端都關了');
select is(
  (select count(*)::int from merchant_feature_grant_logs where is_bulk and feature_key = 'staff_portal' and note = '先藏起來'),
  :all_n, '②-9 每間店一筆批次紀錄,備註相同');
select is(
  (select string_agg(industry_type || ':' || default_enabled::text, ',' order by industry_type)
     from industry_feature_presets where feature_key = 'staff_portal'),
  'in_store_beauty:true,on_site_dispatch:false',
  '②-10 新開商家預設以傳入的值為準(批次不會自動改預設)');
select is(
  (select string_agg(feature_key || ':' || enabled::text, ',' order by feature_key) from merchant_feature_grants
    where merchant_id = 'f1025600-0000-4000-8000-000000000021' and feature_key like 'staff\_%' and feature_key <> 'staff_portal'),
  'staff_order_editing:true,staff_self_availability:true,staff_self_payroll:true',
  '②-11 大項關掉時細項的值保留(T9)');

-- ─── ③ ACL ────────────────────────────────────────────────────────────────
select is(
  array[
    has_function_privilege('anon', 'public.platform_set_merchant_features(uuid, jsonb, text)', 'execute'),
    has_function_privilege('authenticated', 'public.platform_set_merchant_features(uuid, jsonb, text)', 'execute'),
    has_function_privilege('anon', 'public.platform_save_feature_settings(jsonb, jsonb, text)', 'execute'),
    has_function_privilege('authenticated', 'public.platform_save_feature_settings(jsonb, jsonb, text)', 'execute')
  ],
  array[false, true, false, true],
  '③-1 兩支函式:anon 不能執行,authenticated 可以(第一行再檢查超級管理員)');

select * from finish();
rollback;
