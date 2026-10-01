-- 紅利系統重構 批次 6:紅利設定頁改版的後端 + 砍掉舊欄位 points_earn_rate。
-- 對應規格書 .project/specs/紅利系統重構.md(v2.3 + v2.4 主腦裁決)§八 批次 6:
--   ① §3.10 private.protect_merchant_member_settings_rule_columns:把 points_earn_rate 移出保護清單
--   ② §1.1 drop column merchant_member_settings.points_earn_rate(§〇.4 判斷 19:延到這一批才做)
--   ③ §3.9 public.upsert_member_point_formulas(公式批次儲存,設定頁「紅利計算」分頁的「儲存設定」)
--   ④ public.get_point_formula_service_items(設定頁公式下拉要列的服務項目;見下方「為什麼多一支」)
--
-- 【套用前 SELECT 核對(CLAUDE.md 5-1 / 規格書 §1.1 套用程序)】2026-10-01 對正式庫(唯讀,ref wjtbmmnakcriuaqoknsq):
--   select m.name, s.points_earn_rate from merchant_member_settings s join merchants m on m.id = s.merchant_id
--   where s.points_earn_rate <> 0;
--   ⇒ 14 列,**全部**是名稱含「E2E」的測試商家(非 E2E 0 列)。沒有任何真實商家的值需要回填或遷移,
--     drop 會一併丟掉這 14 列測試值(使用者已裁決測試資料最後一次清空,可接受)。
--   正式庫仍引用這個欄位的函式(prosrc ilike '%points_earn_rate%'):
--     public.compute_member_loyalty_points(指紋 5fe102be… ,批次 4 migration 20261001050000 已改寫成不讀它)
--     private.protect_merchant_member_settings_rule_columns(指紋 218667b3… ,批次 1 改過、本支 ① 再改)
--   沒有任何 view / materialized view 引用。
--   ⇒ 只要批次 1~5 依序套用、再套這一支,資料庫裡就不會剩下任何引用。下方 ② 前面有一道守門,
--     套用當下若還有別的函式 / view 引用這個欄位、或冒出非測試商家的非 0 值,整支 migration 直接中止,
--     不會留下「欄位砍了、函式執行時才爆炸」的狀態(plpgsql 函式本體不會因為 drop column 而在套用時報錯)。
--
-- 【權限】本支新增的兩支 public 函式都是 security definer,開頭檢查 private.can_manage_member_points
--   (跟 merchant_point_formulas 的 RLS 同一把鑰匙,§2.8「公式增刪改查 = member_points」),
--   revoke public, anon, authenticated 之後只 grant authenticated(規則 1:三個都要先收再給)。

-- =========================================================================
-- ① §3.10 保護 trigger:移除 points_earn_rate(其餘逐字照批次 1 的版本)。
--    必須跟 drop column 在同一支 migration,而且排在 drop 之前:舊版本體寫死 new.points_earn_rate,
--    欄位一消失,這張表任何 INSERT / UPDATE 都會在 trigger 裡報錯。
-- =========================================================================
create or replace function private.protect_merchant_member_settings_rule_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  -- 這次異動有沒有真的改動到「紅利點數規則」那些欄位。
  v_touches_points_rules boolean;
  -- 這次異動有沒有真的改動到「會員政策」那兩個欄位。
  v_touches_policy boolean;
  v_merchant_id uuid;
begin
  if tg_op = 'INSERT' then
    -- INSERT:old 是 NULL,不能寫 `is distinct from old.xxx`(對 NULL record 取欄位在 plpgsql
    -- 觸發器裡會直接 raise)。改成判斷「有沒有主動帶了非預設值」,預設值以 schema 實際宣告為準。
    v_touches_points_rules :=
      coalesce(new.points_feature_enabled, true) is distinct from true
      or coalesce(new.reward_condition_mode, 'none') is distinct from 'none'
      or coalesce(new.referral_bonus_points, 0) is distinct from 0
      or coalesce(new.birthday_bonus_points, 0) is distinct from 0
      -- 紅利系統重構 §1.1 A 紅利計算
      or coalesce(new.earn_mode, 'basic') is distinct from 'basic'
      or coalesce(new.basic_points_per_order, 0) is distinct from 0
      or coalesce(new.basic_min_amount, 0) is distinct from 0::numeric
      or coalesce(new.basic_tiered_enabled, false) is distinct from false
      -- §1.1 B 點數使用
      or coalesce(new.redeem_points_unit, 0) is distinct from 0
      or coalesce(new.redeem_amount_unit, 0) is distinct from 0::numeric
      or coalesce(new.redeem_max_ratio_percent, 0) is distinct from 0
      -- §1.1 C 推薦系統
      or coalesce(new.referral_inviter_reward_enabled, false) is distinct from false
      or coalesce(new.referral_subsequent_bonus_points, 0) is distinct from 0
      or coalesce(new.referral_inviter_earning_enabled, true) is distinct from true
      or coalesce(new.referral_invitee_earning_enabled, true) is distinct from true
      -- §1.1 D 生日獎勵
      or coalesce(new.birthday_bonus_enabled, false) is distinct from false
      or coalesce(new.birthday_line_message, '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。')
           is distinct from '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。';

    v_touches_policy :=
      coalesce(new.policy_enabled, false) is distinct from false
      or new.policy_content is not null;

    v_merchant_id := new.merchant_id;
  else
    -- UPDATE:比對「值有沒有真的被改動」。這是整支 trigger 的關鍵——用 is distinct from 而不是
    -- 「payload 有沒有帶這個欄位」,所以 MemberSettingsPage 存會員政策時把規則欄位原樣
    -- 送一次(值沒變)完全不會觸發規則組的檢查,反之亦然。
    v_touches_points_rules :=
      new.points_feature_enabled is distinct from old.points_feature_enabled
      or new.reward_condition_mode is distinct from old.reward_condition_mode
      or new.referral_bonus_points is distinct from old.referral_bonus_points
      or new.birthday_bonus_points is distinct from old.birthday_bonus_points
      -- 紅利系統重構 §1.1 A 紅利計算
      or new.earn_mode is distinct from old.earn_mode
      or new.basic_points_per_order is distinct from old.basic_points_per_order
      or new.basic_min_amount is distinct from old.basic_min_amount
      or new.basic_tiered_enabled is distinct from old.basic_tiered_enabled
      -- §1.1 B 點數使用
      or new.redeem_points_unit is distinct from old.redeem_points_unit
      or new.redeem_amount_unit is distinct from old.redeem_amount_unit
      or new.redeem_max_ratio_percent is distinct from old.redeem_max_ratio_percent
      -- §1.1 C 推薦系統
      or new.referral_inviter_reward_enabled is distinct from old.referral_inviter_reward_enabled
      or new.referral_subsequent_bonus_points is distinct from old.referral_subsequent_bonus_points
      or new.referral_inviter_earning_enabled is distinct from old.referral_inviter_earning_enabled
      or new.referral_invitee_earning_enabled is distinct from old.referral_invitee_earning_enabled
      -- §1.1 D 生日獎勵
      or new.birthday_bonus_enabled is distinct from old.birthday_bonus_enabled
      or new.birthday_line_message is distinct from old.birthday_line_message;

    v_touches_policy :=
      new.policy_enabled is distinct from old.policy_enabled
      or new.policy_content is distinct from old.policy_content;

    -- 用 old.merchant_id(這一列目前歸屬的商家)。merchant_id 是主鍵,理論上不會被改,
    -- 這裡比照 20260924020100 的既有寫法多一層保險。
    v_merchant_id := old.merchant_id;
  end if;

  if v_touches_points_rules
     -- 放行路徑:service_role(後台維運 / Edge Function)。目前沒有任何 Edge Function 會寫
     -- 這張表,保留這道是為了跟既有三支保護 trigger 的結構一致,不留下「將來多一條路徑就爆掉」
     -- 的落差。
     and auth.role() <> 'service_role'
     and not private.can_manage_member_points(v_merchant_id)
  then
    raise exception '紅利點數的規則設定(啟用開關、核發獎勵資格條件、紅利計算、點數使用、推薦系統、生日獎勵)需要「紅利點數管理」權限才能修改;「會員管理」權限可以做手動調整與登記兌換,但不能改這些規則'
      using errcode = '42501';
  end if;

  if v_touches_policy
     and auth.role() <> 'service_role'
     and not private.can_manage_member_settings(v_merchant_id)
  then
    raise exception '會員政策(啟用開關與政策內容)需要「會員系統設定」權限才能修改'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.protect_merchant_member_settings_rule_columns() is '2026-09-24 使用者裁決(紅利點數管理權限拆分)的欄位層級保護;2026-10-01 紅利系統重構批次 1(§3.10)擴充保護清單、批次 6 隨 drop column 移除 points_earn_rate。merchant_member_settings 是整列 upsert(PostgREST 不是 RPC),RLS 的 UPDATE policy 是整列層級、WITH CHECK 看不到 OLD,所以用 BEFORE INSERT OR UPDATE trigger(比照 merchant_staff 上既有三支保護 trigger)。兩組欄位對稱處理:「紅利點數規則」= points_feature_enabled/reward_condition_mode/referral_bonus_points/birthday_bonus_points + 紅利計算(earn_mode/basic_points_per_order/basic_min_amount/basic_tiered_enabled)+ 點數使用(redeem_points_unit/redeem_amount_unit/redeem_max_ratio_percent)+ 推薦系統(referral_inviter_reward_enabled/referral_subsequent_bonus_points/referral_inviter_earning_enabled/referral_invitee_earning_enabled)+ 生日獎勵(birthday_bonus_enabled/birthday_line_message),要 private.can_manage_member_points;會員政策兩欄(policy_enabled/policy_content)要 private.can_manage_member_settings。⚠️ 判斷的是「值真的有變動」(is distinct from)而不是「payload 有沒有帶這個欄位」。INSERT 面跟 schema 實際預設值比對;seed_default_member_settings 只帶 merchant_id,所以建立新商家的路徑一定不會被擋。';

-- =========================================================================
-- ② §1.1 drop column points_earn_rate(§〇.4 判斷 19)。
--    守門(套用當下再核對一次,不只靠檔頭那次 SELECT):
--      a. 不可以有任何非測試商家的非 0 值(規格書 §1.1 套用程序第 2 步:「出現任何一列不是測試商家就停下來」)
--      b. 除了 ① 剛改寫的 trigger 以外,不可以有任何函式 / view 還寫著這個欄位名
--         (plpgsql 本體在 drop 時不會被檢查,漏改的函式會等到執行時才報錯)
-- =========================================================================
do $$
declare
  v_real_rows integer;
  v_refs text;
begin
  select count(*) into v_real_rows
  from public.merchant_member_settings s
  join public.merchants m on m.id = s.merchant_id
  where s.points_earn_rate <> 0
    and not (m.name ilike '%e2e%' or m.name like '%測試%');
  if v_real_rows > 0 then
    raise exception '中止:有 % 間非測試商家的 points_earn_rate 不是 0,依規格書 §1.1 不可直接 drop,請回報主腦', v_real_rows;
  end if;

  select string_agg(n.nspname || '.' || p.proname, ', ') into v_refs
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where p.prosrc ilike '%points_earn_rate%'
    and n.nspname not in ('pg_catalog', 'information_schema');
  if v_refs is not null then
    raise exception '中止:以下函式仍引用 points_earn_rate,drop 之後執行時會報錯:%', v_refs;
  end if;

  select string_agg(schemaname || '.' || viewname, ', ') into v_refs
  from pg_views
  where definition ilike '%points_earn_rate%'
    and schemaname not in ('pg_catalog', 'information_schema');
  if v_refs is not null then
    raise exception '中止:以下 view 仍引用 points_earn_rate:%', v_refs;
  end if;
end;
$$;

alter table public.merchant_member_settings drop column points_earn_rate;

-- =========================================================================
-- ③ §3.9 public.upsert_member_point_formulas(p_merchant_id, p_formulas jsonb)
--    p_formulas 是「這間商家完整的公式清單」:payload 裡沒有的既有列 → 刪除;有 id 的 → 更新;沒 id 的 → 新增。
--    三道防重複:前端下拉變灰 → 本函式白話錯誤(含項目名與衝突的公式名)→ 兩個部分唯一索引兜底。
-- =========================================================================
create or replace function public.upsert_member_point_formulas(p_merchant_id uuid, p_formulas jsonb)
returns setof public.merchant_point_formulas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_elem jsonb;
  v_idx integer := 0;
  v_id uuid;
  v_name text;
  v_enabled boolean;
  v_item uuid;
  v_min numeric;
  v_points integer;
  v_sort integer;
  v_item_name text;
  v_other_name text;
  v_clean jsonb := '[]'::jsonb;
  v_old jsonb;
begin
  if p_merchant_id is null or not private.can_manage_member_points(p_merchant_id) then
    raise exception '沒有權限修改這間商家的紅利派點公式(需要「紅利點數管理」權限)' using errcode = '42501';
  end if;

  if p_formulas is null or jsonb_typeof(p_formulas) <> 'array' then
    raise exception '公式清單格式不正確' using errcode = '22023';
  end if;
  -- 防呆上限:畫面上一條一張卡,正常商家不會超過服務項目數 + 1;擋掉惡意塞爆。
  if jsonb_array_length(p_formulas) > 500 then
    raise exception '公式數量太多(最多 500 條)' using errcode = '22023';
  end if;

  -- 同一間商家的兩次儲存排隊執行(兩個分頁同時按儲存時,第二次會看到第一次的結果再做比對)。
  perform pg_advisory_xact_lock(hashtext('upsert_member_point_formulas'), hashtext(p_merchant_id::text));

  -- 逐條驗證,通過的整理成 v_clean(jsonb 陣列);全部通過才寫入。
  for v_elem in select value from jsonb_array_elements(p_formulas)
  loop
    v_idx := v_idx + 1;
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception '第 % 條公式格式不正確', v_idx using errcode = '22023';
    end if;

    begin
      v_id := nullif(v_elem ->> 'id', '')::uuid;
      v_item := nullif(v_elem ->> 'service_item_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception '第 % 條公式的識別碼格式不正確', v_idx using errcode = '22023';
    end;

    v_name := btrim(coalesce(v_elem ->> 'name', ''));
    if char_length(v_name) < 1 or char_length(v_name) > 50 then
      raise exception '第 % 條公式的名稱要填 1~50 個字', v_idx using errcode = '22023';
    end if;

    begin
      v_enabled := coalesce((v_elem ->> 'enabled')::boolean, true);
      v_min := coalesce((v_elem ->> 'min_unit_price')::numeric, 0);
      v_points := (v_elem ->> 'points_per_unit')::integer;
      v_sort := coalesce((v_elem ->> 'sort_order')::integer, v_idx);
    exception when others then
      raise exception '公式「%」的數字欄位格式不正確', v_name using errcode = '22023';
    end;

    if v_points is null or v_points < 0 then
      raise exception '公式「%」的「每個數量獲得」要填 0 以上的整數', v_name using errcode = '22023';
    end if;
    if v_min < 0 or v_min > 99999999.99 then
      raise exception '公式「%」的單項金額門檻要填 0 以上的金額', v_name using errcode = '22023';
    end if;

    if v_item is not null and not exists (
      select 1 from public.service_items si where si.id = v_item and si.merchant_id = p_merchant_id
    ) then
      -- 不洩漏別家商家的項目是否存在:一律同一句。
      raise exception '公式「%」選的服務項目不屬於這間商家', v_name using errcode = '23514';
    end if;

    if v_id is not null then
      if exists (select 1 from jsonb_array_elements(v_clean) c where (c ->> 'id')::uuid = v_id) then
        raise exception '公式清單裡有重複的公式,請重新整理後再儲存' using errcode = '22023';
      end if;
      if not exists (
        select 1 from public.merchant_point_formulas f where f.id = v_id and f.merchant_id = p_merchant_id
      ) then
        -- 可能是別的分頁剛刪掉它,或 id 不屬於這間商家(IDOR):都不更新任何東西,同一句話。
        raise exception '公式「%」已經不存在,請重新整理後再儲存', v_name using errcode = '22023';
      end if;
    end if;

    -- 重複的服務項目(含兩條「全部服務項目」):白話錯誤,講清楚被哪一條公式設過。
    v_other_name := null;
    select c ->> 'name' into v_other_name
    from jsonb_array_elements(v_clean) c
    where (c ->> 'service_item_id')::uuid is not distinct from v_item
    limit 1;
    if v_other_name is not null then
      if v_item is null then
        v_item_name := '全部服務項目';
      else
        select si.name into v_item_name from public.service_items si where si.id = v_item;
      end if;
      raise exception '「%」已經被公式「%」設定過了,同一個服務項目只能有一條公式', v_item_name, v_other_name
        using errcode = '23505';
    end if;

    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'idx', v_idx, 'id', v_id, 'name', v_name, 'enabled', v_enabled, 'service_item_id', v_item,
      'min_unit_price', v_min, 'points_per_unit', v_points, 'sort_order', v_sort
    ));
  end loop;

  -- 寫入。先刪後寫,而且「要更新的列」也先刪掉再用原本的 id / created_at 插回:
  -- 兩條公式互換服務項目(A:項目1→項目2、B:項目2→項目1)時,逐列 UPDATE 會在中途撞到部分唯一索引,
  -- 而部分唯一索引不能設成 deferrable。merchant_point_formulas 沒有任何外鍵被別的表引用
  -- (訂單的 breakdown 只在 jsonb 裡記 formula_id 字串,不受影響),所以先刪再插是安全的。
  select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) into v_old
  from public.merchant_point_formulas f
  where f.merchant_id = p_merchant_id;

  delete from public.merchant_point_formulas f where f.merchant_id = p_merchant_id;

  insert into public.merchant_point_formulas
    (id, merchant_id, name, enabled, service_item_id, min_unit_price, points_per_unit, sort_order,
     created_at, updated_at)
  select
    coalesce(p.id, gen_random_uuid()),
    p_merchant_id,
    p.name,
    p.enabled,
    p.service_item_id,
    p.min_unit_price,
    p.points_per_unit,
    p.sort_order,
    coalesce(o.created_at, now()),
    case
      when o.id is not null
       and o.name = p.name
       and o.enabled = p.enabled
       and o.service_item_id is not distinct from p.service_item_id
       and o.min_unit_price = p.min_unit_price
       and o.points_per_unit = p.points_per_unit
       and o.sort_order = p.sort_order
      then o.updated_at
      else now()
    end
  from jsonb_to_recordset(v_clean) as p(
    idx integer, id uuid, name text, enabled boolean, service_item_id uuid,
    min_unit_price numeric(10, 2), points_per_unit integer, sort_order integer
  )
  left join jsonb_to_recordset(v_old) as o(
    id uuid, name text, enabled boolean, service_item_id uuid, min_unit_price numeric(10, 2),
    points_per_unit integer, sort_order integer, created_at timestamptz, updated_at timestamptz
  ) on o.id = p.id
  order by p.idx;

  return query
  select f.*
  from public.merchant_point_formulas f
  where f.merchant_id = p_merchant_id
  order by f.sort_order, f.created_at, f.id;
end;
$$;

comment on function public.upsert_member_point_formulas(uuid, jsonb) is '紅利系統重構 §3.9(#838):紅利點數管理頁「紅利計算」分頁的公式批次儲存。p_formulas = 這間商家完整的公式清單(每個元素 {id?, name, enabled, service_item_id|null, min_unit_price, points_per_unit, sort_order}):payload 沒有的既有列刪除、有 id 的更新(保留 created_at;值沒變時 updated_at 也不變)、沒 id 的新增。權限 private.can_manage_member_points(§2.8)。先驗證整份清單(名稱 1~50 字、點數 >= 0 整數、門檻 >= 0、服務項目必須屬於同商家(已下架也可以,保留舊公式)、id 必須是這間商家既有的公式、payload 內不可重複的服務項目 / 兩條全部服務項目 ⇒ 白話錯誤含項目名與衝突公式名),全部通過才寫入;任何一條不通過整份不寫。同一商家的儲存以 advisory lock 排隊。回傳儲存後的完整清單。';

revoke execute on function public.upsert_member_point_formulas(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_member_point_formulas(uuid, jsonb) to authenticated;

-- =========================================================================
-- ④ public.get_point_formula_service_items(p_merchant_id)
--    【為什麼多一支(規格書沒有點名,engineer 判斷,已在回報中說明)】
--    §4.2 的公式卡片要有服務項目下拉(「名稱 (NT$現價)」)、已下架標記、一句話預覽,都需要服務項目的
--    名稱與價格。但 service_items 的 SELECT 政策只放行「服務項目管理」或「訂單管理」鑰匙
--    (20260919140000)——只被開了「會員管理 + 紅利點數管理」的客服打開這頁會讀不到任何項目,
--    公式整個沒辦法設定。做法比照 #860 / 資安清單 #6 的既有模式:**不放寬 service_items 的表層政策**,
--    改開一支只回 4 個欄位(id / name / price / status)的唯讀函式,鑰匙跟公式本身同一把。
--    已下架的項目只在「目前有公式綁著它」時才回傳(要顯示「(已下架)」),其餘下架項目不回,少一個資訊面。
-- =========================================================================
create or replace function public.get_point_formula_service_items(p_merchant_id uuid)
returns table (id uuid, name text, price numeric, status text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_merchant_id is null or not private.can_manage_member_points(p_merchant_id) then
    raise exception '沒有權限查看這間商家的紅利派點設定(需要「紅利點數管理」權限)' using errcode = '42501';
  end if;

  return query
  select si.id, si.name, si.price, si.status
  from public.service_items si
  where si.merchant_id = p_merchant_id
    and (
      si.status = 'active'
      or exists (
        select 1 from public.merchant_point_formulas f
        where f.merchant_id = p_merchant_id and f.service_item_id = si.id
      )
    )
  order by (si.status = 'active') desc, si.created_at, si.id;
end;
$$;

comment on function public.get_point_formula_service_items(uuid) is '紅利系統重構 批次 6(§4.2 支援函式):紅利點數管理頁公式下拉要列的服務項目,只回 id/name/price/status 四欄。權限 private.can_manage_member_points(跟公式本身同一把鑰匙)。不放寬 service_items 的表層 SELECT 政策(那張表只給服務項目管理 / 訂單管理鑰匙)。回傳上架中的項目,加上「目前有公式綁著」的已下架項目(要標「(已下架)」);其他已下架項目不回。';

revoke execute on function public.get_point_formula_service_items(uuid) from public, anon, authenticated;
grant execute on function public.get_point_formula_service_items(uuid) to authenticated;
