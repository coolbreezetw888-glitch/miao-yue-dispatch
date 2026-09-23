-- 建單與訂單管理介面優化(SPECS-INDEX #644):行事曆排程狀態顏色設定——資料表與權限。
--
-- 跟既有 merchant_booking_status_colors(#620/#621,對應「訂單狀態」:待確認/已確認/已完成/
-- 已取消)是完全獨立的新功能,不是同一件事的擴充:這次對應的是「行事曆本身的排程狀態」
-- (不是訂單狀態)——全天休假/時段排休/跨店佔用衝突,三種狀態各自可自訂底色。
--
-- 資料表形狀刻意選擇「一商家一狀態一列」(merchant_id + state_type 複合主鍵),不是比照
-- merchant_booking_status_colors「一商家一列、四個顏色各自一欄」的做法——主腦裁示:這次要讓
-- 模組 13(客戶端,目前還沒開發)未來上線時可以直接查詢同一張表沿用,用「一狀態一列」的通用
-- 枚舉形狀比「寫死四個欄位」更適合日後任何新呼叫端直接查詢用,不需要為了新增/理解欄位語意
-- 而重新讀一次商家設定頁的程式碼。
--
-- 預設色碼選色理由(避免跟 merchant_booking_status_colors 既有 4 色撞色造成混淆,已查證該表
-- 目前 4 個預設值:pending_confirmation=#ebaa2d 黃橘、accepted=#1c6fd2 藍、completed=#1ea25d 綠、
-- cancelled=#606d7f 冷灰藍):這次 3 個預設值改用「暖灰」色系(stone,而不是撞色的 slate 冷灰藍)
-- 代表「休假/排休」語意上的中性、非警示;跨店佔用改用「深橘/赭」(distinctly 比 warn 的
-- #ebaa2d 更深、更偏紅棕,不會被誤認成待確認訂單的黃橘色),代表「這是別的原因造成的占用,
-- 不是休假,也不是待處理的訂單」。三色彼此之間也刻意選在不同色相(暖灰 vs 赭橘),搭配這次
-- 固定的圖樣(斜線/斜線/交叉網格)雙重區分,不是只靠顏色本身分辨。
create table public.merchant_calendar_state_styles (
  merchant_id uuid not null references public.merchants(id) on delete cascade,
  state_type text not null check (state_type in ('full_day_leave', 'partial_leave', 'cross_store_occupied')),
  color text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (merchant_id, state_type)
);

comment on table public.merchant_calendar_state_styles is 'SPECS-INDEX #644:商家層級「行事曆排程狀態」底色設定,一商家最多三列(state_type 各一列)。跟 merchant_booking_status_colors(訂單狀態顏色)是平行但完全獨立的功能,不共用同一張表。查無資料時前端/後端一律套用下面 seed 函式種入的預設值。state_type 三種:full_day_leave(全天休假)/partial_leave(時段排休)/cross_store_occupied(服務人員在其他店有訂單造成的行程衝突)。故意用「一狀態一列」而不是「一商家一列、三欄」的形狀,方便模組 13(客戶端,目前尚未開發)未來直接查詢同一張表沿用,不需要重新設計。';
comment on column public.merchant_calendar_state_styles.state_type is '三種枚舉值之一:full_day_leave(全天休假,對應 staff_leave_records 整天請假)/partial_leave(時段排休,對應 staff_availability_overrides 單日例外關閉)/cross_store_occupied(服務人員在其他店有訂單造成的行程衝突)。';
comment on column public.merchant_calendar_state_styles.color is '底色色碼。比照 merchant_booking_status_colors 的既有規則,不做嚴格 hex CHECK 約束,允許商家輸入任意合法 CSS color 字串。實際渲染時前端固定疊加對應圖樣(斜線/交叉網格),不是純色塊。';

create trigger merchant_calendar_state_styles_set_updated_at
  before update on public.merchant_calendar_state_styles
  for each row execute function public.set_updated_at();

alter table public.merchant_calendar_state_styles enable row level security;

-- SELECT 開放給商家管理員/被授權 orders 客服(跟 merchant_booking_status_colors 完全一致的
-- can_manage_bookings 判斷)——這是商家設定頁(admin-only 頁面)讀取用的政策。服務人員自己的
-- 行事曆(MyCalendarTimelineView)不透過這個政策讀取(一般服務人員不符合 can_manage_bookings),
-- 改用下一支 migration 新增的 get_my_calendar_state_styles(SECURITY DEFINER 自助函式,只檢查
-- is_own_staff_row),比照 get_my_day_business_hours 的既有做法,不放寬這張表本身的 RLS。
create policy merchant_calendar_state_styles_select on public.merchant_calendar_state_styles
  for select to authenticated
  using (private.can_manage_bookings(merchant_id));

-- 沒有 INSERT/UPDATE/DELETE 政策——寫入只透過下一支 migration 的 SECURITY DEFINER 函式
-- (seed_default_merchant_calendar_state_styles / update_merchant_calendar_state_styles),
-- 比照 merchant_booking_status_colors 的既有做法全部收斂到函式,不開放任何角色直接對這張表下
-- INSERT/UPDATE/DELETE。
