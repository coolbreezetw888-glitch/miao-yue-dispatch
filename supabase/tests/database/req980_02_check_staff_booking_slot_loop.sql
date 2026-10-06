-- SPECS-INDEX #980 QA 打回:private.check_staff_booking_slot 的無限迴圈修正 — pgTAP
-- migration 20261006110000_req980_fix_check_staff_booking_slot_loop.sql
--
-- 原本逐格迴圈用 time 型別 +30 分鐘,結束時間落在 23:30~24:00(不含兩端)時 23:30+30 分繞回 00:00 ⇒ 無限迴圈。
-- 這支用 statement_timeout = 3 秒:任何一條卡住就會變成錯誤(整支測試轉紅),不會真的一直等。
--
--   ①~④ 非 30 倍數工時(45、100、自訂 20、40 分鐘)、結束落在 23:30~24:00:短時間內回傳「放行」
--   ⑤   一般判斷照舊:超出每週時段的照樣擋
--   ⑥   無時段限制(unlimited_backend_edit)的服務人員 23:00 起 40 分鐘:放行
--   ⑦~⑧ 會跨到隔天的照舊擋下
--   ⑨   list_staff_bookable_start_times 45 分鐘工時:00:00~23:00 共 47 個起點(23:30 起會跨日)
--   ⑩~⑪ 回歸:新函式與改前版本(這裡用 pg_temp 逐字複製一份原版)的放行 / 擋下結果逐一相同
--   ⑫~⑲ 起點不在整點 / 半點(主腦追加第 3 點):整段預約必須落在可約範圍內;單日排休 / 單日開啟用半小時格線比對
--         ⑫、⑰ 同時斷言「改前版本」的結果,把原本的誤判寫成紀錄(⑫ 原本誤放行、⑰ 原本誤擋)
--
-- 故障注入(engineer 已做,見回報):把迴圈改回 time 型別 ⇒ 因逾時整支轉紅
begin;

-- ─── SPECS-INDEX #977(2026-10-06,第 3 批)測試墊片:no_time_slot_limit 不再影響後台 ───────────────
-- 「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶線上預約,後台建單 / 改單 / 行事曆一律不看它
-- (migration 20261006130200)。這支測試的 fixture 原本用 no_time_slot_limit=true 代表「這位服務人員不用另外
-- 布置每週時段,只受商家營業時間限制」——那是情境布置的捷徑,不是這支測試要驗的主題。
-- 為了讓原本的情境一字不差地成立,這裡在本交易內暫時掛一個 trigger:no_time_slot_limit=true 的服務人員
-- 自動補上 7 天 00:00–24:00 的每週時段(= 改前「只受營業時間限制」的效果);改回 false 時拿掉這幾列。
-- 整支測試結束 rollback,不留任何東西。新行為本身由 req977_01 驗證(那支不掛這個墊片)。
create function pg_temp.req977_full_day_windows()
returns trigger
language plpgsql
security definer
set search_path = public
as $req977$
begin
  if new.no_time_slot_limit then
    insert into public.staff_availability_windows (staff_id, day_of_week, start_time, end_time)
    select new.id, d::smallint, '00:00'::time, '24:00'::time
    from generate_series(0, 6) d
    on conflict (staff_id, day_of_week, start_time, end_time) do nothing;
  elsif tg_op = 'UPDATE' and old.no_time_slot_limit then
    delete from public.staff_availability_windows
    where staff_id = new.id and start_time = '00:00'::time and end_time = '24:00'::time;
  end if;
  return new;
end;
$req977$;

create trigger req977_full_day_windows
  after insert or update of no_time_slot_limit on public.merchant_staff
  for each row execute function pg_temp.req977_full_day_windows();
-- ─── 墊片結束 ──────────────────────────────────────────────────────────────────────────────

select plan(19);

set local statement_timeout = '3s';

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- 改前版本(逐字複製 20261001010000 的函式本體,只改名稱、拿掉 security definer),給回歸比對用。
create function pg_temp.old_check_staff_booking_slot(
  p_merchant_id uuid,
  p_staff public.merchant_staff,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_exclude_booking_id uuid,
  p_role_label text
)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_bypass_bounds boolean;
  v_local_date date;
  v_day_of_week smallint;
  v_local_start time;
  v_local_end time;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_strict_conflict boolean;
  v_slot_start time;
  v_slot_end time;
  v_check_end time;
  v_override_is_available boolean;
  v_run_start time;
  v_run_end time;
  v_leave_type_name text;
begin
  -- 規則 2.3/§5.3 第 2 點:unlimited_backend_edit 覆寫例外優先權最高,連第三層單日例外也一併跳過。
  v_bypass_bounds := p_staff.unlimited_backend_edit;

  -- 模組 7(排班與休假管理)規則 2.7,主腦裁示版本(取代規格書原文規則 2.8 的設計):
  -- 請假整天判斷放在這裡——v_bypass_bounds 判斷區塊「之外」,一律執行,不受 unlimited_backend_edit
  -- 影響。用 daterange 疊加比對(而不是只比對 p_start_at 的當地日期),涵蓋 unlimited_backend_edit
  -- 情境下理論上可能發生的跨日預約,確保只要預約範圍落在的任何一個日曆天有請假紀錄就擋下。
  -- 用 leave_type_name_snapshot 這個快照欄位顯示假別名稱,不重新 join merchant_leave_types
  -- 查詢目前名稱(比照模組 9 §234 已經踩過、修過的坑)。
  select slr.leave_type_name_snapshot into v_leave_type_name
  from public.staff_leave_records slr
  where slr.staff_id = p_staff.id
    and slr.status = 'confirmed'
    and daterange(slr.start_date, slr.end_date, '[]') && daterange(
          date(p_start_at at time zone 'Asia/Taipei'),
          date(p_end_at at time zone 'Asia/Taipei'),
          '[]'
        )
  limit 1;

  if v_leave_type_name is not null then
    raise exception '%這天是休假日(假別：%)，無法預約', p_role_label, v_leave_type_name;
  end if;

  if not v_bypass_bounds then
    if date(p_start_at at time zone 'Asia/Taipei') <> date(p_end_at at time zone 'Asia/Taipei') then
      raise exception '%的預約時段跨到隔天，目前系統不支援，請拆成同一天內的時段', p_role_label;
    end if;

    v_local_date := date(p_start_at at time zone 'Asia/Taipei');
    v_day_of_week := extract(dow from (p_start_at at time zone 'Asia/Taipei'))::smallint;
    v_local_start := (p_start_at at time zone 'Asia/Taipei')::time;
    v_local_end := (p_end_at at time zone 'Asia/Taipei')::time;

    select true, is_closed, open_time, close_time
    into v_has_hours, v_is_closed, v_open_time, v_close_time
    from public.merchant_business_hours
    where merchant_id = p_merchant_id and day_of_week = v_day_of_week;

    -- §5.3:以半小時為單位逐格檢查 [v_local_start, v_local_end)。
    -- §4.3 交叉提醒:自訂工時是客服輸入的任意分鐘數,不保證是 30 的倍數,所以整段長度不一定剛好
    -- 對齊半小時格線——迴圈仍然以 v_local_start 為起點、每次固定推進 30 分鐘(對齊
    -- staff_availability_overrides 的半小時格線鍵值去查例外),但最後一格如果超出 v_local_end,
    -- 交集檢查(v_check_end)只看「實際用到的部分」,不要求整個半小時格子都要合格
    -- ——避免把一個 70 分鐘的自訂工時,因為最後一格「多算」了 20 分鐘而被誤判超出邊界。
    --
    -- **修正重點(主腦複查抓到的漏洞)**:「查無例外」的格子不能逐格獨立檢查「存在某一組時段
    -- 覆蓋這一格」——那樣會讓橫跨兩組相鄰時段交界的預約被誤判通過。改成用 v_run_start/v_run_end
    -- 把連續的「無例外」格子累積成一段,遇到下一個「有例外」的格子時、或迴圈跑完時,才把整段
    -- 一次拿去跟原本的整段判斷邏輯(private.check_staff_legacy_range)比對,確保「無任何單日例外
    -- 時,逐格判斷結果與模組 5 原本的整段範圍判斷結果完全一致」(§5.3 第 4 點)。
    v_slot_start := v_local_start;
    v_run_start := null;
    v_run_end := null;
    while v_slot_start < v_local_end loop
      v_slot_end := v_slot_start + interval '30 minutes';
      v_check_end := least(v_slot_end, v_local_end);

      select is_available into v_override_is_available
      from public.staff_availability_overrides
      where staff_id = p_staff.id
        and override_date = v_local_date
        and slot_start_time = v_slot_start;

      if found then
        -- 遇到有例外的格子:先把前面累積、還沒驗證的「無例外連續區段」一次驗證掉
        -- (不能留到迴圈結束才驗證,因為這個例外格子把連續區段切斷了)。
        if v_run_start is not null then
          perform private.check_staff_legacy_range(
            p_staff, v_day_of_week, v_has_hours, v_is_closed, v_open_time, v_close_time,
            v_run_start, v_run_end, p_role_label
          );
          v_run_start := null;
          v_run_end := null;
        end if;

        -- §5.3 第 1 點:有例外,直接採用例外的 is_available,不論前兩層原本判斷結果是什麼。
        if not v_override_is_available then
          raise exception '%的%到%這個時段目前不可預約(已設定臨時關閉)', p_role_label, v_slot_start, v_check_end;
        end if;
        -- is_available = true:例外開啟,這一格直接放行,不需要再檢查商家營業時間/服務人員時段。
      else
        -- §5.3 第 1 點:查無例外,累積進「無例外連續區段」,先不急著判斷,等區段結束
        -- (遇到下一個有例外的格子,或迴圈跑完)才把整段一次套用跟原本整段判斷完全相同的條件
        -- (等價性見檔案開頭與 20260919100200_day_override_third_layer.sql 的說明)。
        if v_run_start is null then
          v_run_start := v_slot_start;
        end if;
        v_run_end := v_check_end;
      end if;

      v_slot_start := v_slot_end;
    end loop;

    -- 迴圈跑完後,如果還有累積中、尚未驗證的「無例外連續區段」(例如整個 [start,end) 都沒有
    -- 任何例外設定,或最後一段沒有以例外格子收尾),要在這裡補驗證,不能漏掉。
    if v_run_start is not null then
      perform private.check_staff_legacy_range(
        p_staff, v_day_of_week, v_has_hours, v_is_closed, v_open_time, v_close_time,
        v_run_start, v_run_end, p_role_label
      );
    end if;
  end if;

  -- 規則 2.4/2.6 衝突檢查不變(跟第三層是獨立的判斷維度,不受單日例外影響)。
  select enabled into v_strict_conflict
  from public.merchant_feature_flags
  where merchant_id = p_merchant_id and feature_key = 'strict_conflict_check';
  if v_strict_conflict is null then
    v_strict_conflict := true; -- 查無資料視為預設開啟
  end if;

  if v_strict_conflict then
    if private.staff_booking_conflict_exists(p_staff.id, p_start_at, p_end_at, p_exclude_booking_id) then
      raise exception '%在這個時段已經有其他預約', p_role_label;
    end if;

    -- SPECS-INDEX #924(2026-10-01):「同一個人在別的分店」只在**同一集團內**比對。
    -- 原本這段 EXISTS 掃的是**整個平台**的 merchant_staff(沒有任何商家/集團過濾),
    -- 兩間毫不相關的商家只要各有一人填到同一支電話就會互相擋單,錯誤訊息還會告訴 A 店
    -- 「這個人在另一間店有預約」(跨租戶資訊洩漏,資安清單 #16 / #17)。
    -- 判定條件統一收在 private.same_person_staff_ids_in_group(),get_merchant_day_schedule /
    -- get_my_day_schedule_state 的灰色「跨店佔用」格用的是**同一支**,三邊不可能各說各話
    -- (否則會出現「行事曆顯示空的、送出卻被擋」)。
    -- 錯誤訊息照規格書 §12.7 第 3 點:{角色}「{姓名}」只指本店自己的人(p_role_label + p_staff.name),
    -- 不帶別家分店店名、客戶、訂單內容(資安清單 #17)。p_role_label 為助手時本身已是 '助手「姓名」',
    -- 就不再重複補姓名。
    if exists (
      select 1
      from private.same_person_staff_ids_in_group(p_staff.id) as other_staff(staff_id)
      where private.staff_booking_conflict_exists(other_staff.staff_id, p_start_at, p_end_at, p_exclude_booking_id)
    ) then
      raise exception '%在這個時段已經有同集團其他分店的預約，請改選其他時段或其他服務人員',
        case
          when strpos(p_role_label, '「') > 0 then p_role_label
          else format('%s「%s」', p_role_label, p_staff.name)
        end;
    end if;
  end if;
end;
$$;


-- =========================================================================
-- Fixture:營業時間七天 00:00~23:59
--   N:一般服務人員,無時段限制(每週時段 = 營業時間)
--   U:unlimited_backend_edit
--   R:每週時段 09:00~12:00、13:00~18:00;2026-12-09 10:00 單日排休、19:00 單日開啟;2026-12-09 15:00~16:00 有一筆預約
-- =========================================================================
insert into auth.users (id, email) values ('e9810000-0000-4000-8000-000000000001', 'pgtap-req980b-admin@test.local');
insert into groups (id) values ('e9810000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values ('e9810000-0000-4000-8000-000000000021', 'e9810000-0000-4000-8000-000000000011', '迴圈修正測試店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values ('e9810000-0000-4000-8000-000000000021', 'e9810000-0000-4000-8000-000000000001');
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
select 'e9810000-0000-4000-8000-000000000021'::uuid, d, false, '00:00', '23:59' from generate_series(0, 6) as d;
insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('e9810000-0000-4000-8000-000000000031', 'e9810000-0000-4000-8000-000000000021', '服務人員N', '0900098101', true, false),
  ('e9810000-0000-4000-8000-000000000032', 'e9810000-0000-4000-8000-000000000021', '服務人員U', '0900098102', false, true),
  ('e9810000-0000-4000-8000-000000000033', 'e9810000-0000-4000-8000-000000000021', '服務人員R', '0900098103', false, false);
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time)
select 'e9810000-0000-4000-8000-000000000033'::uuid, d, w.s::time, w.e::time
from generate_series(0, 6) as d, (values ('09:00', '12:00'), ('13:00', '18:00')) as w(s, e);
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('e9810000-0000-4000-8000-000000000033', '2026-12-09', '10:00', false),
  ('e9810000-0000-4000-8000-000000000033', '2026-12-09', '19:00', true);
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('e9810000-0000-4000-8000-000000000041', 'e9810000-0000-4000-8000-000000000021', '一小時', 1000, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values ('e9810000-0000-4000-8000-000000000051', 'e9810000-0000-4000-8000-000000000021', '現場付款');
select seed_default_member_settings('e9810000-0000-4000-8000-000000000021');

select pg_temp.test_set_auth('e9810000-0000-4000-8000-000000000001');
select id from create_booking(
  p_merchant_id => 'e9810000-0000-4000-8000-000000000021',
  p_staff_id => 'e9810000-0000-4000-8000-000000000033',
  p_service_items => jsonb_build_array(jsonb_build_object('service_item_id','e9810000-0000-4000-8000-000000000041','quantity',1,'unit_price',1000)),
  p_start_at => '2026-12-09 15:00:00+08',
  p_customer_name => '迴圈測試客戶',
  p_customer_phone => '0955098101',
  p_payment_method_id => 'e9810000-0000-4000-8000-000000000051') \gset bk_
select pg_temp.test_clear_auth();

-- 放行 = true、規則擋下 = false;其他錯誤(含逾時)照常丟出 ⇒ 測試轉紅。
create function pg_temp.new_ok(p_staff uuid, p_start timestamptz, p_minutes integer) returns boolean
language plpgsql as $$
declare v_staff public.merchant_staff;
begin
  select * into v_staff from public.merchant_staff where id = p_staff;
  perform private.check_staff_booking_slot('e9810000-0000-4000-8000-000000000021', v_staff, p_start, p_start + make_interval(mins => p_minutes), null, '主要服務人員');
  return true;
exception when raise_exception then
  return false;
end;
$$;

create function pg_temp.old_ok(p_staff uuid, p_start timestamptz, p_minutes integer) returns boolean
language plpgsql as $$
declare v_staff public.merchant_staff;
begin
  select * into v_staff from public.merchant_staff where id = p_staff;
  perform pg_temp.old_check_staff_booking_slot('e9810000-0000-4000-8000-000000000021', v_staff, p_start, p_start + make_interval(mins => p_minutes), null, '主要服務人員');
  return true;
exception when raise_exception then
  return false;
end;
$$;

select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000031', '2026-12-08 23:00:00+08', 45), true,
  '① 45 分鐘、23:00 起(結束 23:45)⇒ 不卡死、放行');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000031', '2026-12-08 22:00:00+08', 100), true,
  '② 100 分鐘、22:00 起(結束 23:40)⇒ 不卡死、放行');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000031', '2026-12-08 23:30:00+08', 20), true,
  '③ 自訂 20 分鐘、23:30 起(結束 23:50)⇒ 不卡死、放行');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000031', '2026-12-08 23:00:00+08', 40), true,
  '④ 一般服務人員 23:00 起 40 分鐘(結束 23:40,客服手動送單的既有情境)⇒ 不卡死、放行');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 17:30:00+08', 45), false,
  '⑤ R:17:30 起 45 分鐘(結束 18:15,超出每週時段 18:00)⇒ 照舊擋下');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000032', '2026-12-08 23:00:00+08', 40), true,
  '⑥ unlimited_backend_edit 23:00 起 40 分鐘 ⇒ 放行');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000031', '2026-12-08 23:30:00+08', 45), false,
  '⑦ 23:30 起 45 分鐘(跨到隔天)⇒ 照舊擋下');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000031', '2026-12-08 23:30:00+08', 30), false,
  '⑧ 23:30 起 30 分鐘(結束 24:00 = 隔天 00:00)⇒ 照舊擋下');

select pg_temp.test_set_auth('e9810000-0000-4000-8000-000000000001');
select is(
  public.list_staff_bookable_start_times('e9810000-0000-4000-8000-000000000021', 'e9810000-0000-4000-8000-000000000031', '2026-12-08', 45, null),
  (select array_agg(to_char(make_time(m / 60, m % 60, 0), 'HH24:MI') order by m) from generate_series(0, 1380, 30) as m),
  '⑨ list_staff_bookable_start_times 45 分鐘:00:00~23:00 共 47 個起點(23:30 起會跨日),不會卡住');
select pg_temp.test_clear_auth();

select is(
  (select count(*) from generate_series(0, 1410, 30) as m, unnest(array[30, 60, 90, 120]) as d,
     unnest(array['e9810000-0000-4000-8000-000000000031'::uuid, 'e9810000-0000-4000-8000-000000000033'::uuid]) as s,
     lateral (select ('2026-12-09'::timestamp + make_interval(mins => m)) at time zone 'Asia/Taipei' as st) x
   where pg_temp.new_ok(s, x.st, d) is distinct from pg_temp.old_ok(s, x.st, d))::int,
  0,
  '⑩ 回歸:30 倍數工時 × 48 個起點 × N / R(含單日排休、單日開啟、兩段時段、既有訂單衝突)⇒ 新舊結果完全相同');
select is(
  (select count(*) from generate_series(0, 1320, 30) as m, unnest(array[45, 75]) as d,
     lateral (select ('2026-12-09'::timestamp + make_interval(mins => m)) at time zone 'Asia/Taipei' as st) x
   where m + d <= 1410
     and pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', x.st, d) is distinct from pg_temp.old_ok('e9810000-0000-4000-8000-000000000033', x.st, d))::int,
  0,
  '⑪ 回歸:非 30 倍數(45/75 分)、結束不超過 23:30 的起點 ⇒ 新舊結果完全相同');

-- ⑫~⑲ 起點不在整點 / 半點。R:每週時段 09:00~12:00、13:00~18:00;12/09 10:00 單日排休、19:00 單日開啟;15:00~16:00 有預約
select ok(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 09:05:00+08', 60) = false
      and pg_temp.old_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 09:05:00+08', 60) = true,
  '⑫ 09:05~10:05 碰到 10:00 單日排休 ⇒ 現在擋下(改前版本用 09:05 / 09:35 查例外查不到 ⇒ 誤放行)');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 09:10:00+08', 45), true,
  '⑬ 09:10 起 45 分鐘(到 09:55,整段在時段內、沒碰到排休)⇒ 放行');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 11:20:00+08', 45), false,
  '⑭ 11:20 起 45 分鐘(到 12:05,超出每週時段 12:00)⇒ 擋下');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 12:50:00+08', 30), false,
  '⑮ 12:50 起 30 分鐘(從 12:50 開始,還沒到每週時段 13:00)⇒ 擋下');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 13:05:00+08', 45), true,
  '⑯ 13:05 起 45 分鐘(到 13:50)⇒ 放行');
select ok(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 19:05:00+08', 20) = true
      and pg_temp.old_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 19:05:00+08', 20) = false,
  '⑰ 19:05~19:25 落在 19:00 單日開啟那一格 ⇒ 現在放行(改前版本查不到例外 ⇒ 誤擋)');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 19:20:00+08', 20), false,
  '⑱ 19:20~19:40 超出 19:00~19:30 的單日開啟(19:30 之後不在時段內)⇒ 擋下');
select is(pg_temp.new_ok('e9810000-0000-4000-8000-000000000033', '2026-12-09 14:20:00+08', 45), false,
  '⑲ 14:20~15:05 跟 15:00~16:00 的既有預約重疊 ⇒ 擋下(嚴格檢查預設開啟)');

select * from finish();
rollback;
