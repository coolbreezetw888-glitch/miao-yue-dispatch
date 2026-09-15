-- 模組 2:超級管理員/平台管理後台(核心層)
-- 對應規格書功能 3.3(get_merchant_admin_users 放寬)、3.4(platform_add_merchant_admin)、
-- 3.5(platform_remove_merchant_admin，含規則 2.4 防呆)、3.6(platform_set_group_admin，含規則 2.5 防呆)。
--
-- 分工界線見規則 2.3：這三個函式是超級管理員「代替商家做調整/問題排除」的操作介面，
-- 跟模組 3(商家管理員自己管自己店)完全不共用寫入路徑，只是都寫同一張 merchant_admins 表。

-- =========================================================================
-- 3.3 get_merchant_admin_users 放寬檢查條件：
-- is_merchant_admin(p_merchant_id) OR is_platform_admin()。
-- CREATE OR REPLACE，簽章不變，既有的 grant/revoke 設定維持不變（module 1 的
-- 20260915110000 migration 已註記 CREATE OR REPLACE 不會重置權限）。
-- =========================================================================
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
  if not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin()) then
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

comment on function public.get_merchant_admin_users(uuid) is '對應規格書 3.3/4.3/5.4:回傳指定商家的管理員清單+email，呼叫者必須是該商家管理員或平台管理員。';

-- =========================================================================
-- 3.4 platform_add_merchant_admin：超級管理員代替商家，把已註冊帳號的人加成某間店的管理員。
-- 不做「邀請還沒註冊過的人」這種寄信邀請功能，查無 email 對應帳號要回傳清楚錯誤，不能靜默失敗。
-- =========================================================================
create or replace function public.platform_add_merchant_admin(
  p_merchant_id uuid,
  p_user_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  if not exists (select 1 from public.merchants where id = p_merchant_id) then
    raise exception '找不到指定的商家: %', p_merchant_id;
  end if;

  -- email 比對時 trim + lower，避免大小寫或前後空白差異造成「明明有帳號卻查不到」的誤判。
  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_user_email));

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
  end if;

  if exists (
    select 1 from public.merchant_admins
    where merchant_id = p_merchant_id and user_id = v_user_id
  ) then
    raise exception '這個人已經是管理員了' using errcode = 'P0001';
  end if;

  insert into public.merchant_admins (merchant_id, user_id)
  values (p_merchant_id, v_user_id);
end;
$$;

comment on function public.platform_add_merchant_admin(uuid, text) is '對應規格書 3.4:超級管理員代替商家新增管理員，呼叫者必須通過 is_platform_admin 檢查；查無此 email 對應帳號或已是管理員時回傳明確錯誤。';

revoke execute on function public.platform_add_merchant_admin(uuid, text) from public, anon;
grant execute on function public.platform_add_merchant_admin(uuid, text) to authenticated;

-- =========================================================================
-- 3.5 platform_remove_merchant_admin：對應規則 2.4，不能把一間店的管理員移除到完全沒人能管。
-- 判斷邏輯:移除這筆後，若該商家 merchant_admins 會變成 0 筆，且該商家所屬集團也沒有設定
-- group_admin_user_id，就擋下操作。
-- =========================================================================
create or replace function public.platform_remove_merchant_admin(
  p_merchant_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group_admin_user_id uuid;
  v_remaining_count integer;
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  select g.group_admin_user_id into v_group_admin_user_id
  from public.merchants m
  join public.groups g on g.id = m.group_id
  where m.id = p_merchant_id;

  if not found then
    raise exception '找不到指定的商家: %', p_merchant_id;
  end if;

  if v_group_admin_user_id is null then
    select count(*) into v_remaining_count
    from public.merchant_admins
    where merchant_id = p_merchant_id
      and user_id <> p_user_id;

    if v_remaining_count = 0 then
      raise exception '移除後這間店會沒有任何人能登入管理，請先新增其他管理員' using errcode = 'P0001';
    end if;
  end if;

  delete from public.merchant_admins
  where merchant_id = p_merchant_id and user_id = p_user_id;
end;
$$;

comment on function public.platform_remove_merchant_admin(uuid, uuid) is '對應規格書 3.5/規則 2.4:超級管理員代替商家移除管理員，若移除後該商家會變成無人可管(且集團也沒有集團管理者)則擋下並提示。';

revoke execute on function public.platform_remove_merchant_admin(uuid, uuid) from public, anon;
grant execute on function public.platform_remove_merchant_admin(uuid, uuid) to authenticated;

-- =========================================================================
-- 3.6 platform_set_group_admin：超級管理員代替集團，指定或清空集團管理者。
-- p_user_email 為 null 時走規則 2.5 的清空防呆檢查：若清空後集團底下有任何商家的
-- merchant_admins 也是 0 筆，一樣擋下並提示。
-- =========================================================================
create or replace function public.platform_set_group_admin(
  p_group_id uuid,
  p_user_email text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_orphan_merchant_count integer;
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作，僅限平台管理員使用' using errcode = '42501';
  end if;

  if not exists (select 1 from public.groups where id = p_group_id) then
    raise exception '找不到指定的集團: %', p_group_id;
  end if;

  if p_user_email is null then
    select count(*) into v_orphan_merchant_count
    from public.merchants m
    where m.group_id = p_group_id
      and not exists (
        select 1 from public.merchant_admins ma where ma.merchant_id = m.id
      );

    if v_orphan_merchant_count > 0 then
      raise exception '清空集團管理者後，集團底下會有商家沒有任何人能登入管理，請先為這些商家新增管理員' using errcode = 'P0001';
    end if;

    update public.groups set group_admin_user_id = null where id = p_group_id;
    return;
  end if;

  select id into v_user_id
  from auth.users
  where lower(email) = lower(trim(p_user_email));

  if v_user_id is null then
    raise exception '找不到這個 email 對應的使用者，請確認對方已經註冊過秒約帳號' using errcode = 'P0002';
  end if;

  update public.groups set group_admin_user_id = v_user_id where id = p_group_id;
end;
$$;

comment on function public.platform_set_group_admin(uuid, text) is '對應規格書 3.6/規則 2.5:超級管理員代替集團指定或清空集團管理者。清空時若會導致集團底下有商家無人可管則擋下；設定時查無 email 對應帳號要回傳明確錯誤。';

revoke execute on function public.platform_set_group_admin(uuid, text) from public, anon;
grant execute on function public.platform_set_group_admin(uuid, text) to authenticated;
