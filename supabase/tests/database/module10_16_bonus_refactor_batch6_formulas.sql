-- 紅利系統重構 批次 6(紅利設定頁改版 + 砍舊欄位)的回歸測試。
-- 對應 migration 20261001070000_bonus_refactor_batch6_settings_and_drop_earn_rate.sql;
-- 規格書 .project/specs/紅利系統重構.md §1.1(drop points_earn_rate)、§3.9、§3.10、§2.8、§七。
--
-- 測的東西:
--   A. points_earn_rate 已 drop;資料庫裡沒有任何函式 / view 還寫著這個欄位名;保護 trigger 照常運作
--      (會員系統設定客服「只送會員政策兩欄」的局部 upsert 成功、改規則欄位被擋)
--   B. §3.9 upsert_member_point_formulas:新增 / 更新(保留 id 與 created_at)/ 刪除(payload 沒有就刪)/
--      兩條公式互換服務項目 / 重複項目的白話錯誤(含項目名與衝突公式名)/ 兩條「全部服務項目」/
--      跨商家項目被擋 / 別家公式 id(IDOR)被擋且別家資料沒被動 / 驗證失敗整份不寫(原子性)/
--      已下架項目可以保留公式
--   C. §2.8 權限:管理員、member_points 客服可存;members-only、member_settings-only、別家管理員 42501
--   D. get_point_formula_service_items:只回四欄;上架中 + 「有公式綁著的已下架」;沒綁的已下架不回;權限
--   E. 權限衛生:兩支新函式 PUBLIC / anon 沒有 EXECUTE、authenticated 有
begin;

select plan(43);

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
--   使用者:1 A 店管理員 / 2 客服P(member_points + members)/ 3 客服S(member_settings)/
--           4 客服M(members)/ 6 B 店管理員
--   服務項目:A 店 31「冷氣安裝」、32「清洗」、33「已下架但有公式」、34「已下架沒公式」;B 店 39
-- =========================================================================
insert into auth.users (id, email) values
  ('db160000-0000-4000-8000-000000000001', 'pgtap-m1016-admin@test.local'),
  ('db160000-0000-4000-8000-000000000002', 'pgtap-m1016-agent-points@test.local'),
  ('db160000-0000-4000-8000-000000000003', 'pgtap-m1016-agent-settings@test.local'),
  ('db160000-0000-4000-8000-000000000004', 'pgtap-m1016-agent-members@test.local'),
  ('db160000-0000-4000-8000-000000000006', 'pgtap-m1016-admin-b@test.local');

insert into groups (id) values
  ('db160000-0000-4000-8000-000000000010'),
  ('db160000-0000-4000-8000-000000000011');

insert into merchants (id, group_id, name, industry_type) values
  ('db160000-0000-4000-8000-000000000020', 'db160000-0000-4000-8000-000000000010', '紅利設定頁測試A店', 'in_store_beauty'),
  ('db160000-0000-4000-8000-000000000021', 'db160000-0000-4000-8000-000000000011', '紅利設定頁測試B店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id) values
  ('db160000-0000-4000-8000-000000000020', 'db160000-0000-4000-8000-000000000001'),
  ('db160000-0000-4000-8000-000000000021', 'db160000-0000-4000-8000-000000000006');

insert into merchant_agents (id, merchant_id, user_id, name, phone, invited_email, status) values
  ('db160000-0000-4000-8000-000000000051', 'db160000-0000-4000-8000-000000000020',
   'db160000-0000-4000-8000-000000000002', '客服P', '0900016101', 'pgtap-m1016-agent-points@test.local', 'active'),
  ('db160000-0000-4000-8000-000000000052', 'db160000-0000-4000-8000-000000000020',
   'db160000-0000-4000-8000-000000000003', '客服S', '0900016102', 'pgtap-m1016-agent-settings@test.local', 'active'),
  ('db160000-0000-4000-8000-000000000053', 'db160000-0000-4000-8000-000000000020',
   'db160000-0000-4000-8000-000000000004', '客服M', '0900016103', 'pgtap-m1016-agent-members@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('db160000-0000-4000-8000-000000000051', 'member_points', true),
  ('db160000-0000-4000-8000-000000000051', 'members', true),
  ('db160000-0000-4000-8000-000000000052', 'member_settings', true),
  ('db160000-0000-4000-8000-000000000053', 'members', true);

insert into merchant_member_settings (merchant_id) values
  ('db160000-0000-4000-8000-000000000020'),
  ('db160000-0000-4000-8000-000000000021');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('db160000-0000-4000-8000-000000000031', 'db160000-0000-4000-8000-000000000020', '冷氣安裝', 2200, 'primary', 60, 'active'),
  ('db160000-0000-4000-8000-000000000032', 'db160000-0000-4000-8000-000000000020', '清洗', 800, 'primary', 60, 'active'),
  ('db160000-0000-4000-8000-000000000033', 'db160000-0000-4000-8000-000000000020', '已下架但有公式', 500, 'primary', 30, 'removed'),
  ('db160000-0000-4000-8000-000000000034', 'db160000-0000-4000-8000-000000000020', '已下架沒公式', 500, 'primary', 30, 'removed'),
  ('db160000-0000-4000-8000-000000000039', 'db160000-0000-4000-8000-000000000021', 'B店項目', 1000, 'primary', 30, 'active');

-- B 店既有一條公式(IDOR 測試的目標)。
insert into merchant_point_formulas (id, merchant_id, name, service_item_id, points_per_unit) values
  ('db160000-0000-4000-8000-000000000091', 'db160000-0000-4000-8000-000000000021', 'B店公式', null, 7);

-- =========================================================================
-- A. 舊欄位已 drop + 沒有殘留引用 + 保護 trigger 照常
-- =========================================================================
select hasnt_column('public', 'merchant_member_settings', 'points_earn_rate',
  'A1 §1.1:points_earn_rate 已 drop');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.prosrc ilike '%points_earn_rate%' and n.nspname not in ('pg_catalog', 'information_schema')),
  0,
  'A2 §〇.4 判斷 19:資料庫裡沒有任何函式本體還寫著 points_earn_rate(否則執行時才會爆)'
);

select is(
  (select count(*)::int from pg_views where definition ilike '%points_earn_rate%'),
  0,
  'A3:沒有任何 view 引用 points_earn_rate'
);

-- 會員系統設定客服 S:前端改成「只送會員政策兩欄」的局部 upsert(PostgREST merge-duplicates 只更新 payload 欄位),必須成功。
select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000003');
select lives_ok(
  $$insert into merchant_member_settings (merchant_id, policy_enabled, policy_content)
    values ('db160000-0000-4000-8000-000000000020', true, '批次6政策')
    on conflict (merchant_id) do update
      set policy_enabled = excluded.policy_enabled, policy_content = excluded.policy_content$$,
  'A4 §3.14:會員系統設定頁改成「只送會員政策兩欄」的局部 upsert,只有 member_settings 鑰匙的客服照樣存得進去'
);
select throws_ok(
  $$update merchant_member_settings set earn_mode = 'advanced' where merchant_id = 'db160000-0000-4000-8000-000000000020'$$,
  '42501', null,
  'A5 §3.10:trigger 改寫後,member_settings 客服改規則欄位仍被擋'
);
select pg_temp.test_clear_auth();

select is(
  (select row(policy_enabled, policy_content, earn_mode, birthday_line_message)::text
   from merchant_member_settings where merchant_id = 'db160000-0000-4000-8000-000000000020'),
  row(true, '批次6政策', 'basic', '生日快樂！本店已贈送您 {{points}} 點紅利,祝您有美好的一天。')::text,
  'A6:局部 upsert 只動了政策兩欄,紅利規則欄位(含新欄位)維持原值,沒有被寫回預設'
);

-- =========================================================================
-- B. upsert_member_point_formulas 的資料行為(以 A 店管理員身分)
-- =========================================================================
select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000001');

-- B1:新增兩條(全部服務項目 + 冷氣安裝)
select is(
  (select count(*)::int from upsert_member_point_formulas(
    'db160000-0000-4000-8000-000000000020',
    '[{"name":"全部","enabled":true,"service_item_id":null,"min_unit_price":0,"points_per_unit":1,"sort_order":1},
      {"name":"冷氣","enabled":true,"service_item_id":"db160000-0000-4000-8000-000000000031","min_unit_price":2000,"points_per_unit":5,"sort_order":2}]'::jsonb)),
  2,
  'B1 §3.9:沒有 id 的兩條 ⇒ 新增,回傳儲存後的完整清單(2 條)'
);

select id as all_id, created_at as all_created from merchant_point_formulas
where merchant_id = 'db160000-0000-4000-8000-000000000020' and service_item_id is null \gset
select id as ac_id from merchant_point_formulas
where merchant_id = 'db160000-0000-4000-8000-000000000020'
  and service_item_id = 'db160000-0000-4000-8000-000000000031' \gset

-- B2:更新(帶 id、改點數與名稱)+ 刪除(冷氣那條不在 payload)+ 新增清洗
select lives_ok(
  format($$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"id":"%s","name":"全部服務項目改名","enabled":false,"service_item_id":null,"min_unit_price":100,"points_per_unit":3,"sort_order":1},
      {"name":"清洗","enabled":true,"service_item_id":"db160000-0000-4000-8000-000000000032","min_unit_price":0,"points_per_unit":2,"sort_order":2}]'::jsonb)$$,
    :'all_id'),
  'B2 §3.9:一次完成「更新一條 + 刪除一條 + 新增一條」'
);
select is(
  (select row(name, enabled, min_unit_price, points_per_unit, created_at = :'all_created'::timestamptz)::text
   from merchant_point_formulas where id = :'all_id'::uuid),
  row('全部服務項目改名', false, 100.00, 3, true)::text,
  'B3 §3.9:帶 id 的那條是「更新」:id 不變、created_at 保留、新值寫入'
);
select is(
  (select count(*)::int from merchant_point_formulas where id = :'ac_id'::uuid),
  0,
  'B4 §3.9:payload 裡沒有的既有列(冷氣安裝那條)被刪除'
);
select is(
  (select count(*)::int from merchant_point_formulas
   where merchant_id = 'db160000-0000-4000-8000-000000000020'
     and service_item_id = 'db160000-0000-4000-8000-000000000032' and points_per_unit = 2),
  1,
  'B5 §3.9:沒有 id 的清洗那條被新增'
);

-- B6:兩條公式互換服務項目(逐列 UPDATE 會撞部分唯一索引,函式要能處理)
select id as wash_id from merchant_point_formulas
where merchant_id = 'db160000-0000-4000-8000-000000000020'
  and service_item_id = 'db160000-0000-4000-8000-000000000032' \gset
select lives_ok(
  format($$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"id":"%s","name":"原本是全部","enabled":true,"service_item_id":"db160000-0000-4000-8000-000000000032","min_unit_price":0,"points_per_unit":3,"sort_order":1},
      {"id":"%s","name":"原本是清洗","enabled":true,"service_item_id":null,"min_unit_price":0,"points_per_unit":2,"sort_order":2}]'::jsonb)$$,
    :'all_id', :'wash_id'),
  'B6 §3.9:兩條公式互換服務項目(全部 ↔ 清洗)可以存,不會撞唯一索引'
);
select is(
  (select service_item_id::text from merchant_point_formulas where id = :'all_id'::uuid),
  'db160000-0000-4000-8000-000000000032',
  'B7:互換後 id 不變、服務項目確實換過來'
);

-- B8~B9:重複服務項目的白話錯誤(第三道防線之前的第二道),逐字含項目名與衝突的公式名
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"公式甲","service_item_id":"db160000-0000-4000-8000-000000000031","points_per_unit":1},
      {"name":"公式乙","service_item_id":"db160000-0000-4000-8000-000000000031","points_per_unit":2}]'::jsonb)$$,
  '23505',
  '「冷氣安裝」已經被公式「公式甲」設定過了，同一個服務項目只能有一條公式',
  'B8 §3.9:同一個服務項目出現兩次 ⇒ 白話錯誤,含項目名「冷氣安裝」與先設定它的公式名「公式甲」'
);
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"全部一","service_item_id":null,"points_per_unit":1},
      {"name":"全部二","service_item_id":null,"points_per_unit":2}]'::jsonb)$$,
  '23505',
  '「全部服務項目」已經被公式「全部一」設定過了，同一個服務項目只能有一條公式',
  'B9 §1.2:兩條「全部服務項目」⇒ 同樣的白話錯誤'
);

-- B10:原子性——第二條驗證失敗,第一條也不能寫進去(既有兩條維持原狀)
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"會先通過的","service_item_id":"db160000-0000-4000-8000-000000000031","points_per_unit":1},
      {"name":"","service_item_id":null,"points_per_unit":2}]'::jsonb)$$,
  '22023', null,
  'B10:名稱空白 ⇒ 22023'
);
select is(
  (select array_agg(name order by name) from merchant_point_formulas
   where merchant_id = 'db160000-0000-4000-8000-000000000020'),
  array['原本是全部', '原本是清洗'],
  'B11 原子性:有一條不合格就整份不寫,既有兩條原封不動、也沒有多出「會先通過的」'
);

select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"負數","service_item_id":null,"points_per_unit":-1}]'::jsonb)$$,
  '22023', null,
  'B12:每個數量獲得負數 ⇒ 22023'
);
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"小數","service_item_id":null,"points_per_unit":1.5}]'::jsonb)$$,
  '22023', null,
  'B13:每個數量獲得不是整數 ⇒ 22023'
);
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"負門檻","service_item_id":null,"min_unit_price":-5,"points_per_unit":1}]'::jsonb)$$,
  '22023', null,
  'B14:單項金額門檻負數 ⇒ 22023'
);
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020', '{"a":1}'::jsonb)$$,
  '22023', null,
  'B15:p_formulas 不是陣列 ⇒ 22023'
);

-- B16:跨商家服務項目(B 店的項目)被擋
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"偷用別家","service_item_id":"db160000-0000-4000-8000-000000000039","points_per_unit":1}]'::jsonb)$$,
  '23514',
  '公式「偷用別家」選的服務項目不屬於這間商家',
  'B16 §3.9:service_item_id 必須屬於同商家,別家的項目被擋'
);

-- B17~B18:IDOR——A 店管理員拿 B 店公式的 id 來「更新」
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"id":"db160000-0000-4000-8000-000000000091","name":"搶過來","service_item_id":null,"points_per_unit":99}]'::jsonb)$$,
  '22023',
  '公式「搶過來」已經不存在，請重新整理後再儲存',
  'B17 IDOR:payload 帶別家商家的公式 id ⇒ 擋下(錯誤訊息不透露那筆存不存在)'
);
select pg_temp.test_clear_auth();
select is(
  (select row(merchant_id, name, points_per_unit)::text from merchant_point_formulas
   where id = 'db160000-0000-4000-8000-000000000091'),
  row('db160000-0000-4000-8000-000000000021'::uuid, 'B店公式', 7)::text,
  'B18 IDOR:B 店那條公式完全沒被動到(仍屬 B 店、名稱點數不變)'
);

-- B19:已下架的服務項目可以保留公式(§1.2 邊界)
select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000001');
select lives_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"下架項目的舊公式","service_item_id":"db160000-0000-4000-8000-000000000033","points_per_unit":4}]'::jsonb)$$,
  'B19 §1.2:綁已下架服務項目的公式可以存(保留舊公式,不強迫刪除)'
);
select is(
  (select count(*)::int from merchant_point_formulas where merchant_id = 'db160000-0000-4000-8000-000000000020'),
  1,
  'B20:這次 payload 只有一條 ⇒ 其他兩條都被刪掉,只剩一條'
);

-- B21:空陣列 = 全部刪除
select is(
  (select count(*)::int from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020', '[]'::jsonb)),
  0,
  'B21 §3.9:空陣列 ⇒ 這間商家的公式全部刪除,回傳空清單'
);

-- =========================================================================
-- C. §2.8 權限
-- =========================================================================
select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000002');
select lives_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
    '[{"name":"客服P設的","service_item_id":"db160000-0000-4000-8000-000000000031","points_per_unit":5}]'::jsonb)$$,
  'C1 §2.8:有「紅利點數管理」鑰匙的客服 P 可以存公式'
);

select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000004');
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020', '[]'::jsonb)$$,
  '42501', null,
  'C2 §2.8(核心):只有「會員管理」鑰匙的客服 M 不能存公式(會員管理 ≠ 紅利點數管理)'
);

select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000003');
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020', '[]'::jsonb)$$,
  '42501', null,
  'C3 §2.8:只有「會員系統設定」鑰匙的客服 S 不能存公式'
);

select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000006');
select throws_ok(
  $$select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020', '[]'::jsonb)$$,
  '42501', null,
  'C4 跨商家:B 店管理員不能動 A 店的公式'
);
select pg_temp.test_clear_auth();
select is(
  (select count(*)::int from merchant_point_formulas where merchant_id = 'db160000-0000-4000-8000-000000000020'),
  1,
  'C5:被擋下的三次呼叫(都帶空陣列 = 全刪)一條都沒刪掉'
);

-- =========================================================================
-- D. get_point_formula_service_items
-- =========================================================================
-- 先讓 A 店有一條綁「已下架但有公式」的公式(管理員身分)。
select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000001');
select * from upsert_member_point_formulas('db160000-0000-4000-8000-000000000020',
  '[{"name":"下架的","service_item_id":"db160000-0000-4000-8000-000000000033","points_per_unit":1}]'::jsonb);

select is(
  (select array_agg(name order by name) from get_point_formula_service_items('db160000-0000-4000-8000-000000000020')),
  array['冷氣安裝', '已下架但有公式', '清洗'],
  'D1:回傳上架中的項目 + 有公式綁著的已下架項目;沒被綁的已下架項目、別家的項目都不回'
);
select is(
  (select status from get_point_formula_service_items('db160000-0000-4000-8000-000000000020')
   where id = 'db160000-0000-4000-8000-000000000033'),
  'removed',
  'D2:已下架項目帶 status=removed(前端據此標「(已下架)」)'
);

select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000002');
select is(
  (select count(*)::int from get_point_formula_service_items('db160000-0000-4000-8000-000000000020')),
  3,
  'D3 §2.8:沒有服務項目 / 訂單鑰匙、只有紅利點數管理鑰匙的客服 P 也讀得到下拉需要的項目(不必放寬 service_items 表層政策)'
);
select is(
  (select count(*)::int from service_items where merchant_id = 'db160000-0000-4000-8000-000000000020'),
  0,
  'D4:同一位客服 P 直接查 service_items 表仍然一筆都看不到(表層政策沒有被放寬)'
);

select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000004');
select throws_ok(
  $$select * from get_point_formula_service_items('db160000-0000-4000-8000-000000000020')$$,
  '42501', null,
  'D5:只有會員管理鑰匙的客服 M 讀不到'
);
select pg_temp.test_set_auth('db160000-0000-4000-8000-000000000006');
select throws_ok(
  $$select * from get_point_formula_service_items('db160000-0000-4000-8000-000000000020')$$,
  '42501', null,
  'D6:別家管理員讀不到'
);
select pg_temp.test_clear_auth();

select is(
  (select count(*)::int from pg_policies
   where schemaname = 'public' and tablename = 'service_items' and cmd in ('SELECT', 'ALL')),
  1,
  'D7:service_items 仍然只有原本那一條 SELECT 政策(沒有為了設定頁新增 / 放寬)'
);
select is(
  (select array_length(proargnames, 1) - 1 from pg_proc where proname = 'get_point_formula_service_items'),
  4,
  'D8:只回 4 個欄位(id / name / price / status)'
);

-- =========================================================================
-- E. 權限衛生
-- =========================================================================
select ok(
  not has_function_privilege('anon', 'public.upsert_member_point_formulas(uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.get_point_formula_service_items(uuid)', 'execute'),
  'E1:anon 對兩支新函式都沒有 EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.upsert_member_point_formulas(uuid, jsonb)', 'execute')
  and has_function_privilege('authenticated', 'public.get_point_formula_service_items(uuid)', 'execute'),
  'E2:authenticated 有 EXECUTE(函式內自己檢查紅利點數管理鑰匙)'
);
select is(
  (select count(*)::int from pg_proc p
   cross join lateral aclexplode(p.proacl) a
   where p.proname in ('upsert_member_point_formulas', 'get_point_formula_service_items')
     and a.grantee = 0),
  0,
  'E3:兩支新函式的 ACL 沒有 PUBLIC(grantee = 0)'
);

select * from finish();
rollback;
