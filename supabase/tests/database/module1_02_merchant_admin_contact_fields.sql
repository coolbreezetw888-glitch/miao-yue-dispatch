-- 2026-09-24 使用者裁決(migration 20260924040600 + 20260924040700)的回歸測試:
--   merchant_admins 新增「電話」,並擴充 update_my_admin_profile / get_merchant_admin_users。
--
-- 【使用者裁決原文】
--   「我認為需要,因為這會影響到整個系統判斷這個管理員與集團的關聯或者這個管理員在系統內的資料
--     (以我這個廠商視角)。」
--
-- 【⚠️ 同日後續裁決:contact_email 整個廢除,所以這份測試裡沒有它】
--   這兩支 migration 原本除了 phone 還要加/回傳 merchant_admins.contact_email,使用者看過實際
--   畫面後推翻了「一個人有兩個 Email」的設計,原話:
--     「登入和聯絡信箱應該要是一致的(所以理論上不該出現不同的信箱)」
--     「A,客服和服務人員應該也是一樣只需要一個 Email 即可。」
--   所以 merchant_admins **沒有** contact_email 欄位,update_my_admin_profile 是 4 參數
--   (不是 5),get_merchant_admin_users 回傳的 Email 只有一個:`email`(auth.users 的登入帳號)。
--   merchant_staff / merchant_agents 那兩個真的上線過的 contact_email 由
--   20260924040800_drop_person_contact_email.sql 移除,對應的測試在 module3_05 / module14_02。
--   ⚠️ 這個決定不適用於 public.merchants.contact_email(店家對外給消費者看的信箱),那個保留。
--
-- 【這份測試最重要的一條】
-- 「既有管理員(phone 是 null)不受影響」—— 這個欄位刻意是 nullable(理由見 migration
-- 檔頭:既有資料列從來沒機會填過,設 NOT NULL 會當場失敗,而管理員是商家老闆不能因為沒填電話
-- 就被停用)。這條測試同時也是防止之後有人「順手統一」把欄位改成 NOT NULL 的護欄。
begin;

select plan(18);

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
-- Fixture:同一間商家兩位管理員(A/B),用來驗「一位管理員改不到另一位的資料」。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1020000-0000-4000-8000-000000000001', 'pgtap-m102-admin-a@test.local'),
  ('e1020000-0000-4000-8000-000000000002', 'pgtap-m102-admin-b@test.local');

insert into groups (id) values ('e1020000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e1020000-0000-4000-8000-000000000020', 'e1020000-0000-4000-8000-000000000010',
        '管理員聯絡方式測試店', 'in_store_beauty');

insert into merchant_admins (id, merchant_id, user_id) values
  ('e1020000-0000-4000-8000-000000000031', 'e1020000-0000-4000-8000-000000000020',
   'e1020000-0000-4000-8000-000000000001'),
  ('e1020000-0000-4000-8000-000000000032', 'e1020000-0000-4000-8000-000000000020',
   'e1020000-0000-4000-8000-000000000002');

-- =========================================================================
-- ① 欄位存在、而且是 nullable(這是刻意的不一致,見檔頭)。
-- =========================================================================
select has_column('public', 'merchant_admins', 'phone',
  '§1:merchant_admins.phone 欄位已新增');

select col_is_null('public', 'merchant_admins', 'phone',
  '§1(核心,刻意的不一致):merchant_admins.phone 是 nullable —— 跟 merchant_staff.phone / merchant_agents.phone 的 NOT NULL 不同。既有管理員從來沒機會填過這個欄位,設 NOT NULL 會當場失敗,而且管理員是商家老闆,不能因為沒填電話就被停用。不要「順手統一」');

-- =========================================================================
-- ② 既有管理員(phone 是 null)不受影響 —— 最重要的一條。
-- =========================================================================
select ok(
  (select phone is null from merchant_admins
   where id = 'e1020000-0000-4000-8000-000000000031'),
  '§1(核心):剛建立的管理員 phone 是 null,不會因為新增欄位就被塞進假資料'
);

-- =========================================================================
-- ③ 管理員可以更新自己的 phone。
-- =========================================================================
select pg_temp.test_set_auth('e1020000-0000-4000-8000-000000000001');

select lives_ok(
  $$select update_my_admin_profile(
      'e1020000-0000-4000-8000-000000000020'::uuid,
      '管理員A', '店長', '0912345678')$$,
  '§2:管理員可以透過 update_my_admin_profile 更新自己的姓名/職位/電話'
);

select is(
  (select row(display_name, job_title, phone)::text from merchant_admins
   where id = 'e1020000-0000-4000-8000-000000000031'),
  row('管理員A', '店長', '0912345678')::text,
  '§2(核心):三個欄位都正確寫入(display_name/job_title 既有行為沒壞,phone 是這次新增的)'
);

-- =========================================================================
-- ④ 留空(null)可以存 —— phone 是選填,「清空」是合法操作,不能被當成格式錯誤擋下。
-- =========================================================================
select lives_ok(
  $$select update_my_admin_profile(
      'e1020000-0000-4000-8000-000000000020'::uuid,
      '管理員A', '店長', '')$$,
  '§2:電話傳空字串是合法的(代表清空),不會被格式驗證誤擋'
);

select ok(
  (select phone is null from merchant_admins
   where id = 'e1020000-0000-4000-8000-000000000031'),
  '§2(核心):空字串被正規化成 NULL,不是存進一個空字串(比照全站 nullif(btrim(...),'''') 的既有慣例)'
);

select lives_ok(
  $$select update_my_admin_profile(
      'e1020000-0000-4000-8000-000000000020'::uuid,
      '管理員A', '店長', null)$$,
  '§2:直接傳 null 也是合法的'
);

-- =========================================================================
-- ⑤ 格式錯誤有白話中文訊息(不能讓管理員看到資料庫原始的 check constraint 錯誤)。
-- =========================================================================
select throws_ok(
  $$select update_my_admin_profile(
      'e1020000-0000-4000-8000-000000000020'::uuid,
      '管理員A', '店長', '12345')$$,
  'P0001',
  '手機號碼格式不正確,請輸入 09 開頭、總共 10 位數字的台灣手機號碼(例如 0912345678),或留空不填',
  '§2(核心):電話格式不符 ^09\d{8}$ 時給白話中文訊息(而且明確告知「或留空不填」,因為這個欄位是選填),不是資料庫原始的 merchant_admins_phone_tw_mobile_format 錯誤'
);

-- 資料庫層的約束本身也要真的存在(擋掉繞過 RPC 直接寫表的路徑)。
select pg_temp.test_clear_auth();

select throws_ok(
  $$update merchant_admins set phone = '0212345678'
    where id = 'e1020000-0000-4000-8000-000000000031'$$,
  '23514', null,
  '§1:merchant_admins_phone_tw_mobile_format 約束真的存在,連直接寫表也擋得住。⚠️ 注意它只接受台灣手機,**不接受市話**(0212345678 被擋下)——管理員是商家老闆,留公司市話是合理情境,已在回報中請使用者確認是否需要放寬'
);

-- =========================================================================
-- ⑥ 不是本人的其他管理員不能改 —— update_my_admin_profile 用的是「所有權判斷」
--    (user_id = auth.uid()),不是 is_merchant_admin 那種權限判斷,所以同商家的管理員 B
--    改不到管理員 A 的資料。
-- =========================================================================
select pg_temp.test_set_auth('e1020000-0000-4000-8000-000000000001');
select update_my_admin_profile(
  'e1020000-0000-4000-8000-000000000020'::uuid,
  '管理員A', '店長', '0912345678');

select pg_temp.test_set_auth('e1020000-0000-4000-8000-000000000002');
select update_my_admin_profile(
  'e1020000-0000-4000-8000-000000000020'::uuid,
  '管理員B', '副店長', '0987654321');

select pg_temp.test_clear_auth();

select is(
  (select row(display_name, phone)::text from merchant_admins
   where id = 'e1020000-0000-4000-8000-000000000031'),
  row('管理員A', '0912345678')::text,
  '§2(核心授權邊界):管理員 B 更新自己的資料之後,管理員 A 的資料完全沒被動到——update_my_admin_profile 是所有權判斷(user_id = auth.uid()),不是 is_merchant_admin 權限判斷,所以同商家管理員之間互相改不到'
);

select is(
  (select row(display_name, phone)::text from merchant_admins
   where id = 'e1020000-0000-4000-8000-000000000032'),
  row('管理員B', '0987654321')::text,
  '§2:管理員 B 自己的資料正確寫入'
);

-- 舊簽章都沒有被留下來。這支函式的簽章在同一批開發裡動過兩次:
--   3 參數(原始版,不含 phone)→ 5 參數(草稿版,phone + contact_email)→ 4 參數(現在,只有 phone)。
-- 只要留下任何一個舊重載,PostgREST 依送來的參數名解析時就有機會走到它(不寫 phone,或寫入一個
-- 已經不存在的 contact_email 欄位),這是 update_merchant_agent 已經踩過的坑。
-- 寫成「只能存在 1 支,而且必須是 4 參數」而不是逐一列舉 pronargs,這樣之後再有人新增重載也會被抓到。
select ok(
  (select count(*)::int from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'update_my_admin_profile') = 1
  and exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_my_admin_profile'
      and p.pronargs = 4
  ),
  '§2:update_my_admin_profile 只有一支、而且是 4 參數版本——舊的 3 參數版本與開發中的 5 參數草稿版本(有 p_contact_email)都已被 drop,沒有留下孤兒重載'
);


-- =========================================================================
-- ⑦ get_merchant_admin_users 回傳新增的 profile 欄位(migration 20260924040700)。
--
-- 使用者原話:「目前我這邊看到的只有 Email(新增管理員也是 Email),新增用 Email 沒問題
-- (假設未來用手機也沒問題),但**名單要顯示暱稱 / 手機 / Email,這樣才好判斷是誰**。」
--
-- ⚠️ 這支函式同時餵兩個畫面(商家端 MerchantAdminList + 超級管理員端 MerchantDetailPage),
--    兩邊共用 useMerchantAdmins hook,所以「商家端名單」跟「超級管理員後台看得到」是同一個改動。
-- =========================================================================
insert into auth.users (id, email) values
  ('e1020000-0000-4000-8000-000000000003', 'pgtap-m102-platform@test.local');
insert into platform_admins (user_id) values ('e1020000-0000-4000-8000-000000000003');

select pg_temp.test_set_auth('e1020000-0000-4000-8000-000000000001');

-- 這張名單的三個主要顯示欄位:暱稱(display_name)/ 手機(phone)/ 登入 Email。
select is(
  (select row(display_name, phone, email)::text from get_merchant_admin_users(
     'e1020000-0000-4000-8000-000000000020'::uuid)
   where user_id = 'e1020000-0000-4000-8000-000000000001'),
  row('管理員A', '0912345678', 'pgtap-m102-admin-a@test.local')::text,
  '§3(核心,使用者原話「名單要顯示暱稱/手機/Email,這樣才好判斷是誰」):get_merchant_admin_users 同時回傳 display_name(暱稱)/ phone(手機)/ email(登入 Email)'
);

-- ⚠️ 這裡原本還有兩條斷言,測「contact_email 也一併回傳」與「登入 Email 跟聯絡 Email 不同時
--    兩個欄位各自正確回傳、沒有互相覆蓋」。2026-09-24 使用者裁決一個人只有一個 Email 之後,
--    merchant_admins 沒有 contact_email 欄位、這支函式也不回傳它,那兩條斷言失去對象,已刪除。
--    上面那一條(display_name / phone / email)就是這張名單的完整顯示欄位。

select is(
  (select job_title from get_merchant_admin_users(
     'e1020000-0000-4000-8000-000000000020'::uuid)
   where user_id = 'e1020000-0000-4000-8000-000000000001'),
  '店長',
  '§3:job_title 也一併補上(它 2026-09-16 就存在,卻一直沒被這支函式回傳——同一個缺口一次補齊)'
);

-- 既有管理員三個 profile 欄位都是 null 時,函式要照常回傳這一列(只是欄位是 null),不能整列消失。
-- 這一條很重要:如果實作時不小心用了 inner join 或加了 where ... is not null,既有管理員就會
-- 從名單上憑空消失。
-- ⚠️ 必須先切回 postgres 身分:merchant_admins 完全沒有 INSERT 政策(寫入一律走 RPC),
--    以 authenticated 身分 insert 會被 RLS 擋下,整份測試會在這裡中斷。
select pg_temp.test_clear_auth();

insert into auth.users (id, email) values
  ('e1020000-0000-4000-8000-000000000004', 'pgtap-m102-admin-c@test.local');
insert into merchant_admins (id, merchant_id, user_id) values
  ('e1020000-0000-4000-8000-000000000033', 'e1020000-0000-4000-8000-000000000020',
   'e1020000-0000-4000-8000-000000000004');

select pg_temp.test_set_auth('e1020000-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from get_merchant_admin_users('e1020000-0000-4000-8000-000000000020'::uuid)),
  3,
  '§3(核心):三個 profile 欄位全是 null 的既有管理員照樣出現在名單上(共 3 位)——不能因為新欄位是 null 就讓那一列從名單消失'
);

select ok(
  (select display_name is null and job_title is null and phone is null
   from get_merchant_admin_users('e1020000-0000-4000-8000-000000000020'::uuid)
   where user_id = 'e1020000-0000-4000-8000-000000000004'),
  '§3:沒填過資料的管理員三個欄位誠實回傳 null(刻意不在後端 coalesce 成「未填寫」,否則前端無法分辨「真的沒填」跟「填了那串字」;前端負責 fallback 顯示)'
);

select pg_temp.test_clear_auth();

-- 超級管理員也看得到這些欄位(使用者裁決 (a):「要」,理由「以我這個廠商視角」)。
-- 權限條件維持 20260915120200 既有的「該商家管理員 or 平台管理員」,這次一字未改。
select pg_temp.test_set_auth('e1020000-0000-4000-8000-000000000003');

select is(
  (select row(display_name, phone, email)::text from get_merchant_admin_users(
     'e1020000-0000-4000-8000-000000000020'::uuid)
   where user_id = 'e1020000-0000-4000-8000-000000000001'),
  row('管理員A', '0912345678', 'pgtap-m102-admin-a@test.local')::text,
  '§3(核心,使用者裁決 (a)「要」):平台超級管理員(不是這間商家的管理員)也看得到商家管理員的暱稱/電話/Email——走的是既有 get_merchant_admin_users 的平台管理員分支,沒有放寬 merchant_admins 的 RLS(模組 2 規則 2.3 的決定完全維持)'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
