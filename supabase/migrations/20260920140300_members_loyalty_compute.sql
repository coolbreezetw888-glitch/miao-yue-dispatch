-- 模組 10:會員與紅利 — compute_member_loyalty_points + complete_booking 疊加(第四支,風險第二高)。
-- 對應規格書 §3.7/§3.8、規則 2.1~2.5、2.8。
--
-- ⚠️ complete_booking() 目前的完整版本,是動工前用 mcp__claude_ai_Supabase__execute_sql 對正式
-- 專案 wjtbmmnakcriuaqoknsq 執行 pg_get_functiondef 取得的(2026-09-20 查證),確認
-- `perform public.compute_booking_commission(p_booking_id);`(模組 8 §3.7 疊加的那一行)還在,
-- 跟 20260920120200_payroll_commission_compute.sql 裡的版本逐字相同。以下逐字保留這個版本的
-- 函式主體,只在模組 8 那一行之後、return v_result 之前,新增一行
-- perform public.compute_member_loyalty_points(p_booking_id);,不會蓋掉模組 8 已經加的邏輯。

-- =========================================================================
-- 3.7:compute_member_loyalty_points(p_booking_id uuid)。SECURITY DEFINER,不對外公開給前端
-- 直接呼叫(只由 complete_booking 內部呼叫),明確 revoke 所有角色的 execute 權限(比照模組 8
-- compute_booking_commission 的既有保護精神——這支函式的呼叫時機直接決定規則 2.2「快照建立後
-- 不自動重算」是否成立)。
--
-- 函式內的每一步「直接 return」都是規格書 §3.7 明講的步驟順序,不是隨意省略:
--   步驟 1:member_id is null → return(規則 2.2,沒有連結會員完全不計算紅利)。
--   步驟 3:require_verified_phone_for_rewards=true 且未驗證 → return(規則 2.8)。
--   步驟 4:points_earn_rate <= 0 → return(尚未設定比例)。
--   步驟 5:v_points <= 0 → return(金額太小算不到 1 點)。
-- 步驟 7(規則 2.4 推薦獎勵)只有在成功走完步驟 1~6(真的核發了消費點數)才會執行到——這是
-- 規格書 §3.7 本身定義的循序流程,連帶的效果是:如果 points_earn_rate 還沒設定
-- (=0,尚未核發任何消費點數),推薦獎勵這次也不會觸發,因為函式在步驟 4 就已經 return 了。
-- 這是規格書步驟本身隱含的耦合,不是本次實作自行加上的額外限制,已在回報時一併提出讓主腦/
-- 使用者知悉,列入待確認事項。
--
-- 規則 2.8 對「推薦獎勵」路徑的補充判斷(規格書條文本身沒有寫得非常明確的地方,這裡採用能
-- 落實規格書意圖的解讀,已在回報時提出待確認):政策開啟時,「消費核發」路徑檢查的是被推薦人
-- (這筆訂單的會員)自己的 phone_verified;而「推薦獎勵」實際上是核發給推薦人,這裡額外檢查
-- 推薦人自己的 phone_verified 才核發點數(但不影響 referral_rewarded_at 是否標記,標記與否
-- 只看規則 2.4 的三個資格條件是否成立,呼應規則 2.4 第 5 點「資格只看有沒有第一筆消費,不看
-- 當時的其他設定」的精神)。
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
  v_require_verified boolean;
  v_phone_verified boolean;
  v_points integer;
  v_new_balance integer;
  v_inserted boolean;
  v_referred_by uuid;
  v_referral_rewarded_at timestamptz;
  v_referral_bonus_points integer;
  v_prior_earn_count integer;
  v_referrer_phone_verified boolean;
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
  select points_earn_rate, require_verified_phone_for_rewards
  into v_earn_rate, v_require_verified
  from public.merchant_member_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_earn_rate := 0;
    v_require_verified := false;
  end if;

  -- 鎖定該會員資料列(規則 2.3:計算新餘額前先 for update,避免併發競態算錯餘額)。
  select phone_verified, referred_by_member_id, referral_rewarded_at
  into v_phone_verified, v_referred_by, v_referral_rewarded_at
  from public.members
  where id = v_member_id
  for update;

  -- 3. require_verified_phone_for_rewards=true 時,查該會員 phone_verified,不是 true 就 return。
  if v_require_verified and not coalesce(v_phone_verified, false) then
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
        -- 鎖定推薦人資料列(規則 2.3 精神:計算新餘額前先 for update,不論是否要檢查電話
        -- 驗證政策都先鎖定,避免併發競態)。
        select phone_verified, points_balance into v_referrer_phone_verified, v_referrer_new_balance
        from public.members
        where id = v_referred_by
        for update;

        if not v_require_verified then
          v_referrer_phone_verified := true;
        end if;

        if coalesce(v_referrer_phone_verified, false) then
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

      -- 規則 2.4 第 5 點:不論獎勵點數是否 > 0(或推薦人是否通過電話驗證),只要資格條件成立,
      -- 都要標記 referral_rewarded_at,避免之後調整設定值又重複觸發。
      update public.members set referral_rewarded_at = now() where id = v_member_id;
    end if;
  end if;
end;
$$;

comment on function public.compute_member_loyalty_points(uuid) is '模組 10 §3.7(核心):某筆訂單完成當下,計算連結會員的消費紅利點數並寫入 member_point_transactions 快照(規則 2.1:含稅總額 final_amount_snapshot,不受服務人員計酬類型影響),同時檢查並視情況核發推薦獎勵(規則 2.4)。on conflict (booking_id) where transaction_type=''earn_booking'' do nothing 保護既有紀錄不被覆寫(規則 2.2 核心規則)。SECURITY DEFINER,不對外公開,只由 complete_booking() 內部用 perform 呼叫——刻意 revoke 所有角色的 execute 權限,避免被提前呼叫而在訂單真正完成前就把點數鎖死。';

revoke execute on function public.compute_member_loyalty_points(uuid) from public, anon, authenticated;

-- =========================================================================
-- 3.8:complete_booking() 疊加呼叫 compute_member_loyalty_points(create or replace)。
-- 簽章/回傳型別/呼叫方式完全不變。疊加位置:在模組 8 疊加的
-- `perform public.compute_booking_commission(p_booking_id);` 之後、`return v_result;` 之前。
-- 以下函式主體逐字保留自 20260920120200_payroll_commission_compute.sql(已用 pg_get_functiondef
-- 對正式環境核對過,無漂移,模組 8 那一行仍在)。
-- =========================================================================
create or replace function public.complete_booking(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以標記完成,目前狀態不允許這個操作';
  end if;

  update public.bookings
  set status = 'completed',
      completed_at = now(),
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 模組 8(薪資與帳務)§3.7 新增的唯一一行:訂單成功轉為 completed 之後,計算抽成快照。
  perform public.compute_booking_commission(p_booking_id);

  -- 模組 10(會員與紅利)§3.8 新增的唯一一行:訂單成功轉為 completed 之後,計算會員紅利點數
  -- (規則 2.1/2.2/2.4/2.8)。刻意排在模組 8 那一行之後,不會影響/覆蓋模組 8 的抽成計算邏輯,
  -- 兩者各自寫各自的表,互不影響。
  perform public.compute_member_loyalty_points(p_booking_id);

  return v_result;
end;
$$;

comment on function public.complete_booking(uuid) is '把預約標記為完成(模組 6)。模組 8(薪資與帳務)§3.7 疊加呼叫 compute_booking_commission(p_booking_id)計算抽成快照;模組 10(會員與紅利)§3.8 接著疊加呼叫 compute_member_loyalty_points(p_booking_id)計算會員紅利點數,兩者都在訂單狀態成功轉為 completed 之後、return 之前執行,各自寫各自的表(booking_commission_records / member_point_transactions),互不影響、互不覆蓋。簽章/回傳型別/呼叫方式完全不變,其餘邏輯逐字保留自模組 6/8 既有版本。';
