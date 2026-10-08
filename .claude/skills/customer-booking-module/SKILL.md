---
name: customer-booking-module
description: 秒約客戶端(公開預約頁 /booking/<代碼>、未來的 LINE 登入/會員中心 /me)的規則與已知坑。要改公開預約頁、客戶版可約時段、公開 RPC、商家「線上預約」設定、或推薦畫面開關時套用。
---

# 客戶端模組(模組 13)

> 第 1 批 2026-10-08 上線(commit fbb1b1e,#1040/#1037/#1039/#978)。規格:母版 `.project/specs/客戶端第1批-公開預約頁.md`;總體定案在 `.project/specs/客戶端模組-規劃草稿.md` 第七章(優先於草稿其他章)。
> 後續批次:2 LINE 登入+既有會員驗證+訪客預約;3 送出預約+通知商家;4 會員中心/我的錢包;5 LINE 通知與綁定。

## 🔴 鐵律
1. **未登入的人只能透過兩支 SECURITY DEFINER 函式拿資料**:`get_public_booking_page(slug)`、`get_public_available_slots(slug, items, staff_id, from, days)`。**不准**新增任何給 anon 的 RLS / `grant select`(pgTAP 斷言 anon policy = 0)。
2. 公開函式回傳**白名單逐欄** `jsonb_build_object`,禁止 `to_jsonb(整列)`。新增欄位時,要把新欄位的哨兵字串加進 `c1_public_booking_page.sql` 與 e2e `c1-public-booking-page` 的全文搜尋。
3. 「不指定」只回時間,**不能透露哪位服務人員有空**;停用/不存在代碼只回 `{status}`。
4. 錯誤訊息固定中文 + `hint` 代碼,不帶任何資料;前端依 hint 顯示自己的句子,不顯示資料庫原文。
5. **客戶版時段規則只有一支**:`private.check_customer_booking_slot`(回原因代碼,null=可約)。第 3 批送出預約**必須呼叫同一支**,看得到 = 送得出。
6. 客戶版必須跟後台 `list_staff_bookable_start_times` **等價**(沒有客戶專屬規則時);營業時間/每週時段/單日例外那段是複製後改寫,**改後台時段核心時要同步改客戶版**並重跑 `c1_public_available_slots` 的 B01 等價測試。
7. 客戶端專屬規則(後台不受影響):
   - `unlimited_backend_edit` 對客戶無效;**一律擋重疊**(不看 `strict_conflict_check`)。
   - `no_time_slot_limit` 只跳過每週時段,營業時間仍要遵守(#977)。
   - 最少提前天數(空=0)、最遠可預約天數(**空=60**)、`merchant_booking_settings.min_lead_hours`(預設 2,0~72)。
   - 車程緩衝 `travel_buffer_minutes`(0~240)**只有到府產業生效**,只延長「與既有訂單」的比對區間 `[T−X, T+D+X)`,不延長營業/每週時段邊界;後台不擋不提醒(#1039)。
   - 工時 = Σ(工時 × 數量),**一律伺服器重算**;至少 1 個主要項目;服務人員有對應項目時只檢查主要項目,沒任何對應 = 全會。
8. `merchant_booking_settings` 大多數商家**沒有列**:讀取一律 coalesce 預設值,不要補插 463 列。新三欄(min_lead_hours/travel_buffer_minutes/allow_guest_booking)有保護 trigger `private.protect_merchant_booking_settings_online_columns`:只有管理員能改(客服有營業時間權限也只能改建單間隔)。
9. `apply_industry_preset`、`generate_booking_slug` 已收回 PUBLIC/anon/authenticated 執行權限(只剩 service_role);呼叫者是 SECURITY DEFINER 的建店函式。
10. 測試用「現在時間」只在 `private.public_available_slots_at`(postgres/service_role),**對外函式不能多一個指定現在時間的參數**。

## 前端(`src/modules/public-booking/`)
- 不套後台外殼、不需登入;已登入後台的人打開也看客人版,不帶自己商家資料。主題色依該預約頁商家,離開要還原。
- ①~⑤ 同一網址內切換,系統「上一頁」= 上一步(history state);填的資料**不存瀏覽器**,重新整理回 ①。
- 不能按的按鈕上方常駐黃色 ! 說原因(ui-overlay-patterns 二之三)。數量單位「份」(不用冷氣業的「台」)。
- 文字一律純文字顯示(不用 dangerouslySetInnerHTML)。
- 推薦畫面總開關 `src/modules/members/referralVisibility.ts` 的 `REFERRAL_UI_HIDDEN`(#1037):紅利推薦分頁、會員詳細頁推薦碼/名單、新增會員推薦人、列表推薦碼、編輯視窗推薦人、功能卡片字樣、搜尋提示都吃這個;匯入/匯出、資料庫、獎勵邏輯不動。相關測試改成「開關關掉才驗」,不刪測試。

## 已知限制 / 待辦
- 公開函式沒有呼叫頻率限制(最壞 0.5~1.2 秒/次)→ 第 3 批防機器人驗證時一起處理。
- 「下一週」停用靠前端推斷(函式不回傳最遠日);不指定且各人範圍有空檔時可能提早停用。
- 服務人員設定頁的客戶預約欄位「即將推出」字樣,第 3 批送出上線時拿掉。
- `types.ts` 裡 `get_public_available_slots` 的 `p_staff_id` 是手改成 `string | null`,重新產生型別會被蓋掉。

## 測試
- pgTAP:`c1_public_booking_page.sql`(白名單、哨兵)、`c1_public_available_slots.sql`(B 區、等價、效能)、`c1_function_acl_hardening.sql`(權限)。
- e2e-local:`c1-public-booking-page.spec.ts`(含攔截 `/rest/v1/rpc/` 原文搜哨兵)、`c1-merchant-online-booking-settings.spec.ts`;fixture `e2e-local/support/c1-public-booking-fixture.ts`。
