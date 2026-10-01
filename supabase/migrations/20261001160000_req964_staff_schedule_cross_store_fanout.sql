-- SPECS-INDEX #964 / #906 服務人員端行事曆即時同步 —— 批次 5:跨店佔用灰色格子也要即時(fan-out)
-- 規格書:.project/specs/服務人員端即時同步.md v1.1(#906、§三 批次表第 5 列、#885 / #886 / #887 / #888)
--
-- =========================================================================
-- 缺口(#906)
-- =========================================================================
--   同一個人(同一集團、電話相同)在 A 店、B 店各有一列 merchant_staff。他正看著 A 店的行事曆
--   (訂的是 A 店那一列的頻道 staff:<A列id>:schedule),這時 B 店替 B 店那一列建單 ⇒ 批次 1 只通知
--   B 店那一列 ⇒ A 店畫面上的灰色「外店預約中」格子不會即時出現(要切頁或重新整理才會)。
--
-- =========================================================================
-- 做法:發送拆成兩層
-- =========================================================================
--   第一層 private.notify_staff_schedule_changed(p_staff_id)「發一則給某一列」——**本檔不改它**,
--     原樣保留交易內去重(GUC miaoyue.rt_staff_notified,以「收件那一列」為單位)、發送端過濾
--     (在職 + 已開通登入 + 行事曆檢視有開,#876 helper)與例外保護。
--   第二層(新)private.notify_staff_schedule_changed_fanout(p_staff_id):
--     ① 先對本人那一列呼叫第一層;
--     ② 再對 private.same_person_staff_ids_in_group(p_staff_id) 回傳的每一列各呼叫第一層一次
--        ⇒ 每一列都各自套用發送端過濾(另一列沒開登入 / 已停用 / 行事曆檢視沒開 ⇒ 收不到)。
--     🔴 只做一層、不遞迴:第二層只呼叫第一層,**永遠不會呼叫自己** ⇒ 不會有 A→B→A 互相觸發。
--        (same_person_staff_ids_in_group 是「同集團 + 電話相同」,本來就是對稱、傳遞的關係,
--         一層就已經涵蓋這個人在集團裡的每一列,不需要也不可以再往下展。)
--     去重:收件列的去重沿用第一層的 GUC(A 店、B 店同一筆交易都有變動 ⇒ 同一列只收 1 則)。
--       另外加一個「這筆交易已經對這位來源服務人員展開過」的記號(GUC miaoyue.rt_staff_fanned_out),
--       只是省掉重複查詢(例如匯入迴圈對同一位服務人員插上千筆,不必每筆都重查一次同集團名單);
--       同樣是 transaction-local、回滾會一起回滾、長度上限 8000 字元,超過就不再累積、退化成「每次都查」
--       (只多花查詢,收件端仍由第一層去重,不會重複發)。
--     判定「同一個人」完全沿用 #924 的 private.same_person_staff_ids_in_group(跟擋建單、兩支行事曆
--       灰格函式共用同一支),不自己另寫一套 ⇒ 「灰格算得到的人」=「會收到即時訊號的人」。
--
-- =========================================================================
-- 所有觸發點都走 fan-out
-- =========================================================================
--   private.tg_bookings_notify_staff_schedule:主要服務人員(新 / 轉派時的舊)+ 批次 1 多做的
--     「UPDATE 時通知這張單目前的每一位助手」—— 全部改呼叫 fan-out。
--   private.tg_booking_assistants_notify_staff_schedule:助手(新 / 轉派時的舊)—— 改呼叫 fan-out。
--   助手也要 fan-out 的依據:public.get_my_day_schedule_state 的 foreign_bookings 有第二段
--     union all 查 booking_assistants(同一個人在別店當助手的那段時間也會畫成灰格)⇒ 灰格算得到,
--     就要即時。
--   兩支 trigger 函式除了把 notify_staff_schedule_changed 換成 notify_staff_schedule_changed_fanout,
--   其餘邏輯逐字沿用 20261001110000。trigger 本身(bookings_notify_staff_schedule /
--   booking_assistants_notify_staff_schedule)不重建,照舊指向同名函式。
--
-- =========================================================================
-- 訊號內容(#886)不變
-- =========================================================================
--   跨店收件那一列收到的也只有 {"v":1,"reason":"schedule_changed"}(+ realtime.send 自動補的 id)——
--   因為實際送出仍然只經過第一層那一支,payload 只在那裡組一次。不帶客戶 / 訂單 / 店名 / 日期。
--
-- =========================================================================
-- 例外保護(沿用批次 1 / #902)
-- =========================================================================
--   第一層本身已經把「過濾 + 送出」包在 exception 裡。第二層再把「查同集團名單 + 逐列發送」整段包進
--   begin … exception when others ⇒ 例如 same_person_staff_ids_in_group 被改壞,只留
--   WARNING 'WarnStaffScheduleFanout: …',建單 / 改單照常成功;本人那一列的通知在這個區塊之前
--   已經發出,不受影響。WHEN OTHERS 不吞 query_canceled。
--
-- =========================================================================
-- ⚠️ 之後的資料修正 migration 也會觸發(#887),而且現在會多通知同集團同一人的其他列 —— 預期、無害。
-- =========================================================================
--
-- =========================================================================
-- 改前線上指紋(2026-10-02,正式庫 wjtbmmnakcriuaqoknsq 唯讀 SELECT
--   md5(replace(prosrc, E'\r\n', E'\n')),本機 db reset 後同一查詢逐一相同)
-- =========================================================================
--   private.notify_staff_schedule_changed(uuid)              61e757e87dd3445ad955c46ef3947c99(960)  ← 本檔不改
--   private.tg_bookings_notify_staff_schedule()              d8346fc7c47200057d5140d6e9eb9cce(685)  ← 本檔改寫
--   private.tg_booking_assistants_notify_staff_schedule()    351494b843e0a5c3b4a83370149541cb(430)  ← 本檔改寫
--   private.same_person_staff_ids_in_group(uuid)             d28032b7b8d4373f48193d6ecc4fffa2(657)  ← 本檔不改
--   public.get_my_day_schedule_state(uuid, date)             2fc16644af9f4d60a92e312794e8e4ee(2764) ← 本檔不改
--   private.staff_calendar_view_allows_notifications(uuid)   4e7475842ebfb966a238170a4c6fed5a(578)  ← 本檔不改
--   正式庫最大 migration:20261001150000 ⇒ 本檔 20261001160000。
--
-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1)
-- =========================================================================
--   新函式與兩支改寫的 trigger 函式:private schema、SECURITY DEFINER、owner postgres
--   (rolbypassrls,才能寫 realtime.messages;也才能呼叫只留給 postgres / service_role 的
--   same_person_staff_ids_in_group),對 public / anon / authenticated **全部 revoke EXECUTE**,
--   整組重寫一次(不依賴 create or replace 保留舊 ACL)。函式本體內不寫註解(規則 6,指紋比對才穩定)。
--
-- 用語:一律「服務人員」。

-- =========================================================================
-- 第二層:fan-out(本人 + 同集團同一個人的其他列;只做一層)
-- =========================================================================
create or replace function private.notify_staff_schedule_changed_fanout(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_done text;
  v_mark text;
  v_other_staff_id uuid;
begin
  if p_staff_id is null then
    return;
  end if;

  perform private.notify_staff_schedule_changed(p_staff_id);

  v_mark := '|' || p_staff_id::text || '|';
  v_done := coalesce(current_setting('miaoyue.rt_staff_fanned_out', true), '');

  if position(v_mark in v_done) > 0 then
    return;
  end if;

  if length(v_done) < 8000 then
    perform set_config('miaoyue.rt_staff_fanned_out', v_done || v_mark, true);
  end if;

  begin
    for v_other_staff_id in
      select s.staff_id
      from private.same_person_staff_ids_in_group(p_staff_id) as s(staff_id)
    loop
      perform private.notify_staff_schedule_changed(v_other_staff_id);
    end loop;
  exception
    when others then
      raise warning 'WarnStaffScheduleFanout: %', sqlerrm;
  end;
end;
$$;

comment on function private.notify_staff_schedule_changed_fanout(uuid) is 'SPECS-INDEX #964/#906:即時同步的 fan-out 層。先通知本人那一列,再對 private.same_person_staff_ids_in_group(同一集團、同一個人的其他 merchant_staff 列)各通知一次;每一列都經過 private.notify_staff_schedule_changed 的交易內去重與發送端過濾(在職 + 已開通登入 + 行事曆檢視有開)。只做一層、絕不遞迴。查名單出錯只記 WARNING,不讓建單回滾。只給 bookings / booking_assistants 的 AFTER trigger 函式呼叫,三個角色都沒有 EXECUTE。';

revoke execute on function private.notify_staff_schedule_changed_fanout(uuid) from public, anon, authenticated;

-- =========================================================================
-- bookings 的 AFTER trigger 函式:逐字沿用 20261001110000,只把發送改成 fan-out
-- =========================================================================
create or replace function private.tg_bookings_notify_staff_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assistant_staff_id uuid;
begin
  if tg_op = 'INSERT' then
    perform private.notify_staff_schedule_changed_fanout(new.staff_id);
  elsif tg_op = 'DELETE' then
    perform private.notify_staff_schedule_changed_fanout(old.staff_id);
  else
    perform private.notify_staff_schedule_changed_fanout(new.staff_id);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_staff_schedule_changed_fanout(old.staff_id);
    end if;
    for v_assistant_staff_id in
      select ba.staff_id from public.booking_assistants ba where ba.booking_id = new.id
    loop
      perform private.notify_staff_schedule_changed_fanout(v_assistant_staff_id);
    end loop;
  end if;
  return null;
end;
$$;

comment on function private.tg_bookings_notify_staff_schedule() is 'SPECS-INDEX #887(+ #964/#906 fan-out):bookings 任何 INSERT/UPDATE/DELETE 後通知主要服務人員(轉派時新舊兩人都通知);UPDATE 時也通知這張單目前的助手。每一位都走 private.notify_staff_schedule_changed_fanout ⇒ 同集團同一個人在其他分店的那一列也會收到(跨店佔用灰格即時)。刻意不做欄位過濾。';

revoke execute on function private.tg_bookings_notify_staff_schedule() from public, anon, authenticated;

-- =========================================================================
-- booking_assistants 的 AFTER trigger 函式:逐字沿用 20261001110000,只把發送改成 fan-out
-- =========================================================================
create or replace function private.tg_booking_assistants_notify_staff_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.notify_staff_schedule_changed_fanout(new.staff_id);
  elsif tg_op = 'DELETE' then
    perform private.notify_staff_schedule_changed_fanout(old.staff_id);
  else
    perform private.notify_staff_schedule_changed_fanout(new.staff_id);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_staff_schedule_changed_fanout(old.staff_id);
    end if;
  end if;
  return null;
end;
$$;

comment on function private.tg_booking_assistants_notify_staff_schedule() is 'SPECS-INDEX #888(+ #964/#906 fan-out):booking_assistants(助手/納編)任何 INSERT/UPDATE/DELETE 後通知那位助手(轉派時新舊兩人都通知;CASCADE 刪除也會觸發)。走 private.notify_staff_schedule_changed_fanout ⇒ 同集團同一個人在其他分店的那一列也會收到(get_my_day_schedule_state 的 foreign_bookings 也算助手那段)。';

revoke execute on function private.tg_booking_assistants_notify_staff_schedule() from public, anon, authenticated;
