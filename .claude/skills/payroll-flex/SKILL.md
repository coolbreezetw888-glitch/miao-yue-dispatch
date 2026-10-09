---
name: payroll-flex
description: 秒約「彈性計薪」(#1035)的規則與已知坑:月薪獎金方案(A 批)、之後的日薪/時薪(B 批)與自由公式(C 批)。要改薪資設定、店家/服務人員報表、抽成或薪資狀態歷史函式時套用。
---

# 彈性計薪(#1035)

> A 批「月薪加獎金」:commit f9f9f69,migration `20261010160000_req1035a_bonus_plans_schema`、`20261010160100_req1035a_bonus_functions`(2026-10-09 上線)。完整規格:母版 `.project/specs/彈性計薪.md`(不在本 repo)。

## 使用者裁決(2026-10-09,全部 A)
- Q1 日薪/時薪上工時間 = 可預約時段 + 時段外被排的訂單,重疊只算一次(B 批)。
- Q2 有上工就算一天(B 批)。
- Q3 獎金件數只算**主要服務人員**,跟場不算(避免一台發兩份)。
- Q4 日薪/時薪的人不能自己開關時段(B 批)。
- Q5 先建「獎金方案」再套給人。

## A 批資料
| 表 | 用途 |
|---|---|
| `staff_bonus_plans` | 方案(每店使用中最多 50 個;使用中同名不分大小寫唯一;封存後不能改) |
| `staff_bonus_plan_versions` | 規則版本;effective_month 必為 1 號,只能寫本月或下個月;計算取 ≤ 該月最新版本 |
| `staff_bonus_assignments` | 指派給在職月薪人員;變動由 trigger 同步進 `staff_payroll_status_history.bonus_plan_id` |

三張表 RLS 開、0 policy,只能經 RPC(list/save/set/archive/preview/get_staff_bonus_by_range)。

## 🔴 鐵律
1. **抽成相關函式不能動**:`calculate_booking_staff_commission`、`compute_booking_commission`、`recalculate_booking_commission`、`compute_staff_payroll(_by_range)`、`get_merchant_monthly_salary_base_as_of` 等。業績基準另抽成 `private.booking_item_revenue_basis`,算式要跟抽成那支逐行一致 —— 改其中一邊要同步另一邊。
2. 獎金看**月底(台北時間)當時**的狀態:最後一天被移除或改成抽成制 ⇒ 該月 0 元。只算 completed、只算主要服務人員。
3. 每條規則各自四捨五入到元;單月合計封頂 100 萬並帶 capped 旗標。
4. 只算**完整月份**;不完整月份顯示「這幾個月不是完整月份，不計算獎金」。
5. **沒有任何方案的店,報表/CSV 必須跟改版前一字不差**:前端一律看 `bonus_feature_used` 決定要不要顯示獎金卡、淨利說明、CSV 欄。
6. 服務人員本人看自己的獎金,回應不能含方案 id/名稱/版本。
7. `get_staff_payroll_status_as_of` 是 drop+create(多回 bonus_plan_id);B 批還會再加欄,**以 A 批版本為底**,改後 5 支呼叫者都要實際呼叫驗證。
8. 同層兄弟元件的 key 要加前綴(`editor-${seq}` / `archive-${seq}`),計數器都從 0 起會撞 key。

## 指紋(A 批上線後正式庫)
- sync_staff_payroll_status_history d3d5655e、get_staff_payroll_status_as_of 916323b0、get_merchant_billing_summary_by_range 9a1f196c、get_staff_bonus_by_range 209ef2f1。
- ⚠️ 上線前正式庫有幾支函式是「拿掉註解後」部署的,指紋跟 migration 檔不同(例:sync 舊值 58c14a89、as_of 舊值 fc8695aa、get_merchant_monthly_salary_base_as_of ecf1674e)。核對前先把註解去掉再算,或直接以正式庫現值為準。

## 已知限制(使用者未裁決前照規格)
- 沒有月結鎖帳:已完成單被還原/取消,過去月份獎金會跟著變;料錢設定看「現在」的值。
- 服務人員端「我的薪資報表」預設區間是本月 1 號到今天(不完整月份),看不到本月獎金,要切「按月份」(待使用者決定是否改預設)。
- 方案名稱不分版本,改名後過去月份明細顯示新名。
- 區間中途從月薪改抽成的人,明細列獎金欄為空但總數含前面月份(跟月薪基本額慣例相同)。
- 單月舊版 `get_merchant_billing_summary` 不算獎金(前端已不用)。

---

## B 批「日薪/時薪」(2026-10-09,commit afa6865,migration `20261010170000_req1035b_wage_schema`、`20261010170100_req1035b_wage_functions`)

### 資料
- 計酬類型 check 擴成四種:`piece_rate`、`monthly_salary`、`daily_wage`、`hourly_wage`。
- `staff_wage_settings`(金額)→ trigger 同步進歷史表 `wage_amount`(舊列 null,sync 比對時當 0)。
- `staff_work_day_records`(唯一 staff_id+work_date):每日凍結的上工分鐘/金額/原因。cron `staff-work-day-freeze`(`15 16 * * *` UTC = 台北 00:15)凍結前一天。

### 算法鐵律
1. 上工分鐘 = (每週時段 ∩ 營業時間 − 單日例外關掉的格子) ∪ 這人當主要或跟場的未取消訂單;用 int4multirange,重疊只算一次;跨午夜切兩天;24:00 = 1440。
2. 請假那天 = 0。時段外的「開放」格不加分鐘(#1023)。
3. 日薪有上工就算一整天;時薪每天四捨五入到元。
4. 報表每天標 settled(已凍結)/ unsettled(過去但沒紀錄)/ estimated(今天),未來不算。
5. **凍結後只在這些情況重算那天**(都會用「現在的」每週範本):訂單新增/刪除、改時間、換主要服務人員、變成或離開 cancelled;請假新增/改/刪;單日例外變動;`recompute_staff_work_day`。其他訂單狀態變化(例如 confirmed→completed)**不重算**。改每週範本不影響已凍結日子。
6. 4 支 AFTER trigger 掛在 bookings / booking_assistants / staff_availability_overrides / staff_leave_records:今天/未來直接略過;沒有工資歷史的人經 `staff_has_wage_history` 快速略過。不吞錯。
7. Q4:日薪/時薪的人 `can_self_manage_availability` = false(DB 與前端都擋)。
8. 店家報表:`wage_feature_used` 決定是否顯示;明細在主名單後補「區間內有工資的日薪/時薪人員」(中途改制者在原列帶 wage_amount 等 4 欄,月底前離職者另加一列),保證「明細工資加總 = total_wage_payout」且每人只一列。
9. `get_staff_wage_by_range` 查不到人也回 42501(不洩漏 id)。

### 指紋(B 批上線後)
sync 5b85b194、as_of 4e155840、get_merchant_billing_summary_by_range 0cd65c0a、create_staff_leave 18fe6df2、tg_bookings_refreeze_work_day 887ac4ea、get_staff_wage_by_range 73067e23。as_of 現有 7 支呼叫者;C 批要再改時以這版為底。

### B 批已知限制
- 硬刪有跟場的過去訂單時,跟場那天不重算(跟場資料先被連帶刪掉;目前只有匯入還原會硬刪)。
- 訂單詳情「沒有抽成紀錄」改成通用說法(`get_booking_commission_summary` 不能動,不回計酬類型)。
- 服務人員報表版面看「目前」的計酬方式;改制後回看過去月份看不到工資明細(合計有算)。
- staff_payroll_status_history 沒有 merchant_id 索引(體檢時加)。

---

## C 批「自由公式」(2026-10-09,commit c52236d,migration `20261010180000_req1035c_bonus_formula`)

### 🔴 公式安全鐵律(改公式引擎前必讀)
1. **永遠不准用 EXECUTE / format() / 任何動態 SQL** 處理公式。流程固定:`bonus_formula_compile` 逐字白名單切記號 → 遞迴解析成 jsonb 語法樹 → `bonus_formula_eval` 遞迴求值。服務名稱只當查詢參數、限本店,存檔時換成服務 id。
2. 存檔一律以 text 在伺服器重新編譯,**忽略前端送來的 ast**。前端不做任何求值(沒有 eval / new Function / 自己的解析器),檢查與試算都打 `preview_bonus_formula`。
3. 上限:300 字、150 記號、函式巢狀 8、數量/業績 合計 10 次、每方案 5 條;計算器再整棵檢查(節點深度 200、節點數 300、欄位與運算子白名單),不符丟 BFE02「獎金公式的資料不正確，請重新儲存這個獎金方案。」。
4. 編譯錯誤用 BFC01 回 `{ok:false, message:"第 N 個字附近：…", position}`,不吞錯、不露 PostgreSQL 內部訊息。看不見的字元(零寬、方向控制、特殊空白)訊息只寫 `U+XXXX`,不放原字元。
5. 除以 0 → 那次除法 = 0 + division_by_zero 旗標;中間值 > 1e12 → 整條 0 + overflow;< 0 → 0 + negative_clamped;> 100 萬封頂 + capped。IF 只算選到的那邊。
6. 服務人員看報表不含公式原文/ast;名稱空白時預設「自訂公式」。
7. 白名單:欄位「完成單數、完成數量、業績、月薪、請假天數」;函式 IF(3 參數)、MIN/MAX(2~10)、數量("服務")、業績("服務");接受全形數字/字母/運算子/彎引號;不接受 AND/OR/NOT、`%`、`^`、`.5`、千分位(`MAX(1,000)` 判千分位報錯,提示逗號後加空白)。

### 指紋
bonus_validate_rules 044a3807、bonus_compute_rules bcbc87c0、bonus_formula_compile 7c32ea83、bonus_formula_eval 5f44d9a7、preview_bonus_formula 0d51db59。

### C 批已知限制
- 公式用到的服務改名後計算照常(存 id),但下次開編輯器原文舊名會被判「找不到」,要改新名才能再存。
- 極端報表(一年 × 50 位 × 5 條滿額公式)約 6 秒,接近一般查詢逾時;體檢可考慮限制每方案節點總數。
- 組合字元(U+0300~U+036F)錯誤訊息仍會放原字元(只是顯示,體檢時一起處理)。
- 服務名稱含引號的服務無法用公式指定(前端提示先改名)。
