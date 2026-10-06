-- SPECS-INDEX #977 第 3 批(2026-10-06):「服務人員是否顯示會員資料」(merchant_staff.show_member_info)關閉時,
-- 服務人員端預約詳情只看得到客戶姓名,電話、地址都看不到(使用者裁決 H-13:這個開關本來的定義就是藏客戶聯絡資料;
-- 改前關閉仍看得到 ⇒ bug)。規格書「權限收緊與服務人員開關修正-第3批」第四節。
--
-- 服務人員看得到客戶資料的出口盤點(詳見回報):
--   ・public.get_my_booking_schedule —— 行事曆列表 / 時間軸 / 預約詳情都讀這支,**唯一**回傳電話與地址的出口 ⇒ 本檔修改。
--   ・即時同步訊號 payload 只有 {id, reason, v},不帶任何客戶資料 —— 不用改。
--   ・推播 / 站內鈴鐺 / LINE 通知的文案變數(render_booking_notification_variables)沒有電話、地址變數 —— 不用改。
--   ・其他服務人員可呼叫的函式(get_my_day_schedule_state、get_my_day_business_hours、抽成 / 薪資報表等)
--     不回傳電話、地址;bookings / members 表層政策服務人員讀不到。
--
-- 以 20260930010100_req851_get_my_booking_schedule_hide_notes.sql 的定義為底,只改 customer_phone / customer_address 兩行。
-- 簽章不變(create or replace,ACL 原樣保留);下面仍把 revoke / grant 整組明寫一次,ACL 跟改前完全相同。
-- ⚠️ 本檔沒有任何資料寫入。

CREATE OR REPLACE FUNCTION public.get_my_booking_schedule(p_staff_id uuid, p_start_date date, p_end_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      -- SPECS-INDEX #977(2026-10-06,第 3 批,使用者裁決 H-13):「服務人員是否顯示會員資料」關閉時,
      -- 服務人員只看得到客戶姓名 ⇒ 電話、地址**在這裡就不回傳**(null),不是送出去再讓前端不顯示。
      -- 開啟時照舊。這支是服務人員端唯一會回傳客戶電話 / 地址的出口(盤點表見回報)。
      'customer_phone', case when v_show_member_info then bb.customer_phone else null end,
      'customer_address', case when v_show_member_info then bb.customer_address else null end,
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
$function$;

revoke execute on function public.get_my_booking_schedule(uuid, date, date) from public, anon;
grant execute on function public.get_my_booking_schedule(uuid, date, date) to authenticated;
grant execute on function public.get_my_booking_schedule(uuid, date, date) to service_role;
