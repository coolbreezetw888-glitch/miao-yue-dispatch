-- 預約詳情資訊擴充與建單備註分類(功能層)
-- 對應規格書第一節第 4 點(create_booking/update_booking 新增 p_customer_notes)、
-- 第三節 3.2(預約客服/姓名顯示)、3.3(最後修改追蹤機制)、第五節第 1 點(不動既有驗證規則)。
--
-- **重蹈覆轍風險提醒(規格書第五節第 1 點,先前「建單表單細節修正」已經踩過一次坑)**:
-- create_booking/update_booking 這次又要新增參數(p_customer_notes)。新增參數會讓 Postgres
-- 判斷函式身分(名稱+參數型別清單)變成不同身分,`create or replace` 不會取代舊函式,而是額外
-- 建立一個重載(overload)版本,導致正式環境同時存在新舊兩個簽章版本,呼叫時報 42725
-- (function is not unique)。這裡照樣先明確 drop 掉舊的 11 個參數版本,再建立新的 12 個參數版本。

-- =========================================================================
-- get_booking_actor_names:把 bookings.created_by_user_id/last_modified_by_user_id 轉成
-- 可讀的姓名顯示(對應規格書 3.2/3.3)。
--
-- 一般客服(非商家管理員)沒辦法直接 SELECT 到 merchant_admins/其他人的 merchant_agents
-- 資料列(見 merchant_admins_select/merchant_agents_select 這兩條既有 RLS 政策,只放行本人跟
-- 商家管理員),所以包一支 SECURITY DEFINER 函式,只回傳算好的顯示名稱字串,不洩漏原始
-- email/其他欄位。權限檢查用 private.can_manage_bookings(跟預約詳情本身的 RLS 一致,不是
-- is_merchant_admin),讓被開通 orders 權限的客服也能查詢建立者/最後修改者姓名。
--
-- 判斷順序:先查 merchant_admins(該 user_id 是這間商家的管理員,顯示 display_name,沒填
-- fallback email 的 @ 前半段,再 fallback「管理員」,跟首頁個人資料卡片 emailNamePrefix 的
-- fallback 邏輯一致);查不到管理員再查 merchant_agents(該 user_id 是這間商家的客服,不論
-- 目前是 active 還是已被 status='removed' 軟移除都查得到,顯示 nickname,沒填 fallback name
-- 欄位——name 是必填欄位,一定有值);兩邊都查不到才顯示「(已移除的人員)」(規格書 3.2 的情境:
-- 例如 merchant_admins 是硬刪除,整筆真的消失)。
-- =========================================================================
create or replace function public.get_booking_actor_names(
  p_merchant_id uuid,
  p_user_ids uuid[]
)
returns table (
  user_id uuid,
  display_name text
)
language plpgsql
security definer
stable
set search_path = public
as $$
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的預約資料' using errcode = '42501';
  end if;

  return query
  select
    uids.uid,
    coalesce(admin_match.admin_name, agent_match.agent_name, '(已移除的人員)')
  from (select distinct u as uid from unnest(p_user_ids) as u where u is not null) uids
  left join lateral (
    select coalesce(
      nullif(btrim(ma.display_name), ''),
      nullif(split_part(u.email::text, '@', 1), ''),
      '管理員'
    ) as admin_name
    from public.merchant_admins ma
    join auth.users u on u.id = ma.user_id
    where ma.merchant_id = p_merchant_id and ma.user_id = uids.uid
    limit 1
  ) admin_match on true
  left join lateral (
    select coalesce(nullif(btrim(mag.nickname), ''), mag.name) as agent_name
    from public.merchant_agents mag
    where mag.merchant_id = p_merchant_id and mag.user_id = uids.uid
    limit 1
  ) agent_match on true;
end;
$$;

comment on function public.get_booking_actor_names(uuid, uuid[]) is '對應規格書「預約詳情資訊擴充與建單備註分類」第三節 3.2/3.3:把 bookings.created_by_user_id/last_modified_by_user_id 轉成可讀姓名,呼叫者必須通過 private.can_manage_bookings(p_merchant_id)(跟預約詳情本身的 RLS 一致,不是 is_merchant_admin,被開通 orders 權限的客服也能查)。管理員優先查 merchant_admins.display_name(沒填 fallback email 前半段,再 fallback「管理員」);查不到管理員再查 merchant_agents.nickname(沒填 fallback name 欄位,name 是必填一定有值);兩邊都查不到(例如管理員已被硬刪除)顯示「(已移除的人員)」。傳入的 p_user_ids 會先去重複、過濾 null 再查詢。';

revoke execute on function public.get_booking_actor_names(uuid, uuid[]) from public, anon;
grant execute on function public.get_booking_actor_names(uuid, uuid[]) to authenticated;

-- =========================================================================
-- create_booking:drop 掉 11 個參數的舊版本(...uuid[], uuid[], text 結尾是 p_customer_address),
-- 重新建立新增 p_customer_notes 的 12 個參數版本。內部邏輯只新增 customer_notes 這一欄的寫入,
-- 其餘驗證規則完全不變(規格書第五節第 1 點)。
-- =========================================================================
drop function if exists public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text);

create function public.create_booking(
  p_merchant_id uuid,
  p_staff_id uuid,
  p_service_item_ids uuid[],
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}',
  p_material_cost_item_ids uuid[] default '{}',
  p_customer_address text default null,
  p_customer_notes text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_end_at timestamptz;
  v_created_by_role text;
  v_booking_id uuid;
  v_industry_type text;
  v_result public.bookings;
begin
  -- 1. 權限檢查(規則 2.12 第 2 點)
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限建立這間商家的預約' using errcode = '42501';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;

  -- 建單表單細節修正第二節第 4 點:依商家 industry_type 判斷客戶地址是否必填,
  -- 不能只靠前端擋。前端是體驗層引導,這裡才是真正的安全邊界。
  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 2~7. 共用驗證邏輯(規則 3.5 第 7 點):服務項目/主要人員/助手邊界衝突/料錢成本開關。
  v_end_at := private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_item_ids, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null
  );

  -- 8. 通過後在同一個交易裡寫入 bookings(狀態改為 pending_confirmation,決策記錄 5)
  --    + 三張關聯表(規格書 4.1 第 8 步)。任何一步失敗,整個函式呼叫(單一交易)rollback。
  --    預約詳情資訊擴充與建單備註分類第一節:一併寫入 customer_notes(客戶備註)。
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation'
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
  select v_booking_id, si.id, si.duration_minutes
  from public.service_items si
  where si.id = any(p_service_item_ids);

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select v_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select v_booking_id, mci.id, mci.amount
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$$;

comment on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text) is '對應建單功能擴充規格書 4.1,預約詳情資訊擴充與建單備註分類第一節第 4 點新增 p_customer_notes 參數(加在參數清單最後面,舊呼叫端不受影響):手動建單,一併寫入 customer_notes(客戶備註,跟既有 notes/內部備註分開存放)。其餘邏輯不變:依商家 industry_type 判斷客戶地址是否必填(private.industry_requires_customer_address),驗證邏輯透過 private.validate_booking_selection 共用(規則 3.5 第 7 點),建立後狀態固定是 pending_confirmation(決策記錄 5)。不會寫入 last_modified_by_user_id/last_modified_at(這兩欄只給 confirm_booking/update_booking/cancel_booking/complete_booking 這四支「異動既有訂單」的函式使用,建立當下維持 null)。';

revoke execute on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text) from public, anon;
grant execute on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text) to authenticated;

-- =========================================================================
-- update_booking:同樣先 drop 掉 11 個參數的舊版本,重新建立新增 p_customer_notes 的
-- 12 個參數版本。同時是規格書第三節 3.3 點「最後修改」追蹤機制要異動的四支函式之一:
-- 成功執行時把 last_modified_by_user_id/last_modified_at 設成 auth.uid()/now()。
-- =========================================================================
drop function if exists public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text);

create function public.update_booking(
  p_booking_id uuid,
  p_staff_id uuid,
  p_service_item_ids uuid[],
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}',
  p_material_cost_item_ids uuid[] default '{}',
  p_customer_address text default null,
  p_customer_notes text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_end_at timestamptz;
  v_industry_type text;
  v_result public.bookings;
begin
  -- 1. 依 p_booking_id 查出既有的 merchant_id/status,查無資料則報錯。
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  -- 2. 權限檢查,跟建單/確認相同(orders section_key)。
  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  -- 3. 狀態檢查(規則 3.5 第 1 點):只有 pending_confirmation/accepted 能編輯。
  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '已完成或已取消的預約不能編輯,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;

  -- 建單表單細節修正第二節第 4 點:編輯時同樣依商家 industry_type 判斷客戶地址是否必填。
  select industry_type into v_industry_type
  from public.merchants
  where id = v_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 4. 跟 create_booking 完全相同的驗證邏輯,唯一差異是傳入 p_booking_id 排除自己原本的時段
  --    (規則 3.5 第 3 點:所有時段重疊查詢都加上 and b.id <> p_booking_id)。
  v_end_at := private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_item_ids, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id
  );

  -- 5. 驗證通過後,同一個交易裡更新主體欄位(不改變 status,規則 3.5 第 5 點)+
  --    整批刪除重寫三張關聯表(規則 3.5 第 4 點,不做增量式差異比對)。
  --    預約詳情資訊擴充與建單備註分類第一節:一併更新 customer_notes;
  --    第三節 3.3 點:一併寫入 last_modified_by_user_id/last_modified_at(編輯訂單算異動)。
  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    customer_address = nullif(btrim(coalesce(p_customer_address, '')), ''),
    notes = p_notes,
    customer_notes = p_customer_notes,
    last_modified_by_user_id = auth.uid(),
    last_modified_at = now()
  where id = p_booking_id;

  delete from public.booking_service_items where booking_id = p_booking_id;
  delete from public.booking_assistants where booking_id = p_booking_id;
  delete from public.booking_material_costs where booking_id = p_booking_id;

  insert into public.booking_service_items (booking_id, service_item_id, duration_minutes_snapshot)
  select p_booking_id, si.id, si.duration_minutes
  from public.service_items si
  where si.id = any(p_service_item_ids);

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select p_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select p_booking_id, mci.id, mci.amount
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$$;

comment on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text) is '對應建單功能擴充規格書 4.9/決策記錄 6,預約詳情資訊擴充與建單備註分類第一節第 4 點新增 p_customer_notes 參數(加在參數清單最後面):編輯已建立訂單,一併更新 customer_notes,並依第三節 3.3 點寫入 last_modified_by_user_id=auth.uid()/last_modified_at=now()(編輯訂單算「異動」)。其餘邏輯不變:pending_confirmation/accepted 狀態下可用,依商家 industry_type 判斷客戶地址是否必填,驗證邏輯透過 private.validate_booking_selection 跟 create_booking 共用,不會改變 status 欄位。';

revoke execute on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text) from public, anon;
grant execute on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text, text) to authenticated;

-- =========================================================================
-- confirm_booking:簽章不變(create or replace 不會產生重載版本問題),只在成功轉換狀態的
-- UPDATE 裡一併寫入 last_modified_by_user_id/last_modified_at(規格書第三節 3.3 點:確認訂單
-- 也算異動,不是只有編輯表單才算)。其餘既有驗證規則完全不動(規格書第五節第 1 點)。
-- =========================================================================
create or replace function public.confirm_booking(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'pending_confirmation' then
    raise exception '只有「待確認」狀態的預約可以確認,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  update public.bookings
  set status = 'accepted',
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.confirm_booking(uuid) is '對應建單功能擴充規格書 4.8/決策記錄 5:把 pending_confirmation 轉成 accepted。預約詳情資訊擴充與建單備註分類第三節 3.3 點(修改):成功執行時一併寫入 last_modified_by_user_id=auth.uid()/last_modified_at=now()。權限比照建單權限(orders section_key),任何有 orders 權限的人都能操作,同一人建立後馬上自己確認也是允許的操作模式。已知限制(規格書 2.4):這次不重新驗證時段衝突。不算危險操作,不觸發任何通知。';

-- =========================================================================
-- cancel_booking:簽章不變,同樣只在 UPDATE 裡補上 last_modified_by_user_id/last_modified_at。
-- =========================================================================
create or replace function public.cancel_booking(
  p_booking_id uuid,
  p_reason text default null
)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status not in ('pending_confirmation', 'accepted') then
    raise exception '只有「待確認」或「已確認」狀態的預約可以取消,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  update public.bookings
  set status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.cancel_booking(uuid, text) is '對應建單功能擴充規格書 2.4/決策記錄 5 第 4 點:取消預約,可取消狀態是 pending_confirmation 或 accepted。預約詳情資訊擴充與建單備註分類第三節 3.3 點(修改):成功執行時一併寫入 last_modified_by_user_id=auth.uid()/last_modified_at=now()。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查,避免呼叫端偽造商家 id 繞過權限。不算危險操作,不需要 JSON 備份。';

-- =========================================================================
-- complete_booking:先前批次只更新過這支函式的 comment(body 從 20260916140100 建立以來沒有
-- 真的被 create or replace 過),這次是它第一次真正需要改動 body(補上 last_modified 欄位寫入)。
-- =========================================================================
create or replace function public.complete_booking(p_booking_id uuid)
returns public.bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
  v_result public.bookings;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.bookings
  where id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限執行此操作' using errcode = '42501';
  end if;

  if v_status <> 'accepted' then
    raise exception '只有「已接受」狀態的預約可以標記完成,目前狀態不允許這個操作';
  end if;

  update public.bookings
  set status = 'completed',
      completed_at = now(),
      last_modified_by_user_id = auth.uid(),
      last_modified_at = now()
  where id = p_booking_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.complete_booking(uuid) is '對應規格書 3.5/規則 2.9:標記完成。預約詳情資訊擴充與建單備註分類第三節 3.3 點(修改,這是這支函式建立以來第一次真的改動 body):成功執行時一併寫入 last_modified_by_user_id=auth.uid()/last_modified_at=now()。只接受 p_booking_id,merchant_id 由資料庫內部查出再做權限檢查。只有 accepted 狀態能轉成 completed。不算危險操作,不需要 JSON 備份。';
