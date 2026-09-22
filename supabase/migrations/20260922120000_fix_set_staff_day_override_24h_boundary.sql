-- 模組 14(服務人員端)v2 §10.3.1:「整天排休」需要呼叫既有的
-- set_staff_day_override(staff_id, date, '00:00', '24:00', false) 涵蓋當天全部 48 個半小時格。
--
-- 動工前依規格書要求先用 execute_sql 實測這個既有函式從未驗證過的邊界輸入,結果發現一個真正的
-- bug(不是規格書假設的「可能沒問題」,是實測證實會出問題):
--   PostgreSQL 的 time 型別加法是「一天之內取模」運算——'23:30:00'::time + interval '30 minutes'
--   算出來是 '00:00:00'(回捲到當天開始),不是 '24:00:00'。
--   原本的迴圈寫法 `v_slot := p_start_time; while v_slot < p_end_time loop ... v_slot := v_slot +
--   interval '30 minutes'; end loop;` 只要 p_end_time = '24:00:00',v_slot 跑到 23:30 那一格
--   之後永遠回捲到 00:00,而 00:00 < 24:00:00 恆為真,造成無限迴圈(實測用 DO 區塊 + 遞迴 CTE
--   都證實這個迴圈永遠不會自然結束,不管 p_start_time 是多少)。
--
-- 規格書原本預期的兩個退回方案(前端分兩次呼叫涵蓋 00:00~23:30 + 23:30~24:00,或展開成 48 次
-- 個別呼叫)實際上都無法迴避這個 bug——因為「涵蓋到 24:00:00 的最後一格」這件事,不管拆成多少次
-- 呼叫,最後一次呼叫的 p_end_time 終究得是 '24:00:00',一樣會踩到同一個無限迴圈。這不是前端呼叫
-- 方式能繞過的問題,是既有函式内部迴圈邏輯本身的 bug,所以這裡改成從根本修正:把迴圈索引從
-- 「time 型別逐格相加」改成「當日分鐘數(整數)逐格相加」,00:00~24:00 换算成 0~1440 分鐘,
-- 用整數比較不會有時間型別在日界的回捲問題,最後一格(1410~1440,也就是 23:30~24:00)可以正確
-- 迴圈到、也能正確結束。
--
-- 除了迴圈索引的型別,函式簽章、既有的商家管理員/自助權限檢查、時間對齊驗證、既有預約衝突回報
-- 邏輯完全不變,對所有既有的正常呼叫(p_end_time 不是 24:00:00 的情況)行為完全一致。
--
-- 動工前已用 execute_sql 查證正式環境這支函式目前的完整最新定義(疊加自助分支後的版本,
-- 20260921110000_staff_portal_availability_overlay.sql 那一版),這次在那個基礎上疊加,不是從
-- 規格書描述的舊版本重建。

create or replace function public.set_staff_day_override(
  p_staff_id uuid,
  p_override_date date,
  p_start_time time,
  p_end_time time,
  p_is_available boolean
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_start_minutes int;
  v_end_minutes int;
  v_slot_minutes int;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_conflict_count int;
begin
  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  if not (private.can_manage_business_hours(v_merchant_id) or private.can_self_manage_availability(p_staff_id)) then
    raise exception '沒有權限設定這位服務人員的可預約狀態' using errcode = '42501';
  end if;

  if p_is_available is null then
    raise exception '請指定這個時段要開啟還是關閉';
  end if;

  if extract(minute from p_start_time)::int not in (0, 30) or extract(second from p_start_time) <> 0 then
    raise exception '開始時間必須對齊半小時格線(例如 14:00 或 14:30)';
  end if;
  if extract(minute from p_end_time)::int not in (0, 30) or extract(second from p_end_time) <> 0 then
    raise exception '結束時間必須對齊半小時格線(例如 14:00 或 14:30)';
  end if;
  if p_end_time <= p_start_time then
    raise exception '結束時間必須晚於開始時間';
  end if;

  -- 修正重點:改用「當日分鐘數」整數逐格相加,不用 time 型別直接相加——time 型別在跨過
  -- 24:00:00(=一天結束的邊界值)時會回捲成 00:00:00,導致迴圈永遠無法結束(見檔頭說明)。
  -- extract(hour from '24:00:00'::time) = 24,所以 v_end_minutes 在這個邊界值下正確等於 1440,
  -- 迴圈跑到 v_slot_minutes = 1410(23:30)那一格插入後,下一輪 v_slot_minutes = 1440,
  -- 1440 < 1440 為假,正確結束,不會回捲。
  v_start_minutes := extract(hour from p_start_time)::int * 60 + extract(minute from p_start_time)::int;
  v_end_minutes := extract(hour from p_end_time)::int * 60 + extract(minute from p_end_time)::int;

  v_slot_minutes := v_start_minutes;
  while v_slot_minutes < v_end_minutes loop
    insert into public.staff_availability_overrides (staff_id, override_date, slot_start_time, is_available)
    values (
      p_staff_id,
      p_override_date,
      make_time((v_slot_minutes / 60) % 24, v_slot_minutes % 60, 0),
      p_is_available
    )
    on conflict (staff_id, override_date, slot_start_time)
    do update set is_available = excluded.is_available, updated_at = now();
    v_slot_minutes := v_slot_minutes + 30;
  end loop;

  if p_is_available then
    v_conflict_count := 0;
  else
    -- 這裡的 `date::timestamp + time` 運算(不同於迴圈索引用的 time+interval 逐格相加)
    -- 已實測確認 PostgreSQL 對 p_end_time='24:00:00' 這個邊界值會正確算出「隔天 00:00:00」,
    -- 不會有迴圈那種回捲問題,所以這兩行維持原樣不動,不需要跟著改成分鐘數運算。
    v_range_start := (p_override_date::timestamp + p_start_time) at time zone 'Asia/Taipei';
    v_range_end := (p_override_date::timestamp + p_end_time) at time zone 'Asia/Taipei';

    select count(*) into v_conflict_count
    from (
      select b.id
      from public.bookings b
      where b.staff_id = p_staff_id
        and b.status <> 'cancelled'
        and b.start_at < v_range_end
        and b.end_at > v_range_start
      union
      select b.id
      from public.booking_assistants ba
      join public.bookings b on b.id = ba.booking_id
      where ba.staff_id = p_staff_id
        and b.status <> 'cancelled'
        and b.start_at < v_range_end
        and b.end_at > v_range_start
    ) x;
  end if;

  return v_conflict_count;
end;
$function$;

comment on function public.set_staff_day_override(uuid, date, time, time, boolean) is '模組 6/14:設定服務人員某一天某段時間的可預約狀態(單日例外),半小時對齊。模組 14 v2 §10.3.1 修正:迴圈索引改用當日分鐘數整數運算,修正 p_end_time=24:00:00(整天排休邊界值)導致的無限迴圈 bug。權限:商家管理員/客服(can_manage_business_hours)或本人自助(can_self_manage_availability,僅按件計酬且已開通權限)。回傳這段時間現有的既有預約衝突筆數(不自動取消)。';
