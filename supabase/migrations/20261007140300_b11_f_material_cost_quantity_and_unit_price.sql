-- =====================================================================
-- SPECS-INDEX #993(第 11 批 F):建單 / 編輯訂單的料錢成本改成「數量 − +」與「自訂成本單價」
-- 規格書:.project/specs/改掛會員與預設文案全形-第11批.md §十三
--
--   ① booking_material_costs 加 quantity(1~999,既有列 default 補 1,不寫 update)+ amount_snapshot ≥ 0;
--      amount_snapshot 語意改成「單價快照」(數值不變 ⇒ 既有訂單的料錢合計 / 抽成 / 報表數字完全不變)。
--      booking_service_items.quantity 一起加上限 999(F-1)。
--   ② 新 helper private.parse_booking_material_cost_items(jsonb):驗格式、抽出 (id, 數量, 單價)。不開放給前端。
--   ③ create_booking / update_booking / staff_create_booking / staff_update_booking:
--      p_material_cost_item_ids uuid[] → p_material_cost_items jsonb(同位置換掉;參數名不同 = 新簽章 ⇒ 先 drop 舊簽章)。
--      寫入:單價 = coalesce(前端 unit_price, 編輯時這張單的舊快照, 品項現價);數量 = 前端 quantity。
--      private.validate_booking_selection 不改(呼叫端用 helper 抽出 id 陣列再傳進去)。
--   ④ 讀取端 × 數量:calculate_booking_staff_commission、get_merchant_billing_summary(_by_range);
--      staff_get_booking_for_edit 多回 quantity。
-- 底稿 = 正式庫目前版本(md5(replace(prosrc,E'\r\n',E'\n')),2026-10-07 唯讀核對,A 上線後):
--   create_booking 4a1686f08d4323982141dad9dd1ba411、update_booking aad29e5465553b24dab12388108ba594、
--   staff_create_booking 92df8c6f0ac0a58297d3e0e37d72e3ac、staff_update_booking 07153f670327007bdc66cfbd30861c2c、
--   calculate_booking_staff_commission 0a46ab26a17bc373589b14d17173bbc2、
--   get_merchant_billing_summary 1f5d530740b9f4e16bbd0aeb720ce6d7、
--   get_merchant_billing_summary_by_range 4fa1f54e54e43c8a2c1a58ee1e1a0813、
--   staff_get_booking_for_edit 03252a1957899c218467e7be0d4d221e。
-- 🔴 參數改名後舊前端建單 / 改單會失敗 ⇒ migration 套完要立刻推前端(規格 §13.8 第 3 點)。
-- 編號 140300:正式庫已套到 140400(E),本支編號較小,本機用 --include-all 套。
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 寫入前的安全檢查(規格 §13.5 第 1 點):資料不符就整支停下,不自己改資料。
-- ---------------------------------------------------------------------
do $guard$
begin
  if exists (select 1 from public.booking_material_costs where amount_snapshot < 0) then
    raise exception 'b11-f 前置檢查失敗：booking_material_costs 有負數 amount_snapshot，請先回報主腦';
  end if;
  if exists (select 1 from public.booking_service_items where quantity > 999) then
    raise exception 'b11-f 前置檢查失敗：booking_service_items 有數量超過 999 的資料，請先回報主腦';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------
-- ① 欄位與 CHECK
-- ---------------------------------------------------------------------
alter table public.booking_material_costs
  add column quantity integer not null default 1;

alter table public.booking_material_costs
  add constraint booking_material_costs_quantity_range check (quantity between 1 and 999),
  add constraint booking_material_costs_amount_snapshot_non_negative check (amount_snapshot >= 0);

comment on column public.booking_material_costs.amount_snapshot is
  '單價快照(第 11 批 F #993 起;小計 = amount_snapshot × quantity)。新加的品項 = 自訂成本單價或品項現價;編輯時沒改單價的品項沿用原本的快照。';
comment on column public.booking_material_costs.quantity is
  '數量(第 11 批 F #993 新增,1~999;既有列補 1)。同一品項一筆訂單仍只能有一列(UNIQUE),多份用數量表達。';

alter table public.booking_service_items
  add constraint booking_service_items_quantity_max check (quantity <= 999);

-- ---------------------------------------------------------------------
-- ② 新 helper:驗料錢格式並拆成 (品項 id, 數量, 單價)
-- ---------------------------------------------------------------------
create or replace function private.parse_booking_material_cost_items(p jsonb)
returns table(material_cost_item_id uuid, quantity int, unit_price numeric)
language plpgsql
immutable
set search_path to 'public'
as $function$
declare
  v_elem jsonb;
  v_id uuid;
  v_qty_num numeric;
  v_price numeric;
  v_seen uuid[] := '{}'::uuid[];
begin
  -- null / JSON null / 空陣列 ⇒ 沒有料錢(空集合)。
  if p is null or jsonb_typeof(p) = 'null' then
    return;
  end if;
  if jsonb_typeof(p) <> 'array' then
    raise exception '料錢成本的格式不正確，必須是清單';
  end if;

  for v_elem in select e from jsonb_array_elements(p) as e loop
    if jsonb_typeof(v_elem) <> 'object' or (v_elem ->> 'material_cost_item_id') is null then
      raise exception '每個料錢成本品項都必須指定 material_cost_item_id';
    end if;
    begin
      v_id := (v_elem ->> 'material_cost_item_id')::uuid;
    exception when others then
      raise exception '料錢成本品項的編號格式不正確';
    end;

    -- 數量:必須是 JSON 數字、整數、1~999(字串 "3"、1.5、0、1000 一律擋)。
    if jsonb_typeof(v_elem -> 'quantity') is distinct from 'number' then
      raise exception '料錢成本的數量必須是 1 到 999 的整數';
    end if;
    v_qty_num := (v_elem ->> 'quantity')::numeric;
    if v_qty_num <> trunc(v_qty_num) or v_qty_num < 1 or v_qty_num > 999 then
      raise exception '料錢成本的數量必須是 1 到 999 的整數';
    end if;

    -- 單價:沒帶或 null ⇒ null(由呼叫端決定用舊快照或品項現價);有帶就必須是 0 ~ 99,999,999.99 的數字。
    if (v_elem -> 'unit_price') is null or jsonb_typeof(v_elem -> 'unit_price') = 'null' then
      v_price := null;
    elsif jsonb_typeof(v_elem -> 'unit_price') <> 'number' then
      raise exception '料錢成本的單價格式不正確，必須是數字';
    else
      v_price := (v_elem ->> 'unit_price')::numeric;
      if v_price < 0 or v_price > 99999999.99 then
        raise exception '料錢成本的單價不能是負數，也不能超過 99,999,999.99';
      end if;
    end if;

    if v_id = any(v_seen) then
      raise exception '同一個料錢成本品項不能在同一筆預約裡選取兩次';
    end if;
    v_seen := v_seen || v_id;

    material_cost_item_id := v_id;
    quantity := v_qty_num::int;
    unit_price := v_price;
    return next;
  end loop;
end;
$function$;

revoke execute on function private.parse_booking_material_cost_items(jsonb) from public, anon, authenticated, service_role;

comment on function private.parse_booking_material_cost_items(jsonb) is
  '第 11 批 F #993:驗證並拆開建單 / 改單的料錢參數 p_material_cost_items(jsonb 陣列,每項 {material_cost_item_id, quantity, unit_price | null})。null / [] ⇒ 空集合;不是陣列、缺 id、數量不是 1~999 整數、單價不是數字或 < 0 或 > 99,999,999.99、同一品項兩次 ⇒ raise 白話訊息。只給 create_booking / update_booking 內部呼叫,不開放給前端。';

-- ---------------------------------------------------------------------
-- ③ 四支換參數簽章:先 drop 舊簽章(完整型別),再建新的
-- ---------------------------------------------------------------------
drop function public.staff_create_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, uuid[]);
drop function public.staff_update_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, uuid[]);
drop function public.create_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid);
drop function public.update_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], uuid[], text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid);

CREATE OR REPLACE FUNCTION public.create_booking(p_merchant_id uuid, p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_assistant_staff_ids uuid[] DEFAULT '{}'::uuid[], p_material_cost_items jsonb DEFAULT '[]'::jsonb, p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_member_id uuid DEFAULT NULL::uuid, p_hide_notes_from_staff boolean DEFAULT false, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT 0, p_points_redeem_member_id uuid DEFAULT NULL::uuid)
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
  -- [b11-f begin] 第 11 批 F #993:料錢改成 {material_cost_item_id, quantity, unit_price} 陣列;
  --   這裡是從裡面抽出來的品項 id(交給既有的 validate_booking_selection 檢查開關 / 上架 / 同商家)。
  v_material_ids uuid[];
  -- [b11-f end]
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
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678)；市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456)，有分機的話用 # 接在後面(例如 02-1234-5678#123)';
  end if;

  -- 紅利系統重構 §3.3 第 2/3 步的「參數本身」檢查,放在任何寫入(含自動建立會員)之前:
  -- 數字明顯不合法時,不要先建了一位會員才報錯(雖然整筆會回滾,但錯誤越早越好懂)。
  if p_points_override is not null then
    if p_points_override < 0 then
      raise exception '派點數不能是負數';
    end if;
    if p_points_override > 100000 then
      raise exception '單筆訂單最多只能設定 100,000 點，請確認是否多打了零';
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
        raise exception '這支電話底下有 % 位客戶，請先在建單畫面選擇這筆訂單是哪一位', v_match_count;
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
      raise exception '找不到指定的會員，或會員不屬於這間商家/已被下架';
    end if;
  end if;

  -- [b11-f begin] 先驗料錢格式(數量 1~999 整數、單價 ≥ 0、不可重複),再抽出 id 交給既有檢查。
  select coalesce(array_agg(m.material_cost_item_id), '{}'::uuid[]) into v_material_ids
  from private.parse_booking_material_cost_items(p_material_cost_items) m;
  -- [b11-f end]

  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, v_material_ids, null,
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
      raise exception '紅利點數功能已關閉，無法設定派點';
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
      raise exception '客戶已變更，紅利折抵已重設，請重新確認後送出';
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

  -- [req977-batch7 begin] SPECS-INDEX #977 第 7 批(2026-10-07):服務人員本人透過 staff_create_booking 建的單,
  -- 建立者角色記成 'staff'(bookings_created_by_role_check 本批已放寬)。其餘情況維持原式。
  if private.is_staff_order_call(p_merchant_id) then
    v_created_by_role := 'staff';
  else
  -- [req977-batch7 end]
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;
  -- [req977-batch7 begin]
  end if;
  -- [req977-batch7 end]
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

  -- [b11-f begin] 第 11 批 F #993:每列存「數量」與「單價快照」(amount_snapshot = 單價,小計 = 單價 × 數量)。
  --   單價 = 前端送的自訂成本單價;沒送(null)= 品項現價。品項是否屬於這間商家已由 validate_booking_selection 擋過。
  if array_length(v_material_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, quantity, amount_snapshot)
    select v_booking_id, mci.id, m.quantity, coalesce(m.unit_price, mci.amount)
    from private.parse_booking_material_cost_items(p_material_cost_items) m
    join public.material_cost_items mci on mci.id = m.material_cost_item_id;
  end if;
  -- [b11-f end]

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

revoke all on function public.create_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid) from public, anon;
grant execute on function public.create_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid) to authenticated, service_role;
comment on function public.create_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, uuid) is
  '建立預約(模組 5/6/9/10 + #852 + #912 自動會員 + 紅利系統重構批次 3)。新增訂單時前端不帶 p_member_id,由電話自動連結/建立會員(private.resolve_booking_member_by_phone,與 preview_booking_points 同一支)。派點快照由 private.compute_booking_planned_points 計算(與預覽同一支引擎);p_points_override = 客服人工派點(0~100,000);p_points_redeemed = 折抵點數(建單當下就從會員餘額扣,分類帳 redeem_booking);p_points_redeem_member_id = 要扣誰的點數(折抵 > 0 時必帶且須等於伺服器決定的會員,v2.4 裁決 22 ①)。final_amount_snapshot 不扣折抵(第 3 題定案 A)。';

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
    -- [b11-f end]
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$function$;

revoke all on function public.update_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid) from public, anon;
grant execute on function public.update_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid) to authenticated, service_role;
comment on function public.update_booking(uuid, uuid, jsonb, timestamp with time zone, text, text, text, text, uuid[], jsonb, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean, integer, integer, boolean, uuid) is
  '編輯預約(模組 5/6/9/10 + #852 + 紅利系統重構批次 3)。p_member_id / p_hide_notes_from_staff 仍是無條件覆寫(前端一律帶值)。紅利:每次重算系統建議派點;p_points_override 有值 = 人工設定、null = 維持(已人工設定就保留客服數字);p_points_override_reset = 改用建議值;p_points_redeemed default null = 維持原折抵,有值才改。會員變更(含變空)而原本有折抵 ⇒ 先整筆退回給原會員。折抵與會員都沒變時,只有應付金額變動才重驗上限,原折抵超過新上限 ⇒ 擋下(v2.4 裁決 14)。原會員已下架時可維持連結、可調低或改 0、不可增加(v2.4 裁決 15)。p_points_redeemed > 0 時 p_points_redeem_member_id 必須等於 p_member_id(v2.4 裁決 22 ①)。';

CREATE OR REPLACE FUNCTION public.staff_create_booking(p_staff_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT 0, p_points_redeem_member_id uuid DEFAULT NULL::uuid, p_material_cost_items jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_b public.bookings;
begin
  if auth.uid() is null then
    raise exception '請先登入' using errcode = '42501';
  end if;
  -- 主要服務人員固定是自己(裁決 3):p_staff_id 必須是登入者本人那一列,而且可以自己下單。
  if not private.staff_order_self_ok(p_staff_id) then
    raise exception '沒有權限新增預約' using errcode = '42501';
  end if;

  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;

  perform set_config('miaoyue.staff_order_actor', p_staff_id::text, true);
  -- 協助人員一律空陣列(裁決 4)、料錢用前端傳的值(#986 第 9 批;null = 不帶)、會員一律 null(由 create_booking 依電話
  -- 自動連結 / 建立,跟後台新增模式一樣)、內部備註一律「服務人員看得到」。
  -- 狀態由 create_booking 既有的第 4 批邏輯決定(商家後台確認後直接接單 ⇒ accepted,否則 pending_confirmation)。
  -- [req986-batch9 begin] #986 第 9 批(9-1):料錢品項是否屬於這間商家、是否上架、總開關是否開著、不可重複,
  --   全部交給 create_booking → private.validate_booking_selection 既有檢查(不寫第二套)。
  -- [req986-batch9 end]
  v_b := public.create_booking(
    p_merchant_id => v_merchant_id,
    p_staff_id => p_staff_id,
    p_service_items => p_service_items,
    p_start_at => p_start_at,
    p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone,
    p_customer_email => p_customer_email,
    p_notes => p_notes,
    p_assistant_staff_ids => '{}'::uuid[],
    p_material_cost_items => coalesce(p_material_cost_items, '[]'::jsonb),
    p_customer_address => p_customer_address,
    p_customer_notes => p_customer_notes,
    p_custom_total_amount_enabled => p_custom_total_amount_enabled,
    p_custom_total_amount => p_custom_total_amount,
    p_discount_enabled => p_discount_enabled,
    p_discount_mode => p_discount_mode,
    p_discount_value => p_discount_value,
    p_tax_enabled => p_tax_enabled,
    p_tax_mode => p_tax_mode,
    p_tax_value => p_tax_value,
    p_payment_method_id => p_payment_method_id,
    p_custom_duration_enabled => p_custom_duration_enabled,
    p_custom_duration_minutes => p_custom_duration_minutes,
    p_member_id => null,
    p_hide_notes_from_staff => false,
    p_points_override => p_points_override,
    p_points_redeemed => p_points_redeemed,
    p_points_redeem_member_id => p_points_redeem_member_id
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  -- 只回建單成功提示(buildBookingCreatedToast)需要的欄位,不回整列。
  return jsonb_build_object(
    'id', v_b.id,
    'merchant_id', v_b.merchant_id,
    'status', v_b.status,
    'member_id', v_b.member_id,
    'member_name_snapshot', v_b.member_name_snapshot,
    'member_auto_created', v_b.member_auto_created,
    'final_amount_snapshot', v_b.final_amount_snapshot,
    'points_planned', v_b.points_planned,
    'points_redeemed', v_b.points_redeemed,
    'points_redeem_amount_snapshot', v_b.points_redeem_amount_snapshot
  );
end;
$function$;

revoke all on function public.staff_create_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, jsonb) from public, anon;
grant execute on function public.staff_create_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, jsonb) to authenticated, service_role;
comment on function public.staff_create_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, uuid, jsonb) is
  'SPECS-INDEX #977 第 7 批 / #986 第 9 批 / 第 11 批 F #993:服務人員本人(可以自己下單者)建自己的單。沒有商家 / 其他服務人員 / 協助人員 / 會員 / 隱藏備註參數;料錢 p_material_cost_items(jsonb 陣列,每項 {material_cost_item_id, quantity 1~999, unit_price 自訂成本單價或 null = 品項現價};null = 不帶),格式由 private.parse_booking_material_cost_items 驗證,其餘檢查沿用 validate_booking_selection。內部呼叫 create_booking(created_by_role = staff)。只回傳成功提示需要的欄位。';

CREATE OR REPLACE FUNCTION public.staff_update_booking(p_booking_id uuid, p_service_items jsonb, p_start_at timestamp with time zone, p_customer_name text, p_customer_phone text, p_customer_email text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_customer_address text DEFAULT NULL::text, p_customer_notes text DEFAULT NULL::text, p_custom_total_amount_enabled boolean DEFAULT false, p_custom_total_amount numeric DEFAULT NULL::numeric, p_discount_enabled boolean DEFAULT false, p_discount_mode text DEFAULT NULL::text, p_discount_value numeric DEFAULT NULL::numeric, p_tax_enabled boolean DEFAULT false, p_tax_mode text DEFAULT NULL::text, p_tax_value numeric DEFAULT NULL::numeric, p_payment_method_id uuid DEFAULT NULL::uuid, p_custom_duration_enabled boolean DEFAULT false, p_custom_duration_minutes integer DEFAULT NULL::integer, p_points_override integer DEFAULT NULL::integer, p_points_redeemed integer DEFAULT NULL::integer, p_points_override_reset boolean DEFAULT false, p_points_redeem_member_id uuid DEFAULT NULL::uuid, p_material_cost_items jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner public.bookings;
  v_cur public.bookings;
  v_assistants uuid[];
  v_materials jsonb;
  v_b public.bookings;
begin
  v_owner := private.staff_order_own_booking(p_booking_id, '編輯這筆訂單');

  -- 已確認是自己的單 ⇒ 鎖自己的單,防「客服同時改了協助人員 / 換了主要服務人員」。
  select * into v_cur
  from public.bookings b
  where b.id = p_booking_id and b.staff_id = v_owner.staff_id
  for update;
  if not found then
    raise exception '這筆訂單的服務人員已變更，請重新整理' using errcode = '42501';
  end if;

  -- 裁決 4:既有協助人員原樣保留(不接受前端傳)。
  select coalesce(array_agg(ba.staff_id order by ba.staff_id), '{}'::uuid[]) into v_assistants
  from public.booking_assistants ba
  where ba.booking_id = p_booking_id;

  -- 主腦決定 C:料錢保留原值(update_booking 對既有品項沿用原本的金額快照)。
  -- [b11-f begin] 第 11 批 F #993:連同數量、單價一起保留 —— 以這張單現有的 quantity 與 amount_snapshot(= 單價)
  --   組成跟前端同格式的 jsonb,不送 null 單價(避免改用品項現價)。
  select coalesce(
           jsonb_agg(jsonb_build_object(
             'material_cost_item_id', bmc.material_cost_item_id,
             'quantity', bmc.quantity,
             'unit_price', bmc.amount_snapshot
           ) order by bmc.material_cost_item_id),
           '[]'::jsonb)
  into v_materials
  from public.booking_material_costs bmc
  where bmc.booking_id = p_booking_id;
  -- [b11-f end]

  -- [req986-batch9 begin] #986 第 9 批(9-2):前端有帶料錢(非 null;空陣列 = 全部拿掉)⇒ 用前端的值;
  --   null ⇒ 維持這張單現有料錢(= 第 7 批行為,舊前端照樣可用)。
  --   檢查全部交給 update_booking → private.validate_booking_selection(第 8 批:這張單原本就有的品項
  --   不被下架 / 總開關擋,新加的照舊檢查)。不寫第二套。
  if p_material_cost_items is not null then
    v_materials := p_material_cost_items;
  end if;
  -- [req986-batch9 end]
  perform set_config('miaoyue.staff_order_actor', v_cur.staff_id::text, true);
  v_b := public.update_booking(
    p_booking_id => p_booking_id,
    p_staff_id => v_cur.staff_id,
    p_service_items => p_service_items,
    p_start_at => p_start_at,
    p_customer_name => p_customer_name,
    p_customer_phone => p_customer_phone,
    p_customer_email => p_customer_email,
    -- 內部備註被藏起來時,服務人員看不到原文,前端送什麼都不採用 ⇒ 用現值(不然會被清空)。
    p_notes => case when v_cur.hide_notes_from_staff then v_cur.notes else p_notes end,
    p_assistant_staff_ids => v_assistants,
    p_material_cost_items => v_materials,
    p_customer_address => p_customer_address,
    p_customer_notes => p_customer_notes,
    p_custom_total_amount_enabled => p_custom_total_amount_enabled,
    p_custom_total_amount => p_custom_total_amount,
    p_discount_enabled => p_discount_enabled,
    p_discount_mode => p_discount_mode,
    p_discount_value => p_discount_value,
    p_tax_enabled => p_tax_enabled,
    p_tax_mode => p_tax_mode,
    p_tax_value => p_tax_value,
    p_payment_method_id => p_payment_method_id,
    p_custom_duration_enabled => p_custom_duration_enabled,
    p_custom_duration_minutes => p_custom_duration_minutes,
    -- 會員維持現值(服務人員不能補掛 / 換會員);隱藏備註旗標維持現值。
    p_member_id => v_cur.member_id,
    p_hide_notes_from_staff => v_cur.hide_notes_from_staff,
    p_points_override => p_points_override,
    p_points_redeemed => p_points_redeemed,
    p_points_override_reset => p_points_override_reset,
    p_points_redeem_member_id => p_points_redeem_member_id
  );
  perform set_config('miaoyue.staff_order_actor', '', true);

  return jsonb_build_object(
    'id', v_b.id,
    'merchant_id', v_b.merchant_id,
    'status', v_b.status,
    'start_at', v_b.start_at,
    'staff_id', v_b.staff_id
  );
end;
$function$;

revoke all on function public.staff_update_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, jsonb) from public, anon;
grant execute on function public.staff_update_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, jsonb) to authenticated, service_role;
comment on function public.staff_update_booking(uuid, jsonb, timestamp with time zone, text, text, text, text, text, text, boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, integer, integer, boolean, uuid, jsonb) is
  'SPECS-INDEX #977 第 7 批 / #986 第 9 批:主要服務人員本人(可以自己下單者)編輯自己的單。主要服務人員、協助人員、會員、隱藏備註旗標一律保留現值;內部備註被藏起來時保留原文。料錢 p_material_cost_items(第 11 批 F #993 起為 jsonb 陣列,每項 {material_cost_item_id, quantity, unit_price}):null = 維持現有料錢(連同數量、單價快照),非 null(含空陣列)= 用前端的值,格式由 private.parse_booking_material_cost_items 驗證,其餘檢查沿用 validate_booking_selection。內部呼叫 update_booking。#939 第 11 批 A:服務人員不能挑選 / 補掛會員,但改了電話時 update_booking 會依新電話自動改掛(找不到就自動建立新會員,跟服務人員自己建單同一套規則),紅利依新會員重算。';

-- ---------------------------------------------------------------------
-- ④ 讀取端 × 數量(簽章不變,create or replace;權限與註解不受影響)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.calculate_booking_staff_commission(p_booking_id uuid, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_merchant_id uuid;
  v_subtotal numeric(10, 2);
  v_discount numeric(10, 2);
  v_basis_type text;
  v_material_cost_total numeric(10, 2) := 0;
  v_raw_total numeric(10, 2) := 0;
  v_item_count int := 0;
  v_items jsonb := '[]'::jsonb;
  v_total_commission_amount numeric(10, 2) := 0;
  v_total_commission_base_amount numeric(10, 2) := 0;
  rec record;
  v_ratio numeric;
  v_effective_subtotal numeric(10, 2);
  v_discount_share numeric(10, 2);
  v_material_cost_share numeric(10, 2);
  v_commission_base numeric(10, 2);
  v_commission_mode text;
  v_commission_value numeric(10, 2);
  v_commission_amount numeric(10, 2);
  v_output_base numeric(10, 2);
begin
  select merchant_id, subtotal_amount_snapshot, discount_amount_snapshot
  into v_merchant_id, v_subtotal, v_discount
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  select commission_basis_type into v_basis_type
  from public.merchant_payroll_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_basis_type := 'gross';
  end if;

  if v_basis_type = 'net_of_material_cost' then
    -- 第 11 批 F #993:amount_snapshot 是「單價」,扣除料錢 = Σ 單價 × 數量。
    select coalesce(sum(amount_snapshot * quantity), 0) into v_material_cost_total
    from public.booking_material_costs
    where booking_id = p_booking_id;
  else
    v_material_cost_total := 0;
  end if;

  select count(*), coalesce(sum(bsi.unit_price_snapshot * bsi.quantity), 0)
  into v_item_count, v_raw_total
  from public.booking_service_items bsi
  where bsi.booking_id = p_booking_id;

  for rec in
    select bsi.id as booking_service_item_id, bsi.service_item_id, bsi.quantity,
           bsi.unit_price_snapshot, si.name as service_item_name
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = p_booking_id
    order by bsi.created_at
  loop
    if v_raw_total > 0 then
      v_ratio := (rec.unit_price_snapshot * rec.quantity) / v_raw_total;
    else
      v_ratio := 1.0 / greatest(v_item_count, 1);
    end if;

    v_effective_subtotal := coalesce(v_subtotal, 0) * v_ratio;
    v_discount_share := coalesce(v_discount, 0) * v_ratio;
    v_material_cost_share := v_material_cost_total * v_ratio;
    v_commission_base := greatest(v_effective_subtotal - v_discount_share - v_material_cost_share, 0);

    select ssc.commission_mode, ssc.commission_value
    into v_commission_mode, v_commission_value
    from public.staff_service_commission_rates ssc
    where ssc.staff_id = p_staff_id and ssc.service_item_id = rec.service_item_id;

    if not found then
      v_commission_mode := 'percentage';
      v_commission_value := 0;
    end if;

    if v_commission_mode = 'percentage' then
      v_commission_amount := round(v_commission_base * v_commission_value / 100, 2);
      v_output_base := round(v_commission_base, 2);
    else
      v_commission_amount := round(v_commission_value * rec.quantity, 2);
      v_output_base := 0;
    end if;

    v_total_commission_amount := v_total_commission_amount + v_commission_amount;
    v_total_commission_base_amount := v_total_commission_base_amount + v_output_base;

    v_items := v_items || jsonb_build_object(
      'booking_service_item_id', rec.booking_service_item_id,
      'service_item_id', rec.service_item_id,
      'service_item_name', rec.service_item_name,
      'quantity', rec.quantity,
      'commission_mode', v_commission_mode,
      'commission_value', v_commission_value,
      'commission_base_amount', v_output_base,
      'commission_amount', v_commission_amount
    );
  end loop;

  return jsonb_build_object(
    'items', v_items,
    'commission_basis_type', v_basis_type,
    'total_commission_amount', round(v_total_commission_amount, 2),
    'total_commission_base_amount', round(v_total_commission_base_amount, 2),
    'total_material_cost_deducted', round(v_material_cost_total, 2)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary(p_merchant_id uuid, p_year integer, p_month integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_month_start date;
  v_next_month_start date;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_as_of timestamptz;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  v_month_start := make_date(p_year, p_month, 1);
  v_next_month_start := v_month_start + interval '1 month';
  v_range_start := v_month_start::timestamp at time zone 'Asia/Taipei';
  v_range_end := v_next_month_start::timestamp at time zone 'Asia/Taipei';
  -- 該年月最後一天結束前的那一刻(Asia/Taipei),比照 11.7 compute_staff_payroll 的邊界寫法。
  v_as_of := v_range_end - interval '1 microsecond';

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  --
  -- 2026-09-24(任務 1,使用者裁決「都已完成時間做依據」「完成代表收到錢」):月份基準從
  -- b.start_at(預約發生的時間)改成「完成時間」coalesce(b.completed_at, b.start_at)。
  -- coalesce 的 fallback 只會對「直接 INSERT 出來、沒走 complete_booking 的歷史匯入訂單」
  -- 生效(§2 已回填既有的 14 筆,20260924040100 已修掉根因,這裡是防禦性保留,理由見檔頭)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

  -- 第 11 批 F #993:amount_snapshot 是「單價」,料錢合計 = Σ 單價 × 數量。
  select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持用 bcr.computed_at:已查證它跟該訂單的 completed_at 完全相等(25/25 筆,
  -- max_diff 0.000000 秒),而且 recalculate_booking_commission 不會改動 computed_at
  -- (只改 recalculated_at),所以這已經就是「完成時間」,改成 join bookings 只會白白
  -- 失去 booking_commission_records_merchant_id_computed_at_idx 這個既有索引。詳見檔頭。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8:total_monthly_salary_base 呼叫 private.get_merchant_monthly_salary_base_as_of(11.6)。
  select total_amount, is_estimated
  into v_total_salary_base, v_salary_estimated
  from private.get_merchant_monthly_salary_base_as_of(p_merchant_id, v_as_of);

  -- 2026-09-24(任務 2,使用者裁決「即便這個人離職,紀錄還是存在」):母體從
  -- `where ms.status = 'active'`(現在的狀態)改成「該月月底當時 existed 且 status=active」
  -- ——跟上面 11.6 算基本額用的是同一個 v_as_of、同一組條件,兩邊母體從此必然一致。
  -- ⚠️ 這推翻 §11.9「per_staff_breakdown 維持目前在職名單」的決策記錄,以使用者裁決為準。
  -- compensation_type 也取「那個時間點」的值,不是現在的值(同一個人可能中途改過計酬類型)。
  --
  -- is_active_as_of(2026-09-24 主腦裁決追加):讓前端知道要不要在這一列旁邊顯示「已離職」標籤。
  -- ⚠️ 語意說明(這個欄位名跟它實際的意思有落差,已在回報中提出可改名,讀到這裡請以本註解為準):
  --    它的值是「這個人**目前**是否仍在職」(ms.status = 'active',查詢執行當下的狀態),
  --    **不是**「在 v_as_of 那個時間點是否在職」。
  --    原因:這支函式的母體條件已經是「該月月底當時 existed 且 status=active」,所以「在 as_of
  --    那一刻是否在職」對每一列**恆為 true**,當成旗標毫無資訊量。真正驅動「已離職」標籤的判斷
  --    是「這個人已經離開了,所以你在這張 9 月報表上看到一個現在名單裡沒有的人」——那必須看
  --    目前狀態。若主腦要改名,建議 is_currently_active。
  for rec in
    select ms.id, ms.name, s.compensation_type, (ms.status = 'active') as is_currently_active
    from public.merchant_staff ms
    join lateral private.get_staff_payroll_status_as_of(ms.id, v_as_of) s on true
    where ms.merchant_id = p_merchant_id
      and s.existed
      and s.status = 'active'
    order by ms.name
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      v_payroll := private.compute_staff_payroll(rec.id, p_year, p_month);
      v_total_salary_deduction := v_total_salary_deduction
        + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', v_payroll -> 'net_pay',
        'commission_amount', null
      );
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin',
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction),
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    -- 任務 3:按年月查詢本質上就是一個完整月份,固定 true(加上這個欄位只是為了讓兩支
    -- 函式的回傳形狀一致,前端不用分兩套處理)。
    'salary_applicable', true,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary_by_range(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_salary_applicable boolean;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_estimated_net_margin numeric(10, 2);
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC
  -- 查詢過大區間造成效能問題或撈出超出預期範圍的資料。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- =======================================================================
  -- 任務 3(使用者已回覆「可以」):月薪相關數字只在「完整月份」的查詢下才計算。
  -- 條件:起始日是某個月的 1 號,且結束日是某個月的最後一天(可以跨多個月,2/1–4/30 合法)。
  --   ・p_start_date 是 1 號          → date_trunc('month', p_start_date) = p_start_date
  --   ・p_end_date 是該月最後一天     → p_end_date + 1 天之後就會跨到下個月的 1 號
  -- 這同時消滅一個真的 bug:原本不論區間頭尾是不是完整月份,都用 generate_series 以「月初」
  -- 為單位展開,所以「查 2/15–3/15(29 天)」會收到 2 個整月的月薪基本額,而扣款那一邊
  -- (compute_staff_payroll_by_range)卻是按區間裁切的 → 兩邊口徑不一致,月薪實發沒有意義。
  -- =======================================================================
  v_salary_applicable := (
    p_start_date = date_trunc('month', p_start_date)::date
    and (p_end_date + 1) = date_trunc('month', (p_end_date + 1)::date)::date
  );

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  -- 2026-09-24(任務 1):月份/區間基準從 b.start_at 改成完成時間(理由見檔頭與 §3 的註解)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

  -- 第 11 批 F #993:amount_snapshot 是「單價」,料錢合計 = Σ 單價 × 數量。
  select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持 computed_at(已查證 ≡ completed_at,且事後重算不改它,詳見檔頭)。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8(核心):比照 11.7 的「逐月迴圈」邏輯,對區間內每個月份呼叫 11.6,把每個月份的加總
  -- 結果再加總。只要任一月份任一人用到估算,salary_estimation_applied 就是 true。
  -- 2026-09-24(任務 3):只在 v_salary_applicable 為真時才算;不是完整月份時一律留 null
  -- (不是 0——前端要能分辨「不適用」與「真的是零」)。
  if v_salary_applicable then
    select
      coalesce(sum(gm.total_amount), 0),
      coalesce(bool_or(gm.is_estimated), false)
    into v_total_salary_base, v_salary_estimated
    from generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start)
    cross join lateral private.get_merchant_monthly_salary_base_as_of(
      p_merchant_id,
      ((least((m.month_start + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
        at time zone 'Asia/Taipei') - interval '1 microsecond'
    ) as gm;
  else
    v_total_salary_base := null;
    v_total_salary_deduction := null;
    v_salary_estimated := false;
  end if;

  -- 2026-09-24(任務 2):母體改成「區間內至少有一個月份,在該月的 as_of 時間點 existed 且
  -- status=active」的人——跟上面 11.6 逐月加總用的是同一套 as_of 算式(含 least(..., p_end_date)
  -- 的裁切)與同一組條件,兩邊母體必然一致。compensation_type 取「區間內最後一個當時在職月份」
  -- 的值(同一個人可能中途改過計酬類型;取最後一個月份跟 §11 一貫的「月底當下的值」慣例一致)。
  -- 這同時修掉一個附帶的對不起來:已離職的按件計酬人員,他的抽成一直都被算進
  -- total_commission_payout(那個查詢只看 merchant_id + computed_at,不看人員狀態),卻沒有
  -- 任何一列明細承載它。
  for rec in
    with months as (
      select
        gs::date as month_start,
        ((least((gs + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
          at time zone 'Asia/Taipei') - interval '1 microsecond' as as_of
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    staff_months as (
      select
        ms.id, ms.name, m.month_start, s.compensation_type,
        -- is_active_as_of 的來源:merchant_staff.status 是「目前」的狀態(語意說明見單月版註解)。
        (ms.status = 'active') as is_currently_active
      from public.merchant_staff ms
      cross join months m
      join lateral private.get_staff_payroll_status_as_of(ms.id, m.as_of) s on true
      where ms.merchant_id = p_merchant_id
        and s.existed
        and s.status = 'active'
    )
    select
      id,
      name,
      is_currently_active,
      (array_agg(compensation_type order by month_start desc))[1] as compensation_type
    from staff_months
    -- is_currently_active 對同一個 id 只有一個值(它來自 merchant_staff 那一列),放進 group by
    -- 只是為了讓它能被 select,不會讓分組變細。
    group by id, name, is_currently_active
    order by name
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      if v_salary_applicable then
        -- §3.6:跨月時依區間內實際涵蓋的每個月份分別計算「當月實際天數」再加總,不是整個區間套用
        -- 同一個天數——private.compute_staff_payroll_by_range 內部已經處理這個邏輯。
        v_payroll := private.compute_staff_payroll_by_range(rec.id, p_start_date, p_end_date);
        v_total_salary_deduction := v_total_salary_deduction
          + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', v_payroll -> 'net_pay',
          'commission_amount', null
        );
      else
        -- 任務 3:不是完整月份時,月薪制人員照樣列在明細上(order_count 仍然有意義),
        -- 但 net_pay 回 null,代表「這個區間算不出月薪實發」,不是「實發 0 元」。
        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', null,
          'commission_amount', null
        );
      end if;
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission
      );
    end if;
  end loop;

  -- 任務 3:商家總淨利(概估毛利)是「營收 − 料錢 − 抽成 − 月薪實發」,只要月薪那一段算不出來,
  -- 整個數字就沒有意義 → 一律 null,不是拿營收減一減硬湊一個數字出來給商家看。
  if v_salary_applicable then
    v_estimated_net_margin :=
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction);
  else
    v_estimated_net_margin := null;
  end if;

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin', v_estimated_net_margin,
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    'salary_applicable', v_salary_applicable,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_get_booking_for_edit(p_booking_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b public.bookings;
begin
  v_b := private.staff_order_own_booking(p_booking_id, '編輯這筆訂單');

  if v_b.status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能編輯，請重新整理';
  end if;

  return jsonb_build_object(
    'id', v_b.id,
    'merchant_id', v_b.merchant_id,
    'staff_id', v_b.staff_id,
    'status', v_b.status,
    'start_at', v_b.start_at,
    'end_at', v_b.end_at,
    'customer_name', v_b.customer_name,
    'customer_phone', v_b.customer_phone,
    'customer_email', v_b.customer_email,
    'customer_address', v_b.customer_address,
    'customer_notes', v_b.customer_notes,
    -- 內部備註被設成「不讓服務人員看到」⇒ 不回原文,只回 notes_hidden(前端據此不顯示內部備註欄)。
    'notes', case when v_b.hide_notes_from_staff then null else v_b.notes end,
    'notes_hidden', v_b.hide_notes_from_staff,
    'custom_total_amount_enabled', v_b.custom_total_amount_enabled,
    'custom_total_amount', v_b.custom_total_amount,
    'discount_enabled', v_b.discount_enabled,
    'discount_mode', v_b.discount_mode,
    'discount_value', v_b.discount_value,
    'tax_enabled', v_b.tax_enabled,
    'tax_mode_snapshot', v_b.tax_mode_snapshot,
    'tax_value_snapshot', v_b.tax_value_snapshot,
    'payment_method_id', v_b.payment_method_id,
    'payment_method_name_snapshot', v_b.payment_method_name_snapshot,
    'custom_duration_enabled', v_b.custom_duration_enabled,
    'custom_duration_minutes', v_b.custom_duration_minutes,
    'member_id', v_b.member_id,
    'member_name_snapshot', v_b.member_name_snapshot,
    'points_planned', v_b.points_planned,
    'points_planned_auto', v_b.points_planned_auto,
    'points_planned_overridden', v_b.points_planned_overridden,
    'points_redeemed', v_b.points_redeemed,
    'points_redeem_amount_snapshot', v_b.points_redeem_amount_snapshot,
    'service_items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'service_item_id', bsi.service_item_id,
        'name', coalesce(si.name, '(已刪除的服務項目)'),
        'quantity', bsi.quantity,
        'unit_price_snapshot', bsi.unit_price_snapshot
      ) order by bsi.id)
      from public.booking_service_items bsi
      left join public.service_items si on si.id = bsi.service_item_id
      where bsi.booking_id = v_b.id
    ), '[]'::jsonb),
    -- 協助人員只回姓名(唯讀顯示「由商家指派」),不回 id。
    'assistant_names', coalesce((
      select jsonb_agg(coalesce(ms.name, '(已刪除的人員)') order by ms.name)
      from public.booking_assistants ba
      left join public.merchant_staff ms on ms.id = ba.staff_id
      where ba.booking_id = v_b.id
    ), '[]'::jsonb)
    -- [req986-batch9 begin] #986 第 9 批(9-2):這張單目前的料錢。name 取品項目前名稱(已刪除 ⇒ 固定字);
    --   is_active = 品項仍上架。金額一律回訂單上的快照 amount_snapshot。
    , 'material_costs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'material_cost_item_id', bmc.material_cost_item_id,
        'name', coalesce(mci.name, '(已刪除的料錢品項)'),
        'amount_snapshot', bmc.amount_snapshot,
        -- 第 11 批 F #993:數量(amount_snapshot 是單價,小計 = 單價 × 數量)。
        'quantity', bmc.quantity,
        'is_active', coalesce(mci.status = 'active', false)
      ) order by bmc.created_at, bmc.id)
      from public.booking_material_costs bmc
      left join public.material_cost_items mci on mci.id = bmc.material_cost_item_id
      where bmc.booking_id = v_b.id
    ), '[]'::jsonb)
    -- [req986-batch9 end]
  );
end;
$function$;
