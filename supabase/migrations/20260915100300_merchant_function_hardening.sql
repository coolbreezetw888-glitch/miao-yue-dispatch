-- 模組 1:商家與集團管理 — 安全加固
-- 對應 Supabase 顧問(security advisor)掃描結果的修正,不對應規格書新增需求,是落實 3.6 RLS
-- 設計原則「不對前端開放非必要寫入/呼叫」時順手補上的資料庫函式權限收斂:
--   1. 三個 trigger 函式補上 search_path,避免 search_path 被劫持(function_search_path_mutable)。
--   2. Supabase 專案預設會在函式建立時,自動額外授權 anon/authenticated 可以直接執行
--      (不只是透過 PUBLIC),單靠 `revoke ... from public` 收不掉這層——必須額外對
--      anon/authenticated 個別下 revoke。本模組原本設計成「只能透過 RPC 呼叫」的內部輔助函式
--      (apply_industry_preset、generate_booking_slug)與純 trigger 函式
--      (prevent_disable_last_active_merchant),收斂成不開放任何角色直接呼叫。

alter function public.set_updated_at() set search_path = public;
alter function public.prevent_industry_type_change() set search_path = public;
alter function public.storage_path_merchant_id(text) set search_path = public;

-- 內部輔助函式:只給 create_group_and_merchant / create_merchant_in_group 內部呼叫,
-- 不開放 anon/authenticated 直接打 /rest/v1/rpc/apply_industry_preset 等端點。
revoke execute on function public.apply_industry_preset(uuid) from anon, authenticated;
revoke execute on function public.generate_booking_slug(text) from anon, authenticated;

-- 純 trigger 函式,不需要也不應該被任何角色直接呼叫。
revoke execute on function public.prevent_disable_last_active_merchant() from anon, authenticated;

-- create_group_and_merchant / create_merchant_in_group:只給登入使用者呼叫,anon 不行。
revoke execute on function public.create_group_and_merchant(text, text, text, text, text) from anon;
revoke execute on function public.create_merchant_in_group(uuid, text, text, text, text, text) from anon;

-- is_merchant_admin / is_group_member:供 RLS 政策及登入後前端呼叫,anon 不需要。
revoke execute on function public.is_merchant_admin(uuid) from anon;
revoke execute on function public.is_group_member(uuid) from anon;
