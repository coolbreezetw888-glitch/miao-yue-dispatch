-- 模組 2:超級管理員/平台管理後台(核心層)
-- 對應規格書規則 2.1 / 功能 3.7(RLS 政策疊加，讓超級管理員無視模組 1 的權限限制)、
-- 功能 3.8(industry_feature_presets 的寫入政策，新增，非疊加)。

-- =========================================================================
-- 3.7 疊加 OR private.is_platform_admin()，政策名稱、數量都不變，只是判斷式多一個 OR 分支。
-- 完全沿用模組 1 規格書 3.6 自己預留的「刻意設計成方便疊加」的擴充口，不是繞過 RLS 另開後門。
-- 刻意只疊加這三條(groups_select、merchants_select、merchants_update)——不疊加
-- merchant_admins/merchant_feature_flags 的政策(見規則 2.3：新增/移除管理員走
-- platform_add_merchant_admin/platform_remove_merchant_admin 這兩個 SECURITY DEFINER 函式，
-- 不需要也不應該開放超級管理員直接對 merchant_admins 表做 RLS 層級的讀寫)。
-- =========================================================================
alter policy groups_select on public.groups
  using (private.is_group_member(id) or private.is_platform_admin());

alter policy merchants_select on public.merchants
  using (private.is_merchant_admin(id) or private.is_platform_admin());

alter policy merchants_update on public.merchants
  using (private.is_merchant_admin(id) or private.is_platform_admin())
  with check (private.is_merchant_admin(id) or private.is_platform_admin());

-- =========================================================================
-- 3.8 industry_feature_presets 的寫入政策(新增，非疊加)
-- 現況只有一條開放給所有登入者的 SELECT 政策(industry_feature_presets_select，見模組 1
-- migration 20260915110000_merchant_private_schema_hardening.sql)。這裡新增三條，
-- 限定 is_platform_admin() 才能寫入/刪除。
-- =========================================================================
create policy industry_feature_presets_insert_platform_admin
  on public.industry_feature_presets
  for insert
  to authenticated
  with check (private.is_platform_admin());

create policy industry_feature_presets_update_platform_admin
  on public.industry_feature_presets
  for update
  to authenticated
  using (private.is_platform_admin())
  with check (private.is_platform_admin());

create policy industry_feature_presets_delete_platform_admin
  on public.industry_feature_presets
  for delete
  to authenticated
  using (private.is_platform_admin());
