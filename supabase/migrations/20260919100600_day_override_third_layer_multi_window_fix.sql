-- 模組 6(訂單管理,第二批)§5.3 修正:主腦複查抓到的真正邏輯漏洞。
--
-- **問題**:20260919100200_day_override_third_layer.sql 版本的 private.check_staff_booking_slot,
-- 對於「沒有被單日例外覆蓋」的半小時格子,是逐格獨立檢查「存在某一組 staff_availability_windows
-- 覆蓋這一格」,而不是要求「整個沒有例外覆蓋的連續區段,必須被同一組時段完整涵蓋」。
-- 這導致「同一天有兩組相鄰時段」(既有系統本來就支援的資料型態,例如師傅上午 09:00-10:00、
-- 下午 10:00-12:00 分兩筆設定)時,一筆橫跨兩組時段交界的預約(例如 09:30-10:30),即使沒有
-- 任何一組時段能單獨涵蓋整段,也會因為每一格分別都能在「某一組」裡找到落腳處而被誤判通過。
-- 這違反了規格書 §5.3 第 4 點要求的等價性(無任何單日例外時,逐格判斷結果必須跟模組 5 原本的
-- 整段範圍判斷結果完全一致)。原本的 pgTAP 等價性測試(module6_04 PART A)沒有涵蓋到「同一天
-- 多組時段」這個情境,所以沒有抓到這個漏洞。
--
-- **修法**:把「查無例外,回歸既有規則判斷」的部分,從「逐格獨立檢查」改成「先把連續的無例外
-- 格子累積成一段,遇到下一個有例外的格子、或迴圈跑完時,才把整段一次拿去跟原本的整段判斷邏輯
-- (是否完整落在商家營業時間內、以及是否存在『同一組』staff_availability_windows 完整涵蓋整段)
-- 比對」。有例外設定的格子維持原本逐格檢查的做法不變(例外資料本身就是逐格存的,不需要連續性
-- 判斷)。抽出 private.check_staff_legacy_range 這支小型內部輔助函式,避免「累積區段驗證」的
-- 邏輯在『遇到例外格子時提前結算』跟『迴圈跑完後結算』兩個地方各寫一份重複程式碼。
--
-- 簽章、回傳型別、呼叫方式完全不變(create or replace),差異只在函式內部邏輯。
create or replace function private.check_staff_legacy_range(
  p_staff public.merchant_staff,
  p_day_of_week smallint,
  p_has_hours boolean,
  p_is_closed boolean,
  p_open_time time,
  p_close_time time,
  p_range_start time,
  p_range_end time,
  p_role_label text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  -- 規則 2.1∩2.2:這一整段(不是單一半小時格子)必須完整落在商家營業時間內,
  -- 而且(no_time_slot_limit 者除外)必須存在「同一組」staff_availability_windows
  -- 完整涵蓋這一整段——不能分別用不同組時段拼湊涵蓋這一段的頭尾。
  v_ok := coalesce(p_has_hours, false)
    and not coalesce(p_is_closed, true)
    and p_range_start >= p_open_time
    and p_range_end <= p_close_time;

  if v_ok and not p_staff.no_time_slot_limit then
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
$$;

comment on function private.check_staff_legacy_range(public.merchant_staff, smallint, boolean, boolean, time, time, time, time, text) is '規則 2.1∩2.2 的「整段範圍」判斷(不是逐格判斷):[p_range_start, p_range_end) 這一整段是否完整落在商家營業時間內,且存在同一組 staff_availability_windows 完整涵蓋整段。給 private.check_staff_booking_slot 內部呼叫,用來驗證「沒有被單日例外覆蓋的連續區段」,修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界的預約被誤判放行的漏洞。只給本模組內部函式呼叫,不對外暴露。';

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
  v_run_start time;
  v_run_end time;
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
    --
    -- **修正重點(主腦複查抓到的漏洞)**:「查無例外」的格子不能逐格獨立檢查「存在某一組時段
    -- 覆蓋這一格」——那樣會讓橫跨兩組相鄰時段交界的預約被誤判通過。改成用 v_run_start/v_run_end
    -- 把連續的「無例外」格子累積成一段,遇到下一個「有例外」的格子時、或迴圈跑完時,才把整段
    -- 一次拿去跟原本的整段判斷邏輯(private.check_staff_legacy_range)比對,確保「無任何單日例外
    -- 時,逐格判斷結果與模組 5 原本的整段範圍判斷結果完全一致」(§5.3 第 4 點)。
    v_slot_start := v_local_start;
    v_run_start := null;
    v_run_end := null;
    while v_slot_start < v_local_end loop
      v_slot_end := v_slot_start + interval '30 minutes';
      v_check_end := least(v_slot_end, v_local_end);

      select is_available into v_override_is_available
      from public.staff_availability_overrides
      where staff_id = p_staff.id
        and override_date = v_local_date
        and slot_start_time = v_slot_start;

      if found then
        -- 遇到有例外的格子:先把前面累積、還沒驗證的「無例外連續區段」一次驗證掉
        -- (不能留到迴圈結束才驗證,因為這個例外格子把連續區段切斷了)。
        if v_run_start is not null then
          perform private.check_staff_legacy_range(
            p_staff, v_day_of_week, v_has_hours, v_is_closed, v_open_time, v_close_time,
            v_run_start, v_run_end, p_role_label
          );
          v_run_start := null;
          v_run_end := null;
        end if;

        -- §5.3 第 1 點:有例外,直接採用例外的 is_available,不論前兩層原本判斷結果是什麼。
        if not v_override_is_available then
          raise exception '%的%到%這個時段目前不可預約(已設定臨時關閉)', p_role_label, v_slot_start, v_check_end;
        end if;
        -- is_available = true:例外開啟,這一格直接放行,不需要再檢查商家營業時間/服務人員時段。
      else
        -- §5.3 第 1 點:查無例外,累積進「無例外連續區段」,先不急著判斷,等區段結束
        -- (遇到下一個有例外的格子,或迴圈跑完)才把整段一次套用跟原本整段判斷完全相同的條件
        -- (等價性見檔案開頭與 20260919100200_day_override_third_layer.sql 的說明)。
        if v_run_start is null then
          v_run_start := v_slot_start;
        end if;
        v_run_end := v_check_end;
      end if;

      v_slot_start := v_slot_end;
    end loop;

    -- 迴圈跑完後,如果還有累積中、尚未驗證的「無例外連續區段」(例如整個 [start,end) 都沒有
    -- 任何例外設定,或最後一段沒有以例外格子收尾),要在這裡補驗證,不能漏掉。
    if v_run_start is not null then
      perform private.check_staff_legacy_range(
        p_staff, v_day_of_week, v_has_hours, v_is_closed, v_open_time, v_close_time,
        v_run_start, v_run_end, p_role_label
      );
    end if;
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

comment on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) is '對應規格書 §5.3(取代模組 5 擴充原本「整段範圍一次判斷」的寫法):以半小時為單位逐格檢查商家整體營業時間(第一層)∩服務人員每週時段(第二層)∩單日例外(第三層,staff_availability_overrides)的疊加結果,任何一格不合格就整筆擋下且指出具體時段。unlimited_backend_edit=true 時整組(含第三層)一併跳過,優先權最高。無任何單日例外資料時,「無例外的連續格子」會先累積成一段再套用 private.check_staff_legacy_range 的整段判斷(修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界預約被誤判放行的漏洞),因此逐格判斷結果與模組 5 原本的整段範圍判斷完全等價(見 supabase/tests/database/module6_04_day_override_third_layer.sql PART A 的驗證方式,以及本次新增的多組相鄰時段驗證)。規則 2.4/2.6 衝突檢查邏輯不變,是獨立的判斷維度,不受第三層影響。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次。只給本模組內部函式呼叫,不對外暴露。';
