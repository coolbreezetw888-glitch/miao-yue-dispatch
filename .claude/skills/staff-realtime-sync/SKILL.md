---
name: staff-realtime-sync
description: 秒約服務人員端行事曆「即時同步」(Supabase Realtime Broadcast 私有頻道)的規則與已知坑。要改訂單相關 trigger、服務人員行事曆、realtime 頻道/政策、或想在別的頁面加即時更新時套用。
---

# 服務人員端即時同步(#874 → #885~#907)

> 2026-10-01 完成並通過品管(未上線時寫成)。完整規格:`.project/specs/服務人員端即時同步.md`(在母版資料夾,不在本 repo)。

## 架構一句話
訂單或助手名單變動 → 資料庫 trigger 發一則**不含任何內容**的訊號到私有頻道 `staff:<merchant_staff id>:schedule` → 服務人員的行事曆頁收到就重查既有的 `get_my_booking_schedule`。**資料權限一點都沒放寬**,訊號只是「請重查」的鈴聲。

## 🔴 鐵律
1. **訊號 payload 只能是 `{id, reason:'schedule_changed', v:1}`**。絕對不能帶客戶姓名、電話、地址、備註、日期 —— 否則等於繞過 #851/#876 的遮蔽。
2. **不能改用 Postgres Changes 訂 `bookings`**:服務人員在設計上一筆 bookings 都 SELECT 不到,Postgres Changes 需要訂閱者通過 RLS。
3. `realtime.messages` **只有一條 SELECT 政策**(`staff_schedule_broadcast_receive`,`authenticated`),**刻意沒有 INSERT 政策** —— 登入者不能自己發訊號,只有 trigger(owner 身分)發。
4. 判斷誰能收、誰會被發,**兩邊要一致**:在職 + 已開通登入 + 「行事曆檢視」權限開(沿用 #876 的 `private.staff_calendar_view_allows_notifications`)。改其中一邊要同步改另一邊。
5. 發送端**同一筆交易內去重**(交易內 GUC):`update_booking` 會把助手名單全刪再全加,不去重會一人收好幾則;匯入 1000 筆不去重就是 1000 則。
6. `realtime.send` 內部會吃掉錯誤 ⇒ 發訊號失敗**不會**讓建單/改單回滾。這是敢掛在 trigger 上的前提;如果哪天 Supabase 改了這個行為,要重新評估。
7. 新函式一律放 `private` schema,照 `supabase-permission-hygiene` 做 revoke/grant。
8. 用語一律「服務人員」。

## 前端(`src/modules/staff-portal/`)
- `staffScheduleChannel.ts`:純邏輯(topic 組字、訊號解析、斷線分類 `isTransportChannelError`、狀態判定)。
- `context.tsx` 的 `useStaffScheduleLiveSync`:進行事曆頁才訂閱、離開退訂;權限變 false → 退訂;收到訊號去抖後重查;重連 SUBSCRIBED 時強制補查一次;連續被拒 3 次(`STAFF_SCHEDULE_MAX_CONSECUTIVE_ERRORS`)就放棄,重進頁面才再試。
- **傳輸層斷線不計入放棄次數**(只認 4 種明確開頭的訊息),其他任何沒見過的錯誤一律算「被拒」→ 預設是安全的。
- 即時功能壞掉時行事曆照常可用,只記 warn、不跳 toast;console 不可印 token。
- 2026-10-07 第 14 批(#1003/#1006)起,商家端行事曆**也有**即時同步:私有頻道 `merchant:<merchant_id>:calendar`,訊號只有 `{v:1, reason:"calendar_changed"}`。
  - 觸發:每週時段、單日例外、訂單、助手四張表;訂單/助手另外 fan-out 到同集團同一人(`same_person_staff_ids_in_group`)所在的其他店。同一筆交易同一家店只發 1 則;發送失敗不影響存檔。
  - 收聽權限:`private.can_listen_merchant_calendar_topic` → `can_manage_bookings`。`realtime.messages` 只有 2 條 SELECT 政策(服務人員、商家),**沒有寫入政策**;新增頻道時 pgTAP 的政策數量斷言要跟著改。
  - 前端:`booking/useMerchantCalendarLiveSync.ts` + `merchantCalendarChannel.ts`,去抖/重連補查/被拒 3 次放棄共用 `staffScheduleChannel.ts` 的純函式;收到訊號只重抓 5 支行事曆查詢。
  - ~~不涵蓋請假 / 營業時間 / 服務人員資料~~ → 第 17 批 #1011(2026-10-08,migration `20261008100000_req1011`)已補:
    - `staff_leave_records`、`merchant_business_hours`、`merchant_staff` 各掛 trigger,**只在行事曆實際讀的欄位變動時發**(請假:staff_id/status/start_date/end_date/假別;營業時間:day_of_week/is_closed/open_time/close_time;服務人員→商家:merchant_id/name/status/unlimited_backend_edit/正規化電話;→本人另加 can_create_edit_orders/show_member_info/compensation_type)。intro、avatar、備註、no_time_slot_limit 等不發。
    - 請假、營業時間**不跨店**(灰格只算訂單、可預約檢查只看自己那列)。⚠️ 電話變動會通知同集團新舊電話相同的其他店(`private.notify_calendar_for_phone_peers`,可單獨移除)。
    - 服務人員端收到訊號現在也重抓 `my-day-business-hours`、`my-staff-record`(推翻 #896 Q1 部分);商家端多重抓 staff-list。
    - 建單表單已開著時不重抓可選時段(沿用「表單不閃動」原則)。
    - 新表要加即時同步:照這三支 trigger 的寫法,欄位篩選 + 交易內去重 + 每段 begin/exception。
  - 每個開著行事曆的商家分頁多佔 1 條 Realtime 連線(Free 上限 200,#901)。
- 2026-10-08 第 23 批 #1036(migration `20261008150000_req1036`,commit be1614c):服務人員頻道多了兩個觸發來源。
  - `staff_availability_windows`(每週時段)→ `private.tg_staff_availability_windows_staff_live_sync`;`staff_availability_overrides`(單日例外)→ `private.tg_staff_availability_overrides_staff_live_sync`。**只送本人、不跨店**;單日例外只在人/日期/格子/開關變動時發,「再關一次」只動 updated_at 不發。
  - 前端:`useStaffScheduleLiveSync` 現在掛在 **MyCalendarPage 與 MyAvailabilityPage(休假設定)** 兩頁;重抓清單 `STAFF_SCHEDULE_INVALIDATE_KEYS` 共 6 把(含每週時段 `["booking-module","staff-availability-windows"]`、排休 `["staff-portal-module","my-availability-overrides"]`)。
  - `AvailabilityWindowEditList`(商家端、服務人員端共用):重抓時正在編輯(草稿≠原值)的列被刪 ⇒ toast「這組時段已被刪除」;沒草稿或改回原值的列安靜消失;改回原值即丟草稿。
  - 已知限制(使用者接受):休假設定頁即時更新需要「行事曆檢視」權限(收聽判定沿用鐵律 4)。
  - 同集團同一人「收不到別店時段訊號」只有 pgTAP 驗(B1/H1/G2),e2e fixture 沒有同一人跨店情境。
  - e2e 的清理程式要連 `merchant:%:calendar` 的訊號列一起清(b14 有寫,其他測試尚未補)。

## 已知限制(不修)
- 同一個 topic 在舊頻道退訂途中又被重新訂閱(權限 true→false→true 在一次網路來回內完成):realtime-js 會回傳正在 leaving 的舊物件,這次收不到即時訊號,重進頁面恢復。真要修:建頻道前查 `getChannels()` 同名頻道狀態。
- 若 Supabase 日後用 `phx_error` 推送拒絕,會被當傳輸層斷線而不累計放棄 → 只會回到 supabase-js 原本的退避重連,不洩漏資料。
- 每天第一則訊號可能因分區未建而失敗、Postgres Logs 出現 `WarnSendingBroadcastMessage`(#902),預期行為。
- ~~跨店灰色佔用格不即時(#906/#964)~~:第 14 批 #1006 已修(服務人員端原本就會即時;商家端改由上面的商家頻道處理)。

## 測試
- pgTAP:發送端、去重、授權函式、政策數量。
- vitest:`staffScheduleChannel`、`useStaffScheduleLiveSync`、`MyCalendarPage`。
- **e2e 只在本機跑**:`npm run test:e2e:local` → `e2e-local/staff-schedule-live-sync.spec.ts`(E1~E13b)。守門擋任何非 localhost 的 HTTP/WebSocket。
- E13b 的寫法:要「等收到 phx_join 才切斷」,頻道在 joining 狀態才會每輪都報 CHANNEL_ERROR;單純斷 socket 只會報 1 次,鎖不住「斷線不計入放棄」。
- fixture 用 `docker exec psql` 清 `realtime.messages`,前面有本機目標檢查;如果前面步驟丟錯會跳過清理,殘留可能讓 pgTAP module14_07 的 P2 失敗 → 重跑 `supabase db reset --local`。

## 上線
- 照母版 `.project/notes/2026-10-01-即時同步上線清單.md`。重點:先請使用者在 Supabase 後台 Realtime Settings 關掉「Allow public access」,再套 migration,指紋與政策數核對過才推前端。
- 連線數:約 400 位服務人員前要升 Pro,每月看 Connected Clients(#901)。
