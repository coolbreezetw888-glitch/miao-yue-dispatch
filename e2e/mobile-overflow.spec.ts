// 手機版容器寬度溢出修正(.project/specs/手機版容器寬度溢出修正.md 第三節)——
// 永久留在自動化測試框架裡的回歸測試:用 375×667(iPhone SE 尺寸)瀏覽過主要頁面/彈窗,
// 每個頁面/彈窗開啟後檢查 `document.documentElement.scrollWidth <= window.innerWidth`
// (容許 1px 誤差),不成立就讓測試失敗並印出是哪個頁面/元件。
//
// 這個 bug 過去已經以同樣的模式出現三次(BusinessHoursPage.tsx、MerchantAdminList.tsx、
// 這次的 CalendarPage.tsx BookingDetailDialog):`flex items-center justify-between` 的
// 兩欄式資訊列,右側的值沒有 `min-w-0`/`break-words`,遇到長文字(長 email、長地址、長電話
// 號碼組合字串)時撐開整個容器,超出手機螢幕。這裡故意用「長串不含空白的數字/英文」當測試
// 資料(見 e2e/support/mobile-overflow-fixture.ts 開頭說明),不是短字串或純中文——中日韓文字
// 預設就能逐字換行,測不出這個 bug。
//
// **編號 190 追加的第四種偵測方式,務必保留**:QA 這次抓到一種先前完全漏測的變體——
// `ServiceItemsPage.tsx` 服務項目卡片的 metadata 行(`<p>${金額} ・ {類型} ・ {工時} 分鐘 ・
// {分類名稱}</p>`),長分類名稱撐出這個 `<p>` 自己的版位、視覺上被右側「編輯/下架」按鈕蓋住,
// 但因為這個 `<p>` 是 `flex` 容器裡「已經有 `min-w-0`」的那個子元素內部的區塊元素,它的溢出
// 只在自己的版位裡蓋住相鄰元素,不會撐大 `<li>`、更不會撐大整個頁面,連
// `document.documentElement.scrollWidth` 也測不出來——原本只檢查 document 層級跟
// `[role="dialog"]` 層級,兩者都測不到這一類 bug。因此這裡新增
// `assertNoElementOverflow()`:對整個頁面(不限彈窗)掃描每一個元素,直接比較該元素「自己的」
// `scrollWidth` 跟 `clientWidth`,不透過任何預先猜測的 CSS class 或選取器去找可疑元素——
// 這樣以後任何頁面新增同類寫法(不管是不是 `flex items-center justify-between`)都會被抓到,
// 不需要每次出現新變體就手動加一種新的偵測邏輯。**已用「先重現失敗、修完再驗證通過」驗證過**:
// 見交付報告或 git 紀錄裡「暫時還原 ServiceItemsPage.tsx 這行的 break-words」重新跑一次測試的紀錄。
//
// 資料怎麼來:e2e/support/mobile-overflow-fixture.ts 用真實 signUp() + 真正的 RPC/資料表操作,
// 對正式 Supabase 專案建立一組全新測試帳號+測試商家(名稱/email 都用 `e2e-mobile-overflow-`
// 開頭清楚標記,不會跟真實商家「涼風工匠」「美甲」或真實帳號搞混)。**已知限制**:這個專案的
// 商家/服務人員/服務項目/預約都刻意只做軟刪除(規則:分店只能停用不能真刪除),所以
// teardown 只能做到軟停用/軟移除,沒辦法把底層資料列從資料庫整個刪乾淨——這件事需要有
// 資料庫直接存取權限的人定期手動清理,細節見 fixture 檔案開頭的完整說明。
import { devices, expect, test } from "@playwright/test";

import {
  injectFixtureSession,
  injectSessionForCredentials,
  LONG_CATEGORY_NAME,
  LONG_CUSTOMER_NAME,
  LONG_CUSTOMER_NAME_PREFIX,
  LONG_MATERIAL_NAME,
  LONG_SERVICE_NAME,
  LONG_STAFF_NAME_PREFIX,
  setupMobileOverflowFixture,
  teardownMobileOverflowFixture,
  type MobileOverflowFixture,
} from "./support/mobile-overflow-fixture";
import { primeCurrentMerchant } from "./support/app-shell";
import { assertNoHorizontalOverflow } from "./support/overflow-assert";

// **重要,踩過的坑**:光是 `page.setViewportSize({width:375,...})` 不夠——那只是把桌面版
// Chromium 的視窗改窄,不會套用 `isMobile`/`hasTouch` 這些手機模擬旗標。實測發現,Radix
// Dialog(`position: fixed`)裡的內容撐寬到超出 375px 時,在「純改視窗寬度」的桌面模式下,
// `document.documentElement.scrollWidth` 完全不會反映這個溢出(fixed 定位元素的溢出不會
// 撐大文件捲動範圍)——會導致測試在真的有 bug 的版本上也「測不出來」,變成一份看起來有測試、
// 實際上永遠會過的假測試。改用 Playwright 內建的「iPhone SE (3rd gen)」裝置描述(375×667,
// 含 isMobile/hasTouch)比照使用者原始回報的「F12 手機模擬檢視」,才會讓瀏覽器真的用手機版
// 版面引擎計算(這時 fixed 定位元素的溢出才會正確反映在 scrollWidth 上)。
// 刻意不整包 spread(`...devices[...]`)、只挑需要的欄位:裝置描述裡的 `defaultBrowserType:
// "webkit"` 會被 test.use() 讀到而嘗試切換去啟動 webkit(這台機器 / CI 只裝了 chromium,
// playwright.config.ts 也只設定了 chromium 這個 project),整包 spread 進來會導致
// `browserType.launch: Executable doesn't exist ... webkit ...` 直接炸掉。
const IPHONE_SE_3RD_GEN = devices["iPhone SE (3rd gen)"];
test.use({
  viewport: IPHONE_SE_3RD_GEN.viewport,
  userAgent: IPHONE_SE_3RD_GEN.userAgent,
  deviceScaleFactor: IPHONE_SE_3RD_GEN.deviceScaleFactor,
  isMobile: IPHONE_SE_3RD_GEN.isMobile,
  hasTouch: IPHONE_SE_3RD_GEN.hasTouch,
});

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

// ⚠️ assertNoHorizontalOverflow() / assertNoElementOverflow() 原本寫在這個檔案裡。
//    2026-09-25 規格書「超級管理員商家詳情強化」#710 要求新的
//    e2e/platform-admin-merchant-detail.spec.ts 複用同一個助手(而不是再抄一份),
//    所以整段原封不動搬到 e2e/support/overflow-assert.ts 對外 export,邏輯一個字沒改。
//    那個檔案裡保留了完整的技術說明(為什麼要額外量 dialog 自己的 scrollWidth、
//    每一條排除規則的理由),要改這兩支函式之前務必先讀那段註解。

let fixture: MobileOverflowFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupMobileOverflowFixture();
  } catch (err) {
    setupFailed = true;

    console.error("[mobile-overflow] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownMobileOverflowFixture(fixture);

  console.log("[mobile-overflow] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectFixtureSession(page, fixture);

  // 啟動步驟:先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage,避免後面直接深連結
  // 到受保護頁面時被 Require*Access 守衛誤判導回 /app。為什麼是這個頁面/這個錨點,見
  // e2e/support/app-shell.ts 的完整說明。
  await primeCurrentMerchant(page);
});

test("首頁 /app", async ({ page }) => {
  await assertNoHorizontalOverflow(page, "首頁 /app");
});

test("商家設定頁(含管理員名單)/app/settings", async ({ page }) => {
  await page.goto("/app/settings");
  // 管理員名單只有目前登入的這個 fixture 帳號一筆,email 本身就刻意夠長(70+ 字元)。
  await expect(page.getByText(fixture.email)).toBeVisible({ timeout: LOAD_TIMEOUT });
  await assertNoHorizontalOverflow(page, "商家設定頁 /app/settings");
});

test("人員管理頁 /app/staff", async ({ page }) => {
  await page.goto("/app/staff");
  await expect(page.getByText(LONG_STAFF_NAME_PREFIX, { exact: false }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await assertNoHorizontalOverflow(page, "人員管理頁 /app/staff(清單)");

  const staffRow = page.locator("li", { hasText: LONG_STAFF_NAME_PREFIX });
  await staffRow.getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertNoHorizontalOverflow(page, "人員管理頁 /app/staff(編輯服務人員對話框)");
  await page.keyboard.press("Escape");
});

test("服務項目管理頁 /app/service-items", async ({ page }) => {
  await page.goto("/app/service-items");
  await expect(page.getByText(LONG_SERVICE_NAME, { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // .first():分類名稱同時出現在「分類管理」清單自己的一列,也會被服務項目卡片的
  // 「金額 ・ 類型 ・ 時長 ・ 分類名稱」這行 metadata 文字重複引用一次,兩處都要有,
  // 只是這裡只需要確認至少可見一次。
  await expect(page.getByText(LONG_CATEGORY_NAME, { exact: false }).first()).toBeVisible();
  await assertNoHorizontalOverflow(page, "服務項目管理頁 /app/service-items(清單,含分類)");

  await page.getByRole("button", { name: "新增服務項目" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertNoHorizontalOverflow(page, "服務項目管理頁(新增服務項目對話框)");
  await page.keyboard.press("Escape");
});

test("料錢成本管理頁 /app/material-costs", async ({ page }) => {
  await page.goto("/app/material-costs");
  await expect(page.getByText(LONG_MATERIAL_NAME, { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await assertNoHorizontalOverflow(page, "料錢成本管理頁 /app/material-costs(清單)");

  await page.getByRole("button", { name: "新增品項" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertNoHorizontalOverflow(page, "料錢成本管理頁(新增品項對話框)");
  await page.keyboard.press("Escape");
});

test("行事曆 /app/calendar(週/月檢視、預約詳情、編輯、新增預約)", async ({ page }) => {
  await page.goto("/app/calendar");
  await expect(page.getByRole("button", { name: "週檢視" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  // SPECS-INDEX #640:行事曆預設改成先顯示月檢視,這裡接下來要測的是週檢視底下的服務人員
  // 時間軸格線,所以先手動切回週檢視,不能再假設進頁面時預設就是週檢視。
  await page.getByRole("button", { name: "週檢視" }).click();
  // 等格線真的渲染出服務人員欄位(營業時間已經整週開放,格線應該出現,不是「尚未設定」訊息)。
  await expect(page.getByText(LONG_STAFF_NAME_PREFIX, { exact: false }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await assertNoHorizontalOverflow(page, "行事曆 /app/calendar(週檢視格線)");

  // 點擊預約色塊(客戶姓名開頭)開啟預約詳情彈窗——同一筆預約會同時出現在主要服務人員跟助手
  // 兩欄,用 .first() 避免「找到兩個符合的按鈕」的錯誤,點哪一個都會開到同一筆預約。
  await page
    .getByRole("button", { name: new RegExp(LONG_CUSTOMER_NAME_PREFIX) })
    .first()
    .click();
  await expect(page.getByText("預約詳情")).toBeVisible();
  // 等真正的預約內容(getBooking 查詢)載入完成,不能只等對話框標題出現就檢查——標題是
  // 靜態文字,查詢還沒 resolve 前內容區只會顯示「載入中⋯」,太早檢查會誤判成「沒有溢出」。
  await expect(
    page.getByRole("dialog").getByText(LONG_CUSTOMER_NAME_PREFIX, { exact: false }),
  ).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await assertNoHorizontalOverflow(page, "行事曆(預約詳情彈窗 BookingDetailDialog)");

  // 從詳情彈窗點「編輯」,切換成編輯表單(帶入既有資料)。同樣要等 getBooking 查詢真的把
  // 客戶姓名帶進輸入框(用 toHaveValue,不是 getByText——這是 <input> 的 value,不是文字節點)。
  await page.getByRole("dialog").getByRole("button", { name: "編輯" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "編輯預約" })).toBeVisible();
  await expect(page.locator("#booking-customer-name")).toHaveValue(LONG_CUSTOMER_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await assertNoHorizontalOverflow(page, "行事曆(編輯預約表單彈窗)");
  await page.keyboard.press("Escape");

  // 新增預約表單(空白建單)。頁面上「新增預約」同時是觸發按鈕跟對話框標題的文字,
  // 用 getByRole("dialog") 範圍限定只比對對話框裡的標題,避免兩個都符合的錯誤。等服務項目
  // 清單(含長名稱那項)真的載入完成再檢查,不是只等對話框標題出現。
  await page.getByRole("button", { name: "新增預約" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "新增預約" })).toBeVisible();
  await expect(page.getByRole("dialog").getByText(LONG_SERVICE_NAME, { exact: false })).toBeVisible(
    { timeout: LOAD_TIMEOUT },
  );
  await assertNoHorizontalOverflow(page, "行事曆(新增預約表單彈窗)");
  await page.keyboard.press("Escape");

  // 月檢視。
  await page.getByRole("button", { name: "月檢視" }).click();
  await expect(page.getByRole("button", { name: "上一月" })).toBeVisible();
  await assertNoHorizontalOverflow(page, "行事曆(月檢視)");
});

// 訂單管理頁 /app/orders —— 2026-09-24 新增,補上這份測試檔原本完全沒有涵蓋的一頁。
//
// 為什麼這一頁要補進來(不是「順便多測一頁」):這一頁剛從「只渲染最新 500 筆」改成真正的分頁
// (見 src/modules/booking/ordersPageLogic.ts sliceBookingsForPage 的說明),新增了一組分頁控制項
// (每頁筆數下拉 + 上一頁/「N / M」/下一頁),清單前後各一組。這組控制項當初只用 Tailwind 的
// `flex-wrap` + 固定寬度「推算」375px 下不會溢出,沒有真的在手機尺寸瀏覽器跑過——而這份規格書
// (.project/specs/手機版容器寬度溢出修正.md 第三節)要求的就是「不要再靠肉眼/推算,要有長期
// 執行的自動化測試」。這一頁沒被涵蓋,等於這組新控制項完全沒有防護。
//
// **為什麼不需要為了讓分頁器出現而多建 50 筆訂單**(這點很重要,不要以為是偷懒):OrdersPage.tsx
// 渲染分頁器的條件是 `totalCount > 0`,**不是** `totalPages > 1`——只要有一筆訂單,上下兩組
// 分頁器就都會渲染出來(顯示「1 / 1」,上一頁/下一頁兩顆都是 disabled 狀態,但版位、按鈕、
// 下拉都是完整的真實尺寸)。所以既有 fixture 建的那一筆預約就足以讓整組控制項上畫面被量到,
// 不必為了測排版去建 51 筆訂單(這個專案的 bookings 只有軟刪除、沒有 DELETE 政策,每多建一筆
// 就是在正式 Supabase 專案裡多留一列永久殘留資料,見 mobile-overflow-fixture.ts 開頭的已知限制)。
//
// **這支測試不是「永遠會過」的假測試,已經用負面對照實測過**(規格書第四節第 3 點的要求):
// 把 OrdersPager 根容器的 `flex-wrap` 暫時改成 `flex-nowrap` 重跑這一支,測試確實失敗,並印出
// 實測數字——分頁器那一列的 `scrollWidth: 349` vs `clientWidth: 335`(上下兩組都各報一次),
// 右側那一組(上一頁+頁碼+下一頁)自己是 `scrollWidth: 216` vs `clientWidth: 202`。改回
// `flex-wrap` 後同一支測試通過。這組數字有兩個重要含意,留在這裡給以後改這個元件的人參考:
//   ① `flex-wrap` 在這裡**不是**可有可無的保險:整組控制項的自然寬度是 349px,而 375px 螢幕扣掉
//      頁面左右 `px-5` 之後可用寬度只有 335px,少 14px——也就是說在 375px 下這組控制項**一定會**
//      換成上下兩行(不是「剛好塞得下」)。誰把 flex-wrap 拿掉,這一頁就會立刻需要左右滑動。
//   ② 換行之後每一行都還很寬鬆:右側那組自然寬度 216px,可用 335px,還有 119px 餘裕。
// **已知涵蓋範圍的界線,誠實記在這裡**:因此這支測試量到的頁碼文字是「1 / 1」,沒有真的量到
// 「12 / 120」這種較寬的多頁頁碼文字。以上面 ② 的實測餘裕推算,就算頁碼長到「20000 / 20000」
// (百萬筆訂單、每頁 50 筆的極端值,比「1 / 1」多 8 個半形字元,約 +56px)也還在 335px 之內;
// 但這是**推算,不是實測**,要連多頁狀態一起納入自動化保護,就得接受「fixture 要建滿超過一頁的
// 訂單」這個成本(bookings 只有軟刪除,每筆都會永久留在正式資料庫裡),那是主腦/使用者要裁決的
// 取捨,不是這支測試能自己決定的。
//
// 另外一併涵蓋規格書第三節「測試資料要用會撐開容器的極端值」的部分:訂單卡片會把
// 「服務人員 ・ 客戶姓名 ・ 客戶電話 ・ 客戶地址」串成一行顯示,fixture 的這筆預約本來就同時帶了
// 超長客戶姓名(LONG_CUSTOMER_NAME)、40 碼電話組合字串(LONG_PHONE_COMBO)跟含長網址的超長地址
// (LONG_ADDRESS),而且 fixture 商家是 on_site_dispatch(到府派工),客戶地址欄位在這一頁會真的
// 顯示出來(見 OrdersPage.tsx showCustomerAddress)——這正是最容易撐爆版面的那一行。
test("訂單管理頁 /app/orders(分頁控制項 + 長內容訂單卡片)", async ({ page }) => {
  await page.goto("/app/orders");

  // 等訂單卡片真的渲染出來(客戶姓名是卡片上的動態內容)。這一步不能只等頁面標題:分頁器的
  // 渲染條件是「已經有撈到訂單」,查詢還沒 resolve 前 totalCount 是 0、分頁器根本不存在,
  // 太早檢查會量到一個沒有分頁器的畫面,變成一份看起來有測、其實沒測到新控制項的假測試。
  await expect(page.getByText(LONG_CUSTOMER_NAME_PREFIX, { exact: false }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // 明確斷言「上下各一組分頁器都在畫面上」,理由同上——這是防止這支測試哪天因為分頁器沒渲染
  // 而「安靜地變成永遠會過」的守門條件,不是多餘的重複斷言。用 role=combobox + aria-label 定位
  // (combobox 是 Radix SelectTrigger 的 role,aria-label 見 OrdersPage.tsx OrdersPager 那顆
  // SelectTrigger);這一頁另一顆 Select(服務人員篩選)沒有這個名稱,不會被誤抓進來。
  const pageSizeSelects = page.getByRole("combobox", { name: "每頁顯示筆數" });
  await expect(pageSizeSelects).toHaveCount(2);
  await assertNoHorizontalOverflow(page, "訂單管理頁 /app/orders(預設每頁 50 筆,含上下兩組分頁器)");

  // 每頁筆數下拉展開後的選單(Radix SelectContent,portal 到 body 的浮層)也要量一次——
  // 浮層是這一頁唯一「不在主要文件流裡」的新元件,寬度來源跟底下的觸發按鈕不同。
  await pageSizeSelects.first().click();
  await expect(page.getByRole("option", { name: "500" })).toBeVisible();
  await assertNoHorizontalOverflow(page, "訂單管理頁(每頁筆數下拉展開)");

  // 切到最大的每頁筆數(500),觸發按鈕上的文字變成三位數、頁碼也會重算,再量一次。
  await page.getByRole("option", { name: "500" }).click();
  await expect(pageSizeSelects.first()).toContainText("500");
  await assertNoHorizontalOverflow(page, "訂單管理頁(每頁 500 筆)");
});

// ---------------------------------------------------------------------------
// 超級管理員後台:選用區塊,預設略過。
//
// platform_admins 這張表刻意沒有開放一般使用者自助寫入(見超級管理員後台規格書 2.8「超級
// 管理員本人種子資料不進版控」的設計精神——這張表的異動一律走人工 SQL,不是前端 client
// 呼叫範圍內能做的事),所以沒辦法在這支測試裡自動建立/清除一個「臨時的」平台管理員測試帳號。
//
// 如果要涵蓋這幾個頁面,需要先由有 Supabase 資料庫直接存取權限的人手動建立一個專用的、
// 長期保留的測試帳號並登記進 platform_admins,把帳密存進本機 .env(不要 commit):
//   E2E_PLATFORM_ADMIN_EMAIL=...
//   E2E_PLATFORM_ADMIN_PASSWORD=...
// 這是主腦/使用者需要確認是否要建立的一個長期 fixture(牽涉到 platform_admins 這張
// 敏感表格),這次交付先用臨時建立+立即刪除的方式人工驗證過 MerchantDetailPage.tsx 的修正
// 有效(見交付報告),沒有把這個帳號留在資料庫裡長期存在。
// ---------------------------------------------------------------------------
test.describe("超級管理員後台(選用,需要預先設定好的平台管理員測試帳號)", () => {
  const platformAdminEmail = process.env["E2E_PLATFORM_ADMIN_EMAIL"];
  const platformAdminPassword = process.env["E2E_PLATFORM_ADMIN_PASSWORD"];

  test.skip(
    !platformAdminEmail || !platformAdminPassword,
    "未設定 E2E_PLATFORM_ADMIN_EMAIL / E2E_PLATFORM_ADMIN_PASSWORD,略過超級管理員後台檢查" +
      "(見這個 describe 區塊開頭的完整說明)。",
  );

  test.beforeEach(async ({ page }) => {
    await injectSessionForCredentials(
      page,
      platformAdminEmail as string,
      platformAdminPassword as string,
    );
  });

  test("集團與商家總覽 /platform-admin", async ({ page }) => {
    await page.goto("/platform-admin");
    // ⚠️ 2026-09-25 改成 getByRole(heading):原本的 getByText("集團與商家") 是子字串比對,
    //    會同時命中 <h1>「集團與商家總覽」和副標「系統裡所有的集團與商家,可以篩選…」兩個
    //    元素,strict mode 下會直接報「resolved to 2 elements」。這個問題在副標文字還是舊版
    //    (「系統裡所有的集團與商家，可以篩選、可以啟用/停用任一間店」)時就已經存在,只是
    //    這個 describe 區塊平常被 test.skip 略過所以沒人發現。換成明確的 heading 比對即可。
    await expect(page.getByRole("heading", { name: "集團與商家總覽" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await assertNoHorizontalOverflow(page, "超級管理員後台 /platform-admin(總覽)");
  });

  test("商家詳情頁(含管理員名單)", async ({ page }) => {
    await page.goto(`/platform-admin/merchants/${fixture.merchantId}`);
    await expect(page.getByText(fixture.email)).toBeVisible({ timeout: LOAD_TIMEOUT });
    await assertNoHorizontalOverflow(page, "超級管理員後台(商家詳情頁,含管理員名單)");
  });

  test("產業預設功能組合編輯器 /platform-admin/industry-presets", async ({ page }) => {
    await page.goto("/platform-admin/industry-presets");
    await expect(page.getByRole("heading", { name: "產業預設功能組合" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await assertNoHorizontalOverflow(page, "超級管理員後台(產業預設功能組合編輯器)");
  });
});
