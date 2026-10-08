// 客戶端第 3 批(C3-D04 / C3-F06 / C3-F07):Turnstile sitekey 與腳本載入。
import { afterEach, describe, expect, it } from "vitest";

import {
  loadTurnstile,
  resetTurnstileLoaderForTest,
  resolveTurnstileSiteKey,
  TURNSTILE_SCRIPT_SRC,
  TURNSTILE_TEST_SITEKEY_PASS,
} from "./turnstile";

afterEach(() => {
  resetTurnstileLoaderForTest();
  delete window.turnstile;
  document.querySelectorAll("script[data-miaoyue='turnstile']").forEach((s) => s.remove());
});

describe("resolveTurnstileSiteKey", () => {
  it("有設環境變數就用(去空白)", () => {
    expect(resolveTurnstileSiteKey({ key: " 0x4AAA ", dev: false })).toBe("0x4AAA");
  });
  it("本機開發沒設 ⇒ 官方必過測試 sitekey;正式 build 沒設 ⇒ null(不偷用測試金鑰)", () => {
    expect(resolveTurnstileSiteKey({ key: undefined, dev: true })).toBe(
      TURNSTILE_TEST_SITEKEY_PASS,
    );
    expect(resolveTurnstileSiteKey({ key: "", dev: false })).toBeNull();
  });
});

describe("loadTurnstile", () => {
  it("只插一次官方腳本(render=explicit);載入後回傳 window.turnstile", async () => {
    const p1 = loadTurnstile();
    const p2 = loadTurnstile();
    const scripts = document.querySelectorAll("script[data-miaoyue='turnstile']");
    expect(scripts).toHaveLength(1);
    expect((scripts[0] as HTMLScriptElement).src).toBe(TURNSTILE_SCRIPT_SRC);
    const api = { render: () => "w", execute: () => {}, reset: () => {}, remove: () => {} };
    window.turnstile = api;
    scripts[0]!.dispatchEvent(new Event("load"));
    await expect(p1).resolves.toBe(api);
    await expect(p2).resolves.toBe(api);
  });

  it("載入失敗 ⇒ reject,下次可以重試", async () => {
    const p = loadTurnstile();
    document.querySelector("script[data-miaoyue='turnstile']")!.dispatchEvent(new Event("error"));
    await expect(p).rejects.toThrow("turnstile-load-failed");
    expect(document.querySelectorAll("script[data-miaoyue='turnstile']")).toHaveLength(0);
    void loadTurnstile().catch(() => undefined);
    expect(document.querySelectorAll("script[data-miaoyue='turnstile']")).toHaveLength(1);
  });

  it("前端原始碼不含任何 Turnstile secret(C3-F06)", async () => {
    const mod = await import("./turnstile?raw");
    const src = (mod as { default: string }).default;
    // secret 長得像 0x4AAAAAAA…(正式)或 1x0000…0AA(官方測試 secret,30 個以上的 0);sitekey 只有 20 個 0。
    expect(src).not.toMatch(/[0-9]x0{30,}A{2}|0x4AAAAAAA[A-Za-z0-9_-]{20,}/);
    expect(src).not.toContain("import.meta.env.TURNSTILE_SECRET");
  });
});
