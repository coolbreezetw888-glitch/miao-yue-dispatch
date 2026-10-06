-- SPECS-INDEX #980 QA 打回(2026-10-06):修 private.check_staff_booking_slot 的兩個既有 bug。
-- 主腦裁決 (b) + 追加第 3 點:修既有函式本身;**起點在整點 / 半點的既有情境,判斷結果必須完全不變**
-- (主腦就此破例允許修改既有函式;規格書原文「不可修改既有函式行為」)。
--
-- ═══ 問題 1:無限迴圈 ═══════════════════════════════════════════════════════════════
-- 逐格迴圈原本用 time 型別:`v_slot_start := v_slot_start + 30 分`。time 超過 24:00 會繞回 00:00,
-- 所以預約結束時間落在 23:30~24:00(不含兩端)時:23:30 那一格 +30 分 = 00:00 < 結束時間 ⇒ 永遠跑不完。
-- 例:非 30 倍數工時(20 / 45 / 100 分鐘、自訂工時)的 23:00 起點;客服手動送 23:00 起 40 分鐘的單也會卡。
-- list_staff_bookable_start_times 會主動試 23:00 起點 ⇒ 必踩 ⇒ 時間選單轉圈約 40 秒後報錯。
-- (若當天在 00:00 之後的某一格剛好有「單日排休」,繞回之後會撞到它而結束 —— 所以不是每次都卡。)
--
-- ═══ 問題 2:起點不在整點 / 半點時,單日例外查不到(主腦追加第 3 點要求先查清楚現況)═════════
-- 單日例外 staff_availability_overrides 的鍵值是半小時格線(09:00、09:30…)。原本迴圈從預約起點開始
-- 每次 +30 分鐘,起點 09:05 ⇒ 拿 09:05、09:35 去查 ⇒ 永遠查不到任何例外:
--   ・誤放行:09:05~10:05 碰到 10:00~10:30 的「單日排休」,原本照樣放行(排休被忽略)
--   ・誤擋  :19:05~19:25 落在 19:00~19:30 的「單日開啟」(平常時段外),原本被擋(開啟被忽略)
-- 營業時間 / 每週時段那一層(private.check_staff_legacy_range)本來就是「整段範圍」比對,用的是實際時間,
-- 起點不在整點時判斷本來就正確(09:05~10:05 必須整段落在同一組每週時段內),這次沒有動它。
--
-- ═══ 修法(只動迴圈相關幾行,其餘逐字沿用)═════════════════════════════════════════════
--   ① declare 多四個變數:v_grid_start / v_grid_slot(time)、v_elapsed / v_total(interval)
--   ② 迴圈前:v_grid_start = 起點往前取到整點 / 半點(起點本來就在整點 / 半點 ⇒ 就是起點本身);
--      v_elapsed = 0;v_total = 結束 − v_grid_start
--   ③ 迴圈條件改 `while v_elapsed < v_total`;每一格:
--        v_grid_slot  = v_grid_start + v_elapsed            ← 查單日例外的鍵值
--        v_slot_start = greatest(v_grid_slot, 預約起點)     ← 這次預約實際用到這一格的起點
--        v_check_end  = v_grid_start + least(v_elapsed + 30 分, v_total)
--   ④ 單日例外查詢條件 slot_start_time = v_grid_slot(原本是 v_slot_start)
--   ⑤ 迴圈尾 `v_elapsed := v_elapsed + 30 分`(原本 `v_slot_start := v_slot_end`)
-- 等價性:起點在整點 / 半點 ⇒ v_grid_start = 起點 ⇒ 每一格的 v_grid_slot = v_slot_start、v_check_end
-- 跟原本逐字相同(且不會繞回:迴圈只在同一天、結束 < 24:00 時執行)⇒ 判斷結果與錯誤訊息都不變。
-- pgTAP req980_02 用 pg_temp 複製一份原版逐一比對(30 倍數工時 × 48 個起點 × 兩位服務人員)。
-- 原本 v_slot_end 變數保留宣告(已不再使用),避免無謂的差異。
--
-- ═══ 底稿指紋(supabase-permission-hygiene 規則 6)═══════════════════════════════════
--   正式庫(主腦提供):prosrc 換行正規化成 LF 後的 md5 = c6901da4f3d76432fbd80f432054deeb
--   本機 db reset 後同一算法                          = c6901da4f3d76432fbd80f432054deeb ✅
--   底稿 = 20261001010000_req924_cross_store_occupancy_group_scope.sql 的函式本體(CRLF→LF 後同一指紋)
--
-- ═══ 權限 ═══════════════════════════════════════════════════════════════════════
-- 改前本機 ACL:postgres=X/postgres | authenticated=X/postgres(沒有 PUBLIC / anon)。
-- create or replace 不會重設權限,下面仍整組重寫一次,確保改後 ACL 與改前一致。
--
-- ⚠️ 本檔沒有任何 INSERT/UPDATE/DELETE,只有函式定義與 comment。

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
  v_slot_start time;
  v_slot_end time;
  v_check_end time;
  -- 2026-10-06 #980 QA:迴圈改用「從半小時格線起點經過多久」(interval)計時,不再用 time 型別逐格相加
  -- (23:30 + 30 分會繞回 00:00 ⇒ 無限迴圈);並以半小時格線查單日例外(起點不在整點 / 半點時原本查不到例外)。
  v_grid_start time;
  v_grid_slot time;
  v_elapsed interval;
  v_total interval;
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
    -- #980 QA:格線起點 = 預約起點往前取到整點 / 半點(09:05 ⇒ 09:00);起點本來就在整點 / 半點時 = 起點本身。
    v_grid_start := v_local_start - make_interval(secs => (extract(epoch from v_local_start) % 1800)::double precision);
    v_elapsed := interval '0 minutes';
    v_total := v_local_end - v_grid_start;
    v_run_start := null;
    v_run_end := null;
    while v_elapsed < v_total loop
      -- v_grid_slot = 這一格在半小時格線上的鍵值(查單日例外用);
      -- [v_slot_start, v_check_end) = 這次預約實際用到這一格的部分(第一格可能從 09:05 開始,最後一格可能在 10:05 結束)。
      v_grid_slot := v_grid_start + v_elapsed;
      v_slot_start := greatest(v_grid_slot, v_local_start);
      v_check_end := v_grid_start + least(v_elapsed + interval '30 minutes', v_total);

      select is_available into v_override_is_available
      from public.staff_availability_overrides
      where staff_id = p_staff.id
        and override_date = v_local_date
        and slot_start_time = v_grid_slot;

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

      v_elapsed := v_elapsed + interval '30 minutes';
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

    -- SPECS-INDEX #924(2026-10-01):「同一個人在別的分店」只在**同一集團內**比對。
    -- 原本這段 EXISTS 掃的是**整個平台**的 merchant_staff(沒有任何商家/集團過濾),
    -- 兩間毫不相關的商家只要各有一人填到同一支電話就會互相擋單,錯誤訊息還會告訴 A 店
    -- 「這個人在另一間店有預約」(跨租戶資訊洩漏,資安清單 #16 / #17)。
    -- 判定條件統一收在 private.same_person_staff_ids_in_group(),get_merchant_day_schedule /
    -- get_my_day_schedule_state 的灰色「跨店佔用」格用的是**同一支**,三邊不可能各說各話
    -- (否則會出現「行事曆顯示空的、送出卻被擋」)。
    -- 錯誤訊息照規格書 §12.7 第 3 點:{角色}「{姓名}」只指本店自己的人(p_role_label + p_staff.name),
    -- 不帶別家分店店名、客戶、訂單內容(資安清單 #17)。p_role_label 為助手時本身已是 '助手「姓名」',
    -- 就不再重複補姓名。
    if exists (
      select 1
      from private.same_person_staff_ids_in_group(p_staff.id) as other_staff(staff_id)
      where private.staff_booking_conflict_exists(other_staff.staff_id, p_start_at, p_end_at, p_exclude_booking_id)
    ) then
      raise exception '%在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員',
        case
          when strpos(p_role_label, '「') > 0 then p_role_label
          else format('%s「%s」', p_role_label, p_staff.name)
        end;
    end if;
  end if;
end;
$$;

comment on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) is '對應規格書 §5.3(模組 5/6/9)+ 模組 7(排班與休假管理)規則 2.7:以半小時為單位逐格檢查商家整體營業時間(第一層)∩服務人員每週時段(第二層)∩單日例外(第三層,staff_availability_overrides)的疊加結果,任何一格不合格就整筆擋下且指出具體時段。unlimited_backend_edit=true 時第一/二/三層(邊界檢查)一併跳過,優先權最高。**主腦裁示(取代排班與休假管理.md 規格書原文規則 2.8 的設計)**:請假整天判斷(模組 7)放在 v_bypass_bounds 判斷區塊之外,一律執行,不受 unlimited_backend_edit 影響——請假期間一律擋下建單,沒有覆寫例外,要安排工作請先呼叫 cancel_staff_leave 取消請假紀錄。無任何單日例外資料時,「無例外的連續格子」會先累積成一段再套用 private.check_staff_legacy_range 的整段判斷(修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界預約被誤判放行的漏洞),因此逐格判斷結果與模組 5 原本的整段範圍判斷完全等價。規則 2.4/2.6 衝突檢查邏輯不變,是獨立的判斷維度,不受第三層或請假判斷影響。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次。只給本模組內部函式呼叫,不對外暴露。【SPECS-INDEX #924,2026-10-01】「同一個人在別的分店」只在**同一集團內**比對(private.same_person_staff_ids_in_group,跟兩支行事曆函式共用同一支);不同集團的商家完全隔離、互不擋單。錯誤訊息改成「{角色}「{姓名}」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員」({角色}/{姓名} 是本店自己的服務人員:p_role_label + p_staff.name;助手的 p_role_label 已含姓名就原樣用),不洩漏別家分店的店名/客戶/訂單。【SPECS-INDEX #980 QA,2026-10-06】① 逐格迴圈改用「從半小時格線起點經過多久」(interval)計時,不再用 time 型別逐格 +30 分鐘:原本結束時間落在 23:30~24:00(不含兩端)時 23:30+30 分會繞回 00:00 造成無限迴圈。② 起點不在整點 / 半點(例 09:05)時,單日例外改用半小時格線鍵值(09:00、09:30…)查詢,每一格只檢查預約實際用到的部分;原本會用 09:05、09:35 這種鍵值去查而永遠查不到,單日排休被忽略(誤放行)、單日開啟也被忽略(誤擋)。起點在整點 / 半點的情境判斷結果完全不變。';

revoke execute on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) to authenticated;
