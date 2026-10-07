-- SPECS-INDEX #1003 / #1006(第 14 批,2026-10-07):商家端行事曆即時同步
-- 規格書:.project/specs/行事曆同步與時間軸卡片-第14批.md(#1003、#1006)
-- 沿用:秒約/.claude/skills/staff-realtime-sync(#874 服務人員端即時同步)的整套規矩
--
-- =========================================================================
-- 缺口(改前查證結果)
-- =========================================================================
--   ① #1003:商家端行事曆(CalendarPage)**沒有訂閱任何即時訊號**(全專案只有 staff-portal 呼叫
--     supabase `.channel(`,staff-realtime-sync skill 也明寫「商家端沒有即時同步(刻意)」)。
--     商家端畫面只會在 ①掛載 ②切回分頁(react-query refetchOnWindowFocus)③自己操作完 refetchAll
--     這三個時間點重抓 get_merchant_day_schedule ⇒ 服務人員在手機改「每週固定可預約時段」,
--     商家端開著的行事曆不會變,一定要重整。
--   ② #1006(#964):同集團兩店、同一個人(電話相同),一店建單 / 拖拉改時間 ⇒ 二店**商家端**時間軸的
--     灰色「外店預約中」不會即時出現 —— 原因同 ①,商家端根本沒有訂閱。服務人員端那一半在
--     20261001160000(fan-out)已經做了,正式庫指紋與 repo 一致、realtime.messages 也查得到兩店那兩列
--     各自收到訊號(只讀查詢,2026-10-07)。
--
-- =========================================================================
-- 做法:新增一個「商家行事曆」私有頻道 merchant:<merchant_id>:calendar
-- =========================================================================
--   訊號只是「請重查」的鈴聲,商家端收到後重打既有的 get_merchant_day_schedule 等查詢 ——
--   **資料可見範圍一點都沒放寬**(那幾支查詢自己的權限檢查照舊)。
--
--   發送端(trigger,owner postgres,rolbypassrls):
--     ・staff_availability_windows(每週固定可預約時段)任何 INSERT / UPDATE / DELETE
--       ⇒ 那位服務人員所屬的商家(服務人員端自己改、商家端「服務人員」頁改都會觸發)。
--     ・staff_availability_overrides(單日例外:行事曆點格子開關時段、服務人員端排休)
--       ⇒ 那位服務人員所屬的商家。
--     ・bookings 任何 INSERT / UPDATE / DELETE ⇒ 這張單的商家(轉商家不會發生,仍新舊都發),
--       再加上「主要服務人員 / 轉派時的舊人 / 這張單目前的助手」在**同集團其他分店**那幾列所屬的商家
--       (#1006:那些店的時間軸要畫灰色「外店預約中」)。
--     ・booking_assistants 任何 INSERT / UPDATE / DELETE ⇒ 那位助手所屬商家 + 同集團同一個人的其他分店。
--       (CASCADE 刪除時 bookings 那一列已經看不到 ⇒ 一律用「助手所屬商家」,助手一定跟訂單同一間店。)
--     判定「同一個人」完全沿用 #924 的 private.same_person_staff_ids_in_group(灰格函式、擋建單、
--     服務人員端 fan-out 共用同一支)⇒ 「灰格算得到的店」=「會收到即時訊號的店」。
--
--   🔴 訊號內容(比照 #886):payload 只有 {"v":1,"reason":"calendar_changed"}(外加 realtime.send
--     自動補的 id)。不帶客戶姓名 / 電話 / 備註 / 金額 / booking_id / 日期 / staff_id / 店名。
--     頻道名裡只有收件商家自己的 merchant_id。
--
--   去重:交易內 GUC miaoyue.rt_merchant_notified(以「收件商家」為單位)—— set_staff_day_override 一次
--     插 48 格、update_booking 助手全刪再全插、匯入上千筆,同一間商家同一筆交易都只收 1 則。
--     另一個 GUC miaoyue.rt_merchant_fanned_staff 記「這筆交易已經對這位服務人員查過同集團名單」,
--     只為了省查詢。兩個都是 transaction-local、回滾一起回滾、長度上限 8000 字元(超過退化成可能重複發 /
--     多查幾次,不會無限長大)。
--
--   例外保護(比照 #902):realtime.send 本身吞錯;本檔的「查商家 / 查同集團名單 / 送出」再整段包進
--     begin … exception when others ⇒ 任何一步出錯只留 WARNING 'WarnMerchantCalendarSignal: …' /
--     'WarnMerchantCalendarFanout: …',存檔(建單、改時段、開關格子)照常成功。WHEN OTHERS 不吞 query_canceled。
--
--   🔴 不改任何既有函式(服務人員端 #874 / #964 的 trigger 與函式指紋都不動),新增的是**另外一組** trigger。
--
-- =========================================================================
-- 接收端:realtime.messages 第二條 SELECT 政策 merchant_calendar_broadcast_receive
-- =========================================================================
--   private.can_listen_merchant_calendar_topic(p_topic):只認 merchant:<小寫 UUID>:calendar,
--   且 private.can_manage_bookings(該商家)= 商家管理員,或該商家在職客服且開了「訂單管理」(orders)——
--   跟商家端行事曆頁(RequireBookingAccess)與 get_merchant_day_schedule 的權限檢查同一支函式,不另發明標準。
--   ⇒ 別家商家、沒開訂單管理的客服、服務人員、未登入者,改頻道名裡的 id 也加入不了(伺服器每次 join 都用
--   auth.uid() 重驗)。形狀不對一律 false、不丟錯(先比 regex,再在 exception 裡轉型)。
--   政策同樣加 realtime.messages.topic = realtime.topic() ⇒ 只看得到「目前這個頻道」自己的列。
--
--   🔴 #892 照舊:realtime.messages **仍然沒有任何 INSERT / UPDATE / DELETE 政策**。登入者發不出訊號,
--   只有 trigger 以 postgres 身分發。也**不在 public schema 建任何包裝 realtime.send 的函式**。
--
-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1 / 6)
-- =========================================================================
--   發送端函式與 trigger 函式:private、SECURITY DEFINER、對 public / anon / authenticated 全部 revoke EXECUTE。
--   can_listen_merchant_calendar_topic:只給 authenticated(RLS 運算式以查詢者身分執行),public / anon 收回。
--   函式本體內不寫註解,說明全部在 $$ 之外,套正式庫後 md5(prosrc)(先 CRLF→LF)指紋比對才穩定。
--
-- =========================================================================
-- 上線注意
-- =========================================================================
--   ・正式庫 Realtime 已啟用、「Allow public access」已關(#874 上線時做過),這次不用再動後台。
--   ・連線數:商家端每一個開著行事曆的分頁多佔 1 條 Realtime 連線(Free 方案上限 200,#901)。
--   ・之後的資料修正 migration 直接改上述四張表,也會對受影響商家發訊號 —— 預期、無害。
--
-- 用語:一律「服務人員」。

-- =========================================================================
-- 1. 發一則給某一間商家(交易內去重 + 例外保護)
-- =========================================================================
create or replace function private.notify_merchant_calendar_changed(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sent text;
  v_mark text;
begin
  if p_merchant_id is null then
    return;
  end if;

  v_mark := '|' || p_merchant_id::text || '|';
  v_sent := coalesce(current_setting('miaoyue.rt_merchant_notified', true), '');

  if position(v_mark in v_sent) > 0 then
    return;
  end if;

  if length(v_sent) < 8000 then
    perform set_config('miaoyue.rt_merchant_notified', v_sent || v_mark, true);
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('v', 1, 'reason', 'calendar_changed'),
      'calendar_changed',
      'merchant:' || p_merchant_id::text || ':calendar',
      true
    );
  exception
    when others then
      raise warning 'WarnMerchantCalendarSignal: %', sqlerrm;
  end;
end;
$$;

comment on function private.notify_merchant_calendar_changed(uuid) is 'SPECS-INDEX #1003:通知某間商家「行事曆有變動」(Realtime Broadcast 私有頻道 merchant:<merchant_id>:calendar,事件 calendar_changed,payload 只有 {v:1, reason:calendar_changed})。同一筆交易內同一間商家只發一次(GUC miaoyue.rt_merchant_notified)。送出失敗只記 WARNING。只給本檔的 trigger 函式呼叫,三個角色都沒有 EXECUTE。';

revoke execute on function private.notify_merchant_calendar_changed(uuid) from public, anon, authenticated;

-- =========================================================================
-- 2. 某位服務人員有變動 ⇒ 通知他所屬的商家;p_cross_store = true 時再通知同集團同一個人的其他分店
-- =========================================================================
create or replace function private.notify_merchant_calendar_for_staff(p_staff_id uuid, p_cross_store boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done text;
  v_mark text;
  v_merchant_id uuid;
begin
  if p_staff_id is null then
    return;
  end if;

  begin
    select ms.merchant_id into v_merchant_id
    from public.merchant_staff ms
    where ms.id = p_staff_id;

    perform private.notify_merchant_calendar_changed(v_merchant_id);
  exception
    when others then
      raise warning 'WarnMerchantCalendarSignal: %', sqlerrm;
  end;

  if not coalesce(p_cross_store, false) then
    return;
  end if;

  v_mark := '|' || p_staff_id::text || '|';
  v_done := coalesce(current_setting('miaoyue.rt_merchant_fanned_staff', true), '');

  if position(v_mark in v_done) > 0 then
    return;
  end if;

  if length(v_done) < 8000 then
    perform set_config('miaoyue.rt_merchant_fanned_staff', v_done || v_mark, true);
  end if;

  begin
    for v_merchant_id in
      select distinct ms.merchant_id
      from private.same_person_staff_ids_in_group(p_staff_id) as s(staff_id)
      join public.merchant_staff ms on ms.id = s.staff_id
    loop
      perform private.notify_merchant_calendar_changed(v_merchant_id);
    end loop;
  exception
    when others then
      raise warning 'WarnMerchantCalendarFanout: %', sqlerrm;
  end;
end;
$$;

comment on function private.notify_merchant_calendar_for_staff(uuid, boolean) is 'SPECS-INDEX #1003 / #1006:某位服務人員的時段或訂單有變動 ⇒ 通知他所屬商家的行事曆;p_cross_store = true(訂單 / 助手變動)時,再通知 private.same_person_staff_ids_in_group(同集團、同一個人)那幾列所屬的商家(灰色「外店預約中」即時)。只做一層、不遞迴;同交易對同一位服務人員只查一次同集團名單(GUC miaoyue.rt_merchant_fanned_staff)。任何錯誤只記 WARNING。三個角色都沒有 EXECUTE。';

revoke execute on function private.notify_merchant_calendar_for_staff(uuid, boolean) from public, anon, authenticated;

-- =========================================================================
-- 3. 每週固定可預約時段 / 單日例外 ⇒ 所屬商家(不跨店:這兩張表不影響別家店的灰格)
-- =========================================================================
create or replace function private.tg_staff_availability_notify_merchant_calendar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.notify_merchant_calendar_for_staff(new.staff_id, false);
  elsif tg_op = 'DELETE' then
    perform private.notify_merchant_calendar_for_staff(old.staff_id, false);
  else
    perform private.notify_merchant_calendar_for_staff(new.staff_id, false);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_merchant_calendar_for_staff(old.staff_id, false);
    end if;
  end if;
  return null;
end;
$$;

comment on function private.tg_staff_availability_notify_merchant_calendar() is 'SPECS-INDEX #1003:staff_availability_windows / staff_availability_overrides 任何 INSERT / UPDATE / DELETE 後,通知那位服務人員所屬商家的行事曆重查(服務人員端改每週時段、商家端改時段、行事曆點格子開關時段都涵蓋)。';

revoke execute on function private.tg_staff_availability_notify_merchant_calendar() from public, anon, authenticated;

drop trigger if exists staff_availability_windows_notify_merchant_calendar on public.staff_availability_windows;
create trigger staff_availability_windows_notify_merchant_calendar
after insert or update or delete on public.staff_availability_windows
for each row execute function private.tg_staff_availability_notify_merchant_calendar();

drop trigger if exists staff_availability_overrides_notify_merchant_calendar on public.staff_availability_overrides;
create trigger staff_availability_overrides_notify_merchant_calendar
after insert or update or delete on public.staff_availability_overrides
for each row execute function private.tg_staff_availability_notify_merchant_calendar();

-- =========================================================================
-- 4. bookings ⇒ 訂單所屬商家 + 主要服務人員 / 舊主要服務人員 / 目前助手在同集團其他分店的商家
-- =========================================================================
create or replace function private.tg_bookings_notify_merchant_calendar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assistant_staff_id uuid;
begin
  if tg_op = 'INSERT' then
    perform private.notify_merchant_calendar_changed(new.merchant_id);
    perform private.notify_merchant_calendar_for_staff(new.staff_id, true);
  elsif tg_op = 'DELETE' then
    perform private.notify_merchant_calendar_changed(old.merchant_id);
    perform private.notify_merchant_calendar_for_staff(old.staff_id, true);
  else
    perform private.notify_merchant_calendar_changed(new.merchant_id);
    if old.merchant_id is distinct from new.merchant_id then
      perform private.notify_merchant_calendar_changed(old.merchant_id);
    end if;
    perform private.notify_merchant_calendar_for_staff(new.staff_id, true);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_merchant_calendar_for_staff(old.staff_id, true);
    end if;
    for v_assistant_staff_id in
      select ba.staff_id from public.booking_assistants ba where ba.booking_id = new.id
    loop
      perform private.notify_merchant_calendar_for_staff(v_assistant_staff_id, true);
    end loop;
  end if;
  return null;
end;
$$;

comment on function private.tg_bookings_notify_merchant_calendar() is 'SPECS-INDEX #1003 / #1006:bookings 任何 INSERT / UPDATE / DELETE 後通知訂單所屬商家的行事曆;並對主要服務人員(轉派時新舊兩人)與 UPDATE 時目前的助手,通知他們在同集團其他分店那幾列所屬的商家(灰色「外店預約中」即時)。刻意不做欄位過濾(比照 #887)。';

revoke execute on function private.tg_bookings_notify_merchant_calendar() from public, anon, authenticated;

drop trigger if exists bookings_notify_merchant_calendar on public.bookings;
create trigger bookings_notify_merchant_calendar
after insert or update or delete on public.bookings
for each row execute function private.tg_bookings_notify_merchant_calendar();

-- =========================================================================
-- 5. booking_assistants ⇒ 助手所屬商家 + 同集團同一個人的其他分店
-- =========================================================================
create or replace function private.tg_booking_assistants_notify_merchant_calendar()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.notify_merchant_calendar_for_staff(new.staff_id, true);
  elsif tg_op = 'DELETE' then
    perform private.notify_merchant_calendar_for_staff(old.staff_id, true);
  else
    perform private.notify_merchant_calendar_for_staff(new.staff_id, true);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_merchant_calendar_for_staff(old.staff_id, true);
    end if;
  end if;
  return null;
end;
$$;

comment on function private.tg_booking_assistants_notify_merchant_calendar() is 'SPECS-INDEX #1003 / #1006:booking_assistants(助手 / 納編)任何 INSERT / UPDATE / DELETE 後,通知助手所屬商家與同集團同一個人其他分店的行事曆(CASCADE 刪除也會觸發;此時訂單列已看不到,所以一律用助手所屬商家)。';

revoke execute on function private.tg_booking_assistants_notify_merchant_calendar() from public, anon, authenticated;

drop trigger if exists booking_assistants_notify_merchant_calendar on public.booking_assistants;
create trigger booking_assistants_notify_merchant_calendar
after insert or update or delete on public.booking_assistants
for each row execute function private.tg_booking_assistants_notify_merchant_calendar();

-- =========================================================================
-- 6. 接收端:誰可以加入 merchant:<merchant_id>:calendar
-- =========================================================================
create or replace function private.can_listen_merchant_calendar_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  if p_topic is null then
    return false;
  end if;

  if p_topic !~ '^merchant:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:calendar$' then
    return false;
  end if;

  begin
    v_merchant_id := substring(p_topic from 10 for 36)::uuid;
  exception
    when others then
      return false;
  end;

  return coalesce(private.can_manage_bookings(v_merchant_id), false);
end;
$$;

comment on function private.can_listen_merchant_calendar_topic(text) is 'SPECS-INDEX #1003:目前登入者可不可以加入 Realtime 私有頻道 p_topic。只認 merchant:<小寫 merchant_id>:calendar,且 private.can_manage_bookings(該商家)(商家管理員,或在職且開了訂單管理的客服 —— 跟商家端行事曆頁、get_merchant_day_schedule 同標準)。形狀不對一律回 false、不丟錯。只給 realtime.messages 的 SELECT 政策 merchant_calendar_broadcast_receive 呼叫。';

revoke execute on function private.can_listen_merchant_calendar_topic(text) from public, anon;
grant  execute on function private.can_listen_merchant_calendar_topic(text) to authenticated;

drop policy if exists merchant_calendar_broadcast_receive on realtime.messages;
create policy merchant_calendar_broadcast_receive
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and realtime.messages.topic = (select realtime.topic())
  and (select private.can_listen_merchant_calendar_topic(realtime.topic()))
);

comment on policy merchant_calendar_broadcast_receive on realtime.messages is 'SPECS-INDEX #1003:商家管理員 / 開了訂單管理的客服只能加入 / 接收自己商家的 merchant:<merchant_id>:calendar 私有 broadcast 頻道。🔴 #892 照舊:realtime.messages 刻意沒有任何 INSERT / UPDATE / DELETE 政策,不要「順手補齊」—— 訊號只由資料庫 trigger 以 postgres 身分發出。';
