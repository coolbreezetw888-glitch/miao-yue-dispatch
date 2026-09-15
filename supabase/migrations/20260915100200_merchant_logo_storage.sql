-- 模組 1:商家與集團管理
-- 對應規格書 3.5(Storage bucket 設定)、規則 2.6(LOGO 格式與大小限制)。
-- 上傳路徑慣例:<merchant_id>/<檔名>,前端上傳時要照這個慣例組路徑(見 src/modules/merchant/api.ts)。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'merchant-logos',
  'merchant-logos',
  true,
  2097152, -- 2MB,見規則 2.6。前端仍需在送出前擋下超過限制的檔案,這裡是後端層的第二道防線。
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 從物件路徑(<merchant_id>/<檔名>)解析出 merchant_id;解析失敗回傳 null 而不是拋錯,
-- 讓後面的 is_merchant_admin(null) 自然評估為 false,不會讓整條政策因為型別轉換錯誤而中斷。
create or replace function public.storage_path_merchant_id(p_path text)
returns uuid
language plpgsql
immutable
as $$
begin
  return (storage.foldername(p_path))[1]::uuid;
exception
  when others then
    return null;
end;
$$;

-- 公開讀取(顯示 LOGO 用),任何人都能讀
create policy merchant_logos_public_read
  on storage.objects
  for select
  using (bucket_id = 'merchant-logos');

-- 只有該商家的管理員可以上傳/更換/刪除自己商家的 LOGO
create policy merchant_logos_admin_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'merchant-logos'
    and public.is_merchant_admin(public.storage_path_merchant_id(name))
  );

create policy merchant_logos_admin_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'merchant-logos'
    and public.is_merchant_admin(public.storage_path_merchant_id(name))
  )
  with check (
    bucket_id = 'merchant-logos'
    and public.is_merchant_admin(public.storage_path_merchant_id(name))
  );

create policy merchant_logos_admin_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'merchant-logos'
    and public.is_merchant_admin(public.storage_path_merchant_id(name))
  );
