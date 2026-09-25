-- SPECS-INDEX #794(規格書 .project/specs/客服編輯功能.md §2.2 / §2.3 / #794):
-- 絆線:守住「public.merchant_agents 是唯讀表」這個不變式。
--
-- 【為什麼需要這支測試】
-- merchant_agents 的所有欄位保護(登入帳號 user_id / invited_email、LINE 綁定 line_user_id、
-- pending_admin_login_email*)都建立在一件事上:**這張表對 authenticated 只有一條 SELECT policy,
-- 沒有任何 INSERT / UPDATE / DELETE policy**,所以前端不管怎麼 PATCH / POST / DELETE 都會被 RLS
-- 直接擋下,所有寫入一律走 SECURITY DEFINER 函式(update_merchant_agent / remove_merchant_agent /
-- restore_merchant_agent / hard_delete_merchant_agent / mark_agent_active_if_self / …)。
--
-- 對照組 merchant_staff 因為有 UPDATE policy,所以「必須」有欄位保護 trigger
-- (security_audit_02 / security_audit_04);merchant_agents 沒有寫入 policy,加 trigger 會是一支
-- 永遠不會被觸發的死程式碼——**正確做法不是加 trigger,而是守住「永遠沒有寫入 policy」**。
--
-- 只要之後有人為了某個看似合理的需求(例如「讓客服自己改暱稱比較快,不用走 RPC」)加上一條
-- UPDATE policy,這張表的欄位保護會在那一刻全部消失,而且沒有任何東西會響。這支測試就是那個會響的東西。
--
-- 【寫法:每一條「行為斷言」前面都先有「前提斷言」】
-- 本專案吃過兩次「空清單假通過」的虧:pg_policies 對打錯的表名會回 0 列,此時「沒有 UPDATE policy」
-- 這條會假通過。所以先證明查詢真的查得到東西,才輪到真正要驗的行為。
-- 第 ⑥⑦ 條(merchant_staff 對照組)是整支測試的自我驗證:證明「同一個查詢方法真的抓得到 UPDATE
-- policy」,不是因為查詢寫錯才到處都回 0。
--
-- 這支測試只讀系統目錄,不需要 fixture、不需要切換身份,所以沒有 test_set_auth helper。
begin;

select plan(7);

-- =========================================================================
-- ① 前提:pg_policies 真的查得到 merchant_agents(表名 / schema 沒打錯)。
-- =========================================================================
select cmp_ok(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'merchant_agents'),
  '>',
  0,
  '#794 ①(前提):pg_policies 查得到 public.merchant_agents 的 policy(> 0 列)——若這條紅了,代表表名或 schema 不對,底下的斷言都不可信'
);

-- =========================================================================
-- ② 行為:policy 總數恰好 = 1。
-- =========================================================================
select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'merchant_agents'),
  1,
  '#794 ②:merchant_agents 必須永遠只有 1 條 policy。它的所有欄位保護(登入帳號、LINE 綁定、pending_admin_login_email)都依賴「前端無法直接 PATCH 這張表」;一旦加上任何寫入 policy,必須同時補上比照 merchant_staff 的欄位保護 trigger,否則客服帳號可被劫持'
);

-- =========================================================================
-- ③ 行為:那唯一一條 policy 的 cmd 是 SELECT(一次驗完「只有 SELECT」且「沒有別的」)。
--    刻意不寫成三條各自 count(cmd='UPDATE') = 0——那樣新增一種 cmd(例如 ALL)時會漏掉。
-- =========================================================================
select is(
  (select array_agg(cmd order by cmd)::text from pg_policies where schemaname = 'public' and tablename = 'merchant_agents'),
  '{SELECT}',
  '#794 ③:merchant_agents 的 policy 集合必須恰好是 {SELECT}(沒有 INSERT / UPDATE / DELETE / ALL)。要開放寫入請走 SECURITY DEFINER 函式,不要開表層 policy'
);

-- =========================================================================
-- ④ 前提:pg_class 查得到這張表(relkind = r 一般資料表)。
-- =========================================================================
select is(
  (select count(*)::int
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'merchant_agents' and c.relkind = 'r'),
  1,
  '#794 ④(前提):pg_class 查得到 public.merchant_agents 這張一般資料表(= 1 列)'
);

-- =========================================================================
-- ⑤ 行為:RLS 真的有開。只驗「沒有寫入 policy」是不夠的——RLS 被關掉的話,
--    零 policy 等於完全開放(authenticated 在表層有 DELETE / UPDATE 的 grant),比有 policy 更慘。
-- =========================================================================
select ok(
  (select c.relrowsecurity
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'merchant_agents'),
  '#794 ⑤:merchant_agents 的 RLS 必須是開啟狀態(relrowsecurity = true)。RLS 關掉之後「只有 SELECT policy」就沒有意義了,authenticated 會直接拿到表層 grant 的 UPDATE / DELETE'
);

-- =========================================================================
-- ⑥⑦ 對照組(自我驗證):merchant_staff 確實有 UPDATE policy,證明上面的查詢方法真的抓得到
--    UPDATE policy。沒有這兩條,①~③ 可能因為查詢寫錯而全部假通過。
-- =========================================================================
select cmp_ok(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'merchant_staff'),
  '>',
  0,
  '#794 ⑥(對照組前提):pg_policies 查得到 public.merchant_staff 的 policy(> 0 列)'
);

select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'merchant_staff' and cmd = 'UPDATE'
  ),
  '#794 ⑦(對照組):merchant_staff 確實有 UPDATE policy——證明這支測試查 cmd 的方法真的抓得到 UPDATE policy,merchant_agents 那邊回 {SELECT} 不是因為查詢寫錯'
);

select * from finish();

rollback;
