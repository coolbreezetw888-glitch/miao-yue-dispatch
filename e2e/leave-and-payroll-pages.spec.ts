// SPECS-INDEX #712 / #762 / #763(規格書 .project/specs/測試覆蓋補強.md §三):
// /app/leave-types(月薪人員假別設定)、/app/leave-records(請假紀錄)、
// /app/payroll-settings(抽成與薪資設定)三頁的瀏覽器測試。
//
// **為什麼要補這三頁**:2026-09-24 品管把全部 spec 的 goto() 去重得到 24 條路由,發現這三頁
// 跟 /app/agents/:agentId/permissions **e2e 零覆蓋**(見 .claude/skills/automated-testing/SKILL.md
// 第五節「🔴 還要記得:沒紅 ≠ 驗過」)。2026-09-24 的用語統一批次改到了這幾頁,卻沒有任何
// 自動化測試會造訪它們——「只有 2 條測試壞掉」一部分只是因為改到的頁面本來就沒被測過。
//
// 🔴 **每一條測試都是「前提斷言 → 行為斷言」兩段式**,順序不可調換:
//    先證明「我要驗的那筆資料真的出現在畫面上了」,才輪到真正要驗的行為。
//    這不是形式要求——這個專案連續踩過兩次「空清單假通過」:
//      ① 對一張空卡片斷言「裡面沒有按鈕」(0 === 0,永遠通過);
//      ② 對一間 staff=0 的商家斷言「手機版不溢出」(沒有內容當然不會溢出)。
//    ⚠️ **未來維護者注意**:某條前提斷言過不了的時候,請去查 fixture 為什麼沒建成功,
//    **不要把前提斷言拿掉讓測試變綠**——那會讓整支測試退化成永遠會過的假測試。
//
// **fixture 共用說明(規格書 §3.1)**:這三頁共用既有的 e2e/support/payroll-fixture.ts,
// 因為它一次 setup 剛好把三頁需要的前提資料全部湊齊(3 筆預設假別 + 事假的 full_day_rate
// 扣款規則 + 抽成制服務人員含 20% 抽成 + 月薪制服務人員含月薪 3000 + 已完成訂單 + 一筆請假紀錄),
// 而且它的常數是導出的、可斷言的,不用猜畫面上會出現什麼數字。
//
// ⚠️ **共用的代價,誠實寫在這裡**:payroll-fixture 的 teardown 是 **id-based**
//    (`.in("id", [...])` + disableFixtureMerchant),**只在同一次 run 內有效**。這支 spec 自己
//    呼叫 setupPayrollFixture() = **另外多建一間測試商家**,不是跟 payroll-reports.spec.ts
//    共用同一間。⇒ 每跑一次完整 e2e 會比以前多一間 `E2E薪資帳務測試商家<runId>`
//    + 2 位服務人員 + 1 筆訂單 + 1 筆請假紀錄 + (#712 T3)1 筆新假別
//    + (#763 T4)1 列 merchant_staff_service_items,納進 SPECS-INDEX #638 的總清理量。
//
// 📌 **刻意不塞進 e2e/payroll-reports.spec.ts 共用同一次 beforeAll**(可以省一間商家):
//    那支是 mode: "serial" 且目前只有 2 條測試,塞進十幾條新測試後,任何一條早期失敗就會把
//    後面全部吃掉——那正是 SKILL 第五節記錄的 payroll-reports.spec.ts 事故本身。
//    多花一間測試商家,換「失敗爆炸半徑不擴散」,值得。

import { devices, expect, test, type Page } from "@playwright/test";

import {
  COMMISSION_RATE_PERCENTAGE,
  EXPECTED_COMMISSION_AMOUNT,
  MONTHLY_BASE_SALARY,
  MONTHLY_SALARY_STAFF_NAME_PREFIX,
  PIECE_RATE_STAFF_NAME_PREFIX,
  injectPayrollFixtureSession,
  setupPayrollFixture,
  teardownPayrollFixture,
  type PayrollFixture,
} from "./support/payroll-fixture";
import { primeCurrentMerchant } from "./support/app-shell";
import { assertNoHorizontalOverflow } from "./support/overflow-assert";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: PayrollFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupPayrollFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[leave-and-payroll-pages] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownPayrollFixture(fixture);
  console.log(
    "[leave-and-payroll-pages] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"),
  );
});

test.beforeEach(async ({ page }) => {
  await injectPayrollFixtureSession(page, fixture);

  // 啟動步驟:先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage,避免後面直接深連結
  // 到受保護頁面時被 Require*Access 守衛誤判導回 /app。見 e2e/support/app-shell.ts。
  await primeCurrentMerchant(page);
});

/** 用 CardTitle 的**逐字**文字定位到那整張 Card(shadcn 的 Card 根容器固定帶 `bg-card`)。
 *
 * ⚠️ 為什麼一定要 scope 到卡片、不能用整頁的 getByText:
 *   ① `載入中⋯` 這四個字在這幾頁的**每一個區塊**逐字重複出現,沒有 scope 一定撞 strict mode;
 *   ② /app/payroll-settings 有三個獨立區塊,服務人員姓名要分別落在正確的卡片裡才算驗到。
 *   exact: true 是必要的——例如「抽成制服務人員」同時出現在「商家層級設定」的說明文字裡,
 *   但那個元素的**完整**文字不等於這五個字,所以 exact 比對不會誤抓。 */
function cardByTitle(page: Page, title: string) {
  return page.locator("div.bg-card").filter({ has: page.getByText(title, { exact: true }) });
}

/** 頁面主體(<main>)裡唯一那份清單的每一列。這三頁的清單都是 `<ul class="space-y-2"><li>`,
 * 而 AppLayout 的頁首/底部分頁籤都沒有用到 <ul>(已查證),所以這個選擇器只會命中內容清單。 */
function listItems(scope: Page | ReturnType<typeof cardByTitle>) {
  return scope.locator("ul > li");
}

// =========================================================================
// 【#712】/app/leave-types —— 月薪人員假別設定
// =========================================================================
test.describe("#712 /app/leave-types 月薪人員假別設定", () => {
  async function gotoLeaveTypes(page: Page) {
    await page.goto("/app/leave-types");
    // 等 <h1> 出現當作「頁面載完了」的錨點。⚠️ 一定要用 getByRole("heading"):AppLayout 的頁首
    // 也有一個 <p data-testid="app-header-title"> 顯示同一串文字,用 getByText 會撞 strict mode。
    await expect(page.getByRole("heading", { name: "月薪人員假別設定" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
  }

  test("T1 假別清單列出新商家的三筆預設假別,而且不是空狀態", async ({ page }) => {
    await gotoLeaveTypes(page);

    // 🔴 前提斷言:清單真的渲染出三列。先等到列數對,才代表查詢已經 resolve——如果直接斷言
    //    「空狀態文字 count = 0」,在還在「載入中⋯」的瞬間也會通過,那是假的前提。
    const items = listItems(page);
    await expect(items).toHaveCount(3, { timeout: LOAD_TIMEOUT });
    // 反向前提:證明我們不是在對空清單做斷言。
    await expect(page.getByText("目前還沒有任何假別")).toHaveCount(0);

    // 行為斷言:三筆預設假別(事假/病假/特休)由 create_group_and_merchant 自動種入
    // (migration 20260919150100_scheduling_leave_functions.sql L315-330),名稱要逐字對上。
    const names = await items.locator("> div > p:nth-child(1)").allTextContents();
    expect(names.slice().sort()).toEqual(["事假", "特休", "病假"].slice().sort());

    // 行為斷言:三筆都是「上架中」(新種入的預設假別 status='active')。
    await expect(items.getByText("上架中", { exact: true })).toHaveCount(3);
  });

  test("T2 每一列都有「編輯 / 下架」,商家管理員還看得到「扣款規則」", async ({ page }) => {
    await gotoLeaveTypes(page);

    // 前提斷言:「事假」那一列真的存在(不是對一張空卡片斷言「裡面沒有按鈕」)。
    const row = listItems(page).filter({ has: page.getByText("事假", { exact: true }) });
    await expect(row).toHaveCount(1, { timeout: LOAD_TIMEOUT });

    // 行為斷言:三顆按鈕都在這一列裡。
    // 「扣款規則」是權限旗標算出來的(LeaveTypesPage.tsx L176
    //  `merchantRole === "admin" || canManageCommissionSettings === true`),fixture 帳號是這間
    //  商家的管理員 ⇒ 必須出現。這條同時釘住了那個判斷沒有壞掉。
    await expect(row.getByRole("button", { name: "扣款規則" })).toBeVisible();
    await expect(row.getByRole("button", { name: "編輯" })).toBeVisible();
    await expect(row.getByRole("button", { name: "下架" })).toBeVisible();
  });

  test("T3 新增一筆假別後真的出現在清單上(寫入路徑真的通)", async ({ page }) => {
    await gotoLeaveTypes(page);

    // 前提斷言:記下目前的列數(應為 3)。
    const items = listItems(page);
    await expect(items).toHaveCount(3, { timeout: LOAD_TIMEOUT });

    // 行為斷言:走完整的新增流程(彈窗 → 填名稱 → 儲存),清單真的多一列。
    // 這是本頁唯一一條會寫入資料的測試,新增的假別會隨 fixture 商家一起被停用(teardown)。
    const newName = `E2E測試假別${fixture.runId}`;
    await page.getByRole("button", { name: "新增假別" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.locator("#leave-type-name").fill(newName);
    await dialog.getByRole("button", { name: "儲存" }).click();

    await expect(items).toHaveCount(4, { timeout: LOAD_TIMEOUT });
    await expect(
      listItems(page).filter({ has: page.getByText(newName, { exact: true }) }),
    ).toHaveCount(1);
  });

  test("T4 用語釘樁:標題與跨頁連結逐字正確", async ({ page }) => {
    await gotoLeaveTypes(page);

    // 2026-09-24 用語統一批次:這個 <h1> 從「假別設定」改成「月薪人員假別設定」,
    // 而且要跟 appLayoutLogic.ts 的頁首標題、ManagePage.tsx 的功能卡片 label 用同一個詞。
    // ⚠️ 刻意用中文字串斷言、不改成 data-testid:「畫面中文字改了、測試就跟著紅」本身就是一層
    //    有用的保護(SKILL 第五節「✅ 修法」),改成 testid 等於把警報器拆掉。
    await expect(
      page.getByRole("heading", { name: "月薪人員假別設定", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("前往「請假紀錄」登記請假 →")).toBeVisible();
  });
});

// =========================================================================
// 【#762】/app/leave-records —— 請假紀錄
// =========================================================================
test.describe("#762 /app/leave-records 請假紀錄", () => {
  async function gotoLeaveRecords(page: Page) {
    await page.goto("/app/leave-records");
    await expect(page.getByRole("heading", { name: "請假紀錄" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
  }

  /** 「紀錄清單」那張卡片裡的列(不要用整頁 ul > li——這一頁另外還有一張篩選卡片)。 */
  function recordItems(page: Page) {
    return listItems(cardByTitle(page, "紀錄清單"));
  }

  test("T1 清單真的有 fixture 建的那筆請假紀錄", async ({ page }) => {
    await gotoLeaveRecords(page);

    // 🔴 前提斷言:先等清單真的渲染出一列(而不是先斷言空狀態文字 count = 0——那在
    //    「載入中⋯」的瞬間也會成立)。
    const items = recordItems(page);
    await expect(items).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(page.getByText("目前沒有符合篩選條件的請假紀錄")).toHaveCount(0);

    // 行為斷言:這一列的四項內容都對得上 fixture 真的寫進資料庫的值。
    const row = items.first();
    // 姓名 ・ 假別快照(LeaveRecordsPage.tsx L455-458)
    await expect(row).toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX);
    await expect(row).toContainText("事假");
    // 起訖日期(fixture 建的是「今天整天」)
    await expect(row).toContainText(fixture.todayDateKey);
    // 狀態徽章:今天整天的假 ⇒ getLeaveRecordDisplayStatus 算出來是 ongoing ⇒「進行中」
    await expect(row.getByText("進行中", { exact: true })).toBeVisible();
  });

  test("T2 篩選器真的會篩(有資料時看得到、條件不符時看不到)", async ({ page }) => {
    await gotoLeaveRecords(page);

    // 前提斷言:不帶任何篩選時,清單有且只有 fixture 那一筆。
    const items = recordItems(page);
    await expect(items).toHaveCount(1, { timeout: LOAD_TIMEOUT });

    // 行為斷言 ①:把「日期區間(起)」設成這筆請假的**隔天** ⇒ 這筆應該被篩掉。
    // 🔴 這條是本頁最有價值的一條:它同時證明了「有資料時看得到」與「條件不符時看不到」
    //    兩個方向——單向斷言(只驗看得到)騙不過去,因為一個永遠回傳全部的假篩選器也會通過。
    const dayAfter = new Date(`${fixture.todayDateKey}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    const dayAfterKey = dayAfter.toISOString().slice(0, 10);

    await page.locator("#leave-filter-from").fill(dayAfterKey);
    await expect(page.getByText("目前沒有符合篩選條件的請假紀錄。")).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(items).toHaveCount(0);

    // 行為斷言 ②:清掉篩選條件,那一筆要回來(證明它只是被篩掉,不是被刪掉)。
    await page.locator("#leave-filter-from").fill("");
    await expect(items).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(items.first()).toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX);
  });

  test("T3 「登記請假」彈窗的兩個下拉真的有選項,而且只列月薪制", async ({ page }) => {
    await gotoLeaveRecords(page);
    // 前提斷言:清單載完了(代表 staffList / leaveTypes 這些查詢也已經在跑),再開彈窗。
    await expect(recordItems(page)).toHaveCount(1, { timeout: LOAD_TIMEOUT });

    await page.getByRole("button", { name: "登記請假" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("登記請假", { exact: true })).toBeVisible();

    // 彈窗裡有兩個 Radix Select(role=combobox):第 0 個是「服務人員」,第 1 個是「假別」。
    // 用 nth 定位是因為 Label 沒有 htmlFor 綁到 SelectTrigger(Radix 的 trigger 是 button)。
    const comboboxes = dialog.getByRole("combobox");
    await expect(comboboxes).toHaveCount(2);

    // 行為斷言 ①:服務人員下拉只列月薪制的人。
    // 這條釘住了 filterMonthlySalaryStaff(scheduling/types.ts §4.3)沒有壞掉——
    // **同時驗「月薪制看得到」與「抽成制看不到」兩個方向**,單向斷言沒有保護力。
    await comboboxes.nth(0).click();
    await expect(page.getByRole("option", { name: fixture.monthlySalaryStaffName })).toBeVisible();
    await expect(page.getByRole("option", { name: fixture.pieceRateStaffName })).toHaveCount(0);
    // 反向前提:空選單提示不該出現(出現就代表我們其實是在對空選單做斷言)。
    await expect(page.getByText("目前沒有月薪制的服務人員")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 行為斷言 ②:假別下拉列出三筆預設假別。
    await comboboxes.nth(1).click();
    for (const name of ["事假", "病假", "特休"]) {
      await expect(page.getByRole("option", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByText("目前沒有可用的假別,請先到「月薪人員假別設定」新增")).toHaveCount(
      0,
    );
    await page.keyboard.press("Escape");

    await page.keyboard.press("Escape");
  });

  test("T4 「取消」的確認彈窗文字正確(按「先不要」,不真的取消)", async ({ page }) => {
    await gotoLeaveRecords(page);

    // 前提斷言:scope 到 fixture 那一筆紀錄。
    const row = recordItems(page).first();
    await expect(row).toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX, { timeout: LOAD_TIMEOUT });

    // 行為斷言:確認彈窗的三串文字逐字正確。
    // exact: true 是必要的——AlertDialogAction 的文字是「確定取消」,含有「取消」這個子字串,
    // 不加 exact 會同時命中兩顆按鈕。
    await row.getByRole("button", { name: "取消", exact: true }).click();
    const alert = page.getByRole("alertdialog");
    await expect(alert.getByText("確定要取消這筆請假紀錄嗎?")).toBeVisible();
    await expect(alert.getByRole("button", { name: "先不要" })).toBeVisible();
    await expect(alert.getByRole("button", { name: "確定取消" })).toBeVisible();

    // 🔴 點「先不要」關掉,**不要真的取消**:這筆請假紀錄是 payroll-fixture 扣款語意的來源,
    //    取消掉之後本檔後面(以及手機版那幾條)的前提就沒了。
    await alert.getByRole("button", { name: "先不要" }).click();
    await expect(alert).toHaveCount(0);
    // 收尾確認:那一筆仍然在清單上,狀態沒變。
    await expect(recordItems(page)).toHaveCount(1);
    await expect(recordItems(page).first().getByText("進行中", { exact: true })).toBeVisible();
  });
});

// =========================================================================
// 【#763】/app/payroll-settings —— 抽成與薪資設定
// =========================================================================
test.describe("#763 /app/payroll-settings 抽成與薪資設定", () => {
  async function gotoPayrollSettings(page: Page) {
    await page.goto("/app/payroll-settings");
    await expect(page.getByRole("heading", { name: "抽成與薪資設定" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
  }

  test("T1 三個區塊都不是空的,而且兩位服務人員各自落在正確的卡片裡", async ({ page }) => {
    await gotoPayrollSettings(page);

    // 🔴 這頁有三個獨立的空狀態,是最容易假通過的一頁。
    // 前提斷言:兩張人員卡片各自真的渲染出一列(先等列數,再驗空狀態文字不存在)。
    const pieceCard = cardByTitle(page, "抽成制服務人員");
    const monthlyCard = cardByTitle(page, "月薪制服務人員");
    await expect(listItems(pieceCard)).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(listItems(monthlyCard)).toHaveCount(1, { timeout: LOAD_TIMEOUT });
    await expect(page.getByText("目前沒有抽成制的服務人員。")).toHaveCount(0);
    await expect(page.getByText("目前沒有月薪制的服務人員。")).toHaveCount(0);

    // 行為斷言:每位服務人員只出現在自己那張卡片裡(不是整頁 getByText 撈到就算數)。
    // 這條釘住了 PayrollSettingsPage.tsx 依 compensation_type 分流的那兩個 filter。
    await expect(pieceCard).toContainText(PIECE_RATE_STAFF_NAME_PREFIX);
    await expect(pieceCard).not.toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX);
    await expect(monthlyCard).toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX);
    await expect(monthlyCard).not.toContainText(PIECE_RATE_STAFF_NAME_PREFIX);
  });

  test("T2 商家層級設定的抽成基準真的反映後端的值", async ({ page }) => {
    await gotoPayrollSettings(page);

    // 前提斷言:這張卡片載完了(scope 到這張卡再等,不能用整頁的 getByText("載入中⋯")——
    // 這四個字在三個區塊逐字重複出現,沒 scope 必撞 strict mode)。
    const card = cardByTitle(page, "商家層級設定");
    await expect(card.locator("#basis-gross")).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(card.getByText("載入中⋯")).toHaveCount(0);

    // 行為斷言:fixture 寫的是 commission_basis_type: "gross"(payroll-fixture.ts L220-226)
    // ⇒「服務金額全額」被選中、「扣除料錢成本後淨額」沒被選中。
    // ⚠️ 這條的價值在於它是**由後端資料決定的**,不是畫面寫死的字:如果查詢壞掉、或
    //    useEffect 沒把值灌進 RadioGroup,兩顆都會是未選中,這條就會紅。
    await expect(card.locator("#basis-gross")).toBeChecked();
    await expect(card.locator("#basis-net")).not.toBeChecked();
  });

  test("T3 月薪制那一列顯示的金額 = fixture 寫進資料庫的金額", async ({ page }) => {
    await gotoPayrollSettings(page);

    // 前提斷言:scope 到月薪制那一列。
    const row = listItems(cardByTitle(page, "月薪制服務人員")).first();
    await expect(row).toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX, { timeout: LOAD_TIMEOUT });

    // 行為斷言:畫面上的金額用 fixture 常數組出來,不寫死 3000——證明 staff_salary_settings
    // 真的被讀出來、真的算成畫面文字。這是本頁最實質的一條。
    await expect(row).toContainText(`月薪 ${MONTHLY_BASE_SALARY} 元`);
  });

  test("T4 抽成制那一列的「已設定 N 項」是真的統計(會隨資料改變)", async ({ page }) => {
    await gotoPayrollSettings(page);

    const row = listItems(cardByTitle(page, "抽成制服務人員")).first();
    await expect(row).toContainText(PIECE_RATE_STAFF_NAME_PREFIX, { timeout: LOAD_TIMEOUT });

    // 🔴 規格書 §三 #763 T4 預測這一列會顯示「已設定 1 項服務的抽成,0 項尚未設定」。
    //    **實跑後的事實不是這樣**,照規格書指示「用實際輸出寫斷言,並在註解說明為什麼」:
    //    這一列的分母 `total` 來自 fetchStaffServiceItemIds()(staff-agent/api.ts L256-263),
    //    查的是 **merchant_staff_service_items**(「這位服務人員可接哪些服務項目」),
    //    而 payroll-fixture 只寫了 **staff_service_commission_rates**(抽成比例),
    //    從來沒有寫過 merchant_staff_service_items ⇒ total = 0
    //    ⇒ 走的是 PayrollSettingsPage.tsx L565-566 的 `total === 0` 分支。
    await expect(row).toContainText("尚未設定任何可接服務項目");

    // 🔴 但只斷言上面那一行,等於對「分母是 0」的空統計做斷言——跟這批要防的「空清單假通過」
    //    是同一種病。所以這裡**用產品自己的操作路徑**把那位服務人員的「可接服務」打開,
    //    再看統計文字有沒有跟著變。統計會從一個分支跳到另一個分支,才證明它是真的在算。
    await row.getByRole("button", { name: "編輯" }).click();
    const dialog = page.getByRole("dialog");
    // 前提斷言:彈窗裡真的列出了這間商家的服務項目(不是對空清單操作)。
    const itemRow = listItems(dialog).filter({ hasText: "E2E測試服務項目" });
    await expect(itemRow).toHaveCount(1, { timeout: LOAD_TIMEOUT });

    // 打開「可接服務」開關 ⇒ 才會渲染抽成模式/數值欄位(決策 6:關的時候直接不渲染)。
    await itemRow.getByRole("switch").click();

    // 行為斷言 ①:欄位帶出來的數值 = fixture 寫進 staff_service_commission_rates 的 20%,
    // 試算金額 = 1000 × 20% = 200(EXPECTED_COMMISSION_AMOUNT)。
    // 這證明抽成設定真的從資料庫讀出來、真的算成畫面數字。
    await expect(itemRow.locator('input[type="number"]')).toHaveValue(
      String(COMMISSION_RATE_PERCENTAGE),
      { timeout: LOAD_TIMEOUT },
    );
    await expect(itemRow).toContainText(`試算:1 件約 ${EXPECTED_COMMISSION_AMOUNT} 元`);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // 行為斷言 ②:回到清單,統計文字已經從「尚未設定任何可接服務項目」變成真的計數。
    // 現在 total = 1(剛剛打開的那一項)、configured = 1(fixture 的 20% 抽成)。
    await expect(row).toContainText("已設定 1 項服務的抽成,0 項尚未設定", {
      timeout: LOAD_TIMEOUT,
    });
  });

  test("T5 月薪編輯彈窗打得開、而且帶入現有值", async ({ page }) => {
    await gotoPayrollSettings(page);

    // 前提斷言:scope 到月薪制那一列。
    const row = listItems(cardByTitle(page, "月薪制服務人員")).first();
    await expect(row).toContainText(MONTHLY_SALARY_STAFF_NAME_PREFIX, { timeout: LOAD_TIMEOUT });

    await row.getByRole("button", { name: "編輯" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`${fixture.monthlySalaryStaffName} 的薪資設定`)).toBeVisible();

    // 行為斷言:欄位帶入資料庫裡的月薪,而且試算文字有算出來。
    await expect(dialog.locator("#base-salary")).toHaveValue(String(MONTHLY_BASE_SALARY), {
      timeout: LOAD_TIMEOUT,
    });
    await expect(dialog.getByText("一天薪水約")).toBeVisible();

    // 🔴 按 Escape 關掉,**不要儲存**——避免改動 payroll-reports.spec.ts 依賴的扣款語意。
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("T6 用語釘樁:2026-09-24 用語統一批次的六串文字逐字正確", async ({ page }) => {
    await gotoPayrollSettings(page);

    // 這一頁是 2026-09-24 用語統一批次改動最多的地方,而且當時完全沒有 e2e 覆蓋。
    // ⚠️ 括號是**全形實心方括號【】**,不是半形 []——抄的時候不要被編輯器換掉。
    // ⚠️ 刻意用中文字串、不改成 data-testid(SKILL 第五節「✅ 修法」):畫面文字改了測試跟著紅,
    //    本身就是這批要保留的警報器。
    await expect(page.getByRole("heading", { name: "抽成與薪資設定", exact: true })).toBeVisible();

    const basisCard = cardByTitle(page, "商家層級設定");
    await expect(basisCard.getByText("【抽成制】抽成基準", { exact: true })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(basisCard.getByText("【月薪制】月折算天數", { exact: true })).toBeVisible();

    await expect(cardByTitle(page, "抽成制服務人員")).toHaveCount(1);
    await expect(cardByTitle(page, "月薪制服務人員")).toHaveCount(1);
    await expect(
      page.getByText("逐一設定每位服務人員每個服務項目的抽成,沒有設定的項目視為 0 元"),
    ).toBeVisible();
  });
});

// =========================================================================
// 手機版(375×667)排版檢查 —— 三頁各一條
//
// 刻意放在這支 spec 自己裡面、用獨立的 describe 套 test.use(viewport),不是塞進
// e2e/mobile-overflow.spec.ts:那支已經是 10 條的 serial 長鏈(#711 剛處理完它的脆弱性),
// 再加 3 條只會讓爆炸半徑更大;而且那支用的是「對抗性超長字串」fixture,這裡用的是真實資料
// fixture,語意本來就不同。
//
// ⚠️ 本頁的溢出驗證只求「真實資料下不溢出」。**不要為了讓它更容易紅而故意塞長備註/長姓名**
//    ——對抗性長字串的溢出驗證是 mobile-overflow.spec.ts 的職責,兩支不要混。
//
// 裝置描述刻意逐欄挑選、不整包 spread:裝置描述裡的 `defaultBrowserType: "webkit"` 會被
// test.use() 讀到而嘗試啟動 webkit(這台機器/CI 只裝了 chromium),整包 spread 會直接炸成
// `browserType.launch: Executable doesn't exist`。這是已記錄在 mobile-overflow.spec.ts 的坑。
// =========================================================================
test.describe("手機版 375px 排版", () => {
  const IPHONE_SE_3RD_GEN = devices["iPhone SE (3rd gen)"];
  test.use({
    viewport: IPHONE_SE_3RD_GEN.viewport,
    userAgent: IPHONE_SE_3RD_GEN.userAgent,
    deviceScaleFactor: IPHONE_SE_3RD_GEN.deviceScaleFactor,
    isMobile: IPHONE_SE_3RD_GEN.isMobile,
    hasTouch: IPHONE_SE_3RD_GEN.hasTouch,
  });

  test("#712 T5 月薪人員假別設定頁在 375px 不溢出", async ({ page }) => {
    await page.goto("/app/leave-types");
    await expect(page.getByRole("heading", { name: "月薪人員假別設定" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    // 🔴 前提斷言:清單真的有內容才量溢出。**不對空清單量溢出**——沒有內容當然不會溢出,
    //    那正是這個專案已經踩過的「空清單假通過」。
    //
    // ⚠️ 這裡不能只寫 `expect(await listItems(page).count()).toBeGreaterThan(0)`:`.count()`
    //    是**一次性快照、不會自動重試**,而 <h1> 出現的時機比假別查詢 resolve 早得多
    //    ——2026-09-25 第一次實跑就真的紅在這裡(count = 0,畫面還停在「載入中⋯」)。
    //    先用會自動重試的 toBeVisible() 等到第一列真的渲染出來,再取一次數量。
    //    **這是修掉測試自己的競態,不是把前提斷言拿掉**——前提斷言原封不動保留在下面。
    await expect(listItems(page).first()).toBeVisible({ timeout: LOAD_TIMEOUT });
    const count = await listItems(page).count();
    expect(count).toBeGreaterThan(0);

    await assertNoHorizontalOverflow(page, "月薪人員假別設定頁 /app/leave-types");
  });

  test("#762 T6 請假紀錄頁在 375px 不溢出", async ({ page }) => {
    await page.goto("/app/leave-records");
    await expect(page.getByRole("heading", { name: "請假紀錄" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    const items = listItems(cardByTitle(page, "紀錄清單"));
    await expect(items).toHaveCount(1, { timeout: LOAD_TIMEOUT });

    await assertNoHorizontalOverflow(page, "請假紀錄頁 /app/leave-records");
  });

  test("#763 T7 抽成與薪資設定頁在 375px 不溢出", async ({ page }) => {
    await page.goto("/app/payroll-settings");
    await expect(page.getByRole("heading", { name: "抽成與薪資設定" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    // 前提斷言:兩張人員卡片都不是空的(這頁三個空狀態,空著量溢出等於沒量)。
    await expect(listItems(cardByTitle(page, "抽成制服務人員"))).toHaveCount(1, {
      timeout: LOAD_TIMEOUT,
    });
    await expect(listItems(cardByTitle(page, "月薪制服務人員"))).toHaveCount(1, {
      timeout: LOAD_TIMEOUT,
    });

    await assertNoHorizontalOverflow(page, "抽成與薪資設定頁 /app/payroll-settings");
  });
});
