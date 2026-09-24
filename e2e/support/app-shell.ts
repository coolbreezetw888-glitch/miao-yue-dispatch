// 多支 e2e 測試共用的「商家管理員/客服 session 啟動步驟」。
//
// 為什麼需要這一步(既有問題,跟任何單一模組的修正主題無關,原本散落在 members.spec.ts /
// mobile-overflow.spec.ts 等各檔案 beforeEach 的註解裡):全新瀏覽器 session 第一次直接深連結
// 到受保護頁面時,有機會在 currentMerchantId 還沒被 src/modules/merchant/context.tsx 的
// fallback effect 寫進 localStorage 前,就先讀到 merchant === null 而被 Require*Access 守衛
// 誤判導回 /app。先造訪一次後台外殼頁,讓「目前操作中商家」正確寫進 localStorage,之後同一個
// 瀏覽器 context 內再深連結其他頁面就不會再踩到這個 race。這個目的到今天仍然成立,不能省略。
//
// 2026-09-24 修正(這次改動的原因):原本這一步是 `page.goto("/app")` + 斷言畫面上的
// 「目前操作中的商家」這段佔位文字。2026-09-23 的後台導覽改版(見 src/routes/HomePage.tsx
// 檔案開頭的完整說明)把「首頁」分頁籤從商家管理員/客服視角拔掉了:
//   1. /app 對商家管理員/客服現在會直接 <Navigate to="/app/manage" replace />;
//   2. 「目前操作中的商家」那段 M0 時期的佔位文字已經被移除。
// 所以舊斷言永遠等不到,20 秒後逾時、整個檔案的測試全垮。改成直接造訪 /app/manage(商家管理員
// 的「功能」頁),並斷言 ManagePage 根容器的 data-testid。
//
// 為什麼挑根容器的 data-testid 當錨點,而不是頁面上某張功能卡片:ManagePage 上的每一張卡片
// (客服管理、LINE 串接設定、資料匯入⋯)都會因為角色/權限開關而消失(見 ManagePage.tsx 的
// visible 判斷),拿任何一張當錨點都會讓「客服 + 權限被關掉」的測試情境誤判失敗。根容器則是
// 商家管理員/客服兩種角色、任何權限組合下都一定渲染(一張卡片都看不到時顯示空狀態文字,
// 不是整頁消失)。AppLayout 本身已經先擋掉 merchantsLoading 才會渲染子路由,所以這個錨點出現
// 的時機跟舊斷言等價——merchants 載入完成,也正是 fallback effect 寫 localStorage 的時機。
//
// 注意:這個 helper 只適用於商家管理員/客服 session。服務人員 session 的落點仍然是 /app
// (HomePage.tsx 現在專職服務人員自己的個人資料首頁),不要套用在服務人員測試上。
import { expect, type Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 20_000;

/** 造訪後台「功能」頁,等它確實渲染完成,確保「目前操作中商家」已經寫進 localStorage。 */
export async function primeCurrentMerchant(page: Page, timeout = DEFAULT_TIMEOUT): Promise<void> {
  await page.goto("/app/manage");
  await expect(page.getByTestId("manage-page")).toBeVisible({ timeout });
}
