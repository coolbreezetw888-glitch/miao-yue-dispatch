-- SPECS-INDEX #1011(第 17 批,2026-10-08):請假 / 營業時間 / 服務人員資料變動,也要即時同步到行事曆
-- 規格書:.project/specs/行事曆即時同步補齊-第17批.md
-- 沿用:秒約/.claude/skills/staff-realtime-sync 的整套規矩;第 14 批 20261007160000 的商家頻道
--       merchant:<merchant_id>:calendar(private.notify_merchant_calendar_changed / notify_merchant_calendar_for_staff)
--       與 #874 的服務人員頻道 staff:<staff_id>:schedule(private.notify_staff_schedule_changed)。
--
-- =========================================================================
-- 改前查證(行事曆畫面實際讀了哪些欄位)
-- =========================================================================
--   商家端行事曆(CalendarPage):
--     ・get_merchant_day_schedule:merchant_business_hours(merchant_id, day_of_week, is_closed, open_time,
--       close_time);merchant_staff(id, merchant_id, status = 'active' 篩選, name 顯示與排序,
--       unlimited_backend_edit 決定可約時段);staff_leave_records(staff_id, status = 'confirmed',
--       start_date, end_date, leave_type_name_snapshot, id);外店灰格靠 private.same_person_staff_ids_in_group
--       ⇒ merchant_staff.phone(正規化後)+ 所屬商家的 group_id。
--     ・useMerchantStaffList(merchant_staff select *,status = 'active',order by name):畫面只用 id / name。
--   服務人員端行事曆(MyCalendarPage / MyCalendarTimelineView):
--     ・get_my_day_business_hours:自己商家的 merchant_business_hours(同上 5 欄)。
--     ・get_my_day_schedule_state:自己的 staff_leave_records(同上)+ 同集團同一個人的外店佔用(phone)。
--     ・get_my_booking_schedule:merchant_staff.show_member_info(決定客戶電話 / 地址 / 會員欄位顯不顯示)。
--     ・my-staff-record(merchant_staff 自己那一列):status、unlimited_backend_edit、can_create_edit_orders、
--       show_member_info、compensation_type(決定能不能建單 / 拖拉 / 開關時段)、name。
--
-- =========================================================================
-- 這支 migration 做什麼(只新增 trigger,不改任何既有函式)
-- =========================================================================
--   1. staff_leave_records(請假)INSERT / DELETE,或 UPDATE 動到 staff_id / status / start_date /
--      end_date / leave_type_name_snapshot ⇒ 那位服務人員所屬商家 + 那位服務人員本人。
--      notes / cancelled_at / created_by_user_id / updated_at 單獨變動不發(行事曆沒顯示)。
--      🔸 不跨店 fan-out:請假只擋「那一列服務人員」自己(check_staff_booking_slot 只查 p_staff.id 的請假;
--         get_merchant_day_schedule 的外店灰格只算訂單、不算請假;get_my_day_schedule_state 的 on_leave
--         也只查自己)⇒ 同集團同一個人在別家店的畫面與可預約判斷都不受影響。
--   2. merchant_business_hours(營業時間,公休 = is_closed)INSERT / DELETE,或 UPDATE 動到 merchant_id /
--      day_of_week / is_closed / open_time / close_time ⇒ 該商家 + 該商家所有「在職 + 已開通登入」的服務人員
--      (notify_staff_schedule_changed 內部再篩一次行事曆檢視權限)。updated_at 單獨變動不發
--      (營業時間頁整批 upsert 7 天、值沒變 ⇒ 0 則)。不跨店:外店灰格不看別家店的營業時間。
--   3. merchant_staff(服務人員資料):
--      ・商家端:INSERT 一位在職的人 / DELETE / UPDATE 動到 merchant_id、name、status、
--        unlimited_backend_edit、正規化後的 phone ⇒ 所屬商家(換商家時新舊兩間)。
--      ・服務人員本人:UPDATE 動到上面那些,或 can_create_edit_orders / show_member_info /
--        compensation_type ⇒ 本人(notify_staff_schedule_changed 只發給在職 + 已開通 + 有行事曆檢視的人)。
--      ・同集團跨店:正規化後的 phone 變了(或換商家 / 刪除)⇒「同一個人」的對應關係變了,
--        同集團裡舊電話、新電話相同的其他列,他們的外店灰格會多 / 少 ⇒ 通知那些列的商家與服務人員本人。
--      ・不發:intro、avatar_url、nickname、is_listed、line_*、no_time_slot_limit(只影響客戶線上預約)、
--        advance_booking_days、login_* 等行事曆沒讀的欄位;phone 只是格式不同(正規化後相同)也不發。
--
--   🔴 訊號內容不變:商家頻道 {"v":1,"reason":"calendar_changed"},服務人員頻道 {"v":1,"reason":"schedule_changed"}
--     (外加 realtime.send 自動補的 id),全部沿用既有發送函式。不帶請假假別 / 備註 / 姓名 / 電話 / 日期 / id。
--   去重:沿用既有交易內 GUC(miaoyue.rt_merchant_notified、miaoyue.rt_staff_notified)。
--   例外保護:既有發送函式本身吞錯;本檔的「查名單 / 迴圈」與每一段呼叫再分段包進
--     begin … exception when others ⇒ 只留 WARNING 'WarnCalendarLiveSync: …',存檔照常成功。
--     商家段與服務人員段分開包 ⇒ 一段壞掉不會把另一段已發出的訊號一起回滾。WHEN OTHERS 不吞 query_canceled。
--
-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1 / 6)
-- =========================================================================
--   新函式全部 private、SECURITY DEFINER、set search_path = public,對 public / anon / authenticated
--   全部 revoke EXECUTE(只給 trigger 以 owner 身分呼叫)。realtime.messages 政策不動(仍只有 2 條 SELECT,
--   沒有任何寫入政策)。函式本體內不寫註解,套正式庫後 md5(prosrc)(先 CRLF→LF)指紋比對才穩定。
--
-- =========================================================================
-- 上線注意
-- =========================================================================
--   ・依賴 20261001110000(#874)、20261007160000(#1003)⇒ 必須在它們之後套用。
--   ・前端同一批:服務人員端收到訊號多重抓 my-day-business-hours、my-staff-record;商家端多重抓 staff-list。
--   ・之後的資料修正 migration 直接改這三張表,也會對受影響的商家 / 服務人員發訊號 —— 預期、無害。
--
-- 用語:一律「服務人員」。

-- =========================================================================
-- 1. 某間商家的營業時間變了 ⇒ 商家行事曆 + 該商家在職且已開通登入的服務人員
-- =========================================================================
create or replace function private.notify_calendar_for_merchant_hours(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
begin
  if p_merchant_id is null then
    return;
  end if;

  begin
    perform private.notify_merchant_calendar_changed(p_merchant_id);
  exception
    when others then
      raise warning 'WarnCalendarLiveSync: %', sqlerrm;
  end;

  begin
    for v_staff_id in
      select ms.id
      from public.merchant_staff ms
      where ms.merchant_id = p_merchant_id
        and ms.status = 'active'
        and ms.login_status = 'active'
    loop
      perform private.notify_staff_schedule_changed(v_staff_id);
    end loop;
  exception
    when others then
      raise warning 'WarnCalendarLiveSync: %', sqlerrm;
  end;
end;
$$;

comment on function private.notify_calendar_for_merchant_hours(uuid) is 'SPECS-INDEX #1011:商家營業時間有變動 ⇒ 通知該商家的行事曆(merchant:<id>:calendar)與該商家在職、已開通登入的服務人員(staff:<id>:schedule,notify_staff_schedule_changed 內部再篩行事曆檢視權限)。兩段分開例外保護,任何錯誤只記 WARNING。三個角色都沒有 EXECUTE。';

revoke execute on function private.notify_calendar_for_merchant_hours(uuid) from public, anon, authenticated;

-- =========================================================================
-- 2. 同集團「同一個人」的對應關係變了 ⇒ 同集團裡電話(正規化後)= p_phone 的其他列:商家 + 服務人員本人
-- =========================================================================
create or replace function private.notify_calendar_for_phone_peers(p_staff_id uuid, p_merchant_id uuid, p_phone text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
  v_peer record;
begin
  if p_merchant_id is null or p_phone is null then
    return;
  end if;

  begin
    v_phone := private.normalize_phone(p_phone);
    if v_phone is null then
      return;
    end if;

    for v_peer in
      select ms.id, ms.merchant_id
      from public.merchants me
      join public.merchants om on om.group_id = me.group_id
      join public.merchant_staff ms on ms.merchant_id = om.id
      where me.id = p_merchant_id
        and me.group_id is not null
        and ms.id is distinct from p_staff_id
        and private.normalize_phone(ms.phone) = v_phone
    loop
      perform private.notify_merchant_calendar_changed(v_peer.merchant_id);
      perform private.notify_staff_schedule_changed(v_peer.id);
    end loop;
  exception
    when others then
      raise warning 'WarnCalendarLiveSync: %', sqlerrm;
  end;
end;
$$;

comment on function private.notify_calendar_for_phone_peers(uuid, uuid, text) is 'SPECS-INDEX #1011:服務人員電話(正規化後)/ 所屬商家變了或被刪除 ⇒ 同集團裡電話跟 p_phone 相同的其他列(= 換前或換後的「同一個人」,判定標準同 private.same_person_staff_ids_in_group)的外店灰格會變,通知那些列的商家行事曆與服務人員本人。任何錯誤只記 WARNING。三個角色都沒有 EXECUTE。';

revoke execute on function private.notify_calendar_for_phone_peers(uuid, uuid, text) from public, anon, authenticated;

-- =========================================================================
-- 3. staff_leave_records(請假)⇒ 所屬商家 + 服務人員本人(不跨店)
-- =========================================================================
create or replace function private.tg_staff_leave_records_calendar_live_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_ids uuid[];
  v_staff_id uuid;
begin
  if tg_op = 'INSERT' then
    v_staff_ids := array[new.staff_id];
  elsif tg_op = 'DELETE' then
    v_staff_ids := array[old.staff_id];
  else
    if new.staff_id is not distinct from old.staff_id
       and new.status is not distinct from old.status
       and new.start_date is not distinct from old.start_date
       and new.end_date is not distinct from old.end_date
       and new.leave_type_name_snapshot is not distinct from old.leave_type_name_snapshot then
      return null;
    end if;
    v_staff_ids := array[new.staff_id];
    if old.staff_id is distinct from new.staff_id then
      v_staff_ids := v_staff_ids || old.staff_id;
    end if;
  end if;

  foreach v_staff_id in array v_staff_ids loop
    begin
      perform private.notify_merchant_calendar_for_staff(v_staff_id, false);
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
    begin
      perform private.notify_staff_schedule_changed(v_staff_id);
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
  end loop;

  return null;
end;
$$;

comment on function private.tg_staff_leave_records_calendar_live_sync() is 'SPECS-INDEX #1011:staff_leave_records INSERT / DELETE,或 UPDATE 動到 staff_id / status / start_date / end_date / leave_type_name_snapshot 後,通知那位服務人員所屬商家的行事曆與服務人員本人。notes / cancelled_at 等單獨變動不發。不跨店(請假只影響那一列自己的可預約判斷與畫面)。';

revoke execute on function private.tg_staff_leave_records_calendar_live_sync() from public, anon, authenticated;

drop trigger if exists staff_leave_records_calendar_live_sync on public.staff_leave_records;
create trigger staff_leave_records_calendar_live_sync
after insert or update or delete on public.staff_leave_records
for each row execute function private.tg_staff_leave_records_calendar_live_sync();

-- =========================================================================
-- 4. merchant_business_hours(營業時間 / 公休)⇒ 該商家 + 該商家的服務人員(不跨店)
-- =========================================================================
create or replace function private.tg_merchant_business_hours_calendar_live_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.notify_calendar_for_merchant_hours(new.merchant_id);
  elsif tg_op = 'DELETE' then
    perform private.notify_calendar_for_merchant_hours(old.merchant_id);
  else
    if new.merchant_id is not distinct from old.merchant_id
       and new.day_of_week is not distinct from old.day_of_week
       and new.is_closed is not distinct from old.is_closed
       and new.open_time is not distinct from old.open_time
       and new.close_time is not distinct from old.close_time then
      return null;
    end if;
    perform private.notify_calendar_for_merchant_hours(new.merchant_id);
    if old.merchant_id is distinct from new.merchant_id then
      perform private.notify_calendar_for_merchant_hours(old.merchant_id);
    end if;
  end if;
  return null;
end;
$$;

comment on function private.tg_merchant_business_hours_calendar_live_sync() is 'SPECS-INDEX #1011:merchant_business_hours INSERT / DELETE,或 UPDATE 動到 merchant_id / day_of_week / is_closed / open_time / close_time 後,通知該商家的行事曆與該商家的服務人員。值沒變的 upsert(只動 updated_at)不發。不跨店。';

revoke execute on function private.tg_merchant_business_hours_calendar_live_sync() from public, anon, authenticated;

drop trigger if exists merchant_business_hours_calendar_live_sync on public.merchant_business_hours;
create trigger merchant_business_hours_calendar_live_sync
after insert or update or delete on public.merchant_business_hours
for each row execute function private.tg_merchant_business_hours_calendar_live_sync();

-- =========================================================================
-- 5. merchant_staff(服務人員資料)⇒ 只在行事曆有讀的欄位變動時發
-- =========================================================================
create or replace function private.tg_merchant_staff_calendar_live_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_changed boolean;
  v_merchant_changed boolean;
  v_calendar_changed boolean;
  v_staff_changed boolean;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      begin
        perform private.notify_merchant_calendar_changed(new.merchant_id);
      exception
        when others then
          raise warning 'WarnCalendarLiveSync: %', sqlerrm;
      end;
    end if;
    return null;
  end if;

  if tg_op = 'DELETE' then
    begin
      perform private.notify_merchant_calendar_changed(old.merchant_id);
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
    perform private.notify_calendar_for_phone_peers(old.id, old.merchant_id, old.phone);
    return null;
  end if;

  v_merchant_changed := new.merchant_id is distinct from old.merchant_id;
  begin
    v_phone_changed := private.normalize_phone(new.phone) is distinct from private.normalize_phone(old.phone);
  exception
    when others then
      raise warning 'WarnCalendarLiveSync: %', sqlerrm;
      v_phone_changed := new.phone is distinct from old.phone;
  end;
  v_calendar_changed := v_merchant_changed
    or v_phone_changed
    or new.name is distinct from old.name
    or new.status is distinct from old.status
    or new.unlimited_backend_edit is distinct from old.unlimited_backend_edit;
  v_staff_changed := v_calendar_changed
    or new.can_create_edit_orders is distinct from old.can_create_edit_orders
    or new.show_member_info is distinct from old.show_member_info
    or new.compensation_type is distinct from old.compensation_type;

  if not v_staff_changed then
    return null;
  end if;

  if v_calendar_changed then
    begin
      perform private.notify_merchant_calendar_changed(new.merchant_id);
      if v_merchant_changed then
        perform private.notify_merchant_calendar_changed(old.merchant_id);
      end if;
    exception
      when others then
        raise warning 'WarnCalendarLiveSync: %', sqlerrm;
    end;
  end if;

  begin
    perform private.notify_staff_schedule_changed(new.id);
  exception
    when others then
      raise warning 'WarnCalendarLiveSync: %', sqlerrm;
  end;

  if v_phone_changed or v_merchant_changed then
    perform private.notify_calendar_for_phone_peers(new.id, old.merchant_id, old.phone);
    perform private.notify_calendar_for_phone_peers(new.id, new.merchant_id, new.phone);
  end if;

  return null;
end;
$$;

comment on function private.tg_merchant_staff_calendar_live_sync() is 'SPECS-INDEX #1011:merchant_staff 只在行事曆有讀的欄位變動時發訊號。商家端:INSERT 在職的人 / DELETE / UPDATE 動到 merchant_id、name、status、unlimited_backend_edit、正規化後 phone。服務人員本人:以上或 can_create_edit_orders、show_member_info、compensation_type。phone(正規化後)/ 商家變了或刪除:同集團舊電話、新電話相同的其他列(商家 + 服務人員本人)也通知。其他欄位(備註、頭像、LINE、no_time_slot_limit 等)不發。';

revoke execute on function private.tg_merchant_staff_calendar_live_sync() from public, anon, authenticated;

drop trigger if exists merchant_staff_calendar_live_sync on public.merchant_staff;
create trigger merchant_staff_calendar_live_sync
after insert or update or delete on public.merchant_staff
for each row execute function private.tg_merchant_staff_calendar_live_sync();
