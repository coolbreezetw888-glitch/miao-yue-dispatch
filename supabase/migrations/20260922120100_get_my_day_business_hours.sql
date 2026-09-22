-- 模組 14(服務人員端)v2 §10.2.1:新函式 get_my_day_business_hours。
-- 服務人員原本完全沒有任何管道讀到商家的營業時間(merchant_business_hours 的 SELECT 政策要求
-- can_manage_business_hours,服務人員不符合),這次需求 2(時間軸格線)/需求 3(時段排休分頁)
-- 都需要知道「今天幾點開門幾點打烊」,所以新增一支小函式共用給這兩個需求。
--
-- 只檢查 is_own_staff_row(不額外檢查任何 section_key)——營業時間本身不是敏感資料,真正的功能
-- 存取控制留給呼叫端頁面的路由守衛(比照既有 4.3/4.4 頁面已經在做的事)。
--
-- 回傳形狀故意跟既有 get_merchant_day_schedule 的 business_hours 物件完全一致
-- (has_setting/is_closed/open_time/close_time),讓前端能直接沿用既有處理 businessHours 的邏輯,
-- 不用重新設計一套解析方式。動工前已用 execute_sql 查證 get_merchant_day_schedule 正式環境目前
-- 的完整定義,這裡的查詢邏輯直接比照它的寫法(day_of_week 換算、查無列/公休時 open_time/
-- close_time 維持 null,不額外處理——跟既有函式行為一致)。

create or replace function public.get_my_day_business_hours(p_staff_id uuid, p_date date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_day_of_week smallint;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的營業時間' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  v_day_of_week := extract(dow from p_date)::smallint;

  select true, is_closed, open_time, close_time
  into v_has_hours, v_is_closed, v_open_time, v_close_time
  from public.merchant_business_hours
  where merchant_id = v_merchant_id and day_of_week = v_day_of_week;

  return jsonb_build_object(
    'has_setting', coalesce(v_has_hours, false),
    'is_closed', coalesce(v_is_closed, true),
    'open_time', v_open_time,
    'close_time', v_close_time
  );
end;
$function$;

comment on function public.get_my_day_business_hours(uuid, date) is '模組 14(服務人員端)v2 §10.2.1:服務人員自助查詢自己所屬商家某一天的營業時間,只檢查 is_own_staff_row(不額外檢查 section_key,營業時間本身不敏感)。回傳形狀比照 get_merchant_day_schedule 的 business_hours 物件({has_setting, is_closed, open_time, close_time}),供時間軸格線(10.2.3)/時段排休分頁(10.3.3)共用。規則 2.4:傳入別人的 staff_id 一律被擋下。';

revoke all on function public.get_my_day_business_hours(uuid, date) from public, anon;
grant execute on function public.get_my_day_business_hours(uuid, date) to authenticated;
