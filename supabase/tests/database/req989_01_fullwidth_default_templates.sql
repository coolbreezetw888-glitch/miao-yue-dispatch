-- SPECS-INDEX #989 第 11 批 B 項:預設文案改全形(只改新的,既有資料不回填)
-- migration 20261007140100_b11_b_fullwidth_default_templates.sql
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §2。
--
-- 測的東西:
--   ① 新商家走真正的開店流程(create_group_and_merchant,以一般登入者身分)仍然成功(回歸)。
--      ※ 開店者本身就是新商家的管理員(有紅利權限),所以 B-7 / B-8 不同步時這條不會紅;
--        真正會被擋的是「沒有紅利權限的人寫入預設列」,由 ③ 守住(故障注入已確認 ③ 會紅)。
--   ② 新商家的 LINE 5 則預設文案、推播 booking_updated 內文、生日 LINE 文案都是全形版
--   ③ B-8 比對字串真的換成新版:沒有紅利權限的人 INSERT 時明確帶「舊版」生日文案 ⇒ 被當成改規則擋下;
--      帶「新版」⇒ 放行(證明觸發器認的預設值 = 欄位預設值)
--   ④ 既有商家不回填:migration 前就存在的舊文案列不會被改(本交易內模擬)
--   ⑤ 紅利退回備註(refund_booking_redeem)兩句是全形版
--   ⑥ 權限屬性不變:四支函式 security definer + search_path=public,ACL 跟改前一致
begin;

select plan(14);

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

insert into auth.users (id, email) values
  ('e9890000-0000-4000-8000-000000000001', 'pgtap-req989-onboarding@test.local'),
  ('e9890000-0000-4000-8000-000000000002', 'pgtap-req989-stranger@test.local');

-- ① 真正的開店流程(一般登入者)
select pg_temp.test_set_auth('e9890000-0000-4000-8000-000000000001');
select lives_ok(
  $$select public.create_group_and_merchant('第11批全形預設文案測試店', 'in_store_beauty')$$,
  '① 一般登入者走 create_group_and_merchant 開新店成功(回歸)'
);
select pg_temp.test_clear_auth();

create temp table req989_m as
  select m.id from public.merchants m where m.name = '第11批全形預設文案測試店';

select is((select count(*)::int from req989_m), 1, '① 新商家只建立一間');

-- ② 新商家的預設文案
select is(
  (select array_agg(event_type || '=' || message_template order by event_type)
   from public.merchant_line_event_settings where merchant_id = (select id from req989_m)),
  array[
    'booking_cancelled=【{{merchant_name}}】您的預約已取消：{{booking_date}}、服務項目：{{service_names}}。取消原因：{{cancel_reason}}。',
    'booking_completed=【{{merchant_name}}】感謝您的光臨！本次服務：{{service_names}}，本次獲得 {{points_earned}} 點。',
    'booking_confirmed=【{{merchant_name}}】您的預約已確認：{{booking_date}}、服務項目：{{service_names}}、服務人員：{{staff_name}}。',
    'booking_created=【{{merchant_name}}】有新的預約：{{customer_name}} 於 {{booking_date}} 預約 {{service_names}}，金額 {{final_amount}} 元。',
    'staff_leave_created=【{{merchant_name}}】{{staff_name}} 登記了一筆請假：{{booking_date}}。'
  ]::text[],
  '② B-1~B-5:新商家的 LINE 5 則預設文案逐字是全形版'
);
select is(
  (select message_body from public.merchant_push_event_settings
   where merchant_id = (select id from req989_m) and event_type = 'booking_updated'),
  '{{booking_date}} {{customer_name}}：{{change_summary}}',
  '② B-6:新商家的推播 booking_updated 預設內文是全形冒號'
);
select is(
  (select array_agg(message_body order by event_type) from public.merchant_push_event_settings
   where merchant_id = (select id from req989_m) and event_type <> 'booking_updated'),
  array[
    '{{booking_date}} {{customer_name}} 的預約已取消',
    '{{booking_date}} {{customer_name}}‧{{service_names}}',
    '{{booking_date}} {{customer_name}}‧{{service_names}}'
  ]::text[],
  '② 其他三則推播預設內文不變(本來就沒有半形標點)'
);
select is(
  (select birthday_line_message from public.merchant_member_settings where merchant_id = (select id from req989_m)),
  '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。',
  '② B-7:新商家的生日 LINE 預設文案是全形逗號'
);
select is(
  (select column_default from information_schema.columns
   where table_schema = 'public' and table_name = 'merchant_member_settings' and column_name = 'birthday_line_message'),
  $d$'生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。'::text$d$,
  '② B-7:欄位預設值是全形版'
);

-- ③ B-8 比對字串:用一個跟任何商家都無關的登入者身分(沒有紅利權限)直接 INSERT。
--    以 postgres 身分執行(繞過 RLS,只看觸發器),但 request.jwt.claims 設成 authenticated,
--    觸發器裡的 auth.role() / private.can_manage_member_points() 會把他當成沒有權限的一般使用者。
insert into public.groups (id) values ('e9890000-0000-4000-8000-000000000011');
insert into public.merchants (id, group_id, name, industry_type) values
  ('e9890000-0000-4000-8000-000000000021', 'e9890000-0000-4000-8000-000000000011', '第11批觸發器測試店甲', 'in_store_beauty'),
  ('e9890000-0000-4000-8000-000000000022', 'e9890000-0000-4000-8000-000000000011', '第11批觸發器測試店乙', 'in_store_beauty'),
  ('e9890000-0000-4000-8000-000000000023', 'e9890000-0000-4000-8000-000000000011', '第11批觸發器測試店丙', 'in_store_beauty');
delete from public.merchant_member_settings
where merchant_id in ('e9890000-0000-4000-8000-000000000021', 'e9890000-0000-4000-8000-000000000022',
                      'e9890000-0000-4000-8000-000000000023');

select set_config('request.jwt.claims',
  json_build_object('sub', 'e9890000-0000-4000-8000-000000000002', 'role', 'authenticated')::text, true);
select lives_ok(
  $$insert into public.merchant_member_settings (merchant_id) values ('e9890000-0000-4000-8000-000000000021')$$,
  '③ 沒有紅利權限的人只帶 merchant_id INSERT(吃欄位預設值)⇒ 放行'
);
select lives_ok(
  $$insert into public.merchant_member_settings (merchant_id, birthday_line_message)
    values ('e9890000-0000-4000-8000-000000000022', '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。')$$,
  '③ 明確帶「新版(全形)」預設文案 ⇒ 觸發器認得是預設值,放行'
);
select throws_ok(
  $$insert into public.merchant_member_settings (merchant_id, birthday_line_message)
    values ('e9890000-0000-4000-8000-000000000023', '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。')$$,
  '42501', null,
  '③ 明確帶「舊版(半形)」文案 ⇒ 已經不是預設值,沒有紅利權限被擋(證明 B-8 比對字串跟 B-7 同步換新)'
);
select set_config('request.jwt.claims', '', true);

-- ④ 既有商家不回填:migration 沒有 UPDATE,舊文案列維持原樣(本交易內模擬一列「舊商家」資料)
update public.merchant_member_settings
set birthday_line_message = '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。'
where merchant_id = 'e9890000-0000-4000-8000-000000000021';
select is(
  (select birthday_line_message from public.merchant_member_settings where merchant_id = 'e9890000-0000-4000-8000-000000000021'),
  '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。',
  '④ 既有的舊版生日文案可以照常存在(沒有 CHECK 或觸發器強制改寫)'
);

-- ⑤ 紅利退回備註
select ok(
  (select prosrc like '%''訂單取消，退回紅利折抵 %s 點''%'
          and prosrc like '%''訂單編輯變更了會員或折抵點數，先退回原本的紅利折抵 %s 點''%'
          and prosrc not like '%訂單取消,退回%'
          and prosrc not like '%折抵點數,先退回%'
   from pg_proc where oid = 'private.refund_booking_redeem'::regproc),
  '⑤ B-9 / B-10:紅利退回備註兩句都是全形逗號'
);

-- ⑥ 權限屬性不變
select is(
  (select array_agg(n.nspname || '.' || p.proname || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, 'NULL')
                    || '|' || coalesce(p.proacl::text, 'NULL') order by n.nspname, p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where (n.nspname, p.proname) in (('public', 'seed_default_line_event_settings'),
                                    ('public', 'seed_default_push_event_settings'),
                                    ('private', 'protect_merchant_member_settings_rule_columns'),
                                    ('private', 'refund_booking_redeem'))),
  array[
    'private.protect_merchant_member_settings_rule_columns|true|{search_path=public}|NULL',
    'private.refund_booking_redeem|true|{search_path=public}|{postgres=X/postgres}',
    'public.seed_default_line_event_settings|true|{search_path=public}|{postgres=X/postgres,service_role=X/postgres}',
    'public.seed_default_push_event_settings|true|{search_path=public}|{postgres=X/postgres,service_role=X/postgres}'
  ]::text[],
  '⑥ 四支重建的函式:security definer、search_path=public、ACL 跟改前(正式庫 2026-10-07 唯讀查詢)一致'
);
select is(
  (select array_agg(t.tgname::text || ':' || t.tgenabled::text)
   from pg_trigger t where t.tgfoid = 'private.protect_merchant_member_settings_rule_columns'::regproc and not t.tgisinternal),
  array['merchant_member_settings_protect_rule_columns:O']::text[],
  '⑥ 保護觸發器綁定不變'
);

select * from finish();
rollback;
