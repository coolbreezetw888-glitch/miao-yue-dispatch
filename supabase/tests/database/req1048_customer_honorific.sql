-- #1048 客戶端稱呼統一用「您」(資料庫那半)
-- 規格書 .project/specs/客戶端用語統一您.md
--
--   H01  LINE 通知客人預設文案 13 個範本:到府 / 非到府都沒有「你 / 妳」;逐字對齊前端 CUSTOMER_LINE_DEFAULT_TEMPLATES
--   H02  有 {{merchant_phone}} 的句子仍自己一行(R5)
--   H03  完成頁預設句(會員 3 句 + 訪客 1 句)用「您」
--   H04  權限沒變(proacl、security definer、search_path)
begin;
select plan(13);

-- H01
select is((select count(*)::int from jsonb_object_keys(private.customer_line_default_templates(false))), 13, 'H01-1 範本數量仍是 13');
select is((select count(*)::int from jsonb_each_text(private.customer_line_default_templates(false)) d where d.value ~ '[你妳]'), 0,
          'H01-2 非到府預設文案沒有「你 / 妳」');
select is((select count(*)::int from jsonb_each_text(private.customer_line_default_templates(true)) d where d.value ~ '[你妳]'), 0,
          'H01-3 到府預設文案沒有「你 / 妳」');
select is(private.customer_line_default_templates(false),
  jsonb_build_object(
    'submitted_pending', E'「{{merchant_name}}」已收到您的預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n店家確認後會再用 LINE 通知您。\n查看預約：{{member_center_url}}',
    'submitted_accepted', E'「{{merchant_name}}」預約成功：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}',
    'scheduled_by_store', E'「{{merchant_name}}」已為您安排預約：\n{{booking_date}} {{booking_time}}\n{{service_items}}\n查看預約：{{member_center_url}}',
    'confirmed', E'「{{merchant_name}}」已確認您的預約：\n{{booking_date}} {{booking_time}}\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}',
    'rescheduled', E'「{{merchant_name}}」調整了您的預約時間：\n原本：{{old_booking_date}} {{old_booking_time}}\n改為：{{booking_date}} {{booking_time}}\n如果時間不方便，請聯絡店家：{{merchant_phone}}',
    'cancelled_by_store', E'「{{merchant_name}}」取消了您 {{booking_date}} {{booking_time}} 的預約。\n有問題請聯絡店家：{{merchant_phone}}',
    'cancelled_by_customer', '您在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。',
    'reminder', E'提醒您：{{booking_day_word}} {{booking_time}} 在「{{merchant_name}}」有預約。\n{{service_items}}\n查看預約：{{member_center_url}}',
    'completed', E'謝謝您今天光臨「{{merchant_name}}」！\n查看紀錄：{{member_center_url}}',
    'contact_request', '{{contact_name}} 申請成為您在「{{merchant_name}}」會員的聯絡人，請到會員中心同意或拒絕：{{member_center_url}}',
    'contact_removed', '您已不是「{{merchant_name}}」會員「{{member_name}}」的聯絡人，之後不會再收到這位會員的預約通知。',
    'contact_approved', '您已成為「{{merchant_name}}」會員「{{member_name}}」的聯絡人，可以到會員中心查看預約：{{member_center_url}}',
    'contact_rejected', E'您申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。\n有問題請聯絡店家：{{merchant_phone}}'
  ),
  'H01-4 非到府 13 個範本逐字對齊前端');
select is(private.customer_line_default_templates(true) ->> 'confirmed',
          E'「{{merchant_name}}」已確認您的預約：\n{{booking_date}} {{booking_time}}（預計抵達時間）\n服務人員：{{staff_name}}\n查看或取消：{{member_center_url}}',
          'H01-5 到府版仍在時間後面加「（預計抵達時間）」');

-- H02
select is((select count(*)::int
           from jsonb_each_text(private.customer_line_default_templates(false)) d,
                regexp_split_to_table(d.value, E'\n') l
           where l like '%{{merchant_phone}}%' and l not in ('有問題請聯絡店家：{{merchant_phone}}', '如果時間不方便，請聯絡店家：{{merchant_phone}}')),
          0, 'H02-1 有 {{merchant_phone}} 的句子都自己一行');

-- H03(用不存在的商家:LINE 不能用 ⇒ 不說「用 LINE」)
select is(private.default_member_completion_message(gen_random_uuid(), 'accepted'), '服務前店家可能會再跟您聯絡確認。', 'H03-1 會員直接成立預設句');
select is(private.default_member_completion_message(gen_random_uuid(), 'pending_confirmation'), '店家確認後會通知您。', 'H03-2 會員待確認預設句');
select ok(position('店家確認後會用 LINE 通知您。' in pg_get_functiondef('private.default_member_completion_message(uuid,text)'::regprocedure)) > 0
          and pg_get_functiondef('private.default_member_completion_message(uuid,text)'::regprocedure) !~ '[你妳]',
          'H03-3 會員 LINE 版預設句用「您」、函式內沒有「你 / 妳」');
select ok(position('店家確認後會與您聯絡。' in pg_get_functiondef('private.customer_booking_result(uuid)'::regprocedure)) > 0
          and pg_get_functiondef('private.customer_booking_result(uuid)'::regprocedure) !~ '[你妳]',
          'H03-4 訪客完成頁預設句用「您」、函式內沒有「你 / 妳」');

-- H04
select is((select proacl::text from pg_proc where oid = 'private.customer_booking_result(uuid)'::regprocedure),
          '{postgres=X/postgres,service_role=X/postgres}', 'H04-1 customer_booking_result 權限不變');
select is((select array_agg(proacl::text order by proname) from pg_proc
           where oid in ('private.default_member_completion_message(uuid,text)'::regprocedure, 'private.customer_line_default_templates(boolean)'::regprocedure)),
          array['{postgres=X/postgres}', '{postgres=X/postgres}'], 'H04-2 另外兩支權限不變');
select is((select array_agg(prosecdef::text || ':' || array_to_string(proconfig, ',') order by proname) from pg_proc
           where oid in ('private.customer_booking_result(uuid)'::regprocedure, 'private.customer_line_default_templates(boolean)'::regprocedure,
                         'private.default_member_completion_message(uuid,text)'::regprocedure)),
          array['true:search_path=public', 'false:search_path=public', 'true:search_path=public'], 'H04-3 security definer / search_path 不變');

select * from finish();
rollback;
