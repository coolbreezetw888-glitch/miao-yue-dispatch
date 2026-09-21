-- 對應規格書 .project/specs/帳號登入安全性優化.md 第二節(問題 2:登入信箱變更機制)。
--
-- 2.2.1/2.2.2:merchant_staff/merchant_agents 各自新增三個「管理員建議的新登入信箱」欄位。
-- 這三個欄位純粹是「建議紀錄」,不是登入 email 本身(規則 2.3.1)——真正的登入 email 永遠即時查
-- auth.users,不會有兩份互相打架的「目前 email」定義(判斷 3)。
--
-- merchant_agents 目前完全沒有給 authenticated 的 UPDATE RLS 政策(唯一一條政策是
-- merchant_agents_select),所以前端本來就不可能直接 .update() 這張表的任何欄位,新增這三欄不需要
-- 額外保護,一律只能透過本次新增的 SECURITY DEFINER 函式(下一支 migration)寫入。
--
-- merchant_staff 則不同——既有 merchant_staff_update 政策讓商家管理員可以直接 .update() 整列
-- (既有的 UpsertMerchantStaffInput 欄位就是這樣寫入的),如果不額外處理,前端理論上可以繞過
-- request_staff_login_email_change() 的驗證(在職狀態檢查、email 格式檢查),直接用一般的
-- supabase.from('merchant_staff').update(...) 把這三個敏感欄位改成任意值。這裡比照既有
-- private.protect_merchant_staff_line_binding_columns() 這支「BEFORE UPDATE 觸發器 + transaction
-- 層級旗標放行」的既有模式,新增一支同類型的觸發器,擋下對這三個新欄位的直接改動,只留一條後門給
-- 下一支 migration 的 request_staff_login_email_change/clear_staff_pending_login_email 函式呼叫前
-- 打開的 transaction-local 旗標。

alter table public.merchant_staff
  add column pending_admin_login_email text,
  add column pending_admin_login_email_requested_by uuid references auth.users(id) on delete set null,
  add column pending_admin_login_email_requested_at timestamptz;

comment on column public.merchant_staff.pending_admin_login_email is '對應規格書 2.2.1:商家管理員建議的新登入信箱,本人還沒按「套用」。純粹是建議紀錄,不是登入 email 本身(登入 email 一律即時查 auth.users)。只能透過 request_staff_login_email_change/clear_staff_pending_login_email 寫入,見同名觸發器 merchant_staff_protect_pending_login_email_columns。';
comment on column public.merchant_staff.pending_admin_login_email_requested_by is '對應規格書 2.2.1:是哪位管理員建議的。';
comment on column public.merchant_staff.pending_admin_login_email_requested_at is '對應規格書 2.2.1:建議的時間。';

alter table public.merchant_agents
  add column pending_admin_login_email text,
  add column pending_admin_login_email_requested_by uuid references auth.users(id) on delete set null,
  add column pending_admin_login_email_requested_at timestamptz;

comment on column public.merchant_agents.pending_admin_login_email is '對應規格書 2.2.2:比照 merchant_staff.pending_admin_login_email,設計理由完全相同。merchant_agents 沒有給 authenticated 的 UPDATE RLS 政策,前端本來就無法直接 .update() 這張表,不需要額外的觸發器保護。';
comment on column public.merchant_agents.pending_admin_login_email_requested_by is '對應規格書 2.2.2:是哪位管理員建議的。';
comment on column public.merchant_agents.pending_admin_login_email_requested_at is '對應規格書 2.2.2:建議的時間。';

-- =========================================================================
-- merchant_staff 專用的欄位保護觸發器,完全比照既有
-- private.protect_merchant_staff_line_binding_columns() 的寫法(同一個 codebase 一貫的「敏感欄位
-- 只能透過 SECURITY DEFINER 函式寫入」既有模式,見 .project/specs/帳號登入安全性優化.md §2.2.1
-- 邊界情況)。旗標名稱刻意跟 line_notifications.bypass_staff_binding_guard 分開,避免兩組互相干擾。
-- =========================================================================
create or replace function private.protect_merchant_staff_pending_login_email_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if (new.pending_admin_login_email is distinct from old.pending_admin_login_email
      or new.pending_admin_login_email_requested_by is distinct from old.pending_admin_login_email_requested_by
      or new.pending_admin_login_email_requested_at is distinct from old.pending_admin_login_email_requested_at)
     and auth.role() <> 'service_role'
     and coalesce(current_setting('staff_agent.bypass_pending_login_email_guard', true), 'off') <> 'on'
  then
    raise exception '不能透過一般編輯直接變更登入信箱建議,請透過「修改登入信箱」的功能操作'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.protect_merchant_staff_pending_login_email_columns() is '對應規格書 2.2.1 邊界情況:擋下對 merchant_staff 三個 pending_admin_login_email* 欄位的直接 UPDATE,只放行 service_role 或已設定 staff_agent.bypass_pending_login_email_guard 旗標(request_staff_login_email_change/clear_staff_pending_login_email 專用)的呼叫。';

create trigger merchant_staff_protect_pending_login_email_columns
  before update on public.merchant_staff
  for each row execute function private.protect_merchant_staff_pending_login_email_columns();

-- =========================================================================
-- private.is_own_agent_row(p_agent_id):比照既有 private.is_own_staff_row(p_staff_id) 的寫法,
-- 給 clear_agent_pending_login_email 判斷「本人」使用(下一支 migration)。
-- =========================================================================
create or replace function private.is_own_agent_row(p_agent_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.merchant_agents ma
    where ma.id = p_agent_id
      and ma.user_id = auth.uid()
      and ma.status = 'active'
  );
$$;

comment on function private.is_own_agent_row(uuid) is '比照既有 private.is_own_staff_row(p_staff_id):回傳指定客服紀錄是不是目前登入者本人、且該客服目前是 status=''active''。供 clear_agent_pending_login_email 判斷「本人操作」使用。';
