-- 模組 12:資料匯入/報表匯出 — import_members_batch(第二支)。
-- 對應規格書 §2.1/§2.2/§2.5/§2.6/§2.7/§3.1(核心必測)。
--
-- 重要技術依據(供之後維護者理解為什麼規則 2.8 的復原「時間戳記比對」邏輯是可靠的):
-- Postgres 的 now() 在同一個交易(transaction)內永遠回傳同一個值(交易開始時間，不是
-- statement 執行當下的時間，那是 clock_timestamp() 才會變動)。這支函式從頭到尾只在一個交易裡
-- 執行(單一 RPC 呼叫 = 單一交易)，所以 merchant_bulk_operations.created_at(這支函式一開始
-- insert 時寫入)跟這批次寫入的每一筆 members.created_at/updated_at(靠 set_updated_at trigger
-- 或 insert 時的 default now()）完全是同一個時間值——之後 rollback_bulk_operation(3.5)
-- 判斷「這筆資料自從匯入之後有沒有被動過」，只需要比對 members.updated_at 是否還等於
-- merchant_bulk_operations.created_at，不需要額外存一份「匯入當下的時間戳記」。
--
-- p_rows 每一列的 JSON 形狀(前端 CSV 欄位對應完成後組出):
-- {
--   "row_number": 1,                      -- 必填，對應 CSV 第幾筆資料列(不含表頭)，用於錯誤報告
--   "name": "王小明",                      -- 必填
--   "phone": "0912345678" | null,
--   "email": "a@b.com" | null,
--   "birthday": "1990-01-01" | null,       -- ISO date 字串
--   "notes": "備註" | null,
--   "referrer_value": "0911111111" | null, -- 對應規則 2.5.3：可以是電話或 referral_code
--   "starting_points_balance": 100 | null  -- 對應規則 2.6
-- }
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

        v_member := public.update_member(v_existing_member_id, coalesce(v_name, v_old_member.name), v_phone, v_email, v_birthday, v_notes);
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

comment on function public.import_members_batch(uuid, text, jsonb) is '模組 12 §3.1(核心):批次匯入會員，逐列呼叫既有的 create_member/update_member/adjust_member_points(規則 2.2/2.5/2.6，完全不直接寫入 members/member_point_transactions)，單一列失敗不影響其他列，只有商家管理員可以呼叫(規則 2.1)。';

revoke execute on function public.import_members_batch(uuid, text, jsonb) from public, anon;
grant execute on function public.import_members_batch(uuid, text, jsonb) to authenticated;
