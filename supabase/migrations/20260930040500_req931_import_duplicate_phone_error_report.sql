-- SPECS-INDEX #931 收尾修正(2026-10-01,品管驗收打回):CSV 匯入遇到重複電話時,商家要看得到
-- 「是哪一列、跟哪一位既有會員撞、那個人叫什麼名字」,不能只有一個「略過(重複) 1」的數字。
--
-- ─── 為什麼要有這一支 migration ────────────────────────────────────────────────
-- 20260930040200(#931)在 create_member / update_member 裡加了「這支電話已經有會員:某某某」
-- 這句白話訊息,而且那兩支函式的 comment 原本都寫著「CSV 匯入自動同步套用這條規則(該列會算
-- failed 並把這段白話訊息寫進 error_report)」。
-- 🔴 那句話**經品管實測為假**:import_members_batch 在 insert_only 模式下,是先自己用
--    private.normalize_phone 查一次既有會員,查到就**直接算 skipped、不呼叫 create_member**
--    (20260928040000 那一版的「規則 2.5.1」分支)⇒ create_member 裡新加的那句訊息,從匯入
--    這條路徑永遠走不到。而 insert_only 是匯入精靈的**預設**寫入模式,所以這不是邊角路徑。
--    結果:那一列既不算成功也不算失敗,error_report 一個字都沒有,商家只看到略過的筆數。
--
-- ─── 這次做的事(只有三件,刻意不多做)────────────────────────────────────────────
-- 1. import_members_batch 的 insert_only 略過分支,**額外**往 error_report 寫一筆
--    {row_number, raw_data, error_message},訊息指名撞到的既有會員姓名,並說明「已略過、沒有
--    新建也沒有修改既有資料」以及三種處理方式。
-- 2. **計數語意一個字都不改**:那一列仍然算 skipped_duplicate_rows,不改算 failed。理由寫在
--    函式內那段註解裡(結果頁三格數字 + 匯入紀錄頁 + 既有 pgTAP 斷言都吃這三個計數)。
-- 3. 把 import_members_batch 自己的 comment 補上這個行為。
--    ⚠️ create_member / update_member 那兩句**宣稱匯入會算 failed** 的假 comment,直接在
--    20260930040200 那支還沒上線的 migration 裡就地改掉(同一批未上線的東西,不需要為了改
--    一句註解再多開一支 migration)。
--
-- ─── 刻意不做 ─────────────────────────────────────────────────────────────────
-- ・不動 import_historical_bookings_batch 一個字(它沒有「電話重複略過」這個概念)。
-- ・不動 create_member / update_member / private.normalize_phone / is_valid_taiwan_phone 的本體。
-- ・不改前端:error_report 沿用既有結構,結果頁與匯入紀錄頁本來就會把它逐列印出來。
--   📌 已回報主腦:結果頁那塊區塊的標題目前寫「失敗清單」、按鈕寫「下載失敗清單 CSV」,現在
--      裡面會多出「已略過」的列。訊息本身有講清楚,但標題用字要不要跟著調整(例如改成「需要
--      處理的列」)屬於前端文案決策,不在這次打回的六項範圍內,留給主腦裁決。
-- ・沒有任何 UPDATE / DELETE,不動任何存量資料。
--
-- 函式其餘內容**逐字沿用** 20260928040000_import_phone_validation.sql 的版本(簽章不變 ⇒
-- create or replace,不 drop;revoke/grant 照慣例整組重新宣告,supabase-permission-hygiene 規則 1)。

-- =========================================================================
-- import_members_batch:逐字沿用 20260928040000,只在 insert_only 的「重複略過」分支補訊息。
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
  -- SPECS-INDEX #931 收尾(2026-10-01):略過重複電話那一列時,要把「跟誰撞」的姓名寫進 error_report。
  v_conflict_name text;
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

        -- SPECS-INDEX #931 收尾(2026-10-01,品管實測打回):**略過也要留話**。
        -- 之前這個分支只把 v_skipped_rows 加一就結束 ⇒ 那一列既不算成功也不算失敗,error_report
        -- 裡一個字都沒有,商家在結果頁只看到「略過(重複) 1」,永遠不知道是哪一列、跟誰撞、
        -- 那個人叫什麼名字。使用者對 #931 的原話是「要擋下來並指名是誰…不能只說失敗」,
        -- 而這條路徑連「失敗」都沒說。而 insert_only 是匯入精靈的**預設**模式,所以這是常態路徑。
        --
        -- 🔴 為什麼不改成算 failed:success / failed / skipped_duplicate_rows 三個計數的語意是既有的
        --    (結果頁那三格數字、匯入紀錄頁、以及既有的 pgTAP 斷言都吃它們),把略過改成失敗會連帶
        --    改掉畫面與既有測試的期望值。使用者要的是「看得見訊息」,不是「改變計數」⇒ 維持 skipped,
        --    只是**額外**在 error_report 留一筆指名訊息。
        -- 📌 error_report 是 jsonb 陣列、每一筆是 {row_number, raw_data, error_message},前端固定渲染
        --    成「第 N 列:<error_message>」⇒ 沿用同一個結構就自動顯示得出來,不需要動前端一個字。
        --    訊息本身明寫「已略過、沒有新建也沒有修改既有資料」,所以就算它出現在結果頁那塊標題
        --    寫「失敗清單」的區塊裡,商家讀完也不會誤會這一列被寫壞了。
        -- 📌 為什麼不能靠 create_member 內建的 #931 檢查:這個分支在呼叫 create_member **之前**就先
        --    短路了,create_member 那句「這支電話已經有會員:某某某」從匯入這條路徑走不到。
        select m.name into v_conflict_name from public.members m where m.id = v_existing_member_id;
        v_error_report := v_error_report || jsonb_build_array(jsonb_build_object(
          'row_number', v_row_number,
          'raw_data', v_row,
          'error_message', format(
            '這支電話已經有會員:%s —— 這一列已略過,沒有新建,也沒有修改這位既有會員的任何資料。同一間商家底下,一支電話只能有一位會員:如果就是同一位客戶,請把這一列從 CSV 裡移除;如果你本來就是想更新這位既有會員的資料,請改用「電話重複時更新既有會員資料」這個寫入模式重新匯入;如果真的是不同的人,請改填另一支電話',
            v_conflict_name)
        ));
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

comment on function public.import_members_batch(uuid, text, jsonb) is '模組 12 §3.1(核心):批次匯入會員，逐列呼叫既有的 create_member/update_member/adjust_member_points(規則 2.2/2.5/2.6，完全不直接寫入 members/member_point_transactions)，單一列失敗不影響其他列，只有商家管理員可以呼叫(規則 2.1)。2026-09-24 修正(B3):update_member 自從 #615 改成 7 個參數後,這裡仍然只傳 6 個,導致 upsert_by_phone 模式下每一次匯入都把電話對上的既有會員的會員等級靜默清成未分級;現在改成沿用該會員更新前的 tier_id。SPECS-INDEX #824(2026-09-28):「電話」欄位有填時套用 #822 的格式規則(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機),不合格的那一列算 failed 並寫進 error_report(白話中文,含這一列填的值與正確格式範例),其他列照常匯入;留空維持合法;檢查在「用電話找既有會員」之前,不合格的電話不會被當成重複略過。SPECS-INDEX #931 收尾(2026-10-01,品管實測打回):insert_only 模式(匯入精靈的預設模式)遇到這支電話已經有 active 會員時,**除了**照舊算 skipped_duplicate_rows,**額外**往 error_report 寫一筆指名訊息「這支電話已經有會員:某某某 —— 這一列已略過,沒有新建也沒有修改這位既有會員的任何資料…」,讓商家在結果頁看得到是哪一列、跟哪一位撞。🔴 那一列**仍然算 skipped、不算 failed**(三個計數的語意是既有的,畫面與既有 pgTAP 斷言都吃它);使用者要的是「看得見訊息」而不是「改變計數」。🔴 也要知道:這個分支在呼叫 create_member **之前**就短路了,所以 create_member 裡 #931 那句同樣的白話訊息從匯入這條路徑走不到 —— 匯入的訊息是這裡自己寫的,不是從 create_member 繼承來的。';

revoke execute on function public.import_members_batch(uuid, text, jsonb) from public, anon;
grant execute on function public.import_members_batch(uuid, text, jsonb) to authenticated;
