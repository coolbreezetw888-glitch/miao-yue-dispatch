-- 行事曆拖拉改時間與轉派(SPECS-INDEX #819;#807~#810 的資料層驗收)。
-- 對應規格書 .project/specs/行事曆拖拉改時間與轉派.md §9.1 的 18 條,每一條都是「查表驗最終狀態」,
-- 不是只看 RPC 回傳值(回傳值裡的 mode 另外多驗一次,那是對前端的契約,不取代查表)。
-- 三種 mode 與 Q1/Q2/Q5 的裁決以 §十一之〇為準(Q1=B 斜拖人跟時間一起改;Q2=助手一律只換人、時間忽略;
-- Q5=A 主轉派給既有助手擋下),跟 migration 20260928010000_move_booking.sql 檔頭的對照表一致。
--
-- =========================================================================
-- 【故障注入紀錄(automated-testing 第四節;2026-09-28 engineer 在本機 Docker 容器實際跑過)】
-- 做法:對本機容器 psql 執行
--   create or replace function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz,
--     timestamptz, uuid, text) returns void language plpgsql as $$ begin return; end; $$;
-- 把所有衝突/休假/排班檢查掏空,再跑 `npm run test:db`。
-- 實際結果:規格書要求的 #4 / #5 / #7 / #9 / #16 全部轉紅(15 個斷言),其餘 82 個斷言維持綠燈;
-- 這支檔案「Tests: 97 Failed: 15, Failed tests: 18-21, 39-45, 91-94」。逐條實際紅字:
--   # Failed test 18: "#4 mode=time 助手衝突:B 在 13:00 有別的單 → 整筆擋下,訊息指出是助手 B"
--   #       caught: no exception / wanted: P0001
--   # Failed test 19: "#4 mode=time 助手衝突:T1 start_at 仍是 10:00(交易回滾)"
--   #         have: 2026-10-06 05:00:00+00 / want: 2026-10-06 02:00:00+00   ← 單真的被移到 13:00 了
--   # Failed test 20: "#5 mode=time 主衝突:A 在 15:00 有別的單 → 整筆擋下,訊息指出是主要服務人員"
--   #       caught: no exception / wanted: P0001
--   # Failed test 21: "#5 mode=time 主衝突:T1 start_at 仍是 10:00"
--   #         have: 2026-10-06 07:00:00+00 / want: 2026-10-06 02:00:00+00
--   # Failed test 39: "#7(i) reassign_main 斜拖衝突:C 在 14:00 有 T2 → 擋下"
--   #       caught: no exception / wanted: P0001
--   # Failed test 40: "#7(i) reassign_main 衝突:主服務人員仍是 A"
--   #         have: e7000000-...-000000000043 (C) / want: e7000000-...-000000000041 (A)
--   # Failed test 41: "#7(i) reassign_main 衝突:start_at 仍是 10:00"
--   #         have: 2026-10-06 06:00:00+00 / want: 2026-10-06 02:00:00+00
--   # Failed test 42: "#7(ii) reassign_main 同列衝突:C 在 10:00 有 T5 → 擋下"
--   #       caught: no exception / wanted: P0001
--   # Failed test 43: "#7(ii) reassign_main 同列衝突:主服務人員仍是 A"
--   #         have: ...43 (C) / want: ...41 (A)
--   # Failed test 44: "#9 reassign_assistant 衝突:C 在 10:00 有 T5 → 擋下,訊息前綴是助手「C」"
--   #       caught: no exception / wanted: P0001
--   # Failed test 45: "#9 reassign_assistant 衝突:助手仍是 B"
--   #         have: ...43 (C) / want: ...42 (B)
--   # Failed test 91: "#16 目標服務人員 C 整天請假 → 主轉派被擋下,訊息含「休假日」"
--   #       caught: no exception / wanted: P0001
--   # Failed test 92: "#16 請假擋下:主服務人員仍是 A"
--   #         have: ...43 (C) / want: ...41 (A)
--   # Failed test 93: "#16 目標服務人員 C 整天請假 → 助手轉派也被擋下"
--   #       caught: no exception / wanted: P0001
--   # Failed test 94: "#16 請假擋下:助手仍是 B"
--   #         have: ...43 (C) / want: ...42 (B)
-- (同一次注入也讓 module5_01/5_02/5_07/6_04/6_06/6_07/7_01/12_01 既有的衝突/排班/請假測試轉紅,
--  證明掏空的確實是整個專案共用的那一支檢查,不是別的東西。)
-- 每個衝突區塊後面的 pg_temp.reset_t1() 是為了讓注入時各區塊獨立轉紅、不連鎖中止;守門正常時它是 no-op。
-- 復原方式:`npx supabase db reset --local`(從 migration 重新套用),再跑一次全綠。
-- =========================================================================
begin;

select plan(97);

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

-- 「復原」= 用 RPC 回傳的 next 當 expected、previous 當 target,再呼叫同一支 RPC 一次(規格書 §3.1/§4.5)。
-- 這支小工具就是前端 buildUndoInput() 的資料庫版,三種 mode 的反向輸入規則:
--   time / reassign_main   → dragged = next.staff_id(現在的主)、target = previous.staff_id、target_start = previous.start_at
--   reassign_assistant     → dragged = next.assistant_staff_id(現在的助手)、target = previous.assistant_staff_id、
--                            target_start = next.start_at(反正會被忽略)
create function pg_temp.undo_move(p_booking_id uuid, p_result jsonb)
returns jsonb language plpgsql as $$
begin
  if p_result ->> 'mode' = 'reassign_assistant' then
    return public.move_booking(
      p_booking_id,
      (p_result -> 'next' ->> 'assistant_staff_id')::uuid,
      (p_result -> 'previous' ->> 'assistant_staff_id')::uuid,
      (p_result -> 'next' ->> 'start_at')::timestamptz,
      (p_result -> 'next' ->> 'start_at')::timestamptz,
      (p_result -> 'next' ->> 'staff_id')::uuid
    );
  end if;

  return public.move_booking(
    p_booking_id,
    (p_result -> 'next' ->> 'staff_id')::uuid,
    (p_result -> 'previous' ->> 'staff_id')::uuid,
    (p_result -> 'previous' ->> 'start_at')::timestamptz,
    (p_result -> 'next' ->> 'start_at')::timestamptz,
    (p_result -> 'next' ->> 'staff_id')::uuid
  );
end;
$$;

-- 把 T1 強制拉回「A 主、B 助手、10:00–11:00」的起始狀態(以 postgres 身分繞過 RLS)。
-- 只放在「應該被擋下」的測試後面:守門正常時它是 no-op(前一條 is() 已經證明資料沒動);
-- 做故障注入時,被掏空的檢查會讓那次移動真的寫進去,沒有這步,後面的測試會因為 T1 已經跑掉而連鎖
-- 中止(psql 遇到 throws_ok 以外的例外會直接放棄整個交易),就看不到 #7/#9/#16 各自的紅字了。
create function pg_temp.reset_t1(p_booking_id uuid, p_main uuid, p_assistant uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.bookings
  set staff_id = p_main, start_at = '2026-10-06 10:00:00+08', end_at = '2026-10-06 11:00:00+08'
  where id = p_booking_id;
  update public.booking_assistants set staff_id = p_assistant where booking_id = p_booking_id;
end;
$$;

-- =========================================================================
-- Fixture(§9.1):一間商家 M、三位在職服務人員 A(主)/B(助手)/C(第三人)、
-- 一筆 A 主 + B 助手的訂單 T1(10:00–11:00)、另一筆 C 主的訂單 T2(14:00–15:00)、
-- 一位有 orders 權限的客服、一位沒有的客服。
-- 另加:另一間商家 M2 的服務人員 D(跨商家目標)、M 的已移除服務人員 E(已移除目標)。
-- 測試日期 2026-10-06(週一);M 全週營業 00:00–23:59,三位服務人員 no_time_slot_limit=true,
-- 所以「營業時間/每週時段」這兩層不會擋,測試才能聚焦在本功能自己的規則跟「同時段其他預約」「請假」。
-- =========================================================================
\set merchant_m  e7000000-0000-4000-8000-000000000021
\set merchant_m2 e7000000-0000-4000-8000-000000000022
\set user_admin  e7000000-0000-4000-8000-000000000001
\set user_orders e7000000-0000-4000-8000-000000000002
\set user_none   e7000000-0000-4000-8000-000000000003
\set staff_a     e7000000-0000-4000-8000-000000000041
\set staff_b     e7000000-0000-4000-8000-000000000042
\set staff_c     e7000000-0000-4000-8000-000000000043
\set staff_d     e7000000-0000-4000-8000-000000000044
\set staff_e     e7000000-0000-4000-8000-000000000045
\set item_60     e7000000-0000-4000-8000-000000000031
\set pm_cash     e7000000-0000-4000-8000-000000000071
\set leave_type  e7000000-0000-4000-8000-000000000061

insert into auth.users (id, email) values
  (:'user_admin',  'pgtap-drag-admin@test.local'),
  (:'user_orders', 'pgtap-drag-agent-orders@test.local'),
  (:'user_none',   'pgtap-drag-agent-none@test.local');

insert into groups (id) values
  ('e7000000-0000-4000-8000-000000000011'),
  ('e7000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  (:'merchant_m',  'e7000000-0000-4000-8000-000000000011', '拖拉測試商家', 'in_store_beauty'),
  (:'merchant_m2', 'e7000000-0000-4000-8000-000000000012', '拖拉測試另一間商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  (:'merchant_m', :'user_admin');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select :'merchant_m', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  (:'item_60', :'merchant_m', '剪髮 60 分', 500, 'primary', 60);

insert into payment_methods (id, merchant_id, name) values
  (:'pm_cash', :'merchant_m', '現場付款');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, status) values
  (:'staff_a', :'merchant_m',  '服務人員A', '0900000141', true, 'active'),
  (:'staff_b', :'merchant_m',  '服務人員B', '0900000142', true, 'active'),
  (:'staff_c', :'merchant_m',  '服務人員C', '0900000143', true, 'active'),
  (:'staff_d', :'merchant_m2', '服務人員D(別家)', '0900000144', true, 'active'),
  (:'staff_e', :'merchant_m',  '服務人員E(已移除)', '0900000145', true, 'removed');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('e7000000-0000-4000-8000-000000000051', :'merchant_m', :'user_orders', '客服-有訂單權限', 'pgtap-drag-agent-orders@test.local', 'active', now(), '0901000151'),
  ('e7000000-0000-4000-8000-000000000052', :'merchant_m', :'user_none',   '客服-無授權',     'pgtap-drag-agent-none@test.local',   'active', now(), '0901000152');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e7000000-0000-4000-8000-000000000051', 'orders', true);

insert into merchant_leave_types (id, merchant_id, name) values
  (:'leave_type', :'merchant_m', '特休');

select pg_temp.test_set_auth(:'user_admin');

-- T1:A 主 + B 助手,10:00–11:00。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 10:00:00+08', '客戶甲', '0988000001',
  p_assistant_staff_ids => array[:'staff_b'::uuid],
  p_payment_method_id => :'pm_cash'::uuid
) \gset t1_

-- T2:C 主,14:00–15:00。
select id from create_booking(
  :'merchant_m'::uuid, :'staff_c'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 14:00:00+08', '客戶乙', '0988000002',
  p_payment_method_id => :'pm_cash'::uuid
) \gset t2_

-- 記下 T1 助手列的 id,之後用來證明 reassign_assistant 是 update 不是 delete+insert(§6.1)。
select id from booking_assistants where booking_id = :'t1_id'::uuid \gset ba_

select pg_temp.test_clear_auth();

-- =========================================================================
-- #1 ACL:anon / public 對 move_booking 沒有 EXECUTE(supabase-permission-hygiene 規則 1)。
-- #2 ACL 正向對照:authenticated 有 EXECUTE —— 證明 #1 的查法分得出「有」跟「沒有」,
--    不是因為簽章拼錯而永遠回 false(automated-testing 第四節「正向對照」)。
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid)', 'execute'),
  '#1 ACL:anon 沒有 move_booking 的 EXECUTE'
);
select ok(
  not has_function_privilege('public', 'public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid)', 'execute'),
  '#1 ACL:PUBLIC 沒有 move_booking 的 EXECUTE(沒 revoke 的話 Postgres 預設會給)'
);
select ok(
  has_function_privilege('authenticated', 'public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid)', 'execute'),
  '#2 ACL 正向對照:authenticated 有 move_booking 的 EXECUTE(證明 #1 的查法真的分得出有/無)'
);

-- =========================================================================
-- #3 mode=time:A 拖 A 欄 13:00 → start 13:00 / end 14:00(60 分保留)、staff 仍 A、助手仍 1 列 B、id 沒變。
-- =========================================================================
select pg_temp.test_set_auth(:'user_admin');

select public.move_booking(
  :'t1_id'::uuid, :'staff_a'::uuid, :'staff_a'::uuid,
  '2026-10-06 13:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'::uuid
) as r \gset mv3_

select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 13:00:00+08'::timestamptz,
  '#3 mode=time:start_at 變成 13:00');
select is((select end_at from bookings where id = :'t1_id'::uuid), '2026-10-06 14:00:00+08'::timestamptz,
  '#3 mode=time:end_at 變成 14:00(60 分鐘時長保留)');
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#3 mode=time:主服務人員仍是 A');
select is((select count(*)::int from booking_assistants where booking_id = :'t1_id'::uuid), 1,
  '#3 mode=time:助手仍是 1 列');
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#3 mode=time:助手仍是 B');
select is((select id from booking_assistants where booking_id = :'t1_id'::uuid), :'ba_id'::uuid,
  '#3 mode=time:助手列的 id 沒變(沒有被 delete+insert)');
select is(:'mv3_r'::jsonb ->> 'mode', 'time',
  '#3 mode=time:回傳 mode = time(前端契約)');
select is((:'mv3_r'::jsonb ->> 'time_changed')::boolean, true,
  '#3 mode=time:回傳 time_changed = true');
select is((:'mv3_r'::jsonb ->> 'staff_changed')::boolean, false,
  '#3 mode=time:回傳 staff_changed = false');

-- =========================================================================
-- #18 last_modified_by_user_id = 呼叫者、last_modified_at 有更新(§4 [4]g)。
-- =========================================================================
select is((select last_modified_by_user_id from bookings where id = :'t1_id'::uuid), :'user_admin'::uuid,
  '#18 last_modified_by_user_id = 呼叫者(管理員)');
select ok((select last_modified_at is not null from bookings where id = :'t1_id'::uuid),
  '#18 last_modified_at 有被寫入');

-- =========================================================================
-- #17 復原對稱性:用 #3 回傳的 previous/next 反向呼叫 → 回到 10:00–11:00。
-- =========================================================================
select lives_ok(
  format($$select pg_temp.undo_move(%L::uuid, %L::jsonb)$$, :'t1_id', :'mv3_r'),
  '#17 復原:用 previous/next 反向呼叫 move_booking 成功'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#17 復原:start_at 回到 10:00');
select is((select end_at from bookings where id = :'t1_id'::uuid), '2026-10-06 11:00:00+08'::timestamptz,
  '#17 復原:end_at 回到 11:00');

-- =========================================================================
-- #4 mode=time 衝突(助手):B 在 13:00–14:00 另有一筆單(T3)→ 把 T1 拖到 13:00 → throws,
--    訊息沿用 check_staff_booking_slot 原文、前綴「助手「姓名」」(§6.5),且 T1 start_at 仍是 10:00。
-- =========================================================================
select id from create_booking(
  :'merchant_m'::uuid, :'staff_b'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 13:00:00+08', '客戶丙', '0988000003',
  p_payment_method_id => :'pm_cash'::uuid
) \gset t3_

select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 13:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '助手「服務人員B」在這個時段已經有其他預約',
  '#4 mode=time 助手衝突:B 在 13:00 有別的單 → 整筆擋下,訊息指出是助手 B'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#4 mode=time 助手衝突:T1 start_at 仍是 10:00(交易回滾)');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);

-- =========================================================================
-- #5 mode=time 衝突(主):A 在 15:00–16:00 另有一筆單(T4)→ 把 T1 拖到 15:00 → throws,前綴「主要服務人員」。
-- =========================================================================
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 15:00:00+08', '客戶丁', '0988000004',
  p_payment_method_id => :'pm_cash'::uuid
) \gset t4_

select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 15:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '主要服務人員在這個時段已經有其他預約',
  '#5 mode=time 主衝突:A 在 15:00 有別的單 → 整筆擋下,訊息指出是主要服務人員'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#5 mode=time 主衝突:T1 start_at 仍是 10:00');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);

-- =========================================================================
-- #6 mode=reassign_main:A 拖到 C 欄(原時段)→ staff_id=C、時間不變、助手仍是 B。
-- =========================================================================
select public.move_booking(
  :'t1_id'::uuid, :'staff_a'::uuid, :'staff_c'::uuid,
  '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'::uuid
) as r \gset mv6_

select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_c'::uuid,
  '#6 reassign_main:主服務人員變成 C');
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#6 reassign_main:start_at 不變(10:00)');
select is((select end_at from bookings where id = :'t1_id'::uuid), '2026-10-06 11:00:00+08'::timestamptz,
  '#6 reassign_main:end_at 不變(11:00)');
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#6 reassign_main:助手仍是 B(助手名單不變)');
select is(:'mv6_r'::jsonb ->> 'mode', 'reassign_main',
  '#6 reassign_main:回傳 mode = reassign_main');
select is((:'mv6_r'::jsonb ->> 'time_changed')::boolean, false,
  '#6 reassign_main:回傳 time_changed = false(同一列)');

select lives_ok(
  format($$select pg_temp.undo_move(%L::uuid, %L::jsonb)$$, :'t1_id', :'mv6_r'),
  '#6 reassign_main 復原:C 拖回 A 欄成功'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#6 reassign_main 復原:主服務人員回到 A');

-- =========================================================================
-- #6b Q1=B 斜拖:A 拖到 C 欄 + 16:00 → staff_id=C 且 start 16:00 / end 17:00「兩個都改」,助手仍是 B。
--     (mode 仍回 reassign_main,靠 time_changed=true 告訴前端時間也動了 —— 見對照表)
-- =========================================================================
select public.move_booking(
  :'t1_id'::uuid, :'staff_a'::uuid, :'staff_c'::uuid,
  '2026-10-06 16:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'::uuid
) as r \gset mv6b_

select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_c'::uuid,
  '#6b Q1=B 斜拖:主服務人員變成 C');
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 16:00:00+08'::timestamptz,
  '#6b Q1=B 斜拖:start_at 也變成 16:00');
select is((select end_at from bookings where id = :'t1_id'::uuid), '2026-10-06 17:00:00+08'::timestamptz,
  '#6b Q1=B 斜拖:end_at 變成 17:00(時長保留)');
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#6b Q1=B 斜拖:助手名單不變,仍是 B');
select is(:'mv6b_r'::jsonb ->> 'mode', 'reassign_main',
  '#6b Q1=B 斜拖:回傳 mode = reassign_main');
select is((:'mv6b_r'::jsonb ->> 'time_changed')::boolean, true,
  '#6b Q1=B 斜拖:回傳 time_changed = true');

select lives_ok(
  format($$select pg_temp.undo_move(%L::uuid, %L::jsonb)$$, :'t1_id', :'mv6b_r'),
  '#6b Q1=B 斜拖 復原:反向呼叫成功'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#6b 復原:主服務人員回到 A');
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#6b 復原:start_at 回到 10:00');

-- =========================================================================
-- #7 mode=reassign_main 衝突:
--    (i) 斜拖進 C 已有的 T2(14:00–15:00)→ throws,staff 仍 A、時間仍 10:00。
--    (ii) 規格書原句:C 在 10:00–11:00 已有單(T5)→ A 拖到 C 欄同一列 → throws,staff 仍 A。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_c', '2026-10-06 14:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '主要服務人員在這個時段已經有其他預約',
  '#7(i) reassign_main 斜拖衝突:C 在 14:00 有 T2 → 擋下'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#7(i) reassign_main 衝突:主服務人員仍是 A');
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#7(i) reassign_main 衝突:start_at 仍是 10:00');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);

select id from create_booking(
  :'merchant_m'::uuid, :'staff_c'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 10:00:00+08', '客戶戊', '0988000005',
  p_payment_method_id => :'pm_cash'::uuid
) \gset t5_

select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_c', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '主要服務人員在這個時段已經有其他預約',
  '#7(ii) reassign_main 同列衝突:C 在 10:00 有 T5 → 擋下'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#7(ii) reassign_main 同列衝突:主服務人員仍是 A');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);

-- =========================================================================
-- #9 mode=reassign_assistant 衝突:C 忙(T5 10:00–11:00)→ B 拖到 C 欄 → throws,助手仍是 B。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_b', :'staff_c', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '助手「服務人員C」在這個時段已經有其他預約',
  '#9 reassign_assistant 衝突:C 在 10:00 有 T5 → 擋下,訊息前綴是助手「C」'
);
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#9 reassign_assistant 衝突:助手仍是 B');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);

-- T5 用完了,直接以超級使用者把它標成取消(取消的單不參與衝突),讓 C 的 10:00 重新空出來。
select pg_temp.test_clear_auth();
update bookings set status = 'cancelled', cancelled_at = now() where id = :'t5_id'::uuid;
select pg_temp.test_set_auth(:'user_admin');

-- =========================================================================
-- #8 mode=reassign_assistant:B(助手)拖到 C 欄 → booking_assistants.staff_id=C、bookings.staff_id 仍 A、
--    列數仍 1、列的 id 沒變(update 不是 delete+insert)。
-- =========================================================================
select public.move_booking(
  :'t1_id'::uuid, :'staff_b'::uuid, :'staff_c'::uuid,
  '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'::uuid
) as r \gset mv8_

select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_c'::uuid,
  '#8 reassign_assistant:助手變成 C');
select is((select count(*)::int from booking_assistants where booking_id = :'t1_id'::uuid), 1,
  '#8 reassign_assistant:助手仍是 1 列');
select is((select id from booking_assistants where booking_id = :'t1_id'::uuid), :'ba_id'::uuid,
  '#8 reassign_assistant:助手列 id 沒變(是 update,不是 delete+insert)');
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#8 reassign_assistant:主服務人員仍是 A');
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#8 reassign_assistant:start_at 不變');
select is(:'mv8_r'::jsonb ->> 'mode', 'reassign_assistant',
  '#8 reassign_assistant:回傳 mode = reassign_assistant');
select is((:'mv8_r'::jsonb -> 'previous' ->> 'assistant_staff_id')::uuid, :'staff_b'::uuid,
  '#8 reassign_assistant:回傳 previous.assistant_staff_id = B(復原要用)');
select is((:'mv8_r'::jsonb -> 'next' ->> 'assistant_staff_id')::uuid, :'staff_c'::uuid,
  '#8 reassign_assistant:回傳 next.assistant_staff_id = C');

select lives_ok(
  format($$select pg_temp.undo_move(%L::uuid, %L::jsonb)$$, :'t1_id', :'mv8_r'),
  '#8 reassign_assistant 復原:C 拖回 B 成功'
);
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#8 reassign_assistant 復原:助手回到 B');

-- =========================================================================
-- #8b Q2 使用者裁決:助手斜拖(換人 + 換時間)→ 只換人,時間一概不動。
--     B 拖到 C 欄 + 13:00 → 助手變 C,但 bookings.start_at 仍 10:00。
-- =========================================================================
select public.move_booking(
  :'t1_id'::uuid, :'staff_b'::uuid, :'staff_c'::uuid,
  '2026-10-06 13:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'::uuid
) as r \gset mv8b_

select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_c'::uuid,
  '#8b Q2 助手斜拖:助手變成 C');
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#8b Q2 助手斜拖:start_at 完全不動(仍 10:00,時間維度被忽略)');
select is((select end_at from bookings where id = :'t1_id'::uuid), '2026-10-06 11:00:00+08'::timestamptz,
  '#8b Q2 助手斜拖:end_at 完全不動');
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#8b Q2 助手斜拖:主服務人員仍是 A');
select is((:'mv8b_r'::jsonb ->> 'time_changed')::boolean, false,
  '#8b Q2 助手斜拖:回傳 time_changed = false');

select lives_ok(
  format($$select pg_temp.undo_move(%L::uuid, %L::jsonb)$$, :'t1_id', :'mv8b_r'),
  '#8b 復原:助手 C 拖回 B 成功'
);
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#8b 復原:助手回到 B');

-- =========================================================================
-- #12 Q2 使用者裁決:助手在自己欄位改時間(B 拖 B 欄 13:00)= 換成自己 = 沒有變動 → 擋下,start_at 不變。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_b', :'staff_b', '2026-10-06 13:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '放開的位置跟原本一樣,沒有需要變更的內容',
  '#12 Q2 助手同欄改時間:視為無操作擋下(助手沒有自己的時間)'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#12 Q2 助手同欄改時間:start_at 不變');
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#12 Q2 助手同欄改時間:助手不變');

-- =========================================================================
-- #10 助手轉給主服務人員本人(B → A 欄)→ throws「已經在這筆預約裡了」。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_b', :'staff_a', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '這位服務人員已經在這筆預約裡了',
  '#10 助手轉給主服務人員本人 → 擋下'
);
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#10 助手轉給主服務人員本人:助手仍是 B');

-- =========================================================================
-- #11 Q5=A:主轉給既有助手(A → B 欄)→ throws,staff_id 仍 A。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_b', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '「服務人員B」已經是這筆預約的助手,請先用編輯把助手改掉,或改拖給其他人',
  '#11 Q5=A 主轉派給既有助手 → 擋下'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#11 Q5=A:主服務人員仍是 A');

-- =========================================================================
-- 主色塊「放開位置跟原本一樣」(A → A 欄 10:00)→ 後端也擋下(5.8 的後端防線)。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '放開的位置跟原本一樣,沒有需要變更的內容',
  '主色塊放開在原位 → 後端也視為沒有變動擋下'
);

-- =========================================================================
-- 角色/目標判定的邊界(§3.1 錯誤表):
--   被拖的人既不是主也不是助手(C 不在 T1 裡)/ 目標在別家(D)/ 目標已移除(E)/ 訂單不存在。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_c', :'staff_a', '2026-10-06 12:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '找不到這位服務人員在這筆預約裡的角色,請重新整理',
  '被拖的人(C)既不是 T1 的主也不是助手 → 擋下'
);
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_d', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '找不到這位服務人員,或這位服務人員已被移除',
  '目標服務人員屬於另一間商家(D)→ 擋下'
);
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_e', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '找不到這位服務人員,或這位服務人員已被移除',
  '目標服務人員已移除(E)→ 擋下'
);
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    'e7000000-0000-4000-8000-0000000000ff', :'staff_a', :'staff_a', '2026-10-06 12:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '找不到這筆預約',
  '訂單不存在 → 擋下'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '上面四條邊界擋下後:T1 主服務人員仍是 A');

-- =========================================================================
-- #13 已完成訂單(T6)→ throws;已取消訂單(T7)→ throws;時間都不變。
-- =========================================================================
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 17:00:00+08', '客戶己', '0988000006',
  p_payment_method_id => :'pm_cash'::uuid
) \gset t6_
select id from create_booking(
  :'merchant_m'::uuid, :'staff_a'::uuid,
  jsonb_build_array(jsonb_build_object('service_item_id', :'item_60', 'quantity', 1, 'unit_price', 500)),
  '2026-10-06 18:30:00+08', '客戶庚', '0988000007',
  p_payment_method_id => :'pm_cash'::uuid
) \gset t7_

select pg_temp.test_clear_auth();
update bookings set status = 'completed', completed_at = now() where id = :'t6_id'::uuid;
update bookings set status = 'cancelled', cancelled_at = now() where id = :'t7_id'::uuid;
select pg_temp.test_set_auth(:'user_admin');

select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t6_id', :'staff_a', :'staff_a', '2026-10-06 20:00:00+08', '2026-10-06 17:00:00+08', :'staff_a'),
  'P0001', '已完成或已取消的預約不能移動',
  '#13 已完成的訂單不能移動'
);
select is((select start_at from bookings where id = :'t6_id'::uuid), '2026-10-06 17:00:00+08'::timestamptz,
  '#13 已完成的訂單:start_at 不變');
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t7_id', :'staff_a', :'staff_a', '2026-10-06 20:00:00+08', '2026-10-06 18:30:00+08', :'staff_a'),
  'P0001', '已完成或已取消的預約不能移動',
  '#13 已取消的訂單不能移動'
);
select is((select start_at from bookings where id = :'t7_id'::uuid), '2026-10-06 18:30:00+08'::timestamptz,
  '#13 已取消的訂單:start_at 不變');

-- =========================================================================
-- #14 權限:沒 orders 權限的客服 → 42501;有權限的客服 → 成功(且 last_modified_by 是那位客服)。
-- =========================================================================
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth(:'user_none');

select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 12:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  '42501', null,
  '#14 沒有 orders 權限的客服 → 42501'
);

-- 查表要先切回超級使用者:沒權限的客服在 bookings 的 SELECT RLS 底下本來就看不到這一列(會查到 NULL),
-- 那是 RLS 正常運作,不是這條要驗的事。
select pg_temp.test_clear_auth();
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#14 沒權限的客服:start_at 不變');

select pg_temp.test_set_auth(:'user_orders');

select lives_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 12:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  '#14 有 orders 權限的客服 → 成功'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 12:00:00+08'::timestamptz,
  '#14 有權限的客服:start_at 變成 12:00');
select is((select last_modified_by_user_id from bookings where id = :'t1_id'::uuid), :'user_orders'::uuid,
  '#14/#18 有權限的客服:last_modified_by_user_id = 那位客服');

select lives_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 10:00:00+08', '2026-10-06 12:00:00+08', :'staff_a'),
  '#14 有權限的客服把它拖回 10:00'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#14 拖回後 start_at = 10:00');

select pg_temp.test_clear_auth();
select pg_temp.test_set_auth(:'user_admin');

-- =========================================================================
-- #15 畫面過期:expected_start_at 傳舊的(09:00)→ 40001,資料不變;expected_staff_id 傳錯(C)→ 40001。
-- =========================================================================
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 12:00:00+08', '2026-10-06 09:00:00+08', :'staff_a'),
  '40001', null,
  '#15 畫面過期:expected_start_at 跟現況不符 → 40001'
);
select is((select start_at from bookings where id = :'t1_id'::uuid), '2026-10-06 10:00:00+08'::timestamptz,
  '#15 畫面過期:start_at 不變');
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_a', '2026-10-06 12:00:00+08', '2026-10-06 10:00:00+08', :'staff_c'),
  '40001', null,
  '#15 畫面過期:expected_staff_id 跟現況不符 → 40001'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#15 畫面過期:staff_id 不變');

-- =========================================================================
-- #16 整天請假的 C:A 拖到 C 欄 → throws 訊息含「休假日」(沿用 check_staff_booking_slot 第 1 層,原文一字不改)。
--     助手 B 拖到 C 欄也一樣被擋(前綴換成助手「C」)。放在最後,因為 C 這天從此不可用。
-- =========================================================================
select pg_temp.test_clear_auth();
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status)
values (:'staff_c', :'leave_type', '特休', '2026-10-06', '2026-10-06', 'confirmed');
select pg_temp.test_set_auth(:'user_admin');

select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_a', :'staff_c', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '主要服務人員這天是休假日(假別:特休),無法預約',
  '#16 目標服務人員 C 整天請假 → 主轉派被擋下,訊息含「休假日」'
);
select is((select staff_id from bookings where id = :'t1_id'::uuid), :'staff_a'::uuid,
  '#16 請假擋下:主服務人員仍是 A');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);
select throws_ok(
  format($$select public.move_booking(%L, %L, %L, %L, %L, %L)$$,
    :'t1_id', :'staff_b', :'staff_c', '2026-10-06 10:00:00+08', '2026-10-06 10:00:00+08', :'staff_a'),
  'P0001', '助手「服務人員C」這天是休假日(假別:特休),無法預約',
  '#16 目標服務人員 C 整天請假 → 助手轉派也被擋下'
);
select is((select staff_id from booking_assistants where booking_id = :'t1_id'::uuid), :'staff_b'::uuid,
  '#16 請假擋下:助手仍是 B');
select pg_temp.reset_t1(:'t1_id'::uuid, :'staff_a'::uuid, :'staff_b'::uuid);

-- =========================================================================
-- §6.1 收尾:跑完這麼多次移動/復原之後,T1 的服務項目列與助手列都沒有被重寫。
-- =========================================================================
select is((select count(*)::int from booking_service_items where booking_id = :'t1_id'::uuid), 1,
  '§6.1 booking_service_items 仍是 1 列(move_booking 沒有重寫關聯表)');
select is((select id from booking_assistants where booking_id = :'t1_id'::uuid), :'ba_id'::uuid,
  '§6.1 booking_assistants 那一列的 id 從頭到尾沒變');
-- create_booking 手動建單的初始狀態是 pending_confirmation(待確認),move_booking 不該動它。
select is((select status from bookings where id = :'t1_id'::uuid), 'pending_confirmation',
  '§6.1 move_booking 不改變 status(仍是建單時的 pending_confirmation)');

select pg_temp.test_clear_auth();

select * from finish();
rollback;
