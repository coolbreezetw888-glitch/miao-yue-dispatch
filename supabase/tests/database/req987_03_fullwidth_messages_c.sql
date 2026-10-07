-- SPECS-INDEX #987 第 10 批 子批 10-c:建單 / 訂單核心類錯誤訊息全形化 —— 逐字保留證明
-- migration 20261007130200_req987_c_fullwidth_messages_booking_core.sql
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md 第一節 1-3、第五節 5-1。
--
--   每支重建的函式三條斷言:
--   ① 指紋:目前 prosrc(CRLF→LF)把「新訊息」逐一換回「舊訊息」後,md5 必須等於改前指紋。
--      對照表以外的任何差異(多一個空白、改一個運算子)都會讓指紋對不上 ⇒ 變紅。
--   ② 屬性:security definer / volatility / search_path(proconfig)/ ACL / comment 跟改前逐字相同。
--   ③ 觸發器:綁這支函式的觸發器清單(表.名稱:啟用狀態)跟改前相同(不是觸發器函式就是空陣列)。
--   對照表的每一組都是「含單引號的完整 SQL 字串字面值」,避免換到函式裡其他地方的同樣文字。
begin;

select plan(60);

create function pg_temp.req987_oid(p_sig text) returns oid language sql stable as $$
  select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' = p_sig
$$;

-- p_pairs = array[新1, 舊1, 新2, 舊2, ...]
create function pg_temp.req987_swap_back(p_sig text, p_pairs text[]) returns text language plpgsql stable as $$
declare
  v_src text;
begin
  select replace(prosrc, E'\r\n', E'\n') into v_src from pg_proc where oid = pg_temp.req987_oid(p_sig);
  for i in 1 .. coalesce(array_length(p_pairs, 1), 0) / 2 loop
    v_src := replace(v_src, p_pairs[2 * i - 1], p_pairs[2 * i]);
  end loop;
  return v_src;
end $$;

create function pg_temp.req987_attrs(p_sig text) returns text[] language sql stable as $$
  select array[p.prosecdef::text, p.provolatile::text, coalesce(p.proconfig::text, 'NULL'),
               coalesce(p.proacl::text, 'NULL'), coalesce(obj_description(p.oid, 'pg_proc'), 'NULL')]
  from pg_proc p where p.oid = pg_temp.req987_oid(p_sig)
$$;

create function pg_temp.req987_triggers(p_sig text) returns text[] language sql stable as $$
  select coalesce(array_agg(t.tgrelid::regclass::text || '.' || t.tgname::text || ':' || t.tgenabled::text
                            order by t.tgrelid::regclass::text, t.tgname), array[]::text[])
  from pg_trigger t where t.tgfoid = pg_temp.req987_oid(p_sig) and not t.tgisinternal
$$;

-- ----- private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric)$m$, array[
    $m$'已開啟自訂總金額，請輸入金額'$m$, $m$'已開啟自訂總金額,請輸入金額'$m$,
    $m$'計算出來的最終金額不能是負數，請確認折扣/稅金設定'$m$, $m$'計算出來的最終金額不能是負數,請確認折扣/稅金設定'$m$
  ])),
  $m$20dd0b438deedf3040c0fe1b45ab9495$m$,
  $m$private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres}$m$, $m$對應規格書 §2.3/七、建議實作順序第 2 點:create_booking/update_booking 共用的金額計算引擎,依「小計→折扣→稅金→最終金額」固定順序計算,折扣不可超過小計、最終金額不可為負數。只給本模組內部函式呼叫,不對外暴露。$m$],
  $m$private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric)$m$),
  array[]::text[],
  $m$private.calculate_booking_amount(p_items_subtotal numeric, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, OUT subtotal_amount numeric, OUT discount_amount numeric, OUT tax_amount numeric, OUT final_amount numeric) ③ 觸發器綁定不變$m$);

-- ----- private.check_booking_points_redeemed_requires_member() -----
select is(
  md5(pg_temp.req987_swap_back($m$private.check_booking_points_redeemed_requires_member()$m$, array[
    $m$'這筆訂單沒有連結會員，不能使用紅利點數折抵'$m$, $m$'這筆訂單沒有連結會員,不能使用紅利點數折抵'$m$
  ])),
  $m$19c1dd07edc6bb9d1392d4b53f6dd0fd$m$,
  $m$private.check_booking_points_redeemed_requires_member() ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.check_booking_points_redeemed_requires_member()$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$紅利系統重構 §1.4 + v2.4 主腦裁決 2:有折抵點數(points_redeemed > 0)的訂單必須連結會員。只在 INSERT、或 UPDATE 時 points_redeemed 有變更才檢查;會員被硬刪、外鍵 on delete set null 自動清空 member_id 時不擋,也不改動折抵數字(保住帳務報表的歷史折抵金額)。取代原本的表層 CHECK(那會讓 platform_purge 與單一會員硬刪除失敗)。$m$],
  $m$private.check_booking_points_redeemed_requires_member() ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.check_booking_points_redeemed_requires_member()$m$),
  array[$m$bookings.bookings_check_points_redeemed_requires_member:O$m$]::text[],
  $m$private.check_booking_points_redeemed_requires_member() ③ 觸發器綁定不變$m$);

-- ----- private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)$m$, array[
    $m$'%這天是休假日(假別：%)，無法預約'$m$, $m$'%這天是休假日(假別:%),無法預約'$m$,
    $m$'%的預約時段跨到隔天，目前系統不支援，請拆成同一天內的時段'$m$, $m$'%的預約時段跨到隔天,目前系統不支援,請拆成同一天內的時段'$m$,
    $m$'%在這個時段已經有同集團其他分店的預約，請改選其他時段或其他服務人員'$m$, $m$'%在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員'$m$
  ])),
  $m$3e90d220bc68a96cf4228929f85a6c91$m$,
  $m$private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres}$m$, $m$對應規格書 §5.3(模組 5/6/9)+ 模組 7(排班與休假管理)規則 2.7:以半小時為單位逐格檢查商家整體營業時間(第一層)∩服務人員每週時段(第二層)∩單日例外(第三層,staff_availability_overrides)的疊加結果,任何一格不合格就整筆擋下且指出具體時段。unlimited_backend_edit=true 時第一/二/三層(邊界檢查)一併跳過,優先權最高。**主腦裁示(取代排班與休假管理.md 規格書原文規則 2.8 的設計)**:請假整天判斷(模組 7)放在 v_bypass_bounds 判斷區塊之外,一律執行,不受 unlimited_backend_edit 影響——請假期間一律擋下建單,沒有覆寫例外,要安排工作請先呼叫 cancel_staff_leave 取消請假紀錄。無任何單日例外資料時,「無例外的連續格子」會先累積成一段再套用 private.check_staff_legacy_range 的整段判斷(修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界預約被誤判放行的漏洞),因此逐格判斷結果與模組 5 原本的整段範圍判斷完全等價。規則 2.4/2.6 衝突檢查邏輯不變,是獨立的判斷維度,不受第三層或請假判斷影響。private.validate_booking_selection 對主要服務人員呼叫一次、對每一位助手各自呼叫一次。只給本模組內部函式呼叫,不對外暴露。【SPECS-INDEX #924,2026-10-01】「同一個人在別的分店」只在**同一集團內**比對(private.same_person_staff_ids_in_group,跟兩支行事曆函式共用同一支);不同集團的商家完全隔離、互不擋單。錯誤訊息改成「{角色}「{姓名}」在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員」({角色}/{姓名} 是本店自己的服務人員:p_role_label + p_staff.name;助手的 p_role_label 已含姓名就原樣用),不洩漏別家分店的店名/客戶/訂單。【SPECS-INDEX #980 QA,2026-10-06】① 逐格迴圈改用「從半小時格線起點經過多久」(interval)計時,不再用 time 型別逐格 +30 分鐘:原本結束時間落在 23:30~24:00(不含兩端)時 23:30+30 分會繞回 00:00 造成無限迴圈。② 起點不在整點 / 半點(例 09:05)時,單日例外改用半小時格線鍵值(09:00、09:30…)查詢,每一格只檢查預約實際用到的部分;原本會用 09:05、09:35 這種鍵值去查而永遠查不到,單日排休被忽略(誤放行)、單日開啟也被忽略(誤擋)。起點在整點 / 半點的情境判斷結果完全不變。$m$],
  $m$private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)$m$),
  array[]::text[],
  $m$private.check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text) ③ 觸發器綁定不變$m$);

-- ----- private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)$m$, array[
    $m$'%的%到%這個時段不可預約(超出商家營業時間，或超出服務人員可預約時段設定)'$m$, $m$'%的%到%這個時段不可預約(超出商家營業時間,或超出服務人員可預約時段設定)'$m$
  ])),
  $m$ca7da00e8a194242e8869172f0877b96$m$,
  $m$private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m$NULL$m$, $m$規則 2.1∩2.2 的「整段範圍」判斷(不是逐格判斷):[p_range_start, p_range_end) 這一整段是否完整落在商家營業時間內,且存在同一組 staff_availability_windows 完整涵蓋整段。給 private.check_staff_booking_slot 內部呼叫,用來驗證「沒有被單日例外覆蓋的連續區段」,修正 20260919100200_day_override_third_layer.sql 逐格獨立檢查導致橫跨相鄰時段交界的預約被誤判放行的漏洞。只給本模組內部函式呼叫,不對外暴露。$m$],
  $m$private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)$m$),
  array[]::text[],
  $m$private.check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text) ③ 觸發器綁定不變$m$);

-- ----- private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean)$m$, array[
    $m$'原因最多 500 個字，目前是 % 個字，請精簡後再送出'$m$, $m$'原因最多 500 個字,目前是 % 個字,請精簡後再送出'$m$,
    $m$'還原或取消已完成的訂單，只有商家管理員可以操作'$m$, $m$'還原或取消已完成的訂單,只有商家管理員可以操作'$m$,
    $m$'這筆訂單的狀態已經改變，請重新整理後再試'$m$, $m$'這筆訂單的狀態已經改變,請重新整理後再試'$m$,
    $m$'匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入'$m$, $m$'匯入的歷史訂單不能還原,只能取消。如果匯錯了,請取消後重新匯入'$m$,
    $m$'這筆已完成訂單缺少完成時間，資料異常，請聯絡系統管理員'$m$, $m$'這筆已完成訂單缺少完成時間,資料異常,請聯絡系統管理員'$m$
  ])),
  $m$86545d74041b3a71cf197eaa761134af$m$,
  $m$private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$#844 §4.1 反轉引擎(還原完成 / 取消已完成訂單共用)。步驟順序刻意且有 pgTAP 故障注入守著:參數檢查(原因必填、去頭尾空白、上限 500 字)→ for update 鎖訂單 → is_merchant_admin(42501,先擋權限再回報狀態)→ status 必須 completed(否則「狀態已經改變」,冪等)→ 匯入單不能還原 → 讀抽成快照成 jsonb → 【取消路徑】先改 cancelled(保留 completed_at)再 refund_booking_redeem → reverse_booking_earned_points(completed_at 仍在)→ 刪抽成快照(明細 cascade)→ 台北時區算 report_month / is_cross_month → 改最終狀態並清 completed_at → 五參數 log_booking_status_change(note 只放原因)→ 寫 booking_completion_reversals。不發任何通知(p_notify_requested 只寫稽核 notified)。只由 revert_completed_booking / cancel_completed_booking 呼叫。$m$],
  $m$private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean)$m$),
  array[]::text[],
  $m$private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean) ③ 觸發器綁定不變$m$);

-- ----- private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer)$m$, array[
    $m$'應收回點數不一致：呼叫端傳入 % 點，分類帳上這張訂單的有效入帳是 % 點'$m$, $m$'應收回點數不一致:呼叫端傳入 % 點,分類帳上這張訂單的有效入帳是 % 點'$m$,
    $m$'會員「%s」應收回 %s 點，目前只有 %s 點，已收回 %s 點，差額 %s 點未收回。'$m$, $m$'會員「%s」應收回 %s 點,目前只有 %s 點,已收回 %s 點,差額 %s 點未收回。'$m$,
    $m$'應收回 %s 點，會員目前只有 %s 點，已收回 %s 點，差額 %s 點未收回。'$m$, $m$'應收回 %s 點,會員目前只有 %s 點,已收回 %s 點,差額 %s 點未收回。'$m$,
    $m$'這 %s 點是在%s折抵掉的，如果要一併追回，請到%s取消紅利折抵，或用『手動調整點數』扣除。'$m$, $m$'這 %s 點是在%s折抵掉的,如果要一併追回,請到%s取消紅利折抵,或用『手動調整點數』扣除。'$m$,
    $m$'推薦人「%s」應收回推薦獎勵 %s 點，目前只有 %s 點，已收回 %s 點，差額 %s 點未收回；如果要一併追回，請用『手動調整點數』扣除。'$m$, $m$'推薦人「%s」應收回推薦獎勵 %s 點,目前只有 %s 點,已收回 %s 點,差額 %s 點未收回;如果要一併追回,請用『手動調整點數』扣除。'$m$,
    $m$'推薦人應收回推薦獎勵 %s 點，推薦人目前只有 %s 點，已收回 %s 點，差額 %s 點未收回；如果要一併追回，請用『手動調整點數』扣除。'$m$, $m$'推薦人應收回推薦獎勵 %s 點,推薦人目前只有 %s 點,已收回 %s 點,差額 %s 點未收回;如果要一併追回,請用『手動調整點數』扣除。'$m$
  ])),
  $m$9577d051f0b49d261faa28dac76dc458$m$,
  $m$private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$紅利系統重構 §3.11.2(給 #844 的固定合約):收回本單已入帳點數。先 for update 鎖訂單列,再依 id 排序鎖所有要動到的會員。應收回 = 本單有效入帳(Σ earn_booking − Σ 已收回);p_points_due 有傳且不一致 → raise 22023。實收回 = least(應收回, 會員目前餘額),扣到 0 為止,不放寬「不可為負」兩道 CHECK;實收回 > 0 才寫 earn_booking_reversal(note:應收回 N 點、實收回 M 點、差額 K 點未收回),= 0 不寫列(points_delta <> 0)。推薦者因本單拿到的首次/後續推薦獎勵一併同樣收回(referral_bonus_reversal);收回首次獎勵且本單推薦獎勵淨額因此歸 0(全額收回)時才清掉被推薦者 referral_rewarded_at,有差額不清,之後補收齊當次再清(v2.4 裁決 17)。不看會員 status、不看 points_feature_enabled;不動 bookings.points_planned;不做跨訂單自動反轉。淨額為 0 時什麼都不寫、回傳全 0(冪等)。回傳 jsonb:points_due/points_recovered/points_shortfall/referral_due/referral_recovered/referral_shortfall/referrer_member_id/shortfall_hint(有差額時才有值,由呼叫端顯示)。只准內部呼叫。$m$],
  $m$private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer)$m$),
  array[]::text[],
  $m$private.reverse_booking_earned_points(p_booking_id uuid, p_points_due integer) ③ 觸發器綁定不變$m$);

-- ----- private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer)$m$, array[
    $m$'紅利點數功能已關閉，無法使用點數折抵'$m$, $m$'紅利點數功能已關閉,無法使用點數折抵'$m$,
    $m$'這筆訂單沒有連結會員，不能使用紅利點數折抵'$m$, $m$'這筆訂單沒有連結會員,不能使用紅利點數折抵'$m$,
    $m$'這位會員目前只有 % 點，無法折抵 % 點'$m$, $m$'這位會員目前只有 % 點,無法折抵 % 點'$m$,
    $m$'折抵 % 點換算後不到 1 元(目前 % 點 = % 元)，至少要使用 % 點才折得到 1 元'$m$, $m$'折抵 % 點換算後不到 1 元(目前 % 點 = % 元),至少要使用 % 點才折得到 1 元'$m$,
    $m$'這筆訂單的應付金額 NT$% 依商家設定的單次最大使用比例 %，折抵上限不到 1 元，無法使用紅利折抵'$m$, $m$'這筆訂單的應付金額 NT$% 依商家設定的單次最大使用比例 %,折抵上限不到 1 元,無法使用紅利折抵'$m$,
    $m$'本單最多可折抵 NT$%(應付金額 NT$% 的 %)，折抵 % 點可折 NT$%，已超過上限；這位會員本單最多建議使用 % 點'$m$, $m$'本單最多可折抵 NT$%(應付金額 NT$% 的 %),折抵 % 點可折 NT$%,已超過上限;這位會員本單最多建議使用 % 點'$m$
  ])),
  $m$3e131c362cef74e179ca0bf068d4312a$m$,
  $m$private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres}$m$, $m$紅利系統重構 §2.10 + v2.4 裁決 8/12:建單/改單「這次要新扣點」時的折抵驗證,回傳折抵金額(無條件捨去到整數元)。檢查:功能開啟、商家已設定兌換比例與比例上限、有會員、點數 <= 可用點數、換算後 >= 1 元、換算金額 <= cap_amount(max_points 只是建議值,不是硬上限)。錯誤訊息全部是給客服看的白話。算式全部走 redeem_points_to_amount / compute_booking_redeem_limits,不另寫。只准內部呼叫。$m$],
  $m$private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer)$m$),
  array[]::text[],
  $m$private.validate_booking_redeem(p_merchant_id uuid, p_member_id uuid, p_points integer, p_payable_amount numeric, p_available_points integer) ③ 觸發器綁定不變$m$);

-- ----- private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text) -----
select is(
  md5(pg_temp.req987_swap_back($m$private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text)$m$, array[
    $m$'服務項目的數量格式不正確，必須是整數'$m$, $m$'服務項目的數量格式不正確,必須是整數'$m$,
    $m$'服務項目的單價格式不正確，必須是數字'$m$, $m$'服務項目的單價格式不正確,必須是數字'$m$,
    $m$'請提供每個服務項目的單價，且不能是負數'$m$, $m$'請提供每個服務項目的單價,且不能是負數'$m$,
    $m$'找不到其中一個服務項目，或這個服務項目已下架'$m$, $m$'找不到其中一個服務項目,或這個服務項目已下架'$m$,
    $m$'已開啟自訂工時，請輸入大於 0 的總服務時長(分鐘)'$m$, $m$'已開啟自訂工時,請輸入大於 0 的總服務時長(分鐘)'$m$,
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$,
    $m$'找不到其中一位助手，或這位助手已被移除'$m$, $m$'找不到其中一位助手,或這位助手已被移除'$m$,
    $m$'這間商家尚未開啟料錢成本功能，無法選用料錢成本品項'$m$, $m$'這間商家尚未開啟料錢成本功能,無法選用料錢成本品項'$m$,
    $m$'找不到其中一個料錢成本品項，或已下架'$m$, $m$'找不到其中一個料錢成本品項,或已下架'$m$,
    $m$'找不到這個付款方式，或已下架'$m$, $m$'找不到這個付款方式,或已下架'$m$
  ])),
  $m$ce64c091a92de894087be1376e32e887$m$,
  $m$private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres}$m$, $m$對應規則 3.5 第 7 點,模組 9 v2 付款方式驗證 + SPECS-INDEX #604 必填疊加:create_booking/update_booking 共用的驗證邏輯。#604:p_payment_method_id 為 null 時,create_booking(p_exclude_booking_id is null)一律擋下;update_booking 只在這筆訂單目前已存的值也是 null 時放行(維持原值),主動清空才擋下。其餘付款方式驗證邏輯(存在性/狀態/快照不重新整理)完全不動,見 20260919130400 的既有說明。#985:編輯既有訂單時,訂單原本就有的料錢品項維持原值,不要求料錢功能開啟、不要求仍上架;新加品項照舊檢查。只給本模組內部函式呼叫,不對外暴露。$m$],
  $m$private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text)$m$),
  array[]::text[],
  $m$private.validate_booking_selection(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_exclude_booking_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_payment_method_id uuid, OUT end_at timestamp with time zone, OUT items_subtotal numeric, OUT payment_method_name text) ③ 觸發器綁定不變$m$);

-- ----- public.cancel_booking(p_booking_id uuid, p_reason text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.cancel_booking(p_booking_id uuid, p_reason text)$m$, array[
    $m$'只有「待確認」或「已確認」狀態的預約可以取消，目前狀態不允許這個操作(目前狀態：%)'$m$, $m$'只有「待確認」或「已確認」狀態的預約可以取消,目前狀態不允許這個操作(目前狀態:%)'$m$
  ])),
  $m$36df95bc55e9a519eab036c7e6dfe1bc$m$,
  $m$public.cancel_booking(p_booking_id uuid, p_reason text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.cancel_booking(p_booking_id uuid, p_reason text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應建單功能擴充規格書 2.4/決策記錄 5 第 4 點:取消預約,可取消狀態是 pending_confirmation 或 accepted。預約詳情資訊擴充與建單備註分類第三節 3.3 點:成功執行時一併寫入 last_modified_by_user_id/last_modified_at。模組 6 §9.1(SPECS-INDEX #597)新增:成功執行時一併寫入一筆 booking_status_change_logs。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查。不算危險操作,不需要 JSON 備份。$m$],
  $m$public.cancel_booking(p_booking_id uuid, p_reason text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.cancel_booking(p_booking_id uuid, p_reason text)$m$),
  array[]::text[],
  $m$public.cancel_booking(p_booking_id uuid, p_reason text) ③ 觸發器綁定不變$m$);

-- ----- public.complete_booking(p_booking_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.complete_booking(p_booking_id uuid)$m$, array[
    $m$'只有「已接受」狀態的預約可以標記完成，目前狀態不允許這個操作'$m$, $m$'只有「已接受」狀態的預約可以標記完成,目前狀態不允許這個操作'$m$
  ])),
  $m$a1b9c712eac0b47e99f57e13a9013705$m$,
  $m$public.complete_booking(p_booking_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.complete_booking(p_booking_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$把預約標記為完成(模組 6)。模組 8(薪資與帳務)§3.7 疊加呼叫 compute_booking_commission;模組 10(會員與紅利)§3.8 疊加呼叫 compute_member_loyalty_points;模組 6 §9.1(SPECS-INDEX #597)疊加寫入一筆 booking_status_change_logs。三者都在訂單狀態成功轉為 completed 之後、return 之前執行,各自寫各自的表,互不影響、互不覆蓋。簽章/回傳型別/呼叫方式完全不變。$m$],
  $m$public.complete_booking(p_booking_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.complete_booking(p_booking_id uuid)$m$),
  array[]::text[],
  $m$public.complete_booking(p_booking_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.confirm_booking(p_booking_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.confirm_booking(p_booking_id uuid)$m$, array[
    $m$'只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：%)'$m$, $m$'只有「待確認」狀態的預約可以確認,目前狀態不允許這個操作(目前狀態:%)'$m$
  ])),
  $m$f2bd4e2eb613e316a307f6b91b7daeb3$m$,
  $m$public.confirm_booking(p_booking_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.confirm_booking(p_booking_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應建單功能擴充規格書 4.8/決策記錄 5:把 pending_confirmation 轉成 accepted。預約詳情資訊擴充與建單備註分類第三節 3.3 點:成功執行時一併寫入 last_modified_by_user_id/last_modified_at。模組 6 §9.1(SPECS-INDEX #597)新增:成功執行時一併寫入一筆 booking_status_change_logs。權限比照建單權限(orders section_key)。已知限制(規格書 2.4):這次不重新驗證時段衝突。不算危險操作,不觸發任何通知。$m$],
  $m$public.confirm_booking(p_booking_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.confirm_booking(p_booking_id uuid)$m$),
  array[]::text[],
  $m$public.confirm_booking(p_booking_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid)$m$, array[
    $m$'客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$, $m$'客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$,
    $m$'單筆訂單最多只能設定 100,000 點，請確認是否多打了零'$m$, $m$'單筆訂單最多只能設定 100,000 點,請確認是否多打了零'$m$,
    $m$'這支電話底下有 % 位客戶，請先在建單畫面選擇這筆訂單是哪一位'$m$, $m$'這支電話底下有 % 位客戶,請先在建單畫面選擇這筆訂單是哪一位'$m$,
    $m$'找不到指定的會員，或會員不屬於這間商家/已被下架'$m$, $m$'找不到指定的會員,或會員不屬於這間商家/已被下架'$m$,
    $m$'紅利點數功能已關閉，無法設定派點'$m$, $m$'紅利點數功能已關閉,無法設定派點'$m$,
    $m$'客戶已變更，紅利折抵已重設，請重新確認後送出'$m$, $m$'客戶已變更,紅利折抵已重設,請重新確認後送出'$m$
  ])),
  -- 第 11 批 F #993(migration 20261007140300)把料錢參數改成 jsonb(數量 / 自訂成本單價),基準改成「F 版本換回舊訊息後」的指紋;第 10 批改前指紋 8de032182d92969cd4bd3339939c9397
  $m$653f14c2a8d189eac09c34231b5a73dc$m$,
  $m$public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$建立預約(模組 5/6/9/10 + #852 + #912 自動會員 + 紅利系統重構批次 3)。新增訂單時前端不帶 p_member_id,由電話自動連結/建立會員(private.resolve_booking_member_by_phone,與 preview_booking_points 同一支)。派點快照由 private.compute_booking_planned_points 計算(與預覽同一支引擎);p_points_override = 客服人工派點(0~100,000);p_points_redeemed = 折抵點數(建單當下就從會員餘額扣,分類帳 redeem_booking);p_points_redeem_member_id = 要扣誰的點數(折抵 > 0 時必帶且須等於伺服器決定的會員,v2.4 裁決 22 ①)。final_amount_snapshot 不扣折抵(第 3 題定案 A)。$m$],
  $m$public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid)$m$),
  array[]::text[],
  $m$public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_redeem_member_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.get_booking_points_ledger(p_booking_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_booking_points_ledger(p_booking_id uuid)$m$, array[
    $m$'找不到這筆預約，或沒有權限查看'$m$, $m$'找不到這筆預約,或沒有權限查看'$m$
  ])),
  $m$5ead5d7e4c229ddad154d1ee37bca8f9$m$,
  $m$public.get_booking_points_ledger(p_booking_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_booking_points_ledger(p_booking_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$紅利系統重構批次 7(§4.7):訂單詳情「已入帳 N 點 / 已收回」用。回傳 {earned_points(本單 earn_booking 加總;從未入帳為 null), reversed_points(本單 earn_booking_reversal 收回點數), effective_points(有效入帳 = 入帳 − 收回,從未入帳為 null)}。權限 = orders 鑰匙(can_manage_bookings);不存在 / 別家訂單同一個 42501。存在理由:分類帳 SELECT 要 members 鑰匙,訂單詳情只需要 orders 鑰匙;只回這張單的三個數字。$m$],
  $m$public.get_booking_points_ledger(p_booking_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_booking_points_ledger(p_booking_id uuid)$m$),
  array[]::text[],
  $m$public.get_booking_points_ledger(p_booking_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.get_completed_booking_reversal_preview(p_booking_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_completed_booking_reversal_preview(p_booking_id uuid)$m$, array[
    $m$'還原或取消已完成的訂單，只有商家管理員可以操作'$m$, $m$'還原或取消已完成的訂單,只有商家管理員可以操作'$m$,
    $m$'這筆訂單的狀態已經改變，請重新整理後再試'$m$, $m$'這筆訂單的狀態已經改變,請重新整理後再試'$m$,
    $m$'匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入。'$m$, $m$'匯入的歷史訂單不能還原,只能取消。如果匯錯了,請取消後重新匯入。'$m$,
    $m$'服務人員「%s」已經移除。還原後這張單無法編輯或改時間，只能重新完成或取消。'$m$, $m$'服務人員「%s」已經移除。還原後這張單無法編輯或改時間,只能重新完成或取消。'$m$,
    $m$'服務人員「%s」目前已改成月薪制。這次會收回原本的抽成，之後重新完成也不會再產生抽成。'$m$, $m$'服務人員「%s」目前已改成月薪制。這次會收回原本的抽成,之後重新完成也不會再產生抽成。'$m$,
    $m$'這張單的抽成曾經人工重算過。收回後原本重算的結果不會保留，重新完成時會依當時的設定重新計算。'$m$, $m$'這張單的抽成曾經人工重算過。收回後原本重算的結果不會保留,重新完成時會依當時的設定重新計算。'$m$
  ])),
  $m$367f2027e4b909a66142462806fd9839$m$,
  $m$public.get_completed_booking_reversal_preview(p_booking_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_completed_booking_reversal_preview(p_booking_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$#844 §4.2:還原/取消已完成訂單前的「這次會連帶影響」清單資料來源。只有商家管理員可以(42501,先擋權限再回報狀態);訂單不是 completed → raise。只讀不鎖、不呼叫會寫入的紅利函式;點數算法逐字比照 reverse_booking_earned_points(取消路徑先模擬退回折抵)。回傳 can_revert/can_cancel/blocked_reasons、staff、commission、completed_at、report_month、is_cross_month、months_ago(台北時區)、revenue_amount、member、points{members[], points_due_expected, frozen_points, referral}、warnings。含會員/推薦人姓名與餘額,只給管理員。$m$],
  $m$public.get_completed_booking_reversal_preview(p_booking_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_completed_booking_reversal_preview(p_booking_id uuid)$m$),
  array[]::text[],
  $m$public.get_completed_booking_reversal_preview(p_booking_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)$m$, array[
    $m$'這筆預約剛剛被其他人改過，畫面已重新整理，請再拖一次'$m$, $m$'這筆預約剛剛被其他人改過,畫面已重新整理,請再拖一次'$m$,
    $m$'找不到這位服務人員在這筆預約裡的角色，請重新整理'$m$, $m$'找不到這位服務人員在這筆預約裡的角色,請重新整理'$m$,
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$,
    $m$'放開的位置跟原本一樣，沒有需要變更的內容'$m$, $m$'放開的位置跟原本一樣,沒有需要變更的內容'$m$,
    $m$'「%」已經是這筆預約的助手，請先用編輯把助手改掉，或改拖給其他人'$m$, $m$'「%」已經是這筆預約的助手,請先用編輯把助手改掉,或改拖給其他人'$m$,
    $m$'找不到其中一位助手，或這位助手已被移除'$m$, $m$'找不到其中一位助手,或這位助手已被移除'$m$
  ])),
  $m$11b37a204905a48c3cbe812b6dfbc0a0$m$,
  $m$public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$行事曆拖拉專用的「移動預約」(SPECS-INDEX #807~#810,規格書 行事曆拖拉改時間與轉派.md §3.1/§六/§十一之〇)。三種 mode:time(主服務人員色塊在同一欄改時間 → update bookings.start_at/end_at,助手列不動但實際時段跟著走)、reassign_main(主服務人員色塊拖到別人的欄位 → update bookings.staff_id,助手名單不變)、reassign_assistant(助手色塊拖到別人的欄位 → update booking_assistants.staff_id,不是 delete+insert)。使用者裁決(2026-09-27):Q1 斜拖 = B「人跟時間一起改」→ mode 仍是 reassign_main 但 staff_id 與 start_at/end_at 同時更新、time_changed=true,助手要用新時段再驗一次;Q2 拖助手 = 一律只換助手、p_target_start_at 完全忽略(助手的時間跟著主服務人員走),助手拖回自己欄位視為沒有變動而擋下;Q3 拖到過去 = 允許(後端不擋,前端跳確認框);Q5 主轉派給既有助手 = A 擋下。時長(end_at−start_at)永遠不變。所有衝突/休假/排班/跨日/跨店檢查一律呼叫 private.check_staff_booking_slot(p_exclude_booking_id=這筆單),錯誤訊息沿用原文。p_expected_start_at/p_expected_staff_id 跟現況不符 → 40001(畫面過期)。回傳 {mode, booking, previous, next, time_changed, staff_changed},previous/next 給前端復原用(復原=反向再呼叫一次,會重新驗證)。不呼叫任何通知函式,不動 booking_service_items/booking_material_costs。$m$],
  $m$public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)$m$),
  array[]::text[],
  $m$public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)$m$, array[
    $m$'找不到這筆預約，或沒有權限查看'$m$, $m$'找不到這筆預約,或沒有權限查看'$m$,
    $m$'請提供每個服務項目的單價，且不能是負數'$m$, $m$'請提供每個服務項目的單價,且不能是負數'$m$
  ])),
  -- 第 11 批 A #939(migration 20261007140150)改寫了會員判斷,基準改成「A 版本換回舊訊息後」的指紋;第 10 批改前指紋 a8e435488a282d73ca476b615898f343
  $m$95c5923d88bc700377fef91084e052a1$m$,
  $m$public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$紅利系統重構 §3.2(v2.3,#842;取代 #917):建單/改單頁的紅利即時預覽,唯讀。權限 = orders 鑰匙(can_manage_bookings);別家商家的 p_booking_id ⇒ 42501;別家/下架/亂填的 p_member_id ⇒ 當成沒有會員(不洩漏存不存在)。新增模式依電話找會員(resolve_booking_member_by_phone,與 create_booking 同一支);找不到 ⇒ resolution=new,以全新會員屬性試算派點、不開放折抵。功能關閉只回 {"feature_enabled": false}。派點一律由 compute_booking_planned_points 計算(與建單同一支引擎),折抵上限由 compute_booking_redeem_limits 計算。批次 7:多回 reward_condition_mode,只在 ineligible_reason = reward_condition 時有值(畫面文案「需 {條件}」用)。不放寬 merchant_member_settings 的 SELECT 政策。$m$],
  $m$public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)$m$),
  array[]::text[],
  $m$public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) ③ 觸發器綁定不變$m$);

-- ----- public.recalculate_booking_commission(p_booking_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.recalculate_booking_commission(p_booking_id uuid)$m$, array[
    $m$'重新計算已完成訂單的抽成金額，只有商家管理員可以操作'$m$, $m$'重新計算已完成訂單的抽成金額,只有商家管理員可以操作'$m$,
    $m$'這筆訂單目前沒有抽成紀錄，無法重新計算(可能是月薪制服務人員，不適用抽成)'$m$, $m$'這筆訂單目前沒有抽成紀錄,無法重新計算(可能是月薪制服務人員,不適用抽成)'$m$
  ])),
  $m$cdabc100207b2e27cc062f3303b5f501$m$,
  $m$public.recalculate_booking_commission(p_booking_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.recalculate_booking_commission(p_booking_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$NULL$m$],
  $m$public.recalculate_booking_commission(p_booking_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.recalculate_booking_commission(p_booking_id uuid)$m$),
  array[]::text[],
  $m$public.recalculate_booking_commission(p_booking_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid)$m$, array[
    $m$'這位是主服務人員，不能用「移除協助人員」移除'$m$, $m$'這位是主服務人員,不能用「移除協助人員」移除'$m$,
    $m$'這位協助人員已經不在這筆預約上，畫面已重新整理'$m$, $m$'這位協助人員已經不在這筆預約上,畫面已重新整理'$m$
  ])),
  $m$4cadaace0c7577340819f88a639dfc96$m$,
  $m$public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$SPECS-INDEX #873:只移除一位協助人員(delete 一筆 booking_assistants),訂單本身(狀態/時間/金額/紅利/最後修改)完全不動,主服務人員的單維持不變。權限 private.can_manage_bookings;只允許 pending_confirmation / accepted;這位已不在單上 → 40001。不呼叫通知;被移除那位的服務人員端由 #874 booking_assistants trigger 發重查訊號。回傳 {booking_id, booking_status, removed_staff_id, removed_staff_name, primary_staff_id, primary_staff_name, remaining_assistant_count}。$m$],
  $m$public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid)$m$),
  array[]::text[],
  $m$public.remove_booking_assistant(p_booking_id uuid, p_staff_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid)$m$, array[
    $m$'已完成或已取消的預約不能編輯，目前狀態不允許這個操作(目前狀態：%)'$m$, $m$'已完成或已取消的預約不能編輯,目前狀態不允許這個操作(目前狀態:%)'$m$,
    $m$'客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$, $m$'客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$,
    $m$'單筆訂單最多只能設定 100,000 點，請確認是否多打了零'$m$, $m$'單筆訂單最多只能設定 100,000 點,請確認是否多打了零'$m$,
    $m$'客戶已變更，紅利折抵已重設，請重新確認後送出'$m$, $m$'客戶已變更,紅利折抵已重設,請重新確認後送出'$m$,
    $m$'找不到指定的會員，或會員不屬於這間商家/已被下架'$m$, $m$'找不到指定的會員,或會員不屬於這間商家/已被下架'$m$,
    $m$'紅利點數功能已關閉，無法設定派點'$m$, $m$'紅利點數功能已關閉,無法設定派點'$m$,
    $m$'這位會員已下架，不能增加紅利折抵(可以調低或改成 0，把點數退回給會員)'$m$, $m$'這位會員已下架,不能增加紅利折抵(可以調低或改成 0,把點數退回給會員)'$m$,
    $m$'本單目前最多可折 NT$%(應付 NT$% 的 %)，原本的紅利折抵 % 點(NT$%)已超過上限，請先把折抵點數改成 % 點以下'$m$, $m$'本單目前最多可折 NT$%(應付 NT$% 的 %),原本的紅利折抵 % 點(NT$%)已超過上限,請先把折抵點數改成 % 點以下'$m$
  ])),
  -- 第 11 批 A #939(migration 20261007140150)改寫了會員判斷,基準改成「A 版本換回舊訊息後」的指紋;第 10 批改前指紋 ad73011a8c051b81809b0bf681b3c4e5
  -- 第 11 批 F #993(migration 20261007140300)再改料錢參數與寫入,基準再改成「F 版本換回舊訊息後」;A 版本為 03794e2fc0ee47f63c3c7da1f9435029
  $m$d9d3aff5c3e5e4b154cac826dba9ef88$m$,
  $m$public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$編輯預約(模組 5/6/9/10 + #852 + 紅利系統重構批次 3)。p_member_id / p_hide_notes_from_staff 仍是無條件覆寫(前端一律帶值)。紅利:每次重算系統建議派點;p_points_override 有值 = 人工設定、null = 維持(已人工設定就保留客服數字);p_points_override_reset = 改用建議值;p_points_redeemed default null = 維持原折抵,有值才改。會員變更(含變空)而原本有折抵 ⇒ 先整筆退回給原會員。折抵與會員都沒變時,只有應付金額變動才重驗上限,原折抵超過新上限 ⇒ 擋下(v2.4 裁決 14)。原會員已下架時可維持連結、可調低或改 0、不可增加(v2.4 裁決 15)。p_points_redeemed > 0 時 p_points_redeem_member_id 必須等於 p_member_id(v2.4 裁決 22 ①)。$m$],
  $m$public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid)$m$),
  array[]::text[],
  $m$public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_items jsonb, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid)$m$, array[
    $m$'已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：%)'$m$, $m$'已完成或已取消的預約不能修改付款方式,目前狀態不允許這個操作(目前狀態:%)'$m$,
    $m$'找不到這個付款方式，或已下架'$m$, $m$'找不到這個付款方式,或已下架'$m$
  ])),
  $m$4cceaae30c232e6bfa8a8115e60c62bb$m$,
  $m$public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應模組 9 v2:單獨更新一筆預約的付款方式(FK+快照兩欄一起寫),不需要傳服務項目/金額等其餘欄位。權限/狀態限制跟 update_booking 一致。傳 null 代表清空成「尚未設定」。目前秒約內部前端沒有任何頁面呼叫這支(CalendarPage 走完整的 update_booking),保留純粹是模組獨立性的對外介面,供之後其他模組(例如未來的客戶端付款頁)直接複用。修正紀錄(2026-09-19,主腦複查):p_payment_method_id 維持這筆訂單原值時,沿用既有 payment_method_name_snapshot,不重新查詢 payment_methods.name(見 20260919130400 修正 migration),避免商家事後改名連帶洗掉沒有主動變更付款方式的歷史訂單顯示文字。$m$],
  $m$public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid)$m$),
  array[]::text[],
  $m$public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid) ③ 觸發器綁定不變$m$);

select * from finish();
rollback;
