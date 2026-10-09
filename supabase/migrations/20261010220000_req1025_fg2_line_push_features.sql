-- SPECS-INDEX #1025 功能開關 第 2 批(FG-2):LINE 通知、再行銷通知、手機推播通知。
-- 規格書 .project/specs/功能開關.md(第 2 版)第三節第 2 批 FG2-A01;第二節「新增功能的約定」三件事:
--   ① platform_features 加列 ② 兩個產業各加一列 industry_feature_presets ③ 既有商家每間補一列 grants(true)。
-- ⇒ 既有商家所有功能維持打開,行為完全不變(第五節第 3 點)。
--
-- 主 / 細項:line_marketing 的 parent 是 line_notifications(只允許一層,既有 trigger 會擋)。
-- 判斷規則沿用 private.merchant_has_feature(FG-1,不改):主功能關 ⇒ 細部功能一律視為關(T5),細部值保留。
-- 超級管理員畫面、批次開關、按儲存才生效、統計(platform_feature_usage_summary)都是讀 platform_features
-- 動態列出,不用改。

-- =========================================================================
-- FG2-A01 功能清單新增 3 項(文字照規格書表格,不自己改字)
-- =========================================================================
insert into public.platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled) values
  ('line_notifications', 'LINE 通知',
   '用店家的 LINE 官方帳號，把預約通知發給店家人員和客人，也包含生日禮通知。',
   '這間店不再發任何 LINE 訊息(通知店家人員、通知客人、生日禮)，商家後台看不到 LINE 相關設定與紀錄。客人用 LINE 登入會員中心不受影響。還沒發出去的通知會直接取消。',
   null, 50, true),
  ('push_notifications', '手機推播通知',
   '把預約通知推播到店家人員、服務人員的手機或瀏覽器。',
   '這間店不再發手機推播，商家後台看不到推播相關設定與紀錄。大家已經開通的裝置會保留，重新打開功能後不用重新設定。',
   null, 60, true);

insert into public.platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled) values
  ('line_marketing', '再行銷通知',
   '店家手動發優惠訊息給會員。',
   '商家後台看不到「再行銷通知」，不能發送。其他 LINE 通知照常。',
   'line_notifications', 51, true);

-- 兩個產業的預設(Q4=A:全開)。
insert into public.industry_feature_presets (industry_type, feature_key, default_enabled)
select t.industry_type, f.key, true
from (values ('on_site_dispatch'), ('in_store_beauty')) as t(industry_type)
cross join public.platform_features f
where f.key in ('line_notifications', 'line_marketing', 'push_notifications')
on conflict (industry_type, feature_key) do nothing;

-- 既有商家每間補 3 列 true;補完核對列數(不符就停下,不自動清資料)。
do $$
declare
  v_merchants integer;
  v_features integer;
  v_existing integer;
  v_rows integer;
  v_total integer;
  v_presets integer;
begin
  select count(*) into v_merchants from public.merchants;
  select count(*) into v_features from public.platform_features;
  select count(*) into v_existing
  from public.merchant_feature_grants
  where feature_key in ('line_notifications', 'line_marketing', 'push_notifications');
  raise notice '[req1025 FG2-A01] 補資料前:商家 % 間;功能清單 % 項;三個新功能已有 % 列', v_merchants, v_features, v_existing;

  insert into public.merchant_feature_grants (merchant_id, feature_key, enabled)
  select m.id, f.key, true
  from public.merchants m
  cross join public.platform_features f
  where f.key in ('line_notifications', 'line_marketing', 'push_notifications')
  on conflict (merchant_id, feature_key) do nothing;

  select count(*) into v_rows
  from public.merchant_feature_grants
  where feature_key in ('line_notifications', 'line_marketing', 'push_notifications');
  raise notice '[req1025 FG2-A01] 補資料後:三個新功能共 % 列', v_rows;
  if v_rows <> v_merchants * 3 then
    raise exception '[req1025 FG2-A01] 列數 % 不等於 商家數 % × 3，停止', v_rows, v_merchants;
  end if;

  -- 全表:商家數 × 功能數(本批後正式庫應為 463 × 10 = 4630)。
  if v_features <> 10 then
    raise exception '[req1025 FG2-A01] 功能清單應為 10 項，實際 % 項，停止', v_features;
  end if;
  select count(*) into v_total from public.merchant_feature_grants;
  raise notice '[req1025 FG2-A01] merchant_feature_grants 全表 % 列(應為 % × %)', v_total, v_merchants, v_features;
  if v_total <> v_merchants * v_features then
    raise exception '[req1025 FG2-A01] 全表列數 % 不等於 商家數 % × 功能數 %，停止', v_total, v_merchants, v_features;
  end if;

  -- 產業預設:兩產業 × 所有功能都有一列。
  select count(*) into v_presets
  from public.industry_feature_presets p
  join public.platform_features f on f.key = p.feature_key
  where p.industry_type in ('on_site_dispatch', 'in_store_beauty');
  if v_presets <> 2 * v_features then
    raise exception '[req1025 FG2-A01] 產業預設 % 列不等於 2 × %，停止', v_presets, v_features;
  end if;
end;
$$;

-- =========================================================================
-- 推播發送記錄多一種略過原因 feature_disabled(平台沒開「手機推播通知」時,Edge Function 寫這一列)
-- 原有值逐字保留。
-- =========================================================================
alter table public.push_notification_log drop constraint if exists push_notification_log_skip_reason_check;
alter table public.push_notification_log add constraint push_notification_log_skip_reason_check
  check (skip_reason is null or skip_reason in ('event_disabled', 'no_subscription', 'no_target', 'personal_disabled', 'no_recipient', 'feature_disabled'));
