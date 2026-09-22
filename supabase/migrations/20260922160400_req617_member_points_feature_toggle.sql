-- .project/SPECS-INDEX.md #617(對應 .project/specs/會員與紅利.md §10.5「紅利點數獨立化」)。
--
-- 新增 merchant_member_settings.points_feature_enabled:商家決定要不要啟用紅利點數功能的開關。
-- 預設 true——沿用目前既有商家的實際使用狀況(規格書明講「除非主腦跟使用者確認新商家預設要
-- 關閉,否則新商家種子函式這次不變動預設值」,這次沒有這樣的確認,所以維持預設開啟)。
--
-- 關閉後前端行為(src/modules/members/MemberDetailPage.tsx、MemberPointsPage.tsx):不再顯示
-- 任何點數相關的操作入口與數字,但既有的點數餘額資料(members.points_balance/
-- member_point_transactions)完全不受影響,只是隱藏,不清空——這支 migration 本身只新增一個
-- boolean 欄位,不動任何既有資料表結構/資料。
--
-- 不需要新的 RLS 政策:merchant_member_settings 既有的
-- merchant_member_settings_insert/merchant_member_settings_update 政策(見
-- 20260920140100_members_core_functions.sql)已經是整列 upsert 授權給
-- private.can_manage_member_settings(merchant_id) 通過的使用者,新欄位自動涵蓋在內。

alter table public.merchant_member_settings
  add column points_feature_enabled boolean not null default true;

comment on column public.merchant_member_settings.points_feature_enabled is
  '商家是否啟用紅利點數功能(.project/SPECS-INDEX.md #617)。預設 true(沿用既有商家的實際使用
  狀況)。關閉後前端隱藏建單表單/會員詳情頁/紅利點數管理頁的點數操作入口與數字,既有點數餘額/
  異動歷史資料不受影響,重新開啟後完整還原顯示——這個欄位只控制「要不要顯示」,不影響任何後端
  核發/兌換/調整邏輯本身(那些函式沒有讀這個欄位,商家管理員/客服理論上還是可以透過直接呼叫
  RPC 操作點數,這個開關純粹是前端體驗層的顯示開關,不是資料庫層的安全邊界)。';
