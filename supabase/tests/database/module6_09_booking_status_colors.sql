-- 建單與訂單管理介面優化 §十 10.1-10.4(SPECS-INDEX #620):merchant_booking_status_colors
-- 資料表/預設值/種子函式/權限/update_merchant_booking_status_colors。
--
-- SPECS-INDEX #860(2026-09-30 補):同一張表的服務人員自助讀取函式
-- public.get_my_booking_status_colors(p_staff_id)——見下方 ⑤。
-- 放在這一支檔案(而不是 module14_*)是因為姊妹表的同類函式 get_my_calendar_state_styles
-- 也是釘在「表本身」那一支 module6_10_calendar_state_styles.sql 的 ⑥,組織方式跟著它走。
begin;

select plan(21);

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

insert into auth.users (id, email) values
  ('c9000000-0000-4000-8000-000000000001', 'pgtap-m6i-admin1@test.local'),
  ('c9000000-0000-4000-8000-000000000002', 'pgtap-m6i-admin2@test.local'),
  ('c9000000-0000-4000-8000-000000000003', 'pgtap-m6i-agent-orders@test.local'),
  ('c9000000-0000-4000-8000-000000000004', 'pgtap-m6i-agent-none@test.local'),
  -- #860 ⑤ 用:一店在職服務人員 X、一店離職服務人員 W、一店尚未開通登入的服務人員 V、二店服務人員 Y。
  ('c9000000-0000-4000-8000-000000000005', 'pgtap-m6i-staff-x@test.local'),
  ('c9000000-0000-4000-8000-000000000006', 'pgtap-m6i-staff-w@test.local'),
  ('c9000000-0000-4000-8000-000000000007', 'pgtap-m6i-staff-v@test.local'),
  ('c9000000-0000-4000-8000-000000000008', 'pgtap-m6i-staff-y@test.local');

insert into groups (id) values
  ('c9000000-0000-4000-8000-000000000011'),
  ('c9000000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000011', '顏色設定測試一店', 'in_store_beauty'),
  ('c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000012', '顏色設定測試二店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000001'),
  ('c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('c9000000-0000-4000-8000-000000000031', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000003', '客服-orders', 'pgtap-m6i-agent-orders@test.local', 'active', now(), '0900000301'),
  ('c9000000-0000-4000-8000-000000000032', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000004', '客服-無授權', 'pgtap-m6i-agent-none@test.local', 'active', now(), '0900000302');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('c9000000-0000-4000-8000-000000000031', 'orders', true);

-- #860 ⑤ 的 fixture:private.is_own_staff_row 的成立條件是
-- merchant_staff.id = p_staff_id and user_id = auth.uid() and status='active' and login_status='active',
-- 所以這裡刻意準備「四個條件只差一項」的三種人,把 is_own_staff_row 的每一半都蓋到:
--   X(041):一店、active/active           → 唯一應該讀得到的人
--   W(042):一店、status='removed'        → 離職(login_status 照樣 active,證明擋的是 status)
--   V(043):一店、login_status='invited'  → 還沒開通登入(status 照樣 active)
--   Y(044):二店、active/active           → 別家商家的在職服務人員(跨商家測試對象)
insert into merchant_staff (id, merchant_id, user_id, name, status, login_status, login_activated_at, phone) values
  ('c9000000-0000-4000-8000-000000000041', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000005', '服務人員X(一店在職)', 'active', 'active', now(), '0977333001'),
  ('c9000000-0000-4000-8000-000000000042', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000006', '服務人員W(一店已離職)', 'removed', 'active', now(), '0977333002'),
  ('c9000000-0000-4000-8000-000000000043', 'c9000000-0000-4000-8000-000000000021', 'c9000000-0000-4000-8000-000000000007', '服務人員V(一店未開通登入)', 'active', 'invited', null, '0977333003'),
  ('c9000000-0000-4000-8000-000000000044', 'c9000000-0000-4000-8000-000000000022', 'c9000000-0000-4000-8000-000000000008', '服務人員Y(二店在職)', 'active', 'active', now(), '0977333004');

-- =========================================================================
-- ① §10.1:查無資料時,查詢回傳 0 筆(前端 fallback 成 DEFAULT_BOOKING_STATUS_COLORS)。
-- =========================================================================
select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  0,
  '§10.1:商家還沒特別設定過顏色時,merchant_booking_status_colors 查無資料'
);

-- =========================================================================
-- ② §10.1:資料表 DEFAULT 值是實際量測後的真實色碼(對照 migration 註解記錄的來源)。
-- seed_default_booking_status_colors 只 grant 給 service_role/postgres(§10.2),pgTAP 測試檔案
-- 本身就是用 postgres 連線,直接呼叫不需要額外 test_set_auth。
-- =========================================================================
select lives_ok(
  $$select seed_default_booking_status_colors('c9000000-0000-4000-8000-000000000021')$$,
  '§10.2:seed_default_booking_status_colors(postgres 角色)執行成功'
);

select is(
  (select pending_confirmation_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#ebaa2d',
  '§10.1:pending_confirmation 預設色碼是實測值 #ebaa2d(對應 warn token)'
);

select is(
  (select accepted_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#1c6fd2',
  '§10.1:accepted 預設色碼是實測值 #1c6fd2(對應 brand token)'
);

select is(
  (select completed_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#1ea25d',
  '§10.1:completed 預設色碼是實測值 #1ea25d(對應 cta token)'
);

select is(
  (select cancelled_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#606d7f',
  '§10.1:cancelled 預設色碼是實測值 #606d7f(對應 muted-foreground token)'
);

-- 冪等:重複呼叫不會產生第二筆,也不會覆蓋(這裡先手動改一個值,再呼叫一次 seed,確認值不被蓋回預設)。
update merchant_booking_status_colors set completed_color = '#123456' where merchant_id = 'c9000000-0000-4000-8000-000000000021';
select seed_default_booking_status_colors('c9000000-0000-4000-8000-000000000021');

select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  1,
  '§10.2:重複呼叫 seed_default_booking_status_colors 不會產生第二筆'
);

select is(
  (select completed_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#123456',
  '§10.2:重複呼叫 seed_default_booking_status_colors 不會覆蓋商家已經自訂過的顏色(on conflict do nothing)'
);

-- =========================================================================
-- ③ §10.2:新商家建立時(create_group_and_merchant)自動種好一筆。
-- =========================================================================
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select create_group_and_merchant('顏色設定自動種子測試店', 'in_store_beauty') \gset new_merchant_

select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = :'new_merchant_create_group_and_merchant'::uuid),
  1,
  '§10.2:create_group_and_merchant 建立新商家時自動種入一筆 merchant_booking_status_colors'
);

-- =========================================================================
-- ④ §10.3/§10.4:權限——update_merchant_booking_status_colors。
-- =========================================================================
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000004');

select throws_ok(
  $$select update_merchant_booking_status_colors(
    'c9000000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#444444'
  )$$,
  '42501', null,
  '§10.3/§10.4:沒有 orders 權限的客服不能修改訂單狀態顏色'
);

select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select lives_ok(
  $$select update_merchant_booking_status_colors(
    'c9000000-0000-4000-8000-000000000021', '#111111', '#222222', '#333333', '#444444'
  )$$,
  '§10.3/§10.4:被授權 orders 的客服可以修改訂單狀態顏色'
);

select is(
  (select completed_color from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  '#333333',
  '§10.4:update_merchant_booking_status_colors 正確 upsert 新的顏色值'
);

select pg_temp.test_clear_auth();

-- §10.3:SELECT 開放給任何看得到訂單的人(private.can_manage_bookings),被授權 orders 的客服
-- 應該讀得到目前的顏色設定(即使不是自己改的)。
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000003');

select is(
  (select count(*)::int from merchant_booking_status_colors where merchant_id = 'c9000000-0000-4000-8000-000000000021'),
  1,
  '§10.3:被授權 orders 的客服可以 SELECT 到訂單狀態顏色設定'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑤ SPECS-INDEX #860:public.get_my_booking_status_colors(p_staff_id)
--    ——服務人員自助讀取自己所屬商家的四個狀態色碼,讓服務人員端行事曆色塊跟商家端一致。
--    寫法比照姊妹表的既有先例 module6_10_calendar_state_styles.sql 的 ⑥
--    (get_my_calendar_state_styles:正向讀到商家剛設定的值 + 反向 42501)。
--
--    此刻一店的四個色碼已經被 ④ 的 update_merchant_booking_status_colors 改成
--    #111111 / #222222 / #333333 / #444444 —— 正向那幾條就是驗「服務人員讀到的,
--    正是商家設定頁剛剛存下去的那組值」,不是驗預設值。
--
--    二店另外給一組完全不同的色碼:這樣「跨商家讀不到」才有實際可偷的東西
--    (若哪天 is_own_staff_row 那道檢查被拿掉,⑤-6 會直接讀到二店的 #aaaaaa 而不再拋 42501)。
-- =========================================================================
select seed_default_booking_status_colors('c9000000-0000-4000-8000-000000000022');
update merchant_booking_status_colors
   set pending_confirmation_color = '#aaaaaa',
       accepted_color = '#bbbbbb',
       completed_color = '#cccccc',
       cancelled_color = '#dddddd'
 where merchant_id = 'c9000000-0000-4000-8000-000000000022';

select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000005'); -- 服務人員 X(一店、active/active)

-- ⑤-1~4:四個 key 全部都要驗,不能只驗一個(四個色碼是分開挑欄位組出來的,漏一個不會被發現)。
select is(
  (get_my_booking_status_colors('c9000000-0000-4000-8000-000000000041'::uuid) ->> 'pending_confirmation_color'),
  '#111111',
  '#860:X 自助讀取到商家設定的「待確認」色碼(跟商家設定頁一致)'
);

select is(
  (get_my_booking_status_colors('c9000000-0000-4000-8000-000000000041'::uuid) ->> 'accepted_color'),
  '#222222',
  '#860:X 自助讀取到商家設定的「已確認」色碼'
);

select is(
  (get_my_booking_status_colors('c9000000-0000-4000-8000-000000000041'::uuid) ->> 'completed_color'),
  '#333333',
  '#860:X 自助讀取到商家設定的「已完成」色碼'
);

select is(
  (get_my_booking_status_colors('c9000000-0000-4000-8000-000000000041'::uuid) ->> 'cancelled_color'),
  '#444444',
  '#860:X 自助讀取到商家設定的「已取消」色碼'
);

-- ⑤-5:回傳形狀——只有那 4 個 key,不含 merchant_id / created_at / updated_at。
-- 這是「改用函式而不是放寬表層 SELECT 政策」的核心賣點(表層政策會把整列、含未來新增的欄位
-- 都給出去),所以把它釘死:哪天有人把函式改成 select c.* / to_jsonb(c),這一條會紅。
select is(
  (select array_agg(k order by k)
     from jsonb_object_keys(get_my_booking_status_colors('c9000000-0000-4000-8000-000000000041'::uuid)) k)::text,
  (array['accepted_color', 'cancelled_color', 'completed_color', 'pending_confirmation_color'])::text,
  '#860:回傳只含那 4 個色碼 key,沒有 merchant_id / created_at / updated_at 等多餘欄位'
);

-- ⑤-6(核心必測,對應規則 2.4):跨商家。X 傳入二店服務人員 Y 的 staff_id。
-- merchant_id 是函式內部用 private.staff_merchant_id(p_staff_id) 解出來的、呼叫端無法指定,
-- 所以這是「讀到別家商家顏色」唯一可能的輸入形狀——擋住它就等於結構上擋住全部。
select throws_ok(
  $$select get_my_booking_status_colors('c9000000-0000-4000-8000-000000000044'::uuid)$$,
  '42501', null,
  '#860 規則 2.4(核心必測):X 傳入二店服務人員 Y 的 staff_id 被擋下(讀不到別家商家的顏色)'
);

select pg_temp.test_clear_auth();

-- ⑤-7:離職(status='removed')。is_own_staff_row 的語意是「這間商家的『在職』服務人員本人」,
-- 這一半如果沒測到,哪天有人把 status 條件拿掉也不會有人發現。
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000006'); -- W(一店、status=removed)
select throws_ok(
  $$select get_my_booking_status_colors('c9000000-0000-4000-8000-000000000042'::uuid)$$,
  '42501', null,
  '#860:已離職(status=removed)的服務人員,連自己的 staff_id 都讀不到顏色設定'
);
select pg_temp.test_clear_auth();

-- ⑤-8:尚未開通登入(login_status='invited',status 照樣 active)。跟 ⑤-7 分開兩條,
-- 因為 is_own_staff_row 是 status 與 login_status 兩個獨立條件,只測一個會漏掉另一個。
select pg_temp.test_set_auth('c9000000-0000-4000-8000-000000000007'); -- V(一店、login_status=invited)
select throws_ok(
  $$select get_my_booking_status_colors('c9000000-0000-4000-8000-000000000043'::uuid)$$,
  '42501', null,
  '#860:還沒開通登入(login_status=invited)的服務人員,連自己的 staff_id 都讀不到顏色設定'
);
select pg_temp.test_clear_auth();

select * from finish();

rollback;
