-- SPECS-INDEX #977 第 4 批(2026-10-06):「商家後台確認後直接接單」開關生效。
-- 規格書 .project/specs/服務人員接單確認-第4批.md 第四節;主腦裁決 ⑤ ⑥。
--
-- 主要服務人員的 merchant_staff.direct_accept_after_merchant_confirm = true 時,商家管理員 / 客服在後台建的新訂單
-- 直接是 accepted(畫面「已確認」),操作紀錄 to_status 也寫 accepted。關閉(預設)維持 pending_confirmation,行為完全不變。
--
-- 底稿:20261001040000_bonus_refactor_batch3_booking_points.sql 的 create_booking(28 參數),
--       以本機套完全部 migration 後的 pg_get_functiondef 輸出為底,**只改**:
--         ・declare 多一個變數 v_initial_status;
--         ・v_created_by_role 那行後面多一段計算 v_initial_status;
--         ・insert 的 status 值與建立時的操作紀錄 to_status 從 'pending_confirmation' 改成 v_initial_status。
--       新增的段落都包在「[req977-batch4 begin] … [req977-batch4 end]」註解之間,pgTAP req977_04 會把它們拿掉、
--       把 v_initial_status 換回 'pending_confirmation',再比對指紋必須等於改前的 d8fb4ffb50f0516c8c815aed24c09784
--       (CRLF→LF 後 md5(prosrc)),證明其餘內容逐字相同。
-- 簽章不變(create or replace,ACL 與 comment 原樣保留);下面仍把 revoke / grant 整組明寫一次,與改前相同。
-- 編輯訂單(update_booking)不動:換主要服務人員時狀態不變(裁決 ⑥)。
-- ⚠️ 本檔沒有任何資料寫入。

CREATE OR REPLACE FUNCTION public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_assistant_staff_ids uuid[] DEFAULT '{}'::uuid[], p_material_cost_item_ids uuid[] DEFAULT '{}'::uuid[], p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_member_id uuid DEFAULT NULL::uuid, p_hide_notes_from_staff boolean DEFAULT false, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT 0, p_points_redeem_member_id uuid DEFAULT NULL::uuid)
 RETURNS bookings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_sel record;
  v_amount record;
  v_created_by_role text;
  v_booking_id uuid;
  v_industry_type text;
  v_result public.bookings;
  v_member_name text;
  -- SPECS-INDEX #912(2026-09-30)新增的 5 個區域變數。
  v_normalized_phone text;
  v_match_count int := 0;
  v_matched_member_id uuid;
  v_effective_member_id uuid;
  v_member_auto_created boolean := false;
  v_new_member public.members;
  -- 紅利系統重構 §3.3(批次 3)新增。
  v_s public.merchant_member_settings;
  v_points record;
  v_planned integer;
  v_overridden boolean := false;
  v_redeem_points integer := coalesce(p_points_redeemed, 0);
  v_redeem_amount numeric := 0;
  v_member_balance integer;
  -- [req977-batch4 begin] SPECS-INDEX #977 第 4 批(2026-10-06):新訂單的初始狀態(見下方說明)。
  v_initial_status text;
  -- [req977-batch4 end]
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限建立這間商家的預約' using errcode = '42501';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;
  -- SPECS-INDEX #822(2026-09-27):客戶電話格式驗證(手機或市話,市話可帶 # 分機,分隔符號不強制)。
  -- 規則本體在 private.is_valid_taiwan_phone,跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應。
  -- 🔴 SPECS-INDEX #913(2026-09-30):**這一段必須留在「自動建立會員」的前面**。
  --    它就是「自動建會員不會變成 #827 那個塞髒電話的新後門」的唯一理由 —— 電話在這裡先驗過,
  --    下面傳給 create_member 的一定是合格電話。不要因為任何原因把這兩段的順序調換。
  if not private.is_valid_taiwan_phone(p_customer_phone) then
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)';
  end if;

  -- 紅利系統重構 §3.3 第 2/3 步的「參數本身」檢查,放在任何寫入(含自動建立會員)之前:
  -- 數字明顯不合法時,不要先建了一位會員才報錯(雖然整筆會回滾,但錯誤越早越好懂)。
  if p_points_override is not null then
    if p_points_override < 0 then
      raise exception '派點數不能是負數';
    end if;
    if p_points_override > 100000 then
      raise exception '單筆訂單最多只能設定 100,000 點,請確認是否多打了零';
    end if;
  end if;
  if v_redeem_points < 0 then
    raise exception '折抵點數不能是負數';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- =====================================================================
  -- SPECS-INDEX #912 / #914(2026-09-30):自動建立 / 自動連結會員。
  -- 呼叫端有帶 p_member_id(客服在畫面上明確選過了)⇒ 這一整段跳過,完全照既有邏輯走。
  -- =====================================================================
  v_effective_member_id := p_member_id;

  if p_member_id is null then
    v_normalized_phone := private.normalize_phone(p_customer_phone);

    if v_normalized_phone is null then
      -- 防禦性分支,理論上到不了:上面的 is_valid_taiwan_phone 已經保證電話含有數字,
      -- normalize_phone 不可能回 NULL(只有「空值」或「只填了 #分機」才會)。
      -- 真的走到這裡的話,刻意**不建會員**:一支連正規化都算不出數字的電話,建成會員之後
      -- 永遠比對不到任何東西,只會變成一筆撈不出來的空資料。維持訂單沒有會員即可。
      -- (紅利系統重構 v2.4 裁決 8 ①:改呼叫共用 helper 之後,這個分支照樣保留。)
      v_match_count := 0;
      v_effective_member_id := null;
    else
      -- 紅利系統重構 §3.3 第 0 步 / §3.2 末段(批次 3):「依電話找會員」那一句改呼叫共用 helper
      -- private.resolve_booking_member_by_phone —— 建單頁預覽(preview_booking_points)呼叫的是
      -- **同一支**,保證「預覽對到的會員 = 送出後連結的會員」。helper 內容是原本這裡那一句逐字搬過去的
      -- (同商家、status = 'active'、normalize_phone 完全相等;挑最早建立的那一位,不用 min(uuid)——
      -- 完整理由與 #931 的已知代價都寫在 helper 的註解裡,那邊是唯一一份)。
      select r.match_count, r.member_id
      into v_match_count, v_matched_member_id
      from private.resolve_booking_member_by_phone(p_merchant_id, p_customer_phone) r;

      if v_match_count = 1 then
        -- 自動連結:不新增紀錄,而且**不改這位會員的任何欄位**(姓名/email/生日/updated_at 全不動)。
        -- 使用者裁決:「除了手機以外的資訊不是自己的,由會員自己修改」。
        -- 黑名單客戶照樣自動連結(既有規則是「建單時警告、不擋單」),警告由前端負責。
        v_effective_member_id := v_matched_member_id;
        v_member_auto_created := false;
      elsif v_match_count = 0 then
        -- 自動建立:完全複用既有的 public.create_member,不自己寫一份 insert
        -- (推薦碼產生、權限檢查、#931 的唯一性檢查全部沿用同一支函式,不會有第二套規則)。
        -- 生日/備註/推薦人/會員等級一律不帶:建單表單根本沒有生日欄位(規格書 §十一 Q4 裁決 (A):
        -- 生日之後在會員詳情頁補填,不在最常用的建單流程上多加欄位)。
        -- email 有填就帶進去(create_member 有 p_email);自動**連結**時則不動既有會員的 email。
        v_new_member := public.create_member(
          p_merchant_id,
          btrim(p_customer_name),
          btrim(p_customer_phone),
          nullif(btrim(coalesce(p_customer_email, '')), ''),
          null, null, null, null
        );
        v_effective_member_id := v_new_member.id;
        v_member_auto_created := true;
      else
        -- #914 後端防線。#931 之後新資料不會再出現這種情況,保留當舊資料的安全網。
        -- ⚠️ 訊息刻意不提「這支電話的新客戶」那顆按鈕 —— #931 已經把它整顆移除了。
        raise exception '這支電話底下有 % 位客戶,請先在建單畫面選擇這筆訂單是哪一位', v_match_count;
      end if;
    end if;
  end if;

  -- 既有的會員驗證(模組 10 §3.6),判斷對象從 p_member_id 改成 v_effective_member_id:
  --   ・呼叫端明確帶了 p_member_id ⇒ 行為與訊息跟以前**完全一樣**(找不到/不同商家/已下架就 raise);
  --   ・自動連結/自動建立 ⇒ 這裡是一道便宜的一致性複查(同商家、active),順便取出
  --     member_name_snapshot 要用的姓名(既有規則:取**會員資料表裡的**姓名,不是表單打的)。
  if v_effective_member_id is not null then
    select name into v_member_name
    from public.members
    where id = v_effective_member_id
      and merchant_id = p_merchant_id
      and status = 'active';

    if not found then
      raise exception '找不到指定的會員,或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null,
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
  -- 紅利系統重構 §3.3 第 1~3 步(批次 3):派點快照 + 人工覆寫 + 折抵驗證。
  -- 會員一律用 v_effective_member_id(自動連結/自動建立之後的會員,v2.3 對齊紀錄第 4 點);
  -- 派點由批次 2 的唯一計算引擎算,**跟 preview_booking_points 同一支、同一組輸入**
  -- (p_service_items 原樣、應付金額 = calculate_booking_amount 的 final_amount),
  -- 所以「預覽 N 點、建出來 M 點」不會發生(pgTAP 直接比對)。
  -- =====================================================================
  v_s := private.merchant_member_settings_effective(p_merchant_id);

  select * into v_points from private.compute_booking_planned_points(
    p_merchant_id,
    v_effective_member_id,
    p_service_items,
    v_amount.final_amount,
    p_custom_total_amount_enabled,
    p_discount_enabled,
    false
  );

  if p_points_override is not null then
    -- 第 4 題定案 A:只要 orders 鑰匙(上面 can_manage_bookings 已檢查),不另外要求 members/member_points。
    -- 第 13 題:0~100,000,不限制偏離建議值的倍數;points_planned_auto 照樣寫下來供事後稽核。
    if not coalesce(v_s.points_feature_enabled, true) then
      raise exception '紅利點數功能已關閉,無法設定派點';
    end if;
    v_planned := p_points_override;
    v_overridden := true;
  else
    v_planned := v_points.auto_points;
    v_overridden := false;
  end if;

  if v_redeem_points > 0 then
    -- 🔴 v2.4 裁決 22 ①:客服在畫面上確認的是「從某一位會員扣點」。伺服器依送出當下的電話決定的會員
    --    如果不是那一位(改了電話、預覽還沒更新就送出),一律擋下,不可以默默改扣另一個人的點數。
    -- (沒有會員的情況交給下面 validate_booking_redeem 回「這筆訂單沒有連結會員」那句更清楚的話。)
    if v_effective_member_id is not null
       and p_points_redeem_member_id is distinct from v_effective_member_id then
      raise exception '客戶已變更,紅利折抵已重設,請重新確認後送出';
    end if;

    -- 🔴 先鎖會員列、再讀餘額:兩張單同時對同一位會員折抵時,第二張會排隊等第一張交易結束,
    --    讀到的是扣過之後的餘額,不會兩張都以為「還有 100 點」而把點數用兩次(規則 2.3 for update)。
    --    這次才自動建立的會員餘額一定是 0,會自然被「只有 0 點」擋下。
    if v_effective_member_id is not null then
      select points_balance into v_member_balance
      from public.members
      where id = v_effective_member_id
      for update;
    end if;

    v_redeem_amount := private.validate_booking_redeem(
      p_merchant_id, v_effective_member_id, v_redeem_points, v_amount.final_amount, v_member_balance
    );
  end if;

  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;
  -- [req977-batch4 begin] SPECS-INDEX #977 第 4 批(2026-10-06,主腦裁決 ⑤):
  -- 主要服務人員開了「商家後台確認後直接接單」(merchant_staff.direct_accept_after_merchant_confirm)
  -- ⇒ 後台建的新訂單直接是 accepted(畫面「已確認」),操作紀錄 to_status 也寫 accepted;
  -- 關閉(預設)維持 pending_confirmation。只認同一間商家的那筆服務人員紀錄。
  -- 建單 LINE / 推播照舊只發「新訂單」事件(前端決定,這裡不發任何通知)。
  -- 這支函式其餘內容與 20261001040000 的定義逐字相同(指紋比對見 pgTAP req977_04)。
  v_initial_status := case
    when exists (
      select 1
      from public.merchant_staff ms
      where ms.id = p_staff_id
        and ms.merchant_id = p_merchant_id
        and ms.direct_accept_after_merchant_confirm
    ) then 'accepted'
    else 'pending_confirmation'
  end;
  -- [req977-batch4 end]

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method_id, payment_method_name_snapshot,
    custom_duration_enabled, custom_duration_minutes,
    member_id, member_name_snapshot,
    hide_notes_from_staff,
    member_auto_created,
    -- 紅利系統重構 §3.3 第 4 步。
    points_planned, points_planned_auto, points_planned_overridden, points_review_required,
    points_planned_breakdown, points_redeemed, points_redeem_amount_snapshot
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_sel.end_at,
    -- 🔴 customer_name 一律是**這次表單打的姓名**,不會被會員資料表的姓名覆蓋(#931 的完整語意:
    --    「同一支手機也可以用其他姓名新建訂單」)。source / created_by_role 也維持
    --    'manual' / 'admin'|'agent' 不動 —— 'customer' / 'smart' 是留給模組 13 與智慧建單的(#911)。
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), v_initial_status,
    coalesce(p_custom_total_amount_enabled, false), p_custom_total_amount, v_amount.subtotal_amount,
    coalesce(p_discount_enabled, false), p_discount_mode, p_discount_value, v_amount.discount_amount,
    coalesce(p_tax_enabled, false), p_tax_mode, p_tax_value, v_amount.tax_amount,
    -- 🔴 第 3 題定案 A / §2.11:final_amount_snapshot 是**折抵前**應付總額,不扣紅利折抵
    --    (抽成、報表營收、LINE {{final_amount}} 全部照舊讀它);折抵金額另存 points_redeem_amount_snapshot。
    v_amount.final_amount, p_payment_method_id, v_sel.payment_method_name,
    coalesce(p_custom_duration_enabled, false),
    case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    v_effective_member_id, v_member_name,
    -- SPECS-INDEX #852:coalesce 是為了「呼叫端明確傳 null 進來」的邊界(欄位是 not null),
    -- 不是為了容許漏帶 —— 漏帶時 default false 已經在簽章那一層生效了。
    coalesce(p_hide_notes_from_staff, false),
    -- SPECS-INDEX #911:只有「這次自動新建了一筆會員」才是 true。自動連結既有會員、
    -- 或呼叫端明確帶了 p_member_id,都是 false。
    v_member_auto_created,
    v_planned, v_points.auto_points, v_overridden, v_points.review_required,
    v_points.breakdown, v_redeem_points, v_redeem_amount
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    v_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select v_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select v_booking_id, mci.id, mci.amount
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  -- 紅利系統重構 §3.3 第 5 步:有折抵 ⇒ 分類帳 redeem_booking(−)+ 扣餘額。
  -- 跟訂單 insert 在同一個交易裡,任何一步失敗整筆回滾(不會「點數扣了、訂單沒建出來」或反過來)。
  if v_redeem_points > 0 then
    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
    ) values (
      v_effective_member_id, p_merchant_id, 'redeem_booking', -v_redeem_points,
      v_member_balance - v_redeem_points, v_booking_id,
      format('建單時使用紅利折抵 %s 點(折 NT$%s)', v_redeem_points, trim_scale(v_redeem_amount)),
      auth.uid()
    );

    update public.members
    set points_balance = v_member_balance - v_redeem_points
    where id = v_effective_member_id;
  end if;

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:建立訂單本身也算一筆操作記錄,
  -- from_status = null 代表「建立」這個動作。
  perform private.log_booking_status_change(v_booking_id, p_merchant_id, null, v_initial_status);

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$function$;

revoke execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean,
  integer, integer, uuid
) from public, anon;
grant execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean,
  integer, integer, uuid
) to authenticated, service_role;
