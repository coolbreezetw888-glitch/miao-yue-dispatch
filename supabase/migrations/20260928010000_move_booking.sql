-- SPECS-INDEX #807 / #808 / #809 / #810(規格書 .project/specs/行事曆拖拉改時間與轉派.md §3.1、§六、§十一之〇)。
-- 行事曆拖拉專用的「移動預約」函式 public.move_booking。
--
-- =========================================================================
-- 【為什麼不用既有的 update_booking】
-- update_booking 有 24 個參數,做法是「整批刪掉三張關聯表再重寫」,呼叫端每次都必須把全部欄位
-- 重新帶齊(p_member_id 沒帶就把會員連結清空;料錢快照曾因此出過 B2 事故)。拖拉只需要改 2 個
-- 欄位(時間 / 主服務人員)或 1 個欄位(助手是誰),所以另開一支窄介面的 RPC:
--   - 只碰 bookings.staff_id / start_at / end_at / booking_assistants.staff_id
--   - 不重寫 booking_service_items / booking_material_costs,也不動 booking_assistants 的列數
--     (轉派助手是 update ... set staff_id,不是 delete+insert,保留 id / created_at)
--   - 驗證完全沿用 private.check_staff_booking_slot,不另寫一套衝突判斷
--
-- 【放 public schema 的理由】
-- PostgREST 只暴露 public(supabase/config.toml api.schemas),放 private 前端會拿到 PGRST202
-- 「找不到函式」—— 這正是 #805 推播從來沒成功過的事故原因。
--
-- =========================================================================
-- 【三種 mode 與使用者裁決(2026-09-27,§十一之〇)—— 前端 resolveMoveMode() 必須跟這裡一模一樣】
--
--   拖的是誰(p_dragged_staff_id 對照訂單)  拖到哪                              mode                 資料層動作
--   ------------------------------------  ---------------------------------  -------------------  ------------------------------------------
--   主服務人員(= bookings.staff_id)       同一欄、不同時間                     time                 update bookings set start_at, end_at
--   主服務人員                              別人的欄位、同一時間                 reassign_main        update bookings set staff_id
--   主服務人員                              別人的欄位 + 不同時間(斜拖,Q1=B)  reassign_main        兩個都改:staff_id + start_at/end_at
--   助手(∈ booking_assistants)            任何地方(Q2 使用者新規則)          reassign_assistant   只 update booking_assistants set staff_id,
--                                                                                                   p_target_start_at 完全忽略
--
--   Q1(斜拖)= B:人跟時間一起改;助手因為共用時間也跟著移,所以助手要用「新時段」再驗一次。
--   Q2(拖助手)= 使用者原話:「只是變換助手,不管時間改成怎樣,都只是把助手換人,原因是助手的時間
--       是跟著主服務人員走」⇒ 助手色塊的拖拉一律只解讀成「換一位助手」,時間維度完全忽略;
--       助手拖回自己那一欄 = 沒有任何改變 = 無操作(前端不打 RPC;後端收到就當「沒變動」擋下)。
--   Q3(拖到過去)= B:允許,前端跳確認框;後端不擋(跟編輯表單一致,整條檢查鏈本來就沒有 now() 比對)。
--   Q5(主轉派給既有助手)= A:擋下,提示先用編輯把助手改掉或改拖給其他人(避免同一人既是主又是副)。
--
-- 【衝突/休假/排班檢查誰負責】
--   一律呼叫 private.check_staff_booking_slot(p_exclude_booking_id = 這筆單自己),自動繼承:
--   整天請假(連 unlimited_backend_edit 都不能繞過)/ 跨日 / 營業時間 ∩ 每週時段 ∩ 單日例外 /
--   同時段其他預約(strict_conflict_check)/ 跨店同一支電話佔用。錯誤訊息沿用它的原文一字不改。
--     mode=time               → 主服務人員 × 新時段;每一位助手 × 新時段
--     mode=reassign_main      → 目標服務人員 × 新時段(時間沒變就是原時段);時間有變時每一位助手 × 新時段
--     mode=reassign_assistant → 目標服務人員 × 原時段
--
-- 【畫面過期偵測(#810)】
--   專案沒有 realtime,兩位管理員同時拖同一筆單,後到的那位 p_expected_start_at / p_expected_staff_id
--   會跟資料庫現況對不上 → errcode 40001,前端收到就重抓格線。用 is distinct from 比對。
--
-- 【回傳】
--   { mode, booking(整列), previous{start_at,end_at,staff_id,assistant_staff_id},
--     next{同上}, time_changed, staff_changed }
--   previous/next 給前端「復原」用:復原 = 用 next 當 expected、把 previous 當 target,再呼叫同一支
--   RPC 一次(所以復原也會重新跑完整檢查,不會把單塞回這幾秒內被別人佔走的時段)。
--   time_changed / staff_changed 是規格書回傳格式之外多給的兩個布林:Q1=B 之後「斜拖」會同時改人跟
--   時間,mode 只有三個值不夠表達「這次到底動了什麼」,前端 toast / changeSummary 要靠這兩個旗標。
--   assistant_staff_id 取這筆單「第一位」助手(依 created_at);schema 允許多位但正式庫每筆最多 1 位。
--
-- 【不做的事】
--   不呼叫任何通知函式(通知由前端 fire-and-forget,跟 update_booking 一致,§6.9)。
--   不改時長(end_at − start_at 永遠保留;custom_duration_* 不動)。
--   不新增/移除助手(只換人)。
-- =========================================================================

create or replace function public.move_booking(
  p_booking_id uuid,
  p_dragged_staff_id uuid,
  p_target_staff_id uuid,
  p_target_start_at timestamptz,
  p_expected_start_at timestamptz,
  p_expected_staff_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
  where id = p_booking_id;

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
    raise exception '這筆預約剛剛被其他人改過,畫面已重新整理,請再拖一次' using errcode = '40001';
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
    raise exception '找不到這位服務人員在這筆預約裡的角色,請重新整理';
  end if;

  -- 目標服務人員:必須是同一間商家、在職(§6.3,跟 validate_booking_selection 第 2/4 步一致)。
  select * into v_target
  from public.merchant_staff
  where id = p_target_staff_id
    and merchant_id = v_booking.merchant_id
    and status = 'active';

  if not found then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
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
      raise exception '放開的位置跟原本一樣,沒有需要變更的內容';
    end if;

    if v_staff_changed then
      -- Q5 = A:主轉派給「已經是本單助手」的人,擋下。
      if exists (
        select 1 from public.booking_assistants ba
        where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
      ) then
        raise exception '「%」已經是這筆預約的助手,請先用編輯把助手改掉,或改拖給其他人', v_target.name;
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
        raise exception '找不到這位服務人員,或這位服務人員已被移除';
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
          raise exception '找不到其中一位助手,或這位助手已被移除';
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
    where id = p_booking_id;

  else
    -- ---------------------------------------------------------------
    -- 助手色塊:只控制「誰是助手」(Q2 使用者裁決),p_target_start_at 完全忽略。
    -- ---------------------------------------------------------------
    v_mode := 'reassign_assistant';
    v_new_start := v_booking.start_at;
    v_new_end := v_booking.end_at;

    if v_target.id = p_dragged_staff_id then
      -- Q2 衍生邊界 1:助手拖回自己那一欄 = 換成自己 = 沒有任何改變。
      raise exception '放開的位置跟原本一樣,沒有需要變更的內容';
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
      raise exception '找不到這位服務人員在這筆預約裡的角色,請重新整理';
    end if;

    update public.bookings set
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id;

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
$$;

comment on function public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid) is
'行事曆拖拉專用的「移動預約」(SPECS-INDEX #807~#810,規格書 行事曆拖拉改時間與轉派.md §3.1/§六/§十一之〇)。三種 mode:time(主服務人員色塊在同一欄改時間 → update bookings.start_at/end_at,助手列不動但實際時段跟著走)、reassign_main(主服務人員色塊拖到別人的欄位 → update bookings.staff_id,助手名單不變)、reassign_assistant(助手色塊拖到別人的欄位 → update booking_assistants.staff_id,不是 delete+insert)。使用者裁決(2026-09-27):Q1 斜拖 = B「人跟時間一起改」→ mode 仍是 reassign_main 但 staff_id 與 start_at/end_at 同時更新、time_changed=true,助手要用新時段再驗一次;Q2 拖助手 = 一律只換助手、p_target_start_at 完全忽略(助手的時間跟著主服務人員走),助手拖回自己欄位視為沒有變動而擋下;Q3 拖到過去 = 允許(後端不擋,前端跳確認框);Q5 主轉派給既有助手 = A 擋下。時長(end_at−start_at)永遠不變。所有衝突/休假/排班/跨日/跨店檢查一律呼叫 private.check_staff_booking_slot(p_exclude_booking_id=這筆單),錯誤訊息沿用原文。p_expected_start_at/p_expected_staff_id 跟現況不符 → 40001(畫面過期)。回傳 {mode, booking, previous, next, time_changed, staff_changed},previous/next 給前端復原用(復原=反向再呼叫一次,會重新驗證)。不呼叫任何通知函式,不動 booking_service_items/booking_material_costs。';

-- supabase-permission-hygiene 規則 1:新函式會自動繼承 PUBLIC EXECUTE,一定要明寫 revoke。
-- 這支的設計對象就是「已登入的商家管理員 / 有 orders 權限的客服」(函式第一件事就是
-- can_manage_bookings 檢查),所以 grant 給 authenticated 是刻意的,跟 update_booking 的既有慣例一致;
-- anon / PUBLIC 一律收掉。
revoke execute on function public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid) from public, anon;
grant  execute on function public.move_booking(uuid, uuid, uuid, timestamptz, timestamptz, uuid) to authenticated;
