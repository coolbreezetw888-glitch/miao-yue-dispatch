-- 2026-09-24 使用者裁決修補(紅利點數關閉期間錯過的,**不補發**)。
--
-- =========================================================================
-- 【使用者裁決原文】
--   「B,原因是紅利點數都關閉了,自然就沒有這個點數派不派發與給不給的問題,
--     因為這個機制關閉的時候代表根本不存在。」
--
-- 【這次要推翻的是什麼】
-- 上一支 20260924030000_points_feature_enabled_backend_enforcement.sql 選擇了
-- 「關閉期間不留任何標記」,結論是**會補發**:
--   ・推薦獎勵 → 完整補得回來(關閉期間沒寫 earn_booking,「第一筆消費累點」的資格還在)
--   ・生日贈點 → 同月內補得回來
-- 使用者的裁決正好相反:關閉期間發生的資格事件,視為「已經過去了」,重新打開後不補。
--
-- =========================================================================
-- 【實作方式:我選了什麼、為什麼,以及我明確否決了什麼】
--
-- 主腦已經指出這一題的核心違和感:「在功能關閉時去寫入已發放標記」這件事本身很怪,而且有一個
-- 很嚴重的副作用。我同意,所以**兩條路徑都不採用「關閉時寫入已發放標記」的做法**。
--
-- ── 我否決的做法(以及為什麼)────────────────────────────────────
-- 【否決案】在 points_feature_enabled 由 true → false 的那一刻,把當月所有「生日在本月、
--   今年還沒發過」的會員 last_birthday_bonus_year 一次標記成今年。
--   否決理由(就是主腦擔心的那件事,而且真的會發生):
--   商家只是想「關掉五分鐘看看畫面長什麼樣」,或是誤點了開關馬上關回來——這一下就**永久**
--   吃掉了整批當月生日會員的獎勵,而且事後完全救不回來(資料庫裡只剩一筆「今年已發過」的
--   假紀錄,沒有任何線索指出它其實從來沒發出去)。用一個「可逆的設定開關」去造成「不可逆的
--   資料損失」,是設計錯誤,不是實作細節。另外它還會在查帳時留下對不起來的假紀錄
--   (members.last_birthday_bonus_year 說發過了,member_point_transactions 裡卻一筆都沒有)。
--
-- ── 我採用的做法:記錄「開關本身的歷史」,發放時回頭問「那個資格事件發生的當天,功能開著嗎」──
-- 完全不寫任何「已發放」標記,改成新增一張開關異動歷史表,把「這個商家的紅利點數功能在哪些
-- 時間區間是開著/關著」如實記下來;核發時再回頭查「該會員生日那一天,功能是開著的嗎」。
--
-- 為什麼這是對的:
--   (1) 唯一的寫入是「商家按了開關」這個**事實本身**的稽核紀錄,不是一筆謊稱「已經發過獎勵」
--       的假紀錄。關閉功能時不再對任何會員資料做破壞性寫入。
--   (2) 五分鐘測試開關不會吃掉任何人的獎勵:判斷的粒度是「該生日當天(Asia/Taipei 整天)
--       有沒有任何一刻功能是開著的」,關五分鐘那天其他 23 小時 55 分都是開著的 → 照發。
--   (3) 完全滿足使用者裁決:功能真的關了一整天(或好幾個月),那天過生日的會員就是沒有,
--       而且重新打開之後也不會被補回來——因為判斷依據是「那天的歷史狀態」,跟現在是開還是關無關,
--       這個判斷永遠穩定、永遠冪等,不需要靠標記去「記得已經跳過了」。
--   (4) 這個「合併型生效區間歷史表 + 觸發器自動維護 + 上線當下種子紀錄」的模式,是這個專案
--       **既有的**設計語言,不是我另外發明的:public.staff_payroll_status_history
--       (20260922150000 §11.1 / 20260922150100 §11.2/11.3)就是同一套結構,連
--       clock_timestamp() 而不是 now() 這個坑都已經踩過並寫成註解。照抄既有模式的維護成本
--       遠低於發明新做法。
--   (5) 附帶好處:商家/客服之後如果爭執「我幾月幾號就關掉了,為什麼還在發點」,這張表就是答案。
--
-- 代價(誠實列出):多一張表、一支觸發器、一支判斷函式。對「只是不要補發」這個需求來說,
-- 這比「寫一行標記」重。我認為值得,因為否決案的副作用是**不可逆的資料損失**;但這是一個
-- 產品判斷,如果主腦/使用者認為寧可接受「關掉就吃掉當月生日」也要少一張表,請告知,改回來不難。
--
-- ── 推薦獎勵完全不需要這張表(這是這次設計最乾淨的一段)────────────────────
-- 使用者要的是「關閉期間被推薦人完成了訂單,那次『第一筆消費』的資格要視為已用掉」。
-- 原本的判斷條件是「這是這位被推薦人的第 1 筆 **earn_booking 點數異動紀錄**」——功能關閉期間
-- 不寫 earn_booking,所以那個名額一直空著,這才是它會被補發的原因。
-- 這次把判斷改成「這是這位被推薦人的第 1 筆 **已完成訂單**」:
--   ・已完成訂單這個事實,不管紅利點數功能開著還是關著都一樣會存在 → 關閉期間完成的那一筆
--     自然就把名額用掉了,重新打開後下一筆訂單的計數是 2,推薦獎勵不會再觸發。
--   ・**關閉期間完全不需要寫入任何東西**,連歷史表都不用查。
--   ・而且「第一筆消費」本來就該用「第一筆消費」來定義,用「第一筆點數異動」去代表它,原本就是
--     一個實作方便造成的偏差。
-- ⚠️ 附帶的行為變化(誠實列出,已在回報中提出):如果某位會員的第一筆已完成訂單當時因為
--    points_earn_rate 還是 0(或金額太小算不到 1 點、或不符合 reward_condition_mode)而沒有
--    產生 earn_booking,舊邏輯會把「之後第一筆真的有累到點的訂單」當成第一筆而觸發推薦獎勵,
--    新邏輯則認定名額已經在第一筆已完成訂單時用掉了。我認為新行為才是對的(「第一筆消費」
--    指的是消費,不是點數),但這確實是超出「關閉期間不補發」這個問題本身的變化。
--
-- 【簽章不變】兩支函式都是 create or replace、簽章一字不改。
-- 權限設定(revoke/grant)照原樣重新宣告一次(supabase-permission-hygiene)。
-- =========================================================================

-- =========================================================================
-- §1 merchant_points_feature_history:紅利點數功能開關的異動歷史(合併型生效區間表)。
--     結構完全比照 public.staff_payroll_status_history(20260922150000 §11.1)。
-- =========================================================================
create table public.merchant_points_feature_history (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  enabled boolean not null,
  -- 預設值用 clock_timestamp() 不是 now(),理由完全同 staff_payroll_status_history:
  -- 實際寫入一律由 §2 的函式明確帶入,這裡只是防禦性欄位定義,維持一致的時間語意。
  effective_from timestamptz not null default clock_timestamp(),
  effective_to timestamptz,
  is_backfill_seed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint merchant_points_feature_history_effective_range_check
    check (effective_to is null or effective_to > effective_from)
);

comment on table public.merchant_points_feature_history is '2026-09-24 使用者裁決(「紅利點數都關閉了,自然就沒有這個點數派不派發與給不給的問題,因為這個機制關閉的時候代表根本不存在」):商家 merchant_member_settings.points_feature_enabled 這個開關的異動歷史(合併型生效區間表,結構比照 public.staff_payroll_status_history §11.1)。effective_to is null 代表目前生效中的一筆。存在的唯一目的是讓 grant_pending_birthday_bonuses 能回頭問「該會員生日那一天,這個商家的紅利點數功能是開著的嗎」,從而做到「關閉期間錯過的生日獎勵不補發」,又不必在關閉功能時對會員資料寫入任何謊稱「已發放」的假標記(那種做法會讓商家只是關開關五分鐘測試就永久吃掉整批當月生日會員的獎勵,且不可逆)。is_backfill_seed=true 只有這支 migration 一次性回填的種子紀錄才是 true。完全透過 §2 的觸發器(SECURITY DEFINER)寫入,沒有 INSERT/UPDATE/DELETE 政策。';
comment on column public.merchant_points_feature_history.enabled is '這個生效區間內,points_feature_enabled 的值。true=功能開著,false=功能關著。';
comment on column public.merchant_points_feature_history.effective_to is 'NULL 代表這是目前生效中的一筆,任何時刻每個商家最多只有一筆(見下方 partial unique index)。';
comment on column public.merchant_points_feature_history.is_backfill_seed is '只有這支 migration 上線當下一次性回填的起始紀錄是 true,之後任何正常異動(觸發器產生)一律 false。';

-- 保證每個商家任何時刻最多只有一筆「目前生效中」的紀錄。
create unique index merchant_points_feature_history_current_uidx
  on public.merchant_points_feature_history (merchant_id)
  where effective_to is null;

-- 供「查詢某一天有沒有跟哪些區間重疊」使用(§3)。
create index merchant_points_feature_history_merchant_range_idx
  on public.merchant_points_feature_history (merchant_id, effective_from, effective_to);

-- RLS:只開放 SELECT,要求 private.can_manage_members(merchant_id)(看得到會員的人才看得到
-- 這個商家的紅利開關歷史)。沒有 INSERT/UPDATE/DELETE 政策——一律透過 §2 的觸發器寫入。
alter table public.merchant_points_feature_history enable row level security;

create policy merchant_points_feature_history_select on public.merchant_points_feature_history
  for select to authenticated
  using (private.can_manage_members(merchant_id));

-- =========================================================================
-- §2 自動記錄異動的觸發器(完全比照 20260922150100 §11.2 的 sync 函式結構)。
-- =========================================================================
create or replace function private.sync_merchant_points_feature_history(
  p_merchant_id uuid,
  p_is_backfill_seed boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
  v_current_id uuid;
  v_current_enabled boolean;
  -- ⚠️ 用 clock_timestamp() 不是 now()——理由完全同 private.sync_staff_payroll_status_history
  -- 的 v_now 註解:同一個 transaction 內 now() 永遠是同一個值,如果同一個 transaction 內這支
  -- 函式被呼叫兩次以上(pgTAP 測試 fixture 很常見:同一個交易裡先關掉再打開),第二次要結算
  -- 「第一次剛建立」的那筆舊紀錄時,新的 effective_to 會等於那筆舊紀錄自己的 effective_from,
  -- 違反 CHECK(effective_to > effective_from)。
  v_now timestamptz := clock_timestamp();
begin
  select points_feature_enabled into v_enabled
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    -- 設定列被刪掉了(目前沒有 DELETE 政策,理論上不會發生):防呆直接 return,不猜測狀態。
    return;
  end if;

  select id, enabled into v_current_id, v_current_enabled
  from public.merchant_points_feature_history
  where merchant_id = p_merchant_id and effective_to is null;

  -- 值跟目前生效中的紀錄相同就什麼都不做(避免「只改了 policy_content 這種無關欄位順帶觸發
  -- UPDATE」產生一堆雜訊列)。不同才結算舊區間、開新區間。
  if v_current_id is null or v_current_enabled is distinct from v_enabled then
    if v_current_id is not null then
      update public.merchant_points_feature_history
      set effective_to = v_now
      where id = v_current_id;
    end if;

    insert into public.merchant_points_feature_history (
      merchant_id, enabled, effective_from, is_backfill_seed
    ) values (
      p_merchant_id, v_enabled, v_now, p_is_backfill_seed
    );
  end if;
end;
$$;

comment on function private.sync_merchant_points_feature_history(uuid, boolean) is '2026-09-24:比對 merchant_member_settings.points_feature_enabled 目前值跟 merchant_points_feature_history 目前生效中的紀錄,不同才結算舊區間(effective_to)、開新區間;相同則不動作(避免只改了會員政策等無關欄位時產生雜訊列)。時間點用 clock_timestamp() 不是 now(),理由完全同 private.sync_staff_payroll_status_history 的 v_now 註解(同一交易內連續呼叫兩次會讓新的 effective_to 等於舊紀錄自己的 effective_from 而違反 CHECK)。p_is_backfill_seed 只有這支 migration 的一次性回填會帶 true。只給觸發器/回填呼叫,不對外暴露。';

revoke execute on function private.sync_merchant_points_feature_history(uuid, boolean) from public, anon;
grant execute on function private.sync_merchant_points_feature_history(uuid, boolean) to authenticated;

-- ⚠️ 必須是 SECURITY DEFINER:merchant_points_feature_history 完全沒有給 authenticated 任何
-- 寫入政策,商家管理員/客服透過一般的 upsert merchant_member_settings 觸發這個 trigger 時,
-- 如果 trigger 函式不是 SECURITY DEFINER,寫入會被 RLS 擋下而整個存檔失敗。
-- (這個坑 20260922150100 §11.2 的實作警語已經明確記過一次。)
create or replace function private.merchant_member_settings_sync_points_feature_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform private.sync_merchant_points_feature_history(new.merchant_id);
  return new;
end;
$$;

comment on function private.merchant_member_settings_sync_points_feature_history() is '2026-09-24:merchant_member_settings.points_feature_enabled 異動(含第一次 INSERT)時,自動同步 merchant_points_feature_history。SECURITY DEFINER(理由見上方函式註解:歷史表沒有給 authenticated 寫入政策)。';

-- after insert or update of points_feature_enabled:
--   ・insert 面要掛,因為商家第一次存會員設定時這一列才被建立,那一刻就是這個商家的歷史起點。
--   ・update 只監看 points_feature_enabled 這一欄,其他欄位(會員政策等)改動不會觸發。
create trigger merchant_member_settings_sync_points_feature_history
  after insert or update of points_feature_enabled on public.merchant_member_settings
  for each row execute function private.merchant_member_settings_sync_points_feature_history();

-- =========================================================================
-- §3 private.was_points_feature_enabled_on(p_merchant_id uuid, p_date date) returns boolean。
--     「這個商家在 p_date 這一天(Asia/Taipei 整天),紅利點數功能有沒有任何一刻是開著的?」
-- =========================================================================
create or replace function private.was_points_feature_enabled_on(
  p_merchant_id uuid,
  p_date date
)
returns boolean
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_day_start timestamptz;
  v_day_end timestamptz;
begin
  -- 以 Asia/Taipei 的整天為判斷粒度(比照本專案一貫的 `... at time zone 'Asia/Taipei'` 邊界寫法)。
  v_day_start := p_date::timestamp at time zone 'Asia/Taipei';
  v_day_end := (p_date + 1)::timestamp at time zone 'Asia/Taipei';

  -- 1. 這一天之內有任何一段「功能開著」的區間 → 視為那天是開著的。
  --    ⚠️ 刻意用「有任何一刻開著」而不是「整天都開著」:這是「商家關開關五分鐘測試一下,不會
  --    因此吃掉當天生日會員的獎勵」這個副作用防護的關鍵,不是寬鬆隨便訂的。
  if exists (
    select 1
    from public.merchant_points_feature_history h
    where h.merchant_id = p_merchant_id
      and h.enabled
      and h.effective_from < v_day_end
      and (h.effective_to is null or h.effective_to > v_day_start)
  ) then
    return true;
  end if;

  -- 2. 沒有任何「開著」的區間跟這一天重疊。再分兩種情況:
  --    (a) 有「關著」的區間跟這一天重疊 → 那天確實整天是關著的 → false(這就是不補發的情境)。
  if exists (
    select 1
    from public.merchant_points_feature_history h
    where h.merchant_id = p_merchant_id
      and h.effective_from < v_day_end
      and (h.effective_to is null or h.effective_to > v_day_start)
  ) then
    return false;
  end if;

  --    (b) 完全沒有任何區間跟這一天重疊 —— 代表這一天早於這個商家最早一筆歷史紀錄
  --        (也就是這個歷史機制上線之前,或這個商家還沒建立過會員設定列)。
  --        這種情況沒有任何證據說當時功能是關著的,而 points_feature_enabled 的 schema 預設
  --        就是 true(20260922160400:17),所以回 true。
  --        ⚠️ 這個 fallback 的方向是刻意選 true 而不是 false:選 false 等於「因為我們以前沒在
  --        記錄,所以你過去所有會員的生日獎勵一律沒收」,那是拿系統自己的限制去懲罰商家。
  --        比照 §11.5 對機制上線前的處理精神(用種子紀錄回推,而不是一律當作不存在)。
  return true;
end;
$$;

comment on function private.was_points_feature_enabled_on(uuid, date) is '2026-09-24(使用者裁決「紅利點數都關閉了…這個機制關閉的時候代表根本不存在」):查詢某商家在某一天(Asia/Taipei 整天)紅利點數功能有沒有任何一刻是開著的,供 grant_pending_birthday_bonuses 判斷「該會員生日那天功能開著嗎」,做到關閉期間錯過的生日獎勵不補發。判斷粒度刻意是「那天有任何一刻開著就算開著」而不是「整天都開著」——這樣商家把開關關掉五分鐘測試一下,不會永久吃掉當天生日會員的獎勵(那種不可逆的副作用是這次刻意避開的設計陷阱)。完全沒有歷史紀錄涵蓋該日時(該日早於歷史機制上線,或該商家還沒建立過會員設定列)回傳 true,不拿系統自己以前沒在記錄這件事去追溯沒收商家的獎勵。只給模組 10 內部函式呼叫,不對外暴露。';

revoke execute on function private.was_points_feature_enabled_on(uuid, date) from public, anon;
grant execute on function private.was_points_feature_enabled_on(uuid, date) to authenticated;

-- =========================================================================
-- §4 一次性種子回填:對這支 migration 執行當下所有既有的 merchant_member_settings 逐一
--     產生起始紀錄,標記 is_backfill_seed=true。比照 20260922150100 §11.3 的做法。
--
-- 本機/pgTAP 環境跑 migration 時通常沒有任何既有 merchant_member_settings 資料(測試資料都在
-- 各自測試檔案的 transaction 裡建立),這段實際上是 no-op;正式環境套用時才會真的產生種子紀錄。
-- =========================================================================
do $$
declare
  v_merchant_id uuid;
begin
  for v_merchant_id in select merchant_id from public.merchant_member_settings loop
    perform private.sync_merchant_points_feature_history(v_merchant_id, true);
  end loop;
end;
$$;

-- =========================================================================
-- §5 grant_pending_birthday_bonuses:加上「該會員生日那天功能開著嗎」的逐人判斷。
--
-- 完整照抄 20260924030000_points_feature_enabled_backend_enforcement.sql:263 的版本,
-- 只加上迴圈內的 was_points_feature_enabled_on 判斷(以及對應的變數與註解)。
-- 既有的「目前開關為 false 就整批回傳 0」那一段**保留不動**(它是「現在關著就不要發」,
-- 跟這次新增的「那天關著所以不補發」是兩件互補的事,既有測試也釘著它)。
-- =========================================================================
create or replace function public.grant_pending_birthday_bonuses(p_merchant_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward_condition_mode text;
  v_points_feature_enabled boolean;
  v_bonus_points integer;
  v_granted_count integer := 0;
  v_member record;
  v_new_balance integer;
  v_current_year integer := extract(year from current_date)::int;
  v_month_first date := date_trunc('month', current_date)::date;
  v_birthday_this_year date;
begin
  if not private.can_manage_members(p_merchant_id) then
    raise exception '沒有權限管理這間商家的會員' using errcode = '42501';
  end if;

  select reward_condition_mode, birthday_bonus_points, points_feature_enabled
  into v_reward_condition_mode, v_bonus_points, v_points_feature_enabled
  from public.merchant_member_settings
  where merchant_id = p_merchant_id;

  if not found then
    v_reward_condition_mode := 'none';
    v_bonus_points := 0;
    v_points_feature_enabled := true;
  end if;

  -- (2026-09-24 使用者裁決:「關閉後就不計算點數了。」)
  -- 「現在」功能是關著的 → 整批不處理,回傳 0。權限檢查照常在上面執行過(沒權限仍然拋 42501)。
  if not coalesce(v_points_feature_enabled, true) then
    return 0;
  end if;

  for v_member in
    select id, phone_verified, line_bound, points_balance, birthday
    from public.members
    where merchant_id = p_merchant_id
      and status = 'active'
      and birthday is not null
      and extract(month from birthday) = extract(month from current_date)
      and (last_birthday_bonus_year is null or last_birthday_bonus_year < v_current_year)
    for update
  loop
    -- =====================================================================
    -- (2026-09-24 使用者裁決:「紅利點數都關閉了,自然就沒有這個點數派不派發與給不給的問題,
    --  因為這個機制關閉的時候代表根本不存在。」)
    --
    -- 這位會員今年的生日那一天,這個商家的紅利點數功能是開著的嗎?關著 → 那天等於這個機制
    -- 根本不存在,這份獎勵就是沒有,而且之後也不會被補回來(判斷依據是歷史狀態,跟現在開關
    -- 是開還是關無關,所以這個略過是永久且冪等的,不需要寫任何「已跳過」標記)。
    --
    -- 生日日期的算法:上面的查詢條件已經限定「生日月份 = 本月」,所以今年的生日一定落在本月。
    -- 用「本月 1 號 + (生日的日 - 1)」再用 least(...) 夾住本月最後一天——這個夾法是為了處理
    -- 2/29 生日遇到平年的情況(直接 make_date(2027,2,29) 會拋 date field value out of range),
    -- 平年時視為 2/28。
    -- =====================================================================
    v_birthday_this_year := least(
      v_month_first + (extract(day from v_member.birthday)::int - 1),
      (v_month_first + interval '1 month - 1 day')::date
    );

    if not private.was_points_feature_enabled_on(p_merchant_id, v_birthday_this_year) then
      continue;
    end if;

    -- (#619)資格條件不符時,這條路徑靜默略過,不標記年份(留給下次符合資格後補發,呼應原本
    -- 規則 2.8 對電話驗證政策的既有精神,延伸適用到新的五選一條件)。
    if not private.member_meets_reward_condition(
      v_reward_condition_mode, v_member.phone_verified, v_member.line_bound
    ) then
      continue;
    end if;

    if v_bonus_points > 0 then
      v_new_balance := v_member.points_balance + v_bonus_points;
      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after
      ) values (
        v_member.id, p_merchant_id, 'birthday_bonus', v_bonus_points, v_new_balance
      );
      update public.members set points_balance = v_new_balance where id = v_member.id;
    end if;

    -- 規則 2.5:不論獎勵點數是否 > 0,都更新 last_birthday_bonus_year,避免之後調高金額
    -- 又對同一位會員在同一年重複核發。
    update public.members set last_birthday_bonus_year = v_current_year where id = v_member.id;

    v_granted_count := v_granted_count + 1;
  end loop;

  return v_granted_count;
end;
$$;

comment on function public.grant_pending_birthday_bonuses(uuid) is '模組 10 §3.11(規則 2.5,#619 疊加,2026-09-24 兩次疊加 points_feature_enabled 相關行為):任何有 members 權限的人打開會員管理列表頁時觸發,檢查該商家「生日在本月、今年還沒發過生日獎勵」的會員並一次核發完畢。【2026-09-24 第一次疊加】使用者裁決「關閉後就不計算點數了」:points_feature_enabled 目前為 false 時,權限檢查照常執行(沒權限仍然拋 42501),但一位會員都不處理、直接回傳 0,也不標記 last_birthday_bonus_year。【2026-09-24 第二次疊加(本次)】使用者裁決「紅利點數都關閉了,自然就沒有這個點數派不派發與給不給的問題,因為這個機制關閉的時候代表根本不存在」:功能目前是開著的情況下,再逐位會員檢查 private.was_points_feature_enabled_on(該會員今年生日那一天)——那天功能是關著的就永久略過,不補發。判斷依據是 merchant_points_feature_history 的歷史狀態,跟現在開關是開是關無關,所以略過是冪等的,不需要寫入任何「已跳過」標記,也因此不會出現「商家關開關五分鐘測試就永久吃掉整批當月生日會員獎勵」這種不可逆的副作用。生日日期用「本月 1 號 + (生日的日−1)」並用 least 夾住本月最後一天,以處理 2/29 生日遇到平年(視為 2/28,避免 make_date 拋 date field value out of range)。#619:資格判斷用 reward_condition_mode(五選一)。用「生日當月」而不是嚴格「當天」容錯。回傳實際處理的會員數量,冪等操作。';

revoke execute on function public.grant_pending_birthday_bonuses(uuid) from public, anon;
grant execute on function public.grant_pending_birthday_bonuses(uuid) to authenticated;

-- =========================================================================
-- §6 compute_member_loyalty_points:推薦獎勵的「第一筆消費」判斷,從「第 1 筆 earn_booking
--     點數異動」改成「第 1 筆已完成訂單」。
--
-- 完整照抄 20260924030000:88 的版本,只改步驟 7 那一段的計數查詢(以及對應變數名與註解)。
-- 步驟 1~6 與 2.5 的守門、for update 鎖定順序完全不動。
-- =========================================================================
create or replace function public.compute_member_loyalty_points(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_member_id uuid;
  v_final_amount numeric(10, 2);
  v_earn_rate numeric(10, 2);
  v_reward_condition_mode text;
  v_points_feature_enabled boolean;
  v_points integer;
  v_new_balance integer;
  v_inserted boolean;
  v_referred_by uuid;
  v_referral_rewarded_at timestamptz;
  v_referral_bonus_points integer;
  -- 2026-09-24:原本叫 v_prior_earn_count(數 earn_booking 點數異動),改成數「已完成訂單」。
  v_completed_booking_count integer;
  v_phone_verified boolean;
  v_line_bound boolean;
  v_referrer_phone_verified boolean;
  v_referrer_line_bound boolean;
  v_referrer_new_balance integer;
begin
  -- 1. 查 bookings 取得 merchant_id/member_id/final_amount_snapshot。member_id is null 直接 return。
  select merchant_id, member_id, final_amount_snapshot
  into v_merchant_id, v_member_id, v_final_amount
  from public.bookings
  where id = p_booking_id;

  if not found or v_member_id is null then
    return;
  end if;

  -- 2. 查 merchant_member_settings,查無資料視為預設值。
  select points_earn_rate, reward_condition_mode, points_feature_enabled
  into v_earn_rate, v_reward_condition_mode, v_points_feature_enabled
  from public.merchant_member_settings
  where merchant_id = v_merchant_id;

  if not found then
    v_earn_rate := 0;
    v_reward_condition_mode := 'none';
    -- 沿用欄位預設值 true(查無設定列時 earn_rate=0 本來就會在步驟 4 return,
    -- 這裡給 true 只是為了跟 schema 預設一致,不讓「查無資料」變成隱性的關閉)。
    v_points_feature_enabled := true;
  end if;

  -- 2.5(2026-09-24 使用者裁決:「關閉後就不計算點數了。」)
  -- 紅利點數功能關閉時,這條「系統自動核發」的路徑整段不做——消費累點不發,
  -- 步驟 7 的推薦獎勵也因此完全走不到。刻意放在鎖定會員資料列之前:功能關閉時連鎖都不用拿。
  if not coalesce(v_points_feature_enabled, true) then
    return;
  end if;

  -- 鎖定該會員資料列(規則 2.3:計算新餘額前先 for update,避免併發競態算錯餘額)。
  select phone_verified, line_bound, referred_by_member_id, referral_rewarded_at
  into v_phone_verified, v_line_bound, v_referred_by, v_referral_rewarded_at
  from public.members
  where id = v_member_id
  for update;

  -- 3.(#619)依 reward_condition_mode 判斷,不符合就直接 return。
  if not private.member_meets_reward_condition(v_reward_condition_mode, v_phone_verified, v_line_bound) then
    return;
  end if;

  -- =======================================================================
  -- 4~6. 消費累點區塊。
  --
  -- ⚠️⚠️ 2026-09-24(主腦裁決:「推薦獎勵必須跟 points_earn_rate 脫鉤」):這一整段原本是
  -- 「三個 return」的結構——
  --      if v_earn_rate <= 0 then return; end if;        (步驟 4)
  --      if v_points <= 0 then return; end if;           (步驟 5)
  --      if not v_inserted then return; end if;          (步驟 6)
  -- 而步驟 7 的推薦獎勵在這三個 return 的**後面**,所以只要商家沒設定消費點數比例
  -- (points_earn_rate = 0)、或這筆金額太小算不到 1 點,推薦獎勵就**永遠不會發出去**。
  --
  -- 這在產品語意上講不通:referral_bonus_points 是一個**獨立的設定**,商家完全可能刻意
  -- 「不做消費累點、只做推薦獎勵」。用「消費幾元累積一點」的設定值去決定「推薦獎勵發不發」,
  -- 等於把兩個不相關的功能綁在一起。
  --
  -- 【這是一個既有 bug,而且我原本的改動讓它在某個情境下變得更糟(誠實記錄)】
  --   ・既有行為:points_earn_rate 一直是 0 → 推薦獎勵從來不會發(整條路徑走不到)。
  --   ・我把「第一筆消費」的判斷改成「第 1 筆已完成訂單」之後,多出一個更糟的情境:
  --     被推薦人的第一筆訂單完成時 earn_rate=0(沒發推薦獎勵),商家後來把 earn_rate 設成 100,
  --     第二筆訂單完成 → 已完成訂單數是 2,不是 1 → 推薦獎勵**永久失去**。
  --     舊邏輯在這個情境下反而發得出來(第二筆才是第 1 筆 earn_booking)。
  --   所以這一段不是順手擴大範圍,是修掉我自己的改動造成的退化 + 底下那個既有 bug。
  --
  -- 【改法】把「消費累點」收斂成一個**不會 return** 的區塊:條件不符就「跳過累點」而不是
  -- 「結束整支函式」,讓步驟 7 的推薦獎勵一定有機會被評估。
  --
  -- 【冪等性怎麼保住(原本那三個 return 之一負責這件事,不能就這樣拿掉)】
  -- 原本 `if not v_inserted then return` 的註解寫的是「避免用同一筆訂單重複觸發推薦邏輯」。
  -- 拿掉它之後,重複觸發的防線改由步驟 7 自己的 `v_referral_rewarded_at is null` 條件承擔
  -- ——而那本來就是真正的冪等標記(規則 2.4 第 5 點:只要資格成立就一定會寫 referral_rewarded_at,
  -- 不論獎勵點數是否 > 0)。逐一推演過三種重複呼叫的情況,結論都正確:
  --   (a) 前一次發過推薦獎勵 → referral_rewarded_at 已有值 → 步驟 7 直接跳過。✅
  --   (b) 前一次因為不是第一筆而沒發 → 這次算出來還是不是第一筆 → 跳過。✅
  --   (c) 前一次 earn_booking 已寫入(on conflict 命中)→ 情況同 (a)/(b)。✅
  -- =======================================================================
  if v_earn_rate > 0 then
    -- 金額太小算不到 1 點時,跳過累點(但不影響下面的推薦獎勵)。
    v_points := floor(coalesce(v_final_amount, 0) / v_earn_rate);

    if v_points > 0 then
      -- 寫入快照。on conflict do nothing 保護既有紀錄不被覆蓋(規則 2.2 核心規則)。
      select points_balance + v_points into v_new_balance from public.members where id = v_member_id;

      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after, booking_id
      ) values (
        v_member_id, v_merchant_id, 'earn_booking', v_points, v_new_balance, p_booking_id
      )
      on conflict (booking_id) where transaction_type = 'earn_booking' do nothing;

      v_inserted := found;

      -- 只有真的插入了才更新餘額(沒插入代表這筆訂單已經累過點,不能重複加)。
      if v_inserted then
        update public.members set points_balance = v_new_balance where id = v_member_id;
      end if;
    end if;
  end if;

  -- 7. 規則 2.4:推薦獎勵。被推薦人(v_member_id)還有推薦人、還沒因此拿過獎勵、且這是
  -- 這位被推薦人的「第一筆消費」。
  --
  -- ⚠️ 2026-09-24(主腦裁決):這一段現在是**無條件會被評估到**的(只要功能開著、被推薦人通過
  -- reward_condition_mode 的資格判斷),不再被上面消費累點那一段的 earn_rate / 點數大小決定。
  -- referral_bonus_points 是獨立設定,商家可以刻意「不做消費累點、只做推薦獎勵」。
  -- 詳細理由與冪等性推演見上方 4~6 區塊的註解。
  --
  -- (2026-09-24)v_points_feature_enabled 在這裡再判斷一次是刻意的「保險」:目前功能關閉時
  -- 步驟 2.5 就 return 了,根本走不到這裡;但推薦獎勵是一條獨立的「系統自動核發點數」路徑,
  -- 如果之後有人調整步驟順序,少了這一層就會默默漏掉。
  if coalesce(v_points_feature_enabled, true)
     and v_referred_by is not null and v_referral_rewarded_at is null then
    -- =====================================================================
    -- (2026-09-24 使用者裁決:「…關閉期間被推薦人完成了訂單,那次『第一筆消費』的資格要視為
    --  已用掉。」)
    --
    -- 原本的判斷是「這是這位被推薦人的第 1 筆 earn_booking 點數異動紀錄」。問題:紅利點數功能
    -- 關閉期間完全不寫 earn_booking(見步驟 2.5),所以那個「第一筆」的名額一直空著,商家重新
    -- 打開功能後被推薦人下一次消費就會補觸發推薦獎勵——正是使用者說不要的行為。
    --
    -- 改成數「這位被推薦人的已完成訂單」:已完成訂單這個事實不受紅利點數開關影響,關閉期間
    -- 完成的那一筆自然就把名額用掉了,所以**關閉期間完全不需要寫入任何標記**就達成「不補發」。
    -- 而且「第一筆消費」本來就該用消費來定義,用「第一筆點數異動」代表它原本就是實作上的偏差。
    --
    -- 為什麼是 = 1:complete_booking 先把這筆訂單 update 成 status='completed',才 perform
    -- 呼叫這支函式,所以這筆訂單自己已經被算進來了 → 1 代表「這是第一筆」。
    -- =====================================================================
    select count(*) into v_completed_booking_count
    from public.bookings
    where member_id = v_member_id and status = 'completed';

    if v_completed_booking_count = 1 then
      select referral_bonus_points into v_referral_bonus_points
      from public.merchant_member_settings
      where merchant_id = v_merchant_id;

      if v_referral_bonus_points is null then
        v_referral_bonus_points := 0;
      end if;

      if v_referral_bonus_points > 0 then
        -- 鎖定推薦人資料列(規則 2.3 精神:計算新餘額前先 for update,不論是否要檢查資格條件都
        -- 先鎖定,避免併發競態)。
        select phone_verified, line_bound, points_balance
        into v_referrer_phone_verified, v_referrer_line_bound, v_referrer_new_balance
        from public.members
        where id = v_referred_by
        for update;

        if private.member_meets_reward_condition(
          v_reward_condition_mode, v_referrer_phone_verified, v_referrer_line_bound
        ) then
          v_referrer_new_balance := v_referrer_new_balance + v_referral_bonus_points;

          insert into public.member_point_transactions (
            member_id, merchant_id, transaction_type, points_delta, balance_after,
            booking_id, related_member_id
          ) values (
            v_referred_by, v_merchant_id, 'referral_bonus', v_referral_bonus_points,
            v_referrer_new_balance, p_booking_id, v_member_id
          );

          update public.members set points_balance = v_referrer_new_balance where id = v_referred_by;
        end if;
      end if;

      -- 規則 2.4 第 5 點:不論獎勵點數是否 > 0(或推薦人是否通過資格條件),只要資格條件成立,
      -- 都要標記 referral_rewarded_at,避免之後調整設定值又重複觸發。
      update public.members set referral_rewarded_at = now() where id = v_member_id;
    end if;
  end if;
end;
$$;

comment on function public.compute_member_loyalty_points(uuid) is '模組 10 §3.7(核心,#619 疊加,2026-09-24 兩次疊加):某筆訂單完成當下,計算連結會員的消費紅利點數並寫入 member_point_transactions 快照(規則 2.1:含稅總額 final_amount_snapshot),同時檢查並視情況核發推薦獎勵(規則 2.4)。【2026-09-24 第一次疊加】使用者裁決「關閉後就不計算點數了」:points_feature_enabled 為 false 時在鎖定會員資料列之前就直接 return,消費累點與推薦獎勵兩條自動核發路徑都不執行。【2026-09-24 第二次疊加(本次)】使用者裁決「關閉期間被推薦人完成了訂單,那次第一筆消費的資格要視為已用掉」:推薦獎勵的「第一筆消費」判斷從「這是第 1 筆 earn_booking 點數異動」改成「這是這位被推薦人的第 1 筆已完成訂單」。原本的寫法在功能關閉期間不寫 earn_booking,名額一直空著,商家重新打開後會補觸發推薦獎勵;改成數已完成訂單之後,關閉期間完成的那一筆自然就把名額用掉,完全不需要在關閉期間寫入任何標記。【2026-09-24 第三次疊加(主腦裁決):推薦獎勵跟 points_earn_rate 脫鉤】原本步驟 4/5/6 有三個 return(earn_rate<=0、算不到 1 點、earn_booking 沒插入)都在推薦獎勵之前,所以商家只要沒設定消費點數比例,推薦獎勵就永遠不會發出去——這在產品語意上講不通,referral_bonus_points 是獨立設定,商家可以刻意「不做消費累點、只做推薦獎勵」。這既是既有 bug,也被「第一筆消費改成數已完成訂單」放大成更糟的情境(第一筆訂單完成時 earn_rate=0 沒發,商家之後把 earn_rate 設起來,第二筆訂單已完成數是 2 → 推薦獎勵永久失去)。改法:把消費累點收斂成一個不會 return 的區塊(條件不符就跳過累點而不是結束函式),讓推薦獎勵一定有機會被評估;原本靠 `if not v_inserted then return` 承擔的重複觸發防線,改由步驟 7 自己的 referral_rewarded_at is null 條件承擔(那本來就是真正的冪等標記)。手動調整(adjust_member_points)與兌換(redeem_member_points)刻意不受開關影響。on conflict (booking_id) where transaction_type=''earn_booking'' do nothing 保護既有紀錄不被覆寫(規則 2.2)。SECURITY DEFINER,不對外公開,只由 complete_booking() 內部用 perform 呼叫。';

revoke execute on function public.compute_member_loyalty_points(uuid) from public, anon, authenticated;

-- =========================================================================
-- §7 更新 points_feature_enabled 的欄位註解:上一支 migration 寫的「重新打開後補不補得回來」
--     那一整段已經被這次的使用者裁決推翻,必須改掉,不能留著誤導之後的人。
-- =========================================================================
comment on column public.merchant_member_settings.points_feature_enabled is
  '商家是否啟用紅利點數功能(.project/SPECS-INDEX.md #617,2026-09-24 兩次語意修正)。預設 true。
  【這個開關的效力】使用者裁決「關閉後就不計算點數了。」——它不是前端顯示開關,而是「後端會不會
  自動產生新的點數」的真正開關。關閉時會停止的自動核發路徑:compute_member_loyalty_points
  (訂單完成的消費累點 + 連帶的推薦獎勵 referral_bonus)、grant_pending_birthday_bonuses
  (生日贈點)。這兩條都是系統自動觸發、商家沒有逐筆確認機會的路徑,關閉後完全不寫
  member_point_transactions、不動 members.points_balance。
  【⚠️ 重新打開後一律「不補發」(2026-09-24 第二次裁決,推翻上一版的說明)】使用者裁決原文:
  「紅利點數都關閉了,自然就沒有這個點數派不派發與給不給的問題,因為這個機制關閉的時候代表
  根本不存在。」兩條路徑各自的落實方式:
   ・生日贈點:新增 public.merchant_points_feature_history 如實記錄這個開關的異動歷史,
     grant_pending_birthday_bonuses 逐位會員問 private.was_points_feature_enabled_on(該會員
     今年生日那一天)——那天功能關著就永久略過,不補發。判斷依據是歷史狀態,所以略過是冪等的,
     不需要寫入任何「已發放/已跳過」的假標記。也因此商家把開關關掉幾分鐘測試一下,**不會**
     吃掉當天生日會員的獎勵(判斷粒度是「那天有任何一刻開著就算開著」)。
   ・推薦獎勵:「第一筆消費」的判斷改成數「被推薦人的已完成訂單」,不再數 earn_booking 點數
     異動。已完成訂單不受這個開關影響,所以關閉期間完成的那一筆自然把名額用掉,重新打開後
     不會補觸發。同樣不需要在關閉期間寫入任何標記。
  【關閉時仍然可用的手動路徑】adjust_member_points(管理員手動調整)、redeem_member_points
  (登記兌換)、import_members_batch 的起始點數餘額。理由:關閉功能後既有點數餘額不會消失
  (#617 決定不清空資料),商家需要靠這些手動操作把既有餘額清算掉;把它們一起擋掉會讓商家
  無法收尾。這幾支都是商家主動點下去、且要填寫原因/用途的操作。
  【前端行為】關閉後隱藏建單表單與會員詳情頁的點數操作入口與數字;紅利點數管理頁刻意「不」
  隱藏——餘額總覽、手動調整、登記兌換在功能關閉時照常顯示(同上「要能清算既有餘額」的理由)。
  既有點數餘額與異動歷史資料不受影響。
  【權限】2026-09-24:這個欄位跟 reward_condition_mode/points_earn_rate/referral_bonus_points/
  birthday_bonus_points 一起被歸類為「紅利點數規則」,只有 private.can_manage_member_points
  (新的 member_points section_key)能改,見 20260924040400 的欄位層級保護觸發器。';
