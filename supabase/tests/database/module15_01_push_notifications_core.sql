-- 模組 15(服務人員推播通知)— 對應規格書
-- .project\specs\服務人員推播通知.md 第二節(2.1~2.4)、規則 4.7 引用的 can_manage_push_notification
-- (7.3)、7.4 seed_default_push_event_settings + create_group_and_merchant/create_merchant_in_group
-- 疊加、7.5 get_staff_push_subscription_count、7.9 update_push_event_setting。
--
-- ⚠️ 2026-09-25「手機推播擴及三種角色」批次改動了兩處(其餘一字未動):
--    ① staff_push_subscriptions → push_subscriptions(主體改成 auth.users.id,§2.1/§3.1)
--    ⑦ get_staff_push_subscription_count → get_staff_push_status(回傳 jsonb,§3.3)
--    另外 ⑤ 寫入 push_notification_log 的欄位 staff_id → target_type/target_id(§2.4/§3.2)。
--    新增的資料表/函式(§2.2/§2.5/§2.6/§5.1/§6.6/§4.6)測試放在 module15_02_push_multi_role.sql。
begin;

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

-- =========================================================================
-- Fixture:两間商家(A/B)。A 商家:管理員、3 種客服(無授權/push_notification/orders-only)、
-- 兩位服務人員(甲、乙,甲有 user_id 可登入,乙沒有 user_id 模擬尚未邀請登入)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ec500000-0000-4000-8000-000000000001', 'pgtap-m15-admin-a@test.local'),
  ('ec500000-0000-4000-8000-000000000002', 'pgtap-m15-admin-b@test.local'),
  ('ec500000-0000-4000-8000-000000000003', 'pgtap-m15-agent-none@test.local'),
  ('ec500000-0000-4000-8000-000000000004', 'pgtap-m15-agent-push@test.local'),
  ('ec500000-0000-4000-8000-000000000005', 'pgtap-m15-agent-orders@test.local'),
  ('ec500000-0000-4000-8000-000000000006', 'pgtap-m15-staff-jia@test.local'),
  ('ec500000-0000-4000-8000-000000000007', 'pgtap-m15-staff-yi@test.local'),
  ('ec500000-0000-4000-8000-000000000008', 'pgtap-m15-seed-onboarding@test.local');

insert into groups (id) values
  ('ec500000-0000-4000-8000-000000000011'),
  ('ec500000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000011', '推播通知測試A店', 'in_store_beauty'),
  ('ec500000-0000-4000-8000-000000000022', 'ec500000-0000-4000-8000-000000000012', '推播通知測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000001'),
  ('ec500000-0000-4000-8000-000000000022', 'ec500000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ec500000-0000-4000-8000-000000000051', 'ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m15-agent-none@test.local', 'active', now(), '0900000101'),
  ('ec500000-0000-4000-8000-000000000052', 'ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000004', '客服-push', 'pgtap-m15-agent-push@test.local', 'active', now(), '0900000102'),
  ('ec500000-0000-4000-8000-000000000053', 'ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000005', '客服-orders', 'pgtap-m15-agent-orders@test.local', 'active', now(), '0900000103');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ec500000-0000-4000-8000-000000000052', 'push_notification', true),
  ('ec500000-0000-4000-8000-000000000053', 'orders', true);

insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, phone) values
  ('ec500000-0000-4000-8000-000000000061', 'ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000006', '服務人員甲', 'active', 'active', '0900000101'),
  ('ec500000-0000-4000-8000-000000000062', 'ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000007', '服務人員乙', 'active', 'active', '0900000102');

-- =========================================================================
-- ① §2.1 push_subscriptions:CHECK/唯一索引/RLS(核心必測)。
--
-- ⚠️ 2026-09-25「手機推播擴及三種角色」批次:這張表原本叫 staff_push_subscriptions,
--    主體是 merchant_staff.id;現在改成 push_subscriptions,主體是 auth.users.id(§2.1),
--    因為裝置屬於登入帳號、不屬於某間店的某個職務。下面的斷言逐條沿用原本的驗證意圖
--    (本人可讀寫自己的/看不到別人的/endpoint UNIQUE/沒有 UPDATE 政策/刪不掉別人的),
--    只是判斷欄位從 staff_id 換成 user_id。**一條都沒有刪掉。**
-- =========================================================================
select throws_ok(
  $$insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
    values ('ec500000-0000-4000-8000-000000000006', null, 'p', 'a')$$,
  '23502', null,
  '§2.1:endpoint not null 擋下'
);

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000006'); -- 服務人員甲
select lives_ok(
  $$insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key, user_agent)
    values ('ec500000-0000-4000-8000-000000000006', 'https://fcm.example/aaa', 'p256dh-1', 'auth-1', 'iPhone Safari')$$,
  '§2.1(核心必測):服務人員甲新增自己的裝置登記成功'
);

select is(
  (select count(*)::int from push_subscriptions where user_id = 'ec500000-0000-4000-8000-000000000006'),
  1,
  '§2.1:服務人員甲看得到自己剛新增的那一筆'
);

select throws_ok(
  $$insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
    values ('ec500000-0000-4000-8000-000000000007', 'https://fcm.example/bbb', 'p', 'a')$$,
  '42501', null,
  '§2.1(核心必測):服務人員甲無法幫服務人員乙新增裝置登記(with check 擋下)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000007'); -- 服務人員乙
select lives_ok(
  $$insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
    values ('ec500000-0000-4000-8000-000000000007', 'https://fcm.example/ccc', 'p256dh-2', 'auth-2')$$,
  '§2.1:服務人員乙新增自己的裝置登記成功'
);
select is(
  (select count(*)::int from push_subscriptions where user_id = 'ec500000-0000-4000-8000-000000000006'),
  0,
  '§2.1(核心必測):服務人員乙看不到服務人員甲的裝置登記'
);
select pg_temp.test_clear_auth();

-- endpoint 唯一索引(核心必測)。
select throws_ok(
  $$insert into push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
    values ('ec500000-0000-4000-8000-000000000007', 'https://fcm.example/aaa', 'p', 'a')$$,
  '23505', null,
  '§2.1(核心必測):endpoint 唯一索引擋下重複的 endpoint'
);

-- 商家管理員沒有直接 SELECT 政策(§2.1 邊界情況:管理員只能看數量,走 get_staff_push_status)。
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000001'); -- A店管理員
select is(
  (select count(*)::int from push_subscriptions),
  0,
  '§2.1:商家管理員沒有 SELECT 政策,直接查這張表看不到任何一筆'
);
select pg_temp.test_clear_auth();

-- 沒有 UPDATE 政策:一般角色不能更新 last_seen_at(WITH 子句包 UPDATE 必須是頂層陳述式,
-- 這裡改成「先執行 UPDATE(靜默受 0 筆影響)→ 另外查詢確認沒有變化」兩個獨立陳述式)。
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000006');
update push_subscriptions set last_seen_at = now()
where user_id = 'ec500000-0000-4000-8000-000000000006';
select is(
  (select last_seen_at from push_subscriptions where user_id = 'ec500000-0000-4000-8000-000000000006'),
  null,
  '§2.1:沒有 UPDATE 政策,本人也無法更新 last_seen_at(RLS 靜默擋下,仍是 null)'
);
select pg_temp.test_clear_auth();

-- 刪除:本人可以刪除自己的裝置登記,不能刪除別人的。
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000007');
delete from push_subscriptions where user_id = 'ec500000-0000-4000-8000-000000000006';
select pg_temp.test_clear_auth();

-- 管理員對這張表沒有 SELECT 政策,這裡改用超級使用者身分(不受 RLS 限制)確認實際資料列數。
select is(
  (select count(*)::int from push_subscriptions where user_id = 'ec500000-0000-4000-8000-000000000006'),
  1,
  '§2.1(核心必測):服務人員乙嘗試刪除服務人員甲的裝置登記,RLS 靜默擋下,甲的那一筆仍在(用超級使用者身分確認,不受 RLS 限制)'
);

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000007');
select lives_ok(
  $$delete from push_subscriptions where user_id = 'ec500000-0000-4000-8000-000000000007'$$,
  '§2.1:服務人員乙刪除自己的裝置登記成功'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ② 7.3 can_manage_push_notification 權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000001');
select ok(private.can_manage_push_notification('ec500000-0000-4000-8000-000000000021'), '7.3:商家管理員永遠為真');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000003');
select ok(not private.can_manage_push_notification('ec500000-0000-4000-8000-000000000021'), '7.3:無授權客服為假');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000004');
select ok(private.can_manage_push_notification('ec500000-0000-4000-8000-000000000021'), '7.3:被授權 push_notification 的客服為真');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000005');
select ok(not private.can_manage_push_notification('ec500000-0000-4000-8000-000000000021'), '7.3:只有 orders 權限的客服為假(兩把獨立鑰匙)');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ③ 7.4 seed_default_push_event_settings 直接呼叫 + create_group_and_merchant 疊加。
-- =========================================================================
-- 這裡的 A 商家是本測試檔用「直接 insert into merchants」的方式建立(不是走
-- create_group_and_merchant),所以此刻還沒有任何 merchant_push_event_settings,直接呼叫
-- seed_default_push_event_settings 驗證種子邏輯本身;create_group_and_merchant 的疊加效果
-- 留給下面用 onboarding_merchant 另外驗證。
select seed_default_push_event_settings('ec500000-0000-4000-8000-000000000021');
select seed_default_push_event_settings('ec500000-0000-4000-8000-000000000021'); -- 冪等

select is(
  (select count(*)::int from merchant_push_event_settings where merchant_id = 'ec500000-0000-4000-8000-000000000021'),
  4,
  '7.4:seed_default_push_event_settings 種入剛好 4 筆且冪等(重複呼叫不新增)'
);

select is(
  (select row(enabled, message_title)
   from merchant_push_event_settings
   where merchant_id = 'ec500000-0000-4000-8000-000000000021' and event_type = 'booking_created')::text,
  row(false, '新訂單通知')::text,
  '2.2:booking_created 預設標題正確,enabled 一律預設關閉'
);

select is(
  (select message_body from merchant_push_event_settings
   where merchant_id = 'ec500000-0000-4000-8000-000000000021' and event_type = 'booking_updated'),
  '{{booking_date}} {{customer_name}}:{{change_summary}}',
  '2.2:booking_updated 預設內文包含 {{change_summary}} 變數'
);

select throws_ok(
  $$insert into merchant_push_event_settings (merchant_id, event_type) values ('ec500000-0000-4000-8000-000000000021', 'not_a_real_event')$$,
  '23514', null,
  '2.2:event_type CHECK 約束擋下不合法的事件類型'
);

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000008');
select create_group_and_merchant('推播通知種子測試店', 'in_store_beauty') \gset onboarding_merchant_
select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_push_event_settings where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  4,
  '7.4(核心必測):create_group_and_merchant 建立商家後,merchant_push_event_settings 剛好 4 筆'
);

-- 回歸驗證:疊加後既有其他模組的種子函式仍然照跑。
select is(
  (select count(*)::int from payment_methods where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid) > 0,
  true,
  '回歸驗證:create_group_and_merchant 疊加 seed_default_push_event_settings 後,既有 seed_default_payment_methods 沒有被蓋掉'
);
select is(
  (select count(*)::int from merchant_line_event_settings where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  5,
  '回歸驗證:既有 seed_default_line_event_settings(模組11)沒有被蓋掉'
);

-- =========================================================================
-- ④ 7.9 update_push_event_setting 權限邊界(security invoker,靠 RLS 把關)。
-- =========================================================================
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000003'); -- 無授權客服
select throws_ok(
  $$select update_push_event_setting('ec500000-0000-4000-8000-000000000021', 'booking_created', true, '標題', '內文')$$,
  'P0002', null,
  '7.9:無授權客服呼叫 update_push_event_setting 被 RLS 靜默擋下(0 筆更新,轉成明確錯誤)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000004'); -- push_notification 客服
select lives_ok(
  $$select update_push_event_setting('ec500000-0000-4000-8000-000000000021', 'booking_created', true, '客服改的標題', '客服改的內文')$$,
  '7.9:被授權 push_notification 的客服呼叫 update_push_event_setting 成功'
);
select pg_temp.test_clear_auth();

select is(
  (select row(enabled, message_title) from merchant_push_event_settings
   where merchant_id = 'ec500000-0000-4000-8000-000000000021' and event_type = 'booking_created')::text,
  row(true, '客服改的標題')::text,
  '7.9:更新內容確實寫入'
);

-- 跨商家隔離:B 店管理員看不到 A 店的推播事件設定。
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from merchant_push_event_settings where merchant_id = 'ec500000-0000-4000-8000-000000000021'),
  0,
  '3.21 等效/跨商家隔離:B 店管理員看不到 A 店的 merchant_push_event_settings'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 2.3 push_notification_log:CHECK 約束、一般角色無法寫入、SELECT 依權限。
-- =========================================================================
select throws_ok(
  $$insert into push_notification_log (merchant_id, event_type, status) values ('ec500000-0000-4000-8000-000000000021', 'booking_created', 'not_a_real_status')$$,
  '23514', null,
  '2.3:status CHECK 約束擋下不合法的狀態值'
);
select throws_ok(
  $$insert into push_notification_log (merchant_id, event_type, status, skip_reason) values ('ec500000-0000-4000-8000-000000000021', 'booking_created', 'skipped', 'not_a_real_reason')$$,
  '23514', null,
  '2.3:skip_reason CHECK 約束擋下不合法的原因值'
);

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into push_notification_log (merchant_id, event_type, status) values ('ec500000-0000-4000-8000-000000000021', 'booking_created', 'sent')$$,
  '42501', null,
  '2.3(核心必測):push_notification_log 沒有 INSERT 政策,商家管理員也被擋下'
);
select pg_temp.test_clear_auth();

-- 用超級使用者身分(不受 RLS 限制)模擬 Edge Function service role 寫入一筆記錄。
-- 2026-09-25:staff_id 欄位已移除(§3.2),收件人改用 target_type/target_id 表示(§2.4)。
insert into push_notification_log (merchant_id, event_type, booking_id, target_type, target_id, status, skip_reason, device_count, success_count, rendered_title, rendered_body)
values ('ec500000-0000-4000-8000-000000000021', 'booking_created', null, 'staff', 'ec500000-0000-4000-8000-000000000061', 'sent', null, 1, 1, '新訂單通知', '測試內文');

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from push_notification_log where merchant_id = 'ec500000-0000-4000-8000-000000000021'),
  1,
  '2.3:商家管理員可以 SELECT 到 Edge Function 寫入的發送記錄'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000002'); -- B店管理員
select is(
  (select count(*)::int from push_notification_log where merchant_id = 'ec500000-0000-4000-8000-000000000021'),
  0,
  '2.3/跨商家隔離:B 店管理員看不到 A 店的發送記錄'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ 2.4 push_reminder_dedupe_log:冪等主鍵、完全沒有 RLS 政策(核心必測)。
-- =========================================================================
-- 先準備一筆真的 booking(冪等表的 booking_id 有外鍵)。用超級使用者身分直接插入,避免牽扯
-- create_booking 完整驗證邏輯(不是本測試檔的重點)。
insert into bookings (id, merchant_id, staff_id, start_at, end_at, customer_name, customer_phone, status, created_by_role)
values ('ec500000-0000-4000-8000-000000000091', 'ec500000-0000-4000-8000-000000000021', 'ec500000-0000-4000-8000-000000000061', now() + interval '1 day', now() + interval '1 day 1 hour', '測試客戶', '0900000000', 'accepted', 'admin');

select lives_ok(
  $$insert into push_reminder_dedupe_log (booking_id, reminder_date) values ('ec500000-0000-4000-8000-000000000091', current_date)$$,
  '2.4:第一次插入成功'
);

-- WITH 子句包資料異動陳述式必須是頂層陳述式,這裡改成「先執行第二次 insert(靜默受 on conflict
-- do nothing 影響)→ 另外查詢確認仍然只有 1 筆」兩個獨立陳述式。
insert into push_reminder_dedupe_log (booking_id, reminder_date)
values ('ec500000-0000-4000-8000-000000000091', current_date)
on conflict (booking_id, reminder_date) do nothing;

select is(
  (select count(*)::int from push_reminder_dedupe_log
   where booking_id = 'ec500000-0000-4000-8000-000000000091' and reminder_date = current_date),
  1,
  '2.4(核心必測):同一個 (booking_id, reminder_date) 第二次插入被主鍵擋下(on conflict do nothing,仍然只有 1 筆)'
);

select lives_ok(
  $$insert into push_reminder_dedupe_log (booking_id, reminder_date) values ('ec500000-0000-4000-8000-000000000091', current_date + 1)$$,
  '2.4:不同 reminder_date 可以正常各自插入'
);

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from push_reminder_dedupe_log where booking_id = 'ec500000-0000-4000-8000-000000000091'),
  0,
  '2.4(核心必測):沒有任何 RLS 政策,商家管理員也完全看不到冪等紀錄表'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ §3.3 get_staff_push_status(取代 7.5 get_staff_push_subscription_count):
-- 管理員可看「裝置數 + 有沒有開啟任何事件」,不回傳任何 endpoint 內容。
--
-- ⚠️ 2026-09-25:函式改名/改回傳值的理由見 §3.3 —— 裝置登記現在屬於登入帳號,所以
--    「已開通 N 台」不再等於「他會收到這間店的通知」。原本兩條斷言的驗證意圖完全保留。
-- =========================================================================
select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000001');
select is(
  get_staff_push_status('ec500000-0000-4000-8000-000000000061'),
  jsonb_build_object('device_count', 1, 'any_event_enabled', false),
  '§3.3:商家管理員查詢服務人員甲的推播狀態 —— 有 1 台裝置(①留下的那一筆),但沒有任何事件訂閱,所以 any_event_enabled=false'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec500000-0000-4000-8000-000000000002'); -- B店管理員
select throws_ok(
  $$select get_staff_push_status('ec500000-0000-4000-8000-000000000061')$$,
  '42501', null,
  '§3.3(核心必測):B店管理員查詢 A 店服務人員的推播狀態被擋下(跨商家隔離)'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
