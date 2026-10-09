-- SPECS-INDEX #1025 功能開關 第 1 批(FG-1):機制(功能清單、商家實際開關、變更紀錄、判斷函式、平台 RPC)。
-- 規格書 .project/specs/功能開關.md(第 2 版)第二節、第三節 FG1-A01 ~ A07、F03 ~ F05。
--
-- 架構(第二節):
--   platform_features          功能清單(程式維護,只有 migration 寫入;畫面只能開關、不能新增名稱 —— T8)
--     ├─ industry_feature_presets   產業預設(既有表,加外鍵):只在開店 / 開分店那一刻套用一次(T2、T4)
--     └─ merchant_feature_grants    每間商家實際的開關(新表,只有平台寫得進去 —— T1)
--            └─ private.merchant_has_feature(merchant_id, key)  ← 所有擋住點都只問這一支
--
-- 🔴 新增功能的約定(給之後每一批,例如 FG-2、FG-3、施工圖片):那一批的 migration 要
--    ① 在 platform_features 加一列;② 兩個產業各加一列 industry_feature_presets;
--    ③ 幫所有既有商家補一列 merchant_feature_grants(值由那一批的規格明寫)。
--    三件事缺一不可,pgTAP req1025_01 ⑩ 會抓。
--
-- 本檔不改任何既有擋住點函式(那些在 20261010150100);只改 apply_industry_preset(FG1-A06)。
-- ⚠️5(F6 批次開關 + 統計,FG1-F06)這次**不做**;merchant_feature_grant_logs.is_bulk 先建好,之後補函式不用改表。

-- =========================================================================
-- FG1-A01 功能清單 public.platform_features
-- =========================================================================
create table public.platform_features (
  key text primary key,
  name text not null,
  description text not null,
  off_impact text not null,
  parent_key text null references public.platform_features(key),
  sort_order smallint not null,
  default_enabled boolean not null,
  created_at timestamptz not null default now(),
  constraint platform_features_key_format check (key ~ '^[a-z][a-z0-9_]{1,49}$'),
  constraint platform_features_parent_not_self check (parent_key <> key)
);

comment on table public.platform_features is
  'SPECS-INDEX #1025 FG1-A01:平台功能清單(程式維護,只有 migration 寫入)。parent_key = 屬於哪個主功能(只允許一層,trigger 擋)。default_enabled 只在 merchant_feature_grants 沒有那一列時當防禦用的預設值。';

-- 只允許一層:細部功能的主功能不能自己也是細部功能;已經有細部功能的主功能不能變成細部功能。
create or replace function private.platform_features_one_level_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_key is not null then
    if exists (
      select 1 from public.platform_features p
      where p.key = new.parent_key and p.parent_key is not null
    ) then
      raise exception '功能清單只允許一層：「%」的主功能本身也是細部功能。', new.key using errcode = '23514';
    end if;
    if exists (
      select 1 from public.platform_features c
      where c.parent_key = new.key
    ) then
      raise exception '功能清單只允許一層：「%」底下已經有細部功能，不能再設成別人的細部功能。', new.key using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function private.platform_features_one_level_guard() from public, anon, authenticated;

create trigger platform_features_one_level_guard
  before insert or update of parent_key on public.platform_features
  for each row execute function private.platform_features_one_level_guard();

alter table public.platform_features enable row level security;

create policy platform_features_select on public.platform_features
  for select to authenticated
  using (true);

revoke all on table public.platform_features from anon;
revoke insert, update, delete, truncate, references, trigger on table public.platform_features from authenticated;

-- 本批 3 列(文字照規格書 FG1-A01 表格,不自己改字)。
insert into public.platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled) values
  ('online_booking', '客戶線上預約',
   '客人用預約網址自己看服務、選時間、送出預約。',
   '客人打開預約網址會看到「這間店目前暫停線上預約」，不能再線上送出預約。已經成立的預約不受影響，店家後台照常可以建單。商家後台看不到預約網址。',
   null, 10, true),
  ('data_import', '資料匯入',
   '用檔案一次匯入會員、歷史訂單。',
   '商家後台看不到「資料匯入」和「匯入紀錄」。以前匯入的資料不受影響，重新打開後紀錄還在。',
   null, 20, true),
  ('report_export', '報表匯出中心',
   '下載訂單、會員、請假、服務人員的報表檔案。',
   '商家後台看不到「報表匯出中心」，不能再下載報表檔案。畫面上的店家報表、服務人員報表照常可以看。',
   null, 30, true);

-- =========================================================================
-- FG1-A02 產業預設 industry_feature_presets 加外鍵 + 本批預設值
-- =========================================================================
do $$
declare
  v_total integer;
  v_orphans integer;
begin
  select count(*) into v_total from public.industry_feature_presets;
  select count(*) into v_orphans
  from public.industry_feature_presets ifp
  where not exists (select 1 from public.platform_features f where f.key = ifp.feature_key);
  raise notice '[req1025 FG1-A02] industry_feature_presets 現有 % 列,其中 % 列的 feature_key 不在功能清單', v_total, v_orphans;
  if v_orphans > 0 then
    raise exception '[req1025 FG1-A02] industry_feature_presets 有 % 列的 feature_key 不在功能清單，停止(不自動刪除，請人工確認)', v_orphans;
  end if;
end;
$$;

alter table public.industry_feature_presets
  add constraint industry_feature_presets_feature_key_fkey
  foreign key (feature_key) references public.platform_features(key) on delete cascade;

-- Q4=A:兩個產業 × 3 個功能,預設全開。
insert into public.industry_feature_presets (industry_type, feature_key, default_enabled)
select t.industry_type, f.key, true
from (values ('on_site_dispatch'), ('in_store_beauty')) as t(industry_type)
cross join public.platform_features f
on conflict (industry_type, feature_key) do nothing;

-- =========================================================================
-- FG1-A03 商家實際開關 public.merchant_feature_grants
-- =========================================================================
create table public.merchant_feature_grants (
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  feature_key text not null references public.platform_features(key) on delete cascade,
  enabled boolean not null,
  updated_by uuid null,
  updated_at timestamptz not null default now(),
  primary key (merchant_id, feature_key)
);

comment on table public.merchant_feature_grants is
  'SPECS-INDEX #1025 FG1-A03:平台給每間商家的功能開關(T1:跟商家自己可寫的 merchant_feature_flags 分開)。沒有任何寫入政策;只能透過 platform_set_merchant_feature(超級管理員)與 apply_industry_preset(開店 / 開分店)寫入。updated_by = 最後改的人(auth.uid),開店自動寫入與 migration 補資料為 null。';

create index merchant_feature_grants_feature_key_idx on public.merchant_feature_grants (feature_key);

create trigger merchant_feature_grants_set_updated_at
  before update on public.merchant_feature_grants
  for each row execute function public.set_updated_at();

alter table public.merchant_feature_grants enable row level security;

create policy merchant_feature_grants_select on public.merchant_feature_grants
  for select to authenticated
  using (
    private.is_platform_admin()
    or private.is_merchant_admin(merchant_id)
    or private.is_merchant_agent(merchant_id)
    or private.is_merchant_staff(merchant_id)
  );

revoke all on table public.merchant_feature_grants from anon;
revoke insert, update, delete, truncate, references, trigger on table public.merchant_feature_grants from authenticated;

-- 既有商家補資料:每間 × 功能清單每一項 = true ⇒ 既有商家行為完全不變(第五節第 2 點)。
do $$
declare
  v_merchants integer;
  v_features integer;
  v_rows integer;
begin
  select count(*) into v_merchants from public.merchants;
  select count(*) into v_features from public.platform_features;
  raise notice '[req1025 FG1-A03] 補資料前:商家 % 間 × 功能 % 項', v_merchants, v_features;

  insert into public.merchant_feature_grants (merchant_id, feature_key, enabled)
  select m.id, f.key, true
  from public.merchants m
  cross join public.platform_features f
  on conflict (merchant_id, feature_key) do nothing;

  select count(*) into v_rows from public.merchant_feature_grants;
  raise notice '[req1025 FG1-A03] 補資料後:merchant_feature_grants % 列', v_rows;
  if v_rows <> v_merchants * v_features then
    raise exception '[req1025 FG1-A03] 列數 % 不等於 商家數 % × 功能數 %，停止', v_rows, v_merchants, v_features;
  end if;
end;
$$;

-- =========================================================================
-- FG1-A04 ⚠️1 變更紀錄 public.merchant_feature_grant_logs
-- =========================================================================
create table public.merchant_feature_grant_logs (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  feature_key text not null references public.platform_features(key) on delete cascade,
  old_enabled boolean null,
  new_enabled boolean not null,
  note text null,
  changed_by uuid not null,
  is_bulk boolean not null default false,
  created_at timestamptz not null default now(),
  constraint merchant_feature_grant_logs_note_length check (note is null or char_length(note) <= 200)
);

comment on table public.merchant_feature_grant_logs is
  'SPECS-INDEX #1025 FG1-A04(⚠️1):平台功能開關的人為變更紀錄(誰、何時、哪間店、哪個功能、開關前後、備註)。只有超級管理員看得到;只由 platform_set_merchant_feature(之後的批次函式 is_bulk = true)寫入。開店自動套用、migration 補資料不寫紀錄。';

create index merchant_feature_grant_logs_merchant_created_idx
  on public.merchant_feature_grant_logs (merchant_id, created_at desc);

alter table public.merchant_feature_grant_logs enable row level security;

create policy merchant_feature_grant_logs_select on public.merchant_feature_grant_logs
  for select to authenticated
  using (private.is_platform_admin());

revoke all on table public.merchant_feature_grant_logs from anon;
revoke insert, update, delete, truncate, references, trigger on table public.merchant_feature_grant_logs from authenticated;

-- =========================================================================
-- FG1-A05 判斷函式 private.merchant_has_feature
-- =========================================================================
-- 規則(第二節):
--   1. key 不在功能清單 ⇒ false(fail closed)。
--   2. 細部功能,而且主功能判斷為關 ⇒ false(T5)。
--   3. merchant_feature_grants 有這間店這個 key 的列 ⇒ 用那一列的 enabled。
--   4. 沒有列 ⇒ 用 platform_features.default_enabled(防禦用)。
--   (merchant_id 為 null ⇒ false。)
-- 功能清單只允許一層(trigger 擋),所以主功能本身一定沒有主功能,不用遞迴。
create or replace function private.merchant_has_feature(p_merchant_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select
      coalesce(g.enabled, f.default_enabled)
      and (f.parent_key is null or coalesce(pg.enabled, pf.default_enabled, false))
    from public.platform_features f
    left join public.merchant_feature_grants g
      on g.merchant_id = p_merchant_id and g.feature_key = f.key
    left join public.platform_features pf
      on pf.key = f.parent_key
    left join public.merchant_feature_grants pg
      on pg.merchant_id = p_merchant_id and pg.feature_key = f.parent_key
    where f.key = p_feature_key
      and p_merchant_id is not null
  ), false);
$$;

comment on function private.merchant_has_feature(uuid, text) is
  'SPECS-INDEX #1025 FG1-A05:這間商家有沒有這個平台功能。不在清單 ⇒ false;細部功能在主功能關時 ⇒ false;有 merchant_feature_grants 列用列值,沒有用 platform_features.default_enabled。只給其他 SECURITY DEFINER 函式內部呼叫(anon / authenticated 都不能直接執行)。';

revoke execute on function private.merchant_has_feature(uuid, text) from public, anon, authenticated;

-- =========================================================================
-- FG1-A06 改寫 public.apply_industry_preset:寫進 merchant_feature_grants
-- =========================================================================
-- 簽章、security definer、ACL(postgres / service_role)不變;呼叫者 create_group_and_merchant /
-- create_merchant_in_group 不動。不再寫 merchant_feature_flags(那是商家自己的設定,T1)。
create or replace function public.apply_industry_preset(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_industry_type text;
begin
  select industry_type into v_industry_type
  from public.merchants
  where id = p_merchant_id;

  if v_industry_type is null then
    raise exception '找不到指定的商家：%', p_merchant_id;
  end if;

  -- #1025 FG1-A06:功能清單每一項都寫一列;值 = 這個產業的預設,沒設產業預設就用功能清單的預設值。
  insert into public.merchant_feature_grants (merchant_id, feature_key, enabled)
  select p_merchant_id, f.key, coalesce(ifp.default_enabled, f.default_enabled)
  from public.platform_features f
  left join public.industry_feature_presets ifp
    on ifp.feature_key = f.key and ifp.industry_type = v_industry_type
  on conflict (merchant_id, feature_key) do nothing;
end;
$$;

comment on function public.apply_industry_preset(uuid) is
  '依商家的 industry_type 讀取 industry_feature_presets,批次寫入 merchant_feature_grants(SPECS-INDEX #1025 FG1-A06 起改寫平台功能開關表，不再寫 merchant_feature_flags)。功能清單每一項都寫一列，值 = 該產業的預設，沒設產業預設就用 platform_features.default_enabled;on conflict do nothing。只在開店 / 開分店時呼叫一次(T2:之後改產業預設不影響已開好的商家;T3:商家切換產業也不重套)。';

revoke execute on function public.apply_industry_preset(uuid) from public, anon, authenticated;
grant execute on function public.apply_industry_preset(uuid) to service_role;

-- =========================================================================
-- FG1-A07 ⚠️2 收緊 merchant_feature_flags 能寫的 key
-- =========================================================================
do $$
declare
  v_other integer;
begin
  select count(*) into v_other
  from public.merchant_feature_flags
  where feature_key not in ('material_cost_enabled', 'strict_conflict_check');
  raise notice '[req1025 FG1-A07] merchant_feature_flags 不是 material_cost_enabled / strict_conflict_check 的列:% 列', v_other;
  if v_other > 0 then
    raise exception '[req1025 FG1-A07] merchant_feature_flags 有 % 列不是兩種既有 key，停止(不自動刪除，請人工確認)', v_other;
  end if;
end;
$$;

alter table public.merchant_feature_flags
  add constraint merchant_feature_flags_feature_key_allowed
  check (feature_key in ('material_cost_enabled', 'strict_conflict_check'));

-- =========================================================================
-- FG1-F03 平台改單一商家開關 public.platform_set_merchant_feature
-- =========================================================================
create or replace function public.platform_set_merchant_feature(
  p_merchant_id uuid,
  p_feature_key text,
  p_enabled boolean,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old boolean;
  v_note text;
begin
  if not private.is_platform_admin() then
    raise exception '只有超級管理員可以調整功能開關。' using errcode = '42501';
  end if;

  if p_merchant_id is null or not exists (select 1 from public.merchants m where m.id = p_merchant_id) then
    raise exception '找不到這間商家。' using errcode = 'P0002';
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

  select g.enabled into v_old
  from public.merchant_feature_grants g
  where g.merchant_id = p_merchant_id and g.feature_key = p_feature_key
  for update;

  -- 值跟原本一樣 ⇒ 不寫紀錄、直接結束。
  if found and v_old = p_enabled then
    return;
  end if;

  insert into public.merchant_feature_grants (merchant_id, feature_key, enabled, updated_by, updated_at)
  values (p_merchant_id, p_feature_key, p_enabled, auth.uid(), now())
  on conflict (merchant_id, feature_key) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  -- ⚠️1 變更紀錄
  -- created_at 用 clock_timestamp():同一個交易裡連改幾次時,紀錄的先後順序仍然分得出來。
  insert into public.merchant_feature_grant_logs (merchant_id, feature_key, old_enabled, new_enabled, note, changed_by, is_bulk, created_at)
  values (p_merchant_id, p_feature_key, v_old, p_enabled, v_note, auth.uid(), false, clock_timestamp());
end;
$$;

comment on function public.platform_set_merchant_feature(uuid, text, boolean, text) is
  'SPECS-INDEX #1025 FG1-F03:超級管理員開關單一商家的平台功能。第一行檢查 is_platform_admin();商家不存在 P0002、功能不在清單 22023、備註最多 200 字。值跟原本一樣 ⇒ 不寫紀錄。每次實際變更寫一列 merchant_feature_grant_logs(⚠️1)。';

revoke execute on function public.platform_set_merchant_feature(uuid, text, boolean, text) from public, anon;
grant execute on function public.platform_set_merchant_feature(uuid, text, boolean, text) to authenticated;

-- =========================================================================
-- FG1-F04 讀取 public.get_merchant_features
-- =========================================================================
create or replace function public.get_merchant_features(p_merchant_id uuid)
returns table (
  feature_key text,
  name text,
  description text,
  off_impact text,
  parent_key text,
  sort_order smallint,
  granted boolean,
  effective boolean,
  preset_enabled boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  -- 防 IDOR:亂填別人家的 merchant_id 拿不到(X2)。
  if p_merchant_id is null or not (
    private.is_platform_admin()
    or private.is_merchant_admin(p_merchant_id)
    or private.is_merchant_agent(p_merchant_id)
    or private.is_merchant_staff(p_merchant_id)
  ) then
    raise exception '沒有權限查看這間商家的功能。' using errcode = '42501';
  end if;

  return query
  select
    f.key,
    f.name,
    f.description,
    f.off_impact,
    f.parent_key,
    f.sort_order,
    g.enabled,
    private.merchant_has_feature(p_merchant_id, f.key),
    ifp.default_enabled
  from public.platform_features f
  left join public.merchant_feature_grants g
    on g.merchant_id = p_merchant_id and g.feature_key = f.key
  left join public.merchants m
    on m.id = p_merchant_id
  left join public.industry_feature_presets ifp
    on ifp.feature_key = f.key and ifp.industry_type = m.industry_type
  left join public.platform_features pf
    on pf.key = f.parent_key
  -- 主功能在前、細部功能緊跟在自己的主功能後面。
  order by coalesce(pf.sort_order, f.sort_order), coalesce(pf.key, f.key), (f.parent_key is not null), f.sort_order, f.key;
end;
$$;

comment on function public.get_merchant_features(uuid) is
  'SPECS-INDEX #1025 FG1-F04:列出這間商家每個平台功能:granted(那一列的值,沒有列為 null)、effective(merchant_has_feature 的結果)、preset_enabled(這間店目前產業的預設值)。呼叫者必須是超級管理員或這間店的管理員 / 客服 / 服務人員,否則 42501(防 IDOR)。';

revoke execute on function public.get_merchant_features(uuid) from public, anon;
grant execute on function public.get_merchant_features(uuid) to authenticated;

-- =========================================================================
-- FG1-F05 ⚠️1 讀取變更紀錄 public.platform_list_merchant_feature_logs
-- =========================================================================
create or replace function public.platform_list_merchant_feature_logs(p_merchant_id uuid, p_limit integer default 20)
returns table (
  created_at timestamptz,
  feature_key text,
  feature_name text,
  old_enabled boolean,
  new_enabled boolean,
  note text,
  is_bulk boolean,
  changed_by_email text
)
language plpgsql
stable
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  if not private.is_platform_admin() then
    raise exception '只有超級管理員可以查看功能開關紀錄。' using errcode = '42501';
  end if;

  return query
  select
    l.created_at,
    l.feature_key,
    f.name,
    l.old_enabled,
    l.new_enabled,
    l.note,
    l.is_bulk,
    u.email::text
  from public.merchant_feature_grant_logs l
  join public.platform_features f on f.key = l.feature_key
  left join auth.users u on u.id = l.changed_by
  where l.merchant_id = p_merchant_id
  order by l.created_at desc, l.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

comment on function public.platform_list_merchant_feature_logs(uuid, integer) is
  'SPECS-INDEX #1025 FG1-F05(⚠️1):超級管理員看某間商家最近的功能開關變更紀錄(含改的人 email,auth.users 一律包在權限檢查後)。p_limit 夾在 1~100,預設 20。';

revoke execute on function public.platform_list_merchant_feature_logs(uuid, integer) from public, anon;
grant execute on function public.platform_list_merchant_feature_logs(uuid, integer) to authenticated;
