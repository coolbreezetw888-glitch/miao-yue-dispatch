-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\人員與權限管理.md §8.1/§8.2/§8.3
-- 對應 .project/SPECS-INDEX.md #595、#596
--
-- 背景:電話欄位這次改為必填、格式須符合台灣手機號碼(09 開頭、共 10 碼數字)。
-- 前端(src/lib/validation.ts::isValidTaiwanMobilePhone)與 Edge Function
-- (supabase/functions/_shared/phoneValidation.ts)的驗證已在前一批完成,唯獨資料庫層
-- 的 NOT NULL + CHECK 約束當時因為正式環境(wjtbmmnakcriuaqoknsq)有既有資料不符合新格式
-- 而暫緩(3 筆 merchant_staff 完全空白、1 筆 merchant_staff 存測試值「123」、
-- 1 筆 merchant_agents 存測試值「0900」)。
--
-- 這批既有資料已在套用這份 migration 之前,由主腦與 engineer 共同確認並人工處理完畢
-- (詳細處理記錄見本次回報/PROGRESS.md,摘要如下):
--   - merchant_staff「師傅1」(f1b91214-...):測試值「123」→ 改為佔位測試電話 0900000002,
--     status 維持 active(這是使用者自己的測試帳號)。
--   - merchant_agents「客服1」(634f4dd3-...):測試值「0900」→ 改為佔位測試電話 0900000003,
--     status 維持 active(同上,使用者自己的測試帳號)。
--   - merchant_staff「a」(ec4d0dcd-...)/「testb」(6535947e-...)/
--     「E2E產業轉移測試服務人員...」(6b228fee-...):電話完全空白 → 因為這幾筆本來就是
--     測試/空殼資料,不無中生有捏造電話,改為 status='removed'(軟刪除停用,schema 目前
--     只有 active/removed 兩種狀態,沒有獨立的「暫停」狀態,故以 removed 達成停用效果),
--     並補一個佔位電話(0900000004/0900000005/0900000006)只是為了滿足接下來的
--     NOT NULL 約束,這幾筆已停用不會再顯示給任何人。
--
-- 套用這份 migration 前已重新用 SELECT 核對過,確認全表已無 phone 為 NULL 或不符合
-- ^09\d{8}$ 格式的資料(含所有 status),此時加上 NOT NULL + CHECK 不會失敗。

alter table public.merchant_staff
  alter column phone set not null;

alter table public.merchant_staff
  add constraint merchant_staff_phone_tw_mobile_format
  check (phone ~ '^09\d{8}$');

alter table public.merchant_agents
  alter column phone set not null;

alter table public.merchant_agents
  add constraint merchant_agents_phone_tw_mobile_format
  check (phone ~ '^09\d{8}$');
