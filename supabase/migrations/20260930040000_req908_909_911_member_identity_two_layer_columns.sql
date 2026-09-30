-- SPECS-INDEX #908 / #909 / #911(規格書 .project/specs/建單自動建立會員與會員兩層狀態.md §三)。
-- 階段 1「資料層與旗標」:只加欄位 + 回填,**完全不改任何使用者看得到的行為**,可以單獨先上。
--
-- ═══ 這支 migration 做三件事 ══════════════════════════════════════════════════════
--   #908 public.members 新增三個欄位(「已完成身分驗證」兩層狀態的地基)
--   #909 既有 121 筆會員的回填(只回填 line_bound = true 的那 5 筆)
--   #911 public.bookings 新增 member_auto_created(這筆訂單有沒有順手建了一個會員)
--
-- ⚠️ 本檔沒有任何 DELETE,唯一的 UPDATE 就是 #909 的回填(見下方「動手前的唯讀核對」)。
--
-- ═══ 動手前的唯讀核對(CLAUDE.md 第 5-1 條 / 開發流程紀錄.md 第九章第 11 點)══════════
-- 2026-09-30 對正式專案 wjtbmmnakcriuaqoknsq 跑過唯讀 SELECT,跟規格書 §2.2 的數字一致:
--   members 總筆數 121(active 121 / removed 0)、line_bound = true **5** 筆、
--   phone_verified = true 0 筆、user_id is not null 0 筆、電話為空 2 筆、
--   同商家內電話正規化後重複的組數 **0 組**、bookings 總筆數 297。
--   information_schema 確認這三個新欄位與 bookings.member_auto_created **目前都不存在**。
-- ⇒ 所以 #909 的 UPDATE 命中範圍就是那 5 筆,不會波及其他 116 筆。
--
-- ═══ 🔴 為什麼欄位不可以叫 line_bound / is_line_verified 這一類名字 ═══════════════════
-- 使用者 2026-09-30 明確要求(SPECS-INDEX #872):「這邊牽涉到登入方式,未來可能會改手機登入,
-- 所以這邊我先不講死登入的方式」。而且 #866「登入方式可能要調整」還懸著。
-- public.members.line_bound 是**另一回事** —— 那是「LINE 推播管道可用、line_user_id 可以推播」,
-- 是**通知管道**的狀態,不是身分。兩個欄位目前剛好只有一條路徑會同時動到(LINE 綁定碼),
-- 但它們不是同一件事,不可以互相取代。
--
-- ═══ 🔴 為什麼是三個欄位,而不是一個 boolean、也不是兩個 ════════════════════════════
-- 使用者 2026-09-30 對 Q2(解除綁定之後還算不算真正的會員)裁決 **(B) 一起清掉**,
-- 但**附帶一個限制**(原話):「如果真的解除綁定,會員資料、紀錄、加入時間也不該清除
-- (僅是綁定狀態變回未綁定)」。
-- ⇒ 所以「現在有沒有通過驗證」跟「第一次是什麼時候通過的」**必須是兩個欄位**:
--   ・identity_verified_at        = 目前的驗證狀態(解除綁定時清成 null)
--   ・identity_first_verified_at  = 第一次完成驗證的時間(**永遠不清**,這就是使用者要的「加入時間」)
--   ・identity_verified_via       = 目前這一段驗證是靠哪一種方式完成的
-- 如果只用一個欄位同時承擔兩件事,第二次解除綁定就會把「第一次驗證的時間」永久弄丟,
-- 使用者明確要求保留的東西就失效了。
--
-- ═══ 🔴 為什麼不直接用既有的 members.user_id is not null 當判定 ═══════════════════════
-- (規格書 §三 #908 的「(甲)/(乙) 評估」,四個理由的摘要)
--  1. user_id 正式庫 0 筆有值,而 LINE 綁定碼流程**根本不會建立 auth.users 帳號**
--     (MemberLineBindingSection 的畫面文字逐字寫「不需要會員先有系統登入帳號」)
--     ⇒ 用 user_id 判定等於宣告「今天沒有任何真正的會員」,名單的兩層分類當場沒有意義。
--  2. user_id 回答的是「有沒有登入帳號」,不是「有沒有證明過身分」,這是兩件事。
--  3. user_id 是 uuid,答不出「什麼時候變成正式會員的」(報表/稽核會問)。
--  4. user_id 也答不出「當初是靠什麼驗證的」。
-- ⇒ 本批**完全不碰** members.user_id,也不移除它那個 partial unique index。
--   模組 13(客戶端)上線時把帳號綁上 user_id 的那一刻,**順手也寫** identity_verified_at 並把
--   identity_verified_via 設成 'account'(屆時在下面那條 CHECK 多加一個值就好),就接上了。
--   identity_verified_at 是**唯一的判定欄位**,user_id 是它的其中一種來源,不是競爭者。
--
-- ═══ 🟢 RLS:不需要額外的保護 trigger(結論要留在這裡,避免後人以為漏做)═══════════════
-- public.members 已啟用 RLS,而且**只有 SELECT 政策**(members_select:can_manage_members
-- OR can_manage_bookings),完全沒有 INSERT / UPDATE / DELETE 政策(「RPC only」寫入,
-- 表註解明文寫)。⇒ 這三個新欄位**天生只能被 SECURITY DEFINER 函式寫**,
-- 不需要像 merchant_staff.line_user_id 那樣另外加 BEFORE UPDATE 保護 trigger。
-- public.bookings 同樣已啟用 RLS,member_auto_created 只由 create_booking 寫。
--
-- ═══ 📌 SPECS-INDEX #922:未綁定的會員紀錄永久保留,不做自動清理 ═══════════════════════
-- 使用者裁決原話:「這是商家的客戶資料,我們不能隨意刪除」。
-- ⇒ 本批**不新增**任何 cron job、排程函式、TTL、批次刪除或「N 天未綁定自動下架」的邏輯,
--   也**不把**自動建立的會員標成任何「暫時」狀態(它就是一筆正常的 status = 'active' 會員)。
--   要下架只能由商家自己用既有的 deactivate_member(軟刪除,status = 'removed')。
--   🔴 **不要因為「會累積很多空會員」就加自動清理** —— 使用者已經知道會累積,並且明確要求保留。
--
-- ═══ 刻意不做 ═══════════════════════════════════════════════════════════════════
-- ・不動 members.line_bound / phone_verified / user_id 一個字。
-- ・不讓 create_member / update_member / import_members_batch / transfer_members_to_merchant /
--   platform_* 接受或寫入這三個新欄位 —— 客服不可以手動把客戶標成「已驗證」。
--   (唯一寫入路徑見 20260930040100_req910_identity_verified_write_paths.sql)
-- ・不新增任何「identity_verified_at is null 就不寄通知」的判斷(#921:通知現況已經成立,
--   靠 line_bound + line_user_id 物理上就寄不出去;多加一道等於同一條規則兩地維護,
--   而且會有「把現在已經在跑的 LINE 通知整個關掉」的風險)。

-- =========================================================================
-- #908:public.members 新增三個欄位
-- =========================================================================
alter table public.members
  add column identity_verified_at timestamptz,
  add column identity_verified_via text,
  add column identity_first_verified_at timestamptz;

alter table public.members
  add constraint members_identity_verified_via_check
  check (identity_verified_via is null or identity_verified_via in ('line'));

comment on column public.members.identity_verified_at is
  'SPECS-INDEX #908/#872(2026-09-30):**目前**有沒有通過身分驗證,以及是什麼時候通過的;null = 目前未驗證。語意是「這個人本人已經證明過他就是這支手機的主人」,**與登入方式無關**。🔴 不可以改成 line_bound 或任何跟特定登入管道綁定的名字 —— 使用者 2026-09-30 明確要求(「這邊牽涉到登入方式,未來可能會改手機登入,所以這邊我先不講死登入的方式」),而且 #866「登入方式可能要調整」還沒定案。members.line_bound 是另一回事:那是「LINE 推播管道可用」,是通知管道的狀態,不是身分。判定「是不是真正的會員」一律看這個欄位 is not null,不看 line_bound、不看 phone_verified、不看 user_id。唯一寫入路徑:consume_line_binding_code(設上)與 unbind_line_account(清成 null),見 20260930040100。';

comment on column public.members.identity_verified_via is
  'SPECS-INDEX #908(2026-09-30):**目前**這一段驗證是靠哪一種方式完成的。這次只放 ''line'' 一個值(今天唯一能證明身分的路徑就是 LINE 綁定碼:那組碼必須從客人本人的 LINE 帳號送出,商家自己做不到)。#866 之後若真的加手機登入,只要在 members_identity_verified_via_check 多加一個值(例如 ''phone_otp''),模組 13 把帳號綁上 members.user_id 時則用 ''account'' —— **不動任何讀取邏輯、不動任何既有資料**。解除綁定時跟 identity_verified_at 一起清成 null。📌 刻意**不回傳給前端**(名單/詳情只需要「有沒有驗證過 + 什麼時候」,不需要知道是哪一種登入方式;少回一個欄位就少一個資訊面,資安清單 #6)。';

comment on column public.members.identity_first_verified_at is
  'SPECS-INDEX #908/#910(2026-09-30):**第一次**完成身分驗證的時間,🔴 **一旦寫上就永遠不清、不覆寫**(連解除綁定也不清)。存在的理由是使用者對 Q2 的裁決:他選「解除綁定要把綁定狀態歸零」,但同時明確要求「會員資料、紀錄、加入時間也不該清除(僅是綁定狀態變回未綁定)」。⇒ identity_verified_at 負責「現在綁沒綁」(會被清),這個欄位負責「第一次是什麼時候」(不會被清)。🔴 不要為了「少一個欄位」把兩者合併 —— 合併之後第二次解除綁定就會把第一次驗證的時間永久弄丟。';

-- 名單頁要按「有沒有驗證過」分兩堆,而且一定帶 merchant_id(資安清單 #16:任何查詢都要確實用
-- merchant_id 過濾,不只靠 RLS 一道防線)。
create index members_identity_verified_at_idx
  on public.members (merchant_id, identity_verified_at);

-- =========================================================================
-- #909:既有會員的回填 —— **只回填 line_bound = true 的那 5 筆**
-- =========================================================================
-- 🔴 這一段最容易寫錯,所以理由完整留在這裡:
--
--  1. **不能把所有既有會員都當成「已綁定」。** 121 筆裡面只有 5 筆 line_bound = true;
--     其餘 116 筆是客服手動建立或 CSV 匯入的,**那些客戶本人從來沒有做過任何認領動作**,
--     依使用者對「真正的會員」的定義,他們在畫面上就是「尚未驗證」
--     (2026-10-01 修正用詞:這裡原本寫的是舊標籤「已建立(未綁定)」;使用者已裁決狀態名稱裡
--      不可以出現「綁定」二字,現行文案的唯一來源是 src/modules/members/memberIdentityStatus.ts)。
--  2. **也不能全部當成未綁定。** 那 5 筆已經完成過 LINE 綁定,把他們降級會讓 LINE 通知與
--     名單顯示同時出錯。使用者 2026-09-30 對 Q6 裁決 **(A)「算」**:靠後台發碼完成 LINE 綁定
--     的人算「真正的會員」(那組碼必須從客人本人的 LINE 送出,本質上就是本人的主動認領動作)。
--  3. 時間用 coalesce(updated_at, created_at) 而不是 now():綁定一定發生在過去某個時間點,
--     寫 now() 會讓「什麼時候變成正式會員」這個欄位從一開始就是假的。
--     ⚠️ **誠實說明:這是回填的近似值,不是真正的綁定時間**(updated_at 也可能是後來改資料
--     造成的)。只有 5 筆,可接受;沒有任何地方存著真正的綁定時間可以拿來用
--     (line_binding_codes.used_at 只在「這組碼還沒被清掉」時才對得上,不保證涵蓋這 5 筆)。
--  4. **phone_verified 不納入回填條件。** 正式庫 phone_verified = true 有 0 筆,而且那個欄位的
--     schema 註解明文寫「純粹的人工標記欄位,不代表真的發送過簡訊驗證碼,只有管理員/客服在
--     會員詳情頁手動標記」⇒ 那是商家自己按的,不是客戶本人證明的,**不能當成身分驗證**。
--  5. identity_first_verified_at 回填成同一個時間:對這 5 筆來說「第一次」就是這一次。
--
-- ⚠️ 為什麼要暫時關掉 members_set_updated_at 這個 trigger:
--    那支 trigger 是 `new.updated_at = now()` 無條件覆寫。如果讓它照跑,這 5 筆的 updated_at
--    會被改成「跑 migration 的時間」,而 identity_verified_at 取的又正是**改之前**的 updated_at
--    ⇒ 事後再也沒有辦法核對「這個回填值是從哪裡來的」。這是純粹的回填,不是真的有人改資料,
--    所以刻意不讓 updated_at 跳動。
--    整段包在一個 DO 區塊裡:DO 是**單一敘述**,中途任何失敗都會連同 disable trigger 一起回滾,
--    不可能留下一個「trigger 被關著」的資料庫。
do $$
begin
  execute 'alter table public.members disable trigger members_set_updated_at';

  update public.members
  set identity_verified_at = coalesce(updated_at, created_at),
      identity_verified_via = 'line',
      identity_first_verified_at = coalesce(updated_at, created_at)
  where line_bound = true
    and identity_verified_at is null;

  execute 'alter table public.members enable trigger members_set_updated_at';
end;
$$;

-- =========================================================================
-- #911:public.bookings 新增 member_auto_created
-- =========================================================================
-- default false 對既有 297 筆訂單就是正確答案(沒有任何一筆是自動建立的),**不需要回填**。
--
-- 🔴 為什麼需要這個欄位,而不是改 create_booking 的回傳型別:
--    建單成功的提示框要能講出三種不同的話(「已自動建立會員」/「已連結既有會員」/「沒有會員」),
--    但 create_booking 回傳的是 public.bookings 整列,前端只看得到 member_id 有沒有值,
--    **分不出「新建的」和「接上舊的」**。
--    而回傳型別**絕對不能改成 jsonb** —— 呼叫端是 43 支 pgTAP + 8 支 e2e fixture + 1 處前端,
--    多數寫成 `select id from create_booking(…)`,改型別會一次弄壞整套測試,
--    收益卻只是省一個欄位。
--
-- 🔴 為什麼不沿用既有的預留值 bookings.source / created_by_role:
--    bookings_source_check 是 ('manual','smart','customer','import'),
--    bookings_created_by_role_check 是 ('admin','agent','customer')。
--    'customer' / 'smart' 是留給**客戶自助預約(模組 13)**與**智慧建單**的,語意是
--    「這張訂單是誰、用什麼方式開的」。#872 的情境是客服在後台手動建單,
--    source 就該是 'manual'、created_by_role 就該是 'admin'/'agent' —— 這兩個欄位**一律不動**。
--    把它們改成 'customer' 會讓「客戶自己下的單」與「客服代客戶下的單」混在一起,
--    直接汙染那 43 支 pgTAP 與所有報表的來源統計。
--    ⇒ 「這筆訂單順手建了一個會員」是**另一個維度**的事實,需要自己的欄位。
alter table public.bookings
  add column member_auto_created boolean not null default false;

comment on column public.bookings.member_auto_created is
  'SPECS-INDEX #911/#872(2026-09-30):這筆訂單在**建立當下**有沒有順手自動建立一筆新的會員紀錄。true = 建單時這支電話在本商家查無 active 會員,create_booking 自動建了一位;false = 本來就有(自動連結到既有那一位)、或呼叫端明確帶了 p_member_id、或這筆訂單沒有會員。⚠️ 它只描述「建單當下」發生的事:**事後編輯訂單改了會員也不會改這個欄位**(update_booking 的欄位清單裡沒有它,刻意不加進去)。用途:① 建單成功的提示框要分辨「已自動建立會員」還是「已連結既有會員」(前端只看 member_id 分不出來);② 稽核 —— 搭配 members.created_by_user_id 可以回答「這位會員是誰、什麼時候、怎麼進來的」(資安清單 #21)。唯一寫入路徑是 create_booking。';
