---
name: feature-flags
description: 秒約「平台功能開關」(#1025)的規則與已知坑。要新增可被平台關掉的功能、在某頁加功能守門、改超級管理員功能開關畫面、或動 merchant_feature_flags / merchant_feature_grants 時套用。
---

# 平台功能開關(#1025)

> 第 1 批 FG-1:commit ad4d5e1,migration `20261010150000_req1025_fg1_feature_grants`、`20261010150100_req1025_fg1_feature_gates`(2026-10-09 上線)。完整規格:母版 `.project/specs/功能開關.md`(不在本 repo)。

## 架構一句話
平台(超級管理員)決定每間店「有沒有這個功能」;商家自己打不開。關掉 = 商家後台**整個看不到**(使用者裁決 F3=A,不做上鎖畫面),而且資料庫函式同步擋住。

## 三張表
| 表 | 用途 | 誰能寫 |
|---|---|---|
| `platform_features` | 功能清單(key、名稱、off_impact、預設值、parent_key,只允許一層主/細部,trigger 擋) | 只有 migration |
| `industry_feature_presets` | 新開店依產業預設開哪些(外鍵到功能清單) | 超級管理員 |
| `merchant_feature_grants` | 每間店實際開關(真相來源) | **只有** `platform_set_merchant_feature`(第一行驗超級管理員);沒有任何寫入政策 |
| `merchant_feature_grant_logs` | 誰、何時、哪間、開關前後、備註;`is_bulk` 欄位留給批次開關(FG1-F06,等使用者 F6) | 寫入函式自動寫 |

## 🔴 鐵律
1. **擋住點一律在資料庫**:用 `private.merchant_has_feature(merchant_id, key)`(merchant_id null ⇒ false)。只藏畫面不算數。
2. **絕對不要讀 `merchant_feature_flags` 當平台開關** —— 那張是商家自己能寫的設定;現在已用 CHECK 收成白名單(`material_cost_enabled`、`strict_conflict_check`),新增商家設定 key 要同步改 CHECK。
3. 前端判斷一律 `hasFeature(key) === true`:讀取中/失敗都當「先不顯示」,路由守門 `RequireMerchantFeature` 讀取中只顯示骨架、**不導走**,確定關才 `Navigate replace` 到 `/app/manage`。
4. 客人端被關時回應要跟「停用的店」逐字相同(`{"status":"unavailable"}` / page_unavailable),不透露是平台沒開通。
5. 商家端被擋的錯誤訊息:「這個功能目前沒有開放。」(42501 / feature_disabled),不帶資料。報表匯出例外:沿用既有權限訊息。
6. 功能關掉時,店家給個人/角色的設定值**保留不刪**(畫面藏起來、存檔原值送回),平台重開後原設定直接恢復。
7. 畫面不出現任何方案、價格、加購字眼(訂閱連動等 #864 方案定好再做)。
8. 新開店(`apply_industry_preset`)寫 grants,不寫變更紀錄;產業沒設預設時用功能清單預設值。

## 目前的開關(FG-1)
| key | 關掉時擋哪裡 |
|---|---|
| 線上預約 | `merchant_public_booking_open` → get_public_booking_page、public_available_slots_at、internal_customer_submit_booking;後台預約網址卡、商家設定預約網址區塊、服務人員編輯裡 4 個線上預約欄位(⚠️6) |
| 資料匯入 | import_members_batch、import_historical_bookings_batch(`[req1025 begin/end]` 標記段);功能頁卡片、路由、產業轉移空狀態說明 |
| 報表匯出 | `can_export_reports` AND 開關;功能頁卡片、路由、客服權限頁那一列、產業轉移結果頁連結。`get_staff_commission_summary` 管理員仍可經服務人員報表權限呼叫(刻意) |

## 新增一個可關的功能(照做)
1. 新 migration:`platform_features` insert + 既有商家每間補 grants(補完核對列數 = 商家數 × 功能數,不符就 raise)+ 兩產業預設。
2. 資料庫擋住點加 `merchant_has_feature`;改既有大函式時以正式庫現行本體為底,只插標記段,事後指紋比對。
3. 前端:`MERCHANT_FEATURE_KEYS` 加 key;卡片/連結 `hasFeature(...) === true`;路由包 `RequireMerchantFeature`;grep 全專案連到該頁的連結。
4. pgTAP 斷言 grants 列數、擋住點、ACL;vitest 驗看不到/導回。

## 待做
- FG1-F06/U08 批次開關+統計(等使用者 F6)。
- FG-2:LINE 通知、再行銷、手機推播(會碰 public-booking,等 #1048 收尾)。
- FG-3:服務人員細部功能(等 F7~F9)。疊加規則:實際能用 = 平台主功能開 AND 平台細部開 AND 店家給這個人開。
- F01 清單裡還有 10 支客人端函式有自己的停用檢查、沒接線上預約開關(customer_me_context、get_customer_session_state 等),之後評估。

---

## 批次開關 + 服務人員細部功能 + 按儲存才生效(2026-10-09,commit d3ffb25,migration 20261010200000/200100/200200,Edge invite-merchant-staff v10)

### 使用者第三輪裁決(鐵律)
1. **細項縮排列在大項下面**;大項打開時細項預設全開;大項關掉時細項變灰不能操作(值保留)。
2. **所有平台開關都是「先調整、按儲存才生效」**(功能開關頁、商家詳情卡、全部開啟/關閉)。一次儲存在同一個交易內(`platform_save_feature_settings`、`platform_set_merchant_features`),任何一項不合法整筆不寫;未存離開用 `useLeaveGuard` 提醒(攔不到瀏覽器上一頁)。舊的單項 `platform_set_merchant_feature` 保留但畫面不用。
3. 批次只寫有變動的店,紀錄 `is_bulk=true`,備註空白寫「批次調整」。統計用 `platform_feature_usage_summary`(細項跟著大項算關)。

### 服務人員細部功能(FG-3)
- 大項「服務人員登入端」;細項:新增編輯訂單、自己排休、看自己的抽成薪資(行事曆檢視與確認接單併入大項)。
- **實際能用 = 平台大項 AND 細項 AND 店家給這個人**,集中在 `private.has_own_staff_permission`、`private.staff_order_self_ok`、`generate_own_staff_line_binding_code`;Edge `invite-merchant-staff` 用 service role 呼叫 `internal_merchant_has_feature` 自己檢查(關 → 403,查詢失敗 → 500)。
- 登入端關:服務人員只看到「這間店目前沒有開放服務人員登入，請聯絡店家管理員。」+ 登出(頁首保留可切商家,不提秒約);底部分頁籤與鈴鐺不顯示;雙重身分停在後台。`resolve_push_recipients` 停發推播與站內鈴鐺給該店服務人員(管理員/客服不受影響)。即時同步發送端沒改(空訊號,收聽端已擋)。
- 後台服務人員管理:登入端關時「邀請登入」「服務人員權限」、登入狀態/信箱、新增編輯訂單、顯示會員資料都藏起來,存檔原值送回;「商家後台確認後直接接單」照常顯示(F9)。
- 未擋(只回本人顏色/營業時間設定,無客人資料):get_my_booking_status_colors、get_my_calendar_state_styles、get_my_day_business_hours、get_my_day_schedule_state、clear_staff_pending_login_email、頭像 storage 政策。

### 指紋(上線後)
has_own_staff_permission b30806e9、staff_order_self_ok 9aebab86、generate_own_staff_line_binding_code 27b39cde、resolve_push_recipients 5da04839。正式庫 merchant_feature_grants = 商家數 × 7。

### 待做
- FG-2:LINE 通知、再行銷、手機推播開關(等週額度重置)。
- 小尾巴(體檢時處理):批次確認窗大項關閉缺「底下的細部功能也會一起停用。」;關閉畫面頁首標題仍是「個人資料」;req1025 e2e 沒監聽 console same key。
