-- SPECS-INDEX #805:建單/改單/取消的推播與站內通知在正式環境從來沒有成功過一次。
--
-- 【根因】
-- push-notify-dispatch 用呼叫者自己的 JWT(anon key + Authorization 標頭的 callerClient)呼叫
-- `rpc("can_manage_bookings", { p_merchant_id })` 做授權檢查(index.ts:137)。但 can_manage_bookings
-- 一直只存在於 private schema(20260916140100_booking_functions.sql 3.1),而 PostgREST 只暴露
-- public(supabase/config.toml api.schemas = ["public", "graphql_public"]),所以這支 RPC 永遠回
-- PGRST202「找不到函式」,Edge Function 直接回 500,後面的發送與 push_notification_log /
-- user_notifications 寫入一行都不會執行。
--
-- 【修法 A(使用者 2026-09-26 裁決)】
-- 在 public 補一支同名、同簽章的包裝函式,內容只做一件事:轉呼叫 private.can_manage_bookings。
-- 完全比照既有先例 public.can_dispatch_line_notification(20260920160400_line_notifications_dispatch_functions.sql
-- 3.14),那支就是給 line-notify-dispatch 用呼叫者 JWT 呼叫的 public 包裝。
-- Edge Function 呼叫的名字本來就是 can_manage_bookings,所以不用改程式碼、也不用重新部署。
--
-- 【授權語意跟 private.can_manage_bookings 完全一致的依據】
-- 1. 兩支都是 security definer、owner 都是 postgres、都 set search_path = public、都 stable:
--    包一層之後執行身分沒有變(postgres → postgres),搜尋路徑沒有變,查到的表也是同一批。
-- 2. private.can_manage_bookings 的判斷只依賴 auth.uid()(讀 request.jwt.claims 這個 session 設定)
--    跟 merchant_admins / merchant_agents / merchant_agent_permissions 的資料;security definer 不會改動
--    session 設定,所以 auth.uid() 在包裝層與內層讀到的是同一個值。
-- 3. 這支不加任何額外條件、也不拿掉任何條件,回傳值 = private.can_manage_bookings 的回傳值。
--
-- 【權限(supabase-permission-hygiene 規則 1)】
-- 新函式會自動繼承 PUBLIC EXECUTE,一定要明寫 revoke。這支的設計對象就是「已登入的呼叫者」
-- (Edge Function 拿呼叫者 JWT 來問「這個人能不能管這間商家的預約」),所以 grant 給 authenticated 是
-- 刻意的、跟 can_dispatch_line_notification 一樣;anon / PUBLIC 一律收掉。它只回傳一個 boolean,
-- 而且只回答「呼叫者自己」的權限,不會洩漏任何其他資料。
create or replace function public.can_manage_bookings(p_merchant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select private.can_manage_bookings(p_merchant_id);
$$;

comment on function public.can_manage_bookings(uuid) is '#805:給 push-notify-dispatch 用呼叫者 JWT 呼叫的 public 包裝,判斷呼叫者能不能建立/修改/取消該商家的預約(商家管理員永遠可以,或該商家目前有效且被開通 orders 權限的客服)。內容只轉呼叫 private.can_manage_bookings,授權語意完全相同;比照 public.can_dispatch_line_notification 的先例。';

revoke execute on function public.can_manage_bookings(uuid) from public, anon;
grant execute on function public.can_manage_bookings(uuid) to authenticated;
