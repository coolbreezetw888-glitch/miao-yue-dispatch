-- 模組 3:人員與權限管理 — 效能優化
-- 對應 Supabase 顧問(performance advisor)掃描結果的修正,不對應規格書新增需求:
--   1. 兩個外鍵欄位補上索引(merchant_agents.user_id、merchant_staff.user_id),
--      避免之後查詢量變大時全表掃描(比照模組 1 的既有做法,見 20260915100500)。
--   2. merchant_agents_select / merchant_agent_permissions_select 政策裡的 auth.uid()
--      改成 (select auth.uid()),避免每一列都重新求值一次(RLS 效能優化的標準寫法)。

create index if not exists idx_merchant_agents_user_id on public.merchant_agents (user_id);
create index if not exists idx_merchant_staff_user_id on public.merchant_staff (user_id);

alter policy merchant_agents_select on public.merchant_agents
  using (
    private.is_merchant_admin(merchant_id)
    or user_id = (select auth.uid())
  );

alter policy merchant_agent_permissions_select on public.merchant_agent_permissions
  using (
    exists (
      select 1 from public.merchant_agents ag
      where ag.id = agent_id
        and (private.is_merchant_admin(ag.merchant_id) or ag.user_id = (select auth.uid()))
    )
  );
