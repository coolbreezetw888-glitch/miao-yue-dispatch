-- 紅利系統重構 批次 2:計算引擎 + 建單預覽 + 依電話找會員的共用函式。
-- 對應規格書 .project/specs/紅利系統重構.md(v2.3/v2.4)§八 批次 2:
--   §3.1 private.compute_booking_planned_points(含 p_assume_new_member)—— 派點的唯一計算引擎
--   §3.2 public.preview_booking_points —— 建單頁即時預覽(唯讀),取代 #917(從未建立,無東西要刪)
--   §3.2 末段 private.resolve_booking_member_by_phone —— 「依電話找會員」共用 helper
--        (此批**只新增**,create_booking 在批次 3 才改成呼叫它;本批不動 create_booking)
--   §2.10 折抵上限/換算:抽成兩支純函式,預覽與批次 3 的 create_booking/update_booking 共用同一套算式
--
-- 【動工前指紋核對】2026-10-01 對正式庫(唯讀)查 md5(replace(prosrc, CRLF, LF)),與 §〇.1b 一致:
--   public.create_booking                 b9da6db2d4dce942255be007e161db59 / 9633(本批不改,只逐字搬出比對那一句)
--   public.update_booking                 e97f02778781d1b1a6d83801e42d80ce / 6360(本批不改)
--   private.calculate_booking_amount      605f707d1635f95bd686fa930dd080bf / 1355(只呼叫)
--   private.member_meets_reward_condition 0d988cddb7dbfb17e0b5dedd695c952f / 370(只呼叫)
--   public.compute_member_loyalty_points  5fe102beb17b1137b018b6c0f9081586 / 7640(本批不改)
--   正式庫尚無 preview_booking_points / compute_booking_planned_points / resolve_booking_member_by_phone。
--
-- 【對既有行為的影響】零。本支只新增函式,沒有改任何既有函式、表、政策。

-- =========================================================================
-- 0. private.merchant_member_settings_effective:讀商家紅利設定,查無列時回「欄位預設值」
--    (引擎與預覽共用,避免兩邊各寫一份預設值而分岔)。
-- =========================================================================
create or replace function private.merchant_member_settings_effective(p_merchant_id uuid)
returns public.merchant_member_settings
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.merchant_member_settings;
begin
  select * into v_s from public.merchant_member_settings where merchant_id = p_merchant_id;
  if found then
    return v_s;
  end if;

  -- 查無列(例如直接 insert merchants、沒走 seed_default_member_settings 的商家):
  -- 逐欄照 schema 的 DEFAULT(20260920140000 / 20260922160400 / 20260923010200 / 20261001020000)。
  v_s.merchant_id := p_merchant_id;
  v_s.points_feature_enabled := true;
  v_s.reward_condition_mode := 'none';
  v_s.referral_bonus_points := 0;
  v_s.birthday_bonus_points := 0;
  v_s.earn_mode := 'basic';
  v_s.basic_points_per_order := 0;
  v_s.basic_min_amount := 0;
  v_s.basic_tiered_enabled := false;
  v_s.redeem_points_unit := 0;
  v_s.redeem_amount_unit := 0;
  v_s.redeem_max_ratio_percent := 0;
  v_s.referral_inviter_reward_enabled := false;
  v_s.referral_subsequent_bonus_points := 0;
  v_s.referral_inviter_earning_enabled := true;
  v_s.referral_invitee_earning_enabled := true;
  v_s.birthday_bonus_enabled := false;
  return v_s;
end;
$$;

comment on function private.merchant_member_settings_effective(uuid) is '紅利系統重構 批次 2:讀 merchant_member_settings,查無列時回傳各欄位的 schema 預設值(紅利功能開啟、基本模式、每筆 0 點 = 尚未設定、不開放折抵)。只給 compute_booking_planned_points / preview_booking_points 內部呼叫。';

revoke execute on function private.merchant_member_settings_effective(uuid) from public, anon, authenticated;

-- =========================================================================
-- 1. §3.2 末段:private.resolve_booking_member_by_phone(依電話找會員,create_booking 與預覽共用)
-- =========================================================================
create or replace function private.resolve_booking_member_by_phone(p_merchant_id uuid, p_phone text)
returns table (match_count int, member_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  -- 【逐字搬自 public.create_booking 的 #912 區塊(正式庫指紋 b9da6db2…),連註解一起】
  -- 規格書 紅利系統重構 §3.2 末段 / §〇.4 判斷 16:建單(create_booking)與建單頁預覽
  -- (preview_booking_points)必須用**同一套**規則依電話找會員,所以把這一句抽成共用 helper。
  -- 差別只有一處:create_booking 是先把 private.normalize_phone(p_customer_phone) 算進區域變數
  -- 再比對;這裡在同一句裡算。normalize_phone 回 NULL 時(只填了 #分機之類)等式為 NULL ⇒
  -- count = 0、member_id = NULL,跟 create_booking「v_normalized_phone is null ⇒ 當 0 筆」同結果。
  --
  -- 只在**同一個 merchant_id**、**status = 'active'** 的範圍內比對(§2.1:會員是 per-merchant,
  -- 表註解明文寫「判斷 7:不做跨商家比對/合併」;資安清單 #16:硬性帶 merchant_id,
  -- 不只靠 RLS 一道防線)。
  -- 同號但 status = 'removed' 的紀錄**當成 0 筆**:那筆是商家刻意下架的,系統不該自作主張
  -- 把它重新啟用(#931 的唯一性約束同樣只管 active,兩邊一致)。
  --
  -- 🔴 這一句原本寫成 `select count(*), min(m.id)`,那是**執行期一定會炸**的錯誤:
  --    PostgreSQL 沒有 min(uuid) 這個聚合函式 ⇒ 42883 function min(uuid) does not exist
  --    ⇒ **每一次建單都失敗**。2026-09-30 主腦實跑本機全套時抓到(87 檔裡 27 檔紅),
  --    純靜態盤點看不出來 —— 這就是「migration 一定要實跑一次」的理由,留在這裡當紀錄。
  -- 改成 `(array_agg(m.id order by m.created_at, m.id))[1]`,三個理由:
  --   ① array_agg 對 uuid 合法,而且整段仍然是**一句**聚合查詢,永遠回剛好一列
  --      (查無資料時 count = 0、array_agg 為 NULL ⇒ [1] 也是 NULL),
  --      不會踩到「SELECT INTO 沒有列 ⇒ 變數被設成 NULL 而不是 0」那個陷阱。
  --   ② min(id) **就算存在也是錯的語意**:id 是 gen_random_uuid(),「最小的 uuid」跟
  --      「哪一位客戶」毫無關係,等於用亂數決定紅利要發給誰。
  --   ③ 「取**最早建立**的那一位」是這條需求**已經寫在文件上**的行為:#931 的已知代價逐字寫著
  --      「家人共用一支電話時,會員名單只會有最早建立的那一個名字,紅利點數也全部累積在那一筆上」。
  --      所以萬一舊資料真的有多筆,挑到誰是**可預期、而且跟文件一致**的。
  --      id 當第二排序鍵,讓 created_at 完全相同時結果仍然穩定(同樣的資料不會跑出不同答案)。
  -- 📌 #931 的唯一索引之後 active 同號最多只有 1 筆,所以這個挑選規則實際上只是保險;
  --    但保險也必須是可預期的,不能是亂數。
  select count(*)::int, (array_agg(m.id order by m.created_at, m.id))[1]
  from public.members m
  where m.merchant_id = p_merchant_id
    and m.status = 'active'
    and private.normalize_phone(m.phone) = private.normalize_phone(p_phone);
$$;

comment on function private.resolve_booking_member_by_phone(uuid, text) is '紅利系統重構 §3.2 末段(v2.3):依電話在同商家、status=active 的會員裡找人(private.normalize_phone 完全相等,不是前綴)。回傳 match_count 與最早建立那一位的 id。create_booking(#912,批次 3 起改呼叫它)與 preview_booking_points 共用,保證「預覽對到的會員 = 送出後連結的會員」。唯讀,只准內部呼叫。';

revoke execute on function private.resolve_booking_member_by_phone(uuid, text) from public, anon, authenticated;

-- =========================================================================
-- 2. §2.10 折抵換算與上限(純函式;預覽與批次 3 的 create_booking/update_booking 共用)
-- =========================================================================
create or replace function private.redeem_points_to_amount(
  p_points integer,
  p_points_unit integer,
  p_amount_unit numeric
)
returns numeric
language sql
immutable
set search_path = public
as $$
  -- 第 17 題定案:任意整數點數都收;金額 = floor(點數 × 金額單位 / 點數單位),無條件捨去到整數元。
  -- 例:100 點 = 10 元時,55 點 → 5 元。比例尚未設定(點數單位 <= 0)一律 0。
  select case
    when coalesce(p_points, 0) <= 0 or coalesce(p_points_unit, 0) <= 0 or coalesce(p_amount_unit, 0) <= 0 then 0::numeric
    else floor(p_points::numeric * p_amount_unit / p_points_unit)
  end;
$$;

comment on function private.redeem_points_to_amount(integer, integer, numeric) is '紅利系統重構 §2.10 第 3 點(第 17 題):點數換算成折抵金額,無條件捨去到整數元。預覽與建單/改單共用,不可另寫第二套算式。';

revoke execute on function private.redeem_points_to_amount(integer, integer, numeric) from public, anon, authenticated;

create or replace function private.compute_booking_redeem_limits(
  p_points_unit integer,
  p_amount_unit numeric,
  p_max_ratio_percent integer,
  p_payable_amount numeric,
  p_available_points integer
)
returns table (cap_amount numeric, max_amount numeric, max_points integer)
language plpgsql
immutable
set search_path = public
as $$
declare
  -- 全程用 numeric 算,最後才轉 integer:極小金額單位(1 點 = 0.01 元)× 極大點數單位時,
  -- 中間值可能超過 bigint(9.2e18),numeric 不會溢位。
  v_available numeric;
  v_by_amount numeric;
  v_p_star numeric;
  v_best_amount numeric;
  v_points numeric;
begin
  -- 比例上限(§2.10 第 2 點):cap_amount = floor(應付總額 × 比例 / 100),整數元。
  cap_amount := floor(greatest(coalesce(p_payable_amount, 0), 0) * greatest(coalesce(p_max_ratio_percent, 0), 0) / 100.0);
  max_amount := 0;
  max_points := 0;
  v_available := greatest(coalesce(p_available_points, 0), 0);

  if coalesce(p_points_unit, 0) <= 0 or coalesce(p_amount_unit, 0) <= 0
     or coalesce(p_max_ratio_percent, 0) <= 0 or cap_amount < 1
     or v_available <= 0 then
    return next;
    return;
  end if;

  -- ① 換算金額不超過 cap_amount 的最大點數:
  --    floor(p × A / P) <= M ⟺ p × A < (M + 1) × P ⟺ p <= ceil((M + 1) × P / A) − 1。
  v_by_amount := ceil((cap_amount + 1) * p_points_unit / p_amount_unit) - 1;
  -- numeric 除法有精度截斷,補一道保險:真的換算一次,超過就往下退。
  while v_by_amount > 0
    and floor(v_by_amount * p_amount_unit / p_points_unit) > cap_amount loop
    v_by_amount := v_by_amount - 1;
  end loop;

  -- ② p* = min(可用點數, ①);最大可折金額 A = p* 的換算金額。
  v_p_star := least(v_available, v_by_amount);
  v_best_amount := floor(v_p_star * p_amount_unit / p_points_unit);

  -- 換算後折不到 1 元 ⇒ 不能折抵(bookings_points_redeem_amount_consistent:
  -- 有折抵點數就必須有折抵金額)。
  if v_best_amount < 1 then
    return next;
    return;
  end if;

  if v_available < v_by_amount then
    -- ③a 餘額卡住(可用點數比金額上限允許的還少):照回可用點數(v2.4 裁決 9 的例子:
    --    餘額 55 點、100 點 = 10 元 ⇒ 55 點折 5 元,符合第 17 題原文)。
    v_points := v_available;
  else
    -- ③b 金額上限卡住:v2.4 裁決 9 —— 不含「換不到錢的零頭點數」,
    --    取能折到 A 元的最少點數 ceil(A × P / 金額單位)(例:上限 500 元 ⇒ 5000 點,不是 5009)。
    v_points := least(v_available, ceil(v_best_amount * p_points_unit / p_amount_unit));
    -- 保險:確認換算回去剛好是 A(numeric 精度截斷時微調)。
    while floor(v_points * p_amount_unit / p_points_unit) < v_best_amount and v_points < v_p_star loop
      v_points := v_points + 1;
    end loop;
  end if;

  max_points := v_points::integer;  -- <= 可用點數 <= int 最大值,不會溢位
  -- v2.4 裁決 10:max_amount = max_points 實際可折的金額。
  max_amount := private.redeem_points_to_amount(max_points, p_points_unit, p_amount_unit);
  return next;
end;
$$;

comment on function private.compute_booking_redeem_limits(integer, numeric, integer, numeric, integer) is '紅利系統重構 §2.10 + v2.4 主腦裁決 9/10:本單折抵上限。cap_amount = floor(應付 × 比例 / 100)(比例上限);max_points = 可用點數卡住時回可用點數,否則回「能折到最大金額的最少點數」(不含換不到錢的零頭點數);max_amount = redeem_points_to_amount(max_points)(實際可折金額)。換算後不到 1 元時 max_points = max_amount = 0。預覽與建單/改單共用。';

revoke execute on function private.compute_booking_redeem_limits(integer, numeric, integer, numeric, integer) from public, anon, authenticated;

-- =========================================================================
-- 3. §3.1 private.compute_booking_planned_points(核心計算引擎,單一真相)
-- =========================================================================
create or replace function private.compute_booking_planned_points(
  p_merchant_id uuid,
  p_member_id uuid,
  p_service_items jsonb,
  p_payable_amount numeric,
  p_custom_total_amount_enabled boolean,
  p_discount_enabled boolean,
  p_assume_new_member boolean default false
)
returns table (
  auto_points integer,
  review_required boolean,
  eligible boolean,
  ineligible_reason text,
  breakdown jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.merchant_member_settings;
  v_has_member boolean := false;
  v_phone_verified boolean;
  v_line_bound boolean;
  v_is_invitee boolean;
  v_is_inviter boolean;
  v_base numeric;
  v_multiplier numeric;
  v_total bigint := 0;
  v_elem jsonb;
  v_item_id uuid;
  v_qty int;
  v_unit_price numeric;
  v_item_name text;
  v_formula public.merchant_point_formulas;
  v_item_points bigint;
  v_items jsonb := '[]'::jsonb;
begin
  -- 第 5 步先算:「需人工確認」只跟訂單本身有沒有自訂總金額/折扣有關(§2.5 第 1 點),
  -- 不論後面因為什麼原因 auto = 0 都照實回報。
  review_required := coalesce(p_custom_total_amount_enabled, false) or coalesce(p_discount_enabled, false);
  auto_points := 0;
  eligible := false;
  ineligible_reason := null;
  breakdown := '[]'::jsonb;

  -- 1. 功能總開關(既有裁決「關閉時代表不存在」)。
  v_s := private.merchant_member_settings_effective(p_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    ineligible_reason := 'feature_disabled';
    return next;
    return;
  end if;

  -- 2./3. 決定會員屬性。
  if p_member_id is not null then
    -- 硬性帶 merchant_id(資安清單 #16):別家商家的會員 id 一律當成「沒有會員」。
    -- 不過濾 status:create_booking 已先確認 active;update_booking(批次 3)對已下架會員的處理
    -- 由批次 3 明訂(v2.4 裁決 5 ③),引擎只負責「給定會員就照規則算」。
    select m.phone_verified,
           m.line_bound,
           m.referred_by_member_id is not null,
           exists (select 1 from public.members r where r.referred_by_member_id = m.id)
    into v_phone_verified, v_line_bound, v_is_invitee, v_is_inviter
    from public.members m
    where m.id = p_member_id
      and m.merchant_id = p_merchant_id;
    v_has_member := found;
  elsif coalesce(p_assume_new_member, false) then
    -- §3.1 v2.3:只給預覽用。電話在這間店還沒有會員(送出後才會自動建立)⇒ 用「全新會員」的屬性:
    -- 尚未驗證、沒綁 LINE、沒有推薦人、沒推薦過人。**不會為了預覽真的去建會員。**
    v_phone_verified := false;
    v_line_bound := false;
    v_is_invitee := false;
    v_is_inviter := false;
    v_has_member := true;
  end if;

  if not v_has_member then
    ineligible_reason := 'no_member';  -- 訪客單不派點
    return next;
    return;
  end if;

  -- §2.7:核發資格在建單當下判斷(完成時不再重查)。
  if not private.member_meets_reward_condition(v_s.reward_condition_mode, v_phone_verified, v_line_bound) then
    ineligible_reason := 'reward_condition';
    return next;
    return;
  end if;

  -- §2.6 開關 2/3 + 第 14 題:同時是推薦者又是被推薦者時,任一開關關閉就不累積。
  if v_is_inviter and not coalesce(v_s.referral_inviter_earning_enabled, true) then
    ineligible_reason := 'inviter_earning_disabled';
    return next;
    return;
  end if;
  if v_is_invitee and not coalesce(v_s.referral_invitee_earning_enabled, true) then
    ineligible_reason := 'invitee_earning_disabled';
    return next;
    return;
  end if;

  eligible := true;

  -- 4. 依計算模式算點(§2.1:兩種模式互斥,進階模式沒公式的項目就是 0,絕不退回基本模式補算)。
  if coalesce(v_s.earn_mode, 'basic') = 'advanced' then
    -- §2.3 逐項計算。以呼叫端送進來的 unit_price / quantity 為準(建單/編輯當下的實際單價)。
    if p_service_items is not null and jsonb_typeof(p_service_items) = 'array' then
      for v_elem in select value from jsonb_array_elements(p_service_items) loop
        v_item_id := (v_elem ->> 'service_item_id')::uuid;
        v_qty := coalesce((v_elem ->> 'quantity')::int, 0);
        v_unit_price := coalesce((v_elem ->> 'unit_price')::numeric, 0);
        v_item_points := 0;
        v_formula := null;

        -- 只認這間商家的服務項目(不論上架與否:下架項目在舊單編輯時仍照公式算,§2.3 測試)。
        -- 別家商家的項目 id(正常路徑在 validate_booking_selection 就會被擋)不會吃到任何公式,
        -- 連「全部服務項目」那條都不會,也不回傳名稱。
        select si.name into v_item_name
        from public.service_items si
        where si.id = v_item_id
          and si.merchant_id = p_merchant_id;

        if found then
          -- 第 2 題定案 B:個別公式優先;沒有(或被停用)才吃「全部服務項目」那條;絕不相加。
          select f.* into v_formula
          from public.merchant_point_formulas f
          where f.merchant_id = p_merchant_id
            and f.enabled
            and f.service_item_id = v_item_id
          order by f.sort_order, f.id
          limit 1;

          if not found then
            select f.* into v_formula
            from public.merchant_point_formulas f
            where f.merchant_id = p_merchant_id
              and f.enabled
              and f.service_item_id is null
            order by f.sort_order, f.id
            limit 1;
          end if;

          -- 門檻「大於等於」、比的是建單當下實際單價(不是 service_items.price 現價)。
          if v_formula.id is not null and v_unit_price >= v_formula.min_unit_price and v_qty > 0 then
            v_item_points := v_formula.points_per_unit::bigint * v_qty;
          end if;
        else
          v_item_name := null;
        end if;

        v_total := v_total + v_item_points;
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'mode', 'advanced',
          'service_item_id', v_item_id,
          'name', v_item_name,
          'unit_price', v_unit_price,
          'quantity', v_qty,
          'formula_id', v_formula.id,
          'formula_name', v_formula.name,
          'threshold', v_formula.min_unit_price,
          'points_per_unit', v_formula.points_per_unit,
          'points', v_item_points
        ));
      end loop;
    end if;
    breakdown := v_items;
  else
    -- §2.2 基本模式。base = 折扣後、含稅、紅利折抵前的應付總額(第 5 題)。
    v_base := greatest(coalesce(p_payable_amount, 0), 0);
    if coalesce(v_s.basic_points_per_order, 0) <= 0 then
      v_multiplier := 0;  -- 0 = 尚未設定,不派點
    elsif coalesce(v_s.basic_tiered_enabled, false) then
      -- 每滿額累計:floor(base / 門檻) × 每次點數(門檻 > 0 由表級 CHECK 保證;這裡再防一次除以零)。
      v_multiplier := case when coalesce(v_s.basic_min_amount, 0) > 0
                           then floor(v_base / v_s.basic_min_amount) else 0 end;
    else
      -- 單筆達門檻只贈一次;門檻 0 = 每筆都給。
      v_multiplier := case when v_base >= coalesce(v_s.basic_min_amount, 0) then 1 else 0 end;
    end if;
    v_total := (v_multiplier * coalesce(v_s.basic_points_per_order, 0))::bigint;
    breakdown := jsonb_build_array(jsonb_build_object(
      'mode', 'basic',
      'base', v_base,
      'min_amount', v_s.basic_min_amount,
      'tiered', v_s.basic_tiered_enabled,
      'points_per_order', v_s.basic_points_per_order,
      'multiplier', v_multiplier,
      'points', v_total
    ));
  end if;

  auto_points := v_total::int;
  return next;
end;
$$;

comment on function private.compute_booking_planned_points(uuid, uuid, jsonb, numeric, boolean, boolean, boolean) is '紅利系統重構 §3.1:派點的唯一計算引擎(單一真相)。依商家 earn_mode 走基本(§2.2)或進階(§2.3)公式;先判斷功能開關、會員有無、核發資格(§2.7,建單當下)、推薦開關 2/3(§2.6、第 14 題)。p_assume_new_member 只給 preview_booking_points 用(電話在店裡還沒有會員時,以「全新會員」屬性試算,不建會員)。preview_booking_points 與 create_booking/update_booking(批次 3)一律呼叫這一支,不可另寫公式。只准內部呼叫。';

revoke execute on function private.compute_booking_planned_points(uuid, uuid, jsonb, numeric, boolean, boolean, boolean) from public, anon, authenticated;

-- =========================================================================
-- 4. §3.2 public.preview_booking_points(建單頁即時預覽 RPC,唯讀)
-- =========================================================================
create or replace function public.preview_booking_points(
  p_merchant_id uuid,
  p_booking_id uuid,
  p_member_id uuid,
  p_customer_phone text,
  p_service_items jsonb,
  p_custom_total_amount_enabled boolean,
  p_custom_total_amount numeric,
  p_discount_enabled boolean,
  p_discount_mode text,
  p_discount_value numeric,
  p_tax_enabled boolean,
  p_tax_mode text,
  p_tax_value numeric
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.merchant_member_settings;
  v_booking_member_id uuid;
  v_booking_merchant_id uuid;
  v_resolution text;
  v_member_id uuid;
  v_member_name text;
  v_balance integer;
  v_match_count int;
  v_matched_id uuid;
  v_elem jsonb;
  v_subtotal numeric := 0;
  v_qty int;
  v_unit_price numeric;
  v_item_count int;
  v_found_count int;
  v_amount record;
  v_points record;
  v_rules_configured boolean;
  v_available integer := 0;
  v_frozen integer := 0;
  v_redeem_enabled boolean;
  -- 用純量變數而不是 record:record 沒被賦值時,就算 CASE 走不到那一支,
  -- 引用 v_limits.max_points 也會報「record is not assigned yet」(故障注入時抓到)。
  v_max_points integer := 0;
  v_max_amount numeric := 0;
  v_cap_amount numeric := 0;
begin
  -- 1. 權限:跟建單同一把鑰匙(orders)。p_merchant_id 只拿來「問呼叫者對這間店有沒有權限」,
  --    之後每一筆查詢都硬性帶 merchant_id,不信任呼叫端給的任何其他 id。
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查看這間商家的紅利點數預覽' using errcode = '42501';
  end if;

  -- 編輯模式:訂單必須屬於這間商家。「不存在」跟「別家的」回同一個錯誤,不洩漏存不存在。
  if p_booking_id is not null then
    select b.merchant_id, b.member_id into v_booking_merchant_id, v_booking_member_id
    from public.bookings b
    where b.id = p_booking_id;

    if not found or v_booking_merchant_id is distinct from p_merchant_id then
      raise exception '找不到這筆預約,或沒有權限查看' using errcode = '42501';
    end if;
  end if;

  -- 2. 功能關閉 ⇒ 只回一個鍵,不洩漏任何設定或會員資訊。
  v_s := private.merchant_member_settings_effective(p_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    return jsonb_build_object('feature_enabled', false);
  end if;

  -- 3. 決定會員(member.resolution)。
  if p_member_id is not null then
    select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
    from public.members m
    where m.id = p_member_id
      and m.merchant_id = p_merchant_id
      and m.status = 'active';
    if found then
      v_resolution := 'given';
    else
      -- 別家的、已下架的、亂填的 ⇒ 當成沒有會員,不報錯、不洩漏存不存在(#917 IDOR 要求)。
      v_resolution := 'none';
      v_member_id := null;
      v_member_name := null;
      v_balance := null;
    end if;
  elsif p_booking_id is null then
    -- 新增模式:由伺服器依電話找會員,跟 create_booking 用同一支 helper。
    if not private.is_valid_taiwan_phone(p_customer_phone) then
      v_resolution := 'phone_incomplete';
    else
      select r.match_count, r.member_id into v_match_count, v_matched_id
      from private.resolve_booking_member_by_phone(p_merchant_id, p_customer_phone) r;

      if v_match_count = 1 then
        select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
        from public.members m
        where m.id = v_matched_id
          and m.merchant_id = p_merchant_id;
        v_resolution := 'existing';
      elsif v_match_count = 0 then
        v_resolution := 'new';
      else
        v_resolution := 'ambiguous';  -- #931 之後不會發生;當成沒有會員
      end if;
    end if;
  else
    -- 編輯模式且沒給會員 ⇒ 舊的訪客單、沒有補掛(編輯模式後端不依電話比對,§12.7)。
    v_resolution := 'none';
  end if;

  v_rules_configured := case
    when coalesce(v_s.earn_mode, 'basic') = 'advanced' then
      exists (select 1 from public.merchant_point_formulas f where f.merchant_id = p_merchant_id and f.enabled)
    else coalesce(v_s.basic_points_per_order, 0) > 0
  end;

  -- 4./5. 算應付金額 + 呼叫引擎。客服還在填表時(沒選服務項目、格式不對、折扣超過小計…)
  --       回 {"feature_enabled": true, "error": "…"},不要讓前端一直噴 500。
  begin
    if p_service_items is null or jsonb_typeof(p_service_items) <> 'array'
       or jsonb_array_length(p_service_items) = 0 then
      raise exception '請至少選擇一個服務項目';
    end if;

    v_item_count := jsonb_array_length(p_service_items);
    for v_elem in select value from jsonb_array_elements(p_service_items) loop
      if v_elem ->> 'service_item_id' is null then
        raise exception '每個服務項目都必須指定 service_item_id';
      end if;
      v_qty := (v_elem ->> 'quantity')::int;
      if v_qty is null or v_qty < 1 then
        raise exception '服務項目數量必須至少為 1';
      end if;
      v_unit_price := (v_elem ->> 'unit_price')::numeric;
      if v_unit_price is null or v_unit_price < 0 then
        raise exception '請提供每個服務項目的單價,且不能是負數';
      end if;
      -- 跟 validate_booking_selection 的 items_subtotal 同一個算式。
      v_subtotal := v_subtotal + (v_unit_price * v_qty);
    end loop;

    -- 服務項目必須屬於這間商家(不限上架:編輯舊單時可能含已下架項目)。
    select count(*) into v_found_count
    from jsonb_array_elements(p_service_items) as elem
    join public.service_items si
      on si.id = (elem ->> 'service_item_id')::uuid
     and si.merchant_id = p_merchant_id;
    if v_found_count <> v_item_count then
      raise exception '找不到其中一個服務項目';
    end if;

    select * into v_amount from private.calculate_booking_amount(
      v_subtotal,
      p_custom_total_amount_enabled, p_custom_total_amount,
      p_discount_enabled, p_discount_mode, p_discount_value,
      p_tax_enabled, p_tax_mode, p_tax_value
    );

    select * into v_points from private.compute_booking_planned_points(
      p_merchant_id,
      case when v_resolution in ('given', 'existing') then v_member_id else null end,
      p_service_items,
      v_amount.final_amount,
      p_custom_total_amount_enabled,
      p_discount_enabled,
      v_resolution = 'new'
    );
  exception
    when others then
      return jsonb_build_object('feature_enabled', true, 'error', sqlerrm);
  end;

  -- 6. 折抵上限(§2.10)。只有 existing / given 開放('new' 餘額一定是 0)。
  if v_resolution in ('given', 'existing') then
    v_available := coalesce(v_balance, 0);
    -- §〇.4 判斷 22:編輯同一張單、會員也是這張單的會員時,加回本單目前有效凍結
    -- (= −Σ redeem_booking/redeem_booking_refund 的 points_delta,§1.5 淨額定義)。
    if p_booking_id is not null and v_booking_member_id = v_member_id then
      select coalesce(-sum(t.points_delta), 0)::int into v_frozen
      from public.member_point_transactions t
      where t.booking_id = p_booking_id
        and t.member_id = v_member_id
        and t.transaction_type in ('redeem_booking', 'redeem_booking_refund');
      v_available := v_available + greatest(v_frozen, 0);
    end if;
  end if;

  v_redeem_enabled := v_resolution in ('given', 'existing')
    and coalesce(v_s.redeem_points_unit, 0) > 0
    and coalesce(v_s.redeem_amount_unit, 0) > 0
    and coalesce(v_s.redeem_max_ratio_percent, 0) > 0;

  if v_redeem_enabled then
    select l.max_points, l.max_amount, l.cap_amount into v_max_points, v_max_amount, v_cap_amount
    from private.compute_booking_redeem_limits(
      v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
      v_amount.final_amount, v_available
    ) l;
  end if;

  -- 7. 回傳。member_id / name / balance 只在 existing / given 時有值。
  return jsonb_build_object(
    'feature_enabled', true,
    'member', jsonb_build_object(
      'resolution', v_resolution,
      'member_id', case when v_resolution in ('existing', 'given') then v_member_id end,
      'name', case when v_resolution in ('existing', 'given') then v_member_name end,
      'balance', case when v_resolution in ('existing', 'given') then v_balance end
    ),
    'rules_configured', v_rules_configured,
    'earn_mode', coalesce(v_s.earn_mode, 'basic'),
    'auto_points', v_points.auto_points,
    'review_required', v_points.review_required,
    'eligible', v_points.eligible,
    'ineligible_reason', v_points.ineligible_reason,
    'breakdown', v_points.breakdown,
    'redeem', jsonb_build_object(
      'enabled', v_redeem_enabled,
      'points_unit', case when v_redeem_enabled then v_s.redeem_points_unit end,
      'amount_unit', case when v_redeem_enabled then v_s.redeem_amount_unit end,
      'max_ratio_percent', case when v_redeem_enabled then v_s.redeem_max_ratio_percent end,
      'payable', v_amount.final_amount,
      'available_points', v_available,
      'max_points', v_max_points,
      -- v2.4 裁決 10:max_amount = max_points 實際可折金額(畫面「最多可折 NT$X」直接用它);
      -- 比例上限另給 cap_amount。
      'max_amount', v_max_amount,
      'cap_amount', v_cap_amount
    )
  );
end;
$$;

comment on function public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) is '紅利系統重構 §3.2(v2.3,#842;取代 #917):建單/改單頁的紅利即時預覽,唯讀。權限 = orders 鑰匙(can_manage_bookings);別家商家的 p_booking_id ⇒ 42501;別家/下架/亂填的 p_member_id ⇒ 當成沒有會員(不洩漏存不存在)。新增模式依電話找會員(resolve_booking_member_by_phone,與 create_booking 同一支);找不到 ⇒ resolution=new,以全新會員屬性試算派點、不開放折抵。功能關閉只回 {"feature_enabled": false}。派點一律由 compute_booking_planned_points 計算(與建單同一支引擎),折抵上限由 compute_booking_redeem_limits 計算。不放寬 merchant_member_settings 的 SELECT 政策。';

revoke execute on function public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) from public, anon;
grant execute on function public.preview_booking_points(uuid, uuid, uuid, text, jsonb, boolean, numeric, boolean, text, numeric, boolean, text, numeric) to authenticated;
