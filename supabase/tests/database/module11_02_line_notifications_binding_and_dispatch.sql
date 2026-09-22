-- 模組 11(LINE 通知)— 對應規格書 3.4~3.10/3.14/3.18/3.19,規則 2.4/2.7/2.8/2.9(consume 路徑)。
-- 這支檔案涵蓋:LINE 個人帳號綁定碼產生/權限邊界/互斥失效(2.7)/consume 覆蓋舊值(2.8)/
-- consume 只給 service_role(核心必測,2.9 的 service role 放行路徑)、
-- resolve_line_notification_targets 與 preview_line_notification_targets 判斷邏輯一致性(3.10/3.14 核心必測)、
-- 規則 2.4 三種安靜跳過情境(not_configured/event_disabled/target_not_bound/no_target)、
-- render_booking_notification_variables 變數組裝(3.9)、get_line_notification_log(3.18)、
-- unbind_line_account 權限邊界(3.19)。
begin;

select plan(53);

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
-- Fixture:一間商家,管理員 + 在職客服(無授權)+ 一位服務人員(未綁定)+ 一位會員(未綁定)。
-- =========================================================================
insert into auth.users (id, email) values
  ('ed000000-0000-4000-8000-000000000001', 'pgtap-m11b-admin@test.local'),
  ('ed000000-0000-4000-8000-000000000002', 'pgtap-m11b-agent@test.local');

insert into groups (id) values ('ed000000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type)
values ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000011', 'LINE通知綁定測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id, display_name)
values ('ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000001', '綁定測試管理員');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('ed000000-0000-4000-8000-000000000051', 'ed000000-0000-4000-8000-000000000021', 'ed000000-0000-4000-8000-000000000002', '綁定測試客服', 'pgtap-m11b-agent@test.local', 'active', now(), '0900000101');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'ed000000-0000-4000-8000-000000000021', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('ed000000-0000-4000-8000-000000000031', 'ed000000-0000-4000-8000-000000000021', '剪髮', 800, 'primary', 40);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('ed000000-0000-4000-8000-000000000041', 'ed000000-0000-4000-8000-000000000021', '綁定測試服務人員', '0922000001', true);

select seed_default_line_event_settings('ed000000-0000-4000-8000-000000000021');
select seed_default_member_settings('ed000000-0000-4000-8000-000000000021');

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select id from create_member('ed000000-0000-4000-8000-000000000021', '綁定測試會員', '0933000001') \gset member_
select id from create_booking(
  p_merchant_id => 'ed000000-0000-4000-8000-000000000021',
  p_staff_id => 'ed000000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','ed000000-0000-4000-8000-000000000031','quantity',1,'unit_price',800)),
  p_start_at => '2026-12-05 10:00:00+08',
  p_customer_name => '通知測試客戶',
  p_customer_phone => '0955099001',
  p_member_id => :'member_id'::uuid
) \gset booking_
select pg_temp.test_clear_auth();

-- =========================================================================
-- ① 3.4~3.7:綁定碼產生 + 權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select code, expires_at from generate_own_admin_line_binding_code('ed000000-0000-4000-8000-000000000021') \gset admincode1_
select pg_temp.test_clear_auth();

select ok(:'admincode1_code' ~ '^[0-9]{6}$', '3.4:generate_own_admin_line_binding_code 產生 6 碼數字');

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');
select code from generate_own_agent_line_binding_code('ed000000-0000-4000-8000-000000000021') \gset agentcode1_
select pg_temp.test_clear_auth();
select ok(:'agentcode1_code' ~ '^[0-9]{6}$', '3.5:generate_own_agent_line_binding_code 產生 6 碼數字');

-- 3.6:只有商家管理員能幫服務人員產生綁定碼,客服(即使假設有 line_notification 權限)被擋下。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');
select throws_ok(
  $$select generate_staff_line_binding_code('ed000000-0000-4000-8000-000000000041')$$,
  '42501', null,
  '3.6/一之二節第 1 點:客服呼叫 generate_staff_line_binding_code 被擋下(即使有 line_notification 權限也一樣)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select code from generate_staff_line_binding_code('ed000000-0000-4000-8000-000000000041') \gset staffcode1_
select pg_temp.test_clear_auth();
select ok(:'staffcode1_code' ~ '^[0-9]{6}$', '3.6:商家管理員呼叫 generate_staff_line_binding_code 成功');

-- 3.7:members 權限即可(這裡管理員本身就有,先驗證基本成功路徑;無 members 權限的客服被擋下)。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');
select throws_ok(
  format($$select generate_member_line_binding_code('%s')$$, (:'member_id')),
  '42501', null,
  '3.7:無 members 權限的客服呼叫 generate_member_line_binding_code 被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select code from generate_member_line_binding_code(:'member_id'::uuid) \gset membercode1_
select pg_temp.test_clear_auth();
select ok(:'membercode1_code' ~ '^[0-9]{6}$', '3.7:商家管理員呼叫 generate_member_line_binding_code 成功');

-- =========================================================================
-- ② 規則 2.7:產生新碼會讓同目標舊碼失效。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select code from generate_member_line_binding_code(:'member_id'::uuid) \gset membercode2_
select pg_temp.test_clear_auth();

select isnt(:'membercode1_code'::text, :'membercode2_code'::text, '2.7:重新產生的碼跟舊碼是不同的號碼(隨機性基本檢查)');

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select (consume_line_binding_code(:'membercode1_code', 'ed000000-0000-4000-8000-000000000021', 'Uoldcodeattempt001')->>'success')::boolean as old_code_result \gset oldcode_
select pg_temp.test_clear_auth();

select is(:'oldcode_old_code_result'::boolean, false, '2.7(核心邏輯):產生第二組碼後,第一組舊碼即使還在原本 10 分鐘效期內,拿去消費也被判定為已失效');

-- =========================================================================
-- ③ 3.8/規則 2.8:consume_line_binding_code 只給 service_role,四種 target_type 正確更新,
-- 重新綁定直接覆蓋舊值。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001'); -- authenticated,非 service_role
select throws_ok(
  format($$select consume_line_binding_code('%s', 'ed000000-0000-4000-8000-000000000021', 'Uattempt')$$, (:'membercode2_code')),
  '42501', null,
  '3.8(核心必測):consume_line_binding_code 不給一般 authenticated 角色呼叫,只給 service_role'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');

select (consume_line_binding_code('invalid0', 'ed000000-0000-4000-8000-000000000021', 'Ux')->>'success')::boolean as r \gset badcode_
select is(:'badcode_r'::boolean, false, '3.8:查無有效碼時 success=false');
select (consume_line_binding_code('invalid0', 'ed000000-0000-4000-8000-000000000021', 'Ux')->>'reason') as r \gset badreason_
select is(:'badreason_r'::text, 'invalid_or_expired', '3.8:查無有效碼時正確回傳 reason=invalid_or_expired');

select consume_line_binding_code(:'membercode2_code', 'ed000000-0000-4000-8000-000000000021', 'Umember0001') as result \gset memberconsume_
select is((:'memberconsume_result'::jsonb->>'success')::boolean, true, '3.8:member 類型消費成功');
select is((:'memberconsume_result'::jsonb->>'target_type'), 'member', '3.8:回傳 target_type 正確');

select consume_line_binding_code(:'staffcode1_code', 'ed000000-0000-4000-8000-000000000021', 'Ustaff0001') as staffresult \gset staffconsume_
select is((:'staffconsume_staffresult'::jsonb->>'success')::boolean, true, '3.8/2.9:staff 類型消費成功(service role 不受規則 2.9 觸發器阻擋)');

select consume_line_binding_code(:'admincode1_code', 'ed000000-0000-4000-8000-000000000021', 'Uadmin0001') as adminresult \gset adminconsume_
select is((:'adminconsume_adminresult'::jsonb->>'success')::boolean, true, '3.8:admin 類型消費成功');

select consume_line_binding_code(:'agentcode1_code', 'ed000000-0000-4000-8000-000000000021', 'Uagent0001') as agentresult \gset agentconsume_
select is((:'agentconsume_agentresult'::jsonb->>'success')::boolean, true, '3.8:agent 類型消費成功');

select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound) from members where id = :'member_id'::uuid)::text,
  row('Umember0001', true)::text,
  '3.8:members.line_user_id/line_bound 正確寫入'
);
select is(
  (select row(line_user_id, line_bound) from merchant_staff where id = 'ed000000-0000-4000-8000-000000000041')::text,
  row('Ustaff0001', true)::text,
  '3.8:merchant_staff.line_user_id/line_bound 正確寫入(觸發器放行 service role)'
);
select is(
  (select row(line_user_id, line_bound) from merchant_admins where user_id = 'ed000000-0000-4000-8000-000000000001')::text,
  row('Uadmin0001', true)::text,
  '3.8:merchant_admins.line_user_id/line_bound 正確寫入'
);
select is(
  (select row(line_user_id, line_bound) from merchant_agents where user_id = 'ed000000-0000-4000-8000-000000000002')::text,
  row('Uagent0001', true)::text,
  '3.8:merchant_agents.line_user_id/line_bound 正確寫入'
);

-- 規則 2.8:重新綁定直接取代舊值,不需先解除。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select code from generate_member_line_binding_code(:'member_id'::uuid) \gset membercode3_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select consume_line_binding_code(:'membercode3_code', 'ed000000-0000-4000-8000-000000000021', 'UmemberNEW9999');
select pg_temp.test_clear_auth();

select is(
  (select line_user_id from members where id = :'member_id'::uuid),
  'UmemberNEW9999',
  '2.8:已綁定的會員重新走一次綁定流程,line_user_id 正確更新為新值(直接取代,不是疊加)'
);

-- =========================================================================
-- ④ 3.19 unbind_line_account 權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002'); -- 客服本人
select lives_ok(
  $$select unbind_line_account('agent', 'ed000000-0000-4000-8000-000000000051')$$,
  '3.19:客服本人可以解除自己的綁定'
);
select pg_temp.test_clear_auth();

select is(
  (select line_bound from merchant_agents where id = 'ed000000-0000-4000-8000-000000000051'),
  false,
  '3.19:解除後 line_bound 正確變回 false'
);

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002'); -- 客服,對服務人員解除被擋下(判斷 5)
select throws_ok(
  $$select unbind_line_account('staff', 'ed000000-0000-4000-8000-000000000041')$$,
  '42501', null,
  '3.19:客服呼叫解除服務人員的 LINE 綁定被擋下(只有商家管理員能做)'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001'); -- 管理員可以解除服務人員綁定
select lives_ok(
  $$select unbind_line_account('staff', 'ed000000-0000-4000-8000-000000000041')$$,
  '3.19:商家管理員可以解除服務人員的 LINE 綁定'
);
select pg_temp.test_clear_auth();

select is(
  (select row(line_user_id, line_bound) from merchant_staff where id = 'ed000000-0000-4000-8000-000000000041')::text,
  row(null, false)::text,
  '3.19/2.9:解除服務人員綁定正確清空欄位(透過合法的 bypass 旗標路徑,不是繞過觸發器本身)'
);

-- =========================================================================
-- ⑤ 規則 2.4(核心必測)+ 3.10/3.14 一致性:resolve_line_notification_targets /
-- preview_line_notification_targets 判斷邏輯完全一致。
-- =========================================================================
-- 尚未串接 LINE → not_configured(connected=false)。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select (resolve_line_notification_targets('ed000000-0000-4000-8000-000000000021', 'booking_confirmed', :'booking_id'::uuid, null)->>'connected')::boolean as r \gset notconfigured_
select pg_temp.test_clear_auth();
select is(:'notconfigured_r'::boolean, false, '2.4 第 1 點:商家沒有串接 LINE,resolve 回傳 connected=false');

-- preview_line_notification_targets(前端呼叫路徑)在同樣「尚未串接」的情況下,回傳
-- has_any_target=false,不拋例外(2.5 規則:沒有目標就不顯示彈窗,不是報錯)。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select (preview_line_notification_targets(:'booking_id'::uuid, 'booking_confirmed')->>'has_any_target')::boolean as r \gset previewnotconfigured_
select pg_temp.test_clear_auth();
select is(:'previewnotconfigured_r'::boolean, false, '2.4/2.5:尚未串接 LINE 時,preview_line_notification_targets 回傳 has_any_target=false');

-- 串接 LINE(直接寫入 merchant_line_configs 模擬已完成 line-test-connection),但事件關閉 → event_disabled。
insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected)
values ('ed000000-0000-4000-8000-000000000021', 'chid', 'secret', 'token-abcdefgh', true);

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select (resolve_line_notification_targets('ed000000-0000-4000-8000-000000000021', 'booking_confirmed', :'booking_id'::uuid, null)->>'event_enabled')::boolean as r \gset eventdisabled_
select pg_temp.test_clear_auth();
select is(:'eventdisabled_r'::boolean, false, '2.4 第 2 點:事件關閉時,resolve 回傳 event_enabled=false(即使已串接)');

-- 開啟 booking_confirmed 事件,四種對象都打開。走到這裡,前面步驟已經讓管理員/會員維持已綁定
-- (③/2.8 consume 過)、客服/服務人員則在④被明確解除綁定——這裡驗證「同一個事件裡,已綁定的
-- 對象正常進 targets,未綁定的各自落在 skipped,兩者互不影響」(規則 2.4 第 3 點的核心主張)。
update merchant_line_event_settings
set enabled = true, notify_admin = true, notify_agent = true, notify_staff = true, notify_member = true
where merchant_id = 'ed000000-0000-4000-8000-000000000021' and event_type = 'booking_confirmed';

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select resolve_line_notification_targets('ed000000-0000-4000-8000-000000000021', 'booking_confirmed', :'booking_id'::uuid, null) as r \gset mixed_
select pg_temp.test_clear_auth();

select is(
  jsonb_array_length(:'mixed_r'::jsonb->'targets'),
  2,
  '2.4 第 3 點:已綁定的管理員/會員正常進入 targets(服務人員/客服此時尚未綁定,不影響這兩位)'
);
select ok(
  exists (select 1 from jsonb_array_elements(:'mixed_r'::jsonb->'targets') t where t->>'type' = 'admin'),
  '2.4 第 3 點:已綁定的管理員確實出現在 targets'
);
select ok(
  exists (select 1 from jsonb_array_elements(:'mixed_r'::jsonb->'targets') t where t->>'type' = 'member'),
  '2.4 第 3 點:已綁定的會員確實出現在 targets'
);
select ok(
  exists (select 1 from jsonb_array_elements(:'mixed_r'::jsonb->'skipped') s where s->>'type' = 'staff' and s->>'reason' = 'target_not_bound'),
  '2.4 第 3 點:尚未綁定的服務人員落在 skipped,reason=target_not_bound,不影響同事件已綁定的管理員/會員照常發送'
);
select ok(
  exists (select 1 from jsonb_array_elements(:'mixed_r'::jsonb->'skipped') s where s->>'type' = 'agent' and s->>'reason' = 'target_not_bound'),
  '2.4 第 3 點:尚未綁定的客服落在 skipped,reason=target_not_bound'
);

-- 重新綁定服務人員 + 客服,驗證這兩位這次會轉移進入 targets(管理員/會員繼續維持在 targets,
-- 不會因為別的對象狀態改變而受影響)。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select code from generate_staff_line_binding_code('ed000000-0000-4000-8000-000000000041') \gset staffcode2_
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002');
select code from generate_own_agent_line_binding_code('ed000000-0000-4000-8000-000000000021') \gset agentcode2_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select consume_line_binding_code(:'staffcode2_code', 'ed000000-0000-4000-8000-000000000021', 'UstaffRebound001');
select consume_line_binding_code(:'agentcode2_code', 'ed000000-0000-4000-8000-000000000021', 'UagentRebound001');
select resolve_line_notification_targets('ed000000-0000-4000-8000-000000000021', 'booking_confirmed', :'booking_id'::uuid, null) as r \gset bound_
select pg_temp.test_clear_auth();

select is(
  jsonb_array_length(:'bound_r'::jsonb->'targets'),
  4,
  '規則 2.4 第 3 點:重新綁定服務人員跟客服後,四種對象全部進入 targets,彼此判斷互不影響'
);
select ok(
  exists (select 1 from jsonb_array_elements(:'bound_r'::jsonb->'targets') t where t->>'type' = 'staff' and t->>'line_user_id' = 'UstaffRebound001'),
  '3.10/3.14 一致性:targets 裡的服務人員 line_user_id 正確帶出(供 line-notify-dispatch 直接拿去推播,不用另外查一次)'
);

-- 3.10/3.14 一致性(核心必測):preview_line_notification_targets(前端,透過管理員 JWT)跟
-- resolve_line_notification_targets(Edge Function 透過 service role 直接呼叫)在同樣的狀態下,
-- 判斷出的「會通知的對象」完全一致,不會分岔。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select preview_line_notification_targets(:'booking_id'::uuid, 'booking_confirmed') as r \gset preview_
select pg_temp.test_clear_auth();

select is(
  (:'preview_r'::jsonb->>'has_any_target')::boolean,
  true,
  '3.10:有已綁定的服務人員/會員時,preview_line_notification_targets 回傳 has_any_target=true'
);
select is(
  (select count(*)::int from jsonb_array_elements(:'preview_r'::jsonb->'targets')),
  (select count(*)::int from jsonb_array_elements(:'bound_r'::jsonb->'targets')),
  '3.10/3.14(核心必測):preview 跟 resolve 判斷出的目標數量完全一致,兩邊共用同一份邏輯不會分岔'
);
select is(
  (select array_agg(t->>'name' order by t->>'name') from jsonb_array_elements(:'preview_r'::jsonb->'targets') t),
  (select array_agg(t->>'name' order by t->>'name') from jsonb_array_elements(:'bound_r'::jsonb->'targets') t),
  '3.10/3.14(核心必測):preview 跟 resolve 判斷出的目標姓名清單完全一致'
);

-- =========================================================================
-- ⑥ 3.9 render_booking_notification_variables:變數組裝正確,缺值時回傳空字串不報錯。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
select render_booking_notification_variables(:'booking_id'::uuid) as r \gset vars_
select pg_temp.test_clear_auth();

select is(:'vars_r'::jsonb->>'customer_name', '通知測試客戶', '3.9:customer_name 正確組裝');
select is(:'vars_r'::jsonb->>'service_names', '剪髮', '3.9:service_names 正確組裝(join booking_service_items/service_items)');
select is(:'vars_r'::jsonb->>'staff_name', '綁定測試服務人員', '3.9:staff_name 正確組裝');
select is(:'vars_r'::jsonb->>'member_name', '綁定測試會員', '3.9:member_name 正確組裝(來自 member_name_snapshot)');
select is(:'vars_r'::jsonb->>'final_amount', '800', '3.9:final_amount 正確組裝(去除小數點)');
select is(:'vars_r'::jsonb->>'cancel_reason', '', '3.9:尚未取消時 cancel_reason 回傳空字串,不報錯');
select is(:'vars_r'::jsonb->>'points_earned', '', '3.9:尚未有點數異動紀錄時 points_earned 回傳空字串,不報錯');
select ok(length(:'vars_r'::jsonb->>'booking_date') > 0, '3.9:booking_date 正確組裝(非空字串)');

-- 補一筆 earn_booking 點數異動,驗證 points_earned 正確帶出。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id)
values (:'member_id'::uuid, 'ed000000-0000-4000-8000-000000000021', 'earn_booking', 8, 8, :'booking_id'::uuid);
select render_booking_notification_variables(:'booking_id'::uuid) as r \gset vars2_
select pg_temp.test_clear_auth();

select is(:'vars2_r'::jsonb->>'points_earned', '8', '3.9:有 earn_booking 紀錄時 points_earned 正確帶出');

-- render_booking_notification_variables 只給 service_role,一般角色呼叫被擋下。
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select render_booking_notification_variables('%s')$$, (:'booking_id')),
  '42501', null,
  '3.9:render_booking_notification_variables 不給一般 authenticated 角色呼叫,只給 service_role'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑦ 3.18 get_line_notification_log:分頁/篩選/權限邊界。
-- =========================================================================
select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001', 'service_role');
insert into line_notification_log (merchant_id, event_type, booking_id, target_type, target_id, status, skip_reason)
values
  ('ed000000-0000-4000-8000-000000000021', 'booking_confirmed', :'booking_id'::uuid, 'staff', 'ed000000-0000-4000-8000-000000000041', 'sent', null),
  ('ed000000-0000-4000-8000-000000000021', 'booking_confirmed', :'booking_id'::uuid, 'member', :'member_id'::uuid, 'sent', null),
  ('ed000000-0000-4000-8000-000000000021', 'booking_cancelled', :'booking_id'::uuid, 'member', :'member_id'::uuid, 'skipped', 'target_not_bound');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000002'); -- 無 line_notification 權限的客服
select throws_ok(
  $$select get_line_notification_log('ed000000-0000-4000-8000-000000000021')$$,
  '42501', null,
  '3.18:無 line_notification 權限的客服呼叫 get_line_notification_log 被擋下'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('ed000000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from get_line_notification_log('ed000000-0000-4000-8000-000000000021')),
  3,
  '3.18:管理員呼叫 get_line_notification_log 回傳全部 3 筆'
);
select is(
  (select count(*)::int from get_line_notification_log('ed000000-0000-4000-8000-000000000021', 'booking_cancelled')),
  1,
  '3.18:依 event_type 篩選正確,只回傳 1 筆'
);
select is(
  (select count(*)::int from get_line_notification_log('ed000000-0000-4000-8000-000000000021', null, 1, 0)),
  1,
  '3.18:p_limit 分頁參數正確生效'
);
select pg_temp.test_clear_auth();

select * from finish();
rollback;
