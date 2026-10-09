-- SPECS-INDEX #1036(第 23 批):服務人員端「每週可預約時段」+「單日例外」即時同步
-- 規格:.project/specs/服務人員端時段即時同步-第23批.md
-- 對應 migration:20261008150000_req1036_staff_availability_windows_staff_live_sync.sql
--
--   P 前置:今天的 realtime.messages 分區存在
--   A 權限衛生 + 結構:新 trigger 函式三個角色都沒有 EXECUTE、private、SECURITY DEFINER、owner postgres、
--     search_path 固定;新 trigger 是 AFTER ROW INSERT/UPDATE/DELETE、啟用中;#1003 商家那個 trigger 還在;
--     realtime.messages 仍只有兩條 SELECT 政策;新函式不直接碰 realtime
--   B 商家管理員(authenticated + RLS 真路徑)新增 / 修改 / 刪除 X1 的時段 → X1 本人 1 則;
--     同店其他服務人員、同集團同一個人的二店那列 0 則;只動 updated_at → 本人 0 則;同交易多次 → 1 則
--   C 發送端過濾:未開通登入 / 行事曆檢視關閉 → 本人頻道 0 則(商家頻道照舊)
--   D 服務人員本人改自己的時段 → 自己 1 則(另一台裝置更新);別的服務人員改不了 X1 的(42501、0 則)
--   E 🔴 資安:payload 只有 {id, reason, v},原文搜不到時間 / 星期 / 姓名 / id
--   F 例外保護:服務人員發送函式不見了 → 改時段照常成功,商家頻道照收
--   G 🔴 收聽端沒放寬:W1、X2(同一個人在二店的帳號)聽不到 X1 的頻道;X1 自己可以
--   H 單日例外(主腦裁決同批補上):管理員用 set_staff_day_override(行事曆點格子)關 / 清 X1 的格子 → X1 本人
--     1 則、別人 0 則;同值 upsert(只動 updated_at)→ 0 則;行事曆檢視關閉的人 → 0 則;發送函式壞掉照常存檔
--
-- 【故障注入(2026-10-08,本機,量測完已還原 tgenabled = O)】
--   ① 停用 staff_availability_windows_staff_live_sync   → A3、B1、B2、B4、B5、D1 轉紅
--   ② 停用 staff_availability_overrides_staff_live_sync → A3b、H1、H3 轉紅
--
-- pgTAP 整份檔案是同一筆交易 ⇒ 每段量測前用 pg_temp.reset_sig() 清 GUC 記號與訊號列(模擬新交易)。
begin;

select plan(32);

create temp table sig_log (topic text, event text, extension text, private boolean, payload jsonb);
grant all on sig_log to authenticated;

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

create function pg_temp.ssig_total()
returns int language sql as $$
  select count(*)::int from realtime.messages where topic like 'staff:%:schedule';
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

create function pg_temp.as_user(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
  set local role authenticated;
end;
$$;

create function pg_temp.as_owner()
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- =========================================================================
-- Fixture
--   集團一:一店(M1)、二店(M2)
--   管理員甲(A1)管一店
--   X(電話 0900103601):X1 在一店(已開通 + 行事曆檢視 + 排班自助 + 抽成制)、X2 在二店(已開通 + 行事曆檢視)
--   W1:一店另一位(已開通 + 行事曆檢視);Y1:一店未開通;Z1:一店已開通但行事曆檢視關閉
-- =========================================================================
insert into auth.users (id, email) values
  ('e1036000-0000-4000-8000-000000000001', 'pgtap-req1036-admin@test.local'),
  ('e1036000-0000-4000-8000-000000000003', 'pgtap-req1036-x1@test.local'),
  ('e1036000-0000-4000-8000-000000000004', 'pgtap-req1036-x2@test.local'),
  ('e1036000-0000-4000-8000-000000000005', 'pgtap-req1036-w1@test.local'),
  ('e1036000-0000-4000-8000-000000000006', 'pgtap-req1036-z1@test.local');

insert into groups (id) values ('e1036000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('e1036000-0000-4000-8000-000000000021', 'e1036000-0000-4000-8000-000000000011', '時段祕密測試一店', 'in_store_beauty'),
  ('e1036000-0000-4000-8000-000000000022', 'e1036000-0000-4000-8000-000000000011', '時段祕密測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e1036000-0000-4000-8000-000000000021', 'e1036000-0000-4000-8000-000000000001', '管理員甲');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, compensation_type) values
  ('e1036000-0000-4000-8000-000000000041', 'e1036000-0000-4000-8000-000000000021', 'e1036000-0000-4000-8000-000000000003', '祕密時段服務人員X一店', 'active', 'active', '0900103601', 'piece_rate'),
  ('e1036000-0000-4000-8000-000000000042', 'e1036000-0000-4000-8000-000000000022', 'e1036000-0000-4000-8000-000000000004', '祕密時段服務人員X二店', 'active', 'active', '0900103601', 'piece_rate'),
  ('e1036000-0000-4000-8000-000000000044', 'e1036000-0000-4000-8000-000000000021', null, '祕密時段服務人員Y一店', 'active', 'not_invited', '0900103644', 'piece_rate'),
  ('e1036000-0000-4000-8000-000000000045', 'e1036000-0000-4000-8000-000000000021', 'e1036000-0000-4000-8000-000000000005', '祕密時段服務人員W一店', 'active', 'active', '0900103645', 'piece_rate'),
  ('e1036000-0000-4000-8000-000000000046', 'e1036000-0000-4000-8000-000000000021', 'e1036000-0000-4000-8000-000000000006', '祕密時段服務人員Z一店', 'active', 'active', '0900103646', 'piece_rate');

insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('e1036000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('e1036000-0000-4000-8000-000000000041', 'staff_availability_self_manage', true),
  ('e1036000-0000-4000-8000-000000000042', 'staff_calendar_view', true),
  ('e1036000-0000-4000-8000-000000000045', 'staff_calendar_view', true),
  ('e1036000-0000-4000-8000-000000000045', 'staff_availability_self_manage', true),
  ('e1036000-0000-4000-8000-000000000046', 'staff_calendar_view', false)
on conflict (staff_id, section_key) do update set granted = excluded.granted;

\set M1 '''e1036000-0000-4000-8000-000000000021'''
\set M2 '''e1036000-0000-4000-8000-000000000022'''
\set A1U '''e1036000-0000-4000-8000-000000000001'''
\set X1U '''e1036000-0000-4000-8000-000000000003'''
\set X2U '''e1036000-0000-4000-8000-000000000004'''
\set W1U '''e1036000-0000-4000-8000-000000000005'''
\set X1 '''e1036000-0000-4000-8000-000000000041'''
\set X2 '''e1036000-0000-4000-8000-000000000042'''
\set Y1 '''e1036000-0000-4000-8000-000000000044'''
\set W1 '''e1036000-0000-4000-8000-000000000045'''
\set Z1 '''e1036000-0000-4000-8000-000000000046'''
\set WIN '''e1036000-0000-4000-8000-000000000081'''

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
        unnest(array['private.tg_staff_availability_windows_staff_live_sync()',
                     'private.tg_staff_availability_overrides_staff_live_sync()']) f),
  'A1 🔴 權限衛生:兩支新 trigger 函式對 PUBLIC / anon / authenticated 都沒有 EXECUTE'
);
select ok(
  (select bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres' and n.nspname = 'private'
          and p.proconfig @> array['search_path=public'])
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in ('tg_staff_availability_windows_staff_live_sync', 'tg_staff_availability_overrides_staff_live_sync'))
  and (select count(*) from pg_proc where proname in ('tg_staff_availability_windows_staff_live_sync',
                                                      'tg_staff_availability_overrides_staff_live_sync')) = 2,
  'A2 兩支新函式在 private、SECURITY DEFINER、owner postgres、search_path 固定為 public'
);
select is(
  (select array_agg(t.tgname || '>' || p.proname || '>' || t.tgenabled::text || '>' ||
                    case when pg_get_triggerdef(t.oid) like '%AFTER INSERT OR DELETE OR UPDATE ON public.staff_availability_windows FOR EACH ROW%'
                         then 'after-row-iud' else pg_get_triggerdef(t.oid) end
                    order by t.tgname)
   from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.staff_availability_windows'::regclass and not t.tgisinternal
     and t.tgname in ('staff_availability_windows_staff_live_sync', 'staff_availability_windows_notify_merchant_calendar')),
  array['staff_availability_windows_notify_merchant_calendar>tg_staff_availability_notify_merchant_calendar>O>after-row-iud',
        'staff_availability_windows_staff_live_sync>tg_staff_availability_windows_staff_live_sync>O>after-row-iud'],
  'A3 新 trigger 是 AFTER ROW INSERT / UPDATE / DELETE、啟用中;#1003 商家頻道那個 trigger 照舊'
);
select is(
  (select array_agg(t.tgname || '>' || p.proname || '>' || t.tgenabled::text || '>' ||
                    case when pg_get_triggerdef(t.oid) like '%AFTER INSERT OR DELETE OR UPDATE ON public.staff_availability_overrides FOR EACH ROW%'
                         then 'after-row-iud' else pg_get_triggerdef(t.oid) end
                    order by t.tgname)
   from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.staff_availability_overrides'::regclass and not t.tgisinternal),
  -- #1035 B 批 PB-R03:多一個 staff_availability_overrides_refreeze_work_day(過去日子改格子時重算日薪／時薪上工紀錄)。
  array['staff_availability_overrides_notify_merchant_calendar>tg_staff_availability_notify_merchant_calendar>O>after-row-iud',
        'staff_availability_overrides_refreeze_work_day>tg_staff_availability_overrides_refreeze_work_day>O>after-row-iud',
        'staff_availability_overrides_staff_live_sync>tg_staff_availability_overrides_staff_live_sync>O>after-row-iud'],
  'A3b 單日例外表:新 trigger 是 AFTER ROW INSERT / UPDATE / DELETE、啟用中;#1003 商家頻道那個照舊;#1035 B 批重算那個(共 3 個)'
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
  and not exists (select 1 from pg_proc where proname in ('tg_staff_availability_windows_staff_live_sync',
                                                         'tg_staff_availability_overrides_staff_live_sync')
                  and (prosrc ilike '%realtime.%' or prosrc ilike '%broadcast_changes%' or prosrc ilike '%raise exception%')),
  'A5 🔴 新函式不直接碰 realtime、不 raise 錯誤(一律走既有發送函式);public schema 沒有任何函式包裝 realtime.send'
);

-- =========================================================================
-- B. 商家管理員改 X1 的每週時段(authenticated + RLS 真路徑)
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
insert into public.staff_availability_windows (id, staff_id, day_of_week, start_time, end_time)
values (:WIN, :X1, 3, '09:00', '12:00');
select pg_temp.as_owner();
select is(
  array[pg_temp.ssig(:X1), pg_temp.ssig(:W1), pg_temp.ssig(:X2), pg_temp.ssig(:Z1), pg_temp.ssig_total(), pg_temp.msig(:M1), pg_temp.msig(:M2)],
  array[1, 0, 0, 0, 1, 1, 0],
  'B1 🔴 管理員新增 X1 的時段 → X1 本人 1 則;同店 W1 / Z1、同一個人在二店的 X2 都 0 則;一店商家頻道照舊 1 則'
);

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
update public.staff_availability_windows set end_time = '13:00' where id = :WIN;
select pg_temp.as_owner();
select is(array[pg_temp.ssig(:X1), pg_temp.ssig_total()], array[1, 1], 'B2 管理員修改 X1 的時段 → X1 本人 1 則');

select pg_temp.reset_sig();
update public.staff_availability_windows set updated_at = now() + interval '1 minute' where id = :WIN;
select is(pg_temp.ssig_total(), 0, 'B3 只動 updated_at(時段沒變)→ 服務人員頻道 0 則');

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
update public.staff_availability_windows set start_time = '08:00' where id = :WIN;
insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time) values (:X1, 4, '10:00', '11:00');
delete from public.staff_availability_windows where staff_id = :X1 and day_of_week = 4;
select pg_temp.as_owner();
select is(array[pg_temp.ssig(:X1), pg_temp.ssig_total()], array[1, 1], 'B4 同一筆交易改 + 新增 + 刪除 → X1 只 1 則(交易內去重)');

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
delete from public.staff_availability_windows where id = :WIN;
select pg_temp.as_owner();
select is(array[pg_temp.ssig(:X1), pg_temp.ssig_total()], array[1, 1], 'B5 管理員刪除 X1 的時段 → X1 本人 1 則');

-- =========================================================================
-- C. 發送端過濾(沿用 #885)
-- =========================================================================
select pg_temp.reset_sig();
insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time) values (:Y1, 1, '09:00', '12:00');
select is(
  array[pg_temp.ssig(:Y1), pg_temp.ssig_total(), pg_temp.msig(:M1)],
  array[0, 0, 1],
  'C1 未開通登入的服務人員 → 本人頻道 0 則(商家頻道照舊 1 則)'
);

select pg_temp.reset_sig();
insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time) values (:Z1, 1, '09:00', '12:00');
select is(
  array[pg_temp.ssig(:Z1), pg_temp.ssig_total()],
  array[0, 0],
  'C2 🔴 行事曆檢視關閉的服務人員 → 本人頻道 0 則(跟收聽端判定一致,他本來就加入不了頻道)'
);

-- =========================================================================
-- D. 服務人員本人
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.as_user(:X1U);
insert into public.staff_availability_windows (id, staff_id, day_of_week, start_time, end_time)
values (:WIN, :X1, 5, '14:00', '16:00');
select pg_temp.as_owner();
select is(
  array[pg_temp.ssig(:X1), pg_temp.ssig_total()],
  array[1, 1],
  'D1 服務人員 X1 自己新增時段 → 自己頻道 1 則(另一台裝置 / 分頁跟著更新)'
);

select pg_temp.reset_sig();
select pg_temp.as_user(:W1U);
select throws_ok(
  $$insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    values ('e1036000-0000-4000-8000-000000000041', 6, '09:00', '10:00')$$,
  '42501',
  '沒有權限設定這位服務人員的可預約時段',
  'D2 🔴 權限沒放寬:W1 改不了 X1 的時段(42501,訊息不含任何時段)'
);
select pg_temp.as_owner();
select is(pg_temp.ssig_total(), 0, 'D3 被擋下的寫入 → 0 則');

-- =========================================================================
-- E. 🔴 資安:訊號原文
-- =========================================================================
select pg_temp.reset_sig();
select is(
  (select array_agg(distinct k order by k) from sig_log s, jsonb_object_keys(s.payload) k where s.topic like 'staff:%'),
  array['id', 'reason', 'v'],
  'E1 🔴 本檔所有服務人員頻道訊號 payload 的 key 只有 id / reason / v'
);
-- 客戶端第 3 批(2026-10-09 主腦裁決)修正:只算「本檔測試資料」的頻道(e1036000- 開頭的服務人員 / 商家)。
--   原本用 topic like 'staff:%' 會把資料庫裡先前 e2e 留下的舊訊號也算進來;乾淨資料庫上本檔實際只產生
--   B1、B2、B4、B5、D1 共 5 則服務人員訊號,所以門檻改成 >= 5(= 本檔每一則都必須真的發出)。檢查內容不變。
select ok(
  (select count(*) from sig_log where topic like 'staff:e1036000-%') >= 5
  and not exists (select 1 from sig_log
                  where (topic like 'staff:e1036000-%' or topic like 'merchant:e1036000-%')
                    and (payload::text like '%祕密%' or payload::text like '%0900103%'
                     or payload::text like '%e1036000%' or payload::text like '%:00%'
                     or payload::text like '%day_of_week%' or private is not true or extension <> 'broadcast'
                     or (topic like 'staff:%' and (event <> 'schedule_changed' or payload->>'reason' <> 'schedule_changed')))),
  'E2 🔴 訊號原文搜不到時間 / 星期 / 姓名 / 電話 / id;事件與 reason 沿用 schedule_changed'
);

-- =========================================================================
-- F. 例外保護
-- =========================================================================
select pg_temp.reset_sig();
alter function private.notify_staff_schedule_changed(uuid) rename to notify_staff_schedule_changed_req1036_off;
select lives_ok(
  $$update public.staff_availability_windows set end_time = '17:00' where id = 'e1036000-0000-4000-8000-000000000081'$$,
  'F1 🔴 服務人員發送函式壞掉 → 改時段照常成功(只留 WARNING)'
);
alter function private.notify_staff_schedule_changed_req1036_off(uuid) rename to notify_staff_schedule_changed;
select is(
  array[pg_temp.msig(:M1), pg_temp.ssig_total()],
  array[1, 0],
  'F2 服務人員那段壞掉時,商家頻道照樣發出(各自獨立)'
);
select is(
  (select end_time from public.staff_availability_windows where id = :WIN),
  '17:00'::time,
  'F3 存檔確實寫進去了'
);

-- =========================================================================
-- G. 🔴 收聽端沒放寬(Realtime 加入頻道時的判定)
-- =========================================================================
select pg_temp.as_user(:W1U);
select is(private.can_listen_staff_schedule_topic('staff:e1036000-0000-4000-8000-000000000041:schedule'), false,
  'G1 🔴 同店另一位服務人員 W1 加入不了 X1 的頻道');
select pg_temp.as_owner();
select pg_temp.as_user(:X2U);
select is(private.can_listen_staff_schedule_topic('staff:e1036000-0000-4000-8000-000000000041:schedule'), false,
  'G2 🔴 同一個人在二店的帳號(X2)也加入不了一店 X1 的頻道(訊號只到 X1 那一列本人)');
select pg_temp.as_owner();
select pg_temp.as_user(:X1U);
select is(private.can_listen_staff_schedule_topic('staff:e1036000-0000-4000-8000-000000000041:schedule'), true,
  'G3 X1 本人可以加入自己的頻道(正向對照)');
select pg_temp.as_owner();

-- =========================================================================
-- H. 單日例外(行事曆點格子開關時段)
--   X1 今天以後某個星期三:每週時段先布置 09:00–12:00(#1023:時段外不能「開」,關不受限)
-- =========================================================================
insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
values (:X1, 3, '09:00', '12:00'), (:W1, 3, '09:00', '12:00'), (:Z1, 3, '09:00', '12:00');
\set OD '''2026-12-16'''

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
select set_staff_day_override(:X1, :OD::date, '09:00'::time, '10:30'::time, false);
select pg_temp.as_owner();
select is(
  array[pg_temp.ssig(:X1), pg_temp.ssig(:W1), pg_temp.ssig(:X2), pg_temp.ssig(:Z1), pg_temp.ssig_total(), pg_temp.msig(:M1)],
  array[1, 0, 0, 0, 1, 1],
  'H1 🔴 管理員在行事曆關掉 X1 三格 → X1 本人只 1 則(去重);同店 W1 / Z1、二店的 X2 都 0 則;一店商家頻道照舊 1 則'
);

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
select set_staff_day_override(:X1, :OD::date, '09:00'::time, '10:30'::time, false);
select pg_temp.as_owner();
select is(pg_temp.ssig_total(), 0, 'H2 再關一次同樣的格子(upsert 只動 updated_at)→ 服務人員頻道 0 則');

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
select clear_staff_day_override(:X1, :OD::date, '09:00'::time, '10:30'::time);
select pg_temp.as_owner();
select is(array[pg_temp.ssig(:X1), pg_temp.ssig_total()], array[1, 1], 'H3 管理員把格子恢復(刪例外)→ X1 本人 1 則');

select pg_temp.reset_sig();
select pg_temp.as_user(:A1U);
select set_staff_day_override(:Z1, :OD::date, '09:00'::time, '09:30'::time, false);
select pg_temp.as_owner();
select is(array[pg_temp.ssig(:Z1), pg_temp.ssig_total(), pg_temp.msig(:M1)], array[0, 0, 1],
  'H4 行事曆檢視關閉的 Z1 → 本人頻道 0 則(商家頻道照舊)');

select pg_temp.reset_sig();
alter function private.notify_staff_schedule_changed(uuid) rename to notify_staff_schedule_changed_req1036_off;
select lives_ok(
  $$insert into public.staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values ('e1036000-0000-4000-8000-000000000041', '2026-12-16', '11:00', false)$$,
  'H5 🔴 服務人員發送函式壞掉 → 單日例外照常存檔(只留 WARNING)'
);
alter function private.notify_staff_schedule_changed_req1036_off(uuid) rename to notify_staff_schedule_changed;
select is(array[pg_temp.msig(:M1), pg_temp.ssig_total()], array[1, 0], 'H6 服務人員那段壞掉時,商家頻道照樣發出');

select pg_temp.reset_sig();
select is(
  (select array_agg(distinct k order by k) from sig_log s, jsonb_object_keys(s.payload) k where s.topic like 'staff:%'),
  array['id', 'reason', 'v'],
  'H7 🔴 加上單日例外之後,所有服務人員頻道訊號 payload 的 key 仍只有 id / reason / v(沒有日期 / 格子)'
);

select * from finish();
rollback;
