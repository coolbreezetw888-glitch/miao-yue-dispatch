-- 客戶端第 5-B 批 QA 退回修正(#1047)
-- 5-A 的兩支 migration(20261010120000 / 20261010120100)已套上正式庫,一個字都不改;要改的 5-A 函式在這裡重新定義。
--
--   #1 contact_rejected 預設文字:「有問題請聯絡店家：{{merchant_phone}}」改成獨立一行(比照 cancelled_by_store)。
--      原本整則只有一行,店家沒填電話(正式庫 463 間有 462 間)時整行被拿掉 ⇒ 訊息空白 ⇒ 記失敗。
--      店家自己存的文字若「逐字等於舊預設」也一併改成新預設(正式庫 2026-10-09 SELECT:設定表 0 列、0 筆符合,這段只是保險)。
--   #5 line_quota_exhausted 鈴鐺內文改全形括號「（包含員工通知）」。
--   其他內容逐字照 5-A 版本。

-- =========================================================================
-- #1 預設範本(只改 contact_rejected 一筆)
-- =========================================================================
create or replace function private.customer_line_default_templates(p_is_on_site boolean)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  t text := case when coalesce(p_is_on_site, false) then '{{booking_time}}（預計抵達時間）' else '{{booking_time}}' end;
begin
  return jsonb_build_object(
    'submitted_pending',
      '「{{merchant_name}}」已收到你的預約：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '店家確認後會再用 LINE 通知你。' || E'\n' || '查看預約：{{member_center_url}}',
    'submitted_accepted',
      '「{{merchant_name}}」預約成功：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '服務人員：{{staff_name}}' || E'\n' || '查看或取消：{{member_center_url}}',
    'scheduled_by_store',
      '「{{merchant_name}}」已為你安排預約：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '查看預約：{{member_center_url}}',
    'confirmed',
      '「{{merchant_name}}」已確認你的預約：' || E'\n' || '{{booking_date}} ' || t || E'\n'
      || '服務人員：{{staff_name}}' || E'\n' || '查看或取消：{{member_center_url}}',
    'rescheduled',
      '「{{merchant_name}}」調整了你的預約時間：' || E'\n' || '原本：{{old_booking_date}} {{old_booking_time}}' || E'\n'
      || '改為：{{booking_date}} ' || t || E'\n' || '如果時間不方便，請聯絡店家：{{merchant_phone}}',
    'cancelled_by_store',
      '「{{merchant_name}}」取消了你 {{booking_date}} {{booking_time}} 的預約。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}',
    'cancelled_by_customer',
      '你們在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。',
    'reminder',
      '提醒你：{{booking_day_word}} ' || t || ' 在「{{merchant_name}}」有預約。' || E'\n' || '{{service_items}}' || E'\n'
      || '查看預約：{{member_center_url}}',
    'completed',
      '謝謝你今天光臨「{{merchant_name}}」！' || E'\n' || '查看紀錄：{{member_center_url}}',
    'contact_request',
      '{{contact_name}} 申請成為你在「{{merchant_name}}」會員的聯絡人，請到會員中心同意或拒絕：{{member_center_url}}',
    'contact_removed',
      '你已不是「{{merchant_name}}」會員「{{member_name}}」的聯絡人，之後不會再收到這位會員的預約通知。',
    'contact_approved',
      '你已成為「{{merchant_name}}」會員「{{member_name}}」的聯絡人，可以到會員中心查看預約：{{member_center_url}}',
    'contact_rejected',
      '你申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}'
  );
end;
$$;
revoke all on function private.customer_line_default_templates(boolean) from public, anon, authenticated, service_role;

update public.merchant_customer_line_settings
set templates = jsonb_set(templates, '{contact_rejected}',
      to_jsonb('你申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}')),
    updated_at = now()
where templates ->> 'contact_rejected' = '你申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。有問題請聯絡店家：{{merchant_phone}}';

-- =========================================================================
-- #5 額度用完鈴鐺:全形括號(只改內文一處)
-- =========================================================================
create or replace function public.internal_finish_customer_line_job(p_outbox_id uuid, p_outcome text, p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.customer_line_outbox;
  v_err text := left(nullif(btrim(coalesce(p_error, '')), ''), 500);
  v_until timestamptz;
  v_month_start timestamptz;
  v_skipped_others integer := 0;
begin
  if p_outcome not in ('sent', 'skipped', 'failed', 'retry', 'quota_exhausted') then
    raise exception '結果代碼不正確。' using errcode = '22023', hint = 'invalid_outcome';
  end if;
  select * into o from public.customer_line_outbox where id = p_outbox_id for update;
  if not found or o.status <> 'processing' then
    return jsonb_build_object('state', 'not_claimed');
  end if;

  if p_outcome = 'retry' then
    if o.attempts >= 3 then
      update public.customer_line_outbox set status = 'failed', last_error = v_err, processed_at = now(), claimed_at = null
      where id = o.id;
      return jsonb_build_object('state', 'failed');
    end if;
    update public.customer_line_outbox
    set status = 'pending', attempts = o.attempts + 1, last_error = v_err, claimed_at = null,
        send_after = now() + case o.attempts when 0 then interval '1 minute' when 1 then interval '5 minutes' else interval '15 minutes' end
    where id = o.id;
    return jsonb_build_object('state', 'retry');
  end if;

  if p_outcome = 'quota_exhausted' then
    -- 停發到下個月 1 日台北 00:00;這間店其他待發列全部略過;管理員鈴鐺(同月一則)。
    v_until := (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month') at time zone 'Asia/Taipei';
    v_month_start := date_trunc('month', now() at time zone 'Asia/Taipei') at time zone 'Asia/Taipei';
    insert into public.merchant_customer_line_settings (merchant_id, quota_blocked_until)
    values (o.merchant_id, v_until)
    on conflict (merchant_id) do update set quota_blocked_until = excluded.quota_blocked_until, updated_at = now();

    update public.customer_line_outbox
    set status = 'skipped', last_error = 'quota_exhausted', processed_at = now(), claimed_at = null
    where id = o.id;
    update public.customer_line_outbox x
    set status = 'skipped', last_error = 'quota_exhausted', processed_at = now()
    where x.merchant_id = o.merchant_id and x.status = 'pending' and x.id <> o.id;
    get diagnostics v_skipped_others = row_count;

    if not exists (
      select 1 from public.user_notifications n
      where n.merchant_id = o.merchant_id and n.event_type = 'line_quota_exhausted' and n.created_at >= v_month_start
    ) then
      insert into public.user_notifications (user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body)
      select ma.user_id, o.merchant_id, 'admin', ma.id, 'line_quota_exhausted', null,
             'LINE 訊息額度已用完',
             'LINE 官方帳號本月訊息額度已用完，這個月的 LINE 通知（包含員工通知）都會發送失敗，下個月 1 日自動恢復。'
      from public.merchant_admins ma
      where ma.merchant_id = o.merchant_id and ma.user_id is not null;
    end if;
    return jsonb_build_object('state', 'quota_exhausted', 'skipped_others', v_skipped_others);
  end if;

  update public.customer_line_outbox
  set status = p_outcome, last_error = v_err, processed_at = now(), claimed_at = null
  where id = o.id;
  return jsonb_build_object('state', p_outcome);
end;
$$;
revoke all on function public.internal_finish_customer_line_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.internal_finish_customer_line_job(uuid, text, text) to service_role;
