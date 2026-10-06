-- SPECS-INDEX #987 第 10 批 子批 10-c:建單 / 訂單核心類錯誤訊息的半形標點改全形
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md
--
-- 做法(規格 1-3):每支函式的底稿 = 本機套完 20261007120200 之後的 pg_get_functiondef(oid),
-- 除了訊息字串裡「中文旁的半形 , : ; ! ?」改成全形以外逐字保留(空白、換行、註解、屬性都不動)。
-- 半形括號 ( )、斜線 /、金額千分位、時間冒號、% 佔位符一律不動。
-- 「名稱: %」這種冒號後面的半形空白一起拿掉(全形冒號本身就有間距)。
-- 逐字保留的證明:supabase/tests/database/req987_03_fullwidth_messages_c.sql(新訊息換回舊訊息後 md5 = 下方改前指紋)。
--
-- 本支重建 20 支函式;改前指紋 md5(replace(prosrc, E'\r\n', E'\n')):
--   20dd0b438deedf3040c0fe1b45ab9495  private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric)
--   19c1dd07edc6bb9d1392d4b53f6dd0fd  private.check_booking_points_redeemed_requires_member()
--   3e90d220bc68a96cf4228929f85a6c91  private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)
--   ca7da00e8a194242e8869172f0877b96  private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)
--   86545d74041b3a71cf197eaa761134af  private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean)
--   9577d051f0b49d261faa28dac76dc458  private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer)
--   3e131c362cef74e179ca0bf068d4312a  private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer)
--   ce64c091a92de894087be1376e32e887  private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text)
--   36df95bc55e9a519eab036c7e6dfe1bc  public.cancel_booking(p_booking_id uuid, p_reason text)
--   a1b9c712eac0b47e99f57e13a9013705  public.complete_booking(p_booking_id uuid)
--   f2bd4e2eb613e316a307f6b91b7daeb3  public.confirm_booking(p_booking_id uuid)
--   8de032182d92969cd4bd3339939c9397  public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid)
--   5ead5d7e4c229ddad154d1ee37bca8f9  public.get_booking_points_ledger(p_booking_id uuid)
--   367f2027e4b909a66142462806fd9839  public.get_completed_booking_reversal_preview(p_booking_id uuid)
--   11b37a204905a48c3cbe812b6dfbc0a0  public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)
--   a8e435488a282d73ca476b615898f343  public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)
--   cdabc100207b2e27cc062f3303b5f501  public.recalculate_booking_commission(p_booking_id uuid)
--   4cadaace0c7577340819f88a639dfc96  public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid)
--   ad73011a8c051b81809b0bf681b3c4e5  public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid)
--   4cceaae30c232e6bfa8a8115e60c62bb  public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid)

-- ===== private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric)
 RETURNS record
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_taxable_base numeric;
begin
  -- ①小計(§2.3 步驟 1):自訂總金額開關開啟時取代逐項小計。
  if coalesce(p_custom_total_amount_enabled, false) then
    if p_custom_total_amount is null then
      raise exception '已開啟自訂總金額，請輸入金額';
    end if;
    subtotal_amount := p_custom_total_amount;
  else
    subtotal_amount := coalesce(p_items_subtotal, 0);
  end if;

  -- ②折扣(§2.3 步驟 2):固定金額或百分比二選一,換算成實際扣除的金額。
  if coalesce(p_discount_enabled, false) then
    if p_discount_mode = 'fixed' then
      discount_amount := coalesce(p_discount_value, 0);
    elsif p_discount_mode = 'percentage' then
      discount_amount := round(subtotal_amount * (coalesce(p_discount_value, 0) / 100), 2);
    else
      raise exception '折扣模式必須是「固定金額」或「百分比」其中一種';
    end if;
  else
    discount_amount := 0;
  end if;

  -- 邊界情況(§2.3):折扣金額不可大於小計,超過就白話報錯擋下。
  if discount_amount > subtotal_amount then
    raise exception '折扣金額不能超過訂單小計';
  end if;

  -- ③稅金(§2.3 步驟 3):以「小計 - 折扣」當課稅基礎,不是以原始小計。
  v_taxable_base := subtotal_amount - discount_amount;
  if coalesce(p_tax_enabled, false) then
    if p_tax_mode = 'fixed' then
      tax_amount := coalesce(p_tax_value, 0);
    elsif p_tax_mode = 'percentage' then
      tax_amount := round(v_taxable_base * (coalesce(p_tax_value, 0) / 100), 2);
    else
      raise exception '稅金模式必須是「比例」或「固定金額」其中一種';
    end if;
  else
    tax_amount := 0;
  end if;

  -- ④最終金額(§2.3 步驟 4):理論上折扣已經在步驟②擋過超額,這裡是最後一道防線。
  final_amount := subtotal_amount - discount_amount + tax_amount;
  if final_amount < 0 then
    raise exception '計算出來的最終金額不能是負數，請確認折扣/稅金設定';
  end if;
end;
$function$;

revoke execute on function private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric) from PUBLIC, anon, service_role;
grant execute on function private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric) to authenticated;

-- ===== private.check_booking_points_redeemed_requires_member()(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION private.check_booking_points_redeemed_requires_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (tg_op = 'INSERT' or new.points_redeemed is distinct from old.points_redeemed)
     and new.points_redeemed > 0
     and new.member_id is null
  then
    raise exception '這筆訂單沒有連結會員，不能使用紅利點數折抵'
      using errcode = '23514';
  end if;
  return new;
end;
$function$;

revoke execute on function private.check_booking_points_redeemed_requires_member() from PUBLIC, anon, authenticated, service_role;

-- ===== private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)(改 3 則訊息)=====
CREATE OR REPLACE FUNCTION private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '%這天是休假日(假別：%)，無法預約', p_role_label, v_leave_type_name;
  end if;

  if not v_bypass_bounds then
    if date(p_start_at at time zone 'Asia/Taipei') <> date(p_end_at at time zone 'Asia/Taipei') then
      raise exception '%的預約時段跨到隔天，目前系統不支援，請拆成同一天內的時段', p_role_label;
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
      raise exception '%在這個時段已經有同集團其他分店的預約，請改選其他時段或其他服務人員',
        case
          when strpos(p_role_label, '「') > 0 then p_role_label
          else format('%s「%s」', p_role_label, p_staff.name)
        end;
    end if;
  end if;
end;
$function$;

revoke execute on function private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text) from PUBLIC, anon, service_role;
grant execute on function private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text) to authenticated;

-- ===== private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)(改 1 則訊息)=====
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
    raise exception '%的%到%這個時段不可預約(超出商家營業時間，或超出服務人員可預約時段設定)',
      p_role_label, p_range_start, p_range_end;
  end if;
end;
$function$;

-- private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text):改前 proacl 為 NULL(預設權限);create or replace 不會動到 ACL,這裡刻意不下 grant / revoke(下了反而會把 NULL 變成明確清單)。

-- ===== private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean)(改 5 則訊息)=====
CREATE OR REPLACE FUNCTION private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- 去頭尾空白:除了半形空白,也去掉 tab、換行與全形空白(U+3000)——只按 btrim() 預設只去半形空白,
  -- 「全形空白」或「只有換行」的原因會被當成有填(pgTAP D17 實測抓到)。
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n\u3000');
  v_merchant_id uuid;
  v_status text;
  v_source text;
  v_original_completed_at timestamptz;
  v_commission_snapshot jsonb;
  v_commission_amount numeric(10, 2) := 0;
  v_frozen integer := 0;
  v_points jsonb;
  v_is_cross_month boolean;
  v_report_month text;
  v_action text;
  v_booking public.bookings;
begin
  -- 1. 參數檢查(不涉及訂單內容,先擋不會洩漏任何資訊)。
  if p_target_status is null or p_target_status not in ('accepted', 'cancelled') then
    raise exception '不支援的目標狀態(只能還原為「已確認」或取消)' using errcode = '22023';
  end if;

  if v_reason = '' then
    raise exception '請填寫還原/取消的原因' using errcode = '22023';
  end if;

  if char_length(v_reason) > 500 then
    raise exception '原因最多 500 個字，目前是 % 個字，請精簡後再送出', char_length(v_reason) using errcode = '22023';
  end if;

  -- 2. 鎖訂單列(§3.11:鎖住之後才看狀態,兩個人同時按,第二個人一定看到最新狀態)。
  select b.merchant_id, b.status, b.source, b.completed_at
  into v_merchant_id, v_status, v_source, v_original_completed_at
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;

  -- 3. 先擋權限、再回報狀態:客服不會從錯誤訊息得知這張單目前的狀態(§4.1 第 3 步)。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '還原或取消已完成的訂單，只有商家管理員可以操作' using errcode = '42501';
  end if;

  -- 4. 狀態複檢(冪等:同一張單重複按,第二次在這裡被擋下,不會重複刪快照或重複收點)。
  if v_status <> 'completed' then
    raise exception '這筆訂單的狀態已經改變，請重新整理後再試' using errcode = 'P0001';
  end if;

  -- 5. 匯入的歷史訂單只能取消、不能還原(§3.13)。
  if p_target_status = 'accepted' and v_source = 'import' then
    raise exception '匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入' using errcode = 'P0001';
  end if;

  -- 不變量 status='completed' ⇔ completed_at 有值(§3.10;正式庫 0 筆例外)。萬一真的遇到就擋下,
  -- 不要寫出一筆 original_completed_at 為空的稽核(稽核表該欄 not null,會變成看不懂的系統錯誤)。
  if v_original_completed_at is null then
    raise exception '這筆已完成訂單缺少完成時間，資料異常，請聯絡系統管理員' using errcode = 'P0001';
  end if;

  v_action := case p_target_status when 'accepted' then 'revert_to_accepted' else 'cancel_completed' end;

  -- 6. 抽成快照組成 jsonb(先讀、還不刪,§3.4 第 1 點)。月薪制/沒有快照 → null / 0。
  select to_jsonb(r) || jsonb_build_object('items', coalesce((
           select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
           from public.booking_commission_item_records i
           where i.commission_record_id = r.id), '[]'::jsonb)),
         r.commission_amount
  into v_commission_snapshot, v_commission_amount
  from public.booking_commission_records r
  where r.booking_id = p_booking_id;

  v_commission_amount := coalesce(v_commission_amount, 0);

  -- 7. 折抵退回(只有取消路徑)。🔴 順序不可調換(§4.1 第 7 步,pgTAP module17_01 有故障注入):
  --    先把狀態改成 cancelled(completed_at 先留著)→ 再退回。退回函式看「訂單現在是不是 cancelled」
  --    決定分類帳備註,狀態沒先改會寫成「訂單編輯變更了會員或折抵點數…」。
  if p_target_status = 'cancelled' then
    update public.bookings
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_reason = v_reason
    where id = p_booking_id;

    v_frozen := private.refund_booking_redeem(p_booking_id);
  else
    v_frozen := 0;  -- 還原路徑:單子還活著,折抵凍結維持(§3.6)
  end if;

  -- 8. 收回入帳(兩個入口都做;不傳 p_points_due,讓紅利函式自己從分類帳算)。
  --    🔴 此時 completed_at 一定還在(§4.1 第 8 步,pgTAP 有故障注入):收回函式用它找「本單完成之後
  --    才折抵的訂單」組差額提示;先清成 null 會變成 -infinity,提示會列出該會員所有折抵單。
  --    會員已下架、紅利功能關閉都照樣收回(前提 E、Q9(a)):本檔刻意不加任何判斷。
  v_points := private.reverse_booking_earned_points(p_booking_id);

  -- 9. 刪抽成快照(明細 on delete cascade)。放在紅利呼叫之後只是讓可能 raise 的步驟先跑;
  --    任何一步 raise 都整筆回滾(邊界 17)。
  delete from public.booking_commission_records where booking_id = p_booking_id;

  -- 10. 跨月與報表月份一律用台北時區(§3.8)。
  v_is_cross_month := date_trunc('month', v_original_completed_at at time zone 'Asia/Taipei')
                      < date_trunc('month', now() at time zone 'Asia/Taipei');
  v_report_month := to_char(v_original_completed_at at time zone 'Asia/Taipei', 'YYYY-MM');

  -- 11. 改最終狀態並清 completed_at(還原路徑在這一步才改狀態;取消路徑狀態已是 cancelled)。
  update public.bookings
  set status = p_target_status,
      completed_at = null,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_booking;

  -- 12. 操作紀錄:五參數版(沒有 default,一定要明確傳 note)。note 只放原因,不放點數或餘額
  --     ——有訂單鑰匙的客服看得到操作紀錄(§3.2)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, 'completed', p_target_status, v_reason);

  -- 13. 稽核表(收回函式 8 個鍵逐一寫入同名欄位)。
  insert into public.booking_completion_reversals (
    booking_id, merchant_id, action, reason, actor_user_id, actor_name_snapshot,
    original_completed_at, report_month, is_cross_month,
    commission_record_snapshot, commission_amount_reversed,
    points_due, points_recovered, points_shortfall,
    referral_due, referral_recovered, referral_shortfall,
    referrer_member_id, shortfall_hint,
    frozen_points_refunded, notified
  ) values (
    p_booking_id, v_merchant_id, v_action, v_reason, auth.uid(),
    private.current_actor_display_name(v_merchant_id),
    v_original_completed_at, v_report_month, v_is_cross_month,
    v_commission_snapshot, v_commission_amount,
    coalesce((v_points ->> 'points_due')::int, 0),
    coalesce((v_points ->> 'points_recovered')::int, 0),
    coalesce((v_points ->> 'points_shortfall')::int, 0),
    coalesce((v_points ->> 'referral_due')::int, 0),
    coalesce((v_points ->> 'referral_recovered')::int, 0),
    coalesce((v_points ->> 'referral_shortfall')::int, 0),
    (v_points ->> 'referrer_member_id')::uuid,
    v_points ->> 'shortfall_hint',
    v_frozen,
    case when p_target_status = 'cancelled' then coalesce(p_notify_requested, false) else false end
  );

  -- 14. 回傳(含推薦人餘額的提示 ⇒ 只有管理員拿得到,權限已在第 3 步擋)。
  return jsonb_build_object(
    'booking', to_jsonb(v_booking),
    'action', v_action,
    'commission_amount_reversed', v_commission_amount,
    'report_month', v_report_month,
    'is_cross_month', v_is_cross_month,
    'points', jsonb_build_object(
      'points_due', coalesce((v_points ->> 'points_due')::int, 0),
      'points_recovered', coalesce((v_points ->> 'points_recovered')::int, 0),
      'points_shortfall', coalesce((v_points ->> 'points_shortfall')::int, 0),
      'referral_due', coalesce((v_points ->> 'referral_due')::int, 0),
      'referral_recovered', coalesce((v_points ->> 'referral_recovered')::int, 0),
      'referral_shortfall', coalesce((v_points ->> 'referral_shortfall')::int, 0),
      'referrer_member_id', v_points -> 'referrer_member_id',
      'shortfall_hint', v_points -> 'shortfall_hint',
      'frozen_points_refunded', v_frozen
    )
  );
end;
$function$;

revoke execute on function private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean) from PUBLIC, anon, authenticated, service_role;

-- ===== private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer)(改 6 則訊息)=====
CREATE OR REPLACE FUNCTION private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_completed_at timestamptz;
  v_lock_ids uuid[];
  v_row record;
  v_balance integer;
  v_recovered integer;
  v_points_due integer := 0;
  v_points_recovered integer := 0;
  v_member_count integer := 0;
  v_member_name text;
  v_member_hint text;
  v_referral_due integer := 0;
  v_referral_recovered integer := 0;
  v_referrer_count integer := 0;
  v_referrer_member_id uuid := null;
  v_orders text;
  v_hint text := null;
begin
  -- 0. 先鎖訂單列:同一張單的入帳(complete_booking)/ 收回 / 退回折抵全部排隊,淨額在鎖之後才算,
  --    重複呼叫第二次一定看到淨額 0 ⇒ 什麼都不寫(冪等)。
  select b.merchant_id, b.completed_at
  into v_merchant_id, v_completed_at
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;

  -- 1. 會員列鎖:本單入帳的會員、拿到本單推薦獎勵的推薦者、以及推薦獎勵對應的被推薦者(收回首次獎勵
  --    時要清他的 referral_rewarded_at),依 id 排序一次鎖。
  --    §3.11.2 第 7 步:**不檢查 members.status**(下架 ≠ 帳戶結清,下架會員照樣收回)。
  select coalesce(array_agg(distinct s.id order by s.id), '{}')
  into v_lock_ids
  from (
    select t.member_id as id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    union
    select t.member_id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    union
    select t.related_member_id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type = 'referral_bonus'
      and t.related_member_id is not null
  ) s
  where s.id is not null;

  perform 1
  from public.members m
  where m.id = any(v_lock_ids)
  order by m.id
  for update;

  -- 應收回 due = 本單有效入帳(Σ earn_booking + Σ earn_booking_reversal 的 points_delta;後者為負)。
  select coalesce(sum(x.net), 0)::int
  into v_points_due
  from (
    select sum(t.points_delta) as net
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
  ) x;

  -- 呼叫端有傳應收回點數、但跟分類帳算出來的不一樣 → 擋下(防止呼叫端算錯)。
  if p_points_due is not null and p_points_due <> v_points_due then
    raise exception '應收回點數不一致：呼叫端傳入 % 點，分類帳上這張訂單的有效入帳是 % 點', p_points_due, v_points_due
      using errcode = '22023';
  end if;

  -- 2./3. 收回本單入帳:扣到 0 為止(第 1 題定案 A,不放寬兩道「不可為負」CHECK);
  --        有實際扣到點(recovered > 0)才寫 earn_booking_reversal;recovered = 0 不寫列
  --        (points_delta <> 0 CHECK,主腦裁決),三個數字由回傳值帶給呼叫端。
  --    §3.11.2 第 8 步:**不讀 points_feature_enabled**(收回是拿回不該給的,不是新派點)。
  --    #844 批次 4 修正(2026-10-01,本支尚未上線直接改):差額提示**依會員分句**。本單有效入帳 > 0 的會員
  --    通常只有 1 位;#844 邊界 19「還原後換了會員、舊會員上一輪有差額沒收回」會有 2 位。原本把所有會員的
  --    應收回 / 餘額 / 已收回加總成一句,而且只找第一位會員的折抵訂單 ⇒ 兩位會員的數字混在一起講。
  --    現在每位有差額的會員各一句、各自找自己的折抵訂單;只有 1 位時文字與原本逐字相同(不冠姓名),
  --    2 位以上才在句首冠「會員「姓名」」讓操作者分得出是誰。
  select count(*)::int
  into v_member_count
  from (
    select 1
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
  ) x;

  for v_row in
    select t.member_id, sum(t.points_delta)::int as net
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    order by t.member_id
  loop
    select m.points_balance, m.name into v_balance, v_member_name from public.members m where m.id = v_row.member_id;
    if not found then
      continue;  -- 會員已被硬刪(分類帳 on delete cascade 會一起消失,理論上到不了)
    end if;

    v_recovered := least(v_row.net, v_balance);

    if v_recovered > 0 then
      update public.members
      set points_balance = v_balance - v_recovered
      where id = v_row.member_id;

      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
      ) values (
        v_row.member_id, v_merchant_id, 'earn_booking_reversal', -v_recovered, v_balance - v_recovered, p_booking_id,
        format('應收回 %s 點、實收回 %s 點、差額 %s 點未收回', v_row.net, v_recovered, v_row.net - v_recovered),
        auth.uid()
      );
    end if;

    v_points_recovered := v_points_recovered + v_recovered;

    -- 提示文字(這位會員有差額才寫;由呼叫端 #844 顯示給操作者;本函式不 raise、不擋取消)。
    if v_row.net - v_recovered > 0 then
      if v_member_count > 1 then
        v_member_hint := format('會員「%s」應收回 %s 點，目前只有 %s 點，已收回 %s 點，差額 %s 點未收回。',
                                v_member_name, v_row.net, v_balance, v_recovered, v_row.net - v_recovered);
      else
        v_member_hint := format('應收回 %s 點，會員目前只有 %s 點，已收回 %s 點，差額 %s 點未收回。',
                                v_row.net, v_balance, v_recovered, v_row.net - v_recovered);
      end if;

      -- 「訂單 #B」:**這位會員**在本單完成之後、最近幾筆仍有紅利折抵的訂單(找不到就省略這一句)。
      -- 系統沒有訂單編號,用「台北時間 預約時間 + 客戶姓名」讓操作者認得出是哪張單。
      select string_agg(x.label, '、' order by x.last_redeem_at desc)
      into v_orders
      from (
        select format('訂單「%s %s」',
                      to_char(b.start_at at time zone 'Asia/Taipei', 'YYYY/MM/DD HH24:MI'),
                      b.customer_name) as label,
               max(t.created_at) as last_redeem_at
        from public.member_point_transactions t
        join public.bookings b on b.id = t.booking_id
        where t.member_id = v_row.member_id
          and t.transaction_type = 'redeem_booking'
          and t.booking_id <> p_booking_id
          and b.points_redeemed > 0
          and b.status <> 'cancelled'
          and t.created_at >= coalesce(v_completed_at, '-infinity'::timestamptz)
        group by b.id, b.start_at, b.customer_name
        order by max(t.created_at) desc
        limit 3
      ) x;

      if v_orders is not null then
        v_member_hint := v_member_hint || format('這 %s 點是在%s折抵掉的，如果要一併追回，請到%s取消紅利折抵，或用『手動調整點數』扣除。',
                                                 v_row.net - v_recovered, v_orders, v_orders);
      end if;

      v_hint := coalesce(v_hint || ' ', '') || v_member_hint;
    end if;
  end loop;

  -- 4. 推薦獎勵一併收回(第 8 題):本單發給推薦者的 referral_bonus / referral_repeat_bonus,淨額
  --    (扣掉已有的 referral_bonus_reversal)> 0 者,同樣扣到 0 為止、收得到才寫列;推薦者已下架也照扣。
  --    收回的是首次獎勵且**全額收回**(v2.4 裁決 17)→ 清掉被推薦者的 referral_rewarded_at,讓他下一筆完成的
  --    訂單重新觸發首次獎勵;有差額就不清。
  --    (本單會員與推薦者若是同一人,上面的入帳收回已先扣過,這裡讀到的是扣完後的餘額。)
  --    #844 批次 4 修正:推薦人差額提示同樣**依推薦人分句**(邊界 19 換過會員時,新舊會員可能各有推薦人);
  --    只有 1 位推薦人時文字與原本逐字相同,2 位以上才冠「推薦人「姓名」」。
  select count(*)::int
  into v_referrer_count
  from (
    select 1
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
  ) x;

  for v_row in
    select t.member_id,
           sum(t.points_delta)::int as net,
           bool_or(t.transaction_type = 'referral_bonus') as has_first,
           (array_agg(t.related_member_id) filter (
              where t.transaction_type in ('referral_bonus', 'referral_repeat_bonus')
                and t.related_member_id is not null))[1] as invitee_id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    order by t.member_id
  loop
    select m.points_balance, m.name into v_balance, v_member_name from public.members m where m.id = v_row.member_id;
    if not found then
      continue;
    end if;

    v_referrer_member_id := coalesce(v_referrer_member_id, v_row.member_id);
    v_referral_due := v_referral_due + v_row.net;
    v_recovered := least(v_row.net, v_balance);

    if v_recovered > 0 then
      update public.members
      set points_balance = v_balance - v_recovered
      where id = v_row.member_id;

      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id,
        related_member_id, note, created_by_user_id
      ) values (
        v_row.member_id, v_merchant_id, 'referral_bonus_reversal', -v_recovered, v_balance - v_recovered, p_booking_id,
        v_row.invitee_id,
        format('應收回 %s 點、實收回 %s 點、差額 %s 點未收回', v_row.net, v_recovered, v_row.net - v_recovered),
        auth.uid()
      );
    end if;

    v_referral_recovered := v_referral_recovered + v_recovered;

    -- 推薦人差額的提示(這位推薦人有差額才寫,接在會員提示之後)。
    if v_row.net - v_recovered > 0 then
      v_hint := coalesce(v_hint || ' ', '') ||
                case when v_referrer_count > 1 then
                  format('推薦人「%s」應收回推薦獎勵 %s 點，目前只有 %s 點，已收回 %s 點，差額 %s 點未收回；如果要一併追回，請用『手動調整點數』扣除。',
                         v_member_name, v_row.net, v_balance, v_recovered, v_row.net - v_recovered)
                else
                  format('推薦人應收回推薦獎勵 %s 點，推薦人目前只有 %s 點，已收回 %s 點，差額 %s 點未收回；如果要一併追回，請用『手動調整點數』扣除。',
                         v_row.net, v_balance, v_recovered, v_row.net - v_recovered)
                end;
    end if;

    -- v2.4 裁決 17:只有本次收回後,本單推薦獎勵淨額歸 0(全額收回)才清被推薦者的「已拿過首次」標記;
    -- 有差額(推薦者餘額不足)就不清,否則被推薦者下一張單又會觸發一次首次獎勵(第 8 題防刷點)。
    -- 之後再呼叫收回把差額收齊、淨額歸 0 時,當次再清。
    if v_row.has_first and v_row.invitee_id is not null and v_row.net - v_recovered = 0 then
      update public.members set referral_rewarded_at = null where id = v_row.invitee_id;
    end if;
  end loop;

  -- 5. bookings.points_planned 不動(建單時的承諾快照,留給稽核與訂單詳情顯示)。
  -- 6. 不做任何跨訂單自動反轉(§3.11.3 使用者裁決):差額只反映在回傳值、note 與下面的提示文字。

  -- 差額提示已在上面兩個迴圈裡依會員 / 推薦人分句寫好(會員在前、推薦人在後)。

  return jsonb_build_object(
    'points_due', v_points_due,
    'points_recovered', v_points_recovered,
    'points_shortfall', v_points_due - v_points_recovered,
    'referral_due', v_referral_due,
    'referral_recovered', v_referral_recovered,
    'referral_shortfall', v_referral_due - v_referral_recovered,
    'referrer_member_id', v_referrer_member_id,
    'shortfall_hint', v_hint
  );
end;
$function$;

revoke execute on function private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer) from PUBLIC, anon, authenticated, service_role;

-- ===== private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer)(改 6 則訊息)=====
CREATE OR REPLACE FUNCTION private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_s public.merchant_member_settings;
  v_amount numeric;
  v_cap numeric;
  v_max_points integer;
  v_min_points integer;
  v_available integer := greatest(coalesce(p_available_points, 0), 0);
begin
  if coalesce(p_points, 0) <= 0 then
    return 0;
  end if;

  v_s := private.merchant_member_settings_effective(p_merchant_id);

  -- §2.10 第 1 點:開放折抵的前提。
  if not coalesce(v_s.points_feature_enabled, true) then
    raise exception '紅利點數功能已關閉，無法使用點數折抵';
  end if;
  if coalesce(v_s.redeem_points_unit, 0) <= 0 or coalesce(v_s.redeem_amount_unit, 0) <= 0
     or coalesce(v_s.redeem_max_ratio_percent, 0) <= 0 then
    raise exception '這間商家尚未開放紅利點數折抵(要先到「紅利點數管理 → 點數使用」設定兌換比例與單次最大使用比例)';
  end if;
  if p_member_id is null then
    raise exception '這筆訂單沒有連結會員，不能使用紅利點數折抵';
  end if;

  -- v2.4 裁決 12:比的是「點數 ≤ 可用點數」與「換算金額 ≤ cap_amount」;max_points 只是畫面建議值,
  -- 不是硬上限(第 17 題:任意點數都收)。
  if p_points > v_available then
    raise exception '這位會員目前只有 % 點，無法折抵 % 點', v_available, p_points;
  end if;

  v_amount := private.redeem_points_to_amount(p_points, v_s.redeem_points_unit, v_s.redeem_amount_unit);

  -- v2.4 裁決 8 ③:換算後折不到 1 元的點數擋下(否則會「扣了點數、一塊錢都沒折」)。
  if v_amount < 1 then
    v_min_points := ceil(v_s.redeem_points_unit / v_s.redeem_amount_unit)::int;
    while private.redeem_points_to_amount(v_min_points, v_s.redeem_points_unit, v_s.redeem_amount_unit) < 1 loop
      v_min_points := v_min_points + 1;
    end loop;
    raise exception '折抵 % 點換算後不到 1 元(目前 % 點 = % 元)，至少要使用 % 點才折得到 1 元',
      p_points, v_s.redeem_points_unit, trim_scale(v_s.redeem_amount_unit), v_min_points;
  end if;

  select l.cap_amount, l.max_points into v_cap, v_max_points
  from private.compute_booking_redeem_limits(
    v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
    p_payable_amount, v_available
  ) l;

  if v_cap < 1 then
    raise exception '這筆訂單的應付金額 NT$% 依商家設定的單次最大使用比例 %，折抵上限不到 1 元，無法使用紅利折抵',
      trim_scale(coalesce(p_payable_amount, 0)), v_s.redeem_max_ratio_percent || '%';
  end if;

  if v_amount > v_cap then
    raise exception '本單最多可折抵 NT$%(應付金額 NT$% 的 %)，折抵 % 點可折 NT$%，已超過上限；這位會員本單最多建議使用 % 點',
      trim_scale(v_cap), trim_scale(coalesce(p_payable_amount, 0)), v_s.redeem_max_ratio_percent || '%',
      p_points, trim_scale(v_amount), v_max_points;
  end if;

  -- 第 3 題 / §2.11:只做檢查,final_amount_snapshot 不扣。cap <= 應付金額,理論上一定成立。
  if coalesce(p_payable_amount, 0) - v_amount < 0 then
    raise exception '紅利折抵金額不能超過訂單應付金額';
  end if;

  return v_amount;
end;
$function$;

revoke execute on function private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer) from PUBLIC, anon, authenticated, service_role;

-- ===== private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text)(改 10 則訊息)=====
CREATE OR REPLACE FUNCTION private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text)
 RETURNS record
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_item_count int;
  v_distinct_count int;
  v_total_minutes int;
  v_found_count int;
  v_item jsonb;
  v_quantity int;
  v_unit_price numeric;
  v_staff public.merchant_staff;
  v_assistant public.merchant_staff;
  v_assistant_id uuid;
  v_material_enabled boolean;
  v_existing_payment_method_id uuid;
  v_new_material_count int;
begin
  -- 1. 服務項目(§2.1/§4.1):至少選 1 個、結構必須是 jsonb 陣列、不能重複、每個元素的
  --    quantity/unit_price 格式必須正確(§2.4:單價一律信任呼叫端傳入值,這裡只驗證「格式」,
  --    不驗證「是否等於目前的即時價格」)。
  if p_service_items is null or jsonb_typeof(p_service_items) <> 'array' or jsonb_array_length(p_service_items) = 0 then
    raise exception '請至少選擇一個服務項目';
  end if;

  v_item_count := jsonb_array_length(p_service_items);

  select count(*) into v_distinct_count
  from (select distinct (elem ->> 'service_item_id') from jsonb_array_elements(p_service_items) elem) u;
  if v_distinct_count <> v_item_count then
    raise exception '同一個服務項目不能在同一筆預約裡選取兩次';
  end if;

  items_subtotal := 0;
  for v_item in select * from jsonb_array_elements(p_service_items) loop
    if v_item ->> 'service_item_id' is null then
      raise exception '每個服務項目都必須指定 service_item_id';
    end if;

    begin
      v_quantity := (v_item ->> 'quantity')::int;
    exception when others then
      raise exception '服務項目的數量格式不正確，必須是整數';
    end;
    if v_quantity is null or v_quantity < 1 then
      raise exception '服務項目數量必須至少為 1';
    end if;

    begin
      v_unit_price := (v_item ->> 'unit_price')::numeric;
    exception when others then
      raise exception '服務項目的單價格式不正確，必須是數字';
    end;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception '請提供每個服務項目的單價，且不能是負數';
    end if;

    items_subtotal := items_subtotal + (v_unit_price * v_quantity);
  end loop;

  -- §2.2(取代原公式):每個服務項目的工時貢獻 = duration_minutes_snapshot × quantity。
  -- duration_minutes_snapshot 的取得方式不變(每次重新查詢 service_items.duration_minutes,
  -- 跟金額欄位「不重新查詢」刻意不同,見規格書 §2.4 第 3 點)。
  select coalesce(sum(si.duration_minutes * (elem ->> 'quantity')::int), 0), count(*)
  into v_total_minutes, v_found_count
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si
    on si.id = (elem ->> 'service_item_id')::uuid
   and si.merchant_id = p_merchant_id
   and si.status = 'active';

  if v_found_count <> v_item_count then
    raise exception '找不到其中一個服務項目，或這個服務項目已下架';
  end if;

  -- §4.3(裁決 Q3 方向一):自訂工時開關開啟時,直接取代逐項加總結果計算 end_at;
  -- 關閉時沿用 §2.2 既有公式。這是「end_at 怎麼算出來」唯一的分歧點,算出來之後,
  -- 後面所有排程驗證(規則 2.1/2.2/2.3/2.4/2.6、第五節單日例外第三層)一律使用這個 end_at,
  -- 走完全相同一套驗證邏輯(§4.3 第 2 點)。
  if coalesce(p_custom_duration_enabled, false) then
    if p_custom_duration_minutes is null or p_custom_duration_minutes <= 0 then
      raise exception '已開啟自訂工時，請輸入大於 0 的總服務時長(分鐘)';
    end if;
    end_at := p_start_at + make_interval(mins => p_custom_duration_minutes);
  else
    end_at := p_start_at + make_interval(mins => v_total_minutes);
  end if;

  -- 2. 主要服務人員:必須屬於這間商家、status='active'。
  select * into v_staff
  from public.merchant_staff
  where id = p_staff_id and merchant_id = p_merchant_id and status = 'active';
  if not found then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  -- 3. 助手清單(決策記錄 2/3):不能跟主要服務人員是同一人、不能重複指派同一人兩次。
  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    if p_staff_id = any(p_assistant_staff_ids) then
      raise exception '助手不能跟主要服務人員是同一人';
    end if;

    select count(*) into v_distinct_count
    from (select distinct unnest(p_assistant_staff_ids)) u;
    if v_distinct_count <> array_length(p_assistant_staff_ids, 1) then
      raise exception '同一位助手不能在同一筆預約裡被加派兩次';
    end if;
  end if;

  -- 4. 規則 2.1/2.2/2.3/2.4/2.6/第五節第三層:先驗證主要服務人員,再逐一驗證每一位助手
  --    (決策記錄 2)。§4.3 第 3 點:助手的驗證範圍一樣套用這個自訂後的 end_at,不因為是自訂工時
  --    就對助手網開一面。
  perform private.check_staff_booking_slot(
    p_merchant_id, v_staff, p_start_at, end_at, p_exclude_booking_id, '主要服務人員'
  );

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    foreach v_assistant_id in array p_assistant_staff_ids loop
      select * into v_assistant
      from public.merchant_staff
      where id = v_assistant_id and merchant_id = p_merchant_id and status = 'active';
      if not found then
        raise exception '找不到其中一位助手，或這位助手已被移除';
      end if;

      perform private.check_staff_booking_slot(
        p_merchant_id, v_assistant, p_start_at, end_at, p_exclude_booking_id,
        format('助手「%s」', v_assistant.name)
      );
    end loop;
  end if;

  -- 5. 料錢成本(規格書 2.3):帶了品項就必須先確認商家已開啟 material_cost_enabled,
  --    且不能重複選、必須屬於這間商家且 status='active'。
  --    #985 順手修(第 7 批 QA):編輯既有訂單(p_exclude_booking_id 不是 null)時,這筆訂單
  --    「原本就有」的料錢品項視為維持原值——不要求功能開關開著、也不要求品項仍上架(比照第 6 步
  --    付款方式「維持原值不因商家事後下架而擋下」的既有做法)。只有這次「新加進來」的品項才照舊
  --    檢查開關與上架狀態。品項仍必須屬於這間商家。
  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    if p_exclude_booking_id is not null then
      select count(*) into v_new_material_count
      from unnest(p_material_cost_item_ids) as req(item_id)
      where not exists (
        select 1 from public.booking_material_costs bmc
        where bmc.booking_id = p_exclude_booking_id
          and bmc.material_cost_item_id = req.item_id
      );
    else
      v_new_material_count := array_length(p_material_cost_item_ids, 1);
    end if;

    if v_new_material_count > 0 then
      select enabled into v_material_enabled
      from public.merchant_feature_flags
      where merchant_id = p_merchant_id and feature_key = 'material_cost_enabled';

      if coalesce(v_material_enabled, false) is not true then
        raise exception '這間商家尚未開啟料錢成本功能，無法選用料錢成本品項';
      end if;
    end if;

    select count(*) into v_distinct_count
    from (select distinct unnest(p_material_cost_item_ids)) u;
    if v_distinct_count <> array_length(p_material_cost_item_ids, 1) then
      raise exception '同一個料錢成本品項不能在同一筆預約裡選取兩次';
    end if;

    select count(*) into v_found_count
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids)
      and mci.merchant_id = p_merchant_id
      and (
        mci.status = 'active'
        or (
          p_exclude_booking_id is not null
          and exists (
            select 1 from public.booking_material_costs bmc
            where bmc.booking_id = p_exclude_booking_id
              and bmc.material_cost_item_id = mci.id
          )
        )
      );

    if v_found_count <> array_length(p_material_cost_item_ids, 1) then
      raise exception '找不到其中一個料錢成本品項，或已下架';
    end if;
  end if;

  -- 6. 付款方式(模組 9 v2 + SPECS-INDEX #604 疊加必填規則)。
  --    **#604 新增(最前面先判斷)**:p_payment_method_id 是 null 的情況分兩種:
  --      (a) p_exclude_booking_id 是 null(create_booking 新建)→ 一律擋下,必須選擇付款方式。
  --      (b) p_exclude_booking_id 不是 null(update_booking 編輯既有訂單)→ 只有在這筆訂單
  --          「目前已存的 payment_method_id 也是 null」時才放行(客服完全沒有去動這個欄位,
  --          維持原值,即使原值是 null);如果這筆訂單原本已經有值、這次卻被改成 null(客服
  --          主動清空),一樣擋下。
  --    這個檢查通過之後,才進入原本(2026-09-19 主腦複查修正過的)付款方式存在性/狀態驗證,
  --    邏輯完全不變。
  if p_payment_method_id is null then
    if p_exclude_booking_id is null then
      raise exception '請選擇付款方式';
    else
      select payment_method_id into v_existing_payment_method_id
      from public.bookings
      where id = p_exclude_booking_id;

      if v_existing_payment_method_id is not null then
        raise exception '請選擇付款方式';
      end if;
    end if;
  end if;

  --    **關鍵修正(2026-09-19 主腦複查)**:如果這是編輯既有訂單(p_exclude_booking_id 不是 null)、
  --    且這個 payment_method_id 剛好就是這筆訂單目前已經存的值(客服沒有主動更換付款方式),
  --    直接沿用既有的 payment_method_name_snapshot,不重新查詢 payment_methods.name——
  --    避免商家事後把這個付款方式改名字,連帶讓「沒有主動變更付款方式」的編輯動作意外把
  --    歷史訂單的顯示名稱洗成新名字,違反使用者明確要求的「訂單歷史不受商家事後異動影響」。
  if p_payment_method_id is not null then
    if p_exclude_booking_id is not null then
      select payment_method_name_snapshot into payment_method_name
      from public.bookings
      where id = p_exclude_booking_id and payment_method_id = p_payment_method_id;
    end if;

    if payment_method_name is null then
      -- 新建立、或客服主動選了不同的付款方式(不是維持原值)→ 查詢目前的名稱當作新快照。
      select name into payment_method_name
      from public.payment_methods
      where id = p_payment_method_id
        and merchant_id = p_merchant_id
        and (
          status = 'active'
          or (
            p_exclude_booking_id is not null
            and exists (
              select 1 from public.bookings
              where id = p_exclude_booking_id and payment_method_id = p_payment_method_id
            )
          )
        );

      if not found then
        raise exception '找不到這個付款方式，或已下架';
      end if;
    end if;
  end if;
end;
$function$;

revoke execute on function private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text) from PUBLIC, anon, service_role;
grant execute on function private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text) to authenticated;

-- ===== public.cancel_booking(p_booking_id uuid, p_reason text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.cancel_booking(p_booking_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  -- 紅利系統重構 批次 3:加上 for update(原本沒有),跟 update_booking 排隊 ——
  -- 否則「改單」與「取消」同時送出時,改單可能在取消之後又把折抵重新扣回去。
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '只有「待確認」或「已確認」狀態的預約可以取消，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 紅利系統重構 §3.11.1:退回這張單的折抵凍結(不看紅利功能開關、不看會員狀態;沒有折抵就什麼都不寫)。
  -- 取消的訂單不入帳派點(points_planned 保留當歷史快照,complete_booking 不會再被呼叫)。
  if private.refund_booking_redeem(p_booking_id) > 0 then
    -- 退回時把 points_redeemed / points_redeem_amount_snapshot 歸 0 了,回傳最新的那一列。
    select * into v_result from public.bookings where id = p_booking_id;
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'cancelled');

  return v_result;
end;
$function$;

revoke execute on function public.cancel_booking(p_booking_id uuid, p_reason text) from PUBLIC, anon;
grant execute on function public.cancel_booking(p_booking_id uuid, p_reason text) to authenticated, service_role;

-- ===== public.complete_booking(p_booking_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.complete_booking(p_booking_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以標記完成，目前狀態不允許這個操作';
  end if;

  update public.bookings
  set status = 'completed',
      completed_at = now(),
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 模組 8(薪資與帳務)§3.7 既有的一行:訂單成功轉為 completed 之後,計算抽成快照。
  perform public.compute_booking_commission(p_booking_id);

  -- 模組 10(會員與紅利)§3.8 既有的一行:訂單成功轉為 completed 之後,計算會員紅利點數。
  perform public.compute_member_loyalty_points(p_booking_id);

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'completed');

  return v_result;
end;
$function$;

revoke execute on function public.complete_booking(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.complete_booking(p_booking_id uuid) to authenticated, service_role;

-- ===== public.confirm_booking(p_booking_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.confirm_booking(p_booking_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'pending_confirmation' then
    raise exception '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  update public.bookings
  set status = 'accepted',
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:v_status 是變更前的狀態(pending_confirmation)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'accepted');

  return v_result;
end;
$function$;

revoke execute on function public.confirm_booking(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.confirm_booking(p_booking_id uuid) to authenticated, service_role;

-- ===== public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid)(改 6 則訊息)=====
CREATE OR REPLACE FUNCTION public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_assistant_staff_ids uuid[] DEFAULT '{}'::uuid[], p_material_cost_item_ids uuid[] DEFAULT '{}'::uuid[], p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_member_id uuid DEFAULT NULL::uuid, p_hide_notes_from_staff boolean DEFAULT false, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT 0, p_points_redeem_member_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sel record;
  v_amount record;
  v_created_by_role text;
  v_booking_id uuid;
  v_industry_type text;
  v_result public.bookings;
  v_member_name text;
  -- SPECS-INDEX #912(2026-09-30)新增的 5 個區域變數。
  v_normalized_phone text;
  v_match_count int := 0;
  v_matched_member_id uuid;
  v_effective_member_id uuid;
  v_member_auto_created boolean := false;
  v_new_member public.members;
  -- 紅利系統重構 §3.3(批次 3)新增。
  v_s public.merchant_member_settings;
  v_points record;
  v_planned integer;
  v_overridden boolean := false;
  v_redeem_points integer := coalesce(p_points_redeemed, 0);
  v_redeem_amount numeric := 0;
  v_member_balance integer;
  -- [req977-batch4 begin] SPECS-INDEX #977 第 4 批(2026-10-06):新訂單的初始狀態(見下方說明)。
  v_initial_status text;
  -- [req977-batch4 end]
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限建立這間商家的預約' using errcode = '42501';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;
  -- SPECS-INDEX #822(2026-09-27):客戶電話格式驗證(手機或市話,市話可帶 # 分機,分隔符號不強制)。
  -- 規則本體在 private.is_valid_taiwan_phone,跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應。
  -- 🔴 SPECS-INDEX #913(2026-09-30):**這一段必須留在「自動建立會員」的前面**。
  --    它就是「自動建會員不會變成 #827 那個塞髒電話的新後門」的唯一理由 —— 電話在這裡先驗過,
  --    下面傳給 create_member 的一定是合格電話。不要因為任何原因把這兩段的順序調換。
  if not private.is_valid_taiwan_phone(p_customer_phone) then
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)';
  end if;

  -- 紅利系統重構 §3.3 第 2/3 步的「參數本身」檢查,放在任何寫入(含自動建立會員)之前:
  -- 數字明顯不合法時,不要先建了一位會員才報錯(雖然整筆會回滾,但錯誤越早越好懂)。
  if p_points_override is not null then
    if p_points_override < 0 then
      raise exception '派點數不能是負數';
    end if;
    if p_points_override > 100000 then
      raise exception '單筆訂單最多只能設定 100,000 點，請確認是否多打了零';
    end if;
  end if;
  if v_redeem_points < 0 then
    raise exception '折抵點數不能是負數';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- =====================================================================
  -- SPECS-INDEX #912 / #914(2026-09-30):自動建立 / 自動連結會員。
  -- 呼叫端有帶 p_member_id(客服在畫面上明確選過了)⇒ 這一整段跳過,完全照既有邏輯走。
  -- =====================================================================
  v_effective_member_id := p_member_id;

  if p_member_id is null then
    v_normalized_phone := private.normalize_phone(p_customer_phone);

    if v_normalized_phone is null then
      -- 防禦性分支,理論上到不了:上面的 is_valid_taiwan_phone 已經保證電話含有數字,
      -- normalize_phone 不可能回 NULL(只有「空值」或「只填了 #分機」才會)。
      -- 真的走到這裡的話,刻意**不建會員**:一支連正規化都算不出數字的電話,建成會員之後
      -- 永遠比對不到任何東西,只會變成一筆撈不出來的空資料。維持訂單沒有會員即可。
      -- (紅利系統重構 v2.4 裁決 8 ①:改呼叫共用 helper 之後,這個分支照樣保留。)
      v_match_count := 0;
      v_effective_member_id := null;
    else
      -- 紅利系統重構 §3.3 第 0 步 / §3.2 末段(批次 3):「依電話找會員」那一句改呼叫共用 helper
      -- private.resolve_booking_member_by_phone —— 建單頁預覽(preview_booking_points)呼叫的是
      -- **同一支**,保證「預覽對到的會員 = 送出後連結的會員」。helper 內容是原本這裡那一句逐字搬過去的
      -- (同商家、status = 'active'、normalize_phone 完全相等;挑最早建立的那一位,不用 min(uuid)——
      -- 完整理由與 #931 的已知代價都寫在 helper 的註解裡,那邊是唯一一份)。
      select r.match_count, r.member_id
      into v_match_count, v_matched_member_id
      from private.resolve_booking_member_by_phone(p_merchant_id, p_customer_phone) r;

      if v_match_count = 1 then
        -- 自動連結:不新增紀錄,而且**不改這位會員的任何欄位**(姓名/email/生日/updated_at 全不動)。
        -- 使用者裁決:「除了手機以外的資訊不是自己的,由會員自己修改」。
        -- 黑名單客戶照樣自動連結(既有規則是「建單時警告、不擋單」),警告由前端負責。
        v_effective_member_id := v_matched_member_id;
        v_member_auto_created := false;
      elsif v_match_count = 0 then
        -- 自動建立:完全複用既有的 public.create_member,不自己寫一份 insert
        -- (推薦碼產生、權限檢查、#931 的唯一性檢查全部沿用同一支函式,不會有第二套規則)。
        -- 生日/備註/推薦人/會員等級一律不帶:建單表單根本沒有生日欄位(規格書 §十一 Q4 裁決 (A):
        -- 生日之後在會員詳情頁補填,不在最常用的建單流程上多加欄位)。
        -- email 有填就帶進去(create_member 有 p_email);自動**連結**時則不動既有會員的 email。
        v_new_member := public.create_member(
          p_merchant_id,
          btrim(p_customer_name),
          btrim(p_customer_phone),
          nullif(btrim(coalesce(p_customer_email, '')), ''),
          null, null, null, null
        );
        v_effective_member_id := v_new_member.id;
        v_member_auto_created := true;
      else
        -- #914 後端防線。#931 之後新資料不會再出現這種情況,保留當舊資料的安全網。
        -- ⚠️ 訊息刻意不提「這支電話的新客戶」那顆按鈕 —— #931 已經把它整顆移除了。
        raise exception '這支電話底下有 % 位客戶，請先在建單畫面選擇這筆訂單是哪一位', v_match_count;
      end if;
    end if;
  end if;

  -- 既有的會員驗證(模組 10 §3.6),判斷對象從 p_member_id 改成 v_effective_member_id:
  --   ・呼叫端明確帶了 p_member_id ⇒ 行為與訊息跟以前**完全一樣**(找不到/不同商家/已下架就 raise);
  --   ・自動連結/自動建立 ⇒ 這裡是一道便宜的一致性複查(同商家、active),順便取出
  --     member_name_snapshot 要用的姓名(既有規則:取**會員資料表裡的**姓名,不是表單打的)。
  if v_effective_member_id is not null then
    select name into v_member_name
    from public.members
    where id = v_effective_member_id
      and merchant_id = p_merchant_id
      and status = 'active';

    if not found then
      raise exception '找不到指定的會員，或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
  );

  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  -- =====================================================================
  -- 紅利系統重構 §3.3 第 1~3 步(批次 3):派點快照 + 人工覆寫 + 折抵驗證。
  -- 會員一律用 v_effective_member_id(自動連結/自動建立之後的會員,v2.3 對齊紀錄第 4 點);
  -- 派點由批次 2 的唯一計算引擎算,**跟 preview_booking_points 同一支、同一組輸入**
  -- (p_service_items 原樣、應付金額 = calculate_booking_amount 的 final_amount),
  -- 所以「預覽 N 點、建出來 M 點」不會發生(pgTAP 直接比對)。
  -- =====================================================================
  v_s := private.merchant_member_settings_effective(p_merchant_id);

  select * into v_points from private.compute_booking_planned_points(
    p_merchant_id,
    v_effective_member_id,
    p_service_items,
    v_amount.final_amount,
    p_custom_total_amount_enabled,
    p_discount_enabled,
    false
  );

  if p_points_override is not null then
    -- 第 4 題定案 A:只要 orders 鑰匙(上面 can_manage_bookings 已檢查),不另外要求 members/member_points。
    -- 第 13 題:0~100,000,不限制偏離建議值的倍數;points_planned_auto 照樣寫下來供事後稽核。
    if not coalesce(v_s.points_feature_enabled, true) then
      raise exception '紅利點數功能已關閉，無法設定派點';
    end if;
    v_planned := p_points_override;
    v_overridden := true;
  else
    v_planned := v_points.auto_points;
    v_overridden := false;
  end if;

  if v_redeem_points > 0 then
    -- 🔴 v2.4 裁決 22 ①:客服在畫面上確認的是「從某一位會員扣點」。伺服器依送出當下的電話決定的會員
    --    如果不是那一位(改了電話、預覽還沒更新就送出),一律擋下,不可以默默改扣另一個人的點數。
    -- (沒有會員的情況交給下面 validate_booking_redeem 回「這筆訂單沒有連結會員」那句更清楚的話。)
    if v_effective_member_id is not null
       and p_points_redeem_member_id is distinct from v_effective_member_id then
      raise exception '客戶已變更，紅利折抵已重設，請重新確認後送出';
    end if;

    -- 🔴 先鎖會員列、再讀餘額:兩張單同時對同一位會員折抵時,第二張會排隊等第一張交易結束,
    --    讀到的是扣過之後的餘額,不會兩張都以為「還有 100 點」而把點數用兩次(規則 2.3 for update)。
    --    這次才自動建立的會員餘額一定是 0,會自然被「只有 0 點」擋下。
    if v_effective_member_id is not null then
      select points_balance into v_member_balance
      from public.members
      where id = v_effective_member_id
      for update;
    end if;

    v_redeem_amount := private.validate_booking_redeem(
      p_merchant_id, v_effective_member_id, v_redeem_points, v_amount.final_amount, v_member_balance
    );
  end if;

  -- [req977-batch7 begin] SPECS-INDEX #977 第 7 批(2026-10-07):服務人員本人透過 staff_create_booking 建的單,
  -- 建立者角色記成 'staff'(bookings_created_by_role_check 本批已放寬)。其餘情況維持原式。
  if private.is_staff_order_call(p_merchant_id) then
    v_created_by_role := 'staff';
  else
  -- [req977-batch7 end]
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;
  -- [req977-batch7 begin]
  end if;
  -- [req977-batch7 end]
  -- [req977-batch4 begin] SPECS-INDEX #977 第 4 批(2026-10-06,主腦裁決 ⑤):
  -- 主要服務人員開了「商家後台確認後直接接單」(merchant_staff.direct_accept_after_merchant_confirm)
  -- ⇒ 後台建的新訂單直接是 accepted(畫面「已確認」),操作紀錄 to_status 也寫 accepted;
  -- 關閉(預設)維持 pending_confirmation。只認同一間商家的那筆服務人員紀錄。
  -- 建單 LINE / 推播照舊只發「新訂單」事件(前端決定,這裡不發任何通知)。
  -- 這支函式其餘內容與 20261001040000 的定義逐字相同(指紋比對見 pgTAP req977_04)。
  v_initial_status := case
    when exists (
      select 1
      from public.merchant_staff ms
      where ms.id = p_staff_id
        and ms.merchant_id = p_merchant_id
        and ms.direct_accept_after_merchant_confirm
    ) then 'accepted'
    else 'pending_confirmation'
  end;
  -- [req977-batch4 end]

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method_id, payment_method_name_snapshot,
    custom_duration_enabled, custom_duration_minutes,
    member_id, member_name_snapshot,
    hide_notes_from_staff,
    member_auto_created,
    -- 紅利系統重構 §3.3 第 4 步。
    points_planned, points_planned_auto, points_planned_overridden, points_review_required,
    points_planned_breakdown, points_redeemed, points_redeem_amount_snapshot
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_sel.end_at,
    -- 🔴 customer_name 一律是**這次表單打的姓名**,不會被會員資料表的姓名覆蓋(#931 的完整語意:
    --    「同一支手機也可以用其他姓名新建訂單」)。source / created_by_role 也維持
    --    'manual' / 'admin'|'agent' 不動 —— 'customer' / 'smart' 是留給模組 13 與智慧建單的(#911)。
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), v_initial_status,
    coalesce(p_custom_total_amount_enabled, false), p_custom_total_amount, v_amount.subtotal_amount,
    coalesce(p_discount_enabled, false), p_discount_mode, p_discount_value, v_amount.discount_amount,
    coalesce(p_tax_enabled, false), p_tax_mode, p_tax_value, v_amount.tax_amount,
    -- 🔴 第 3 題定案 A / §2.11:final_amount_snapshot 是**折抵前**應付總額,不扣紅利折抵
    --    (抽成、報表營收、LINE {{final_amount}} 全部照舊讀它);折抵金額另存 points_redeem_amount_snapshot。
    v_amount.final_amount, p_payment_method_id, v_sel.payment_method_name,
    coalesce(p_custom_duration_enabled, false),
    case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    v_effective_member_id, v_member_name,
    -- SPECS-INDEX #852:coalesce 是為了「呼叫端明確傳 null 進來」的邊界(欄位是 not null),
    -- 不是為了容許漏帶 —— 漏帶時 default false 已經在簽章那一層生效了。
    coalesce(p_hide_notes_from_staff, false),
    -- SPECS-INDEX #911:只有「這次自動新建了一筆會員」才是 true。自動連結既有會員、
    -- 或呼叫端明確帶了 p_member_id,都是 false。
    v_member_auto_created,
    v_planned, v_points.auto_points, v_overridden, v_points.review_required,
    v_points.breakdown, v_redeem_points, v_redeem_amount
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    v_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select v_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select v_booking_id, mci.id, mci.amount
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  -- 紅利系統重構 §3.3 第 5 步:有折抵 ⇒ 分類帳 redeem_booking(−)+ 扣餘額。
  -- 跟訂單 insert 在同一個交易裡,任何一步失敗整筆回滾(不會「點數扣了、訂單沒建出來」或反過來)。
  if v_redeem_points > 0 then
    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
    ) values (
      v_effective_member_id, p_merchant_id, 'redeem_booking', -v_redeem_points,
      v_member_balance - v_redeem_points, v_booking_id,
      format('建單時使用紅利折抵 %s 點(折 NT$%s)', v_redeem_points, trim_scale(v_redeem_amount)),
      auth.uid()
    );

    update public.members
    set points_balance = v_member_balance - v_redeem_points
    where id = v_effective_member_id;
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:建立訂單本身也算一筆操作記錄,
  -- from_status = null 代表「建立」這個動作。
  perform private.log_booking_status_change(v_booking_id, p_merchant_id, null, v_initial_status);

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$function$;

revoke execute on function public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid) from PUBLIC, anon;
grant execute on function public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid) to authenticated, service_role;

-- ===== public.get_booking_points_ledger(p_booking_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_booking_points_ledger(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_earned integer;
  v_reversed integer;
  v_has_earn boolean;
begin
  select b.merchant_id into v_merchant_id from public.bookings b where b.id = p_booking_id;

  -- 跟建單 / 訂單詳情同一把鑰匙(orders)。「不存在」與「別家的」回同一個錯誤,不洩漏存不存在。
  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '找不到這筆預約，或沒有權限查看' using errcode = '42501';
  end if;

  select
    coalesce(sum(t.points_delta) filter (where t.transaction_type = 'earn_booking'), 0)::int,
    coalesce(-sum(t.points_delta) filter (where t.transaction_type = 'earn_booking_reversal'), 0)::int,
    bool_or(t.transaction_type = 'earn_booking')
  into v_earned, v_reversed, v_has_earn
  from public.member_point_transactions t
  where t.booking_id = p_booking_id
    and t.merchant_id = v_merchant_id
    and t.transaction_type in ('earn_booking', 'earn_booking_reversal');

  -- 只回這一張單的入帳 / 收回點數,不回會員餘額、不回其他交易、不回推薦獎勵(那是推薦者的交易)。
  return jsonb_build_object(
    'earned_points', case when coalesce(v_has_earn, false) then v_earned end,
    'reversed_points', v_reversed,
    'effective_points', case when coalesce(v_has_earn, false) then greatest(v_earned - v_reversed, 0) end
  );
end;
$function$;

revoke execute on function public.get_booking_points_ledger(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.get_booking_points_ledger(p_booking_id uuid) to authenticated, service_role;

-- ===== public.get_completed_booking_reversal_preview(p_booking_id uuid)(改 6 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_completed_booking_reversal_preview(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b public.bookings;
  v_staff record;
  v_commission record;
  v_member jsonb := null;
  v_months_ago integer;
  v_is_cross_month boolean;
  v_blocked jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_points jsonb := null;
  v_members jsonb := '[]'::jsonb;
  v_referral jsonb := null;
  v_frozen_total integer := 0;
  v_due_total integer := 0;
  -- 模擬餘額:bal_r = 還原路徑、bal_c = 取消路徑(先加回折抵凍結)
  v_bal_r jsonb := '{}'::jsonb;
  v_bal_c jsonb := '{}'::jsonb;
  v_row record;
  v_r integer;
  v_c integer;
  v_ref_first uuid := null;
  v_ref_name text;
  v_ref_balance integer;
  v_ref_due integer := 0;
  v_ref_short_r integer := 0;
  v_ref_short_c integer := 0;
begin
  select * into v_b from public.bookings b where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;

  -- 先擋權限再回報狀態(跟引擎一致)。回傳含會員/推薦人姓名與餘額 ⇒ 只給商家管理員(§3.2)。
  if not private.is_merchant_admin(v_b.merchant_id) then
    raise exception '還原或取消已完成的訂單，只有商家管理員可以操作' using errcode = '42501';
  end if;

  if v_b.status <> 'completed' then
    raise exception '這筆訂單的狀態已經改變，請重新整理後再試' using errcode = 'P0001';
  end if;

  if v_b.source = 'import' then
    v_blocked := v_blocked || jsonb_build_array(jsonb_build_object(
      'code', 'import_cannot_revert',
      'message', '匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入。'));
  end if;

  -- 服務人員
  select ms.id, ms.name, ms.status, ms.compensation_type
  into v_staff
  from public.merchant_staff ms
  where ms.id = v_b.staff_id;

  -- 抽成快照
  select r.commission_amount, r.recalculated_at, r.computed_at
  into v_commission
  from public.booking_commission_records r
  where r.booking_id = p_booking_id;

  if v_staff.id is not null and v_staff.status = 'removed' then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'staff_removed',
      'message', format('服務人員「%s」已經移除。還原後這張單無法編輯或改時間，只能重新完成或取消。', v_staff.name)));
  end if;

  if v_staff.id is not null and v_staff.compensation_type = 'monthly_salary' and v_commission.commission_amount is not null then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'staff_now_monthly',
      'message', format('服務人員「%s」目前已改成月薪制。這次會收回原本的抽成，之後重新完成也不會再產生抽成。', v_staff.name)));
  end if;

  if v_commission.recalculated_at is not null then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
      'code', 'commission_recalculated',
      'message', '這張單的抽成曾經人工重算過。收回後原本重算的結果不會保留，重新完成時會依當時的設定重新計算。'));
  end if;

  -- 跨月(台北時區;§3.8)
  v_is_cross_month := date_trunc('month', v_b.completed_at at time zone 'Asia/Taipei')
                      < date_trunc('month', now() at time zone 'Asia/Taipei');
  v_months_ago := greatest(0,
      (extract(year from now() at time zone 'Asia/Taipei')::int * 12 + extract(month from now() at time zone 'Asia/Taipei')::int)
    - (extract(year from v_b.completed_at at time zone 'Asia/Taipei')::int * 12 + extract(month from v_b.completed_at at time zone 'Asia/Taipei')::int));

  -- 訂單目前連結的會員
  if v_b.member_id is not null then
    select jsonb_build_object('id', m.id, 'name', m.name, 'status', m.status, 'balance', m.points_balance)
    into v_member
    from public.members m
    where m.id = v_b.member_id;
  end if;

  -- 點數:本單從來沒有任何點數交易 → null
  if exists (select 1 from public.member_point_transactions t where t.booking_id = p_booking_id) then
    -- 起始餘額:所有可能被動到的人(入帳會員、推薦人、折抵被扣的人)
    for v_row in
      select m.id, m.points_balance
      from public.members m
      where m.id in (select t.member_id from public.member_point_transactions t where t.booking_id = p_booking_id)
    loop
      v_bal_r := v_bal_r || jsonb_build_object(v_row.id::text, v_row.points_balance);
      v_bal_c := v_bal_c || jsonb_build_object(v_row.id::text, v_row.points_balance);
    end loop;

    -- 目前有效凍結(只有取消路徑會退)
    for v_row in
      select t.member_id, (-sum(t.points_delta))::int as frozen
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.transaction_type in ('redeem_booking', 'redeem_booking_refund')
      group by t.member_id
      having -sum(t.points_delta) > 0
      order by t.member_id
    loop
      v_frozen_total := v_frozen_total + v_row.frozen;
      v_bal_c := v_bal_c || jsonb_build_object(v_row.member_id::text,
                   coalesce((v_bal_c ->> v_row.member_id::text)::int, 0) + v_row.frozen);
    end loop;

    -- 本單入帳(依會員 id,比照收回函式)
    for v_row in
      select t.member_id, sum(t.points_delta)::int as net, m.name, m.status, m.points_balance,
             coalesce((
               select (-sum(f.points_delta))::int
               from public.member_point_transactions f
               where f.booking_id = p_booking_id and f.member_id = t.member_id
                 and f.transaction_type in ('redeem_booking', 'redeem_booking_refund')
             ), 0) as frozen
      from public.member_point_transactions t
      join public.members m on m.id = t.member_id
      where t.booking_id = p_booking_id
        and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
      group by t.member_id, m.name, m.status, m.points_balance
      having sum(t.points_delta) > 0
      order by t.member_id
    loop
      v_r := (v_bal_r ->> v_row.member_id::text)::int;
      v_c := (v_bal_c ->> v_row.member_id::text)::int;
      v_due_total := v_due_total + v_row.net;

      v_members := v_members || jsonb_build_array(jsonb_build_object(
        'member_id', v_row.member_id,
        'name', v_row.name,
        'status', v_row.status,
        'balance', v_row.points_balance,
        'due_expected', v_row.net,
        'frozen_refund_expected', greatest(v_row.frozen, 0),
        'shortfall_if_revert', greatest(v_row.net - v_r, 0),
        'shortfall_if_cancel', greatest(v_row.net - v_c, 0)
      ));

      v_bal_r := v_bal_r || jsonb_build_object(v_row.member_id::text, v_r - least(v_row.net, v_r));
      v_bal_c := v_bal_c || jsonb_build_object(v_row.member_id::text, v_c - least(v_row.net, v_c));
    end loop;

    -- 推薦獎勵(依推薦人 id,用扣完入帳後的模擬餘額)
    for v_row in
      select t.member_id, sum(t.points_delta)::int as net
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
      group by t.member_id
      having sum(t.points_delta) > 0
      order by t.member_id
    loop
      v_r := coalesce((v_bal_r ->> v_row.member_id::text)::int, 0);
      v_c := coalesce((v_bal_c ->> v_row.member_id::text)::int, 0);

      if v_ref_first is null then
        v_ref_first := v_row.member_id;
        select m.name, m.points_balance into v_ref_name, v_ref_balance from public.members m where m.id = v_row.member_id;
      end if;

      v_ref_due := v_ref_due + v_row.net;
      v_ref_short_r := v_ref_short_r + greatest(v_row.net - v_r, 0);
      v_ref_short_c := v_ref_short_c + greatest(v_row.net - v_c, 0);

      v_bal_r := v_bal_r || jsonb_build_object(v_row.member_id::text, v_r - least(v_row.net, v_r));
      v_bal_c := v_bal_c || jsonb_build_object(v_row.member_id::text, v_c - least(v_row.net, v_c));
    end loop;

    if v_ref_first is not null then
      v_referral := jsonb_build_object(
        'referrer_member_id', v_ref_first,
        'referrer_name', v_ref_name,
        'referrer_balance', v_ref_balance,
        'due_expected', v_ref_due,
        -- 規格的單一欄位;推薦人跟本單會員是不同人時(實務上一定如此)兩條路徑相同。
        'shortfall_expected', v_ref_short_r,
        -- 精確版:推薦人恰好也是本單入帳會員或折抵被扣的人時(極罕見,邊界 19),兩條路徑可能不同。
        'shortfall_if_revert', v_ref_short_r,
        'shortfall_if_cancel', v_ref_short_c
      );
    end if;

    v_points := jsonb_build_object(
      'members', v_members,
      'points_due_expected', v_due_total,
      'frozen_points', v_frozen_total,
      'referral', v_referral
    );
  end if;

  return jsonb_build_object(
    'booking_id', v_b.id,
    'status', v_b.status,
    'source', v_b.source,
    'can_revert', v_b.source <> 'import',
    'can_cancel', true,
    'blocked_reasons', v_blocked,
    'staff', case when v_staff.id is null then null else jsonb_build_object(
      'id', v_staff.id, 'name', v_staff.name, 'status', v_staff.status,
      'compensation_type_now', v_staff.compensation_type) end,
    'commission', jsonb_build_object(
      'exists', v_commission.commission_amount is not null,
      'amount', coalesce(v_commission.commission_amount, 0),
      'recalculated', v_commission.recalculated_at is not null,
      'computed_at', v_commission.computed_at),
    'completed_at', v_b.completed_at,
    'report_month', to_char(v_b.completed_at at time zone 'Asia/Taipei', 'YYYY-MM'),
    'is_cross_month', v_is_cross_month,
    'months_ago', v_months_ago,
    'revenue_amount', v_b.final_amount_snapshot,
    'member', v_member,
    'points', v_points,
    'warnings', v_warnings
  );
end;
$function$;

revoke execute on function public.get_completed_booking_reversal_preview(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.get_completed_booking_reversal_preview(p_booking_id uuid) to authenticated, service_role;

-- ===== public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)(改 9 則訊息)=====
CREATE OR REPLACE FUNCTION public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
  v_target public.merchant_staff;
  v_main public.merchant_staff;
  v_assistant public.merchant_staff;
  v_dragged_role text;
  v_mode text;
  v_duration interval;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_time_changed boolean := false;
  v_staff_changed boolean := false;
  v_prev_assistant_staff_id uuid;
  v_next_assistant_staff_id uuid;
  v_updated_rows integer;
  v_result public.bookings;
begin
  -- [a] 讀訂單 → 權限 → 狀態(順序跟 update_booking 完全一致)。
  select * into v_booking
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_booking.merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_booking.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能移動';
  end if;

  -- [b] 畫面過期偵測(#810):前端「拖之前」看到的值跟資料庫現況不符,代表別人剛改過這筆單。
  --     用 is distinct from(§6.6),即使哪天 staff_id 允許 null 也不會誤判。
  if v_booking.start_at is distinct from p_expected_start_at
     or v_booking.staff_id is distinct from p_expected_staff_id then
    raise exception '這筆預約剛剛被其他人改過，畫面已重新整理，請再拖一次' using errcode = '40001';
  end if;

  -- [c] 判定被拖的那顆色塊是主還是助手。
  if p_dragged_staff_id is not null and p_dragged_staff_id = v_booking.staff_id then
    v_dragged_role := 'main';
  elsif exists (
    select 1 from public.booking_assistants ba
    where ba.booking_id = p_booking_id and ba.staff_id = p_dragged_staff_id
  ) then
    v_dragged_role := 'assistant';
  else
    raise exception '找不到這位服務人員在這筆預約裡的角色，請重新整理';
  end if;

  -- 目標服務人員:必須是同一間商家、在職(§6.3,跟 validate_booking_selection 第 2/4 步一致)。
  select * into v_target
  from public.merchant_staff
  where id = p_target_staff_id
    and merchant_id = v_booking.merchant_id
    and status = 'active';

  if not found then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  -- 復原/回傳用:這筆單目前的(第一位)助手。
  select ba.staff_id into v_prev_assistant_staff_id
  from public.booking_assistants ba
  where ba.booking_id = p_booking_id
  order by ba.created_at, ba.id
  limit 1;
  v_next_assistant_staff_id := v_prev_assistant_staff_id;

  -- [e] 時長永遠不變。
  v_duration := v_booking.end_at - v_booking.start_at;

  if v_dragged_role = 'main' then
    -- ---------------------------------------------------------------
    -- 主服務人員色塊:控制「時間 + 主服務人員」。
    -- ---------------------------------------------------------------
    if p_target_start_at is null then
      raise exception '請指定要移動到的時間';
    end if;

    -- §6.7:秒/毫秒截掉再用,不依賴前端吸附。
    v_new_start := date_trunc('minute', p_target_start_at);
    v_new_end := v_new_start + v_duration;

    v_time_changed := v_new_start is distinct from v_booking.start_at;
    v_staff_changed := v_target.id <> v_booking.staff_id;

    if not v_time_changed and not v_staff_changed then
      -- 5.8:前端遇到「跟原本完全一樣」不會打 RPC;後端收到就當作沒有需要變更的內容擋下,
      -- 避免寫入一筆「沒變」的更新(還會讓前端多送一則推播)。
      raise exception '放開的位置跟原本一樣，沒有需要變更的內容';
    end if;

    if v_staff_changed then
      -- Q5 = A:主轉派給「已經是本單助手」的人,擋下。
      if exists (
        select 1 from public.booking_assistants ba
        where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
      ) then
        raise exception '「%」已經是這筆預約的助手，請先用編輯把助手改掉，或改拖給其他人', v_target.name;
      end if;

      v_mode := 'reassign_main';

      -- 規則 2 / Q1=B:目標服務人員 × 新時段(時間沒變就是原時段)。
      perform private.check_staff_booking_slot(
        v_booking.merchant_id, v_target, v_new_start, v_new_end, p_booking_id, '主要服務人員'
      );
    else
      v_mode := 'time';

      -- 規則 1:主服務人員本人 × 新時段(本人也要在職,跟 validate_booking_selection 第 2 步一致)。
      select * into v_main
      from public.merchant_staff
      where id = v_booking.staff_id
        and merchant_id = v_booking.merchant_id
        and status = 'active';

      if not found then
        raise exception '找不到這位服務人員，或這位服務人員已被移除';
      end if;

      perform private.check_staff_booking_slot(
        v_booking.merchant_id, v_main, v_new_start, v_new_end, p_booking_id, '主要服務人員'
      );
    end if;

    -- 規則 1「須檢測」+ Q1=B 衍生邊界 3:只要時間有變,每一位助手都要用新時段再驗一次
    -- (助手沒有自己的時間欄位,實際時段跟著主單走)。
    if v_time_changed then
      for v_assistant in
        select ms.*
        from public.booking_assistants ba
        join public.merchant_staff ms on ms.id = ba.staff_id
        where ba.booking_id = p_booking_id
        order by ba.created_at, ba.id
      loop
        if v_assistant.status <> 'active' or v_assistant.merchant_id <> v_booking.merchant_id then
          raise exception '找不到其中一位助手，或這位助手已被移除';
        end if;

        perform private.check_staff_booking_slot(
          v_booking.merchant_id, v_assistant, v_new_start, v_new_end, p_booking_id,
          format('助手「%s」', v_assistant.name)
        );
      end loop;
    end if;

    -- [g] 寫入(同一個交易;任何 raise 都會整筆回滾)。
    update public.bookings set
      staff_id = v_target.id,
      start_at = v_new_start,
      end_at = v_new_end,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id;

  else
    -- ---------------------------------------------------------------
    -- 助手色塊:只控制「誰是助手」(Q2 使用者裁決),p_target_start_at 完全忽略。
    -- ---------------------------------------------------------------
    v_mode := 'reassign_assistant';
    v_new_start := v_booking.start_at;
    v_new_end := v_booking.end_at;

    if v_target.id = p_dragged_staff_id then
      -- Q2 衍生邊界 1:助手拖回自己那一欄 = 換成自己 = 沒有任何改變。
      raise exception '放開的位置跟原本一樣，沒有需要變更的內容';
    end if;

    if v_target.id = v_booking.staff_id
       or exists (
         select 1 from public.booking_assistants ba
         where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
       ) then
      raise exception '這位服務人員已經在這筆預約裡了';
    end if;

    -- 規則 3:目標服務人員 × 原時段。
    perform private.check_staff_booking_slot(
      v_booking.merchant_id, v_target, v_booking.start_at, v_booking.end_at, p_booking_id,
      format('助手「%s」', v_target.name)
    );

    -- §6.1:update ... set staff_id,不是 delete+insert(保留 id / created_at,列數不變)。
    update public.booking_assistants
    set staff_id = v_target.id
    where booking_id = p_booking_id
      and staff_id = p_dragged_staff_id;

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows <> 1 then
      raise exception '找不到這位服務人員在這筆預約裡的角色，請重新整理';
    end if;

    update public.bookings set
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id;

    v_prev_assistant_staff_id := p_dragged_staff_id;
    v_next_assistant_staff_id := v_target.id;
    v_staff_changed := true;
  end if;

  -- [h] 回傳。
  select * into v_result from public.bookings where id = p_booking_id;

  return jsonb_build_object(
    'mode', v_mode,
    'booking', to_jsonb(v_result),
    'previous', jsonb_build_object(
      'start_at', v_booking.start_at,
      'end_at', v_booking.end_at,
      'staff_id', v_booking.staff_id,
      'assistant_staff_id', v_prev_assistant_staff_id
    ),
    'next', jsonb_build_object(
      'start_at', v_result.start_at,
      'end_at', v_result.end_at,
      'staff_id', v_result.staff_id,
      'assistant_staff_id', v_next_assistant_staff_id
    ),
    'time_changed', v_time_changed,
    'staff_changed', v_staff_changed
  );
end;
$function$;

revoke execute on function public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid) from PUBLIC, anon;
grant execute on function public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid) to authenticated, service_role;

-- ===== public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_s public.merchant_member_settings;
  v_booking_member_id uuid;
  v_booking_merchant_id uuid;
  v_resolution text;
  v_member_id uuid;
  v_member_name text;
  v_balance integer;
  v_match_count int;
  v_matched_id uuid;
  v_elem jsonb;
  v_subtotal numeric := 0;
  v_qty int;
  v_unit_price numeric;
  v_item_count int;
  v_found_count int;
  v_amount record;
  v_points record;
  v_rules_configured boolean;
  v_available integer := 0;
  v_frozen integer := 0;
  v_redeem_enabled boolean;
  -- 用純量變數而不是 record:record 沒被賦值時,就算 CASE 走不到那一支,
  -- 引用 v_limits.max_points 也會報「record is not assigned yet」(故障注入時抓到)。
  v_max_points integer := 0;
  v_max_amount numeric := 0;
  v_cap_amount numeric := 0;
begin
  -- 1. 權限:跟建單同一把鑰匙(orders)。p_merchant_id 只拿來「問呼叫者對這間店有沒有權限」,
  --    之後每一筆查詢都硬性帶 merchant_id,不信任呼叫端給的任何其他 id。
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查看這間商家的紅利點數預覽' using errcode = '42501';
  end if;

  -- 編輯模式:訂單必須屬於這間商家。「不存在」跟「別家的」回同一個錯誤,不洩漏存不存在。
  if p_booking_id is not null then
    select b.merchant_id, b.member_id into v_booking_merchant_id, v_booking_member_id
    from public.bookings b
    where b.id = p_booking_id;

    if not found or v_booking_merchant_id is distinct from p_merchant_id then
      raise exception '找不到這筆預約，或沒有權限查看' using errcode = '42501';
    end if;
  end if;

  -- 2. 功能關閉 ⇒ 只回一個鍵,不洩漏任何設定或會員資訊。
  v_s := private.merchant_member_settings_effective(p_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    return jsonb_build_object('feature_enabled', false);
  end if;

  -- 3. 決定會員(member.resolution)。
  if p_member_id is not null then
    select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
    from public.members m
    where m.id = p_member_id
      and m.merchant_id = p_merchant_id
      and m.status = 'active';
    if found then
      v_resolution := 'given';
    else
      -- 別家的、已下架的、亂填的 ⇒ 當成沒有會員,不報錯、不洩漏存不存在(#917 IDOR 要求)。
      v_resolution := 'none';
      v_member_id := null;
      v_member_name := null;
      v_balance := null;
    end if;
  elsif p_booking_id is null then
    -- 新增模式:由伺服器依電話找會員,跟 create_booking 用同一支 helper。
    if not private.is_valid_taiwan_phone(p_customer_phone) then
      v_resolution := 'phone_incomplete';
    else
      select r.match_count, r.member_id into v_match_count, v_matched_id
      from private.resolve_booking_member_by_phone(p_merchant_id, p_customer_phone) r;

      if v_match_count = 1 then
        select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
        from public.members m
        where m.id = v_matched_id
          and m.merchant_id = p_merchant_id;
        v_resolution := 'existing';
      elsif v_match_count = 0 then
        v_resolution := 'new';
      else
        v_resolution := 'ambiguous';  -- #931 之後不會發生;當成沒有會員
      end if;
    end if;
  else
    -- 編輯模式且沒給會員 ⇒ 舊的訪客單、沒有補掛(編輯模式後端不依電話比對,§12.7)。
    v_resolution := 'none';
  end if;

  v_rules_configured := case
    when coalesce(v_s.earn_mode, 'basic') = 'advanced' then
      exists (select 1 from public.merchant_point_formulas f where f.merchant_id = p_merchant_id and f.enabled)
    else coalesce(v_s.basic_points_per_order, 0) > 0
  end;

  -- 4./5. 算應付金額 + 呼叫引擎。客服還在填表時(沒選服務項目、格式不對、折扣超過小計…)
  --       回 {"feature_enabled": true, "error": "…"},不要讓前端一直噴 500。
  begin
    if p_service_items is null or jsonb_typeof(p_service_items) <> 'array'
       or jsonb_array_length(p_service_items) = 0 then
      raise exception '請至少選擇一個服務項目';
    end if;

    v_item_count := jsonb_array_length(p_service_items);
    for v_elem in select value from jsonb_array_elements(p_service_items) loop
      if v_elem ->> 'service_item_id' is null then
        raise exception '每個服務項目都必須指定 service_item_id';
      end if;
      v_qty := (v_elem ->> 'quantity')::int;
      if v_qty is null or v_qty < 1 then
        raise exception '服務項目數量必須至少為 1';
      end if;
      v_unit_price := (v_elem ->> 'unit_price')::numeric;
      if v_unit_price is null or v_unit_price < 0 then
        raise exception '請提供每個服務項目的單價，且不能是負數';
      end if;
      -- 跟 validate_booking_selection 的 items_subtotal 同一個算式。
      v_subtotal := v_subtotal + (v_unit_price * v_qty);
    end loop;

    -- 服務項目必須屬於這間商家(不限上架:編輯舊單時可能含已下架項目)。
    select count(*) into v_found_count
    from jsonb_array_elements(p_service_items) as elem
    join public.service_items si
      on si.id = (elem ->> 'service_item_id')::uuid
     and si.merchant_id = p_merchant_id;
    if v_found_count <> v_item_count then
      raise exception '找不到其中一個服務項目';
    end if;

    select * into v_amount from private.calculate_booking_amount(
      v_subtotal,
      p_custom_total_amount_enabled, p_custom_total_amount,
      p_discount_enabled, p_discount_mode, p_discount_value,
      p_tax_enabled, p_tax_mode, p_tax_value
    );

    select * into v_points from private.compute_booking_planned_points(
      p_merchant_id,
      case when v_resolution in ('given', 'existing') then v_member_id else null end,
      p_service_items,
      v_amount.final_amount,
      p_custom_total_amount_enabled,
      p_discount_enabled,
      v_resolution = 'new'
    );
  exception
    when others then
      return jsonb_build_object('feature_enabled', true, 'error', sqlerrm);
  end;

  -- 6. 折抵上限(§2.10)。只有 existing / given 開放('new' 餘額一定是 0)。
  if v_resolution in ('given', 'existing') then
    v_available := coalesce(v_balance, 0);
    -- §〇.4 判斷 22:編輯同一張單、會員也是這張單的會員時,加回本單目前有效凍結
    -- (= −Σ redeem_booking/redeem_booking_refund 的 points_delta,§1.5 淨額定義)。
    if p_booking_id is not null and v_booking_member_id = v_member_id then
      select coalesce(-sum(t.points_delta), 0)::int into v_frozen
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.member_id = v_member_id
        and t.transaction_type in ('redeem_booking', 'redeem_booking_refund');
      v_available := v_available + greatest(v_frozen, 0);
    end if;
  end if;

  v_redeem_enabled := v_resolution in ('given', 'existing')
    and coalesce(v_s.redeem_points_unit, 0) > 0
    and coalesce(v_s.redeem_amount_unit, 0) > 0
    and coalesce(v_s.redeem_max_ratio_percent, 0) > 0;

  if v_redeem_enabled then
    select l.max_points, l.max_amount, l.cap_amount into v_max_points, v_max_amount, v_cap_amount
    from private.compute_booking_redeem_limits(
      v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
      v_amount.final_amount, v_available
    ) l;
  end if;

  -- 7. 回傳。member_id / name / balance 只在 existing / given 時有值。
  return jsonb_build_object(
    'feature_enabled', true,
    'member', jsonb_build_object(
      'resolution', v_resolution,
      'member_id', case when v_resolution in ('existing', 'given') then v_member_id end,
      'name', case when v_resolution in ('existing', 'given') then v_member_name end,
      'balance', case when v_resolution in ('existing', 'given') then v_balance end
    ),
    'rules_configured', v_rules_configured,
    'earn_mode', coalesce(v_s.earn_mode, 'basic'),
    'auto_points', v_points.auto_points,
    'review_required', v_points.review_required,
    'eligible', v_points.eligible,
    'ineligible_reason', v_points.ineligible_reason,
    -- 批次 7:只在「因為核發資格條件拿不到點」時才告訴前端是哪一種條件(文案「需 {條件}」用),
    -- 其餘情況一律 null,不多洩漏商家設定。
    'reward_condition_mode', case when v_points.ineligible_reason = 'reward_condition'
                                  then v_s.reward_condition_mode end,
    'breakdown', v_points.breakdown,
    'redeem', jsonb_build_object(
      'enabled', v_redeem_enabled,
      'points_unit', case when v_redeem_enabled then v_s.redeem_points_unit end,
      'amount_unit', case when v_redeem_enabled then v_s.redeem_amount_unit end,
      'max_ratio_percent', case when v_redeem_enabled then v_s.redeem_max_ratio_percent end,
      'payable', v_amount.final_amount,
      'available_points', v_available,
      'max_points', v_max_points,
      -- v2.4 裁決 10:max_amount = max_points 實際可折金額(畫面「最多可折 NT$X」直接用它);
      -- 比例上限另給 cap_amount。
      'max_amount', v_max_amount,
      'cap_amount', v_cap_amount
    )
  );
end;
$function$;

revoke execute on function public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) from PUBLIC, anon;
grant execute on function public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) to authenticated, service_role;

-- ===== public.recalculate_booking_commission(p_booking_id uuid)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.recalculate_booking_commission(p_booking_id uuid)
 RETURNS booking_commission_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_staff_id uuid;
  v_status text;
  v_commission_record_id uuid;
  v_calc jsonb;
  v_result public.booking_commission_records;
  item jsonb;
begin
  select b.merchant_id, b.staff_id, b.status
  into v_merchant_id, v_staff_id, v_status
  from public.bookings b
  where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '重新計算已完成訂單的抽成金額，只有商家管理員可以操作' using errcode = '42501';
  end if;

  if v_status <> 'completed' then
    raise exception '只有已完成的訂單才能重新計算抽成';
  end if;

  select id into v_commission_record_id
  from public.booking_commission_records
  where booking_id = p_booking_id;

  if v_commission_record_id is null then
    raise exception '這筆訂單目前沒有抽成紀錄，無法重新計算(可能是月薪制服務人員，不適用抽成)';
  end if;

  delete from public.booking_commission_item_records
  where commission_record_id = v_commission_record_id;

  v_calc := private.calculate_booking_staff_commission(p_booking_id, v_staff_id);

  update public.booking_commission_records
  set commission_basis_type_snapshot = v_calc ->> 'commission_basis_type',
      commission_base_amount_snapshot = (v_calc ->> 'total_commission_base_amount')::numeric,
      material_cost_deducted_snapshot = (v_calc ->> 'total_material_cost_deducted')::numeric,
      commission_rate_percentage_snapshot = null,
      commission_amount = (v_calc ->> 'total_commission_amount')::numeric,
      recalculated_at = now()
  where id = v_commission_record_id
  returning * into v_result;

  for item in select * from jsonb_array_elements(v_calc -> 'items')
  loop
    insert into public.booking_commission_item_records (
      commission_record_id, booking_service_item_id, service_item_name_snapshot,
      quantity_snapshot, commission_mode_snapshot, commission_value_snapshot,
      commission_base_amount_snapshot, commission_amount
    ) values (
      v_commission_record_id,
      (item ->> 'booking_service_item_id')::uuid,
      item ->> 'service_item_name',
      (item ->> 'quantity')::integer,
      item ->> 'commission_mode',
      (item ->> 'commission_value')::numeric,
      (item ->> 'commission_base_amount')::numeric,
      (item ->> 'commission_amount')::numeric
    );
  end loop;

  return v_result;
end;
$function$;

revoke execute on function public.recalculate_booking_commission(p_booking_id uuid) from PUBLIC, anon;
grant execute on function public.recalculate_booking_commission(p_booking_id uuid) to authenticated, service_role;

-- ===== public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
  v_assistant_name text;
  v_primary_name text;
  v_deleted integer;
begin
  -- [a] 讀訂單 → 權限 → 狀態(順序跟 update_booking / move_booking 一致:先擋權限,不洩漏狀態)。
  select * into v_booking
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_booking.merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_booking.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能移除協助人員';
  end if;

  if p_staff_id is not distinct from v_booking.staff_id then
    -- 防呆:這支只處理協助人員;主服務人員要換人請用編輯或拖拉轉派,要整張取消請用取消預約。
    raise exception '這位是主服務人員，不能用「移除協助人員」移除';
  end if;

  select ms.name into v_assistant_name
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  select ms.name into v_primary_name
  from public.merchant_staff ms
  where ms.id = v_booking.staff_id;

  -- [b] 只刪這一筆協助關聯。bookings 那一列一個欄位都不碰。
  delete from public.booking_assistants
  where booking_id = p_booking_id
    and staff_id = p_staff_id;
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    -- 兩個人同時操作 / 畫面過期:這位已經不在這張單上了。用 40001 讓前端知道要重抓。
    raise exception '這位協助人員已經不在這筆預約上，畫面已重新整理' using errcode = '40001';
  end if;

  return jsonb_build_object(
    'booking_id', v_booking.id,
    'booking_status', v_booking.status,
    'removed_staff_id', p_staff_id,
    'removed_staff_name', v_assistant_name,
    'primary_staff_id', v_booking.staff_id,
    'primary_staff_name', v_primary_name,
    'remaining_assistant_count', (
      select count(*) from public.booking_assistants where booking_id = p_booking_id
    )
  );
end;
$function$;

revoke execute on function public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid) from PUBLIC, anon;
grant execute on function public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid) to authenticated, service_role;

-- ===== public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid)(改 8 則訊息)=====
CREATE OR REPLACE FUNCTION public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_assistant_staff_ids uuid[] DEFAULT '{}'::uuid[], p_material_cost_item_ids uuid[] DEFAULT '{}'::uuid[], p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_member_id uuid DEFAULT NULL::uuid, p_hide_notes_from_staff boolean DEFAULT false, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT NULL::integer, p_points_override_reset boolean DEFAULT false, p_points_redeem_member_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_industry_type text;
  v_sel record;
  v_amount record;
  v_result public.bookings;
  v_member_name text;
  -- 2026-09-24 修正(B2):這筆預約「既有」的料錢快照對照表,形狀是
  -- {"<material_cost_item_id>": <amount_snapshot>, ...}。在整批刪除關聯表之前先收起來,
  -- 重寫時讓舊品項沿用原本的快照值,只有這次新加的品項才去讀品項目前的金額。
  v_existing_material_snapshots jsonb;
  -- 紅利系統重構 §3.4(批次 3)新增。
  v_old_member_id uuid;
  v_old_planned integer;
  v_old_overridden boolean;
  v_old_redeemed integer;
  v_old_redeem_amount numeric;
  v_old_final_amount numeric;
  v_member_status text;
  v_member_changed boolean;
  v_s public.merchant_member_settings;
  v_points record;
  v_planned integer;
  v_overridden boolean;
  v_target_redeemed integer;
  v_redeem_changed boolean;
  v_new_redeem_amount numeric;
  v_member_balance integer;
  v_frozen integer;
  v_cap numeric;
  v_max_points integer;
begin
  -- 紅利系統重構 批次 3:這一句加上 for update(原本沒有)。改單會動到點數分類帳,
  -- 同一張單的「改單 / 取消 / 退回折抵」必須排隊,鎖的順序一律「訂單 → 會員」
  -- (cancel_booking、private.refund_booking_redeem 同樣先鎖訂單),不會互相死鎖。
  select merchant_id, status, member_id, points_planned, points_planned_overridden,
         points_redeemed, points_redeem_amount_snapshot, final_amount_snapshot
  into v_merchant_id, v_status, v_old_member_id, v_old_planned, v_old_overridden,
       v_old_redeemed, v_old_redeem_amount, v_old_final_amount
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能編輯，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;
  -- SPECS-INDEX #822(2026-09-27):客戶電話格式驗證(手機或市話,市話可帶 # 分機,分隔符號不強制)。
  -- 規則本體在 private.is_valid_taiwan_phone,跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應。
  -- 這裡是「後端函式」那一層;資料庫 CHECK 約束因舊髒資料還沒清(#638)暫時補不上,見本 migration 開頭說明。
  if not private.is_valid_taiwan_phone(p_customer_phone) then
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)';
  end if;

  -- 紅利系統重構 §3.4 第 2 步:兩個派點參數互相矛盾 ⇒ 擋下,不默默選一邊。
  if coalesce(p_points_override_reset, false) and p_points_override is not null then
    raise exception '不能同時清除人工設定又指定新的點數';
  end if;
  if p_points_override is not null then
    if p_points_override < 0 then
      raise exception '派點數不能是負數';
    end if;
    if p_points_override > 100000 then
      raise exception '單筆訂單最多只能設定 100,000 點，請確認是否多打了零';
    end if;
  end if;
  -- v2.4 裁決 22 ①:明確要折抵(> 0)時,畫面確認的會員必須就是這次送出的會員。
  -- (沒有會員的情況交給後面 validate_booking_redeem 回「這筆訂單沒有連結會員」那句更清楚的話。)
  if coalesce(p_points_redeemed, 0) > 0 and p_member_id is not null
     and p_points_redeem_member_id is distinct from p_member_id then
    raise exception '客戶已變更，紅利折抵已重設，請重新確認後送出';
  end if;
  if p_points_redeemed is not null and p_points_redeemed < 0 then
    raise exception '折抵點數不能是負數';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = v_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 模組 10(會員與紅利)§3.6:驗證邏輯跟 create_booking 相同。update_booking 本身既有邏輯
  -- (上面的狀態檢查)已經只允許 pending_confirmation/accepted 呼叫這支函式,訂單一旦
  -- completed,member_id 自然永久鎖定,不需要額外的狀態檢查(判斷 9)。
  --
  -- 🔴 紅利系統重構 批次 3(v2.4 裁決 5 ③)「已下架會員的舊單」改單規則:
  --   ・p_member_id = 這張單**原本**的會員,而那位會員已下架(status = 'removed')⇒ **放行**,
  --     維持連結(姓名快照照樣取會員資料表的姓名)。改版前這種單只要一編輯就被
  --     「已被下架」擋下,前端又一律把原會員帶回來,等於這張單永遠改不動;而且「下架」在這套系統的
  --     定義是「不再出現在名單上」,不是「帳戶結清」(§3.11.2 第 7 步),不該因此卡死訂單。
  --     這種單:原本的折抵可以維持、**調低**(退差額給他,v2.4 裁決 15;調低後照常完整驗證,
  --     換算仍須 >= 1 元)或改成 0(= 全部退回,退回一律不看狀態);**不可增加**(下方 validate 前擋);
  --     派點照規則重算。
  --   ・p_member_id 是**另一位**已下架會員(想改掛到已下架會員)⇒ 跟以前一樣擋下。
  --   ・p_member_id 為 null(呼叫端清空、或根本沒帶這個參數)⇒ 視為「解除會員」,原本有折抵就先整筆退回
  --     (下方「會員變更」處理),不會留下「有折抵、沒會員」的訂單(v2.4 裁決 4/5 ①)。
  v_member_changed := p_member_id is distinct from v_old_member_id;

  if p_member_id is not null then
    select name, status into v_member_name, v_member_status
    from public.members
    where id = p_member_id
      and merchant_id = v_merchant_id;

    if not found or (v_member_status <> 'active' and v_member_changed) then
      raise exception '找不到指定的會員，或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
  );

  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  -- =====================================================================
  -- 紅利系統重構 §3.4 第 2 步:重算系統建議值,決定 planned(第 6 題定案)。
  -- =====================================================================
  v_s := private.merchant_member_settings_effective(v_merchant_id);

  select * into v_points from private.compute_booking_planned_points(
    v_merchant_id,
    p_member_id,
    p_service_items,
    v_amount.final_amount,
    p_custom_total_amount_enabled,
    p_discount_enabled,
    false
  );

  if p_points_override is not null then
    if not coalesce(v_s.points_feature_enabled, true) then
      raise exception '紅利點數功能已關閉，無法設定派點';
    end if;
    v_planned := p_points_override;
    v_overridden := true;
  elsif coalesce(p_points_override_reset, false) then
    -- 客服按了「改用建議值」。
    v_planned := v_points.auto_points;
    v_overridden := false;
  elsif not coalesce(v_old_overridden, false) then
    -- 沒有人工設定 ⇒ 自動跟著金額/會員走(裁決 11)。
    v_planned := v_points.auto_points;
    v_overridden := false;
  else
    -- 已人工設定 ⇒ 保留客服的數字,只更新建議值(前端拿新舊比對後提示 +「改用建議值」鈕)。
    v_planned := v_old_planned;
    v_overridden := true;
  end if;

  -- =====================================================================
  -- 紅利系統重構 §3.4 第 3/4/4-1 步:折抵差異處理。
  --   目標折抵點數:
  --     p_points_redeemed 有值 ⇒ 就是它;
  --     p_points_redeemed 為 null(= 維持)且會員沒變 ⇒ 維持原本的點數;
  --     p_points_redeemed 為 null 但會員變了(含變空)⇒ 0 —— 原折抵扣的是**舊會員**的點數,
  --       不可以默默變成「用新會員的點數折抵」,也不可以留著「有折抵、沒會員」(v2.4 裁決 4/5)。
  --   有變動(會員變了,或點數變了)⇒ 先把舊的整筆退回給當初被扣的會員,再依新值對新會員重新扣。
  -- =====================================================================
  v_target_redeemed := case
    when p_points_redeemed is not null then p_points_redeemed
    when v_member_changed then 0
    else v_old_redeemed
  end;
  v_redeem_changed := v_member_changed or v_target_redeemed <> v_old_redeemed;
  v_new_redeem_amount := v_old_redeem_amount;

  if v_redeem_changed then
    -- 先鎖相關會員列(舊、新兩位,依 id 排序鎖,避免兩張單互換會員時 A→B / B→A 交叉死鎖),
    -- 再退舊、再讀新會員餘額 —— 退完才驗,同一位會員「改折抵點數」時可用點數自然含本單原凍結。
    perform 1
    from public.members
    where id in (v_old_member_id, p_member_id)
    order by id
    for update;

    perform private.refund_booking_redeem(p_booking_id);
    v_new_redeem_amount := 0;

    if v_target_redeemed > 0 then
      -- v2.4 裁決 15:已下架會員(只可能是這張單原本的會員,改掛別位下架會員在上面就擋了)
      -- 只能維持或調低,不可增加;調低 = 退差額給他,下面照常完整驗證(換算仍須 >= 1 元)。
      if p_member_id is not null and v_member_status <> 'active' and v_target_redeemed > v_old_redeemed then
        raise exception '這位會員已下架，不能增加紅利折抵(可以調低或改成 0，把點數退回給會員)';
      end if;

      if p_member_id is not null then
        select points_balance into v_member_balance
        from public.members
        where id = p_member_id;
      end if;

      v_new_redeem_amount := private.validate_booking_redeem(
        v_merchant_id, p_member_id, v_target_redeemed, v_amount.final_amount, v_member_balance
      );
    end if;
  elsif v_old_redeemed > 0 and p_member_id is not null
        and v_amount.final_amount is distinct from v_old_final_amount
        and coalesce(v_s.points_feature_enabled, true)
        and coalesce(v_s.redeem_points_unit, 0) > 0
        and coalesce(v_s.redeem_amount_unit, 0) > 0
        and coalesce(v_s.redeem_max_ratio_percent, 0) > 0 then
    -- §3.4 第 4-1 步 / §〇.4 判斷 21(v2.4 裁決 14 改寫):折抵點數與會員都沒變時,
    -- **只有應付金額跟原本的 final_amount_snapshot 不同才重驗上限**。只改時間/服務人員/備註等
    -- 不重驗 —— 商家事後調低比例,不影響已經談定的舊單(原則同派點快照)。
    -- 原折抵金額超過新上限 ⇒ 擋下,請客服自己決定調降多少(不自動幫客人改點數)。
    -- 商家事後把紅利功能或點數折抵關掉(比例設 0)的舊單不在此列:那時已經沒有「上限」這個設定,
    -- 已折抵的維持原狀(取消時照樣退回),否則每一張有折抵的舊單都會變成改不動。
    select points_balance into v_member_balance
    from public.members
    where id = p_member_id;

    select coalesce(-sum(t.points_delta), 0)::int into v_frozen
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.member_id = p_member_id
      and t.transaction_type in ('redeem_booking', 'redeem_booking_refund');

    select l.cap_amount, l.max_points into v_cap, v_max_points
    from private.compute_booking_redeem_limits(
      v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
      v_amount.final_amount, coalesce(v_member_balance, 0) + greatest(coalesce(v_frozen, 0), 0)
    ) l;

    if v_old_redeem_amount > v_cap then
      raise exception '本單目前最多可折 NT$%(應付 NT$% 的 %)，原本的紅利折抵 % 點(NT$%)已超過上限，請先把折抵點數改成 % 點以下',
        trim_scale(v_cap), trim_scale(v_amount.final_amount), v_s.redeem_max_ratio_percent || '%',
        v_old_redeemed, trim_scale(v_old_redeem_amount), v_max_points;
    end if;
  end if;

  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_sel.end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    customer_address = nullif(btrim(coalesce(p_customer_address, '')), ''),
    notes = p_notes,
    customer_notes = p_customer_notes,
    custom_total_amount_enabled = coalesce(p_custom_total_amount_enabled, false),
    custom_total_amount = p_custom_total_amount,
    subtotal_amount_snapshot = v_amount.subtotal_amount,
    discount_enabled = coalesce(p_discount_enabled, false),
    discount_mode = p_discount_mode,
    discount_value = p_discount_value,
    discount_amount_snapshot = v_amount.discount_amount,
    tax_enabled = coalesce(p_tax_enabled, false),
    tax_mode_snapshot = p_tax_mode,
    tax_value_snapshot = p_tax_value,
    tax_amount_snapshot = v_amount.tax_amount,
    -- 🔴 第 3 題定案 A / §2.11:不扣紅利折抵。
    final_amount_snapshot = v_amount.final_amount,
    payment_method_id = p_payment_method_id,
    payment_method_name_snapshot = v_sel.payment_method_name,
    custom_duration_enabled = coalesce(p_custom_duration_enabled, false),
    custom_duration_minutes = case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    member_id = p_member_id,
    member_name_snapshot = v_member_name,
    -- SPECS-INDEX #852/#857:無條件覆寫,跟這支函式其他欄位同一套語意(見參數清單上的 ⚠️)。
    hide_notes_from_staff = coalesce(p_hide_notes_from_staff, false),
    -- 紅利系統重構 §3.4。
    points_planned = v_planned,
    points_planned_auto = v_points.auto_points,
    points_planned_overridden = v_overridden,
    points_review_required = v_points.review_required,
    points_planned_breakdown = v_points.breakdown,
    points_redeemed = v_target_redeemed,
    points_redeem_amount_snapshot = case when v_target_redeemed = 0 then 0 else v_new_redeem_amount end,
    last_modified_by_user_id = auth.uid(),
    last_modified_at = now()
  where id = p_booking_id;

  -- 紅利系統重構 §3.4 第 4 步:依新值對新會員扣點(同一交易;上面已退過舊的)。
  if v_redeem_changed and v_target_redeemed > 0 then
    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
    ) values (
      p_member_id, v_merchant_id, 'redeem_booking', -v_target_redeemed,
      v_member_balance - v_target_redeemed, p_booking_id,
      format('編輯訂單時使用紅利折抵 %s 點(折 NT$%s)', v_target_redeemed, trim_scale(v_new_redeem_amount)),
      auth.uid()
    );

    update public.members
    set points_balance = v_member_balance - v_target_redeemed
    where id = p_member_id;
  end if;

  -- 2026-09-24 修正(B2):一定要在下面那行 delete「之前」把既有的料錢快照收起來,
  -- 不然整批刪掉之後就再也查不到原始快照了。
  select coalesce(
           jsonb_object_agg(bmc.material_cost_item_id::text, bmc.amount_snapshot),
           '{}'::jsonb
         )
    into v_existing_material_snapshots
  from public.booking_material_costs bmc
  where bmc.booking_id = p_booking_id;

  delete from public.booking_service_items where booking_id = p_booking_id;
  delete from public.booking_assistants where booking_id = p_booking_id;
  delete from public.booking_material_costs where booking_id = p_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    p_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select p_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    -- 2026-09-24 修正(B2):舊品項沿用原本的 amount_snapshot(維持快照原則),
    -- 只有這次新加進來的品項(對照表裡查不到)才讀 material_cost_items.amount 的即時金額。
    -- 比照同一支函式上面服務項目的做法(unit_price 用呼叫端帶入的快照值,不重查 service_items.price)。
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select
      p_booking_id,
      mci.id,
      coalesce(
        (v_existing_material_snapshots ->> mci.id::text)::numeric,
        mci.amount
      )
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$function$;

revoke execute on function public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) from PUBLIC, anon;
grant execute on function public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) to authenticated, service_role;

-- ===== public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_payment_method_name text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  if p_payment_method_id is not null then
    -- 修正(2026-09-19,主腦複查):如果這個 payment_method_id 剛好就是這筆訂單目前已存的值,
    -- 沿用既有快照文字,不重新查詢目前名稱(理由同 private.validate_booking_selection)。
    select payment_method_name_snapshot into v_payment_method_name
    from public.bookings
    where id = p_booking_id and payment_method_id = p_payment_method_id;

    if v_payment_method_name is null then
      -- 跟 private.validate_booking_selection 同樣的放行邏輯:status='active',或是這筆訂單本來
      -- 就已經是這個值(不強制因為商家事後下架而擋下「沒有真的要換」的操作)。
      select name into v_payment_method_name
      from public.payment_methods
      where id = p_payment_method_id
        and merchant_id = v_merchant_id
        and (
          status = 'active'
          or exists (
            select 1 from public.bookings
            where id = p_booking_id and payment_method_id = p_payment_method_id
          )
        );

      if not found then
        raise exception '找不到這個付款方式，或已下架';
      end if;
    end if;
  else
    v_payment_method_name := null;
  end if;

  update public.bookings
  set payment_method_id = p_payment_method_id,
      payment_method_name_snapshot = v_payment_method_name,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid) from PUBLIC, anon;
grant execute on function public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid) to authenticated, service_role;

