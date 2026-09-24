-- 模組 15 擴充:手機推播擴及三種角色 — 測試推播的送達回報(ack)
-- 對應規格書 §6.3(送達回報)、§6.4(公開端點與 token 規則)。需求編號 #739、#740。

-- =========================================================================
-- ⚠️ 規格書沒有定義、但 §6.4 第 3 點做不到就會卡住的一個欄位(這裡說明為什麼要加)
--
-- §6.4 第 3 點要求「ack 抵達時,同時更新**對應裝置**的 push_subscriptions.last_seen_at」。
-- 但 §2.4 定義的 push_notification_log 欄位裡,沒有任何一欄記得「這一列是發給哪一台裝置的」
-- —— target_type/target_id 記的是「收件人是誰」,而一個人可以有很多台裝置,
-- push-send-test 是「一台裝置一列 log、一列一個 ack_token」。
--
-- 沒有 token → 裝置 的對應,就只能在 ack 進來時更新「這個人全部的裝置」,那等於謊報:
-- 明明只有一台回報,卻把三台都標成「最後收到通知」。
--
-- 所以這裡加一個 nullable 的 ack_subscription_id。它只有測試推播會填,對既有資料是無害的新增。
-- =========================================================================
alter table public.push_notification_log
  add column ack_subscription_id uuid references public.push_subscriptions(id) on delete set null;

comment on column public.push_notification_log.ack_subscription_id is '§6.4 第 3 點:這一列的測試推播是發給哪一台裝置。只有 event_type=''test'' 會填,用來在 ack 進來時精準更新那一台裝置的 last_seen_at(不是把這個人全部的裝置都標成收到)。';

-- =========================================================================
-- §6.4 ack_push_test_notification(p_ack_token uuid)
--
-- 一次性 + 10 分鐘有效。回傳 boolean 只是給 Edge Function 寫 server log 用的,
-- **Edge Function 不論回傳什麼都一律回 204**(§6.4 第 4 點:任何差異化的回應都是一個
-- 可以拿來窮舉 token 的訊號)。
--
-- ⚠️ 只有 service role 能呼叫:這支函式是無登入端點的後端,絕對不能開給 anon/authenticated。
-- =========================================================================
create or replace function public.ack_push_test_notification(p_ack_token uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_subscription_id uuid;
  v_updated int;
begin
  if p_ack_token is null then
    return false;
  end if;

  update public.push_notification_log
  set acked_at = now()
  where ack_token = p_ack_token
    and acked_at is null
    and attempted_at > now() - interval '10 minutes'
  returning ack_subscription_id into v_subscription_id;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  if v_subscription_id is not null then
    update public.push_subscriptions
    set last_seen_at = now()
    where id = v_subscription_id;
  end if;

  return true;
end;
$$;

comment on function public.ack_push_test_notification(uuid) is '§6.4:測試推播的送達回報。一次性(acked_at is null)、10 分鐘有效。同時更新那一台裝置的 last_seen_at。只有 service role 能呼叫——呼叫它的 push-test-ack 是一支 verify_jwt=false 的公開端點,權限完全靠不可猜測的一次性 token。';

revoke execute on function public.ack_push_test_notification(uuid) from public, anon, authenticated;
grant execute on function public.ack_push_test_notification(uuid) to service_role;
