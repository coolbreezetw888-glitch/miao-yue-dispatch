// 第 11 批 G(#994):編輯服務人員「計酬類型」「服務項目」改下拉。本機 Supabase 專用(e2e-local 設定,
// loopback guard 生效,不碰正式庫)。規格書:.project/specs/改掛會員與預設文案全形-第11批.md §14.7 e2e-local 1~7。
//
//   1. 計酬類型下拉:選月薪制 → 儲存 → DB → 重開顯示月薪制 → 改回原值
//   2. 服務項目:勾一項 ⇒ 不按儲存 DB 立刻多一列;清單仍開著 → 取消勾 ⇒ DB 那列消失;外框摘要跟著變
//   3. 搜尋:輸入某項名稱 ⇒ 只剩那一列
//   4. 已下架那一列:在「已下架」下、勾選中 → 取消 ⇒ DB 移除、列消失
//   5. 清單開著按 Esc ⇒ 清單關、表單還在;再按 Esc ⇒ 表單關
//   6. 1280 / 375 / 320 無橫向捲動;375 × 560 矮視窗清單可以捲到最後一列
//   7. 新增服務人員:服務項目仍顯示「請先儲存…」灰字
// fixture 額外建 9 個上架項目 + 1 個「已下架但綁著」的項目(商家刪除時 cascade;afterAll 先 SELECT 核對再刪)。
// 截圖存 test-results/b11-g-shots/(不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:npx playwright test --config playwright.local.config.ts b11-g-staff-form-dropdowns

import { expect, test, type Browser, type CDPSession, type Page } from "@playwright/test";

import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  injectSession,
  serviceClient,
  setupLiveSyncFixture,
  teardownLiveSyncFixture,
  type LiveSyncFixture,
} from "./support/staff-live-sync-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOTS = "test-results/b11-g-shots";
const ITEM_PREFIX = "E2E第11批G項目";
const REMOVED_NAME = "E2E第11批G已下架項目";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 240_000 });

let fixture: LiveSyncFixture;
let createdItemIds: string[] = [];
let removedItemId: string;
let originalCompensation: string;

test.beforeAll(async () => {
  test.setTimeout(150_000);
  fixture = await setupLiveSyncFixture();
  const svc = serviceClient();
  const ins = await svc
    .from("service_items")
    .insert(
      Array.from({ length: 9 }, (_, i) => ({
        merchant_id: fixture.m1.merchantId,
        name: `${ITEM_PREFIX}${String(i + 1).padStart(2, "0")}`,
        price: 100 * (i + 1),
        item_type: "primary",
        duration_minutes: 30,
      })),
    )
    .select("id");
  if (ins.error) throw new Error(`建立服務項目失敗:${ins.error.message}`);
  createdItemIds = (ins.data as { id: string }[]).map((r) => r.id);

  const removed = await svc
    .from("service_items")
    .insert({
      merchant_id: fixture.m1.merchantId,
      name: REMOVED_NAME,
      price: 999,
      item_type: "primary",
      duration_minutes: 30,
    })
    .select("id")
    .single();
  if (removed.error) throw new Error(`建立已下架項目失敗:${removed.error.message}`);
  removedItemId = (removed.data as { id: string }).id;
  createdItemIds.push(removedItemId);
  const bind = await svc
    .from("merchant_staff_service_items")
    .insert({ staff_id: fixture.staffA.staffId, service_item_id: removedItemId });
  if (bind.error) throw new Error(`綁定已下架項目失敗:${bind.error.message}`);
  const down = await svc
    .from("service_items")
    .update({ status: "removed" })
    .eq("id", removedItemId);
  if (down.error) throw new Error(`下架項目失敗:${down.error.message}`);

  const staffRow = await svc
    .from("merchant_staff")
    .select("compensation_type")
    .eq("id", fixture.staffA.staffId)
    .single();
  originalCompensation = (staffRow.data as { compensation_type: string }).compensation_type;
});

test.afterAll(async () => {
  if (!fixture) return;
  const svc = serviceClient();
  if (createdItemIds.length > 0) {
    // CLAUDE.md 5-1:刪前用同條件 SELECT 核對,只刪本 fixture 建的項目。
    const check = await svc
      .from("service_items")
      .select("id, name, merchant_id")
      .in("id", createdItemIds);
    const rows = (check.data ?? []) as { id: string; name: string; merchant_id: string }[];
    const foreign = rows.filter(
      (r) =>
        r.merchant_id !== fixture.m1.merchantId ||
        !(r.name.startsWith(ITEM_PREFIX) || r.name === REMOVED_NAME),
    );
    if (check.error || foreign.length > 0) {
      throw new Error(`清理中止:有不是本 fixture 建的服務項目(${foreign.length} 筆)`);
    }
    await svc.from("merchant_staff_service_items").delete().in("service_item_id", createdItemIds);
    await svc.from("service_items").delete().in("id", createdItemIds);
  }
  await teardownLiveSyncFixture(fixture);
});

async function openAsAdmin(
  browser: Browser,
  width: number,
  path: string,
  height?: number,
): Promise<Page> {
  const session = (await fixture.m1.admin.auth.getSession()).data.session;
  expect(session).not.toBeNull();
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: height ?? (mobile ? 812 : 900) },
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

async function openStaffEditor(page: Page) {
  const card = page.locator("li").filter({ hasText: fixture.staffA.name });
  await card.getByRole("button", { name: "編輯" }).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("combobox", { name: "計酬類型" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

async function boundItemIds(): Promise<string[]> {
  const r = await serviceClient()
    .from("merchant_staff_service_items")
    .select("service_item_id")
    .eq("staff_id", fixture.staffA.staffId);
  return ((r.data ?? []) as { service_item_id: string }[]).map((x) => x.service_item_id).sort();
}

const trigger = (page: Page) => page.getByTestId("staff-service-items-trigger");
const content = (page: Page) => page.getByTestId("staff-service-items-content");
const row = (page: Page, id: string) => page.getByTestId(`staff-service-items-option-${id}`);

test("1. 計酬類型是下拉:選月薪制 → 儲存 → DB → 重開顯示 → 改回原值", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, "/app/staff");
  const recorder = recordRequestHosts(page);
  await openStaffEditor(page);
  const select = page.getByRole("combobox", { name: "計酬類型" });
  await expect(page.getByRole("radiogroup", { name: "計酬類型" })).toHaveCount(0);
  const target = originalCompensation === "monthly_salary" ? "抽成制" : "月薪制";
  const targetValue = originalCompensation === "monthly_salary" ? "piece_rate" : "monthly_salary";
  const originalLabel = originalCompensation === "monthly_salary" ? "月薪制" : "抽成制";
  await expect(select).toHaveText(originalLabel);
  await select.click();
  await expect(page.getByRole("option")).toHaveText(["抽成制", "月薪制"]);
  await page.getByRole("option", { name: target }).click();
  await page.getByRole("button", { name: "儲存" }).click();
  await expect
    .poll(async () => {
      const r = await serviceClient()
        .from("merchant_staff")
        .select("compensation_type")
        .eq("id", fixture.staffA.staffId)
        .single();
      return (r.data as { compensation_type: string }).compensation_type;
    })
    .toBe(targetValue);

  await openStaffEditor(page);
  await expect(page.getByRole("combobox", { name: "計酬類型" })).toHaveText(target);
  await page.getByRole("combobox", { name: "計酬類型" }).click();
  await page.getByRole("option", { name: originalLabel }).click();
  await page.getByRole("button", { name: "儲存" }).click();
  await expect
    .poll(async () => {
      const r = await serviceClient()
        .from("merchant_staff")
        .select("compensation_type")
        .eq("id", fixture.staffA.staffId)
        .single();
      return (r.data as { compensation_type: string }).compensation_type;
    })
    .toBe(originalCompensation);
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

test("2~5. 服務項目:勾 / 取消即存、搜尋、已下架列、Esc 只關清單", async ({ browser }) => {
  const page = await openAsAdmin(browser, 1280, "/app/staff");
  const recorder = recordRequestHosts(page);
  await openStaffEditor(page);
  const before = await boundItemIds();
  expect(before).toEqual([removedItemId]);
  await expect(page.getByTestId("staff-service-items-summary")).toHaveText(
    `已選 1 項：${REMOVED_NAME}(已下架)`,
  );

  // 2. 勾一項 ⇒ 不按儲存,DB 立刻多一列;清單仍開著
  await trigger(page).click();
  await expect(content(page)).toBeVisible();
  const first = createdItemIds[0]!;
  await row(page, first).click();
  await expect.poll(boundItemIds).toEqual([first, removedItemId].sort());
  await expect(content(page)).toBeVisible();
  await expect(row(page, first)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("staff-service-items-summary")).toHaveText(
    `已選 2 項：${ITEM_PREFIX}01、${REMOVED_NAME}(已下架)`,
  );
  await page.screenshot({ path: `${SHOTS}/g-1280-open.png` });
  // 取消勾 ⇒ DB 那列消失
  await row(page, first).click();
  await expect.poll(boundItemIds).toEqual([removedItemId]);
  await expect(row(page, first)).toHaveAttribute("aria-checked", "false");

  // 3. 搜尋(11 列 > 8 ⇒ 有搜尋框)
  const search = page.getByTestId("staff-service-items-search");
  await expect(search).toBeVisible();
  await search.fill(`${ITEM_PREFIX}07`);
  await expect(content(page).getByRole("checkbox")).toHaveCount(1);
  await expect(content(page).getByRole("checkbox")).toContainText(`${ITEM_PREFIX}07`);
  await search.fill("");

  // 4. 已下架那一列:在「已下架」下、勾選中 → 取消 ⇒ DB 移除、列消失
  await expect(page.getByTestId("staff-service-items-removed-heading")).toHaveText("已下架");
  const removedRow = row(page, removedItemId);
  await expect(removedRow).toHaveAttribute("aria-checked", "true");
  await expect(removedRow).toContainText("已下架，取消勾選後就不能再選回來");
  await removedRow.click();
  await expect.poll(boundItemIds).toEqual([]);
  await expect(removedRow).toHaveCount(0);
  await expect(page.getByTestId("staff-service-items-summary")).toHaveText("請選擇服務項目");

  // 5. Esc 只關清單,表單還在;再按 Esc ⇒ 表單關
  await page.keyboard.press("Escape");
  await expect(content(page)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "計酬類型" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("combobox", { name: "計酬類型" })).toHaveCount(0);
  expectOnlyLocalRequests(recorder);
  await page.context().close();
});

for (const width of [1280, 375, 320]) {
  test(`6. ${width}px:清單開著時無橫向捲動`, async ({ browser }) => {
    const page = await openAsAdmin(browser, width, "/app/staff");
    await openStaffEditor(page);
    await trigger(page).scrollIntoViewIfNeeded();
    await trigger(page).click();
    await expect(content(page)).toBeVisible();
    const box = (await content(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await assertNoHorizontalOverflow(page, `${width}px 編輯服務人員(服務項目清單開著)`);
    await page.screenshot({ path: `${SHOTS}/g-${width}-open.png` });
    await page.context().close();
  });
}

test("6. 375 × 560 矮視窗(滑鼠滾輪):清單可以捲到最後一列", async ({ browser }) => {
  const session = (await fixture.m1.admin.auth.getSession()).data.session!;
  const context = await browser.newContext({
    viewport: { width: 375, height: 560 },
    deviceScaleFactor: 1,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, session);
  await page.goto("/app");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto("/app/staff");
  await openStaffEditor(page);
  await trigger(page).scrollIntoViewIfNeeded();
  await trigger(page).click();
  const list = page.getByTestId("staff-service-items-list");
  await expect(list).toBeVisible();
  const lastId = createdItemIds[createdItemIds.length - 2]!; // 最後一個上架項目(已下架那個在 4. 已移除)
  const listBox = (await list.boundingBox())!;
  // 清單本身要比內容矮(真的需要捲)
  const scrollable = await list.evaluate((el) => el.scrollHeight > el.clientHeight + 4);
  expect(scrollable).toBe(true);
  await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2);
  for (let i = 0; i < 10; i += 1) await page.mouse.wheel(0, 300);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(row(page, lastId)).toBeInViewport();
  await page.screenshot({ path: `${SHOTS}/g-375x560-scrolled.png` });
  await context.close();
});

test("6. 375 × 560 矮視窗(手指拖曳,停住再放開):清單可以捲到最後一列", async ({ browser }) => {
  const page = await openAsAdmin(browser, 375, "/app/staff", 560);
  await openStaffEditor(page);
  await trigger(page).scrollIntoViewIfNeeded();
  await trigger(page).tap();
  const list = page.getByTestId("staff-service-items-list");
  await expect(list).toBeVisible();
  const lastId = createdItemIds[createdItemIds.length - 2]!;
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const touchAt = (type: "touchStart" | "touchMove", x: number, y: number) =>
    cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [{ x, y }] });
  const isLastVisible = () =>
    list.evaluate((el, id) => {
      const r = el.querySelector(`[data-testid="staff-service-items-option-${id}"]`);
      if (!r) return false;
      const a = el.getBoundingClientRect();
      const b = r.getBoundingClientRect();
      return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
    }, lastId);
  for (let round = 0; round < 15 && !(await isLastVisible()); round += 1) {
    const box = (await list.boundingBox())!;
    const x = box.x + box.width / 2;
    const fromY = box.y + box.height - 10;
    const toY = box.y + 10;
    await touchAt("touchStart", x, fromY);
    for (let k = 1; k <= 8; k += 1) await touchAt("touchMove", x, fromY + ((toY - fromY) * k) / 8);
    await page.waitForTimeout(200); // 手指停住一下再放開(不甩出去,沒有慣性)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
  }
  expect(await list.evaluate((el) => el.scrollTop), "手指往上滑要真的讓清單往下捲").toBeGreaterThan(
    0,
  );
  expect(await isLastVisible(), "最後一列要完整出現在清單裡").toBe(true);
  await assertNoHorizontalOverflow(page, "375×560 服務項目清單捲到底");
  await page.context().close();
});

test("7. 新增服務人員:服務項目仍顯示「請先儲存…」灰字", async ({ browser }) => {
  const page = await openAsAdmin(browser, 375, "/app/staff");
  await page
    .getByRole("button", { name: /新增服務人員/ })
    .first()
    .click({ timeout: LOAD_TIMEOUT });
  await expect(
    page.getByText("請先儲存這位服務人員的基本資料，儲存後重新點選「編輯」即可勾選服務項目。"),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "計酬類型" })).toHaveText("抽成制");
  await page.context().close();
});
