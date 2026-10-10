-- SPECS-INDEX #1051 全面體檢修正(H1-01、H1-02、H1-03、H1-06、H1-08、H1-09、H1-12):權限收緊與整理。
--
-- 背景:Supabase 預設讓 postgres 在 public 建的每張表/序列自動給 anon、authenticated 全部表層權限,
-- 每支新函式自動給 PUBLIC/anon EXECUTE。資料一直由 RLS 與函式內檢查保護;這支把表層權限與預設值
-- 一併收緊,讓之後新增的物件預設就是關的。
--
-- 對外刻意開放給未登入訪客(anon)的只有 3 支 RPC(皆 SECURITY DEFINER、函式內有頻率限制),
-- 收緊後仍可執行:get_public_booking_page、get_public_available_slots、customer_peek_contact_invite。

-- =====================================================================
-- H1-01 表層權限
-- =====================================================================
-- ① anon:public / private 所有表、序列一律收回(anon 只走上面 3 支 RPC,不直接讀寫任何表)。
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all tables in schema private from anon;
revoke all on all sequences in schema private from anon;

-- ② authenticated:TRUNCATE / REFERENCES / TRIGGER 用不到,收回(讀寫仍由 RLS policy 決定)。
revoke truncate, references, trigger on all tables in schema public from authenticated;
revoke truncate, references, trigger on all tables in schema private from authenticated;

-- ③ RLS 開啟、0 條 policy、只由 SECURITY DEFINER 函式 / service_role 讀寫的 4 張表:authenticated 一起收回
--    (前端與 security invoker 函式都不直接讀寫這 4 張表)。
revoke all on table public.merchant_line_configs from authenticated;
revoke all on table public.line_binding_codes from authenticated;
revoke all on table public.line_webhook_events from authenticated;
revoke all on table public.push_reminder_dedupe_log from authenticated;

-- ④ 預設權限:postgres 之後在 public 建的表/序列不再自動給 anon;函式不再自動給 PUBLIC/anon EXECUTE。
--    (新函式若要給 anon,一律在該支 migration 明確 grant。authenticated / service_role 的預設不變。)
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres revoke execute on functions from public;

--    supabase_admin 建的物件:只有 supabase_admin 的成員能改它的預設權限。本專案的 migration 角色
--    (postgres)不是成員 ⇒ 跳過並留下 notice(public schema 的物件都由本專案 migration 以 postgres 建立)。
do $$
begin
  if pg_has_role(current_user, 'supabase_admin', 'MEMBER') then
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
    execute 'alter default privileges for role supabase_admin in schema public revoke execute on functions from anon';
    execute 'alter default privileges for role supabase_admin revoke execute on functions from public';
  else
    raise notice '#1051:目前角色 % 不是 supabase_admin 成員,supabase_admin 的預設權限維持原狀', current_user;
  end if;
end;
$$;

-- ⑤ public 裡 3 支不讀資料的 security invoker 小函式(trigger / 字串解析),anon 用不到,一併收回。
--    authenticated 保留(storage 寫入 policy 會用到 storage_path_*)。
revoke execute on function public.set_updated_at() from public, anon;
revoke execute on function public.storage_path_merchant_id(text) from public, anon;
revoke execute on function public.storage_path_self_staff_id(text) from public, anon;

-- =====================================================================
-- H1-02 trigger 函式不需要讓任何人直接呼叫
-- =====================================================================
revoke execute on function public.prevent_disable_last_active_merchant() from public, anon, authenticated;

-- =====================================================================
-- H1-03 private schema 函式 EXECUTE
-- =====================================================================
-- private 不對外開放;函式一律由 SECURITY DEFINER 函式(以 owner 身分)呼叫,不需要對 PUBLIC/anon/
-- authenticated 開放。唯一例外:RLS policy(含 storage.objects、realtime.messages)在查詢者身分下
-- 直接呼叫的判斷函式,authenticated 必須能執行 ⇒ 只對下列名單重新 grant。
-- (trigger 觸發時不檢查 EXECUTE;security invoker 的呼叫鏈已在正式庫逐支確認不會以
--  authenticated 身分呼叫到 private 函式。)
revoke execute on all functions in schema private from public, anon, authenticated;

do $$
declare
  r record;
  v_keep text[] := array[
    'booking_merchant_id',
    'can_listen_merchant_calendar_topic',
    'can_listen_staff_schedule_topic',
    'can_manage_bookings',
    'can_manage_business_hours',
    'can_manage_commission_settings',
    'can_manage_line_notification',
    'can_manage_material_costs',
    'can_manage_member_points',
    'can_manage_member_settings',
    'can_manage_members',
    'can_manage_payment_methods',
    'can_manage_push_notification',
    'can_manage_service_items',
    'can_manage_staff',
    'can_manage_team_leave',
    'can_self_manage_availability',
    'can_send_line_marketing',
    'can_view_payroll_reports',
    'is_group_member',
    'is_merchant_admin',
    'is_merchant_agent',
    'is_merchant_staff',
    'is_own_staff_row',
    'is_platform_admin',
    'owns_push_target',
    'staff_compensation_type',
    'staff_merchant_id'
  ];
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = any (v_keep)
  loop
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end;
$$;

-- =====================================================================
-- H1-06 公開圖片 bucket 收掉「任何人都能列出全部檔案」的 SELECT policy
-- =====================================================================
-- 公開 bucket 用公開網址讀圖不經過 RLS,所以這兩條拿掉後圖片照樣顯示。
drop policy if exists merchant_logos_public_read on storage.objects;
drop policy if exists staff_avatars_public_read on storage.objects;

-- 前端上傳用 upload(..., { upsert: true }):Storage 的 upsert 需要對該檔案有 SELECT 權限
-- (本機實測:拿掉上面兩條、沒有替代時,上傳回「new row violates row-level security policy」)。
-- ⇒ 補上「只看得到自己有權寫入的檔案」的 SELECT policy,條件與既有 insert/update/delete policy 一致:
--    商家管理員 ⇒ 自己店的 LOGO / 服務人員頭像;服務人員本人 ⇒ 自己 self/<staff_id>/ 底下的頭像。
--    未登入訪客與其他店一律看不到(列不出檔名)。
create policy merchant_logos_admin_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'merchant-logos'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

create policy staff_avatars_admin_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'staff-avatars'
    and private.is_merchant_admin(public.storage_path_merchant_id(name))
  );

create policy staff_avatars_self_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'staff-avatars'
    and (storage.foldername(name))[2] = 'self'
    and private.is_own_staff_row(public.storage_path_self_staff_id(name))
    and exists (
      select 1
      from public.merchant_staff ms
      where ms.id = public.storage_path_self_staff_id(objects.name)
        and ms.merchant_id = public.storage_path_merchant_id(objects.name)
    )
  );

-- =====================================================================
-- H1-08 未使用的平台批次清除函式
-- =====================================================================
drop function if exists public.platform_purge_merchant_members_and_points(uuid);

-- =====================================================================
-- H1-09 店家報表依 merchant_id 篩選薪資歷史
-- =====================================================================
create index if not exists staff_payroll_status_history_merchant_comp_idx
  on public.staff_payroll_status_history (merchant_id, compensation_type);

-- =====================================================================
-- H1-12 舊版單月帳務報表函式(已由 get_merchant_billing_summary_by_range 取代,前端沒有呼叫)
-- =====================================================================
drop function if exists public.get_merchant_billing_summary(uuid, integer, integer);
