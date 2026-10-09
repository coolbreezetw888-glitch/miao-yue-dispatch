-- SPECS-INDEX #1049 / #1050(2026-10-10):行事曆格子顯示一致化 + 排程狀態顏色透明度 —— 資料表。
-- 規格書:.project/specs/行事曆格子顯示與顏色透明度.md(R9)。
--
-- 這支 migration 只動 merchant_calendar_state_styles(#644 / #1021 那張表),不碰任何 RLS 政策:
--   1. 加 opacity 欄位(10~100,預設 100 = 跟改版前一模一樣)。
--   2. state_type CHECK 加第 5 種 outside_business_hours(營業時間外的格子,深色)。
--   3. 既有商家每間補一列 outside_business_hours(on conflict do nothing,不覆蓋);
--      補完核對「列數 = 商家數 × 5」,不符就 raise(整支 migration 回滾)。
--
-- 預設色 #334155(tailwind slate-700):
--   ・跟白色(營業時間內、每週時段外)、淡綠 #dcfce7(可預約)、暖灰斜線(休假 / 排休)、赭橘網格(外店佔用)
--     色相與明度都分得開;深色底上的時間文字改用淺色(#f8fafc),對比約 10:1。
--   ・訂單卡片是整張實色 + 白字 + 調亮的左色條,疊在深色格子上邊界清楚(已取消的 #606d7f 也比 #334155 亮一階)。

-- 1. opacity
alter table public.merchant_calendar_state_styles
  add column opacity smallint not null default 100;

alter table public.merchant_calendar_state_styles
  add constraint merchant_calendar_state_styles_opacity_check
  check (opacity between 10 and 100);

comment on column public.merchant_calendar_state_styles.opacity is 'SPECS-INDEX #1050:這個狀態顏色的透明度(百分比,10~100,預設 100)。前端乘在既有 alpha 上(圖樣狀態底色 0.12、線條 0.55;純色狀態 = opacity/100),文字不跟著變淡。';

-- 2. state_type 第 5 種
alter table public.merchant_calendar_state_styles
  drop constraint merchant_calendar_state_styles_state_type_check;

alter table public.merchant_calendar_state_styles
  add constraint merchant_calendar_state_styles_state_type_check
  check (state_type in ('full_day_leave', 'partial_leave', 'cross_store_occupied', 'staff_available_slot', 'outside_business_hours'));

comment on column public.merchant_calendar_state_styles.state_type is '五種枚舉值之一:full_day_leave(全天休假)/partial_leave(時段排休,單日例外關閉)/cross_store_occupied(跨店佔用)/staff_available_slot(#1021:每週可預約時段內、可預約的空格子)/outside_business_hours(#1049:營業時間外的格子,純色無圖樣)。';

-- 3. 既有商家補第 5 列 + 核對
insert into public.merchant_calendar_state_styles (merchant_id, state_type, color)
select m.id, 'outside_business_hours', '#334155'
from public.merchants m
on conflict (merchant_id, state_type) do nothing;

do $$
declare
  v_merchants bigint;
  v_rows bigint;
begin
  select count(*) into v_merchants from public.merchants;
  select count(*) into v_rows
  from public.merchant_calendar_state_styles s
  join public.merchants m on m.id = s.merchant_id;
  if v_rows <> v_merchants * 5 then
    raise exception 'req1049 補列核對失敗:merchant_calendar_state_styles 有 % 列,應為商家數 % × 5 = %',
      v_rows, v_merchants, v_merchants * 5;
  end if;
end;
$$;
