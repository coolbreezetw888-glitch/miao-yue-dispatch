-- SPECS-INDEX #929(資料庫那一半):get_members_by_phone 的電話比對從「完全相等」改成「前綴比對」。
--
-- ═══ 使用者要的行為(原話)═══════════════════════════════════════════════════════════
-- 「電話**不一定要完整輸入**,比如開頭 0903 就會先列出所有 0903 開頭的電話,
--   **每增加一個字就重新顯示一次**。」
-- 正確術語:即時前綴搜尋 / 輸入即查(type-ahead、autocomplete)。
--
-- ═══ 為什麼只改資料庫這一行就夠了(主腦已查證)═══════════════════════════════════════
-- ・舊的比對是 `private.normalize_phone(m.phone) = v_normalized_phone` —— **完全相等**,
--   所以打到一半(例如 0903)一律回空陣列,要打完整支號碼才會跳出候選。
-- ・前端 useMembersByPhone 的 enabled 條件是 `phone.trim().length > 0`,
--   **本來就每打一個字就重查一次** ⇒ 前端不用改。
-- ・回傳的 JSON **形狀完全不變**(還是一個陣列,每個元素還是那 6 個 key),
--   所以既有前端與既有 pgTAP 的 `jsonb_array_length(...)`、`jsonb_array_elements(...)` 都不用改。
--
-- ═══ 🔴 兩個門檻(這兩個一定要一起定,少任何一個都會出事)═══════════════════════════════
--
-- ① **最少字數 = 4 位數字**(正規化後)。低於 4 一律回空陣列,跟「還在輸入中途」同一個處理。
--    ・為什麼需要:不設門檻的話,客服只打一個 `0`,前綴比對會把**整間商家幾乎所有會員**
--      一次撈出來(台灣電話一律 0 開頭)—— 那不是搜尋,那是把整本客戶名冊倒在畫面上,
--      而且每打一個字就重跑一次。
--    ・為什麼是 4 而不是 3 或 5:使用者自己舉的例子就是「開頭 0903」= **4 位**,
--      這是必須能用的最低字數。而 4 位已經足以區分不同的門號前綴(09xx)與市話區碼 + 1 碼,
--      篩選力道夠;再往上設(例如 6)就違背使用者「打一半就要看到」的要求。
--
-- ② **回傳筆數上限 = 20 筆**。
--    ・為什麼需要:前綴比對的候選會比完全相等多很多(舊行為幾乎永遠是 0 或 1 筆)。
--      這支函式對每一位候選都要跑一次「最近一筆預約日期」的子查詢,而且每打一個字就重跑,
--      沒有上限的話 payload 與查詢成本都沒有天花板。
--    ・為什麼是 20:這份清單是掛在建單表單「客戶電話」欄位下方的候選列表,
--      人眼一次能掃的量大約十幾筆;20 已經遠超過「客服會一筆一筆看」的量,
--      同時小到 payload 與查詢都很便宜。要更精準的話客服只要再多打一兩個數字就會自動收斂
--      (這正是使用者要的「每增加一個字就重新顯示一次」)。
--    ・🔴 為了讓上限**永遠不會把正確答案切掉**:排序刻意把「**完全相等**的那一筆排在最前面」。
--      所以客服把整支號碼打完時,那位會員一定在第 1 筆,不可能因為截斷而消失。
--      這一條是上限能安全存在的前提,不要為了「排序看起來比較單純」把它拿掉。
--
-- ═══ 🟢 這條改動不會影響「自動連結會員」的正確性(很重要,不要誤以為會)═══════════════════
-- create_booking 的自動連結(#912)**不呼叫這支函式**,它自己跑一段
-- `private.normalize_phone(m.phone) = v_normalized_phone` 的**完全相等**比對,而且沒有筆數上限。
-- ⇒ 前綴比對與筆數上限只影響「畫面上列出哪些候選」,**不可能**讓系統連結到錯的人,
--   也不可能因為截斷而漏掉「這支電話已經有會員」的判斷。
--
-- ═══ 📌 跟 #931 不衝突 ═════════════════════════════════════════════════════════════
-- #931 規定「同一支電話在同一商家只能有一位會員」。前綴搜尋列出的多筆是**不同電話**
-- (0903111111、0903222222…),不是同一支電話的多個人,兩件事沒有矛盾。
--
-- ═══ 逐字沿用的基準版本 ═════════════════════════════════════════════════════════════
-- get_members_by_phone ← 20260923010500_req614_get_members_by_phone_function.sql
--   ⚠️ 2026-09-30 對正式庫核對:線上 prosrc 的 md5 是 31ad8bd8de15abeab2eed762a09fb3f9(長度 1162),
--      檔案本體(CRLF→LF)是 f0cbc6bafa148dd91b16cc88e9c7b9ce(長度 1229),**不相符**。
--      逐字比對過差異:只有 `if v_normalized_phone is null then` 裡面那兩行中文註解在線上被拿掉,
--      **可執行的 SQL 完全一致**。這是 supabase-permission-hygiene 規則 6 記錄過的既有現象
--      (apply_migration 會壓縮註解),repo 檔案才是正本 ⇒ 本檔以 repo 檔案為基準。
-- 簽章不變(2 個參數)⇒ create or replace,不需要 drop。
--
-- ⚠️ 本檔沒有任何 UPDATE/DELETE,只有一支函式定義。

create or replace function public.get_members_by_phone(p_merchant_id uuid, p_phone text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  -- SPECS-INDEX #929:兩個門檻寫成具名常數,不要散在 SQL 裡 —— 以後要調整只會有一個地方。
  c_min_digits constant int := 4;
  c_max_results constant int := 20;
  v_normalized_phone text;
  v_result jsonb;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的客戶' using errcode = '42501';
  end if;

  v_normalized_phone := private.normalize_phone(p_phone);
  if v_normalized_phone is null then
    -- 邊界情況(§10.2.1):電話為空字串/格式不完整(客服可能還在輸入中途),直接回傳空陣列,
    -- 不報錯。
    return '[]'::jsonb;
  end if;

  -- SPECS-INDEX #929 門檻①:少於 c_min_digits 位數字時,跟「還在輸入中途」一樣回空陣列。
  -- 不報錯 —— 客服本來就是一個字一個字打進來的,每打一個字都跳一次錯誤訊息只會很吵。
  if length(v_normalized_phone) < c_min_digits then
    return '[]'::jsonb;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'member_id', t.member_id,
        'name', t.name,
        'phone', t.phone,
        'last_booking_date', t.last_booking_date,
        'is_blacklisted', t.is_blacklisted,
        'blacklist_reason', t.blacklist_reason
      )
      -- 🔴 jsonb_agg 自己的 order by 要跟下面子查詢的 order by 一致,否則「截斷之後留下哪 20 筆」
      --    跟「這 20 筆在畫面上的順序」會是兩套規則,看起來像 bug。
      order by t.exact_match_first, t.last_booking_date desc nulls last, t.name, t.member_id
    ),
    '[]'::jsonb
  )
  into v_result
  from (
    select
      m.id as member_id,
      m.name,
      m.phone,
      m.is_blacklisted,
      m.blacklist_reason,
      -- 0 = 電話完全相等,1 = 只是前綴相符。完全相等的永遠排第一,所以「打完整支號碼」時
      -- 那位會員不可能被 c_max_results 切掉(見檔頭門檻②的說明)。
      case when private.normalize_phone(m.phone) = v_normalized_phone then 0 else 1 end as exact_match_first,
      (
        select max(b.start_at)
        from public.bookings b
        where b.member_id = m.id
      ) as last_booking_date
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.status = 'active'
      -- SPECS-INDEX #929:從「完全相等」改成「前綴相符」。
      -- 用 starts_with() 而不是 `like v_normalized_phone || '%'`:normalize_phone 只會留下數字,
      -- 所以理論上不可能出現 % 或 _ 這種 LIKE 萬用字元,但 starts_with 從根本上就不需要跳脫,
      -- 少一個「哪天正規化規則改了就變成注入面」的隱患。
      and starts_with(private.normalize_phone(m.phone), v_normalized_phone)
    order by
      case when private.normalize_phone(m.phone) = v_normalized_phone then 0 else 1 end,
      (select max(b.start_at) from public.bookings b where b.member_id = m.id) desc nulls last,
      m.name,
      m.id
    limit c_max_results
  ) t;

  return v_result;
end;
$$;

comment on function public.get_members_by_phone(uuid, text) is '模組 10 §10.2.1(SPECS-INDEX #614):建單頁輸入客戶電話時,列出這支電話底下這個商家的既有客戶(電話用 private.normalize_phone 正規化後比對),附最近一筆預約日期(不限狀態,start_at 最大值,查無訂單為 null)跟黑名單標記(is_blacklisted/blacklist_reason,#616)。權限只要求 can_manage_bookings(orders 權限,建單本身的權限邊界,不需要 members 權限)。只在本商家內比對,不做跨商家查詢,只查 status=''active''。【SPECS-INDEX #929,2026-09-30】比對規則從「完全相等」改成「**前綴相符**」(使用者要的即時前綴搜尋:打 0903 就列出所有 0903 開頭的電話,每多打一個字自動收斂一次;前端每打一個字本來就會重查,不需要改)。🔴 同時定了兩個門檻:① **最少 4 位數字**(正規化後),不足就回空陣列 —— 否則客服只打一個 ''0'' 會把整間商家的會員全部撈出來(台灣電話一律 0 開頭);4 是使用者自己舉的例子「0903」的長度,是必須能用的最低字數。② **回傳上限 20 筆** —— 前綴比對的候選比完全相等多很多,而這支函式對每位候選都要跑一次「最近一筆預約」子查詢;20 已遠超過人眼一次會掃的量。為了讓上限**永遠不會切掉正確答案**,排序刻意把「電話完全相等」的那一筆排在最前面(打完整支號碼時它一定是第 1 筆),jsonb_agg 與子查詢的 order by 保持一致。🟢 這支函式只決定「畫面上列哪些候選」:create_booking 的自動連結(#912)**不呼叫它**,而是自己跑沒有筆數上限的完全相等比對 ⇒ 前綴/上限不可能讓系統連結到錯的人。📌 跟 #931(一支電話只能有一位會員)不衝突:前綴搜尋列出的多筆是不同電話,不是同一支電話的多個人。';

revoke execute on function public.get_members_by_phone(uuid, text) from public, anon;
grant execute on function public.get_members_by_phone(uuid, text) to authenticated;
