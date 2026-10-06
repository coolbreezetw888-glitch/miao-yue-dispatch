-- SPECS-INDEX #986 第 9 批(2026-10-07,使用者裁決 10「確認接單後客服也收到鈴鐺」)。
-- 規格:.project/specs/使用者裁決小項與第7批調整-第9批.md 3-5(需求 9-16)。
--
-- 重建 public.staff_confirm_booking(uuid)。底稿 = 本機最新定義(20261006140000,之後沒有其他版本),逐字保留;
-- 只在第 7 步管理員那段 insert 之後加一段(包在 [req986-batch9 begin] … [req986-batch9 end]),
-- 並把第 7 步開頭那行註解改成新說明(pgTAP req986_02 把段落拿掉、註解換回原文後,指紋必須等於改前)。
--   改前指紋 6e2bf9642b01b633ac0275f7fc85996a
-- 客服:同商家、在職、有 user_id、merchant_agent_permissions(orders, granted = true);同一帳號已以管理員收到就不重複。
-- 仍然不發 LINE、不發推播;鈴鐺維持非即時。簽章不變,ACL 重申。

CREATE OR REPLACE FUNCTION public.staff_confirm_booking(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 7. 站內鈴鐺通知:該商家每一位商家管理員(merchant_admins 每一列),以及有「訂單管理」權限的在職客服(#986 第 9 批);不含其他服務人員。
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
  -- [req986-batch9 begin] #986 第 9 批(9-16,使用者裁決 10):有「訂單管理」權限的在職客服也收到同一則鈴鐺。
  --   條件:同商家、status = 'active'、user_id 不是 null、merchant_agent_permissions(orders, granted = true)。
  --   去重:同一個登入帳號已經以管理員身分收到 ⇒ 不再以客服身分寫第二則。標題 / 內文跟管理員那則同一份。
  insert into public.user_notifications (
    user_id, merchant_id, target_type, target_id, event_type, booking_id, title, body
  )
  select g.user_id, v_merchant_id, 'agent', g.id, 'booking_confirmed', p_booking_id,
         '服務人員已確認訂單', v_body
  from public.merchant_agents g
  where g.merchant_id = v_merchant_id
    and g.status = 'active'
    and g.user_id is not null
    and exists (
      select 1 from public.merchant_agent_permissions p
      where p.agent_id = g.id and p.section_key = 'orders' and p.granted = true
    )
    and not exists (
      select 1 from public.merchant_admins ma2
      where ma2.merchant_id = v_merchant_id and ma2.user_id = g.user_id
    );
  -- [req986-batch9 end]

  -- 8. 只回傳 id 與新狀態:**不回傳整列 bookings** —— 那會把客戶電話 / 地址送到服務人員手機上,
  --    繞過「服務人員是否顯示會員資料」關閉時的遮蔽(#977 第 3 批)。前端成功後自己重查行事曆。
  return jsonb_build_object('id', p_booking_id, 'status', 'accepted');
end;
$function$;

comment on function public.staff_confirm_booking(uuid) is 'SPECS-INDEX #977 第 4 批 / #986 第 9 批:主要服務人員本人把自己「待確認」的訂單改成「已確認」(accepted)。條件:本人 + 在職 + 已開通登入 + 行事曆檢視權限 + 訂單是 pending_confirmation(for update 鎖列)。同交易寫操作紀錄(actor_role_snapshot=staff)與站內鈴鐺通知給商家管理員與有訂單管理權限的在職客服(booking_confirmed;同一帳號只一則)。不發 LINE / 推播。只回傳 {id, status},不回傳客戶資料。';

revoke execute on function public.staff_confirm_booking(uuid) from public, anon;
grant execute on function public.staff_confirm_booking(uuid) to authenticated, service_role;
