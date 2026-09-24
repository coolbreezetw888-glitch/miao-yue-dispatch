-- 2026-09-24 主腦上線前巡檢抓到:public.update_merchant_agent 的權限判斷有同一個三值邏輯漏洞。
--
-- =========================================================================
-- 【怎麼被發現的 —— 這件事值得記下來】
-- 20260924040900 修掉 unbind_line_account 的三值邏輯漏洞之後,主腦沒有只相信「那一支修好了」,
-- 而是對正式環境做了一次**系統性掃查**:把 public/private 底下所有函式的定義撈出來、逐行剝掉
-- `--` 註解(避免被「註解裡引用舊寫法」誤判),再找還有沒有「裸寫 or <變數> = auth.uid()」的
-- 可執行程式碼。結果掃出這一支——而它正是**同一批 migration(040500 + 040800)自己新建的**,
-- 也就是說這個洞不是既有的,是這一批引入的,如果沒有掃就會跟著上線。
--
-- 教訓:修掉一個「有明確特徵、可以被機械掃出來」的漏洞模式時,一定要把整個資料庫掃一遍,
--       不要只修「被通報的那一支」。engineer 當時的回報也建議過要做這件事,主腦當場做了。
--
-- =========================================================================
-- 【漏洞本體】
-- 20260924040800 建立的版本(以及 040500 的 6 參數前身)權限判斷寫成:
--   if not (private.is_merchant_admin(v_merchant_id) or v_user_id = auth.uid()) then
--     raise exception '沒有權限編輯這位客服的資料...' using errcode = '42501';
--   end if;
--
-- 而 public.merchant_agents.user_id 是 **nullable**(information_schema 已查證 is_nullable=YES;
-- 「已邀請但本人還沒去設定密碼註冊」的客服,這個欄位就是 NULL)。
--
-- 在 PostgreSQL 的三值邏輯下:
--   ・v_user_id 是 NULL 時,`v_user_id = auth.uid()` 的結果是 **NULL**(不是 false)
--   ・`false or NULL` = **NULL**
--   ・`not NULL`      = **NULL**
--   ・`if NULL then`  → **不成立**,所以那個 raise 根本不會執行
-- ⇒ 權限檢查被靜默跳過,函式繼續往下走到 UPDATE。
-- (主腦已在正式環境實際執行 `select not (false or null)` 確認回傳 NULL,不是憑印象推論。)
--
-- 【實際影響】
-- 任何**已登入**的使用者(不必是這間商家的任何角色),只要知道某筆「已邀請未註冊」客服的
-- merchant_agents.id,就能修改那個人的 name / nickname / phone / job_title。
--   ・不會洩漏資料(這支函式只寫不讀別人的東西),但會竄改別人的資料。
--   ・需要先知道一個 UUID,不是可以隨手掃出來的。
--   ・**目前曝險為零**:主腦查證正式環境 merchant_agents 的 user_id 為 NULL 筆數 = 0。
--     但只要商家邀請一位新客服、對方還沒註冊,這個洞就打開了。
--
-- 【修法】
-- 套用跟 20260924040900 三個分支完全一致的 null 安全寫法:
--   or (v_user_id is not null and auth.uid() is not null and v_user_id = auth.uid())
-- 這樣兩邊任一為 NULL 時整個 or 的右側是明確的 false,而不是 NULL。
--
-- 除了這一個判斷式,**其餘每一行完整照抄 20260924040800 的版本,一個字都沒動**
-- (簽章、參數、回傳型別、四個欄位的驗證與正規化、錯誤訊息文字全部不變),
-- 所以這支 migration 對「正常的管理員編輯」與「客服本人編輯」兩條路徑都沒有任何行為變化。
--
-- 簽章沒變 ⇒ 用 create or replace,不需要 drop(不會產生孤兒重載)。
-- create or replace 不會改動既有 ACL,下面的 revoke/grant 是幂等的,寫出來是為了讓這支函式的
-- 權限邊界在這份 migration 裡也看得到(.claude/skills/supabase-permission-hygiene 規則 1)。
-- =========================================================================

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
  --
  -- ⚠️⚠️ 三值邏輯防禦(2026-09-24 主腦巡檢補上,寫法跟 unbind_line_account 三個分支完全一致):
  --    merchant_agents.user_id 是 nullable(「已邀請但還沒註冊」的客服就是 NULL)。
  --    如果裸寫 `or v_user_id = auth.uid()`,當 v_user_id 是 NULL 時該比較的結果是 NULL,
  --    `false or NULL` = NULL、`not NULL` = NULL、`if NULL then` **不成立**
  --    → 這個 raise 根本不會執行,權限檢查被靜默跳過,任何已登入者只要知道那筆 id
  --      就能改別人的資料。
  --    所以兩邊都要先確認 is not null,讓結果是明確的 false 而不是 NULL。
  --    不要因為覺得囉唆而把這兩個 is not null 簡化掉。
  if not (
    private.is_merchant_admin(v_merchant_id)
    or (v_user_id is not null and auth.uid() is not null and v_user_id = auth.uid())
  ) then
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

comment on function public.update_merchant_agent(uuid, text, text, text, text) is '客服管理列表頁的「編輯」(2026-09-24 使用者裁決「客服可自行編輯或管理員可協助編輯」)。merchant_agents 只有 SELECT 的 RLS 政策、完全沒有 INSERT/UPDATE/DELETE 政策(刻意鎖成唯讀,所有寫入走 SECURITY DEFINER 函式),所以前端必須透過這支函式才改得動。授權:private.is_merchant_admin(該客服的 merchant_id) 或這筆紀錄本人(這一列自己的 user_id = auth.uid();刻意不用 is_merchant_agent,否則客服 A 能改客服 B)。只開放 name / nickname / phone / job_title 四個欄位,函式簽章本身不暴露其他欄位的參數,所以 status / user_id / invited_email / line_user_id / line_bound / pending_admin_login_email* 這些身分綁定與登入帳號欄位從介面上就不可能被改到。四個欄位在同一個 UPDATE 語句裡寫完,天然是原子交易。phone 先自行驗證 NOT NULL 與 ^09\d{8}$ 並給白話中文訊息;name 驗證非空白;nickname/job_title 空字串正規化成 NULL。⚠️【2026-09-24 拿掉 p_contact_email】使用者裁決三種「人」的角色只有一個 Email(登入 Email),contact_email 欄位已由 20260924040800 移除;public.merchants.contact_email(店家對外給消費者看的信箱)不受影響,一律保留。⚠️⚠️【2026-09-24 主腦巡檢補上三值邏輯防禦 —— 這是本批自己引入的漏洞,不是既有的】040500/040800 建立的版本把授權寫成 `if not (is_merchant_admin(...) or v_user_id = auth.uid())`,而 merchant_agents.user_id 是 nullable(「已邀請未註冊」的客服就是 NULL)。NULL 時該比較是 NULL、`false or NULL` = NULL、`not NULL` = NULL、`if NULL then` 不成立 ⇒ raise 不會執行、權限檢查被靜默跳過,任何已登入者只要知道那筆 merchant_agents.id 就能竄改對方的姓名/暱稱/電話/職位。已改成 `or (v_user_id is not null and auth.uid() is not null and v_user_id = auth.uid())`,跟 unbind_line_account 三個分支寫法完全一致。發現方式:修完 unbind_line_account 之後對正式環境做全庫掃查(剝掉 -- 註解後再找裸寫的 `or <變數> = auth.uid()`),掃出這一支。修補當下正式環境 user_id 為 NULL 的客服筆數 = 0,所以實際上沒有人被攻擊過。';

revoke execute on function public.update_merchant_agent(uuid, text, text, text, text) from public, anon;
grant  execute on function public.update_merchant_agent(uuid, text, text, text, text) to authenticated;
