-- 模組 1:商家與集團管理 — 效能優化
-- 對應 Supabase 顧問(performance advisor)掃描結果的修正，不對應規格書新增需求：
--   1. 三個外鍵欄位補上索引(groups.group_admin_user_id、merchant_admins.user_id、merchants.group_id)，
--      避免之後查詢量變大時全表掃描。
--   2. groups_update_by_group_admin 政策裡的 auth.uid() 改成 (select auth.uid())，
--      避免每一列都重新求值一次，大量資料時效能較好(RLS 效能優化的標準寫法)。

create index if not exists idx_groups_group_admin_user_id on public.groups (group_admin_user_id);
create index if not exists idx_merchant_admins_user_id on public.merchant_admins (user_id);
create index if not exists idx_merchants_group_id on public.merchants (group_id);

drop policy if exists groups_update_by_group_admin on public.groups;
create policy groups_update_by_group_admin on public.groups
  for update to authenticated
  using (group_admin_user_id = (select auth.uid()))
  with check (group_admin_user_id = (select auth.uid()));
