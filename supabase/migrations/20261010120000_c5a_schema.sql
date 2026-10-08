-- 客戶端第 5-A 批(LINE 通知客人)— 資料表(C5-A01~A05)
-- 規格:.project/specs/客戶端第5批-LINE通知與綁定.md(零之零定案優先)。
--
-- 這支只動資料結構:
--   A01 member_customer_contacts 加兩個通知開關
--   A02 merchant_customer_line_settings(一店一列,大多數店沒有列 ⇒ 讀取一律 coalesce 預設,不補插)
--   A03 customer_line_friendships(每個 LINE userId 對這間店的好友狀態;沒有列 = 不確定)
--   A04 customer_line_outbox(待發清單)
--   A05 line_notification_log / user_notifications 的 check 擴充(原有值逐字保留,2026-10-09 正式庫 SELECT 核對過)
-- 全部新表:RLS 開、0 policy、revoke all from anon, authenticated(鐵律 1)。只走 SECURITY DEFINER 函式與 service role。

-- =========================================================================
-- C5-A01 聯絡人的兩個通知開關(預設開)
-- =========================================================================
alter table public.member_customer_contacts
  add column if not exists notify_booking boolean not null default true,
  add column if not exists notify_promo boolean not null default true,
  add column if not exists notify_prefs_updated_at timestamptz null;

comment on column public.member_customer_contacts.notify_booking is 'C5-A01:這位聯絡人要不要收 LINE 預約通知(含聯絡人申請 / 移除通知)。只能透過 customer_set_notify_prefs 改。';
comment on column public.member_customer_contacts.notify_promo is 'C5-A01:這位聯絡人要不要收 LINE 優惠通知(行銷 / 生日禮,5-B 才接上)。只能透過 customer_set_notify_prefs 改。';

-- =========================================================================
-- C5-A02 店家的「通知客人」設定
-- =========================================================================
create table if not exists public.merchant_customer_line_settings (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  on_submitted boolean not null default true,
  on_scheduled_by_store boolean not null default false,
  on_confirmed boolean not null default true,
  on_rescheduled boolean not null default true,
  on_cancelled_by_store boolean not null default true,
  on_cancelled_by_customer boolean not null default true,
  on_reminder boolean not null default false,
  on_completed boolean not null default false,
  on_contact_events boolean not null default true,
  reminder_hours_before integer not null default 24
    constraint merchant_customer_line_settings_reminder_hours_check check (reminder_hours_before in (2, 3, 6, 12, 24, 48)),
  monthly_cap integer null
    constraint merchant_customer_line_settings_monthly_cap_check check (monthly_cap is null or monthly_cap between 1 and 100000),
  templates jsonb not null default '{}'::jsonb
    constraint merchant_customer_line_settings_templates_object_check check (jsonb_typeof(templates) = 'object'),
  quota_blocked_until timestamptz null,
  quota_warned_month text null
    constraint merchant_customer_line_settings_quota_warned_month_check check (quota_warned_month is null or quota_warned_month ~ '^[0-9]{4}-[0-9]{2}$'),
  updated_by_user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.merchant_customer_line_settings is 'C5-A02:店家「通知客人」設定。一店一列,沒有列 = 全部預設(Q1=A)。只走 get/update_customer_line_settings 與 service role。';

alter table public.merchant_customer_line_settings enable row level security;
revoke all on table public.merchant_customer_line_settings from anon, authenticated;

-- =========================================================================
-- C5-A03 好友狀態
-- =========================================================================
create table if not exists public.customer_line_friendships (
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  line_user_id text not null,
  is_friend boolean not null,
  source text not null constraint customer_line_friendships_source_check check (source in ('webhook', 'login')),
  changed_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (merchant_id, line_user_id)
);
comment on table public.customer_line_friendships is 'C5-A03:某個 LINE userId 是不是這間店官方帳號的好友(webhook follow/unfollow、LINE 登入 friendFlag)。沒有列 = 不確定(照常發)。只走 internal_set_line_friendship。';

alter table public.customer_line_friendships enable row level security;
revoke all on table public.customer_line_friendships from anon, authenticated;

-- =========================================================================
-- C5-A04 待發清單
-- =========================================================================
create table if not exists public.customer_line_outbox (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  kind text not null constraint customer_line_outbox_kind_check check (kind in (
    'customer_submitted', 'customer_scheduled_by_store', 'customer_confirmed', 'customer_rescheduled',
    'customer_cancelled_by_store', 'customer_cancelled_by_customer', 'customer_reminder', 'customer_completed',
    'customer_contact_request', 'customer_contact_removed', 'customer_contact_request_resolved',
    'store_booking_created', 'store_booking_cancelled'
  )),
  booking_id uuid null references public.bookings(id) on delete cascade,
  member_id uuid null,
  subject_user_id uuid null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text null,
  send_after timestamptz not null default now(),
  status text not null default 'pending'
    constraint customer_line_outbox_status_check check (status in ('pending', 'processing', 'sent', 'skipped', 'failed')),
  attempts integer not null default 0,
  last_error text null constraint customer_line_outbox_last_error_len check (last_error is null or char_length(last_error) <= 500),
  claimed_at timestamptz null,
  created_at timestamptz not null default now(),
  processed_at timestamptz null
);
comment on table public.customer_line_outbox is 'C5-A04:LINE 通知客人 / 客人訂單通知店家的待發清單。只由 private.enqueue_customer_line 寫入,customer-line-notify-dispatch(service role)領取發送。不存任何 token 或 LINE userId。';

create unique index if not exists customer_line_outbox_dedupe_active_uidx
  on public.customer_line_outbox (dedupe_key)
  where status in ('pending', 'processing');
create index if not exists customer_line_outbox_status_send_after_idx
  on public.customer_line_outbox (status, send_after);
create index if not exists customer_line_outbox_booking_idx
  on public.customer_line_outbox (booking_id) where booking_id is not null;
create index if not exists customer_line_outbox_merchant_status_idx
  on public.customer_line_outbox (merchant_id, status);

alter table public.customer_line_outbox enable row level security;
revoke all on table public.customer_line_outbox from anon, authenticated;

-- =========================================================================
-- C5-A05 擴充既有 check 與欄位(原有值逐字保留)
-- =========================================================================
alter table public.line_notification_log drop constraint if exists line_notification_log_event_type_check;
alter table public.line_notification_log add constraint line_notification_log_event_type_check check (event_type = any (array[
  'booking_created'::text, 'booking_confirmed'::text, 'booking_cancelled'::text, 'booking_completed'::text,
  'staff_leave_created'::text, 'marketing_manual'::text, 'birthday_bonus'::text,
  'customer_submitted'::text, 'customer_scheduled_by_store'::text, 'customer_confirmed'::text,
  'customer_rescheduled'::text, 'customer_cancelled_by_store'::text, 'customer_cancelled_by_customer'::text,
  'customer_reminder'::text, 'customer_completed'::text, 'customer_contact_request'::text,
  'customer_contact_removed'::text, 'customer_contact_request_resolved'::text
]));

alter table public.line_notification_log drop constraint if exists line_notification_log_skip_reason_check;
alter table public.line_notification_log add constraint line_notification_log_skip_reason_check check ((skip_reason is null) or (skip_reason = any (array[
  'not_configured'::text, 'event_disabled'::text, 'target_not_bound'::text, 'no_target'::text,
  'staff_inactive'::text, 'staff_calendar_view_off'::text,
  'customer_opted_out'::text, 'not_friend'::text, 'monthly_cap'::text, 'quota_exhausted'::text,
  'stale'::text, 'superseded'::text
])));

alter table public.line_notification_log
  add column if not exists target_user_id uuid null references auth.users(id) on delete set null,
  add column if not exists outbox_id uuid null;
create index if not exists line_notification_log_outbox_idx on public.line_notification_log (outbox_id) where outbox_id is not null;

alter table public.user_notifications drop constraint if exists user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check check (event_type = any (array[
  'booking_created'::text, 'booking_cancelled'::text, 'booking_updated'::text, 'booking_reminder_next_day'::text,
  'booking_confirmed'::text, 'booking_completed_cancelled'::text, 'booking_completed_reverted'::text,
  'member_line_login_linked'::text, 'customer_booking_created'::text, 'customer_booking_cancelled'::text,
  'member_contact_request'::text,
  'line_quota_warning'::text, 'line_quota_exhausted'::text
]));
