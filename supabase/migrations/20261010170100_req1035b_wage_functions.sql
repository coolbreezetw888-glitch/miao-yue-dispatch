-- SPECS-INDEX #1035 彈性計薪 B 批(日薪／時薪制)— migration 2:計算、凍結、對外函式、報表
-- 規格書:母版 .project/specs/彈性計薪.md 第三節 PB-R、PB-F、PB-B、PB-U03;第四節 PX。
-- 使用者裁決(2026-10-09):Q1=A 上工時間 = 可預約時段 + 時段外被排的訂單(重疊只算一次);
--                         Q2=A 有上工就算一天;Q4=A 日薪／時薪的人不能自己開關時段(can_self_manage_availability 不改)。
--
--   PB-R01 private.compute_work_day(人, 日期)            某人某天的上工分鐘(純計算)
--   PB-R02 private.wage_day_row(人, 日期)                 加上當天計酬類型 / 費率 / 金額(不是日薪／時薪且在職 ⇒ null)
--   PB-R03 private.refreeze_work_day / freeze_work_days   凍結與重算 + 4 支 trigger + pg_cron「staff-work-day-freeze」
--   PB-R04 private.compute_staff_wage_by_range            逐天合併「凍結紀錄 / 即時算」
--   PB-F01~F04  set_staff_wage / list_staff_wages / get_staff_wage_by_range / recompute_staff_work_day
--   PB-B01 get_merchant_billing_summary_by_range 加 total_wage_payout、wage_includes_estimate、wage_feature_used
--   PB-U03 create_staff_leave:月薪、日薪、時薪都可以請假(抽成制照舊擋)
--
-- 🔴 全部新函式 search_path = ''、先 revoke 再 grant;private.* 一律不 grant。
-- 🔴 不用 EXECUTE / 動態 SQL;trigger 不用 exception when others 吞錯(吞錯會讓薪水默默算錯)。
-- 🔴 不動的函式:calculate_booking_staff_commission、compute_booking_commission、recalculate_booking_commission、
--    compute_staff_payroll(_by_range)、get_merchant_monthly_salary_base_as_of、get_merchant_billing_summary(舊版,Q11)、
--    check_staff_booking_slot、set_staff_day_override、can_self_manage_availability、get_staff_commission_summary_by_range。

-- =========================================================================
-- 共用小工具
-- =========================================================================
-- 台北時間的「今天」。
create function private.wage_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (now() at time zone 'Asia/Taipei')::date;
$$;

revoke all on function private.wage_today() from public, anon, authenticated;

-- time ⇒ 當日分鐘數 0~1440。用 epoch 換算,'24:00' 會得到 1440(不會回捲成 0,既有已知坑)。
create function private.wage_time_minutes(p_time time)
returns int
language sql
immutable
set search_path = ''
as $$
  select (extract(epoch from p_time) / 60)::int;
$$;

revoke all on function private.wage_time_minutes(time) from public, anon, authenticated;

-- 一組不重疊區間的總分鐘數。
create function private.wage_multirange_minutes(p_ranges int4multirange)
returns int
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum(upper(r) - lower(r)), 0)::int
  from unnest(p_ranges) as r
  where not isempty(r);
$$;

revoke all on function private.wage_multirange_minutes(int4multirange) from public, anon, authenticated;

-- 這個人是否「曾經」是日薪／時薪制(歷史任一列)。trigger 與報表的快速略過:從來不是的人什麼都不用算。
create function private.staff_has_wage_history(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.staff_payroll_status_history h
    where h.staff_id = p_staff_id
      and h.compensation_type in ('daily_wage', 'hourly_wage')
  );
$$;

revoke all on function private.staff_has_wage_history(uuid) from public, anon, authenticated;

-- =========================================================================
-- PB-R01 某人某天的上工分鐘(Q1 = A)
--   1. 當天有 confirmed 請假 ⇒ is_leave = true、全部 0。
--   2. 時段 = 營業時間 ∩ 每週時段(當天星期),再扣掉當天 is_available = false 的半小時格;
--      營業時間沒設 / 公休 ⇒ 0。不看 unlimited_backend_edit(那是「可以排在外面」,不是「整天上班」)。
--      ⚠️ 單日例外 is_available = true 不加時段(#1023 起每週時段外不能「開放」,時段內開放等於沒變)。
--   3. 訂單時間 = 當天他當主要或跟場、status <> 'cancelled' 的訂單 [start_at, end_at)(台北時間,裁到當天)。
--   4. worked = 時段 ∪ 訂單(重疊只算一次);extra = 訂單落在時段外的分鐘。
--   Q1 改 B ⇒ 拿掉第 3 步;改 C ⇒ 只用第 3 步。只改這一支。
--   區間運算用 int4multirange(當日分鐘 0~1440),不逐分鐘迴圈。純計算、不寫資料、不檢查權限。
-- =========================================================================
create function private.compute_work_day(p_staff_id uuid, p_date date)
returns table (
  shift_minutes int,
  extra_booking_minutes int,
  worked_minutes int,
  is_leave boolean,
  leave_type_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
  v_leave_name text;
  v_dow smallint := extract(dow from p_date)::smallint;
  v_hours record;
  v_windows int4multirange := '{}'::int4multirange;
  v_closed int4multirange := '{}'::int4multirange;
  v_shift int4multirange := '{}'::int4multirange;
  v_bookings int4multirange := '{}'::int4multirange;
  v_day_start timestamptz := p_date::timestamp at time zone 'Asia/Taipei';
  v_day_end timestamptz := (p_date + 1)::timestamp at time zone 'Asia/Taipei';
begin
  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;
  if not found or p_date is null then
    shift_minutes := 0; extra_booking_minutes := 0; worked_minutes := 0; is_leave := false; leave_type_name := null;
    return next;
    return;
  end if;

  -- 1. 請假(整天)
  select slr.leave_type_name_snapshot into v_leave_name
  from public.staff_leave_records slr
  where slr.staff_id = p_staff_id
    and slr.status = 'confirmed'
    and p_date between slr.start_date and slr.end_date
  order by slr.created_at, slr.id
  limit 1;

  if found then
    shift_minutes := 0; extra_booking_minutes := 0; worked_minutes := 0; is_leave := true; leave_type_name := v_leave_name;
    return next;
    return;
  end if;

  -- 2. 時段 = 營業時間 ∩ 每週時段 − 關閉的半小時格
  select bh.is_closed, bh.open_time, bh.close_time into v_hours
  from public.merchant_business_hours bh
  where bh.merchant_id = v_merchant_id and bh.day_of_week = v_dow;

  if found and not v_hours.is_closed and v_hours.open_time is not null and v_hours.close_time is not null then
    select coalesce(range_agg(int4range(private.wage_time_minutes(w.start_time), private.wage_time_minutes(w.end_time))),
                    '{}'::int4multirange)
    into v_windows
    from public.staff_availability_windows w
    where w.staff_id = p_staff_id and w.day_of_week = v_dow;

    select coalesce(range_agg(int4range(private.wage_time_minutes(o.slot_start_time),
                                        least(private.wage_time_minutes(o.slot_start_time) + 30, 1440))),
                    '{}'::int4multirange)
    into v_closed
    from public.staff_availability_overrides o
    where o.staff_id = p_staff_id and o.override_date = p_date and not o.is_available;

    v_shift := (v_windows * int4multirange(int4range(private.wage_time_minutes(v_hours.open_time),
                                                       private.wage_time_minutes(v_hours.close_time))))
               - v_closed;
  end if;

  -- 3. 訂單時間(主要 + 跟場;跨午夜的單裁到當天,另一天由另一天自己算)
  select coalesce(range_agg(int4range(
           floor(extract(epoch from (greatest(b.start_at, v_day_start) - v_day_start)) / 60)::int,
           ceil(extract(epoch from (least(b.end_at, v_day_end) - v_day_start)) / 60)::int)),
         '{}'::int4multirange)
  into v_bookings
  from (
    select b1.start_at, b1.end_at
    from public.bookings b1
    where b1.staff_id = p_staff_id
      and b1.status <> 'cancelled'
      and b1.start_at < v_day_end and b1.end_at > v_day_start
    union all
    select b2.start_at, b2.end_at
    from public.booking_assistants ba
    join public.bookings b2 on b2.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b2.status <> 'cancelled'
      and b2.start_at < v_day_end and b2.end_at > v_day_start
  ) b;

  -- 4. 合計(重疊只算一次)
  shift_minutes := private.wage_multirange_minutes(v_shift);
  worked_minutes := private.wage_multirange_minutes(v_shift + v_bookings);
  extra_booking_minutes := private.wage_multirange_minutes(v_bookings - v_shift);
  is_leave := false;
  leave_type_name := null;
  return next;
end;
$$;

revoke all on function private.compute_work_day(uuid, date) from public, anon, authenticated;

-- =========================================================================
-- PB-R02 某人某天的完整一列(含當天計酬類型、費率、金額)
--   當天(台北)結束那一刻的狀態:existed、在職、日薪／時薪制 —— 任一不成立 ⇒ null(這天不計)。
--   時薪:round(worked × wage / 60, 0)(每天四捨五入到元,Q9);日薪:worked > 0 ⇒ wage(Q2 = A),否則 0。
--   不套假別扣款、沒有獎金(S6)、沒有抽成。
-- =========================================================================
create function private.wage_day_row(p_staff_id uuid, p_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status record;
  v_day record;
  v_wage numeric(10, 2);
  v_pay numeric(10, 0);
begin
  select * into v_status
  from private.get_staff_payroll_status_as_of(
    p_staff_id, ((p_date + 1)::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond');

  if not found
     or not coalesce(v_status.existed, false)
     or v_status.status is distinct from 'active'
     or v_status.compensation_type not in ('daily_wage', 'hourly_wage') then
    return null;
  end if;

  select * into v_day from private.compute_work_day(p_staff_id, p_date);
  v_wage := coalesce(v_status.wage_amount, 0);

  if v_status.compensation_type = 'hourly_wage' then
    v_pay := round(v_day.worked_minutes * v_wage / 60, 0);
  elsif v_day.worked_minutes > 0 then
    v_pay := round(v_wage, 0);
  else
    v_pay := 0;
  end if;

  return jsonb_build_object(
    'date', p_date,
    'compensation_type', v_status.compensation_type,
    'wage_amount', v_wage,
    'shift_minutes', v_day.shift_minutes,
    'extra_booking_minutes', v_day.extra_booking_minutes,
    'worked_minutes', v_day.worked_minutes,
    'is_leave', v_day.is_leave,
    'leave_type_name', v_day.leave_type_name,
    'pay_amount', v_pay
  );
end;
$$;

revoke all on function private.wage_day_row(uuid, date) from public, anon, authenticated;

-- =========================================================================
-- PB-R03-1 重算(覆蓋)某人某天的凍結紀錄:只限過去日期、只限那天是日薪／時薪制且在職的人。
--   只做純計算與 upsert,不丟業務錯誤(trigger 會呼叫它,不能擋住原本的訂單 / 時段操作)。
--   人已經被刪掉(cascade 途中)⇒ 什麼都不做。
-- =========================================================================
create function private.refreeze_work_day(p_staff_id uuid, p_date date, p_reason text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
  v_row jsonb;
begin
  if p_staff_id is null or p_date is null or p_date >= private.wage_today() then
    return;
  end if;
  if not private.staff_has_wage_history(p_staff_id) then
    return;
  end if;

  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;
  if not found then
    return;
  end if;

  v_row := private.wage_day_row(p_staff_id, p_date);
  if v_row is null then
    return;
  end if;

  insert into public.staff_work_day_records as r (
    merchant_id, staff_id, work_date, compensation_type, wage_amount, shift_minutes, extra_booking_minutes,
    worked_minutes, is_leave, leave_type_name, pay_amount, frozen_at, refrozen_reason
  ) values (
    v_merchant_id, p_staff_id, p_date, v_row ->> 'compensation_type', (v_row ->> 'wage_amount')::numeric,
    (v_row ->> 'shift_minutes')::int, (v_row ->> 'extra_booking_minutes')::int, (v_row ->> 'worked_minutes')::int,
    (v_row ->> 'is_leave')::boolean, v_row ->> 'leave_type_name', (v_row ->> 'pay_amount')::numeric,
    now(), p_reason
  )
  on conflict (staff_id, work_date) do update set
    merchant_id = excluded.merchant_id,
    compensation_type = excluded.compensation_type,
    wage_amount = excluded.wage_amount,
    shift_minutes = excluded.shift_minutes,
    extra_booking_minutes = excluded.extra_booking_minutes,
    worked_minutes = excluded.worked_minutes,
    is_leave = excluded.is_leave,
    leave_type_name = excluded.leave_type_name,
    pay_amount = excluded.pay_amount,
    frozen_at = excluded.frozen_at,
    refrozen_reason = excluded.refrozen_reason,
    updated_at = now();
end;
$$;

revoke all on function private.refreeze_work_day(uuid, date, text) from public, anon, authenticated;

-- =========================================================================
-- PB-R03-2 每天凍結:「昨天」以及「最近 35 天內還沒有紀錄」的日子(已存在的不覆蓋)。
--   p_today 只給測試用(null = 台北今天)。回傳這次新寫入幾筆。純 SQL,不呼叫外部。
-- =========================================================================
create function private.freeze_work_days(p_today date default null)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := coalesce(p_today, private.wage_today());
  v_from date := v_today - 35;
  v_to date := v_today - 1;
  v_pair record;
  v_row jsonb;
  v_count int := 0;
  v_inserted int;
begin
  for v_pair in
    select s.staff_id, s.merchant_id, d::date as work_date
    from (
      select distinct h.staff_id, ms.merchant_id
      from public.staff_payroll_status_history h
      join public.merchant_staff ms on ms.id = h.staff_id
      where h.compensation_type in ('daily_wage', 'hourly_wage')
        and h.status = 'active'
        and h.effective_from < ((v_to + 1)::timestamp at time zone 'Asia/Taipei')
        and (h.effective_to is null or h.effective_to > (v_from::timestamp at time zone 'Asia/Taipei'))
    ) s
    cross join generate_series(v_from, v_to, interval '1 day') as d
    where not exists (
      select 1 from public.staff_work_day_records r
      where r.staff_id = s.staff_id and r.work_date = d::date
    )
    order by s.staff_id, d
  loop
    v_row := private.wage_day_row(v_pair.staff_id, v_pair.work_date);
    if v_row is not null then
      insert into public.staff_work_day_records (
        merchant_id, staff_id, work_date, compensation_type, wage_amount, shift_minutes, extra_booking_minutes,
        worked_minutes, is_leave, leave_type_name, pay_amount, frozen_at, refrozen_reason
      ) values (
        v_pair.merchant_id, v_pair.staff_id, v_pair.work_date, v_row ->> 'compensation_type',
        (v_row ->> 'wage_amount')::numeric, (v_row ->> 'shift_minutes')::int,
        (v_row ->> 'extra_booking_minutes')::int, (v_row ->> 'worked_minutes')::int,
        (v_row ->> 'is_leave')::boolean, v_row ->> 'leave_type_name', (v_row ->> 'pay_amount')::numeric,
        now(), null
      )
      on conflict (staff_id, work_date) do nothing;
      get diagnostics v_inserted = row_count;
      v_count := v_count + v_inserted;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function private.freeze_work_days(date) from public, anon, authenticated;

-- =========================================================================
-- PB-R03-3 「刻意改過去某天」才重算(Q8):4 支 trigger
--   每支都只在「日期 < 今天(台北)」且那人曾經是日薪／時薪制時才真的算(refreeze_work_day 內判斷)。
--   每週時段範本、營業時間、費率、計酬類型變更 ⇒ 不重算(只影響今天以後)。
-- =========================================================================

-- 一段 [start, end) 時間(台北)涵蓋的日期(過去的);最多 366 天。
create function private.wage_dates_of_span(p_start_at timestamptz, p_end_at timestamptz)
returns setof date
language sql
stable
set search_path = ''
as $$
  select d::date
  from generate_series(
    (p_start_at at time zone 'Asia/Taipei')::date,
    least(
      (greatest(p_end_at - interval '1 microsecond', p_start_at) at time zone 'Asia/Taipei')::date,
      (p_start_at at time zone 'Asia/Taipei')::date + 365,
      private.wage_today() - 1
    ),
    interval '1 day'
  ) as d
  where p_start_at is not null and p_end_at is not null;
$$;

revoke all on function private.wage_dates_of_span(timestamptz, timestamptz) from public, anon, authenticated;

-- (a) 單日例外(關閉 / 開啟某一格)
create function private.tg_staff_availability_overrides_refreeze_work_day()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and new.staff_id is not distinct from old.staff_id
     and new.override_date is not distinct from old.override_date
     and new.slot_start_time is not distinct from old.slot_start_time
     and new.is_available is not distinct from old.is_available then
    return null;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    perform private.refreeze_work_day(old.staff_id, old.override_date, 'override');
  end if;
  -- 新增;或改到另一個人 / 另一天(同人同天只改格子或開關時,上面那次已經算過)。
  if tg_op = 'INSERT'
     or (tg_op = 'UPDATE' and (new.staff_id is distinct from old.staff_id or new.override_date is distinct from old.override_date)) then
    perform private.refreeze_work_day(new.staff_id, new.override_date, 'override');
  end if;
  return null;
end;
$$;

revoke all on function private.tg_staff_availability_overrides_refreeze_work_day() from public, anon, authenticated;

create trigger staff_availability_overrides_refreeze_work_day
  after insert or update or delete on public.staff_availability_overrides
  for each row execute function private.tg_staff_availability_overrides_refreeze_work_day();

-- (b) 請假(新增 / 取消 / 改日期)。涵蓋的每個過去日期,最多 366 天。
create function private.tg_staff_leave_records_refreeze_work_day()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.wage_today();
  v_d date;
begin
  if tg_op = 'UPDATE'
     and new.staff_id is not distinct from old.staff_id
     and new.status is not distinct from old.status
     and new.start_date is not distinct from old.start_date
     and new.end_date is not distinct from old.end_date then
    return null;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.start_date < v_today
     and private.staff_has_wage_history(old.staff_id) then
    for v_d in
      select gs::date from generate_series(
        greatest(old.start_date, least(old.end_date, v_today - 1) - 365),
        least(old.end_date, v_today - 1), interval '1 day') gs
    loop
      perform private.refreeze_work_day(old.staff_id, v_d, 'leave');
    end loop;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.start_date < v_today
     and private.staff_has_wage_history(new.staff_id) then
    for v_d in
      select gs::date from generate_series(
        greatest(new.start_date, least(new.end_date, v_today - 1) - 365),
        least(new.end_date, v_today - 1), interval '1 day') gs
    loop
      perform private.refreeze_work_day(new.staff_id, v_d, 'leave');
    end loop;
  end if;
  return null;
end;
$$;

revoke all on function private.tg_staff_leave_records_refreeze_work_day() from public, anon, authenticated;

create trigger staff_leave_records_refreeze_work_day
  after insert or update or delete on public.staff_leave_records
  for each row execute function private.tg_staff_leave_records_refreeze_work_day();

-- (c) 訂單:時間 / 狀態 / 主要服務人員改變(新舊兩個日期、新舊兩個人 + 這張單目前的跟場)。
--   ⚠️ 規格只列 update;這裡另外涵蓋 insert / delete(補建過去日期的單、硬刪單也會改變那天的上工時間)。
create function private.tg_bookings_refreeze_work_day()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := private.wage_today();
  v_staff uuid;
  v_d date;
begin
  -- 時間、主要服務人員都沒變時,只有「變成取消 / 從取消改回」才會改變上工時間(取消的單不算);
  -- 其他狀態變化(確認、完成、還原…)不重算(主腦裁決 M2:避免過去的日子因為完成訂單被拿現在的範本重算)。
  if tg_op = 'UPDATE'
     and new.start_at is not distinct from old.start_at
     and new.end_at is not distinct from old.end_at
     and new.staff_id is not distinct from old.staff_id
     and (new.status = 'cancelled') is not distinct from (old.status = 'cancelled') then
    return null;
  end if;

  -- 快速略過:新舊時間都不碰過去的日期 ⇒ 不用算。
  if (tg_op = 'INSERT' or (old.start_at at time zone 'Asia/Taipei')::date >= v_today)
     and (tg_op = 'DELETE' or (new.start_at at time zone 'Asia/Taipei')::date >= v_today) then
    return null;
  end if;

  for v_staff in
    select distinct x.staff_id
    from (
      select old.staff_id as staff_id where tg_op in ('UPDATE', 'DELETE')
      union all
      select new.staff_id where tg_op in ('INSERT', 'UPDATE')
      union all
      select ba.staff_id from public.booking_assistants ba
      where ba.booking_id = case when tg_op = 'DELETE' then old.id else new.id end
    ) x
    where x.staff_id is not null
  loop
    if not private.staff_has_wage_history(v_staff) then
      continue;
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
      for v_d in select * from private.wage_dates_of_span(old.start_at, old.end_at) loop
        perform private.refreeze_work_day(v_staff, v_d, 'booking');
      end loop;
    end if;
    if tg_op in ('INSERT', 'UPDATE') then
      for v_d in select * from private.wage_dates_of_span(new.start_at, new.end_at) loop
        perform private.refreeze_work_day(v_staff, v_d, 'booking');
      end loop;
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function private.tg_bookings_refreeze_work_day() from public, anon, authenticated;

create trigger bookings_refreeze_work_day
  after insert or delete or update of start_at, end_at, status, staff_id on public.bookings
  for each row execute function private.tg_bookings_refreeze_work_day();

-- (d) 跟場名單(加入 / 移除)
create function private.tg_booking_assistants_refreeze_work_day()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b record;
  v_d date;
begin
  if tg_op = 'UPDATE'
     and new.staff_id is not distinct from old.staff_id
     and new.booking_id is not distinct from old.booking_id then
    return null;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and private.staff_has_wage_history(old.staff_id) then
    -- 整張單被硬刪(cascade)時訂單已經查不到 ⇒ 略過(那天的主要服務人員由訂單 trigger 處理)。
    select b.start_at, b.end_at into v_b from public.bookings b where b.id = old.booking_id;
    if found then
      for v_d in select * from private.wage_dates_of_span(v_b.start_at, v_b.end_at) loop
        perform private.refreeze_work_day(old.staff_id, v_d, 'booking');
      end loop;
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and private.staff_has_wage_history(new.staff_id) then
    select b.start_at, b.end_at into v_b from public.bookings b where b.id = new.booking_id;
    if found then
      for v_d in select * from private.wage_dates_of_span(v_b.start_at, v_b.end_at) loop
        perform private.refreeze_work_day(new.staff_id, v_d, 'booking');
      end loop;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function private.tg_booking_assistants_refreeze_work_day() from public, anon, authenticated;

create trigger booking_assistants_refreeze_work_day
  after insert or delete or update of staff_id, booking_id on public.booking_assistants
  for each row execute function private.tg_booking_assistants_refreeze_work_day();

-- =========================================================================
-- PB-R04 某人某區間的工資(逐天,只到今天;未來不算,Q10)
--   過去日:有凍結紀錄 ⇒ 讀紀錄(settled);沒有 ⇒ 即時算(unsettled,唯讀不寫)。今天:即時算(estimated)。
--   區間上限一年。work_days = worked_minutes > 0 的天數。不檢查權限。
-- =========================================================================
create function private.compute_staff_wage_by_range(p_staff_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := private.wage_today();
  v_last date;
  v_d date;
  v_rec record;
  v_row jsonb;
  v_days jsonb := '[]'::jsonb;
  v_total_pay numeric := 0;
  v_total_minutes int := 0;
  v_work_days int := 0;
  v_wage_missing boolean := false;
  v_latest_type text := null;
  v_latest_wage numeric := null;
  v_now_status record;
begin
  v_last := least(p_end_date, v_today);

  if p_start_date is not null and v_last >= p_start_date and private.staff_has_wage_history(p_staff_id) then
    for v_d in select gs::date from generate_series(p_start_date, v_last, interval '1 day') gs loop
      v_row := null;
      if v_d < v_today then
        select r.compensation_type, r.wage_amount, r.shift_minutes, r.extra_booking_minutes, r.worked_minutes,
               r.is_leave, r.leave_type_name, r.pay_amount
        into v_rec
        from public.staff_work_day_records r
        where r.staff_id = p_staff_id and r.work_date = v_d;
        if found then
          v_row := jsonb_build_object(
            'date', v_d,
            'compensation_type', v_rec.compensation_type,
            'wage_amount', v_rec.wage_amount,
            'shift_minutes', v_rec.shift_minutes,
            'extra_booking_minutes', v_rec.extra_booking_minutes,
            'worked_minutes', v_rec.worked_minutes,
            'is_leave', v_rec.is_leave,
            'leave_type_name', v_rec.leave_type_name,
            'pay_amount', v_rec.pay_amount,
            'state', 'settled'
          );
        end if;
      end if;

      if v_row is null then
        v_row := private.wage_day_row(p_staff_id, v_d);
        if v_row is null then
          continue;
        end if;
        v_row := v_row || jsonb_build_object('state', case when v_d = v_today then 'estimated' else 'unsettled' end);
      end if;

      v_days := v_days || jsonb_build_array(v_row);
      v_total_pay := v_total_pay + (v_row ->> 'pay_amount')::numeric;
      v_total_minutes := v_total_minutes + (v_row ->> 'worked_minutes')::int;
      if (v_row ->> 'worked_minutes')::int > 0 then
        v_work_days := v_work_days + 1;
      end if;
      if (v_row ->> 'wage_amount')::numeric = 0 then
        v_wage_missing := true;
      end if;
      v_latest_type := v_row ->> 'compensation_type';
      v_latest_wage := (v_row ->> 'wage_amount')::numeric;
    end loop;
  end if;

  -- 目前是日薪／時薪制、但還沒設定金額(或 0)⇒ 也標黃(區間內可能還沒有任何一天)。
  select * into v_now_status from private.get_staff_payroll_status_as_of(p_staff_id, now());
  if found and coalesce(v_now_status.existed, false) and v_now_status.status = 'active'
     and v_now_status.compensation_type in ('daily_wage', 'hourly_wage')
     and coalesce(v_now_status.wage_amount, 0) = 0 then
    v_wage_missing := true;
  end if;

  return jsonb_build_object(
    'total_pay', v_total_pay,
    'total_worked_minutes', v_total_minutes,
    'work_days', v_work_days,
    'days', v_days,
    'wage_missing', v_wage_missing,
    'latest_compensation_type', v_latest_type,
    'latest_wage_amount', v_latest_wage,
    'includes_estimate', (p_start_date <= v_today and p_end_date >= v_today)
  );
end;
$$;

revoke all on function private.compute_staff_wage_by_range(uuid, date, date) from public, anon, authenticated;

-- =========================================================================
-- PB-F01 set_staff_wage(p_staff_id, p_amount):設定日薪／時薪金額
--   權限 can_manage_commission_settings(由服務人員反查商家)+ 在職 + 目前是日薪／時薪制。
-- =========================================================================
create function public.set_staff_wage(p_staff_id uuid, p_amount numeric)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_staff record;
begin
  select ms.id, ms.merchant_id, ms.status, ms.compensation_type into v_staff
  from public.merchant_staff ms where ms.id = p_staff_id;

  if not found or not private.can_manage_commission_settings(v_staff.merchant_id) then
    raise exception '沒有權限設定這位服務人員的薪資。' using errcode = '42501';
  end if;
  if v_staff.status <> 'active' then
    raise exception '這位服務人員已經移除，不能設定金額。' using errcode = '22023';
  end if;
  if v_staff.compensation_type not in ('daily_wage', 'hourly_wage') then
    raise exception '只有日薪制或時薪制的服務人員可以設定日薪／時薪金額。' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 or p_amount > 1000000 then
    raise exception '金額要在 0 到 1,000,000 元之間。' using errcode = '22023';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception '金額最多只能到小數點後 2 位。' using errcode = '22023';
  end if;

  insert into public.staff_wage_settings as s (staff_id, merchant_id, wage_amount, updated_by_user_id)
  values (p_staff_id, v_staff.merchant_id, p_amount, auth.uid())
  on conflict (staff_id) do update set
    wage_amount = excluded.wage_amount,
    merchant_id = excluded.merchant_id,
    updated_by_user_id = excluded.updated_by_user_id,
    updated_at = now();

  return jsonb_build_object('staff_id', p_staff_id, 'wage_amount', p_amount, 'compensation_type', v_staff.compensation_type);
end;
$$;

revoke all on function public.set_staff_wage(uuid, numeric) from public, anon, authenticated;
grant execute on function public.set_staff_wage(uuid, numeric) to authenticated;

-- =========================================================================
-- PB-F02 list_staff_wages(p_merchant_id):目前在職的日薪／時薪人員 + 金額(沒有設定 ⇒ 0)
-- =========================================================================
create function public.list_staff_wages(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_merchant_id is null or not private.can_manage_commission_settings(p_merchant_id) then
    raise exception '沒有權限查看這間商家的薪資設定。' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'staff_id', ms.id,
           'name', ms.name,
           'compensation_type', ms.compensation_type,
           'wage_amount', coalesce(ws.wage_amount, 0),
           'has_setting', ws.staff_id is not null
         ) order by ms.display_order, ms.created_at, ms.id), '[]'::jsonb)
  into v_result
  from public.merchant_staff ms
  left join public.staff_wage_settings ws on ws.staff_id = ms.id
  where ms.merchant_id = p_merchant_id
    and ms.status = 'active'
    and ms.compensation_type in ('daily_wage', 'hourly_wage');

  return v_result;
end;
$$;

revoke all on function public.list_staff_wages(uuid) from public, anon, authenticated;
grant execute on function public.list_staff_wages(uuid) to authenticated;

-- =========================================================================
-- PB-F03 get_staff_wage_by_range(p_staff_id, p_start, p_end)
--   權限:can_view_payroll_reports(該店)或 can_view_staff_own_payroll(本人)。區間上限一年(比照既有)。
-- =========================================================================
create function public.get_staff_wage_by_range(p_staff_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
begin
  -- 主腦裁決 L2:查不到人跟沒有權限回同一句 42501(跟 set_staff_wage 一致),不透露這個 id 存不存在。
  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;
  if not found
     or not (private.can_view_payroll_reports(v_merchant_id) or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的服務人員報表。' using errcode = '42501';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception '請選擇查詢區間。' using errcode = '22023';
  end if;
  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期。';
  end if;
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年。';
  end if;

  return private.compute_staff_wage_by_range(p_staff_id, p_start_date, p_end_date);
end;
$$;

revoke all on function public.get_staff_wage_by_range(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_staff_wage_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- PB-F04 recompute_staff_work_day(p_staff_id, p_date)(⚠️範圍 6):手動「重新計算這天」
--   只限過去日期、那天是日薪／時薪制且在職;寫 refrozen_reason = 'manual_job'。
-- =========================================================================
create function public.recompute_staff_work_day(p_staff_id uuid, p_date date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
  v_rec record;
begin
  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;
  if not found or not private.can_manage_commission_settings(v_merchant_id) then
    raise exception '沒有權限重新計算這位服務人員的上工紀錄。' using errcode = '42501';
  end if;
  if p_date is null or p_date >= private.wage_today() then
    raise exception '只能重新計算今天以前的日子。' using errcode = '22023';
  end if;
  if private.wage_day_row(p_staff_id, p_date) is null then
    raise exception '這位服務人員那天不是在職的日薪制或時薪制，不用計算。' using errcode = '22023';
  end if;

  perform private.refreeze_work_day(p_staff_id, p_date, 'manual_job');

  select r.work_date, r.compensation_type, r.wage_amount, r.shift_minutes, r.extra_booking_minutes,
         r.worked_minutes, r.is_leave, r.leave_type_name, r.pay_amount, r.frozen_at
  into v_rec
  from public.staff_work_day_records r
  where r.staff_id = p_staff_id and r.work_date = p_date;

  return to_jsonb(v_rec);
end;
$$;

revoke all on function public.recompute_staff_work_day(uuid, date) from public, anon, authenticated;
grant execute on function public.recompute_staff_work_day(uuid, date) to authenticated;

-- =========================================================================
-- PB-R03-4 排程:台北每天 00:15(UTC 16:15)凍結昨天 + 補最近 35 天漏掉的。純 SQL,不呼叫外部。
-- =========================================================================
select
  cron.schedule(
    'staff-work-day-freeze',
    '15 16 * * *',
    $$ select private.freeze_work_days(); $$
  );


-- =========================================================================
-- PB-U03 create_staff_leave:月薪、日薪、時薪都可以登記請假(抽成制照舊擋)(⚠️ 零之一第 2 點)
--   改前本體 = 20261007130100_req987_b_fullwidth_messages_member_staff.sql(本機 / 正式庫指紋 35126872),
--   逐字保留,只動標了「#1035 B 批」的第 2 步(條件 + 錯誤訊息)。ACL 照改前。
-- =========================================================================
CREATE OR REPLACE FUNCTION public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text DEFAULT NULL::text, p_confirm_despite_conflicts boolean DEFAULT false)
 RETURNS staff_leave_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_compensation_type text;
  v_leave_type_name text;
  v_conflict_count int;
  v_result public.staff_leave_records;
begin
  -- 1. 查 merchant_staff 取得 merchant_id/compensation_type,檢查權限。
  select merchant_id, compensation_type
  into v_merchant_id, v_compensation_type
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_manage_team_leave(v_merchant_id) then
    raise exception '沒有權限管理這間商家的請假紀錄' using errcode = '42501';
  end if;

  -- 2. 規則 2.2:只有月薪制服務人員可以登記請假紀錄。
  -- #1035 B 批(PB-U03):日薪制、時薪制也可以登記(請假那天上工時間 = 0,不套假別扣款規則);抽成制照舊擋。
  if v_compensation_type not in ('monthly_salary', 'daily_wage', 'hourly_wage') then
    raise exception '只有月薪制、日薪制、時薪制的服務人員可以登記請假紀錄，請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)';
  end if;

  -- 3. end_date >= start_date(資料表 CHECK 約束也會擋,這裡提前給白話錯誤訊息)。
  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 4. 規則 2.5:同一服務人員的 confirmed 請假區間不能重疊,沒有覆寫例外。
  if exists (
    select 1
    from public.staff_leave_records slr
    where slr.staff_id = p_staff_id
      and slr.status = 'confirmed'
      and daterange(slr.start_date, slr.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception '這位服務人員在這段期間已經有其他請假紀錄，日期區間不能重疊';
  end if;

  -- 5. 規則 2.6:既有預約衝突,警示但不強制擋下——有衝突且沒有確認旗標就擋下並回傳筆數。
  select count(*) into v_conflict_count
  from public.preview_staff_leave_conflicts(p_staff_id, p_start_date, p_end_date);

  if v_conflict_count > 0 and not coalesce(p_confirm_despite_conflicts, false) then
    raise exception '這段期間已經有 % 筆預約，請先確認清單後再登記請假', v_conflict_count;
  end if;

  -- 6. 假別必須屬於同一商家且 status='active'(已下架的假別只留給歷史紀錄快照顯示用)。
  select name into v_leave_type_name
  from public.merchant_leave_types
  where id = p_leave_type_id and merchant_id = v_merchant_id and status = 'active';

  if not found then
    raise exception '找不到這個假別，或已下架';
  end if;

  -- 7. 通過後寫入,status 固定 'confirmed'(這次不做簽核流程,建立即生效)。
  insert into public.staff_leave_records (
    staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, notes, status, created_by_user_id
  ) values (
    p_staff_id, p_leave_type_id, v_leave_type_name, p_start_date, p_end_date, p_notes, 'confirmed', auth.uid()
  )
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) from PUBLIC, anon;
grant execute on function public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) to authenticated, service_role;

-- =========================================================================
-- PB-B01 店家報表加鍵(既有鍵一個都不改,只有 estimated_net_margin 多減工資)
--   改前本體 = 20261010160100_req1035a_bonus_functions.sql(本機 / 正式庫指紋 9a1f196c),
--   逐字保留,只動標了「#1035 B 批」的地方:
--     ① declare 多幾個變數
--     ② 月薪獎金段之後算 total_wage_payout(區間內只到今天;所有曾經是日薪／時薪制的人 compute_staff_wage_by_range 合計;
--        不需要完整月份)、wage_includes_estimate、wage_feature_used(該店歷史上有任何日薪／時薪制的人)
--     ③ per_staff_breakdown 分支:原本「不是月薪就當抽成」改成 monthly_salary 照舊 / daily_wage、hourly_wage 新分支 /
--        其他照舊抽成分支 —— 既有兩種的輸出逐字不變
--     ④ estimated_net_margin(salary_applicable 時)再多減 total_wage_payout;沒有日薪／時薪人員的店 = 減 0
--     ⑤ 回傳多三個鍵 total_wage_payout、wage_includes_estimate、wage_feature_used
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary_by_range(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_salary_applicable boolean;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_estimated_net_margin numeric(10, 2);
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
  -- #1035 A 批 PA-B01:月薪獎金
  v_total_monthly_bonus numeric(12, 2);
  v_bonus_feature_used boolean;
  v_staff_bonus numeric(12, 2);
  -- #1035 B 批 PB-B01:日薪／時薪支出
  v_total_wage_payout numeric(12, 2);
  v_wage_includes_estimate boolean;
  v_wage_feature_used boolean;
  v_staff_wage jsonb;
  v_wage_staff record;
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC
  -- 查詢過大區間造成效能問題或撈出超出預期範圍的資料。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- =======================================================================
  -- 任務 3(使用者已回覆「可以」):月薪相關數字只在「完整月份」的查詢下才計算。
  -- 條件:起始日是某個月的 1 號,且結束日是某個月的最後一天(可以跨多個月,2/1–4/30 合法)。
  --   ・p_start_date 是 1 號          → date_trunc('month', p_start_date) = p_start_date
  --   ・p_end_date 是該月最後一天     → p_end_date + 1 天之後就會跨到下個月的 1 號
  -- 這同時消滅一個真的 bug:原本不論區間頭尾是不是完整月份,都用 generate_series 以「月初」
  -- 為單位展開,所以「查 2/15–3/15(29 天)」會收到 2 個整月的月薪基本額,而扣款那一邊
  -- (compute_staff_payroll_by_range)卻是按區間裁切的 → 兩邊口徑不一致,月薪實發沒有意義。
  -- =======================================================================
  v_salary_applicable := (
    p_start_date = date_trunc('month', p_start_date)::date
    and (p_end_date + 1) = date_trunc('month', (p_end_date + 1)::date)::date
  );

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  -- 2026-09-24(任務 1):月份/區間基準從 b.start_at 改成完成時間(理由見檔頭與 §3 的註解)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

  -- 第 11 批 F #993:amount_snapshot 是「單價」,料錢合計 = Σ 單價 × 數量。
  select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持 computed_at(已查證 ≡ completed_at,且事後重算不改它,詳見檔頭)。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8(核心):比照 11.7 的「逐月迴圈」邏輯,對區間內每個月份呼叫 11.6,把每個月份的加總
  -- 結果再加總。只要任一月份任一人用到估算,salary_estimation_applied 就是 true。
  -- 2026-09-24(任務 3):只在 v_salary_applicable 為真時才算;不是完整月份時一律留 null
  -- (不是 0——前端要能分辨「不適用」與「真的是零」)。
  if v_salary_applicable then
    select
      coalesce(sum(gm.total_amount), 0),
      coalesce(bool_or(gm.is_estimated), false)
    into v_total_salary_base, v_salary_estimated
    from generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start)
    cross join lateral private.get_merchant_monthly_salary_base_as_of(
      p_merchant_id,
      ((least((m.month_start + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
        at time zone 'Asia/Taipei') - interval '1 microsecond'
    ) as gm;
  else
    v_total_salary_base := null;
    v_total_salary_deduction := null;
    v_salary_estimated := false;
  end if;

  -- #1035 A 批 PA-B01:月薪獎金合計。跟月薪同一個「完整月份」條件;每月份照「月底當時」的狀態與方案
  -- (compute_staff_monthly_bonus 自己判斷 existed / 在職 / 月薪制 / 有方案,不成立就是 0)。
  -- 只掃「歷史上曾經有過方案」的人,沒有任何方案的店 = 0 列 = 0 元。
  v_bonus_feature_used := exists (
    select 1 from public.staff_bonus_plans bp where bp.merchant_id = p_merchant_id
  );
  if v_salary_applicable then
    select coalesce(sum((private.compute_staff_monthly_bonus(h.staff_id, m.month_start::date) ->> 'amount')::numeric), 0)
    into v_total_monthly_bonus
    from (
      select distinct sh.staff_id
      from public.staff_payroll_status_history sh
      where sh.merchant_id = p_merchant_id
        and sh.bonus_plan_id is not null
    ) h
    cross join generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start);
  else
    v_total_monthly_bonus := null;
  end if;

  -- #1035 B 批 PB-B01:日薪／時薪支出。按天算(不需要完整月份),只算到今天(今天 = 預估,未來不算)。
  -- 母體 = 歷史上曾經是日薪／時薪制的人(含已移除的;compute_staff_wage_by_range 逐天判斷當天是否在職)。
  v_wage_feature_used := exists (
    select 1 from public.staff_payroll_status_history sh
    where sh.merchant_id = p_merchant_id
      and sh.compensation_type in ('daily_wage', 'hourly_wage')
  );
  v_wage_includes_estimate := (p_start_date <= private.wage_today() and p_end_date >= private.wage_today());
  select coalesce(sum((private.compute_staff_wage_by_range(h.staff_id, p_start_date, p_end_date) ->> 'total_pay')::numeric), 0)
  into v_total_wage_payout
  from (
    select distinct sh.staff_id
    from public.staff_payroll_status_history sh
    where sh.merchant_id = p_merchant_id
      and sh.compensation_type in ('daily_wage', 'hourly_wage')
  ) h;

  -- 2026-09-24(任務 2):母體改成「區間內至少有一個月份,在該月的 as_of 時間點 existed 且
  -- status=active」的人——跟上面 11.6 逐月加總用的是同一套 as_of 算式(含 least(..., p_end_date)
  -- 的裁切)與同一組條件,兩邊母體必然一致。compensation_type 取「區間內最後一個當時在職月份」
  -- 的值(同一個人可能中途改過計酬類型;取最後一個月份跟 §11 一貫的「月底當下的值」慣例一致)。
  -- 這同時修掉一個附帶的對不起來:已離職的按件計酬人員,他的抽成一直都被算進
  -- total_commission_payout(那個查詢只看 merchant_id + computed_at,不看人員狀態),卻沒有
  -- 任何一列明細承載它。
  for rec in
    with months as (
      select
        gs::date as month_start,
        ((least((gs + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
          at time zone 'Asia/Taipei') - interval '1 microsecond' as as_of
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    staff_months as (
      select
        ms.id, ms.name, ms.display_order, ms.created_at, m.month_start, s.compensation_type,
        -- is_active_as_of 的來源:merchant_staff.status 是「目前」的狀態(語意說明見單月版註解)。
        (ms.status = 'active') as is_currently_active
      from public.merchant_staff ms
      cross join months m
      join lateral private.get_staff_payroll_status_as_of(ms.id, m.as_of) s on true
      where ms.merchant_id = p_merchant_id
        and s.existed
        and s.status = 'active'
    )
    select
      id,
      name,
      is_currently_active,
      (array_agg(compensation_type order by month_start desc))[1] as compensation_type
    from staff_months
    -- is_currently_active 對同一個 id 只有一個值(它來自 merchant_staff 那一列),放進 group by
    -- 只是為了讓它能被 select,不會讓分組變細。
    group by id, name, is_currently_active, display_order, created_at
    order by display_order, created_at, id
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      if v_salary_applicable then
        -- §3.6:跨月時依區間內實際涵蓋的每個月份分別計算「當月實際天數」再加總,不是整個區間套用
        -- 同一個天數——private.compute_staff_payroll_by_range 內部已經處理這個邏輯。
        v_payroll := private.compute_staff_payroll_by_range(rec.id, p_start_date, p_end_date);
        v_total_salary_deduction := v_total_salary_deduction
          + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

        -- #1035 A 批 PA-B01:這位月薪人員區間內每個月份的獎金加總。
        select coalesce(sum((private.compute_staff_monthly_bonus(rec.id, m.month_start::date) ->> 'amount')::numeric), 0)
        into v_staff_bonus
        from generate_series(
          date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
        ) as m(month_start);

        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', v_payroll -> 'net_pay',
          'commission_amount', null,
          'bonus_amount', v_staff_bonus
        );
      else
        -- 任務 3:不是完整月份時,月薪制人員照樣列在明細上(order_count 仍然有意義),
        -- 但 net_pay 回 null,代表「這個區間算不出月薪實發」,不是「實發 0 元」。
        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', null,
          'commission_amount', null,
          'bonus_amount', null
        );
      end if;
    elsif rec.compensation_type in ('daily_wage', 'hourly_wage') then
      -- #1035 B 批 PB-B01:日薪／時薪制(原本會落到下面的抽成分支、抽成 0)。
      v_staff_wage := private.compute_staff_wage_by_range(rec.id, p_start_date, p_end_date);
      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', null,
        'bonus_amount', null,
        'wage_amount', (v_staff_wage ->> 'total_pay')::numeric,
        'worked_minutes', (v_staff_wage ->> 'total_worked_minutes')::int,
        'work_days', (v_staff_wage ->> 'work_days')::int,
        'wage_missing', (v_staff_wage ->> 'wage_missing')::boolean
      );
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission,
        'bonus_amount', null
      );
    end if;
  end loop;

  -- #1035 B 批 PB-B01(主腦裁決 M1):明細補上「區間內有工資」但上面母體沒有以日薪／時薪列出來的人,
  -- 讓「明細的工資加總 = total_wage_payout」:
  --   ① 月底已離職(上面母體只收月底在職的人)⇒ 另加一列(compensation_type = 區間內最後一天的日薪／時薪類型,
  --      is_active_as_of = 現在是否在職 ⇒ 前端沿用「已離職」標籤);
  --   ② 區間中途改制、上面已經用月薪 / 抽成列出來 ⇒ 在同一列多帶 wage_amount / worked_minutes / work_days / wage_missing
  --      (不另起一列,staff_id 在明細裡維持唯一)。
  -- 只掃「歷史上曾經是日薪／時薪制」的人 ⇒ 完全沒用到日薪／時薪的店不進迴圈,回傳跟 A 批逐鍵相同。
  for v_wage_staff in
    select distinct sh.staff_id
    from public.staff_payroll_status_history sh
    where sh.merchant_id = p_merchant_id
      and sh.compensation_type in ('daily_wage', 'hourly_wage')
    order by sh.staff_id
  loop
    -- 已經是日薪／時薪列 ⇒ 上面的分支已經帶了工資。
    if exists (
      select 1 from jsonb_array_elements(v_breakdown) e
      where e ->> 'staff_id' = v_wage_staff.staff_id::text
        and e ->> 'compensation_type' in ('daily_wage', 'hourly_wage')
    ) then
      continue;
    end if;

    v_staff_wage := private.compute_staff_wage_by_range(v_wage_staff.staff_id, p_start_date, p_end_date);
    if not ((v_staff_wage ->> 'total_pay')::numeric > 0 or (v_staff_wage ->> 'work_days')::int > 0) then
      continue;
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_breakdown) e where e ->> 'staff_id' = v_wage_staff.staff_id::text
    ) then
      -- ② 同一列多帶工資
      select coalesce(jsonb_agg(
               case when e ->> 'staff_id' = v_wage_staff.staff_id::text
                    then e || jsonb_build_object(
                           'wage_amount', (v_staff_wage ->> 'total_pay')::numeric,
                           'worked_minutes', (v_staff_wage ->> 'total_worked_minutes')::int,
                           'work_days', (v_staff_wage ->> 'work_days')::int,
                           'wage_missing', (v_staff_wage ->> 'wage_missing')::boolean)
                    else e end
               order by ord), '[]'::jsonb)
      into v_breakdown
      from jsonb_array_elements(v_breakdown) with ordinality as t(e, ord);
    else
      -- ① 另加一列
      select count(*)::int into v_order_count
      from public.bookings b
      where b.staff_id = v_wage_staff.staff_id
        and b.status = 'completed'
        and coalesce(b.completed_at, b.start_at) >= v_range_start
        and coalesce(b.completed_at, b.start_at) < v_range_end;

      v_breakdown := v_breakdown || (
        select jsonb_build_object(
          'staff_id', ms.id,
          'staff_name', ms.name,
          'compensation_type', v_staff_wage ->> 'latest_compensation_type',
          'order_count', v_order_count,
          'is_active_as_of', (ms.status = 'active'),
          'net_pay', null,
          'commission_amount', null,
          'bonus_amount', null,
          'wage_amount', (v_staff_wage ->> 'total_pay')::numeric,
          'worked_minutes', (v_staff_wage ->> 'total_worked_minutes')::int,
          'work_days', (v_staff_wage ->> 'work_days')::int,
          'wage_missing', (v_staff_wage ->> 'wage_missing')::boolean
        )
        from public.merchant_staff ms
        where ms.id = v_wage_staff.staff_id
      );
    end if;
  end loop;

  -- 任務 3:商家總淨利(概估毛利)是「營收 − 料錢 − 抽成 − 月薪實發」,只要月薪那一段算不出來,
  -- 整個數字就沒有意義 → 一律 null,不是拿營收減一減硬湊一個數字出來給商家看。
  if v_salary_applicable then
    v_estimated_net_margin :=
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction)
      - v_total_monthly_bonus  -- #1035 A 批:月薪獎金(沒有方案 = 0)
      - v_total_wage_payout;   -- #1035 B 批:日薪／時薪支出(沒有日薪／時薪人員 = 0)
  else
    v_estimated_net_margin := null;
  end if;

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin', v_estimated_net_margin,
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    'salary_applicable', v_salary_applicable,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count,
    -- #1035 A 批 PA-B01
    'total_monthly_bonus', v_total_monthly_bonus,
    'bonus_feature_used', v_bonus_feature_used,
    -- #1035 B 批 PB-B01
    'total_wage_payout', v_total_wage_payout,
    'wage_includes_estimate', v_wage_includes_estimate,
    'wage_feature_used', v_wage_feature_used
  );
end;
$function$;

-- ACL 照改前(create or replace 不改 ACL;重申:anon 沒有、authenticated / service_role 有)。
revoke execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) to authenticated, service_role;
