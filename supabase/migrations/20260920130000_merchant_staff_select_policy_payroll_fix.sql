-- SPECS-INDEX 編號 299/302(規格書 .project/specs/薪資與帳務.md §4.1/§4.4)。
--
-- 背景:品管驗收「抽成與薪資設定頁」(/app/payroll-settings)跟「師傅報表頁」(/app/staff-report)
-- 時回報「商家底下明明有在職服務人員,兩個頁面的服務人員清單/下拉選單卻都顯示空清單」,並確認
-- 用同一個登入 session 直接對 merchant_staff 下一模一樣的 REST 查詢(merchant_id + status=active)
-- 能正確拿回資料,證明問題出在前端。
--
-- 這次調查用 Playwright 針對「商家管理員」登入的情境,分別模擬「服務人員已存在時直接進入頁面」
-- 跟「先進入空清單頁面、再透過 UI 新增服務人員、SPA 導航切回同頁」兩種情境,兩者都正確顯示服務
-- 人員清單、React Query 的 refetch-on-mount 行為也正常——無法在「商家管理員」身分下重現品管回報
-- 的現象,懷疑當時品管的瀏覽器自動化工具真的如他們自己在 SPECS-INDEX 備註裡提到的一樣不穩定。
--
-- 但調查過程中,直接用 SQL 建立一位「只有 commission_settings 權限、沒有 orders/team_leave/
-- 管理員身分」的客服帳號,實際登入後對 merchant_staff 下一模一樣的查詢,確認回傳 0 筆
-- (即使該商家確實有 2 位在職服務人員)——這是一個真實、可 100% 穩定重現的既有缺口,只是觸發身分
-- 是「客服」不是「商家管理員」。這兩個頁面的路由守衛(RequireCommissionSettingsAccess.tsx/
-- RequireStaffReportAccess.tsx)明確設計成允許被開通 commission_settings/billing/staff_report
-- 權限的客服進入,但 merchant_staff 的 SELECT 政策(merchant_staff_select,目前條件是
-- is_merchant_admin or can_manage_bookings or can_manage_team_leave,見
-- 20260919140000_booking_related_tables_select_policy_orders_fix.sql/
-- 20260920110000_merchant_staff_select_policy_team_leave_fix.sql 兩次既有先例)完全沒有把這三把
-- 鑰匙算進去,導致這種客服打開這兩個頁面時,useMerchantStaffList 拿到的永遠是空陣列——跟品管
-- 回報的畫面症狀(「目前沒有按件計酬的服務人員」/「目前沒有月薪制的服務人員」/「目前沒有在職的
-- 服務人員」)完全一致。這個既有缺口在 20260920120100_payroll_billing_functions.sql 建立
-- private.staff_compensation_type() 這支 SECURITY DEFINER 函式時,註解裡已經明講「該表 SELECT
-- 政策不包含 commission_settings 這把鑰匙,會誤擋被開通 commission_settings 的客服」,但當時只
-- 繞開了 staff_commission_rates/staff_salary_settings 的 RLS WITH CHECK 判斷,沒有一併修正這裡
-- 真正擋住前端下拉選單/清單顯示的 merchant_staff_select 本身。
--
-- 修法:比照 20260919140000/20260920110000 兩支既有先例,再加上這兩個頁面實際要求的權限:
--   - private.can_manage_commission_settings(merchant_id):抽成與薪資設定頁(/app/payroll-settings)
--     的守衛權限,涵蓋 is_merchant_admin(內部已包含,加了不影響既有行為)。
--   - private.can_view_payroll_reports(merchant_id):師傅報表頁(/app/staff-report)的守衛權限,
--     內部是 can_view_billing or can_view_staff_report 任一為真(涵蓋 billing/staff_report 兩把
--     鑰匙,對應規格書「billing 連帶可以看師傅報表」的既有設計,同樣內部已包含 is_merchant_admin)。
-- SELECT 只是讀取服務人員基本資料(姓名/計酬類型等)用於下拉選單/清單顯示,不涉及任何敏感操作或
-- 資料異動,放寬讀取範圍風險低。INSERT/UPDATE 政策(仍然只給 is_merchant_admin)完全不動,不受
-- 本次修正影響。

drop policy if exists merchant_staff_select on public.merchant_staff;

create policy merchant_staff_select on public.merchant_staff
  for select to authenticated
  using (
    private.is_merchant_admin(merchant_id)
    or private.can_manage_bookings(merchant_id)
    or private.can_manage_team_leave(merchant_id)
    or private.can_manage_commission_settings(merchant_id)
    or private.can_view_payroll_reports(merchant_id)
  );
