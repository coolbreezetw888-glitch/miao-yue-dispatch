-- SPECS-INDEX #873(規格書 .project/specs/副服務人員移除修正.md)。
-- 「移除副服務人員(協助人員)不該連主服務人員的訂單一起取消」+ 反方向「主服務人員被移除時,協助卡不可殘留」。
--
-- =========================================================================
-- 【成因(查證結果)】
--   行事曆上同一筆 bookings 會畫成兩張色塊(主 + 「(協助)」),兩張色塊點下去都只把 booking id 交給
--   預約詳情(BookingDetailDialog),詳情底部只有「取消預約」⇒ 呼叫 public.cancel_booking(p_booking_id)
--   ⇒ 整張單 status='cancelled'(主服務人員的單一起不見,前端還會發 booking_cancelled 的 LINE / 推播)。
--   系統原本**沒有**「只移除一位協助人員」的窄介面(只能進編輯表單整批重寫 update_booking)。
--
-- 【這支 migration 做兩件事】
--   ① 新增 public.remove_booking_assistant(p_booking_id, p_staff_id):
--      只 delete 一筆 booking_assistants,bookings 那一列完全不動(狀態 / 時間 / 金額 / 紅利 / 最後修改都不動)。
--      權限與狀態檢查的順序照 move_booking / update_booking:讀訂單 → can_manage_bookings → 狀態。
--      只允許 pending_confirmation / accepted(已完成的單協助人員牽涉抽成紀錄,已取消的單沒有意義)。
--      不呼叫任何通知函式(訂單沒取消,不能發「訂單取消」)。被移除那位的服務人員端行事曆,
--      由既有的 #874 trigger(booking_assistants_notify_staff_schedule,AFTER DELETE)發「請重查」訊號。
--   ② 主服務人員被移除(merchant_staff.status: active → removed)時,把「他當主服務人員、而且還沒結束
--      (pending_confirmation / accepted)」的訂單上的協助人員一併刪掉,行事曆 / 服務人員端都不再殘留「(協助)」。
--      - 已完成 / 已取消的單**不動**(歷史事實、抽成紀錄;已取消的單本來就不會出現在任何行事曆)。
--      - 訂單被取消(cancel_booking)不需要另外處理:get_merchant_day_schedule / get_my_booking_schedule
--        都排除 cancelled,協助卡本來就會一起消失;刻意不刪 booking_assistants,保留歷史。
--      - 改派主服務人員(move_booking reassign_main / update_booking 換主)協助人員**保留**,不在這裡處理。
--      - 恢復(removed → active)不會把協助人員加回來(刪掉就是刪掉,要的話重新指派)。
--
-- 【安全】
--   - ① grant 給 authenticated 是刻意的(設計對象就是商家管理員 / 有 orders 權限的客服,函式第一件事就是
--     can_manage_bookings);anon / PUBLIC 收掉。跟 move_booking 的既有慣例一致。
--   - ② trigger function 放 private,三個角色的 EXECUTE 全部收掉(trigger 由資料庫自己呼叫,不需要 EXECUTE)。
--   - 兩支都 security definer + 固定 search_path。
-- =========================================================================

create or replace function public.remove_booking_assistant(
  p_booking_id uuid,
  p_staff_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.bookings;
  v_assistant_name text;
  v_primary_name text;
  v_deleted integer;
begin
  -- [a] 讀訂單 → 權限 → 狀態(順序跟 update_booking / move_booking 一致:先擋權限,不洩漏狀態)。
  select * into v_booking
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_booking.merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_booking.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能移除協助人員';
  end if;

  if p_staff_id is not distinct from v_booking.staff_id then
    -- 防呆:這支只處理協助人員;主服務人員要換人請用編輯或拖拉轉派,要整張取消請用取消預約。
    raise exception '這位是主服務人員,不能用「移除協助人員」移除';
  end if;

  select ms.name into v_assistant_name
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  select ms.name into v_primary_name
  from public.merchant_staff ms
  where ms.id = v_booking.staff_id;

  -- [b] 只刪這一筆協助關聯。bookings 那一列一個欄位都不碰。
  delete from public.booking_assistants
  where booking_id = p_booking_id
    and staff_id = p_staff_id;
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    -- 兩個人同時操作 / 畫面過期:這位已經不在這張單上了。用 40001 讓前端知道要重抓。
    raise exception '這位協助人員已經不在這筆預約上,畫面已重新整理' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'booking_status', v_booking.status,
    'removed_staff_id', p_staff_id,
    'removed_staff_name', v_assistant_name,
    'primary_staff_id', v_booking.staff_id,
    'primary_staff_name', v_primary_name,
    'remaining_assistant_count', (
      select count(*) from public.booking_assistants where booking_id = p_booking_id
    )
  );
end;
$$;

comment on function public.remove_booking_assistant(uuid, uuid) is
'SPECS-INDEX #873:只移除一位協助人員(delete 一筆 booking_assistants),訂單本身(狀態/時間/金額/紅利/最後修改)完全不動,主服務人員的單維持不變。權限 private.can_manage_bookings;只允許 pending_confirmation / accepted;這位已不在單上 → 40001。不呼叫通知;被移除那位的服務人員端由 #874 booking_assistants trigger 發重查訊號。回傳 {booking_id, booking_status, removed_staff_id, removed_staff_name, primary_staff_id, primary_staff_name, remaining_assistant_count}。';

-- supabase-permission-hygiene 規則 1:新函式會自動繼承 PUBLIC EXECUTE,一定要明寫 revoke。
revoke execute on function public.remove_booking_assistant(uuid, uuid) from public, anon;
grant  execute on function public.remove_booking_assistant(uuid, uuid) to authenticated;


-- -------------------------------------------------------------------------
-- ② 主服務人員被移除 → 他當主服務人員、還沒結束的訂單上的協助人員一併刪除
-- -------------------------------------------------------------------------
create or replace function private.tg_merchant_staff_removed_drop_assistants()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'removed' and old.status is distinct from 'removed' then
    delete from public.booking_assistants ba
    using public.bookings b
    where ba.booking_id = b.id
      and b.staff_id = new.id
      and b.status in ('pending_confirmation', 'accepted');
  end if;
  return null;
end;
$$;

comment on function private.tg_merchant_staff_removed_drop_assistants() is
'SPECS-INDEX #873:服務人員被移除(status 變成 removed)時,把他擔任主服務人員、而且還沒結束(pending_confirmation / accepted)的訂單上的協助人員一併刪除,行事曆與服務人員端不再殘留「(協助)」卡。已完成 / 已取消的單不動(歷史與抽成紀錄)。恢復(removed→active)不會把協助人員加回來。';

revoke execute on function private.tg_merchant_staff_removed_drop_assistants() from public, anon, authenticated;

drop trigger if exists merchant_staff_removed_drop_assistants on public.merchant_staff;
create trigger merchant_staff_removed_drop_assistants
after update of status on public.merchant_staff
for each row
execute function private.tg_merchant_staff_removed_drop_assistants();
