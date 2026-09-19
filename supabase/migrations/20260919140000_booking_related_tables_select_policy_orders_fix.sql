-- SPECS-INDEX 編號 240/241/242(規格書 .project/specs/建單相關資料表權限缺口修正.md)。
--
-- 背景:模組 9(支付方式)v2 品管驗收時,用真實瀏覽器測試「只有『訂單管理』權限、沒有其他
-- 管理權限的客服」建單時的實際體驗,額外發現三張既有資料表(分別來自模組 3/4/5,早於這次
-- 改動)的 RLS SELECT 政策沒有把「訂單管理」權限算進去,導致這種客服打開「新增預約」表單時,
-- 部分區塊/選單會是空的,實務上會卡住建單流程——跟這次模組 9 對 payment_methods/
-- material_cost_items 做的修正(20260919130200_material_cost_items_select_policy_orders_fix.sql)
-- 是同一種問題、同一種修法,只是這次要修的是另外三張表。三張表分屬三個不同既有模組,
-- 依規格書要求寫成一支獨立的新 migration,不跟其他改動混在一起,方便之後追溯。
--
-- 核心原則:「管理某張清單(新增/編輯/下架)」跟「建單時讀取這張清單來選用」是兩件不同的事——
-- 管理繼續只給該功能專屬的權限(INSERT/UPDATE 完全不動),讀取(SELECT)只要客服有「訂單管理」
-- 權限(private.can_manage_bookings(merchant_id))就應該讀得到,不需要額外的專屬權限。

-- =========================================================================
-- 1. merchant_feature_flags(模組 5):建單表單要判斷「這間商家有沒有開啟料錢成本功能」時,
--    會查這張表的 material_cost_enabled 旗標。只有訂單管理權限、沒有營業時間設定權限的客服
--    查不到,前端把查無結果當成「功能關閉」,料錢成本區塊就完全不顯示——即使
--    material_cost_items 本身的 RLS 已經修好也沒用。
--    目前 SELECT 政策:private.can_manage_business_hours(merchant_id)。
--    修正:同時放行 can_manage_bookings。INSERT/UPDATE 維持只允許 can_manage_business_hours,不動。
-- =========================================================================
drop policy if exists merchant_feature_flags_select on public.merchant_feature_flags;

create policy merchant_feature_flags_select on public.merchant_feature_flags
  for select to authenticated
  using (private.can_manage_bookings(merchant_id) or private.can_manage_business_hours(merchant_id));

-- =========================================================================
-- 2. merchant_staff(模組 3):建單表單的「主要服務人員」「助手」下拉選單需要讀這張表列出
--    商家的服務人員清單。目前只有商家管理員本人能讀,任何客服(不管有沒有訂單管理權限)都
--    讀不到,下拉選單永遠是空的。
--    目前 SELECT 政策:private.is_merchant_admin(merchant_id)。
--    修正:同時放行 can_manage_bookings。INSERT/UPDATE 維持只允許 is_merchant_admin,不動。
-- =========================================================================
drop policy if exists merchant_staff_select on public.merchant_staff;

create policy merchant_staff_select on public.merchant_staff
  for select to authenticated
  using (private.is_merchant_admin(merchant_id) or private.can_manage_bookings(merchant_id));

-- =========================================================================
-- 3. service_items(模組 4):建單表單的「服務項目」多選清單需要讀這張表。只有「服務項目
--    管理」權限的客服讀得到,只有「訂單管理」權限的客服讀不到,清單是空的。
--    目前 SELECT 政策:private.can_manage_service_items(merchant_id)。
--    修正:同時放行 can_manage_bookings。INSERT/UPDATE 維持只允許 can_manage_service_items,不動。
-- =========================================================================
drop policy if exists service_items_select on public.service_items;

create policy service_items_select on public.service_items
  for select to authenticated
  using (private.can_manage_service_items(merchant_id) or private.can_manage_bookings(merchant_id));
