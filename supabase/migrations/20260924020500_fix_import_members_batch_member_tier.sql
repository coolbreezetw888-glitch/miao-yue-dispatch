-- 深夜自主巡檢批次(2026-09-24)B3:import_members_batch 在 upsert_by_phone 模式下呼叫
-- update_member 時少傳第 7 個參數,每一次匯入都會靜默清掉既有會員的會員等級(tier_id)。
--
-- =========================================================================
-- 【問題】
-- 這是跟 B1(20260924020300)完全同源的一個 bug,但影響更大:B1 只發生在「按下復原」的時候,
-- 這一支是「每一次 upsert_by_phone 匯入」都會發生。
--
-- public.update_member 在 20260923010300_req615_618_member_core_functions_rewrite.sql 被
-- drop + create 改成 7 個參數,第 7 個 p_tier_id 雖然有 `default null`,但函式內部是無條件
-- `update public.members set ... tier_id = p_tier_id`——少傳就等於把會員等級清成未分級。
-- import_members_batch 是在 p_tier_id 這個參數存在之前寫的,只傳 6 個參數。
--
-- 【錯誤情境】
--   1. 商家已經把幾位熟客標成「VIP」等級。
--   2. 之後商家拿一份新的名單 CSV,用 upsert_by_phone 模式匯入(這個模式的本意是
--      「電話已存在就更新既有會員的基本資料」)。
--   3. CSV 裡根本沒有「會員等級」這個欄位(匯入格式本來就不支援指定等級),
--      但凡是電話對上的既有會員,等級全部被清成「未分級」。
--   4. 匯入結果只會回報 success_rows,完全不會提到等級被清掉這件事。
--
-- 【修法】
-- 補傳第 7 個參數。函式裡本來就已經先 `select * into v_old_member from public.members
-- where id = v_existing_member_id`(更新前的那一列),直接沿用 v_old_member.tier_id——
-- 語意是「匯入只更新 CSV 有帶的基本資料欄位,不動會員等級」,這正是 upsert 匯入該有的行為。
--
-- 【為什麼沒有一併把 tier_id 記進 pre_operation_snapshot】
-- 這支修好之後,匯入流程本身就不再改動 tier_id 了,所以「匯入前的等級」永遠等於
-- 「匯入後的等級」,把它記進快照是多餘的資訊;而 B1(20260924020300)的復原邏輯採用的
-- 正是「沿用該會員目前的 tier_id」,結果完全一致。
-- 相對的,動快照格式要付出真實代價:正式環境已經存在的 merchant_bulk_operations 紀錄
-- 全部是舊的五欄格式(name/phone/email/birthday/notes),一旦 rollback 改成讀快照裡的
-- tier_id,那些舊紀錄會讀到 SQL NULL,反而把等級清空——等於製造一個新的、更難發現的 bug。
-- 綜合評估後刻意不動快照格式,維持原本的五個欄位。
--
-- 這支 migration 完整重貼 import_members_batch 的最新定義(來源:20260920170100,
-- 之後沒有任何 migration 再改過它),唯一的差異就是 update_member 那一行多了
-- `v_old_member.tier_id`,其餘一字不改。
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

comment on function public.import_members_batch(uuid, text, jsonb) is '模組 12 §3.1(核心):批次匯入會員，逐列呼叫既有的 create_member/update_member/adjust_member_points(規則 2.2/2.5/2.6，完全不直接寫入 members/member_point_transactions)，單一列失敗不影響其他列，只有商家管理員可以呼叫(規則 2.1)。2026-09-24 修正(B3):update_member 自從 #615 改成 7 個參數後,這裡仍然只傳 6 個,導致 upsert_by_phone 模式下每一次匯入都把電話對上的既有會員的會員等級靜默清成未分級;現在改成沿用該會員更新前的 tier_id。';

revoke execute on function public.import_members_batch(uuid, text, jsonb) from public, anon;
grant execute on function public.import_members_batch(uuid, text, jsonb) to authenticated;
