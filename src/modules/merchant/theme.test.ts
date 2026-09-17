// 對應規格書「首頁外殼與主題色優化」二、2.1/2.2:主題色實際套用的核心 bug 修正。
// 這裡驗證兩個純函式(resolveMerchantThemeColor / deriveThemeColors)的邏輯,以及
// applyThemeColorToDocument 真的有把值寫進 <html> 的 inline style(jsdom 環境下可以直接檢查
// document.documentElement.style)。
import { afterEach, describe, expect, it } from "vitest";

import { applyThemeColorToDocument, deriveThemeColors, resolveMerchantThemeColor } from "./theme";
import type { Merchant } from "./types";

function fakeMerchant(overrides: Partial<Pick<Merchant, "theme_preset" | "theme_custom_color">>) {
  return {
    theme_preset: null,
    theme_custom_color: null,
    ...overrides,
  } as Pick<Merchant, "theme_preset" | "theme_custom_color">;
}

describe("resolveMerchantThemeColor()", () => {
  it("自訂色有值時,優先權高於預設色系(規格書 2.1 明講的優先順序)", () => {
    const color = resolveMerchantThemeColor(
      fakeMerchant({ theme_preset: "warm_green", theme_custom_color: "#EC4899" }),
    );
    expect(color).toBe("#EC4899");
  });

  it("只有預設色系、沒有自訂色時,退回預設色系對應的代表色", () => {
    const color = resolveMerchantThemeColor(fakeMerchant({ theme_preset: "soft_pink" }));
    expect(color).toBe("#EC4899");
  });

  it("兩者都沒有設定時回傳 null(防禦性處理,理論上不會發生)", () => {
    expect(resolveMerchantThemeColor(fakeMerchant({}))).toBeNull();
    expect(resolveMerchantThemeColor(null)).toBeNull();
  });

  it("自訂色格式不合法時忽略,退回預設色系", () => {
    const color = resolveMerchantThemeColor(
      fakeMerchant({ theme_preset: "steady_blue", theme_custom_color: "not-a-color" }),
    );
    expect(color).toBe("#2563EB");
  });

  it("preset key 對不到任何已知色系時(理論上不會發生)回傳 null", () => {
    expect(resolveMerchantThemeColor(fakeMerchant({ theme_preset: "unknown_key" }))).toBeNull();
  });
});

describe("deriveThemeColors()", () => {
  it("brand/cta/ring 直接採用輸入的 hex 顏色", () => {
    const derived = deriveThemeColors("#EC4899");
    expect(derived.brand).toBe("#EC4899");
    expect(derived.cta).toBe("#EC4899");
    expect(derived.ring).toBe("#EC4899");
  });

  it("偏亮的顏色(例如白色系)疊字用深色,確保對比足夠可讀", () => {
    const derived = deriveThemeColors("#FDE68A"); // 淺黃色,亮度高
    expect(derived.brandForeground).toBe("#171717");
    expect(derived.ctaForeground).toBe("#171717");
  });

  it("偏暗的顏色疊字用白色", () => {
    const derived = deriveThemeColors("#111827"); // 簡約黑白預設色,亮度低
    expect(derived.brandForeground).toBe("#ffffff");
    expect(derived.ctaForeground).toBe("#ffffff");
  });

  it("soft 變化值是跟著輸入顏色算出來的 color-mix(),不是寫死的固定字串", () => {
    const derived = deriveThemeColors("#2563EB");
    expect(derived.brandSoft).toContain("#2563EB");
    expect(derived.ctaSoft).toContain("#2563EB");
  });
});

describe("applyThemeColorToDocument()", () => {
  afterEach(() => {
    // 每個測試案例結束後清掉 inline style,避免互相汙染下一個案例的斷言。
    document.documentElement.removeAttribute("style");
  });

  it("有解析出顏色時,把衍生值寫進 <html> 的 inline style,覆寫既有 CSS 變數", () => {
    applyThemeColorToDocument("#16A34A");
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--brand")).toBe("#16A34A");
    expect(style.getPropertyValue("--cta")).toBe("#16A34A");
    expect(style.getPropertyValue("--ring")).toBe("#16A34A");
    expect(style.getPropertyValue("--brand-foreground")).not.toBe("");
  });

  it("換成沒有主題色的商家(resolvedColor 為 null)時,清掉先前的覆寫,不殘留上一間商家的顏色", () => {
    applyThemeColorToDocument("#16A34A");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#16A34A");

    applyThemeColorToDocument(null);
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--cta")).toBe("");
  });

  it("切換到另一間主題色不同的商家時,新顏色會直接覆蓋掉舊的,不殘留", () => {
    applyThemeColorToDocument("#16A34A");
    applyThemeColorToDocument("#7C3AED");
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#7C3AED");
  });
});
