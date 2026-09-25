-- 模組 15 擴充:站內通知中心(鈴鐺)— pgTAP
-- 對應規格書 .project/specs/手機推播擴及三種角色.md §十之二 的四列「核心必測」:
--   §13.2 user_notifications 的 RLS(只看得到自己的;看不到同商家別人的;
--         authenticated 的 INSERT/UPDATE/DELETE **權限**已被 revoke —— 不是靠政策擋而是靠 GRANT 收掉)
--   §13.2 不開 UPDATE 政策 ⇒ 使用者**無法**用 update 竄改 title
--   §13.8 mark_my_notifications_read(只改得到自己的;帶別人的 id 進去回 0 且資料沒變;
--         p_ids = null 全部標完;**只寫 read_at,其他欄位一字不變**;anon 被擋下)
--   §13.9 prune_user_notifications(31 天前刪、29 天前留;第 501 列之後刪、最新 500 留;
--         authenticated 呼叫被擋下 42501)
-- 另外補上 §13.2 的 CHECK(拒絕 'test')、auth.users 級聯、booking 硬刪除後 booking_id 變 null。
begin;

select plan(51);

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

-- =========================================================================
-- Fixture:一間商家 A,裡面有管理員甲、客服乙。
--   甲有 3 則通知(2 未讀 + 1 已讀);乙有 1 則未讀。
--   另外兩個「只有通知、沒有任何角色列」的帳號丙/丁,專門給級聯與清理測試用
--   (刻意不用甲/乙 —— 他們身上掛著 merchant_admins/merchant_agents,刪帳號會被別的 FK 絆住,
--    那不是這支測試要驗的東西)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ee500000-0000-4000-8000-000000000001', 'pgtap-m15c-admin@test.local'),
  ('ee500000-0000-4000-8000-000000000002', 'pgtap-m15c-agent@test.local'),
  ('ee500000-0000-4000-8000-000000000003', 'pgtap-m15c-cascade@test.local'),
  ('ee500000-0000-4000-8000-000000000004', 'pgtap-m15c-prune-overflow@test.local'),
  ('ee500000-0000-4000-8000-000000000005', 'pgtap-m15c-prune-expiry@test.local');

insert into groups (id) values ('ee500000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('ee500000-0000-4000-8000-000000000021', 'ee500000-0000-4000-8000-000000000011', '鈴鐺測試A店', 'in_store_beauty');

insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('ee500000-0000-4000-8000-000000000031', 'ee500000-0000-4000-8000-000000000021', 'ee500000-0000-4000-8000-000000000001', '老闆甲');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ee500000-0000-4000-8000-000000000041', 'ee500000-0000-4000-8000-000000000021', 'ee500000-0000-4000-8000-000000000002', '客服乙', 'pgtap-m15c-agent@test.local', 'active', now(), '0900000401');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone) values
  ('ee500000-0000-4000-8000-000000000051', 'ee500000-0000-4000-8000-000000000021', null, '服務人員丙', 'active', 'invited', '0900000501');

-- 一筆訂單,給「硬刪除之後 booking_id 變 null」那一條用。
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, created_by_role) values
  ('ee500000-0000-4000-8000-000000000061', 'ee500000-0000-4000-8000-000000000021',
   'ee500000-0000-4000-8000-000000000051', now() + interval '1 day', now() + interval '1 day 1 hour',
   '測試客戶', '0912345678', 'admin');

insert into user_notifications (id, user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body, read_at) values
  ('ee500000-0000-4000-8000-000000000101', 'ee500000-0000-4000-8000-000000000001',
   'ee500000-0000-4000-8000-000000000021', 'admin', 'ee500000-0000-4000-8000-000000000031',
   'booking_created', 'ee500000-0000-4000-8000-000000000061', '甲的通知一', '內容一', null),
  ('ee500000-0000-4000-8000-000000000102', 'ee500000-0000-4000-8000-000000000001',
   'ee500000-0000-4000-8000-000000000021', 'admin', 'ee500000-0000-4000-8000-000000000031',
   'booking_cancelled', null, '甲的通知二', '內容二', null),
  ('ee500000-0000-4000-8000-000000000103', 'ee500000-0000-4000-8000-000000000001',
   'ee500000-0000-4000-8000-000000000021', 'admin', 'ee500000-0000-4000-8000-000000000031',
   'booking_updated', null, '甲的通知三(已讀)', '內容三', now() - interval '1 hour'),
  ('ee500000-0000-4000-8000-000000000104', 'ee500000-0000-4000-8000-000000000002',
   'ee500000-0000-4000-8000-000000000021', 'agent', 'ee500000-0000-4000-8000-000000000041',
   'booking_created', 'ee500000-0000-4000-8000-000000000061', '乙的通知', '乙的內容', null),
  ('ee500000-0000-4000-8000-000000000105', 'ee500000-0000-4000-8000-000000000003',
   'ee500000-0000-4000-8000-000000000021', 'staff', 'ee500000-0000-4000-8000-000000000051',
   'booking_created', null, '丙的通知', '丙的內容', null);

-- =========================================================================
-- ① §13.2 RLS SELECT:只看得到自己的(4 條)
-- =========================================================================
select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000001'); -- 甲
select is(
  (select count(*) from user_notifications)::int, 3,
  '§13.2(核心必測):甲只看得到自己的 3 則通知'
);
select is(
  (select count(*) from user_notifications
    where user_id = 'ee500000-0000-4000-8000-000000000002')::int, 0,
  '§13.2(核心必測):甲**看不到**同一間商家裡客服乙的通知'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000002'); -- 乙
select is(
  (select count(*) from user_notifications)::int, 1,
  '§13.2:乙只看得到自己那 1 則'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('00000000-0000-4000-8000-0000000000ff', 'anon');
select is(
  (select count(*) from user_notifications)::int, 0,
  '§13.2:未登入(anon)一則都看不到'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ② §13.2 第 3/4 點:GRANT 收斂 —— 不是靠政策擋,是靠 GRANT 收掉(11 條)
-- =========================================================================
select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000001'); -- 甲
select throws_ok(
  $$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body)
    values ('ee500000-0000-4000-8000-000000000001', 'ee500000-0000-4000-8000-000000000021',
            'admin', 'ee500000-0000-4000-8000-000000000031', 'booking_created', '自己塞的', '自己塞的')$$,
  '42501', NULL,
  '§13.2(核心必測):authenticated 直接 INSERT 被擋下(表層 GRANT 已 revoke)'
);
select throws_ok(
  $$update user_notifications set read_at = now()
     where id = 'ee500000-0000-4000-8000-000000000101'$$,
  '42501', NULL,
  '§13.2(核心必測):authenticated 直接 UPDATE read_at 被擋下(標已讀只能走 RPC)'
);
select throws_ok(
  $$update user_notifications set title = '我改掉的假通知'
     where id = 'ee500000-0000-4000-8000-000000000101'$$,
  '42501', NULL,
  '🔴 §13.2(核心必測):使用者**無法**用 UPDATE 竄改自己那一列的 title —— 這正是刻意不開 UPDATE 政策的直接後果'
);
select throws_ok(
  $$delete from user_notifications where id = 'ee500000-0000-4000-8000-000000000101'$$,
  '42501', NULL,
  '§13.2(核心必測):authenticated 直接 DELETE 被擋下'
);
select pg_temp.test_clear_auth();

select is(
  (select title from user_notifications where id = 'ee500000-0000-4000-8000-000000000101'),
  '甲的通知一',
  '§13.2:上面那幾次嘗試之後,通知內容一個字都沒變'
);

select ok(
  not has_table_privilege('authenticated', 'public.user_notifications', 'insert'),
  '§13.2 第 4 點:authenticated 沒有 INSERT 權限'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_notifications', 'update'),
  '§13.2 第 4 點:authenticated 沒有 UPDATE 權限'
);
select ok(
  not has_table_privilege('authenticated', 'public.user_notifications', 'delete'),
  '§13.2 第 4 點:authenticated 沒有 DELETE 權限'
);
select ok(
  has_table_privilege('authenticated', 'public.user_notifications', 'select'),
  '§13.2:SELECT 權限要**留著**(收太多會讓鈴鐺讀不到自己的通知)'
);
select ok(
  not has_table_privilege('anon', 'public.user_notifications', 'insert'),
  '§13.2 第 4 點:anon 沒有 INSERT 權限'
);
select ok(
  not has_table_privilege('anon', 'public.user_notifications', 'update'),
  '§13.2 第 4 點:anon 沒有 UPDATE 權限'
);
select ok(
  not has_table_privilege('anon', 'public.user_notifications', 'delete'),
  '§13.2 第 4 點:anon 沒有 DELETE 權限'
);

-- 政策層也要對:只有一條 SELECT 政策,0 條寫入政策。
select is(
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'user_notifications' and p.polcmd = 'r')::int, 1,
  '§13.2:剛好一條 SELECT 政策'
);
select is(
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'user_notifications' and p.polcmd <> 'r')::int, 0,
  '🔴 §13.2 第 3 點:**完全沒有** INSERT / UPDATE / DELETE 政策(有人加了這條就會紅)'
);
select ok(
  (select relrowsecurity from pg_class where relname = 'user_notifications'),
  '§13.2 第 1 點:RLS 已啟用'
);

-- =========================================================================
-- ③ §13.8 mark_my_notifications_read(12 條)
-- =========================================================================
select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000001'); -- 甲
select is(
  public.mark_my_notifications_read(array['ee500000-0000-4000-8000-000000000101']::uuid[]), 1,
  '§13.8:帶自己那一列的 id → 回傳 1'
);
select pg_temp.test_clear_auth();

select ok(
  (select read_at is not null from user_notifications where id = 'ee500000-0000-4000-8000-000000000101'),
  '§13.8:那一列真的變成已讀'
);
select ok(
  (select read_at is null from user_notifications where id = 'ee500000-0000-4000-8000-000000000102'),
  '§13.8:**只標那一列** —— 另一則未讀的沒被波及'
);
select is(
  (select title || '|' || body || '|' || event_type || '|' || target_type || '|' ||
          target_id::text || '|' || merchant_id::text || '|' || coalesce(booking_id::text, 'null')
     from user_notifications where id = 'ee500000-0000-4000-8000-000000000101'),
  '甲的通知一|內容一|booking_created|admin|ee500000-0000-4000-8000-000000000031|ee500000-0000-4000-8000-000000000021|ee500000-0000-4000-8000-000000000061',
  '🔴 §13.8(核心必測):這支函式**只寫 read_at**,其他欄位一字不變'
);

select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000001'); -- 甲
select is(
  public.mark_my_notifications_read(array['ee500000-0000-4000-8000-000000000104']::uuid[]), 0,
  '🔴 §13.8(核心必測):帶**別人**的 id 進去 → 回傳 0'
);
select pg_temp.test_clear_auth();

select ok(
  (select read_at is null from user_notifications where id = 'ee500000-0000-4000-8000-000000000104'),
  '§13.8(核心必測):別人那一列一個字都沒被改到'
);

select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000001'); -- 甲
select is(
  public.mark_my_notifications_read(null), 1,
  '§13.8:p_ids = null → 把自己剩下的 1 則未讀標完(已讀的不會被重複計算)'
);
select is(
  (select count(*) from user_notifications where read_at is null)::int, 0,
  '§13.8:甲自己已經沒有任何未讀'
);
select pg_temp.test_clear_auth();

select ok(
  (select read_at is null from user_notifications where id = 'ee500000-0000-4000-8000-000000000104'),
  '§13.8:「全部標為已讀」不會外溢到別人身上'
);

select pg_temp.test_set_auth('00000000-0000-4000-8000-0000000000ff', 'anon');
select throws_ok(
  $$select public.mark_my_notifications_read(null)$$,
  '42501', NULL,
  '§13.8(核心必測):anon 呼叫被擋下'
);
select pg_temp.test_clear_auth();

select ok(
  not has_function_privilege('anon', 'public.mark_my_notifications_read(uuid[])', 'execute'),
  'supabase-permission-hygiene 規則 1:anon 沒有 EXECUTE'
);
select ok(
  not has_function_privilege('public', 'public.mark_my_notifications_read(uuid[])', 'execute'),
  'supabase-permission-hygiene 規則 1:PUBLIC 沒有 EXECUTE(建函式時的預設授權已收回)'
);
select ok(
  has_function_privilege('authenticated', 'public.mark_my_notifications_read(uuid[])', 'execute'),
  '§13.8:authenticated 要有 EXECUTE(前端唯一的寫入管道)'
);

-- =========================================================================
-- ④ §13.2 CHECK / 級聯 / 外鍵(6 條)
-- =========================================================================
select throws_ok(
  $$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body)
    values ('ee500000-0000-4000-8000-000000000001', 'ee500000-0000-4000-8000-000000000021',
            'admin', 'ee500000-0000-4000-8000-000000000031', 'test', 't', 'b')$$,
  '23514', NULL,
  '§13.2:CHECK 拒絕 event_type = ''test''(測試推播刻意不進鈴鐺)'
);
select throws_ok(
  $$insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body)
    values ('ee500000-0000-4000-8000-000000000001', 'ee500000-0000-4000-8000-000000000021',
            'member', 'ee500000-0000-4000-8000-000000000031', 'booking_created', 't', 'b')$$,
  '23514', NULL,
  '§13.2:CHECK 拒絕不在清單內的 target_type(這一批刻意不含 member)'
);

-- booking 硬刪除(全庫唯一路徑是 rollback_bulk_operation)→ booking_id 變 null,通知本身還在。
delete from bookings where id = 'ee500000-0000-4000-8000-000000000061';
select is(
  (select count(*) from user_notifications where id = 'ee500000-0000-4000-8000-000000000101')::int, 1,
  '§13.2:訂單被硬刪除之後,那一則通知**還在**'
);
select ok(
  (select booking_id is null from user_notifications where id = 'ee500000-0000-4000-8000-000000000101'),
  '§13.2:on delete set null 生效,booking_id 變成 null'
);
select is(
  (select title from user_notifications where id = 'ee500000-0000-4000-8000-000000000101'),
  '甲的通知一',
  '§13.2:內容是發送當下的文字副本,訂單刪掉也不會變空白'
);

-- auth.users 刪除 → 級聯清空。
delete from auth.users where id = 'ee500000-0000-4000-8000-000000000003';
select is(
  (select count(*) from user_notifications where id = 'ee500000-0000-4000-8000-000000000105')::int, 0,
  '§13.2:auth.users 刪除時通知級聯清空'
);

-- =========================================================================
-- ⑤ §13.9 prune_user_notifications(9 條)
-- =========================================================================
-- 使用者丁:502 列全部是「剛剛」建立的 → 只該留最新 500 列。
insert into user_notifications (user_id, merchant_id, target_type, target_id, event_type, title, body, created_at)
select
  'ee500000-0000-4000-8000-000000000004',
  'ee500000-0000-4000-8000-000000000021',
  'admin', 'ee500000-0000-4000-8000-000000000031', 'booking_created',
  '溢出測試 ' || i, '內容',
  now() - (i || ' seconds')::interval
from generate_series(1, 502) as i;

-- 使用者戊:一列 31 天前、一列 29 天前 → 只該留 29 天前那一列。
insert into user_notifications (id, user_id, merchant_id, target_type, target_id, event_type, title, body, created_at) values
  ('ee500000-0000-4000-8000-000000000201', 'ee500000-0000-4000-8000-000000000005',
   'ee500000-0000-4000-8000-000000000021', 'admin', 'ee500000-0000-4000-8000-000000000031',
   'booking_created', '31 天前', '內容', now() - interval '31 days'),
  ('ee500000-0000-4000-8000-000000000202', 'ee500000-0000-4000-8000-000000000005',
   'ee500000-0000-4000-8000-000000000021', 'admin', 'ee500000-0000-4000-8000-000000000031',
   'booking_created', '29 天前', '內容', now() - interval '29 days');

select is(
  (select count(*) from user_notifications where user_id = 'ee500000-0000-4000-8000-000000000004')::int,
  502,
  '§13.9 前提斷言:清理前丁真的有 502 列(避免空清單假通過)'
);

select pg_temp.test_set_auth('ee500000-0000-4000-8000-000000000004');
select throws_ok(
  $$select public.prune_user_notifications()$$,
  '42501', NULL,
  '§13.9(核心必測):authenticated 呼叫清理函式被擋下'
);
select pg_temp.test_clear_auth();

select is(
  public.prune_user_notifications(), 3,
  '§13.9:一次清理刪掉 3 列(戊的 31 天前 1 列 + 丁超出 500 的 2 列)'
);
select is(
  (select count(*) from user_notifications where user_id = 'ee500000-0000-4000-8000-000000000004')::int,
  500,
  '§13.9:丁只留下最新 500 列'
);
select is(
  (select count(*) from user_notifications
    where user_id = 'ee500000-0000-4000-8000-000000000004' and title = '溢出測試 1')::int,
  1,
  '§13.9:最新的那一列(1 秒前)留著'
);
select is(
  (select count(*) from user_notifications
    where user_id = 'ee500000-0000-4000-8000-000000000004' and title in ('溢出測試 501', '溢出測試 502'))::int,
  0,
  '§13.9:第 501 / 502 列(最舊的)被刪除'
);
select is(
  (select count(*) from user_notifications where id = 'ee500000-0000-4000-8000-000000000201')::int, 0,
  '§13.9:31 天前的列被刪除'
);
select is(
  (select count(*) from user_notifications where id = 'ee500000-0000-4000-8000-000000000202')::int, 1,
  '§13.9:29 天前的列留著'
);
select ok(
  not has_function_privilege('authenticated', 'public.prune_user_notifications()', 'execute'),
  'supabase-permission-hygiene 規則 1:prune 對 authenticated 沒有 EXECUTE'
);
select ok(
  not has_function_privilege('anon', 'public.prune_user_notifications()', 'execute')
  and not has_function_privilege('public', 'public.prune_user_notifications()', 'execute'),
  'supabase-permission-hygiene 規則 1:prune 對 anon 與 PUBLIC 都沒有 EXECUTE'
);

-- =========================================================================
-- ⑥ 索引與排程(3 條)
-- =========================================================================
select ok(
  exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'user_notifications'
       and indexname = 'user_notifications_unread_idx'
  ),
  '§13.2:未讀數字用的 partial index 存在'
);
select ok(
  exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'user_notifications'
       and indexname = 'user_notifications_user_created_idx'
  ),
  '§13.2:列表查詢用的 (user_id, created_at desc) 索引存在'
);
select ok(
  exists (select 1 from cron.job where jobname = 'user-notifications-prune-daily'),
  '§13.9:每日清理排程已建立'
);

select * from finish();
rollback;
