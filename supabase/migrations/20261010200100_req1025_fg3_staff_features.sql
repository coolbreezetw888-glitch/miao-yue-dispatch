-- SPECS-INDEX #1025 功能開關 第 3 批(FG-3):服務人員細部功能。
-- 規格書 .project/specs/功能開關.md(第 2 版)第三節第 3 批 FG3-A01、FG3-F01、FG3-F02(⚠️7);
-- 使用者第二輪裁決:F7 = S1~S4、F8 = 只顯示一句話 + 登出、F9 = 不自動確認(建單初始狀態不改)。
--
-- 疊加規則:服務人員實際能用 = 平台主功能(staff_portal)開 AND 平台細部功能開 AND 店家給這個人開(既有個人權限)。
-- 平台關掉時,店家給個人的設定(merchant_staff_permissions、merchant_staff 開關)一列都不改(T9),
-- 只是這裡的判斷函式回 false;平台重新打開後原設定直接恢復。
--
-- 改到內容的既有函式(以正式庫現行本體為底,只插 [req1025 FG3] 標記段):
--   private.has_own_staff_permission         (20260921100100;正式庫 6f07516e)
--   private.staff_order_self_ok              (20261007100000;正式庫 49b3dc97)
--   public.generate_own_staff_line_binding_code (20260924040900;正式庫 e4663720)
--   public.resolve_push_recipients           (20261001100000;正式庫 3feb095e)⚠️7
-- 新增:public.internal_merchant_has_feature(只給 service_role,Edge Function invite-merchant-staff 用;FG-2 沿用)。
--
-- 不改:建單初始狀態(direct_accept_after_merchant_confirm,F9)、店家後台指派 / 確認訂單、服務人員名單、
--       服務人員報表(店家看)、#876 private.staff_calendar_view_allows_notifications(LINE 看 FG-2)。

-- =========================================================================
-- FG3-A01 功能清單新增 4 項(文字照規格書表格,不自己改字)
-- =========================================================================
insert into public.platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled) values
  ('staff_portal', '服務人員登入端',
   '服務人員用自己的帳號登入，看自己的行事曆和預約明細、確認接單、看自己的個人資料。',
   '服務人員登入後只會看到「這間店目前沒有開放服務人員登入，請聯絡店家管理員。」商家後台看不到邀請登入與服務人員權限設定。店家照常可以把訂單派給服務人員，每位服務人員的權限設定會保留，重新打開後恢復。',
   null, 40, true);

insert into public.platform_features (key, name, description, off_impact, parent_key, sort_order, default_enabled) values
  ('staff_order_editing', '服務人員新增編輯訂單',
   '服務人員在自己的行事曆新增預約、拖拉改時間，編輯、取消、完成自己的訂單。',
   '服務人員只能看自己的行事曆，不能自己建單或改單。每位服務人員原本的設定會保留，重新打開後恢復。',
   'staff_portal', 41, true),
  ('staff_self_availability', '服務人員自己排休',
   '服務人員自己設定每週可預約時段，或整天、半小時排休(只限按件計酬)。',
   '服務人員看不到排休頁，不能自己改時段或排休。已經設定好的時段和休假照常有效。',
   'staff_portal', 42, true),
  ('staff_self_payroll', '服務人員查看自己的抽成薪資',
   '服務人員查自己某段期間的抽成明細或薪資扣款明細。',
   '服務人員看不到自己的抽成薪資頁。店家後台的服務人員報表照常可以看。',
   'staff_portal', 43, true);

-- 兩個產業的預設(Q4=A:全開)。
insert into public.industry_feature_presets (industry_type, feature_key, default_enabled)
select t.industry_type, f.key, true
from (values ('on_site_dispatch'), ('in_store_beauty')) as t(industry_type)
cross join public.platform_features f
where f.key in ('staff_portal', 'staff_order_editing', 'staff_self_availability', 'staff_self_payroll')
on conflict (industry_type, feature_key) do nothing;

-- 既有商家每間補 4 列 true ⇒ 既有商家行為完全不變(第五節第 3 點)。
do $$
declare
  v_merchants integer;
  v_existing integer;
  v_rows integer;
begin
  select count(*) into v_merchants from public.merchants;
  select count(*) into v_existing
  from public.merchant_feature_grants
  where feature_key in ('staff_portal', 'staff_order_editing', 'staff_self_availability', 'staff_self_payroll');
  raise notice '[req1025 FG3-A01] 補資料前:商家 % 間;四個新功能已有 % 列', v_merchants, v_existing;

  insert into public.merchant_feature_grants (merchant_id, feature_key, enabled)
  select m.id, f.key, true
  from public.merchants m
  cross join public.platform_features f
  where f.key in ('staff_portal', 'staff_order_editing', 'staff_self_availability', 'staff_self_payroll')
  on conflict (merchant_id, feature_key) do nothing;

  select count(*) into v_rows
  from public.merchant_feature_grants
  where feature_key in ('staff_portal', 'staff_order_editing', 'staff_self_availability', 'staff_self_payroll');
  raise notice '[req1025 FG3-A01] 補資料後:四個新功能共 % 列', v_rows;
  if v_rows <> v_merchants * 4 then
    raise exception '[req1025 FG3-A01] 列數 % 不等於 商家數 % × 4，停止', v_rows, v_merchants;
  end if;

  -- 全表完整性:所有商家 × 所有功能都有一列(第二節「新增功能的約定」)。
  select count(*) into v_rows
  from public.merchants m cross join public.platform_features f
  where not exists (
    select 1 from public.merchant_feature_grants g where g.merchant_id = m.id and g.feature_key = f.key
  );
  if v_rows <> 0 then
    raise exception '[req1025 FG3-A01] 還有 % 個「商家 × 功能」沒有開關列，停止', v_rows;
  end if;
end;
$$;

-- =========================================================================
-- FG3-F01 擋住點 ①:private.has_own_staff_permission
-- 原本條件 AND staff_portal AND(排休 ⇒ staff_self_availability;薪資 ⇒ staff_self_payroll)。
-- 一次涵蓋:行事曆檢視(get_my_booking_schedule)、確認接單、即時同步頻道授權、排休、薪資、個人資料編輯。
-- =========================================================================
create or replace function private.has_own_staff_permission(p_staff_id uuid, p_section_key text)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_own_staff_row(p_staff_id)
    and exists (
      select 1
      from public.merchant_staff_permissions msp
      where msp.staff_id = p_staff_id
        and msp.section_key = p_section_key
        and msp.granted = true
    )
    -- [req1025 FG3 begin] 平台功能開關:登入端 + 對應的細部功能(個人權限值不動,T9)
    and private.merchant_has_feature(private.staff_merchant_id(p_staff_id), 'staff_portal')
    and case p_section_key
          when 'staff_availability_self_manage'
            then private.merchant_has_feature(private.staff_merchant_id(p_staff_id), 'staff_self_availability')
          when 'staff_payroll_view'
            then private.merchant_has_feature(private.staff_merchant_id(p_staff_id), 'staff_self_payroll')
          else true
        end;
    -- [req1025 FG3 end]
$$;

comment on function private.has_own_staff_permission(uuid, text) is '對應規格書 3.6:private.is_own_staff_row(p_staff_id) 為真,且 merchant_staff_permissions 有一筆 staff_id=p_staff_id and section_key=p_section_key and granted=true 的紀錄,才回傳 true。SPECS-INDEX #1025 FG3-F01:另外要求這間店的平台功能「服務人員登入端」(staff_portal)開著;排休(staff_availability_self_manage)再要求 staff_self_availability、薪資(staff_payroll_view)再要求 staff_self_payroll。只給本模組內部函式呼叫,不對外暴露。';

-- ACL 不變(既有:revoke public / anon,grant authenticated —— RLS 政策會用到)。
revoke execute on function private.has_own_staff_permission(uuid, text) from public, anon;
grant execute on function private.has_own_staff_permission(uuid, text) to authenticated;

-- =========================================================================
-- FG3-F01 擋住點 ②:private.staff_order_self_ok 再 AND staff_order_editing(主功能關時自動為 false)
-- =========================================================================
create or replace function private.staff_order_self_ok(p_staff_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    private.is_own_staff_row(p_staff_id)
    and exists (
      select 1
      from public.merchant_staff ms
      where ms.id = p_staff_id
        and ms.can_create_edit_orders = true
        and ms.show_member_info = true
    )
    and private.has_own_staff_permission(p_staff_id, 'staff_calendar_view')
    -- [req1025 FG3 begin] 平台功能開關「服務人員新增編輯訂單」(細部功能;登入端關時自動為 false)
    and private.merchant_has_feature(private.staff_merchant_id(p_staff_id), 'staff_order_editing'),
    -- [req1025 FG3 end]
    false
  );
$function$;

comment on function private.staff_order_self_ok(uuid) is 'SPECS-INDEX #977 第 7 批:目前登入者是不是這位服務人員本人,而且「可以自己下單」(在職、已開通登入、can_create_edit_orders、show_member_info、行事曆檢視權限都成立)。SPECS-INDEX #1025 FG3-F01:另外要求平台功能「服務人員新增編輯訂單」(staff_order_editing)開著。';

revoke execute on function private.staff_order_self_ok(uuid) from public, anon, authenticated;

-- =========================================================================
-- FG3-F01 擋住點 ③:public.generate_own_staff_line_binding_code
-- staff_portal 關 ⇒ 42501「這個功能目前沒有開放。」(店家管理員幫服務人員產生綁定碼的既有路徑不擋)。
-- 檢查放在「是不是本人」之後:不是這間店服務人員的人仍然拿到原本那句,不透露這間店的開關狀態。
-- =========================================================================
create or replace function public.generate_own_staff_line_binding_code(p_merchant_id uuid)
returns table (code text, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_id uuid;
begin
  -- 「在職(status)且已開通登入(login_status)」這組條件跟 private.is_merchant_staff 完全一致
  -- (也就是模組 14 所有自助功能認定的「能用服務人員端的人」)。這裡不呼叫那支函式而是直接
  -- 查詢,單純因為下一步需要那一列的 id,不是另立一套判斷標準。
  -- merchant_staff 有 (merchant_id, user_id) where status = 'active' 的唯一索引
  -- (merchant_staff_merchant_user_unique),所以這個查詢最多只會有一列。
  select id into v_staff_id
  from public.merchant_staff
  where merchant_id = p_merchant_id
    and user_id = auth.uid()
    and status = 'active'
    and login_status = 'active';

  if v_staff_id is null then
    raise exception '你不是這間商家目前在職、且已開通登入的服務人員' using errcode = '42501';
  end if;

  -- [req1025 FG3 begin] 平台功能開關「服務人員登入端」
  if not private.merchant_has_feature(p_merchant_id, 'staff_portal') then
    raise exception '這個功能目前沒有開放。' using errcode = '42501', hint = 'feature_disabled';
  end if;
  -- [req1025 FG3 end]

  return query select * from private.issue_line_binding_code(p_merchant_id, 'staff', v_staff_id, auth.uid());
end;
$$;

comment on function public.generate_own_staff_line_binding_code(uuid) is '2026-09-24 使用者裁決「要讓服務人員自己綁定」:在職且已開通登入的服務人員幫自己產生 LINE 綁定碼。刻意只收 p_merchant_id、由函式內部用 auth.uid() 解析出自己的 merchant_staff.id,前端無法指定別人(避免「幫別人產生綁定碼」造成的通知收件人劫持)。綁定碼規則(6 碼/10 分鐘/舊碼失效)共用 private.issue_line_binding_code,跟 3.6 完全一致。SPECS-INDEX #1025 FG3-F01:這間店的平台功能「服務人員登入端」關掉時 42501「這個功能目前沒有開放。」(hint feature_disabled)。';

-- ACL 不變(create or replace 保留既有 ACL;這裡重寫一次 revoke 防止之後被誤開)。
revoke execute on function public.generate_own_staff_line_binding_code(uuid) from public, anon;
grant  execute on function public.generate_own_staff_line_binding_code(uuid) to authenticated;

-- =========================================================================
-- FG3-F02 ⚠️7 推播收件人:服務人員分支再 AND staff_portal;管理員 / 客服分支逐字不變。LINE 不改。
-- =========================================================================
create or replace function public.resolve_push_recipients(
  p_merchant_id uuid,
  p_event_type text,
  p_booking_staff_id uuid
)
returns table (
  target_type text,
  target_id uuid,
  target_user_id uuid,
  target_name text
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select 'staff'::text, s.id, s.user_id, coalesce(nullif(trim(s.name), ''), '服務人員')
  from public.push_event_subscriptions pes
  join public.merchant_staff s on s.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'staff'
    and pes.event_type = p_event_type
    and pes.enabled
    and p_booking_staff_id is not null
    and s.id = p_booking_staff_id
    and s.merchant_id = p_merchant_id
    and s.status = 'active'
    and s.login_status = 'active'
    and s.user_id is not null
    and private.staff_calendar_view_allows_notifications(s.id)
    -- [req1025 FG3 begin] ⚠️7 服務人員登入端關掉時不推播給這間店的服務人員
    and private.merchant_has_feature(p_merchant_id, 'staff_portal')
    -- [req1025 FG3 end]

  union all

  select 'admin'::text, a.id, a.user_id, coalesce(nullif(trim(a.display_name), ''), '商家管理員')
  from public.push_event_subscriptions pes
  join public.merchant_admins a on a.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'admin'
    and pes.event_type = p_event_type
    and pes.enabled
    and a.merchant_id = p_merchant_id
    and a.user_id is not null

  union all

  select 'agent'::text, g.id, g.user_id, coalesce(nullif(trim(g.name), ''), '客服')
  from public.push_event_subscriptions pes
  join public.merchant_agents g on g.id = pes.target_id
  where pes.merchant_id = p_merchant_id
    and pes.target_type = 'agent'
    and pes.event_type = p_event_type
    and pes.enabled
    and g.merchant_id = p_merchant_id
    and g.status = 'active'
    and g.user_id is not null;
$$;

comment on function public.resolve_push_recipients(uuid, text, uuid) is '§5.1:回傳這個事件的收件人清單(target_type/target_id/target_user_id/target_name)。兩支 Edge Function 共用,不在 TypeScript 裡各自拼 SQL。刻意不去重 —— 同一個 target_user_id 可能因為多重身份出現多次,去重發生在裝置層(§4.3),因為 log 要一個身份一列。SPECS-INDEX #876:服務人員分支另外要求「行事曆檢視」是開的(private.staff_calendar_view_allows_notifications),關掉就不推播、也不進站內鈴鐺。SPECS-INDEX #1025 ⚠️7:服務人員分支另外要求這間店的平台功能「服務人員登入端」開著。只有 service role 能呼叫。';

revoke execute on function public.resolve_push_recipients(uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_push_recipients(uuid, text, uuid) to service_role;

-- =========================================================================
-- public.internal_merchant_has_feature:給 Edge Function(service role)用的包裝(FG2-F01 定義,FG-3 先建立)
-- =========================================================================
create or replace function public.internal_merchant_has_feature(p_merchant_id uuid, p_feature_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.merchant_has_feature(p_merchant_id, p_feature_key);
$$;

comment on function public.internal_merchant_has_feature(uuid, text) is
  'SPECS-INDEX #1025(FG2-F01 定義,FG3 先建立):Edge Function 用 service role 查「這間商家有沒有這個平台功能」,內容只呼叫 private.merchant_has_feature。只給 service_role(anon / authenticated 都不能執行)。';

revoke execute on function public.internal_merchant_has_feature(uuid, text) from public, anon, authenticated;
grant execute on function public.internal_merchant_has_feature(uuid, text) to service_role;
