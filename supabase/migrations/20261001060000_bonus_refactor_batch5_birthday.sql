-- 紅利系統重構 批次 5:生日獎勵排程(#841)
-- 對應規格書 .project/specs/紅利系統重構.md §1.7、§2.9、§3.6、§3.7、§3.8、§3.12。
--
-- 內容:
--   ① private.birthday_anchor_date          —— 某年的生日錨定日(2/29 在平年 → 2/28)
--   ② public.run_birthday_bonus_grants       —— 排程 A:台北 00:05 發點數(純 SQL,不依賴外部服務)
--   ③ public.claim_birthday_line_pending     —— 排程 B 用:認領「待發送」的生日 LINE(service_role 專用)
--   ④ public.mark_birthday_line_result       —— 排程 B 用:回寫發送結果(service_role 專用)
--   ⑤ public.get_birthday_bonus_grants       —— 生日分頁的紀錄清單(members 或 member_points 任一放行)
--   ⑥ drop public.grant_pending_birthday_bonuses(uuid) —— 舊的「打開會員列表頁被動補發」整支廢止
--   ⑧ member_birthday_bonus_grants.line_status 多兩種略過原因(v2.4 第 19 條 ②③)
--   ⑦ pg_cron 兩個排程:birthday-bonus-grant-daily(UTC 16:05)、birthday-line-dispatch-daily(UTC 01:10)
--
-- 🔴 安全原則(§1.7 第 3 點,比照 20260922100200_push_notifications_cron.sql):
--   Vault 密鑰 birthday_line_cron_secret 的「值」**完全不出現在這份檔案**。排程 B 只在執行當下用
--   (select decrypted_secret from vault.decrypted_secrets where name = 'birthday_line_cron_secret')
--   讀取。正式庫上線時由主腦在 SQL Editor 一次性 vault.create_secret(...),並把同一個值設成
--   Edge Function 的環境變數 BIRTHDAY_LINE_CRON_SECRET。密鑰還沒建之前,排程 B 送出的標頭是空的,
--   Edge Function 會回 401、什麼都不做(安全的失敗方向);排程 A 發點數完全不受影響。
--
-- 正式庫唯讀查證(2026-10-01,ref wjtbmmnakcriuaqoknsq):
--   grant_pending_birthday_bonuses(uuid) 指紋 ba0ea7693bbe3f61c9a1b6f1a1cb72d7 / 3281 字元(CRLF→LF 後),
--   與規格書 §〇.1b 一致 ⇒ 本支直接 drop,沒有其他版本。
--   was_points_feature_enabled_on 指紋 c0309981c628fe5141f45f2a415f2c07 / 1455(不動,只呼叫)。
--   cron.job 目前 2 個(push-notify-reminder-daily、user-notifications-prune-daily);Vault 1 把。

-- =========================================================================
-- ① 生日錨定日(§2.9 第 5 點)
-- =========================================================================
create or replace function private.birthday_anchor_date(p_birthday date, p_year integer)
returns date
language sql
immutable
set search_path = public
as $$
  select make_date(
    p_year,
    extract(month from p_birthday)::int,
    least(
      extract(day from p_birthday)::int,
      extract(day from (make_date(p_year, extract(month from p_birthday)::int, 1)
                        + interval '1 month - 1 day'))::int
    )
  );
$$;

comment on function private.birthday_anchor_date(date, integer) is '紅利系統重構 §2.9 第 5 點:某會員在某一年的生日錨定日。月份照生日,日期夾在該年該月的最後一天以內 ⇒ 2/29 生日在平年落在 2/28、閏年落在 2/29。只給生日排程內部使用。';

revoke execute on function private.birthday_anchor_date(date, integer) from public, anon, authenticated;

-- =========================================================================
-- ② 排程 A:run_birthday_bonus_grants(§3.6 / §2.9)
-- =========================================================================
create or replace function public.run_birthday_bonus_grants(p_run_date date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date;
  v_count integer := 0;
  v_c record;
  v_balance integer;
  v_tx_id uuid;
  v_grant_id uuid;
begin
  -- §2.9 第 6 點:兩個排程實例重疊時,後到的直接 return 0,不互相等待。
  -- 真正的「每人每年一次」保證是 member_birthday_bonus_grants 的 (member_id, bonus_year) 唯一索引。
  if not pg_try_advisory_xact_lock(hashtext('birthday_bonus_grant')) then
    return 0;
  end if;

  -- 🔴 一律用台北日期。資料庫時區是 UTC,台北 00:05 時 UTC 還是前一天 16:05。
  v_today := coalesce(p_run_date, (now() at time zone 'Asia/Taipei')::date);

  for v_c in
    select
      m.id as member_id,
      m.merchant_id,
      m.name as member_name,
      m.phone_verified,
      m.line_bound,
      s.birthday_bonus_points as points,
      s.reward_condition_mode,
      y.yr as bonus_year,
      private.birthday_anchor_date(m.birthday, y.yr) as anchor_date
    from public.merchant_member_settings s
    join public.merchants mer on mer.id = s.merchant_id
    join public.members m on m.merchant_id = s.merchant_id
    -- 補發窗口 [今天 − 6, 今天] 可能跨年(例:12/31 生日、1/2 才跑到)。候選年份取「今天的年」與
    -- 「今天 − 6 天的年」,錨定日落在窗口內的那一年就是這筆的 bonus_year。平常兩者相同,只有
    -- 1/1~1/6 會多一個候選年。每位會員每個 bonus_year 最多一筆,不會因此一年發兩次。
    cross join lateral (
      select distinct yr
      from unnest(array[extract(year from v_today)::int, extract(year from v_today - 6)::int]) as yr
    ) y
    where mer.status = 'active'   -- v2.4 第 19 條 ③:被平台停用(關店)的商家不發
      and s.points_feature_enabled = true
      and s.birthday_bonus_enabled = true
      and s.birthday_bonus_points > 0
      and m.status = 'active'
      and m.birthday is not null
      and private.birthday_anchor_date(m.birthday, y.yr) between v_today - 6 and v_today
      and not exists (
        select 1 from public.member_birthday_bonus_grants g
        where g.member_id = m.id and g.bonus_year = y.yr
      )
    order by m.merchant_id, m.id, y.yr
  loop
    -- 「關閉期間不補發」(2026-09-24 使用者裁決,沿用):錨定日那天紅利功能是關著的 ⇒ 永久不發,
    -- 不寫任何紀錄(判斷依據是歷史狀態,天生冪等)。
    if not private.was_points_feature_enabled_on(v_c.merchant_id, v_c.anchor_date) then
      continue;
    end if;

    -- 核發資格(§2.7:生日贈點在觸發當下評估)。不符 ⇒ 跳過且不留紀錄(窗口內之後符合了仍會補發)。
    -- 🔴 第 16 題:黑名單照樣發,這裡刻意不看 is_blacklisted。
    if not private.member_meets_reward_condition(
      v_c.reward_condition_mode, v_c.phone_verified, v_c.line_bound
    ) then
      continue;
    end if;

    -- 每位會員各自一個子交易(begin … exception):撞到唯一索引 ⇒ 靜默略過;其他任何錯誤(例:餘額加上去
    -- 超過 integer 上限)⇒ 只回滾這一位,發 WARNING(含 member_id 與錯誤訊息,留在資料庫 log),
    -- 繼續處理下一位,不讓一位會員的資料問題擋掉其他人與別家店(v2.4 第 19 條 ①)。
    begin
      -- §3.6:逐會員 for update skip locked。鎖不到(別的交易正在改這位會員的點數)⇒ 今天先略過,
      -- 補發窗口內下一次排程會再處理。同時再確認一次 status(查詢到鎖定之間可能被下架)。
      select points_balance into v_balance
      from public.members
      where id = v_c.member_id and status = 'active'
      for update skip locked;

      if not found then
        continue;
      end if;

      insert into public.member_point_transactions (
        member_id, merchant_id, transaction_type, points_delta, balance_after, note
      ) values (
        v_c.member_id, v_c.merchant_id, 'birthday_bonus', v_c.points, v_balance + v_c.points,
        format('%s 年生日贈點(生日 %s)', v_c.bonus_year, to_char(v_c.anchor_date, 'MM/DD'))
      )
      returning id into v_tx_id;

      update public.members
      set points_balance = v_balance + v_c.points,
          -- §1.3:舊欄位只做相容寫入(判斷依據已改成 member_birthday_bonus_grants)。
          last_birthday_bonus_year = greatest(coalesce(last_birthday_bonus_year, v_c.bonus_year), v_c.bonus_year)
      where id = v_c.member_id;

      -- §2.9 第 6 點:唯一索引是唯一的真相。沒插進去(今年已經有一筆)⇒ 丟出 unique_violation,
      -- 讓上面的分類帳與餘額一起回滾,等於「沒插入就不加點」。
      insert into public.member_birthday_bonus_grants (
        merchant_id, member_id, bonus_year, anchor_date, points,
        point_transaction_id, member_name_snapshot, line_status
      ) values (
        v_c.merchant_id, v_c.member_id, v_c.bonus_year, v_c.anchor_date, v_c.points,
        v_tx_id, v_c.member_name, 'pending'
      )
      on conflict do nothing
      returning id into v_grant_id;

      if v_grant_id is null then
        raise exception 'birthday bonus already granted for this member and year'
          using errcode = 'unique_violation';
      end if;

      v_count := v_count + 1;
    exception
      when unique_violation then
        null;  -- 今年已經發過:這位會員的子交易已回滾,不加點、不留第二筆。
      when others then
        raise warning 'run_birthday_bonus_grants: skipped member %: %', v_c.member_id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$$;

comment on function public.run_birthday_bonus_grants(date) is '紅利系統重構 §3.6/§2.9(#841)排程 A:每天台北 00:05 由 pg_cron(birthday-bonus-grant-daily)執行,對所有商家發生日贈點。資格:商家 merchants.status = active(停用的店不發)且 points_feature_enabled 且 birthday_bonus_enabled 且 birthday_bonus_points > 0;會員 active、有生日、通過 reward_condition_mode(觸發當下評估)、今年錨定日落在 [台北今天−6, 台北今天](7 天補發窗口,跨年時看錨定日所在年份)、錨定日當天紅利功能是開著的(was_points_feature_enabled_on)、且 member_birthday_bonus_grants 沒有 (member_id, 該年) 這一列。符合 ⇒ 同一子交易內寫分類帳 birthday_bonus、加餘額、寫發送紀錄(line_status=pending)、相容寫入 last_birthday_bonus_year。不看 LINE 綁定(未綁定仍給點)、不看黑名單(第 16 題照樣發)。冪等:唯一索引 + 沒插入就回滾;單一會員發生其他錯誤只回滾他自己並發 WARNING,其餘照發;advisory lock 拿不到直接回 0。p_run_date 只供測試指定台北日期。回傳實際發放人數。只有 postgres(排程)與 service_role 能執行。';

revoke execute on function public.run_birthday_bonus_grants(date) from public, anon, authenticated;
grant execute on function public.run_birthday_bonus_grants(date) to service_role;

-- =========================================================================
-- ⑧ line_status 多兩種略過原因(v2.4 第 19 條 ②③)。表是批次 1 建的、尚未上線;生日分頁(批次 6)
--    要多兩個中文標籤:skipped_member_removed「會員已下架略過」、skipped_merchant_disabled「商家已停用略過」。
-- =========================================================================
alter table public.member_birthday_bonus_grants
  drop constraint member_birthday_bonus_grants_line_status_check;
alter table public.member_birthday_bonus_grants
  add constraint member_birthday_bonus_grants_line_status_check
    check (line_status in ('pending', 'sent', 'failed', 'skipped_not_bound', 'skipped_not_connected',
                           'skipped_member_removed', 'skipped_merchant_disabled'));

-- =========================================================================
-- ③ 排程 B 用:claim_birthday_line_pending(§3.7 第 2 步)
-- =========================================================================
create or replace function public.claim_birthday_line_pending(p_limit integer default 100)
returns setof jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_r record;
begin
  -- (a) 認領後超過 30 分鐘還沒回報結果 ⇒ Edge Function 中途中斷。LINE 可能已經送出也可能沒有,
  --     §3.7 第 4 點「不自動重試(避免對同一個人重複發)」⇒ 直接標 failed 讓商家看得到原因。
  update public.member_birthday_bonus_grants
  set line_status = 'failed',
      line_error = '發送過程中斷,系統沒有收到發送結果;為避免重複發送,不會自動重試'
  where line_status = 'pending'
    and line_attempted_at is not null
    and line_attempted_at < now() - interval '30 minutes';

  -- (b) 發點數後超過 7 天都沒發出 LINE(例如 LINE 發送排程當時尚未啟用)⇒ 不再補發過期的生日祝福。
  update public.member_birthday_bonus_grants
  set line_status = 'failed',
      line_error = '超過 7 天仍未發送(當時 LINE 發送排程可能尚未啟用),為避免過期的生日祝福,不再補發',
      line_attempted_at = now()
  where line_status = 'pending'
    and line_attempted_at is null
    and granted_at < now() - interval '7 days';

  for v_r in
    select
      g.id as grant_id,
      g.merchant_id,
      g.member_id,
      g.points,
      coalesce(m.name, g.member_name_snapshot) as member_name,
      m.line_bound,
      m.line_user_id,
      m.status as member_status,
      mer.status as merchant_status,
      c.is_connected,
      c.channel_access_token,
      s.birthday_line_message,
      mer.name as merchant_name
    from public.member_birthday_bonus_grants g
    join public.members m on m.id = g.member_id
    join public.merchants mer on mer.id = g.merchant_id
    left join public.merchant_line_configs c on c.merchant_id = g.merchant_id
    left join public.merchant_member_settings s on s.merchant_id = g.merchant_id
    where g.line_status = 'pending'
      and g.line_attempted_at is null
    order by g.granted_at, g.id
    limit v_limit
    for update of g skip locked
  loop
    -- v2.4 第 19 條 ③:商家已被平台停用(關店)⇒ 不發 LINE。
    if v_r.merchant_status <> 'active' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_merchant_disabled',
          line_error = '商家已停用,不發送生日 LINE 訊息',
          line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    -- v2.4 第 19 條 ②:發點之後會員被下架 ⇒ 不發 LINE(點數已經發了,不收回)。
    if v_r.member_status <> 'active' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_member_removed',
          line_error = '會員已下架,不發送生日 LINE 訊息(生日點數已照常發放)',
          line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    if not coalesce(v_r.line_bound, false) or coalesce(btrim(v_r.line_user_id), '') = '' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_not_bound', line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    if not coalesce(v_r.is_connected, false) or coalesce(btrim(v_r.channel_access_token), '') = '' then
      update public.member_birthday_bonus_grants
      set line_status = 'skipped_not_connected', line_attempted_at = now()
      where id = v_r.grant_id;
      continue;
    end if;

    -- 認領:寫 line_attempted_at,狀態仍是 pending,結果由 mark_birthday_line_result 回寫。
    -- 已認領的列不會再被下一次呼叫撈到(條件是 line_attempted_at is null)。
    update public.member_birthday_bonus_grants
    set line_attempted_at = now()
    where id = v_r.grant_id;

    return next jsonb_build_object(
      'grant_id', v_r.grant_id,
      'merchant_id', v_r.merchant_id,
      'member_id', v_r.member_id,
      'line_user_id', v_r.line_user_id,
      'channel_access_token', v_r.channel_access_token,
      'message_template', coalesce(v_r.birthday_line_message, ''),
      'member_name', coalesce(v_r.member_name, ''),
      'points', v_r.points,
      'merchant_name', coalesce(v_r.merchant_name, '')
    );
  end loop;

  return;
end;
$$;

comment on function public.claim_birthday_line_pending(integer) is '紅利系統重構 §3.7(#841)排程 B 專用(service_role):認領 line_status=pending 且尚未認領的生日發送紀錄(最多 p_limit 筆,夾在 1~500)。商家已停用 ⇒ skipped_merchant_disabled;會員已下架 ⇒ skipped_member_removed(v2.4 第 19 條 ②③)。會員未綁 LINE ⇒ 直接標 skipped_not_bound;商家 LINE 未連線 ⇒ 標 skipped_not_connected;兩者都不回傳。真的要發的列寫入 line_attempted_at(認領)後回傳 jsonb(grant_id/merchant_id/member_id/line_user_id/channel_access_token/message_template/member_name/points/merchant_name)。另外兩條保護:認領超過 30 分鐘沒回報 ⇒ failed(不自動重試,避免重複發);發點後超過 7 天沒發出 ⇒ failed(不發過期祝福)。🔴 回傳內容含 LINE channel access token,只能給 service_role。';

revoke execute on function public.claim_birthday_line_pending(integer) from public, anon, authenticated;
grant execute on function public.claim_birthday_line_pending(integer) to service_role;

-- =========================================================================
-- ④ 排程 B 用:mark_birthday_line_result(§3.7 第 3 步)
-- =========================================================================
create or replace function public.mark_birthday_line_result(
  p_grant_id uuid,
  p_status text,
  p_error text default null,
  p_log_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception '生日 LINE 發送結果只能是 sent 或 failed' using errcode = '22023';
  end if;

  select merchant_id into v_merchant_id
  from public.member_birthday_bonus_grants
  where id = p_grant_id;

  if not found then
    return false;
  end if;

  -- 發送紀錄必須是同一間商家的生日事件,避免把別家的紀錄掛上來。
  if p_log_id is not null and not exists (
    select 1 from public.line_notification_log l
    where l.id = p_log_id and l.merchant_id = v_merchant_id and l.event_type = 'birthday_bonus'
  ) then
    raise exception '發送紀錄不屬於這筆生日贈點' using errcode = '22023';
  end if;

  -- 只回寫還在 pending 的列:已經有結果的不覆蓋(重複呼叫冪等)。
  update public.member_birthday_bonus_grants
  set line_status = p_status,
      line_error = case when p_status = 'failed' then left(coalesce(p_error, '發送失敗'), 1000) else null end,
      line_notification_log_id = p_log_id,
      line_attempted_at = coalesce(line_attempted_at, now())
  where id = p_grant_id
    and line_status = 'pending';

  return found;
end;
$$;

comment on function public.mark_birthday_line_result(uuid, text, text, uuid) is '紅利系統重構 §3.7(#841)排程 B 專用(service_role):回寫一筆生日發送紀錄的 LINE 結果(sent/failed),可掛上 line_notification_log 的 id(必須是同商家、event_type=birthday_bonus)。只更新仍是 pending 的列,重複呼叫回 false、不覆蓋既有結果。失敗訊息截到 1000 字。';

revoke execute on function public.mark_birthday_line_result(uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.mark_birthday_line_result(uuid, text, text, uuid) to service_role;

-- =========================================================================
-- ⑤ 生日分頁的紀錄清單:get_birthday_bonus_grants(§3.8,第 10 題)
-- =========================================================================
create or replace function public.get_birthday_bonus_grants(p_merchant_id uuid)
returns table (
  id uuid,
  member_id uuid,
  member_name text,
  points integer,
  bonus_year integer,
  anchor_date date,
  line_status text,
  line_error text,
  granted_at timestamptz,
  line_attempted_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (private.can_manage_members(p_merchant_id) or private.can_manage_member_points(p_merchant_id)) then
    raise exception '沒有權限查看這間商家的生日紅利紀錄' using errcode = '42501';
  end if;

  return query
  select g.id, g.member_id, g.member_name_snapshot, g.points, g.bonus_year, g.anchor_date,
         g.line_status, g.line_error, g.granted_at, g.line_attempted_at
  from public.member_birthday_bonus_grants g
  where g.merchant_id = p_merchant_id
  order by g.granted_at desc, g.id desc
  limit 50;
end;
$$;

comment on function public.get_birthday_bonus_grants(uuid) is '紅利系統重構 §3.8(#841):生日分頁的「生日點數發送紀錄」,最近 50 筆(granted_at desc)。權限:members 或 member_points 任一放行(第 10 題定案),其餘 42501。會員姓名用發送當下的快照。';

revoke execute on function public.get_birthday_bonus_grants(uuid) from public, anon;
grant execute on function public.get_birthday_bonus_grants(uuid) to authenticated, service_role;

-- =========================================================================
-- ⑥ §3.12 廢止舊的被動補發(打開會員列表頁時觸發、以「當月」容錯)
-- 前端 MembersListPage.tsx 的呼叫與提示條、api.ts 的 grantPendingBirthdayBonuses 在同一批移除。
-- =========================================================================
drop function if exists public.grant_pending_birthday_bonuses(uuid);

-- =========================================================================
-- ⑦ §1.7 pg_cron 兩個排程(第 11 題定案時間)。cron.schedule 對同名排程是覆蓋語意,重複套用安全。
-- pg_cron / pg_net 已由 20260922100200_push_notifications_cron.sql 啟用,這裡不重複建 extension。
-- =========================================================================

-- 排程 A:UTC 16:05 = 台北 00:05。純 SQL,不依賴任何外部服務或密鑰。
select
  cron.schedule(
    'birthday-bonus-grant-daily',
    '5 16 * * *',
    $$ select public.run_birthday_bonus_grants(); $$
  );

-- 排程 B:UTC 01:10 = 台北 09:10(刻意跟 01:00 的服務人員推播提醒錯開 10 分鐘)。
-- 網址比照 push-notify-reminder-daily 的既有寫法(正式專案網址);密鑰只在執行當下從 Vault 讀。
select
  cron.schedule(
    'birthday-line-dispatch-daily',
    '10 1 * * *',
    $$
    select
      net.http_post(
        url := 'https://wjtbmmnakcriuaqoknsq.supabase.co/functions/v1/birthday-line-dispatch',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'birthday_line_cron_secret')
        ),
        body := '{}'::jsonb
      ) as request_id;
    $$
  );
