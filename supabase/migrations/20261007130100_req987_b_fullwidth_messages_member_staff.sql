-- SPECS-INDEX #987 第 10 批 子批 10-b:會員 / 紅利 / 服務人員 / 客服 / 排班類錯誤訊息的半形標點改全形
-- 規格書 .project/specs/資料庫錯誤訊息全形標點-第10批.md
--
-- 做法(規格 1-3):每支函式的底稿 = 本機套完 20261007120200 之後的 pg_get_functiondef(oid),
-- 除了訊息字串裡「中文旁的半形 , : ; ! ?」改成全形以外逐字保留(空白、換行、註解、屬性都不動)。
-- 半形括號 ( )、斜線 /、金額千分位、時間冒號、% 佔位符一律不動。
-- 「名稱: %」這種冒號後面的半形空白一起拿掉(全形冒號本身就有間距)。
-- 逐字保留的證明:supabase/tests/database/req987_02_fullwidth_messages_b.sql(新訊息換回舊訊息後 md5 = 下方改前指紋)。
--
-- 本支重建 25 支函式;改前指紋 md5(replace(prosrc, E'\r\n', E'\n')):
--   7d7219e604c42778bdf4f2a25987d140  private.protect_merchant_member_settings_rule_columns()
--   062526f9f0e72e903fdd69dd2bf16d84  private.protect_merchant_staff_pending_login_email_columns()
--   69fa3e54b23a81ee8c9f348960106b5d  public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text)
--   186d47d477d7138eb85458e32c02a0b2  public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric)
--   a5bc1c7a8aa84f15b0b2795cb719e89f  public.cancel_staff_leave(p_leave_id uuid)
--   774ae843a7b3b90a343f5ae3f313b511  public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone)
--   51b907fc57ae50a5e5a69372f0d15ead  public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid)
--   7c28d62da89eb4a0a917dde65e708a04  public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean)
--   5224c85cef1af7834b681f4889f2d25f  public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)
--   2c42c7b32205a02674a5d3db0e5b39fd  public.get_my_booking_status_colors(p_staff_id uuid)
--   7394c1584de33df93d893313d68e2bf0  public.get_my_calendar_state_styles(p_staff_id uuid)
--   de074329ca23b6c16964cbdc35e7b1fc  public.get_my_day_business_hours(p_staff_id uuid, p_date date)
--   02d52ca220fda3b7be562b13432447b3  public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)
--   70607cbe6ba2deeea6bef7e665aa9c32  public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)
--   7376bd66cbc6566aaf60d0ffddc0a1a5  public.reactivate_member(p_member_id uuid)
--   47874cae260caf3ff162cdaecae0cfb7  public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text)
--   2c1a7a18a78272d1ab9dc15c0020f153  public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text)
--   78d77a28b4761b8b80b2d6d917520345  public.redeem_member_points(p_member_id uuid, p_points integer, p_note text)
--   ed26190fca9e17b0cc98844920fcbfd7  public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean)
--   8515cd87ff2e36e03103e23222cd503c  public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])
--   d0e3666bedd28a93e8e273e08b798663  public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid)
--   e941adeb472834e4198828cef69c1f65  public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text)
--   6f7f0e4d0d2445f0d06a65bf8ab40c0e  public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text)
--   f61661e5fab53790e42fb24a259ccecf  public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text)
--   72b25242dc98820b4f4a4b4650eb41ba  public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)

-- ===== private.protect_merchant_member_settings_rule_columns()(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION private.protect_merchant_member_settings_rule_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- 這次異動有沒有真的改動到「紅利點數規則」那些欄位。
  v_touches_points_rules boolean;
  -- 這次異動有沒有真的改動到「會員政策」那兩個欄位。
  v_touches_policy boolean;
  v_merchant_id uuid;
begin
  if tg_op = 'INSERT' then
    -- INSERT:old 是 NULL,不能寫 `is distinct from old.xxx`(對 NULL record 取欄位在 plpgsql
    -- 觸發器裡會直接 raise)。改成判斷「有沒有主動帶了非預設值」,預設值以 schema 實際宣告為準。
    v_touches_points_rules :=
      coalesce(new.points_feature_enabled, true) is distinct from true
      or coalesce(new.reward_condition_mode, 'none') is distinct from 'none'
      or coalesce(new.referral_bonus_points, 0) is distinct from 0
      or coalesce(new.birthday_bonus_points, 0) is distinct from 0
      -- 紅利系統重構 §1.1 A 紅利計算
      or coalesce(new.earn_mode, 'basic') is distinct from 'basic'
      or coalesce(new.basic_points_per_order, 0) is distinct from 0
      or coalesce(new.basic_min_amount, 0) is distinct from 0::numeric
      or coalesce(new.basic_tiered_enabled, false) is distinct from false
      -- §1.1 B 點數使用
      or coalesce(new.redeem_points_unit, 0) is distinct from 0
      or coalesce(new.redeem_amount_unit, 0) is distinct from 0::numeric
      or coalesce(new.redeem_max_ratio_percent, 0) is distinct from 0
      -- §1.1 C 推薦系統
      or coalesce(new.referral_inviter_reward_enabled, false) is distinct from false
      or coalesce(new.referral_subsequent_bonus_points, 0) is distinct from 0
      or coalesce(new.referral_inviter_earning_enabled, true) is distinct from true
      or coalesce(new.referral_invitee_earning_enabled, true) is distinct from true
      -- §1.1 D 生日獎勵
      or coalesce(new.birthday_bonus_enabled, false) is distinct from false
      or coalesce(new.birthday_line_message, '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。')
           is distinct from '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。';

    v_touches_policy :=
      coalesce(new.policy_enabled, false) is distinct from false
      or new.policy_content is not null;

    v_merchant_id := new.merchant_id;
  else
    -- UPDATE:比對「值有沒有真的被改動」。這是整支 trigger 的關鍵——用 is distinct from 而不是
    -- 「payload 有沒有帶這個欄位」,所以 MemberSettingsPage 存會員政策時把規則欄位原樣
    -- 送一次(值沒變)完全不會觸發規則組的檢查,反之亦然。
    v_touches_points_rules :=
      new.points_feature_enabled is distinct from old.points_feature_enabled
      or new.reward_condition_mode is distinct from old.reward_condition_mode
      or new.referral_bonus_points is distinct from old.referral_bonus_points
      or new.birthday_bonus_points is distinct from old.birthday_bonus_points
      -- 紅利系統重構 §1.1 A 紅利計算
      or new.earn_mode is distinct from old.earn_mode
      or new.basic_points_per_order is distinct from old.basic_points_per_order
      or new.basic_min_amount is distinct from old.basic_min_amount
      or new.basic_tiered_enabled is distinct from old.basic_tiered_enabled
      -- §1.1 B 點數使用
      or new.redeem_points_unit is distinct from old.redeem_points_unit
      or new.redeem_amount_unit is distinct from old.redeem_amount_unit
      or new.redeem_max_ratio_percent is distinct from old.redeem_max_ratio_percent
      -- §1.1 C 推薦系統
      or new.referral_inviter_reward_enabled is distinct from old.referral_inviter_reward_enabled
      or new.referral_subsequent_bonus_points is distinct from old.referral_subsequent_bonus_points
      or new.referral_inviter_earning_enabled is distinct from old.referral_inviter_earning_enabled
      or new.referral_invitee_earning_enabled is distinct from old.referral_invitee_earning_enabled
      -- §1.1 D 生日獎勵
      or new.birthday_bonus_enabled is distinct from old.birthday_bonus_enabled
      or new.birthday_line_message is distinct from old.birthday_line_message;

    v_touches_policy :=
      new.policy_enabled is distinct from old.policy_enabled
      or new.policy_content is distinct from old.policy_content;

    -- 用 old.merchant_id(這一列目前歸屬的商家)。merchant_id 是主鍵,理論上不會被改,
    -- 這裡比照 20260924020100 的既有寫法多一層保險。
    v_merchant_id := old.merchant_id;
  end if;

  if v_touches_points_rules
     -- 放行路徑:service_role(後台維運 / Edge Function)。目前沒有任何 Edge Function 會寫
     -- 這張表,保留這道是為了跟既有三支保護 trigger 的結構一致,不留下「將來多一條路徑就爆掉」
     -- 的落差。
     and auth.role() <> 'service_role'
     and not private.can_manage_member_points(v_merchant_id)
  then
    raise exception '紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改；「會員管理」權限可以做手動調整與登記兌換，但不能改這些規則'
      using errcode = '42501';
  end if;

  if v_touches_policy
     and auth.role() <> 'service_role'
     and not private.can_manage_member_settings(v_merchant_id)
  then
    raise exception '會員政策(啟用開關與政策內容)需要「會員系統設定」權限才能修改'
      using errcode = '42501';
  end if;

  return new;
end;
$function$;

-- private.protect_merchant_member_settings_rule_columns():改前 proacl 為 NULL(預設權限);create or replace 不會動到 ACL,這裡刻意不下 grant / revoke(下了反而會把 NULL 變成明確清單)。

-- ===== private.protect_merchant_staff_pending_login_email_columns()(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION private.protect_merchant_staff_pending_login_email_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (new.pending_admin_login_email is distinct from old.pending_admin_login_email
      or new.pending_admin_login_email_requested_by is distinct from old.pending_admin_login_email_requested_by
      or new.pending_admin_login_email_requested_at is distinct from old.pending_admin_login_email_requested_at)
     and auth.role() <> 'service_role'
     and coalesce(current_setting('staff_agent.bypass_pending_login_email_guard', true), 'off') <> 'on'
  then
    raise exception '不能透過一般編輯直接變更登入信箱建議，請透過「修改登入信箱」的功能操作'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;

-- private.protect_merchant_staff_pending_login_email_columns():改前 proacl 為 NULL(預設權限);create or replace 不會動到 ACL,這裡刻意不下 grant / revoke(下了反而會把 NULL 變成明確清單)。

-- ===== public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_balance integer;
  v_new_balance integer;
  v_result public.members;
begin
  select merchant_id, points_balance into v_merchant_id, v_balance
  from public.members
  where id = p_member_id
  for update;

  if not found then
    raise exception '找不到這位會員';
  end if;

  -- 規則 2.6(核心):只檢查 private.is_merchant_admin,不接受客服呼叫,即使該客服已經被授權
  -- members 這個 section_key 也一樣被擋下。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '手動調整會員點數，只有商家管理員可以操作' using errcode = '42501';
  end if;

  if p_points_delta is null or p_points_delta = 0 then
    raise exception '調整點數不可為 0';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception '請填寫調整原因';
  end if;

  v_new_balance := v_balance + p_points_delta;

  if v_new_balance < 0 then
    raise exception '這位會員目前只有 % 點，調整後不能變成負數', v_balance;
  end if;

  insert into public.member_point_transactions (
    member_id, merchant_id, transaction_type, points_delta, balance_after, note, created_by_user_id
  ) values (
    p_member_id, v_merchant_id, 'manual_adjustment', p_points_delta, v_new_balance, p_note, auth.uid()
  );

  update public.members set points_balance = v_new_balance where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text) from PUBLIC, anon;
grant execute on function public.adjust_member_points(p_member_id uuid, p_points_delta integer, p_note text) to authenticated, service_role;

-- ===== public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_compensation_type text;
begin
  select merchant_id, compensation_type into v_merchant_id, v_compensation_type
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_manage_commission_settings(v_merchant_id) then
    raise exception '沒有權限設定這間商家的抽成' using errcode = '42501';
  end if;

  if v_compensation_type <> 'piece_rate' then
    raise exception '只有按件計酬的服務人員可以設定抽成';
  end if;

  if p_commission_mode not in ('percentage', 'fixed_amount') then
    raise exception '抽成模式必須是 percentage 或 fixed_amount';
  end if;

  if p_commission_value < 0 then
    raise exception '抽成數值不可為負數';
  end if;

  if p_commission_mode = 'percentage' and p_commission_value > 100 then
    raise exception '百分比模式下，抽成數值必須介於 0~100 之間';
  end if;

  insert into public.staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
  select p_staff_id, item_id, p_commission_mode, p_commission_value
  from unnest(p_service_item_ids) as item_id
  on conflict (staff_id, service_item_id) do update
    set commission_mode = excluded.commission_mode,
        commission_value = excluded.commission_value;
end;
$function$;

revoke execute on function public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric) from PUBLIC, anon;
grant execute on function public.batch_apply_staff_service_commission_rates(p_staff_id uuid, p_service_item_ids uuid[], p_commission_mode text, p_commission_value numeric) to authenticated, service_role;

-- ===== public.cancel_staff_leave(p_leave_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.cancel_staff_leave(p_leave_id uuid)
 RETURNS staff_leave_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.staff_leave_records;
begin
  select ms.merchant_id, slr.status
  into v_merchant_id, v_status
  from public.staff_leave_records slr
  join public.merchant_staff ms on ms.id = slr.staff_id
  where slr.id = p_leave_id;

  if not found then
    raise exception '找不到這筆請假紀錄';
  end if;

  if not private.can_manage_team_leave(v_merchant_id) then
    raise exception '沒有權限管理這間商家的請假紀錄' using errcode = '42501';
  end if;

  if v_status <> 'confirmed' then
    raise exception '這筆請假紀錄目前狀態不是「進行中」，無法取消(目前狀態：%)', v_status;
  end if;

  update public.staff_leave_records
  set status = 'cancelled', cancelled_at = now()
  where id = p_leave_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.cancel_staff_leave(p_leave_id uuid) from PUBLIC, anon;
grant execute on function public.cancel_staff_leave(p_leave_id uuid) to authenticated, service_role;

-- ===== public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
begin
  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  if not (private.can_manage_business_hours(v_merchant_id) or private.can_self_manage_availability(p_staff_id)) then
    raise exception '沒有權限設定這位服務人員的可預約狀態' using errcode = '42501';
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

  delete from public.staff_availability_overrides
  where staff_id = p_staff_id
    and override_date = p_override_date
    and slot_start_time >= p_start_time
    and slot_start_time < p_end_time;
end;
$function$;

revoke execute on function public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone) from PUBLIC, anon;
grant execute on function public.clear_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone) to authenticated, service_role;

-- ===== public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid)(改 6 則訊息)=====
CREATE OR REPLACE FUNCTION public.create_member(p_merchant_id uuid, p_name text, p_phone text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_birthday date DEFAULT NULL::date, p_notes text DEFAULT NULL::text, p_referred_by_member_id uuid DEFAULT NULL::uuid, p_tier_id uuid DEFAULT NULL::uuid)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_referral_code text;
  v_attempt int := 0;
  v_result public.members;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
  v_constraint_name text;
begin
  if not (private.can_manage_members(p_merchant_id) or private.can_manage_bookings(p_merchant_id)) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除(電話這次只當查詢索引,不是必填欄位,見 #614/§10.2)。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)「把 #827 一起修掉」):
  -- 會員電話的格式檢查。規則本體沿用 #822 的 private.is_valid_taiwan_phone(跟 create_booking /
  -- update_booking / 兩支匯入函式同一條規則,不另外寫第二套正規表示式)。
  -- 🔴 必須排在下面 #931 唯一性檢查的**前面**:格式明顯不對的電話應該拿到「格式不正確」這個精準訊息,
  --    而不是先被拿去跟既有會員比對(髒電話正規化之後可能剛好撞到別人,訊息就會完全誤導)。
  -- 電話留空維持合法(#618 之後會員電話是選填),所以是 `p_phone is not null` 才檢查。
  -- 🟢 2026-09-30 唯讀核對:正式庫 119 筆有填電話的會員**全部通過**這條規則(不合格 0 筆),
  --    所以現在補上檢查不會弄壞任何存量資料,也不需要先清資料。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):同商家 + 同一支電話只能有一位 active 會員。
  -- 只比對 status = 'active'(使用者明確裁決:已下架的同號紀錄不擋新建,因為它看不見卻擋得住)。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用這一筆；如果真的是不同的人，請改填另一支電話', v_conflict_name;
    end if;
  end if;

  if p_referred_by_member_id is not null then
    if not exists (
      select 1 from public.members
      where id = p_referred_by_member_id
        and merchant_id = p_merchant_id
        and status = 'active'
    ) then
      raise exception '找不到指定的推薦人，或推薦人不屬於這間商家/已被下架';
    end if;
  end if;

  -- #615:會員分級。有指定 p_tier_id 時,必須屬於同一商家且 status='active'。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = p_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級，或不屬於這間商家/已下架';
    end if;
  end if;

  loop
    v_referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.members (
        merchant_id, name, phone, email, birthday, notes,
        referred_by_member_id, referral_code, created_by_user_id, tier_id
      ) values (
        p_merchant_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_email, '')), ''), p_birthday, p_notes,
        p_referred_by_member_id, v_referral_code, auth.uid(), p_tier_id
      )
      returning * into v_result;
      exit;
    exception when unique_violation then
      -- SPECS-INDEX #931:先分辨是哪一個約束撞到。不分辨的話,電話撞號會被當成推薦碼撞號,
      -- 重試 5 次之後丟出「產生推薦碼失敗」這個完全誤導的訊息(見本節開頭的說明)。
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'members_merchant_active_phone_uniq' then
        -- 走到這裡代表是併發:上面的事前檢查通過時那一筆還沒 commit。
        -- 重新查一次姓名(這是新的一個敘述,拿到新的 snapshot,所以看得到對方剛 commit 的那一列)。
        select m.name into v_conflict_name
        from public.members m
        where m.merchant_id = p_merchant_id
          and m.status = 'active'
          and private.normalize_phone(m.phone) = v_normalized_phone
        limit 1;

        raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用這一筆；如果真的是不同的人，請改填另一支電話',
          coalesce(v_conflict_name, '(同一時間剛好有人用這支電話建立了會員)');
      end if;

      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise exception '產生推薦碼失敗，請重新再試一次';
      end if;
    end;
  end loop;

  return v_result;
end;
$function$;

revoke execute on function public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid) from PUBLIC, anon;
grant execute on function public.create_member(p_merchant_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_referred_by_member_id uuid, p_tier_id uuid) to authenticated, service_role;

-- ===== public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean)(改 4 則訊息)=====
CREATE OR REPLACE FUNCTION public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text DEFAULT NULL::text, p_confirm_despite_conflicts boolean DEFAULT false)
 RETURNS staff_leave_records
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_compensation_type text;
  v_leave_type_name text;
  v_conflict_count int;
  v_result public.staff_leave_records;
begin
  -- 1. 查 merchant_staff 取得 merchant_id/compensation_type,檢查權限。
  select merchant_id, compensation_type
  into v_merchant_id, v_compensation_type
  from public.merchant_staff
  where id = p_staff_id;

  if not found then
    raise exception '找不到這位服務人員';
  end if;

  if not private.can_manage_team_leave(v_merchant_id) then
    raise exception '沒有權限管理這間商家的請假紀錄' using errcode = '42501';
  end if;

  -- 2. 規則 2.2:只有月薪制服務人員可以登記請假紀錄。
  if v_compensation_type <> 'monthly_salary' then
    raise exception '只有月薪制的服務人員可以登記請假紀錄，請先確認這位服務人員的計酬方式(在服務人員管理頁編輯)';
  end if;

  -- 3. end_date >= start_date(資料表 CHECK 約束也會擋,這裡提前給白話錯誤訊息)。
  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 4. 規則 2.5:同一服務人員的 confirmed 請假區間不能重疊,沒有覆寫例外。
  if exists (
    select 1
    from public.staff_leave_records slr
    where slr.staff_id = p_staff_id
      and slr.status = 'confirmed'
      and daterange(slr.start_date, slr.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception '這位服務人員在這段期間已經有其他請假紀錄，日期區間不能重疊';
  end if;

  -- 5. 規則 2.6:既有預約衝突,警示但不強制擋下——有衝突且沒有確認旗標就擋下並回傳筆數。
  select count(*) into v_conflict_count
  from public.preview_staff_leave_conflicts(p_staff_id, p_start_date, p_end_date);

  if v_conflict_count > 0 and not coalesce(p_confirm_despite_conflicts, false) then
    raise exception '這段期間已經有 % 筆預約，請先確認清單後再登記請假', v_conflict_count;
  end if;

  -- 6. 假別必須屬於同一商家且 status='active'(已下架的假別只留給歷史紀錄快照顯示用)。
  select name into v_leave_type_name
  from public.merchant_leave_types
  where id = p_leave_type_id and merchant_id = v_merchant_id and status = 'active';

  if not found then
    raise exception '找不到這個假別，或已下架';
  end if;

  -- 7. 通過後寫入,status 固定 'confirmed'(這次不做簽核流程,建立即生效)。
  insert into public.staff_leave_records (
    staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, notes, status, created_by_user_id
  ) values (
    p_staff_id, p_leave_type_id, v_leave_type_name, p_start_date, p_end_date, p_notes, 'confirmed', auth.uid()
  )
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) from PUBLIC, anon;
grant execute on function public.create_staff_leave(p_staff_id uuid, p_leave_type_id uuid, p_start_date date, p_end_date date, p_notes text, p_confirm_despite_conflicts boolean) to authenticated, service_role;

-- ===== public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_show_member_info boolean;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_result jsonb;
begin
  -- 1. 規則 2.4(核心必測):必須是本人,且已開通 staff_calendar_view。
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的行事曆' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_calendar_view') then
    raise exception '尚未開通行事曆檢視功能，請洽商家管理員' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 2. 範圍上限(建議 62 天,避免一次查詢範圍過大拖垮效能)。
  if (p_end_date - p_start_date) > 62 then
    raise exception '查詢範圍不能超過 62 天，請分批查詢' using errcode = '22023';
  end if;

  select ms.merchant_id, ms.show_member_info
  into v_merchant_id, v_show_member_info
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  v_range_start := (p_start_date::timestamp) at time zone 'Asia/Taipei';
  v_range_end := ((p_end_date + 1)::timestamp) at time zone 'Asia/Taipei';

  -- 3. 規則 2.5:涵蓋「主要服務人員」與「助手」兩種身份(比照 set_staff_day_override 既有的
  -- 既有預約衝突查詢邏輯,bookings 跟 booking_assistants 兩邊都查)。
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', bb.id,
      'start_at', bb.start_at,
      'end_at', bb.end_at,
      'status', bb.status,
      'role_in_booking', bb.role_in_booking,
      'customer_name', bb.customer_name,
      -- SPECS-INDEX #977(2026-10-06,第 3 批,使用者裁決 H-13):「服務人員是否顯示會員資料」關閉時,
      -- 服務人員只看得到客戶姓名 ⇒ 電話、地址**在這裡就不回傳**(null),不是送出去再讓前端不顯示。
      -- 開啟時照舊。這支是服務人員端唯一會回傳客戶電話 / 地址的出口(盤點表見回報)。
      'customer_phone', case when v_show_member_info then bb.customer_phone else null end,
      'customer_address', case when v_show_member_info then bb.customer_address else null end,
      -- SPECS-INDEX #851:內部備註逐單隱藏(2026-09-30)。旗標為 true 時這裡就是 null,
      -- 回應 JSON 裡**沒有那段文字**,不是「有送出但前端不顯示」。
      -- 🔴 主腦裁決 T1=A:不額外回傳「本來有沒有備註」的布林 —— 那會洩漏「存在性」,
      --    也會讓服務人員端出現「這裡有秘密」的提示,跟這次要藏的初衷相反。
      -- 🔴 主腦裁決 T4:primary 與 assistant 同待遇,所以這裡不判斷 bb.role_in_booking。
      'notes', case when bb.hide_notes_from_staff then null else bb.notes end,
      'customer_notes', bb.customer_notes,
      'service_item_names', coalesce(si_agg.names, '[]'::jsonb),
      'final_amount_snapshot', bb.final_amount_snapshot,
      -- 規則 2.6:基本資訊一律回傳,只有 show_member_info=true 時才附上會員專屬欄位;
      -- 沒有連結會員(member_id is null)時這幾項一律是 null,跟關掉開關時的結果一致。
      'is_member', case when v_show_member_info then (bb.member_id is not null) else null end,
      'member_name', case
        when v_show_member_info and bb.member_id is not null then bb.member_name_snapshot
        else null
      end,
      'member_points_balance', case
        when v_show_member_info and bb.member_id is not null then m.points_balance
        else null
      end
    )
    order by bb.start_at
  ), '[]'::jsonb)
  into v_result
  from (
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      b.hide_notes_from_staff,
      'primary'::text as role_in_booking
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
    union all
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      b.hide_notes_from_staff,
      'assistant'::text as role_in_booking
    from public.booking_assistants ba
    join public.bookings b on b.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
  ) bb
  left join public.members m on m.id = bb.member_id
  left join lateral (
    select jsonb_agg(si.name order by si.name) as names
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = bb.id
  ) si_agg on true;

  return v_result;
end;
$function$;

revoke execute on function public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date) from PUBLIC, anon;
grant execute on function public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date) to authenticated, service_role;

-- ===== public.get_my_booking_status_colors(p_staff_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_my_booking_status_colors(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的訂單狀態顏色設定' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  -- 只挑 4 個色碼,不回傳整列(不給 merchant_id / created_at / updated_at,也不會因為這張表
  -- 日後多欄位就自動多給)。查無資料時回 '{}'::jsonb,由前端 fallback 成
  -- DEFAULT_BOOKING_STATUS_COLORS —— 跟 get_my_calendar_state_styles 完全相同的慣例。
  select jsonb_build_object(
           'pending_confirmation_color', c.pending_confirmation_color,
           'accepted_color', c.accepted_color,
           'completed_color', c.completed_color,
           'cancelled_color', c.cancelled_color
         )
    into v_result
  from public.merchant_booking_status_colors c
  where c.merchant_id = v_merchant_id;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

revoke execute on function public.get_my_booking_status_colors(p_staff_id uuid) from PUBLIC, anon;
grant execute on function public.get_my_booking_status_colors(p_staff_id uuid) to authenticated, service_role;

-- ===== public.get_my_calendar_state_styles(p_staff_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_my_calendar_state_styles(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的行事曆顏色設定' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  select coalesce(jsonb_object_agg(state_type, color), '{}'::jsonb)
  into v_result
  from public.merchant_calendar_state_styles
  where merchant_id = v_merchant_id;

  return v_result;
end;
$function$;

revoke execute on function public.get_my_calendar_state_styles(p_staff_id uuid) from PUBLIC, anon;
grant execute on function public.get_my_calendar_state_styles(p_staff_id uuid) to authenticated, service_role;

-- ===== public.get_my_day_business_hours(p_staff_id uuid, p_date date)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.get_my_day_business_hours(p_staff_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_day_of_week smallint;
  v_has_hours boolean;
  v_is_closed boolean;
  v_open_time time;
  v_close_time time;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的營業時間' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  v_day_of_week := extract(dow from p_date)::smallint;

  select true, is_closed, open_time, close_time
  into v_has_hours, v_is_closed, v_open_time, v_close_time
  from public.merchant_business_hours
  where merchant_id = v_merchant_id and day_of_week = v_day_of_week;

  return jsonb_build_object(
    'has_setting', coalesce(v_has_hours, false),
    'is_closed', coalesce(v_is_closed, true),
    'open_time', v_open_time,
    'close_time', v_close_time
  );
end;
$function$;

revoke execute on function public.get_my_day_business_hours(p_staff_id uuid, p_date date) from PUBLIC, anon;
grant execute on function public.get_my_day_business_hours(p_staff_id uuid, p_date date) to authenticated, service_role;

-- ===== public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_operation_id uuid;
  v_total_rows int;
  v_success_rows int := 0;
  v_failed_rows int := 0;
  v_error_report jsonb := '[]'::jsonb;
  v_row jsonb;
  v_idx int;
  v_row_number int;
  v_customer_name text;
  v_customer_phone text;
  v_customer_email text;
  v_customer_address text;
  v_customer_notes text;
  v_staff_id uuid;
  v_start_at timestamptz;
  v_duration_minutes int;
  v_end_at timestamptz;
  v_status_raw text;
  v_status text;
  v_service_description text;
  v_final_amount numeric(10, 2);
  v_subtotal_amount numeric(10, 2);
  v_discount_amount numeric(10, 2);
  v_tax_amount numeric(10, 2);
  v_payment_method text;
  v_member_phone text;
  v_member_id uuid;
  v_member_name text;
  v_booking_id uuid;
begin
  -- 規則 2.1(核心):只有商家管理員能發動批次匯入。
  if not private.is_merchant_admin(p_merchant_id) then
    raise exception '批次匯入/資料搬遷，只有商家管理員可以操作' using errcode = '42501';
  end if;

  v_total_rows := jsonb_array_length(p_rows);

  if v_total_rows > 2000 then
    raise exception '單批匯入最多 2,000 筆資料，這次上傳了 % 筆，請分批匯入', v_total_rows;
  end if;

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, total_rows, created_by_user_id
  ) values (
    p_merchant_id, 'historical_booking_import', v_total_rows, auth.uid()
  ) returning id into v_operation_id;

  for v_idx in 0 .. v_total_rows - 1 loop
    v_row := p_rows -> v_idx;
    begin
      v_row_number := coalesce((v_row->>'row_number')::int, v_idx + 1);
      v_customer_name := nullif(btrim(coalesce(v_row->>'customer_name', '')), '');
      v_customer_phone := nullif(btrim(coalesce(v_row->>'customer_phone', '')), '');
      v_customer_email := nullif(btrim(coalesce(v_row->>'customer_email', '')), '');
      v_customer_address := nullif(btrim(coalesce(v_row->>'customer_address', '')), '');
      v_customer_notes := nullif(btrim(coalesce(v_row->>'customer_notes', '')), '');
      v_staff_id := nullif(v_row->>'staff_id', '')::uuid;
      v_start_at := nullif(v_row->>'start_at', '')::timestamptz;
      v_duration_minutes := nullif(v_row->>'duration_minutes', '')::int;
      v_service_description := nullif(btrim(coalesce(v_row->>'service_description', '')), '');
      v_payment_method := nullif(btrim(coalesce(v_row->>'payment_method', '')), '');
      v_member_phone := nullif(btrim(coalesce(v_row->>'member_phone', '')), '');

      -- 必填欄位驗證。
      if v_customer_name is null then
        raise exception '缺少必填欄位：客戶姓名';
      end if;
      if v_customer_phone is null then
        raise exception '缺少必填欄位：客戶電話';
      end if;
      -- SPECS-INDEX #824(2026-09-28):客戶電話格式檢查,規則本體沿用 #822 的 private.is_valid_taiwan_phone
      -- (跟 create_booking / update_booking 同一條規則,手機或市話、市話可帶 # 分機、分隔符號不強制)。
      -- raise 出去會被下面既有的 exception when others 接住 → 這一列算 failed、寫進 error_report,
      -- 其他列不受影響(匯入模組既有的逐列回報慣例,不整批失敗)。
      if not private.is_valid_taiwan_phone(v_customer_phone) then
        raise exception '「客戶電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)', v_customer_phone;
      end if;
      if v_staff_id is null then
        raise exception '缺少必填欄位：服務人員';
      end if;
      if v_start_at is null then
        raise exception '缺少必填欄位：預約時間，或時間格式無法辨識';
      end if;
      if nullif(v_row->>'final_amount', '') is null then
        raise exception '缺少必填欄位：訂單金額';
      end if;
      v_final_amount := (v_row->>'final_amount')::numeric(10, 2);
      if v_final_amount < 0 then
        raise exception '訂單金額不可為負數';
      end if;

      -- staff_id 必須是這個商家底下存在的服務人員(3.3 數值對應步驟保證，這裡再次防呆)。
      if not exists (
        select 1 from public.merchant_staff where id = v_staff_id and merchant_id = p_merchant_id
      ) then
        raise exception '指定的服務人員不存在於這個商家';
      end if;

      -- end_at：有工時欄位就用，沒有預設 60 分鐘(規則 2.3/3.4)。
      v_end_at := v_start_at + make_interval(mins => coalesce(v_duration_minutes, 60));

      -- status 正規化(規則 3.4)。
      v_status_raw := lower(btrim(coalesce(v_row->>'status', '')));
      v_status := case
        when v_status_raw in ('completed', '已完成', 'complete') then 'completed'
        when v_status_raw in ('cancelled', '已取消', 'canceled') then 'cancelled'
        else 'completed'
      end;

      -- 選填進階金額欄位：final_amount 是唯一權威金額，subtotal/discount/tax 只是分項顯示。
      --
      -- 2026-09-24(任務 4,使用者裁決:「…如果是舊訂單匯入,在稅金欄位沒有填寫金額就當作總營收
      -- (未稅)去計算。」):折扣/稅金要先解析出來,因為下面反推未稅小計時會用到它們。
      -- 這兩行的內容本身完全沒變,只是從 subtotal 那一行的下面搬到上面。
      v_discount_amount := coalesce(nullif(v_row->>'discount_amount', '')::numeric(10, 2), 0);
      v_tax_amount := coalesce(nullif(v_row->>'tax_amount', '')::numeric(10, 2), 0);

      -- 未稅小計(subtotal_amount_snapshot)。這個欄位直接決定帳務報表的
      -- total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
      -- 所以它「含不含稅」這件事必須完全正確。
      v_subtotal_amount := nullif(v_row->>'subtotal_amount', '')::numeric(10, 2);

      if v_subtotal_amount is null then
        if v_tax_amount > 0 then
          -- 稅金有填、小計沒填:依 .project/specs/訂單管理.md §2.3 的四則順序
          -- (final = subtotal − discount + tax)對 subtotal 移項反推:
          --   subtotal = final_amount + discount − tax
          -- 例:CSV 只有「金額 1050 / 稅金 50」(沒有折扣)→ 小計 = 1050 + 0 − 50 = 1000,
          -- 未稅營收算出 1000 而不是 1050,那 50 元稅金不再被算進營收裡。
          v_subtotal_amount := v_final_amount + v_discount_amount - v_tax_amount;

          -- 防呆:反推出負數代表 CSV 這一列本身矛盾(稅金比訂單總金額還大)。不靜默寫入負數
          -- 小計(那會讓報表營收莫名變少還很難查),拋白話錯誤訊息讓這一列進 error_report,
          -- 商家自己去修那一列就好,不影響同一批其他正常的列(這個迴圈是逐列 exception 處理)。
          if v_subtotal_amount < 0 then
            raise exception '稅金金額(%)大於訂單金額(%)，無法推算未稅小計，請確認這一列的金額與稅金欄位',
              v_tax_amount, v_final_amount;
          end if;
        else
          -- 稅金沒填或是 0:完全照使用者裁決原文——總金額直接當未稅營收,不做任何反推。
          v_subtotal_amount := v_final_amount;
        end if;
      end if;

      -- 會員連結(選填，規則 3.4：只比對既有 active 會員，不建立新會員)。
      v_member_id := null;
      v_member_name := null;
      if v_member_phone is not null and private.normalize_phone(v_member_phone) is not null then
        select id, name into v_member_id, v_member_name
        from public.members
        where merchant_id = p_merchant_id
          and status = 'active'
          and private.normalize_phone(phone) = private.normalize_phone(v_member_phone)
        limit 1;
      end if;

      -- 注意:bookings.payment_method(text)這個舊欄位在模組 9 v2 已經被拿掉，改成
      -- payment_method_id(外鍵，指向 payment_methods)+ payment_method_name_snapshot(文字快照)。
      -- 歷史匯入的付款方式文字不保證能對應到這個商家「現在」的付款方式清單，比照第一節 1.3
      -- service_description_snapshot 的精神，直接存成文字快照，不嘗試比對/建立 payment_methods
      -- 資料列，payment_method_id 一律留 null。
      insert into public.bookings (
        merchant_id, staff_id, customer_name, customer_phone, customer_email, customer_address,
        customer_notes, start_at, end_at, status, source, created_by_role, created_by_user_id,
        service_description_snapshot, subtotal_amount_snapshot, discount_amount_snapshot,
        tax_amount_snapshot, final_amount_snapshot, payment_method_name_snapshot, member_id,
        member_name_snapshot,
        -- 2026-09-24(任務 1 的根因修正):原本這個 INSERT 完全沒有 completed_at,所以每一筆
        -- 匯入的已完成訂單 completed_at 都是 null(正式環境那 14 筆就是這樣來的)。任務 1 之後
        -- 帳務報表改用「完成時間」分月,不補這一欄就等於每次匯入都繼續製造報表撈不到的資料。
        completed_at
      ) values (
        p_merchant_id, v_staff_id, v_customer_name, v_customer_phone, v_customer_email,
        v_customer_address, v_customer_notes, v_start_at, v_end_at, v_status, 'import', 'admin',
        auth.uid(), v_service_description, v_subtotal_amount, v_discount_amount, v_tax_amount,
        v_final_amount, v_payment_method, v_member_id, v_member_name,
        -- 用 v_start_at 而不是 now():歷史訂單的「完成」發生在服務當天,不是按下匯入按鈕那天。
        -- 用 now() 會把 2024 年的營收整批算進匯入當月。status='cancelled' 維持 null(沒完成過)。
        case when v_status = 'completed' then v_start_at else null end
      ) returning id into v_booking_id;

      insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
        values (v_operation_id, 'bookings', v_booking_id, 'created');

      v_success_rows := v_success_rows + 1;
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
      error_report = v_error_report
  where id = v_operation_id;

  return v_operation_id;
end;
$function$;

revoke execute on function public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb) from PUBLIC, anon;
grant execute on function public.import_historical_bookings_batch(p_merchant_id uuid, p_rows jsonb) to authenticated, service_role;

-- ===== public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        raise exception '「電話」欄位格式不正確(這一列填的是「%」)。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)', v_phone;
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
            '這支電話已經有會員：%s —— 這一列已略過，沒有新建，也沒有修改這位既有會員的任何資料。同一間商家底下，一支電話只能有一位會員：如果就是同一位客戶，請把這一列從 CSV 裡移除；如果你本來就是想更新這位既有會員的資料，請改用「電話重複時更新既有會員資料」這個寫入模式重新匯入；如果真的是不同的人，請改填另一支電話',
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
$function$;

revoke execute on function public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb) from PUBLIC, anon;
grant execute on function public.import_members_batch(p_merchant_id uuid, p_write_mode text, p_rows jsonb) to authenticated, service_role;

-- ===== public.reactivate_member(p_member_id uuid)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.reactivate_member(p_member_id uuid)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_phone text;
  v_normalized_phone text;
  v_conflict_name text;
begin
  -- 原本只 select merchant_id,這次多取 phone(唯一性檢查要用)。
  select merchant_id, phone into v_merchant_id, v_phone
  from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  -- SPECS-INDEX #931(2026-09-30):重新上架等於讓這一列變成 active,所以要跟「其他 active 會員」
  -- 比對電話。`m.id <> p_member_id` 不可省(否則自己也會被算進去)。
  v_normalized_phone := private.normalize_phone(v_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '不能重新上架：這位會員的電話現在已經有另一位使用中的會員：%。同一間商家底下，一支電話只能有一位會員 —— 請先把其中一邊的電話改掉(或把那一位下架)，再重新上架這一位', v_conflict_name;
    end if;
  end if;

  update public.members set status = 'active' where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.reactivate_member(p_member_id uuid) from PUBLIC, anon;
grant execute on function public.reactivate_member(p_member_id uuid) to authenticated, service_role;

-- ===== public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_agent_id uuid;
  v_existing_status text;
begin
  if p_status not in ('invited', 'active') then
    raise exception '不合法的狀態：%', p_status;
  end if;

  if p_user_id is null then
    raise exception 'p_user_id 不可為 null';
  end if;

  select id, status into v_agent_id, v_existing_status
  from public.merchant_agents
  where merchant_id = p_merchant_id and user_id = p_user_id;

  if found then
    if v_existing_status in ('invited', 'active') then
      raise exception '這個人已經是這間店的客服了' using errcode = 'P0001';
    end if;

    -- 重新啟用舊的 removed 紀錄:更新既有列而不是插入新列,保留舊的權限設定
    -- (merchant_agent_permissions 透過 agent_id 外鍵掛在這個既有的 id 上,不會變成孤兒資料)。
    update public.merchant_agents
    set status = p_status,
        invited_email = p_invited_email,
        name = p_name,
        nickname = p_nickname,
        phone = p_phone,
        invited_at = now(),
        activated_at = case when p_status = 'active' then now() else null end
    where id = v_agent_id;

    return v_agent_id;
  end if;

  insert into public.merchant_agents (
    merchant_id, user_id, invited_email, name, nickname, phone, status, activated_at
  ) values (
    p_merchant_id, p_user_id, p_invited_email, p_name, p_nickname, p_phone, p_status,
    case when p_status = 'active' then now() else null end
  )
  returning id into v_agent_id;

  return v_agent_id;
end;
$function$;

revoke execute on function public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text) from PUBLIC, anon, authenticated;
grant execute on function public.record_invited_merchant_agent(p_merchant_id uuid, p_user_id uuid, p_invited_email text, p_name text, p_nickname text, p_phone text, p_status text) to service_role;

-- ===== public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text)(改 4 則訊息)=====
CREATE OR REPLACE FUNCTION public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_conflict_id uuid;
begin
  if p_login_status not in ('invited', 'active') then
    raise exception '不合法的登入狀態：%', p_login_status;
  end if;

  if p_user_id is null then
    raise exception 'p_user_id 不可為 null';
  end if;

  -- 規格書 §1.2.2 第 1 點:調整索引後依然應該被擋下的合理業務衝突——同一個 merchant_id 下,
  -- 已經有另一筆 status='active' 的紀錄,user_id 就是 p_user_id(代表這個帳號已經是本店
  -- 另一位在職服務人員的登入)。找到就丟出清楚的中文錯誤訊息,不要讓使用者看到生硬的資料庫錯誤。
  select id into v_conflict_id
  from public.merchant_staff
  where merchant_id = (select merchant_id from public.merchant_staff where id = p_staff_id)
    and user_id = p_user_id
    and status = 'active'
    and id <> p_staff_id;

  if v_conflict_id is not null then
    raise exception '這個 Email 目前已經是本店另一位在職服務人員的登入帳號，不能重複綁定。如果是同一個人，請先確認是否選錯了服務人員，或聯絡系統管理員協助處理。' using errcode = 'P0001';
  end if;

  -- 規格書 §1.2.2 第 2 點:防禦性最後一道網。萬一索引調整後又漏了某種情境,依然不會讓使用者
  -- 看到原始的 Postgres unique_violation 錯誤訊息,而是回傳清楚的中文說明。
  begin
    update public.merchant_staff
    set user_id = p_user_id,
        invited_login_email = p_invited_login_email,
        login_status = p_login_status,
        login_invited_at = now(),
        login_activated_at = case when p_login_status = 'active' then now() else login_activated_at end
    where id = p_staff_id;
  exception when unique_violation then
    raise exception '這個信箱可能曾經被移除的服務人員使用過，系統應該要能自動處理，如果看到這個訊息代表發生了非預期的資料衝突，請聯絡系統管理員。' using errcode = 'P0001';
  end;

  if not found then
    raise exception '找不到指定的服務人員紀錄：%', p_staff_id;
  end if;

  perform public.seed_default_staff_permissions(p_staff_id);
end;
$function$;

revoke execute on function public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text) from PUBLIC, anon, authenticated;
grant execute on function public.record_invited_staff_login(p_staff_id uuid, p_user_id uuid, p_invited_login_email text, p_login_status text) to service_role;

-- ===== public.redeem_member_points(p_member_id uuid, p_points integer, p_note text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.redeem_member_points(p_member_id uuid, p_points integer, p_note text)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_balance integer;
  v_new_balance integer;
  v_result public.members;
begin
  select merchant_id, points_balance into v_merchant_id, v_balance
  from public.members
  where id = p_member_id
  for update;

  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_points is null or p_points <= 0 then
    raise exception '兌換點數必須大於 0';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception '請說明這次兌換的用途';
  end if;

  if p_points > v_balance then
    raise exception '這位會員目前只有 % 點，無法兌換 % 點', v_balance, p_points;
  end if;

  v_new_balance := v_balance - p_points;

  insert into public.member_point_transactions (
    member_id, merchant_id, transaction_type, points_delta, balance_after, note, created_by_user_id
  ) values (
    p_member_id, v_merchant_id, 'redeem', -p_points, v_new_balance, p_note, auth.uid()
  );

  update public.members set points_balance = v_new_balance where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.redeem_member_points(p_member_id uuid, p_points integer, p_note text) from PUBLIC, anon;
grant execute on function public.redeem_member_points(p_member_id uuid, p_points integer, p_note text) to authenticated, service_role;

-- ===== public.set_staff_day_override(p_staff_id uuid, p_override_date date, p_start_time time without time zone, p_end_time time without time zone, p_is_available boolean)(改 1 則訊息)=====
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

-- ===== public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_source_group uuid;
  v_target_group uuid;
  v_operation_id uuid;
  v_members_snapshot jsonb;
  v_bookings_snapshot jsonb;
  v_full_snapshot jsonb;
  v_member_count int;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_conflict_moving_name text;
  v_conflict_target_name text;
  v_conflict_phone text;
begin
  -- 規則 2.1(核心):只有商家管理員能發動。
  if not private.is_merchant_admin(p_source_merchant_id) then
    raise exception '你不是來源商家的管理員，無法搬遷資料' using errcode = '42501';
  end if;

  -- 規則 2.10(核心，安全邊界)①②:呼叫者必須同時是來源+目標商家的管理員。
  if not private.is_merchant_admin(p_target_merchant_id) then
    raise exception '你不是目標商家的管理員，無法把資料搬過去' using errcode = '42501';
  end if;

  select group_id into v_source_group from public.merchants where id = p_source_merchant_id;
  select group_id into v_target_group from public.merchants where id = p_target_merchant_id;

  if v_source_group is null then
    raise exception '找不到來源商家';
  end if;
  if v_target_group is null then
    raise exception '找不到目標商家';
  end if;

  -- 規則 2.10(核心，安全邊界)③:兩間商家必須同一集團。
  if v_source_group <> v_target_group then
    raise exception '這兩間商家不屬於同一個集團，無法搬遷資料';
  end if;

  if p_source_merchant_id = p_target_merchant_id then
    raise exception '來源商家跟目標商家不能是同一間';
  end if;

  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception '請選擇至少一位要搬遷的會員';
  end if;

  -- 3.6 步驟 2:所有選取的會員必須屬於來源商家，任何一筆不屬於就整批拒絕(原子性操作)。
  if exists (
    select 1 from unnest(p_member_ids) as mid
    where not exists (
      select 1 from public.members m where m.id = mid and m.merchant_id = p_source_merchant_id
    )
  ) then
    raise exception '選取的會員清單中，有會員不屬於來源商家，整批搬遷已取消';
  end if;

  -- SPECS-INDEX #931(2026-09-30):目標商家底下一支電話只能有一位 active 會員。
  -- 在**任何寫入之前**先找出第一筆會撞到的組合,訊息要講清楚「是哪一筆卡住、跟誰撞」,
  -- 不能只說整批失敗(客服要知道去改哪一位)。
  -- `not (tg.id = any(p_member_ids))`:目標商家那一邊要排除「這次也一起被搬走的」那些人。
  -- order by 讓「先報哪一筆」是穩定的(同樣的輸入永遠得到同樣的訊息,客服重試時不會看到不同答案)。
  select mv.name, tg.name, mv.phone
  into v_conflict_moving_name, v_conflict_target_name, v_conflict_phone
  from public.members mv
  join public.members tg
    on tg.merchant_id = p_target_merchant_id
   and tg.status = 'active'
   and private.normalize_phone(tg.phone) = private.normalize_phone(mv.phone)
   and not (tg.id = any(p_member_ids))
  where mv.id = any(p_member_ids)
    and mv.status = 'active'
    and private.normalize_phone(mv.phone) is not null
  order by mv.name, tg.name, mv.id
  limit 1;

  if v_conflict_moving_name is not null then
    raise exception '整批搬遷已取消：要搬過去的會員「%」(電話 %)，跟目標商家現有的會員「%」是同一支電話。同一間商家底下，一支電話只能有一位會員 —— 請先處理掉其中一邊(改電話，或把其中一位下架)，再重新搬遷',
      v_conflict_moving_name, v_conflict_phone, v_conflict_target_name;
  end if;

  v_member_count := array_length(p_member_ids, 1);

  -- 規則 2.7:記錄復原所需資訊——搬遷前的 merchant_id，以及即將被斷開連結的訂單原本指向誰。
  select coalesce(jsonb_object_agg(id::text, jsonb_build_object('merchant_id', merchant_id)), '{}'::jsonb)
    into v_members_snapshot
  from public.members
  where id = any(p_member_ids);

  select coalesce(jsonb_object_agg(id::text, to_jsonb(member_id::text)), '{}'::jsonb)
    into v_bookings_snapshot
  from public.bookings
  where merchant_id = p_source_merchant_id
    and member_id = any(p_member_ids);

  v_full_snapshot := jsonb_build_object('members', v_members_snapshot, 'bookings_member_id', v_bookings_snapshot);

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, related_merchant_id, total_rows, success_rows,
    pre_operation_snapshot, created_by_user_id
  ) values (
    p_source_merchant_id, 'industry_transfer_members', p_target_merchant_id, v_member_count, v_member_count,
    v_full_snapshot, auth.uid()
  ) returning id into v_operation_id;

  -- 3.6 步驟 4:更新選中會員的 merchant_id，連帶更新其分類帳紀錄的 merchant_id
  -- (points_balance 完全不變，判斷 7:單純資料搬家，不是重新計算)。
  update public.members
  set merchant_id = p_target_merchant_id
  where id = any(p_member_ids);

  update public.member_point_transactions
  set merchant_id = p_target_merchant_id
  where member_id = any(p_member_ids);

  -- 規則 2.11(核心，本規格書主動抓到的資料隔離風險):舊商家所有引用這批會員的訂單，member_id
  -- 設為 null(member_name_snapshot 純文字保留),避免新商家透過搬過去的會員看到舊商家的訂單明細。
  update public.bookings
  set member_id = null
  where merchant_id = p_source_merchant_id
    and member_id = any(p_member_ids);

  insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
  select v_operation_id, 'members', mid, 'updated' from unnest(p_member_ids) as mid;

  return v_operation_id;
end;
$function$;

revoke execute on function public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[]) from PUBLIC, anon;
grant execute on function public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[]) to authenticated, service_role;

-- ===== public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid)(改 3 則訊息)=====
CREATE OR REPLACE FUNCTION public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid DEFAULT NULL::uuid)
 RETURNS members
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的兩個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)):會員電話的格式檢查,規則與擺放順序的理由
  -- 跟 create_member 那一段完全相同(格式檢查一定要排在唯一性檢查前面)。
  -- ⚠️ 既有的髒電話依使用者裁決不主動清;但只要客服進來編輯這位會員,就會被要求先把電話改正確
  --    (跟 update_booking 對舊訂單的既有處理方式一致)。正式庫目前不合格 0 筆,所以實際上沒有人會遇到。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)；不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):改電話時不可以撞到同商家**另一位** active 會員。
  -- `m.id <> p_member_id` 這個排除條件缺一不可 —— 沒有它的話,客服只是進來改個姓名錯字、
  -- 電話原封不動,也會被自己那一列擋下來。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員：%。同一間商家底下，一支電話只能有一位會員 —— 如果是同一位客戶，請直接使用那一筆；如果真的是不同的人，請改填另一支電話', v_conflict_name;
    end if;
  end if;

  -- #615:會員分級,同 create_member 的驗證邏輯。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = v_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級，或不屬於這間商家/已下架';
    end if;
  end if;

  update public.members set
    name = btrim(p_name),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    birthday = p_birthday,
    notes = p_notes,
    tier_id = p_tier_id
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid) from PUBLIC, anon;
grant execute on function public.update_member(p_member_id uuid, p_name text, p_phone text, p_email text, p_birthday date, p_notes text, p_tier_id uuid) to authenticated, service_role;

-- ===== public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text)
 RETURNS merchant_agents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_user_id uuid;
  v_name text;
  v_phone text;
  v_result public.merchant_agents;
begin
  select merchant_id, user_id into v_merchant_id, v_user_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄';
  end if;

  -- 授權:該商家管理員(可以協助編輯任何一位客服)**或**這筆紀錄本人(客服自行編輯)。
  -- 直接對應使用者裁決原文「客服可自行編輯或管理員可協助編輯」。
  -- ⚠️ 本人那一條用 v_user_id = auth.uid() 比對**這一列自己的** user_id,不是用
  --    private.is_merchant_agent(merchant_id)——後者只要是這間店任何一位在職客服就成立,
  --    會讓客服 A 改客服 B 的資料。
  --
  -- ⚠️⚠️ 三值邏輯防禦(2026-09-24 主腦巡檢補上,寫法跟 unbind_line_account 三個分支完全一致):
  --    merchant_agents.user_id 是 nullable(「已邀請但還沒註冊」的客服就是 NULL)。
  --    如果裸寫 `or v_user_id = auth.uid()`,當 v_user_id 是 NULL 時該比較的結果是 NULL,
  --    `false or NULL` = NULL、`not NULL` = NULL、`if NULL then` **不成立**
  --    → 這個 raise 根本不會執行,權限檢查被靜默跳過,任何已登入者只要知道那筆 id
  --      就能改別人的資料。
  --    所以兩邊都要先確認 is not null,讓結果是明確的 false 而不是 NULL。
  --    不要因為覺得囉唆而把這兩個 is not null 簡化掉。
  if not (
    private.is_merchant_admin(v_merchant_id)
    or (v_user_id is not null and auth.uid() is not null and v_user_id = auth.uid())
  ) then
    raise exception '沒有權限編輯這位客服的資料，只有商家管理員或這位客服本人可以編輯'
      using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------------
  -- 欄位驗證:全部在 UPDATE 之前擋下並給白話中文訊息,不讓使用者看到資料庫原始錯誤。
  -- ---------------------------------------------------------------------
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    -- merchant_agents.name 是 not null(20260916100000:85)。
    raise exception '姓名不可為空白';
  end if;

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is null then
    -- merchant_agents.phone 在 20260922140000(#595/#596)已改成 NOT NULL,所以編輯時電話必填。
    raise exception '手機號碼不可為空白';
  end if;

  -- merchant_agents_phone_tw_mobile_format:check (phone ~ '^09\d{8}$')
  -- (20260922140000:37-39)。這裡先自己擋下來,不然商家會看到
  -- 「new row for relation "merchant_agents" violates check constraint ...」這種原始錯誤。
  if v_phone !~ '^09\d{8}$' then
    raise exception '手機號碼格式不正確，請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)';
  end if;

  -- nickname / job_title 空字串一律正規化成 NULL(比照 update_my_staff_profile 與
  -- update_my_agent_profile 的既有慣例 nullif(trim(coalesce(x,'')),''),避免存進一堆空字串)。
  -- job_title 為 NULL 時前端 fallback 顯示「客服」(見該欄位註解),所以清空是合法操作。
  --
  -- ⚠️ 四個欄位在**同一個 UPDATE 語句**裡寫完,所以天然是一個原子交易——這正是當初追加
  -- p_job_title 的主要目的(讓前端不必呼叫兩支 RPC,不會出現「第一支成功、第二支失敗」
  -- 的部分儲存狀態)。
  update public.merchant_agents
  set name = v_name,
      nickname = nullif(btrim(coalesce(p_nickname, '')), ''),
      phone = v_phone,
      job_title = nullif(btrim(coalesce(p_job_title, '')), '')
  where id = p_agent_id
  returning * into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text) from PUBLIC, anon;
grant execute on function public.update_merchant_agent(p_agent_id uuid, p_name text, p_nickname text, p_phone text, p_job_title text) to authenticated, service_role;

-- ===== public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text)(改 2 則訊息)=====
CREATE OR REPLACE FUNCTION public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_phone text;
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  -- 電話正規化 + 格式驗證。先在函式裡擋下並給白話中文訊息,不讓管理員看到資料庫原始的
  -- check constraint 錯誤(比照任務 7 update_merchant_agent 的既有做法)。
  -- ⚠️ 空字串要正規化成 NULL 再判斷:這個欄位是選填的,「清空」是合法操作,
  --    不能因為前端送了空字串就當成格式錯誤。
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');

  if v_phone is not null and v_phone !~ '^09\d{8}$' then
    raise exception '手機號碼格式不正確，請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)，或留空不填';
  end if;

  update public.merchant_admins
  set display_name = nullif(btrim(coalesce(p_display_name, '')), ''),
      job_title = nullif(btrim(coalesce(p_job_title, '')), ''),
      phone = v_phone
  where merchant_id = p_merchant_id
    and user_id = auth.uid();

  if not found then
    raise exception '找不到你在這間商家的管理員紀錄，無法更新' using errcode = 'P0002';
  end if;
end;
$function$;

revoke execute on function public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text) from PUBLIC, anon;
grant execute on function public.update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text, p_phone text) to authenticated, service_role;

-- ===== public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text)(改 1 則訊息)=====
CREATE OR REPLACE FUNCTION public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限編輯這位服務人員的資料' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_profile_edit') then
    raise exception '尚未開通個人資料編輯功能，請洽商家管理員' using errcode = '42501';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception '姓名不可為空白';
  end if;

  update public.merchant_staff
  set name = trim(p_name),
      nickname = nullif(trim(coalesce(p_nickname, '')), ''),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      avatar_url = p_avatar_url,
      intro = nullif(trim(coalesce(p_intro, '')), '')
  where id = p_staff_id;
end;
$function$;

revoke execute on function public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text) from PUBLIC, anon;
grant execute on function public.update_my_staff_profile(p_staff_id uuid, p_name text, p_nickname text, p_phone text, p_avatar_url text, p_intro text) to authenticated, service_role;

-- ===== public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)(改 3 則訊息)=====
CREATE OR REPLACE FUNCTION public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)
 RETURNS SETOF merchant_point_formulas
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_elem jsonb;
  v_idx integer := 0;
  v_id uuid;
  v_name text;
  v_enabled boolean;
  v_item uuid;
  v_min numeric;
  v_points integer;
  v_sort integer;
  v_item_name text;
  v_other_name text;
  v_clean jsonb := '[]'::jsonb;
  v_old jsonb;
begin
  if p_merchant_id is null or not private.can_manage_member_points(p_merchant_id) then
    raise exception '沒有權限修改這間商家的紅利派點公式(需要「紅利點數管理」權限)' using errcode = '42501';
  end if;

  if p_formulas is null or jsonb_typeof(p_formulas) <> 'array' then
    raise exception '公式清單格式不正確' using errcode = '22023';
  end if;
  -- 防呆上限:畫面上一條一張卡,正常商家不會超過服務項目數 + 1;擋掉惡意塞爆。
  if jsonb_array_length(p_formulas) > 500 then
    raise exception '公式數量太多(最多 500 條)' using errcode = '22023';
  end if;

  -- 同一間商家的兩次儲存排隊執行(兩個分頁同時按儲存時,第二次會看到第一次的結果再做比對)。
  perform pg_advisory_xact_lock(hashtext('upsert_member_point_formulas'), hashtext(p_merchant_id::text));

  -- 逐條驗證,通過的整理成 v_clean(jsonb 陣列);全部通過才寫入。
  for v_elem in select value from jsonb_array_elements(p_formulas)
  loop
    v_idx := v_idx + 1;
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception '第 % 條公式格式不正確', v_idx using errcode = '22023';
    end if;

    begin
      v_id := nullif(v_elem ->> 'id', '')::uuid;
      v_item := nullif(v_elem ->> 'service_item_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception '第 % 條公式的識別碼格式不正確', v_idx using errcode = '22023';
    end;

    v_name := btrim(coalesce(v_elem ->> 'name', ''));
    if char_length(v_name) < 1 or char_length(v_name) > 50 then
      raise exception '第 % 條公式的名稱要填 1~50 個字', v_idx using errcode = '22023';
    end if;

    begin
      v_enabled := coalesce((v_elem ->> 'enabled')::boolean, true);
      v_min := coalesce((v_elem ->> 'min_unit_price')::numeric, 0);
      v_points := (v_elem ->> 'points_per_unit')::integer;
      v_sort := coalesce((v_elem ->> 'sort_order')::integer, v_idx);
    exception when others then
      raise exception '公式「%」的數字欄位格式不正確', v_name using errcode = '22023';
    end;

    if v_points is null or v_points < 0 then
      raise exception '公式「%」的「每個數量獲得」要填 0 以上的整數', v_name using errcode = '22023';
    end if;
    if v_min < 0 or v_min > 99999999.99 then
      raise exception '公式「%」的單項金額門檻要填 0 以上的金額', v_name using errcode = '22023';
    end if;

    if v_item is not null and not exists (
      select 1 from public.service_items si where si.id = v_item and si.merchant_id = p_merchant_id
    ) then
      -- 不洩漏別家商家的項目是否存在:一律同一句。
      raise exception '公式「%」選的服務項目不屬於這間商家', v_name using errcode = '23514';
    end if;

    if v_id is not null then
      if exists (select 1 from jsonb_array_elements(v_clean) c where (c ->> 'id')::uuid = v_id) then
        raise exception '公式清單裡有重複的公式，請重新整理後再儲存' using errcode = '22023';
      end if;
      if not exists (
        select 1 from public.merchant_point_formulas f where f.id = v_id and f.merchant_id = p_merchant_id
      ) then
        -- 可能是別的分頁剛刪掉它,或 id 不屬於這間商家(IDOR):都不更新任何東西,同一句話。
        raise exception '公式「%」已經不存在，請重新整理後再儲存', v_name using errcode = '22023';
      end if;
    end if;

    -- 重複的服務項目(含兩條「全部服務項目」):白話錯誤,講清楚被哪一條公式設過。
    v_other_name := null;
    select c ->> 'name' into v_other_name
    from jsonb_array_elements(v_clean) c
    where (c ->> 'service_item_id')::uuid is not distinct from v_item
    limit 1;
    if v_other_name is not null then
      if v_item is null then
        v_item_name := '全部服務項目';
      else
        select si.name into v_item_name from public.service_items si where si.id = v_item;
      end if;
      raise exception '「%」已經被公式「%」設定過了，同一個服務項目只能有一條公式', v_item_name, v_other_name
        using errcode = '23505';
    end if;

    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'idx', v_idx, 'id', v_id, 'name', v_name, 'enabled', v_enabled, 'service_item_id', v_item,
      'min_unit_price', v_min, 'points_per_unit', v_points, 'sort_order', v_sort
    ));
  end loop;

  -- 寫入。先刪後寫,而且「要更新的列」也先刪掉再用原本的 id / created_at 插回:
  -- 兩條公式互換服務項目(A:項目1→項目2、B:項目2→項目1)時,逐列 UPDATE 會在中途撞到部分唯一索引,
  -- 而部分唯一索引不能設成 deferrable。merchant_point_formulas 沒有任何外鍵被別的表引用
  -- (訂單的 breakdown 只在 jsonb 裡記 formula_id 字串,不受影響),所以先刪再插是安全的。
  select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) into v_old
  from public.merchant_point_formulas f
  where f.merchant_id = p_merchant_id;

  delete from public.merchant_point_formulas f where f.merchant_id = p_merchant_id;

  insert into public.merchant_point_formulas
    (id, merchant_id, name, enabled, service_item_id, min_unit_price, points_per_unit, sort_order,
     created_at, updated_at)
  select
    coalesce(p.id, gen_random_uuid()),
    p_merchant_id,
    p.name,
    p.enabled,
    p.service_item_id,
    p.min_unit_price,
    p.points_per_unit,
    p.sort_order,
    coalesce(o.created_at, now()),
    case
      when o.id is not null
       and o.name = p.name
       and o.enabled = p.enabled
       and o.service_item_id is not distinct from p.service_item_id
       and o.min_unit_price = p.min_unit_price
       and o.points_per_unit = p.points_per_unit
       and o.sort_order = p.sort_order
      then o.updated_at
      else now()
    end
  from jsonb_to_recordset(v_clean) as p(
    idx integer, id uuid, name text, enabled boolean, service_item_id uuid,
    min_unit_price numeric(10, 2), points_per_unit integer, sort_order integer
  )
  left join jsonb_to_recordset(v_old) as o(
    id uuid, name text, enabled boolean, service_item_id uuid, min_unit_price numeric(10, 2),
    points_per_unit integer, sort_order integer, created_at timestamptz, updated_at timestamptz
  ) on o.id = p.id
  order by p.idx;

  return query
  select f.*
  from public.merchant_point_formulas f
  where f.merchant_id = p_merchant_id
  order by f.sort_order, f.created_at, f.id;
end;
$function$;

revoke execute on function public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb) from PUBLIC, anon;
grant execute on function public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb) to service_role, authenticated;

