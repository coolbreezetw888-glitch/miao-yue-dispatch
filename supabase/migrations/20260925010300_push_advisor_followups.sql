-- 模組 15 擴充:手機推播擴及三種角色 — Supabase advisors 的兩項回應
-- (supabase-permission-hygiene 規則 5:每次動完 schema 跑一次 advisors,並處理自己新產生的項目)
--
-- 2026-09-25 套用前三支 migration 之後跑 performance advisors,這一批**自己新增**的兩個項目:
--   1. auth_rls_initplan × 3:push_subscriptions 的三條政策直接寫 `auth.uid()`,
--      PostgreSQL 會對每一列重新算一次。官方建議改寫成 `(select auth.uid())`,
--      這樣它變成 InitPlan、整個查詢只算一次。
--   2. unindexed_foreign_keys × 1:push_notification_log.ack_subscription_id 沒有覆蓋索引。
--      這一欄的用途是「刪除裝置時要把 log 那一欄設成 null」(on delete set null)——
--      使用者每按一次「移除這台裝置」,PostgreSQL 就要掃一次整張 log 表找有沒有參照。
--      log 表是會長期累積的稽核記錄,沒有索引之後會愈來愈慢。
--
-- ⚠️ 這兩項都**沒有改變任何權限判斷結果**:`(select auth.uid())` 跟 `auth.uid()` 回傳同一個值,
--    加索引更是完全不影響語意。pgTAP 的 RLS 斷言在這支 migration 之後仍然全綠。
--
-- 其餘 advisors 項目都不是這一批產生的:
--   - rls_enabled_no_policy(push_reminder_dedupe_log 等 4 張)是這個專案刻意的設計
--     (RLS 開啟 + 零政策 = 完全拒絕一般客戶端,只有 service_role 能碰),不是漏洞。
--   - authenticated_security_definer_function_executable 是這個架構的常態(SECURITY DEFINER RPC
--     + 函式內部權限檢查)。本批次新增的 5 支 authenticated 可呼叫函式已逐支確認內部都有檢查:
--     upsert_my_push_subscription(只用 auth.uid())、get_my_push_identity /
--     get_merchant_push_event_enabled_map / count_my_recent_test_pushes(不是成員就 raise 42501)、
--     get_staff_push_status(private.is_merchant_admin)。
--   - **完全沒有 anon_security_definer_function_executable** —— 本批次沒有任何函式開給 anon。

-- =========================================================================
-- 1. push_subscriptions 的三條政策改用 (select auth.uid())
-- =========================================================================
drop policy push_subscriptions_select on public.push_subscriptions;
drop policy push_subscriptions_insert on public.push_subscriptions;
drop policy push_subscriptions_delete on public.push_subscriptions;

create policy push_subscriptions_select on public.push_subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy push_subscriptions_insert on public.push_subscriptions
  for insert to authenticated
  with check (user_id = (select auth.uid()));

create policy push_subscriptions_delete on public.push_subscriptions
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- §2.1:仍然刻意沒有 UPDATE 政策(理由見 20260925010000 的註解)。

-- =========================================================================
-- 2. push_notification_log.ack_subscription_id 的覆蓋索引
-- 只有測試推播會填這一欄,絕大多數列是 null,所以用 partial index(省空間、也更快)。
-- =========================================================================
create index push_notification_log_ack_subscription_idx
  on public.push_notification_log (ack_subscription_id)
  where ack_subscription_id is not null;
