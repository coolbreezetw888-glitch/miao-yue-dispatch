// SPECS-INDEX #756/#761(規格書 .project/specs/手機推播擴及三種角色.md §13.6 / §十之二):
// **手機頁首版面預算的守門員。**
//
// 🔴 為什麼一定要獨立成這一支檔案,不塞進既有的 e2e/mobile-overflow.spec.ts:
//    既有那支抓不到 320px 的退步,兩個原因(已實際讀過它的程式碼確認):
//      ① 它跑的是 **375px**(iPhone SE 3rd gen),不是 320px;
//      ② 它的 assertNoElementOverflow() 明文**排除 `text-overflow: ellipsis` 的元素**
//         (原文:「刻意單行省略號,是規格書明確認可的其中一種修法,不應該被判定為 bug」),
//         而頁首標題正是 `truncate`。
//    ⇒ **「頁首標題被截成省略號」這件事會安靜地發生,沒有任何既有測試會紅。** 這支就是那個會紅的東西。
//
// 之後任何人往頁首加東西(再一顆按鈕、一個徽章、一段文字),都應該回來跑這一支。
//
// ⚠️ 320px 是目前市面上還在用的最窄手機寬度(iPhone SE 1st gen / 部分 Android)。刻意用
//    Playwright 的手機模擬旗標(isMobile/hasTouch),不是單純把桌面視窗改窄 ——
//    e2e/mobile-overflow.spec.ts 檔頭記錄過:純改視窗寬度時 `position: fixed` 元素的溢出
//    不會反映在 `document.documentElement.scrollWidth` 上,會做出一份永遠會過的假測試。
import { expect, test } from "@playwright/test";

import {
  injectAppHeaderFixtureSession,
  setupAppHeaderFixture,
  teardownAppHeaderFixture,
  type AppHeaderFixture,
} from "./support/app-header-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

/** §13.6:目前全系統最長的頁首標題,對應 /app/leave-types(appLayoutLogic.ts 的標題規則)。 */
const LONGEST_HEADER_TITLE = "月薪人員假別設定";

const NARROW_VIEWPORT = { width: 320, height: 568 };
const LOAD_TIMEOUT = 20_000;

test.use({
  viewport: NARROW_VIEWPORT,
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
});

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: AppHeaderFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupAppHeaderFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[app-header-320] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownAppHeaderFixture(fixture);
  console.log("[app-header-320] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectAppHeaderFixtureSession(page, fixture);
  // 先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage(見 e2e/support/app-shell.ts)。
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
});

async function measureHeader(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const title = document.querySelector('[data-testid="app-header-title"]');
    const row = title?.parentElement ?? null;
    return {
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      titleClientWidth: title ? (title as HTMLElement).clientWidth : -1,
      titleScrollWidth: title ? (title as HTMLElement).scrollWidth : -1,
      rowWidth: row ? (row as HTMLElement).clientWidth : -1,
    };
  });
}

test("§13.6 斷言①:320px 下載入 /app,文件不產生橫向捲軸", async ({ page }) => {
  const metrics = await measureHeader(page);
  console.log("[app-header-320] /app 量測:", JSON.stringify(metrics));
  // 前提斷言:確認真的是 320px 的視窗在跑(不是設定沒生效導致下面全部形式上通過)。
  expect(metrics.innerWidth).toBe(NARROW_VIEWPORT.width);
  // 容許 1px 誤差,比照 e2e/support/overflow-assert.ts 的既有慣例。
  expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
});

test("§13.6 斷言②:鈴鐺與登出按鈕在 320px 下都看得到、都按得到", async ({ page }) => {
  const bell = page.getByTestId("notification-bell");
  const signOut = page.getByRole("button", { name: "登出" });

  await expect(bell).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(signOut).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 「看得到」不等於「按得到」:兩顆都要真的有版位、而且沒有被別的元素蓋掉。
  const bellBox = await bell.boundingBox();
  const signOutBox = await signOut.boundingBox();
  expect(bellBox).not.toBeNull();
  expect(signOutBox).not.toBeNull();
  expect(bellBox!.width).toBeGreaterThan(0);
  expect(signOutBox!.width).toBeGreaterThan(0);
  // DOM 順序即視覺順序:鈴鐺在登出**左邊**(使用者原話「登出的左側」)。
  expect(bellBox!.x).toBeLessThan(signOutBox!.x);
  // §13.6 第 3 點:鈴鐺尺寸對齊登出按鈕(都是 32px 高),不是 Button size="icon" 的 36px。
  expect(Math.round(bellBox!.height)).toBe(32);
  expect(Math.round(signOutBox!.height)).toBe(32);

  // 真的按得到:點下去面板要打開(不是被蓋住吃掉點擊)。
  await bell.click();
  await expect(page.getByTestId("notification-panel")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("🔴 §13.6 斷言③:最長的頁首標題「月薪人員假別設定」在 320px 下**沒有被截成省略號**", async ({
  page,
}) => {
  await page.goto("/app/leave-types");
  const title = page.getByTestId("app-header-title");
  await expect(title).toHaveText(LONGEST_HEADER_TITLE, { timeout: LOAD_TIMEOUT });

  const metrics = await measureHeader(page);
  console.log("[app-header-320] /app/leave-types 量測:", JSON.stringify(metrics));

  // 前提斷言:標題真的量到了(沒量到會是 -1,那時候下面的比較會形式上通過)。
  expect(metrics.titleClientWidth).toBeGreaterThan(0);
  // 真正要驗的:這個 <p> 是 `truncate`,內容寬度超過可視寬度就會被截成省略號 ——
  // scrollWidth <= clientWidth 代表沒有被截。
  expect(metrics.titleScrollWidth).toBeLessThanOrEqual(metrics.titleClientWidth);
  // 順便守住文件層級不溢出(換頁之後也要成立)。
  expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
});

test("§13.7:320px 下打開通知面板之後,文件仍然沒有橫向捲軸", async ({ page }) => {
  await page.getByTestId("notification-bell").click();
  await expect(page.getByTestId("notification-panel")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const metrics = await page.evaluate(() => ({
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    panelWidth: (
      document.querySelector('[data-testid="notification-panel"]') as HTMLElement | null
    )?.getBoundingClientRect().width,
  }));
  console.log("[app-header-320] 面板打開後量測:", JSON.stringify(metrics));

  // 前提斷言:面板真的有寬度(沒渲染出來的話下面的比較毫無意義)。
  expect(metrics.panelWidth).toBeGreaterThan(0);
  // §13.7:w-[calc(100vw-1.5rem)] max-w-sm ⇒ 320px 下是 296px,不會撐出捲軸。
  expect(metrics.panelWidth!).toBeLessThanOrEqual(metrics.innerWidth);
  expect(metrics.docScrollWidth).toBeLessThanOrEqual(metrics.innerWidth + 1);
});
