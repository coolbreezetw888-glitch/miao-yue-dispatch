// 回歸測試:對應 ARCHITECTURE.md 第八節第 5 條要補的坑第 1 項
// ——2026-09-16「登入憑證失效會無限跳轉、畫面永久卡死」的嚴重穩定性 bug,端對端版本。
// 完整背景見 src/lib/auth-guard.ts 檔案開頭的說明。
//
// 這裡重現的情境:瀏覽器本機還留著一份「格式正確、但簽章無效(已失效)」的 Supabase session,
// 造訪 /app 之後,伺服器驗證會判定這組憑證無效——驗證修好之後的行為是:
//   1. 最終落在 /signin,不會卡在「載入中」,也不會在 /app <-> /signin 之間無限跳轉。
//   2. 不會對 /auth/v1/user 瘋狂連續發送請求(原始 bug 重現時實測是每秒 20 幾次)。
//   3. 背景會自動清掉本機那份已經失效的憑證(呼叫 supabase.auth.signOut())。
//
// 這份測試會打「真正的」Supabase Auth 伺服器(.env 設定的正式專案),但只送出一組格式正確、
// 簽章無效的假 token——這是唯讀的憑證驗證行為(伺服器只會回 401,不會有任何資料被讀取或寫入),
// 不會影響任何真實使用者或真實資料。
import { expect, test } from "@playwright/test";

import { getSupabaseAuthStorageKey } from "./support/supabase-storage-key";

function buildFakeInvalidSession() {
  const now = Math.floor(Date.now() / 1000);
  return {
    // 格式看起來像 JWT(三段用 . 分隔),但簽章段落是亂數,伺服器驗證一定會判定無效。
    access_token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e2e-fake-payload.not-a-real-signature",
    token_type: "bearer",
    expires_in: 3600,
    // expires_at 刻意設在未來,模擬「本機快取看起來還沒過期」的情境——這正是原始 bug 的關鍵:
    // 只讀本機快取的 getSession() 會誤判成「已登入」,只有真的打去伺服器的 getUser() 才驗得出來。
    expires_at: now + 3600,
    refresh_token: "e2e-fake-refresh-token-clearly-not-real",
    user: {
      id: "00000000-0000-0000-0000-000000000000",
      aud: "authenticated",
      role: "authenticated",
      email: "e2e-fake-session@example.invalid",
    },
  };
}

test.describe("登入憑證失效不會無限跳轉(回歸測試)", () => {
  test("灌入無效 token 造訪 /app,最終落在 /signin 且沒有陷入跳轉迴圈", async ({ page }) => {
    const storageKey = getSupabaseAuthStorageKey();
    const fakeSession = buildFakeInvalidSession();

    // 在任何頁面 script 執行之前,先把假 session 塞進 localStorage(每次 goto 都會重新套用)。
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value);
      },
      [storageKey, JSON.stringify(fakeSession)] as [string, string],
    );

    let authUserRequestCount = 0;
    page.on("request", (request) => {
      if (request.url().includes("/auth/v1/user")) {
        authUserRequestCount += 1;
      }
    });

    await page.goto("/app");

    // 憑證驗證失敗後應該落在 /signin。原始 bug 重現時,畫面會永久卡在「載入中」,永遠等不到這個
    // URL 變化,所以這裡的 timeout 本身就是一種偵測手段。
    await page.waitForURL(/\/signin$/, { timeout: 15_000 });

    // 再多觀察幾秒,確認沒有反彈回 /app 又跳回來(原始 bug 的症狀是兩邊互相導來導去,不會停在
    // /signin 不動)。
    await page.waitForTimeout(3000);
    expect(page.url()).toMatch(/\/signin$/);

    // 原始 bug 重現時,/auth/v1/user 會被瘋狂連續呼叫(實測每秒 20 幾次、永遠停不下來)。
    // 這裡不要求剛好幾次(正常流程裡 CurrentMerchantProvider、AppShell、SignIn 各自的
    // getVerifiedUser() 呼叫都合理),只驗證「沒有失控暴增到兩位數以上」。
    expect(authUserRequestCount).toBeLessThan(8);

    // 憑證確實失效時,getVerifiedUser() 應該已經在背景清掉本機那份無效憑證。
    const remaining = await page.evaluate((key) => window.localStorage.getItem(key), storageKey);
    expect(remaining).toBeNull();
  });
});
