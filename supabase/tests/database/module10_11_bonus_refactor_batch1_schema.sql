-- 紅利系統重構 批次 1(資料庫地基)的回歸測試。
-- 對應 migration 20261001020000_bonus_refactor_batch1_schema.sql;規格書 .project/specs/紅利系統重構.md
-- §1.1~§1.6、§3.10、§七。
--
-- 測的東西:
--   A. §1.1 merchant_member_settings 新欄位:預設值、每一道 CHECK 正反、seed 新商家仍成功、舊欄位還在
--   B. §3.10 保護 trigger:只有 member_settings 鑰匙的客服改任何一個新規則欄位都被擋(UPDATE + INSERT 兩面),
--      member_points 客服可以改;會員政策「原樣送一次新欄位」照樣存得進去;members-only 客服連列都碰不到
--   C. §1.2 merchant_point_formulas:兩個唯一索引、跨商家服務項目被擋、CHECK、RLS 四種角色 + 別家管理員
--   D. §1.3 member_birthday_bonus_grants:(member_id, bonus_year) 唯一、CHECK、RLS(members 或 member_points
--      任一放行,其他角色看不到,沒有任何寫入政策)
--   E. §1.4 bookings 7 個新欄位:預設值、CHECK 正反
--   F. §1.5 transaction_type 10 種、既有 earn_booking 唯一索引保留且沒有新增同型索引
--   G. §1.6 line_notification_log.event_type 允許 birthday_bonus
--   H. 權限衛生:兩張新表 RLS 開著;兩支新的 private trigger 函式三個角色都沒有 EXECUTE
--   I. v2.4 主腦裁決 1/2:單一會員硬刪除、平台清除會員(有生日紀錄 + 折抵訂單)都成功,折抵數字不變
--   J. v2.4 補測:§1.1 兩個開關的回填結果
--
-- 時間:本檔不依賴「現在幾月幾號」;唯一的業務時間是寫死的台北時間 2026-12-15 10:00(建單用)。
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

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

select plan(93);

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

-- 13 個新規則欄位 + 一個「非預設」的合法測試值。給 B 段的逐欄測試用。
create function pg_temp.new_rule_columns()
returns table(col text, val text) language sql as $$
  values
    ('earn_mode', $v$'advanced'$v$),
    ('basic_points_per_order', '5'),
    ('basic_min_amount', '10'),
    ('basic_tiered_enabled', 'true'),
    ('redeem_points_unit', '100'),
    ('redeem_amount_unit', '10'),
    ('redeem_max_ratio_percent', '50'),
    ('referral_inviter_reward_enabled', 'true'),
    ('referral_subsequent_bonus_points', '5'),
    ('referral_inviter_earning_enabled', 'false'),
    ('referral_invitee_earning_enabled', 'false'),
    ('birthday_bonus_enabled', 'true'),
    ('birthday_line_message', $v$'改過的生日文案'$v$)
$$;

-- 逐欄 UPDATE,回傳「沒有被 42501 擋下」的欄位清單(空陣列 = 每一欄都被擋)。
-- 每一欄在自己的 exception 區塊裡跑(子交易),彼此不互相影響。
create function pg_temp.update_cols_not_blocked(p_merchant_id uuid)
returns text[] language plpgsql as $$
declare
  r record;
  v_rows int;
  v_out text[] := '{}';
begin
  for r in select * from pg_temp.new_rule_columns() loop
    begin
      execute format('update public.merchant_member_settings set %I = %s where merchant_id = %L',
                     r.col, r.val, p_merchant_id);
      get diagnostics v_rows = row_count;
      v_out := v_out || (r.col || ':not_blocked_rows=' || v_rows);
    exception
      when insufficient_privilege then null;
      when others then v_out := v_out || (r.col || ':' || sqlstate);
    end;
  end loop;
  return v_out;
end;
$$;

-- 逐欄 INSERT(只帶 merchant_id + 一個非預設的新欄位),回傳沒被 42501 擋下的欄位。
create function pg_temp.insert_cols_not_blocked(p_merchant_id uuid)
returns text[] language plpgsql as $$
declare
  r record;
  v_out text[] := '{}';
begin
  for r in select * from pg_temp.new_rule_columns() loop
    begin
      execute format('insert into public.merchant_member_settings (merchant_id, %I) values (%L, %s)',
                     r.col, p_merchant_id, r.val);
      v_out := v_out || (r.col || ':not_blocked');
    exception
      when insufficient_privilege then null;
      when others then v_out := v_out || (r.col || ':' || sqlstate);
    end;
  end loop;
  return v_out;
end;
$$;

-- =========================================================================
-- Fixture
--   使用者:1 管理員(A 店、A2 店)/ 2 客服P(member_points)/ 3 客服S(member_settings)/
--           4 客服M(members)/ 6 B 店管理員 / 7 新開店的使用者
--   商家:A(…20,有設定列)、A2(…22,同集團、刻意沒有設定列,測 INSERT 面)、B(…21,別的集團)
-- =========================================================================
insert into auth.users (id, email) values
  ('db110000-0000-4000-8000-000000000001', 'pgtap-m1011-admin@test.local'),
  ('db110000-0000-4000-8000-000000000002', 'pgtap-m1011-agent-points@test.local'),
  ('db110000-0000-4000-8000-000000000003', 'pgtap-m1011-agent-settings@test.local'),
  ('db110000-0000-4000-8000-000000000004', 'pgtap-m1011-agent-members@test.local'),
  ('db110000-0000-4000-8000-000000000006', 'pgtap-m1011-admin-b@test.local'),
  ('db110000-0000-4000-8000-000000000007', 'pgtap-m1011-onboard@test.local');

insert into groups (id) values
  ('db110000-0000-4000-8000-000000000010'),
  ('db110000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('db110000-0000-4000-8000-000000000020', 'db110000-0000-4000-8000-000000000010', '紅利地基測試A店', 'in_store_beauty'),
  ('db110000-0000-4000-8000-000000000022', 'db110000-0000-4000-8000-000000000010', '紅利地基測試A2店(無設定列)', 'in_store_beauty'),
  ('db110000-0000-4000-8000-000000000021', 'db110000-0000-4000-8000-000000000011', '紅利地基測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('db110000-0000-4000-8000-000000000020', 'db110000-0000-4000-8000-000000000001'),
  ('db110000-0000-4000-8000-000000000022', 'db110000-0000-4000-8000-000000000001'),
  ('db110000-0000-4000-8000-000000000021', 'db110000-0000-4000-8000-000000000006');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('db110000-0000-4000-8000-000000000051', 'db110000-0000-4000-8000-000000000020',
   'db110000-0000-4000-8000-000000000002', '客服P(紅利點數管理)', '0900011101',
   'pgtap-m1011-agent-points@test.local', 'active'),
  ('db110000-0000-4000-8000-000000000052', 'db110000-0000-4000-8000-000000000020',
   'db110000-0000-4000-8000-000000000003', '客服S(會員系統設定)', '0900011102',
   'pgtap-m1011-agent-settings@test.local', 'active'),
  ('db110000-0000-4000-8000-000000000053', 'db110000-0000-4000-8000-000000000020',
   'db110000-0000-4000-8000-000000000004', '客服M(會員管理)', '0900011103',
   'pgtap-m1011-agent-members@test.local', 'active'),
  ('db110000-0000-4000-8000-000000000054', 'db110000-0000-4000-8000-000000000022',
   'db110000-0000-4000-8000-000000000003', '客服S(A2店)', '0900011102',
   'pgtap-m1011-agent-settings@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('db110000-0000-4000-8000-000000000051', 'member_points', true),
  ('db110000-0000-4000-8000-000000000052', 'member_settings', true),
  ('db110000-0000-4000-8000-000000000053', 'members', true),
  ('db110000-0000-4000-8000-000000000054', 'member_settings', true);

-- A 店設定列:只帶 merchant_id(全部新欄位吃 schema 預設值)。
insert into merchant_member_settings (merchant_id) values ('db110000-0000-4000-8000-000000000020');

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'db110000-0000-4000-8000-000000000020', d, false, '00:00', '23:59'
from generate_series(0, 6) as d;

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('db110000-0000-4000-8000-000000000031', 'db110000-0000-4000-8000-000000000020', 'A店服務', 1000, 'primary', 30),
  ('db110000-0000-4000-8000-000000000033', 'db110000-0000-4000-8000-000000000020', 'A店服務2', 500, 'primary', 30),
  ('db110000-0000-4000-8000-000000000032', 'db110000-0000-4000-8000-000000000021', 'B店服務', 1000, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit) values
  ('db110000-0000-4000-8000-000000000041', 'db110000-0000-4000-8000-000000000020', '服務人員', '0901011101', true);

insert into payment_methods (id, merchant_id, name) values
  ('db110000-0000-4000-8000-000000000071', 'db110000-0000-4000-8000-000000000020', '現場付款');

-- =========================================================================
-- A. §1.1 新欄位:預設值、CHECK、seed、舊欄位仍在
-- =========================================================================
select is(
  (select row(earn_mode, basic_points_per_order, basic_min_amount, basic_tiered_enabled,
              redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent,
              referral_inviter_reward_enabled, referral_subsequent_bonus_points,
              referral_inviter_earning_enabled, referral_invitee_earning_enabled,
              birthday_bonus_enabled, birthday_line_message)::text
   from merchant_member_settings where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  row('basic', 0, 0.00, false, 0, 0.00, 0, false, 0, true, true, false,
      '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。')::text,
  'A1 §1.1:只帶 merchant_id 建立的設定列,13 個新欄位全部是規格書表格的預設值(開關 2/3 預設 true、其餘 0/false/basic、生日文案預設句)'
);

-- 批次 6 更新:舊欄位在批次 6(20261001070000)已 drop,這條改成斷言它已不存在。
select hasnt_column('public', 'merchant_member_settings', 'points_earn_rate',
  'A2 §〇.4 判斷 19:points_earn_rate 在批次 6 已 drop(批次 1 時保留,批次 6 才砍)');

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000007');
select create_group_and_merchant('紅利地基種子測試店', 'in_store_beauty') \gset onboarding_merchant_
select pg_temp.test_clear_auth();

select is(
  (select row(earn_mode, redeem_max_ratio_percent, referral_inviter_reward_enabled, birthday_bonus_enabled)::text
   from merchant_member_settings
   where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  row('basic', 0, false, false)::text,
  'A3 §1.1:以一般登入者身分走 create_group_and_merchant 開新店,seed_default_member_settings 仍成功(保護 trigger 沒有擋到只帶預設值的 INSERT),新欄位都是預設值'
);

-- CHECK 反例(以 postgres 身分直接改,只驗資料庫約束本身)。
select throws_ok(
  $$update merchant_member_settings set earn_mode = 'mixed' where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_earn_mode_check"',
  'A4 §1.1:earn_mode 只能是 basic / advanced'
);
select throws_ok(
  $$update merchant_member_settings set basic_points_per_order = -1 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_basic_points_per_order_check"',
  'A5 §1.1:basic_points_per_order 不可為負'
);
select throws_ok(
  $$update merchant_member_settings set basic_min_amount = -0.01 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_basic_min_amount_check"',
  'A6 §1.1:basic_min_amount 不可為負'
);
select throws_ok(
  $$update merchant_member_settings set basic_tiered_enabled = true, basic_min_amount = 0 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_basic_tiered_requires_min_amount"',
  'A7 §1.1:滿額累計開啟時門檻不能是 0(否則除以零)'
);
select lives_ok(
  $$update merchant_member_settings set basic_tiered_enabled = true, basic_min_amount = 100 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  'A8 §1.1(正例):滿額累計開啟 + 門檻 100 可以存'
);
select throws_ok(
  $$update merchant_member_settings set redeem_points_unit = 100, redeem_amount_unit = 0 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_redeem_units_pair"',
  'A9 §1.1:兌換比例只填點數、金額是 0 → 擋下(兩個要同時 0 或同時 > 0)'
);
select throws_ok(
  $$update merchant_member_settings set redeem_points_unit = 0, redeem_amount_unit = 10 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_redeem_units_pair"',
  'A10 §1.1:兌換比例只填金額、點數是 0 → 擋下'
);
select lives_ok(
  $$update merchant_member_settings set redeem_points_unit = 100, redeem_amount_unit = 10, redeem_max_ratio_percent = 100 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  'A11 §1.1(正例):100 點折 10 元、上限 100% 可以存'
);
select throws_ok(
  $$update merchant_member_settings set redeem_max_ratio_percent = 101 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_redeem_max_ratio_percent_check"',
  'A12 §1.1:單次最大使用比例不能超過 100%'
);
select throws_ok(
  $$update merchant_member_settings set redeem_max_ratio_percent = -1 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_redeem_max_ratio_percent_check"',
  'A13 §1.1:單次最大使用比例不能是負數'
);
select throws_ok(
  $$update merchant_member_settings set referral_subsequent_bonus_points = -1 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_referral_subsequent_bonus_points_check"',
  'A14 §1.1:後續推薦獎勵點數不可為負'
);
select throws_ok(
  format($$update merchant_member_settings set birthday_line_message = %L where merchant_id = 'db110000-0000-4000-8000-000000000020'$$, repeat('字', 1001)),
  '23514',
  'new row for relation "merchant_member_settings" violates check constraint "merchant_member_settings_birthday_line_message_length_check"',
  'A15 §1.1:生日 LINE 文案超過 1000 字 → 擋下'
);
select lives_ok(
  format($$update merchant_member_settings set birthday_line_message = %L where merchant_id = 'db110000-0000-4000-8000-000000000020'$$, repeat('字', 1000)),
  'A16 §1.1(正例):剛好 1000 字可以存(char_length 算字數,不是 byte)'
);
select throws_ok(
  $$update merchant_member_settings set birthday_line_message = null where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '23502',
  'null value in column "birthday_line_message" of relation "merchant_member_settings" violates not-null constraint',
  'A17 §1.1:生日文案不可為 NULL(排程發 LINE 時一定要有範本)'
);

-- 把 A 店還原成全部預設值,讓下面 B 段從乾淨狀態開始。
update merchant_member_settings
set earn_mode = 'basic', basic_points_per_order = 0, basic_min_amount = 0, basic_tiered_enabled = false,
    redeem_points_unit = 0, redeem_amount_unit = 0, redeem_max_ratio_percent = 0,
    referral_inviter_reward_enabled = false, referral_subsequent_bonus_points = 0,
    referral_inviter_earning_enabled = true, referral_invitee_earning_enabled = true,
    birthday_bonus_enabled = false,
    birthday_line_message = '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。',
    policy_content = '原始政策'
where merchant_id = 'db110000-0000-4000-8000-000000000020';

-- =========================================================================
-- B. §3.10 保護 trigger 的權限邊界
-- =========================================================================

-- B1/B2:只有 member_settings 的客服 S,改 13 個新規則欄位中的任何一個都被擋(UPDATE 面)。
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000003');
select is(
  pg_temp.update_cols_not_blocked('db110000-0000-4000-8000-000000000020'),
  '{}'::text[],
  'B1 §3.10(核心):只有「會員系統設定」鑰匙的客服,逐一改 13 個新規則欄位(紅利計算/點數使用/推薦系統/生日獎勵),每一個都被 42501 擋下,沒有漏網欄位'
);
select throws_ok(
  $$update merchant_member_settings set earn_mode = 'advanced' where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '42501',
  '紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改；「會員管理」權限可以做手動調整與登記兌換，但不能改這些規則',
  'B2 §3.10:被擋時的白話錯誤訊息逐字正確(列出新的四個分頁名稱)'
);
-- 批次 6 更新:舊欄位已 drop、也已移出保護清單;這條改成確認既有規則欄位 referral_bonus_points 仍被保護。
select throws_ok(
  $$update merchant_member_settings set referral_bonus_points = 50 where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  '42501',
  '紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改；「會員管理」權限可以做手動調整與登記兌換，但不能改這些規則',
  'B3 §3.10:既有規則欄位(referral_bonus_points)仍在保護清單內(批次 6 只移出已 drop 的 points_earn_rate)'
);

-- B4/B5:關鍵回歸——S 存會員政策時,整列 upsert 把所有規則欄位(含 13 個新欄位)原樣送一次,必須成功。
select lives_ok(
  $$update merchant_member_settings
    set policy_enabled = true, policy_content = '客服S改過的政策',
        points_feature_enabled = true, reward_condition_mode = 'none',
        referral_bonus_points = 0, birthday_bonus_points = 0,
        earn_mode = 'basic', basic_points_per_order = 0, basic_min_amount = 0, basic_tiered_enabled = false,
        redeem_points_unit = 0, redeem_amount_unit = 0, redeem_max_ratio_percent = 0,
        referral_inviter_reward_enabled = false, referral_subsequent_bonus_points = 0,
        referral_inviter_earning_enabled = true, referral_invitee_earning_enabled = true,
        birthday_bonus_enabled = false,
        birthday_line_message = '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。'
    where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  'B4 §3.10(關鍵回歸,絕對不能壞):只有會員系統設定鑰匙的客服存「會員政策」時,整列 upsert 把新舊全部規則欄位原樣送一次(值沒變)→ 必須成功'
);
select pg_temp.test_clear_auth();
select is(
  (select policy_content from merchant_member_settings where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  '客服S改過的政策',
  'B5 §3.10:上一條的會員政策真的存進去了(不是被靜默擋下)'
);

-- B6/B7:INSERT 面——S 在沒有設定列的 A2 店,帶任何一個非預設的新規則欄位 INSERT 都被擋;只帶 merchant_id 放行。
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000003');
select is(
  pg_temp.insert_cols_not_blocked('db110000-0000-4000-8000-000000000022'),
  '{}'::text[],
  'B6 §3.10(INSERT 面):在還沒有設定列的商家,只有會員系統設定鑰匙的客服帶 13 個新規則欄位中任何一個非預設值 INSERT,每一個都被擋(upsert 第一次走 INSERT,不能從這裡繞過)'
);
select lives_ok(
  $$insert into merchant_member_settings (merchant_id) values ('db110000-0000-4000-8000-000000000022')$$,
  'B7 §3.10(INSERT 面,不能壞):只帶 merchant_id、全部吃預設值的 INSERT 必須放行(= seed_default_member_settings 的路徑)'
);
select pg_temp.test_clear_auth();

-- B8/B9:member_points 客服 P 可以一次改全部 13 個新欄位,而且真的生效。
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000002');
select lives_ok(
  $$update merchant_member_settings
    set earn_mode = 'advanced', basic_points_per_order = 5, basic_min_amount = 100, basic_tiered_enabled = true,
        redeem_points_unit = 100, redeem_amount_unit = 10, redeem_max_ratio_percent = 50,
        referral_inviter_reward_enabled = true, referral_subsequent_bonus_points = 5,
        referral_inviter_earning_enabled = false, referral_invitee_earning_enabled = false,
        birthday_bonus_enabled = true, birthday_line_message = '生日快樂 {{member_name}}'
    where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  'B8 §2.8/§3.10(反面對照):紅利點數管理鑰匙的客服可以修改全部新規則欄位'
);
select pg_temp.test_clear_auth();
select is(
  (select row(earn_mode, basic_points_per_order, basic_min_amount, basic_tiered_enabled,
              redeem_points_unit, redeem_amount_unit, redeem_max_ratio_percent,
              referral_inviter_reward_enabled, referral_subsequent_bonus_points,
              referral_inviter_earning_enabled, referral_invitee_earning_enabled,
              birthday_bonus_enabled, birthday_line_message)::text
   from merchant_member_settings where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  row('advanced', 5, 100.00, true, 100, 10.00, 50, true, 5, false, false, true, '生日快樂 {{member_name}}')::text,
  'B9 §3.10:客服 P 的修改確實生效'
);

-- B10:只有 members 鑰匙的客服 M 連這張表的列都碰不到(RLS),改新欄位 = 0 列、值不變。
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000004');
update merchant_member_settings set earn_mode = 'basic', redeem_max_ratio_percent = 0
where merchant_id = 'db110000-0000-4000-8000-000000000020';
select pg_temp.test_clear_auth();
select is(
  (select row(earn_mode, redeem_max_ratio_percent)::text from merchant_member_settings
   where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  row('advanced', 50)::text,
  'B10 §2.8(核心):只有「會員管理」鑰匙的客服改不動新規則欄位(RLS 撈不到這一列,值維持 advanced / 50)'
);

-- =========================================================================
-- C. §1.2 merchant_point_formulas
--   🔴 紅利系統重構 批次 7(v2.4 裁決 21 ④)改寫:這張表收掉了 INSERT / UPDATE / DELETE 政策與表權限,
--   寫入一律走 upsert_member_point_formulas(SECURITY DEFINER)。所以 C1~C10 的「表層約束 / trigger」
--   測試改用 postgres 身分直接寫(測的是約束本身,跟誰在寫無關);C13 / C14 / C17 的「寫不進去」改成斷言
--   「直接寫表一律 42501」(錯誤訊息從 RLS 違規變成 permission denied);C18「紅利點數管理客服可以改、可以刪」
--   改走正規入口 upsert_member_point_formulas 驗證。讀取(C11 / C12 / C15 / C16)不變。
-- =========================================================================
select lives_ok(
  $$insert into merchant_point_formulas (id, merchant_id, name, service_item_id, min_unit_price, points_per_unit)
    values ('db110000-0000-4000-8000-0000000000f1', 'db110000-0000-4000-8000-000000000020', '公式 1',
            'db110000-0000-4000-8000-000000000031', 500, 10)$$,
  'C1 §1.2:可以新增「個別服務項目」公式(表層約束放行)'
);
select lives_ok(
  $$insert into merchant_point_formulas (id, merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-0000000000f2', 'db110000-0000-4000-8000-000000000020', '全部項目', null, 3)$$,
  'C2 §1.2(第 2 題定案 B):「全部服務項目」公式可以跟個別項目公式並存'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', '重複項目', 'db110000-0000-4000-8000-000000000031', 1)$$,
  '23505',
  'duplicate key value violates unique constraint "merchant_point_formulas_merchant_item_unique_idx"',
  'C3 §1.2(第三輪裁決 A):同一個服務項目不能被兩條公式設到,資料庫層就擋'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', '第二條全部', null, 1)$$,
  '23505',
  'duplicate key value violates unique constraint "merchant_point_formulas_merchant_all_items_unique_idx"',
  'C4 §1.2:「全部服務項目」公式一間商家最多一條'
);

select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', '偷掛別家項目', 'db110000-0000-4000-8000-000000000032', 1)$$,
  '23514',
  '公式指定的服務項目不屬於這間商家',
  'C5 §1.2(資安:跨商家):公式不能掛到別家商家的服務項目(直接打 PostgREST 寫表也擋得住)'
);
select throws_ok(
  $$update merchant_point_formulas set service_item_id = 'db110000-0000-4000-8000-000000000032'
    where id = 'db110000-0000-4000-8000-0000000000f1'$$,
  '23514',
  '公式指定的服務項目不屬於這間商家',
  'C6 §1.2(資安:跨商家):UPDATE 也不能把公式改掛到別家的服務項目'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', '   ', 'db110000-0000-4000-8000-000000000033', 1)$$,
  '23514',
  'new row for relation "merchant_point_formulas" violates check constraint "merchant_point_formulas_name_length_check"',
  'C7 §1.2:公式名稱不能是空白'
);
select throws_ok(
  format($$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', %L, 'db110000-0000-4000-8000-000000000033', 1)$$, repeat('名', 51)),
  '23514',
  'new row for relation "merchant_point_formulas" violates check constraint "merchant_point_formulas_name_length_check"',
  'C8 §1.2:公式名稱最多 50 字'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', '負點數', 'db110000-0000-4000-8000-000000000033', -1)$$,
  '23514',
  'new row for relation "merchant_point_formulas" violates check constraint "merchant_point_formulas_points_per_unit_check"',
  'C9 §1.2:每個數量獲得點數不可為負'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, min_unit_price, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', '負門檻', 'db110000-0000-4000-8000-000000000033', -1, 1)$$,
  '23514',
  'new row for relation "merchant_point_formulas" violates check constraint "merchant_point_formulas_min_unit_price_check"',
  'C10 §1.2:單項金額門檻不可為負'
);
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000001');
select is(
  (select count(*)::int from merchant_point_formulas where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  2,
  'C11 §1.2 RLS:商家管理員看得到自己店的 2 條公式'
);
select pg_temp.test_clear_auth();

-- 看不到 / 寫不進去的角色
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000004');
select is(
  (select count(*)::int from merchant_point_formulas),
  0,
  'C12 §2.8:只有「會員管理」鑰匙的客服讀不到公式(公式是規則,歸紅利點數管理)'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', 'M想新增', 'db110000-0000-4000-8000-000000000033', 1)$$,
  '42501',
  'permission denied for table merchant_point_formulas',
  'C13 §2.8:只有「會員管理」鑰匙的客服不能新增公式(批次 7 起直接寫表一律 permission denied)'
);
select throws_ok(
  $$delete from merchant_point_formulas where id = 'db110000-0000-4000-8000-0000000000f1'$$,
  '42501',
  'permission denied for table merchant_point_formulas',
  'C13b 批次 7:直接 DELETE 也是報錯(不是靜默 0 列)'
);
select pg_temp.test_clear_auth();
select ok(
  exists (select 1 from merchant_point_formulas where id = 'db110000-0000-4000-8000-0000000000f1'),
  'C14 §2.8:只有「會員管理」鑰匙的客服刪不掉公式'
);

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000003');
select is(
  (select count(*)::int from merchant_point_formulas),
  0,
  'C15 §2.8:只有「會員系統設定」鑰匙的客服也讀不到公式'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000006');
select is(
  (select count(*)::int from merchant_point_formulas where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  0,
  'C16(資安:跨商家):別家商家的管理員讀不到 A 店的公式'
);
select throws_ok(
  $$insert into merchant_point_formulas (merchant_id, name, service_item_id, points_per_unit)
    values ('db110000-0000-4000-8000-000000000020', 'B店管理員想寫A店', null, 1)$$,
  '42501',
  'permission denied for table merchant_point_formulas',
  'C17(資安:跨商家):別家商家的管理員不能替 A 店新增公式'
);
select pg_temp.test_clear_auth();

-- member_points 客服可以改、可以刪(批次 7 起走正規入口 upsert_member_point_formulas:
-- payload 只放 f1(停用 + 改掛 33)⇒ f1 更新、f2 不在清單裡 ⇒ 刪除)。
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000002');
select count(*) from upsert_member_point_formulas('db110000-0000-4000-8000-000000000020',
  '[{"id":"db110000-0000-4000-8000-0000000000f1","name":"公式 1","enabled":false,"service_item_id":"db110000-0000-4000-8000-000000000033","min_unit_price":500,"points_per_unit":10,"sort_order":1}]'::jsonb);
select pg_temp.test_clear_auth();
select is(
  (select array_agg(row(id, enabled, service_item_id)::text order by id)
   from merchant_point_formulas where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  array[row('db110000-0000-4000-8000-0000000000f1'::uuid, false, 'db110000-0000-4000-8000-000000000033'::uuid)::text],
  'C18 §1.2:紅利點數管理客服可以停用/改掛同店另一個項目、也可以刪除公式'
);

-- =========================================================================
-- D. §1.3 member_birthday_bonus_grants
-- =========================================================================
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000001');
select id from create_member('db110000-0000-4000-8000-000000000020', '生日測試會員', '0955110001') \gset bday_member_
select pg_temp.test_clear_auth();

-- 只由 service_role 函式寫入(批次 5);這裡以 postgres 身分直接布置 fixture。
insert into member_point_transactions (id, member_id, merchant_id, transaction_type, points_delta, balance_after)
values ('db110000-0000-4000-8000-0000000000a1', :'bday_member_id', 'db110000-0000-4000-8000-000000000020',
        'birthday_bonus', 20, 20);

select lives_ok(
  format($$insert into member_birthday_bonus_grants
    (id, merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot)
    values ('db110000-0000-4000-8000-0000000000b1', 'db110000-0000-4000-8000-000000000020', %L, 2026, '2026-02-28', 20,
            'db110000-0000-4000-8000-0000000000a1', '生日測試會員')$$, :'bday_member_id'),
  'D1 §1.3:寫入一筆生日發送紀錄'
);
select is(
  (select row(line_status, line_error, line_notification_log_id, line_attempted_at, granted_at is not null)::text
   from member_birthday_bonus_grants where id = 'db110000-0000-4000-8000-0000000000b1'),
  row('pending', null::text, null::uuid, null::timestamptz, true)::text,
  'D2 §1.3:預設 line_status = pending、granted_at 自動帶值、其餘 LINE 欄位為空'
);
select throws_ok(
  format($$insert into member_birthday_bonus_grants
    (merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot)
    values ('db110000-0000-4000-8000-000000000020', %L, 2026, '2026-02-28', 20,
            'db110000-0000-4000-8000-0000000000a1', '生日測試會員')$$, :'bday_member_id'),
  '23505',
  'duplicate key value violates unique constraint "member_birthday_bonus_grants_member_year_unique_idx"',
  'D3 §1.3(核心):同一位會員同一年第二筆 → 唯一索引擋下(這就是「每人每年只發一次」的硬性保證)'
);
select lives_ok(
  format($$insert into member_birthday_bonus_grants
    (merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot)
    values ('db110000-0000-4000-8000-000000000020', %L, 2027, '2027-02-28', 20,
            'db110000-0000-4000-8000-0000000000a1', '生日測試會員')$$, :'bday_member_id'),
  'D4 §1.3:同一位會員「隔年」可以再有一筆'
);
select throws_ok(
  format($$insert into member_birthday_bonus_grants
    (merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot)
    values ('db110000-0000-4000-8000-000000000020', %L, 2028, '2028-02-29', 0,
            'db110000-0000-4000-8000-0000000000a1', '生日測試會員')$$, :'bday_member_id'),
  '23514',
  'new row for relation "member_birthday_bonus_grants" violates check constraint "member_birthday_bonus_grants_points_check"',
  'D5 §1.3:points 必須 > 0(只有真的發出點數才寫紀錄)'
);
select throws_ok(
  $$update member_birthday_bonus_grants set line_status = 'queued' where id = 'db110000-0000-4000-8000-0000000000b1'$$,
  '23514',
  'new row for relation "member_birthday_bonus_grants" violates check constraint "member_birthday_bonus_grants_line_status_check"',
  'D6 §1.3:line_status 只允許五種值'
);

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000004');
select is((select count(*)::int from member_birthday_bonus_grants), 2,
  'D7 §1.3(第 10 題定案):「會員管理」鑰匙的客服看得到生日發送紀錄');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000002');
select is((select count(*)::int from member_birthday_bonus_grants), 2,
  'D8 §1.3(第 10 題定案):「紅利點數管理」鑰匙的客服也看得到生日發送紀錄');
select throws_ok(
  format($$insert into member_birthday_bonus_grants
    (merchant_id, member_id, bonus_year, anchor_date, points, point_transaction_id, member_name_snapshot)
    values ('db110000-0000-4000-8000-000000000020', %L, 2030, '2030-02-28', 99,
            'db110000-0000-4000-8000-0000000000a1', '偽造')$$, :'bday_member_id'),
  '42501',
  -- 批次 8 主腦裁決:表權限也收回了(20261001080000 第 6 段),所以先撞到的是表權限,不是 RLS。
  'permission denied for table member_birthday_bonus_grants',
  'D9 §1.3:沒有 INSERT 政策、也沒有 INSERT 表權限——連紅利點數管理客服也不能自己塞一筆生日紀錄'
);
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000003');
select is((select count(*)::int from member_birthday_bonus_grants), 0,
  'D10 §1.3:只有「會員系統設定」鑰匙的客服看不到生日發送紀錄');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000006');
select is((select count(*)::int from member_birthday_bonus_grants), 0,
  'D11(資安:跨商家):別家商家的管理員看不到 A 店的生日發送紀錄');
select pg_temp.test_clear_auth();

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000001');
-- 批次 8 主腦裁決:表權限收回後,直接改 / 刪是 42501 報錯(不再是「靜默 0 列」)。
select throws_ok(
  $$update member_birthday_bonus_grants set points = 999 where id = 'db110000-0000-4000-8000-0000000000b1'$$,
  '42501', 'permission denied for table member_birthday_bonus_grants',
  'D12a:商家管理員直接 UPDATE 生日發送紀錄 ⇒ 42501'
);
select throws_ok(
  $$delete from member_birthday_bonus_grants where id = 'db110000-0000-4000-8000-0000000000b1'$$,
  '42501', 'permission denied for table member_birthday_bonus_grants',
  'D12b:商家管理員直接 DELETE 生日發送紀錄 ⇒ 42501'
);
select pg_temp.test_clear_auth();
select is(
  (select points from member_birthday_bonus_grants where id = 'db110000-0000-4000-8000-0000000000b1'),
  20,
  'D12 §1.3:沒有 UPDATE/DELETE 政策與表權限——連商家管理員也改不動、刪不掉生日發送紀錄(值仍是 20)'
);

-- =========================================================================
-- E. §1.4 bookings 7 個新欄位
-- =========================================================================
select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'db110000-0000-4000-8000-000000000020',
  p_staff_id => 'db110000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','db110000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-15 10:00:00+08',
  p_customer_name => '紅利欄位測試客',
  p_customer_phone => '0955110002',
  p_payment_method_id => 'db110000-0000-4000-8000-000000000071'
) \gset bk_
select pg_temp.test_clear_auth();

-- 紅利系統重構 批次 3 起 create_booking 會寫派點快照:這間商家此時是進階模式、沒有任何公式 ⇒
-- 派點 0,但 breakdown 會是引擎產生的逐項明細(不再是空陣列)。這條改成比對「數字欄位」+
-- 「breakdown 是陣列」;派點/折抵的完整行為由 module10_13 負責。
select is(
  (select row(points_planned, points_planned_auto, points_planned_overridden, points_review_required,
              jsonb_typeof(points_planned_breakdown), points_redeemed, points_redeem_amount_snapshot)::text
   from bookings where id = :'bk_id'::uuid),
  row(0, 0, false, false, 'array', 0, 0.00)::text,
  'E1 §1.4:不帶新參數建單(商家沒有派點規則)⇒ 派點 0、未覆寫、不需人工確認、沒有折抵;breakdown 是陣列'
);
select isnt(
  (select member_id from bookings where id = :'bk_id'::uuid),
  null,
  'E2 fixture 前提:這張單有連結會員(#912 依電話自動建立),下面的折抵 CHECK 正例才有意義'
);

select throws_ok(
  format($$update bookings set points_planned = -1 where id = %L$$, :'bk_id'),
  '23514',
  'new row for relation "bookings" violates check constraint "bookings_points_planned_check"',
  'E3 §1.4:預定派點不可為負'
);
select throws_ok(
  format($$update bookings set points_planned_auto = -1 where id = %L$$, :'bk_id'),
  '23514',
  'new row for relation "bookings" violates check constraint "bookings_points_planned_auto_check"',
  'E4 §1.4:系統建議派點不可為負'
);
select throws_ok(
  format($$update bookings set points_redeemed = 10, points_redeem_amount_snapshot = 0 where id = %L$$, :'bk_id'),
  '23514',
  'new row for relation "bookings" violates check constraint "bookings_points_redeem_amount_consistent"',
  'E5 §1.4:有折抵點數但折抵金額是 0 → 擋下(兩者要同時為 0 或同時不為 0)'
);
select throws_ok(
  format($$update bookings set points_redeemed = 0, points_redeem_amount_snapshot = 5 where id = %L$$, :'bk_id'),
  '23514',
  'new row for relation "bookings" violates check constraint "bookings_points_redeem_amount_consistent"',
  'E6 §1.4:折抵金額不是 0 但折抵點數是 0 → 擋下'
);
select throws_ok(
  format($$update bookings set points_redeemed = 10, points_redeem_amount_snapshot = 1, member_id = null where id = %L$$, :'bk_id'),
  '23514',
  '這筆訂單沒有連結會員，不能使用紅利點數折抵',
  'E7 §1.4 + v2.4 裁決 2(UPDATE 面):把訂單改成「有折抵但沒有會員」→ 新 trigger 擋下,白話訊息逐字正確'
);
select lives_ok(
  format($$update bookings set points_redeemed = 10, points_redeem_amount_snapshot = 1, points_planned = 12, points_planned_auto = 10, points_planned_overridden = true where id = %L$$, :'bk_id'),
  'E8 §1.4(正例):有會員 + 折抵 10 點 / 1 元 + 覆寫派點 12 點,可以存'
);
select is(
  (select final_amount_snapshot from bookings where id = :'bk_id'::uuid),
  1000.00,
  'E9 §1.4(第 3 題定案 A):寫了折抵金額,final_amount_snapshot 仍是折抵前的 1000(資料庫不會自己扣)'
);
select throws_ok(
  format($$update bookings set points_redeemed = -1, points_redeem_amount_snapshot = 1 where id = %L$$, :'bk_id'),
  '23514',
  'new row for relation "bookings" violates check constraint "bookings_points_redeemed_check"',
  'E10 §1.4(v2.4 補測):折抵點數不可為負'
);
select throws_ok(
  format($$update bookings set points_redeemed = 5, points_redeem_amount_snapshot = -1 where id = %L$$, :'bk_id'),
  '23514',
  'new row for relation "bookings" violates check constraint "bookings_points_redeem_amount_snapshot_check"',
  'E11 §1.4(v2.4 補測):折抵金額不可為負'
);
-- INSERT 面:複製一張既有訂單當模板,換新 id、拿掉會員、帶折抵 → 必須被擋。
create temp table bk_copy as select * from bookings where id = :'bk_id'::uuid;
update bk_copy set id = gen_random_uuid(), member_id = null, points_redeemed = 10, points_redeem_amount_snapshot = 1;
select throws_ok(
  $$insert into bookings select * from bk_copy$$,
  '23514',
  '這筆訂單沒有連結會員，不能使用紅利點數折抵',
  'E12 §1.4 + v2.4 裁決 2(INSERT 面):直接新增一張「有折抵但沒有會員」的訂單 → 新 trigger 擋下'
);

-- =========================================================================
-- F. §1.5 transaction_type 十種;唯一索引只保留既有那一支
-- =========================================================================
select lives_ok(
  format($$insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id)
    values
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'referral_repeat_bonus', 5, 25, %2$L),
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'redeem_booking', -10, 15, %2$L),
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'redeem_booking_refund', 10, 25, %2$L),
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'earn_booking_reversal', -5, 20, %2$L),
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'referral_bonus_reversal', -5, 15, %2$L)$$,
    :'bday_member_id', :'bk_id'),
  'F1 §1.5:五種新的交易類型都可以寫入'
);
select lives_ok(
  format($$insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id)
    values
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'earn_booking_reversal', -1, 14, %2$L),
      (%1$L, 'db110000-0000-4000-8000-000000000020', 'referral_repeat_bonus', 1, 15, %2$L)$$,
    :'bday_member_id', :'bk_id'),
  'F2 §1.5(v2.1 定案):新類型**沒有**「每單一筆」唯一索引,同一張單第二筆可以寫(冪等改由函式內淨額判斷負責)'
);
select throws_ok(
  format($$insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after)
    values (%L, 'db110000-0000-4000-8000-000000000020', 'cashback', 1, 16)$$, :'bday_member_id'),
  '23514',
  'new row for relation "member_point_transactions" violates check constraint "member_point_transactions_transaction_type_check"',
  'F3 §1.5:清單外的類型仍被擋'
);
select is(
  (select array_agg(indexname::text order by indexname) from pg_indexes
   where schemaname = 'public' and tablename = 'member_point_transactions' and indexdef ilike '%unique%'),
  -- #844 migration C(20261001090200)改寫:原斷言「earn_booking 每單一筆唯一索引保留」在 migration C
  -- 移除該索引後已不成立(冪等改由 compute_member_loyalty_points 鎖會員列後的淨額判斷負責,見 module17_02)。
  -- 本條原本要守的另一半「批次 1 沒有新增任何唯一索引」照守:現在只剩主鍵。
  array['member_point_transactions_pkey'],
  'F4 §1.5(§〇.3 判斷 11 + #844 migration C):分類帳只剩主鍵一支唯一索引 —— earn_booking 每單一筆索引已由 #844 移除,新類型也沒有新增任何唯一索引'
);
select throws_ok(
  format($$insert into member_point_transactions (member_id, merchant_id, transaction_type, points_delta, balance_after)
    values (%L, 'db110000-0000-4000-8000-000000000020', 'earn_booking_reversal', -99, -1)$$, :'bday_member_id'),
  '23514',
  'new row for relation "member_point_transactions" violates check constraint "member_point_transactions_balance_after_check"',
  'F5 §1.5(第 1 題定案 A):balance_after >= 0 這道 CHECK 沒有被放寬'
);

-- =========================================================================
-- G. §1.6 line_notification_log.event_type
-- =========================================================================
select lives_ok(
  $$insert into line_notification_log (merchant_id, event_type, target_type, status)
    values ('db110000-0000-4000-8000-000000000020', 'birthday_bonus', 'member', 'skipped')$$,
  'G1 §1.6:LINE 發送紀錄允許 event_type = birthday_bonus'
);
select throws_ok(
  $$insert into line_notification_log (merchant_id, event_type, target_type, status)
    values ('db110000-0000-4000-8000-000000000020', 'birthday', 'member', 'skipped')$$,
  '23514',
  'new row for relation "line_notification_log" violates check constraint "line_notification_log_event_type_check"',
  'G2 §1.6:清單外的事件類型仍被擋'
);

-- =========================================================================
-- I. v2.4 裁決 1/2:會員被硬刪時,折抵訂單與生日紀錄都不能讓刪除失敗,且折抵數字原樣保留
--    (#848 報表要靠 points_redeem_amount_snapshot 算歷史折抵金額)
-- =========================================================================
insert into auth.users (id, email) values
  ('db110000-0000-4000-8000-000000000008', 'pgtap-m1011-platform@test.local');
insert into platform_admins (user_id) values ('db110000-0000-4000-8000-000000000008');

select pg_temp.test_set_auth('db110000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'db110000-0000-4000-8000-000000000020',
  p_staff_id => 'db110000-0000-4000-8000-000000000041',
  p_service_items => jsonb_build_array(jsonb_build_object(
    'service_item_id','db110000-0000-4000-8000-000000000031','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-16 10:00:00+08',
  p_customer_name => '硬刪會員測試客',
  p_customer_phone => '0955110003',
  p_payment_method_id => 'db110000-0000-4000-8000-000000000071'
) \gset bk2_
select pg_temp.test_clear_auth();
select member_id as bk2_member_id from bookings where id = :'bk2_id'::uuid \gset
update bookings set points_redeemed = 20, points_redeem_amount_snapshot = 2 where id = :'bk2_id'::uuid;

select lives_ok(
  format($$delete from members where id = %L$$, :'bk2_member_id'),
  'I1 v2.4 裁決 2:單一會員硬刪除成功——他有一張折抵 20 點的訂單,外鍵把 member_id 自動清空時不會被擋'
);
select is(
  (select row(member_id, points_redeemed, points_redeem_amount_snapshot)::text from bookings where id = :'bk2_id'::uuid),
  row(null::uuid, 20, 2.00)::text,
  'I2 v2.4 裁決 2:會員被硬刪後,訂單的 member_id 變成空,但折抵 20 點 / 2 元原樣保留(不回頭改數字)'
);

-- #1051:平台批次清除函式已移除;這裡直接用它原本的兩句刪除重現「清空 A 店會員與點數」,驗證的是外鍵行為。
delete from member_point_transactions where merchant_id = 'db110000-0000-4000-8000-000000000020';
select lives_ok(
  $$delete from members where merchant_id = 'db110000-0000-4000-8000-000000000020'$$,
  'I3 v2.4 裁決 1/2(核心):清除 A 店全部會員與點數成功——A 店同時有生日發送紀錄(2 筆)與折抵訂單,兩者都不能讓清除失敗'
);
select pg_temp.test_clear_auth();
select is(
  (select row(member_id, points_redeemed, points_redeem_amount_snapshot)::text from bookings where id = :'bk_id'::uuid),
  row(null::uuid, 10, 1.00)::text,
  'I4 v2.4 裁決 2:清除後折抵訂單的 member_id 清空,折抵 10 點 / 1 元原樣保留'
);
select is(
  (select count(*)::int from member_birthday_bonus_grants where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  0,
  'I5 v2.4 裁決 1:分類帳被清掉後,對應的生日發送紀錄跟著刪除(on delete cascade),不再擋住清除'
);
select is(
  (select count(*)::int from members where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  0,
  'I6:A 店會員真的清空了'
);

-- =========================================================================
-- J. §1.1 回填結果(v2.4 補測)
--    migration 是在空的本機庫上跑的,回填當下沒有資料可驗。這裡在交易內重現「套用前」的狀態:
--    先布置三種既有列,把兩個新開關欄位拿掉,再逐字重跑 migration 20261001020000 的
--    add column(去掉 comment)+ 回填兩句,最後驗結果。
--    ⚠️ 下面的回填兩句必須跟 migration 檔保持逐字一致,改 migration 時要一起改。
-- =========================================================================
update merchant_member_settings set referral_bonus_points = 0, birthday_bonus_points = 0
where merchant_id = 'db110000-0000-4000-8000-000000000020';
update merchant_member_settings set referral_bonus_points = 20, birthday_bonus_points = 30
where merchant_id = 'db110000-0000-4000-8000-000000000022';
update merchant_member_settings set referral_bonus_points = 5, birthday_bonus_points = 0
where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid;

alter table public.merchant_member_settings drop column referral_inviter_reward_enabled;
alter table public.merchant_member_settings drop column birthday_bonus_enabled;

alter table public.merchant_member_settings
  add column referral_inviter_reward_enabled boolean not null default false;
alter table public.merchant_member_settings
  add column birthday_bonus_enabled boolean not null default false;

update public.merchant_member_settings
set referral_inviter_reward_enabled = true
where referral_bonus_points > 0;

update public.merchant_member_settings
set birthday_bonus_enabled = true
where birthday_bonus_points > 0;

select is(
  (select row(referral_inviter_reward_enabled, birthday_bonus_enabled)::text from merchant_member_settings
   where merchant_id = 'db110000-0000-4000-8000-000000000022'),
  row(true, true)::text,
  'J1 §1.1 回填:原本推薦 20 點、生日 30 點的商家 ⇒ 開關 1 與生日開關都回填成 true(既有行為零改變)'
);
select is(
  (select row(referral_inviter_reward_enabled, birthday_bonus_enabled)::text from merchant_member_settings
   where merchant_id = 'db110000-0000-4000-8000-000000000020'),
  row(false, false)::text,
  'J2 §1.1 回填:兩個點數都是 0 的商家(= 正式庫兩間真實商家的狀況)⇒ 兩個開關都是 false'
);
select is(
  (select row(referral_inviter_reward_enabled, birthday_bonus_enabled)::text from merchant_member_settings
   where merchant_id = :'onboarding_merchant_create_group_and_merchant'::uuid),
  row(true, false)::text,
  'J3 §1.1 回填:只有推薦點數 > 0 的商家 ⇒ 只有推薦開關是 true,兩個回填各看各的欄位'
);

-- =========================================================================
-- H. 權限衛生
-- =========================================================================
select ok(
  (select relrowsecurity from pg_class where oid = 'public.merchant_point_formulas'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.member_birthday_bonus_grants'::regclass),
  'H1 資安:兩張新表都開了 RLS'
);
select ok(
  not has_function_privilege('anon', 'private.check_point_formula_service_item_merchant()', 'execute')
  and not has_function_privilege('authenticated', 'private.check_point_formula_service_item_merchant()', 'execute')
  and not has_function_privilege('public', 'private.check_point_formula_service_item_merchant()', 'execute'),
  'H2 資安(supabase-permission-hygiene 規則 1):新的 trigger 函式 anon / authenticated / PUBLIC 都沒有 EXECUTE'
);
select is(
  (select array_agg(polname::text order by polname) from pg_policy
   where polrelid = 'public.member_birthday_bonus_grants'::regclass),
  array['member_birthday_bonus_grants_select'],
  'H3 資安:生日發送紀錄只有一條 SELECT 政策,沒有任何寫入政策'
);
select ok(
  not has_function_privilege('anon', 'private.check_booking_points_redeemed_requires_member()', 'execute')
  and not has_function_privilege('authenticated', 'private.check_booking_points_redeemed_requires_member()', 'execute')
  and not has_function_privilege('public', 'private.check_booking_points_redeemed_requires_member()', 'execute'),
  'H4 資安(v2.4):訂單折抵要連會員的 trigger 函式 anon / authenticated / PUBLIC 都沒有 EXECUTE'
);
select ok(
  not exists (select 1 from pg_constraint where conname = 'bookings_points_redeemed_requires_member'),
  'H5 v2.4 裁決 2:表層 CHECK bookings_points_redeemed_requires_member 已不存在(改由 trigger 在寫入時檢查)'
);

select * from finish();

rollback;
