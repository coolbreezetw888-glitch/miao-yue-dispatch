// 第 11 批 J(#995):電腦版大視窗加寬 + 點外面不關 + 上方空白條 + 填過資料先問放棄。本機 Supabase 專用
// (e2e-local 設定,loopback guard 生效,不碰正式庫)。規格書:.project/specs/改掛會員與預設文案全形-第11批.md §17.7。
//
//   1. 1280 × 800 新增預約:寬 1112(第 16 批起 = 行事曆內容欄)、上緣 56;點左側遮罩不關;點面板正上方(y=28)直接關(沒填)
//   2. 1920 × 1080:寬 1112 置中;1024 × 768:寬 984(第 16 批起 = 行事曆內容欄;原 1152 / 992)
//   3. 填客戶姓名 → Esc ⇒「確定放棄這次輸入？」→ 繼續編輯(姓名還在)→ 點上方空白 ⇒ 再問 → 放棄 ⇒ 關
//   4. 「選擇項目」整頁開著按 Esc ⇒ 只回到表單
//   5. 預約詳情(檢視型):Esc / 點上方空白 ⇒ 直接關
//   6. 編輯服務人員:1280 寬時 856(第 16 批起 = 服務人員管理頁 4xl 內容欄;原 1152)、兩欄格線還是兩欄;服務項目下拉開著點遮罩 ⇒ 只關下拉
//   7. 小卡窗(付款方式新增):點遮罩不關、點卡片正上方 24px ⇒ 關;填名稱後點同處 ⇒ 問放棄
//   8. 確認窗(取消預約):點上方空白 = 取消,預約沒被取消
//   9. 375 × 812:全頁層滿版、沒有空白條;小卡窗點遮罩不關、點卡片正上方 ⇒ 關
//  10. 320 寬:小卡窗沒有橫向捲動
//  11. 深色模式:空白條沒有字(第 12 批 #1000 起條上不顯示文字;原本驗「字看得到」)
//  ※ 第 12 批 #1001:小卡窗電腦版改成跟全頁層同寬(1280 ⇒ 1152),7 的寬度斷言跟著改;
//    第 15 批 #1009 再改成對齊頁面內容欄(付款方式頁 1280 ⇒ 856),完整驗收在 b15-card-dialog-column-align.spec.ts;
//    完整的第 12 批驗收在 b12-card-dialog-wide.spec.ts。
//  ※ 第 16 批 #1010:全頁層也改成對齊頁面內容欄,1 / 2 / 6 的寬度斷言跟著改;完整驗收在 b16-full-page-layer-column-align.spec.ts。
//  ・浮出面板(日期時間選擇 Popover;服務人員表單的服務項目下拉見 6)點外面照舊收起,視窗不動
//  ※ 第 21 批 #1020:小卡窗 / 確認窗拿掉上方空白條(7、8、9 改成「點上方不關,Esc / ✕ 關」);全頁層空白條
//    滑過不反白(11)。完整驗收在 b21-1018-1022-small-fixes.spec.ts。
// 截圖存 test-results/b11-j-shots/(🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:npx playwright test --config playwright.local.config.ts b11-j-overlay-dismiss-and-width

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  adminCreateBooking,
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type CreatedBooking,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = "test-results/b11-j-shots";
const DISCARD_TITLE = "確定放棄這次輸入？";
const STRIP = "[data-overlay-dismiss-strip]";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 240_000 });

let fixture: LiveSyncFixture;
let detailBooking: CreatedBooking;
let cancelBooking: CreatedBooking;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
  detailBooking = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "10:00",
    customerName: "E2E第11批J詳情客",
  });
  cancelBooking = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "13:00",
    customerName: "E2E第11批J取消客",
  });
});

test.afterAll(async () => {
  if (!fixture) return;
  await teardownLiveSyncFixture(fixture);
});

async function openAsAdmin(
  browser: Browser,
  width: number,
  height: number,
  path: string,
): Promise<Page> {
  const session = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(session).not.toBeNull();
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, session!);
  await page.goto("/app");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto(path);
  return page;
}

async function openNewBooking(page: Page): Promise<Locator> {
  await page.goto(`/app/calendar?date=${fixture.dateKey}`);
  await page.getByRole("button", { name: "新增預約" }).first().click({ timeout: LOAD_TIMEOUT });
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增預約" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  return dialog;
}

/** 等進場動畫結束、位置穩定後的框。 */
async function settledBox(locator: Locator) {
  let last = "";
  await expect
    .poll(
      async () => {
        const b = await locator.boundingBox();
        const now = JSON.stringify(b);
        const same = now === last;
        last = now;
        return same && b !== null;
      },
      { timeout: 5_000, intervals: [150] },
    )
    .toBe(true);
  return (await locator.boundingBox())!;
}

async function stripBox(page: Page) {
  const strip = page.locator(STRIP).first();
  await expect(strip).toBeAttached();
  return settledBox(strip);
}

test("1~3. 新增預約(1280):寬度、點遮罩不關、上方空白條、填過資料先問放棄", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  const recorder = recordRequestHosts(page);
  let dialog = await openNewBooking(page);
  const box = await settledBox(dialog);
  // 1. 第 16 批 #1010:寬 = 行事曆內容欄(max-w-6xl 1152 − 左右 px-5)= 1112,x = 64 + 20 = 84;上緣 56。
  expect(Math.round(box.width)).toBe(1112);
  expect(Math.round(box.x)).toBe(84);
  expect(Math.round(box.y)).toBe(56);
  const strip = await stripBox(page);
  expect(Math.round(strip.y)).toBe(0);
  expect(Math.round(strip.height)).toBe(56);
  expect(Math.round(strip.x)).toBe(84);
  expect(Math.round(strip.width)).toBe(1112);
  // 第 12 批 #1000:條上沒有字。
  await expect(page.locator(STRIP)).toHaveText("");
  await page.screenshot({ path: `${SHOTS}/1280-new-booking.png` });

  // 點左側遮罩、右側遮罩、下方遮罩 ⇒ 都不關。
  await page.mouse.click(20, 400);
  await page.mouse.click(1260, 400);
  await page.mouse.click(640, 795);
  await expect(dialog).toBeVisible();

  // 點面板正上方(沒填)⇒ 直接關。
  await page.mouse.click(640, 28);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(DISCARD_TITLE)).toHaveCount(0);

  // 3. 填客戶姓名 → Esc ⇒ 問放棄。
  dialog = await openNewBooking(page);
  await dialog.locator("#booking-customer-name").fill("王小明");
  await page.keyboard.press("Escape");
  const confirm = page.getByTestId("discard-changes-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(DISCARD_TITLE);
  await expect(confirm).toContainText("剛剛填的內容還沒儲存，關掉就會不見。");
  await page.screenshot({ path: `${SHOTS}/1280-discard-confirm.png` });
  await confirm.getByRole("button", { name: "繼續編輯" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(dialog.locator("#booking-customer-name")).toHaveValue("王小明");

  // 點上方空白 ⇒ 再問 →「放棄」⇒ 關。
  await stripBox(page);
  await page.mouse.click(640, 28);
  await expect(page.getByTestId("discard-changes-confirm")).toBeVisible();
  await page.getByTestId("discard-changes-confirm").getByRole("button", { name: "放棄" }).click();
  await expect(dialog).toHaveCount(0);

  // J-11:✕ 不問(填過也直接關)。
  dialog = await openNewBooking(page);
  await dialog.locator("#booking-customer-name").fill("王小明");
  await dialog.getByRole("button", { name: "關閉" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(DISCARD_TITLE)).toHaveCount(0);

  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

test("2. 1920 寬:1112 置中;1024 寬:984", async ({ browser }) => {
  const wide = await openAsAdmin(browser, 1920, 1080, "/app/manage");
  const d1 = await openNewBooking(wide);
  const b1 = await settledBox(d1);
  // 第 16 批 #1010:= 行事曆內容欄 1112,置中。
  expect(Math.round(b1.width)).toBe(1112);
  expect(Math.round(b1.x)).toBe((1920 - 1112) / 2);
  await wide.screenshot({ path: `${SHOTS}/1920-new-booking.png` });
  await wide.context().close();

  const narrow = await openAsAdmin(browser, 1024, 768, "/app/manage");
  const d2 = await openNewBooking(narrow);
  const b2 = await settledBox(d2);
  // 第 16 批 #1010:1024 寬時行事曆容器 = 整個畫面,內容欄 = 1024 − 左右 20 = 984,x = 20。
  expect(Math.round(b2.width)).toBe(984);
  expect(Math.round(b2.x)).toBe(20);
  await narrow.context().close();
});

test("4. 「選擇項目」整頁開著按 Esc ⇒ 只回到表單", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  const dialog = await openNewBooking(page);
  await dialog.locator("#booking-service-items").click();
  await expect(page.getByTestId("service-item-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("service-item-picker")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page.getByText(DISCARD_TITLE)).toHaveCount(0);
  await page.context().close();
});

async function openDetail(page: Page, customerName: string): Promise<Locator> {
  await page.goto("/app/orders");
  await expect(page.getByRole("heading", { name: "訂單管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await page
    .getByRole("button", { name: new RegExp(customerName) })
    .click({ timeout: LOAD_TIMEOUT });
  const layer = page.getByRole("dialog");
  await expect(layer.getByText("預約詳情")).toBeVisible({ timeout: LOAD_TIMEOUT });
  return layer;
}

test("5. 預約詳情(檢視型):Esc / 上方空白 ⇒ 直接關", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  let layer = await openDetail(page, detailBooking.customerName);
  await settledBox(layer);
  await page.keyboard.press("Escape");
  await expect(layer).toHaveCount(0);
  await expect(page.getByText(DISCARD_TITLE)).toHaveCount(0);

  layer = await openDetail(page, detailBooking.customerName);
  await stripBox(page);
  await page.mouse.click(640, 28);
  await expect(layer).toHaveCount(0);
  await expect(page.getByText(DISCARD_TITLE)).toHaveCount(0);
  await page.context().close();
});

test("8. 確認窗(取消預約):點上方空白 = 取消,預約沒被取消", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  const layer = await openDetail(page, cancelBooking.customerName);
  await layer.getByRole("button", { name: "取消預約" }).click();
  const alert = page.getByRole("alertdialog").filter({ hasText: "確定要取消這筆預約嗎？" });
  await expect(alert).toBeVisible();
  // 點遮罩不關。
  await page.mouse.click(20, 400);
  await expect(alert).toBeVisible();
  const card = await settledBox(alert);
  const strips = page.locator(STRIP);
  // 第 21 批 #1020:確認窗沒有自己的空白條 ⇒ 只剩下層全頁層那一條。
  await expect(strips).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/1280-cancel-confirm-strip.png` });
  // 點確認窗正上方、點下層全頁層的空白條位置(y=28)都不會關任何一層(上層遮罩蓋住下層空白條)。
  await page.mouse.click(card.x + card.width / 2, card.y - 24);
  await page.mouse.click(640, 28);
  await expect(alert).toBeVisible();
  // 確認窗開著時下層被設 aria-hidden ⇒ 用 CSS 選擇器確認下層還在。
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  // Esc = 取消(只關確認窗)。
  await page.keyboard.press("Escape");
  await expect(alert).toHaveCount(0);
  await expect(layer).toBeVisible();
  const r = await serviceClient()
    .from("bookings")
    .select("status")
    .eq("id", cancelBooking.id)
    .single();
  expect((r.data as { status: string }).status).not.toBe("cancelled");
  await page.context().close();
});

test("6. 編輯服務人員(1280):856 寬、兩欄還是兩欄;服務項目下拉開著點遮罩 ⇒ 只關下拉", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/staff");
  const card = page.locator("li").filter({ hasText: fixture.staffA.name });
  await card.getByRole("button", { name: "編輯" }).click({ timeout: LOAD_TIMEOUT });
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "編輯服務人員" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  const box = await settledBox(dialog);
  // 第 16 批 #1010:= 服務人員管理頁內容欄(max-w-4xl 896 − 左右 px-5)= 856。
  expect(Math.round(box.width)).toBe(856);
  const columns = await dialog.locator("#staff-name").evaluate((el) => {
    const grid = el.closest(".grid") as HTMLElement | null;
    return grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0;
  });
  expect(columns).toBe(2);
  await page.screenshot({ path: `${SHOTS}/1280-staff-form.png` });

  await page.getByTestId("staff-service-items-trigger").click();
  await expect(page.getByTestId("staff-service-items-content")).toBeVisible();
  await page.mouse.click(20, 400);
  await expect(page.getByTestId("staff-service-items-content")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // 再點一次遮罩:視窗本身也不關。
  await page.mouse.click(20, 400);
  await expect(dialog).toBeVisible();
  await page.context().close();
});

async function openNewPaymentMethod(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "新增付款方式" }).first().click({ timeout: LOAD_TIMEOUT });
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "新增付款方式" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  return dialog;
}

test("7. 小卡窗(付款方式新增):點遮罩 / 卡片正上方都不關(#1020)、Esc 關;填名稱後 Esc 問放棄", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/payment-methods");
  let dialog = await openNewPaymentMethod(page);
  const box = await settledBox(dialog);
  // 第 12 批 #1001:電腦版小卡窗跟全頁層同寬(原本 400);第 15 批 #1009 起改成對齊頁面內容欄
  // (付款方式頁 max-w-4xl 896 − 左右內距 40 = 856)。
  expect(Math.round(box.width)).toBe(856);
  // 第 21 批 #1020:小卡窗沒有上方空白條。
  await page.waitForTimeout(400);
  await expect(page.locator(STRIP)).toHaveCount(0);
  await page.mouse.click(20, 400);
  await page.mouse.click(640, Math.min(795, box.y + box.height + 20));
  await page.mouse.click(box.x + box.width / 2, box.y - 24);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  dialog = await openNewPaymentMethod(page);
  await dialog.locator("#payment-method-name").fill("E2E第11批J轉帳");
  await settledBox(dialog);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("discard-changes-confirm")).toBeVisible();
  await page.getByTestId("discard-changes-confirm").getByRole("button", { name: "放棄" }).click();
  await expect(dialog).toHaveCount(0);
  await page.context().close();
});

test("浮出面板:視窗裡的日期時間選擇(Popover)點外面照舊收起,視窗不動", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  const dialog = await openNewBooking(page);
  // 先選服務人員,時間清單才查得到。
  await dialog.locator("#booking-staff").click();
  await page.getByRole("option", { name: fixture.staffA.name }).click();
  await dialog.locator("#booking-datetime").click();
  const panel = page.getByTestId("booking-time-options");
  await expect(panel).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.mouse.click(20, 400);
  await expect(panel).toHaveCount(0);
  await expect(dialog).toBeVisible();
  // 再點一次遮罩:視窗本身也不關。
  await page.mouse.click(20, 400);
  await expect(dialog).toBeVisible();
  await page.context().close();
});

test("9~10. 手機 375:全頁層滿版沒有空白條;小卡窗點遮罩 / 正上方都不關、✕ 關(#1020);320 不橫捲", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 375, 812, "/app/manage");
  const dialog = await openNewBooking(page);
  const box = await settledBox(dialog);
  expect(Math.round(box.x)).toBe(0);
  expect(Math.round(box.y)).toBe(0);
  expect(Math.round(box.width)).toBe(375);
  expect(Math.round(box.height)).toBe(812);
  // 等一下確定不是還沒量到。
  await page.waitForTimeout(400);
  await expect(page.locator(STRIP)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/375-new-booking.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.goto("/app/payment-methods");
  const card = await openNewPaymentMethod(page);
  const cb = await settledBox(card);
  await page.mouse.click(8, cb.y + cb.height / 2);
  await page.mouse.click(187, Math.min(805, cb.y + cb.height + 30));
  await expect(page.locator(STRIP)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/375-payment-card.png` });
  await page.mouse.click(187, cb.y - 20);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "關閉" }).click();
  await expect(card).toHaveCount(0);
  await page.context().close();

  const tiny = await openAsAdmin(browser, 320, 640, "/app/payment-methods");
  await openNewPaymentMethod(tiny);
  await assertNoHorizontalOverflow(tiny, "320 付款方式小卡窗");
  await tiny.context().close();
});

test("11. 深色模式:空白條沒有字(第 12 批 #1000)", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await openNewBooking(page);
  await stripBox(page);
  await expect(page.locator(STRIP)).toHaveText("");
  await expect(page.locator(STRIP).locator("*")).toHaveCount(0);
  expect(await page.locator(STRIP).evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  await page.locator(STRIP).hover();
  // 第 21 批 #1020:滑過不反白(底色維持透明)。
  expect(await page.locator(STRIP).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    "rgba(0, 0, 0, 0)",
  );
  await page.screenshot({ path: `${SHOTS}/1280-dark-strip.png` });
  await page.context().close();
});
