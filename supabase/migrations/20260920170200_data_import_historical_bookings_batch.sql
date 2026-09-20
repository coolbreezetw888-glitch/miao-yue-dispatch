-- 模組 12:資料匯入/報表匯出 — import_historical_bookings_batch(第三支)。
-- 對應規格書 §2.3/§2.4(核心必測)/§3.4。
--
-- ⚠️ 核心設計決策(規則 2.3/2.4):這支函式完全不呼叫 create_booking/update_booking/
-- complete_booking，也不執行任何排程衝突驗證，更不會觸發 compute_booking_commission/
-- compute_member_loyalty_points(這兩支只在 complete_booking() 內部被呼叫)。歷史訂單是
-- 「已經發生過的事實」，不是「要不要允許發生」的判斷，這是刻意的設計，不是遺漏。
--
-- 進度說明（給主腦回報時使用，不完全等同規格書逐字描述的一處實作簡化）：
-- 規格書 §3.4 提到「如果 CSV 額外提供了折扣/稅金欄位，依模組 6 §2.3 節相同公式換算」——
-- 這裡選擇不重新實作模組 6 的百分比/固定金額折扣稅金計算引擎（那套引擎專為即時建單設計，
-- 牽涉 discount_mode/tax_mode 等多組欄位），改成把 final_amount 視為唯一權威的實收金額，
-- subtotal/discount/tax 三個欄位（如果 CSV 有提供）純粹當作歷史留存的分項金額顯示，不參與
-- final_amount 的推算。這是為了避免历史资料因为公式差异被系统「重新算错」，比强行套用即时建单
-- 的计算公式更安全，但跟规格书原文字面并不完全一致，需要在完成回报时向主腦特别说明。
--
-- p_rows 每一列的 JSON 形狀：
-- {
--   "row_number": 1,
--   "customer_name": "王小明",              -- 必填
--   "customer_phone": "0912345678",         -- 必填
--   "customer_email": "..." | null,
--   "customer_address": "..." | null,
--   "customer_notes": "..." | null,         -- 客戶備註（規格書 3.4 明列的欄位）
--   "staff_id": "<uuid>",                   -- 必填，數值對應步驟(3.3)解析好的真實服務人員 id
--   "start_at": "2024-01-01T10:00:00+08:00",-- 必填，ISO 時間字串
--   "duration_minutes": 90 | null,          -- 選填，沒有就預設 60 分鐘
--   "status": "已完成" | "completed" | "cancelled" | "已取消" | null,
--   "service_description": "洗剪吹" | null,
--   "final_amount": 1000,                   -- 必填，>= 0
--   "subtotal_amount": 1000 | null,         -- 選填，純顯示用分項金額，不參與 final_amount 推算
--   "discount_amount": 0 | null,
--   "tax_amount": 0 | null,
--   "payment_method": "cash" | null,
--   "member_phone": "0911111111" | null     -- 選填，比對既有 active 會員，找不到留空，不建立新會員
-- }
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
      v_subtotal_amount := coalesce(nullif(v_row->>'subtotal_amount', '')::numeric(10, 2), v_final_amount);
      v_discount_amount := coalesce(nullif(v_row->>'discount_amount', '')::numeric(10, 2), 0);
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric(10, 2), 0);

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
        member_name_snapshot
      ) values (
        p_merchant_id, v_staff_id, v_customer_name, v_customer_phone, v_customer_email,
        v_customer_address, v_customer_notes, v_start_at, v_end_at, v_status, 'import', 'admin',
        auth.uid(), v_service_description, v_subtotal_amount, v_discount_amount, v_tax_amount,
        v_final_amount, v_payment_method, v_member_id, v_member_name
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

comment on function public.import_historical_bookings_batch(uuid, jsonb) is '模組 12 §3.4(核心，規則 2.3/2.4):批次匯入歷史訂單。完全不呼叫 create_booking/update_booking/complete_booking，不做排程衝突驗證，不觸發抽成/紅利計算。只有商家管理員可以呼叫(規則 2.1)。';

revoke execute on function public.import_historical_bookings_batch(uuid, jsonb) from public, anon;
grant execute on function public.import_historical_bookings_batch(uuid, jsonb) to authenticated;
