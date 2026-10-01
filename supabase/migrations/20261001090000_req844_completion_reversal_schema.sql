-- #844 已完成訂單可取消/還原 —— 批次 1:稽核表 + RLS + 操作紀錄加原因
-- 規格:.project/specs/已完成訂單取消與還原.md v1.2 §2.1、§2.2、§4.6、§九 批次 1、§十 第 1 段
--
-- 這支 migration 只建「地基」,沒有任何路徑會寫入新表、也沒有任何路徑會呼叫新的五參數
-- log_booking_status_change —— 兩者都留給批次 2 的反轉引擎(20261001090100)。
-- 疊在紅利重構 8 批(20261001020000 ~ 20261001080000)之上;本檔不碰紅利任何物件。
--
-- 動工前正式庫(wjtbmmnakcriuaqoknsq)唯讀指紋(2026-10-01,prosrc 先把 CRLF 正規化成 LF):
--   private.log_booking_status_change(uuid,uuid,text,text)  md5 0442db1836c0796a20e01b1791997a62 / 415 字元
--   public.get_booking_status_change_logs(uuid)              md5 917e40cc2a2ae74b7e980da8fd1ac93e / 554 字元
--   (正式庫存的是去掉註解後的主體;本機 20260922160100 原文逐行比對去掉註解後邏輯一致)
--   ⇒ 四參數 log_booking_status_change 本檔一行不動;get_booking_status_change_logs 以
--     20260922160100 的主體為底,只多回一欄 note。

-- =========================================================================
-- 1. 稽核表 booking_completion_reversals(§2.1,append-only)
-- =========================================================================
create table public.booking_completion_reversals (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  -- 冗餘存一份,方便 RLS/索引直接用(比照 booking_status_change_logs.merchant_id)。
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  action text not null
    check (action in ('revert_to_accepted', 'cancel_completed')),
  reason text not null
    check (btrim(reason) <> ''),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name_snapshot text not null,
  original_completed_at timestamptz not null,
  report_month text not null,
  is_cross_month boolean not null,
  commission_record_snapshot jsonb,
  commission_amount_reversed numeric(10,2) not null default 0,
  points_due integer not null default 0,
  points_recovered integer not null default 0,
  points_shortfall integer not null default 0,
  referral_due integer not null default 0,
  referral_recovered integer not null default 0,
  referral_shortfall integer not null default 0,
  referrer_member_id uuid,
  shortfall_hint text,
  frozen_points_refunded integer not null default 0,
  notified boolean not null default false,
  -- 同一交易內可能連續兩筆(比照 #623 / log_booking_status_change 的教訓用 clock_timestamp())。
  created_at timestamptz not null default clock_timestamp()
);

comment on table public.booking_completion_reversals is '#844 已完成訂單取消/還原的稽核紀錄,append-only:每做一次「還原完成」(revert_to_accepted)或「取消已完成訂單」(cancel_completed)寫一筆,把被刪掉的抽成快照原文(含明細)、紅利收回三數 ×2、折抵退回點數、原因、操作者留下來。這是「上個月報表為什麼變少」唯一的證據來源。RLS:只有 SELECT 政策且限商家管理員(private.is_merchant_admin)——含抽成金額(薪資資料)與 shortfall_hint(含推薦人目前餘額),只有訂單鑰匙的客服看不到。anon/authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE 表權限已收回,直接寫表一律 42501;只由反轉引擎(SECURITY DEFINER,批次 2)寫入。';
comment on column public.booking_completion_reversals.action is 'revert_to_accepted = 還原完成(completed → accepted);cancel_completed = 取消已完成訂單(completed → cancelled)。';
comment on column public.booking_completion_reversals.reason is '必填原因(去頭尾空白後不可為空)。同一段文字也寫進 booking_status_change_logs.note。';
comment on column public.booking_completion_reversals.actor_name_snapshot is '操作者姓名快照,沿用 private.current_actor_display_name。';
comment on column public.booking_completion_reversals.original_completed_at is '反轉前的 bookings.completed_at(反轉時 bookings.completed_at 會被清回 null,§3.10)。用來回答「影響哪個月的報表」。';
comment on column public.booking_completion_reversals.report_month is 'to_char(original_completed_at at time zone ''Asia/Taipei'', ''YYYY-MM''),日後「期後調整」報表直接篩這欄。';
comment on column public.booking_completion_reversals.is_cross_month is '執行當下(台北時區)完成月份是否早於本月。';
comment on column public.booking_completion_reversals.commission_record_snapshot is '被刪除的 booking_commission_records 整列 + items(booking_commission_item_records 明細整列陣列);月薪制/無抽成時為 null。';
comment on column public.booking_completion_reversals.points_due is '紅利收回函式 private.reverse_booking_earned_points 回傳的 points_due(本人應收回)。以下 points_* / referral_* / referrer_member_id / shortfall_hint 欄位名一律對齊該函式回傳鍵。';
comment on column public.booking_completion_reversals.shortfall_hint is '紅利收回函式回傳的差額提示原文(只在有差額時有值;可能含推薦人目前餘額 ⇒ 本表只給管理員看)。';
comment on column public.booking_completion_reversals.frozen_points_refunded is '取消路徑 private.refund_booking_redeem 的回傳值(退回的折抵凍結點數);還原路徑固定 0。';
comment on column public.booking_completion_reversals.notified is '取消路徑管理員有沒有打開「同時發送取消通知」開關(cancel_completed_booking 的 p_notify_requested)。只記錄管理員的選擇,不代表送達;還原路徑固定 false。';

create index booking_completion_reversals_booking_id_created_at_idx
  on public.booking_completion_reversals (booking_id, created_at);
create index booking_completion_reversals_merchant_id_report_month_idx
  on public.booking_completion_reversals (merchant_id, report_month);

alter table public.booking_completion_reversals enable row level security;

-- 只有 SELECT 政策,而且是管理員專屬(不是 can_manage_bookings),理由見表註解。
create policy booking_completion_reversals_select on public.booking_completion_reversals
  for select to authenticated
  using (private.is_merchant_admin(merchant_id));

-- 沒有寫入政策時 UPDATE / DELETE 是「靜默 0 列」不報錯 ⇒ 比照紅利批次 7 對 merchant_point_formulas
-- 的做法,把表層級寫入權限一起收回,直接寫表一律 42501(pgTAP module17_01 第 1 段驗)。
-- 反轉引擎是 SECURITY DEFINER(owner 身分)、service_role 不受影響。
revoke insert, update, delete, truncate on public.booking_completion_reversals from anon, authenticated;

-- =========================================================================
-- 2. private.log_booking_status_change 五參數 overload(§2.2 第 1 點)
-- =========================================================================
-- 🔴 與規格書字面的一處差異:規格寫「多一個 p_note text default null」。但若五參數版的 p_note 有
-- default,既有四參數呼叫 log_booking_status_change(a, b, c, d) 會同時匹配「四參數版」與「五參數版
-- 省略 p_note」兩個候選 ⇒ Postgres 拋 42725「function ... is not unique」,create_booking /
-- confirm_booking / cancel_booking / complete_booking 全部壞掉。所以這裡的 p_note **不給 default**:
-- 四參數呼叫只會匹配舊版(行為完全不變),只有明確傳第五個參數才會走這支。
create function private.log_booking_status_change(
  p_booking_id uuid,
  p_merchant_id uuid,
  p_from_status text,
  p_to_status text,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 與四參數版逐字相同,只多寫 note。空白原因存 null(反轉引擎本身已擋空白原因,這裡只是保險,
  -- 避免畫面出現一行空的「原因:」)。created_at 用 clock_timestamp() 的理由同四參數版(#623)。
  insert into public.booking_status_change_logs (
    booking_id, merchant_id, from_status, to_status,
    actor_user_id, actor_name_snapshot, actor_role_snapshot, note, created_at
  ) values (
    p_booking_id, p_merchant_id, p_from_status, p_to_status,
    auth.uid(),
    private.current_actor_display_name(p_merchant_id),
    private.current_actor_role_snapshot(p_merchant_id),
    nullif(btrim(p_note), ''),
    clock_timestamp()
  );
end;
$$;

comment on function private.log_booking_status_change(uuid, uuid, text, text, text) is '#844 §2.2:log_booking_status_change 的五參數版,多寫 note(還原/取消已完成訂單的原因)。p_note 刻意不給 default(給了會讓既有四參數呼叫變成 42725 not unique)。只由 SECURITY DEFINER 函式內部 perform 呼叫,revoke 所有角色的 execute。';

revoke execute on function private.log_booking_status_change(uuid, uuid, text, text, text) from public, anon, authenticated;

-- 表上 note 欄位的註解改成現況(建表時寫「先不開放使用者輸入」)。
comment on column public.booking_status_change_logs.note is '操作備註。#844 起「還原完成」「取消已完成訂單」會把管理員填的原因寫在這裡(只寫原因,不寫點數/餘額——客服也看得到這欄);其他狀態轉換為 null。';

-- =========================================================================
-- 3. get_booking_status_change_logs 多回 note(§2.2 第 2 點)
-- =========================================================================
-- returns table 的欄位變了,不能 create or replace ⇒ drop 再 create,並補回權限
-- (supabase-permission-hygiene:drop 會清掉 grant)。主體以 20260922160100 為底,只多選 l.note。
drop function public.get_booking_status_change_logs(uuid);

create function public.get_booking_status_change_logs(p_booking_id uuid)
returns table (
  id uuid,
  from_status text,
  to_status text,
  actor_name_snapshot text,
  actor_role_snapshot text,
  created_at timestamptz,
  note text
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
begin
  -- RETURNS TABLE 的 id 會變成同名區域變數,這裡用 b.id 消除歧義(沿用原版註解,module6_08 涵蓋)。
  select b.merchant_id into v_merchant_id from public.bookings b where b.id = p_booking_id;

  if not found then
    raise exception '找不到這筆預約';
  end if;

  if not private.can_manage_bookings(v_merchant_id) then
    raise exception '沒有權限查詢這筆預約的操作記錄' using errcode = '42501';
  end if;

  return query
  select l.id, l.from_status, l.to_status, l.actor_name_snapshot, l.actor_role_snapshot, l.created_at, l.note
  from public.booking_status_change_logs l
  where l.booking_id = p_booking_id
  order by l.created_at desc;
end;
$$;

comment on function public.get_booking_status_change_logs(uuid) is '模組 6 §9.1(SPECS-INDEX #597):回傳某筆訂單的操作記錄,依時間新到舊排序。權限檢查跟檢視訂單本身一致(private.can_manage_bookings,即 orders section_key),管理員永遠可以,被授權 orders 的客服也可以。#844 §2.2 起多回 note(還原/取消已完成訂單的原因;只有原因,不含點數/餘額)。';

revoke execute on function public.get_booking_status_change_logs(uuid) from public, anon;
grant execute on function public.get_booking_status_change_logs(uuid) to authenticated, service_role;
