-- 客戶端第 4-A 批(模組 13)— migration 3:public.confirm_booking 並發修正(主腦 2026-10-09 裁決 (a);規格 J03「不能變」的核准例外)
-- 規格書:.project/specs/客戶端第4批-會員中心與自己取消.md(C4-D02 並發驗收)
--
-- 問題(engineer 甲用兩條連線實際重現):客人取消(internal_customer_cancel_booking 鎖住訂單列並改成 cancelled)
--   的同時店家按「確認」⇒ confirm_booking 讀取沒有 for update,讀到的是舊狀態 pending_confirmation、通過狀態檢查,
--   UPDATE 只有 where id = …,等前一個交易提交後照樣把已取消的單改回 accepted(取消原因仍是「客人線上取消」、
--   紅利折抵已退回 ⇒ 資料前後矛盾)。後台 cancel_booking 與 confirm_booking 同時按也一樣。
--
-- 只改三處(其餘逐字保留;錯誤訊息、hint、權限、comment 都不變):
--   ① 讀取訂單加 for update(鎖順序 訂單 → …,跟 cancel_booking / update_booking / refund_booking_redeem 一致);
--      READ COMMITTED 下等鎖之後讀到的是最新狀態 ⇒ 已取消 / 已完成等走原本的「只有待確認可以確認」錯誤路徑。
--   ② UPDATE 的 where 加 status = 'pending_confirmation' 當保險。
--   ③ 保險萬一沒更新到 ⇒ 用同一句錯誤訊息擋下(不會寫出 null 結果、也不會寫操作紀錄)。
-- create or replace 不換簽章 ⇒ ACL(postgres / authenticated / service_role)與 comment 保留,不需重寫 revoke / grant。

CREATE OR REPLACE FUNCTION public.confirm_booking(p_booking_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'pending_confirmation' then
    raise exception '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  update public.bookings
  set status = 'accepted',
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
    and status = 'pending_confirmation'
  returning * into v_result;

  if not found then
    raise exception '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：%)', (select status from public.bookings where id = p_booking_id);
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:v_status 是變更前的狀態(pending_confirmation)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'accepted');

  return v_result;
end;
$function$;
