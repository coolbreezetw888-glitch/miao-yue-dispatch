-- SPECS-INDEX #1025 功能開關 第 3 批 FG3-T01:服務人員細部功能的擋住點
-- migration 20261010200100_req1025_fg3_staff_features.sql
-- 規格書 .project/specs/功能開關.md(第 2 版)FG3-A01、FG3-F01、FG3-F02(⚠️7)、FG3-T01、邊界 19。
--
--   ①  功能清單 4 項(主 / 細部)、產業預設、所有商家都有開關列
--   ②  基準(全開):四種 section、建單、時段開關、即時頻道授權都是 true
--   ③  staff_portal 關:has_own_staff_permission 四種 section 全 false;確認接單、建單、行事曆、即時頻道、
--      自己綁 LINE 都被擋;店家後台指派該服務人員建單、店家確認訂單照常;推播收件人不含服務人員(⚠️7)、
--      管理員照常;另一間店(邊界 19)不受影響
--   ④  staff_portal 開、staff_order_editing 關:只有建單 / 時段開關被擋,行事曆、確認接單照常
--   ⑤  staff_self_availability 關:排休被擋,行事曆不受影響
--   ⑥  staff_self_payroll 關:自己的薪資報表被擋,行事曆不受影響
--   ⑦  重新全開:個人權限與 merchant_staff 開關完全沒變、權限恢復
--   ⑧  internal_merchant_has_feature 只給 service_role
begin;

select plan(46);

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

-- 平台開關:直接用超級管理員的 RPC(順便走真正的寫入路徑)。
create function pg_temp.set_feature(p_merchant uuid, p_key text, p_enabled boolean)
returns void language plpgsql as $$
begin
  perform pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000001');
  perform public.platform_set_merchant_feature(p_merchant, p_key, p_enabled);
  perform pg_temp.test_clear_auth();
end;
$$;

-- 個人設定快照(T9:平台開關怎麼切都不能動到這些值)。
create function pg_temp.staff_settings_snapshot()
returns text language sql stable as $$
  select
    (select string_agg(msp.staff_id::text || '/' || msp.section_key || '=' || msp.granted::text, ',' order by msp.staff_id, msp.section_key)
       from merchant_staff_permissions msp
      where msp.staff_id in ('f1025400-0000-4000-8000-000000000040', 'f1025400-0000-4000-8000-000000000041'))
    || '|' ||
    (select string_agg(ms.id::text || ':' || ms.can_create_edit_orders::text || ':' || ms.show_member_info::text
                       || ':' || ms.login_status || ':' || ms.status, ',' order by ms.id)
       from merchant_staff ms
      where ms.id in ('f1025400-0000-4000-8000-000000000040', 'f1025400-0000-4000-8000-000000000041'))
$$;

-- ─── Fixture ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('f1025400-0000-4000-8000-000000000001', 'pgtap-1025s-platform@test.local'),
  ('f1025400-0000-4000-8000-000000000002', 'pgtap-1025s-admin-a@test.local'),
  ('f1025400-0000-4000-8000-000000000003', 'pgtap-1025s-staff-a@test.local'),
  ('f1025400-0000-4000-8000-000000000004', 'pgtap-1025s-staff-b@test.local');
insert into platform_admins (user_id) values ('f1025400-0000-4000-8000-000000000001');

insert into groups (id) values
  ('f1025400-0000-4000-8000-000000000011'),
  ('f1025400-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1025400-0000-4000-8000-000000000021', 'f1025400-0000-4000-8000-000000000011', '服務人員開關A店', 'on_site_dispatch'),
  ('f1025400-0000-4000-8000-000000000022', 'f1025400-0000-4000-8000-000000000012', '服務人員開關B店', 'in_store_beauty');
select public.apply_industry_preset('f1025400-0000-4000-8000-000000000021');
select public.apply_industry_preset('f1025400-0000-4000-8000-000000000022');
insert into merchant_admins (id, merchant_id, user_id) values
  ('f1025400-0000-4000-8000-000000000025', 'f1025400-0000-4000-8000-000000000021', 'f1025400-0000-4000-8000-000000000002');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f1025400-0000-4000-8000-000000000030', 'f1025400-0000-4000-8000-000000000021', '到府服務', 800, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f1025400-0000-4000-8000-000000000050', 'f1025400-0000-4000-8000-000000000021', '現金');

-- 40 = A 店服務人員甲(抽成制、四項全開、可以自己下單);41 = 同一個人在 B 店的身分(邊界 19)。
insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at,
                            unlimited_backend_edit, can_create_edit_orders, show_member_info, phone) values
  ('f1025400-0000-4000-8000-000000000040', 'f1025400-0000-4000-8000-000000000021', 'f1025400-0000-4000-8000-000000000003',
   '服務人員甲', 'piece_rate', 'active', 'active', now(), true, true, true, '0900102540'),
  ('f1025400-0000-4000-8000-000000000041', 'f1025400-0000-4000-8000-000000000022', 'f1025400-0000-4000-8000-000000000003',
   '服務人員甲(B店)', 'piece_rate', 'active', 'active', now(), true, true, true, '0900102540');
insert into merchant_staff_permissions (staff_id, section_key, granted)
select s.id, k.section_key, true
from (values ('f1025400-0000-4000-8000-000000000040'::uuid), ('f1025400-0000-4000-8000-000000000041'::uuid)) s(id)
cross join (values ('staff_calendar_view'), ('staff_availability_self_manage'), ('staff_payroll_view'), ('staff_profile_edit')) k(section_key);

-- 推播訂閱:服務人員甲 + 管理員(⚠️7)。
insert into push_event_subscriptions (merchant_id, target_type, target_id, event_type, enabled) values
  ('f1025400-0000-4000-8000-000000000021', 'staff', 'f1025400-0000-4000-8000-000000000040', 'booking_created', true),
  ('f1025400-0000-4000-8000-000000000021', 'admin', 'f1025400-0000-4000-8000-000000000025', 'booking_created', true);

-- 管理員建單(派給甲)。
create function pg_temp.mk(p_start timestamptz)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f1025400-0000-4000-8000-000000000021',
    p_staff_id => 'f1025400-0000-4000-8000-000000000040',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f1025400-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955102540',
    p_customer_address => '台北市開關路 1 號',
    p_payment_method_id => 'f1025400-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(timestamptz) to authenticated;

-- 服務人員自己建單。
create function pg_temp.smk(p_start timestamptz)
returns uuid language sql as $$
  select (public.staff_create_booking(
    p_staff_id => 'f1025400-0000-4000-8000-000000000040',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f1025400-0000-4000-8000-000000000030','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '自建客人',
    p_customer_phone => '0955102541',
    p_customer_address => '新北市自建路 1 號',
    p_payment_method_id => 'f1025400-0000-4000-8000-000000000050'
  ) ->> 'id')::uuid;
$$;
grant execute on function pg_temp.smk(timestamptz) to authenticated;

select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000002');
select pg_temp.mk('2026-11-20 10:00:00+08') as id \gset b1_
select pg_temp.mk('2026-11-20 14:00:00+08') as id \gset b2_
select pg_temp.mk('2026-11-21 10:00:00+08') as id \gset b3_
select pg_temp.test_clear_auth();

select set_config('test.snapshot_before', pg_temp.staff_settings_snapshot(), true);

-- 甲在 A 店的各種判斷,一次取成一個字串(calendar,availability,payroll,profile,order,slot,listen;t / f)。
-- security definer:staff_order_self_ok / staff_slot_toggle_ok 已 revoke authenticated(只給其他 SECURITY DEFINER 內部呼叫),
-- 這裡比照它們真正的呼叫方式;auth.uid() 讀的是 request.jwt.claims,仍是服務人員本人。
create function pg_temp.order_ok(p_staff uuid)
returns boolean language sql stable security definer as $$
  select private.staff_order_self_ok(p_staff)
$$;

create function pg_temp.flags_a()
returns text language sql stable security definer as $$
  select concat_ws(',',
    private.has_own_staff_permission('f1025400-0000-4000-8000-000000000040', 'staff_calendar_view'),
    private.has_own_staff_permission('f1025400-0000-4000-8000-000000000040', 'staff_availability_self_manage'),
    private.has_own_staff_permission('f1025400-0000-4000-8000-000000000040', 'staff_payroll_view'),
    private.has_own_staff_permission('f1025400-0000-4000-8000-000000000040', 'staff_profile_edit'),
    private.staff_order_self_ok('f1025400-0000-4000-8000-000000000040'),
    private.staff_slot_toggle_ok('f1025400-0000-4000-8000-000000000040'),
    private.can_listen_staff_schedule_topic('staff:f1025400-0000-4000-8000-000000000040:schedule'))
$$;

-- ─── ① 功能清單 ───────────────────────────────────────────────────────────
select is(
  array(select key || ':' || coalesce(parent_key, '-') || ':' || default_enabled::text from platform_features
         where key like 'staff\_%' order by sort_order),
  array['staff_portal:-:true', 'staff_order_editing:staff_portal:true',
        'staff_self_availability:staff_portal:true', 'staff_self_payroll:staff_portal:true'],
  '①-1 功能清單新增 4 項:登入端(主功能)+ 3 個細部功能,預設開');
select is(
  (select count(*)::int from industry_feature_presets where feature_key like 'staff\_%' and default_enabled),
  8, '①-2 兩個產業 × 4 個新功能都有產業預設(開)');
select is(
  (select count(*)::int from merchants m cross join platform_features f
    where not exists (select 1 from merchant_feature_grants g where g.merchant_id = m.id and g.feature_key = f.key)
      and m.id in ('f1025400-0000-4000-8000-000000000021', 'f1025400-0000-4000-8000-000000000022')),
  0, '①-3 開店套用後,每個功能都有開關列');

-- ─── ② 基準 ──────────────────────────────────────────────────────────────
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000003');
select is(pg_temp.flags_a(), 't,t,t,t,t,t,t',
  '②-1 全開:四種權限、建單、時段開關、即時頻道授權都是 true');
select pg_temp.test_clear_auth();

-- ─── ③ staff_portal 關 ───────────────────────────────────────────────────
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_portal', false);
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000003');
select is(pg_temp.flags_a(), 'f,f,f,f,f,f,f',
  '③-1 登入端關:四種權限、建單、時段開關、即時頻道授權全部 false');
select is(private.can_self_manage_availability('f1025400-0000-4000-8000-000000000040'), false, '③-2 排休判斷 false');
select is(private.can_view_staff_own_payroll('f1025400-0000-4000-8000-000000000040'), false, '③-3 自己的薪資判斷 false');
select throws_ok(
  $$select * from public.get_my_booking_schedule('f1025400-0000-4000-8000-000000000040', '2026-11-20', '2026-11-21')$$,
  '42501', null, '③-4 get_my_booking_schedule 被擋');
select throws_ok(
  format($$select public.staff_confirm_booking(%L)$$, :'b1_id'),
  '42501', null, '③-5 確認接單被擋');
select throws_ok(
  $$select pg_temp.smk('2026-11-22 10:00:00+08')$$,
  '42501', null, '③-6 服務人員自己建單被擋');
select throws_ok(
  format($$select public.staff_cancel_booking(%L, '不要了')$$, :'b2_id'),
  '42501', null, '③-7 服務人員取消自己的單被擋');
select throws_ok(
  $$select * from public.generate_own_staff_line_binding_code('f1025400-0000-4000-8000-000000000021')$$,
  '42501', '這個功能目前沒有開放。', '③-8 服務人員自己產生 LINE 綁定碼被擋(固定一句,不帶資料)');
select throws_ok(
  $$select public.set_staff_day_override('f1025400-0000-4000-8000-000000000040', '2026-11-25', '10:00', '11:00', false)$$,
  '42501', null, '③-9 自己排休被擋');
select throws_ok(
  $$select * from public.get_staff_commission_summary('f1025400-0000-4000-8000-000000000040', 2026, 11)$$,
  '42501', null, '③-10 自己的抽成報表被擋');
-- 邊界 19:同一個人在 B 店照常。
select is(
  private.has_own_staff_permission('f1025400-0000-4000-8000-000000000041', 'staff_calendar_view')
  and pg_temp.order_ok('f1025400-0000-4000-8000-000000000041')
  and private.can_listen_staff_schedule_topic('staff:f1025400-0000-4000-8000-000000000041:schedule'),
  true, '③-11 同一個人在 B 店(登入端開著)照常(邊界 19)');
select pg_temp.test_clear_auth();

-- 店家後台照常:派給甲建單、自己確認訂單。
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000002');
select lives_ok(
  $$select pg_temp.mk('2026-11-23 10:00:00+08')$$,
  '③-12 登入端關掉時,管理員照常建單派給這位服務人員');
select lives_ok(
  format($$select public.confirm_booking(%L)$$, :'b1_id'),
  '③-13 管理員照常在後台確認訂單(F9)');
select is(
  (select status from bookings where id = :'b1_id'::uuid), 'accepted', '③-14 確認後訂單變已確認');
select pg_temp.test_clear_auth();

-- ⚠️7 推播收件人。
select is(
  array(select target_type from public.resolve_push_recipients(
          'f1025400-0000-4000-8000-000000000021', 'booking_created', 'f1025400-0000-4000-8000-000000000040') order by 1),
  array['admin'],
  '③-15 ⚠️7 登入端關:推播收件人不含服務人員,管理員照常');
select is(
  public.internal_merchant_has_feature('f1025400-0000-4000-8000-000000000021', 'staff_portal'),
  false, '③-16 internal_merchant_has_feature 反映登入端已關');
select is(
  public.internal_merchant_has_feature('f1025400-0000-4000-8000-000000000021', 'staff_self_payroll'),
  false, '③-17 細部功能自己的列是開的,但主功能關 ⇒ false(T5)');
select is(pg_temp.staff_settings_snapshot(), current_setting('test.snapshot_before'),
  '③-18 平台關掉登入端,個人權限與 merchant_staff 開關一個值都沒變(T9)');

-- ─── ④ 登入端開、staff_order_editing 關 ─────────────────────────────────
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_portal', true);
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_order_editing', false);
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000003');
select is(pg_temp.flags_a(), 't,t,t,t,f,f,t',
  '④-1 只關新增編輯訂單:四種權限與即時頻道照常;建單、時段開關 false');
select throws_ok(
  $$select pg_temp.smk('2026-11-22 10:00:00+08')$$,
  '42501', null, '④-2 服務人員自己建單被擋');
select throws_ok(
  format($$select public.staff_cancel_booking(%L, '不要了')$$, :'b2_id'),
  '42501', null, '④-3 服務人員取消自己的單被擋');
select throws_ok(
  $$select public.staff_set_my_slot('f1025400-0000-4000-8000-000000000040', '2026-11-25', '10:00', '11:00', false)$$,
  '42501', null, '④-4 時間軸開關自己的時段被擋');
select lives_ok(
  $$select * from public.get_my_booking_schedule('f1025400-0000-4000-8000-000000000040', '2026-11-20', '2026-11-21')$$,
  '④-5 行事曆照常');
select lives_ok(
  format($$select public.staff_confirm_booking(%L)$$, :'b2_id'),
  '④-6 確認接單照常');
select lives_ok(
  $$select * from public.generate_own_staff_line_binding_code('f1025400-0000-4000-8000-000000000021')$$,
  '④-7 自己綁 LINE 照常(只看登入端)');
select pg_temp.test_clear_auth();
select is(
  array(select target_type from public.resolve_push_recipients(
          'f1025400-0000-4000-8000-000000000021', 'booking_created', 'f1025400-0000-4000-8000-000000000040') order by 1),
  array['admin', 'staff'],
  '④-8 登入端開著:推播收件人恢復含服務人員');
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_order_editing', true);

-- ─── ⑤ staff_self_availability 關 ───────────────────────────────────────
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_self_availability', false);
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000003');
select is(pg_temp.flags_a(), 't,f,t,t,t,f,t',
  '⑤-1 只關自己排休:排休權限、時段開關 false;行事曆、薪資、建單、即時頻道照常');
select is(private.can_self_manage_availability('f1025400-0000-4000-8000-000000000040'), false, '⑤-2 排休判斷 false');
select throws_ok(
  $$select public.set_staff_day_override('f1025400-0000-4000-8000-000000000040', '2026-11-25', '10:00', '11:00', false)$$,
  '42501', null, '⑤-3 自己排休 RPC 被擋');
select lives_ok(
  $$select * from public.get_my_booking_schedule('f1025400-0000-4000-8000-000000000040', '2026-11-20', '2026-11-21')$$,
  '⑤-4 行事曆照常');
select pg_temp.test_clear_auth();
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_self_availability', true);

-- ─── ⑥ staff_self_payroll 關 ────────────────────────────────────────────
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_self_payroll', false);
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000003');
select is(pg_temp.flags_a(), 't,t,f,t,t,t,t',
  '⑥-1 只關自己的抽成薪資:薪資權限 false,其他照常');
select is(private.can_view_staff_own_payroll('f1025400-0000-4000-8000-000000000040'), false, '⑥-2 自己的薪資判斷 false');
select throws_ok(
  $$select * from public.get_staff_commission_summary('f1025400-0000-4000-8000-000000000040', 2026, 11)$$,
  '42501', null, '⑥-3 自己的抽成報表被擋');
select lives_ok(
  $$select public.set_staff_day_override('f1025400-0000-4000-8000-000000000040', '2026-11-25', '10:00', '11:00', false)$$,
  '⑥-4 排休照常');
select pg_temp.test_clear_auth();
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000002');
select lives_ok(
  $$select * from public.get_staff_commission_summary('f1025400-0000-4000-8000-000000000040', 2026, 11)$$,
  '⑥-5 店家管理員看服務人員報表照常');
select pg_temp.test_clear_auth();
select pg_temp.set_feature('f1025400-0000-4000-8000-000000000021', 'staff_self_payroll', true);

-- ─── ⑦ 全部重新打開 ─────────────────────────────────────────────────────
select pg_temp.test_set_auth('f1025400-0000-4000-8000-000000000003');
select is(pg_temp.flags_a(), 't,t,t,t,t,t,t', '⑦-1 重新全開:權限全部恢復');
select lives_ok(
  format($$select public.staff_confirm_booking(%L)$$, :'b3_id'),
  '⑦-2 確認接單恢復');
select pg_temp.test_clear_auth();
select is(pg_temp.staff_settings_snapshot(), current_setting('test.snapshot_before'),
  '⑦-3 整個過程個人權限與 merchant_staff 開關完全沒變(T9)');
select is(
  (select count(*)::int from merchant_feature_grant_logs where merchant_id = 'f1025400-0000-4000-8000-000000000021'),
  8, '⑦-4 每次平台開關都留紀錄(4 關 + 4 開)');

-- ─── ⑧ ACL ────────────────────────────────────────────────────────────────
select is(
  array[
    has_function_privilege('anon', 'public.internal_merchant_has_feature(uuid, text)', 'execute'),
    has_function_privilege('authenticated', 'public.internal_merchant_has_feature(uuid, text)', 'execute'),
    has_function_privilege('service_role', 'public.internal_merchant_has_feature(uuid, text)', 'execute')
  ],
  array[false, false, true],
  '⑧-1 internal_merchant_has_feature 只給 service_role');
select is(
  array[
    has_function_privilege('anon', 'public.resolve_push_recipients(uuid, text, uuid)', 'execute'),
    has_function_privilege('authenticated', 'public.resolve_push_recipients(uuid, text, uuid)', 'execute'),
    has_function_privilege('authenticated', 'private.staff_order_self_ok(uuid)', 'execute'),
    has_function_privilege('anon', 'private.has_own_staff_permission(uuid, text)', 'execute'),
    has_function_privilege('anon', 'public.generate_own_staff_line_binding_code(uuid)', 'execute'),
    has_function_privilege('authenticated', 'public.generate_own_staff_line_binding_code(uuid)', 'execute')
  ],
  array[false, false, false, false, false, true],
  '⑧-2 改過的四支函式 ACL 維持原樣');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in ('has_own_staff_permission', 'staff_order_self_ok', 'generate_own_staff_line_binding_code',
                        'resolve_push_recipients', 'internal_merchant_has_feature')
      and p.prosecdef
      and p.proconfig @> array['search_path=public']),
  5, '⑧-3 五支函式都是 SECURITY DEFINER + search_path = public');

select * from finish();
rollback;
