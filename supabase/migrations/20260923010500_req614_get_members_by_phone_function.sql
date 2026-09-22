-- SPECS-INDEX #614(規格書 .project/specs/會員與紅利.md §10.2/§10.2.1)。
-- 新增預約會員比對邏輯:電話當查詢索引,不當唯一鍵。客服在建單頁輸入電話時,系統列出這支電話底下
-- 這個商家所有既有客戶(附最近消費日期+黑名單標記),可連結既有客戶或另外新建。
--
-- 比照 get_customer_related_bookings(20260918110200_order_management_functions.sql)的既有寫法:
-- 用 private.normalize_phone 正規化後比對,權限只要求 can_manage_bookings(orders 權限,建單本身
-- 的權限邊界,不需要 members 權限,呼應規則 2.10 既有精神)。

create or replace function public.get_members_by_phone(p_merchant_id uuid, p_phone text)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
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
      order by t.last_booking_date desc nulls last, t.name
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
      (
        select max(b.start_at)
        from public.bookings b
        where b.member_id = m.id
      ) as last_booking_date
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.status = 'active'
      and private.normalize_phone(m.phone) = v_normalized_phone
  ) t;

  return v_result;
end;
$$;

comment on function public.get_members_by_phone(uuid, text) is '模組 10 §10.2.1(SPECS-INDEX #614):建單頁輸入客戶電話時,列出這支電話底下這個商家所有既有客戶(電話正規化後相同,沿用 private.normalize_phone),附最近一筆預約日期(不限狀態,start_at 最大值,查無訂單為 null)跟黑名單標記(is_blacklisted/blacklist_reason,對應 #616),依最近消費日期新到舊排序。權限只要求 can_manage_bookings(orders 權限,建單本身的權限邊界,不需要 members 權限)。電話為空/格式不完整時直接回傳空陣列,不報錯(客服可能還在輸入中途)。只在本商家內比對,不做跨商家查詢。';

revoke execute on function public.get_members_by_phone(uuid, text) from public, anon;
grant execute on function public.get_members_by_phone(uuid, text) to authenticated;
