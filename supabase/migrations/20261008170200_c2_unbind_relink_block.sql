-- 客戶端第 2 批(模組 13)— migration 3:店家解除 LINE 綁定後,被解除的客戶帳號不能自動接回
-- 主腦複查 2026-10-08(使用者同意的第三道保險「店家解除後，接錯的人會被登出」必須真的有效)。
-- 前提:20261008170000、20261008170100 已套用。這支沒有任何既有資料的寫入或刪除。
--
-- 規則:
--   ・店家在會員詳細頁「解除 LINE 綁定」(unbind_line_account 的 member 分支)時,若那位會員有接上客戶帳號,
--     把「(會員, 客戶帳號)」記進 customer_member_link_blocks。
--   ・同一個客戶帳號之後再填同一支電話 ⇒ customer_complete_profile 回 phone_taken(不帶任何會員資料)。
--   ・別的 LINE 帳號(不同 user_id)填這支電話 ⇒ 照常直接接上。
--   ・店家撤銷:public.allow_member_customer_relink(p_member_id)(會員詳細頁「允許重新接上」按鈕),
--     權限 = can_manage_members。get_member_customer_login_status 多回 relink_blocked 讓畫面決定要不要顯示按鈕。
--   ⚠️ 沒有選「重新用綁定碼綁定就撤銷」:那要改 consume_line_binding_code 本體,它在規格 J03「指紋不能變」清單裡。
--
-- 改前指紋(本機,= 20261008170100 套用後):
--   public.unbind_line_account               cc2ebc651ba96df0ff125e2d76c83113
--   public.customer_complete_profile         34c044b19dc849285a0ff7d353700935
--   private.link_customer_to_member          d122833e26aa45bc73bedd52d4583078
--   public.get_member_customer_login_status  8e5262b07a067c9b270c2f12b695c806

-- =========================================================================
-- 封鎖表
-- =========================================================================
create table public.customer_member_link_blocks (
  member_id uuid not null references public.members(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  created_by_user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (member_id, user_id)
);
comment on table public.customer_member_link_blocks is 'C2(主腦複查):店家解除會員 LINE 綁定時,被解除的客戶帳號不能再自動接回這位會員。customer_complete_profile 遇到就回 phone_taken。店家用 allow_member_customer_relink 撤銷。不建 RLS policy、表層權限收掉。';
alter table public.customer_member_link_blocks enable row level security;
revoke all on table public.customer_member_link_blocks from anon, authenticated;

-- =========================================================================
-- unbind_line_account:member 分支多寫封鎖(其餘逐字不變)
-- =========================================================================
create or replace function public.unbind_line_account(p_target_type text, p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_merchant_id uuid;
  v_self_user_id uuid;
begin
  if p_target_type not in ('admin', 'agent', 'staff', 'member') then
    raise exception '不支援的綁定目標類型：%', p_target_type;
  end if;

  if p_target_type = 'admin' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_admins where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位管理員';
    end if;
    -- ⚠️ 三值邏輯防禦(三個分支寫法刻意完全一致,見 20260924040900 檔頭§「順帶修掉的既有漏洞」):
    --    裸寫 `or v_self_user_id = auth.uid()` 在兩邊都是 NULL 時,該比較的結果是 NULL,
    --    `not (false or NULL)` = NULL,而 `if NULL then` 不成立 → raise 不會觸發、權限檢查被靜默
    --    跳過。不要因為覺得囉唆而把這兩個 is not null 簡化掉。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_admins set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'agent' then
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_agents where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位客服';
    end if;
    -- ⚠️ 三值邏輯防禦 —— 這一條是真的在修一個既有漏洞:merchant_agents.user_id 是 nullable
    --    (login 尚未註冊的「已邀請」客服就是 NULL)。不要簡化掉這兩個 is not null。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '沒有權限解除這個 LINE 綁定' using errcode = '42501';
    end if;
    update public.merchant_agents set line_user_id = null, line_bound = false where id = p_target_id;

  elsif p_target_type = 'staff' then
    -- 2026-09-24 放寬(使用者裁決「要讓服務人員自己綁定」):原本只允許 private.is_merchant_admin,
    -- 現在加上「本人」。「本人」一律用 auth.uid() 對照 merchant_staff.user_id 判斷,
    -- 完全不信任前端傳來的任何 id —— 前端只能指定「要解除哪一列」,而那一列必須是它自己。
    select merchant_id, user_id into v_merchant_id, v_self_user_id
    from public.merchant_staff where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位服務人員';
    end if;

    -- ⚠️ 三值邏輯防禦 —— merchant_staff.user_id 是 nullable(login_status = 'not_invited' 的人
    --    還沒有登入帳號)。不要簡化掉這兩個 is not null。
    if not (
      private.is_merchant_admin(v_merchant_id)
      or (v_self_user_id is not null and auth.uid() is not null and v_self_user_id = auth.uid())
    ) then
      raise exception '只有商家管理員或這位服務人員本人可以解除這個 LINE 綁定' using errcode = '42501';
    end if;

    -- 已經完成權限檢查(管理員 or 本人),這是規則 2.9 觸發器
    -- private.protect_merchant_staff_line_binding_columns 明確允許的合法例外路徑。
    -- 旗標是 transaction-local(set_config 第三參數 true),交易結束就自動失效。
    perform set_config('line_notifications.bypass_staff_binding_guard', 'on', true);
    update public.merchant_staff set line_user_id = null, line_bound = false where id = p_target_id;
    perform set_config('line_notifications.bypass_staff_binding_guard', 'off', true);

  elsif p_target_type = 'member' then
    select merchant_id into v_merchant_id from public.members where id = p_target_id;

    if v_merchant_id is null then
      raise exception '找不到這位會員';
    end if;
    if not private.can_manage_members(v_merchant_id) then
      raise exception '沒有權限管理這位會員' using errcode = '42501';
    end if;
    -- SPECS-INDEX #910(2026-09-30,使用者裁決 Q2 = (B) 附帶限制):
    --   ・identity_verified_at / identity_verified_via **清成 null** ⇒ 綁定狀態歸零,
    --     名單上變回「尚未驗證」(2026-10-01 修正用詞,舊標籤是「已建立(未綁定)」;狀態名稱
    --     裡不可以有「綁定」二字,文案唯一來源是 memberIdentityStatus.ts),綁定之後才能觸發的
    --     功能(再行銷通知等)碰不到他。
    --   ・🔴 identity_first_verified_at **刻意不寫進這句 UPDATE** ⇒ 第一次完成驗證的時間永久保留。
    --     使用者原話:「如果真的解除綁定,會員資料、紀錄、加入時間也不該清除(僅是綁定狀態
    --     變回未綁定)」。不要「順手」把它一起清掉 —— 那會讓第二次解除綁定時這個時間永久弄丟。
    --   ・會員本人、訂單紀錄、點數餘額、分類帳全部不動,一筆都不刪。
    --   ・[c2] C2-H02(使用者 Q3):同時清 user_id ⇒ 客戶端 LINE 登入一起斷開,客人下次登入要重新填電話。
    --   ・[c2-relink] 被解除的客戶帳號記進封鎖表 ⇒ 這個帳號之後填同一支電話不會自動接回(回 phone_taken);
    --     別的 LINE 帳號照常可以接上。店家用 allow_member_customer_relink 撤銷。
    insert into public.customer_member_link_blocks (member_id, user_id, merchant_id, created_by_user_id)
    select m.id, m.user_id, m.merchant_id, auth.uid()
    from public.members m
    where m.id = p_target_id and m.user_id is not null
    on conflict (member_id, user_id) do nothing;
    update public.members
    set line_user_id = null,
        line_bound = false,
        identity_verified_at = null,
        identity_verified_via = null,
        user_id = null
    where id = p_target_id;
  end if;
end;
$function$;

-- =========================================================================
-- customer_complete_profile:被封鎖的帳號 ⇒ phone_taken(其餘逐字不變)
-- =========================================================================
create or replace function public.customer_complete_profile(p_slug text, p_phone text, p_name text, p_agree_policy boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_merchant public.merchants;
  v_cfg public.merchant_line_login_configs;
  v_ident public.customer_line_identities;
  v_linked public.members;
  v_member public.members;
  v_new public.members;
  v_phone text;
  v_name text;
  v_policy_enabled boolean := false;
  v_policy_hash text;
  v_distinct_phones int;
  v_seen boolean;
  v_result jsonb;
  v_member_id_for_consent uuid;
begin
  -- 1. 只給客戶帳號(後台人員的帳號不能拿來當客人)。
  if v_uid is null or not private.is_customer_account() then
    raise exception '這個功能只給用 LINE 登入的客人使用。' using errcode = '42501', hint = 'not_customer';
  end if;

  -- 2. slug → 商家;停用 / 沒啟用 LINE 登入。
  select * into v_merchant from public.merchants where booking_slug = lower(btrim(coalesce(p_slug, '')));
  if not found or v_merchant.status is distinct from 'active' then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;
  select * into v_cfg from public.merchant_line_login_configs where merchant_id = v_merchant.id;
  if not found or not v_cfg.enabled then
    return jsonb_build_object('state', 'line_login_unavailable');
  end if;

  -- 3. 這位客人的 LINE channel 必須等於這間店目前的 channel。
  select * into v_ident from public.customer_line_identities where user_id = v_uid;
  if not found or v_ident.line_channel_id is distinct from v_cfg.channel_id then
    return jsonb_build_object('state', 'channel_mismatch');
  end if;

  -- 4. 必須勾選同意。
  if p_agree_policy is not true then
    raise exception '請先勾選同意會員政策與隱私權政策。' using errcode = '22023', hint = 'policy_not_agreed';
  end if;

  select coalesce(ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null, false),
         case when ms.policy_enabled and nullif(btrim(coalesce(ms.policy_content, '')), '') is not null
              then md5(ms.policy_content) else null end
    into v_policy_enabled, v_policy_hash
  from public.merchant_member_settings ms where ms.merchant_id = v_merchant.id;
  v_policy_enabled := coalesce(v_policy_enabled, false);

  -- 同一位客人在同一間店的呼叫排隊處理(避免同時按兩次建出兩筆)。
  perform pg_advisory_xact_lock(hashtextextended('c2_profile:' || v_merchant.id::text || ':' || v_uid::text, 0));

  -- 5. 已經接上這間店的會員 ⇒ 直接回 linked(不重複建立、不改電話)。
  select * into v_linked from public.members
  where merchant_id = v_merchant.id and user_id = v_uid and status = 'active';
  if found then
    insert into public.customer_policy_consents (
      merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
    ) values (
      v_merchant.id, v_uid, v_linked.id, private.normalize_phone(p_phone), 'line_login', v_policy_enabled, v_policy_hash, '2026-10-08'
    );
    return jsonb_build_object('state', 'linked');
  end if;

  -- 7.(零之二 第 3 點)電話:手機或含區碼市話,不收分機。
  if p_phone is null or not private.is_valid_customer_phone(btrim(p_phone)) then
    raise exception '電話格式不正確。手機請填 09 開頭共 10 碼，市話請連同區碼填 9~10 碼，不用填分機。'
      using errcode = '22023', hint = 'invalid_phone';
  end if;
  v_phone := private.normalize_phone(btrim(p_phone));

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and char_length(v_name) > 50 then
    raise exception '姓名最多 50 個字。' using errcode = '22023', hint = 'invalid_name';
  end if;

  -- 零之二 Q6:同一位客人在同一間店 24 小時內最多換 5 支不同電話(用過的電話重送不算新的一支)。
  select count(distinct c.phone_normalized), coalesce(bool_or(c.phone_normalized = v_phone), false)
    into v_distinct_phones, v_seen
  from public.customer_policy_consents c
  where c.user_id = v_uid and c.merchant_id = v_merchant.id and c.context = 'line_login'
    and c.phone_normalized is not null and c.consented_at > now() - interval '24 hours';
  if not v_seen and v_distinct_phones >= 5 then
    return jsonb_build_object('state', 'too_many_attempts');
  end if;

  -- 同一支電話在同一間店排隊處理(兩位客人同時填同一支新電話)。
  perform pg_advisory_xact_lock(hashtextextended('c2_phone:' || v_merchant.id::text || ':' || v_phone, 0));

  -- 8. 用正規化電話找這間店的 active 會員(members_merchant_active_phone_uniq ⇒ 最多一位)。
  select * into v_member from public.members m
  where m.merchant_id = v_merchant.id and m.status = 'active' and private.normalize_phone(m.phone) = v_phone
  limit 1;

  if not found then
    -- 新電話 ⇒ 直接相信,沿用 create_member 建會員。姓名空白時用 LINE 顯示名稱。
    v_name := coalesce(v_name, left(nullif(btrim(coalesce(v_ident.display_name, '')), ''), 50), 'LINE 會員');
    begin
      v_new := private.create_member_as_customer_flow(v_merchant.id, v_name, v_phone);
    exception when others then
      -- 🔴 不把 create_member 的原文帶出去(撞號時原文會帶出別的會員姓名,C2-F06)。
      raise exception '系統忙碌，請稍後再試一次。' using errcode = 'P0001', hint = 'retry';
    end;

    update public.members
       set user_id = null
     where merchant_id = v_merchant.id and user_id = v_uid and id <> v_new.id;
    update public.members
       set user_id = v_uid,
           line_user_id = v_ident.line_sub,
           line_bound = true,
           identity_verified_at = now(),
           identity_verified_via = 'line',
           identity_first_verified_at = now()
     where id = v_new.id;

    v_member_id_for_consent := v_new.id;
    v_result := jsonb_build_object('state', 'linked', 'created', true);
  elsif v_member.user_id is null
        and exists (select 1 from public.customer_member_link_blocks b
                    where b.member_id = v_member.id and b.user_id = v_uid) then
    -- [c2-relink] 店家解除過「這個客戶帳號 ↔ 這位會員」⇒ 這個帳號不能自動接回;跟 phone_taken 同一個回應(不帶任何會員資料)。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', 'phone_taken');
  elsif v_member.user_id is null then
    -- 零之二 第 1 點:既有會員還沒有客戶帳號接上 ⇒ 直接接上(+ 鈴鐺)。
    perform private.link_customer_to_member(v_member.id, v_uid, v_ident.line_sub);
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked', 'existing', true);
  elsif v_member.user_id = v_uid then
    v_member_id_for_consent := v_member.id;
    v_result := jsonb_build_object('state', 'linked');
  else
    -- 零之二 第 1 點:已經有別的客戶帳號接上 ⇒ 不取代。回應不帶任何會員資料(C2-F06)。
    v_member_id_for_consent := null;
    v_result := jsonb_build_object('state', 'phone_taken');
  end if;

  -- 9. 每次呼叫都寫一筆同意紀錄(也是 Q6 的計數來源)。
  insert into public.customer_policy_consents (
    merchant_id, user_id, member_id, phone_normalized, context, member_policy_enabled, member_policy_hash, privacy_policy_version
  ) values (
    v_merchant.id, v_uid, v_member_id_for_consent, v_phone, 'line_login', v_policy_enabled, v_policy_hash, '2026-10-08'
  );

  return v_result;
end;
$$;

-- =========================================================================
-- link_customer_to_member:最後一道防線(其餘逐字不變)
-- =========================================================================
create or replace function private.link_customer_to_member(p_member_id uuid, p_user_id uuid, p_line_sub text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_member public.members;
begin
  select * into v_member from public.members where id = p_member_id for update;
  if not found then
    raise exception '找不到這位會員。' using errcode = 'P0002';
  end if;
  -- 零之二:已經有別的客戶帳號接上 ⇒ 不取代(呼叫端應該先回 phone_taken,這裡是最後一道防線)。
  if v_member.user_id is not null and v_member.user_id <> p_user_id then
    raise exception '這位會員已經有其他帳號接上。' using errcode = '42501';
  end if;

  -- [c2-relink] 最後一道防線:店家解除過這個帳號 ⇒ 不能接回。
  if exists (select 1 from public.customer_member_link_blocks b where b.member_id = p_member_id and b.user_id = p_user_id) then
    raise exception '這位會員目前不能自動接上，請聯繫店家。' using errcode = '42501';
  end if;

  -- 1. 同商家任何會員(不分狀態)若佔著這個 user_id ⇒ 先清成 null(members_merchant_id_user_id_idx 不分狀態)。
  update public.members
     set user_id = null
   where merchant_id = v_member.merchant_id and user_id = p_user_id and id <> p_member_id;

  -- 2. 接上:原本綁的 LINE 直接取代;identity 三欄用 coalesce。
  -- 4. 姓名、生日、點數、等級、黑名單一律不動(#931、#616)。
  update public.members
     set user_id = p_user_id,
         line_user_id = p_line_sub,
         line_bound = true,
         identity_verified_at = coalesce(identity_verified_at, now()),
         identity_verified_via = coalesce(identity_verified_via, 'line'),
         identity_first_verified_at = coalesce(identity_first_verified_at, now())
   where id = p_member_id;

  perform private.notify_member_line_login_linked(p_member_id);
end;
$$;

-- =========================================================================
-- get_member_customer_login_status:多回 relink_blocked
-- =========================================================================
create or replace function public.get_member_customer_login_status(p_member_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member public.members;
  v_last timestamptz;
begin
  select * into v_member from public.members where id = p_member_id;
  if not found or not private.can_manage_members(v_member.merchant_id) then
    raise exception '沒有權限查看這位會員。' using errcode = '42501';
  end if;

  if v_member.user_id is not null then
    select i.last_login_at into v_last from public.customer_line_identities i where i.user_id = v_member.user_id;
  end if;

  return jsonb_build_object(
    'linked', v_member.user_id is not null and v_last is not null,
    'last_login_at', v_last,
    'relink_blocked', exists (select 1 from public.customer_member_link_blocks b where b.member_id = p_member_id)
  );
end;
$$;
comment on function public.get_member_customer_login_status(uuid) is 'C2-H03:會員詳細頁「客戶端登入:已連結(最後登入 …)/ 未連結」。權限 = can_manage_members。只回 linked / last_login_at / relink_blocked(店家解除過、有客戶帳號被擋住不能自動接回 ⇒ 顯示「允許重新接上」),不回 LINE userId。';

-- =========================================================================
-- allow_member_customer_relink:店家撤銷封鎖
-- =========================================================================
create or replace function public.allow_member_customer_relink(p_member_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_count integer;
begin
  select merchant_id into v_merchant_id from public.members where id = p_member_id;
  if v_merchant_id is null or not private.can_manage_members(v_merchant_id) then
    raise exception '沒有權限管理這位會員。' using errcode = '42501';
  end if;
  delete from public.customer_member_link_blocks where member_id = p_member_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
comment on function public.allow_member_customer_relink(uuid) is 'C2(主腦複查):會員詳細頁「允許重新接上」。清掉這位會員的所有客戶帳號封鎖,之後那些帳號填同一支電話就能再接上。權限 = can_manage_members。回傳清掉幾筆。';
revoke execute on function public.allow_member_customer_relink(uuid) from public, anon;
grant execute on function public.allow_member_customer_relink(uuid) to authenticated;
