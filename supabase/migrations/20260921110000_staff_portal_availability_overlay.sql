-- 模組 14:服務人員端(功能層,第六支)。
-- 對應規格書 3.13(staff_availability_windows 四政策疊加)、3.14(staff_availability_overrides
-- SELECT 政策疊加 + set_staff_day_override/clear_staff_day_override 疊加自助分支)。
--
-- 動工前已用 execute_sql 直接查詢正式環境 pg_policies/pg_get_functiondef 確認這兩張表的政策、
-- 這兩支函式目前的完整最新定義,逐字比對跟本機 migration 檔案一致,沒有正式環境獨自漂移的情況,
-- 在此基礎上疊加(比照模組 9 §233 事故的教訓,規格書 3.13/3.14 明講要做這件事)。

-- =========================================================================
-- 3.13:staff_availability_windows 四個政策(select/insert/update/delete)疊加
-- or private.can_self_manage_availability(staff_id)。
-- =========================================================================
drop policy if exists staff_availability_windows_select on public.staff_availability_windows;
drop policy if exists staff_availability_windows_insert on public.staff_availability_windows;
drop policy if exists staff_availability_windows_update on public.staff_availability_windows;
drop policy if exists staff_availability_windows_delete on public.staff_availability_windows;

create policy staff_availability_windows_select on public.staff_availability_windows
  for select to authenticated
  using (
    private.can_manage_business_hours(private.staff_merchant_id(staff_id))
    or private.can_self_manage_availability(staff_id)
  );

create policy staff_availability_windows_insert on public.staff_availability_windows
  for insert to authenticated
  with check (
    private.can_manage_business_hours(private.staff_merchant_id(staff_id))
    or private.can_self_manage_availability(staff_id)
  );

create policy staff_availability_windows_update on public.staff_availability_windows
  for update to authenticated
  using (
    private.can_manage_business_hours(private.staff_merchant_id(staff_id))
    or private.can_self_manage_availability(staff_id)
  )
  with check (
    private.can_manage_business_hours(private.staff_merchant_id(staff_id))
    or private.can_self_manage_availability(staff_id)
  );

create policy staff_availability_windows_delete on public.staff_availability_windows
  for delete to authenticated
  using (
    private.can_manage_business_hours(private.staff_merchant_id(staff_id))
    or private.can_self_manage_availability(staff_id)
  );

-- =========================================================================
-- 3.14 第 1 點:staff_availability_overrides_select 疊加 or private.can_self_manage_availability(staff_id)。
-- =========================================================================
drop policy if exists staff_availability_overrides_select on public.staff_availability_overrides;

create policy staff_availability_overrides_select on public.staff_availability_overrides
  for select to authenticated
  using (
    private.can_manage_business_hours(private.staff_merchant_id(staff_id))
    or private.can_self_manage_availability(staff_id)
  );

-- =========================================================================
-- 3.14 第 2 點:set_staff_day_override/clear_staff_day_override 權限檢查那一行疊加自助分支。
-- 簽章/回傳型別/其餘邏輯完全不變,create or replace 即可(參數型別沒有變更)。
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
  -- 1. 權限檢查(§5.4:歸在 business_hours,不是 orders;模組 14 規格書 3.14 疊加自助分支)。
  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  if not (private.can_manage_business_hours(v_merchant_id) or private.can_self_manage_availability(p_staff_id)) then
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

comment on function public.set_staff_day_override(uuid, date, time, time, boolean) is '對應規格書 §5.2/模組 14 規格書 3.14:把 [p_start_time, p_end_time) 這段時間依半小時展開,upsert 寫入這位服務人員這一天的單日例外設定(is_available=true 開啟/false 關閉)。權限檢查疊加自助分支:can_manage_business_hours(商家管理員/客服)或 can_self_manage_availability(服務人員自己,僅按件計酬)。關閉時額外查詢這段區間內既有預約(狀態不是 cancelled,含以助手身份佔用的情境)筆數並回傳,不阻擋操作、不自動取消/通知,單純回報數字讓前端提示自行確認。開啟時一律回傳 0。';

revoke execute on function public.set_staff_day_override(uuid, date, time, time, boolean) from public, anon;
grant execute on function public.set_staff_day_override(uuid, date, time, time, boolean) to authenticated;

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

  if not (private.can_manage_business_hours(v_merchant_id) or private.can_self_manage_availability(p_staff_id)) then
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

comment on function public.clear_staff_day_override(uuid, date, time, time) is '對應規格書 §5.2/模組 14 規格書 3.14:清除 [p_start_time, p_end_time) 這段時間內這位服務人員這一天的單日例外設定,恢復成「沒有例外,回歸每週固定模板」的狀態。權限檢查疊加自助分支:can_manage_business_hours(商家管理員/客服)或 can_self_manage_availability(服務人員自己,僅按件計酬)。';

revoke execute on function public.clear_staff_day_override(uuid, date, time, time) from public, anon;
grant execute on function public.clear_staff_day_override(uuid, date, time, time) to authenticated;
