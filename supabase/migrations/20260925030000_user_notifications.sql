-- 模組 15 擴充:站內通知中心(鈴鐺)— 資料層 + 標已讀 + 保留期限清理
-- 對應規格書 .project/specs/手機推播擴及三種角色.md §十三(13.2 / 13.8 / 13.9)。
-- 需求編號 #751、#752、#758、#759。
--
-- ⚠️ 這支 migration 刻意排在 20260925020000(服務人員報表歸月基準修正 #767)之後 —— 那一支
--    還在等使用者手動套用,兩者沒有任何交集(不同的表、不同的函式),但帳本順序要正確。
--
-- =========================================================================
-- 這支 migration 完全不修改任何既有物件:沒有 alter、沒有 drop、沒有 create or replace 蓋掉
-- 別人的函式。全部都是新增(一張新表、兩支新函式、一個新排程)。所以套用失敗時不會讓既有
-- 功能處於半殘狀態。
-- =========================================================================
--
-- ⚠️ 動手前的唯讀核對(CLAUDE.md 核心行為原則 5-1):這支 migration 一列資料都不寫、一列資料
--    都不刪(§13.9 的清理是排程之後才會跑的事,不是套用當下)。engineer 2026-09-25 對正式專案
--    wjtbmmnakcriuaqoknsq 實際查證過的兩件事,結論寫在這裡供之後維護的人參考:
--      ① `bookings` **沒有** deleted_at / is_deleted 這類軟刪除欄位(已列全部 41 個欄位確認);
--         取消是 status='cancelled' + cancelled_at,那是狀態變更、不是刪除。
--         而「真的 DELETE FROM bookings」確實存在一條路:`public.rollback_bulk_operation`
--         (復原歷史訂單匯入)—— 全庫只有這一支函式的本體含 `delete from public.bookings`。
--      ⇒ 所以 booking_id 的 `on delete set null` **不是多餘的防禦**,是真的會被觸發到,
--         而且是唯一能讓「訂單被硬刪除之後,通知內容還看得到」成立的寫法。
--      ② 既有的 `push_notification_log` 只有 1 條 SELECT 政策、0 條 INSERT/UPDATE/DELETE 政策
--         (實查 pg_policy)。這張新表的權限收斂方式跟它一致,再加上表層 GRANT 也一起收掉。

-- =========================================================================
-- §13.2 public.user_notifications
-- 一列 = 「系統在某個時間,以某個身份,發給某個登入帳號的一則通知」。
-- =========================================================================
create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  target_type text not null check (target_type in ('admin', 'agent', 'staff')),
  target_id uuid not null,
  event_type text not null check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day'
    )
  ),
  booking_id uuid references public.bookings(id) on delete set null,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.user_notifications is '§13.2:站內通知中心(鈴鐺)唯一的資料來源。一列 = 系統發給某個登入帳號的一則通知。跟既有的 push_notification_log 分工明確(§13.1):那張表是給「商家管理員稽核這間店的通知發了沒」用的、RLS 主體是 private.can_manage_push_notification(merchant_id)、長期保存;這張表是給「每一個人看自己收到什麼」用的、RLS 主體是 user_id = auth.uid()、30 天 / 每人 500 筆就清掉(§13.9)。刻意不合併成同一張表,四個理由見規格書 §13.3。';
comment on column public.user_notifications.user_id is '§13.2:RLS 就靠這一欄(user_id = auth.uid())。on delete cascade —— 帳號刪除時通知自動消失。';
comment on column public.user_notifications.target_type is '§13.2:以什麼身份收到的。同一個人同時是客服又是服務人員時,兩則通知點下去的目的地不同(§5.5),所以必須記。';
comment on column public.user_notifications.target_id is '§13.2:對應 merchant_admins.id / merchant_agents.id / merchant_staff.id。刻意不加外鍵,比照 push_event_subscriptions.target_id 與 line_binding_codes.target_id 的既有先例(同一欄位對應三張角色表)。';
comment on column public.user_notifications.event_type is '§13.2:刻意**不含** ''test'' —— 測試推播是使用者自己按出來的,記進鈴鐺只是雜訊(§6.6 允許 60 秒內按 3 次,等於一分鐘塞 3 列垃圾)。之後要改主意只是「CHECK 放寬 + push-send-test 多寫一列 insert」的事。';
comment on column public.user_notifications.booking_id is '§13.2:on delete set null —— 訂單真的被硬刪除時(全庫唯一的硬刪除路徑是 rollback_bulk_operation)這一欄變 null,但通知本身仍然看得到,因為 title/body 是發送當下的文字副本。';
comment on column public.user_notifications.title is '§13.2:發送當下已經套完變數的文字副本,跟 push_notification_log.rendered_title 是同一份內容(**不含** §4.8 給管理員/客服加的商家名稱前綴 —— 鈴鐺面板本身就會另外顯示商家名稱,再加一次前綴是重複)。刻意存副本而不是事後重算:通知講的是「當時發生了什麼」,訂單之後改了時間也不該回頭改變歷史通知。';
comment on column public.user_notifications.read_at is '§13.2:未讀的定義就是這一欄為 null。只能透過 public.mark_my_notifications_read(§13.8)寫入 —— 這張表刻意沒有 UPDATE 政策。';

-- ⚠️ 刻意不存「點下去要去哪裡」的網址(§13.2)。這是 §〇.5 那個 bug 的直接教訓:
--    `/app/my-calendar` 這個不存在的路由被寫死在程式碼裡、而且沒人發現。如果把目的地網址存進
--    資料庫,那個錯誤就會被永久冷凍在每一列歷史紀錄裡,將來修好路由也救不回舊紀錄。
--    改成只存 event_type / target_type / booking_id,點擊時用純函式即時算出目的地(§13.7)。

-- §13.2 索引三支:
create index user_notifications_user_created_idx
  on public.user_notifications (user_id, created_at desc);
-- partial index:未讀數字(§13.5 的 count exact + head)只掃這一支。
create index user_notifications_unread_idx
  on public.user_notifications (user_id)
  where read_at is null;
-- §13.9 的清理排程用它。
create index user_notifications_created_at_idx
  on public.user_notifications (created_at);

-- =========================================================================
-- §13.2 RLS 與權限:五點全部照做,一點都不簡化
-- =========================================================================
alter table public.user_notifications enable row level security;

-- 1 + 2:只有 SELECT 政策,條件是 user_id = auth.uid()。
create policy user_notifications_select on public.user_notifications
  for select to authenticated
  using (user_id = auth.uid());

-- 3. **完全不建立 INSERT / UPDATE / DELETE 政策。** 寫入只由 service role 做(繞過 RLS)。
--
-- 🔴 為什麼不開 UPDATE 政策讓前端自己標已讀(§13.2 第 5 點,`supabase-permission-hygiene`
--    規則 2 記載的「RLS UPDATE policy 的欄位陷阱」):PostgreSQL 的 RLS **不做欄位層級權限**。
--    只要開了 UPDATE 政策,使用者就能把自己那一列的 title / body 改成任何內容 —— 通知的內容
--    是系統發出的事實紀錄,不該讓收件人改。所以標已讀改走下面的 SECURITY DEFINER 函式,
--    那支函式只碰 read_at 一個欄位。**不要為了圖方便回頭加 UPDATE 政策。**

-- 4. 並且明確收掉表層級 GRANT。Supabase 的 public schema 對 anon / authenticated 有預設 GRANT,
--    **光是「不建政策」不夠乾淨** —— 要讓「沒有權限」這件事同時寫在 GRANT 跟政策兩層上。
revoke insert, update, delete on public.user_notifications from anon, authenticated;

-- =========================================================================
-- §13.8 public.mark_my_notifications_read(p_ids uuid[] default null)
-- 前端唯一的寫入管道。回傳實際被標成已讀的列數。
-- =========================================================================
create or replace function public.mark_my_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
begin
  -- §4.1 的核心安全規則:身分一律由後端從 auth.uid() 解析,這支函式**完全不接受 user_id 參數**,
  -- 前端沒有任何管道指定別人。未登入直接擋下,不要靜默回 0(那會讓呼叫端分不清「沒東西可標」
  -- 跟「你根本沒登入」)。
  if v_user_id is null then
    raise exception '必須登入才能標記站內通知為已讀' using errcode = '42501';
  end if;

  -- 🔴 這支函式只寫 read_at 一個欄位。title / body / event_type / target_* 永遠不可能被改到。
  update public.user_notifications
     set read_at = now()
   where user_id = v_user_id
     and read_at is null
     and (p_ids is null or id = any (p_ids));

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.mark_my_notifications_read(uuid[]) is '§13.8:把自己的站內通知標成已讀。p_ids 為 null 時把自己**全部**未讀標完(包含不在面板那 20 則裡面的 —— 使用者按「全部標為已讀」的意思就是全部清掉)。`user_id = auth.uid()` 這個條件不可省:帶別人的 id 進來會一列都改不到、回傳 0。只寫 read_at 一個欄位,通知內容永遠改不動。';

-- `supabase-permission-hygiene` 規則 1:revoke 一定要含 public(drop+create 會繼承 PUBLIC EXECUTE)。
-- 這一支是前端要呼叫的,所以 authenticated 保留;anon 沒有任何理由能標記別人的通知。
revoke execute on function public.mark_my_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_my_notifications_read(uuid[]) to authenticated;

-- =========================================================================
-- §13.9 public.prune_user_notifications()
-- 每人最多保留 500 筆,且超過 30 天的一律刪除,兩個條件都套用(誰先砍到算誰的)。
-- =========================================================================
--
-- ⚠️ 這支跟既有的 push-notify-reminder-daily 排程差別很大,**不要照抄那支的複雜寫法**:
--    那支要用 pg_net + Vault 密鑰去打 Edge Function;這一支是純資料庫內的刪除,
--    不需要 pg_net、不需要密鑰、不需要 Edge Function。
create or replace function public.prune_user_notifications()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_expired integer;
  v_overflow integer;
begin
  -- ① 超過 30 天的一律刪除。
  delete from public.user_notifications
   where created_at < now() - interval '30 days';
  get diagnostics v_expired = row_count;

  -- ② 每個 user_id 只留最新 500 列。
  --    排序第二鍵刻意加 id:同一毫秒建出來的兩列(同一件事命中兩個身份就是這種情形)如果只用
  --    created_at 排序,row_number() 的結果不穩定,同一批資料跑兩次可能刪到不同的列。
  delete from public.user_notifications
   where id in (
     select id
       from (
         select id,
                row_number() over (
                  partition by user_id
                  order by created_at desc, id desc
                ) as rn
           from public.user_notifications
       ) ranked
      where ranked.rn > 500
   );
  get diagnostics v_overflow = row_count;

  return v_expired + v_overflow;
end;
$$;

comment on function public.prune_user_notifications() is '§13.9:站內通知的保留期限清理。30 天 + 每人 500 筆兩個條件都套用。⚠️ 30 / 500 是依「一間一天 30 筆訂單的店、管理員開三種事件 ≈ 一天 40 則」算出來的建議值,不是技術限制,使用者覺得不合適改一個數字重跑 migration 就好。只有排程(以 postgres 身份執行)呼叫得到,一般使用者一律 42501。';

-- 只有排程呼叫得到:三個一般角色全部收回(規則 1 明文要包含 authenticated)。
-- cron.schedule 是以排程建立者(postgres,也是這支函式的 owner)身份執行,owner 永遠有 EXECUTE,
-- 所以收掉這三個角色不會讓排程失效。service_role 保留是為了萬一之後要從 Edge Function 手動觸發
-- 一次清理(比照 resolve_push_recipients / is_staff_push_event_disabled 的既有慣例)。
revoke execute on function public.prune_user_notifications() from public, anon, authenticated;
grant execute on function public.prune_user_notifications() to service_role;

-- =========================================================================
-- §13.9 排程:每天 UTC 02:30(= 台北 10:30)。
-- 刻意跟既有的 push-notify-reminder-daily(UTC 01:00)錯開,不要兩個排程擠在一起。
-- pg_cron 本身已經由 20260922100200_push_notifications_cron.sql 啟用過,這裡不重複建 extension。
-- cron.schedule 對同名排程是「覆蓋」語意,所以這一行重複套用是安全的。
-- =========================================================================
select
  cron.schedule(
    'user-notifications-prune-daily',
    '30 2 * * *',
    $$ select public.prune_user_notifications(); $$
  );
