-- 客戶端第 4-B 批(模組 13)— migration 4:主腦裁決(風險 4)跨店搬會員時聯絡人一致
-- transfer_members_to_merchant:搬走前清掉這批會員所有客戶端聯絡人(removed_via = 'transfer',不寫封鎖)、
--   取消待處理加入申請、撤銷有效邀請;有聯絡人的會員同步清空 members.user_id / line_user_id / line_bound
--   (LINE 登入 channel 每店各自,到新店不能沿用;沒有聯絡人的會員 line_user_id 不動,跟改前一樣)。
-- 其餘逐字不變(由目前資料庫定義只插入一段,有 [c4b] 標記);權限 / 錯誤訊息不變。

alter table public.member_customer_contacts drop constraint member_customer_contacts_removed_via_check;
alter table public.member_customer_contacts add constraint member_customer_contacts_removed_via_check
  check (removed_via is null or removed_via in ('primary', 'self', 'store', 'unbind', 'stale', 'transfer'));
comment on column public.member_customer_contacts.removed_via is 'primary = 主要聯絡人移除(會封鎖);self = 自己退出;store = 店家移除(會封鎖);unbind = 店家解除 LINE 綁定(會封鎖);stale = 會員已刪除 / 搬到別店後,同帳號加入別的會員時自動清掉;transfer = 會員被搬到集團內別間店(不封鎖)。';

-- ─── public.transfer_members_to_merchant(C4-H01 補:搬會員時清聯絡人)───
CREATE OR REPLACE FUNCTION public.transfer_members_to_merchant(p_source_merchant_id uuid, p_target_merchant_id uuid, p_member_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    raise exception '整批搬遷已取消：要搬過去的會員「%」(電話 %)，跟目標商家現有的會員「%」是同一支電話。同一間商家底下，一支電話只能有一位會員 —— 請先處理掉其中一邊(改電話，或把其中一位下架)，再重新搬遷',
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
  -- [c4b begin] 客戶端第 4-B 批:LINE 登入 channel 是每間店各自的,搬到新店不能沿用 ⇒ 搬走前清掉這批會員的
  --   客戶端聯絡人(不封鎖)、取消待處理加入申請、撤銷有效邀請;有聯絡人的會員同步清空 user_id / line_user_id / line_bound。
  update public.members m
  set user_id = null, line_user_id = null, line_bound = false
  where m.id = any(p_member_ids)
    and exists (select 1 from public.member_customer_contacts c where c.member_id = m.id and c.status = 'active');
  update public.member_customer_contacts
  set status = 'removed', is_primary = false, removed_at = now(), removed_by_user_id = auth.uid(), removed_via = 'transfer'
  where member_id = any(p_member_ids) and status = 'active';
  update public.member_contact_requests
  set status = 'cancelled', resolved_at = now(), resolved_by_role = 'system'
  where member_id = any(p_member_ids) and status = 'pending';
  update public.member_contact_invites
  set revoked_at = now(), revoked_by_user_id = auth.uid()
  where member_id = any(p_member_ids) and used_at is null and revoked_at is null;
  -- [c4b end]

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
$function$;
