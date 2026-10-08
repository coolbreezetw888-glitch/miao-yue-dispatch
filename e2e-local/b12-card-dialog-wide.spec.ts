// 第 12 批(#1000、#1001):視窗上方空白條去字 + 電腦版小卡窗加寬。本機 Supabase 專用
// (e2e-local 設定,loopback guard 生效,不碰正式庫)。規格書:.project/specs/視窗上方條去字與小卡窗加寬-第12批.md
//
//   1. 1280 × 800 編輯客服資料:寬 = 頁面內容欄(第 15 批 #1009 起;第 12 批原為 1152)、高度只到按鈕列(下方看得到後面頁面)、垂直置中、
//      標題下 / 按鈕列上各一條分隔線、兩顆按鈕左右各半;空白條沒字、48px、點了照樣關;填過資料先問放棄
//   2. 1280 × 800 編輯料錢成本品項:同上
//   3. 1280 × 520(內容比畫面長):上緣 56、下緣離底 18、中間捲動、標題列與按鈕列不動
//   4. 1280 確認窗(取消預約):仍 400 寬、按鈕靠右(不變);空白條沒字
//   5. 1280 全頁層(預約詳情):1112 寬(第 16 批 #1010 起 = 訂單管理內容欄;原 1152)、上緣 56(不變);空白條沒字
//   6. 375 × 812:小卡窗 / 確認窗 / 全頁層跟改版前一樣(位置、寬度、按鈕各半;截圖)
//
// ※ 第 21 批 #1020:小卡窗 / 確認窗拿掉上方空白條 ⇒ 1、3、4~5 改成「沒有空白條、點上方不關、Esc 關 / 先問放棄」;
//   全頁層空白條不變(完整驗收在 b21-1018-1022-small-fixes.spec.ts)。
//
// 截圖存 B12_SHOTS(預設 test-results/b12-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:npx playwright test --config playwright.local.config.ts b12-card-dialog-wide

import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

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
const SHOTS = process.env["B12_SHOTS"] ?? "test-results/b12-shots";
const STRIP = "[data-overlay-dismiss-strip]";
const DISCARD_TITLE = "確定放棄這次輸入？";
// 固定字串(不帶 runId):截圖比對時畫面內容才會一樣。商家每次都是新建的,不會撞名。
const AGENT_NAME = "E2E第12批客服";
const MATERIAL_NAME = "E2E第12批料錢";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 240_000 });

let fixture: LiveSyncFixture;
let agentId: string | null = null;
let materialId: string | null = null;
let cancelBooking: CreatedBooking;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
  const agent = await serviceClient()
    .from("merchant_agents")
    .insert({
      merchant_id: fixture.m1.merchantId,
      name: AGENT_NAME,
      phone: "0911000120",
      invited_email: `e2e-b12-agent-${fixture.runId}@example.test`,
      status: "invited",
    })
    .select("id")
    .single();
  if (agent.error) throw new Error(`建立測試客服失敗:${agent.error.message}`);
  agentId = (agent.data as { id: string }).id;
  const item = await fixture.m1.admin
    .from("material_cost_items")
    .insert({ merchant_id: fixture.m1.merchantId, name: MATERIAL_NAME, amount: 300 })
    .select("id")
    .single();
  if (item.error) throw new Error(`建立料錢品項失敗:${item.error.message}`);
  materialId = (item.data as { id: string }).id;
  cancelBooking = await adminCreateBooking(fixture, fixture.m1, {
    staffId: fixture.staffA.staffId,
    time: "13:00",
    customerName: "E2E第12批取消客",
  });
});

test.afterAll(async () => {
  if (!fixture) return;
  const svc = serviceClient();
  // 先用同條件 SELECT 核對只有本次建立的那一筆,再刪(本機庫;商家刪除時也會 cascade,這裡是保險)。
  if (agentId) {
    const chk = await svc.from("merchant_agents").select("id,name,merchant_id").eq("id", agentId);
    const rows = (chk.data ?? []) as { name: string; merchant_id: string }[];
    if (
      rows.length === 1 &&
      rows[0]!.name === AGENT_NAME &&
      rows[0]!.merchant_id === fixture.m1.merchantId
    ) {
      await svc.from("merchant_agents").delete().eq("id", agentId);
    }
  }
  if (materialId) {
    const chk = await svc
      .from("material_cost_items")
      .select("id,name,merchant_id")
      .eq("id", materialId);
    const rows = (chk.data ?? []) as { name: string; merchant_id: string }[];
    if (
      rows.length === 1 &&
      rows[0]!.name === MATERIAL_NAME &&
      rows[0]!.merchant_id === fixture.m1.merchantId
    ) {
      await svc.from("material_cost_items").delete().eq("id", materialId);
    }
  }
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

async function openAgentEdit(page: Page): Promise<Locator> {
  const row = page.locator("li").filter({ hasText: AGENT_NAME });
  await row.getByRole("button", { name: "編輯", exact: true }).click({ timeout: LOAD_TIMEOUT });
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "編輯客服資料" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  return dialog;
}

async function openMaterialEdit(page: Page): Promise<Locator> {
  const row = page.locator("li").filter({ hasText: MATERIAL_NAME });
  await row.getByRole("button", { name: "編輯", exact: true }).click({ timeout: LOAD_TIMEOUT });
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "編輯料錢成本品項" }) });
  await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
  return dialog;
}

/** 電腦版小卡窗的共用斷言:寬度 / 左右邊界 = 頁面內容欄(第 15 批 #1009 起;原本第 12 批是寬 1152)、
 *  在「上 56 / 下 18」之間置中、分隔線、按鈕平均分寬、空白條沒字 48px。 */
async function expectWideCard(page: Page, dialog: Locator, viewportH: number) {
  const box = await settledBox(dialog);
  const col = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>("[data-app-content-root]")!
      .firstElementChild as HTMLElement;
    const r = main.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const pl = Number.parseFloat(cs.paddingLeft);
    return { left: r.left + pl, width: r.width - pl - Number.parseFloat(cs.paddingRight) };
  });
  expect(Math.abs(box.width - col.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.x - col.left)).toBeLessThanOrEqual(1);
  expect(box.y).toBeGreaterThanOrEqual(56 - 0.5);
  expect(box.y + box.height).toBeLessThanOrEqual(viewportH - 18 + 0.5);
  // 置中於 [56, H-18] 這段(中心 = H/2 + 19)。
  expect(Math.abs(box.y + box.height / 2 - (viewportH / 2 + 19))).toBeLessThanOrEqual(1);

  const header = dialog.locator("[data-card-dialog-header]");
  const footer = dialog.locator("[data-card-dialog-footer]");
  const headerBorder = await header.evaluate((el) => getComputedStyle(el).borderBottomWidth);
  const footerBorder = await footer.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(headerBorder).toBe("1px");
  expect(footerBorder).toBe("1px");
  // 按鈕列在卡片最底、按鈕平均分寬。
  const fb = await footer.boundingBox();
  expect(Math.round(fb!.y + fb!.height)).toBe(Math.round(box.y + box.height) - 1); // 卡片 1px 邊框
  const buttons = footer.getByRole("button");
  const n = await buttons.count();
  expect(n).toBe(2);
  const widths: number[] = [];
  for (let i = 0; i < n; i += 1) widths.push((await buttons.nth(i).boundingBox())!.width);
  expect(Math.abs(widths[0]! - widths[1]!)).toBeLessThanOrEqual(1);
  expect(widths[0]!).toBeGreaterThan(300);

  // 第 21 批 #1020:小卡窗沒有上方空白條。
  await expect(page.locator(STRIP)).toHaveCount(0);
  return box;
}

test("1. 編輯客服資料(1280):拉寬、高度跟內容、置中、分隔線、按鈕各半、空白條沒字但照樣關", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/agents");
  const recorder = recordRequestHosts(page);
  let dialog = await openAgentEdit(page);
  const box = await expectWideCard(page, dialog, 800);
  // 高度只到按鈕列:卡片下方看得到後面頁面(還有空間)。
  expect(box.y + box.height).toBeLessThan(800 - 18 - 20);
  // 欄位一欄直排(姓名在暱稱正上方)。
  const nameBox = (await dialog.locator("#agent-edit-name").boundingBox())!;
  const nickBox = (await dialog.locator("#agent-edit-nickname").boundingBox())!;
  expect(nickBox.y).toBeGreaterThan(nameBox.y + nameBox.height);
  expect(Math.round(nickBox.x)).toBe(Math.round(nameBox.x));
  await page.screenshot({ path: `${SHOTS}/1280-agent-edit.png` });

  // 第 21 批 #1020:點卡片上方不關;Esc 關(沒改過)。
  await page.mouse.click(640, box.y - 24);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // 改過 ⇒ Esc 先問放棄。
  dialog = await openAgentEdit(page);
  await dialog.locator("#agent-edit-nickname").fill("改過");
  await settledBox(dialog);
  await page.keyboard.press("Escape");
  await expect(page.getByText(DISCARD_TITLE)).toBeVisible();
  await page.getByTestId("discard-changes-confirm").getByRole("button", { name: "放棄" }).click();
  await expect(dialog).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

test("2. 編輯料錢成本品項(1280):同上規格", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/material-costs");
  const dialog = await openMaterialEdit(page);
  await expectWideCard(page, dialog, 800);
  await page.screenshot({ path: `${SHOTS}/1280-material-edit.png` });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.context().close();
});

test("3. 內容比畫面長(1280 × 520):上緣 56、下緣離底 18、只有中間捲動,標題列與按鈕列不動", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, 520, "/app/agents");
  const dialog = await openAgentEdit(page);
  const box = await settledBox(dialog);
  expect(Math.round(box.y)).toBe(56);
  expect(Math.round(box.y + box.height)).toBe(520 - 18);
  const body = dialog.locator("[data-card-dialog-body]");
  const scroll = await body.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(scroll.sh).toBeGreaterThan(scroll.ch);
  const header = dialog.locator("[data-card-dialog-header]");
  const footer = dialog.locator("[data-card-dialog-footer]");
  const h1 = (await header.boundingBox())!;
  const f1 = (await footer.boundingBox())!;
  await page.screenshot({ path: `${SHOTS}/1280x520-long-card-top.png` });
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const h2 = (await header.boundingBox())!;
  const f2 = (await footer.boundingBox())!;
  expect(h2.y).toBe(h1.y);
  expect(f2.y).toBe(f1.y);
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // 捲到底:最後一個欄位(電話)看得到、而且在按鈕列上方。
  const phone = (await dialog.locator("#agent-edit-phone").boundingBox())!;
  expect(phone.y + phone.height).toBeLessThanOrEqual(f2.y);
  await page.screenshot({ path: `${SHOTS}/1280x520-long-card-bottom.png` });
  // 第 21 批 #1020:小卡窗沒有上方空白條(上緣 56 不收回)。
  await expect(page.locator(STRIP)).toHaveCount(0);
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

test("4~5. 確認窗(1280)仍 400 寬、按鈕靠右;全頁層 1112 寬、上緣 56;兩者空白條都沒字", async ({
  browser,
}) => {
  const page = await openAsAdmin(browser, 1280, 800, "/app/manage");
  const layer = await openDetail(page, cancelBooking.customerName);
  const lb = await settledBox(layer);
  // 第 16 批 #1010:= 訂單管理內容欄(max-w-6xl 1152 − 左右 px-5)= 1112。
  expect(Math.round(lb.width)).toBe(1112);
  expect(Math.round(lb.y)).toBe(56);
  await expect(page.locator(STRIP)).toHaveCount(1);
  await expect(page.locator(STRIP)).toHaveText("");
  await page.screenshot({ path: `${SHOTS}/1280-full-page-layer.png` });

  await layer.getByRole("button", { name: "取消預約" }).click();
  const alert = page.getByRole("alertdialog").filter({ hasText: "確定要取消這筆預約嗎？" });
  await expect(alert).toBeVisible();
  const ab = await settledBox(alert);
  expect(Math.round(ab.width)).toBe(400);
  // 置中(不是第 12 批的 50%+19px)。
  expect(Math.abs(ab.y + ab.height / 2 - 400)).toBeLessThanOrEqual(1);
  // 按鈕靠右、按內容寬(最後一顆右緣貼卡片內距)。
  const btns = alert.getByRole("button");
  const last = (await btns.last().boundingBox())!;
  const first = (await btns.first().boundingBox())!;
  expect(Math.round(ab.x + ab.width - (last.x + last.width))).toBe(21); // p-5 + 1px 邊框
  expect(first.width).toBeLessThan(300);
  const strips = page.locator(STRIP);
  // 第 21 批 #1020:確認窗沒有空白條 ⇒ 只剩下層全頁層那一條。
  await expect(strips).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/1280-confirm.png` });
  // 兩層重疊:點確認窗上方、點下層空白條的位置都不關任何一層;Esc 只關確認窗。
  await page.mouse.click(ab.x + ab.width / 2, ab.y - 24);
  await page.mouse.click(640, 28);
  await expect(alert).toBeVisible();
  // 確認窗開著時下層被設 aria-hidden ⇒ 用 CSS 選擇器確認下層還在。
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(alert).toHaveCount(0);
  await expect(layer).toBeVisible();
  await page.context().close();
});

test("6. 手機 375:小卡窗 / 確認窗 / 全頁層跟改版前一樣", async ({ browser }) => {
  const page = await openAsAdmin(browser, 375, 812, "/app/agents");
  const card = await openAgentEdit(page);
  const cb = await settledBox(card);
  expect(Math.round(cb.x)).toBe(16);
  expect(Math.round(cb.width)).toBe(343);
  // 垂直置中(手機規格沒變)。
  expect(Math.abs(cb.y + cb.height / 2 - 406)).toBeLessThanOrEqual(1);
  // 中間內容區在手機是 display:contents(不產生框)。
  expect(
    await card.locator("[data-card-dialog-body]").evaluate((el) => getComputedStyle(el).display),
  ).toBe("contents");
  const header = card.locator("[data-card-dialog-header]");
  expect(await header.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("0px");
  const btns = card.locator("[data-card-dialog-footer]").getByRole("button");
  const w0 = (await btns.nth(0).boundingBox())!.width;
  const w1 = (await btns.nth(1).boundingBox())!.width;
  expect(Math.abs(w0 - w1)).toBeLessThanOrEqual(1);
  // 第 21 批 #1020:小卡窗沒有上方空白條(原本驗「空白條沒字」)。
  await expect(page.locator(STRIP)).toHaveCount(0);
  await card.screenshot({ path: `${SHOTS}/375-agent-edit-card.png` });
  await page.screenshot({ path: `${SHOTS}/375-agent-edit.png` });
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);

  await page.goto("/app/material-costs");
  const mat = await openMaterialEdit(page);
  await settledBox(mat);
  await mat.screenshot({ path: `${SHOTS}/375-material-edit-card.png` });
  await page.screenshot({ path: `${SHOTS}/375-material-edit.png` });
  await page.keyboard.press("Escape");

  const layer = await openDetail(page, cancelBooking.customerName);
  const lb = await settledBox(layer);
  expect(Math.round(lb.width)).toBe(375);
  expect(Math.round(lb.y)).toBe(0);
  await page.waitForTimeout(400);
  await expect(page.locator(STRIP)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/375-full-page-layer.png` });
  await layer.getByRole("button", { name: "取消預約" }).click();
  const alert = page.getByRole("alertdialog").filter({ hasText: "確定要取消這筆預約嗎？" });
  const ab = await settledBox(alert);
  expect(Math.round(ab.width)).toBe(343);
  await alert.screenshot({ path: `${SHOTS}/375-confirm-card.png` });
  await page.screenshot({ path: `${SHOTS}/375-confirm.png` });
  await page.context().close();
});
