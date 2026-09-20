-- 模組 14:服務人員端(功能層,第九支)。
-- 對應規格書 3.16(update_my_staff_profile)、3.20(頭像自助上傳 Storage 政策)。
--
-- 動工前已用 execute_sql 查詢正式環境 public.storage_path_merchant_id 的既有實作方式
-- ((storage.foldername(p_path))[1]::uuid,exception 吞掉轉型失敗回傳 null),3.20 的
-- storage_path_self_staff_id 沿用同樣手法,只是改抓第三段路徑。

-- =========================================================================
-- 3.16 update_my_staff_profile:只接受六個參數並只更新這六個欄位,函式簽章本身就不接受
-- is_listed/11 個權限開關/compensation_type/status/merchant_id/user_id 這些欄位的參數
-- (規則 2.7,從介面設計上直接排除誤用的可能性)。規則 2.8:編輯需要 staff_profile_edit 權限。
-- =========================================================================
create or replace function public.update_my_staff_profile(
  p_staff_id uuid,
  p_name text,
  p_nickname text,
  p_phone text,
  p_contact_email text,
  p_avatar_url text,
  p_intro text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限編輯這位服務人員的資料' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_profile_edit') then
    raise exception '尚未開通個人資料編輯功能,請洽商家管理員' using errcode = '42501';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception '姓名不可為空白';
  end if;

  update public.merchant_staff
  set name = trim(p_name),
      nickname = nullif(trim(coalesce(p_nickname, '')), ''),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      contact_email = nullif(trim(coalesce(p_contact_email, '')), ''),
      avatar_url = p_avatar_url,
      intro = nullif(trim(coalesce(p_intro, '')), '')
  where id = p_staff_id;
end;
$$;

comment on function public.update_my_staff_profile(uuid, text, text, text, text, text, text) is '對應規格書 3.16/規則 2.7/2.8:服務人員自助編輯個人資料,只接受並只更新 name/nickname/phone/contact_email/avatar_url/intro 六個欄位,函式簽章本身不暴露其他任何欄位的參數。需要 is_own_staff_row(本人)且已開通 staff_profile_edit 權限。';

revoke execute on function public.update_my_staff_profile(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_my_staff_profile(uuid, text, text, text, text, text, text) to authenticated;

-- =========================================================================
-- 3.20 頭像自助上傳 Storage 政策(對應判斷 8)。
-- 路徑慣例:<merchant_id>/self/<staff_id>/<檔名>,跟既有管理員路徑 <merchant_id>/<檔名> 分開,
-- 避免同商家服務人員互相覆蓋/刪除彼此頭像。既有 staff_avatars_admin_insert/update/delete、
-- staff_avatars_public_read 完全不動。
-- =========================================================================
create or replace function public.storage_path_self_staff_id(p_object_name text)
returns uuid
language plpgsql
immutable
set search_path = public
as $$
begin
  return (storage.foldername(p_object_name))[3]::uuid;
exception
  when others then
    return null;
end;
$$;

comment on function public.storage_path_self_staff_id(text) is '對應規格書 3.20:解析 <merchant_id>/self/<staff_id>/<檔名> 這個路徑慣例的第三段,回傳 staff_id。沿用既有 public.storage_path_merchant_id 的路徑切割手法(storage.foldername 取陣列元素,轉型失敗一律回傳 null,不拋錯)。';

-- 安全邊界:只有本人(is_own_staff_row 為真)且「路徑裡宣稱的 staff_id」確實屬於「路徑裡宣稱的
-- merchant_id」底下(避免有人把自己的 staff_id 塞進別間商家的路徑裡誤導比對),才能寫入/更新/
-- 刪除 self/<staff_id>/ 路徑底下的檔案。第二層路徑段必須是 'self' 字面值,天然就跟既有管理員
-- 路徑 <merchant_id>/<檔名>(只有一層)區隔開來——is_own_staff_row(null) 一律回傳 false,
-- 不會誤放行非 self 路徑。
--
-- 實測踩過的坑(已修正,寫下來避免之後改這段程式碼的人重踩):下面 EXISTS 子查詢裡故意寫
-- storage.objects.name 完整限定名稱,不能只寫裸的 name——merchant_staff 這張表自己也有一個
-- name 欄位(服務人員姓名),裸寫 name 在這個子查詢的作用域裡會被 PostgreSQL 解析成 ms.name
-- (服務人員姓名文字),不是外層 storage.objects 正在寫入的檔案路徑,導致
-- storage_path_self_staff_id/storage_path_merchant_id 吃到錯的字串、永遠解析失敗、政策永遠
-- 擋下——一開始寫成裸 name 時,pgTAP 測試直接抓到「本人上傳自己的頭像也被拒絕」這個回歸,
-- 改成完整限定名稱後重新驗證通過。
create policy staff_avatars_self_insert
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[2] = 'self'
    and private.is_own_staff_row(public.storage_path_self_staff_id(name))
    and exists (
      select 1 from public.merchant_staff ms
      where ms.id = public.storage_path_self_staff_id(storage.objects.name)
        and ms.merchant_id = public.storage_path_merchant_id(storage.objects.name)
    )
  );

create policy staff_avatars_self_update
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[2] = 'self'
    and private.is_own_staff_row(public.storage_path_self_staff_id(name))
    and exists (
      select 1 from public.merchant_staff ms
      where ms.id = public.storage_path_self_staff_id(storage.objects.name)
        and ms.merchant_id = public.storage_path_merchant_id(storage.objects.name)
    )
  )
  with check (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[2] = 'self'
    and private.is_own_staff_row(public.storage_path_self_staff_id(name))
    and exists (
      select 1 from public.merchant_staff ms
      where ms.id = public.storage_path_self_staff_id(storage.objects.name)
        and ms.merchant_id = public.storage_path_merchant_id(storage.objects.name)
    )
  );

create policy staff_avatars_self_delete
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[2] = 'self'
    and private.is_own_staff_row(public.storage_path_self_staff_id(name))
    and exists (
      select 1 from public.merchant_staff ms
      where ms.id = public.storage_path_self_staff_id(storage.objects.name)
        and ms.merchant_id = public.storage_path_merchant_id(storage.objects.name)
    )
  );
