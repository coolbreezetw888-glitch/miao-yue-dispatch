-- SPECS-INDEX #1025 功能開關 FG1-T01 ⑫(⚠️5,使用者 F6 裁決「做」):全部商家一起開關 + 統計
-- migration 20261010200000_req1025_fg1_bulk_feature_switch.sql
-- 規格書 .project/specs/功能開關.md(第 2 版)FG1-F06、FG1-T01 ⑫、邊界 16。
-- (⑫ 獨立成這支檔案,不動 req1025_01 的 plan。)
--
--   ①  非超級管理員(一般帳號 / 商家管理員 / 匿名)呼叫兩支函式 ⇒ 42501
--   ②  錯誤輸入:功能不在清單 22023、沒指定開或關 22023、備註 201 字 22023
--   ③  統計:依 merchant_has_feature 的實際結果(含停用商家;細部功能在主功能關時算關)
--   ④  批次關閉:所有商家 effective = false、只對原本開著的店寫紀錄、is_bulk = true、備註空白寫「批次調整」、回傳值正確
--   ⑤  p_also_presets = true ⇒ 兩產業預設也變;false ⇒ 不變
--   ⑥  再按一次同樣的值 ⇒ 回傳 0、不寫紀錄
--   ⑦  批次開啟 + 自訂備註
--   ⑧  ACL
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(23);

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

-- ─── Fixture ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('f1025500-0000-4000-8000-000000000001', 'pgtap-1025b-platform@test.local'),
  ('f1025500-0000-4000-8000-000000000002', 'pgtap-1025b-admin@test.local'),
  ('f1025500-0000-4000-8000-000000000003', 'pgtap-1025b-nobody@test.local');
insert into platform_admins (user_id) values ('f1025500-0000-4000-8000-000000000001');
insert into groups (id) values
  ('f1025500-0000-4000-8000-000000000011'),
  ('f1025500-0000-4000-8000-000000000012'),
  ('f1025500-0000-4000-8000-000000000013');
insert into merchants (id, group_id, name, industry_type, status) values
  ('f1025500-0000-4000-8000-000000000021', 'f1025500-0000-4000-8000-000000000011', '批次A店', 'on_site_dispatch', 'active'),
  ('f1025500-0000-4000-8000-000000000022', 'f1025500-0000-4000-8000-000000000012', '批次B店', 'in_store_beauty', 'active'),
  ('f1025500-0000-4000-8000-000000000023', 'f1025500-0000-4000-8000-000000000013', '批次C店(停用)', 'in_store_beauty', 'disabled');
select public.apply_industry_preset('f1025500-0000-4000-8000-000000000021');
select public.apply_industry_preset('f1025500-0000-4000-8000-000000000022');
select public.apply_industry_preset('f1025500-0000-4000-8000-000000000023');
insert into merchant_admins (merchant_id, user_id) values
  ('f1025500-0000-4000-8000-000000000021', 'f1025500-0000-4000-8000-000000000002');

-- B 店的資料匯入先關(批次關閉時不該再寫它的紀錄)。
update merchant_feature_grants set enabled = false
  where merchant_id = 'f1025500-0000-4000-8000-000000000022' and feature_key = 'data_import';

select count(*)::int as n from merchants \gset all_
select count(*)::int as n from merchant_feature_grants where feature_key = 'data_import' and enabled \gset on_before_

-- ─── ① 權限 ──────────────────────────────────────────────────────────────
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000003');
select throws_ok($$select * from public.platform_feature_usage_summary()$$,
  '42501', '只有超級管理員可以查看功能開關統計。', '①-1 一般登入者看統計 ⇒ 42501');
select throws_ok($$select public.platform_set_feature_for_all_merchants('data_import', false)$$,
  '42501', '只有超級管理員可以調整功能開關。', '①-2 一般登入者批次開關 ⇒ 42501');
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000002');
select throws_ok($$select * from public.platform_feature_usage_summary()$$,
  '42501', null, '①-3 商家管理員看統計 ⇒ 42501');
select throws_ok($$select public.platform_set_feature_for_all_merchants('data_import', false)$$,
  '42501', null, '①-4 商家管理員批次開關 ⇒ 42501');
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000003', 'anon');
select throws_ok($$select public.platform_set_feature_for_all_merchants('data_import', false)$$,
  '42501', null, '①-5 匿名 ⇒ 權限錯誤');
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_feature_grant_logs where is_bulk), 0, '①-6 被擋下時沒有寫任何紀錄');

-- ─── ② 錯誤輸入 ───────────────────────────────────────────────────────────
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000001');
select throws_ok($$select public.platform_set_feature_for_all_merchants('no_such_feature', false)$$,
  '22023', '沒有這個功能。', '②-1 功能不在清單 ⇒ 22023');
select throws_ok($$select public.platform_set_feature_for_all_merchants('data_import', null)$$,
  '22023', '請指定要開啟還是關閉。', '②-2 沒指定開或關 ⇒ 22023');
select throws_ok(
  format($$select public.platform_set_feature_for_all_merchants('data_import', false, true, %L)$$, repeat('字', 201)),
  '22023', '備註最多 200 字。', '②-3 備註 201 字 ⇒ 22023');

-- ─── ③ 統計 ──────────────────────────────────────────────────────────────
select is(
  (select enabled_count || '/' || disabled_count from public.platform_feature_usage_summary() where feature_key = 'data_import'),
  :on_before_n || '/' || (:all_n - :on_before_n),
  '③-1 統計 = 實際開 / 關的商家數(含停用的 C 店)');
select is(
  (select count(*)::int from public.platform_feature_usage_summary()),
  (select count(*)::int from platform_features),
  '③-2 每個功能一列');
select pg_temp.test_clear_auth();
update merchant_feature_grants set enabled = false
  where merchant_id = 'f1025500-0000-4000-8000-000000000021' and feature_key = 'staff_portal';
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000001');
select ok(
  (select disabled_count >= 1 from public.platform_feature_usage_summary() where feature_key = 'staff_self_payroll'),
  '③-3 細部功能自己的列是開的、主功能關 ⇒ 統計算關(T5)');
select pg_temp.test_clear_auth();
update merchant_feature_grants set enabled = true
  where merchant_id = 'f1025500-0000-4000-8000-000000000021' and feature_key = 'staff_portal';

-- ─── ④ 批次關閉(p_also_presets = false) ───────────────────────────────────
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000001');
select is(
  public.platform_set_feature_for_all_merchants('data_import', false, false),
  :on_before_n, '④-1 回傳實際被改變的商家數(= 原本開著的店數)');
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchants m where private.merchant_has_feature(m.id, 'data_import')),
  0, '④-2 所有商家(含停用)effective = false');
select is(
  (select count(*)::int from merchant_feature_grant_logs where feature_key = 'data_import' and is_bulk),
  :on_before_n, '④-3 只對原本開著的店寫紀錄');
select is(
  (select count(*)::int from merchant_feature_grant_logs
    where merchant_id = 'f1025500-0000-4000-8000-000000000022' and feature_key = 'data_import'),
  0, '④-4 原本就關的 B 店沒有紀錄');
select is(
  (select string_agg(distinct coalesce(old_enabled::text, 'null') || '>' || new_enabled::text || '|' || note || '|'
                     || changed_by::text, ',')
     from merchant_feature_grant_logs where feature_key = 'data_import' and is_bulk),
  'true>false|批次調整|f1025500-0000-4000-8000-000000000001',
  '④-5 紀錄:開→關、備註空白寫「批次調整」、改的人 = 超級管理員');
select is(
  (select string_agg(industry_type || ':' || default_enabled::text, ',' order by industry_type)
     from industry_feature_presets where feature_key = 'data_import'),
  'in_store_beauty:true,on_site_dispatch:true',
  '⑤-1 p_also_presets = false ⇒ 兩產業預設不變');

-- ─── ⑥ 同值再按一次 ───────────────────────────────────────────────────────
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000001');
select is(
  public.platform_set_feature_for_all_merchants('data_import', false, true),
  0, '⑥-1 已經全部是關 ⇒ 回傳 0');
select pg_temp.test_clear_auth();
select is(
  (select string_agg(industry_type || ':' || default_enabled::text, ',' order by industry_type)
     from industry_feature_presets where feature_key = 'data_import'),
  'in_store_beauty:false,on_site_dispatch:false',
  '⑤-2 p_also_presets = true ⇒ 兩產業預設一起改成關(就算沒有商家改變)');

-- ─── ⑦ 批次開啟 + 自訂備註 ──────────────────────────────────────────────
select pg_temp.test_set_auth('f1025500-0000-4000-8000-000000000001');
select is(
  public.platform_set_feature_for_all_merchants('data_import', true, true, '  統一打開  '),
  :all_n, '⑦-1 批次開啟:所有商家都改變');
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_feature_grant_logs
    where feature_key = 'data_import' and is_bulk and new_enabled and note = '統一打開'),
  :all_n, '⑦-2 每間都有一列開啟紀錄,備註去掉前後空白');

-- ─── ⑧ ACL ────────────────────────────────────────────────────────────────
select is(
  array[
    has_function_privilege('anon', 'public.platform_feature_usage_summary()', 'execute'),
    has_function_privilege('authenticated', 'public.platform_feature_usage_summary()', 'execute'),
    has_function_privilege('anon', 'public.platform_set_feature_for_all_merchants(text, boolean, boolean, text)', 'execute'),
    has_function_privilege('authenticated', 'public.platform_set_feature_for_all_merchants(text, boolean, boolean, text)', 'execute')
  ],
  array[false, true, false, true],
  '⑧-1 兩支函式:anon 不能執行,authenticated 可以(函式第一行再檢查超級管理員)');

select * from finish();
rollback;
