-- 模組 7:排班與休假管理 — get_staff_schedule_overview(3.8,排班一覽專用,新增函式)。
-- 對應規格書 §3.8:回傳這個商家所有 status='active' 服務人員,在 [p_start_date, p_end_date]
-- 這段期間每一天的:①每週固定時段摘要 ②單日例外區間 ③是否請假 ④非取消狀態預約筆數(不展開明細)。
-- 回傳結構的確切 jsonb 欄位命名不強制規定成固定格式(規格書邊界情況已明講,唯讀彙整查詢,
-- 調整空間風險低),這裡選擇「staff 陣列,每位服務人員底下再有 days 陣列」的巢狀結構。

create or replace function public.get_staff_schedule_overview(
  p_merchant_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_staff_result jsonb := '[]'::jsonb;
  v_staff record;
  v_days jsonb;
  v_cursor date;
  v_day_of_week smallint;
  v_windows jsonb;
  v_overrides jsonb;
  v_on_leave jsonb;
  v_booking_count int;
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  if not private.can_view_scheduling(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的排班一覽' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  for v_staff in
    select id, name, no_time_slot_limit
    from public.merchant_staff
    where merchant_id = p_merchant_id and status = 'active'
    order by name
  loop
    v_days := '[]'::jsonb;
    v_cursor := p_start_date;

    while v_cursor <= p_end_date loop
      v_day_of_week := extract(dow from v_cursor)::smallint;
      v_day_start := (v_cursor::timestamp) at time zone 'Asia/Taipei';
      v_day_end := ((v_cursor + 1)::timestamp) at time zone 'Asia/Taipei';

      -- ①每週固定時段摘要:no_time_slot_limit=true 標記「不受時段限制」,否則列出
      -- staff_availability_windows 當天(day_of_week)的時段清單(可能是空陣列=未設定)。
      if v_staff.no_time_slot_limit then
        v_windows := jsonb_build_array(jsonb_build_object('unrestricted', true));
      else
        select coalesce(
          jsonb_agg(
            jsonb_build_object('start_time', saw.start_time, 'end_time', saw.end_time)
            order by saw.start_time
          ),
          '[]'::jsonb
        )
        into v_windows
        from public.staff_availability_windows saw
        where saw.staff_id = v_staff.id and saw.day_of_week = v_day_of_week;
      end if;

      -- ②單日例外區間,合併相鄰同值半小時格子(比照 get_merchant_day_schedule 既有寫法)。
      select coalesce((
        select jsonb_agg(
          jsonb_build_object('start_time', grp_start, 'end_time', grp_end, 'is_available', grp_is_available)
          order by grp_start
        )
        from (
          select min(slot_start_time) as grp_start,
                 max(slot_start_time) + interval '30 minutes' as grp_end,
                 is_available as grp_is_available
          from (
            select
              slot_start_time,
              is_available,
              sum(is_new_group) over (order by slot_start_time) as grp_id
            from (
              select
                slot_start_time,
                is_available,
                case
                  when lag(slot_start_time) over (order by slot_start_time) = slot_start_time - interval '30 minutes'
                       and lag(is_available) over (order by slot_start_time) = is_available
                  then 0
                  else 1
                end as is_new_group
              from public.staff_availability_overrides
              where staff_id = v_staff.id and override_date = v_cursor
            ) marked
          ) grouped
          group by grp_id, is_available
        ) merged
      ), '[]'::jsonb) into v_overrides;

      -- ③是否請假(比照 get_merchant_day_schedule 的 on_leave 寫法,快照名稱)。
      select jsonb_build_object('leave_record_id', slr.id, 'leave_type_name', slr.leave_type_name_snapshot)
      into v_on_leave
      from public.staff_leave_records slr
      where slr.staff_id = v_staff.id
        and slr.status = 'confirmed'
        and v_cursor between slr.start_date and slr.end_date
      limit 1;

      -- ④這天這位服務人員名下(含助手身份)非取消狀態的預約筆數,只給數字不展開明細。
      select count(*) into v_booking_count
      from (
        select b.id
        from public.bookings b
        where b.staff_id = v_staff.id
          and b.merchant_id = p_merchant_id
          and b.status <> 'cancelled'
          and b.start_at < v_day_end
          and b.end_at > v_day_start
        union
        select b.id
        from public.booking_assistants ba
        join public.bookings b on b.id = ba.booking_id
        where ba.staff_id = v_staff.id
          and b.merchant_id = p_merchant_id
          and b.status <> 'cancelled'
          and b.start_at < v_day_end
          and b.end_at > v_day_start
      ) bb;

      v_days := v_days || jsonb_build_array(jsonb_build_object(
        'date', v_cursor,
        'windows', v_windows,
        'overrides', v_overrides,
        'on_leave', v_on_leave,
        'booking_count', v_booking_count
      ));

      v_cursor := v_cursor + 1;
    end loop;

    v_staff_result := v_staff_result || jsonb_build_array(jsonb_build_object(
      'staff_id', v_staff.id,
      'staff_name', v_staff.name,
      'no_time_slot_limit', v_staff.no_time_slot_limit,
      'days', v_days
    ));
  end loop;

  return jsonb_build_object(
    'start_date', p_start_date,
    'end_date', p_end_date,
    'staff', v_staff_result
  );
end;
$$;

comment on function public.get_staff_schedule_overview(uuid, date, date) is '對應規格書 §3.8:排班一覽頁專用的彙整查詢,回傳這個商家所有在職服務人員在 [p_start_date, p_end_date] 這段期間每一天的每週固定時段摘要(windows)+單日例外區間(overrides)+是否請假(on_leave,快照名稱,查無資料為 null)+非取消狀態預約筆數(booking_count,只給數字不展開明細)。SECURITY DEFINER,檢查 private.can_view_scheduling。唯讀彙整查詢,不是任何寫入行為的依據,回傳的 jsonb 欄位命名不是強制固定格式。';

revoke execute on function public.get_staff_schedule_overview(uuid, date, date) from public, anon;
grant execute on function public.get_staff_schedule_overview(uuid, date, date) to authenticated;
