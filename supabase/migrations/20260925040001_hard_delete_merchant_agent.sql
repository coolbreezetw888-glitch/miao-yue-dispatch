-- SPECS-INDEX #798(規格書 .project/specs/客服編輯功能.md #798 + 第六節開放問題):
-- 客服的「真正刪除」(硬刪除)。
--
-- 【使用者裁決(2026-09-25)】
-- 規格書第六節原本建議「C:只做分頁籤、不做硬刪除」,使用者裁決「選 A+C」——分頁籤(#797)與
-- 真正刪除(#798)兩個都要做。原話:「選3 A+C,如果較複雜可以用Fable模組去執行」。
-- 情境:邀請信 Email 打錯字 → 對方永遠收不到 → 那一列永遠停在「邀請信已寄出」→ 移除只是軟移除,
-- 名單上永遠掛著一筆清不掉的幽靈資料。這支函式就是用來清掉它的。
--
-- 【做法:照抄服務人員的既有先例 public.hard_delete_merchant_staff(20260921160000 / 20260922150200)】
-- 命名、權限檢查順序、錯誤碼、錯誤文案的嚴謹度全部對齊,使用者不用多學一套操作:
--   1. 找不到 → P0001
--   2. 不是該商家管理員 → 42501(SECURITY DEFINER 函式內部自己檢查,不是只靠前端藏按鈕)
--   3. status 不是 'removed' → P0001(必須先軟移除,不能跳過)
--   4. 全部通過才 DELETE
--
-- 【外鍵盤點(2026-09-25 實查正式庫 pg_constraint,confrelid = merchant_agents)】
--   指向 merchant_agents.id 的外鍵**只有一條**:
--     merchant_agent_permissions.agent_id → ON DELETE CASCADE(20260916100000:115)
--   那是這位客服自己的「功能權限開關」設定列(跟服務人員的 merchant_staff_permissions 同一個性質),
--   不是歷史事實資料。服務人員的硬刪除先例也是讓同類的純設定表 cascade 清掉(它檢查的是
--   bookings / booking_assistants / staff_leave_records / booking_commission_records 這些**歷史事實表**,
--   客服沒有對應的歷史事實表——bookings 沒有 agent_id 欄位,建單人的紀錄是掛在 auth.users 上)。
--   ⇒ 這支函式不需要比照服務人員那五項「有歷史紀錄就擋下」的檢查,因為沒有任何一張歷史事實表
--     指向 merchant_agents。
--   ⚠️ 完全不動 auth.users:merchant_agents.user_id 是 references auth.users(id) on delete set null,
--      方向是 auth.users 被刪才影響 merchant_agents,不是反過來。刪掉這一列之後,
--      merchant_agents_merchant_user_unique (merchant_id, user_id) 這個 partial unique index 就釋放了,
--      同一個人之後可以被重新邀請。
--
-- 【權限衛生(.claude/skills/supabase-permission-hygiene 規則 1)】
-- 新函式會繼承 PostgreSQL 預設的 PUBLIC EXECUTE,所以一定要 revoke public / anon 再 grant authenticated
-- (這支函式本來就是給登入的商家管理員從前端呼叫,授權判斷在函式內部)。
-- 對應 pgTAP:supabase/tests/database/module3_06_hard_delete_merchant_agent.sql。

create or replace function public.hard_delete_merchant_agent(p_agent_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_status text;
begin
  select merchant_id, status into v_merchant_id, v_status
  from public.merchant_agents
  where id = p_agent_id;

  if not found then
    raise exception '找不到指定的客服紀錄' using errcode = 'P0001';
  end if;

  -- 只有該商家管理員能真正刪除(跟 remove_merchant_agent / restore_merchant_agent /
  -- hard_delete_merchant_staff 同一個授權層級)。客服本人也不行——這是不可復原的操作。
  if not private.is_merchant_admin(v_merchant_id) then
    raise exception '沒有權限執行此操作,僅限該商家管理員使用' using errcode = '42501';
  end if;

  -- 必須先軟移除(status = 'removed')才能真正刪除,不能從在職 / 邀請中直接跳到刪除。
  -- 這是刻意的兩段式防呆:畫面上「真正刪除」按鈕也只出現在已移除的那一列旁邊。
  if v_status <> 'removed' then
    raise exception '只能對已經移除的客服執行真正刪除,請先移除這位客服(軟刪除),確認不再需要之後再進行真正刪除。'
      using errcode = 'P0001';
  end if;

  -- 全部通過才真的 DELETE——讓 merchant_agent_permissions.agent_id 的 on delete cascade
  -- 自動清掉這位客服的權限開關設定列(唯一一條指向 merchant_agents 的外鍵)。完全不動 auth.users。
  delete from public.merchant_agents where id = p_agent_id;
end;
$$;

comment on function public.hard_delete_merchant_agent(uuid) is 'SPECS-INDEX #798(2026-09-25 使用者裁決「選 A+C」):客服的「真正刪除」(硬刪除),照抄 hard_delete_merchant_staff 的先例。只有 private.is_merchant_admin(該客服的 merchant_id) 可以呼叫(42501),而且只能對 status=removed 的客服操作(P0001,必須先軟移除)。指向 merchant_agents.id 的外鍵只有 merchant_agent_permissions.agent_id(on delete cascade,這位客服自己的權限開關設定),沒有任何歷史事實表指向 merchant_agents(bookings 沒有 agent_id),所以不需要比照服務人員那幾項「有歷史紀錄就擋下」的檢查。完全不動 auth.users;刪除後 (merchant_id, user_id) 的 partial unique index 釋放,同一個人可以被重新邀請。';

revoke all on function public.hard_delete_merchant_agent(uuid) from public, anon;
grant execute on function public.hard_delete_merchant_agent(uuid) to authenticated;
