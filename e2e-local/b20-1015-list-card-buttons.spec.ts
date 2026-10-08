// 第 20 批 #1015:服務人員管理、客服管理兩頁的列表卡片,⋯ 只留「移除」(與不可逆的「真正刪除」),
// 其餘動作改成卡片上直接看得到的按鈕。本機 Supabase 專用(e2e-local 設定,loopback guard 生效,不碰正式庫)。
// 規格書:.project/specs/列表卡片按鈕外露-第20批.md
//
//   1. 管理員 × 服務人員管理(1280 / 375):已開通 / 未邀請 / 邀請中 / 已移除 四種人,卡片上的按鈕與 ⋯ 內容
//      跟改版前的顯示條件一致;外露的「邀請登入」打開的是同一個小卡窗、「服務人員權限」跳到同一頁。
//   2. 客服(有 staff_management 權限)× 服務人員管理(1280 / 375):看不到「邀請登入」「服務人員權限」,
//      ⋯ 只有「移除」;已移除的人沒有 ⋯(真正刪除只給管理員)。
//   3. 管理員 × 客服管理(1280 / 375):在職 / 邀請中 / 已移除,「權限設定」在卡片上、⋯ 只有「移除」或「真正刪除」;
//      「權限設定」跳到同一頁。
//   4. 客服 × 客服管理:照舊被導回(整頁只給管理員)。
//   每個寬度都檢查整頁沒有橫向捲動,並量「卡片上的按鈕」是否全部在卡片框內。
//
// 截圖存 B20_SHOTS(預設 test-results/b20-shots/;🔴 不寫進 .project/notes/ui-ref-2026-10-01/after/)。
//
// 執行:E2E_LOCAL_PORT=5299 npx playwright test --config playwright.local.config.ts b20-1015-list-card-buttons

import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { buildFetch } from "../e2e/support/fixture-supabase-client";
import { assertNoHorizontalOverflow } from "../e2e/support/overflow-assert";
import {
  injectSession,
  setupBatch3Fixture,
  teardownBatch3Fixture,
  type Batch3Fixture,
} from "./support/permission-batch3-fixture";
import { readLocalSupabaseTarget } from "./support/local-target";

const LOAD_TIMEOUT = 20_000;
const SHOTS = process.env["B20_SHOTS"] ?? "test-results/b20-shots";

const STAFF_UNINVITED = "E2E第20批未邀請";
const STAFF_INVITED = "E2E第20批邀請中";
const STAFF_REMOVED = "E2E第20批已移除";
const AGENT_INVITED = "E2E第20批客服邀請中";
const AGENT_REMOVED = "E2E第20批客服已移除";

test.use({ timezoneId: "Asia/Taipei" });
test.describe.configure({ mode: "serial", timeout: 300_000 });

let fixture: Batch3Fixture;
let activeStaffName: string;
let activeAgentName: string;
let activeStaffId: string;

function serviceClient(): SupabaseClient {
  const { url, serviceRoleKey } = readLocalSupabaseTarget();
  return createClient(url, serviceRoleKey, {
    global: { fetch: buildFetch(serviceRoleKey) },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function must<T>(label: string, data: T | null | undefined, error: { message: string } | null): T {
  if (error || data === null || data === undefined) {
    throw new Error(`${label}失敗:${error?.message ?? "沒有回傳資料"}`);
  }
  return data;
}

test.beforeAll(async () => {
  test.setTimeout(180_000);
  fixture = await setupBatch3Fixture();
  const svc = serviceClient();
  const seed = Number(fixture.runId.slice(-6));
  const phone = (n: number) => `09${String((seed * 10 + n) % 100_000_000).padStart(8, "0")}`;

  // 客服「再行銷」額外開 staff_management ⇒ 可以進服務人員管理(走正式的 set_agent_permission)。
  const marketingAgent = await svc
    .from("merchant_agents")
    .select("id,name")
    .eq("merchant_id", fixture.merchantId)
    .eq("user_id", fixture.marketingSession.user.id)
    .single();
  const agentRow = must("查客服(再行銷)", marketingAgent.data, marketingAgent.error) as {
    id: string;
    name: string;
  };
  activeAgentName = agentRow.name;
  const perm = await fixture.admin.rpc("set_agent_permission", {
    p_agent_id: agentRow.id,
    p_section_key: "staff_management",
    p_granted: true,
  });
  if (perm.error) throw new Error(`開客服 staff_management 失敗:${perm.error.message}`);

  const staffS = await svc.from("merchant_staff").select("name").eq("id", fixture.staffId).single();
  activeStaffName = (must("查服務人員 S", staffS.data, staffS.error) as { name: string }).name;
  activeStaffId = fixture.staffId;

  // 三位服務人員:未邀請(管理員正式 insert)、邀請中、已移除(狀態用 service_role 布置)。
  const ins = await fixture.admin
    .from("merchant_staff")
    .insert([
      { merchant_id: fixture.merchantId, name: STAFF_UNINVITED, phone: phone(1) },
      { merchant_id: fixture.merchantId, name: STAFF_INVITED, phone: phone(2) },
      { merchant_id: fixture.merchantId, name: STAFF_REMOVED, phone: phone(3) },
    ])
    .select("id,name");
  const staffRows = must("建立服務人員", ins.data, ins.error) as { id: string; name: string }[];
  const idOf = (n: string) => staffRows.find((r) => r.name === n)!.id;
  const inv = await svc
    .from("merchant_staff")
    .update({
      login_status: "invited",
      invited_login_email: `e2e-b20-staff-${fixture.runId}@example.test`,
    })
    .eq("id", idOf(STAFF_INVITED))
    .eq("merchant_id", fixture.merchantId)
    .select("id");
  if (must("布置邀請中", inv.data, inv.error).length !== 1) throw new Error("布置邀請中筆數不對");
  const rem = await svc
    .from("merchant_staff")
    .update({ status: "removed" })
    .eq("id", idOf(STAFF_REMOVED))
    .eq("merchant_id", fixture.merchantId)
    .select("id");
  if (must("布置已移除", rem.data, rem.error).length !== 1) throw new Error("布置已移除筆數不對");

  // 兩位客服:邀請中、已移除。
  const ag = await svc
    .from("merchant_agents")
    .insert([
      {
        merchant_id: fixture.merchantId,
        name: AGENT_INVITED,
        phone: phone(4),
        invited_email: `e2e-b20-agent1-${fixture.runId}@example.test`,
        status: "invited",
      },
      {
        merchant_id: fixture.merchantId,
        name: AGENT_REMOVED,
        phone: phone(5),
        invited_email: `e2e-b20-agent2-${fixture.runId}@example.test`,
        status: "removed",
      },
    ])
    .select("id");
  if (must("建立客服", ag.data, ag.error).length !== 2) throw new Error("建立客服筆數不對");
});

test.afterAll(async () => {
  if (fixture) await teardownBatch3Fixture(fixture);
});

async function openAs(
  browser: Browser,
  session: Session,
  width: number,
  path: string,
): Promise<Page> {
  const mobile = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: mobile ? 812 : 900 },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  // 不讓任何 Edge Function 真的被呼叫(這支測試只點開對話框,不送出)。
  await page.route("**/functions/v1/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await injectSession(page, session);
  await page.goto("/app");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout: LOAD_TIMEOUT });
  await page.goto(path);
  return page;
}

function row(page: Page, name: string): Locator {
  return page.locator("li").filter({ hasText: name }).first();
}

/** 打開某一列的 ⋯,回傳選單裡所有項目的文字,關掉選單。 */
async function menuLabels(page: Page, r: Locator): Promise<string[]> {
  await r.getByRole("button", { name: "更多動作", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const labels = (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.trim());
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  return labels;
}

/** 卡片上看得到的按鈕 / 連結文字(不含 ⋯、不含登入信箱那一行裡的按鈕)。 */
async function cardActionLabels(r: Locator): Promise<string[]> {
  const labels: string[] = [];
  for (const name of ["編輯", "恢復", "邀請登入", "服務人員權限", "權限設定"]) {
    const btn = r.getByRole("button", { name, exact: true });
    const link = r.getByRole("link", { name, exact: true });
    if ((await btn.count()) + (await link.count()) > 0) labels.push(name);
  }
  return labels;
}

/** 卡片上每一顆動作按鈕都在卡片框內(375 不被擠出去)。 */
async function assertActionsInsideCard(r: Locator, label: string) {
  const card = r.locator(":scope > div").first();
  const box = await card.boundingBox();
  expect(box, `${label}:卡片量不到`).not.toBeNull();
  const actions = r.locator("button, a");
  const n = await actions.count();
  for (let i = 0; i < n; i++) {
    const b = await actions.nth(i).boundingBox();
    if (!b) continue;
    expect(b.x, `${label}:第 ${i} 顆按鈕左緣超出卡片`).toBeGreaterThanOrEqual(box!.x - 0.5);
    expect(b.x + b.width, `${label}:第 ${i} 顆按鈕右緣超出卡片`).toBeLessThanOrEqual(
      box!.x + box!.width + 0.5,
    );
  }
}

async function shot(page: Page, name: string) {
  // 整頁截圖時固定頁首 / 底部分頁列會蓋在畫面中間 ⇒ 拍的那一下暫時藏起來,拍完還原;
  // 也拿掉剛關掉的 ⋯ 留下的焦點框。
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const pos = getComputedStyle(el).position;
      if (pos === "fixed" || pos === "sticky") {
        el.dataset["b20Hidden"] = el.style.visibility;
        el.style.visibility = "hidden";
      }
    }
  });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-b20-hidden]"))) {
      el.style.visibility = el.dataset["b20Hidden"] ?? "";
      delete el.dataset["b20Hidden"];
    }
  });
}

for (const width of [1280, 375]) {
  test(`#1015 管理員 × 服務人員管理 ${width}:按鈕外露、⋯ 只留移除 / 真正刪除`, async ({
    browser,
  }) => {
    const page = await openAs(browser, fixture.adminSession, width, "/app/staff");
    await expect(row(page, STAFF_UNINVITED)).toBeVisible({ timeout: LOAD_TIMEOUT });
    await expect(row(page, activeStaffName)).toBeVisible();

    // 已開通登入:編輯 + 服務人員權限(連結);沒有邀請登入。
    const active = row(page, activeStaffName);
    expect(await cardActionLabels(active)).toEqual(["編輯", "服務人員權限"]);
    await expect(active.getByRole("link", { name: "服務人員權限", exact: true })).toHaveAttribute(
      "href",
      `/app/staff/${activeStaffId}/permissions`,
    );
    expect(await menuLabels(page, active)).toEqual(["移除"]);

    // 未邀請:編輯 + 邀請登入;沒有服務人員權限。
    const uninvited = row(page, STAFF_UNINVITED);
    expect(await cardActionLabels(uninvited)).toEqual(["編輯", "邀請登入"]);
    expect(await menuLabels(page, uninvited)).toEqual(["移除"]);

    // 邀請中:只有編輯(原本 ⋯ 裡也只有移除)。
    const invited = row(page, STAFF_INVITED);
    expect(await cardActionLabels(invited)).toEqual(["編輯"]);
    expect(await menuLabels(page, invited)).toEqual(["移除"]);

    // 已移除:要先切到「已移除」分頁(「全部」也包含,直接在全部找)。恢復 + ⋯ 只有真正刪除。
    const removed = row(page, STAFF_REMOVED);
    expect(await cardActionLabels(removed)).toEqual(["恢復"]);
    expect(await menuLabels(page, removed)).toEqual(["真正刪除"]);

    await assertNoHorizontalOverflow(page, `服務人員管理(管理員)${width}`);
    for (const [n, r] of [
      [activeStaffName, active],
      [STAFF_UNINVITED, uninvited],
      [STAFF_INVITED, invited],
      [STAFF_REMOVED, removed],
    ] as const) {
      await assertActionsInsideCard(r, `${n} @${width}`);
    }
    await shot(page, `staff-admin-${width}`);

    // 外露的「邀請登入」打開的是同一個小卡窗(標題含「開通登入」),取消後關閉。
    await uninvited.getByRole("button", { name: "邀請登入", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: /開通登入/ });
    await expect(dialog).toBeVisible({ timeout: LOAD_TIMEOUT });
    await shot(page, `staff-admin-${width}-invite-dialog`);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // 外露的「服務人員權限」跳到同一頁。
    await active.getByRole("link", { name: "服務人員權限", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/app/staff/${activeStaffId}/permissions$`));
    await expect(page.getByRole("heading", { name: `${activeStaffName} 的權限設定` })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await page.context().close();
  });

  test(`#1015 客服(有服務人員管理權限)× 服務人員管理 ${width}:看不到管理員專屬按鈕`, async ({
    browser,
  }) => {
    const page = await openAs(browser, fixture.marketingSession, width, "/app/staff");
    await expect(row(page, STAFF_UNINVITED)).toBeVisible({ timeout: LOAD_TIMEOUT });

    for (const name of [activeStaffName, STAFF_UNINVITED, STAFF_INVITED]) {
      const r = row(page, name);
      expect(await cardActionLabels(r), name).toEqual(["編輯"]);
      expect(await menuLabels(page, r), name).toEqual(["移除"]);
    }
    const removed = row(page, STAFF_REMOVED);
    expect(await cardActionLabels(removed)).toEqual(["恢復"]);
    // 真正刪除只給管理員 ⇒ 客服看已移除的人沒有 ⋯(跟改版前一樣)。
    await expect(removed.getByRole("button", { name: "更多動作", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "邀請登入", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "服務人員權限", exact: true })).toHaveCount(0);

    await assertNoHorizontalOverflow(page, `服務人員管理(客服)${width}`);
    await shot(page, `staff-agent-${width}`);
    await page.context().close();
  });

  test(`#1015 管理員 × 客服管理 ${width}:權限設定外露、⋯ 只留移除 / 真正刪除`, async ({
    browser,
  }) => {
    const page = await openAs(browser, fixture.adminSession, width, "/app/agents");
    await expect(row(page, AGENT_INVITED)).toBeVisible({ timeout: LOAD_TIMEOUT });

    for (const name of [activeAgentName, AGENT_INVITED]) {
      const r = row(page, name);
      expect(await cardActionLabels(r), name).toEqual(["編輯", "權限設定"]);
      expect(await menuLabels(page, r), name).toEqual(["移除"]);
    }
    const removed = row(page, AGENT_REMOVED);
    expect(await cardActionLabels(removed)).toEqual(["恢復"]);
    expect(await menuLabels(page, removed)).toEqual(["真正刪除"]);

    await assertNoHorizontalOverflow(page, `客服管理(管理員)${width}`);
    for (const name of [activeAgentName, AGENT_INVITED, AGENT_REMOVED]) {
      await assertActionsInsideCard(row(page, name), `${name} @${width}`);
    }
    await shot(page, `agents-admin-${width}`);

    // 外露的「權限設定」跳到同一頁。
    await row(page, AGENT_INVITED).getByRole("link", { name: "權限設定", exact: true }).click();
    await expect(page).toHaveURL(/\/app\/agents\/[0-9a-f-]+\/permissions$/);
    await expect(page.getByRole("heading", { name: `${AGENT_INVITED} 的權限設定` })).toBeVisible({
      timeout: LOAD_TIMEOUT,
    });
    await page.context().close();
  });
}

test("#1015 客服 × 客服管理:照舊被導回(整頁只給管理員)", async ({ browser }) => {
  const page = await openAs(browser, fixture.marketingSession, 1280, "/app/agents");
  await expect(page).toHaveURL(/\/app$/, { timeout: LOAD_TIMEOUT });
  await expect(page.getByRole("link", { name: "權限設定", exact: true })).toHaveCount(0);
  await page.context().close();
});
