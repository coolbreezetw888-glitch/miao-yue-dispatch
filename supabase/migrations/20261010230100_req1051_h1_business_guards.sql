-- SPECS-INDEX #1051 全面體檢修正(H1-07、H1-10、H1-11、H1-13):商業規則加固。
--
-- H1-07 public.hard_delete_merchant_staff:有上工紀錄、歷史工資(wage_amount > 0)、歷史獎金方案
--       (bonus_plan_id is not null)、或有獎金指派紀錄 ⇒ 不准真正刪除(與既有月薪歷史同樣處理)。
-- H1-10 private.validate_booking_selection:單價 > 1,000,000、逐項小計 > 10,000,000 ⇒ 白話訊息;
--       private.calculate_booking_amount:自訂總金額 > 10,000,000 ⇒ 白話訊息。
--       客人端送單不經過 validate_booking_selection,且固定不開自訂總金額 ⇒ 不受影響。
-- H1-11 merchants.theme_custom_color 只接受 #RGB/#RRGGBB(或 null);logo_url 只接受本專案 Storage
--       merchant-logos 公開網址前綴(正式專案網址;本機開發的 127.0.0.1/localhost)或 null。
--       套用前已在正式庫確認現有資料全部符合。
-- H1-13 private.bonus_formula_compile:組合字元(U+0300~U+036F)錯誤訊息只寫碼位。
--
-- 改既有函式一律以正式庫現行本體(pg_get_functiondef)為底,只改上述區塊;不改簽章,既有 ACL 不變。

CREATE OR REPLACE FUNCTION public.hard_delete_merchant_staff(p_staff_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_name text;
  v_booking_count int;
  v_assistant_count int;
  v_leave_count int;
  v_commission_count int;
  v_paid_salary_history_count int;
  v_wage_history_count int;
begin
  select merchant_id, status, name into v_merchant_id, v_status, v_name
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到指定的服務人員紀錄' using errcode = 'P0001';
  end if;

  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'removed' then
    raise exception '只能對已經移除的服務人員執行真正刪除，請先移除這位服務人員(軟刪除)，確認不再需要之後再進行真正刪除。' using errcode = 'P0001';
  end if;

  select count(*) into v_booking_count from public.bookings where staff_id = p_staff_id;
  select count(*) into v_assistant_count from public.booking_assistants where staff_id = p_staff_id;
  select count(*) into v_leave_count from public.staff_leave_records where staff_id = p_staff_id;
  select count(*) into v_commission_count from public.booking_commission_records where staff_id = p_staff_id;

  if (v_booking_count + v_assistant_count + v_leave_count + v_commission_count) > 0 then
    raise exception '這位服務人員「%」有歷史紀錄牽連(訂單 %筆、助手身份訂單 %筆、請假紀錄 %筆、抽成紀錄 %筆)，為了保留歷史帳務與訂單資料，無法真正刪除，只能維持「已移除」狀態。',
      v_name, v_booking_count, v_assistant_count, v_leave_count, v_commission_count
      using errcode = 'P0001';
  end if;

  -- 模組 8 §11.4(核心,第五項檢查):曾經領過非 0 月薪的人,即使四項既有檢查都是 0(從未接過
  -- 訂單/請過假),也不能真正刪除——staff_payroll_status_history 是 on delete cascade,真的刪除
  -- 會連帶砍掉過去月份帳務報表依賴的歷史金額紀錄。
  select count(*) into v_paid_salary_history_count
  from public.staff_payroll_status_history
  where staff_id = p_staff_id and monthly_base_salary > 0;

  if v_paid_salary_history_count > 0 then
    raise exception '這位服務人員過去有實際發生過的月薪紀錄(曾經是有薪資的月薪制員工)，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。'
      using errcode = 'P0001';
  end if;

  -- #1051(H1-07):日薪/時薪的上工紀錄、歷史工資、獎金方案也屬於帳務歷史,同樣不准真正刪除
  -- (這幾張表都是 on delete cascade,真的刪除會讓過去月份的工資/獎金支出一起消失)。
  select
    (select count(*) from public.staff_work_day_records where staff_id = p_staff_id)
    + (select count(*) from public.staff_payroll_status_history
       where staff_id = p_staff_id and (wage_amount > 0 or bonus_plan_id is not null))
    + (select count(*) from public.staff_bonus_assignments where staff_id = p_staff_id)
  into v_wage_history_count;

  if v_wage_history_count > 0 then
    raise exception '這位服務人員過去有上工、工資或獎金紀錄，為了保留歷史帳務報表的正確性，無法真正刪除，只能維持「已移除」狀態。'
      using errcode = 'P0001';
  end if;

  -- 全部通過(四項既有筆數 + 第五項薪資歷史檢查皆為 0)才真的執行 DELETE——讓既有的
  -- on delete cascade 外鍵自動清掉 merchant_staff_service_items/staff_availability_windows/
  -- staff_availability_overrides/merchant_staff_permissions/staff_service_commission_rates/
  -- staff_salary_settings/staff_payroll_status_history 七張純設定/歷史表的關聯資料,這裡不需要
  -- 手動一張一張 delete。完全不動 auth.users(merchant_staff.user_id 是
  -- references auth.users(id) on delete set null,方向是 auth.users 被刪才影響 merchant_staff,
  -- 不是反過來——硬刪除這一列本來就不會、也不應該去動 auth.users)。
  delete from public.merchant_staff where id = p_staff_id;
end;
$function$
;

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
    -- #1051(H1-10):後台單價白話上限(與料錢單筆上限一致)。
    if v_unit_price > 1000000 then
      raise exception '服務項目單價太大，請確認是否輸入錯誤。';
    end if;

    items_subtotal := items_subtotal + (v_unit_price * v_quantity);
  end loop;

  -- #1051(H1-10):逐項小計白話上限(避免超過金額欄位上限時出現系統原始錯誤)。
  if items_subtotal > 10000000 then
    raise exception '訂單金額太大，請確認是否輸入錯誤。';
  end if;

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
$function$
;

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
    -- #1051(H1-10):自訂總金額白話上限(客人端固定不開自訂總金額,不受影響)。
    if p_custom_total_amount > 10000000 then
      raise exception '自訂總金額太大，請確認是否輸入錯誤。';
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
$function$
;

CREATE OR REPLACE FUNCTION private.bonus_formula_compile(p_merchant_id uuid, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c_max_len constant integer := 300;
  c_max_tokens constant integer := 150;
  c_max_item_calls constant integer := 10;
  -- 看不見的字元(控制字元、零寬字元、方向控制 U+202E 等、各種特殊空白):錯誤訊息不放原字元,改寫碼位。
  c_invisible constant text :=
    '^[[:cntrl:]\u00a0\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3164\ufeff\uffa0\ufff0-\ufffb]$';
  v_len integer;
  v_i integer := 1;
  v_raw text;
  v_c text;
  v_n text;
  v_start integer;
  v_buf text;
  v_int text;
  v_dec text;
  v_upper text;
  v_tokens jsonb[] := array[]::jsonb[];
  v_norm text := '';
  v_item_calls integer := 0;
  v_prev jsonb;
  v_parsed jsonb;
  v_ast jsonb;
  v_msg text;
  v_hint text;
begin
  if p_text is null
     or btrim(translate(p_text, '　' || chr(9) || chr(10) || chr(13), '    ')) = '' then
    return jsonb_build_object('ok', false, 'message', '請輸入公式。', 'position', null);
  end if;

  v_len := char_length(p_text);
  if v_len > c_max_len then
    return jsonb_build_object(
      'ok', false,
      'message', '公式最多 ' || c_max_len || ' 個字，目前 ' || v_len || ' 個字。',
      'position', null);
  end if;

  begin
    while v_i <= v_len loop
      v_raw := substr(p_text, v_i, 1);
      v_c := private.bonus_formula_norm_char(v_raw);
      v_n := private.bonus_formula_norm_char(substr(p_text, v_i + 1, 1));

      if v_c = ' ' then
        v_norm := v_norm || ' ';
        v_i := v_i + 1;
        continue;
      end if;

      -- 數字:整數最多 9 位、小數最多 4 位;不能加千分位逗號。
      if v_c ~ '^[0-9]$' then
        v_start := v_i;
        v_int := '';
        v_dec := null;
        while v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) ~ '^[0-9]$' loop
          v_int := v_int || private.bonus_formula_norm_char(substr(p_text, v_i, 1));
          v_i := v_i + 1;
        end loop;
        if v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) = '.' then
          v_dec := '';
          v_i := v_i + 1;
          while v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) ~ '^[0-9]$' loop
            v_dec := v_dec || private.bonus_formula_norm_char(substr(p_text, v_i, 1));
            v_i := v_i + 1;
          end loop;
          if v_dec = '' then
            perform private.bonus_formula_fail('小數點後面要接數字。', v_i - 1);
          end if;
        end if;
        v_int := coalesce(nullif(ltrim(v_int, '0'), ''), '0');
        if char_length(v_int) > 9 then
          perform private.bonus_formula_fail('數字太大了：整數最多 9 位數。', v_start);
        end if;
        if v_dec is not null and char_length(v_dec) > 4 then
          perform private.bonus_formula_fail('小數最多 4 位。', v_start);
        end if;
        if v_dec is null
           and v_i <= v_len
           and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) = ','
           and private.bonus_formula_norm_char(substr(p_text, v_i + 1, 1)) ~ '^[0-9]$'
           and private.bonus_formula_norm_char(substr(p_text, v_i + 2, 1)) ~ '^[0-9]$'
           and private.bonus_formula_norm_char(substr(p_text, v_i + 3, 1)) ~ '^[0-9]$'
           and coalesce(private.bonus_formula_norm_char(substr(p_text, v_i + 4, 1)), '') !~ '^[0-9]$' then
          perform private.bonus_formula_fail(
            '數字不能加千分位逗號，例如 100,000 請寫成 100000（如果是函式的兩個參數，請在逗號後面加一個空白）。',
            v_i);
        end if;
        v_buf := v_int || coalesce('.' || v_dec, '');
        v_tokens := v_tokens || jsonb_build_object('k', 'num', 'v', v_buf, 'p', v_start);
        v_norm := v_norm || v_buf;
        continue;
      end if;

      -- 名稱:中文或英文字母連續一段,只接受白名單。
      if v_c ~ '^[A-Za-z一-鿿]$' then
        v_start := v_i;
        v_buf := '';
        while v_i <= v_len and private.bonus_formula_norm_char(substr(p_text, v_i, 1)) ~ '^[A-Za-z一-鿿]$' loop
          v_buf := v_buf || private.bonus_formula_norm_char(substr(p_text, v_i, 1));
          v_i := v_i + 1;
        end loop;
        v_upper := upper(v_buf);
        if v_upper in ('IF', 'MIN', 'MAX') then
          v_buf := v_upper;
        elsif v_buf in ('完成單數', '完成數量', '業績', '月薪', '請假天數', '數量') then
          null;
        elsif v_upper in ('AND', 'OR', 'NOT') then
          perform private.bonus_formula_fail(
            '不支援「' || v_buf || '」；要同時符合兩個條件請把條件相乘，例如 (完成單數 > 10) * (業績 > 50000)，或用 IF 一層包一層。',
            v_start);
        elsif cardinality(v_tokens) >= 2
              and v_tokens[cardinality(v_tokens)] ->> 'k' = 'lp'
              and v_tokens[cardinality(v_tokens) - 1] ->> 'v' in ('數量', '業績') then
          perform private.bonus_formula_fail(
            '服務名稱要用引號包起來，例如 數量("' || left(v_buf, 20) || '")。',
            v_start);
        else
          perform private.bonus_formula_fail(
            '不認識「' || left(v_buf, 20) || '」，可以用的欄位有：完成單數、完成數量、業績、月薪、請假天數。',
            v_start);
        end if;
        v_tokens := v_tokens || jsonb_build_object('k', 'name', 'v', v_buf, 'p', v_start);
        v_norm := v_norm || v_buf;
        continue;
      end if;

      -- 字串:只用在 數量("…") / 業績("…");內容照原文(不做全形轉換),只當成比對服務名稱的參數。
      if v_c = '"' then
        v_start := v_i;
        v_buf := '';
        v_i := v_i + 1;
        loop
          if v_i > v_len then
            perform private.bonus_formula_fail('引號沒有成對：服務名稱後面要再加一個「"」。', v_start);
          end if;
          v_raw := substr(p_text, v_i, 1);
          exit when v_raw in ('"', '“', '”', '＂');
          if v_raw in (chr(10), chr(13)) then
            perform private.bonus_formula_fail('引號沒有成對：服務名稱後面要再加一個「"」。', v_start);
          end if;
          if v_raw ~ c_invisible then
            perform private.bonus_formula_fail(
              '這裡有看不見的特殊字元（U+' || upper(lpad(to_hex(ascii(v_raw)), 4, '0')) || '），請刪掉後重打。',
              v_i);
          end if;
          v_buf := v_buf || v_raw;
          v_i := v_i + 1;
        end loop;
        v_i := v_i + 1;
        if char_length(v_buf) > 100 then
          perform private.bonus_formula_fail('服務名稱太長了（最多 100 個字）。', v_start);
        end if;
        v_tokens := v_tokens || jsonb_build_object('k', 'str', 'v', v_buf, 'p', v_start);
        v_norm := v_norm || '"' || v_buf || '"';
        continue;
      end if;

      -- 運算子
      v_buf := null;
      if v_c in ('+', '*', '/') then
        v_buf := v_c;
      elsif v_c = '-' then
        if v_n = '-' then
          perform private.bonus_formula_fail('不能連續寫兩個減號「--」；要減掉負數請寫成 5 - (-3)。', v_i);
        end if;
        v_buf := '-';
      elsif v_c = '>' then
        v_buf := case when v_n = '=' then '>=' else '>' end;
      elsif v_c = '<' then
        v_buf := case when v_n = '=' then '<=' when v_n = '>' then '<>' else '<' end;
      elsif v_c = '=' then
        if v_n = '=' then
          perform private.bonus_formula_fail('比較「等於」只要寫一個「=」。', v_i);
        end if;
        v_buf := '=';
      elsif v_c = '!' then
        if v_n is distinct from '=' then
          perform private.bonus_formula_fail('不能使用「!」；「不等於」請寫 <>。', v_i);
        end if;
        v_buf := '<>';
      elsif v_c = '≧' then
        v_buf := '>=';
      elsif v_c = '≦' then
        v_buf := '<=';
      elsif v_c = '≠' then
        v_buf := '<>';
      end if;
      if v_buf is not null then
        v_tokens := v_tokens || jsonb_build_object('k', 'op', 'v', v_buf, 'p', v_i);
        v_norm := v_norm || v_buf;
        v_i := v_i + case when char_length(v_buf) = 2 and v_c in ('>', '<', '!') then 2 else 1 end;
        continue;
      end if;

      if v_c = '(' then
        v_prev := v_tokens[cardinality(v_tokens)];
        if v_prev ->> 'k' = 'name' and v_prev ->> 'v' in ('數量', '業績') then
          v_item_calls := v_item_calls + 1;
        end if;
        v_tokens := v_tokens || jsonb_build_object('k', 'lp', 'p', v_i);
      elsif v_c = ')' then
        v_tokens := v_tokens || jsonb_build_object('k', 'rp', 'p', v_i);
      elsif v_c = ',' then
        v_tokens := v_tokens || jsonb_build_object('k', 'comma', 'p', v_i);
      elsif v_c = '%' then
        perform private.bonus_formula_fail('不支援百分號；5% 請寫成 0.05。', v_i);
      elsif v_c = '^' then
        perform private.bonus_formula_fail('不支援次方，請改用乘法。', v_i);
      elsif v_c = '.' then
        perform private.bonus_formula_fail('小數點前面要有數字，例如 0.5。', v_i);
      elsif v_raw ~ c_invisible then
        perform private.bonus_formula_fail(
          '這裡有看不見的特殊字元（U+' || upper(lpad(to_hex(ascii(v_raw)), 4, '0')) || '），請刪掉後重打。',
          v_i);
      elsif ascii(v_raw) between 768 and 879 then
        -- #1051(H1-13):組合字元(U+0300~U+036F)單獨顯示會疊在引號上,訊息只寫碼位、不放原字元。
        perform private.bonus_formula_fail(
          '這裡有無法單獨使用的符號（U+' || upper(lpad(to_hex(ascii(v_raw)), 4, '0')) || '），請刪掉後重打。',
          v_i);
      else
        perform private.bonus_formula_fail('不能使用「' || v_raw || '」。', v_i);
      end if;
      v_norm := v_norm || v_c;
      v_i := v_i + 1;
    end loop;

    if cardinality(v_tokens) > c_max_tokens then
      perform private.bonus_formula_fail(
        '公式太長了：最多 ' || c_max_tokens || ' 個符號（數字、欄位、運算符號、括號各算一個），目前 '
          || cardinality(v_tokens) || ' 個。',
        null);
    end if;
    if v_item_calls > c_max_item_calls then
      perform private.bonus_formula_fail(
        '數量("…")、業績("…") 合計最多用 ' || c_max_item_calls || ' 次，目前 ' || v_item_calls || ' 次。',
        null);
    end if;

    v_tokens := v_tokens || jsonb_build_object('k', 'end', 'p', v_len);
    v_parsed := private.bonus_formula_parse(to_jsonb(v_tokens), 0, 0, 0, p_merchant_id);
    perform private.bonus_formula_expect(to_jsonb(v_tokens) -> (v_parsed ->> 'p')::integer, 'end');
    v_ast := v_parsed -> 'n';
  exception when sqlstate 'BFC01' then
    get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
    return jsonb_build_object(
      'ok', false,
      'message', case when v_hint ~ '^[0-9]+$' then '第 ' || v_hint || ' 個字附近：' || v_msg else v_msg end,
      'position', case when v_hint ~ '^[0-9]+$' then v_hint::integer end);
  end;

  -- 自己產生的語法樹也走一次形狀檢查(跟計算器同一關)。
  perform private.bonus_formula_check_ast(v_ast, 1, 0);

  return jsonb_build_object(
    'ok', true,
    'ast', v_ast,
    'normalized_text', btrim(regexp_replace(v_norm, ' {2,}', ' ', 'g')),
    'item_calls', v_item_calls);
end;
$function$
;

-- ---------------- H1-11 merchants 格式限制 ----------------
alter table public.merchants
  add constraint merchants_theme_custom_color_hex_check
  check (theme_custom_color is null or theme_custom_color ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$');

alter table public.merchants
  add constraint merchants_logo_url_storage_prefix_check
  check (
    logo_url is null
    or logo_url ~ '^(https://wjtbmmnakcriuaqoknsq\.supabase\.co|http://(127\.0\.0\.1|localhost)(:[0-9]+)?)/storage/v1/object/public/merchant-logos/[^?#[:space:]]+$'
  );
