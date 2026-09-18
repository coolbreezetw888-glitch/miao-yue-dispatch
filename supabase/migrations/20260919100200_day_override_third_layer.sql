-- 模組 6:訂單管理(第二批)— §5.3 單日例外第三層,正式接進 private.check_staff_booking_slot。
--
-- **這是本次任務風險最高的一步,務必先讀完再往下看**:這支函式是 create_booking/update_booking
-- 共用的邊界驗證邏輯(透過 private.validate_booking_selection 對主要服務人員與每位助手各自呼叫一次)。
-- 這份 migration 之前,supabase/tests/database/module6_04_day_override_third_layer.sql 的 PART A
-- (8 條斷言,完全沒有布置任何 staff_availability_overrides 資料)已經先對著**修改前**的這支函式
-- 跑過一次,全數通過——這是規格書 §5.3 第 4 點要求的安全網基準。這份 migration 套用之後,
-- PART A 那 8 條斷言要在**完全不改測試檔案內容**的前提下重新跑一次,依然全數通過,才能證明
-- 「無例外時,新的逐格判斷邏輯跟原本的整段範圍判斷邏輯結果完全一致」。
--
-- 設計方式(§5.3):簽章、回傳型別、呼叫方式完全不變(create or replace),差異只在函式內部——
-- 原本「一次性判斷整段 [start_at, end_at) 是否落在商家營業時間∩服務人員時段的某個連續範圍內」,
-- 改成「以半小時為單位逐格判斷,每一格先看有沒有 staff_availability_overrides 例外設定,有則直接
-- 採用例外的 is_available 值(不論前兩層原本判斷結果是什麼);沒有則對這一格分別重新套用原本的
-- 商家營業時間∩服務人員時段判斷(§5.3 第 1 點)」。unlimited_backend_edit 覆寫例外(規則 2.3)
-- 優先權比第三層更高,連第三層都一併跳過(§5.3 第 2 點)。任何一格不合格就整筆擋下,錯誤訊息
-- 具體指出是哪個時段(§5.3 第 3 點)。
create or replace function private.check_staff_booking_slot(
  p_merchant_id uuid,
  p_staff public.merchant_staff,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_booking_id uuid,
  p_role_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass_bounds boolean;
  v_local_date date;
  v_day_of_week smallint;
  v_local_start time;
  v_local_end time;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_strict_conflict boolean;
  v_normalized_phone text;
  v_slot_start time;
  v_slot_end time;
  v_check_end time;
  v_override_is_available boolean;
  v_legacy_slot_ok boolean;
  v_window_ok boolean;
begin
  -- 規則 2.3/§5.3 第 2 點:unlimited_backend_edit 覆寫例外優先權最高,連第三層單日例外也一併跳過。
  v_bypass_bounds := p_staff.unlimited_backend_edit;

  if not v_bypass_bounds then
    if date(p_start_at at time zone 'Asia/Taipei') <> date(p_end_at at time zone 'Asia/Taipei') then
      raise exception '%的預約時段跨到隔天,目前系統不支援,請拆成同一天內的時段', p_role_label;
    end if;

    v_local_date := date(p_start_at at time zone 'Asia/Taipei');
    v_day_of_week := extract(dow from (p_start_at at time zone 'Asia/Taipei'))::smallint;
    v_local_start := (p_start_at at time zone 'Asia/Taipei')::time;
    v_local_end := (p_end_at at time zone 'Asia/Taipei')::time;

    select true, is_closed, open_time, close_time
    into v_has_hours, v_is_closed, v_open_time, v_close_time
    from public.merchant_business_hours
    where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

    -- §5.3:以半小時為單位逐格檢查 [v_local_start, v_local_end)。
    -- §4.3 交叉提醒:自訂工時是客服輸入的任意分鐘數,不保證是 30 的倍數,所以整段長度不一定剛好
    -- 對齊半小時格線——迴圈仍然以 v_local_start 為起點、每次固定推進 30 分鐘(對齊
    -- staff_availability_overrides 的半小時格線鍵值去查例外),但最後一格如果超出 v_local_end,
    -- 交集檢查(v_check_end)只看「實際用到的部分」,不要求整個半小時格子都要合格
    -- ——避免把一個 70 分鐘的自訂工時,因為最後一格「多算」了 20 分鐘而被誤判超出邊界。
    v_slot_start := v_local_start;
    while v_slot_start < v_local_end loop
      v_slot_end := v_slot_start + interval '30 minutes';
      v_check_end := least(v_slot_end, v_local_end);

      select is_available into v_override_is_available
      from public.staff_availability_overrides
      where staff_id = p_staff.id
        and override_date = v_local_date
        and slot_start_time = v_slot_start;

      if found then
        -- §5.3 第 1 點:有例外,直接採用例外的 is_available,不論前兩層原本判斷結果是什麼。
        if not v_override_is_available then
          raise exception '%的%到%這個時段目前不可預約(已設定臨時關閉)', p_role_label, v_slot_start, v_check_end;
        end if;
        -- is_available = true:例外開啟,這一格直接放行,不需要再檢查商家營業時間/服務人員時段。
      else
        -- §5.3 第 1 點:查無例外,回歸既有規則 2.1∩2.2 交集判斷,對這一格分別檢查
        -- (無例外情況下,對每一格都套用跟原本整段判斷完全相同的條件,等價性見檔案開頭說明)。
        v_legacy_slot_ok := coalesce(v_has_hours, false)
          and not coalesce(v_is_closed, true)
          and v_slot_start >= v_open_time
          and v_check_end <= v_close_time;

        if v_legacy_slot_ok and not p_staff.no_time_slot_limit then
          select exists (
            select 1 from public.staff_availability_windows
            where staff_id = p_staff.id
              and day_of_week = v_day_of_week
              and start_time <= v_slot_start
              and end_time >= v_check_end
          ) into v_window_ok;
          v_legacy_slot_ok := v_window_ok;
        end if;

        if not v_legacy_slot_ok then
          raise exception '%的%到%這個時段不可預約(超出商家營業時間,或超出服務人員可預約時段設定)',
            p_role_label, v_slot_start, v_check_end;
        end if;
      end if;

      v_slot_start := v_slot_end;
    end loop;
  end if;

  -- 規則 2.4/2.6 衝突檢查不變(跟第三層是獨立的判斷維度,不受單日例外影響)。
  select enabled into v_strict_conflict
  from public.merchant_feature_flags
  where merchant_id = p_merchant_id and feature_key = 'strict_conflict_check';
  if v_strict_conflict is null then
    v_strict_conflict := true; -- 查無資料視為預設開啟
  end if;

  if v_strict_conflict then
    if private.staff_booking_conflict_exists(p_staff.id, p_start_at, p_end_at, p_exclude_booking_id) then
      raise exception '%在這個時段已經有其他預約', p_role_label;
    end if;

    v_normalized_phone := private.normalize_phone(p_staff.phone);
    if v_normalized_phone is not null then
      if exists (
        select 1
        from public.merchant_staff ms2
        where ms2.id <> p_staff.id
          and private.normalize_phone(ms2.phone) = v_normalized_phone
          and private.staff_booking_conflict_exists(ms2.id, p_start_at, p_end_at, p_exclude_booking_id)
      ) then
        raise exception '%在這個時段已經在另一間店有預約', p_role_label;
      end if;
    end if;
  end if;
end;
$$;

comment on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) is '對應規格書 §5.3(取代模組 5 擴充原本「整段範圍一次判斷」的寫法):以半小時為單位逐格檢查商家整體營業時間(第一層)∩服務人員每週時段(第二層)∩單日例外(第三層,staff_availability_overrides)的疊加結果,任何一格不合格就整筆擋下且指出具體時段。unlimited_backend_edit=true 時整組(含第三層)一併跳過,優先權最高。無任何單日例外資料時,逐格判斷結果與模組 5 原本的整段範圍判斷完全等價(見 supabase/tests/database/module6_04_day_override_third_layer.sql PART A 的驗證方式)。規則 2.4/2.6 衝突檢查邏輯不變,是獨立的判斷維度,不受第三層影響。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次。只給本模組內部函式呼叫,不對外暴露。';
