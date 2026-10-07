-- SPECS-INDEX #986 第 9 批(2026-10-07):服務人員建單 / 編輯看得到、改得了料錢 + options 多回描述與建單時間間隔
-- migration 20261007120000_req986_service_item_description.sql
--           20261007120100_req986_staff_order_material_costs.sql
-- 規格書 .project/specs/使用者裁決小項與第7批調整-第9批.md 3-1、3-3、3-4、5-1。
--
--   ①~②    overload:staff_create_booking、staff_update_booking 各只有一支
--   ③~⑥    指紋:4 支重建函式拿掉 [req986-batch9] 段落、改過的幾行換回原文後 = 改前指紋
--   ⑦~⑧    ACL(public / anon 無 EXECUTE、authenticated 有)、security definer / stable 不變
--   ⑨       抽成計算 4 支指紋未變
--   ⑩~⑮    staff_get_booking_form_options:料錢(開 / 關)、key 清單、建單時間間隔、服務項目描述
--   ⑯~㉑    staff_create_booking 帶料錢:上架品項寫入快照;別家 / 已下架 / 總開關關 ⇒ 擋;null、不帶 ⇒ 0 筆
--   ㉒~㉖    staff_update_booking 帶料錢:null 不變、{} 清空、加新品項、原本就有的已下架品項不擋、新加已下架品項擋
--   ㉗~㉙    協助人員 / 別人的單 / 開關關的服務人員 ⇒ 擋(新參數沒有開新洞)
--   ㉚~㉛    staff_get_booking_for_edit:material_costs(含 is_active = false);隱藏備註仍不回原文
--   ㉜~㉝    抽成:第 8 批開關開 / 關,服務人員改過料錢的單跟客服改的同一張單抽成相同
begin;

select plan(33);

-- #987 第 10 批(2026-10-07):complete_booking、recalculate_booking_commission 的錯誤訊息半形標點改成全形。
-- 這裡先把第 10 批改過的訊息換回舊訊息(完整 SQL 字串字面值,含單引號),再套原本的還原規則比指紋;
-- 第 10 批自己「只動訊息」的證明見 req987_0*_fullwidth_messages_*.sql。
create function pg_temp.req987_revert(p_src text) returns text language plpgsql immutable as $req987$
declare
  v_pairs text[] := array[
    $m$'只有「已接受」狀態的預約可以標記完成，目前狀態不允許這個操作'$m$, $m$'只有「已接受」狀態的預約可以標記完成,目前狀態不允許這個操作'$m$,
    $m$'重新計算已完成訂單的抽成金額，只有商家管理員可以操作'$m$, $m$'重新計算已完成訂單的抽成金額,只有商家管理員可以操作'$m$,
    $m$'這筆訂單目前沒有抽成紀錄，無法重新計算(可能是月薪制服務人員，不適用抽成)'$m$, $m$'這筆訂單目前沒有抽成紀錄,無法重新計算(可能是月薪制服務人員,不適用抽成)'$m$
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

-- =========================================================================
-- ①~⑨ 結構:overload、指紋、ACL、抽成 4 支
-- =========================================================================
select is((select count(*)::int from pg_proc where proname = 'staff_create_booking'), 1, '① staff_create_booking 只有一支(沒有同名 overload)');
select is((select count(*)::int from pg_proc where proname = 'staff_update_booking'), 1, '② staff_update_booking 只有一支(沒有同名 overload)');

create temp table r986a_fp on commit drop as
  select p.proname::text as proname,
    md5(
      replace(replace(replace(replace(
        regexp_replace(replace(p.prosrc, E'\r\n', E'\n'),
          '[ ]*?-- \[req986-batch9 begin\].*?-- \[req986-batch9 end\]\n', '', 'g'),
        '  -- 不回傳任何客戶、會員、其他服務人員資料。料錢:#986 第 9 批推翻主腦決定 C,總開關開著才回本店上架品項(名稱、金額)。',
        '  -- 不回傳任何客戶、會員、其他服務人員資料;料錢(主腦決定 C:服務人員模式不顯示)也不回。'),
        '料錢用前端傳的值(#986 第 9 批;null = 不帶)', '料錢一律空陣列(主腦決定 C)'),
        'p_material_cost_item_ids => coalesce(p_material_cost_item_ids, ''{}''::uuid[]),', 'p_material_cost_item_ids => ''{}''::uuid[],'),
        -- 第 11 批 F #993:參數改成 jsonb(p_material_cost_items),先換回第 9 批的寫法再比。
        'p_material_cost_items => coalesce(p_material_cost_items, ''[]''::jsonb),', 'p_material_cost_item_ids => ''{}''::uuid[],')
    ) as reverted
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('staff_get_booking_form_options', 'staff_get_booking_for_edit', 'staff_create_booking', 'staff_update_booking');

select is((select reverted from r986a_fp where proname = 'staff_get_booking_form_options'), '8d8cfd4b0a2f4f079c0f406ccfe087ae',
  '③ staff_get_booking_form_options 拿掉本批段落、註解換回原文後 = 改前指紋');
select is((select reverted from r986a_fp where proname = 'staff_get_booking_for_edit'), 'c1b32819db641ed937acceb8f0b81020',
  '④ staff_get_booking_for_edit 拿掉本批段落後 = 改前指紋');
select is((select reverted from r986a_fp where proname = 'staff_create_booking'), 'e919014463059cc4e992346f8e22bef8',
  '⑤ staff_create_booking 拿掉本批段落、註解與料錢參數值換回原文後 = 改前指紋');
-- 第 11 批 F #993(migration 20261007140300)把 staff_update_booking 的料錢改成 jsonb(連同數量、單價保留),
-- 基準改成「F 版本拿掉本批段落後」的指紋;第 9 批改前指紋 e0e56ecfb266aac0f4ceb1cc411b54ad。
select is((select reverted from r986a_fp where proname = 'staff_update_booking'), '444c74b0bcae2056ae393618ad1a0783',
  '⑥ staff_update_booking 拿掉本批段落後 = 改前指紋');

select is(
  (select string_agg(p.proname || ':' || array_to_string(p.proacl, ' '), ' | ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('staff_get_booking_form_options', 'staff_get_booking_for_edit', 'staff_create_booking', 'staff_update_booking')),
  'staff_create_booking:postgres=X/postgres authenticated=X/postgres service_role=X/postgres | '
  || 'staff_get_booking_for_edit:postgres=X/postgres authenticated=X/postgres service_role=X/postgres | '
  || 'staff_get_booking_form_options:postgres=X/postgres authenticated=X/postgres service_role=X/postgres | '
  || 'staff_update_booking:postgres=X/postgres authenticated=X/postgres service_role=X/postgres',
  '⑦ 4 支的 ACL:沒有 PUBLIC / anon,只給 authenticated 與 service_role'
);
select is(
  (select string_agg(p.proname || ':' || p.prosecdef::text || '/' || p.provolatile::text, ' ' order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('staff_get_booking_form_options', 'staff_get_booking_for_edit', 'staff_create_booking', 'staff_update_booking')),
  'staff_create_booking:true/v staff_get_booking_for_edit:true/s staff_get_booking_form_options:true/s staff_update_booking:true/v',
  '⑧ 4 支都還是 SECURITY DEFINER;兩支讀取仍是 STABLE、兩支寫入仍是 VOLATILE'
);
select is(
  (select string_agg(p.proname || ':' || md5(pg_temp.req987_revert(replace(replace(p.prosrc, E'\r\n', E'\n'),
     -- 第 11 批 F #993:扣除料錢改成「單價 × 數量」——先換回改前的寫法再比指紋。
     E'    -- 第 11 批 F #993:amount_snapshot 是「單價」,扣除料錢 = Σ 單價 × 數量。\n    select coalesce(sum(amount_snapshot * quantity), 0)',
     '    select coalesce(sum(amount_snapshot), 0)'))), ' ' order by p.proname)
   from pg_proc p
   where p.oid in ('private.calculate_booking_staff_commission(uuid, uuid)'::regprocedure,
                   'public.compute_booking_commission(uuid)'::regprocedure,
                   'public.recalculate_booking_commission(uuid)'::regprocedure,
                   'public.complete_booking(uuid)'::regprocedure)),
  'calculate_booking_staff_commission:0a46ab26a17bc373589b14d17173bbc2 complete_booking:a1b9c712eac0b47e99f57e13a9013705 '
  || 'compute_booking_commission:cc8e2a2b366c5a83b1fb65c8261e6062 recalculate_booking_commission:cdabc100207b2e27cc062f3303b5f501',
  '⑨ 抽成計算 4 支(calculate / compute / recalculate / complete)指紋未變(#987 第 10 批的錯誤訊息標點先換回舊訊息再比)'
);

-- =========================================================================
-- Fixture
--   使用者:01 A 店管理員 / 02 A 店客服(訂單管理)/ 05 服務人員 P(可以自己下單)/
--           07 服務人員 Q(沒開「新增編輯訂單」)/ 08 服務人員 R(可以自己下單,當協助人員)/ 06 B 店管理員
-- =========================================================================
insert into auth.users (id, email) values
  ('f9860000-0000-4000-8000-000000000001', 'pgtap-r986a-admin@test.local'),
  ('f9860000-0000-4000-8000-000000000002', 'pgtap-r986a-agent@test.local'),
  ('f9860000-0000-4000-8000-000000000005', 'pgtap-r986a-staffP@test.local'),
  ('f9860000-0000-4000-8000-000000000006', 'pgtap-r986a-adminB@test.local'),
  ('f9860000-0000-4000-8000-000000000007', 'pgtap-r986a-staffQ@test.local'),
  ('f9860000-0000-4000-8000-000000000008', 'pgtap-r986a-staffR@test.local');

insert into groups (id) values
  ('f9860000-0000-4000-8000-000000000011'),
  ('f9860000-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f9860000-0000-4000-8000-000000000020', 'f9860000-0000-4000-8000-000000000011', '#986 A 店', 'on_site_dispatch'),
  ('f9860000-0000-4000-8000-000000000021', 'f9860000-0000-4000-8000-000000000012', '#986 B 店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f9860000-0000-4000-8000-000000000020', 'f9860000-0000-4000-8000-000000000001', '店主甲'),
  ('f9860000-0000-4000-8000-000000000021', 'f9860000-0000-4000-8000-000000000006', '店主乙');
insert into merchant_agents (id, merchant_id, user_id, name, invited_email, status, activated_at, phone) values
  ('f9860000-0000-4000-8000-000000000022', 'f9860000-0000-4000-8000-000000000020', 'f9860000-0000-4000-8000-000000000002', '訂單客服', 'pgtap-r986a-agent@test.local', 'active', now(), '0900986022');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9860000-0000-4000-8000-000000000022', 'orders', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9860000-0000-4000-8000-000000000031', 'f9860000-0000-4000-8000-000000000020', 'S1', 3000, 'primary', 60),
  ('f9860000-0000-4000-8000-000000000032', 'f9860000-0000-4000-8000-000000000020', 'S2', 800, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9860000-0000-4000-8000-000000000050', 'f9860000-0000-4000-8000-000000000020', '現金');
-- 料錢:M500、M600、M_old(之後下架)、M_off(已下架)、B 店的 MB。
insert into material_cost_items (id, merchant_id, name, amount, status) values
  ('f9860000-0000-4000-8000-000000000060', 'f9860000-0000-4000-8000-000000000020', 'M500', 500, 'active'),
  ('f9860000-0000-4000-8000-000000000061', 'f9860000-0000-4000-8000-000000000020', 'M600', 600, 'active'),
  ('f9860000-0000-4000-8000-000000000062', 'f9860000-0000-4000-8000-000000000020', 'M_old', 120, 'active'),
  ('f9860000-0000-4000-8000-000000000064', 'f9860000-0000-4000-8000-000000000020', 'M_off', 90, 'removed'),
  ('f9860000-0000-4000-8000-000000000065', 'f9860000-0000-4000-8000-000000000021', 'MB', 70, 'active');
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('f9860000-0000-4000-8000-000000000020', 'material_cost_enabled', true),
  ('f9860000-0000-4000-8000-000000000021', 'material_cost_enabled', true);

insert into merchant_staff (id, merchant_id, user_id, name, compensation_type, status, login_status, login_activated_at, unlimited_backend_edit, phone, can_create_edit_orders, show_member_info) values
  ('f9860000-0000-4000-8000-000000000040', 'f9860000-0000-4000-8000-000000000020', 'f9860000-0000-4000-8000-000000000005', '服務人員P', 'piece_rate', 'active', 'active', now(), true, '0900986040', true, true),
  ('f9860000-0000-4000-8000-000000000041', 'f9860000-0000-4000-8000-000000000020', 'f9860000-0000-4000-8000-000000000007', '服務人員Q', 'piece_rate', 'active', 'active', now(), true, '0900986041', false, true),
  ('f9860000-0000-4000-8000-000000000042', 'f9860000-0000-4000-8000-000000000020', 'f9860000-0000-4000-8000-000000000008', '服務人員R', 'piece_rate', 'active', 'active', now(), true, '0900986042', true, true);
insert into merchant_staff_permissions (staff_id, section_key, granted) values
  ('f9860000-0000-4000-8000-000000000040', 'staff_calendar_view', true),
  ('f9860000-0000-4000-8000-000000000041', 'staff_calendar_view', true),
  ('f9860000-0000-4000-8000-000000000042', 'staff_calendar_view', true);
insert into staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value) values
  ('f9860000-0000-4000-8000-000000000040', 'f9860000-0000-4000-8000-000000000031', 'percentage', 40),
  ('f9860000-0000-4000-8000-000000000040', 'f9860000-0000-4000-8000-000000000032', 'percentage', 40);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'f9860000-0000-4000-8000-000000000020', d, false, '08:00', '22:00' from generate_series(0, 6) d;

-- 管理員建單(主要服務人員 P,可帶協助人員)。
create function pg_temp.mk(p_item uuid, p_materials uuid[], p_start timestamptz, p_assistants uuid[] default '{}')
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f9860000-0000-4000-8000-000000000020',
    p_staff_id => 'f9860000-0000-4000-8000-000000000040',
    p_service_items => (
      select jsonb_agg(jsonb_build_object('service_item_id', si.id, 'quantity', 1, 'unit_price', si.price))
      from public.service_items si where si.id = p_item
    ),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955986000',
    p_customer_address => '台北市測試路 86 號',
    p_assistant_staff_ids => p_assistants,
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end,
    p_payment_method_id => 'f9860000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, uuid[], timestamptz, uuid[]) to authenticated;

-- 服務人員本人建單(帶 / 不帶料錢)。
create function pg_temp.smk(p_staff uuid, p_start timestamptz, p_materials uuid[])
returns uuid language sql as $$
  select (public.staff_create_booking(
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9860000-0000-4000-8000-000000000032','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '自建客人',
    p_customer_phone => '0955986011',
    p_customer_address => '新北市自建路 1 號',
    p_payment_method_id => 'f9860000-0000-4000-8000-000000000050',
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end
  ) ->> 'id')::uuid;
$$;
grant execute on function pg_temp.smk(uuid, timestamptz, uuid[]) to authenticated;

-- 舊前端:完全不帶料錢參數。
create function pg_temp.smk_old(p_staff uuid, p_start timestamptz)
returns uuid language sql as $$
  select (public.staff_create_booking(
    p_staff_id => p_staff,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9860000-0000-4000-8000-000000000032','quantity',1,'unit_price',800)),
    p_start_at => p_start,
    p_customer_name => '自建客人',
    p_customer_phone => '0955986011',
    p_customer_address => '新北市自建路 1 號',
    p_payment_method_id => 'f9860000-0000-4000-8000-000000000050'
  ) ->> 'id')::uuid;
$$;
grant execute on function pg_temp.smk_old(uuid, timestamptz) to authenticated;

-- 服務人員本人改單(服務項目固定 S1、時間由呼叫端給;p_materials = null ⇒ 不帶料錢)。
create function pg_temp.sup(p_booking uuid, p_start timestamptz, p_materials uuid[])
returns jsonb language sql as $$
  select public.staff_update_booking(
    p_booking_id => p_booking,
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9860000-0000-4000-8000-000000000031','quantity',1,'unit_price',3000)),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955986000',
    p_customer_address => '台北市測試路 86 號',
    p_payment_method_id => 'f9860000-0000-4000-8000-000000000050',
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end
  );
$$;
grant execute on function pg_temp.sup(uuid, timestamptz, uuid[]) to authenticated;

-- 客服改單(update_booking,同樣內容)。
create function pg_temp.aup(p_booking uuid, p_start timestamptz, p_materials uuid[])
returns uuid language sql as $$
  select id from public.update_booking(
    p_booking_id => p_booking,
    p_staff_id => 'f9860000-0000-4000-8000-000000000040',
    p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','f9860000-0000-4000-8000-000000000031','quantity',1,'unit_price',3000)),
    p_start_at => p_start,
    p_customer_name => '林小姐',
    p_customer_phone => '0955986000',
    p_customer_address => '台北市測試路 86 號',
    p_material_cost_items => case when p_materials is null then null else (select coalesce(jsonb_agg(jsonb_build_object('material_cost_item_id', x, 'quantity', 1) order by o), '[]'::jsonb) from unnest(p_materials) with ordinality as u(x, o)) end,
    p_payment_method_id => 'f9860000-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.aup(uuid, timestamptz, uuid[]) to authenticated;

create function pg_temp.mats(p_booking uuid)
returns text language sql as $$
  select coalesce(string_agg(mci.name || ':' || bmc.amount_snapshot::text, ',' order by mci.name), '')
  from public.booking_material_costs bmc join public.material_cost_items mci on mci.id = bmc.material_cost_item_id
  where bmc.booking_id = p_booking;
$$;

create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;
grant execute on function pg_temp.done(uuid) to authenticated;

-- =========================================================================
-- ⑩~⑮ staff_get_booking_form_options
-- =========================================================================
update service_items set description = '含清洗與檢查' where id = 'f9860000-0000-4000-8000-000000000032';

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
create temp table r986a_opt on commit drop as
  select public.staff_get_booking_form_options('f9860000-0000-4000-8000-000000000040') as o;
select pg_temp.test_clear_auth();

select is(
  (select (o ->> 'material_cost_enabled') || '/' || (select string_agg(e ->> 'name' || '=' || (e ->> 'amount'), ',' order by e ->> 'name')
                                                    from jsonb_array_elements(o -> 'material_cost_items') e)
   from r986a_opt),
  'true/M_old=120.00,M500=500.00,M600=600.00',
  '⑩ 總開關開 ⇒ 回本店上架料錢品項(不含已下架 M_off、不含別家 MB)'
);
select is(
  (select array_agg(k order by k) from r986a_opt, jsonb_object_keys(o) k),
  array['business_hours','industry_type','material_cost_enabled','material_cost_items','payment_methods','service_categories','service_items','staff_id','staff_name','start_time_interval_minutes','tax_settings'],
  '⑪ key 清單:多了 material_cost_enabled、material_cost_items、start_time_interval_minutes,沒有客戶 / 會員 / 其他服務人員'
);
select is((select (o ->> 'start_time_interval_minutes')::int from r986a_opt), 30, '⑫ 查無建單時間間隔設定 ⇒ 30');
select is(
  (select string_agg(coalesce(e ->> 'name', '') || '=' || coalesce(e ->> 'description', '(null)'), ',' order by e ->> 'name')
   from r986a_opt, jsonb_array_elements(o -> 'service_items') e),
  'S1=(null),S2=含清洗與檢查',
  '⑬ 服務項目每筆多 description(沒填 = null)'
);

insert into merchant_booking_settings (merchant_id, start_time_interval_minutes) values ('f9860000-0000-4000-8000-000000000020', 10);
update merchant_feature_flags set enabled = false
where merchant_id = 'f9860000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
create temp table r986a_opt2 on commit drop as
  select public.staff_get_booking_form_options('f9860000-0000-4000-8000-000000000040') as o;
select pg_temp.test_clear_auth();
select is((select (o ->> 'start_time_interval_minutes')::int from r986a_opt2), 10, '⑭ 有設定建單時間間隔 10 ⇒ 回 10');
select is(
  (select (o ->> 'material_cost_enabled') || '/' || (o -> 'material_cost_items')::text from r986a_opt2),
  'false/[]',
  '⑮ 總開關關 ⇒ material_cost_enabled = false、品項 []'
);

-- =========================================================================
-- ⑯~㉑ staff_create_booking 帶料錢(此時總開關關)
-- =========================================================================
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
select throws_ok(
  $$select pg_temp.smk('f9860000-0000-4000-8000-000000000040', '2036-08-07 09:00+08', array['f9860000-0000-4000-8000-000000000060'::uuid])$$,
  'P0001', '這間商家尚未開啟料錢成本功能，無法選用料錢成本品項', '⑯ 總開關關時帶品項 ⇒ 擋(錯誤訊息同客服)'
);
select pg_temp.test_clear_auth();
update merchant_feature_flags set enabled = true
where merchant_id = 'f9860000-0000-4000-8000-000000000020' and feature_key = 'material_cost_enabled';

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
select pg_temp.smk('f9860000-0000-4000-8000-000000000040', '2036-08-01 09:00+08', array['f9860000-0000-4000-8000-000000000060'::uuid]) as id \gset s1_
select throws_ok(
  $$select pg_temp.smk('f9860000-0000-4000-8000-000000000040', '2036-08-01 11:00+08', array['f9860000-0000-4000-8000-000000000065'::uuid])$$,
  'P0001', '找不到其中一個料錢成本品項，或已下架', '⑰ 帶別家商家的品項 ⇒ 擋'
);
select throws_ok(
  $$select pg_temp.smk('f9860000-0000-4000-8000-000000000040', '2036-08-07 13:00+08', array['f9860000-0000-4000-8000-000000000064'::uuid])$$,
  'P0001', '找不到其中一個料錢成本品項，或已下架', '⑱ 帶已下架品項 ⇒ 擋'
);
select pg_temp.smk('f9860000-0000-4000-8000-000000000040', '2036-08-01 13:00+08', null) as id \gset s2_
select pg_temp.smk_old('f9860000-0000-4000-8000-000000000040', '2036-08-01 15:00+08') as id \gset s3_
select pg_temp.test_clear_auth();

select is(pg_temp.mats(:'s1_id'::uuid), 'M500:500.00', '⑲ 服務人員建單帶上架品項 ⇒ booking_material_costs 有對應列、金額快照 = 品項金額');
select is(pg_temp.mats(:'s2_id'::uuid), '', '⑳ 帶 null ⇒ 0 筆料錢');
select is(pg_temp.mats(:'s3_id'::uuid), '', '㉑ 舊前端完全不帶料錢參數 ⇒ 0 筆料錢(跟第 7 批一樣)');

-- =========================================================================
-- ㉒~㉖ staff_update_booking 帶料錢
-- =========================================================================
-- u1:管理員建單,帶 M500 + M_old;之後 M_old 改價 999 並下架。
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000001');
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', array['f9860000-0000-4000-8000-000000000060'::uuid, 'f9860000-0000-4000-8000-000000000062'::uuid], '2036-08-02 09:00+08') as id \gset u1_
select pg_temp.test_clear_auth();
update material_cost_items set status = 'removed', amount = 999 where id = 'f9860000-0000-4000-8000-000000000062';

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
select pg_temp.sup(:'u1_id'::uuid, '2036-08-02 09:00+08', null);
select pg_temp.test_clear_auth();
select is(pg_temp.mats(:'u1_id'::uuid), 'M_old:120.00,M500:500.00', '㉒ 傳 null ⇒ 料錢不變(含已下架的 M_old 與原快照)');

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
select pg_temp.sup(:'u1_id'::uuid, '2036-08-02 09:00+08',
  array['f9860000-0000-4000-8000-000000000062'::uuid, 'f9860000-0000-4000-8000-000000000061'::uuid]);
select pg_temp.test_clear_auth();
select is(pg_temp.mats(:'u1_id'::uuid), 'M_old:120.00,M600:600.00',
  '㉓ 拿掉 M500、加上架的 M600、保留已下架的 M_old ⇒ 不擋;M_old 快照仍是 120(不吃改價後的 999)');

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
select throws_ok(
  format($$select pg_temp.sup(%L, '2036-08-02 09:00+08', array['f9860000-0000-4000-8000-000000000062'::uuid, 'f9860000-0000-4000-8000-000000000064'::uuid])$$, :'u1_id'),
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㉔ 新加已下架品項 ⇒ 擋'
);
select throws_ok(
  format($$select pg_temp.sup(%L, '2036-08-02 09:00+08', array['f9860000-0000-4000-8000-000000000065'::uuid])$$, :'u1_id'),
  'P0001', '找不到其中一個料錢成本品項，或已下架', '㉕ 新加別家商家的品項 ⇒ 擋'
);
select pg_temp.sup(:'u1_id'::uuid, '2036-08-02 09:00+08', '{}'::uuid[]);
select pg_temp.test_clear_auth();
select is(pg_temp.mats(:'u1_id'::uuid), '', '㉖ 傳 {} ⇒ 料錢全部拿掉');

-- =========================================================================
-- ㉗~㉙ 協助人員 / 別人的單 / 開關關的服務人員
-- =========================================================================
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000001');
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', '{}'::uuid[], '2036-08-03 09:00+08',
  array['f9860000-0000-4000-8000-000000000042'::uuid]) as id \gset as_
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000008');
select throws_ok(
  format($$select pg_temp.sup(%L, '2036-08-03 09:00+08', array['f9860000-0000-4000-8000-000000000060'::uuid])$$, :'as_id'),
  '42501', NULL, '㉗ 協助人員帶料錢改別人當主要的單 ⇒ 42501'
);
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000007');
select throws_ok(
  format($$select pg_temp.sup(%L, '2036-08-03 09:00+08', array['f9860000-0000-4000-8000-000000000060'::uuid])$$, :'as_id'),
  '42501', NULL, '㉘ 不相干的服務人員改別人的單 ⇒ 42501'
);
select throws_ok(
  $$select pg_temp.smk('f9860000-0000-4000-8000-000000000041', '2036-08-03 13:00+08', array['f9860000-0000-4000-8000-000000000060'::uuid])$$,
  '42501', '沒有權限新增預約', '㉙ 沒開「新增編輯訂單」的服務人員帶料錢建單 ⇒ 擋'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ㉚~㉛ staff_get_booking_for_edit
-- =========================================================================
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000001');
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', array['f9860000-0000-4000-8000-000000000060'::uuid], '2036-08-04 09:00+08') as id \gset ed_
select pg_temp.test_clear_auth();
-- 直接補一筆已下架品項的料錢列(模擬「建單時還上架、之後下架」)。
insert into booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
values (:'ed_id'::uuid, 'f9860000-0000-4000-8000-000000000062', 120);
update bookings set hide_notes_from_staff = true, notes = '只給客服看的備註' where id = :'ed_id'::uuid;

select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
create temp table r986a_ed on commit drop as
  select public.staff_get_booking_for_edit(:'ed_id'::uuid) as r;
select pg_temp.test_clear_auth();
select is(
  (select string_agg((e ->> 'name') || ':' || (e ->> 'amount_snapshot') || ':' || (e ->> 'is_active')
                     || ':' || ((e ->> 'material_cost_item_id') is not null)::text, ',' order by e ->> 'name')
   from r986a_ed, jsonb_array_elements(r -> 'material_costs') e),
  'M_old:120.00:false:true,M500:500.00:true:true',
  '㉚ material_costs 回這張單的料錢(品項 id、目前名稱、快照金額),已下架品項 is_active = false'
);
select is(
  (select coalesce(r ->> 'notes', '(null)') || '/' || (r ->> 'notes_hidden') from r986a_ed),
  '(null)/true',
  '㉛ hide_notes_from_staff 仍不回備註原文'
);

-- =========================================================================
-- ㉜~㉝ 抽成:服務人員改料錢 vs 客服改料錢,第 8 批開關開 / 關
-- =========================================================================
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000001');
select public.set_material_cost_affects_commission('f9860000-0000-4000-8000-000000000020', true);
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', array['f9860000-0000-4000-8000-000000000060'::uuid], '2036-08-05 09:00+08') as id \gset cs1_
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', array['f9860000-0000-4000-8000-000000000060'::uuid], '2036-08-05 11:00+08') as id \gset ca1_
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', array['f9860000-0000-4000-8000-000000000060'::uuid], '2036-08-06 09:00+08') as id \gset cs2_
select pg_temp.mk('f9860000-0000-4000-8000-000000000031', array['f9860000-0000-4000-8000-000000000060'::uuid], '2036-08-06 11:00+08') as id \gset ca2_
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000005');
select pg_temp.sup(:'cs1_id'::uuid, '2036-08-05 09:00+08', array['f9860000-0000-4000-8000-000000000061'::uuid]);
select pg_temp.sup(:'cs2_id'::uuid, '2036-08-06 09:00+08', array['f9860000-0000-4000-8000-000000000061'::uuid]);
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000002');
select pg_temp.aup(:'ca1_id'::uuid, '2036-08-05 11:00+08', array['f9860000-0000-4000-8000-000000000061'::uuid]);
select pg_temp.aup(:'ca2_id'::uuid, '2036-08-06 11:00+08', array['f9860000-0000-4000-8000-000000000061'::uuid]);
select pg_temp.test_set_auth('f9860000-0000-4000-8000-000000000001');
select pg_temp.done(:'cs1_id'::uuid);
select pg_temp.done(:'ca1_id'::uuid);
select public.set_material_cost_affects_commission('f9860000-0000-4000-8000-000000000020', false);
select pg_temp.done(:'cs2_id'::uuid);
select pg_temp.done(:'ca2_id'::uuid);
select pg_temp.test_clear_auth();

select is(
  (select string_agg(commission_amount::text || '/' || material_cost_deducted_snapshot::text, ' '
                     order by case booking_id when :'cs1_id'::uuid then 1 else 2 end)
   from booking_commission_records where booking_id in (:'cs1_id'::uuid, :'ca1_id'::uuid)),
  '960.00/600.00 960.00/600.00',
  '㉜ 開關開:服務人員改成 M600 的單 = 客服改成 M600 的單,抽成 (3000-600)×40% = 960'
);
select is(
  (select string_agg(commission_amount::text || '/' || material_cost_deducted_snapshot::text, ' '
                     order by case booking_id when :'cs2_id'::uuid then 1 else 2 end)
   from booking_commission_records where booking_id in (:'cs2_id'::uuid, :'ca2_id'::uuid)),
  '1200.00/0.00 1200.00/0.00',
  '㉝ 開關關:兩張單抽成都是 3000×40% = 1200(不扣料錢)'
);

select * from finish();
rollback;
