-- 紅利系統重構 批次 3:建單 / 改單 / 取消疊加派點快照、人工覆寫、點數折抵(凍結)與退回。
-- 對應規格書 .project/specs/紅利系統重構.md(v2.3 + 檔尾 v2.4 主腦裁決)§八 批次 3:
--   §3.3  create_booking 第 26/27 個參數 p_points_override / p_points_redeemed;
--         #912 的「依電話找會員」那一句改呼叫 private.resolve_booking_member_by_phone(批次 2 已建)
--   §3.4  update_booking 第 26/27/28 個參數 p_points_override / p_points_redeemed(default null = 維持)/
--         p_points_override_reset;金額調低後原折抵超過新上限要擋(§〇.4 判斷 21)
--   §3.11.1 private.refund_booking_redeem + cancel_booking 疊加一行
--   v2.4 裁決 4/5:會員變更(含變空、含呼叫端沒帶 p_member_id)而原本有折抵 ⇒ 先退回原折抵;
--                 已下架會員的舊單改單規則(見 update_booking 內「已下架會員」註解)
--   v2.4 裁決 14:折抵與會員都沒變時,只有應付金額變動才重驗折抵上限(只改時間/服務人員不重驗)
--   v2.4 裁決 15:已下架會員的舊單可以維持、調低或改 0 折抵,不可增加
--   v2.4 裁決 22 ①(批次 7 QA 打回,2026-10-01):兩支都多一個參數 p_points_redeem_member_id
--                 (create_booking 第 28 個、update_booking 第 29 個)= 「客服在畫面上看到、要扣誰的點數」。
--                 折抵 > 0 時必帶,而且必須等於伺服器實際決定的會員,不符就擋下。防的是「改電話後立刻送出,
--                 前端還帶著上一位會員的折抵點數,後端依新電話對到另一位會員、餘額又夠 ⇒ 扣錯人」。
--                 (這支 migration 尚未上線,依主腦裁決直接改簽章,不另開 migration。)
--   v2.4 裁決 8/12:派點/折抵一律用批次 2 的 compute_booking_planned_points /
--                 redeem_points_to_amount / compute_booking_redeem_limits,不另寫算式;
--                 驗證比的是「點數 ≤ 可用點數 且 換算金額 ≤ cap_amount」,max_points 不是硬上限;
--                 換算為 0 元的點數擋下。
--
-- 【動工前指紋核對】2026-10-01 對正式庫 wjtbmmnakcriuaqoknsq(唯讀)查
--   md5(replace(prosrc, E'\r\n', E'\n')) / 長度,與規格書 §〇.1b 一致,本機 db reset 後也相同:
--   public.create_booking(25 參數)   b9da6db2d4dce942255be007e161db59 / 9633
--   public.update_booking(25 參數)   e97f02778781d1b1a6d83801e42d80ce / 6360
--   public.cancel_booking(uuid, text) 54c7cadf8c736cefa6f8bfd9eef11ed1 / 939
--   private.calculate_booking_amount  605f707d1635f95bd686fa930dd080bf / 1355(只呼叫)
--   三支 public 函式正式庫 ACL 都是 {postgres, authenticated, service_role}(沒有 PUBLIC / anon)。
--   本支 migration 的函式主體以正式庫 pg_get_functiondef 為底疊加,不是從舊 migration 複製。
--
-- 【對既有呼叫端的影響】
--   ・create_booking / update_booking 換簽章(drop 舊版 → 建新版),新參數全部排在最後且有安全預設:
--     不帶新參數的呼叫 = 自動派點(寫快照)、不折抵、改單時維持原折抵與原人工覆寫。
--   ・cancel_booking 簽章不變(create or replace,權限不會被重設)。

-- =========================================================================
-- 1. §3.11.1 private.refund_booking_redeem(退回本單折抵凍結;給 cancel_booking、update_booking、#844)
-- =========================================================================
create or replace function private.refund_booking_redeem(p_booking_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_row record;
  v_balance integer;
  v_total integer := 0;
begin
  -- 先鎖訂單列:同一張單的「退回 / 重新折抵」全部排隊,淨額在鎖之後才算,重複呼叫(或兩個人
  -- 同時按取消)第二次一定看到淨額 0 ⇒ 什麼都不寫(冪等)。鎖的順序一律「訂單 → 會員」,
  -- 跟 update_booking / cancel_booking 一致,不會互相死鎖。
  select b.merchant_id, b.status into v_merchant_id, v_status
  from public.bookings b
  where b.id = p_booking_id
  for update;

  if not found then
    return 0;
  end if;

  -- 「目前有效凍結」= −Σ(redeem_booking + redeem_booking_refund 的 points_delta)(§1.5 淨額定義)。
  -- 依分類帳上「當初被扣點的那位會員」分組退回 —— 退給被扣的人,不是退給 bookings.member_id
  -- 目前指向的人(改單時兩者可能不同)。
  -- **不看 points_feature_enabled、也不看會員 status**(§3.11.2 統一對照:「收回 / 退回」一律不看
  -- 狀態、不看開關 —— 那是客人自己的點數)。
  for v_row in
    select t.member_id, (-sum(t.points_delta))::int as frozen
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.transaction_type in ('redeem_booking', 'redeem_booking_refund')
    group by t.member_id
    having -sum(t.points_delta) > 0
    order by t.member_id
  loop
    -- update 本身就會鎖會員列;加回之後餘額一定 >= 0,不會碰到兩道「不可為負」的 CHECK。
    update public.members
    set points_balance = points_balance + v_row.frozen
    where id = v_row.member_id
    returning points_balance into v_balance;

    if not found then
      continue;  -- 會員已被硬刪(分類帳會跟著 cascade 消失,理論上到不了)
    end if;

    insert into public.member_point_transactions (
      member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id, note, created_by_user_id
    ) values (
      v_row.member_id, v_merchant_id, 'redeem_booking_refund', v_row.frozen, v_balance, p_booking_id,
      case when v_status = 'cancelled'
           then format('訂單取消,退回紅利折抵 %s 點', v_row.frozen)
           else format('訂單編輯變更了會員或折抵點數,先退回原本的紅利折抵 %s 點', v_row.frozen)
      end,
      auth.uid()
    );

    v_total := v_total + v_row.frozen;
  end loop;

  if v_total > 0 then
    update public.bookings
    set points_redeemed = 0,
        points_redeem_amount_snapshot = 0
    where id = p_booking_id;
  end if;

  return v_total;
end;
$$;

comment on function private.refund_booking_redeem(uuid) is '紅利系統重構 §3.11.1(給 #844 的固定合約):退回本單目前有效的折抵凍結(= −Σ redeem_booking/redeem_booking_refund),依分類帳上被扣點的會員分組寫 redeem_booking_refund 並加回餘額,bookings.points_redeemed / points_redeem_amount_snapshot 歸 0。先 for update 鎖訂單列再算淨額,重複呼叫回 0、不寫任何東西(冪等)。不看紅利功能開關、不看會員狀態(退回是客人自己的點數)。回傳退回點數。只准內部呼叫(cancel_booking、update_booking、#844 反轉引擎)。';

revoke execute on function private.refund_booking_redeem(uuid) from public, anon, authenticated;

-- =========================================================================
-- 2. 折抵驗證(create_booking / update_booking 共用,只在「這次要新扣點」時呼叫)
-- =========================================================================
create or replace function private.validate_booking_redeem(
  p_merchant_id uuid,
  p_member_id uuid,
  p_points integer,
  p_payable_amount numeric,
  p_available_points integer
)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s public.merchant_member_settings;
  v_amount numeric;
  v_cap numeric;
  v_max_points integer;
  v_min_points integer;
  v_available integer := greatest(coalesce(p_available_points, 0), 0);
begin
  if coalesce(p_points, 0) <= 0 then
    return 0;
  end if;

  v_s := private.merchant_member_settings_effective(p_merchant_id);

  -- §2.10 第 1 點:開放折抵的前提。
  if not coalesce(v_s.points_feature_enabled, true) then
    raise exception '紅利點數功能已關閉,無法使用點數折抵';
  end if;
  if coalesce(v_s.redeem_points_unit, 0) <= 0 or coalesce(v_s.redeem_amount_unit, 0) <= 0
     or coalesce(v_s.redeem_max_ratio_percent, 0) <= 0 then
    raise exception '這間商家尚未開放紅利點數折抵(要先到「紅利點數管理 → 點數使用」設定兌換比例與單次最大使用比例)';
  end if;
  if p_member_id is null then
    raise exception '這筆訂單沒有連結會員,不能使用紅利點數折抵';
  end if;

  -- v2.4 裁決 12:比的是「點數 ≤ 可用點數」與「換算金額 ≤ cap_amount」;max_points 只是畫面建議值,
  -- 不是硬上限(第 17 題:任意點數都收)。
  if p_points > v_available then
    raise exception '這位會員目前只有 % 點,無法折抵 % 點', v_available, p_points;
  end if;

  v_amount := private.redeem_points_to_amount(p_points, v_s.redeem_points_unit, v_s.redeem_amount_unit);

  -- v2.4 裁決 8 ③:換算後折不到 1 元的點數擋下(否則會「扣了點數、一塊錢都沒折」)。
  if v_amount < 1 then
    v_min_points := ceil(v_s.redeem_points_unit / v_s.redeem_amount_unit)::int;
    while private.redeem_points_to_amount(v_min_points, v_s.redeem_points_unit, v_s.redeem_amount_unit) < 1 loop
      v_min_points := v_min_points + 1;
    end loop;
    raise exception '折抵 % 點換算後不到 1 元(目前 % 點 = % 元),至少要使用 % 點才折得到 1 元',
      p_points, v_s.redeem_points_unit, trim_scale(v_s.redeem_amount_unit), v_min_points;
  end if;

  select l.cap_amount, l.max_points into v_cap, v_max_points
  from private.compute_booking_redeem_limits(
    v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
    p_payable_amount, v_available
  ) l;

  if v_cap < 1 then
    raise exception '這筆訂單的應付金額 NT$% 依商家設定的單次最大使用比例 %,折抵上限不到 1 元,無法使用紅利折抵',
      trim_scale(coalesce(p_payable_amount, 0)), v_s.redeem_max_ratio_percent || '%';
  end if;

  if v_amount > v_cap then
    raise exception '本單最多可折抵 NT$%(應付金額 NT$% 的 %),折抵 % 點可折 NT$%,已超過上限;這位會員本單最多建議使用 % 點',
      trim_scale(v_cap), trim_scale(coalesce(p_payable_amount, 0)), v_s.redeem_max_ratio_percent || '%',
      p_points, trim_scale(v_amount), v_max_points;
  end if;

  -- 第 3 題 / §2.11:只做檢查,final_amount_snapshot 不扣。cap <= 應付金額,理論上一定成立。
  if coalesce(p_payable_amount, 0) - v_amount < 0 then
    raise exception '紅利折抵金額不能超過訂單應付金額';
  end if;

  return v_amount;
end;
$$;

comment on function private.validate_booking_redeem(uuid, uuid, integer, numeric, integer) is '紅利系統重構 §2.10 + v2.4 裁決 8/12:建單/改單「這次要新扣點」時的折抵驗證,回傳折抵金額(無條件捨去到整數元)。檢查:功能開啟、商家已設定兌換比例與比例上限、有會員、點數 <= 可用點數、換算後 >= 1 元、換算金額 <= cap_amount(max_points 只是建議值,不是硬上限)。錯誤訊息全部是給客服看的白話。算式全部走 redeem_points_to_amount / compute_booking_redeem_limits,不另寫。只准內部呼叫。';

revoke execute on function private.validate_booking_redeem(uuid, uuid, integer, numeric, integer) from public, anon, authenticated;

-- =========================================================================
-- 3. §3.3 create_booking:25 參數 → 27 參數
-- =========================================================================
drop function if exists public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean
);

create function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamp with time zone,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null::text,
  p_notes text default null::text,
  p_assistant_staff_ids uuid[] default '{}'::uuid[],
  p_material_cost_item_ids uuid[] default '{}'::uuid[],
  p_customer_address text default null::text,
  p_customer_notes text default null::text,
  p_custom_total_amount_enabled boolean default false,
  p_custom_total_amount numeric default null::numeric,
  p_discount_enabled boolean default false,
  p_discount_mode text default null::text,
  p_discount_value numeric default null::numeric,
  p_tax_enabled boolean default false,
  p_tax_mode text default null::text,
  p_tax_value numeric default null::numeric,
  p_payment_method_id uuid default null::uuid,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null::integer,
  p_member_id uuid default null::uuid,
  p_hide_notes_from_staff boolean default false,
  -- 紅利系統重構 §3.3(第 26/27 個參數):
  --   p_points_override:客服人工設定的派點數(0~100,000);null = 用系統建議值。
  --   p_points_redeemed:這筆訂單要用幾點折抵;0 = 不折抵(新單沒有「原值」,預設 0 是安全方向)。
  -- v2.4 裁決 22 ①(第 28 個參數):
  --   p_points_redeem_member_id:折抵要扣「哪一位會員」的點數(= 畫面預覽對到的那位)。
  --     p_points_redeemed > 0 時必帶,且必須等於下面依電話自動連結 / 建立後的會員,否則擋下。
  p_points_override integer default null::integer,
  p_points_redeemed integer default 0,
  p_points_redeem_member_id uuid default null::uuid
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $function$
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
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation',
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
  perform private.log_booking_status_change(v_booking_id, p_merchant_id, null, 'pending_confirmation');

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$function$;

comment on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean,
  integer, integer, uuid
) is '建立預約(模組 5/6/9/10 + #852 + #912 自動會員 + 紅利系統重構批次 3)。新增訂單時前端不帶 p_member_id,由電話自動連結/建立會員(private.resolve_booking_member_by_phone,與 preview_booking_points 同一支)。派點快照由 private.compute_booking_planned_points 計算(與預覽同一支引擎);p_points_override = 客服人工派點(0~100,000);p_points_redeemed = 折抵點數(建單當下就從會員餘額扣,分類帳 redeem_booking);p_points_redeem_member_id = 要扣誰的點數(折抵 > 0 時必帶且須等於伺服器決定的會員,v2.4 裁決 22 ①)。final_amount_snapshot 不扣折抵(第 3 題定案 A)。';

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

-- =========================================================================
-- 4. §3.4 update_booking:25 參數 → 28 參數
-- =========================================================================
drop function if exists public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean
);

create function public.update_booking(
  p_booking_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamp with time zone,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null::text,
  p_notes text default null::text,
  p_assistant_staff_ids uuid[] default '{}'::uuid[],
  p_material_cost_item_ids uuid[] default '{}'::uuid[],
  p_customer_address text default null::text,
  p_customer_notes text default null::text,
  p_custom_total_amount_enabled boolean default false,
  p_custom_total_amount numeric default null::numeric,
  p_discount_enabled boolean default false,
  p_discount_mode text default null::text,
  p_discount_value numeric default null::numeric,
  p_tax_enabled boolean default false,
  p_tax_mode text default null::text,
  p_tax_value numeric default null::numeric,
  p_payment_method_id uuid default null::uuid,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null::integer,
  p_member_id uuid default null::uuid,
  p_hide_notes_from_staff boolean default false,
  -- 紅利系統重構 §3.4(第 26/27/28 個參數):
  --   p_points_override:null = 維持原本的人工設定(沒有人工設定就跟著系統建議值走);有值 = 改成這個數字。
  --   p_points_redeemed:🔴 default null = 維持這張單目前的折抵(§〇.4 判斷 15,跟 #852/#857 同一個坑:
  --     預設 0 的話,任何沒帶這個參數的呼叫都會把客人已折抵的點數整筆默默退掉);只有明確傳數字(含 0)才算要改。
  --   p_points_override_reset:true = 客服按了「改用建議值」,清掉人工設定。
  -- v2.4 裁決 22 ①(第 29 個參數):
  --   p_points_redeem_member_id:折抵要扣「哪一位會員」的點數。p_points_redeemed > 0 時必帶,
  --     且必須等於 p_member_id(編輯模式伺服器決定的會員就是它),否則擋下。p_points_redeemed 為 null(= 維持)不檢查。
  p_points_override integer default null::integer,
  p_points_redeemed integer default null::integer,
  p_points_override_reset boolean default false,
  p_points_redeem_member_id uuid default null::uuid
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $function$
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
    raise exception '已完成或已取消的預約不能編輯,目前狀態不允許這個操作(目前狀態:%)', v_status;
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
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)';
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
      raise exception '單筆訂單最多只能設定 100,000 點,請確認是否多打了零';
    end if;
  end if;
  -- v2.4 裁決 22 ①:明確要折抵(> 0)時,畫面確認的會員必須就是這次送出的會員。
  -- (沒有會員的情況交給後面 validate_booking_redeem 回「這筆訂單沒有連結會員」那句更清楚的話。)
  if coalesce(p_points_redeemed, 0) > 0 and p_member_id is not null
     and p_points_redeem_member_id is distinct from p_member_id then
    raise exception '客戶已變更,紅利折抵已重設,請重新確認後送出';
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
  v_member_changed := p_member_id is distinct from v_old_member_id;

  if p_member_id is not null then
    select name, status into v_member_name, v_member_status
    from public.members
    where id = p_member_id
      and merchant_id = v_merchant_id;

    if not found or (v_member_status <> 'active' and v_member_changed) then
      raise exception '找不到指定的會員,或會員不屬於這間商家/已被下架';
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
    p_member_id,
    p_service_items,
    v_amount.final_amount,
    p_custom_total_amount_enabled,
    p_discount_enabled,
    false
  );

  if p_points_override is not null then
    if not coalesce(v_s.points_feature_enabled, true) then
      raise exception '紅利點數功能已關閉,無法設定派點';
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
    where id in (v_old_member_id, p_member_id)
    order by id
    for update;

    perform private.refund_booking_redeem(p_booking_id);
    v_new_redeem_amount := 0;

    if v_target_redeemed > 0 then
      -- v2.4 裁決 15:已下架會員(只可能是這張單原本的會員,改掛別位下架會員在上面就擋了)
      -- 只能維持或調低,不可增加;調低 = 退差額給他,下面照常完整驗證(換算仍須 >= 1 元)。
      if p_member_id is not null and v_member_status <> 'active' and v_target_redeemed > v_old_redeemed then
        raise exception '這位會員已下架,不能增加紅利折抵(可以調低或改成 0,把點數退回給會員)';
      end if;

      if p_member_id is not null then
        select points_balance into v_member_balance
        from public.members
        where id = p_member_id;
      end if;

      v_new_redeem_amount := private.validate_booking_redeem(
        v_merchant_id, p_member_id, v_target_redeemed, v_amount.final_amount, v_member_balance
      );
    end if;
  elsif v_old_redeemed > 0 and p_member_id is not null
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
    where id = p_member_id;

    select coalesce(-sum(t.points_delta), 0)::int into v_frozen
    from public.member_point_transactions t
    where t.booking_id = p_booking_id
      and t.member_id = p_member_id
      and t.transaction_type in ('redeem_booking', 'redeem_booking_refund');

    select l.cap_amount, l.max_points into v_cap, v_max_points
    from private.compute_booking_redeem_limits(
      v_s.redeem_points_unit, v_s.redeem_amount_unit, v_s.redeem_max_ratio_percent,
      v_amount.final_amount, coalesce(v_member_balance, 0) + greatest(coalesce(v_frozen, 0), 0)
    ) l;

    if v_old_redeem_amount > v_cap then
      raise exception '本單目前最多可折 NT$%(應付 NT$% 的 %),原本的紅利折抵 % 點(NT$%)已超過上限,請先把折抵點數改成 % 點以下',
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
    member_id = p_member_id,
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
      p_member_id, v_merchant_id, 'redeem_booking', -v_target_redeemed,
      v_member_balance - v_target_redeemed, p_booking_id,
      format('編輯訂單時使用紅利折抵 %s 點(折 NT$%s)', v_target_redeemed, trim_scale(v_new_redeem_amount)),
      auth.uid()
    );

    update public.members
    set points_balance = v_member_balance - v_target_redeemed
    where id = p_member_id;
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

comment on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean,
  integer, integer, boolean, uuid
) is '編輯預約(模組 5/6/9/10 + #852 + 紅利系統重構批次 3)。p_member_id / p_hide_notes_from_staff 仍是無條件覆寫(前端一律帶值)。紅利:每次重算系統建議派點;p_points_override 有值 = 人工設定、null = 維持(已人工設定就保留客服數字);p_points_override_reset = 改用建議值;p_points_redeemed default null = 維持原折抵,有值才改。會員變更(含變空)而原本有折抵 ⇒ 先整筆退回給原會員。折抵與會員都沒變時,只有應付金額變動才重驗上限,原折抵超過新上限 ⇒ 擋下(v2.4 裁決 14)。原會員已下架時可維持連結、可調低或改 0、不可增加(v2.4 裁決 15)。p_points_redeemed > 0 時 p_points_redeem_member_id 必須等於 p_member_id(v2.4 裁決 22 ①)。';

revoke execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean,
  integer, integer, boolean, uuid
) from public, anon;
grant execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid, boolean,
  integer, integer, boolean, uuid
) to authenticated, service_role;

-- =========================================================================
-- 5. §3.11.1 cancel_booking 疊加退回折抵(簽章不變,create or replace 不會重設權限)
-- =========================================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text default null::text)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  -- 紅利系統重構 批次 3:加上 for update(原本沒有),跟 update_booking 排隊 ——
  -- 否則「改單」與「取消」同時送出時,改單可能在取消之後又把折抵重新扣回去。
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

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '只有「待確認」或「已確認」狀態的預約可以取消,目前狀態不允許這個操作(目前狀態:%)', v_status;
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
$function$;
