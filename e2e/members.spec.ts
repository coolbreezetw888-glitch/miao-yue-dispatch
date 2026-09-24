// 模組 10(會員與紅利)規格書 §7/§8 明確要求的 Playwright 測試:
//   1. 會員管理列表頁(§4.1):建立會員 → 清單正確顯示;下架後預設篩選看不到,重新上架後恢復。
//   2. 會員詳情頁(§4.2,已依 #617 更新):點數區塊簡化成摘要+連結;相關訂單/推薦名單正確顯示
//      fixture 資料。
//   3. 紅利點數管理頁(§10.5/#617,商家端調整批次 2026-09-22 新增):獨立卡片入口(取代原本掛在
//      「功能」的「產業轉移」#601 已隱藏、「訂單管理」#610 已獨立成分頁籤)、餘額總覽搜尋、
//      登記兌換與手動調整只有管理員看得到入口。
//   4. 建單表單疊加 MemberPickerField(§4.4):在「新增預約」表單裡搜尋既有會員、選中後欄位
//      正確顯示選中結果。
//   5. 訂單詳情頁會員連結(§4.5):有 members 權限的管理員在訂單詳情頁看到會員姓名是可點擊連結。
//
// 範圍說明(已在回報時一併提出):3.6/3.7/3.8「選擇既有會員完成訂單後正確核發點數」這條核心
// 業務邏輯,已經由 supabase/tests/database/module10_02_booking_overlay_and_loyalty.sql 的 30
// 條 pgTAP 斷言完整覆蓋(呼叫的是跟前端完全相同的 create_booking/complete_booking RPC)——這裡
// 用 fixture 直接呼叫同一組 RPC 準備好「已連結會員並完成」的訂單,Playwright 只驗證畫面渲染
// 正確,不重覆走一次完整的行事曆日期/時段/服務人員 UI 操作(那部分風險/效益比不划算,這個
// codebase 目前也沒有任何既有 e2e 測試會這樣做,連 mobile-overflow.spec.ts 都只驗證「新增預約」
// 對話框能開啟,沒有實際送出過)。
import { expect, test } from "@playwright/test";

import {
  EXISTING_MEMBER_PHONE,
  INITIAL_POINTS_BALANCE,
  injectMembersFixtureSession,
  POINTS_EARN_RATE,
  setupMembersFixture,
  teardownMembersFixture,
  type MembersFixture,
} from "./support/members-fixture";
import { primeCurrentMerchant } from "./support/app-shell";

const LOAD_TIMEOUT = 20_000;

test.describe.configure({ mode: "serial", timeout: 60_000 });

let fixture: MembersFixture;
let setupFailed = false;

test.beforeAll(async () => {
  try {
    fixture = await setupMembersFixture();
  } catch (err) {
    setupFailed = true;
    console.error("[members] 建立測試 fixture 失敗:", err);
    throw err;
  }
});

test.afterAll(async () => {
  if (setupFailed || !fixture) return;
  const actions = await teardownMembersFixture(fixture);
  console.log("[members] fixture 清理結果:\n" + actions.map((a) => `  - ${a}`).join("\n"));
});

test.beforeEach(async ({ page }) => {
  await injectMembersFixtureSession(page, fixture);

  // 啟動步驟:先造訪一次後台外殼頁,讓「目前操作中商家」寫進 localStorage,避免後面直接深連結
  // 到受保護頁面時被 Require*Access 守衛誤判導回 /app。為什麼是這個頁面/這個錨點,見
  // e2e/support/app-shell.ts 的完整說明。
  await primeCurrentMerchant(page);
});

test("會員管理列表頁(§4.1):建立會員、下架後預設篩選看不到、重新上架後恢復", async ({ page }) => {
  await page.goto("/app/members");
  await expect(page.getByRole("heading", { name: "會員管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // fixture 既有會員應該出現在清單裡。
  await expect(page.getByText(fixture.existingMemberName)).toBeVisible();

  const newMemberName = `E2E新建會員${fixture.runId}`;
  await page.getByRole("button", { name: "新增會員" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("姓名 *").fill(newMemberName);
  await page.getByLabel(/^電話/).fill("0955888100");
  await page.getByRole("dialog").getByRole("button", { name: "建立" }).click();

  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 下架這位新建會員,預設篩選(上架中)應該看不到。
  const newMemberRow = page.locator("li", { hasText: newMemberName });
  await newMemberRow.getByRole("button", { name: "下架" }).click();
  await page.getByRole("button", { name: "確定下架" }).click();

  await expect(page.getByText(newMemberName)).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  // 切換到「已下架」篩選,應該看得到,並可以重新上架恢復。
  await page.getByRole("button", { name: "已下架", exact: true }).click();
  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });
  const removedRow = page.locator("li", { hasText: newMemberName });
  await removedRow.getByRole("button", { name: "恢復" }).click();

  await page.getByRole("button", { name: "上架中", exact: true }).click();
  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("會員詳情頁(§4.2):點數區塊簡化成摘要+連結,相關訂單/推薦名單正確顯示", async ({ page }) => {
  await page.goto(`/app/members/${fixture.existingMemberId}`);
  await expect(page.getByRole("heading", { name: fixture.existingMemberName })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // #617(紅利點數獨立化):點數區塊這次只保留精簡摘要(大字餘額顯示,用 CSS class 精準定位)
  // + 「查看完整點數紀錄」連結,不再直接提供兌換/手動調整操作。
  const expectedEarnedPoints = 1000 / POINTS_EARN_RATE;
  const initialBalance = INITIAL_POINTS_BALANCE + expectedEarnedPoints;
  const balanceDisplay = page.locator("p.text-3xl");
  await expect(balanceDisplay).toHaveText(`${initialBalance} 點`);
  await expect(page.getByRole("button", { name: "登記兌換" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "手動調整" })).toHaveCount(0);

  const pointsLink = page.getByRole("link", { name: "查看完整點數紀錄 →" });
  await expect(pointsLink).toBeVisible();
  await expect(pointsLink).toHaveAttribute(
    "href",
    `/app/member-points?member=${fixture.existingMemberId}`,
  );

  // 相關訂單:fixture 已連結並完成的那筆訂單應該出現,顯示已核發的點數。
  await expect(page.getByText(`已核發 ${expectedEarnedPoints} 點`)).toBeVisible();

  // 推薦名單:fixture 的被推薦會員應該出現。
  await expect(page.getByText(fixture.referredMemberName)).toBeVisible();
});

test("紅利點數管理頁(§10.5/#617):獨立卡片入口、餘額總覽搜尋、登記兌換與手動調整", async ({
  page,
}) => {
  // 「功能」分頁籤正確顯示「紅利點數管理」獨立卡片,不再有「產業轉移」(#601)、
  // 不再有「訂單管理」卡片(#610,已獨立成底部分頁籤——底部導覽本身也有一個同名連結,
  // 這裡刻意把檢查範圍限定在 <main> 卡片區,避免跟底部分頁籤的「訂單管理」連結搞混)。
  await page.goto("/app/manage");
  await expect(page.getByRole("heading", { name: "功能" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  const mainContent = page.locator("main");
  const pointsCard = page.getByRole("link", { name: /紅利點數管理/ });
  await expect(pointsCard).toBeVisible();
  await expect(mainContent.getByText("產業轉移")).toHaveCount(0);
  await expect(mainContent.getByText("訂單管理")).toHaveCount(0);

  // 底部分頁籤改成 4 個(首頁/功能/訂單管理/行事曆),「訂單管理」獨立分頁籤直接可達。
  const bottomNav = page.locator("nav");
  await expect(bottomNav.getByRole("link")).toHaveCount(4);
  await expect(bottomNav.getByRole("link", { name: "訂單管理" })).toBeVisible();

  await pointsCard.click();
  await expect(page.getByRole("heading", { name: "紅利點數管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 搜尋既有會員,確認清單顯示目前餘額。
  const expectedEarnedPoints = 1000 / POINTS_EARN_RATE;
  const initialBalance = INITIAL_POINTS_BALANCE + expectedEarnedPoints;
  await page.getByPlaceholder("搜尋姓名/電話").fill(fixture.existingMemberName);
  const memberRow = page.getByRole("button", { name: new RegExp(fixture.existingMemberName) });
  await expect(memberRow).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(memberRow.getByText(`${initialBalance} 點`)).toBeVisible();

  // 點擊會員展開完整異動歷史 + 兌換/調整入口。
  await memberRow.click();
  await expect(page.getByRole("button", { name: "登記兌換" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "手動調整" })).toBeVisible();

  await page.getByRole("button", { name: "登記兌換" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel("兌換點數 *").fill("10");
  await page.getByLabel("用途說明 *").fill("e2e 測試兌換一次免費加值服務");
  await page.getByRole("dialog").getByRole("button", { name: "確認兌換" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  const expectedBalance = initialBalance - 10;
  await expect(page.locator("p.text-3xl")).toHaveText(`${expectedBalance} 點`, {
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.getByText("兌換使用")).toBeVisible();
  await expect(page.getByText("e2e 測試兌換一次免費加值服務")).toBeVisible();

  // 帶 ?member= query 直接進入這位會員的明細(會員詳情頁「查看完整點數紀錄」連結會這樣用)。
  await page.goto(`/app/member-points?member=${fixture.existingMemberId}`);
  await expect(page.getByText(fixture.existingMemberName).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  await expect(page.locator("p.text-3xl")).toHaveText(`${expectedBalance} 點`);
});

test("建單表單電話比對連結既有會員(§10.2)+ 訂單詳情頁會員連結(§4.5)", async ({ page }) => {
  // 2026-09-24 更新:原本這一段測的是 §4.4 的獨立「會員(選填)」欄位 MemberPickerField
  //(用姓名/電話搜尋框選會員)。§10.2(SPECS-INDEX #614,git 931f43a/7c602aa)已經把那個欄位
  // 整個移除,改成「電話當查詢索引、不當唯一鍵」:客服在既有的「客戶電話」欄位輸入電話,下方的
  // MemberPhoneMatchPanel 列出這支電話底下這個商家的既有客戶,點選其中一位完成連結。
  // 驗證意圖不變(在建單表單裡找到既有會員、選中後正確顯示連結結果),只是換成新的互動流程。
  await page.goto("/app/calendar");
  await page.getByRole("button", { name: "新增預約" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "新增預約" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 輸入既有客戶的電話 → 候選名單列出這位客戶(顯示姓名 + 最近消費日期)。
  await page.locator("#booking-customer-phone").fill(EXISTING_MEMBER_PHONE);
  const candidateButton = page.getByRole("button", {
    name: new RegExp(fixture.existingMemberName),
  });
  await expect(candidateButton).toBeVisible({ timeout: LOAD_TIMEOUT });
  await candidateButton.click();

  // 選中後面板改成顯示「已連結會員:<姓名>」+「清除連結」按鈕(候選名單收起來)。
  await expect(page.getByText("已連結會員:")).toBeVisible();
  await expect(page.getByText(fixture.existingMemberName).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "清除連結" })).toBeVisible();

  // §4.5:訂單詳情頁——fixture 已完成的訂單連結到 existingMember,管理員應該看到可點擊連結。
  await page.goto("/app/orders");
  await page.getByRole("button", { name: /0955888099/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const memberLink = page.getByRole("link", { name: fixture.existingMemberName });
  await expect(memberLink).toBeVisible();
  await expect(memberLink).toHaveAttribute("href", `/app/members/${fixture.existingMemberId}`);
});
