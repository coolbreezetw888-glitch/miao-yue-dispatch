-- SPECS-INDEX #851:服務人員端唯一的訂單來源,在 hide_notes_from_staff = true 時不回傳備註文字。
-- 規格書:.project/specs/內部備註對服務人員隱藏.md(#851 / #858 / 第一節)
--
-- ═══ 為什麼一定要擋在這一層,而不是前端 if 掉不 render ══════════════════════════
-- 服務人員端是**手機瀏覽器直接打 Supabase**(publishable key),中間沒有我們自己的後端。
-- 只要 API 的回應 JSON 裡帶著那段備註文字,服務人員按 F12 → Network,就能原封不動看到它,
-- 畫面上有沒有畫出來完全不影響。所以「勾了就不給看」必須在這裡把文字拿掉。
--
-- ═══ 為什麼是這支函式,而不是加 RLS 政策 ═════════════════════════════════════
-- bookings 只有一條 SELECT 政策 bookings_select,條件是 private.can_manage_bookings(merchant_id)
-- (20260916140100_booking_functions.sql:558),而 can_manage_bookings 只認 merchant_admins /
-- merchant_agents,**不認 merchant_staff** ⇒ 服務人員一筆 bookings 都撈不到,RLS 那一層已經全關。
-- 真正的洩漏面只有這支 SECURITY DEFINER 函式(它刻意繞過 RLS 讓服務人員看到自己的班表),
-- 所以「這支函式回傳什麼」= 「服務人員能拿到什麼」,在這裡遮蔽就是在唯一的出入口遮蔽。
-- 📌 附帶好處:服務人員端的卡片列表與詳情彈窗讀的是**同一份**回傳資料
--    (MyCalendarPage.tsx 的 detailBooking 從同一個 schedule 陣列 .find() 出來),
--    所以在這裡遮一次,兩個畫面自動一致,不可能一邊有一邊沒有。
--
-- ═══ 這次相對於 20260921120000 的差異,只有三處 ═══════════════════════════════
--   1. union 第一段(primary)多帶一個 b.hide_notes_from_staff
--   2. union 第二段(assistant)同上 —— 主腦裁決 T4:協助人員**同待遇**,一起隱藏。
--      兩段都帶、外層用同一個 case 一次處理,是最不容易「只改到一段」的寫法。
--   3. 'notes' 那一項從 `bb.notes` 改成 case when 遮蔽。寫法刻意比照同一支函式裡既有的
--      show_member_info 先例(`case when … then … else null end`),風格一致。
-- 其餘每一行逐字沿用 20260921120000(已用 md5 比對正式庫 prosrc:可執行 SQL 逐字一致,
-- 差別只有中文註解被 MCP apply_migration 壓縮掉,見 supabase-permission-hygiene 規則 6)。

create or replace function public.get_my_booking_schedule(
  p_staff_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_merchant_id uuid;
  v_show_member_info boolean;
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_result jsonb;
begin
  -- 1. 規則 2.4(核心必測):必須是本人,且已開通 staff_calendar_view。
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員的行事曆' using errcode = '42501';
  end if;

  if not private.has_own_staff_permission(p_staff_id, 'staff_calendar_view') then
    raise exception '尚未開通行事曆檢視功能,請洽商家管理員' using errcode = '42501';
  end if;

  if p_end_date < p_start_date then
    raise exception '結束日期不能早於開始日期';
  end if;

  -- 2. 範圍上限(建議 62 天,避免一次查詢範圍過大拖垮效能)。
  if (p_end_date - p_start_date) > 62 then
    raise exception '查詢範圍不能超過 62 天,請分批查詢' using errcode = '22023';
  end if;

  select ms.merchant_id, ms.show_member_info
  into v_merchant_id, v_show_member_info
  from public.merchant_staff ms
  where ms.id = p_staff_id;

  v_range_start := (p_start_date::timestamp) at time zone 'Asia/Taipei';
  v_range_end := ((p_end_date + 1)::timestamp) at time zone 'Asia/Taipei';

  -- 3. 規則 2.5:涵蓋「主要服務人員」與「助手」兩種身份(比照 set_staff_day_override 既有的
  -- 既有預約衝突查詢邏輯,bookings 跟 booking_assistants 兩邊都查)。
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', bb.id,
      'start_at', bb.start_at,
      'end_at', bb.end_at,
      'status', bb.status,
      'role_in_booking', bb.role_in_booking,
      'customer_name', bb.customer_name,
      'customer_phone', bb.customer_phone,
      'customer_address', bb.customer_address,
      -- SPECS-INDEX #851:內部備註逐單隱藏(2026-09-30)。旗標為 true 時這裡就是 null,
      -- 回應 JSON 裡**沒有那段文字**,不是「有送出但前端不顯示」。
      -- 🔴 主腦裁決 T1=A:不額外回傳「本來有沒有備註」的布林 —— 那會洩漏「存在性」,
      --    也會讓服務人員端出現「這裡有秘密」的提示,跟這次要藏的初衷相反。
      -- 🔴 主腦裁決 T4:primary 與 assistant 同待遇,所以這裡不判斷 bb.role_in_booking。
      'notes', case when bb.hide_notes_from_staff then null else bb.notes end,
      'customer_notes', bb.customer_notes,
      'service_item_names', coalesce(si_agg.names, '[]'::jsonb),
      'final_amount_snapshot', bb.final_amount_snapshot,
      -- 規則 2.6:基本資訊一律回傳,只有 show_member_info=true 時才附上會員專屬欄位;
      -- 沒有連結會員(member_id is null)時這幾項一律是 null,跟關掉開關時的結果一致。
      'is_member', case when v_show_member_info then (bb.member_id is not null) else null end,
      'member_name', case
        when v_show_member_info and bb.member_id is not null then bb.member_name_snapshot
        else null
      end,
      'member_points_balance', case
        when v_show_member_info and bb.member_id is not null then m.points_balance
        else null
      end
    )
    order by bb.start_at
  ), '[]'::jsonb)
  into v_result
  from (
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      b.hide_notes_from_staff,
      'primary'::text as role_in_booking
    from public.bookings b
    where b.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
    union all
    select
      b.id, b.start_at, b.end_at, b.status, b.customer_name, b.customer_phone,
      b.customer_address, b.notes, b.customer_notes, b.final_amount_snapshot,
      b.member_id, b.member_name_snapshot,
      b.hide_notes_from_staff,
      'assistant'::text as role_in_booking
    from public.booking_assistants ba
    join public.bookings b on b.id = ba.booking_id
    where ba.staff_id = p_staff_id
      and b.status <> 'cancelled'
      and b.start_at < v_range_end
      and b.end_at > v_range_start
  ) bb
  left join public.members m on m.id = bb.member_id
  left join lateral (
    select jsonb_agg(si.name order by si.name) as names
    from public.booking_service_items bsi
    join public.service_items si on si.id = bsi.service_item_id
    where bsi.booking_id = bb.id
  ) si_agg on true;

  return v_result;
end;
$$;

comment on function public.get_my_booking_schedule(uuid, date, date) is '對應規格書 3.15/規則 2.4/2.5/2.6:服務人員自助查看自己排程用的唯讀彙整函式。SECURITY DEFINER,先檢查 is_own_staff_row + has_own_staff_permission(staff_calendar_view),回傳 [p_start_date, p_end_date] 這段期間內(Asia/Taipei 日曆日)自己以主要服務人員或助手身份參與、狀態不是 cancelled 的預約清單。查詢範圍上限 62 天。基本資訊原則上一律回傳,兩個例外:(1) 會員專屬欄位(is_member/member_name/member_points_balance)依 merchant_staff.show_member_info 決定,關閉時一律 null;(2) SPECS-INDEX #851(2026-09-30)內部備註 notes 在 bookings.hide_notes_from_staff = true 時一律回 null(primary 與 assistant 同待遇),客服勾了「不讓服務人員看到」的那一筆,備註文字完全不會出現在這支函式的回應裡。';

-- supabase-permission-hygiene 規則 1:create or replace 之後把 revoke/grant 整組重寫一次,
-- 不要依賴「上一支 migration 設過了」—— 雖然同簽章的 replace 會保留 ACL,明寫出來才不會在
-- 未來某次改簽章(drop + create)時默默繼承預設的 PUBLIC EXECUTE。
-- ⚠️ 這支函式**要**留給 authenticated(服務人員本人要能呼叫,內部已有 is_own_staff_row 檢查),
--    所以 revoke 清單刻意不含 authenticated,跟 20260921120000 完全一致。
revoke execute on function public.get_my_booking_schedule(uuid, date, date) from public, anon;
grant execute on function public.get_my_booking_schedule(uuid, date, date) to authenticated;
