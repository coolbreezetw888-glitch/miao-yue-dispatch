-- 模組 7:排班與休假管理 — private.check_staff_booking_slot 疊加請假判斷(3.6/規則 2.7)。
--
-- ⚠️ 主腦裁示,跟規格書原文有出入的地方(以這裡為準,見規格書第〇節判斷 5/規則 2.7/2.8):
-- 規格書原本把請假整天判斷放在 v_bypass_bounds(unlimited_backend_edit)判斷區塊「裡面」,
-- 代表這個開關開啟時連請假限制也會被跳過。主腦裁定:**請假限制不應該被 unlimited_backend_edit
-- 覆寫,不論這個開關是否開啟,只要服務人員當天有 confirmed 的請假紀錄,一律擋下建單**。
-- 理由:unlimited_backend_edit 原本的語意是「後台編輯不受時段限制」,適用於「服務人員的可預約
-- 時段設定」這類偏好性質的限制;但請假代表「這個人明確表示這天不會出勤」,是更明確的事實陳述,
-- 不應該被一個原本設計來處理排程彈性的開關悄悄蓋過去——真的要在請假期間安排這位服務人員工作,
-- 正確流程應該是先呼叫 cancel_staff_leave 取消請假紀錄(這只需要一個按鈕),再正常建單。
-- 落實方式:把請假整天判斷移到 v_bypass_bounds 判斷區塊「之外」,一律執行、不受這個開關影響。
--
-- ⚠️ 動工前置確認(規格書 §233 事故教訓,已遵守):以下函式主體是直接讀取目前正式環境/最新
-- migration(20260919100600_day_override_third_layer_multi_window_fix.sql)裡
-- private.check_staff_booking_slot 的完整最新版本,在這個版本的基礎上只新增請假判斷這一段,
-- 其餘邏輯逐字保留,不是從舊版本或規格書示意片段裡複製函式主體。
-- private.check_staff_legacy_range 這支輔助函式完全不動,不在這支 migration 裡重複定義。

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
  v_leave_type_name text;
begin
  -- 規則 2.3/§5.3 第 2 點:unlimited_backend_edit 覆寫例外優先權最高,連第三層單日例外也一併跳過。
  v_bypass_bounds := p_staff.unlimited_backend_edit;

  -- 模組 7(排班與休假管理)規則 2.7,主腦裁示版本(取代規格書原文規則 2.8 的設計):
  -- 請假整天判斷放在這裡——v_bypass_bounds 判斷區塊「之外」,一律執行,不受 unlimited_backend_edit
  -- 影響。用 daterange 疊加比對(而不是只比對 p_start_at 的當地日期),涵蓋 unlimited_backend_edit
  -- 情境下理論上可能發生的跨日預約,確保只要預約範圍落在的任何一個日曆天有請假紀錄就擋下。
  -- 用 leave_type_name_snapshot 這個快照欄位顯示假別名稱,不重新 join merchant_leave_types
  -- 查詢目前名稱(比照模組 9 §234 已經踩過、修過的坑)。
  select slr.leave_type_name_snapshot into v_leave_type_name
  from public.staff_leave_records slr
  where slr.staff_id = p_staff.id
    and slr.status = 'confirmed'
    and daterange(slr.start_date, slr.end_date, '[]') && daterange(
          date(p_start_at at time zone 'Asia/Taipei'),
          date(p_end_at at time zone 'Asia/Taipei'),
          '[]'
        )
  limit 1;

  if v_leave_type_name is not null then
    raise exception '%這天是休假日(假別:%),無法預約', p_role_label, v_leave_type_name;
  end if;

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

comment on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) is '對應規格書 §5.3(模組 5/6/9)+ 模組 7(排班與休假管理)規則 2.7:以半小時為單位逐格檢查商家整體營業時間(第一層)∩服務人員每週時段(第二層)∩單日例外(第三層,staff_availability_overrides)的疊加結果,任何一格不合格就整筆擋下且指出具體時段。unlimited_backend_edit=true 時第一/二/三層(邊界檢查)一併跳過,優先權最高。**主腦裁示(取代排班與休假管理.md 規格書原文規則 2.8 的設計)**:請假整天判斷(模組 7)放在 v_bypass_bounds 判斷區塊之外,一律執行,不受 unlimited_backend_edit 影響——請假期間一律擋下建單,沒有覆寫例外,要安排工作請先呼叫 cancel_staff_leave 取消請假紀錄。無任何單日例外資料時,「無例外的連續格子」會先累積成一段再套用 private.check_staff_legacy_range 的整段判斷(修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界預約被誤判放行的漏洞),因此逐格判斷結果與模組 5 原本的整段範圍判斷完全等價。規則 2.4/2.6 衝突檢查邏輯不變,是獨立的判斷維度,不受第三層或請假判斷影響。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次。只給本模組內部函式呼叫,不對外暴露。';
