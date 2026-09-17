-- 跨模組修正批次「首頁外殼與主題色優化」第一節 1.3。
-- 對應規格書 `.project/specs/首頁外殼與主題色優化.md` 一、1.3:
--   - merchant_admins 新增 display_name / job_title(nullable),給首頁個人資料卡片使用。
--   - merchant_agents 新增 job_title(nullable),姓名/暱稱沿用既有的 name/nickname 欄位。
--   - 新增 2 支 SECURITY DEFINER RPC,讓使用者自助編輯「自己那一列」的個人資料——
--     這兩支函式檢查的是「呼叫者是不是這筆紀錄本人」(auth.uid() = user_id),是所有權判斷,
--     不是「是不是管理員」這種權限判斷,刻意不使用 private.is_merchant_admin。
-- 不需要額外的 RLS SELECT 政策調整:merchant_admins/merchant_agents 現有的 SELECT 政策
-- (is_merchant_admin(merchant_id) 或 user_id = auth.uid())已經足夠讓使用者查到自己這一列,
-- 這兩個新欄位只是多了欄位,沿用既有政策即可。

-- =========================================================================
-- 欄位新增
-- =========================================================================
alter table public.merchant_admins add column display_name text;
alter table public.merchant_admins add column job_title text;

comment on column public.merchant_admins.display_name is '對應規格書「首頁外殼與主題色優化」1.3:管理員自訂的姓名/暱稱,首頁個人資料卡片顯示用,沒填時前端 fallback 顯示帳號 email 的 @ 前半段。';
comment on column public.merchant_admins.job_title is '對應規格書「首頁外殼與主題色優化」1.3:管理員自訂的職位,沒填時前端 fallback 顯示「商家管理員」。';

alter table public.merchant_agents add column job_title text;

comment on column public.merchant_agents.job_title is '對應規格書「首頁外殼與主題色優化」1.3:客服自訂的職位,沒填時前端 fallback 顯示「客服」。姓名/暱稱沿用既有的 name/nickname 欄位,不重複新增。';

-- =========================================================================
-- update_my_admin_profile(p_merchant_id uuid, p_display_name text, p_job_title text)
-- 只允許更新「呼叫者自己」在指定商家的 merchant_admins 那一列——用 auth.uid() = user_id 比對,
-- 不是檢查呼叫者是不是這間商家的管理員(呼叫者當然是,因為這是他自己那筆 merchant_admins
-- 紀錄本身;重點是「不能夾帶別人的 merchant_id/user_id 改到別人的列」,所以判斷條件必須落在
-- user_id = auth.uid() 上,不能只檢查 is_merchant_admin(p_merchant_id) 就放行——那樣的話同一間店
-- 的另一位管理員也能改到這個人的個人資料,不符合「只能改自己」的所有權語意)。
-- 找不到符合條件的列(帶錯 merchant_id、或這個人根本不是這間店的管理員)一律拋出錯誤,
-- 不會誤改到別人的資料,也不會靜默失敗。
-- =========================================================================
create or replace function public.update_my_admin_profile(
  p_merchant_id uuid,
  p_display_name text,
  p_job_title text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  update public.merchant_admins
  set display_name = nullif(trim(p_display_name), ''),
      job_title = nullif(trim(p_job_title), '')
  where merchant_id = p_merchant_id
    and user_id = auth.uid();

  if not found then
    raise exception '找不到你在這間商家的管理員紀錄,無法更新' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.update_my_admin_profile(uuid, text, text) is '對應規格書「首頁外殼與主題色優化」1.3:管理員自助編輯自己的姓名/職位。只檢查呼叫者是不是這筆 merchant_admins 紀錄本人(auth.uid() = user_id),是所有權判斷,不是 private.is_merchant_admin 那種權限判斷。';

revoke execute on function public.update_my_admin_profile(uuid, text, text) from public, anon;
grant execute on function public.update_my_admin_profile(uuid, text, text) to authenticated;

-- =========================================================================
-- update_my_agent_profile(p_merchant_id uuid, p_nickname text, p_job_title text)
-- 同樣邏輯,檢查呼叫者是不是這筆 merchant_agents 紀錄本人的 user_id。
-- =========================================================================
create or replace function public.update_my_agent_profile(
  p_merchant_id uuid,
  p_nickname text,
  p_job_title text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '需要登入才能執行此操作' using errcode = '28000';
  end if;

  update public.merchant_agents
  set nickname = nullif(trim(p_nickname), ''),
      job_title = nullif(trim(p_job_title), '')
  where merchant_id = p_merchant_id
    and user_id = auth.uid();

  if not found then
    raise exception '找不到你在這間商家的客服紀錄,無法更新' using errcode = 'P0002';
  end if;
end;
$$;

comment on function public.update_my_agent_profile(uuid, text, text) is '對應規格書「首頁外殼與主題色優化」1.3:客服自助編輯自己的暱稱/職位。只檢查呼叫者是不是這筆 merchant_agents 紀錄本人(auth.uid() = user_id)。';

revoke execute on function public.update_my_agent_profile(uuid, text, text) from public, anon;
grant execute on function public.update_my_agent_profile(uuid, text, text) to authenticated;
