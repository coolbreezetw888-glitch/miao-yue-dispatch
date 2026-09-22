-- 模組 14(服務人員端)v2 品管打回重做(SPECS-INDEX 編號 485)——修正 get_merchant_day_schedule
-- 合併 staff_availability_overrides 時的 24:00 跨日回捲 bug。
--
-- ⚠️ 動工前置確認:以下函式主體是直接用 pg_get_functiondef 查證正式環境這支函式目前的最新
-- 完整定義(疊加 on_leave 欄位後的版本,20260919150300_scheduling_day_schedule_on_leave.sql
-- 那一版,這次 v2 完全沒有修改過這支函式),在這個版本的基礎上只修正 availability_overrides
-- 這一段的 grp_end 計算方式,其餘邏輯(business_hours/available_windows/on_leave/bookings/
-- foreign_bookings,以及一般不跨 24:00 的合併情況)逐字保留,不是從規格書描述或猜測重建。
--
-- 根因(品管已用 execute_sql 直接查證,不是臆測):原本寫法
--   max(slot_start_time) + interval '30 minutes' as grp_end
-- 當這一組合併區間的最後一格是 23:30(「整天排休」一定會產生這種情況,因為服務人員自助標記
-- 整天休假時,前端呼叫 set_staff_day_override(staffId, date, '00:00', '24:00', false) 涵蓋
-- 00:00~23:30 全部 48 格,詳見 20260922120000_fix_set_staff_day_override_24h_boundary.sql)時,
-- PostgreSQL 的 time 型別加法是「一天之內取模」運算——'23:30:00'::time + interval '30 minutes'
-- 算出來是 '00:00:00'(回捲到當天開始),不會進位到隔天。這導致合併後的區間變成
-- start=00:00/end=00:00(零寬度區間),前端 CalendarPage.tsx 的 matchedOverride 比對邏輯
-- (timeToMinutes(o.start_time) <= slotStartMin && timeToMinutes(o.end_time) >= slotEndMin)
-- 永遠比對不到這一筆,整天的例外關閉因此在商家管理員視角的行事曆上完全「消失」——格線顯示成
-- 完全可預約,下拉選單顯示「新增預約」而不是「例外關閉」樣式。
--
-- 這是跟同一次修正 set_staff_day_override 一模一樣的邊界值 bug(time+interval 跨日回捲),
-- 只是發生在另一支既有函式裡,修法比照辦理:把 grp_end 的計算從「time 型別直接相加」改成
-- 「當日分鐘數(整數)相加」,最後再用 make_time 組回 time 型別——PostgreSQL 的 time 型別明確
-- 允許 24:00:00 這個代表「一天結束」的邊界值(已用 execute_sql 實測驗證
-- make_time(24,0,0) = '24:00:00',序列化進 jsonb 後也是字串 "24:00:00",不會回捲,前端
-- timeToMinutes("24:00:00") 正確解析成 1440),不會再有回捲問題。

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
      --
      -- 模組 14 v2 品管打回修正(SPECS-INDEX 編號 485):grp_end 改用「當日分鐘數」整數運算
      -- (0~1440)算出後再用 make_time 組回 time 型別,不直接對 time 型別做 `+ interval` 相加
      -- ——time 型別加法在跨過 24:00:00 時會回捲成 00:00:00(不會進位),當最後一格是 23:30
      -- (「整天排休」一定會產生這種情況)時,合併後的區間會變成 start=00:00/end=00:00
      -- (零寬度),前端比對邏輯永遠比對不到,整天排休因此在商家管理員視角完全「消失」。
      -- 這裡的 grp_end_minutes 最大值恰好是 1440(23:30 這格 +30 分鐘),make_time(24,0,0)
      -- 是 PostgreSQL 明確允許的邊界值,已用 execute_sql 實測確認不會拋錯、也不會回捲。
      'availability_overrides', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'start_time', grp_start,
            'end_time', make_time(grp_end_minutes / 60, grp_end_minutes % 60, 0),
            'is_available', grp_is_available
          )
          order by grp_start
        )
        from (
          select min(slot_start_time) as grp_start,
                 (
                   extract(hour from max(slot_start_time))::int * 60
                   + extract(minute from max(slot_start_time))::int
                   + 30
                 ) as grp_end_minutes,
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

comment on function public.get_merchant_day_schedule(uuid, date) is '對應規格書 3.6/5.3,建單功能擴充 4.2,模組 6 §5.5 第 3 點,模組 7(排班與休假管理)§3.7,模組 14 v2 §485 修正:給行事曆總覽頁使用,回傳當天(Asia/Taipei)所有在職服務人員的可預約邊界(第一層∩第二層,不含第三層——第三層例外另外用 availability_overrides 陣列回傳,由前端疊加判斷最終顯示狀態)、單日例外區間(合併相鄰同值半小時格子,grp_end 用當日分鐘數整數運算避免 24:00 跨日回捲導致整天排休消失的 bug)、是否整天請假(on_leave,查無資料為 null,含快照假別名稱)、本店預約明細(含多服務項目陣列、main/assistant 角色標示)、跨商家占用概況(不洩漏對方客戶/商家細節)。回傳 jsonb。';
