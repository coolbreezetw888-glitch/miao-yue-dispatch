-- 深夜自主巡檢批次(2026-09-24)資料庫層權限衛生修補,共三件事:
--   A1 resolve_line_notification_targets 對 authenticated 的 EXECUTE(真實可利用的外洩漏洞)
--   A2 recalculate_booking_commission 對 PUBLIC/anon 的 EXECUTE(目前不可利用,純權限衛生)
--   A5 6 條 merchant_staff / merchant_staff_service_items 政策漏寫 to authenticated(角色落在 PUBLIC)
--
-- =========================================================================
-- §A1:收回 public.resolve_line_notification_targets(uuid, text, uuid, uuid)
--      對 authenticated 的 EXECUTE。
--
-- 【問題】
-- 原始定義在 20260920160400_line_notifications_dispatch_functions.sql:22,檔尾(:145)的收權
-- 只寫了 `revoke execute ... from public, anon;`——漏掉了 authenticated。而 Supabase 專案裡
-- authenticated 這個角色本來就會拿到 PUBLIC 的預設 EXECUTE,單純 revoke from public 並不會
-- 讓 authenticated 失去權限(PostgreSQL 的 PUBLIC 是「所有角色」的集合,revoke from public
-- 只拿掉「來自 PUBLIC 的那一份」,但 authenticated 在 Supabase 的初始化腳本裡另外被賦予了
-- public schema 上的預設權限,實測結果 has_function_privilege('authenticated', ...) 仍為 true)。
--
-- 【攻擊情境(已在正式環境用唯讀查詢確認權限確實是開的)】
-- 任何持有有效 JWT 的登入者——不需要是管理員、不需要任何 section_key 開關,連別家商家的客服
-- 或服務人員都算——可以直接打 POST /rest/v1/rpc/resolve_line_notification_targets,body 裡
-- 帶入「任意」的 p_merchant_id,就能拿到那間商家全部管理員/客服的姓名與 line_user_id。
-- 這支函式是 SECURITY DEFINER,而且內部「完全沒有任何權限檢查」(它預設呼叫者已經被外層
-- 把關了),所以一旦直接曝光就是無差別的跨商家個資外洩。
--
-- 【為什麼收掉 authenticated 不會弄壞前端】
-- 設計上真正給前端用的是同一支 migration :150 的包裝函式
-- public.preview_line_notification_targets(uuid, text)——它有 private.can_manage_bookings
-- 權限檢查,而且只回傳 {type, name},刻意濾掉 line_user_id。它是 SECURITY DEFINER,函式內部
-- 對 resolve_line_notification_targets 的呼叫是以「函式擁有者(postgres)」的身份執行,
-- 不受 authenticated 權限變動影響。Edge Function line-notify-dispatch 走 service_role,
-- 下面明確保留 service_role 的 EXECUTE。
-- 前端原始碼(src/)完全沒有直接呼叫 resolve_line_notification_targets,只有自動產生的
-- types.ts 提到它的型別。
-- =========================================================================
revoke execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_line_notification_targets(uuid, text, uuid, uuid)
  to service_role;

comment on function public.resolve_line_notification_targets(uuid, text, uuid, uuid) is '3.10 邊界情況:preview_line_notification_targets(前端預覽)跟 line-notify-dispatch(實際發送判斷)共用的唯一一份判斷邏輯,避免兩邊分岔造成「彈窗說會通知,結果沒有通知」。⚠️ 函式內部完全沒有權限檢查,只能給 service_role(Edge Function)直接呼叫,前端一律走有 can_manage_bookings 檢查、且會濾掉 line_user_id 的 preview_line_notification_targets 包裝函式。2026-09-24 安全修補:原本漏掉 revoke authenticated,導致任何登入者都能帶任意 merchant_id 撈走該商家所有管理員/客服的 line_user_id。';

-- =========================================================================
-- §A2:收回 public.recalculate_booking_commission(uuid) 對 PUBLIC / anon 的 EXECUTE。
--
-- 【問題】
-- 20260922110900_req2_recalculate_booking_commission_rewrite.sql 用 drop + create 換了簽章
-- 重寫這支函式,檔尾只補回 `grant execute ... to authenticated;`,沒有補 revoke——而
-- PostgreSQL 對「新建」函式一律預設 grant execute to PUBLIC,所以重寫之後 anon 又拿回了
-- EXECUTE(線上實測 has_function_privilege('anon', ...) = true)。
--
-- 【目前是否可被利用】
-- 不可利用。函式第一段就有 private.is_merchant_admin(...) 檢查,anon 的 auth.uid() 是 null,
-- 必定拋出 42501。這裡純粹是權限衛生:不該對外曝光的 RPC 端點不要留在 anon 可打的清單裡,
-- 避免之後有人把內部檢查重構掉時直接變成真漏洞。
--
-- 【authenticated 保留】
-- 這支函式本來就是給前端(商家管理員在訂單頁按「重新計算抽成」)呼叫的,authenticated 必須留著。
-- =========================================================================
revoke execute on function public.recalculate_booking_commission(uuid) from public, anon;
grant execute on function public.recalculate_booking_commission(uuid) to authenticated;

-- =========================================================================
-- §A5:6 條政策補上 `to authenticated`。
--
-- 【問題】
-- 20260923050000_staff_management_agent_permission.sql 重建這 6 條政策時沒有寫 `to authenticated`
-- (:37 :50 :55 :64 :79 :94),PostgreSQL 因此把 polroles 記成 {0}(PUBLIC),跟專案其他
-- 政策(例如同一支 migration 之外的 industry_feature_presets_* 都有明確寫 to authenticated)
-- 不一致。
--
-- 【目前是否可被利用】
-- 不可利用。6 條政策的判斷式全部都是 private.is_*(...) 這類需要 auth.uid() 的函式,anon 的
-- auth.uid() 為 null,結果必定是 false。純粹是一致性/可稽核性問題:政策清單上看起來像是
-- 「開放給所有角色」,會誤導之後做安全稽核的人。
--
-- 【修法】
-- 原封不動照抄 20260923050000 的判斷式(using/with check 一字不改),只多加 `to authenticated`。
-- 先 drop 再 create(不用 alter policy),維持跟原始 migration 完全一致的撰寫風格,方便日後
-- 直接 diff 比對兩個版本的判斷式。
-- =========================================================================

drop policy if exists merchant_staff_select on public.merchant_staff;
create policy merchant_staff_select on public.merchant_staff
  for select
  to authenticated
  using (
    private.is_merchant_admin(merchant_id)
    or private.can_manage_bookings(merchant_id)
    or private.can_manage_team_leave(merchant_id)
    or private.can_manage_commission_settings(merchant_id)
    or private.can_view_payroll_reports(merchant_id)
    or private.can_manage_staff(merchant_id)
    or (user_id = auth.uid())
  );

drop policy if exists merchant_staff_insert on public.merchant_staff;
create policy merchant_staff_insert on public.merchant_staff
  for insert
  to authenticated
  with check (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id));

drop policy if exists merchant_staff_update on public.merchant_staff;
create policy merchant_staff_update on public.merchant_staff
  for update
  to authenticated
  using (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id))
  with check (private.is_merchant_admin(merchant_id) or private.can_manage_staff(merchant_id));

drop policy if exists merchant_staff_service_items_select on public.merchant_staff_service_items;
create policy merchant_staff_service_items_select on public.merchant_staff_service_items
  for select
  to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = merchant_staff_service_items.staff_id
        and (
          private.is_merchant_admin(ms.merchant_id)
          or private.can_manage_commission_settings(ms.merchant_id)
          or private.can_manage_staff(ms.merchant_id)
        )
    )
  );

drop policy if exists merchant_staff_service_items_insert on public.merchant_staff_service_items;
create policy merchant_staff_service_items_insert on public.merchant_staff_service_items
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = merchant_staff_service_items.staff_id
        and (
          private.is_merchant_admin(ms.merchant_id)
          or private.can_manage_commission_settings(ms.merchant_id)
          or private.can_manage_staff(ms.merchant_id)
        )
    )
  );

drop policy if exists merchant_staff_service_items_delete on public.merchant_staff_service_items;
create policy merchant_staff_service_items_delete on public.merchant_staff_service_items
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.merchant_staff ms
      where ms.id = merchant_staff_service_items.staff_id
        and (
          private.is_merchant_admin(ms.merchant_id)
          or private.can_manage_commission_settings(ms.merchant_id)
          or private.can_manage_staff(ms.merchant_id)
        )
    )
  );
