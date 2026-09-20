-- 模組 14:服務人員端(功能層,第七支)。
-- 對應規格書 3.15(get_my_booking_schedule)、規則 2.4(核心必測)/2.5/2.6。
--
-- 動工前已用 execute_sql 查詢正式環境 get_merchant_day_schedule 的最新完整定義,確認
-- bookings/booking_assistants/booking_service_items/service_items 的正確 join 方式(以正式環境
-- 目前實際結構為準,不是憑規格書示意欄位名稱照抄)。

create or replace function public.get_my_booking_schedule(
  p_staff_id uuid,
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
  v_merchant_id uuid;
  v_show_member_info boolean;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_result jsonb;
begin
  -- 1. 規則 2.4(核心必測):必須是本人,且已開通 staff_calendar_view。
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的行事曆' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_calendar_view') then
    raise exception '尚未開通行事曆檢視功能,請洽商家管理員' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 2. 範圍上限(建議 62 天,避免一次查詢範圍過大拖垮效能)。
  if (p_end_date - p_start_date) > 62 then
    raise exception '查詢範圍不能超過 62 天,請分批查詢' using errcode = '22023';
  end if;

  select ms.merchant_id, ms.show_member_info
  into v_merchant_id, v_show_member_info
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  v_range_start := (p_start_date::timestamp) at time zone 'Asia/Taipei';
  v_range_end := ((p_end_date + 1)::timestamp) at time zone 'Asia/Taipei';

  -- 3. 規則 2.5:涵蓋「主要服務人員」與「助手」兩種身份(比照 set_staff_day_override 既有的
  -- 既有預約衝突查詢邏輯,bookings 跟 booking_assistants 兩邊都查)。
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', bb.id,
      'start_at', bb.start_at,
      'end_at', bb.end_at,
      'status', bb.status,
      'role_in_booking', bb.role_in_booking,
      'customer_name', bb.customer_name,
      'customer_phone', bb.customer_phone,
      'customer_address', bb.customer_address,
      'notes', bb.notes,
      'customer_notes', bb.customer_notes,
      'service_item_names', coalesce(si_agg.names, '[]'::jsonb),
      'final_amount_snapshot', bb.final_amount_snapshot,
      -- 規則 2.6:基本資訊一律回傳,只有 show_member_info=true 時才附上會員專屬欄位;
      -- 沒有連結會員(member_id is null)時這幾項一律是 null,跟關掉開關時的結果一致。
      'is_member', case when v_show_member_info then (bb.member_id is not null) else null end,
      'member_name', case
        when v_show_member_info and bb.member_id is not null then bb.member_name_snapshot
        else null
      end,
      'member_points_balance', case
        when v_show_member_info and bb.member_id is not null then m.points_balance
        else null
      end
    )
    order by bb.start_at
  ), '[]'::jsonb)
  into v_result
  from (
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      'primary'::text as role_in_booking
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
    union all
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      'assistant'::text as role_in_booking
    from public.booking_assistants ba
    join public.bookings b on b.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
  ) bb
  left join public.members m on m.id = bb.member_id
  left join lateral (
    select jsonb_agg(si.name order by si.name) as names
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = bb.id
  ) si_agg on true;

  return v_result;
end;
$$;

comment on function public.get_my_booking_schedule(uuid, date, date) is '對應規格書 3.15/規則 2.4/2.5/2.6:服務人員自助查看自己排程用的唯讀彙整函式。SECURITY DEFINER,先檢查 is_own_staff_row + has_own_staff_permission(staff_calendar_view),回傳 [p_start_date, p_end_date] 這段期間內(Asia/Taipei 日曆日)自己以主要服務人員或助手身份參與、狀態不是 cancelled 的預約清單。查詢範圍上限 62 天。基本資訊一律回傳,會員專屬欄位(is_member/member_name/member_points_balance)依 merchant_staff.show_member_info 決定是否回傳,關閉時一律 null。';

revoke execute on function public.get_my_booking_schedule(uuid, date, date) from public, anon;
grant execute on function public.get_my_booking_schedule(uuid, date, date) to authenticated;
