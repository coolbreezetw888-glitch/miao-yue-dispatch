-- SPECS-INDEX #1025 功能開關 第 1 批 FG1-T01:核心機制(功能清單 / 商家實際開關 / 變更紀錄 / 判斷函式 / 平台 RPC)
-- 規格書 .project/specs/功能開關.md(第 2 版)FG1-T01 ①~⑪(⑫ 屬 ⚠️5,這批不做)。
-- migration 20261010150000_req1025_fg1_feature_grants.sql
--
--   ①  三張新表 RLS 開啟、政策數量正確、anon / authenticated 沒有寫入權限
--   ②  商家管理員直接 insert / update / delete merchant_feature_grants ⇒ 被擋
--   ③  商家管理員寫 merchant_feature_flags 的 online_booking ⇒ CHECK 擋(⚠️2);就算寫進去 merchant_has_feature 也不受影響(T1)
--   ④  platform_set_merchant_feature:一般帳號 / 商家管理員 / 匿名 42501;超級管理員成功 + 紀錄;同值不寫紀錄;錯誤輸入
--   ⑤  get_merchant_features:自己店的管理員 / 客服 / 服務人員可讀;別家管理員帶本店 id ⇒ 42501(IDOR);匿名 ⇒ 權限錯誤
--   ⑥  merchant_has_feature:列值 / 沒列用預設 / 不存在 key / 細部功能在主功能關時 false;只允許一層
--   ⑦  開店、開分店:每個功能一列,值 = 產業預設;產業預設缺時 = 功能清單預設;不寫變更紀錄
--   ⑧  商家切換 industry_type ⇒ merchant_feature_grants 不變(T3)
--   ⑨  改 industry_feature_presets ⇒ 既有商家的 merchant_feature_grants 不變(T2)
--   ⑩  通用完整性:所有商家 × 所有功能都有一列;兩產業 × 所有功能都有產業預設
--   ⑪  ACL
--   ⑫  platform_list_merchant_feature_logs(⚠️1)只給超級管理員,回傳功能名稱與改的人 email
begin;

select plan(54);

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

-- 這間店目前的開關快照(key:enabled,依 key 排序)。
create function pg_temp.grants_of(p_merchant_id uuid)
returns text language sql stable as $$
  select coalesce(string_agg(g.feature_key || ':' || g.enabled::text, ',' order by g.feature_key), '')
  from merchant_feature_grants g where g.merchant_id = p_merchant_id
$$;

-- ─── Fixture ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('f1025000-0000-4000-8000-000000000001', 'pgtap-1025-platform@test.local'),
  ('f1025000-0000-4000-8000-000000000002', 'pgtap-1025-admin-a@test.local'),
  ('f1025000-0000-4000-8000-000000000003', 'pgtap-1025-admin-b@test.local'),
  ('f1025000-0000-4000-8000-000000000004', 'pgtap-1025-agent-a@test.local'),
  ('f1025000-0000-4000-8000-000000000005', 'pgtap-1025-staff-a@test.local'),
  ('f1025000-0000-4000-8000-000000000006', 'pgtap-1025-nobody@test.local');
insert into platform_admins (user_id) values ('f1025000-0000-4000-8000-000000000001');

insert into groups (id) values
  ('f1025000-0000-4000-8000-000000000011'),
  ('f1025000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type, booking_slug) values
  ('f1025000-0000-4000-8000-000000000021', 'f1025000-0000-4000-8000-000000000011', '功能開關A店', 'on_site_dispatch', 'pgtap-1025-a'),
  ('f1025000-0000-4000-8000-000000000022', 'f1025000-0000-4000-8000-000000000012', '功能開關B店', 'in_store_beauty', 'pgtap-1025-b');
-- 直接 insert 的商家不會走開店函式 ⇒ 這裡手動套一次(跟開店同一支)。
select public.apply_industry_preset('f1025000-0000-4000-8000-000000000021');
select public.apply_industry_preset('f1025000-0000-4000-8000-000000000022');
insert into merchant_admins (merchant_id, user_id) values
  ('f1025000-0000-4000-8000-000000000021', 'f1025000-0000-4000-8000-000000000002'),
  ('f1025000-0000-4000-8000-000000000022', 'f1025000-0000-4000-8000-000000000003');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('f1025000-0000-4000-8000-000000000031', 'f1025000-0000-4000-8000-000000000021', 'f1025000-0000-4000-8000-000000000004',
   '客服甲', '0900102501', 'pgtap-1025-agent-a@test.local', 'active');
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('f1025000-0000-4000-8000-000000000041', 'f1025000-0000-4000-8000-000000000021', 'f1025000-0000-4000-8000-000000000005',
   '服務人員甲', 'piece_rate', 'active', 'active', now(), '0900102541');

-- ─── ① 表結構與權限 ──────────────────────────────────────────────────────
select ok(
  (select bool_and(c.relrowsecurity) from pg_class c
    where c.oid in ('public.platform_features'::regclass, 'public.merchant_feature_grants'::regclass,
                    'public.merchant_feature_grant_logs'::regclass)),
  '①-1 三張新表都開了 RLS');
select is(
  array(select tablename || ':' || cmd || ':' || array_to_string(roles, '/') from pg_policies
         where schemaname = 'public'
           and tablename in ('platform_features', 'merchant_feature_grants', 'merchant_feature_grant_logs')
         order by 1),
  array['merchant_feature_grant_logs:SELECT:authenticated',
        'merchant_feature_grants:SELECT:authenticated',
        'platform_features:SELECT:authenticated'],
  '①-2 三張表各只有一條 SELECT 政策(給 authenticated),沒有任何寫入政策');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('platform_features', 'merchant_feature_grants', 'merchant_feature_grant_logs')
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0, '①-3 anon / authenticated 對三張表沒有 insert / update / delete / truncate 權限');
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('platform_features', 'merchant_feature_grants', 'merchant_feature_grant_logs')
      and grantee = 'anon'),
  0, '①-4 anon 對三張表沒有任何權限');

-- ─── ② 商家管理員不能直接寫 merchant_feature_grants ─────────────────────────
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000002');
select throws_ok(
  $$insert into merchant_feature_grants (merchant_id, feature_key, enabled)
      values ('f1025000-0000-4000-8000-000000000022', 'data_import', true)$$,
  '42501', null, '②-1 商家管理員 insert merchant_feature_grants ⇒ 42501');
select throws_ok(
  $$update merchant_feature_grants set enabled = false where merchant_id = 'f1025000-0000-4000-8000-000000000021'$$,
  '42501', null, '②-2 商家管理員 update 自己店的 merchant_feature_grants ⇒ 42501');
select throws_ok(
  $$delete from merchant_feature_grants where merchant_id = 'f1025000-0000-4000-8000-000000000021'$$,
  '42501', null, '②-3 商家管理員 delete 自己店的 merchant_feature_grants ⇒ 42501');

-- ─── ③ ⚠️2 merchant_feature_flags 只能寫兩種 key;而且判斷函式不看它(T1) ───────
select throws_ok(
  $$insert into merchant_feature_flags (merchant_id, feature_key, enabled)
      values ('f1025000-0000-4000-8000-000000000021', 'online_booking', true)$$,
  '23514', null, '③-1 商家管理員往 merchant_feature_flags 寫 online_booking ⇒ CHECK 擋(23514)');
select pg_temp.test_clear_auth();
-- 模擬「拿掉 ⚠️2」:暫時移掉 CHECK 把關閉的值寫進去,判斷函式照樣只看 merchant_feature_grants。
alter table merchant_feature_flags drop constraint merchant_feature_flags_feature_key_allowed;
insert into merchant_feature_flags (merchant_id, feature_key, enabled)
  values ('f1025000-0000-4000-8000-000000000021', 'data_import', false);
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'data_import'),
  true, '③-2 就算 merchant_feature_flags 有 data_import = false,merchant_has_feature 仍是 true(只看平台的表)');
delete from merchant_feature_flags where merchant_id = 'f1025000-0000-4000-8000-000000000021' and feature_key = 'data_import';
alter table merchant_feature_flags add constraint merchant_feature_flags_feature_key_allowed
  check (feature_key in ('material_cost_enabled', 'strict_conflict_check'));

-- ─── ④ platform_set_merchant_feature ─────────────────────────────────────
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000006');
select throws_ok(
  $$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'data_import', false)$$,
  '42501', '只有超級管理員可以調整功能開關。', '④-1 一般登入者 ⇒ 42501');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'data_import', false)$$,
  '42501', '只有超級管理員可以調整功能開關。', '④-2 商家管理員對自己店 ⇒ 42501');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000002', 'anon');
select throws_ok(
  $$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'data_import', false)$$,
  '42501', null, '④-3 匿名 ⇒ 權限錯誤(沒有 EXECUTE)');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'data_import', false, '  試用到期  ')$$,
  '④-4 超級管理員關掉 A 店的資料匯入成功');
select pg_temp.test_clear_auth();
select is(
  (select enabled::text || '|' || updated_by::text from merchant_feature_grants
    where merchant_id = 'f1025000-0000-4000-8000-000000000021' and feature_key = 'data_import'),
  'false|f1025000-0000-4000-8000-000000000001', '④-5 開關值變 false,updated_by = 超級管理員');
select is(
  (select array_agg(old_enabled::text || '>' || new_enabled::text || '|' || coalesce(note, '') || '|' || changed_by::text || '|' || is_bulk::text)
     from merchant_feature_grant_logs where merchant_id = 'f1025000-0000-4000-8000-000000000021'),
  array['true>false|試用到期|f1025000-0000-4000-8000-000000000001|false'],
  '④-6 寫了一列紀錄(開→關、備註去頭尾空白、改的人、不是批次)');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000001');
select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'data_import', false);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_feature_grant_logs where merchant_id = 'f1025000-0000-4000-8000-000000000021'),
  1, '④-7 值跟原本一樣再呼叫一次 ⇒ 紀錄不增加');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-0000000000ff', 'data_import', false)$$,
  'P0002', '找不到這間商家。', '④-8 商家不存在 ⇒ P0002');
select throws_ok(
  $$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'no_such_feature', false)$$,
  '22023', '沒有這個功能。', '④-9 功能不在清單 ⇒ 22023');
select throws_ok(
  format($$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'report_export', false, %L)$$, repeat('字', 201)),
  '22023', '備註最多 200 字。', '④-10 備註 201 字 ⇒ 22023');
select lives_ok(
  format($$select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'report_export', false, %L)$$, repeat('字', 200)),
  '④-11 備註剛好 200 字可以存');
select public.platform_set_merchant_feature('f1025000-0000-4000-8000-000000000021', 'report_export', true);
select pg_temp.test_clear_auth();

-- ─── ⑤ get_merchant_features(含 IDOR) ─────────────────────────────────────
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')),
  (select count(*)::int from platform_features), '⑤-1 自己店的管理員讀得到全部功能(#1025 FG-3 起功能清單不只 3 項)');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000004');
select is(
  (select count(*)::int from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')),
  (select count(*)::int from platform_features), '⑤-2 自己店的客服讀得到');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000005');
select is(
  (select count(*)::int from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')),
  (select count(*)::int from platform_features), '⑤-3 自己店的服務人員讀得到');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000003');
select throws_ok(
  $$select * from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')$$,
  '42501', '沒有權限查看這間商家的功能。', '⑤-4 別家店的管理員帶入 A 店 id ⇒ 42501(IDOR)');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000006');
select throws_ok(
  $$select * from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')$$,
  '42501', '沒有權限查看這間商家的功能。', '⑤-5 跟這間店無關的登入者 ⇒ 42501');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000006', 'anon');
select throws_ok(
  $$select * from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')$$,
  '42501', null, '⑤-6 匿名 ⇒ 權限錯誤');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000001');
select is(
  array(select feature_key || ':' || coalesce(granted::text, 'null') || ':' || effective::text || ':' || coalesce(preset_enabled::text, 'null')
          from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')
         where feature_key in ('online_booking', 'data_import', 'report_export')),
  array['online_booking:true:true:true', 'data_import:false:false:true', 'report_export:true:true:true'],
  '⑤-7 超級管理員讀得到;依 sort_order 排序;granted / effective / preset_enabled 正確');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from merchant_feature_grants where merchant_id = 'f1025000-0000-4000-8000-000000000022'),
  0, '⑤-8 RLS:商家管理員直接讀表也看不到別家店的開關');
select pg_temp.test_clear_auth();

-- ─── ⑥ merchant_has_feature ────────────────────────────────────────────────
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'data_import'),
  false, '⑥-1 有列 ⇒ 用列值(false)');
delete from merchant_feature_grants where merchant_id = 'f1025000-0000-4000-8000-000000000021' and feature_key = 'report_export';
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'report_export'),
  true, '⑥-2 沒有列 ⇒ 用功能清單預設值(true)');
update platform_features set default_enabled = false where key = 'report_export';
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'report_export'),
  false, '⑥-3 沒有列 ⇒ 用功能清單預設值(改成 false 後跟著變)');
update platform_features set default_enabled = true where key = 'report_export';
insert into merchant_feature_grants (merchant_id, feature_key, enabled)
  values ('f1025000-0000-4000-8000-000000000021', 'report_export', true);
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'no_such_feature'),
  false, '⑥-4 不存在的 key ⇒ false(fail closed)');
select is(
  private.merchant_has_feature(null, 'online_booking'),
  false, '⑥-5 merchant_id 為 null ⇒ false');
-- 臨時主 / 細部功能(測完刪掉,不影響 ⑩)
insert into platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled) values
  ('zz_parent', '測試主功能', '測試', '測試', null, 900, true),
  ('zz_child', '測試細部功能', '測試', '測試', 'zz_parent', 901, true);
insert into merchant_feature_grants (merchant_id, feature_key, enabled) values
  ('f1025000-0000-4000-8000-000000000021', 'zz_parent', false),
  ('f1025000-0000-4000-8000-000000000021', 'zz_child', true);
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'zz_child'),
  false, '⑥-6 細部功能自己是開的,但主功能關 ⇒ false(T5)');
update merchant_feature_grants set enabled = true
  where merchant_id = 'f1025000-0000-4000-8000-000000000021' and feature_key = 'zz_parent';
select is(
  private.merchant_has_feature('f1025000-0000-4000-8000-000000000021', 'zz_child'),
  true, '⑥-7 主功能重新打開 ⇒ 細部功能原本的值恢復');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000001');
select is(
  array(select feature_key from public.get_merchant_features('f1025000-0000-4000-8000-000000000021')),
  array['online_booking', 'data_import', 'report_export',
        'staff_portal', 'staff_order_editing', 'staff_self_availability', 'staff_self_payroll',
        -- #1025 FG-2:LINE 通知(底下再行銷通知)、手機推播通知
        'line_notifications', 'line_marketing', 'push_notifications',
        'zz_parent', 'zz_child'],
  '⑥-8 get_merchant_features:細部功能緊跟在自己的主功能後面');
select pg_temp.test_clear_auth();
select throws_ok(
  $$insert into platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled)
      values ('zz_grand', '孫', '測試', '測試', 'zz_child', 902, true)$$,
  '23514', null, '⑥-9 只允許一層:細部功能底下不能再掛細部功能');
select throws_ok(
  $$update platform_features set parent_key = 'report_export' where key = 'zz_parent'$$,
  '23514', null, '⑥-10 只允許一層:已有細部功能的主功能不能變成別人的細部功能');
delete from platform_features where key in ('zz_child', 'zz_parent');

-- ─── ⑦ 開店 / 開分店 ───────────────────────────────────────────────────────
-- 到府派工的「資料匯入」預設改關;到店服務的「報表匯出」產業預設拿掉,功能清單預設暫時改關。
update industry_feature_presets set default_enabled = false
  where industry_type = 'on_site_dispatch' and feature_key = 'data_import';
delete from industry_feature_presets where industry_type = 'in_store_beauty' and feature_key = 'report_export';
update platform_features set default_enabled = false where key = 'report_export';

-- ⑨ 用:改產業預設之前,A 店的快照
select set_config('test.a_grants_before', pg_temp.grants_of('f1025000-0000-4000-8000-000000000021'), true);

select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000006');
select lives_ok(
  $$select public.create_group_and_merchant('功能開關測試新店', 'on_site_dispatch')$$,
  '⑦-1 一般登入者開新店成功');
select pg_temp.test_clear_auth();
select set_config('test.new_id', (select id::text from merchants where name = '功能開關測試新店'), true);
select set_config('test.new_gid', (select group_id::text from merchants where name = '功能開關測試新店'), true);
select is(
  pg_temp.grants_of(current_setting('test.new_id')::uuid),
  'data_import:false,line_marketing:true,line_notifications:true,online_booking:true,push_notifications:true,report_export:true,staff_order_editing:true,staff_portal:true,staff_self_availability:true,staff_self_payroll:true',
  '⑦-2 新店:每個功能都有一列,值 = 到府派工的產業預設(資料匯入關)');

select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000006');
select lives_ok(
  format($$select public.create_merchant_in_group(%L, '功能開關測試分店', 'in_store_beauty')$$, current_setting('test.new_gid')),
  '⑦-3 開分店成功');
select pg_temp.test_clear_auth();
select is(
  pg_temp.grants_of((select id from merchants where name = '功能開關測試分店')),
  'data_import:true,line_marketing:true,line_notifications:true,online_booking:true,push_notifications:true,report_export:false,staff_order_editing:true,staff_portal:true,staff_self_availability:true,staff_self_payroll:true',
  '⑦-4 分店:照自己產業(到店服務)的預設,不複製本店(T4);報表匯出沒有產業預設 ⇒ 用功能清單預設(關)');
select is(
  (select count(*)::int from merchant_feature_grant_logs
    where merchant_id in (current_setting('test.new_id')::uuid, (select id from merchants where name = '功能開關測試分店'))),
  0, '⑦-5 開店自動套用不寫變更紀錄');

-- ─── ⑧ 商家切換產業 ⇒ 開關不變(T3) ───────────────────────────────────────
select set_config('test.new_before', pg_temp.grants_of(current_setting('test.new_id')::uuid), true);
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000006');
update merchants set industry_type = 'in_store_beauty' where id = current_setting('test.new_id')::uuid;
select pg_temp.test_clear_auth();
select is(
  (select industry_type || '|' || pg_temp.grants_of(id) from merchants where id = current_setting('test.new_id')::uuid),
  'in_store_beauty|' || current_setting('test.new_before'),
  '⑧ 商家管理員把產業切成到店服務 ⇒ 產業真的改了,功能開關完全不變');

-- ─── ⑨ 改產業預設 ⇒ 既有商家不變(T2) ─────────────────────────────────────
select is(
  pg_temp.grants_of('f1025000-0000-4000-8000-000000000021'),
  current_setting('test.a_grants_before'),
  '⑨ 改了產業預設(⑦ 開頭那幾行)之後,既有的 A 店開關完全不變');

-- 還原 ⑦ 改的預設
update industry_feature_presets set default_enabled = true
  where industry_type = 'on_site_dispatch' and feature_key = 'data_import';
insert into industry_feature_presets (industry_type, feature_key, default_enabled) values ('in_store_beauty', 'report_export', true);
update platform_features set default_enabled = true where key = 'report_export';

-- ─── ⑩ 通用完整性 ─────────────────────────────────────────────────────────
select is(
  (select count(*)::int from merchants m cross join platform_features f
    where not exists (select 1 from merchant_feature_grants g where g.merchant_id = m.id and g.feature_key = f.key)),
  0, '⑩-1 所有商家 × 所有功能都有一列 merchant_feature_grants(抓「新增功能忘了補既有商家」)');
select is(
  (select count(*)::int from (values ('on_site_dispatch'), ('in_store_beauty')) t(industry_type) cross join platform_features f
    where not exists (select 1 from industry_feature_presets p where p.industry_type = t.industry_type and p.feature_key = f.key)),
  0, '⑩-2 兩個產業 × 所有功能都有產業預設');
select is(
  (select count(*)::int from platform_features),
  10, '⑩-3 功能清單共 10 項(第 1 批 3 項 + #1025 FG-3 服務人員細部功能 4 項 + FG-2 LINE / 再行銷 / 推播 3 項)');

-- ─── ⑪ ACL ────────────────────────────────────────────────────────────────
select is(
  array[
    has_function_privilege('anon', 'public.apply_industry_preset(uuid)', 'execute'),
    has_function_privilege('authenticated', 'public.apply_industry_preset(uuid)', 'execute'),
    has_function_privilege('anon', 'private.merchant_has_feature(uuid, text)', 'execute'),
    has_function_privilege('authenticated', 'private.merchant_has_feature(uuid, text)', 'execute'),
    has_function_privilege('anon', 'private.merchant_public_booking_open(uuid)', 'execute'),
    has_function_privilege('authenticated', 'private.merchant_public_booking_open(uuid)', 'execute')
  ],
  array[false, false, false, false, false, false],
  '⑪-1 apply_industry_preset / merchant_has_feature / merchant_public_booking_open:anon、authenticated 都不能執行');
select is(
  array[
    has_function_privilege('anon', 'public.platform_set_merchant_feature(uuid, text, boolean, text)', 'execute'),
    has_function_privilege('anon', 'public.get_merchant_features(uuid)', 'execute'),
    has_function_privilege('anon', 'public.platform_list_merchant_feature_logs(uuid, integer)', 'execute'),
    has_function_privilege('authenticated', 'public.platform_set_merchant_feature(uuid, text, boolean, text)', 'execute'),
    has_function_privilege('authenticated', 'public.get_merchant_features(uuid)', 'execute'),
    has_function_privilege('authenticated', 'public.platform_list_merchant_feature_logs(uuid, integer)', 'execute')
  ],
  array[false, false, false, true, true, true],
  '⑪-2 三支 public RPC:anon 不行、authenticated 可以(函式內部再檢查身分)');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname, p.proname) in (('public', 'platform_set_merchant_feature'), ('public', 'get_merchant_features'),
                                     ('public', 'platform_list_merchant_feature_logs'), ('private', 'merchant_has_feature'),
                                     ('private', 'merchant_public_booking_open'), ('public', 'apply_industry_preset'))
      and exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)),
  0, '⑪-3 新增 / 改寫的函式 PUBLIC 都沒有 EXECUTE');

-- ─── ⑫ platform_list_merchant_feature_logs ────────────────────────────────
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000002');
select throws_ok(
  $$select * from public.platform_list_merchant_feature_logs('f1025000-0000-4000-8000-000000000021')$$,
  '42501', '只有超級管理員可以查看功能開關紀錄。', '⑫-1 商家管理員看自己店的紀錄 ⇒ 42501');
select pg_temp.test_set_auth('f1025000-0000-4000-8000-000000000001');
select is(
  array(select feature_name || '|' || old_enabled::text || '>' || new_enabled::text || '|' || changed_by_email
          from public.platform_list_merchant_feature_logs('f1025000-0000-4000-8000-000000000021')),
  array['報表匯出中心|false>true|pgtap-1025-platform@test.local',
        '報表匯出中心|true>false|pgtap-1025-platform@test.local',
        '資料匯入|true>false|pgtap-1025-platform@test.local'],
  '⑫-2 超級管理員看得到紀錄(新的在前、功能名稱、改的人 email)');
select is(
  (select count(*)::int from public.platform_list_merchant_feature_logs('f1025000-0000-4000-8000-000000000021', 1)),
  1, '⑫-3 p_limit 有效');
select pg_temp.test_clear_auth();

select * from finish();
rollback;
