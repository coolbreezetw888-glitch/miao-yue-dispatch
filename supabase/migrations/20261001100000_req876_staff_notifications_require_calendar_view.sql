-- SPECS-INDEX #876(2026-09-30 使用者裁決 a):管理員關掉某位服務人員的「行事曆檢視」
-- (merchant_staff_permissions.section_key = 'staff_calendar_view')之後,這位服務人員
-- **不再收到**任何會帶出訂單/客戶內容的推播(含站內鈴鐺)與 LINE 通知。
-- 規格書:.project/specs/通知權限與CSV公式注入修正.md 第一章。
--
-- =========================================================================
-- 架構查證(engineer 2026-10-01):收件人是「當場決定」,沒有佇列
-- =========================================================================
--   * 推播:push-notify-dispatch(前端建單/改單後呼叫)與 push-notify-reminder-dispatch(pg_cron
--     每天跑的隔日提醒)都在**送出的那一刻**呼叫 public.resolve_push_recipients 決定收件人
--     (_shared/pushDbAdapter.ts → resolveRecipients),#823「被換掉的原服務人員」也是同一支。
--     站內鈴鐺 user_notifications 是推播流程逐收件人寫入的,跟著同一份收件人清單。
--   * LINE:line-notify-dispatch 在送出當下呼叫 public.resolve_line_notification_targets;
--     前端預覽彈窗 preview_line_notification_targets 也走同一支(預覽會跟實際一致)。
--   * 全專案唯一的「先排隊、之後才寄」是 birthday-line-dispatch(claim_birthday_line_pending),
--     收件人是**會員**,跟服務人員無關,不在本條範圍。
--   ⇒ 不存在「關掉權限前已經排進佇列」的通知;只要改這兩支收件人判斷,關掉的下一刻起就生效。
--
-- =========================================================================
-- 為什麼不直接呼叫 private.has_own_staff_permission
-- =========================================================================
--   has_own_staff_permission 第一道是 private.is_own_staff_row(p_staff_id) —— 比對
--   merchant_staff.user_id = auth.uid()。通知流程是 Edge Function 用 service_role 呼叫
--   (auth.uid() 為 null)或由商家管理員/客服觸發,**永遠不是服務人員本人** ⇒ 直接套用會讓所有
--   服務人員一律收不到任何通知。所以抽出一支不看 auth.uid() 的判斷函式(下方 helper)。
--
-- =========================================================================
-- 「沒有權限紀錄」怎麼算(SPECS-INDEX #877 的同一個事實)
-- =========================================================================
--   四筆權限紀錄是服務人員**第一次完成登入**時才由 seed_default_staff_permissions 建立,且一律
--   granted = true。還沒登入的服務人員(正式庫 2026-10-01 唯讀查:not_invited 261 位)一筆紀錄
--   都沒有,但他們可能已經綁定 LINE、正在收 LINE 通知。
--   ⇒ 已開通登入(login_status = 'active'):跟行事曆完全同一個標準 —— 必須有 granted = true
--     的紀錄才算開(紀錄遺失 = 看不到行事曆 = 也不收通知,往安全的方向)。
--   ⇒ 尚未開通登入:沒有紀錄 = 系統預設(登入時會被種成「開」)⇒ 照舊寄;只有管理員**明確
--     關掉**(set_staff_permission 寫入 granted = false,登入時的 seed 是 on conflict do nothing,
--     不會蓋掉)才不寄。
--   正式庫現況(2026-10-01 唯讀):已登入 51 位全部有 granted = true 的紀錄、全庫 0 筆 false
--   ⇒ 本 migration 套上去的當下,實際收件人一位都不會變;只有之後管理員關掉開關才會生效。
--
-- ⚠️ supabase-permission-hygiene 規則 1:三支函式都把 revoke/grant 整組重寫。
-- ⚠️ 規則 6:兩支既有函式改前已對正式庫取 md5(prosrc)(CRLF→LF):
--      resolve_push_recipients           9582b6c163d365f5655c43c8b0168119(= repo 版,逐字一致)
--      resolve_line_notification_targets cb280b7f12def8b573bea05ba6413bb2(= repo 版拿掉函式本體內
--      4 行純註解後逐字一致;差異只在註解,可執行 SQL 相同)
--    本檔刻意把所有說明都寫在 $$ 之外,函式本體不含註解,套用後指紋比對不會再因註解被壓縮而對不上。
-- ⚠️ 時間戳排在 #844(20261001090200)之後。

-- =========================================================================
-- helper:這位服務人員目前「行事曆檢視」是不是開的(通知用,不看 auth.uid())
-- 只給本檔兩支 SECURITY DEFINER 收件人函式在函式擁有者身分下呼叫;三個角色全部收回。
-- 找不到這位服務人員 → false。
-- =========================================================================
create or replace function private.staff_calendar_view_allows_notifications(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
      when ms.login_status = 'active' then exists (
        select 1 from public.merchant_staff_permissions msp
        where msp.staff_id = ms.id
          and msp.section_key = 'staff_calendar_view'
          and msp.granted = true
      )
      else not exists (
        select 1 from public.merchant_staff_permissions msp
        where msp.staff_id = ms.id
          and msp.section_key = 'staff_calendar_view'
          and msp.granted = false
      )
    end
    from public.merchant_staff ms
    where ms.id = p_staff_id
  ), false);
$$;

comment on function private.staff_calendar_view_allows_notifications(uuid) is 'SPECS-INDEX #876:服務人員「行事曆檢視」是否開啟(通知收件人判斷專用,不看 auth.uid())。已開通登入者必須有 granted=true 紀錄(與 get_my_booking_schedule 同標準);尚未開通登入者沒有紀錄視為預設開,只有明確 granted=false 才算關。找不到服務人員回 false。只給 resolve_push_recipients / resolve_line_notification_targets 內部呼叫。';

revoke execute on function private.staff_calendar_view_allows_notifications(uuid)
  from public, anon, authenticated;

-- =========================================================================
-- 推播收件人:服務人員分支多一道 #876 判斷;管理員/客服分支逐字不變。
-- =========================================================================
create or replace function public.resolve_push_recipients(
  p_merchant_id uuid,
  p_event_type text,
  p_booking_staff_id uuid
)
returns table (
  target_type text,
  target_id uuid,
  target_user_id uuid,
  target_name text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select 'staff'::text, s.id, s.user_id, coalesce(nullif(trim(s.name), ''), '服務人員')
  from public.push_event_subscriptions pes
  join public.merchant_staff s on s.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'staff'
    and pes.event_type = p_event_type
    and pes.enabled
    and p_booking_staff_id is not null
    and s.id = p_booking_staff_id
    and s.merchant_id = p_merchant_id
    and s.status = 'active'
    and s.login_status = 'active'
    and s.user_id is not null
    and private.staff_calendar_view_allows_notifications(s.id)

  union all

  select 'admin'::text, a.id, a.user_id, coalesce(nullif(trim(a.display_name), ''), '商家管理員')
  from public.push_event_subscriptions pes
  join public.merchant_admins a on a.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'admin'
    and pes.event_type = p_event_type
    and pes.enabled
    and a.merchant_id = p_merchant_id
    and a.user_id is not null

  union all

  select 'agent'::text, g.id, g.user_id, coalesce(nullif(trim(g.name), ''), '客服')
  from public.push_event_subscriptions pes
  join public.merchant_agents g on g.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'agent'
    and pes.event_type = p_event_type
    and pes.enabled
    and g.merchant_id = p_merchant_id
    and g.status = 'active'
    and g.user_id is not null;
$$;

comment on function public.resolve_push_recipients(uuid, text, uuid) is '§5.1:回傳這個事件的收件人清單(target_type/target_id/target_user_id/target_name)。兩支 Edge Function 共用,不在 TypeScript 裡各自拼 SQL。刻意不去重 —— 同一個 target_user_id 可能因為多重身份出現多次,去重發生在裝置層(§4.3),因為 log 要一個身份一列。SPECS-INDEX #876:服務人員分支另外要求「行事曆檢視」是開的(private.staff_calendar_view_allows_notifications),關掉就不推播、也不進站內鈴鐺。只有 service role 能呼叫。';

revoke execute on function public.resolve_push_recipients(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_push_recipients(uuid, text, uuid) to service_role;

-- =========================================================================
-- LINE 收件人:服務人員分支在「已綁定」判斷之前多一道 #876 判斷。
--   * 關掉 ⇒ 既不進 targets、也不進 skipped(line_notification_log.skip_reason 的 CHECK 沒有對應的
--     原因值;要不要新增一個「權限關閉」的跳過原因留給主腦決定,本檔不擴充 schema)。
--   * 訂單沒有指派服務人員(staff_id 為 null)時維持原行為(照舊記 target_not_bound)。
--   * 會員/管理員/客服分支逐字不變。
-- =========================================================================
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
    select * into v_booking from public.bookings where id = p_booking_id;
  end if;

  if v_settings.notify_staff and v_booking.id is not null then
    if v_booking.staff_id is not null
       and not private.staff_calendar_view_allows_notifications(v_booking.staff_id) then
      null;
    elsif exists (select 1 from public.merchant_staff where id = v_booking.staff_id and line_bound = true) then
      v_targets := v_targets || jsonb_build_array(jsonb_build_object(
        'type', 'staff', 'id', v_booking.staff_id,
        'name', (select name from public.merchant_staff where id = v_booking.staff_id),
        'line_user_id', (select line_user_id from public.merchant_staff where id = v_booking.staff_id)
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
      from public.members where id = v_booking.member_id;

      if coalesce(v_member_bound, false) then
        v_targets := v_targets || jsonb_build_array(jsonb_build_object(
          'type', 'member', 'id', v_booking.member_id, 'name', v_member_name,
          'line_user_id', (select line_user_id from public.members where id = v_booking.member_id)
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

comment on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) is '3.10 邊界情況:preview_line_notification_targets(前端預覽)跟 line-notify-dispatch(實際發送判斷)共用的唯一一份判斷邏輯,避免兩邊分岔造成「彈窗說會通知,結果沒有通知」。⚠️ 函式內部完全沒有權限檢查,只能給 service_role(Edge Function)直接呼叫,前端一律走有 can_manage_bookings 檢查、且會濾掉 line_user_id 的 preview_line_notification_targets 包裝函式。2026-09-24 安全修補:原本漏掉 revoke authenticated,導致任何登入者都能帶任意 merchant_id 撈走該商家所有管理員/客服的 line_user_id。SPECS-INDEX #876:服務人員分支另外要求「行事曆檢視」是開的(private.staff_calendar_view_allows_notifications),關掉就不寄、也不列入跳過清單。';

revoke execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  to service_role;
