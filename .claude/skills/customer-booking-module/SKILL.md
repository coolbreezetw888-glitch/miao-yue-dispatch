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
   - 最少提前天數(空=0)、最遠可預約天數(**空=180**,第 3 批起)、`merchant_booking_settings.min_lead_hours`(預設 2,0~72)。
   - 車程緩衝 `travel_buffer_minutes`(0~240)**只有到府產業生效**,只延長「與既有訂單」的比對區間 `[T−X, T+D+X)`,不延長營業/每週時段邊界;後台不擋不提醒(#1039)。
   - 工時 = Σ(工時 × 數量),**一律伺服器重算**;至少 1 個主要項目;服務人員有對應項目時只檢查主要項目,沒任何對應 = 全會。
8. `merchant_booking_settings` 大多數商家**沒有列**:讀取一律 coalesce 預設值,不要補插 463 列。新三欄(min_lead_hours/travel_buffer_minutes/allow_guest_booking)有保護 trigger `private.protect_merchant_booking_settings_online_columns`:只有管理員能改(客服有營業時間權限也只能改建單間隔)。
9. `apply_industry_preset`、`generate_booking_slug` 已收回 PUBLIC/anon/authenticated 執行權限(只剩 service_role);呼叫者是 SECURITY DEFINER 的建店函式。
10. 測試用「現在時間」只在 `private.public_available_slots_at`(postgres/service_role),**對外函式不能多一個指定現在時間的參數**。

## 第 2 批 LINE 登入(2026-10-08,commit 191be87,#1042)
- **每店自己的 LINE Login channel**,Secret 存 Vault(`merchant_line_login_configs`),只進不出;登入走 Edge Function `customer-line-login`(`verify_jwt=false`,寫在 config.toml),**自驗 HS256 id_token**(LINE 網頁登入用 Channel Secret 簽;不用 Supabase 自訂 OIDC:免費只 3 個且只認公鑰)。state 存雜湊、單次;PKCE;固定 callback `/auth/line/callback`(`PUBLIC_SITE_URL` 組,不收前端傳入)。掛自訂網域時每店要補登 callback。
- 客戶帳號 = 「LINE channel + userId」一個 `auth.users`,合成 email `line-<uuid>@customer.miaoyue.invalid`,`app_metadata.account_type='customer'`(判斷一律看 app_metadata,不看 user_metadata)。
- **任何「用 email 找帳號再給權限」的地方都要排除客人帳號**(invite_merchant_admin、platform_add_merchant_admin、platform_set_group_admin、lookup_*_by_email、`_shared/inviteAccountResolver.ts` 擋 `.invalid`),錯誤訊息要跟「查無此人」逐字相同。新增類似入口時照做。
- 前端客戶專用 client(`customerClient.ts`,storageKey `miaoyue-customer-<slug>`);後台 AppLayout / PlatformAdminGuard 遇到客人帳號只登出後台 client。
- 電話規則(使用者定案):既有會員**直接接上**(不驗證)+ 店家鈴鐺 `member_line_login_linked`(管理員 + 有會員權限客服);已被別的客戶帳號接上 ⇒ `phone_taken`(不取代、不帶任何資料);店家解除後被解除的帳號進 `customer_member_link_blocks`,不能自動接回,`allow_member_customer_relink` 撤銷;每人每店 24h 最多 5 支電話;收市話(0 開頭 9~10 碼,不收分機)。多位聯絡人 #1041 在第 4 批。
- 建會員沿用 `create_member`,靠 `private.can_manage_members` 的交易內 GUC 標記(只有 `create_member_as_customer_flow` 設,用完即清);PostgREST 不開放 `set_config`,客人設不到。
- Edge 取 IP:先 `cf-connecting-ip`(Cloudflare 會擋客戶端自帶此標頭,回 error 1000),再 XFF **最後一段**,都沒有 = `unknown`;**不可信 XFF 第一段**。頻率限制在「店有啟用 LINE 登入」之後才計算。
- 設 Edge secret(`supabase secrets set`)會讓**所有** Edge Function 版本 +1,verify_jwt 不變;部署前後用 `functions list` 核對。
- LINE 好友狀態 API 回 400/403 當 `not_linked` 是推測,要用真 LINE 實測確認。

## 第 3 批 送出預約(2026-10-09,commit 7bb229d,#1043/#1044)
- **送出只有一條路**:前端 → Edge `customer-booking-submit`(verify_jwt=false)→ `public.internal_customer_submit_booking`(**只給 service_role**)。會員帶客人 token;訪客必須先過 Cloudflare Turnstile(`TURNSTILE_SECRET_KEY` 只在 Edge secret;沒設 ⇒ `guest_unavailable`;正式環境用官方測試 secret ⇒ 一律失敗)。前端 sitekey `VITE_TURNSTILE_SITE_KEY`,Turnstile 腳本只在 ⑥-4 載入。
- 送出時段**只用** `check_customer_booking_slot`(看得到 = 送得出);項目檢查共用 `private.customer_parse_booking_items`(第 1 批時段函式也呼叫它)。單價一律 `service_items.price`;草稿只收 7 鍵,其他丟掉。
- 「不指定」= 依 `merchant_staff.display_order, created_at, id` 第一位能排的人;完成頁 `staff_display` 回被排到那位的顯示名(暱稱優先),送出**前**的時段查詢仍不透露是誰。
- 防重送:前端每進確認畫面產生 `submission_id`;店層級 advisory lock 在查重送**之前**拿;唯一索引 `(merchant_id, customer_submission_id)`;訪客重送要比對正規化電話,會員要同帳號,否則 400。
- 狀態:訪客、黑名單 ⇒ `pending_confirmation`;主要服務人員 `auto_accept_booking` ⇒ `accepted`;`direct_accept_after_merchant_confirm` 對客人單無效。未完成上限 3(超過時不能留下新建的會員)。
- 回傳的 `_internal`(訂單 id、推播文字)**Edge 一定要刪掉**再回客人;e2e 替身也要刪。
- 鈴鐺 `customer_booking_created` 由資料庫同交易寫(一定發,不看推播開關):管理員、有 orders 權限的客服、被排到且通過行事曆檢視門檻的服務人員;黑名單句只給管理員/客服;推播走 `dispatchPushForBooking`(`skipInAppNotification` + `messageOverride`,不含黑名單句)。
- 頻率限制表 `private.rate_limit_hits`(unlogged、只存 IP 雜湊,cron `rate-limit-hits-prune-hourly`)。公開兩支函式每 IP 10 分鐘 120 次 ⇒ 改成 **volatile,只能 POST**;資料庫取 IP 讀 `request.headers` 的 cf-connecting-ip → XFF 最後段,拿不到不限制。正式庫 2026-10-09 實測拿得到。
- 完成頁文字:`merchant_booking_settings.completion_message_member / _guest`(≤200,只管理員能改);沒填預設:會員待確認「店家確認後會通知你。」、會員直接成立「服務前店家可能會再跟你聯絡確認。」、訪客「店家確認後會與你聯絡。」。
- 前端:步驟條 5 步(第 5 步未登入「登入／電話」、已登入「確認送出」);填資料頁依店家設定顯示「下一步會請你…」。**不要在畫面承諾第 4、5 批才有的功能**(會員中心、LINE 通知)。
- 服務人員順位 `display_order`:只能透過 `move_merchant_staff_order`(保護 trigger 擋直接 UPDATE);新增自動排最後;變動只發**商家**行事曆訊號。後台所有選服務人員的地方(`useMerchantStaffList`、`fetchMerchantStaff`、行事曆/排班一覽/帳單報表/報表匯出函式)都依順位;平台端 `platform_get_merchant_staff`、服務人員端不改。**新增列服務人員的地方要照 `display_order, created_at, id` 排。**
- 已知:同一 submission_id 真並發只有程式碼審查(本機建可提交資料被擋);Vercel 預覽網址訪客送出會失敗(只有一組正式 secret);LINE 內建瀏覽器的 Turnstile 要實機測。

## 第 4-A 批 會員中心 / 自己取消(2026-10-09,commit 1b1d243,#1045)
- 網址 `/booking/<代碼>/me`(+`/bookings`、`/wallet`、`/profile`);**只開給有啟用 LINE 登入的店**,沒啟用 ⇒ 函式回 `unavailable`。LINE 加入/登入沒有草稿時一律進 `/me`(取代第 3 批 C3-D07 回 ①)。
- 客人身分一律 `auth.uid()` + slug 經 `private.customer_member_of` / `customer_me_context` 推出,**不收前端傳 member_id**;別人的、別店的、不存在的單一律同一個 `not_found`。4-B 會把 `customer_member_of` 改成查聯絡人表,4-A 函式不用回頭改。
- 取消:前端 → Edge `customer-booking-cancel`(verify_jwt=false,同 IP 10 分鐘 20 次,頻率在驗 token 前算)→ `internal_customer_cancel_booking`(只給 service_role)。**後台 `cancel_booking` 不動**,客人版是同步驟複本,pgTAP 對照結果一致 —— 改後台取消流程時要同步改客人版並重跑 `c4_cancel.sql`。期限 `merchant_booking_settings.customer_cancel_deadline_hours`(0~168,預設 24,只管理員能改);店家建的單也能取消(使用者 Q1)。
- **改 bookings 狀態/內容的函式一律先 `for update` 鎖單、鎖到後才檢查狀態、UPDATE where 加狀態條件**(2026-10-09 修 confirm_booking / move_booking / update_booking_payment_method 的並發 bug:客人取消同時店家確認會把已取消改回已確認)。新增此類函式照做,pgTAP 有本體含 for update 的守門。
- 錢包只有紅利(儲值金 #1038 留 `stored_value: null`);紅利關掉 ⇒ 底部選單不出現錢包、`/me/wallet` 導回 `/me`。點數紀錄**不回 note**(店家手打內部說明)、不回 balance_after,排序在資料庫做;推薦類型跟 `REFERRAL_UI_HIDDEN` 切換成「活動贈點」。
- 我的資料:手機不能改;**生日填過就鎖**(防改生日領生日禮,使用者 Q3);`members.address`(≤200)。`update_member` 第 8 參數 `p_address`:**null = 不變、空字串 = 清掉**(匯入/復原用 7 參數不會洗掉地址),後台編輯一律帶這個參數。
- 後台:訂單詳細已取消的單顯示「取消原因：〇〇」;「最後修改」是客人帳號時依操作紀錄 `actor_role_snapshot='customer'` 顯示「客人」(`get_booking_actor_names` 查不到人會回「(已移除的人員)」字樣,要當成查不到)。
- 鈴鐺 `customer_booking_cancelled`(同交易寫,收件人規則同 `customer_booking_created`);推播 `booking_cancelled` + `skipInAppNotification`。
- 第 5 批接點:LINE 通知客人「已取消」接在 Edge 推播旁邊。

## 第 4-B 批 多位聯絡人(2026-10-09,commit 579250e,#1041)
- 一位會員可有多個客戶帳號(聯絡人):表 `member_customer_contacts`(+ `member_contact_invites`、`member_contact_requests`、`member_contact_invite_claims`),全部 RLS 開、0 policy、只走函式。**`members.user_id / line_user_id / line_bound` 代表主要聯絡人,只能由 `private.member_sync_primary` 同步**;新增聯絡人只走 `private.member_contact_add`。
- 「客人是哪位會員」一律 `private.customer_member_of`(已改查聯絡人表);**新增客人函式不要直接比對 `members.user_id`**。
- 鎖順序:客戶帳號鎖(`c2_profile` 鍵)→ 會員列 `for update` → 申請/邀請列。任何會因「是不是主要」而分支的函式,鎖會員列後要**重讀身分**(QA 抓過:改自己電話與轉移主要並發)。
- 邀請碼:24 bytes 亂數、資料庫/登入暫存只存 SHA-256、72 小時一次性、每會員最多 5 個有效;LINE 登入走 `customer-line-login` `purpose:'invite'`,登入成功伺服器把邀請保留給該帳號 30 分鐘(`internal_customer_contact_invite_claim`),**complete 不回邀請碼**;前端進頁立刻 `history.replaceState` 拿掉。peek 同 IP 10 分鐘 30 次。
- 同電話已被別的帳號接上 ⇒ **送加入申請**(`join_pending`,取代第 2 批 phone_taken;被封鎖仍 phone_taken)。每帳號每店 1 筆待處理、每會員 5 筆,7 天過期(cron `member-contact-requests-expire-hourly` + 讀取時也判斷)。主要聯絡人或店家可同意/拒絕。
- 移除聯絡人(主要或店家)= 封鎖(要店家「允許重新接上」);自己退出不封鎖;解除 LINE 綁定 = 清全部聯絡人並封鎖;跨店搬會員清聯絡人(`removed_via='transfer'`,不封鎖)。這三個確認窗用危險樣式。
- 第二聯絡人電話(使用者 Q2=A):`create_member / update_member / reactivate_member` 用 `assert_phone_not_member_contact` 擋(hint `phone_is_member_contact`);`get_members_by_phone` 回 `matched_contact_phone`;會員列表另呼叫 `search_members_by_contact_phone`;`preview_booking_points` 回 `member_contact`(紅利區塊黃 ! 提示)但 **`resolve_booking_member_by_phone` / `resolve_edit_booking_member` 不認聯絡人電話,建單沒選會員就被擋**;訪客預約(`resolve_guest_member`)直接掛那位會員。
- 會被交易內刪索引的測試(c3_submit_booking A03-38、module10_09)打到的輔助函式要寫 plpgsql,不要寫成可內聯的 SQL 函式(否則快取計畫報「could not open relation with OID」)。
- 第 5 批接點:通知主要聯絡人「有人申請」、通知聯絡人「已被移除」,目前只有會員中心/鈴鐺看得到。

## 第 5-A 批 LINE 通知客人(2026-10-09,commit f54b02e,#1046)
- 流程:bookings trigger `bookings_enqueue_customer_line`(AFTER INSERT / UPDATE OF status, start_at)→ `private.enqueue_customer_line` 寫 `customer_line_outbox` → cron `customer-line-dispatch-every-minute` 帶 `X-Cron-Secret`(Vault `customer_line_cron_secret`,Edge secret `CUSTOMER_LINE_CRON_SECRET` 同值)→ Edge `customer-line-notify-dispatch`(verify_jwt=false)claim(`for update skip locked`)/ prepare / finish。Vault 沒密鑰時 cron 不呼叫,待發停在 pending。
- **新增會改 bookings 狀態/時間的函式,一定要設 `last_modified_by_user_id`**(trigger 靠它判斷客人/店家);服務人員端函式要設交易內 GUC `miaoyue.staff_order_actor`(優先於帳號判斷,服務人員操作不通知客人)。匯入(source=import)不發。
- 改時間合併:pending 列只延後 send_after、保留第一次的 old_start_at;前一則 processing 中又改 ⇒ 另寫一則(dedupe_key 加 `:after:<id>`,3 分鐘後,old_start_at = 這次改前時間)。發送時時間已改回 ⇒ 不發。
- 重試 1/5/15 分、共 4 次;LINE retry key 由 outbox id + 收件人算,409 當成功;已寫過紀錄的收件人不重發。卡 processing 10 分鐘放回(`claimed_at`)。
- 收件人 = 該會員開著「預約通知」的聯絡人;已知非好友(webhook unfollow)略過不扣則數;客人函式回應不得含 LINE userId / token。
- 模組 11 不再發會員:`resolve_line_notification_targets` 拿掉 notify_member 段、`line-notify-dispatch` Edge 也濾 `type:'member'`(verify_jwt 維持 true)。`get_line_notification_log` 是 5 參數(`p_category`),會員列 target_line_user_id 一律 null。
- 預設範本只存 DB(`get_customer_line_settings` 回 default_templates);「（預計抵達時間）」只加在時間獨立一行的範本。「恢復預設」與清空文字儲存都要確認窗(danger)。
- 5-A 刻意未做(5-B):提醒、完成、聯絡人通知(S03)、每月上限、80% 鈴鐺、用量查詢;**優惠通知開關 `src/lib/customerLinePromo.ts` `PROMO_SWITCH_VISIBLE=false`,5-B 行銷/生日照開關發時改 true**(客人端與後台聯絡人卡共用)。5-B 種類進清單 dispatcher 會標 skipped。
- 已知風險:集團多店共用官方帳號 webhook 查詢失敗;LINE 登入 channel 與官方帳號不同 Provider 時 push failed;LINE 429 分辨月額度靠 message 文字,待真 LINE 實測。

## 前端(`src/modules/public-booking/`)
- 不套後台外殼、不需登入;已登入後台的人打開也看客人版,不帶自己商家資料。主題色依該預約頁商家,離開要還原。
- ①~⑤ 同一網址內切換,系統「上一頁」= 上一步(history state);填的資料**不存瀏覽器**,重新整理回 ①。
- 不能按的按鈕上方常駐黃色 ! 說原因(ui-overlay-patterns 二之三)。數量單位「份」(不用冷氣業的「台」)。
- 文字一律純文字顯示(不用 dangerouslySetInnerHTML)。
- 推薦畫面總開關 `src/modules/members/referralVisibility.ts` 的 `REFERRAL_UI_HIDDEN`(#1037):紅利推薦分頁、會員詳細頁推薦碼/名單、新增會員推薦人、列表推薦碼、編輯視窗推薦人、功能卡片字樣、搜尋提示都吃這個;匯入/匯出、資料庫、獎勵邏輯不動。相關測試改成「開關關掉才驗」,不刪測試。

## 已知限制 / 待辦
- 「下一週」停用靠前端推斷(函式不回傳最遠日);不指定且各人範圍有空檔時可能提早停用。
- `types.ts` 裡 `get_public_available_slots` 的 `p_staff_id` 是手改成 `string | null`,重新產生型別會被蓋掉。

## 測試
- pgTAP:`c1_public_booking_page.sql`(白名單、哨兵)、`c1_public_available_slots.sql`(B 區、等價、效能)、`c1_function_acl_hardening.sql`(權限)。
- e2e-local:`c1-public-booking-page.spec.ts`(含攔截 `/rest/v1/rpc/` 原文搜哨兵)、`c1-merchant-online-booking-settings.spec.ts`;fixture `e2e-local/support/c1-public-booking-fixture.ts`。
