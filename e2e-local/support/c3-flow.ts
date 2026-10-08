// 客戶端第 3 批 e2e 共用的畫面操作(預約頁 ①→⑤、截圖、客人登入狀態)。
import { expect, type Page } from "@playwright/test";
import type { Session } from "@supabase/supabase-js";

export const LOAD_TIMEOUT = 20_000;
export const SHOT_DIR = process.env["E2E_SHOT_DIR"] ?? "../.project/notes/c3-shots";

/** ①→⑤:選一項服務、(可指定)服務人員、第一個能約的時間,填好姓名 / 地址 / 備註。回傳選到的日期與時間。 */
export async function walkToForm(
  page: Page,
  slug: string,
  opts: { item: string; name: string; staffId?: string | null; note?: string },
): Promise<{ date: string; time: string }> {
  await page.goto(`/booking/${slug}`);
  await page.getByTestId("public-booking-start").click({ timeout: LOAD_TIMEOUT });
  await page.getByRole("checkbox", { name: new RegExp(opts.item) }).click();
  await page.getByTestId("public-booking-next").click();
  if (opts.staffId) await page.getByTestId(`public-booking-staff-${opts.staffId}`).click();
  await page.getByTestId("public-booking-next").click();
  await expect(page.getByTestId("public-booking-times")).toBeVisible({ timeout: LOAD_TIMEOUT });
  const day = page.locator('[data-testid^="public-booking-day-"][aria-pressed="true"]');
  const date = ((await day.getAttribute("data-testid")) ?? "").replace("public-booking-day-", "");
  const timeBtn = page.getByTestId("public-booking-times").locator("button").first();
  const time = ((await timeBtn.getAttribute("data-testid")) ?? "").replace(
    "public-booking-time-",
    "",
  );
  await timeBtn.click();
  await page.getByTestId("public-booking-next").click();
  await page.locator("#public-booking-name").fill(opts.name);
  const address = page.locator("#public-booking-address");
  if (await address.count()) await address.fill("台北市信義區松仁路 58 號 12 樓");
  await page.locator("#public-booking-note").fill(opts.note ?? "門口有狗");
  return { date, time };
}

async function expectNoHorizontalScroll(page: Page, label: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${label}:375 寬不可以有橫向捲動`).toBeLessThanOrEqual(clientWidth);
}

/** 1280 + 375 各一張(先把視窗拉到整頁高度再截,固定頁首 / 頁尾才不會蓋住內容)。 */
export async function shotBoth(page: Page, name: string): Promise<void> {
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await page.waitForTimeout(250);
    if (width === 375) await expectNoHorizontalScroll(page, name);
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(h, width === 375 ? 812 : 900) });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** 把一份真的本機客人登入狀態放進「這間店的客戶 client」的儲存位置(customerClient.ts 的 storageKey)。 */
export async function injectCustomerSession(
  page: Page,
  slug: string,
  session: Session,
): Promise<void> {
  await page.addInitScript(
    ([k, v]) => {
      window.localStorage.setItem(k, v);
    },
    [`miaoyue-customer-${slug}`, JSON.stringify(session)] as [string, string],
  );
}
