-- 2026-09-24 使用者裁決:三種「人」的角色都只保留一個 Email(登入 Email),
--                        把 merchant_staff / merchant_agents 的 contact_email 欄位整個拿掉。
--
-- =========================================================================
-- 【使用者裁決原文】
--   「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
--   「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--
-- 背景:系統裡「人」原本有兩種 email——
--   ・登入 Email:auth.users.email,Supabase Auth 管理,是身分錨點。
--   ・聯絡 Email:各角色資料表自己的 contact_email 欄位。
-- 使用者實際使用後認為這是多餘的設計:同一個人兩個信箱只會製造「到底該看哪一個」的困惑,
-- 而且畫面上兩個欄位長得很像,一直要靠說明文字提醒「這個不是登入帳號」。
--
-- 所以三種角色一律只留登入 Email:
--   ・merchant_admins —— 從來沒有過 contact_email(20260924040600 那支 migration 原本要加,
--                        在還沒套用之前就改成只加 phone,見該檔檔頭)。這裡沒有它的事。
--   ・merchant_agents(客服)     —— 本支 §2 drop column。
--   ・merchant_staff(服務人員)  —— 本支 §2 drop column。
--
-- =========================================================================
-- 【⚠️⚠️ 為什麼 public.merchants.contact_email 刻意完全不動 —— 這是最重要的界線】
--
-- public.merchants(商家/店家本身)也有一個 contact_email,但那是**完全不同的東西**:
--   ・它是「店家對外的聯絡信箱」,要顯示給消費者看的(見 20260915100000:62 的欄位註解:
--     「商家對外聯絡信箱,跟登入帳號 auth.users.email 是不同欄位,見規則 2.3,不可互相帶入」)。
--   ・**店家本身沒有登入帳號**(登入的是它的管理員 merchant_admins),所以根本不存在
--     「跟登入信箱重複」這個問題——使用者這次的裁決前提在它身上不成立。
--
-- 因此以下全部保留不動,不要「順手統一」:
--   ・public.merchants.contact_email 欄位本身
--   ・public.create_group_and_merchant / create_merchant_in_group 的 p_contact_email 參數
--     (散落在很多支 migration 裡,因為那兩支函式被反覆 create or replace 過:
--      20260915100100 / 20260915110000 / 20260919130100 / 20260919130300 / 20260919150100 /
--      20260920120500 / 20260920140600 / 20260920160300 / 20260922100100 / 20260922160300 /
--      20260923020100 …)
--   ・前端商家設定頁/新增商家表單的「聯絡信箱」欄位(MerchantSettingsPage / MerchantIntakeForm /
--     OnboardingPage / NewMerchantPage / IndustryTransferWizardPage、updateMerchantSettings)
--   ・e2e fixture 裡呼叫 create_group_and_merchant 時帶的 p_contact_email
--
-- ⚠️ 判斷方法(給之後維護的人):看這個 contact_email 掛在哪張表。
--    掛在 merchants → 店家對外信箱 → 保留。
--    掛在 merchant_staff / merchant_agents / merchant_admins → 「人」的第二個信箱 → 已移除。
--    絕對不要對 contact_email 做全域取代。
--
-- =========================================================================
-- 【主腦對正式資料庫的查證結果(這是「可以直接 drop、不需要先回填/備份」的依據)】
-- 依 .claude/skills/supabase-permission-hygiene「drop 欄位前要回填」的規則,動手前必須先確認
-- 這兩個欄位裡沒有任何只存在於它、而且還有用的資訊。主腦已對正式環境查證:
--
--   ・merchant_staff:124 筆裡只有 15 筆有值。其中 11 筆屬於 E2E 測試商家(status 全是
--     'removed')、1 筆是使用者自己建的測試列(`123@QQ.COM`,status='removed'),
--     **剩下 3 筆是真實在職人員,而這 3 筆的 contact_email 跟他們的登入 Email 完全一樣**。
--   ・merchant_agents:全表 2 筆,**0 筆有值**。
--   ・merchant_admins:正式環境**還沒有這個欄位**(它只存在於 20260924040600 那支還沒套用的
--     migration 裡,而那支已經改成不加它了)。
--
-- → 結論:drop 這兩個欄位不會遺失任何真實資訊,所以**不需要**先做資料回填或搬移。
--   這句話是有查證支撐的事實,不是「看起來應該沒差」的推測。
--
-- =========================================================================
-- 【這支 migration 的執行順序,以及為什麼是這個順序】
--   §1 先 drop 掉所有會讀寫這兩個欄位的函式(含每一個舊簽章)。
--   §2 再 alter table drop column。
--   §3 最後重建那些函式的新版本(參數少一個)。
-- 先 drop 函式再 drop 欄位,是為了不留下任何「函式主體引用已不存在欄位」的中間狀態——
-- PostgreSQL 不會替 plpgsql 主體做欄位層級的依賴追蹤,所以那種狀態能建立、但會在執行期才爆,
-- 是最難查的一類錯誤。這裡用順序本身排除這個可能。
--
-- 【⚠️ 舊簽章一定要逐一 drop function if exists —— 本專案踩過的已知坑】
-- PostgreSQL 把「參數不同的同名函式」視為不同的重載函式,PostgREST 又會依前端送來的**參數名**
-- 挑選重載。少 drop 一個舊簽章,就會留下一支孤兒重載,製造「有時候走到舊版」這種極難查的問題
-- (20260924040500 的檔頭就記了 update_merchant_agent 踩過這個坑)。
-- 這次兩支函式的簽章都會變,而且 update_merchant_agent 有一個特別的陷阱,見 §1 的說明。
-- =========================================================================

-- =========================================================================
-- §1 drop 掉所有相關函式的所有已知簽章。
-- =========================================================================

-- ---------------------------------------------------------------------------
-- 1-a. public.update_my_staff_profile —— 服務人員自助編輯個人資料(20260921140000,規格書 3.16)。
--      舊:7 參數 (p_staff_id, p_name, p_nickname, p_phone, p_contact_email, p_avatar_url, p_intro)
--      新:6 參數 (p_staff_id, p_name, p_nickname, p_phone, p_avatar_url, p_intro)
--      這支函式從建立到現在只有過 7 參數這一個版本(全 migration 目錄只有 20260921140000:13
--      建立它),所以只需要 drop 這一個舊簽章;新的 6 參數簽章 (uuid,text,text,text,text,text)
--      是全新的,不會跟任何既有重載撞上。
-- ---------------------------------------------------------------------------
drop function if exists public.update_my_staff_profile(uuid, text, text, text, text, text, text);

-- ---------------------------------------------------------------------------
-- 1-b. public.update_merchant_agent —— 商家管理員/客服本人編輯客服資料(20260924040500)。
--      舊(同一批開發中的第一版草稿,**從未上線**):
--                            5 參數 (p_agent_id, p_name, p_nickname, p_phone, p_contact_email)
--      舊(20260924040500):  6 參數 (…上面五個…, p_job_title)
--      新(本支):            5 參數 (p_agent_id, p_name, p_nickname, p_phone, p_job_title)
--
-- ⚠️ 事實更正(主腦 2026-09-24 對正式環境查證):`update_merchant_agent` 這支函式
--    **目前在正式環境完全不存在**(查 pg_proc 零筆)。它是 20260924040500 才要新建的,而 040500
--    到現在還沒套用。所以上面那個 5 參數版本只存在於本批開發過程中的草稿裡,從來沒有真的上線過。
--    下面兩行 drop 因此在正式環境都是 no-op,靠 `if exists` 保護——**但仍然要留著**,理由有兩個:
--      (1) 開發/測試環境可能已經套用過草稿版本,少 drop 就會留下孤兒重載;
--      (2) 這支 migration 必須能在「已套用 040500」和「跨過 040500 直接套用」兩種狀態下都正確。
--
-- ⚠️ 主腦裁決(不把 040500 改成一開始就沒有 contact_email):040500 與本支在同一次部署裡一起
--    套用,所以「先建六參數再改成五參數」不會產生任何中間期的破壞;而回頭改 040500 要連帶重驗
--    module3_05 那 26 條斷言,是為了外觀整潔而增加實質風險。維持現狀。
--
-- ⚠️⚠️ 這裡有一個非常容易踩的陷阱,務必看清楚:
--      新的 5 參數版本跟「第一版的 5 參數版本」**型別完全一樣**(uuid, text, text, text, text),
--      在 PostgreSQL 眼中就是同一支函式的同一個簽章——差別只在第 5 個參數的**名字**
--      (p_job_title vs p_contact_email)。
--      而 `create or replace function` **不允許變更既有函式的輸入參數名稱**(會直接報
--      「cannot change name of input parameter」)。
--      所以這裡**必須**先 drop 那個 5 參數簽章,不能只靠 create or replace 蓋過去。
--      (即使某個環境已經套用過 20260924040500、目前只有 6 參數版本,多寫這行 drop 的成本也是零,
--       靠 if exists 保護。)
--      同時也要 drop 6 參數版本,否則它會變成一支「寫得到已經不存在的 contact_email 欄位」的
--      孤兒重載,PostgREST 依參數名解析時有機會走進去,執行期才爆。
-- ---------------------------------------------------------------------------
drop function if exists public.update_merchant_agent(uuid, text, text, text, text, text);
drop function if exists public.update_merchant_agent(uuid, text, text, text, text);

-- =========================================================================
-- §2 drop 兩張「人」的表的 contact_email 欄位。
--
-- 沒有任何 trigger / RLS policy / 索引 / 欄位層級 grant 引用這兩個欄位(已逐一 grep 確認:
-- merchant_staff 只有 merchant_staff_select/insert/update 三條政策,條件都是
-- is_merchant_admin / is_own_staff_row 之類的列層級判斷,不列舉欄位;merchant_agents 只有
-- SELECT 政策,寫入一律走 SECURITY DEFINER 函式),所以只要 drop column 本身,
-- 欄位註解會隨欄位一起消失,不需要另外處理。
--
-- 幾支既有 migration 的**註解文字**裡還會提到 contact_email
-- (20260916100000:49 的欄位註解、20260924020100:79/94、20260924030100:70 的保護 trigger 說明),
-- 那些是已經套用過的歷史紀錄,刻意不回頭改寫——改寫已套用的 migration 會讓歷史對不上真實
-- 套用順序。要看「現在的樣子」請看這支 migration 和本專案的 SPECS-INDEX。
-- =========================================================================
alter table public.merchant_staff drop column contact_email;
alter table public.merchant_agents drop column contact_email;

-- =========================================================================
-- §3 重建函式(新簽章,不含 contact_email)。
-- =========================================================================

-- ---------------------------------------------------------------------------
-- 3-a. public.update_my_staff_profile(6 參數)
--      除了拿掉 p_contact_email / set contact_email = … 這兩行之外,主體與 20260921140000
--      **一字不改**:同樣的 is_own_staff_row(本人)+ has_own_staff_permission('staff_profile_edit')
--      兩道把關、同樣的姓名非空白驗證、同樣的 nullif(trim(coalesce(x,'')),'') 正規化慣例、
--      同樣 returns void。這次只做「移除一個欄位」,不順便改動任何既有行為。
--
--      規則 2.7 的設計精神照樣成立(而且範圍又縮小了一個欄位):函式簽章本身就不暴露
--      is_listed / 11 個權限開關 / compensation_type / status / merchant_id / user_id /
--      login_status 這些欄位的參數,從介面設計上直接排除誤用的可能性。
-- ---------------------------------------------------------------------------
create or replace function public.update_my_staff_profile(
  p_staff_id uuid,
  p_name text,
  p_nickname text,
  p_phone text,
  p_avatar_url text,
  p_intro text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限編輯這位服務人員的資料' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_profile_edit') then
    raise exception '尚未開通個人資料編輯功能,請洽商家管理員' using errcode = '42501';
  end if;

  if p_name is null or trim(p_name) = '' then
    raise exception '姓名不可為空白';
  end if;

  update public.merchant_staff
  set name = trim(p_name),
      nickname = nullif(trim(coalesce(p_nickname, '')), ''),
      phone = nullif(trim(coalesce(p_phone, '')), ''),
      avatar_url = p_avatar_url,
      intro = nullif(trim(coalesce(p_intro, '')), '')
  where id = p_staff_id;
end;
$$;

comment on function public.update_my_staff_profile(uuid, text, text, text, text, text) is '對應規格書 3.16/規則 2.7/2.8:服務人員自助編輯個人資料,只接受並只更新 name/nickname/phone/avatar_url/intro 五個欄位,函式簽章本身不暴露其他任何欄位的參數。需要 is_own_staff_row(本人)且已開通 staff_profile_edit 權限。【2026-09-24 使用者裁決】原本還有第六個欄位 p_contact_email(寫入 merchant_staff.contact_email),已連同欄位本身一起移除——使用者原話:「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」三種「人」的角色(merchant_admins / merchant_agents / merchant_staff)從此只有一個 Email,就是登入 Email(auth.users.email)。舊的 7 參數簽章已在 20260924040800 裡 drop,避免留下孤兒重載被 PostgREST 依參數名解析到(那會寫入一個已經不存在的欄位)。⚠️ 這個決定不適用於 public.merchants.contact_email —— 那是店家對外給消費者看的信箱,店家本身沒有登入帳號,不存在跟登入信箱重複的問題,一律保留。';

revoke execute on function public.update_my_staff_profile(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.update_my_staff_profile(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3-b. public.update_merchant_agent(5 參數)
--      除了拿掉 p_contact_email / set contact_email = … 之外,主體與 20260924040500 **一字不改**:
--      同樣的「該商家管理員 或 這一列自己的 user_id = auth.uid()」雙路徑授權(刻意不用
--      private.is_merchant_agent,否則客服 A 能改客服 B)、同樣的姓名/電話白話中文錯誤訊息、
--      同樣 returns public.merchant_agents。
--
--      ⚠️ 參數順序刻意把 p_job_title 留在最後(而不是把它往前挪去補 contact_email 的位置),
--         這樣前端既有呼叫端的具名參數 p_name / p_nickname / p_phone / p_job_title 完全不用動,
--         只是不再送 p_contact_email 而已。PostgREST 是依參數名對應的,順序本身不影響呼叫,
--         但保持「新欄位往後加」的慣例讓 diff 更容易讀。
-- ---------------------------------------------------------------------------
create or replace function public.update_merchant_agent(
  p_agent_id uuid,
  p_name text,
  p_nickname text,
  p_phone text,
  p_job_title text
)
returns public.merchant_agents
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_user_id uuid;
  v_name text;
  v_phone text;
  v_result public.merchant_agents;
begin
  select merchant_id, user_id into v_merchant_id, v_user_id
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄';
  end if;

  -- 授權:該商家管理員(可以協助編輯任何一位客服)**或**這筆紀錄本人(客服自行編輯)。
  -- 直接對應使用者裁決原文「客服可自行編輯或管理員可協助編輯」。
  -- ⚠️ 本人那一條用 v_user_id = auth.uid() 比對**這一列自己的** user_id,不是用
  --    private.is_merchant_agent(merchant_id)——後者只要是這間店任何一位在職客服就成立,
  --    會讓客服 A 改客服 B 的資料。
  if not (private.is_merchant_admin(v_merchant_id) or v_user_id = auth.uid()) then
    raise exception '沒有權限編輯這位客服的資料,只有商家管理員或這位客服本人可以編輯'
      using errcode = '42501';
  end if;

  -- ---------------------------------------------------------------------
  -- 欄位驗證:全部在 UPDATE 之前擋下並給白話中文訊息,不讓使用者看到資料庫原始錯誤。
  -- ---------------------------------------------------------------------
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is null then
    -- merchant_agents.name 是 not null(20260916100000:85)。
    raise exception '姓名不可為空白';
  end if;

  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  if v_phone is null then
    -- merchant_agents.phone 在 20260922140000(#595/#596)已改成 NOT NULL,所以編輯時電話必填。
    raise exception '手機號碼不可為空白';
  end if;

  -- merchant_agents_phone_tw_mobile_format:check (phone ~ '^09\d{8}$')
  -- (20260922140000:37-39)。這裡先自己擋下來,不然商家會看到
  -- 「new row for relation "merchant_agents" violates check constraint ...」這種原始錯誤。
  if v_phone !~ '^09\d{8}$' then
    raise exception '手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)';
  end if;

  -- nickname / job_title 空字串一律正規化成 NULL(比照 update_my_staff_profile 與
  -- update_my_agent_profile 的既有慣例 nullif(trim(coalesce(x,'')),''),避免存進一堆空字串)。
  -- job_title 為 NULL 時前端 fallback 顯示「客服」(見該欄位註解),所以清空是合法操作。
  --
  -- ⚠️ 四個欄位在**同一個 UPDATE 語句**裡寫完,所以天然是一個原子交易——這正是當初追加
  -- p_job_title 的主要目的(讓前端不必呼叫兩支 RPC,不會出現「第一支成功、第二支失敗」
  -- 的部分儲存狀態)。
  update public.merchant_agents
  set name = v_name,
      nickname = nullif(btrim(coalesce(p_nickname, '')), ''),
      phone = v_phone,
      job_title = nullif(btrim(coalesce(p_job_title, '')), '')
  where id = p_agent_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_merchant_agent(uuid, text, text, text, text) is '客服管理列表頁的「編輯」(2026-09-24 使用者裁決「客服可自行編輯或管理員可協助編輯」)。merchant_agents 只有 SELECT 的 RLS 政策、完全沒有 INSERT/UPDATE/DELETE 政策(刻意鎖成唯讀,所有寫入走 SECURITY DEFINER 函式),所以前端必須透過這支函式才改得動。授權:private.is_merchant_admin(該客服的 merchant_id) 或這筆紀錄本人(這一列自己的 user_id = auth.uid();刻意不用 is_merchant_agent,否則客服 A 能改客服 B)。只開放 name / nickname / phone / job_title 四個欄位,函式簽章本身不暴露其他欄位的參數(比照 update_my_staff_profile 的既有手法),所以 status / user_id / invited_email / line_user_id / line_bound / pending_admin_login_email* 這些身分綁定與登入帳號欄位從介面上就不可能被改到。四個欄位在同一個 UPDATE 語句裡寫完,天然是原子交易。phone 先自行驗證 NOT NULL 與 ^09\d{8}$(merchant_agents_phone_tw_mobile_format 約束)並給白話中文訊息,不讓商家看到資料庫原始的 check constraint 錯誤;name 驗證非空白;nickname/job_title 空字串正規化成 NULL。⚠️⚠️【2026-09-24 使用者裁決:拿掉 p_contact_email】原本還有第五個欄位 p_contact_email(寫入 merchant_agents.contact_email),已連同欄位本身一起移除。使用者原話:「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」三種「人」的角色從此只有一個 Email,就是登入 Email(auth.users.email)。⚠️ 重載陷阱:新的 5 參數簽章 (uuid,text,text,text,text) 跟這支函式**第一版**的 5 參數簽章型別完全相同,只有第 5 個參數的名字不同(p_job_title vs p_contact_email),而 create or replace 不允許變更輸入參數名稱,所以 20260924040800 必須先 drop 那個簽章(以及 20260924040500 建立的 6 參數版本)才能建立這一版;少 drop 任何一個都會留下孤兒重載,讓 PostgREST 依參數名解析到寫入已不存在欄位的舊版。⚠️ 這個決定不適用於 public.merchants.contact_email(店家對外給消費者看的信箱,店家本身沒有登入帳號),那個一律保留。⚠️ 後續處置(維持 20260924040500 的既有結論):既有的 public.update_my_agent_profile(p_merchant_id, p_nickname, p_job_title) 能做的事已經被這支函式完全涵蓋(本人授權那條路徑就是為此保留),等確認沒有任何地方還在呼叫它之後就可以移除,不是該長期並存。';

revoke execute on function public.update_merchant_agent(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_merchant_agent(uuid, text, text, text, text) to authenticated;
