-- SPECS-INDEX #931(取代 #930)+ #827:
--   #931 **同一間商家底下,一支電話只能有一位「使用中(active)」的會員。**
--   #827 會員電話的格式檢查(使用者裁決 Q5 = (A)「把 #827 一起修掉」)。
-- 規格書:.project/specs/建單自動建立會員與會員兩層狀態.md 檔頭「2026-09-30 晚間:使用者推翻了
-- 本規格書的一個核心前提」那一段(= §十一 Q3 的 (B) 案)+ §三 #913 第 2 點。
--
-- ═══ 這支 migration 動到五樣東西 ═══════════════════════════════════════════════════
--   1. 新增 partial unique index members_merchant_active_phone_uniq
--   2. create_member                 ← #827 格式檢查 + #931 唯一性檢查(+ 修掉一個誤導訊息的既有陷阱)
--   3. update_member                 ← 同上(唯一性檢查要排除自己那一列)
--   4. reactivate_member             ← #931 的白話訊息(🔴 本批加索引造成的回歸,必須補)
--   5. transfer_members_to_merchant  ← #931 的白話訊息(🔴 同上,而且要講清楚是哪一筆卡住)
-- 🔴 第 4、5 兩項不是「順手加的防呆」:沒有它們,兩顆既有的按鈕會開始吐 Postgres 原生的英文
--    `duplicate key value violates unique constraint …`。不能讓我們加的索引把既有功能弄成英文亂碼。
--    規格書寫「transfer_members_to_merchant 不需要改」是在**還沒有唯一索引**的前提下寫的,已過時。
--
-- ═══ 使用者裁決(原話)═══════════════════════════════════════════════════════════
-- 「我覺得直接改成,後面的就直接不進會員名單,保持一支手機只綁一個資料就好,這樣比較單純,
--   也省得再做一個篩選功能。」
-- ⚠️ 規劃者當初評估過這個方向並且**不建議**(規格書 §十一 Q3 的 (B) 案),使用者**知道代價、
--    仍然選它**,理由是「比較單純」。代價要原樣留在這裡:
--    ① 夫妻/家人共用一支電話時,會員名單只會有最早建立的那一個名字,紅利點數也全部累積在那一筆上。
--    ② CSV 匯入與手動新增會員都要跟著改(見下面第 2、3 節)。
--    ③ 既有的「+ 這支電話的新客戶」按鈕沒有用途了(前端範圍,不在這支 migration 裡)。
--
-- ═══ 🔴 為什麼唯一性**只管 active**(這一題使用者明確答「要」,不是實作者自己決定的)═══════
-- 使用者 2026-09-30 對「已下架的同號紀錄要不要排除」裁決:**要**,只約束使用中的會員。
-- 理由:get_members_by_phone 只查 status = 'active'。如果連已下架的也一起擋,
-- 客服會遇到「系統說這支電話已經有會員,但名單上怎麼找都找不到」—— 一個看不見卻擋得住的東西。
-- ⇒ 已下架(status = 'removed')的同號紀錄**不擋**新建;這支電話之後會有 1 筆 removed + 1 筆 active,
--   get_members_by_phone 只回 active,不影響建單畫面。
--
-- ═══ 🔴 擋下來的訊息必須「指名是誰」════════════════════════════════════════════════
-- 使用者要求:訊息要講「這支電話已經有會員:某某某」,**不能只說失敗**。
-- 只說「失敗」的話,客服完全不知道要去找誰,只會重試或改填假電話。
--
-- ═══ 📌 這條規則**不會**讓「同一支電話用別的姓名建單」變成錯誤 ═══════════════════════════
-- 使用者親口確認的完整語意(原話):「同一支手機也可以用其他姓名新建訂單,紅利和訂單紀錄一樣
-- 歸在這個會員底下,原因是手機正確,不會有人拿別人的手機來隨便預約,除非惡搞,但即便是惡搞,
-- 也不影響,因為沒完工不會派紅利,也不會收到錢頂多取消訂單,反而還可以告知這個手機主人他的
-- 個資被冒用。」
-- ⇒ 推導出的兩條實作規則(落在 create_booking,見 20260930040300):
--    ① **訂單**留這次填的姓名(bookings.customer_name 本來就有自己的欄位);
--    ② **會員那一筆的姓名不會被建單覆寫** —— 只有客服在會員管理裡手動改(update_member),
--       或客戶自己在客戶端「完成個人資訊」時才會變。
--
-- ═══ 動手前的唯讀核對(CLAUDE.md 第 5-1 條)═════════════════════════════════════════
-- 2026-09-30 對正式專案 wjtbmmnakcriuaqoknsq 跑唯讀 SELECT:
--   select count(*) from (
--     select merchant_id, private.normalize_phone(phone) np, count(*)
--     from public.members where status = 'active' and private.normalize_phone(phone) is not null
--     group by 1,2 having count(*) > 1) d;
--   → **0 組**(members 共 121 筆、active 121、沒填電話 2 筆、非 active 0 筆)
-- ⇒ 下面的 unique index **現在就可以建,不會卡到任何既有資料**,而且不需要先清資料。
-- ⚠️ 本檔沒有任何 UPDATE/DELETE 資料的敘述。
--
-- ═══ 🟢 順便解掉一個既有風險 ═════════════════════════════════════════════════════
-- 規格書風險表第 6 項「兩筆交易同時判定這支電話 0 筆、各建一筆會員」原本只能接受;
-- 有了下面這個 unique index,**資料庫層直接擋掉**,那個風險消失。

-- =========================================================================
-- 1. partial unique index:同商家 + 正規化後的電話,只約束 status = 'active'
-- =========================================================================
-- 為什麼用「正規化後的電話」當鍵、而不是 phone 原文:
--   '0912-345-678' / '0912345678' / '(09)12345678' / '0912345678#5' 是同一支電話,
--   用原文當鍵等於完全擋不住(客服換一種寫法就繞過去了),而且會跟
--   get_members_by_phone / create_booking 的比對邏輯不一致(那兩邊都用 private.normalize_phone)。
--
-- 為什麼 WHERE 只寫 status = 'active'、不另外寫 phone is not null:
--   private.normalize_phone(null) 與 normalize_phone('#123') 都回 NULL,而 unique index 裡的
--   NULL 互不衝突 ⇒ 沒填電話(正式庫 2 筆)、或只填了分機的會員天生不受這個約束,
--   不需要多寫一個條件。
--
-- 🔴 維護注意:這是**運算式索引**,索引內容是 private.normalize_phone 當下的行為算出來的。
--    以後任何一支 migration 只要 `create or replace function private.normalize_phone`
--    改變了它的算法(2026-09-27 的 #822 就改過一次,加了「在 # 處截斷」),
--    這個索引裡的舊值就會變成陳舊資料、唯一性判斷會靜默出錯。
--    ⇒ **改 normalize_phone 的那支 migration 必須同時 `reindex index public.members_merchant_active_phone_uniq;`**
--    (改完也要順手重看 get_members_by_phone / create_booking / import_members_batch 的比對。)
create unique index members_merchant_active_phone_uniq
  on public.members (merchant_id, private.normalize_phone(phone))
  where status = 'active';

comment on index public.members_merchant_active_phone_uniq is
  'SPECS-INDEX #931(2026-09-30 使用者裁決,取代 #930):同一間商家底下,一支電話只能有一位「使用中(active)」的會員。鍵是 (merchant_id, private.normalize_phone(phone)),所以不同寫法的同一支電話('' 0912-345-678 '' / '' 0912345678 '')算同一支。🔴 WHERE 只約束 status = ''active'' 是使用者明確裁決的(問「已下架的同號紀錄要不要排除」→ 答「要」):get_members_by_phone 只查 active,若連已下架的也一起擋,客服會遇到「系統說這支電話已經有會員,但名單上怎麼找都找不到」。沒填電話、或只填了分機的會員(normalize_phone 回 NULL)天生不受約束,因為 unique index 裡的 NULL 互不衝突。🔴 這是運算式索引:以後只要有人改 private.normalize_phone 的算法(#822 就改過一次),就必須在同一支 migration 裡 reindex 這個索引,否則唯一性判斷會靜默出錯。';

-- =========================================================================
-- 2. create_member:寫入前先檢查,撞到就用「指名是誰」的白話訊息擋下
-- =========================================================================
-- 逐字沿用最新版本 20260923010300_req615_618_member_core_functions_rewrite.sql
-- (檔案本體 CRLF 正規化成 LF 後 md5 = c77122e20420f12f9d01f4f4974cebc2、長度 1799,
--  2026-09-30 對正式庫 pg_proc.prosrc 核對逐字相符),簽章不變(8 個參數)⇒ create or replace,
-- 不需要 drop(drop 會一併丟掉 EXECUTE 權限設定,supabase-permission-hygiene 規則 1)。
--
-- 📌 範圍的決策轉折(這一段刻意留著,因為後人一定會問「#827 到底算不算這一批的事」):
--    ① 主腦 2026-09-30 一開始**刻意把範圍限定在「#872 這條路徑上的後門」**,只加 #931 的
--       唯一性檢查,不順手加電話格式檢查(#827 本體),理由是不擴大到整個
--       create_member / update_member。
--    ② 這個保留意見**當天就被使用者的裁決推翻了** —— 使用者對 Q5 選 (A)「把 #827 一起修掉」。
--    ③ ⇒ **本檔案照 (A) 做**:create_member 與 update_member 兩支都**同時**加了 #931 的唯一性
--       檢查 **與** #827 的電話格式檢查(private.is_valid_taiwan_phone),而且格式檢查刻意排在
--       唯一性檢查的前面(理由見下面各自的 inline 註解)。
--    ⚠️ 2026-10-01 品管打回時修掉的就是這一段:①的保留意見原本被抄進派工單、又被抄進這個檔頭,
--       於是變成「檔頭說沒做、函式本體(第 148 行)做了、comment on function 也說做了」的三方
--       自相矛盾。現在檔頭與本體一致。#827 的完整背景另見 20260930040300 的檔頭。
--
-- 🔴 為什麼「事前檢查」跟「攔 unique_violation」兩層都要做(少任何一層都會出事):
--   ① 事前檢查:正常情況下給出白話中文、而且指名是誰的訊息。
--   ② 攔 unique_violation:這支函式**本來就有一個 `exception when unique_violation` 區塊**
--      在處理「推薦碼撞號要重試」。如果不去分辨是哪一個約束撞到,電話撞號會被誤認成推薦碼撞號
--      → 白白重試 5 次 → 最後丟出「產生推薦碼失敗,請重新再試一次」這個**完全誤導**的訊息。
--      所以這裡用 get stacked diagnostics 讀 constraint_name 精準分流。
--      (併發:兩筆交易同時判定「這支電話 0 筆」時,事前檢查兩邊都會過,真正擋下來的是索引。)
create or replace function public.create_member(
  p_merchant_id uuid,
  p_name text,
  p_phone text default null,
  p_email text default null,
  p_birthday date default null,
  p_notes text default null,
  p_referred_by_member_id uuid default null,
  p_tier_id uuid default null
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral_code text;
  v_attempt int := 0;
  v_result public.members;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
  v_constraint_name text;
begin
  if not (private.can_manage_members(p_merchant_id) or private.can_manage_bookings(p_merchant_id)) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除(電話這次只當查詢索引,不是必填欄位,見 #614/§10.2)。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)「把 #827 一起修掉」):
  -- 會員電話的格式檢查。規則本體沿用 #822 的 private.is_valid_taiwan_phone(跟 create_booking /
  -- update_booking / 兩支匯入函式同一條規則,不另外寫第二套正規表示式)。
  -- 🔴 必須排在下面 #931 唯一性檢查的**前面**:格式明顯不對的電話應該拿到「格式不正確」這個精準訊息,
  --    而不是先被拿去跟既有會員比對(髒電話正規化之後可能剛好撞到別人,訊息就會完全誤導)。
  -- 電話留空維持合法(#618 之後會員電話是選填),所以是 `p_phone is not null` 才檢查。
  -- 🟢 2026-09-30 唯讀核對:正式庫 119 筆有填電話的會員**全部通過**這條規則(不合格 0 筆),
  --    所以現在補上檢查不會弄壞任何存量資料,也不需要先清資料。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123);不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):同商家 + 同一支電話只能有一位 active 會員。
  -- 只比對 status = 'active'(使用者明確裁決:已下架的同號紀錄不擋新建,因為它看不見卻擋得住)。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員:%。同一間商家底下,一支電話只能有一位會員 —— 如果是同一位客戶,請直接使用這一筆;如果真的是不同的人,請改填另一支電話', v_conflict_name;
    end if;
  end if;

  if p_referred_by_member_id is not null then
    if not exists (
      select 1 from public.members
      where id = p_referred_by_member_id
        and merchant_id = p_merchant_id
        and status = 'active'
    ) then
      raise exception '找不到指定的推薦人,或推薦人不屬於這間商家/已被下架';
    end if;
  end if;

  -- #615:會員分級。有指定 p_tier_id 時,必須屬於同一商家且 status='active'。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = p_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級,或不屬於這間商家/已下架';
    end if;
  end if;

  loop
    v_referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.members (
        merchant_id, name, phone, email, birthday, notes,
        referred_by_member_id, referral_code, created_by_user_id, tier_id
      ) values (
        p_merchant_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_email, '')), ''), p_birthday, p_notes,
        p_referred_by_member_id, v_referral_code, auth.uid(), p_tier_id
      )
      returning * into v_result;
      exit;
    exception when unique_violation then
      -- SPECS-INDEX #931:先分辨是哪一個約束撞到。不分辨的話,電話撞號會被當成推薦碼撞號,
      -- 重試 5 次之後丟出「產生推薦碼失敗」這個完全誤導的訊息(見本節開頭的說明)。
      get stacked diagnostics v_constraint_name = constraint_name;
      if v_constraint_name = 'members_merchant_active_phone_uniq' then
        -- 走到這裡代表是併發:上面的事前檢查通過時那一筆還沒 commit。
        -- 重新查一次姓名(這是新的一個敘述,拿到新的 snapshot,所以看得到對方剛 commit 的那一列)。
        select m.name into v_conflict_name
        from public.members m
        where m.merchant_id = p_merchant_id
          and m.status = 'active'
          and private.normalize_phone(m.phone) = v_normalized_phone
        limit 1;

        raise exception '這支電話已經有會員:%。同一間商家底下,一支電話只能有一位會員 —— 如果是同一位客戶,請直接使用這一筆;如果真的是不同的人,請改填另一支電話',
          coalesce(v_conflict_name, '(同一時間剛好有人用這支電話建立了會員)');
      end if;

      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise exception '產生推薦碼失敗,請重新再試一次';
      end if;
    end;
  end loop;

  return v_result;
end;
$$;

comment on function public.create_member(uuid, text, text, text, date, text, uuid, uuid) is '模組 10 §3.3(SPECS-INDEX #615/#618 疊加):建立會員。權限檢查同時放行 can_manage_bookings(建單頁快速建立入口,#324 既有修正)。#618 移除電話必填檢查(電話不再是必填欄位)。#615 新增 p_tier_id(選填,指派會員等級,須屬於同商家且未下架)。推薦人驗證/referral_code 產生邏輯不變。SPECS-INDEX #931(2026-09-30 使用者裁決):同一間商家底下一支電話只能有一位 active 會員 —— 寫入前先用 private.normalize_phone 比對,撞到就 raise「這支電話已經有會員:某某某」(指名是誰,不能只說失敗);只比對 status = ''active''(已下架的同號紀錄不擋新建,使用者明確裁決)。另外把既有的 `exception when unique_violation`(原本只處理推薦碼撞號要重試)改成先用 get stacked diagnostics 讀 constraint_name 分流 —— 不分流的話電話撞號會被誤認成推薦碼撞號、重試 5 次後丟出「產生推薦碼失敗」這個完全誤導的訊息。⚠️ **CSV 匯入走的不是這條路徑,不要以為這句檢查在匯入時會生效**(2026-10-01 品管實測後修正的說明):import_members_batch 在 insert_only 模式(匯入精靈的預設)下,是先自己用 private.normalize_phone 查一次既有會員,查到就直接算 skipped_duplicate_rows、**在呼叫 create_member 之前就短路了** ⇒ 這裡的訊息從匯入那條路徑永遠走不到。匯入那條路徑自己的指名訊息是 20260930040500 補的(仍然算 skipped、不算 failed,額外寫一筆進 error_report)。本函式這句檢查真正守住的是:客服在會員管理畫面新增會員、建單頁的快速建立會員、以及任何直接打 RPC 的呼叫端。【SPECS-INDEX #827,2026-09-30 使用者裁決 Q5 = (A)】同時補上會員電話的格式檢查(private.is_valid_taiwan_phone,跟 create_booking / update_booking / 兩支匯入函式同一條規則),關掉「繞過畫面直接打 RPC 就能把 123 存成會員電話」這個後門;電話留空維持合法(#618)。🔴 格式檢查刻意排在唯一性檢查**前面** —— 髒電話正規化之後可能剛好撞到別人,先比對唯一性會給出完全誤導的訊息。正式庫 119 筆有電話的會員全部通過這條規則(不合格 0 筆,2026-09-30 唯讀核對),補檢查不會弄壞存量資料。';

revoke execute on function public.create_member(uuid, text, text, text, date, text, uuid, uuid) from public, anon;
grant execute on function public.create_member(uuid, text, text, text, date, text, uuid, uuid) to authenticated;

-- =========================================================================
-- 3. update_member:改電話時不可以撞到同商家另一位 active 會員
-- =========================================================================
-- 逐字沿用最新版本 20260923010300(md5 = a2b813f06b6f384605c1cff445cff9c7、長度 1065,
-- 2026-09-30 對正式庫核對逐字相符),簽章不變(7 個參數)⇒ create or replace。
--
-- ⚠️ 這支函式沒有 unique_violation 的 exception 區塊,所以撞到索引時會直接把 Postgres 的
--    英文錯誤訊息(duplicate key value violates unique constraint …)丟給客服看。
--    事前檢查的存在就是為了讓正常情況拿到白話中文;併發(極低機率)才會看到原生訊息。
create or replace function public.update_member(
  p_member_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_birthday date,
  p_notes text,
  p_tier_id uuid default null
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的兩個區域變數。
  v_normalized_phone text;
  v_conflict_name text;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  -- #618:電話必填政策已移除。

  -- SPECS-INDEX #827(2026-09-30 使用者裁決 Q5 = (A)):會員電話的格式檢查,規則與擺放順序的理由
  -- 跟 create_member 那一段完全相同(格式檢查一定要排在唯一性檢查前面)。
  -- ⚠️ 既有的髒電話依使用者裁決不主動清;但只要客服進來編輯這位會員,就會被要求先把電話改正確
  --    (跟 update_booking 對舊訂單的既有處理方式一致)。正式庫目前不合格 0 筆,所以實際上沒有人會遇到。
  if p_phone is not null and btrim(p_phone) <> '' and not private.is_valid_taiwan_phone(p_phone) then
    raise exception '會員電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123);不填也可以';
  end if;

  -- SPECS-INDEX #931(2026-09-30):改電話時不可以撞到同商家**另一位** active 會員。
  -- `m.id <> p_member_id` 這個排除條件缺一不可 —— 沒有它的話,客服只是進來改個姓名錯字、
  -- 電話原封不動,也會被自己那一列擋下來。
  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '這支電話已經有會員:%。同一間商家底下,一支電話只能有一位會員 —— 如果是同一位客戶,請直接使用那一筆;如果真的是不同的人,請改填另一支電話', v_conflict_name;
    end if;
  end if;

  -- #615:會員分級,同 create_member 的驗證邏輯。
  if p_tier_id is not null then
    if not exists (
      select 1 from public.merchant_member_tiers
      where id = p_tier_id and merchant_id = v_merchant_id and status = 'active'
    ) then
      raise exception '找不到指定的會員等級,或不屬於這間商家/已下架';
    end if;
  end if;

  update public.members set
    name = btrim(p_name),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    birthday = p_birthday,
    notes = p_notes,
    tier_id = p_tier_id
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_member(uuid, text, text, text, date, text, uuid) is '模組 10 §3.4(SPECS-INDEX #615/#618 疊加):編輯會員基本資料。#618 移除電話必填檢查。#615 新增 p_tier_id(選填,重新指派會員等級,傳 null 代表清空成未分級)。不接受修改 referred_by_member_id(既有規則不變)。權限維持只檢查 can_manage_members。SPECS-INDEX #931(2026-09-30 使用者裁決):改電話時先比對同商家**其他** active 會員(m.id <> p_member_id 這個排除條件缺一不可,否則只改姓名錯字也會被自己那一列擋下),撞到就 raise「這支電話已經有會員:某某某」。已下架的同號紀錄不擋。⚠️ 關於 CSV 匯入(2026-10-01 品管實測後修正的說明):這支函式確實是 import_members_batch 在 upsert_by_phone 模式下的更新路徑,所以 #827 的電話格式檢查在那條路徑上是真的會生效;但 #931 的唯一性檢查在那條路徑上**實務上不會觸發** —— 匯入是先用電話找到那一位既有會員、再拿同一支電話去更新他本人,而唯一性檢查本來就排除自己(m.id <> p_member_id)。至於 insert_only 模式下的重複電話,完全不會走到這支函式(它在呼叫 create_member 之前就被短路成 skipped 了),那條路徑的指名訊息是 20260930040500 補的。【SPECS-INDEX #827,2026-09-30 使用者裁決 Q5 = (A)】同時補上會員電話的格式檢查(排在唯一性檢查前面,理由同 create_member)。既有的髒電話依使用者裁決不主動清,但客服一進來編輯就會被要求先改正確(跟 update_booking 對舊訂單的既有處理方式一致);正式庫目前不合格 0 筆,實際上沒有人會遇到。';

revoke execute on function public.update_member(uuid, text, text, text, date, text, uuid) from public, anon;
grant execute on function public.update_member(uuid, text, text, text, date, text, uuid) to authenticated;

-- =========================================================================
-- 4. reactivate_member:重新上架前先確認這支電話沒有被別人佔走
-- =========================================================================
-- 🔴 為什麼這一支也必須改(這是**本批自己造成的回歸**,不是既有問題):
--    上面那個 partial unique index 只約束 status = 'active'。所以
--    「下架 A(電話 0912…)→ 期間有人用同一支電話建了 B → 客服按『重新上架』把 A 改回 active」
--    這條路徑會直接撞到索引,吐出 Postgres 原生的英文訊息
--    `duplicate key value violates unique constraint "members_merchant_active_phone_uniq"`。
--    客服看到英文亂碼完全不知道發生什麼事,更不知道要去找誰 —— 不能讓我們加的索引把一顆既有按鈕
--    弄成這樣。所以這裡補上跟 create_member 同一套的事前檢查 + **指名是誰**的白話訊息。
--
-- 逐字沿用最新版本 20260920140100_members_core_functions.sql
-- (md5 = 453a466049ba283cdbb4067ceaf3424e、長度 461,2026-09-30 對正式庫 pg_proc.prosrc 核對
--  逐字相符)。簽章不變(1 個參數)⇒ create or replace。
create or replace function public.reactivate_member(p_member_id uuid)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result public.members;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_phone text;
  v_normalized_phone text;
  v_conflict_name text;
begin
  -- 原本只 select merchant_id,這次多取 phone(唯一性檢查要用)。
  select merchant_id, phone into v_merchant_id, v_phone
  from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  -- SPECS-INDEX #931(2026-09-30):重新上架等於讓這一列變成 active,所以要跟「其他 active 會員」
  -- 比對電話。`m.id <> p_member_id` 不可省(否則自己也會被算進去)。
  v_normalized_phone := private.normalize_phone(v_phone);
  if v_normalized_phone is not null then
    select m.name into v_conflict_name
    from public.members m
    where m.merchant_id = v_merchant_id
      and m.id <> p_member_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
    limit 1;

    if v_conflict_name is not null then
      raise exception '不能重新上架:這位會員的電話現在已經有另一位使用中的會員:%。同一間商家底下,一支電話只能有一位會員 —— 請先把其中一邊的電話改掉(或把那一位下架),再重新上架這一位', v_conflict_name;
    end if;
  end if;

  update public.members set status = 'active' where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.reactivate_member(uuid) is '模組 10 §3.5:重新上架會員(status=active)。【SPECS-INDEX #931,2026-09-30】重新上架前先檢查:同商家**其他** active 會員裡有沒有人的電話跟這一位相同(m.id <> p_member_id 不可省),有就 raise「這支電話現在已經有另一位使用中的會員:某某某」並說明怎麼處理。🔴 這一段不是「順手加的防呆」,而是本批加了 members_merchant_active_phone_uniq 之後**必須補**的白話訊息 —— 不補的話,「下架 A → 別人用同一支電話建了 B → 重新上架 A」這條既有路徑會直接吐 Postgres 原生的英文 duplicate key 錯誤給客服看。';

revoke execute on function public.reactivate_member(uuid) from public, anon;
grant execute on function public.reactivate_member(uuid) to authenticated;

-- =========================================================================
-- 5. transfer_members_to_merchant:整批搬遷前先確認目標商家沒有同號的使用中會員
-- =========================================================================
-- 🔴 同樣是本批造成的回歸:搬遷是 `update members set merchant_id = 目標商家`,所以只要目標商家
--    已經有一位同號的 active 會員,就會撞到 unique index → 原生英文錯誤,而且是**整批**失敗,
--    客服完全不知道是哪一筆卡住。
-- ⚠️ 規格書寫「transfer_members_to_merchant 是搬整列、欄位跟著搬,不需要改」—— 那是在**還沒有
--    唯一索引**的前提下寫的,已經過時。
-- 📌 為什麼不用擔心「同一批裡面兩位同號」:來源商家本身已經受同一個索引約束(一支電話最多一位
--    active),所以同一批 active 會員之間不可能同號;已下架的成員搬過去仍然是 removed,不進索引。
--
-- 逐字沿用最新版本 20260920170300_data_import_industry_transfer.sql
-- (md5 = 96ceb4002f9acff210775c9f43a94635、長度 3341,2026-09-30 對正式庫 pg_proc.prosrc 核對
--  逐字相符)。簽章不變(3 個參數)⇒ create or replace。
-- 新增的檢查刻意放在既有「所有會員必須屬於來源商家」那道檢查之後、**任何寫入之前**,
-- 沿用這支函式既有的「任何一筆不合格就整批拒絕」的原子性風格。
-- ⚠️ 既有訊息裡的全形逗號(，)是原檔的寫法,刻意逐字保留,只有新增那一段用半形。
create or replace function public.transfer_members_to_merchant(
  p_source_merchant_id uuid,
  p_target_merchant_id uuid,
  p_member_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_group uuid;
  v_target_group uuid;
  v_operation_id uuid;
  v_members_snapshot jsonb;
  v_bookings_snapshot jsonb;
  v_full_snapshot jsonb;
  v_member_count int;
  -- SPECS-INDEX #931 新增的三個區域變數。
  v_conflict_moving_name text;
  v_conflict_target_name text;
  v_conflict_phone text;
begin
  -- 規則 2.1(核心):只有商家管理員能發動。
  if not private.is_merchant_admin(p_source_merchant_id) then
    raise exception '你不是來源商家的管理員，無法搬遷資料' using errcode = '42501';
  end if;

  -- 規則 2.10(核心，安全邊界)①②:呼叫者必須同時是來源+目標商家的管理員。
  if not private.is_merchant_admin(p_target_merchant_id) then
    raise exception '你不是目標商家的管理員，無法把資料搬過去' using errcode = '42501';
  end if;

  select group_id into v_source_group from public.merchants where id = p_source_merchant_id;
  select group_id into v_target_group from public.merchants where id = p_target_merchant_id;

  if v_source_group is null then
    raise exception '找不到來源商家';
  end if;
  if v_target_group is null then
    raise exception '找不到目標商家';
  end if;

  -- 規則 2.10(核心，安全邊界)③:兩間商家必須同一集團。
  if v_source_group <> v_target_group then
    raise exception '這兩間商家不屬於同一個集團，無法搬遷資料';
  end if;

  if p_source_merchant_id = p_target_merchant_id then
    raise exception '來源商家跟目標商家不能是同一間';
  end if;

  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception '請選擇至少一位要搬遷的會員';
  end if;

  -- 3.6 步驟 2:所有選取的會員必須屬於來源商家，任何一筆不屬於就整批拒絕(原子性操作)。
  if exists (
    select 1 from unnest(p_member_ids) as mid
    where not exists (
      select 1 from public.members m where m.id = mid and m.merchant_id = p_source_merchant_id
    )
  ) then
    raise exception '選取的會員清單中，有會員不屬於來源商家，整批搬遷已取消';
  end if;

  -- SPECS-INDEX #931(2026-09-30):目標商家底下一支電話只能有一位 active 會員。
  -- 在**任何寫入之前**先找出第一筆會撞到的組合,訊息要講清楚「是哪一筆卡住、跟誰撞」,
  -- 不能只說整批失敗(客服要知道去改哪一位)。
  -- `not (tg.id = any(p_member_ids))`:目標商家那一邊要排除「這次也一起被搬走的」那些人。
  -- order by 讓「先報哪一筆」是穩定的(同樣的輸入永遠得到同樣的訊息,客服重試時不會看到不同答案)。
  select mv.name, tg.name, mv.phone
  into v_conflict_moving_name, v_conflict_target_name, v_conflict_phone
  from public.members mv
  join public.members tg
    on tg.merchant_id = p_target_merchant_id
   and tg.status = 'active'
   and private.normalize_phone(tg.phone) = private.normalize_phone(mv.phone)
   and not (tg.id = any(p_member_ids))
  where mv.id = any(p_member_ids)
    and mv.status = 'active'
    and private.normalize_phone(mv.phone) is not null
  order by mv.name, tg.name, mv.id
  limit 1;

  if v_conflict_moving_name is not null then
    raise exception '整批搬遷已取消:要搬過去的會員「%」(電話 %),跟目標商家現有的會員「%」是同一支電話。同一間商家底下,一支電話只能有一位會員 —— 請先處理掉其中一邊(改電話,或把其中一位下架),再重新搬遷',
      v_conflict_moving_name, v_conflict_phone, v_conflict_target_name;
  end if;

  v_member_count := array_length(p_member_ids, 1);

  -- 規則 2.7:記錄復原所需資訊——搬遷前的 merchant_id，以及即將被斷開連結的訂單原本指向誰。
  select coalesce(jsonb_object_agg(id::text, jsonb_build_object('merchant_id', merchant_id)), '{}'::jsonb)
    into v_members_snapshot
  from public.members
  where id = any(p_member_ids);

  select coalesce(jsonb_object_agg(id::text, to_jsonb(member_id::text)), '{}'::jsonb)
    into v_bookings_snapshot
  from public.bookings
  where merchant_id = p_source_merchant_id
    and member_id = any(p_member_ids);

  v_full_snapshot := jsonb_build_object('members', v_members_snapshot, 'bookings_member_id', v_bookings_snapshot);

  insert into public.merchant_bulk_operations (
    merchant_id, operation_type, related_merchant_id, total_rows, success_rows,
    pre_operation_snapshot, created_by_user_id
  ) values (
    p_source_merchant_id, 'industry_transfer_members', p_target_merchant_id, v_member_count, v_member_count,
    v_full_snapshot, auth.uid()
  ) returning id into v_operation_id;

  -- 3.6 步驟 4:更新選中會員的 merchant_id，連帶更新其分類帳紀錄的 merchant_id
  -- (points_balance 完全不變，判斷 7:單純資料搬家，不是重新計算)。
  update public.members
  set merchant_id = p_target_merchant_id
  where id = any(p_member_ids);

  update public.member_point_transactions
  set merchant_id = p_target_merchant_id
  where member_id = any(p_member_ids);

  -- 規則 2.11(核心，本規格書主動抓到的資料隔離風險):舊商家所有引用這批會員的訂單，member_id
  -- 設為 null(member_name_snapshot 純文字保留),避免新商家透過搬過去的會員看到舊商家的訂單明細。
  update public.bookings
  set member_id = null
  where merchant_id = p_source_merchant_id
    and member_id = any(p_member_ids);

  insert into public.merchant_bulk_operation_items (operation_id, entity_table, entity_id, action)
  select v_operation_id, 'members', mid, 'updated' from unnest(p_member_ids) as mid;

  return v_operation_id;
end;
$$;

comment on function public.transfer_members_to_merchant(uuid, uuid, uuid[]) is '模組 12 §3.6(核心，規則 2.10/2.11):把選定的會員(含紅利點數歷史)整批搬到目標商家。呼叫者必須同時是來源+目標商家的管理員，且兩間商家必須同一集團(規則 2.10)。搬遷同一交易內順帶把舊商家引用這批會員的訂單 member_id 設為 null，避免跨商家資料外洩(規則 2.11)。【SPECS-INDEX #931,2026-09-30】搬遷前(任何寫入之前)多一道檢查:要搬過去的 active 會員裡,有沒有人的電話跟目標商家現有的 active 會員相同(排除這次一起搬走的那些人),有就整批拒絕,而且訊息要指名「是哪一筆卡住、跟目標商家的誰撞、電話是多少」,不能只說整批失敗。🔴 這一段是本批加了 members_merchant_active_phone_uniq 之後**必須補**的:不補的話這支函式會直接吐 Postgres 原生的英文 duplicate key 錯誤,而且是整批失敗,客服無法判斷要改哪一位。規格書原文寫「這支不需要改」是在還沒有唯一索引的前提下寫的,已過時。📌 同一批裡面不可能有兩位同號的 active 會員(來源商家本身就受同一個索引約束),已下架的成員搬過去仍然是 removed、不進索引。';

revoke execute on function public.transfer_members_to_merchant(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.transfer_members_to_merchant(uuid, uuid, uuid[]) to authenticated;
