-- SPECS-INDEX #1035 彈性計薪 C 批(自由公式)
-- migration 20261010180000_req1035c_bonus_formula.sql
-- 規格書:母版 .project/specs/彈性計薪.md PC-F01~F03、PC-E01~E04、PX-03、第七節 PT(C)。
--
--   L  合法公式 35 例(編譯成功)
--   X  非法公式 47 例(編譯失敗、訊息白話、含位置;字串注入只會「找不到服務」)
--   E  計算結果(優先順序、左結合、IF / MIN / MAX、比較、四捨五入、全形)
--   F  旗標:除以 0、IF 不算沒選到的那邊、溢位、負值、封頂
--   T  竄改語法樹被拒(不認識的節點、多欄位、壞變數、壞數字、壞運算子、巢狀過深、節點過多)
--   S  函式原始碼不含動態 SQL 字樣;ACL(private 全收、preview 只給 authenticated)
--   I  整合:欄位值跟 A 批規則的量一致、存檔重新編譯(忽略前端 ast)、5 條上限、錯誤訊息、
--      報表含公式獎金、公式明細不含原文、沒有公式時輸出鍵不變、preview 三種模式與 IDOR
begin;
-- #1051:migration 已把「新函式預設給 PUBLIC 執行權」關掉;本檔的測試輔助函式需要讓測試角色呼叫,在這個交易內恢復(rollback 後失效)。
alter default privileges for role postgres grant execute on functions to public;

select plan(153);

create function pg_temp.test_set_auth(p_user_id uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id, 'role', p_role)::text, true);
  execute format('set local role %I', p_role);
end;
$$;

-- ── Fixture ───────────────────────────────────────────────────────────────
--   A 店:01 管理員;月薪 M(月薪 30,000)、月薪 M2(沒有單);服務:冷氣清洗、水管、舊項目(已下架)、重複 ×2
--   B 店:02 管理員;月薪 MB;服務「B專屬」
insert into auth.users (id, email) values
  ('f1035c00-0000-4000-8000-000000000001', 'pgtap-1035c-admin-a@test.local'),
  ('f1035c00-0000-4000-8000-000000000002', 'pgtap-1035c-admin-b@test.local');
insert into groups (id) values
  ('f1035c00-0000-4000-8000-000000000011'),
  ('f1035c00-0000-4000-8000-000000000012');
insert into merchants (id, group_id, name, industry_type) values
  ('f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000011', '#1035C 公式店', 'on_site_dispatch'),
  ('f1035c00-0000-4000-8000-000000000021', 'f1035c00-0000-4000-8000-000000000012', '#1035C 別家店', 'on_site_dispatch');
insert into merchant_admins (merchant_id, user_id, display_name) values
  ('f1035c00-0000-4000-8000-000000000020', 'f1035c00-0000-4000-8000-000000000001', 'A 店主'),
  ('f1035c00-0000-4000-8000-000000000021', 'f1035c00-0000-4000-8000-000000000002', 'B 店主');
insert into service_items (id, merchant_id, name, price, item_type, duration_minutes, status) values
  ('f1035c00-0000-4000-8000-000000000031', 'f1035c00-0000-4000-8000-000000000020', '冷氣清洗', 1000, 'primary', 30, 'active'),
  ('f1035c00-0000-4000-8000-000000000032', 'f1035c00-0000-4000-8000-000000000020', '水管', 2000, 'primary', 30, 'active'),
  ('f1035c00-0000-4000-8000-000000000033', 'f1035c00-0000-4000-8000-000000000020', '舊項目', 500, 'primary', 30, 'removed'),
  ('f1035c00-0000-4000-8000-000000000034', 'f1035c00-0000-4000-8000-000000000020', '重複', 500, 'primary', 30, 'active'),
  ('f1035c00-0000-4000-8000-000000000035', 'f1035c00-0000-4000-8000-000000000020', '重複', 600, 'primary', 30, 'active'),
  ('f1035c00-0000-4000-8000-000000000036', 'f1035c00-0000-4000-8000-000000000021', 'B專屬', 1500, 'primary', 30, 'active');
insert into payment_methods (id, merchant_id, name) values
  ('f1035c00-0000-4000-8000-000000000050', 'f1035c00-0000-4000-8000-000000000020', '現金');
insert into merchant_leave_types (id, merchant_id, name) values
  ('f1035c00-0000-4000-8000-000000000070', 'f1035c00-0000-4000-8000-000000000020', '事假');
insert into merchant_staff (id, merchant_id, name, compensation_type, status, unlimited_backend_edit, phone, created_at) values
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000020', '月薪M', 'monthly_salary', 'active', true, '0900103640', now() - interval '400 days'),
  ('f1035c00-0000-4000-8000-000000000041', 'f1035c00-0000-4000-8000-000000000020', '月薪M2', 'monthly_salary', 'active', true, '0900103641', now() - interval '400 days'),
  ('f1035c00-0000-4000-8000-000000000043', 'f1035c00-0000-4000-8000-000000000021', '月薪MB', 'monthly_salary', 'active', true, '0900103643', now() - interval '400 days');
insert into staff_salary_settings (staff_id, monthly_base_salary) values
  ('f1035c00-0000-4000-8000-000000000040', 30000),
  ('f1035c00-0000-4000-8000-000000000041', 28000),
  ('f1035c00-0000-4000-8000-000000000043', 26000);

create function pg_temp.mk(p_staff uuid, p_items jsonb, p_start timestamptz)
returns uuid language sql as $$
  select id from public.create_booking(
    p_merchant_id => 'f1035c00-0000-4000-8000-000000000020',
    p_staff_id => p_staff,
    p_service_items => p_items,
    p_start_at => p_start,
    p_customer_name => '王先生',
    p_customer_phone => '0955103600',
    p_customer_address => '台北市測試路 1035 號',
    p_payment_method_id => 'f1035c00-0000-4000-8000-000000000050'
  );
$$;
grant execute on function pg_temp.mk(uuid, jsonb, timestamptz) to authenticated;
create function pg_temp.done(p_booking uuid)
returns void language plpgsql as $$
begin
  perform public.confirm_booking(p_booking);
  perform public.complete_booking(p_booking);
end;
$$;
grant execute on function pg_temp.done(uuid) to authenticated;

-- 月薪M 本月完成:冷氣 ×1、冷氣 ×1、冷氣 ×2、水管 ×1 ⇒ 4 單、5 份、業績 6,000(冷氣 4 份 / 4,000;水管 1 份 / 2,000)
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
create temp table p1035c_bk (id uuid) on commit drop;
grant all on p1035c_bk to authenticated;
insert into p1035c_bk values
  (pg_temp.mk('f1035c00-0000-4000-8000-000000000040', '[{"service_item_id":"f1035c00-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]', '2036-04-02 09:00+08')),
  (pg_temp.mk('f1035c00-0000-4000-8000-000000000040', '[{"service_item_id":"f1035c00-0000-4000-8000-000000000031","quantity":1,"unit_price":1000}]', '2036-04-02 11:00+08')),
  (pg_temp.mk('f1035c00-0000-4000-8000-000000000040', '[{"service_item_id":"f1035c00-0000-4000-8000-000000000031","quantity":2,"unit_price":1000}]', '2036-04-02 13:00+08')),
  (pg_temp.mk('f1035c00-0000-4000-8000-000000000040', '[{"service_item_id":"f1035c00-0000-4000-8000-000000000032","quantity":1,"unit_price":2000}]', '2036-04-02 15:00+08'));
select pg_temp.done(id) from p1035c_bk;
reset role;

select date_trunc('month', now() at time zone 'Asia/Taipei')::date as this_month,
       (date_trunc('month', now() at time zone 'Asia/Taipei') + interval '1 month - 1 day')::date as month_end \gset ctx_

-- 請假(本月涵蓋 4 天,重疊只算一次;取消的不算;跨上個月的只算本月那天)
insert into staff_leave_records (staff_id, leave_type_id, leave_type_name_snapshot, start_date, end_date, status) values
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000070', '事假', :'ctx_this_month'::date, :'ctx_this_month'::date + 2, 'confirmed'),
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000070', '事假', :'ctx_this_month'::date + 2, :'ctx_this_month'::date + 3, 'confirmed'),
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000070', '事假', :'ctx_this_month'::date - 2, :'ctx_this_month'::date, 'confirmed'),
  ('f1035c00-0000-4000-8000-000000000040', 'f1035c00-0000-4000-8000-000000000070', '事假', :'ctx_this_month'::date + 10, :'ctx_this_month'::date + 10, 'cancelled');

create function pg_temp.c(p_text text) returns jsonb language sql as $$
  select private.bonus_formula_compile('f1035c00-0000-4000-8000-000000000020', p_text);
$$;
create function pg_temp.ev(p_text text) returns jsonb language sql as $$
  select private.bonus_formula_eval(pg_temp.c(p_text) -> 'ast',
    '{"orders":4,"units":5,"revenue":6000,"salary":30000,"leave_days":2}'::jsonb);
$$;

-- =========================================================================
-- L 合法公式(35)
-- =========================================================================
select ok(coalesce((pg_temp.c(f) ->> 'ok')::boolean, false), 'L 合法:' || f)
from unnest(array[
  '1', '12.5', '0.0001', '999999999', '999999999.9999',
  '完成單數', '完成數量', '業績', '月薪', '請假天數',
  'MAX(完成數量 - 10, 0) * 300', 'IF(業績 >= 100000, 業績 * 0.03, 0)', 'MIN(完成單數 * 100, 5000)',
  '-完成單數 + 10', '+5', '-(-(3))', '1 + 2 * 3 / 4 - 5',
  '(完成單數 > 10) * (業績 > 50000) * 1000', 'IF(完成單數 >= 10, IF(業績 > 1, 1, 2), 3)',
  'min(1, 2)', 'Max(1, 2, 3)', 'if(1,2,3)',
  '（完成單數＞＝10）＊2', '完成單數 ≧ 10', '完成單數 ≦ 10', '完成單數 ≠ 10', '完成單數 != 10', '完成單數 <> 10',
  '數量("冷氣清洗") * 50', '業績("水管") * 0.1', '數量(“冷氣清洗”) * 50', '數量("舊項目")',
  E'  完成單數\n * 2　', '((((((((1))))))))', '１２３ + 月薪 / 30 * 請假天數'
]) as f;

-- =========================================================================
-- X 非法公式(47):編譯失敗,訊息含預期的白話片段
-- =========================================================================
select ok(
  not coalesce((pg_temp.c(x.f) ->> 'ok')::boolean, true) and (pg_temp.c(x.f) ->> 'message') like '%' || x.m || '%',
  'X 非法:' || left(x.f, 40) || ' ⇒ ' || x.m)
from (values
  ('完成台數*3', '不認識「完成台數」'),
  ('5%', '5% 請寫成 0.05'),
  ('100,000', '千分位'),
  ('MAX(1,000)', '千分位'),
  ('1;drop table x', '不能使用「;」'),
  ('1 -- c', '「--」'),
  ('IF(1,2)', 'IF 要剛好 3 個參數'),
  ('MAX(1)', '2～10 個參數'),
  ('MAX(1,2,3,4,5,6,7,8,9,10,11)', '2～10 個參數'),
  ('(((((((((1)))))))))', '最多 8 層'),
  ('MAX(MAX(MAX(MAX(MAX(MAX(MAX(MAX(MAX(1,1),1),1),1),1),1),1),1),1)', '最多 8 層'),
  ('1 < 2 < 3', '只能比較一次'),
  ('數量("x'') or 1=1 --")', '找不到叫「x'') or 1=1 --」'),
  ('"abc"', '引號只能用在'),
  ('', '請輸入公式'),
  (E'  \n　', '請輸入公式'),
  ('1+', '還沒寫完'),
  ('(1', '少了右括號'),
  ('IF(1,2,3', '少了右括號'),
  ('1)', '多了一個右括號'),
  ('MIN(1,)', '少了數字或欄位'),
  ('()', '括號裡面是空的'),
  ('1 AND 2', '不支援「AND」'),
  ('NOT 1', '不支援「NOT」'),
  ('.5', '小數點前面要有數字'),
  ('1.', '小數點後面要接數字'),
  ('1.12345', '小數最多 4 位'),
  ('1234567890', '整數最多 9 位'),
  ('完成單數(2)', '是欄位'),
  ('2 ^ 3', '次方'),
  ('$1', '不能使用「$」'),
  (E'1 \\ 2', '不能使用「'),
  ('1 2', '少了運算符號'),
  ('select 1', '不認識「select」'),
  ('pg_sleep(10)', '不認識「pg」'),
  ('數量(冷氣清洗)', '要用引號包起來'),
  ('數量(1)', '括號裡要放服務名稱'),
  ('數量("重複")', '好幾個服務項目'),
  ('數量("B專屬")', '找不到叫「B專屬」'),
  ('IF', '後面要接括號'),
  ('數量', '後面要接括號'),
  ('1 == 1', '只要寫一個'),
  ('數量("abc', '引號沒有成對'),
  (repeat('1+', 151) || '1', '最多 300 個字'),
  (repeat('1+', 75) || '1', '最多 150 個符號'),
  (E'1 \u202e+ 2', '看不見的特殊字元（U+202E）'),
  (E'完成單數\u200b * 2', '看不見的特殊字元（U+200B）')
) as x(f, m);

select is(
  (select position(chr(8238) in (pg_temp.c(E'1 \u202e+ 2') ->> 'message')) || '/' || (pg_temp.c(E'1 \u202e+ 2') ->> 'position')),
  '0/3', 'X 方向控制字元:錯誤訊息不含原字元、位置正確'
);
select is(
  pg_temp.c(E'數量("冷氣\u200b清洗")') ->> 'message',
  '第 7 個字附近：這裡有看不見的特殊字元（U+200B），請刪掉後重打。', 'X 服務名稱引號裡的零寬字元也擋下(不放原字元)'
);

select is(
  (select (pg_temp.c(repeat('數量("冷氣清洗")+', 10) || '數量("冷氣清洗")') ->> 'message')),
  '數量("…")、業績("…") 合計最多用 10 次，目前 11 次。', 'X 數量() / 業績() 超過 10 次'
);
select is(pg_temp.c('完成台數*3') -> 'position', '1'::jsonb, 'X 錯誤帶位置(第 1 個字)');
select is(pg_temp.c('1 + 完成台數') -> 'position', '5'::jsonb, 'X 位置是原文第幾個字(1 起算)');

-- =========================================================================
-- E 計算結果(vars:完成單數 4、完成數量 5、業績 6,000、月薪 30,000、請假天數 2)
-- =========================================================================
select is((pg_temp.ev(x.f) ->> 'value')::numeric, x.v, 'E ' || x.f || ' = ' || x.v)
from (values
  ('MAX(完成數量 - 10, 0) * 300', 0::numeric),
  ('MAX(完成數量 - 3, 0) * 300', 600),
  ('IF(業績 >= 5000, 業績 * 0.03, 0)', 180),
  ('MIN(完成單數 * 100, 300)', 300),
  ('1 + 2 * 3', 7),
  ('(1 + 2) * 3', 9),
  ('10 - 4 - 3', 3),
  ('100 / 8', 13),
  ('月薪 * 0.01 - 請假天數 * 100', 100),
  ('(完成單數 > 3) * 1000 + (完成單數 = 4) * 1 + (完成單數 <> 4) * 10000', 1001),
  ('-5 + 10', 5),
  ('2 * -3 + 10', 4),
  ('IF(完成單數 < 4, 1, IF(完成單數 <= 4, 2, 3))', 2),
  ('MAX(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)', 10),
  ('0.5 + 0.4999', 1),
  ('業績 / 完成單數', 1500),
  ('２０＋１０', 30)
) as x(f, v);

-- =========================================================================
-- F 旗標
-- =========================================================================
select is(pg_temp.ev('業績 / (完成單數 - 4) + 7'), '{"value": 7, "flags": ["division_by_zero"]}'::jsonb, 'F1 除以 0 ⇒ 那次除法 = 0 + division_by_zero');
select is(pg_temp.ev('IF(1, 5, 1/0)'), '{"value": 5, "flags": []}'::jsonb, 'F2 IF 沒選到的那邊不計算(不帶旗標)');
select is(pg_temp.ev('999999999 * 999999999'), '{"value": 0, "flags": ["overflow"]}'::jsonb, 'F3 中間值超過 1e12 ⇒ 整條 0 + overflow');
select is(pg_temp.ev('完成單數 - 100'), '{"value": 0, "flags": ["negative_clamped"]}'::jsonb, 'F4 負值 ⇒ 0 + negative_clamped');
select is(pg_temp.ev('業績 * 1000'), '{"value": 1000000, "flags": ["capped"]}'::jsonb, 'F5 超過 1,000,000 ⇒ 封頂 + capped');
select is(pg_temp.ev('0.4'), '{"value": 0, "flags": []}'::jsonb, 'F6 0.4 四捨五入成 0,不算負值');

-- =========================================================================
-- T 竄改語法樹
-- =========================================================================
select throws_ok($$select private.bonus_formula_eval('{"t":"sql","v":"select 1"}', '{}')$$, 'BFE02', null, 'T1 不認識的節點 ⇒ 拒絕');
select throws_ok($$select private.bonus_formula_eval('{"t":"num","v":"1","x":1}', '{}')$$, 'BFE02', null, 'T2 多出來的欄位 ⇒ 拒絕');
select throws_ok($$select private.bonus_formula_eval('{"t":"var","n":"password"}', '{}')$$, 'BFE02', null, 'T3 不在白名單的變數 ⇒ 拒絕');
select throws_ok($$select private.bonus_formula_eval('{"t":"num","v":"1;drop"}', '{}')$$, 'BFE02', null, 'T4 數字格式不對 ⇒ 拒絕');
select throws_ok($$select private.bonus_formula_eval('{"t":"bin","op":"^","l":{"t":"num","v":"1"},"r":{"t":"num","v":"2"}}', '{}')$$, 'BFE02', null, 'T5 不在白名單的運算子 ⇒ 拒絕');
create function pg_temp.nest(p_n int) returns jsonb language plpgsql as $$
declare v jsonb := '{"t":"num","v":"1"}'; i int;
begin
  for i in 1..p_n loop v := jsonb_build_object('t', 'max', 'args', jsonb_build_array(v, '{"t":"num","v":"1"}'::jsonb)); end loop;
  return v;
end; $$;
create function pg_temp.chain(p_n int) returns jsonb language plpgsql as $$
declare v jsonb := '{"t":"num","v":"1"}'; i int;
begin
  for i in 1..p_n loop v := jsonb_build_object('t', 'bin', 'op', '+', 'l', v, 'r', '{"t":"num","v":"1"}'::jsonb); end loop;
  return v;
end; $$;
select is((private.bonus_formula_eval(pg_temp.nest(8), '{}') ->> 'value')::numeric, 1::numeric, 'T6 函式巢狀 8 層 ⇒ 可以算');
select throws_ok($$select private.bonus_formula_eval(pg_temp.nest(9), '{}')$$, 'BFE02', null, 'T7 函式巢狀 9 層 ⇒ 拒絕');
select throws_ok($$select private.bonus_formula_eval(pg_temp.chain(250), '{}')$$, 'BFE02', null, 'T8 節點過深 / 過多 ⇒ 拒絕');
select throws_ok(
  $$select private.bonus_compute_rules('f1035c00-0000-4000-8000-000000000040', date_trunc('month', now())::date,
      '[{"key":"a","label":"x","kind":"formula","text":"1","ast":{"t":"sql"}}]')$$,
  'BFE02', '獎金公式的資料不正確，請重新儲存這個獎金方案。', 'T9 存在資料庫裡的語法樹被竄改 ⇒ 計算時拒絕(白話訊息)'
);

-- =========================================================================
-- S 安全:原始碼、ACL
-- =========================================================================
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private')
     and (p.proname like 'bonus\_formula\_%' or p.proname in ('preview_bonus_formula', 'bonus_validate_rules', 'bonus_compute_rules'))
     and regexp_replace(p.prosrc, '--[^\n]*', '', 'g') ~* '(execute|format\s*\(|pg_read|dblink|lo_import|copy\s)'),
  0, 'S1 公式相關函式原始碼(去掉註解)不含 execute / format( / 其他動態執行字樣'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname like 'bonus\_formula\_%'),
  9, 'S2 前提:private.bonus_formula_* 共 9 支'
);
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private'
     and (p.proname like 'bonus\_formula\_%' or p.proname in ('bonus_validate_rules', 'bonus_compute_rules'))
     and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
          or has_function_privilege('public', p.oid, 'execute'))),
  0, 'S3 private 公式函式:anon / authenticated / public 都不能呼叫'
);
select is(
  has_function_privilege('anon', 'public.preview_bonus_formula(uuid, text, uuid, date, jsonb)', 'execute')::text || '/'
  || has_function_privilege('authenticated', 'public.preview_bonus_formula(uuid, text, uuid, date, jsonb)', 'execute')::text,
  'false/true', 'S4 preview_bonus_formula:anon 不行、authenticated 可以(函式內再判權限)'
);

-- =========================================================================
-- I 整合
-- =========================================================================
select is(
  private.bonus_formula_vars('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month'::date)
    - 'item_units' - 'item_revenue',
  '{"orders": 4, "units": 5, "revenue": 6000.00, "salary": 30000.00, "leave_days": 4}'::jsonb,
  'I1 欄位值:4 單、5 份、業績 6,000、月薪 30,000、請假 4 天(重疊一次、取消不算、跨月只算本月)'
);
select is(
  (select (v -> 'item_units' ->> 'f1035c00-0000-4000-8000-000000000031') || '/' || (v -> 'item_revenue' ->> 'f1035c00-0000-4000-8000-000000000032')
   from (select private.bonus_formula_vars('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month'::date) v) x),
  '4/2000.00', 'I2 指定服務:冷氣 4 份、水管業績 2,000'
);
select is(
  (select jsonb_agg(r ->> 'quantity' order by r ->> 'key')
   from jsonb_array_elements(private.bonus_compute_rules('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month'::date,
     private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
       '[{"key":"a","label":"a","kind":"per_order","threshold":0,"amount":1},{"key":"b","label":"b","kind":"per_unit","threshold":0,"amount":1},{"key":"c","label":"c","kind":"percent","threshold":0,"percent":1}]')) -> 'rules') r),
  '["4", "5", "6000.00"]'::jsonb, 'I3 公式欄位跟 A 批規則的量一致(單數 / 份數 / 業績同一個基準)'
);

-- 存檔:公式規則 + 一般規則,前端送來的假 ast 一律忽略
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
select public.save_staff_bonus_plan('f1035c00-0000-4000-8000-000000000020', null, '公式組',
  '[{"key":"per-order","label":"每單 100","kind":"per_order","threshold":0,"amount":100},
    {"key":"f1","label":"超過 3 份每份 300","kind":"formula","text":" MAX(完成數量 - 3, 0) * 300 ","ast":{"t":"num","v":"999999"}},
    {"key":"f2","label":"指定服務","kind":"formula","text":"數量(\"冷氣清洗\") * 50 + 業績(\"水管\") * 0.1 - 請假天數 * 10"}]',
  'this_month') as plan_id \gset
select public.set_staff_bonus_plan('f1035c00-0000-4000-8000-000000000040', :'plan_id'::uuid);
reset role;

select is(
  (select v.rules -> 1 from staff_bonus_plan_versions v where v.plan_id = :'plan_id'::uuid),
  jsonb_build_object('key', 'f1', 'label', '超過 3 份每份 300', 'kind', 'formula', 'text', 'MAX(完成數量 - 3, 0) * 300',
                     'ast', pg_temp.c('MAX(完成數量 - 3, 0) * 300') -> 'ast'),
  'I4 存檔:公式規則只存 key / label / kind / text(去頭尾空白)/ 伺服器重新編譯的 ast(前端送的 ast 被忽略)'
);
select is(
  (select v.rules -> 2 -> 'ast' -> 'l' -> 'l' -> 'l' from staff_bonus_plan_versions v where v.plan_id = :'plan_id'::uuid),
  '{"t": "item_units", "id": "f1035c00-0000-4000-8000-000000000031"}'::jsonb,
  'I5 數量("冷氣清洗") 存成服務 id(之後改名不影響計算)'
);
select is(
  (select (r ->> 'amount') || '/' || (r -> 'rules' -> 1 ->> 'amount') || '/' || (r -> 'rules' -> 2 ->> 'amount')
   from (select private.compute_staff_monthly_bonus('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month'::date) r) x),
  '1360/600/360', 'I6 月獎金:每單 100 × 4 = 400、公式 (5 − 3) × 300 = 600、4 × 50 + 2,000 × 0.1 − 4 × 10 = 360,合計 1,360'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(private.compute_staff_monthly_bonus('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month'::date) -> 'rules' -> 1) k),
  array['achieved', 'amount', 'counted_quantity', 'flags', 'key', 'kind', 'label', 'metric', 'quantity', 'range_end', 'range_start'],
  'I7 公式規則的明細不含公式原文(text / ast)'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(private.compute_staff_monthly_bonus('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month'::date) -> 'rules' -> 0) k),
  array['achieved', 'amount', 'counted_quantity', 'key', 'kind', 'label', 'metric', 'quantity', 'range_end', 'range_start'],
  'I8 一般規則的明細鍵跟 A 批相同(沒有多 flags)'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys(private.bonus_compute_rules('f1035c00-0000-4000-8000-000000000041', :'ctx_this_month'::date,
     private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020', '[{"key":"a","label":"a","kind":"per_order","threshold":0,"amount":1}]'))) k)::text
  || (private.bonus_compute_rules('f1035c00-0000-4000-8000-000000000041', :'ctx_this_month'::date,
     private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020', '[{"key":"a","label":"a","kind":"per_order","threshold":0,"amount":1}]')) ->> 'flags'),
  '{amount,flags,month,rules}[]', 'I9 沒有公式時最外層鍵與 flags 跟 A 批相同'
);
select is(
  private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
    '[{"key":"a","label":"a","kind":"lump_sum","metric":"orders","threshold":3,"amount":500,"service_item_ids":["f1035c00-0000-4000-8000-000000000031"]}]'),
  '[{"key": "a", "cap": null, "kind": "lump_sum", "label": "a", "amount": 500, "metric": "orders", "percent": null, "threshold": 3, "retroactive": false, "service_item_ids": ["f1035c00-0000-4000-8000-000000000031"]}]'::jsonb,
  'I10 一般規則驗證後的正規化結果跟 A 批相同'
);
select throws_ok(
  $$select private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
    '[{"key":"a","label":"a","kind":"per_order","threshold":0,"amount":1,"text":"1"}]')$$,
  '22023', '第 1 條規則有不認得的欄位「text」。', 'I11 一般規則帶 text ⇒ 不認得的欄位(跟 A 批一樣)'
);
select throws_ok(
  $$select private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
    '[{"key":"a","label":"a","kind":"formula","text":"1","threshold":0}]')$$,
  '22023', '第 1 條規則有不認得的欄位「threshold」。', 'I12 公式規則帶多餘欄位 ⇒ 拒收'
);
select throws_ok(
  $$select private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
    '[{"key":"a","label":"a","kind":"per_order","threshold":0,"amount":1},{"key":"b","label":"b","kind":"formula","text":"完成台數 * 3"}]')$$,
  '22023', '第 2 條規則的公式有錯誤：第 1 個字附近：不認識「完成台數」，可以用的欄位有：完成單數、完成數量、業績、月薪、請假天數。',
  'I13 公式編譯失敗 ⇒ 存檔擋下,說第幾條、第幾個字'
);
select throws_ok(
  $$select private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
    (select jsonb_agg(jsonb_build_object('key', 'k' || g, 'label', 'x', 'kind', 'formula', 'text', '1')) from generate_series(1, 6) g))$$,
  '22023', '一個方案最多 5 條自訂公式規則。', 'I14 公式規則最多 5 條'
);
select throws_ok(
  $$select private.bonus_validate_rules('f1035c00-0000-4000-8000-000000000020',
    '[{"key":"a","label":"a","kind":"formula"}]')$$,
  '22023', '第 1 條規則的公式不能空白。', 'I15 公式規則沒有 text ⇒ 擋下'
);

-- 店家報表含公式獎金
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000001');
select is(
  (public.get_merchant_billing_summary_by_range('f1035c00-0000-4000-8000-000000000020', :'ctx_this_month', :'ctx_month_end') ->> 'total_monthly_bonus')::numeric,
  1360::numeric, 'I16 店家報表 total_monthly_bonus 含公式獎金'
);
select is(
  (public.get_staff_bonus_by_range('f1035c00-0000-4000-8000-000000000040', :'ctx_this_month', :'ctx_month_end') ->> 'total_amount')::numeric,
  1360::numeric, 'I17 服務人員報表獎金 = 店家報表'
);

-- preview_bonus_formula
select is(
  (select (r ->> 'ok') || '/' || (r ->> 'value') || '/' || (r -> 'vars_used' ->> 'orders') || '/' || (r -> 'vars_used' -> 'items' -> 0 ->> 'name')
   from (select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '數量("冷氣清洗") * 50 + 完成單數',
           'f1035c00-0000-4000-8000-000000000040', :'ctx_this_month') r) x),
  'true/204/4/冷氣清洗', 'I18 試算(某人某月實際數字)= 4 × 50 + 4 = 204,回傳用到的數字'
);
select is(
  (select (r ->> 'value') || '/' || (r ->> 'flags')
   from (select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', 'IF(業績 >= 100000, 業績 * 0.03, 0)',
           null, null, '{"revenue": 120000}') r) x),
  '3600/[]', 'I19 試算(範例數字):業績 120,000 ⇒ 3,600'
);
select is(
  (public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '數量("冷氣清洗") * 50 + 業績 / 完成單數',
     null, null, '{"revenue": 1000}') -> 'flags'),
  '["division_by_zero", "sample_items_zero"]'::jsonb, 'I20 範例試算:除以 0 旗標、指定服務以 0 計算的旗標'
);
select is(
  public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', 'MAX(完成數量 - 10, 0) * 300'),
  '{"ok": true, "flags": [], "value": null, "message": null, "position": null, "vars_used": null, "normalized_text": "MAX(完成數量 - 10, 0) * 300"}'::jsonb,
  'I21 只檢查(沒有人、沒有範例)⇒ ok,不算數字'
);
select is(
  (select (r ->> 'ok') || '/' || (r ->> 'position') || '/' || (r ->> 'message')
   from (select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1 + 完成台數') r) x),
  'false/5/第 5 個字附近：不認識「完成台數」，可以用的欄位有：完成單數、完成數量、業績、月薪、請假天數。',
  'I22 公式錯誤時不丟錯,回 ok=false + 位置 + 白話訊息'
);
select throws_ok(
  $$select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1', null, null, '{"orders": 1, "password": 2}')$$,
  '22023', '範例數字有不認得的欄位「password」。', 'I23 範例數字只收五個欄位'
);
select throws_ok(
  $$select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1', null, null, '{"orders": "1"}')$$,
  '22023', '範例數字要填 0～1,000,000,000 之間的數字。', 'I24 範例數字必須是數字'
);
select throws_ok(
  format($$select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1', 'f1035c00-0000-4000-8000-000000000040', (%L::date - interval '24 months')::date)$$, :'ctx_this_month'),
  '22023', '試算月份只能選最近 24 個月（含本月）。', 'I25 試算月份限最近 24 個月'
);
select throws_ok(
  $$select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1', 'f1035c00-0000-4000-8000-000000000043', date_trunc('month', now())::date)$$,
  'P0002', '找不到這位服務人員。', 'I26 IDOR:不能試算別家店的服務人員'
);
select pg_temp.test_set_auth('f1035c00-0000-4000-8000-000000000002');
select throws_ok(
  $$select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1')$$,
  '42501', '沒有權限試算這間商家的獎金。', 'I27 IDOR:B 店店主不能用 A 店試算'
);
select is(
  (public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000021', '數量("冷氣清洗")') ->> 'ok'),
  'false', 'I28 IDOR:B 店的公式只在 B 店的服務裡找名稱(A 店的「冷氣清洗」找不到)'
);
select throws_ok(
  $$select public.save_staff_bonus_plan('f1035c00-0000-4000-8000-000000000020', null, '偷存', '[{"key":"a","label":"a","kind":"formula","text":"1"}]', 'this_month')$$,
  '42501', null, 'I29 IDOR:B 店店主不能存 A 店方案'
);
select pg_temp.test_set_auth('00000000-0000-4000-8000-000000000999', 'anon');
select throws_ok(
  $$select public.preview_bonus_formula('f1035c00-0000-4000-8000-000000000020', '1')$$,
  '42501', null, 'I30 未登入不能呼叫'
);
reset role;

select * from finish();
rollback;
