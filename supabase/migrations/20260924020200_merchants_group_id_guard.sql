-- 深夜自主巡檢批次(2026-09-24)A4:merchants.group_id 加上欄位層級保護。
--
-- =========================================================================
-- 【問題】
-- merchants_update 政策(模組 1 建立,20260915120100_platform_admin_rls_overlay.sql:19-21
-- 疊加平台管理員分支後的最新版本)是:
--     using       (private.is_merchant_admin(id) or private.is_platform_admin())
--     with check  (private.is_merchant_admin(id) or private.is_platform_admin())
-- 判斷的對象是這一列的「id」,跟 group_id 完全無關。RLS 的 UPDATE 政策又是整列層級的,
-- 沒辦法限制「可以改哪些欄位」,所以商家管理員可以把自己的店改成掛在別的集團底下。
--
-- 【攻擊情境】
--   1. 某間店的店長(merchant_admins 裡的一員)直接打
--      PATCH /rest/v1/merchants?id=eq.<A 店>,body 送 {"group_id":"<另一個集團的 id>"}。
--   2. using / with check 都只看 id,兩邊都通過,UPDATE 成功。
--   3. 原本那個集團的老闆(靠 groups.group_admin_user_id 繼承取得 A 店存取權,見
--      private.is_merchant_admin 的集團繼承分支)的 is_merchant_admin(A) 立刻變成 false。
--   4. 老闆從此在後台「看不到也管不到」A 店,而且因為他已經不是 A 店的管理員,
--      也沒有任何一條路可以自己把 group_id 改回來——只能請平台管理員或工程師進資料庫手動修。
--
-- 【既有防線(查證結果)】
-- merchants 這張表上目前只有兩個 trigger:merchants_set_updated_at(公用的 updated_at 回填)
-- 與 prevent_disable_last_active_merchant(擋「把集團最後一間啟用中的店停用」)。
-- 沒有任何機制保護 group_id。
--
-- 【修法】
-- 比照 merchant_staff 上既有的兩支欄位保護 trigger(protect_merchant_staff_line_binding_columns /
-- protect_merchant_staff_pending_login_email_columns)的同一套模式,新增一支 BEFORE UPDATE
-- trigger:group_id 有變動時只允許 private.is_platform_admin()。集團歸屬本來就是平台層級的
-- 編制調整,不是單店店長該有的權限。
--
-- 【為什麼不會弄壞既有流程(逐一查證過)】
--   ・create_merchant_in_group / create_group_and_merchant:這兩支都是 INSERT 新商家時
--     直接帶入 group_id,BEFORE UPDATE trigger 完全不會被觸發。
--   ・transfer_members_to_merchant(產業轉移精靈)與 rollback_bulk_operation 的
--     industry_transfer_members 分支:改的是 members.merchant_id /
--     member_point_transactions.merchant_id / bookings.member_id,完全不碰 merchants 這張表。
--   ・20260923040000_allow_industry_type_change 放寬的是 industry_type,不是 group_id。
--   ・前端 src/modules/merchant/api.ts 的 updateMerchantSettings payload 完全沒有 group_id
--     這個 key(只有 name/industry_type/address/phone/contact_email/intro/theme_*/announcement_*/
--     logo_url);disableMerchant/enableMerchant 只改 status。
--   ・全專案 supabase/migrations 底下沒有任何一行 `update public.merchants ...` 會寫 group_id
--     (已用 grep 逐檔確認)。
--   也就是說:目前沒有任何一條合法流程會更新 merchants.group_id,這支 trigger 上線後
--   「理論上不該有任何正常請求被它擋下」。仍然保留 service_role 與 transaction-local 旗標
--   兩條繞道,是為了將來真的要做「商家轉移集團」功能時有現成、可稽核的後門可用,不必再動 RLS。
-- =========================================================================

create or replace function private.protect_merchants_group_id_column()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.group_id is distinct from old.group_id
     -- 第一道繞道:後台維運 / 未來的 Edge Function 走 service_role。
     and auth.role() <> 'service_role'
     -- 第二道繞道:已經自行完成權限檢查的 SECURITY DEFINER 函式,可在寫入前用 set_config
     -- 短暫打開這個 transaction-local 旗標(目前沒有任何函式使用,先預留,寫法比照
     -- line_notifications.bypass_staff_binding_guard 的既有慣例)。
     and coalesce(current_setting('platform_admin.bypass_merchant_group_guard', true), 'off') <> 'on'
     -- 主要判斷:集團歸屬是平台層級的編制調整,只有超級管理員能做。
     and not private.is_platform_admin()
  then
    raise exception '商家的集團歸屬只能由平台管理員調整,商家管理員不能自行把店搬到其他集團'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.protect_merchants_group_id_column() is '2026-09-24 安全修補(A4):擋下非平台管理員對 merchants.group_id 的異動。merchants_update 政策只判斷 id、不限制欄位,店長原本可以自己把店搬到別的集團,導致原集團管理者的 private.is_merchant_admin() 立刻失效、永久失去存取且無法自行修復。放行路徑:service_role,或 transaction-local 旗標 platform_admin.bypass_merchant_group_guard(預留給未來的「商家轉移集團」功能)。';

create trigger merchants_protect_group_id_column
  before update on public.merchants
  for each row execute function private.protect_merchants_group_id_column();
