-- SPECS-INDEX #1019(第 21 批,A2):鈴鐺「已完成訂單被取消 / 被還原」的原因完整顯示 —— 資料庫這一段。
--
-- 使用者要「原因完整顯示」。前端已改成換行不截斷(NotificationBell.tsx),但寫通知的
-- private.notify_completed_booking_reversal(第 11 批 H,20261007140500)會先把原因切到 60 字再加「…」,
-- 超過 60 字的原因在資料庫就不見了。這支 migration 只做一件事:**拿掉 60 字截斷**,其餘逐字不變
-- (收件人規則、標題、內文格式、換行 / tab 換成半形空白、SECURITY DEFINER、search_path、ACL 全部照舊)。
--
-- 長度檢查:
--   ・原因上限 500 字(private.reverse_booking_completion:超過 500 字 raise;前端 REVERSAL_REASON_MAX = 500)。
--   ・user_notifications.title / body 都是 text,沒有長度 CHECK、沒有 trigger ⇒ 500 字原因 + 固定前綴可以完整存下。
-- 舊通知不回補(主腦裁決)。
--
-- 改前指紋(正式庫 wjtbmmnakcriuaqoknsq,2026-10-08 唯讀實查;算法 = prosrc 先把 CRLF 換成 LF 再取 md5):
--   private.notify_completed_booking_reversal = 0321fe41c9baa8b9a25d4169f47d1029(= 本機 = 20261007140500,沒有漂移)
--
-- 套用順序:跟 20261008120000_req1021_staff_available_slot_calendar_style.sql 動的是完全不同的物件,互不依賴;
-- 照檔名順序先 20261008120000、再本檔。前端新版(鈴鐺換行)跟本檔也互不依賴,先後都安全。
-- ⚠️ 本檔沒有任何資料寫入或刪除。

create or replace function private.notify_completed_booking_reversal(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_merchant_id uuid;
  v_action text;
  v_reason text;
  v_actor uuid;
  v_actor_name text;
  v_start_at timestamptz;
  v_customer_name text;
  v_event text;
  v_title text;
  v_body text;
begin
  -- 這張單最新一列稽核(同一交易內引擎剛寫入的就是它)。
  select r.merchant_id, r.action, r.reason, r.actor_user_id, r.actor_name_snapshot
    into v_merchant_id, v_action, v_reason, v_actor, v_actor_name
  from public.booking_completion_reversals r
  where r.booking_id = p_booking_id
  order by r.created_at desc, r.id desc
  limit 1;

  if not found then
    return;
  end if;

  select b.start_at, b.customer_name
    into v_start_at, v_customer_name
  from public.bookings b
  where b.id = p_booking_id;

  -- 原因:換行 / tab 換成一個半形空白(鈴鐺內文是一段文字)。#1019 第 21 批起**不再截到 60 字**,完整寫進內文
  -- (原因已由 private.reverse_booking_completion 限制最多 500 字;user_notifications.body 是 text、沒有長度限制)。
  v_reason := regexp_replace(coalesce(v_reason, ''), E'\r\n|[\r\n\t]', ' ', 'g');

  if v_action = 'cancel_completed' then
    v_event := 'booking_completed_cancelled';
    v_title := '已完成訂單被取消';
    v_body := format(
      '%s 將 %s「%s」的已完成訂單取消。原因：%s',
      coalesce(nullif(btrim(v_actor_name), ''), '管理員'),
      to_char(v_start_at at time zone 'Asia/Taipei', 'YYYY/MM/DD HH24:MI'),
      coalesce(nullif(btrim(v_customer_name), ''), '未填姓名'),
      v_reason
    );
  else
    v_event := 'booking_completed_reverted';
    v_title := '已完成訂單被還原';
    v_body := format(
      '%s 將 %s「%s」的已完成訂單還原為已確認。原因：%s',
      coalesce(nullif(btrim(v_actor_name), ''), '管理員'),
      to_char(v_start_at at time zone 'Asia/Taipei', 'YYYY/MM/DD HH24:MI'),
      coalesce(nullif(btrim(v_customer_name), ''), '未填姓名'),
      v_reason
    );
  end if;

  -- ① 管理員(排除操作者本人)。不放電話 / 地址 / 金額 / 點數。
  insert into public.user_notifications (
    user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body
  )
  select ma.user_id, v_merchant_id, 'admin', ma.id, v_event, p_booking_id, v_title, v_body
  from public.merchant_admins ma
  where ma.merchant_id = v_merchant_id
    and ma.user_id is distinct from v_actor;

  -- ② 有「訂單管理」權限的在職客服(排除操作者本人;同一帳號已是同店管理員 ⇒ 不重寫)。服務人員一律不寫。
  insert into public.user_notifications (
    user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body
  )
  select g.user_id, v_merchant_id, 'agent', g.id, v_event, p_booking_id, v_title, v_body
  from public.merchant_agents g
  where g.merchant_id = v_merchant_id
    and g.status = 'active'
    and g.user_id is not null
    and g.user_id is distinct from v_actor
    and exists (
      select 1 from public.merchant_agent_permissions p
      where p.agent_id = g.id and p.section_key = 'orders' and p.granted = true
    )
    and not exists (
      select 1 from public.merchant_admins ma2
      where ma2.merchant_id = v_merchant_id and ma2.user_id = g.user_id
    );
end;
$function$;

comment on function private.notify_completed_booking_reversal(uuid) is 'SPECS-INDEX #997 第 11 批 H / #1019 第 21 批(原因完整寫入,不再截到 60 字):讀這張單最新一列 booking_completion_reversals,寫站內鈴鐺(booking_completed_cancelled / booking_completed_reverted)給同店其他管理員與有訂單管理權限的在職客服(排除操作者本人、同帳號只一則、服務人員不寫)。不看推播開關與 p_notify_requested;不發 LINE / 推播;內文不放電話 / 地址 / 金額 / 點數。只由 revert_completed_booking / cancel_completed_booking 在同一交易內呼叫。';

revoke execute on function private.notify_completed_booking_reversal(uuid) from public, anon, authenticated, service_role;
