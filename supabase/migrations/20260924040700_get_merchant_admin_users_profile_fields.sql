-- 2026-09-24 使用者裁決:管理員名單要看得到聯絡方式(商家端 + 超級管理員端)。
--
-- =========================================================================
-- 【使用者裁決】
--   (a) 超級管理員後台要看得到管理員的電話/Email → 使用者回覆:「要」。
--       理由(前一則原文):「以我這個廠商視角」——他是平台方,需要掌握每位商家管理員的聯絡方式。
--   (b) 商家管理員名單要顯示這幾欄 → 使用者回覆:「要」,但自己備註「這個我不確定回答的正不正確,
--       因為你的描述我不是很清楚」。
--
-- ⚠️ 【2026-09-24 同日後續裁決:不回傳 contact_email】
--   這支 migration 原本除了 display_name / job_title / phone,還要回傳 merchant_admins.contact_email。
--   使用者看過實際畫面後推翻了「一個人有兩個 Email」這個設計,原話:
--     「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
--     「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--   所以三種「人」的角色都只有**一個** Email,就是這支函式本來就在回傳的 `email`
--   (來自 auth.users,登入帳號)。merchant_admins 從此沒有 contact_email 這個欄位
--   (20260924040600 改成只加 phone),merchant_staff / merchant_agents 的則由
--   20260924040800_drop_person_contact_email.sql 移除。
--   ⚠️⚠️ 這個決定**不**適用於 public.merchants.contact_email(店家對外給消費者看的信箱,
--        店家本身沒有登入帳號),那個一律保留,詳見 20260924040800 檔頭。
--
-- =========================================================================
-- 【⚠️ 查證後的關鍵結論:(a) 和 (b) 是同一個改動,一行就同時滿足,而且不需要新增任何函式】
--
-- 動工前逐一查證的結果:
--
-- 1. public.get_merchant_admin_users(p_merchant_id) 的**最新版本**(20260915120200:14,模組 2
--    規格書功能 3.3)權限檢查已經是:
--        if not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin())
--    → **超級管理員早就可以呼叫這支函式了**,不需要另外做一支
--      platform_get_merchant_admin_contacts,也不需要動 merchant_admins 的 RLS。
--    (開發過程中曾在 20260924040600 §3 建議「新增一支 platform_get_merchant_admin_contacts」,
--     那是在只看到 20260915110000 那個較舊版本時的判斷;查到 20260915120200 才發現放寬早就做過了。
--     這裡不新增那支函式,因為它會是重複的第二條路。)
--
-- 2. 前端**兩個畫面共用同一個 hook、同一支函式**:
--      ・商家端    src/modules/merchant/MerchantSettingsPage.tsx:369 → <MerchantAdminList>
--                 → useMerchantAdmins() → fetchMerchantAdminUsers() → get_merchant_admin_users
--      ・超級管理員 src/modules/platform-admin/MerchantDetailPage.tsx:78 → useMerchantAdmins(id)
--                 (該檔案第 2 行註解原文:「管理員名單沿用模組 1 現成的 useMerchantAdmins
--                  (見規則 2.3:查詢邏輯不重工)」)
--    → 所以只要把欄位加進這支函式的回傳,(a)(b) 同時成立。
--
-- 3. 沒有任何資料庫內部依賴這支函式(grep 過 migrations/functions,只有註解提到它),
--    所以可以安全 drop + create(改 RETURNS TABLE 必須 drop,不能 create or replace)。
--
-- 【這對 (b) 那個「使用者不確定自己有沒有聽懂」的風險意味著什麼 —— 重要】
-- 因為 (a) 本身就**必須**做這個改動(超級管理員要看到聯絡方式,資料就得從這支函式回傳出來),
-- 所以這支 migration 不論 (b) 的答案是什麼都要做。
-- 而「商家端那張名單上到底要不要把這幾欄顯示出來」純粹是**前端顯示決策**——資料庫多回傳幾個
-- 欄位,前端可以顯示也可以不顯示。萬一使用者其實誤會了 (b) 的意思,只要前端不渲染那幾欄就好,
-- **不需要回頭改資料庫**。這件事已在回報中講明,讓主腦不必卡在 (b) 的確認上。
--
-- =========================================================================
-- 【隱私邊界:這算不算跨越模組 2 規則 2.3 刻意畫下的界線?—— 不算,理由如下】
-- 20260915120100_platform_admin_rls_overlay.sql:8-11 明文決定「不疊加 merchant_admins 的 RLS 政策」,
-- 20260915120400 的 platform_get_merchant_admin_counts 也明講「只回傳筆數,不含 email,
-- 不擴大既有的 email 曝光範圍」。
-- (順帶一提:這次只多回傳 display_name / job_title / phone 三個欄位,**沒有**新增任何 email 欄位
--  ——`email` 這一欄 20260915120200 就在回傳了,曝光範圍完全沒變。)
-- 但那兩條講的是「不要開放超級管理員**直接對表做 RLS 讀寫**」,而模組 2 規格書功能 3.3 本身
-- 就已經明確放寬 get_merchant_admin_users 讓超級管理員看得到管理員清單**含登入 email**。
-- 也就是說:「超級管理員透過 SECURITY DEFINER 函式看得到商家管理員是誰、email 是什麼」
-- 是既有的、刻意的設計。這次只是在同一條既有路徑上多回傳幾個 profile 欄位,
-- 走的是同一套設計語言(函式把關,不放寬 RLS),不是新開一條路。
--
-- 【範圍限制:只做「看得到」,不做「可以編輯」】
-- 主腦明確要求,使用者也沒要求編輯。這支 migration 只改一支 **stable / 唯讀**的查詢函式,
-- 完全沒有新增任何寫入路徑。超級管理員要改商家管理員的聯絡方式,目前做不到也不該做——
-- 那些欄位只有管理員本人能透過 update_my_admin_profile 修改(所有權判斷)。
--
-- =========================================================================
-- 【順便補上 display_name / job_title:同一個缺口,不分兩次改】
-- 這支函式原本只回傳 (id, merchant_id, user_id, email, created_at)——連 2026-09-16 就已經存在的
-- display_name / job_title 都沒有回傳。所以商家的管理員名單上只看得到一串**登入 email** 和加入
-- 日期,看不到「這個人叫什麼名字、是什麼職位」(有多位管理員時根本分不出誰是誰)。
-- 既然這次要動這支函式的回傳形狀,三個 profile 欄位一次補齊,不要為了同一個缺口改兩次
-- (每改一次回傳形狀,前端型別 + types.ts 就要重新產生一次)。
--
-- 【回傳形狀是「超集」,既有前端不會壞】
-- 新增欄位不會影響既有前端:MerchantAdminUser 型別(src/modules/merchant/types.ts:45)原本只宣告了
-- 5 個欄位,多回傳的欄位會被忽略。這跟 update_my_admin_profile 追加參數那個**破壞性**改動不同
-- (那個會讓舊的 3 參數呼叫直接失敗),這支是**相容**的擴充。
-- =========================================================================

-- ⚠️ 改 RETURNS TABLE 必須先 drop(create or replace 不允許變更回傳型別)。
-- drop + create 會**重置函式權限**,所以下面務必重新宣告 revoke/grant
-- (.claude/skills/supabase-permission-hygiene 規則 1;20260915120300_platform_admin_public_revoke_fix
--  就是當初漏掉這件事才需要補的那支 migration,不要重蹈)。
drop function if exists public.get_merchant_admin_users(uuid);

create or replace function public.get_merchant_admin_users(p_merchant_id uuid)
returns table (
  id uuid,
  merchant_id uuid,
  user_id uuid,
  email text,
  created_at timestamptz,
  -- 2026-09-24 新增的三個 profile 欄位。順序放在既有欄位**之後**,讓回傳形狀是嚴格的超集。
  -- ⚠️ 刻意**沒有** contact_email:使用者裁決三種「人」的角色只有一個 Email,就是上面的 `email`
  --    (auth.users 的登入帳號)。詳見檔頭。
  display_name text,
  job_title text,
  phone text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  -- 權限檢查維持 20260915120200(模組 2 功能 3.3)的既有條件,一字不改:
  -- 該商家管理員 或 平台管理員。這次沒有放寬任何權限,只是多回傳幾個欄位。
  if not (private.is_merchant_admin(p_merchant_id) or private.is_platform_admin()) then
    raise exception '沒有權限查看此商家的管理員名單' using errcode = '42501';
  end if;

  -- ⚠️【三個新欄位對既有管理員都可能是 null,前端一定要處理「沒填」的顯示】
  --    ・phone:2026-09-24 才新增的欄位,既有管理員全部是 null。
  --    ・display_name / job_title:2026-09-16 就存在,但一直沒有畫面強迫填,所以也常常是 null。
  --    既有的 fallback 慣例(見那兩個欄位自己的註解):display_name 沒填時前端 fallback 顯示
  --    帳號 email 的 @ 前半段;job_title 沒填時 fallback 顯示「商家管理員」。
  --    phone 沒填時建議顯示「未填」之類的佔位文字,不要顯示空白
  --    (空白會讓人以為是載入失敗)。
  --    這三個欄位**不做** coalesce 補預設值:資料庫誠實回傳 null,讓前端決定怎麼呈現
  --    ——後端硬塞「未填寫」字串會讓前端無法分辨「真的沒填」跟「填了『未填寫』三個字」。
  return query
    select
      ma.id, ma.merchant_id, ma.user_id, u.email::text, ma.created_at,
      -- ⚠️ u.email 是這張名單上**唯一**的 Email(登入帳號,auth.users,Supabase Auth 管的)。
      --    2026-09-24 使用者裁決三種「人」的角色只需要一個 Email,所以這裡不會再有第二個
      --    email 欄位可以混。
      ma.display_name, ma.job_title, ma.phone
    from public.merchant_admins ma
    join auth.users u on u.id = ma.user_id
    where ma.merchant_id = p_merchant_id
    order by ma.created_at asc;
end;
$$;

comment on function public.get_merchant_admin_users(uuid) is '對應規格書 3.3/4.3/5.4(2026-09-24 使用者裁決疊加):回傳指定商家的管理員清單,呼叫者必須是該商家管理員或平台管理員(權限條件這次一字未改)。【2026-09-24】回傳新增三個 profile 欄位 display_name / job_title / phone。使用者裁決:超級管理員後台要看得到商家管理員的電話與 Email(原文「要」,理由「以我這個廠商視角」——他是平台方,需要掌握每位商家管理員的聯絡方式),商家端的管理員名單也要顯示。查證後發現這兩件事是同一個改動:前端兩個畫面(商家端 MerchantSettingsPage → MerchantAdminList、超級管理員端 platform-admin/MerchantDetailPage)共用同一個 useMerchantAdmins hook、同一支這個函式,所以只要把欄位加進回傳就同時滿足兩邊,不需要另外做一支 platform_get_merchant_admin_contacts,也不需要放寬 merchant_admins 的 RLS(模組 2 規則 2.3 刻意不疊加 RLS 的決定完全維持)。順便補上 display_name / job_title——它們 2026-09-16 就存在卻一直沒被這支函式回傳,所以名單上只看得到登入 email 和加入日期,有多位管理員時分不出誰是誰;同一個缺口一次補齊,不要為了它改兩次回傳形狀。⚠️⚠️【刻意不回傳 contact_email】這支 migration 原本還要回傳 merchant_admins.contact_email,2026-09-24 同日被使用者推翻,原話:「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」所以三種「人」的角色(merchant_admins / merchant_agents / merchant_staff)都只有一個 Email,就是這裡的 u.email(登入帳號,auth.users)。merchant_admins 從來沒有過 contact_email 欄位(20260924040600 改成只加 phone),merchant_staff / merchant_agents 的由 20260924040800_drop_person_contact_email 移除。⚠️ 這個決定不適用於 public.merchants.contact_email(店家對外給消費者看的信箱,店家本身沒有登入帳號,不存在跟登入信箱重複的問題),那個一律保留。⚠️ 這支函式是 stable 唯讀,這次完全沒有新增任何寫入路徑——超級管理員只「看得到」不能編輯,那些欄位只有管理員本人能透過 update_my_admin_profile 修改。回傳形狀是既有欄位的嚴格超集,既有前端型別原本只宣告 5 個欄位、會忽略新欄位,所以這是相容的擴充(跟 update_my_admin_profile 追加參數那個破壞性改動不同)。⚠️ 三個新欄位對既有管理員都可能是 null(phone 是這次才新增;display_name/job_title 雖然 2026-09-16 就存在,但從來沒有畫面強迫填),前端必須處理「沒填」的顯示;刻意不在後端做 coalesce 補預設值,因為那會讓前端無法分辨「真的沒填」與「填了那串預設文字」。使用者對這張名單的需求原文:「目前我這邊看到的只有 Email(新增管理員也是 Email),新增用 Email 沒問題,但名單要顯示暱稱/手機/Email,這樣才好判斷是誰。」——名單的三個主要顯示欄位就是 display_name(暱稱)/ phone(手機)/ email(登入 Email,也是唯一的 Email)。';

-- drop + create 會重置權限,這裡務必重新宣告(見上方警語)。
revoke execute on function public.get_merchant_admin_users(uuid) from public, anon;
grant execute on function public.get_merchant_admin_users(uuid) to authenticated;
