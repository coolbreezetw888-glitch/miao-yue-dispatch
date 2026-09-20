-- 模組 11(LINE 通知)— 對應規格書 .project/specs/LINE通知.md 第一節(1.1~1.6)、一之二節、
-- 規則 2.1/2.9/2.10、3.1~3.3/3.16/3.17/3.20。這支檔案涵蓋:CHECK 約束/預設值/RLS-only 表格保護、
-- merchant_staff 既有 RLS 政策文字沒有變動 + 新觸發器正確擋下一般異動、憑證管理僅限管理員(核心必測)、
-- can_manage_line_notification 權限邊界、seed_default_line_event_settings 疊加 create_group_and_merchant。
begin;

select plan(42);

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
-- Fixture:两間商家(A/B)。A 商家:管理員 + 3 種客服(無授權/line_notification/orders-only)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ec000000-0000-4000-8000-000000000001', 'pgtap-m11-admin-a@test.local'),
  ('ec000000-0000-4000-8000-000000000002', 'pgtap-m11-admin-b@test.local'),
  ('ec000000-0000-4000-8000-000000000003', 'pgtap-m11-agent-none@test.local'),
  ('ec000000-0000-4000-8000-000000000004', 'pgtap-m11-agent-line@test.local'),
  ('ec000000-0000-4000-8000-000000000005', 'pgtap-m11-agent-orders@test.local'),
  ('ec000000-0000-4000-8000-000000000006', 'pgtap-m11-seed-onboarding@test.local');

insert into groups (id) values
  ('ec000000-0000-4000-8000-000000000011'),
  ('ec000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000011', 'LINE通知測試A店', 'in_store_beauty'),
  ('ec000000-0000-4000-8000-000000000022', 'ec000000-0000-4000-8000-000000000012', 'LINE通知測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name) values
  ('ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000001', 'A店管理員'),
  ('ec000000-0000-4000-8000-000000000022', 'ec000000-0000-4000-8000-000000000002', 'B店管理員');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at) values
  ('ec000000-0000-4000-8000-000000000051', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000003', '客服-無授權', 'pgtap-m11-agent-none@test.local', 'active', now()),
  ('ec000000-0000-4000-8000-000000000052', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000004', '客服-line通知', 'pgtap-m11-agent-line@test.local', 'active', now()),
  ('ec000000-0000-4000-8000-000000000053', 'ec000000-0000-4000-8000-000000000021', 'ec000000-0000-4000-8000-000000000005', '客服-orders', 'pgtap-m11-agent-orders@test.local', 'active', now());

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('ec000000-0000-4000-8000-000000000052', 'line_notification', true),
  ('ec000000-0000-4000-8000-000000000053', 'orders', true);

insert into merchant_staff (id, merchant_id, name, phone) values
  ('ec000000-0000-4000-8000-000000000061', 'ec000000-0000-4000-8000-000000000021', '服務人員甲', '0911111111');

-- =========================================================================
-- ① §1.1/1.2/1.3/1.4/1.5:CHECK 約束 + RLS-only 表格,一般角色無法直接讀寫。
-- =========================================================================
select throws_ok(
  $$insert into merchant_line_event_settings (merchant_id, event_type)
    values ('ec000000-0000-4000-8000-000000000021', 'not_a_real_event')$$,
  '23514', null,
  '1.2:event_type CHECK 約束擋下不合法的事件類型'
);

select throws_ok(
  $$insert into line_notification_log (merchant_id, event_type, target_type, status)
    values ('ec000000-0000-4000-8000-000000000021', 'booking_created', 'admin', 'not_a_real_status')$$,
  '23514', null,
  '1.3:status CHECK 約束擋下不合法的狀態值'
);

select throws_ok(
  $$insert into line_notification_log (merchant_id, event_type, target_type, status, skip_reason)
    values ('ec000000-0000-4000-8000-000000000021', 'booking_created', 'admin', 'skipped', 'not_a_real_reason')$$,
  '23514', null,
  '1.3:skip_reason CHECK 約束擋下不合法的原因值'
);

select throws_ok(
  $$insert into line_binding_codes (merchant_id, target_type, target_id, code, expires_at)
    values ('ec000000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), '12abc', now() + interval '10 minutes')$$,
  '23514', null,
  '1.4:code CHECK 約束擋下非 6 碼數字格式'
);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select throws_ok(
  $$insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token)
    values ('ec000000-0000-4000-8000-000000000021', 'x', 'y', 'z')$$,
  '42501', null,
  '3.21:merchant_line_configs 沒有任何 RLS 政策,一般角色直接 insert 被擋下'
);

select throws_ok(
  $$insert into line_binding_codes (merchant_id, target_type, target_id, code, expires_at)
    values ('ec000000-0000-4000-8000-000000000021', 'admin', gen_random_uuid(), '123456', now() + interval '10 minutes')$$,
  '42501', null,
  '3.21:line_binding_codes 沒有任何 RLS 政策,一般角色直接 insert 被擋下'
);

select is(
  (select count(*)::int from line_webhook_events),
  0,
  '3.21:line_webhook_events 一般角色 SELECT 不到任何資料(沒有政策)'
);

select throws_ok(
  $$insert into line_notification_log (merchant_id, event_type, target_type, status)
    values ('ec000000-0000-4000-8000-000000000021', 'booking_created', 'admin', 'sent')$$,
  '42501', null,
  '3.21:line_notification_log 沒有 INSERT 政策,一般角色直接 insert 被擋下'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ② 3.20:seed_default_line_event_settings 直接呼叫 + create_group_and_merchant 疊加。
-- =========================================================================
select seed_default_line_event_settings('ec000000-0000-4000-8000-000000000021');
select seed_default_line_event_settings('ec000000-0000-4000-8000-000000000021'); -- 冪等

select is(
  (select count(*)::int from merchant_line_event_settings where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  5,
  '3.20:seed_default_line_event_settings 種入剛好 5 筆且冪等'
);

select is(
  (select row(enabled, notify_admin, notify_agent, notify_staff, notify_member)
   from merchant_line_event_settings
   where merchant_id = 'ec000000-0000-4000-8000-000000000021' and event_type = 'booking_created')::text,
  row(false, true, false, false, false)::text,
  '1.2:booking_created 預設對象正確(enabled 一律預設關閉)'
);

select is(
  (select row(enabled, notify_admin, notify_agent, notify_staff, notify_member)
   from merchant_line_event_settings
   where merchant_id = 'ec000000-0000-4000-8000-000000000021' and event_type = 'booking_confirmed')::text,
  row(false, false, false, true, true)::text,
  '1.2:booking_confirmed 預設對象正確'
);

select is(
  (select row(enabled, notify_admin, notify_agent, notify_staff, notify_member)
   from merchant_line_event_settings
   where merchant_id = 'ec000000-0000-4000-8000-000000000021' and event_type = 'booking_completed')::text,
  row(false, false, false, false, true)::text,
  '1.2:booking_completed 預設對象正確'
);

select is(
  (select row(enabled, notify_admin, notify_agent, notify_staff, notify_member)
   from merchant_line_event_settings
   where merchant_id = 'ec000000-0000-4000-8000-000000000021' and event_type = 'staff_leave_created')::text,
  row(false, true, false, false, false)::text,
  '1.2:staff_leave_created 預設對象正確'
);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000006');
select create_group_and_merchant('LINE通知種子測試店', 'in_store_beauty') \gset onboarding_merchant_
select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_line_event_settings where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  5,
  '3.20:create_group_and_merchant 建立商家後,merchant_line_event_settings 剛好 5 筆'
);

-- create_group_and_merchant 疊加後,既有其他模組的種子函式仍然照跑(回歸驗證,對應模組 7/8/9/10
-- 已踩過「疊加時蓋掉舊版本」的坑)。
select is(
  (select count(*)::int from payment_methods where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid) > 0,
  true,
  '回歸驗證:create_group_and_merchant 疊加 seed_default_line_event_settings 後,既有 seed_default_payment_methods 沒有被蓋掉'
);
select is(
  (select count(*)::int from merchant_member_settings where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  1,
  '回歸驗證:既有 seed_default_member_settings 沒有被蓋掉'
);

-- =========================================================================
-- ③ 3.17:can_manage_line_notification 權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select ok(private.can_manage_line_notification('ec000000-0000-4000-8000-000000000021'), '3.17:商家管理員永遠為真');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003');
select ok(not private.can_manage_line_notification('ec000000-0000-4000-8000-000000000021'), '3.17:無授權客服為假');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004');
select ok(private.can_manage_line_notification('ec000000-0000-4000-8000-000000000021'), '3.17:被授權 line_notification 的客服為真');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ 規則 2.1(核心必測):憑證管理三支函式只認商家管理員,line_notification 客服也被擋下。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004'); -- 客服-line_notification
select throws_ok(
  $$select set_merchant_line_credentials('ec000000-0000-4000-8000-000000000021', 'chid', 'secret', 'token')$$,
  '42501', null,
  '2.1:被授權 line_notification 的客服呼叫 set_merchant_line_credentials 仍被擋下'
);
select throws_ok(
  $$select get_merchant_line_config_status('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '2.1:被授權 line_notification 的客服呼叫 get_merchant_line_config_status 仍被擋下'
);
select throws_ok(
  $$select disconnect_merchant_line('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '2.1:被授權 line_notification 的客服呼叫 disconnect_merchant_line 仍被擋下'
);
-- 對照組:同一位客服呼叫 update_line_event_setting 可以成功(確認只有憑證管理這幾支特別鎖死)。
select lives_ok(
  $$select update_line_event_setting('ec000000-0000-4000-8000-000000000021', 'booking_created', true, true, false, false, false, '測試文案')$$,
  '2.1 對照組:被授權 line_notification 的客服呼叫 update_line_event_setting 成功'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001'); -- 商家管理員
select lives_ok(
  $$select set_merchant_line_credentials('ec000000-0000-4000-8000-000000000021', 'chid-001', 'secret-001', 'token-0123456789')$$,
  '2.1/3.1:商家管理員設定憑證成功'
);

-- merchant_line_configs 沒有任何 RLS 政策(3.21 刻意設計),就算是商家管理員本人,直接對這張表
-- 下 SELECT 也會被 RLS 擋成 0 筆——這裡改用 get_merchant_line_config_status(3.2,SECURITY DEFINER)
-- 讀取,才是規格書設計的正確讀取路徑。
select is(
  (get_merchant_line_config_status('ec000000-0000-4000-8000-000000000021')->>'is_connected')::boolean,
  false,
  '3.1:寫入憑證後 is_connected 正確重設為 false(透過 get_merchant_line_config_status 讀取)'
);

select is(
  (get_merchant_line_config_status('ec000000-0000-4000-8000-000000000021')->>'channel_access_token_masked'),
  '••••' || right('token-0123456789', 4),
  '3.2:channel_access_token 遮蔽格式正確,只顯示末 4 碼'
);
select pg_temp.test_clear_auth();

-- 用超級使用者身分(不受 RLS 限制)手動把 is_connected 打開(模擬 line-test-connection 成功),
-- 測試 disconnect 不受連線狀態影響、也不影響其餘四張表。
update merchant_line_configs set is_connected = true, line_bot_user_id = 'Utestbotuser0001'
where merchant_id = 'ec000000-0000-4000-8000-000000000021';

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');
select lives_ok(
  $$select disconnect_merchant_line('ec000000-0000-4000-8000-000000000021')$$,
  '3.3:商家管理員解除串接成功'
);
select is(
  (select count(*)::int from merchant_line_configs where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  0,
  '3.3:解除串接後 merchant_line_configs 這筆確實被刪除'
);
select is(
  (select count(*)::int from merchant_line_event_settings where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  5,
  '判斷 12/3.3:解除串接不影響 merchant_line_event_settings(仍是 5 筆)'
);

select is(
  (get_merchant_line_config_status('ec000000-0000-4000-8000-000000000021')->>'is_connected')::boolean,
  false,
  '3.2:查無資料時回傳「尚未串接」的預設狀態,不報錯'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ 一之二節:既有 merchant_staff RLS 政策文字完全沒有變動 + 新觸發器正確運作(規則 2.9,核心必測)。
-- =========================================================================
select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'merchant_staff_update'),
  'private.is_merchant_admin(merchant_id)',
  '一之二節:merchant_staff_update 政策定義完全沒有變動(保護靠額外的觸發器,不是改政策)'
);
select is(
  (select pg_get_expr(polqual, polrelid)::text from pg_policy where polname = 'merchant_staff_select'),
  '(private.is_merchant_admin(merchant_id) OR private.can_manage_bookings(merchant_id) OR private.can_manage_team_leave(merchant_id) OR private.can_manage_commission_settings(merchant_id) OR private.can_view_payroll_reports(merchant_id) OR (user_id = auth.uid()))',
  '一之二節:merchant_staff_select 政策定義本模組沒有變動(2026-09-21 模組 14 服務人員端規格書 3.3 疊加了 or user_id = auth.uid() 分支,這裡的期望值已同步更新,不是本模組造成的變動)'
);

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001');

select throws_ok(
  format($$update merchant_staff set line_user_id = 'Uattacker0001', line_bound = true where id = '%s'$$, 'ec000000-0000-4000-8000-000000000061'),
  '42501', null,
  '2.9(核心必測):商家管理員直接對 line_user_id/line_bound 發起 UPDATE 被觸發器擋下'
);

select lives_ok(
  format($$update merchant_staff set name = '服務人員甲(改名)' where id = '%s'$$, 'ec000000-0000-4000-8000-000000000061'),
  '2.9:同一張表只改姓名(不碰這兩個欄位)可以正常成功,觸發器沒有誤擋一般欄位編輯'
);

select is(
  (select name from merchant_staff where id = 'ec000000-0000-4000-8000-000000000061'),
  '服務人員甲(改名)',
  '2.9:姓名確實被改成功'
);

select is(
  (select line_bound from merchant_staff where id = 'ec000000-0000-4000-8000-000000000061'),
  false,
  '2.9:line_bound 沒有被剛才被擋下的異動影響,維持原值'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥ 規則 2.10:客服權限邊界(未授權/被授權/管理員三種情境)。
-- =========================================================================
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000003'); -- 無授權客服
select throws_ok(
  $$select update_line_event_setting('ec000000-0000-4000-8000-000000000021', 'booking_created', true, true, false, false, false, 'x')$$,
  'P0002', null,
  '2.10:無授權客服呼叫 update_line_event_setting 被 RLS 靜默擋下(0 筆更新,轉成明確錯誤)'
);
select throws_ok(
  $$select get_line_notification_log('ec000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '2.10:無授權客服呼叫 get_line_notification_log 被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000005'); -- orders-only 客服
select throws_ok(
  $$select update_line_event_setting('ec000000-0000-4000-8000-000000000021', 'booking_created', true, true, false, false, false, 'x')$$,
  'P0002', null,
  '2.10:只有 orders 權限的客服呼叫 update_line_event_setting 依然被擋下(兩把獨立鑰匙)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000004'); -- line_notification 客服
select lives_ok(
  $$select get_line_notification_log('ec000000-0000-4000-8000-000000000021')$$,
  '2.10:被授權 line_notification 的客服呼叫 get_line_notification_log 成功'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000001'); -- 管理員
select lives_ok(
  $$select update_line_event_setting('ec000000-0000-4000-8000-000000000021', 'booking_created', true, true, false, false, false, '管理員改的文案')$$,
  '2.10:商家管理員呼叫 update_line_event_setting 成功'
);
select pg_temp.test_clear_auth();

-- 跨商家隔離:B 店管理員看不到 A 店的通知事件設定。
select pg_temp.test_set_auth('ec000000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from merchant_line_event_settings where merchant_id = 'ec000000-0000-4000-8000-000000000021'),
  0,
  '3.21/跨商家隔離:B 店管理員看不到 A 店的 merchant_line_event_settings'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
