-- SPECS-INDEX #977 第 4 批(2026-10-06):「商家後台確認後直接接單」開關生效 — pgTAP
-- migration 20261006140100_req977_create_booking_direct_accept.sql
-- 規格書 .project/specs/服務人員接單確認-第4批.md 第四、六節;主腦裁決 ⑤ ⑥。
--
--   ①     指紋:把本批新增的段落拿掉、v_initial_status 換回 'pending_confirmation' 之後,prosrc 指紋必須等於改前
--          d8fb4ffb50f0516c8c815aed24c09784(CRLF→LF 後 md5)⇒ 其餘內容逐字相同
--          ⚠️ #977 第 7 批(2026-10-07)又在 create_booking 加了一段 [req977-batch7] 包起來的段落(created_by_role 認得服務人員),
--          所以下面的正規表示式改成同時拿掉 batch4 與 batch7 兩種段落(batch[47]),其餘不變;第 7 批自己的指紋見 req977_05 ⑦。
--   ②     ACL / 簽章與改前相同
--   ③~⑥   「改前複製品」比對:用 ① 還原出來的改前版本另建一份 pg_temp.create_booking_old,
--          開關關閉時 4 組參數(新客自動建會員 / 既有會員+派點覆寫+協助人員+折扣+稅+自訂工時+藏備註 /
--          紅利折抵+自訂總金額 / 客服建單)在各自回滾的子交易裡跑新舊兩版,訂單整列、操作紀錄、服務項目、
--          協助人員、點數分類帳全部相同(只排除 id 與會員 id 這種每次隨機產生的值)
--   ⑦~⑩   開關開啟:管理員建單 / 客服建單都直接 accepted、操作紀錄 to_status = accepted;
--          只有「協助人員」開了開關不算(看主要服務人員);開關開啟時跟舊版只差狀態與紀錄
--   ⑪~⑫   編輯訂單換主要服務人員:狀態不變(待確認換給開了開關的人仍是待確認;已確認換給沒開的人仍是已確認)
begin;

select plan(12);

-- #987 第 10 批(2026-10-07):create_booking 的錯誤訊息半形標點改成全形。
-- 這裡先把第 10 批改過的訊息換回舊訊息(完整 SQL 字串字面值,含單引號),再套原本的還原規則比指紋;
-- 第 10 批自己「只動訊息」的證明見 req987_0*_fullwidth_messages_*.sql。
create function pg_temp.req987_revert(p_src text) returns text language plpgsql immutable as $req987$
declare
  v_pairs text[] := array[
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

-- =========================================================================
-- ① 指紋 + 建立「改前複製品」
-- =========================================================================
create temp table r977e_src on commit drop as
  select
    replace(p.prosrc, E'\r\n', E'\n') as new_src,
    replace(
      regexp_replace(
        pg_temp.req987_revert(replace(p.prosrc, E'\r\n', E'\n')),
        '  -- \[req977-batch[47] begin\].*?-- \[req977-batch[47] end\]\n', '', 'g'),
      'v_initial_status', '''pending_confirmation''') as reverted_src,
    pg_get_functiondef(p.oid) as def
  from pg_proc p
  where p.oid = 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)'::regprocedure;

select is(
  (select md5(reverted_src) from r977e_src),
  -- 第 11 批 F #993(migration 20261007140300)把料錢參數改成 jsonb(數量 / 自訂成本單價),基準改成「F 版本拿掉本批段落後」的指紋;
  -- 第 4 批改前指紋 d8fb4ffb50f0516c8c815aed24c09784。
  'e789100f3d6b0b6be04c450180305805',
  '① 拿掉本批新增段落、v_initial_status 換回 pending_confirmation 後,指紋等於改前(其餘內容逐字相同)'
);

do $$
declare
  v_def text;
begin
  select def into v_def from r977e_src;
  v_def := replace(v_def, 'FUNCTION public.create_booking(', 'FUNCTION pg_temp.create_booking_old(');
  v_def := regexp_replace(v_def, '  -- \[req977-batch[47] begin\].*?-- \[req977-batch[47] end\]\n', '', 'g');
  v_def := replace(v_def, 'v_initial_status', '''pending_confirmation''');
  execute v_def;
end;
$$;

select is(
  (select array_to_string(proacl, ' ') || ' / ' || pronargs || ' / ' || prosecdef::text
   from pg_proc where oid = 'public.create_booking(uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid)'::regprocedure),
  'postgres=X/postgres authenticated=X/postgres service_role=X/postgres / 28 / true',
  '② create_booking 的 ACL、28 個參數、SECURITY DEFINER 都跟改前相同'
);

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('f9775000-0000-4000-8000-000000000001', 'pgtap-r977e-admin@test.local'),
  ('f9775000-0000-4000-8000-000000000003', 'pgtap-r977e-agent@test.local');
insert into groups (id) values ('f9775000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values
  ('f9775000-0000-4000-8000-000000000021', 'f9775000-0000-4000-8000-000000000011', '#977 直接接單測試店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('f9775000-0000-4000-8000-000000000021', 'f9775000-0000-4000-8000-000000000001');
insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('f9775000-0000-4000-8000-000000000051', 'f9775000-0000-4000-8000-000000000021',
   'f9775000-0000-4000-8000-000000000003', '客服甲', '0900977551', 'pgtap-r977e-agent@test.local', 'active');
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('f9775000-0000-4000-8000-000000000051', 'orders', true);
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('f9775000-0000-4000-8000-000000000031', 'f9775000-0000-4000-8000-000000000021', '剪髮', 1000, 'primary', 60, 'active'),
  ('f9775000-0000-4000-8000-000000000032', 'f9775000-0000-4000-8000-000000000021', '護髮', 600, 'primary', 30, 'active');
insert into payment_methods (id, merchant_id, name) values
  ('f9775000-0000-4000-8000-000000000071', 'f9775000-0000-4000-8000-000000000021', '現金');
-- 40:開關關閉(預設)/ 41:開關關閉(當協助人員)/ 42:開關開啟 / 43:只有它開(當協助人員用)
insert into merchant_staff (id, merchant_id, name, phone, unlimited_backend_edit, direct_accept_after_merchant_confirm) values
  ('f9775000-0000-4000-8000-000000000040', 'f9775000-0000-4000-8000-000000000021', '關閉者', '0900977540', true, false),
  ('f9775000-0000-4000-8000-000000000041', 'f9775000-0000-4000-8000-000000000021', '協助者', '0900977541', true, false),
  ('f9775000-0000-4000-8000-000000000042', 'f9775000-0000-4000-8000-000000000021', '開啟者', '0900977542', true, true),
  ('f9775000-0000-4000-8000-000000000043', 'f9775000-0000-4000-8000-000000000021', '開啟的協助者', '0900977543', true, true);
insert into merchant_member_settings (merchant_id, earn_mode, basic_points_per_order, basic_min_amount,
                                      redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent)
values ('f9775000-0000-4000-8000-000000000021', 'basic', 10, 500, 100, 10, 50);
insert into members (id, merchant_id, name, phone, referral_code, points_balance, status) values
  ('f9775000-0000-4000-8000-000000000061', 'f9775000-0000-4000-8000-000000000021', '老會員', '0913977561', 'R977E61', 1000, 'active');

-- 一筆訂單的完整快照(排除每次隨機的 id / 會員 id;同一個交易內 now() 相同,時間欄位可以直接比)。
create function pg_temp.snap(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select (to_jsonb(b) - 'id' - 'member_id')
    || jsonb_build_object(
      'has_member', b.member_id is not null,
      'logs', (select jsonb_agg(jsonb_build_object('f', from_status, 't', to_status, 'r', actor_role_snapshot, 'n', actor_name_snapshot) order by created_at)
               from booking_status_change_logs where booking_id = b.id),
      'items', (select jsonb_agg(jsonb_build_object('s', service_item_id, 'q', quantity, 'p', unit_price_snapshot, 'd', duration_minutes_snapshot) order by service_item_id)
                from booking_service_items where booking_id = b.id),
      'assistants', (select jsonb_agg(staff_id order by staff_id) from booking_assistants where booking_id = b.id),
      'ledger', (select jsonb_agg(jsonb_build_object('t', transaction_type, 'd', points_delta, 'a', balance_after))
                 from member_point_transactions where booking_id = b.id))
  from bookings b where b.id = p_id;
$$;

-- 第 N 組參數,%s = 要呼叫的函式(新版 public.create_booking 或改前複製品 pg_temp.create_booking_old)。
create function pg_temp.call_sql(p_fn text, p_set int, p_staff uuid)
returns text language sql as $$
  select format(case p_set
    when 1 then $q$select id from %s(
      p_merchant_id => 'f9775000-0000-4000-8000-000000000021', p_staff_id => %L,
      p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
      p_start_at => '2026-12-01 10:00:00+08', p_customer_name => '新客人', p_customer_phone => '0922977501',
      p_payment_method_id => 'f9775000-0000-4000-8000-000000000071')$q$
    when 2 then $q$select id from %s(
      p_merchant_id => 'f9775000-0000-4000-8000-000000000021', p_staff_id => %L,
      p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":2,"unit_price":900},{"service_item_id":"f9775000-0000-4000-8000-000000000032","quantity":1,"unit_price":600}]',
      p_start_at => '2026-12-02 13:00:00+08', p_customer_name => '老會員改名', p_customer_phone => '0913977561',
      p_customer_email => 'a@example.com', p_notes => '內部備註', p_customer_notes => '客戶備註',
      p_assistant_staff_ids => array['f9775000-0000-4000-8000-000000000041']::uuid[],
      p_discount_enabled => true, p_discount_mode => 'fixed', p_discount_value => 100,
      p_tax_enabled => true, p_tax_mode => 'percentage', p_tax_value => 5,
      p_custom_duration_enabled => true, p_custom_duration_minutes => 90,
      p_hide_notes_from_staff => true, p_points_override => 7,
      p_payment_method_id => 'f9775000-0000-4000-8000-000000000071')$q$
    when 3 then $q$select id from %s(
      p_merchant_id => 'f9775000-0000-4000-8000-000000000021', p_staff_id => %L,
      p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
      p_start_at => '2026-12-03 15:00:00+08', p_customer_name => '老會員', p_customer_phone => '0913977561',
      p_custom_total_amount_enabled => true, p_custom_total_amount => 1500,
      p_points_redeemed => 100, p_points_redeem_member_id => 'f9775000-0000-4000-8000-000000000061',
      p_payment_method_id => 'f9775000-0000-4000-8000-000000000071')$q$
  end, p_fn, p_staff);
$$;

-- 在一個會回滾的子交易裡跑一次建單,只把快照帶出來(兩版跑同一個時段也不會互相衝突)。
create function pg_temp.run_rb(p_sql text)
returns jsonb language plpgsql as $$
declare
  v_id uuid;
  v_snap jsonb;
begin
  begin
    execute p_sql into v_id;
    v_snap := pg_temp.snap(v_id);
    raise exception using errcode = 'RB977', message = 'rollback';
  exception when sqlstate 'RB977' then
    null;
  end;
  return v_snap;
end;
$$;

grant execute on function pg_temp.snap(uuid), pg_temp.call_sql(text, int, uuid), pg_temp.run_rb(text) to authenticated;

-- =========================================================================
-- ③~⑥ 開關關閉:新舊兩版結果完全相同
-- =========================================================================
select pg_temp.test_set_auth('f9775000-0000-4000-8000-000000000001');
create temp table r977e_cmp (label text, new_snap jsonb, old_snap jsonb) on commit drop;
insert into r977e_cmp
  select 's' || s, pg_temp.run_rb(pg_temp.call_sql('public.create_booking', s, 'f9775000-0000-4000-8000-000000000040')),
                   pg_temp.run_rb(pg_temp.call_sql('pg_temp.create_booking_old', s, 'f9775000-0000-4000-8000-000000000040'))
  from generate_series(1, 3) s;
select pg_temp.test_set_auth('f9775000-0000-4000-8000-000000000003');
insert into r977e_cmp
  select 'agent', pg_temp.run_rb(pg_temp.call_sql('public.create_booking', 2, 'f9775000-0000-4000-8000-000000000040')),
                  pg_temp.run_rb(pg_temp.call_sql('pg_temp.create_booking_old', 2, 'f9775000-0000-4000-8000-000000000040'));
select pg_temp.test_clear_auth();

select ok(
  (select new_snap = old_snap and new_snap ->> 'status' = 'pending_confirmation'
          and (new_snap ->> 'member_auto_created')::boolean from r977e_cmp where label = 's1'),
  '③ 開關關閉 / 新客人(自動建立會員):新舊兩版整筆結果相同,狀態待確認'
);
select ok(
  (select new_snap = old_snap and jsonb_array_length(new_snap -> 'assistants') = 1
          and (new_snap ->> 'points_planned')::int = 7 and (new_snap ->> 'hide_notes_from_staff')::boolean
   from r977e_cmp where label = 's2'),
  '④ 開關關閉 / 既有會員+派點覆寫+協助人員+折扣+稅+自訂工時+藏備註:新舊兩版整筆結果相同'
);
select ok(
  (select new_snap = old_snap and (new_snap ->> 'points_redeemed')::int = 100 and jsonb_array_length(new_snap -> 'ledger') = 1
   from r977e_cmp where label = 's3'),
  '⑤ 開關關閉 / 紅利折抵+自訂總金額:新舊兩版整筆結果相同(含點數分類帳)'
);
select ok(
  (select new_snap = old_snap and new_snap ->> 'created_by_role' = 'agent'
          and new_snap -> 'logs' -> 0 ->> 'r' = 'agent'
   from r977e_cmp where label = 'agent'),
  '⑥ 開關關閉 / 客服建單:新舊兩版整筆結果相同'
);

-- =========================================================================
-- ⑦~⑩ 開關開啟
-- =========================================================================
select pg_temp.test_set_auth('f9775000-0000-4000-8000-000000000001');
create temp table r977e_on (label text, new_snap jsonb, old_snap jsonb) on commit drop;
insert into r977e_on
  select 'admin', pg_temp.run_rb(pg_temp.call_sql('public.create_booking', 1, 'f9775000-0000-4000-8000-000000000042')),
                  pg_temp.run_rb(pg_temp.call_sql('pg_temp.create_booking_old', 1, 'f9775000-0000-4000-8000-000000000042'));
select pg_temp.test_set_auth('f9775000-0000-4000-8000-000000000003');
insert into r977e_on
  select 'agent', pg_temp.run_rb(pg_temp.call_sql('public.create_booking', 3, 'f9775000-0000-4000-8000-000000000042')), null;
select pg_temp.test_clear_auth();

select is(
  (select jsonb_build_object('status', new_snap ->> 'status', 'logs', new_snap -> 'logs') from r977e_on where label = 'admin'),
  jsonb_build_object('status', 'accepted', 'logs', jsonb_build_array(jsonb_build_object('f', null, 't', 'accepted', 'r', 'merchant_admin', 'n', 'pgtap-r977e-admin'))),
  '⑦ 開關開啟 / 管理員建單:新訂單直接是 accepted,建立的操作紀錄 to_status 也是 accepted'
);
select ok(
  (select (new_snap - 'status' - 'logs') = (old_snap - 'status' - 'logs')
          and old_snap ->> 'status' = 'pending_confirmation'
   from r977e_on where label = 'admin'),
  '⑧ 開關開啟時跟改前版本相比,只差狀態與操作紀錄,其他欄位完全相同'
);
select is(
  (select new_snap ->> 'status' || '/' || (new_snap -> 'logs' -> 0 ->> 't') from r977e_on where label = 'agent'),
  'accepted/accepted',
  '⑨ 開關開啟 / 客服建單(含紅利折抵):一樣直接 accepted'
);

select pg_temp.test_set_auth('f9775000-0000-4000-8000-000000000001');
select is(
  (select status from public.create_booking(
     p_merchant_id => 'f9775000-0000-4000-8000-000000000021',
     p_staff_id => 'f9775000-0000-4000-8000-000000000040',
     p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
     p_start_at => '2026-12-05 10:00:00+08', p_customer_name => '客人五', p_customer_phone => '0922977505',
     p_assistant_staff_ids => array['f9775000-0000-4000-8000-000000000043']::uuid[],
     p_payment_method_id => 'f9775000-0000-4000-8000-000000000071')),
  'pending_confirmation',
  '⑩ 只有協助人員開了開關、主要服務人員沒開 ⇒ 仍是待確認(只看主要服務人員)'
);

-- =========================================================================
-- ⑪~⑫ 編輯換主要服務人員:狀態不變
-- =========================================================================
select id from public.create_booking(
  p_merchant_id => 'f9775000-0000-4000-8000-000000000021',
  p_staff_id => 'f9775000-0000-4000-8000-000000000040',
  p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
  p_start_at => '2026-12-06 10:00:00+08', p_customer_name => '客人六', p_customer_phone => '0922977506',
  p_payment_method_id => 'f9775000-0000-4000-8000-000000000071') \gset p_
select id from public.create_booking(
  p_merchant_id => 'f9775000-0000-4000-8000-000000000021',
  p_staff_id => 'f9775000-0000-4000-8000-000000000042',
  p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
  p_start_at => '2026-12-07 10:00:00+08', p_customer_name => '客人七', p_customer_phone => '0922977507',
  p_payment_method_id => 'f9775000-0000-4000-8000-000000000071') \gset a_

select is(
  (select status from public.update_booking(
     p_booking_id => :'p_id'::uuid,
     p_staff_id => 'f9775000-0000-4000-8000-000000000042',
     p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
     p_start_at => '2026-12-06 10:00:00+08', p_customer_name => '客人六', p_customer_phone => '0922977506',
     p_payment_method_id => 'f9775000-0000-4000-8000-000000000071')),
  'pending_confirmation',
  '⑪ 待確認的單改派給開了開關的服務人員 ⇒ 仍是待確認(主腦裁決 ⑥)'
);
select is(
  (select status from public.update_booking(
     p_booking_id => :'a_id'::uuid,
     p_staff_id => 'f9775000-0000-4000-8000-000000000040',
     p_service_items => '[{"service_item_id":"f9775000-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]',
     p_start_at => '2026-12-07 10:00:00+08', p_customer_name => '客人七', p_customer_phone => '0922977507',
     p_payment_method_id => 'f9775000-0000-4000-8000-000000000071')),
  'accepted',
  '⑫ 直接接單建立的已確認單改派給沒開開關的服務人員 ⇒ 仍是已確認'
);
select pg_temp.test_clear_auth();

select * from finish();

rollback;
