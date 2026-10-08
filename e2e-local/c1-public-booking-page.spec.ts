// 客戶端第 1 批(C1)本機 e2e:公開預約頁 /booking/<代碼>。
// 規格書:.project/specs/客戶端第1批-公開預約頁.md(C1-A01~A10、C1-F02、C1-G02)。fixture 見 support/c1-public-booking-fixture.ts。
// **只在本機跑**:`npx playwright test --config playwright.local.config.ts c1-public-booking-page`
// (Playwright 自己開獨立的 headless Chromium,不碰使用者的瀏覽器;只連本機 Docker 的 Supabase)。
//
// 守門(每一條):afterEach 斷言瀏覽器打到 supabase.co 的請求 = 0,且確實有打到本機。
// 截圖:E2E_SHOT_DIR(預設 test-results/c1-shots)。
import { expect, test, type Page, type Response } from "@playwright/test";

import {
  anonClient,
  injectSession,
  ITEM_ADDON,
  ITEM_INDOOR,
  ITEM_OUTDOOR,
  LINE_URL_A,
  SENTINELS,
  serviceClient,
  setupC1Fixture,
  SHOP_A_NAME,
  SHOP_B_NAME,
  STAFF_CHEN,
  STAFF_HAO,
  STAFF_MING,
  teardownC1Fixture,
  THEME_A,
  THEME_B,
  type C1Fixture,
} from "./support/c1-public-booking-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "test-results/c1-shots";

test.use({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "default", timeout: 120_000 });

let fixture: C1Fixture;
let setupFailed = false;
let recorders: RequestRecorder[] = [];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  try {
    fixture = await setupC1Fixture();
    console.log(
      `[c1-public-booking 本機] fixture 建好(A=${fixture.slugA},B=${fixture.slugB},C=${fixture.slugC},今天=${fixture.today},已滿=${fixture.dateFull},請假=${fixture.dateLeave},週日=${fixture.dateSunday})`,
    );
  } catch (err) {
    setupFailed = true;
    throw err;
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  if (setupFailed || !fixture) return;
  const actions = await teardownC1Fixture(fixture);
  console.log("[c1-public-booking 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(() => {
  recorders = [];
});
test.afterEach(() => {
  expect(recorders.length, "前提:這條測試至少開過一個頁面").toBeGreaterThan(0);
  for (const r of recorders) expectOnlyLocalRequests(r);
});

function track(page: Page): void {
  recorders.push(recordRequestHosts(page));
}

/** 收集這一頁所有 /rest/v1/rpc/ 的回應原文(C1-F02)。 */
function collectRpcBodies(page: Page): string[] {
  const bodies: string[] = [];
  page.on("response", (res: Response) => {
    if (!res.url().includes("/rest/v1/rpc/")) return;
    void res
      .text()
      .then((t) => bodies.push(`${new URL(res.url()).pathname} ${t}`))
      .catch(() => undefined);
  });
  return bodies;
}

async function openHome(page: Page, slug: string): Promise<void> {
  await page.goto(`/booking/${slug}`);
  await expect(page.getByTestId("public-booking-shop-name")).toBeVisible({ timeout: LOAD_TIMEOUT });
}

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label}:375 寬不可以有橫向捲動`).toBeLessThanOrEqual(clientWidth);
}

/** ② 選「室內機清洗 ×2 + 室外機清洗 ×1」(= 預覽圖的組合:大約 4 小時、NT$ 6,200)。 */
async function pickPreviewItems(page: Page): Promise<void> {
  await page.getByRole("checkbox", { name: new RegExp(ITEM_INDOOR) }).click();
  await page.getByRole("button", { name: `增加「${ITEM_INDOOR}」的數量` }).click();
  await page.getByRole("checkbox", { name: new RegExp(`^${ITEM_OUTDOOR}`) }).click();
}

async function firstOpenDay(page: Page): Promise<string> {
  const day = page.locator('[data-testid^="public-booking-day-"][data-state="open"]').first();
  const testId = await day.getAttribute("data-testid");
  return (testId ?? "").replace("public-booking-day-", "");
}

test("C1-A01:代碼不存在 ⇒ 中文訊息;停用商家 ⇒ 暫停訊息且看不到店名;回應原文只有 status", async ({
  page,
}) => {
  track(page);
  const bodies = collectRpcBodies(page);
  await page.goto("/booking/no-such-shop-c1e2e");
  await expect(page.getByTestId("public-booking-not-found")).toContainText(
    "請向店家確認連結是否正確",
  );
  await expect(page.locator("body")).not.toContainText("404");
  await expect(page.locator("body")).not.toContainText("Page not found");

  await page.goto(`/booking/${fixture.slugC}`);
  await expect(page.getByText("這間店目前暫停線上預約")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.locator("body")).not.toContainText(SENTINELS.otherShop);
  await expect(page.locator("body")).not.toContainText("E2E客戶端C1本機");

  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(2);
  expect(
    bodies.some(
      (b) => b.endsWith('{"status": "not_found"}') || b.endsWith('{"status":"not_found"}'),
    ),
  ).toBe(true);
  expect(
    bodies.some(
      (b) => b.endsWith('{"status": "unavailable"}') || b.endsWith('{"status":"unavailable"}'),
    ),
  ).toBe(true);
});

test("C1-F02:瀏覽器實際收到的回應原文(頁面 + 指定 / 不指定時段)搜不到任何哨兵字串與內部 id", async ({
  page,
}) => {
  track(page);
  const bodies = collectRpcBodies(page);
  await openHome(page, fixture.slugA);
  await page.getByTestId("public-booking-start").click();
  await page.getByRole("checkbox", { name: new RegExp(ITEM_INDOOR) }).click();
  await page.getByTestId("public-booking-next").click();
  await page.getByTestId("public-booking-next").click(); // 不指定
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goBack();
  await page.getByTestId(`public-booking-staff-${fixture.staffMingId}`).click();
  await page.getByTestId("public-booking-next").click(); // 指定阿明
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await openHome(page, fixture.slugB);

  await expect
    .poll(() => bodies.filter((b) => b.includes("get_public_available_slots")).length)
    .toBeGreaterThanOrEqual(2);
  expect(bodies.filter((b) => b.includes("get_public_booking_page")).length).toBeGreaterThanOrEqual(
    2,
  );
  const all = bodies.join("\n");
  const forbidden = [
    ...Object.values(SENTINELS),
    fixture.merchantAId,
    fixture.merchantBId,
    fixture.merchantCId,
    fixture.groupId,
    fixture.userId,
  ];
  for (const s of forbidden) expect(all, `回應原文不可以出現「${s}」`).not.toContain(s);
  // 正向對照:真的有收到資料(不是空字串假綠)
  expect(all).toContain(SHOP_A_NAME);
  expect(all).toContain(STAFF_MING);
});

test("C1-A02~A09 + C3-D01(1280):①~⑤ 走完,時長 / 金額、日期狀態、上一頁保留;⑤「確定預約」可以按、直接到 ⑥-4;截圖", async ({
  page,
}) => {
  track(page);
  await openHome(page, fixture.slugA);

  // ① 店家首頁
  await expect(page).toHaveTitle(SHOP_A_NAME);
  await expect(page.getByTestId("public-booking-logo-text")).toHaveText("涼風");
  await expect(page.getByText("到府服務")).toBeVisible();
  await expect(page.getByTestId("public-booking-announcement")).toContainText("十月起週日公休");
  const line = page.getByRole("link", { name: /LINE 聯絡店家/ });
  await expect(line).toHaveAttribute("href", LINE_URL_A);
  await expect(line).toHaveAttribute("target", "_blank");
  await expect(line).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.getByRole("link", { name: /撥打電話/ })).toHaveAttribute(
    "href",
    "tel:0223456789",
  );
  await expect(page.getByText("會員中心")).toHaveCount(0);
  await page.screenshot({
    path: `${SHOT_DIR}/c1-01-home-blue-1280.png`,
    fullPage: true,
    animations: "disabled",
  });

  // ② 選服務
  await page.getByTestId("public-booking-start").click();
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 1／5");
  await expect(page.getByText(SENTINELS.removedItem)).toHaveCount(0);
  await page.getByRole("tab", { name: "加購項目" }).click();
  await page.getByRole("checkbox", { name: new RegExp(ITEM_ADDON) }).click();
  await expect(page.getByTestId("public-booking-next")).toBeDisabled();
  await expect(page.getByTestId("public-booking-service-blocked")).toContainText(
    "請至少選一項主要服務。",
  );
  await page.getByRole("checkbox", { name: new RegExp(ITEM_ADDON) }).click(); // 取消
  await page.getByRole("tab", { name: "分離式冷氣" }).click();
  await pickPreviewItems(page);
  await expect(page.getByTestId("public-booking-total-duration")).toHaveText("大約 4 小時");
  await expect(page.getByTestId("public-booking-total-price")).toHaveText("NT$ 6,200");
  await expect(page.getByTestId("public-booking-selected-count")).toContainText(
    "已選 2 項（共 3 份）",
  );
  await page.screenshot({ path: `${SHOT_DIR}/c1-02-services-1280.png`, animations: "disabled" });
  await page.getByTestId("public-booking-next").click();

  // ③ 選服務人員:不指定預設選中;小陳只會室外機 ⇒ 不出現;未上架不出現;沒有暱稱的顯示本名
  await expect(page.getByTestId("public-booking-staff-any")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radio", { name: new RegExp(STAFF_MING) })).toBeVisible();
  await expect(page.getByRole("radio", { name: new RegExp(STAFF_HAO) })).toBeVisible();
  await expect(page.getByRole("radio", { name: new RegExp(STAFF_CHEN) })).toHaveCount(0);
  await expect(page.getByText(SENTINELS.unlistedStaff)).toHaveCount(0);
  await expect(page.getByText(SENTINELS.staffRealName)).toHaveCount(0);
  await page.screenshot({ path: `${SHOT_DIR}/c1-03-staff-1280.png`, animations: "disabled" });
  await page.getByTestId(`public-booking-staff-${fixture.staffMingId}`).click();
  await page.getByTestId("public-booking-next").click();

  // ④ 選時間:今天 = 範圍外(最少提前 1 天)、週日 = 公休、整天有預約 / 請假 = 已滿
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const todayCell = page.getByTestId(`public-booking-day-${fixture.today}`);
  await expect(todayCell).toBeDisabled();
  await expect(todayCell).toHaveAttribute("data-state", "out_of_range");
  await expect(page.getByTestId(`public-booking-day-${fixture.dateSunday}`)).toContainText("公休");
  await expect(page.getByTestId(`public-booking-day-${fixture.dateFull}`)).toContainText("已滿");
  await expect(page.getByTestId(`public-booking-day-${fixture.dateLeave}`)).toContainText("已滿");
  await expect(page.getByTestId("public-booking-onsite-note")).toContainText(
    "預約時間為預計抵達時間",
  );
  await expect(page.getByTestId("public-booking-prev-week")).toBeDisabled();
  const day = await firstOpenDay(page);
  await page.getByTestId(`public-booking-day-${day}`).click();
  await page.getByTestId("public-booking-time-10:00").click();
  await expect(page.getByTestId("public-booking-slot-summary")).toContainText(
    "10:00 開始，預計 14:00 左右完成（共約 4 小時）。",
  );
  await page.screenshot({ path: `${SHOT_DIR}/c1-04-time-1280.png`, animations: "disabled" });

  // C1-A09:瀏覽器的上一頁 = 回到 ③,已選的服務人員仍然被選著;下一頁回到 ④ 時間還在
  await page.goBack();
  await expect(page.getByTestId(`public-booking-staff-${fixture.staffMingId}`)).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page).toHaveURL(new RegExp(`/booking/${fixture.slugA}$`));
  await page.goForward();
  await expect(page.getByTestId("public-booking-time-10:00")).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: LOAD_TIMEOUT },
  );
  await page.getByTestId("public-booking-next").click();

  // ⑤ 填資料:到府有必填地址。客戶端第 3 批(C3-D01):A 店沒有 LINE 登入、允許不登入 ⇒「確定預約」可以按,
  //   姓名 / 地址填好後直接到 ⑥-4 不登入預約(不再是第 1 批的「線上預約即將開放」停用按鈕)。
  // 2026-10-09 使用者新增:步驟條 5 步;A 店沒有 LINE 登入、允許不登入 ⇒ 下一步「登入／電話」+ 姓名上方提示句。
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 4／5");
  await expect(page.getByTestId("public-booking-step-label")).toContainText("下一步：登入／電話");
  await expect(page.getByTestId("public-booking-next-step-hint")).toHaveText(
    "下一步會請你填寫電話。",
  );
  const summary = page.getByTestId("public-booking-summary");
  await expect(summary).toContainText(STAFF_MING);
  await expect(summary).toContainText(`${ITEM_INDOOR} ×2、${ITEM_OUTDOOR} ×1`);
  await expect(summary).toContainText("NT$ 6,200");
  const submit = page.getByTestId("public-booking-submit");
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("確定預約");
  await expect(page.getByText("線上預約即將開放")).toHaveCount(0);
  const address = page.locator("#public-booking-address");
  await expect(address).toBeVisible();
  await expect(address).toHaveAttribute("aria-required", "true");
  await page.locator("#public-booking-name").fill("王小明");
  await address.fill("台北市信義區松仁路 58 號 12 樓");
  await page.screenshot({
    path: `${SHOT_DIR}/c1-05-form-1280.png`,
    fullPage: true,
    animations: "disabled",
  });
  await submit.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${SHOT_DIR}/c1-05-submit-1280.png`,
    animations: "disabled",
  });
  // C3-D01:沒有 LINE 登入的店 ⇒ 直接到 ⑥-4(沒有 ⑥-1 LINE 登入畫面)
  await submit.click();
  await expect(page.getByTestId("customer-guest")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("customer-line-login")).toHaveCount(0);
  await expect(page.getByTestId("public-booking-step-label")).toContainText("步驟 5／5");

  // 重新整理 ⇒ 回到 ①(不存瀏覽器)
  await page.reload();
  await expect(page.getByTestId("public-booking-start")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("C1-A07:下一週翻到超過最遠可預約天數(20 天)就停用;日期狀態截圖", async ({ page }) => {
  track(page);
  await openHome(page, fixture.slugA);
  await page.getByTestId("public-booking-start").click();
  await page.getByRole("checkbox", { name: new RegExp(ITEM_INDOOR) }).click();
  await page.getByTestId("public-booking-next").click();
  await page.getByTestId("public-booking-next").click();
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByTestId("public-booking-week-heading").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOT_DIR}/c1-04-day-states-1280.png`, animations: "disabled" });
  const next = page.getByTestId("public-booking-next-week");
  for (let i = 0; i < 2; i += 1) {
    await expect(next).toBeEnabled({ timeout: LOAD_TIMEOUT });
    await next.click();
  }
  // 第 3 週(第 14~20 天)最後一天還在範圍內 ⇒ 還能翻;第 4 週整週範圍外 ⇒ 停用
  await expect(next).toBeEnabled({ timeout: LOAD_TIMEOUT });
  await next.click();
  await expect(page.getByTestId("public-booking-week-empty")).toContainText(
    "目前沒有可以預約的時間，請聯絡店家。",
    { timeout: LOAD_TIMEOUT },
  );
  await expect(next).toBeDisabled();
  await page.getByTestId("public-booking-prev-week").click();
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test.describe("375 寬", () => {
  test.use({ viewport: { width: 375, height: 780 } });

  test("C1-A09 / G02:①~⑤ 每一步都沒有橫向捲動;截圖", async ({ page }) => {
    track(page);
    await openHome(page, fixture.slugA);
    await expectNoHorizontalScroll(page, "①");
    await page.screenshot({
      path: `${SHOT_DIR}/c1-01-home-blue-375.png`,
      fullPage: true,
      animations: "disabled",
    });
    await page.getByTestId("public-booking-start").click();
    await pickPreviewItems(page);
    await expectNoHorizontalScroll(page, "②");
    await page.screenshot({ path: `${SHOT_DIR}/c1-02-services-375.png`, animations: "disabled" });
    await page.getByTestId("public-booking-next").click();
    await expectNoHorizontalScroll(page, "③");
    await page.screenshot({ path: `${SHOT_DIR}/c1-03-staff-375.png`, animations: "disabled" });
    await page.getByTestId("public-booking-next").click();
    await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
    const day = await firstOpenDay(page);
    await page.getByTestId(`public-booking-day-${day}`).click();
    await page.getByTestId("public-booking-time-10:00").click();
    await expectNoHorizontalScroll(page, "④");
    await page.screenshot({ path: `${SHOT_DIR}/c1-04-time-375.png`, animations: "disabled" });
    await page.getByTestId("public-booking-next").click();
    await page.locator("#public-booking-name").fill("王小明");
    await page.locator("#public-booking-address").fill("台北市信義區松仁路 58 號 12 樓");
    await expectNoHorizontalScroll(page, "⑤");
    await page.screenshot({
      path: `${SHOT_DIR}/c1-05-form-375.png`,
      fullPage: true,
      animations: "disabled",
    });
  });

  test("到店商家 ⑤ 沒有地址欄位;375 截圖", async ({ page }) => {
    track(page);
    await openHome(page, fixture.slugB);
    await page.getByTestId("public-booking-start").click();
    await page.getByRole("checkbox").first().click();
    await page.getByTestId("public-booking-next").click();
    await page.getByTestId("public-booking-next").click();
    await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(page.getByTestId("public-booking-onsite-note")).toHaveCount(0);
    const day = await firstOpenDay(page);
    await page.getByTestId(`public-booking-day-${day}`).click();
    await page.locator('[data-testid^="public-booking-time-"]').first().click();
    await page.getByTestId("public-booking-next").click();
    // 客戶端第 3 批(C3-D01):B 店沒有 LINE 登入、允許不登入 ⇒「確定預約」可以按(不再是停用按鈕)。
    await expect(page.getByTestId("public-booking-submit")).toBeEnabled();
    await expect(page.getByTestId("public-booking-submit")).toHaveText("確定預約");
    await expect(page.locator("#public-booking-address")).toHaveCount(0);
    await expect(page.getByText("服務地址")).toHaveCount(0);
    await expectNoHorizontalScroll(page, "到店 ⑤");
    await page.screenshot({
      path: `${SHOT_DIR}/c1-05-form-instore-375.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
});

test("C1-A02:兩種主題色的主要按鈕顏色不同;分頁標題 = 店名;① 綠色 / 橘色截圖", async ({ page }) => {
  track(page);
  const startBg = () =>
    page.getByTestId("public-booking-start").evaluate((el) => getComputedStyle(el).backgroundColor);
  await openHome(page, fixture.slugA);
  const blue = await startBg();
  await openHome(page, fixture.slugB);
  await expect(page).toHaveTitle(SHOP_B_NAME);
  const green = await startBg();
  expect(blue).toBe("rgb(37, 99, 235)"); // THEME_A
  expect(green).toBe("rgb(22, 163, 74)"); // THEME_B
  expect(THEME_A).not.toBe(THEME_B);
  // B 沒填地址、公告關 ⇒ 那幾塊不顯示;關掉的公告內容不出現
  await expect(page.getByTestId("public-booking-address")).toHaveCount(0);
  await expect(page.getByTestId("public-booking-announcement")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(SENTINELS.announcementOff);
  await page.screenshot({
    path: `${SHOT_DIR}/c1-01-home-green-instore-1280.png`,
    fullPage: true,
    animations: "disabled",
  });

  // 第二種主題色(同一間店改成活力橘)
  const svc = serviceClient();
  const up = await svc
    .from("merchants")
    .update({ theme_custom_color: "#FF7A30" })
    .eq("id", fixture.merchantAId);
  expect(up.error).toBeNull();
  try {
    await openHome(page, fixture.slugA);
    expect(await startBg()).toBe("rgb(255, 122, 48)");
    await page.screenshot({
      path: `${SHOT_DIR}/c1-01-home-orange-1280.png`,
      fullPage: true,
      animations: "disabled",
    });
  } finally {
    await svc
      .from("merchants")
      .update({ theme_custom_color: THEME_A })
      .eq("id", fixture.merchantAId);
  }
});

test("C1-A04:聯絡按鈕四種組合(都有 / 只有 LINE / 只有電話 / 都沒有)", async ({ page }) => {
  track(page);
  const svc = serviceClient();
  const contacts = page.getByTestId("public-booking-contacts");

  await openHome(page, fixture.slugA); // 都有
  await expect(contacts.getByRole("link")).toHaveCount(2);

  await openHome(page, fixture.slugB); // 只有電話
  await expect(contacts.getByRole("link")).toHaveCount(1);
  await expect(contacts.getByRole("link")).toHaveAttribute("href", "tel:0912000111");

  try {
    await svc
      .from("merchants")
      .update({ phone: null, line_friend_url: "https://line.me/R/ti/p/@c1e2e" } as never)
      .eq("id", fixture.merchantBId);
    await openHome(page, fixture.slugB); // 只有 LINE
    await expect(contacts.getByRole("link")).toHaveCount(1);
    await expect(contacts.getByRole("link")).toHaveAttribute(
      "href",
      "https://line.me/R/ti/p/@c1e2e",
    );
    await expect(contacts.getByRole("link")).toHaveAttribute("target", "_blank");

    await svc
      .from("merchants")
      .update({ phone: null, line_friend_url: null } as never)
      .eq("id", fixture.merchantBId);
    await openHome(page, fixture.slugB); // 都沒有 ⇒ 整列不顯示
    await expect(contacts).toHaveCount(0);
  } finally {
    await svc
      .from("merchants")
      .update({ phone: "0912-000-111", line_friend_url: null } as never)
      .eq("id", fixture.merchantBId);
  }
});

test("C1-A01:已登入後台的管理員打開別家的預約頁 ⇒ 看到的是別家的資料,不會被導去後台", async ({
  page,
}) => {
  track(page);
  await injectSession(page, fixture.adminSession);
  await page.goto("/app/manage");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto(`/booking/${fixture.slugB.toUpperCase()}`);
  await expect(page.getByTestId("public-booking-shop-name")).toHaveText(SHOP_B_NAME, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page).toHaveURL(new RegExp(`/booking/${fixture.slugB.toUpperCase()}$`));
  await expect(page.getByText("到店服務")).toBeVisible();
  // 沒有後台外殼(底部分頁籤)
  await expect(page.getByRole("link", { name: "行事曆" })).toHaveCount(0);
});

test("C1-F01 對照:沒登入的人直接讀資料表一列都拿不到(只能透過兩支函式)", async ({ page }) => {
  track(page);
  await openHome(page, fixture.slugA);
  const anon = anonClient();
  for (const table of [
    "merchants",
    "merchant_staff",
    "service_items",
    "bookings",
    "merchant_booking_settings",
  ]) {
    const r = await anon.from(table).select("*").limit(5);
    expect(r.data ?? [], `沒登入讀 ${table} 應該是 0 列`).toEqual([]);
  }
});
