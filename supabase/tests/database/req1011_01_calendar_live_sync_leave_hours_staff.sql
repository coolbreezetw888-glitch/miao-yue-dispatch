-- SPECS-INDEX #1011(第 17 批):請假 / 營業時間 / 服務人員資料變動也即時同步到行事曆
-- 規格:.project/specs/行事曆即時同步補齊-第17批.md
-- 對應 migration:20261008100000_req1011_calendar_live_sync_leave_hours_staff.sql
--
--   P 前置:今天的 realtime.messages 分區存在
--   A 權限衛生 + 結構:五支新函式三個角色都沒有 EXECUTE、private、SECURITY DEFINER、owner postgres、
--     search_path 固定;三個 trigger 啟用;realtime.messages 仍只有兩條 SELECT 政策
--   B 請假:新增 / 取消 / 刪除 → 所屬商家 1 則 + 服務人員本人 1 則;只改備註 → 0 則;不跨店
--   C 營業時間:改時間 → 該商家 1 則 + 該商家已開通的服務人員 1 則;7 天整批改 → 仍 1 則;值沒變 upsert → 0 則;不跨店
--   D 服務人員資料:後台無時段限制 / 名字 / 離職 → 商家 1 則;show_member_info → 只有本人;
--     備註類欄位 / no_time_slot_limit → 0 則;電話換成同集團另一人的 → 兩店都收
--   E 🔴 資安:payload 只有 {id, reason, v},原文搜不到假別 / 備註 / 姓名 / 電話
--   F 例外保護:服務人員發送函式不見了 → 請假、改營業時間照常成功,商家照收
--
-- pgTAP 整份檔案是同一筆交易 ⇒ 每段量測前用 pg_temp.reset_sig() 清 GUC 記號與訊號列(模擬新交易)。
begin;

select plan(27);

create temp table sig_log (topic text, event text, extension text, private boolean, payload jsonb);

create function pg_temp.msig(p_merchant uuid)
returns int language sql as $$
  select count(*)::int from realtime.messages
  where topic = 'merchant:' || p_merchant::text || ':calendar'
    and event = 'calendar_changed' and extension = 'broadcast' and private is true;
$$;

create function pg_temp.ssig(p_staff uuid)
returns int language sql as $$
  select count(*)::int from realtime.messages
  where topic = 'staff:' || p_staff::text || ':schedule'
    and event = 'schedule_changed' and extension = 'broadcast' and private is true;
$$;

create function pg_temp.total()
returns int language sql as $$
  select count(*)::int from realtime.messages where topic like 'merchant:%:calendar' or topic like 'staff:%:schedule';
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

-- =========================================================================
-- Fixture
--   集團一:一店(M1)、二店(M2);集團二:別集團店(M3)
--   X(電話 0900101101):X1 在一店(已開通登入 + 行事曆檢視)、X2 在二店(已開通 + 行事曆檢視)
--   Y1:一店另一位(未開通);W1:一店另一位(已開通 + 行事曆檢視,電話 0900101144)
--   V3:別集團店、電話同 X
-- =========================================================================
insert into auth.users (id, email) values
  ('e1011000-0000-4000-8000-000000000003', 'pgtap-req1011-x1@test.local'),
  ('e1011000-0000-4000-8000-000000000004', 'pgtap-req1011-x2@test.local'),
  ('e1011000-0000-4000-8000-000000000005', 'pgtap-req1011-w1@test.local');

insert into groups (id) values
  ('e1011000-0000-4000-8000-000000000011'),
  ('e1011000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e1011000-0000-4000-8000-000000000021', 'e1011000-0000-4000-8000-000000000011', '請假祕密測試一店', 'in_store_beauty'),
  ('e1011000-0000-4000-8000-000000000022', 'e1011000-0000-4000-8000-000000000011', '請假祕密測試二店', 'in_store_beauty'),
  ('e1011000-0000-4000-8000-000000000023', 'e1011000-0000-4000-8000-000000000012', '請假祕密別集團店', 'in_store_beauty');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone) values
  ('e1011000-0000-4000-8000-000000000041', 'e1011000-0000-4000-8000-000000000021', 'e1011000-0000-4000-8000-000000000003', '祕密服務人員X一店', 'active', 'active', '0900101101'),
  ('e1011000-0000-4000-8000-000000000042', 'e1011000-0000-4000-8000-000000000022', 'e1011000-0000-4000-8000-000000000004', '祕密服務人員X二店', 'active', 'active', '0900101101'),
  ('e1011000-0000-4000-8000-000000000044', 'e1011000-0000-4000-8000-000000000021', null, '祕密服務人員Y一店', 'active', 'not_invited', '0900101144'),
  ('e1011000-0000-4000-8000-000000000045', 'e1011000-0000-4000-8000-000000000021', 'e1011000-0000-4000-8000-000000000005', '祕密服務人員W一店', 'active', 'active', '0900101145'),
  ('e1011000-0000-4000-8000-000000000043', 'e1011000-0000-4000-8000-000000000023', null, '祕密別集團同電話', 'active', 'not_invited', '0900101101');

insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('e1011000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('e1011000-0000-4000-8000-000000000042', 'staff_calendar_view', true),
  ('e1011000-0000-4000-8000-000000000045', 'staff_calendar_view', true);

insert into merchant_leave_types (id, merchant_id, name) values
  ('e1011000-0000-4000-8000-000000000071', 'e1011000-0000-4000-8000-000000000021', '祕密特休假');

\set M1 '''e1011000-0000-4000-8000-000000000021'''
\set M2 '''e1011000-0000-4000-8000-000000000022'''
\set M3 '''e1011000-0000-4000-8000-000000000023'''
\set X1 '''e1011000-0000-4000-8000-000000000041'''
\set X2 '''e1011000-0000-4000-8000-000000000042'''
\set X3 '''e1011000-0000-4000-8000-000000000043'''
\set Y1 '''e1011000-0000-4000-8000-000000000044'''
\set W1 '''e1011000-0000-4000-8000-000000000045'''
\set LT '''e1011000-0000-4000-8000-000000000071'''

-- 營業時間(fixture 階段就會觸發新 trigger;下面每段都先 reset)
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '09:00', '18:00'
from unnest(array[:M1, :M2, :M3]::uuid[]) as m, generate_series(0, 6) as d;

-- =========================================================================
-- P. 前置
-- =========================================================================
select ok(
  exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'realtime.messages'::regclass
            and c.relname = 'messages_' || to_char(now()::timestamp, 'YYYY_MM_DD')),
  'P1 前置:realtime.messages 今天的分區存在(不存在 = 本機 Realtime 沒在跑,下面全部會是 0 則)'
);

-- =========================================================================
-- A. 權限衛生 + 結構
-- =========================================================================
select ok(
  (select bool_and(not has_function_privilege(r, f, 'execute'))
   from unnest(array['public', 'anon', 'authenticated']) r,
        unnest(array['private.notify_calendar_for_merchant_hours(uuid)',
                     'private.notify_calendar_for_phone_peers(uuid,uuid,text)',
                     'private.tg_staff_leave_records_calendar_live_sync()',
                     'private.tg_merchant_business_hours_calendar_live_sync()',
                     'private.tg_merchant_staff_calendar_live_sync()']) f),
  'A1 🔴 權限衛生:五支新函式對 PUBLIC / anon / authenticated 都沒有 EXECUTE'
);
select ok(
  (select bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' and n.nspname = 'private'
                   and p.proconfig @> array['search_path=public'])
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in ('notify_calendar_for_merchant_hours', 'notify_calendar_for_phone_peers',
                       'tg_staff_leave_records_calendar_live_sync', 'tg_merchant_business_hours_calendar_live_sync',
                       'tg_merchant_staff_calendar_live_sync'))
  and (select count(*) from pg_proc where proname in ('notify_calendar_for_merchant_hours', 'notify_calendar_for_phone_peers',
                       'tg_staff_leave_records_calendar_live_sync', 'tg_merchant_business_hours_calendar_live_sync',
                       'tg_merchant_staff_calendar_live_sync')) = 5,
  'A2 五支新函式都在 private、SECURITY DEFINER、owner postgres、search_path 固定為 public'
);
select is(
  (select array_agg(c.relname || '.' || t.tgname || '>' || p.proname order by c.relname)
   from pg_trigger t join pg_proc p on p.oid = t.tgfoid join pg_class c on c.oid = t.tgrelid
   where t.tgname like '%calendar_live_sync' and t.tgenabled = 'O'),
  array['merchant_business_hours.merchant_business_hours_calendar_live_sync>tg_merchant_business_hours_calendar_live_sync',
        'merchant_staff.merchant_staff_calendar_live_sync>tg_merchant_staff_calendar_live_sync',
        'staff_leave_records.staff_leave_records_calendar_live_sync>tg_staff_leave_records_calendar_live_sync'],
  'A3 三個 trigger 掛在請假 / 營業時間 / 服務人員三張表上、啟用中'
);
select is(
  (select array_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ',') order by policyname)
   from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
  array['merchant_calendar_broadcast_receive:SELECT:authenticated',
        'staff_schedule_broadcast_receive:SELECT:authenticated'],
  'A4 🔴 realtime.messages 仍只有兩條 SELECT 政策,沒有任何寫入政策'
);
select ok(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and (p.prosrc ilike '%realtime.send%' or p.prosrc ilike '%realtime.messages%'))
  and not exists (select 1 from pg_proc where proname in ('notify_calendar_for_merchant_hours', 'notify_calendar_for_phone_peers',
                       'tg_staff_leave_records_calendar_live_sync', 'tg_merchant_business_hours_calendar_live_sync',
                       'tg_merchant_staff_calendar_live_sync')
                  and (prosrc ilike '%realtime.%' or prosrc ilike '%broadcast_changes%')),
  'A5 🔴 新函式不直接碰 realtime(一律走既有發送函式);public schema 沒有任何函式包裝 realtime.send'
);

-- =========================================================================
-- B. 請假
-- =========================================================================
select pg_temp.reset_sig();
insert into public.staff_leave_records (id, staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, notes)
values ('e1011000-0000-4000-8000-000000000081', :X1, :LT, '祕密特休假', '2026-12-10', '2026-12-11', '祕密請假備註');
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.msig(:M2), pg_temp.ssig(:X2), pg_temp.ssig(:W1), pg_temp.total()],
  array[1, 1, 0, 0, 0, 2],
  'B1 🔴 新增請假 → 一店 1 則 + 服務人員 X1 本人 1 則;同一個人的二店 / X2、同店其他人 0 則(不跨店)'
);

select pg_temp.reset_sig();
update public.staff_leave_records set notes = '祕密請假備註改了', updated_at = now()
where id = 'e1011000-0000-4000-8000-000000000081';
select is(pg_temp.total(), 0, 'B2 只改請假備註(行事曆沒顯示)→ 0 則');

select pg_temp.reset_sig();
update public.staff_leave_records set status = 'cancelled', cancelled_at = now()
where id = 'e1011000-0000-4000-8000-000000000081';
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.total()],
  array[1, 1, 2],
  'B3 取消請假(status → cancelled)→ 一店 1 則 + 本人 1 則'
);

select pg_temp.reset_sig();
update public.staff_leave_records set end_date = '2026-12-12' where id = 'e1011000-0000-4000-8000-000000000081';
delete from public.staff_leave_records where id = 'e1011000-0000-4000-8000-000000000081';
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.total()],
  array[1, 1, 2],
  'B4 同交易改日期又刪除 → 一店只 1 則、本人只 1 則(交易內去重)'
);

select pg_temp.reset_sig();
insert into public.staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date)
values (:Y1, :LT, '祕密特休假', '2026-12-10', '2026-12-10');
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:Y1), pg_temp.total()],
  array[1, 0, 1],
  'B5 未開通登入的服務人員請假 → 一店 1 則,本人頻道不發(沿用 #885 發送端過濾)'
);

-- =========================================================================
-- C. 營業時間
-- =========================================================================
select pg_temp.reset_sig();
update public.merchant_business_hours set close_time = '20:00' where merchant_id = :M1 and day_of_week = 1;
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.ssig(:W1), pg_temp.ssig(:Y1),
        pg_temp.msig(:M2), pg_temp.ssig(:X2), pg_temp.total()],
  array[1, 1, 1, 0, 0, 0, 3],
  'C1 🔴 改一店營業時間 → 一店 1 則 + 一店已開通的 X1、W1 各 1 則;未開通 Y1、二店、X 的二店那列 0 則(不跨店)'
);

select pg_temp.reset_sig();
update public.merchant_business_hours set is_closed = true, open_time = null, close_time = null where merchant_id = :M1;
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.ssig(:W1), pg_temp.total()],
  array[1, 1, 1, 3],
  'C2 一次把 7 天改成公休 → 一店只 1 則、每位服務人員只 1 則(交易內去重)'
);

select pg_temp.reset_sig();
insert into public.merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select :M2::uuid, d, false, '09:00', '18:00' from generate_series(0, 6) d
on conflict (merchant_id, day_of_week) do update
  set is_closed = excluded.is_closed, open_time = excluded.open_time, close_time = excluded.close_time;
select is(pg_temp.total(), 0, 'C3 營業時間頁整批存檔但值都沒變(只動 updated_at)→ 0 則');

select pg_temp.reset_sig();
delete from public.merchant_business_hours where merchant_id = :M2 and day_of_week = 0;
select is(
  array[pg_temp.msig(:M2), pg_temp.ssig(:X2), pg_temp.msig(:M1), pg_temp.ssig(:X1)],
  array[1, 1, 0, 0],
  'C4 刪掉二店某天的營業時間 → 二店 1 則 + X2 1 則;一店 / X1 0 則'
);

-- =========================================================================
-- D. 服務人員資料
-- =========================================================================
select pg_temp.reset_sig();
update public.merchant_staff set unlimited_backend_edit = not unlimited_backend_edit where id = :Y1;
select is(
  array[pg_temp.msig(:M1), pg_temp.msig(:M2), pg_temp.total()],
  array[1, 0, 1],
  'D1 🔴 切換「後台無時段限制」→ 一店 1 則(Y1 未開通,本人不發);二店 0 則'
);

select pg_temp.reset_sig();
update public.merchant_staff set name = '祕密服務人員X一店改名' where id = :X1;
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.msig(:M2), pg_temp.ssig(:X2)],
  array[1, 1, 0, 0],
  'D2 改名字(行事曆欄名與排序)→ 一店 1 則 + 本人 1 則;不跨店'
);

select pg_temp.reset_sig();
update public.merchant_staff set show_member_info = not show_member_info where id = :X1;
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:X1), pg_temp.total()],
  array[0, 1, 1],
  'D3 show_member_info(只影響服務人員端客戶欄位)→ 商家 0 則、本人 1 則'
);

select pg_temp.reset_sig();
update public.merchant_staff
set intro = '祕密自我介紹', avatar_url = 'https://example.invalid/a.png', nickname = '祕密暱稱',
    is_listed = not is_listed, no_time_slot_limit = not no_time_slot_limit, updated_at = now()
where id = :X1;
select is(pg_temp.total(), 0, 'D4 🔴 行事曆沒讀的欄位(介紹 / 頭像 / 暱稱 / 上架 / 客戶端無時段限制)→ 0 則');

select pg_temp.reset_sig();
update public.merchant_staff set phone = '0900101101' where id = :W1;
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig(:W1), pg_temp.msig(:M2), pg_temp.ssig(:X2), pg_temp.ssig(:X1),
        pg_temp.msig(:M3)],
  array[1, 1, 1, 1, 1, 0],
  'D5 🔴 W1 電話改成跟 X 一樣(同集團變成同一個人)→ 一店、二店各 1 則,W1 / X1 / X2 各 1 則;別集團店 0 則'
);

select pg_temp.reset_sig();
update public.merchant_staff set status = 'removed' where id = :Y1;
select is(
  array[pg_temp.msig(:M1), pg_temp.msig(:M2)],
  array[1, 0],
  'D6 🔴 服務人員離職(status → removed)→ 一店 1 則'
);

-- =========================================================================
-- E. 🔴 資安:訊號原文
-- =========================================================================
select pg_temp.reset_sig();
select is(
  (select array_agg(distinct k order by k) from sig_log s, jsonb_object_keys(s.payload) k),
  array['id', 'reason', 'v'],
  'E1 🔴 本檔所有訊號(商家 + 服務人員頻道)payload 的 key 只有 id / reason / v'
);
select ok(
  (select count(*) from sig_log) > 15
  and not exists (select 1 from sig_log
                  where payload::text like '%祕密%' or payload::text like '%0900101%'
                     or payload::text like '%e1011000%' or payload::text like '%2026-12%'
                     or private is not true or extension <> 'broadcast'
                     or (topic like 'merchant:%' and (event <> 'calendar_changed' or payload->>'reason' <> 'calendar_changed'))
                     or (topic like 'staff:%' and (event <> 'schedule_changed' or payload->>'reason' <> 'schedule_changed'))),
  'E2 🔴 訊號原文搜不到假別 / 請假備註 / 姓名 / 電話 / id / 日期;事件與 reason 沿用既有兩種'
);

-- =========================================================================
-- F. 例外保護:服務人員發送函式不見了 → 存檔照常成功、商家照收
-- =========================================================================
select pg_temp.reset_sig();
alter function private.notify_staff_schedule_changed(uuid) rename to notify_staff_schedule_changed_req1011_off;
select lives_ok(
  $$insert into public.staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date)
    values ('e1011000-0000-4000-8000-000000000041', 'e1011000-0000-4000-8000-000000000071', '祕密特休假', '2026-12-20', '2026-12-20')$$,
  'F1 🔴 服務人員發送函式壞掉 → 新增請假照常成功(只留 WARNING)'
);
select lives_ok(
  $$update public.merchant_business_hours set is_closed = false, open_time = '10:00', close_time = '19:00'
    where merchant_id = 'e1011000-0000-4000-8000-000000000021' and day_of_week = 3$$,
  'F2 🔴 服務人員發送函式壞掉 → 改營業時間照常成功'
);
select lives_ok(
  $$update public.merchant_staff set name = '祕密改名二' where id = 'e1011000-0000-4000-8000-000000000045'$$,
  'F3 🔴 服務人員發送函式壞掉 → 改服務人員資料照常成功'
);
alter function private.notify_staff_schedule_changed_req1011_off(uuid) rename to notify_staff_schedule_changed;
select is(
  array[pg_temp.msig(:M1), pg_temp.total()],
  array[1, 1],
  'F4 服務人員那段壞掉時,商家那段照樣發出(分段保護,不會一起回滾)'
);

select * from finish();
rollback;
