-- 模組 14:服務人員端(功能層,第三支)——本模組風險最高的兩個既有政策疊加。
-- 對應規格書 3.2(merchants_select)、3.3(merchant_staff_select)。
--
-- 動工前已用 mcp Supabase execute_sql 直接查詢正式環境(專案 wjtbmmnakcriuaqoknsq)
-- pg_policies 系統視圖,確認這兩條政策目前的完整最新定義,在此基礎上疊加,不是照抄規格書或
-- migration 檔名臆測的版本(比照模組 9 §233 事故的教訓,規格書 3.2/3.3 明講要做這件事):
--   merchants_select:
--     private.is_merchant_admin(id) or private.is_platform_admin() or private.is_merchant_agent(id)
--     (最後一次疊加在 20260916100000_staff_agent_schema.sql,之後沒有任何 migration 再動過)
--   merchant_staff_select:
--     private.is_merchant_admin(merchant_id) or private.can_manage_bookings(merchant_id)
--     or private.can_manage_team_leave(merchant_id) or private.can_manage_commission_settings(merchant_id)
--     or private.can_view_payroll_reports(merchant_id)
--     (最後一次疊加在 20260920130000_merchant_staff_select_policy_payroll_fix.sql)
-- 兩者都跟本地 migration 檔案逐字比對過,確認一致,沒有正式環境獨自漂移的情況。

-- =========================================================================
-- 3.2:merchants_select 疊加 is_merchant_staff 分支,讓服務人員登入後透過既有的
-- fetchAccessibleMerchants() 正確看到自己服務的商家,不會被誤導到 Onboarding。
-- 不疊加 merchants_update——服務人員不能改商家設定(規格書 3.2 邊界情況)。
-- =========================================================================
alter policy merchants_select on public.merchants
  using (
    private.is_merchant_admin(id)
    or private.is_platform_admin()
    or private.is_merchant_agent(id)
    or private.is_merchant_staff(id)
  );

-- =========================================================================
-- 3.3:merchant_staff_select 疊加自我讀取條件 or user_id = auth.uid()。
-- 比照 merchant_agents_select 的既有精神,不限制 status/login_status——讓被移除的服務人員
-- 仍能讀到「自己被移除了」這個誠實狀態,不算資料外洩(規格書 3.3 說明,理由同模組 3 規則 2.9
-- 邊界情況)。不修改 merchant_staff_update(自助編輯改走 3.16 專屬函式,見規格書 3.3 邊界情況)。
-- =========================================================================
drop policy if exists merchant_staff_select on public.merchant_staff;

create policy merchant_staff_select on public.merchant_staff
  for select to authenticated
  using (
    private.is_merchant_admin(merchant_id)
    or private.can_manage_bookings(merchant_id)
    or private.can_manage_team_leave(merchant_id)
    or private.can_manage_commission_settings(merchant_id)
    or private.can_view_payroll_reports(merchant_id)
    or user_id = auth.uid()
  );
