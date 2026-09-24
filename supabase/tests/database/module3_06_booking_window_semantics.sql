-- 2026-09-24(migration 20260924040200)的回歸測試:
--   預約天數欄位從三個收斂成兩個,並放寬會擋下使用者舉例數字的約束。
--
-- 【背景】前端這批把服務人員的預約天數設定改成兩個欄位:
--   ・advance_booking_days      →「最少要提前幾天預約」(⚠️ 語意反轉,欄位名沿用)
--   ・booking_window_max_days   →「最遠可以預約到幾天後」
--   ・booking_window_min_days   → 整個廢除
--
-- 【為什麼需要這份測試】
-- 最關鍵的一條:booking_window_max_days 原本的 CHECK 是 between 3 and 180,而**使用者自己舉的
-- 例子是 365**(可以預約到一年後)—— 365 > 180 會被約束直接擋下,商家在畫面上存檔會拿到一個
-- 資料庫原始錯誤。這不是理論風險,是使用者明確講出來的使用情境,所以要有測試釘住 365 能存。
begin;

select plan(10);

-- =========================================================================
-- Fixture(全部以 postgres 身分操作:這份測試只驗 schema 約束,不驗權限)
-- =========================================================================
insert into groups (id) values ('e3060000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('e3060000-0000-4000-8000-000000000020', 'e3060000-0000-4000-8000-000000000010',
        '預約天數欄位測試店', 'in_store_beauty');

insert into merchant_staff (id, merchant_id, name, phone) values
  ('e3060000-0000-4000-8000-000000000041', 'e3060000-0000-4000-8000-000000000020', '天數測試師傅', '0900003601');

-- =========================================================================
-- ① booking_window_min_days 這個欄位已經整個移除。
-- =========================================================================
select hasnt_column('public', 'merchant_staff', 'booking_window_min_days',
  '§1:booking_window_min_days 欄位已經 drop(下限欄位從畫面廢除,而且正式環境 125 列全部是 null,沒有資料需要回填)');

-- =========================================================================
-- ② min <= max 那條跨欄位約束也跟著移除(下限欄位沒了,這條規則就沒有意義)。
-- =========================================================================
select ok(
  not exists (
    select 1 from pg_constraint
    where conrelid = 'public.merchant_staff'::regclass
      and conname = 'merchant_staff_booking_window_range'
  ),
  '§2:merchant_staff_booking_window_range(min <= max 的跨欄位約束)已經移除'
);

-- =========================================================================
-- ③ 核心:使用者自己舉的例子 365 必須存得進去(原本 between 3 and 180 會擋下)。
-- =========================================================================
select lives_ok(
  $$update merchant_staff set booking_window_max_days = 365
    where id = 'e3060000-0000-4000-8000-000000000041'$$,
  '§3(核心):booking_window_max_days = 365(使用者自己舉的例子,可以預約到一年後)必須存得進去——原本的 CHECK between 3 and 180 會把它直接擋下'
);

select is(
  (select booking_window_max_days from merchant_staff where id = 'e3060000-0000-4000-8000-000000000041'),
  365,
  '§3:365 確實存進去了'
);

-- 下限從 3 降到 1:「只能預約明天」是合理設定。
select lives_ok(
  $$update merchant_staff set booking_window_max_days = 1
    where id = 'e3060000-0000-4000-8000-000000000041'$$,
  '§3:booking_window_max_days = 1(最遠只能預約到明天)也是合理設定,原本的下限 3 沒有道理'
);

-- 但刻意保留一個上限,擋掉打錯字的離譜數字。
select throws_ok(
  $$update merchant_staff set booking_window_max_days = 3651
    where id = 'e3060000-0000-4000-8000-000000000041'$$,
  '23514', null,
  '§3:上限刻意保留在 3650(約十年)——擋掉「把 30 打成 3000000」這種打錯字的離譜數字,不是整條約束移除'
);

-- 2026-09-24 使用者追加裁決:0 是合法的,而且有明確語意。使用者原話:
--   「應該是最遠可預約到幾天後設置為 0 才是代表一定要當天預約當天完成
--     (但這種情況應該幾乎為 0 不過就預留這個可能性)。」
-- ⚠️ 這個 0 跟 advance_booking_days 的 0 意思完全相反,見下面那條斷言的說明。
select lives_ok(
  $$update merchant_staff set booking_window_max_days = 0
    where id = 'e3060000-0000-4000-8000-000000000041'$$,
  '§3(使用者追加裁決):booking_window_max_days = 0 是合法設定,語意是「最遠只能約到今天」= 只能預約當天(一定要當天預約當天完成)。使用者明講幾乎不會用到,但要求預留這個可能性'
);

select is(
  (select booking_window_max_days from merchant_staff where id = 'e3060000-0000-4000-8000-000000000041'),
  0,
  '§3:0 確實存進去了(不是被約束擋掉也不是被轉成 null)'
);

-- =========================================================================
-- ④ advance_booking_days(新語意「最少要提前幾天」):0 合理、負數沒有意義。
-- =========================================================================
-- ⚠️ 兩個 0 的語意完全相反,這兩條斷言刻意放在一起對照,避免之後有人搞混:
--   ・advance_booking_days = 0      → 「不需要提前」= 當天就可以預約(最寬鬆,不擋任何日期)
--   ・booking_window_max_days = 0   → 「最遠只能約到今天」= 只能預約當天(最嚴格)
-- 使用者自己在討論時也一度把這兩個講反,所以測試裡也留下這個對照。
select lives_ok(
  $$update merchant_staff set advance_booking_days = 0
    where id = 'e3060000-0000-4000-8000-000000000041'$$,
  '§4:advance_booking_days = 0(「不需要提前」= 當天就可以預約,最寬鬆的設定)是合理值,必須存得進去。⚠️ 注意這個 0 跟 booking_window_max_days = 0(「只能預約當天」,最嚴格)意思剛好相反'
);

select throws_ok(
  $$update merchant_staff set advance_booking_days = -1
    where id = 'e3060000-0000-4000-8000-000000000041'$$,
  '23514', null,
  '§4:advance_booking_days 負數沒有任何意義,被新增的防呆約束擋下(原本這個欄位完全沒有約束,打 -5 會被靜默存進資料庫)'
);

select * from finish();

rollback;
