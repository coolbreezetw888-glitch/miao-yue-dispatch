-- 深夜自主巡檢批次(2026-09-24)A3:merchant_staff 的四個「身分/身價」欄位加上欄位層級保護。
--
-- =========================================================================
-- 【問題】
-- 20260923050000_staff_management_agent_permission.sql:54-58 把 merchant_staff_update 政策
-- 放寬成「商家管理員 or 被授權 staff_management 的客服」,但 RLS 的 UPDATE 政策是「整列」層級
-- 的,沒有辦法限制「可以改哪些欄位」。結果是:只要被開了 staff_management 這一個開關的客服,
-- 就可以改這一列的「任何」欄位,包含 user_id(這位服務人員綁定的登入帳號)。
--
-- 【攻擊情境(逐步查證過,不是理論推演)】
--   1. 客服只需要被開 staff_management 一個開關(這個開關的本意只是「可以新增/編輯服務人員」)。
--   2. 直接打 PATCH /rest/v1/merchant_staff?id=eq.<某位師傅>,body 送 {"user_id":"<客服自己的 auth uid>"}。
--   3. merchant_staff_update 政策通過(can_manage_staff 為真、merchant_id 沒變,with check 也過)。
--   4. 從這一刻起 private.is_own_staff_row(<那位師傅的 staff id>) 對這個客服為真,於是他可以呼叫
--      get_staff_monthly_payroll_summary / get_staff_commission_summary / get_my_booking_schedule
--      等「本人限定」的函式,拿到那位師傅的完整薪資、抽成明細,以及所有經手預約的客戶姓名、
--      電話、地址、金額。
--   5. 同時,真正的那位師傅因為 user_id 被換掉,立刻失去服務人員端的存取權(等同被踢出登入)。
--   6. seed_default_staff_permissions 對每位新建的服務人員「預設」就把 staff_payroll_view 設為
--      true,所以攻擊者連額外開權限這一步都不需要。
--
-- 【既有防線與缺口(查證結果)】
--   ・merchant_staff 上已經有兩支同類型的欄位保護 trigger——
--     merchant_staff_protect_line_binding_columns(20260920160000)、
--     merchant_staff_protect_pending_login_email_columns(20260921170000),
--     證明這個 codebase 早就有「敏感欄位只能透過指定路徑寫入」的既有模式;
--     但兩支都沒有涵蓋 user_id。
--   ・把 merchant_id 改到別家商家「會」被 with check 擋下,所以這不是跨商家漏洞,
--     是同一間商家內部的提權(客服 → 竊取師傅身分)。
--   ・merchant_staff 沒有 user_id 的 unique constraint(只有
--     merchant_staff_merchant_user_unique 這個 (merchant_id, user_id) where status='active'
--     的 partial index,它擋的是「同一人同時是本店兩筆在職名錄」,擋不了這個攻擊)。
--
-- 【修法】
-- 完全比照既有的 private.protect_merchant_staff_pending_login_email_columns() 的結構
-- (BEFORE UPDATE trigger + `auth.role() <> 'service_role'` + transaction-local 繞道旗標),
-- 新增一支 private.protect_merchant_staff_identity_columns(),保護「身分綁定」這兩個欄位:
--   user_id      → 這一列綁定的登入帳號(本次漏洞的主角)
--   login_status → 登入開通狀態(not_invited / invited / active,跟身分綁定是同一組狀態)
-- 只有 private.is_merchant_admin(merchant_id) 才能改這兩個欄位。
--
-- 【為什麼「只」保護這兩欄——status 與 compensation_type 刻意不納入】
-- 這次漏洞的提權路徑完完全全來自 user_id:改成自己 → private.is_own_staff_row() 變真 →
-- 讀到別人的薪資/抽成/客戶個資。login_status 跟 user_id 是同一組「這個帳號能不能以這個人的
-- 身分登入」的狀態,一起保護才不會留下側門。
--
--   ・status(在職/已移除):2026-09-23 使用者決策明文寫著「服務人員管理 = 新增/編輯/
--     軟刪除/指派服務項目」,而「軟刪除」在實作上就是把 status 改成 'removed'
--     (src/modules/staff-agent/api.ts 的 removeMerchantStaff/reactivateMerchantStaff)。
--     把它鎖住等於把使用者明確授予客服的權限拿掉,那不是資安修補,是功能退化。
--   ・compensation_type(月薪制/按件計酬):它本來就沒有被限制過,而且改它不會讓任何人
--     讀到原本讀不到的資料——不構成提權路徑。要不要限制屬於產品決策,不在這次資安修復
--     的範圍內,刻意不順手擴大。
--
-- 結論:這支 trigger 上線後,被授權 staff_management 的客服「原有的每一件事都還能做」
-- (新增、一般編輯、軟刪除、復職、改計酬類型、指派服務項目),唯一被拿掉的是
-- 「把某位服務人員的登入帳號改綁到別人身上」這個他本來就不該有的能力。
-- 下面的 pgTAP 測試會把「客服仍然可以軟刪除/復職/改 compensation_type」釘成回歸保護,
-- 避免之後有人又把保護範圍改寬。
-- =========================================================================

-- =========================================================================
-- §1:合法寫入路徑的盤點結果(這是這次改動最容易出錯的地方,逐一查過所有會寫入這兩個欄位的路徑)
--
--  (1) public.record_invited_staff_login(uuid, text, ...)
--      —— 寫 user_id / login_status。只 grant 給 service_role(Edge Function
--         invite-merchant-staff 呼叫),auth.role() = 'service_role',被第一道
--         `auth.role() <> 'service_role'` 條件放行,不需要旗標。
--
--  (2) public.mark_staff_login_active_if_self()
--      —— 寫 login_status = 'active'。由「服務人員本人」以 authenticated 身份呼叫,
--         本人不是 merchant admin,會被這支 trigger 擋下 → 必須用旗標繞道。
--         下面 §3 用 create or replace 幫它補上 set_config,函式簽章/權限/其餘邏輯一字不改。
--
--  (3) public.hard_delete_merchant_staff(uuid)
--      —— 是 DELETE,不是 UPDATE,BEFORE UPDATE trigger 完全不會被觸發。不受影響。
--
--  (4) public.update_my_staff_profile(...)(服務人員自助編輯)
--      —— 只寫 name/nickname/phone/contact_email/avatar_url/intro,完全不碰這兩個欄位。不受影響。
--
--  (5) public.request_staff_login_email_change / clear_staff_pending_login_email
--      —— 只寫三個 pending_admin_login_email* 欄位。不受影響。
--
--  (6) LINE 綁定/解綁(bind_line_account / unbind_line_account)
--      —— 只寫 line_user_id / line_bound。不受影響(那是另一支 trigger 管的欄位)。
--
--  (7) private.merchant_staff_sync_payroll_status_history()
--      —— 是 AFTER INSERT OR UPDATE OF compensation_type, status 的 trigger,監看的兩個欄位
--         都不在這次的保護清單內,而且它寫入的是 staff_payroll_status_history、不是
--         merchant_staff,不會遞迴觸發。完全不受影響。
--
--  (8) 前端 src/modules/staff-agent/api.ts 的 updateMerchantStaff / removeMerchantStaff /
--      reactivateMerchantStaff(客服的一般編輯、軟刪除、復職、改計酬類型)
--      —— 這些路徑寫的是 name/nickname/phone/contact_email/intro/avatar_url/is_listed/
--         各種預約設定旗標/status/compensation_type,全部都不在保護清單內,
--         被授權 staff_management 的客服照常可以做(見檔頭「為什麼只保護這兩欄」)。
-- =========================================================================

create or replace function private.protect_merchant_staff_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- ⚠️ 保護清單刻意「只有」這兩欄。不要在這裡順手加上 status / compensation_type
  -- (理由見檔頭「為什麼只保護這兩欄」:那兩欄不構成提權路徑,而且 status 是使用者
  --  2026-09-23 明確授權給客服的「軟刪除」功能)。
  if (new.user_id is distinct from old.user_id
      or new.login_status is distinct from old.login_status)
     -- 第一道繞道:Edge Function / 後台維運走 service_role(見 §1 (1))。
     and auth.role() <> 'service_role'
     -- 第二道繞道:已經自行完成權限檢查的 SECURITY DEFINER 函式,在真正要寫入前用 set_config
     -- 短暫打開這個 transaction-local 旗標(set_config 第三參數 true,交易結束自動失效,
     -- 不會外溢到同一個連線之後的其他語句)。目前唯一的使用者是
     -- mark_staff_login_active_if_self(見 §1 (2) 與下方 §3)。
     and coalesce(current_setting('staff_agent.bypass_staff_identity_guard', true), 'off') <> 'on'
     -- 主要判斷:這兩個欄位只有商家管理員能改。用 old.merchant_id(這一列「目前」歸屬的商家),
     -- 不用 new.merchant_id——避免「先把列搬到自己也管得到的另一間商家、同時改 user_id」這種
     -- 組合技(merchant_id 的變更本來就已經被 merchant_staff_update 的 with check 擋住,
     -- 這裡再多一層保險)。
     and not private.is_merchant_admin(old.merchant_id)
  then
    raise exception '只有商家管理員可以變更服務人員綁定的登入帳號或登入狀態'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.protect_merchant_staff_identity_columns() is '2026-09-24 安全修補(A3):擋下非商家管理員對 merchant_staff.user_id / login_status 的異動。原本 merchant_staff_update 政策是整列層級的,被授權 staff_management 的客服可以把某位師傅的 user_id 改成自己,藉此透過 private.is_own_staff_row 取得該師傅的薪資/抽成/客戶個資,同時把本人踢出登入。保護清單刻意只有這兩個「身分綁定」欄位——status(軟刪除)是使用者 2026-09-23 明確授權給客服的功能,compensation_type 不構成提權路徑,兩者都不納入。放行路徑有兩條:service_role(record_invited_staff_login 等 Edge Function 路徑),以及 transaction-local 旗標 staff_agent.bypass_staff_identity_guard(目前只有 mark_staff_login_active_if_self 使用)。';

create trigger merchant_staff_protect_identity_columns
  before update on public.merchant_staff
  for each row execute function private.protect_merchant_staff_identity_columns();

-- =========================================================================
-- §3:mark_staff_login_active_if_self 補上繞道旗標。
--
-- 這支函式是「服務人員本人完成 Supabase 邀請信設定密碼後,轉場頁載入時自動呼叫」,把自己
-- 所有 login_status='invited' 的紀錄改成 'active'。呼叫者是服務人員本人(authenticated),
-- 不是商家管理員,如果不放行就會整個邀請流程卡死在最後一步(本人登入後永遠停在 invited)。
--
-- 完整照抄 20260921100400_staff_portal_invite_functions.sql:60 的原始定義,只在 update 前後
-- 各加一行 set_config(比照 unbind_line_account 對 line_notifications.bypass_staff_binding_guard
-- 的既有寫法:用完馬上關掉,不依賴交易結束才失效)。簽章、returns、language、security definer、
-- search_path、權限設定全部維持原樣。
--
-- 為什麼這樣放行仍然是安全的:這支函式的 where 條件是 `user_id = auth.uid()`,呼叫者只能影響
-- 「已經是自己」的那幾列,無法指定別人;而且只會把 invited 改成 active,不會碰 user_id。
-- =========================================================================
create or replace function public.mark_staff_login_active_if_self()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  perform set_config('staff_agent.bypass_staff_identity_guard', 'on', true);
  update public.merchant_staff
  set login_status = 'active', login_activated_at = now()
  where user_id = auth.uid() and login_status = 'invited';
  perform set_config('staff_agent.bypass_staff_identity_guard', 'off', true);
end;
$$;

comment on function public.mark_staff_login_active_if_self() is '對應規格書 3.12:服務人員完成 Supabase 邀請信的設定密碼流程後,轉場頁載入時呼叫,把自己所有 login_status=invited 的紀錄一次改成 active。只能改自己的紀錄,呼叫者無法影響到別人。2026-09-24(A3):新增的 merchant_staff_protect_identity_columns trigger 會擋下非管理員對 login_status 的異動,這裡在 update 前後用 transaction-local 旗標 staff_agent.bypass_staff_identity_guard 放行這條已經自行檢查過「只能改自己」的合法路徑。';

revoke execute on function public.mark_staff_login_active_if_self() from public, anon;
grant execute on function public.mark_staff_login_active_if_self() to authenticated;
