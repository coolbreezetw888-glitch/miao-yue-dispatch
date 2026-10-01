-- 紅利系統重構 批次 4:訂單完成時入帳改寫 + 給 #844 的「收回已入帳點數」合約函式。
-- 對應規格書 .project/specs/紅利系統重構.md(v2.3 + 檔尾 v2.4 主腦裁決)§八 批次 4:
--   §3.5    public.compute_member_loyalty_points 改寫主體(簽章不變、complete_booking 不動)
--           ・入帳 = bookings.points_planned 快照,不重算、不再讀 points_earn_rate(欄位批次 6 才 drop)
--           ・完成時不重查 reward_condition_mode(§2.7 / 第 9 題),只看 points_feature_enabled
--           ・推薦獎勵:開關 1 referral_inviter_reward_enabled、首次 referral_bonus / 後續 referral_repeat_bonus
--             (第 7 題「達標」= 這一次真的寫入了 earn_booking)
--   §3.11.2 private.reverse_booking_earned_points(給 #844 的固定合約)
--   v2.4 裁決 16:已下架會員的訂單完成時**維持現行照發**(不看 members.status),等使用者裁決 #942。
--
-- 【不做的事】
--   ・既有唯一索引 member_point_transactions_earn_booking_unique_idx 不動,仍用 on conflict do nothing
--     (「還原完成 → 再完成」的再入帳由 #844 migration C 在本支之後處理,§九末尾跨規格書事項)。
--   ・不做任何跨訂單自動反轉(§3.11.3)。
--
-- 【動工前指紋核對】2026-10-01 對正式庫 wjtbmmnakcriuaqoknsq(唯讀)查
--   md5(replace(prosrc, E'\r\n', E'\n')) / 長度,與規格書 §〇.1b 一致:
--   public.compute_member_loyalty_points(uuid)   5fe102beb17b1137b018b6c0f9081586 / 7640(本支改寫)
--   public.complete_booking(uuid)                4cfb14875fbb5ffc365373b046907520 / 1088(不改,只確認)
--   private.member_meets_reward_condition        0d988cddb7dbfb17e0b5dedd695c952f / 370(只呼叫)
--   新主體以正式庫 pg_get_functiondef 為底改寫,不是從舊 migration 複製。
--
-- 【鎖的順序】一律「訂單列 → 會員列(依 member id 由小到大)」,跟批次 3 的 refund_booking_redeem /
--   update_booking / cancel_booking 一致:
--   ・compute_member_loyalty_points 只由 complete_booking 呼叫,complete_booking 先 update 了訂單列(已持有
--     訂單列鎖),本函式再把「本單會員 + 推薦者」依 id 排序一次鎖起來。
--   ・reverse_booking_earned_points 自己先 for update 鎖訂單列,再把所有要動到的會員依 id 排序鎖起來。

-- =========================================================================
-- 1. §3.5 public.compute_member_loyalty_points(簽章不變)
-- =========================================================================
create or replace function public.compute_member_loyalty_points(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_merchant_id uuid;
  v_member_id uuid;
  v_points_planned integer;
  v_source text;
  v_status text;
  v_s public.merchant_member_settings;
  v_referred_by uuid;
  v_locked_referred_by uuid;
  v_referral_rewarded_at timestamptz;
  v_phone_verified boolean;
  v_line_bound boolean;
  v_balance integer;
  v_inserted boolean := false;
  v_completed_booking_count integer;
  v_is_first boolean;
  v_bonus_points integer;
  v_bonus_type text;
  v_referral_net integer;
  v_referrer_phone_verified boolean;
  v_referrer_line_bound boolean;
  v_referrer_balance integer;
begin
  -- 1. 讀訂單。沒有會員(訪客單)→ 不派點。
  select b.merchant_id, b.member_id, coalesce(b.points_planned, 0), b.source, b.status
  into v_merchant_id, v_member_id, v_points_planned, v_source, v_status
  from public.bookings b
  where b.id = p_booking_id;

  if not found or v_member_id is null then
    return;
  end if;

  -- 匯入的歷史訂單不觸發紅利(§2.4 表「匯入歷史訂單」列;既有行為是 import 根本不呼叫 complete_booking,
  -- 這裡再擋一次當保險,避免之後有人在匯入流程順手呼叫本函式)。
  -- 只處理已完成的訂單(complete_booking 先把狀態改成 completed 才 perform 本函式)。
  if v_source = 'import' or v_status <> 'completed' then
    return;
  end if;

  -- 2. 功能總開關(2026-09-24 使用者裁決「關閉後就不計算點數了」;§2.7 / 第 9 題:這是完成當下唯一
  --    還要看的東西)。關閉時消費入帳與推薦獎勵兩條「系統自動核發」路徑都不做,重新開啟也不補發。
  --    刻意放在鎖會員列之前:功能關閉時連鎖都不用拿。查無設定列 → 欄位預設值(功能開啟)。
  v_s := private.merchant_member_settings_effective(v_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    return;
  end if;

  -- 3. 鎖會員列:本單會員 + 推薦者,依 id 排序一次鎖(跟 reverse_booking_earned_points 同順序,
  --    避免「A 單完成」與「B 單收回」交叉鎖同兩位會員時互相死鎖)。
  --    v2.4 裁決 16:不看 members.status(已下架會員的訂單完成時照發,維持現行,等 #942 裁決)。
  select m.referred_by_member_id into v_referred_by
  from public.members m
  where m.id = v_member_id;

  if not found then
    return;
  end if;

  perform 1
  from public.members m
  where m.id in (v_member_id, v_referred_by)
  order by m.id
  for update;

  select m.phone_verified, m.line_bound, m.referred_by_member_id, m.referral_rewarded_at, m.points_balance
  into v_phone_verified, v_line_bound, v_locked_referred_by, v_referral_rewarded_at, v_balance
  from public.members m
  where m.id = v_member_id;

  -- 鎖之前讀的推薦人跟鎖之後不同(極少見:剛好有人同時改推薦人)→ 補鎖新的推薦人。
  if v_locked_referred_by is distinct from v_referred_by then
    v_referred_by := v_locked_referred_by;
    if v_referred_by is not null then
      perform 1 from public.members m where m.id = v_referred_by for update;
    end if;
  end if;

  -- 4. 消費入帳 = 建單時定案的 points_planned 快照(§2.4:不重算、不看現在的公式/價格;
  --    §2.7 / 第 9 題:不重查 reward_condition_mode —— 資格已在建單當下算進 points_planned_auto)。
  --    冪等:沿用既有唯一索引 member_point_transactions_earn_booking_unique_idx + on conflict do nothing;
  --    只有真的插入才加餘額(§1.5 保留;「還原完成後再完成」由 #844 migration C 改淨額判斷)。
  --
  --    (保留 2026-09-24 主腦裁決「推薦獎勵必須跟消費累點脫鉤」的精神)這一段刻意寫成**不會 return**
  --    的區塊:派 0 點(沒達門檻、進階模式沒命中、客服覆寫成 0)只是「跳過入帳」,下面的推薦獎勵仍然
  --    一定會被評估 —— 首次推薦獎勵不看這筆有沒有派到點(第 7 題)。原本用「消費幾元累積一點」的設定
  --    決定推薦獎勵發不發,等於把兩個不相關的功能綁在一起,這件事不能改回去。
  if v_points_planned > 0 then
    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id
    ) values (
      v_member_id, v_merchant_id, 'earn_booking', v_points_planned, v_balance + v_points_planned, p_booking_id
    )
    on conflict (booking_id) where transaction_type = 'earn_booking' do nothing;

    v_inserted := found;

    if v_inserted then
      update public.members
      set points_balance = v_balance + v_points_planned
      where id = v_member_id;
    end if;
  end if;

  -- 5. 推薦獎勵(§2.6 / §3.5 第 3 步)。
  --    開關 1 關 → 首次、後續都不發,也不標記 referral_rewarded_at(§2.6)。
  --    被推薦者(本單會員)與推薦者都要在「觸發當下」通過 reward_condition_mode(§2.7:推薦獎勵沒有
  --    建單這個定案時刻,仍在觸發當下評估;沿用既有兩道資格檢查)。
  if coalesce(v_s.referral_inviter_reward_enabled, false)
     and v_referred_by is not null
     and private.member_meets_reward_condition(v_s.reward_condition_mode, v_phone_verified, v_line_bound)
  then
    -- (保留 2026-09-24 使用者裁決「關閉期間被推薦人完成了訂單,那次『第一筆消費』的資格要視為已用掉」)
    -- 「第一筆」用「這位被推薦者的已完成訂單數 = 1」判斷,不是「第 1 筆 earn_booking」:已完成訂單這個
    -- 事實不受紅利開關影響,關閉期間完成的那一筆自然就把名額用掉,關閉期間不需要寫任何標記就達成
    -- 「不補發」。= 1 是因為 complete_booking 先把本單改成 completed 才呼叫本函式,本單已被算進來。
    select count(*) into v_completed_booking_count
    from public.bookings
    where member_id = v_member_id and status = 'completed';

    v_is_first := v_completed_booking_count = 1 and v_referral_rewarded_at is null;

    if v_is_first then
      v_bonus_points := coalesce(v_s.referral_bonus_points, 0);
      v_bonus_type := 'referral_bonus';
    elsif v_inserted then
      -- 第 7 題「達標」:這一次真的寫入了 earn_booking(points_planned > 0 且功能開啟且不是重複呼叫)。
      v_bonus_points := coalesce(v_s.referral_subsequent_bonus_points, 0);
      v_bonus_type := 'referral_repeat_bonus';
    else
      v_bonus_points := 0;
    end if;

    if v_bonus_points > 0 then
      -- 冪等(§1.5 淨額判斷,不靠唯一索引):本單發給這位推薦者的推薦獎勵淨額
      -- (referral_bonus + referral_repeat_bonus + referral_bonus_reversal)> 0 就不再發。
      select coalesce(sum(t.points_delta), 0) into v_referral_net
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.member_id = v_referred_by
        and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal');

      if v_referral_net <= 0 then
        select m.phone_verified, m.line_bound, m.points_balance
        into v_referrer_phone_verified, v_referrer_line_bound, v_referrer_balance
        from public.members m
        where m.id = v_referred_by;

        if found and private.member_meets_reward_condition(
             v_s.reward_condition_mode, v_referrer_phone_verified, v_referrer_line_bound)
        then
          insert into public.member_point_transactions (
            member_id, merchant_id, transaction_type, points_delta, balance_after,
            booking_id, related_member_id
          ) values (
            v_referred_by, v_merchant_id, v_bonus_type, v_bonus_points,
            v_referrer_balance + v_bonus_points, p_booking_id, v_member_id
          );

          update public.members
          set points_balance = v_referrer_balance + v_bonus_points
          where id = v_referred_by;
        end if;
      end if;
    end if;

    -- 既有規則 2.4 第 5 點:首次資格成立時,不論獎勵點數是否 > 0、推薦者是否通過資格條件,
    -- 都標記 referral_rewarded_at,避免之後調整設定值又重複觸發。
    if v_is_first then
      update public.members set referral_rewarded_at = now() where id = v_member_id;
    end if;
  end if;
end;
$function$;

comment on function public.compute_member_loyalty_points(uuid) is '紅利系統重構 §3.5(批次 4 改寫主體,簽章不變,只由 complete_booking 內部 perform 呼叫):訂單完成當下,把建單時定案的 bookings.points_planned 快照入帳成 earn_booking(不重算、不讀 points_earn_rate、不重查 reward_condition_mode;只看 points_feature_enabled 開關,關閉 = 不入帳、不補發)。冪等沿用 earn_booking 每單一筆唯一索引 + on conflict do nothing(還原完成後再入帳由 #844 migration C 改淨額判斷)。推薦獎勵(§2.6):referral_inviter_reward_enabled 開啟時,被推薦者第 1 筆已完成訂單 → 推薦者得 referral_bonus_points(referral_bonus,不看本單有沒有派到點);之後每一筆「這次真的寫入了 earn_booking」的訂單 → referral_subsequent_bonus_points(referral_repeat_bonus);被推薦者與推薦者都要在觸發當下符合 reward_condition_mode;本單推薦獎勵淨額 > 0 不再發(冪等)。首次資格成立即標記 referral_rewarded_at。匯入訂單(source=import)與非 completed 訂單不處理。v2.4 裁決 16:不看會員 status(已下架照發,等 #942)。鎖順序:訂單列(complete_booking 已持有)→ 本單會員與推薦者依 id 排序。';

revoke execute on function public.compute_member_loyalty_points(uuid) from public, anon, authenticated;

-- =========================================================================
-- 2. §3.11.2 private.reverse_booking_earned_points(給 #844 的固定合約)
-- =========================================================================
create or replace function private.reverse_booking_earned_points(
  p_booking_id uuid,
  p_points_due integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_merchant_id uuid;
  v_completed_at timestamptz;
  v_lock_ids uuid[];
  v_row record;
  v_balance integer;
  v_recovered integer;
  v_points_due integer := 0;
  v_points_recovered integer := 0;
  v_member_count integer := 0;
  v_member_name text;
  v_member_hint text;
  v_referral_due integer := 0;
  v_referral_recovered integer := 0;
  v_referrer_count integer := 0;
  v_referrer_member_id uuid := null;
  v_orders text;
  v_hint text := null;
begin
  -- 0. 先鎖訂單列:同一張單的入帳(complete_booking)/ 收回 / 退回折抵全部排隊,淨額在鎖之後才算,
  --    重複呼叫第二次一定看到淨額 0 ⇒ 什麼都不寫(冪等)。
  select b.merchant_id, b.completed_at
  into v_merchant_id, v_completed_at
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約' using errcode = 'P0002';
  end if;

  -- 1. 會員列鎖:本單入帳的會員、拿到本單推薦獎勵的推薦者、以及推薦獎勵對應的被推薦者(收回首次獎勵
  --    時要清他的 referral_rewarded_at),依 id 排序一次鎖。
  --    §3.11.2 第 7 步:**不檢查 members.status**(下架 ≠ 帳戶結清,下架會員照樣收回)。
  select coalesce(array_agg(distinct s.id order by s.id), '{}')
  into v_lock_ids
  from (
    select t.member_id as id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    union
    select t.member_id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    union
    select t.related_member_id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type = 'referral_bonus'
      and t.related_member_id is not null
  ) s
  where s.id is not null;

  perform 1
  from public.members m
  where m.id = any(v_lock_ids)
  order by m.id
  for update;

  -- 應收回 due = 本單有效入帳(Σ earn_booking + Σ earn_booking_reversal 的 points_delta;後者為負)。
  select coalesce(sum(x.net), 0)::int
  into v_points_due
  from (
    select sum(t.points_delta) as net
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
  ) x;

  -- 呼叫端有傳應收回點數、但跟分類帳算出來的不一樣 → 擋下(防止呼叫端算錯)。
  if p_points_due is not null and p_points_due <> v_points_due then
    raise exception '應收回點數不一致:呼叫端傳入 % 點,分類帳上這張訂單的有效入帳是 % 點', p_points_due, v_points_due
      using errcode = '22023';
  end if;

  -- 2./3. 收回本單入帳:扣到 0 為止(第 1 題定案 A,不放寬兩道「不可為負」CHECK);
  --        有實際扣到點(recovered > 0)才寫 earn_booking_reversal;recovered = 0 不寫列
  --        (points_delta <> 0 CHECK,主腦裁決),三個數字由回傳值帶給呼叫端。
  --    §3.11.2 第 8 步:**不讀 points_feature_enabled**(收回是拿回不該給的,不是新派點)。
  --    #844 批次 4 修正(2026-10-01,本支尚未上線直接改):差額提示**依會員分句**。本單有效入帳 > 0 的會員
  --    通常只有 1 位;#844 邊界 19「還原後換了會員、舊會員上一輪有差額沒收回」會有 2 位。原本把所有會員的
  --    應收回 / 餘額 / 已收回加總成一句,而且只找第一位會員的折抵訂單 ⇒ 兩位會員的數字混在一起講。
  --    現在每位有差額的會員各一句、各自找自己的折抵訂單;只有 1 位時文字與原本逐字相同(不冠姓名),
  --    2 位以上才在句首冠「會員「姓名」」讓操作者分得出是誰。
  select count(*)::int
  into v_member_count
  from (
    select 1
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
  ) x;

  for v_row in
    select t.member_id, sum(t.points_delta)::int as net
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    order by t.member_id
  loop
    select m.points_balance, m.name into v_balance, v_member_name from public.members m where m.id = v_row.member_id;
    if not found then
      continue;  -- 會員已被硬刪(分類帳 on delete cascade 會一起消失,理論上到不了)
    end if;

    v_recovered := least(v_row.net, v_balance);

    if v_recovered > 0 then
      update public.members
      set points_balance = v_balance - v_recovered
      where id = v_row.member_id;

      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
      ) values (
        v_row.member_id, v_merchant_id, 'earn_booking_reversal', -v_recovered, v_balance - v_recovered, p_booking_id,
        format('應收回 %s 點、實收回 %s 點、差額 %s 點未收回', v_row.net, v_recovered, v_row.net - v_recovered),
        auth.uid()
      );
    end if;

    v_points_recovered := v_points_recovered + v_recovered;

    -- 提示文字(這位會員有差額才寫;由呼叫端 #844 顯示給操作者;本函式不 raise、不擋取消)。
    if v_row.net - v_recovered > 0 then
      if v_member_count > 1 then
        v_member_hint := format('會員「%s」應收回 %s 點,目前只有 %s 點,已收回 %s 點,差額 %s 點未收回。',
                                v_member_name, v_row.net, v_balance, v_recovered, v_row.net - v_recovered);
      else
        v_member_hint := format('應收回 %s 點,會員目前只有 %s 點,已收回 %s 點,差額 %s 點未收回。',
                                v_row.net, v_balance, v_recovered, v_row.net - v_recovered);
      end if;

      -- 「訂單 #B」:**這位會員**在本單完成之後、最近幾筆仍有紅利折抵的訂單(找不到就省略這一句)。
      -- 系統沒有訂單編號,用「台北時間 預約時間 + 客戶姓名」讓操作者認得出是哪張單。
      select string_agg(x.label, '、' order by x.last_redeem_at desc)
      into v_orders
      from (
        select format('訂單「%s %s」',
                      to_char(b.start_at at time zone 'Asia/Taipei', 'YYYY/MM/DD HH24:MI'),
                      b.customer_name) as label,
               max(t.created_at) as last_redeem_at
        from public.member_point_transactions t
        join public.bookings b on b.id = t.booking_id
        where t.member_id = v_row.member_id
          and t.transaction_type = 'redeem_booking'
          and t.booking_id <> p_booking_id
          and b.points_redeemed > 0
          and b.status <> 'cancelled'
          and t.created_at >= coalesce(v_completed_at, '-infinity'::timestamptz)
        group by b.id, b.start_at, b.customer_name
        order by max(t.created_at) desc
        limit 3
      ) x;

      if v_orders is not null then
        v_member_hint := v_member_hint || format('這 %s 點是在%s折抵掉的,如果要一併追回,請到%s取消紅利折抵,或用『手動調整點數』扣除。',
                                                 v_row.net - v_recovered, v_orders, v_orders);
      end if;

      v_hint := coalesce(v_hint || ' ', '') || v_member_hint;
    end if;
  end loop;

  -- 4. 推薦獎勵一併收回(第 8 題):本單發給推薦者的 referral_bonus / referral_repeat_bonus,淨額
  --    (扣掉已有的 referral_bonus_reversal)> 0 者,同樣扣到 0 為止、收得到才寫列;推薦者已下架也照扣。
  --    收回的是首次獎勵且**全額收回**(v2.4 裁決 17)→ 清掉被推薦者的 referral_rewarded_at,讓他下一筆完成的
  --    訂單重新觸發首次獎勵;有差額就不清。
  --    (本單會員與推薦者若是同一人,上面的入帳收回已先扣過,這裡讀到的是扣完後的餘額。)
  --    #844 批次 4 修正:推薦人差額提示同樣**依推薦人分句**(邊界 19 換過會員時,新舊會員可能各有推薦人);
  --    只有 1 位推薦人時文字與原本逐字相同,2 位以上才冠「推薦人「姓名」」。
  select count(*)::int
  into v_referrer_count
  from (
    select 1
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
  ) x;

  for v_row in
    select t.member_id,
           sum(t.points_delta)::int as net,
           bool_or(t.transaction_type = 'referral_bonus') as has_first,
           (array_agg(t.related_member_id) filter (
              where t.transaction_type in ('referral_bonus', 'referral_repeat_bonus')
                and t.related_member_id is not null))[1] as invitee_id
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('referral_bonus', 'referral_repeat_bonus', 'referral_bonus_reversal')
    group by t.member_id
    having sum(t.points_delta) > 0
    order by t.member_id
  loop
    select m.points_balance, m.name into v_balance, v_member_name from public.members m where m.id = v_row.member_id;
    if not found then
      continue;
    end if;

    v_referrer_member_id := coalesce(v_referrer_member_id, v_row.member_id);
    v_referral_due := v_referral_due + v_row.net;
    v_recovered := least(v_row.net, v_balance);

    if v_recovered > 0 then
      update public.members
      set points_balance = v_balance - v_recovered
      where id = v_row.member_id;

      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id,
        related_member_id, note, created_by_user_id
      ) values (
        v_row.member_id, v_merchant_id, 'referral_bonus_reversal', -v_recovered, v_balance - v_recovered, p_booking_id,
        v_row.invitee_id,
        format('應收回 %s 點、實收回 %s 點、差額 %s 點未收回', v_row.net, v_recovered, v_row.net - v_recovered),
        auth.uid()
      );
    end if;

    v_referral_recovered := v_referral_recovered + v_recovered;

    -- 推薦人差額的提示(這位推薦人有差額才寫,接在會員提示之後)。
    if v_row.net - v_recovered > 0 then
      v_hint := coalesce(v_hint || ' ', '') ||
                case when v_referrer_count > 1 then
                  format('推薦人「%s」應收回推薦獎勵 %s 點,目前只有 %s 點,已收回 %s 點,差額 %s 點未收回;如果要一併追回,請用『手動調整點數』扣除。',
                         v_member_name, v_row.net, v_balance, v_recovered, v_row.net - v_recovered)
                else
                  format('推薦人應收回推薦獎勵 %s 點,推薦人目前只有 %s 點,已收回 %s 點,差額 %s 點未收回;如果要一併追回,請用『手動調整點數』扣除。',
                         v_row.net, v_balance, v_recovered, v_row.net - v_recovered)
                end;
    end if;

    -- v2.4 裁決 17:只有本次收回後,本單推薦獎勵淨額歸 0(全額收回)才清被推薦者的「已拿過首次」標記;
    -- 有差額(推薦者餘額不足)就不清,否則被推薦者下一張單又會觸發一次首次獎勵(第 8 題防刷點)。
    -- 之後再呼叫收回把差額收齊、淨額歸 0 時,當次再清。
    if v_row.has_first and v_row.invitee_id is not null and v_row.net - v_recovered = 0 then
      update public.members set referral_rewarded_at = null where id = v_row.invitee_id;
    end if;
  end loop;

  -- 5. bookings.points_planned 不動(建單時的承諾快照,留給稽核與訂單詳情顯示)。
  -- 6. 不做任何跨訂單自動反轉(§3.11.3 使用者裁決):差額只反映在回傳值、note 與下面的提示文字。

  -- 差額提示已在上面兩個迴圈裡依會員 / 推薦人分句寫好(會員在前、推薦人在後)。

  return jsonb_build_object(
    'points_due', v_points_due,
    'points_recovered', v_points_recovered,
    'points_shortfall', v_points_due - v_points_recovered,
    'referral_due', v_referral_due,
    'referral_recovered', v_referral_recovered,
    'referral_shortfall', v_referral_due - v_referral_recovered,
    'referrer_member_id', v_referrer_member_id,
    'shortfall_hint', v_hint
  );
end;
$function$;

comment on function private.reverse_booking_earned_points(uuid, integer) is '紅利系統重構 §3.11.2(給 #844 的固定合約):收回本單已入帳點數。先 for update 鎖訂單列,再依 id 排序鎖所有要動到的會員。應收回 = 本單有效入帳(Σ earn_booking − Σ 已收回);p_points_due 有傳且不一致 → raise 22023。實收回 = least(應收回, 會員目前餘額),扣到 0 為止,不放寬「不可為負」兩道 CHECK;實收回 > 0 才寫 earn_booking_reversal(note:應收回 N 點、實收回 M 點、差額 K 點未收回),= 0 不寫列(points_delta <> 0)。推薦者因本單拿到的首次/後續推薦獎勵一併同樣收回(referral_bonus_reversal);收回首次獎勵且本單推薦獎勵淨額因此歸 0(全額收回)時才清掉被推薦者 referral_rewarded_at,有差額不清,之後補收齊當次再清(v2.4 裁決 17)。不看會員 status、不看 points_feature_enabled;不動 bookings.points_planned;不做跨訂單自動反轉。淨額為 0 時什麼都不寫、回傳全 0(冪等)。回傳 jsonb:points_due/points_recovered/points_shortfall/referral_due/referral_recovered/referral_shortfall/referrer_member_id/shortfall_hint(有差額時才有值,由呼叫端顯示)。只准內部呼叫。';

revoke execute on function private.reverse_booking_earned_points(uuid, integer) from public, anon, authenticated;
