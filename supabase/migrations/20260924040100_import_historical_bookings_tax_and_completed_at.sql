-- 2026-09-24 使用者裁決修補(匯入舊訂單時,稅金不可以被算進未稅營收)+ 匯入訂單的 completed_at 根因修正。
--
-- =========================================================================
-- 【任務 4:匯入舊訂單時,稅金不可以被算進未稅營收】
--
-- 使用者裁決原文:
--   「並不是每一筆服務都固定會有開發票(稅金),要看商家是否有要開發票,所以如果是舊訂單匯入,
--     在稅金欄位沒有填寫金額就當作總營收(未稅)去計算。」
--
-- 原本的寫法(20260920170200:150):
--   v_subtotal_amount := coalesce(nullif(v_row->>'subtotal_amount','')::numeric(10,2), v_final_amount);
-- 也就是「CSV 沒給未稅小計 → 直接把 final_amount 當小計」。
--
-- 問題(已查證):CSV 只有「金額 1050 / 稅金 50」、沒有「未稅小計」這一欄時,這行會把**含稅的**
-- 1050 當成小計。而帳務報表的未稅營收是
--   total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot)
-- (20260922150500:204),於是算出 1050 —— 等於把 50 元稅金算進未稅營收裡,直接違反使用者
-- 明確表達的原則。
--
-- 【反推公式的方向:已對照 .project/specs/訂單管理.md §2.3 逐條確認,不是憑印象寫的】
-- §2.3 的四則順序(該節原文步驟 1~4):
--   步驟 1 小計   subtotal
--   步驟 2 折扣   discount
--   步驟 3 稅金   tax(課稅基礎是 subtotal − discount)
--   步驟 4 最終   final_amount_snapshot = subtotal − discount + tax
-- 把步驟 4 對 subtotal 移項:
--   subtotal = final_amount + discount − tax
-- 也就是「最終金額 + 折扣 − 稅金」。(主腦任務描述寫的 `final_amount - tax_amount + discount_amount`
-- 跟這個是同一個式子,只是加項順序不同,方向正確,已逐項核對過。)
--
-- 【這次的修法】
--   ・稅金欄位沒填或為 0  → 維持現況,final_amount 直接當未稅小計(完全符合使用者裁決原文:
--     「在稅金欄位沒有填寫金額就當作總營收(未稅)去計算」)。
--   ・稅金欄位有填(> 0)、但小計沒填 → 依上面公式反推
--     subtotal = final_amount + discount − tax,讓未稅營收真的是未稅的。
--   ・小計欄位有填 → 一律尊重 CSV 給的值,不反推、不覆蓋(商家自己給的分項金額最權威)。
--   ・防呆:反推結果 < 0(代表 CSV 的稅金比訂單總金額還大,資料本身矛盾)→ 這一列拋出白話
--     中文錯誤訊息,進到 error_report 讓商家自己去修那一列,不靜默寫入一個負數小計。
--
-- ⚠️ 這支函式原本的檔頭有一段「subtotal/discount/tax 純粹當作歷史留存的分項金額顯示,不參與
--    final_amount 的推算」的設計說明。這次**沒有**推翻那條:final_amount 仍然是唯一權威的實收
--    金額,這次改的是反方向——用 final_amount 去推算 subtotal,而不是用 subtotal 去推算
--    final_amount。final_amount 本身一行都沒有被動到。
--
-- =========================================================================
-- 【附帶(但必要)修正:匯入的已完成訂單要寫入 completed_at】
--
-- 這不是額外加料,是任務 1「報表改用完成時間當基準」的根因修正,沒有它任務 1 會持續壞掉:
--   ・唯一的一般完成路徑 public.complete_booking() 一律 `completed_at = now()`。
--   ・這支匯入函式是**直接 INSERT** status='completed',INSERT 欄位清單裡完全沒有
--     completed_at → 必定寫成 null。
--   ・正式環境(wjtbmmnakcriuaqoknsq)唯讀查證結果:status='completed' 共 40 筆,其中
--     completed_at 為 null 的 14 筆 **全部** source='import',精準對應這條路徑。
--   ・任務 1 之後報表用「完成時間」分月,如果不修這裡,以後每一次歷史匯入都會再生產一批
--     completed_at 為 null 的訂單,永遠只能靠報表端的 coalesce 兜著。
--
-- 寫入的值是 v_start_at(不是 now()):歷史匯入訂單的「完成」發生在服務當天,不是按下匯入
-- 按鈕的那天。拿 now() 會把 2024 年的營收全部算進匯入當月,明顯錯誤。
-- status='cancelled' 的列維持 null(沒完成過的訂單不該有完成時間)。
--
-- 【簽章不變】create or replace,參數一字不改。其餘每一行完整照抄
-- 20260920170200_data_import_historical_bookings_batch.sql,只動上述兩處。
-- 權限設定(revoke/grant)照原樣重新宣告一次(supabase-permission-hygiene)。
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

comment on function public.import_historical_bookings_batch(uuid, jsonb) is '模組 12 §3.4(核心，規則 2.3/2.4,2026-09-24 使用者裁決疊加):批次匯入歷史訂單。完全不呼叫 create_booking/update_booking/complete_booking，不做排程衝突驗證，不觸發抽成/紅利計算。只有商家管理員可以呼叫(規則 2.1)。【2026-09-24 任務 4】使用者裁決「並不是每一筆服務都固定會有開發票(稅金)…如果是舊訂單匯入,在稅金欄位沒有填寫金額就當作總營收(未稅)去計算」:未稅小計 subtotal_amount_snapshot 的決定方式改成三分支——CSV 有給小計就尊重 CSV;沒給小計但稅金 > 0 就依訂單管理規格書 §2.3 的四則順序反推 subtotal = final_amount + discount − tax(原本直接把含稅的 final_amount 當小計,等於把稅金算進未稅營收);沒給小計且稅金沒填或為 0 則維持 final_amount 直接當未稅小計。反推出負數(稅金大於訂單金額,CSV 本身矛盾)時該列拋白話錯誤訊息進 error_report,不寫入負數小計。final_amount 仍然是唯一權威的實收金額,一行都沒被動到。【2026-09-24 任務 1 根因修正】INSERT 補上 completed_at = start_at(status=completed 時;cancelled 維持 null):這支函式是直接 INSERT status=completed,原本完全沒寫 completed_at,是正式環境那 14 筆「已完成但 completed_at 為 null」的唯一來源;帳務報表改用完成時間分月之後,不補這一欄就會每次匯入都製造報表分錯月份的資料。用 start_at 而不是 now(),因為歷史訂單的完成發生在服務當天。';

revoke execute on function public.import_historical_bookings_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_historical_bookings_batch(uuid, jsonb) to authenticated;
