// 模組 10(會員與紅利)規格書 §7/§8 明確要求的 Playwright 測試:
//   1. 會員管理列表頁(§4.1):建立會員 → 清單正確顯示;下架後預設篩選看不到,重新上架後恢復。
//   2. 會員詳情頁(§4.2,已依 SPECS-INDEX #830 更新):點數卡片是完整操作面板(餘額 + 登記兌換 /
//      手動調整 + 異動歷史,從紅利點數管理頁搬回來);相關訂單/推薦名單正確顯示 fixture 資料。
//   3. 紅利點數管理頁(§10.5/#617,商家端調整批次 2026-09-22 新增;#830 後只剩規則設定):獨立
//      卡片入口(取代原本掛在「功能」的「產業轉移」#601 已隱藏、「訂單管理」#610 已獨立成分頁籤)、
//      規則卡片可見、不再有「會員點數餘額總覽」。
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

// #1037(客戶端第 1 批 C1-E02):會員詳細頁的推薦名單跟著同一個開關藏起來;開關關掉(恢復)時照舊驗名單。
import { REFERRAL_UI_HIDDEN } from "../src/modules/members/referralVisibility";

import {
  EXISTING_MEMBER_PHONE,
  INITIAL_POINTS_BALANCE,
  injectMembersFixtureSession,
  BASIC_TIER_AMOUNT,
  setupMembersFixture,
  STAFF_NAME_PREFIX,
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
  await page.getByLabel(/^姓名\s*\*?$/).fill(newMemberName);
  await page.getByLabel(/^電話/).fill("0955888100");
  await page.getByRole("dialog").getByRole("button", { name: "建立" }).click();

  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });

  // 下架這位新建會員,預設篩選(上架中)應該看不到。
  const newMemberRow = page.locator("li", { hasText: newMemberName });
  // #849(ui-v1-full ListCard):「下架」收進每列右側的「⋯」(更多動作)選單。
  // 會員卡片整張可點(role="button",名稱會包含卡片裡所有文字)⇒ 卡片內的按鈕一律加 exact。
  await newMemberRow.getByRole("button", { name: "更多動作", exact: true }).click();
  await page.getByRole("menuitem", { name: "下架" }).click();
  await page.getByRole("button", { name: "確定下架" }).click();

  await expect(page.getByText(newMemberName)).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  // 切換到「已下架」篩選,應該看得到,並可以重新上架恢復。
  // #849:狀態篩選從按鈕改成底線式分頁籤(UnderlineTabsTrigger,名稱後面帶數量,例如「已下架 1」)。
  await page.getByRole("tab", { name: /^已下架\s*\d+$/ }).click();
  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });
  const removedRow = page.locator("li", { hasText: newMemberName });
  await removedRow.getByRole("button", { name: "恢復", exact: true }).click();

  await page.getByRole("tab", { name: /^上架中\s*\d+$/ }).click();
  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("會員詳情頁(§4.2/#830):點數卡片含登記兌換與手動調整入口、異動歷史,相關訂單/推薦名單正確顯示", async ({
  page,
}) => {
  await page.goto(`/app/members/${fixture.existingMemberId}`);
  await expect(page.getByRole("heading", { name: fixture.existingMemberName })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // SPECS-INDEX #830:點數卡片改回完整操作面板(大字餘額顯示,用 CSS class 精準定位)+ 登記兌換 /
  // 手動調整入口(fixture 登入的是商家管理員,兩顆都要看得到)+ 異動歷史,不再有「查看完整點數紀錄」
  // 連結導去紅利點數管理頁。
  const expectedEarnedPoints = 1000 / BASIC_TIER_AMOUNT;
  const initialBalance = INITIAL_POINTS_BALANCE + expectedEarnedPoints;
  const balanceDisplay = page.locator("p.text-3xl");
  await expect(balanceDisplay).toHaveText(`${initialBalance} 點`);
  await expect(page.getByRole("button", { name: "登記兌換" })).toBeVisible();
  await expect(page.getByRole("button", { name: "手動調整" })).toBeVisible();
  await expect(page.getByText("異動歷史")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看完整點數紀錄 →" })).toHaveCount(0);

  // 登記兌換一次,餘額與異動歷史要即時更新(這段原本在紅利點數管理頁的測試裡,跟著功能一起搬過來)。
  await page.getByRole("button", { name: "登記兌換" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/^兌換點數\s*\*?$/).fill("10");
  await page.getByLabel(/^用途說明\s*\*?$/).fill("e2e 測試兌換一次免費加值服務");
  await page.getByRole("dialog").getByRole("button", { name: "確認兌換" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: LOAD_TIMEOUT });

  const expectedBalance = initialBalance - 10;
  await expect(balanceDisplay).toHaveText(`${expectedBalance} 點`, { timeout: LOAD_TIMEOUT });
  await expect(page.getByText("兌換使用")).toBeVisible();
  await expect(page.getByText("e2e 測試兌換一次免費加值服務")).toBeVisible();

  // 相關訂單:fixture 已連結並完成的那筆訂單應該出現,顯示已核發的點數。
  // #849(紅利系統重構 §4.8 / #844):相關訂單的標籤從「已核發 N 點」改成「已入帳 N 點」(看淨額)。
  await expect(page.getByText(`已入帳 ${expectedEarnedPoints} 點`, { exact: true })).toBeVisible();

  // 推薦名單:fixture 的被推薦會員應該出現(#1037 隱藏期間改驗「整張推薦名單卡片不出現」)。
  if (REFERRAL_UI_HIDDEN) {
    await expect(page.getByText("推薦名單", { exact: true })).toHaveCount(0);
  } else {
    await expect(page.getByText(fixture.referredMemberName)).toBeVisible();
  }
});

test("紅利點數管理頁(§10.5/#617/#830):獨立卡片入口、只剩規則設定、不再有餘額總覽", async ({
  page,
}) => {
  // 「功能」分頁籤正確顯示「紅利點數管理」獨立卡片,不再有「產業轉移」(#601)、
  // 不再有「訂單管理」卡片(#610,已獨立成底部分頁籤——底部導覽本身也有一個同名連結,
  // 這裡刻意把檢查範圍限定在 <main> 卡片區,避免跟底部分頁籤的「訂單管理」連結搞混)。
  await page.goto("/app/manage");
  await expect(page.getByRole("heading", { name: "功能" })).toBeVisible({ timeout: LOAD_TIMEOUT });
  const mainContent = page.locator("main");
  // #974(2026-10-06):卡片標題「紅利點數管理」改名「紅利點數」。
  const pointsCard = page.getByRole("link", { name: /^紅利點數/ });
  await expect(pointsCard).toBeVisible();
  await expect(mainContent.getByText("產業轉移")).toHaveCount(0);
  await expect(mainContent.getByText("訂單管理")).toHaveCount(0);

  // 底部分頁籤改成 4 個(首頁/功能/訂單管理/行事曆),「訂單管理」獨立分頁籤直接可達。
  const bottomNav = page.locator("nav");
  await expect(bottomNav.getByRole("link")).toHaveCount(4);
  await expect(bottomNav.getByRole("link", { name: "訂單管理" })).toBeVisible();

  await pointsCard.click();
  await expect(page.getByRole("heading", { name: "紅利點數", exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // SPECS-INDEX #830:這頁只剩「規則」那一半(fixture 登入的是商家管理員,兩張規則卡片都要看得到),
  // 「會員點數餘額總覽」跟搜尋框、登記兌換/手動調整入口都不該再出現在這頁。
  await expect(page.getByText("核發獎勵資格條件", { exact: true })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  // 紅利系統重構批次 6(#836):「點數設定」卡片已移除,改成獨立的啟用開關 + 四個分頁(細節在
  // member-points-settings.spec.ts)。
  await expect(page.getByText("點數設定", { exact: true })).toHaveCount(0);
  await expect(page.getByText("啟用紅利點數功能", { exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "紅利計算" })).toBeVisible();
  await expect(page.getByText("會員點數餘額總覽")).toHaveCount(0);
  await expect(page.getByPlaceholder("搜尋姓名/電話")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "登記兌換" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "手動調整" })).toHaveCount(0);
});

test("建單表單電話比對連結既有會員(§10.2)+ 訂單詳情頁會員連結(§4.5)", async ({ page }) => {
  // 2026-10-01 更新(SPECS-INDEX #915 / #936 第二波,規格書 §12.2):面板改成「自動」的顯示。
  // 原本測的是「點選候選 → 面板變成『已連結會員:<姓名>』+『清除連結』按鈕」,但第二波裁決:
  //   ・新增訂單時前端一律不帶 p_member_id,會員連結由後端依送出當下的電話自動決定(§12.1);
  //   ・點選候選只是把電話 / 姓名 / 地址帶進表單的快捷鍵(#936);
  //   ・「清除連結」按鈕整顆移除(使用者裁決不需要不入會的退路)。
  // 驗證意圖不變(在建單表單裡找到既有會員、畫面正確告訴客服會連結到誰),改成新的互動流程:
  // 打電話開頭 → 列出開頭相符的候選 → 點一下 → 電話與姓名被帶入、面板顯示「將連結既有客戶」。
  await page.goto("/app/calendar");
  await page.getByRole("button", { name: "新增預約" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "新增預約" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 只打電話開頭(前綴比對至少 4 位數字)→ 列出開頭相符的候選(姓名 + 電話 + 最近消費日期)。
  const phonePrefix = EXISTING_MEMBER_PHONE.slice(0, 7);
  await page.locator("#booking-customer-phone").fill(phonePrefix);
  await expect(page.getByText("開頭相符的客戶(點一下帶入資料)")).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const candidateButton = page.getByRole("button", {
    name: new RegExp(fixture.existingMemberName),
  });
  await expect(candidateButton).toBeVisible({ timeout: LOAD_TIMEOUT });
  await candidateButton.click();

  // 點選後:電話補成完整號碼、姓名帶入,面板切到「將連結既有客戶:<姓名>」(不是按鈕,也沒有清除連結)。
  await expect(page.locator("#booking-customer-phone")).toHaveValue(EXISTING_MEMBER_PHONE);
  await expect(page.locator("#booking-customer-name")).toHaveValue(fixture.existingMemberName);
  await expect(page.getByText("將連結既有客戶：")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("button", { name: "清除連結" })).toHaveCount(0);

  // §4.5:訂單詳情頁——fixture 已完成的訂單連結到 existingMember,管理員應該看到可點擊連結。
  await page.goto("/app/orders");
  await page.getByRole("button", { name: /0955888099/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: LOAD_TIMEOUT });

  const memberLink = page.getByRole("link", { name: fixture.existingMemberName });
  await expect(memberLink).toBeVisible();
  await expect(memberLink).toHaveAttribute("href", `/app/members/${fixture.existingMemberId}`);
});

// ---------------------------------------------------------------------------
// SPECS-INDEX #822(2026-09-27 使用者裁決):客戶電話格式驗證(手機或市話皆可、市話可帶 # 分機、
// 分隔符號不強制)。規則本身的完整規則表在 src/lib/validation.test.ts(Vitest)與
// supabase/tests/database/module6_11_customer_phone_format.sql(pgTAP);這裡只驗「前端表單真的有
// 接上這條驗證、擋下時不會送出」。兩個表單都用「先亂打被擋 → 改成合法值就往下走」的
// 前提斷言 → 行為斷言兩段式,避免「按鈕根本沒反應」也被當成通過。
// ---------------------------------------------------------------------------
test("建單表單:客戶電話亂打會被擋下、不會送出;改成市話+分機就放行(SPECS-INDEX #822)", async ({
  page,
}) => {
  await page.goto("/app/calendar");
  await page.getByRole("button", { name: "新增預約" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "新增預約" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  // 先把排在電話「前面」的必填項填齊(服務人員、服務項目、客戶姓名;日期時間開啟時已預設帶入),
  // 否則 handleSubmit 會先被更前面的檢查擋住,根本走不到電話那一條。
  // #849(ui-v1-full FormField):標題文字與「*」拆成不同節點,原本「找文字再往上一層」的定位失效;
  // 改用服務人員下拉自己的 id(e2e-local 的建單測試也是這樣定位)。
  await dialog.locator("#booking-staff").click();
  await page.getByRole("option", { name: `${STAFF_NAME_PREFIX}${fixture.runId}` }).click();
  // SPECS-INDEX #979(2026-10-06):服務項目改從「選擇項目」整頁勾選後按「確認」(只改操作步驟)。
  await dialog.locator("#booking-service-items").click();
  const picker = dialog.getByTestId("service-item-picker");
  const serviceItemCheckbox = picker.getByRole("checkbox", { name: /E2E測試服務項目\(會員模組\)/ });
  await expect(serviceItemCheckbox).toBeVisible({ timeout: LOAD_TIMEOUT });
  await serviceItemCheckbox.click();
  await picker.getByRole("button", { name: /^確認/ }).click();
  // #849(第 2 批「時間清單只列可約」):選好服務人員與項目之後,預約時間不一定會自動帶入
  // (預設時段可能已經過了或不可約,按鈕顯示「請選擇日期時間」),handleSubmit 會先卡在時間那一關。
  // 打開時間清單點第一個可約時間,讓送出真的走到電話那一條檢查。
  await dialog.locator("#booking-datetime").click();
  const timeOptions = page.getByTestId("booking-time-options");
  await expect(timeOptions.getByRole("button").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await timeOptions.getByRole("button").first().click();
  await expect(dialog.locator("#booking-datetime")).not.toContainText("請選擇日期時間");
  await dialog.locator("#booking-customer-name").fill("E2E電話格式測試客戶");

  // 亂打 3 碼(正式庫實查到的髒資料型態)→ 被擋下,對話框還在。
  await dialog.locator("#booking-customer-phone").fill("123");
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText("電話格式不正確").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog).toBeVisible();

  // 正向對照:改成「市話 + 分機」再送出,電話那一關要放行、往下走到下一個檢查
  //(付款方式預設未選,所以下一個 toast 應該是「請選擇付款方式」,而不是電話格式錯誤)。
  // 刻意停在這一關,不真的建立訂單。
  await dialog.locator("#booking-customer-phone").fill("02-1234-5678#123");
  await dialog.getByRole("button", { name: "建立預約" }).click();
  await expect(page.getByText("請選擇付款方式").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
});

test("新增會員表單:電話填了但格式不對會被擋下;留空或合法就放行(SPECS-INDEX #822)", async ({
  page,
}) => {
  await page.goto("/app/members");
  await expect(page.getByRole("heading", { name: "會員管理" })).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });

  const newMemberName = `E2E電話格式會員${fixture.runId}`;
  await page.getByRole("button", { name: "新增會員" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await page.getByLabel(/^姓名\s*\*?$/).fill(newMemberName);

  // 亂打 → 擋下,對話框還在、清單裡沒有這位會員。
  await page.getByLabel(/^電話/).fill("abc");
  await dialog.getByRole("button", { name: "建立" }).click();
  await expect(page.getByText("電話格式不正確").first()).toBeVisible({ timeout: LOAD_TIMEOUT });
  await expect(dialog).toBeVisible();

  // 正向對照:改成帶分隔符號的市話 → 建立成功,清單看得到。
  await page.getByLabel(/^電話/).fill("(02) 2345-6789");
  await dialog.getByRole("button", { name: "建立" }).click();
  await expect(page.getByText(newMemberName)).toBeVisible({ timeout: LOAD_TIMEOUT });
});
