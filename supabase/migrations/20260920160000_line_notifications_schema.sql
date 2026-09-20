-- 模組 11:LINE 通知(資料層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\LINE通知.md 第一節(1.1-1.6)、
-- 一之二節(RLS 影響評估)、規則 2.9(merchant_staff 欄位保護觸發器)、3.17(權限判斷函式)、
-- 3.21(RLS 政策總覽,merchant_line_event_settings/line_notification_log 這兩張表的政策部分)。
--
-- ⚠️ 實作偏離規格書之處(已在完工回報向主腦說明,這裡先留紀錄):
--   1.4 line_binding_codes 規格書描述的「唯一索引 (code) where used_at is null and expires_at > now()」
--   在 PostgreSQL 裡無法建立——partial index 的 WHERE 子句只能用 IMMUTABLE 函式,now() 是 STABLE,
--   建立時會直接報錯(functions in index predicate must be marked IMMUTABLE)。改為在 3.4-3.8 產生
--   綁定碼的函式裡,用「先查詢目前有效範圍內是否已有相同號碼、有的話重新亂數」的迴圈邏輯達到
--   同樣的「有效範圍內不重複」效果,不依賴資料庫層級的宣告式唯一索引。

-- =========================================================================
-- 1.1 merchant_line_configs(商家 LINE 官方帳號串接設定,一商家最多一列)
-- 沒有任何直接開放的 RLS 政策(3.21)——一律透過 3.1~3.3 的 SECURITY DEFINER 函式讀寫。
-- =========================================================================
create table public.merchant_line_configs (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  channel_id text not null,
  channel_secret text not null,
  channel_access_token text not null,
  line_bot_user_id text,
  line_bot_basic_id text,
  display_name text,
  is_connected boolean not null default false,
  last_tested_at timestamptz,
  last_test_result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_line_configs is 'LINE 官方帳號串接設定(對應規格書 1.1)。channel_secret/channel_access_token 只在寫入當下由前端送出一次,SELECT 用途函式一律回傳遮蔽版本,沒有任何 RLS 政策直接開放給前端讀寫。';

-- 規則 8:Webhook 多租戶路由靠 line_bot_user_id 反查商家,同一個 LINE 官方帳號不會對應兩個商家。
create unique index merchant_line_configs_bot_user_id_unique
  on public.merchant_line_configs (line_bot_user_id)
  where line_bot_user_id is not null;

create trigger merchant_line_configs_set_updated_at
  before update on public.merchant_line_configs
  for each row execute function public.set_updated_at();

alter table public.merchant_line_configs enable row level security;
-- 刻意不建立任何政策(3.21):一律透過 3.1~3.3 的 SECURITY DEFINER 函式存取。

-- =========================================================================
-- 1.2 merchant_line_event_settings(通知事件設定,一商家一事件一列)
-- =========================================================================
create table public.merchant_line_event_settings (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'booking_created', 'booking_confirmed', 'booking_cancelled',
      'booking_completed', 'staff_leave_created'
    )
  ),
  enabled boolean not null default false,
  notify_admin boolean not null default false,
  notify_agent boolean not null default false,
  notify_staff boolean not null default false,
  notify_member boolean not null default false,
  message_template text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (merchant_id, event_type)
);

comment on table public.merchant_line_event_settings is '通知事件設定(對應規格書 1.2)。新商家建立時由 seed_default_line_event_settings(3.20)種入 5 筆,enabled 預設一律關閉(判斷 3.14 精神)。';

create trigger merchant_line_event_settings_set_updated_at
  before update on public.merchant_line_event_settings
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.3 line_notification_log(發送記錄)
-- =========================================================================
create table public.line_notification_log (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  event_type text not null check (
    event_type in (
      'booking_created', 'booking_confirmed', 'booking_cancelled', 'booking_completed',
      'staff_leave_created', 'marketing_manual'
    )
  ),
  booking_id uuid references public.bookings(id) on delete set null,
  staff_leave_record_id uuid references public.staff_leave_records(id) on delete set null,
  target_type text not null check (target_type in ('admin', 'agent', 'staff', 'member')),
  -- target_id 刻意不加外鍵——同一欄位對應四種不同表,比照 merchant_staff_service_items.service_item_id
  -- 刻意不加外鍵的既有先例(規格書 1.3)。
  target_id uuid,
  target_line_user_id text,
  status text not null check (status in ('sent', 'failed', 'skipped')),
  skip_reason text check (
    skip_reason is null
    or skip_reason in ('not_configured', 'event_disabled', 'target_not_bound', 'no_target')
  ),
  error_detail text,
  rendered_message text,
  attempted_at timestamptz not null default now(),
  created_by_user_id uuid references auth.users(id) on delete set null
);

comment on table public.line_notification_log is '發送記錄(對應規格書 1.3)。沒有 INSERT/UPDATE/DELETE 政策給一般角色,只由 Edge Function 用 service role 寫入。';

create index line_notification_log_merchant_attempted_idx
  on public.line_notification_log (merchant_id, attempted_at desc);
create index line_notification_log_booking_idx
  on public.line_notification_log (booking_id);

-- =========================================================================
-- 1.4 line_binding_codes(LINE 個人帳號綁定碼)
-- =========================================================================
create table public.line_binding_codes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  target_type text not null check (target_type in ('admin', 'agent', 'staff', 'member')),
  target_id uuid not null,
  code text not null check (code ~ '^[0-9]{6}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_line_user_id text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.line_binding_codes is 'LINE 個人帳號綁定碼(對應規格書 1.4)。沒有任何直接開放的 RLS 政策——一律透過 3.4~3.7 的產生函式寫入、透過 Webhook(service role)消費。「有效範圍內號碼不重複」改由 3.4~3.7 的產生邏輯用查詢+重試達成(見本檔開頭偏離說明,PostgreSQL 不允許 partial index 用 now() 當條件)。';

create index line_binding_codes_target_idx
  on public.line_binding_codes (merchant_id, target_type, target_id, used_at);
-- Webhook 消費時的查詢路徑(依 merchant_id + code 查目前有效的碼),加速比對。
create index line_binding_codes_lookup_idx
  on public.line_binding_codes (merchant_id, code, used_at, expires_at);

alter table public.line_binding_codes enable row level security;
-- 刻意不建立任何政策(3.21):一律透過 3.4~3.8 的 SECURITY DEFINER 函式存取。

-- =========================================================================
-- 1.5 line_webhook_events(Webhook 事件冪等紀錄)
-- =========================================================================
create table public.line_webhook_events (
  webhook_event_id text primary key,
  merchant_id uuid references public.merchants(id) on delete set null,
  line_event_type text,
  processed_at timestamptz not null default now(),
  note text
);

comment on table public.line_webhook_events is 'Webhook 事件冪等紀錄(對應規格書 1.5,套用 webhook-payment-integration SKILL 規則 4)。啟用 RLS 但刻意不建立任何政策,只有 service role 能存取。';

alter table public.line_webhook_events enable row level security;
-- 刻意不建立任何政策(3.21):只有 Edge Function 用 service role 存取。

-- =========================================================================
-- 1.6 既有表擴充:members/merchant_admins/merchant_agents 新增 line_user_id/line_bound。
-- merchant_staff 已經有這兩個欄位(模組 3 預留),這次不需要新增。
-- =========================================================================
alter table public.members
  add column line_user_id text,
  add column line_bound boolean not null default false;

alter table public.merchant_admins
  add column line_user_id text,
  add column line_bound boolean not null default false;

alter table public.merchant_agents
  add column line_user_id text,
  add column line_bound boolean not null default false;

comment on column public.members.line_bound is '是否已完成 LINE 個人帳號綁定(模組 11)。true 代表 line_user_id 有效可推播。';
comment on column public.merchant_admins.line_bound is '是否已完成 LINE 個人帳號綁定(模組 11)。';
comment on column public.merchant_agents.line_bound is '是否已完成 LINE 個人帳號綁定(模組 11)。';

-- =========================================================================
-- 規則 2.9 / 一之二節第 2 點:merchant_staff.line_user_id/line_bound 只能由 service role 寫入。
-- 這是規劃階段主動發現的既有缺口(merchant_staff_update 政策全欄位開放給商家管理員),
-- 用 BEFORE UPDATE 觸發器補一層欄位層級保護,不修改既有 UPDATE 政策本身。
-- =========================================================================
create or replace function private.protect_merchant_staff_line_binding_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (new.line_user_id is distinct from old.line_user_id
      or new.line_bound is distinct from old.line_bound)
     and auth.role() <> 'service_role'
     -- unbind_line_account(3.19)的服務人員分支是唯一一個「以一般 authenticated 角色執行、
     -- 但已經在函式內部完成 is_merchant_admin 檢查」的合法例外路徑——它會在真的要清空這兩個
     -- 欄位前,用 set_config 短暫打開這個工作階段層級的旗標(transaction-local,語句結束或
     -- transaction 結束就自動失效),不是永久放行。
     and coalesce(current_setting('line_notifications.bypass_staff_binding_guard', true), 'off') <> 'on'
  then
    raise exception '不能透過一般編輯直接變更 LINE 綁定狀態,請透過 LINE 綁定/解除綁定流程操作'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.protect_merchant_staff_line_binding_columns() is '規則 2.9:擋下「不是透過 service role」對 merchant_staff.line_user_id/line_bound 的異動,不影響這兩個欄位以外的一般編輯(姓名/電話/上架狀態等維持商家管理員可直接修改)。唯一例外是 3.19 unbind_line_account 已完成權限檢查後,用 transaction-local 的 line_notifications.bypass_staff_binding_guard 旗標放行。';

create trigger merchant_staff_protect_line_binding_columns
  before update on public.merchant_staff
  for each row execute function private.protect_merchant_staff_line_binding_columns();

-- =========================================================================
-- 3.17 private.can_manage_line_notification(p_merchant_id uuid)
-- section_key = 'line_notification'(沿用模組 3 §1.4 早就預留的字串)。完全比照
-- can_manage_members/can_manage_team_leave 的既有寫法。
-- =========================================================================
create or replace function private.can_manage_line_notification(p_merchant_id uuid)
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
        and map.section_key = 'line_notification'
        and map.granted = true
    );
$$;

comment on function private.can_manage_line_notification(uuid) is '規則 2.10:是否可以管理該商家的 LINE 通知設定/發送記錄/自己的綁定狀態。不涵蓋規則 2.1/2.6 永遠只給管理員的憑證管理/行銷發送。';

revoke execute on function private.can_manage_line_notification(uuid) from public, anon;
grant execute on function private.can_manage_line_notification(uuid) to authenticated;

-- =========================================================================
-- 3.21 RLS 政策(merchant_line_event_settings / line_notification_log)
-- =========================================================================
alter table public.merchant_line_event_settings enable row level security;

create policy merchant_line_event_settings_select on public.merchant_line_event_settings
  for select to authenticated
  using (private.can_manage_line_notification(merchant_id));

create policy merchant_line_event_settings_update on public.merchant_line_event_settings
  for update to authenticated
  using (private.can_manage_line_notification(merchant_id))
  with check (private.can_manage_line_notification(merchant_id));

-- 沒有 INSERT/DELETE 政策:5 種事件是系統固定種好的清單,商家不能新增/刪除,只能改內容(3.16)。

alter table public.line_notification_log enable row level security;

create policy line_notification_log_select on public.line_notification_log
  for select to authenticated
  using (private.can_manage_line_notification(merchant_id));

-- 沒有 INSERT/UPDATE/DELETE 政策:只由 Edge Function 用 service role 寫入。
