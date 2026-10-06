-- SPECS-INDEX #977 第 3 批(2026-10-06):「客戶預約無時段限制」(no_time_slot_limit)改成只管客戶預約 — pgTAP
-- migration 20261006130200_req977_no_time_slot_limit_customer_only.sql
-- 規格書「權限收緊與服務人員開關修正-第3批」第三節。
--
-- ⚠️ 這支**不掛** #977 測試墊片(其他舊測試檔頭那個自動補全天時段的 trigger),驗的就是新行為本身。
--
--   ① 回歸(核心):沒開 no_time_slot_limit 的服務人員,新版 private.check_staff_booking_slot 的放行 / 擋下結果
--      跟改前版本(pg_temp 逐字複製 20261006110000 的 check_staff_booking_slot + 20260919100600 的
--      check_staff_legacy_range,比照 req980_02 的做法)**逐一完全相同**。
--      矩陣:3 天(營業 / 營業 / 公休)× 07:00~19:00 每 10 分鐘一個起點(含非 30 倍數起點)× 工時 30 / 45 / 60 / 100 分鐘
--            × 4 位服務人員(有每週時段 + 單日例外 / 沒有時段 / 全天時段 / 後台無時段限制)
--   ②③ 前提:矩陣同時有放行與擋下(不是全部一樣的假通過)
--   ④⑤ 開了 no_time_slot_limit 的服務人員:新版結果 = 「當作沒開」;改前版本確實會放行一部分(證明這次真的有改到)
--   ⑥⑦ create_booking:開了 no_time_slot_limit、沒設定時段 ⇒ 被擋;同一位設好每週時段 ⇒ 時段內可以建
--   ⑧   list_staff_bookable_start_times:開了 no_time_slot_limit、沒設定時段 ⇒ 0 個可選時間
--   ⑨~⑪ get_merchant_day_schedule:no_time_slot_limit 不再讓可約時段變成整段營業時間;unlimited_backend_edit 才會;
--        回傳欄位換成 unlimited_backend_edit
--   ⑫⑬ get_staff_schedule_overview:「不受時段限制」改看 unlimited_backend_edit
--   ⑭   三支改過的函式 ACL 跟改前完全相同
--
-- 故障注入(engineer 已做,見回報):把 check_staff_legacy_range 的 `if v_ok then` 改回
--   `if v_ok and not p_staff.no_time_slot_limit then` ⇒ ④⑥⑧ 轉紅(⑦ 連帶紅:⑥ 已先建了同時段的單);① 仍綠(沒開的人本來就不受影響,這正是要證明的事)。
begin;

select plan(14);

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

-- ─── 改前版本(逐字複製,只改名稱、拿掉 security definer;check_staff_booking_slot 內呼叫改指向改前的 legacy range)───
create function pg_temp.old_check_staff_legacy_range(p_staff merchant_staff, p_day_of_week smallint, p_has_hours boolean, p_is_closed boolean, p_open_time time without time zone, p_close_time time without time zone, p_range_start time without time zone, p_range_end time without time zone, p_role_label text)
 RETURNS void
 LANGUAGE plpgsql

 SET search_path TO 'public'
AS $function$
declare
  v_ok boolean;
begin
  -- 規則 2.1∩2.2:這一整段(不是單一半小時格子)必須完整落在商家營業時間內,
  -- 而且(no_time_slot_limit 者除外)必須存在「同一組」staff_availability_windows
  -- 完整涵蓋這一整段——不能分別用不同組時段拼湊涵蓋這一段的頭尾。
  v_ok := coalesce(p_has_hours, false)
    and not coalesce(p_is_closed, true)
    and p_range_start >= p_open_time
    and p_range_end <= p_close_time;

  if v_ok and not p_staff.no_time_slot_limit then
    select exists (
      select 1 from public.staff_availability_windows
      where staff_id = p_staff.id
        and day_of_week = p_day_of_week
        and start_time <= p_range_start
        and end_time >= p_range_end
    ) into v_ok;
  end if;

  if not v_ok then
    raise exception '%的%到%這個時段不可預約(超出商家營業時間,或超出服務人員可預約時段設定)',
      p_role_label, p_range_start, p_range_end;
  end if;
end;
$function$;

create function pg_temp.old_check_staff_booking_slot(p_merchant_id uuid, p_staff merchant_staff, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_exclude_booking_id uuid, p_role_label text)
 RETURNS void
 LANGUAGE plpgsql

 SET search_path TO 'public'
AS $function$
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
  -- 2026-10-06 #980 QA:迴圈改用「從半小時格線起點經過多久」(interval)計時,不再用 time 型別逐格相加
  -- (23:30 + 30 分會繞回 00:00 ⇒ 無限迴圈);並以半小時格線查單日例外(起點不在整點 / 半點時原本查不到例外)。
  v_grid_start time;
  v_grid_slot time;
  v_elapsed interval;
  v_total interval;
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
    raise exception '%這天是休假日(假別:%),無法預約', p_role_label, v_leave_type_name;
  end if;

  if not v_bypass_bounds then
    if date(p_start_at at time zone 'Asia/Taipei') <> date(p_end_at at time zone 'Asia/Taipei') then
      raise exception '%的預約時段跨到隔天,目前系統不支援,請拆成同一天內的時段', p_role_label;
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
    -- #980 QA:格線起點 = 預約起點往前取到整點 / 半點(09:05 ⇒ 09:00);起點本來就在整點 / 半點時 = 起點本身。
    v_grid_start := v_local_start - make_interval(secs => (extract(epoch from v_local_start) % 1800)::double precision);
    v_elapsed := interval '0 minutes';
    v_total := v_local_end - v_grid_start;
    v_run_start := null;
    v_run_end := null;
    while v_elapsed < v_total loop
      -- v_grid_slot = 這一格在半小時格線上的鍵值(查單日例外用);
      -- [v_slot_start, v_check_end) = 這次預約實際用到這一格的部分(第一格可能從 09:05 開始,最後一格可能在 10:05 結束)。
      v_grid_slot := v_grid_start + v_elapsed;
      v_slot_start := greatest(v_grid_slot, v_local_start);
      v_check_end := v_grid_start + least(v_elapsed + interval '30 minutes', v_total);

      select is_available into v_override_is_available
      from public.staff_availability_overrides
      where staff_id = p_staff.id
        and override_date = v_local_date
        and slot_start_time = v_grid_slot;

      if found then
        -- 遇到有例外的格子:先把前面累積、還沒驗證的「無例外連續區段」一次驗證掉
        -- (不能留到迴圈結束才驗證,因為這個例外格子把連續區段切斷了)。
        if v_run_start is not null then
          perform pg_temp.old_check_staff_legacy_range(
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

      v_elapsed := v_elapsed + interval '30 minutes';
    end loop;

    -- 迴圈跑完後,如果還有累積中、尚未驗證的「無例外連續區段」(例如整個 [start,end) 都沒有
    -- 任何例外設定,或最後一段沒有以例外格子收尾),要在這裡補驗證,不能漏掉。
    if v_run_start is not null then
      perform pg_temp.old_check_staff_legacy_range(
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
      raise exception '%在這個時段已經有同集團其他分店的預約,請改選其他時段或其他服務人員',
        case
          when strpos(p_role_label, '「') > 0 then p_role_label
          else format('%s「%s」', p_role_label, p_staff.name)
        end;
    end if;
  end if;
end;
$function$;


create function pg_temp.new_ok(p_merchant_id uuid, p_staff public.merchant_staff, p_start timestamptz, p_end timestamptz)
returns boolean language plpgsql as $$
begin
  perform private.check_staff_booking_slot(p_merchant_id, p_staff, p_start, p_end, null, '測試');
  return true;
exception when others then
  return false;
end;
$$;

create function pg_temp.old_ok(p_merchant_id uuid, p_staff public.merchant_staff, p_start timestamptz, p_end timestamptz)
returns boolean language plpgsql as $$
begin
  perform pg_temp.old_check_staff_booking_slot(p_merchant_id, p_staff, p_start, p_end, null, '測試');
  return true;
exception when others then
  return false;
end;
$$;

-- =========================================================================
-- Fixture
-- =========================================================================
insert into auth.users (id, email) values
  ('f9770000-0000-4000-8000-000000000001', 'pgtap-r977-admin@test.local');
insert into groups (id) values ('f9770000-0000-4000-8000-000000000011');
insert into merchants (id, group_id, name, industry_type) values
  ('f9770000-0000-4000-8000-000000000020', 'f9770000-0000-4000-8000-000000000011', '#977 時段測試店', 'in_store_beauty');
insert into merchant_admins (merchant_id, user_id) values
  ('f9770000-0000-4000-8000-000000000020', 'f9770000-0000-4000-8000-000000000001');

-- 營業時間:週一 09:00~18:00、週二 09:00~18:00、週三公休(2026-11-09 週一、11-10 週二、11-11 週三)。
insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time) values
  ('f9770000-0000-4000-8000-000000000020', 1, false, '09:00', '18:00'),
  ('f9770000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00'),
  ('f9770000-0000-4000-8000-000000000020', 3, true, null, null);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit, unlimited_backend_edit) values
  ('f9770000-0000-4000-8000-000000000041', 'f9770000-0000-4000-8000-000000000020', 'S1有時段', '0911977041', false, false),
  ('f9770000-0000-4000-8000-000000000042', 'f9770000-0000-4000-8000-000000000020', 'S2沒時段', '0911977042', false, false),
  ('f9770000-0000-4000-8000-000000000043', 'f9770000-0000-4000-8000-000000000020', 'S3全天時段', '0911977043', false, false),
  ('f9770000-0000-4000-8000-000000000044', 'f9770000-0000-4000-8000-000000000020', 'S4後台無限制', '0911977044', false, true),
  ('f9770000-0000-4000-8000-000000000045', 'f9770000-0000-4000-8000-000000000020', 'S5客戶無時段限制', '0911977045', true, false);

-- S1:週一 09:00~18:00;週二兩段 10:00~12:00、13:00~15:30;11-10 單日例外:10:30 那格關、16:00 / 16:30 兩格開。
-- S3:週一~週三 00:00~24:00。
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('f9770000-0000-4000-8000-000000000041', 1, '09:00', '18:00'),
  ('f9770000-0000-4000-8000-000000000041', 2, '10:00', '12:00'),
  ('f9770000-0000-4000-8000-000000000041', 2, '13:00', '15:30'),
  ('f9770000-0000-4000-8000-000000000043', 1, '00:00', '24:00'),
  ('f9770000-0000-4000-8000-000000000043', 2, '00:00', '24:00'),
  ('f9770000-0000-4000-8000-000000000043', 3, '00:00', '24:00');
insert into staff_availability_overrides (staff_id, override_date, slot_start_time, is_available) values
  ('f9770000-0000-4000-8000-000000000041', '2026-11-10', '10:30', false),
  ('f9770000-0000-4000-8000-000000000041', '2026-11-10', '16:00', true),
  ('f9770000-0000-4000-8000-000000000041', '2026-11-10', '16:30', true);

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('f9770000-0000-4000-8000-000000000060', 'f9770000-0000-4000-8000-000000000020', '#977 服務', 500, 'primary', 60);
insert into payment_methods (id, merchant_id, name) values
  ('f9770000-0000-4000-8000-000000000061', 'f9770000-0000-4000-8000-000000000020', '現金');

-- 試算矩陣(postgres 身分直接呼叫兩個版本)
create temp table req977_matrix on commit drop as
select ms.id as staff_id, d.day, t.start_min, dur.minutes,
       pg_temp.new_ok('f9770000-0000-4000-8000-000000000020', ms,
         (d.day + make_interval(mins => t.start_min))::timestamp at time zone 'Asia/Taipei',
         (d.day + make_interval(mins => t.start_min + dur.minutes))::timestamp at time zone 'Asia/Taipei') as new_result,
       pg_temp.old_ok('f9770000-0000-4000-8000-000000000020', ms,
         (d.day + make_interval(mins => t.start_min))::timestamp at time zone 'Asia/Taipei',
         (d.day + make_interval(mins => t.start_min + dur.minutes))::timestamp at time zone 'Asia/Taipei') as old_result
from public.merchant_staff ms
cross join (values (date '2026-11-09'), (date '2026-11-10'), (date '2026-11-11')) d(day)
cross join generate_series(7 * 60, 19 * 60, 10) t(start_min)
cross join (values (30), (45), (60), (100)) dur(minutes)
where ms.merchant_id = 'f9770000-0000-4000-8000-000000000020';

-- =========================================================================
-- ①~③ 沒開 no_time_slot_limit:判斷結果完全不變
-- =========================================================================
select is(
  (select count(*)::int from req977_matrix m join merchant_staff ms on ms.id = m.staff_id
   where not ms.no_time_slot_limit and m.new_result is distinct from m.old_result),
  0,
  '① 沒開 no_time_slot_limit 的 4 位服務人員(有時段+單日例外 / 沒時段 / 全天時段 / 後台無限制),3 天 × 73 個起點 × 4 種工時新舊結果逐一相同'
);
select ok(
  (select count(*) from req977_matrix m join merchant_staff ms on ms.id = m.staff_id where not ms.no_time_slot_limit and m.new_result) > 100,
  '② 前提:矩陣裡有足夠多「放行」的組合(不是全部擋下的假通過)'
);
select ok(
  (select count(*) from req977_matrix m join merchant_staff ms on ms.id = m.staff_id where not ms.no_time_slot_limit and not m.new_result) > 100,
  '③ 前提:矩陣裡也有足夠多「擋下」的組合(含非 30 倍數起點與工時)'
);

-- =========================================================================
-- ④⑤ 開了 no_time_slot_limit:新版 = 當作沒開(跟 S2 沒時段完全相同 ⇒ 全部擋下)
-- =========================================================================
select is(
  (select count(*)::int from req977_matrix
   where staff_id = 'f9770000-0000-4000-8000-000000000045' and new_result),
  0,
  '④ 開了 no_time_slot_limit、沒設定每週時段:後台判斷一律擋下(跟沒開、沒時段的 S2 相同)'
);
select ok(
  (select count(*) from req977_matrix
   where staff_id = 'f9770000-0000-4000-8000-000000000045' and old_result) > 0,
  '⑤ 對照:改前版本對同一位會放行營業時間內的組合(證明這次真的改到了後台判斷)'
);

-- =========================================================================
-- ⑥⑦ create_booking(後台建單)
-- =========================================================================
select pg_temp.test_set_auth('f9770000-0000-4000-8000-000000000001');
select throws_ok(
  $$select create_booking(
    'f9770000-0000-4000-8000-000000000020', 'f9770000-0000-4000-8000-000000000045',
    jsonb_build_array(jsonb_build_object('service_item_id','f9770000-0000-4000-8000-000000000060','quantity',1,'unit_price',500)),
    '2026-11-10 10:00:00+08', '客戶一', '0933977001',
    p_payment_method_id => 'f9770000-0000-4000-8000-000000000061'
  )$$,
  'P0001', null,
  '⑥ 管理員幫「開了 no_time_slot_limit、沒設時段」的服務人員建單:被擋(改前會成功)'
);
select pg_temp.test_clear_auth();
insert into staff_availability_windows (staff_id, day_of_week, start_time, end_time) values
  ('f9770000-0000-4000-8000-000000000045', 2, '10:00', '12:00');
select pg_temp.test_set_auth('f9770000-0000-4000-8000-000000000001');
select lives_ok(
  $$select create_booking(
    'f9770000-0000-4000-8000-000000000020', 'f9770000-0000-4000-8000-000000000045',
    jsonb_build_array(jsonb_build_object('service_item_id','f9770000-0000-4000-8000-000000000060','quantity',1,'unit_price',500)),
    '2026-11-10 10:00:00+08', '客戶二', '0933977002',
    p_payment_method_id => 'f9770000-0000-4000-8000-000000000061'
  )$$,
  '⑦ 同一位補上每週時段 10:00~12:00 之後,時段內可以建單(跟一般服務人員相同)'
);

-- =========================================================================
-- ⑧ list_staff_bookable_start_times
-- =========================================================================
select is(
  cardinality(list_staff_bookable_start_times(
    'f9770000-0000-4000-8000-000000000020', 'f9770000-0000-4000-8000-000000000045', '2026-11-09', 60, null)),
  0,
  '⑧ 建單時間清單:開了 no_time_slot_limit、週一沒有每週時段 ⇒ 0 個可選時間(改前會列出整段營業時間)'
);

-- =========================================================================
-- ⑨~⑪ get_merchant_day_schedule(後台行事曆可約時段)
-- =========================================================================
select is(
  (select s -> 'available_windows' from jsonb_array_elements(get_merchant_day_schedule('f9770000-0000-4000-8000-000000000020', '2026-11-09') -> 'staff') s
   where s ->> 'staff_id' = 'f9770000-0000-4000-8000-000000000045'),
  '[]'::jsonb,
  '⑨ 行事曆:開了 no_time_slot_limit、週一沒時段 ⇒ 可約時段是空的(改前是整段營業時間)'
);
select is(
  (select s -> 'available_windows' from jsonb_array_elements(get_merchant_day_schedule('f9770000-0000-4000-8000-000000000020', '2026-11-09') -> 'staff') s
   where s ->> 'staff_id' = 'f9770000-0000-4000-8000-000000000044'),
  '[{"end_time": "18:00:00", "start_time": "09:00:00"}]'::jsonb,
  '⑩ 行事曆:開了「商家後台編輯無時段限制」的服務人員 ⇒ 整段營業時間可約(跟後台建單判斷同一個欄位)'
);
select ok(
  (select bool_and(s ? 'unlimited_backend_edit' and not (s ? 'no_time_slot_limit'))
   from jsonb_array_elements(get_merchant_day_schedule('f9770000-0000-4000-8000-000000000020', '2026-11-09') -> 'staff') s),
  '⑪ 行事曆回傳欄位:有 unlimited_backend_edit、不再有 no_time_slot_limit'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑫⑬ get_staff_schedule_overview(排班一覽,功能隱藏中但後端照常)
-- =========================================================================
select pg_temp.test_set_auth('f9770000-0000-4000-8000-000000000001');
select is(
  (select s -> 'days' -> 0 -> 'windows' from jsonb_array_elements(get_staff_schedule_overview('f9770000-0000-4000-8000-000000000020', '2026-11-09', '2026-11-09') -> 'staff') s
   where s ->> 'staff_id' = 'f9770000-0000-4000-8000-000000000044'),
  '[{"unrestricted": true}]'::jsonb,
  '⑫ 排班一覽:後台無時段限制 ⇒「不受時段限制」'
);
select is(
  (select s -> 'days' -> 0 -> 'windows' from jsonb_array_elements(get_staff_schedule_overview('f9770000-0000-4000-8000-000000000020', '2026-11-09', '2026-11-09') -> 'staff') s
   where s ->> 'staff_id' = 'f9770000-0000-4000-8000-000000000045'),
  '[]'::jsonb,
  '⑬ 排班一覽:只開 no_time_slot_limit、週一沒時段 ⇒ 未設定(不再顯示「不受時段限制」)'
);
select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑭ ACL 不變
-- =========================================================================
select is(
  array[
    coalesce(array_to_string((select proacl from pg_proc where oid = 'private.check_staff_legacy_range(public.merchant_staff, smallint, boolean, boolean, time, time, time, time, text)'::regprocedure), ' '), '(預設)'),
    array_to_string((select proacl from pg_proc where oid = 'public.get_merchant_day_schedule(uuid, date)'::regprocedure), ' '),
    array_to_string((select proacl from pg_proc where oid = 'public.get_staff_schedule_overview(uuid, date, date)'::regprocedure), ' ')
  ],
  array[
    '(預設)',
    'postgres=X/postgres authenticated=X/postgres service_role=X/postgres',
    'postgres=X/postgres authenticated=X/postgres service_role=X/postgres'
  ],
  '⑭ 三支改過的函式 ACL 跟改前完全相同'
);

select * from finish();

rollback;
