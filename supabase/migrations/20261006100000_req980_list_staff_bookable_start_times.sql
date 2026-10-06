-- SPECS-INDEX #980(2026-10-06):建單 / 改單選時間時,只列出「這位服務人員這天真正可以約的開始時間」。
-- 規格:.project/specs/建單畫面與下拉刷新-第2批.md 第二節
--
-- ═══ 為什麼新增這支唯讀 RPC,而不是前端自己算 ═══════════════════════════════════════
-- 規格書 §2 第 5 點:「以後端為準,前端算出的清單要和送出時後端的檢查一致」。
-- 送出時真正擋時段的是 private.check_staff_booking_slot(由 validate_booking_selection 呼叫),它疊了:
--   營業時間 ∩ 服務人員每週時段、單日例外(含「例外開啟」可以超出平常時段)、請假、跨日、
--   unlimited_backend_edit 跳過邊界(但請假照擋)、嚴格工時衝突檢查開關(查無設定 = 預設開啟)、
--   同集團同一人跨店佔用(#924)、編輯時排除自己。
-- 前端如果照抄一份,只要其中一條哪天改了,兩邊就會各說各話(「清單列得出來、送出卻被擋」)。
-- ⇒ 這支函式**不自己判斷任何規則**,只是把一天的 48 個半小時起點逐一丟給**同一支**
--   private.check_staff_booking_slot 試算,沒被擋下的才回傳。判斷條件永遠只有一份。
--
-- ═══ 不改既有函式 ═══════════════════════════════════════════════════════════════════
-- 本檔只新增一支函式,沒有 create or replace 任何既有函式、沒有任何 INSERT/UPDATE/DELETE。
-- check_staff_booking_slot 本來就只讀資料(raise 擋下或什麼都不做),在 begin…exception 子交易裡
-- 呼叫它不會留下任何副作用。
--
-- ═══ 權限(supabase-permission-hygiene 規則 1)═════════════════════════════════════════
--   ・security definer:要以 owner 身份呼叫 private.check_staff_booking_slot。
--   ・第一行就檢查 private.can_manage_bookings(p_merchant_id)(跟 get_merchant_day_schedule /
--     create_booking 同一條權限):只有這間商家的管理員、或有「訂單」權限的客服才能查。
--   ・服務人員必須屬於 p_merchant_id 且在職;p_exclude_booking_id 必須屬於 p_merchant_id
--     (否則 A 店可以拿 B 店的訂單 id 來試探「排除這筆之後有沒有空」,屬跨租戶試探)。
--   ・revoke public, anon;grant authenticated(前端要直接呼叫)。
--   ・只回傳「HH:MI」字串陣列,不回傳任何訂單、客戶、別家分店的資訊。

create or replace function public.list_staff_bookable_start_times(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_date date,
  p_duration_minutes integer,
  p_exclude_booking_id uuid default null
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff public.merchant_staff;
  v_minutes integer;
  v_start timestamptz;
  v_result text[] := '{}'::text[];
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的可預約時間' using errcode = '42501';
  end if;

  if p_date is null or p_duration_minutes is null or p_duration_minutes < 1 or p_duration_minutes > 1440 then
    raise exception '查詢可預約時間的參數不正確' using errcode = '22023';
  end if;

  if p_exclude_booking_id is not null and not exists (
    select 1 from public.bookings b
    where b.id = p_exclude_booking_id and b.merchant_id = p_merchant_id
  ) then
    raise exception '找不到這筆預約' using errcode = '42501';
  end if;

  -- 跟 private.validate_booking_selection 第 2 步同一個條件:屬於這間商家、在職。
  select * into v_staff
  from public.merchant_staff
  where id = p_staff_id and merchant_id = p_merchant_id and status = 'active';
  if not found then
    return v_result;
  end if;

  -- 一天 48 個半小時起點(跟建單畫面的 SLOT_MINUTES = 30 一致)。
  v_minutes := 0;
  while v_minutes < 1440 loop
    v_start := (p_date::timestamp + make_interval(mins => v_minutes)) at time zone 'Asia/Taipei';
    begin
      -- 🔴 跟 validate_booking_selection 呼叫主要服務人員時**完全相同的參數**(角色標籤只影響錯誤訊息)。
      perform private.check_staff_booking_slot(
        p_merchant_id,
        v_staff,
        v_start,
        v_start + make_interval(mins => p_duration_minutes),
        p_exclude_booking_id,
        '主要服務人員'
      );
      v_result := v_result || to_char(make_time(v_minutes / 60, v_minutes % 60, 0), 'HH24:MI');
    exception
      -- 只吞「規則擋下」(RAISE EXCEPTION 預設 SQLSTATE P0001);其他真正的錯誤照常往外丟,
      -- 不會被誤當成「這個時段不能約」而默默消失。
      when raise_exception then
        null;
    end;
    v_minutes := v_minutes + 30;
  end loop;

  return v_result;
end;
$$;

comment on function public.list_staff_bookable_start_times(uuid, uuid, date, integer, uuid) is 'SPECS-INDEX #980(2026-10-06):建單 / 改單的時間選單只列出能約的開始時間。把 p_date(台北日曆日)的 48 個半小時起點逐一交給 private.check_staff_booking_slot 試算(區間 = 起點 + p_duration_minutes,參數與 validate_booking_selection 呼叫主要服務人員時相同),沒被擋下的才以 HH:MI 字串回傳 —— 判斷規則(營業時間、每週時段、單日例外、請假、unlimited_backend_edit、嚴格工時衝突檢查、同集團跨店佔用、編輯時排除自己)全部沿用同一支函式,不另寫一套。權限:private.can_manage_bookings;服務人員須屬於該商家且在職(否則回空陣列);p_exclude_booking_id 須屬於該商家(否則 42501)。唯讀,不寫入任何資料。';

revoke execute on function public.list_staff_bookable_start_times(uuid, uuid, date, integer, uuid) from public, anon;
grant execute on function public.list_staff_bookable_start_times(uuid, uuid, date, integer, uuid) to authenticated;
