-- 品管複驗時額外發現的小缺口(SPECS-INDEX 編號 123 備註,「額外發現」段落):
-- merchant_feature_flags 的 SELECT 政策沒有跟著這次編號 123/127/142 打回修正的
-- UPDATE(20260916140100_booking_functions.sql)/INSERT(20260916150000_merchant_feature_flags_insert_policy.sql)
-- 一起更新,仍停留在模組 1 遺留的 private.is_merchant_admin(merchant_id)。
--
-- 影響:被商家管理員開放 business_hours 權限的客服,雖然能透過 setFeatureFlag()(upsert)寫入
-- 「嚴格工時衝突檢查」開關,但呼叫 getFeatureFlag() 讀回時會被這條較嚴格的 SELECT 政策擋下
-- (RLS 篩成 0 筆),前端 BusinessHoursPage.tsx 把「查無資料」一律當成預設值 true 處理
-- (規格書 1.4:查無資料時前端視為預設開啟),導致客服看到的畫面跟自己剛剛存進去的值不一致。
-- 這跟規格書 1.4/規則 2.12「商家管理員永遠可以修改,並可以自行決定要不要開放給客服調整」
-- 的設計意圖不符——開放了寫入權限,卻沒有對等開放讀取權限。
--
-- 修法:把 SELECT 政策的判斷條件從 private.is_merchant_admin(merchant_id) 改成
-- private.can_manage_business_hours(merchant_id),跟 UPDATE/INSERT 政策維持一致
-- (同一把 business_hours 鑰匙,讀寫權限對齊)。
--
-- 安全性確認:merchant_feature_flags 只存 merchant_id/feature_key/enabled 三個欄位，
-- 不含任何敏感資料；已檢查呼叫端 getFeatureFlag()（src/modules/merchant/api.ts）、
-- useFeatureFlag()（src/modules/merchant/context.tsx）與唯一使用者 BusinessHoursPage.tsx，
-- 均未依賴「只有管理員能讀」這個更嚴格的假設（找不到資料一律視為 null → 前端預設 true，
-- 不區分呼叫者身份），放寬為「管理員或被授權 business_hours 的客服皆可讀」不會造成資料外洩。
alter policy merchant_feature_flags_select on public.merchant_feature_flags
  using (private.can_manage_business_hours(merchant_id));

comment on policy merchant_feature_flags_select on public.merchant_feature_flags is
  '讀取權限比照 UPDATE/INSERT 政策，同樣歸在 business_hours 這把鑰匙底下：商家管理員永遠可以，或該商家目前有效且被開通 business_hours 這個 section_key 的客服（SPECS-INDEX 編號 123 品管複驗「額外發現」小修正）。';
