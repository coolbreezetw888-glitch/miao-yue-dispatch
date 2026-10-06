-- 安全回歸測試(2026-09-24 深夜巡檢批次 A1 / A2 / A5)。
-- 對應 migration:20260924020000_security_revoke_execute_and_policy_roles.sql
--
-- 【為什麼需要這份測試】
-- ・A1:resolve_line_notification_targets 是一支「內部完全沒有權限檢查」的 SECURITY DEFINER
--       函式,放在 public schema 就會被 PostgREST 自動曝光成 /rest/v1/rpc/<name>。原本漏掉
--       revoke authenticated,任何登入者都能帶任意 merchant_id 撈走該商家所有管理員/客服的
--       姓名與 line_user_id。把「authenticated 不能直接呼叫它、但前端該用的包裝函式仍然能用」
--       兩件事一起釘成回歸測試。
-- ・A2:recalculate_booking_commission 被 drop + create 重寫時繼承了 PostgreSQL 對新函式的
--       預設 PUBLIC EXECUTE。目前不可利用(函式第一段就檢查 is_merchant_admin),但要釘住,
--       避免之後有人重構掉內部檢查就變成真漏洞。
-- ・A5:6 條政策建立時漏寫 to authenticated,角色落在 PUBLIC,跟專案其他政策不一致。
--
-- 比照 module2_03_private_functions_access_control.sql /
-- seed_functions_01_execute_privileges_and_idempotency.sql 的既有寫法。
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

select plan(22);

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
-- ①~④ A1:resolve_line_notification_targets 的 EXECUTE 權限邊界。
-- =========================================================================
select ok(
  not has_function_privilege('authenticated', 'public.resolve_line_notification_targets(uuid, text, uuid, uuid)', 'execute'),
  'A1:authenticated 不能直接執行 resolve_line_notification_targets(這是本次修補的主角)'
);
select ok(
  not has_function_privilege('anon', 'public.resolve_line_notification_targets(uuid, text, uuid, uuid)', 'execute'),
  'A1:anon 不能直接執行 resolve_line_notification_targets'
);
select ok(
  not has_function_privilege('public', 'public.resolve_line_notification_targets(uuid, text, uuid, uuid)', 'execute'),
  'A1:PUBLIC 虛擬角色也沒有 resolve_line_notification_targets 的執行權'
);
select ok(
  has_function_privilege('service_role', 'public.resolve_line_notification_targets(uuid, text, uuid, uuid)', 'execute'),
  'A1:service_role 保有執行權(Edge Function line-notify-dispatch 要用)'
);

-- =========================================================================
-- ⑤~⑦ A2:recalculate_booking_commission 的 EXECUTE 權限邊界。
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.recalculate_booking_commission(uuid)', 'execute'),
  'A2:anon 不能執行 recalculate_booking_commission'
);
select ok(
  not has_function_privilege('public', 'public.recalculate_booking_commission(uuid)', 'execute'),
  'A2:PUBLIC 虛擬角色也沒有 recalculate_booking_commission 的執行權'
);
select ok(
  has_function_privilege('authenticated', 'public.recalculate_booking_commission(uuid)', 'execute'),
  'A2:authenticated 保有執行權(前端「重新計算抽成」按鈕要用,內部自己檢查 is_merchant_admin)'
);

-- =========================================================================
-- ⑧~⑬ A5:6 條政策的角色欄位必須是 {authenticated},不是 PUBLIC。
-- pg_policies.roles 為 PUBLIC 時會顯示成 {public}。
-- =========================================================================
select is(
  (select roles::text[] from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff' and policyname = 'merchant_staff_select'),
  array['authenticated'],
  'A5:merchant_staff_select 的角色是 authenticated,不是 PUBLIC'
);
select is(
  (select roles::text[] from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff' and policyname = 'merchant_staff_insert'),
  array['authenticated'],
  'A5:merchant_staff_insert 的角色是 authenticated,不是 PUBLIC'
);
select is(
  (select roles::text[] from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff' and policyname = 'merchant_staff_update'),
  array['authenticated'],
  'A5:merchant_staff_update 的角色是 authenticated,不是 PUBLIC'
);
select is(
  (select roles::text[] from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff_service_items'
      and policyname = 'merchant_staff_service_items_select'),
  array['authenticated'],
  'A5:merchant_staff_service_items_select 的角色是 authenticated,不是 PUBLIC'
);
select is(
  (select roles::text[] from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff_service_items'
      and policyname = 'merchant_staff_service_items_insert'),
  array['authenticated'],
  'A5:merchant_staff_service_items_insert 的角色是 authenticated,不是 PUBLIC'
);
select is(
  (select roles::text[] from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff_service_items'
      and policyname = 'merchant_staff_service_items_delete'),
  array['authenticated'],
  'A5:merchant_staff_service_items_delete 的角色是 authenticated,不是 PUBLIC'
);

-- =========================================================================
-- Fixture:一間商家 + 管理員 + 一位被授權 staff_management 的客服 + 一筆預約,
-- 用來做 A1 的「實際呼叫」正反面測試,以及 A5 的功能回歸(政策重建後判斷式沒有跑掉)。
-- =========================================================================
insert into auth.users (id, email) values
  ('d1000000-0000-4000-8000-000000000001', 'pgtap-sec01-admin@test.local'),
  ('d1000000-0000-4000-8000-000000000002', 'pgtap-sec01-agent@test.local');

insert into groups (id) values ('d1000000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('d1000000-0000-4000-8000-000000000020', 'd1000000-0000-4000-8000-000000000010', '權限稽核測試商家', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('d1000000-0000-4000-8000-000000000020', 'd1000000-0000-4000-8000-000000000001');

insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone)
values ('d1000000-0000-4000-8000-000000000050', 'd1000000-0000-4000-8000-000000000020',
        'd1000000-0000-4000-8000-000000000002', '客服-服務人員管理', 'pgtap-sec01-agent@test.local',
        'active', now(), '0900000301');

insert into merchant_agent_permissions (agent_id, section_key, granted)
values ('d1000000-0000-4000-8000-000000000050', 'staff_management', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('d1000000-0000-4000-8000-000000000020', 2, false, '00:00', '23:59');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes)
values ('d1000000-0000-4000-8000-000000000030', 'd1000000-0000-4000-8000-000000000020', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('d1000000-0000-4000-8000-000000000040', 'd1000000-0000-4000-8000-000000000020', '服務人員甲', '0901000301', true);

insert into payment_methods (id, merchant_id, name)
values ('d1000000-0000-4000-8000-000000000060', 'd1000000-0000-4000-8000-000000000020', '現場付款');

select pg_temp.test_set_auth('d1000000-0000-4000-8000-000000000001');

select id from create_booking(
  'd1000000-0000-4000-8000-000000000020', 'd1000000-0000-4000-8000-000000000040',
  jsonb_build_array(jsonb_build_object('service_item_id','d1000000-0000-4000-8000-000000000030','quantity',1,'unit_price',300)),
  '2026-09-22 10:00:00+08', '客戶甲', '0988000301',
  p_payment_method_id => 'd1000000-0000-4000-8000-000000000060'
) \gset sec01_booking_

-- =========================================================================
-- ⑭ A1 負面:商家管理員(authenticated)直接呼叫 resolve_line_notification_targets 會被擋下。
--    這一條就是漏洞本身——修補前這裡會成功回傳含 line_user_id 的清單。
-- =========================================================================
select throws_ok(
  format(
    $$select public.resolve_line_notification_targets(
        'd1000000-0000-4000-8000-000000000020', 'booking_created', '%s', null)$$,
    :'sec01_booking_id'::text
  ),
  '42501', null,
  'A1 負面:登入者(連商家管理員都算)不能直接呼叫 resolve_line_notification_targets'
);

-- =========================================================================
-- ⑮⑯ A1 正面:前端真正該用的包裝函式 preview_line_notification_targets 仍然正常運作
--     (它是 SECURITY DEFINER,內部呼叫以函式擁有者身份執行,不受這次收權影響)。
-- =========================================================================
select lives_ok(
  format(
    $$select public.preview_line_notification_targets('%s', 'booking_created')$$,
    :'sec01_booking_id'::text
  ),
  'A1 正面:preview_line_notification_targets 沒有被這次收權弄壞,商家管理員仍可呼叫'
);

select is(
  (select (public.preview_line_notification_targets(:'sec01_booking_id'::uuid, 'booking_created') ->> 'has_any_target')::boolean),
  false,
  'A1 正面:這間商家沒有接 LINE,包裝函式正確回傳 has_any_target = false(而不是拋錯)'
);

-- =========================================================================
-- ⑰~⑳ A5 功能回歸:6 條政策重建後判斷式沒有跑掉——被授權 staff_management 的客服
--     仍然看得到/改得動 merchant_staff,也仍然能指派服務項目。
-- =========================================================================
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('d1000000-0000-4000-8000-000000000002');

select is(
  (select count(*) from merchant_staff where merchant_id = 'd1000000-0000-4000-8000-000000000020')::int,
  1,
  'A5 回歸:被授權 staff_management 的客服仍然 SELECT 得到 merchant_staff'
);

select lives_ok(
  $$insert into merchant_staff (id, merchant_id, name, phone)
    values ('d1000000-0000-4000-8000-000000000041', 'd1000000-0000-4000-8000-000000000020', '客服新增的服務人員', '0901000302')$$,
  'A5 回歸:被授權 staff_management 的客服仍然可以 INSERT merchant_staff'
);

select lives_ok(
  $$update merchant_staff set phone = '0901000399' where id = 'd1000000-0000-4000-8000-000000000041'$$,
  'A5 回歸:被授權 staff_management 的客服仍然可以做一般編輯(改電話)'
);

select lives_ok(
  $$insert into merchant_staff_service_items (staff_id, service_item_id)
    values ('d1000000-0000-4000-8000-000000000041', 'd1000000-0000-4000-8000-000000000030')$$,
  'A5 回歸:被授權 staff_management 的客服仍然可以指派服務人員可承接的服務項目'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- SPECS-INDEX #977 第 7 批(2026-10-07):服務人員新增編輯訂單的新函式也要守住同一條規則(規則 1)。
--   public 的 11 支(服務人員端前端 / Edge Function 要呼叫):anon / PUBLIC 沒有、authenticated 有。
--   private 的 5 支 helper(只給內部用):anon / PUBLIC / authenticated 都沒有。
-- 細節與每支的放行 / 擋下情境見 req977_05 ~ req977_09。
-- =========================================================================
select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and (p.proname like 'staff\_%' and p.proname in (
            'staff_get_booking_form_options', 'staff_get_booking_for_edit', 'staff_list_my_bookable_start_times',
            'staff_preview_booking_points', 'staff_create_booking', 'staff_update_booking', 'staff_cancel_booking',
            'staff_complete_booking', 'staff_move_booking', 'staff_set_my_slot')
          or p.proname = 'can_staff_dispatch_booking_notification')
     and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('public', p.oid, 'execute')
     and has_function_privilege('authenticated', p.oid, 'execute')),
  11,
  '#977 第 7 批:11 支服務人員訂單函式 anon / PUBLIC 都不能執行,authenticated 可以(數量對 = 每一支都符合)'
);
select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and p.proname in ('staff_order_self_ok', 'staff_order_actor_id', 'is_staff_order_call', 'staff_order_own_booking', 'staff_slot_toggle_ok')
     and not has_function_privilege('anon', p.oid, 'execute')
     and not has_function_privilege('public', p.oid, 'execute')
     and not has_function_privilege('authenticated', p.oid, 'execute')),
  5,
  '#977 第 7 批:5 支 private helper 對 anon / PUBLIC / authenticated 都沒有 EXECUTE'
);

select * from finish();
rollback;
