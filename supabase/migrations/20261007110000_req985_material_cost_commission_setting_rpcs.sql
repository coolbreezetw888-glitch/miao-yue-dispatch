-- SPECS-INDEX #985 第 8 批(規格書 .project/specs/料錢是否影響抽成開關-第8批.md 8-5 / 8-6)。
-- 「料錢影響服務人員抽成」開關搬到料錢成本管理頁。開關沿用既有欄位
-- merchant_payroll_settings.commission_basis_type(開啟 = net_of_material_cost、關閉 = gross,
-- 查無列 = gross = 關閉),不新增欄位、不改任何表層 RLS、不動計算引擎。
--
-- 為什麼要兩支 RPC:只有「料錢成本管理」鑰匙的客服讀不到 merchant_payroll_settings(表層 RLS =
-- can_manage_commission_settings),但料錢頁要顯示開關目前狀態。不放寬表層 RLS(表層會給整列),
-- 改用只回兩個布林值的讀取 RPC。寫入權限跟現在能改這個設定的人完全相同(管理員或
-- 「抽成與薪資設定」鑰匙),不擴權。

-- =========================================================================
-- 8-5 讀取
-- =========================================================================
create or replace function public.get_material_cost_commission_setting(p_merchant_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_basis text;
begin
  -- 第一步:身分與商家檢查(未登入時 auth.uid() 為 null,兩支權限函式都回 false)。
  if p_merchant_id is null
     or not (
       coalesce(private.can_manage_material_costs(p_merchant_id), false)
       or coalesce(private.can_manage_commission_settings(p_merchant_id), false)
     ) then
    raise exception '沒有權限查看這間商家的料錢設定' using errcode = '42501';
  end if;

  select mps.commission_basis_type into v_basis
  from public.merchant_payroll_settings mps
  where mps.merchant_id = p_merchant_id;

  return jsonb_build_object(
    'affects_commission', coalesce(v_basis = 'net_of_material_cost', false),
    'can_edit', coalesce(private.can_manage_commission_settings(p_merchant_id), false)
  );
end;
$$;

comment on function public.get_material_cost_commission_setting(uuid) is 'SPECS-INDEX #985 8-5:料錢成本管理頁讀取「料錢影響服務人員抽成」開關。管理員、料錢成本管理或抽成與薪資設定鑰匙可讀,其餘 42501。回傳 {affects_commission, can_edit};查無設定列視為關閉。';

revoke execute on function public.get_material_cost_commission_setting(uuid) from public, anon;
grant execute on function public.get_material_cost_commission_setting(uuid) to authenticated;

-- =========================================================================
-- 8-6 寫入
-- =========================================================================
create or replace function public.set_material_cost_affects_commission(
  p_merchant_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_basis text;
begin
  -- 第一步:權限(跟表層 RLS 同一條,不擴權)。
  if p_merchant_id is null
     or not coalesce(private.can_manage_commission_settings(p_merchant_id), false) then
    raise exception '只有商家管理員或有「抽成與薪資設定」權限的人可以修改這個開關'
      using errcode = '42501';
  end if;

  if p_enabled is null then
    raise exception '請指定要開啟或關閉' using errcode = '22023';
  end if;

  v_basis := case when p_enabled then 'net_of_material_cost' else 'gross' end;

  -- 只動 commission_basis_type,其他欄位(created_at 等)不碰。
  insert into public.merchant_payroll_settings (merchant_id, commission_basis_type)
  values (p_merchant_id, v_basis)
  on conflict (merchant_id) do update
    set commission_basis_type = excluded.commission_basis_type;

  return jsonb_build_object('affects_commission', p_enabled);
end;
$$;

comment on function public.set_material_cost_affects_commission(uuid, boolean) is 'SPECS-INDEX #985 8-6:料錢成本管理頁切換「料錢影響服務人員抽成」開關(開啟 = net_of_material_cost、關閉 = gross)。只有商家管理員或抽成與薪資設定鑰匙可寫(跟 merchant_payroll_settings 表層 RLS 相同),其餘 42501;p_enabled 為 null 拒絕。只更新 commission_basis_type。';

revoke execute on function public.set_material_cost_affects_commission(uuid, boolean) from public, anon;
grant execute on function public.set_material_cost_affects_commission(uuid, boolean) to authenticated;
