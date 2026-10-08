-- 客戶端第 4-A 批(模組 13)— migration 4:move_booking、update_booking_payment_method 並發修正
-- (主腦 2026-10-09 裁決:比照 20261010100200 confirm_booking 的做法;另開一支 migration,不併入 100200 ——
--  100200 已套進本機資料庫、主腦也已核對過它的指紋,分開比較好追蹤、要單獨復原也容易)
--
-- 問題:兩支都會先檢查「只有待確認 / 已確認可以改」,但讀取訂單沒有 for update、UPDATE 只有 where id = …。
--   客人(或後台)剛把單取消的同時,店家拖拉改時間 / 改付款方式 ⇒ 讀到舊狀態、通過檢查,等前一個交易提交後
--   照樣改到這張已取消的單(狀態不會被改回,但會留下「已取消的單被改過」;拖拉還會觸發行事曆即時同步)。
--
-- 每支只改這幾處(其餘逐字保留;錯誤訊息、errcode、簽章、權限、comment 都不變):
--   ① 讀取訂單加 for update(鎖順序 訂單 → …,跟 cancel_booking / update_booking 一致);
--      等鎖之後讀到最新狀態 ⇒ 已取消 / 已完成走原本的錯誤路徑。
--   ② UPDATE bookings 的 where 加 status in ('pending_confirmation', 'accepted') 當保險。
--   ③ 保險萬一沒更新到 ⇒ 用原本同一句錯誤訊息擋下(整筆交易回滾)。
--   move_booking 有兩個 UPDATE bookings(主服務人員色塊 / 助手色塊),兩個都加。
-- create or replace 不換簽章 ⇒ ACL(postgres / authenticated / service_role)與 comment 保留。

-- ─── public.move_booking ───
CREATE OR REPLACE FUNCTION public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
  v_target public.merchant_staff;
  v_main public.merchant_staff;
  v_assistant public.merchant_staff;
  v_dragged_role text;
  v_mode text;
  v_duration interval;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_time_changed boolean := false;
  v_staff_changed boolean := false;
  v_prev_assistant_staff_id uuid;
  v_next_assistant_staff_id uuid;
  v_updated_rows integer;
  v_result public.bookings;
begin
  -- [a] 讀訂單 → 權限 → 狀態(順序跟 update_booking 完全一致)。
  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_booking.merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_booking.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能移動';
  end if;

  -- [b] 畫面過期偵測(#810):前端「拖之前」看到的值跟資料庫現況不符,代表別人剛改過這筆單。
  --     用 is distinct from(§6.6),即使哪天 staff_id 允許 null 也不會誤判。
  if v_booking.start_at is distinct from p_expected_start_at
     or v_booking.staff_id is distinct from p_expected_staff_id then
    raise exception '這筆預約剛剛被其他人改過，畫面已重新整理，請再拖一次' using errcode = '40001';
  end if;

  -- [c] 判定被拖的那顆色塊是主還是助手。
  if p_dragged_staff_id is not null and p_dragged_staff_id = v_booking.staff_id then
    v_dragged_role := 'main';
  elsif exists (
    select 1 from public.booking_assistants ba
    where ba.booking_id = p_booking_id and ba.staff_id = p_dragged_staff_id
  ) then
    v_dragged_role := 'assistant';
  else
    raise exception '找不到這位服務人員在這筆預約裡的角色，請重新整理';
  end if;

  -- 目標服務人員:必須是同一間商家、在職(§6.3,跟 validate_booking_selection 第 2/4 步一致)。
  select * into v_target
  from public.merchant_staff
  where id = p_target_staff_id
    and merchant_id = v_booking.merchant_id
    and status = 'active';

  if not found then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  -- 復原/回傳用:這筆單目前的(第一位)助手。
  select ba.staff_id into v_prev_assistant_staff_id
  from public.booking_assistants ba
  where ba.booking_id = p_booking_id
  order by ba.created_at, ba.id
  limit 1;
  v_next_assistant_staff_id := v_prev_assistant_staff_id;

  -- [e] 時長永遠不變。
  v_duration := v_booking.end_at - v_booking.start_at;

  if v_dragged_role = 'main' then
    -- ---------------------------------------------------------------
    -- 主服務人員色塊:控制「時間 + 主服務人員」。
    -- ---------------------------------------------------------------
    if p_target_start_at is null then
      raise exception '請指定要移動到的時間';
    end if;

    -- §6.7:秒/毫秒截掉再用,不依賴前端吸附。
    v_new_start := date_trunc('minute', p_target_start_at);
    v_new_end := v_new_start + v_duration;

    v_time_changed := v_new_start is distinct from v_booking.start_at;
    v_staff_changed := v_target.id <> v_booking.staff_id;

    if not v_time_changed and not v_staff_changed then
      -- 5.8:前端遇到「跟原本完全一樣」不會打 RPC;後端收到就當作沒有需要變更的內容擋下,
      -- 避免寫入一筆「沒變」的更新(還會讓前端多送一則推播)。
      raise exception '放開的位置跟原本一樣，沒有需要變更的內容';
    end if;

    if v_staff_changed then
      -- Q5 = A:主轉派給「已經是本單助手」的人,擋下。
      if exists (
        select 1 from public.booking_assistants ba
        where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
      ) then
        raise exception '「%」已經是這筆預約的助手，請先用編輯把助手改掉，或改拖給其他人', v_target.name;
      end if;

      v_mode := 'reassign_main';

      -- 規則 2 / Q1=B:目標服務人員 × 新時段(時間沒變就是原時段)。
      perform private.check_staff_booking_slot(
        v_booking.merchant_id, v_target, v_new_start, v_new_end, p_booking_id, '主要服務人員'
      );
    else
      v_mode := 'time';

      -- 規則 1:主服務人員本人 × 新時段(本人也要在職,跟 validate_booking_selection 第 2 步一致)。
      select * into v_main
      from public.merchant_staff
      where id = v_booking.staff_id
        and merchant_id = v_booking.merchant_id
        and status = 'active';

      if not found then
        raise exception '找不到這位服務人員，或這位服務人員已被移除';
      end if;

      perform private.check_staff_booking_slot(
        v_booking.merchant_id, v_main, v_new_start, v_new_end, p_booking_id, '主要服務人員'
      );
    end if;

    -- 規則 1「須檢測」+ Q1=B 衍生邊界 3:只要時間有變,每一位助手都要用新時段再驗一次
    -- (助手沒有自己的時間欄位,實際時段跟著主單走)。
    if v_time_changed then
      for v_assistant in
        select ms.*
        from public.booking_assistants ba
        join public.merchant_staff ms on ms.id = ba.staff_id
        where ba.booking_id = p_booking_id
        order by ba.created_at, ba.id
      loop
        if v_assistant.status <> 'active' or v_assistant.merchant_id <> v_booking.merchant_id then
          raise exception '找不到其中一位助手，或這位助手已被移除';
        end if;

        perform private.check_staff_booking_slot(
          v_booking.merchant_id, v_assistant, v_new_start, v_new_end, p_booking_id,
          format('助手「%s」', v_assistant.name)
        );
      end loop;
    end if;

    -- [g] 寫入(同一個交易;任何 raise 都會整筆回滾)。
    update public.bookings set
      staff_id = v_target.id,
      start_at = v_new_start,
      end_at = v_new_end,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id
      and status in ('pending_confirmation', 'accepted');

    if not found then
      raise exception '已完成或已取消的預約不能移動';
    end if;

  else
    -- ---------------------------------------------------------------
    -- 助手色塊:只控制「誰是助手」(Q2 使用者裁決),p_target_start_at 完全忽略。
    -- ---------------------------------------------------------------
    v_mode := 'reassign_assistant';
    v_new_start := v_booking.start_at;
    v_new_end := v_booking.end_at;

    if v_target.id = p_dragged_staff_id then
      -- Q2 衍生邊界 1:助手拖回自己那一欄 = 換成自己 = 沒有任何改變。
      raise exception '放開的位置跟原本一樣，沒有需要變更的內容';
    end if;

    if v_target.id = v_booking.staff_id
       or exists (
         select 1 from public.booking_assistants ba
         where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
       ) then
      raise exception '這位服務人員已經在這筆預約裡了';
    end if;

    -- 規則 3:目標服務人員 × 原時段。
    perform private.check_staff_booking_slot(
      v_booking.merchant_id, v_target, v_booking.start_at, v_booking.end_at, p_booking_id,
      format('助手「%s」', v_target.name)
    );

    -- §6.1:update ... set staff_id,不是 delete+insert(保留 id / created_at,列數不變)。
    update public.booking_assistants
    set staff_id = v_target.id
    where booking_id = p_booking_id
      and staff_id = p_dragged_staff_id;

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows <> 1 then
      raise exception '找不到這位服務人員在這筆預約裡的角色，請重新整理';
    end if;

    update public.bookings set
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id
      and status in ('pending_confirmation', 'accepted');

    if not found then
      raise exception '已完成或已取消的預約不能移動';
    end if;

    v_prev_assistant_staff_id := p_dragged_staff_id;
    v_next_assistant_staff_id := v_target.id;
    v_staff_changed := true;
  end if;

  -- [h] 回傳。
  select * into v_result from public.bookings where id = p_booking_id;

  return jsonb_build_object(
    'mode', v_mode,
    'booking', to_jsonb(v_result),
    'previous', jsonb_build_object(
      'start_at', v_booking.start_at,
      'end_at', v_booking.end_at,
      'staff_id', v_booking.staff_id,
      'assistant_staff_id', v_prev_assistant_staff_id
    ),
    'next', jsonb_build_object(
      'start_at', v_result.start_at,
      'end_at', v_result.end_at,
      'staff_id', v_result.staff_id,
      'assistant_staff_id', v_next_assistant_staff_id
    ),
    'time_changed', v_time_changed,
    'staff_changed', v_staff_changed
  );
end;
$function$;

-- ─── public.update_booking_payment_method ───
CREATE OR REPLACE FUNCTION public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_payment_method_name text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  if p_payment_method_id is not null then
    -- 修正(2026-09-19,主腦複查):如果這個 payment_method_id 剛好就是這筆訂單目前已存的值,
    -- 沿用既有快照文字,不重新查詢目前名稱(理由同 private.validate_booking_selection)。
    select payment_method_name_snapshot into v_payment_method_name
    from public.bookings
    where id = p_booking_id and payment_method_id = p_payment_method_id;

    if v_payment_method_name is null then
      -- 跟 private.validate_booking_selection 同樣的放行邏輯:status='active',或是這筆訂單本來
      -- 就已經是這個值(不強制因為商家事後下架而擋下「沒有真的要換」的操作)。
      select name into v_payment_method_name
      from public.payment_methods
      where id = p_payment_method_id
        and merchant_id = v_merchant_id
        and (
          status = 'active'
          or exists (
            select 1 from public.bookings
            where id = p_booking_id and payment_method_id = p_payment_method_id
          )
        );

      if not found then
        raise exception '找不到這個付款方式，或已下架';
      end if;
    end if;
  else
    v_payment_method_name := null;
  end if;

  update public.bookings
  set payment_method_id = p_payment_method_id,
      payment_method_name_snapshot = v_payment_method_name,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
    and status in ('pending_confirmation', 'accepted')
  returning * into v_result;

  if not found then
    raise exception '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：%)', (select status from public.bookings where id = p_booking_id);
  end if;

  return v_result;
end;
$function$;
