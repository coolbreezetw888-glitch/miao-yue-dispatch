-- 安全修補:收回 5 支 seed_default_* 函式對 PUBLIC / anon / authenticated 的 EXECUTE 權限。
--
-- 【問題】
-- 這 5 支函式當初建立時沿用了「不額外 revoke/grant」的舊慣例(見
-- 20260919130100_payment_methods_v2_functions.sql §2 的註解:「前端從未直接把它當 RPC 呼叫,
-- 只透過 perform 內部呼叫」)。但 PostgreSQL 對新建函式預設就會 grant execute to PUBLIC,
-- 而 public schema 的所有函式都會被 PostgREST 曝光成 /rest/v1/rpc/<name> 端點。
-- 結果是:任何人(連登入都不需要,anon key 是公開資訊)都可以帶入任意 merchant_id 呼叫這些
-- 函式,而函式內部完全沒有任何權限檢查——等同於可以無限次往別人的商家塞入重複的預設資料
-- (付款方式「現場付款/匯款」、假別「事假/病假/特休」等)。
--
-- 【修法】
-- 比照專案裡較新、寫法正確的 seed 函式慣例(seed_default_booking_status_colors、
-- seed_default_line_event_settings、seed_default_merchant_calendar_state_styles、
-- seed_default_push_event_settings、seed_default_staff_permissions,見
-- 20260922160300_req620_merchant_booking_status_colors_functions.sql:30),
-- 一律 `revoke execute ... from public, anon, authenticated;` 並只 grant 給 service_role, postgres。
--
-- 【為什麼不會影響建立商家的正常流程】
-- 這 5 支函式只被 create_merchant_in_group / create_group_and_merchant 這類 SECURITY DEFINER
-- 函式內部用 perform 呼叫。SECURITY DEFINER 內部呼叫是以函式擁有者 postgres 的身份執行,
-- postgres 保有 EXECUTE,所以收回 anon/authenticated 的權限不影響既有流程。
-- 前端原始碼也完全沒有直接呼叫這 5 支函式(src/ 底下只有自動產生的
-- src/integrations/supabase/types.ts 提到它們的型別)。

-- =========================================================================
-- §1:收回執行權。
-- =========================================================================
revoke execute on function public.seed_default_leave_types(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_leave_types(uuid) to service_role, postgres;

revoke execute on function public.seed_default_payment_methods(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_payment_methods(uuid) to service_role, postgres;

revoke execute on function public.seed_default_leave_deduction_rules(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_leave_deduction_rules(uuid) to service_role, postgres;

revoke execute on function public.seed_default_member_settings(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_member_settings(uuid) to service_role, postgres;

revoke execute on function public.seed_default_payroll_settings(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_payroll_settings(uuid) to service_role, postgres;

-- =========================================================================
-- §2:順手把 seed_default_payment_methods / seed_default_leave_types 改成冪等。
--
-- 另外 3 支本來就已經冪等(seed_default_leave_deduction_rules 有
-- `on conflict (leave_type_id) do nothing`;seed_default_member_settings /
-- seed_default_payroll_settings 是對 merchant_id 為主鍵的設定表做 on conflict do nothing),
-- 只有這兩支是純 insert values,重複呼叫會產生第二批重複資料。
--
-- payment_methods / merchant_leave_types 這兩張表上「沒有」(merchant_id, name) 的 unique
-- 約束——商家可以自己命名、甚至取一樣的名字,這是既有設計(見 20260919130000 /
-- 20260919150000 schema),這次刻意不新增 unique constraint(會影響既有資料),
-- 改用 `where not exists` 逐筆比對名稱來達成防重複。
--
-- 重寫時完整保留原本的函式簽章、returns void、language plpgsql、security definer
-- 以及 `set search_path = public`(照抄原始定義的結構,不做任何其他行為變動)。
-- =========================================================================
create or replace function public.seed_default_payment_methods(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.payment_methods (merchant_id, name, description)
  select p_merchant_id, v.name, v.description
  from (values
    ('現場付款'::text, null::text),
    ('匯款'::text, null::text)
  ) as v(name, description)
  where not exists (
    select 1
    from public.payment_methods pm
    where pm.merchant_id = p_merchant_id
      and pm.name = v.name
  );
end;
$$;

comment on function public.seed_default_payment_methods(uuid) is '模組 9 v2:新商家建立當下種入兩筆預設付款方式(現場付款/匯款),使用者已確認的定案(不是開放問題)。商家可以之後自己改名字/加說明文字/刪除/下架,不是鎖死不能動。「匯款」預設不帶說明文字——收款帳號是每個商家自己的資訊,系統不該替商家瞎猜或塞入佔位文字混進正式資料,提醒商家「這裡可以填收款帳號」是管理頁輸入框 placeholder 的 UI 層級提示。只在 create_group_and_merchant/create_merchant_in_group 建立商家當下呼叫一次。20260924010000 起改為冪等(用 where not exists 逐筆比對同商家同名稱,不新增 unique constraint),重複呼叫不會產生第二批;同時 revoke 掉 PUBLIC/anon/authenticated 的 EXECUTE,只留 postgres/service_role——前端從未直接把它當 RPC 呼叫,只透過 SECURITY DEFINER 函式內部 perform 呼叫。';

create or replace function public.seed_default_leave_types(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_leave_types (merchant_id, name, description)
  select p_merchant_id, v.name, v.description
  from (values
    ('事假'::text, null::text),
    ('病假'::text, null::text),
    ('特休'::text, null::text)
  ) as v(name, description)
  where not exists (
    select 1
    from public.merchant_leave_types mlt
    where mlt.merchant_id = p_merchant_id
      and mlt.name = v.name
  );
end;
$$;

comment on function public.seed_default_leave_types(uuid) is '模組 7 排班與休假管理:新商家建立當下種入三筆預設假別(事假/病假/特休,第〇節判斷 6),商家可以之後自己改名字/加說明文字/下架/新增其他假別,不是鎖死不能動。只在 create_group_and_merchant/create_merchant_in_group 建立商家當下呼叫一次。20260924010000 起改為冪等(用 where not exists 逐筆比對同商家同名稱,不新增 unique constraint),重複呼叫不會產生第二批;同時 revoke 掉 PUBLIC/anon/authenticated 的 EXECUTE,只留 postgres/service_role。';

-- 防禦性重下一次,不是必要步驟——先前這裡的註解寫「create or replace 會重新 grant execute
-- to PUBLIC」是錯的:`create or replace function` 會「保留」該函式既有的權限設定,只有「全新
-- 建立」的函式才會套用 PostgreSQL 預設的 grant execute to PUBLIC。所以 §1 對這兩支函式的收權
-- 不會被 §2 的 create or replace 洗掉,下面這幾行在目前的寫法下是重複的、完全無害。
-- 保留它們的理由是防禦未來的改動:萬一之後有人把 §2 的 create or replace 改成 drop function
-- + create function(那種情況才真的是「全新建立」、真的會重新授權給 PUBLIC),這幾行能確保
-- 收權不會默默失效。維護時請跟著 §2 一起留著。
revoke execute on function public.seed_default_payment_methods(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_payment_methods(uuid) to service_role, postgres;

revoke execute on function public.seed_default_leave_types(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_leave_types(uuid) to service_role, postgres;
