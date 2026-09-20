-- 模組 12:資料匯入/報表匯出 — transfer_members_to_merchant(第四支)。
-- 對應規格書 §2.10(核心必測，防止跨商家資料外洩)/§2.11(核心必測，訂單連結斷開)/§3.6。
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

comment on function public.transfer_members_to_merchant(uuid, uuid, uuid[]) is '模組 12 §3.6(核心，規則 2.10/2.11):把選定的會員(含紅利點數歷史)整批搬到目標商家。呼叫者必須同時是來源+目標商家的管理員，且兩間商家必須同一集團(規則 2.10)。搬遷同一交易內順帶把舊商家引用這批會員的訂單 member_id 設為 null，避免跨商家資料外洩(規則 2.11)。';

revoke execute on function public.transfer_members_to_merchant(uuid, uuid, uuid[]) from public, anon;
grant execute on function public.transfer_members_to_merchant(uuid, uuid, uuid[]) to authenticated;
