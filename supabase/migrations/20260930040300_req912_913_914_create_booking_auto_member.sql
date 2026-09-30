-- SPECS-INDEX #912 / #913 / #914(規格書 .project/specs/建單自動建立會員與會員兩層狀態.md §三)。
-- 建單時**自動建立 / 自動連結會員**,客服不用再按任何按鈕。這是整份規格書的核心。
--
-- ═══ 🔴 簽章完全不變(這一點是刻意的,不要「順手」改)══════════════════════════════════
-- create_booking 的呼叫端是 **43 支 pgTAP + 8 支 e2e fixture + 1 處前端**,多數寫成
-- `select id from create_booking(…)`。所以:
--   ・**不新增任何參數**(沒有 p_auto_create_member、也沒有 p_force_create_member 這種開關 ——
--     使用者明確裁決「不需要不入會的退路」,加開關等於偷偷把退路又放回來);
--   ・**回傳型別維持 public.bookings**,絕對不改成 jsonb(改型別會一次弄壞整套測試);
--   ・「這筆是新建還是連結」改用 bookings.member_auto_created 這個欄位傳出去(#911)。
-- ⇒ 簽章不變 ⇒ 用 create or replace,**不需要 drop**(drop 會一併丟掉 EXECUTE 權限設定,
--   supabase-permission-hygiene 規則 1;而且 drop 後 create 時參數清單打錯一個字就會多出一個
--   overload,PostgREST 會回 PGRST203、建單整個壞掉)。
--
-- ═══ 逐字沿用的基準版本 ═════════════════════════════════════════════════════════════
-- create_booking ← 20260930010200_req852_booking_rpc_hide_notes_from_staff.sql
--   (檔案 `$function$ … $function$` 本體 CRLF 正規化成 LF 後
--    md5 = 5cbddbe458f5b0cecf580d209f95b990、長度 5211;2026-09-30 對正式專案
--    wjtbmmnakcriuaqoknsq 的 pg_proc.prosrc 核對**逐字相符**,不是憑印象重寫、
--    也不是從線上 prosrc 反抄。簽章確認就是那 25 個參數,線上只有 1 個 overload。)
-- 這次相對於基準版本的差異**只有**:
--   ① declare 多 5 個區域變數;
--   ② 在「客戶地址檢查」之後、「p_member_id 驗證」之前插入一段自動處理;
--   ③ 原本 `if p_member_id is not null then …` 的判斷對象改成 v_effective_member_id;
--   ④ INSERT 的欄位清單多 member_auto_created、member_id 改用 v_effective_member_id。
-- 其餘每一行(權限檢查、姓名/電話非空、電話格式、金額計算、關聯表、狀態紀錄)逐字不變。
--
-- ═══ #912 的規則(逐條都是使用者裁決的直接翻譯)═══════════════════════════════════════
--  1. **判定鍵是手機**,而且是 private.normalize_phone() 之後的數字比對
--     ('0912-345-678' / '0912345678' / '(09)12345678' 視為同一支;'#' 之後的分機不參與比對)。
--     **兩邊都要正規化** —— 輸入值與資料庫裡的 members.phone 都要過 normalize_phone。
--  2. **手機已存在 ⇒ 絕對不新增會員紀錄**,也**絕對不去改那位會員的任何欄位**
--     (姓名、email、生日一律不動)。使用者裁決:「除了手機以外的資訊不是自己的,由會員自己修改」。
--     🔴 這一條跟 #931 的完整語意是同一件事:同一支手機**可以**用別的姓名建單,
--     訂單留這次填的姓名(bookings.customer_name),**會員那一筆的姓名不動**。
--  3. member_name_snapshot 照既有邏輯取「會員資料表裡的姓名」,不是表單上打的姓名(既有行為,不改)。
--     ⇒ 會出現「訂單的 customer_name = 表單打的」vs「member_name_snapshot = 會員原本的名字」
--     不一致 —— 這是**正確的**,正是使用者說「由會員自己登入後修改」要保留的資訊。
--  4. **自動建立的會員一律 identity_verified_at = null**(= 兩層狀態裡的「尚未驗證」)。
--     create_member 不會碰那三個欄位,所以這條是自動成立的。
--  5. **p_member_id 有帶就完全尊重呼叫端**,整段跳過。這保住:客服在畫面上明確選了某一位;
--     以及既有 43 支 pgTAP / 8 支 e2e fixture 原本帶 p_member_id 的案例行為完全不變。
--  6. **不新增任何「不要自動建立」的開關或參數**(使用者明確裁決不需要退路)。
--     ⚠️ 已知副作用:既有測試裡**原本刻意建「訪客訂單」(不帶 p_member_id)的案例,
--     從此都會自動產生一筆會員**。這不是 bug,是需求;但會改變那些測試的資料前提。
--  7. 🟢 **孤兒會員不可能發生**:這段跟 INSERT 在**同一個交易**裡(整支函式就是一個交易),
--     任何後續失敗(時段衝突、金額錯誤、服務項目不存在)都會把新建的會員一起 rollback。
--     ⇒ 不需要任何補償邏輯,也不需要「先建會員再建單」那種兩步流程。
--
-- ═══ #914:同一支電話有兩位以上 active 會員時,**後端不猜,直接 raise** ═══════════════════
-- 這是**防線,不是主要路徑**。直接打 RPC 繞過畫面時會被擋下。
-- 🔴 為什麼不自動選「最近消費的那一位」:選錯人 = **紅利點數發到錯的人身上**
--    (#842 定案訂單完成就入帳,入帳之後要靠 #844 的反轉才能救)。
--    一個系統猜不出來的事,不該用「猜最近的那個」來賭錢。
-- 📌 #931(2026-09-30 使用者裁決「一支電話在同一商家只能有一位會員」)之後,
--    這個情況**在新資料上不會再發生**(members_merchant_active_phone_uniq 直接擋掉),
--    而且正式庫目前同商家內電話重複 0 組。**但這道 raise 仍然保留**,理由有兩個:
--      ① 舊資料的安全網(唯一性約束只管 active,理論上仍可能出現先前遺留的組合);
--      ② 唯一性約束萬一沒涵蓋到某條路徑時,它是最後一道牆。
--    ⚠️ 訊息文字**刻意偏離**規格書 §六 的原文:原文寫「…或選「這支電話的新客戶」」,
--    但 #931 已經把那顆按鈕整顆移除了,再叫客服去按一顆不存在的按鈕只會讓人更困惑。
--
-- ═══ #913:順手關掉 #827 在**這條路徑上**的後門(而且刻意不擴大範圍)═════════════════════
-- 🟢 結論:**自動建立會員這條路徑不可能塞進髒電話。** 因為 create_booking 在第 3 步就已經用
--    private.is_valid_taiwan_phone 驗過格式,第 5c 步傳給 create_member 的一定是合格電話。
--    ⇒ 自動建會員**不會**變成 #827 的新後門。pgTAP 用「電話填 123 → raise,而且 members
--      一列都沒有多」把這個結論鎖住。
-- ✅ #827 **本體也在同一批關掉了**(繞過畫面直接呼叫 create_member / update_member 塞「123」):
--    規格書 §十一 Q5 的裁決就是 (A)「一起修」,主腦 2026-09-30 更正了派工單的範圍限定。
--    實作在 20260930040200_req931_one_active_member_per_phone.sql 第 2、3 節
--    (跟 #931 的唯一性檢查寫在同兩支函式裡,格式檢查排在唯一性檢查前面)。
-- 📌 順手更新 private.is_valid_taiwan_phone 的 comment(#913 第 3 點):它原本寫著
--    「只給 create_booking / update_booking 內部呼叫」,但 #824 之後已經多了兩支匯入函式呼叫端。
--    這次只改 comment,函式本體一個字都不動(所以不需要重跑它的 revoke/grant —— 但仍照慣例寫出來)。
--
-- ⚠️ 本檔沒有任何 UPDATE/DELETE 資料的敘述,只有函式定義與一個 comment。

-- =========================================================================
-- 1. private.is_valid_taiwan_phone:只更新過時的 comment,本體一個字不動
-- =========================================================================
comment on function private.is_valid_taiwan_phone(text) is 'SPECS-INDEX #822:客戶電話格式規則(2026-09-27 使用者裁決)。去掉空白/括號/連字號後,手機 = 09 開頭共 10 碼;市話 = 0 開頭、第二碼 2~8、共 9~10 碼,可接 #1~6 碼分機。不列舉區碼。正規表示式跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應,改一邊要同步改另一邊。【2026-09-30 #913 更新這句過時的說明】呼叫端現在有四支,不只 create_booking / update_booking:create_booking、update_booking(#822)、import_members_batch、import_historical_bookings_batch(#824 逐列驗證)。EXECUTE 只開給 service_role,這些都是 SECURITY DEFINER、以 owner 身份呼叫,不需要放寬權限。✅ **#827 已於 2026-09-30 同一批關掉**(使用者裁決 Q5 = (A)):create_member / update_member 也套上這條規則了,見 20260930040200_req931_one_active_member_per_phone.sql 第 2、3 節 —— 所以現在的完整呼叫端是六支:create_booking、update_booking、create_member、update_member、import_members_batch、import_historical_bookings_batch。';

-- ACL 維持不變(這次沒有 drop、也沒有改本體),照慣例原樣重寫一次,讓權限邊界在這份 migration 裡也看得到。
revoke execute on function private.is_valid_taiwan_phone(text) from public, anon, authenticated;
grant execute on function private.is_valid_taiwan_phone(text) to service_role;

-- =========================================================================
-- 2. create_booking:內建「自動建立 / 自動連結會員」
-- =========================================================================
create or replace function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}'::uuid[],
  p_material_cost_item_ids uuid[] default '{}'::uuid[],
  p_customer_address text default null,
  p_customer_notes text default null,
  p_custom_total_amount_enabled boolean default false,
  p_custom_total_amount numeric default null,
  p_discount_enabled boolean default false,
  p_discount_mode text default null,
  p_discount_value numeric default null,
  p_tax_enabled boolean default false,
  p_tax_mode text default null,
  p_tax_value numeric default null,
  p_payment_method_id uuid default null,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null,
  p_member_id uuid default null,
  -- SPECS-INDEX #852(2026-09-30):這一筆訂單的內部備註要不要對服務人員隱藏。
  -- ⚠️ 語意跟 p_notes / p_customer_notes / p_member_id 完全一致 —— **無條件覆寫**,不是
  --    「有帶才更新」。所以呼叫端(前端 api.ts)每次都要帶入目前的值,即使這次沒有要改它。
  p_hide_notes_from_staff boolean default false
)
returns bookings
language plpgsql
security definer
set search_path = 'public'
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
      v_match_count := 0;
      v_effective_member_id := null;
    else
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
      select count(*), (array_agg(m.id order by m.created_at, m.id))[1]
      into v_match_count, v_matched_member_id
      from public.members m
      where m.merchant_id = p_merchant_id
        and m.status = 'active'
        and private.normalize_phone(m.phone) = v_normalized_phone;

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
    member_auto_created
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
    v_amount.final_amount, p_payment_method_id, v_sel.payment_method_name,
    coalesce(p_custom_duration_enabled, false),
    case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    v_effective_member_id, v_member_name,
    -- SPECS-INDEX #852:coalesce 是為了「呼叫端明確傳 null 進來」的邊界(欄位是 not null),
    -- 不是為了容許漏帶 —— 漏帶時 default false 已經在簽章那一層生效了。
    coalesce(p_hide_notes_from_staff, false),
    -- SPECS-INDEX #911:只有「這次自動新建了一筆會員」才是 true。自動連結既有會員、
    -- 或呼叫端明確帶了 p_member_id,都是 false。
    v_member_auto_created
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

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:建立訂單本身也算一筆操作記錄,
  -- from_status = null 代表「建立」這個動作。
  perform private.log_booking_status_change(v_booking_id, p_merchant_id, null, 'pending_confirmation');

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$function$;

comment on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) is '建立預約(模組 6)。模組 6 §9.1(#597):成功建立後寫入一筆 booking_status_change_logs(from_status=null, to_status=pending_confirmation)。#822:客戶電話在非空檢查之後多一段格式檢查(private.is_valid_taiwan_phone)。#852:p_hide_notes_from_staff(無條件覆寫語意,呼叫端每次都要帶目前的值,見 #857)。【SPECS-INDEX #912/#913/#914,2026-09-30】呼叫端**沒有**帶 p_member_id 時,自動處理會員:用 private.normalize_phone 在同一商家、status=''active'' 的 members 裡比對電話 —— 剛好 1 位就**自動連結**(不新增紀錄、不改那位會員的任何欄位,連 updated_at 都不動);0 位就**自動建立**(完全複用 public.create_member,只帶姓名/電話/email,生日與推薦人不帶,因為建單表單沒有生日欄位);≥2 位就 raise(#914 後端防線,#931 之後新資料不會再發生,保留當舊資料的安全網)。帶了 p_member_id 就完全尊重呼叫端,整段跳過(既有 43 支 pgTAP / 8 支 e2e fixture 的行為不變)。新建的那一筆寫進 bookings.member_auto_created = true(#911),提示框靠它分辨「已自動建立」還是「已連結既有」。🟢 整支函式是一個交易 ⇒ 後續任何失敗(時段衝突、金額錯誤)都會把新建的會員一起 rollback,**不可能留下孤兒會員**。🔴 電話格式檢查必須留在自動建立會員的**前面**,那就是「自動建會員不會變成 #827 塞髒電話新後門」的唯一理由(#913)。🔴 簽章與回傳型別**刻意完全不變**:不新增「不要自動建立」的開關(使用者明確裁決不需要退路),回傳型別維持 public.bookings 不改成 jsonb(43 支 pgTAP 多寫成 select id from create_booking(…))。customer_name 一律留這次表單打的姓名,不會被會員資料表的姓名覆蓋;source/created_by_role 維持 manual/admin|agent 不動。';

revoke execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) from public, anon;
grant execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) to authenticated;
