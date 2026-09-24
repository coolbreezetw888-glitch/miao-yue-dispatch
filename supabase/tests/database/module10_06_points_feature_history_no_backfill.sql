-- 2026-09-24 使用者裁決(migration 20260924040300)的回歸測試:
--   任務 5:紅利點數關閉期間錯過的,**不補發**
--
-- 【使用者裁決原文】
--   「B,原因是紅利點數都關閉了,自然就沒有這個點數派不派發與給不給的問題,
--     因為這個機制關閉的時候代表根本不存在。」
--
-- 【這份測試跟 points_feature_toggle_01 的分工】
--   ・points_feature_toggle_01 驗的是「開關**現在**是關著的時候不要發」,以及推薦獎勵的
--     「不補發」(那條靠「數已完成訂單」達成,同一個交易內就驗得出來)。
--   ・這份檔案驗的是**生日贈點**的「不補發」。它必須獨立成一份,因為那個情境需要一段
--     「跨越整個日曆日」的關閉區間才驗得出來——在同一個測試交易裡把開關關掉再打開只差幾毫秒,
--     沒辦法讓某位會員的生日整天落進關閉區間。所以這裡用「以 postgres 身分直接寫入
--     merchant_points_feature_history 的區間」來製造精確的時間軸(比照 module8_02 §11.5
--     手動改寫 staff_payroll_status_history 的既有做法)。
--
-- 【這份測試最重要的兩件事,順序不要顛倒】
--   ① 生日落在關閉區間內 → 不發,而且重新打開後也永遠不補發。
--   ② ⚠️ 但是「商家只是把開關關掉幾分鐘測試一下」**不可以**吃掉當天生日會員的獎勵。
--      這是這次實作刻意避開的不可逆副作用(否決了「關閉時就寫入已發放標記」那個做法的唯一理由),
--      所以它跟 ① 一樣是核心斷言,不是附加的 nice-to-have。
begin;

select plan(20);

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
  ('da060000-0000-4000-8000-000000000001', 'pgtap-m1006-admin@test.local');

insert into groups (id) values ('da060000-0000-4000-8000-000000000010');

insert into merchants (id, group_id, name, industry_type)
values ('da060000-0000-4000-8000-000000000020', 'da060000-0000-4000-8000-000000000010',
        '紅利開關歷史測試店', 'in_store_beauty');

insert into merchant_admins (merchant_id, user_id)
values ('da060000-0000-4000-8000-000000000020', 'da060000-0000-4000-8000-000000000001');

-- 生日贈點 30 點,不設資格條件(讓這份測試只變動「開關歷史」這一個變數)。
-- 這個 insert 會觸發 §2 的觸發器,種下這個商家的第一筆歷史(enabled=true)。
insert into merchant_member_settings (
  merchant_id, points_earn_rate, referral_bonus_points, birthday_bonus_points
) values ('da060000-0000-4000-8000-000000000020', 100, 50, 30);

-- =========================================================================
-- ① 觸發器與歷史表本身:第一次建立設定列就要種下一筆「目前生效中」的歷史。
-- =========================================================================
select is(
  (select count(*)::int from merchant_points_feature_history
   where merchant_id = 'da060000-0000-4000-8000-000000000020'),
  1,
  '§2 觸發器:第一次 INSERT merchant_member_settings 就自動種下一筆開關歷史(insert 面要掛觸發器,否則這個商家永遠沒有歷史起點)'
);

select is(
  (select enabled from merchant_points_feature_history
   where merchant_id = 'da060000-0000-4000-8000-000000000020' and effective_to is null),
  true,
  '§2:目前生效中的那一筆 enabled = true(欄位 schema 預設值)'
);

-- 改一個「無關欄位」不該產生雜訊歷史列(觸發器只監看 points_feature_enabled)。
update merchant_member_settings set policy_content = '測試政策'
where merchant_id = 'da060000-0000-4000-8000-000000000020';

select is(
  (select count(*)::int from merchant_points_feature_history
   where merchant_id = 'da060000-0000-4000-8000-000000000020'),
  1,
  '§2:只改了會員政策(points_feature_enabled 沒變)不會產生雜訊歷史列'
);

-- 真的切換開關 → 結算舊區間、開新區間。
update merchant_member_settings set points_feature_enabled = false
where merchant_id = 'da060000-0000-4000-8000-000000000020';

select is(
  (select count(*)::int from merchant_points_feature_history
   where merchant_id = 'da060000-0000-4000-8000-000000000020'),
  2,
  '§2:真的切換 points_feature_enabled 才會結算舊區間並開一筆新區間'
);

select ok(
  (select effective_to is not null from merchant_points_feature_history
   where merchant_id = 'da060000-0000-4000-8000-000000000020' and enabled = true),
  '§2:舊的 enabled=true 區間被正確結算(effective_to 有值)'
);

-- 切回來,讓後面的測試在「目前是開著」的狀態下跑(生日贈點的「現在關著就整批不處理」那一關
-- 已經由 points_feature_toggle_01 驗過,這份檔案要驗的是「現在開著、但生日那天關著」)。
update merchant_member_settings set points_feature_enabled = true
where merchant_id = 'da060000-0000-4000-8000-000000000020';

-- =========================================================================
-- 手動改寫開關歷史時間軸,製造出「本月 1 號 ~ 本月 20 號功能是關著的」這段區間。
-- 先清掉上面那幾筆測試用的雜訊列,再寫入乾淨的三段區間:
--   段 1:enabled=true,2025-01-01 ~ 本月 1 號 00:00
--   段 2:enabled=false,本月 1 號 00:00 ~ 本月 20 號 00:00   ← 關閉區間
--   段 3:enabled=true,本月 20 號 00:00 ~ null(目前生效中)
-- 全部以 Asia/Taipei 為基準,跟 private.was_points_feature_enabled_on 的判斷粒度一致。
-- =========================================================================
delete from merchant_points_feature_history
where merchant_id = 'da060000-0000-4000-8000-000000000020';

insert into merchant_points_feature_history (merchant_id, enabled, effective_from, effective_to, is_backfill_seed) values
  ('da060000-0000-4000-8000-000000000020', true,
   '2025-01-01 00:00:00+08'::timestamptz,
   (date_trunc('month', current_date)::date::text || ' 00:00:00+08')::timestamptz,
   true),
  ('da060000-0000-4000-8000-000000000020', false,
   (date_trunc('month', current_date)::date::text || ' 00:00:00+08')::timestamptz,
   ((date_trunc('month', current_date)::date + 19)::text || ' 00:00:00+08')::timestamptz,
   false),
  ('da060000-0000-4000-8000-000000000020', true,
   ((date_trunc('month', current_date)::date + 19)::text || ' 00:00:00+08')::timestamptz,
   null,
   false);

-- =========================================================================
-- ② private.was_points_feature_enabled_on:先直接驗判斷函式本身(三種情況)。
-- =========================================================================
select is(
  private.was_points_feature_enabled_on(
    'da060000-0000-4000-8000-000000000020', (date_trunc('month', current_date)::date + 4)
  ),
  false,
  '§3(核心):本月 5 號落在關閉區間(1 號~20 號)內 → was_points_feature_enabled_on 回傳 false'
);

select is(
  private.was_points_feature_enabled_on(
    'da060000-0000-4000-8000-000000000020', (date_trunc('month', current_date)::date + 24)
  ),
  true,
  '§3:本月 25 號在重新打開之後 → 回傳 true'
);

select is(
  private.was_points_feature_enabled_on(
    'da060000-0000-4000-8000-000000000020', '2020-01-01'::date
  ),
  true,
  '§3(fallback 方向):查詢的日期早於這個商家最早一筆歷史(這個機制上線前)→ 回傳 true,不拿「系統以前沒在記錄」這件事去追溯沒收商家的獎勵'
);

-- 邊界:關閉區間的最後一天(19 號,因為區間在 20 號 00:00 結束)仍然是關著的;
-- 20 號當天有一刻是開著的(00:00 起就開了)→ 算開著。
select is(
  private.was_points_feature_enabled_on(
    'da060000-0000-4000-8000-000000000020', (date_trunc('month', current_date)::date + 18)
  ),
  false,
  '§3(邊界):本月 19 號是關閉區間的最後一整天 → false'
);

select is(
  private.was_points_feature_enabled_on(
    'da060000-0000-4000-8000-000000000020', (date_trunc('month', current_date)::date + 19)
  ),
  true,
  '§3(邊界):本月 20 號當天 00:00 就重新打開了 → 該日有開著的時刻 → true'
);

-- =========================================================================
-- ③ 核心必測:生日落在關閉區間內的會員 → 不發,而且重新打開後也不補發。
--    (目前開關是 true,所以整批處理不會被「現在關著」那一關擋下,真正擋下他的是生日那天的歷史。)
-- =========================================================================
select pg_temp.test_set_auth('da060000-0000-4000-8000-000000000001');

-- 會員 X:生日 = 本月 5 號(落在關閉區間 1~20 號內)。
select id from create_member(
  'da060000-0000-4000-8000-000000000020', '生日在關閉期間的會員', '0955100601',
  p_birthday => (date_trunc('month', current_date)::date + 4)
) \gset member_x_

-- 會員 Y:生日 = 本月 25 號(在重新打開之後)——對照組,證明生日贈點整體是正常運作的。
select id from create_member(
  'da060000-0000-4000-8000-000000000020', '生日在重新打開後的會員', '0955100602',
  p_birthday => (date_trunc('month', current_date)::date + 24)
) \gset member_y_

select is(
  grant_pending_birthday_bonuses('da060000-0000-4000-8000-000000000020'),
  1,
  '任務 5(核心):兩位本月生日的會員,只有 1 位被核發——生日落在關閉區間內的那位被略過(使用者裁決:「這個機制關閉的時候代表根本不存在」)'
);

select is(
  (select points_balance from members where id = :'member_x_id'::uuid),
  0,
  '任務 5(核心):生日(本月 5 號)落在關閉區間內的會員 X,餘額仍然是 0——沒有補發'
);

select is(
  (select points_balance from members where id = :'member_y_id'::uuid),
  30,
  '任務 5(對照組):生日(本月 25 號)在重新打開之後的會員 Y 正常拿到 30 點——證明上面的「不發」是歷史判斷生效,不是生日贈點整體壞掉'
);

select ok(
  (select last_birthday_bonus_year is null from members where id = :'member_x_id'::uuid),
  '任務 5(核心,不寫假標記):被略過的會員 X 的 last_birthday_bonus_year 仍然是 null——不補發是靠「查歷史狀態」達成的,完全沒有寫入任何謊稱「今年已發過」的假紀錄(那種做法會讓之後查帳對不上)'
);

-- 再跑一次:必須冪等,而且會員 X 永遠不會突然被補發(因為判斷依據是歷史,跟現在開關無關)。
select is(
  grant_pending_birthday_bonuses('da060000-0000-4000-8000-000000000020'),
  0,
  '任務 5:重複執行冪等——Y 已經發過(last_birthday_bonus_year 已標記),X 則是因為生日那天功能關著而永久略過,兩者都不會再處理'
);

select is(
  (select points_balance from members where id = :'member_x_id'::uuid),
  0,
  '任務 5(核心):重複執行後會員 X 的餘額還是 0——「不補發」是永久的,不是延後發(這個略過不需要靠標記就永遠穩定)'
);

select pg_temp.test_clear_auth();

-- =========================================================================
-- ④ ⚠️ 副作用防護(跟 ③ 同等重要):商家只是把開關關掉「一小段時間」測試一下,
--    不可以吃掉當天生日會員的獎勵。
--    做法:在會員 Z 的生日當天,製造一段「只有幾分鐘」的關閉區間,其餘時間都是開著的。
--    private.was_points_feature_enabled_on 的判斷粒度是「那天有任何一刻開著就算開著」,
--    所以 Z 必須照樣拿到獎勵。
-- =========================================================================
delete from merchant_points_feature_history
where merchant_id = 'da060000-0000-4000-8000-000000000020';

insert into merchant_points_feature_history (merchant_id, enabled, effective_from, effective_to, is_backfill_seed) values
  -- 一直開著,直到本月 10 號 10:00
  ('da060000-0000-4000-8000-000000000020', true,
   '2025-01-01 00:00:00+08'::timestamptz,
   ((date_trunc('month', current_date)::date + 9)::text || ' 10:00:00+08')::timestamptz,
   true),
  -- 本月 10 號 10:00 ~ 10:05 關掉五分鐘(商家測試一下畫面)
  ('da060000-0000-4000-8000-000000000020', false,
   ((date_trunc('month', current_date)::date + 9)::text || ' 10:00:00+08')::timestamptz,
   ((date_trunc('month', current_date)::date + 9)::text || ' 10:05:00+08')::timestamptz,
   false),
  -- 之後又開著
  ('da060000-0000-4000-8000-000000000020', true,
   ((date_trunc('month', current_date)::date + 9)::text || ' 10:05:00+08')::timestamptz,
   null,
   false);

select is(
  private.was_points_feature_enabled_on(
    'da060000-0000-4000-8000-000000000020', (date_trunc('month', current_date)::date + 9)
  ),
  true,
  '任務 5(核心副作用防護):商家在本月 10 號只把開關關掉五分鐘 → 該日仍然算「功能開著」(判斷粒度是「那天有任何一刻開著」),不會因此永久吃掉當天生日會員的獎勵'
);

select pg_temp.test_set_auth('da060000-0000-4000-8000-000000000001');

select id from create_member(
  'da060000-0000-4000-8000-000000000020', '生日當天商家關了五分鐘的會員', '0955100603',
  p_birthday => (date_trunc('month', current_date)::date + 9)
) \gset member_z_

-- ⚠️ 這裡期望值是 2 而不是 1,原因很重要,而且本身就是一條有價值的證據:
--    上面 ③ 被略過的會員 X(生日本月 5 號)在這一段裡也會被核發——因為這一段把開關歷史改寫成
--    「只有 10 號 10:00~10:05 關著」,本月 5 號那天變成是開著的,所以 X 現在符合資格了。
--    這證明了 ③ 對 X 的略過**完全沒有在會員身上留下任何持久化痕跡**:判斷 100% 來自開關歷史,
--    歷史一改、結論就跟著改。如果當初採用的是「關閉時寫入 last_birthday_bonus_year 假標記」
--    那個被否決的做法,X 這時候就永遠回不來了(而且資料庫裡還躺著一筆從沒發出去的「已發過」紀錄)。
select is(
  grant_pending_birthday_bonuses('da060000-0000-4000-8000-000000000020'),
  2,
  '任務 5(核心副作用防護):生日當天商家只關了五分鐘的會員 Z 照樣被核發;同時會員 X 也回來了(這一段的歷史裡本月 5 號是開著的)——證明 ③ 對 X 的略過純粹由開關歷史決定,沒有在會員身上寫下任何不可逆的假標記'
);

select is(
  (select points_balance from members where id = :'member_z_id'::uuid),
  30,
  '任務 5(核心副作用防護):會員 Z 實際拿到 30 點——商家關開關五分鐘測試一下,不會吃掉當天生日會員的獎勵'
);

select is(
  (select points_balance from members where id = :'member_x_id'::uuid),
  30,
  '任務 5(不寫假標記的直接證據):會員 X 在歷史改寫成「他生日那天是開著的」之後就拿到了 30 點——如果當初採用「關閉時寫入已發放標記」的做法,他會永久拿不到,而且會留下一筆假的「今年已發過」紀錄'
);

select pg_temp.test_clear_auth();

select * from finish();

rollback;
