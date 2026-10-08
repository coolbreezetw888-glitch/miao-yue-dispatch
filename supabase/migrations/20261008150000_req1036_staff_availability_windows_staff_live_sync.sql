-- SPECS-INDEX #1036(第 23 批,2026-10-08):服務人員端「每週可預約時段」+「單日例外」即時同步
-- 規格書:.project/specs/服務人員端時段即時同步-第23批.md
-- 沿用:秒約/.claude/skills/staff-realtime-sync 的整套規矩;#874 的服務人員頻道 staff:<staff_id>:schedule
--       (private.notify_staff_schedule_changed);寫法照 #1011(20261008100000)的 trigger。
--
-- =========================================================================
-- 缺口(改前查證)
-- =========================================================================
--   staff_availability_windows / staff_availability_overrides 目前只掛了 #1003 的
--   *_notify_merchant_calendar(只發商家頻道 merchant:<id>:calendar)。服務人員頻道沒有任何 trigger 涵蓋
--   這兩張表 ⇒ 商家(或有「營業時間」權限的客服)改了某位服務人員的每週時段、或在行事曆點格子開關時段,
--   那位服務人員開著的時間軸 / 休假設定頁不會動。
--
-- =========================================================================
-- 這支 migration 做什麼(只新增兩支 trigger 函式 + 兩個 trigger,不改任何既有函式)
-- =========================================================================
--   1. staff_availability_windows(每週時段)INSERT / DELETE,或 UPDATE 動到 staff_id / day_of_week /
--      start_time / end_time ⇒ 那位服務人員本人。
--   2. staff_availability_overrides(單日例外:主腦 2026-10-08 裁決同批補上)INSERT / DELETE,或 UPDATE 動到
--      staff_id / override_date / slot_start_time / is_available ⇒ 那位服務人員本人。
--      (set_staff_day_override 是 upsert,同一格「關→關」只動 updated_at ⇒ 不發。)
--   兩者:notify_staff_schedule_changed 內部只發給在職 + 已開通登入 + 行事曆檢視有開的人;
--   換 staff_id(實務上不會發生)⇒ 新舊兩人都發。updated_at 單獨變動不發。
--   兩支分開寫(不共用一支 + tg_table_name 分支):欄位不同,分開寫指紋與欄位篩選都比較好讀、好單獨移除。
--   🔸 不跨店、不套 #1011 的 private.notify_calendar_for_phone_peers:每週時段 / 單日例外只決定「這一列」
--      自己的可預約格子;同集團同一個人在別家店的畫面(外店灰格只算訂單)與可預約判斷都不看這兩張表 ⇒ 不適用。
--   🔸 商家頻道不動:#1003 的 trigger 照舊負責(兩個 trigger 各自去重,互不影響)。
--
--   🔴 訊號內容不變:{"v":1,"reason":"schedule_changed"}(外加 realtime.send 自動補的 id),
--     沿用既有發送函式。不帶星期 / 時間 / staff_id / 姓名。
--   去重:沿用既有交易內 GUC miaoyue.rt_staff_notified(一筆交易改好幾組時段、set_staff_day_override
--     一次寫多格、整批匯入 ⇒ 同一位服務人員同一筆交易只收 1 則)。
--   例外保護:既有發送函式本身吞錯;本檔每一次呼叫再包 begin … exception when others ⇒
--     只留 WARNING 'WarnCalendarLiveSync: …'(只進伺服器 log,內容是錯誤原文、不含資料列),
--     存檔照常成功。WHEN OTHERS 不吞 query_canceled。
--   本 trigger 不 raise 任何錯誤 ⇒ 不會在權限檢查之前透露資料(AFTER trigger,RLS / #1024 的
--     BEFORE trigger 已經擋過才會走到這裡)。
--
-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1 / 6)
-- =========================================================================
--   新函式 private、SECURITY DEFINER、set search_path = public,對 public / anon / authenticated 全部
--   revoke EXECUTE(只由 trigger 以 owner 身分呼叫)。realtime.messages 政策不動(仍只有 2 條 SELECT,
--   沒有任何寫入政策);收聽端 private.can_listen_staff_schedule_topic 不動 ⇒ 誰能收完全沒變。
--   函式本體內不寫註解,套正式庫後 md5(prosrc)(先 CRLF→LF)指紋比對才穩定。
--
-- =========================================================================
-- 上線注意
-- =========================================================================
--   ・依賴 20261001110000(#874)、20261007160000(#1003)、20261008100000(#1011)之後套用。
--   ・前端同一批:服務人員端收到訊號多重抓 booking-module/staff-availability-windows 與
--     staff-portal-module/my-availability-overrides;休假設定頁也訂頻道。
--   ・套用後核對:兩支新函式指紋;staff_availability_windows 觸發器 4 個、staff_availability_overrides 2 個;
--     realtime.messages 仍 2 條 SELECT 政策。
--   ・之後的資料修正 migration 直接改這張表,也會對受影響的服務人員發訊號 —— 預期、無害。
--
-- 用語:一律「服務人員」。

create or replace function private.tg_staff_availability_windows_staff_live_sync()
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
       and new.day_of_week is not distinct from old.day_of_week
       and new.start_time is not distinct from old.start_time
       and new.end_time is not distinct from old.end_time then
      return null;
    end if;
    v_staff_ids := array[new.staff_id];
    if old.staff_id is distinct from new.staff_id then
      v_staff_ids := v_staff_ids || old.staff_id;
    end if;
  end if;

  foreach v_staff_id in array v_staff_ids loop
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

comment on function private.tg_staff_availability_windows_staff_live_sync() is 'SPECS-INDEX #1036(第 23 批):staff_availability_windows INSERT / DELETE,或 UPDATE 動到 staff_id / day_of_week / start_time / end_time 後,通知那位服務人員本人(staff:<staff_id>:schedule,沿用 notify_staff_schedule_changed 的發送端過濾與交易內去重)。updated_at 單獨變動不發。不跨店(每週時段只影響那一列自己)。商家頻道由 #1003 的 trigger 負責。任何錯誤只記 WARNING。三個角色都沒有 EXECUTE。';

revoke execute on function private.tg_staff_availability_windows_staff_live_sync() from public, anon, authenticated;

drop trigger if exists staff_availability_windows_staff_live_sync on public.staff_availability_windows;
create trigger staff_availability_windows_staff_live_sync
after insert or update or delete on public.staff_availability_windows
for each row execute function private.tg_staff_availability_windows_staff_live_sync();

create or replace function private.tg_staff_availability_overrides_staff_live_sync()
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
       and new.override_date is not distinct from old.override_date
       and new.slot_start_time is not distinct from old.slot_start_time
       and new.is_available is not distinct from old.is_available then
      return null;
    end if;
    v_staff_ids := array[new.staff_id];
    if old.staff_id is distinct from new.staff_id then
      v_staff_ids := v_staff_ids || old.staff_id;
    end if;
  end if;

  foreach v_staff_id in array v_staff_ids loop
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

comment on function private.tg_staff_availability_overrides_staff_live_sync() is 'SPECS-INDEX #1036(第 23 批,主腦裁決同批補上):staff_availability_overrides(單日例外)INSERT / DELETE,或 UPDATE 動到 staff_id / override_date / slot_start_time / is_available 後,通知那位服務人員本人(staff:<staff_id>:schedule,沿用 notify_staff_schedule_changed 的發送端過濾與交易內去重)。updated_at 單獨變動不發。不跨店。商家頻道由 #1003 的 trigger 負責。任何錯誤只記 WARNING。三個角色都沒有 EXECUTE。';

revoke execute on function private.tg_staff_availability_overrides_staff_live_sync() from public, anon, authenticated;

drop trigger if exists staff_availability_overrides_staff_live_sync on public.staff_availability_overrides;
create trigger staff_availability_overrides_staff_live_sync
after insert or update or delete on public.staff_availability_overrides
for each row execute function private.tg_staff_availability_overrides_staff_live_sync();
