-- 預約詳情資訊擴充與建單備註分類規格書:customer_notes 讀寫、last_modified_by_user_id/
-- last_modified_at 追蹤機制(confirm_booking/update_booking/cancel_booking/complete_booking
-- 這四支函式都要正確更新)、get_booking_actor_names 姓名顯示邏輯、舊資料相容性。
begin;

select plan(23);

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
-- fixture 布置:一間商家「詳情擴充測試商家」,兩位管理員(甲有填 display_name,乙沒填,
-- 用來驗證 fallback 顯示 email 前半段)、兩位客服(丙有填 nickname,丁沒填,用來驗證 fallback
-- 顯示 name 欄位)、一個完全不相干的使用者 E(不是這間商家的任何人,用來驗證「(已移除的人員)」),
-- 另外一間不相干的商家 + 其管理員,用來驗證權限邊界。
-- =========================================================================
insert into auth.users (id, email) values
  ('bc000000-0000-4000-8000-000000000001', 'pgtap-detail-admin-a@test.local'),
  ('bc000000-0000-4000-8000-000000000002', 'pgtap-detail-admin-b@test.local'),
  ('bc000000-0000-4000-8000-000000000003', 'pgtap-detail-agent-c@test.local'),
  ('bc000000-0000-4000-8000-000000000004', 'pgtap-detail-agent-d@test.local'),
  ('bc000000-0000-4000-8000-000000000005', 'pgtap-detail-unrelated-e@test.local'),
  ('bc000000-0000-4000-8000-000000000009', 'pgtap-detail-other-merchant-admin@test.local');

insert into groups (id) values
  ('bc000000-0000-4000-8000-000000000010'),
  ('bc000000-0000-4000-8000-000000000019');

insert into merchants (id, group_id, name, industry_type) values
  ('bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000010', '詳情擴充測試商家', 'in_store_beauty'),
  ('bc000000-0000-4000-8000-000000000029', 'bc000000-0000-4000-8000-000000000019', '不相干的另一間商家', 'in_store_beauty');

-- 甲管理員:有填 display_name。乙管理員:沒填,呼叫 get_booking_actor_names 應該 fallback 成
-- email 的 @ 前半段(跟首頁個人資料卡片 emailNamePrefix 的 fallback 邏輯一致)。
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000001', '甲管理員'),
  ('bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000002', null);

insert into merchant_admins (merchant_id, user_id) values
  ('bc000000-0000-4000-8000-000000000029', 'bc000000-0000-4000-8000-000000000009');

-- 丙客服:有填 nickname。丁客服:沒填,應該 fallback 顯示 name 欄位(必填,一定有值)。
-- 丙同時開通 orders 權限,用來驗證 get_booking_actor_names 的權限檢查是 can_manage_bookings
-- (不是 is_merchant_admin),被開通 orders 的客服也能查詢。
insert into merchant_agents (id, merchant_id, user_id, name, nickname, invited_email, status) values
  ('bc000000-0000-4000-8000-000000000031', 'bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000003', '客服丙本名', '阿丙', 'pgtap-detail-agent-c@test.local', 'active'),
  ('bc000000-0000-4000-8000-000000000032', 'bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000004', '客服丁', null, 'pgtap-detail-agent-d@test.local', 'active');

insert into merchant_agent_permissions (agent_id, section_key, granted) values
  ('bc000000-0000-4000-8000-000000000031', 'orders', true);

insert into merchant_business_hours (merchant_id, day_of_week, is_closed, open_time, close_time)
values ('bc000000-0000-4000-8000-000000000020', 2, false, '09:00', '18:00');

insert into service_items (id, merchant_id, name, price, item_type, duration_minutes) values
  ('bc000000-0000-4000-8000-000000000041', 'bc000000-0000-4000-8000-000000000020', '洗髮', 300, 'primary', 30);

insert into merchant_staff (id, merchant_id, name, phone, no_time_slot_limit)
values ('bc000000-0000-4000-8000-000000000051', 'bc000000-0000-4000-8000-000000000020', '服務人員甲', null, true);

-- =========================================================================
-- ①②③ create_booking:寫入 customer_notes,剛建立時 last_modified_by_user_id/at 都是 null
-- (從未被 confirm/update/cancel/complete 這四支函式異動過)。
-- =========================================================================
select pg_temp.test_set_auth('bc000000-0000-4000-8000-000000000001');

select id from create_booking(
  'bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000051',
  array['bc000000-0000-4000-8000-000000000041']::uuid[], '2026-09-22 10:00:00+08',
  '客戶甲', '0988000001', null, '內部備註甲', '{}'::uuid[], '{}'::uuid[], null, '客戶備註甲'
) \gset booking1_

select is(
  (select customer_notes from bookings where id = :'booking1_id'::uuid),
  '客戶備註甲',
  '①第一節:create_booking 正確寫入 customer_notes'
);

select is(
  (select last_modified_by_user_id from bookings where id = :'booking1_id'::uuid),
  null,
  '②第三節 3.3:剛建立、從未被四支函式異動過的訂單,last_modified_by_user_id 維持 null'
);

select is(
  (select last_modified_at from bookings where id = :'booking1_id'::uuid),
  null,
  '③第三節 3.3:剛建立、從未被四支函式異動過的訂單,last_modified_at 維持 null'
);

-- =========================================================================
-- ④⑤ confirm_booking:確認訂單也算「異動」,成功執行後 last_modified_by_user_id/at 要更新。
-- =========================================================================
select confirm_booking(:'booking1_id'::uuid);

select is(
  (select last_modified_by_user_id from bookings where id = :'booking1_id'::uuid),
  'bc000000-0000-4000-8000-000000000001'::uuid,
  '④第三節 3.3:confirm_booking 成功執行後 last_modified_by_user_id 正確設成操作者(甲管理員)'
);

select isnt(
  (select last_modified_at from bookings where id = :'booking1_id'::uuid),
  null,
  '⑤第三節 3.3:confirm_booking 成功執行後 last_modified_at 不再是 null'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑥⑦ update_booking(改用乙管理員操作,同一間商家的另一位管理員):customer_notes 可被改掉
-- (含改成 null,驗證可以被清空),last_modified_by_user_id 正確換成這次的操作者(乙),
-- 不是繼續維持原本 confirm_booking 時的甲。
-- =========================================================================
select pg_temp.test_set_auth('bc000000-0000-4000-8000-000000000002');

select update_booking(
  :'booking1_id'::uuid, 'bc000000-0000-4000-8000-000000000051',
  array['bc000000-0000-4000-8000-000000000041']::uuid[], '2026-09-22 10:00:00+08',
  '客戶甲', '0988000001', null, '內部備註甲', '{}'::uuid[], '{}'::uuid[], null, '客戶備註甲(改過)'
);

select is(
  (select customer_notes from bookings where id = :'booking1_id'::uuid),
  '客戶備註甲(改過)',
  '⑥第一節:update_booking 正確更新 customer_notes'
);

select is(
  (select last_modified_by_user_id from bookings where id = :'booking1_id'::uuid),
  'bc000000-0000-4000-8000-000000000002'::uuid,
  '⑦第三節 3.3:update_booking 成功執行後 last_modified_by_user_id 正確換成這次的操作者(乙管理員),不是沿用 confirm_booking 當時的甲'
);

-- ⑧ update_booking 傳 p_customer_notes = null,客戶備註可以被清空成 null(不是被擋下或報錯)。
select update_booking(
  :'booking1_id'::uuid, 'bc000000-0000-4000-8000-000000000051',
  array['bc000000-0000-4000-8000-000000000041']::uuid[], '2026-09-22 10:00:00+08',
  '客戶甲', '0988000001', null, '內部備註甲', '{}'::uuid[], '{}'::uuid[], null, null
);

select is(
  (select customer_notes from bookings where id = :'booking1_id'::uuid),
  null,
  '⑧第一節:update_booking 傳 null 可以把 customer_notes 清空成 null'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑨⑩ cancel_booking:取消預約也算異動,成功執行後 last_modified_by_user_id/at 要更新。
-- 用第二筆全新的預約測試,避免受前面 booking1 的狀態轉換影響。
-- =========================================================================
select pg_temp.test_set_auth('bc000000-0000-4000-8000-000000000001');

select id from create_booking(
  'bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000051',
  array['bc000000-0000-4000-8000-000000000041']::uuid[], '2026-09-22 11:00:00+08',
  '客戶乙', '0988000002'
) \gset booking2_

select cancel_booking(:'booking2_id'::uuid, '測試取消');

select is(
  (select last_modified_by_user_id from bookings where id = :'booking2_id'::uuid),
  'bc000000-0000-4000-8000-000000000001'::uuid,
  '⑨第三節 3.3:cancel_booking 成功執行後 last_modified_by_user_id 正確設成操作者'
);

select isnt(
  (select last_modified_at from bookings where id = :'booking2_id'::uuid),
  null,
  '⑩第三節 3.3:cancel_booking 成功執行後 last_modified_at 不再是 null'
);

-- =========================================================================
-- ⑪⑫ complete_booking:標記完成也算異動。第三筆預約先確認再標記完成。
-- =========================================================================
select id from create_booking(
  'bc000000-0000-4000-8000-000000000020', 'bc000000-0000-4000-8000-000000000051',
  array['bc000000-0000-4000-8000-000000000041']::uuid[], '2026-09-22 12:00:00+08',
  '客戶丙', '0988000003'
) \gset booking3_

select confirm_booking(:'booking3_id'::uuid);
select complete_booking(:'booking3_id'::uuid);

select is(
  (select status from bookings where id = :'booking3_id'::uuid),
  'completed',
  '⑪complete_booking 正確把狀態轉成 completed(既有行為不受影響)'
);

select is(
  (select last_modified_by_user_id from bookings where id = :'booking3_id'::uuid),
  'bc000000-0000-4000-8000-000000000001'::uuid,
  '⑫第三節 3.3:complete_booking 成功執行後 last_modified_by_user_id 正確設成操作者(這是這支函式建立以來第一次真的改動 body)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ⑬⑭⑮ 舊資料相容性:模擬「這支 migration 上線前就存在」的舊預約列(customer_notes/
-- last_modified_by_user_id/last_modified_at 都是 null),直接查詢不會出錯。
-- =========================================================================
insert into bookings (
  id, merchant_id, staff_id, start_at, end_at,
  customer_name, customer_phone, created_by_role, status
) values (
  'bc000000-0000-4000-8000-000000000099', 'bc000000-0000-4000-8000-000000000020',
  'bc000000-0000-4000-8000-000000000051', now(), now() + interval '30 minutes',
  '舊資料客戶', '0911199999', 'admin', 'accepted'
);

select is(
  (select customer_notes from bookings where id = 'bc000000-0000-4000-8000-000000000099'::uuid),
  null,
  '⑬舊資料相容性:customer_notes 查詢正常,是 null 不出錯'
);

select is(
  (select last_modified_by_user_id from bookings where id = 'bc000000-0000-4000-8000-000000000099'::uuid),
  null,
  '⑭舊資料相容性:last_modified_by_user_id 查詢正常,是 null 不出錯'
);

select is(
  (select last_modified_at from bookings where id = 'bc000000-0000-4000-8000-000000000099'::uuid),
  null,
  '⑮舊資料相容性:last_modified_at 查詢正常,是 null 不出錯'
);

-- =========================================================================
-- ⑯~⑳ get_booking_actor_names:姓名顯示邏輯(第三節 3.2/3.3)。
-- =========================================================================
select pg_temp.test_set_auth('bc000000-0000-4000-8000-000000000001');

select is(
  (
    select display_name from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array[
        'bc000000-0000-4000-8000-000000000001',
        'bc000000-0000-4000-8000-000000000002',
        'bc000000-0000-4000-8000-000000000003',
        'bc000000-0000-4000-8000-000000000004',
        'bc000000-0000-4000-8000-000000000005'
      ]::uuid[]
    )
    where user_id = 'bc000000-0000-4000-8000-000000000001'::uuid
  ),
  '甲管理員',
  '⑯get_booking_actor_names:管理員有填 display_name 時直接顯示'
);

select is(
  (
    select display_name from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array['bc000000-0000-4000-8000-000000000002']::uuid[]
    )
  ),
  'pgtap-detail-admin-b',
  '⑰get_booking_actor_names:管理員沒填 display_name 時 fallback 顯示 email 的 @ 前半段'
);

select is(
  (
    select display_name from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array['bc000000-0000-4000-8000-000000000003']::uuid[]
    )
  ),
  '阿丙',
  '⑱get_booking_actor_names:客服有填 nickname 時直接顯示'
);

select is(
  (
    select display_name from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array['bc000000-0000-4000-8000-000000000004']::uuid[]
    )
  ),
  '客服丁',
  '⑲get_booking_actor_names:客服沒填 nickname 時 fallback 顯示 name 欄位'
);

select is(
  (
    select display_name from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array['bc000000-0000-4000-8000-000000000005']::uuid[]
    )
  ),
  '(已移除的人員)',
  '⑳get_booking_actor_names:兩邊(merchant_admins/merchant_agents)都查不到時顯示「(已移除的人員)」'
);

-- ㉑ 傳重複的 user_id,結果應該去重複只回傳 1 筆。
select is(
  (
    select count(*)::int from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array[
        'bc000000-0000-4000-8000-000000000001',
        'bc000000-0000-4000-8000-000000000001'
      ]::uuid[]
    )
  ),
  1,
  '㉑get_booking_actor_names:傳重複的 user_id 會先去重複,只回傳 1 筆'
);

select pg_temp.test_clear_auth();

-- ㉒ 權限檢查是 can_manage_bookings(不是 is_merchant_admin):被開通 orders 權限的客服丙
-- 也應該能成功呼叫,查得到甲管理員的姓名。
select pg_temp.test_set_auth('bc000000-0000-4000-8000-000000000003');

select is(
  (
    select display_name from get_booking_actor_names(
      'bc000000-0000-4000-8000-000000000020',
      array['bc000000-0000-4000-8000-000000000001']::uuid[]
    )
  ),
  '甲管理員',
  '㉒get_booking_actor_names:被開通 orders 權限的客服(非商家管理員)也能成功查詢'
);

select pg_temp.test_clear_auth();

-- ㉓ 無關的另一間商家管理員,呼叫這間商家的 get_booking_actor_names 應該被擋下(42501)。
select pg_temp.test_set_auth('bc000000-0000-4000-8000-000000000009');

select throws_ok(
  $$select * from get_booking_actor_names(
    'bc000000-0000-4000-8000-000000000020',
    array['bc000000-0000-4000-8000-000000000001']::uuid[]
  )$$,
  '42501', null,
  '㉓get_booking_actor_names:無關的另一間商家管理員呼叫被擋下'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
