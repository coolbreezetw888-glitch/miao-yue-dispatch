-- SPECS-INDEX #976 第 3 批(2026-10-06):新增「再行銷通知」客服權限(section_key = 'line_marketing')。
-- 規格書「權限收緊與服務人員開關修正-第3批」第二節。
--
-- 改前:再行銷通知只給商家管理員 —— 頁面 RequireMerchantAdmin、Edge Function line-send-marketing 用
--       am_i_merchant_admin 檢查;可選名單直接讀 members 表(要會員管理或訂單權限才讀得到)。
-- 改後:商家管理員,或 line_marketing 權限開啟的在職客服,三個地方用同一個判斷 private.can_send_line_marketing:
--   ① 名單:public.list_line_marketable_members(只回傳畫面需要的 5 個欄位,不開放 members 表層 SELECT)
--   ② 發送:Edge Function line-send-marketing 改呼叫 public.am_i_allowed_line_marketing(本檔新增)
--   ③ 會員等級篩選:merchant_member_tiers 的 SELECT 政策多放行 can_send_line_marketing
--      (頁面上「依會員等級挑選」要讀等級清單;這張表只有名稱 / 排序 / 狀態,沒有個資)
-- 既有客服預設關閉:merchant_agent_permissions 沒有這個 key 的列 = 沒開(useAgentPermission 預設 false),
-- 本檔不寫入任何授權資料。
--
-- ⚠️ 本檔沒有任何資料寫入,只有函式與政策。

-- =========================================================================
-- private.can_send_line_marketing
-- =========================================================================
create or replace function private.can_send_line_marketing(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    private.is_merchant_admin(p_merchant_id)
    or exists (
      select 1
      from public.merchant_agents ma
      join public.merchant_agent_permissions map on map.agent_id = ma.id
      where ma.merchant_id = p_merchant_id
        and ma.user_id = auth.uid()
        and ma.status = 'active'
        and map.section_key = 'line_marketing'
        and map.granted = true
    );
$$;

comment on function private.can_send_line_marketing(uuid) is 'SPECS-INDEX #976(2026-10-06):再行銷通知的後端權限 = 商家管理員,或 line_marketing 權限開啟的在職客服。跟前端 RequireLineMarketingAccess 同一個判斷。';

-- RLS 政策(merchant_member_tiers_select)會在呼叫者身分下執行 ⇒ authenticated 保有 EXECUTE,比照其他 private.can_*。
revoke execute on function private.can_send_line_marketing(uuid) from public, anon;
grant execute on function private.can_send_line_marketing(uuid) to authenticated;

-- =========================================================================
-- public.am_i_allowed_line_marketing:給 Edge Function 以「呼叫者身分」檢查(比照 am_i_merchant_admin)
-- =========================================================================
create or replace function public.am_i_allowed_line_marketing(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.can_send_line_marketing(p_merchant_id);
$$;

comment on function public.am_i_allowed_line_marketing(uuid) is 'SPECS-INDEX #976(2026-10-06):目前登入者能不能對這間商家發送再行銷通知(管理員或 line_marketing 客服)。給 Edge Function line-send-marketing 用呼叫者的 JWT 檢查。';

revoke execute on function public.am_i_allowed_line_marketing(uuid) from public, anon;
grant execute on function public.am_i_allowed_line_marketing(uuid) to authenticated;

-- =========================================================================
-- public.list_line_marketable_members:再行銷通知頁的可選名單
-- 範圍跟改前 fetchMarketableMembers 相同:這間商家 line_bound = true 且 status = 'active' 的會員,依姓名排序。
-- 只回傳畫面用到的 id / name / phone / tier_id / is_blacklisted(不回 line_user_id —— 那只有 Edge Function 用 service_role 查)。
-- =========================================================================
create or replace function public.list_line_marketable_members(p_merchant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not private.can_send_line_marketing(p_merchant_id) then
    raise exception '沒有權限使用這間商家的再行銷通知' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', m.id,
        'name', m.name,
        'phone', m.phone,
        'tier_id', m.tier_id,
        'is_blacklisted', m.is_blacklisted
      )
      order by m.name, m.id
    )
    from public.members m
    where m.merchant_id = p_merchant_id
      and m.line_bound = true
      and m.status = 'active'
  ), '[]'::jsonb);
end;
$$;

comment on function public.list_line_marketable_members(uuid) is 'SPECS-INDEX #976(2026-10-06):再行銷通知頁的可選會員名單(已綁定 LINE、有效會員)。權限 private.can_send_line_marketing。唯讀,不回傳 line_user_id。';

revoke execute on function public.list_line_marketable_members(uuid) from public, anon;
grant execute on function public.list_line_marketable_members(uuid) to authenticated;

-- =========================================================================
-- merchant_member_tiers 讀取:多放行再行銷通知(會員等級篩選)
-- =========================================================================
drop policy if exists merchant_member_tiers_select on public.merchant_member_tiers;
create policy merchant_member_tiers_select on public.merchant_member_tiers
  for select to authenticated
  using (
    private.can_manage_members(merchant_id)
    or private.can_manage_member_settings(merchant_id)
    or private.can_send_line_marketing(merchant_id)
  );
