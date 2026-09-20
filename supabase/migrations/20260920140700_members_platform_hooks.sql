-- 模組 10:會員與紅利 — platform_export_merchant_members_snapshot / platform_purge_merchant_members_and_points
-- (第八支)。對應規格書 §3.17/§3.18、規則 2.9。這次只建函式本體,不建對應 UI,也不是本模組
-- 4.x 節任何頁面的一部分,純粹是給模組 2(超級管理員後台)之後「清空本商家所有訂單、會員紅利」
-- 功能直接複用的建構塊。

-- =========================================================================
-- 3.17:platform_export_merchant_members_snapshot。允許商家管理員自己也能匯出備份,不限於
-- 平台管理員(比照模組 2 platform_add_merchant_admin 的既有慣例:內部檢查身份,不是靠角色層級
-- 的 grant/revoke 限制)。
-- =========================================================================
create or replace function public.platform_export_merchant_members_snapshot(p_merchant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_members jsonb;
  v_transactions jsonb;
begin
  if not (private.is_platform_admin() or private.is_merchant_admin(p_merchant_id)) then
    raise exception '沒有權限匯出這間商家的會員資料' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) into v_members
  from public.members m
  where m.merchant_id = p_merchant_id;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into v_transactions
  from public.member_point_transactions t
  where t.merchant_id = p_merchant_id;

  return jsonb_build_object('members', v_members, 'member_point_transactions', v_transactions);
end;
$$;

comment on function public.platform_export_merchant_members_snapshot(uuid) is '模組 10 §3.17(規則 2.9,模組 2 掛鉤點):回傳該商家完整的 members + member_point_transactions JSON,供模組 2 執行清空前自動備份下載使用。平台管理員或該商家自己的管理員都能呼叫,一般客服被擋下。這次沒有任何 UI 使用,純粹是給模組 2 之後串接用的建構塊。';

revoke execute on function public.platform_export_merchant_members_snapshot(uuid) from public, anon;
grant execute on function public.platform_export_merchant_members_snapshot(uuid) to authenticated;

-- =========================================================================
-- 3.18:platform_purge_merchant_members_and_points。只接受平台管理員,不接受商家管理員
-- (真正不可逆的硬刪除,避免商家自己不小心點到就整個清空)。
-- =========================================================================
create or replace function public.platform_purge_merchant_members_and_points(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.is_platform_admin() then
    raise exception '沒有權限執行此操作,僅限平台管理員使用' using errcode = '42501';
  end if;

  delete from public.member_point_transactions where merchant_id = p_merchant_id;
  delete from public.members where merchant_id = p_merchant_id;
end;
$$;

comment on function public.platform_purge_merchant_members_and_points(uuid) is '模組 10 §3.18(規則 2.9,模組 2 掛鉤點,危險操作):硬刪除該商家的 members/member_point_transactions。bookings.member_id/member_name_snapshot 因為 on delete set null 會自動變成 null,不會刪除訂單本身。只有 private.is_platform_admin() 通過才能呼叫,商家管理員/客服皆被擋下。這次沒有任何 UI 使用,純粹是給模組 2 之後串接用的建構塊。';

revoke execute on function public.platform_purge_merchant_members_and_points(uuid) from public, anon;
grant execute on function public.platform_purge_merchant_members_and_points(uuid) to authenticated;
