-- SPECS-INDEX #1049 / #1050(2026-10-10):行事曆格子顯示一致化 + 排程狀態顏色透明度。
-- migration 20261010210000_req1049_1050_calendar_state_opacity_schema / 20261010210100_..._functions。
-- 驗:opacity 欄位 CHECK、第 5 種 outside_business_hours、列數 = 商家數 × 5、seed 冪等不覆蓋、
--     update 函式(權限 42501、anon 無 EXECUTE、新參數、null = 不改、格式 / 範圍檢查、舊版呼叫相容)、
--     get_my_calendar_state_styles 多回 opacity、新函式 get_my_staff_availability_windows 正 / 反、
--     沒有放寬 RLS(沒排休權限的服務人員直接查表仍是 0 筆)、anon 政策 0 條。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(37);

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
  ('c1049000-0000-4000-8000-000000000001', 'pgtap-r1049-admin@test.local'),
  ('c1049000-0000-4000-8000-000000000002', 'pgtap-r1049-agent-none@test.local'),
  ('c1049000-0000-4000-8000-000000000003', 'pgtap-r1049-staff-monthly@test.local'),
  ('c1049000-0000-4000-8000-000000000004', 'pgtap-r1049-staff-other@test.local'),
  ('c1049000-0000-4000-8000-000000000005', 'pgtap-r1049-admin2@test.local');

insert into groups (id) values ('c1049000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('c1049000-0000-4000-8000-000000000021', 'c1049000-0000-4000-8000-000000000011', '透明度測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c1049000-0000-4000-8000-000000000021', 'c1049000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c1049000-0000-4000-8000-000000000031', 'c1049000-0000-4000-8000-000000000021', 'c1049000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-r1049-agent-none@test.local', 'active', now(), '0900104901');

-- 月薪制、沒有「自己排休」權限 ⇒ staff_availability_windows 的 RLS 讀不到自己的時段(R6 要解的情況)
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('c1049000-0000-4000-8000-000000000041', 'c1049000-0000-4000-8000-000000000021', 'c1049000-0000-4000-8000-000000000003', '服務人員月薪', 'monthly_salary', 'active', 'active', now(), '0977104901'),
  ('c1049000-0000-4000-8000-000000000042', 'c1049000-0000-4000-8000-000000000021', 'c1049000-0000-4000-8000-000000000004', '服務人員別人', 'piece_rate', 'active', 'active', now(), '0977104902');

insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('c1049000-0000-4000-8000-000000000041', 3, '09:00', '15:00'),
  ('c1049000-0000-4000-8000-000000000041', 1, '10:00', '12:00'),
  ('c1049000-0000-4000-8000-000000000042', 3, '08:00', '20:00');

select seed_default_merchant_calendar_state_styles('c1049000-0000-4000-8000-000000000021');

-- ① 欄位 / CHECK
select is(
  (select opacity::int from merchant_calendar_state_styles
   where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'),
  100,
  'opacity 預設 100'
);
select throws_ok(
  $$update merchant_calendar_state_styles set opacity = 9
    where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'$$,
  '23514', null, 'opacity 9 被 CHECK 擋下'
);
select throws_ok(
  $$update merchant_calendar_state_styles set opacity = 101
    where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'$$,
  '23514', null, 'opacity 101 被 CHECK 擋下'
);
select lives_ok(
  $$update merchant_calendar_state_styles set opacity = 10
    where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'$$,
  'opacity 10 可以'
);
update merchant_calendar_state_styles set opacity = 100
where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'full_day_leave';
select throws_ok(
  $$insert into merchant_calendar_state_styles (merchant_id, state_type, color)
    values ('c1049000-0000-4000-8000-000000000021', 'whatever', '#123abc')$$,
  '23514', null, 'state_type 不認得的值仍被擋'
);

-- ② seed 5 列、預設深色、冪等、不覆蓋自訂
select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = 'c1049000-0000-4000-8000-000000000021'),
  5, 'seed 種 5 列'
);
select is(
  (select color || '/' || opacity from merchant_calendar_state_styles
   where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'outside_business_hours'),
  '#334155/100', '營業時間外預設 #334155、透明度 100'
);
update merchant_calendar_state_styles set color = '#000000', opacity = 40
where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'outside_business_hours';
select seed_default_merchant_calendar_state_styles('c1049000-0000-4000-8000-000000000021');
select is(
  (select count(*)::int || ':' || max(color) filter (where state_type = 'outside_business_hours')
          || '/' || max(opacity) filter (where state_type = 'outside_business_hours')
   from merchant_calendar_state_styles where merchant_id = 'c1049000-0000-4000-8000-000000000021'),
  '5:#000000/40', '重複 seed 不多種、不覆蓋自訂顏色與透明度'
);

-- ③ 全部商家都是 5 列(migration 補列 + 核對)
select is(
  (select count(*)::int from merchants m
   where (select count(*) from merchant_calendar_state_styles s where s.merchant_id = m.id) <> 5),
  0, '每一間商家都剛好 5 列'
);

-- ④ 新商家自動 5 列
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000005');
select create_group_and_merchant('透明度自動種子店', 'in_store_beauty') \gset new_merchant_
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_calendar_state_styles
   where merchant_id = :'new_merchant_create_group_and_merchant'::uuid),
  5, 'create_group_and_merchant 新商家自動 5 列'
);

-- ⑤ update 權限
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000002');
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1049000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#111111', p_partial_leave_color => '#222222', p_cross_store_occupied_color => '#333333',
    p_outside_business_hours_color => '#444444', p_full_day_leave_opacity => 50)$$,
  '42501', null, '沒有 orders 權限的客服不能改顏色 / 透明度'
);
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000003');
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1049000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#111111', p_partial_leave_color => '#222222', p_cross_store_occupied_color => '#333333',
    p_full_day_leave_opacity => 50)$$,
  '42501', null, '服務人員不能改顏色 / 透明度'
);
select pg_temp.test_clear_auth();

-- ⑥ 管理員一次改 5 色 + 5 個透明度
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000001');
select lives_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1049000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#111111', p_partial_leave_color => '#222222', p_cross_store_occupied_color => '#333333',
    p_staff_available_slot_color => '#444444', p_outside_business_hours_color => ' #1E293B ',
    p_full_day_leave_opacity => 10, p_partial_leave_opacity => 25, p_cross_store_occupied_opacity => 50,
    p_staff_available_slot_opacity => 75, p_outside_business_hours_opacity => 100)$$,
  '管理員可以一次改 5 色 + 5 個透明度'
);
select pg_temp.test_clear_auth();
select is(
  (select string_agg(state_type || '=' || color || '/' || opacity, ',' order by state_type)
   from merchant_calendar_state_styles where merchant_id = 'c1049000-0000-4000-8000-000000000021'),
  'cross_store_occupied=#333333/50,full_day_leave=#111111/10,outside_business_hours=#1E293B/100,partial_leave=#222222/25,staff_available_slot=#444444/75',
  '5 色 + 5 個透明度都寫進去(前後空白去掉)'
);

-- ⑦ null = 不改;舊版前端只傳 5 個參數照樣能用
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000001');
select lives_ok(
  $$select update_merchant_calendar_state_styles(
    'c1049000-0000-4000-8000-000000000021', '#555555', '#666666', '#777777', '#888888')$$,
  '舊版前端只傳 5 個(位置)參數照樣能呼叫'
);
select pg_temp.test_clear_auth();
select is(
  (select string_agg(state_type || '=' || color || '/' || opacity, ',' order by state_type)
   from merchant_calendar_state_styles where merchant_id = 'c1049000-0000-4000-8000-000000000021'),
  'cross_store_occupied=#777777/50,full_day_leave=#555555/10,outside_business_hours=#1E293B/100,partial_leave=#666666/25,staff_available_slot=#888888/75',
  '沒給的營業時間外顏色與所有透明度都維持原值'
);

-- ⑧ 格式 / 範圍檢查
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000001');
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1049000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#111111', p_partial_leave_color => '#222222', p_cross_store_occupied_color => '#333333',
    p_outside_business_hours_color => 'red;background:url(x)')$$,
  'P0001', '「營業時間外」的色碼格式不正確，請輸入像 #334155 這樣的色碼',
  '營業時間外色碼格式不對 ⇒ 擋下'
);
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1049000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#111111', p_partial_leave_color => '#222222', p_cross_store_occupied_color => '#333333',
    p_partial_leave_opacity => 5)$$,
  'P0001', '「時段排休」的透明度要在 10% 到 100% 之間',
  '透明度 5 ⇒ 擋下(白話訊息)'
);
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1049000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#111111', p_partial_leave_color => '#222222', p_cross_store_occupied_color => '#333333',
    p_outside_business_hours_opacity => 101)$$,
  'P0001', null,
  '透明度 101 ⇒ 擋下'
);
select pg_temp.test_clear_auth();
select is(
  (select color from merchant_calendar_state_styles
   where merchant_id = 'c1049000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'),
  '#555555', '被擋下的呼叫整筆沒有寫入'
);

-- ⑨ update 函式屬性
select is(
  (select row(p.prosecdef, p.proconfig::text)::text from pg_proc p
   where p.oid = 'public.update_merchant_calendar_state_styles(uuid,text,text,text,text,text,integer,integer,integer,integer,integer)'::regprocedure),
  row(true, '{search_path=public}')::text,
  'update 函式 SECURITY DEFINER + search_path=public'
);
select ok(
  not has_function_privilege('anon', 'public.update_merchant_calendar_state_styles(uuid,text,text,text,text,text,integer,integer,integer,integer,integer)', 'execute'),
  'anon 不能執行 update 函式'
);
select ok(
  has_function_privilege('authenticated', 'public.update_merchant_calendar_state_styles(uuid,text,text,text,text,text,integer,integer,integer,integer,integer)', 'execute'),
  'authenticated 可以執行 update 函式(函式內再判斷權限)'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_merchant_calendar_state_styles'),
  1, '舊簽章已刪掉,只剩一支'
);

-- ⑩ 服務人員端讀到透明度
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000003');
select is(
  (get_my_calendar_state_styles('c1049000-0000-4000-8000-000000000041'::uuid) #>> '{opacity,partial_leave}'),
  '25', 'get_my_calendar_state_styles 回傳 opacity 物件'
);
select is(
  (get_my_calendar_state_styles('c1049000-0000-4000-8000-000000000041'::uuid) ->> 'outside_business_hours'),
  '#1E293B', 'get_my_calendar_state_styles 回傳營業時間外顏色'
);

-- ⑪ R6:沒有排休權限的服務人員,直接查表仍是 0 筆(RLS 沒放寬)……
select is(
  (select count(*)::int from staff_availability_windows where staff_id = 'c1049000-0000-4000-8000-000000000041'),
  0, 'RLS 沒有放寬:月薪制 / 沒排休權限的服務人員直接查表讀不到自己的時段'
);
-- ……但新函式讀得到自己的時段,只有三個欄位
select is(
  (select string_agg(day_of_week || ' ' || start_time || '-' || end_time, ',' order by day_of_week, start_time)
   from get_my_staff_availability_windows('c1049000-0000-4000-8000-000000000041')),
  '1 10:00:00-12:00:00,3 09:00:00-15:00:00',
  'get_my_staff_availability_windows 回傳本人的每週時段'
);
select throws_ok(
  $$select * from get_my_staff_availability_windows('c1049000-0000-4000-8000-000000000042')$$,
  '42501', null, '傳別人的 staff_id ⇒ 42501'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000001');
select throws_ok(
  $$select * from get_my_staff_availability_windows('c1049000-0000-4000-8000-000000000041')$$,
  '42501', null, '商家管理員也不能用這支讀服務人員的時段(只給本人)'
);
select pg_temp.test_clear_auth();

-- 平台把「服務人員登入端」關掉 ⇒ 42501
insert into merchant_feature_grants (merchant_id, feature_key, enabled)
values ('c1049000-0000-4000-8000-000000000021', 'staff_portal', false)
on conflict (merchant_id, feature_key) do update set enabled = false;
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000003');
select throws_ok(
  $$select * from get_my_staff_availability_windows('c1049000-0000-4000-8000-000000000041')$$,
  '42501', '這個功能目前沒有開放。', '服務人員登入端關閉 ⇒ 42501「這個功能目前沒有開放。」'
);
select pg_temp.test_clear_auth();
update merchant_feature_grants set enabled = true
where merchant_id = 'c1049000-0000-4000-8000-000000000021' and feature_key = 'staff_portal';

-- 已移除(status = removed)⇒ 42501
update merchant_staff set status = 'removed' where id = 'c1049000-0000-4000-8000-000000000041';
select pg_temp.test_set_auth('c1049000-0000-4000-8000-000000000003');
select throws_ok(
  $$select * from get_my_staff_availability_windows('c1049000-0000-4000-8000-000000000041')$$,
  '42501', null, '已移除的服務人員 ⇒ 42501'
);
select pg_temp.test_clear_auth();
update merchant_staff set status = 'active' where id = 'c1049000-0000-4000-8000-000000000041';

-- ⑫ 新函式屬性
select is(
  (select row(p.prosecdef, p.provolatile, p.proconfig::text)::text from pg_proc p
   where p.oid = 'public.get_my_staff_availability_windows(uuid)'::regprocedure),
  row(true, 's'::"char", '{search_path=public}')::text,
  'get_my_staff_availability_windows:SECURITY DEFINER、stable、search_path=public'
);
select ok(
  not has_function_privilege('anon', 'public.get_my_staff_availability_windows(uuid)', 'execute'),
  'anon 不能執行 get_my_staff_availability_windows'
);
select is(
  (select array_agg(a.attname::text order by a.attnum)
   from pg_proc p, unnest(p.proargnames) with ordinality as a(attname, attnum)
   where p.oid = 'public.get_my_staff_availability_windows(uuid)'::regprocedure),
  array['p_staff_id', 'day_of_week', 'start_time', 'end_time'],
  '只回 day_of_week / start_time / end_time 三個欄位'
);

-- ⑬ 沒有任何 anon 政策;這兩張表的政策沒有變多
select is(
  (select count(*)::int from pg_policies where 'anon' = any(roles)),
  0, '整個資料庫 anon 政策 0 條'
);
select is(
  (select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
   where tablename in ('merchant_calendar_state_styles', 'staff_availability_windows')),
  'merchant_calendar_state_styles_select:SELECT,staff_availability_windows_delete:DELETE,staff_availability_windows_insert:INSERT,staff_availability_windows_select:SELECT,staff_availability_windows_update:UPDATE',
  '兩張表的政策清單跟改版前相同(沒新增、沒放寬)'
);

select * from finish();

rollback;
