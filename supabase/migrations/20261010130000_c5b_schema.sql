-- 客戶端第 5-B 批(LINE 通知客人:費用與延伸)— 資料結構
-- 規格:.project/specs/客戶端第5批-LINE通知與綁定.md(零之零定案優先;5-B 範圍見第五節)。
--
-- 這支只動資料結構(5-A 的兩支 migration 不改):
--   ① merchant_customer_line_settings 加 quota_checked_at(C5-Q04 第 2 點:查 LINE 額度每店每小時最多一次)
--   ② member_birthday_bonus_grants.line_status 多 skipped_opted_out(C5-P02:主要聯絡人關掉「優惠通知」)
--      原有值逐字保留(2026-10-09 正式庫 SELECT 核對:pending / sent / failed / skipped_not_bound /
--      skipped_not_connected / skipped_member_removed / skipped_merchant_disabled)。

-- =========================================================================
-- ① C5-Q04:上次查 LINE 額度的時間(dispatcher 用 internal_line_quota_check_due 搶這個時間戳)
-- =========================================================================
alter table public.merchant_customer_line_settings
  add column if not exists quota_checked_at timestamptz null;

comment on column public.merchant_customer_line_settings.quota_checked_at is
  'C5-Q04:customer-line-notify-dispatch 上次查 LINE 官方帳號本月額度的時間(每店每小時最多查一次)。只由 internal_line_quota_check_due 寫。';

-- =========================================================================
-- ② C5-P02:生日禮 LINE 多一種略過原因
-- =========================================================================
alter table public.member_birthday_bonus_grants
  drop constraint member_birthday_bonus_grants_line_status_check;
alter table public.member_birthday_bonus_grants
  add constraint member_birthday_bonus_grants_line_status_check
    check (line_status in ('pending', 'sent', 'failed', 'skipped_not_bound', 'skipped_not_connected',
                           'skipped_member_removed', 'skipped_merchant_disabled',
                           'skipped_opted_out'));
