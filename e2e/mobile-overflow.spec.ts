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
import { devices, expect, test, type Page } from "@playwright/test";

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

/** 檢查目前頁面有沒有「需要左右滑動才能看完整」的橫向溢出。用完整的頁面/元件描述當作
 * 斷言訊息的一部分,測試失敗時終端機輸出能直接看出是哪個頁面/彈窗出包,不用另外猜。
 *
 * **重點技術細節,寫這份測試時實測踩到的坑,務必保留這段說明**:規格書原本只要求檢查
 * `document.documentElement.scrollWidth <= window.innerWidth`。但實測發現,這個檢查方式
 * 對「彈窗/對話框」(`Dialog`,底層是 `position: fixed`)完全測不出來——用還沒修的
 * `CalendarPage.tsx` 版本實際重現過:客戶欄位的 `<span>` 明明已經撐到
 * `getBoundingClientRect().right` 超過 700px(在 375px 寬的畫面上,肉眼看是明顯被裁切/需要
 * 撐開才看得到全部文字),但 `document.documentElement.scrollWidth` 卻仍然精確等於 375,
 * 完全沒有反映這個溢出。原因是 CSS 的固定定位(`position: fixed`)元素是相對於
 * viewport(而不是 `<html>`)定位的,它的子孫溢出不會被算進 `<html>` 自己的可捲動範圍——
 * 但那個彈窗元素「自己」的 `scrollWidth`(相對於它自己的 `clientWidth`)完全正確反映了
 * 溢出(實測 `scrollWidth: 721` vs `clientWidth: 373`)。所以這裡除了規格書原本要求的
 * document 層級檢查,**額外加上「目前畫面上如果有開啟中的對話框,也檢查那個對話框元素自己
 * 的 scrollWidth」**,兩者都要通過,測試才會對彈窗類型的溢出真的有效——不然會變成一份
 * 「看起來有測試、實際上永遠會過」的假測試,對彈窗类型的 bug 完全沒有防護力。 */
async function assertNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const result = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'));
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      dialogs: dialogs.map((el) => ({ scrollWidth: el.scrollWidth })),
    };
  });
  expect(
    result.scrollWidth,
    `[${label}] document.documentElement.scrollWidth(${result.scrollWidth}) 超出 window.innerWidth(${result.innerWidth})` +
      `(容許 1px 誤差)——代表這個頁面在 375px 寬的手機螢幕上需要左右滑動才能看完整。`,
  ).toBeLessThanOrEqual(result.innerWidth + 1);

  result.dialogs.forEach((dialog, index) => {
    expect(
      dialog.scrollWidth,
      `[${label}] 第 ${index + 1} 個對話框(role="dialog")的 scrollWidth(${dialog.scrollWidth}) 超出` +
        ` window.innerWidth(${result.innerWidth})(容許 1px 誤差)——彈窗內有內容撐開超出 375px 寬的手機螢幕。`,
    ).toBeLessThanOrEqual(result.innerWidth + 1);
  });

  await assertNoElementOverflow(page, label);
}

/** 編號 190 新增:不透過任何預先猜測的選取器,直接掃描目前畫面上「每一個」元素,比較它
 * 自己的 `scrollWidth` 跟 `clientWidth`——這是唯一能抓到「溢出被相鄰元素視覺蓋住、但沒有撐大
 * 頁面或彈窗整體寬度」這種變體的方式(見檔案開頭「編號 190 追加的第四種偵測方式」說明)。
 *
 * 排除規則,逐項都有實際理由,不是隨便加的:
 * - `INPUT`/`TEXTAREA`/`SELECT`/`OPTION`:表單欄位本身對「內容比欄框寬」有瀏覽器原生的
 *   內部捲動行為(例如打長字的 `<input>`),這是正常的輸入框行為,不是這次要抓的排版 bug。
 * - `SCRIPT`/`STYLE`/`SVG`/`PATH`/`IFRAME`:非可視文字內容元素,量測沒有意義。
 * - `clientWidth <= 4`:排除 shadcn/Radix 大量使用的「螢幕閱讀器專用/視覺隱藏」元素
 *   (例如 `sr-only`,故意把元素縮到 1px 見方再用 `overflow:hidden` 塞進完整文字內容,
 *   這是刻意的無障礙設計,scrollWidth 遠大於 clientWidth 是正常且必要的,不是 bug)。
 * - `overflow-x: auto`/`scroll`:刻意設計成「可以左右滑」的容器(例如比較寬的表格/格線),
 *   這是有意的設計,不是規格書要抓的「應該要換行卻沒換行」問題。
 * - `text-overflow: ellipsis`(對應 Tailwind 的 `truncate`):刻意單行省略號,是規格書
 *   明確認可的其中一種修法,不應該被判定為 bug。
 */
async function assertNoElementOverflow(page: Page, label: string): Promise<void> {
  const overflowing = await page.evaluate(() => {
    const found: Array<{
      tag: string;
      classes: string;
      text: string;
      scrollWidth: number;
      clientWidth: number;
    }> = [];
    document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
      const tag = el.tagName;
      if (
        [
          "SCRIPT",
          "STYLE",
          "SVG",
          "PATH",
          "IFRAME",
          "INPUT",
          "TEXTAREA",
          "SELECT",
          "OPTION",
        ].includes(tag)
      ) {
        return;
      }
      if (el.clientWidth <= 4) return;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return;
      if (style.overflowX === "auto" || style.overflowX === "scroll") return;
      if (style.textOverflow === "ellipsis") return;
      // 這個元素本身故意比某個「可橫向捲動」的祖先還寬(例如行事曆週檢視格線:外層
      // `overflow-x-auto` 容器裡放一個 `min-w-[640px]` 的內容 div,讓使用者橫向滑動看完整
      // 格線)——這是刻意的設計,不是「文字沒換行撐開容器」的排版 bug,往上找到任何一層
      // 祖先有 `overflow-x: auto`/`scroll` 就跳過,不誤判。
      let ancestor = el.parentElement;
      let hasScrollableAncestor = false;
      while (ancestor) {
        const ancestorOverflowX = window.getComputedStyle(ancestor).overflowX;
        if (ancestorOverflowX === "auto" || ancestorOverflowX === "scroll") {
          hasScrollableAncestor = true;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      if (hasScrollableAncestor) return;
      if (el.scrollWidth > el.clientWidth + 1) {
        found.push({
          tag,
          classes: el.className ? String(el.className).slice(0, 100) : "",
          text: (el.textContent ?? "").trim().slice(0, 60),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    });
    return found;
  });

  expect(
    overflowing,
    `[${label}] 發現 ${overflowing.length} 個元素自己的 scrollWidth 超出 clientWidth(容許 1px 誤差)` +
      `——即使沒有撐大整個頁面或彈窗的寬度,這些元素的內容也比自己的版位還寬,實際畫面上很可能被` +
      `相鄰元素蓋住、看不到完整內容:\n${JSON.stringify(overflowing, null, 2)}`,
  ).toEqual([]);
}

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

  // **已知既有問題,跟這次修正主題無關,不在這次任務範圍內修**(發現後回報主腦,不是這次
  // 順手改的):`RequireMerchantAdmin`(以及可能其他用同一種寫法的頁面守衛)在「這個瀏覽器
  // 從來沒有選過商家」時,有機會在 `currentMerchantId` 還沒被 context.tsx 的 fallback effect
  // 寫進 localStorage 前,就先讀到 `merchant === null` 而誤判成「沒有商家/不是管理員」、
  // 直接把使用者導回 `/app`——實測會在全新瀏覽器 session 直接深連結到 `/app/settings` 等
  // 受保護頁面時重現。這裡先訪問一次 `/app` 讓「目前操作中商家」正確寫進 localStorage,
  // 之後同一個瀏覽器 context 內再訪問其他頁面就不會再踩到這個 race,不影響這次要測的
  // 「容器寬度會不會溢出」這個主題。
  await page.goto("/app");
  await expect(page.getByText("目前操作中的商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
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
    await expect(page.getByText("集團與商家")).toBeVisible({ timeout: LOAD_TIMEOUT });
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
