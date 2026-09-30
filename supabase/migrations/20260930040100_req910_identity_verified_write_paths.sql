-- SPECS-INDEX #910(規格書 .project/specs/建單自動建立會員與會員兩層狀態.md §三 #910)。
-- 「已完成身分驗證」這三個欄位的**唯一寫入路徑**。
--
-- ═══ 🔴 這份檔案就是那份登記簿,未來新增登入方式時也要登記在這裡 ═══════════════════════
-- public.members.identity_verified_at / identity_verified_via / identity_first_verified_at
-- 目前**只有這兩支函式**會寫:
--   ・public.consume_line_binding_code  → 綁定成功時設上
--   ・public.unbind_line_account        → 解除綁定時把「目前狀態」清成 null
-- 其他所有既有函式(create_member、update_member、import_members_batch、
-- transfer_members_to_merchant、platform_*、set_member_phone_verified)**一律不碰這三個欄位**
-- —— 客服不可以手動把客戶標成「已驗證」。
-- (transfer_members_to_merchant 是搬整列、欄位跟著搬,不需要改。)
-- 🔴 #866 之後真的加手機登入、或模組 13 做出客戶端登入時,**新那條路徑也要在這裡登記**,
--    並在 members_identity_verified_via_check 加上對應的值('phone_otp' / 'account')。
--
-- ═══ 使用者對 Q2 的裁決(這一段決定了下面每一行怎麼寫,不可以只讀「B」就動手)═══════════
-- 問題:客戶解除 LINE 綁定之後,還算不算「真正的會員」?
-- 使用者 2026-09-30 原話:「我比較偏向 B,因為本來就在會員清單,只是看有沒有綁定決定後續的
-- 再行銷通知等等,如果真的解除綁定,**會員資料、紀錄、加入時間也不該清除**(僅是綁定狀態變回
-- 未綁定)影響的只是不能碰到有綁定之後才能觸發的功能」。
--
-- ⇒ 落地結論(兩件事同時成立,缺一條就不符合裁決):
--    ① 解除綁定時把**目前的驗證狀態**歸零:identity_verified_at = null、identity_verified_via = null
--       ⇒ 名單上他會變回「尚未驗證」,綁定之後才能觸發的功能(再行銷通知等)碰不到他。
--       (2026-10-01 修正用詞:原本寫舊標籤「已建立(未綁定)」;使用者已裁決狀態名稱裡不可以
--        有「綁定」二字,現行文案的唯一來源是 src/modules/members/memberIdentityStatus.ts。)
--    ② **identity_first_verified_at 一律不動** —— 這就是使用者說的「加入時間不該清除」。
--       規劃者原本建議 (A) 不清掉的唯一理由就是「清掉會讓第一次完成驗證的時間永久消失」;
--       既然裁決是 (B),那個時間就必須另外保留成歷史,否則第二次解除綁定時使用者要的東西就失效了。
--    ③ 會員本人、會員的訂單紀錄、點數餘額、分類帳**全部不動**,一筆都不刪。
--
-- ═══ 為什麼 identity_verified_at 用 coalesce 而不是直接覆寫 ════════════════════════════
-- 一個人**第二次**綁定(換手機、重綁 LINE)不該把「這一段驗證狀態是從什麼時候開始的」改掉。
-- identity_first_verified_at 同樣用 coalesce(它更嚴格:一旦有值就永遠不再變)。
--
-- ═══ 兩支函式的其餘內容逐字沿用最新版本 ═══════════════════════════════════════════════
-- ・consume_line_binding_code ← 20260920160200_line_notifications_binding_functions.sql
--   (檔案本體 CRLF 正規化成 LF 後 md5 = 6867b6412595b140f4d0f7959118ff56、長度 1570,
--    2026-09-30 對正式庫 pg_proc.prosrc 核對**逐字相符**,不是憑印象重寫)
-- ・unbind_line_account ← 20260924040900_self_service_line_binding.sql
--   (同樣方式核對,md5 = 4f209a723c49fb8fb009568e06ce9f91、長度 4212,逐字相符)
-- 兩支簽章都不變,所以用 create or replace,不需要 drop
-- (drop 會一併丟掉現有的 EXECUTE 權限設定,見 supabase-permission-hygiene 規則 1)。
-- revoke/grant 仍然原樣重寫一次(幂等),讓「這支函式的權限邊界」在這份 migration 裡也看得到。
--
-- ⚠️ 本檔沒有任何 UPDATE/DELETE 資料的敘述,只有函式定義。

-- =========================================================================
-- 1. consume_line_binding_code:member 分支的 UPDATE 多三個欄位
--    (admin / agent / staff 三個分支一個字都不改 —— 那三種是「內部人員」,
--     「已完成身分驗證」是會員(顧客)的兩層狀態,跟他們無關。)
-- =========================================================================
create or replace function public.consume_line_binding_code(
  p_code text,
  p_merchant_id uuid,
  p_line_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_binding public.line_binding_codes;
  v_target_name text;
begin
  select * into v_binding
  from public.line_binding_codes
  where merchant_id = p_merchant_id
    and code = p_code
    and used_at is null
    and expires_at > now()
  order by created_at desc
  limit 1;

  if v_binding.id is null then
    return jsonb_build_object('success', false, 'reason', 'invalid_or_expired');
  end if;

  if v_binding.target_type = 'admin' then
    update public.merchant_admins
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning coalesce(display_name, '商家管理員') into v_target_name;
  elsif v_binding.target_type = 'agent' then
    update public.merchant_agents
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning name into v_target_name;
  elsif v_binding.target_type = 'staff' then
    update public.merchant_staff
    set line_user_id = p_line_user_id, line_bound = true
    where id = v_binding.target_id
    returning name into v_target_name;
  elsif v_binding.target_type = 'member' then
    -- SPECS-INDEX #908/#910(2026-09-30):這裡是「已完成身分驗證」目前唯一的設上點。
    -- 為什麼這條路徑算得上「本人證明過自己」:綁定碼必須由客人**用他自己的 LINE 帳號**
    -- 傳給商家官方帳號,商家自己做不到 ⇒ 本質上就是本人的主動認領動作(使用者 2026-09-30
    -- 對 Q6 裁決 (A)「算」)。
    -- coalesce 的用意:第二次綁定(換手機、重綁)不該把「這一段驗證是從什麼時候開始的」改掉;
    -- identity_first_verified_at 更嚴格,一旦有值就永遠不再變(解除綁定也不清,見下面那支函式)。
    update public.members
    set line_user_id = p_line_user_id,
        line_bound = true,
        identity_verified_at = coalesce(identity_verified_at, now()),
        identity_verified_via = coalesce(identity_verified_via, 'line'),
        identity_first_verified_at = coalesce(identity_first_verified_at, now())
    where id = v_binding.target_id
    returning name into v_target_name;
  end if;

  update public.line_binding_codes
  set used_at = now(), used_by_line_user_id = p_line_user_id
  where id = v_binding.id;

  return jsonb_build_object(
    'success', true,
    'target_type', v_binding.target_type,
    'target_id', v_binding.target_id,
    'target_name', v_target_name
  );
end;
$$;

comment on function public.consume_line_binding_code(text, uuid, text) is '規則 2.8/3.8:比對綁定碼成功後直接覆蓋 line_user_id/line_bound(換帳號直接取代,不需先解除)。只給 line-webhook Edge Function 用 service role 呼叫。SPECS-INDEX #908/#910(2026-09-30):member 分支的同一句 UPDATE 額外寫入「已完成身分驗證」三個欄位 —— identity_verified_at 與 identity_verified_via 用 coalesce(第二次綁定不改「這一段驗證從何時開始」),identity_first_verified_at 也用 coalesce 且**之後永遠不會被任何路徑清掉或覆寫**。這支函式是 identity_verified_at 目前**唯一的設上路徑**(清掉的唯一路徑是 unbind_line_account);未來 #866 改登入方式或模組 13 做出客戶端登入時,新那條路徑也要在 20260930040100 這份 migration 裡登記,並在 members_identity_verified_via_check 加上對應的值。admin/agent/staff 三個分支完全不變(「已完成身分驗證」是會員的兩層狀態,跟內部人員無關)。';

revoke execute on function public.consume_line_binding_code(text, uuid, text) from public, anon, authenticated;
grant execute on function public.consume_line_binding_code(text, uuid, text) to service_role;

-- =========================================================================
-- 2. unbind_line_account:member 分支的 UPDATE 多兩個欄位(清成 null)
--    admin / agent / staff 三個分支一個字都不改。
-- =========================================================================
create or replace function public.unbind_line_account(p_target_type text, p_target_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_self_user_id uuid;
begin
  if p_target_type not in ('admin', 'agent', 'staff', 'member') then
    raise exception '不支援的綁定目標類型: %', p_target_type;
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
    update public.members
    set line_user_id = null,
        line_bound = false,
        identity_verified_at = null,
        identity_verified_via = null
    where id = p_target_id;
  end if;
end;
$$;

comment on function public.unbind_line_account(text, uuid) is '規則 2.8 反向操作/3.19:解除 LINE 綁定。admin/agent 允許管理員或本人;staff 自 2026-09-24 使用者裁決「要讓服務人員自己綁定」起,同樣允許「管理員或本人」(本人一律用 auth.uid() 對照 merchant_staff.user_id 判斷,不信任前端傳來的 id;實際欄位異動透過 line_notifications.bypass_staff_binding_guard 這個 transaction-local 旗標合法放行規則 2.9 觸發器);member 檢查 can_manage_members。三個分支都用 (user_id is not null and auth.uid() is not null and user_id = auth.uid()) 的 null 安全寫法(2026-09-24 修掉的既有三值邏輯漏洞)。SPECS-INDEX #910(2026-09-30,使用者裁決 Q2 = (B) 附帶限制):member 分支額外把 identity_verified_at 與 identity_verified_via 清成 null(綁定狀態歸零,名單上變回「尚未驗證」——2026-10-01 修正用詞,原本寫的是舊標籤「已建立(未綁定)」;使用者已裁決狀態名稱裡不可以出現「綁定」二字,文案的唯一來源是 src/modules/members/memberIdentityStatus.ts),但 🔴 **identity_first_verified_at 一律不動**(第一次完成驗證的時間永久保留 —— 使用者原話「會員資料、紀錄、加入時間也不該清除,僅是綁定狀態變回未綁定」)。這支函式是 identity_verified_at 目前唯一的清除路徑;會員本人與他的訂單/點數/分類帳完全不動。';

revoke execute on function public.unbind_line_account(text, uuid) from public, anon;
grant  execute on function public.unbind_line_account(text, uuid) to authenticated;
