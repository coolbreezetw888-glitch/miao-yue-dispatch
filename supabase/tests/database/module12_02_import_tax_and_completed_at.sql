-- 2026-09-24 使用者裁決(migration 20260924040100)的回歸測試:
--   任務 4:匯入舊訂單時,稅金不可以被算進未稅營收
--   附帶:匯入的已完成訂單要寫入 completed_at(任務 1「報表改用完成時間」的根因修正)
--
-- 【使用者裁決原文(任務 4)】
--   「並不是每一筆服務都固定會有開發票(稅金),要看商家是否有要開發票,所以如果是舊訂單匯入,
--     在稅金欄位沒有填寫金額就當作總營收(未稅)去計算。」
--
-- 【為什麼需要這份測試】
-- 原本 import_historical_bookings_batch 在「CSV 只給金額+稅金、沒給未稅小計」時,直接把**含稅的**
-- 總金額當成 subtotal_amount_snapshot。而帳務報表的未稅營收是
-- Σ(subtotal_amount_snapshot − discount_amount_snapshot),所以那筆稅金會被算進未稅營收裡。
-- 這是一個安靜的金額錯誤——不會拋錯、不會有紅字,只會讓商家的營收數字虛高,所以必須有測試釘住。
--
-- 這份測試刻意「一路驗到報表」而不是只驗 bookings 欄位:因為使用者關心的是「未稅營收會不會被
-- 汙染」,只驗欄位值沒有證明那件事真的被解決。
begin;

select plan(17);

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
-- =========================================================================
insert into auth.users (id, email) values
  ('ec020000-0000-4000-8000-000000000001', 'pgtap-m1202-admin@test.local');

insert into groups (id) values ('ec020000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('ec020000-0000-4000-8000-000000000020', 'ec020000-0000-4000-8000-000000000010',
        '匯入稅金測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('ec020000-0000-4000-8000-000000000020', 'ec020000-0000-4000-8000-000000000001');

insert into merchant_staff (id, merchant_id, name, phone, compensation_type) values
  ('ec020000-0000-4000-8000-000000000041', 'ec020000-0000-4000-8000-000000000020',
   '匯入測試師傅', '0900001201', 'piece_rate');

select pg_temp.test_set_auth('ec020000-0000-4000-8000-000000000001');

-- =========================================================================
-- 匯入四種金額組合(全部 status 已完成、start_at 都在 2024-05,方便一次用報表驗算):
--   A:金額 1050、稅金 50、沒給小計   → 小計要反推成 1000(核心情境,使用者裁決指的就是這個)
--   B:金額 1000、稅金沒填、沒給小計  → 小計 = 1000(維持現況,使用者裁決:「稅金欄位沒有填寫
--                                       金額就當作總營收(未稅)去計算」)
--   C:金額 1050、稅金 50、小計給 999 → 尊重 CSV 給的 999,不反推、不覆蓋
--   D:金額 1100、稅金 100、折扣 200、沒給小計 → 小計 = 1100 + 200 − 100 = 1200
--                                       (驗證反推公式真的照 §2.3 把折扣加回來,不是只減稅金)
-- =========================================================================
select import_historical_bookings_batch(
  'ec020000-0000-4000-8000-000000000020',
  jsonb_build_array(
    jsonb_build_object(
      'row_number', 1, 'customer_name', 'A含稅未給小計', 'customer_phone', '0955120001',
      'staff_id', 'ec020000-0000-4000-8000-000000000041',
      'start_at', '2024-05-01T10:00:00+08:00', 'status', '已完成',
      'final_amount', 1050, 'tax_amount', 50
    ),
    jsonb_build_object(
      'row_number', 2, 'customer_name', 'B無稅金', 'customer_phone', '0955120002',
      'staff_id', 'ec020000-0000-4000-8000-000000000041',
      'start_at', '2024-05-02T10:00:00+08:00', 'status', '已完成',
      'final_amount', 1000
    ),
    jsonb_build_object(
      'row_number', 3, 'customer_name', 'C有給小計', 'customer_phone', '0955120003',
      'staff_id', 'ec020000-0000-4000-8000-000000000041',
      'start_at', '2024-05-03T10:00:00+08:00', 'status', '已完成',
      'final_amount', 1050, 'tax_amount', 50, 'subtotal_amount', 999
    ),
    jsonb_build_object(
      'row_number', 4, 'customer_name', 'D含稅含折扣', 'customer_phone', '0955120004',
      'staff_id', 'ec020000-0000-4000-8000-000000000041',
      'start_at', '2024-05-04T10:00:00+08:00', 'status', '已完成',
      'final_amount', 1100, 'tax_amount', 100, 'discount_amount', 200
    )
  )
) \gset import_op_

select is(
  (select failed_rows from merchant_bulk_operations where id = :'import_op_import_historical_bookings_batch'::uuid),
  0,
  '四列都匯入成功(failed_rows = 0),證明下面的金額差異不是因為某一列失敗造成的'
);

-- =========================================================================
-- ① 核心:A(金額 1050 / 稅金 50 / 沒給小計)的未稅小計要是 1000,不是 1050。
-- =========================================================================
select is(
  (select subtotal_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'A含稅未給小計'),
  1000.00,
  '任務 4(核心):CSV 只給「金額 1050 / 稅金 50」沒給小計 → 未稅小計反推成 1000.00(原本會直接把含稅的 1050 當小計,等於把 50 元稅金算進未稅營收)'
);

select is(
  (select final_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'A含稅未給小計'),
  1050.00,
  '任務 4:final_amount_snapshot 仍然是 1050.00(實收金額)——這次改的只有未稅小計的推算方向,final_amount 是唯一權威金額這件事沒變'
);

select is(
  (select tax_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'A含稅未給小計'),
  50.00,
  '任務 4:稅金 50.00 照樣留存在 tax_amount_snapshot(稅金不是被丟掉,是被移出未稅營收的口徑)'
);

-- 驗證 §2.3 的恆等式仍然成立:final = subtotal − discount + tax。
select is(
  (select subtotal_amount_snapshot - discount_amount_snapshot + tax_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'A含稅未給小計'),
  1050.00,
  '任務 4:反推之後訂單管理規格書 §2.3 的恆等式仍然成立(小計 − 折扣 + 稅金 = 最終金額),不是隨便減一個數字'
);

-- =========================================================================
-- ② B:稅金沒填 → 維持現況,總額直接當未稅營收(這是使用者裁決的原文情境,不能改壞)。
-- =========================================================================
select is(
  (select subtotal_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'B無稅金'),
  1000.00,
  '任務 4(使用者裁決原文):稅金欄位沒填 → 總金額 1000 直接當未稅小計,行為完全維持不變'
);

select is(
  (select tax_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'B無稅金'),
  0.00,
  '任務 4:稅金沒填時 tax_amount_snapshot 是 0.00'
);

-- =========================================================================
-- ③ C:CSV 自己給了小計 → 一律尊重 CSV,不反推也不覆蓋。
-- =========================================================================
select is(
  (select subtotal_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'C有給小計'),
  999.00,
  '任務 4:CSV 明確給了未稅小計(999)就完全尊重它,不會因為有稅金就自作聰明反推成 1000(商家自己給的分項金額最權威)'
);

-- =========================================================================
-- ④ D:含稅又含折扣 → 反推公式要把折扣加回來(subtotal = final + discount − tax)。
--    這一條是最容易寫錯方向的地方(很容易寫成 final − tax − discount)。
-- =========================================================================
select is(
  (select subtotal_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'D含稅含折扣'),
  1200.00,
  '任務 4(公式方向):金額 1100 / 稅金 100 / 折扣 200 → 小計 = 1100 + 200 − 100 = 1200(依 §2.3 對 final = subtotal − discount + tax 移項,折扣要「加」回來不是減)'
);

select is(
  (select subtotal_amount_snapshot - discount_amount_snapshot + tax_amount_snapshot from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'D含稅含折扣'),
  1100.00,
  '任務 4(公式方向對照):D 的恆等式也成立(1200 − 200 + 100 = 1100)'
);

-- =========================================================================
-- ⑤ 核心的核心:一路驗到帳務報表,證明「稅金真的沒有被算進未稅營收」。
--    2024-05 這四筆的未稅營收應該是 Σ(小計 − 折扣):
--      A 1000 − 0 = 1000
--      B 1000 − 0 = 1000
--      C  999 − 0 =  999
--      D 1200 − 200 = 1000
--      合計 = 3999
--    稅金合計 = 50 + 0 + 50 + 100 = 200,完全不該混進上面那個數字。
--    (原本 A 會貢獻 1050、D 會貢獻 (1100−200)=900… 總之未稅營收會被稅金汙染。)
--
--    ⚠️ 這裡用 2024-05 去查得到這四筆,本身就同時證明了「匯入的已完成訂單有寫入 completed_at
--       = start_at」——報表已經改成用完成時間分月(20260924040000),如果 completed_at 還是 null
--       而且沒有 coalesce fallback,這四筆就會整批從報表消失。
-- =========================================================================
select is(
  (get_merchant_billing_summary('ec020000-0000-4000-8000-000000000020', 2024, 5) ->> 'total_revenue_excl_tax')::numeric,
  3999.00,
  '任務 4(核心,一路驗到報表):2024-05 的未稅營收 = 1000(A)+1000(B)+999(C)+1000(D)= 3999.00,完全不含那 200 元稅金'
);

select is(
  (get_merchant_billing_summary('ec020000-0000-4000-8000-000000000020', 2024, 5) ->> 'total_tax_amount')::numeric,
  200.00,
  '任務 4:稅金 200.00 獨立顯示在 total_tax_amount 裡(該進哪一欄就進哪一欄,不是被丟掉也不是混進營收)'
);

-- =========================================================================
-- ⑥ 附帶修正(任務 1 的根因):匯入的已完成訂單要寫入 completed_at = start_at。
-- =========================================================================
select is(
  (select count(*)::int from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020'
     and status = 'completed' and completed_at is null),
  0,
  '任務 1 根因修正:匯入的已完成訂單不再留下 completed_at = null(原本這支函式的 INSERT 完全沒有 completed_at,是正式環境那 14 筆 null 的唯一來源)'
);

select is(
  (select completed_at from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'A含稅未給小計'),
  (select start_at from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'A含稅未給小計'),
  '任務 1 根因修正:completed_at 寫的是 start_at(服務當天),不是 now()(按下匯入按鈕那天)——否則 2024 年的營收會整批被算進匯入當月'
);

-- 已取消的訂單不該有完成時間。
select import_historical_bookings_batch(
  'ec020000-0000-4000-8000-000000000020',
  jsonb_build_array(jsonb_build_object(
    'row_number', 1, 'customer_name', 'E已取消', 'customer_phone', '0955120005',
    'staff_id', 'ec020000-0000-4000-8000-000000000041',
    'start_at', '2024-05-05T10:00:00+08:00', 'status', '已取消',
    'final_amount', 500
  ))
);

select ok(
  (select completed_at is null from bookings
   where merchant_id = 'ec020000-0000-4000-8000-000000000020' and customer_name = 'E已取消'),
  '任務 1 根因修正:status=cancelled 的匯入訂單 completed_at 維持 null(沒完成過的訂單不該有完成時間)'
);

-- =========================================================================
-- ⑦ 防呆:稅金比訂單總金額還大(CSV 本身矛盾)→ 那一列要失敗並進 error_report,
--    不是靜默寫入一個負數小計(負數小計會讓報表營收莫名變少,而且極難查)。
-- =========================================================================
select import_historical_bookings_batch(
  'ec020000-0000-4000-8000-000000000020',
  jsonb_build_array(jsonb_build_object(
    'row_number', 1, 'customer_name', 'F稅金大於金額', 'customer_phone', '0955120006',
    'staff_id', 'ec020000-0000-4000-8000-000000000041',
    'start_at', '2024-06-01T10:00:00+08:00', 'status', '已完成',
    'final_amount', 100, 'tax_amount', 500
  ))
) \gset bad_op_

select is(
  (select failed_rows from merchant_bulk_operations where id = :'bad_op_import_historical_bookings_batch'::uuid),
  1,
  '任務 4(防呆):稅金(500)大於訂單金額(100)時那一列匯入失敗,不會靜默寫入負數的未稅小計'
);

select ok(
  (select error_report::text like '%無法推算未稅小計%'
   from merchant_bulk_operations where id = :'bad_op_import_historical_bookings_batch'::uuid),
  '任務 4(防呆):error_report 裡是白話中文訊息(「…無法推算未稅小計,請確認這一列的金額與稅金欄位」),商家看得懂要去修哪一欄'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
