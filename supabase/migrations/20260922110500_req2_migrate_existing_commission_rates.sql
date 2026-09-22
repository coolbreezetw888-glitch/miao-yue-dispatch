-- 商家端三項調整規格書 §二 2.10:一次性資料遷移。針對每一位按件計酬服務人員,把「他目前的
-- 有效比例」(個人覆寫優先,查無覆寫用商家預設值)套用到他目前所有「可接服務」的服務項目上,
-- 當作服務項目層級抽成的起始值。務必在 drop 舊結構之前執行。

insert into public.staff_service_commission_rates (staff_id, service_item_id, commission_mode, commission_value)
select
  mssi.staff_id,
  mssi.service_item_id,
  'percentage',
  coalesce(scr.rate_percentage, mps.default_commission_rate_percentage, 0)
from public.merchant_staff_service_items mssi
join public.merchant_staff ms on ms.id = mssi.staff_id and ms.compensation_type = 'piece_rate'
left join public.staff_commission_rates scr on scr.staff_id = mssi.staff_id
left join public.merchant_payroll_settings mps on mps.merchant_id = ms.merchant_id
on conflict (staff_id, service_item_id) do nothing;
