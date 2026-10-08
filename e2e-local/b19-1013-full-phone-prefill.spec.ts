// SPECS-INDEX #1013(第 19 批):新增預約輸入「完整」客戶電話時,也要能一鍵帶入既有客戶資料。
// 規格書 .project/specs/建單電話完整輸入無法帶入-第19批.md。
// 執行:`npm run test:e2e:local -- b19-1013`(playwright.local.config.ts;只連本機 Docker,Playwright 自己開
// 獨立的 headless Chromium,不碰使用者的瀏覽器)。不在預設 config 的 testDir 裡 ⇒ 不影響 123 條 / 22 檔基準。
//
//   1. 打滿會員甲的完整電話 ⇒「將連結既有客戶:甲」保留 + 清單只列甲 ⇒ 點了 ⇒ 姓名 / 電話帶入
//      (結果跟「打一半再點選」完全一樣)。
//   2. 打一半點選的舊流程不變。
//   3. 打滿一個不存在的號碼 ⇒ 沒有清單、沒有「將連結」(新客戶流程)。
//   每條都在電腦 1280 與手機 375 各跑一次;手機版另外確認面板沒有撐出橫向捲動。
//
// 測試資料:沿用紅利批次 8 的 setupBonusFixture(管理員、會員甲 0966100001 / 乙 0966100002)。
// teardown 同一支 teardownBonusFixture(service_role 硬刪除,刪前核對名稱 / email 格式、刪後全部 0)。
// 這支不送出任何訂單,只操作建單表單。
import { expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";
import {
  injectSession,
  MEMBER_A_PHONE,
  setupBonusFixture,
  teardownBonusFixture,
  type BonusFixture,
} from "./support/bonus-fixture";

const LOAD_TIMEOUT = 20_000;
/** 不在任何會員名下的電話(本 fixture 只有甲 0966100001、乙 0966100002 與 NEW_CUSTOMER_PHONE 0966100099)。 */
const UNUSED_PHONE = "0966101013";

test.describe.configure({ mode: "serial", timeout: 120_000 });

let fixture: BonusFixture;
let setupFailed = false;
let recorder: RequestRecorder | null = null;

test.beforeAll(async () => {
  try {
    fixture = await setupBonusFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBonusFixture(fixture);
  console.log("[b19-1013 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  recorder = recordRequestHosts(page);
});

test.afterEach(async () => {
  if (recorder) expectOnlyLocalRequests(recorder);
});

async function openNewBooking(page: Page): Promise<Locator> {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
  await page.goto("/app/calendar");
  await page.getByRole("button", { name: "新增預約" }).first().click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  return dialog;
}

const VIEWPORTS = [
  { label: "電腦 1280", width: 1280, height: 800 },
  { label: "手機 375", width: 375, height: 812 },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`#1013 ${vp.label}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test("打滿完整電話 ⇒「將連結」保留 + 清單只列那一位 ⇒ 點了帶入(同打一半點選)", async ({
      page,
    }) => {
      const dialog = await openNewBooking(page);
      const nameInput = dialog.locator("#booking-customer-name");
      const phoneInput = dialog.locator("#booking-customer-phone");
      await nameInput.fill("客服先打的名字");
      await phoneInput.fill(MEMBER_A_PHONE);

      await expect(dialog.getByText("將連結既有客戶：")).toBeVisible({ timeout: LOAD_TIMEOUT });
      await expect(dialog.getByText("開頭相符的客戶(點一下帶入資料)")).toBeVisible();
      const memberRows = dialog.getByRole("button", { name: /E2E紅利會員/ });
      await expect(memberRows).toHaveCount(1);
      await expect(memberRows.first()).toContainText(fixture.memberAName);
      // 沒點之前不自動帶入
      await expect(nameInput).toHaveValue("客服先打的名字");

      if (vp.width === 375) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(0);
      }

      await memberRows.first().click();
      await expect(nameInput).toHaveValue(fixture.memberAName);
      await expect(phoneInput).toHaveValue(MEMBER_A_PHONE);
      await expect(dialog.getByText("將連結既有客戶：")).toBeVisible();
    });

    test("打一半點選的舊流程不變", async ({ page }) => {
      const dialog = await openNewBooking(page);
      const nameInput = dialog.locator("#booking-customer-name");
      const phoneInput = dialog.locator("#booking-customer-phone");
      await phoneInput.fill(MEMBER_A_PHONE.slice(0, 7));
      await expect(dialog.getByText("開頭相符的客戶(點一下帶入資料)")).toBeVisible({
        timeout: LOAD_TIMEOUT,
      });
      await expect(dialog.getByText("將連結既有客戶：")).toHaveCount(0);
      // 開頭 0966100 ⇒ 甲、乙兩位都列出
      await expect(dialog.getByRole("button", { name: /E2E紅利會員/ })).toHaveCount(2);
      await dialog.getByRole("button", { name: new RegExp(fixture.memberAName) }).click();
      await expect(phoneInput).toHaveValue(MEMBER_A_PHONE);
      await expect(nameInput).toHaveValue(fixture.memberAName);
      await expect(dialog.getByText("將連結既有客戶：")).toBeVisible();
    });

    test("打滿不存在的號碼 ⇒ 沒有清單、沒有「將連結」(新客戶流程)", async ({ page }) => {
      const dialog = await openNewBooking(page);
      // 先打開頭讓清單出現,確認查詢真的有在跑,再打滿成不存在的號碼。
      await dialog.locator("#booking-customer-phone").fill(UNUSED_PHONE.slice(0, 6));
      await expect(dialog.getByText("開頭相符的客戶(點一下帶入資料)")).toBeVisible({
        timeout: LOAD_TIMEOUT,
      });
      await dialog.locator("#booking-customer-phone").fill(UNUSED_PHONE);
      await expect(dialog.getByText("開頭相符的客戶(點一下帶入資料)")).toHaveCount(0, {
        timeout: LOAD_TIMEOUT,
      });
      await expect(dialog.getByText("將連結既有客戶：")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: /E2E紅利會員/ })).toHaveCount(0);
    });
  });
}
