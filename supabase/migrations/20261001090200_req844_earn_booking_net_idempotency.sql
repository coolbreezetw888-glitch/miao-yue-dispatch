-- #844 已完成訂單可取消/還原 —— 批次 3(migration C):earn_booking 改淨額入帳 + complete_booking 加鎖
--   + 三處「已入帳」改看淨額。
-- 規格:.project/specs/已完成訂單取消與還原.md v1.2 §2.4、§3.11、§4.7、§4.8、§一 #8 #31 #32、§七 邊界 19~22、
--       §十 module17_02;檔尾 ✅ 使用者裁決 Q11 = A(補到應得:v_topup := points_planned − v_net,> 0 才寫)。
--       紅利規格書 .project/specs/紅利系統重構.md §1.5、§3.5、§九末尾、檔尾 v2.4 第 17、18 條。
-- 疊在紅利重構 8 批(20261001020000 ~ 20261001080000)與 #844 批次 1、2(20261001090000、20261001090100)之上。
--
-- 【本檔改了什麼】
--   1. drop index public.member_point_transactions_earn_booking_unique_idx
--      + 改寫 public.compute_member_loyalty_points 第 4、5 步(簽章不變)。
--      🔴 兩件事必須在同一支 migration(§2.4):索引拿掉、函式沒改 ⇒ `on conflict (booking_id) where
--      transaction_type='earn_booking'` 找不到對應索引,整支函式報錯、所有訂單都完成不了;函式改了、
--      索引沒拿掉 ⇒ 「還原 → 再完成」第二筆 earn_booking 被索引擋下報錯。
--   2. public.complete_booking:讀狀態那一句加 `for update`,其餘逐字不動(§3.11 / v2.4 第 18 條⑤)。
--   3. public.get_member_related_bookings:earned_points 改「本單、本會員的有效入帳」,尾端加 reversed_points
--      (回傳型別變了 ⇒ drop + create + 補回 revoke/grant)。
--   4. public.render_booking_notification_variables:points_earned 改「本單、bookings.member_id 那位會員的
--      有效入帳」,≤ 0 給空字串;其餘逐字不動。
--
-- 【底稿與指紋】md5(replace(prosrc, E'\r\n', E'\n')) / 長度,2026-10-01 核對:
--   public.compute_member_loyalty_points(uuid)
--       底稿 = 本機紅利批次 4 20261001050000 的主體:8ae9507e9efbe8b92d0a079efccf1e1a / 6486
--       (本機 db reset 後 = 該檔內容;正式庫還是舊版 5fe102beb17b1137b018b6c0f9081586 / 7640,不拿它當底)
--   public.complete_booking(uuid)
--       底稿 = 正式庫 wjtbmmnakcriuaqoknsq(唯讀 SELECT):4cfb14875fbb5ffc365373b046907520 / 1088(= 本機)
--   public.render_booking_notification_variables(uuid)
--       底稿 = 正式庫(唯讀 SELECT):ba1be075820bf4c1c65b88cde5b276e0 / 1510(= 本機;紅利沒改這支)
--   public.get_member_related_bookings(uuid)
--       底稿 = 本機紅利批次 7 20261001080000:9ce9a3094a22d17df31dcfc8ac537472 / 1318
--       (正式庫還是舊版 7589ec5c941c53d4b6eb007ba4648b44 / 1174)
--   ⇒ 本檔必須跟紅利 8 批 + #844 批次 1、2 同一次或之後上線。
--
-- 【鎖的順序】不變:一律「訂單列 → 會員列(依 id 由小到大)」。complete_booking 現在先 for update 鎖訂單列
--   (原本是 update 時才拿到同一把鎖),compute_member_loyalty_points 再依 id 排序鎖會員列 ——
--   跟 reverse_booking_earned_points / refund_booking_redeem / cancel_booking / update_booking / 反轉引擎一致。

-- =========================================================================
-- 1. §2.4 移除 earn_booking 每單一筆唯一索引(冪等改由 compute_member_loyalty_points 的淨額判斷負責)
-- =========================================================================
drop index if exists public.member_point_transactions_earn_booking_unique_idx;

-- =========================================================================
-- 2. §4.7 public.compute_member_loyalty_points(簽章不變;底稿 = 紅利批次 4 主體,只改第 4、5 步)
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
  v_net integer := 0;
  v_topup integer := 0;
  v_net_after integer := 0;
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
  --
  --    【#844 migration C 改寫(20261001090200)】原本的冪等是「earn_booking 每單一筆唯一索引 +
  --    on conflict do nothing」;#844「還原完成 → 再完成」需要同一張單寫第二筆 earn_booking,索引已在
  --    本 migration 移除,冪等改成「鎖會員列(上面第 3 步)之後算淨額」:
  --      v_net   = 本單 + 本單**目前**的會員,Σ earn_booking + Σ earn_booking_reversal(後者為負)。
  --                還原後換了會員 ⇒ 新會員從 0 開始算;舊會員沒收回的差額留在舊會員身上(#844 邊界 19)。
  --      v_topup = points_planned − v_net(✅ 使用者裁決 Q11 = A「補到應得」):
  --                > 0 才寫一筆 earn_booking(points_delta = v_topup,不帶 on conflict)並加餘額;
  --                ≤ 0 不寫 —— 已完成的單重複呼叫(v_net = planned)、或改單後應得比沒收回的差額還少
  --                (#844 邊界 21:不補、也不自動倒扣,要扣請管理員手動調整)都落在這裡。
  --    淨額在鎖會員列之後才算:兩個交易同時入帳同一張單時,後到的一定看得到先到的那一筆。
  --    (complete_booking 本身也已在本 migration 加 for update,同一張單根本不會同時完成兩次。)
  --
  --    (保留 2026-09-24 主腦裁決「推薦獎勵必須跟消費累點脫鉤」的精神)這一段刻意寫成**不會 return**
  --    的區塊:派 0 點(沒達門檻、進階模式沒命中、客服覆寫成 0)只是「跳過入帳」,下面的推薦獎勵仍然
  --    一定會被評估 —— 首次推薦獎勵不看這筆有沒有派到點(第 7 題)。原本用「消費幾元累積一點」的設定
  --    決定推薦獎勵發不發,等於把兩個不相關的功能綁在一起,這件事不能改回去。
  select coalesce(sum(t.points_delta), 0)::int into v_net
  from public.member_point_transactions t
  where t.booking_id = p_booking_id
    and t.member_id = v_member_id
    and t.transaction_type in ('earn_booking', 'earn_booking_reversal');

  v_topup := v_points_planned - v_net;

  if v_topup > 0 then
    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id
    ) values (
      v_member_id, v_merchant_id, 'earn_booking', v_topup, v_balance + v_topup, p_booking_id
    );

    update public.members
    set points_balance = v_balance + v_topup
    where id = v_member_id;

    v_inserted := true;
  end if;

  v_net_after := v_net + case when v_inserted then v_topup else 0 end;

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
    elsif v_net_after > 0 then
      -- 第 7 題「達標」(#844 migration C / 紅利 v2.4 第 18 條⑥ 改判斷):這次完成之後,本單對這位會員
      -- 是有派到點的(有效入帳 > 0)。不再用「這次真的寫入了 earn_booking」:部分收回情境(本單會員
      -- 差額沒收回、推薦人那筆後續獎勵已全額收回)再完成時,本次只補差額、甚至不寫,舊判斷會讓推薦人的
      -- 後續獎勵永遠不重新發。重複發放由下面「本單推薦獎勵淨額 ≤ 0 才發」(v_referral_net)擋住。
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

comment on function public.compute_member_loyalty_points(uuid) is '紅利系統重構 §3.5(批次 4 改寫主體)+ #844 migration C(20261001090200)改淨額入帳。簽章不變,只由 complete_booking 內部 perform 呼叫:訂單完成當下,把建單時定案的 bookings.points_planned 快照入帳成 earn_booking(不重算、不讀 points_earn_rate、不重查 reward_condition_mode;只看 points_feature_enabled 開關,關閉 = 不入帳、不補發)。冪等不靠唯一索引(已移除,同一張單「完成 → 還原 → 再完成」可以有多筆 earn_booking):鎖會員列後算本單 + 本單目前會員的淨額(earn_booking + earn_booking_reversal),補到應得 = points_planned − 淨額,> 0 才寫一筆並加餘額(#844 Q11 裁決 A);≤ 0 不寫、也不倒扣。推薦獎勵(§2.6):referral_inviter_reward_enabled 開啟時,被推薦者第 1 筆已完成訂單 → 推薦者得 referral_bonus_points(referral_bonus,不看本單有沒有派到點);之後每一筆「這次完成後本單對這位會員有效入帳 > 0」的訂單 → referral_subsequent_bonus_points(referral_repeat_bonus);被推薦者與推薦者都要在觸發當下符合 reward_condition_mode;本單推薦獎勵淨額 > 0 不再發(冪等)。首次資格成立即標記 referral_rewarded_at。匯入訂單(source=import)與非 completed 訂單不處理。v2.4 裁決 16:不看會員 status(已下架照發,等 #942)。鎖順序:訂單列(complete_booking 已 for update)→ 本單會員與推薦者依 id 排序。';

revoke execute on function public.compute_member_loyalty_points(uuid) from public, anon, authenticated;

-- =========================================================================
-- 3. §3.11 public.complete_booking:讀狀態加 for update(底稿 = 正式庫 4cfb1487… / 1088,其餘逐字不動)
--    唯一索引拿掉之後,兩個人同時按「標記完成」:兩邊都讀到 accepted,第二個等第一個提交後照樣再 update
--    一次 ⇒ 兩筆「已確認 → 已完成」操作紀錄、前端發兩次 LINE。加鎖後第二個人讀到 completed,被既有檢查
--    擋下「只有「已接受」狀態的預約可以標記完成」。跟紅利批次 3 給 cancel_booking 加的是同一種修法。
--    create or replace、簽章不變 ⇒ 既有 EXECUTE 權限不會被重設。
-- =========================================================================
CREATE OR REPLACE FUNCTION public.complete_booking(p_booking_id uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

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

  -- 模組 8(薪資與帳務)§3.7 既有的一行:訂單成功轉為 completed 之後,計算抽成快照。
  perform public.compute_booking_commission(p_booking_id);

  -- 模組 10(會員與紅利)§3.8 既有的一行:訂單成功轉為 completed 之後,計算會員紅利點數。
  perform public.compute_member_loyalty_points(p_booking_id);

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'completed');

  return v_result;
end;
$function$;

-- =========================================================================
-- 4. §4.8 第 1 點 public.get_member_related_bookings
--    底稿 = 紅利批次 7 20261001080000,只改 earned_points 那個子查詢 + 尾端加 reversed_points。
--    earned_points:本單、本會員(p_member_id)的有效入帳 = Σ earn_booking + Σ earn_booking_reversal;
--      本單本會員從來沒有 earn_booking ⇒ null(維持「從未入帳」語意)。
--    reversed_points:本單本會員被收回的點數(正數),沒有為 0。
--    回傳型別變了 ⇒ 不能 create or replace,要 drop + create,並補回 revoke/grant(supabase-permission-hygiene)。
-- =========================================================================
drop function if exists public.get_member_related_bookings(uuid);

create function public.get_member_related_bookings(p_member_id uuid)
returns table (
  id uuid,
  start_at timestamptz,
  status text,
  final_amount_snapshot numeric,
  service_item_names text[],
  earned_points integer,
  points_planned integer,
  points_redeemed integer,
  points_planned_overridden boolean,
  reversed_points integer
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- 同上:RETURNS TABLE 也定義了 id 欄位,查詢 members 表時明確加上別名限定。
  select m.merchant_id into v_merchant_id from public.members m where m.id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  -- 刻意檢查 can_manage_members,不是 can_manage_bookings——這是這支函式存在的核心理由
  -- (一之二節方向二),即使呼叫者只有 orders 權限、沒有 members 權限也一樣被擋下。
  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  return query
    select
      b.id,
      b.start_at,
      b.status,
      b.final_amount_snapshot,
      coalesce(
        (select array_agg(si.name order by si.name)
         from public.booking_service_items bsi
         join public.service_items si on si.id = bsi.service_item_id
         where bsi.booking_id = b.id),
        array[]::text[]
      ) as service_item_names,
      -- #844 §4.8:有效入帳(本單 + 本會員,入帳 − 收回)。同一張單「完成 → 還原 → 再完成」後可能有
      -- 多筆 earn_booking,不能再取任意一筆的毛額;從未入帳 ⇒ null。
      lp.earned_points,
      -- 紅利系統重構 §3.13(批次 7):會員詳情頁「相關訂單」每列顯示「預定 / 已入帳 / 折抵」。
      b.points_planned,
      b.points_redeemed,
      b.points_planned_overridden,
      lp.reversed_points
    from public.bookings b
    cross join lateral (
      select
        case when bool_or(t.transaction_type = 'earn_booking')
             then coalesce(sum(t.points_delta), 0)::int end as earned_points,
        coalesce(-sum(t.points_delta) filter (where t.transaction_type = 'earn_booking_reversal'), 0)::int
          as reversed_points
      from public.member_point_transactions t
      where t.booking_id = b.id
        and t.member_id = p_member_id
        and t.transaction_type in ('earn_booking', 'earn_booking_reversal')
    ) lp
    where b.member_id = p_member_id
    order by b.start_at desc
    limit 50;
end;
$$;

comment on function public.get_member_related_bookings(uuid) is '模組 10 §3.13(一之二節 RLS 影響評估方向二):回傳指定會員的歷史訂單清單(上限 50 筆,新到舊),含紅利點數;紅利系統重構批次 7 加回 points_planned / points_redeemed / points_planned_overridden(預定派點、折抵點數、是否人工設定);#844 migration C:earned_points 改成本單、本會員的有效入帳(earn_booking − 收回,從未入帳為 null),尾端加 reversed_points(本單本會員被收回的點數,沒有為 0)。SECURITY DEFINER 繞過 bookings_select,只回傳會員詳情頁需要的欄位,不曝露內部備註等敏感欄位。檢查 can_manage_members,不是 can_manage_bookings。';

revoke execute on function public.get_member_related_bookings(uuid) from public, anon;
grant execute on function public.get_member_related_bookings(uuid) to authenticated;

-- =========================================================================
-- 5. §4.8 第 2 點 public.render_booking_notification_variables
--    底稿 = 正式庫 ba1be075… / 1510(紅利沒改這支),只改 points_earned 那一句查詢:
--    原本取「最新一筆 earn_booking」⇒ 再完成時若只補了差額(Q11 A),LINE 會寫「獲得 10 點」。
--    改成本單、bookings.member_id 那位會員的有效入帳(入帳 − 收回);≤ 0 或沒有 ⇒ 空字串(跟原本「沒有入帳」一樣)。
-- =========================================================================
CREATE OR REPLACE FUNCTION public.render_booking_notification_variables(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
  v_merchant_name text;
  v_service_names text;
  v_staff_name text;
  v_points_earned int;
begin
  select * into v_booking from public.bookings where id = p_booking_id;
  if v_booking.id is null then
    raise exception '找不到這筆預約';
  end if;

  select name into v_merchant_name from public.merchants where id = v_booking.merchant_id;

  select string_agg(si.name, '、' order by bsi.created_at)
  into v_service_names
  from public.booking_service_items bsi
  join public.service_items si on si.id = bsi.service_item_id
  where bsi.booking_id = p_booking_id;

  select name into v_staff_name from public.merchant_staff where id = v_booking.staff_id;

  -- #844 §4.8:本單、本單目前會員的有效入帳(入帳 − 收回),不是最後一筆 earn_booking。
  select sum(points_delta)::int into v_points_earned
  from public.member_point_transactions
  where booking_id = p_booking_id
    and member_id = v_booking.member_id
    and transaction_type in ('earn_booking', 'earn_booking_reversal');

  if v_points_earned is not null and v_points_earned <= 0 then
    v_points_earned := null;
  end if;

  return jsonb_build_object(
    'merchant_name', coalesce(v_merchant_name, ''),
    'customer_name', coalesce(v_booking.customer_name, ''),
    'booking_date', to_char(v_booking.start_at at time zone 'Asia/Taipei', 'YYYY-MM-DD HH24:MI'),
    'service_names', coalesce(v_service_names, ''),
    'final_amount', coalesce(trim(to_char(v_booking.final_amount_snapshot, 'FM999999990')), ''),
    'staff_name', coalesce(v_staff_name, ''),
    'member_name', coalesce(v_booking.member_name_snapshot, ''),
    'cancel_reason', coalesce(v_booking.cancelled_reason, ''),
    'points_earned', coalesce(v_points_earned::text, '')
  );
end;
$function$;

-- create or replace 不會重設權限;這裡再明確寫一次,讓本檔單獨閱讀也看得出這支只給 service role。
revoke execute on function public.render_booking_notification_variables(uuid) from public, anon, authenticated;
grant execute on function public.render_booking_notification_variables(uuid) to service_role;
