-- 建單表單細節修正(功能層)
-- 對應規格書第二節第 4 點:create_booking/update_booking 新增 p_customer_address 參數,
-- 依商家 industry_type 判斷是否必填,不能只靠前端擋。
--
-- **重要更正**:一開始以為在既有參數清單最後面加一個有預設值的新參數,`create or replace
-- function` 就能直接沿用同一個函式物件——實測發現這個想法是錯的。Postgres 判斷函式身分
-- (是否為同一個函式、可否用 CREATE OR REPLACE 取代)是看「函式名稱 + 參數型別清單」,新增一個
-- 參數會讓型別清單變長、變成不同的身分,`create or replace` 在這種情況下不會取代舊函式,而是
-- 額外建立一個「重載(overload)」版本——正式環境會同時存在 10 個參數跟 11 個參數兩個版本的
-- create_booking,PostgREST/psql 呼叫時會因為「有多個候選函式、不知道要選哪個」直接報錯
-- (42725 function is not unique)。本機 `npm run test:db` 一開始就是因為這樣整批炸開才發現這個問題。
-- 正確做法比照建單功能擴充規格書 4.1 當初新增 create_booking 簽章時的做法:先明確 drop 掉舊的
-- 10 個參數版本,再建立新的 11 個參數版本,確保正式環境跟本機測試庫都只會有單一版本存在。

-- =========================================================================
-- private.industry_requires_customer_address:某個產業類型是否要求填寫客戶地址。
-- 規格書明講:如果技術上要在資料庫層做到跟前端一樣的「可擴充對照表」有困難(例如另建一張
-- lookup table 太小題大作),直接寫 if industry_type = 'on_site_dispatch' 也可以接受,但要在
-- 註解清楚寫明「以後新增產業類型需要地址時,要同步修改這裡跟前端的 INDUSTRY_REQUIRES_CUSTOMER_ADDRESS」
-- ——這裡採用後者(直接判斷式包一支小函式,不另建 lookup table)。
--
-- **重要,以後維護請注意**:這支函式的判斷邏輯必須跟前端
-- src/modules/merchant/types.ts 的 INDUSTRY_REQUIRES_CUSTOMER_ADDRESS 對照表保持一致。
-- 之後新增產業類型、且該產業需要必填客戶地址時,兩邊都要同步修改,不要只改其中一邊
-- (前端只是體驗層引導,這裡才是真正的安全邊界)。
-- =========================================================================
create or replace function private.industry_requires_customer_address(p_industry_type text)
returns boolean
language sql
immutable
as $$
  select p_industry_type = 'on_site_dispatch';
$$;

comment on function private.industry_requires_customer_address(text) is '對應建單表單細節修正規格書第二節第 2/4 點:判斷某個產業類型的建單/編輯表單是否要求必填客戶地址,目前只有 on_site_dispatch(到府派工)需要。**以後新增產業類型時,要同步修改這裡跟前端 src/modules/merchant/types.ts 的 INDUSTRY_REQUIRES_CUSTOMER_ADDRESS 對照表,避免漏改其中一邊。** 只給 create_booking/update_booking 內部呼叫,不對外暴露。';

revoke execute on function private.industry_requires_customer_address(text) from public, anon;
grant execute on function private.industry_requires_customer_address(text) to authenticated;

-- =========================================================================
-- create_booking:drop 掉 10 個參數的舊版本,重新建立新增 p_customer_address 的 11 個參數版本。
-- =========================================================================
drop function if exists public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]);

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
  p_customer_address text default null
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
  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes,
    source, created_by_role, created_by_user_id, status
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes,
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

comment on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text) is '對應建單功能擴充規格書 4.1,建單表單細節修正第二節第 4 點新增 p_customer_address 參數(加在參數清單最後面,舊呼叫端不受影響):手動建單,依商家 industry_type 判斷客戶地址是否必填(private.industry_requires_customer_address)。其餘邏輯不變:驗證邏輯透過 private.validate_booking_selection 共用(規則 3.5 第 7 點),建立後狀態固定是 pending_confirmation(決策記錄 5)。';

revoke execute on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text) from public, anon;
grant execute on function public.create_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text) to authenticated;

-- =========================================================================
-- update_booking:同樣先 drop 掉 10 個參數的舊版本,重新建立新增 p_customer_address 的
-- 11 個參數版本(理由同上,避免正式環境同時存在新舊兩個重載版本)。
-- =========================================================================
drop function if exists public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[]);

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
  p_customer_address text default null
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
  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    customer_address = nullif(btrim(coalesce(p_customer_address, '')), ''),
    notes = p_notes
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

comment on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text) is '對應建單功能擴充規格書 4.9/決策記錄 6,建單表單細節修正第二節第 4 點新增 p_customer_address 參數(加在參數清單最後面):編輯已建立訂單,同樣依商家 industry_type 判斷客戶地址是否必填。其餘邏輯不變:pending_confirmation/accepted 狀態下可用,驗證邏輯透過 private.validate_booking_selection 跟 create_booking 共用,不會改變 status 欄位。';

revoke execute on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text) from public, anon;
grant execute on function public.update_booking(uuid, uuid, uuid[], timestamptz, text, text, text, text, uuid[], uuid[], text) to authenticated;
