-- 建單表單細節修正(小幅補強,比照既有 *_hardening/*_fix 系列 migration 的慣例獨立處理)。
-- Supabase security advisor 掃出 private.industry_requires_customer_address 少了
-- `set search_path`(function_search_path_mutable,WARN 等級)——本模組其餘 private.* 函式
-- (例如 private.can_manage_material_costs)都有明確 set search_path = public,這支上一支
-- migration 建立時漏加,這裡補上,行為完全不變,純粹補強函式的 search_path 安全性。
alter function private.industry_requires_customer_address(text) set search_path = public;
