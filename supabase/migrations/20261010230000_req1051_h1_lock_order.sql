-- SPECS-INDEX #1051 全面體檢修正(H1-04、H1-05):訂單/會員點數/獎金方案等寫入函式的加鎖順序加固。
--
-- H1-04:下列 10 支改成「先不加鎖讀出 merchant_id → 權限檢查 → 通過後才 for update 重讀狀態」
--        (照 private.staff_order_own_booking 的寫法);「找不到這筆」與「沒有權限」回同一句既有的沒權限訊息。
--        有權限的人看到的行為與錯誤訊息完全不變(重讀後的狀態檢查、後續邏輯一字未改)。
--   public.cancel_booking / complete_booking / confirm_booking / update_booking_payment_method /
--   update_booking / move_booking / adjust_member_points / redeem_member_points /
--   archive_staff_bonus_plan、private.reverse_booking_completion
-- H1-05:public.cancel_staff_leave、public.restore_merchant_agent 權限檢查後加鎖重讀。
--
-- 每支都以正式庫現行本體(pg_get_functiondef)為底,只改上述區塊;create or replace 不改簽章,
-- 既有 ACL 不變(仍照原本的 revoke/grant)。

CREATE OR REPLACE FUNCTION public.cancel_booking(p_booking_id uuid, p_reason text DEFAULT NULL::text)
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
  -- 紅利系統重構 批次 3:加上 for update(原本沒有),跟 update_booking 排隊 ——
  -- 否則「改單」與「取消」同時送出時,改單可能在取消之後又把折抵重新扣回去。
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀狀態;
  -- 「找不到這筆」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.bookings
  where id = p_booking_id;

  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '只有「待確認」或「已確認」狀態的預約可以取消，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  -- 紅利系統重構 §3.11.1:退回這張單的折抵凍結(不看紅利功能開關、不看會員狀態;沒有折抵就什麼都不寫)。
  -- 取消的訂單不入帳派點(points_planned 保留當歷史快照,complete_booking 不會再被呼叫)。
  if private.refund_booking_redeem(p_booking_id) > 0 then
    -- 退回時把 points_redeemed / points_redeem_amount_snapshot 歸 0 了,回傳最新的那一列。
    select * into v_result from public.bookings where id = p_booking_id;
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'cancelled');

  return v_result;
end;
$function$
;

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
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀狀態;
  -- 「找不到這筆」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.bookings
  where id = p_booking_id;

  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以標記完成，目前狀態不允許這個操作';
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
$function$
;

CREATE OR REPLACE FUNCTION public.confirm_booking(p_booking_id uuid)
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
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀狀態;
  -- 「找不到這筆」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.bookings
  where id = p_booking_id;

  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'pending_confirmation' then
    raise exception '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  update public.bookings
  set status = 'accepted',
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
    and status = 'pending_confirmation'
  returning * into v_result;

  if not found then
    raise exception '只有「待確認」狀態的預約可以確認，目前狀態不允許這個操作(目前狀態：%)', (select status from public.bookings where id = p_booking_id);
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:v_status 是變更前的狀態(pending_confirmation)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, v_status, 'accepted');

  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_booking_payment_method(p_booking_id uuid, p_payment_method_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_payment_method_name text;
  v_result public.bookings;
begin
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀狀態;
  -- 「找不到這筆」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.bookings
  where id = p_booking_id;

  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：%)', v_status;
  end if;

  if p_payment_method_id is not null then
    -- 修正(2026-09-19,主腦複查):如果這個 payment_method_id 剛好就是這筆訂單目前已存的值,
    -- 沿用既有快照文字,不重新查詢目前名稱(理由同 private.validate_booking_selection)。
    select payment_method_name_snapshot into v_payment_method_name
    from public.bookings
    where id = p_booking_id and payment_method_id = p_payment_method_id;

    if v_payment_method_name is null then
      -- 跟 private.validate_booking_selection 同樣的放行邏輯:status='active',或是這筆訂單本來
      -- 就已經是這個值(不強制因為商家事後下架而擋下「沒有真的要換」的操作)。
      select name into v_payment_method_name
      from public.payment_methods
      where id = p_payment_method_id
        and merchant_id = v_merchant_id
        and (
          status = 'active'
          or exists (
            select 1 from public.bookings
            where id = p_booking_id and payment_method_id = p_payment_method_id
          )
        );

      if not found then
        raise exception '找不到這個付款方式，或已下架';
      end if;
    end if;
  else
    v_payment_method_name := null;
  end if;

  update public.bookings
  set payment_method_id = p_payment_method_id,
      payment_method_name_snapshot = v_payment_method_name,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
    and status in ('pending_confirmation', 'accepted')
  returning * into v_result;

  if not found then
    raise exception '已完成或已取消的預約不能修改付款方式，目前狀態不允許這個操作(目前狀態：%)', (select status from public.bookings where id = p_booking_id);
  end if;

  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.update_booking(p_booking_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_assistant_staff_ids uuid[] DEFAULT '{}'::uuid[], p_material_cost_items jsonb DEFAULT '[]'::jsonb, p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_member_id uuid DEFAULT NULL::uuid, p_hide_notes_from_staff boolean DEFAULT false, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT NULL::integer, p_points_override_reset boolean DEFAULT false, p_points_redeem_member_id uuid DEFAULT NULL::uuid)
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
  -- [b11-f begin] 第 11 批 F #993:從 p_material_cost_items 抽出來的品項 id(交給 validate_booking_selection)。
  v_material_ids uuid[];
  -- [b11-f end]
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
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀;「找不到這筆」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.bookings
  where id = p_booking_id;

  if v_merchant_id is null or not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  select merchant_id, status, member_id, points_planned, points_planned_overridden,
         points_redeemed, points_redeem_amount_snapshot, final_amount_snapshot
  into v_merchant_id, v_status, v_old_member_id, v_old_planned, v_old_overridden,
       v_old_redeemed, v_old_redeem_amount, v_old_final_amount
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
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

  -- [b11-f begin] 先驗料錢格式(數量 1~999 整數、單價 ≥ 0、不可重複),再抽出 id 交給既有檢查。
  select coalesce(array_agg(m.material_cost_item_id), '{}'::uuid[]) into v_material_ids
  from private.parse_booking_material_cost_items(p_material_cost_items) m;
  -- [b11-f end]

  select * into v_sel from private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, v_material_ids, p_booking_id,
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

  if array_length(v_material_ids, 1) is not null then
    -- 2026-09-24 修正(B2):舊品項沿用原本的 amount_snapshot(維持快照原則),
    -- 只有這次新加進來的品項(對照表裡查不到)才讀 material_cost_items.amount 的即時金額。
    -- 比照同一支函式上面服務項目的做法(unit_price 用呼叫端帶入的快照值,不重查 service_items.price)。
    -- [b11-f begin] 第 11 批 F #993:單價 = coalesce(前端送的自訂成本單價, 這張單原本的單價快照, 品項現價);
    --   數量 = 前端送的數量(1~999,helper 已驗)。amount_snapshot 語意 = 單價,小計 = 單價 × 數量。
    insert into public.booking_material_costs (booking_id, material_cost_item_id, quantity, amount_snapshot)
    select
      p_booking_id,
      mci.id,
      m.quantity,
      coalesce(
        m.unit_price,
        (v_existing_material_snapshots ->> mci.id::text)::numeric,
        mci.amount
      )
    from private.parse_booking_material_cost_items(p_material_cost_items) m
    join public.material_cost_items mci on mci.id = m.material_cost_item_id;
    -- 主腦裁決(溢位):單一品項小計 ≤ 1,000,000、整張單料錢合計 ≤ 9,999,999.99(單價沒送時要寫入後才知道)。
    perform private.assert_booking_material_cost_limits(p_booking_id);
    -- [b11-f end]
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.move_booking(p_booking_id uuid, p_dragged_staff_id uuid, p_target_staff_id uuid, p_target_start_at timestamp with time zone, p_expected_start_at timestamp with time zone, p_expected_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_booking public.bookings;
  v_target public.merchant_staff;
  v_main public.merchant_staff;
  v_assistant public.merchant_staff;
  v_dragged_role text;
  v_mode text;
  v_duration interval;
  v_new_start timestamptz;
  v_new_end timestamptz;
  v_time_changed boolean := false;
  v_staff_changed boolean := false;
  v_prev_assistant_staff_id uuid;
  v_next_assistant_staff_id uuid;
  v_updated_rows integer;
  v_result public.bookings;
begin
  -- [a] 讀訂單 → 權限 → 狀態(順序跟 update_booking 完全一致)。
  --     #1051 加固:先不加鎖讀 → 權限檢查 → 通過後才加鎖重讀;「找不到這筆」與「沒有權限」回同一句。
  select * into v_booking
  from public.bookings
  where id = p_booking_id;

  if v_booking.id is null or not private.can_manage_bookings(v_booking.merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id
  for update;

  if not found then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_booking.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能移動';
  end if;

  -- [b] 畫面過期偵測(#810):前端「拖之前」看到的值跟資料庫現況不符,代表別人剛改過這筆單。
  --     用 is distinct from(§6.6),即使哪天 staff_id 允許 null 也不會誤判。
  if v_booking.start_at is distinct from p_expected_start_at
     or v_booking.staff_id is distinct from p_expected_staff_id then
    raise exception '這筆預約剛剛被其他人改過，畫面已重新整理，請再拖一次' using errcode = '40001';
  end if;

  -- [c] 判定被拖的那顆色塊是主還是助手。
  if p_dragged_staff_id is not null and p_dragged_staff_id = v_booking.staff_id then
    v_dragged_role := 'main';
  elsif exists (
    select 1 from public.booking_assistants ba
    where ba.booking_id = p_booking_id and ba.staff_id = p_dragged_staff_id
  ) then
    v_dragged_role := 'assistant';
  else
    raise exception '找不到這位服務人員在這筆預約裡的角色，請重新整理';
  end if;

  -- 目標服務人員:必須是同一間商家、在職(§6.3,跟 validate_booking_selection 第 2/4 步一致)。
  select * into v_target
  from public.merchant_staff
  where id = p_target_staff_id
    and merchant_id = v_booking.merchant_id
    and status = 'active';

  if not found then
    raise exception '找不到這位服務人員，或這位服務人員已被移除';
  end if;

  -- 復原/回傳用:這筆單目前的(第一位)助手。
  select ba.staff_id into v_prev_assistant_staff_id
  from public.booking_assistants ba
  where ba.booking_id = p_booking_id
  order by ba.created_at, ba.id
  limit 1;
  v_next_assistant_staff_id := v_prev_assistant_staff_id;

  -- [e] 時長永遠不變。
  v_duration := v_booking.end_at - v_booking.start_at;

  if v_dragged_role = 'main' then
    -- ---------------------------------------------------------------
    -- 主服務人員色塊:控制「時間 + 主服務人員」。
    -- ---------------------------------------------------------------
    if p_target_start_at is null then
      raise exception '請指定要移動到的時間';
    end if;

    -- §6.7:秒/毫秒截掉再用,不依賴前端吸附。
    v_new_start := date_trunc('minute', p_target_start_at);
    v_new_end := v_new_start + v_duration;

    v_time_changed := v_new_start is distinct from v_booking.start_at;
    v_staff_changed := v_target.id <> v_booking.staff_id;

    if not v_time_changed and not v_staff_changed then
      -- 5.8:前端遇到「跟原本完全一樣」不會打 RPC;後端收到就當作沒有需要變更的內容擋下,
      -- 避免寫入一筆「沒變」的更新(還會讓前端多送一則推播)。
      raise exception '放開的位置跟原本一樣，沒有需要變更的內容';
    end if;

    if v_staff_changed then
      -- Q5 = A:主轉派給「已經是本單助手」的人,擋下。
      if exists (
        select 1 from public.booking_assistants ba
        where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
      ) then
        raise exception '「%」已經是這筆預約的助手，請先用編輯把助手改掉，或改拖給其他人', v_target.name;
      end if;

      v_mode := 'reassign_main';

      -- 規則 2 / Q1=B:目標服務人員 × 新時段(時間沒變就是原時段)。
      perform private.check_staff_booking_slot(
        v_booking.merchant_id, v_target, v_new_start, v_new_end, p_booking_id, '主要服務人員'
      );
    else
      v_mode := 'time';

      -- 規則 1:主服務人員本人 × 新時段(本人也要在職,跟 validate_booking_selection 第 2 步一致)。
      select * into v_main
      from public.merchant_staff
      where id = v_booking.staff_id
        and merchant_id = v_booking.merchant_id
        and status = 'active';

      if not found then
        raise exception '找不到這位服務人員，或這位服務人員已被移除';
      end if;

      perform private.check_staff_booking_slot(
        v_booking.merchant_id, v_main, v_new_start, v_new_end, p_booking_id, '主要服務人員'
      );
    end if;

    -- 規則 1「須檢測」+ Q1=B 衍生邊界 3:只要時間有變,每一位助手都要用新時段再驗一次
    -- (助手沒有自己的時間欄位,實際時段跟著主單走)。
    if v_time_changed then
      for v_assistant in
        select ms.*
        from public.booking_assistants ba
        join public.merchant_staff ms on ms.id = ba.staff_id
        where ba.booking_id = p_booking_id
        order by ba.created_at, ba.id
      loop
        if v_assistant.status <> 'active' or v_assistant.merchant_id <> v_booking.merchant_id then
          raise exception '找不到其中一位助手，或這位助手已被移除';
        end if;

        perform private.check_staff_booking_slot(
          v_booking.merchant_id, v_assistant, v_new_start, v_new_end, p_booking_id,
          format('助手「%s」', v_assistant.name)
        );
      end loop;
    end if;

    -- [g] 寫入(同一個交易;任何 raise 都會整筆回滾)。
    update public.bookings set
      staff_id = v_target.id,
      start_at = v_new_start,
      end_at = v_new_end,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id
      and status in ('pending_confirmation', 'accepted');

    if not found then
      raise exception '已完成或已取消的預約不能移動';
    end if;

  else
    -- ---------------------------------------------------------------
    -- 助手色塊:只控制「誰是助手」(Q2 使用者裁決),p_target_start_at 完全忽略。
    -- ---------------------------------------------------------------
    v_mode := 'reassign_assistant';
    v_new_start := v_booking.start_at;
    v_new_end := v_booking.end_at;

    if v_target.id = p_dragged_staff_id then
      -- Q2 衍生邊界 1:助手拖回自己那一欄 = 換成自己 = 沒有任何改變。
      raise exception '放開的位置跟原本一樣，沒有需要變更的內容';
    end if;

    if v_target.id = v_booking.staff_id
       or exists (
         select 1 from public.booking_assistants ba
         where ba.booking_id = p_booking_id and ba.staff_id = v_target.id
       ) then
      raise exception '這位服務人員已經在這筆預約裡了';
    end if;

    -- 規則 3:目標服務人員 × 原時段。
    perform private.check_staff_booking_slot(
      v_booking.merchant_id, v_target, v_booking.start_at, v_booking.end_at, p_booking_id,
      format('助手「%s」', v_target.name)
    );

    -- §6.1:update ... set staff_id,不是 delete+insert(保留 id / created_at,列數不變)。
    update public.booking_assistants
    set staff_id = v_target.id
    where booking_id = p_booking_id
      and staff_id = p_dragged_staff_id;

    get diagnostics v_updated_rows = row_count;
    if v_updated_rows <> 1 then
      raise exception '找不到這位服務人員在這筆預約裡的角色，請重新整理';
    end if;

    update public.bookings set
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
    where id = p_booking_id
      and status in ('pending_confirmation', 'accepted');

    if not found then
      raise exception '已完成或已取消的預約不能移動';
    end if;

    v_prev_assistant_staff_id := p_dragged_staff_id;
    v_next_assistant_staff_id := v_target.id;
    v_staff_changed := true;
  end if;

  -- [h] 回傳。
  select * into v_result from public.bookings where id = p_booking_id;

  return jsonb_build_object(
    'mode', v_mode,
    'booking', to_jsonb(v_result),
    'previous', jsonb_build_object(
      'start_at', v_booking.start_at,
      'end_at', v_booking.end_at,
      'staff_id', v_booking.staff_id,
      'assistant_staff_id', v_prev_assistant_staff_id
    ),
    'next', jsonb_build_object(
      'start_at', v_result.start_at,
      'end_at', v_result.end_at,
      'staff_id', v_result.staff_id,
      'assistant_staff_id', v_next_assistant_staff_id
    ),
    'time_changed', v_time_changed,
    'staff_changed', v_staff_changed
  );
end;
$function$
;

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
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀餘額;「找不到這位會員」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.members
  where id = p_member_id;

  -- 規則 2.6(核心):只檢查 private.is_merchant_admin,不接受客服呼叫,即使該客服已經被授權
  -- members 這個 section_key 也一樣被擋下。
  if v_merchant_id is null or not private.is_merchant_admin(v_merchant_id) then
    raise exception '手動調整會員點數，只有商家管理員可以操作' using errcode = '42501';
  end if;

  select merchant_id, points_balance into v_merchant_id, v_balance
  from public.members
  where id = p_member_id
  for update;

  if not found then
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
$function$
;

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
  -- #1051 加固:先不加鎖讀出商家 → 權限檢查 → 通過後才加鎖重讀餘額;「找不到這位會員」與「沒有權限」回同一句。
  select merchant_id into v_merchant_id
  from public.members
  where id = p_member_id;

  if v_merchant_id is null or not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  select merchant_id, points_balance into v_merchant_id, v_balance
  from public.members
  where id = p_member_id
  for update;

  if not found then
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
$function$
;

CREATE OR REPLACE FUNCTION public.archive_staff_bonus_plan(p_plan_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_plan record;
  v_in_use_count int;
  v_in_use_names text;
begin
  -- #1051 加固:先不加鎖讀 → 權限檢查 → 通過後才加鎖重讀狀態。
  select bp.id, bp.merchant_id, bp.status into v_plan
  from public.staff_bonus_plans bp
  where bp.id = p_plan_id;

  if not found or not private.can_manage_commission_settings(v_plan.merchant_id) then
    raise exception '找不到這個獎金方案，或沒有權限修改。' using errcode = '42501';
  end if;

  select bp.id, bp.merchant_id, bp.status into v_plan
  from public.staff_bonus_plans bp
  where bp.id = p_plan_id
  for update;

  if not found then
    raise exception '找不到這個獎金方案，或沒有權限修改。' using errcode = '42501';
  end if;

  if v_plan.status = 'archived' then
    return;
  end if;

  select count(*)::int, string_agg(ms.name, '、' order by ms.display_order, ms.created_at, ms.id)
  into v_in_use_count, v_in_use_names
  from public.staff_bonus_assignments a
  join public.merchant_staff ms on ms.id = a.staff_id
  where a.plan_id = p_plan_id
    and ms.status = 'active'
    and ms.compensation_type = 'monthly_salary';

  if v_in_use_count > 0 then
    raise exception '還有 % 位月薪人員使用這個方案（%），請先改掉。', v_in_use_count, v_in_use_names
      using errcode = '23503';
  end if;

  update public.staff_bonus_assignments
  set plan_id = null, updated_by_user_id = auth.uid(), updated_at = now()
  where plan_id = p_plan_id;

  update public.staff_bonus_plans
  set status = 'archived', updated_at = now()
  where id = p_plan_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION private.reverse_booking_completion(p_booking_id uuid, p_target_status text, p_reason text, p_notify_requested boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- 去頭尾空白:除了半形空白,也去掉 tab、換行與全形空白(U+3000)——只按 btrim() 預設只去半形空白,
  -- 「全形空白」或「只有換行」的原因會被當成有填(pgTAP D17 實測抓到)。
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n\u3000');
  v_merchant_id uuid;
  v_status text;
  v_source text;
  v_original_completed_at timestamptz;
  v_commission_snapshot jsonb;
  v_commission_amount numeric(10, 2) := 0;
  v_frozen integer := 0;
  v_points jsonb;
  v_is_cross_month boolean;
  v_report_month text;
  v_action text;
  v_booking public.bookings;
begin
  -- 1. 參數檢查(不涉及訂單內容,先擋不會洩漏任何資訊)。
  if p_target_status is null or p_target_status not in ('accepted', 'cancelled') then
    raise exception '不支援的目標狀態(只能還原為「已確認」或取消)' using errcode = '22023';
  end if;

  if v_reason = '' then
    raise exception '請填寫還原/取消的原因' using errcode = '22023';
  end if;

  if char_length(v_reason) > 500 then
    raise exception '原因最多 500 個字，目前是 % 個字，請精簡後再送出', char_length(v_reason) using errcode = '22023';
  end if;

  -- 2. #1051 加固:先不加鎖讀出商家 → 權限檢查(§4.1 第 3 步:先擋權限、再回報狀態,
  --    客服不會從錯誤訊息得知這張單目前的狀態)→ 通過後才鎖訂單列重讀
  --    (§3.11:鎖住之後才看狀態,兩個人同時按,第二個人一定看到最新狀態)。
  --    「找不到這筆」與「沒有權限」回同一句。
  select b.merchant_id into v_merchant_id
  from public.bookings b
  where b.id = p_booking_id;

  if v_merchant_id is null or not private.is_merchant_admin(v_merchant_id) then
    raise exception '還原或取消已完成的訂單，只有商家管理員可以操作' using errcode = '42501';
  end if;

  select b.merchant_id, b.status, b.source, b.completed_at
  into v_merchant_id, v_status, v_source, v_original_completed_at
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    raise exception '還原或取消已完成的訂單，只有商家管理員可以操作' using errcode = '42501';
  end if;

  -- 4. 狀態複檢(冪等:同一張單重複按,第二次在這裡被擋下,不會重複刪快照或重複收點)。
  if v_status <> 'completed' then
    raise exception '這筆訂單的狀態已經改變，請重新整理後再試' using errcode = 'P0001';
  end if;

  -- 5. 匯入的歷史訂單只能取消、不能還原(§3.13)。
  if p_target_status = 'accepted' and v_source = 'import' then
    raise exception '匯入的歷史訂單不能還原，只能取消。如果匯錯了，請取消後重新匯入' using errcode = 'P0001';
  end if;

  -- 不變量 status='completed' ⇔ completed_at 有值(§3.10;正式庫 0 筆例外)。萬一真的遇到就擋下,
  -- 不要寫出一筆 original_completed_at 為空的稽核(稽核表該欄 not null,會變成看不懂的系統錯誤)。
  if v_original_completed_at is null then
    raise exception '這筆已完成訂單缺少完成時間，資料異常，請聯絡系統管理員' using errcode = 'P0001';
  end if;

  v_action := case p_target_status when 'accepted' then 'revert_to_accepted' else 'cancel_completed' end;

  -- 6. 抽成快照組成 jsonb(先讀、還不刪,§3.4 第 1 點)。月薪制/沒有快照 → null / 0。
  select to_jsonb(r) || jsonb_build_object('items', coalesce((
           select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
           from public.booking_commission_item_records i
           where i.commission_record_id = r.id), '[]'::jsonb)),
         r.commission_amount
  into v_commission_snapshot, v_commission_amount
  from public.booking_commission_records r
  where r.booking_id = p_booking_id;

  v_commission_amount := coalesce(v_commission_amount, 0);

  -- 7. 折抵退回(只有取消路徑)。🔴 順序不可調換(§4.1 第 7 步,pgTAP module17_01 有故障注入):
  --    先把狀態改成 cancelled(completed_at 先留著)→ 再退回。退回函式看「訂單現在是不是 cancelled」
  --    決定分類帳備註,狀態沒先改會寫成「訂單編輯變更了會員或折抵點數…」。
  if p_target_status = 'cancelled' then
    update public.bookings
    set status = 'cancelled',
        cancelled_at = now(),
        cancelled_reason = v_reason
    where id = p_booking_id;

    v_frozen := private.refund_booking_redeem(p_booking_id);
  else
    v_frozen := 0;  -- 還原路徑:單子還活著,折抵凍結維持(§3.6)
  end if;

  -- 8. 收回入帳(兩個入口都做;不傳 p_points_due,讓紅利函式自己從分類帳算)。
  --    🔴 此時 completed_at 一定還在(§4.1 第 8 步,pgTAP 有故障注入):收回函式用它找「本單完成之後
  --    才折抵的訂單」組差額提示;先清成 null 會變成 -infinity,提示會列出該會員所有折抵單。
  --    會員已下架、紅利功能關閉都照樣收回(前提 E、Q9(a)):本檔刻意不加任何判斷。
  v_points := private.reverse_booking_earned_points(p_booking_id);

  -- 9. 刪抽成快照(明細 on delete cascade)。放在紅利呼叫之後只是讓可能 raise 的步驟先跑;
  --    任何一步 raise 都整筆回滾(邊界 17)。
  delete from public.booking_commission_records where booking_id = p_booking_id;

  -- 10. 跨月與報表月份一律用台北時區(§3.8)。
  v_is_cross_month := date_trunc('month', v_original_completed_at at time zone 'Asia/Taipei')
                      < date_trunc('month', now() at time zone 'Asia/Taipei');
  v_report_month := to_char(v_original_completed_at at time zone 'Asia/Taipei', 'YYYY-MM');

  -- 11. 改最終狀態並清 completed_at(還原路徑在這一步才改狀態;取消路徑狀態已是 cancelled)。
  update public.bookings
  set status = p_target_status,
      completed_at = null,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_booking;

  -- 12. 操作紀錄:五參數版(沒有 default,一定要明確傳 note)。note 只放原因,不放點數或餘額
  --     ——有訂單鑰匙的客服看得到操作紀錄(§3.2)。
  perform private.log_booking_status_change(p_booking_id, v_merchant_id, 'completed', p_target_status, v_reason);

  -- 13. 稽核表(收回函式 8 個鍵逐一寫入同名欄位)。
  insert into public.booking_completion_reversals (
    booking_id, merchant_id, action, reason, actor_user_id, actor_name_snapshot,
    original_completed_at, report_month, is_cross_month,
    commission_record_snapshot, commission_amount_reversed,
    points_due, points_recovered, points_shortfall,
    referral_due, referral_recovered, referral_shortfall,
    referrer_member_id, shortfall_hint,
    frozen_points_refunded, notified
  ) values (
    p_booking_id, v_merchant_id, v_action, v_reason, auth.uid(),
    private.current_actor_display_name(v_merchant_id),
    v_original_completed_at, v_report_month, v_is_cross_month,
    v_commission_snapshot, v_commission_amount,
    coalesce((v_points ->> 'points_due')::int, 0),
    coalesce((v_points ->> 'points_recovered')::int, 0),
    coalesce((v_points ->> 'points_shortfall')::int, 0),
    coalesce((v_points ->> 'referral_due')::int, 0),
    coalesce((v_points ->> 'referral_recovered')::int, 0),
    coalesce((v_points ->> 'referral_shortfall')::int, 0),
    (v_points ->> 'referrer_member_id')::uuid,
    v_points ->> 'shortfall_hint',
    v_frozen,
    case when p_target_status = 'cancelled' then coalesce(p_notify_requested, false) else false end
  );

  -- 14. 回傳(含推薦人餘額的提示 ⇒ 只有管理員拿得到,權限已在第 3 步擋)。
  return jsonb_build_object(
    'booking', to_jsonb(v_booking),
    'action', v_action,
    'commission_amount_reversed', v_commission_amount,
    'report_month', v_report_month,
    'is_cross_month', v_is_cross_month,
    'points', jsonb_build_object(
      'points_due', coalesce((v_points ->> 'points_due')::int, 0),
      'points_recovered', coalesce((v_points ->> 'points_recovered')::int, 0),
      'points_shortfall', coalesce((v_points ->> 'points_shortfall')::int, 0),
      'referral_due', coalesce((v_points ->> 'referral_due')::int, 0),
      'referral_recovered', coalesce((v_points ->> 'referral_recovered')::int, 0),
      'referral_shortfall', coalesce((v_points ->> 'referral_shortfall')::int, 0),
      'referrer_member_id', v_points -> 'referrer_member_id',
      'shortfall_hint', v_points -> 'shortfall_hint',
      'frozen_points_refunded', v_frozen
    )
  );
end;
$function$
;

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

  -- #1051 加固:權限檢查通過後才加鎖重讀狀態,同一筆同時操作時後到的人看到最新狀態。
  select slr.status into v_status
  from public.staff_leave_records slr
  where slr.id = p_leave_id
  for update;

  if not found then
    raise exception '找不到這筆請假紀錄';
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
$function$
;

CREATE OR REPLACE FUNCTION public.restore_merchant_agent(p_agent_id uuid)
 RETURNS merchant_agents
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_user_id uuid;
  v_activated_at timestamptz;
  v_invited_email text;
  v_new_status text;
  v_result public.merchant_agents;
begin
  select merchant_id, status, user_id, activated_at, invited_email
  into v_merchant_id, v_status, v_user_id, v_activated_at, v_invited_email
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄';
  end if;

  -- 只有商家管理員能恢復(比照既有 remove_merchant_agent 的授權,恢復跟移除必須是同一個層級的
  -- 權限,否則被移除的客服自己就能把自己恢復回來)。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作，僅限該商家管理員使用' using errcode = '42501';
  end if;

  -- #1051 加固:權限檢查通過後才加鎖重讀,同一筆同時操作時後到的人看到最新狀態。
  select status, user_id, activated_at, invited_email
  into v_status, v_user_id, v_activated_at, v_invited_email
  from public.merchant_agents
  where id = p_agent_id
  for update;

  if not found then
    raise exception '找不到指定的客服紀錄';
  end if;

  if v_status <> 'removed' then
    raise exception '只有已移除的客服才需要恢復，這位客服目前的狀態不是已移除';
  end if;

  -- 防呆(§(4) 那個極端情況):如果這個商家底下已經有另一筆「還沒被移除」的客服用同一個
  -- 邀請 email,恢復會在列表上出現兩筆同一個人。正常情況不可能發生——
  -- merchant_agents_merchant_user_unique (merchant_id, user_id) where user_id is not null
  -- 這個 partial unique index 不分狀態,同一個 (商家, 登入帳號) 全表只能有一列,而且既有的
  -- record_invited_merchant_agent 重新邀請時是復用舊列而不是插新列。只有在舊列的 auth 帳號被
  -- 刪除(on delete set null 把 user_id 清成 null)之後商家又用同一個 email 邀了新人,才可能
  -- 出現兩列。這種情況擋下來並說清楚該怎麼辦,不要留一個看不懂的重複資料給商家。
  if exists (
    select 1
    from public.merchant_agents ma
    where ma.merchant_id = v_merchant_id
      and ma.id <> p_agent_id
      and ma.status <> 'removed'
      and ma.invited_email = v_invited_email
  ) then
    raise exception '這個邀請 Email(%)目前已經有另一筆使用中的客服紀錄，無法恢復這一筆；如果要改用這一筆，請先移除另一筆',
      v_invited_email;
  end if;

  -- ---------------------------------------------------------------------
  -- 恢復成什麼狀態(⚠️ 這裡跟主腦契約「一律改回 active」有一處刻意調整,理由見檔頭)
  --   ・登入帳號還在、而且確實曾經啟用過(activated_at 有值)→ 'active'
  --     這是最常見的情境(在職過、被誤移除、要恢復),結果跟契約一致。
  --   ・其餘 → 'invited':代表「邀請信寄過但本人從沒設定密碼」,或「登入帳號已經被刪除」。
  --     恢復成 active 會讓畫面顯示「已啟用」但他其實一天都沒登入過,而且
  --     public.mark_agent_active_if_self() 的轉換條件是 status = 'invited',寫成 active 之後
  --     他將來真的去設定密碼登入時那支函式撈不到他,會永遠卡在錯誤狀態。
  --
  -- activated_at 刻意**不**重設:它記錄的是「這個帳號第一次啟用的時間」這個歷史事實,
  -- remove_merchant_agent 當初也沒有清掉它。恢復不該偽造一個新的啟用時間。
  -- invited_at 同理不動(恢復不是重新邀請;真要重新寄邀請信請走 record_invited_merchant_agent,
  -- 那支才會更新 invited_at)。
  -- ---------------------------------------------------------------------
  v_new_status := case
    when v_user_id is not null and v_activated_at is not null then 'active'
    else 'invited'
  end;

  update public.merchant_agents
  set status = v_new_status
  where id = p_agent_id
  returning * into v_result;

  return v_result;
end;
$function$
;
