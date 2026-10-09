-- SPECS-INDEX #1021(第 21 批):行事曆「服務人員可預約時段」底色 = merchant_calendar_state_styles 第 4 種
-- state_type = 'staff_available_slot'。驗:CHECK 收新值、seed / 新商家 / 既有商家補值、update 新參數
-- (權限、格式檢查、null = 不改、舊 4 參數呼叫仍可用)、服務人員端 get_my_calendar_state_styles 讀得到、
-- 函式屬性(SECURITY DEFINER、search_path、ACL)。
begin;

select plan(20);

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
  ('c1021000-0000-4000-8000-000000000001', 'pgtap-r1021-admin@test.local'),
  ('c1021000-0000-4000-8000-000000000002', 'pgtap-r1021-agent-none@test.local'),
  ('c1021000-0000-4000-8000-000000000003', 'pgtap-r1021-staff@test.local'),
  ('c1021000-0000-4000-8000-000000000004', 'pgtap-r1021-admin2@test.local');

insert into groups (id) values ('c1021000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('c1021000-0000-4000-8000-000000000021', 'c1021000-0000-4000-8000-000000000011', '可預約時段底色測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c1021000-0000-4000-8000-000000000021', 'c1021000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c1021000-0000-4000-8000-000000000031', 'c1021000-0000-4000-8000-000000000021', 'c1021000-0000-4000-8000-000000000002', '客服-無授權', 'pgtap-r1021-agent-none@test.local', 'active', now(), '0900102101');

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, phone) values
  ('c1021000-0000-4000-8000-000000000041', 'c1021000-0000-4000-8000-000000000021', 'c1021000-0000-4000-8000-000000000003', '服務人員R', 'piece_rate', 'active', 'active', now(), '0977102101');

-- ① CHECK 收第 4 個值、仍擋亂打的值
select lives_ok(
  $$insert into merchant_calendar_state_styles (merchant_id, state_type, color)
    values ('c1021000-0000-4000-8000-000000000021', 'staff_available_slot', '#123abc')$$,
  'state_type 可以是 staff_available_slot'
);
select throws_ok(
  $$insert into merchant_calendar_state_styles (merchant_id, state_type, color)
    values ('c1021000-0000-4000-8000-000000000021', 'whatever', '#123abc')$$,
  '23514', null,
  'state_type 不認得的值仍被 CHECK 擋下'
);
delete from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021';

-- ② seed 種 4 列,第 4 列是 #dcfce7;冪等、不覆蓋
select seed_default_merchant_calendar_state_styles('c1021000-0000-4000-8000-000000000021');
select is(
  (select count(*)::int from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021'),
  5,
  'seed 種 5 列(#1049 起多一種 outside_business_hours)'
);
select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021' and state_type = 'staff_available_slot'),
  '#dcfce7',
  '服務人員可預約時段預設色 #dcfce7(淡綠)'
);
update merchant_calendar_state_styles set color = '#aabbcc'
where merchant_id = 'c1021000-0000-4000-8000-000000000021' and state_type = 'staff_available_slot';
select seed_default_merchant_calendar_state_styles('c1021000-0000-4000-8000-000000000021');
select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021' and state_type = 'staff_available_slot'),
  '#aabbcc',
  '重複 seed 不覆蓋商家自訂的第 4 色'
);

-- ③ 既有商家都已補第 4 列(migration 的回填)
select is(
  (select count(*)::int from merchants m
   where not exists (
     select 1 from merchant_calendar_state_styles s
     where s.merchant_id = m.id and s.state_type = 'staff_available_slot'
   )
   and m.id <> 'c1021000-0000-4000-8000-000000000021'),
  0,
  '既有商家全部都有 staff_available_slot 這一列(回填)'
);

-- ④ 新商家建立時自動有第 4 列
select pg_temp.test_set_auth('c1021000-0000-4000-8000-000000000004');
select create_group_and_merchant('可預約時段底色自動種子店', 'in_store_beauty') \gset new_merchant_
select pg_temp.test_clear_auth();
select is(
  (select color from merchant_calendar_state_styles
   where merchant_id = :'new_merchant_create_group_and_merchant'::uuid and state_type = 'staff_available_slot'),
  '#dcfce7',
  'create_group_and_merchant 新商家自動種入第 4 列 #dcfce7'
);

-- ⑤ update:權限
select pg_temp.test_set_auth('c1021000-0000-4000-8000-000000000002'); -- 無 orders 授權客服
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    'c1021000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#444444'
  )$$,
  '42501', null,
  '沒有 orders 權限的客服不能改第 4 色'
);
select pg_temp.test_clear_auth();

-- ⑥ update:管理員改 5 色
select pg_temp.test_set_auth('c1021000-0000-4000-8000-000000000001');
select lives_ok(
  $$select update_merchant_calendar_state_styles(
    'c1021000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', ' #D1FAE5 '
  )$$,
  '管理員可以一次改 4 種顏色'
);
select pg_temp.test_clear_auth();
select is(
  (select color from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021' and state_type = 'staff_available_slot'),
  '#D1FAE5',
  '第 4 色寫入(前後空白去掉)'
);

-- ⑦ update:格式不對擋下(資安:不讓怪字串進 inline style)
select pg_temp.test_set_auth('c1021000-0000-4000-8000-000000000001');
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    'c1021000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', 'red;background:url(x)'
  )$$,
  'P0001', '「服務人員可預約時段」的色碼格式不正確，請輸入像 #DCFCE7 這樣的色碼',
  '第 4 色格式不對 ⇒ 擋下'
);
select throws_ok(
  $$select update_merchant_calendar_state_styles(
    'c1021000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#12345'
  )$$,
  'P0001', null,
  '第 4 色 5 碼 ⇒ 擋下'
);
select lives_ok(
  $$select update_merchant_calendar_state_styles(
    'c1021000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#abc'
  )$$,
  '第 4 色 #RGB 三碼可以'
);

-- ⑧ 舊版前端只傳 4 個參數(具名)⇒ 照樣成功,第 4 色不變
select lives_ok(
  $$select update_merchant_calendar_state_styles(
    p_merchant_id => 'c1021000-0000-4000-8000-000000000021',
    p_full_day_leave_color => '#555555',
    p_partial_leave_color => '#666666',
    p_cross_store_occupied_color => '#777777'
  )$$,
  '只傳 4 個具名參數(舊版前端)照樣能呼叫'
);
select pg_temp.test_clear_auth();
select is(
  (select row(
    (select color from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021' and state_type = 'full_day_leave'),
    (select color from merchant_calendar_state_styles where merchant_id = 'c1021000-0000-4000-8000-000000000021' and state_type = 'staff_available_slot')
  ))::text,
  row('#555555', '#abc')::text,
  '只傳 4 個參數:前 3 色更新、第 4 色維持原值'
);

-- ⑨ 服務人員端讀得到第 4 色;傳別人的 staff_id 仍 42501
select pg_temp.test_set_auth('c1021000-0000-4000-8000-000000000003');
select is(
  (get_my_calendar_state_styles('c1021000-0000-4000-8000-000000000041'::uuid) ->> 'staff_available_slot'),
  '#abc',
  '服務人員端 get_my_calendar_state_styles 讀到第 4 色'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(get_my_calendar_state_styles('c1021000-0000-4000-8000-000000000041'::uuid)) k),
  array['cross_store_occupied', 'full_day_leave', 'opacity', 'outside_business_hours', 'partial_leave', 'staff_available_slot'],
  '服務人員端只拿到 5 個色碼 key + #1050 的 opacity,沒有多露其他欄位'
);
select pg_temp.test_clear_auth();

-- ⑩ 函式屬性
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
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_merchant_calendar_state_styles'),
  1,
  '舊的 4 參數簽章已刪掉,只剩一支(避免 PostgREST 兩支都符合)'
);

select * from finish();

rollback;
