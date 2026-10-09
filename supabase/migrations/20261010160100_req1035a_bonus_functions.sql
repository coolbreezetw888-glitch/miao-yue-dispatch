-- SPECS-INDEX #1035 彈性計薪 A 批(月薪加獎金)— migration 2:規則、計算、對外函式、店家報表
-- 規格書:母版 .project/specs/彈性計薪.md 第三節 PA-R / PA-F / PA-B01、第四節 PX。
--
--   PA-R03  private.booking_item_revenue_basis(booking)    每個服務項目列的業績基準(跟抽成同一個分攤公式)
--   PA-R01  private.bonus_validate_rules(merchant, rules)   規則格式完整驗證(多餘欄位一律拒收),回正規化後的規則
--   PA-R04  private.bonus_compute_rules(staff, 月, rules)   照規則算某人某月(B 算法為預設;cap / retroactive)
--   PA-R05  private.compute_staff_monthly_bonus(staff, 月) 月底當時的方案 → 該月適用版本 → 金額 + 明細
--   PA-F01~F06  list / save / set / archive / preview / get_staff_bonus_by_range
--   PA-B01  public.get_merchant_billing_summary_by_range 加 total_monthly_bonus、bonus_feature_used、
--           per_staff_breakdown[].bonus_amount;estimated_net_margin 多減獎金(沒有方案的店 = 減 0,數字不變)
--
-- 🔴 全部計算在資料庫;獎金不寫快照,每次查詢即時算(已完成訂單被還原 / 取消時跟抽成一起變)。
-- 🔴 private.* 一律 revoke all(public / anon / authenticated);public.* 先 revoke 再只 grant authenticated,
--    函式內由「傳進來的 id 反查 merchant_id」再判權限(PX-02)。
-- 🔴 不用 EXECUTE / 動態 SQL。
-- 🔴 private.calculate_booking_staff_commission 不改(指紋 3ed85dc4fb8e51128829e7f521458a79 不能變);
--    PA-R03 另抽一支,pgTAP 比對兩邊對同一張單的基準一致。

-- =========================================================================
-- PA-R03 業績基準:每個服務項目列 = subtotal × 比例 − 折扣 × 比例 −(店家設定扣料錢時)料錢 × 比例,下限 0。
--   跟 private.calculate_booking_staff_commission 逐行同一套算式(含每一步 numeric(10, 2) 的四捨五入),
--   只是不查抽成設定、不算抽成金額。料錢設定看「現在」的 merchant_payroll_settings(獎金是查詢時算,
--   沒有快照可用 ⚠️ 規格 PA-R03)。
-- =========================================================================
create function private.booking_item_revenue_basis(p_booking_id uuid)
returns table (
  booking_service_item_id uuid,
  service_item_id uuid,
  quantity integer,
  basis_amount numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
  v_subtotal numeric(10, 2);
  v_discount numeric(10, 2);
  v_basis_type text;
  v_material_cost_total numeric(10, 2) := 0;
  v_raw_total numeric(10, 2) := 0;
  v_item_count int := 0;
  rec record;
  v_ratio numeric;
  v_effective_subtotal numeric(10, 2);
  v_discount_share numeric(10, 2);
  v_material_cost_share numeric(10, 2);
  v_commission_base numeric(10, 2);
begin
  select b.merchant_id, b.subtotal_amount_snapshot, b.discount_amount_snapshot
  into v_merchant_id, v_subtotal, v_discount
  from public.bookings b
  where b.id = p_booking_id;

  if not found then
    return;
  end if;

  select mps.commission_basis_type into v_basis_type
  from public.merchant_payroll_settings mps
  where mps.merchant_id = v_merchant_id;

  if not found then
    v_basis_type := 'gross';
  end if;

  if v_basis_type = 'net_of_material_cost' then
    select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0) into v_material_cost_total
    from public.booking_material_costs bmc
    where bmc.booking_id = p_booking_id;
  else
    v_material_cost_total := 0;
  end if;

  select count(*), coalesce(sum(bsi.unit_price_snapshot * bsi.quantity), 0)
  into v_item_count, v_raw_total
  from public.booking_service_items bsi
  where bsi.booking_id = p_booking_id;

  for rec in
    select bsi.id as bsi_id, bsi.service_item_id as si_id, bsi.quantity as qty,
           bsi.unit_price_snapshot
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = p_booking_id
    order by bsi.created_at, bsi.id
  loop
    if v_raw_total > 0 then
      v_ratio := (rec.unit_price_snapshot * rec.qty) / v_raw_total;
    else
      v_ratio := 1.0 / greatest(v_item_count, 1);
    end if;

    v_effective_subtotal := coalesce(v_subtotal, 0) * v_ratio;
    v_discount_share := coalesce(v_discount, 0) * v_ratio;
    v_material_cost_share := v_material_cost_total * v_ratio;
    v_commission_base := greatest(v_effective_subtotal - v_discount_share - v_material_cost_share, 0);

    booking_service_item_id := rec.bsi_id;
    service_item_id := rec.si_id;
    quantity := rec.qty;
    basis_amount := round(v_commission_base, 2);
    return next;
  end loop;
end;
$$;

revoke all on function private.booking_item_revenue_basis(uuid) from public, anon, authenticated;

-- =========================================================================
-- PA-R01 規則格式驗證(資料庫才是真正的關卡;前端驗證只是體驗)。
--   陣列 1~20 條;每條只准這些欄位:key / label / kind / metric / service_item_ids / threshold / cap /
--   amount / percent / retroactive。多餘欄位一律拒收(不是忽略)。
--   回傳正規化後的陣列(每條都補齊全部欄位,不適用的欄位寫 null),save / preview 都只用這個結果。
--   錯誤訊息:全形標點、指出第幾條哪個欄位。
-- =========================================================================
create function private.bonus_validate_rules(p_merchant_id uuid, p_rules jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_allowed_keys constant text[] := array[
    'key', 'label', 'kind', 'metric', 'service_item_ids', 'threshold', 'cap', 'amount', 'percent', 'retroactive'
  ];
  v_count int;
  v_idx int := 0;
  v_rule jsonb;
  v_prefix text;
  v_bad_key text;
  v_key text;
  v_keys text[] := array[]::text[];
  v_label text;
  v_kind text;
  v_metric text;
  v_ids jsonb;
  v_id_texts text[];
  v_id_text text;
  v_service_ids uuid[];
  v_threshold numeric;
  v_cap numeric;
  v_amount numeric;
  v_percent numeric;
  v_retroactive boolean;
  v_foreign_count int;
  v_out jsonb := '[]'::jsonb;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'array' then
    raise exception '獎金規則的格式不正確。' using errcode = '22023';
  end if;

  v_count := jsonb_array_length(p_rules);
  if v_count < 1 or v_count > 20 then
    raise exception '一個獎金方案至少要有 1 條規則，最多 20 條。' using errcode = '22023';
  end if;

  for v_rule in select e from jsonb_array_elements(p_rules) as t(e)
  loop
    v_idx := v_idx + 1;
    v_prefix := '第 ' || v_idx || ' 條規則';

    if jsonb_typeof(v_rule) <> 'object' then
      raise exception '%的格式不正確。', v_prefix using errcode = '22023';
    end if;

    select k into v_bad_key
    from jsonb_object_keys(v_rule) as t(k)
    where k <> all (c_allowed_keys)
    order by k
    limit 1;
    if v_bad_key is not null then
      raise exception '%有不認得的欄位「%」。', v_prefix, left(v_bad_key, 40) using errcode = '22023';
    end if;

    -- key:前端產生,1~40 字、只能小寫英數與減號,同一版內唯一(報表明細對應用)。
    if jsonb_typeof(v_rule -> 'key') is distinct from 'string' then
      raise exception '%缺少代號。', v_prefix using errcode = '22023';
    end if;
    v_key := v_rule ->> 'key';
    if char_length(v_key) < 1 or char_length(v_key) > 40 or v_key !~ '^[a-z0-9-]+$' then
      raise exception '%的代號格式不正確。', v_prefix using errcode = '22023';
    end if;
    if v_key = any (v_keys) then
      raise exception '%的代號跟其他規則重複。', v_prefix using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;

    -- label:1~30 字(前後空白去掉後)。
    if jsonb_typeof(v_rule -> 'label') is distinct from 'string' then
      raise exception '%的「名稱」要 1～30 個字。', v_prefix using errcode = '22023';
    end if;
    v_label := btrim(v_rule ->> 'label');
    if char_length(v_label) < 1 or char_length(v_label) > 30 then
      raise exception '%的「名稱」要 1～30 個字。', v_prefix using errcode = '22023';
    end if;

    -- kind:A 批四種(C 批才會多 formula)。
    v_kind := case when jsonb_typeof(v_rule -> 'kind') = 'string' then v_rule ->> 'kind' end;
    if v_kind is null or v_kind not in ('per_order', 'per_unit', 'percent', 'lump_sum') then
      raise exception '%的「給什麼」不正確。', v_prefix using errcode = '22023';
    end if;

    -- metric:per_order=orders、per_unit=units、percent=revenue(固定,函式強制);lump_sum 三選一(必填)。
    v_metric := case when jsonb_typeof(v_rule -> 'metric') = 'string' then v_rule ->> 'metric' end;
    if v_rule ? 'metric' and jsonb_typeof(v_rule -> 'metric') <> 'null' and v_metric is null then
      raise exception '%的「用什麼量判斷達標」不正確。', v_prefix using errcode = '22023';
    end if;
    if v_kind = 'lump_sum' then
      if v_metric is null or v_metric not in ('orders', 'units', 'revenue') then
        raise exception '%的「用什麼量判斷達標」不正確。', v_prefix using errcode = '22023';
      end if;
    else
      if v_metric is not null
         and v_metric <> (case v_kind when 'per_order' then 'orders' when 'per_unit' then 'units' else 'revenue' end) then
        raise exception '%的「用什麼量判斷達標」跟「給什麼」對不上。', v_prefix using errcode = '22023';
      end if;
      v_metric := case v_kind when 'per_order' then 'orders' when 'per_unit' then 'units' else 'revenue' end;
    end if;

    -- service_item_ids:0~50 個,必須是本店服務項目(含已下架);重複的合併。
    v_ids := v_rule -> 'service_item_ids';
    v_service_ids := array[]::uuid[];
    if v_ids is not null and jsonb_typeof(v_ids) <> 'null' then
      if jsonb_typeof(v_ids) <> 'array' then
        raise exception '%的「只算這些服務」格式不正確。', v_prefix using errcode = '22023';
      end if;
      if jsonb_array_length(v_ids) > 50 then
        raise exception '%的「只算這些服務」最多選 50 項。', v_prefix using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_array_elements(v_ids) as t(e) where jsonb_typeof(e) <> 'string') then
        raise exception '%的「只算這些服務」格式不正確。', v_prefix using errcode = '22023';
      end if;
      select coalesce(array_agg(distinct e), array[]::text[]) into v_id_texts
      from jsonb_array_elements_text(v_ids) as t(e);
      foreach v_id_text in array v_id_texts
      loop
        if v_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception '%的「只算這些服務」格式不正確。', v_prefix using errcode = '22023';
        end if;
        v_service_ids := v_service_ids || v_id_text::uuid;
      end loop;
      select count(*) into v_foreign_count
      from unnest(v_service_ids) as u(id)
      where not exists (
        select 1 from public.service_items si where si.id = u.id and si.merchant_id = p_merchant_id
      );
      if v_foreign_count > 0 then
        raise exception '%的「只算這些服務」裡有不屬於這間店的服務項目。', v_prefix using errcode = '22023';
      end if;
      select coalesce(array_agg(id order by id), array[]::uuid[]) into v_service_ids
      from unnest(v_service_ids) as u(id);
    end if;

    -- threshold:0 ~ 1 億,最多 2 位小數(必填)。
    if jsonb_typeof(v_rule -> 'threshold') is distinct from 'number' then
      raise exception '%的「超過多少後才開始算」要填 0～100,000,000 之間的數字。', v_prefix using errcode = '22023';
    end if;
    v_threshold := (v_rule ->> 'threshold')::numeric;
    if v_threshold < 0 or v_threshold > 100000000 or scale(v_threshold) > 2 then
      raise exception '%的「超過多少後才開始算」要填 0～100,000,000 之間的數字，最多 2 位小數。', v_prefix using errcode = '22023';
    end if;

    -- cap(⚠️範圍 2):null 或 > threshold,同樣不超過 1 億。
    v_cap := null;
    if v_rule ? 'cap' and jsonb_typeof(v_rule -> 'cap') <> 'null' then
      if jsonb_typeof(v_rule -> 'cap') <> 'number' then
        raise exception '%的「算到多少為止」要填數字。', v_prefix using errcode = '22023';
      end if;
      v_cap := (v_rule ->> 'cap')::numeric;
      if v_cap <= v_threshold then
        raise exception '%的「算到多少為止」要大於「超過多少後才開始算」。', v_prefix using errcode = '22023';
      end if;
      if v_cap > 100000000 or scale(v_cap) > 2 then
        raise exception '%的「算到多少為止」要填 100,000,000 以內的數字，最多 2 位小數。', v_prefix using errcode = '22023';
      end if;
    end if;

    -- amount / percent:依種類二選一,另一個必須不填(或 null)。
    v_amount := null;
    v_percent := null;
    if v_kind = 'percent' then
      if v_rule ? 'amount' and jsonb_typeof(v_rule -> 'amount') <> 'null' then
        raise exception '%是「業績百分比」，不用填「金額」。', v_prefix using errcode = '22023';
      end if;
      if jsonb_typeof(v_rule -> 'percent') is distinct from 'number' then
        raise exception '%的「百分比」要填 0～100 之間的數字。', v_prefix using errcode = '22023';
      end if;
      v_percent := (v_rule ->> 'percent')::numeric;
      if v_percent < 0 or v_percent > 100 or scale(v_percent) > 2 then
        raise exception '%的「百分比」要填 0～100 之間的數字，最多 2 位小數。', v_prefix using errcode = '22023';
      end if;
    else
      if v_rule ? 'percent' and jsonb_typeof(v_rule -> 'percent') <> 'null' then
        raise exception '%不是「業績百分比」，不用填「百分比」。', v_prefix using errcode = '22023';
      end if;
      if jsonb_typeof(v_rule -> 'amount') is distinct from 'number' then
        raise exception '%的「金額」要填 0～1,000,000 元之間的數字。', v_prefix using errcode = '22023';
      end if;
      v_amount := (v_rule ->> 'amount')::numeric;
      if v_amount < 0 or v_amount > 1000000 or scale(v_amount) > 2 then
        raise exception '%的「金額」要填 0～1,000,000 元之間的數字，最多 2 位小數。', v_prefix using errcode = '22023';
      end if;
    end if;

    -- retroactive(⚠️範圍 3):boolean,預設 false;「達標給一筆」不適用。
    v_retroactive := false;
    if v_rule ? 'retroactive' and jsonb_typeof(v_rule -> 'retroactive') <> 'null' then
      if jsonb_typeof(v_rule -> 'retroactive') <> 'boolean' then
        raise exception '%的「達標後整月都算」格式不正確。', v_prefix using errcode = '22023';
      end if;
      v_retroactive := (v_rule ->> 'retroactive')::boolean;
    end if;
    if v_kind = 'lump_sum' and v_retroactive then
      raise exception '%是「達標給一筆」，不能勾選「達標後整月都算」。', v_prefix using errcode = '22023';
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', v_key,
      'label', v_label,
      'kind', v_kind,
      'metric', v_metric,
      'service_item_ids', to_jsonb(v_service_ids),
      'threshold', v_threshold,
      'cap', v_cap,
      'amount', v_amount,
      'percent', v_percent,
      'retroactive', v_retroactive
    ));
  end loop;

  return v_out;
end;
$$;

revoke all on function private.bonus_validate_rules(uuid, jsonb) from public, anon, authenticated;

-- =========================================================================
-- PA-R02 / PA-R04 照規則算某人某月(不檢查權限、不看方案;規則必須是 bonus_validate_rules 的輸出)。
--   該月完成單 = bookings.staff_id = 這位(只算主要服務人員,Q3=A)、status='completed'、
--   coalesce(completed_at, start_at) 落在該月(台北)—— 跟店家報表、抽成同一個月份基準。
--   每條規則:量 Q(orders 整數 / units 整數 / revenue 元)、T = threshold、C = cap(null = 無限)
--     per_order / per_unit:第 T+1 個到第 C 個每個 × amount;retroactive:Q > T ⇒ 第 1 個到第 min(Q, C) 個全算。
--     percent:業績累計落在 (T, C] 的那一段 × percent%;retroactive:Q > T ⇒ 0 到 min(Q, C) 全算。
--     lump_sum:Q ≥ T 給一次(T = 0 ⇒ Q > 0 才給);有 cap ⇒ 還要 Q ≤ C ⚠️。
--   每條四捨五入到元;合計 > 1,000,000 ⇒ 封頂並加旗標 capped(⚠️範圍 5)。
--   📌 因為每個單位給的錢一樣(或業績是線性的),「第幾台」只影響明細的區間說明,不影響金額;
--      所以這裡用量直接算,不必逐單排序展開(排序規則 PA-R02 仍然成立,只是算出來的結果相同)。
-- =========================================================================
create function private.bonus_compute_rules(p_staff_id uuid, p_month date, p_rules jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_start timestamptz;
  v_end timestamptz;
  v_booking_ids uuid[];
  v_items jsonb;
  v_rule jsonb;
  v_ids uuid[];
  v_kind text;
  v_metric text;
  v_threshold numeric;
  v_cap numeric;
  v_amount numeric;
  v_percent numeric;
  v_retro boolean;
  v_q numeric;
  v_hi numeric;
  v_counted numeric;
  v_range_start numeric;
  v_range_end numeric;
  v_achieved boolean;
  v_rule_amount numeric;
  v_total numeric := 0;
  v_results jsonb := '[]'::jsonb;
  v_flags jsonb := '[]'::jsonb;
begin
  v_start := v_month::timestamp at time zone 'Asia/Taipei';
  v_end := (v_month + interval '1 month')::timestamp at time zone 'Asia/Taipei';

  select coalesce(array_agg(b.id order by coalesce(b.completed_at, b.start_at), b.id), array[]::uuid[])
  into v_booking_ids
  from public.bookings b
  where b.staff_id = p_staff_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_start
    and coalesce(b.completed_at, b.start_at) < v_end;

  select coalesce(jsonb_agg(jsonb_build_object(
           'b', u.booking_id, 's', r.service_item_id, 'q', r.quantity, 'r', r.basis_amount)), '[]'::jsonb)
  into v_items
  from unnest(v_booking_ids) as u(booking_id)
  cross join lateral private.booking_item_revenue_basis(u.booking_id) as r;

  for v_rule in select e from jsonb_array_elements(coalesce(p_rules, '[]'::jsonb)) as t(e)
  loop
    v_kind := v_rule ->> 'kind';
    v_metric := v_rule ->> 'metric';
    v_threshold := coalesce((v_rule ->> 'threshold')::numeric, 0);
    v_cap := (v_rule ->> 'cap')::numeric;
    v_amount := coalesce((v_rule ->> 'amount')::numeric, 0);
    v_percent := coalesce((v_rule ->> 'percent')::numeric, 0);
    v_retro := coalesce((v_rule ->> 'retroactive')::boolean, false);
    select coalesce(array_agg(e::uuid), array[]::uuid[]) into v_ids
    from jsonb_array_elements_text(coalesce(v_rule -> 'service_item_ids', '[]'::jsonb)) as t(e);

    -- 量 Q
    if v_metric = 'orders' then
      if cardinality(v_ids) = 0 then
        v_q := cardinality(v_booking_ids);
      else
        select count(distinct x.b) into v_q
        from jsonb_to_recordset(v_items) as x(b uuid, s uuid, q int, r numeric)
        where x.s = any (v_ids);
      end if;
    elsif v_metric = 'units' then
      select coalesce(sum(x.q), 0) into v_q
      from jsonb_to_recordset(v_items) as x(b uuid, s uuid, q int, r numeric)
      where cardinality(v_ids) = 0 or x.s = any (v_ids);
    else
      select coalesce(sum(x.r), 0) into v_q
      from jsonb_to_recordset(v_items) as x(b uuid, s uuid, q int, r numeric)
      where cardinality(v_ids) = 0 or x.s = any (v_ids);
    end if;

    v_counted := 0;
    v_range_start := null;
    v_range_end := null;
    v_achieved := null;
    v_rule_amount := 0;

    if v_kind in ('per_order', 'per_unit') then
      -- 單 / 份是整數:第 k 個算不算 ⇔ k 落在 (T, C];T、C 可能有小數 ⇒ 用 floor 換成整數界線。
      v_hi := case when v_cap is null then v_q else least(v_q, floor(v_cap)) end;
      if v_retro then
        if v_q > v_threshold then
          v_counted := greatest(v_hi, 0);
          v_range_start := 1;
        end if;
      else
        v_counted := greatest(v_hi - floor(v_threshold), 0);
        v_range_start := floor(v_threshold) + 1;
      end if;
      if v_counted > 0 then
        v_range_end := v_range_start + v_counted - 1;
      else
        v_range_start := null;
      end if;
      v_rule_amount := v_counted * v_amount;
    elsif v_kind = 'percent' then
      v_hi := case when v_cap is null then v_q else least(v_q, v_cap) end;
      if v_retro then
        if v_q > v_threshold then
          v_counted := greatest(v_hi, 0);
        end if;
      else
        v_counted := greatest(v_hi - v_threshold, 0);
      end if;
      v_rule_amount := v_counted * v_percent / 100;
    elsif v_kind = 'lump_sum' then
      v_achieved := case when v_threshold = 0 then v_q > 0 else v_q >= v_threshold end;
      if v_cap is not null and v_q > v_cap then
        v_achieved := false;
      end if;
      v_counted := case when v_achieved then 1 else 0 end;
      v_rule_amount := case when v_achieved then v_amount else 0 end;
    end if;

    v_rule_amount := round(v_rule_amount, 0);
    v_total := v_total + v_rule_amount;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'key', v_rule ->> 'key',
      'label', v_rule ->> 'label',
      'kind', v_kind,
      'metric', v_metric,
      'quantity', v_q,
      'counted_quantity', v_counted,
      'range_start', v_range_start,
      'range_end', v_range_end,
      'achieved', v_achieved,
      'amount', v_rule_amount
    ));
  end loop;

  if v_total > 1000000 then
    v_total := 1000000;
    v_flags := v_flags || '["capped"]'::jsonb;
  end if;

  return jsonb_build_object(
    'month', v_month,
    'amount', v_total,
    'rules', v_results,
    'flags', v_flags
  );
end;
$$;

revoke all on function private.bonus_compute_rules(uuid, date, jsonb) from public, anon, authenticated;

-- =========================================================================
-- PA-R05 某人某月的獎金。
--   1. 月底(台北)當時的狀態:existed、在職、月薪制、有方案 —— 任一不成立 ⇒ 0。
--   2. 該月適用版本 = effective_month ≤ 該月 1 號的最新一版;沒有 ⇒ 0(方案建立前的月份)。
--   3. 照規則算(bonus_compute_rules)。
--   回 {month, has_plan, plan_id, plan_name, plan_status, version_effective_month, amount, rules[], flags[]}。
--   不檢查權限(只給其他函式呼叫;revoke all)。
-- =========================================================================
create function private.compute_staff_monthly_bonus(p_staff_id uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_month date := date_trunc('month', p_month)::date;
  v_as_of timestamptz;
  v_status record;
  v_staff_merchant_id uuid;
  v_plan record;
  v_version record;
  v_result jsonb;
begin
  v_as_of := ((v_month + interval '1 month')::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond';

  select * into v_status from private.get_staff_payroll_status_as_of(p_staff_id, v_as_of);

  if not found
     or not coalesce(v_status.existed, false)
     or v_status.status is distinct from 'active'
     or v_status.compensation_type is distinct from 'monthly_salary'
     or v_status.bonus_plan_id is null then
    return jsonb_build_object(
      'month', v_month, 'has_plan', false, 'plan_id', null, 'plan_name', null, 'plan_status', null,
      'version_effective_month', null, 'amount', 0, 'rules', '[]'::jsonb, 'flags', '[]'::jsonb
    );
  end if;

  select ms.merchant_id into v_staff_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;

  select bp.id, bp.name, bp.status into v_plan
  from public.staff_bonus_plans bp
  where bp.id = v_status.bonus_plan_id
    and bp.merchant_id = v_staff_merchant_id;

  if not found then
    return jsonb_build_object(
      'month', v_month, 'has_plan', false, 'plan_id', null, 'plan_name', null, 'plan_status', null,
      'version_effective_month', null, 'amount', 0, 'rules', '[]'::jsonb, 'flags', '[]'::jsonb
    );
  end if;

  select v.effective_month, v.rules into v_version
  from public.staff_bonus_plan_versions v
  where v.plan_id = v_plan.id
    and v.effective_month <= v_month
  order by v.effective_month desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'month', v_month, 'has_plan', true, 'plan_id', v_plan.id, 'plan_name', v_plan.name,
      'plan_status', v_plan.status, 'version_effective_month', null, 'amount', 0,
      'rules', '[]'::jsonb, 'flags', '[]'::jsonb
    );
  end if;

  v_result := private.bonus_compute_rules(p_staff_id, v_month, v_version.rules);

  return v_result || jsonb_build_object(
    'has_plan', true,
    'plan_id', v_plan.id,
    'plan_name', v_plan.name,
    'plan_status', v_plan.status,
    'version_effective_month', v_version.effective_month
  );
end;
$$;

revoke all on function private.compute_staff_monthly_bonus(uuid, date) from public, anon, authenticated;

-- 台北時間的「本月 1 號」(save / list / preview 共用,避免各寫一次時區)。
create function private.bonus_this_month()
returns date
language sql
stable
set search_path = ''
as $$
  select date_trunc('month', now() at time zone 'Asia/Taipei')::date;
$$;

revoke all on function private.bonus_this_month() from public, anon, authenticated;

-- =========================================================================
-- PA-F01 list_staff_bonus_plans(p_merchant_id)
--   回 {this_month, plans[], assignments[], service_items[]}
--   plans[]:id、name、status、created_at、staff_count / staff_names(目前在職的月薪人員中指派這個方案的人)、
--           current_version(effective_month ≤ 本月的最新版)、next_version(effective_month > 本月,有的話)
--   assignments[]:這間店每位服務人員目前的指派(給月薪人員下拉用)
--   service_items[]:這間店全部服務項目(含已下架,規則編輯器的「只算這些服務」用;
--                   不靠 service_items 表層 RLS,只有「抽成與薪資設定」權限的客服也拿得到)
-- =========================================================================
create function public.list_staff_bonus_plans(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_this_month date := private.bonus_this_month();
  v_plans jsonb;
  v_assignments jsonb;
  v_items jsonb;
begin
  if p_merchant_id is null or not private.can_manage_commission_settings(p_merchant_id) then
    raise exception '沒有權限查看這間商家的獎金方案。' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', bp.id,
           'name', bp.name,
           'status', bp.status,
           'created_at', bp.created_at,
           'staff_count', coalesce(u.staff_count, 0),
           'staff_names', coalesce(u.staff_names, '[]'::jsonb),
           'current_version', cv.v,
           'next_version', nv.v
         ) order by bp.status, bp.created_at, bp.id), '[]'::jsonb)
  into v_plans
  from public.staff_bonus_plans bp
  left join lateral (
    select count(*)::int as staff_count,
           jsonb_agg(ms.name order by ms.display_order, ms.created_at, ms.id) as staff_names
    from public.staff_bonus_assignments a
    join public.merchant_staff ms on ms.id = a.staff_id
    where a.plan_id = bp.id
      and ms.status = 'active'
      and ms.compensation_type = 'monthly_salary'
  ) u on true
  left join lateral (
    select jsonb_build_object('effective_month', v.effective_month, 'rules', v.rules) as v
    from public.staff_bonus_plan_versions v
    where v.plan_id = bp.id and v.effective_month <= v_this_month
    order by v.effective_month desc
    limit 1
  ) cv on true
  left join lateral (
    select jsonb_build_object('effective_month', v.effective_month, 'rules', v.rules) as v
    from public.staff_bonus_plan_versions v
    where v.plan_id = bp.id and v.effective_month > v_this_month
    order by v.effective_month asc
    limit 1
  ) nv on true
  where bp.merchant_id = p_merchant_id;

  select coalesce(jsonb_agg(jsonb_build_object('staff_id', a.staff_id, 'plan_id', a.plan_id)
           order by a.staff_id), '[]'::jsonb)
  into v_assignments
  from public.staff_bonus_assignments a
  join public.merchant_staff ms on ms.id = a.staff_id
  where ms.merchant_id = p_merchant_id
    and a.plan_id is not null;

  select coalesce(jsonb_agg(jsonb_build_object('id', si.id, 'name', si.name, 'status', si.status)
           order by (si.status = 'active') desc, si.name, si.id), '[]'::jsonb)
  into v_items
  from public.service_items si
  where si.merchant_id = p_merchant_id;

  return jsonb_build_object(
    'this_month', v_this_month,
    'plans', v_plans,
    'assignments', v_assignments,
    'service_items', v_items
  );
end;
$$;

revoke all on function public.list_staff_bonus_plans(uuid) from public, anon, authenticated;
grant execute on function public.list_staff_bonus_plans(uuid) to authenticated;

-- =========================================================================
-- PA-F02 save_staff_bonus_plan(p_merchant_id, p_plan_id null = 新增, p_name, p_rules, p_effective)
--   p_effective:'this_month'(預設)/ 'next_month'。不能選過去月份(Q7:過去月份照當時的版本算)。
--   該月份已有版本 ⇒ 覆蓋那一版;沒有 ⇒ 新增一版。「本月」存檔時下個月那版不動。
--   回方案 id。
-- =========================================================================
create function public.save_staff_bonus_plan(
  p_merchant_id uuid,
  p_plan_id uuid,
  p_name text,
  p_rules jsonb,
  p_effective text default 'this_month'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_rules jsonb;
  v_effective_month date;
  v_plan_id uuid;
  v_plan record;
  v_active_count int;
begin
  if p_merchant_id is null or not private.can_manage_commission_settings(p_merchant_id) then
    raise exception '沒有權限修改這間商家的獎金方案。' using errcode = '42501';
  end if;

  if char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception '方案名稱要 1～30 個字。' using errcode = '22023';
  end if;

  if p_effective is null or p_effective not in ('this_month', 'next_month') then
    raise exception '生效月份只能選「從本月起」或「從下個月起」。' using errcode = '22023';
  end if;

  v_effective_month := private.bonus_this_month();
  if p_effective = 'next_month' then
    v_effective_month := (v_effective_month + interval '1 month')::date;
  end if;

  v_rules := private.bonus_validate_rules(p_merchant_id, p_rules);

  if p_plan_id is null then
    select count(*) into v_active_count
    from public.staff_bonus_plans bp
    where bp.merchant_id = p_merchant_id and bp.status = 'active';
    if v_active_count >= 50 then
      raise exception '使用中的獎金方案最多 50 個，請先封存用不到的方案。' using errcode = '22023';
    end if;
  else
    -- 由方案 id 反查商家(PX-02):別家的方案一律當成找不到。
    select bp.id, bp.merchant_id, bp.status into v_plan
    from public.staff_bonus_plans bp
    where bp.id = p_plan_id
    for update;
    if not found or v_plan.merchant_id is distinct from p_merchant_id then
      raise exception '找不到這個獎金方案。' using errcode = 'P0002';
    end if;
    if v_plan.status <> 'active' then
      raise exception '這個方案已經封存，不能再修改。' using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1 from public.staff_bonus_plans bp
    where bp.merchant_id = p_merchant_id
      and bp.status = 'active'
      and lower(btrim(bp.name)) = lower(v_name)
      and bp.id is distinct from p_plan_id
  ) then
    raise exception '已經有同名的獎金方案「%」，請換一個名稱。', v_name using errcode = '23505';
  end if;

  if p_plan_id is null then
    insert into public.staff_bonus_plans (merchant_id, name, created_by_user_id)
    values (p_merchant_id, v_name, auth.uid())
    returning id into v_plan_id;
  else
    v_plan_id := p_plan_id;
    update public.staff_bonus_plans
    set name = v_name, updated_at = now()
    where id = v_plan_id;
  end if;

  insert into public.staff_bonus_plan_versions (plan_id, merchant_id, effective_month, rules, created_by_user_id)
  values (v_plan_id, p_merchant_id, v_effective_month, v_rules, auth.uid())
  on conflict (plan_id, effective_month)
  do update set rules = excluded.rules, updated_at = now();

  return v_plan_id;
end;
$$;

revoke all on function public.save_staff_bonus_plan(uuid, uuid, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_staff_bonus_plan(uuid, uuid, text, jsonb, text) to authenticated;

-- =========================================================================
-- PA-F03 set_staff_bonus_plan(p_staff_id, p_plan_id null = 不給獎金)
--   由服務人員反查商家;指派方案時:服務人員在職、月薪制、方案使用中且同店。取消指派(null)不看計酬方式。
-- =========================================================================
create function public.set_staff_bonus_plan(p_staff_id uuid, p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_staff record;
  v_plan record;
begin
  select ms.id, ms.merchant_id, ms.status, ms.compensation_type into v_staff
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  if not found or not private.can_manage_commission_settings(v_staff.merchant_id) then
    raise exception '找不到這位服務人員，或沒有權限修改他的獎金方案。' using errcode = '42501';
  end if;

  if p_plan_id is not null then
    if v_staff.status <> 'active' then
      raise exception '這位服務人員已經移除，不能指派獎金方案。' using errcode = '22023';
    end if;
    if v_staff.compensation_type <> 'monthly_salary' then
      raise exception '只有月薪制的服務人員可以套用獎金方案。' using errcode = '22023';
    end if;
    select bp.id, bp.merchant_id, bp.status into v_plan
    from public.staff_bonus_plans bp
    where bp.id = p_plan_id;
    if not found or v_plan.merchant_id is distinct from v_staff.merchant_id then
      raise exception '找不到這個獎金方案。' using errcode = 'P0002';
    end if;
    if v_plan.status <> 'active' then
      raise exception '這個方案已經封存，不能再指派。' using errcode = '22023';
    end if;
  end if;

  insert into public.staff_bonus_assignments (staff_id, merchant_id, plan_id, updated_by_user_id)
  values (p_staff_id, v_staff.merchant_id, p_plan_id, auth.uid())
  on conflict (staff_id)
  do update set plan_id = excluded.plan_id,
                updated_by_user_id = excluded.updated_by_user_id,
                updated_at = now()
  where public.staff_bonus_assignments.plan_id is distinct from excluded.plan_id;
end;
$$;

revoke all on function public.set_staff_bonus_plan(uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_staff_bonus_plan(uuid, uuid) to authenticated;

-- =========================================================================
-- PA-F04 archive_staff_bonus_plan(p_plan_id)
--   還有在職月薪人員在用 ⇒ 擋下並說是誰。
--   ⚠️ 規劃者補充:封存時把「已移除 / 已不是月薪制」的人身上殘留的指派清掉(plan_id → null),
--      避免他們日後被恢復 / 改回月薪制時默默套上一個已封存的方案;歷史月份不受影響(歷史表照常開新列)。
-- =========================================================================
create function public.archive_staff_bonus_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan record;
  v_in_use_count int;
  v_in_use_names text;
begin
  select bp.id, bp.merchant_id, bp.status into v_plan
  from public.staff_bonus_plans bp
  where bp.id = p_plan_id
  for update;

  if not found or not private.can_manage_commission_settings(v_plan.merchant_id) then
    raise exception '找不到這個獎金方案，或沒有權限修改。' using errcode = '42501';
  end if;

  if v_plan.status = 'archived' then
    return;
  end if;

  select count(*)::int, string_agg(ms.name, '、' order by ms.display_order, ms.created_at, ms.id)
  into v_in_use_count, v_in_use_names
  from public.staff_bonus_assignments a
  join public.merchant_staff ms on ms.id = a.staff_id
  where a.plan_id = p_plan_id
    and ms.status = 'active'
    and ms.compensation_type = 'monthly_salary';

  if v_in_use_count > 0 then
    raise exception '還有 % 位月薪人員使用這個方案（%），請先改掉。', v_in_use_count, v_in_use_names
      using errcode = '23503';
  end if;

  update public.staff_bonus_assignments
  set plan_id = null, updated_by_user_id = auth.uid(), updated_at = now()
  where plan_id = p_plan_id;

  update public.staff_bonus_plans
  set status = 'archived', updated_at = now()
  where id = p_plan_id;
end;
$$;

revoke all on function public.archive_staff_bonus_plan(uuid) from public, anon, authenticated;
grant execute on function public.archive_staff_bonus_plan(uuid) to authenticated;

-- =========================================================================
-- PA-F05 preview_staff_bonus(p_merchant_id, p_rules, p_staff_id, p_month)(⚠️範圍 1)
--   用「還沒存檔的規則」對某人某月試算;回 PA-R05 同格式。月份限最近 24 個月(含本月)。
-- =========================================================================
create function public.preview_staff_bonus(
  p_merchant_id uuid,
  p_rules jsonb,
  p_staff_id uuid,
  p_month date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_this_month date := private.bonus_this_month();
  v_month date;
  v_staff_merchant_id uuid;
  v_rules jsonb;
begin
  if p_merchant_id is null or not private.can_manage_commission_settings(p_merchant_id) then
    raise exception '沒有權限試算這間商家的獎金。' using errcode = '42501';
  end if;

  select ms.merchant_id into v_staff_merchant_id
  from public.merchant_staff ms
  where ms.id = p_staff_id;
  if not found or v_staff_merchant_id is distinct from p_merchant_id then
    raise exception '找不到這位服務人員。' using errcode = 'P0002';
  end if;

  if p_month is null then
    raise exception '請選擇要試算的月份。' using errcode = '22023';
  end if;
  v_month := date_trunc('month', p_month)::date;
  if v_month > v_this_month or v_month < (v_this_month - interval '23 months')::date then
    raise exception '試算月份只能選最近 24 個月（含本月）。' using errcode = '22023';
  end if;

  v_rules := private.bonus_validate_rules(p_merchant_id, p_rules);

  return private.bonus_compute_rules(p_staff_id, v_month, v_rules) || jsonb_build_object(
    'has_plan', true,
    'plan_id', null,
    'plan_name', null,
    'plan_status', null,
    'version_effective_month', null
  );
end;
$$;

revoke all on function public.preview_staff_bonus(uuid, jsonb, uuid, date) from public, anon, authenticated;
grant execute on function public.preview_staff_bonus(uuid, jsonb, uuid, date) to authenticated;

-- =========================================================================
-- PA-F06 get_staff_bonus_by_range(p_staff_id, p_start, p_end)
--   權限:can_view_payroll_reports(該店)或 can_view_staff_own_payroll(本人)。
--   只算區間內「完整月份」(1 號到月底都在區間內),其他月份列進 partial_months 讓畫面說明;上限一年。
--   回 {months:[...], total_amount, partial_months:[date], has_any_plan}
--   has_any_plan:任一月份(含不完整月份)月底當時有套用方案 —— 畫面用它決定要不要顯示獎金區塊。
--   服務人員本人看(沒有服務人員報表權限)時只回規則名稱、種類、算出的量與金額:
--     拿掉 plan_id、plan_name、plan_status、version_effective_month(⚠️ PA-F06 末段)。
-- =========================================================================
create function public.get_staff_bonus_by_range(p_staff_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_merchant_id uuid;
  v_full_view boolean;
  v_months jsonb := '[]'::jsonb;
  v_partial jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_has_any_plan boolean := false;
  v_month date;
  v_result jsonb;
  v_partial_has_plan boolean;
begin
  select ms.merchant_id into v_merchant_id from public.merchant_staff ms where ms.id = p_staff_id;
  if not found then
    raise exception '找不到這位服務人員。' using errcode = 'P0002';
  end if;

  v_full_view := private.can_view_payroll_reports(v_merchant_id);
  if not (v_full_view or private.can_view_staff_own_payroll(p_staff_id)) then
    raise exception '沒有權限查詢這間商家的服務人員報表。' using errcode = '42501';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception '請選擇查詢區間。' using errcode = '22023';
  end if;
  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期。';
  end if;
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年。';
  end if;

  for v_month in
    select gs::date
    from generate_series(date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month') as gs
  loop
    if v_month >= p_start_date and (v_month + interval '1 month - 1 day')::date <= p_end_date then
      v_result := private.compute_staff_monthly_bonus(p_staff_id, v_month);
      v_total := v_total + coalesce((v_result ->> 'amount')::numeric, 0);
      v_has_any_plan := v_has_any_plan or coalesce((v_result ->> 'has_plan')::boolean, false);
      if not v_full_view then
        v_result := v_result - 'plan_id' - 'plan_name' - 'plan_status' - 'version_effective_month';
      end if;
      v_months := v_months || jsonb_build_array(v_result);
    else
      v_partial := v_partial || to_jsonb(v_month);
      -- 不完整月份不算錢,但那個月月底當時有方案的話,畫面仍要顯示獎金區塊(說明「不是完整月份,不計算獎金」)。
      select coalesce(s.existed and s.status = 'active' and s.compensation_type = 'monthly_salary'
                      and s.bonus_plan_id is not null, false)
      into v_partial_has_plan
      from private.get_staff_payroll_status_as_of(
        p_staff_id,
        ((v_month + interval '1 month')::timestamp at time zone 'Asia/Taipei') - interval '1 microsecond'
      ) s;
      v_has_any_plan := v_has_any_plan or coalesce(v_partial_has_plan, false);
    end if;
  end loop;

  return jsonb_build_object(
    'months', v_months,
    'total_amount', v_total,
    'partial_months', v_partial,
    'has_any_plan', v_has_any_plan
  );
end;
$$;

revoke all on function public.get_staff_bonus_by_range(uuid, date, date) from public, anon, authenticated;
grant execute on function public.get_staff_bonus_by_range(uuid, date, date) to authenticated;

-- =========================================================================
-- PA-B01 店家報表加鍵(既有鍵一個都不改,只有 estimated_net_margin 多減獎金)
--   改前本體 = 20261009100100_c3_functions.sql 的版本(本機指紋 142eedf1f452668053696a881595ecff),
--   逐字保留,只動標了「#1035 A 批」的地方:
--     ① declare 多三個變數
--     ② 月薪段之後算 total_monthly_bonus(salary_applicable 時 = 區間每個月份、每位「月底當時月薪制且在職
--        且有方案」的人 compute_staff_monthly_bonus 合計;否則 null)+ bonus_feature_used(該店有任何方案,含封存)
--     ③ per_staff_breakdown 三個分支各多一個 bonus_amount(月薪且 salary_applicable ⇒ 數字;其他 null)
--     ④ estimated_net_margin(salary_applicable 時)多減 total_monthly_bonus;沒有方案的店 = 減 0,數字不變
--     ⑤ 回傳多兩個鍵 total_monthly_bonus、bonus_feature_used
-- =========================================================================
CREATE OR REPLACE FUNCTION public.get_merchant_billing_summary_by_range(p_merchant_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_salary_applicable boolean;
  v_total_revenue_excl_tax numeric(10, 2);
  v_total_tax_amount numeric(10, 2);
  v_total_material_cost numeric(10, 2);
  v_total_commission_payout numeric(10, 2);
  v_total_salary_base numeric(10, 2);
  v_salary_estimated boolean := false;
  v_total_salary_deduction numeric(10, 2) := 0;
  v_estimated_net_margin numeric(10, 2);
  v_breakdown jsonb := '[]'::jsonb;
  rec record;
  v_payroll jsonb;
  v_order_count int;
  v_staff_commission numeric(10, 2);
  -- 紅利系統重構 §3.15(#848)
  v_total_points_redeem_amount numeric(10, 2);
  v_points_feature_enabled boolean;
  -- #985 第 8 批 8-8:料錢影響抽成(只是資訊鍵,不參與任何既有數字)
  v_material_cost_affects_commission_now boolean;
  v_commission_material_deducted_count int;
  v_commission_material_not_deducted_count int;
  -- #1035 A 批 PA-B01:月薪獎金
  v_total_monthly_bonus numeric(12, 2);
  v_bonus_feature_used boolean;
  v_staff_bonus numeric(12, 2);
begin
  if not private.can_view_billing(p_merchant_id) then
    raise exception '沒有權限查詢這間商家的帳務報表' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於起始日期';
  end if;

  -- 後端查詢區間上限保護(§3.6):不只靠前端擋,後端也要擋,避免有人繞過前端限制直接呼叫 RPC
  -- 查詢過大區間造成效能問題或撈出超出預期範圍的資料。
  if (p_end_date - p_start_date) > 366 then
    raise exception '查詢區間最長不能超過一年';
  end if;

  v_range_start := p_start_date::timestamp at time zone 'Asia/Taipei';
  v_range_end := (p_end_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- =======================================================================
  -- 任務 3(使用者已回覆「可以」):月薪相關數字只在「完整月份」的查詢下才計算。
  -- 條件:起始日是某個月的 1 號,且結束日是某個月的最後一天(可以跨多個月,2/1–4/30 合法)。
  --   ・p_start_date 是 1 號          → date_trunc('month', p_start_date) = p_start_date
  --   ・p_end_date 是該月最後一天     → p_end_date + 1 天之後就會跨到下個月的 1 號
  -- 這同時消滅一個真的 bug:原本不論區間頭尾是不是完整月份,都用 generate_series 以「月初」
  -- 為單位展開,所以「查 2/15–3/15(29 天)」會收到 2 個整月的月薪基本額,而扣款那一邊
  -- (compute_staff_payroll_by_range)卻是按區間裁切的 → 兩邊口徑不一致,月薪實發沒有意義。
  -- =======================================================================
  v_salary_applicable := (
    p_start_date = date_trunc('month', p_start_date)::date
    and (p_end_date + 1) = date_trunc('month', (p_end_date + 1)::date)::date
  );

  -- 3.1:total_revenue_excl_tax = Σ(subtotal_amount_snapshot − discount_amount_snapshot),
  -- total_tax_amount = Σ tax_amount_snapshot。
  -- 2026-09-24(任務 1):月份/區間基準從 b.start_at 改成完成時間(理由見檔頭與 §3 的註解)。
  select
    coalesce(sum(b.subtotal_amount_snapshot - b.discount_amount_snapshot), 0),
    coalesce(sum(b.tax_amount_snapshot), 0)
  into v_total_revenue_excl_tax, v_total_tax_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利系統重構 §3.15(#848):紅利折抵金額 = 已完成訂單的 points_redeem_amount_snapshot 加總。
  -- 期間判定跟上面營收同一條(完成時間基準),兩個數字的期間才對得上。只算 completed:取消的單
  -- 折抵已退回、待確認/已確認的單還沒收錢。這是「另外加的資訊欄」,既有鍵(營收、淨利…)一律
  -- 不扣折抵(第 3 題定案 A,§2.11)。
  select coalesce(sum(b.points_redeem_amount_snapshot), 0)
  into v_total_points_redeem_amount
  from public.bookings b
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 紅利功能開關:只有 billing 鑰匙的客服讀不到 merchant_member_settings(RLS),所以由這支
  -- SECURITY DEFINER 函式代為回傳,前端不可以用 useMerchantMemberSettings 判斷(§〇.3 判斷 13)。
  -- 查無設定列 → true,跟前端 DEFAULT_MERCHANT_MEMBER_SETTINGS 一致。
  v_points_feature_enabled := coalesce(
    (select mms.points_feature_enabled
     from public.merchant_member_settings mms
     where mms.merchant_id = p_merchant_id),
    true
  );

  -- 第 11 批 F #993:amount_snapshot 是「單價」,料錢合計 = Σ 單價 × 數量。
  select coalesce(sum(bmc.amount_snapshot * bmc.quantity), 0)
  into v_total_material_cost
  from public.booking_material_costs bmc
  join public.bookings b on b.id = bmc.booking_id
  where b.merchant_id = p_merchant_id
    and b.status = 'completed'
    and coalesce(b.completed_at, b.start_at) >= v_range_start
    and coalesce(b.completed_at, b.start_at) < v_range_end;

  -- 抽成維持 computed_at(已查證 ≡ completed_at,且事後重算不改它,詳見檔頭)。
  select coalesce(sum(bcr.commission_amount), 0)
  into v_total_commission_payout
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  -- §11.8(核心):比照 11.7 的「逐月迴圈」邏輯,對區間內每個月份呼叫 11.6,把每個月份的加總
  -- 結果再加總。只要任一月份任一人用到估算,salary_estimation_applied 就是 true。
  -- 2026-09-24(任務 3):只在 v_salary_applicable 為真時才算;不是完整月份時一律留 null
  -- (不是 0——前端要能分辨「不適用」與「真的是零」)。
  if v_salary_applicable then
    select
      coalesce(sum(gm.total_amount), 0),
      coalesce(bool_or(gm.is_estimated), false)
    into v_total_salary_base, v_salary_estimated
    from generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start)
    cross join lateral private.get_merchant_monthly_salary_base_as_of(
      p_merchant_id,
      ((least((m.month_start + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
        at time zone 'Asia/Taipei') - interval '1 microsecond'
    ) as gm;
  else
    v_total_salary_base := null;
    v_total_salary_deduction := null;
    v_salary_estimated := false;
  end if;

  -- #1035 A 批 PA-B01:月薪獎金合計。跟月薪同一個「完整月份」條件;每月份照「月底當時」的狀態與方案
  -- (compute_staff_monthly_bonus 自己判斷 existed / 在職 / 月薪制 / 有方案,不成立就是 0)。
  -- 只掃「歷史上曾經有過方案」的人,沒有任何方案的店 = 0 列 = 0 元。
  v_bonus_feature_used := exists (
    select 1 from public.staff_bonus_plans bp where bp.merchant_id = p_merchant_id
  );
  if v_salary_applicable then
    select coalesce(sum((private.compute_staff_monthly_bonus(h.staff_id, m.month_start::date) ->> 'amount')::numeric), 0)
    into v_total_monthly_bonus
    from (
      select distinct sh.staff_id
      from public.staff_payroll_status_history sh
      where sh.merchant_id = p_merchant_id
        and sh.bonus_plan_id is not null
    ) h
    cross join generate_series(
      date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
    ) as m(month_start);
  else
    v_total_monthly_bonus := null;
  end if;

  -- 2026-09-24(任務 2):母體改成「區間內至少有一個月份,在該月的 as_of 時間點 existed 且
  -- status=active」的人——跟上面 11.6 逐月加總用的是同一套 as_of 算式(含 least(..., p_end_date)
  -- 的裁切)與同一組條件,兩邊母體必然一致。compensation_type 取「區間內最後一個當時在職月份」
  -- 的值(同一個人可能中途改過計酬類型;取最後一個月份跟 §11 一貫的「月底當下的值」慣例一致)。
  -- 這同時修掉一個附帶的對不起來:已離職的按件計酬人員,他的抽成一直都被算進
  -- total_commission_payout(那個查詢只看 merchant_id + computed_at,不看人員狀態),卻沒有
  -- 任何一列明細承載它。
  for rec in
    with months as (
      select
        gs::date as month_start,
        ((least((gs + interval '1 month - 1 day')::date, p_end_date) + 1)::timestamp
          at time zone 'Asia/Taipei') - interval '1 microsecond' as as_of
      from generate_series(
        date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
      ) as gs
    ),
    staff_months as (
      select
        ms.id, ms.name, ms.display_order, ms.created_at, m.month_start, s.compensation_type,
        -- is_active_as_of 的來源:merchant_staff.status 是「目前」的狀態(語意說明見單月版註解)。
        (ms.status = 'active') as is_currently_active
      from public.merchant_staff ms
      cross join months m
      join lateral private.get_staff_payroll_status_as_of(ms.id, m.as_of) s on true
      where ms.merchant_id = p_merchant_id
        and s.existed
        and s.status = 'active'
    )
    select
      id,
      name,
      is_currently_active,
      (array_agg(compensation_type order by month_start desc))[1] as compensation_type
    from staff_months
    -- is_currently_active 對同一個 id 只有一個值(它來自 merchant_staff 那一列),放進 group by
    -- 只是為了讓它能被 select,不會讓分組變細。
    group by id, name, is_currently_active, display_order, created_at
    order by display_order, created_at, id
  loop
    select count(*)::int into v_order_count
    from public.bookings b
    where b.staff_id = rec.id
      and b.status = 'completed'
      and coalesce(b.completed_at, b.start_at) >= v_range_start
      and coalesce(b.completed_at, b.start_at) < v_range_end;

    if rec.compensation_type = 'monthly_salary' then
      if v_salary_applicable then
        -- §3.6:跨月時依區間內實際涵蓋的每個月份分別計算「當月實際天數」再加總,不是整個區間套用
        -- 同一個天數——private.compute_staff_payroll_by_range 內部已經處理這個邏輯。
        v_payroll := private.compute_staff_payroll_by_range(rec.id, p_start_date, p_end_date);
        v_total_salary_deduction := v_total_salary_deduction
          + coalesce((v_payroll ->> 'total_deduction_amount')::numeric, 0);

        -- #1035 A 批 PA-B01:這位月薪人員區間內每個月份的獎金加總。
        select coalesce(sum((private.compute_staff_monthly_bonus(rec.id, m.month_start::date) ->> 'amount')::numeric), 0)
        into v_staff_bonus
        from generate_series(
          date_trunc('month', p_start_date), date_trunc('month', p_end_date), interval '1 month'
        ) as m(month_start);

        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', v_payroll -> 'net_pay',
          'commission_amount', null,
          'bonus_amount', v_staff_bonus
        );
      else
        -- 任務 3:不是完整月份時,月薪制人員照樣列在明細上(order_count 仍然有意義),
        -- 但 net_pay 回 null,代表「這個區間算不出月薪實發」,不是「實發 0 元」。
        v_breakdown := v_breakdown || jsonb_build_object(
          'staff_id', rec.id,
          'staff_name', rec.name,
          'compensation_type', rec.compensation_type,
          'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
          'net_pay', null,
          'commission_amount', null,
          'bonus_amount', null
        );
      end if;
    else
      select coalesce(sum(bcr.commission_amount), 0) into v_staff_commission
      from public.booking_commission_records bcr
      where bcr.staff_id = rec.id
        and bcr.computed_at >= v_range_start
        and bcr.computed_at < v_range_end;

      v_breakdown := v_breakdown || jsonb_build_object(
        'staff_id', rec.id,
        'staff_name', rec.name,
        'compensation_type', rec.compensation_type,
        'order_count', v_order_count,
        'is_active_as_of', rec.is_currently_active,
        'net_pay', null,
        'commission_amount', v_staff_commission,
        'bonus_amount', null
      );
    end if;
  end loop;

  -- 任務 3:商家總淨利(概估毛利)是「營收 − 料錢 − 抽成 − 月薪實發」,只要月薪那一段算不出來,
  -- 整個數字就沒有意義 → 一律 null,不是拿營收減一減硬湊一個數字出來給商家看。
  if v_salary_applicable then
    v_estimated_net_margin :=
      v_total_revenue_excl_tax - v_total_material_cost - v_total_commission_payout
      - (v_total_salary_base - v_total_salary_deduction)
      - v_total_monthly_bonus;  -- #1035 A 批:月薪獎金(沒有方案 = 0)
  else
    v_estimated_net_margin := null;
  end if;

  -- #985 第 8 批 8-8:三個資訊鍵(既有鍵一個都不改)。
  --   material_cost_affects_commission_now:商家「目前」的設定(查無設定列 ⇒ false)。
  --   兩個計數:期間判斷跟上面「總抽成支出」同一條(bcr.computed_at),筆數才對得上抽成金額。
  v_material_cost_affects_commission_now := coalesce(
    (select mps.commission_basis_type = 'net_of_material_cost'
     from public.merchant_payroll_settings mps
     where mps.merchant_id = p_merchant_id),
    false
  );

  select
    count(*) filter (where bcr.commission_basis_type_snapshot = 'net_of_material_cost')::int,
    count(*) filter (where bcr.commission_basis_type_snapshot = 'gross')::int
  into v_commission_material_deducted_count, v_commission_material_not_deducted_count
  from public.booking_commission_records bcr
  where bcr.merchant_id = p_merchant_id
    and bcr.computed_at >= v_range_start
    and bcr.computed_at < v_range_end;

  return jsonb_build_object(
    'total_revenue_excl_tax', v_total_revenue_excl_tax,
    'total_tax_amount', v_total_tax_amount,
    'total_material_cost', v_total_material_cost,
    'total_commission_payout', v_total_commission_payout,
    'total_monthly_salary_base', v_total_salary_base,
    'total_monthly_salary_deduction', v_total_salary_deduction,
    'estimated_net_margin', v_estimated_net_margin,
    'per_staff_breakdown', v_breakdown,
    'salary_estimation_applied', v_salary_estimated,
    'salary_applicable', v_salary_applicable,
    -- 紅利系統重構 §3.15(#848)
    'total_points_redeem_amount', v_total_points_redeem_amount,
    'points_feature_enabled', v_points_feature_enabled,
    -- #985 第 8 批 8-8
    'material_cost_affects_commission_now', v_material_cost_affects_commission_now,
    'commission_orders_material_deducted_count', v_commission_material_deducted_count,
    'commission_orders_material_not_deducted_count', v_commission_material_not_deducted_count,
    -- #1035 A 批 PA-B01
    'total_monthly_bonus', v_total_monthly_bonus,
    'bonus_feature_used', v_bonus_feature_used
  );
end;
$function$;

-- ACL 照改前(create or replace 不改 ACL;重申:anon 沒有、authenticated / service_role 有)。
revoke execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) from public, anon;
grant execute on function public.get_merchant_billing_summary_by_range(uuid, date, date) to authenticated, service_role;
