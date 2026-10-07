// SPECS-INDEX #998 第 11 批 I:「目前開啟 / 目前關閉」狀態字要醒目(開綠、關紅、粗體)。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §16.5。**只在本機跑**:
//   npx playwright test --config playwright.local.config.ts b11-i-state-text-color
// (只連本機 Docker;Playwright 自己開獨立 headless Chromium,不碰使用者的瀏覽器)。
//
// 1280 寬,淺色 / 深色各跑一次:
//   ・抽成與薪資設定頁「料錢影響抽成：目前…」:關 / 開兩種顏色不同,且都不等於整行灰字的顏色;字是粗體
//   ・料錢成本管理頁「料錢成本功能」開關列說明:「目前已開啟 / 目前已關閉」同上
//   ・截圖存 test-results/b11-i-shots/(**不寫進** .project/notes/ui-ref-2026-10-01/after/)
// 深色模式:專案用 Tailwind `.dark` class(src/styles.css `@custom-variant dark (&:is(.dark *))`),
// 沒有執行期的切換開關 ⇒ 這裡 emulateMedia({ colorScheme: "dark" }) + 在 <html> 加 `dark` class。
// 測試資料:沿用 material-commission-fixture(料錢成本功能已開、管理員一位),狀態用 service_role 直接切。
import { mkdirSync } from "node:fs";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  injectSession,
  serviceClient,
  setupMaterialCommissionFixture,
  teardownMaterialCommissionFixture,
  type MaterialCommissionFixture,
} from "./support/material-commission-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/b11-i-shots";

test.describe.configure({ mode: "serial", timeout: 90_000 });
test.use({ viewport: { width: 1280, height: 900 } });

let fixture: MaterialCommissionFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupMaterialCommissionFixture();
  } catch (err) {
    setupFailed = true;
    throw err;
  }
  mkdirSync(SHOT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownMaterialCommissionFixture(fixture);
  console.log("[b11-i 本機] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function setCommissionBasis(net: boolean) {
  const r = await serviceClient()
    .from("merchant_payroll_settings")
    .upsert(
      {
        merchant_id: fixture.merchantId,
        commission_basis_type: net ? "net_of_material_cost" : "gross",
      },
      { onConflict: "merchant_id" },
    );
  if (r.error) throw new Error(`切換料錢影響抽成失敗:${r.error.message}`);
}

async function setMaterialFeature(enabled: boolean) {
  const r = await serviceClient()
    .from("merchant_feature_flags")
    .upsert(
      { merchant_id: fixture.merchantId, feature_key: "material_cost_enabled", enabled },
      { onConflict: "merchant_id,feature_key" },
    );
  if (r.error) throw new Error(`切換料錢成本功能失敗:${r.error.message}`);
}

async function applyTheme(page: Page, dark: boolean) {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await page.evaluate((isDark) => {
    document.documentElement.classList.toggle("dark", isDark);
  }, dark);
}

async function colorOf(locator: Locator): Promise<{ color: string; weight: number }> {
  return locator.evaluate((el) => {
    const s = getComputedStyle(el);
    return { color: s.color, weight: Number(s.fontWeight) };
  });
}

for (const dark of [false, true]) {
  const mode = dark ? "dark" : "light";

  test(`I-${mode} 抽成與薪資設定頁:目前關閉紅、目前開啟綠,都跟灰字不同`, async ({ page }) => {
    const recorder = recordRequestHosts(page);
    await injectSession(page, fixture.adminSession);
    await primeCurrentMerchant(page, LOAD_TIMEOUT);

    await setCommissionBasis(false);
    await page.goto("/app/payroll-settings");
    await applyTheme(page, dark);
    const line = page.getByTestId("payroll-material-commission-readonly");
    await expect(line).toHaveText("料錢影響抽成：目前關閉。要修改請到「料錢成本管理」。", {
      timeout: LOAD_TIMEOUT,
    });
    const state = page.getByTestId("payroll-material-commission-state");
    await expect(state).toHaveAttribute("data-state", "off");
    const off = await colorOf(state);
    const gray = await colorOf(line);
    await line.screenshot({ path: `${SHOT_DIR}/payroll-off-${mode}-1280.png` });

    await setCommissionBasis(true);
    await page.reload();
    await applyTheme(page, dark);
    await expect(line).toHaveText("料錢影響抽成：目前開啟。要修改請到「料錢成本管理」。", {
      timeout: LOAD_TIMEOUT,
    });
    await expect(state).toHaveAttribute("data-state", "on");
    const on = await colorOf(state);
    await line.screenshot({ path: `${SHOT_DIR}/payroll-on-${mode}-1280.png` });

    expect(off.color).not.toBe(on.color);
    expect(off.color).not.toBe(gray.color);
    expect(on.color).not.toBe(gray.color);
    expect(off.weight).toBeGreaterThanOrEqual(600);
    expect(on.weight).toBeGreaterThanOrEqual(600);
    expect(gray.weight).toBeLessThan(600);
    expectOnlyLocalRequests(recorder);
  });

  test(`I-${mode} 料錢成本管理頁:目前已開啟綠、目前已關閉紅,後半句維持灰字`, async ({ page }) => {
    const recorder = recordRequestHosts(page);
    await injectSession(page, fixture.adminSession);
    await primeCurrentMerchant(page, LOAD_TIMEOUT);

    await setMaterialFeature(true);
    await page.goto("/app/material-costs");
    await applyTheme(page, dark);
    const state = page.getByTestId("material-cost-feature-state");
    await expect(state).toHaveText("目前已開啟", { timeout: LOAD_TIMEOUT });
    const desc = state.locator("xpath=..");
    await expect(desc).toHaveText("目前已開啟，建單表單會出現「料錢成本」區塊。");
    const on = await colorOf(state);
    const gray = await colorOf(desc);
    await desc.screenshot({ path: `${SHOT_DIR}/material-feature-on-${mode}-1280.png` });

    await setMaterialFeature(false);
    await page.reload();
    await applyTheme(page, dark);
    await expect(state).toHaveText("目前已關閉", { timeout: LOAD_TIMEOUT });
    await expect(desc).toHaveText("目前已關閉，建單表單不會出現「料錢成本」區塊。");
    const off = await colorOf(state);
    await desc.screenshot({ path: `${SHOT_DIR}/material-feature-off-${mode}-1280.png` });
    await page.screenshot({ path: `${SHOT_DIR}/material-costs-page-${mode}-1280.png` });

    expect(off.color).not.toBe(on.color);
    expect(off.color).not.toBe(gray.color);
    expect(on.color).not.toBe(gray.color);
    expect(off.weight).toBeGreaterThanOrEqual(600);
    expect(on.weight).toBeGreaterThanOrEqual(600);

    await setMaterialFeature(true);
    expectOnlyLocalRequests(recorder);
  });
}
