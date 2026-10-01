-- SPECS-INDEX #972:LINE 通知(及推播)跨商家訂單/請假紀錄檢查(IDOR 修補)。
-- 規格書:.project/specs/LINE通知跨商家檢查.md
--
-- =========================================================================
-- 問題
-- =========================================================================
--   line-notify-dispatch 授權只檢查「呼叫者能管理傳入的 merchant_id」,沒檢查傳入的 booking_id /
--   staff_leave_record_id 屬於那間商家;下游這幾支函式又只用編號撈資料:
--     resolve_line_notification_targets       ← 用 booking_id 撈訂單,取被指派服務人員/會員的 line_user_id
--     render_booking_notification_variables   ← 只收 booking_id,組出客戶姓名/服務/金額/取消原因
--     render_staff_leave_notification_variables ← 只收 staff_leave_record_id,組出服務人員姓名/請假日期
--   ⇒ A 商家管理員/客服拿到 B 商家的訂單編號,可以用 A 的 LINE 帳號對 B 的服務人員/會員發送,
--     而且 B 訂單內容與對方 LINE 使用者編號會寫進 A 的發送記錄(A 自己看得到)。
--   推播 push-notify-dispatch 有同一個洞(render_booking_notification_variables 是兩邊共用的,
--   pushDbAdapter.getBookingStaffId 也只用 booking_id 查)。推播的收件人函式 resolve_push_recipients
--   本來就有 s.merchant_id = p_merchant_id,所以推播洩漏的是「B 訂單內容寫進 A 的推播紀錄 / 站內通知」。
--
-- =========================================================================
-- 修法(資料庫這一層;Edge Function 那一層另外在 index.ts 擋,兩層都擋 = 縱深防禦)
-- =========================================================================
--   1. resolve_line_notification_targets(簽章不變):
--      - 一開頭就檢查:有帶 p_booking_id → 那筆訂單必須存在且 merchant_id = p_merchant_id;
--        有帶 p_staff_leave_record_id → 那筆請假紀錄的服務人員必須屬於 p_merchant_id。
--        不符一律丟錯(errcode P0002,訊息不區分「不存在」與「別家的」,避免被拿來探測編號)。
--        為什麼丟錯不回空結果:Edge Function 只在拿到結果時才寫發送記錄;如果回 connected=true 的空清單,
--        管理員/客服那兩段(只看 p_merchant_id)還是會算出收件人,Edge 照樣會寫記錄、照樣發送 ——
--        丟錯則讓 Edge 走「判斷通知對象時發生錯誤」500 分支,一筆記錄都不寫。
--      - 放在「商家是否已連線 LINE」判斷之前:未連線的商家也不該能用別家編號得到任何不同的回應。
--      - 順帶(SPECS-INDEX #972 備註、#962 回報):服務人員分支補上推播早就有的
--        merchant_staff.merchant_id = p_merchant_id;會員分支補上 members.merchant_id = p_merchant_id。
--        正常資料下訂單的服務人員/會員本來就屬於同一商家,行為不變;只是不再單靠「訂單寫入時沒出錯」。
--        別家的服務人員 → 視同找不到 → staff_inactive(#962 已定「找不到這位服務人員也算不在職」);
--        別家的會員 → 視同未綁定 → target_not_bound。
--   2. render_booking_notification_variables:簽章改成 (p_booking_id uuid, p_merchant_id uuid),
--      訂單的 merchant_id 跟 p_merchant_id 不同(或 p_merchant_id 為 null)→ 丟錯 P0002。
--      p_merchant_id 刻意**不給 default**(supabase-permission-hygiene 規則 4:default 會讓漏改的呼叫端
--      靜默走舊路);服務人員姓名的查詢也補上 merchant_id 條件。
--   3. render_staff_leave_notification_variables:簽章改成 (p_staff_leave_record_id uuid, p_merchant_id uuid)。
--      查無此紀錄 → 維持既有行為回 '{}'(module11_03 釘住的安靜路徑);
--      紀錄存在但服務人員不屬於 p_merchant_id → 丟錯 P0002。
--   2、3 是 drop + create 換簽章 ⇒ 依 supabase-permission-hygiene 規則 1,revoke/grant 整組重寫。
--
-- =========================================================================
-- ⚠️ 部署順序(本檔換了兩支函式的簽章,Edge Function 必須同時重新部署)
-- =========================================================================
--   套用本 migration 之後,舊版 Edge Function 呼叫 render_*(只帶一個參數)會 PGRST202 → 變數組裝失敗
--   → 舊程式回傳 {} → 文案裡的 {{變數}} 原樣送出。所以本檔套上去之後要**立刻**重新部署:
--     line-notify-dispatch、push-notify-dispatch、push-notify-reminder-dispatch(後兩支共用 pushDbAdapter)。
--   (反過來先部署 Edge 也一樣有空窗:新程式帶兩個參數打舊函式同樣 PGRST202,所以順序是 migration → 立刻部署。)
--
-- =========================================================================
-- 改前指紋(正式庫 wjtbmmnakcriuaqoknsq 2026-10-01 唯讀,md5(replace(prosrc, CRLF, LF)),= 本機)
-- =========================================================================
--   resolve_line_notification_targets          bc0447b09a36ab17d09b2ba4b15a3f6c(= #962 20261001140000 版)
--   render_booking_notification_variables      2975e3b35f48da2e140cacf6d3d064ee(= #844 20261001090200 版)
--   render_staff_leave_notification_variables  ac0b5b78c576bf018b27cd87080d9cc6(= 20260920160600 版)
--   三支都以線上版為底改寫;本檔所有說明寫在 $$ 之外,函式本體不含註解。
-- ⚠️ 時間戳排在 20261001140000 之後。

create or replace function public.resolve_line_notification_targets(
  p_merchant_id uuid,
  p_event_type text,
  p_booking_id uuid default null,
  p_staff_leave_record_id uuid default null
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_is_connected boolean;
  v_settings public.merchant_line_event_settings;
  v_booking public.bookings;
  v_targets jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_member_bound boolean;
  v_member_name text;
begin
  if p_booking_id is not null and not exists (
    select 1 from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆預約,或它不屬於這個商家' using errcode = 'P0002';
  end if;

  if p_staff_leave_record_id is not null and not exists (
    select 1 from public.staff_leave_records r
    join public.merchant_staff ms on ms.id = r.staff_id
    where r.id = p_staff_leave_record_id and ms.merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆請假紀錄,或它不屬於這個商家' using errcode = 'P0002';
  end if;

  select is_connected into v_is_connected
  from public.merchant_line_configs where merchant_id = p_merchant_id;

  if coalesce(v_is_connected, false) = false then
    return jsonb_build_object(
      'connected', false, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb
    );
  end if;

  select * into v_settings
  from public.merchant_line_event_settings
  where merchant_id = p_merchant_id and event_type = p_event_type;

  if v_settings.id is null or not v_settings.enabled then
    return jsonb_build_object(
      'connected', true, 'event_enabled', false, 'targets', '[]'::jsonb, 'skipped', '[]'::jsonb
    );
  end if;

  if p_booking_id is not null then
    select * into v_booking from public.bookings
    where id = p_booking_id and merchant_id = p_merchant_id;
  end if;

  if v_settings.notify_staff and v_booking.id is not null then
    if v_booking.staff_id is not null
       and not exists (
         select 1 from public.merchant_staff
         where id = v_booking.staff_id and merchant_id = p_merchant_id and status = 'active'
       ) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_inactive')
      );
    elsif v_booking.staff_id is not null
       and not private.staff_calendar_view_allows_notifications(v_booking.staff_id) then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'staff_calendar_view_off')
      );
    elsif exists (
      select 1 from public.merchant_staff
      where id = v_booking.staff_id and merchant_id = p_merchant_id and line_bound = true
    ) then
      v_targets := v_targets || jsonb_build_array(jsonb_build_object(
        'type', 'staff', 'id', v_booking.staff_id,
        'name', (select name from public.merchant_staff where id = v_booking.staff_id and merchant_id = p_merchant_id),
        'line_user_id', (select line_user_id from public.merchant_staff where id = v_booking.staff_id and merchant_id = p_merchant_id)
      ));
    else
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'staff', 'id', v_booking.staff_id, 'reason', 'target_not_bound')
      );
    end if;
  end if;

  if v_settings.notify_member and v_booking.id is not null then
    if v_booking.member_id is null then
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('type', 'member', 'id', null, 'reason', 'no_target')
      );
    else
      select name, line_bound into v_member_name, v_member_bound
      from public.members where id = v_booking.member_id and merchant_id = p_merchant_id;

      if coalesce(v_member_bound, false) then
        v_targets := v_targets || jsonb_build_array(jsonb_build_object(
          'type', 'member', 'id', v_booking.member_id, 'name', v_member_name,
          'line_user_id', (select line_user_id from public.members where id = v_booking.member_id and merchant_id = p_merchant_id)
        ));
      else
        v_skipped := v_skipped || jsonb_build_array(
          jsonb_build_object('type', 'member', 'id', v_booking.member_id, 'reason', 'target_not_bound')
        );
      end if;
    end if;
  end if;

  if v_settings.notify_admin then
    v_targets := v_targets || coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', 'admin', 'id', id, 'name', coalesce(display_name, '商家管理員'), 'line_user_id', line_user_id
      ))
      from public.merchant_admins where merchant_id = p_merchant_id and line_bound = true
    ), '[]'::jsonb);
    v_skipped := v_skipped || coalesce((
      select jsonb_agg(jsonb_build_object('type', 'admin', 'id', id, 'reason', 'target_not_bound'))
      from public.merchant_admins where merchant_id = p_merchant_id and line_bound = false
    ), '[]'::jsonb);
  end if;

  if v_settings.notify_agent then
    v_targets := v_targets || coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', 'agent', 'id', id, 'name', name, 'line_user_id', line_user_id
      ))
      from public.merchant_agents
      where merchant_id = p_merchant_id and status = 'active' and line_bound = true
    ), '[]'::jsonb);
    v_skipped := v_skipped || coalesce((
      select jsonb_agg(jsonb_build_object('type', 'agent', 'id', id, 'reason', 'target_not_bound'))
      from public.merchant_agents
      where merchant_id = p_merchant_id and status = 'active' and line_bound = false
    ), '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'connected', true,
    'event_enabled', true,
    'targets', v_targets,
    'skipped', v_skipped
  );
end;
$$;

comment on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) is '3.10 邊界情況:preview_line_notification_targets(前端預覽)跟 line-notify-dispatch(實際發送判斷)共用的唯一一份判斷邏輯,避免兩邊分岔造成「彈窗說會通知,結果沒有通知」。⚠️ 函式內部完全沒有權限檢查,只能給 service_role(Edge Function)直接呼叫,前端一律走有 can_manage_bookings 檢查、且會濾掉 line_user_id 的 preview_line_notification_targets 包裝函式。2026-09-24 安全修補:原本漏掉 revoke authenticated,導致任何登入者都能帶任意 merchant_id 撈走該商家所有管理員/客服的 line_user_id。SPECS-INDEX #876:服務人員分支要求「行事曆檢視」是開的(private.staff_calendar_view_allows_notifications)。SPECS-INDEX #962:服務人員分支另要求在職(merchant_staff.status = active,與 resolve_push_recipients 同一道);不寄的服務人員列入跳過清單,原因依序為 staff_inactive(已離職/停用)、staff_calendar_view_off(未開放行事曆檢視)、target_not_bound(未綁 LINE)。SPECS-INDEX #972:有帶 p_booking_id / p_staff_leave_record_id 時,該訂單/請假紀錄必須屬於 p_merchant_id,否則丟錯 P0002(跨商家 IDOR 修補);服務人員/會員查詢一併加上 merchant_id = p_merchant_id。';

revoke execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  to service_role;

-- =========================================================================
-- render_booking_notification_variables:(uuid) → (uuid, uuid)
-- =========================================================================
drop function public.render_booking_notification_variables(uuid);

create function public.render_booking_notification_variables(p_booking_id uuid, p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_merchant_name text;
  v_service_names text;
  v_staff_name text;
  v_points_earned int;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null or v_booking.merchant_id is distinct from p_merchant_id then
    raise exception '找不到這筆預約,或它不屬於這個商家' using errcode = 'P0002';
  end if;

  select name into v_merchant_name from public.merchants where id = v_booking.merchant_id;

  select string_agg(si.name, '、' order by bsi.created_at)
  into v_service_names
  from public.booking_service_items bsi
  join public.service_items si on si.id = bsi.service_item_id
  where bsi.booking_id = p_booking_id;

  select name into v_staff_name from public.merchant_staff
  where id = v_booking.staff_id and merchant_id = v_booking.merchant_id;

  select sum(points_delta)::int into v_points_earned
  from public.member_point_transactions
  where booking_id = p_booking_id
    and member_id = v_booking.member_id
    and transaction_type in ('earn_booking', 'earn_booking_reversal');

  if v_points_earned is not null and v_points_earned <= 0 then
    v_points_earned := null;
  end if;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'customer_name', coalesce(v_booking.customer_name, ''),
    'booking_date', to_char(v_booking.start_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI'),
    'service_names', coalesce(v_service_names, ''),
    'final_amount', coalesce(trim(to_char(v_booking.final_amount_snapshot, 'FM999999990')), ''),
    'staff_name', coalesce(v_staff_name, ''),
    'member_name', coalesce(v_booking.member_name_snapshot, ''),
    'cancel_reason', coalesce(v_booking.cancelled_reason, ''),
    'points_earned', coalesce(v_points_earned::text, '')
  );
end;
$$;

comment on function public.render_booking_notification_variables(uuid, uuid) is '3.9:LINE 通知 / 推播共用的訂單文案變數組裝。#844 §4.8:points_earned = 本單、本單目前會員的有效入帳(入帳 − 收回)。SPECS-INDEX #972:必須同時帶 p_merchant_id,訂單不屬於該商家(或 p_merchant_id 為 null)一律丟錯 P0002,防止用別家訂單編號把別家訂單內容組進自己的通知;刻意不給 default。只給 service_role。';

revoke execute on function public.render_booking_notification_variables(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.render_booking_notification_variables(uuid, uuid)
  to service_role;

-- =========================================================================
-- render_staff_leave_notification_variables:(uuid) → (uuid, uuid)
-- =========================================================================
drop function public.render_staff_leave_notification_variables(uuid);

create function public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid, p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_record public.staff_leave_records;
  v_staff_name text;
  v_merchant_name text;
  v_booking_date text;
begin
  select * into v_record from public.staff_leave_records where id = p_staff_leave_record_id;
  if v_record.id is null then
    return '{}'::jsonb;
  end if;

  select ms.name, m.name
  into v_staff_name, v_merchant_name
  from public.merchant_staff ms
  join public.merchants m on m.id = ms.merchant_id
  where ms.id = v_record.staff_id and ms.merchant_id = p_merchant_id;

  if not found then
    raise exception '找不到這筆請假紀錄,或它不屬於這個商家' using errcode = 'P0002';
  end if;

  if v_record.start_date = v_record.end_date then
    v_booking_date := to_char(v_record.start_date, 'YYYY-MM-DD');
  else
    v_booking_date := to_char(v_record.start_date, 'YYYY-MM-DD') || ' 至 ' || to_char(v_record.end_date, 'YYYY-MM-DD');
  end if;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'staff_name', coalesce(v_staff_name, ''),
    'booking_date', coalesce(v_booking_date, ''),
    'leave_type_name', coalesce(v_record.leave_type_name_snapshot, '')
  );
end;
$$;

comment on function public.render_staff_leave_notification_variables(uuid, uuid) is 'SPECS-INDEX 385:staff_leave_created 事件的文案變數組裝。查無此請假紀錄回 {}(安靜路徑)。SPECS-INDEX #972:必須同時帶 p_merchant_id,請假紀錄的服務人員不屬於該商家(或 p_merchant_id 為 null)一律丟錯 P0002;刻意不給 default。只給 service_role。';

revoke execute on function public.render_staff_leave_notification_variables(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.render_staff_leave_notification_variables(uuid, uuid)
  to service_role;
