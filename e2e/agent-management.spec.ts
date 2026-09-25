// SPECS-INDEX #795 / #797 / #798(規格書 .project/specs/客服編輯功能.md):
// /app/agents(客服管理頁)的瀏覽器測試。
//
// **為什麼要補這一頁**(規格書 #795 實查):`grep -rn "app/agents" e2e/` 在這支檔案出現之前只有
// agent-permissions.spec.ts 的返回連結會經過它一次,**沒有任何一條測試造訪過客服管理頁本身**。
// #789(編輯)/ #790(恢復)的資料庫行為有 pgTAP module3_05 守著,但「按鈕在不在、點了有沒有反應、
// 表單有沒有帶入現值」完全沒有保護。
//
// 🔴 **每一條都是「前提斷言 → 行為斷言」兩段式**:全新商家的客服清單是**空的**,不先證明 fixture
//    真的建出客服,底下所有「找得到編輯按鈕」的斷言都是對空清單斷言(本專案抓過兩次的假通過模式)。
//    ⚠️ 未來維護者:某條前提斷言過不了,請去查 fixture 為什麼沒建成功,**不要把前提斷言拿掉讓測試變綠**。
//
// **fixture 直接沿用 #765 產出的 e2e/support/agent-permissions-fixture.ts**(規格書 #795 的硬前置就是它):
// 它會建立 1 位商家管理員 + 1 位 status='active' 的客服。這支 spec 不另外蓋第二支 fixture。
//
// **測試順序是刻意設計的(serial)**:
//   T1 前提 → T2 編輯對話框帶入現值 → T3 改值存檔 → T4 驗證失敗不吃資料
//   → T5 移除 → T6 分頁籤(#797,此時名單裡有 1 位已移除、0 位在職,三顆分頁籤的計數才有意義)
//   → T7 手機版 375px 分頁籤不溢出(#797 規格書要求「仍然要實測」)
//   → T8 恢復 → T9 再次移除 + 真正刪除(#798,放最後,因為刪掉之後這位客服就不存在了)
//
// ⚠️ T9 真的會把 fixture 客服硬刪除,所以 afterAll 的 teardownAgentPermissionsFixture() 裡
//    「remove_merchant_agent」那一步會回「找不到指定的客服紀錄」——那是預期中的,商家本身仍會被正常
//    軟停用。反過來說,這支 spec 比其他 spec 多清掉了一列正式庫的 merchant_agents(#638 的技術債
//    這裡反而少留一筆)。

import { devices, expect, test, type Page } from "@playwright/test";

import {
  injectAgentPermissionsFixtureSession,
  setupAgentPermissionsFixture,
  teardownAgentPermissionsFixture,
  type AgentPermissionsFixture,
} from "./support/agent-permissions-fixture";
import { primeCurrentMerchant } from "./support/app-shell";
import { assertNoHorizontalOverflow } from "./support/overflow-assert";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: AgentPermissionsFixture;
let setupFailed = false;

/** T3 改暱稱用的新值;帶 runId 是為了跟正式庫裡其他殘留的 E2E 資料區分。 */
function newNickname(): string {
  return `e2e改後暱稱${fixture.runId}`;
}

/** fixture 建客服時用的電話(agent-permissions-fixture.ts L137 的同一條公式)。
 * fixture 沒有把它 export 出來,這裡照公式重算——T2 要驗「電話欄位帶入了現值」。 */
function fixturePhone(): string {
  return `09${fixture.runId.slice(-8)}`;
}

test.beforeAll(async () => {
  try {
    fixture = await setupAgentPermissionsFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[agent-management] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownAgentPermissionsFixture(fixture);
  console.log(
    "[agent-management] fixture 清理結果(T9 已硬刪除客服時,「移除 fixture 客服」那一行會回找不到,屬預期):\n" +
      actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectAgentPermissionsFixtureSession(page, fixture);
  // 先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage(見 e2e/support/app-shell.ts)。
  await primeCurrentMerchant(page);
});

/** 客服名單裡的每一列(AgentListPage.tsx 的 <ul> → <li>)。 */
function agentRows(page: Page) {
  return page.locator("main ul > li");
}

/** fixture 那位客服的那一列。用姓名做 hasText(暱稱改了之後姓名仍在,定位不會失效)。 */
function fixtureRow(page: Page) {
  return agentRows(page).filter({ hasText: fixture.agentName });
}

/** 進客服管理頁,並先做前提斷言:名單真的有列、fixture 客服真的在上面。 */
async function gotoAgents(page: Page): Promise<void> {
  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "客服管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // 🔴 前提斷言:清單列數 > 0(規格書 #795 第 1 條)。全新商家客服清單是空的,不先證明這件事,
  //    底下每一條「找得到某顆按鈕」都可能是對空清單斷言。
  await expect(agentRows(page).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  expect(await agentRows(page).count()).toBeGreaterThan(0);
  await expect(fixtureRow(page)).toHaveCount(1);
}

/** 點該列的「編輯」,回傳打開的對話框 locator。 */
async function openEditDialog(page: Page) {
  await fixtureRow(page).getByRole("button", { name: "編輯" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "編輯客服資料" })).toBeVisible();
  return dialog;
}

test("T1 前提:客服名單列數 > 0,而且找得到 fixture 建的那位客服", async ({ page }) => {
  await gotoAgents(page);
  // gotoAgents 已經做完「列數 > 0」與「fixture 那一列恰好 1 筆」;這裡再明確驗姓名與狀態徽章。
  await expect(fixtureRow(page).getByText(fixture.agentName, { exact: false })).toBeVisible();
  // fixture 走的是「既有帳號直接開通」分支 ⇒ status='active' ⇒ 徽章是「已啟用」。
  await expect(fixtureRow(page).getByText("已啟用", { exact: true })).toBeVisible();
});

test("T2 「編輯」打開的對話框帶入現值,而且沒有「聯絡 Email」與「是否上架」欄位", async ({
  page,
}) => {
  await gotoAgents(page);
  const dialog = await openEditDialog(page);

  // 行為斷言 ①:四個欄位帶入現值(不是空白表單)。fixture 沒設暱稱/職位,所以那兩欄應該是空字串;
  // 姓名與電話必須是 fixture 寫進去的值——這才證明表單真的在讀該列資料,不是渲染預設值。
  await expect(dialog.getByLabel("姓名")).toHaveValue(fixture.agentName);
  await expect(dialog.getByLabel("暱稱")).toHaveValue("");
  await expect(dialog.getByLabel("職位")).toHaveValue("");
  await expect(dialog.getByLabel("電話")).toHaveValue(fixturePhone());

  // 行為斷言 ②(守住 #792 / #793 的決定):對話框裡找不到「聯絡 Email」與「上架」。
  // contact_email 欄位 2026-09-24 已連同資料庫欄位一起廢除;客服沒有 is_listed。
  await expect(dialog.getByText("聯絡 Email")).toHaveCount(0);
  await expect(dialog.getByText("上架")).toHaveCount(0);
  await expect(dialog.getByRole("switch")).toHaveCount(0);
});

test("T3 改一個值 → 存檔 → toast 成功 → 清單上那一列顯示新值", async ({ page }) => {
  await gotoAgents(page);
  const dialog = await openEditDialog(page);

  // 前提:改之前清單上還沒有這個暱稱(否則「顯示新值」可能只是本來就在)。
  await expect(page.getByText(newNickname())).toHaveCount(0);

  await dialog.getByLabel("暱稱").fill(newNickname());
  await dialog.getByRole("button", { name: "儲存" }).click();

  await expect(page.getByText("客服資料已更新")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog).toBeHidden();
  // AgentListPage 的顯示格式是 `${name}(${nickname})`。
  await expect(fixtureRow(page)).toContainText(`${fixture.agentName}(${newNickname()})`, {
    timeout: LOAD_TIMEOUT,
  });
});

test("T4 電話填 0912(格式錯)→ 儲存 → 看到白話錯誤,而且對話框沒有關閉", async ({ page }) => {
  await gotoAgents(page);
  const dialog = await openEditDialog(page);

  await dialog.getByLabel("電話").fill("0912");
  await dialog.getByRole("button", { name: "儲存" }).click();

  // ⚠️ 規格書 #795 第 5 條寫「含『09 開頭』字樣」——那是**資料庫函式**的錯誤文案;實際上前端會先用
  //    isValidTaiwanMobilePhone() 擋下,toast 顯示的是 src/lib/validation.ts 的 TW_MOBILE_PHONE_ERROR_MESSAGE
  //    「請輸入正確的手機號碼格式,例如 0912345678」,請求根本不會送到資料庫。所以這裡斷言的是前端那句;
  //    欄位下方的靜態說明文字才有「09 開頭」。已在回報裡註明規格書這一條的期望值要更正。
  await expect(page.getByText("請輸入正確的手機號碼格式", { exact: false })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(dialog.getByText("09 開頭", { exact: false })).toBeVisible();
  // 對話框沒有關閉,而且剛才打的值還在(資料沒有被吃掉)。
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("電話")).toHaveValue("0912");
  // 清單上的暱稱仍是 T3 的值(這次失敗的送出沒有動到任何資料)。
  await page.keyboard.press("Escape");
  await expect(fixtureRow(page)).toContainText(newNickname());
});

test("T5 移除 → 出現「已移除」徽章、「恢復」按鈕出現、「編輯」按鈕消失", async ({ page }) => {
  await gotoAgents(page);
  const row = fixtureRow(page);

  // 前提:移除前這一列有「編輯」、沒有「恢復」。
  await expect(row.getByRole("button", { name: "編輯" })).toBeVisible();
  await expect(row.getByRole("button", { name: "恢復" })).toHaveCount(0);

  await row.getByRole("button", { name: "移除" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("確定要移除這位客服嗎?")).toBeVisible();
  await confirm.getByRole("button", { name: "確定移除" }).click();

  await expect(page.getByText("已移除客服")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(row.getByText("已移除", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(row.getByRole("button", { name: "恢復" })).toBeVisible();
  await expect(row.getByRole("button", { name: "編輯" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "權限設定" })).toHaveCount(0);
});

test("T6 #797 分頁籤:全部 / 在職 (n) / 已移除 (n),切換後名單真的被篩選", async ({ page }) => {
  await gotoAgents(page);

  // 前提:T5 之後 fixture 客服是已移除狀態(否則底下的計數斷言沒有區分度)。
  await expect(fixtureRow(page).getByText("已移除", { exact: true })).toBeVisible();

  // 三顆分頁籤,計數格式比照服務人員頁:「全部」不帶數字,其餘帶 (n)。
  // 這間 fixture 商家只有這 1 位客服 ⇒ 在職 (0)、已移除 (1)。
  const allTab = page.getByRole("tab", { name: "全部" });
  const activeTab = page.getByRole("tab", { name: "在職 (0)" });
  const removedTab = page.getByRole("tab", { name: "已移除 (1)" });
  await expect(allTab).toBeVisible();
  await expect(activeTab).toBeVisible();
  await expect(removedTab).toBeVisible();
  // 守住 #792:客服分頁籤不可以出現「上架」。
  await expect(page.getByRole("tab", { name: /上架/ })).toHaveCount(0);

  // 「在職」→ 名單變空,顯示分類空狀態(不是「目前還沒有任何客服。」那個全空狀態)。
  await activeTab.click();
  await expect(page.getByText("這個分類目前沒有客服。")).toBeVisible();
  await expect(agentRows(page)).toHaveCount(0);

  // 「已移除」→ fixture 客服回到名單上。
  await removedTab.click();
  await expect(fixtureRow(page)).toHaveCount(1);

  // 「全部」→ 一樣看得到。
  await allTab.click();
  await expect(fixtureRow(page)).toHaveCount(1);
});

// ---------------------------------------------------------------------------
// 手機版(375×667)排版檢查——規格書 #797:「客服只有三顆會比較寬鬆,但仍然要實測」。
// 裝置描述刻意逐欄挑選、不整包 spread(理由見 agent-permissions.spec.ts L219-223 / mobile-overflow.spec.ts)。
// ---------------------------------------------------------------------------
test.describe("手機版 375px 排版", () => {
  const IPHONE_SE_3RD_GEN = devices["iPhone SE (3rd gen)"];
  test.use({
    viewport: IPHONE_SE_3RD_GEN.viewport,
    userAgent: IPHONE_SE_3RD_GEN.userAgent,
    deviceScaleFactor: IPHONE_SE_3RD_GEN.deviceScaleFactor,
    isMobile: IPHONE_SE_3RD_GEN.isMobile,
    hasTouch: IPHONE_SE_3RD_GEN.hasTouch,
  });

  test("T7 #797 客服管理頁(含三顆分頁籤)在 375px 手機寬不溢出", async ({ page }) => {
    await gotoAgents(page);
    // 前提:三顆分頁籤真的渲染出來了(不對沒有分頁籤的畫面量溢出,那是假通過)。
    await expect(page.getByRole("tab", { name: "已移除 (1)" })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(3);

    await assertNoHorizontalOverflow(page, "客服管理頁 /app/agents(含 #797 分頁籤)");
  });
});

test("T8 點「恢復」→「已移除」徽章消失、「編輯」按鈕回來", async ({ page }) => {
  await gotoAgents(page);
  const row = fixtureRow(page);

  // 前提:目前是已移除狀態。
  await expect(row.getByText("已移除", { exact: true })).toBeVisible();

  await row.getByRole("button", { name: "恢復" }).click();
  await expect(page.getByText("已恢復這位客服")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // fixture 客服 user_id 與 activated_at 都有值 ⇒ restore_merchant_agent 恢復成 'active' ⇒「已啟用」。
  await expect(row.getByText("已啟用", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(row.getByText("已移除", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "編輯" })).toBeVisible();
  await expect(row.getByRole("button", { name: "恢復" })).toHaveCount(0);
  // 分頁籤計數跟著更新。
  await expect(page.getByRole("tab", { name: "在職 (1)" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "已移除 (0)" })).toBeVisible();
});

test("T9 #798 真正刪除:只出現在已移除那一列、二次確認講明無法復原、確認後那一列真的消失", async ({
  page,
}) => {
  await gotoAgents(page);
  const row = fixtureRow(page);

  // 前提 ①:在職狀態下**沒有**「真正刪除」按鈕(必須先軟移除,兩段式防呆)。
  await expect(row.getByRole("button", { name: "編輯" })).toBeVisible();
  await expect(row.getByRole("button", { name: "真正刪除" })).toHaveCount(0);

  // 先軟移除。
  await row.getByRole("button", { name: "移除" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確定移除" }).click();
  await expect(row.getByText("已移除", { exact: true })).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 前提 ②:已移除之後「恢復」跟「真正刪除」並排出現。
  await expect(row.getByRole("button", { name: "恢復" })).toBeVisible();
  const hardDeleteButton = row.getByRole("button", { name: "真正刪除" });
  await expect(hardDeleteButton).toBeVisible();

  // 行為 ①:二次確認對話框明確講「無法復原」,而且標題帶這位客服的名字(不是通用文案)。
  await hardDeleteButton.click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText(`確定要真正刪除「${fixture.agentName}」嗎?`)).toBeVisible();
  await expect(confirm.getByText("無法復原", { exact: false })).toBeVisible();
  // 先按「取消」一次:取消之後什麼都不該發生,那一列還在。
  await confirm.getByRole("button", { name: "取消" }).click();
  await expect(confirm).toBeHidden();
  await expect(fixtureRow(page)).toHaveCount(1);

  // 行為 ②:再打開,這次確認 → toast → 那一列消失 → 名單回到全空狀態(這間商家只有這一位客服)。
  await hardDeleteButton.click();
  await page.getByRole("alertdialog").getByRole("button", { name: "確定真正刪除" }).click();
  await expect(page.getByText("已真正刪除")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(fixtureRow(page)).toHaveCount(0, { timeout: LOAD_TIMEOUT });
  await expect(page.getByText("目前還沒有任何客服。")).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 行為 ③:重新整理之後也還是不在(不是前端把那一列藏起來而已,資料庫真的沒有了)。
  await page.reload();
  await expect(page.getByRole("heading", { name: "客服管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("目前還沒有任何客服。")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(fixtureRow(page)).toHaveCount(0);
});
