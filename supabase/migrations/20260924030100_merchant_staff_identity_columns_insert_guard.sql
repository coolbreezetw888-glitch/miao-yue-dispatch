-- 2026-09-24 使用者裁決修補(登入帳號的權限邊界:INSERT 面也要擋)。
--
-- =========================================================================
-- 【使用者裁決原文】
--   「登入帳號(Email)除了管理員與服務人員本身可以修改,其餘角色都沒有權限。」
--
-- 【前一支修補做了什麼、漏了什麼】
-- 20260924020100_merchant_staff_identity_columns_guard.sql 新增了
-- private.protect_merchant_staff_identity_columns() + merchant_staff_protect_identity_columns
-- 觸發器,擋下「非商家管理員」修改 merchant_staff.user_id / login_status。
-- 但那支觸發器只掛在 **BEFORE UPDATE**,INSERT 面完全沒有保護。
--
-- 【剩下的缺口(逐步查證過)】
--   1. merchant_staff_insert 政策(最新版在 20260924020000_security_revoke_execute_and_policy_roles.sql:97)
--      是 `with check (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id))`
--      —— 被授權 staff_management 的客服可以新增服務人員。
--   2. RLS 的 INSERT 政策跟 UPDATE 政策一樣是「整列」層級的,沒有辦法限制「可以帶哪些欄位」。
--   3. 於是客服可以直接打 POST /rest/v1/merchant_staff,body 帶
--      {"merchant_id":"<本店>","name":"人頭","phone":"09...","user_id":"<客服自己的 auth uid>",
--       "login_status":"active"},憑空新增一筆「綁在自己帳號上、而且已開通登入」的服務人員紀錄。
--   4. 從那一刻起 private.is_own_staff_row(<那筆新紀錄的 id>) 對這個客服成立
--      (is_own_staff_row 同時要求 status='active' 且 login_status='active',第 3 步兩個條件都
--       自己填滿了),於是他可以呼叫 get_staff_monthly_payroll_summary /
--       get_staff_commission_summary / get_my_booking_schedule 等「本人限定」的函式。
--      —— 跟前一支修補要擋的是同一種提權,只是換成「新增一筆假的自己」而不是「改掉別人的」。
--
-- 【為什麼前端沒有踩到,但還是要修】
-- src/modules/staff-agent/api.ts:109 的新增流程(createMerchantStaff)送出的欄位裡沒有
-- user_id / login_status(逐欄確認過),所以正常從畫面操作完全不受影響。
-- 這是 **API 層**(PostgREST 直打)的缺口,不是畫面上的缺口——而 PostgREST 是對外公開的,
-- 任何拿到自己 access token 的客服都能直接打。
--
-- 【修法:擴充既有那一支觸發器函式,而不是另寫一支】
-- 理由:保護的是「同一組欄位、同一條規則」(user_id / login_status 只有商家管理員能碰)。
-- 拆成兩支函式會讓之後改規則的人只改到一半——這正是這次要修的問題本身(上一支只做了 UPDATE)。
-- 觸發器改掛 `before insert or update`,函式內部用 tg_op 分流。
--
-- ⚠️ INSERT 時 old 是 NULL,不能沿用 `new.xxx is distinct from old.xxx`
--    (對 NULL record 取欄位在 plpgsql 觸發器裡會直接 raise),所以兩個分支的判斷式分開寫:
--      ・UPDATE:值有沒有被改動 → new.xxx is distinct from old.xxx
--      ・INSERT:有沒有「帶了非預設值」→ 拿 schema 的實際預設值來比
--
-- 【欄位預設值(已查 schema 確認,不是憑印象)】
--   ・user_id:20260916100000_staff_agent_schema.sql 的 create table 裡沒有 default,
--     也不是 not null → 預設 NULL。所以「帶了非預設值」= new.user_id is not null。
--   ・login_status:20260921100000_staff_portal_schema.sql:12
--     `add column login_status text not null default 'not_invited'`
--     → 預設 'not_invited'。所以「帶了非預設值」= 值不是 'not_invited'。
--     (not null 欄位理論上不會是 NULL,還是用 coalesce 包一層,萬一之後 schema 變動也不會誤擋。)
-- =========================================================================

-- =========================================================================
-- §1 合法 INSERT 路徑的盤點結果
--     (這一步做錯會讓「新增服務人員」或「邀請登入」整個壞掉,所以逐一查過所有可能的來源)
--
--  (1) 資料庫函式 —— 一支都沒有。
--      `grep -rn "insert into (public\.)?merchant_staff\b" supabase/migrations` 結果為零列:
--      整個 migrations 裡沒有任何函式會 INSERT merchant_staff(只有 merchant_staff_permissions
--      的 INSERT,那是另一張表)。邀請流程走的是 **UPDATE**
--      (public.record_invited_staff_login,20260921100400:34 起,update ... set user_id=...),
--      不是 INSERT——所以邀請流程根本不會碰到這次新增的 INSERT 判斷,不可能被誤擋。
--
--  (2) Edge Function invite-merchant-staff(supabase/functions/invite-merchant-staff/index.ts)
--      —— 它對 merchant_staff 只做 select(:132 查 staff_id 是否屬於這間商家),
--      寫入一律透過 record_invited_staff_login(:188,UPDATE 路徑),不自己 INSERT。
--      而且它用 service_role 呼叫,就算之後改成 INSERT 也會被第一道
--      `auth.role() <> 'service_role'` 放行。
--
--  (3) 前端 src/modules/staff-agent/api.ts:109 createMerchantStaff(客服/管理員的「新增服務人員」)
--      —— 送出 merchant_id / name / nickname / phone / contact_email / intro / avatar_url /
--         is_listed / 各種預約設定旗標 / compensation_type,**沒有** user_id、**沒有**
--         login_status。這是最重要的一條:被授權 staff_management 的客服的正常新增流程
--         完全不帶這兩個欄位,判斷式對他一律為 false,照樣新增成功。
--         下方 pgTAP 測試把這一條釘成回歸保護。
--
--  (4) e2e 測試 fixture(e2e/support/*.ts)—— 逐檔確認過,所有 .from("merchant_staff").insert()
--      都沒有帶 user_id / login_status,而且全部用 adminClient(service_role key)執行,
--      兩層都不會被擋。
--
--  (5) pgTAP 測試 fixture(supabase/tests/database/*.sql)—— 有好幾支會直接
--      `insert into merchant_staff (..., user_id, login_status, ...)`
--      (module14_01/02/03、module15_01、module3_02、login_email_security_01、
--       security_audit_02 等)。這些 INSERT 都是以 postgres 身分執行、沒有設定
--       request.jwt.claims,此時 auth.role() 回傳 NULL,`NULL <> 'service_role'` 為 NULL,
--       整個 AND 條件鏈的結果是 NULL,`if NULL then` 不成立 → 不會拋錯。
--       這跟前一支 UPDATE 觸發器上線後既有測試依然全綠的原因是同一個,不是這次新引入的行為。
--
--  結論:目前這個 codebase 裡「合法且會帶 user_id / login_status 的 INSERT」路徑一條都沒有。
--  這次的 INSERT 判斷擋掉的,是一條純粹只有攻擊者才會走的路。
-- =========================================================================

create or replace function private.protect_merchant_staff_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  -- 這次的異動有沒有碰到「身分綁定」欄位(INSERT/UPDATE 判斷方式不同,見檔頭)。
  v_touches_identity boolean;
  -- 要拿哪一個 merchant_id 去問 is_merchant_admin。
  v_merchant_id uuid;
begin
  -- ⚠️ 保護清單刻意「只有」user_id 與 login_status 這兩欄。不要在這裡順手加上
  -- status / compensation_type(理由見 20260924020100 檔頭「為什麼只保護這兩欄」:
  -- 那兩欄不構成提權路徑,而且 status 是使用者 2026-09-23 明確授權給客服的「軟刪除」功能)。
  if tg_op = 'INSERT' then
    -- INSERT:old 是 NULL,不能寫 `is distinct from old.xxx`。
    -- 判斷「有沒有主動帶了非預設值」——預設值以 schema 實際宣告為準(見檔頭)。
    v_touches_identity := (new.user_id is not null)
      or (coalesce(new.login_status, 'not_invited') <> 'not_invited');
    -- INSERT 沒有 old,只能用 new.merchant_id;merchant_staff_insert 政策的 with check
    -- 已經確認呼叫者對這個 merchant_id 有管理權,這裡再問「是不是管理員」是第二層。
    v_merchant_id := new.merchant_id;
  else
    v_touches_identity := (new.user_id is distinct from old.user_id)
      or (new.login_status is distinct from old.login_status);
    -- UPDATE 用 old.merchant_id(這一列「目前」歸屬的商家),不用 new.merchant_id——避免
    -- 「先把列搬到自己也管得到的另一間商家、同時改 user_id」這種組合技(merchant_id 的變更
    -- 本來就已經被 merchant_staff_update 的 with check 擋住,這裡再多一層保險)。
    v_merchant_id := old.merchant_id;
  end if;

  if v_touches_identity
     -- 第一道繞道(保留自 20260924020100):Edge Function / 後台維運走 service_role。
     -- 目前唯一的使用者是 public.record_invited_staff_login(UPDATE 路徑,見 §1 (1)(2))。
     and auth.role() <> 'service_role'
     -- 第二道繞道(保留自 20260924020100):已經自行完成權限檢查的 SECURITY DEFINER 函式,
     -- 在真正要寫入前用 set_config 短暫打開這個 transaction-local 旗標。
     -- 目前唯一的使用者是 public.mark_staff_login_active_if_self()(UPDATE 路徑)。
     and coalesce(current_setting('staff_agent.bypass_staff_identity_guard', true), 'off') <> 'on'
     -- 主要判斷:這兩個欄位只有商家管理員能碰。
     and not private.is_merchant_admin(v_merchant_id)
  then
    if tg_op = 'INSERT' then
      raise exception '只有商家管理員可以在新增服務人員時指定登入帳號或登入狀態'
        using errcode = '42501';
    else
      -- ⚠️ 這段訊息文字跟 20260924020100 一字不差,既有的
      -- security_audit_02_merchant_staff_identity_guard.sql 用 throws_ok 比對過它,不要改。
      raise exception '只有商家管理員可以變更服務人員綁定的登入帳號或登入狀態'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

comment on function private.protect_merchant_staff_identity_columns() is '2026-09-24 安全修補(A3 + INSERT 面補強):擋下非商家管理員對 merchant_staff.user_id / login_status 的寫入,INSERT 與 UPDATE 兩面都擋。UPDATE 面(原 A3):RLS 的 merchant_staff_update 是整列層級,被授權 staff_management 的客服可以把某位師傅的 user_id 改成自己,藉此透過 private.is_own_staff_row 取得該師傅的薪資/抽成/客戶個資。INSERT 面(本次):merchant_staff_insert 同樣是整列層級,客服可以直接打 PostgREST 新增一筆 user_id=自己、login_status=active 的紀錄,憑空造出「一個自己」拿到同樣的資料。判斷方式在兩個 tg_op 下不同——UPDATE 看「值有沒有被改動」(is distinct from old),INSERT 看「有沒有帶非預設值」(user_id 預設 NULL、login_status 預設 not_invited),因為 INSERT 時 old 是 NULL 不能沿用。保護清單刻意只有這兩個「身分綁定」欄位——status(軟刪除)是使用者 2026-09-23 明確授權給客服的功能,compensation_type 不構成提權路徑。放行路徑仍是兩條:service_role,以及 transaction-local 旗標 staff_agent.bypass_staff_identity_guard。經盤點,目前沒有任何合法路徑會帶著 user_id/login_status 去 INSERT merchant_staff(邀請流程走 record_invited_staff_login 的 UPDATE),前端 createMerchantStaff 也不帶這兩欄,所以客服的正常新增流程不受影響。';

-- 觸發器改掛 before insert or update(原本只有 before update)。
-- 名稱維持 merchant_staff_protect_identity_columns 不變:
-- security_audit_02_merchant_staff_identity_guard.sql 最後一條測試用這個名字檢查觸發器存在。
drop trigger if exists merchant_staff_protect_identity_columns on public.merchant_staff;

create trigger merchant_staff_protect_identity_columns
  before insert or update on public.merchant_staff
  for each row execute function private.protect_merchant_staff_identity_columns();
