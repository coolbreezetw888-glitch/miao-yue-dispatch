// SPECS-INDEX #764(規格書 .project/specs/測試覆蓋補強.md §三 #764):
// /app/agents/:agentId/permissions(客服權限設定頁)的瀏覽器測試。
//
// **為什麼要補這一頁**:2026-09-24 品管把全部 spec 的 goto() 去重得到 24 條路由,發現這一頁
// 跟另外三頁**e2e 零覆蓋**(見 .claude/skills/automated-testing/SKILL.md 第五節「沒紅 ≠ 驗過」)。
// 這一頁從專案建立至今從來沒有被任何自動化測試造訪過。
//
// 🔴 **這支測試的每一條都是「前提斷言 → 行為斷言」兩段式**,不是形式要求:
//    這個專案已經連續踩過兩次「空清單假通過」(對一張空卡片斷言「裡面沒有按鈕」;對一間
//    staff=0/agent=0 的商家斷言「手機版不溢出」)。所以每一條都要先證明「我要驗的資料真的
//    在畫面上了」,才輪到真正要驗的行為。
//    ⚠️ **未來維護者注意**:如果哪天某條前提斷言過不了,請去查 fixture 為什麼沒建成功,
//    **不要把前提斷言拿掉讓測試變綠**——那會讓整支測試退化成永遠會過的假測試。
//
// fixture(會真的建立一位客服)見 e2e/support/agent-permissions-fixture.ts。

import { devices, expect, test } from "@playwright/test";

import {
  GRANTED_SECTION_KEYS,
  injectAgentPermissionsFixtureSession,
  setupAgentPermissionsFixture,
  teardownAgentPermissionsFixture,
  type AgentPermissionsFixture,
} from "./support/agent-permissions-fixture";
import { primeCurrentMerchant } from "./support/app-shell";
import { assertNoHorizontalOverflow } from "./support/overflow-assert";
import { visibleAgentPermissionSections } from "../src/modules/staff-agent/types";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: AgentPermissionsFixture;
let setupFailed = false;

/** 畫面上「應該」列出來的權限項目。**刻意從原始碼的 visibleAgentPermissionSections() 算出來,
 * 不寫死 16**——否則以後新增/隱藏一項權限,這支測試會紅得莫名其妙(而且會讓人以為是產品壞了)。
 * 這樣寫的同時仍然保有保護力:它釘住的是「畫面渲染的清單 === 原始碼定義的可見清單」,
 * 真正會抓到的 bug 是「AgentPermissionsPage 改成直接用 AGENT_PERMISSION_SECTIONS(漏掉
 * hidden 過濾)」或「某一列渲染不出來」。 */
const VISIBLE_SECTIONS = visibleAgentPermissionSections();

/** types.ts 裡唯一標了 hidden: true 的那一項(2026-09-24 使用者指示刻意隱藏)。
 * 這個字串**故意寫死**:它代表的是「這個 label 不可以出現在畫面上」,寫死才能在有人
 * 不小心把 hidden 拿掉時真的紅起來。 */
const HIDDEN_SECTION_LABEL = "排班一覽";

/** 權限列的定位器。#764 T2 會先驗證「渲染出來的 label 陣列 === VISIBLE_SECTIONS 的 label 陣列」,
 * 之後其他測試才可以安心用 index 定位到某一項(index 的正確性由 T2 背書)。 */
function permissionItems(page: import("@playwright/test").Page) {
  return page.locator("main ul > li");
}

function sectionIndex(key: string): number {
  const index = VISIBLE_SECTIONS.findIndex((s) => s.key === key);
  if (index < 0) {
    throw new Error(
      `測試設定錯誤:visibleAgentPermissionSections() 裡找不到 section_key「${key}」。` +
        "這通常代表 types.ts 的權限清單改過了,請同步檢查 agent-permissions-fixture.ts 的 GRANTED_SECTION_KEYS。",
    );
  }
  return index;
}

test.beforeAll(async () => {
  try {
    fixture = await setupAgentPermissionsFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[agent-permissions] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownAgentPermissionsFixture(fixture);
  console.log(
    "[agent-permissions] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectAgentPermissionsFixtureSession(page, fixture);

  // 啟動步驟:先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage,避免後面直接深連結
  // 到受保護頁面時被 RequireMerchantAdmin 守衛誤判導回 /app。見 e2e/support/app-shell.ts。
  await primeCurrentMerchant(page);
});

/** 進入客服權限設定頁,並等到「這位客服的名字」真的出現在 <h1> 上。
 *
 * ⚠️ **不能只等「權限設定」四個字**:AgentPermissionsPage.tsx L60-62 的 <h1> 是動態的——
 *    agents 查詢還沒回來時顯示「權限設定」,查到之後才變成「{name} 的權限設定」。
 *    等前者會在資料還沒載到時就往下跑,是一個真實存在的競態。 */
async function gotoAgentPermissions(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`/app/agents/${fixture.agentId}/permissions`);
  await expect(page.getByRole("heading", { name: `${fixture.agentName} 的權限設定` })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // 前提斷言:權限清單真的渲染出來了(不是還卡在「載入中⋯」)。所有後續斷言都建立在這之上。
  await expect(permissionItems(page)).toHaveCount(VISIBLE_SECTIONS.length, {
    timeout: LOAD_TIMEOUT,
  });
}

test("T1 標題顯示的是「這位客服」的名字,不是通用的「權限設定」", async ({ page }) => {
  await page.goto(`/app/agents/${fixture.agentId}/permissions`);

  // 行為斷言:heading 逐字等於「{客服姓名} 的權限設定」。
  // 這條釘住了 AgentPermissionsPage.tsx L29-34 的 agents 查詢真的查得到這間商家的客服,
  // 而且 .find((a) => a.id === agentId) 真的對上了網址上的 agentId——只要查詢壞掉或
  // agentId 對不上,畫面會永遠停在通用的「權限設定」,這條就會逾時。
  const heading = page.getByRole("heading", { name: `${fixture.agentName} 的權限設定` });
  await expect(heading).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(heading).toHaveText(`${fixture.agentName} 的權限設定`);
});

test("T2 權限開關逐列渲染,清單內容與原始碼定義一致,而且不含刻意隱藏的那一項", async ({ page }) => {
  await gotoAgentPermissions(page);

  // 前提斷言已經在 gotoAgentPermissions() 裡做完(列數 === 可見清單長度)。
  // 行為斷言 ①:每一列的 label 逐字、逐順序對上原始碼定義。
  // ⚠️ 刻意比對「整個陣列」而不是逐一 getByText:很多 label(例如「服務人員管理」)同時出現在
  //    別項的 description 裡(business_hours 的說明就引用了「服務人員管理」),逐一 getByText
  //    會直接撞 strict mode violation。
  const renderedLabels = await permissionItems(page)
    .locator("> div > p:nth-child(1)")
    .allTextContents();
  expect(renderedLabels).toEqual(VISIBLE_SECTIONS.map((s) => s.label));

  // 行為斷言 ②:每一列都真的有一個開關(不是只有文字)。
  await expect(permissionItems(page).getByRole("switch")).toHaveCount(VISIBLE_SECTIONS.length);

  // 行為斷言 ③:標了 hidden: true 的那一項「排班一覽」完全不出現在畫面上。
  // 這條是唯一能抓到「有人把 visibleAgentPermissionSections() 換回 AGENT_PERMISSION_SECTIONS」
  // 的保護,不能省。
  await expect(page.getByText(HIDDEN_SECTION_LABEL, { exact: true })).toHaveCount(0);
});

test("T3 開關狀態真的反映資料庫(開 / 關混合,不是渲染一堆預設 false)", async ({ page }) => {
  await gotoAgentPermissions(page);

  // 🔴 這一條是本頁最容易假通過的地方:全新客服的 merchant_agent_permissions 是空的,
  //    16 個開關會**全部都是關的**,這時候斷言「開關存在」等於什麼都沒驗。
  //    所以 fixture 預先打開了 GRANTED_SECTION_KEYS 這 2 項,讓畫面有開 / 關混合的狀態。
  //
  // 前提斷言:fixture 真的宣稱它開了這 2 項(fixture 自己在寫入失敗時會 throw)。
  expect(fixture.grantedSectionKeys).toEqual([...GRANTED_SECTION_KEYS]);

  const items = permissionItems(page);

  // 行為斷言 ①:fixture 開過的那 2 項,畫面上是「開」。
  for (const key of GRANTED_SECTION_KEYS) {
    await expect(
      items.nth(sectionIndex(key)).getByRole("switch"),
      `section_key「${key}」在資料庫裡是 granted=true,畫面上的開關應該是開的`,
    ).toBeChecked();
  }

  // 行為斷言 ②:沒開過的項目,畫面上是「關」。挑 2 項沒被 fixture 碰過的。
  // 有「開 + 關」兩個方向,才證明畫面真的在讀資料,不是把每一格都渲染成同一個狀態。
  const ungrantedKeys = VISIBLE_SECTIONS.map((s) => s.key)
    .filter((key) => !(GRANTED_SECTION_KEYS as readonly string[]).includes(key))
    .slice(0, 2);
  expect(ungrantedKeys).toHaveLength(2);
  for (const key of ungrantedKeys) {
    await expect(
      items.nth(sectionIndex(key)).getByRole("switch"),
      `section_key「${key}」從來沒有被授權過,畫面上的開關應該是關的`,
    ).not.toBeChecked();
  }
});

test("T4 切換一個開關真的寫回資料庫,重新整理之後還在", async ({ page }) => {
  await gotoAgentPermissions(page);

  // 挑一個「目前確定是關的」項目來測寫入往返。用第一個沒被 fixture 授權過的 key。
  const targetKey = VISIBLE_SECTIONS.map((s) => s.key).find(
    (key) => !(GRANTED_SECTION_KEYS as readonly string[]).includes(key),
  ) as string;
  const targetSwitch = permissionItems(page).nth(sectionIndex(targetKey)).getByRole("switch");

  // 前提斷言:它現在真的是關的(否則下面「點開 → 還是開的」可能只是本來就開著)。
  await expect(targetSwitch).not.toBeChecked();

  // 行為斷言:點開 → 等畫面反映(Switch 是受控元件,要等 set_agent_permission 回來、
  // invalidateQueries 重新查完才會變)→ 重新整理 → 仍然是開的。
  // 這條驗的是 set_agent_permission RPC 的完整往返,是本頁唯一的寫入路徑。
  await targetSwitch.click();
  await expect(targetSwitch).toBeChecked({ timeout: LOAD_TIMEOUT });

  await page.reload();
  const afterReload = permissionItems(page).nth(sectionIndex(targetKey)).getByRole("switch");
  await expect(afterReload).toBeChecked({ timeout: LOAD_TIMEOUT });
});

test("T5 返回連結回得到客服名單", async ({ page }) => {
  await gotoAgentPermissions(page);

  const backLink = page.getByRole("link", { name: "← 返回客服名單" });
  await expect(backLink).toBeVisible();
  await backLink.click();
  await expect(page).toHaveURL(/\/app\/agents$/);
  // 前提斷言 + 行為斷言合一:回到客服名單頁之後,這位 fixture 客服真的列在上面
  // (證明剛才那一頁不是憑空冒出來的、也證明返回連結接到正確的清單)。
  await expect(page.getByText(fixture.agentName, { exact: false }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
});

// ---------------------------------------------------------------------------
// 手機版(375×667)排版檢查。
//
// 刻意放在這支 spec 自己裡面、用獨立的 describe 套 test.use(viewport),不是塞進
// e2e/mobile-overflow.spec.ts:那支已經是 10 條的 serial 長鏈,再加進來只會讓爆炸半徑更大;
// 而且那支用的是「對抗性超長字串」fixture,這裡用的是真實資料 fixture,語意本來就不同。
//
// 裝置描述刻意逐欄挑選、不整包 spread(`...devices[...]`)——裝置描述裡的
// `defaultBrowserType: "webkit"` 會被 test.use() 讀到而嘗試啟動 webkit(這台機器/CI 只裝了
// chromium),整包 spread 會直接炸成 `browserType.launch: Executable doesn't exist`。
// 這是已經記錄在 mobile-overflow.spec.ts L58-61 的坑。
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

  test("T6 客服權限設定頁在 375px 手機寬不溢出", async ({ page }) => {
    // 前提斷言:16 列權限真的都渲染出來了(gotoAgentPermissions 內含)。
    // **不對空清單量溢出**——沒有內容當然不會溢出,那是假通過。
    await gotoAgentPermissions(page);

    await assertNoHorizontalOverflow(page, "客服權限設定頁 /app/agents/:agentId/permissions");
  });
});
