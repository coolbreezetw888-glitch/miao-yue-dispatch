-- SPECS-INDEX #987 第 10 批 子批 10-b:會員 / 紅利 / 服務人員 / 客服 / 排班類錯誤訊息全形化 —— 逐字保留證明
-- migration 20261007130100_req987_b_fullwidth_messages_member_staff.sql
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md 第一節 1-3、第五節 5-1。
--
--   每支重建的函式三條斷言:
--   ① 指紋:目前 prosrc(CRLF→LF)把「新訊息」逐一換回「舊訊息」後,md5 必須等於改前指紋。
--      對照表以外的任何差異(多一個空白、改一個運算子)都會讓指紋對不上 ⇒ 變紅。
--   ② 屬性:security definer / volatility / search_path(proconfig)/ ACL / comment 跟改前逐字相同。
--   ③ 觸發器:綁這支函式的觸發器清單(表.名稱:啟用狀態)跟改前相同(不是觸發器函式就是空陣列)。
--   對照表的每一組都是「含單引號的完整 SQL 字串字面值」,避免換到函式裡其他地方的同樣文字。
begin;

select plan(75);

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
  -- SPECS-INDEX #1025 FG1-F02:import_members_batch / import_historical_bookings_batch 多一段資料匯入功能開關(有 [req1025 begin/end] 標記),先拿掉再比對改前指紋。
  v_src := regexp_replace(v_src, '  -- \[req1025 begin\].*?-- \[req1025 end\]\n', '', 'g');
  -- 第 22 批 #1023:set_staff_day_override 多了一段「時段外不能開放」(有標記),先拿掉再換回舊訊息比對改前指紋。
  v_src := regexp_replace(v_src, '  -- \[req1023-batch22 begin\].*?-- \[req1023-batch22 end\]\n\n', '', 'g');
  -- 客戶端第 3 批 C3-E01:get_my_booking_schedule 每筆多回 source / is_guest_booking(只加這幾行),先拿掉再比對改前指紋。
  v_src := replace(v_src, E'      ''source'', bb.source,\n      ''is_guest_booking'', bb.is_guest_booking,\n', '');
  v_src := replace(v_src, E'      b.source, b.is_guest_booking,\n', '');
  -- 客戶端第 4-B 批 C4-K03:create_member / update_member / reactivate_member 各多一行聯絡人電話檢查,先拿掉再比對改前指紋。
  v_src := regexp_replace(v_src, E'  perform private\\.assert_phone_not_member_contact\\([^\\n]*\\);\\n\\n', '', 'g');
  -- 客戶端第 4-B 批:transfer_members_to_merchant 多一段清聯絡人(有 [c4b begin/end] 標記),先拿掉再比對改前指紋。
  v_src := regexp_replace(v_src, E'  -- \\[c4b begin\\].*?-- \\[c4b end\\]\\n\\n', '', 'g');
  -- 客戶端第 4-A 批 C4-A04:update_member 多 p_address(只加這幾段),先拿掉再比對改前指紋。
  if p_sig like 'public.update_member(%' then
    v_src := replace(v_src, ', p_address text DEFAULT NULL::text)', ')');
    v_src := replace(v_src, E'  v_address text;
', '');
    v_src := replace(v_src, E'  if p_address is not null then
    v_address := nullif(btrim(p_address), '''');
    if char_length(coalesce(v_address, '''')) > 200 then
      raise exception ''地址最多 200 字。'' using errcode = ''22023'', hint = ''invalid_address'';
    end if;
  end if;

', '');
    v_src := replace(v_src, E'    tier_id = p_tier_id,
    address = case when p_address is null then address else v_address end
', E'    tier_id = p_tier_id
');
  end if;
  -- #1035 B 批 PB-U03:create_staff_leave 第 2 步多放行日薪制、時薪制(多一行註解 + 條件 + 訊息),先換回再比對改前指紋。
  if p_sig like 'public.create_staff_leave(%' then
    v_src := replace(v_src, E'  -- #1035 B 批(PB-U03):日薪制、時薪制也可以登記(請假那天上工時間 = 0,不套假別扣款規則);抽成制照舊擋。
', '');
    v_src := replace(v_src, E'if v_compensation_type not in (''monthly_salary'', ''daily_wage'', ''hourly_wage'') then',
                            E'if v_compensation_type <> ''monthly_salary'' then');
    v_src := replace(v_src, '只有月薪制、日薪制、時薪制的服務人員可以登記請假紀錄', '只有月薪制的服務人員可以登記請假紀錄');
  end if;
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

-- ----- private.protect_merchant_member_settings_rule_columns() -----
select is(
  md5(pg_temp.req987_swap_back($m$private.protect_merchant_member_settings_rule_columns()$m$, array[
    $m$'紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改；「會員管理」權限可以做手動調整與登記兌換，但不能改這些規則'$m$, $m$'紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改;「會員管理」權限可以做手動調整與登記兌換,但不能改這些規則'$m$,
    -- 第 11 批 #989(migration 20261007140100)把生日預設文案比對字串也改成全形,一起換回才對得上第 10 批改前指紋
    $m$'生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。'$m$, $m$'生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。'$m$
  ])),
  $m$7d7219e604c42778bdf4f2a25987d140$m$,
  $m$private.protect_merchant_member_settings_rule_columns() ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.protect_merchant_member_settings_rule_columns()$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m$NULL$m$, $m$2026-09-24 使用者裁決(紅利點數管理權限拆分)的欄位層級保護;2026-10-01 紅利系統重構批次 1(§3.10)擴充保護清單、批次 6 隨 drop column 移除 points_earn_rate。merchant_member_settings 是整列 upsert(PostgREST 不是 RPC),RLS 的 UPDATE policy 是整列層級、WITH CHECK 看不到 OLD,所以用 BEFORE INSERT OR UPDATE trigger(比照 merchant_staff 上既有三支保護 trigger)。兩組欄位對稱處理:「紅利點數規則」= points_feature_enabled/reward_condition_mode/referral_bonus_points/birthday_bonus_points + 紅利計算(earn_mode/basic_points_per_order/basic_min_amount/basic_tiered_enabled)+ 點數使用(redeem_points_unit/redeem_amount_unit/redeem_max_ratio_percent)+ 推薦系統(referral_inviter_reward_enabled/referral_subsequent_bonus_points/referral_inviter_earning_enabled/referral_invitee_earning_enabled)+ 生日獎勵(birthday_bonus_enabled/birthday_line_message),要 private.can_manage_member_points;會員政策兩欄(policy_enabled/policy_content)要 private.can_manage_member_settings。⚠️ 判斷的是「值真的有變動」(is distinct from)而不是「payload 有沒有帶這個欄位」。INSERT 面跟 schema 實際預設值比對;seed_default_member_settings 只帶 merchant_id,所以建立新商家的路徑一定不會被擋。$m$],
  $m$private.protect_merchant_member_settings_rule_columns() ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.protect_merchant_member_settings_rule_columns()$m$),
  array[$m$merchant_member_settings.merchant_member_settings_protect_rule_columns:O$m$]::text[],
  $m$private.protect_merchant_member_settings_rule_columns() ③ 觸發器綁定不變$m$);

-- ----- private.protect_merchant_staff_pending_login_email_columns() -----
select is(
  md5(pg_temp.req987_swap_back($m$private.protect_merchant_staff_pending_login_email_columns()$m$, array[
    $m$'不能透過一般編輯直接變更登入信箱建議，請透過「修改登入信箱」的功能操作'$m$, $m$'不能透過一般編輯直接變更登入信箱建議,請透過「修改登入信箱」的功能操作'$m$
  ])),
  $m$062526f9f0e72e903fdd69dd2bf16d84$m$,
  $m$private.protect_merchant_staff_pending_login_email_columns() ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$private.protect_merchant_staff_pending_login_email_columns()$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m$NULL$m$, $m$對應規格書 2.2.1 邊界情況:擋下對 merchant_staff 三個 pending_admin_login_email* 欄位的直接 UPDATE,只放行 service_role 或已設定 staff_agent.bypass_pending_login_email_guard 旗標(request_staff_login_email_change/clear_staff_pending_login_email 專用)的呼叫。$m$],
  $m$private.protect_merchant_staff_pending_login_email_columns() ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$private.protect_merchant_staff_pending_login_email_columns()$m$),
  array[$m$merchant_staff.merchant_staff_protect_pending_login_email_columns:O$m$]::text[],
  $m$private.protect_merchant_staff_pending_login_email_columns() ③ 觸發器綁定不變$m$);

-- ----- public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text)$m$, array[
    $m$'手動調整會員點數，只有商家管理員可以操作'$m$, $m$'手動調整會員點數,只有商家管理員可以操作'$m$,
    $m$'這位會員目前只有 % 點，調整後不能變成負數'$m$, $m$'這位會員目前只有 % 點,調整後不能變成負數'$m$
  ])),
  $m$69fa3e54b23a81ee8c9f348960106b5d$m$,
  $m$public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 10 §3.10(核心,規則 2.6):手動調整會員點數,只有商家管理員可以呼叫(private.is_merchant_admin),不透過 merchant_agent_permissions 開放給客服——比照模組 8 recalculate_booking_commission 的同一套理由,這是能無中生有增減點數餘額(等同一種「準金錢」價值)的敏感操作。p_note 必填(要求填寫調整原因)。不允許調整後餘額變負(規則 2.7),管理員最多只能扣到剛好 0。$m$],
  $m$public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text)$m$),
  array[]::text[],
  $m$public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text) ③ 觸發器綁定不變$m$);

-- ----- public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric)$m$, array[
    $m$'百分比模式下，抽成數值必須介於 0~100 之間'$m$, $m$'百分比模式下,抽成數值必須介於 0~100 之間'$m$
  ])),
  $m$186d47d477d7138eb85458e32c02a0b2$m$,
  $m$public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$NULL$m$],
  $m$public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric)$m$),
  array[]::text[],
  $m$public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric) ③ 觸發器綁定不變$m$);

-- ----- public.cancel_staff_leave(p_leave_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.cancel_staff_leave(p_leave_id uuid)$m$, array[
    $m$'這筆請假紀錄目前狀態不是「進行中」，無法取消(目前狀態：%)'$m$, $m$'這筆請假紀錄目前狀態不是「進行中」,無法取消(目前狀態:%)'$m$
  ])),
  $m$a5bc1c7a8aa84f15b0b2795cb719e89f$m$,
  $m$public.cancel_staff_leave(p_leave_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.cancel_staff_leave(p_leave_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.5:取消一筆請假紀錄(軟刪除,status 改 cancelled,規則 2.10 不算危險操作)。只有目前狀態是 confirmed 的紀錄能取消。要改請假的日期/假別,一律先取消原本這筆再重新登記一筆新的(規則 2.9)。$m$],
  $m$public.cancel_staff_leave(p_leave_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.cancel_staff_leave(p_leave_id uuid)$m$),
  array[]::text[],
  $m$public.cancel_staff_leave(p_leave_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone)$m$, array[
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$
  ])),
  $m$774ae843a7b3b90a343f5ae3f313b511$m$,
  $m$public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 §5.2/模組 14 規格書 3.14:清除 [p_start_time, p_end_time) 這段時間內這位服務人員這一天的單日例外設定,恢復成「沒有例外,回歸每週固定模板」的狀態。權限檢查疊加自助分支:can_manage_business_hours(商家管理員/客服)或 can_self_manage_availability(服務人員自己,僅按件計酬)。$m$],
  $m$public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone)$m$),
  array[]::text[],
  $m$public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone) ③ 觸發器綁定不變$m$);

-- ----- public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid)$m$, array[
    $m$'會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以'$m$, $m$'會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123);不填也可以'$m$,
    $m$'這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用這一筆；如果真的是不同的人，請改填另一支電話'$m$, $m$'這支電話已經有會員:%。同一間商家底下,一支電話只能有一位會員 —— 如果是同一位客戶,請直接使用這一筆;如果真的是不同的人,請改填另一支電話'$m$,
    $m$'找不到指定的推薦人，或推薦人不屬於這間商家/已被下架'$m$, $m$'找不到指定的推薦人,或推薦人不屬於這間商家/已被下架'$m$,
    $m$'找不到指定的會員等級，或不屬於這間商家/已下架'$m$, $m$'找不到指定的會員等級,或不屬於這間商家/已下架'$m$,
    $m$'產生推薦碼失敗，請重新再試一次'$m$, $m$'產生推薦碼失敗,請重新再試一次'$m$
  ])),
  $m$51b907fc57ae50a5e5a69372f0d15ead$m$,
  $m$public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 10 §3.3(SPECS-INDEX #615/#618 疊加):建立會員。權限檢查同時放行 can_manage_bookings(建單頁快速建立入口,#324 既有修正)。#618 移除電話必填檢查(電話不再是必填欄位)。#615 新增 p_tier_id(選填,指派會員等級,須屬於同商家且未下架)。推薦人驗證/referral_code 產生邏輯不變。SPECS-INDEX #931(2026-09-30 使用者裁決):同一間商家底下一支電話只能有一位 active 會員 —— 寫入前先用 private.normalize_phone 比對,撞到就 raise「這支電話已經有會員:某某某」(指名是誰,不能只說失敗);只比對 status = 'active'(已下架的同號紀錄不擋新建,使用者明確裁決)。另外把既有的 `exception when unique_violation`(原本只處理推薦碼撞號要重試)改成先用 get stacked diagnostics 讀 constraint_name 分流 —— 不分流的話電話撞號會被誤認成推薦碼撞號、重試 5 次後丟出「產生推薦碼失敗」這個完全誤導的訊息。⚠️ **CSV 匯入走的不是這條路徑,不要以為這句檢查在匯入時會生效**(2026-10-01 品管實測後修正的說明):import_members_batch 在 insert_only 模式(匯入精靈的預設)下,是先自己用 private.normalize_phone 查一次既有會員,查到就直接算 skipped_duplicate_rows、**在呼叫 create_member 之前就短路了** ⇒ 這裡的訊息從匯入那條路徑永遠走不到。匯入那條路徑自己的指名訊息是 20260930040500 補的(仍然算 skipped、不算 failed,額外寫一筆進 error_report)。本函式這句檢查真正守住的是:客服在會員管理畫面新增會員、建單頁的快速建立會員、以及任何直接打 RPC 的呼叫端。【SPECS-INDEX #827,2026-09-30 使用者裁決 Q5 = (A)】同時補上會員電話的格式檢查(private.is_valid_taiwan_phone,跟 create_booking / update_booking / 兩支匯入函式同一條規則),關掉「繞過畫面直接打 RPC 就能把 123 存成會員電話」這個後門;電話留空維持合法(#618)。🔴 格式檢查刻意排在唯一性檢查**前面** —— 髒電話正規化之後可能剛好撞到別人,先比對唯一性會給出完全誤導的訊息。正式庫 119 筆有電話的會員全部通過這條規則(不合格 0 筆,2026-09-30 唯讀核對),補檢查不會弄壞存量資料。$m$],
  $m$public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid)$m$),
  array[]::text[],
  $m$public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean)$m$, array[
    $m$'只有月薪制的服務人員可以登記請假紀錄，請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)'$m$, $m$'只有月薪制的服務人員可以登記請假紀錄,請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)'$m$,
    $m$'這位服務人員在這段期間已經有其他請假紀錄，日期區間不能重疊'$m$, $m$'這位服務人員在這段期間已經有其他請假紀錄,日期區間不能重疊'$m$,
    $m$'這段期間已經有 % 筆預約，請先確認清單後再登記請假'$m$, $m$'這段期間已經有 % 筆預約,請先確認清單後再登記請假'$m$,
    $m$'找不到這個假別，或已下架'$m$, $m$'找不到這個假別,或已下架'$m$
  ])),
  $m$7c28d62da89eb4a0a917dde65e708a04$m$,
  $m$public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.3:建立一筆請假紀錄,逐項檢查權限(team_leave)/計酬類型(規則 2.2)/日期合理性/區間重疊(規則 2.5,無覆寫例外)/既有預約衝突(規則 2.6,p_confirm_despite_conflicts=true 才能在有衝突時放行)/假別必須屬於同商家且上架中。leave_type_name_snapshot 在這裡寫死,之後查詢一律讀這個快照,不重新 join merchant_leave_types(比照模組 9 §234 的教訓)。$m$],
  $m$public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean)$m$),
  array[]::text[],
  $m$public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) ③ 觸發器綁定不變$m$);

-- ----- public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)$m$, array[
    $m$'尚未開通行事曆檢視功能，請洽商家管理員'$m$, $m$'尚未開通行事曆檢視功能,請洽商家管理員'$m$,
    $m$'查詢範圍不能超過 62 天，請分批查詢'$m$, $m$'查詢範圍不能超過 62 天,請分批查詢'$m$
  ])),
  $m$5224c85cef1af7834b681f4889f2d25f$m$,
  $m$public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.15/規則 2.4/2.5/2.6:服務人員自助查看自己排程用的唯讀彙整函式。SECURITY DEFINER,先檢查 is_own_staff_row + has_own_staff_permission(staff_calendar_view),回傳 [p_start_date, p_end_date] 這段期間內(Asia/Taipei 日曆日)自己以主要服務人員或助手身份參與、狀態不是 cancelled 的預約清單。查詢範圍上限 62 天。基本資訊原則上一律回傳,兩個例外:(1) 會員專屬欄位(is_member/member_name/member_points_balance)依 merchant_staff.show_member_info 決定,關閉時一律 null;(2) SPECS-INDEX #851(2026-09-30)內部備註 notes 在 bookings.hide_notes_from_staff = true 時一律回 null(primary 與 assistant 同待遇),客服勾了「不讓服務人員看到」的那一筆,備註文字完全不會出現在這支函式的回應裡。$m$],
  $m$public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)$m$),
  array[]::text[],
  $m$public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date) ③ 觸發器綁定不變$m$);

-- ----- public.get_my_booking_status_colors(p_staff_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_my_booking_status_colors(p_staff_id uuid)$m$, array[
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$
  ])),
  $m$2c42c7b32205a02674a5d3db0e5b39fd$m$,
  $m$public.get_my_booking_status_colors(p_staff_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_my_booking_status_colors(p_staff_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$SPECS-INDEX #860(2026-09-30):服務人員自助查詢自己所屬商家的「訂單狀態顏色設定」(待確認/已確認/已完成/已取消四個色碼),讓服務人員端行事曆的預約色塊跟商家端 CalendarPage 完全一致。只檢查 private.is_own_staff_row(傳別人的 staff_id 一律 42501),merchant_id 由 private.staff_merchant_id 在函式內部解出來,呼叫端無法指定 ⇒ 結構上不可能讀到別家商家的顏色。回傳 {欄位名: 色碼} 的 jsonb,查無資料時回 {},由前端 fallback 成 DEFAULT_BOOKING_STATUS_COLORS。做法刻意逐字比照姊妹表的既有先例 public.get_my_calendar_state_styles(20260923020100),而不是放寬 merchant_booking_status_colors_select 這條表層政策——表層政策給的是整列、且未來新增欄位會自動外流,這裡只給挑好的 4 個色碼。本 migration 完全沒有新增/修改/刪除任何 RLS 政策。$m$],
  $m$public.get_my_booking_status_colors(p_staff_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_my_booking_status_colors(p_staff_id uuid)$m$),
  array[]::text[],
  $m$public.get_my_booking_status_colors(p_staff_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.get_my_calendar_state_styles(p_staff_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_my_calendar_state_styles(p_staff_id uuid)$m$, array[
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$
  ])),
  $m$7394c1584de33df93d893313d68e2bf0$m$,
  $m$public.get_my_calendar_state_styles(p_staff_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_my_calendar_state_styles(p_staff_id uuid)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$SPECS-INDEX #644:服務人員自助查詢自己所屬商家的行事曆排程狀態顏色設定,只檢查 is_own_staff_row。回傳 {state_type: color} 的 jsonb 物件,查無資料的 key 由前端 fallback 成 DEFAULT_CALENDAR_STATE_STYLES。規則 2.4:傳入別人的 staff_id 一律被擋下。$m$],
  $m$public.get_my_calendar_state_styles(p_staff_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_my_calendar_state_styles(p_staff_id uuid)$m$),
  array[]::text[],
  $m$public.get_my_calendar_state_styles(p_staff_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.get_my_day_business_hours(p_staff_id uuid, p_date date) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.get_my_day_business_hours(p_staff_id uuid, p_date date)$m$, array[
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$
  ])),
  $m$de074329ca23b6c16964cbdc35e7b1fc$m$,
  $m$public.get_my_day_business_hours(p_staff_id uuid, p_date date) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.get_my_day_business_hours(p_staff_id uuid, p_date date)$m$),
  array[$m$true$m$, $m$s$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 14(服務人員端)v2 §10.2.1:服務人員自助查詢自己所屬商家某一天的營業時間,只檢查 is_own_staff_row(不額外檢查 section_key,營業時間本身不敏感)。回傳形狀比照 get_merchant_day_schedule 的 business_hours 物件({has_setting, is_closed, open_time, close_time}),供時間軸格線(10.2.3)/時段排休分頁(10.3.3)共用。規則 2.4:傳入別人的 staff_id 一律被擋下。$m$],
  $m$public.get_my_day_business_hours(p_staff_id uuid, p_date date) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.get_my_day_business_hours(p_staff_id uuid, p_date date)$m$),
  array[]::text[],
  $m$public.get_my_day_business_hours(p_staff_id uuid, p_date date) ③ 觸發器綁定不變$m$);

-- ----- public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)$m$, array[
    $m$'「客戶電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$, $m$'「客戶電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$
  ])),
  $m$02d52ca220fda3b7be562b13432447b3$m$,
  $m$public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 12 §3.4(核心，規則 2.3/2.4,2026-09-24 使用者裁決疊加):批次匯入歷史訂單。完全不呼叫 create_booking/update_booking/complete_booking，不做排程衝突驗證，不觸發抽成/紅利計算。只有商家管理員可以呼叫(規則 2.1)。【2026-09-24 任務 4】使用者裁決「並不是每一筆服務都固定會有開發票(稅金)…如果是舊訂單匯入,在稅金欄位沒有填寫金額就當作總營收(未稅)去計算」:未稅小計 subtotal_amount_snapshot 的決定方式改成三分支——CSV 有給小計就尊重 CSV;沒給小計但稅金 > 0 就依訂單管理規格書 §2.3 的四則順序反推 subtotal = final_amount + discount − tax(原本直接把含稅的 final_amount 當小計,等於把稅金算進未稅營收);沒給小計且稅金沒填或為 0 則維持 final_amount 直接當未稅小計。反推出負數(稅金大於訂單金額,CSV 本身矛盾)時該列拋白話錯誤訊息進 error_report,不寫入負數小計。final_amount 仍然是唯一權威的實收金額,一行都沒被動到。【2026-09-24 任務 1 根因修正】INSERT 補上 completed_at = start_at(status=completed 時;cancelled 維持 null):這支函式是直接 INSERT status=completed,原本完全沒寫 completed_at,是正式環境那 14 筆「已完成但 completed_at 為 null」的唯一來源;帳務報表改用完成時間分月之後,不補這一欄就會每次匯入都製造報表分錯月份的資料。用 start_at 而不是 now(),因為歷史訂單的完成發生在服務當天。【SPECS-INDEX #824,2026-09-28】客戶電話在「缺少必填欄位」檢查之後套用 #822 的格式規則(private.is_valid_taiwan_phone,跟 create_booking 同一條),不合格的那一列算 failed 並寫進 error_report(白話中文,含這一列填的值與正確格式範例),其他列照常匯入;這支函式不走 create_booking,所以 #822 加在那裡的守門原本管不到這裡。member_phone(選填的會員連結查詢鍵)刻意不驗。$m$],
  $m$public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)$m$),
  array[]::text[],
  $m$public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb) ③ 觸發器綁定不變$m$);

-- ----- public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)$m$, array[
    $m$'「電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$, $m$'「電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)'$m$,
    $m$'這支電話已經有會員：%s —— 這一列已略過，沒有新建，也沒有修改這位既有會員的任何資料。同一間商家底下，一支電話只能有一位會員：如果就是同一位客戶，請把這一列從 CSV 裡移除；如果你本來就是想更新這位既有會員的資料，請改用「電話重複時更新既有會員資料」這個寫入模式重新匯入；如果真的是不同的人，請改填另一支電話'$m$, $m$'這支電話已經有會員:%s —— 這一列已略過,沒有新建,也沒有修改這位既有會員的任何資料。同一間商家底下,一支電話只能有一位會員:如果就是同一位客戶,請把這一列從 CSV 裡移除;如果你本來就是想更新這位既有會員的資料,請改用「電話重複時更新既有會員資料」這個寫入模式重新匯入;如果真的是不同的人,請改填另一支電話'$m$
  ])),
  $m$70607cbe6ba2deeea6bef7e665aa9c32$m$,
  $m$public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 12 §3.1(核心):批次匯入會員，逐列呼叫既有的 create_member/update_member/adjust_member_points(規則 2.2/2.5/2.6，完全不直接寫入 members/member_point_transactions)，單一列失敗不影響其他列，只有商家管理員可以呼叫(規則 2.1)。2026-09-24 修正(B3):update_member 自從 #615 改成 7 個參數後,這裡仍然只傳 6 個,導致 upsert_by_phone 模式下每一次匯入都把電話對上的既有會員的會員等級靜默清成未分級;現在改成沿用該會員更新前的 tier_id。SPECS-INDEX #824(2026-09-28):「電話」欄位有填時套用 #822 的格式規則(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機),不合格的那一列算 failed 並寫進 error_report(白話中文,含這一列填的值與正確格式範例),其他列照常匯入;留空維持合法;檢查在「用電話找既有會員」之前,不合格的電話不會被當成重複略過。SPECS-INDEX #931 收尾(2026-10-01,品管實測打回):insert_only 模式(匯入精靈的預設模式)遇到這支電話已經有 active 會員時,**除了**照舊算 skipped_duplicate_rows,**額外**往 error_report 寫一筆指名訊息「這支電話已經有會員:某某某 —— 這一列已略過,沒有新建也沒有修改這位既有會員的任何資料…」,讓商家在結果頁看得到是哪一列、跟哪一位撞。🔴 那一列**仍然算 skipped、不算 failed**(三個計數的語意是既有的,畫面與既有 pgTAP 斷言都吃它);使用者要的是「看得見訊息」而不是「改變計數」。🔴 也要知道:這個分支在呼叫 create_member **之前**就短路了,所以 create_member 裡 #931 那句同樣的白話訊息從匯入這條路徑走不到 —— 匯入的訊息是這裡自己寫的,不是從 create_member 繼承來的。$m$],
  $m$public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)$m$),
  array[]::text[],
  $m$public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb) ③ 觸發器綁定不變$m$);

-- ----- public.reactivate_member(p_member_id uuid) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.reactivate_member(p_member_id uuid)$m$, array[
    $m$'不能重新上架：這位會員的電話現在已經有另一位使用中的會員：%。同一間商家底下，一支電話只能有一位會員 —— 請先把其中一邊的電話改掉(或把那一位下架)，再重新上架這一位'$m$, $m$'不能重新上架:這位會員的電話現在已經有另一位使用中的會員:%。同一間商家底下,一支電話只能有一位會員 —— 請先把其中一邊的電話改掉(或把那一位下架),再重新上架這一位'$m$
  ])),
  $m$7376bd66cbc6566aaf60d0ffddc0a1a5$m$,
  $m$public.reactivate_member(p_member_id uuid) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.reactivate_member(p_member_id uuid)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 10 §3.5:重新上架會員(status=active)。【SPECS-INDEX #931,2026-09-30】重新上架前先檢查:同商家**其他** active 會員裡有沒有人的電話跟這一位相同(m.id <> p_member_id 不可省),有就 raise「這支電話現在已經有另一位使用中的會員:某某某」並說明怎麼處理。🔴 這一段不是「順手加的防呆」,而是本批加了 members_merchant_active_phone_uniq 之後**必須補**的白話訊息 —— 不補的話,「下架 A → 別人用同一支電話建了 B → 重新上架 A」這條既有路徑會直接吐 Postgres 原生的英文 duplicate key 錯誤給客服看。$m$],
  $m$public.reactivate_member(p_member_id uuid) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.reactivate_member(p_member_id uuid)$m$),
  array[]::text[],
  $m$public.reactivate_member(p_member_id uuid) ③ 觸發器綁定不變$m$);

-- ----- public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text)$m$, array[
    $m$'不合法的狀態：%'$m$, $m$'不合法的狀態: %'$m$
  ])),
  $m$47874cae260caf3ff162cdaecae0cfb7$m$,
  $m$public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.6:只給 service_role 呼叫,由 Edge Function invite-merchant-agent 寫入邀請結果。$m$],
  $m$public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text)$m$),
  array[]::text[],
  $m$public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text) ③ 觸發器綁定不變$m$);

-- ----- public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text)$m$, array[
    $m$'不合法的登入狀態：%'$m$, $m$'不合法的登入狀態: %'$m$,
    $m$'這個 Email 目前已經是本店另一位在職服務人員的登入帳號，不能重複綁定。如果是同一個人，請先確認是否選錯了服務人員，或聯絡系統管理員協助處理。'$m$, $m$'這個 Email 目前已經是本店另一位在職服務人員的登入帳號,不能重複綁定。如果是同一個人,請先確認是否選錯了服務人員,或聯絡系統管理員協助處理。'$m$,
    $m$'這個信箱可能曾經被移除的服務人員使用過，系統應該要能自動處理，如果看到這個訊息代表發生了非預期的資料衝突，請聯絡系統管理員。'$m$, $m$'這個信箱可能曾經被移除的服務人員使用過,系統應該要能自動處理,如果看到這個訊息代表發生了非預期的資料衝突,請聯絡系統管理員。'$m$,
    $m$'找不到指定的服務人員紀錄：%'$m$, $m$'找不到指定的服務人員紀錄: %'$m$
  ])),
  $m$2c1a7a18a78272d1ab9dc15c0020f153$m$,
  $m$public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.11,2026-09-21 修正(「服務人員管理優化與硬刪除」§1.2.2):只給 service_role 呼叫,由 Edge Function invite-merchant-staff 寫入邀請結果,並緊接著呼叫 seed_default_staff_permissions 種入預設權限(判斷 1)。新增兩層防呆:①同一帳號已是本店另一位在職服務人員的登入時,回傳清楚的中文說明;②把實際的 UPDATE 包進 exception 區塊,萬一發生非預期的 unique_violation 也不會讓使用者看到原始資料庫錯誤。$m$],
  $m$public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text)$m$),
  array[]::text[],
  $m$public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text) ③ 觸發器綁定不變$m$);

-- ----- public.redeem_member_points(p_member_id uuid, p_points integer, p_note text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.redeem_member_points(p_member_id uuid, p_points integer, p_note text)$m$, array[
    $m$'這位會員目前只有 % 點，無法兌換 % 點'$m$, $m$'這位會員目前只有 % 點,無法兌換 % 點'$m$
  ])),
  $m$78d77a28b4761b8b80b2d6d917520345$m$,
  $m$public.redeem_member_points(p_member_id uuid, p_points integer, p_note text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.redeem_member_points(p_member_id uuid, p_points integer, p_note text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 10 §3.9(規則 2.7):登記兌換/使用點數,只能消耗既有餘額、不能讓餘額變負,p_note 必填。跟本模組其餘操作一樣用一般 merchant_agent_permissions(members)授權(規則 2.6 的對照組:只有 adjust_member_points 特別鎖死管理員)。$m$],
  $m$public.redeem_member_points(p_member_id uuid, p_points integer, p_note text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.redeem_member_points(p_member_id uuid, p_points integer, p_note text)$m$),
  array[]::text[],
  $m$public.redeem_member_points(p_member_id uuid, p_points integer, p_note text) ③ 觸發器綁定不變$m$);

-- ----- public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean)$m$, array[
    $m$'找不到這位服務人員，或這位服務人員已被移除'$m$, $m$'找不到這位服務人員,或這位服務人員已被移除'$m$
  ])),
  $m$ed26190fca9e17b0cc98844920fcbfd7$m$,
  $m$public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 6/14:設定服務人員某一天某段時間的可預約狀態(單日例外),半小時對齊。模組 14 v2 §10.3.1 修正:迴圈索引改用當日分鐘數整數運算,修正 p_end_time=24:00:00(整天排休邊界值)導致的無限迴圈 bug。權限:商家管理員/客服(can_manage_business_hours)或本人自助(can_self_manage_availability,僅按件計酬且已開通權限)。回傳這段時間現有的既有預約衝突筆數(不自動取消)。$m$],
  $m$public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean)$m$),
  array[]::text[],
  $m$public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean) ③ 觸發器綁定不變$m$);

-- ----- public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[]) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])$m$, array[
    $m$'整批搬遷已取消：要搬過去的會員「%」(電話 %)，跟目標商家現有的會員「%」是同一支電話。同一間商家底下，一支電話只能有一位會員 —— 請先處理掉其中一邊(改電話，或把其中一位下架)，再重新搬遷'$m$, $m$'整批搬遷已取消:要搬過去的會員「%」(電話 %),跟目標商家現有的會員「%」是同一支電話。同一間商家底下,一支電話只能有一位會員 —— 請先處理掉其中一邊(改電話,或把其中一位下架),再重新搬遷'$m$
  ])),
  $m$8515cd87ff2e36e03103e23222cd503c$m$,
  $m$public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[]) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 12 §3.6(核心，規則 2.10/2.11):把選定的會員(含紅利點數歷史)整批搬到目標商家。呼叫者必須同時是來源+目標商家的管理員，且兩間商家必須同一集團(規則 2.10)。搬遷同一交易內順帶把舊商家引用這批會員的訂單 member_id 設為 null，避免跨商家資料外洩(規則 2.11)。【SPECS-INDEX #931,2026-09-30】搬遷前(任何寫入之前)多一道檢查:要搬過去的 active 會員裡,有沒有人的電話跟目標商家現有的 active 會員相同(排除這次一起搬走的那些人),有就整批拒絕,而且訊息要指名「是哪一筆卡住、跟目標商家的誰撞、電話是多少」,不能只說整批失敗。🔴 這一段是本批加了 members_merchant_active_phone_uniq 之後**必須補**的:不補的話這支函式會直接吐 Postgres 原生的英文 duplicate key 錯誤,而且是整批失敗,客服無法判斷要改哪一位。規格書原文寫「這支不需要改」是在還沒有唯一索引的前提下寫的,已過時。📌 同一批裡面不可能有兩位同號的 active 會員(來源商家本身就受同一個索引約束),已下架的成員搬過去仍然是 removed、不進索引。$m$],
  $m$public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[]) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])$m$),
  array[]::text[],
  $m$public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[]) ③ 觸發器綁定不變$m$);

-- ----- public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text)$m$, array[
    $m$'會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以'$m$, $m$'會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123);不填也可以'$m$,
    $m$'這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用那一筆；如果真的是不同的人，請改填另一支電話'$m$, $m$'這支電話已經有會員:%。同一間商家底下,一支電話只能有一位會員 —— 如果是同一位客戶,請直接使用那一筆;如果真的是不同的人,請改填另一支電話'$m$,
    $m$'找不到指定的會員等級，或不屬於這間商家/已下架'$m$, $m$'找不到指定的會員等級,或不屬於這間商家/已下架'$m$
  ])),
  $m$d0e3666bedd28a93e8e273e08b798663$m$,
  $m$public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$模組 10 §3.4(SPECS-INDEX #615/#618 疊加):編輯會員基本資料。#618 移除電話必填檢查。#615 新增 p_tier_id(選填,重新指派會員等級,傳 null 代表清空成未分級)。不接受修改 referred_by_member_id(既有規則不變)。權限維持只檢查 can_manage_members。SPECS-INDEX #931(2026-09-30 使用者裁決):改電話時先比對同商家**其他** active 會員(m.id <> p_member_id 這個排除條件缺一不可,否則只改姓名錯字也會被自己那一列擋下),撞到就 raise「這支電話已經有會員:某某某」。已下架的同號紀錄不擋。⚠️ 關於 CSV 匯入(2026-10-01 品管實測後修正的說明):這支函式確實是 import_members_batch 在 upsert_by_phone 模式下的更新路徑,所以 #827 的電話格式檢查在那條路徑上是真的會生效;但 #931 的唯一性檢查在那條路徑上**實務上不會觸發** —— 匯入是先用電話找到那一位既有會員、再拿同一支電話去更新他本人,而唯一性檢查本來就排除自己(m.id <> p_member_id)。至於 insert_only 模式下的重複電話,完全不會走到這支函式(它在呼叫 create_member 之前就被短路成 skipped 了),那條路徑的指名訊息是 20260930040500 補的。【SPECS-INDEX #827,2026-09-30 使用者裁決 Q5 = (A)】同時補上會員電話的格式檢查(排在唯一性檢查前面,理由同 create_member)。既有的髒電話依使用者裁決不主動清,但客服一進來編輯就會被要求先改正確(跟 update_booking 對舊訂單的既有處理方式一致);正式庫目前不合格 0 筆,實際上沒有人會遇到。【客戶端第 4-A 批 C4-A04】新增第 8 個參數 p_address(default null):null(不帶)= 地址不變(匯入 import_members_batch、復原 rollback_bulk_operation 用 7 個參數呼叫,不會清掉地址);空字串 / 只有空白 = 清掉;超過 200 字 ⇒ 22023 invalid_address。$m$],
  $m$public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text)$m$),
  array[]::text[],
  $m$public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid, p_address text) ③ 觸發器綁定不變$m$);

-- ----- public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text)$m$, array[
    $m$'沒有權限編輯這位客服的資料，只有商家管理員或這位客服本人可以編輯'$m$, $m$'沒有權限編輯這位客服的資料,只有商家管理員或這位客服本人可以編輯'$m$,
    $m$'手機號碼格式不正確，請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)'$m$, $m$'手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)'$m$
  ])),
  $m$e941adeb472834e4198828cef69c1f65$m$,
  $m$public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$客服管理列表頁的「編輯」(2026-09-24 使用者裁決「客服可自行編輯或管理員可協助編輯」)。merchant_agents 只有 SELECT 的 RLS 政策、完全沒有 INSERT/UPDATE/DELETE 政策(刻意鎖成唯讀,所有寫入走 SECURITY DEFINER 函式),所以前端必須透過這支函式才改得動。授權:private.is_merchant_admin(該客服的 merchant_id) 或這筆紀錄本人(這一列自己的 user_id = auth.uid();刻意不用 is_merchant_agent,否則客服 A 能改客服 B)。只開放 name / nickname / phone / job_title 四個欄位,函式簽章本身不暴露其他欄位的參數,所以 status / user_id / invited_email / line_user_id / line_bound / pending_admin_login_email* 這些身分綁定與登入帳號欄位從介面上就不可能被改到。四個欄位在同一個 UPDATE 語句裡寫完,天然是原子交易。phone 先自行驗證 NOT NULL 與 ^09\d{8}$ 並給白話中文訊息;name 驗證非空白;nickname/job_title 空字串正規化成 NULL。⚠️【2026-09-24 拿掉 p_contact_email】使用者裁決三種「人」的角色只有一個 Email(登入 Email),contact_email 欄位已由 20260924040800 移除;public.merchants.contact_email(店家對外給消費者看的信箱)不受影響,一律保留。⚠️⚠️【2026-09-24 主腦巡檢補上三值邏輯防禦 —— 這是本批自己引入的漏洞,不是既有的】040500/040800 建立的版本把授權寫成 `if not (is_merchant_admin(...) or v_user_id = auth.uid())`,而 merchant_agents.user_id 是 nullable(「已邀請未註冊」的客服就是 NULL)。NULL 時該比較是 NULL、`false or NULL` = NULL、`not NULL` = NULL、`if NULL then` 不成立 ⇒ raise 不會執行、權限檢查被靜默跳過,任何已登入者只要知道那筆 merchant_agents.id 就能竄改對方的姓名/暱稱/電話/職位。已改成 `or (v_user_id is not null and auth.uid() is not null and v_user_id = auth.uid())`,跟 unbind_line_account 三個分支寫法完全一致。發現方式:修完 unbind_line_account 之後對正式環境做全庫掃查(剝掉 -- 註解後再找裸寫的 `or <變數> = auth.uid()`),掃出這一支。修補當下正式環境 user_id 為 NULL 的客服筆數 = 0,所以實際上沒有人被攻擊過。$m$],
  $m$public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text)$m$),
  array[]::text[],
  $m$public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text) ③ 觸發器綁定不變$m$);

-- ----- public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text)$m$, array[
    $m$'手機號碼格式不正確，請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)，或留空不填'$m$, $m$'手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678),或留空不填'$m$,
    $m$'找不到你在這間商家的管理員紀錄，無法更新'$m$, $m$'找不到你在這間商家的管理員紀錄,無法更新'$m$
  ])),
  $m$6f7f0e4d0d2445f0d06a65bf8ab40c0e$m$,
  $m$public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書「首頁外殼與主題色優化」1.3 + 2026-09-24 使用者裁決疊加:管理員自助編輯自己的姓名/職位/電話。只檢查呼叫者是不是這筆 merchant_admins 紀錄本人(auth.uid() = user_id),是所有權判斷,不是 private.is_merchant_admin 那種權限判斷——所以一位管理員改不到同商家其他管理員的資料。【2026-09-24】新增 p_phone 參數(使用者裁決:「我認為需要…以我這個廠商視角」,平台方需要能掌握每一位商家管理員的聯絡方式)。因為追加參數等於新的重載,這支 migration 在建立前先 drop 了舊的 3 參數版本,也 drop 了開發過程中曾存在的 5 參數草稿版本(那個版本有 p_contact_email),避免留下孤兒重載讓 PostgREST 有時候解析到寫不到 phone、或寫得到已不存在欄位的舊版(這是 update_merchant_agent 已經踩過的坑)。phone 在函式內先驗證 ^09\d{8}$ 並給白話中文訊息,空字串正規化成 NULL(這個欄位是選填,清空是合法操作)。⚠️ 刻意**沒有** p_contact_email:2026-09-24 使用者裁決「登入和聯絡信箱應該要是一致的」「客服和服務人員應該也是一樣只需要一個 Email 即可」,三種「人」的角色都只有登入 Email 一個信箱,merchant_admins 從來沒有過 contact_email 欄位,merchant_staff / merchant_agents 的則由 20260924040800 移除。回傳型別維持 void,沒有順便改動回傳契約。$m$],
  $m$public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text)$m$),
  array[]::text[],
  $m$public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text) ③ 觸發器綁定不變$m$);

-- ----- public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text)$m$, array[
    $m$'尚未開通個人資料編輯功能，請洽商家管理員'$m$, $m$'尚未開通個人資料編輯功能,請洽商家管理員'$m$
  ])),
  $m$f61661e5fab53790e42fb24a259ccecf$m$,
  $m$public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}$m$, $m$對應規格書 3.16/規則 2.7/2.8:服務人員自助編輯個人資料,只接受並只更新 name/nickname/phone/avatar_url/intro 五個欄位,函式簽章本身不暴露其他任何欄位的參數。需要 is_own_staff_row(本人)且已開通 staff_profile_edit 權限。【2026-09-24 使用者裁決】原本還有第六個欄位 p_contact_email(寫入 merchant_staff.contact_email),已連同欄位本身一起移除——使用者原話:「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」三種「人」的角色(merchant_admins / merchant_agents / merchant_staff)從此只有一個 Email,就是登入 Email(auth.users.email)。舊的 7 參數簽章已在 20260924040800 裡 drop,避免留下孤兒重載被 PostgREST 依參數名解析到(那會寫入一個已經不存在的欄位)。⚠️ 這個決定不適用於 public.merchants.contact_email —— 那是店家對外給消費者看的信箱,店家本身沒有登入帳號,不存在跟登入信箱重複的問題,一律保留。$m$],
  $m$public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text)$m$),
  array[]::text[],
  $m$public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text) ③ 觸發器綁定不變$m$);

-- ----- public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb) -----
select is(
  md5(pg_temp.req987_swap_back($m$public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)$m$, array[
    $m$'公式清單裡有重複的公式，請重新整理後再儲存'$m$, $m$'公式清單裡有重複的公式,請重新整理後再儲存'$m$,
    $m$'公式「%」已經不存在，請重新整理後再儲存'$m$, $m$'公式「%」已經不存在,請重新整理後再儲存'$m$,
    $m$'「%」已經被公式「%」設定過了，同一個服務項目只能有一條公式'$m$, $m$'「%」已經被公式「%」設定過了,同一個服務項目只能有一條公式'$m$
  ])),
  $m$72b25242dc98820b4f4a4b4650eb41ba$m$,
  $m$public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb) ① 新訊息換回舊訊息後指紋 = 改前$m$);
select is(
  pg_temp.req987_attrs($m$public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)$m$),
  array[$m$true$m$, $m$v$m$, $m${search_path=public}$m$, $m${postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}$m$, $m$紅利系統重構 §3.9(#838):紅利點數管理頁「紅利計算」分頁的公式批次儲存。p_formulas = 這間商家完整的公式清單(每個元素 {id?, name, enabled, service_item_id|null, min_unit_price, points_per_unit, sort_order}):payload 沒有的既有列刪除、有 id 的更新(保留 created_at;值沒變時 updated_at 也不變)、沒 id 的新增。權限 private.can_manage_member_points(§2.8)。先驗證整份清單(名稱 1~50 字、點數 >= 0 整數、門檻 >= 0、服務項目必須屬於同商家(已下架也可以,保留舊公式)、id 必須是這間商家既有的公式、payload 內不可重複的服務項目 / 兩條全部服務項目 ⇒ 白話錯誤含項目名與衝突公式名),全部通過才寫入;任何一條不通過整份不寫。同一商家的儲存以 advisory lock 排隊。回傳儲存後的完整清單。$m$],
  $m$public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb) ② security definer / volatility / search_path / ACL / comment 不變$m$);
select is(
  pg_temp.req987_triggers($m$public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)$m$),
  array[]::text[],
  $m$public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb) ③ 觸發器綁定不變$m$);

select * from finish();
rollback;
