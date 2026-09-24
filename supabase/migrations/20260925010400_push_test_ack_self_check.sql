-- 模組 15 擴充:手機推播擴及三種角色 — 修正 1(品管 2026-09-25 上線後複查抓到的功能缺陷)
-- 對應規格書 §6.3 第 4 點(前端輪詢 acked_at)。需求編號 #739。
--
-- =========================================================================
-- 🔴 這支函式在修什麼(不是重構,是一個會讓主要使用者看到假警告的真缺陷)
--
-- §6.3 的送達回報有兩條路:
--   主路徑 —— service worker 收到推播時 postMessage 給所有開著的分頁;
--   備援 —— 前端每 3 秒查一次「我剛剛那幾個 ack_token 有沒有被標記成已送達」。
--
-- 備援原本直接查 public.push_notification_log,但那張表的 SELECT 政策是
--   private.can_manage_push_notification(merchant_id)
--     = private.is_merchant_admin(merchant_id)
--       OR (該商家在職客服 AND merchant_agent_permissions.section_key='push_notification' AND granted)
--
-- **服務人員完全不在這個判斷裡**,而客服那條路徑目前也走不通(2026-09-25 查正式環境:
-- merchant_agent_permissions 是 0 筆,沒有任何客服被開通過任何權限)。
--
-- 後果:備援機制實際上只對商家管理員有效。服務人員查到的是 0 列,而且 RLS 是「靜默過濾」
-- 不是丟錯 —— 前端拿到空陣列、判定「還沒回報」,15 秒後必定落到「⚠️ 通知已送出,但系統
-- 沒有收到你裝置的回報」。**而服務人員正是這個功能的主要使用者**(模組 14 的定位就是手機為主)。
-- 主路徑在「使用者就站在這一頁按開啟通知」時會通,所以會踩到的是 iOS PWA 分頁被系統暫停、
-- 或使用者切走再回來的情況 —— 那時他會看到一個**假警告**。
--
-- 🔴 修法刻意**不是**放寬 push_notification_log 的 RLS。
--    那張表的 SELECT 語意是「商家層級的發送記錄稽核」,放寬等於順手改掉「誰能看發送記錄」
--    這件事(而且會讓服務人員看得到全店每一筆發送記錄)。改成開一個只回 boolean 的窄窗口,
--    完全比照 §2.6 get_merchant_push_event_enabled_map 的既有做法。
-- =========================================================================
create or replace function public.have_my_test_pushes_been_acked(p_ack_tokens uuid[])
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1
    from public.push_notification_log l
    where auth.uid() is not null
      and p_ack_tokens is not null
      and array_length(p_ack_tokens, 1) between 1 and 50
      and l.ack_token = any(p_ack_tokens)
      and l.acked_at is not null
      and (
        (l.target_type = 'admin' and l.target_id in (
          select a.id from public.merchant_admins a where a.user_id = auth.uid()))
        or (l.target_type = 'agent' and l.target_id in (
          select g.id from public.merchant_agents g
          where g.user_id = auth.uid() and g.status = 'active'))
        or (l.target_type = 'staff' and l.target_id in (
          select s.id from public.merchant_staff s
          where s.user_id = auth.uid() and s.status = 'active' and s.login_status = 'active'))
      )
  );
$$;

comment on function public.have_my_test_pushes_been_acked(uuid[]) is '§6.3 第 4 點:前端輪詢「我剛剛那幾則測試通知有沒有任何一則回報送達」。只回一個 boolean,不回傳任何記錄內容。身分一律從 auth.uid() 反查(§4.1),而且只比對「這一列的收件人就是我本人」—— 帶別人的 ack_token 進來一律回 false。存在的理由:push_notification_log 的 SELECT RLS 是商家層級的稽核語意(can_manage_push_notification),服務人員與未開通權限的客服讀不到,直接查會靜默回 0 列、讓他們永遠看到「沒收到回報」的假警告。刻意不放寬那張表的 RLS,改開這個只回 boolean 的窄窗口。';

-- supabase-permission-hygiene 規則 1:revoke 要包含 public 與 anon;這一支必須給 authenticated
-- (它就是給登入使用者的前端呼叫的),但函式內部已經用 auth.uid() 把範圍鎖死在本人身上。
revoke execute on function public.have_my_test_pushes_been_acked(uuid[]) from public, anon;
grant execute on function public.have_my_test_pushes_been_acked(uuid[]) to authenticated;
