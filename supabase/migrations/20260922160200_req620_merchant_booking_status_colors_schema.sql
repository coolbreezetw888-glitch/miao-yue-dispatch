-- 建單與訂單管理介面優化 §十 10.1-10.4(SPECS-INDEX #620):訂單狀態顏色自訂——資料表與權限。
--
-- ⚠️ 動工前的必要查證(規格書 10.1 明文要求):四個 DEFAULT 值不能憑空估算,必須實際量測
-- CalendarPage.tsx/OrdersPage.tsx 目前寫死的顏色。已讀取 src/modules/booking/types.ts 的
-- bookingBlockClasses/bookingCardAccentBorderClass(§7.5 已經把這兩支「狀態 -> 樣式」的純函式
-- 統一放在這支檔案),確認兩處的色塊/色條共用同一組 Tailwind 設計 token(cta/warn/brand/
-- muted-foreground),而不是各自寫死不同色碼——這代表目前系統實際上只有「一組」狀態代表色,
-- 不是行事曆跟訂單頁分別維護兩組不同的顏色(這點也呼應規格書「兩處要改成讀同一張顏色設定表」
-- 的方向本來就是對的)。這四個 token 的實際色碼定義在 src/styles.css 的 :root 區塊(oklch 格式,
-- 這個專案的既有規則是「顏色一律用 oklch 格式定義」):
--   --warn:  oklch(0.78 0.15 78)   → pending_confirmation(待確認)
--   --brand: oklch(0.55 0.17 256)  → accepted(已確認,border-l-brand)
--   --cta:   oklch(0.63 0.15 154)  → completed(已完成)
--   --muted-foreground: oklch(0.53 0.032 257) → cancelled(已取消,OrdersPage.tsx §7.5 新增的
--                                                灰階配色,CalendarPage.tsx 用 bg-muted/text-muted-
--                                                foreground 同一個 token 家族)
-- 用 CSS Color 4 規格公開的 OKLab→線性 sRGB 轉換矩陣(Björn Ottosson 發表、W3C 採用的標準公式)
-- 逐一手算轉成 sRGB hex(全部落在 [0,1] 色域內,不需要色域裁切,換算結果是精確值,不是近似):
--   warn  → #ebaa2d
--   brand → #1c6fd2
--   cta   → #1ea25d
--   muted-foreground → #606d7f
-- 這四個色碼就是下面 DEFAULT 值/seed 值的來源,不是這次規劃階段推測的近似色碼。

create table public.merchant_booking_status_colors (
  merchant_id uuid primary key references public.merchants(id) on delete cascade,
  pending_confirmation_color text not null default '#ebaa2d',
  accepted_color text not null default '#1c6fd2',
  completed_color text not null default '#1ea25d',
  cancelled_color text not null default '#606d7f',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.merchant_booking_status_colors is '建單與訂單管理介面優化 §10.1(SPECS-INDEX #620):商家層級訂單狀態顏色設定,一商家一列,查無資料時前端/後端一律套用這四個 DEFAULT 值(等同目前程式碼寫死的預設顏色,已實際量測 src/styles.css 的 warn/brand/cta/muted-foreground 四個 design token 換算而來,不是估算值)。CalendarPage.tsx(色塊)/OrdersPage.tsx(色條)這次改成兩處都讀同一張表(§10.5),取代原本各自寫死的 Tailwind class。';
comment on column public.merchant_booking_status_colors.pending_confirmation_color is '待確認,對應改版前的 warn 橘色系(實測色碼 #ebaa2d)。';
comment on column public.merchant_booking_status_colors.accepted_color is '已確認,對應改版前的 brand 藍色系(實測色碼 #1c6fd2)。';
comment on column public.merchant_booking_status_colors.completed_color is '已完成,對應改版前的 cta 綠色系(實測色碼 #1ea25d)。';
comment on column public.merchant_booking_status_colors.cancelled_color is '已取消,對應改版前的 muted-foreground 灰色系(實測色碼 #606d7f)。';

create trigger merchant_booking_status_colors_set_updated_at
  before update on public.merchant_booking_status_colors
  for each row execute function public.set_updated_at();

alter table public.merchant_booking_status_colors enable row level security;

-- §10.3:SELECT 開放給所有能存取這個商家的登入使用者——顏色是顯示邏輯,不是敏感資料,任何看得到
-- 訂單的人都應該看得到正確的顏色。這裡直接對應「看得到訂單」= private.can_manage_bookings(即
-- orders section_key:管理員永遠可以,被授權 orders 的客服也可以),跟 §10.4 UPDATE/INSERT 函式
-- 的權限判斷共用同一支函式,不需要另外定義一個「更寬鬆」的存取函式。
create policy merchant_booking_status_colors_select on public.merchant_booking_status_colors
  for select to authenticated
  using (private.can_manage_bookings(merchant_id));

-- 沒有 INSERT/UPDATE/DELETE 政策——寫入只透過下一支 migration 的 SECURITY DEFINER 函式
-- (seed_default_booking_status_colors / update_merchant_booking_status_colors),不開放任何角色
-- 直接對這張表下 INSERT/UPDATE/DELETE(比照 merchant_tax_settings 系列設定表的既有做法精神,
-- 差別是這次連 INSERT/UPDATE 政策都不開,全部收斂到 upsert 函式,理由:§10.3 的權限判斷本來就是
-- 同一支 can_manage_bookings,直接開表級 RLS 政策 vs. 透過函式對使用者體驗沒有差異,但集中在
-- 一支函式更方便未來如果要疊加格式驗證/稽核記錄時只改一個地方)。
