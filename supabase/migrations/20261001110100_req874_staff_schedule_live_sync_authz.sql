-- SPECS-INDEX #874 服務人員端行事曆即時同步 —— 批次 2:頻道授權端(#890 + #891),刻意不建 INSERT 政策(#892)
-- 規格書:.project/specs/服務人員端即時同步.md v1.1(§二 #889~#893、§三 批次 2、§五 給 engineer 的提醒)
-- 依賴:20261001110000_req874_staff_schedule_live_sync_signal.sql(批次 1 發送端)
--
-- =========================================================================
-- 這支 migration 做什麼
-- =========================================================================
--   讓服務人員「只能」加入自己的私有頻道 staff:<自己的 merchant_staff.id>:schedule,收資料庫
--   trigger 發的「你的班表有變動」鈴聲。Realtime 伺服器在有人加入私有頻道時,會以那個人的 JWT 身分
--   (role = authenticated、request.jwt.claims 帶 sub)並 SET realtime.topic = 頻道名,去查
--   realtime.messages 的 RLS 政策 —— 查得到才放行,否則回 CHANNEL_ERROR
--   (本機實測:沒有任何政策時一律回「Unauthorized: You do not have permissions to read from this
--   Channel topic」,見 scripts/req874-realtime-authz-probe.mjs)。
--   ⇒ 本檔**只新增一條 SELECT 政策 + 一支 private 判定函式**。不放寬任何既有政策、不改任何既有函式、
--     不新增任何 public 函式(PostgREST 不會多出任何 /rest/v1/rpc/ 端點)。
--     這是本專案第一次動 realtime schema。
--
-- =========================================================================
-- #890 private.can_listen_staff_schedule_topic(p_topic text)
-- =========================================================================
--   * 為什麼包成 plpgsql 函式:要從 topic 字串切出 UUID。直接在政策寫 ::uuid,亂打的 topic
--     (例如 staff:abc:schedule)會讓政策「報錯」而不是「乾淨拒絕」,而 Postgres 不保證 AND 的
--     求值順序,不能靠前面的 regex 短路。⇒ 先比對形狀,再在 begin … exception 裡安全轉型。
--   * 📌 engineer 收緊(規格書範例的 regex 也接受大寫 A-F,2026-10-01,待主腦確認):只接受
--     **小寫** UUID。資料庫端(#885)與前端 staffScheduleTopic(批次 3 已把 id 轉小寫)都只產生小寫
--     頻道名;若接受大寫,同一位服務人員就能另外開一個「永遠不會有訊號」的大寫頻道,沒有用途、
--     只是多一個連線。收緊後,每位服務人員在每間店恰好只有一個可加入的頻道。
--   * 判定 = private.is_own_staff_row(本人 user_id = auth.uid() + status = 'active' +
--     login_status = 'active')且 private.has_own_staff_permission(…, 'staff_calendar_view')
--     (有 granted = true 的紀錄)—— 跟 get_my_booking_schedule 的前置檢查逐字同一組函式,
--     不另發明標準。
--   * 🔴 訂閱端 ↔ 發送端判定一致(#890 v1.1):發送端(#885)= status/login_status 都 active
--     + #876 helper(對已開通登入者 = staff_calendar_view 有 granted = true 的紀錄)。
--     對「本人」而言兩邊在「開 / 沒紀錄 / granted = false / 停用 / 未完成登入」各狀態下結果逐一相同,
--     pgTAP module14_07 的 F 段鎖住。
--   * 不靠「UUID 難猜」:每次加入頻道,伺服器都用 auth.uid() 重新驗;改頻道名裡的 id 訂別人的,
--     user_id = auth.uid() 不成立 ⇒ false ⇒ CHANNEL_ERROR(資安清單 #5)。
--   * EXECUTE:只給 authenticated(RLS 運算式以查詢者身分執行,Realtime 授權時角色是 authenticated);
--     public / anon 收回(未登入者不該有任何頻道)。放 private schema ⇒ PostgREST 不曝光。
--     函式本體內不寫註解,說明全部在 $$ 之外,套正式庫後的 md5(prosrc) 指紋比對才穩定。
--
-- =========================================================================
-- #891 realtime.messages 的 SELECT 政策 staff_schedule_broadcast_receive(只給「收」)
-- =========================================================================
--   * 官方:要加入 Broadcast 頻道,至少要有該 topic 的讀或寫權限之一 ⇒ 只有 SELECT 就能加入、接收。
--   * extension = 'broadcast':presence 不給(我們不用 presence)。
--   * 📌 engineer 補強(規格書範例沒有,2026-10-01,待主腦確認):多加
--     realtime.messages.topic = realtime.topic() —— 只看得到「目前這個頻道」自己的列。
--     規格書範例只看 realtime.topic() 這個設定值,不看列本身的 topic:萬一有人能以 authenticated
--     身分直接查 realtime.messages(目前 PostgREST 只曝光 public / graphql_public,所以做不到),
--     把 realtime.topic 設成自己的頻道就能讀到**所有**頻道的列。加上這條後,本機實測 Realtime
--     加入頻道照常 SUBSCRIBED(Realtime 授權時查的就是該 topic 的列)。
--   * 整個判定包成 (select …) ⇒ Postgres 當 InitPlan 只算一次,不會每列呼叫一次函式
--     (官方 RLS 效能建議;每次加入頻道都會跑)。
--
-- =========================================================================
-- 🔴 #892 刻意**不**建立任何 INSERT(或 UPDATE / DELETE / ALL)政策 —— 這不是疏漏,是設計
-- =========================================================================
--   * authenticated 與 anon 對 realtime.messages 都**有表層 INSERT 權限**,而且
--     relforcerowsecurity = false ⇒ **RLS 政策是唯一那道牆**。
--   * 很多教學文章(連官方入門範例)都寫 `for insert to authenticated with check (true)`。只要有人
--     「順手補齊」,任何登入者就能用 channel.send() / HTTP 廣播 API 對**任意**服務人員的頻道灌訊號
--     ⇒ 強迫對方無限次重查(對資料庫的放大攻擊)+「行事曆一直閃」的騷擾。
--   * 我們完全不需要客戶端發訊息:訊號 100% 由資料庫 trigger 以 postgres(rolbypassrls = true)
--     身分發出,不受 RLS 約束。⇒ 結果是:**收得到、發不出去。**
--   * 🔴 realtime.send 的 ACL 是 =X/supabase_realtime_admin(PUBLIC 有 EXECUTE)。它現在打不到,
--     只因為 PostgREST 只曝光 public schema。⇒ **永遠不要在 public schema 建任何包裝
--     realtime.send 的函式**,那等於開一個「任何登入者可對任意頻道發訊息」的 RPC 端點。
--   * 這兩點由 pgTAP module14_07 的 G 段鎖住(政策只有 1 條且是 SELECT;以 authenticated 身分
--     直接 insert 被 RLS 擋;public schema 沒有任何函式原文提到 realtime.send)。
--
-- =========================================================================
-- 上線注意
-- =========================================================================
--   * 套正式庫前,使用者先在 Supabase 後台 Realtime → Settings 確認 Realtime 啟用、關閉
--     「Allow public access」(#893)。本機沒有那個開關,私有頻道照樣檢查本政策(已實測)。
--   * 與批次 1 同一次上線、排在 #876(20261001100000)之後;套用後以 md5(prosrc)(先 CRLF→LF)
--     比對 private.can_listen_staff_schedule_topic 的指紋。
--
-- 用語:一律「服務人員」。

create or replace function private.can_listen_staff_schedule_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
begin
  if p_topic is null then
    return false;
  end if;

  if p_topic !~ '^staff:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:schedule$' then
    return false;
  end if;

  begin
    v_staff_id := substring(p_topic from 7 for 36)::uuid;
  exception
    when others then
      return false;
  end;

  return private.is_own_staff_row(v_staff_id)
     and private.has_own_staff_permission(v_staff_id, 'staff_calendar_view');
end;
$$;

comment on function private.can_listen_staff_schedule_topic(text) is 'SPECS-INDEX #890:目前登入者可不可以加入 Realtime 私有頻道 p_topic。只認 staff:<小寫 merchant_staff.id>:schedule,且必須是本人(is_own_staff_row:user_id = auth.uid()、status / login_status 都 active)並開通行事曆檢視(has_own_staff_permission staff_calendar_view),跟 get_my_booking_schedule 同標準、跟發送端 notify_staff_schedule_changed 判定一致。形狀不對一律回 false、不丟錯。只給 realtime.messages 的 SELECT 政策 staff_schedule_broadcast_receive 呼叫。';

revoke execute on function private.can_listen_staff_schedule_topic(text) from public, anon;
grant  execute on function private.can_listen_staff_schedule_topic(text) to authenticated;

drop policy if exists staff_schedule_broadcast_receive on realtime.messages;
create policy staff_schedule_broadcast_receive
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and realtime.messages.topic = (select realtime.topic())
  and (select private.can_listen_staff_schedule_topic(realtime.topic()))
);

comment on policy staff_schedule_broadcast_receive on realtime.messages is 'SPECS-INDEX #891:服務人員只能加入 / 接收自己的 staff:<merchant_staff.id>:schedule 私有 broadcast 頻道。🔴 #892:realtime.messages 刻意沒有任何 INSERT / UPDATE / DELETE 政策(authenticated 有表層 INSERT 權限,RLS 是唯一的牆),不要「順手補齊」—— 訊號只由資料庫 trigger 以 postgres 身分發出。';
