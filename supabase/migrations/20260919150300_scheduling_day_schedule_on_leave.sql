-- 模組 7:排班與休假管理 — get_merchant_day_schedule 疊加 on_leave 欄位(3.7)。
--
-- ⚠️ 動工前置確認(規格書 §233 事故教訓,已遵守):以下函式主體是直接讀取目前正式環境/最新
-- migration(20260919100300_day_override_schedule_query.sql)裡 get_merchant_day_schedule
-- 的完整最新版本,在這個版本的基礎上只新增 on_leave 欄位這一段,其餘邏輯逐字保留,不是從舊版本
-- 或規格書示意片段裡複製函式主體。

create or replace function public.get_merchant_day_schedule(
  p_merchant_id uuid,
  p_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_day_of_week smallint;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_staff jsonb;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的行事曆' using errcode = '42501';
  end if;

  v_day_of_week := extract(dow from p_date)::smallint;
  v_day_start := (p_date::timestamp) at time zone 'Asia/Taipei';
  v_day_end := ((p_date + 1)::timestamp) at time zone 'Asia/Taipei';

  select true, is_closed, open_time, close_time
  into v_has_hours, v_is_closed, v_open_time, v_close_time
  from public.merchant_business_hours
  where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

  select coalesce(jsonb_agg(staff_block), '[]'::jsonb)
  into v_staff
  from (
    select jsonb_build_object(
      'staff_id', ms.id,
      'staff_name', ms.name,
      'no_time_slot_limit', ms.no_time_slot_limit,
      'available_windows', (
        case
          when coalesce(v_has_hours, false) is false or coalesce(v_is_closed, true) then '[]'::jsonb
          when ms.no_time_slot_limit then
            jsonb_build_array(jsonb_build_object('start_time', v_open_time, 'end_time', v_close_time))
          else coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'start_time', greatest(saw.start_time, v_open_time),
                'end_time', least(saw.end_time, v_close_time)
              )
              order by saw.start_time
            )
            from public.staff_availability_windows saw
            where saw.staff_id = ms.id
              and saw.day_of_week = v_day_of_week
              and saw.start_time < v_close_time
              and saw.end_time > v_open_time
          ), '[]'::jsonb)
        end
      ),
      -- 模組 6 §5.5 第 3 點:這位服務人員這一天的單日例外設定,合併相鄰同值的半小時格子
      -- 成一個個區間(標準的「gaps and islands」分組寫法:偵測跟上一格是否緊鄰且 is_available
      -- 相同,不緊鄰或值不同就視為新的一段,再用累加和當分組鍵)。
      'availability_overrides', coalesce((
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
              where staff_id = ms.id and override_date = p_date
            ) marked
          ) grouped
          group by grp_id, is_available
        ) merged
      ), '[]'::jsonb),
      -- 模組 7(排班與休假管理)§3.7(新增):這位服務人員這一天是否整天請假。查無資料時是
      -- SQL null,前端據此判斷這位服務人員這天是否整天休假。用 leave_type_name_snapshot 快照欄位,
      -- 不重新 join merchant_leave_types 查詢目前名稱(比照模組 9 §234 的教訓)。
      'on_leave', (
        select jsonb_build_object('leave_record_id', slr.id, 'leave_type_name', slr.leave_type_name_snapshot)
        from public.staff_leave_records slr
        where slr.staff_id = ms.id
          and slr.status = 'confirmed'
          and p_date between slr.start_date and slr.end_date
        limit 1
      ),
      -- 本店預約(規則 2.6 第 3 點:完整顯示客戶/服務項目資訊,因為是自家資料)。
      -- 同時涵蓋「主要服務人員」跟「助手」兩種身份(4.2 第 2 點),用 role 欄位標示。
      'bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', bb.id,
            'start_at', bb.start_at,
            'end_at', bb.end_at,
            'status', bb.status,
            'customer_name', bb.customer_name,
            'customer_phone', bb.customer_phone,
            'notes', bb.notes,
            'role', bb.role,
            'service_items', coalesce(si_agg.items, '[]'::jsonb)
          )
          order by bb.start_at
        )
        from (
          select b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone, b.notes, 'main'::text as role
          from public.bookings b
          where b.staff_id = ms.id
            and b.merchant_id = p_merchant_id
            and b.status <> 'cancelled'
            and b.start_at < v_day_end
            and b.end_at > v_day_start
          union all
          select b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone, b.notes, 'assistant'::text as role
          from public.booking_assistants ba
          join public.bookings b on b.id = ba.booking_id
          where ba.staff_id = ms.id
            and b.merchant_id = p_merchant_id
            and b.status <> 'cancelled'
            and b.start_at < v_day_end
            and b.end_at > v_day_start
        ) bb
        left join lateral (
          select jsonb_agg(jsonb_build_object('id', si.id, 'name', si.name) order by si.name) as items
          from public.booking_service_items bsi
          join public.service_items si on si.id = bsi.service_item_id
          where bsi.booking_id = bb.id
        ) si_agg on true
      ), '[]'::jsonb),
      -- 跨商家占用(規則 2.6 第 3 點:只回傳起訖時間,不回傳對方的客戶/商家細節)。
      -- 同時涵蓋對方以「主要服務人員」或「助手」身份占用的情境。
      'foreign_bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at)
          order by fb.start_at
        )
        from (
          select fb.start_at, fb.end_at
          from public.bookings fb
          join public.merchant_staff fms on fms.id = fb.staff_id
          where fms.id <> ms.id
            and private.normalize_phone(fms.phone) is not null
            and private.normalize_phone(fms.phone) = private.normalize_phone(ms.phone)
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
          union all
          select fb.start_at, fb.end_at
          from public.booking_assistants fba
          join public.bookings fb on fb.id = fba.booking_id
          join public.merchant_staff fms on fms.id = fba.staff_id
          where fms.id <> ms.id
            and private.normalize_phone(fms.phone) is not null
            and private.normalize_phone(fms.phone) = private.normalize_phone(ms.phone)
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
        ) fb
      ), '[]'::jsonb)
    ) as staff_block
    from public.merchant_staff ms
    where ms.merchant_id = p_merchant_id and ms.status = 'active'
    order by ms.name
  ) staff_blocks;

  return jsonb_build_object(
    'date', p_date,
    'business_hours', jsonb_build_object(
      'has_setting', coalesce(v_has_hours, false),
      'is_closed', coalesce(v_is_closed, true),
      'open_time', v_open_time,
      'close_time', v_close_time
    ),
    'staff', v_staff
  );
end;
$$;

comment on function public.get_merchant_day_schedule(uuid, date) is '對應規格書 3.6/5.3,建單功能擴充 4.2,模組 6 §5.5 第 3 點,模組 7(排班與休假管理)§3.7:給行事曆總覽頁使用,回傳當天(Asia/Taipei)所有在職服務人員的可預約邊界(第一層∩第二層,不含第三層——第三層例外另外用 availability_overrides 陣列回傳,由前端疊加判斷最終顯示狀態)、單日例外區間(合併相鄰同值半小時格子)、是否整天請假(on_leave,查無資料為 null,含快照假別名稱)、本店預約明細(含多服務項目陣列、main/assistant 角色標示)、跨商家占用概況(不洩漏對方客戶/商家細節)。回傳 jsonb。';
