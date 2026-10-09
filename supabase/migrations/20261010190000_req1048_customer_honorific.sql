-- #1048 客戶端稱呼統一用「您」(資料庫那半)
-- 範圍(使用者 2026-10-09 確認):只改「客人看得到」的字;商家後台、客服、服務人員端、超級管理員的訊息不動。
-- 已上線的 migration 一個字都不改;要改的函式在這裡 create or replace 重新定義,只改文字,
-- 參數、回傳型別、volatility、security definer、search_path、權限全部照舊。
--
--   ① private.customer_line_default_templates  LINE 通知客人預設文案 13 個範本(含「你們在」→「您在」),
--      逐字對齊前端 CUSTOMER_LINE_DEFAULT_TEMPLATES;有 {{merchant_phone}} 的句子仍自己一行(5-B 規則)。
--   ② private.default_member_completion_message  會員完成頁預設句 3 句。
--   ③ private.customer_booking_result            訪客完成頁預設句 1 句(其餘逐字照 20261010120100 版本)。
--   ④ 店家已存的 LINE 文案:只把「內容跟舊預設逐字相同」的列換成新預設(代表店家沒改過);店家改過的不動。
--      本機 2026-10-09 SELECT:merchant_customer_line_settings 0 列、符合 0 筆;這段是保險。

-- =========================================================================
-- ④ 前置:先記下舊預設(到府 / 非到府兩種),等 ① 換完再比對
-- =========================================================================
create temporary table req1048_old_line_defaults as
select false as is_on_site, d.key as code, d.value as old_text
from jsonb_each_text(private.customer_line_default_templates(false)) d
union all
select true as is_on_site, d.key as code, d.value as old_text
from jsonb_each_text(private.customer_line_default_templates(true)) d;

-- =========================================================================
-- ① LINE 通知客人預設文案
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
      '「{{merchant_name}}」已收到您的預約：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '店家確認後會再用 LINE 通知您。' || E'\n' || '查看預約：{{member_center_url}}',
    'submitted_accepted',
      '「{{merchant_name}}」預約成功：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '服務人員：{{staff_name}}' || E'\n' || '查看或取消：{{member_center_url}}',
    'scheduled_by_store',
      '「{{merchant_name}}」已為您安排預約：' || E'\n' || '{{booking_date}} ' || t || E'\n' || '{{service_items}}' || E'\n'
      || '查看預約：{{member_center_url}}',
    'confirmed',
      '「{{merchant_name}}」已確認您的預約：' || E'\n' || '{{booking_date}} ' || t || E'\n'
      || '服務人員：{{staff_name}}' || E'\n' || '查看或取消：{{member_center_url}}',
    'rescheduled',
      '「{{merchant_name}}」調整了您的預約時間：' || E'\n' || '原本：{{old_booking_date}} {{old_booking_time}}' || E'\n'
      || '改為：{{booking_date}} ' || t || E'\n' || '如果時間不方便，請聯絡店家：{{merchant_phone}}',
    'cancelled_by_store',
      '「{{merchant_name}}」取消了您 {{booking_date}} {{booking_time}} 的預約。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}',
    'cancelled_by_customer',
      '您在「{{merchant_name}}」{{booking_date}} {{booking_time}} 的預約已由 {{contact_name}} 取消。',
    'reminder',
      '提醒您：{{booking_day_word}} ' || t || ' 在「{{merchant_name}}」有預約。' || E'\n' || '{{service_items}}' || E'\n'
      || '查看預約：{{member_center_url}}',
    'completed',
      '謝謝您今天光臨「{{merchant_name}}」！' || E'\n' || '查看紀錄：{{member_center_url}}',
    'contact_request',
      '{{contact_name}} 申請成為您在「{{merchant_name}}」會員的聯絡人，請到會員中心同意或拒絕：{{member_center_url}}',
    'contact_removed',
      '您已不是「{{merchant_name}}」會員「{{member_name}}」的聯絡人，之後不會再收到這位會員的預約通知。',
    'contact_approved',
      '您已成為「{{merchant_name}}」會員「{{member_name}}」的聯絡人，可以到會員中心查看預約：{{member_center_url}}',
    'contact_rejected',
      '您申請成為「{{merchant_name}}」會員聯絡人的要求沒有被同意。' || E'\n' || '有問題請聯絡店家：{{merchant_phone}}'
  );
end;
$$;
revoke all on function private.customer_line_default_templates(boolean) from public, anon, authenticated, service_role;

-- =========================================================================
-- ④ 店家已存的 LINE 文案:只換「逐字等於舊預設」的那一格
--    (where 內容 = 舊預設;同一個範本到府 / 非到府各比一次,換成對應的新預設)
-- =========================================================================
do $$
declare
  r record;
begin
  for r in
    select o.is_on_site, o.code, o.old_text,
           private.customer_line_default_templates(o.is_on_site) ->> o.code as new_text
    from req1048_old_line_defaults o
  loop
    if r.new_text is not null and r.new_text <> r.old_text then
      update public.merchant_customer_line_settings
      set templates = jsonb_set(templates, array[r.code], to_jsonb(r.new_text)),
          updated_at = now()
      where templates ->> r.code = r.old_text;
    end if;
  end loop;
end;
$$;
drop table req1048_old_line_defaults;

-- =========================================================================
-- ② 會員完成頁預設句
-- =========================================================================
create or replace function private.default_member_completion_message(p_merchant_id uuid, p_status text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_status = 'accepted' then
    return '服務前店家可能會再跟您聯絡確認。';
  end if;
  if private.customer_line_notify_available(p_merchant_id) and (private.customer_line_settings(p_merchant_id)).on_confirmed then
    return '店家確認後會用 LINE 通知您。';
  end if;
  return '店家確認後會通知您。';
end;
$$;
revoke all on function private.default_member_completion_message(uuid, text) from public, anon, authenticated, service_role;

-- =========================================================================
-- ③ 完成頁結果(只改訪客預設句一處)
-- =========================================================================
CREATE OR REPLACE FUNCTION private.customer_booking_result(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b public.bookings;
  v_staff_display text;
  v_member_msg text;
  v_guest_msg text;
begin
  select * into v_b from public.bookings where id = p_booking_id;
  if not found then
    return jsonb_build_object('state', 'unavailable');
  end if;

  select coalesce(nullif(btrim(ms.nickname), ''), ms.name) into v_staff_display
  from public.merchant_staff ms where ms.id = v_b.staff_id;

  select s.completion_message_member, s.completion_message_guest into v_member_msg, v_guest_msg
  from public.merchant_booking_settings s where s.merchant_id = v_b.merchant_id;

  return jsonb_build_object(
    'state', 'created',
    'booking', jsonb_build_object(
      'status', v_b.status,
      'start_at', v_b.start_at,
      'end_at', v_b.end_at,
      'staff_display', v_staff_display,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('name', si.name, 'quantity', bsi.quantity)
                         order by case when si.item_type = 'primary' then 0 else 1 end, si.created_at, si.id)
        from public.booking_service_items bsi
        join public.service_items si on si.id = bsi.service_item_id
        where bsi.booking_id = v_b.id
      ), '[]'::jsonb),
      'address', v_b.customer_address,
      'phone', case when v_b.is_guest_booking then v_b.customer_phone else null end,
      'estimated_amount', v_b.final_amount_snapshot,
      'is_guest', v_b.is_guest_booking
    ),
    'completion_message', case
      when v_b.is_guest_booking then coalesce(v_guest_msg, '店家確認後會與您聯絡。')
      when v_member_msg is not null then v_member_msg
      -- [c5] C5-M04:預設句改由 private.default_member_completion_message 決定(只有能用 LINE 通知時才說「用 LINE」)。
      else private.default_member_completion_message(v_b.merchant_id, v_b.status)
    end
  );
end;
$function$;
revoke execute on function private.customer_booking_result(uuid) from public, anon, authenticated;
grant execute on function private.customer_booking_result(uuid) to service_role;
