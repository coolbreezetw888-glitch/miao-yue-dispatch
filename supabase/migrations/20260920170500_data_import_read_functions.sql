-- 模組 12:資料匯入/報表匯出 — 唯讀查詢函式(第六支)。
-- 對應規格書 §3.7/§3.8。
create or replace function public.get_merchant_bulk_operations(p_merchant_id uuid)
returns setof public.merchant_bulk_operations
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的批次操作紀錄' using errcode = '42501';
  end if;

  return query
    select *
    from public.merchant_bulk_operations
    where merchant_id = p_merchant_id
    order by created_at desc;
end;
$$;

comment on function public.get_merchant_bulk_operations(uuid) is '模組 12 §3.7:回傳該商家的批次操作歷史清單(依時間新到舊)，供 4.2 匯入紀錄頁使用。只有商家管理員可以查詢。';

revoke execute on function public.get_merchant_bulk_operations(uuid) from public, anon;
grant execute on function public.get_merchant_bulk_operations(uuid) to authenticated;

create or replace function public.platform_list_merchant_bulk_operations(p_merchant_id uuid)
returns setof public.merchant_bulk_operations
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not (private.is_platform_admin() or private.is_merchant_admin(p_merchant_id)) then
    raise exception '沒有權限查詢這間商家的批次操作紀錄' using errcode = '42501';
  end if;

  return query
    select *
    from public.merchant_bulk_operations
    where merchant_id = p_merchant_id
    order by created_at desc;
end;
$$;

comment on function public.platform_list_merchant_bulk_operations(uuid) is '模組 12 §3.8:模組 2(超級管理員後台)掛鉤點，這次沒有任何 UI 使用，純粹是給之後「代替商家排查資料匯入問題」情境直接複用的建構塊。平台管理員或該商家管理員可以呼叫，一般客服被擋下。';

revoke execute on function public.platform_list_merchant_bulk_operations(uuid) from public, anon;
grant execute on function public.platform_list_merchant_bulk_operations(uuid) to authenticated;
