-- 深夜自主巡檢批次(2026-09-24)B2:update_booking 會把料錢成本的金額快照重新讀成「品項目前的
-- 金額」,破壞快照原則,並連帶改掉師傅的抽成基準。
--
-- =========================================================================
-- 【問題】
-- update_booking 的實作方式是「整批刪除三張關聯表再重寫」(規則 3.5 第 4 點,刻意不做增量
-- 差異比對)。服務項目重寫時用的是呼叫端傳進來的快照值:
--     (elem ->> 'unit_price')::numeric        ← 沒有去重查 service_items.price
-- 但料錢成本重寫時卻是:
--     select p_booking_id, mci.id, mci.amount  ← 直接讀「現在」的 material_cost_items.amount
-- 同一支函式裡兩種做法,料錢這邊是錯的。
--
-- booking_material_costs 的資料表註解(20260917100000_booking_expansion_schema.sql:88)白紙黑字
-- 寫著「amount_snapshot 是建立/編輯當下的金額快照,之後品項金額異動不會回頭影響已建立的預約」,
-- 目前做不到。
--
-- 【錯誤情境(實際數字)】
--   9/1  建單,料錢選了「染劑」,當時 300 元 → amount_snapshot 記 300,正確。
--   9/5  商家把「染劑」的單價調漲成 500(品項設定變更,跟舊訂單無關)。
--   9/6  客服只是進去把客戶電話的錯字改掉就按儲存(update_booking 會重寫全部關聯表)
--        → 這筆 9/1 舊單的料錢快照被改寫成 500。
--   後果 ① 商家的料錢成本報表:這筆單多算了 200 元成本。
--   後果 ② 如果商家的 commission_basis_type = 'net_of_material_cost'(抽成以「扣掉料錢後的
--        金額」為基準),抽成 40%、小計 2000:原本 (2000-300)*40% = 680,
--        變成 (2000-500)*40% = 600,師傅平白少拿 80 元,而且沒有任何人會發現。
--
-- 【修法】
-- 比照同一支函式裡服務項目的做法——既有的品項沿用原本的 amount_snapshot,只有「這次新增的」
-- 品項才去讀 material_cost_items.amount 的即時金額。
-- 做法:在 `delete from public.booking_material_costs` 之前,先把這筆預約既有的
-- (material_cost_item_id -> amount_snapshot) 收成一個 jsonb 對照表存進區域變數;重寫時用
-- coalesce(對照表裡的舊快照, 品項目前金額) 決定每一筆要寫入的值。
--
-- 【跟抽成重算的順序】
-- 查證過:update_booking 從頭到尾沒有呼叫 recalculate_booking_commission,也沒有任何
-- trigger 在 bookings/booking_material_costs 上重算抽成——抽成紀錄(booking_commission_records)
-- 是在訂單「完成」時才產生,而 update_booking 本身只允許 pending_confirmation/accepted 兩個
-- 狀態呼叫。所以這次改動不會跟抽成重算的先後順序打架;它修正的正是「之後真的要算抽成時,
-- 讀到的料錢基準是不是原始快照」這件事。
-- 另外,料錢成本不參與 private.calculate_booking_amount(訂單小計/折扣/稅金),
-- 這次改動不會影響訂單金額的任何一個快照欄位。
--
-- 【create_booking 為什麼不用改】
-- create_booking 是「第一次」寫入,當下讀即時金額就是正確的快照行為,維持原樣。
--
-- 這支 migration 完整重貼 update_booking 的最新定義(來源:
-- 20260920140200_members_booking_overlay.sql:194,之後沒有任何 migration 再改過它),
-- 唯一的差異是多了 v_existing_material_snapshots 這個區域變數與它的取值/使用,其餘一字不改。
-- =========================================================================

create or replace function public.update_booking(
  p_booking_id uuid,
  p_staff_id uuid,
  p_service_items jsonb,
  p_start_at timestamptz,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text default null,
  p_notes text default null,
  p_assistant_staff_ids uuid[] default '{}'::uuid[],
  p_material_cost_item_ids uuid[] default '{}'::uuid[],
  p_customer_address text default null,
  p_customer_notes text default null,
  p_custom_total_amount_enabled boolean default false,
  p_custom_total_amount numeric default null,
  p_discount_enabled boolean default false,
  p_discount_mode text default null,
  p_discount_value numeric default null,
  p_tax_enabled boolean default false,
  p_tax_mode text default null,
  p_tax_value numeric default null,
  p_payment_method_id uuid default null,
  p_custom_duration_enabled boolean default false,
  p_custom_duration_minutes integer default null,
  p_member_id uuid default null
)
returns bookings
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_merchant_id uuid;
  v_status text;
  v_industry_type text;
  v_sel record;
  v_amount record;
  v_result public.bookings;
  v_member_name text;
  -- 2026-09-24 修正(B2):這筆預約「既有」的料錢快照對照表,形狀是
  -- {"<material_cost_item_id>": <amount_snapshot>, ...}。在整批刪除關聯表之前先收起來,
  -- 重寫時讓舊品項沿用原本的快照值,只有這次新加的品項才去讀品項目前的金額。
  v_existing_material_snapshots jsonb;
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
    raise exception '已完成或已取消的預約不能編輯,目前狀態不允許這個操作(目前狀態:%)', v_status;
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = v_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  -- 模組 10(會員與紅利)§3.6:驗證邏輯跟 create_booking 相同。update_booking 本身既有邏輯
  -- (上面的狀態檢查)已經只允許 pending_confirmation/accepted 呼叫這支函式,訂單一旦
  -- completed,member_id 自然永久鎖定,不需要額外的狀態檢查(判斷 9)。
  if p_member_id is not null then
    select name into v_member_name
    from public.members
    where id = p_member_id
      and merchant_id = v_merchant_id
      and status = 'active';

    if not found then
      raise exception '找不到指定的會員,或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    v_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, p_booking_id,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
  );

  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  update public.bookings set
    staff_id = p_staff_id,
    start_at = p_start_at,
    end_at = v_sel.end_at,
    customer_name = btrim(p_customer_name),
    customer_phone = btrim(p_customer_phone),
    customer_email = nullif(btrim(coalesce(p_customer_email, '')), ''),
    customer_address = nullif(btrim(coalesce(p_customer_address, '')), ''),
    notes = p_notes,
    customer_notes = p_customer_notes,
    custom_total_amount_enabled = coalesce(p_custom_total_amount_enabled, false),
    custom_total_amount = p_custom_total_amount,
    subtotal_amount_snapshot = v_amount.subtotal_amount,
    discount_enabled = coalesce(p_discount_enabled, false),
    discount_mode = p_discount_mode,
    discount_value = p_discount_value,
    discount_amount_snapshot = v_amount.discount_amount,
    tax_enabled = coalesce(p_tax_enabled, false),
    tax_mode_snapshot = p_tax_mode,
    tax_value_snapshot = p_tax_value,
    tax_amount_snapshot = v_amount.tax_amount,
    final_amount_snapshot = v_amount.final_amount,
    payment_method_id = p_payment_method_id,
    payment_method_name_snapshot = v_sel.payment_method_name,
    custom_duration_enabled = coalesce(p_custom_duration_enabled, false),
    custom_duration_minutes = case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    member_id = p_member_id,
    member_name_snapshot = v_member_name,
    last_modified_by_user_id = auth.uid(),
    last_modified_at = now()
  where id = p_booking_id;

  -- 2026-09-24 修正(B2):一定要在下面那行 delete「之前」把既有的料錢快照收起來,
  -- 不然整批刪掉之後就再也查不到原始快照了。
  select coalesce(
           jsonb_object_agg(bmc.material_cost_item_id::text, bmc.amount_snapshot),
           '{}'::jsonb
         )
    into v_existing_material_snapshots
  from public.booking_material_costs bmc
  where bmc.booking_id = p_booking_id;

  delete from public.booking_service_items where booking_id = p_booking_id;
  delete from public.booking_assistants where booking_id = p_booking_id;
  delete from public.booking_material_costs where booking_id = p_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    p_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

  if p_assistant_staff_ids is not null and array_length(p_assistant_staff_ids, 1) is not null then
    insert into public.booking_assistants (booking_id, staff_id)
    select p_booking_id, x from unnest(p_assistant_staff_ids) as x;
  end if;

  if p_material_cost_item_ids is not null and array_length(p_material_cost_item_ids, 1) is not null then
    -- 2026-09-24 修正(B2):舊品項沿用原本的 amount_snapshot(維持快照原則),
    -- 只有這次新加進來的品項(對照表裡查不到)才讀 material_cost_items.amount 的即時金額。
    -- 比照同一支函式上面服務項目的做法(unit_price 用呼叫端帶入的快照值,不重查 service_items.price)。
    insert into public.booking_material_costs (booking_id, material_cost_item_id, amount_snapshot)
    select
      p_booking_id,
      mci.id,
      coalesce(
        (v_existing_material_snapshots ->> mci.id::text)::numeric,
        mci.amount
      )
    from public.material_cost_items mci
    where mci.id = any(p_material_cost_item_ids);
  end if;

  select * into v_result from public.bookings where id = p_booking_id;
  return v_result;
end;
$function$;

comment on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) is '編輯預約(模組 6,逐字沿用既有邏輯)。模組 10(會員與紅利)§3.6 疊加新參數 p_member_id(加在最後,預設 null),驗證邏輯同 create_booking。只有 pending_confirmation/accepted 狀態能呼叫這支函式(既有邏輯),訂單一旦 completed 就無法再透過這支函式變更 member_id,達成判斷 9「永久鎖定」的效果。呼叫端每次都要帶入目前的 member_id(即使不變更),否則會被清空成 null——前端表單已在編輯模式下把既有 member_id 帶入初始值,確保正常編輯流程不會意外清空會員連結。2026-09-24 修正(B2):料錢成本關聯表重寫時,舊品項改為沿用原本的 amount_snapshot,只有這次新加的品項才讀 material_cost_items.amount 的即時金額——原本無條件重讀即時金額,會讓「編輯訂單的任何一個欄位」順手把舊單的料錢成本快照改成品項現在的價格,連帶改掉 net_of_material_cost 模式下的師傅抽成基準。';

revoke execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) from public, anon;
grant execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) to authenticated;
