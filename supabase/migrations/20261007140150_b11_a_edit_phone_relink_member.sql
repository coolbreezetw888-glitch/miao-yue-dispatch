-- =====================================================================
-- SPECS-INDEX #939 / #988(第 11 批 A,使用者裁決 ③):已連結會員的訂單改電話 ⇒ 自動改掛會員 + 紅利重算
-- 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §一
--
-- 背景:update_booking 本來就允許換會員(p_member_id 無條件覆寫,換會員時先退舊會員折抵、再對新會員
-- 重新扣、派點依新會員重算),問題在「改了電話」這件事沒有人去決定新會員 —— 前端一律送回原會員 id,
-- 服務人員端 staff_update_booking 也強制帶原會員 ⇒ 會出現「王小明的會員、李小華的電話」。
-- 這支 migration 讓**後端**依新電話決定會員(跟建單同一支 resolve_booking_member_by_phone):
--   ① 新增 private.resolve_edit_booking_member:判斷「這張單有沒有會員、電話有沒有真的改」並依新電話找會員。
--      商家一律取自訂單本身,不接受呼叫端傳商家(防跨商家)。不開放給前端(revoke)。
--   ② public.update_booking(簽章不變):改電話時忽略 p_member_id,改用依電話算出的會員(0 位 ⇒
--      create_member 自動建立);之後所有原本用 p_member_id 的地方改用 v_effective_member_id;
--      v2.4 裁決 22 ① 那道檢查同步改比對 v_effective_member_id。
--   ③ public.preview_booking_points(簽章不變):編輯模式先問同一支 helper,保證「預覽對到誰 = 送出後掛誰」。
--   ④ public.staff_update_booking:函式本體不改,只更新註解(改電話時同樣自動改掛)。
-- 不新增分類帳交易類型、不新增 RLS policy、不放寬任何 CHECK、不寫任何業務資料。
-- 兩支既有函式以正式庫改前指紋為底稿(md5(replace(prosrc,E'\r\n',E'\n'))):
--   update_booking c65d88d427a78859609af12c2e56b917、preview_booking_points 84f354af32cf4b665db73f6619332931。
-- 編號 140150:排在 B(140100,退回備註全形)之後、D(140200)之前。
-- =====================================================================

-- ---------------------------------------------------------------------
-- ① 新 helper
-- ---------------------------------------------------------------------
create or replace function private.resolve_edit_booking_member(p_booking_id uuid, p_customer_phone text)
returns table(phone_changed boolean, match_count int, member_id uuid)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_member_id uuid;
  v_old_phone text;
begin
  -- 商家、會員、原電話一律讀訂單本身(不信任呼叫端給的商家)。
  select b.merchant_id, b.member_id, b.customer_phone
  into v_merchant_id, v_member_id, v_old_phone
  from public.bookings b
  where b.id = p_booking_id;

  -- 找不到單、或單沒有會員(A-5:沒連結會員的舊單改電話不會自動連結,補掛仍要客服點選)⇒ 不觸發。
  if not found or v_member_id is null then
    return query select false, 0, null::uuid;
    return;
  end if;

  -- A-1:只改格式(0912-345-678 ↔ 0912345678)不算改電話。
  if private.normalize_phone(p_customer_phone) is not distinct from private.normalize_phone(v_old_phone) then
    return query select false, 0, null::uuid;
    return;
  end if;

  -- A-2:跟建單完全同一套(同商家、active、normalize_phone 完全相等)。
  return query
  select true, r.match_count, r.member_id
  from private.resolve_booking_member_by_phone(v_merchant_id, p_customer_phone) r;
end;
$function$;

revoke execute on function private.resolve_edit_booking_member(uuid, text) from public, anon, authenticated, service_role;

comment on function private.resolve_edit_booking_member(uuid, text) is
  'SPECS-INDEX #939(第 11 批 A):編輯訂單時判斷「這張單原本有會員、而且電話正規化後真的改了」,並依新電話找會員(呼叫 resolve_booking_member_by_phone,同商家、active、normalize_phone 完全相等)。回傳 (phone_changed, match_count, member_id);沒會員 / 只改格式 ⇒ phone_changed = false。商家取自訂單本身,不接受呼叫端傳商家。只給 update_booking 與 preview_booking_points 內部呼叫。';

-- ---------------------------------------------------------------------
-- ② public.update_booking
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_assistant_staff_ids uuid[] DEFAULT '{}'::uuid[], p_material_cost_item_ids uuid[] DEFAULT '{}'::uuid[], p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_member_id uuid DEFAULT NULL::uuid, p_hide_notes_from_staff boolean DEFAULT false, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT NULL::integer, p_points_override_reset boolean DEFAULT false, p_points_redeem_member_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_industry_type text;
  v_sel record;
  v_amount record;
  v_result public.bookings;
  v_member_name text;
  -- 2026-09-24 修正(B2):這筆預約「既有」的料錢快照對照表,形狀是
  -- {"<material_cost_item_id>": <amount_snapshot>, ...}。在整批刪除關聯表之前先收起來,
  -- 重寫時讓舊品項沿用原本的快照值,只有這次新加的品項才去讀品項目前的金額。
  v_existing_material_snapshots jsonb;
  -- 紅利系統重構 §3.4(批次 3)新增。
  v_old_member_id uuid;
  v_old_planned integer;
  v_old_overridden boolean;
  v_old_redeemed integer;
  v_old_redeem_amount numeric;
  v_old_final_amount numeric;
  v_member_status text;
  v_member_changed boolean;
  v_s public.merchant_member_settings;
  v_points record;
  v_planned integer;
  v_overridden boolean;
  v_target_redeemed integer;
  v_redeem_changed boolean;
  v_new_redeem_amount numeric;
  v_member_balance integer;
  v_frozen integer;
  v_cap numeric;
  v_max_points integer;
  -- SPECS-INDEX #939(第 11 批 A):改了電話 ⇒ 依新電話決定這張單的會員。
  v_effective_member_id uuid;
  v_phone_changed boolean;
  v_match_count int;
  v_matched_member_id uuid;
  v_new_member public.members;
begin
  -- 紅利系統重構 批次 3:這一句加上 for update(原本沒有)。改單會動到點數分類帳,
  -- 同一張單的「改單 / 取消 / 退回折抵」必須排隊,鎖的順序一律「訂單 → 會員」
  -- (cancel_booking、private.refund_booking_redeem 同樣先鎖訂單),不會互相死鎖。
  select merchant_id, status, member_id, points_planned, points_planned_overridden,
         points_redeemed, points_redeem_amount_snapshot, final_amount_snapshot
  into v_merchant_id, v_status, v_old_member_id, v_old_planned, v_old_overridden,
       v_old_redeemed, v_old_redeem_amount, v_old_final_amount
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能編輯，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;
  -- SPECS-INDEX #822(2026-09-27):客戶電話格式驗證(手機或市話,市話可帶 # 分機,分隔符號不強制)。
  -- 規則本體在 private.is_valid_taiwan_phone,跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應。
  -- 這裡是「後端函式」那一層;資料庫 CHECK 約束因舊髒資料還沒清(#638)暫時補不上,見本 migration 開頭說明。
  if not private.is_valid_taiwan_phone(p_customer_phone) then
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)';
  end if;

  -- 紅利系統重構 §3.4 第 2 步:兩個派點參數互相矛盾 ⇒ 擋下,不默默選一邊。
  if coalesce(p_points_override_reset, false) and p_points_override is not null then
    raise exception '不能同時清除人工設定又指定新的點數';
  end if;
  if p_points_override is not null then
    if p_points_override < 0 then
      raise exception '派點數不能是負數';
    end if;
    if p_points_override > 100000 then
      raise exception '單筆訂單最多只能設定 100,000 點，請確認是否多打了零';
    end if;
  end if;
  -- =====================================================================
  -- SPECS-INDEX #939(第 11 批 A,使用者裁決 ③):已連結會員的單改了電話 ⇒ 依新電話改掛會員。
  --   觸發條件(A-1):這張單原本有會員,而且 normalize_phone(新電話) 不等於 normalize_phone(原電話)
  --   (只改格式 0912-345-678 ↔ 0912345678 不算)。判斷寫在 private.resolve_edit_booking_member,
  --   preview_booking_points 呼叫的是**同一支**,保證「預覽對到誰 = 送出後掛誰」。
  --   觸發時(A-2 / A-4):前端照舊送原會員 id,這裡**忽略 p_member_id**,改用依電話算出的結果:
  --     1 位 ⇒ 改掛到他(不改他任何欄位,A-7);0 位 ⇒ 用 create_member 自動建立(跟 create_booking
  --     同一套:姓名 = 表單姓名、電話 = 新電話、email 有填就帶);≥ 2 位(舊資料安全網)⇒ 擋下。
  --   沒觸發 ⇒ v_effective_member_id = p_member_id,語意與改版前逐字相同(含補掛、解除會員)。
  --   之後所有原本用 p_member_id 的地方一律改用 v_effective_member_id ⇒ 既有的「會員變了就先退舊
  --   會員折抵、再對新會員重新扣、派點依新會員重算」規則自動套用(不另寫一套紅利重算)。
  --   新建的會員在這個交易裡,後面任何一步 raise 都會連同新會員一起回滾(§1.8 原子性)。
  -- =====================================================================
  select r.phone_changed, r.match_count, r.member_id
  into v_phone_changed, v_match_count, v_matched_member_id
  from private.resolve_edit_booking_member(p_booking_id, p_customer_phone) r;

  if coalesce(v_phone_changed, false) then
    if v_match_count = 1 then
      v_effective_member_id := v_matched_member_id;
    elsif v_match_count = 0 then
      v_new_member := public.create_member(
        v_merchant_id,
        btrim(p_customer_name),
        btrim(p_customer_phone),
        nullif(btrim(coalesce(p_customer_email, '')), ''),
        null, null, null, null
      );
      v_effective_member_id := v_new_member.id;
    else
      raise exception '這支電話底下有 % 位客戶，請先在建單畫面選擇這筆訂單是哪一位', v_match_count;
    end if;
  else
    v_effective_member_id := p_member_id;
  end if;

  -- v2.4 裁決 22 ①:明確要折抵(> 0)時,畫面確認的會員必須就是這次送出的會員。
  -- (沒有會員的情況交給後面 validate_booking_redeem 回「這筆訂單沒有連結會員」那句更清楚的話。)
  -- #939:比對對象改成 v_effective_member_id(改電話時 = 依新電話算出的會員),
  --   否則前端照預覽對新會員折抵會被誤擋;前端若還帶原會員 ⇒ 擋下,請客服重新確認。
  if coalesce(p_points_redeemed, 0) > 0 and v_effective_member_id is not null
     and p_points_redeem_member_id is distinct from v_effective_member_id then
    raise exception '客戶已變更，紅利折抵已重設，請重新確認後送出';
  end if;
  if p_points_redeemed is not null and p_points_redeemed < 0 then
    raise exception '折抵點數不能是負數';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = v_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 模組 10(會員與紅利)§3.6:驗證邏輯跟 create_booking 相同。update_booking 本身既有邏輯
  -- (上面的狀態檢查)已經只允許 pending_confirmation/accepted 呼叫這支函式,訂單一旦
  -- completed,member_id 自然永久鎖定,不需要額外的狀態檢查(判斷 9)。
  --
  -- 🔴 紅利系統重構 批次 3(v2.4 裁決 5 ③)「已下架會員的舊單」改單規則:
  --   ・p_member_id = 這張單**原本**的會員,而那位會員已下架(status = 'removed')⇒ **放行**,
  --     維持連結(姓名快照照樣取會員資料表的姓名)。改版前這種單只要一編輯就被
  --     「已被下架」擋下,前端又一律把原會員帶回來,等於這張單永遠改不動;而且「下架」在這套系統的
  --     定義是「不再出現在名單上」,不是「帳戶結清」(§3.11.2 第 7 步),不該因此卡死訂單。
  --     這種單:原本的折抵可以維持、**調低**(退差額給他,v2.4 裁決 15;調低後照常完整驗證,
  --     換算仍須 >= 1 元)或改成 0(= 全部退回,退回一律不看狀態);**不可增加**(下方 validate 前擋);
  --     派點照規則重算。
  --   ・p_member_id 是**另一位**已下架會員(想改掛到已下架會員)⇒ 跟以前一樣擋下。
  --   ・p_member_id 為 null(呼叫端清空、或根本沒帶這個參數)⇒ 視為「解除會員」,原本有折抵就先整筆退回
  --     (下方「會員變更」處理),不會留下「有折抵、沒會員」的訂單(v2.4 裁決 4/5 ①)。
  --   #939:以上三點講的「p_member_id」從這裡開始一律指 v_effective_member_id
  --   (沒改電話時兩者相同;改了電話時是依新電話算出的會員,只可能是 active)。
  v_member_changed := v_effective_member_id is distinct from v_old_member_id;

  if v_effective_member_id is not null then
    select name, status into v_member_name, v_member_status
    from public.members
    where id = v_effective_member_id
      and merchant_id = v_merchant_id;

    if not found or (v_member_status <> 'active' and v_member_changed) then
      raise exception '找不到指定的會員，或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
  );

  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  -- =====================================================================
  -- 紅利系統重構 §3.4 第 2 步:重算系統建議值,決定 planned(第 6 題定案)。
  -- =====================================================================
  v_s := private.merchant_member_settings_effective(v_merchant_id);

  select * into v_points from private.compute_booking_planned_points(
    v_merchant_id,
    v_effective_member_id,
    p_service_items,
    v_amount.final_amount,
    p_custom_total_amount_enabled,
    p_discount_enabled,
    false
  );

  if p_points_override is not null then
    if not coalesce(v_s.points_feature_enabled, true) then
      raise exception '紅利點數功能已關閉，無法設定派點';
    end if;
    v_planned := p_points_override;
    v_overridden := true;
  elsif coalesce(p_points_override_reset, false) then
    -- 客服按了「改用建議值」。
    v_planned := v_points.auto_points;
    v_overridden := false;
  elsif not coalesce(v_old_overridden, false) then
    -- 沒有人工設定 ⇒ 自動跟著金額/會員走(裁決 11)。
    v_planned := v_points.auto_points;
    v_overridden := false;
  else
    -- 已人工設定 ⇒ 保留客服的數字,只更新建議值(前端拿新舊比對後提示 +「改用建議值」鈕)。
    v_planned := v_old_planned;
    v_overridden := true;
  end if;

  -- =====================================================================
  -- 紅利系統重構 §3.4 第 3/4/4-1 步:折抵差異處理。
  --   目標折抵點數:
  --     p_points_redeemed 有值 ⇒ 就是它;
  --     p_points_redeemed 為 null(= 維持)且會員沒變 ⇒ 維持原本的點數;
  --     p_points_redeemed 為 null 但會員變了(含變空)⇒ 0 —— 原折抵扣的是**舊會員**的點數,
  --       不可以默默變成「用新會員的點數折抵」,也不可以留著「有折抵、沒會員」(v2.4 裁決 4/5)。
  --   有變動(會員變了,或點數變了)⇒ 先把舊的整筆退回給當初被扣的會員,再依新值對新會員重新扣。
  -- =====================================================================
  v_target_redeemed := case
    when p_points_redeemed is not null then p_points_redeemed
    when v_member_changed then 0
    else v_old_redeemed
  end;
  v_redeem_changed := v_member_changed or v_target_redeemed <> v_old_redeemed;
  v_new_redeem_amount := v_old_redeem_amount;

  if v_redeem_changed then
    -- 先鎖相關會員列(舊、新兩位,依 id 排序鎖,避免兩張單互換會員時 A→B / B→A 交叉死鎖),
    -- 再退舊、再讀新會員餘額 —— 退完才驗,同一位會員「改折抵點數」時可用點數自然含本單原凍結。
    perform 1
    from public.members
    where id in (v_old_member_id, v_effective_member_id)
    order by id
    for update;

    perform private.refund_booking_redeem(p_booking_id);
    v_new_redeem_amount := 0;

    if v_target_redeemed > 0 then
      -- v2.4 裁決 15:已下架會員(只可能是這張單原本的會員,改掛別位下架會員在上面就擋了)
      -- 只能維持或調低,不可增加;調低 = 退差額給他,下面照常完整驗證(換算仍須 >= 1 元)。
      if v_effective_member_id is not null and v_member_status <> 'active' and v_target_redeemed > v_old_redeemed then
        raise exception '這位會員已下架，不能增加紅利折抵(可以調低或改成 0，把點數退回給會員)';
      end if;

      if v_effective_member_id is not null then
        select points_balance into v_member_balance
        from public.members
        where id = v_effective_member_id;
      end if;

      v_new_redeem_amount := private.validate_booking_redeem(
        v_merchant_id, v_effective_member_id, v_target_redeemed, v_amount.final_amount, v_member_balance
      );
    end if;
  elsif v_old_redeemed > 0 and v_effective_member_id is not null
        and v_amount.final_amount is distinct from v_old_final_amount
        and coalesce(v_s.points_feature_enabled, true)
        and coalesce(v_s.redeem_points_unit, 0) > 0
        and coalesce(v_s.redeem_amount_unit, 0) > 0
        and coalesce(v_s.redeem_max_ratio_percent, 0) > 0 then
    -- §3.4 第 4-1 步 / §〇.4 判斷 21(v2.4 裁決 14 改寫):折抵點數與會員都沒變時,
    -- **只有應付金額跟原本的 final_amount_snapshot 不同才重驗上限**。只改時間/服務人員/備註等
    -- 不重驗 —— 商家事後調低比例,不影響已經談定的舊單(原則同派點快照)。
    -- 原折抵金額超過新上限 ⇒ 擋下,請客服自己決定調降多少(不自動幫客人改點數)。
    -- 商家事後把紅利功能或點數折抵關掉(比例設 0)的舊單不在此列:那時已經沒有「上限」這個設定,
    -- 已折抵的維持原狀(取消時照樣退回),否則每一張有折抵的舊單都會變成改不動。
    select points_balance into v_member_balance
    from public.members
    where id = v_effective_member_id;

    select coalesce(-sum(t.points_delta), 0)::int into v_frozen
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.member_id = v_effective_member_id
      and t.transaction_type in ('redeem_booking', 'redeem_booking_refund');

    select l.cap_amount, l.max_points into v_cap, v_max_points
    from private.compute_booking_redeem_limits(
      v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
      v_amount.final_amount, coalesce(v_member_balance, 0) + greatest(coalesce(v_frozen, 0), 0)
    ) l;

    if v_old_redeem_amount > v_cap then
      raise exception '本單目前最多可折 NT$%(應付 NT$% 的 %)，原本的紅利折抵 % 點(NT$%)已超過上限，請先把折抵點數改成 % 點以下',
        trim_scale(v_cap), trim_scale(v_amount.final_amount), v_s.redeem_max_ratio_percent || '%',
        v_old_redeemed, trim_scale(v_old_redeem_amount), v_max_points;
    end if;
  end if;

  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_sel.end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    customer_address = nullif(btrim(coalesce(p_customer_address, '')), ''),
    notes = p_notes,
    customer_notes = p_customer_notes,
    custom_total_amount_enabled = coalesce(p_custom_total_amount_enabled, false),
    custom_total_amount = p_custom_total_amount,
    subtotal_amount_snapshot = v_amount.subtotal_amount,
    discount_enabled = coalesce(p_discount_enabled, false),
    discount_mode = p_discount_mode,
    discount_value = p_discount_value,
    discount_amount_snapshot = v_amount.discount_amount,
    tax_enabled = coalesce(p_tax_enabled, false),
    tax_mode_snapshot = p_tax_mode,
    tax_value_snapshot = p_tax_value,
    tax_amount_snapshot = v_amount.tax_amount,
    -- 🔴 第 3 題定案 A / §2.11:不扣紅利折抵。
    final_amount_snapshot = v_amount.final_amount,
    payment_method_id = p_payment_method_id,
    payment_method_name_snapshot = v_sel.payment_method_name,
    custom_duration_enabled = coalesce(p_custom_duration_enabled, false),
    custom_duration_minutes = case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    member_id = v_effective_member_id,
    member_name_snapshot = v_member_name,
    -- SPECS-INDEX #852/#857:無條件覆寫,跟這支函式其他欄位同一套語意(見參數清單上的 ⚠️)。
    hide_notes_from_staff = coalesce(p_hide_notes_from_staff, false),
    -- 紅利系統重構 §3.4。
    points_planned = v_planned,
    points_planned_auto = v_points.auto_points,
    points_planned_overridden = v_overridden,
    points_review_required = v_points.review_required,
    points_planned_breakdown = v_points.breakdown,
    points_redeemed = v_target_redeemed,
    points_redeem_amount_snapshot = case when v_target_redeemed = 0 then 0 else v_new_redeem_amount end,
    last_modified_by_user_id = auth.uid(),
    last_modified_at = now()
  where id = p_booking_id;

  -- 紅利系統重構 §3.4 第 4 步:依新值對新會員扣點(同一交易;上面已退過舊的)。
  if v_redeem_changed and v_target_redeemed > 0 then
    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
    ) values (
      v_effective_member_id, v_merchant_id, 'redeem_booking', -v_target_redeemed,
      v_member_balance - v_target_redeemed, p_booking_id,
      format('編輯訂單時使用紅利折抵 %s 點(折 NT$%s)', v_target_redeemed, trim_scale(v_new_redeem_amount)),
      auth.uid()
    );

    update public.members
    set points_balance = v_member_balance - v_target_redeemed
    where id = v_effective_member_id;
  end if;

  -- 2026-09-24 修正(B2):一定要在下面那行 delete「之前」把既有的料錢快照收起來,
  -- 不然整批刪掉之後就再也查不到原始快照了。
  select coalesce(
           jsonb_object_agg(bmc.material_cost_item_id::text, bmc.amount_snapshot),
           '{}'::jsonb
         )
    into v_existing_material_snapshots
  from public.booking_material_costs bmc
  where bmc.booking_id = p_booking_id;

  delete from public.booking_service_items where booking_id = p_booking_id;
  delete from public.booking_assistants where booking_id = p_booking_id;
  delete from public.booking_material_costs where booking_id = p_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    p_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select p_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    -- 2026-09-24 修正(B2):舊品項沿用原本的 amount_snapshot(維持快照原則),
    -- 只有這次新加進來的品項(對照表裡查不到)才讀 material_cost_items.amount 的即時金額。
    -- 比照同一支函式上面服務項目的做法(unit_price 用呼叫端帶入的快照值,不重查 service_items.price)。
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select
      p_booking_id,
      mci.id,
      coalesce(
        (v_existing_material_snapshots ->> mci.id::text)::numeric,
        mci.amount
      )
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$function$;


revoke execute on function public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) from PUBLIC, anon;
grant execute on function public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_assistant_staff_ids uuid[], p_material_cost_item_ids uuid[], p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_member_id uuid, p_hide_notes_from_staff boolean, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- ③ public.preview_booking_points
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- SPECS-INDEX #939(第 11 批 A):編輯已連結會員的單、而且改了電話。
  v_phone_changed boolean := false;
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
      raise exception '找不到這筆預約，或沒有權限查看' using errcode = '42501';
    end if;
  end if;

  -- 2. 功能關閉 ⇒ 只回一個鍵,不洩漏任何設定或會員資訊。
  v_s := private.merchant_member_settings_effective(p_merchant_id);
  if not coalesce(v_s.points_feature_enabled, true) then
    return jsonb_build_object('feature_enabled', false);
  end if;

  -- 3. 決定會員(member.resolution)。
  -- SPECS-INDEX #939(第 11 批 A):編輯模式**先**問 private.resolve_edit_booking_member
  --   (update_booking 呼叫的是同一支 ⇒「預覽對到誰 = 送出後掛誰」)。這張單原本有會員、而且電話
  --   正規化後跟原本不同 ⇒ 依新電話決定會員(忽略 p_member_id):格式還沒填完 ⇒ phone_incomplete;
  --   1 位 ⇒ existing(就是他);0 位 ⇒ new(儲存時會自動建立);≥ 2 位 ⇒ ambiguous。
  --   沒觸發才走下面原本的 p_member_id 分支(含補掛、已下架的原會員)。
  --   helper 的商家取自訂單本身;上面已確認訂單屬於 p_merchant_id,不能拿別家的單探測會員。
  if p_booking_id is not null then
    select r.phone_changed, r.match_count, r.member_id
    into v_phone_changed, v_match_count, v_matched_id
    from private.resolve_edit_booking_member(p_booking_id, p_customer_phone) r;
    v_phone_changed := coalesce(v_phone_changed, false);
  end if;

  if v_phone_changed then
    if not private.is_valid_taiwan_phone(p_customer_phone) then
      v_resolution := 'phone_incomplete';
    elsif v_match_count = 1 then
      select m.id, m.name, m.points_balance into v_member_id, v_member_name, v_balance
      from public.members m
      where m.id = v_matched_id
        and m.merchant_id = p_merchant_id;
      v_resolution := 'existing';
    elsif v_match_count = 0 then
      v_resolution := 'new';
    else
      v_resolution := 'ambiguous';
    end if;
  elsif p_member_id is not null then
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
        raise exception '請提供每個服務項目的單價，且不能是負數';
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
    -- 批次 7:只在「因為核發資格條件拿不到點」時才告訴前端是哪一種條件(文案「需 {條件}」用),
    -- 其餘情況一律 null,不多洩漏商家設定。
    'reward_condition_mode', case when v_points.ineligible_reason = 'reward_condition'
                                  then v_s.reward_condition_mode end,
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
$function$;


revoke execute on function public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) from PUBLIC, anon;
grant execute on function public.preview_booking_points(p_merchant_id uuid, p_booking_id uuid, p_member_id uuid, p_customer_phone text, p_service_items jsonb, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- ④ public.staff_update_booking:本體不改(它把現有會員傳給 update_booking,改電話時後端會忽略),只更新註解。
-- ---------------------------------------------------------------------
comment on function public.staff_update_booking(p_booking_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text, p_notes text, p_customer_address text, p_customer_notes text, p_custom_total_amount_enabled boolean, p_custom_total_amount numeric, p_discount_enabled boolean, p_discount_mode text, p_discount_value numeric, p_tax_enabled boolean, p_tax_mode text, p_tax_value numeric, p_payment_method_id uuid, p_custom_duration_enabled boolean, p_custom_duration_minutes integer, p_points_override integer, p_points_redeemed integer, p_points_override_reset boolean, p_points_redeem_member_id uuid, p_material_cost_item_ids uuid[]) is
  'SPECS-INDEX #977 第 7 批 / #986 第 9 批:主要服務人員本人(可以自己下單者)編輯自己的單。主要服務人員、協助人員、會員、隱藏備註旗標一律保留現值;內部備註被藏起來時保留原文。料錢 p_material_cost_item_ids:null = 維持現有料錢,非 null(含空陣列)= 用前端的值,檢查沿用 validate_booking_selection。內部呼叫 update_booking。#939 第 11 批 A:服務人員不能挑選 / 補掛會員,但改了電話時 update_booking 會依新電話自動改掛(找不到就自動建立新會員,跟服務人員自己建單同一套規則),紅利依新會員重算。';
