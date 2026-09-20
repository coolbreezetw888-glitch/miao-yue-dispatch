-- 模組 12:資料匯入/報表匯出 — rollback_bulk_operation(第五支)。
-- 對應規格書 §2.7/§2.8(核心必測，本模組風險最高的一條)/§3.5。
--
-- 技術依據(見 20260920170100 開頭註解):同一批次的所有寫入都在同一個交易內完成，Postgres 的
-- now() 在同一交易內是常數，所以 merchant_bulk_operations.created_at 可以直接拿來跟
-- members/bookings 的 updated_at 比對，判斷「這筆資料是不是自從匯入之後就沒有被動過」。
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

        perform public.update_member(
          v_member.id,
          v_val->>'name',
          v_val->>'phone',
          v_val->>'email',
          nullif(v_val->>'birthday', '')::date,
          v_val->>'notes'
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

comment on function public.rollback_bulk_operation(uuid) is '模組 12 §3.5(核心，規則 2.8):依 operation_type 分派復原邏輯，每一筆要復原的資料執行前都先確認自從匯入/搬遷之後沒有被其他操作動過，不符合就跳過並記錄原因，不強行復原。同一個批次只能復原一次。';

revoke execute on function public.rollback_bulk_operation(uuid) from public, anon;
grant execute on function public.rollback_bulk_operation(uuid) to authenticated;
