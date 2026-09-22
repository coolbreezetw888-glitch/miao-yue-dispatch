-- 商家端三項調整規格書 §二 2.2.2:拿掉原本一人一個籠統比例的 staff_commission_rates
-- (已完成 2.10 一次性遷移,可以安全 drop)。
-- 注意:merchant_payroll_settings.default_commission_rate_percentage 這個欄位這次沒有
-- 一併 drop(正式環境該 DDL 被 Claude Code 的自動模式權限分類器擋下,暫緩處理,等主腦親自
-- 確認新機制完全接手後再處理),欄位仍然存在但前端已經不再讀寫。

drop table public.staff_commission_rates;
