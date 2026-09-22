-- SPECS-INDEX #615/#618(規格書 .project/specs/會員與紅利.md §10.3/§10.6)。
-- create_member/update_member 疊加:
--   1. 移除電話必填檢查(phone_required_to_create 欄位已在上一支 migration 移除)。
--   2. 新增 p_tier_id 參數(#615 會員分級,指派等級)。
--
-- ⚠️ 動工前已查證目前套用的最新版本在 20260920150000_members_select_and_create_member_orders_fix.sql
-- (SPECS-INDEX #324 回歸修正:權限檢查同時放行 private.can_manage_bookings,讓建單頁「找不到?
-- 建立新會員」快速建立入口不需要 members 權限也能用)。以下逐字保留這個版本的邏輯,只移除電話必填
-- 檢查、新增 p_tier_id 參數(加在參數清單最後面,預設 null,舊呼叫端不受影響)。
--
-- 新增參數會讓函式的完整參數型別列表變長,一律先 drop function if exists(完整列出舊的參數型別
-- 清單)再重新 create,不能只用 create or replace(這個 codebase 反覆踩過的坑,見
-- 20260919130100_payment_methods_v2_functions.sql 開頭警語)。

drop function if exists public.create_member(uuid, text, text, text, date, text, uuid);

create function public.create_member(
  p_merchant_id uuid,
  p_name text,
  p_phone text default null,
  p_email text default null,
  p_birthday date default null,
  p_notes text default null,
  p_referred_by_member_id uuid default null,
  p_tier_id uuid default null
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral_code text;
  v_attempt int := 0;
  v_result public.members;
begin
  if not (private.can_manage_members(p_merchant_id) or private.can_manage_bookings(p_merchant_id)) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除(電話這次只當查詢索引,不是必填欄位,見 #614/§10.2)。

  if p_referred_by_member_id is not null then
    if not exists (
      select 1 from public.members
      where id = p_referred_by_member_id
        and merchant_id = p_merchant_id
        and status = 'active'
    ) then
      raise exception '找不到指定的推薦人,或推薦人不屬於這間商家/已被下架';
    end if;
  end if;

  -- #615:會員分級。有指定 p_tier_id 時,必須屬於同一商家且 status='active'。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = p_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級,或不屬於這間商家/已下架';
    end if;
  end if;

  loop
    v_referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.members (
        merchant_id, name, phone, email, birthday, notes,
        referred_by_member_id, referral_code, created_by_user_id, tier_id
      ) values (
        p_merchant_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_email, '')), ''), p_birthday, p_notes,
        p_referred_by_member_id, v_referral_code, auth.uid(), p_tier_id
      )
      returning * into v_result;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise exception '產生推薦碼失敗,請重新再試一次';
      end if;
    end;
  end loop;

  return v_result;
end;
$$;

comment on function public.create_member(uuid, text, text, text, date, text, uuid, uuid) is '模組 10 §3.3(SPECS-INDEX #615/#618 疊加):建立會員。權限檢查同時放行 can_manage_bookings(建單頁快速建立入口,#324 既有修正)。#618 移除電話必填檢查(電話不再是必填欄位)。#615 新增 p_tier_id(選填,指派會員等級,須屬於同商家且未下架)。推薦人驗證/referral_code 產生邏輯不變。';

revoke execute on function public.create_member(uuid, text, text, text, date, text, uuid, uuid) from public, anon;
grant execute on function public.create_member(uuid, text, text, text, date, text, uuid, uuid) to authenticated;

-- =========================================================================
-- update_member:同樣移除電話必填檢查,新增 p_tier_id 參數。不允許修改 referred_by_member_id
-- (既有規則,推薦關係只在建立當下決定)。
-- =========================================================================
drop function if exists public.update_member(uuid, text, text, text, date, text);

create function public.update_member(
  p_member_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_birthday date,
  p_notes text,
  p_tier_id uuid default null
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

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除。

  -- #615:會員分級,同 create_member 的驗證邏輯。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = v_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級,或不屬於這間商家/已下架';
    end if;
  end if;

  update public.members set
    name = btrim(p_name),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    birthday = p_birthday,
    notes = p_notes,
    tier_id = p_tier_id
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_member(uuid, text, text, text, date, text, uuid) is '模組 10 §3.4(SPECS-INDEX #615/#618 疊加):編輯會員基本資料。#618 移除電話必填檢查。#615 新增 p_tier_id(選填,重新指派會員等級,傳 null 代表清空成未分級)。不接受修改 referred_by_member_id(既有規則不變)。權限維持只檢查 can_manage_members(#324 那支回歸修正只放寬 create_member/members_select,update_member 這種管理性質操作不受影響,見 20260920150000 檔頭說明)。';

revoke execute on function public.update_member(uuid, text, text, text, date, text, uuid) from public, anon;
grant execute on function public.update_member(uuid, text, text, text, date, text, uuid) to authenticated;
