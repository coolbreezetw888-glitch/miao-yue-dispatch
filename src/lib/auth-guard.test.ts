// 回歸測試:對應 ARCHITECTURE.md 第八節第 5 條要補的「模組 1~3 已知踩過的坑」第 1 項
// ——2026-09-16 那次「登入憑證失效會無限跳轉、畫面永久卡死」的嚴重穩定性 bug。
//
// 完整原因見 src/lib/auth-guard.ts 檔案開頭的說明。這裡驗證修法之後的 getVerifiedUser() 具備
// 三個必要行為,任何一個回歸都會重演那次 bug:
//   1. 憑證確實失效(伺服器回 401/403 的 AuthApiError)時,回傳 null——不是拋出例外。
//   2. 憑證確實失效時,會在背景呼叫 supabase.auth.signOut() 清掉本機那份無效憑證
//      (這是避免 /signin 頁面用 getSession() 誤判成「已登入」形成無限跳轉迴圈的關鍵修法)。
//   3. 純網路問題(AuthRetryableFetchError,不是憑證真的失效)時,不能誤觸發 signOut(),
//      否則使用者只是網路不穩就會被誤登出。
//   4. 任何非預期例外都要在這裡吞掉、統一回傳 null,Promise 絕對不能 reject
//      (呼叫端漏寫 .catch() 也不會讓畫面卡死)。
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();
const signOutMock = vi.fn().mockResolvedValue({ error: null });

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: (...args: unknown[]) => getUserMock(...args),
      signOut: (...args: unknown[]) => signOutMock(...args),
    },
  },
}));

// 動態 import,確保每個測試都拿到套用了上面 mock 之後的模組。
async function importGetVerifiedUser() {
  const mod = await import("./auth-guard");
  return mod.getVerifiedUser;
}

describe("getVerifiedUser()", () => {
  beforeEach(() => {
    getUserMock.mockReset();
    signOutMock.mockClear();
  });

  it("憑證有效時回傳伺服器驗證過的使用者,不觸發背景登出", async () => {
    const fakeUser = { id: "user-1", email: "owner@example.com" };
    getUserMock.mockResolvedValue({ data: { user: fakeUser }, error: null });

    const getVerifiedUser = await importGetVerifiedUser();
    const result = await getVerifiedUser();

    expect(result).toEqual(fakeUser);
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("憑證確實失效(401 AuthApiError)時回傳 null,並在背景觸發 signOut 清除本機憑證", async () => {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: new AuthApiError("Invalid JWT", 401, "invalid_token"),
    });

    const getVerifiedUser = await importGetVerifiedUser();
    const result = await getVerifiedUser();

    expect(result).toBeNull();
    // getVerifiedUser 內部刻意不 await signOut()(避免擋住畫面轉場),所以這裡等一個 microtask
    // 讓那個 fire-and-forget 的呼叫有機會真的被觸發。
    await Promise.resolve();
    await Promise.resolve();
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("純網路問題(AuthRetryableFetchError)時回傳 null,但不誤觸發登出", async () => {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: new AuthRetryableFetchError("Failed to fetch", 0),
    });

    const getVerifiedUser = await importGetVerifiedUser();
    const result = await getVerifiedUser();

    expect(result).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(signOutMock).not.toHaveBeenCalled();
  });

  it("getUser() 意外 reject 時,Promise 不會 reject,一律回傳 null", async () => {
    getUserMock.mockRejectedValue(new Error("unexpected network crash"));

    const getVerifiedUser = await importGetVerifiedUser();

    await expect(getVerifiedUser()).resolves.toBeNull();
    expect(signOutMock).not.toHaveBeenCalled();
  });
});
