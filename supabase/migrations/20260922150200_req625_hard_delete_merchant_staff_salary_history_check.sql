-- 模組 8(薪資與帳務)規格書 §十一 11.4(SPECS-INDEX #625,核心,補強既有安全邊界):
-- hard_delete_merchant_staff(.project/specs/服務人員管理優化與硬刪除.md §3.3)目前檢查
-- bookings/booking_assistants/staff_leave_records/booking_commission_records 四張歷史事實表,
-- 這次新增第五項檢查:staff_payroll_status_history 裡如果存在任何一筆 monthly_base_salary > 0
-- 的紀錄,一併擋下真正刪除——否則 staff_payroll_status_history 是 on delete cascade 掛在
-- merchant_staff.id 底下,真的執行硬刪除會連帶砍掉這筆歷史紀錄,讓已經產生過的過去月份報表
-- (get_merchant_billing_summary 的 total_monthly_salary_base,11.8)重新整理後金額悄悄變少。
--
-- ⚠️ 動工前已用 pg_get_functiondef 直接查證正式環境(wjtbmmnakcriuaqoknsq)目前
-- hard_delete_merchant_staff 的完整最新版本,結果跟本機 migration 20260921160000 完全一致,
-- 無漂移,在這個版本的基礎上疊加第五項檢查,不是從舊版本重建。

create or replace function public.hard_delete_merchant_staff(p_staff_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_name text;
  v_booking_count int;
  v_assistant_count int;
  v_leave_count int;
  v_commission_count int;
  v_paid_salary_history_count int;
begin
  select merchant_id, status, name into v_merchant_id, v_status, v_name
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到指定的服務人員紀錄' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'removed' then
    raise exception '只能對已經移除的服務人員執行真正刪除,請先移除這位服務人員(軟刪除),確認不再需要之後再進行真正刪除。' using errcode = 'P0001';
  end if;

  select count(*) into v_booking_count from public.bookings where staff_id = p_staff_id;
  select count(*) into v_assistant_count from public.booking_assistants where staff_id = p_staff_id;
  select count(*) into v_leave_count from public.staff_leave_records where staff_id = p_staff_id;
  select count(*) into v_commission_count from public.booking_commission_records where staff_id = p_staff_id;

  if (v_booking_count + v_assistant_count + v_leave_count + v_commission_count) > 0 then
    raise exception '這位服務人員「%」有歷史紀錄牽連(訂單 %筆、助手身份訂單 %筆、請假紀錄 %筆、抽成紀錄 %筆),為了保留歷史帳務與訂單資料,無法真正刪除,只能維持「已移除」狀態。',
      v_name, v_booking_count, v_assistant_count, v_leave_count, v_commission_count
      using errcode = 'P0001';
  end if;

  -- 模組 8 §11.4(核心,第五項檢查):曾經領過非 0 月薪的人,即使四項既有檢查都是 0(從未接過
  -- 訂單/請過假),也不能真正刪除——staff_payroll_status_history 是 on delete cascade,真的刪除
  -- 會連帶砍掉過去月份帳務報表依賴的歷史金額紀錄。
  select count(*) into v_paid_salary_history_count
  from public.staff_payroll_status_history
  where staff_id = p_staff_id and monthly_base_salary > 0;

  if v_paid_salary_history_count > 0 then
    raise exception '這位服務人員過去有實際發生過的月薪紀錄(曾經是有薪資的月薪制員工),為了保留歷史帳務報表的正確性,無法真正刪除,只能維持「已移除」狀態。'
      using errcode = 'P0001';
  end if;

  -- 全部通過(四項既有筆數 + 第五項薪資歷史檢查皆為 0)才真的執行 DELETE——讓既有的
  -- on delete cascade 外鍵自動清掉 merchant_staff_service_items/staff_availability_windows/
  -- staff_availability_overrides/merchant_staff_permissions/staff_service_commission_rates/
  -- staff_salary_settings/staff_payroll_status_history 七張純設定/歷史表的關聯資料,這裡不需要
  -- 手動一張一張 delete。完全不動 auth.users(merchant_staff.user_id 是
  -- references auth.users(id) on delete set null,方向是 auth.users 被刪才影響 merchant_staff,
  -- 不是反過來——硬刪除這一列本來就不會、也不應該去動 auth.users)。
  delete from public.merchant_staff where id = p_staff_id;
end;
$$;

comment on function public.hard_delete_merchant_staff(uuid) is '對應規格書「服務人員管理優化與硬刪除」§3.3 + 模組 8 §11.4:只能對 status=removed 的服務人員操作,且 bookings/booking_assistants/staff_leave_records/booking_commission_records 四張歷史事實表只要有任何一筆牽連就整個擋下(不做部分刪除/匿名化)。§11.4 新增第五項檢查:staff_payroll_status_history 裡如果存在任何一筆 monthly_base_salary > 0 的紀錄,同樣擋下(保留歷史帳務報表正確性)。通過所有檢查後執行 DELETE,讓既有的 on delete cascade 外鍵自動清掉純設定/歷史表的關聯資料。完全不動 auth.users,同一信箱之後可以被重新邀請使用。';

revoke all on function public.hard_delete_merchant_staff(uuid) from public, anon;
grant execute on function public.hard_delete_merchant_staff(uuid) to authenticated;
