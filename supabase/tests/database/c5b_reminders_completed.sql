-- 客戶端第 5-B 批 — 服務前提醒(C5-N07 / N12)、服務完成(C5-N08)
-- 規格書 .project/specs/客戶端第5批-LINE通知與綁定.md(零之零:Q1=A 提醒 / 完成預設關;Q2=A 服務前 N 小時、22:00~08:00 不發)
--
--   N12  固定「現在時間」(private.enqueue_customer_line_reminders_at):剛好進範圍、超出範圍、離開始不到 1 小時、
--        剛約的單、待確認、匯入、沒會員、別店沒開提醒、深夜不寫 / 08:00 補寫、同一個開始時間只提醒一次、
--        改時間後再提醒新時間、取消後不提醒、停發中不寫、排程存在
--   N07  prepare:照常準備(不再標 skipped)、booking_day_word、開始時間變了 / 已開始 / 不是已確認 ⇒ stale、提醒不套 6 小時過時
--   N08  trigger:完成 ⇒ 一筆;店家沒開 ⇒ 0;服務人員按完成也發;還原不發「確認」;匯入不發;prepare 還原後 ⇒ stale
--   X01  新函式 proacl
begin;

select plan(56);

create function pg_temp.err(p_sql text)
returns text language plpgsql as $$
declare v_hint text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_hint = pg_exception_hint;
  return sqlstate || ':' || coalesce(v_hint, '');
end $$;

-- 台北時間字串 ⇒ timestamptz
create function pg_temp.tp(p text)
returns timestamptz language sql as $$ select (p::timestamp at time zone 'Asia/Taipei') $$;

create function pg_temp.reminders(p_booking uuid)
returns text[] language sql as $$
  select coalesce(array_agg(status || ':' || coalesce(last_error, '') order by created_at, id), array[]::text[])
  from public.customer_line_outbox where booking_id = p_booking and kind = 'customer_reminder'
$$;

create function pg_temp.kinds(p_booking uuid)
returns text[] language sql as $$
  select coalesce(array_agg(kind order by kind), array[]::text[]) from public.customer_line_outbox where booking_id = p_booking
$$;

-- =========================================================================
-- Fixture:A 店(提醒 24 小時、完成開)、B 店(全部預設 ⇒ 提醒 / 完成關)、C 店(提醒 12 小時)
-- =========================================================================
insert into auth.users (id, email, raw_app_meta_data) values
  ('c5c00000-0000-4000-8000-000000000001', 'pgtap-c5c-admin@test.local', '{}'::jsonb),
  ('c5c00000-0000-4000-8000-000000000003', 'pgtap-c5c-staff@test.local', '{}'::jsonb),
  ('c5c00000-0000-4000-8000-000000000011', 'line-pgtap-c5c-11@customer.miaoyue.invalid', '{"account_type":"customer"}'::jsonb);

insert into groups (id) values ('c5c00000-0000-4000-8000-000000000091');
insert into merchants (id, group_id, name, industry_type, booking_slug, status, phone) values
  ('c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000091', 'C5C提醒店', 'in_store_beauty', 'pgtap-c5c-a', 'active', '0223456789'),
  ('c5c00000-0000-4000-8000-000000000032', 'c5c00000-0000-4000-8000-000000000091', 'C5C預設店', 'in_store_beauty', 'pgtap-c5c-b', 'active', null),
  ('c5c00000-0000-4000-8000-000000000033', 'c5c00000-0000-4000-8000-000000000091', 'C5C十二小時店', 'in_store_beauty', 'pgtap-c5c-c', 'active', null);
insert into merchant_admins (merchant_id, user_id) values
  ('c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000001');
insert into merchant_staff (id, merchant_id, name, status, login_status, phone, user_id) values
  ('c5c00000-0000-4000-8000-000000000051', 'c5c00000-0000-4000-8000-000000000031', 'C5C服務人員', 'active', 'not_invited', '0900530051', 'c5c00000-0000-4000-8000-000000000003'),
  ('c5c00000-0000-4000-8000-000000000052', 'c5c00000-0000-4000-8000-000000000032', 'C5C-B服務人員', 'active', 'not_invited', '0900530052', null),
  ('c5c00000-0000-4000-8000-000000000053', 'c5c00000-0000-4000-8000-000000000033', 'C5C-C服務人員', 'active', 'not_invited', '0900530053', null);
insert into merchant_line_configs (merchant_id, channel_id, channel_secret, channel_access_token, is_connected) values
  ('c5c00000-0000-4000-8000-000000000031', '1234567801', 'C5C-A-SECRET', 'C5C-A-TOKEN-SENTINEL', true),
  ('c5c00000-0000-4000-8000-000000000032', '1234567802', 'C5C-B-SECRET', 'C5C-B-TOKEN-SENTINEL', true),
  ('c5c00000-0000-4000-8000-000000000033', '1234567803', 'C5C-C-SECRET', 'C5C-C-TOKEN-SENTINEL', true);
insert into merchant_customer_line_settings (merchant_id, on_reminder, on_completed, reminder_hours_before) values
  ('c5c00000-0000-4000-8000-000000000031', true, true, 24),
  ('c5c00000-0000-4000-8000-000000000033', true, false, 12);
insert into merchant_line_login_configs (merchant_id, channel_id, channel_secret_vault_id, channel_secret_last4, enabled) values
  ('c5c00000-0000-4000-8000-000000000031', '5454545454', vault.create_secret('C5CFAKESECRET000000000000000AA'), '00AA', true);
insert into customer_line_identities (user_id, line_channel_id, line_sub, display_name) values
  ('c5c00000-0000-4000-8000-000000000011', '5454545454', 'U00000000000000000000000000c5c011', '小明');

insert into members (id, merchant_id, name, phone, referral_code) values
  ('c5c00000-0000-4000-8000-000000000041', 'c5c00000-0000-4000-8000-000000000031', 'C5C會員', '0912530001', 'C5CREF41'),
  ('c5c00000-0000-4000-8000-000000000042', 'c5c00000-0000-4000-8000-000000000032', 'C5C-B會員', '0912530002', 'C5CREF42'),
  ('c5c00000-0000-4000-8000-000000000043', 'c5c00000-0000-4000-8000-000000000033', 'C5C-C會員', '0912530003', 'C5CREF43');
insert into member_customer_contacts (id, merchant_id, member_id, user_id, is_primary, joined_via) values
  ('c5c00000-0000-4000-8000-000000000071', 'c5c00000-0000-4000-8000-000000000031', 'c5c00000-0000-4000-8000-000000000041', 'c5c00000-0000-4000-8000-000000000011', true, 'backfill');

-- 訂單(created_at 可指定;預設「很久以前就約好」)
create function pg_temp.bk(p_id text, p_merchant text, p_member text, p_start timestamptz, p_status text default 'accepted',
                           p_source text default 'manual', p_created timestamptz default '2026-01-01 00:00:00+00')
returns uuid language plpgsql as $$
declare v uuid := ('c5c00000-0000-4000-8000-0000000' || p_id)::uuid;
begin
  insert into public.bookings (id, merchant_id, staff_id, member_id, start_at, end_at, customer_name, customer_phone,
                               source, created_by_role, status, created_at, completed_at)
  values (v, ('c5c00000-0000-4000-8000-0000000000' || p_merchant)::uuid,
          ('c5c00000-0000-4000-8000-0000000000' || (50 + (p_merchant::int - 30))::text)::uuid,
          case when p_member is null then null else ('c5c00000-0000-4000-8000-0000000000' || p_member)::uuid end,
          p_start, p_start + interval '1 hour', '客人', '0912530001', p_source, 'admin', p_status, p_created,
          case when p_status = 'completed' then p_start end);
  return v;
end $$;

-- 現在 P = 2026-11-02 10:00(台北)
select pg_temp.bk('00101', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '20 hours');                 -- 進範圍
select pg_temp.bk('00102', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '30 hours');                 -- 超過 24 小時
select pg_temp.bk('00103', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '30 minutes');               -- 不到 1 小時
select pg_temp.bk('00104', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '20 hours', 'accepted', 'manual',
                  pg_temp.tp('2026-11-02 09:00'));                                                            -- 剛約的單
select pg_temp.bk('00105', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '20 hours', 'pending_confirmation'); -- 待確認
select pg_temp.bk('00106', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '20 hours', 'accepted', 'import');   -- 匯入
select pg_temp.bk('00107', '32', '42', pg_temp.tp('2026-11-02 10:00') + interval '20 hours');                 -- B 店沒開提醒
select pg_temp.bk('00108', '31', null, pg_temp.tp('2026-11-02 10:00') + interval '20 hours');                 -- 沒會員
select pg_temp.bk('00109', '31', '41', pg_temp.tp('2026-11-02 10:00') + interval '1 hour');                   -- 剛好 1 小時(含)
select pg_temp.bk('00110', '33', '43', pg_temp.tp('2026-11-03 09:00'));                                        -- C 店 12 小時,早上 9 點的單

-- =========================================================================
-- N12 提醒排程
-- =========================================================================
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-02 10:00')), 2, 'N12-1 P 時間點:只有符合條件的 2 張單寫入');
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000101'), array['pending:'], 'N12-2 進範圍(開始前 20 小時、N=24)⇒ 一筆待發提醒');
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000109'), array['pending:'], 'N12-3 離開始剛好 1 小時也算「1 小時以上」(Q2=A)');
select is((select count(*)::int from customer_line_outbox where kind = 'customer_reminder' and booking_id in (
             'c5c00000-0000-4000-8000-000000000102', 'c5c00000-0000-4000-8000-000000000103', 'c5c00000-0000-4000-8000-000000000104')),
          0, 'N12-4 超過 N 小時、不到 1 小時、剛約的單(建立晚於開始前 N 小時)⚠️ ⇒ 都不寫');
select is((select count(*)::int from customer_line_outbox where kind = 'customer_reminder' and booking_id in (
             'c5c00000-0000-4000-8000-000000000105', 'c5c00000-0000-4000-8000-000000000106',
             'c5c00000-0000-4000-8000-000000000107', 'c5c00000-0000-4000-8000-000000000108')),
          0, 'N12-5 待確認、匯入、店家沒開提醒(Q1=A 預設關)、沒會員 ⇒ 都不寫');
select is((select row(send_after, dedupe_key, payload ->> 'start_at' is not null, member_id)::text from customer_line_outbox
           where booking_id = 'c5c00000-0000-4000-8000-000000000101' and kind = 'customer_reminder'),
          row(pg_temp.tp('2026-11-02 10:00'), 'reminder:c5c00000-0000-4000-8000-000000000101:'
              || to_char((pg_temp.tp('2026-11-02 10:00') + interval '20 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              true, 'c5c00000-0000-4000-8000-000000000041'::uuid)::text,
          'N12-6 待發列:send_after = 現在、dedupe_key = reminder:訂單:開始時間、payload 記開始時間');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-02 10:10')), 0, 'N12-7 10 分鐘後再跑 ⇒ 不重複寫');
update customer_line_outbox set status = 'sent', processed_at = now()
where booking_id = 'c5c00000-0000-4000-8000-000000000101' and kind = 'customer_reminder';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-02 10:20')), 0, 'N12-8 已發出去之後(不再是待發)也不會再提醒同一個開始時間');

-- 深夜不寫(C 店早上 9 點的單、N=12:晚上 9 點起進範圍)
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-02 20:50')), 1, 'N12-9 晚上 20:50:A 店 30 小時後那張單這時才進 24 小時範圍(1 筆)');
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000110'), array[]::text[], 'N12-9b C 店的單還沒進範圍(開始前 12 小時 10 分)');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-02 22:00')), 0, 'N12-10 台北 22:00 起不寫 ⚠️');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-03 03:00')), 0, 'N12-11 半夜不寫');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-03 07:50')), 0, 'N12-12 07:50 仍不寫');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-03 08:00')), 1, 'N12-13 08:00 補寫(離服務剛好 1 小時,Q2=A)');
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000110'), array['pending:'], 'N12-14 C 店那張單在 08:00 寫入');

-- 改時間後再提醒新時間;狀態一變,還沒發的提醒作廢
select pg_temp.bk('00111', '31', '41', pg_temp.tp('2026-11-05 10:00'));
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-04 12:00')), 1, 'N12-15 新的一張單進範圍');
update bookings set start_at = pg_temp.tp('2026-11-05 11:00'), end_at = pg_temp.tp('2026-11-05 12:00') where id = 'c5c00000-0000-4000-8000-000000000111';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-04 12:10')), 1, 'N12-16 改了時間 ⇒ 用新的開始時間再提醒一次');
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000111'), array['pending:', 'pending:'], 'N12-17 兩筆待發(舊時間那筆發送時會判 stale)');
update bookings set status = 'cancelled' where id = 'c5c00000-0000-4000-8000-000000000111';
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000111'), array['skipped:stale', 'skipped:stale'], 'N12-18 取消 ⇒ 還沒發的提醒全部作廢');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-04 12:20')), 0, 'N12-19 取消後不再提醒');

-- 停發中不寫
select pg_temp.bk('00112', '31', '41', pg_temp.tp('2026-11-06 10:00'));
update merchant_customer_line_settings set quota_blocked_until = pg_temp.tp('2026-12-01 00:00') where merchant_id = 'c5c00000-0000-4000-8000-000000000031';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-05 12:00')), 0, 'N12-20 額度用完停發中 ⇒ 不寫');
update merchant_customer_line_settings set quota_blocked_until = null where merchant_id = 'c5c00000-0000-4000-8000-000000000031';

-- QA #4:提醒被作廢後狀態改回已確認(時間沒變)⇒ 還會再提醒;已發出去的那筆仍算數
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-05 12:10')), 1, 'QA4-1 停發解除 ⇒ 這張單寫入提醒');
update bookings set status = 'pending_confirmation' where id = 'c5c00000-0000-4000-8000-000000000112';
update bookings set status = 'accepted' where id = 'c5c00000-0000-4000-8000-000000000112';
select is(pg_temp.reminders('c5c00000-0000-4000-8000-000000000112'), array['skipped:stale'], 'QA4-2 狀態變動 ⇒ 舊提醒作廢');
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-05 12:20')), 1, 'QA4-3 改回已確認、時間沒變 ⇒ 會再提醒(作廢的不算去重)');
update customer_line_outbox set status = 'sent' where booking_id = 'c5c00000-0000-4000-8000-000000000112' and status = 'pending';
update bookings set status = 'pending_confirmation' where id = 'c5c00000-0000-4000-8000-000000000112';
update bookings set status = 'accepted' where id = 'c5c00000-0000-4000-8000-000000000112';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-05 12:30')), 0, 'QA4-4 已發出去過同一個開始時間 ⇒ 不再提醒');

-- R1:結束成 skipped(非作廢)或 failed 的提醒都算已經提醒過,下一輪不再寫;只有作廢(skipped / stale)的不算
select pg_temp.bk('00113', '31', '41', pg_temp.tp('2026-11-07 10:00'));
select pg_temp.bk('00114', '31', '41', pg_temp.tp('2026-11-07 10:30'));
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-06 12:00')), 2, 'R1-1 兩張新單各寫一筆提醒');
update customer_line_outbox set status = 'skipped', last_error = null, processed_at = now()
where booking_id = 'c5c00000-0000-4000-8000-000000000113' and kind = 'customer_reminder';
update customer_line_outbox set status = 'failed', last_error = 'all_failed', processed_at = now()
where booking_id = 'c5c00000-0000-4000-8000-000000000114' and kind = 'customer_reminder';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-06 12:10')), 0, 'R1-2 整批略過(skipped,非作廢)、發送失敗(failed)之後,下一輪都不再寫');
update customer_line_outbox set last_error = 'event_disabled'
where booking_id = 'c5c00000-0000-4000-8000-000000000113' and kind = 'customer_reminder';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-06 12:20')), 0, 'R1-3 店家關提醒 / 額度用完等原因略過(last_error 不是 stale)⇒ 不再寫');
update bookings set status = 'pending_confirmation' where id = 'c5c00000-0000-4000-8000-000000000113';
update customer_line_outbox set status = 'skipped', last_error = 'stale'
where booking_id = 'c5c00000-0000-4000-8000-000000000113' and kind = 'customer_reminder';
update bookings set status = 'accepted' where id = 'c5c00000-0000-4000-8000-000000000113';
select is(private.enqueue_customer_line_reminders_at(pg_temp.tp('2026-11-06 12:30')), 1, 'R1-4 被作廢(skipped / stale,例如 Edge 判過時)後改回已確認 ⇒ 下一輪會再寫');
select is((select array_agg(status || ':' || coalesce(last_error, '') order by status) from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000113' and kind = 'customer_reminder'), array['pending:', 'skipped:stale'], 'R1-5 ⇒ 多一筆待發');

select is((select schedule from cron.job where jobname = 'customer-line-reminder-enqueue'), '*/10 * * * *', 'N12-21 排程每 10 分鐘');
select ok((select command like '%private.enqueue_customer_line_reminders()%' and command not like '%decrypted_secret%'
           and command not like '%http_post%' from cron.job where jobname = 'customer-line-reminder-enqueue'),
          'N12-22 排程只跑純 SQL(不連外、不碰密鑰)');

-- =========================================================================
-- N07 prepare:提醒
-- =========================================================================
create function pg_temp.claim_ob(p_booking text, p_kind text, p_payload jsonb, p_id text)
returns uuid language plpgsql as $$
declare v uuid := ('c5c00000-0000-4000-8000-0000000' || p_id)::uuid;
begin
  insert into public.customer_line_outbox (id, merchant_id, kind, booking_id, member_id, payload, status, claimed_at)
  select v, b.merchant_id, p_kind, b.id, b.member_id, p_payload, 'processing', now()
  from public.bookings b where b.id = ('c5c00000-0000-4000-8000-0000000' || p_booking)::uuid;
  return v;
end $$;

-- 用真正的「現在」:明天這個時間的單
select pg_temp.bk('00120', '31', '41', date_trunc('minute', now()) + interval '20 hours');
select pg_temp.claim_ob('00120', 'customer_reminder',
  jsonb_build_object('start_at', (select start_at from bookings where id = 'c5c00000-0000-4000-8000-000000000120')), '00301');
select public.internal_prepare_customer_line_job('c5c00000-0000-4000-8000-000000000301') as j \gset r_
select is(array[:'r_j'::jsonb ->> 'state', :'r_j'::jsonb ->> 'template_code', :'r_j'::jsonb ->> 'log_event_type',
                (jsonb_array_length(:'r_j'::jsonb -> 'recipients'))::text],
          array['send', 'reminder', 'customer_reminder', '1'], 'N07-1 提醒照常準備(5-B 起不再標 skipped):範本 reminder、收件人 1 位');
select is(:'r_j'::jsonb -> 'variables' ->> 'booking_day_word',
          (select case ((start_at at time zone 'Asia/Taipei')::date - (now() at time zone 'Asia/Taipei')::date)
                    when 0 then '今天' when 1 then '明天' when 2 then '後天' end
           from bookings where id = 'c5c00000-0000-4000-8000-000000000120'),
          'N07-2 {{booking_day_word}} 依台北日期 = 今天 / 明天');
select ok(:'r_j'::jsonb ->> 'template' like '提醒你：{{booking_day_word}} {{booking_time}} 在「{{merchant_name}}」有預約。%', 'N07-3 用預設提醒範本');
update customer_line_outbox set created_at = now() - interval '7 hours' where id = 'c5c00000-0000-4000-8000-000000000301';
select is(public.internal_prepare_customer_line_job('c5c00000-0000-4000-8000-000000000301') ->> 'state', 'send', 'N07-4 提醒不套「建立超過 6 小時就過時」');
select pg_temp.claim_ob('00120', 'customer_reminder', '{"start_at":"2026-01-01T00:00:00Z"}', '00302');
select is(public.internal_prepare_customer_line_job('c5c00000-0000-4000-8000-000000000302') ->> 'state', 'stale', 'N07-5 開始時間跟排提醒時不同 ⇒ stale');
select pg_temp.bk('00121', '31', '41', now() - interval '5 minutes');
select pg_temp.claim_ob('00121', 'customer_reminder',
  jsonb_build_object('start_at', (select start_at from bookings where id = 'c5c00000-0000-4000-8000-000000000121')), '00303');
select is(public.internal_prepare_customer_line_job('c5c00000-0000-4000-8000-000000000303') ->> 'state', 'stale', 'N07-6 已經開始了才輪到 ⇒ stale');
select pg_temp.bk('00122', '31', '41', now() + interval '1 day', 'pending_confirmation');
select pg_temp.claim_ob('00122', 'customer_reminder',
  jsonb_build_object('start_at', (select start_at from bookings where id = 'c5c00000-0000-4000-8000-000000000122')), '00304');
select is(public.internal_prepare_customer_line_job('c5c00000-0000-4000-8000-000000000304') ->> 'state', 'stale', 'N07-7 不是已確認 ⇒ stale');
update merchant_customer_line_settings set on_reminder = false where merchant_id = 'c5c00000-0000-4000-8000-000000000031';
select is(public.internal_prepare_customer_line_job('c5c00000-0000-4000-8000-000000000301') ->> 'reason', 'event_disabled', 'N07-8 等待中店家關掉提醒 ⇒ 安靜結束');
update merchant_customer_line_settings set on_reminder = true where merchant_id = 'c5c00000-0000-4000-8000-000000000031';

-- =========================================================================
-- N08 服務完成
-- =========================================================================
select pg_temp.bk('00130', '31', '41', now() - interval '2 hours');
update bookings set status = 'completed', completed_at = now(), last_modified_by_user_id = 'c5c00000-0000-4000-8000-000000000001'
where id = 'c5c00000-0000-4000-8000-000000000130';
select is(pg_temp.kinds('c5c00000-0000-4000-8000-000000000130'), array['customer_completed'], 'N08-1 店家按完成 ⇒ 一筆「服務完成」');
select is((select dedupe_key from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000130'),
          'completed:c5c00000-0000-4000-8000-000000000130', 'N08-2 dedupe_key');
select pg_temp.bk('00131', '32', '42', now() - interval '2 hours');
update bookings set status = 'completed', completed_at = now() where id = 'c5c00000-0000-4000-8000-000000000131';
select is(pg_temp.kinds('c5c00000-0000-4000-8000-000000000131'), array[]::text[], 'N08-3 店家沒開「服務完成」(Q1=A 預設關)⇒ 不寫');
select pg_temp.bk('00132', '31', '41', now() - interval '2 hours');
select set_config('miaoyue.staff_order_actor', 'c5c00000-0000-4000-8000-000000000003', true);
update bookings set status = 'completed', completed_at = now(), last_modified_by_user_id = 'c5c00000-0000-4000-8000-000000000003'
where id = 'c5c00000-0000-4000-8000-000000000132';
select set_config('miaoyue.staff_order_actor', '', true);
select is(pg_temp.kinds('c5c00000-0000-4000-8000-000000000132'), array['customer_completed'], 'N08-4 服務人員按完成也通知(規格沒有排除)');
update bookings set status = 'accepted', completed_at = null where id = 'c5c00000-0000-4000-8000-000000000130';
select is(pg_temp.kinds('c5c00000-0000-4000-8000-000000000130'), array['customer_completed'], 'N08-5 還原成已確認 ⇒ 不會多一則「已確認」');
select pg_temp.bk('00133', '31', '41', now() - interval '2 hours', 'accepted', 'import');
update bookings set status = 'completed', completed_at = now() where id = 'c5c00000-0000-4000-8000-000000000133';
select is(pg_temp.kinds('c5c00000-0000-4000-8000-000000000133'), array[]::text[], 'N08-6 匯入的單不發');
select pg_temp.bk('00134', '31', null, now() - interval '2 hours');
update bookings set status = 'completed', completed_at = now() where id = 'c5c00000-0000-4000-8000-000000000134';
select is(pg_temp.kinds('c5c00000-0000-4000-8000-000000000134'), array[]::text[], 'N08-7 沒有會員不發');

-- prepare
update customer_line_outbox set status = 'processing', claimed_at = now() where booking_id = 'c5c00000-0000-4000-8000-000000000132';
select public.internal_prepare_customer_line_job(id) as j from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000132' \gset c_
select is(array[:'c_j'::jsonb ->> 'state', :'c_j'::jsonb ->> 'template_code', :'c_j'::jsonb ->> 'template'],
          array['send', 'completed', '謝謝你今天光臨「{{merchant_name}}」！' || E'\n' || '查看紀錄：{{member_center_url}}'],
          'N08-8 prepare:範本 completed');
update customer_line_outbox set status = 'processing', claimed_at = now() where booking_id = 'c5c00000-0000-4000-8000-000000000130';
select is((select public.internal_prepare_customer_line_job(id) ->> 'state' from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000130'),
          'stale', 'N08-9 完成後又被還原 ⇒ stale');

-- QA #3:完成 → 還原 → 再完成,不重複「謝謝光臨」
update bookings set status = 'completed', completed_at = now() where id = 'c5c00000-0000-4000-8000-000000000130';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000130' and kind = 'customer_completed'),
          1, 'QA3-1 前一則還在發送中 ⇒ 再完成不多寫');
update customer_line_outbox set status = 'sent' where booking_id = 'c5c00000-0000-4000-8000-000000000132';
update bookings set status = 'accepted', completed_at = null where id = 'c5c00000-0000-4000-8000-000000000132';
update bookings set status = 'completed', completed_at = now() where id = 'c5c00000-0000-4000-8000-000000000132';
select is((select count(*)::int from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000132' and kind = 'customer_completed'),
          1, 'QA3-2 已經發過「服務完成」⇒ 還原再完成不再寫');
update customer_line_outbox set status = 'skipped', last_error = 'stale' where booking_id = 'c5c00000-0000-4000-8000-000000000130';
update bookings set status = 'accepted', completed_at = null where id = 'c5c00000-0000-4000-8000-000000000130';
update bookings set status = 'completed', completed_at = now() where id = 'c5c00000-0000-4000-8000-000000000130';
select is((select array_agg(status order by status) from customer_line_outbox where booking_id = 'c5c00000-0000-4000-8000-000000000130' and kind = 'customer_completed'),
          array['pending', 'skipped'], 'QA3-3 前一則被判過時沒發出去 ⇒ 再完成會寫新的一則');

-- =========================================================================
-- X01 新函式權限
-- =========================================================================
select is((select count(*)::int from pg_proc p
           where p.oid in ('private.enqueue_customer_line_reminders_at(timestamptz)'::regprocedure, 'private.enqueue_customer_line_reminders()'::regprocedure)
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))),
          0, 'X01-1 提醒排程兩支:anon / authenticated / service_role 都不能執行(只有排程)');
select is((select count(*)::int from pg_proc p
           where p.oid = 'private.tg_bookings_enqueue_customer_line()'::regprocedure
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))),
          0, 'X01-2 trigger 函式換版本後權限仍全部收回');
select is((select array_agg(tgname::text order by tgname) from pg_trigger where tgrelid = 'public.bookings'::regclass and tgname = 'bookings_enqueue_customer_line'),
          array['bookings_enqueue_customer_line'], 'X01-3 trigger 仍掛著');
select is((select count(*)::int from customer_line_outbox o where o.payload::text like '%TOKEN-SENTINEL%' or coalesce(o.last_error, '') like '%TOKEN-SENTINEL%'),
          0, 'X02 待發清單沒有 token');

select * from finish();
rollback;
