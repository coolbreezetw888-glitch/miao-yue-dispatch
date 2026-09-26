-- SPECS-INDEX #806(從 #805 的根因延伸):
-- 絆線:Edge Function 用「呼叫者身分」(anon key + 呼叫者 JWT 的 callerClient)呼叫的每一支 RPC,
-- 都必須 (1) 存在於 public schema、(2) authenticated 有 EXECUTE 權限。
--
-- 【為什麼需要這支測試】
-- #805:push-notify-dispatch 呼叫 rpc("can_manage_bookings"),但那支函式只存在於 private schema。
-- PostgREST 只暴露 public,所以這支 RPC 永遠回 PGRST202,Edge Function 直接回 500,
-- 建單/改單/取消的推播與站內通知在正式環境**從來沒有成功過一次**。
-- 它能活這麼久,是因為 Deno 測試注入假的 createCallerClient —— 假 client 對任何名字都乖乖回傳預設值,
-- 「RPC 名稱打不打得到真資料庫」這件事從來沒有被驗證過。這支測試就是拿真資料庫補上那一層。
--
-- 【清單怎麼來、怎麼維護】
-- 清單 = grep 全部 supabase/functions/**/*.ts 裡用 callerClient 呼叫的 .rpc("...")(2026-09-26 掃描結果):
--   invite-merchant-agent / invite-merchant-staff / line-send-marketing / line-test-connection → am_i_merchant_admin(p_merchant_id)
--   line-notify-dispatch                                                                       → can_dispatch_line_notification(p_merchant_id, p_event_type)
--   push-notify-dispatch                                                                       → can_manage_bookings(p_merchant_id)
--   push-send-test                                                                             → get_my_push_identity(p_merchant_id) / count_my_recent_test_pushes(p_merchant_id)
-- ⚠️ 只列 callerClient 的呼叫。adminClient(service role)的 .rpc(...) 不受這條限制(service role 可以直接打
--    private schema 以外的任何 public 函式,而且不受 EXECUTE grant 限制),混進來會變成一堆假警報。
-- ⚠️ 之後任何 Edge Function 新增一支 callerClient.rpc(...),就要把它加進下面的 VALUES 清單,並把 plan() 加 2。
--    清單本身就是契約:用這個指令重掃可以對照 ——
--    grep -rn --include=*.ts -E '\.rpc\(' supabase/functions/ | grep -v adminClient
--
-- 【為什麼斷言的是「名稱 + 參數名」而不只是名稱】
-- PostgREST 是用「函式名 + JSON body 的 key 名」解析要呼叫哪支函式,所以 Edge Function 傳的參數名
-- (p_merchant_id 等)也是契約的一部分;參數名改掉一樣會 PGRST202。這裡用 pg_get_function_identity_arguments
-- 精確比對,並要求剛好 1 支(避免同名多載讓 PostgREST 解析出錯)。
--
-- 【正向對照(automated-testing/SKILL.md 第四節)】
-- 這種「存在 / 有權限」的斷言,如果查詢方法寫錯(例如 schema 名、函式名拼錯),負向會假通過、正向會假失敗,
-- 所以每一種查詢方法都各配一組對照:
--   ⑫⑬ private.can_manage_business_hours:已知**只在 private**。斷言它在 public 查不到、在 private 查得到,
--        證明「查 public 有沒有這支函式」的方法分辨得出「在」與「不在」,不是永遠回 true / 永遠回 false。
--   ⑭⑮ public.resolve_push_recipients:已知**刻意不給 authenticated、只給 service_role**(內部輔助函式)。
--        斷言 authenticated 沒有 EXECUTE、service_role 有,證明 has_function_privilege 這個查法分辨得出「有」與「沒有」。
-- 除此之外,#805 的修法(20260926010000_public_can_manage_bookings.sql)也做過故障注入:把 public.can_manage_bookings
-- 改名 → 第 4 條(存在性)紅;revoke execute from authenticated → 第 9 條(權限)紅;還原後全綠
-- (細節見 SPECS-INDEX #805/#806 備註)。
--
-- 【斷言編號】① 前提;②~⑥ 存在性(依清單 seq 1~5);⑦~⑪ 權限(依清單 seq 1~5);⑫~⑮ 正向對照。
--
-- 這支測試只讀系統目錄,不需要 fixture、不需要切換身份,所以沒有 test_set_auth helper。
begin;

select plan(15);

-- =========================================================================
-- 契約清單:Edge Function 用呼叫者身分呼叫的每一支 RPC(函式名, identity arguments 原文)。
-- =========================================================================
create temp table edge_caller_rpc_contract (
  seq int,
  fn  text,
  args text,
  called_by text
) on commit drop;

insert into edge_caller_rpc_contract (seq, fn, args, called_by) values
  (1, 'am_i_merchant_admin',            'p_merchant_id uuid',                    'invite-merchant-agent / invite-merchant-staff / line-send-marketing / line-test-connection'),
  (2, 'can_dispatch_line_notification', 'p_merchant_id uuid, p_event_type text', 'line-notify-dispatch'),
  (3, 'can_manage_bookings',            'p_merchant_id uuid',                    'push-notify-dispatch(#805)'),
  (4, 'get_my_push_identity',           'p_merchant_id uuid',                    'push-send-test'),
  (5, 'count_my_recent_test_pushes',    'p_merchant_id uuid',                    'push-send-test');

-- =========================================================================
-- ① 前提:清單真的有 5 筆。本專案吃過「空清單假通過」的虧 —— 下面 ②~⑪ 是用 select ... from 清單 產生的,
--    清單若意外是空的,會一條斷言都不產生而 plan 對不上;這條讓失敗原因一眼可讀。
-- =========================================================================
select is(
  (select count(*)::int from edge_caller_rpc_contract),
  5,
  '#806 ①(前提):Edge Function 呼叫者身分 RPC 契約清單共 5 筆(新增 callerClient.rpc 時要同步加清單、plan +2)'
);

-- =========================================================================
-- ②~⑥(依 seq 1~5):每一支 RPC 在 public 恰好有 1 支同名、同參數名的函式。
-- =========================================================================
select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = c.fn
     and pg_get_function_identity_arguments(p.oid) = c.args),
  1,
  format('#806 存在:public.%s(%s) 必須恰好存在 1 支(被 %s 用呼叫者 JWT 呼叫;不在 public 就是 PGRST202 → 500,#805 就是這樣)', c.fn, c.args, c.called_by)
)
from edge_caller_rpc_contract c
order by c.seq;

-- =========================================================================
-- ⑦~⑪(依 seq 1~5):每一支 RPC,authenticated 都有 EXECUTE。
-- 用 has_function_privilege(role, 'schema.fn(argtypes)', 'execute');函式不存在時這個呼叫會直接拋錯,
-- 所以用 coalesce + exists 包起來,讓「不存在」在這裡表現成 false 而不是整支測試中斷。
-- =========================================================================
select ok(
  coalesce(
    (select has_function_privilege('authenticated', p.oid, 'execute')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = c.fn
       and pg_get_function_identity_arguments(p.oid) = c.args
     limit 1),
    false
  ),
  format('#806 權限:authenticated 對 public.%s(%s) 必須有 EXECUTE(呼叫者 JWT 的角色就是 authenticated;沒有就是 42501 → Edge Function 回 500)', c.fn, c.args)
)
from edge_caller_rpc_contract c
order by c.seq;

-- =========================================================================
-- ⑫⑬ 正向對照 A:「存在性」查法分辨得出「在 / 不在」。
--    private.can_manage_business_hours 已知只在 private(20260916140100 3.1),沒有 public 包裝。
-- =========================================================================
select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'can_manage_business_hours'),
  0,
  '#806 ⑫(對照組):can_manage_business_hours 在 public 查不到(= 0)—— 證明上面的存在性查詢不是永遠回 1'
);

select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'can_manage_business_hours'
     and pg_get_function_identity_arguments(p.oid) = 'p_merchant_id uuid'),
  1,
  '#806 ⑬(對照組):同一個查法對 private.can_manage_business_hours(p_merchant_id uuid) 查得到(= 1)—— 證明 ⑫ 的 0 不是因為函式名 / 參數比對寫錯'
);

-- =========================================================================
-- ⑭⑮ 正向對照 B:「權限」查法分辨得出「有 / 沒有」。
--    public.resolve_push_recipients 是內部輔助函式,刻意只給 service_role(supabase-permission-hygiene 規則 1)。
-- =========================================================================
select ok(
  not has_function_privilege('authenticated', 'public.resolve_push_recipients(uuid, text, uuid)', 'execute'),
  '#806 ⑭(對照組):authenticated 對 public.resolve_push_recipients 沒有 EXECUTE —— 證明 has_function_privilege 這個查法不是永遠回 true'
);

select ok(
  has_function_privilege('service_role', 'public.resolve_push_recipients(uuid, text, uuid)', 'execute'),
  '#806 ⑮(對照組):service_role 對同一支 public.resolve_push_recipients 有 EXECUTE —— 證明 ⑭ 的 false 不是因為函式簽章寫錯'
);

select * from finish();

rollback;
