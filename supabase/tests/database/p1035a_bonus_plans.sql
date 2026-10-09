-- SPECS-INDEX #1035 彈性計薪 A 批(月薪加獎金)— 資料 / 權限 / 歷史 / 對外函式
-- migration 20261010160000_req1035a_bonus_plans_schema.sql、20261010160100_req1035a_bonus_functions.sql
-- 規格書:母版 .project/specs/彈性計薪.md PA-D01~D03、PA-F01~F06、PX-01~02。
--
--   A  三張新表:RLS 開、0 policy、anon / authenticated 沒有任何表權限;名稱 check、使用中同名唯一、
--      effective_month 必須是 1 號、(plan, month) 唯一
--   B  函式 ACL:private.* 三個角色都沒有 EXECUTE;public.* 只有 authenticated;
--      get_staff_payroll_status_as_of 重建後 ACL 跟改前一樣、多回 bonus_plan_id;五支呼叫者照常能跑
--   C  指派 → 歷史開新列;相同值不開新列;月中換方案取月底值;非月薪制 / 已封存 / 別店方案被擋
--   D  save:新增 / 同名 / 驗證(多餘欄位、種類、百分比、別店服務、條數)/ 本月與下個月版本 / 不能選過去
--   E  版本選取:方案建立前的月份 0;effective_month ≤ 該月的最新一版
--   F  archive:有人在用擋下並說是誰;沒人用才封存;殘留指派清掉;封存後不能指派、不能修改
--   G  IDOR:別店管理員 list / save / set / archive / preview / get 全擋;沒有薪資設定權限的客服擋
--   H  get_staff_bonus_by_range:本人看得到自己、看不到別人;本人回應不含方案資訊;不完整月份列進 partial_months
begin;

select plan(69);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- ── Fixture ───────────────────────────────────────────────────────────────
--   A 店:01 管理員、03 沒有薪資設定權限的客服、04 月薪人員 M1 的登入帳號
--   B 店:02 管理員
insert into auth.users (id, email) values
  ('f1035a00-0000-4000-8000-000000000001', 'pgtap-1035a-admin-a@test.local'),
  ('f1035a00-0000-4000-8000-000000000002', 'pgtap-1035a-admin-b@test.local'),
  ('f1035a00-0000-4000-8000-000000000003', 'pgtap-1035a-agent-a@test.local'),
  ('f1035a00-0000-4000-8000-000000000004', 'pgtap-1035a-staff-m1@test.local');
insert into groups (id) values
  ('f1035a00-0000-4000-8000-000000000011'),
  ('f1035a00-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1035a00-0000-4000-8000-000000000020', 'f1035a00-0000-4000-8000-000000000011', '#1035 A 店', 'on_site_dispatch'),
  ('f1035a00-0000-4000-8000-000000000021', 'f1035a00-0000-4000-8000-000000000012', '#1035 B 店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f1035a00-0000-4000-8000-000000000020', 'f1035a00-0000-4000-8000-000000000001', 'A 店主'),
  ('f1035a00-0000-4000-8000-000000000021', 'f1035a00-0000-4000-8000-000000000002', 'B 店主');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f1035a00-0000-4000-8000-000000000025', 'f1035a00-0000-4000-8000-000000000020', 'f1035a00-0000-4000-8000-000000000003', '訂單客服', 'pgtap-1035a-agent-a@test.local', 'active', now(), '0900103525');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f1035a00-0000-4000-8000-000000000025', 'orders', true);
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('f1035a00-0000-4000-8000-000000000031', 'f1035a00-0000-4000-8000-000000000020', '冷氣清洗', 3000, 'primary', 60, 'active'),
  ('f1035a00-0000-4000-8000-000000000032', 'f1035a00-0000-4000-8000-000000000020', '舊項目', 1000, 'primary', 60, 'removed'),
  ('f1035a00-0000-4000-8000-000000000033', 'f1035a00-0000-4000-8000-000000000021', 'B 店項目', 1000, 'primary', 60, 'active');
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('f1035a00-0000-4000-8000-000000000040', 'f1035a00-0000-4000-8000-000000000020', 'f1035a00-0000-4000-8000-000000000004', '月薪一', 'monthly_salary', 'active', 'active', now(), '0900103540');
insert into merchant_staff (id, merchant_id, name, compensation_type, status, phone) values
  ('f1035a00-0000-4000-8000-000000000041', 'f1035a00-0000-4000-8000-000000000020', '月薪二', 'monthly_salary', 'active', '0900103541'),
  ('f1035a00-0000-4000-8000-000000000042', 'f1035a00-0000-4000-8000-000000000020', '抽成人', 'piece_rate', 'active', '0900103542'),
  ('f1035a00-0000-4000-8000-000000000043', 'f1035a00-0000-4000-8000-000000000021', 'B 月薪', 'monthly_salary', 'active', '0900103543');
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f1035a00-0000-4000-8000-000000000040', 'staff_payroll_view', true);
insert into staff_salary_settings (staff_id, monthly_base_salary) values
  ('f1035a00-0000-4000-8000-000000000040', 30000),
  ('f1035a00-0000-4000-8000-000000000041', 28000),
  ('f1035a00-0000-4000-8000-000000000043', 30000);

create temp table p1035_ctx on commit drop as
select
  date_trunc('month', now() at time zone 'Asia/Taipei')::date as this_month,
  (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month')::date as next_month;
grant select on p1035_ctx to authenticated;
select this_month, next_month from p1035_ctx \gset ctx_

-- 一條合法規則(per_unit,超過 10 份後每份 300)
create function pg_temp.r_unit() returns jsonb language sql immutable as $$
  select '[{"key":"r1","label":"超過 10 份每份 300","kind":"per_unit","threshold":10,"amount":300}]'::jsonb;
$$;
grant execute on function pg_temp.r_unit() to authenticated;

-- =========================================================================
-- A 三張新表
-- =========================================================================
select is(
  (select array_agg(c.relname::text || ':' || c.relrowsecurity::text order by c.relname)
   from pg_class c where c.relnamespace = 'public'::regnamespace
     and c.relname in ('staff_bonus_plans', 'staff_bonus_plan_versions', 'staff_bonus_assignments')),
  array['staff_bonus_assignments:true', 'staff_bonus_plan_versions:true', 'staff_bonus_plans:true'],
  'A1 三張新表都開 RLS'
);
select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
     and tablename in ('staff_bonus_plans', 'staff_bonus_plan_versions', 'staff_bonus_assignments')),
  0, 'A2 三張新表 0 policy(只走函式)'
);
select is(
  (select count(*)::int from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('staff_bonus_plans', 'staff_bonus_plan_versions', 'staff_bonus_assignments')
     and grantee in ('anon', 'authenticated', 'PUBLIC')),
  0, 'A3 anon / authenticated 對三張新表沒有任何表權限'
);
select throws_ok(
  $$insert into staff_bonus_plans (merchant_id, name) values ('f1035a00-0000-4000-8000-000000000020', '   ')$$,
  '23514', null, 'A4 名稱全空白被 check 擋'
);
select throws_ok(
  $$insert into staff_bonus_plans (merchant_id, name) values ('f1035a00-0000-4000-8000-000000000020', repeat('名', 31))$$,
  '23514', null, 'A5 名稱 31 字被 check 擋'
);
insert into staff_bonus_plans (id, merchant_id, name) values
  ('f1035a00-0000-4000-8000-000000000090', 'f1035a00-0000-4000-8000-000000000020', '測試唯一');
select throws_ok(
  $$insert into staff_bonus_plans (merchant_id, name) values ('f1035a00-0000-4000-8000-000000000020', ' 測試唯一 ')$$,
  '23505', null, 'A6 同店使用中同名(忽略前後空白)被唯一索引擋'
);
update staff_bonus_plans set status = 'archived' where id = 'f1035a00-0000-4000-8000-000000000090';
select lives_ok(
  $$insert into staff_bonus_plans (merchant_id, name, status) values ('f1035a00-0000-4000-8000-000000000020', '測試唯一', 'active')$$,
  'A7 封存的方案不佔名稱'
);
select throws_ok(
  format($$insert into staff_bonus_plan_versions (plan_id, merchant_id, effective_month, rules)
           values ('f1035a00-0000-4000-8000-000000000090', 'f1035a00-0000-4000-8000-000000000020', %L::date + 3, '[]')$$, :'ctx_this_month'),
  '23514', null, 'A8 effective_month 不是 1 號被 check 擋'
);
insert into staff_bonus_plan_versions (plan_id, merchant_id, effective_month, rules)
values ('f1035a00-0000-4000-8000-000000000090', 'f1035a00-0000-4000-8000-000000000020', :'ctx_this_month', '[]');
select throws_ok(
  format($$insert into staff_bonus_plan_versions (plan_id, merchant_id, effective_month, rules)
           values ('f1035a00-0000-4000-8000-000000000090', 'f1035a00-0000-4000-8000-000000000020', %L, '[]')$$, :'ctx_this_month'),
  '23505', null, 'A9 同方案同月份只能一版'
);
-- 清掉 A 段的測試列(後面的段落從乾淨狀態開始)
delete from staff_bonus_plans where merchant_id = 'f1035a00-0000-4000-8000-000000000020';

-- =========================================================================
-- B 函式 ACL
-- =========================================================================
select is(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
   where p.pronamespace = 'private'::regnamespace
     and p.proname in ('booking_item_revenue_basis', 'bonus_validate_rules', 'bonus_compute_rules',
                       'compute_staff_monthly_bonus', 'bonus_this_month',
                       'staff_bonus_assignments_sync_payroll_status_history')
     and (has_function_privilege('anon', p.oid, 'execute')
          or has_function_privilege('authenticated', p.oid, 'execute'))),
  null, 'B1 新的 private 函式 anon / authenticated 都沒有 EXECUTE'
);
select is(
  (select count(*)::int from pg_proc p
   where p.pronamespace = 'private'::regnamespace
     and p.proname in ('booking_item_revenue_basis', 'bonus_validate_rules', 'bonus_compute_rules',
                       'compute_staff_monthly_bonus', 'bonus_this_month',
                       'staff_bonus_assignments_sync_payroll_status_history')
     and array_to_string(p.proacl, ',') ~ '(^|,)=X'),
  0, 'B2 新的 private 函式 PUBLIC 沒有 EXECUTE'
);
select is(
  (select array_agg(p.proname::text || ':' || has_function_privilege('anon', p.oid, 'execute')::text || '/'
                    || has_function_privilege('authenticated', p.oid, 'execute')::text order by p.proname)
   from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('list_staff_bonus_plans', 'save_staff_bonus_plan', 'set_staff_bonus_plan',
                       'archive_staff_bonus_plan', 'preview_staff_bonus', 'get_staff_bonus_by_range')),
  array['archive_staff_bonus_plan:false/true', 'get_staff_bonus_by_range:false/true',
        'list_staff_bonus_plans:false/true', 'preview_staff_bonus:false/true',
        'save_staff_bonus_plan:false/true', 'set_staff_bonus_plan:false/true'],
  'B3 六支對外函式:anon 沒有、authenticated 有'
);
select is(
  (select array_to_string(p.proacl, ',') from pg_proc p
   where p.oid = 'private.get_staff_payroll_status_as_of(uuid, timestamptz)'::regprocedure),
  'postgres=X/postgres,authenticated=X/postgres',
  'B4 get_staff_payroll_status_as_of 重建後 ACL 跟改前一樣'
);
select is(
  (select pg_get_function_result('private.get_staff_payroll_status_as_of(uuid, timestamptz)'::regprocedure)),
  -- #1035 B 批 PB-D03:再多回 wage_amount(放最後,前六欄不變)。
  'TABLE(compensation_type text, status text, monthly_base_salary numeric, is_estimated boolean, existed boolean, bonus_plan_id uuid, wage_amount numeric)',
  'B5 get_staff_payroll_status_as_of 多回 bonus_plan_id(前五欄不變;B 批再多 wage_amount)'
);
select is(
  (select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
     and p.prokind = 'f' and p.prosecdef
     and p.proname in ('list_staff_bonus_plans', 'save_staff_bonus_plan', 'set_staff_bonus_plan',
                       'archive_staff_bonus_plan', 'preview_staff_bonus', 'get_staff_bonus_by_range',
                       'booking_item_revenue_basis', 'bonus_validate_rules', 'bonus_compute_rules',
                       'compute_staff_monthly_bonus')
     and array_to_string(p.proconfig, ',') = 'search_path=""'),
  10, 'B6 新的 SECURITY DEFINER 函式都設 search_path = 空字串'
);
-- B7~B11 呼叫者照常能跑(PL/pgSQL 沒有 pg_depend,drop + create 之後要實際呼叫一次)
select lives_ok($$select private.compute_staff_payroll('f1035a00-0000-4000-8000-000000000040', 2026, 9)$$,
  'B7 呼叫者 compute_staff_payroll 照常能跑');
select lives_ok($$select private.compute_staff_payroll_by_range('f1035a00-0000-4000-8000-000000000040', '2026-08-01', '2026-09-30')$$,
  'B8 呼叫者 compute_staff_payroll_by_range 照常能跑');
select is((select total_amount from private.get_merchant_monthly_salary_base_as_of('f1035a00-0000-4000-8000-000000000020', clock_timestamp())),
  58000.00::numeric, 'B9 呼叫者 get_merchant_monthly_salary_base_as_of 照常能跑(30000 + 28000)');
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select lives_ok($$select public.get_merchant_billing_summary('f1035a00-0000-4000-8000-000000000020', 2026, 9)$$,
  'B10 呼叫者 get_merchant_billing_summary(舊版,Q11 不改)照常能跑');
select lives_ok($$select public.get_merchant_billing_summary_by_range('f1035a00-0000-4000-8000-000000000020', '2026-09-01', '2026-09-30')$$,
  'B11 呼叫者 get_merchant_billing_summary_by_range 照常能跑');

-- =========================================================================
-- D save
-- =========================================================================
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"per_unit","threshold":10,"amount":300,"evil":1}]', 'this_month')$$,
  '22023', '第 1 條規則有不認得的欄位「evil」。', 'D1 多餘欄位一律拒收'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"bogus","threshold":0,"amount":1}]', 'this_month')$$,
  '22023', '第 1 條規則的「給什麼」不正確。', 'D2 不認得的「給什麼」⇒ 拒收(#1035 C 批起 formula 是合法種類,見 p1035c_formula)'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"per_unit","threshold":0,"amount":1},{"key":"r2","label":"y","kind":"percent","threshold":0,"percent":5,"amount":3}]', 'this_month')$$,
  '22023', '第 2 條規則是「業績百分比」，不用填「金額」。', 'D3 指出第幾條、哪個欄位(全形標點)'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"percent","threshold":0,"percent":100.5}]', 'this_month')$$,
  '22023', null, 'D4 百分比超過 100 被擋'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"per_unit","threshold":0,"amount":1,"service_item_ids":["f1035a00-0000-4000-8000-000000000033"]}]', 'this_month')$$,
  '22023', '第 1 條規則的「只算這些服務」裡有不屬於這間店的服務項目。', 'D5 別店的服務項目被擋(PX-02)'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      (select jsonb_agg(jsonb_build_object('key', 'r' || g, 'label', 'x', 'kind', 'per_order', 'threshold', 0, 'amount', 1))
       from generate_series(1, 21) g), 'this_month')$$,
  '22023', '一個獎金方案至少要有 1 條規則，最多 20 條。', 'D6 超過 20 條被擋'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組', pg_temp.r_unit(), 'last_month')$$,
  '22023', null, 'D7 不能選過去月份(只收 this_month / next_month)'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"lump_sum","metric":"units","threshold":10,"amount":1000,"retroactive":true}]', 'this_month')$$,
  '22023', '第 1 條規則是「達標給一筆」，不能勾選「達標後整月都算」。', 'D8 達標給一筆不能勾整月都算'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"x","kind":"per_unit","threshold":10,"cap":10,"amount":1}]', 'this_month')$$,
  '22023', '第 1 條規則的「算到多少為止」要大於「超過多少後才開始算」。', 'D9 cap 要大於 threshold'
);
-- 合法:含已下架的本店服務項目(規格:含已下架)
select lives_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '冷氣組',
      '[{"key":"r1","label":"超過 10 份每份 300","kind":"per_unit","threshold":10,"amount":300,"service_item_ids":["f1035a00-0000-4000-8000-000000000032","f1035a00-0000-4000-8000-000000000031","f1035a00-0000-4000-8000-000000000031"]}]', 'this_month')$$,
  'D10 新增方案(服務項目含已下架、重複的合併)'
);
reset role;
select id as plan1 from staff_bonus_plans where merchant_id = 'f1035a00-0000-4000-8000-000000000020' and name = '冷氣組' \gset
select is(
  (select rules from staff_bonus_plan_versions where plan_id = :'plan1'::uuid and effective_month = :'ctx_this_month'::date),
  '[{"key":"r1","cap":null,"kind":"per_unit","label":"超過 10 份每份 300","amount":300,"metric":"units","percent":null,"threshold":10,"retroactive":false,"service_item_ids":["f1035a00-0000-4000-8000-000000000031","f1035a00-0000-4000-8000-000000000032"]}]'::jsonb,
  'D11 存進去的是正規化後的規則(補齊欄位、metric 由種類決定、服務去重排序)'
);
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, ' 冷氣組 ', pg_temp.r_unit(), 'this_month')$$,
  '23505', '已經有同名的獎金方案「冷氣組」，請換一個名稱。', 'D12 同店同名被擋'
);
-- 下個月起另有設定:本月版不動
select lives_ok(
  format($$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', %L, '冷氣組',
      '[{"key":"r1","label":"下個月起每份 500","kind":"per_unit","threshold":10,"amount":500}]', 'next_month')$$, :'plan1'),
  'D13 改規則選「從下個月起」'
);
select is(
  (select jsonb_build_object(
     'cur', (p -> 'current_version' -> 'rules' -> 0 ->> 'amount'),
     'next', (p -> 'next_version' -> 'rules' -> 0 ->> 'amount'),
     'next_month', (p -> 'next_version' ->> 'effective_month'))
   from jsonb_array_elements(public.list_staff_bonus_plans('f1035a00-0000-4000-8000-000000000020') -> 'plans') p
   where p ->> 'name' = '冷氣組'),
  jsonb_build_object('cur', '300', 'next', '500', 'next_month', :'ctx_next_month'),
  'D14 list:本月版仍是 300,下個月版 500'
);
select lives_ok(
  format($$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', %L, '冷氣組',
      '[{"key":"r1","label":"本月改成每份 350","kind":"per_unit","threshold":10,"amount":350}]', 'this_month')$$, :'plan1'),
  'D15 再改規則選「從本月起」'
);
select is(
  (select (p -> 'current_version' -> 'rules' -> 0 ->> 'amount') || '/' || (p -> 'next_version' -> 'rules' -> 0 ->> 'amount')
   from jsonb_array_elements(public.list_staff_bonus_plans('f1035a00-0000-4000-8000-000000000020') -> 'plans') p
   where p ->> 'name' = '冷氣組'),
  '350/500', 'D16「從本月起」只覆蓋本月那一版,下個月那版不動'
);
select is(
  (select count(*)::int from jsonb_array_elements(public.list_staff_bonus_plans('f1035a00-0000-4000-8000-000000000020') -> 'service_items')),
  2, 'D17 list 帶本店全部服務項目(含已下架,不含別店)'
);

-- =========================================================================
-- C 指派 → 歷史
-- =========================================================================
select throws_ok(
  format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000042', %L)$$, :'plan1'),
  '22023', '只有月薪制的服務人員可以套用獎金方案。', 'C1 抽成制不能套用'
);
reset role;
select count(*)::int as h0 from staff_payroll_status_history where staff_id = 'f1035a00-0000-4000-8000-000000000040' \gset
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select lives_ok(format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000040', %L)$$, :'plan1'),
  'C2 指派方案給月薪一');
reset role;
select is(
  (select count(*)::int - :h0 || '/' || coalesce((select bonus_plan_id::text from staff_payroll_status_history
     where staff_id = 'f1035a00-0000-4000-8000-000000000040' and effective_to is null), 'null')
   from staff_payroll_status_history where staff_id = 'f1035a00-0000-4000-8000-000000000040'),
  '1/' || :'plan1', 'C3 指派後歷史開一列新的,目前那列 bonus_plan_id = 方案'
);
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select lives_ok(format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000040', %L)$$, :'plan1'),
  'C4 再指派同一個方案');
reset role;
select is(
  (select count(*)::int - :h0 from staff_payroll_status_history where staff_id = 'f1035a00-0000-4000-8000-000000000040'),
  1, 'C5 相同值不開新列'
);
-- 改月薪金額也照常開新列,且帶著 bonus_plan_id(不會把方案洗掉)
update staff_salary_settings set monthly_base_salary = 31000 where staff_id = 'f1035a00-0000-4000-8000-000000000040';
select is(
  (select bonus_plan_id::text || '/' || monthly_base_salary::int from staff_payroll_status_history
   where staff_id = 'f1035a00-0000-4000-8000-000000000040' and effective_to is null),
  :'plan1' || '/31000', 'C6 改月薪開新列時 bonus_plan_id 照帶'
);

-- C7 月中換方案取月底值:兩個方案,把歷史時間挪到上上個月,月中換成方案 2
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '水電組', pg_temp.r_unit(), 'this_month') as plan2 \gset
select lives_ok(format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000041', %L)$$, :'plan1'), 'C7a 月薪二指派方案 1');
select lives_ok(format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000041', %L)$$, :'plan2'), 'C7b 月薪二改成方案 2');
reset role;
-- 把月薪二的歷史改成:很久以前起(未指派)→ 上上個月 1 號起方案 1 → 上上個月 15 號起方案 2
--   (最後兩列是方案 1、方案 2;前面幾列(建立、設定月薪)排在 2020 年,彼此相接)
with h as (
  select id, row_number() over (order by effective_from) as rn, count(*) over () as n
  from staff_payroll_status_history where staff_id = 'f1035a00-0000-4000-8000-000000000041'
),
t as (
  select id, rn, n,
    (:'ctx_this_month'::date - interval '2 months')::timestamp at time zone 'Asia/Taipei' as p1_from,
    (:'ctx_this_month'::date - interval '2 months' + interval '14 days')::timestamp at time zone 'Asia/Taipei' as p2_from
  from h
)
update staff_payroll_status_history s
set effective_from = case
      when t.rn = t.n then t.p2_from
      when t.rn = t.n - 1 then t.p1_from
      else timestamptz '2020-01-01 00:00+08' + (t.rn - 1) * interval '1 day' end,
    effective_to = case
      when t.rn = t.n then null
      when t.rn = t.n - 1 then t.p2_from
      when t.rn = t.n - 2 then t.p1_from
      else timestamptz '2020-01-01 00:00+08' + t.rn * interval '1 day' end
from t where t.id = s.id;
select is(
  (select bonus_plan_id from private.get_staff_payroll_status_as_of('f1035a00-0000-4000-8000-000000000041',
     ((:'ctx_this_month'::date - interval '1 month')::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond')),
  :'plan2'::uuid, 'C8 月中換方案:上上個月用月底當時的方案 2'
);
select is(
  (select bonus_plan_id from private.get_staff_payroll_status_as_of('f1035a00-0000-4000-8000-000000000041',
     ((:'ctx_this_month'::date - interval '2 months')::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond')),
  null::uuid, 'C9 方案指派之前的月份 bonus_plan_id = null'
);

-- =========================================================================
-- E 版本選取(直接放三個版本:上上個月、本月、下個月)
-- =========================================================================
delete from staff_bonus_plan_versions where plan_id = :'plan2'::uuid;
insert into staff_bonus_plan_versions (plan_id, merchant_id, effective_month, rules) values
  (:'plan2'::uuid, 'f1035a00-0000-4000-8000-000000000020', (:'ctx_this_month'::date - interval '2 months')::date,
   '[{"key":"a","label":"v1","kind":"lump_sum","metric":"orders","threshold":0,"cap":null,"amount":100,"percent":null,"retroactive":false,"service_item_ids":[]}]'),
  (:'plan2'::uuid, 'f1035a00-0000-4000-8000-000000000020', :'ctx_this_month'::date,
   '[{"key":"a","label":"v2","kind":"lump_sum","metric":"orders","threshold":0,"cap":null,"amount":200,"percent":null,"retroactive":false,"service_item_ids":[]}]'),
  (:'plan2'::uuid, 'f1035a00-0000-4000-8000-000000000020', :'ctx_next_month'::date,
   '[{"key":"a","label":"v3","kind":"lump_sum","metric":"orders","threshold":0,"cap":null,"amount":300,"percent":null,"retroactive":false,"service_item_ids":[]}]');
select is(
  (select (r ->> 'version_effective_month') || '/' || (r -> 'rules' -> 0 ->> 'label')
   from (select private.compute_staff_monthly_bonus('f1035a00-0000-4000-8000-000000000041', (:'ctx_this_month'::date - interval '1 month')::date) as r) x),
  ((:'ctx_this_month'::date - interval '2 months')::date)::text || '/v1',
  'E1 上個月用 effective_month ≤ 該月的最新一版(上上個月那版)'
);
select is(
  (select r -> 'rules' -> 0 ->> 'label' from (select private.compute_staff_monthly_bonus('f1035a00-0000-4000-8000-000000000041', :'ctx_this_month'::date) as r) x),
  'v2', 'E2 本月用本月那版'
);
select is(
  (select r -> 'rules' -> 0 ->> 'label' from (select private.compute_staff_monthly_bonus('f1035a00-0000-4000-8000-000000000041', :'ctx_next_month'::date) as r) x),
  'v3', 'E3 下個月用下個月那版'
);
delete from staff_bonus_plan_versions where plan_id = :'plan2'::uuid and effective_month = (:'ctx_this_month'::date - interval '2 months')::date;
select is(
  (select (r ->> 'has_plan') || '/' || (r ->> 'amount') || '/' || coalesce(r ->> 'version_effective_month', 'null')
   from (select private.compute_staff_monthly_bonus('f1035a00-0000-4000-8000-000000000041', (:'ctx_this_month'::date - interval '1 month')::date) as r) x),
  'true/0/null', 'E4 方案建立前的月份(沒有 ≤ 該月的版本)= 0'
);

-- =========================================================================
-- F archive
-- =========================================================================
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select throws_ok(
  format($$select public.archive_staff_bonus_plan(%L)$$, :'plan1'),
  '23503', '還有 1 位月薪人員使用這個方案（月薪一），請先改掉。', 'F1 有人在用 ⇒ 擋下並說是誰'
);
-- 月薪一改成抽成制(指派殘留),封存時要被清掉
reset role;
update merchant_staff set compensation_type = 'piece_rate' where id = 'f1035a00-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select lives_ok(format($$select public.archive_staff_bonus_plan(%L)$$, :'plan1'), 'F2 沒有在職月薪人員在用 ⇒ 可以封存');
reset role;
select is(
  (select status || '/' || coalesce((select plan_id::text from staff_bonus_assignments where staff_id = 'f1035a00-0000-4000-8000-000000000040'), 'null')
   from staff_bonus_plans where id = :'plan1'::uuid),
  'archived/null', 'F3 封存後狀態 archived,殘留的指派清掉'
);
update merchant_staff set compensation_type = 'monthly_salary' where id = 'f1035a00-0000-4000-8000-000000000040';
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select throws_ok(
  format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000040', %L)$$, :'plan1'),
  '22023', '這個方案已經封存，不能再指派。', 'F4 封存的方案不能再指派'
);
select throws_ok(
  format($$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', %L, '冷氣組', pg_temp.r_unit(), 'this_month')$$, :'plan1'),
  '22023', '這個方案已經封存，不能再修改。', 'F5 封存的方案不能再修改'
);
select is(
  (select p ->> 'status' from jsonb_array_elements(public.list_staff_bonus_plans('f1035a00-0000-4000-8000-000000000020') -> 'plans') p
   where p ->> 'id' = :'plan1'),
  'archived', 'F6 list 仍列出封存的方案'
);

-- =========================================================================
-- G IDOR / 權限
-- =========================================================================
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000002');
select throws_ok($$select public.list_staff_bonus_plans('f1035a00-0000-4000-8000-000000000020')$$,
  '42501', null, 'G1 B 店管理員不能列 A 店方案');
select throws_ok(
  format($$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000021', %L, '偷改', pg_temp.r_unit(), 'this_month')$$, :'plan2'),
  'P0002', '找不到這個獎金方案。', 'G2 B 店管理員拿 A 店方案 id 改名(帶自己的店)⇒ 找不到'
);
select throws_ok(
  format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000043', %L)$$, :'plan2'),
  'P0002', '找不到這個獎金方案。', 'G3 B 店管理員不能把 A 店方案指派給自己的人'
);
select throws_ok(
  format($$select public.set_staff_bonus_plan('f1035a00-0000-4000-8000-000000000041', %L)$$, :'plan2'),
  '42501', null, 'G4 B 店管理員不能改 A 店服務人員的指派'
);
select throws_ok(format($$select public.archive_staff_bonus_plan(%L)$$, :'plan2'),
  '42501', null, 'G5 B 店管理員不能封存 A 店方案');
select throws_ok(
  format($$select public.preview_staff_bonus('f1035a00-0000-4000-8000-000000000021', pg_temp.r_unit(), 'f1035a00-0000-4000-8000-000000000041', %L)$$, :'ctx_this_month'),
  'P0002', '找不到這位服務人員。', 'G6 B 店管理員不能試算 A 店的人'
);
select throws_ok(
  format($$select public.get_staff_bonus_by_range('f1035a00-0000-4000-8000-000000000041', %L, (%L::date + interval '1 month - 1 day')::date)$$, :'ctx_this_month', :'ctx_this_month'),
  '42501', null, 'G7 B 店管理員不能看 A 店服務人員的獎金'
);
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000003');
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035a00-0000-4000-8000-000000000020', null, '客服建的', pg_temp.r_unit(), 'this_month')$$,
  '42501', null, 'G8 沒有「抽成與薪資設定」權限的客服不能建方案'
);

-- =========================================================================
-- H get_staff_bonus_by_range
-- =========================================================================
reset role;
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000004');
select throws_ok(
  format($$select public.get_staff_bonus_by_range('f1035a00-0000-4000-8000-000000000041', %L, (%L::date + interval '1 month - 1 day')::date)$$, :'ctx_this_month', :'ctx_this_month'),
  '42501', null, 'H1 服務人員本人看不到別人的獎金'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     public.get_staff_bonus_by_range('f1035a00-0000-4000-8000-000000000040', :'ctx_this_month', (:'ctx_this_month'::date + interval '1 month - 1 day')::date) -> 'months' -> 0) k),
  array['amount', 'flags', 'has_plan', 'month', 'rules'],
  'H2 本人看自己:只有金額 / 規則明細,不含方案 id、名稱、版本(PA-F06 末段)'
);
reset role;
select pg_temp.test_set_auth('f1035a00-0000-4000-8000-000000000001');
select is(
  (select (r -> 'months' -> 0 ? 'plan_id')::text || '/' || jsonb_array_length(r -> 'partial_months') || '/' || jsonb_array_length(r -> 'months')
   from (select public.get_staff_bonus_by_range('f1035a00-0000-4000-8000-000000000041',
           (:'ctx_this_month'::date - interval '1 month' + interval '10 days')::date,
           (:'ctx_this_month'::date + interval '1 month - 1 day')::date) as r) x),
  'true/1/1', 'H3 管理員看得到方案資訊;不完整月份(上個月 11 號起)列進 partial_months,只算本月'
);
select throws_ok(
  $$select public.get_staff_bonus_by_range('f1035a00-0000-4000-8000-000000000041', '2025-01-01', '2026-03-01')$$,
  'P0001', '查詢區間最長不能超過一年。', 'H4 區間上限一年'
);

select * from finish();
rollback;
