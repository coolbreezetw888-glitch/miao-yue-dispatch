-- SPECS-INDEX #860:服務人員端行事曆的預約色塊,要跟商家端一樣套用商家自訂的訂單狀態顏色。
--
-- ═══ 根因(已用唯讀 SELECT 對正式專案 wjtbmmnakcriuaqoknsq 實查確認)═══════════════
-- src/modules/staff-portal/MyCalendarTimelineView.tsx:170 用的是 bookingBlockClasses(status)
-- ——寫死的 Tailwind class;商家端 CalendarPage.tsx:2448 用的是
-- bookingBlockStyle(effectiveStatusColors, status)——讀 merchant_booking_status_colors。
-- 當初服務人員端刻意寫死,是因為那張表只有一條 SELECT 政策:
--
--   merchant_booking_status_colors_select : for select to authenticated
--     using (private.can_manage_bookings(merchant_id))
--
-- 而 can_manage_bookings 只認 merchant_admins / merchant_agents,**不認 merchant_staff**。
-- 2026-09-30 以「涼風工匠」的純服務人員 T2(staff 1d8624f0…、user 5aa8d0d0…、
-- status=active/login_status=active、既不是管理員也不是客服)實際模擬 authenticated 身份查:
--
--   select count(*) from public.merchant_booking_status_colors;   → 0 筆
--   select count(*) from public.merchant_calendar_state_styles;    → 0 筆
--   private.can_manage_bookings('e0d44004-…')                      → false
--
-- ⇒ 服務人員讀那張表一定是 0 筆,前端永遠 fallback 成預設色,所以兩端顏色不一致。
--
-- ═══ 🔴 為什麼用 SECURITY DEFINER 函式,不是新增一條 SELECT 政策 ═══════════════════
-- **同一個問題在姊妹表上已經解決過了,而且解法是函式,不是放寬政策。**
-- merchant_calendar_state_styles(排休/衝突底色)的 SELECT 政策條件**一字不差地一樣**,
-- 2026-09-23 的 20260923020100_req644_… 選擇新增 public.get_my_calendar_state_styles(p_staff_id)
-- ——SECURITY DEFINER + 只檢查 private.is_own_staff_row——而**完全沒有動那條政策**。
-- 上面那次實查也確認它現在就在正常運作(T2 呼叫得到涼風工匠自訂的三個色碼)。
--
-- 所以這支 migration 刻意做成「一模一樣的第二支函式」,理由三點:
--   1. **一致性**:兩張平行的顏色設定表,在服務人員端不應該一張走函式、一張走表層政策。
--      supabase-permission-hygiene 結尾就寫著「這次的漏洞全部都出在『沒有跟著既有慣例走』的
--      地方」——同專案裡較新的做法是對的,就跟著它。
--   2. **權限面更小**:表層 SELECT 政策給的是**整列**(PostgREST 預設 select=*),而且**未來
--      這張表新增的任何欄位都會自動變成服務人員讀得到**。函式只回傳挑好的 4 個色碼。
--      這正是 supabase-permission-hygiene 規則 2 末段「放寬 SELECT policy 之前先想清楚:
--      你想給的是『這幾個欄位』還是『整列』?」要避免的形狀。
--   3. **不動既有政策、不動寫入面**:本檔完全沒有 create/alter/drop policy,
--      merchant_booking_status_colors 的 INSERT/UPDATE/DELETE 依舊「完全沒有政策」
--      (寫入只能走 update_merchant_booking_status_colors),這次一個字都沒碰。
--
-- 📌 已在回報中向主腦明講:主腦的派工原文要求「新增一條 SELECT 政策」。我改用函式,是因為
--    派工當下還不知道姊妹表已經有這個先例(派工單同時問我「merchant_calendar_state_styles
--    有沒有同樣問題」)。功能結果完全相同(服務人員端看到商家自訂的四個色碼、跨商家讀不到),
--    如果主腦仍要表層政策,說一聲即可改——那會是另一支 migration,本檔不需要撤銷。
--
-- ═══ 跨商家讀不到:為什麼結構上就不可能 ═════════════════════════════════════════
-- 函式唯一的輸入是 p_staff_id,第一行就 private.is_own_staff_row(p_staff_id)
-- (它的定義是 merchant_staff.id = p_staff_id and user_id = auth.uid()
--   and status='active' and login_status='active',= 派工說的「自己是這間商家在職服務人員」)。
-- 傳別人的 staff_id → 直接 42501;傳自己的 → merchant_id 由
-- private.staff_merchant_id(p_staff_id) 在函式內部查出來,**呼叫端無法指定 merchant_id**,
-- 所以「讀到別家商家的顏色」沒有任何輸入可以構造出來。pgTAP 另外正/反各釘一條。
--
-- 本檔沒有任何 UPDATE / DELETE / INSERT,不動一筆資料。

create or replace function public.get_my_booking_status_colors(p_staff_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
  v_merchant_id uuid;
  v_result jsonb;
begin
  if not private.is_own_staff_row(p_staff_id) then
    raise exception '沒有權限查詢這位服務人員所屬商家的訂單狀態顏色設定' using errcode = '42501';
  end if;

  v_merchant_id := private.staff_merchant_id(p_staff_id);
  if v_merchant_id is null then
    raise exception '找不到這位服務人員,或這位服務人員已被移除';
  end if;

  -- 只挑 4 個色碼,不回傳整列(不給 merchant_id / created_at / updated_at,也不會因為這張表
  -- 日後多欄位就自動多給)。查無資料時回 '{}'::jsonb,由前端 fallback 成
  -- DEFAULT_BOOKING_STATUS_COLORS —— 跟 get_my_calendar_state_styles 完全相同的慣例。
  select jsonb_build_object(
           'pending_confirmation_color', c.pending_confirmation_color,
           'accepted_color', c.accepted_color,
           'completed_color', c.completed_color,
           'cancelled_color', c.cancelled_color
         )
    into v_result
  from public.merchant_booking_status_colors c
  where c.merchant_id = v_merchant_id;

  return coalesce(v_result, '{}'::jsonb);
end;
$function$;

comment on function public.get_my_booking_status_colors(uuid) is 'SPECS-INDEX #860(2026-09-30):服務人員自助查詢自己所屬商家的「訂單狀態顏色設定」(待確認/已確認/已完成/已取消四個色碼),讓服務人員端行事曆的預約色塊跟商家端 CalendarPage 完全一致。只檢查 private.is_own_staff_row(傳別人的 staff_id 一律 42501),merchant_id 由 private.staff_merchant_id 在函式內部解出來,呼叫端無法指定 ⇒ 結構上不可能讀到別家商家的顏色。回傳 {欄位名: 色碼} 的 jsonb,查無資料時回 {},由前端 fallback 成 DEFAULT_BOOKING_STATUS_COLORS。做法刻意逐字比照姊妹表的既有先例 public.get_my_calendar_state_styles(20260923020100),而不是放寬 merchant_booking_status_colors_select 這條表層政策——表層政策給的是整列、且未來新增欄位會自動外流,這裡只給挑好的 4 個色碼。本 migration 完全沒有新增/修改/刪除任何 RLS 政策。';

-- supabase-permission-hygiene 規則 1:新建函式會自動繼承 PUBLIC EXECUTE,一定要明寫收回。
-- 這支要留給 authenticated(服務人員本人呼叫,內部已有 is_own_staff_row 檢查),
-- 所以 revoke 清單刻意不含 authenticated ——寫法逐字比照 get_my_calendar_state_styles。
revoke all on function public.get_my_booking_status_colors(uuid) from public, anon;
grant execute on function public.get_my_booking_status_colors(uuid) to authenticated;
