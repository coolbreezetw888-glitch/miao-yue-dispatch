-- SPECS-INDEX #927(2026-10-01):資料庫註解(COMMENT)裡殘留的特定產業稱呼清理。
--
-- 背景:#878 已經把使用者看得到的 raise exception 訊息改成「服務人員」;剩下的是只有開發者
-- 看得到的資料庫註解。盤點方式:正式庫唯讀查 pg_description,目前仍帶違規用語的「現役」註解
-- 只有下面 4 個物件(共 4 處舊稱「師傅」+ 1 處「店長」);其餘歷史 migration 裡的舊註解
-- 早就被後續 migration 的 comment on / drop function 覆蓋,正式庫已經看不到。
--
-- 🔴 這支 migration 只用 COMMENT ON 改註解文字,刻意不重建任何函式:
--    COMMENT ON 只寫 pg_description,不碰 pg_proc.prosrc,所以 #878 的函式指紋、
--    security definer / search_path / ACL 全部不變。
-- 📌 註解內容逐字沿用 repo 裡最後一版的原文,只替換用語:
--    「服務人員/師傅」→「服務人員」、「師傅報表」→「服務人員報表」(與 #878 一致)、
--    「某位師傅/該師傅」→「某位服務人員/該服務人員」、「店長」→「商家管理員」。
-- 📌 protect_merchant_staff_identity_columns 的註解:正式庫現存版本(733 字)跟 repo 最後一版
--    20260924030100 的原文(841 字)不一致(套用當時被縮短過);這裡以 repo 原文為準,
--    套用後兩邊會重新一致。

-- 原文:20260916100000_staff_agent_schema.sql 第 48 行
comment on table public.merchant_staff is '服務人員(對應規格書 1.1)。多對多:同一人可同時服務多間商家。這次不開放登入(規則 2.2),user_id 多半為 NULL,保留欄位為未來認領帳號流程鋪路。';

-- 原文:20260920120100_payroll_billing_functions.sql 第 81 行
comment on function private.can_view_staff_report(uuid) is '是否能檢視該商家的服務人員報表(模組 8,規則 2.9):商家管理員永遠可以,或是該商家目前有效的客服且被開通 staff_report 這個 section_key。只給 RLS 政策/get_staff_commission_summary/get_staff_monthly_payroll_summary 內部呼叫,不對外暴露。';

-- 原文:20260924030100_merchant_staff_identity_columns_insert_guard.sql 第 150 行
comment on function private.protect_merchant_staff_identity_columns() is '2026-09-24 安全修補(A3 + INSERT 面補強):擋下非商家管理員對 merchant_staff.user_id / login_status 的寫入,INSERT 與 UPDATE 兩面都擋。UPDATE 面(原 A3):RLS 的 merchant_staff_update 是整列層級,被授權 staff_management 的客服可以把某位服務人員的 user_id 改成自己,藉此透過 private.is_own_staff_row 取得該服務人員的薪資/抽成/客戶個資。INSERT 面(本次):merchant_staff_insert 同樣是整列層級,客服可以直接打 PostgREST 新增一筆 user_id=自己、login_status=active 的紀錄,憑空造出「一個自己」拿到同樣的資料。判斷方式在兩個 tg_op 下不同——UPDATE 看「值有沒有被改動」(is distinct from old),INSERT 看「有沒有帶非預設值」(user_id 預設 NULL、login_status 預設 not_invited),因為 INSERT 時 old 是 NULL 不能沿用。保護清單刻意只有這兩個「身分綁定」欄位——status(軟刪除)是使用者 2026-09-23 明確授權給客服的功能,compensation_type 不構成提權路徑。放行路徑仍是兩條:service_role,以及 transaction-local 旗標 staff_agent.bypass_staff_identity_guard。經盤點,目前沒有任何合法路徑會帶著 user_id/login_status 去 INSERT merchant_staff(邀請流程走 record_invited_staff_login 的 UPDATE),前端 createMerchantStaff 也不帶這兩欄,所以客服的正常新增流程不受影響。';

-- 原文:20260924020200_merchants_group_id_guard.sql 第 73 行
comment on function private.protect_merchants_group_id_column() is '2026-09-24 安全修補(A4):擋下非平台管理員對 merchants.group_id 的異動。merchants_update 政策只判斷 id、不限制欄位,商家管理員原本可以自己把店搬到別的集團,導致原集團管理者的 private.is_merchant_admin() 立刻失效、永久失去存取且無法自行修復。放行路徑:service_role,或 transaction-local 旗標 platform_admin.bypass_merchant_group_guard(預留給未來的「商家轉移集團」功能)。';
