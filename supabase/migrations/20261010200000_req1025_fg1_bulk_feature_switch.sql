-- SPECS-INDEX #1025 功能開關 第 1 批補做(⚠️5,使用者第二輪 F6 裁決「做」):
--   FG1-F06 全部商家一起開關 + 目前幾間開／幾間關統計。
-- 規格書 .project/specs/功能開關.md(第 2 版)FG1-F06、FG1-T01 ⑫、邊界 16。
--
-- 只新增兩支函式,不改任何既有表或函式:
--   public.platform_feature_usage_summary()                         統計(依 merchant_has_feature 的實際結果)
--   public.platform_set_feature_for_all_merchants(key, enabled, also_presets, note)  批次開關
-- 寫入對象跟 FG1-F03 一樣:merchant_feature_grants(真相來源)+ merchant_feature_grant_logs(⚠️1,is_bulk = true)。
-- 兩支第一行都檢查 is_platform_admin()(X1);revoke public / anon,只 grant authenticated(supabase-permission-hygiene 規則 1)。

-- =========================================================================
-- FG1-F06-1 統計 public.platform_feature_usage_summary
-- =========================================================================
create or replace function public.platform_feature_usage_summary()
returns table (
  feature_key text,
  enabled_count integer,
  disabled_count integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not private.is_platform_admin() then
    raise exception '只有超級管理員可以查看功能開關統計。' using errcode = '42501';
  end if;

  -- 所有商家(含停用的),依 merchant_has_feature 的實際結果(細部功能在主功能關時算關,T5)。
  -- 一間商家都沒有時,兩個數字都是 0(left join lateral 留一列 null)。
  return query
  select
    f.key,
    (count(*) filter (where x.on_flag is true))::integer,
    (count(*) filter (where x.on_flag is false))::integer
  from public.platform_features f
  left join lateral (
    select private.merchant_has_feature(m.id, f.key) as on_flag
    from public.merchants m
  ) x on true
  group by f.key
  order by f.key;
end;
$$;

comment on function public.platform_feature_usage_summary() is
  'SPECS-INDEX #1025 FG1-F06(⚠️5):超級管理員看每個平台功能目前幾間商家開、幾間關(所有商家含停用;依 private.merchant_has_feature 的實際結果,細部功能在主功能關時算關)。非超級管理員 42501。';

revoke execute on function public.platform_feature_usage_summary() from public, anon;
grant execute on function public.platform_feature_usage_summary() to authenticated;

-- =========================================================================
-- FG1-F06-2 批次開關 public.platform_set_feature_for_all_merchants
-- =========================================================================
create or replace function public.platform_set_feature_for_all_merchants(
  p_feature_key text,
  p_enabled boolean,
  p_also_presets boolean default true,
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
  v_changed integer;
begin
  if not private.is_platform_admin() then
    raise exception '只有超級管理員可以調整功能開關。' using errcode = '42501';
  end if;

  if p_feature_key is null or not exists (select 1 from public.platform_features f where f.key = p_feature_key) then
    raise exception '沒有這個功能。' using errcode = '22023';
  end if;

  if p_enabled is null then
    raise exception '請指定要開啟還是關閉。' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if char_length(v_note) > 200 then
    raise exception '備註最多 200 字。' using errcode = '22023';
  end if;
  -- ⚠️1:批次調整沒填備註時,紀錄寫「批次調整」。
  v_note := coalesce(v_note, '批次調整');

  -- 鎖住這個功能現有的每一列,避免跟同時進行的單店調整(platform_set_merchant_feature)交錯。
  perform 1
  from public.merchant_feature_grants g
  where g.feature_key = p_feature_key
  for update;

  -- 用當下的商家清單(邊界 16:剛被刪的店 cascade 掉,不影響結果)。
  -- 只有「值真的會改變」的店才寫入與記紀錄;原本沒有列(防禦用情境)視為改變,紀錄 old_enabled = null。
  with targets as (
    select m.id as merchant_id, g.enabled as old_enabled
    from public.merchants m
    left join public.merchant_feature_grants g
      on g.merchant_id = m.id and g.feature_key = p_feature_key
    where g.enabled is distinct from p_enabled
  ),
  upserted as (
    insert into public.merchant_feature_grants (merchant_id, feature_key, enabled, updated_by, updated_at)
    select t.merchant_id, p_feature_key, p_enabled, v_uid, now()
    from targets t
    on conflict (merchant_id, feature_key) do update
      set enabled = excluded.enabled,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
    returning 1
  ),
  logged as (
    insert into public.merchant_feature_grant_logs
      (merchant_id, feature_key, old_enabled, new_enabled, note, changed_by, is_bulk, created_at)
    select t.merchant_id, p_feature_key, t.old_enabled, p_enabled, v_note, v_uid, true, clock_timestamp()
    from targets t
    returning 1
  )
  select (select count(*) from upserted)::integer into v_changed;

  -- 同一個交易內把兩個產業的「新開商家預設」也改成一樣。
  if coalesce(p_also_presets, false) then
    insert into public.industry_feature_presets (industry_type, feature_key, default_enabled)
    select t.industry_type, p_feature_key, p_enabled
    from (values ('on_site_dispatch'), ('in_store_beauty')) as t(industry_type)
    on conflict (industry_type, feature_key) do update
      set default_enabled = excluded.default_enabled;
  end if;

  return v_changed;
end;
$$;

comment on function public.platform_set_feature_for_all_merchants(text, boolean, boolean, text) is
  'SPECS-INDEX #1025 FG1-F06(⚠️5):超級管理員把某個平台功能對「所有商家(含停用)」一次開或關。第一行檢查 is_platform_admin()(42501);功能不在清單 22023;備註最多 200 字。只有值真的改變的店才寫入並記一列 merchant_feature_grant_logs(is_bulk = true,備註空白時寫「批次調整」)。p_also_presets = true 時同一個交易內把兩個產業的 industry_feature_presets 也設成同一個值。回傳實際被改變的商家數;整支一個交易,失敗整筆回滾。';

revoke execute on function public.platform_set_feature_for_all_merchants(text, boolean, boolean, text) from public, anon;
grant execute on function public.platform_set_feature_for_all_merchants(text, boolean, boolean, text) to authenticated;
