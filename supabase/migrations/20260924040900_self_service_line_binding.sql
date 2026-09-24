-- 模組 11(LINE 通知)× 模組 14(服務人員端):讓服務人員自己完成 LINE 綁定/解除綁定。
--
-- =========================================================================
-- 【為什麼要做這次放寬】
-- =========================================================================
-- 模組 11 當初的「判斷 5」寫著:「服務人員的異動只有商家管理員能做,本人沒有登入帳號,不適用
-- 『本人』例外。」所以 3.6 generate_staff_line_binding_code 和 3.19 unbind_line_account 的
-- staff 分支都只認 private.is_merchant_admin。
--
-- 但模組 14(服務人員端)之後讓服務人員有了自己的登入帳號(merchant_staff.user_id +
-- login_status),上面那個前提已經不成立——後端函式卻沒有跟著放寬。結果是 2026-09-24 新建的
-- 服務人員端「個人資料」分頁籤上的 LINE 綁定卡片(src/modules/staff-portal/
-- MyStaffLineBindingCard.tsx)只能做成「唯讀」:放任何按鈕上去按了都必定跳 42501。
--
-- 使用者 2026-09-24 就這件事做出裁決,原話:
--
--     「B,要讓服務人員自己綁定。」
--
-- 這支 migration 就是實作這個裁決:服務人員可以自己產生綁定碼、自己解除綁定,
-- 完全不需要再向商家管理員索取 6 碼。
--
-- =========================================================================
-- 【為什麼是「新增一支窄函式」,不是「放寬既有的 get_merchant_line_config_status」】
-- =========================================================================
-- 綁定流程的前端畫面需要兩樣「商家層級」的資訊:
--   1. 這間商家到底有沒有串好 LINE(沒串好就不該顯示產生綁定碼的按鈕,按了也沒意義)
--   2. LINE 官方帳號的加好友連結來源(merchant_line_configs.line_bot_basic_id)
--
-- 這兩樣目前唯一的來源是 3.2 get_merchant_line_config_status,而它第一行就是
-- `if not private.is_merchant_admin(...) then raise 42501`——只有商家管理員能呼叫。
--
-- 我們刻意「不」放寬那一支,而是新增一支只回傳公開資訊的窄函式。理由:
--   ・get_merchant_line_config_status 是「串接管理」用的函式,它還會回傳
--     channel_access_token_masked(遮蔽過的 access token 尾四碼)、channel_id、
--     last_tested_at、last_test_result。那些是管理員在 LINE 設定頁排查串接問題要看的東西,
--     不是服務人員/客服需要知道的。
--   ・(已確認:它不會回傳 channel_secret 也不會回傳完整的 channel_access_token,所以現況
--     並沒有憑證洩漏問題。但「沒有洩漏」不等於「應該讓所有人看」——最小權限原則下,
--     只給呼叫端真正需要的三個欄位,比放寬一支回傳七個欄位的函式安全。)
--   ・放寬舊函式還會讓「這支函式的讀者是誰」變得模糊,之後有人往裡面多加一個敏感欄位時,
--     不會意識到自己同時把它送給了全商家的服務人員。窄函式讓這個邊界寫死在函式定義裡。
--
-- 所以:public.get_merchant_line_config_status 這次一個字都不改,維持管理員專用。
--
-- =========================================================================
-- 【順帶修掉的既有漏洞:unbind_line_account 的三值邏輯洞(admin / agent 兩個分支)】
--
-- 這支 migration 本來就要 create or replace unbind_line_account,所以一併修掉是零額外風險。
--
-- 漏洞本體:admin / agent 兩個分支的權限判斷原本是
--     if not (private.is_merchant_admin(v_merchant_id) or v_self_user_id = auth.uid()) then
--       raise exception … using errcode = '42501';
--
-- 當那一列的 user_id 是 NULL、而呼叫者又不是該商家管理員時:
--     v_self_user_id = auth.uid()   →  NULL = <uuid>            →  NULL
--     false or NULL                 →  NULL
--     not NULL                      →  NULL
--     if NULL then …                →  不成立,raise 不會執行
-- 也就是 **權限檢查被靜默跳過**,直接落到下面那行 UPDATE。
-- (SQL 的三值邏輯:`not (false or null)` 是 NULL,不是 true。這不是 plpgsql 特例。)
--
-- 誰真的受影響(已用 information_schema 逐表查證 user_id 的 nullability):
--   ・merchant_agents.user_id  → nullable(YES)  ⇒ **這一條是真的洞**。
--     「已邀請但還沒完成註冊」的客服 user_id 就是 NULL;如果他已經綁了 LINE,
--     任何已登入的使用者只要知道那筆 merchant_agents.id,就能解除他的 LINE 綁定。
--     嚴重度不高(不洩漏任何資料、只是讓對方收不到通知,而且要先知道一個 UUID),但它是真的洞。
--   ・merchant_admins.user_id  → NOT NULL(NO)  ⇒ 目前不可能觸發,但仍然一併套用同樣的防禦寫法。
--     理由:那個 NOT NULL 是「別的地方的約束」,將來任何一支 migration 放寬它,這個洞就會在
--     沒有任何人察覺的情況下打開 —— 這正是「靠別處的約束來保證這裡的正確性」這種隱性依賴的
--     典型後果。三個分支寫法一致,也比較不會被之後的人改壞。
--   ・member 分支不受影響:它走 private.can_manage_members(v_merchant_id),
--     沒有 `or … = auth.uid()` 這種寫法,所以一個字都不改。
--
-- 目前實際曝險 = 零(2026-09-24 對正式環境跑唯讀 SELECT 查證):
--     merchant_agents  共 2 筆,user_id is null 0 筆,line_bound = true 0 筆  → 可被利用 0 筆
--     merchant_admins  共 179 筆,user_id is null 0 筆,line_bound = true 0 筆 → 可被利用 0 筆
--     merchant_staff   共 124 筆,user_id is null 104 筆,line_bound = true 0 筆 → 可被利用 0 筆
-- 全系統目前沒有任何一筆 line_bound = true,所以現在無人可被攻擊;但它會在「有客服被邀請、
-- 綁了 LINE 卻還沒完成註冊」的那一刻打開。
--
-- ⚠️ 順帶注意 merchant_staff 那個 104:一旦這次的服務人員自助綁定上線,staff 分支的
--    nullable user_id 列數遠多於客服(104 vs 0)。所以 staff 分支從第一天就寫成 null 安全的
--    版本(而不是先照抄舊寫法再回頭修)是必要的,不是潔癖。
-- =========================================================================

-- =========================================================================
-- 【權限衛生】
-- =========================================================================
-- 2026-09-24 本專案剛做完一輪安全清理(把 anon 可呼叫的 SECURITY DEFINER 函式從 6 支降到 0),
-- 見 .claude/skills/supabase-permission-hygiene/SKILL.md 規則 1。這三支函式一律照既有慣例
-- 明確 revoke public, anon,只 grant 給 authenticated——不因為「新增函式」又開一個洞。

-- =========================================================================
-- (a) 新增 public.generate_own_staff_line_binding_code(p_merchant_id uuid)
--
-- ⚠️ 為什麼參數是 p_merchant_id、而不是像 3.6 那樣收 p_staff_id:
--    如果讓前端傳 staff_id,就等於開了一個「服務人員可以幫同商家的別人產生綁定碼」的洞——
--    拿到別人的 6 碼之後,攻擊者可以用自己的 LINE 帳號去消費那組碼,把別人的通知收件人
--    換成自己(訂單通知含客戶姓名/電話/地址/金額)。函式內部檢查「這個 staff_id 是不是我」
--    也不夠好:那要求每個呼叫端都記得傳對的 id,而且錯誤訊息會洩漏「這個 id 存在」。
--    正確做法是讓函式自己用 auth.uid() 解析出「我在這間商家的那一列」,
--    前端在協定層面就沒有辦法指定別人。
--
-- 其餘行為(6 碼數字、10 分鐘效期、寫進 public.line_binding_codes、產生新碼時讓同目標舊碼
-- 立刻失效)完全比照既有的 3.6 generate_staff_line_binding_code —— 做法是共用同一支
-- private.issue_line_binding_code(所有規則都在那支裡面),不是抄一份規則出來各自維護。
-- =========================================================================
create or replace function public.generate_own_staff_line_binding_code(p_merchant_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
begin
  -- 「在職(status)且已開通登入(login_status)」這組條件跟 private.is_merchant_staff 完全一致
  -- (也就是模組 14 所有自助功能認定的「能用服務人員端的人」)。這裡不呼叫那支函式而是直接
  -- 查詢,單純因為下一步需要那一列的 id,不是另立一套判斷標準。
  -- merchant_staff 有 (merchant_id, user_id) where status = 'active' 的唯一索引
  -- (merchant_staff_merchant_user_unique),所以這個查詢最多只會有一列。
  select id into v_staff_id
  from public.merchant_staff
  where merchant_id = p_merchant_id
    and user_id = auth.uid()
    and status = 'active'
    and login_status = 'active';

  if v_staff_id is null then
    raise exception '你不是這間商家目前在職、且已開通登入的服務人員' using errcode = '42501';
  end if;

  return query select * from private.issue_line_binding_code(p_merchant_id, 'staff', v_staff_id, auth.uid());
end;
$$;

comment on function public.generate_own_staff_line_binding_code(uuid) is '2026-09-24 使用者裁決「要讓服務人員自己綁定」:在職且已開通登入的服務人員幫自己產生 LINE 綁定碼。刻意只收 p_merchant_id、由函式內部用 auth.uid() 解析出自己的 merchant_staff.id,前端無法指定別人(避免「幫別人產生綁定碼」造成的通知收件人劫持)。綁定碼規則(6 碼/10 分鐘/舊碼失效)共用 private.issue_line_binding_code,跟 3.6 完全一致。';

revoke execute on function public.generate_own_staff_line_binding_code(uuid) from public, anon;
grant  execute on function public.generate_own_staff_line_binding_code(uuid) to authenticated;

-- =========================================================================
-- (b) 放寬 public.unbind_line_account 的 staff 分支:管理員「或本人」。
--
-- ⚠️ 用 create or replace,不 drop:這次只改函式內部的權限判斷,參數型別/參數名稱/回傳型別
--    完全沒動(仍然是 (p_target_type text, p_target_id uuid) returns void),所以 create or
--    replace 就足夠。本專案踩過「drop/create 換簽章後 PostgREST 留下孤兒 overload,導致
--    /rest/v1/rpc 呼叫解析到錯的那一支」的坑(見 20260924040500 對 update_merchant_agent 的
--    處理),但那個坑的觸發條件是「簽章真的變了」。這裡多餘地 drop 反而有壞處:
--    drop 會一併丟掉現有的 EXECUTE 權限設定(見 permission-hygiene 規則 1 的
--    recalculate_booking_commission 案例),等於自己製造一個要記得補回來的風險。
--    為了完整性,下面仍然把 revoke/grant 原樣重寫一次(create or replace 不會改動既有 ACL,
--    這兩行是幂等的,寫出來是為了讓「這支函式的權限邊界」在這份 migration 裡也看得到)。
--
-- admin / agent 兩個分支除了套用三值邏輯防禦(見檔頭§「順帶修掉的既有漏洞」)之外沒有任何
-- 行為變化;member 分支一個字都不改。
-- =========================================================================
create or replace function public.unbind_line_account(p_target_type text, p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_self_user_id uuid;
begin
  if p_target_type not in ('admin', 'agent', 'staff', 'member') then
    raise exception '不支援的綁定目標類型: %', p_target_type;
  end if;

  if p_target_type = 'admin' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_admins where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位管理員';
    end if;
    -- ⚠️ 三值邏輯防禦(三個分支寫法刻意完全一致,見檔頭§「順帶修掉的既有漏洞」):
    --    裸寫 `or v_self_user_id = auth.uid()` 在兩邊都是 NULL 時,該比較的結果是 NULL,
    --    `not (false or NULL)` = NULL,而 `if NULL then` 不成立 → raise 不會觸發、權限檢查被靜默
    --    跳過。merchant_admins.user_id 目前是 NOT NULL 所以這裡現在不可能發生,但那個 NOT NULL
    --    是「別的地方的約束」,將來任何一支 migration 放寬它,這個洞就會在沒人察覺的情況下打開。
    --    不要因為覺得囉唆而把這兩個 is not null 簡化掉。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_admins set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'agent' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_agents where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位客服';
    end if;
    -- ⚠️ 三值邏輯防禦 —— **這一條是真的在修一個既有漏洞,不是預防性加固**(見檔頭§「順帶修掉的
    --    既有漏洞」):merchant_agents.user_id 是 nullable(login 尚未註冊的「已邀請」客服就是
    --    NULL)。原本裸寫 `or v_self_user_id = auth.uid()`,當那筆客服的 user_id 是 NULL 時,
    --    `not (false or NULL)` = NULL、`if NULL then` 不成立 → raise 不會觸發,任何已登入者
    --    只要知道那筆 merchant_agents.id 就能解除他的 LINE 綁定。
    --    不要因為覺得囉唆而把這兩個 is not null 簡化掉。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_agents set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'staff' then
    -- 2026-09-24 放寬(使用者裁決「要讓服務人員自己綁定」):原本只允許 private.is_merchant_admin,
    -- 現在加上「本人」。「本人」一律用 auth.uid() 對照 merchant_staff.user_id 判斷,
    -- 完全不信任前端傳來的任何 id —— 前端只能指定「要解除哪一列」,而那一列必須是它自己。
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_staff where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位服務人員';
    end if;

    -- ⚠️ 三值邏輯防禦 —— 這裡同樣是真的會發生,不是預防性加固:
    --    merchant_staff.user_id 是 nullable(login_status = 'not_invited' 的服務人員還沒有登入
    --    帳號)。裸寫 `v_self_user_id = auth.uid()` 在兩邊都是 NULL 時該比較是 NULL,
    --    `not (false or NULL)` = NULL、`if NULL then` 不成立 → 權限檢查被靜默跳過。
    --    (這次 staff 分支是新放寬的,所以這個洞從來沒有真的打開過;但 agent 分支的同樣寫法
    --     已經是線上的既有漏洞,見檔頭§「順帶修掉的既有漏洞」。三個分支現在寫法完全一致。)
    --    不要因為覺得囉唆而把這兩個 is not null 簡化掉。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '只有商家管理員或這位服務人員本人可以解除這個 LINE 綁定' using errcode = '42501';
    end if;

    -- 已經完成權限檢查(管理員 or 本人),這是規則 2.9 觸發器
    -- private.protect_merchant_staff_line_binding_columns 明確允許的合法例外路徑
    -- (見 20260920160000 schema 檔對這個觸發器的註解)。旗標是 transaction-local
    -- (set_config 第三參數 true),這個函式呼叫所在的交易結束就自動失效,不會外溢影響
    -- 同一個資料庫連線之後的其他語句。
    perform set_config('line_notifications.bypass_staff_binding_guard', 'on', true);
    update public.merchant_staff set line_user_id = null, line_bound = false where id = p_target_id;
    perform set_config('line_notifications.bypass_staff_binding_guard', 'off', true);

  elsif p_target_type = 'member' then
    select merchant_id into v_merchant_id from public.members where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位會員';
    end if;
    if not private.can_manage_members(v_merchant_id) then
      raise exception '沒有權限管理這位會員' using errcode = '42501';
    end if;
    update public.members set line_user_id = null, line_bound = false where id = p_target_id;
  end if;
end;
$$;

comment on function public.unbind_line_account(text, uuid) is '規則 2.8 反向操作/3.19:解除 LINE 綁定。admin/agent 允許管理員或本人;staff 自 2026-09-24 使用者裁決「要讓服務人員自己綁定」起,同樣允許「管理員或本人」(本人一律用 auth.uid() 對照 merchant_staff.user_id 判斷,不信任前端傳來的 id;實際欄位異動透過 line_notifications.bypass_staff_binding_guard 這個 transaction-local 旗標合法放行規則 2.9 觸發器);member 檢查 can_manage_members。2026-09-24 同時修掉一個既有的三值邏輯漏洞:admin/agent 分支原本裸寫 `or v_self_user_id = auth.uid()`,當該列 user_id 為 NULL(merchant_agents.user_id 是 nullable,「已邀請未註冊」的客服就是 NULL)時 not (false or NULL) = NULL,if NULL then 不成立 → 權限檢查被靜默跳過,任何已登入者只要知道那筆 id 就能解除對方的綁定。三個分支現在都用 (user_id is not null and auth.uid() is not null and user_id = auth.uid()) 的 null 安全寫法。';

revoke execute on function public.unbind_line_account(text, uuid) from public, anon;
grant  execute on function public.unbind_line_account(text, uuid) to authenticated;

-- =========================================================================
-- (c) 新增 public.get_merchant_line_bot_public_info(p_merchant_id uuid)
--
-- 只回傳「這間商家有沒有串好 LINE」跟「加好友連結需要的官方帳號 ID」,共三個欄位:
--   is_connected       —— 商家是否已完成串接並通過測試連線
--   display_name       —— LINE 官方帳號的顯示名稱(給畫面上寫「加 XXX 好友」用)
--   line_bot_basic_id  —— 組加好友連結 https://line.me/R/ti/p/@<basic_id> 用
--
-- 刻意「不」回傳的欄位(對照 merchant_line_configs 的完整欄位清單逐一確認):
--   channel_id / channel_secret / channel_access_token / line_bot_user_id /
--   last_tested_at / last_test_result / created_at / updated_at
-- 特別是 channel_secret 與 channel_access_token 這兩個真正的憑證:這支函式從頭到尾
-- 沒有讀取這兩個欄位(連遮蔽版本都沒有),所以不存在「不小心洩漏一部分」的可能。
--
-- 查無 merchant_line_configs 那一列時回傳「尚未串接」的預設物件、不拋錯 —— 行為比照既有的
-- 3.2 get_merchant_line_config_status,讓前端只需要處理一種形狀。
-- =========================================================================
create or replace function public.get_merchant_line_bot_public_info(p_merchant_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_row public.merchant_line_configs;
begin
  -- 允許:這間商家的在職管理員(含集團管理者)/ 在職客服 / 在職且已開通登入的服務人員。
  -- 三支判斷都是既有的 private helper,不自己另寫一套條件:
  --   private.is_merchant_admin —— 含集團管理者自動取得的權限(規則 2.4)
  --   private.is_merchant_agent —— 已內含 status = 'active'(規則 2.9 第 1 點)
  --   private.is_merchant_staff —— 已內含 status = 'active' and login_status = 'active'
  -- 刻意不要求客服另外被授權 line_notification:這支函式回傳的是「加好友連結」層級的公開
  -- 資訊,任何在職成員綁定自己的 LINE 都會用到,跟「管理商家的 LINE 通知設定」是兩件事。
  if not (
    private.is_merchant_admin(p_merchant_id)
    or private.is_merchant_agent(p_merchant_id)
    or private.is_merchant_staff(p_merchant_id)
  ) then
    raise exception '沒有權限查詢這間商家的 LINE 官方帳號資訊' using errcode = '42501';
  end if;

  select * into v_row from public.merchant_line_configs where merchant_id = p_merchant_id;

  if v_row.merchant_id is null then
    return jsonb_build_object(
      'is_connected', false,
      'display_name', null,
      'line_bot_basic_id', null
    );
  end if;

  return jsonb_build_object(
    'is_connected', v_row.is_connected,
    'display_name', v_row.display_name,
    'line_bot_basic_id', v_row.line_bot_basic_id
  );
end;
$$;

comment on function public.get_merchant_line_bot_public_info(uuid) is '2026-09-24 新增:只回傳 LINE 官方帳號的「公開資訊」三個欄位(is_connected / display_name / line_bot_basic_id),供在職管理員/客服/服務人員做自助 LINE 綁定時取得加好友連結與「商家有沒有串好」的判斷依據。刻意不回傳任何憑證相關欄位(channel_id / channel_secret / channel_access_token / line_bot_user_id)或串接排查資訊(last_tested_at / last_test_result)——那些留在管理員專用的 3.2 get_merchant_line_config_status,那一支這次完全沒有放寬。';

revoke execute on function public.get_merchant_line_bot_public_info(uuid) from public, anon;
grant  execute on function public.get_merchant_line_bot_public_info(uuid) to authenticated;
