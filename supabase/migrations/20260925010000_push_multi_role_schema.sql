-- 模組 15 擴充:手機推播擴及三種角色(管理員 / 客服 / 服務人員)— 資料層
-- 對應規格書 .project/specs/手機推播擴及三種角色.md 第二節(2.1~2.5)、第三節(3.1/3.2)、
-- 規則 4.6(孤兒訂閱清理觸發器)。需求編號 #715、#716、#717、#718、#719、#721、#722、#729。
--
-- ⚠️ 這一批刻意不做 §十三 的「站內通知中心(鈴鐺)」(#751~#761),所以這裡沒有
--    user_notifications 這張表。鈴鐺是獨立批次,理由見規格書 §十一「第 5 批」。
--
-- ⚠️ 動手前的 SELECT 先行核對(CLAUDE.md 核心行為原則 5-1,規格書 §3.1 第 1 點 / §3.2 第 1 點):
--    2026-09-25 對正式專案 wjtbmmnakcriuaqoknsq 實際查詢結果:
--      staff_push_subscriptions        = 0 筆   ← 沒有任何人開通過,換表零風險
--      merchant_push_event_settings    = 924 筆(231 商家 × 4 事件),其中 enabled = 8
--      push_notification_log           = 3 筆,而且 staff_id is not null 的有 0 筆
--                                        (三筆全部是 skip_reason='event_disabled' 的跳過紀錄)
--      merchant_agent_permissions      = 0 筆
--    也就是說 §3.2 的回填實際上會影響 0 列 —— 規格書當時預期「3 列要回填」,實際上那 3 列的
--    staff_id 本來就是 null。回填語句仍然保留(冪等、無副作用),並在下面用一道 assert 擋住
--    「有 staff_id 卻沒回填到」的情況。
--
--    下面的遷移仍然寫成「兩條路都走得通」的形式(規格書 §3.1 第 2/3 點):先建新表 → 搬資料
--    (0 筆時是 no-op)→ 比對筆數 → 才 drop 舊表。這樣就算套用當下舊表已經有資料,也不會遺失。

-- =========================================================================
-- §2.1 push_subscriptions:裝置登記,主體從「服務人員」改成「登入帳號」
-- =========================================================================
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh_key text not null,
  auth_key text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

comment on table public.push_subscriptions is '§2.1:裝置登記。一列 = 「某個登入帳號的其中一台裝置/瀏覽器願意接收推播」。取代舊的 staff_push_subscriptions —— 主體是登入帳號(user_id),不是某間店的某個職務,因為一個人只有一支手機,不會因為他同時是客服又是服務人員就多出一支。「這台裝置要收哪間店的什麼事件」完全由 push_event_subscriptions(§2.2)決定。刻意沒有 merchant_id 欄位。';
comment on column public.push_subscriptions.last_seen_at is '§6.3 的送達回報(ack)成功時由 service role 更新。這是這個欄位第一次真的有程式碼會寫它。';

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using (user_id = auth.uid());

create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check (user_id = auth.uid());

create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using (user_id = auth.uid());

-- §2.1:刻意沒有 UPDATE 政策 —— last_seen_at 只由 service role 更新。
--
-- ⚠️ 這裡有一個規格書沒有講清楚、實作上一定會撞到的矛盾,處理方式記在這裡:
--    §2.1 同時要求 ①沒有 UPDATE 政策,以及 ②重複點「開啟通知」時用
--    `upsert ... on conflict (endpoint) do update set user_id = excluded.user_id, ...`
--    (「同一台手機換人登入時必須改主人」)。這兩件事在 PostgREST 上不可能同時成立:
--      - upsert 的衝突分支走的是 UPDATE 路徑,沒有 UPDATE 政策會直接被 RLS 擋下;
--      - 就算補一條 `using (user_id = auth.uid())` 的 UPDATE 政策,「換主人」的情境下既有那一列
--        屬於「舊主人」,新主人的 USING 判斷必定為 false,照樣擋下 —— 等於做不到規格要的行為。
--    → 採用的解法:不開 UPDATE 政策(維持 §2.1 字面要求),改成提供一支 SECURITY DEFINER 的
--      public.upsert_my_push_subscription(...)(見 20260925010100_push_multi_role_functions.sql)。
--      那支函式完全不收 user_id 參數,一律用 auth.uid() 當主人(§4.1 的核心安全規則),
--      前端沒有任何管道可以替別人登記裝置。

-- =========================================================================
-- §2.5 private.owns_push_target(p_target_type, p_target_id, p_merchant_id)
-- 「目前登入的這個人,是不是就是這組 (merchant_id, target_type, target_id) 所指的那個人」。
-- 寫法完全比照既有的 private.can_manage_* 家族。
-- =========================================================================
create or replace function private.owns_push_target(
  p_target_type text,
  p_target_id uuid,
  p_merchant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select case p_target_type
    when 'admin' then exists (
      select 1 from public.merchant_admins a
      where a.id = p_target_id and a.merchant_id = p_merchant_id and a.user_id = auth.uid()
    )
    when 'agent' then exists (
      select 1 from public.merchant_agents g
      where g.id = p_target_id and g.merchant_id = p_merchant_id and g.user_id = auth.uid()
        and g.status = 'active'
    )
    when 'staff' then exists (
      select 1 from public.merchant_staff s
      where s.id = p_target_id and s.merchant_id = p_merchant_id and s.user_id = auth.uid()
        and s.status = 'active' and s.login_status = 'active'
    )
    else false
  end;
$$;

comment on function private.owns_push_target(text, uuid, uuid) is '§2.5:push_event_subscriptions 的擁有權判斷。三種角色的在職條件跟 useMerchantRole(模組 3 §5.1)完全一致,不自己另發明一套:管理員存在即有效、客服要 status=active、服務人員要 status=active 且 login_status=active。未登入時 auth.uid() 為 null,三個 exists 全部為 false。';

-- ⚠️ supabase-permission-hygiene 規則 1:revoke 一定要包含 authenticated 之外的 public/anon。
--    這一支跟 private.can_manage_push_notification 一樣「必須」給 authenticated——RLS 政策是在
--    authenticated 身份下執行的,收掉會讓政策直接失效。anon 連 private schema 的 USAGE 都沒有。
revoke execute on function private.owns_push_target(text, uuid, uuid) from public, anon;
grant execute on function private.owns_push_target(text, uuid, uuid) to authenticated;

-- =========================================================================
-- §2.2 push_event_subscriptions:每個人自己的 4 個事件開關
-- =========================================================================
create table public.push_event_subscriptions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  target_type text not null check (target_type in ('admin', 'agent', 'staff')),
  target_id uuid not null,
  event_type text not null check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day'
    )
  ),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, target_type, target_id, event_type)
);

comment on table public.push_event_subscriptions is '§2.2:一列 = 一個人的一個身份的一種事件。使用者裁決的方案 C(每個人自己決定要收哪幾種)真正落地的地方。target_type/target_id 沿用模組 11 line_binding_codes 完全相同的多型語彙,target_id 刻意不加外鍵(同一欄位對應三張角色表),孤兒列由下方的 AFTER DELETE 觸發器清理。enabled 預設 true(Q7 裁決:四個事件預設全開)——刻意跟商家總開關 merchant_push_event_settings.enabled 預設 false 相反,理由:這張表的列是「使用者按下開啟通知時才被建出來的」,建出來那一刻代表他就是想收通知。';
comment on column public.push_event_subscriptions.target_id is '§2.2:對應 merchant_admins.id / merchant_agents.id / merchant_staff.id。刻意不加外鍵,比照 line_binding_codes.target_id 的既有先例。';

-- 派送時要用它找出「這間店訂閱了這個事件的所有人」(§5.1)。
create index push_event_subscriptions_dispatch_idx
  on public.push_event_subscriptions (merchant_id, event_type)
  where enabled;

create trigger push_event_subscriptions_set_updated_at
  before update on public.push_event_subscriptions
  for each row execute function public.set_updated_at();

alter table public.push_event_subscriptions enable row level security;

create policy push_event_subscriptions_select on public.push_event_subscriptions
  for select to authenticated
  using (private.owns_push_target(target_type, target_id, merchant_id));

create policy push_event_subscriptions_insert on public.push_event_subscriptions
  for insert to authenticated
  with check (private.owns_push_target(target_type, target_id, merchant_id));

-- ⚠️ supabase-permission-hygiene 規則 2(RLS UPDATE policy 的欄位陷阱):USING 與 WITH CHECK
--    兩邊都明確寫同一個條件。
--
--    📌 一個要更正的技術敘述(2026-09-25 實測,證據在下面):規格書 §2.2/§4.1 寫「只寫 USING
--    會讓人把 target_id 改成別人的」——**這句話對 PostgreSQL 來說是錯的**。做法:在本機
--    Docker 容器把這條政策改成只有 USING(`pg_policy.polwithcheck` 實際查出來是 NULL),
--    再跑 supabase/tests/database/module15_02_push_multi_role.sql,那條「把自己的 target_id
--    改成別人的」斷言**照樣通過**(更新照樣被擋下 42501)。原因是 CREATE POLICY 的文件行為:
--    UPDATE 政策省略 WITH CHECK 時,PostgreSQL 會把 USING 運算式同時當成 WITH CHECK 使用。
--
--    那為什麼還是明確寫出來?兩個理由,跟「防止改 target_id」無關:
--      1. 讓「新列也要通過同一個檢查」這件事寫在臉上,之後有人改 USING 時不會誤以為只影響讀取;
--      2. 一旦將來有人想放寬 USING(例如讓管理員也看得到),WITH CHECK 就不會被一起放寬。
--
--    規則 2 真正要防的欄位陷阱在這張表上**依然存在但無害**:政策擋不住「改自己那一列的哪個
--    欄位」,而這張表除了 target_id 之外的可寫欄位只有 enabled/event_type —— 本人本來就該能改。
create policy push_event_subscriptions_update on public.push_event_subscriptions
  for update to authenticated
  using (private.owns_push_target(target_type, target_id, merchant_id))
  with check (private.owns_push_target(target_type, target_id, merchant_id));

create policy push_event_subscriptions_delete on public.push_event_subscriptions
  for delete to authenticated
  using (private.owns_push_target(target_type, target_id, merchant_id));

-- =========================================================================
-- §4.6 第 3 點:孤兒訂閱清理觸發器
-- 硬刪除服務人員/客服/管理員之後,對應的 push_event_subscriptions 列一起刪掉。
--
-- ⚠️ 這是衛生問題,不是安全問題 —— §5.1 的收件人解析一律從角色表 join 出來,孤兒列就算留著
--    也絕對發不出東西。所以觸發器失敗不影響正確性。
-- ⚠️ 動手前已用 pg_trigger 查過三張表目前的觸發器清單(2026-09-25):merchant_staff 有 4 支
--    (protect_identity_columns / protect_line_binding_columns /
--     protect_pending_login_email_columns / set_updated_at / sync_payroll_status_history)、
--    merchant_agents 有 1 支(set_updated_at)、merchant_admins 一支都沒有。
--    全部是 BEFORE INSERT/UPDATE 或 AFTER INSERT/UPDATE,沒有任何 AFTER DELETE,
--    所以新增這三支 AFTER DELETE 不會跟既有的互相干擾。
-- =========================================================================
create or replace function private.cleanup_orphan_push_event_subscriptions()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  delete from public.push_event_subscriptions
  where target_type = tg_argv[0] and target_id = old.id;
  return old;
end;
$$;

comment on function private.cleanup_orphan_push_event_subscriptions() is '§4.6 第 3 點:角色列被硬刪除時,順手清掉對應的 push_event_subscriptions 孤兒列。target_type 由觸發器的 tg_argv[0] 傳入,三張表共用同一支函式。';

revoke execute on function private.cleanup_orphan_push_event_subscriptions() from public, anon, authenticated;

create trigger merchant_admins_cleanup_push_event_subscriptions
  after delete on public.merchant_admins
  for each row execute function private.cleanup_orphan_push_event_subscriptions('admin');

create trigger merchant_agents_cleanup_push_event_subscriptions
  after delete on public.merchant_agents
  for each row execute function private.cleanup_orphan_push_event_subscriptions('agent');

create trigger merchant_staff_cleanup_push_event_subscriptions
  after delete on public.merchant_staff
  for each row execute function private.cleanup_orphan_push_event_subscriptions('staff');

-- =========================================================================
-- §2.4 push_notification_log 擴充:收件人多型化 + 測試推播 + 送達回報
-- 一列的語意從「一次事件對一位服務人員」改成「一次事件對一位收件人」。
-- =========================================================================
alter table public.push_notification_log
  add column target_type text,
  add column target_id uuid,
  add column ack_token uuid,
  add column acked_at timestamptz;

alter table public.push_notification_log
  add constraint push_notification_log_target_type_check
  check (target_type is null or target_type in ('admin', 'agent', 'staff'));

create unique index push_notification_log_ack_token_key
  on public.push_notification_log (ack_token);

comment on column public.push_notification_log.target_type is '§2.4:收件人的角色。跳過整件事(商家總開關關閉/沒有任何收件人/訂單沒指派服務人員)的那一列這兩欄為 null。';
comment on column public.push_notification_log.target_id is '§2.4:收件人的身份 id(merchant_admins/merchant_agents/merchant_staff 三者之一),無外鍵,同 §2.2。';
comment on column public.push_notification_log.ack_token is '§6.4:只有測試推播(event_type=''test'')會填。一次性、10 分鐘有效,service worker 用它回報送達。';
comment on column public.push_notification_log.acked_at is '§6.3:送達回報抵達的時間。有值 = 系統確認過「通知抵達了那台裝置的 service worker」(注意:不等於「使用者真的看到了」,誠實界線見 §6.5)。';

-- event_type 的 CHECK 加入 'test'(測試推播的記錄也寫這張表)。
-- ⚠️ merchant_push_event_settings 跟 push_event_subscriptions 的 CHECK 絕對不要加 'test' ——
--    測試推播不是一種可以訂閱的事件(§2.4)。
alter table public.push_notification_log
  drop constraint push_notification_log_event_type_check;
alter table public.push_notification_log
  add constraint push_notification_log_event_type_check
  check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day', 'test'
    )
  );

-- skip_reason 的 CHECK 加入 'personal_disabled' 與 'no_recipient'(語意表見 §5.3)。
alter table public.push_notification_log
  drop constraint push_notification_log_skip_reason_check;
alter table public.push_notification_log
  add constraint push_notification_log_skip_reason_check
  check (
    skip_reason is null
    or skip_reason in (
      'event_disabled', 'no_subscription', 'no_target', 'personal_disabled', 'no_recipient'
    )
  );

-- -------------------------------------------------------------------------
-- §3.2:staff_id 先回填到 target_type/target_id,再整欄移除。
-- supabase-permission-hygiene 規則 3:drop column 之前必須先回填,順序不能顛倒。
-- -------------------------------------------------------------------------
update public.push_notification_log
set target_type = 'staff', target_id = staff_id
where staff_id is not null;

do $$
declare
  v_missing int;
begin
  select count(*) into v_missing
  from public.push_notification_log
  where staff_id is not null and target_id is null;

  if v_missing > 0 then
    raise exception '§3.2 回填失敗:還有 % 列有 staff_id 但沒有 target_id,不可以 drop 欄位', v_missing;
  end if;
end;
$$;

alter table public.push_notification_log drop column staff_id;

comment on table public.push_notification_log is '§2.4:推播發送記錄。一列 = 「一次事件對一位收件人」(原本是「一次事件對一位服務人員」)。收件人由 target_type/target_id 表示。沒有 INSERT/UPDATE/DELETE 政策給一般角色,只由 Edge Function 用 service role 寫入;RLS 維持 private.can_manage_push_notification(merchant_id) 只開 SELECT。';

-- =========================================================================
-- §3.1 遷移:staff_push_subscriptions → push_subscriptions
-- 兩條路都走得通的寫法(規格書 §3.1 第 2/3 點),實際套用當下舊表是 0 筆。
-- =========================================================================
do $$
declare
  v_before int;
  v_moved int;
begin
  select count(*) into v_before from public.staff_push_subscriptions;

  -- 路徑 3:萬一套用當下已經有人開通了,先把裝置搬過去(0 筆時是 no-op)。
  insert into public.push_subscriptions (
    user_id, endpoint, p256dh_key, auth_key, user_agent, created_at
  )
  select ms.user_id, s.endpoint, s.p256dh_key, s.auth_key, s.user_agent, s.created_at
  from public.staff_push_subscriptions s
  join public.merchant_staff ms on ms.id = s.staff_id
  where ms.user_id is not null
  on conflict (endpoint) do nothing;

  -- 舊表的 merchant_id/staff_id 資訊轉成事件訂閱(四種事件各一列,enabled = true)。
  insert into public.push_event_subscriptions (merchant_id, target_type, target_id, event_type)
  select distinct s.merchant_id, 'staff', s.staff_id, e.event_type
  from public.staff_push_subscriptions s
  join public.merchant_staff ms on ms.id = s.staff_id
  cross join (
    values ('booking_created'), ('booking_cancelled'), ('booking_updated'),
           ('booking_reminder_next_day')
  ) as e(event_type)
  where ms.user_id is not null
  on conflict (merchant_id, target_type, target_id, event_type) do nothing;

  select count(*) into v_moved from public.push_subscriptions;

  -- 遷移前後比對:舊表裡「有 user_id 可對應」的列全部要搬到(§3.1 第 3 點末句)。
  if v_moved < (
    select count(distinct s.endpoint)
    from public.staff_push_subscriptions s
    join public.merchant_staff ms on ms.id = s.staff_id
    where ms.user_id is not null
  ) then
    raise exception '§3.1 遷移筆數對不上,停止(舊表 % 筆,新表 % 筆)', v_before, v_moved;
  end if;

  raise notice '§3.1 遷移完成:staff_push_subscriptions % 筆 → push_subscriptions % 筆', v_before, v_moved;
end;
$$;

drop table public.staff_push_subscriptions;
