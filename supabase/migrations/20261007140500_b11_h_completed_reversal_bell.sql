-- SPECS-INDEX #997 第 11 批 H(2026-10-07):已完成訂單被取消 / 被還原時,發站內鈴鐺給店裡其他管理員與客服。
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §十五(H-1 ~ H-12);主腦裁決:§15.9 全部照規劃員建議。
--
-- 改前指紋(正式庫 wjtbmmnakcriuaqoknsq,2026-10-07 唯讀實查,md5(replace(prosrc,E'\r\n',E'\n'))):
--   public.revert_completed_booking   = 0545086eb67e02ade465173f704c6b10(本檔改寫)
--   public.cancel_completed_booking   = 2477b425edfa346e1b4c5d8f887aa668(本檔改寫)
--   private.reverse_booking_completion = b5499e10fd2524dc96b032fb8829210d(本檔**不改**,只確認)
--   user_notifications_event_type_check = 5 個值(created / cancelled / updated / reminder_next_day / confirmed)
--
-- 為什麼不改引擎 private.reverse_booking_completion:它在 supabase/tests/database/req987_03_fullwidth_messages_c.sql
-- 的指紋守門名單裡(新訊息換回舊訊息後 md5 必須等於改前),動它會讓守門變紅。所以只改兩支薄包裝:
-- 先呼叫引擎(參數照舊),成功後在**同一個交易**呼叫新 helper 寫鈴鐺,失敗整筆回滾。
--
-- 收件人規則(H-3):
--   ① 該店 merchant_admins 每一列(排除操作者本人)
--   ② 同店、在職(status='active')、已開通登入、有「訂單管理」(orders, granted=true)權限的客服(排除操作者本人);
--      同一帳號已是同店管理員 ⇒ 不再以客服身分寫第二則
--   服務人員一律不寫;不在 merchant_admins 的集團管理員不寫(先例 staff_confirm_booking 一致)。
--   操作者 = 稽核列 actor_user_id(= auth.uid());為 null(只有 service_role 直接呼叫)⇒ 不排除任何人。
-- 與開關無關(H-4):不讀推播設定 / 個人推播開關,也不看 p_notify_requested;只寫 user_notifications,不發 LINE / 推播。
--
-- 與「同時發送取消通知」打開時 Edge Function 另寫的 booking_cancelled 鈴鐺:資料庫兩列都保留,
-- **合併只在前端鈴鐺畫面**(src/modules/notifications/notificationLink.ts mergeNotificationRows,120 秒內同單併成一則)。
--
-- ⚠️ 本檔沒有任何資料寫入或刪除(只有 alter constraint、comment、create function 與 ACL)。放寬 CHECK 不會讓既有任何一列失效。

-- =========================================================================
-- ① user_notifications.event_type CHECK 放寬(H-1,比照 20261006140000)
-- =========================================================================
alter table public.user_notifications
  drop constraint user_notifications_event_type_check;
alter table public.user_notifications
  add constraint user_notifications_event_type_check check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day',
      'booking_confirmed',
      -- SPECS-INDEX #997 第 11 批 H:已完成訂單被取消 / 被還原 ⇒ 鈴鐺通知其他管理員與有訂單管理權限的在職客服。
      -- 只由 private.notify_completed_booking_reversal 寫入;推播設定沒有這兩個事件(純站內通知)。
      'booking_completed_cancelled', 'booking_completed_reverted'
    )
  );

comment on column public.user_notifications.event_type is '§13.2:刻意**不含** ''test'' —— 測試推播是使用者自己按出來的,記進鈴鐺只是雜訊。SPECS-INDEX #977 第 4 批(2026-10-06)新增 ''booking_confirmed'':服務人員確認接單時由 public.staff_confirm_booking 直接寫給商家管理員(純站內通知,推播設定沒有這個事件)。SPECS-INDEX #997 第 11 批 H(2026-10-07)新增 ''booking_completed_cancelled''(已完成訂單被取消)、''booking_completed_reverted''(已完成訂單被還原):由 private.notify_completed_booking_reversal 寫給其他管理員與有訂單管理權限的在職客服(純站內通知,推播設定沒有這兩個事件)。';

-- =========================================================================
-- ② private.notify_completed_booking_reversal(H-2 ~ H-6)
-- =========================================================================
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

  -- 原因:換行 / tab 換成一個半形空白;超過 60 字 ⇒ 前 60 字 + …(完整原因在訂單「操作記錄」)。
  v_reason := regexp_replace(coalesce(v_reason, ''), E'\r\n|[\r\n\t]', ' ', 'g');
  if char_length(v_reason) > 60 then
    v_reason := left(v_reason, 60) || '…';
  end if;

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

comment on function private.notify_completed_booking_reversal(uuid) is 'SPECS-INDEX #997 第 11 批 H:讀這張單最新一列 booking_completion_reversals,寫站內鈴鐺(booking_completed_cancelled / booking_completed_reverted)給同店其他管理員與有訂單管理權限的在職客服(排除操作者本人、同帳號只一則、服務人員不寫)。不看推播開關與 p_notify_requested;不發 LINE / 推播;內文不放電話 / 地址 / 金額 / 點數。只由 revert_completed_booking / cancel_completed_booking 在同一交易內呼叫。';

revoke execute on function private.notify_completed_booking_reversal(uuid) from public, anon, authenticated, service_role;

-- =========================================================================
-- ③ 兩支薄包裝改寫(H-7;簽章、security definer、search_path 不變;引擎一字不改)
-- =========================================================================
create or replace function public.revert_completed_booking(p_booking_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
begin
  -- 真正的管理員檢查在引擎裡(先擋權限再回報狀態)。還原不發 LINE / 推播(§3.7)。
  v_result := private.reverse_booking_completion(p_booking_id, 'accepted', p_reason, false);
  -- 第 11 批 H:同一交易寫站內鈴鐺給其他管理員與有訂單管理權限的在職客服;失敗整筆回滾。
  perform private.notify_completed_booking_reversal(p_booking_id);
  return v_result;
end;
$function$;

comment on function public.revert_completed_booking(uuid, text) is '#844 §4.3:還原完成(completed → accepted)。薄包裝,呼叫 private.reverse_booking_completion。只有商家管理員可以(引擎內 is_merchant_admin,42501);原因必填;匯入單擋下;不退折抵。不發 LINE / 推播;另寫站內鈴鐺給其他管理員與有訂單管理權限的在職客服(第 11 批 H)。回傳 jsonb(booking、action、commission_amount_reversed、report_month、is_cross_month、points{…})。';

revoke execute on function public.revert_completed_booking(uuid, text) from public, anon;
grant execute on function public.revert_completed_booking(uuid, text) to authenticated, service_role;

create or replace function public.cancel_completed_booking(
  p_booking_id uuid,
  p_reason text,
  p_notify_requested boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_result jsonb;
begin
  -- p_notify_requested 只用來寫稽核表 notified(管理員的選擇);LINE / 推播由前端在成功後依開關非同步發送(§4.4、§4.5)。
  v_result := private.reverse_booking_completion(p_booking_id, 'cancelled', p_reason, coalesce(p_notify_requested, false));
  -- 第 11 批 H:不論 p_notify_requested,同一交易寫站內鈴鐺給其他管理員與有訂單管理權限的在職客服;失敗整筆回滾。
  perform private.notify_completed_booking_reversal(p_booking_id);
  return v_result;
end;
$function$;

comment on function public.cancel_completed_booking(uuid, text, boolean) is '#844 §4.4:取消已完成訂單(completed → cancelled)。薄包裝,呼叫 private.reverse_booking_completion。只有商家管理員可以;原因必填(同時寫進 cancelled_reason);匯入單允許;先退回折抵凍結再收回入帳;抽成快照刪除並備份。p_notify_requested 只寫稽核 notified。不發 LINE / 推播;另寫站內鈴鐺給其他管理員與有訂單管理權限的在職客服(第 11 批 H,與開關無關)。';

revoke execute on function public.cancel_completed_booking(uuid, text, boolean) from public, anon;
grant execute on function public.cancel_completed_booking(uuid, text, boolean) to authenticated, service_role;
