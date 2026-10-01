-- SPECS-INDEX #874 服務人員端行事曆即時同步 —— 批次 1:資料庫發訊號端(#885 + #886 + #887 + #888)
-- 規格書:.project/specs/服務人員端即時同步.md v1.1(§二 #885~#888、§三 批次 1、§五 給 engineer 的提醒)
--
-- =========================================================================
-- 這支 migration 做什麼
-- =========================================================================
--   bookings / booking_assistants 任何 INSERT / UPDATE / DELETE 之後,通知受影響的服務人員
--   「你的班表有變動」(Supabase Realtime Broadcast 私有頻道 staff:<merchant_staff.id>:schedule,
--   事件名 schedule_changed)。服務人員端收到後自己重打 get_my_booking_schedule 拿資料。
--   ⇒ 本檔**只決定「什麼時候重新去拿」,不改「拿得到什麼」**:不放寬任何 RLS、不改任何既有函式、
--     不新增任何 public 函式(PostgREST 不會多出任何 /rest/v1/rpc/ 端點)。
--
-- =========================================================================
-- 🔴 #886 訊號內容:只有 {"v":1,"reason":"schedule_changed"}(外加 realtime.send 自動補的 id)
-- =========================================================================
--   不帶客戶姓名 / 電話 / 地址 / 備註 / 金額 / 會員資訊 / booking_id / 日期 / staff_id。
--   刻意用 realtime.send,**不用** realtime.broadcast_changes(後者會把整列訂單送出去,
--   一次繞過 #851 內部備註遮蔽與 #876)。broadcast-from-database 的訊息會在 realtime.messages
--   留存 3 天 ⇒ 連日期都不帶。
--
-- =========================================================================
-- 為什麼用 trigger,不讓前端發(規格書 〇.6)
-- =========================================================================
--   bookings / booking_assistants 沒有任何 INSERT/UPDATE/DELETE 的 RLS 政策 ⇒ 寫入 100% 收斂在
--   SECURITY DEFINER 函式裡(本機 12 支,含 #844 的 private.reverse_booking_completion 與紅利的
--   private.refund_booking_redeem)。row-level AFTER trigger 掛在表上 ⇒ 不管哪支函式寫的、
--   未來新增哪支函式,都自動涵蓋;ON DELETE CASCADE 刪助手列也會觸發 row trigger。
--
-- =========================================================================
-- #885 交易內去重 + 發送端過濾
-- =========================================================================
--   * 去重:transaction-local 自訂 GUC miaoyue.rt_staff_notified 存「這筆交易已處理過的 staff_id」。
--     set_config(..., is_local => true) ⇒ 交易結束(commit 或 rollback)就消失,回滾時記號也一起回滾。
--     update_booking 對助手是「全刪再全插」、匯入是迴圈 ⇒ 沒有去重會一人收好幾則、一次匯入上千則。
--     GUC 長度上限 8000 字元(約 200 位不同服務人員),超過就不再累積記號、退化成「可能重複發」,
--     不會無限長大。
--   * 發送端過濾(v1.1,與 #876 一致):只發給「在職(status='active')+ 已開通登入
--     (login_status='active')+ 行事曆檢視有開」的服務人員。行事曆檢視的判斷沿用 #876 的
--     private.staff_calendar_view_allows_notifications(對已開通登入者 = 有 granted=true 的
--     staff_calendar_view 紀錄,跟 get_my_booking_schedule 的 has_own_staff_permission 同標準)。
--     那支 helper 對「尚未開通登入」者預設放行(LINE 語意),所以這裡必須另外要求
--     status / login_status 都是 active。
--     不能用 private.is_own_staff_row / has_own_staff_permission:它們看 auth.uid(),在 trigger 裡
--     (呼叫者是商家管理員)永遠是 false。
--   * 🔴 依賴 #876(20261001100000)的 helper ⇒ 本檔時間戳必須排在它後面,上線也必須跟 #876
--     同一次或之後。
--
-- =========================================================================
-- 失敗不會擋住建單(規格書 〇.4、#902)
-- =========================================================================
--   realtime.send 本身用 EXCEPTION WHEN OTHERS 把所有錯誤吞成
--   WARNING 'WarnSendingBroadcastMessage'(正式庫與本機原文指紋相同:
--   md5 = c12384e30dda994bf2e0d23daeaea20b,CRLF→LF 後)。
--   ⇒ realtime.messages 當天分區還沒建好(每天第一則、還沒有任何人連線時)、Realtime 壞掉,
--     都只會在 Postgres Logs 留一行 WARNING,**這是預期的,不是 bug**。
--   📌 engineer 補強(規格書範例沒有,2026-10-01):realtime.send 只保護「送出」那一步;本函式自己的
--     發送端過濾(查 merchant_staff、呼叫 #876 helper)如果哪天出錯(例如 helper 被改壞、被 drop),
--     原本會讓整筆建單/改單回滾。所以把「過濾 + 送出」整段包進 begin … exception when others,
--     失敗只留 WARNING 'WarnStaffScheduleSignal: …'。這段例外區塊放在去重記號之後 ⇒ 每筆交易每位
--     服務人員最多進一次(子交易成本有上限,匯入上千筆也只會進「不同服務人員數」次)。
--     WHEN OTHERS 不會吞掉 query_canceled(statement timeout / 使用者取消),那些照常中止交易。
--
-- =========================================================================
-- ⚠️ 之後的資料修正 migration 也會觸發這兩個 trigger(#887)
-- =========================================================================
--   任何直接 update / delete bookings 或 booking_assistants 的 migration(例如回填欄位)都會對
--   受影響的服務人員發訊號。這是預期、無害的(訊號不含內容、realtime.send 吞例外、交易內去重),
--   不是 bug,不需要先關 trigger。
--
-- =========================================================================
-- 權限衛生(supabase-permission-hygiene 規則 1)
-- =========================================================================
--   三支函式都放 private schema、SECURITY DEFINER、owner 為套用 migration 的 postgres
--   (rolbypassrls = true,才能 INSERT 進 realtime.messages),並對 public / anon / authenticated
--   **三個角色全部 revoke EXECUTE**:它們只該由 trigger 以 definer 身分呼叫。
--   函式本體內不寫註解,說明全部放在 $$ 之外,套用正式庫後的 md5(prosrc) 指紋比對才穩定(規則 6)。
--
-- 用語:一律「服務人員」。

-- =========================================================================
-- #885 訊號發送核心函式
-- =========================================================================
create or replace function private.notify_staff_schedule_changed(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sent text;
  v_mark text;
begin
  if p_staff_id is null then
    return;
  end if;

  v_mark := '|' || p_staff_id::text || '|';
  v_sent := coalesce(current_setting('miaoyue.rt_staff_notified', true), '');

  if position(v_mark in v_sent) > 0 then
    return;
  end if;

  if length(v_sent) < 8000 then
    perform set_config('miaoyue.rt_staff_notified', v_sent || v_mark, true);
  end if;

  begin
    if not exists (
      select 1 from public.merchant_staff ms
      where ms.id = p_staff_id and ms.status = 'active' and ms.login_status = 'active'
    ) or not private.staff_calendar_view_allows_notifications(p_staff_id) then
      return;
    end if;

    perform realtime.send(
      jsonb_build_object('v', 1, 'reason', 'schedule_changed'),
      'schedule_changed',
      'staff:' || p_staff_id::text || ':schedule',
      true
    );
  exception
    when others then
      raise warning 'WarnStaffScheduleSignal: %', sqlerrm;
  end;
end;
$$;

comment on function private.notify_staff_schedule_changed(uuid) is 'SPECS-INDEX #885/#886:通知某位服務人員「你的班表有變動」(Realtime Broadcast 私有頻道 staff:<staff_id>:schedule,事件 schedule_changed,payload 只有 {v:1, reason:schedule_changed})。同一筆交易內同一位服務人員只發一次(GUC miaoyue.rt_staff_notified);只發給在職 + 已開通登入 + 行事曆檢視有開的人。只給 bookings / booking_assistants 的 AFTER trigger 呼叫,三個角色都沒有 EXECUTE。';

revoke execute on function private.notify_staff_schedule_changed(uuid) from public, anon, authenticated;

-- =========================================================================
-- #887 bookings 的 AFTER trigger(主要服務人員;轉派時新舊兩人都通知)
--   📌 engineer 補強(規格書 #887 的範例只通知主要服務人員,2026-10-01,待主腦確認):
--   UPDATE 時**也通知這張單目前的每一位助手**。理由:get_my_booking_schedule 第二段 union all
--   讓助手看得到這張單(排除 cancelled、用 start_at/end_at 判斷範圍),所以 bookings 本身的變動
--   ——取消、改時間(move_booking mode=time)、確認/完成、#844 還原完成/取消已完成——助手的畫面
--   也要變;這些路徑都**不會**碰 booking_assistants,#888 的 trigger 抓不到。不補的話,
--   「取消一張有納編的單,助手畫面上那格不會消失」(使用者點名的納編情境)。
--   成本:每列 UPDATE 多一次走 booking_assistants (booking_id, staff_id) 唯一索引的查詢;去重照舊。
--   INSERT 不需要(建單時助手列是之後才插入,由 #888 處理);DELETE 不需要(ON DELETE CASCADE
--   刪助手列會觸發 #888 的 row trigger)。
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
    perform private.notify_staff_schedule_changed(new.staff_id);
  elsif tg_op = 'DELETE' then
    perform private.notify_staff_schedule_changed(old.staff_id);
  else
    perform private.notify_staff_schedule_changed(new.staff_id);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_staff_schedule_changed(old.staff_id);
    end if;
    for v_assistant_staff_id in
      select ba.staff_id from public.booking_assistants ba where ba.booking_id = new.id
    loop
      perform private.notify_staff_schedule_changed(v_assistant_staff_id);
    end loop;
  end if;
  return null;
end;
$$;

comment on function private.tg_bookings_notify_staff_schedule() is 'SPECS-INDEX #887:bookings 任何 INSERT/UPDATE/DELETE 後通知主要服務人員(轉派時新舊兩人都通知);UPDATE 時也通知這張單目前的助手(取消/改時間/改狀態助手畫面也要變)。刻意不做欄位過濾(規格書 #887:簡單勝過精巧,避免「有時候會即時有時候不會」)。';

revoke execute on function private.tg_bookings_notify_staff_schedule() from public, anon, authenticated;

drop trigger if exists bookings_notify_staff_schedule on public.bookings;
create trigger bookings_notify_staff_schedule
after insert or update or delete on public.bookings
for each row execute function private.tg_bookings_notify_staff_schedule();

-- =========================================================================
-- #888 booking_assistants 的 AFTER trigger(助手 = 使用者點名的「納編」)
--   update_booking:全刪再全插 ⇒ 被移除的人(DELETE)、留下與新加的人(INSERT)都收到,去重後各 1 則
--   move_booking reassign_assistant:純 UPDATE staff_id ⇒ 新舊兩人都收到
--   刪整筆訂單:ON DELETE CASCADE 也會觸發 row trigger ⇒ 助手也收到
-- =========================================================================
create or replace function private.tg_booking_assistants_notify_staff_schedule()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    perform private.notify_staff_schedule_changed(new.staff_id);
  elsif tg_op = 'DELETE' then
    perform private.notify_staff_schedule_changed(old.staff_id);
  else
    perform private.notify_staff_schedule_changed(new.staff_id);
    if old.staff_id is distinct from new.staff_id then
      perform private.notify_staff_schedule_changed(old.staff_id);
    end if;
  end if;
  return null;
end;
$$;

comment on function private.tg_booking_assistants_notify_staff_schedule() is 'SPECS-INDEX #888:booking_assistants(助手/納編)任何 INSERT/UPDATE/DELETE 後通知那位助手本人(轉派時新舊兩人都通知;CASCADE 刪除也會觸發)。';

revoke execute on function private.tg_booking_assistants_notify_staff_schedule() from public, anon, authenticated;

drop trigger if exists booking_assistants_notify_staff_schedule on public.booking_assistants;
create trigger booking_assistants_notify_staff_schedule
after insert or update or delete on public.booking_assistants
for each row execute function private.tg_booking_assistants_notify_staff_schedule();
