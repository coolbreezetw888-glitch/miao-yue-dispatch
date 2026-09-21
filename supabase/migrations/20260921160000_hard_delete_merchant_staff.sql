-- 對應規格書 .project/specs/服務人員管理優化與硬刪除.md 第三節(需求 1):
-- 服務人員「真正刪除」(硬刪除)功能 §3.3。
--
-- 動手前已用 pg_get_constraintdef 重新查證正式環境(wjtbmmnakcriuaqoknsq)目前 bookings/
-- booking_assistants/staff_leave_records/booking_commission_records 這四張表指向
-- merchant_staff.id 的外鍵定義,結果跟規格書 §3.2 完全一致:
--   - bookings.staff_id          → FOREIGN KEY (staff_id) REFERENCES merchant_staff(id)               (無 on delete,NO ACTION,資料庫本身會擋)
--   - booking_assistants.staff_id→ FOREIGN KEY (staff_id) REFERENCES merchant_staff(id)               (無 on delete,NO ACTION,資料庫本身會擋)
--   - staff_leave_records.staff_id      → ... ON DELETE CASCADE   (資料庫本身不會擋,會悄悄砍掉請假紀錄——本函式是唯一防線)
--   - booking_commission_records.staff_id → ... ON DELETE SET NULL(資料庫本身不會擋,會悄悄把財務快照的服務人員欄位清空——本函式是唯一防線)
-- 因此 §3.3 第 4 步對這四張表的檢查,尤其是 staff_leave_records/booking_commission_records
-- 兩張,是應用層的唯一防線,不能省略。
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

  -- 全部通過(四項筆數皆為 0)才真的執行 DELETE——讓既有的 on delete cascade 外鍵自動清掉
  -- merchant_staff_service_items/staff_availability_windows/staff_availability_overrides/
  -- merchant_staff_permissions/staff_commission_rates/staff_salary_settings 六張純設定表的
  -- 關聯資料,這裡不需要手動一張一張 delete。完全不動 auth.users(merchant_staff.user_id 是
  -- references auth.users(id) on delete set null,方向是 auth.users 被刪才影響 merchant_staff,
  -- 不是反過來——硬刪除這一列本來就不會、也不應該去動 auth.users)。
  delete from public.merchant_staff where id = p_staff_id;
end;
$$;

comment on function public.hard_delete_merchant_staff(uuid) is '對應規格書「服務人員管理優化與硬刪除」§3.3:只能對 status=removed 的服務人員操作,且 bookings/booking_assistants/staff_leave_records/booking_commission_records 四張歷史事實表只要有任何一筆牽連就整個擋下(不做部分刪除/匿名化)。通過檢查後執行 DELETE,讓既有的 on delete cascade 外鍵自動清掉純設定表的關聯資料。完全不動 auth.users,同一信箱之後可以被重新邀請使用。';

revoke all on function public.hard_delete_merchant_staff(uuid) from public, anon;
grant execute on function public.hard_delete_merchant_staff(uuid) to authenticated;
