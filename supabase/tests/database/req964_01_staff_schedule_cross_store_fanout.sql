-- SPECS-INDEX #964 / #906 服務人員端行事曆即時同步 —— 批次 5:跨店佔用灰色格子 fan-out
-- 規格:.project/specs/服務人員端即時同步.md v1.1 #906、§三 批次 5
-- 對應 migration:20261001160000_req964_staff_schedule_cross_store_fanout.sql
--
--   P 前置:今天的 realtime.messages 分區存在
--   A 權限衛生 + 結構:fan-out 函式三個角色都沒有 EXECUTE、SECURITY DEFINER、owner postgres、只在 private;
--     兩支 trigger 函式權限照舊、改走 fan-out、不再直接呼叫第一層;fan-out 本體不呼叫自己(不遞迴)
--   B 同集團同一個人的另一列收到(雙向)、同交易去重、不同集團同電話收不到、同集團不同人收不到
--   C 助手(納編)也 fan-out:建單帶助手、bookings UPDATE 通知目前助手、轉派主要服務人員時舊的人
--   D 跨店那一列各自套用發送端過濾:行事曆檢視關 / 已停用 / 未完成登入 → 收不到;本人被擋時另一列照收
--   E 🔴 不遞迴(功能面):把「同一個人」名單改成不對稱的鏈 X2→X1→Y1,只會展開一層
--   F 例外保護:同集團名單函式壞掉 → 建單 / 改單照常成功,本人照收,只是不展開
--   G 🔴 資安:跨店收件那一列的 payload 只有 {id, reason, v},原文搜不到客戶 / 備註 / 店名
--
-- 去重是「交易內」GUC,而 pgTAP 整份檔案是同一筆交易 ⇒ 每段量測前用 pg_temp.reset_sig()
-- 清掉兩個 GUC 記號與之前的訊號列(模擬新的一筆交易),清掉的列先存進 sig_log 給 G 段掃描。
begin;

select plan(34);

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

create function pg_temp.sig(p_staff uuid)
returns int language sql as $$
  select count(*)::int from realtime.messages
  where topic = 'staff:' || p_staff::text || ':schedule'
    and event = 'schedule_changed' and extension = 'broadcast' and private is true;
$$;

create function pg_temp.sig_total()
returns int language sql as $$
  select count(*)::int from realtime.messages where topic like 'staff:%:schedule';
$$;

create function pg_temp.reset_sig()
returns void language plpgsql as $$
begin
  insert into sig_log select topic, event, extension, private, payload
  from realtime.messages where topic like 'staff:%:schedule';
  delete from realtime.messages where topic like 'staff:%:schedule';
  perform set_config('miaoyue.rt_staff_notified', '', true);
  perform set_config('miaoyue.rt_staff_fanned_out', '', true);
end;
$$;

-- 以商家管理員身分建單(呼叫前要先 test_set_auth 成該店管理員)
create function pg_temp.mk(p_merchant uuid, p_item uuid, p_pm uuid, p_staff uuid,
                           p_start timestamptz, p_assistants uuid[] default '{}')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => p_merchant,
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id', p_item, 'quantity', 1, 'unit_price', 800)),
    p_start_at => p_start,
    p_customer_name => '跨店祕密客戶王小明',
    p_customer_phone => '0955096499',
    p_notes => '跨店祕密內部備註',
    p_customer_notes => '跨店祕密客戶備註',
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => p_pm);
$$;

create function pg_temp.touch(p_booking uuid)
returns void language sql as $$
  update public.bookings set notes = notes where id = p_booking;
$$;

-- =========================================================================
-- Fixture
--   集團一:一店(M1)、二店(M2),管理員甲管兩間
--   集團二:別集團店(M3),管理員丙
--   同一個人 X(電話 0900096401):X1 在一店、X2 在二店(同一個登入帳號,雙重身分)、
--                                 X3 在別集團店(電話相同,但不同集團 ⇒ 不是「同一個人」)
--   Y1:一店另一位服務人員(同集團不同人)
--   Z2:二店另一位服務人員(拿來當主要服務人員,X2 當助手)
--   全部已開通登入、行事曆檢視開
-- =========================================================================
insert into auth.users (id, email) values
  ('e9640000-0000-4000-8000-000000000001', 'pgtap-req964-admin1@test.local'),
  ('e9640000-0000-4000-8000-000000000002', 'pgtap-req964-admin3@test.local'),
  ('e9640000-0000-4000-8000-000000000003', 'pgtap-req964-x@test.local'),
  ('e9640000-0000-4000-8000-000000000005', 'pgtap-req964-x3@test.local'),
  ('e9640000-0000-4000-8000-000000000006', 'pgtap-req964-y1@test.local'),
  ('e9640000-0000-4000-8000-000000000007', 'pgtap-req964-z2@test.local');

insert into groups (id) values
  ('e9640000-0000-4000-8000-000000000011'),
  ('e9640000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e9640000-0000-4000-8000-000000000021', 'e9640000-0000-4000-8000-000000000011', '跨店祕密測試一店', 'in_store_beauty'),
  ('e9640000-0000-4000-8000-000000000022', 'e9640000-0000-4000-8000-000000000011', '跨店祕密測試二店', 'in_store_beauty'),
  ('e9640000-0000-4000-8000-000000000023', 'e9640000-0000-4000-8000-000000000012', '跨店祕密別集團店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e9640000-0000-4000-8000-000000000021', 'e9640000-0000-4000-8000-000000000001', '管理員甲'),
  ('e9640000-0000-4000-8000-000000000022', 'e9640000-0000-4000-8000-000000000001', '管理員甲'),
  ('e9640000-0000-4000-8000-000000000023', 'e9640000-0000-4000-8000-000000000002', '管理員丙');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from unnest(array['e9640000-0000-4000-8000-000000000021', 'e9640000-0000-4000-8000-000000000022',
                  'e9640000-0000-4000-8000-000000000023']::uuid[]) as m,
     generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e9640000-0000-4000-8000-000000000031', 'e9640000-0000-4000-8000-000000000021', '剪髮', 800, 'primary', 60),
  ('e9640000-0000-4000-8000-000000000032', 'e9640000-0000-4000-8000-000000000022', '剪髮', 800, 'primary', 60),
  ('e9640000-0000-4000-8000-000000000033', 'e9640000-0000-4000-8000-000000000023', '剪髮', 800, 'primary', 60);

insert into payment_methods (id, merchant_id, name) values
  ('e9640000-0000-4000-8000-000000000061', 'e9640000-0000-4000-8000-000000000021', '現場付款'),
  ('e9640000-0000-4000-8000-000000000062', 'e9640000-0000-4000-8000-000000000022', '現場付款'),
  ('e9640000-0000-4000-8000-000000000063', 'e9640000-0000-4000-8000-000000000023', '現場付款');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit) values
  ('e9640000-0000-4000-8000-000000000041', 'e9640000-0000-4000-8000-000000000021', 'e9640000-0000-4000-8000-000000000003', '服務人員X一店', 'active', 'active', '0900096401', true),
  ('e9640000-0000-4000-8000-000000000042', 'e9640000-0000-4000-8000-000000000022', 'e9640000-0000-4000-8000-000000000003', '服務人員X二店', 'active', 'active', '0900096401', true),
  ('e9640000-0000-4000-8000-000000000043', 'e9640000-0000-4000-8000-000000000023', 'e9640000-0000-4000-8000-000000000005', '別集團同電話', 'active', 'active', '0900096401', true),
  ('e9640000-0000-4000-8000-000000000044', 'e9640000-0000-4000-8000-000000000021', 'e9640000-0000-4000-8000-000000000006', '服務人員Y一店', 'active', 'active', '0900096444', true),
  ('e9640000-0000-4000-8000-000000000045', 'e9640000-0000-4000-8000-000000000022', 'e9640000-0000-4000-8000-000000000007', '服務人員Z二店', 'active', 'active', '0900096445', true);

select seed_default_staff_permissions(s) from unnest(array[
  'e9640000-0000-4000-8000-000000000041', 'e9640000-0000-4000-8000-000000000042',
  'e9640000-0000-4000-8000-000000000043', 'e9640000-0000-4000-8000-000000000044',
  'e9640000-0000-4000-8000-000000000045']::uuid[]) as s;

-- 縮寫(psql 變數)
\set M1 '''e9640000-0000-4000-8000-000000000021'''
\set M2 '''e9640000-0000-4000-8000-000000000022'''
\set M3 '''e9640000-0000-4000-8000-000000000023'''
\set I1 '''e9640000-0000-4000-8000-000000000031'''
\set I2 '''e9640000-0000-4000-8000-000000000032'''
\set I3 '''e9640000-0000-4000-8000-000000000033'''
\set P1 '''e9640000-0000-4000-8000-000000000061'''
\set P2 '''e9640000-0000-4000-8000-000000000062'''
\set P3 '''e9640000-0000-4000-8000-000000000063'''
\set X1 '''e9640000-0000-4000-8000-000000000041'''
\set X2 '''e9640000-0000-4000-8000-000000000042'''
\set X3 '''e9640000-0000-4000-8000-000000000043'''
\set Y1 '''e9640000-0000-4000-8000-000000000044'''
\set Z2 '''e9640000-0000-4000-8000-000000000045'''
\set ADMIN1 '''e9640000-0000-4000-8000-000000000001'''
\set ADMIN3 '''e9640000-0000-4000-8000-000000000002'''

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
  'P2 前置:#924 的同集團同一個人名單:X2 → 只有 X1(別集團同電話的 X3 不算、自己不算)'
);

-- =========================================================================
-- A. 權限衛生 + 結構
-- =========================================================================
select ok(
  not has_function_privilege('public', 'private.notify_staff_schedule_changed_fanout(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.notify_staff_schedule_changed_fanout(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.notify_staff_schedule_changed_fanout(uuid)', 'execute'),
  'A1 🔴 權限衛生:notify_staff_schedule_changed_fanout 對 PUBLIC / anon / authenticated 都沒有 EXECUTE'
);
select ok(
  (select bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' and n.nspname = 'private')
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'notify_staff_schedule_changed_fanout')
  and (select count(*) from pg_proc where proname = 'notify_staff_schedule_changed_fanout') = 1,
  'A2 fan-out 函式只有一支、在 private、SECURITY DEFINER、owner postgres(PostgREST 碰不到)'
);
select ok(
  not has_function_privilege('public', 'private.tg_bookings_notify_staff_schedule()', 'execute')
  and not has_function_privilege('anon', 'private.tg_bookings_notify_staff_schedule()', 'execute')
  and not has_function_privilege('authenticated', 'private.tg_bookings_notify_staff_schedule()', 'execute')
  and not has_function_privilege('public', 'private.tg_booking_assistants_notify_staff_schedule()', 'execute')
  and not has_function_privilege('anon', 'private.tg_booking_assistants_notify_staff_schedule()', 'execute')
  and not has_function_privilege('authenticated', 'private.tg_booking_assistants_notify_staff_schedule()', 'execute')
  and not has_function_privilege('authenticated', 'private.same_person_staff_ids_in_group(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.same_person_staff_ids_in_group(uuid)', 'execute'),
  'A3 權限衛生:兩支改寫的 trigger 函式三個角色都沒有 EXECUTE;#924 名單函式的權限沒有被放寬'
);
select ok(
  (select bool_and(prosrc like '%notify_staff_schedule_changed_fanout(%'
                   and prosrc not like '%notify_staff_schedule_changed(%')
   from pg_proc where proname in ('tg_bookings_notify_staff_schedule', 'tg_booking_assistants_notify_staff_schedule')),
  'A4 所有觸發點(主要服務人員、目前助手、助手表)都改走 fan-out,不再直接呼叫第一層'
);
select ok(
  (select prosrc not like '%notify_staff_schedule_changed_fanout%'
          and prosrc like '%same_person_staff_ids_in_group%'
          and prosrc like '%notify_staff_schedule_changed(%'
          and prosrc not like '%realtime.%'
   from pg_proc where proname = 'notify_staff_schedule_changed_fanout'),
  'A5 🔴 不遞迴(結構面):fan-out 本體不呼叫自己、名單只用 #924 那一支、送出只經過第一層(自己不碰 realtime)'
);
select is(
  (select array_agg(t.tgname || '>' || p.proname order by t.tgname)
   from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgname in ('bookings_notify_staff_schedule', 'booking_assistants_notify_staff_schedule')
     and t.tgenabled = 'O'),
  array['booking_assistants_notify_staff_schedule>tg_booking_assistants_notify_staff_schedule',
        'bookings_notify_staff_schedule>tg_bookings_notify_staff_schedule'],
  'A6 兩個 trigger 照舊啟用、指向同名函式'
);

-- =========================================================================
-- B. fan-out 本體
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M2, :I2, :P2, :X2, '2026-12-01 10:00:00+08') as b1 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig(:X2), pg_temp.sig(:X1), pg_temp.sig(:X3), pg_temp.sig(:Y1), pg_temp.sig(:Z2)],
  array[1, 1, 0, 0, 0],
  'B1 🔴 二店替 X2 建單 → X2 本人 1 則、同集團同一個人在一店那一列 X1 也 1 則;別集團同電話 X3、同集團別人 Y1 / Z2 都 0 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M1, :I1, :P1, :X1, '2026-12-01 13:00:00+08') as b2 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig(:X1), pg_temp.sig(:X2), pg_temp.sig(:X3), pg_temp.sig(:Y1)],
  array[1, 1, 0, 0],
  'B2 反方向:一店替 X1 建單 → X1、X2 各 1 則;X3、Y1 0 則'
);

-- B3 同一筆交易:一店、二店都對 X 有變動 → 每一列仍只收 1 則
select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M1, :I1, :P1, :X1, '2026-12-02 10:00:00+08') as b3a \gset
select pg_temp.mk(:M2, :I2, :P2, :X2, '2026-12-02 13:00:00+08') as b3b \gset
select pg_temp.test_clear_auth();
select pg_temp.touch(:'b1'::uuid);
select pg_temp.touch(:'b2'::uuid);
select is(
  array[pg_temp.sig(:X1), pg_temp.sig(:X2), pg_temp.sig_total()],
  array[1, 1, 2],
  'B3 🔴 同交易去重(以收件列為單位):同一筆交易裡一店、二店各建單又各改單 → X1、X2 各只 1 則,總共 2 則'
);
select is(
  current_setting('miaoyue.rt_staff_fanned_out', true),
  '|' || :X1 || '||' || :X2 || '|',
  'B4 fan-out 來源記號:同交易內同一位服務人員只展開一次(省查詢;收件端仍由第一層去重)'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN3);
select pg_temp.mk(:M3, :I3, :P3, :X3, '2026-12-04 10:00:00+08') as b5 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig(:X3), pg_temp.sig(:X1), pg_temp.sig(:X2)],
  array[1, 0, 0],
  'B5 🔴 不同集團、同電話:別集團店替 X3 建單 → 只有 X3 收到,集團一的 X1 / X2 都 0 則'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M1, :I1, :P1, :Y1, '2026-12-01 10:00:00+08') as b6 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig(:Y1), pg_temp.sig(:X1), pg_temp.sig(:X2), pg_temp.sig_total()],
  array[1, 0, 0, 1],
  'B6 同集團、不同人:一店替 Y1 建單 → 只有 Y1 1 則'
);

-- =========================================================================
-- C. 助手(納編)也 fan-out(get_my_day_schedule_state 的 foreign_bookings 也算助手那段)
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select pg_temp.mk(:M2, :I2, :P2, :Z2, '2026-12-03 10:00:00+08', array[:X2::uuid]) as c1 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig(:Z2), pg_temp.sig(:X2), pg_temp.sig(:X1), pg_temp.sig(:Y1)],
  array[1, 1, 1, 0],
  'C1 🔴 二店建單把 X2 加成助手 → Z2、X2 各 1 則,一店的 X1 也 1 則(協助那段在一店畫面也是灰格)'
);

select pg_temp.reset_sig();
select pg_temp.touch(:'c1'::uuid);
select is(
  array[pg_temp.sig(:Z2), pg_temp.sig(:X2), pg_temp.sig(:X1)],
  array[1, 1, 1],
  'C2 bookings UPDATE(批次 1 多做的「通知目前助手」那條)也 fan-out:助手 X2 在一店那列 X1 收到'
);

select pg_temp.reset_sig();
select pg_temp.test_set_auth(:ADMIN1);
select cancel_booking(:'c1'::uuid, '跨店祕密取消原因') is not null as ok_c3 \gset
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig(:Z2), pg_temp.sig(:X2), pg_temp.sig(:X1)],
  array[1, 1, 1],
  'C3 取消有納編 X2 的單 → X1 收到(一店畫面的灰格要消失)'
);

-- C4 轉派主要服務人員(舊的人也要 fan-out):b3b 主要服務人員 X2 → Z2
select pg_temp.reset_sig();
update public.bookings set staff_id = :Z2::uuid where id = :'b3b'::uuid;
select is(
  array[pg_temp.sig(:Z2), pg_temp.sig(:X2), pg_temp.sig(:X1)],
  array[1, 1, 1],
  'C4 轉派:二店的單從 X2 轉給 Z2 → 舊的 X2 與他在一店那列 X1 都收到(灰格要消失)'
);

-- =========================================================================
-- D. 跨店那一列各自套用發送端過濾(量測方式:碰一下 X1 在一店的單 b2)
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[1, 1],
  'D1 正向對照:改 X1 的單 → X1、X2 各 1 則');

update merchant_staff_permissions set granted = false
where staff_id = :X2::uuid and section_key = 'staff_calendar_view';
select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[1, 0],
  'D2 🔴 X2 在二店的行事曆檢視沒開 → 跨店那列收不到(X1 照收)');
update merchant_staff_permissions set granted = true
where staff_id = :X2::uuid and section_key = 'staff_calendar_view';

delete from merchant_staff_permissions where staff_id = :X2::uuid and section_key = 'staff_calendar_view';
select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[1, 0],
  'D3 X2 的行事曆檢視連紀錄都沒有 → 跨店那列收不到');
insert into merchant_staff_permissions (staff_id, section_key, granted)
values (:X2::uuid, 'staff_calendar_view', true);

update merchant_staff set status = 'removed' where id = :X2::uuid;
select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[1, 0],
  'D4 🔴 X2 在二店已停用(removed)→ 跨店那列收不到');
update merchant_staff set status = 'active' where id = :X2::uuid;

update merchant_staff set login_status = 'invited' where id = :X2::uuid;
select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[1, 0],
  'D5 🔴 X2 在二店還沒完成登入(invited)→ 跨店那列收不到');
update merchant_staff set login_status = 'active' where id = :X2::uuid;

update merchant_staff_permissions set granted = false
where staff_id = :X1::uuid and section_key = 'staff_calendar_view';
select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[0, 1],
  'D6 反過來:本人 X1 被過濾掉時,fan-out 照樣展開,X2 照收(兩列各判各的)');
update merchant_staff_permissions set granted = true
where staff_id = :X1::uuid and section_key = 'staff_calendar_view';

select pg_temp.reset_sig();
select pg_temp.touch(:'b2'::uuid);
select is(array[pg_temp.sig(:X1), pg_temp.sig(:X2)], array[1, 1],
  'D7 狀態全部還原後 → 又是各 1 則(證明 D2~D6 的 0 是過濾造成的)');

-- =========================================================================
-- E. 🔴 不遞迴(功能面):在 savepoint 內把名單函式換成不對稱的鏈
--    X2 → [X1]、X1 → [Y1]。只展開一層 ⇒ 改 X2 的單:X2、X1 收到,Y1 不會收到
--    (若會遞迴,X1 會再展開到 Y1)。量測值先存 psql 變數,rollback 還原後才斷言。
-- =========================================================================
select pg_temp.reset_sig();
savepoint no_recursion;
create or replace function private.same_person_staff_ids_in_group(p_staff_id uuid)
returns setof uuid language sql stable set search_path = public
as $$
  select 'e9640000-0000-4000-8000-000000000041'::uuid where p_staff_id = 'e9640000-0000-4000-8000-000000000042'
  union all
  select 'e9640000-0000-4000-8000-000000000044'::uuid where p_staff_id = 'e9640000-0000-4000-8000-000000000041'
$$;
select pg_temp.touch(:'b1'::uuid);
select pg_temp.sig(:X2) as x2, pg_temp.sig(:X1) as x1, pg_temp.sig(:Y1) as y1 \gset nr_
rollback to savepoint no_recursion;
select is(array[:nr_x2::int, :nr_x1::int, :nr_y1::int], array[1, 1, 0],
  'E1 🔴 不遞迴:名單換成鏈 X2→X1→Y1 時,改 X2 的單只展開一層(X2、X1 收到,Y1 不會被連鎖通知)');
select is(
  md5(replace((select prosrc from pg_proc where oid = 'private.same_person_staff_ids_in_group(uuid)'::regprocedure), E'\r\n', E'\n')),
  'd28032b7b8d4373f48193d6ecc4fffa2',
  'E2 rollback 後 #924 名單函式已還原成線上同一版(指紋相同)'
);

-- =========================================================================
-- F. 例外保護:名單函式壞掉 → 改單照常成功、本人照收、只是不展開
--    📌 不用 create_booking 量:建單本身的擋單檢查(check_staff_booking_slot)也用同一支名單函式,
--       注入後建單會被「擋單檢查」擋下,那不是本批次的程式造成的。改用直接改單(只經過 trigger)。
-- =========================================================================
create function pg_temp.try_update(p_booking uuid)
returns text language plpgsql as $$
begin
  update public.bookings set notes = 'F段改單' where id = p_booking;
  return 'ok';
exception when others then
  return 'error: ' || sqlerrm;
end;
$$;

select pg_temp.reset_sig();
savepoint fanout_fault;
create or replace function private.same_person_staff_ids_in_group(p_staff_id uuid)
returns setof uuid language plpgsql stable set search_path = public
as $$ begin raise exception 'fault injected by req964_01'; end; $$;
select pg_temp.try_update(:'b1'::uuid) as result \gset ff_
select pg_temp.sig(:X2) as x2, pg_temp.sig(:X1) as x1,
       (select count(*) from bookings where id = :'b1'::uuid and notes = 'F段改單') as updated \gset ff_
rollback to savepoint fanout_fault;
select is(:'ff_result'::text, 'ok'::text,
  'F1 🔴 例外保護:同集團名單函式直接丟錯 → 改單照樣成功(不回滾)');
select is(array[:ff_updated::int, :ff_x2::int, :ff_x1::int], array[1, 1, 0],
  'F2 對照:改單真的寫進去、本人 X2 照收 1 則,只是沒展開到 X1');
select is(
  md5(replace((select prosrc from pg_proc where oid = 'private.same_person_staff_ids_in_group(uuid)'::regprocedure), E'\r\n', E'\n')),
  'd28032b7b8d4373f48193d6ecc4fffa2',
  'F3 rollback 後名單函式已還原(本檔不會把注入留給後面的測試)'
);

-- =========================================================================
-- G. 🔴 資安:跨店收件那一列收到的訊號跟本人的一樣空
-- =========================================================================
select pg_temp.reset_sig();
select ok(
  (select count(*) from sig_log where topic = 'staff:' || :X1 || ':schedule') >= 8,
  'G1 前提:整份檔案確實對一店那列 X1 發過多則跨店訊號(下面的掃描不是空集合)'
);
select ok(
  (select bool_and(
     (select array_agg(k order by k) from jsonb_object_keys(payload) k) = array['id', 'reason', 'v']
     and payload->>'reason' = 'schedule_changed' and payload->>'v' = '1')
   from sig_log where topic like 'staff:e9640000-%:schedule'),
  'G2 🔴 本檔每一則訊號(含跨店收件列)payload 的 key 逐字等於 {id, reason, v}'
);
select ok(
  not exists (
    select 1 from sig_log s, unnest(array[
      '跨店祕密', '王小明', '0955096499', '0900096401', '測試二店', '測試一店', '別集團',
      '2026-12', 'customer', 'notes', 'booking', 'staff_id', 'merchant',
      'e9640000-0000-4000-8000-000000000042', 'e9640000-0000-4000-8000-000000000022'
    ]) as needle
    where s.topic like 'staff:e9640000-%:schedule' and s.payload::text ilike '%' || needle || '%'),
  'G3 🔴 本檔每一則訊號的 payload 原文搜不到客戶姓名 / 電話 / 備註 / 店名 / 日期 / 欄位名 / 來源那一列的 id'
);
select is(
  (select array_agg(distinct event || '/' || extension || '/' || private::text) from sig_log
   where topic like 'staff:e9640000-%:schedule'),
  array['schedule_changed/broadcast/true'],
  'G4 跨店訊號跟本人訊號同一個事件名、broadcast、私有頻道'
);

select * from finish();
rollback;
