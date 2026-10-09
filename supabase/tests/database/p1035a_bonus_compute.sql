-- SPECS-INDEX #1035 彈性計薪 A 批(月薪加獎金)— 計算與報表
-- migration 20261010160100_req1035a_bonus_functions.sql
-- 規格書:母版 .project/specs/彈性計薪.md PA-R02~R05、PA-F05、PA-B01、第七節 PT(A)。
--
--   R  每種規則 × (T=0、剛好 T、超過 T、有 cap、retroactive、指定服務、跨門檻那一單的業績只算超過部分)、
--      冷氣例子「T=10、做 13 台 ⇒ 900」(含一張 2 台的單)、四捨五入、合計封頂旗標
--   Q  只算主要服務人員(跟場不算)、只算 completed(還原後就不算)
--   V  PA-R03 業績基準跟 private.calculate_booking_staff_commission 對同一張單算出的基準逐列一致
--      (有折扣、有料錢、店家設定扣料錢)
--   M  compute_staff_monthly_bonus:月底當時不是月薪制 ⇒ 0;試算(preview)跟存檔後算的一致
--   B  店家報表:有方案的店 淨利 = 原算法 − 獎金、明細月薪列 bonus_amount;不完整月份 null;
--      沒有方案的店 total_monthly_bonus = 0、bonus_feature_used = false、淨利不變
begin;

select plan(40);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- ── Fixture ───────────────────────────────────────────────────────────────
--   A 店:01 管理員;服務人員 M(月薪、計算對象)、M2(月薪、沒有方案;基準比對用)、P(抽成,跟場用)
--   B 店:02 管理員;月薪人員 MB(沒有方案)
insert into auth.users (id, email) values
  ('f1035b00-0000-4000-8000-000000000001', 'pgtap-1035b-admin-a@test.local'),
  ('f1035b00-0000-4000-8000-000000000002', 'pgtap-1035b-admin-b@test.local');
insert into groups (id) values
  ('f1035b00-0000-4000-8000-000000000011'),
  ('f1035b00-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1035b00-0000-4000-8000-000000000020', 'f1035b00-0000-4000-8000-000000000011', '#1035 計算店', 'on_site_dispatch'),
  ('f1035b00-0000-4000-8000-000000000021', 'f1035b00-0000-4000-8000-000000000012', '#1035 沒方案店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f1035b00-0000-4000-8000-000000000020', 'f1035b00-0000-4000-8000-000000000001', 'A 店主'),
  ('f1035b00-0000-4000-8000-000000000021', 'f1035b00-0000-4000-8000-000000000002', 'B 店主');
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f1035b00-0000-4000-8000-000000000031', 'f1035b00-0000-4000-8000-000000000020', '冷氣清洗', 1000, 'primary', 30),
  ('f1035b00-0000-4000-8000-000000000032', 'f1035b00-0000-4000-8000-000000000020', '水管', 2000, 'primary', 30),
  ('f1035b00-0000-4000-8000-000000000033', 'f1035b00-0000-4000-8000-000000000021', 'B 項目', 1500, 'primary', 30);
insert into payment_methods (id, merchant_id, name) values
  ('f1035b00-0000-4000-8000-000000000050', 'f1035b00-0000-4000-8000-000000000020', '現金'),
  ('f1035b00-0000-4000-8000-000000000051', 'f1035b00-0000-4000-8000-000000000021', '現金');
insert into material_cost_items (id, merchant_id, name, amount) values
  ('f1035b00-0000-4000-8000-000000000060', 'f1035b00-0000-4000-8000-000000000020', '冷媒', 170);
insert into merchant_feature_flags (merchant_id, feature_key, enabled) values
  ('f1035b00-0000-4000-8000-000000000020', 'material_cost_enabled', true);
insert into merchant_staff (id, merchant_id, name, compensation_type, status, unlimited_backend_edit, phone, created_at) values
  ('f1035b00-0000-4000-8000-000000000040', 'f1035b00-0000-4000-8000-000000000020', '月薪M', 'monthly_salary', 'active', true, '0900103540', now() - interval '400 days'),
  ('f1035b00-0000-4000-8000-000000000041', 'f1035b00-0000-4000-8000-000000000020', '月薪M2', 'monthly_salary', 'active', true, '0900103541', now() - interval '400 days'),
  ('f1035b00-0000-4000-8000-000000000042', 'f1035b00-0000-4000-8000-000000000020', '抽成P', 'piece_rate', 'active', true, '0900103542', now() - interval '400 days'),
  ('f1035b00-0000-4000-8000-000000000043', 'f1035b00-0000-4000-8000-000000000021', '月薪MB', 'monthly_salary', 'active', true, '0900103543', now() - interval '400 days');
insert into staff_salary_settings (staff_id, monthly_base_salary) values
  ('f1035b00-0000-4000-8000-000000000040', 30000),
  ('f1035b00-0000-4000-8000-000000000041', 28000),
  ('f1035b00-0000-4000-8000-000000000043', 26000);
create function pg_temp.mk(p_staff uuid, p_items jsonb, p_start timestamptz, p_assistants uuid[] default null,
                           p_material jsonb default null, p_discount numeric default null)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f1035b00-0000-4000-8000-000000000020',
    p_staff_id => p_staff,
    p_service_items => p_items,
    p_start_at => p_start,
    p_customer_name => '王先生',
    p_customer_phone => '0955103500',
    p_customer_address => '台北市測試路 1035 號',
    p_assistant_staff_ids => p_assistants,
    p_material_cost_items => p_material,
    p_discount_enabled => p_discount is not null,
    p_discount_mode => case when p_discount is not null then 'fixed' end,
    p_discount_value => p_discount,
    p_payment_method_id => 'f1035b00-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, jsonb, timestamptz, uuid[], jsonb, numeric) to authenticated;
create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;
grant execute on function pg_temp.done(uuid) to authenticated;
create function pg_temp.s1(n int) returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('service_item_id', 'f1035b00-0000-4000-8000-000000000031', 'quantity', n, 'unit_price', 1000));
$$;
grant execute on function pg_temp.s1(int) to authenticated;

-- 月薪M 本月完成:11 張「冷氣清洗 ×1」+ 1 張「冷氣清洗 ×2」(= 13 台、12 單)+ 1 張「水管 ×1」
--   ⇒ 全部 14 份、13 單;業績 冷氣 13,000 + 水管 2,000 = 15,000(沒有折扣、沒有料錢)
-- 另外:抽成P 為主要、月薪M 跟場的一張(不能算進 M);M 一張完成後又被還原(不能算)
select pg_temp.test_set_auth('f1035b00-0000-4000-8000-000000000001');
create temp table p1035b_bk (id uuid) on commit drop;
grant all on p1035b_bk to authenticated;
insert into p1035b_bk
select pg_temp.mk('f1035b00-0000-4000-8000-000000000040', pg_temp.s1(1), timestamptz '2036-03-02 09:00+08' + g * interval '1 hour')
from generate_series(1, 11) g;
insert into p1035b_bk select pg_temp.mk('f1035b00-0000-4000-8000-000000000040', pg_temp.s1(2), '2036-03-03 09:00+08');
insert into p1035b_bk select pg_temp.mk('f1035b00-0000-4000-8000-000000000040',
  '[{"service_item_id":"f1035b00-0000-4000-8000-000000000032","quantity":1,"unit_price":2000}]', '2036-03-03 11:00+08');
select pg_temp.done(id) from p1035b_bk;
select pg_temp.mk('f1035b00-0000-4000-8000-000000000042', pg_temp.s1(5), '2036-03-04 09:00+08',
  array['f1035b00-0000-4000-8000-000000000040']::uuid[]) as assist_id \gset
select pg_temp.done(:'assist_id'::uuid);
select pg_temp.mk('f1035b00-0000-4000-8000-000000000040', pg_temp.s1(4), '2036-03-05 09:00+08') as rev_id \gset
select pg_temp.done(:'rev_id'::uuid);
select public.revert_completed_booking(:'rev_id'::uuid, '測試還原');

-- 基準比對用(月薪M2,不影響 M):兩個項目 + 折扣 333 + 料錢 170 × 3,店家設定「扣料錢」
select public.set_material_cost_affects_commission('f1035b00-0000-4000-8000-000000000020', true);
select pg_temp.mk('f1035b00-0000-4000-8000-000000000041',
  '[{"service_item_id":"f1035b00-0000-4000-8000-000000000031","quantity":3,"unit_price":1000},{"service_item_id":"f1035b00-0000-4000-8000-000000000032","quantity":1,"unit_price":2000}]',
  '2036-03-06 09:00+08', null,
  '[{"material_cost_item_id":"f1035b00-0000-4000-8000-000000000060","quantity":3}]', 333) as basis_id \gset
select pg_temp.done(:'basis_id'::uuid);
select public.set_material_cost_affects_commission('f1035b00-0000-4000-8000-000000000020', false);
reset role;

select date_trunc('month', now() at time zone 'Asia/Taipei')::date as this_month,
       (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month - 1 day')::date as month_end,
       (now() at time zone 'Asia/Taipei')::date as today \gset ctx_

-- 一條規則算出來的結果(先正規化,再照算)
create function pg_temp.rr(p_rule jsonb) returns jsonb language sql as $$
  select private.bonus_compute_rules('f1035b00-0000-4000-8000-000000000040',
    date_trunc('month', now() at time zone 'Asia/Taipei')::date,
    private.bonus_validate_rules('f1035b00-0000-4000-8000-000000000020', jsonb_build_array(p_rule || '{"key":"k","label":"x"}'::jsonb))) -> 'rules' -> 0;
$$;
create function pg_temp.amt(p_rule jsonb) returns numeric language sql as $$
  select (pg_temp.rr(p_rule) ->> 'amount')::numeric;
$$;

-- =========================================================================
-- R 每種規則
-- =========================================================================
select is(
  (select (r ->> 'quantity') || '/' || (r ->> 'counted_quantity') || '/' || (r ->> 'range_start') || '~' || (r ->> 'range_end') || '/' || (r ->> 'amount')
   from (select pg_temp.rr('{"kind":"per_unit","threshold":10,"amount":300,"service_item_ids":["f1035b00-0000-4000-8000-000000000031"]}') r) x),
  '13/3/11~13/900', 'R1 冷氣例子:只算冷氣、T=10、做 13 台(含一張 2 台)⇒ 第 11~13 台 = 900'
);
select is(pg_temp.amt('{"kind":"per_unit","threshold":10,"amount":300}'), 1200::numeric, 'R2 不指定服務 ⇒ 14 份,第 11~14 份 = 1,200');
select is(pg_temp.amt('{"kind":"per_unit","threshold":0,"amount":10}'), 140::numeric, 'R3 T=0 ⇒ 從第一份開始(14 × 10)');
select is(pg_temp.amt('{"kind":"per_unit","threshold":14,"amount":300}'), 0::numeric, 'R4 剛好 T(14 份、T=14)⇒ 0');
select is(
  (select (r ->> 'range_start') || '~' || (r ->> 'range_end') || '/' || (r ->> 'amount')
   from (select pg_temp.rr('{"kind":"per_unit","threshold":10,"cap":12,"amount":300}') r) x),
  '11~12/600', 'R5 cap=12 ⇒ 只算第 11~12 份'
);
select is(pg_temp.amt('{"kind":"per_unit","threshold":10,"amount":300,"retroactive":true,"service_item_ids":["f1035b00-0000-4000-8000-000000000031"]}'),
  3900::numeric, 'R6 retroactive:達標後整月都算 ⇒ 13 × 300');
select is(pg_temp.amt('{"kind":"per_unit","threshold":13,"amount":300,"retroactive":true,"service_item_ids":["f1035b00-0000-4000-8000-000000000031"]}'),
  0::numeric, 'R7 retroactive 但 Q = T(沒有超過)⇒ 0');
select is(pg_temp.amt('{"kind":"per_unit","threshold":10,"cap":12,"amount":300,"retroactive":true}'),
  3600::numeric, 'R8 retroactive + cap ⇒ 第 1~12 份');
select is(pg_temp.amt('{"kind":"per_order","threshold":10,"amount":100}'), 300::numeric, 'R9 per_order:13 單、T=10 ⇒ 3 單 × 100');
select is(
  (select (r ->> 'quantity') || '/' || (r ->> 'amount')
   from (select pg_temp.rr('{"kind":"per_order","threshold":0,"amount":100,"service_item_ids":["f1035b00-0000-4000-8000-000000000032"]}') r) x),
  '1/100', 'R10 per_order 指定服務 ⇒ 只算含水管的單'
);
select is(
  (select (r ->> 'quantity')::numeric || '/' || (r ->> 'counted_quantity')::numeric || '/' || (r ->> 'amount')
   from (select pg_temp.rr('{"kind":"percent","threshold":12000,"percent":5}') r) x),
  '15000.00/3000.00/150', 'R11 percent:業績 15,000、T=12,000 ⇒ 超過的 3,000 × 5%(跨門檻那一單只算超過部分)'
);
select is(pg_temp.amt('{"kind":"percent","threshold":12000,"cap":14000,"percent":5}'), 100::numeric, 'R12 percent + cap ⇒ (14,000 − 12,000) × 5%');
select is(pg_temp.amt('{"kind":"percent","threshold":12000,"percent":5,"retroactive":true}'), 750::numeric, 'R13 percent retroactive ⇒ 15,000 × 5%');
select is(pg_temp.amt('{"kind":"percent","threshold":0,"percent":5,"service_item_ids":["f1035b00-0000-4000-8000-000000000032"]}'),
  100::numeric, 'R14 percent 指定服務 ⇒ 只算水管 2,000 × 5%');
select is(pg_temp.amt('{"kind":"percent","threshold":0,"percent":3.33}'), 500::numeric, 'R15 四捨五入到元:15,000 × 3.33% = 499.5 ⇒ 500');
select is(pg_temp.amt('{"kind":"lump_sum","metric":"orders","threshold":13,"amount":3000}'), 3000::numeric, 'R16 lump_sum:滿 13 單(剛好)⇒ 給');
select is(pg_temp.amt('{"kind":"lump_sum","metric":"orders","threshold":14,"amount":3000}'), 0::numeric, 'R17 lump_sum:差一單 ⇒ 不給');
select is(pg_temp.amt('{"kind":"lump_sum","metric":"revenue","threshold":0,"amount":500}'), 500::numeric, 'R18 lump_sum T=0 ⇒ 只要有量就給');
select is(pg_temp.amt('{"kind":"lump_sum","metric":"units","threshold":10,"cap":12,"amount":500}'), 0::numeric, 'R19 lump_sum 有 cap:14 份超過 12 ⇒ 不給 ⚠️');
select is(
  (select (r ->> 'amount') || '/' || (r ->> 'flags')
   from (select private.bonus_compute_rules('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month'::date,
           private.bonus_validate_rules('f1035b00-0000-4000-8000-000000000020',
             '[{"key":"a","label":"x","kind":"per_unit","threshold":0,"amount":1000000}]')) r) x),
  '1000000/["capped"]', 'R20 合計超過 1,000,000 ⇒ 封頂 + capped 旗標'
);
select is(
  (select (r ->> 'amount')::numeric
   from (select private.bonus_compute_rules('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month'::date,
           private.bonus_validate_rules('f1035b00-0000-4000-8000-000000000020',
             '[{"key":"a","label":"x","kind":"per_order","threshold":0,"amount":100},{"key":"b","label":"y","kind":"per_unit","threshold":10,"amount":300,"service_item_ids":["f1035b00-0000-4000-8000-000000000031"]}]')) r) x),
  2200::numeric, 'R21 多條規則疊加:每單 100(13 單)+ 超過 10 台每台 300(900)= 2,200'
);

-- =========================================================================
-- Q 只算主要服務人員、只算 completed
-- =========================================================================
select is(
  (select count(*)::int from booking_assistants where booking_id = :'assist_id'::uuid and staff_id = 'f1035b00-0000-4000-8000-000000000040'),
  1, 'Q1 前提:月薪M 是那張 5 台訂單的跟場'
);
select is(pg_temp.amt('{"kind":"per_unit","threshold":0,"amount":1}'), 14::numeric,
  'Q2 跟場那張(5 台)與被還原那張(4 台)都不算 ⇒ 仍是 14 份');
select is((select status from bookings where id = :'rev_id'::uuid), 'accepted', 'Q3 前提:被還原那張已不是 completed');

-- =========================================================================
-- V PA-R03 業績基準跟抽成基準一致
-- =========================================================================
select is(
  (select jsonb_agg(jsonb_build_object('id', r.booking_service_item_id, 'base', r.basis_amount) order by r.booking_service_item_id)
   from private.booking_item_revenue_basis(:'basis_id'::uuid) r),
  (select jsonb_agg(jsonb_build_object('id', (e ->> 'booking_service_item_id')::uuid, 'base', (e ->> 'commission_base_amount')::numeric)
                    order by (e ->> 'booking_service_item_id')::uuid)
   from jsonb_array_elements(private.calculate_booking_staff_commission(:'basis_id'::uuid, 'f1035b00-0000-4000-8000-000000000041') -> 'items') e),
  'V1 店家設定「扣料錢」時:業績基準逐列 = 抽成基準(含折扣、料錢分攤)'
);
update merchant_payroll_settings set commission_basis_type = 'net_of_material_cost' where merchant_id = 'f1035b00-0000-4000-8000-000000000020';
select ok(
  (select sum(basis_amount) from private.booking_item_revenue_basis(:'basis_id'::uuid))
    < (select subtotal_amount_snapshot - discount_amount_snapshot from bookings where id = :'basis_id'::uuid),
  'V2 前提:這張單真的有扣到料錢(基準合計 < 小計 − 折扣)'
);
update merchant_payroll_settings set commission_basis_type = 'gross' where merchant_id = 'f1035b00-0000-4000-8000-000000000020';
select is(
  (select jsonb_agg(jsonb_build_object('id', r.booking_service_item_id, 'base', r.basis_amount) order by r.booking_service_item_id)
   from private.booking_item_revenue_basis(:'basis_id'::uuid) r),
  (select jsonb_agg(jsonb_build_object('id', (e ->> 'booking_service_item_id')::uuid, 'base', (e ->> 'commission_base_amount')::numeric)
                    order by (e ->> 'booking_service_item_id')::uuid)
   from jsonb_array_elements(private.calculate_booking_staff_commission(:'basis_id'::uuid, 'f1035b00-0000-4000-8000-000000000041') -> 'items') e),
  'V3 店家設定「不扣料錢」時:業績基準逐列 = 抽成基準'
);
select is(
  (select md5(replace(prosrc, chr(13) || chr(10), chr(10))) from pg_proc
   where oid = 'private.calculate_booking_staff_commission(uuid, uuid)'::regprocedure),
  '3ed85dc4fb8e51128829e7f521458a79', 'V4 calculate_booking_staff_commission 指紋沒變'
);

-- =========================================================================
-- M compute_staff_monthly_bonus / preview
-- =========================================================================
select pg_temp.test_set_auth('f1035b00-0000-4000-8000-000000000001');
select public.save_staff_bonus_plan('f1035b00-0000-4000-8000-000000000020', null, '冷氣組',
  '[{"key":"per-order","label":"每單 100","kind":"per_order","threshold":0,"amount":100},{"key":"over-ten","label":"超過 10 台每台 300","kind":"per_unit","threshold":10,"amount":300,"service_item_ids":["f1035b00-0000-4000-8000-000000000031"]}]',
  'this_month') as plan_id \gset
select public.set_staff_bonus_plan('f1035b00-0000-4000-8000-000000000040', :'plan_id'::uuid);
select is(
  (public.preview_staff_bonus('f1035b00-0000-4000-8000-000000000020',
     '[{"key":"per-order","label":"每單 100","kind":"per_order","threshold":0,"amount":100},{"key":"over-ten","label":"超過 10 台每台 300","kind":"per_unit","threshold":10,"amount":300,"service_item_ids":["f1035b00-0000-4000-8000-000000000031"]}]',
     'f1035b00-0000-4000-8000-000000000040', :'ctx_this_month') ->> 'amount')::numeric,
  2200::numeric, 'M1 試算(還沒存檔的規則)= 2,200'
);
select throws_ok(
  format($$select public.preview_staff_bonus('f1035b00-0000-4000-8000-000000000020', '[{"key":"a","label":"x","kind":"per_order","threshold":0,"amount":1}]',
           'f1035b00-0000-4000-8000-000000000040', (%L::date - interval '24 months')::date)$$, :'ctx_this_month'),
  '22023', '試算月份只能選最近 24 個月（含本月）。', 'M2 試算月份限最近 24 個月'
);
reset role;
select is(
  (select (r ->> 'amount') || '/' || (r ->> 'plan_name') || '/' || (r -> 'rules' -> 1 ->> 'range_start') || '~' || (r -> 'rules' -> 1 ->> 'range_end')
   from (select private.compute_staff_monthly_bonus('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month'::date) r) x),
  '2200/冷氣組/11~13', 'M3 存檔指派後本月獎金 = 試算結果 2,200'
);
update merchant_staff set compensation_type = 'piece_rate' where id = 'f1035b00-0000-4000-8000-000000000040';
select is(
  (select (r ->> 'amount') || '/' || (r ->> 'has_plan')
   from (select private.compute_staff_monthly_bonus('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month'::date) r) x),
  '0/false', 'M4 月底當時不是月薪制 ⇒ 0(指派不自動清掉,但不計)'
);
update merchant_staff set compensation_type = 'monthly_salary' where id = 'f1035b00-0000-4000-8000-000000000040';
select is(
  (private.compute_staff_monthly_bonus('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month'::date) ->> 'amount')::numeric,
  2200::numeric, 'M5 改回月薪制、方案還在 ⇒ 照算'
);

-- =========================================================================
-- B 店家報表
-- =========================================================================
select pg_temp.test_set_auth('f1035b00-0000-4000-8000-000000000001');
create temp table p1035b_rep on commit drop as select
  public.get_merchant_billing_summary_by_range('f1035b00-0000-4000-8000-000000000020', :'ctx_this_month', :'ctx_month_end') as full_m,
  public.get_merchant_billing_summary_by_range('f1035b00-0000-4000-8000-000000000020', :'ctx_this_month', :'ctx_month_end'::date - 1) as part_m;
select is((select (full_m ->> 'total_monthly_bonus')::numeric || '/' || (full_m ->> 'bonus_feature_used') from p1035b_rep),
  '2200.00/true', 'B1 完整月份:total_monthly_bonus = 2,200、bonus_feature_used = true');
select is(
  (select (full_m ->> 'estimated_net_margin')::numeric from p1035b_rep),
  (select (full_m ->> 'total_revenue_excl_tax')::numeric - (full_m ->> 'total_material_cost')::numeric
          - (full_m ->> 'total_commission_payout')::numeric
          - ((full_m ->> 'total_monthly_salary_base')::numeric - (full_m ->> 'total_monthly_salary_deduction')::numeric)
          - 2200
   from p1035b_rep),
  'B2 淨利 = 原算法 − 獎金'
);
select is(
  (select jsonb_object_agg(e ->> 'staff_name', e -> 'bonus_amount') from p1035b_rep, jsonb_array_elements(full_m -> 'per_staff_breakdown') e),
  '{"月薪M": 2200.00, "月薪M2": 0.00, "抽成P": null}'::jsonb,
  'B3 明細:月薪列 bonus_amount 有數字(沒方案 = 0),抽成列 null'
);
select is(
  (select coalesce(part_m ->> 'total_monthly_bonus', 'null') || '/' || coalesce(part_m ->> 'estimated_net_margin', 'null') || '/'
          || (select string_agg(coalesce(e ->> 'bonus_amount', 'null'), ',' order by e ->> 'staff_name') from jsonb_array_elements(part_m -> 'per_staff_breakdown') e)
   from p1035b_rep),
  'null/null/null,null,null', 'B4 不完整月份:獎金與淨利都是 null(不是 0)'
);
select pg_temp.test_set_auth('f1035b00-0000-4000-8000-000000000002');
select is(
  (select (r ->> 'total_monthly_bonus')::numeric || '/' || (r ->> 'bonus_feature_used') || '/'
          || ((r ->> 'estimated_net_margin')::numeric = (r ->> 'total_revenue_excl_tax')::numeric - (r ->> 'total_material_cost')::numeric
              - (r ->> 'total_commission_payout')::numeric
              - ((r ->> 'total_monthly_salary_base')::numeric - (r ->> 'total_monthly_salary_deduction')::numeric))::text
   from (select public.get_merchant_billing_summary_by_range('f1035b00-0000-4000-8000-000000000021', :'ctx_this_month', :'ctx_month_end') r) x),
  '0.00/false/true', 'B5 沒有方案的店:獎金 0、bonus_feature_used = false、淨利照原算法(不變)'
);
select pg_temp.test_set_auth('f1035b00-0000-4000-8000-000000000001');
select is(
  (select (r ->> 'total_amount')::numeric || '/' || (r -> 'months' -> 0 ->> 'amount')
   from (select public.get_staff_bonus_by_range('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month', :'ctx_month_end') r) x),
  '2200/2200', 'B6 get_staff_bonus_by_range 合計 = 店家報表那一列'
);
reset role;
-- 封存方案後歷史月份照算(風險 7):先取消指派再封存
select pg_temp.test_set_auth('f1035b00-0000-4000-8000-000000000001');
select public.set_staff_bonus_plan('f1035b00-0000-4000-8000-000000000040', null);
select public.archive_staff_bonus_plan(:'plan_id'::uuid);
reset role;
select is(
  (select (r ->> 'amount') || '/' || (r ->> 'has_plan')
   from (select private.compute_staff_monthly_bonus('f1035b00-0000-4000-8000-000000000040', :'ctx_this_month'::date) r) x),
  '0/false', 'B7 本月月底當時已經沒有方案 ⇒ 本月 0(以月底當時的選擇為準)'
);

select * from finish();
rollback;
