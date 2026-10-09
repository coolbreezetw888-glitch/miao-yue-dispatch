-- SPECS-INDEX #1025 功能開關 第三輪(使用者 2026-10-09 補充 ③):所有開關改成「先調整、按儲存才生效」。
-- 一次儲存要在同一個資料庫交易內套用(大項 + 細項同時生效,不會出現大項開了、細項還沒關的中間狀態)。
--
-- 新增兩支「一次存多項」的平台 RPC(既有 platform_set_merchant_feature / platform_set_feature_for_all_merchants 保留):
--   public.platform_set_merchant_features(merchant_id, changes, note)  商家詳情「功能開關」卡按「儲存」
--   public.platform_save_feature_settings(presets, bulk, note)          「功能開關」頁按「儲存」(新開商家預設 + 全部商家開關)
-- 兩支都是:第一行驗 is_platform_admin()(X1);revoke public / anon,只 grant authenticated;一個函式呼叫 = 一個交易,
-- 任何一項驗證失敗整筆不寫;變更紀錄照舊每間店每個功能一筆(⚠️1)。

-- =========================================================================
-- 商家詳情:一次存多個功能
--   p_changes = [{"feature_key": "...", "enabled": true/false}, ...](最多 50 項,同一個 key 不可重複)
--   回傳實際改變的功能數(跟原本一樣的不寫入、不記紀錄)。
-- =========================================================================
create or replace function public.platform_set_merchant_features(
  p_merchant_id uuid,
  p_changes jsonb,
  p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_note text;
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_key text;
  v_enabled boolean;
  v_old boolean;
  v_found boolean;
  v_seen text[] := '{}';
  v_changed integer := 0;
begin
  if not private.is_platform_admin() then
    raise exception '只有超級管理員可以調整功能開關。' using errcode = '42501';
  end if;

  if p_merchant_id is null or not exists (select 1 from public.merchants m where m.id = p_merchant_id) then
    raise exception '找不到這間商家。' using errcode = 'P0002';
  end if;

  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception '沒有要儲存的變更。' using errcode = '22023';
  end if;
  if jsonb_array_length(p_changes) > 50 then
    raise exception '一次最多儲存 50 項。' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if char_length(v_note) > 200 then
    raise exception '備註最多 200 字。' using errcode = '22023';
  end if;

  -- 先全部驗證完才開始寫(任何一項不對整筆不寫;寫入途中出錯也會整筆回滾)。
  for v_item in select * from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'feature_key') is distinct from 'string'
       or jsonb_typeof(v_item -> 'enabled') is distinct from 'boolean' then
      raise exception '變更內容的格式不正確。' using errcode = '22023';
    end if;
    v_key := v_item ->> 'feature_key';
    if not exists (select 1 from public.platform_features f where f.key = v_key) then
      raise exception '沒有這個功能。' using errcode = '22023';
    end if;
    if v_key = any (v_seen) then
      raise exception '同一個功能不能出現兩次。' using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;
  end loop;

  -- 鎖住這間店的開關列,避免跟同時進行的批次 / 單項調整交錯。
  perform 1 from public.merchant_feature_grants g where g.merchant_id = p_merchant_id for update;

  for v_item in select * from jsonb_array_elements(p_changes) loop
    v_key := v_item ->> 'feature_key';
    v_enabled := (v_item ->> 'enabled')::boolean;

    select g.enabled into v_old
    from public.merchant_feature_grants g
    where g.merchant_id = p_merchant_id and g.feature_key = v_key;
    v_found := found;

    if v_found and v_old = v_enabled then
      continue;
    end if;
    if not v_found then
      v_old := null;
    end if;

    insert into public.merchant_feature_grants (merchant_id, feature_key, enabled, updated_by, updated_at)
    values (p_merchant_id, v_key, v_enabled, v_uid, now())
    on conflict (merchant_id, feature_key) do update
      set enabled = excluded.enabled,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at;

    -- ⚠️1 每項一筆;同一次儲存的備註相同。
    insert into public.merchant_feature_grant_logs (merchant_id, feature_key, old_enabled, new_enabled, note, changed_by, is_bulk, created_at)
    values (p_merchant_id, v_key, v_old, v_enabled, v_note, v_uid, false, clock_timestamp());

    v_changed := v_changed + 1;
  end loop;

  return v_changed;
end;
$$;

comment on function public.platform_set_merchant_features(uuid, jsonb, text) is
  'SPECS-INDEX #1025 第三輪 ③:超級管理員一次儲存單一商家的多個平台功能開關(同一個交易:大項 + 細項同時生效)。p_changes = [{feature_key, enabled}],最多 50 項、key 不可重複、必須在功能清單;任何一項不對整筆不寫。第一行檢查 is_platform_admin()(42501);商家不存在 P0002;備註最多 200 字。值跟原本一樣的不寫入、不記紀錄;其餘每項寫一列 merchant_feature_grant_logs(is_bulk = false,同一個備註)。回傳實際改變的項數。';

revoke execute on function public.platform_set_merchant_features(uuid, jsonb, text) from public, anon;
grant execute on function public.platform_set_merchant_features(uuid, jsonb, text) to authenticated;

-- =========================================================================
-- 「功能開關」頁:一次儲存「新開商家預設」+「全部商家開／關」
--   p_presets = [{"industry_type": "on_site_dispatch" | "in_store_beauty", "feature_key": "...", "default_enabled": bool}, ...]
--   p_bulk    = [{"feature_key": "...", "enabled": bool}, ...](對所有商家含停用;同一個 key 不可重複)
--   回傳 {"presets_changed": n, "merchants_changed": {"<feature_key>": n, ...}}
-- 全部商家開關沿用 platform_set_feature_for_all_merchants 的寫法(只寫真的改變的店、is_bulk 紀錄、備註空白寫「批次調整」),
-- 這裡一律 p_also_presets = false —— 新開商家預設由 p_presets 明確指定(畫面上「全部開啟／關閉」會預設把同一列的預設值一起改,
-- 使用者可以再改回來,儲存時以畫面上的值為準)。
-- =========================================================================
create or replace function public.platform_save_feature_settings(
  p_presets jsonb default '[]'::jsonb,
  p_bulk jsonb default '[]'::jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_presets jsonb := coalesce(p_presets, '[]'::jsonb);
  v_bulk jsonb := coalesce(p_bulk, '[]'::jsonb);
  v_item jsonb;
  v_key text;
  v_industry text;
  v_seen text[] := '{}';
  v_presets_changed integer := 0;
  v_rows integer;
  v_merchants jsonb := '{}'::jsonb;
  v_n integer;
begin
  if not private.is_platform_admin() then
    raise exception '只有超級管理員可以調整功能開關。' using errcode = '42501';
  end if;

  if jsonb_typeof(v_presets) <> 'array' or jsonb_typeof(v_bulk) <> 'array' then
    raise exception '變更內容的格式不正確。' using errcode = '22023';
  end if;
  if jsonb_array_length(v_presets) = 0 and jsonb_array_length(v_bulk) = 0 then
    raise exception '沒有要儲存的變更。' using errcode = '22023';
  end if;
  if jsonb_array_length(v_presets) > 100 or jsonb_array_length(v_bulk) > 50 then
    raise exception '一次儲存的項目太多。' using errcode = '22023';
  end if;
  if char_length(nullif(btrim(coalesce(p_note, '')), '')) > 200 then
    raise exception '備註最多 200 字。' using errcode = '22023';
  end if;

  -- 先全部驗證。
  for v_item in select * from jsonb_array_elements(v_presets) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'industry_type') is distinct from 'string'
       or jsonb_typeof(v_item -> 'feature_key') is distinct from 'string'
       or jsonb_typeof(v_item -> 'default_enabled') is distinct from 'boolean' then
      raise exception '變更內容的格式不正確。' using errcode = '22023';
    end if;
    v_industry := v_item ->> 'industry_type';
    v_key := v_item ->> 'feature_key';
    if v_industry not in ('on_site_dispatch', 'in_store_beauty') then
      raise exception '沒有這個產業。' using errcode = '22023';
    end if;
    if not exists (select 1 from public.platform_features f where f.key = v_key) then
      raise exception '沒有這個功能。' using errcode = '22023';
    end if;
    if (v_industry || ':' || v_key) = any (v_seen) then
      raise exception '同一個功能不能出現兩次。' using errcode = '22023';
    end if;
    v_seen := v_seen || (v_industry || ':' || v_key);
  end loop;

  v_seen := '{}';
  for v_item in select * from jsonb_array_elements(v_bulk) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'feature_key') is distinct from 'string'
       or jsonb_typeof(v_item -> 'enabled') is distinct from 'boolean' then
      raise exception '變更內容的格式不正確。' using errcode = '22023';
    end if;
    v_key := v_item ->> 'feature_key';
    if not exists (select 1 from public.platform_features f where f.key = v_key) then
      raise exception '沒有這個功能。' using errcode = '22023';
    end if;
    if v_key = any (v_seen) then
      raise exception '同一個功能不能出現兩次。' using errcode = '22023';
    end if;
    v_seen := v_seen || v_key;
  end loop;

  -- 新開商家預設(只影響之後新開的店,T2)。值一樣的不算改變。
  for v_item in select * from jsonb_array_elements(v_presets) loop
    insert into public.industry_feature_presets (industry_type, feature_key, default_enabled)
    values (v_item ->> 'industry_type', v_item ->> 'feature_key', (v_item ->> 'default_enabled')::boolean)
    on conflict (industry_type, feature_key) do update
      set default_enabled = excluded.default_enabled
      where industry_feature_presets.default_enabled is distinct from excluded.default_enabled;
    get diagnostics v_rows = row_count;
    v_presets_changed := v_presets_changed + v_rows;
  end loop;

  -- 全部商家開／關(同一個交易)。
  for v_item in select * from jsonb_array_elements(v_bulk) loop
    v_n := public.platform_set_feature_for_all_merchants(
      v_item ->> 'feature_key', (v_item ->> 'enabled')::boolean, false, p_note);
    v_merchants := v_merchants || jsonb_build_object(v_item ->> 'feature_key', v_n);
  end loop;

  return jsonb_build_object('presets_changed', v_presets_changed, 'merchants_changed', v_merchants);
end;
$$;

comment on function public.platform_save_feature_settings(jsonb, jsonb, text) is
  'SPECS-INDEX #1025 第三輪 ③:超級管理員在「功能開關」頁按「儲存」,一個交易內套用「新開商家預設」(p_presets)與「全部商家開／關」(p_bulk,沿用 platform_set_feature_for_all_merchants,p_also_presets = false)。第一行檢查 is_platform_admin()(42501);任何一項格式不對 / 產業或功能不在清單 / 重複 ⇒ 22023,整筆不寫。回傳 {presets_changed, merchants_changed:{feature_key: 改變的商家數}}。';

revoke execute on function public.platform_save_feature_settings(jsonb, jsonb, text) from public, anon;
grant execute on function public.platform_save_feature_settings(jsonb, jsonb, text) to authenticated;
