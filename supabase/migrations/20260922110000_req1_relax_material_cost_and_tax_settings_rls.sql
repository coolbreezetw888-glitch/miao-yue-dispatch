-- 商家端三項調整規格書 §一 1.3:料錢成本功能開關/稅金設定搬家後,寫入權限跟著新頁面的權限走。

-- 1. merchant_feature_flags:UPDATE/INSERT 政策,針對 feature_key = 'material_cost_enabled'
--    這一列額外放行 can_manage_material_costs,不放寬整張表(避免連帶取得修改
--    strict_conflict_check 開關的能力)。SELECT 政策整張表放寬(這張表沒有敏感資料)。
drop policy if exists merchant_feature_flags_update on public.merchant_feature_flags;
create policy merchant_feature_flags_update on public.merchant_feature_flags
  for update to authenticated
  using (
    private.can_manage_business_hours(merchant_id)
    or (feature_key = 'material_cost_enabled' and private.can_manage_material_costs(merchant_id))
  )
  with check (
    private.can_manage_business_hours(merchant_id)
    or (feature_key = 'material_cost_enabled' and private.can_manage_material_costs(merchant_id))
  );

drop policy if exists merchant_feature_flags_insert on public.merchant_feature_flags;
create policy merchant_feature_flags_insert on public.merchant_feature_flags
  for insert to authenticated
  with check (
    private.can_manage_business_hours(merchant_id)
    or (feature_key = 'material_cost_enabled' and private.can_manage_material_costs(merchant_id))
  );

drop policy if exists merchant_feature_flags_select on public.merchant_feature_flags;
create policy merchant_feature_flags_select on public.merchant_feature_flags
  for select to authenticated
  using (
    private.can_manage_bookings(merchant_id)
    or private.can_manage_business_hours(merchant_id)
    or private.can_manage_material_costs(merchant_id)
  );

-- 2. merchant_tax_settings:整張表的 SELECT/INSERT/UPDATE 一併放行 can_manage_payment_methods。
drop policy if exists merchant_tax_settings_select on public.merchant_tax_settings;
create policy merchant_tax_settings_select on public.merchant_tax_settings
  for select to authenticated
  using (
    private.can_manage_business_hours(merchant_id)
    or private.can_manage_payment_methods(merchant_id)
  );

drop policy if exists merchant_tax_settings_insert on public.merchant_tax_settings;
create policy merchant_tax_settings_insert on public.merchant_tax_settings
  for insert to authenticated
  with check (
    private.can_manage_business_hours(merchant_id)
    or private.can_manage_payment_methods(merchant_id)
  );

drop policy if exists merchant_tax_settings_update on public.merchant_tax_settings;
create policy merchant_tax_settings_update on public.merchant_tax_settings
  for update to authenticated
  using (
    private.can_manage_business_hours(merchant_id)
    or private.can_manage_payment_methods(merchant_id)
  )
  with check (
    private.can_manage_business_hours(merchant_id)
    or private.can_manage_payment_methods(merchant_id)
  );
