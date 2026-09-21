-- 對應規格書 .project/specs/服務人員管理優化與硬刪除.md 第一節(需求 3):
-- 重複邀請同一個信箱失敗的 bug 修正 —— §1.2.1(唯一索引調整)+ §1.2.2(record_invited_staff_login
-- 防呆檢查)的回歸測試。
--
-- 已在正式環境(wjtbmmnakcriuaqoknsq)用真實測試資料重現過一次規格書 §1.1 描述的情境,確認
-- 根本原因是 merchant_staff_merchant_user_unique 這個 partial unique index 沒有排除
-- status='removed' 的舊紀錄(重現時拿到 23505 duplicate key value violates unique constraint
-- "merchant_staff_merchant_user_unique"),修復後(index 改成 where user_id is not null and
-- status='active' + record_invited_staff_login 補防呆)在正式環境重新跑過同一套流程確認成功。
-- 這裡把同一套情境搬進 pgTAP,確保之後任何人改動這兩個地方都會被這份測試擋下回歸。
begin;

select plan(13);

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
-- Fixture:一間商家,X 這個信箱先後被 A(之後移除)、B 使用;另外一位在職服務人員 C
-- 用來測「衝突防呆」情境。
-- =========================================================================
insert into auth.users (id, email) values
  ('f1400000-0000-4000-8000-000000000001', 'pgtap-m14-dup-staffX@test.local');

insert into groups (id) values ('f1400000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type) values
  ('f1400000-0000-4000-8000-000000000020', 'f1400000-0000-4000-8000-000000000010', '重複邀請修正測試商家', 'on_site_dispatch');

insert into merchant_staff (id, merchant_id, name, status) values
  ('f1400000-0000-4000-8000-000000000030', 'f1400000-0000-4000-8000-000000000020', '服務人員A', 'active'),
  ('f1400000-0000-4000-8000-000000000031', 'f1400000-0000-4000-8000-000000000020', '服務人員B', 'active'),
  ('f1400000-0000-4000-8000-000000000032', 'f1400000-0000-4000-8000-000000000020', '服務人員C(在職,用來測衝突防呆)', 'active');

-- =========================================================================
-- ①-⑥:完整重現規格書 §1.1 情境:邀請 A → A 完成登入設定密碼 → 移除 A → 新建 B(已在
-- fixture 建好)→ 用同一信箱邀請 B → 應該成功。
-- =========================================================================

-- ① 邀請 A(查無既有帳號分支)。
select lives_ok(
  $$select record_invited_staff_login('f1400000-0000-4000-8000-000000000030', 'f1400000-0000-4000-8000-000000000001', 'pgtap-m14-dup-staffX@test.local', 'invited')$$,
  '①:邀請 A 成功(record_invited_staff_login 邀請信分支)'
);

-- ② A 完成設定密碼,轉場頁呼叫 mark_staff_login_active_if_self()。
select pg_temp.test_set_auth('f1400000-0000-4000-8000-000000000001');
select lives_ok(
  $$select mark_staff_login_active_if_self()$$,
  '②:A 完成登入設定,呼叫 mark_staff_login_active_if_self 成功'
);
select pg_temp.test_clear_auth();

select is(
  (select login_status from merchant_staff where id = 'f1400000-0000-4000-8000-000000000030'),
  'active',
  '②:A 的 login_status 變成 active'
);

-- ③ 移除 A(軟刪除,user_id 保持不變 —— 既有規則 2.8/2.9)。
update merchant_staff set status = 'removed' where id = 'f1400000-0000-4000-8000-000000000030';
select is(
  (select user_id from merchant_staff where id = 'f1400000-0000-4000-8000-000000000030'),
  'f1400000-0000-4000-8000-000000000001'::uuid,
  '③:A 被移除後 user_id 保持不變(既有規則,移除不清空登入綁定)'
);

-- ④/⑤/⑥:用同一信箱邀請 B(全新一列,已在 fixture 建好)—— 這是本次 bug 修正的核心情境。
-- 修復前:這裡會撞 merchant_staff_merchant_user_unique,丟出 23505。
-- 修復後(§1.2.1 索引已排除 status<>'active' 的舊紀錄):應該順利成功。
select lives_ok(
  $$select record_invited_staff_login('f1400000-0000-4000-8000-000000000031', 'f1400000-0000-4000-8000-000000000001', 'pgtap-m14-dup-staffX@test.local', 'active')$$,
  '④(核心必測):重複邀請同一信箱給新的服務人員 B,修復後成功執行,不再撞唯一索引'
);

select is(
  (select user_id from merchant_staff where id = 'f1400000-0000-4000-8000-000000000031'),
  'f1400000-0000-4000-8000-000000000001'::uuid,
  '⑤:B 的 user_id 正確指向 X 的帳號'
);

select is(
  (select login_status from merchant_staff where id = 'f1400000-0000-4000-8000-000000000031'),
  'active',
  '⑤:B 的 login_status 正確變成 active(既有帳號分支)'
);

select is(
  (select status from merchant_staff where id = 'f1400000-0000-4000-8000-000000000030'),
  'removed',
  '⑥:A 那筆仍保持 removed,不受 B 的邀請流程影響'
);

select is(
  (select user_id from merchant_staff where id = 'f1400000-0000-4000-8000-000000000030'),
  'f1400000-0000-4000-8000-000000000001'::uuid,
  '⑥:A 那筆的 user_id 依然不變'
);

select is(
  (select count(*)::int from merchant_staff_permissions where staff_id = 'f1400000-0000-4000-8000-000000000031'),
  4,
  '⑤:record_invited_staff_login 成功後,B 也照樣種入 4 筆預設權限(seed_default_staff_permissions 沒被跳過)'
);

-- =========================================================================
-- §1.2.2 第 1 點(核心必測):合理的業務衝突依然要被擋下——同一信箱已經是本店另一位
-- 「在職」服務人員(B,現在 status=active/user_id=X)的登入,不能再綁給 C。
-- =========================================================================
select throws_ok(
  $$select record_invited_staff_login('f1400000-0000-4000-8000-000000000032', 'f1400000-0000-4000-8000-000000000001', 'pgtap-m14-dup-staffX@test.local', 'active')$$,
  'P0001',
  NULL,
  '§1.2.2 第 1 點(核心必測):同一信箱已是本店另一位在職服務人員(B)的登入,邀請給 C 被擋下'
);

select is(
  (select user_id from merchant_staff where id = 'f1400000-0000-4000-8000-000000000032'),
  null,
  '§1.2.2 第 1 點:C 被擋下後,user_id 完全沒被寫入(整筆交易 rollback)'
);

-- =========================================================================
-- §1.2.1(索引本身):直接在資料庫層驗證新的唯一索引條件——兩筆 status=active 撞同一
-- (merchant_id, user_id) 依然被擋下(索引調整後這個核心保護沒有被削弱)。
-- =========================================================================
select throws_ok(
  $$update merchant_staff set user_id = 'f1400000-0000-4000-8000-000000000001' where id = 'f1400000-0000-4000-8000-000000000032'$$,
  '23505',
  NULL,
  '§1.2.1:繞過函式直接 UPDATE,兩筆 status=active 撞同一 (merchant_id, user_id) 依然被唯一索引擋下'
);

select * from finish();

rollback;
