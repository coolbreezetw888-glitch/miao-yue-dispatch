-- SPECS-INDEX #989 第 11 批 B 項:預設文案改全形(只改新的,既有資料不回填)
-- 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §2
--
-- 做法:每支函式的底稿 = 本機套完 20261007130200 之後的 pg_get_functiondef(oid)
-- (本機指紋與正式庫 2026-10-07 唯讀查詢一致),除了預設文案裡「中文句中的半形 , : !」改成全形以外逐字保留。
-- {{變數}}、% 佔位符、半形括號、半形斜線一律不動。
-- 本支只改「新商家開店時寫入的預設值」與「之後新寫入的紅利退回備註」;
-- 既有商家已存的 LINE / 推播範本、會員設定的生日文案、舊分類帳備註一律不回填(不含任何 UPDATE)。
--
-- 🔴 B-7(欄位預設值)與 B-8(觸發器裡比對「是不是預設值」的字串)必須在同一支 migration:
--    只改一邊,新商家建立會員設定時會被當成「動到規則欄位」而被權限檢查擋下,開店流程失敗。
--
-- CREATE OR REPLACE 不會改動既有 ACL / owner / SECURITY DEFINER / search_path(本支不另下 GRANT / REVOKE)。
--
-- 改前指紋 md5(replace(prosrc, CRLF, LF)):
--   a19a207a73151c202d68d944aee78605  public.seed_default_line_event_settings(p_merchant_id uuid)
--   68186fe0cc6fc7d2bceb67f6291bbfc4  public.seed_default_push_event_settings(p_merchant_id uuid)
--   436d98681df0855fa371cbdb65397824  private.protect_merchant_member_settings_rule_columns()
--   668218be2bd4aabb858697d101bd7a68  private.refund_booking_redeem(p_booking_id uuid)


-- ===== B-7:merchant_member_settings.birthday_line_message 欄位預設值(只改預設值,不 UPDATE 既有列)=====
alter table public.merchant_member_settings
  alter column birthday_line_message set default '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。';

-- ===== public.seed_default_line_event_settings(p_merchant_id uuid)(B 項預設文案全形)=====
CREATE OR REPLACE FUNCTION public.seed_default_line_event_settings(p_merchant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.merchant_line_event_settings (
    merchant_id, event_type, notify_admin, notify_agent, notify_staff, notify_member, message_template
  ) values
    (p_merchant_id, 'booking_created', true, false, false, false,
     '【{{merchant_name}}】有新的預約：{{customer_name}} 於 {{booking_date}} 預約 {{service_names}}，金額 {{final_amount}} 元。'),
    (p_merchant_id, 'booking_confirmed', false, false, true, true,
     '【{{merchant_name}}】您的預約已確認：{{booking_date}}、服務項目：{{service_names}}、服務人員：{{staff_name}}。'),
    (p_merchant_id, 'booking_cancelled', false, false, true, true,
     '【{{merchant_name}}】您的預約已取消：{{booking_date}}、服務項目：{{service_names}}。取消原因：{{cancel_reason}}。'),
    (p_merchant_id, 'booking_completed', false, false, false, true,
     '【{{merchant_name}}】感謝您的光臨！本次服務：{{service_names}}，本次獲得 {{points_earned}} 點。'),
    (p_merchant_id, 'staff_leave_created', true, false, false, false,
     '【{{merchant_name}}】{{staff_name}} 登記了一筆請假：{{booking_date}}。')
  on conflict (merchant_id, event_type) do nothing;
end;
$function$;

-- ===== public.seed_default_push_event_settings(p_merchant_id uuid)(B 項預設文案全形)=====
CREATE OR REPLACE FUNCTION public.seed_default_push_event_settings(p_merchant_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.merchant_push_event_settings (
    merchant_id, event_type, message_title, message_body
  ) values
    (p_merchant_id, 'booking_created', '新訂單通知', '{{booking_date}} {{customer_name}}‧{{service_names}}'),
    (p_merchant_id, 'booking_cancelled', '訂單已取消', '{{booking_date}} {{customer_name}} 的預約已取消'),
    (p_merchant_id, 'booking_updated', '訂單內容異動', '{{booking_date}} {{customer_name}}：{{change_summary}}'),
    (p_merchant_id, 'booking_reminder_next_day', '明天有預約提醒', '{{booking_date}} {{customer_name}}‧{{service_names}}')
  on conflict (merchant_id, event_type) do nothing;
end;
$function$;

-- ===== private.protect_merchant_member_settings_rule_columns()(B 項預設文案全形)=====
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
      or coalesce(new.birthday_line_message, '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。')
           is distinct from '生日快樂！本店已贈送您 {{points}} 點紅利，祝您有美好的一天。';

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

-- ===== private.refund_booking_redeem(p_booking_id uuid)(B 項預設文案全形)=====
CREATE OR REPLACE FUNCTION private.refund_booking_redeem(p_booking_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_row record;
  v_balance integer;
  v_total integer := 0;
begin
  -- 先鎖訂單列:同一張單的「退回 / 重新折抵」全部排隊,淨額在鎖之後才算,重複呼叫(或兩個人
  -- 同時按取消)第二次一定看到淨額 0 ⇒ 什麼都不寫(冪等)。鎖的順序一律「訂單 → 會員」,
  -- 跟 update_booking / cancel_booking 一致,不會互相死鎖。
  select b.merchant_id, b.status into v_merchant_id, v_status
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    return 0;
  end if;

  -- 「目前有效凍結」= −Σ(redeem_booking + redeem_booking_refund 的 points_delta)(§1.5 淨額定義)。
  -- 依分類帳上「當初被扣點的那位會員」分組退回 —— 退給被扣的人,不是退給 bookings.member_id
  -- 目前指向的人(改單時兩者可能不同)。
  -- **不看 points_feature_enabled、也不看會員 status**(§3.11.2 統一對照:「收回 / 退回」一律不看
  -- 狀態、不看開關 —— 那是客人自己的點數)。
  for v_row in
    select t.member_id, (-sum(t.points_delta))::int as frozen
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('redeem_booking', 'redeem_booking_refund')
    group by t.member_id
    having -sum(t.points_delta) > 0
    order by t.member_id
  loop
    -- update 本身就會鎖會員列;加回之後餘額一定 >= 0,不會碰到兩道「不可為負」的 CHECK。
    update public.members
    set points_balance = points_balance + v_row.frozen
    where id = v_row.member_id
    returning points_balance into v_balance;

    if not found then
      continue;  -- 會員已被硬刪(分類帳會跟著 cascade 消失,理論上到不了)
    end if;

    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
    ) values (
      v_row.member_id, v_merchant_id, 'redeem_booking_refund', v_row.frozen, v_balance, p_booking_id,
      case when v_status = 'cancelled'
           then format('訂單取消，退回紅利折抵 %s 點', v_row.frozen)
           else format('訂單編輯變更了會員或折抵點數，先退回原本的紅利折抵 %s 點', v_row.frozen)
      end,
      auth.uid()
    );

    v_total := v_total + v_row.frozen;
  end loop;

  if v_total > 0 then
    update public.bookings
    set points_redeemed = 0,
        points_redeem_amount_snapshot = 0
    where id = p_booking_id;
  end if;

  return v_total;
end;
$function$;
