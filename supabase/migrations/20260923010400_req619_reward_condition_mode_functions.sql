-- SPECS-INDEX #619(規格書 .project/specs/會員與紅利.md §10.7)。
-- 新增「LINE 已綁定」驗證條件,跟既有「電話已驗證」並存。compute_member_loyalty_points(消費紅利+
-- 推薦獎勵)、grant_pending_birthday_bonuses(生日贈點)三個核發路徑,原本判斷
-- require_verified_phone_for_rewards 的邏輯,改用新的 reward_condition_mode(五選一)判斷。
--
-- ⚠️ 動工前已查證目前套用的最新版本:
--   - compute_member_loyalty_points/complete_booking 疊加:20260920140300_members_loyalty_compute.sql
--     (complete_booking 這支這次完全不用動,只重寫 compute_member_loyalty_points 本身,簽章不變)。
--   - grant_pending_birthday_bonuses:20260920140400_members_points_transactions.sql。
-- 兩支函式簽章都不變,直接 create or replace 即可,不受「drop function if exists」規則限制。

-- =========================================================================
-- private.member_meets_reward_condition:共用判斷邏輯,避免兩支函式各寫一份容易漂移。
-- =========================================================================
create or replace function private.member_meets_reward_condition(
  p_mode text,
  p_phone_verified boolean,
  p_line_bound boolean
)
returns boolean
language sql
immutable
as $$
  select case p_mode
    when 'none' then true
    when 'phone_verified' then coalesce(p_phone_verified, false)
    when 'line_bound' then coalesce(p_line_bound, false)
    when 'either' then coalesce(p_phone_verified, false) or coalesce(p_line_bound, false)
    when 'both' then coalesce(p_phone_verified, false) and coalesce(p_line_bound, false)
    else true
  end;
$$;

comment on function private.member_meets_reward_condition(text, boolean, boolean) is '模組 10 §10.7(SPECS-INDEX #619):依 merchant_member_settings.reward_condition_mode 判斷某位會員是否符合核發資格。none=不設條件;phone_verified=只看電話已驗證;line_bound=只看 LINE 已綁定;either=任一即可;both=兩者皆要。只給 compute_member_loyalty_points/grant_pending_birthday_bonuses 內部呼叫,不對外暴露。';

revoke execute on function private.member_meets_reward_condition(text, boolean, boolean) from public, anon;
grant execute on function private.member_meets_reward_condition(text, boolean, boolean) to authenticated;

-- =========================================================================
-- compute_member_loyalty_points:步驟 2/3 改讀 reward_condition_mode,步驟 7(推薦獎勵)的推薦人
-- 資格判斷同樣改用新條件(原本只看 phone_verified,現在看 reward_condition_mode 底下電話已驗證/
-- LINE 已綁定的組合)。其餘步驟(1/4/5/6)完全不動。
-- =========================================================================
create or replace function public.compute_member_loyalty_points(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_member_id uuid;
  v_final_amount numeric(10, 2);
  v_earn_rate numeric(10, 2);
  v_reward_condition_mode text;
  v_phone_verified boolean;
  v_line_bound boolean;
  v_points integer;
  v_new_balance integer;
  v_inserted boolean;
  v_referred_by uuid;
  v_referral_rewarded_at timestamptz;
  v_referral_bonus_points integer;
  v_prior_earn_count integer;
  v_referrer_phone_verified boolean;
  v_referrer_line_bound boolean;
  v_referrer_new_balance integer;
begin
  -- 1. 查 bookings 取得 merchant_id/member_id/final_amount_snapshot。member_id is null 直接 return。
  select merchant_id, member_id, final_amount_snapshot
  into v_merchant_id, v_member_id, v_final_amount
  from public.bookings
  where id = p_booking_id;

  if not found or v_member_id is null then
    return;
  end if;

  -- 2. 查 merchant_member_settings,查無資料視為預設值。
  select points_earn_rate, reward_condition_mode
  into v_earn_rate, v_reward_condition_mode
  from public.merchant_member_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_earn_rate := 0;
    v_reward_condition_mode := 'none';
  end if;

  -- 鎖定該會員資料列(規則 2.3:計算新餘額前先 for update,避免併發競態算錯餘額)。
  select phone_verified, line_bound, referred_by_member_id, referral_rewarded_at
  into v_phone_verified, v_line_bound, v_referred_by, v_referral_rewarded_at
  from public.members
  where id = v_member_id
  for update;

  -- 3.(#619)依 reward_condition_mode 判斷,不符合就直接 return。
  if not private.member_meets_reward_condition(v_reward_condition_mode, v_phone_verified, v_line_bound) then
    return;
  end if;

  -- 4. points_earn_rate <= 0 就直接 return(尚未設定比例,不核發)。
  if v_earn_rate <= 0 then
    return;
  end if;

  -- 5. 計算 v_points,<= 0 就直接 return(金額太小算不到 1 點)。
  v_points := floor(coalesce(v_final_amount, 0) / v_earn_rate);
  if v_points <= 0 then
    return;
  end if;

  -- 6. 寫入快照。on conflict do nothing 保護既有紀錄不被覆蓋(規則 2.2 核心規則,理論上不該
  -- 發生,是最後一道防線)。
  select points_balance + v_points into v_new_balance from public.members where id = v_member_id;

  insert into public.member_point_transactions (
    member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id
  ) values (
    v_member_id, v_merchant_id, 'earn_booking', v_points, v_new_balance, p_booking_id
  )
  on conflict (booking_id) where transaction_type = 'earn_booking' do nothing;

  v_inserted := found;

  if not v_inserted then
    -- 理論上不該發生(complete_booking 只會成功轉換一次狀態),沒有真的插入就不更新餘額、
    -- 也不繼續檢查推薦獎勵,避免用同一筆訂單重複觸發推薦邏輯。
    return;
  end if;

  update public.members set points_balance = v_new_balance where id = v_member_id;

  -- 7. 規則 2.4:推薦獎勵。被推薦人(v_member_id)還有推薦人、還沒因此拿過獎勵、且這是
  -- 這位被推薦人第一筆 earn_booking 紀錄(用「插入這筆之後,總共只有 1 筆」判斷,避免自己算自己)。
  if v_referred_by is not null and v_referral_rewarded_at is null then
    select count(*) into v_prior_earn_count
    from public.member_point_transactions
    where member_id = v_member_id and transaction_type = 'earn_booking';

    if v_prior_earn_count = 1 then
      select referral_bonus_points into v_referral_bonus_points
      from public.merchant_member_settings
      where merchant_id = v_merchant_id;

      if v_referral_bonus_points is null then
        v_referral_bonus_points := 0;
      end if;

      if v_referral_bonus_points > 0 then
        -- 鎖定推薦人資料列(規則 2.3 精神:計算新餘額前先 for update,不論是否要檢查資格條件都
        -- 先鎖定,避免併發競態)。
        select phone_verified, line_bound, points_balance
        into v_referrer_phone_verified, v_referrer_line_bound, v_referrer_new_balance
        from public.members
        where id = v_referred_by
        for update;

        if private.member_meets_reward_condition(
          v_reward_condition_mode, v_referrer_phone_verified, v_referrer_line_bound
        ) then
          v_referrer_new_balance := v_referrer_new_balance + v_referral_bonus_points;

          insert into public.member_point_transactions (
            member_id, merchant_id, transaction_type, points_delta, balance_after,
            booking_id, related_member_id
          ) values (
            v_referred_by, v_merchant_id, 'referral_bonus', v_referral_bonus_points,
            v_referrer_new_balance, p_booking_id, v_member_id
          );

          update public.members set points_balance = v_referrer_new_balance where id = v_referred_by;
        end if;
      end if;

      -- 規則 2.4 第 5 點:不論獎勵點數是否 > 0(或推薦人是否通過資格條件),只要資格條件成立,
      -- 都要標記 referral_rewarded_at,避免之後調整設定值又重複觸發。
      update public.members set referral_rewarded_at = now() where id = v_member_id;
    end if;
  end if;
end;
$$;

comment on function public.compute_member_loyalty_points(uuid) is '模組 10 §3.7(核心,SPECS-INDEX #619 疊加):某筆訂單完成當下,計算連結會員的消費紅利點數並寫入 member_point_transactions 快照(規則 2.1:含稅總額 final_amount_snapshot),同時檢查並視情況核發推薦獎勵(規則 2.4)。#619:資格判斷改用 reward_condition_mode(五選一:none/phone_verified/line_bound/either/both),取代原本單一的 require_verified_phone_for_rewards boolean 開關,推薦獎勵路徑核發給推薦人前同樣依這個條件判斷推薦人自己的資格。on conflict (booking_id) where transaction_type=''earn_booking'' do nothing 保護既有紀錄不被覆寫(規則 2.2 核心規則)。SECURITY DEFINER,不對外公開,只由 complete_booking() 內部用 perform 呼叫。';

revoke execute on function public.compute_member_loyalty_points(uuid) from public, anon, authenticated;

-- =========================================================================
-- grant_pending_birthday_bonuses:同樣改用 reward_condition_mode。
-- =========================================================================
create or replace function public.grant_pending_birthday_bonuses(p_merchant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward_condition_mode text;
  v_bonus_points integer;
  v_granted_count integer := 0;
  v_member record;
  v_new_balance integer;
  v_current_year integer := extract(year from current_date)::int;
begin
  if not private.can_manage_members(p_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  select reward_condition_mode, birthday_bonus_points
  into v_reward_condition_mode, v_bonus_points
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    v_reward_condition_mode := 'none';
    v_bonus_points := 0;
  end if;

  for v_member in
    select id, phone_verified, line_bound, points_balance
    from public.members
    where merchant_id = p_merchant_id
      and status = 'active'
      and birthday is not null
      and extract(month from birthday) = extract(month from current_date)
      and (last_birthday_bonus_year is null or last_birthday_bonus_year < v_current_year)
    for update
  loop
    -- (#619)資格條件不符時,這條路徑靜默略過,不標記年份(留給下次符合資格後補發,呼應原本
    -- 規則 2.8 對電話驗證政策的既有精神,延伸適用到新的五選一條件)。
    if not private.member_meets_reward_condition(
      v_reward_condition_mode, v_member.phone_verified, v_member.line_bound
    ) then
      continue;
    end if;

    if v_bonus_points > 0 then
      v_new_balance := v_member.points_balance + v_bonus_points;
      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after
      ) values (
        v_member.id, p_merchant_id, 'birthday_bonus', v_bonus_points, v_new_balance
      );
      update public.members set points_balance = v_new_balance where id = v_member.id;
    end if;

    -- 規則 2.5:不論獎勵點數是否 > 0,都更新 last_birthday_bonus_year,避免之後調高金額
    -- 又對同一位會員在同一年重複核發。
    update public.members set last_birthday_bonus_year = v_current_year where id = v_member.id;

    v_granted_count := v_granted_count + 1;
  end loop;

  return v_granted_count;
end;
$$;

comment on function public.grant_pending_birthday_bonuses(uuid) is '模組 10 §3.11(規則 2.5,SPECS-INDEX #619 疊加):任何有 members 權限的人打開會員管理列表頁時觸發,檢查該商家「生日在本月、今年還沒發過生日獎勵」的會員並一次核發完畢。#619:資格判斷改用 reward_condition_mode(五選一),取代原本的 require_verified_phone_for_rewards。用「生日當月」而不是嚴格「當天」容錯。回傳實際處理的會員數量,冪等操作。';

revoke execute on function public.grant_pending_birthday_bonuses(uuid) from public, anon;
grant execute on function public.grant_pending_birthday_bonuses(uuid) to authenticated;
