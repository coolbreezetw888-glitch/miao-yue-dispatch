-- 商家端三項調整規格書 §二 2.7.6。

-- staff_service_commission_rates:SELECT/INSERT/UPDATE/DELETE 要求
-- can_manage_commission_settings(該服務人員所屬 merchant_id)。INSERT/UPDATE 額外 WITH CHECK
-- 要求 compensation_type='piece_rate'(比照原 staff_commission_rates 既有寫法)。
create policy staff_service_commission_rates_select on public.staff_service_commission_rates
  for select to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and private.can_manage_commission_settings(ms.merchant_id)
    )
  );

create policy staff_service_commission_rates_insert on public.staff_service_commission_rates
  for insert to authenticated
  with check (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and ms.compensation_type = 'piece_rate'
        and private.can_manage_commission_settings(ms.merchant_id)
    )
  );

create policy staff_service_commission_rates_update on public.staff_service_commission_rates
  for update to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and private.can_manage_commission_settings(ms.merchant_id)
    )
  )
  with check (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and ms.compensation_type = 'piece_rate'
        and private.can_manage_commission_settings(ms.merchant_id)
    )
  );

create policy staff_service_commission_rates_delete on public.staff_service_commission_rates
  for delete to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = staff_id
        and private.can_manage_commission_settings(ms.merchant_id)
    )
  );

-- booking_commission_item_records:只有 SELECT 政策,要求 can_view_payroll_reports(merchant_id)
-- (透過 join booking_commission_records.merchant_id)。沒有 INSERT/UPDATE/DELETE 政策
-- (一律透過 compute_booking_commission/recalculate_booking_commission 內部寫入)。
create policy booking_commission_item_records_select on public.booking_commission_item_records
  for select to authenticated
  using (
    exists (
      select 1 from public.booking_commission_records bcr
      where bcr.id = commission_record_id
        and private.can_view_payroll_reports(bcr.merchant_id)
    )
  );
