-- 模組 15 擴充:手機推播擴及三種角色 — pgTAP
-- 對應規格書 .project/specs/手機推播擴及三種角色.md:
--   §2.1(upsert 換主人 / auth.users 級聯)、§2.2(CHECK/唯一索引/RLS,含 UPDATE WITH CHECK)、
--   §2.4(新 CHECK 值 / ack_token UNIQUE / staff_id 已移除)、§2.5(owns_push_target)、
--   §2.6(get_merchant_push_event_enabled_map)、§3.3(get_staff_push_status)、
--   §4.1(帶別人 target_id 的 insert/update 被擋下,核心必測)、§4.6(停用者排除 + 孤兒清理觸發器)、
--   §5.1(resolve_push_recipients 六種情境 + anon/authenticated 被擋下)、§6.6(頻率限制)。
begin;

select plan(83);

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
-- Fixture:兩間商家 A / B。
--   A 店:管理員甲、客服乙(active)、客服丙(removed,模擬離職)、
--         服務人員丁(active+可登入)、服務人員戊(停用)、服務人員己(沒有 user_id)。
--   B 店:管理員庚。
--   另外:雙重身份帳號「辛」—— 在 A 店同時是客服與服務人員(對應 §〇.6 的 goldtw2021)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ed500000-0000-4000-8000-000000000001', 'pgtap-m15b-admin-a@test.local'),
  ('ed500000-0000-4000-8000-000000000002', 'pgtap-m15b-agent-active@test.local'),
  ('ed500000-0000-4000-8000-000000000003', 'pgtap-m15b-agent-removed@test.local'),
  ('ed500000-0000-4000-8000-000000000004', 'pgtap-m15b-staff-ding@test.local'),
  ('ed500000-0000-4000-8000-000000000005', 'pgtap-m15b-staff-wu@test.local'),
  ('ed500000-0000-4000-8000-000000000006', 'pgtap-m15b-admin-b@test.local'),
  ('ed500000-0000-4000-8000-000000000007', 'pgtap-m15b-dual-role@test.local');

insert into groups (id) values
  ('ed500000-0000-4000-8000-000000000011'),
  ('ed500000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000011', '多角色推播A店', 'in_store_beauty'),
  ('ed500000-0000-4000-8000-000000000022', 'ed500000-0000-4000-8000-000000000012', '多角色推播B店', 'in_store_beauty');

insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('ed500000-0000-4000-8000-000000000031', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000001', '老闆甲'),
  ('ed500000-0000-4000-8000-000000000032', 'ed500000-0000-4000-8000-000000000022', 'ed500000-0000-4000-8000-000000000006', '老闆庚');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ed500000-0000-4000-8000-000000000041', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000002', '客服乙', 'pgtap-m15b-agent-active@test.local', 'active', now(), '0900000201'),
  ('ed500000-0000-4000-8000-000000000042', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000003', '客服丙', 'pgtap-m15b-agent-removed@test.local', 'removed', now(), '0900000202'),
  ('ed500000-0000-4000-8000-000000000043', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000007', '辛-客服身份', 'pgtap-m15b-dual-role@test.local', 'active', now(), '0900000203');

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone) values
  ('ed500000-0000-4000-8000-000000000051', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000004', '服務人員丁', 'active', 'active', '0900000301'),
  ('ed500000-0000-4000-8000-000000000052', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000005', '服務人員戊', 'active', 'active', '0900000302'),
  ('ed500000-0000-4000-8000-000000000053', 'ed500000-0000-4000-8000-000000000021', null, '服務人員己', 'active', 'invited', '0900000303'),
  ('ed500000-0000-4000-8000-000000000054', 'ed500000-0000-4000-8000-000000000021', 'ed500000-0000-4000-8000-000000000007', '辛-服務人員身份', 'active', 'active', '0900000304');

select seed_default_push_event_settings('ed500000-0000-4000-8000-000000000021');
select seed_default_push_event_settings('ed500000-0000-4000-8000-000000000022');

-- =========================================================================
-- ① §2.5 private.owns_push_target:三種角色 ×(本人/別人/停用/跨商家/未登入)
-- =========================================================================
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000001'); -- 管理員甲
select ok(
  private.owns_push_target('admin', 'ed500000-0000-4000-8000-000000000031', 'ed500000-0000-4000-8000-000000000021'),
  '§2.5:管理員判斷自己那一列為真'
);
select ok(
  not private.owns_push_target('admin', 'ed500000-0000-4000-8000-000000000032', 'ed500000-0000-4000-8000-000000000022'),
  '§2.5(核心必測):管理員判斷別人(B 店管理員)那一列為假'
);
select ok(
  not private.owns_push_target('admin', 'ed500000-0000-4000-8000-000000000031', 'ed500000-0000-4000-8000-000000000022'),
  '§2.5(核心必測):target_id 對但 merchant_id 換成另一間店 → 假(跨商家隔離)'
);
select ok(
  not private.owns_push_target('member', 'ed500000-0000-4000-8000-000000000031', 'ed500000-0000-4000-8000-000000000021'),
  '§2.5:不認得的 target_type 一律為假'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000002'); -- 客服乙(active)
select ok(
  private.owns_push_target('agent', 'ed500000-0000-4000-8000-000000000041', 'ed500000-0000-4000-8000-000000000021'),
  '§2.5:在職客服判斷自己那一列為真'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000003'); -- 客服丙(removed)
select ok(
  not private.owns_push_target('agent', 'ed500000-0000-4000-8000-000000000042', 'ed500000-0000-4000-8000-000000000021'),
  '§2.5(核心必測):已停用(status<>active)的客服為假'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004'); -- 服務人員丁
select ok(
  private.owns_push_target('staff', 'ed500000-0000-4000-8000-000000000051', 'ed500000-0000-4000-8000-000000000021'),
  '§2.5:在職且可登入的服務人員判斷自己那一列為真'
);
select pg_temp.test_clear_auth();

-- 未登入(anon):auth.uid() 為 null,三個分支全部為假。
select ok(
  not private.owns_push_target('staff', 'ed500000-0000-4000-8000-000000000051', 'ed500000-0000-4000-8000-000000000021'),
  '§2.5(核心必測):未登入(auth.uid() 為 null)一律為假'
);

select ok(
  not has_function_privilege('anon', 'private.owns_push_target(text,uuid,uuid)', 'execute'),
  '§2.5/權限衛生規則 1:anon 沒有 owns_push_target 的 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'private.owns_push_target(text,uuid,uuid)', 'execute'),
  '§2.5:authenticated 必須有 EXECUTE(RLS 政策就是在這個角色下執行的)'
);

-- =========================================================================
-- ② §2.2 push_event_subscriptions:CHECK / 唯一索引 / RLS(含 §4.1 核心必測)
-- =========================================================================
select throws_ok(
  $$insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type)
    values ('ed500000-0000-4000-8000-000000000021', 'member', 'ed500000-0000-4000-8000-000000000031', 'booking_created')$$,
  '23514', null,
  '§2.2:target_type CHECK 擋下 member(這一批刻意不放會員)'
);
select throws_ok(
  $$insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type)
    values ('ed500000-0000-4000-8000-000000000021', 'staff', 'ed500000-0000-4000-8000-000000000051', 'test')$$,
  '23514', null,
  '§2.4:event_type CHECK 擋下 test —— 測試推播不是一種可以訂閱的事件'
);

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004'); -- 服務人員丁
select lives_ok(
  $$insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type)
    values ('ed500000-0000-4000-8000-000000000021', 'staff', 'ed500000-0000-4000-8000-000000000051', 'booking_created')$$,
  '§2.2:服務人員丁新增自己的事件訂閱成功'
);
select is(
  (select enabled from push_event_subscriptions
   where target_id = 'ed500000-0000-4000-8000-000000000051' and event_type = 'booking_created'),
  true,
  '§2.2(Q7 裁決):enabled 預設為 true(四個事件開關預設全開)'
);
select throws_ok(
  $$insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type)
    values ('ed500000-0000-4000-8000-000000000021', 'staff', 'ed500000-0000-4000-8000-000000000052', 'booking_created')$$,
  '42501', null,
  '§4.1(核心必測):帶別人的 target_id 新增訂閱被 RLS WITH CHECK 擋下'
);
select pg_temp.test_clear_auth();

select throws_ok(
  $$insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type)
    values ('ed500000-0000-4000-8000-000000000021', 'staff', 'ed500000-0000-4000-8000-000000000051', 'booking_created')$$,
  '23505', null,
  '§2.2:唯一索引 (merchant_id, target_type, target_id, event_type) 擋下重複列'
);

-- §4.1(核心必測):使用者不能把自己那一列的 target_id 改成別人的(等於替別人關掉通知)。
--
-- 📌 2026-09-25 做故障注入驗證時查證到的一件事,寫在這裡免得下一個人被規格書誤導:
--    規格書 §2.2/§4.1 說「只寫 USING 會讓人把 target_id 改成別人的」——**那句話是錯的**。
--    實測:把政策改成只有 USING(pg_policy.polwithcheck 查出來是 NULL),下面這條斷言照樣通過,
--    因為 PostgreSQL 的 CREATE POLICY 文件行為是「UPDATE 政策省略 WITH CHECK 時,USING 會被
--    同時當成 WITH CHECK」。
--    真正能讓這條斷言變紅的是「擁有權判斷本身被寫鬆」——已實測:把 private.owns_push_target
--    改成不比對 target_id(只看 merchant_id + auth.uid()),下面第 15、17 兩條立刻 FAIL。
--    所以這條測試不是形式上的假測試,它守的是 owns_push_target 的正確性。
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004');
select throws_ok(
  $$update push_event_subscriptions set target_id = 'ed500000-0000-4000-8000-000000000052'
    where target_id = 'ed500000-0000-4000-8000-000000000051'$$,
  '42501', null,
  '§4.1(核心必測):把自己那一列的 target_id 改成別人的,被 UPDATE 政策的 WITH CHECK 擋下(真正在把關的是 owns_push_target 有沒有比對 target_id)'
);
select pg_temp.test_clear_auth();
select is(
  (select target_id from push_event_subscriptions where event_type = 'booking_created'
     and merchant_id = 'ed500000-0000-4000-8000-000000000021' and target_type = 'staff'),
  'ed500000-0000-4000-8000-000000000051'::uuid,
  '§4.1/權限衛生規則 2(核心必測):把自己的 target_id 改成別人的,被 WITH CHECK 擋下,資料沒變'
);

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000005'); -- 服務人員戊
select is(
  (select count(*)::int from push_event_subscriptions),
  0,
  '§2.2(核心必測):別人看不到服務人員丁的事件訂閱'
);
select pg_temp.test_clear_auth();

-- 跨商家隔離:同一個人在兩間店各有一組,互不影響(§2.2 邊界情況)。
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000007'); -- 雙重身份「辛」
select lives_ok(
  $$insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type) values
      ('ed500000-0000-4000-8000-000000000021', 'agent', 'ed500000-0000-4000-8000-000000000043', 'booking_created'),
      ('ed500000-0000-4000-8000-000000000021', 'staff', 'ed500000-0000-4000-8000-000000000054', 'booking_created')$$,
  '§2.2 邊界情況:同一個人在同一間店以「客服」與「服務人員」兩個身份各自訂閱,兩組列互不衝突'
);
select is(
  (select count(*)::int from push_event_subscriptions),
  2,
  '§2.2:辛看得到自己兩個身份的訂閱(看不到服務人員丁的那一列)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ §2.6 get_merchant_push_event_enabled_map:窄窗口
-- =========================================================================
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004'); -- 服務人員丁
select is(
  (select count(*)::int from get_merchant_push_event_enabled_map('ed500000-0000-4000-8000-000000000021')),
  4,
  '§2.6:服務人員(讀不到 merchant_push_event_settings 本表)可以透過窄函式拿到 4 種事件的總開關狀態'
);
select is(
  (select count(*)::int from push_event_subscriptions x where false) +
  (select count(*)::int from merchant_push_event_settings),
  0,
  '§2.6:同一位服務人員直接查 merchant_push_event_settings 仍然一列都看不到(RLS 沒有被放寬)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000002'); -- 客服乙(沒有 push_notification 權限)
select is(
  (select count(*)::int from get_merchant_push_event_enabled_map('ed500000-0000-4000-8000-000000000021')),
  4,
  '§2.6:沒有 push_notification 權限的客服也呼叫得到(這正是這支窄函式存在的理由)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000006'); -- B 店管理員
select throws_ok(
  $$select * from get_merchant_push_event_enabled_map('ed500000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '§2.6(核心必測):完全不屬於這間商家的人被擋下 42501'
);
select pg_temp.test_clear_auth();

select ok(
  not has_function_privilege('anon', 'public.get_merchant_push_event_enabled_map(uuid)', 'execute'),
  '§2.6/權限衛生規則 1:anon 沒有 EXECUTE'
);

-- =========================================================================
-- ④ §2.1 upsert_my_push_subscription:同一台裝置重複開通 / 換主人 / auth.users 級聯
-- =========================================================================
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004'); -- 服務人員丁
select lives_ok(
  $$select upsert_my_push_subscription('https://fcm.example/shared-device', 'p1', 'a1', 'iPhone')$$,
  '§2.1:第一次登記這台裝置成功'
);
select lives_ok(
  $$select upsert_my_push_subscription('https://fcm.example/shared-device', 'p1b', 'a1b', 'iPhone')$$,
  '§2.1 邊界情況:同一台裝置重複點「開啟通知」不會噴 UNIQUE 錯誤(upsert)'
);
select is(
  (select count(*)::int from push_subscriptions where endpoint = 'https://fcm.example/shared-device'),
  1,
  '§2.1:重複登記仍然只有一列'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000005'); -- 服務人員戊(同一支手機換人登入)
select lives_ok(
  $$select upsert_my_push_subscription('https://fcm.example/shared-device', 'p2', 'a2', 'iPhone')$$,
  '§2.1 邊界情況:同一支手機換人登入,upsert 成功'
);
select pg_temp.test_clear_auth();
select is(
  (select user_id from push_subscriptions where endpoint = 'https://fcm.example/shared-device'),
  'ed500000-0000-4000-8000-000000000005'::uuid,
  '§2.1(核心必測):on conflict 有換主人 —— 不換的話通知會送錯人'
);

-- auth.users 刪除時級聯清空(§2.1)。
insert into auth.users (id, email) values
  ('ed500000-0000-4000-8000-0000000000f1', 'pgtap-m15b-cascade@test.local');
insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
values ('ed500000-0000-4000-8000-0000000000f1', 'https://fcm.example/cascade', 'p', 'a');
delete from auth.users where id = 'ed500000-0000-4000-8000-0000000000f1';
select is(
  (select count(*)::int from push_subscriptions where endpoint = 'https://fcm.example/cascade'),
  0,
  '§2.1:auth.users 被刪除時,裝置登記級聯清空'
);

-- =========================================================================
-- ⑤ §2.4 push_notification_log 擴充後的 CHECK / ack_token / staff_id 已移除
-- =========================================================================
select hasnt_column('public', 'push_notification_log', 'staff_id',
  '§3.2:staff_id 欄位已移除(收件人改用 target_type/target_id)');

select lives_ok(
  $$insert into push_notification_log (merchant_id, event_type, status, target_type, target_id, ack_token)
    values ('ed500000-0000-4000-8000-000000000021', 'test', 'sent', 'admin',
            'ed500000-0000-4000-8000-000000000031', 'ed500000-0000-4000-8000-0000000000a1')$$,
  '§2.4:event_type 新增的 test 值可以寫入'
);
select throws_ok(
  $$insert into push_notification_log (merchant_id, event_type, status, ack_token)
    values ('ed500000-0000-4000-8000-000000000021', 'test', 'sent', 'ed500000-0000-4000-8000-0000000000a1')$$,
  '23505', null,
  '§2.4:ack_token 唯一索引生效'
);
select lives_ok(
  $$insert into push_notification_log (merchant_id, event_type, status, skip_reason, target_type, target_id)
    values ('ed500000-0000-4000-8000-000000000021', 'booking_created', 'skipped', 'personal_disabled',
            'staff', 'ed500000-0000-4000-8000-000000000051')$$,
  '§2.4/§5.3:skip_reason 新增的 personal_disabled 可以寫入'
);
select lives_ok(
  $$insert into push_notification_log (merchant_id, event_type, status, skip_reason)
    values ('ed500000-0000-4000-8000-000000000021', 'booking_created', 'skipped', 'no_recipient')$$,
  '§2.4/§5.3:skip_reason 新增的 no_recipient 可以寫入'
);
select throws_ok(
  $$insert into push_notification_log (merchant_id, event_type, status, target_type)
    values ('ed500000-0000-4000-8000-000000000021', 'booking_created', 'sent', 'member')$$,
  '23514', null,
  '§2.4:target_type CHECK 擋下 member'
);

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into push_notification_log (merchant_id, event_type, status) values ('ed500000-0000-4000-8000-000000000021', 'test', 'sent')$$,
  '42501', null,
  '§2.4:RLS 維持只開 SELECT —— 商家管理員仍然無法直接 INSERT'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ §5.1 resolve_push_recipients
-- 目前的訂閱狀態:服務人員丁(staff/booking_created)、辛的客服身份、辛的服務人員身份。
-- =========================================================================
-- 管理員甲也訂閱 booking_created,讓「管理員收全店每一筆」這條可以被驗到。
insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type) values
  ('ed500000-0000-4000-8000-000000000021', 'admin', 'ed500000-0000-4000-8000-000000000031', 'booking_created'),
  ('ed500000-0000-4000-8000-000000000021', 'agent', 'ed500000-0000-4000-8000-000000000042', 'booking_created');

select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_created', 'ed500000-0000-4000-8000-000000000051')),
  3,
  '§5.1:訂單指派給服務人員丁 → 收件人 = 丁(被指派的服務人員)+ 管理員甲 + 客服辛。已停用的客服丙被排除;辛的「服務人員身份」也不算,因為這筆單不是指派給他(§4.4 第 1 點)'
);
select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_created', null)),
  2,
  '§4.4/§5.1:訂單完全沒有指派服務人員時,管理員/客服照樣收得到(只少了被指派的那位服務人員)'
);
select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_created', 'ed500000-0000-4000-8000-000000000052')),
  2,
  '§4.4 第 1 點:服務人員只收「指派給自己」的單 —— 換成指派給戊(他沒訂閱),丁就不在收件人裡'
);
select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_cancelled', 'ed500000-0000-4000-8000-000000000051')),
  0,
  '§5.1:沒有人訂閱 booking_cancelled 時收件人是空的(對應 skip_reason=no_recipient)'
);
select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_created', 'ed500000-0000-4000-8000-000000000053')),
  2,
  '§5.1:沒有 user_id 的服務人員(還沒被邀請登入)不會被算進收件人'
);

-- §4.6(核心):把服務人員丁停用後,他立刻不再是收件人 —— 就算訂閱列還留著。
update merchant_staff set status = 'removed' where id = 'ed500000-0000-4000-8000-000000000051';
select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_created', 'ed500000-0000-4000-8000-000000000051')),
  2,
  '§4.6(核心必測):服務人員 status 改成 removed 後不再是收件人,即使他的訂閱列還在'
);
update merchant_staff set status = 'active' where id = 'ed500000-0000-4000-8000-000000000051';

-- 個人開關關閉的人不在收件人清單裡(§4.2 第 3 點)。
update push_event_subscriptions set enabled = false
where target_id = 'ed500000-0000-4000-8000-000000000031' and event_type = 'booking_created';
select is(
  (select count(*)::int from resolve_push_recipients(
     'ed500000-0000-4000-8000-000000000021', 'booking_created', 'ed500000-0000-4000-8000-000000000051')),
  2,
  '§4.2:管理員把自己的開關關掉之後,不再出現在收件人清單裡'
);
update push_event_subscriptions set enabled = true
where target_id = 'ed500000-0000-4000-8000-000000000031' and event_type = 'booking_created';

select ok(
  not has_function_privilege('anon', 'public.resolve_push_recipients(uuid,text,uuid)', 'execute'),
  '§5.1/權限衛生規則 1(核心必測):anon 沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'public.resolve_push_recipients(uuid,text,uuid)', 'execute'),
  '§5.1/權限衛生規則 1(核心必測):authenticated 也沒有 EXECUTE —— 這支函式會回傳別人的 user_id,只能給 service role'
);
select ok(
  has_function_privilege('service_role', 'public.resolve_push_recipients(uuid,text,uuid)', 'execute'),
  '§5.1:service_role 有 EXECUTE(Edge Function 要用)'
);

-- §5.2 第 3 點:is_staff_push_event_disabled。
update push_event_subscriptions set enabled = false
where target_id = 'ed500000-0000-4000-8000-000000000051' and event_type = 'booking_created';
select ok(
  is_staff_push_event_disabled('ed500000-0000-4000-8000-000000000021',
    'ed500000-0000-4000-8000-000000000051', 'booking_created'),
  '§4.2 第 3 點:服務人員自己把事件關掉 → is_staff_push_event_disabled 為真(要寫 personal_disabled)'
);
select ok(
  not is_staff_push_event_disabled('ed500000-0000-4000-8000-000000000021',
    'ed500000-0000-4000-8000-000000000053', 'booking_created'),
  '§4.2 第 3 點:從來沒開通過的人回假(不寫 personal_disabled,避免記錄表塞雜訊)'
);
update push_event_subscriptions set enabled = true
where target_id = 'ed500000-0000-4000-8000-000000000051' and event_type = 'booking_created';

-- =========================================================================
-- ⑦ §3.3 get_staff_push_status 的三種狀態
-- =========================================================================
insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
values ('ed500000-0000-4000-8000-000000000004', 'https://fcm.example/ding-1', 'p', 'a');

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000001'); -- A 店管理員
select is(
  get_staff_push_status('ed500000-0000-4000-8000-000000000051'),
  jsonb_build_object('device_count', 1, 'any_event_enabled', true),
  '§3.3:有裝置、也有開啟事件 → {1, true}(顯示「已開通 1 台,會收到通知」)'
);
select is(
  get_staff_push_status('ed500000-0000-4000-8000-000000000053'),
  jsonb_build_object('device_count', 0, 'any_event_enabled', false),
  '§3.3:沒有 user_id 的服務人員 device_count = 0'
);
select pg_temp.test_clear_auth();

update push_event_subscriptions set enabled = false
where target_id = 'ed500000-0000-4000-8000-000000000051';
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000001');
select is(
  get_staff_push_status('ed500000-0000-4000-8000-000000000051'),
  jsonb_build_object('device_count', 1, 'any_event_enabled', false),
  '§3.3(Q6 的核心):有裝置但四種事件全關 → {1, false} —— 這就是「已開通 N 台」不能再直接當成「他會收到通知」的原因'
);
select pg_temp.test_clear_auth();
update push_event_subscriptions set enabled = true
where target_id = 'ed500000-0000-4000-8000-000000000051';

-- =========================================================================
-- ⑧ §6.6 count_my_recent_test_pushes 頻率限制
-- =========================================================================
insert into push_notification_log (merchant_id, event_type, status, target_type, target_id, attempted_at) values
  ('ed500000-0000-4000-8000-000000000021', 'test', 'sent', 'admin', 'ed500000-0000-4000-8000-000000000031', now()),
  ('ed500000-0000-4000-8000-000000000021', 'test', 'sent', 'admin', 'ed500000-0000-4000-8000-000000000031', now()),
  ('ed500000-0000-4000-8000-000000000021', 'test', 'sent', 'admin', 'ed500000-0000-4000-8000-000000000031', now() - interval '61 seconds');

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000001');
select is(
  count_my_recent_test_pushes('ed500000-0000-4000-8000-000000000021'),
  3,
  '§6.6:60 秒內算得到 3 筆(⑤ 寫入的那一筆 + 這裡的 2 筆;61 秒前的那筆不算)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000006'); -- B 店管理員
select throws_ok(
  $$select count_my_recent_test_pushes('ed500000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '§6.6/§6.1:不屬於這間商家的人呼叫 → 42501(身分一律由 get_my_push_identity 從 auth.uid() 解析)'
);
select pg_temp.test_clear_auth();

-- §6.1 第 5 步:get_my_push_identity 的優先權 admin > agent > staff。
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000007'); -- 辛(同時是客服與服務人員)
select is(
  get_my_push_identity('ed500000-0000-4000-8000-000000000021') ->> 'target_type',
  'agent',
  '§6.1:同時是客服與服務人員時,依 admin > agent > staff 優先權解析成 agent(跟 useMerchantRole 一致)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ §4.6 第 3 點:孤兒訂閱清理觸發器
-- =========================================================================
select is(
  (select count(*)::int from push_event_subscriptions where target_id = 'ed500000-0000-4000-8000-000000000042'),
  1,
  '§4.6:刪除前,客服丙的訂閱列存在'
);
delete from merchant_agents where id = 'ed500000-0000-4000-8000-000000000042';
select is(
  (select count(*)::int from push_event_subscriptions where target_id = 'ed500000-0000-4000-8000-000000000042'),
  0,
  '§4.6 第 3 點:硬刪除客服之後,AFTER DELETE 觸發器清掉對應的孤兒訂閱列'
);

-- =========================================================================
-- ⑩ §6.4 ack_push_test_notification:一次性 + 10 分鐘有效 + 更新 last_seen_at
--    (2026-09-25 品管複查後補:這支函式原本只有 Edge Function 層的手動驗證,
--     資料庫層的「一次性」「過期」「只更新那一台裝置」三個語意沒有任何自動化保護。)
-- =========================================================================
insert into push_subscriptions (id, user_id, endpoint, p256dh_key, auth_key) values
  ('ed500000-0000-4000-8000-0000000000d1', 'ed500000-0000-4000-8000-000000000004', 'https://fcm.example/ack-device-1', 'p', 'a'),
  ('ed500000-0000-4000-8000-0000000000d2', 'ed500000-0000-4000-8000-000000000004', 'https://fcm.example/ack-device-2', 'p', 'a');

insert into push_notification_log
  (id, merchant_id, event_type, status, target_type, target_id, ack_token, ack_subscription_id, attempted_at)
values
  -- 有效(剛剛才送出)
  ('ed500000-0000-4000-8000-0000000000e1', 'ed500000-0000-4000-8000-000000000021', 'test', 'sent',
   'staff', 'ed500000-0000-4000-8000-000000000051',
   'ed500000-0000-4000-8000-0000000000b1', 'ed500000-0000-4000-8000-0000000000d1', now()),
  -- 過期(11 分鐘前送出)
  ('ed500000-0000-4000-8000-0000000000e2', 'ed500000-0000-4000-8000-000000000021', 'test', 'sent',
   'staff', 'ed500000-0000-4000-8000-000000000051',
   'ed500000-0000-4000-8000-0000000000b2', 'ed500000-0000-4000-8000-0000000000d2', now() - interval '11 minutes');

select ok(
  ack_push_test_notification('ed500000-0000-4000-8000-0000000000b1'),
  '§6.4:有效的 token 回報成功'
);
select isnt(
  (select acked_at from push_notification_log where id = 'ed500000-0000-4000-8000-0000000000e1'),
  null,
  '§6.4:acked_at 被寫入'
);
select isnt(
  (select last_seen_at from push_subscriptions where id = 'ed500000-0000-4000-8000-0000000000d1'),
  null,
  '§6.4 第 3 點:**對應那一台裝置**的 last_seen_at 被寫入(這是 last_seen_at 第一次真的有程式碼會寫它)'
);
select is(
  (select last_seen_at from push_subscriptions where id = 'ed500000-0000-4000-8000-0000000000d2'),
  null,
  '§6.4 第 3 點(核心):**只有**那一台裝置被標記,不是把這個人全部的裝置都標成收到 —— 那會是謊報'
);

select ok(
  not ack_push_test_notification('ed500000-0000-4000-8000-0000000000b1'),
  '§6.4 第 2 點(核心必測):一次性 —— 同一個 token 第二次回 false'
);
select ok(
  not ack_push_test_notification('ed500000-0000-4000-8000-0000000000b2'),
  '§6.4 第 2 點(核心必測):超過 10 分鐘的 token 不再更新'
);
select is(
  (select acked_at from push_notification_log where id = 'ed500000-0000-4000-8000-0000000000e2'),
  null,
  '§6.4:過期的那一列 acked_at 仍然是 null(真的沒有被改到)'
);
select ok(
  not ack_push_test_notification('ed500000-0000-4000-8000-0000000000bf'),
  '§6.4:根本不存在的 token 回 false'
);
select ok(
  not ack_push_test_notification(null),
  '§6.4:null token 回 false,不丟錯'
);

select ok(
  not has_function_privilege('anon', 'public.ack_push_test_notification(uuid)', 'execute'),
  '§6.4/權限衛生規則 1(核心必測):anon 沒有 EXECUTE —— 呼叫它的 push-test-ack 是公開端點,靠的是 token 不是這支函式的權限'
);
select ok(
  not has_function_privilege('authenticated', 'public.ack_push_test_notification(uuid)', 'execute'),
  '§6.4/權限衛生規則 1(核心必測):authenticated 也沒有 EXECUTE(只有 service_role)'
);

-- =========================================================================
-- ⑪ §6.3 第 4 點 have_my_test_pushes_been_acked:前端輪詢的窄窗口
--    (2026-09-25 品管複查抓到的功能缺陷的修正:原本前端直接查 push_notification_log,
--     但那張表的 SELECT RLS 是 can_manage_push_notification —— 服務人員完全讀不到,
--     會靜默拿到 0 列而看到假警告。)
-- =========================================================================
-- 先證明「直接查那張表」對服務人員真的是 0 列(這就是原本的缺陷)。
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004'); -- 服務人員丁本人
select is(
  (select count(*)::int from push_notification_log where ack_token = 'ed500000-0000-4000-8000-0000000000b1'),
  0,
  '🔴 缺陷本身:服務人員直接查 push_notification_log 拿到 0 列(RLS 靜默過濾,不丟錯)—— 所以備援輪詢對他永遠失效'
);
select ok(
  have_my_test_pushes_been_acked(array['ed500000-0000-4000-8000-0000000000b1']::uuid[]),
  '🔴 修正後(核心必測):同一位服務人員透過窄函式查得到「我那一則已經回報送達」'
);
select ok(
  not have_my_test_pushes_been_acked(array['ed500000-0000-4000-8000-0000000000b2']::uuid[]),
  '§6.3:還沒回報的 token 回 false'
);
select pg_temp.test_clear_auth();

-- 別人的 token 一律 false(核心必測:這支函式只回 boolean,但也不能變成「猜 token」的工具)。
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000005'); -- 服務人員戊(不是收件人)
select ok(
  not have_my_test_pushes_been_acked(array['ed500000-0000-4000-8000-0000000000b1']::uuid[]),
  '§4.1(核心必測):帶別人的 ack_token 進來一律回 false —— 身分是從 auth.uid() 反查的,前端指定不了'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000006'); -- B 店管理員,完全無關
select ok(
  not have_my_test_pushes_been_acked(array['ed500000-0000-4000-8000-0000000000b1']::uuid[]),
  '§4.1:跨商家的人帶同一個 token 也是 false'
);
select pg_temp.test_clear_auth();

-- 未登入(anon 身分,auth.uid() 為 null)。
select ok(
  not have_my_test_pushes_been_acked(array['ed500000-0000-4000-8000-0000000000b1']::uuid[]),
  '§4.1:未登入一律 false'
);

-- 邊界:空陣列 / null / 超過 50 個。
select pg_temp.test_set_auth('ed500000-0000-4000-8000-000000000004');
select ok(
  not have_my_test_pushes_been_acked(array[]::uuid[]),
  '§6.3:空陣列回 false'
);
select ok(
  not have_my_test_pushes_been_acked(null),
  '§6.3:null 回 false,不丟錯'
);
select ok(
  not have_my_test_pushes_been_acked(
    array(select 'ed500000-0000-4000-8000-0000000000b1'::uuid from generate_series(1, 51))),
  '§6.3:一次帶超過 50 個 token 一律回 false(避免被當成批次猜 token 的工具)'
);
select pg_temp.test_clear_auth();

select ok(
  not has_function_privilege('anon', 'public.have_my_test_pushes_been_acked(uuid[])', 'execute'),
  '§6.3/權限衛生規則 1:anon 沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.have_my_test_pushes_been_acked(uuid[])', 'execute'),
  '§6.3:authenticated 有 EXECUTE(這就是給前端呼叫的),範圍由函式內部的 auth.uid() 鎖死'
);

-- ⚠️ 確認這次修正**沒有**順手放寬 push_notification_log 的 RLS(品管特別交代的紅線)。
select is(
  (select count(*)::int from pg_policy where polrelid = 'public.push_notification_log'::regclass),
  1,
  '🔴 紅線:push_notification_log 仍然只有一條政策(SELECT),沒有因為這次修正被放寬'
);
select is(
  (select pg_get_expr(polqual, polrelid) from pg_policy
   where polrelid = 'public.push_notification_log'::regclass),
  'private.can_manage_push_notification(merchant_id)',
  '🔴 紅線:那條 SELECT 政策的條件一字未改'
);

select * from finish();
rollback;
