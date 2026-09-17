-- 預約詳情資訊擴充與建單備註分類(資料層)
-- 對應規格書 D:\SaaS-tool-scaffold(預約系統)\.project\specs\預約詳情資訊擴充與建單備註分類.md
-- 第一節(customer_notes)、第三節第 3.3 點(最後修改追蹤機制)。
--
-- 命名說明(規格書第五節第 4 點:欄位名稱跟規格書描述有出入時,以工程師實際讀到的 schema 為準,
-- 並在回報時說明實際用了哪個欄位)——規格書原本建議新增欄位叫 bookings.updated_at,但 bookings
-- 表已經有一個同名、NOT NULL、由既有 trigger bookings_set_updated_at(見
-- 20260916140000_booking_schema.sql)在每次 UPDATE 時自動寫入 now() 的 updated_at 欄位,
-- 用途是通用的「這一列最後被寫入的時間」,建立當下就等於 created_at,不是 nullable。這跟規格書
-- 要的「從未被 confirm_booking/update_booking/cancel_booking/complete_booking 這四支函式異動過時
-- 要維持 null」語意衝突(既有欄位建立當下就有值、永遠不會是 null),也沒辦法同名新增第二個欄位,
-- 所以改用 last_modified_by_user_id / last_modified_at 這組名稱:語意上更精確對應「被這四支函式
-- 異動過」這件事,不是既有欄位那種泛用的「這一列被寫入過」,也避免跟既有 updated_at 搞混或衝突。
alter table public.bookings
  add column customer_notes text,
  add column last_modified_by_user_id uuid references auth.users(id) on delete set null,
  add column last_modified_at timestamptz;

comment on column public.bookings.customer_notes is '對應規格書「預約詳情資訊擴充與建單備註分類」第一節:客戶備註(客戶看得到的備註),跟既有 notes 欄位(語意上是「內部備註」,商家內部看、客戶看不到,欄位名稱本身這次不改)分開存放,互不影響。nullable,既有預約資料這欄位查詢是 null。';

comment on column public.bookings.last_modified_by_user_id is '對應規格書第三節第 3.3 點:confirm_booking/update_booking/cancel_booking/complete_booking 這四支函式,只要成功執行,都會把這欄設成 auth.uid()。nullable,從建立到現在都沒被這四支函式異動過的訂單維持 null(例如剛建立、還沒被確認過的待確認訂單)。刻意不叫 updated_by_user_id/updated_at,理由見本檔案開頭的命名說明。';

comment on column public.bookings.last_modified_at is '對應規格書第三節第 3.3 點,搭配 last_modified_by_user_id 一起使用,語意跟命名理由同上一個欄位的註解。';
