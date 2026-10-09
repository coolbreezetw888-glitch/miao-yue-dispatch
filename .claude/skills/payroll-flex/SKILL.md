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
