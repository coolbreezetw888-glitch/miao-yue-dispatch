-- SPECS-INDEX 編號 320/324/337/343/347(規格書 .project/specs/會員與紅利.md §2.10、§3.3、§3.16、§4.4、§5)。
--
-- 背景:品管以真實瀏覽器 + API 雙重確認,用「只有 orders 權限、沒有 members 權限」的客服身份
-- 複驗建單頁疊加的「選擇會員」欄位(§4.4 MemberPickerField)時發現:搜尋既有會員永遠查無
-- 結果,點下「找不到?建立新會員」快速建立也會失敗並顯示「沒有權限管理這間商家的會員」。
-- 違反規格書 §2.10 明文規定:「建單頁疊加的『選擇會員』欄位歸在既有的 orders 權限底下,不需要
-- 額外檢查 members 權限……沒有 members 權限的客服一樣能在建單時選擇/快速建立會員」。
--
-- 根因:主腦已直接查詢正式環境確認(pg_policy / pg_get_functiondef,與
-- 20260920140100_members_core_functions.sql 目前套用的版本完全一致,沒有 drift),兩處權限檢查
-- 都只認 private.can_manage_members,沒有比照規格書 §2.10 放行 private.can_manage_bookings:
--   1. members 表的 SELECT RLS 政策(members_select)。
--   2. create_member 函式開頭的權限檢查。
-- 只修 SELECT 政策的話,搜尋會員能看到,但快速建立新會員還是會被 create_member 擋下,兩處都要修。
--
-- 修法:比照這個 codebase 已經三次使用過的先例(20260919140000_booking_related_tables_select_
-- policy_orders_fix.sql / 20260920110000_merchant_staff_select_policy_team_leave_fix.sql /
-- 20260920130000_merchant_staff_select_policy_payroll_fix.sql),用「drop policy if exists 後
-- create policy 重建」的既有寫法,在 members_select 的 using 條件裡加一個
-- `or private.can_manage_bookings(merchant_id)`;create_member 用 create or replace(簽章不變),
-- 只改權限檢查那一段 if。
--
-- 範圍刻意限縮:規格書 §2.10 只點名「選擇會員」「快速建立會員」這兩個建單時會用到的動作要放行
-- orders 權限,沒有說「編輯會員」「下架會員」等管理性質操作也要放行——update_member/
-- deactivate_member/reactivate_member/set_member_phone_verified/adjust_member_points 這幾支函式
-- 維持原樣,只檢查 can_manage_members(adjust_member_points 維持只檢查 is_merchant_admin,規則
-- 2.6),完全不動,避免超出這次修正範圍、不小心放寬管理性質操作。member_point_transactions_select
-- 政策(§3.16,點數歷史查詢)也不動——§2.10 沒有要求 orders 權限能看點數歷史,建單頁只需要
-- 選擇/建立會員,不需要看點數交易紀錄。

drop policy if exists members_select on public.members;

create policy members_select on public.members
  for select to authenticated
  using (
    private.can_manage_members(merchant_id)
    or private.can_manage_bookings(merchant_id)
  );

comment on policy members_select on public.members is '模組 10 §3.16(SPECS-INDEX #337 回歸修正):除了 can_manage_members,額外放行 can_manage_bookings——比照規格書 §2.10,建單頁疊加的「選擇會員」欄位歸在既有的 orders 權限底下,沒有 members 權限的客服一樣要能搜尋到既有會員。';

create or replace function public.create_member(
  p_merchant_id uuid,
  p_name text,
  p_phone text default null,
  p_email text default null,
  p_birthday date default null,
  p_notes text default null,
  p_referred_by_member_id uuid default null
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_required boolean;
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

  select phone_required_to_create into v_phone_required
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    v_phone_required := true;
  end if;

  if v_phone_required and (p_phone is null or btrim(p_phone) = '') then
    raise exception '這個商家要求建立會員時必須填寫電話';
  end if;

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

  loop
    v_referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.members (
        merchant_id, name, phone, email, birthday, notes,
        referred_by_member_id, referral_code, created_by_user_id
      ) values (
        p_merchant_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_email, '')), ''), p_birthday, p_notes,
        p_referred_by_member_id, v_referral_code, auth.uid()
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

comment on function public.create_member(uuid, text, text, text, date, text, uuid) is '模組 10 §3.3(SPECS-INDEX #324 回歸修正):建立會員。權限檢查除了 can_manage_members,額外放行 can_manage_bookings——比照規格書 §2.10,建單頁「找不到?建立新會員」快速建立入口歸在既有的 orders 權限底下。其餘邏輯(電話必填政策、推薦人驗證、referral_code 產生)完全不變。';

revoke execute on function public.create_member(uuid, text, text, text, date, text, uuid) from public, anon;
grant execute on function public.create_member(uuid, text, text, text, date, text, uuid) to authenticated;
