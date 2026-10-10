-- SPECS-INDEX #1025 功能開關 第 2 批 FG2-T01:LINE 通知 / 再行銷通知 / 手機推播通知的資料庫擋住點
-- migration 20261010220000_req1025_fg2_line_push_features.sql、20261010220100_req1025_fg2_line_push_gates.sql
-- 規格書 .project/specs/功能開關.md(第 2 版)FG2-A01、FG2-F01、FG2-T01;第二節「新增功能的約定」。
--
--   ①  功能清單 3 項(line_marketing 的主功能是 line_notifications)、兩產業預設、所有商家 × 所有功能都有一列
--   ②  internal_merchant_has_feature 只有 service_role 能執行(FG-3 建立,FG-2 沿用)
--   ③  基準(全開):店家 LINE 有收件人、客人待發列寫得進去、會員中心 / 公開頁 available = true
--   ④  line_notifications 關:resolve 回空清單(不報錯)、enqueue 不寫列、available = false、
--      再行銷跟著關(細部值保留);帶別家訂單照樣 P0002(#972 順序不變);另一間店不受影響
--   ⑤  重新打開:全部恢復;再行銷原值還在
--   ⑥  只關 line_marketing:只有再行銷關,其他 LINE 照常
--   ⑦  push_notifications 關:判斷為關;推播發送記錄接受 feature_disabled、不接受亂填的原因
--   ⑧  超級管理員畫面讀的資料:get_merchant_features 細部功能 effective 跟著主功能、granted 保留;
--      統計 platform_feature_usage_summary 細部功能跟著主功能算關
--   ⑨  商家管理員不能自己打開(沒有寫入權限)
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

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

-- 平台開關:用超級管理員的 RPC(走真正的寫入路徑)。
create function pg_temp.set_feature(p_merchant uuid, p_key text, p_enabled boolean)
returns void language plpgsql as $$
begin
  perform pg_temp.test_set_auth('f1025300-0000-4000-8000-000000000001');
  perform public.platform_set_merchant_feature(p_merchant, p_key, p_enabled);
  perform pg_temp.test_clear_auth();
end;
$$;

create function pg_temp.has(p_merchant uuid, p_key text)
returns boolean language sql stable as $$ select public.internal_merchant_has_feature(p_merchant, p_key) $$;

create function pg_temp.targets()
returns jsonb language sql stable as $$
  select public.resolve_line_notification_targets('f1025300-0000-4000-8000-000000000021', 'booking_created', null, null)
$$;

create function pg_temp.outbox_count()
returns integer language sql stable as $$
  select count(*)::int from customer_line_outbox where merchant_id = 'f1025300-0000-4000-8000-000000000021'
$$;

create function pg_temp.err(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- ─── Fixture ───────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('f1025300-0000-4000-8000-000000000001', 'pgtap-1025l-platform@test.local'),
  ('f1025300-0000-4000-8000-000000000002', 'pgtap-1025l-admin-a@test.local');
insert into platform_admins (user_id) values ('f1025300-0000-4000-8000-000000000001');

insert into groups (id) values
  ('f1025300-0000-4000-8000-000000000011'),
  ('f1025300-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type, booking_slug, status) values
  ('f1025300-0000-4000-8000-000000000021', 'f1025300-0000-4000-8000-000000000011', 'LINE開關A店', 'on_site_dispatch', 'pgtap-fg2-a', 'active'),
  ('f1025300-0000-4000-8000-000000000022', 'f1025300-0000-4000-8000-000000000012', 'LINE開關B店', 'in_store_beauty', 'pgtap-fg2-b', 'active');
select public.apply_industry_preset('f1025300-0000-4000-8000-000000000021');
select public.apply_industry_preset('f1025300-0000-4000-8000-000000000022');

insert into merchant_admins (id, merchant_id, user_id, line_bound, line_user_id) values
  ('f1025300-0000-4000-8000-000000000025', 'f1025300-0000-4000-8000-000000000021', 'f1025300-0000-4000-8000-000000000002',
   true, 'U00000000000000000000000000f20025');

insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected) values
  ('f1025300-0000-4000-8000-000000000021', '1234567825', 'FG2-SECRET-SENTINEL', 'FG2-TOKEN-SENTINEL', true),
  ('f1025300-0000-4000-8000-000000000022', '1234567826', 'FG2B-SECRET-SENTINEL', 'FG2B-TOKEN-SENTINEL', true);
insert into merchant_line_event_settings (merchant_id, event_type, enabled, notify_admin, notify_agent, notify_staff, notify_member, message_template) values
  ('f1025300-0000-4000-8000-000000000021', 'booking_created', true, true, false, false, false, '新預約');
insert into merchant_customer_line_settings (merchant_id, on_confirmed) values
  ('f1025300-0000-4000-8000-000000000021', true),
  ('f1025300-0000-4000-8000-000000000022', true);

-- B 店的一張訂單(用來驗「帶別家的訂單編號」照樣 P0002)。
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f1025300-0000-4000-8000-000000000030', 'f1025300-0000-4000-8000-000000000022', '剪髮', 500, 'primary', 60);
insert into merchant_staff (id, merchant_id, name, status, login_status, phone) values
  ('f1025300-0000-4000-8000-000000000040', 'f1025300-0000-4000-8000-000000000022', 'B店服務人員', 'active', 'not_invited', '0900102530');
insert into bookings (id, merchant_id, staff_id, start_at, end_at, status, customer_name, customer_phone, source, created_by_role)
values ('f1025300-0000-4000-8000-000000000090', 'f1025300-0000-4000-8000-000000000022', 'f1025300-0000-4000-8000-000000000040',
        now() + interval '3 days', now() + interval '3 days 1 hour', 'accepted', '王先生', '0955102530', 'manual', 'admin');

-- =========================================================================
-- ① 功能清單、產業預設、完整性
-- =========================================================================
select is((select string_agg(key || ':' || coalesce(parent_key, '-') || ':' || sort_order || ':' || default_enabled, ',' order by sort_order)
             from platform_features where key in ('line_notifications', 'line_marketing', 'push_notifications')),
          'line_notifications:-:50:true,line_marketing:line_notifications:51:true,push_notifications:-:60:true',
          '① 功能清單三項:再行銷是 LINE 通知底下的細部功能;預設全開');
select is((select name from platform_features where key = 'line_marketing'), '再行銷通知', '① 名稱照規格');
select is((select count(*)::int from industry_feature_presets
            where feature_key in ('line_notifications', 'line_marketing', 'push_notifications') and default_enabled),
          6, '① 兩個產業 × 三個功能的預設都是開');
select is((select count(*)::int from merchants m cross join platform_features f
            where not exists (select 1 from merchant_feature_grants g where g.merchant_id = m.id and g.feature_key = f.key)),
          0, '① 通用完整性:所有商家 × 所有功能都有開關列(含新開店)');
select is((select count(*)::int from industry_feature_presets p join platform_features f on f.key = p.feature_key
            where p.industry_type in ('on_site_dispatch', 'in_store_beauty')),
          2 * (select count(*)::int from platform_features), '① 兩產業 × 所有功能都有預設');
select is((select count(*)::int from merchant_feature_grants
            where merchant_id = 'f1025300-0000-4000-8000-000000000021'
              and feature_key in ('line_notifications', 'line_marketing', 'push_notifications') and enabled),
          3, '① 新開的店三個功能都開(產業預設)');

-- =========================================================================
-- ② internal_merchant_has_feature 權限
-- =========================================================================
select ok(not has_function_privilege('anon', 'public.internal_merchant_has_feature(uuid, text)', 'execute'), '② anon 不能執行');
select ok(not has_function_privilege('authenticated', 'public.internal_merchant_has_feature(uuid, text)', 'execute'), '② authenticated 不能執行');
select ok(has_function_privilege('service_role', 'public.internal_merchant_has_feature(uuid, text)', 'execute'), '② service_role 可以執行');
select ok(not has_function_privilege('authenticated', 'private.customer_line_notify_available(uuid)', 'execute'), '② customer_line_notify_available 仍只給內部');
select ok(not has_function_privilege('service_role', 'private.enqueue_customer_line(text, uuid, uuid, uuid, uuid, jsonb, timestamptz, text)', 'execute'), '② enqueue_customer_line ACL 不變(service_role 也不行)');

-- =========================================================================
-- ③ 基準:全開
-- =========================================================================
select ok(pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_notifications')
          and pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_marketing')
          and pg_temp.has('f1025300-0000-4000-8000-000000000021', 'push_notifications'), '③ 全開時三個都是開');
select is(jsonb_array_length(pg_temp.targets() -> 'targets'), 1, '③ 店家 LINE:管理員是收件人');
select is((pg_temp.targets() ->> 'connected'), 'true', '③ connected = true');
select private.enqueue_customer_line('customer_confirmed', 'f1025300-0000-4000-8000-000000000021', null, null, null, '{}'::jsonb, now(), 'fg2-base');
select is(pg_temp.outbox_count(), 1, '③ 客人 LINE:待發列寫得進去');
select ok(private.customer_line_notify_available('f1025300-0000-4000-8000-000000000021'), '③ 會員中心 available = true');
select is((public.get_public_booking_page('pgtap-fg2-a') -> 'booking_settings' ->> 'line_notify_available'), 'true', '③ 公開頁 line_notify_available = true');

-- =========================================================================
-- ④ LINE 通知關
-- =========================================================================
select pg_temp.set_feature('f1025300-0000-4000-8000-000000000021', 'line_notifications', false);
select is(pg_temp.targets(),
          '{"connected": false, "event_enabled": false, "targets": [], "skipped": [], "feature_disabled": true}'::jsonb,
          '④ resolve_line_notification_targets 回空清單(不報錯)');
select is(pg_temp.err($$select public.resolve_line_notification_targets('f1025300-0000-4000-8000-000000000021', 'booking_created', 'f1025300-0000-4000-8000-000000000090', null)$$),
          'P0002', '④ 帶別家的訂單編號照樣 P0002(歸屬檢查在開關之前,#972)');
select private.enqueue_customer_line('customer_confirmed', 'f1025300-0000-4000-8000-000000000021', null, null, null, '{}'::jsonb, now(), 'fg2-off');
select is(pg_temp.outbox_count(), 1, '④ enqueue_customer_line 不寫待發列(仍是原本那 1 列)');
select ok(not private.customer_line_notify_available('f1025300-0000-4000-8000-000000000021'), '④ 會員中心 available = false(區塊 / 加好友卡不顯示)');
select is((public.get_public_booking_page('pgtap-fg2-a') -> 'booking_settings' ->> 'line_notify_available'), 'false', '④ 公開頁 line_notify_available = false');
select is(private.default_member_completion_message('f1025300-0000-4000-8000-000000000021', 'pending'),
          '店家確認後會通知您。', '④ 預約完成頁文案不再提 LINE');
select ok(not pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_marketing'), '④ 再行銷跟著主功能關(T5)');
select is((select enabled from merchant_feature_grants where merchant_id = 'f1025300-0000-4000-8000-000000000021' and feature_key = 'line_marketing'),
          true, '④ 再行銷自己的值保留(還是開)');
select ok(pg_temp.has('f1025300-0000-4000-8000-000000000021', 'push_notifications'), '④ 手機推播不受影響');
select ok(pg_temp.has('f1025300-0000-4000-8000-000000000022', 'line_notifications'), '④ 另一間店不受影響');
select private.enqueue_customer_line('customer_confirmed', 'f1025300-0000-4000-8000-000000000022', null, null, null, '{}'::jsonb, now(), 'fg2-b');
select is((select count(*)::int from customer_line_outbox where merchant_id = 'f1025300-0000-4000-8000-000000000022'), 1, '④ 另一間店照常寫待發列');

-- =========================================================================
-- ⑤ 重新打開
-- =========================================================================
select pg_temp.set_feature('f1025300-0000-4000-8000-000000000021', 'line_notifications', true);
select is(jsonb_array_length(pg_temp.targets() -> 'targets'), 1, '⑤ 重新打開:收件人恢復');
select ok(pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_marketing'), '⑤ 再行銷原值恢復(不用重設)');
select ok(private.customer_line_notify_available('f1025300-0000-4000-8000-000000000021'), '⑤ 會員中心 available 恢復');

-- =========================================================================
-- ⑥ 只關再行銷
-- =========================================================================
select pg_temp.set_feature('f1025300-0000-4000-8000-000000000021', 'line_marketing', false);
select ok(not pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_marketing')
          and pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_notifications'), '⑥ 只有再行銷關,LINE 通知照常');
select is(jsonb_array_length(pg_temp.targets() -> 'targets'), 1, '⑥ 店家 LINE 照常有收件人');
select pg_temp.set_feature('f1025300-0000-4000-8000-000000000021', 'line_marketing', true);

-- =========================================================================
-- ⑦ 手機推播關
-- =========================================================================
select pg_temp.set_feature('f1025300-0000-4000-8000-000000000021', 'push_notifications', false);
select ok(not pg_temp.has('f1025300-0000-4000-8000-000000000021', 'push_notifications'), '⑦ 手機推播判斷為關');
select is(pg_temp.err($$insert into push_notification_log (merchant_id, event_type, status, skip_reason, device_count, success_count)
                        values ('f1025300-0000-4000-8000-000000000021', 'booking_created', 'skipped', 'feature_disabled', 0, 0)$$),
          'ok', '⑦ 推播發送記錄接受 feature_disabled');
select is(pg_temp.err($$insert into push_notification_log (merchant_id, event_type, status, skip_reason, device_count, success_count)
                        values ('f1025300-0000-4000-8000-000000000021', 'booking_created', 'skipped', 'bogus_reason', 0, 0)$$),
          '23514', '⑦ 亂填的原因照樣被擋');

-- =========================================================================
-- ⑧ 超級管理員畫面讀的資料
-- =========================================================================
select pg_temp.set_feature('f1025300-0000-4000-8000-000000000021', 'line_notifications', false);
select pg_temp.test_set_auth('f1025300-0000-4000-8000-000000000002');
select is((select granted::text || '/' || effective::text from public.get_merchant_features('f1025300-0000-4000-8000-000000000021')
            where feature_key = 'line_marketing'),
          'true/false', '⑧ get_merchant_features:主功能關 ⇒ 細部 effective 關、granted 保留');
select pg_temp.test_clear_auth();
create temp table fg2_expected as
  select count(*)::int as n from merchants m where not private.merchant_has_feature(m.id, 'line_marketing');
grant select on fg2_expected to authenticated;
select pg_temp.test_set_auth('f1025300-0000-4000-8000-000000000001');
select is((select disabled_count from public.platform_feature_usage_summary() where feature_key = 'line_marketing'),
          (select n from fg2_expected),
          '⑧ 統計:細部功能跟著主功能算關');
select ok((select disabled_count from public.platform_feature_usage_summary() where feature_key = 'line_marketing') >= 1,
          '⑧ 統計:A 店的再行銷算在關');
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨ 商家管理員不能自己打開
-- =========================================================================
select pg_temp.test_set_auth('f1025300-0000-4000-8000-000000000002');
select is(pg_temp.err($$update merchant_feature_grants set enabled = true
                        where merchant_id = 'f1025300-0000-4000-8000-000000000021' and feature_key = 'line_notifications'$$),
          '42501', '⑨ 商家管理員直接改開關表 ⇒ 被擋');
select is(pg_temp.err($$select public.platform_set_merchant_feature('f1025300-0000-4000-8000-000000000021', 'line_notifications', true)$$),
          '42501', '⑨ 商家管理員呼叫平台 RPC ⇒ 42501');
select pg_temp.test_clear_auth();
select ok(not pg_temp.has('f1025300-0000-4000-8000-000000000021', 'line_notifications'), '⑨ 開關仍然是關');

select * from finish();
rollback;
