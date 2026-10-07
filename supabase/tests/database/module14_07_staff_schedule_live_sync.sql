-- SPECS-INDEX #874 服務人員端行事曆即時同步 —— pgTAP module14_07
-- 規格:.project/specs/服務人員端即時同步.md v1.1 §二 #885~#888、#904 第二層、§三 批次 1
-- 對應 migration:20261001110000_req874_staff_schedule_live_sync_signal.sql
--
-- 本檔目前內容(批次 1:發訊號端):
--   P 前置:今天(UTC)的 realtime.messages 分區存在、realtime.send 直接呼叫會寫入(環境正向對照)
--   A 權限衛生:三支新函式 PUBLIC / anon / authenticated 都沒有 EXECUTE;SECURITY DEFINER、owner postgres、
--     放 private;兩個 trigger 是 AFTER ROW INSERT/UPDATE/DELETE;沒有用 broadcast_changes;沒有新增 public 函式
--   B 12 支會改訂單的入口每一支都會發訊號(含 #844 還原完成 / 取消已完成、紅利折抵退回),
--     助手(納編)三種形態 + CASCADE 刪除、交易內去重
--   C 發送端過濾:未開通登入 / 已邀請未登入 / 已移除 / 行事曆檢視關閉(直接 false、沒有紀錄、
--     管理員用 set_staff_permission 關掉)都 0 則;打開後 1 則(正向對照)
--   D 🔴 資安:payload 原文搜不到客戶姓名 / 電話 / 地址 / Email / 內部備註 / 客戶備註 / booking_id / 日期;
--     key 集合逐字等於 {id, reason, v};其他商家的服務人員一則都收不到
--   E 故障注入:發送端過濾的 helper 壞掉 → 建單照樣成功、只是不發(savepoint 內注入、量測後還原);
--     realtime.send 真的失敗(以 authenticated 身分寫入被 RLS 擋)→ 不丟錯
--   (以下批次 2,授權端,對應 migration 20261001110100_req874_staff_schedule_live_sync_authz.sql)
--   F 訂閱端 ↔ 發送端判定一致(#890 v1.1):六種狀態「能訂 ⇔ 有發」
--   G #890 授權判定函式:權限衛生、IDOR、各種身分、亂打的 topic 回 false 不丟錯
--   H #891 政策本身:只看得到目前頻道自己的 broadcast 列
--   I 🔴 #892 沒有 INSERT 政策:政策只有 1 條 SELECT、直接寫入被 RLS 擋、public 沒有包裝 realtime.send 的函式
--
-- 🔴 去重用的是「交易內」GUC,而 pgTAP 整份檔案是同一筆交易 ⇒ 每一段量測前用 pg_temp.reset_sig()
--    清掉已通知記號與之前的訊號列(模擬「新的一筆交易」);清掉的列先複製進 sig_log,最後 D 段
--    對「整份檔案發出的所有訊號」再做一次資安掃描。
--
-- 【故障注入(2026-10-01 台北約 15:40,本機容器 create or replace 後跑本檔,之後已用 db reset --local 還原)】
--   ① 拿掉交易內去重                → B3、B4、B6、B11、B13、B15、B16 共 7 條轉紅
--   ② 拿掉「行事曆檢視」過濾        → C3、C4、C6、C10、E5 共 5 條轉紅
--   ③ 拿掉「在職 + 已開通登入」過濾 → C2、C7、C8 共 3 條轉紅
--   ④ payload 多帶 staff_id         → D2、D3、D7 共 3 條轉紅
--   ⑤ bookings UPDATE 不通知助手    → B2、B5、B9、B10、B11、B12 共 6 條轉紅
--   ⑥ bookings 轉派不通知舊的人     → B7 轉紅
--   ⑦ 拿掉 notify 的例外保護        → E4、E5 轉紅(helper 壞掉時建單整筆失敗)
--   ⑧ drop booking_assistants trigger → A5、B1、B4、B6、B17、C10、D1、D5 共 8 條轉紅
--   本檔 E 段是「永遠留在測試裡」的故障注入(savepoint 內注入、量測、還原)。
begin;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
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
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

select plan(70);

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

-- 這份檔案發出的所有訊號(reset 前先複製一份,最後做整體資安掃描)
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
end;
$$;

create function pg_temp.items(p_item uuid, p_price numeric default 800)
returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('service_item_id', p_item, 'quantity', 1, 'unit_price', p_price));
$$;

-- 一店建單(管理員身分呼叫前要先 test_set_auth)
create function pg_temp.mk(p_staff uuid, p_start timestamptz, p_assistants uuid[] default '{}',
                           p_phone text default '0955087400')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'e8740000-0000-4000-8000-000000000021',
    p_staff_id => p_staff,
    p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000031'),
    p_start_at => p_start,
    p_customer_name => '即時同步客戶',
    p_customer_phone => p_phone,
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => 'e8740000-0000-4000-8000-000000000061');
$$;

-- 一店改單(只換助手 / 備註;其餘維持)
create function pg_temp.upd(p_booking uuid, p_assistants uuid[], p_notes text default null)
returns uuid language sql as $$
  select id from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => (select staff_id from public.bookings where id = p_booking),
    p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000031'),
    p_start_at => (select start_at from public.bookings where id = p_booking),
    p_customer_name => (select customer_name from public.bookings where id = p_booking),
    p_customer_phone => (select customer_phone from public.bookings where id = p_booking),
    p_notes => p_notes,
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => 'e8740000-0000-4000-8000-000000000061');
$$;

-- 直接碰一下訂單列(postgres 身分;用來量測發送端過濾,不受 RPC 的服務人員在職檢查影響)
create function pg_temp.touch(p_booking uuid)
returns void language sql as $$
  update public.bookings set notes = notes where id = p_booking;
$$;

-- =========================================================================
-- Fixture
--   集團一:一店(主要測試店)、二店(只給 transfer_members_to_merchant 當目標);管理員甲管兩間
--   集團二:三店(別人家),管理員丙
--   一店服務人員:S1 / S2 / S3 已開通登入 + 權限種好(行事曆檢視開)
--                S4 尚未邀請(沒有帳號、沒有權限紀錄)
--                S5 已開通登入,但行事曆檢視 granted = false
--   三店服務人員:S9 已開通登入 + 權限種好
-- =========================================================================
insert into auth.users (id, email) values
  ('e8740000-0000-4000-8000-000000000001', 'pgtap-req874-admin1@test.local'),
  ('e8740000-0000-4000-8000-000000000002', 'pgtap-req874-admin3@test.local'),
  ('e8740000-0000-4000-8000-000000000003', 'pgtap-req874-s1@test.local'),
  ('e8740000-0000-4000-8000-000000000004', 'pgtap-req874-s2@test.local'),
  ('e8740000-0000-4000-8000-000000000005', 'pgtap-req874-s3@test.local'),
  ('e8740000-0000-4000-8000-000000000006', 'pgtap-req874-s5@test.local'),
  ('e8740000-0000-4000-8000-000000000007', 'pgtap-req874-s9@test.local');

insert into groups (id) values
  ('e8740000-0000-4000-8000-000000000011'),
  ('e8740000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000011', '即時同步測試一店', 'in_store_beauty'),
  ('e8740000-0000-4000-8000-000000000022', 'e8740000-0000-4000-8000-000000000011', '即時同步測試二店', 'in_store_beauty'),
  ('e8740000-0000-4000-8000-000000000023', 'e8740000-0000-4000-8000-000000000012', '即時同步測試別家店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000001', '管理員甲'),
  ('e8740000-0000-4000-8000-000000000022', 'e8740000-0000-4000-8000-000000000001', '管理員甲'),
  ('e8740000-0000-4000-8000-000000000023', 'e8740000-0000-4000-8000-000000000002', '管理員丙');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from unnest(array['e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000023']::uuid[]) as m,
     generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e8740000-0000-4000-8000-000000000031', 'e8740000-0000-4000-8000-000000000021', '剪髮', 800, 'primary', 60),
  ('e8740000-0000-4000-8000-000000000033', 'e8740000-0000-4000-8000-000000000023', '剪髮', 800, 'primary', 60);

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone, no_time_slot_limit) values
  ('e8740000-0000-4000-8000-000000000041', 'e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000003', '服務人員一', 'active', 'active', '0900087441', true),
  ('e8740000-0000-4000-8000-000000000042', 'e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000004', '服務人員二', 'active', 'active', '0900087442', true),
  ('e8740000-0000-4000-8000-000000000043', 'e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000005', '服務人員三', 'active', 'active', '0900087443', true),
  ('e8740000-0000-4000-8000-000000000044', 'e8740000-0000-4000-8000-000000000021', null,                                   '服務人員四', 'active', 'not_invited', '0900087444', true),
  ('e8740000-0000-4000-8000-000000000045', 'e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000006', '服務人員五', 'active', 'active', '0900087445', true),
  ('e8740000-0000-4000-8000-000000000049', 'e8740000-0000-4000-8000-000000000023', 'e8740000-0000-4000-8000-000000000007', '別家服務人員', 'active', 'active', '0900087449', true);

select seed_default_staff_permissions(s) from unnest(array[
  'e8740000-0000-4000-8000-000000000041', 'e8740000-0000-4000-8000-000000000042',
  'e8740000-0000-4000-8000-000000000043', 'e8740000-0000-4000-8000-000000000045',
  'e8740000-0000-4000-8000-000000000049']::uuid[]) as s;
update merchant_staff_permissions set granted = false
where staff_id = 'e8740000-0000-4000-8000-000000000045' and section_key = 'staff_calendar_view';

insert into payment_methods (id, merchant_id, name) values
  ('e8740000-0000-4000-8000-000000000061', 'e8740000-0000-4000-8000-000000000021', '現場付款'),
  ('e8740000-0000-4000-8000-000000000062', 'e8740000-0000-4000-8000-000000000021', '轉帳'),
  ('e8740000-0000-4000-8000-000000000063', 'e8740000-0000-4000-8000-000000000023', '現場付款');

-- 紅利:100 點 = 10 元、單次最多 50%
insert into merchant_member_settings (merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
                                      redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent)
values ('e8740000-0000-4000-8000-000000000021', 'basic', 10, 500, 100, 10, 50);

insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('e8740000-0000-4000-8000-000000000071', 'e8740000-0000-4000-8000-000000000021', '搬遷會員', '0913087471', 'R874A071', 0, 'active'),
  ('e8740000-0000-4000-8000-000000000072', 'e8740000-0000-4000-8000-000000000021', '折抵會員', '0913087472', 'R874A072', 1000, 'active');

-- =========================================================================
-- P. 前置(環境正向對照)
-- =========================================================================
select ok(
  exists (select 1 from pg_inherits i join pg_class c on c.oid = i.inhrelid
          where i.inhparent = 'realtime.messages'::regclass
            and c.relname = 'messages_' || to_char(now()::timestamp, 'YYYY_MM_DD')),
  'P1 前置:realtime.messages 今天的分區存在(不存在 = 本機 Realtime 容器沒在跑,先 supabase start;否則下面全部會是 0 則)'
);

-- #977 第 7 批(2026-10-07,QA 回報):原本這條數 sig_total()(整張表所有 staff:%:schedule 的列),
-- 本機共用容器裡其他測試 / e2e 殘留的訊號列會讓它變成 2、3… ⇒ 跟這支測試無關的紅燈。
-- 改成只數「這一次 probe 自己寫的那一列」(固定的 probe topic + event + payload),斷言意義不變:
-- 以 postgres 身分直接呼叫 realtime.send,真的會寫一列進 realtime.messages。
select realtime.send(jsonb_build_object('probe', 1), 'probe', 'staff:00000000-0000-4000-8000-000000000000:schedule', true);
select is(
  (select count(*)::int from realtime.messages
   where topic = 'staff:00000000-0000-4000-8000-000000000000:schedule'
     and event = 'probe' and payload ->> 'probe' = '1'),
  1,
  'P2 前置(正向對照):以 postgres 身分直接呼叫 realtime.send 會真的寫一列進 realtime.messages');
select pg_temp.reset_sig();
delete from sig_log;

-- =========================================================================
-- A. 權限衛生與結構
-- =========================================================================
select ok(
  not has_function_privilege('public', 'private.notify_staff_schedule_changed(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.notify_staff_schedule_changed(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.notify_staff_schedule_changed(uuid)', 'execute'),
  'A1 🔴 #885 權限衛生:notify_staff_schedule_changed 對 PUBLIC / anon / authenticated 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('public', 'private.tg_bookings_notify_staff_schedule()', 'execute')
  and not has_function_privilege('anon', 'private.tg_bookings_notify_staff_schedule()', 'execute')
  and not has_function_privilege('authenticated', 'private.tg_bookings_notify_staff_schedule()', 'execute'),
  'A2 #887 權限衛生:tg_bookings_notify_staff_schedule 對三個角色都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('public', 'private.tg_booking_assistants_notify_staff_schedule()', 'execute')
  and not has_function_privilege('anon', 'private.tg_booking_assistants_notify_staff_schedule()', 'execute')
  and not has_function_privilege('authenticated', 'private.tg_booking_assistants_notify_staff_schedule()', 'execute'),
  'A3 #888 權限衛生:tg_booking_assistants_notify_staff_schedule 對三個角色都沒有 EXECUTE'
);
select is(
  (select array_agg(p.proname::text || ':' || n.nspname || ':' || p.prosecdef::text || ':' || pg_get_userbyid(p.proowner) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in ('notify_staff_schedule_changed', 'tg_bookings_notify_staff_schedule', 'tg_booking_assistants_notify_staff_schedule')),
  array['notify_staff_schedule_changed:private:true:postgres',
        'tg_booking_assistants_notify_staff_schedule:private:true:postgres',
        'tg_bookings_notify_staff_schedule:private:true:postgres'],
  'A4:三支函式都只存在 private schema、SECURITY DEFINER、owner postgres(沒有任何 public 版本 ⇒ PostgREST 不會多出端點)'
);
-- tgtype:ROW(1) + INSERT(4) + DELETE(8) + UPDATE(16) = 29;BEFORE 位元(2)沒設 = AFTER
select is(
  (select array_agg(tgrelid::regclass::text || ':' || tgname || ':' || tgtype::text || ':' || tgenabled::text order by tgname)
   from pg_trigger where tgname in ('bookings_notify_staff_schedule', 'booking_assistants_notify_staff_schedule')),
  array['booking_assistants:booking_assistants_notify_staff_schedule:29:O',
        'bookings:bookings_notify_staff_schedule:29:O'],
  'A5:兩個 trigger 都是 AFTER、FOR EACH ROW、INSERT/UPDATE/DELETE、啟用中'
);
select ok(
  not exists (select 1 from pg_proc where proname in ('notify_staff_schedule_changed', 'tg_bookings_notify_staff_schedule',
                                                      'tg_booking_assistants_notify_staff_schedule')
              and prosrc ilike '%broadcast_changes%'),
  'A6 🔴 #886:沒有任何一支用 realtime.broadcast_changes(它會把整列訂單送出去)'
);

-- =========================================================================
-- B. 每一條會改訂單的路徑都會發訊號
-- =========================================================================
-- B1 create_booking 帶助手
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000041', '2026-12-01 10:00:00+08',
                  array['e8740000-0000-4000-8000-000000000042']::uuid[], '0955087401') as id \gset bk1_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042'),
                pg_temp.sig('e8740000-0000-4000-8000-000000000043')],
  array[1, 1, 0],
  'B1 create_booking(帶助手):主要服務人員 1 則、助手 1 則、不相關的人 0 則');

-- B2 confirm_booking
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select confirm_booking(:'bk1_id'::uuid);
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[1, 1],
  'B2 confirm_booking:主要服務人員 1 則;助手也 1 則(狀態色塊助手畫面也要變)');

-- B3 update_booking(助手不變,改備註)= 去重:助手被「全刪再全插」仍只 1 則
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.upd(:'bk1_id'::uuid, array['e8740000-0000-4000-8000-000000000042']::uuid[], '改個備註');
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[1, 1],
  'B3 🔴 #885 交易內去重:update_booking(助手不變)後,主要服務人員與助手在這筆交易各只有 1 則(助手列被刪 1 次又插 1 次、訂單列 UPDATE 1 次)');

-- B4 update_booking 換助手:移除 S2、加入 S3
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.upd(:'bk1_id'::uuid, array['e8740000-0000-4000-8000-000000000043']::uuid[]);
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000042'), pg_temp.sig('e8740000-0000-4000-8000-000000000043')],
  array[1, 1],
  'B4 🔴 #888 納編:update_booking 移除助手 S2 → S2 收到 1 則(那格要消失);新加的 S3 收到 1 則(那格要出現)');

-- B5 move_booking mode=time(主要服務人員拖時間)
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select move_booking(:'bk1_id'::uuid, 'e8740000-0000-4000-8000-000000000041', 'e8740000-0000-4000-8000-000000000041',
  '2026-12-01 13:00:00+08', '2026-12-01 10:00:00+08', 'e8740000-0000-4000-8000-000000000041') \gset mv_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000043'),
                pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[1, 1, 0],
  'B5 move_booking(time):主要服務人員 1 則、目前的助手 S3 也 1 則(他那格也跟著移動);已被移除的 S2 0 則');

-- B6 move_booking mode=reassign_assistant(拖助手 S3 → S2,純 UPDATE staff_id)
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select move_booking(:'bk1_id'::uuid, 'e8740000-0000-4000-8000-000000000043', 'e8740000-0000-4000-8000-000000000042',
  '2026-12-01 13:00:00+08', '2026-12-01 13:00:00+08', 'e8740000-0000-4000-8000-000000000041') \gset mv_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000043'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[1, 1],
  'B6 🔴 #888 納編轉派:move_booking(reassign_assistant)→ 舊助手 S3、新助手 S2 各 1 則');
select is((select array_agg(staff_id::text) from booking_assistants where booking_id = :'bk1_id'::uuid),
  array['e8740000-0000-4000-8000-000000000042'],
  'B6 對照:助手真的從 S3 換成 S2(證明上面那條確實走到 reassign_assistant)');

-- B7 move_booking mode=reassign_main(另一張沒有助手的單:S1 → S2)
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000041', '2026-12-02 10:00:00+08', '{}', '0955087402') as id \gset bk2_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select move_booking(:'bk2_id'::uuid, 'e8740000-0000-4000-8000-000000000041', 'e8740000-0000-4000-8000-000000000042',
  '2026-12-02 10:00:00+08', '2026-12-02 10:00:00+08', 'e8740000-0000-4000-8000-000000000041') \gset mv_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[1, 1],
  'B7 🔴 move_booking(reassign_main)轉派:舊主要服務人員 S1(那格要消失)與新主要服務人員 S2(那格要出現)各 1 則');

-- B8 update_booking_payment_method
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from update_booking_payment_method(:'bk1_id'::uuid, 'e8740000-0000-4000-8000-000000000062') \gset pm_
select pg_temp.test_clear_auth();
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 1,
  'B8 update_booking_payment_method(目前沒有前端呼叫,但是真實可用的路徑):主要服務人員 1 則');

-- B9 complete_booking
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from complete_booking(:'bk1_id'::uuid) \gset cp_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[1, 1],
  'B9 complete_booking:主要服務人員與助手各 1 則');

-- B10 #844 還原完成(revert_completed_booking → private.reverse_booking_completion)
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select revert_completed_booking(:'bk1_id'::uuid, '誤按完成');
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')]::text[]
    || (select status from bookings where id = :'bk1_id'::uuid),
  array['1', '1', 'accepted'],
  'B10 🆕 #844 還原完成:訂單真的回到 accepted,主要服務人員與助手各 1 則');

-- B11 #844 取消已完成(cancel_completed_booking → private.reverse_booking_completion)
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from complete_booking(:'bk1_id'::uuid) \gset cp_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select cancel_completed_booking(:'bk1_id'::uuid, '客戶退單');
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')]::text[]
    || (select status from bookings where id = :'bk1_id'::uuid),
  array['1', '1', 'cancelled'],
  'B11 🆕 #844 取消已完成:訂單真的變 cancelled,主要服務人員與助手各 1 則(那格要消失)');

-- B12 cancel_booking(一般取消,帶助手)
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000041', '2026-12-03 10:00:00+08',
                  array['e8740000-0000-4000-8000-000000000043']::uuid[], '0955087403') as id \gset bk3_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from cancel_booking(:'bk3_id'::uuid, '客戶改期') \gset cc_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000043')],
  array[1, 1],
  'B12 🔴 cancel_booking:主要服務人員 1 則、納編的助手也 1 則(取消是 UPDATE,不碰助手列 —— 助手那格一樣要消失)');

-- B13 紅利折抵退回:cancel_booking 內部呼叫 private.refund_booking_redeem(同一筆交易,去重後 1 則)
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'e8740000-0000-4000-8000-000000000021',
  p_staff_id => 'e8740000-0000-4000-8000-000000000041',
  p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000031', 1000),
  p_start_at => '2026-12-04 10:00:00+08',
  p_customer_name => '折抵會員', p_customer_phone => '0913087472',
  p_payment_method_id => 'e8740000-0000-4000-8000-000000000061',
  p_member_id => 'e8740000-0000-4000-8000-000000000072',
  p_points_redeemed => 100,
  p_points_redeem_member_id => 'e8740000-0000-4000-8000-000000000072') \gset bk4_
select id from create_booking(
  p_merchant_id => 'e8740000-0000-4000-8000-000000000021',
  p_staff_id => 'e8740000-0000-4000-8000-000000000041',
  p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000031', 1000),
  p_start_at => '2026-12-04 13:00:00+08',
  p_customer_name => '折抵會員', p_customer_phone => '0913087472',
  p_payment_method_id => 'e8740000-0000-4000-8000-000000000061',
  p_member_id => 'e8740000-0000-4000-8000-000000000072',
  p_points_redeemed => 100,
  p_points_redeem_member_id => 'e8740000-0000-4000-8000-000000000072') \gset bk5_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from cancel_booking(:'bk4_id'::uuid) \gset cc_
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'),
        (select points_redeemed from bookings where id = :'bk4_id'::uuid),
        (select points_balance from members where id = 'e8740000-0000-4000-8000-000000000072')],
  array[1, 0, 900],
  'B13 🆕 紅利:取消有折抵的單 → 折抵真的退回(本單 0 點、會員餘額 1000-100-100+100=900),主要服務人員在這筆交易只 1 則(取消 + 退回兩次 UPDATE 去重)');

-- B14 private.refund_booking_redeem 本身也會發(直接以 owner 身分呼叫,模擬 update_booking 換會員時的退回)
select pg_temp.reset_sig();
select is(
  array[private.refund_booking_redeem(:'bk5_id'::uuid), pg_temp.sig('e8740000-0000-4000-8000-000000000041')],
  array[100, 1],
  'B14 🆕 private.refund_booking_redeem 單獨執行:退回 100 點,主要服務人員 1 則');

-- B15 import_historical_bookings_batch(迴圈插 5 筆:S1 三筆、S2 兩筆)= 去重
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select import_historical_bookings_batch(
  'e8740000-0000-4000-8000-000000000021',
  (select jsonb_agg(jsonb_build_object(
     'row_number', g, 'customer_name', '匯入客戶' || g, 'customer_phone', '09220874' || lpad(g::text, 2, '0'),
     'staff_id', case when g <= 3 then 'e8740000-0000-4000-8000-000000000041' else 'e8740000-0000-4000-8000-000000000042' end,
     'start_at', '2026-11-0' || g || 'T10:00:00+08:00', 'duration_minutes', 30, 'status', '已完成', 'final_amount', 800))
   from generate_series(1, 5) as g)
) as op \gset imp_
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042'),
        (select success_rows from merchant_bulk_operations where id = :'imp_op'::uuid)],
  array[1, 1, 5],
  'B15 🔴 #885 去重:import_historical_bookings_batch 一次匯入 5 筆(S1 三筆、S2 兩筆)→ S1、S2 各只 1 則');

-- B16 rollback_bulk_operation(全庫唯一真的 delete from bookings)
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select rollback_bulk_operation(:'imp_op'::uuid) as r \gset rb_
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig('e8740000-0000-4000-8000-000000000041'), pg_temp.sig('e8740000-0000-4000-8000-000000000042'),
        (select count(*)::int from bookings where merchant_id = 'e8740000-0000-4000-8000-000000000021' and source = 'import')],
  array[1, 1, 0],
  'B16 rollback_bulk_operation:5 筆匯入單真的被刪掉,S1、S2 各 1 則(DELETE 分支)');

-- B17 刪除整筆訂單 → ON DELETE CASCADE 刪助手列也觸發 row trigger
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000042', '2026-12-05 10:00:00+08',
                  array['e8740000-0000-4000-8000-000000000043']::uuid[], '0955087405') as id \gset bk6_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
delete from bookings where id = :'bk6_id'::uuid;
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000042'), pg_temp.sig('e8740000-0000-4000-8000-000000000043')],
  array[1, 1],
  'B17 🔴 #888:刪除整筆訂單 → 主要服務人員 1 則;助手列被 ON DELETE CASCADE 刪掉,助手也 1 則');

-- B18 transfer_members_to_merchant(把引用會員的訂單 member_id 設 null)
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'e8740000-0000-4000-8000-000000000021',
  p_staff_id => 'e8740000-0000-4000-8000-000000000043',
  p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000031'),
  p_start_at => '2026-12-06 10:00:00+08',
  p_customer_name => '搬遷會員', p_customer_phone => '0913087471',
  p_payment_method_id => 'e8740000-0000-4000-8000-000000000061',
  p_member_id => 'e8740000-0000-4000-8000-000000000071') \gset bk7_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select transfer_members_to_merchant('e8740000-0000-4000-8000-000000000021', 'e8740000-0000-4000-8000-000000000022',
  array['e8740000-0000-4000-8000-000000000071']::uuid[]) as op \gset tr_
select pg_temp.test_clear_auth();
select is(
  array[pg_temp.sig('e8740000-0000-4000-8000-000000000043')]::text[]
    || coalesce((select member_id::text from bookings where id = :'bk7_id'::uuid), 'null'),
  array['1', 'null'],
  'B18 transfer_members_to_merchant:訂單的 member_id 真的被清成 null,主要服務人員 1 則');

-- B19 一般 update_booking(不帶助手的單改備註)
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000041', '2026-12-07 10:00:00+08', '{}', '0955087407') as id \gset bk8_
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.upd(:'bk8_id'::uuid, '{}', '只改備註');
select pg_temp.test_clear_auth();
select is(pg_temp.sig_total(), 1,
  'B19 update_booking(沒有助手):整筆交易只有 1 則(只發給主要服務人員,沒有誤發給其他人)');

-- =========================================================================
-- C. 發送端過濾(#885 v1.1,與 #876 一致)
-- =========================================================================
-- C1 尚未邀請的服務人員:#876 helper 對他預設放行(LINE 語意),但本批次另外要求已開通登入 ⇒ 0 則
select ok(private.staff_calendar_view_allows_notifications('e8740000-0000-4000-8000-000000000044'),
  'C1 前提:#876 helper 對「尚未邀請登入」的 S4 回 true(所以 notify 必須另外檢查 login_status,下一條才有意義)');
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000044', '2026-12-08 10:00:00+08', '{}', '0955087408') as id \gset bk9_
select pg_temp.test_clear_auth();
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000044'), 0,
  'C2 發送端過濾:尚未邀請登入的服務人員(永遠不可能訂閱)不發');

-- C3 行事曆檢視 granted = false 的 S5 當主要服務人員
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000045', '2026-12-09 10:00:00+08', '{}', '0955087409') as id \gset bk10_
select pg_temp.test_clear_auth();
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000045'), 0,
  'C3 發送端過濾:行事曆檢視關閉(granted = false)的服務人員不發');

-- C4 管理員用 set_staff_permission 關掉 S1 的行事曆檢視 → 碰 S1 的單 → 0;再打開 → 1
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select set_staff_permission('e8740000-0000-4000-8000-000000000041', 'staff_calendar_view', false);
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.touch(:'bk8_id'::uuid);
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 0,
  'C4 🔴 管理員中途關掉 S1 的行事曆檢視(set_staff_permission)→ 從下一筆變動起 S1 就收不到(補 #903 的缺口)');

select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select set_staff_permission('e8740000-0000-4000-8000-000000000041', 'staff_calendar_view', true);
select pg_temp.test_clear_auth();
select pg_temp.reset_sig();
select pg_temp.touch(:'bk8_id'::uuid);
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 1,
  'C5 正向對照:重新打開後同一張單的變動 → 1 則');

-- C6 已開通登入、但行事曆檢視紀錄遺失 → 0(與 get_my_booking_schedule 同標準)
delete from merchant_staff_permissions
where staff_id = 'e8740000-0000-4000-8000-000000000041' and section_key = 'staff_calendar_view';
select pg_temp.reset_sig();
select pg_temp.touch(:'bk8_id'::uuid);
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 0,
  'C6 發送端過濾:已開通登入但沒有行事曆檢視紀錄 → 不發(紀錄遺失 = 看不到行事曆 = 也不發)');
insert into merchant_staff_permissions (staff_id, section_key, granted)
values ('e8740000-0000-4000-8000-000000000041', 'staff_calendar_view', true);

-- C7 login_status = 'invited'(已寄邀請、還沒完成登入)→ 0
update merchant_staff set login_status = 'invited' where id = 'e8740000-0000-4000-8000-000000000041';
select pg_temp.reset_sig();
select pg_temp.touch(:'bk8_id'::uuid);
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 0,
  'C7 發送端過濾:login_status = invited(還沒完成登入)→ 不發');
update merchant_staff set login_status = 'active' where id = 'e8740000-0000-4000-8000-000000000041';

-- C8 status = 'removed'(被停用)→ 0
update merchant_staff set status = 'removed' where id = 'e8740000-0000-4000-8000-000000000041';
select pg_temp.reset_sig();
select pg_temp.touch(:'bk8_id'::uuid);
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 0,
  'C8 發送端過濾:服務人員被停用(status = removed)→ 不發');
update merchant_staff set status = 'active' where id = 'e8740000-0000-4000-8000-000000000041';

select pg_temp.reset_sig();
select pg_temp.touch(:'bk8_id'::uuid);
select is(pg_temp.sig('e8740000-0000-4000-8000-000000000041'), 1,
  'C9 正向對照:全部恢復(在職 + 已開通登入 + 行事曆檢視開)→ 1 則');

-- C10 被過濾掉的人也會記進去重記號 ⇒ 同一筆交易裡不會反覆查;但「別人」照常發
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.mk('e8740000-0000-4000-8000-000000000045', '2026-12-10 10:00:00+08',
                  array['e8740000-0000-4000-8000-000000000042']::uuid[], '0955087410') as id \gset bk11_
select pg_temp.test_clear_auth();
select is(array[pg_temp.sig('e8740000-0000-4000-8000-000000000045'), pg_temp.sig('e8740000-0000-4000-8000-000000000042')],
  array[0, 1],
  'C10 同一張單:主要服務人員 S5(行事曆檢視關)0 則、助手 S2(開著)1 則 —— 過濾是逐人判斷');

-- =========================================================================
-- D. 🔴 資安:payload 原文不含任何內容(#886)、其他商家收不到
-- =========================================================================
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'e8740000-0000-4000-8000-000000000021',
  p_staff_id => 'e8740000-0000-4000-8000-000000000041',
  p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000031', 4321),
  p_start_at => '2026-12-11 10:00:00+08',
  p_customer_name => '機密客戶王小明',
  p_customer_phone => '0987654321',
  p_customer_email => 'secret874@example.com',
  p_notes => '內部備註XYZ機密',
  p_assistant_staff_ids => array['e8740000-0000-4000-8000-000000000042']::uuid[],
  p_customer_address => '台北市秘密路99號',
  p_customer_notes => '客戶備註ABC私密',
  p_payment_method_id => 'e8740000-0000-4000-8000-000000000061',
  p_hide_notes_from_staff => true) \gset sec_
select pg_temp.test_clear_auth();

select is(pg_temp.sig_total(), 2, 'D1 前提:帶敏感資料的單建好後,主要服務人員 + 助手共 2 則(下面掃的不是空集合)');
select ok(
  not exists (
    select 1 from realtime.messages m,
      unnest(array['機密客戶王小明', '0987654321', 'secret874@example.com', '內部備註XYZ機密', '台北市秘密路99號',
                   '客戶備註ABC私密', :'sec_id', '2026-12', 'e8740000-0000-4000-8000-000000000041',
                   'e8740000-0000-4000-8000-000000000021']) as s
    where m.topic like 'staff:%:schedule' and (m.payload - 'id')::text like '%' || s || '%'),
  'D2 🔴 #886 資安核心:payload 整包原文搜不到客戶姓名 / 電話 / Email / 內部備註 / 地址 / 客戶備註 / 金額 / booking_id / 日期 / staff_id / merchant_id'
);
select is(
  (select array_agg(distinct k order by k) from realtime.messages m, jsonb_object_keys(m.payload) k
   where m.topic like 'staff:%:schedule'),
  array['id', 'reason', 'v'],
  'D3 🔴 #886:payload 的 key 集合逐字等於 {id, reason, v}'
);
select is(
  (select array_agg(distinct (payload->>'v') || '|' || (payload->>'reason') || '|' || event || '|' || extension || '|' || private::text)
   from realtime.messages where topic like 'staff:%:schedule'),
  array['1|schedule_changed|schedule_changed|broadcast|true'],
  'D4:v = 1、reason = schedule_changed、事件名 schedule_changed、broadcast、private = true(#889 / 〇.10 第 2 點)'
);
select is(
  (select array_agg(topic order by topic) from realtime.messages where topic like 'staff:%:schedule'),
  array['staff:e8740000-0000-4000-8000-000000000041:schedule', 'staff:e8740000-0000-4000-8000-000000000042:schedule'],
  'D5 #889:頻道名逐字是 staff:<merchant_staff.id 小寫>:schedule'
);

-- D6 整份檔案到目前為止(一店的所有操作)發出的所有訊號:別家店 S9 一則都沒有、整體再掃一次資安
select pg_temp.reset_sig();
select is(
  (select count(*)::int from sig_log where topic = 'staff:e8740000-0000-4000-8000-000000000049:schedule'),
  0,
  'D6 🔴 多租戶隔離:一店上面 B / C / D 段的所有操作,別家店的服務人員 S9 一則都沒收到'
);
select ok(
  (select count(*) from sig_log) >= 30
  and not exists (select 1 from sig_log where (payload - 'id')::text ~ '(customer|notes|address|phone|email|amount|booking|staff|merchant|機密|秘密|私密|2026)')
  and not exists (select 1 from sig_log l where (select array_agg(k order by k) from jsonb_object_keys(l.payload) k) <> array['id', 'reason', 'v'])
  and not exists (select 1 from sig_log where topic !~ '^staff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:schedule$'),
  'D7 🔴 整份檔案發出的每一則訊號(30 則以上):payload 都只有 {id, reason, v}、沒有任何業務欄位名或內容、頻道名格式全部正確'
);

-- D8 別家店建單:只有別家店的服務人員收到
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000002');
select id from create_booking(
  p_merchant_id => 'e8740000-0000-4000-8000-000000000023',
  p_staff_id => 'e8740000-0000-4000-8000-000000000049',
  p_service_items => pg_temp.items('e8740000-0000-4000-8000-000000000033'),
  p_start_at => '2026-12-01 10:00:00+08',
  p_customer_name => '別家客戶', p_customer_phone => '0955087499',
  p_payment_method_id => 'e8740000-0000-4000-8000-000000000063') \gset other_
select pg_temp.test_clear_auth();
select is(
  (select array_agg(topic) from realtime.messages where topic like 'staff:%:schedule'),
  array['staff:e8740000-0000-4000-8000-000000000049:schedule'],
  'D8 多租戶隔離:別家店建單 → 只有別家店的服務人員 S9 收到,一店任何人都沒有'
);

-- =========================================================================
-- E. 故障注入:訊號失敗絕不能擋住建單(〇.4 / #902)
-- =========================================================================
select ok(
  (select prosrc ~* 'exception\s+when\s+others' from pg_proc where oid = 'realtime.send(jsonb,text,text,boolean)'::regprocedure),
  'E1 realtime.send 原文仍含 EXCEPTION WHEN OTHERS(它自己把送出失敗吞成 WARNING)'
);

-- E2 realtime.send 真的失敗:以服務人員 S1(authenticated)身分對 S2 的頻道直接呼叫 →
--    realtime.messages 沒有 INSERT 政策,寫入被 RLS 擋 → 被吞掉,不丟錯、也沒有寫進任何東西
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000003');
select lives_ok(
  $$select realtime.send('{"forged":true}'::jsonb, 'schedule_changed', 'staff:e8740000-0000-4000-8000-000000000042:schedule', true)$$,
  'E2 realtime.send 遇到真實失敗(RLS 擋下寫入)不丟錯'
);
select pg_temp.test_clear_auth();
select is(pg_temp.sig_total(), 0, 'E3 對照:上面那次確實沒有寫入(服務人員無法替別人偽造訊號;沒有 INSERT 政策)');

-- E4 發送端過濾的 helper 壞掉(模擬 #876 函式被改壞)→ 建單照樣成功、只是不發
--    在 savepoint 內注入,量測結果先存進 psql 變數,rollback to savepoint 還原後才斷言
--    (pgTAP 的斷言紀錄也在交易裡,不能在 savepoint 裡斷言)
create function pg_temp.try_mk(p_start timestamptz, p_phone text)
returns text language plpgsql as $$
declare v uuid;
begin
  v := pg_temp.mk('e8740000-0000-4000-8000-000000000041', p_start, '{}', p_phone);
  return case when v is null then 'null' else 'ok' end;
exception when others then
  return 'error: ' || sqlerrm;
end;
$$;

select pg_temp.reset_sig();
savepoint fault_injection;
create or replace function private.staff_calendar_view_allows_notifications(p_staff_id uuid)
returns boolean language plpgsql stable security definer set search_path = public
as $$ begin raise exception 'fault injected by module14_07'; end; $$;
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.try_mk('2026-12-12 10:00:00+08', '0955087412') as result \gset fi_
select pg_temp.test_clear_auth();
select pg_temp.sig('e8740000-0000-4000-8000-000000000041') as sig,
       (select count(*) from bookings where customer_phone = '0955087412') as bookings \gset fi_
rollback to savepoint fault_injection;

select is(:'fi_result'::text, 'ok'::text, 'E4 🔴 故障注入:發送端過濾的 helper 直接丟錯 → create_booking 照樣成功(訊號是盡力而為)');
select is(array[:'fi_sig'::int, :'fi_bookings'::int], array[0, 1],
  'E5 故障注入對照:那筆單真的寫進去了(1 筆),只是沒發訊號(0 則)');

-- E6 正向對照:還原後同樣的建單 → 1 則(證明 E4 的 0 則是注入造成的,不是本來就不發)
select pg_temp.reset_sig();
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000001');
select pg_temp.try_mk('2026-12-12 10:00:00+08', '0955087412') as result \gset ctl_
select pg_temp.test_clear_auth();
select is(array[:'ctl_result', pg_temp.sig('e8740000-0000-4000-8000-000000000041')::text], array['ok', '1'],
  'E6 正向對照:helper 還原後同樣的建單 → 成功且 1 則');

select ok(
  (select prosrc not like '%fault injected%' from pg_proc
   where oid = 'private.staff_calendar_view_allows_notifications(uuid)'::regprocedure),
  'E7 rollback to savepoint 後 #876 helper 已還原成原版(本檔不會把注入留給後面的測試)'
);

-- =========================================================================
-- 批次 2:頻道授權端(migration 20261001110100_req874_staff_schedule_live_sync_authz.sql)
--   F 訂閱端 ↔ 發送端判定一致(#890 v1.1)
--   G #890 授權判定函式:權限衛生、各種輸入(含亂打的 topic 回 false 不丟錯)、各種身分
--   H #891 政策本身:只看得到「目前頻道」自己的 broadcast 列
--   I 🔴 #892 沒有 INSERT 政策:政策只有 1 條 SELECT、authenticated / anon 直接寫入被 RLS 擋、
--     public schema 沒有任何包裝 realtime.send 的函式
-- 🔴 realtime.send 會 SET LOCAL realtime.topic(整份檔案同一筆交易,前面送過訊號就殘留著)
--    ⇒ 每次量測政策前都自己 set_config('realtime.topic', …, true),量完清掉。
-- =========================================================================
insert into auth.users (id, email) values
  ('e8740000-0000-4000-8000-000000000008', 'pgtap-req874-plain-user@test.local');

-- 以某人身分呼叫授權函式(呼叫完一定還原身分;回傳 'true' / 'false' / 'null' / 'error: …')
create function pg_temp.can_listen_as(p_user uuid, p_topic text)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.test_set_auth(p_user);
  begin
    v := coalesce(private.can_listen_staff_schedule_topic(p_topic)::text, 'null');
  exception when others then
    v := 'error: ' || sqlerrm;
  end;
  perform pg_temp.test_clear_auth();
  return v;
end;
$$;

-- -------------------------------------------------------------------------
-- F. 訂閱端 ↔ 發送端判定一致:S3(user …05,B18 那張單 bk7 的主要服務人員)在六種狀態下,
--    「本人能不能訂」與「發送端有沒有發」逐一相同
-- -------------------------------------------------------------------------
create temp table consistency (step int, state text, can_listen text, sent boolean);

create function pg_temp.measure(p_step int, p_state text, p_booking uuid)
returns void language plpgsql as $$
begin
  perform pg_temp.reset_sig();
  perform pg_temp.touch(p_booking);
  insert into consistency values (p_step, p_state,
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000005', 'staff:e8740000-0000-4000-8000-000000000043:schedule'),
    pg_temp.sig('e8740000-0000-4000-8000-000000000043') > 0);
end;
$$;

select pg_temp.measure(1, '行事曆檢視開', :'bk7_id'::uuid);
update merchant_staff_permissions set granted = false
where staff_id = 'e8740000-0000-4000-8000-000000000043' and section_key = 'staff_calendar_view';
select pg_temp.measure(2, '行事曆檢視 granted = false', :'bk7_id'::uuid);
delete from merchant_staff_permissions
where staff_id = 'e8740000-0000-4000-8000-000000000043' and section_key = 'staff_calendar_view';
select pg_temp.measure(3, '行事曆檢視沒有紀錄', :'bk7_id'::uuid);
insert into merchant_staff_permissions (staff_id, section_key, granted)
values ('e8740000-0000-4000-8000-000000000043', 'staff_calendar_view', true);
update merchant_staff set login_status = 'invited' where id = 'e8740000-0000-4000-8000-000000000043';
select pg_temp.measure(4, 'login_status = invited', :'bk7_id'::uuid);
update merchant_staff set login_status = 'active', status = 'removed' where id = 'e8740000-0000-4000-8000-000000000043';
select pg_temp.measure(5, 'status = removed', :'bk7_id'::uuid);
update merchant_staff set status = 'active' where id = 'e8740000-0000-4000-8000-000000000043';
select pg_temp.measure(6, '全部恢復', :'bk7_id'::uuid);

select is(
  (select array_agg(can_listen order by step) from consistency),
  array['true', 'false', 'false', 'false', 'false', 'true'],
  'F1 #890 訂閱端:S3 本人在「開 / granted=false / 沒紀錄 / invited / removed / 恢復」六種狀態下能不能訂 = 開、關、關、關、關、開'
);
select is(
  (select array_agg(state order by step) from consistency where can_listen::boolean is distinct from sent),
  null::text[],
  'F2 🔴 #890 v1.1 訂閱端 ↔ 發送端判定一致:六種狀態逐一「能訂 ⇔ 有發」(列出不一致的狀態,應為空)'
);

-- -------------------------------------------------------------------------
-- G. #890 授權判定函式
-- -------------------------------------------------------------------------
select ok(
  has_function_privilege('authenticated', 'private.can_listen_staff_schedule_topic(text)', 'execute')
  and not has_function_privilege('anon', 'private.can_listen_staff_schedule_topic(text)', 'execute')
  and not has_function_privilege('public', 'private.can_listen_staff_schedule_topic(text)', 'execute'),
  'G1 權限衛生:can_listen_staff_schedule_topic 只有 authenticated 有 EXECUTE(RLS 運算式以查詢者身分執行),PUBLIC / anon 沒有'
);
select is(
  (select array_agg(n.nspname || ':' || p.prosecdef::text || ':' || p.provolatile::text || ':' || pg_get_userbyid(p.proowner))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'can_listen_staff_schedule_topic'),
  array['private:true:s:postgres'],
  'G2:只存在 private schema(PostgREST 不曝光)、SECURITY DEFINER、STABLE、owner postgres'
);
select is(
  array[
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000042:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000049:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000004', 'staff:e8740000-0000-4000-8000-000000000042:schedule')],
  array['true', 'false', 'false', 'true'],
  'G3 🔴 #890 IDOR:S1 訂自己 true;改 id 訂同店 S2 false、訂別家店 S9 false;S2 訂自己 true'
);
select is(
  array[
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000008', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000001', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000002', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000006', 'staff:e8740000-0000-4000-8000-000000000045:schedule'),
    pg_temp.can_listen_as(null, 'staff:e8740000-0000-4000-8000-000000000041:schedule')],
  array['false', 'false', 'false', 'false', 'false'],
  'G4:沒有服務人員身分的登入者(例如客戶)、該店商家管理員、別家店管理員訂 S1 都 false;S5(行事曆檢視關)訂自己 false;沒有 sub 的 JWT false'
);
select is(
  array[
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:not-a-uuid:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', null),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', ''),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:E8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041:schedule '),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', ' staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041:scheduleX'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e87400000000400080000000000000041:schedule'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041:presence'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041'),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041:schedule' || chr(10)),
    pg_temp.can_listen_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-00000000004g:schedule')],
  array['false', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false', 'false'],
  'G5 🔴 #890 亂打的頻道名一律乾淨回 false、不丟錯:not-a-uuid / null / 空字串 / 大寫 UUID(只認小寫)/ 前後空白 / 尾巴多字 / 少連字號 / 別的事件 / 少一段 / 結尾換行 / 非 16 進位字元'
);

-- -------------------------------------------------------------------------
-- H. #891 政策本身(Realtime 加入頻道時,就是以加入者身分 + realtime.topic = 頻道名來查這張表)
-- -------------------------------------------------------------------------
select pg_temp.reset_sig();
insert into realtime.messages (topic, extension, event, payload, private) values
  ('staff:e8740000-0000-4000-8000-000000000041:schedule', 'broadcast', 'schedule_changed', '{"t":"s1"}', true),
  ('staff:e8740000-0000-4000-8000-000000000041:schedule', 'presence',  'presence',         '{"t":"s1p"}', true),
  ('staff:e8740000-0000-4000-8000-000000000042:schedule', 'broadcast', 'schedule_changed', '{"t":"s2"}', true),
  ('staff:e8740000-0000-4000-8000-000000000049:schedule', 'broadcast', 'schedule_changed', '{"t":"s9"}', true);

create function pg_temp.visible_as(p_user uuid, p_topic text, p_role text default 'authenticated')
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.test_set_auth(p_user, p_role);
  perform set_config('realtime.topic', coalesce(p_topic, ''), true);
  select coalesce(string_agg(payload->>'t', ',' order by payload->>'t'), '(none)') into v
  from realtime.messages where topic like 'staff:%:schedule';
  perform pg_temp.test_clear_auth();
  perform set_config('realtime.topic', '', true);
  return v;
end;
$$;

select is(
  pg_temp.visible_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
  's1',
  'H1 🔴 #891:S1 在自己的頻道(realtime.topic = 自己)只看得到自己頻道的 broadcast 列 —— 看不到 S2 / 別家店的列,也看不到 presence'
);
select is(
  array[
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000042:schedule'),
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000003', 'staff:e8740000-0000-4000-8000-000000000049:schedule'),
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000003', null),
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000003', 'staff:not-a-uuid:schedule')],
  array['(none)', '(none)', '(none)', '(none)'],
  'H2 🔴 #891:S1 把 realtime.topic 設成 S2 / 別家店 / 沒設 / 亂打 → 一列都看不到(= 加入頻道被拒)'
);
select is(
  array[
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000008', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000001', 'staff:e8740000-0000-4000-8000-000000000041:schedule'),
    pg_temp.visible_as(null, 'staff:e8740000-0000-4000-8000-000000000041:schedule', 'anon'),
    pg_temp.visible_as('e8740000-0000-4000-8000-000000000006', 'staff:e8740000-0000-4000-8000-000000000045:schedule')],
  array['(none)', '(none)', '(none)', '(none)'],
  'H3:客戶 / 商家管理員 / 未登入(anon)在 S1 的頻道一列都看不到;S5(行事曆檢視關)在自己頻道也看不到'
);
select is(
  pg_temp.visible_as('e8740000-0000-4000-8000-000000000004', 'staff:e8740000-0000-4000-8000-000000000042:schedule'),
  's2',
  'H4 正向對照:S2 在自己的頻道看得到自己的列(證明 H2 / H3 的「看不到」是政策擋的,不是本來就沒資料)'
);
select pg_temp.reset_sig();

-- -------------------------------------------------------------------------
-- I. 🔴 #892 沒有任何寫入政策(收得到、發不出去)
-- -------------------------------------------------------------------------
select is(
  (select array_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ',') || ':' || permissive order by policyname)
   from pg_policies where schemaname = 'realtime' and tablename = 'messages'),
  -- SPECS-INDEX #1003(第 14 批)新增第二條 SELECT 政策 merchant_calendar_broadcast_receive(商家端行事曆頻道);
  -- 「沒有任何寫入政策」這條鐵律不變。
  array['merchant_calendar_broadcast_receive:SELECT:authenticated:PERMISSIVE',
        'staff_schedule_broadcast_receive:SELECT:authenticated:PERMISSIVE'],
  'I1 🔴 #892:realtime.messages 只有 SELECT 政策(服務人員班表 + #1003 商家行事曆)、只給 authenticated(沒有任何 INSERT / UPDATE / DELETE / ALL 政策)'
);
select ok(
  has_table_privilege('authenticated', 'realtime.messages', 'INSERT')
  and has_table_privilege('anon', 'realtime.messages', 'INSERT')
  and (select relrowsecurity and not relforcerowsecurity from pg_class where oid = 'realtime.messages'::regclass),
  'I2 前提(說明為什麼 I3~I5 重要):authenticated / anon 都有表層 INSERT 權限、RLS 有開 ⇒ RLS 政策是唯一那道牆'
);
select pg_temp.test_set_auth('e8740000-0000-4000-8000-000000000003');
select set_config('realtime.topic', 'staff:e8740000-0000-4000-8000-000000000041:schedule', true);
select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private)
    values ('staff:e8740000-0000-4000-8000-000000000041:schedule', 'broadcast', 'schedule_changed', '{"forged":true}', true)$$,
  '42501', null,
  'I3 🔴 #892:服務人員以 authenticated 身分直接寫入「自己」頻道的訊息(realtime.topic 也是自己)→ 被 RLS 擋(42501)'
);
select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private)
    values ('staff:e8740000-0000-4000-8000-000000000042:schedule', 'broadcast', 'schedule_changed', '{"forged":true}', true)$$,
  '42501', null,
  'I4 🔴 #892:服務人員對「別人」的頻道直接寫入 → 被 RLS 擋(42501)'
);
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth(null, 'anon');
select throws_ok(
  $$insert into realtime.messages (topic, extension, event, payload, private)
    values ('staff:e8740000-0000-4000-8000-000000000041:schedule', 'broadcast', 'schedule_changed', '{"forged":true}', true)$$,
  '42501', null,
  'I5 #892:未登入(anon)直接寫入 → 被 RLS 擋(42501)'
);
select pg_temp.test_clear_auth();
select set_config('realtime.topic', '', true);
select ok(
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and (p.prosrc ilike '%realtime.send%' or p.prosrc ilike '%realtime.messages%'
                     or p.prosrc ilike '%broadcast_changes%')),
  'I6 🔴 #892:public schema 沒有任何函式包裝 realtime.send / 寫 realtime.messages(否則等於開一個任意頻道發訊息的 RPC 端點)'
);

select * from finish();
rollback;
