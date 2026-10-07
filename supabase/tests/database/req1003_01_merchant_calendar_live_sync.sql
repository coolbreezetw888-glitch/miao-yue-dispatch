-- SPECS-INDEX #1003 / #1006(第 14 批):商家端行事曆即時同步
-- 規格:.project/specs/行事曆同步與時間軸卡片-第14批.md
-- 對應 migration:20261007160000_req1003_merchant_calendar_live_sync.sql
--
--   P 前置:今天的 realtime.messages 分區存在;#924 同集團名單 X2 → X1
--   A 權限衛生 + 結構:四支發送端 / trigger 函式三個角色都沒有 EXECUTE、private、SECURITY DEFINER;
--     can_listen 只給 authenticated;四個 trigger 啟用;realtime.messages 只有兩條 SELECT 政策(沒有寫入政策)
--   B #1003 每週固定可預約時段 / 單日例外:新增 / 修改 / 刪除 → 所屬商家 1 則;別家 0 則;
--     set_staff_day_override 一次 4 格 → 同交易只 1 則
--   C #1006 訂單:二店替同一個人建單 / 改單 → 一店、二店各 1 則;別集團同電話的店 0 則;
--     同集團不同人只通知自己那間;助手也跨店;同交易去重
--   D 🔴 資安:payload 只有 {id, reason, v},原文搜不到客戶 / 備註 / 店名
--   E 🔴 誰能加入頻道:管理員 / 開了訂單管理的客服 ✅;別家、沒開訂單管理、已停用客服、服務人員、
--     大寫 / 亂打 / 服務人員頻道形狀 ❌;政策以加入者身分查 → 看不到別家頻道的列
--   F 例外保護:同集團名單函式壞掉 → 建單照常成功,本店照收
--
-- 去重是「交易內」GUC,而 pgTAP 整份檔案是同一筆交易 ⇒ 每段量測前用 pg_temp.reset_sig()
-- 清掉 GUC 記號與之前的訊號列(模擬新的一筆交易),清掉的列先存進 sig_log 給 D 段掃描。
begin;

-- ─── SPECS-INDEX #977 測試墊片(同 req964_01):no_time_slot_limit=true 的服務人員自動補 7 天全天每週時段 ───
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

select plan(29);

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

create temp table sig_log (topic text, event text, extension text, private boolean, payload jsonb);

create function pg_temp.msig(p_merchant uuid)
returns int language sql as $$
  select count(*)::int from realtime.messages
  where topic = 'merchant:' || p_merchant::text || ':calendar'
    and event = 'calendar_changed' and extension = 'broadcast' and private is true;
$$;

create function pg_temp.msig_total()
returns int language sql as $$
  select count(*)::int from realtime.messages where topic like 'merchant:%:calendar';
$$;

create function pg_temp.reset_sig()
returns void language plpgsql as $$
begin
  insert into sig_log select topic, event, extension, private, payload
  from realtime.messages where topic like 'merchant:%:calendar' or topic like 'staff:%:schedule';
  delete from realtime.messages where topic like 'merchant:%:calendar' or topic like 'staff:%:schedule';
  perform set_config('miaoyue.rt_merchant_notified', '', true);
  perform set_config('miaoyue.rt_merchant_fanned_staff', '', true);
  perform set_config('miaoyue.rt_staff_notified', '', true);
  perform set_config('miaoyue.rt_staff_fanned_out', '', true);
end;
$$;

create function pg_temp.mk(p_merchant uuid, p_item uuid, p_pm uuid, p_staff uuid,
                           p_start timestamptz, p_assistants uuid[] default '{}')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => p_merchant,
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id', p_item, 'quantity', 1, 'unit_price', 800)),
    p_start_at => p_start,
    p_customer_name => '商家行事曆祕密客戶陳大文',
    p_customer_phone => '0955100399',
    p_notes => '商家行事曆祕密內部備註',
    p_customer_notes => '商家行事曆祕密客戶備註',
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => p_pm);
$$;

create function pg_temp.touch(p_booking uuid)
returns void language sql as $$
  update public.bookings set start_at = start_at + interval '30 minutes', end_at = end_at + interval '30 minutes'
  where id = p_booking;
$$;

-- 以 p_user 身分、realtime.topic = p_topic 讀 realtime.messages 看得到幾列(= Realtime 加入頻道時的授權查詢)
create function pg_temp.visible_as(p_user uuid, p_topic text)
returns int language plpgsql as $$
declare
  v int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('realtime.topic', coalesce(p_topic, ''), true);
  set local role authenticated;
  select count(*)::int into v from realtime.messages;
  reset role;
  perform set_config('realtime.topic', '', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;

-- =========================================================================
-- Fixture
--   集團一:一店(M1)、二店(M2),管理員甲管兩間
--   集團二:別集團店(M3),管理員丙
--   同一個人 X(電話 0900100301):X1 在一店、X2 在二店;X3 在別集團店(同電話、不同集團)
--   Y1:一店另一位服務人員;Z2:二店另一位服務人員
--   客服:AG_OK(一店、開訂單管理)、AG_NO(一店、只開店家報表)、AG_RM(一店、開訂單管理但已移除)
-- =========================================================================
insert into auth.users (id, email) values
  ('e1003000-0000-4000-8000-000000000001', 'pgtap-req1003-admin1@test.local'),
  ('e1003000-0000-4000-8000-000000000002', 'pgtap-req1003-admin3@test.local'),
  ('e1003000-0000-4000-8000-000000000003', 'pgtap-req1003-x@test.local'),
  ('e1003000-0000-4000-8000-000000000004', 'pgtap-req1003-agok@test.local'),
  ('e1003000-0000-4000-8000-000000000005', 'pgtap-req1003-agno@test.local'),
  ('e1003000-0000-4000-8000-000000000006', 'pgtap-req1003-agrm@test.local');

insert into groups (id) values
  ('e1003000-0000-4000-8000-000000000011'),
  ('e1003000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000011', '行事曆祕密測試一店', 'in_store_beauty'),
  ('e1003000-0000-4000-8000-000000000022', 'e1003000-0000-4000-8000-000000000011', '行事曆祕密測試二店', 'in_store_beauty'),
  ('e1003000-0000-4000-8000-000000000023', 'e1003000-0000-4000-8000-000000000012', '行事曆祕密別集團店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000001', '管理員甲'),
  ('e1003000-0000-4000-8000-000000000022', 'e1003000-0000-4000-8000-000000000001', '管理員甲'),
  ('e1003000-0000-4000-8000-000000000023', 'e1003000-0000-4000-8000-000000000002', '管理員丙');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from unnest(array['e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000022',
                  'e1003000-0000-4000-8000-000000000023']::uuid[]) as m,
     generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e1003000-0000-4000-8000-000000000031', 'e1003000-0000-4000-8000-000000000021', '剪髮', 800, 'primary', 60),
  ('e1003000-0000-4000-8000-000000000032', 'e1003000-0000-4000-8000-000000000022', '剪髮', 800, 'primary', 60),
  ('e1003000-0000-4000-8000-000000000033', 'e1003000-0000-4000-8000-000000000023', '剪髮', 800, 'primary', 60);

insert into payment_methods (id, merchant_id, name) values
  ('e1003000-0000-4000-8000-000000000061', 'e1003000-0000-4000-8000-000000000021', '現場付款'),
  ('e1003000-0000-4000-8000-000000000062', 'e1003000-0000-4000-8000-000000000022', '現場付款'),
  ('e1003000-0000-4000-8000-000000000063', 'e1003000-0000-4000-8000-000000000023', '現場付款');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit) values
  ('e1003000-0000-4000-8000-000000000041', 'e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000003', '服務人員X一店', 'active', 'active', '0900100301', true),
  ('e1003000-0000-4000-8000-000000000042', 'e1003000-0000-4000-8000-000000000022', null, '服務人員X二店', 'active', 'not_invited', '0900100301', true),
  ('e1003000-0000-4000-8000-000000000043', 'e1003000-0000-4000-8000-000000000023', null, '別集團同電話', 'active', 'not_invited', '0900100301', true),
  ('e1003000-0000-4000-8000-000000000044', 'e1003000-0000-4000-8000-000000000021', null, '服務人員Y一店', 'active', 'not_invited', '0900100344', true),
  ('e1003000-0000-4000-8000-000000000045', 'e1003000-0000-4000-8000-000000000022', null, '服務人員Z二店', 'active', 'not_invited', '0900100345', true);

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('e1003000-0000-4000-8000-000000000051', 'e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000004', '客服-訂單', 'pgtap-req1003-agok@test.local', 'active', now(), '0900100351'),
  ('e1003000-0000-4000-8000-000000000052', 'e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000005', '客服-報表', 'pgtap-req1003-agno@test.local', 'active', now(), '0900100352'),
  ('e1003000-0000-4000-8000-000000000053', 'e1003000-0000-4000-8000-000000000021', 'e1003000-0000-4000-8000-000000000006', '客服-已移除', 'pgtap-req1003-agrm@test.local', 'removed', now(), '0900100353');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e1003000-0000-4000-8000-000000000051', 'orders', true),
  ('e1003000-0000-4000-8000-000000000052', 'billing', true),
  ('e1003000-0000-4000-8000-000000000052', 'orders', false),
  ('e1003000-0000-4000-8000-000000000053', 'orders', true);

\set M1 '''e1003000-0000-4000-8000-000000000021'''
\set M2 '''e1003000-0000-4000-8000-000000000022'''
\set M3 '''e1003000-0000-4000-8000-000000000023'''
\set I1 '''e1003000-0000-4000-8000-000000000031'''
\set I2 '''e1003000-0000-4000-8000-000000000032'''
\set I3 '''e1003000-0000-4000-8000-000000000033'''
\set P1 '''e1003000-0000-4000-8000-000000000061'''
\set P2 '''e1003000-0000-4000-8000-000000000062'''
\set P3 '''e1003000-0000-4000-8000-000000000063'''
\set X1 '''e1003000-0000-4000-8000-000000000041'''
\set X2 '''e1003000-0000-4000-8000-000000000042'''
\set X3 '''e1003000-0000-4000-8000-000000000043'''
\set Y1 '''e1003000-0000-4000-8000-000000000044'''
\set Z2 '''e1003000-0000-4000-8000-000000000045'''
\set ADMIN1 '''e1003000-0000-4000-8000-000000000001'''
\set ADMIN3 '''e1003000-0000-4000-8000-000000000002'''
\set XUSER '''e1003000-0000-4000-8000-000000000003'''
\set AGOK '''e1003000-0000-4000-8000-000000000004'''
\set AGNO '''e1003000-0000-4000-8000-000000000005'''
\set AGRM '''e1003000-0000-4000-8000-000000000006'''

-- =========================================================================
-- P. 前置
-- =========================================================================
select ok(
  exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'realtime.messages'::regclass
            and c.relname = 'messages_' || to_char(now()::timestamp, 'YYYY_MM_DD')),
  'P1 前置:realtime.messages 今天的分區存在(不存在 = 本機 Realtime 沒在跑,下面全部會是 0 則)'
);
select is(
  (select array_agg(s::text order by s::text) from private.same_person_staff_ids_in_group(:X2::uuid) s),
  array[:X1::text],
  'P2 前置:#924 同集團同一個人名單:X2 → 只有 X1(別集團同電話的 X3 不算)'
);

-- =========================================================================
-- A. 權限衛生 + 結構
-- =========================================================================
select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
   from unnest(array['public', 'anon', 'authenticated']) r,
        unnest(array['private.notify_merchant_calendar_changed(uuid)',
                     'private.notify_merchant_calendar_for_staff(uuid,boolean)',
                     'private.tg_staff_availability_notify_merchant_calendar()',
                     'private.tg_bookings_notify_merchant_calendar()',
                     'private.tg_booking_assistants_notify_merchant_calendar()']) f),
  'A1 🔴 權限衛生:發送端與 trigger 函式對 PUBLIC / anon / authenticated 都沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'private.can_listen_merchant_calendar_topic(text)', 'execute')
  and not has_function_privilege('anon', 'private.can_listen_merchant_calendar_topic(text)', 'execute')
  and not has_function_privilege('public', 'private.can_listen_merchant_calendar_topic(text)', 'execute'),
  'A2 權限衛生:can_listen_merchant_calendar_topic 只有 authenticated 有 EXECUTE(RLS 運算式以查詢者身分執行)'
);
select ok(
  (select bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' and n.nspname = 'private')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in ('notify_merchant_calendar_changed', 'notify_merchant_calendar_for_staff',
                       'tg_staff_availability_notify_merchant_calendar', 'tg_bookings_notify_merchant_calendar',
                       'tg_booking_assistants_notify_merchant_calendar', 'can_listen_merchant_calendar_topic'))
  and (select count(*) from pg_proc where proname in ('notify_merchant_calendar_changed', 'notify_merchant_calendar_for_staff',
                       'tg_staff_availability_notify_merchant_calendar', 'tg_bookings_notify_merchant_calendar',
                       'tg_booking_assistants_notify_merchant_calendar', 'can_listen_merchant_calendar_topic')) = 6,
  'A3 六支新函式都在 private、SECURITY DEFINER、owner postgres(PostgREST 碰不到)'
);
select is(
  (select array_agg(c.relname || '.' || t.tgname || '>' || p.proname order by c.relname)
   from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_class c on c.oid = t.tgrelid
   where t.tgname like '%notify_merchant_calendar' and t.tgenabled = 'O'),
  array['booking_assistants.booking_assistants_notify_merchant_calendar>tg_booking_assistants_notify_merchant_calendar',
        'bookings.bookings_notify_merchant_calendar>tg_bookings_notify_merchant_calendar',
        'staff_availability_overrides.staff_availability_overrides_notify_merchant_calendar>tg_staff_availability_notify_merchant_calendar',
        'staff_availability_windows.staff_availability_windows_notify_merchant_calendar>tg_staff_availability_notify_merchant_calendar'],
  'A4 四個 trigger 掛在四張表上、啟用中'
);
select is(
  (select array_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || permissive order by policyname)
   from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
  array['merchant_calendar_broadcast_receive:SELECT:authenticated:PERMISSIVE',
        'staff_schedule_broadcast_receive:SELECT:authenticated:PERMISSIVE'],
  'A5 🔴 #892:realtime.messages 只有兩條 SELECT 政策(服務人員班表 + 商家行事曆),沒有任何寫入政策'
);
select ok(
  (select prosrc like '%realtime.send(%' and prosrc not like '%broadcast_changes%'
   from pg_proc where proname = 'notify_merchant_calendar_changed')
  and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and (p.prosrc ilike '%realtime.send%' or p.prosrc ilike '%realtime.messages%')),
  'A6 🔴 送出只用 realtime.send(不用 broadcast_changes 整列外送);public schema 沒有任何函式包裝 realtime.send'
);

-- =========================================================================
-- B. #1003 每週固定可預約時段 / 單日例外
-- =========================================================================
select pg_temp.reset_sig();
insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values (:Y1, 1, '09:00', '12:00');
select is(
  array[pg_temp.msig(:M1), pg_temp.msig(:M2), pg_temp.msig(:M3)],
  array[1, 0, 0],
  'B1 🔴 #1003:一店服務人員新增每週固定可預約時段 → 一店 1 則,二店 / 別集團 0 則'
);

select pg_temp.reset_sig();
update public.staff_availability_windows set end_time = '13:00' where staff_id = :Y1 and day_of_week = 1;
delete from public.staff_availability_windows where staff_id = :Y1 and day_of_week = 1 and start_time = '09:00';
select is(
  array[pg_temp.msig(:M1), pg_temp.msig_total()],
  array[1, 1],
  'B2 修改 + 刪除每週時段(同一筆交易)→ 一店只收 1 則(交易內去重)'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select public.set_staff_day_override(:Y1, '2026-12-07', '10:00', '12:00', false);
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.msig(:M1), pg_temp.msig_total()],
  array[1, 1],
  'B3 行事曆點格子開關時段(set_staff_day_override 一次寫 4 格)→ 一店只 1 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select public.clear_staff_day_override(:Y1, '2026-12-07', '10:00', '11:00');
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.msig(:M1), pg_temp.msig(:M2)],
  array[1, 0],
  'B4 清除單日例外(刪列)→ 一店 1 則;不跨店(時段不影響別家店的灰格)'
);

select pg_temp.reset_sig();
insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values (:X2, 2, '09:00', '12:00');
select is(
  array[pg_temp.msig(:M2), pg_temp.msig(:M1)],
  array[1, 0],
  'B5 每週時段不跨店:二店那一列 X2 改時段 → 只有二店收到,同一個人的一店 0 則'
);

-- =========================================================================
-- C. #1006 訂單變動跨店
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M2, :I2, :P2, :X2, '2026-12-01 10:00:00+08') as c1 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.msig(:M2), pg_temp.msig(:M1), pg_temp.msig(:M3), pg_temp.msig_total()],
  array[1, 1, 0, 2],
  'C1 🔴 #1006:二店替 X2 建單 → 二店 1 則、同一個人所在的一店 1 則;別集團同電話的店 0 則'
);

select pg_temp.reset_sig();
select pg_temp.touch(:'c1'::uuid);
select is(
  array[pg_temp.msig(:M2), pg_temp.msig(:M1), pg_temp.msig(:M3)],
  array[1, 1, 0],
  'C2 🔴 #1006:拖拉改時間(bookings UPDATE)→ 二店、一店各 1 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M1, :I1, :P1, :Y1, '2026-12-01 10:00:00+08') as c3 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.msig(:M1), pg_temp.msig(:M2), pg_temp.msig_total()],
  array[1, 0, 1],
  'C3 同集團不同人:一店替 Y1 建單 → 只有一店 1 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M2, :I2, :P2, :Z2, '2026-12-03 10:00:00+08', array[:X2::uuid]) as c4 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.msig(:M2), pg_temp.msig(:M1)],
  array[1, 1],
  'C4 助手也跨店:二店建單主要 Z2、助手 X2 → 二店 1 則、X 所在的一店 1 則'
);

select pg_temp.reset_sig();
delete from public.booking_assistants where booking_id = :'c4'::uuid;
select is(
  array[pg_temp.msig(:M2), pg_temp.msig(:M1)],
  array[1, 1],
  'C5 移除助手(booking_assistants DELETE)→ 二店、一店各 1 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M1, :I1, :P1, :X1, '2026-12-02 10:00:00+08') as c6a \gset
select pg_temp.mk(:M2, :I2, :P2, :X2, '2026-12-02 13:00:00+08') as c6b \gset
select pg_temp.test_clear_auth();
select pg_temp.touch(:'c6a'::uuid);
select pg_temp.touch(:'c6b'::uuid);
select is(
  array[pg_temp.msig(:M1), pg_temp.msig(:M2), pg_temp.msig_total()],
  array[1, 1, 2],
  'C6 🔴 同交易去重:一店、二店各建單又各改單 → 每間商家只 1 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN3);
select pg_temp.mk(:M3, :I3, :P3, :X3, '2026-12-04 10:00:00+08') as c7 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.msig(:M3), pg_temp.msig(:M1), pg_temp.msig(:M2)],
  array[1, 0, 0],
  'C7 🔴 不同集團同電話:別集團店建單 → 只有別集團店收到'
);

-- =========================================================================
-- D. 🔴 資安:訊號原文
-- =========================================================================
select pg_temp.reset_sig();
select is(
  (select array_agg(distinct k order by k) from sig_log s, jsonb_object_keys(s.payload) k
   where s.topic like 'merchant:%:calendar'),
  array['id', 'reason', 'v'],
  'D1 🔴 商家行事曆訊號 payload 的 key 只有 id / reason / v'
);
select ok(
  (select count(*) from sig_log where topic like 'merchant:%:calendar') > 10
  and not exists (select 1 from sig_log
                  where topic like 'merchant:%:calendar'
                    and (payload::text like '%祕密%' or payload::text like '%0955100399%'
                         or payload::text like '%e1003000-0000-4000-8000-00000000004%'
                         or payload->>'reason' <> 'calendar_changed' or event <> 'calendar_changed'
                         or private is not true or extension <> 'broadcast')),
  'D2 🔴 所有商家行事曆訊號原文搜不到客戶姓名 / 電話 / 備註 / 店名 / 服務人員 id;一律 private broadcast、reason = calendar_changed'
);

-- =========================================================================
-- E. 🔴 誰能加入頻道(政策以加入者身分、realtime.topic = 頻道名查這張表)
-- =========================================================================
insert into realtime.messages (topic, extension, event, payload, private) values
  ('merchant:' || :M1 || ':calendar', 'broadcast', 'calendar_changed', '{"v":1}', true),
  ('merchant:' || :M3 || ':calendar', 'broadcast', 'calendar_changed', '{"v":1}', true),
  ('merchant:' || :M1 || ':calendar', 'presence', 'calendar_changed', '{"v":1}', true);

select is(
  array[pg_temp.visible_as(:ADMIN1, 'merchant:' || :M1 || ':calendar'),
        pg_temp.visible_as(:AGOK, 'merchant:' || :M1 || ':calendar')],
  array[1, 1],
  'E1 管理員 / 開了訂單管理的客服在自己商家的頻道看得到那一列(只有 broadcast、不含 presence、不含別家)'
);
select is(
  array[pg_temp.visible_as(:ADMIN1, 'merchant:' || :M3 || ':calendar'),
        pg_temp.visible_as(:ADMIN3, 'merchant:' || :M1 || ':calendar'),
        pg_temp.visible_as(:AGNO, 'merchant:' || :M1 || ':calendar'),
        pg_temp.visible_as(:AGRM, 'merchant:' || :M1 || ':calendar'),
        pg_temp.visible_as(:XUSER, 'merchant:' || :M1 || ':calendar')],
  array[0, 0, 0, 0, 0],
  'E2 🔴 別家商家管理員、只開店家報表的客服、已移除的客服、服務人員本人 → 加入一店頻道一列都看不到(= 被拒)'
);
select is(
  array[pg_temp.visible_as(:ADMIN1, upper('merchant:' || :M1 || ':calendar')),
        pg_temp.visible_as(:ADMIN1, 'merchant:' || upper(:M1) || ':calendar'),
        pg_temp.visible_as(:ADMIN1, 'merchant:abc:calendar'),
        pg_temp.visible_as(:ADMIN1, 'staff:' || :M1 || ':schedule'),
        pg_temp.visible_as(:ADMIN1, '')],
  array[0, 0, 0, 0, 0],
  'E3 頻道名大寫 / 亂打 / 服務人員頻道形狀 / 沒設 → 一列都看不到'
);
select ok(
  private.can_listen_merchant_calendar_topic('merchant:not-a-uuid-at-all-xxxxxxxxxxxxxxxx:calendar') is false
  and private.can_listen_merchant_calendar_topic(null) is false,
  'E4 形狀不對 / null 一律回 false,不丟錯'
);
select pg_temp.test_set_auth(:ADMIN1);
select set_config('realtime.topic', 'merchant:' || :M1 || ':calendar', true);
select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private)
    values ('merchant:e1003000-0000-4000-8000-000000000021:calendar', 'broadcast', 'calendar_changed', '{}', true)$$,
  '42501',
  null,
  'E5 🔴 #892:商家管理員以 authenticated 身分直接寫自己商家頻道的訊息 → 被 RLS 擋(發不出訊號)'
);
select set_config('realtime.topic', '', true);
select pg_temp.test_clear_auth();

-- =========================================================================
-- F. 例外保護:同集團名單函式壞掉 → 建單照常成功,本店照收
-- =========================================================================
-- (create_booking 本身擋時段也會用到這支名單函式,所以這裡用「直接改單」走 bookings UPDATE 的 trigger。)
select pg_temp.reset_sig();
alter function private.same_person_staff_ids_in_group(uuid) rename to same_person_staff_ids_in_group_req1003_off;
select lives_ok(
  $$select pg_temp.touch((select id from public.bookings
                          where merchant_id = 'e1003000-0000-4000-8000-000000000022'
                            and staff_id = 'e1003000-0000-4000-8000-000000000042' limit 1))$$,
  'F1 🔴 同集團名單函式不見了 → 改單照常成功(只留 WARNING)'
);
alter function private.same_person_staff_ids_in_group_req1003_off(uuid) rename to same_person_staff_ids_in_group;
select is(
  array[pg_temp.msig(:M2), pg_temp.msig(:M1)],
  array[1, 0],
  'F2 名單壞掉時本店(二店)照樣收到 1 則,只是不展開到一店'
);

select * from finish();
rollback;
