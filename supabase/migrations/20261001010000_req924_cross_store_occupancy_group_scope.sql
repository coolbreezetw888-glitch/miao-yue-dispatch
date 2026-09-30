-- SPECS-INDEX #924(2026-10-01,第二波):跨店佔用判定只在**同一集團內**成立,錯誤訊息不洩漏別家店。
-- 規格:.project/specs/建單自動建立會員與會員兩層狀態.md §12.4
--
-- ═══ 使用者裁決(原話)═══════════════════════════════════════════════════════════════
-- 「兩間毫不相關的商家不會有擋單的問題,因為店家之間是完全隔離的,除非放在同一個集團底下,
--   才會有判斷時段佔用的機制。」
--
-- ═══ 修之前的缺陷 ══════════════════════════════════════════════════════════════════
-- 三支函式都用「服務人員電話正規化後相等」認定「同一個人」,但那段查詢**完全沒有商家/集團過濾**,
-- 掃的是整個平台的 merchant_staff:
--   ① private.check_staff_booking_slot  → 🔴 直接 raise 擋掉建單,訊息「…已經在另一間店有預約」
--      (等於告訴 A 商家「這支電話的人在別家店那個時段有工作」,資安清單 #16 跨租戶 / #17 資訊洩漏)
--   ② public.get_merchant_day_schedule  → 商家端行事曆出現錯誤的灰色「跨店佔用」格
--   ③ public.get_my_day_schedule_state  → 服務人員端出現錯誤的灰色「跨店佔用」格
-- 正式庫已有一支電話出現在 9 間不相關商家(e2e 測試資料),這 9 人目前互相擋單。
--
-- ═══ 修法 ═══════════════════════════════════════════════════════════════════════════
-- 新增一支輔助函式 private.same_person_staff_ids_in_group(p_staff_id),回傳「跟這位服務人員
-- 是同一個人、而且在**同一集團**底下」的其他 merchant_staff.id。三支函式**全部改用這一支**,
-- 判定條件只有一份 —— 否則會出現「行事曆顯示空的、送出卻被擋」這種最難解釋的狀態。
--   ・同一集團 = 兩邊 merchants.group_id 相等(group_id 目前是 not null;仍寫 is not null 防呆:
--     任一邊沒有集團關係 ⇒ 一律不比對)。
--   ・同一個人 = private.normalize_phone(phone) 相等且非 null —— **判定方式不改**:
--     merchant_staff.phone 有 CHECK(^09\d{8}$),只能存個人手機,同集團內兩筆同電話 = 同一人
--     在集團內跨店上班,正是該擋的情況(主腦已查證,「公司市話/分機」風險不成立)。
--   ・同一間商家裡兩筆同電話(同商家必然同集團)⇒ 照舊比對,行為不變。
--   ・不另外加 status 過濾 —— 原本的比對也沒有,這次只收斂範圍,不順手改其他語意。
--
-- ═══ 錯誤訊息(check_staff_booking_slot)═══════════════════════════════════════════════
-- 規格書 §12.7 第 3 點(2026-10-01 使用者裁決,取代 §12.4 原本的「這位服務人員…」):
--   「{角色}「{姓名}」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員」
-- {角色}/{姓名} 沿用改版前訊息的角色標籤(p_role_label)與**本店**這位服務人員的姓名(p_staff.name),
-- 只會是本店自己的人;不帶別家分店店名、客戶、訂單內容。
-- 📌 p_role_label 的兩種值(private.validate_booking_selection):主要服務人員 = '主要服務人員'(不含姓名)、
--    助手 = '助手「姓名」'(已經含姓名)⇒ 已含「」的就原樣用,否則補上「姓名」,避免助手變成「助手「X」「X」」。
--
-- ═══ 動工前指紋核對(2026-10-01,正式庫唯讀 SELECT md5(pg_proc.prosrc),本機 CRLF→LF 後比對)═══
--   get_merchant_day_schedule  正式 f934772caf1bde87181f326b4aa701c0(7941)
--                               本機 20260922120300 → f934772caf1bde87181f326b4aa701c0(7941)✅ 逐字一致
--   get_my_day_schedule_state  正式 d1326e041e541d43531021e44f12edde(2966)
--                               本機 20260923020100 → d1326e041e541d43531021e44f12edde(2966)✅ 逐字一致
--   check_staff_booking_slot   正式 bdd4168932c9ea9be8a010953173c0bf(4054)
--                               本機 20260919150200 → 79850ab636321916b4673f91e6e75eec(5683)⚠️ 原文不同;
--                               把本機本體的註解行/行尾註解拿掉後 → bdd4168932c9ea9be8a010953173c0bf(4054)✅
--                               ⇒ 差異**只有註解**(supabase-permission-hygiene 規則 6 記錄過的 apply_migration
--                                 壓縮註解現象),可執行 SQL 完全一致,repo 檔案是正本 ⇒ 以 repo 檔案為基準。
-- 三支函式除了下面標 #924 的地方,其餘內容逐字沿用上列版本。
--
-- ═══ 簽章 / 權限 ════════════════════════════════════════════════════════════════════
-- 三支函式簽章、回傳型別都不變 ⇒ create or replace,不 drop,既有 ACL 原樣保留(create or replace 不會重設權限)。
-- 新的輔助函式是 security invoker、只被上面三支 SECURITY DEFINER 函式以 owner 身份呼叫 ⇒
-- 照 supabase-permission-hygiene 規則 1 三個角色全部收回,只留 service_role。
--
-- 附帶(§12.5 小尾巴 2):private.is_valid_taiwan_phone 的 comment 重寫成現況(六個呼叫端)。
--
-- ⚠️ 本檔沒有任何 INSERT/UPDATE/DELETE,只有函式定義與 comment。

-- =========================================================================
-- 0. 輔助函式:同一集團內、同一個人(電話相同)的其他服務人員
-- =========================================================================
create or replace function private.same_person_staff_ids_in_group(p_staff_id uuid)
returns setof uuid
language sql
stable
set search_path = public
as $$
  select other_staff.id
  from public.merchant_staff me
  join public.merchants me_merchant on me_merchant.id = me.merchant_id
  join public.merchant_staff other_staff on other_staff.id <> me.id
  join public.merchants other_merchant on other_merchant.id = other_staff.merchant_id
  where me.id = p_staff_id
    -- 同一集團才比對;任一邊沒有集團 ⇒ 不比對(null = null 在 SQL 裡本來就不成立,這裡明寫防呆)
    and me_merchant.group_id is not null
    and other_merchant.group_id = me_merchant.group_id
    -- 同一個人的判定方式不改:電話正規化後相等,自己沒填電話 ⇒ 沒有人跟他同一個人
    and private.normalize_phone(me.phone) is not null
    and private.normalize_phone(other_staff.phone) = private.normalize_phone(me.phone);
$$;

comment on function private.same_person_staff_ids_in_group(uuid) is 'SPECS-INDEX #924(2026-10-01):回傳跟 p_staff_id 是「同一個人」、而且在**同一集團**(merchants.group_id 相等)底下的其他 merchant_staff.id(不含自己)。同一個人 = private.normalize_phone(phone) 相等且非 null(merchant_staff.phone 有 ^09\d{8}$ 約束,只能是個人手機)。不同集團一律不比對 —— 使用者裁決:毫不相關的商家完全隔離,只有同集團才有跨店時段佔用。private.check_staff_booking_slot(擋建單)、public.get_merchant_day_schedule / public.get_my_day_schedule_state(灰色跨店佔用格)三支**共用這一支**,判定條件只有一份,不可以各自再寫一套。只給上述 SECURITY DEFINER 函式內部呼叫。';

revoke execute on function private.same_person_staff_ids_in_group(uuid) from public, anon, authenticated;
grant execute on function private.same_person_staff_ids_in_group(uuid) to service_role;

-- =========================================================================
-- 1. private.check_staff_booking_slot:逐字沿用 20260919150200,只改「另一間店」那一段(#924)
-- =========================================================================
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

comment on function private.check_staff_booking_slot(uuid, public.merchant_staff, timestamptz, timestamptz, uuid, text) is '對應規格書 §5.3(模組 5/6/9)+ 模組 7(排班與休假管理)規則 2.7:以半小時為單位逐格檢查商家整體營業時間(第一層)∩服務人員每週時段(第二層)∩單日例外(第三層,staff_availability_overrides)的疊加結果,任何一格不合格就整筆擋下且指出具體時段。unlimited_backend_edit=true 時第一/二/三層(邊界檢查)一併跳過,優先權最高。**主腦裁示(取代排班與休假管理.md 規格書原文規則 2.8 的設計)**:請假整天判斷(模組 7)放在 v_bypass_bounds 判斷區塊之外,一律執行,不受 unlimited_backend_edit 影響——請假期間一律擋下建單,沒有覆寫例外,要安排工作請先呼叫 cancel_staff_leave 取消請假紀錄。無任何單日例外資料時,「無例外的連續格子」會先累積成一段再套用 private.check_staff_legacy_range 的整段判斷(修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界預約被誤判放行的漏洞),因此逐格判斷結果與模組 5 原本的整段範圍判斷完全等價。規則 2.4/2.6 衝突檢查邏輯不變,是獨立的判斷維度,不受第三層或請假判斷影響。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次。只給本模組內部函式呼叫,不對外暴露。【SPECS-INDEX #924,2026-10-01】「同一個人在別的分店」只在**同一集團內**比對(private.same_person_staff_ids_in_group,跟兩支行事曆函式共用同一支);不同集團的商家完全隔離、互不擋單。錯誤訊息改成「{角色}「{姓名}」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員」({角色}/{姓名} 是本店自己的服務人員:p_role_label + p_staff.name;助手的 p_role_label 已含姓名就原樣用),不洩漏別家分店的店名/客戶/訂單。';

-- =========================================================================
-- 2. public.get_merchant_day_schedule:逐字沿用 20260922120300,只改 foreign_bookings 兩段條件(#924)
-- =========================================================================
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
$$;

comment on function public.get_merchant_day_schedule(uuid, date) is '對應規格書 3.6/5.3,建單功能擴充 4.2,模組 6 §5.5 第 3 點,模組 7(排班與休假管理)§3.7,模組 14 v2 §485 修正:給行事曆總覽頁使用,回傳當天(Asia/Taipei)所有在職服務人員的可預約邊界(第一層∩第二層,不含第三層——第三層例外另外用 availability_overrides 陣列回傳,由前端疊加判斷最終顯示狀態)、單日例外區間(合併相鄰同值半小時格子,grp_end 用當日分鐘數整數運算避免 24:00 跨日回捲導致整天排休消失的 bug)、是否整天請假(on_leave,查無資料為 null,含快照假別名稱)、本店預約明細(含多服務項目陣列、main/assistant 角色標示)、跨商家占用概況(不洩漏對方客戶/商家細節)。回傳 jsonb。【SPECS-INDEX #924,2026-10-01】foreign_bookings 只計入**同一集團內**同一個人(電話相同)在其他分店的預約,判定走 private.same_person_staff_ids_in_group(跟 check_staff_booking_slot 共用同一支);不同集團的商家不再出現灰色跨店佔用格。';

-- =========================================================================
-- 3. public.get_my_day_schedule_state:逐字沿用 20260923020100,只改 foreign_bookings 兩段條件(#924)
-- =========================================================================
create or replace function public.get_my_day_schedule_state(p_staff_id uuid, p_date date)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_on_leave jsonb;
  v_overrides jsonb;
  v_foreign_bookings jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的排程狀態' using errcode = '42501';
  end if;

  v_day_start := (p_date::timestamp) at time zone 'Asia/Taipei';
  v_day_end := ((p_date + 1)::timestamp) at time zone 'Asia/Taipei';

  select jsonb_build_object('leave_record_id', slr.id, 'leave_type_name', slr.leave_type_name_snapshot)
  into v_on_leave
  from public.staff_leave_records slr
  where slr.staff_id = p_staff_id
    and slr.status = 'confirmed'
    and p_date between slr.start_date and slr.end_date
  limit 1;

  -- staff_availability_overrides 一列 = 一個半小時格子(欄位是 slot_start_time,不是
  -- start_time/end_time 區間),這裡逐列直接回傳「這一格的起訖時間」,不做合併(呼叫端只需要
  -- 逐格比對,不需要像商家管理員版本那樣顯示合併後的區間文字)。end_time 用「當日分鐘數整數
  -- 相加」而不是對 time 型別直接 `+ interval`,比照 get_merchant_day_schedule 20260922120300
  -- 已經修過的 24:00 跨日回捲 bug 的同一種算法(23:30 這格 +30 分鐘要算出 24:00:00,不能回捲成
  -- 00:00:00)。
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'start_time', o.slot_start_time,
        'end_time', make_time(
          (extract(hour from o.slot_start_time)::int * 60 + extract(minute from o.slot_start_time)::int + 30) / 60,
          (extract(hour from o.slot_start_time)::int * 60 + extract(minute from o.slot_start_time)::int + 30) % 60,
          0
        ),
        'is_available', o.is_available
      )
      order by o.slot_start_time
    ),
    '[]'::jsonb
  )
  into v_overrides
  from public.staff_availability_overrides o
  where o.staff_id = p_staff_id and o.override_date = p_date;

  -- SPECS-INDEX #924(2026-10-01):跨店佔用只在**同一集團內**成立,判定條件統一走
  -- private.same_person_staff_ids_in_group()(跟 check_staff_booking_slot、
  -- get_merchant_day_schedule 同一支),取代原本掃整個平台的電話比對。
  select coalesce(
    jsonb_agg(jsonb_build_object('start_at', fb.start_at, 'end_at', fb.end_at) order by fb.start_at),
    '[]'::jsonb
  )
  into v_foreign_bookings
  from (
    select fb.start_at, fb.end_at
    from public.bookings fb
    where fb.staff_id in (select private.same_person_staff_ids_in_group(p_staff_id))
      and fb.status <> 'cancelled'
      and fb.start_at < v_day_end
      and fb.end_at > v_day_start
    union all
    select fb.start_at, fb.end_at
    from public.booking_assistants fba
    join public.bookings fb on fb.id = fba.booking_id
    where fba.staff_id in (select private.same_person_staff_ids_in_group(p_staff_id))
      and fb.status <> 'cancelled'
      and fb.start_at < v_day_end
      and fb.end_at > v_day_start
  ) fb;

  return jsonb_build_object(
    'on_leave', v_on_leave,
    'availability_overrides', v_overrides,
    'foreign_bookings', v_foreign_bookings
  );
end;
$function$;

comment on function public.get_my_day_schedule_state(uuid, date) is 'SPECS-INDEX #644:服務人員自助查詢自己某一天的「全天休假/時段排休/跨店佔用」狀態明細,供 MyCalendarTimelineView 渲染用。查詢邏輯逐字比照 get_merchant_day_schedule 目前版本的單一服務人員子查詢(20260922120300 24:00 跨日回捲修正版),只是 availability_overrides 這裡回傳未合併的原始列(呼叫端只需要逐格判斷,不需要合併後的區間文字)。規則 2.4:傳入別人的 staff_id 一律被擋下。【SPECS-INDEX #924,2026-10-01】foreign_bookings 只計入**同一集團內**同一個人(電話相同)在其他分店的預約,判定走 private.same_person_staff_ids_in_group(跟 check_staff_booking_slot / get_merchant_day_schedule 共用同一支)。';

-- =========================================================================
-- 4. §12.5 小尾巴 2:private.is_valid_taiwan_phone 的 comment 重寫成現況(本體不動、ACL 不動)
-- =========================================================================
comment on function private.is_valid_taiwan_phone(text) is 'SPECS-INDEX #822:客戶電話格式規則(2026-09-27 使用者裁決)。去掉空白/括號/連字號後,手機 = 09 開頭共 10 碼;市話 = 0 開頭、第二碼 2~8、共 9~10 碼,可接 #1~6 碼分機。不列舉區碼。正規表示式跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應,改一邊要同步改另一邊。【2026-10-01 現況】呼叫端共六支,全部是 SECURITY DEFINER、以 owner 身份呼叫:① public.create_booking(#822,建單客戶電話)② public.update_booking(#822,編輯訂單客戶電話)③ public.create_member(#827,會員電話選填、填了就驗)④ public.update_member(#827,同上)⑤ public.import_members_batch(#824,匯入會員逐列驗證)⑥ public.import_historical_bookings_batch(#824,匯入歷史訂單逐列驗證)。EXECUTE 只開給 service_role,呼叫端不需要放寬權限;新增呼叫端時請同步更新這段說明。';
