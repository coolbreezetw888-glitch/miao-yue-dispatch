-- 模組 2:超級管理員/平台管理後台(核心層)— 小修正
-- 對應規格書規則 2.2/功能 3.2(public.am_i_platform_admin)。
-- 這支函式建立當下，Postgres 預設會額外授權 PUBLIC 執行；anon 角色是透過 PUBLIC 這個虛擬角色
-- 取得執行權，不是被直接 grant，所以光是 `revoke ... from anon` 收不掉這層，
-- Supabase security advisor 掃出 anon_security_definer_function_executable 警示。
-- 比照模組 1 對 get_merchant_admin_users 的做法(見 20260915100400_merchant_admin_users_lookup.sql)，
-- 額外對 public 也下 revoke。
revoke execute on function public.am_i_platform_admin() from public, anon;
grant execute on function public.am_i_platform_admin() to authenticated;
