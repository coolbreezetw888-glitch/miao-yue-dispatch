-- SPECS-INDEX #852:建單/改單 RPC 要能寫入「內部備註不給服務人員看」這個旗標。
-- 規格書:.project/specs/內部備註對服務人員隱藏.md(#852 / #857 / 補-3 / 補-4)
--
-- ═══ 🔴 為什麼這支 migration 必須 drop + create,不能只 create or replace ═══════════
-- `create or replace function` 在**參數清單改變**時,不會取代舊的那一支,而是多出一個同名的
-- **overload**。PostgREST 呼叫 /rest/v1/rpc/create_booking 時就會回 `PGRST203`
-- (函式名稱有多個候選、無法決定用哪一個)—— **建單功能會整個壞掉**,而且是上線後才會發現。
-- 所以這裡先 drop 舊的 24 參數簽章,再 create 新的 25 參數版本。
--
-- ═══ drop 之前的唯讀核對(開發流程紀錄.md 第九章第 11 點)══════════════════════════
-- 2026-09-30 已用唯讀 SELECT 對正式專案 wjtbmmnakcriuaqoknsq 核對過,確認「要 drop 的那一個」
-- 就是「目前線上唯一存在的那一個」,不會誤刪別的 overload:
--
--   select p.oid::regprocedure::text, pg_get_function_identity_arguments(p.oid),
--          md5(p.prosrc), length(p.prosrc), array_to_string(p.proacl,' | ')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname='public' and p.proname in ('create_booking','update_booking');
--
--   create_booking → 只有 1 筆,簽章
--     (uuid,uuid,jsonb,timestamp with time zone,text,text,text,text,uuid[],uuid[],text,text,
--      boolean,numeric,boolean,text,numeric,boolean,text,numeric,uuid,boolean,integer,uuid)
--     prosrc md5 = 97f35dc1b988301a8981cf5735520369、長度 5017
--   update_booking → 只有 1 筆,同樣 24 個型別(第一個是 p_booking_id)
--     prosrc md5 = 7d86562ccf852248f0b872f516a93bc2、長度 6227
--   兩者的 ACL 都是 postgres=X | authenticated=X | service_role=X(沒有 PUBLIC)
--
--   ✅ 同一組 md5/長度也跟 supabase/migrations/20260927010000_normalize_phone_extension.sql 檔案裡
--      `$function$ … $function$` 的本體(CRLF 正規化成 LF 之後)**逐字相符** —— 所以下面這兩支
--      函式的本體是從那個檔案原封不動抄過來的,不是憑印象重寫,也不是從線上 prosrc 反抄
--      (線上版本的中文註解被 apply_migration 壓縮掉了,見 supabase-permission-hygiene 規則 6)。
--
-- ═══ 這次相對於 20260927010000 的差異,只有這些 ═══════════════════════════════════
--   create_booking:① 簽章最後多 p_hide_notes_from_staff boolean default false
--                   ② insert 的欄位清單多 hide_notes_from_staff
--                   ③ insert 的 values 多 coalesce(p_hide_notes_from_staff, false)
--   update_booking:① 同上的新參數
--                   ② update set 多 hide_notes_from_staff = coalesce(p_hide_notes_from_staff, false)
--   其餘每一行(含客戶電話格式驗證、料錢快照沿用、狀態檢查)逐字不變。
--
-- ═══ supabase-permission-hygiene 規則 1 ════════════════════════════════════════════
-- drop + create 換簽章之後,**舊簽章的 revoke 不會自動套到新簽章**,新函式會繼承預設的
-- PUBLIC EXECUTE。所以下面每一支都用**新的 25 個型別**重新寫一次 revoke + grant。
--
-- ⚠️ 這支 migration 本身沒有任何 UPDATE/DELETE,不動任何一筆既有訂單資料。

-- =========================================================================
-- 0. 先 drop 舊簽章(24 個參數),理由見檔頭。
--    刻意不用 `if exists` —— 如果線上不存在這個簽章,那代表我核對的前提已經不成立,
--    應該讓 migration 直接失敗停下來,而不是靜默跳過然後多 create 出一個 overload。
-- =========================================================================
drop function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
);

drop function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid
);

-- =========================================================================
-- 1a. create_booking(新簽章:25 個參數)
-- =========================================================================
create function public.create_booking(
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
  p_member_id uuid default null,
  -- SPECS-INDEX #852(2026-09-30):這一筆訂單的內部備註要不要對服務人員隱藏。
  -- ⚠️ 語意跟 p_notes / p_customer_notes / p_member_id 完全一致 —— **無條件覆寫**,不是
  --    「有帶才更新」。所以呼叫端(前端 api.ts)每次都要帶入目前的值,即使這次沒有要改它;
  --    漏帶 = 後端拿 default false = **原本藏起來的備註,編輯一次就自動公開給服務人員了**,
  --    而且不會報錯、畫面上也看不出來。這個系統已經被同一個陷阱咬過一次(p_member_id),
  --    所以 #857 額外用 pgTAP + Vitest 兩層測試把它鎖住。
  p_hide_notes_from_staff boolean default false
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
    member_id, member_name_snapshot,
    hide_notes_from_staff
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
    p_member_id, v_member_name,
    -- SPECS-INDEX #852:coalesce 是為了「呼叫端明確傳 null 進來」的邊界(欄位是 not null),
    -- 不是為了容許漏帶 —— 漏帶時 default false 已經在簽章那一層生效了。
    coalesce(p_hide_notes_from_staff, false)
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
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) is '建立預約(模組 6,逐字沿用既有邏輯)。模組 6 §9.1(SPECS-INDEX #597):成功建立後寫入一筆 booking_status_change_logs(from_status=null, to_status=pending_confirmation)。SPECS-INDEX #822(2026-09-27):客戶電話在非空檢查之後多一段格式檢查(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機),其餘邏輯(含模組 10 §3.6 的 p_member_id)完全不變。SPECS-INDEX #852(2026-09-30):最後再疊加一個 p_hide_notes_from_staff boolean default false(內部備註要不要對服務人員隱藏,寫進 bookings.hide_notes_from_staff)。⚠️ 跟 p_notes/p_member_id 同一套「無條件覆寫」語意,呼叫端每次都要帶入目前的值,漏帶會把隱藏設定清成 false(原本藏起來的備註就公開了),見 #857。這次為了加參數必須先 drop 舊簽章再 create —— create or replace 加參數會多出一個 overload,PostgREST 會回 PGRST203,建單/改單會整個壞掉。';

revoke execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) from public, anon;
grant execute on function public.create_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) to authenticated;

-- =========================================================================
-- 1b. update_booking(新簽章:25 個參數)
-- =========================================================================
create function public.update_booking(
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
  p_member_id uuid default null,
  -- SPECS-INDEX #852(2026-09-30):這一筆訂單的內部備註要不要對服務人員隱藏。
  -- ⚠️ 語意跟 p_notes / p_customer_notes / p_member_id 完全一致 —— **無條件覆寫**,不是
  --    「有帶才更新」。所以呼叫端(前端 api.ts)每次都要帶入目前的值,即使這次沒有要改它;
  --    漏帶 = 後端拿 default false = **原本藏起來的備註,編輯一次就自動公開給服務人員了**,
  --    而且不會報錯、畫面上也看不出來。這個系統已經被同一個陷阱咬過一次(p_member_id),
  --    所以 #857 額外用 pgTAP + Vitest 兩層測試把它鎖住。
  p_hide_notes_from_staff boolean default false
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
    -- SPECS-INDEX #852/#857:無條件覆寫,跟這支函式其他欄位同一套語意(見參數清單上的 ⚠️)。
    hide_notes_from_staff = coalesce(p_hide_notes_from_staff, false),
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
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) is '編輯預約(模組 6,逐字沿用既有邏輯)。模組 10 §3.6 疊加 p_member_id(加在最後,預設 null),呼叫端每次都要帶入目前的 member_id 否則會被清空。2026-09-24 修正(B2):料錢成本關聯表重寫時舊品項沿用原本的 amount_snapshot。SPECS-INDEX #822(2026-09-27):客戶電話在非空檢查之後多一段格式檢查(private.is_valid_taiwan_phone,手機或市話、市話可帶 # 分機)——舊訂單若留著不合規的舊電話,編輯時會被要求先改正,舊資料本身不主動清。其餘邏輯完全不變。SPECS-INDEX #852(2026-09-30):最後再疊加一個 p_hide_notes_from_staff boolean default false(內部備註要不要對服務人員隱藏,寫進 bookings.hide_notes_from_staff)。⚠️ 跟 p_notes/p_member_id 同一套「無條件覆寫」語意,呼叫端每次都要帶入目前的值,漏帶會把隱藏設定清成 false(原本藏起來的備註就公開了),見 #857。這次為了加參數必須先 drop 舊簽章再 create —— create or replace 加參數會多出一個 overload,PostgREST 會回 PGRST203,建單/改單會整個壞掉。';

revoke execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) from public, anon;
grant execute on function public.update_booking(
  uuid, uuid, jsonb, timestamptz, text, text, text, text, uuid[], uuid[], text, text,
  boolean, numeric, boolean, text, numeric, boolean, text, numeric, uuid, boolean, integer, uuid,
  boolean
) to authenticated;
