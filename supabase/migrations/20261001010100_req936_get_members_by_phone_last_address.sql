-- SPECS-INDEX #936(2026-10-01,第二波):建單表單點選候選會員時,要把「姓名 + 地址」帶進表單。
-- 規格:.project/specs/建單自動建立會員與會員兩層狀態.md §12.2
--
-- ═══ 為什麼要動資料庫(規格書沒預料到的落差,已在回報中請主腦確認)═══════════════════════
-- 規格寫「會員沒有地址 ⇒ 不動欄位」,前提是會員有地址欄位 —— 但 public.members **根本沒有地址欄位**
-- (實查 src/integrations/supabase/types.ts 的 members.Row)。照字面做,地址永遠帶不進去,
-- 使用者點名要的「姓名、地址資料不對,客服再手動更改就好」有一半落空(到府派工產業最需要地址)。
-- ⇒ engineer 的判斷:地址取「這位會員在本商家最近一筆有填地址的訂單」的 customer_address。
--    - 不新開端點:沿用建單頁本來就在打的 get_members_by_phone,多回傳一個 key。
--    - 權限不變:can_manage_bookings(本來就看得到本商家所有訂單的地址),沒有擴大可見範圍。
--    - 🔴 只取本商家訂單(b.merchant_id = p_merchant_id),見函式內註解。
--    若主腦/使用者不採用這個做法,把本檔刪掉即可:前端把缺少這個 key 當成 null,不會壞。
--
-- ═══ 逐字沿用的基準版本 ═════════════════════════════════════════════════════════════
-- get_members_by_phone ← 20260930040400_req929_get_members_by_phone_prefix_search.sql(第一波,尚未部署;
-- 正式庫目前仍是 #929 之前的版本,兩批會一起上線)。除了標 #936 的兩處,其餘逐字相同。
-- 簽章、回傳型別(jsonb)不變 ⇒ create or replace,不 drop;ACL 照慣例原樣重寫一次。
--
-- ⚠️ 本檔沒有任何 INSERT/UPDATE/DELETE,只有一支函式定義。

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
        'blacklist_reason', t.blacklist_reason,
        -- SPECS-INDEX #936(2026-10-01):點選候選時要把地址帶進建單表單,但 members 沒有地址欄位
        -- ⇒ 取「這位會員在**本商家**最近一筆有填地址的訂單」的地址;沒有就是 null(前端不動欄位)。
        'last_booking_address', t.last_booking_address
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
      ) as last_booking_date,
      -- SPECS-INDEX #936:只取**本商家**(b.merchant_id = p_merchant_id)的訂單地址。
      -- 🔴 這個 merchant_id 條件不能拿掉:transfer_members_to_merchant 會把會員搬到別的商家,
      --    那位會員的舊訂單仍然掛在舊商家底下 —— 不加這條,新商家的客服就會在候選清單裡
      --    看到舊商家那邊的客戶地址(跨商家資料外洩,對照 module12_01 的同類斷言)。
      (
        select b.customer_address
        from public.bookings b
        where b.member_id = m.id
          and b.merchant_id = p_merchant_id
          and nullif(btrim(coalesce(b.customer_address, '')), '') is not null
        order by b.start_at desc, b.created_at desc, b.id
        limit 1
      ) as last_booking_address
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

comment on function public.get_members_by_phone(uuid, text) is '模組 10 §10.2.1(SPECS-INDEX #614):建單頁輸入客戶電話時,列出這支電話底下這個商家的既有客戶(電話用 private.normalize_phone 正規化後比對),附最近一筆預約日期(不限狀態,start_at 最大值,查無訂單為 null)跟黑名單標記(is_blacklisted/blacklist_reason,#616)。權限只要求 can_manage_bookings(orders 權限,建單本身的權限邊界,不需要 members 權限)。只在本商家內比對,不做跨商家查詢,只查 status=''active''。【SPECS-INDEX #929,2026-09-30】比對規則從「完全相等」改成「**前綴相符**」(使用者要的即時前綴搜尋:打 0903 就列出所有 0903 開頭的電話,每多打一個字自動收斂一次;前端每打一個字本來就會重查,不需要改)。🔴 同時定了兩個門檻:① **最少 4 位數字**(正規化後),不足就回空陣列 —— 否則客服只打一個 ''0'' 會把整間商家的會員全部撈出來(台灣電話一律 0 開頭);4 是使用者自己舉的例子「0903」的長度,是必須能用的最低字數。② **回傳上限 20 筆** —— 前綴比對的候選比完全相等多很多,而這支函式對每位候選都要跑一次「最近一筆預約」子查詢;20 已遠超過人眼一次會掃的量。為了讓上限**永遠不會切掉正確答案**,排序刻意把「電話完全相等」的那一筆排在最前面(打完整支號碼時它一定是第 1 筆),jsonb_agg 與子查詢的 order by 保持一致。🟢 這支函式只決定「畫面上列哪些候選」:create_booking 的自動連結(#912)**不呼叫它**,而是自己跑沒有筆數上限的完全相等比對 ⇒ 前綴/上限不可能讓系統連結到錯的人。📌 跟 #931(一支電話只能有一位會員)不衝突:前綴搜尋列出的多筆是不同電話,不是同一支電話的多個人。【SPECS-INDEX #936,2026-10-01】每位候選多回傳一個 key:last_booking_address = 這位會員在**本商家**(bookings.merchant_id = p_merchant_id)最近一筆有填地址的訂單地址,沒有就是 null。用途:建單表單點選候選時把地址帶入(members 表本身沒有地址欄位)。限定本商家是因為 transfer_members_to_merchant 搬過的會員,舊訂單仍屬舊商家,不可外洩。其餘 6 個 key、排序、門檻、權限都不變。';

revoke execute on function public.get_members_by_phone(uuid, text) from public, anon;
grant execute on function public.get_members_by_phone(uuid, text) to authenticated;
