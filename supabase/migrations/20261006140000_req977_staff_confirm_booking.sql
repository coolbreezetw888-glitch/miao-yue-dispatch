-- SPECS-INDEX #977 第 4 批(2026-10-06):服務人員接單確認。
-- 規格書 .project/specs/服務人員接單確認-第4批.md 第一、二節;主腦裁決見 notes/2026-10-02_最新提交修改問題_規劃.md「第4批開工」。
--
-- 本檔做兩件事:
--   ① 放寬 public.user_notifications 的 event_type CHECK,新增 'booking_confirmed'(只有這張表;
--      推播那 4 張表 push_event_subscriptions / push_notification_log / ... 與 push-notify-dispatch 一律不動)。
--   ② 新增 public.staff_confirm_booking(p_booking_id uuid):主要服務人員本人把自己的「待確認」訂單改成「已確認」
--      (資料庫值 accepted;資料庫沒有 confirmed),同一個交易內寫操作紀錄(actor_role_snapshot='staff')
--      與站內鈴鐺通知給該商家每一位商家管理員(不含客服、不發 LINE、不發推播)。
--
-- 為什麼不沿用 public.confirm_booking:那支只認 private.can_manage_bookings(管理員 / 客服),而且寫操作紀錄用的
-- private.log_booking_status_change 只會把角色判成 merchant_admin / agent、姓名只查 admins / agents,
-- 服務人員呼叫會被記成「客服(已移除的人員)」。所以這裡自己 insert 一列操作紀錄(欄位與 clock_timestamp()
-- 的寫法跟 log_booking_status_change 一致),log helper 本身不改。
--
-- ⚠️ 本檔沒有任何資料寫入或刪除(只有 alter constraint 與 create function)。放寬 CHECK 不會讓既有任何一列失效。

-- =========================================================================
-- ① user_notifications.event_type CHECK 放寬
-- =========================================================================
alter table public.user_notifications
  drop constraint user_notifications_event_type_check;
alter table public.user_notifications
  add constraint user_notifications_event_type_check check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day',
      -- SPECS-INDEX #977 第 4 批:服務人員確認接單 ⇒ 鈴鐺通知商家管理員。只由 public.staff_confirm_booking 寫入,
      -- 推播設定沒有這個事件(不能訂閱、不會響),純站內通知。
      'booking_confirmed'
    )
  );

comment on column public.user_notifications.event_type is '§13.2:刻意**不含** ''test'' —— 測試推播是使用者自己按出來的,記進鈴鐺只是雜訊。SPECS-INDEX #977 第 4 批(2026-10-06)新增 ''booking_confirmed'':服務人員確認接單時由 public.staff_confirm_booking 直接寫給商家管理員(純站內通知,推播設定沒有這個事件)。';

-- =========================================================================
-- ② public.staff_confirm_booking
-- =========================================================================
create or replace function public.staff_confirm_booking(p_booking_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_staff_id uuid;
  v_merchant_id uuid;
  v_status text;
  v_start_at timestamptz;
  v_customer_name text;
  v_staff_name text;
  v_body text;
begin
  -- 1. 第一步檢查身分:未登入一律擋。
  if v_uid is null then
    raise exception '請先登入' using errcode = '42501';
  end if;

  -- 2. 先不鎖列讀出這張單的主要服務人員(避免任何登入者都能對別人的訂單下 for update 造成排隊)。
  select b.staff_id, b.merchant_id
  into v_staff_id, v_merchant_id
  from public.bookings b
  where b.id = p_booking_id;

  -- 3. 放行條件(主腦裁決 ①):呼叫者必須是這張單的**主要服務人員**本人,
  --    且在職(status=active)、已開通登入(login_status=active)、開了「行事曆檢視」權限
  --    (跟 get_my_booking_schedule 看得到這張單的條件一致),並且服務人員紀錄屬於這張單的商家。
  --    找不到訂單 / 別人的單 / 別家商家一律回同一句,不透露訂單存不存在。
  if v_staff_id is null
     or not private.has_own_staff_permission(v_staff_id, 'staff_calendar_view')
     or not exists (
       select 1 from public.merchant_staff ms
       where ms.id = v_staff_id and ms.merchant_id = v_merchant_id
     ) then
    -- 協助人員看得到這張單(行事曆上標「協助」),給他一句看得懂的原因。
    -- 只限「目前在職且已開通登入」的協助人員:已移除 / 停用登入的前協助人員看不到這張單,
    -- 給他特別的原因等於透露訂單存在 ⇒ 一律落到下面的「沒有權限確認這筆訂單」。
    if v_staff_id is not null and exists (
      select 1
      from public.booking_assistants ba
      join public.merchant_staff ms on ms.id = ba.staff_id
      where ba.booking_id = p_booking_id
        and ms.user_id = v_uid
        and ms.status = 'active'
        and ms.login_status = 'active'
    ) then
      raise exception '只有這筆訂單的主要服務人員可以確認接單' using errcode = '42501';
    end if;
    raise exception '沒有權限確認這筆訂單' using errcode = '42501';
  end if;

  -- 4. 鎖列後再讀一次狀態(避免跟商家同時取消 / 確認互搶)。鎖到之後主要服務人員若已被換掉,也一律擋下。
  select b.status, b.start_at, b.customer_name
  into v_status, v_start_at, v_customer_name
  from public.bookings b
  where b.id = p_booking_id
    and b.staff_id = v_staff_id
  for update;

  if not found then
    raise exception '這筆訂單的服務人員已變更，請重新整理' using errcode = '42501';
  end if;

  if v_status <> 'pending_confirmation' then
    raise exception '這筆訂單已經不是待確認狀態，請重新整理';
  end if;

  -- 5. 改狀態。資料庫的「已確認」是 accepted(沒有 confirmed)。
  update public.bookings
  set status = 'accepted',
      last_modified_by_user_id = v_uid,
      last_modified_at = now()
  where id = p_booking_id;

  -- 6. 操作紀錄:角色 staff、姓名 = 該服務人員姓名(CHECK 已預留 'staff')。
  select ms.name into v_staff_name
  from public.merchant_staff ms
  where ms.id = v_staff_id;

  insert into public.booking_status_change_logs (
    booking_id, merchant_id, from_status, to_status,
    actor_user_id, actor_name_snapshot, actor_role_snapshot, created_at
  ) values (
    p_booking_id, v_merchant_id, v_status, 'accepted',
    v_uid, coalesce(nullif(btrim(v_staff_name), ''), '服務人員'), 'staff', clock_timestamp()
  );

  -- 7. 站內鈴鐺通知:該商家每一位商家管理員(merchant_admins 每一列;不含客服、不含其他服務人員)。
  --    文字只放服務人員姓名、預約時間、客戶姓名 —— 不放客戶電話、地址(主腦裁決 / 規格二之 2)。
  --    不發 LINE、不發推播(規格一之 4):這裡只寫 user_notifications 一張表。
  v_body := format(
    '服務人員「%s」已確認 %s「%s」的訂單。',
    coalesce(nullif(btrim(v_staff_name), ''), '服務人員'),
    to_char(v_start_at at time zone 'Asia/Taipei', 'YYYY/MM/DD HH24:MI'),
    v_customer_name
  );

  insert into public.user_notifications (
    user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body
  )
  select ma.user_id, v_merchant_id, 'admin', ma.id, 'booking_confirmed', p_booking_id,
         '服務人員已確認訂單', v_body
  from public.merchant_admins ma
  where ma.merchant_id = v_merchant_id;

  -- 8. 只回傳 id 與新狀態:**不回傳整列 bookings** —— 那會把客戶電話 / 地址送到服務人員手機上,
  --    繞過「服務人員是否顯示會員資料」關閉時的遮蔽(#977 第 3 批)。前端成功後自己重查行事曆。
  return jsonb_build_object('id', p_booking_id, 'status', 'accepted');
end;
$function$;

comment on function public.staff_confirm_booking(uuid) is 'SPECS-INDEX #977 第 4 批:主要服務人員本人把自己「待確認」的訂單改成「已確認」(accepted)。條件:本人 + 在職 + 已開通登入 + 行事曆檢視權限 + 訂單是 pending_confirmation(for update 鎖列)。同交易寫操作紀錄(actor_role_snapshot=staff)與站內鈴鐺通知給商家管理員(booking_confirmed)。不發 LINE / 推播。只回傳 {id, status},不回傳客戶資料。';

-- supabase-permission-hygiene 規則 1:revoke 要含 public;這支是服務人員端前端要呼叫的,所以留 authenticated。
revoke execute on function public.staff_confirm_booking(uuid) from public, anon;
grant execute on function public.staff_confirm_booking(uuid) to authenticated, service_role;
