-- 模組 2:超級管理員/平台管理後台(核心層)— 補充讀取用小工具函式
-- 這兩個函式不是規格書 3.1-3.8 明列的項目，是為了滿足介面 4.3(管理員人數欄位)、
-- 4.5(集團管理者是誰的顯示)而額外新增的讀取輔助，範圍很小且都由 is_platform_admin() 內部把關，
-- 不修改任何既有政策，也不疊加規則 2.3 刻意不疊加的 merchant_admins RLS。
-- 這是工程師實作時發現規格書沒有明講的缺口，已同步在回報中向主腦/使用者說明，請求確認。

-- =========================================================================
-- 4.3:集團與商家清單頁需要顯示「管理員人數」。規則 2.3 刻意不疊加 merchant_admins 的 RLS，
-- 平台管理員對 merchant_admins 做 embedded count 查詢會被既有政策擋下(只看得到自己直接管理
-- 的商家的管理員筆數，看不到別家商家的)。用一個小型 SECURITY DEFINER 函式一次回傳所有商家的
-- 管理員人數，只回傳數字，不含 email，不擴大既有的 email 曝光範圍。
-- =========================================================================
create or replace function public.platform_get_merchant_admin_counts()
returns table (
  merchant_id uuid,
  admin_count bigint
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  return query
    select ma.merchant_id, count(*)::bigint
    from public.merchant_admins ma
    group by ma.merchant_id;
end;
$$;

comment on function public.platform_get_merchant_admin_counts() is '對應介面 4.3(管理員人數欄位)的補充讀取函式，只回傳每個商家的管理員筆數，不含 email，呼叫者必須是平台管理員。';

revoke execute on function public.platform_get_merchant_admin_counts() from public, anon;
grant execute on function public.platform_get_merchant_admin_counts() to authenticated;

-- =========================================================================
-- 4.5:集團管理者設定區塊需要顯示「目前的集團管理者是誰」。groups.group_admin_user_id 只是
-- auth.users 的 uuid，前端不能直接查 auth.users(比照模組 1「auth.users 不能被前端直接 join」
-- 的原則，見 merchant-group-module SKILL)。只回傳單一 user_id 對應的 email，呼叫者必須是平台管理員。
-- =========================================================================
create or replace function public.platform_get_user_email(p_user_id uuid)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  return (select email::text from auth.users where id = p_user_id);
end;
$$;

comment on function public.platform_get_user_email(uuid) is '對應介面 4.5(顯示目前集團管理者是誰)的補充讀取函式，只回傳單一 user_id 對應的 email，呼叫者必須是平台管理員。';

revoke execute on function public.platform_get_user_email(uuid) from public, anon;
grant execute on function public.platform_get_user_email(uuid) to authenticated;
