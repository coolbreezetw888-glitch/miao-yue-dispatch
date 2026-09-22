-- SPECS-INDEX #615(規格書 .project/specs/會員與紅利.md §10.3)。
-- 會員分級:新增商家自訂會員等級清單資料表,純分類標籤用途,這次不跟紅利點數倍率或其他權益掛勾。
-- 比照 payment_methods/material_cost_items 的既有「商家自訂清單」設計語言:商家自己命名,直接開放
-- RLS INSERT/UPDATE(不走 RPC),軟刪除(status=removed),不算危險操作,不需要 JSON 備份。

-- =========================================================================
-- merchant_member_tiers(商家自訂會員等級清單)。
-- =========================================================================
create table public.merchant_member_tiers (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_member_tiers is '模組 10 會員與紅利 §10.3(SPECS-INDEX #615):商家自訂會員等級清單(例如一般/VIP/超級VIP),純分類標籤用途,這次不跟紅利點數倍率或其他權益掛勾。比照 payment_methods 的既有設計語言,直接開放 RLS INSERT/UPDATE,不需要 RPC。軟刪除(status=removed),下架某等級後既有會員的 tier_id 不受影響(不會被自動清空)。';
comment on column public.merchant_member_tiers.sort_order is '商家自訂顯示順序高低,數字小的排前面。';

create unique index merchant_member_tiers_merchant_id_name_active_idx
  on public.merchant_member_tiers (merchant_id, name)
  where status = 'active';

create index merchant_member_tiers_merchant_id_idx on public.merchant_member_tiers (merchant_id);

create trigger merchant_member_tiers_set_updated_at
  before update on public.merchant_member_tiers
  for each row execute function public.set_updated_at();

-- =========================================================================
-- members 表擴充:tier_id(nullable,代表「未分級」)。
-- =========================================================================
alter table public.members
  add column tier_id uuid references public.merchant_member_tiers(id) on delete set null;

comment on column public.members.tier_id is '模組 10 §10.3(SPECS-INDEX #615):這位會員目前的等級,留空代表「未分級」。下架某個等級不會連帶清空既有會員的 tier_id(避免下架動作意外影響既有會員資料,商家如果要清空需要自己手動改)。';

create index members_tier_id_idx on public.members (tier_id);

-- =========================================================================
-- RLS:SELECT 同時放行 can_manage_members(逐一會員指派等級時要能看清單、列表頁篩選/顯示要用
-- 到)跟 can_manage_member_settings(等級管理區塊本身);INSERT/UPDATE 只允許
-- can_manage_member_settings(等級清單本身的新增/編輯/下架,歸在會員系統設定頁的權限範圍,規則
-- 2.10 既有精神)。沒有 DELETE 政策(軟刪除)。
-- =========================================================================
alter table public.merchant_member_tiers enable row level security;

create policy merchant_member_tiers_select on public.merchant_member_tiers
  for select to authenticated
  using (
    private.can_manage_members(merchant_id)
    or private.can_manage_member_settings(merchant_id)
  );

create policy merchant_member_tiers_insert on public.merchant_member_tiers
  for insert to authenticated
  with check (private.can_manage_member_settings(merchant_id));

create policy merchant_member_tiers_update on public.merchant_member_tiers
  for update to authenticated
  using (private.can_manage_member_settings(merchant_id))
  with check (private.can_manage_member_settings(merchant_id));
