-- 客戶端第 2 批(模組 13)— migration 1:資料表與權限
-- 規格書 .project/specs/客戶端第2批-LINE登入與訪客預約.md(「零之二」優先於本文)
--
-- 這支只建資料結構,沒有任何既有資料的寫入或刪除:
--   C2-A01 merchant_line_login_configs   商家的 LINE Login channel 設定(secret 存 Vault,表裡只放 Vault id)
--   C2-C02 customer_line_identities      一個「LINE Channel + LINE userId」= 一個客戶登入帳號
--   C2-C04 customer_line_login_attempts  LINE 登入進行中的暫存(state 只存雜湊,10 分鐘有效,單次使用)
--   C2-C06 customer_policy_consents      客人勾選同意的紀錄
--   C2-G01 bookings.is_guest_booking     訪客預約標記(這批沒有寫入路徑,第 3 批送出函式才寫)
--   零之二 第 1 點 鈴鐺:user_notifications.event_type 多一個 'member_line_login_linked'
--
-- 零之二已刪除:C2-A06(驗證方式欄位)、C2-D01(申請表)、C2-D02(驗證碼表)、C2-D05(平台簡訊開關)⇒ 這裡都不建。
--
-- 權限原則(supabase-permission-hygiene、第 1 批鐵律 1):
--   新表一律 enable RLS + 零 policy + revoke all from anon, authenticated。讀寫只透過
--   SECURITY DEFINER 函式(migration 2)或 service_role(Edge Function)。
--
-- 動手前唯讀核對(正式庫 wjtbmmnakcriuaqoknsq,2026-10-08):四張新表與 is_guest_booking 欄位都不存在;
-- bookings.source='customer' 0 筆 ⇒ 新 check 不會擋到任何存量資料;user_notifications 的 event_type check
-- 現況 7 個值(與本機一致),這裡只「加」一個值。

-- =========================================================================
-- C2-A01 merchant_line_login_configs
-- =========================================================================
create table public.merchant_line_login_configs (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  channel_id text not null check (channel_id ~ '^[0-9]{10}$'),
  channel_secret_vault_id uuid not null,
  channel_secret_last4 text not null check (channel_secret_last4 ~ '^[0-9A-Za-z]{4}$'),
  enabled boolean not null default false,
  last_login_succeeded_at timestamptz null,
  linked_oa_status text null check (linked_oa_status in ('ok', 'not_linked', 'unknown')),
  updated_by_user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_line_login_configs is 'C2-A01:商家的 LINE Login channel 設定(一間店最多一列)。Channel Secret 存在 Vault,這張表只放 Vault id 與末 4 碼。不建任何 RLS policy、表層權限也收掉;讀寫只透過 set/get/delete_merchant_line_login_* 函式與 service role。同一個 Channel ID 可以給多間分店共用(不加唯一索引)。';
comment on column public.merchant_line_login_configs.channel_secret_vault_id is 'C2-A01:指向 vault.secrets.id。表裡永遠不存 secret 原文。';
comment on column public.merchant_line_login_configs.linked_oa_status is 'C2-B03 第 7 步:最近一次有客人登入時查「好友 / 官方帳號連結」的結果。ok / not_linked / unknown。';

create trigger merchant_line_login_configs_set_updated_at
  before update on public.merchant_line_login_configs
  for each row execute function public.set_updated_at();

alter table public.merchant_line_login_configs enable row level security;
revoke all on table public.merchant_line_login_configs from anon, authenticated;

-- =========================================================================
-- C2-C02 customer_line_identities
-- =========================================================================
create table public.customer_line_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  line_channel_id text not null,
  line_sub text not null,
  display_name text null,
  picture_url text null,
  first_login_at timestamptz not null default now(),
  last_login_at timestamptz not null default now(),
  constraint customer_line_identities_channel_sub_key unique (line_channel_id, line_sub)
);

comment on table public.customer_line_identities is 'C2-C02:一個「LINE Channel + LINE userId(sub)」= 一個客戶登入帳號(auth.users,app_metadata.account_type = customer)。共用 channel 的分店自然共用同一個帳號,會員仍然每店一筆。不建 RLS policy、表層權限收掉。';

alter table public.customer_line_identities enable row level security;
revoke all on table public.customer_line_identities from anon, authenticated;

-- =========================================================================
-- C2-C04 customer_line_login_attempts
-- =========================================================================
create table public.customer_line_login_attempts (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  channel_id text not null,
  nonce text not null,
  code_verifier text not null,
  draft jsonb null,
  ip_hash text null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null
);

comment on table public.customer_line_login_attempts is 'C2-C04:LINE 登入進行中的暫存。state 只存 SHA-256(十六進位),10 分鐘有效、單次使用;draft(第 1 批 ②~⑤ 選好的內容)在 complete 時原封不動還給前端並同時清成 null。每小時由 pg_cron 刪掉 1 天前的列。不建 RLS policy、表層權限收掉。';
comment on column public.customer_line_login_attempts.ip_hash is 'C2-B01:來源 IP 的 SHA-256(做 10 分鐘 30 次的頻率限制),不存 IP 原文。';

create index customer_line_login_attempts_ip_created_idx
  on public.customer_line_login_attempts (ip_hash, created_at);
create index customer_line_login_attempts_created_idx
  on public.customer_line_login_attempts (created_at);

alter table public.customer_line_login_attempts enable row level security;
revoke all on table public.customer_line_login_attempts from anon, authenticated;

-- =========================================================================
-- C2-C06 customer_policy_consents
-- =========================================================================
create table public.customer_policy_consents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  user_id uuid null references auth.users(id) on delete set null,
  member_id uuid null references public.members(id) on delete set null,
  phone_normalized text null,
  context text not null check (context in ('line_login', 'guest_booking')),
  member_policy_enabled boolean not null,
  member_policy_hash text null,
  privacy_policy_version text not null,
  consented_at timestamptz not null default now()
);

comment on table public.customer_policy_consents is 'C2-C06:客人勾選「會員政策 / 隱私權政策」的同意紀錄。不存 IP(個資最少原則)。也拿來算「同一位客人在同一間店 24 小時內試過幾支不同電話」(零之二 Q6:最多 5 支)。寫入只透過 customer_complete_profile 與第 3 批訪客送出函式。不建 RLS policy、表層權限收掉。';
comment on column public.customer_policy_consents.member_policy_hash is 'C2-C06:同意當下會員政策內容的 md5;商家沒開會員政策時為 null。';

create index customer_policy_consents_user_merchant_idx
  on public.customer_policy_consents (user_id, merchant_id, consented_at);

alter table public.customer_policy_consents enable row level security;
revoke all on table public.customer_policy_consents from anon, authenticated;

-- =========================================================================
-- C2-G01 bookings.is_guest_booking
-- =========================================================================
alter table public.bookings
  add column is_guest_booking boolean not null default false;
alter table public.bookings
  add constraint bookings_guest_booking_source_check
  check (not is_guest_booking or source = 'customer');

comment on column public.bookings.is_guest_booking is 'C2-G01:訪客(不登入)從客戶端下的預約。訪客預約 = source customer + created_by_role customer + created_by_user_id null + 這欄 true。第 2 批沒有寫入路徑,第 3 批送出函式才寫。';

-- =========================================================================
-- 零之二 第 1 點:接上既有會員時發站內鈴鐺
-- 只「加」一個值,原本 7 個值逐字保留。
-- =========================================================================
alter table public.user_notifications drop constraint user_notifications_event_type_check;
alter table public.user_notifications add constraint user_notifications_event_type_check check (
  event_type = any (array[
    'booking_created', 'booking_cancelled', 'booking_updated', 'booking_reminder_next_day',
    'booking_confirmed', 'booking_completed_cancelled', 'booking_completed_reverted',
    'member_line_login_linked'
  ])
);
