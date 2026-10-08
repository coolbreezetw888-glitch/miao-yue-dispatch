-- 客戶端第 4-B 批(模組 13)— migration 1:多位聯絡人(#1041)資料表
-- 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(「零之零」優先;C4-H01、H03、H04、H06)
-- 介面文件:.project/notes/c4-contract.md 「4-B」章節
--
-- 新增資料表(全部:開 RLS、不建任何 policy、表層權限從 anon / authenticated 收掉 ⇒ 只能透過函式讀寫):
--   public.member_customer_contacts        聯絡人(一個 LINE 帳號在一間店只能掛一位會員;每位會員最多一位主要)
--   public.member_contact_invites          邀請連結(只存邀請碼 SHA-256;72 小時;只能用一次)
--   public.member_contact_invite_claims    LINE 登入回來後「保留給這個帳號」的邀請(30 分鐘;邀請碼原文不落地)
--   public.member_contact_requests         「同一支電話」加入申請(7 天沒處理自動 expired)
-- 修改:
--   public.customer_line_login_attempts    多 invite_token_hash(purpose:'invite' 用;consume 時清掉)
-- 回填:
--   既有 members.user_id 不為 null 的會員各補一列主要聯絡人(joined_via = 'backfill')。
--   正式庫 2026-10-09 唯讀核對:members.user_id 不為 null 0 筆 ⇒ 正式庫回填 0 列。
-- members.user_id / line_user_id / line_bound 保留,語意 = 主要聯絡人(由聯絡人函式同步,Q6)。

-- =========================================================================
-- 聯絡人
-- =========================================================================
create table public.member_customer_contacts (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  is_primary boolean not null default false,
  contact_phone text null check (contact_phone is null or contact_phone ~ '^[0-9]{9,10}$'),
  joined_via text not null check (joined_via in ('first_login', 'invite', 'request', 'store', 'backfill')),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  removed_at timestamptz null,
  removed_by_user_id uuid null references auth.users(id) on delete set null,
  removed_via text null check (removed_via is null or removed_via in ('primary', 'self', 'store', 'unbind', 'stale')),
  constraint member_customer_contacts_primary_active_chk check (status = 'active' or not is_primary),
  constraint member_customer_contacts_removed_chk check ((status = 'removed') = (removed_at is not null))
);
comment on table public.member_customer_contacts is 'C4-H01(#1041):會員的聯絡人(一個 LINE 客戶帳號 = 一位聯絡人)。同一間店一個帳號只能是一位會員的 active 聯絡人;每位會員最多一位 active 主要聯絡人(= members.user_id)。contact_phone = 第二聯絡人自己的電話(正規化數字),店家搜尋 / 建單 / 訪客預約都會比對到這位會員(Q2 = A)。不建 RLS policy,全部走函式。';
comment on column public.member_customer_contacts.removed_via is 'primary = 主要聯絡人移除(會封鎖);self = 自己退出;store = 店家移除(會封鎖);unbind = 店家解除 LINE 綁定(會封鎖);stale = 會員已刪除 / 搬到別店後,同帳號加入別的會員時自動清掉。';

create unique index member_customer_contacts_merchant_user_active_uniq
  on public.member_customer_contacts (merchant_id, user_id) where status = 'active';
create unique index member_customer_contacts_member_primary_uniq
  on public.member_customer_contacts (member_id) where is_primary and status = 'active';
create index member_customer_contacts_member_idx
  on public.member_customer_contacts (member_id, created_at);
create index member_customer_contacts_merchant_phone_idx
  on public.member_customer_contacts (merchant_id, contact_phone) where status = 'active' and contact_phone is not null;
create index member_customer_contacts_user_idx
  on public.member_customer_contacts (user_id);

alter table public.member_customer_contacts enable row level security;
revoke all on table public.member_customer_contacts from anon, authenticated;

-- =========================================================================
-- 邀請
-- =========================================================================
create table public.member_contact_invites (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by_user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz null,
  used_by_user_id uuid null references auth.users(id) on delete set null,
  revoked_at timestamptz null,
  revoked_by_user_id uuid null references auth.users(id) on delete set null
);
comment on table public.member_contact_invites is 'C4-H03:聯絡人邀請連結。只存邀請碼 SHA-256(十六進位);72 小時;只能用一次;主要聯絡人可撤銷。同一位會員同時有效最多 5 個(函式檢查)。不建 RLS policy。';
create index member_contact_invites_member_idx on public.member_contact_invites (member_id, created_at);
alter table public.member_contact_invites enable row level security;
revoke all on table public.member_contact_invites from anon, authenticated;

create table public.member_contact_invite_claims (
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  invite_id uuid not null references public.member_contact_invites(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, merchant_id)
);
comment on table public.member_contact_invite_claims is 'C4-H06:用邀請連結 LINE 登入回來時,伺服器把邀請保留給這個客戶帳號 30 分鐘(邀請碼原文不存在任何地方);customer_accept_contact_invite 的 p_token 傳 null 時用這一列。不建 RLS policy。';
alter table public.member_contact_invite_claims enable row level security;
revoke all on table public.member_contact_invite_claims from anon, authenticated;

-- =========================================================================
-- 加入申請
-- =========================================================================
create table public.member_contact_requests (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_normalized text not null check (phone_normalized ~ '^[0-9]{9,10}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolved_by_user_id uuid null references auth.users(id) on delete set null,
  resolved_by_role text null check (resolved_by_role is null or resolved_by_role in ('customer', 'store', 'system')),
  constraint member_contact_requests_resolved_chk check ((status = 'pending') = (resolved_at is null))
);
comment on table public.member_contact_requests is 'C4-H04:別的 LINE 帳號填了已經有聯絡人的會員電話 ⇒ 加入申請。同一個帳號在同一間店同時最多 1 筆 pending;每位會員同時 pending 最多 5 筆;7 天沒處理由 cron 改 expired(讀取時也把超過 7 天的當成失效)。不建 RLS policy。';
create unique index member_contact_requests_user_pending_uniq
  on public.member_contact_requests (merchant_id, user_id) where status = 'pending';
create index member_contact_requests_member_pending_idx
  on public.member_contact_requests (member_id) where status = 'pending';
create index member_contact_requests_user_idx
  on public.member_contact_requests (user_id, merchant_id, created_at);
alter table public.member_contact_requests enable row level security;
revoke all on table public.member_contact_requests from anon, authenticated;

-- =========================================================================
-- LINE 登入暫存:邀請碼雜湊(C4-H06)
-- =========================================================================
alter table public.customer_line_login_attempts
  add column invite_token_hash text null check (invite_token_hash is null or invite_token_hash ~ '^[0-9a-f]{64}$');
comment on column public.customer_line_login_attempts.invite_token_hash is 'C4-H06:purpose = invite 時邀請碼的 SHA-256(不存原文)。consume 時不清(這一列已標成已使用、不能再用),交給 Edge 做「保留給這個帳號」;整列由每小時排程 customer-line-login-attempts-prune-hourly 刪掉 1 天前的資料。';

-- =========================================================================
-- 回填:既有 members.user_id ⇒ 主要聯絡人
--   members_merchant_id_user_id_idx 保證同店同 user_id 最多一列 ⇒ 不會撞 merchant_user_active_uniq。
-- =========================================================================
insert into public.member_customer_contacts (merchant_id, member_id, user_id, is_primary, joined_via, status, created_at)
select m.merchant_id, m.id, m.user_id, true, 'backfill', 'active', coalesce(m.identity_first_verified_at, m.updated_at, now())
from public.members m
join auth.users u on u.id = m.user_id
where m.user_id is not null
  and not exists (select 1 from public.member_customer_contacts c where c.member_id = m.id and c.status = 'active');
