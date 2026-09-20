-- 模組 10:會員與紅利 — 資料層(第一支:schema)。
-- 對應規格書 .project/specs/會員與紅利.md §1.1~§1.4。
--
-- 財務謹慎設計(規格書第〇節判斷 3,比照模組 8 default_commission_rate_percentage 的既有精神):
-- points_earn_rate/referral_bonus_points/birthday_bonus_points 全部預設 0——0 代表「尚未設定」,
-- 不會在商家還沒填任何數字之前,就默默對會員發出一個算是憑空生成的點數。

-- =========================================================================
-- 1.1:merchant_member_settings(商家層級會員設定,一商家一列)。
-- 完全比照 merchant_payroll_settings(模組 8)的既有設計語言:一商家一列,查無資料時前端/後端
-- 一律套用預設值,直接開放 RLS 讀寫(無跨列驗證需求),沒有 DELETE 政策。
-- =========================================================================
create table public.merchant_member_settings (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  phone_required_to_create boolean not null default true,
  require_verified_phone_for_rewards boolean not null default false,
  points_earn_rate numeric(10, 2) not null default 0 check (points_earn_rate >= 0),
  referral_bonus_points integer not null default 0 check (referral_bonus_points >= 0),
  birthday_bonus_points integer not null default 0 check (birthday_bonus_points >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_member_settings is '商家層級會員/紅利設定(模組 10 會員與紅利 §1.1):一商家一列,查無資料時前端/後端一律套用預設值。points_earn_rate/referral_bonus_points/birthday_bonus_points 預設 0 是刻意的(第〇節判斷 3)——0 代表「還沒設定」,不會無故對會員發出憑空生成的點數。RLS 要求 private.can_manage_member_settings(merchant_id),沒有 DELETE 政策。';
comment on column public.merchant_member_settings.phone_required_to_create is '建立會員時電話是否必填,預設 true(跟既有 bookings.customer_phone 一律必填的既有慣例一致)。';
comment on column public.merchant_member_settings.require_verified_phone_for_rewards is '啟用後,只有 phone_verified=true 的會員才能核發紅利/推薦獎勵/生日贈點(規則 2.8)。第〇節判斷 1:phone_verified 這次只是人工標記,不是真的簡訊驗證,這個開關的實際效果侷限於此。';
comment on column public.merchant_member_settings.points_earn_rate is '每消費多少元累積 1 點,計算基準是 bookings.final_amount_snapshot(含稅,規則 2.1)。預設 0(尚未設定,不核發)。';
comment on column public.merchant_member_settings.referral_bonus_points is '成功推薦一位會員(被推薦人完成第一筆訂單,規則 2.4)可得幾點,預設 0。';
comment on column public.merchant_member_settings.birthday_bonus_points is '生日當月核發的點數(規則 2.5,以月為單位容錯,不是精確當天),預設 0。';

create trigger merchant_member_settings_set_updated_at
  before update on public.merchant_member_settings
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.2:members(會員)。商家層級的顧客身份紀錄(判斷 7:不做跨商家比對/合併),
-- 「RPC only」寫入模式(判斷 14)——這張表本身只開放 RLS SELECT,見下一支 migration §3.16。
-- =========================================================================
create table public.members (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  birthday date,
  phone_verified boolean not null default false,
  phone_verified_at timestamptz,
  referral_code text not null unique,
  referred_by_member_id uuid references public.members(id) on delete set null,
  referral_rewarded_at timestamptz,
  points_balance integer not null default 0 check (points_balance >= 0),
  last_birthday_bonus_year integer,
  status text not null default 'active' check (status in ('active', 'removed')),
  notes text,
  user_id uuid references auth.users(id) on delete set null,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint members_no_self_referral check (referred_by_member_id is distinct from id)
);

comment on table public.members is '商家層級的會員(模組 10 會員與紅利 §1.2),由商家管理員/客服建立,不是消費者自己註冊(判斷 7,那是模組 13 的範圍)。「RPC only」寫入(判斷 14):這張表沒有任何 INSERT/UPDATE/DELETE RLS 政策,一律透過 create_member/update_member/deactivate_member/reactivate_member/set_member_phone_verified 這幾支 SECURITY DEFINER 函式寫入,理由是新增/編輯牽涉跨列驗證(電話是否必填看商家設定、推薦人必須同商家且非自己)。不做真刪除,下架用 status=removed(判斷 2.9:這不是危險操作,不需要 JSON 備份)。';
comment on column public.members.phone is '是否必填由 merchant_member_settings.phone_required_to_create 在函式層檢查,不是資料庫 NOT NULL(判斷 14)。';
comment on column public.members.referral_code is '建立當下自動產生的 8 碼英數代碼(判斷 11),這次只用於客服查找,保留給模組 13 之後做客戶自助分享連結。';
comment on column public.members.referred_by_member_id is '推薦這位會員的人,只能在建立當下設定(3.4 明確不允許事後修改,避免事後補推薦人騙獎勵)。';
comment on column public.members.referral_rewarded_at is '這位會員的推薦人是否已經因為這位會員而拿過推薦獎勵(規則 2.4),防止重複核發,不論當時獎勵點數是否 > 0 都會標記。';
comment on column public.members.points_balance is '快取的目前點數餘額,唯一寫入路徑是 compute_member_loyalty_points/redeem_member_points/adjust_member_points/grant_pending_birthday_bonuses 這些 SECURITY DEFINER 函式(判斷 13),必須跟 member_point_transactions 的加總永遠一致。';
comment on column public.members.last_birthday_bonus_year is '今年是否已經核發過生日獎勵(規則 2.5),grant_pending_birthday_bonuses 用這個欄位防止同一年重複核發。';
comment on column public.members.user_id is '對應判斷 12,預留給模組 13(客戶自助登入查看紅利點數)使用,這次完全不會被賦值。';
comment on column public.members.phone_verified is '第〇節判斷 1:純粹的人工標記欄位,不代表真的發送過簡訊驗證碼,只有管理員/客服在會員詳情頁手動標記。';

create index members_merchant_id_status_idx on public.members (merchant_id, status);
create index members_merchant_id_phone_idx on public.members (merchant_id, phone);
create unique index members_merchant_id_user_id_idx
  on public.members (merchant_id, user_id) where user_id is not null;

create trigger members_set_updated_at
  before update on public.members
  for each row execute function public.set_updated_at();

-- =========================================================================
-- 1.3:member_point_transactions(紅利點數分類帳,append-only)。
-- 比照 booking_commission_records(模組 8)的精神:只存一個餘額欄位不夠回答「哪筆訂單賺了多少
-- 點數」這種歷史追溯需求,所有寫入集中在 SECURITY DEFINER 函式裡,沒有 UPDATE/DELETE 政策。
-- =========================================================================
create table public.member_point_transactions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  transaction_type text not null
    check (transaction_type in ('earn_booking', 'referral_bonus', 'birthday_bonus', 'manual_adjustment', 'redeem')),
  points_delta integer not null check (points_delta <> 0),
  balance_after integer not null check (balance_after >= 0),
  booking_id uuid references public.bookings(id) on delete set null,
  related_member_id uuid references public.members(id) on delete set null,
  note text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.member_point_transactions is '某位會員每一次點數異動的永久明細紀錄(模組 10 §1.3,判斷 13),append-only,沒有 UPDATE/DELETE 政策——算錯了只能再新增一筆 manual_adjustment 沖正,不能修改/刪除原本那筆。merchant_id 冗餘存一份,方便 RLS/索引直接用(比照 booking_commission_records.merchant_id 的既有設計精神)。';
comment on column public.member_point_transactions.transaction_type is '五選一:earn_booking(消費核發)/referral_bonus(推薦獎勵)/birthday_bonus(生日贈點)/manual_adjustment(管理員手動調整)/redeem(兌換使用)。';
comment on column public.member_point_transactions.points_delta is '正值為核發,負值為扣除/兌換。';
comment on column public.member_point_transactions.balance_after is '這筆異動完成後的餘額快照,方便報表/明細直接顯示不用重新加總。';
comment on column public.member_point_transactions.booking_id is 'earn_booking 類型必填,記錄是哪一筆訂單賺到的點數;referral_bonus 類型選填(記錄觸發推薦獎勵的那筆訂單)。';
comment on column public.member_point_transactions.related_member_id is 'referral_bonus 類型必填,記錄被推薦的會員是誰。';
comment on column public.member_point_transactions.note is 'manual_adjustment/redeem 類型在函式層要求必填,不是資料庫 NOT NULL。';
comment on column public.member_point_transactions.created_by_user_id is '系統自動核發(earn_booking/referral_bonus/birthday_bonus)時為 null,人工操作(manual_adjustment/redeem)時記錄操作者。';

create index member_point_transactions_member_id_created_at_idx
  on public.member_point_transactions (member_id, created_at);
create index member_point_transactions_merchant_id_created_at_idx
  on public.member_point_transactions (merchant_id, created_at);
-- 規則 2.2 核心防呆:同一筆訂單最多只能有一筆 earn_booking 紀錄(呼應
-- booking_commission_records.unique(booking_id) 的既有精神)。
create unique index member_point_transactions_earn_booking_unique_idx
  on public.member_point_transactions (booking_id)
  where transaction_type = 'earn_booking';

-- =========================================================================
-- 1.4:bookings 擴充 member_id / member_name_snapshot(擴充模組 6 既有表,不新建表)。
-- ADD COLUMN ... 對既有訂單完全沒有影響,這兩個欄位在上線那一刻全部是 null(判斷 8,不做歷史回填)。
-- =========================================================================
alter table public.bookings
  add column member_id uuid references public.members(id) on delete set null,
  add column member_name_snapshot text;

comment on column public.bookings.member_id is '模組 10 §1.4:這筆訂單連結的會員,建立/編輯訂單(未完成前)時可以設定,一旦訂單狀態轉為 completed 就永久鎖定(判斷 9,由 update_booking 既有的狀態限制自然達成,不需要額外檢查)。';
comment on column public.bookings.member_name_snapshot is '模組 10 §1.4:建立/編輯訂單當下,member_id 對應會員的姓名快照,訂單詳情頁顯示這個欄位,不重新查詢 members 表(呼應這個 codebase 一路以來的金額/名稱快照原則)。';
