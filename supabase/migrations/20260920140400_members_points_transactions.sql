-- 模組 10:會員與紅利 — redeem_member_points / adjust_member_points / grant_pending_birthday_bonuses
-- (第五支)。對應規格書 §3.9~§3.11、規則 2.5~2.7。

-- =========================================================================
-- 3.9:redeem_member_points(規則 2.7)。一般 merchant_agent_permissions('members') 授權即可,
-- 不像 adjust_member_points 限定管理員(規則 2.6 的唯一例外)。
-- =========================================================================
create or replace function public.redeem_member_points(
  p_member_id uuid,
  p_points integer,
  p_note text
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_balance integer;
  v_new_balance integer;
  v_result public.members;
begin
  select merchant_id, points_balance into v_merchant_id, v_balance
  from public.members
  where id = p_member_id
  for update;

  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_points is null or p_points <= 0 then
    raise exception '兌換點數必須大於 0';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception '請說明這次兌換的用途';
  end if;

  if p_points > v_balance then
    raise exception '這位會員目前只有 % 點,無法兌換 % 點', v_balance, p_points;
  end if;

  v_new_balance := v_balance - p_points;

  insert into public.member_point_transactions (
    member_id, merchant_id, transaction_type, points_delta, balance_after, note, created_by_user_id
  ) values (
    p_member_id, v_merchant_id, 'redeem', -p_points, v_new_balance, p_note, auth.uid()
  );

  update public.members set points_balance = v_new_balance where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.redeem_member_points(uuid, integer, text) is '模組 10 §3.9(規則 2.7):登記兌換/使用點數,只能消耗既有餘額、不能讓餘額變負,p_note 必填。跟本模組其餘操作一樣用一般 merchant_agent_permissions(members)授權(規則 2.6 的對照組:只有 adjust_member_points 特別鎖死管理員)。';

revoke execute on function public.redeem_member_points(uuid, integer, text) from public, anon;
grant execute on function public.redeem_member_points(uuid, integer, text) to authenticated;

-- =========================================================================
-- 3.10:adjust_member_points(規則 2.6 核心,唯一只限管理員的操作)。
-- =========================================================================
create or replace function public.adjust_member_points(
  p_member_id uuid,
  p_points_delta integer,
  p_note text
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_balance integer;
  v_new_balance integer;
  v_result public.members;
begin
  select merchant_id, points_balance into v_merchant_id, v_balance
  from public.members
  where id = p_member_id
  for update;

  if not found then
    raise exception '找不到這位會員';
  end if;

  -- 規則 2.6(核心):只檢查 private.is_merchant_admin,不接受客服呼叫,即使該客服已經被授權
  -- members 這個 section_key 也一樣被擋下。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '手動調整會員點數,只有商家管理員可以操作' using errcode = '42501';
  end if;

  if p_points_delta is null or p_points_delta = 0 then
    raise exception '調整點數不可為 0';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception '請填寫調整原因';
  end if;

  v_new_balance := v_balance + p_points_delta;

  if v_new_balance < 0 then
    raise exception '這位會員目前只有 % 點,調整後不能變成負數', v_balance;
  end if;

  insert into public.member_point_transactions (
    member_id, merchant_id, transaction_type, points_delta, balance_after, note, created_by_user_id
  ) values (
    p_member_id, v_merchant_id, 'manual_adjustment', p_points_delta, v_new_balance, p_note, auth.uid()
  );

  update public.members set points_balance = v_new_balance where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.adjust_member_points(uuid, integer, text) is '模組 10 §3.10(核心,規則 2.6):手動調整會員點數,只有商家管理員可以呼叫(private.is_merchant_admin),不透過 merchant_agent_permissions 開放給客服——比照模組 8 recalculate_booking_commission 的同一套理由,這是能無中生有增減點數餘額(等同一種「準金錢」價值)的敏感操作。p_note 必填(要求填寫調整原因)。不允許調整後餘額變負(規則 2.7),管理員最多只能扣到剛好 0。';

revoke execute on function public.adjust_member_points(uuid, integer, text) from public, anon;
grant execute on function public.adjust_member_points(uuid, integer, text) to authenticated;

-- =========================================================================
-- 3.11:grant_pending_birthday_bonuses(規則 2.5)。前端在會員管理列表頁載入時呼叫,不是
-- 背景排程(這個系統目前完全沒有排程機制,判斷 5)。以「生日當月」容錯,不是嚴格當天。
-- =========================================================================
create or replace function public.grant_pending_birthday_bonuses(p_merchant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_require_verified boolean;
  v_bonus_points integer;
  v_granted_count integer := 0;
  v_member record;
  v_new_balance integer;
  v_current_year integer := extract(year from current_date)::int;
begin
  if not private.can_manage_members(p_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  select require_verified_phone_for_rewards, birthday_bonus_points
  into v_require_verified, v_bonus_points
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    v_require_verified := false;
    v_bonus_points := 0;
  end if;

  for v_member in
    select id, phone_verified, points_balance
    from public.members
    where merchant_id = p_merchant_id
      and status = 'active'
      and birthday is not null
      and extract(month from birthday) = extract(month from current_date)
      and (last_birthday_bonus_year is null or last_birthday_bonus_year < v_current_year)
    for update
  loop
    -- 規則 2.8:政策開啟時,未驗證電話的會員這條路徑靜默略過,不標記年份(留給下次驗證後補發)。
    if v_require_verified and not coalesce(v_member.phone_verified, false) then
      continue;
    end if;

    if v_bonus_points > 0 then
      v_new_balance := v_member.points_balance + v_bonus_points;
      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after
      ) values (
        v_member.id, p_merchant_id, 'birthday_bonus', v_bonus_points, v_new_balance
      );
      update public.members set points_balance = v_new_balance where id = v_member.id;
    end if;

    -- 規則 2.5:不論獎勵點數是否 > 0,都更新 last_birthday_bonus_year,避免之後調高金額
    -- 又對同一位會員在同一年重複核發。
    update public.members set last_birthday_bonus_year = v_current_year where id = v_member.id;

    v_granted_count := v_granted_count + 1;
  end loop;

  return v_granted_count;
end;
$$;

comment on function public.grant_pending_birthday_bonuses(uuid) is '模組 10 §3.11(規則 2.5):任何有 members 權限的人打開會員管理列表頁時觸發,檢查該商家「生日在本月、今年還沒發過生日獎勵」的會員並一次核發完畢,用 last_birthday_bonus_year 防止同一年重複核發。用「生日當月」而不是嚴格「當天」容錯(這個系統目前沒有背景排程機制,判斷 5)。回傳實際處理的會員數量,供前端顯示提示,冪等操作,重複呼叫不會有副作用。';

revoke execute on function public.grant_pending_birthday_bonuses(uuid) from public, anon;
grant execute on function public.grant_pending_birthday_bonuses(uuid) to authenticated;
