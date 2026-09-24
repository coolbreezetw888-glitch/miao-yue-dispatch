-- 2026-09-24 使用者裁決(migration 20260924040500 + 20260924040800)的回歸測試:
--   任務 7:客服管理補上「編輯」與「恢復」
--
-- 【使用者裁決原文】
--   客服的聯絡 Email:「客服可自行編輯或管理員可協助編輯。」
--   「重新啟用…指的應該是移除後[恢復/真正刪除]按鈕的恢復對吧?如果是的話那就要增加恢復按鈕。」
--
-- 【⚠️ 同日後續裁決:「聯絡 Email」這個欄位本身被廢除了,所以這份測試裡沒有它】
--   使用者原話:
--     「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
--     「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--   merchant_agents.contact_email 已由 20260924040800_drop_person_contact_email.sql drop 掉,
--   update_merchant_agent 從 6 參數變成 5 參數(拿掉 p_contact_email,保留 p_job_title)。
--   客服唯一的 Email 就是 invited_email / auth.users(登入帳號)——正好讓下面②③的
--   「不能從編輯基本資料側面改到 invited_email」那條邊界變得更關鍵。
--   ⚠️ 這個決定不適用於 public.merchants.contact_email(店家對外給消費者看的信箱),那個保留。
--
-- 【為什麼這兩支函式非有不可】
-- public.merchant_agents 只有一條 SELECT 的 RLS 政策,完全沒有 INSERT/UPDATE/DELETE 政策
-- (刻意鎖成唯讀,所有寫入走 SECURITY DEFINER 函式)。所以前端不管怎麼寫都改不動這張表。
--
-- 【這份測試的重點】
--   ① 授權邊界:管理員可以、客服本人可以、其他人(同店別的客服 / 別店的管理員)不行
--   ② 欄位邊界:絕對不能從「編輯基本資料」側面改到 status / user_id / invited_email
--   ③ 白話錯誤訊息:手機格式錯誤不能讓商家看到資料庫原始的 check constraint 錯誤
--   ④ 恢復功能:狀態正確、權限正確、原本的權限設定要一起復原
begin;

select plan(26);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

create function pg_temp.test_clear_auth()
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  reset role;
end;
$$;

-- =========================================================================
-- Fixture
--   商家 A:管理員 admin_a、客服 1(active,曾經啟用過)、客服 2(invited,從沒啟用過)、
--           客服 3(removed,被移除前曾經啟用過)、客服 4(removed,被移除前還停在 invited)
--   商家 B:管理員 admin_b(局外人,用來驗跨商家邊界)
-- =========================================================================
insert into auth.users (id, email) values
  ('e3050000-0000-4000-8000-000000000001', 'pgtap-m305-admin-a@test.local'),
  ('e3050000-0000-4000-8000-000000000002', 'pgtap-m305-admin-b@test.local'),
  ('e3050000-0000-4000-8000-000000000011', 'pgtap-m305-agent1@test.local'),
  ('e3050000-0000-4000-8000-000000000012', 'pgtap-m305-agent2@test.local'),
  ('e3050000-0000-4000-8000-000000000013', 'pgtap-m305-agent3@test.local'),
  ('e3050000-0000-4000-8000-000000000014', 'pgtap-m305-agent4@test.local');

insert into groups (id) values ('e3050000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type) values
  ('e3050000-0000-4000-8000-000000000020', 'e3050000-0000-4000-8000-000000000010', '客服編輯測試A店', 'in_store_beauty'),
  ('e3050000-0000-4000-8000-000000000021', 'e3050000-0000-4000-8000-000000000010', '客服編輯測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('e3050000-0000-4000-8000-000000000020', 'e3050000-0000-4000-8000-000000000001'),
  ('e3050000-0000-4000-8000-000000000021', 'e3050000-0000-4000-8000-000000000002');

-- ⚠️ 2026-09-24 使用者裁決:merchant_agents.contact_email 欄位已經 drop
--    (migration 20260924040800),所以 fixture 不再寫入它。使用者原話:
--      「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
--      「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--    客服唯一的 Email 就是 invited_email / auth.users(登入帳號),下面照樣有寫入它。
insert into merchant_agents (
  id, merchant_id, user_id, name, nickname, phone, invited_email, status, activated_at
) values
  ('e3050000-0000-4000-8000-000000000031', 'e3050000-0000-4000-8000-000000000020',
   'e3050000-0000-4000-8000-000000000011', '客服一', '小一', '0900003001',
   'pgtap-m305-agent1@test.local', 'active', now()),
  ('e3050000-0000-4000-8000-000000000032', 'e3050000-0000-4000-8000-000000000020',
   'e3050000-0000-4000-8000-000000000012', '客服二', null, '0900003002',
   'pgtap-m305-agent2@test.local', 'active', now()),
  -- 客服 3:已移除,而且被移除前曾經啟用過(activated_at 有值)→ 恢復後應該回到 active
  ('e3050000-0000-4000-8000-000000000033', 'e3050000-0000-4000-8000-000000000020',
   'e3050000-0000-4000-8000-000000000013', '客服三(已移除,曾啟用)', null, '0900003003',
   'pgtap-m305-agent3@test.local', 'removed', now()),
  -- 客服 4:已移除,但被移除前從沒設定過密碼(activated_at 是 null)→ 恢復後應該回到 invited
  ('e3050000-0000-4000-8000-000000000034', 'e3050000-0000-4000-8000-000000000020',
   'e3050000-0000-4000-8000-000000000014', '客服四(已移除,從沒啟用)', null, '0900003004',
   'pgtap-m305-agent4@test.local', 'removed', null);

-- 客服 3 原本被授權的功能權限(用來驗「恢復會連權限一起復原」)。
insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('e3050000-0000-4000-8000-000000000033', 'orders', true);

-- =========================================================================
-- ① 兩支函式存在,而且權限收得對(不能給 public / anon)。
-- =========================================================================
select has_function('public', 'update_merchant_agent', array['uuid','text','text','text','text'],
  '任務 7:public.update_merchant_agent(uuid,text,text,text,text) 存在(5 個參數:p_agent_id / p_name / p_nickname / p_phone / p_job_title)');

-- =========================================================================
-- ⚠️⚠️ 這一條是這份測試最容易被寫壞的地方,務必看完再改。
--
-- update_merchant_agent 的簽章在同一批開發裡動過兩次:
--   第一版(曾上線)  5 參數 (uuid, text, text, text, text) —— 第 5 個叫 p_contact_email
--   20260924040500  6 參數 (uuid, text, text, text, text, text) —— 追加 p_job_title
--   20260924040800  5 參數 (uuid, text, text, text, text) —— 第 5 個叫 p_job_title
--                    (2026-09-24 使用者裁決拿掉 contact_email:「登入和聯絡信箱應該要是一致的」
--                     「客服和服務人員應該也是一樣只需要一個 Email 即可」)
--
-- 注意「第一版」跟「現在」的**型別完全相同**,只差參數名字。所以:
--   ・不能再用 `pronargs = 5` 來判斷「舊版有沒有被留下」——現在的正確版本自己就是 5 參數。
--   ・改成兩個條件一起看:(1) 全域只能存在**一支** update_merchant_agent;
--     (2) 它的參數名裡**不能**出現 p_contact_email。
--   這樣不論留下的是 6 參數孤兒、還是型別相同但參數名是 contact_email 的舊版,都會被抓到。
-- =========================================================================
select ok(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_merchant_agent') = 1
  and not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_merchant_agent'
      and 'p_contact_email' = any(coalesce(p.proargnames, array[]::text[]))
  ),
  '任務 7:update_merchant_agent 只有一支、而且參數裡沒有 p_contact_email —— 第一版的 5 參數(有 p_contact_email)與 20260924040500 的 6 參數版本都已被 drop,沒有留下孤兒重載(留著會讓 PostgREST 依參數名解析到寫入已不存在欄位的舊版)');

select has_function('public', 'restore_merchant_agent', array['uuid'],
  '任務 7:public.restore_merchant_agent(uuid) 存在');

select ok(
  not has_function_privilege('anon', 'public.update_merchant_agent(uuid,text,text,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.restore_merchant_agent(uuid)', 'execute'),
  '任務 7(權限衛生):兩支函式都沒有給 anon EXECUTE 權限'
);

select ok(
  has_function_privilege('authenticated', 'public.update_merchant_agent(uuid,text,text,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.restore_merchant_agent(uuid)', 'execute'),
  '任務 7:兩支函式都有給 authenticated EXECUTE 權限'
);

-- =========================================================================
-- ② 管理員可以協助編輯(使用者裁決:「…或管理員可協助編輯」)。
-- =========================================================================
select pg_temp.test_set_auth('e3050000-0000-4000-8000-000000000001');

select lives_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服一改名', '大一', '0900009001', '資深客服')$$,
  '任務 7(使用者裁決「管理員可協助編輯」):商家管理員可以編輯客服的資料'
);

-- ⚠️ 這裡原本還有一條斷言,測「聯絡 Email 真的被改掉了」。2026-09-24 使用者裁決拿掉
--    merchant_agents.contact_email 之後那個欄位不存在了,斷言失去對象,已刪除
--    (下面 name / nickname / phone 與 job_title 兩條就是這支函式完整的寫入範圍)。

select is(
  (select row(name, nickname, phone)::text from merchant_agents
   where id = 'e3050000-0000-4000-8000-000000000031'),
  row('客服一改名', '大一', '0900009001')::text,
  '任務 7:name / nickname / phone 三個欄位也都正確更新'
);

-- p_job_title(開發中追加的參數,現在是第 5 個)也要真的寫進去——這是讓前端能收斂成單一 RPC 呼叫的關鍵,
-- 否則它得再呼叫一次 update_my_agent_profile,會產生「第一支成功、第二支失敗」的部分儲存狀態。
select is(
  (select job_title from merchant_agents where id = 'e3050000-0000-4000-8000-000000000031'),
  '資深客服',
  '任務 7(追加的 p_job_title):職位也在同一支函式、同一個 UPDATE 語句裡寫進去了——前端不必再分兩支 RPC 存同一張表單(那會產生部分儲存狀態)'
);

-- =========================================================================
-- ③ 欄位邊界(核心):絕對不能從這支函式側面改到身分/登入帳號相關欄位。
-- =========================================================================
select is(
  (select row(status, user_id, invited_email)::text from merchant_agents
   where id = 'e3050000-0000-4000-8000-000000000031'),
  row('active', 'e3050000-0000-4000-8000-000000000011'::uuid, 'pgtap-m305-agent1@test.local')::text,
  '任務 7(核心欄位邊界):編輯之後 status / user_id / invited_email 完全沒有被動到——這支函式的簽章本身就只收 name/nickname/phone/job_title 四個欄位的參數,從介面上就不可能碰到它們。⚠️ invited_email(登入信箱)這一條在 2026-09-24 拿掉 contact_email 之後更重要:它現在是客服唯一的 Email,絕對不能從「編輯基本資料」側面被改掉(改它要走 request_agent_login_email_change 那條有驗證流程的路徑)'
);

select ok(
  (select line_bound = false and line_user_id is null
     and pending_admin_login_email is null
   from merchant_agents where id = 'e3050000-0000-4000-8000-000000000031'),
  '任務 7(核心欄位邊界):LINE 綁定與待確認登入 Email 相關欄位也完全沒被動到(那些各有專屬的既有寫入路徑)'
);

-- =========================================================================
-- ④ 客服本人可以自行編輯(使用者裁決:「客服可自行編輯…」)。
-- =========================================================================
select pg_temp.test_set_auth('e3050000-0000-4000-8000-000000000011');

select lives_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服一自己改', '自己', '0900009011', '客服主管')$$,
  '任務 7(使用者裁決「客服可自行編輯」):客服本人可以編輯自己的資料(前端目前 AgentListPage 整頁走 RequireMerchantAdmin 還沒有這個入口,但使用者明確要求,所以授權先保留好)'
);

-- 原本這一條是用 contact_email 驗「本人的修改確實生效」。那個欄位 2026-09-24 被 drop 之後,
-- 改成一次比對這支函式現在能寫的全部四個欄位——證明力比原本只看一個欄位更強,不是退化。
select is(
  (select row(name, nickname, phone, job_title)::text from merchant_agents
   where id = 'e3050000-0000-4000-8000-000000000031'),
  row('客服一自己改', '自己', '0900009011', '客服主管')::text,
  '任務 7:客服本人的修改確實生效(四個開放欄位全部正確寫入)'
);

-- =========================================================================
-- ⑤ 其他人不行:同一間店的另一位客服、以及別間店的管理員。
-- =========================================================================
select pg_temp.test_set_auth('e3050000-0000-4000-8000-000000000012');

select throws_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服二亂改別人', null, '0900009099', null)$$,
  '42501', null,
  '任務 7(核心授權邊界):同一間店的另一位客服不能編輯別人的資料——授權用的是「這一列自己的 user_id = auth.uid()」,不是 is_merchant_agent(那樣會讓客服 A 改客服 B)'
);

select pg_temp.test_set_auth('e3050000-0000-4000-8000-000000000002');

select throws_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '別店管理員亂改', null, '0900009098', null)$$,
  '42501', null,
  '任務 7:別間商家的管理員不能編輯這間店的客服(跨商家邊界)'
);

-- =========================================================================
-- ⑥ 白話錯誤訊息(核心):手機格式/空白/姓名空白都要在函式裡先擋下,
--    不能讓商家看到資料庫原始的 check constraint 錯誤。
-- =========================================================================
select pg_temp.test_set_auth('e3050000-0000-4000-8000-000000000001');

select throws_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服一', null, '12345', null)$$,
  'P0001',
  '手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)',
  '任務 7(核心):手機格式不符 ^09\d{8}$ 時給的是白話中文訊息,不是資料庫原始的 merchant_agents_phone_tw_mobile_format check constraint 錯誤'
);

select throws_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服一', null, '0987654321098', null)$$,
  'P0001',
  '手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678)',
  '任務 7:位數過多的手機號碼同樣被白話訊息擋下'
);

select throws_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服一', null, '   ', null)$$,
  'P0001', '手機號碼不可為空白',
  '任務 7:merchant_agents.phone 是 NOT NULL(#595/#596),空白手機號碼給白話訊息擋下'
);

select throws_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '   ', null, '0900009001', null)$$,
  'P0001', '姓名不可為空白',
  '任務 7:姓名空白給白話訊息擋下(merchant_agents.name 是 NOT NULL)'
);

-- 空字串的 nickname / job_title 要被正規化成 NULL(沿用既有慣例,不存一堆空字串)。
select lives_ok(
  $$select update_merchant_agent(
      'e3050000-0000-4000-8000-000000000031'::uuid,
      '客服一', '', '0900009001', '')$$,
  '任務 7:nickname / job_title 傳空字串是合法的(代表清空)'
);

select ok(
  (select nickname is null and job_title is null from merchant_agents
   where id = 'e3050000-0000-4000-8000-000000000031'),
  '任務 7:nickname / job_title 的空字串都被正規化成 NULL(比照 update_my_staff_profile / update_my_agent_profile 的既有慣例;job_title 為 NULL 時前端 fallback 顯示「客服」,所以清空是合法操作)'
);

-- =========================================================================
-- ⑦ 恢復功能。
-- =========================================================================
-- 客服 3(被移除前曾經啟用過)→ 恢復成 active。
select is(
  (select status from restore_merchant_agent('e3050000-0000-4000-8000-000000000033'::uuid)),
  'active',
  '任務 7(使用者裁決「那就要增加恢復按鈕」):恢復曾經啟用過的客服(activated_at 有值)→ status 回到 active,跟原本的契約一致'
);

-- 客服 4(被移除前還停在 invited)→ 恢復成 invited。
-- ⚠️ 這是對契約「一律改回 active」的刻意調整(已在 migration 檔頭與回報中說明):status 的語意是
--    invited=邀請已寄出但還不能登入 / active=已能登入。把從沒接受邀請的人寫成 active,
--    public.mark_agent_active_if_self()(條件是 status='invited')之後撈不到他,他會永遠卡住。
select is(
  (select status from restore_merchant_agent('e3050000-0000-4000-8000-000000000034'::uuid)),
  'invited',
  '任務 7(對契約的刻意調整):恢復「從沒啟用過」的客服(activated_at 是 null)→ status 回到 invited 而不是 active,否則 mark_agent_active_if_self(條件是 status=invited)之後撈不到他,他永遠卡在錯誤狀態'
);

-- 恢復要連原本的權限設定一起復原(那些列一直掛在同一個 agent_id 上,移除時沒被刪過)。
select ok(
  exists (
    select 1 from merchant_agent_permissions
    where agent_id = 'e3050000-0000-4000-8000-000000000033' and section_key = 'orders' and granted
  ),
  '任務 7:恢復之後客服原本的 merchant_agent_permissions 權限設定完整保留(恢復不是給一張白紙——這點要讓管理員知道,見 migration 註解)'
);

-- 不是 removed 狀態的客服不需要恢復。
select throws_ok(
  $$select restore_merchant_agent('e3050000-0000-4000-8000-000000000031'::uuid)$$,
  'P0001', '只有已移除的客服才需要恢復,這位客服目前的狀態不是已移除',
  '任務 7:對還在職的客服呼叫恢復,給白話訊息擋下'
);

select throws_ok(
  $$select restore_merchant_agent('e3050000-0000-4000-8000-000000000099'::uuid)$$,
  'P0001', '找不到指定的客服紀錄',
  '任務 7:找不到的客服 id 給白話訊息'
);

-- 非管理員不能恢復(跟既有 remove_merchant_agent 同一個授權層級)。
select pg_temp.test_set_auth('e3050000-0000-4000-8000-000000000012');

select throws_ok(
  $$select restore_merchant_agent('e3050000-0000-4000-8000-000000000034'::uuid)$$,
  '42501', null,
  '任務 7(核心授權邊界):客服不能自己恢復被移除的客服——恢復跟移除必須是同一個權限層級(remove_merchant_agent 也只限管理員),否則被移除的人自己就能復活'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
