-- SPECS-INDEX #1023 / #1024(第 22 批):
--   #1023 每週可預約時段外的格子不能「開放」—— 資料庫這一段(畫面不給按,直接呼叫 RPC 也要擋)。
--   #1024 服務人員可預約時段直接調開始 / 結束時間 —— 資料庫這一段(同一天時段不能重疊,繞過畫面也擋)。
--
-- 改了什麼(三件,彼此獨立,可以單獨復原):
--   1. 新增 private.staff_slot_in_weekly_template(staff, date, start_min, end_min):
--        這段時間的每一個半小時格,是不是都落在「營業時間 ∩ 每週可預約時段」裡
--        (「商家後台編輯無時段限制」⇒ 整段營業時間)。規則跟 public.get_merchant_day_schedule 的
--        available_windows、前端 daySlotGrid.ts 的 resolveDaySlot(templateAvailable)逐條對應。
--   2. public.set_staff_day_override:逐字沿用 20261007130100(req987_b)版本,只加一段(前後有 [req1023-batch22] 標記,
--        req977_05 / req987_02 的指紋守門拿掉這段後仍 = 改前指紋)——
--        p_is_available = true(開放)而且有任何一格不在每週可預約時段內 ⇒ raise,整筆不寫。
--        關閉(false)不受影響(整天休假 00:00–24:00 仍然可以寫);clear_staff_day_override 不動
--        (刪例外 = 回到每週時段原本的樣子,不會造成「時段外開放」)。
--        public.staff_set_my_slot 內部呼叫這一支 ⇒ 服務人員端自動一起擋,那支不用改。
--   3. staff_availability_windows 新增 BEFORE INSERT / UPDATE trigger(新增與直接調時間都擋):
--        開始 >= 結束 ⇒ 白話錯誤(原本會撞 CHECK 約束、跳英文);同一位服務人員同一天時段重疊 ⇒ 擋。
--        相接(10:00–12:00 與 12:00–14:00)不算重疊。
--        主腦裁決(2026-10-08):「新增時段」也一起擋,前後規則一致(新增原本沒有重疊檢查,這是收緊)。
--        QA 打回修正:前端角色(anon / authenticated)沒有寫入權限 ⇒ 直接 42501、不做重疊查詢(不洩漏別人的時段);
--        service_role(就算帶別人的 sub)/ 直接 SQL 一律檢查(這些角色繞過 RLS,不能「沒權限就跳過」)。
--        🔴 之後任何 SECURITY DEFINER RPC 寫這張表,必須自己檢查重疊與權限。
--        正式庫 2026-10-08 唯讀查:目前沒有任何重疊的既有時段(0 組)。
--
-- 改前指紋(正式庫 wjtbmmnakcriuaqoknsq,2026-10-08 唯讀實查;算法 = md5(replace(prosrc, CRLF, LF))):
--   public.set_staff_day_override = 79f197586851705f36db90528ef4c48c(= 本機 = 20261007130100,沒有漂移)
--   public.staff_set_my_slot      = 602e236656c7502268169afe0ac4fc23(本檔不動)
--   public.clear_staff_day_override = a9973e8ad3152043a2f61c42b02eabc4(本檔不動)
-- 改後指紋(本機套用後實查,同算法):
--   public.set_staff_day_override                     = bee1cbe7d85136947d363fd1a2aa3770
--   private.staff_slot_in_weekly_template(新)          = a0f1a10e075d30584f233f0979ee0ef6
--   private.tg_staff_availability_windows_validate(新) = 58f8a025e4e96a0fb22b3f73575fda33
--
-- 既有殘留資料:正式庫 is_available = true 的單日例外共 2 筆,都在測試商家「Claude瀏覽器測試商」
--   2026-09-23 10:00 / 10:30,而且都落在每週時段外。本檔**不刪任何資料**(主腦裁決前不動),
--   畫面照舊顯示成淡紫框;商家可以在那一格按「關閉時段」把它清掉(關閉方向不擋)。
--
-- 即時同步:staff_availability_windows 的 UPDATE 已由 #1003 的
--   staff_availability_windows_notify_merchant_calendar(after insert or update or delete)涵蓋,本檔不用另外加。
--
-- 套用順序:接在 20261008130000 之後;跟前端互不依賴(舊前端呼叫時段外開放會收到這裡的白話錯誤,
--   新前端根本不會送)。⚠️ 本檔沒有任何資料寫入或刪除。

-- =========================================================================
-- 1. 每週可預約時段判斷(只給本檔的 SECURITY DEFINER 函式內部呼叫)
-- =========================================================================
create or replace function private.staff_slot_in_weekly_template(
  p_staff_id uuid,
  p_date date,
  p_start_minutes int,
  p_end_minutes int
)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_unlimited boolean;
  v_dow smallint;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
  v_open int;
  v_close int;
  v_slot int;
begin
  select ms.merchant_id, ms.unlimited_backend_edit into v_merchant_id, v_unlimited
  from public.merchant_staff ms
  where ms.id = p_staff_id;
  if v_merchant_id is null then
    return false;
  end if;

  v_dow := extract(dow from p_date)::smallint;
  select bh.is_closed, bh.open_time, bh.close_time into v_is_closed, v_open_time, v_close_time
  from public.merchant_business_hours bh
  where bh.merchant_id = v_merchant_id and bh.day_of_week = v_dow;
  -- 沒有營業時間設定 / 公休 ⇒ 這天沒有任何可預約時段。
  if not found or coalesce(v_is_closed, true) or v_open_time is null or v_close_time is null then
    return false;
  end if;

  -- 一律用「當日分鐘數」比(24:00:00 = 1440,不會回捲成 0)。
  v_open := extract(hour from v_open_time)::int * 60 + extract(minute from v_open_time)::int;
  v_close := extract(hour from v_close_time)::int * 60 + extract(minute from v_close_time)::int;

  v_slot := p_start_minutes;
  while v_slot < p_end_minutes loop
    -- 第一層:營業時間。
    if v_slot < v_open or v_slot + 30 > v_close then
      return false;
    end if;
    -- 第二層:每週可預約時段(跟營業時間取交集);「商家後台編輯無時段限制」⇒ 整段營業時間。
    if not coalesce(v_unlimited, false) and not exists (
      select 1
      from public.staff_availability_windows w
      where w.staff_id = p_staff_id
        and w.day_of_week = v_dow
        and extract(hour from w.start_time)::int * 60 + extract(minute from w.start_time)::int <= v_slot
        and extract(hour from w.end_time)::int * 60 + extract(minute from w.end_time)::int >= v_slot + 30
    ) then
      return false;
    end if;
    v_slot := v_slot + 30;
  end loop;

  return true;
end;
$function$;

comment on function private.staff_slot_in_weekly_template(uuid, date, int, int) is 'SPECS-INDEX #1023(第 22 批):[p_start_minutes, p_end_minutes)(當日分鐘數,半小時對齊)每一格是否都落在這位服務人員這一天的「營業時間 ∩ 每週可預約時段」內;unlimited_backend_edit ⇒ 整段營業時間。不看單日例外、不看請假。規則跟 get_merchant_day_schedule 的 available_windows、前端 resolveDaySlot 的 templateAvailable 一致。只給 set_staff_day_override 內部呼叫,三個角色都沒有 EXECUTE。';

revoke execute on function private.staff_slot_in_weekly_template(uuid, date, int, int) from public, anon, authenticated;

-- =========================================================================
-- 2. set_staff_day_override:逐字沿用 20261007130100,只加「時段外不能開放」那一段
-- =========================================================================
CREATE OR REPLACE FUNCTION public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
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

  -- [req1023-batch22 begin]
  -- SPECS-INDEX #1023(第 22 批):每週可預約時段外的格子不能「開放」(畫面已不給按,這裡擋直接呼叫)。
  -- 要在時段外排單,走既有的「商家後台編輯無時段限制」。關閉方向不受影響。
  if p_is_available and not private.staff_slot_in_weekly_template(p_staff_id, p_override_date, v_start_minutes, v_end_minutes) then
    raise exception '這段時間不在這位服務人員的每週可預約時段內，無法開放。需要在時段外排單時，請由商家開啟「商家後台編輯無時段限制」。';
  end if;
  -- [req1023-batch22 end]

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

revoke execute on function public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean) from PUBLIC, anon;
grant execute on function public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean) to authenticated, service_role;

-- =========================================================================
-- 3. staff_availability_windows:新增 / 修改時開始 < 結束、同一天不能重疊
-- =========================================================================
create or replace function private.tg_staff_availability_windows_validate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_other record;
begin
  -- 第 22 批 QA 打回修正:先判斷「是誰在寫」,再決定要不要做檢查,兩條路都不能洩漏別人的時段。
  --   ・前端來的請求(auth.role() = anon / authenticated)而且對這位服務人員沒有寫入權限
  --     ⇒ 直接 raise 42501(不做重疊查詢,訊息裡沒有任何時段)。anon 的 auth.uid() 是 null,
  --       所以不能用 auth.uid() 判斷(上一版的漏洞:anon 會拿到「跟「14:00–16:00」重疊」)。
  --   ・其他所有情況(service_role —— 就算帶著別人的 sub、資料庫直接執行 SQL)⇒ 一律做檢查。
  --     這些角色會繞過 RLS,上一版判成「沒權限 ⇒ 跳過」會讓重疊時段直接寫進去。
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not (private.can_manage_business_hours(private.staff_merchant_id(new.staff_id))
              or private.can_self_manage_availability(new.staff_id)) then
    raise exception '沒有權限設定這位服務人員的可預約時段' using errcode = '42501';
  end if;

  if new.end_time <= new.start_time then
    raise exception '開始時間必須早於結束時間';
  end if;

  -- 同一位服務人員同時兩個寫入時避免都通過檢查:先鎖住這位服務人員那一列(只鎖、不改,不會觸發任何 trigger)。
  -- for no key update:擋住同時的另一個時段寫入就夠了,不擋別張表用外鍵參照這一列(例如同時建單)。
  perform 1 from public.merchant_staff ms where ms.id = new.staff_id for no key update;

  select w.start_time, w.end_time into v_other
  from public.staff_availability_windows w
  where w.staff_id = new.staff_id
    and w.day_of_week = new.day_of_week
    and w.id <> new.id
    and w.start_time < new.end_time
    and new.start_time < w.end_time
  order by w.start_time
  limit 1;

  if found then
    raise exception '這個時段跟同一天已設定的「%–%」重疊，請調整時間。',
      to_char(v_other.start_time, 'HH24:MI'),
      case when v_other.end_time = '24:00:00'::time then '24:00' else to_char(v_other.end_time, 'HH24:MI') end;
  end if;

  return new;
end;
$function$;

comment on function private.tg_staff_availability_windows_validate() is 'SPECS-INDEX #1024(第 22 批):staff_availability_windows 新增 / 修改(INSERT / UPDATE)前檢查 —— 開始 < 結束(白話訊息,取代 CHECK 約束的英文錯誤)、同一位服務人員同一天的時段不能重疊(相接不算)。前端角色(anon / authenticated)沒有寫入權限 ⇒ 直接 42501、不做重疊查詢(不洩漏別人的時段);service_role / 直接 SQL 一律檢查。🔴 之後任何 SECURITY DEFINER RPC 只要寫這張表,必須自己檢查重疊與權限,不能假設這支 trigger 會替它擋權限(trigger 只對前端角色判權限)。三個角色都沒有 EXECUTE(只由 trigger 呼叫)。';

revoke execute on function private.tg_staff_availability_windows_validate() from public, anon, authenticated;

drop trigger if exists staff_availability_windows_validate on public.staff_availability_windows;
create trigger staff_availability_windows_validate
before insert or update of staff_id, day_of_week, start_time, end_time on public.staff_availability_windows
for each row execute function private.tg_staff_availability_windows_validate();
