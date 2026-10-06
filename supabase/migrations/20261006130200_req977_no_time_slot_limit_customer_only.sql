-- SPECS-INDEX #977 第 3 批(2026-10-06):「客戶預約無時段限制」(merchant_staff.no_time_slot_limit)改成只管客戶預約。
-- 規格書「權限收緊與服務人員開關修正-第3批」第三節。
--
-- 改前讀到這個欄位的 SQL(本機 pg_proc 全文搜尋,只有這 3 支):
--   ① private.check_staff_legacy_range —— 後台建單 / 改單 / 拖拉 / list_staff_bookable_start_times 共用的
--      「營業時間 ∩ 每週時段」判斷;no_time_slot_limit=true 時跳過每週時段那一層。
--   ② public.get_merchant_day_schedule —— 後台行事曆每位服務人員的可約時段(true ⇒ 整段營業時間)。
--   ③ public.get_staff_schedule_overview —— 排班一覽(功能隱藏中)的「不受時段限制」。
-- 改後:三支都不看 no_time_slot_limit。
--   ① 拿掉例外 ⇒ 後台判斷只剩 unlimited_backend_edit(check_staff_booking_slot 在呼叫這支之前就跳過整段)。
--      沒開 no_time_slot_limit 的服務人員:這支的判斷式一個字都沒變 ⇒ 結果完全不變(pgTAP req977_01 用改前複製品逐一比對)。
--   ② / ③ 放寬改看 unlimited_backend_edit(跟 ① 的後台判斷同一個欄位)。回傳的 jsonb 欄位名稱同步改成
--      unlimited_backend_edit,前端型別一起改。
--      📌 這會讓「開了商家後台編輯無時段限制」的服務人員,行事曆格子從「只亮自己的時段」變成「整段營業時間都可點」——
--         這是讓畫面跟後端一致(後端本來就放行),已寫進回報請主腦確認。
-- 欄位與開關本身保留(客戶自助預約模組之後要用),畫面上的「即將推出」標籤不動。
-- 正式庫唯讀核對(主腦 2026-10-06):開著這個欄位的 271 筆全是 E2E 測試殘留商家,真實商家 0 筆。
--
-- 三支簽章都不變(create or replace,ACL 原樣保留);下面仍把 revoke / grant 整組明寫一次,ACL 跟改前完全相同。
-- ⚠️ 本檔沒有任何資料寫入。

-- ① ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_ok boolean;
begin
  -- 規則 2.1∩2.2:這一整段(不是單一半小時格子)必須完整落在商家營業時間內,
  -- 而且必須存在「同一組」staff_availability_windows 完整涵蓋這一整段——不能分別用不同組時段
  -- 拼湊涵蓋這一段的頭尾。
  -- SPECS-INDEX #977(2026-10-06,第 3 批):拿掉「no_time_slot_limit 者除外」。那個欄位改成只管
  -- 客戶線上預約(客戶自助預約模組還沒做),後台建單 / 改單一律不看它;後台要放寬只看
  -- unlimited_backend_edit(在 check_staff_booking_slot 呼叫這支之前就整段跳過)。
  v_ok := coalesce(p_has_hours, false)
    and not coalesce(p_is_closed, true)
    and p_range_start >= p_open_time
    and p_range_end <= p_close_time;

  if v_ok then
    select exists (
      select 1 from public.staff_availability_windows
      where staff_id = p_staff.id
        and day_of_week = p_day_of_week
        and start_time <= p_range_start
        and end_time >= p_range_end
    ) into v_ok;
  end if;

  if not v_ok then
    raise exception '%的%到%這個時段不可預約(超出商家營業時間,或超出服務人員可預約時段設定)',
      p_role_label, p_range_start, p_range_end;
  end if;
end;
$function$;

-- ② ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_merchant_day_schedule(p_merchant_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- SPECS-INDEX #977(2026-10-06,第 3 批):後台行事曆的可約時段不再看 no_time_slot_limit
      -- (那個欄位只留給客戶線上預約)。放寬改看 unlimited_backend_edit —— 跟 check_staff_booking_slot
      -- 的後台判斷同一個欄位,畫面才不會出現「格子灰的、送出卻能建」或反過來的落差。
      -- 回傳欄位名稱跟著改成 unlimited_backend_edit(前端行事曆沒有讀這個值,只讀 available_windows)。
      'unlimited_backend_edit', ms.unlimited_backend_edit,
      'available_windows', (
        case
          when coalesce(v_has_hours, false) is false or coalesce(v_is_closed, true) then '[]'::jsonb
          when ms.unlimited_backend_edit then
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
      -- SPECS-INDEX #924(2026-10-01):「同一個人」只在**同一集團內**成立,判定條件統一走
      -- private.same_person_staff_ids_in_group()(跟 check_staff_booking_slot 同一支),
      -- 取代原本沒有任何商家/集團過濾、掃整個平台的電話比對。
      'foreign_bookings', coalesce((
        select jsonb_agg(
          jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at)
          order by fb.start_at
        )
        from (
          select fb.start_at, fb.end_at
          from public.bookings fb
          where fb.staff_id in (select private.same_person_staff_ids_in_group(ms.id))
            and fb.status <> 'cancelled'
            and fb.start_at < v_day_end
            and fb.end_at > v_day_start
          union all
          select fb.start_at, fb.end_at
          from public.booking_assistants fba
          join public.bookings fb on fb.id = fba.booking_id
          where fba.staff_id in (select private.same_person_staff_ids_in_group(ms.id))
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
$function$;

-- ③ ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_staff_schedule_overview(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    select id, name, unlimited_backend_edit
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

      -- ①每週固定時段摘要:unlimited_backend_edit=true 標記「不受時段限制」,否則列出
      -- (SPECS-INDEX #977,2026-10-06 第 3 批:改前看 no_time_slot_limit;那個欄位只留給客戶線上預約,
      --  後台的放寬一律看 unlimited_backend_edit,跟 check_staff_booking_slot / 行事曆同一個欄位)
      -- staff_availability_windows 當天(day_of_week)的時段清單(可能是空陣列=未設定)。
      if v_staff.unlimited_backend_edit then
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
      'unlimited_backend_edit', v_staff.unlimited_backend_edit,
      'days', v_days
    ));
  end loop;

  return jsonb_build_object(
    'start_date', p_start_date,
    'end_date', p_end_date,
    'staff', v_staff_result
  );
end;
$function$;

-- ACL:跟改前相同。check_staff_legacy_range 改前沒有任何 revoke / grant(proacl 為 NULL = 預設),
-- 這裡刻意不動(只被 SECURITY DEFINER 的 check_staff_booking_slot 呼叫;private schema 沒有對外開放)。
revoke execute on function public.get_merchant_day_schedule(uuid, date) from public, anon;
grant execute on function public.get_merchant_day_schedule(uuid, date) to authenticated;
grant execute on function public.get_merchant_day_schedule(uuid, date) to service_role;

revoke execute on function public.get_staff_schedule_overview(uuid, date, date) from public, anon;
grant execute on function public.get_staff_schedule_overview(uuid, date, date) to authenticated;
grant execute on function public.get_staff_schedule_overview(uuid, date, date) to service_role;
