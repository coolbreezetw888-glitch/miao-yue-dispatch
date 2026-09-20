-- 模組 10:會員與紅利 — 權限函式 + 三張新表 RLS + members CRUD(第二支)。
-- 對應規格書 §3.1~§3.5、§3.16。

-- =========================================================================
-- 3.1:private.can_manage_members / private.can_manage_member_settings
-- 完全比照 private.can_manage_team_leave 的既有寫法(20260919150100_scheduling_leave_functions.sql)。
-- =========================================================================
create or replace function private.can_manage_members(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'members'
        and map.granted = true
    );
$$;

comment on function private.can_manage_members(uuid) is '是否能管理該商家的會員資料(模組 10,規則 2.10):商家管理員永遠可以,或是該商家目前有效的客服且被開通 members 這個 section_key。只給 RLS 政策/SECURITY DEFINER 函式內部呼叫,不對外暴露。';

revoke execute on function private.can_manage_members(uuid) from public, anon;
grant execute on function private.can_manage_members(uuid) to authenticated;

create or replace function private.can_manage_member_settings(p_merchant_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'member_settings'
        and map.granted = true
    );
$$;

comment on function private.can_manage_member_settings(uuid) is '是否能管理該商家的會員系統設定(模組 10,規則 2.10):商家管理員永遠可以,或是該商家目前有效的客服且被開通 member_settings 這個 section_key。只給 RLS 政策內部呼叫,不對外暴露。';

revoke execute on function private.can_manage_member_settings(uuid) from public, anon;
grant execute on function private.can_manage_member_settings(uuid) to authenticated;

-- =========================================================================
-- 3.2:merchant_member_settings 讀寫。比照 merchant_payroll_settings 的既有做法,不包 RPC,
-- 直接開放 RLS SELECT/INSERT/UPDATE,前端用 upsert(on conflict (merchant_id) do update)。
-- 沒有 DELETE 政策。
-- =========================================================================
alter table public.merchant_member_settings enable row level security;

create policy merchant_member_settings_select on public.merchant_member_settings
  for select to authenticated
  using (private.can_manage_member_settings(merchant_id));

create policy merchant_member_settings_insert on public.merchant_member_settings
  for insert to authenticated
  with check (private.can_manage_member_settings(merchant_id));

create policy merchant_member_settings_update on public.merchant_member_settings
  for update to authenticated
  using (private.can_manage_member_settings(merchant_id))
  with check (private.can_manage_member_settings(merchant_id));

-- =========================================================================
-- 3.16:members / member_point_transactions 的 RLS 政策。
-- members:只有 SELECT 政策(判斷 14,RPC only)。
-- member_point_transactions:只有 SELECT 政策,直接用冗餘的 merchant_id 欄位比對(規格書 3.16
-- 建議的簡化寫法,不另外建 private.member_merchant_id 輔助函式)。
-- =========================================================================
alter table public.members enable row level security;

create policy members_select on public.members
  for select to authenticated
  using (private.can_manage_members(merchant_id));

alter table public.member_point_transactions enable row level security;

create policy member_point_transactions_select on public.member_point_transactions
  for select to authenticated
  using (private.can_manage_members(merchant_id));

-- =========================================================================
-- 3.3:create_member。SECURITY DEFINER,§0 判斷 11 的推薦碼採 8 碼英數,唯一性碰撞用迴圈重試
-- 最多 5 次(機率極低,但保留防呆)。
-- =========================================================================
create or replace function public.create_member(
  p_merchant_id uuid,
  p_name text,
  p_phone text default null,
  p_email text default null,
  p_birthday date default null,
  p_notes text default null,
  p_referred_by_member_id uuid default null
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone_required boolean;
  v_referral_code text;
  v_attempt int := 0;
  v_result public.members;
begin
  if not private.can_manage_members(p_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  select phone_required_to_create into v_phone_required
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    v_phone_required := true;
  end if;

  if v_phone_required and (p_phone is null or btrim(p_phone) = '') then
    raise exception '這個商家要求建立會員時必須填寫電話';
  end if;

  if p_referred_by_member_id is not null then
    if not exists (
      select 1 from public.members
      where id = p_referred_by_member_id
        and merchant_id = p_merchant_id
        and status = 'active'
    ) then
      raise exception '找不到指定的推薦人,或推薦人不屬於這間商家/已被下架';
    end if;
  end if;

  loop
    v_referral_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    begin
      insert into public.members (
        merchant_id, name, phone, email, birthday, notes,
        referred_by_member_id, referral_code, created_by_user_id
      ) values (
        p_merchant_id, btrim(p_name), nullif(btrim(coalesce(p_phone, '')), ''),
        nullif(btrim(coalesce(p_email, '')), ''), p_birthday, p_notes,
        p_referred_by_member_id, v_referral_code, auth.uid()
      )
      returning * into v_result;
      exit;
    exception when unique_violation then
      v_attempt := v_attempt + 1;
      if v_attempt >= 5 then
        raise exception '產生推薦碼失敗,請重新再試一次';
      end if;
    end;
  end loop;

  return v_result;
end;
$$;

comment on function public.create_member(uuid, text, text, text, date, text, uuid) is '模組 10 §3.3:建立會員。檢查 can_manage_members;電話必填與否看 merchant_member_settings.phone_required_to_create(查無資料視為必填);推薦人須同商家且 status=active(不需要檢查自我推薦,這個時間點新會員還沒有 id);推薦碼 8 碼英數,唯一性碰撞重試最多 5 次。';

revoke execute on function public.create_member(uuid, text, text, text, date, text, uuid) from public, anon;
grant execute on function public.create_member(uuid, text, text, text, date, text, uuid) to authenticated;

-- =========================================================================
-- 3.4:update_member。不允許修改 referred_by_member_id(推薦關係只在建立當下決定)。
-- =========================================================================
create or replace function public.update_member(
  p_member_id uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_birthday date,
  p_notes text
)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_phone_required boolean;
  v_result public.members;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  if p_name is null or btrim(p_name) = '' then
    raise exception '請填寫會員姓名';
  end if;

  select phone_required_to_create into v_phone_required
  from public.merchant_member_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_phone_required := true;
  end if;

  if v_phone_required and (p_phone is null or btrim(p_phone) = '') then
    raise exception '這個商家要求會員必須填寫電話';
  end if;

  update public.members set
    name = btrim(p_name),
    phone = nullif(btrim(coalesce(p_phone, '')), ''),
    email = nullif(btrim(coalesce(p_email, '')), ''),
    birthday = p_birthday,
    notes = p_notes
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.update_member(uuid, text, text, text, date, text) is '模組 10 §3.4:編輯會員基本資料。不接受修改 referred_by_member_id 這個參數(推薦關係只在建立當下決定,之後不能事後補改/移除,避免推薦獎勵追溯邏輯出現「事後補推薦人騙獎勵」的漏洞)。';

revoke execute on function public.update_member(uuid, text, text, text, date, text) from public, anon;
grant execute on function public.update_member(uuid, text, text, text, date, text) to authenticated;

-- =========================================================================
-- 3.5:deactivate_member / reactivate_member / set_member_phone_verified。
-- =========================================================================
create or replace function public.deactivate_member(p_member_id uuid)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result public.members;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  update public.members set status = 'removed' where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.deactivate_member(uuid) is '模組 10 §3.5:下架會員(軟刪除,status=removed)。規則 2.9:不算危險操作,不需要 JSON 備份,隨時可以重新上架。';

revoke execute on function public.deactivate_member(uuid) from public, anon;
grant execute on function public.deactivate_member(uuid) to authenticated;

create or replace function public.reactivate_member(p_member_id uuid)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result public.members;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  update public.members set status = 'active' where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.reactivate_member(uuid) is '模組 10 §3.5:重新上架會員(status=active)。';

revoke execute on function public.reactivate_member(uuid) from public, anon;
grant execute on function public.reactivate_member(uuid) to authenticated;

create or replace function public.set_member_phone_verified(p_member_id uuid, p_verified boolean)
returns public.members
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_result public.members;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if not found then
    raise exception '找不到這位會員';
  end if;

  if not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  update public.members set
    phone_verified = coalesce(p_verified, false),
    phone_verified_at = case when coalesce(p_verified, false) then now() else null end
  where id = p_member_id
  returning * into v_result;

  return v_result;
end;
$$;

comment on function public.set_member_phone_verified(uuid, boolean) is '模組 10 §3.5(第〇節判斷 1):這是人工標記,不是真的簡訊驗證。前端按鈕文案必須清楚寫「標記為已驗證(人工確認,非簡訊驗證)」,不能讓管理員誤以為系統真的發送/驗證過。p_verified=false 時 phone_verified_at 設回 null。';

revoke execute on function public.set_member_phone_verified(uuid, boolean) from public, anon;
grant execute on function public.set_member_phone_verified(uuid, boolean) to authenticated;
