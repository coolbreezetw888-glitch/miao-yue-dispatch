-- SPECS-INDEX #1021(第 21 批,B3):行事曆「服務人員每週可預約時段」空格子加底色。
--
-- 使用者原話:「目前服務人員的每週可預約時間是白底顯示,我希望顯眼一點(可以加個底色,讓客服可以更清楚的
-- 辨識這個是不是服務人員自己開啟的可預約時間)。」
--
-- 做法:放進既有的「行事曆排程狀態顏色設定」(merchant_calendar_state_styles,#644,原本三種)當第 4 種
-- state_type = 'staff_available_slot',商家可以自訂;預設色 #dcfce7(淡綠)。
--
-- 這支 migration 做的事(只動 #644 這張表與它的兩支函式,不碰任何 RLS 政策):
--   1. state_type CHECK 加第 4 個值。
--   2. seed_default_merchant_calendar_state_styles 多種一列(新商家建立時自動有)。
--   3. 既有商家一次補一列預設值(on conflict do nothing,不覆蓋)。
--   4. update_merchant_calendar_state_styles 多一個參數 p_staff_available_slot_color(預設 null = 這一色不改),
--      舊版前端只傳 4 個參數照樣能呼叫(上線順序不用卡)。新色碼一律檢查格式 #RGB / #RRGGBB。
--   ※ get_my_calendar_state_styles(服務人員端讀取)本來就回傳這間商家「所有列」⇒ 第 4 種自動帶出,
--     函式本體一字不改(也就不會動到 req987 釘的指紋)。商家端是直接讀表(RLS can_manage_bookings),也不用改。

-- =========================================================================
-- 1. state_type 加第 4 個值
-- =========================================================================
alter table public.merchant_calendar_state_styles
  drop constraint merchant_calendar_state_styles_state_type_check;

alter table public.merchant_calendar_state_styles
  add constraint merchant_calendar_state_styles_state_type_check
  check (state_type in ('full_day_leave', 'partial_leave', 'cross_store_occupied', 'staff_available_slot'));

comment on column public.merchant_calendar_state_styles.state_type is '四種枚舉值之一:full_day_leave(全天休假,對應 staff_leave_records 整天請假)/partial_leave(時段排休,對應 staff_availability_overrides 單日例外關閉)/cross_store_occupied(服務人員在其他店有訂單造成的行程衝突)/staff_available_slot(#1021:服務人員每週可預約時段內、可預約的空格子底色,純色無圖樣)。';

-- =========================================================================
-- 2. seed:新商家自動種 4 列
-- =========================================================================
create or replace function public.seed_default_merchant_calendar_state_styles(p_merchant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
  values
    (p_merchant_id, 'full_day_leave', '#78716c'),
    (p_merchant_id, 'partial_leave', '#a8a29e'),
    (p_merchant_id, 'cross_store_occupied', '#c2410c'),
    (p_merchant_id, 'staff_available_slot', '#dcfce7')
  on conflict (merchant_id, state_type) do nothing;
end;
$$;

comment on function public.seed_default_merchant_calendar_state_styles(uuid) is 'SPECS-INDEX #644 / #1021:新商家建立時種入 4 種行事曆排程狀態的預設顏色(第 4 種 staff_available_slot = #dcfce7 淡綠)。冪等,重複呼叫不會產生第二批,也不會覆蓋商家已經自訂過的顏色。';

revoke execute on function public.seed_default_merchant_calendar_state_styles(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_merchant_calendar_state_styles(uuid) to service_role, postgres;

-- =========================================================================
-- 3. 既有商家補第 4 列(只補缺的,不覆蓋)
-- =========================================================================
insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
select m.id, 'staff_available_slot', '#dcfce7'
from public.merchants m
on conflict (merchant_id, state_type) do nothing;

-- =========================================================================
-- 4. update_merchant_calendar_state_styles:多一個參數(有預設值)
--    舊簽章(4 個參數)先刪掉,否則 PostgREST 用 4 個具名參數呼叫時會有兩支同時符合。
-- =========================================================================
drop function public.update_merchant_calendar_state_styles(uuid, text, text, text);

create function public.update_merchant_calendar_state_styles(
  p_merchant_id uuid,
  p_full_day_leave_color text,
  p_partial_leave_color text,
  p_cross_store_occupied_color text,
  p_staff_available_slot_color text default null
)
returns setof public.merchant_calendar_state_styles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff_available_slot_color text := btrim(p_staff_available_slot_color);
begin
  if not private.can_manage_bookings(p_merchant_id) then
    raise exception '沒有權限修改這間商家的行事曆排程狀態顏色設定' using errcode = '42501';
  end if;

  if p_full_day_leave_color is null or btrim(p_full_day_leave_color) = '' then
    raise exception '請設定「全天休假」的顏色';
  end if;
  if p_partial_leave_color is null or btrim(p_partial_leave_color) = '' then
    raise exception '請設定「時段排休」的顏色';
  end if;
  if p_cross_store_occupied_color is null or btrim(p_cross_store_occupied_color) = '' then
    raise exception '請設定「跨店佔用」的顏色';
  end if;
  -- #1021:新的這一色只收 #RGB / #RRGGBB(前端套 inline style 前還會再檢查一次)。null = 不改。
  if v_staff_available_slot_color is not null
     and v_staff_available_slot_color !~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$' then
    raise exception '「服務人員可預約時段」的色碼格式不正確，請輸入像 #DCFCE7 這樣的色碼';
  end if;

  insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
  values
    (p_merchant_id, 'full_day_leave', btrim(p_full_day_leave_color)),
    (p_merchant_id, 'partial_leave', btrim(p_partial_leave_color)),
    (p_merchant_id, 'cross_store_occupied', btrim(p_cross_store_occupied_color))
  on conflict (merchant_id, state_type) do update set
    color = excluded.color,
    updated_at = now();

  if v_staff_available_slot_color is not null then
    insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
    values (p_merchant_id, 'staff_available_slot', v_staff_available_slot_color)
    on conflict (merchant_id, state_type) do update set
      color = excluded.color,
      updated_at = now();
  end if;

  return query
    select * from public.merchant_calendar_state_styles
    where merchant_id = p_merchant_id
    order by state_type;
end;
$$;

comment on function public.update_merchant_calendar_state_styles(uuid, text, text, text, text) is 'SPECS-INDEX #644 / #1021:upsert 商家的 merchant_calendar_state_styles(全天休假/時段排休/跨店佔用/服務人員可預約時段)。權限比照 merchant_booking_status_colors:private.can_manage_bookings(商家管理員或被授權 orders 的客服)。前三色只擋空字串/null(#644 原規則);第 4 色 p_staff_available_slot_color 預設 null = 不改,有給就只收 #RGB / #RRGGBB。';

revoke execute on function public.update_merchant_calendar_state_styles(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_merchant_calendar_state_styles(uuid, text, text, text, text) to authenticated;
