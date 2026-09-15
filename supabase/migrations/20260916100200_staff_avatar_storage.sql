-- 模組 3:人員與權限管理
-- 對應規格書 4.2 邊界情況(服務人員頭像上傳,沿用模組 1 LogoUploader 的上傳邏輯改寫)。
-- 上傳路徑慣例比照模組 1 merchant-logos:<merchant_id>/<檔名>,重用模組 1 已經建好的
-- public.storage_path_merchant_id() 解析函式,不重新發明一套。
-- 格式/大小限制沿用模組 1 規則 2.6 同樣的標準(png/jpg/webp、單檔 2MB)。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-avatars',
  'staff-avatars',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 公開讀取(顯示頭像用),任何人都能讀。
create policy staff_avatars_public_read
  on storage.objects
  for select
  using (bucket_id = 'staff-avatars');

-- 只有該商家的管理員可以上傳/更換/刪除自己商家底下服務人員的頭像。
create policy staff_avatars_admin_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'staff-avatars'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

create policy staff_avatars_admin_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'staff-avatars'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  )
  with check (
    bucket_id = 'staff-avatars'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

create policy staff_avatars_admin_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'staff-avatars'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );
