-- SPECS-INDEX #796(規格書 .project/specs/客服編輯功能.md #796):
-- 移除已廢棄的 public.update_my_agent_profile(p_merchant_id uuid, p_nickname text, p_job_title text)。
--
-- 【為什麼要刪】
-- 20260924040500_merchant_agent_update_and_restore.sql 檔頭 L41-46 自己就要求做這件事:
--   「補上 p_job_title 之後,update_my_agent_profile 能做的事(改自己的 nickname + job_title)已經被
--    update_merchant_agent 完全涵蓋……『兩支函式都能寫 nickname』本身就是一個隱性的不一致來源
--    (同一個欄位兩個入口、兩套授權判斷),留著遲早會有人只改其中一邊。」
--
-- 【動手前的查證(2026-09-25)】
--   ・grep -rn "update_my_agent_profile" src/ e2e/ supabase/ --exclude-dir=.claude:
--     src/ 只剩 src/modules/staff-agent/api.ts 一個標了 @deprecated 的包裝函式 updateMyAgentProfile(),
--     全 src/ 沒有任何地方 import 它(ManagePage.tsx L74 註解明說已不再 import);e2e/ 零命中;
--     supabase/ 只有 migration 註解與 pgTAP homepage_shell_01_self_profile_update.sql 在測它。
--   ・正式庫 pg_proc 實查:函式仍存在,ACL = postgres / authenticated / service_role(沒有 PUBLIC / anon)。
--   ⇒ 沒有任何真實呼叫端。前端包裝函式與 pgTAP 斷言在同一批一起收掉。
--
-- 【為什麼 drop 用完整簽章,而且後面還加一段檢查】
-- 這支函式從建立(20260916170000)到現在只有一個簽章 (uuid, text, text),drop 時明寫簽章是為了
-- 不會誤刪同名的其他重載(目前沒有,但寫清楚不吃虧)。drop 之後再檢查一次「同名函式是否還有殘留」,
-- 有的話直接讓 migration 失敗——寧可套用失敗,也不要留一支沒人知道的孤兒重載。

drop function if exists public.update_my_agent_profile(uuid, text, text);

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_my_agent_profile'
  ) then
    raise exception 'update_my_agent_profile 仍有其他重載殘留,請人工確認簽章後再處理,不要留下孤兒重載';
  end if;
end;
$$;
