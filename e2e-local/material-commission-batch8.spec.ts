// 「料錢影響服務人員抽成開關 第 8 批」(#985)本機 e2e。
// 規格書:.project/specs/料錢是否影響抽成開關-第8批.md 第八節 e2e-local。
// 只連本機 Docker 的 Supabase(`npm run test:e2e:local`),瀏覽器一律 Playwright headless;
// 每一條都斷言「這一頁只打本機」(request-guard)。
//
//   F1 管理員在料錢成本管理頁開啟開關(確認窗 → 確定)→ 資料庫 = 扣料錢 → 完成 B1 →
//      服務人員報表顯示「扣除料錢 $500」與較低的抽成 $1,000
//   F2 管理員關閉開關 → 完成 B2 → 店家報表「總抽成支出」小字顯示混合(1 筆先扣、1 筆沒扣)
//   F3 抽成與薪資設定頁:二選一不見了,只剩唯讀一行 + 連到料錢成本管理
//   F4 只有「料錢成本管理」權限的客服:看得到開關但不能操作,附 `!` 說明
//   F5 手機 375 寬:料錢成本管理頁不爆版(沒有橫向捲動),截圖存 test-results
import { mkdirSync } from "node:fs";

import { devices, expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import { expectOnlyLocalRequests, recordRequestHosts } from "./support/request-guard";
import {
  clientAs,
  completeBooking,
  injectSession,
  serviceClient,
  setupMaterialCommissionFixture,
  teardownMaterialCommissionFixture,
  type MaterialCommissionFixture,
} from "./support/material-commission-fixture";

const LOAD_TIMEOUT = 20_000;
const SHOT_DIR = "test-results/req985-batch8-shots";
const SWITCH_NAME = "料錢影響服務人員抽成";

test.describe.configure({ mode: "serial" });

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
  console.log("[料錢抽成第8批] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

async function openMaterialCostsAsAdmin(page: Page) {
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/material-costs");
  return page.getByRole("switch", { name: SWITCH_NAME });
}

async function basisType(): Promise<string | null> {
  const r = await serviceClient()
    .from("merchant_payroll_settings")
    .select("commission_basis_type")
    .eq("merchant_id", fixture.merchantId)
    .maybeSingle();
  if (r.error) throw new Error(r.error.message);
  return (r.data?.commission_basis_type as string | undefined) ?? null;
}

test("F1 開啟開關 → 完成訂單 → 服務人員報表顯示扣除料錢與較低抽成", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  const sw = await openMaterialCostsAsAdmin(page);
  await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  // 新商家可能已有預設列(gross)或沒有列,兩者都代表「關閉」。
  expect(["gross", null]).toContain(await basisType());

  await sw.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("確定要開啟料錢影響抽成？")).toBeVisible();
  await dialog.getByRole("button", { name: "確定" }).click();
  await expect(page.getByText("已更新").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  expect(await basisType()).toBe("net_of_material_cost");

  await completeBooking(fixture, fixture.booking1Id);

  await page.goto(`/app/staff-report?staffId=${fixture.staffId}`);
  const card = page.getByRole("listitem").filter({ hasText: "E2E第8批客戶1" });
  await expect(card).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(card).toContainText("扣除料錢");
  await expect(card).toContainText("$500");
  await expect(card).toContainText("$2,500");
  await expect(card).toContainText("$1,000");
  expectOnlyLocalRequests(recorder);
});

test("F2 關閉開關 → 再完成一筆 → 店家報表小字顯示期間中切換過", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  const sw = await openMaterialCostsAsAdmin(page);
  await expect(sw).toHaveAttribute("aria-checked", "true", { timeout: LOAD_TIMEOUT });
  await sw.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("確定要關閉料錢影響抽成？")).toBeVisible();
  await dialog.getByRole("button", { name: "確定" }).click();
  await expect(sw).toHaveAttribute("aria-checked", "false", { timeout: LOAD_TIMEOUT });
  expect(await basisType()).toBe("gross");

  await completeBooking(fixture, fixture.booking2Id);
  const recs = await serviceClient()
    .from("booking_commission_records")
    .select("booking_id,commission_amount,material_cost_deducted_snapshot")
    .eq("merchant_id", fixture.merchantId)
    .order("commission_amount");
  expect(recs.data).toEqual([
    {
      booking_id: fixture.booking1Id,
      commission_amount: 1000,
      material_cost_deducted_snapshot: 500,
    },
    { booking_id: fixture.booking2Id, commission_amount: 1200, material_cost_deducted_snapshot: 0 },
  ]);

  await page.goto("/app/billing-report");
  await expect(
    page.getByText("這段期間有 1 筆抽成先扣料錢、1 筆沒有扣（期間中切換過設定）。"),
  ).toBeVisible({ timeout: LOAD_TIMEOUT });
  expectOnlyLocalRequests(recorder);
});

test("F3 抽成與薪資設定頁只剩唯讀一行 + 連結", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/payroll-settings");
  const line = page.getByTestId("payroll-material-commission-readonly");
  await expect(line).toHaveText("料錢影響抽成：目前關閉。要修改請到「料錢成本管理」。", {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByRole("radiogroup", { name: "抽成基準" })).toHaveCount(0);
  await line.getByRole("link", { name: "「料錢成本管理」" }).click();
  await expect(page.getByRole("switch", { name: SWITCH_NAME })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  expectOnlyLocalRequests(recorder);
});

test("F4 只有料錢成本管理權限的客服:看得到開關、不能操作", async ({ page }) => {
  const recorder = recordRequestHosts(page);
  await injectSession(page, fixture.agentSession);
  await primeCurrentMerchant(page, LOAD_TIMEOUT);
  await page.goto("/app/material-costs");
  const sw = page.getByRole("switch", { name: SWITCH_NAME });
  await expect(sw).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(sw).toBeDisabled();
  await expect(
    page.getByText("只有商家管理員或有「抽成與薪資設定」權限的人可以修改。"),
  ).toBeVisible();
  // 後端也擋:直接呼叫寫入 RPC ⇒ 42501,設定不變(前端只是停用開關,不是唯一防線)。
  const r = await clientAs(fixture.agentSession).rpc("set_material_cost_affects_commission", {
    p_merchant_id: fixture.merchantId,
    p_enabled: true,
  });
  expect(r.error?.code).toBe("42501");
  expect(await basisType()).toBe("gross");
  expectOnlyLocalRequests(recorder);
});

test("F5 手機 375 寬:料錢成本管理頁不爆版", async ({ browser }) => {
  const iphone = devices["iPhone SE (3rd gen)"];
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
    userAgent: iphone.userAgent,
    deviceScaleFactor: iphone.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  const recorder = recordRequestHosts(page);
  const sw = await openMaterialCostsAsAdmin(page);
  await expect(sw).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.getByRole("button", { name: "說明：料錢影響抽成的開關會影響哪些訂單" }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOT_DIR}/material-costs-375.png`, fullPage: true });
  await sw.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  // #986 第 9 批(第 8 批 QA 建議):確認窗有淡入 / 縮放動畫,截圖前等動畫全部跑完,免得拍到半透明的窗。
  //    只看確認窗本身(含子元素)的動畫,頁面上若有轉圈圈這種無限動畫不會卡住。
  await page.waitForFunction(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return (
      dialog !== null &&
      dialog.getAnimations({ subtree: true }).every((a) => a.playState !== "running")
    );
  });
  await page.screenshot({ path: `${SHOT_DIR}/material-costs-375-confirm.png` });
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();
  expectOnlyLocalRequests(recorder);
  await context.close();
});
