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
- 全專案目前只有 staff-portal 呼叫 supabase `.channel(`。商家端**沒有**即時同步(刻意)。

## 已知限制(不修)
- 同一個 topic 在舊頻道退訂途中又被重新訂閱(權限 true→false→true 在一次網路來回內完成):realtime-js 會回傳正在 leaving 的舊物件,這次收不到即時訊號,重進頁面恢復。真要修:建頻道前查 `getChannels()` 同名頻道狀態。
- 若 Supabase 日後用 `phx_error` 推送拒絕,會被當傳輸層斷線而不累計放棄 → 只會回到 supabase-js 原本的退避重連,不洩漏資料。
- 每天第一則訊號可能因分區未建而失敗、Postgres Logs 出現 `WarnSendingBroadcastMessage`(#902),預期行為。
- 跨店灰色佔用格不即時(#906/#964,待裁決)。

## 測試
- pgTAP:發送端、去重、授權函式、政策數量。
- vitest:`staffScheduleChannel`、`useStaffScheduleLiveSync`、`MyCalendarPage`。
- **e2e 只在本機跑**:`npm run test:e2e:local` → `e2e-local/staff-schedule-live-sync.spec.ts`(E1~E13b)。守門擋任何非 localhost 的 HTTP/WebSocket。
- E13b 的寫法:要「等收到 phx_join 才切斷」,頻道在 joining 狀態才會每輪都報 CHANNEL_ERROR;單純斷 socket 只會報 1 次,鎖不住「斷線不計入放棄」。
- fixture 用 `docker exec psql` 清 `realtime.messages`,前面有本機目標檢查;如果前面步驟丟錯會跳過清理,殘留可能讓 pgTAP module14_07 的 P2 失敗 → 重跑 `supabase db reset --local`。

## 上線
- 照母版 `.project/notes/2026-10-01-即時同步上線清單.md`。重點:先請使用者在 Supabase 後台 Realtime Settings 關掉「Allow public access」,再套 migration,指紋與政策數核對過才推前端。
- 連線數:約 400 位服務人員前要升 Pro,每月看 Connected Clients(#901)。
