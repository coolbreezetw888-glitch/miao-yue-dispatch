// src/lib/deviceDetection.ts 的單元測試(SPECS-INDEX #862)。
// 原本這一組寫在 src/components/InstallPwaHint.test.ts 裡,跟著函式一起搬過來
// (函式搬到 src/lib 的理由見 deviceDetection.ts 檔頭)。

import { describe, expect, it } from "vitest";

import { isMobileDevice } from "./deviceDetection";

// SPECS-INDEX #862(2026-09-30 使用者裁決 A):安裝提示只在手機顯示,電腦完全不跳。
// 這一組測試釘住的是「不要在電腦上跳」——那是使用者實際回報的問題,誤判成手機的代價最高。
describe("isMobileDevice(#862:安裝提示只在手機顯示)", () => {
  const IPHONE_SAFARI =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const IPAD_SAFARI =
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const ANDROID_CHROME =
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";
  const ANDROID_TABLET_CHROME =
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  // 🔴 這一個就是使用者回報的元凶:桌面版 Chrome 也支援 beforeinstallprompt,所以提示條會跳。
  const WINDOWS_CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  const WINDOWS_EDGE =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0";
  const MAC_CHROME =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
  const MAC_SAFARI =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const LINUX_FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0";

  it("iPhone Safari → true", () => {
    expect(isMobileDevice({ userAgent: IPHONE_SAFARI, maxTouchPoints: 5 })).toBe(true);
  });

  it("iPad Safari(UA 裡有 iPad)→ true", () => {
    expect(isMobileDevice({ userAgent: IPAD_SAFARI, maxTouchPoints: 5 })).toBe(true);
  });

  it("Android 手機 Chrome → true", () => {
    expect(isMobileDevice({ userAgent: ANDROID_CHROME, maxTouchPoints: 5 })).toBe(true);
  });

  it("Android 平板 Chrome(UA 裡沒有 Mobile)→ true", () => {
    expect(isMobileDevice({ userAgent: ANDROID_TABLET_CHROME, maxTouchPoints: 5 })).toBe(true);
  });

  it("🔴 桌面 Windows Chrome → false(這就是使用者回報「電腦也會跳」的那一台)", () => {
    expect(isMobileDevice({ userAgent: WINDOWS_CHROME, maxTouchPoints: 0 })).toBe(false);
  });

  it("桌面 Windows Edge → false", () => {
    expect(isMobileDevice({ userAgent: WINDOWS_EDGE, maxTouchPoints: 0 })).toBe(false);
  });

  it("桌面 macOS Chrome → false", () => {
    expect(isMobileDevice({ userAgent: MAC_CHROME, maxTouchPoints: 0 })).toBe(false);
  });

  it("桌面 macOS Safari → false", () => {
    expect(isMobileDevice({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe(false);
  });

  it("桌面 Linux Firefox → false", () => {
    expect(isMobileDevice({ userAgent: LINUX_FIREFOX, maxTouchPoints: 0 })).toBe(false);
  });

  it("觸控式 Windows 筆電(有觸控但 UA 是 Windows NT)→ false,它是電腦不是手機", () => {
    expect(isMobileDevice({ userAgent: WINDOWS_CHROME, maxTouchPoints: 10 })).toBe(false);
  });

  it("iPadOS 13+ 的「桌面版 UA」iPad(UA 說 Macintosh,但有多點觸控)→ true", () => {
    // 這是 iPad 上 Safari 的預設行為:UA 完全看不出是 iPad,只能靠 maxTouchPoints 補判。
    expect(isMobileDevice({ userAgent: MAC_SAFARI, maxTouchPoints: 5 })).toBe(true);
  });

  it("maxTouchPoints 讀不到時傳 0,不會把 Mac 誤判成 iPad", () => {
    expect(isMobileDevice({ userAgent: MAC_SAFARI, maxTouchPoints: 0 })).toBe(false);
  });
});
