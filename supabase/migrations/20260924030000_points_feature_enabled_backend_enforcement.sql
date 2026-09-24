-- 2026-09-24 使用者裁決修補(紅利點數開關要「真的關掉」)。
--
-- =========================================================================
-- 【使用者裁決原文】
--   「關閉後就不計算點數了。」
--
-- 【原本的設計與問題】
-- merchant_member_settings.points_feature_enabled 這個開關是 SPECS-INDEX #617 新增的
-- (20260922160400_req617_member_points_feature_toggle.sql)。當初的欄位註解明確寫著它
-- 「不影響任何後端核發/兌換/調整邏輯本身」——也就是刻意設計成「只是把前端畫面藏起來,
-- 後端照算」。
--
-- 實際查證的後果:
--   ・private.compute_member_loyalty_points(20260923010400_req619_reward_condition_mode_functions.sql)
--     只讀 points_earn_rate 與 reward_condition_mode,完全沒有讀 points_feature_enabled。
--   ・public.grant_pending_birthday_bonuses(同一支 migration)同樣沒有讀。
--   ・於是商家把紅利點數功能關掉之後,每完成一筆「有連結會員」的訂單,系統仍然默默累積點數;
--     生日贈點也仍然在會員列表頁載入時默默核發。
--   ・商家關了半年再打開,會員會突然帶著一大筆「可兌換」的點數出現,而商家必須認帳——
--     這跟商家按下「關閉」時的預期完全相反。
--
-- 【這次的修法】
-- 把 points_feature_enabled 從「前端顯示開關」升級成「後端會不會自動產生點數」的真正開關:
-- 所有「系統自動核發」的路徑,在開關為 false 時直接靜默結束,不寫 member_point_transactions、
-- 不動 members.points_balance、也不留下任何「已處理過」的標記(理由見下方「為什麼不留標記」)。
--
-- 【✅ 這次會被擋下的路徑(系統自動核發,商家沒有逐筆按過確認)】
--   (1) public.compute_member_loyalty_points(uuid) —— 訂單完成時的「消費累點」。
--       由 complete_booking() 內部 perform 呼叫,商家完成訂單就自動發生。
--   (2) 同一支函式步驟 7 的「推薦獎勵」(referral_bonus)—— 被推薦人第一筆消費累點成立時,
--       自動加點給推薦人。這條路徑靠 (1) 的提前 return 一併擋下(推薦獎勵的程式碼在
--       消費累點寫入成功「之後」才執行,前面 return 掉就永遠走不到),下方另外加了一層
--       顯式判斷當保險,避免之後有人搬動程式碼順序時把這條路徑漏掉。
--   (3) public.grant_pending_birthday_bonuses(uuid) —— 生日贈點。前端打開會員管理列表頁
--       就自動觸發,商家完全沒有逐筆確認的機會,最需要被這個開關關掉。
--
-- 【❌ 這次刻意「不」擋下的路徑(商家手動操作,關掉功能後仍然要能收尾)】
--   (4) public.adjust_member_points(uuid, integer, text) —— 商家管理員手動調整點數。
--   (5) public.redeem_member_points(uuid, integer, text) —— 登記兌換/使用點數。
--   (6) public.import_members_batch(...) 裡的「起始點數餘額」(寫入 transaction_type=
--       'manual_adjustment'、note='資料匯入:起始點數餘額')—— 本質上就是一次手動調整,
--       是匯入的人自己在試算表裡填的數字,不是系統自己算出來的。
--
--   為什麼不擋:關閉紅利點數功能之後,會員手上「既有的」點數餘額並不會消失(#617 當初就
--   決定不清空資料)。商家關掉功能的典型情境是「這套紅利制度我不玩了」,接下來他需要做的是
--   「把既有餘額清算掉」——讓老客戶把點數用完(redeem)、或直接手動歸零(adjust)。
--   如果連這兩支也一起擋掉,商家會變成「關掉功能之後反而卡在一堆清不掉的點數餘額上」,
--   那不是把開關做對,是把商家鎖死。所以這兩條路徑一律放行,不看這個開關。
--
--   另外一個判斷理由:這兩支函式都是「商家主動點下去、而且要填寫原因/用途」的操作,
--   不存在「關了半年之後突然冒出一筆帳」的問題——那才是這次修補真正要解決的事。
--
-- 【為什麼開關關閉時「不」留下已處理標記】
-- grant_pending_birthday_bonuses 平常會把處理過的會員標記 last_birthday_bonus_year,
-- compute_member_loyalty_points 的推薦獎勵會標記 members.referral_rewarded_at。
-- 開關關閉時這次選擇「什麼都不做、也不標記」,跟既有「資格條件不符就靜默略過、不標記年份,
-- 留給下次符合資格後補發」的精神一致(見 20260923010400 的 #619 註解)。
--
-- ⚠️ 兩條路徑「不標記」實際換到的東西不一樣,不要混為一談(2026-09-24 註解修正:
--    原本這裡籠統寫「當年度的生日贈點還補得回來」,說法過強,跟實際查詢條件不符):
--
--   ・推薦獎勵(referral_rewarded_at):真的完整保住。關閉期間被推薦人沒有寫入任何
--     earn_booking,所以「這是他第一筆消費累點」這個資格條件還在;商家重新打開之後,
--     被推薦人下一次消費完成時推薦獎勵就會正常觸發,沒有時間限制。
--
--   ・生日贈點(last_birthday_bonus_year):只在「同一個月內」有意義。
--     grant_pending_birthday_bonuses 的查詢條件是
--       and extract(month from birthday) = extract(month from current_date)
--     (見 20260923010400:225)——它只撈「生日在本月」的會員。所以不標記年份換到的是
--     「在該會員生日的那個月份之內重新打開,才補得回來」;一旦跨月,不管有沒有標記都撈不到,
--     補不回來。
--     具體例子:商家 1 月關掉、3 月才打開 → 2 月生日的那些會員,3 月執行時根本不在查詢
--     範圍內(那時它找的是 3 月生日的人),不會補發。
--     即使如此,「不標記」仍然是正確的選擇:標記了連「同月內關掉又打開」這個最常見的情境
--     都補不回來,而且會留下一筆「今年已發過」的假紀錄,之後查帳對不上。
--
-- 【簽章不變】三支函式全部 create or replace、簽章一字不改,不受「改簽章要先 drop」的規則限制。
-- 權限設定(revoke/grant)照原樣重新宣告一次,保持意圖明確(supabase-permission-hygiene)。
-- =========================================================================

-- =========================================================================
-- §1 compute_member_loyalty_points:新增 points_feature_enabled 守門。
--
-- 完整照抄 20260923010400_req619_reward_condition_mode_functions.sql:44 的版本,
-- 只加上:讀取 points_feature_enabled、步驟 2.5 的守門 return、步驟 7 的保險判斷。
-- 其餘每一個步驟(1/3/4/5/6)與 for update 鎖定順序完全不動。
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
  v_points_feature_enabled boolean;
  v_points integer;
  v_new_balance integer;
  v_inserted boolean;
  v_referred_by uuid;
  v_referral_rewarded_at timestamptz;
  v_referral_bonus_points integer;
  v_prior_earn_count integer;
  v_phone_verified boolean;
  v_line_bound boolean;
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
  select points_earn_rate, reward_condition_mode, points_feature_enabled
  into v_earn_rate, v_reward_condition_mode, v_points_feature_enabled
  from public.merchant_member_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_earn_rate := 0;
    v_reward_condition_mode := 'none';
    -- 沿用欄位預設值 true(查無設定列時 earn_rate=0 本來就會在步驟 4 return,
    -- 這裡給 true 只是為了跟 schema 預設一致,不讓「查無資料」變成隱性的關閉)。
    v_points_feature_enabled := true;
  end if;

  -- 2.5(2026-09-24 使用者裁決:「關閉後就不計算點數了。」)
  -- 紅利點數功能關閉時,這條「系統自動核發」的路徑整段不做——消費累點不發,
  -- 步驟 7 的推薦獎勵也因此完全走不到(見檔頭路徑盤點 (1)(2))。
  -- 刻意放在最前面、在鎖定會員資料列之前就 return:功能關閉時連鎖都不需要拿。
  if not coalesce(v_points_feature_enabled, true) then
    return;
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
  --
  -- (2026-09-24)v_points_feature_enabled 在這裡再判斷一次是刻意的「保險」,不是多餘:
  -- 目前功能關閉時步驟 2.5 就 return 了,程式根本不會執行到這裡;但推薦獎勵是一條獨立的
  -- 「系統自動核發點數」路徑,如果之後有人調整步驟順序(例如把消費累點跟推薦獎勵拆開),
  -- 少了這一層就會默默漏掉。把條件寫在它自己該在的位置,讓「關閉後不自動發點」這件事
  -- 在每一條發點路徑上都看得到。
  if coalesce(v_points_feature_enabled, true)
     and v_referred_by is not null and v_referral_rewarded_at is null then
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

comment on function public.compute_member_loyalty_points(uuid) is '模組 10 §3.7(核心,SPECS-INDEX #619 疊加,2026-09-24 再疊加 points_feature_enabled 守門):某筆訂單完成當下,計算連結會員的消費紅利點數並寫入 member_point_transactions 快照(規則 2.1:含稅總額 final_amount_snapshot),同時檢查並視情況核發推薦獎勵(規則 2.4)。2026-09-24 使用者裁決「關閉後就不計算點數了」:merchant_member_settings.points_feature_enabled 為 false 時,這支函式在鎖定會員資料列之前就直接 return,消費累點與推薦獎勵兩條自動核發路徑都不執行、也不留下 referral_rewarded_at 標記(讓商家重新打開功能後推薦資格還在)。手動調整(adjust_member_points)與兌換(redeem_member_points)刻意不受這個開關影響,商家關閉功能後仍要能清算既有餘額。#619:資格判斷用 reward_condition_mode(五選一:none/phone_verified/line_bound/either/both)。on conflict (booking_id) where transaction_type=''earn_booking'' do nothing 保護既有紀錄不被覆寫(規則 2.2 核心規則)。SECURITY DEFINER,不對外公開,只由 complete_booking() 內部用 perform 呼叫。';

revoke execute on function public.compute_member_loyalty_points(uuid) from public, anon, authenticated;

-- =========================================================================
-- §2 grant_pending_birthday_bonuses:新增 points_feature_enabled 守門。
--
-- 完整照抄 20260923010400_req619_reward_condition_mode_functions.sql:191 的版本,
-- 只加上:讀取 points_feature_enabled、權限檢查通過後的守門 return 0。
--
-- 守門的位置刻意放在「權限檢查之後、進迴圈之前」:
--   ・放在權限檢查之後 —— 沒有 members 權限的人不該因為「功能剛好關閉」就拿到一個
--     看起來成功的 0,權限錯誤還是要照樣拋出來(規則 2.10 的既有行為不能被這次修補改掉)。
--   ・放在迴圈之前 —— 功能關閉時一位會員都不處理,回傳 0(前端本來就用回傳值顯示
--     「這次補發了幾位」,0 代表沒有人要補發,前端不用改)。
-- =========================================================================
create or replace function public.grant_pending_birthday_bonuses(p_merchant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward_condition_mode text;
  v_points_feature_enabled boolean;
  v_bonus_points integer;
  v_granted_count integer := 0;
  v_member record;
  v_new_balance integer;
  v_current_year integer := extract(year from current_date)::int;
begin
  if not private.can_manage_members(p_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  select reward_condition_mode, birthday_bonus_points, points_feature_enabled
  into v_reward_condition_mode, v_bonus_points, v_points_feature_enabled
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    v_reward_condition_mode := 'none';
    v_bonus_points := 0;
    v_points_feature_enabled := true;
  end if;

  -- (2026-09-24 使用者裁決:「關閉後就不計算點數了。」)
  -- 紅利點數功能關閉時,生日贈點整批不處理:不發點、不標記 last_birthday_bonus_year,
  -- 回傳 0。不標記年份是刻意的,但要清楚它換到的是什麼:因為上面那段迴圈的查詢條件只撈
  -- 「生日在本月」的會員(extract(month from birthday) = extract(month from current_date)),
  -- 所以不標記真正保住的是「在該會員生日的那個月份之內重新打開,還補得回來」;一旦跨月,
  -- 不管有沒有標記年份都撈不到那位會員,補不回來(例:1 月關掉、3 月打開,2 月生日的人不會補發)。
  -- 即使如此不標記仍然是對的——標記了連同月內關掉又打開都補不回來,還會留下一筆
  -- 「今年已發過」的假紀錄讓之後查帳對不上。
  if not coalesce(v_points_feature_enabled, true) then
    return 0;
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

comment on function public.grant_pending_birthday_bonuses(uuid) is '模組 10 §3.11(規則 2.5,SPECS-INDEX #619 疊加,2026-09-24 再疊加 points_feature_enabled 守門):任何有 members 權限的人打開會員管理列表頁時觸發,檢查該商家「生日在本月、今年還沒發過生日獎勵」的會員並一次核發完畢。2026-09-24 使用者裁決「關閉後就不計算點數了」:points_feature_enabled 為 false 時,權限檢查照常執行(沒權限仍然拋 42501),但一位會員都不處理、直接回傳 0,而且不標記 last_birthday_bonus_year。不標記年份換到的是「在該會員生日的那個月份之內重新打開,還補得回來」,不是「當年度都補得回來」——這支函式只撈生日在本月的會員,跨月之後不管有沒有標記都撈不到(例:1 月關掉、3 月打開,2 月生日的會員不會補發)。#619:資格判斷用 reward_condition_mode(五選一)。用「生日當月」而不是嚴格「當天」容錯。回傳實際處理的會員數量,冪等操作。';

revoke execute on function public.grant_pending_birthday_bonuses(uuid) from public, anon;
grant execute on function public.grant_pending_birthday_bonuses(uuid) to authenticated;

-- =========================================================================
-- §3 更新 points_feature_enabled 的欄位註解。
--
-- 原本的註解結尾寫著「不影響任何後端核發/兌換/調整邏輯本身(那些函式沒有讀這個欄位…
-- 這個開關純粹是前端體驗層的顯示開關,不是資料庫層的安全邊界)」——這段話在這次修補之後
-- 已經不正確了,而且正是當初造成這個問題的設計說明,必須改掉,不能留著誤導之後的人。
-- =========================================================================
comment on column public.merchant_member_settings.points_feature_enabled is
  '商家是否啟用紅利點數功能(.project/SPECS-INDEX.md #617,2026-09-24 語意修正)。預設 true
  (沿用既有商家的實際使用狀況)。2026-09-24 使用者裁決:「關閉後就不計算點數了。」——
  這個欄位不再只是前端顯示開關,而是「後端會不會自動產生新的點數」的真正開關:
  【關閉時會停止的自動核發路徑】compute_member_loyalty_points(訂單完成的消費累點 + 連帶的
  推薦獎勵 referral_bonus)、grant_pending_birthday_bonuses(生日贈點)。這兩條都是系統自動
  觸發、商家沒有逐筆確認機會的路徑,關閉後完全不寫 member_point_transactions、不動
  members.points_balance,也不留下 last_birthday_bonus_year / referral_rewarded_at 標記。
  【重新打開後補不補得回來】兩條路徑不一樣,不要混為一談:推薦獎勵補得回來(關閉期間被推薦人
  沒有寫入任何 earn_booking,「第一筆消費累點」的資格還在,重新打開後他下次消費完成就會觸發,
  沒有時間限制);生日贈點只在「同一個月內」補得回來——grant_pending_birthday_bonuses 只撈
  「生日在本月」的會員,一旦跨月,不管有沒有標記 last_birthday_bonus_year 都撈不到,補不回來
  (例:1 月關掉、3 月才打開,2 月生日的那些會員不會補發)。
  【關閉時仍然可用的手動路徑】adjust_member_points(管理員手動調整)、redeem_member_points
  (登記兌換)、import_members_batch 的起始點數餘額。理由:關閉功能後既有點數餘額不會消失
  (#617 決定不清空資料),商家需要靠這些手動操作把既有餘額清算掉(讓客戶用完或直接歸零);
  把它們一起擋掉會讓商家無法收尾。這兩支都是商家主動點下去、且要填寫原因/用途的操作,
  不會出現「關了半年突然冒出一筆帳」的問題。
  【前端行為】關閉後隱藏建單表單與會員詳情頁的點數操作入口與數字;紅利點數管理頁
  (src/modules/members/MemberPointsPage.tsx)刻意「不」隱藏——餘額總覽、手動調整、登記兌換
  在功能關閉時照常顯示,這跟上面「關閉時仍然可用的手動路徑」是同一個理由(商家要能清算既有
  餘額,藏起來他就無法收尾)。既有點數餘額與異動歷史資料不受影響,重新開啟後完整還原顯示。';
