-- 深夜自主巡檢批次(2026-09-24)B1:rollback_bulk_operation 呼叫 update_member 時少傳第 7 個參數,
-- 導致「復原會員匯入」會靜默把會員等級(tier_id)清成未分級。
--
-- =========================================================================
-- 【問題】
-- public.update_member 在 20260923010300_req615_618_member_core_functions_rewrite.sql 被
-- drop + create 改成 7 個參數:
--     (p_member_id uuid, p_name text, p_phone text, p_email text,
--      p_birthday date, p_notes text, p_tier_id uuid default null)
-- 第 7 個參數 p_tier_id 有 `default null`,而且函式內部是無條件
-- `update public.members set ... tier_id = p_tier_id`(傳 null 就是「清空成未分級」,
-- 這是 #615 刻意的設計,不是 bug)。
--
-- 但 20260920170400_data_import_rollback.sql 裡的 rollback_bulk_operation 是在 p_tier_id
-- 這個參數存在之前寫的,它只傳 6 個參數——等於每一次復原都無聲無息地把 p_tier_id 帶成 null。
--
-- 【錯誤情境】
--   1. 商家用 upsert_by_phone 模式匯入一批會員 CSV,其中幾位是既有會員(被 update)。
--   2. 商家發現匯入有問題,按下「復原這個批次」。
--   3. rollback_bulk_operation 把姓名/電話/信箱/生日/備註還原成匯入前的快照——看起來很正常,
--      但同一個 UPDATE 順手把 tier_id 設成 null,所有被復原的會員全部變成「未分級」。
--   4. 系統完全不會告知這件事(不在 skipped_reasons 裡,restored_count 照樣 +1),
--      商家要等到之後發現「VIP 會員怎麼都不見了、折扣/紅利倍率都不對」才會察覺。
--
-- 【修法】
-- 補傳第 7 個參數。函式裡本來就已經先 `select * into v_member from public.members
-- where id = v_item.entity_id`(復原前的那一列),直接用 v_member.tier_id 即可——
-- 也就是「復原基本資料,但會員等級維持現狀不動」。
--
-- 為什麼是維持現狀、而不是還原成快照裡的值:pre_operation_snapshot 是
-- 20260920170100_data_import_members_batch.sql 寫的,它只記錄了
-- name/phone/email/birthday/notes 五個欄位,「從來就沒有」tier_id,所以沒有「匯入前的等級」
-- 可以還原。而匯入流程本身也不會設定 tier_id(CSV 沒有等級欄位),所以「維持現狀」在語意上
-- 就等於「還原成匯入前的等級」,是正確的行為。
--
-- 這支 migration 完整重貼 rollback_bulk_operation 的最新定義(來源:20260920170400,
-- 之後沒有任何 migration 再改過它),唯一的差異就是 update_member 那一段多了一行
-- `v_member.tier_id`,其餘一字不改。
-- =========================================================================

create or replace function public.rollback_bulk_operation(p_operation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_op public.merchant_bulk_operations;
  v_restored int := 0;
  v_skipped int := 0;
  v_reasons jsonb := '[]'::jsonb;
  v_item record;
  v_member public.members;
  v_booking public.bookings;
  v_key text;
  v_val jsonb;
  v_member_id uuid;
  v_booking_id uuid;
  v_original_member_id uuid;
begin
  select * into v_op from public.merchant_bulk_operations where id = p_operation_id;
  if not found then
    raise exception '找不到這筆批次紀錄';
  end if;

  -- 規則 2.1(核心):只有(來源)商家管理員能操作復原。
  if not private.is_merchant_admin(v_op.merchant_id) then
    raise exception '批次匯入/資料搬遷，只有商家管理員可以操作' using errcode = '42501';
  end if;

  -- 規則 2.8 第 5 點:同一個批次只能復原一次。
  if v_op.status = 'rolled_back' then
    raise exception '這個批次已經復原過了';
  end if;

  if v_op.operation_type = 'member_import' then
    for v_item in
      select * from public.merchant_bulk_operation_items
      where operation_id = p_operation_id and entity_table = 'members'
    loop
      select * into v_member from public.members where id = v_item.entity_id;
      if not found then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'members', 'entity_id', v_item.entity_id,
          'reason', '這筆會員資料已經不存在，可能已被其他操作刪除'
        ));
        continue;
      end if;

      if v_item.action = 'created' then
        if v_member.updated_at <> v_member.created_at then
          v_skipped := v_skipped + 1;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'entity_table', 'members', 'entity_id', v_item.entity_id,
            'reason', '這位會員匯入後已被編輯過，無法自動復原，請手動確認處理'
          ));
          continue;
        end if;

        if exists (select 1 from public.bookings where member_id = v_member.id) then
          v_skipped := v_skipped + 1;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'entity_table', 'members', 'entity_id', v_item.entity_id,
            'reason', '這位會員匯入後已經被用在真實訂單上，無法自動復原，請手動確認處理'
          ));
          continue;
        end if;

        if exists (
          select 1 from public.member_point_transactions t
          where t.member_id = v_member.id
            and t.id not in (
              select i2.entity_id from public.merchant_bulk_operation_items i2
              where i2.operation_id = p_operation_id and i2.entity_table = 'member_point_transactions'
            )
        ) then
          v_skipped := v_skipped + 1;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'entity_table', 'members', 'entity_id', v_item.entity_id,
            'reason', '這位會員匯入後點數被異動過，無法自動復原，請手動確認處理'
          ));
          continue;
        end if;

        delete from public.members where id = v_member.id;
        v_restored := v_restored + 1;
      elsif v_item.action = 'updated' then
        if v_member.updated_at <> v_op.created_at then
          v_skipped := v_skipped + 1;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'entity_table', 'members', 'entity_id', v_item.entity_id,
            'reason', '這位會員匯入後又被編輯過，無法自動復原，請手動確認處理'
          ));
          continue;
        end if;

        v_val := v_op.pre_operation_snapshot -> 'members' -> v_member.id::text;
        if v_val is null then
          v_skipped := v_skipped + 1;
          v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
            'entity_table', 'members', 'entity_id', v_item.entity_id,
            'reason', '找不到這位會員的復原快照資料'
          ));
          continue;
        end if;

        -- 2026-09-24 修正(B1):update_member 自從 #615 之後是 7 個參數,第 7 個 p_tier_id
        -- 雖然有 default null,但函式內部是無條件 `tier_id = p_tier_id`,少傳就等於清空會員等級。
        -- v_member 是這一列「復原前的現況」(上面已經 select * into 過),直接沿用它的 tier_id,
        -- 讓復原只還原基本資料、不動會員等級(快照裡本來就沒有記錄 tier_id,理由見檔頭說明)。
        perform public.update_member(
          v_member.id,
          v_val->>'name',
          v_val->>'phone',
          v_val->>'email',
          nullif(v_val->>'birthday', '')::date,
          v_val->>'notes',
          v_member.tier_id
        );
        v_restored := v_restored + 1;
      end if;
    end loop;

  elsif v_op.operation_type = 'historical_booking_import' then
    for v_item in
      select * from public.merchant_bulk_operation_items
      where operation_id = p_operation_id and entity_table = 'bookings' and action = 'created'
    loop
      select * into v_booking from public.bookings where id = v_item.entity_id;
      if not found then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'bookings', 'entity_id', v_item.entity_id,
          'reason', '這筆訂單已經不存在，可能已被其他操作刪除'
        ));
        continue;
      end if;

      if v_booking.updated_at <> v_booking.created_at then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'bookings', 'entity_id', v_item.entity_id,
          'reason', '這筆歷史訂單匯入後被人工編輯過，無法自動復原，請手動確認處理'
        ));
        continue;
      end if;

      delete from public.bookings where id = v_booking.id;
      v_restored := v_restored + 1;
    end loop;

  elsif v_op.operation_type = 'industry_transfer_members' then
    for v_key, v_val in select * from jsonb_each(coalesce(v_op.pre_operation_snapshot -> 'members', '{}'::jsonb))
    loop
      v_member_id := v_key::uuid;
      select * into v_member from public.members where id = v_member_id;
      if not found then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'members', 'entity_id', v_member_id,
          'reason', '這筆會員資料已經不存在'
        ));
        continue;
      end if;

      if v_member.merchant_id <> v_op.related_merchant_id then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'members', 'entity_id', v_member_id,
          'reason', '這位會員搬遷後又被搬去了其他商家，無法自動復原，請手動確認處理'
        ));
        continue;
      end if;

      update public.members set merchant_id = (v_val->>'merchant_id')::uuid where id = v_member_id;
      update public.member_point_transactions set merchant_id = (v_val->>'merchant_id')::uuid where member_id = v_member_id;
      v_restored := v_restored + 1;
    end loop;

    for v_key, v_val in select * from jsonb_each(coalesce(v_op.pre_operation_snapshot -> 'bookings_member_id', '{}'::jsonb))
    loop
      v_booking_id := v_key::uuid;
      select * into v_booking from public.bookings where id = v_booking_id;
      if not found then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'bookings', 'entity_id', v_booking_id,
          'reason', '這筆訂單已經不存在'
        ));
        continue;
      end if;

      if v_booking.member_id is not null then
        v_skipped := v_skipped + 1;
        v_reasons := v_reasons || jsonb_build_array(jsonb_build_object(
          'entity_table', 'bookings', 'entity_id', v_booking_id,
          'reason', '這筆訂單的會員連結後來被重新指派過，無法自動復原，請手動確認處理'
        ));
        continue;
      end if;

      v_original_member_id := (v_val #>> '{}')::uuid;
      update public.bookings set member_id = v_original_member_id where id = v_booking_id;
      v_restored := v_restored + 1;
    end loop;
  end if;

  update public.merchant_bulk_operations
  set status = 'rolled_back', rolled_back_at = now(), rolled_back_by_user_id = auth.uid()
  where id = p_operation_id;

  return jsonb_build_object(
    'restored_count', v_restored,
    'skipped_count', v_skipped,
    'skipped_reasons', v_reasons
  );
end;
$$;

comment on function public.rollback_bulk_operation(uuid) is '模組 12 §3.5(核心，規則 2.8):依 operation_type 分派復原邏輯，每一筆要復原的資料執行前都先確認自從匯入/搬遷之後沒有被其他操作動過，不符合就跳過並記錄原因，不強行復原。同一個批次只能復原一次。2026-09-24 修正(B1):update_member 自從 #615 改成 7 個參數後,這裡仍然只傳 6 個,導致復原會員匯入時 p_tier_id 取到 default null,靜默把被復原會員的會員等級清成未分級;現在改成沿用該會員目前的 tier_id。';

revoke execute on function public.rollback_bulk_operation(uuid) from public, anon;
grant execute on function public.rollback_bulk_operation(uuid) to authenticated;
