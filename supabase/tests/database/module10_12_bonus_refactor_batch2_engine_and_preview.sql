-- 紅利系統重構 批次 2(規格書 .project/specs/紅利系統重構.md §八 批次 2)。
-- 對應 migration:20261001030000_bonus_refactor_batch2_engine_and_preview.sql
--
-- 這一檔鎖住的行為:
--   A. 權限衛生:內部函式三個角色都沒有 EXECUTE;預覽只給 authenticated
--   B. §2.2 基本模式(門檻剛好等於 / 差 1 元 / 累計 2.9 倍取 2 / 門檻 0 / 尚未設定)
--   C. §2.3 進階模式(個別優先不相加、門檻大於等於、停用退回「全部」、下架項目、別家項目、加總)
--      + §2.1 模式互斥
--   D. §2.7 五種核發資格模式(建單當下判斷)
--   E. §2.6 開關 2/3 + 第 14 題(推薦者/被推薦者/兩者皆是)
--   F. §2.10 折抵換算與上限(純函式)
--   G. §3.2 末段 resolve_booking_member_by_phone(完全相等、正規化、下架不算、跨商家不算)
--   H. §3.2 預覽:權限 / IDOR 三條 / resolution 六種 / 功能關閉只回一個鍵 / 編輯模式含本單凍結 /
--      結構完整 / 錯誤不噴 500 / 唯讀 / 預覽 = 實際建單路徑(既有會員、新客戶、line_bound 新客戶)
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

select plan(110);

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

-- 一個服務項目的 jsonb 元素。
create function pg_temp.it(p_id text, p_qty int, p_price numeric)
returns jsonb language sql as $$
  select jsonb_build_object('service_item_id', p_id, 'quantity', p_qty, 'unit_price', p_price);
$$;

-- 直接呼叫引擎(以 postgres 身分;引擎只准內部呼叫)。
create function pg_temp.eng(p_member uuid, p_items jsonb, p_payable numeric,
                            p_custom boolean default false, p_discount boolean default false,
                            p_assume_new boolean default false)
returns record language sql as $$
  select auto_points, review_required, eligible, ineligible_reason, breakdown
  from private.compute_booking_planned_points(
    'db120000-0000-4000-8000-000000000021', p_member, p_items, p_payable, p_custom, p_discount, p_assume_new);
$$;

create function pg_temp.eng_points(p_member uuid, p_items jsonb, p_payable numeric, p_assume_new boolean default false)
returns int language sql as $$
  select auto_points from private.compute_booking_planned_points(
    'db120000-0000-4000-8000-000000000021', p_member, p_items, p_payable, false, false, p_assume_new);
$$;

create function pg_temp.eng_reason(p_member uuid, p_assume_new boolean default false)
returns text language sql as $$
  select coalesce(ineligible_reason, 'ok') from private.compute_booking_planned_points(
    'db120000-0000-4000-8000-000000000021', p_member,
    jsonb_build_array(jsonb_build_object('service_item_id','db120000-0000-4000-8000-000000000032','quantity',1,'unit_price',1000)),
    1000, false, false, p_assume_new);
$$;

-- 新增模式預覽(A 店、無折扣稅金)。
create function pg_temp.pv_new(p_phone text, p_items jsonb)
returns jsonb language sql as $$
  select public.preview_booking_points(
    'db120000-0000-4000-8000-000000000021', null, null, p_phone, p_items,
    false, null, false, null, null, false, null, null);
$$;

-- 編輯模式預覽。
create function pg_temp.pv_edit(p_booking uuid, p_member uuid, p_items jsonb)
returns jsonb language sql as $$
  select public.preview_booking_points(
    'db120000-0000-4000-8000-000000000021', p_booking, p_member, '0912000101', p_items,
    false, null, false, null, null, false, null, null);
$$;

-- 唯讀斷言用的資料指紋(members / member_point_transactions / bookings / booking_service_items)。
create function pg_temp.data_fingerprint()
returns text language sql as $$
  select md5(
    coalesce((select string_agg(m::text, '|' order by m.id) from members m), '') ||
    coalesce((select string_agg(t::text, '|' order by t.id) from member_point_transactions t), '') ||
    coalesce((select string_agg(b::text, '|' order by b.id) from bookings b), '') ||
    coalesce((select string_agg(s::text, '|' order by s.id) from booking_service_items s), '')
  );
$$;

-- =========================================================================
-- Fixture:A 店(主場)、B 店(不同集團,IDOR 對照)
-- =========================================================================
insert into auth.users (id, email) values
  ('db120000-0000-4000-8000-000000000001', 'pgtap-m1012-admin-a@test.local'),
  ('db120000-0000-4000-8000-000000000002', 'pgtap-m1012-admin-b@test.local'),
  ('db120000-0000-4000-8000-000000000003', 'pgtap-m1012-agent-orders@test.local'),
  ('db120000-0000-4000-8000-000000000004', 'pgtap-m1012-agent-members@test.local');

insert into groups (id) values
  ('db120000-0000-4000-8000-000000000011'),
  ('db120000-0000-4000-8000-000000000012');

insert into merchants (id, group_id, name, industry_type) values
  ('db120000-0000-4000-8000-000000000021', 'db120000-0000-4000-8000-000000000011', '紅利批次2測試A店', 'in_store_beauty'),
  ('db120000-0000-4000-8000-000000000022', 'db120000-0000-4000-8000-000000000012', '紅利批次2測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('db120000-0000-4000-8000-000000000021', 'db120000-0000-4000-8000-000000000001'),
  ('db120000-0000-4000-8000-000000000022', 'db120000-0000-4000-8000-000000000002');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('db120000-0000-4000-8000-000000000051', 'db120000-0000-4000-8000-000000000021',
   'db120000-0000-4000-8000-000000000003', '客服O(只有訂單)', '0900001201',
   'pgtap-m1012-agent-orders@test.local', 'active'),
  ('db120000-0000-4000-8000-000000000052', 'db120000-0000-4000-8000-000000000021',
   'db120000-0000-4000-8000-000000000004', '客服M(只有會員)', '0900001202',
   'pgtap-m1012-agent-members@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('db120000-0000-4000-8000-000000000051', 'orders', true),
  ('db120000-0000-4000-8000-000000000052', 'members', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select m, d, false, '00:00', '23:59'
from generate_series(0, 6) as d,
     unnest(array['db120000-0000-4000-8000-000000000021', 'db120000-0000-4000-8000-000000000022']::uuid[]) as m;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('db120000-0000-4000-8000-000000000031', 'db120000-0000-4000-8000-000000000021', '冷氣安裝', 2000, 'primary', 30, 'active'),
  ('db120000-0000-4000-8000-000000000032', 'db120000-0000-4000-8000-000000000021', '清洗', 1000, 'primary', 30, 'active'),
  ('db120000-0000-4000-8000-000000000033', 'db120000-0000-4000-8000-000000000021', '已下架舊項目', 500, 'primary', 30, 'removed'),
  ('db120000-0000-4000-8000-000000000034', 'db120000-0000-4000-8000-000000000022', 'B店項目', 1000, 'primary', 30, 'active');

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('db120000-0000-4000-8000-000000000041', 'db120000-0000-4000-8000-000000000021', '服務人員A', '0901001201', true),
  ('db120000-0000-4000-8000-000000000042', 'db120000-0000-4000-8000-000000000022', '服務人員B', '0901001202', true);

insert into payment_methods (id, merchant_id, name) values
  ('db120000-0000-4000-8000-000000000071', 'db120000-0000-4000-8000-000000000021', '現場付款'),
  ('db120000-0000-4000-8000-000000000072', 'db120000-0000-4000-8000-000000000022', '現場付款');

-- A 店紅利設定:基本模式、每筆 10 點、最低 500、100 點 = 10 元、最多 50%。
insert into merchant_member_settings (merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
                                      redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent)
values ('db120000-0000-4000-8000-000000000021', 'basic', 10, 500, 100, 10, 50);

-- 會員(A 店)。
insert into members (id, merchant_id, name, phone, referral_code, points_balance, phone_verified, phone_verified_at,
                     line_bound, line_user_id, referred_by_member_id, status) values
  ('db120000-0000-4000-8000-000000000061', 'db120000-0000-4000-8000-000000000021', '一般會員', '0912000101', 'M1012A01', 500, false, null, false, null, null, 'active'),
  ('db120000-0000-4000-8000-000000000062', 'db120000-0000-4000-8000-000000000021', '推薦者', '0912000102', 'M1012A02', 0, false, null, false, null, null, 'active'),
  ('db120000-0000-4000-8000-000000000065', 'db120000-0000-4000-8000-000000000021', '電話已驗證', '0912000105', 'M1012A05', 0, true, now(), false, null, null, 'active'),
  ('db120000-0000-4000-8000-000000000066', 'db120000-0000-4000-8000-000000000021', 'LINE已綁定', '0912000106', 'M1012A06', 0, false, null, true, 'Upgtap1012line06', null, 'active'),
  ('db120000-0000-4000-8000-000000000067', 'db120000-0000-4000-8000-000000000021', '兩者皆是', '0912000107', 'M1012A07', 0, true, now(), true, 'Upgtap1012line07', null, 'active'),
  ('db120000-0000-4000-8000-000000000069', 'db120000-0000-4000-8000-000000000021', '已下架會員', '0912000109', 'M1012A09', 300, false, null, false, null, null, 'removed');
insert into members (id, merchant_id, name, phone, referral_code, referred_by_member_id) values
  ('db120000-0000-4000-8000-000000000063', 'db120000-0000-4000-8000-000000000021', '被推薦者', '0912000103', 'M1012A03', 'db120000-0000-4000-8000-000000000062'),
  ('db120000-0000-4000-8000-000000000064', 'db120000-0000-4000-8000-000000000021', '既推薦又被推薦', '0912000104', 'M1012A04', 'db120000-0000-4000-8000-000000000062');
insert into members (id, merchant_id, name, phone, referral_code, referred_by_member_id) values
  ('db120000-0000-4000-8000-000000000068', 'db120000-0000-4000-8000-000000000021', '被「既推薦又被推薦」推薦', '0912000108', 'M1012A08', 'db120000-0000-4000-8000-000000000064');
-- B 店:同一支電話的會員(跨商家不得對到)。
insert into members (id, merchant_id, name, phone, referral_code, points_balance) values
  ('db120000-0000-4000-8000-000000000081', 'db120000-0000-4000-8000-000000000022', 'B店同號會員', '0912000101', 'M1012B01', 9999);

-- =========================================================================
-- A. 權限衛生(supabase-permission-hygiene 規則 1)
-- =========================================================================
select ok(
  not has_function_privilege('authenticated', 'private.compute_booking_planned_points(uuid, uuid, jsonb, numeric, boolean, boolean, boolean)', 'execute')
  and not has_function_privilege('anon', 'private.compute_booking_planned_points(uuid, uuid, jsonb, numeric, boolean, boolean, boolean)', 'execute')
  and not has_function_privilege('public', 'private.compute_booking_planned_points(uuid, uuid, jsonb, numeric, boolean, boolean, boolean)', 'execute'),
  'A1 §3.1:計算引擎 authenticated / anon / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'private.resolve_booking_member_by_phone(uuid, text)', 'execute')
  and not has_function_privilege('anon', 'private.resolve_booking_member_by_phone(uuid, text)', 'execute')
  and not has_function_privilege('public', 'private.resolve_booking_member_by_phone(uuid, text)', 'execute'),
  'A2 §3.2:resolve_booking_member_by_phone authenticated / anon / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not has_function_privilege('authenticated', 'private.compute_booking_redeem_limits(integer, numeric, integer, numeric, integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.redeem_points_to_amount(integer, integer, numeric)', 'execute')
  and not has_function_privilege('authenticated', 'private.merchant_member_settings_effective(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.compute_booking_redeem_limits(integer, numeric, integer, numeric, integer)', 'execute')
  and not has_function_privilege('anon', 'private.redeem_points_to_amount(integer, integer, numeric)', 'execute')
  and not has_function_privilege('anon', 'private.merchant_member_settings_effective(uuid)', 'execute')
  and not has_function_privilege('public', 'private.compute_booking_redeem_limits(integer, numeric, integer, numeric, integer)', 'execute')
  and not has_function_privilege('public', 'private.redeem_points_to_amount(integer, integer, numeric)', 'execute')
  and not has_function_privilege('public', 'private.merchant_member_settings_effective(uuid)', 'execute'),
  'A3:折抵兩支純函式與設定讀取 helper,三個角色都沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute'),
  'A4 §3.2:preview_booking_points 對 authenticated 開放(正向對照)'
);
select ok(
  not has_function_privilege('anon', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute')
  and not has_function_privilege('public', 'public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric)', 'execute'),
  'A5 §3.2:preview_booking_points anon / PUBLIC 沒有 EXECUTE'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'preview_booking_points'),
  1,
  'A6:preview_booking_points 只有 1 個版本'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'preview_booking_loyalty_points'),
  0,
  'A7 §〇.4 判斷 17:#917 的 preview_booking_loyalty_points 不存在(由 preview_booking_points 取代)'
);
select ok(
  (select p.prosecdef and p.provolatile = 's' and array_to_string(p.proconfig, ',') like '%search_path=public%'
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'preview_booking_points'),
  'A8:preview_booking_points 是 SECURITY DEFINER + STABLE + 固定 search_path'
);

-- =========================================================================
-- B. §2.2 基本模式
-- =========================================================================
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 500), 10,
  'B1 §2.2:應付金額剛好等於最低消費 500 ⇒ 10 點');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 499), 0,
  'B2 §2.2:差 1 元(499)⇒ 0 點');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 499.99), 0,
  'B3 §2.2:499.99 也不到門檻 ⇒ 0 點');

update merchant_member_settings set basic_tiered_enabled = true
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 1450), 20,
  'B4 §2.2:每滿額累計,1450 / 500 = 2.9 倍取 2 ⇒ 20 點');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 499), 0,
  'B5 §2.2:每滿額累計,未滿一次 ⇒ 0 點');

update merchant_member_settings set basic_tiered_enabled = false, basic_min_amount = 0
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 0), 10,
  'B6 §2.2:門檻 0 = 每筆都給,連 0 元訂單也給 10 點');

update merchant_member_settings set basic_points_per_order = 0
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select results_eq(
  $$select auto_points, eligible, ineligible_reason from pg_temp.eng('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 5000)
      as t(auto_points int, review_required bool, eligible bool, ineligible_reason text, breakdown jsonb)$$,
  $$values (0, true, null::text)$$,
  'B7 §2.2:每筆點數 0 = 尚未設定 ⇒ 0 點,但會員本身仍 eligible(不是資格問題)'
);
update merchant_member_settings set basic_points_per_order = 10, basic_min_amount = 500
where merchant_id = 'db120000-0000-4000-8000-000000000021';

select is(
  (select breakdown -> 0 ->> 'mode' || '/' || (breakdown -> 0 ->> 'points')
   from pg_temp.eng('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 800)
     as t(auto_points int, review_required bool, eligible bool, ineligible_reason text, breakdown jsonb)),
  'basic/10',
  'B8 §3.1:基本模式的 breakdown 標註 mode=basic 與點數'
);

-- review_required(§2.5 第 1 點)
select is(
  (select array[
     (select review_required from pg_temp.eng('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 800, false, false) as t(a int, review_required bool, c bool, d text, e jsonb)),
     (select review_required from pg_temp.eng('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 800, true, false) as t(a int, review_required bool, c bool, d text, e jsonb)),
     (select review_required from pg_temp.eng('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 800, false, true) as t(a int, review_required bool, c bool, d text, e jsonb)),
     (select review_required from pg_temp.eng(null, '[]'::jsonb, 800, false, true) as t(a int, review_required bool, c bool, d text, e jsonb))
   ]),
  array[false, true, true, true],
  'B9 §2.5:review_required = 自訂總金額 or 折扣;沒有會員時也照實回報'
);

-- =========================================================================
-- C. §2.3 進階模式 + §2.1 模式互斥
-- =========================================================================
update merchant_member_settings set earn_mode = 'advanced'
where merchant_id = 'db120000-0000-4000-8000-000000000021';

select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)), 1000), 0,
  'C1 §2.1:進階模式、沒有任何公式 ⇒ 0 點,絕不退回基本模式補算(基本設定仍是每筆 10 點)');

insert into merchant_point_formulas (id, merchant_id, name, enabled, service_item_id, min_unit_price, points_per_unit, sort_order) values
  ('db120000-0000-4000-8000-0000000000a1', 'db120000-0000-4000-8000-000000000021', '全部服務項目', true, null, 0, 1, 1),
  ('db120000-0000-4000-8000-0000000000a2', 'db120000-0000-4000-8000-000000000021', '冷氣安裝公式', true, 'db120000-0000-4000-8000-000000000031', 2000, 5, 2),
  ('db120000-0000-4000-8000-0000000000a3', 'db120000-0000-4000-8000-000000000021', '舊項目公式', true, 'db120000-0000-4000-8000-000000000033', 0, 7, 3);

select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 1, 2000),
                    pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)), 3000), 6,
  'C2 §2.3 第 2 題定案範例:冷氣安裝吃自己的 5 點 + 清洗吃「全部」1 點 = 6 點(個別優先,不相加)');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 5, 2000)), 10000), 25,
  'C3 §2.3:單價剛好等於門檻 2000 ⇒ 每件 5 點 × 5 = 25 點(大於等於)');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 5, 1999)), 9995), 0,
  'C4 §2.3:單價 1999 未達門檻 ⇒ 0 點(不會退回「全部服務項目」那條)');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000033', 2, 500)), 1000), 14,
  'C5 §2.3:已下架的服務項目在舊單編輯時仍照公式算(7 × 2 = 14)');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000034', 3, 1000)), 3000), 0,
  'C6 資安:別家商家的服務項目不會吃到任何公式(連「全部服務項目」都不會)');
select is(
  (select breakdown -> 0 ->> 'name'
   from pg_temp.eng('db120000-0000-4000-8000-000000000061',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000034', 3, 1000)), 3000)
     as t(a int, b bool, c bool, d text, breakdown jsonb)),
  null,
  'C7 資安:別家商家的服務項目,breakdown 不回傳它的名稱'
);

update merchant_point_formulas set enabled = false where id = 'db120000-0000-4000-8000-0000000000a2';
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 2, 2000)), 4000), 2,
  'C8 §2.3:個別公式被停用 ⇒ 退回吃「全部服務項目」(1 × 2 = 2)');
update merchant_point_formulas set enabled = false where id = 'db120000-0000-4000-8000-0000000000a1';
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 2, 2000)), 4000), 0,
  'C9 §2.3:個別與「全部」都停用 ⇒ 0 點(停用的公式不生效)');
update merchant_point_formulas set enabled = true where id in ('db120000-0000-4000-8000-0000000000a1', 'db120000-0000-4000-8000-0000000000a2');

select is(
  (select jsonb_build_object('n', jsonb_array_length(breakdown),
                             'f0', breakdown -> 0 ->> 'formula_name', 'p0', (breakdown -> 0 ->> 'points')::int,
                             'f1', breakdown -> 1 ->> 'formula_name', 'p1', (breakdown -> 1 ->> 'points')::int,
                             'name0', breakdown -> 0 ->> 'name', 'th0', (breakdown -> 0 ->> 'threshold')::numeric)
   from pg_temp.eng('db120000-0000-4000-8000-000000000061',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 1, 2000),
                       pg_temp.it('db120000-0000-4000-8000-000000000032', 3, 1000)), 5000)
     as t(a int, b bool, c bool, d text, breakdown jsonb)),
  jsonb_build_object('n', 2, 'f0', '冷氣安裝公式', 'p0', 5, 'f1', '全部服務項目', 'p1', 3,
                     'name0', '冷氣安裝', 'th0', 2000),
  'C10 §3.1:進階模式 breakdown 逐項列出命中的公式、門檻、點數,多項目加總'
);
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 1, 2000),
                    pg_temp.it('db120000-0000-4000-8000-000000000032', 3, 1000)), 5000), 8,
  'C11 §2.3:多個項目各自命中 ⇒ 加總(5 + 3 = 8)');

update merchant_member_settings set earn_mode = 'basic'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000061',
  jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 1, 2000),
                    pg_temp.it('db120000-0000-4000-8000-000000000032', 3, 1000)), 5000), 10,
  'C12 §2.1:同一張訂單切回基本模式 ⇒ 只看基本設定(10 點),公式完全不參與');

-- =========================================================================
-- D. §2.7 五種核發資格模式(建單當下判斷)
--    61 一般(都沒有)/ 65 電話已驗證 / 66 LINE 已綁定 / 67 兩者皆是
-- =========================================================================
select is(pg_temp.eng_reason('db120000-0000-4000-8000-000000000061'), 'ok',
  'D1 §2.7 none:一般會員 ⇒ 符合');

update merchant_member_settings set reward_condition_mode = 'phone_verified'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000065'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000066')],
  array['ok', 'reward_condition'],
  'D2 §2.7 phone_verified:電話已驗證 ⇒ 符合;只有 LINE ⇒ reward_condition');

update merchant_member_settings set reward_condition_mode = 'line_bound'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000066'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000065')],
  array['ok', 'reward_condition'],
  'D3 §2.7 line_bound:LINE 已綁定 ⇒ 符合;只有電話驗證 ⇒ reward_condition');
select results_eq(
  $$select auto_points, eligible, ineligible_reason from pg_temp.eng('db120000-0000-4000-8000-000000000065', '[]'::jsonb, 5000)
      as t(auto_points int, review_required bool, eligible bool, ineligible_reason text, breakdown jsonb)$$,
  $$values (0, false, 'reward_condition'::text)$$,
  'D4 §2.7:資格不符 ⇒ auto = 0、eligible = false、原因代碼 reward_condition'
);
select is(pg_temp.eng_reason(null, true), 'reward_condition',
  'D5 §2.7 / §3.1:line_bound 模式下「全新會員」(未驗證、未綁 LINE)⇒ reward_condition');

update merchant_member_settings set reward_condition_mode = 'either'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000066'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000065'),
                pg_temp.eng_reason('db120000-0000-4000-8000-000000000061')],
  array['ok', 'ok', 'reward_condition'],
  'D6 §2.7 either:LINE 或電話任一 ⇒ 符合;兩者皆無 ⇒ reward_condition');

update merchant_member_settings set reward_condition_mode = 'both'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000067'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000065'),
                pg_temp.eng_reason('db120000-0000-4000-8000-000000000066')],
  array['ok', 'reward_condition', 'reward_condition'],
  'D7 §2.7 both:兩者皆是 ⇒ 符合;只有其中一項 ⇒ reward_condition');

update merchant_member_settings set reward_condition_mode = 'none'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(pg_temp.eng_points(null, '[]'::jsonb, 800, true), 10,
  'D8 §3.1:none 模式下「全新會員」照樣派點(10 點)');
select is(pg_temp.eng_reason(null, false), 'no_member',
  'D9 §3.1:沒有會員、也不是全新會員試算 ⇒ no_member(訪客單不派點)');
select is(pg_temp.eng_reason('db120000-0000-4000-8000-000000000081'), 'no_member',
  'D10 資安:別家商家的會員 id ⇒ 當成沒有會員(no_member)');

update merchant_member_settings set points_feature_enabled = false
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select results_eq(
  $$select auto_points, eligible, ineligible_reason from pg_temp.eng('db120000-0000-4000-8000-000000000061', '[]'::jsonb, 5000)
      as t(auto_points int, review_required bool, eligible bool, ineligible_reason text, breakdown jsonb)$$,
  $$values (0, false, 'feature_disabled'::text)$$,
  'D11 §3.1:紅利功能關閉 ⇒ auto = 0、feature_disabled'
);
update merchant_member_settings set points_feature_enabled = true
where merchant_id = 'db120000-0000-4000-8000-000000000021';

-- =========================================================================
-- E. §2.6 開關 2/3 + 第 14 題
--    61 一般 / 62 推薦者 / 63 被推薦者 / 64 既推薦(68)又被推薦(62 推薦)
-- =========================================================================
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000061'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000062'),
                pg_temp.eng_reason('db120000-0000-4000-8000-000000000063'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000064')],
  array['ok', 'ok', 'ok', 'ok'],
  'E1 §2.6:兩個開關都開 ⇒ 一般/推薦者/被推薦者/兩者皆是都累積');

update merchant_member_settings set referral_inviter_earning_enabled = false
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000061'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000062'),
                pg_temp.eng_reason('db120000-0000-4000-8000-000000000063'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000064')],
  array['ok', 'inviter_earning_disabled', 'ok', 'inviter_earning_disabled'],
  'E2 §2.6 開關 2 關:推薦者與「兩者皆是」不累積;被推薦者、一般會員照常');
select is(pg_temp.eng_points('db120000-0000-4000-8000-000000000062', '[]'::jsonb, 5000), 0,
  'E3 §2.6 開關 2 關:推薦者 auto = 0');

update merchant_member_settings set referral_inviter_earning_enabled = true, referral_invitee_earning_enabled = false
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000061'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000062'),
                pg_temp.eng_reason('db120000-0000-4000-8000-000000000063'), pg_temp.eng_reason('db120000-0000-4000-8000-000000000064')],
  array['ok', 'ok', 'invitee_earning_disabled', 'invitee_earning_disabled'],
  'E4 §2.6 開關 3 關:被推薦者與「兩者皆是」不累積(第 14 題:任一關閉就不累積)');
select is(pg_temp.eng_reason(null, true), 'ok',
  'E5 §3.1:全新會員沒有推薦關係 ⇒ 開關 3 關閉也不受影響');

update merchant_member_settings set referral_inviter_earning_enabled = false, referral_invitee_earning_enabled = false
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select is(array[pg_temp.eng_reason('db120000-0000-4000-8000-000000000061'), pg_temp.eng_points('db120000-0000-4000-8000-000000000064', '[]'::jsonb, 5000)::text],
  array['ok', '0'],
  'E6 §2.6:兩個開關都關 ⇒ 一般會員照常,「兩者皆是」0 點');
update merchant_member_settings set referral_inviter_earning_enabled = true, referral_invitee_earning_enabled = true
where merchant_id = 'db120000-0000-4000-8000-000000000021';

-- =========================================================================
-- F. §2.10 折抵換算與上限(純函式)
-- =========================================================================
select is(private.redeem_points_to_amount(55, 100, 10), 5::numeric,
  'F1 §2.10 第 17 題:100 點 = 10 元時,55 點折 NT$5(無條件捨去)');
select is(private.redeem_points_to_amount(100, 100, 10), 10::numeric,
  'F2 §2.10:100 點剛好 10 元');
select is(private.redeem_points_to_amount(50, 0, 0), 0::numeric,
  'F3 §2.10:比例尚未設定 ⇒ 0 元');
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(100, 10, 50, 1000, 100000)$$,
  $$values (500::numeric, 500::numeric, 5000)$$,
  'F4 v2.4 裁決 9/10:100 點 = 10 元、上限 NT$500 ⇒ 最多 5000 點(不是 5009,不含換不到錢的零頭),max_amount = 實際可折 500'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(100, 10, 50, 1000, 120)$$,
  $$values (500::numeric, 12::numeric, 120)$$,
  'F5 v2.4 裁決 10:會員只有 120 點 ⇒ 最多 120 點、max_amount = 12(實際可折),比例上限另以 cap_amount = 500 回傳'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(100, 10, 50, 1000, 9)$$,
  $$values (500::numeric, 0::numeric, 0)$$,
  'F6 §2.10:只有 9 點(換算不到 1 元)⇒ 最多 0 點(有折抵點數必須有折抵金額)'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(3, 1, 10, 105.5, 1000)$$,
  $$values (10::numeric, 10::numeric, 30)$$,
  'F7 v2.4 裁決 9:3 點 = 1 元、應付 105.5、上限 10% ⇒ NT$10;折到 10 元最少 30 點(不是 32)'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(100, 10, 0, 1000, 1000)$$,
  $$values (0::numeric, 0::numeric, 0)$$,
  'F8 §2.10:比例 0% ⇒ 不開放(全 0)'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(100, 10, 100, 0, 1000)$$,
  $$values (0::numeric, 0::numeric, 0)$$,
  'F9 §2.10:應付 0 元 ⇒ 不能折'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(7, 3, 33, 999.99, 100000)$$,
  $$values (329::numeric, 329::numeric, 768)$$,
  'F10 v2.4 裁決 9 例:7 點 = 3 元、上限 33%、應付 999.99 ⇒ 768 點折 329 元'
);
select results_eq(
  $$select max_amount, max_points from private.compute_booking_redeem_limits(100, 10, 100, 100000, 55)$$,
  $$values (5::numeric, 55)$$,
  'F11 v2.4 裁決 9 例:餘額卡住(55 點)⇒ 仍回 55 點折 5 元(第 17 題原文例)'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(1, 0.01, 100, 99999999.99, 2147483647)$$,
  $$values (99999999::numeric, 21474836::numeric, 2147483647)$$,
  'F12 邊界不溢位:1 點 = 0.01 元、可用點數 = int 最大值 ⇒ 2147483647 點折 21474836 元'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(2147483647, 0.01, 100, 99999999.99, 2147483647)$$,
  $$values (99999999::numeric, 0::numeric, 0)$$,
  'F13 邊界不溢位:點數單位 = int 最大值、金額單位 0.01(中間值超過 bigint)⇒ 不報錯,折不到 1 元 ⇒ 0'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(1, 99999999.99, 100, 500, 2147483647)$$,
  $$values (500::numeric, 0::numeric, 0)$$,
  'F14 邊界:1 點 = 99999999.99 元(金額單位極大)、上限 500 元 ⇒ 1 點都不能折'
);
select results_eq(
  $$select cap_amount, max_amount, max_points from private.compute_booking_redeem_limits(1, 0.01, 100, 99999999.99, 100)$$,
  $$values (99999999::numeric, 1::numeric, 100)$$,
  'F15 邊界:1 點 = 0.01 元、餘額 100 點 ⇒ 100 點折 1 元'
);

-- 多組參數:max_amount 一律 = redeem_points_to_amount(max_points)(v2.4 裁決 10),
-- 且不超過比例上限、不超過可用點數。
create temp table redeem_grid as
select pu, au, ratio, payable, avail, l.cap_amount, l.max_amount, l.max_points
from unnest(array[1, 3, 7, 100, 2147483647]) pu,
     unnest(array[0.01, 1, 3, 10, 99999999.99]::numeric[]) au,
     unnest(array[1, 10, 33, 50, 100]) ratio,
     unnest(array[0, 30, 99.99, 999.99, 12345.67, 99999999.99]::numeric[]) payable,
     unnest(array[0, 9, 55, 120, 100000, 2147483647]) avail,
     lateral private.compute_booking_redeem_limits(pu, au, ratio, payable, avail) l;

select is(
  (select count(*)::int from redeem_grid
   where private.redeem_points_to_amount(max_points, pu, au) <> max_amount
      or max_amount > cap_amount or max_points > avail or max_points < 0),
  0,
  'F16 v2.4 裁決 10:4500 組參數(含 int 最大值 / 0.01 元單位)皆 redeem_points_to_amount(max_points) = max_amount,且不超過比例上限與可用點數'
);
select is(
  (select count(*)::int from redeem_grid
   where max_points > 0 and max_points < avail
     and private.redeem_points_to_amount(max_points - 1, pu, au) >= max_amount),
  0,
  'F17 v2.4 裁決 9:不是餘額卡住時,少 1 點就一定折不到同樣金額(max_points 不含換不到錢的零頭點數)'
);
select ok(
  (select count(*) from redeem_grid where max_points > 0) > 100
  and (select count(*) from redeem_grid where max_points > 0 and max_points < avail) > 50,
  'F18 正向對照:格點裡確實有大量「可折抵」與「金額上限卡住」的組合(避免 F16/F17 因資料全為 0 而假綠)'
);

-- =========================================================================
-- G. §3.2 末段 resolve_booking_member_by_phone
-- =========================================================================
select results_eq(
  $$select match_count, member_id from private.resolve_booking_member_by_phone('db120000-0000-4000-8000-000000000021', '0912000101')$$,
  $$values (1, 'db120000-0000-4000-8000-000000000061'::uuid)$$,
  'G1:電話完全相等 ⇒ 1 位,就是 A 店那位(B 店同號會員不算)'
);
select results_eq(
  $$select match_count, member_id from private.resolve_booking_member_by_phone('db120000-0000-4000-8000-000000000021', '0912-000-101')$$,
  $$values (1, 'db120000-0000-4000-8000-000000000061'::uuid)$$,
  'G2:有分隔符號的寫法經 normalize_phone 後相等 ⇒ 同一位'
);
select results_eq(
  $$select match_count, member_id from private.resolve_booking_member_by_phone('db120000-0000-4000-8000-000000000021', '0912000109')$$,
  $$values (0, null::uuid)$$,
  'G3:同號但已下架 ⇒ 當 0 筆'
);
select results_eq(
  $$select match_count, member_id from private.resolve_booking_member_by_phone('db120000-0000-4000-8000-000000000021', '091200010')$$,
  $$values (0, null::uuid)$$,
  'G4:前綴不算(完全相等才算)'
);
select results_eq(
  $$select match_count, member_id from private.resolve_booking_member_by_phone('db120000-0000-4000-8000-000000000021', '#123')$$,
  $$values (0, null::uuid)$$,
  'G5:正規化後沒有數字(只有分機)⇒ 0 筆、不報錯'
);

-- =========================================================================
-- H. §3.2 preview_booking_points
-- =========================================================================
-- 先準備 B 店一張訂單(IDOR 用)與 A 店一張連結會員 61 的訂單(編輯模式用)。
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000002');
select id from create_booking(
  p_merchant_id => 'db120000-0000-4000-8000-000000000022',
  p_staff_id => 'db120000-0000-4000-8000-000000000042',
  p_service_items => jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000034', 1, 1000)),
  p_start_at => '2026-12-15 10:00:00+08',
  p_customer_name => 'B店客人',
  p_customer_phone => '0912000101',
  p_payment_method_id => 'db120000-0000-4000-8000-000000000072'
) \gset bbooking_

select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'db120000-0000-4000-8000-000000000021',
  p_staff_id => 'db120000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)),
  p_start_at => '2026-12-16 10:00:00+08',
  p_customer_name => '一般會員',
  p_customer_phone => '0912000101',
  p_payment_method_id => 'db120000-0000-4000-8000-000000000071'
) \gset abooking_
select pg_temp.test_clear_auth();

-- 模擬批次 3 之後才會發生的「建單時折抵 100 點」(直接寫分類帳 + 訂單欄位 + 餘額)。
insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id)
values ('db120000-0000-4000-8000-000000000061', 'db120000-0000-4000-8000-000000000021', 'redeem_booking', -100, 400, :'abooking_id');
update members set points_balance = 400 where id = 'db120000-0000-4000-8000-000000000061';
update bookings set points_redeemed = 100, points_redeem_amount_snapshot = 10 where id = :'abooking_id';

-- --- 權限 ---
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000003');
select is(
  (pg_temp.pv_new('0912999000', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) ->> 'feature_enabled'),
  'true',
  'H1 §2.8:只有 orders 鑰匙的客服可以預覽(刻意用新客戶電話:本 session 第一次預覽就走「不開放折抵」分支,守住 record 未賦值的回歸)'
);
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000004');
select throws_ok(
  $$select pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))$$,
  '42501', '沒有權限查看這間商家的紅利點數預覽',
  'H2 §3.2:只有 members 鑰匙(沒有 orders)⇒ 42501'
);
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000002');
select throws_ok(
  $$select pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))$$,
  '42501', '沒有權限查看這間商家的紅利點數預覽',
  'H3 IDOR:B 店管理員拿 A 店的商家 id 呼叫 ⇒ 42501'
);

-- --- IDOR:訂單 / 會員 ---
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select pg_temp.pv_edit(%L, null, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))$$, :'bbooking_id'),
  '42501', '找不到這筆預約,或沒有權限查看',
  'H4 IDOR:A 店管理員帶 B 店的訂單 id(商家 id 填自己的 A 店)⇒ 42501'
);
select throws_ok(
  $$select pg_temp.pv_edit('db120000-0000-4000-8000-00000000ffff', null, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))$$,
  '42501', '找不到這筆預約,或沒有權限查看',
  'H5 IDOR:不存在的訂單 id ⇒ 同一個 42501 訊息(不洩漏存不存在)'
);
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000003');
select throws_ok(
  format($$select pg_temp.pv_edit(%L, null, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))$$, :'bbooking_id'),
  '42501', '找不到這筆預約,或沒有權限查看',
  'H6 IDOR:A 店客服(orders)帶 B 店訂單 id ⇒ 42501'
);
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select is(
  (select public.preview_booking_points(
     'db120000-0000-4000-8000-000000000021', null, 'db120000-0000-4000-8000-000000000081', '0912000101',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)),
     false, null, false, null, null, false, null, null) -> 'member'),
  '{"resolution":"none","member_id":null,"name":null,"balance":null}'::jsonb,
  'H7 IDOR:別家商家的 p_member_id ⇒ resolution none,不報錯、不回傳姓名與餘額'
);
select is(
  (select jsonb_build_object('auto', r -> 'auto_points', 'reason', r -> 'ineligible_reason', 'redeem', r -> 'redeem' -> 'enabled',
                             'avail', r -> 'redeem' -> 'available_points')
   from public.preview_booking_points(
     'db120000-0000-4000-8000-000000000021', null, 'db120000-0000-4000-8000-000000000081', '0912000101',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)),
     false, null, false, null, null, false, null, null) as r),
  '{"auto":0,"reason":"no_member","redeem":false,"avail":0}'::jsonb,
  'H8 IDOR:別家會員 ⇒ 不派點、不開放折抵、可用點數 0(B 店那位的 9999 點不外洩)'
);
select is(
  (select public.preview_booking_points(
     'db120000-0000-4000-8000-000000000021', null, 'db120000-0000-4000-8000-000000000069', '0912000109',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)),
     false, null, false, null, null, false, null, null) -> 'member' ->> 'resolution'),
  'none',
  'H9 §3.2:已下架的會員 id ⇒ none'
);

-- --- resolution 六種 ---
select is(
  (pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'member'),
  '{"resolution":"existing","member_id":"db120000-0000-4000-8000-000000000061","name":"一般會員","balance":400}'::jsonb,
  'H10 §3.2 existing:電話完全相等 ⇒ 既有會員(姓名、餘額只在這時給)'
);
select is(
  (pg_temp.pv_new('0912-000-101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'member' ->> 'member_id'),
  'db120000-0000-4000-8000-000000000061',
  'H11 §3.2:有分隔符號的電話也對到同一位(與 create_booking 同一套正規化)'
);
select is(
  (pg_temp.pv_new('091200010', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'member'),
  '{"resolution":"phone_incomplete","member_id":null,"name":null,"balance":null}'::jsonb,
  'H12 §3.2 phone_incomplete:還沒打完的電話(前綴)⇒ 不算、不給任何會員資訊'
);
select is(
  (pg_temp.pv_new(null, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'member' ->> 'resolution'),
  'phone_incomplete',
  'H13 §3.2:電話空白 ⇒ phone_incomplete'
);
select is(
  (select jsonb_build_object('res', r -> 'member' ->> 'resolution', 'auto', r -> 'auto_points', 'eligible', r -> 'eligible',
                             'redeem', r -> 'redeem' -> 'enabled', 'avail', r -> 'redeem' -> 'available_points',
                             'maxp', r -> 'redeem' -> 'max_points')
   from pg_temp.pv_new('0912999001', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) as r),
  '{"res":"new","auto":10,"eligible":true,"redeem":false,"avail":0,"maxp":0}'::jsonb,
  'H14 §3.2 new:電話找不到會員 ⇒ 新客戶照樣算派點(10 點),折抵不開放'
);
select is(
  (pg_temp.pv_edit(:'abooking_id', 'db120000-0000-4000-8000-000000000062', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'member'),
  '{"resolution":"given","member_id":"db120000-0000-4000-8000-000000000062","name":"推薦者","balance":0}'::jsonb,
  'H15 §3.2 given:編輯模式帶同商家 active 會員 ⇒ given'
);
select is(
  (pg_temp.pv_edit(:'abooking_id', null, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'member' ->> 'resolution'),
  'none',
  'H16 §3.2 none:編輯模式沒給會員 ⇒ none(編輯模式不依電話比對,即使電話對得到會員)'
);

-- --- line_bound 模式的新客戶 ---
select pg_temp.test_clear_auth();
update merchant_member_settings set reward_condition_mode = 'line_bound'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select is(
  (select jsonb_build_object('res', r -> 'member' ->> 'resolution', 'auto', r -> 'auto_points', 'reason', r ->> 'ineligible_reason')
   from pg_temp.pv_new('0912999002', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) as r),
  '{"res":"new","auto":0,"reason":"reward_condition"}'::jsonb,
  'H17 §3.2:line_bound 模式下的新客戶 ⇒ auto = 0、reason reward_condition'
);
select pg_temp.test_clear_auth();
update merchant_member_settings set reward_condition_mode = 'none'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');

-- --- 折抵上限 / 編輯模式含本單凍結 ---
select is(
  (pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'redeem'),
  '{"enabled":true,"points_unit":100,"amount_unit":10.00,"max_ratio_percent":50,"payable":1000,"available_points":400,"max_points":400,"max_amount":40,"cap_amount":500}'::jsonb,
  'H18 §2.10 / v2.4 裁決 10:既有會員(餘額 400)在 1000 元訂單 ⇒ 比例上限 cap_amount 500、最多 400 點、max_amount = 實際可折 40'
);
select is(
  (pg_temp.pv_edit(:'abooking_id', 'db120000-0000-4000-8000-000000000061', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'redeem' -> 'available_points'),
  '500'::jsonb,
  'H19 §〇.4 判斷 22:編輯同一張單、同一位會員 ⇒ 可用點數 = 餘額 400 + 本單凍結 100 = 500'
);
select is(
  (pg_temp.pv_edit(:'abooking_id', 'db120000-0000-4000-8000-000000000065', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'redeem' -> 'available_points'),
  '0'::jsonb,
  'H20 §〇.4 判斷 22:編輯時換成另一位會員 ⇒ 不加回本單凍結(只看那位的餘額 0)'
);
select is(
  (pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 30))) -> 'redeem'),
  '{"enabled":true,"points_unit":100,"amount_unit":10.00,"max_ratio_percent":50,"payable":30,"available_points":400,"max_points":150,"max_amount":15,"cap_amount":15}'::jsonb,
  'H21 v2.4 裁決 9:30 元訂單、上限 50% ⇒ NT$15;餘額 400 夠 ⇒ 最多 150 點(不是 159,不含零頭)'
);

-- --- 功能關閉只回一個鍵 ---
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = false
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000003');
select is(
  pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))),
  '{"feature_enabled":false}'::jsonb,
  'H22 §3.2:功能關閉 ⇒ 只回 {"feature_enabled": false},不洩漏任何設定或會員資訊'
);
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select throws_ok(
  format($$select pg_temp.pv_edit(%L, null, '[]'::jsonb)$$, :'bbooking_id'),
  '42501', '找不到這筆預約,或沒有權限查看',
  'H23 IDOR:功能關閉時,別家訂單 id 仍然先被 42501 擋下(權限檢查在功能開關之前)'
);
select pg_temp.test_clear_auth();
update merchant_member_settings set points_feature_enabled = true
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');

-- --- 結構完整 / rules_configured ---
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))) k),
  -- 紅利系統重構 批次 7:多一個 reward_condition_mode(只在 ineligible_reason = reward_condition 時有值,
  -- 畫面「需 {條件}」用;其餘情況 null。內容的斷言在 module10_17 A1~A4)。
  array['auto_points', 'breakdown', 'earn_mode', 'eligible', 'feature_enabled', 'ineligible_reason', 'member',
        'redeem', 'review_required', 'reward_condition_mode', 'rules_configured'],
  'H24 §3.2:回傳結構的頂層鍵完整,不多不少'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) -> 'redeem') k),
  array['amount_unit', 'available_points', 'cap_amount', 'enabled', 'max_amount', 'max_points', 'max_ratio_percent', 'payable', 'points_unit'],
  'H25 §3.2:redeem 物件的鍵完整'
);
select is(
  (pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) ->> 'rules_configured'),
  'true',
  'H26 §〇.4 判斷 25:基本模式每筆 10 點 ⇒ rules_configured = true'
);
select pg_temp.test_clear_auth();
update merchant_member_settings set earn_mode = 'advanced'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
update merchant_point_formulas set enabled = false where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select is(
  (select jsonb_build_object('rc', r -> 'rules_configured', 'mode', r -> 'earn_mode', 'auto', r -> 'auto_points')
   from pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) as r),
  '{"rc":false,"mode":"advanced","auto":0}'::jsonb,
  'H27 §〇.4 判斷 25:進階模式、沒有任何啟用中的公式 ⇒ rules_configured = false(前端顯示「尚未設定」而不是 0 點)'
);
select pg_temp.test_clear_auth();
update merchant_point_formulas set enabled = true where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select is(
  (select jsonb_build_object('rc', r -> 'rules_configured', 'auto', r -> 'auto_points', 'n', jsonb_array_length(r -> 'breakdown'))
   from pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000031', 1, 2000),
                                                        pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) as r),
  '{"rc":true,"auto":6,"n":2}'::jsonb,
  'H28 §3.2:進階模式預覽 = 引擎(6 點、breakdown 兩項)'
);
select pg_temp.test_clear_auth();
update merchant_member_settings set earn_mode = 'basic'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');

-- --- 錯誤不噴 500 ---
select is(
  (select array_agg(k order by k) from jsonb_object_keys(pg_temp.pv_new('0912000101', '[]'::jsonb)) k),
  array['error', 'feature_enabled'],
  'H29 §3.2 邊界:服務項目空陣列 ⇒ 回 {feature_enabled, error},不 raise'
);
select is(
  (select public.preview_booking_points(
     'db120000-0000-4000-8000-000000000021', null, null, '0912000101',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)),
     false, null, true, 'fixed', 2000, false, null, null) ->> 'error'),
  '折扣金額不能超過訂單小計',
  'H30 §3.2 邊界:折扣超過小計 ⇒ error 帶 calculate_booking_amount 的原訊息'
);
select is(
  (pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000034', 1, 1000))) ->> 'error'),
  '找不到其中一個服務項目',
  'H31 資安:別家商家的服務項目 ⇒ error,不算點'
);
select is(
  (select public.preview_booking_points(
     'db120000-0000-4000-8000-000000000021', null, null, '0912000101',
     jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)),
     false, null, true, 'percentage', 10, true, 'percentage', 5) ->> 'review_required'),
  'true',
  'H32 §2.5:預覽有折扣 ⇒ review_required = true'
);

-- --- 唯讀 ---
select pg_temp.test_clear_auth();
select pg_temp.data_fingerprint() as fp \gset before_
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000003');
select count(*) as n from (
  select pg_temp.pv_new('0912999003', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) as r
  union all
  select pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))
  union all
  select pg_temp.pv_edit(:'abooking_id', 'db120000-0000-4000-8000-000000000061', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000)))
) s \gset readonly_calls_
select pg_temp.test_clear_auth();
select is(pg_temp.data_fingerprint(), :'before_fp',
  'H33 §3.2 唯讀:預覽前後 members / member_point_transactions / bookings / booking_service_items 完全沒變(新客戶預覽沒有真的建會員)');
select is((select count(*)::int from members where phone = '0912999003'), 0,
  'H34 §3.2:預覽新客戶不會建立會員');

-- --- 預覽 = 實際建單路徑(§七 核心必測)---
-- ① 既有會員:預覽 auto = 以 create_booking 寫入的會員與 final_amount_snapshot 呼叫引擎的結果。
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select (pg_temp.pv_new('0912000105', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 2, 400))) ->> 'auto_points')::int
  as auto \gset pv1_
select id, member_id, final_amount_snapshot from create_booking(
  p_merchant_id => 'db120000-0000-4000-8000-000000000021',
  p_staff_id => 'db120000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 2, 400)),
  p_start_at => '2026-12-17 10:00:00+08',
  p_customer_name => '電話已驗證',
  p_customer_phone => '0912000105',
  p_payment_method_id => 'db120000-0000-4000-8000-000000000071'
) \gset cb1_
select pg_temp.test_clear_auth();
select is(:'cb1_member_id'::uuid, 'db120000-0000-4000-8000-000000000065'::uuid,
  'H35 預覽 = 實際:預覽說 existing 的那位,就是 create_booking 連結的會員');
select is(pg_temp.eng_points(:'cb1_member_id'::uuid, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 2, 400)), :'cb1_final_amount_snapshot'::numeric),
  :'pv1_auto'::int,
  'H36 預覽 = 實際(既有會員):預覽 auto_points = 引擎以實際訂單的會員與金額算出的點數(800 元 ⇒ 10 點)');

-- ② 新客戶(none 模式):預覽用「全新會員」屬性試算 = create_booking 自動建立的那位真會員算出來的點數。
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select (pg_temp.pv_new('0912888001', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 600))) ->> 'auto_points')::int
  as auto \gset pv2_
select id, member_id, final_amount_snapshot, member_auto_created from create_booking(
  p_merchant_id => 'db120000-0000-4000-8000-000000000021',
  p_staff_id => 'db120000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 600)),
  p_start_at => '2026-12-18 10:00:00+08',
  p_customer_name => '全新客戶',
  p_customer_phone => '0912888001',
  p_payment_method_id => 'db120000-0000-4000-8000-000000000071'
) \gset cb2_
select pg_temp.test_clear_auth();
select ok(:'cb2_member_auto_created'::boolean and :'pv2_auto'::int = 10,
  'H37 預覽 = 實際(新客戶):預覽 10 點,送出後確實自動建立了會員');
select is(pg_temp.eng_points(:'cb2_member_id'::uuid, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 600)), :'cb2_final_amount_snapshot'::numeric),
  :'pv2_auto'::int,
  'H38 預覽 = 實際(新客戶):自動建立的真會員算出來的點數 = 預覽的「全新會員」試算');

-- ③ 新客戶 + line_bound 模式:兩邊都是 0。
update merchant_member_settings set reward_condition_mode = 'line_bound'
where merchant_id = 'db120000-0000-4000-8000-000000000021';
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select (pg_temp.pv_new('0912888002', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 600))) ->> 'auto_points')::int
  as auto \gset pv3_
select id, member_id, final_amount_snapshot from create_booking(
  p_merchant_id => 'db120000-0000-4000-8000-000000000021',
  p_staff_id => 'db120000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 600)),
  p_start_at => '2026-12-19 10:00:00+08',
  p_customer_name => '全新客戶二',
  p_customer_phone => '0912888002',
  p_payment_method_id => 'db120000-0000-4000-8000-000000000071'
) \gset cb3_
select pg_temp.test_clear_auth();
select is(
  array[:'pv3_auto'::int,
        pg_temp.eng_points(:'cb3_member_id'::uuid, jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 600)), :'cb3_final_amount_snapshot'::numeric)],
  array[0, 0],
  'H39 預覽 = 實際(line_bound 模式新客戶):預覽 0 點,自動建立的真會員也是 0 點');
update merchant_member_settings set reward_condition_mode = 'none'
where merchant_id = 'db120000-0000-4000-8000-000000000021';

-- --- ambiguous(#931 之後不會發生;在交易內暫時拿掉唯一索引製造舊資料)---
drop index members_merchant_active_phone_uniq;
insert into members (id, merchant_id, name, phone, referral_code, points_balance) values
  ('db120000-0000-4000-8000-00000000006a', 'db120000-0000-4000-8000-000000000021', '同號第二位', '0912000101', 'M1012A0A', 50);
select pg_temp.test_set_auth('db120000-0000-4000-8000-000000000001');
select is(
  (select jsonb_build_object('member', r -> 'member', 'auto', r -> 'auto_points', 'redeem', r -> 'redeem' -> 'enabled')
   from pg_temp.pv_new('0912000101', jsonb_build_array(pg_temp.it('db120000-0000-4000-8000-000000000032', 1, 1000))) as r),
  '{"member":{"resolution":"ambiguous","member_id":null,"name":null,"balance":null},"auto":0,"redeem":false}'::jsonb,
  'H40 §3.2 ambiguous:同號兩位 active ⇒ 當成沒有會員(不派點、不折抵、不給姓名)'
);
select pg_temp.test_clear_auth();
select results_eq(
  $$select match_count, member_id from private.resolve_booking_member_by_phone('db120000-0000-4000-8000-000000000021', '0912000101')$$,
  $$values (2, 'db120000-0000-4000-8000-000000000061'::uuid)$$,
  'G6:同號兩位時 match_count = 2、member_id = 最早建立的那位(與 create_booking 既有規則一致)'
);

select * from finish();
rollback;
