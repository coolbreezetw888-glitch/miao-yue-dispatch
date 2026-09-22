-- 模組 8(薪資與帳務)規格書 §十 10.1:merchant_payroll_settings.pay_days_per_month 直接移除
-- (drop column,不是保留但不讀取)——理由:欄位留著卻沒有任何程式碼讀取,容易誤導之後維護的人
-- 以為它還有作用。
--
-- ⚠️ 動工前查證(2026-09-22,主腦委派 engineer 執行,遵循本專案 Rule 5-1):
--   1. 正式環境 `select count(*), count(*) filter (where pay_days_per_month <> 30), min(...), max(...)
--      from merchant_payroll_settings` 查證結果:3 筆商家資料,全部都是預設值 30,沒有任何商家
--      自己改過這個數字——drop 這個欄位不會有任何商家的既有客製化設定被悄悄清掉。
--   2. `select proname from pg_proc where prosrc ilike '%pay_days_per_month%'` 查證結果:整個資料庫
--      只有 private.compute_staff_payroll 這一支函式讀取這個欄位,已於前一支 migration
--      (20260922130100)改成呼叫 private.get_days_in_month 動態計算,drop 這個欄位前已經沒有任何
--      資料庫函式還在讀寫它。
--   3. `select ... from pg_policies where qual/with_check ilike '%pay_days_per_month%'` 查證結果:
--      沒有任何 RLS 政策引用這個欄位。
--   4. 前端讀寫這個欄位的地方(PayrollSettingsPage.tsx 的月折算天數輸入框、api.ts 的
--      UpsertMerchantPayrollSettingsInput.payDaysPerMonth、LeaveDeductionRuleDialog.tsx 的預覽試算)
--      已在同一批次的前端改動裡一併移除/調整,不會留下「欄位已經被砍但前端表單還在嘗試寫入」的
--      半殘狀態。

alter table public.merchant_payroll_settings drop column pay_days_per_month;

comment on table public.merchant_payroll_settings is '商家層級薪資設定(模組 8 薪資與帳務 §1.1):一商家一列,查無資料時前端/後端一律套用預設值(commission_basis_type=gross、default_commission_rate_percentage 已於商家端三項調整規格書 §二 2.2.2 移除)。RLS 要求 private.can_manage_commission_settings(merchant_id),沒有 DELETE 政策。⚠️ 已於 2026-09-22 調整(§十 10.1):原本的 pay_days_per_month(月折算天數)欄位已移除,改成系統依「當月實際天數」動態計算(見 private.get_days_in_month),不再是商家可填寫的欄位。';
