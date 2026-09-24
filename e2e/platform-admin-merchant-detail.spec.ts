// 規格書「超級管理員商家詳情強化」#710 的端對端測試。
// 對應 .project/specs/超級管理員商家詳情強化.md 第 6.3 節。
//
// 這支測試涵蓋兩件事:
//   ① 入口可見性(#691/#692/#693):總覽表格點得進詳情頁,而且進去的是**那一列**的商家。
//   ② 兩張唯讀名單卡片(#702~#707):看得到、卡片裡沒有任何按鈕、手機寬度不溢出,
//      而且既有的「管理員名單」卡片沒有被改壞。
//
// ---------------------------------------------------------------------------
// ⚠️ 需要一組長期存在的平台管理員測試帳號
//
// platform_admins 這張表刻意沒有開放自助寫入(超級管理員後台規格書 2.8:這張表的異動一律走
// 人工 SQL),所以 e2e **無法自動建立/清除**一個臨時的平台管理員。做法比照
// e2e/mobile-overflow.spec.ts 既有的「環境變數 + test.skip」模式:
//   E2E_PLATFORM_ADMIN_EMAIL=...
//   E2E_PLATFORM_ADMIN_PASSWORD=...
// 主腦已於 2026-09-25 手動建立一組專用帳號並寫進本機 .env(platform_admins 裡有一列,
// note 欄標示為 e2e 專用、非真人)。**.env 不進版控**,所以別人 clone 這個 repo 時讀不到這兩
// 個值,整支測試會被略過而不是爆掉。
//
// ⚠️⚠️ 如果你在本機看到這支是「skipped」而不是「passed」,那**不是通過**,是 .env 讀不到
//      ——playwright.config.ts 沒有掛 dotenv,所以 .env 的內容不會自動進到 process.env,
//      要透過 support/env-file.ts 的 readOptionalEnvValue() 讀。詳見那個檔案的註解。
//
// ⚠️ 這支測試對正式 Supabase 專案是**唯讀**的:只有登入(auth 讀取)+ 兩支 stable 的 RPC +
//    既有的商家/管理員讀取,全程沒有任何 insert/update/delete,也不需要 fixture 與 teardown。
//    這是刻意的設計——平台管理員後台看的是「別人家真實的商家」,建假資料反而測不到重點。
// ---------------------------------------------------------------------------
import { devices, expect, test, type Locator, type Page } from "@playwright/test";

import { readOptionalEnvValue } from "./support/env-file";
import { injectSessionForCredentials } from "./support/mobile-overflow-fixture";
import { assertNoHorizontalOverflow } from "./support/overflow-assert";

const platformAdminEmail = readOptionalEnvValue("E2E_PLATFORM_ADMIN_EMAIL");
const platformAdminPassword = readOptionalEnvValue("E2E_PLATFORM_ADMIN_PASSWORD");

const LOAD_TIMEOUT = 20_000;

/** 總覽表格裡「管理員人數 >= 1」的最後一列。
 *
 * 為什麼要這樣挑,而不是直接用第一列:
 *   ① 規格書 6.3 第 2 點要求驗證「點進去的是**那一列**的商家,不是第一列」——固定用第一列
 *      的話,就算程式把每一列的連結都寫成第一列的 id 也測不出來。
 *   ② 第 8 點要驗「管理員名單卡片的『移除』按鈕還在」,那需要這間店至少有一位管理員,
 *      所以用表格上現成的「管理員人數」欄位挑一間有人的。
 *
 * ⚠️ 刻意不把任何商家 id 寫死在測試碼裡(版控裡不放可辨識的正式資料),一律從畫面上讀。
 */
async function pickTargetRow(page: Page): Promise<{ row: Locator; name: string; href: string }> {
  // ⚠️ 表格是等 useQuery 回來才渲染的(在那之前畫面上只有「載入中⋯」),而 <h1> 一開始就在。
  //    所以不能只等標題出現就開始數列數——第一次跑的時候就因此拿到 0 列而紅了一條。
  await expect(page.getByRole("link", { name: "查看詳情 →" }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const rows = page.locator("tbody tr");
  const total = await rows.count();
  expect(total, "總覽頁至少要有一間商家才能往下測").toBeGreaterThan(0);

  let picked: Locator | null = null;
  for (let i = total - 1; i >= 0; i -= 1) {
    const row = rows.nth(i);
    const adminCount = Number.parseInt(
      ((await row.locator("td").nth(4).textContent()) ?? "0").trim(),
      10,
    );
    if (Number.isFinite(adminCount) && adminCount >= 1) {
      picked = row;
      break;
    }
  }
  expect(picked, "找不到任何「管理員人數 >= 1」的商家,無法驗證管理員名單卡片").not.toBeNull();

  const row = picked as Locator;
  const name = ((await row.locator("td").first().textContent()) ?? "").trim();
  const href = (await row.getByRole("link", { name: "查看詳情 →" }).getAttribute("href")) ?? "";
  expect(href, "「查看詳情 →」連結要有 href").toMatch(/^\/platform-admin\/merchants\//);
  return { row, name, href };
}

/** 「服務人員名單 / 客服名單」那張卡片本身(Card 的根元素)。
 *
 * ⚠️ 刻意不用 data-testid:見 .claude/skills/automated-testing/SKILL.md 第五節——
 *    「畫面中文字改了、測試就跟著紅」本身就是一層有用的保護,改成 testid 等於把警報器拆掉。
 *    這裡用 shadcn Card 固定會帶的 `rounded-xl` class 當容器選擇器,再用卡片標題文字篩選。
 *
 * ⚠️⚠️ 呼叫端一律要先 `await expect(cardByTitle(...)).toHaveCount(1)`。理由:如果這個
 *      locator 因為 class 或標題改了而**一個元素都沒選到**,後面的
 *      `.locator("button")).toHaveCount(0)` 會「0 === 0」直接通過——那就是一份永遠會過的
 *      假測試,正好是這支測試最不能出錯的一條(釘住 2.2 的唯讀裁決)。
 */
function cardByTitle(page: Page, title: string): Locator {
  return page.locator("div.rounded-xl").filter({ hasText: title });
}

/** 找一間「服務人員名單真的有人」的商家,回傳它的詳情頁網址。
 *
 * 為什麼需要它:`pickTargetRow()` 挑的是「管理員人數 >= 1 的最後一列」,實務上那常常是一間
 * 剛跑完別的 e2e 留下來的佔位商家,服務人員/客服都是 0 筆——用它去驗「卡片裡沒有按鈕」
 * 「徽章文字是新用語」會變成在測空清單,什麼都沒驗到。所以內容類的斷言改用這支:
 * 從第一列往下逐一開詳情頁,找到第一間名單非空的就停(最多看 MAX_SCAN 間,避免拖太久)。
 *
 * ⚠️ 一樣刻意不把商家 id 寫死在測試碼裡。
 */
async function gotoMerchantWithStaff(page: Page): Promise<string> {
  const MAX_SCAN = 6;
  await page.goto("/platform-admin");
  await expect(page.getByRole("link", { name: "查看詳情 →" }).first()).toBeVisible({
    timeout: LOAD_TIMEOUT,
  });
  const links = page.getByRole("link", { name: "查看詳情 →" });
  const hrefs: string[] = [];
  const scan = Math.min(MAX_SCAN, await links.count());
  for (let i = 0; i < scan; i += 1) {
    const href = await links.nth(i).getAttribute("href");
    if (href) hrefs.push(href);
  }

  for (const href of hrefs) {
    await page.goto(href);
    await expect(page.getByText("服務人員名單", { exact: true })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    // 等載入結束(不是「載入中⋯」也不是「載入失敗」)再判斷是不是空清單。
    await expect(cardByTitle(page, "服務人員名單").locator("li").first())
      .toBeVisible({
        timeout: LOAD_TIMEOUT,
      })
      .catch(() => undefined);
    if ((await cardByTitle(page, "服務人員名單").locator("li").count()) > 0) return href;
  }

  throw new Error(
    `前 ${scan} 間商家的「服務人員名單」都是空的,無法驗證名單內容。` +
      `請確認正式資料庫裡至少有一間商家有服務人員(規格書 0.4 節提到的「涼風工匠」是總覽頁第一列)。`,
  );
}

test.describe("超級管理員商家詳情強化", () => {
  test.skip(
    !platformAdminEmail || !platformAdminPassword,
    "未設定 E2E_PLATFORM_ADMIN_EMAIL / E2E_PLATFORM_ADMIN_PASSWORD,略過超級管理員後台檢查" +
      "(見這個檔案開頭的完整說明)。",
  );

  // ⚠️ 刻意**不用** serial 模式:automated-testing SKILL 第五節記著「serial 下前面的 test
  //    失敗會讓後面的 test 直接被跳過」,payroll-reports.spec.ts 就因此讓一條過時的測試長期
  //    沒被執行到而沒人發現。這支裡的每一條都自己 goto、互不相依,沒有任何共用狀態,
  //    所以沒有理由承擔那個風險。
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await injectSessionForCredentials(
      page,
      platformAdminEmail as string,
      platformAdminPassword as string,
    );
  });

  // #691:每一列的「操作」欄看得到「查看詳情 →」連結。
  test("總覽頁每一列都有「查看詳情 →」連結,說明文字也提到可以點進去", async ({ page }) => {
    await page.goto("/platform-admin");
    await expect(page.getByRole("heading", { name: "集團與商家總覽" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });

    const rowCount = await page.locator("tbody tr").count();
    // 每一列都要有一個,數量必須跟列數一致(不是「至少有一個」)。
    await expect(page.getByRole("link", { name: "查看詳情 →" })).toHaveCount(rowCount);

    // #693:副標說明補的那一句。
    await expect(
      page.getByText("點商家名稱或右側「查看詳情」,可以進到單一商家的詳情頁"),
    ).toBeVisible();
  });

  // #691 + 規格書 6.3 第 2 點:點進去的必須是**那一列**的商家。
  test("點「查看詳情 →」進到的是那一列的商家,不是第一列", async ({ page }) => {
    await page.goto("/platform-admin");
    await expect(page.getByRole("heading", { name: "集團與商家總覽" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });

    const { row, name, href } = await pickTargetRow(page);
    await row.getByRole("link", { name: "查看詳情 →" }).click();

    await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name, {
      timeout: LOAD_TIMEOUT,
    });
  });

  // #692:商家名稱本身仍然是可以點的連結(只換了顏色 token,沒有被改壞)。
  test("點商家名稱同樣進得到詳情頁(#692 的連結沒被改壞)", async ({ page }) => {
    await page.goto("/platform-admin");
    await expect(page.getByRole("heading", { name: "集團與商家總覽" })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });

    const { row, name, href } = await pickTargetRow(page);
    const nameLink = row.locator("td").first().getByRole("link");
    // 只換顏色 token:仍然是 <a>(不是 <button>),而且用的是品牌色 text-brand。
    await expect(nameLink).toHaveClass(/text-brand/);
    await nameLink.click();

    await expect(page).toHaveURL(new RegExp(`${href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(name, {
      timeout: LOAD_TIMEOUT,
    });
  });

  // #702/#703/#705/#707:兩張卡片看得到,而且寫明「唯讀」。
  test("詳情頁看得到「服務人員名單」與「客服名單」兩張唯讀卡片", async ({ page }) => {
    await gotoMerchantWithStaff(page);

    await expect(page.getByText("服務人員名單", { exact: true })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(page.getByText("客服名單", { exact: true })).toBeVisible();

    // #707:CardDescription 上看得到「唯讀」兩個字,並說明要改請商家自己操作。
    await expect(
      page.getByText("唯讀。這間店目前登記的服務人員。", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("唯讀。這間店目前登記的客服。", { exact: false })).toBeVisible();

    // #705:三種狀態分得出來——這裡至少要確定「不是卡在載入中」,而且沒有出現讀取失敗。
    // ⚠️ 讀取失敗必須顯示錯誤、不能靜默當成空清單(規格書 3.15),所以這條斷言很重要:
    //    如果哪天函式被誤 revoke,畫面會出現「載入失敗:…」而這裡會紅。
    await expect(page.getByText("載入失敗:", { exact: false })).toHaveCount(0);
  });

  // 規格書 2.2 / 6.3 第 5 點:釘住「唯讀」這個使用者裁決——兩張卡片內不得有任何 button。
  test("兩張新卡片內沒有任何按鈕(釘住 2.2「平台方只看不改」的裁決)", async ({ page }) => {
    // ⚠️ 刻意用「名單真的有人」的商家:對空清單驗「沒有按鈕」等於什麼都沒驗。
    await gotoMerchantWithStaff(page);

    // ⚠️ 先確認這兩個 locator 真的各選到一張卡片。少了這兩條,萬一選擇器失效選到 0 個元素,
    //    下面的 toHaveCount(0) 會「0 === 0」直接通過,變成永遠會過的假測試。
    await expect(cardByTitle(page, "服務人員名單")).toHaveCount(1);
    await expect(cardByTitle(page, "客服名單")).toHaveCount(1);
    await expect(
      cardByTitle(page, "服務人員名單").locator("li"),
      "前提:這間店的服務人員名單要真的有人,才驗得出「沒有按鈕」",
    ).not.toHaveCount(0);

    await expect(
      cardByTitle(page, "服務人員名單").locator("button"),
      "服務人員名單卡片內不得出現任何按鈕(沒有編輯/移除/權限入口)",
    ).toHaveCount(0);
    await expect(
      cardByTitle(page, "客服名單").locator("button"),
      "客服名單卡片內不得出現任何按鈕",
    ).toHaveCount(0);
  });

  // 規則 3 / 6.3 第 6 點:中文用語一律用新用語。
  test("兩張新卡片不出現舊用語「按件計酬」,徽章文字全部來自新用語常數", async ({ page }) => {
    await gotoMerchantWithStaff(page);

    // 「按件計酬」是純標籤字串,整頁檢查是安全的。
    await expect(page.getByText("按件計酬")).toHaveCount(0);

    // -----------------------------------------------------------------------
    // 「師傅」:整頁文字檢查,但扣掉「使用者自己填的人名那一行」。
    //
    // ⚠️ 為什麼不能照規格書 §6.3 第 6 點字面做「整頁不得出現師傅」:
    //    正式資料庫裡真的有一位服務人員的**姓名**就叫「師傅1」、暱稱叫「師傅暱稱1」
    //    (2026-09-25 實查 merchant_staff,而且就在規格書自己指定的驗收商家「涼風工匠」裡)。
    //    那是商家自己輸入的資料,不是我們的介面用語,整頁 grep 會在正確的程式碼上直接紅。
    //
    // ⚠️ 為什麼又不能只檢查「服務人員卡片的標題/說明/徽章」(這是 2026-09-25 品管退回的原因):
    //    那樣會漏掉客服卡片的標題/說明/徽章、兩張卡片底部的統計行、側邊選單與其他卡片的
    //    chrome。而「側邊選單回填『師傅報表』」「客服卡片說明改回『師傅』」正是這個專案
    //    連續踩過兩次的坑(見 automated-testing SKILL 第五節),漏掉它等於把警報器拆掉。
    //
    // ✅ 取捨:回到整頁文字,只把「渲染使用者自己填的識別資料」那幾個元素剪掉——
    //    ① 三張名單卡片裡每一列的那顆 <p class="break-words font-medium …>:它的內容就是
    //       personDisplayName()/adminDisplayName() 產生的「姓名(暱稱)」,加上客服/管理員
    //       壓在同一行的小字職稱(job_title 也是使用者自己填的)。
    //    ② <h1>:商家店名,同樣是使用者自己填的。
    //    **排除的界線就到這裡**——卡片標題、CardDescription、徽章、統計行「共 N 位(其中
    //    M 位已移除)」、側邊選單、其他卡片的文字**全部仍在檢查範圍內**。之後如果有人想
    //    再往這個排除清單裡加東西,請先確認那真的是「使用者輸入的資料」,不是我們寫死的字。
    //
    // 作法:在瀏覽器端複製一份 body、把那幾個元素從副本上移除再取 textContent,
    //       不動真正的畫面(下一條斷言還要用)。
    // -----------------------------------------------------------------------
    const pageTextWithoutUserEnteredNames = await page.evaluate(() => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      // ① 名單每一列的「姓名(暱稱)・職稱」那一行
      clone.querySelectorAll("li p.break-words.font-medium").forEach((el) => el.remove());
      // ② 商家店名
      clone.querySelectorAll("h1").forEach((el) => el.remove());
      return clone.textContent ?? "";
    });
    expect(
      pageTextWithoutUserEnteredNames,
      "扣掉使用者自己填的姓名/暱稱/職稱/店名之後,整頁不得再出現舊稱「師傅」" +
        "(卡片標題、說明、徽章、統計行、側邊選單都在檢查範圍內)",
    ).not.toContain("師傅");

    const staffCard = cardByTitle(page, "服務人員名單");
    const allowedBadgeLabels = [
      "月薪制",
      "抽成制",
      "尚未開通",
      "邀請信已寄出",
      "已開通登入",
      "已移除",
    ];
    const badges = staffCard.locator("li div.inline-flex.rounded-md");
    const badgeCount = await badges.count();
    // ⚠️ 前提:至少要真的量到徽章,否則下面的迴圈跑 0 次、這條測試等於沒測。
    //    每位服務人員固定會有「計酬類型 + 登入狀態」兩顆,所以這裡一定 >= 2。
    expect(badgeCount, "服務人員名單至少要有一位、每位至少兩顆徽章").toBeGreaterThanOrEqual(2);
    for (let i = 0; i < badgeCount; i += 1) {
      const text = ((await badges.nth(i).textContent()) ?? "").trim();
      expect(allowedBadgeLabels, `服務人員徽章「${text}」不在新用語常數裡`).toContain(text);
    }
  });

  // 規則 5 / 6.3 第 8 點:既有的「管理員名單」卡片沒有被改壞(它本來就可以新增/移除)。
  test("「管理員名單」卡片的新增與移除按鈕還在(既有功能沒被改壞)", async ({ page }) => {
    await page.goto("/platform-admin");
    const { href } = await pickTargetRow(page);
    await page.goto(href);
    await expect(page.getByText("管理員名單", { exact: true })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });

    const adminCard = cardByTitle(page, "管理員名單");
    await expect(adminCard.getByRole("button", { name: "新增" })).toBeVisible();
    // 這間店是刻意挑「管理員人數 >= 1」的,所以至少要有一顆「移除」。
    expect(await adminCard.getByRole("button", { name: "移除" }).count()).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #706:手機寬度(375px)不得橫向溢出。
//
// ⚠️ 單純 setViewportSize 不夠(mobile-overflow.spec.ts 開頭記過這個坑:那只是把桌面版
//    Chromium 的視窗改窄,不會套用 isMobile/hasTouch,position:fixed 元素的溢出量不出來),
//    所以這裡另開一個 describe 用 Playwright 內建的 iPhone SE 裝置描述。
//    刻意不整包 spread devices[...](裡面的 defaultBrowserType: "webkit" 會讓 Playwright 去
//    啟動這台機器上沒有安裝的 webkit 而直接炸掉),只挑需要的欄位。
// ---------------------------------------------------------------------------
const IPHONE_SE_3RD_GEN = devices["iPhone SE (3rd gen)"];

test.describe("超級管理員商家詳情強化(手機 375px)", () => {
  test.skip(
    !platformAdminEmail || !platformAdminPassword,
    "未設定 E2E_PLATFORM_ADMIN_EMAIL / E2E_PLATFORM_ADMIN_PASSWORD,略過超級管理員後台檢查。",
  );

  test.use({
    viewport: IPHONE_SE_3RD_GEN.viewport,
    userAgent: IPHONE_SE_3RD_GEN.userAgent,
    deviceScaleFactor: IPHONE_SE_3RD_GEN.deviceScaleFactor,
    isMobile: IPHONE_SE_3RD_GEN.isMobile,
    hasTouch: IPHONE_SE_3RD_GEN.hasTouch,
  });

  // ⚠️ 刻意**不用** serial 模式:automated-testing SKILL 第五節記著「serial 下前面的 test
  //    失敗會讓後面的 test 直接被跳過」,payroll-reports.spec.ts 就因此讓一條過時的測試長期
  //    沒被執行到而沒人發現。這支裡的每一條都自己 goto、互不相依,沒有任何共用狀態,
  //    所以沒有理由承擔那個風險。
  test.describe.configure({ timeout: 60_000 });

  test.beforeEach(async ({ page }) => {
    await injectSessionForCredentials(
      page,
      platformAdminEmail as string,
      platformAdminPassword as string,
    );
  });

  test("商家詳情頁(含兩張新名單卡片)在 375px 下不橫向溢出", async ({ page }) => {
    // ⚠️⚠️ 這裡一定要用 gotoMerchantWithStaff(),**不可以**用 pickTargetRow()。
    //   品管 2026-09-25 抓到的問題:pickTargetRow() 挑的是「管理員人數 >= 1 的最後一列」,
    //   實務上那是一間剛跑完別的 e2e 留下來的佔位商家(staff=0 / agent=0)。對那間店而言,
    //   兩張新卡片畫面上就只有「目前沒有服務人員紀錄」「目前沒有客服紀錄」兩行短字——
    //   §3.16 要防的長 Email(break-all)、長手機、長姓名(break-words)、三顆徽章
    //   (flex-wrap)**一個都沒有被渲染出來**,等於在量一張空卡片的寬度,永遠不會溢出。
    //   這跟 gotoMerchantWithStaff() 註解裡寫的原則是同一條:對空清單驗什麼都等於沒驗。
    await gotoMerchantWithStaff(page);

    await expect(page.getByText("服務人員名單", { exact: true })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await expect(page.getByText("客服名單", { exact: true })).toBeVisible();
    // 前提:名單真的有列,才量得到 break-all / break-words / flex-wrap 那一套有沒有生效。
    await expect(
      cardByTitle(page, "服務人員名單").locator("li"),
      "前提:服務人員名單要真的有人,才量得出手機/Email/徽章有沒有撐開容器",
    ).not.toHaveCount(0);

    await assertNoHorizontalOverflow(
      page,
      "超級管理員後台商家詳情頁(含服務人員名單 / 客服名單兩張新卡片)",
    );
  });
});
