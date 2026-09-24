-- 2026-09-24 使用者裁決:客服管理補上「編輯」與「恢復」兩個缺掉的功能。
--
-- =========================================================================
-- 【使用者裁決原文】
--   客服的聯絡 Email:「客服可自行編輯或管理員可協助編輯。」
--   「重新啟用…指的應該是移除後[恢復/真正刪除]按鈕的恢復對吧?如果是的話那就要增加恢復按鈕。」
--
-- 【為什麼一定要先有資料庫函式(不是前端自己寫寫就好)】
-- 已查證:public.merchant_agents 這張表**只有一條 SELECT 的 RLS 政策**
-- (20260916100000_staff_agent_schema.sql:230,`grep "create policy.*merchant_agents"` 只有一筆),
-- 完全沒有 INSERT/UPDATE/DELETE 政策。這是刻意鎖成唯讀的設計——所有寫入一律走 SECURITY DEFINER
-- 函式(record_invited_merchant_agent / remove_merchant_agent / mark_agent_active_if_self /
-- update_my_agent_profile / LINE 綁定那兩支 / 登入 email 那兩支)。
-- 所以前端不管怎麼寫都改不動這張表,必須先有函式。
--
-- 【跟既有 public.update_my_agent_profile 的關係(重要,不要搞混這兩條路)】
--   ・update_my_agent_profile(p_merchant_id, p_nickname, p_job_title)
--     —— 20260916170000:71,「首頁外殼」那批做的**客服自己改自己的暱稱與職位**。
--        它用 `where merchant_id = ... and user_id = auth.uid()` 鎖定本人,連 p_agent_id
--        都不收(呼叫者無法指定別人),只開放 nickname / job_title 兩個欄位。
--     —— **這次一行都不動它**(主腦明確要求,前端還在用)。
--   ・本次新增的 update_merchant_agent(p_agent_id, p_name, p_nickname, p_phone,
--     p_contact_email, p_job_title)
--     —— 是「客服管理**列表頁**的編輯」那條路:收 p_agent_id(所以管理員可以編輯**別人**),
--        授權條件是「該商家管理員 **或** 這筆紀錄本人」。
--
-- 【⚠️ p_job_title 是後來追加的,理由值得記下來(2026-09-24,前端工程師查證後主腦追加要求)】
-- 這支函式原本只收四個欄位(name/nickname/phone/contact_email),結果跟既有
-- update_my_agent_profile 形成「交集只有 nickname、聯集才湊得齊一張表單」的關係:
--       欄位            update_merchant_agent(原4欄)   update_my_agent_profile
--       name                    ✅                           ❌
--       nickname                ✅                           ✅   ← 唯一交集
--       phone                   ✅                           ❌
--       contact_email           ✅                           ❌
--       job_title               ❌                           ✅
-- 前端因此被迫「一次呼叫兩支 RPC」才存得完一張編輯表單,而那會產生「第一支成功、第二支失敗」
-- 的部分儲存狀態——一個不該存在的問題。補上 p_job_title 之後前端可以收斂成單一呼叫,
-- 而且天然是一個原子交易(單一 UPDATE 語句)。
-- job_title 本來就只是 merchant_agents 上的一個普通欄位,沒有理由自成一支函式。
--
-- 【對 update_my_agent_profile 的後續處置(留線索給之後的人)】
-- 補上 p_job_title 之後,update_my_agent_profile 能做的事(改自己的 nickname + job_title)
-- 已經被這支函式**完全涵蓋**——本人授權那條路徑就是為此保留的。所以等前端收斂到單一呼叫、
-- 確認沒有任何地方還在呼叫 update_my_agent_profile 之後,**那支函式就可以標記廢棄並移除**。
-- 「兩支函式都能寫 nickname」本身就是一個隱性的不一致來源(同一個欄位兩個入口、兩套授權判斷),
-- 留著遲早會有人只改其中一邊。這次不動它純粹是因為前端還在用,不是因為它該長期並存。
--
-- =========================================================================
-- 【restore_merchant_agent 的既有約束盤點(主腦要求先查證,以下是查證結果)】
--
-- (1) 既有的 public.remove_merchant_agent(uuid)(20260916100100:231)做的事:
--     檢查 private.is_merchant_admin(該筆的 merchant_id) → `update merchant_agents
--     set status = 'removed' where id = p_agent_id`。就這樣,**沒有**記錄「移除前是什麼狀態」,
--     也沒有清掉 user_id / activated_at / 權限列。所以「恢復」拿不到移除前的狀態,只能推論。
--
-- (2) 「同一個 email 不能重複啟用」之類的約束?**沒有 email 的唯一約束**。
--     merchant_agents 上唯一的 unique 是
--       merchant_agents_merchant_user_unique on (merchant_id, user_id) where user_id is not null
--     注意它**沒有**用 status 過濾 → 同一個 (商家, 登入帳號) 全表最多只能有一列,不分狀態。
--     這表示:恢復一筆 removed 紀錄**不可能**撞上「同一個人已經有另一筆在職紀錄」,
--     因為那第二筆根本插不進來。
--
-- (3) 而且既有的重新邀請流程本身就是「復用舊列」:
--     public.record_invited_merchant_agent(20260916100100:186-207)先用 (merchant_id, user_id)
--     查,查到 status='removed' 就 **update 既有那一列**把它改回 invited/active(註解原文:
--     「重新啟用舊的 removed 紀錄:更新既有列而不是插入新列,保留舊的權限設定」)。
--     也就是說「恢復」這個概念在後端早就存在,只是只能透過「重新寄一次邀請信」達成;
--     使用者要的是列表上一個直接的「恢復」按鈕,不用再跑一次邀請流程。
--     ⚠️ 所以 restore_merchant_agent 恢復之後,該客服**原本的 merchant_agent_permissions
--        權限設定會完整保留**(那些列是掛在同一個 agent_id 上,從頭到尾沒被刪過)。
--        這是好事,但要講清楚:恢復不是「重新給一張白紙」,是「把原本的權限一起復原」。
--
-- (4) 唯一真的可能撞到的情況(極端,但加了防呆):merchant_agents.user_id 是
--     `references auth.users(id) on delete set null`,如果那個 auth 帳號被刪掉,這一列的
--     user_id 會變成 null,此時 (merchant_id, user_id) 的 partial unique index 不再管它
--     (index 條件是 user_id is not null),商家就可能用同一個 email 再邀一位新客服產生第二列。
--     這種情況下恢復舊列會在畫面上出現兩筆同 email 的客服。§2 加了一道 invited_email 的重複
--     檢查擋下來,並給白話訊息。
--
-- 【⚠️ 我對契約做了一處刻意的調整,請主腦確認】
-- 主腦的契約寫「把 status 從 removed 改回 active」。我實作成:
--   ・activated_at is not null 且 user_id is not null → 'active'(這個人確實登入過)
--   ・其餘 → 'invited'(邀請信寄出過但本人從沒設定密碼,或登入帳號已經不存在)
-- 理由:status 的三種值是有明確語意的(20260916100000:93 的 CHECK + 表註解規則 2.7):
-- invited=「邀請信已寄出,本人還沒能登入」、active=「已能登入」。把一位從來沒接受邀請的客服
-- 恢復成 active,畫面上會顯示「已啟用」但他其實一天都沒登入過,而且
-- public.mark_agent_active_if_self()(20260916100100:267)的轉換條件是
-- `where user_id = auth.uid() and status = 'invited'` —— 狀態被寫成 active 之後,他之後真的去
-- 設定密碼登入時,這支函式撈不到他,他會永遠卡在一個不正確的狀態上。
-- 回傳型別是 merchant_agents 整列,前端直接讀回傳值裡的 status 就會拿到正確結果,
-- 所以這個調整不會打破前端契約,只是讓恢復後的狀態是對的。
-- 「一般情況」(真的在職過、被誤移除、要恢復)結果跟契約完全一致,就是 active。
--
-- 【禁止改到的欄位(這次兩支函式都嚴格遵守)】
-- status(只有 restore 能改,而且只能從 removed 改回來)、user_id、invited_email、
-- line_user_id、line_bound、pending_admin_login_email / _requested_by / _requested_at。
-- 這幾個是「身分綁定 / 登入帳號 / LINE 綁定」三組敏感欄位,各自有專屬的既有路徑
-- (record_invited_merchant_agent / bind_line_account / request_staff_login_email_change 等),
-- 不能從一個「編輯基本資料」的函式側面被改掉。
-- 做法:函式簽章本身就只收那四個欄位的參數(比照 update_my_staff_profile 的既有手法,
-- 註解原文:「函式簽章本身不暴露其他任何欄位的參數」),UPDATE 的 set 清單也只有那四欄——
-- 從介面上就不可能碰到別的欄位,不是靠執行時檢查。
-- =========================================================================

-- =========================================================================
-- §1 public.update_merchant_agent(p_agent_id, p_name, p_nickname, p_phone,
--                                 p_contact_email, p_job_title)
--     returns public.merchant_agents
--
-- ⚠️ 先 drop 舊的 5 參數版本再建立 6 參數版本(而不是直接 create or replace):
-- 這支函式在同一批開發中先寫成 5 個參數、才追加 p_job_title。PostgreSQL 把不同參數個數視為
-- **兩支不同的重載函式**,如果某個環境已經套用過 5 參數的版本,單純 create or replace 6 參數版
-- 會留下一支孤兒重載——而 PostgREST 對重載函式的解析會依送來的參數名挑選,留著它只會製造
-- 「有時候走到舊版」這種極難查的問題。加 if exists 所以在還沒套用過舊版的環境(本機 db reset、
-- pgTAP)也不會失敗。
-- =========================================================================
drop function if exists public.update_merchant_agent(uuid, text, text, text, text);

create or replace function public.update_merchant_agent(
  p_agent_id uuid,
  p_name text,
  p_nickname text,
  p_phone text,
  p_contact_email text,
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
  -- ⚠️ 前端目前 AgentListPage 整頁走 RequireMerchantAdmin,所以「本人可編輯」這條路徑暫時
  --    還沒有畫面入口(前端工程師已回報)。仍然保留這條授權,因為使用者明確要求「客服可自行編輯」,
  --    前端之後開入口時不需要再改資料庫。
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

  -- nickname / contact_email / job_title 空字串一律正規化成 NULL(比照 update_my_staff_profile 與
  -- update_my_agent_profile 的既有慣例 nullif(trim(coalesce(x,'')),''),避免存進一堆空字串)。
  -- job_title 為 NULL 時前端 fallback 顯示「客服」(見該欄位註解),所以清空是合法操作。
  -- contact_email 刻意**不**做格式驗證:merchant_agents.contact_email 本身沒有任何約束,
  -- 既有的 update_my_staff_profile 也沒有驗證 email 格式,這裡跟既有慣例保持一致,
  -- 不在這支函式裡單獨引入一套新規則(要加的話應該是全站一起加,屬於另一個題目)。
  --
  -- ⚠️ 五個欄位在**同一個 UPDATE 語句**裡寫完,所以天然是一個原子交易——這正是追加
  -- p_job_title 的主要目的(讓前端不必呼叫兩支 RPC,不會出現「第一支成功、第二支失敗」
  -- 的部分儲存狀態)。
  update public.merchant_agents
  set name = v_name,
      nickname = nullif(btrim(coalesce(p_nickname, '')), ''),
      phone = v_phone,
      contact_email = nullif(btrim(coalesce(p_contact_email, '')), ''),
      job_title = nullif(btrim(coalesce(p_job_title, '')), '')
  where id = p_agent_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_merchant_agent(uuid, text, text, text, text, text) is '2026-09-24 使用者裁決(客服的聯絡 Email:「客服可自行編輯或管理員可協助編輯。」):客服管理列表頁的「編輯」。merchant_agents 只有 SELECT 的 RLS 政策、完全沒有 INSERT/UPDATE/DELETE 政策(刻意鎖成唯讀,所有寫入走 SECURITY DEFINER 函式),所以前端必須透過這支函式才改得動。授權:private.is_merchant_admin(該客服的 merchant_id) 或這筆紀錄本人(這一列自己的 user_id = auth.uid();刻意不用 is_merchant_agent,否則客服 A 能改客服 B)。只開放 name / nickname / phone / contact_email / job_title 五個欄位,函式簽章本身不暴露其他欄位的參數(比照 update_my_staff_profile 的既有手法),所以 status / user_id / invited_email / line_user_id / line_bound / pending_admin_login_email* 這些身分綁定與登入帳號欄位從介面上就不可能被改到。五個欄位在同一個 UPDATE 語句裡寫完,天然是原子交易。phone 先自行驗證 NOT NULL 與 ^09\d{8}$(merchant_agents_phone_tw_mobile_format 約束)並給白話中文訊息,不讓商家看到資料庫原始的 check constraint 錯誤;name 驗證非空白;nickname/contact_email/job_title 空字串正規化成 NULL。contact_email 刻意不驗證格式,跟既有 update_my_staff_profile 的慣例一致。⚠️ p_job_title 是開發中追加的參數(原本只有四個欄位):不加的話它跟既有 update_my_agent_profile 會形成「交集只有 nickname、聯集才湊得齊一張表單」的關係,前端被迫一次呼叫兩支 RPC,會產生「第一支成功、第二支失敗」的部分儲存狀態。因為追加參數等於新的重載,這支 migration 在建立前先 drop 了舊的 5 參數版本,避免留下孤兒重載讓 PostgREST 有時候解析到舊版。⚠️ 後續處置:補上 p_job_title 之後,既有的 public.update_my_agent_profile(p_merchant_id, p_nickname, p_job_title)(客服自助改自己的暱稱/職位)能做的事已經被這支函式完全涵蓋(本人授權那條路徑就是為此保留),等前端收斂到單一呼叫、確認沒有任何地方還在呼叫它之後,那支函式就可以標記廢棄並移除。這次不動它純粹因為前端還在用,不是因為它該長期並存——「兩支函式都能寫 nickname」本身就是隱性的不一致來源。';

revoke execute on function public.update_merchant_agent(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.update_merchant_agent(uuid, text, text, text, text, text) to authenticated;

-- =========================================================================
-- §2 public.restore_merchant_agent(p_agent_id uuid) returns public.merchant_agents
-- =========================================================================
create or replace function public.restore_merchant_agent(p_agent_id uuid)
returns public.merchant_agents
language plpgsql
security definer
set search_path = public
as $$
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
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  if v_status <> 'removed' then
    raise exception '只有已移除的客服才需要恢復,這位客服目前的狀態不是已移除';
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
    raise exception '這個邀請 Email(%)目前已經有另一筆使用中的客服紀錄,無法恢復這一筆;如果要改用這一筆,請先移除另一筆',
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
$$;

comment on function public.restore_merchant_agent(uuid) is '2026-09-24 使用者裁決(「重新啟用…指的應該是移除後[恢復/真正刪除]按鈕的恢復對吧?如果是的話那就要增加恢復按鈕。」):把已移除(status=removed)的客服恢復回可用狀態,對應客服管理列表「已移除」分頁的「恢復」按鈕。只有 private.is_merchant_admin 可以呼叫(跟既有 remove_merchant_agent 同一個授權層級,否則被移除的客服自己就能把自己恢復)。⚠️ 恢復後的狀態不是無條件寫成 active:登入帳號還在且 activated_at 有值(確實啟用過)才是 active,其餘恢復成 invited——因為 status 的語意是 invited=邀請已寄出但還不能登入 / active=已能登入,把從沒接受邀請的人寫成 active 會讓 public.mark_agent_active_if_self()(條件是 status=invited)之後撈不到他,永久卡在錯誤狀態。一般情境(在職過、被誤移除)結果就是 active,跟原本的契約一致;回傳整列 merchant_agents,前端讀回傳值的 status 即可。activated_at / invited_at 刻意不重設(那是歷史事實,remove_merchant_agent 當初也沒清掉;要重新寄邀請信請走 record_invited_merchant_agent)。恢復會連帶復原這位客服原本的 merchant_agent_permissions 權限設定——那些列從頭到尾掛在同一個 agent_id 上、移除時沒被刪過,所以恢復不是給一張白紙。查證結果:merchant_agents 沒有任何 email 唯一約束,而 (merchant_id, user_id) where user_id is not null 的 partial unique index 不分狀態,所以正常情況不可能出現「同一個人兩筆在職紀錄」;只有舊列的 auth 帳號被刪除(user_id 被 on delete set null 清成 null)後商家又用同一個 email 邀新人才可能,函式對這個極端情況加了 invited_email 重複檢查並給白話訊息。';

revoke execute on function public.restore_merchant_agent(uuid) from public, anon;
grant execute on function public.restore_merchant_agent(uuid) to authenticated;
