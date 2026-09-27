-- SPECS-INDEX #822:建單的「客戶電話」格式驗證 + 分機號碼支援。
--
-- ─── 背景 ─────────────────────────────────────────────────────────────────────
-- 客戶電話原本只檢查「有沒有填」(2026-09-24 稽核時刻意不套服務人員那套嚴格手機規則,因為客戶可能
-- 留市話),結果任何非空字串都放行,正式庫實查已有 3 碼 3 筆、40 碼 23 筆的髒資料。
-- 2026-09-27 使用者裁決的規則(原話整理):
--   ・手機:0 + 9 + 8 碼,共 10 碼
--   ・市話:0 + 第二碼 2~8 + 7~8 碼,共 9~10 碼(主腦用使用者給的 13 個區碼逐一驗算過,全部符合,
--     所以**不列舉區碼**——列舉會漏,日後區碼異動還要改程式)
--   ・市話可接「#」+ 數字當分機
--   ・分隔符號(- 空白 括號)不強制,判斷前先去掉;**但 # 要保留**(它是分機分隔符,不是排版用)
--
-- ─── 這次做的三件事 ────────────────────────────────────────────────────────────
-- 1. private.normalize_phone:在「#」處截斷,只取分機前的號碼再去非數字字元。
--    原本的作法是去掉**所有**非數字字元,所以 '02-1234-5678#123' 會變成 '0212345678123',
--    永遠配不到存成 '02-1234-5678' 的會員(get_members_by_phone 兩邊都用它正規化後比對)。
--    它是共用函式,呼叫端(全部逐一確認過,截斷對它們都只有正面或零影響):
--      - get_members_by_phone(建單頁用電話找會員)        ← 這次要修的主角
--      - get_customer_related_bookings(訂單詳情頁相關訂單)← 同樣是客戶電話比對,同受益
--      - create_booking / check_staff_booking_slot 系列(服務人員跨店衝突:比對 merchant_staff.phone)
--      - get_merchant_day_schedule 系列(服務人員跨店排程:比對 merchant_staff.phone)
--        ↑ merchant_staff.phone 有 CHECK(^09\d{8}$),不可能含 #,截斷等於沒動
--      - import_members_batch / import_historical_bookings_batch(匯入時用電話找既有會員)
--        ↑ 匯入值若帶分機,現在反而配得到,是修正不是破壞
-- 2. 新增 private.is_valid_taiwan_phone(text):上面那條規則的資料庫版本,正規表示式跟前端
--    src/lib/validation.ts 的 isValidTaiwanPhone **逐字對應**,改一邊務必同步改另一邊。
-- 3. create_booking / update_booking:在既有「請填寫客戶電話」非空檢查之後,加一段格式檢查。
--    兩支函式的其餘內容**逐字沿用**最新版本(create_booking ← 20260922160100、
--    update_booking ← 20260924020400),簽章不變,不需要 drop。
--
-- ─── 🔴 為什麼沒有資料庫 CHECK 約束(這是限制,不是漏做)──────────────────────────
-- 正式庫 bookings.customer_phone 已有髒資料(3 碼 3 筆、40 碼 23 筆),
-- `alter table ... add constraint` 會直接失敗。所以這次驗證只做「前端」+「後端函式」兩層。
-- 等 SPECS-INDEX #638 把舊資料清乾淨之後,再補 CHECK 約束。舊髒資料依使用者裁決先不動,
-- 本 migration 沒有任何 UPDATE/DELETE。
--
-- ─── 不在這次範圍 ───────────────────────────────────────────────────────────────
-- create_member / update_member(會員電話是選填,而且會員模組有自己的規格)只在前端表單加了同一條
-- 規則的體驗層檢查,後端函式沒動;CSV 匯入(import_*_batch)也沒動。

-- =========================================================================
-- 1. private.normalize_phone:在 # 處截斷
-- =========================================================================
create or replace function private.normalize_phone(p_phone text)
returns text
language sql
immutable
set search_path = public
as $$
  -- split_part(..., '#', 1):只取「#」之前的部分(沒有 # 時就是整串),再去掉所有非數字字元。
  -- NULL 進來 → split_part 回 NULL → 最後回 NULL;'#123' 進來 → '' → NULL(只有分機、沒有號碼,不比對)。
  select nullif(regexp_replace(split_part(p_phone, '#', 1), '[^0-9]', '', 'g'), '');
$$;

comment on function private.normalize_phone(text) is '正規化電話號碼(模組 6 規則 2.6):先在「#」處截斷只取分機前的號碼(SPECS-INDEX #822,2026-09-27),再去除所有非數字字元;NULL 或處理後為空字串一律回傳 NULL(代表不比對)。共用於 get_members_by_phone / get_customer_related_bookings(客戶電話)、check_staff_booking_slot / get_merchant_day_schedule 系列(服務人員電話)、import_*_batch(匯入比對)。已知限制:不處理國碼差異。';

-- ACL 維持跟原本(20260916140100)完全一樣,這次不改權限範圍。
revoke execute on function private.normalize_phone(text) from public, anon;
grant execute on function private.normalize_phone(text) to authenticated;

-- =========================================================================
-- 2. private.is_valid_taiwan_phone:客戶電話規則(手機或市話,市話可帶 # 分機)
-- =========================================================================
create or replace function private.is_valid_taiwan_phone(p_phone text)
returns boolean
language sql
immutable
set search_path = public
as $$
  -- 先去掉排版用的分隔符號(空白、括號、連字號;**不含 #**),再比對完整格式:
  --   09 + 8 碼                      → 手機,共 10 碼
  --   0 + [2-8] + 7~8 碼 (+ #1~6 碼) → 市話,共 9~10 碼,可接分機
  -- NULL 進來一律 false(是否允許留空由呼叫端決定,create_booking 前面已有非空檢查)。
  -- 跟 src/lib/validation.ts 的 TW_PHONE_SEPARATOR_REGEX / TW_PHONE_COMPACT_REGEX 逐字對應。
  select coalesce(
    regexp_replace(p_phone, '[[:space:]()-]', '', 'g') ~ '^(09[0-9]{8}|0[2-8][0-9]{7,8}(#[0-9]{1,6})?)$',
    false
  );
$$;

comment on function private.is_valid_taiwan_phone(text) is 'SPECS-INDEX #822:客戶電話格式規則(2026-09-27 使用者裁決)。去掉空白/括號/連字號後,手機 = 09 開頭共 10 碼;市話 = 0 開頭、第二碼 2~8、共 9~10 碼,可接 #1~6 碼分機。不列舉區碼。只給 create_booking / update_booking 內部呼叫;正規表示式跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應,改一邊要同步改另一邊。';

-- 內部輔助函式:三個角色全部收回(supabase-permission-hygiene 規則 1),只由 SECURITY DEFINER 的
-- create_booking / update_booking 以 owner 身份呼叫,不需要 authenticated 直接執行。
revoke execute on function private.is_valid_taiwan_phone(text) from public, anon, authenticated;
grant execute on function private.is_valid_taiwan_phone(text) to service_role;

-- =========================================================================
-- 3a. create_booking:逐字沿用 20260922160100 的版本,只在非空檢查後加一段格式檢查。簽章不變。
-- =========================================================================
create or replace function public.create_booking(
  p_merchant_id uuid,
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
  v_sel record;
  v_amount record;
  v_created_by_role text;
  v_booking_id uuid;
  v_industry_type text;
  v_result public.bookings;
  v_member_name text;
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限建立這間商家的預約' using errcode = '42501';
  end if;

  if p_customer_name is null or btrim(p_customer_name) = '' then
    raise exception '請填寫客戶姓名';
  end if;
  if p_customer_phone is null or btrim(p_customer_phone) = '' then
    raise exception '請填寫客戶電話';
  end if;
  -- SPECS-INDEX #822(2026-09-27):客戶電話格式驗證(手機或市話,市話可帶 # 分機,分隔符號不強制)。
  -- 規則本體在 private.is_valid_taiwan_phone,跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應。
  -- 這裡是「後端函式」那一層;資料庫 CHECK 約束因舊髒資料還沒清(#638)暫時補不上,見本 migration 開頭說明。
  if not private.is_valid_taiwan_phone(p_customer_phone) then
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)';
  end if;

  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if private.industry_requires_customer_address(v_industry_type)
     and (p_customer_address is null or btrim(p_customer_address) = '') then
    raise exception '請填寫客戶地址';
  end if;

  if p_member_id is not null then
    select name into v_member_name
    from public.members
    where id = p_member_id
      and merchant_id = p_merchant_id
      and status = 'active';

    if not found then
      raise exception '找不到指定的會員,或會員不屬於這間商家/已被下架';
    end if;
  end if;

  select * into v_sel from private.validate_booking_selection(
    p_merchant_id, p_staff_id, p_service_items, p_start_at,
    p_assistant_staff_ids, p_material_cost_item_ids, null,
    p_custom_duration_enabled, p_custom_duration_minutes,
    p_payment_method_id
  );

  select * into v_amount from private.calculate_booking_amount(
    v_sel.items_subtotal,
    p_custom_total_amount_enabled, p_custom_total_amount,
    p_discount_enabled, p_discount_mode, p_discount_value,
    p_tax_enabled, p_tax_mode, p_tax_value
  );

  v_created_by_role := case when private.is_merchant_admin(p_merchant_id) then 'admin' else 'agent' end;

  insert into public.bookings (
    merchant_id, staff_id, start_at, end_at,
    customer_name, customer_phone, customer_email, customer_address, notes, customer_notes,
    source, created_by_role, created_by_user_id, status,
    custom_total_amount_enabled, custom_total_amount, subtotal_amount_snapshot,
    discount_enabled, discount_mode, discount_value, discount_amount_snapshot,
    tax_enabled, tax_mode_snapshot, tax_value_snapshot, tax_amount_snapshot,
    final_amount_snapshot, payment_method_id, payment_method_name_snapshot,
    custom_duration_enabled, custom_duration_minutes,
    member_id, member_name_snapshot
  ) values (
    p_merchant_id, p_staff_id, p_start_at, v_sel.end_at,
    btrim(p_customer_name), btrim(p_customer_phone), nullif(btrim(coalesce(p_customer_email, '')), ''),
    nullif(btrim(coalesce(p_customer_address, '')), ''), p_notes, p_customer_notes,
    'manual', v_created_by_role, auth.uid(), 'pending_confirmation',
    coalesce(p_custom_total_amount_enabled, false), p_custom_total_amount, v_amount.subtotal_amount,
    coalesce(p_discount_enabled, false), p_discount_mode, p_discount_value, v_amount.discount_amount,
    coalesce(p_tax_enabled, false), p_tax_mode, p_tax_value, v_amount.tax_amount,
    v_amount.final_amount, p_payment_method_id, v_sel.payment_method_name,
    coalesce(p_custom_duration_enabled, false),
    case when coalesce(p_custom_duration_enabled, false) then p_custom_duration_minutes else null end,
    p_member_id, v_member_name
  )
  returning id into v_booking_id;

  insert into public.booking_service_items (
    booking_id, service_item_id, duration_minutes_snapshot, quantity, unit_price_snapshot
  )
  select
    v_booking_id,
    (elem ->> 'service_item_id')::uuid,
    si.duration_minutes,
    (elem ->> 'quantity')::int,
    (elem ->> 'unit_price')::numeric
  from jsonb_array_elements(p_service_items) as elem
  join public.service_items si on si.id = (elem ->> 'service_item_id')::uuid;

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

  -- 模組 6 §9.1(SPECS-INDEX #597)新增的唯一一行:建立訂單本身也算一筆操作記錄,
  -- from_status = null 代表「建立」這個動作。
  perform private.log_booking_status_change(v_booking_id, p_merchant_id, null, 'pending_confirmation');

  select * into v_result from public.bookings where id = v_booking_id;
  return v_result;
end;
$function$;

comment on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) is '建立預約(模組 6,逐字沿用既有邏輯)。模組 6 §9.1(SPECS-INDEX #597):成功建立後寫入一筆 booking_status_change_logs(from_status=null, to_status=pending_confirmation)。SPECS-INDEX #822(2026-09-27):客戶電話在非空檢查之後多一段格式檢查(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機),其餘邏輯(含模組 10 §3.6 的 p_member_id)完全不變。';

revoke execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) from public, anon;
grant execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) to authenticated;

-- =========================================================================
-- 3b. update_booking:逐字沿用 20260924020400 的版本,只在非空檢查後加一段格式檢查。簽章不變。
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
  -- SPECS-INDEX #822(2026-09-27):客戶電話格式驗證(手機或市話,市話可帶 # 分機,分隔符號不強制)。
  -- 規則本體在 private.is_valid_taiwan_phone,跟前端 src/lib/validation.ts 的 isValidTaiwanPhone 逐字對應。
  -- 這裡是「後端函式」那一層;資料庫 CHECK 約束因舊髒資料還沒清(#638)暫時補不上,見本 migration 開頭說明。
  if not private.is_valid_taiwan_phone(p_customer_phone) then
    raise exception '客戶電話格式不正確。手機請填 09 開頭共 10 碼(例如 0912345678);市話請連同區碼一起填、共 9~10 碼(例如 02-1234-5678 或 037-123456),有分機的話用 # 接在後面(例如 02-1234-5678#123)';
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
) is '編輯預約(模組 6,逐字沿用既有邏輯)。模組 10 §3.6 疊加 p_member_id(加在最後,預設 null),呼叫端每次都要帶入目前的 member_id 否則會被清空。2026-09-24 修正(B2):料錢成本關聯表重寫時舊品項沿用原本的 amount_snapshot。SPECS-INDEX #822(2026-09-27):客戶電話在非空檢查之後多一段格式檢查(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機)——舊訂單若留著不合規的舊電話,編輯時會被要求先改正,舊資料本身不主動清。其餘邏輯完全不變。';

revoke execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) from public, anon;
grant execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
) to authenticated;
