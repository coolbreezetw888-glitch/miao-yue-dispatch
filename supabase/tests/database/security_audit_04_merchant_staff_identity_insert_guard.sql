-- 安全回歸測試(2026-09-24 第二輪:merchant_staff 身分綁定欄位的 INSERT 面保護)。
-- 對應 migration:20260924030100_merchant_staff_identity_columns_insert_guard.sql
--
-- 【使用者裁決原文】
--   「登入帳號(Email)除了管理員與服務人員本身可以修改,其餘角色都沒有權限。」
--
-- 【為什麼需要這份測試】
-- 前一輪(20260924020100 / security_audit_02)只擋了 BEFORE UPDATE。
-- merchant_staff_insert 政策同樣是「整列」層級的,被授權 staff_management 的客服可以直接打
-- POST /rest/v1/merchant_staff,body 帶 user_id=<自己的 auth uid>、login_status='active',
-- 憑空新增一筆「綁在自己帳號上、而且已開通登入」的服務人員紀錄。
-- 之後 private.is_own_staff_row() 對他成立(它要求 status='active' 且 login_status='active',
-- 這兩個條件攻擊者自己就填滿了),於是他能呼叫「服務人員本人限定」的薪資/抽成/班表函式。
-- 這跟前一輪擋的是同一種提權,只是換成「新增一個假的自己」而不是「改掉別人的」。
--
-- 這份測試釘住四件事:
--   ① 負面(核心):客服 INSERT 帶 user_id / login_status 一律被擋;
--   ② 範圍回歸(最重要):客服「正常新增服務人員」(不帶那兩欄,就是前端
--      src/modules/staff-agent/api.ts createMerchantStaff 實際送出的欄位組合)必須照樣成功
--      —— 這一條證明這次的保護沒有誤擋任何正常流程;
--   ③ 正面:商家管理員 INSERT 可以帶這兩欄;
--   ④ 既有繞道與既有 UPDATE 面保護全部沒有被這次改動弄壞
--      (service_role、邀請流程 record_invited_staff_login、客服的一般編輯)。
begin;

select plan(16);

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
-- Fixture
--   01 = 商家管理員
--   02 = 被授權 staff_management 的客服(攻擊者,同時也是「範圍回歸」的主角)
--   03 = 管理員合法指定給新服務人員的登入帳號
--   04 = 管理員合法指定的第二個登入帳號(測 login_status)
--   05 = service_role 直接 INSERT 時用的登入帳號
--   06 = 邀請流程(record_invited_staff_login)要綁上去的登入帳號
-- =========================================================================
insert into auth.users (id, email) values
  ('d4000000-0000-4000-8000-000000000001', 'pgtap-sec04-admin@test.local'),
  ('d4000000-0000-4000-8000-000000000002', 'pgtap-sec04-agent@test.local'),
  ('d4000000-0000-4000-8000-000000000003', 'pgtap-sec04-staff-new1@test.local'),
  ('d4000000-0000-4000-8000-000000000004', 'pgtap-sec04-staff-new2@test.local'),
  ('d4000000-0000-4000-8000-000000000005', 'pgtap-sec04-staff-svcrole@test.local'),
  ('d4000000-0000-4000-8000-000000000006', 'pgtap-sec04-staff-invited@test.local');

insert into groups (id) values ('d4000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('d4000000-0000-4000-8000-000000000020', 'd4000000-0000-4000-8000-000000000010',
        '服務人員身分欄位 INSERT 保護測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('d4000000-0000-4000-8000-000000000020', 'd4000000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values ('d4000000-0000-4000-8000-000000000050', 'd4000000-0000-4000-8000-000000000020',
        'd4000000-0000-4000-8000-000000000002', '客服-服務人員管理', 'pgtap-sec04-agent@test.local',
        'active', now(), '0900000601');

insert into merchant_agent_permissions (agent_id, section_key, granted)
values ('d4000000-0000-4000-8000-000000000050', 'staff_management', true);

-- 既有的一位服務人員,用來測 UPDATE 面的既有保護有沒有被這次改動弄壞。
insert into merchant_staff (id, merchant_id, name, phone, login_status, status, compensation_type)
values ('d4000000-0000-4000-8000-000000000040', 'd4000000-0000-4000-8000-000000000020', '既有服務人員', '0901000601',
        'not_invited', 'active', 'piece_rate');

-- 尚未邀請的一位,用來測邀請流程(record_invited_staff_login,走 UPDATE 不是 INSERT)。
insert into merchant_staff (id, merchant_id, name, phone, login_status, status)
values ('d4000000-0000-4000-8000-000000000045', 'd4000000-0000-4000-8000-000000000020', '待邀請服務人員', '0901000602',
        'not_invited', 'active');

-- =========================================================================
-- ①②③ 負面(核心):被授權 staff_management 的客服 INSERT 時不能帶身分綁定欄位。
--       同時比對錯誤碼與觸發器自己拋出的中文訊息,確保是被這支觸發器擋下的,
--       不是剛好撞到 RLS 的同一個 42501(客服本來就過得了 merchant_staff_insert 政策)。
-- =========================================================================
select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000002');

select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone, user_id)
    values ('d4000000-0000-4000-8000-000000000020', '人頭帳號-帶user_id', '0901000611',
            'd4000000-0000-4000-8000-000000000002')$$,
  '42501', '只有商家管理員可以在新增服務人員時指定登入帳號或登入狀態',
  'INSERT 核心:客服不能新增一筆 user_id=自己 auth uid 的服務人員(這就是本次補的提權缺口)'
);

select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone, login_status)
    values ('d4000000-0000-4000-8000-000000000020', '人頭帳號-帶login_status', '0901000612', 'active')$$,
  '42501', '只有商家管理員可以在新增服務人員時指定登入帳號或登入狀態',
  'INSERT 核心:客服不能新增一筆 login_status=active 的服務人員(跟 user_id 同一組身分綁定狀態)'
);

select throws_ok(
  $$insert into merchant_staff (merchant_id, name, phone, user_id, login_status, status)
    values ('d4000000-0000-4000-8000-000000000020', '人頭帳號-完整攻擊', '0901000613',
            'd4000000-0000-4000-8000-000000000002', 'active', 'active')$$,
  '42501', '只有商家管理員可以在新增服務人員時指定登入帳號或登入狀態',
  'INSERT 核心:完整攻擊組合(user_id=自己 + login_status=active + status=active)被擋下'
);

-- =========================================================================
-- ④⑤ 範圍回歸(這份測試最重要的一條):客服「正常新增服務人員」必須照樣成功。
--     欄位組合刻意照抄前端 src/modules/staff-agent/api.ts:109 createMerchantStaff 實際送出的
--     那一組(有 name/nickname/phone/contact_email/intro/is_listed/各種旗標/compensation_type,
--     沒有 user_id、沒有 login_status),證明這次的保護沒有誤擋任何正常流程。
-- =========================================================================
select lives_ok(
  $$insert into merchant_staff (
      merchant_id, name, nickname, phone, contact_email, intro, avatar_url,
      is_listed, no_time_slot_limit, unlimited_backend_edit,
      direct_accept_after_merchant_confirm, auto_accept_booking, show_member_info,
      can_create_edit_orders, can_upload_construction_photos, compensation_type
    ) values (
      'd4000000-0000-4000-8000-000000000020', '客服正常新增的服務人員', '小王', '0901000621',
      'normal-new@test.local', '自我介紹', null,
      true, false, false, false, false, false, false, false, 'piece_rate'
    )$$,
  'INSERT 範圍回歸(最重要):客服「正常新增服務人員」(前端實際送出的欄位組合,不帶身分綁定欄位)照樣成功'
);

select is(
  (select count(*)::int from merchant_staff
    where merchant_id = 'd4000000-0000-4000-8000-000000000020'
      and name = '客服正常新增的服務人員'),
  1,
  'INSERT 範圍回歸:那一筆真的寫進資料庫了(不是被靜默擋下)'
);

-- ⑥ 邊界:客服明確把兩個欄位「填成預設值」也不該被擋
--    (PostgREST 的 body 有可能帶上 null / 預設值,誤擋這種寫法會讓前端莫名壞掉)。
select lives_ok(
  $$insert into merchant_staff (merchant_id, name, phone, user_id, login_status)
    values ('d4000000-0000-4000-8000-000000000020', '客服新增-明確帶預設值', '0901000622',
            null, 'not_invited')$$,
  'INSERT 邊界:客服明確帶 user_id=null / login_status=not_invited(等於 schema 預設值)不被誤擋'
);

-- ⑦ 上面三次攻擊真的一筆都沒有進到資料庫(客服沒有成功把任何一列綁到自己身上)。
select is(
  (select count(*)::int from merchant_staff
    where merchant_id = 'd4000000-0000-4000-8000-000000000020'
      and user_id = 'd4000000-0000-4000-8000-000000000002'),
  0,
  'INSERT 核心:三次攻擊全部被擋下,沒有任何一筆 merchant_staff 綁在客服自己的 auth uid 上'
);

-- =========================================================================
-- ⑧⑨ UPDATE 面回歸:前一輪(20260924020100)的保護與客服原有的編輯能力都沒有被弄壞。
-- =========================================================================
select throws_ok(
  $$update merchant_staff set user_id = 'd4000000-0000-4000-8000-000000000002'
    where id = 'd4000000-0000-4000-8000-000000000040'$$,
  '42501', '只有商家管理員可以變更服務人員綁定的登入帳號或登入狀態',
  'UPDATE 回歸:前一輪的 UPDATE 面保護仍然有效,訊息文字也沒變(security_audit_02 比對的就是這句)'
);

select lives_ok(
  $$update merchant_staff set name = '既有服務人員(客服改名)', phone = '0901000699', status = 'removed'
    where id = 'd4000000-0000-4000-8000-000000000040'$$,
  'UPDATE 回歸:客服仍然可以做一般編輯與軟刪除(保護清單刻意只有身分綁定那兩欄)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑩~⑫ 正面:商家管理員 INSERT 可以帶身分綁定欄位。
-- =========================================================================
select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000001');

select lives_ok(
  $$insert into merchant_staff (merchant_id, name, phone, user_id)
    values ('d4000000-0000-4000-8000-000000000020', '管理員新增-帶user_id', '0901000631',
            'd4000000-0000-4000-8000-000000000003')$$,
  'INSERT 正面:商家管理員可以在新增服務人員時直接指定登入帳號(user_id)'
);

select is(
  (select user_id from merchant_staff
    where merchant_id = 'd4000000-0000-4000-8000-000000000020' and name = '管理員新增-帶user_id'),
  'd4000000-0000-4000-8000-000000000003'::uuid,
  'INSERT 正面:管理員指定的 user_id 真的寫進去了'
);

select lives_ok(
  $$insert into merchant_staff (merchant_id, name, phone, user_id, login_status)
    values ('d4000000-0000-4000-8000-000000000020', '管理員新增-帶login_status', '0901000632',
            'd4000000-0000-4000-8000-000000000004', 'active')$$,
  'INSERT 正面:商家管理員可以在新增服務人員時直接指定 login_status'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑬ 既有繞道 1 保留:service_role 直接 INSERT 帶 user_id 不被擋
--    (Edge Function / 後台維運路徑;e2e fixture 也一律走 service_role key)。
-- =========================================================================
select pg_temp.test_set_auth('d4000000-0000-4000-8000-000000000001', 'service_role');

select lives_ok(
  $$insert into merchant_staff (merchant_id, name, phone, user_id, login_status)
    values ('d4000000-0000-4000-8000-000000000020', 'service_role新增', '0901000641',
            'd4000000-0000-4000-8000-000000000005', 'active')$$,
  'INSERT 繞道回歸:service_role 帶 user_id/login_status 新增不被擋(第一道繞道完整保留)'
);

-- =========================================================================
-- ⑭⑮ 合法路徑:邀請流程 record_invited_staff_login。
--     它走的是 UPDATE(不是 INSERT),這兩條確認這次改成 before insert or update
--     之後,邀請流程完全沒有被波及。
-- =========================================================================
select lives_ok(
  $$select public.record_invited_staff_login(
      'd4000000-0000-4000-8000-000000000045',
      'd4000000-0000-4000-8000-000000000006',
      'pgtap-sec04-staff-invited@test.local',
      'invited')$$,
  '合法路徑:邀請流程 record_invited_staff_login(service_role)完全沒有被誤擋'
);

select is(
  (select user_id from merchant_staff where id = 'd4000000-0000-4000-8000-000000000045'),
  'd4000000-0000-4000-8000-000000000006'::uuid,
  '合法路徑:邀請流程真的把 user_id 寫進去了(登入邀請流程沒壞)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑯ 觸發器本身現在同時涵蓋 INSERT 與 UPDATE
--    (避免之後有人重建這支觸發器時又只掛回 before update,缺口默默復活)。
-- =========================================================================
select ok(
  (select pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE ON public.merchant_staff%'
     from pg_trigger
    where tgrelid = 'public.merchant_staff'::regclass
      and tgname = 'merchant_staff_protect_identity_columns'
      and not tgisinternal),
  'merchant_staff_protect_identity_columns 觸發器同時掛在 INSERT 與 UPDATE 上'
);

select * from finish();
rollback;
