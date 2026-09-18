-- 模組 6:訂單管理(第二批)— 單日例外設定/清除函式。
-- 對應規格書 §5.2:set_staff_day_override/clear_staff_day_override,§5.4 權限歸屬(business_hours,
-- 不是 orders)。這份 migration 只新增這兩支函式,**不動** private.check_staff_booking_slot——
-- 第三層邏輯要等下一份 migration(先跑過等價性 pgTAP 安全網之後)才會正式接進排程驗證。

-- =========================================================================
-- §5.2:set_staff_day_override(p_staff_id, p_override_date, p_start_time, p_end_time, p_is_available)
-- returns integer(受影響的既有預約筆數,0 表示沒有衝突)。
-- =========================================================================
create or replace function public.set_staff_day_override(
  p_staff_id uuid,
  p_override_date date,
  p_start_time time,
  p_end_time time,
  p_is_available boolean
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_slot time;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_conflict_count int;
begin
  -- 1. 權限檢查(§5.4:歸在 business_hours,不是 orders)。
  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  if not private.can_manage_business_hours(v_merchant_id) then
    raise exception '沒有權限設定這位服務人員的可預約狀態' using errcode = '42501';
  end if;

  if p_is_available is null then
    raise exception '請指定這個時段要開啟還是關閉';
  end if;

  -- 2. 半小時格線對齊驗證。
  if extract(minute from p_start_time)::int not in (0, 30) or extract(second from p_start_time) <> 0 then
    raise exception '開始時間必須對齊半小時格線(例如 14:00 或 14:30)';
  end if;
  if extract(minute from p_end_time)::int not in (0, 30) or extract(second from p_end_time) <> 0 then
    raise exception '結束時間必須對齊半小時格線(例如 14:00 或 14:30)';
  end if;
  if p_end_time <= p_start_time then
    raise exception '結束時間必須晚於開始時間';
  end if;

  -- 3. 逐一展開半小時格子,upsert 覆蓋舊值(unique(staff_id, override_date, slot_start_time)）。
  v_slot := p_start_time;
  while v_slot < p_end_time loop
    insert into public.staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values (p_staff_id, p_override_date, v_slot, p_is_available)
    on conflict (staff_id, override_date, slot_start_time)
    do update set is_available = excluded.is_available, updated_at = now();
    v_slot := v_slot + interval '30 minutes';
  end loop;

  -- 4. 不阻擋、但要回報既有預約衝突(只在「關閉」的情境下才需要查,§5.2 第 4 點)。
  --    這位服務人員在 [override_date+start_time, override_date+end_time) 這段區間內、
  --    狀態不是 cancelled 的既有預約筆數(比照助手身份也算佔用的既有慣例,
  --    private.staff_booking_conflict_exists 的判斷範圍,這裡直接查詢筆數而非布林值)。
  if p_is_available then
    v_conflict_count := 0;
  else
    v_range_start := (p_override_date::timestamp + p_start_time) at time zone 'Asia/Taipei';
    v_range_end := (p_override_date::timestamp + p_end_time) at time zone 'Asia/Taipei';

    select count(*) into v_conflict_count
    from (
      select b.id
      from public.bookings b
      where b.staff_id = p_staff_id
        and b.status <> 'cancelled'
        and b.start_at < v_range_end
        and b.end_at > v_range_start
      union
      select b.id
      from public.booking_assistants ba
      join public.bookings b on b.id = ba.booking_id
      where ba.staff_id = p_staff_id
        and b.status <> 'cancelled'
        and b.start_at < v_range_end
        and b.end_at > v_range_start
    ) x;
  end if;

  return v_conflict_count;
end;
$$;

comment on function public.set_staff_day_override(uuid, date, time, time, boolean) is '對應規格書 §5.2:把 [p_start_time, p_end_time) 這段時間依半小時展開,upsert 寫入這位服務人員這一天的單日例外設定(is_available=true 開啟/false 關閉)。權限歸在 business_hours(§5.4),不是 orders。關閉時額外查詢這段區間內既有預約(狀態不是 cancelled,含以助手身份佔用的情境)筆數並回傳,不阻擋操作、不自動取消/通知,單純回報數字讓前端提示客服自行確認(§5.2 第 4 點)。開啟時一律回傳 0。';

revoke execute on function public.set_staff_day_override(uuid, date, time, time, boolean) from public, anon;
grant execute on function public.set_staff_day_override(uuid, date, time, time, boolean) to authenticated;

-- =========================================================================
-- §5.2:clear_staff_day_override(p_staff_id, p_override_date, p_start_time, p_end_time)
-- returns void——把範圍內的例外列直接刪除(恢復成「沒有例外,回歸每週固定模板」的狀態)。
-- =========================================================================
create or replace function public.clear_staff_day_override(
  p_staff_id uuid,
  p_override_date date,
  p_start_time time,
  p_end_time time
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  if not private.can_manage_business_hours(v_merchant_id) then
    raise exception '沒有權限設定這位服務人員的可預約狀態' using errcode = '42501';
  end if;

  if extract(minute from p_start_time)::int not in (0, 30) or extract(second from p_start_time) <> 0 then
    raise exception '開始時間必須對齊半小時格線(例如 14:00 或 14:30)';
  end if;
  if extract(minute from p_end_time)::int not in (0, 30) or extract(second from p_end_time) <> 0 then
    raise exception '結束時間必須對齊半小時格線(例如 14:00 或 14:30)';
  end if;
  if p_end_time <= p_start_time then
    raise exception '結束時間必須晚於開始時間';
  end if;

  delete from public.staff_availability_overrides
  where staff_id = p_staff_id
    and override_date = p_override_date
    and slot_start_time >= p_start_time
    and slot_start_time < p_end_time;
end;
$$;

comment on function public.clear_staff_day_override(uuid, date, time, time) is '對應規格書 §5.2:清除 [p_start_time, p_end_time) 這段時間內這位服務人員這一天的單日例外設定,恢復成「沒有例外,回歸每週固定模板(商家整體營業時間∩服務人員每週時段)」的狀態,不是把 is_available 設成某個值。權限歸在 business_hours(§5.4),不是 orders。';

revoke execute on function public.clear_staff_day_override(uuid, date, time, time) from public, anon;
grant execute on function public.clear_staff_day_override(uuid, date, time, time) to authenticated;
