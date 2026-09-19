// 模組 7(排班與休假管理)§6.5:InstallPwaHint 純函式測試(UA 判斷、standalone 判斷、
// localStorage 節流邏輯)。不測瀏覽器安裝行為本身(平台原生能力,測試工具測不到,也不需要測)。

import { describe, expect, it } from "vitest";

import { detectIosSafari, isRecentlyDismissed } from "./InstallPwaHint";

describe("detectIosSafari", () => {
  const IOS_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const IOS_CHROME =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.0.0 Mobile/15E148 Safari/604.1";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";
  const DESKTOP_CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  const IPAD_SAFARI =
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  it("iPhone 上的 Safari 判斷為 true", () => {
    expect(detectIosSafari(IOS_SAFARI)).toBe(true);
  });

  it("iPad 上的 Safari 判斷為 true", () => {
    expect(detectIosSafari(IPAD_SAFARI)).toBe(true);
  });

  it("iOS 上的 Chrome(CriOS)判斷為 false——不是真正的 Safari,不該顯示分享選單教學", () => {
    expect(detectIosSafari(IOS_CHROME)).toBe(false);
  });

  it("Android Chrome 判斷為 false", () => {
    expect(detectIosSafari(ANDROID_CHROME)).toBe(false);
  });

  it("桌面 Chrome 判斷為 false", () => {
    expect(detectIosSafari(DESKTOP_CHROME)).toBe(false);
  });
});

describe("isRecentlyDismissed", () => {
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

  it("從未關閉過(null)回傳 false,應該顯示提示", () => {
    expect(isRecentlyDismissed(null, Date.now())).toBe(false);
  });

  it("剛關閉(1 分鐘前)回傳 true,不應該顯示提示", () => {
    const now = Date.now();
    expect(isRecentlyDismissed(now - 60_000, now)).toBe(true);
  });

  it("關閉時間剛好在 7 天節流窗口邊界內(6 天 23 小時前)回傳 true", () => {
    const now = Date.now();
    expect(isRecentlyDismissed(now - (SEVEN_DAYS_MS - 60_000), now)).toBe(true);
  });

  it("關閉超過 7 天回傳 false,應該重新顯示提示", () => {
    const now = Date.now();
    expect(isRecentlyDismissed(now - (SEVEN_DAYS_MS + 60_000), now)).toBe(false);
  });
});
