-- 對應規格書 4.3(商家設定頁-唯讀管理員清單顯示)、5.4(對外介面:管理員名單查詢)。
-- auth.users 不會透過 PostgREST 直接暴露給前端查詢，也不適合前端直接 join，
-- 所以用一個 security definer 函式安全地把「merchant_admins join auth.users 的 email」
-- 包成一個唯讀查詢介面，呼叫前先檢查 is_merchant_admin，通過才回傳，供模組 3 之後直接複用。
create or replace function public.get_merchant_admin_users(p_merchant_id uuid)
returns table (
  id uuid,
  merchant_id uuid,
  user_id uuid,
  email text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not public.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限查看此商家的管理員名單' using errcode = '42501';
  end if;

  return query
    select ma.id, ma.merchant_id, ma.user_id, u.email::text, ma.created_at
    from public.merchant_admins ma
    join auth.users u on u.id = ma.user_id
    where ma.merchant_id = p_merchant_id
    order by ma.created_at asc;
end;
$$;

comment on function public.get_merchant_admin_users(uuid) is '對應規格書 4.3、5.4:回傳指定商家的管理員清單+email，呼叫者必須通過 is_merchant_admin 檢查。';

revoke execute on function public.get_merchant_admin_users(uuid) from public, anon;
grant execute on function public.get_merchant_admin_users(uuid) to authenticated;
