-- 模組 10:會員與紅利 — get_member_point_history / get_member_related_bookings / get_member_referrals
-- (第六支)。對應規格書 §3.12~§3.14、一之二節 RLS 影響評估方向二。

-- =========================================================================
-- 3.12:get_member_point_history。
-- =========================================================================
create or replace function public.get_member_point_history(p_member_id uuid)
returns table (
  id uuid,
  transaction_type text,
  points_delta integer,
  balance_after integer,
  note text,
  booking_id uuid,
  booking_start_at timestamptz,
  related_member_id uuid,
  related_member_name text,
  created_by_user_id uuid,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- 這支函式的 RETURNS TABLE 定義了一個叫 id 的輸出欄位,在 PL/pgSQL 裡會變成跟同名資料表欄位
  -- 衝突的識別字,底下對 members 表的查詢一律用 m.* 明確加上別名限定,避免 "column reference
  -- id is ambiguous" 這個典型的 RETURNS TABLE 坑。
  select m.merchant_id into v_merchant_id from public.members m where m.id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  return query
    select
      t.id, t.transaction_type, t.points_delta, t.balance_after, t.note,
      t.booking_id, b.start_at, t.related_member_id, rm.name,
      t.created_by_user_id, t.created_at
    from public.member_point_transactions t
    left join public.bookings b on b.id = t.booking_id
    left join public.members rm on rm.id = t.related_member_id
    where t.member_id = p_member_id
    order by t.created_at desc;
end;
$$;

comment on function public.get_member_point_history(uuid) is '模組 10 §3.12:回傳指定會員的點數異動明細(新到舊),含關聯訂單日期/被推薦會員姓名。檢查 can_manage_members。';

revoke execute on function public.get_member_point_history(uuid) from public, anon;
grant execute on function public.get_member_point_history(uuid) to authenticated;

-- =========================================================================
-- 3.13:get_member_related_bookings。對應一之二節 RLS 影響評估方向二:不透過 bookings 表的
-- 一般 RLS SELECT 政策(那是 private.can_manage_bookings),函式內部直接查詢(SECURITY DEFINER
-- 繞過 RLS),只回傳會員詳情頁需要的欄位。
-- =========================================================================
create or replace function public.get_member_related_bookings(p_member_id uuid)
returns table (
  id uuid,
  start_at timestamptz,
  status text,
  final_amount_snapshot numeric,
  service_item_names text[],
  earned_points integer
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- 同上:RETURNS TABLE 也定義了 id 欄位,查詢 members 表時明確加上別名限定。
  select m.merchant_id into v_merchant_id from public.members m where m.id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  -- 刻意檢查 can_manage_members,不是 can_manage_bookings——這是這支函式存在的核心理由
  -- (一之二節方向二),即使呼叫者只有 orders 權限、沒有 members 權限也一樣被擋下。
  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  return query
    select
      b.id,
      b.start_at,
      b.status,
      b.final_amount_snapshot,
      coalesce(
        (select array_agg(si.name order by si.name)
         from public.booking_service_items bsi
         join public.service_items si on si.id = bsi.service_item_id
         where bsi.booking_id = b.id),
        array[]::text[]
      ) as service_item_names,
      (select t.points_delta
         from public.member_point_transactions t
         where t.booking_id = b.id and t.transaction_type = 'earn_booking'
         limit 1) as earned_points
    from public.bookings b
    where b.member_id = p_member_id
    order by b.start_at desc
    limit 50;
end;
$$;

comment on function public.get_member_related_bookings(uuid) is '模組 10 §3.13(一之二節 RLS 影響評估方向二):回傳指定會員的歷史訂單清單(上限 50 筆,新到舊),含是否已核發紅利點數。SECURITY DEFINER 繞過 bookings_select,只回傳會員詳情頁需要的欄位,不曝露內部備註等敏感欄位。檢查 can_manage_members,不是 can_manage_bookings。';

revoke execute on function public.get_member_related_bookings(uuid) from public, anon;
grant execute on function public.get_member_related_bookings(uuid) to authenticated;

-- =========================================================================
-- 3.14:get_member_referrals。保留給模組 13 之後客戶自助介面的「我的推薦名單」直接複用。
-- =========================================================================
create or replace function public.get_member_referrals(p_member_id uuid)
returns table (
  id uuid,
  name text,
  status text,
  referral_rewarded_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- 同上:RETURNS TABLE 也定義了 id 欄位,查詢 members 表時明確加上別名限定。
  select m0.merchant_id into v_merchant_id from public.members m0 where m0.id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  return query
    select m.id, m.name, m.status, m.referral_rewarded_at, m.created_at
    from public.members m
    where m.referred_by_member_id = p_member_id
    order by m.created_at desc;
end;
$$;

comment on function public.get_member_referrals(uuid) is '模組 10 §3.14:回傳指定會員推薦過的人清單(姓名/狀態/是否已核發推薦獎勵/建立日期),保留給模組 13 之後客戶自助介面「我的推薦名單」直接複用。';

revoke execute on function public.get_member_referrals(uuid) from public, anon;
grant execute on function public.get_member_referrals(uuid) to authenticated;
