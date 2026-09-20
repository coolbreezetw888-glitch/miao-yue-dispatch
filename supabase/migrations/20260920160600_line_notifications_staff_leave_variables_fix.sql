-- 模組 11:LINE 通知 — bug fix(SPECS-INDEX 編號 385)。
--
-- 問題:staff_leave_created 事件的預設文案含 {{staff_name}}/{{booking_date}},但
-- line-notify-dispatch 只在 body.booking_id 有值時才呼叫 render_booking_notification_variables
-- 取得變數;staff_leave_created 事件傳的是 staff_leave_record_id(沒有 booking_id),導致變數永遠
-- 是空物件 {},實際發送出去的訊息會把 {{staff_name}}/{{booking_date}} 原樣送給收訊人看到。
--
-- 修法:新增這支 render_staff_leave_notification_variables,比照 20260920160400 migration
-- render_booking_notification_variables(3.9)的既有寫法跟權限設定(SECURITY DEFINER,
-- revoke execute from public, anon, authenticated; grant execute to service_role),
-- 讓 line-notify-dispatch 依 staff_leave_record_id 呼叫這支函式取得變數。
--
-- leave_type_name 讀 leave_type_name_snapshot,不重新 join merchant_leave_types 查詢目前名稱
-- ——這是這個 codebase 已經踩過、修過的坑(假別改名/刪除後,歷史紀錄要維持當時登記的名稱)。
--
-- 查無資料時回傳空物件 {}(不像 render_booking_notification_variables 找不到訂單時 raise
-- exception)——這裡刻意選擇「安靜」路徑,因為呼叫端(line-notify-dispatch)本來就已經把
-- rpc 呼叫的 error 當成「拿不到變數」處理、變數維持空物件並繼續往下走(不影響請假本身是否
-- 登記成功),讓函式本身直接回傳空物件比讓呼叫端額外多一層 error log 更直接。
create or replace function public.render_staff_leave_notification_variables(p_staff_leave_record_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_record public.staff_leave_records;
  v_staff_name text;
  v_merchant_name text;
  v_booking_date text;
begin
  select * into v_record from public.staff_leave_records where id = p_staff_leave_record_id;
  if v_record.id is null then
    return '{}'::jsonb;
  end if;

  select ms.name, m.name
  into v_staff_name, v_merchant_name
  from public.merchant_staff ms
  join public.merchants m on m.id = ms.merchant_id
  where ms.id = v_record.staff_id;

  if v_record.start_date = v_record.end_date then
    v_booking_date := to_char(v_record.start_date, 'YYYY-MM-DD');
  else
    v_booking_date := to_char(v_record.start_date, 'YYYY-MM-DD') || ' 至 ' || to_char(v_record.end_date, 'YYYY-MM-DD');
  end if;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'staff_name', coalesce(v_staff_name, ''),
    'booking_date', coalesce(v_booking_date, ''),
    'leave_type_name', coalesce(v_record.leave_type_name_snapshot, '')
  );
end;
$$;

comment on function public.render_staff_leave_notification_variables(uuid) is 'bug fix(SPECS-INDEX 385):組裝 staff_leave_created 通知文案要用的變數(merchant_name/staff_name/booking_date/leave_type_name)。leave_type_name 讀 leave_type_name_snapshot,不重新 join merchant_leave_types(已知坑)。查無資料回傳空物件 {},不報錯。只給 line-notify-dispatch 用 service role 呼叫。';

revoke execute on function public.render_staff_leave_notification_variables(uuid) from public, anon, authenticated;
grant execute on function public.render_staff_leave_notification_variables(uuid) to service_role;
