-- SPECS-INDEX 編號 254/265(規格書 .project/specs/排班與休假管理.md §2.11、§4.3)。
--
-- 背景:品管以真實瀏覽器用「只有 team_leave 權限(沒有 orders/scheduling)」的客服身份複驗
-- 「請假紀錄」頁面(§4.3)時發現,「登記請假」表單的服務人員下拉選單一律顯示「目前沒有月薪制
-- 的服務人員」,即使商家明明有月薪制服務人員,導致這種客服完全無法登記請假紀錄,違反規格書
-- §2.11「team_leave 客服可以登記/取消請假紀錄」。附帶問題:既有請假紀錄清單裡每筆紀錄的服務
-- 人員姓名顯示佔位字「(服務人員)」而非真實姓名——這是同一個根因造成的兩個表面現象。
--
-- 根因:主腦已直接查詢正式環境 pg_policy 系統表確認,`public.merchant_staff` 的 SELECT 政策
-- (`merchant_staff_select`,定義在 20260919140000_booking_related_tables_select_policy_orders_fix.sql)
-- 目前條件是 `private.is_merchant_admin(merchant_id) or private.can_manage_bookings(merchant_id)`,
-- 只放行商家管理員跟有 orders 權限的客服,沒有把 `private.can_manage_team_leave(merchant_id)` 算
-- 進去。前端「請假紀錄」頁面(LeaveRecordsPage.tsx)不管是「新增請假」表單的服務人員下拉選單,
-- 還是既有紀錄清單裡的服務人員姓名顯示,都是透過 `useMerchantStaffList`(受這張表 RLS 限制)
-- 取得資料——只有 team_leave 權限的客服呼叫這個 hook 一律拿到空陣列,導致下拉選單顯示「目前
-- 沒有月薪制的服務人員」、清單姓名 fallback 成「(服務人員)」佔位字。`create_staff_leave`/
-- `cancel_staff_leave` 這兩支 RPC 本身的權限檢查完全沒有問題(內部用 can_manage_team_leave 自己
-- 判斷,不透過 merchant_staff RLS),問題只出在前端 UI 讀取服務人員清單這一層。
--
-- 修法:比照 20260919140000 那支 migration 已有的先例(同一條政策當時就是為了放行 orders 權限
-- 才加的),再加一個 `or private.can_manage_team_leave(merchant_id)` 條件。SELECT 只是讀取服務
-- 人員基本資料(姓名/計酬類型等)用於下拉選單/清單姓名顯示,不涉及任何敏感操作或資料異動,
-- 放寬讀取範圍風險低。INSERT/UPDATE 政策(仍然只給 is_merchant_admin)完全不動,不受本次修正
-- 影響。也不動 can_view_scheduling——「排班一覽」頁面透過 RPC(get_staff_schedule_overview)讀取,
-- 不經過這張表的 RLS,品管已確認 scheduling-only 客服使用該頁面沒有問題,範圍不需要一併擴大。

drop policy if exists merchant_staff_select on public.merchant_staff;

create policy merchant_staff_select on public.merchant_staff
  for select to authenticated
  using (
    private.is_merchant_admin(merchant_id)
    or private.can_manage_bookings(merchant_id)
    or private.can_manage_team_leave(merchant_id)
  );
