// 紅利系統重構 批次 6(規格書 .project/specs/紅利系統重構.md §4.1~§4.5,#836~#841)的 Playwright 測試。
//
// 🔴 **只在本機跑**:`npm run test:e2e:local`(playwright.local.config.ts)。
//    批次 8 收尾(2026-10-01 總驗收裁決)從 e2e/ 搬到 e2e-local/:預設的 playwright.config.ts 連正式庫,
//    規格書規定紅利 e2e 不可以在正式庫跑;e2e-local/ 不在預設 config 的 testDir 裡,`npm run test:e2e`
//    永遠收不到這支(預設基準因此回到 123 條 / 22 檔)。
//    資料改走本機 fixture(e2e-local/support/bonus-fixture.ts):每次新建測試商家,跑完用 service_role
//    硬刪除(先 SELECT 核對範圍再刪),不留任何殘骸。
//
// 涵蓋:
//   1. §4.1 啟用開關關閉 → 四個分頁消失;開啟 → 四個分頁可切換;未儲存就切換分頁 → 小卡窗提示
//   2. §4.2 新增兩條公式、已被設定的項目在下拉裡變灰「已有公式」、刪除、切換模式後另一邊的值仍在
//   3. §4.3 點數使用:儲存後重新整理值仍在、即時範例
//   4. §4.4 推薦系統:開關 1 關閉時兩個數字欄位隱藏
//   5. §4.5 生日獎勵:儲存文案後重新整理仍在;發送紀錄空狀態文字
import { expect, test, type Page } from "@playwright/test";

import { primeCurrentMerchant } from "../e2e/support/app-shell";
import {
  injectSession,
  setupBonusFixture,
  teardownBonusFixture,
  type BonusFixture,
} from "./support/bonus-fixture";
import {
  expectOnlyLocalRequests,
  recordRequestHosts,
  type RequestRecorder,
} from "./support/request-guard";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 90_000 });

let fixture: BonusFixture;
let setupFailed = false;
let recorder: RequestRecorder | null = null;

test.beforeAll(async () => {
  try {
    // 基本模式「每滿 100 元 1 點」、推薦開關 1 開啟(§4.4 要看到兩個數字欄位)—— 見 bonus-fixture。
    fixture = await setupBonusFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[member-points-settings 本機] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownBonusFixture(fixture);
  console.log(
    "[member-points-settings 本機] 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  recorder = recordRequestHosts(page);
  await injectSession(page, fixture.adminSession);
  await primeCurrentMerchant(page);
});

test.afterEach(async () => {
  if (recorder) expectOnlyLocalRequests(recorder);
});

async function openPointsPage(page: Page) {
  await page.goto("/app/member-points");
  await expect(page.getByRole("heading", { name: "紅利點數", exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("啟用紅利點數功能", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
}

test("§4.1:啟用開關獨立區塊;關閉時四個分頁消失,開啟後可切換", async ({ page }) => {
  await openPointsPage(page);
  const featureSwitch = page.getByRole("switch", { name: "啟用紅利點數功能" });
  await expect(featureSwitch).toBeChecked();
  for (const name of ["紅利計算", "點數使用", "推薦系統", "生日獎勵"]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }

  await featureSwitch.click();
  await expect(page.getByText("目前紅利點數功能已關閉")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("tab", { name: "紅利計算" })).toHaveCount(0);

  await page.getByRole("switch", { name: "啟用紅利點數功能" }).click();
  await expect(page.getByRole("tab", { name: "紅利計算" })).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.getByRole("tab", { name: "推薦系統" }).click();
  // exact:「被推薦者消費是否累積紅利」也包含這串字(批次 8 本機實跑抓到的 strict mode 衝突)。
  await expect(
    page.getByRole("switch", { name: "推薦者消費是否累積紅利", exact: true }),
  ).toBeVisible();
});

test("§4.1:有未儲存的改動時切換分頁 → 小卡窗提示;留下來改動還在", async ({ page }) => {
  await openPointsPage(page);
  await page.getByRole("tab", { name: "點數使用" }).click();
  const ratio = page.getByLabel("單次最大使用比例");
  await ratio.fill("37");
  await page.getByRole("tab", { name: "生日獎勵" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByText("這個分頁還有改動沒有儲存")).toBeVisible();
  await page.getByRole("button", { name: "留下來繼續編輯" }).click();
  await expect(ratio).toHaveValue("37");

  await page.getByRole("tab", { name: "生日獎勵" }).click();
  await page.getByRole("button", { name: "放棄改動並切換" }).click();
  await expect(page.getByRole("switch", { name: "是否啟用生日贈點" })).toBeVisible();
});

test("§4.2:進階公式新增兩條、已設定的項目變灰、刪除、切換模式後基本設定的值仍在", async ({
  page,
}) => {
  await openPointsPage(page);
  // 基本設定先填一個值(fixture 是每滿 100 元 1 點)。
  await expect(page.getByLabel("每滿額獲得")).toHaveValue("1");

  await page.getByRole("switch", { name: "進階設定" }).click();
  await expect(page.getByTestId("basic-settings")).toHaveCount(0);
  await page.getByRole("button", { name: "新增公式" }).click();
  await page.getByRole("button", { name: "新增公式" }).click();
  const cards = page.getByTestId("formula-card");
  await expect(cards).toHaveCount(2);

  // 第一條預設是「全部服務項目」⇒ 常駐 `!` 逐字文案。
  await expect(page.getByText("這條套用在", { exact: false })).toBeVisible();

  // 第二條的下拉裡「全部服務項目」已被第一條用掉 ⇒ 變灰 + 已有公式。
  await cards.nth(1).getByRole("combobox").click();
  const allOption = page.getByRole("option", { name: /全部服務項目/ });
  await expect(allOption).toHaveAttribute("aria-disabled", "true");
  await expect(allOption).toContainText("已有公式");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "儲存設定" }).click();
  await expect(page.getByText("已儲存紅利計算設定")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 刪除第二條(二次確認小卡窗)。
  await page.getByTestId("formula-card").nth(1).getByRole("button", { name: "刪除" }).click();
  await page.getByRole("button", { name: "刪除這條公式" }).click();
  await expect(page.getByTestId("formula-card")).toHaveCount(1);
  await page.getByRole("button", { name: "儲存設定" }).click();
  await expect(page.getByText("已儲存紅利計算設定")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 切回基本模式:基本設定的值還在(切換不清空另一邊)。
  await page.reload();
  await expect(page.getByRole("tab", { name: "紅利計算" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByTestId("formula-card")).toHaveCount(1);
  await page.getByRole("switch", { name: "進階設定" }).click();
  await expect(page.getByLabel("每滿額獲得")).toHaveValue("1");
  await page.getByRole("button", { name: "儲存設定" }).click();
  await expect(page.getByText("已儲存紅利計算設定")).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("§4.3:點數使用儲存後重新整理值仍在,範例即時顯示", async ({ page }) => {
  await openPointsPage(page);
  await page.getByRole("tab", { name: "點數使用" }).click();
  await page.getByLabel("兌換比例:點數").fill("100");
  await page.getByLabel("兌換比例:金額").fill("10");
  await page.getByLabel("單次最大使用比例").fill("50");
  await expect(page.getByTestId("redeem-example")).toContainText("5000");
  await page.getByRole("button", { name: "儲存設定" }).click();
  await expect(page.getByText("已儲存點數使用設定")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.reload();
  await page.getByRole("tab", { name: "點數使用" }).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByLabel("單次最大使用比例")).toHaveValue("50");
});

test("§4.4:推薦系統開關 1 關閉時兩個數字欄位隱藏", async ({ page }) => {
  await openPointsPage(page);
  await page.getByRole("tab", { name: "推薦系統" }).click();
  // bonus-fixture 開了開關 1(referral_inviter_reward_enabled = true)。
  await expect(page.getByTestId("referral-reward-fields")).toBeVisible();
  await page.getByRole("switch", { name: "推薦者邀請是否累積紅利" }).click();
  await expect(page.getByTestId("referral-reward-fields")).toHaveCount(0);
});

test("§4.5:生日文案儲存後重新整理仍在;發送紀錄空狀態", async ({ page }) => {
  await openPointsPage(page);
  await page.getByRole("tab", { name: "生日獎勵" }).click();
  const message = page.getByLabel("LINE 文字訊息");
  await message.fill("{{member_name}} 生日快樂,送您 {{points}} 點(e2e)");
  await expect(page.getByText("會員實際會收到")).toBeVisible();
  await page.getByRole("button", { name: "儲存設定" }).click();
  await expect(page.getByText("已儲存生日獎勵設定")).toBeVisible({ timeout: LOAD_TIMEOUT });

  await page.reload();
  await page.getByRole("tab", { name: "生日獎勵" }).click({ timeout: LOAD_TIMEOUT });
  await expect(page.getByLabel("LINE 文字訊息")).toHaveValue(
    "{{member_name}} 生日快樂,送您 {{points}} 點(e2e)",
  );
  await expect(page.getByText("目前尚無生日紅利紀錄")).toBeVisible({ timeout: LOAD_TIMEOUT });
});
