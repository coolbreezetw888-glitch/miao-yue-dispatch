-- 紅利系統重構 批次 1:資料庫地基(只新增,不改任何既有行為)。
-- 對應規格書 .project/specs/紅利系統重構.md(v2.3)§八 批次 1:
--   §1.1(只新增欄位 + 兩個回填,**不** drop points_earn_rate —— 延到批次 6,§〇.4 判斷 19)
--   §1.2 新表 merchant_point_formulas
--   §1.3 新表 member_birthday_bonus_grants
--   §1.4 bookings 新增 7 個欄位
--   §1.5 member_point_transactions.transaction_type CHECK 擴成 10 種(既有 earn_booking 唯一索引不動、不新增同型索引)
--   §1.6 line_notification_log.event_type CHECK 加 'birthday_bonus'
--   §3.10 protect_merchant_member_settings_rule_columns:把新欄位加進保護清單(舊欄位 points_earn_rate 仍在清單內)
-- (§3.15 報表函式兩個新鍵在下一支 migration 20261001020100。)
--
-- 【動工前指紋核對】2026-10-01 對正式庫(唯讀)查 md5(prosrc)(先把 CRLF 正規化成 LF):
--   private.protect_merchant_member_settings_rule_columns = 218667b3e0da949cd961dfde1321a0c1 / 2446
--   跟規格書 §〇.1b 一致,且跟 repo 20260924040400 的函式本體逐字相同(同一個 md5)⇒ 以它為底疊加。
--
-- 【這支 migration 對既有行為的影響】
--   ・所有新欄位都有 DEFAULT,seed_default_member_settings(只帶 merchant_id)照舊成功。
--   ・回填只動「referral_bonus_points > 0」/「birthday_bonus_points > 0」的列(正式庫 2026-10-01:
--     前者 14 列全部是 E2E 測試商家、後者 0 列);被回填的列 updated_at 會被 set_updated_at 更新,
--     其他列完全不動。回填刻意放在「改寫保護 trigger 之前」:舊版 trigger 不認識新欄位,回填不可能被
--     擋,也不依賴 migration 當下 auth.role() 是什麼。
--   ・bookings 既有訂單全部拿到 0 / false / 空陣列,不回填。
--   ・CHECK 擴充只放寬(多允許幾個值),既有資料必然通過。

-- =========================================================================
-- §1.1 merchant_member_settings 新增欄位
-- =========================================================================

-- A. 紅利計算(#837/#838)
alter table public.merchant_member_settings
  add column earn_mode text not null default 'basic'
    constraint merchant_member_settings_earn_mode_check check (earn_mode in ('basic', 'advanced'));
alter table public.merchant_member_settings
  add column basic_points_per_order integer not null default 0
    constraint merchant_member_settings_basic_points_per_order_check check (basic_points_per_order >= 0);
alter table public.merchant_member_settings
  add column basic_min_amount numeric(10, 2) not null default 0
    constraint merchant_member_settings_basic_min_amount_check check (basic_min_amount >= 0);
alter table public.merchant_member_settings
  add column basic_tiered_enabled boolean not null default false;
alter table public.merchant_member_settings
  add constraint merchant_member_settings_basic_tiered_requires_min_amount
    check (basic_tiered_enabled = false or basic_min_amount > 0);

-- B. 點數使用(#839)
alter table public.merchant_member_settings
  add column redeem_points_unit integer not null default 0
    constraint merchant_member_settings_redeem_points_unit_check check (redeem_points_unit >= 0);
alter table public.merchant_member_settings
  add column redeem_amount_unit numeric(10, 2) not null default 0
    constraint merchant_member_settings_redeem_amount_unit_check check (redeem_amount_unit >= 0);
alter table public.merchant_member_settings
  add constraint merchant_member_settings_redeem_units_pair
    check (
      (redeem_points_unit = 0 and redeem_amount_unit = 0)
      or (redeem_points_unit > 0 and redeem_amount_unit > 0)
    );
alter table public.merchant_member_settings
  add column redeem_max_ratio_percent integer not null default 0
    constraint merchant_member_settings_redeem_max_ratio_percent_check
      check (redeem_max_ratio_percent between 0 and 100);

-- C. 推薦系統(#840)。referral_bonus_points 既有,語意不變。
alter table public.merchant_member_settings
  add column referral_inviter_reward_enabled boolean not null default false;
alter table public.merchant_member_settings
  add column referral_subsequent_bonus_points integer not null default 0
    constraint merchant_member_settings_referral_subsequent_bonus_points_check
      check (referral_subsequent_bonus_points >= 0);
alter table public.merchant_member_settings
  add column referral_inviter_earning_enabled boolean not null default true;
alter table public.merchant_member_settings
  add column referral_invitee_earning_enabled boolean not null default true;

-- D. 生日獎勵(#841)。birthday_bonus_points 既有,語意不變。
alter table public.merchant_member_settings
  add column birthday_bonus_enabled boolean not null default false;
alter table public.merchant_member_settings
  add column birthday_line_message text not null
    default '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。'
    constraint merchant_member_settings_birthday_line_message_length_check
      check (char_length(birthday_line_message) <= 1000);

-- 回填(規格書 §1.1:add column 之後、同一支 migration 內;讓既有行為零改變,§〇.3 判斷 9)。
-- 只更新真正需要變成 true 的列,其餘列不碰。
update public.merchant_member_settings
set referral_inviter_reward_enabled = true
where referral_bonus_points > 0;

update public.merchant_member_settings
set birthday_bonus_enabled = true
where birthday_bonus_points > 0;

comment on column public.merchant_member_settings.earn_mode is '紅利系統重構 §1.1 A(#837/#838):紅利計算模式,basic=基本設定(整張訂單一個規則)、advanced=進階設定(逐服務項目公式,見 merchant_point_formulas)。兩者互相取代,只能擇一。屬於「紅利點數規則」,只有 member_points 鑰匙能改(protect_merchant_member_settings_rule_columns)。';
comment on column public.merchant_member_settings.basic_points_per_order is '紅利系統重構 §1.1 A(#837):基本模式「每筆訂單獲得 X 點」;basic_tiered_enabled 開啟時是「每滿額獲得 X 點」。0 = 尚未設定。';
comment on column public.merchant_member_settings.basic_min_amount is '紅利系統重構 §1.1 A(#837):基本模式「最低消費金額」;basic_tiered_enabled 開啟時是「每滿額消費金額」。比對的是折扣後、含稅、紅利折抵前的應付總額(§2.2)。';
comment on column public.merchant_member_settings.basic_tiered_enabled is '紅利系統重構 §1.1 A(#837):每滿額累計贈點開關;開啟時 basic_min_amount 必須 > 0(否則除以零),由表級 CHECK 擋下。';
comment on column public.merchant_member_settings.redeem_points_unit is '紅利系統重構 §1.1 B(#839):兌換比例「前面的點數」(例:100 點 = redeem_amount_unit 元)。跟 redeem_amount_unit 必須同時為 0(尚未設定 = 不開放折抵)或同時 > 0。';
comment on column public.merchant_member_settings.redeem_amount_unit is '紅利系統重構 §1.1 B(#839):兌換比例「後面的金額」(例:10 → 100 點折 10 元)。';
comment on column public.merchant_member_settings.redeem_max_ratio_percent is '紅利系統重構 §1.1 B(#839):單次訂單最多可用點數折抵的比例(%),0 = 不開放折抵。';
comment on column public.merchant_member_settings.referral_inviter_reward_enabled is '紅利系統重構 §1.1 C(#840)開關 1:推薦者邀請是否累積紅利。預設 false;既有列在 20261001020000 依 referral_bonus_points > 0 回填,讓既有行為零改變。';
comment on column public.merchant_member_settings.referral_subsequent_bonus_points is '紅利系統重構 §1.1 C(#840):推薦者「後續每次達標」獲得幾點(達標 = 被推薦者之後每完成一筆本身有派到點的訂單,§2.6)。';
comment on column public.merchant_member_settings.referral_inviter_earning_enabled is '紅利系統重構 §1.1 C(#840)開關 2:推薦者自己消費是否累積紅利。預設 true(跟現況一致)。';
comment on column public.merchant_member_settings.referral_invitee_earning_enabled is '紅利系統重構 §1.1 C(#840)開關 3:被推薦者自己消費是否累積紅利。預設 true(跟現況一致)。';
comment on column public.merchant_member_settings.birthday_bonus_enabled is '紅利系統重構 §1.1 D(#841):是否啟用生日贈點。預設 false;既有列在 20261001020000 依 birthday_bonus_points > 0 回填。';
comment on column public.merchant_member_settings.birthday_line_message is '紅利系統重構 §1.1 D(#841):生日贈點 LINE 文字訊息範本,可用變數 {{member_name}}/{{points}}/{{merchant_name}},最長 1000 字。歸紅利點數管理(member_points)鑰匙,不歸 LINE 通知鑰匙(第 10 題定案)。';

-- =========================================================================
-- §1.2 新表 merchant_point_formulas(進階派點公式,#838)
-- =========================================================================
create table public.merchant_point_formulas (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  name text not null
    constraint merchant_point_formulas_name_length_check check (char_length(btrim(name)) between 1 and 50),
  enabled boolean not null default true,
  service_item_id uuid references public.service_items(id) on delete cascade,
  min_unit_price numeric(10, 2) not null default 0
    constraint merchant_point_formulas_min_unit_price_check check (min_unit_price >= 0),
  points_per_unit integer not null
    constraint merchant_point_formulas_points_per_unit_check check (points_per_unit >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_point_formulas is '紅利系統重構 §1.2(#838):進階模式的派點公式,一列 = 「某個服務項目(service_item_id 為 NULL 代表全部服務項目)每個數量給幾點、單價要達到多少門檻」。個別項目公式優先,「全部服務項目」只套用在沒有自己公式的項目,兩者不相加(第 2 題定案 B,計算規則在 §2.3,不是資料庫約束)。資料庫層只擋「同一個別項目兩條」與「兩條全部」。RLS 全部要求 private.can_manage_member_points(規則歸紅利點數管理鑰匙);建單頁不直接讀這張表,走 preview_booking_points。服務項目下架時公式保留,不自動刪除/停用。';
comment on column public.merchant_point_formulas.service_item_id is 'NULL = 「全部服務項目」。有值時必須屬於同一個 merchant_id,由 merchant_point_formulas_check_service_item_merchant trigger 在資料庫層擋下跨商家(FK 本身擋不了)。';
comment on column public.merchant_point_formulas.min_unit_price is '單項金額門檻:比對建單當下該項目的實際單價,大於等於才給點(第四輪裁決)。';
comment on column public.merchant_point_formulas.points_per_unit is '每個數量獲得幾點。';

create unique index merchant_point_formulas_merchant_item_unique_idx
  on public.merchant_point_formulas (merchant_id, service_item_id)
  where service_item_id is not null;
create unique index merchant_point_formulas_merchant_all_items_unique_idx
  on public.merchant_point_formulas (merchant_id)
  where service_item_id is null;

create trigger merchant_point_formulas_set_updated_at
  before update on public.merchant_point_formulas
  for each row execute function public.set_updated_at();

-- 規格書 §1.2 寫「函式層檢查 service_item_id 屬於同一個 merchant_id」。但同一節的 RLS 又開放
-- INSERT/UPDATE 給 member_points 鑰匙,等於可以繞過函式直接打 PostgREST 寫表 ⇒ 只在函式層檢查
-- 擋不住。這裡在資料庫層補一道 trigger(比照 private.validate_booking_selection「每種關聯資料都比對
-- merchant_id」的既有慣例),§3.9 的 upsert 函式之後照樣可以再做一次友善的檢查。
create or replace function private.check_point_formula_service_item_merchant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.service_item_id is not null
     and not exists (
       select 1 from public.service_items si
       where si.id = new.service_item_id
         and si.merchant_id = new.merchant_id
     )
  then
    raise exception '公式指定的服務項目不屬於這間商家'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function private.check_point_formula_service_item_merchant() is '紅利系統重構 §1.2:merchant_point_formulas 的 service_item_id 必須屬於同一個 merchant_id。因為這張表的 RLS 開放 member_points 鑰匙直接寫入,只在 upsert_member_point_formulas 函式層檢查擋不住直接打 PostgREST,所以放在資料庫層。';

revoke execute on function private.check_point_formula_service_item_merchant() from public, anon, authenticated;

create trigger merchant_point_formulas_check_service_item_merchant
  before insert or update on public.merchant_point_formulas
  for each row execute function private.check_point_formula_service_item_merchant();

alter table public.merchant_point_formulas enable row level security;

create policy merchant_point_formulas_select on public.merchant_point_formulas
  for select to authenticated
  using (private.can_manage_member_points(merchant_id));

create policy merchant_point_formulas_insert on public.merchant_point_formulas
  for insert to authenticated
  with check (private.can_manage_member_points(merchant_id));

create policy merchant_point_formulas_update on public.merchant_point_formulas
  for update to authenticated
  using (private.can_manage_member_points(merchant_id))
  with check (private.can_manage_member_points(merchant_id));

create policy merchant_point_formulas_delete on public.merchant_point_formulas
  for delete to authenticated
  using (private.can_manage_member_points(merchant_id));

-- =========================================================================
-- §1.3 新表 member_birthday_bonus_grants(生日點數發送紀錄,#841)
-- =========================================================================
create table public.member_birthday_bonus_grants (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  bonus_year integer not null,
  anchor_date date not null,
  points integer not null
    constraint member_birthday_bonus_grants_points_check check (points > 0),
  -- v2.4 主腦裁決 1:on delete cascade。platform_purge_merchant_members_and_points 先刪分類帳、後刪會員,
  -- 沒有 cascade 時只要有生日紀錄就整個清除失敗(23503);分類帳那筆消失,這筆生日紀錄也就沒有意義。
  point_transaction_id uuid not null references public.member_point_transactions(id) on delete cascade,
  member_name_snapshot text not null,
  line_status text not null default 'pending'
    constraint member_birthday_bonus_grants_line_status_check
      check (line_status in ('pending', 'sent', 'failed', 'skipped_not_bound', 'skipped_not_connected')),
  line_error text,
  line_notification_log_id uuid references public.line_notification_log(id) on delete set null,
  granted_at timestamptz not null default clock_timestamp(),
  line_attempted_at timestamptz
);

comment on table public.member_birthday_bonus_grants is '紅利系統重構 §1.3(#841):生日贈點發送紀錄,每位會員每年一列。只有真的發出點數才寫(points > 0)。(member_id, bonus_year) 唯一索引就是「每位會員每年只發一次」的硬性保證,不靠任何「今天跑過了」的旗標。RLS 只有 SELECT(members 或 member_points 任一放行,第 10 題定案),沒有 INSERT/UPDATE/DELETE 政策——只由 service_role 的生日排程函式寫入。';
comment on column public.member_birthday_bonus_grants.anchor_date is '該年的生日錨定日(2/29 生日在平年錨定到 2/28)。';
comment on column public.member_birthday_bonus_grants.point_transaction_id is '對應的 member_point_transactions(birthday_bonus)那一筆。';
comment on column public.member_birthday_bonus_grants.member_name_snapshot is '發送當下的會員姓名(列表顯示用,不回查 members)。';
comment on column public.member_birthday_bonus_grants.granted_at is '用 clock_timestamp() 不用 now():同一次排程內多筆要能排序(比照 booking_status_change_logs 的既有教訓)。';

create unique index member_birthday_bonus_grants_member_year_unique_idx
  on public.member_birthday_bonus_grants (member_id, bonus_year);
create index member_birthday_bonus_grants_merchant_granted_at_idx
  on public.member_birthday_bonus_grants (merchant_id, granted_at desc);

alter table public.member_birthday_bonus_grants enable row level security;

create policy member_birthday_bonus_grants_select on public.member_birthday_bonus_grants
  for select to authenticated
  using (
    private.can_manage_members(merchant_id)
    or private.can_manage_member_points(merchant_id)
  );

comment on column public.members.last_birthday_bonus_year is '【已由 member_birthday_bonus_grants 取代,只做相容寫入】(紅利系統重構 §1.3)新的生日排程仍會同步寫入這個欄位讓既有讀者不壞,但「今年發過沒」的判斷依據改成 member_birthday_bonus_grants 的 (member_id, bonus_year) 唯一索引。原始語意:今年是否已經核發過生日獎勵(規則 2.5)。';

-- =========================================================================
-- §1.4 bookings 新增 7 個欄位(#842 + 生命週期)
-- =========================================================================
alter table public.bookings
  add column points_planned integer not null default 0
    constraint bookings_points_planned_check check (points_planned >= 0);
alter table public.bookings
  add column points_planned_auto integer not null default 0
    constraint bookings_points_planned_auto_check check (points_planned_auto >= 0);
alter table public.bookings
  add column points_planned_overridden boolean not null default false;
alter table public.bookings
  add column points_review_required boolean not null default false;
alter table public.bookings
  add column points_planned_breakdown jsonb not null default '[]'::jsonb;
alter table public.bookings
  add column points_redeemed integer not null default 0
    constraint bookings_points_redeemed_check check (points_redeemed >= 0);
alter table public.bookings
  add column points_redeem_amount_snapshot numeric(10, 2) not null default 0
    constraint bookings_points_redeem_amount_snapshot_check check (points_redeem_amount_snapshot >= 0);
-- v2.4 主腦裁決 2:「有折抵點數的訂單必須連著會員」**不用表層 CHECK**,改成 trigger,只在「寫入/變更折抵」
-- 的那一刻檢查。原因:bookings.member_id 是 on delete set null,會員被硬刪
-- (platform_purge_merchant_members_and_points、單一會員硬刪除)時外鍵會自動把 member_id 清成 null——
-- 表層 CHECK 會讓這種刪除整個失敗(23514)。規則語意不變,只改執行時機:
--   ・INSERT,或 UPDATE 且 points_redeemed 有變更 ⇒ points_redeemed > 0 而 member_id is null 就擋下
--   ・外鍵自動清空 member_id(points_redeemed 沒變)⇒ 不擋,也**不回頭改** points_redeemed /
--     points_redeem_amount_snapshot(保住 #848 報表的歷史折抵金額)
create or replace function private.check_booking_points_redeemed_requires_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT' or new.points_redeemed is distinct from old.points_redeemed)
     and new.points_redeemed > 0
     and new.member_id is null
  then
    raise exception '這筆訂單沒有連結會員,不能使用紅利點數折抵'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function private.check_booking_points_redeemed_requires_member() is '紅利系統重構 §1.4 + v2.4 主腦裁決 2:有折抵點數(points_redeemed > 0)的訂單必須連結會員。只在 INSERT、或 UPDATE 時 points_redeemed 有變更才檢查;會員被硬刪、外鍵 on delete set null 自動清空 member_id 時不擋,也不改動折抵數字(保住帳務報表的歷史折抵金額)。取代原本的表層 CHECK(那會讓 platform_purge 與單一會員硬刪除失敗)。';

revoke execute on function private.check_booking_points_redeemed_requires_member() from public, anon, authenticated;

create trigger bookings_check_points_redeemed_requires_member
  before insert or update on public.bookings
  for each row execute function private.check_booking_points_redeemed_requires_member();
alter table public.bookings
  add constraint bookings_points_redeem_amount_consistent
    check ((points_redeemed = 0) = (points_redeem_amount_snapshot = 0));

comment on column public.bookings.points_planned is '紅利系統重構 §1.4(#842):本單預定派點(建單當下定案的快照),訂單完成時就入帳這個數字。';
comment on column public.bookings.points_planned_auto is '紅利系統重構 §1.4:系統當時算出的建議派點,跟 points_planned 分開存,事後才看得出客服有沒有改過、改了多少。';
comment on column public.bookings.points_planned_overridden is '紅利系統重構 §1.4:客服有沒有人工覆寫派點數。';
comment on column public.bookings.points_review_required is '紅利系統重構 §1.4:建單/編輯當下是否命中「自訂總金額或折扣 → 需人工確認」(§2.5)。';
comment on column public.bookings.points_planned_breakdown is '紅利系統重構 §1.4:逐項計算明細(模式、命中哪條公式、每項幾點),給詳情頁與稽核看,不參與任何計算。';
comment on column public.bookings.points_redeemed is '紅利系統重構 §1.4(#839/#842):客人用幾點折抵,建單當下就從餘額扣掉(redeem_booking),取消時退回(redeem_booking_refund)。寫入/變更成 > 0 時 member_id 必須有值(bookings_check_points_redeemed_requires_member trigger;會員事後被硬刪時不擋、數字保留)。';
comment on column public.bookings.points_redeem_amount_snapshot is '紅利系統重構 §1.4:點數折抵掉的金額。🔴 不從 final_amount_snapshot 扣(第 3 題定案 A):抽成、報表營收、LINE 通知金額全部照舊讀 final_amount_snapshot;「實付」= final_amount_snapshot − 本欄,只在顯示層計算。帳務報表另外加總成「紅利折抵金額」(#848)。';

-- =========================================================================
-- §1.5 member_point_transactions.transaction_type CHECK 擴成 10 種。
--   既有 member_point_transactions_earn_booking_unique_idx 保留不動;不新增任何同型索引
--   (§〇.3 判斷 11:索引改淨額判斷由 #844 的 migration C 處理)。
--   balance_after >= 0 / points_delta <> 0 兩道 CHECK 不動(第 1 題定案 A)。
-- =========================================================================
alter table public.member_point_transactions
  drop constraint member_point_transactions_transaction_type_check;
alter table public.member_point_transactions
  add constraint member_point_transactions_transaction_type_check
    check (transaction_type in (
      'earn_booking', 'referral_bonus', 'birthday_bonus', 'manual_adjustment', 'redeem',
      'referral_repeat_bonus', 'redeem_booking', 'redeem_booking_refund',
      'earn_booking_reversal', 'referral_bonus_reversal'
    ));

comment on column public.member_point_transactions.transaction_type is '十選一(紅利系統重構 §1.5 擴充):earn_booking(消費核發)/referral_bonus(推薦獎勵,首次)/referral_repeat_bonus(推薦獎勵,後續)/birthday_bonus(生日贈點)/manual_adjustment(管理員手動調整)/redeem(會員詳情頁登記兌換)/redeem_booking(建單時折抵凍結)/redeem_booking_refund(訂單取消退回折抵)/earn_booking_reversal(完成後取消/還原,回收本單入帳點數)/referral_bonus_reversal(回收推薦者因本單拿到的推薦獎勵)。新類型不做「每單一筆」唯一索引,冪等靠函式內鎖會員列 + 淨額判斷。';

-- =========================================================================
-- §1.6 line_notification_log.event_type CHECK 加 'birthday_bonus'。
--   merchant_line_event_settings 不動(生日文案存在 merchant_member_settings.birthday_line_message)。
-- =========================================================================
alter table public.line_notification_log
  drop constraint line_notification_log_event_type_check;
alter table public.line_notification_log
  add constraint line_notification_log_event_type_check
    check (event_type in (
      'booking_created', 'booking_confirmed', 'booking_cancelled', 'booking_completed',
      'staff_leave_created', 'marketing_manual', 'birthday_bonus'
    ));

-- =========================================================================
-- §3.10 private.protect_merchant_member_settings_rule_columns():把 §1.1 A/B/C/D 全部新欄位
--   加進「紅利點數規則」保護清單。v2.3 分兩次改:這次(批次 1)舊欄位 points_earn_rate **仍在清單內**
--   (欄位還在,前端設定頁也還在寫它);批次 6 drop 欄位的同一支 migration 再移出。
--   會員政策兩欄的分支、三個放行條件、錯誤碼一個字都不動;只把錯誤訊息括號內的項目改成新的
--   四個分頁名稱(白話說明被擋的是哪一類設定)。
--   INSERT 分支比對的預設值逐一照上面 add column 的 DEFAULT(= 規格書 §1.1 表格)。
-- =========================================================================
create or replace function private.protect_merchant_member_settings_rule_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  -- 這次異動有沒有真的改動到「紅利點數規則」那些欄位。
  v_touches_points_rules boolean;
  -- 這次異動有沒有真的改動到「會員政策」那兩個欄位。
  v_touches_policy boolean;
  v_merchant_id uuid;
begin
  if tg_op = 'INSERT' then
    -- INSERT:old 是 NULL,不能寫 `is distinct from old.xxx`(對 NULL record 取欄位在 plpgsql
    -- 觸發器裡會直接 raise)。改成判斷「有沒有主動帶了非預設值」,預設值以 schema 實際宣告為準。
    v_touches_points_rules :=
      coalesce(new.points_feature_enabled, true) is distinct from true
      or coalesce(new.reward_condition_mode, 'none') is distinct from 'none'
      or coalesce(new.points_earn_rate, 0) is distinct from 0::numeric
      or coalesce(new.referral_bonus_points, 0) is distinct from 0
      or coalesce(new.birthday_bonus_points, 0) is distinct from 0
      -- 紅利系統重構 §1.1 A 紅利計算
      or coalesce(new.earn_mode, 'basic') is distinct from 'basic'
      or coalesce(new.basic_points_per_order, 0) is distinct from 0
      or coalesce(new.basic_min_amount, 0) is distinct from 0::numeric
      or coalesce(new.basic_tiered_enabled, false) is distinct from false
      -- §1.1 B 點數使用
      or coalesce(new.redeem_points_unit, 0) is distinct from 0
      or coalesce(new.redeem_amount_unit, 0) is distinct from 0::numeric
      or coalesce(new.redeem_max_ratio_percent, 0) is distinct from 0
      -- §1.1 C 推薦系統
      or coalesce(new.referral_inviter_reward_enabled, false) is distinct from false
      or coalesce(new.referral_subsequent_bonus_points, 0) is distinct from 0
      or coalesce(new.referral_inviter_earning_enabled, true) is distinct from true
      or coalesce(new.referral_invitee_earning_enabled, true) is distinct from true
      -- §1.1 D 生日獎勵
      or coalesce(new.birthday_bonus_enabled, false) is distinct from false
      or coalesce(new.birthday_line_message, '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。')
           is distinct from '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。';

    v_touches_policy :=
      coalesce(new.policy_enabled, false) is distinct from false
      or new.policy_content is not null;

    v_merchant_id := new.merchant_id;
  else
    -- UPDATE:比對「值有沒有真的被改動」。這是整支 trigger 的關鍵——用 is distinct from 而不是
    -- 「payload 有沒有帶這個欄位」,所以 MemberSettingsPage 存會員政策時把規則欄位原樣
    -- 送一次(值沒變)完全不會觸發規則組的檢查,反之亦然。
    v_touches_points_rules :=
      new.points_feature_enabled is distinct from old.points_feature_enabled
      or new.reward_condition_mode is distinct from old.reward_condition_mode
      or new.points_earn_rate is distinct from old.points_earn_rate
      or new.referral_bonus_points is distinct from old.referral_bonus_points
      or new.birthday_bonus_points is distinct from old.birthday_bonus_points
      -- 紅利系統重構 §1.1 A 紅利計算
      or new.earn_mode is distinct from old.earn_mode
      or new.basic_points_per_order is distinct from old.basic_points_per_order
      or new.basic_min_amount is distinct from old.basic_min_amount
      or new.basic_tiered_enabled is distinct from old.basic_tiered_enabled
      -- §1.1 B 點數使用
      or new.redeem_points_unit is distinct from old.redeem_points_unit
      or new.redeem_amount_unit is distinct from old.redeem_amount_unit
      or new.redeem_max_ratio_percent is distinct from old.redeem_max_ratio_percent
      -- §1.1 C 推薦系統
      or new.referral_inviter_reward_enabled is distinct from old.referral_inviter_reward_enabled
      or new.referral_subsequent_bonus_points is distinct from old.referral_subsequent_bonus_points
      or new.referral_inviter_earning_enabled is distinct from old.referral_inviter_earning_enabled
      or new.referral_invitee_earning_enabled is distinct from old.referral_invitee_earning_enabled
      -- §1.1 D 生日獎勵
      or new.birthday_bonus_enabled is distinct from old.birthday_bonus_enabled
      or new.birthday_line_message is distinct from old.birthday_line_message;

    v_touches_policy :=
      new.policy_enabled is distinct from old.policy_enabled
      or new.policy_content is distinct from old.policy_content;

    -- 用 old.merchant_id(這一列目前歸屬的商家)。merchant_id 是主鍵,理論上不會被改,
    -- 這裡比照 20260924020100 的既有寫法多一層保險。
    v_merchant_id := old.merchant_id;
  end if;

  if v_touches_points_rules
     -- 放行路徑:service_role(後台維運 / Edge Function)。目前沒有任何 Edge Function 會寫
     -- 這張表,保留這道是為了跟既有三支保護 trigger 的結構一致,不留下「將來多一條路徑就爆掉」
     -- 的落差。
     and auth.role() <> 'service_role'
     and not private.can_manage_member_points(v_merchant_id)
  then
    raise exception '紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改;「會員管理」權限可以做手動調整與登記兌換,但不能改這些規則'
      using errcode = '42501';
  end if;

  if v_touches_policy
     and auth.role() <> 'service_role'
     and not private.can_manage_member_settings(v_merchant_id)
  then
    raise exception '會員政策(啟用開關與政策內容)需要「會員系統設定」權限才能修改'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.protect_merchant_member_settings_rule_columns() is '2026-09-24 使用者裁決(紅利點數管理權限拆分)的欄位層級保護;2026-10-01 紅利系統重構批次 1(§3.10)擴充保護清單。merchant_member_settings 是整列 upsert(PostgREST 不是 RPC),RLS 的 UPDATE policy 是整列層級、WITH CHECK 看不到 OLD,所以用 BEFORE INSERT OR UPDATE trigger(比照 merchant_staff 上既有三支保護 trigger)。兩組欄位對稱處理:「紅利點數規則」= points_feature_enabled/reward_condition_mode/points_earn_rate(批次 6 drop 時移出)/referral_bonus_points/birthday_bonus_points + 紅利計算(earn_mode/basic_points_per_order/basic_min_amount/basic_tiered_enabled)+ 點數使用(redeem_points_unit/redeem_amount_unit/redeem_max_ratio_percent)+ 推薦系統(referral_inviter_reward_enabled/referral_subsequent_bonus_points/referral_inviter_earning_enabled/referral_invitee_earning_enabled)+ 生日獎勵(birthday_bonus_enabled/birthday_line_message),要 private.can_manage_member_points;會員政策兩欄(policy_enabled/policy_content)要 private.can_manage_member_settings。⚠️ 判斷的是「值真的有變動」(is distinct from)而不是「payload 有沒有帶這個欄位」。INSERT 面跟 schema 實際預設值比對;seed_default_member_settings 只帶 merchant_id,所以建立新商家的路徑一定不會被擋。';
