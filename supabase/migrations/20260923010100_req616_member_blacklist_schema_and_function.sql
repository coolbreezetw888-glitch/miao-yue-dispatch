-- SPECS-INDEX #616(規格書 .project/specs/會員與紅利.md §10.4)。
-- 會員黑名單:新增黑名單狀態+自訂原因欄位。建單頁面選定黑名單客戶「當下」立即跳警告,純警告
-- 不擋單;黑名單狀態不顯示給客戶端;行銷通知可把黑名單客戶當排除清單使用(該部分由 LINE通知.md
-- §10.2 另外負責,這裡只建資料結構+設定狀態的函式)。

-- =========================================================================
-- members 表擴充:is_blacklisted / blacklist_reason / blacklisted_at / blacklisted_by_user_id。
-- =========================================================================
alter table public.members
  add column is_blacklisted boolean not null default false,
  add column blacklist_reason text,
  add column blacklisted_at timestamptz,
  add column blacklisted_by_user_id uuid references auth.users(id) on delete set null;

comment on column public.members.is_blacklisted is '模組 10 §10.4(SPECS-INDEX #616):黑名單狀態,純警告用途,不擋建單。這個狀態只在商家/客服後台可見,客戶端(未來模組 13)完全不會顯示。';
comment on column public.members.blacklist_reason is '列入黑名單時商家自訂輸入的原因(必填,函式層檢查),不做固定選項清單。解除黑名單時清空。';
comment on column public.members.blacklisted_at is '列入黑名單的時間,解除黑名單時清空。';
comment on column public.members.blacklisted_by_user_id is '執行列入黑名單操作的使用者,解除黑名單時清空。';

create index members_merchant_id_is_blacklisted_idx
  on public.members (merchant_id, is_blacklisted) where is_blacklisted = true;

-- =========================================================================
-- set_member_blacklist_status:SECURITY DEFINER,檢查 private.can_manage_members(規則 2.10 既有
-- 精神,這不是最高權限敏感操作,不像 adjust_member_points 限定管理員)。
-- =========================================================================
create or replace function public.set_member_blacklist_status(
  p_member_id uuid,
  p_is_blacklisted boolean,
  p_reason text default null
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result public.members;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if coalesce(p_is_blacklisted, false) then
    if p_reason is null or btrim(p_reason) = '' then
      raise exception '請輸入列入黑名單的原因';
    end if;

    update public.members set
      is_blacklisted = true,
      blacklist_reason = btrim(p_reason),
      blacklisted_at = now(),
      blacklisted_by_user_id = auth.uid()
    where id = p_member_id
    returning * into v_result;
  else
    update public.members set
      is_blacklisted = false,
      blacklist_reason = null,
      blacklisted_at = null,
      blacklisted_by_user_id = null
    where id = p_member_id
    returning * into v_result;
  end if;

  return v_result;
end;
$$;

comment on function public.set_member_blacklist_status(uuid, boolean, text) is '模組 10 §10.4(SPECS-INDEX #616):列入/解除黑名單。列入時 p_reason 必填(函式層檢查,不是資料庫 NOT NULL),解除時一併清空 blacklist_reason/blacklisted_at/blacklisted_by_user_id。權限比照本模組一般操作(private.can_manage_members),不是最高權限敏感操作。';

revoke execute on function public.set_member_blacklist_status(uuid, boolean, text) from public, anon;
grant execute on function public.set_member_blacklist_status(uuid, boolean, text) to authenticated;
