-- 模組 15:服務人員推播通知(Web Push)— 資料層
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\服務人員推播通知.md 第二節(2.1~2.4)、
-- 第三節(RLS 影響評估,本模組不修改任何既有表)。
--
-- ⚠️ 實作偏離規格書之處(先在這裡留紀錄,完工回報再向主腦說明一次):
--   規格書 3.14/7.6/7.7/8.3 寫的是 `private.render_booking_notification_variables`,查證正式環境
--   後這支函式實際上是 `public.render_booking_notification_variables`(SECURITY DEFINER,已對一般
--   角色 revoke,效果跟放在 private schema 一樣,只是 schema 名稱不同)。本模組的 Edge Function
--   一律呼叫 `public.render_booking_notification_variables`,不是規格書字面上的 private 版本。

-- =========================================================================
-- 2.1 staff_push_subscriptions(服務人員的推播訂閱,一人可多筆)
-- =========================================================================
create table public.staff_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  staff_id uuid not null references public.merchant_staff(id) on delete cascade,
  endpoint text not null unique,
  p256dh_key text not null,
  auth_key text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

comment on table public.staff_push_subscriptions is '2.1:服務人員的推播訂閱(一人可多筆裝置)。endpoint 天然唯一。RLS 只開放服務人員操作自己名下的訂閱,商家管理員/客服沒有直接 SELECT 政策(2.1 邊界情況——要看有沒有開通,呼叫 get_staff_push_subscription_count,7.5)。';

create index staff_push_subscriptions_staff_idx on public.staff_push_subscriptions (staff_id);

alter table public.staff_push_subscriptions enable row level security;

create policy staff_push_subscriptions_select on public.staff_push_subscriptions
  for select to authenticated
  using (staff_id in (select id from public.merchant_staff where user_id = auth.uid()));

create policy staff_push_subscriptions_insert on public.staff_push_subscriptions
  for insert to authenticated
  with check (staff_id in (select id from public.merchant_staff where user_id = auth.uid()));

create policy staff_push_subscriptions_delete on public.staff_push_subscriptions
  for delete to authenticated
  using (staff_id in (select id from public.merchant_staff where user_id = auth.uid()));

-- 沒有 UPDATE 政策(2.1):訂閱物件不會被「編輯」,只有整筆新增/刪除。last_seen_at 由
-- service role(Edge Function)用管理端連線更新,不受這裡的 RLS 限制。

-- =========================================================================
-- 7.3 private.can_manage_push_notification(p_merchant_id uuid)
-- 完全比照 private.can_manage_line_notification 的既有寫法,section_key='push_notification'
-- (新的 section_key,商家管理員永遠可以,客服要被開通才行)。放在這裡(2.2 建表之前)是因為
-- 下面的 RLS 政策馬上就要用到,比照模組 11 schema migration 先建函式再套用政策的既有順序。
-- =========================================================================
create or replace function private.can_manage_push_notification(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'push_notification'
        and map.granted = true
    );
$$;

comment on function private.can_manage_push_notification(uuid) is '7.3:是否可以管理該商家的推播通知設定/發送記錄。完全比照 can_manage_line_notification 的既有寫法。';

revoke execute on function private.can_manage_push_notification(uuid) from public, anon;
grant execute on function private.can_manage_push_notification(uuid) to authenticated;

-- =========================================================================
-- 2.2 merchant_push_event_settings(推播事件設定,一商家一事件一列)
-- =========================================================================
create table public.merchant_push_event_settings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day'
    )
  ),
  enabled boolean not null default false,
  message_title text not null default '',
  message_body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, event_type)
);

comment on table public.merchant_push_event_settings is '2.2:推播事件設定,比照 merchant_line_event_settings 但沒有 notify_admin/agent/staff/member 對象欄位(通知對象永遠是這筆訂單的服務人員本人,見規格書判斷 2)。新商家建立時由 seed_default_push_event_settings(7.4)種好 4 筆,enabled 預設一律關閉。';

create trigger merchant_push_event_settings_set_updated_at
  before update on public.merchant_push_event_settings
  for each row execute function public.set_updated_at();

alter table public.merchant_push_event_settings enable row level security;

create policy merchant_push_event_settings_select on public.merchant_push_event_settings
  for select to authenticated
  using (private.can_manage_push_notification(merchant_id));

create policy merchant_push_event_settings_update on public.merchant_push_event_settings
  for update to authenticated
  using (private.can_manage_push_notification(merchant_id))
  with check (private.can_manage_push_notification(merchant_id));

-- 沒有 INSERT/DELETE 政策:4 種事件是系統固定種好的清單,商家不能新增/刪除,只能改內容。

-- =========================================================================
-- 2.3 push_notification_log(推播發送記錄)
-- =========================================================================
create table public.push_notification_log (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day'
    )
  ),
  booking_id uuid references public.bookings(id) on delete set null,
  staff_id uuid references public.merchant_staff(id) on delete set null,
  status text not null check (status in ('sent', 'partially_sent', 'failed', 'skipped')),
  skip_reason text check (
    skip_reason is null
    or skip_reason in ('event_disabled', 'no_subscription', 'no_target')
  ),
  device_count int not null default 0,
  success_count int not null default 0,
  error_detail text,
  rendered_title text,
  rendered_body text,
  attempted_at timestamptz not null default now()
);

comment on table public.push_notification_log is '2.3:推播發送記錄,一筆代表「對這位服務人員名下所有裝置」這一次事件的整體結果(不是每個裝置一筆,見規格書 2.3 說明)。沒有 INSERT/UPDATE/DELETE 政策給一般角色,只由 Edge Function 用 service role 寫入。';

create index push_notification_log_merchant_attempted_idx
  on public.push_notification_log (merchant_id, attempted_at desc);
create index push_notification_log_booking_idx
  on public.push_notification_log (booking_id);

alter table public.push_notification_log enable row level security;

create policy push_notification_log_select on public.push_notification_log
  for select to authenticated
  using (private.can_manage_push_notification(merchant_id));

-- 沒有 INSERT/UPDATE/DELETE 政策:只由 Edge Function 用 service role 寫入。

-- =========================================================================
-- 2.4 push_reminder_dedupe_log(前一天提醒的冪等紀錄)
-- =========================================================================
create table public.push_reminder_dedupe_log (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  reminder_date date not null,
  sent_at timestamptz not null default now(),
  primary key (booking_id, reminder_date)
);

comment on table public.push_reminder_dedupe_log is '2.4:防止「前一天提醒」排程任務重跑/被觸發兩次時,對同一筆訂單同一天重複發送。寫入方式一律 insert ... on conflict (booking_id, reminder_date) do nothing returning *,只有真正插入成功才繼續發送。啟用 RLS 但不建立任何政策,只有 service role 存取(比照 line_webhook_events)。';

alter table public.push_reminder_dedupe_log enable row level security;
-- 刻意不建立任何政策:只有 Edge Function 用 service role 存取。
