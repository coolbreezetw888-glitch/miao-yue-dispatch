-- SPECS-INDEX #977 第 7 批(2026-10-07):服務人員新增編輯訂單 — pgTAP ①:helper、標記分支、指紋、後台不受影響
-- migration 20261007100000_req977_staff_order_helpers.sql
-- 規格書 .project/specs/服務人員新增編輯訂單-第7批.md 第三節 3-1、3-2,第六節 6-1。
--
--   ①~⑦    指紋:5 支改過的函式拿掉 [req977-batch7] 段落(必要處把替換回去)後 = 改前指紋;
--            set / clear_staff_day_override(方案 B2 不需要改)指紋完全不變;同時核對 STABLE / SECURITY DEFINER / ACL
--   ⑧~⑯    private.staff_order_self_ok:本人 true;別人的 id、離職、未開通登入、行事曆關、新增編輯訂單關、
--            顯示會員資料關、未登入、null 一律 false
--   ⑰~⑳    4 支 private helper + staff_order_own_booking:authenticated / anon 都沒有 EXECUTE
--   ㉑~㉘   沒有標記時「可以自己下單的服務人員」呼叫 8 支既有函式全部 42501
--   ㉙~㉜   沒有標記時用他的身分 select bookings / members / service_items / payment_methods 都是 0 筆
--   ㉝~㊳   偽造標記:別人的 id / 別家的 id / 亂碼 / 標記是本人但商家不對 / 本人但開關關 ⇒ false 不報錯;
--            正向對照:標記是本人 + 對的商家 ⇒ true
--   ㊴~㊵   客服、管理員走 RLS 讀 bookings 不會報 permission denied(helper revoke authenticated 之後)
--   ㊶~㊹   後台不受影響:管理員 / 客服建單 created_by_role = admin / agent,操作紀錄 merchant_admin / agent
--   ㊺~㊻   管理員兼服務人員(沒有標記):建單仍記成 admin / merchant_admin
--   ㊼~㊾   get_booking_actor_names:服務人員 user id ⇒ 服務人員姓名(7-15);管理員、客服姓名不變
--   ㊿      bookings_created_by_role_check 多了 'staff'
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(50);

-- #987 第 10 批(2026-10-07):set_staff_day_override、clear_staff_day_override、create_booking 的錯誤訊息半形標點改成全形。
-- 這裡先把第 10 批改過的訊息換回舊訊息(完整 SQL 字串字面值,含單引號),再套原本的還原規則比指紋;
-- 第 10 批自己「只動訊息」的證明見 req987_0*_fullwidth_messages_*.sql。
create function pg_temp.req987_revert(p_src text) returns text language plpgsql immutable as $req987$
declare
  v_pairs text[] := array[
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$,
    $m$'客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$, $m$'客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$,
    $m$'單筆訂單最多只能設定 100,000 點，請確認是否多打了零'$m$, $m$'單筆訂單最多只能設定 100,000 點,請確認是否多打了零'$m$,
    $m$'這支電話底下有 % 位客戶，請先在建單畫面選擇這筆訂單是哪一位'$m$, $m$'這支電話底下有 % 位客戶,請先在建單畫面選擇這筆訂單是哪一位'$m$,
    $m$'找不到指定的會員，或會員不屬於這間商家/已被下架'$m$, $m$'找不到指定的會員,或會員不屬於這間商家/已被下架'$m$,
    $m$'紅利點數功能已關閉，無法設定派點'$m$, $m$'紅利點數功能已關閉,無法設定派點'$m$,
    $m$'客戶已變更，紅利折抵已重設，請重新確認後送出'$m$, $m$'客戶已變更,紅利折抵已重設,請重新確認後送出'$m$
  ];
begin
  for i in 1 .. array_length(v_pairs, 1) / 2 loop
    p_src := replace(p_src, v_pairs[2 * i - 1], v_pairs[2 * i]);
  end loop;
  return p_src;
end $req987$;



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

-- 只換 auth.uid(),連線角色維持 postgres(用來直接問 private helper:那幾支 authenticated 沒有 EXECUTE)。
create function pg_temp.test_set_uid(p_user_id uuid)
returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', 'authenticated')::text, true);
end;
$$;

-- ── Fixture(共用,#977 第 7 批 req977_05 ~ 09 同一份)────────────────────────────────
--   使用者:01 A 店管理員 / 03 A 店客服(orders)/ 04 甲(可以自己下單)/ 05 乙(協助,也可以自己下單)/
--           06 丙(同店另一位可以自己下單)/ 07 丁(已移除)/ 08 戊(行事曆檢視關)/ 09 B 店管理員 /
--           10 B 店庚(可以自己下單)/ 11 己(未開通登入)/ 12 辛(新增編輯訂單關)/ 13 壬(顯示會員資料關)/
--           14 A 店管理員兼服務人員癸(可以自己下單)
insert into auth.users (id, email) values
  ('f9777000-0000-4000-8000-000000000001', 'pgtap-r977g-admin@test.local'),
  ('f9777000-0000-4000-8000-000000000003', 'pgtap-r977g-agent@test.local'),
  ('f9777000-0000-4000-8000-000000000004', 'pgtap-r977g-jia@test.local'),
  ('f9777000-0000-4000-8000-000000000005', 'pgtap-r977g-yi@test.local'),
  ('f9777000-0000-4000-8000-000000000006', 'pgtap-r977g-bing@test.local'),
  ('f9777000-0000-4000-8000-000000000007', 'pgtap-r977g-ding@test.local'),
  ('f9777000-0000-4000-8000-000000000008', 'pgtap-r977g-wu@test.local'),
  ('f9777000-0000-4000-8000-000000000009', 'pgtap-r977g-adminB@test.local'),
  ('f9777000-0000-4000-8000-000000000010', 'pgtap-r977g-geng@test.local'),
  ('f9777000-0000-4000-8000-000000000011', 'pgtap-r977g-ji@test.local'),
  ('f9777000-0000-4000-8000-000000000012', 'pgtap-r977g-xin@test.local'),
  ('f9777000-0000-4000-8000-000000000013', 'pgtap-r977g-ren@test.local'),
  ('f9777000-0000-4000-8000-000000000014', 'pgtap-r977g-gui@test.local');

insert into groups (id) values
  ('f9777000-0000-4000-8000-000000000015'),
  ('f9777000-0000-4000-8000-000000000016');
insert into merchants (id, group_id, name, industry_type) values
  ('f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000015', '#977-7 A 店', 'on_site_dispatch'),
  ('f9777000-0000-4000-8000-000000000021', 'f9777000-0000-4000-8000-000000000016', '#977-7 B 店', 'on_site_dispatch');
insert into merchant_admins (id, merchant_id, user_id, display_name) values
  ('f9777000-0000-4000-8000-000000000025', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000001', '店主甲'),
  ('f9777000-0000-4000-8000-000000000026', 'f9777000-0000-4000-8000-000000000021', 'f9777000-0000-4000-8000-000000000009', '店主乙'),
  ('f9777000-0000-4000-8000-000000000027', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000014', '店主癸');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9777000-0000-4000-8000-000000000028', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000003', '客服甲', 'pgtap-r977g-agent@test.local', 'active', now(), '0900977728');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9777000-0000-4000-8000-000000000028', 'orders', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9777000-0000-4000-8000-000000000030', 'f9777000-0000-4000-8000-000000000020', '到府服務', 800, 'primary', 60),
  ('f9777000-0000-4000-8000-000000000031', 'f9777000-0000-4000-8000-000000000021', '到府服務', 800, 'primary', 60),
  ('f9777000-0000-4000-8000-000000000032', 'f9777000-0000-4000-8000-000000000020', '加購清潔', 300, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('f9777000-0000-4000-8000-000000000050', 'f9777000-0000-4000-8000-000000000020', '現金'),
  ('f9777000-0000-4000-8000-000000000052', 'f9777000-0000-4000-8000-000000000020', '轉帳'),
  ('f9777000-0000-4000-8000-000000000051', 'f9777000-0000-4000-8000-000000000021', '現金');
insert into material_cost_items (id, merchant_id, name, amount) values
  ('f9777000-0000-4000-8000-000000000055', 'f9777000-0000-4000-8000-000000000020', '冷媒', 200);

-- 服務人員(都開「商家後台編輯無時段限制」⇒ 建單不用布置時段)。
--   40 甲 / 41 乙 / 42 丙 / 43 丁(建單後改已移除)/ 44 戊(行事曆關)/ 46 B 店庚 / 45 己(建單後改未開通)/
--   47 辛(新增編輯訂單關)/ 48 壬(顯示會員資料關)/ 49 癸(管理員兼服務人員)
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone, can_create_edit_orders, show_member_info) values
  ('f9777000-0000-4000-8000-000000000040', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000004', '甲服務人員', 'monthly_salary', 'active', 'active', now(), true, '0900977740', true, true),
  ('f9777000-0000-4000-8000-000000000041', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000005', '乙服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977741', true, true),
  ('f9777000-0000-4000-8000-000000000042', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000006', '丙服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977742', true, true),
  ('f9777000-0000-4000-8000-000000000043', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000007', '丁服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977743', true, true),
  ('f9777000-0000-4000-8000-000000000044', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000008', '戊服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977744', true, true),
  ('f9777000-0000-4000-8000-000000000045', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000011', '己服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977745', true, true),
  ('f9777000-0000-4000-8000-000000000046', 'f9777000-0000-4000-8000-000000000021', 'f9777000-0000-4000-8000-000000000010', '庚服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977746', true, true),
  ('f9777000-0000-4000-8000-000000000047', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000012', '辛服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977747', false, true),
  ('f9777000-0000-4000-8000-000000000048', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000013', '壬服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977748', true, false),
  ('f9777000-0000-4000-8000-000000000049', 'f9777000-0000-4000-8000-000000000020', 'f9777000-0000-4000-8000-000000000014', '癸服務人員', 'piece_rate', 'active', 'active', now(), true, '0900977749', true, true);
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9777000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000042', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000043', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000044', 'staff_calendar_view', false),
  ('f9777000-0000-4000-8000-000000000045', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000046', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000047', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000048', 'staff_calendar_view', true),
  ('f9777000-0000-4000-8000-000000000049', 'staff_calendar_view', true);

-- 管理員建單用。
create function pg_temp.mk(p_staff uuid, p_start timestamptz, p_assistants uuid[] default '{}',
                           p_notes text default null, p_hide boolean default false, p_phone text default '0955977700')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9777000-0000-4000-8000-000000000020',
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => p_phone,
    p_customer_address => '台北市測試路 7 號',
    p_notes => p_notes,
    p_hide_notes_from_staff => p_hide,
    p_assistant_staff_ids => p_assistants,
    p_payment_method_id => 'f9777000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, timestamptz, uuid[], text, boolean, text) to authenticated;

-- A 店每天 08:00–22:00 營業(時間清單 / 時段開關要用)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9777000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

-- =========================================================================
-- ①~⑦ 指紋(拿掉 [req977-batch7] 段落、必要處把替換回去 = 改前指紋)+ 屬性 / ACL 跟改前相同
-- =========================================================================
create temp table r977g_fp on commit drop as
  select
    p.oid,
    p.provolatile::text || '/' || p.prosecdef::text || '/' || array_to_string(p.proacl, ',') as attrs,
    md5(
      replace(replace(replace(
        regexp_replace(pg_temp.req987_revert(
          -- 第 22 批 #1023:set_staff_day_override 多了一段「時段外不能開放」(有標記),拿掉後比對改前指紋。
          regexp_replace(replace(p.prosrc, E'\r\n', E'\n'),
            '  -- \[req1023-batch22 begin\].*?-- \[req1023-batch22 end\]\n\n', '', 'g')),
          '  -- \[req977-batch7 begin\].*?-- \[req977-batch7 end\]\n', '', 'g'),
        E'    )\n    ;\n', E'    );\n'),
        E'agent_match.agent_name,\n      ''(已移除的人員)'')', E'agent_match.agent_name, ''(已移除的人員)'')'),
        E'  ) agent_match on true\n  ;\n', E'  ) agent_match on true;\n')
    ) as reverted_md5,
    (replace(p.prosrc, E'\r\n', E'\n') ~ '\[req977-batch7 begin\]') as has_marker
  from pg_proc p;

select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'private.can_manage_bookings(uuid)'::regprocedure),
  'ba4717c05bbbe3ebb081ae0f46c7f08b|s/true/postgres=X/postgres,authenticated=X/postgres|true',
  '① can_manage_bookings:拿掉本批段落後 = 改前指紋;STABLE、SECURITY DEFINER、ACL 不變'
);
select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'private.current_actor_role_snapshot(uuid)'::regprocedure),
  '8bddc59402bbb4b0283227a3d3602183|s/true/postgres=X/postgres|true',
  '② current_actor_role_snapshot:拿掉本批段落後 = 改前指紋;屬性 / ACL 不變'
);
select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'private.current_actor_display_name(uuid)'::regprocedure),
  'c969d0a7833bae57365d0e8259ed532d|s/true/postgres=X/postgres|true',
  '③ current_actor_display_name:拿掉本批段落後 = 改前指紋;屬性 / ACL 不變'
);
select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'public.get_booking_actor_names(uuid, uuid[])'::regprocedure),
  '1f461b30a591a99981d3215d4a8f4c12|s/true/postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres|true',
  '④ get_booking_actor_names:拿掉本批段落並把兩處斷行換回去後 = 改前指紋;屬性 / ACL 不變'
);
select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'public.set_staff_day_override(uuid, date, time, time, boolean)'::regprocedure),
  'ed26190fca9e17b0cc98844920fcbfd7|v/true/postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres|false',
  '⑤ set_staff_day_override:方案 B2 不需要改,指紋與改前完全相同、沒有本批段落'
);
select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'public.clear_staff_day_override(uuid, date, time, time)'::regprocedure),
  '774ae843a7b3b90a343f5ae3f313b511|v/true/postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres|false',
  '⑥ clear_staff_day_override:方案 B2 不需要改,指紋與改前完全相同、沒有本批段落'
);
select is(
  (select reverted_md5 || '|' || attrs || '|' || has_marker::text from r977g_fp
    where oid = 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)'::regprocedure),
  -- 第 11 批 F #993(migration 20261007140300)把料錢參數改成 jsonb,基準改成「F 版本拿掉本批段落後」的指紋;第 7 批改前指紋 0574cf6aae932aa1ecd7a98e1715cae8。
  'a2c26d3454ad986bf1a65ec6096afff4|v/true/postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres|true',
  '⑦ create_booking:拿掉本批段落後 = 改前指紋(含第 4 批段落);屬性 / ACL 不變'
);

-- 布置:甲的一張單(管理員建),丁改成已移除、己改成未開通登入。
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
select pg_temp.mk('f9777000-0000-4000-8000-000000000040', '2036-03-10 10:00:00+08') as id \gset bj_
select pg_temp.test_clear_auth();
update merchant_staff set status = 'removed' where id = 'f9777000-0000-4000-8000-000000000043';
update merchant_staff set login_status = 'invited' where id = 'f9777000-0000-4000-8000-000000000045';

-- =========================================================================
-- ⑧~⑯ staff_order_self_ok
-- =========================================================================
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000004');
select ok(private.staff_order_self_ok('f9777000-0000-4000-8000-000000000040'), '⑧ 甲本人(在職、已開通、兩個開關、行事曆檢視)⇒ true');
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000042'), '⑨ 甲拿丙的 staff id ⇒ false(別人的 id)');
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000007');
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000043'), '⑩ 丁已移除 ⇒ false');
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000011');
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000045'), '⑪ 己未開通登入 ⇒ false');
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000008');
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000044'), '⑫ 戊行事曆檢視關 ⇒ false');
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000012');
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000047'), '⑬ 辛「新增編輯訂單」關 ⇒ false');
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000013');
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000048'), '⑭ 壬「顯示會員資料」關 ⇒ false(裁決 6 的後端保證)');
select pg_temp.test_clear_auth();
select ok(not private.staff_order_self_ok('f9777000-0000-4000-8000-000000000040'), '⑮ 未登入 ⇒ false');
select pg_temp.test_set_uid('f9777000-0000-4000-8000-000000000004');
select ok(not private.staff_order_self_ok(null), '⑯ staff id 是 null ⇒ false(不是 null)');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑰~⑳ private helper 的 ACL
-- =========================================================================
select ok(
  not has_function_privilege('authenticated', 'private.staff_order_self_ok(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.staff_order_self_ok(uuid)', 'execute')
  and not has_function_privilege('public', 'private.staff_order_self_ok(uuid)', 'execute'),
  '⑰ staff_order_self_ok:authenticated / anon / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'private.staff_order_actor_id()', 'execute')
  and not has_function_privilege('anon', 'private.staff_order_actor_id()', 'execute')
  and not has_function_privilege('public', 'private.staff_order_actor_id()', 'execute'),
  '⑱ staff_order_actor_id:authenticated / anon / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'private.is_staff_order_call(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.is_staff_order_call(uuid)', 'execute')
  and not has_function_privilege('public', 'private.is_staff_order_call(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.staff_slot_toggle_ok(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.staff_slot_toggle_ok(uuid)', 'execute')
  and not has_function_privilege('public', 'private.staff_slot_toggle_ok(uuid)', 'execute'),
  '⑲ is_staff_order_call、staff_slot_toggle_ok:authenticated / anon / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'private.staff_order_own_booking(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'private.staff_order_own_booking(uuid, text)', 'execute')
  and has_function_privilege('authenticated', 'private.can_manage_bookings(uuid)', 'execute'),
  '⑳ staff_order_own_booking:authenticated / anon 沒有 EXECUTE(正向對照:can_manage_bookings 有)'
);

-- =========================================================================
-- ㉑~㉘ 沒有標記時,甲(可以自己下單)直接呼叫既有函式全部被擋
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000004');
select throws_ok(
  $$select public.create_booking(
      p_merchant_id => 'f9777000-0000-4000-8000-000000000020',
      p_staff_id => 'f9777000-0000-4000-8000-000000000040',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
      p_start_at => '2036-03-11 10:00:00+08', p_customer_name => '直接打', p_customer_phone => '0955977799',
      p_customer_address => '台北市', p_payment_method_id => 'f9777000-0000-4000-8000-000000000050')$$,
  '42501', NULL, '㉑ 沒有標記:create_booking 被擋'
);
select throws_ok(
  format($$select public.update_booking(
      p_booking_id => %L, p_staff_id => 'f9777000-0000-4000-8000-000000000040',
      p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
      p_start_at => '2036-03-10 10:00:00+08', p_customer_name => '林小姐', p_customer_phone => '0955977700',
      p_customer_address => '台北市')$$, :'bj_id'),
  '42501', NULL, '㉒ 沒有標記:update_booking 被擋'
);
select throws_ok(format('select public.cancel_booking(%L)', :'bj_id'), '42501', NULL, '㉓ 沒有標記:cancel_booking 被擋');
select throws_ok(format('select public.complete_booking(%L)', :'bj_id'), '42501', NULL, '㉔ 沒有標記:complete_booking 被擋');
select throws_ok(
  format($$select public.move_booking(%L, 'f9777000-0000-4000-8000-000000000040', 'f9777000-0000-4000-8000-000000000040',
      '2036-03-10 11:00:00+08', '2036-03-10 10:00:00+08', 'f9777000-0000-4000-8000-000000000040')$$, :'bj_id'),
  '42501', NULL, '㉕ 沒有標記:move_booking 被擋'
);
select throws_ok(
  $$select public.preview_booking_points('f9777000-0000-4000-8000-000000000020', null, null, '0955977700',
      jsonb_build_array(jsonb_build_object('service_item_id','f9777000-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
      false, null, false, null, null, false, null, null)$$,
  '42501', NULL, '㉖ 沒有標記:preview_booking_points 被擋'
);
select throws_ok(
  $$select public.list_staff_bookable_start_times('f9777000-0000-4000-8000-000000000020',
      'f9777000-0000-4000-8000-000000000040', '2036-03-12', 60)$$,
  '42501', NULL, '㉗ 沒有標記:list_staff_bookable_start_times 被擋'
);
select throws_ok(
  $$select public.set_staff_day_override('f9777000-0000-4000-8000-000000000040', '2036-03-12', '10:00', '10:30', false)$$,
  '42501', NULL, '㉘ 沒有標記:set_staff_day_override 被擋(甲是月薪制、沒有排班自助)'
);

-- =========================================================================
-- ㉙~㉜ 沒有標記時,甲透過 RLS 讀不到商家的訂單 / 會員 / 服務項目 / 付款方式
-- =========================================================================
select is((select count(*)::int from public.bookings), 0, '㉙ 甲 select bookings = 0 筆');
select is((select count(*)::int from public.members), 0, '㉚ 甲 select members = 0 筆');
select is((select count(*)::int from public.service_items), 0, '㉛ 甲 select service_items = 0 筆');
select is((select count(*)::int from public.payment_methods), 0, '㉜ 甲 select payment_methods = 0 筆');

-- =========================================================================
-- ㉝~㊳ 偽造標記
-- =========================================================================
select set_config('miaoyue.staff_order_actor', 'f9777000-0000-4000-8000-000000000042', true);
select ok(not private.can_manage_bookings('f9777000-0000-4000-8000-000000000020'), '㉝ 甲把標記設成丙的 id ⇒ can_manage_bookings 仍是 false');
select set_config('miaoyue.staff_order_actor', 'f9777000-0000-4000-8000-000000000046', true);
select ok(
  not private.can_manage_bookings('f9777000-0000-4000-8000-000000000021')
  and not private.can_manage_bookings('f9777000-0000-4000-8000-000000000020'),
  '㉞ 甲把標記設成 B 店庚的 id ⇒ A、B 兩店都是 false'
);
select set_config('miaoyue.staff_order_actor', 'not-a-uuid; drop table x', true);
select ok(not private.can_manage_bookings('f9777000-0000-4000-8000-000000000020'), '㉟ 標記是亂碼 ⇒ false,不報錯');
select set_config('miaoyue.staff_order_actor', 'f9777000-0000-4000-8000-000000000040', true);
select ok(not private.can_manage_bookings('f9777000-0000-4000-8000-000000000021'), '㊱ 標記是甲本人但問 B 店 ⇒ false');
select ok(private.can_manage_bookings('f9777000-0000-4000-8000-000000000020'), '㊲ 正向對照:標記是甲本人 + A 店 ⇒ true(查法分辨得出真假)');
select set_config('miaoyue.staff_order_actor', '', true);
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000012');
select set_config('miaoyue.staff_order_actor', 'f9777000-0000-4000-8000-000000000047', true);
select ok(not private.can_manage_bookings('f9777000-0000-4000-8000-000000000020'), '㊳ 辛(新增編輯訂單關)把標記設成自己 ⇒ false');
select set_config('miaoyue.staff_order_actor', '', true);

-- =========================================================================
-- ㊴~㊵ 客服、管理員走 RLS 讀 bookings 正常
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000003');
select ok((select count(*) from public.bookings where id = :'bj_id'::uuid) = 1, '㊴ 客服走 RLS 讀得到這張單(helper revoke authenticated 不影響)');
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
select ok((select count(*) from public.bookings where id = :'bj_id'::uuid) = 1, '㊵ 管理員走 RLS 讀得到這張單');

-- =========================================================================
-- ㊶~㊻ 後台建單不受影響
-- =========================================================================
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-03-13 10:00:00+08') as id \gset badm_
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000003');
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-03-13 14:00:00+08') as id \gset bagt_
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000014');
select pg_temp.mk('f9777000-0000-4000-8000-000000000042', '2036-03-13 17:00:00+08') as id \gset bgui_
select pg_temp.test_clear_auth();

select is((select created_by_role from bookings where id = :'badm_id'::uuid), 'admin', '㊶ 管理員建單 created_by_role 仍是 admin');
select is((select actor_role_snapshot from booking_status_change_logs where booking_id = :'badm_id'::uuid), 'merchant_admin', '㊷ 管理員建單操作紀錄仍是 merchant_admin');
select is((select created_by_role from bookings where id = :'bagt_id'::uuid), 'agent', '㊸ 客服建單 created_by_role 仍是 agent');
select is((select actor_role_snapshot || '/' || actor_name_snapshot from booking_status_change_logs where booking_id = :'bagt_id'::uuid), 'agent/客服甲', '㊹ 客服建單操作紀錄仍是 agent / 客服姓名');
select is((select created_by_role from bookings where id = :'bgui_id'::uuid), 'admin', '㊺ 管理員兼服務人員(沒有標記)後台建單仍是 admin');
select is((select actor_role_snapshot from booking_status_change_logs where booking_id = :'bgui_id'::uuid), 'merchant_admin', '㊻ 管理員兼服務人員後台建單操作紀錄仍是 merchant_admin');

-- =========================================================================
-- ㊼~㊾ get_booking_actor_names(7-15)
-- =========================================================================
select pg_temp.test_set_auth('f9777000-0000-4000-8000-000000000001');
create temp table r977g_names on commit drop as
  select * from public.get_booking_actor_names('f9777000-0000-4000-8000-000000000020', array[
    'f9777000-0000-4000-8000-000000000004'::uuid,
    'f9777000-0000-4000-8000-000000000001'::uuid,
    'f9777000-0000-4000-8000-000000000003'::uuid
  ]);
select pg_temp.test_clear_auth();
select is((select display_name from r977g_names where user_id = 'f9777000-0000-4000-8000-000000000004'), '甲服務人員', '㊼ 服務人員的 user id ⇒ 服務人員姓名(不再是「已移除的人員」)');
select is((select display_name from r977g_names where user_id = 'f9777000-0000-4000-8000-000000000001'), '店主甲', '㊽ 管理員姓名不變');
select is((select display_name from r977g_names where user_id = 'f9777000-0000-4000-8000-000000000003'), '客服甲', '㊾ 客服姓名不變');

-- =========================================================================
-- ㊿ created_by_role CHECK
-- =========================================================================
select ok(
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'bookings_created_by_role_check') like '%''staff''%',
  '㊿ bookings_created_by_role_check 已接受 staff'
);

select * from finish();
rollback;
