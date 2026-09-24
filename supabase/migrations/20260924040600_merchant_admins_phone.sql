-- 2026-09-24 使用者裁決:merchant_admins 新增「電話」。
--
-- =========================================================================
-- 【⚠️ 這支 migration 的歷史:原本叫 20260924040600_merchant_admins_phone_and_contact_email.sql】
--
-- 它原本要一次加兩個欄位:phone 與 contact_email。在還沒套用到任何環境之前,使用者看過實際畫面
-- 後推翻了 contact_email 的設計,原話:
--   「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
--   「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--
-- 結論:三種「人」的角色(商家管理員 merchant_admins / 客服 merchant_agents /
--       服務人員 merchant_staff)都只保留**一個** Email,也就是登入 Email(auth.users.email),
--       各表自己的 contact_email 欄位全部拿掉。
--
-- 所以這支 migration 被改成**只加 phone**,而不是「先加 contact_email 再由後面的 migration 刪掉」
-- ——它一天都還沒上線過,沒有任何環境需要那個中間狀態,加了再刪只會在歷史裡留下一個從來不存在
-- 的欄位,讓之後讀 migration 的人以為正式環境曾經有過它。檔名也一併改成反映實際內容。
-- merchant_staff / merchant_agents 那兩個**已經真實存在**的 contact_email 欄位,是另一支
-- 20260924040800_drop_person_contact_email.sql 負責移除的(那兩個欄位真的上線過,只能用 drop)。
--
-- ⚠️⚠️ 不要把這個決定套到 public.merchants.contact_email —— 那是完全不同的東西,詳見
--       20260924040800 檔頭的說明。那個欄位一律保留不動。
--
-- =========================================================================
-- 【使用者裁決原文(phone 這個欄位為什麼要加)】
--   「我認為需要,因為這會影響到整個系統判斷這個管理員與集團的關聯或者這個管理員在系統內的資料
--     (**以我這個廠商視角**)。」
--
-- 也就是:使用者是平台方(廠商),他需要能掌握每一位商家管理員的聯絡方式——這不只是商家自己的
-- 便利性,是平台方營運上的需求。而在「登入 Email 就是聯絡 Email」的新前提下,平台方要的
-- 聯絡方式其實只缺一個電話(Email 早就能從 auth.users 拿到,get_merchant_admin_users 本來就
-- 回傳它),所以這次只需要補 phone。
--
-- 【現況(已查證)】
-- merchant_admins 這張表從建立至今只有:
--   id / merchant_id / user_id / created_at(20260915100000:119)
--   display_name / job_title(20260916170000:15-16,「首頁外殼」那批加的)
--   line_user_id / line_bound(20260920160000:163)
-- **沒有 phone**。所以這不是「前端多加一個輸入框」,必須先改 schema。
--
-- 三種角色的欄位對照(說明為什麼這個缺口一直沒被發現):
--                        姓名            暱稱      職位   電話          Email
--   merchant_staff       name            nickname  —      ✅ NOT NULL   登入 Email(auth.users)
--   merchant_agents      name            nickname  ✅     ✅ NOT NULL   登入 Email(auth.users)
--   merchant_admins      display_name(兼) —        ✅     ❌            登入 Email(auth.users)
-- merchant_admins 當初只是一張「關聯表」(哪個 user 是哪間商家的管理員),profile 欄位是後來
-- 為了首頁個人資料卡片才零星補上的,所以電話一直缺著。
--
-- =========================================================================
-- 【⚠️ 為什麼 phone 必須是 nullable,而且跟另外兩張表刻意不一致】
--
-- merchant_staff.phone / merchant_agents.phone 都是 **NOT NULL**(20260922140000_req595_596,
-- 對應 SPECS-INDEX #595/#596)。這裡刻意**不**跟進,原因是硬性的:
--
--   正式環境現在就有既有的商家管理員資料列,他們從來沒有機會填過這個欄位(欄位根本不存在)。
--   `add column ... not null` 在有既有資料列的情況下會直接失敗;就算給 default 值硬塞過去,
--   那也是憑空捏造一個假電話,比留空更糟。
--
--   對照:20260922140000 當初要把 merchant_staff/merchant_agents 的 phone 改成 NOT NULL 時,
--   必須先由主腦與 engineer 人工處理 5 筆不合格的既有資料(3 筆空白 → 改成 status='removed'
--   並補佔位電話、2 筆測試值 → 改成佔位電話)才做得到。那個代價這裡付不起,也不該付——
--   管理員是商家的老闆/負責人,不能因為「還沒填電話」就把他停用。
--
-- ⚠️⚠️ 所以:**不要「順手統一」把這個欄位改成 NOT NULL**。看到這裡的人如果覺得
--        「三張表應該一致」而去加 NOT NULL,會在既有資料上當場失敗,或逼出一批假資料。
--        要統一的正確做法是:先讓所有既有管理員在畫面上補完電話,確認全表無 null
--        之後才改約束(比照 20260922140000 的流程)。這件事的判斷權在使用者,不在實作者。
--
-- =========================================================================
-- 【phone 的格式 CHECK:我加了,理由與代價】
--
-- 決定:**加**,但寫成允許 null 的形式 `check (phone is null or phone ~ '^09\d{8}$')`,
-- 跟 merchant_staff_phone_tw_mobile_format / merchant_agents_phone_tw_mobile_format
-- 用同一個正規表達式(09 開頭、共 10 碼數字)。
--
-- 為什麼現在加而不是之後再說(這是關鍵理由):
--   約束的兩個方向不對稱——
--     ・現在加、以後想放寬 → 只要 `drop constraint`,一行,沒有資料要處理。
--     ・現在不加、以後想加 → 必須先清理期間累積的所有不合格資料,那正是 20260922140000
--       當初被卡住、要人工處理 5 筆資料才做得到的原因。
--   既有資料列這個欄位全部是 null(欄位這一刻才新增),所以現在加約束保證不會失敗。
--   選「現在加」是選那個之後好回頭的方向。
--
-- ⚠️ 我要明確提出的代價(已在回報中請主腦轉給使用者確認):
--   這個約束只接受**台灣手機號碼**,不接受市話(例如 02-2345-6789)。
--   merchant_staff/merchant_agents 的電話是為了 LINE/推播通知,手機是合理假設;
--   但 merchant_admins 是商家的老闆/負責人,而使用者要的是「平台方能聯絡到他」——
--   老闆留一支**公司市話**是相當合理的情境。
--   如果使用者確認需要支援市話,放寬成「只擋明顯不是電話的輸入」是一行 migration
--   (drop constraint 再視需要加一條寬鬆版),我沒有自行決定放寬,因為那會讓三張表的
--   電話格式規則出現第三種標準,屬於產品決策。
-- =========================================================================

-- =========================================================================
-- §1 新增 phone 欄位。
-- =========================================================================
alter table public.merchant_admins
  add column phone text;

alter table public.merchant_admins
  add constraint merchant_admins_phone_tw_mobile_format
  check (phone is null or phone ~ '^09\d{8}$');

comment on column public.merchant_admins.phone is
  '商家管理員的聯絡電話(2026-09-24 使用者裁決新增)。使用者原文:「我認為需要,因為這會影響到
  整個系統判斷這個管理員與集團的關聯或者這個管理員在系統內的資料(以我這個廠商視角)」——
  使用者是平台方,需要能掌握每一位商家管理員的聯絡方式,不只是商家自己的便利性。
  ⚠️ 這張表刻意**沒有** contact_email 欄位:2026-09-24 使用者裁決「登入和聯絡信箱應該要是一致的
  (所以理論上不該出現不同的信箱)」「客服和服務人員應該也是一樣只需要一個 Email 即可」,所以三種
  「人」的角色都只有一個 Email,就是登入 Email(auth.users.email,由 get_merchant_admin_users
  一併回傳)。不要再為了「方便填聯絡方式」把 contact_email 加回來,那是已經被推翻過一次的設計。
  (public.merchants.contact_email 是完全不同的東西——那是店家對外給消費者看的信箱,店家本身沒有
  登入帳號,不存在跟登入信箱重複的問題,一律保留,見 20260924040800 檔頭。)
  ⚠️⚠️【為什麼是 nullable,而 merchant_staff.phone / merchant_agents.phone 是 NOT NULL —— 這個
  不一致是刻意的,不要「順手統一」】正式環境有既有的管理員資料列,他們從來沒有機會填過這個欄位
  (欄位到 2026-09-24 才存在)。add column not null 在有既有資料時會直接失敗;給 default 硬塞則是
  憑空捏造假電話,比留空更糟。而且管理員是商家的老闆/負責人,不能因為「還沒填電話」就把他停用
  ——這正是 20260922140000(#595/#596)把 merchant_staff/merchant_agents 改成 NOT NULL 時,必須
  先人工處理 5 筆既有資料(含把 3 筆空白的改成 status=removed)才做得到的代價,在管理員身上付不起。
  要統一的正確做法是:先讓所有既有管理員在畫面上補完,確認全表無 null 之後才改約束,而且那是
  使用者的決策不是實作者的。
  【格式約束】merchant_admins_phone_tw_mobile_format:`phone is null or phone ~ ''^09\d{8}$''`,
  跟另外兩張表同一個正規表達式(09 開頭共 10 碼)。⚠️ 這表示**不接受市話**。選擇現在就加約束的
  理由是方向不對稱:現在加、以後放寬只要 drop constraint(零資料處理);現在不加、以後要加就得
  清理期間累積的不合格資料。已在回報中請使用者確認「老闆留公司市話」是否需要支援。';

-- =========================================================================
-- §2 擴充 public.update_my_admin_profile:讓管理員自己填電話。
--
-- ⚠️ 追加參數等於**新的重載函式**(PostgreSQL 把不同參數個數視為兩支不同函式),所以先 drop
-- 舊的 3 參數簽章再建立 4 參數版本——這是任務 7 的 update_merchant_agent 已經踩過並記錄過的坑:
-- 留下孤兒重載會讓 PostgREST 依送來的參數名挑選,製造「有時候走到舊版(不寫 phone)」
-- 這種極難查的問題。加 if exists,所以在還沒套用過舊版的環境也不會失敗。
--
-- ⚠️ 這裡也順手 drop 掉 5 參數版本 (uuid, text, text, text, text)。那是這支 migration 的
-- **前一個草稿版本**(p_merchant_id, p_display_name, p_job_title, p_phone, p_contact_email)。
-- 它從來沒有被套用到正式環境,但本機 `supabase db reset` / 開發分支有可能跑過舊版檔案,
-- 留著會是一支寫得到已經不存在的 contact_email 欄位的孤兒重載(而且 PostgREST 會依參數名
-- 解析到它)。多寫這一行 drop 的成本是零,漏寫的代價是一個很難查的 overload 解析問題。
--
-- 回傳型別維持 returns void(不改成 returns merchant_admins):前端既有呼叫點已經按 void 處理,
-- 這次只追加一個欄位,沒有理由順便改動回傳契約。
-- =========================================================================
drop function if exists public.update_my_admin_profile(uuid, text, text);
drop function if exists public.update_my_admin_profile(uuid, text, text, text, text);

create or replace function public.update_my_admin_profile(
  p_merchant_id uuid,
  p_display_name text,
  p_job_title text,
  p_phone text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text;
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  -- 電話正規化 + 格式驗證。先在函式裡擋下並給白話中文訊息,不讓管理員看到資料庫原始的
  -- check constraint 錯誤(比照任務 7 update_merchant_agent 的既有做法)。
  -- ⚠️ 空字串要正規化成 NULL 再判斷:這個欄位是選填的,「清空」是合法操作,
  --    不能因為前端送了空字串就當成格式錯誤。
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');

  if v_phone is not null and v_phone !~ '^09\d{8}$' then
    raise exception '手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678),或留空不填';
  end if;

  update public.merchant_admins
  set display_name = nullif(btrim(coalesce(p_display_name, '')), ''),
      job_title = nullif(btrim(coalesce(p_job_title, '')), ''),
      phone = v_phone
  where merchant_id = p_merchant_id
    and user_id = auth.uid();

  if not found then
    raise exception '找不到你在這間商家的管理員紀錄,無法更新' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.update_my_admin_profile(uuid, text, text, text) is '對應規格書「首頁外殼與主題色優化」1.3 + 2026-09-24 使用者裁決疊加:管理員自助編輯自己的姓名/職位/電話。只檢查呼叫者是不是這筆 merchant_admins 紀錄本人(auth.uid() = user_id),是所有權判斷,不是 private.is_merchant_admin 那種權限判斷——所以一位管理員改不到同商家其他管理員的資料。【2026-09-24】新增 p_phone 參數(使用者裁決:「我認為需要…以我這個廠商視角」,平台方需要能掌握每一位商家管理員的聯絡方式)。因為追加參數等於新的重載,這支 migration 在建立前先 drop 了舊的 3 參數版本,也 drop 了開發過程中曾存在的 5 參數草稿版本(那個版本有 p_contact_email),避免留下孤兒重載讓 PostgREST 有時候解析到寫不到 phone、或寫得到已不存在欄位的舊版(這是 update_merchant_agent 已經踩過的坑)。phone 在函式內先驗證 ^09\d{8}$ 並給白話中文訊息,空字串正規化成 NULL(這個欄位是選填,清空是合法操作)。⚠️ 刻意**沒有** p_contact_email:2026-09-24 使用者裁決「登入和聯絡信箱應該要是一致的」「客服和服務人員應該也是一樣只需要一個 Email 即可」,三種「人」的角色都只有登入 Email 一個信箱,merchant_admins 從來沒有過 contact_email 欄位,merchant_staff / merchant_agents 的則由 20260924040800 移除。回傳型別維持 void,沒有順便改動回傳契約。';

revoke execute on function public.update_my_admin_profile(uuid, text, text, text) from public, anon;
grant execute on function public.update_my_admin_profile(uuid, text, text, text) to authenticated;

-- =========================================================================
-- §3 刻意「不」在這支 migration 做的一件事(已在回報中提出建議,等使用者裁決,不自行擴大範圍)
--
-- 平台超級管理員要不要看得到管理員的電話?
--   查證結果:模組 2 規格書**規則 2.3 明文刻意決定**不把 is_platform_admin() 疊加到
--   merchant_admins 的 RLS 上(見 20260915120100_platform_admin_rls_overlay.sql:8-11 的註解:
--   「刻意只疊加這三條…不疊加 merchant_admins/merchant_feature_flags 的政策」)。
--   但**函式路徑**是另一回事:public.get_merchant_admin_users 的權限檢查在 20260915120200
--   (模組 2 功能 3.3)就已經是「該商家管理員 or 平台管理員」,所以平台管理員早就能看到這張名單。
--   下一支 migration(20260924040700)因此只需要把 display_name/job_title/phone 加進那支函式的
--   回傳,兩個畫面(商家端 MerchantAdminList + 超級管理員端 MerchantDetailPage,共用同一個
--   useMerchantAdmins hook)就同時滿足,不需要新增任何函式,也不需要放寬 merchant_admins 的 RLS。
-- =========================================================================
