// 第 6 批(SPECS-INDEX #849):預設 e2e「目標切換」(e2e-target.ts)的單元測試。
// 這支是本機模式的第一道關卡:打錯字不可以被當成「沒設」而連到正式庫。
import { afterEach, describe, expect, it } from "vitest";

import { E2E_TARGET_ENV, isLocalE2eTarget, parseE2eTarget } from "./e2e-target";

describe("parseE2eTarget", () => {
  it("沒設 / 空字串 ⇒ default(行為跟改版前一樣)", () => {
    expect(parseE2eTarget(undefined)).toBe("default");
    expect(parseE2eTarget("")).toBe("default");
  });

  it("local ⇒ local", () => {
    expect(parseE2eTarget("local")).toBe("local");
  });

  it("🔴 其他任何值(打錯字、大小寫不同、正式站名稱)一律中止,不當成沒設", () => {
    for (const bad of ["locl", "Local", "LOCAL", " local", "prod", "true", "1"]) {
      expect(() => parseE2eTarget(bad), bad).toThrow(/只接受/);
    }
  });
});

describe("isLocalE2eTarget", () => {
  const saved = process.env[E2E_TARGET_ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[E2E_TARGET_ENV];
    else process.env[E2E_TARGET_ENV] = saved;
  });

  it("看的是行程的環境變數", () => {
    delete process.env[E2E_TARGET_ENV];
    expect(isLocalE2eTarget()).toBe(false);
    process.env[E2E_TARGET_ENV] = "local";
    expect(isLocalE2eTarget()).toBe(true);
  });
});
