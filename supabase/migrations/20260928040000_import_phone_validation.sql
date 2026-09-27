-- SPECS-INDEX #824:CSV 匯入的電話欄位套用 #822 的格式驗證(逐列回報,不整批失敗)。
--
-- ─── 背景 ─────────────────────────────────────────────────────────────────────
-- #822(20260927010000)把「客戶電話格式」規則做進 create_booking / update_booking,
-- 但 CSV 匯入的兩支函式 import_members_batch / import_historical_bookings_batch 是**直接 insert、
-- 不走 create_booking**(歷史訂單)、或走 create_member / update_member(會員,這兩支後端本來就沒有
-- 電話格式檢查),所以 #822 擋了前門、CSV 這個後門沒關——從 CSV 還是可以匯入「123」這種電話。
--
-- ─── 這次做的事 ─────────────────────────────────────────────────────────────────
-- 1. import_members_batch:「電話」欄位**有填**的時候,先過 private.is_valid_taiwan_phone,
--    不合格就 raise exception(進到既有的逐列 exception 處理 → 那一列算 failed、寫進 error_report、
--    其他列照常匯入)。沒填電話維持合法(#618 之後會員電話是選填)。
--    檢查放在「用電話找既有會員」之前:不合格的電話不該拿去比對、也不該被當成「重複略過」。
-- 2. import_historical_bookings_batch:「客戶電話」在既有的非空檢查之後,加同一條格式檢查,
--    同樣走逐列回報。
-- 3. 規則本體**完全沿用** private.is_valid_taiwan_phone(#822 的成果),這裡沒有第二套正規表示式。
--    is_valid_taiwan_phone 的 EXECUTE 只開給 postgres/service_role,這兩支匯入函式都是 SECURITY
--    DEFINER(owner postgres),以 owner 身份呼叫,不需要動它的權限。
--
-- ─── 錯誤訊息格式(延續匯入模組既有慣例)───────────────────────────────────────────
-- error_report 每一筆是 {row_number, raw_data, error_message},前端固定顯示成「第 N 列:<error_message>」,
-- 所以訊息本身不重複寫列號,只寫「哪個欄位、這一列填了什麼、正確格式長怎樣」。實際看起來會是:
--   第 3 列:「客戶電話」欄位格式不正確(這一列填的是「123」)。手機請填 09 開頭共 10 碼(例如 0912345678);
--   市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)
--
-- ─── 刻意不做 ─────────────────────────────────────────────────────────────────
-- ・不整批失敗:匯入模組既有慣例是逐列回報並跳過,這次沿用,不發明新行為。
-- ・不驗 referrer_value(會員匯入的「推薦人電話/推薦碼」):它可能是推薦碼,不是電話。
-- ・不驗 member_phone(歷史訂單匯入的「會員電話」選填欄位):它只拿來查既有會員、不會存進任何欄位,
--   對不到就是不連結;為了一個選填的查詢鍵把整列訂單擋掉不合比例。已另外回報主腦評估。
-- ・不清、不改既有的髒電話(使用者裁決「舊的髒資料可以不管他」);本 migration 沒有任何 UPDATE/DELETE。
-- ・不動 create_booking / update_booking / is_valid_taiwan_phone / normalize_phone 一個字
--   (含 is_valid_taiwan_phone 的 comment 裡「只給 create_booking / update_booking 內部呼叫」那句,
--   現在多了這兩支呼叫端,那句略為過時,留給主腦決定要不要在下一次動到它時一併更新)。
--
-- 兩支函式的其餘內容**逐字沿用**最新版本(import_members_batch ← 20260924020500、
-- import_historical_bookings_batch ← 20260924040100),簽章不變,不需要 drop;
-- revoke/grant 照原樣整組重新宣告(supabase-permission-hygiene 規則 1)。

-- =========================================================================
-- 1. import_members_batch:逐字沿用 20260924020500,只在解析完欄位後加一段電話格式檢查。
-- =========================================================================
create or replace function public.import_members_batch(
  p_merchant_id uuid,
  p_write_mode text,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_id uuid;
  v_total_rows int;
  v_success_rows int := 0;
  v_failed_rows int := 0;
  v_skipped_rows int := 0;
  v_error_report jsonb := '[]'::jsonb;
  v_snapshot jsonb := '{}'::jsonb;
  v_row jsonb;
  v_idx int;
  v_row_number int;
  v_name text;
  v_phone text;
  v_email text;
  v_birthday date;
  v_notes text;
  v_referrer_value text;
  v_starting_points_text text;
  v_starting_points int;
  v_existing_member_id uuid;
  v_referrer_id uuid;
  v_member public.members;
  v_old_member public.members;
  v_action text;
  v_txn_id uuid;
begin
  -- 規則 2.1(核心):只有商家管理員能發動批次匯入，不接受任何客服呼叫。
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '批次匯入/資料搬遷，只有商家管理員可以操作' using errcode = '42501';
  end if;

  if p_write_mode not in ('insert_only', 'upsert_by_phone') then
    raise exception '無效的寫入模式：%', p_write_mode;
  end if;

  v_total_rows := jsonb_array_length(p_rows);

  -- 判斷 9:每批匯入上限 2,000 列。
  if v_total_rows > 2000 then
    raise exception '單批匯入最多 2,000 筆資料，這次上傳了 % 筆，請分批匯入', v_total_rows;
  end if;

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, write_mode, total_rows, created_by_user_id
  ) values (
    p_merchant_id, 'member_import', p_write_mode, v_total_rows, auth.uid()
  ) returning id into v_operation_id;

  for v_idx in 0 .. v_total_rows - 1 loop
    v_row := p_rows -> v_idx;
    v_action := null;
    begin
      v_row_number := coalesce((v_row->>'row_number')::int, v_idx + 1);
      v_name := nullif(btrim(coalesce(v_row->>'name', '')), '');
      v_phone := nullif(btrim(coalesce(v_row->>'phone', '')), '');
      v_email := nullif(btrim(coalesce(v_row->>'email', '')), '');
      v_birthday := nullif(v_row->>'birthday', '')::date;
      v_notes := nullif(btrim(coalesce(v_row->>'notes', '')), '');
      v_referrer_value := nullif(btrim(coalesce(v_row->>'referrer_value', '')), '');
      v_starting_points_text := nullif(btrim(coalesce(v_row->>'starting_points_balance', '')), '');
      v_starting_points := case when v_starting_points_text is null then null
                                 else v_starting_points_text::int end;

      -- 規則 2.6 邊界情況：起始點數為負數，這一列視為錯誤，不寫入。
      if v_starting_points is not null and v_starting_points < 0 then
        raise exception '起始點數餘額不可為負數';
      end if;

      -- SPECS-INDEX #824(2026-09-28):電話**有填**才檢查格式(#618 之後會員電話是選填,留空合法)。
      -- 規則本體沿用 #822 的 private.is_valid_taiwan_phone(手機或市話,市話可帶 # 分機,分隔符號不強制)。
      -- 放在「用電話找既有會員」之前:不合格的電話不拿去比對、也不當成「重複略過」,直接讓這一列失敗。
      -- raise 出去會被下面既有的 exception when others 接住 → 這一列算 failed、寫進 error_report,
      -- 其他列不受影響(匯入模組既有的逐列回報慣例)。
      if v_phone is not null and not private.is_valid_taiwan_phone(v_phone) then
        raise exception '「電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)', v_phone;
      end if;

      -- 找既有會員(依正規化後電話比對，只比對這個商家 status=active 的會員)。
      v_existing_member_id := null;
      if private.normalize_phone(v_phone) is not null then
        select id into v_existing_member_id
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and private.normalize_phone(phone) = private.normalize_phone(v_phone)
        limit 1;
      end if;

      -- 推薦人查找(規則 2.5.3)：電話或推薦碼，找不到就留空，不視為錯誤。
      v_referrer_id := null;
      if v_referrer_value is not null then
        select id into v_referrer_id
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and (
            referral_code = upper(v_referrer_value)
            or (private.normalize_phone(phone) is not null
                and private.normalize_phone(phone) = private.normalize_phone(v_referrer_value))
          )
        limit 1;
      end if;

      if v_existing_member_id is not null and p_write_mode = 'insert_only' then
        -- 規則 2.5.1：insert_only 模式下電話重複，直接略過，不修改既有資料。
        v_skipped_rows := v_skipped_rows + 1;
      elsif v_existing_member_id is not null and p_write_mode = 'upsert_by_phone' then
        -- 規則 2.5.2：upsert_by_phone 模式下電話重複，更新既有會員。
        -- 規則 2.7：先記錄復原所需的原始值——只在這個會員這個批次「第一次」被更新時記錄，
        -- 避免同一支電話在 CSV 裡重複出現時，第二次覆蓋掉真正的原始值(邊界情況，規則 2.5)。
        select * into v_old_member from public.members where id = v_existing_member_id;

        -- 注意:v_snapshot 一開始是 '{}'::jsonb，這時候 v_snapshot -> 'members' 會是 SQL NULL，
        -- 直接對 NULL 用 ? 運算子的結果也是 NULL，`if not (NULL)` 在 plpgsql 裡會被當成「不是
        -- true」而整段跳過(不是拋錯，是靜默跳過)——所以一定要先確保 'members' 這個 key 存在，
        -- 是一個貨真價實的 jsonb 物件，才能接著用 ? 判斷「這個會員是不是第一次被記錄」。
        if not (v_snapshot ? 'members') then
          v_snapshot := v_snapshot || jsonb_build_object('members', '{}'::jsonb);
        end if;

        if not (v_snapshot -> 'members' ? v_existing_member_id::text) then
          v_snapshot := jsonb_set(
            v_snapshot,
            array['members', v_existing_member_id::text],
            jsonb_build_object(
              'name', v_old_member.name,
              'phone', v_old_member.phone,
              'email', v_old_member.email,
              'birthday', v_old_member.birthday,
              'notes', v_old_member.notes
            )
          );
        end if;

        -- 2026-09-24 修正(B3):update_member 自從 #615 之後是 7 個參數,第 7 個 p_tier_id
        -- 雖然有 default null,但函式內部是無條件 `tier_id = p_tier_id`,少傳就等於把這位
        -- 既有會員的會員等級清成未分級。CSV 匯入格式本來就沒有「會員等級」這個欄位,
        -- 沿用 v_old_member.tier_id(更新前的現況)才是正確行為。
        v_member := public.update_member(v_existing_member_id, coalesce(v_name, v_old_member.name), v_phone, v_email, v_birthday, v_notes, v_old_member.tier_id);
        insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
          values (v_operation_id, 'members', v_member.id, 'updated');
        v_action := 'updated';
        v_success_rows := v_success_rows + 1;
      else
        -- 查無既有會員：建立新會員，完全複用 create_member(規則 2.2，電話必填政策/推薦人驗證
        -- 沿用既有邏輯，不重新實作)。
        v_member := public.create_member(p_merchant_id, v_name, v_phone, v_email, v_birthday, v_notes, v_referrer_id);
        insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
          values (v_operation_id, 'members', v_member.id, 'created');
        v_action := 'created';
        v_success_rows := v_success_rows + 1;
      end if;

      -- 規則 2.6：起始點數餘額，透過既有的 adjust_member_points 寫入。
      if v_action in ('created', 'updated') and v_starting_points is not null and v_starting_points > 0 then
        perform public.adjust_member_points(v_member.id, v_starting_points, '資料匯入：起始點數餘額');
        -- adjust_member_points 沒有回傳分類帳紀錄本身，這裡另外查一次剛寫入的那一筆，把「真正的
        -- member_point_transactions.id」記錄進明細表(不是 member_id)，讓 rollback_bulk_operation
        -- (3.5)之後能精準判斷「這筆點數異動是不是這個批次自己產生的」。
        select id into v_txn_id
        from public.member_point_transactions
        where member_id = v_member.id
          and transaction_type = 'manual_adjustment'
          and note = '資料匯入：起始點數餘額'
        order by created_at desc, id desc
        limit 1;
        insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
          values (v_operation_id, 'member_point_transactions', v_txn_id, v_action);
      end if;

      v_action := null;
    exception when others then
      v_failed_rows := v_failed_rows + 1;
      v_error_report := v_error_report || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'raw_data', v_row,
        'error_message', sqlerrm
      ));
    end;
  end loop;

  update public.merchant_bulk_operations
  set success_rows = v_success_rows,
      failed_rows = v_failed_rows,
      skipped_duplicate_rows = v_skipped_rows,
      error_report = v_error_report,
      pre_operation_snapshot = v_snapshot
  where id = v_operation_id;

  return v_operation_id;
end;
$$;

comment on function public.import_members_batch(uuid, text, jsonb) is '模組 12 §3.1(核心):批次匯入會員，逐列呼叫既有的 create_member/update_member/adjust_member_points(規則 2.2/2.5/2.6，完全不直接寫入 members/member_point_transactions)，單一列失敗不影響其他列，只有商家管理員可以呼叫(規則 2.1)。2026-09-24 修正(B3):update_member 自從 #615 改成 7 個參數後,這裡仍然只傳 6 個,導致 upsert_by_phone 模式下每一次匯入都把電話對上的既有會員的會員等級靜默清成未分級;現在改成沿用該會員更新前的 tier_id。SPECS-INDEX #824(2026-09-28):「電話」欄位有填時套用 #822 的格式規則(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機),不合格的那一列算 failed 並寫進 error_report(白話中文,含這一列填的值與正確格式範例),其他列照常匯入;留空維持合法;檢查在「用電話找既有會員」之前,不合格的電話不會被當成重複略過。';

revoke execute on function public.import_members_batch(uuid, text, jsonb) from public, anon;
grant execute on function public.import_members_batch(uuid, text, jsonb) to authenticated;

-- =========================================================================
-- 2. import_historical_bookings_batch:逐字沿用 20260924040100,只在「缺少必填欄位:客戶電話」
--    之後加一段電話格式檢查。
-- =========================================================================
create or replace function public.import_historical_bookings_batch(
  p_merchant_id uuid,
  p_rows jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_id uuid;
  v_total_rows int;
  v_success_rows int := 0;
  v_failed_rows int := 0;
  v_error_report jsonb := '[]'::jsonb;
  v_row jsonb;
  v_idx int;
  v_row_number int;
  v_customer_name text;
  v_customer_phone text;
  v_customer_email text;
  v_customer_address text;
  v_customer_notes text;
  v_staff_id uuid;
  v_start_at timestamptz;
  v_duration_minutes int;
  v_end_at timestamptz;
  v_status_raw text;
  v_status text;
  v_service_description text;
  v_final_amount numeric(10, 2);
  v_subtotal_amount numeric(10, 2);
  v_discount_amount numeric(10, 2);
  v_tax_amount numeric(10, 2);
  v_payment_method text;
  v_member_phone text;
  v_member_id uuid;
  v_member_name text;
  v_booking_id uuid;
begin
  -- 規則 2.1(核心):只有商家管理員能發動批次匯入。
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '批次匯入/資料搬遷，只有商家管理員可以操作' using errcode = '42501';
  end if;

  v_total_rows := jsonb_array_length(p_rows);

  if v_total_rows > 2000 then
    raise exception '單批匯入最多 2,000 筆資料，這次上傳了 % 筆，請分批匯入', v_total_rows;
  end if;

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, total_rows, created_by_user_id
  ) values (
    p_merchant_id, 'historical_booking_import', v_total_rows, auth.uid()
  ) returning id into v_operation_id;

  for v_idx in 0 .. v_total_rows - 1 loop
    v_row := p_rows -> v_idx;
    begin
      v_row_number := coalesce((v_row->>'row_number')::int, v_idx + 1);
      v_customer_name := nullif(btrim(coalesce(v_row->>'customer_name', '')), '');
      v_customer_phone := nullif(btrim(coalesce(v_row->>'customer_phone', '')), '');
      v_customer_email := nullif(btrim(coalesce(v_row->>'customer_email', '')), '');
      v_customer_address := nullif(btrim(coalesce(v_row->>'customer_address', '')), '');
      v_customer_notes := nullif(btrim(coalesce(v_row->>'customer_notes', '')), '');
      v_staff_id := nullif(v_row->>'staff_id', '')::uuid;
      v_start_at := nullif(v_row->>'start_at', '')::timestamptz;
      v_duration_minutes := nullif(v_row->>'duration_minutes', '')::int;
      v_service_description := nullif(btrim(coalesce(v_row->>'service_description', '')), '');
      v_payment_method := nullif(btrim(coalesce(v_row->>'payment_method', '')), '');
      v_member_phone := nullif(btrim(coalesce(v_row->>'member_phone', '')), '');

      -- 必填欄位驗證。
      if v_customer_name is null then
        raise exception '缺少必填欄位：客戶姓名';
      end if;
      if v_customer_phone is null then
        raise exception '缺少必填欄位：客戶電話';
      end if;
      -- SPECS-INDEX #824(2026-09-28):客戶電話格式檢查,規則本體沿用 #822 的 private.is_valid_taiwan_phone
      -- (跟 create_booking / update_booking 同一條規則,手機或市話、市話可帶 # 分機、分隔符號不強制)。
      -- raise 出去會被下面既有的 exception when others 接住 → 這一列算 failed、寫進 error_report,
      -- 其他列不受影響(匯入模組既有的逐列回報慣例,不整批失敗)。
      if not private.is_valid_taiwan_phone(v_customer_phone) then
        raise exception '「客戶電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)', v_customer_phone;
      end if;
      if v_staff_id is null then
        raise exception '缺少必填欄位：服務人員';
      end if;
      if v_start_at is null then
        raise exception '缺少必填欄位：預約時間，或時間格式無法辨識';
      end if;
      if nullif(v_row->>'final_amount', '') is null then
        raise exception '缺少必填欄位：訂單金額';
      end if;
      v_final_amount := (v_row->>'final_amount')::numeric(10, 2);
      if v_final_amount < 0 then
        raise exception '訂單金額不可為負數';
      end if;

      -- staff_id 必須是這個商家底下存在的服務人員(3.3 數值對應步驟保證，這裡再次防呆)。
      if not exists (
        select 1 from public.merchant_staff where id = v_staff_id and merchant_id = p_merchant_id
      ) then
        raise exception '指定的服務人員不存在於這個商家';
      end if;

      -- end_at：有工時欄位就用，沒有預設 60 分鐘(規則 2.3/3.4)。
      v_end_at := v_start_at + make_interval(mins => coalesce(v_duration_minutes, 60));

      -- status 正規化(規則 3.4)。
      v_status_raw := lower(btrim(coalesce(v_row->>'status', '')));
      v_status := case
        when v_status_raw in ('completed', '已完成', 'complete') then 'completed'
        when v_status_raw in ('cancelled', '已取消', 'canceled') then 'cancelled'
        else 'completed'
      end;

      -- 選填進階金額欄位：final_amount 是唯一權威金額，subtotal/discount/tax 只是分項顯示。
      --
      -- 2026-09-24(任務 4,使用者裁決:「…如果是舊訂單匯入,在稅金欄位沒有填寫金額就當作總營收
      -- (未稅)去計算。」):折扣/稅金要先解析出來,因為下面反推未稅小計時會用到它們。
      -- 這兩行的內容本身完全沒變,只是從 subtotal 那一行的下面搬到上面。
      v_discount_amount := coalesce(nullif(v_row->>'discount_amount', '')::numeric(10, 2), 0);
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric(10, 2), 0);

      -- 未稅小計(subtotal_amount_snapshot)。這個欄位直接決定帳務報表的
      -- total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
      -- 所以它「含不含稅」這件事必須完全正確。
      v_subtotal_amount := nullif(v_row->>'subtotal_amount', '')::numeric(10, 2);

      if v_subtotal_amount is null then
        if v_tax_amount > 0 then
          -- 稅金有填、小計沒填:依 .project/specs/訂單管理.md §2.3 的四則順序
          -- (final = subtotal − discount + tax)對 subtotal 移項反推:
          --   subtotal = final_amount + discount − tax
          -- 例:CSV 只有「金額 1050 / 稅金 50」(沒有折扣)→ 小計 = 1050 + 0 − 50 = 1000,
          -- 未稅營收算出 1000 而不是 1050,那 50 元稅金不再被算進營收裡。
          v_subtotal_amount := v_final_amount + v_discount_amount - v_tax_amount;

          -- 防呆:反推出負數代表 CSV 這一列本身矛盾(稅金比訂單總金額還大)。不靜默寫入負數
          -- 小計(那會讓報表營收莫名變少還很難查),拋白話錯誤訊息讓這一列進 error_report,
          -- 商家自己去修那一列就好,不影響同一批其他正常的列(這個迴圈是逐列 exception 處理)。
          if v_subtotal_amount < 0 then
            raise exception '稅金金額(%)大於訂單金額(%)，無法推算未稅小計，請確認這一列的金額與稅金欄位',
              v_tax_amount, v_final_amount;
          end if;
        else
          -- 稅金沒填或是 0:完全照使用者裁決原文——總金額直接當未稅營收,不做任何反推。
          v_subtotal_amount := v_final_amount;
        end if;
      end if;

      -- 會員連結(選填，規則 3.4：只比對既有 active 會員，不建立新會員)。
      v_member_id := null;
      v_member_name := null;
      if v_member_phone is not null and private.normalize_phone(v_member_phone) is not null then
        select id, name into v_member_id, v_member_name
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and private.normalize_phone(phone) = private.normalize_phone(v_member_phone)
        limit 1;
      end if;

      -- 注意:bookings.payment_method(text)這個舊欄位在模組 9 v2 已經被拿掉，改成
      -- payment_method_id(外鍵，指向 payment_methods)+ payment_method_name_snapshot(文字快照)。
      -- 歷史匯入的付款方式文字不保證能對應到這個商家「現在」的付款方式清單，比照第一節 1.3
      -- service_description_snapshot 的精神，直接存成文字快照，不嘗試比對/建立 payment_methods
      -- 資料列，payment_method_id 一律留 null。
      insert into public.bookings (
        merchant_id, staff_id, customer_name, customer_phone, customer_email, customer_address,
        customer_notes, start_at, end_at, status, source, created_by_role, created_by_user_id,
        service_description_snapshot, subtotal_amount_snapshot, discount_amount_snapshot,
        tax_amount_snapshot, final_amount_snapshot, payment_method_name_snapshot, member_id,
        member_name_snapshot,
        -- 2026-09-24(任務 1 的根因修正):原本這個 INSERT 完全沒有 completed_at,所以每一筆
        -- 匯入的已完成訂單 completed_at 都是 null(正式環境那 14 筆就是這樣來的)。任務 1 之後
        -- 帳務報表改用「完成時間」分月,不補這一欄就等於每次匯入都繼續製造報表撈不到的資料。
        completed_at
      ) values (
        p_merchant_id, v_staff_id, v_customer_name, v_customer_phone, v_customer_email,
        v_customer_address, v_customer_notes, v_start_at, v_end_at, v_status, 'import', 'admin',
        auth.uid(), v_service_description, v_subtotal_amount, v_discount_amount, v_tax_amount,
        v_final_amount, v_payment_method, v_member_id, v_member_name,
        -- 用 v_start_at 而不是 now():歷史訂單的「完成」發生在服務當天,不是按下匯入按鈕那天。
        -- 用 now() 會把 2024 年的營收整批算進匯入當月。status='cancelled' 維持 null(沒完成過)。
        case when v_status = 'completed' then v_start_at else null end
      ) returning id into v_booking_id;

      insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
        values (v_operation_id, 'bookings', v_booking_id, 'created');

      v_success_rows := v_success_rows + 1;
    exception when others then
      v_failed_rows := v_failed_rows + 1;
      v_error_report := v_error_report || jsonb_build_array(jsonb_build_object(
        'row_number', v_row_number,
        'raw_data', v_row,
        'error_message', sqlerrm
      ));
    end;
  end loop;

  update public.merchant_bulk_operations
  set success_rows = v_success_rows,
      failed_rows = v_failed_rows,
      error_report = v_error_report
  where id = v_operation_id;

  return v_operation_id;
end;
$$;

comment on function public.import_historical_bookings_batch(uuid, jsonb) is '模組 12 §3.4(核心，規則 2.3/2.4,2026-09-24 使用者裁決疊加):批次匯入歷史訂單。完全不呼叫 create_booking/update_booking/complete_booking，不做排程衝突驗證，不觸發抽成/紅利計算。只有商家管理員可以呼叫(規則 2.1)。【2026-09-24 任務 4】使用者裁決「並不是每一筆服務都固定會有開發票(稅金)…如果是舊訂單匯入,在稅金欄位沒有填寫金額就當作總營收(未稅)去計算」:未稅小計 subtotal_amount_snapshot 的決定方式改成三分支——CSV 有給小計就尊重 CSV;沒給小計但稅金 > 0 就依訂單管理規格書 §2.3 的四則順序反推 subtotal = final_amount + discount − tax(原本直接把含稅的 final_amount 當小計,等於把稅金算進未稅營收);沒給小計且稅金沒填或為 0 則維持 final_amount 直接當未稅小計。反推出負數(稅金大於訂單金額,CSV 本身矛盾)時該列拋白話錯誤訊息進 error_report,不寫入負數小計。final_amount 仍然是唯一權威的實收金額,一行都沒被動到。【2026-09-24 任務 1 根因修正】INSERT 補上 completed_at = start_at(status=completed 時;cancelled 維持 null):這支函式是直接 INSERT status=completed,原本完全沒寫 completed_at,是正式環境那 14 筆「已完成但 completed_at 為 null」的唯一來源;帳務報表改用完成時間分月之後,不補這一欄就會每次匯入都製造報表分錯月份的資料。用 start_at 而不是 now(),因為歷史訂單的完成發生在服務當天。【SPECS-INDEX #824,2026-09-28】客戶電話在「缺少必填欄位」檢查之後套用 #822 的格式規則(private.is_valid_taiwan_phone,跟 create_booking 同一條),不合格的那一列算 failed 並寫進 error_report(白話中文,含這一列填的值與正確格式範例),其他列照常匯入;這支函式不走 create_booking,所以 #822 加在那裡的守門原本管不到這裡。member_phone(選填的會員連結查詢鍵)刻意不驗。';

revoke execute on function public.import_historical_bookings_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_historical_bookings_batch(uuid, jsonb) to authenticated;
