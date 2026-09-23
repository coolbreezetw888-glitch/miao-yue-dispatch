-- 使用者決策(2026-09-23):推翻模組 1 規則 2.1「產業模組建立後鎖定不可修改」。
--
-- 背景:原規則假設兩種產業模板(到府派工/到店服務)未來會有大量結構性差異,換產業要透過
-- 「產業轉移精靈」(模組 12,/app/industry-transfer,開一間新分店+挑選要搬遷的會員資料)這種
-- 重量級流程才安全。實際做到目前為止,唯一真的依照 industry_type 分支的行為只有一件事:
-- private.industry_requires_customer_address()——決定新增/編輯預約時「客戶地址」欄位要不要
-- 顯示/必填。使用者確認接受「同一間商家隨時切換產業模組,只影響往後新增/編輯預約這個欄位的
-- 顯示規則,不影響既有訂單」(舊訂單的 customer_address 本來就是 nullable,維持原樣即可,
-- 不需要任何資料搬遷或回填)。
--
-- 「產業轉移精靈」(模組 12)處理的是另一個獨立情境(開新分店取代舊分店、順便搬遷會員資料),
-- 跟這次「同一間商家原地切換產業」不衝突,不受這次異動影響,繼續保留原樣。

drop trigger if exists merchants_lock_industry_type on public.merchants;
drop function if exists public.prevent_industry_type_change();

comment on column public.merchants.industry_type is '商家目前的產業模組(on_site_dispatch=到府派工/in_store_beauty=到店服務)。2026-09-23 起可由商家管理員隨時在商家設定頁切換,不再鎖定(推翻原本的模組 1 規則 2.1)。目前唯一受影響的行為:private.industry_requires_customer_address() 決定新增/編輯預約時客戶地址欄位是否顯示/必填——切換不會更動既有訂單資料。';

comment on table public.merchants is '商家/分店(對應規格書 1.2)。industry_type 可由商家管理員隨時切換,不再鎖定(2026-09-23 起,見上面 industry_type 欄位註解)。';
