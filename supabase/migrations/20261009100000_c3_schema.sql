-- 客戶端第 3 批(模組 13)— migration 1:欄位、check、計數表、服務人員順位、店家自訂完成頁文字
-- 規格書:.project/specs/客戶端第3批-送出預約與通知店家.md(「零之零」優先)
-- 介面文件:.project/notes/c3-contract.md
--
-- =========================================================================
-- 這支 migration 做的事
-- =========================================================================
--   C3-A01  booking_status_change_logs.actor_role_snapshot 加 'customer'
--           user_notifications.event_type 加 'customer_booking_created'
--           bookings.customer_submission_id(防重送)+ 同店唯一索引 + 「只有客人訂單能有」check
--   C3-G01  private.rate_limit_hits(unlogged 計數表)+ private.rate_limit_hit
--           + public.internal_rate_limit_hit(只給 service_role,Edge Function 用)+ 每小時清理排程
--   C3-H01  merchant_staff.display_order(順位)+ 回填 + 新增時自動排最後 + 只能用專用函式改
--   C3-H05  merchant_booking_settings.completion_message_member / completion_message_guest
--           + 去頭尾空白 / 空字串存 null + 200 字上限 + 加進「只有管理員能改」保護 trigger
--
-- 權限衛生(supabase-permission-hygiene 規則 1):新函式一律 revoke from public, anon, authenticated。
-- 函式本體內不寫註解(套正式庫後 md5(prosrc) 指紋比對才穩定),說明寫在函式上方。
-- 用語:一律「服務人員」;錯誤訊息全形標點。

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A01-1 操作紀錄角色加 'customer'(原本 4 個值逐字保留)
-- ═════════════════════════════════════════════════════════════════════════
alter table public.booking_status_change_logs
  drop constraint booking_status_change_logs_actor_role_snapshot_check;
alter table public.booking_status_change_logs
  add constraint booking_status_change_logs_actor_role_snapshot_check
  check (actor_role_snapshot = any (array['merchant_admin'::text, 'agent'::text, 'staff'::text, 'system'::text, 'customer'::text]));

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A01-2 鈴鐺事件加 'customer_booking_created'(原本 8 個值逐字保留)
-- ═════════════════════════════════════════════════════════════════════════
alter table public.user_notifications
  drop constraint user_notifications_event_type_check;
alter table public.user_notifications
  add constraint user_notifications_event_type_check
  check (event_type = any (array[
    'booking_created'::text, 'booking_cancelled'::text, 'booking_updated'::text, 'booking_reminder_next_day'::text,
    'booking_confirmed'::text, 'booking_completed_cancelled'::text, 'booking_completed_reverted'::text,
    'member_line_login_linked'::text, 'customer_booking_created'::text
  ]));

-- ═════════════════════════════════════════════════════════════════════════
-- C3-A01-3/4 防重送:客人每次進「確認送出」畫面產生一個 uuid,同店同 uuid 只會有一張單
-- ═════════════════════════════════════════════════════════════════════════
alter table public.bookings add column customer_submission_id uuid null;
create unique index bookings_merchant_customer_submission_uniq
  on public.bookings (merchant_id, customer_submission_id)
  where customer_submission_id is not null;
alter table public.bookings
  add constraint bookings_customer_submission_source_check
  check (customer_submission_id is null or source = 'customer');

-- ═════════════════════════════════════════════════════════════════════════
-- C3-G01 頻率限制計數表(unlogged:計數不需要寫交易紀錄;資料庫重啟會清空,可接受)
--   key_hash = SHA-256(key),不存 IP 原文。不建任何 RLS policy;anon / authenticated 沒有任何權限。
-- ═════════════════════════════════════════════════════════════════════════
create unlogged table private.rate_limit_hits (
  bucket text not null,
  key_hash text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, key_hash, window_start)
);
alter table private.rate_limit_hits enable row level security;
revoke all on table private.rate_limit_hits from public, anon, authenticated;
create index rate_limit_hits_window_start_idx on private.rate_limit_hits (window_start);

-- private.rate_limit_hit:固定時間窗計數。回傳 true = 這次還沒超過上限(已計入這次)。
--   時間窗起點 = now() 往下取整到 p_window 的倍數(例如 10 分鐘窗:10:00、10:10…)。
create or replace function private.rate_limit_hit(
  p_bucket text,
  p_key text,
  p_window interval,
  p_max integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_seconds double precision;
  v_window_start timestamptz;
  v_hits integer;
begin
  if p_bucket is null or p_key is null or p_window is null or p_max is null then
    return true;
  end if;
  v_seconds := extract(epoch from p_window);
  if v_seconds <= 0 then
    return true;
  end if;
  v_window_start := to_timestamp(floor(extract(epoch from now()) / v_seconds) * v_seconds);

  insert into private.rate_limit_hits as h (bucket, key_hash, window_start, hits)
  values (p_bucket, encode(sha256(convert_to(p_key, 'UTF8')), 'hex'), v_window_start, 1)
  on conflict (bucket, key_hash, window_start) do update set hits = h.hits + 1
  returning h.hits into v_hits;

  return v_hits <= p_max;
end;
$$;
revoke execute on function private.rate_limit_hit(text, text, interval, integer) from public, anon, authenticated;
grant execute on function private.rate_limit_hit(text, text, interval, integer) to service_role;

-- public.internal_rate_limit_hit:給 Edge Function(service role)用的包裝(C3-G03)。
--   p_window_seconds 1~86400、p_max 1~10000、bucket 1~64 字;超出範圍 ⇒ 22023。
create or replace function public.internal_rate_limit_hit(
  p_bucket text,
  p_key text,
  p_window_seconds integer,
  p_max integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_bucket is null or char_length(p_bucket) < 1 or char_length(p_bucket) > 64
     or p_key is null or char_length(p_key) > 512
     or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400
     or p_max is null or p_max < 1 or p_max > 10000 then
    raise exception '頻率限制參數不正確' using errcode = '22023', hint = 'invalid_rate_limit';
  end if;
  return private.rate_limit_hit(p_bucket, p_key, make_interval(secs => p_window_seconds), p_max);
end;
$$;
revoke execute on function public.internal_rate_limit_hit(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.internal_rate_limit_hit(text, text, integer, integer) to service_role;

-- 清理:刪 1 天前的計數(最長的時間窗是 24 小時)。
create or replace function private.prune_rate_limit_hits()
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from private.rate_limit_hits where window_start < now() - interval '1 day';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke execute on function private.prune_rate_limit_hits() from public, anon, authenticated, service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'rate-limit-hits-prune-hourly';
select cron.schedule(
  'rate-limit-hits-prune-hourly',
  '23 * * * *',
  $$ select private.prune_rate_limit_hits(); $$
);

-- ═════════════════════════════════════════════════════════════════════════
-- C3-H01 服務人員順位 merchant_staff.display_order
--   回填:每間店依 created_at, id 由 1 開始(含已移除的人,保持現在畫面順序)。
--   回填時暫停這張表的使用者 trigger:否則 set_updated_at 會把 400 多位服務人員的 updated_at 全部改掉、
--   即時同步 trigger 也會對每間店發訊號。只動 display_order 一欄,其他欄位不變。
-- ═════════════════════════════════════════════════════════════════════════
alter table public.merchant_staff add column display_order integer;

alter table public.merchant_staff disable trigger user;
update public.merchant_staff s
   set display_order = r.rn
  from (
    select id, row_number() over (partition by merchant_id order by created_at, id)::integer as rn
    from public.merchant_staff
  ) r
 where r.id = s.id;
alter table public.merchant_staff enable trigger user;

alter table public.merchant_staff alter column display_order set not null;
create index merchant_staff_merchant_display_order_idx
  on public.merchant_staff (merchant_id, display_order, created_at, id);

-- 新增:自動排在該店最後(max + 1)。
--   ・登入者(authenticated / anon,含透過 SECURITY DEFINER 函式代為新增)一律由系統決定,帶了也不採用;
--   ・系統 / service_role / 測試(沒有登入身分)帶了值就照用,沒帶就 max + 1;
--   ・同店新增排隊(advisory lock,跟 move_merchant_staff_order 同一把),避免同時新增兩位拿到同一個號碼。
create or replace function private.tg_merchant_staff_display_order_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.display_order is null
     or coalesce(auth.role(), '') in ('authenticated', 'anon') then
    perform pg_advisory_xact_lock(hashtextextended('staff_display_order:' || new.merchant_id::text, 0));
    select coalesce(max(ms.display_order), 0) + 1 into new.display_order
    from public.merchant_staff ms
    where ms.merchant_id = new.merchant_id;
  end if;
  return new;
end;
$$;
revoke execute on function private.tg_merchant_staff_display_order_insert() from public, anon, authenticated;

create trigger merchant_staff_display_order_insert
  before insert on public.merchant_staff
  for each row execute function private.tg_merchant_staff_display_order_insert();

-- 修改:merchant_staff_update 政策讓管理員 / 有服務人員管理權限的客服能直接 PATCH 整列,
--   ⇒ 登入者直接改 display_order 一律擋下,只能透過 public.move_merchant_staff_order(會打開交易內旗標)。
--   service_role、系統(沒有登入身分)不擋。
create or replace function private.protect_merchant_staff_display_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.display_order is distinct from old.display_order
     and coalesce(auth.role(), '') in ('authenticated', 'anon')
     and coalesce(current_setting('staff_agent.bypass_display_order_guard', true), 'off') <> 'on' then
    raise exception '服務人員的順位只能用清單上的上下箭頭調整。' using errcode = '42501', hint = 'display_order_protected';
  end if;
  return new;
end;
$$;
revoke execute on function private.protect_merchant_staff_display_order() from public, anon, authenticated;

create trigger merchant_staff_protect_display_order
  before update on public.merchant_staff
  for each row execute function private.protect_merchant_staff_display_order();

-- ═════════════════════════════════════════════════════════════════════════
-- C3-H05 店家自訂完成頁文字(會員 / 訪客分開)
-- ═════════════════════════════════════════════════════════════════════════
alter table public.merchant_booking_settings
  add column completion_message_member text null,
  add column completion_message_guest text null;
alter table public.merchant_booking_settings
  add constraint merchant_booking_settings_completion_message_member_check
  check (completion_message_member is null or char_length(completion_message_member) between 1 and 200);
alter table public.merchant_booking_settings
  add constraint merchant_booking_settings_completion_message_guest_check
  check (completion_message_guest is null or char_length(completion_message_guest) between 1 and 200);

-- 去頭尾空白(含換行、全形空白);空字串存 null。trigger 名稱字母序排在保護 trigger 前面,
-- 保護 trigger 看到的是整理過的值(只有空白差異的修改不算「修改」)。
create or replace function private.normalize_merchant_booking_completion_messages()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.completion_message_member := nullif(regexp_replace(coalesce(new.completion_message_member, ''), '^[\s　]+|[\s　]+$', '', 'g'), '');
  new.completion_message_guest := nullif(regexp_replace(coalesce(new.completion_message_guest, ''), '^[\s　]+|[\s　]+$', '', 'g'), '');
  return new;
end;
$$;
revoke execute on function private.normalize_merchant_booking_completion_messages() from public, anon, authenticated;

create trigger merchant_booking_settings_normalize_completion_messages
  before insert or update on public.merchant_booking_settings
  for each row execute function private.normalize_merchant_booking_completion_messages();

-- 既有保護 trigger:只有管理員能改線上預約欄位。這次只多兩欄完成頁文字(其他逐字保留)。
create or replace function private.protect_merchant_booking_settings_online_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
       (tg_op = 'INSERT' and (new.min_lead_hours is distinct from 2
                              or new.travel_buffer_minutes is distinct from 0
                              or new.allow_guest_booking is distinct from true
                              or new.completion_message_member is not null
                              or new.completion_message_guest is not null))
    or (tg_op = 'UPDATE' and (new.min_lead_hours is distinct from old.min_lead_hours
                              or new.travel_buffer_minutes is distinct from old.travel_buffer_minutes
                              or new.allow_guest_booking is distinct from old.allow_guest_booking
                              or new.completion_message_member is distinct from old.completion_message_member
                              or new.completion_message_guest is distinct from old.completion_message_guest))
     )
     and auth.role() <> 'service_role'
     and not private.is_merchant_admin(new.merchant_id)
  then
    raise exception '只有商家管理員可以修改線上預約設定' using errcode = '42501';
  end if;
  return new;
end;
$$;
