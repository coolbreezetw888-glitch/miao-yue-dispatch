// SPECS-INDEX #1052 H2-13:vercel.json 全站安全標頭守門(不准被拿掉;CSP 之後另批再加)。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface VercelConfig {
  rewrites?: unknown[];
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

const config = JSON.parse(
  readFileSync(resolve(__dirname, "../../vercel.json"), "utf8"),
) as VercelConfig;

function headerValue(key: string): string | undefined {
  const all = config.headers?.find((h) => h.source === "/(.*)")?.headers ?? [];
  return all.find((h) => h.key === key)?.value;
}

describe("vercel.json 安全標頭(#1052 H2-13)", () => {
  it("全站套用:不能被別的網站用 iframe 包、不猜檔案類型、跨站只送來源網域", () => {
    expect(headerValue("X-Frame-Options")).toBe("DENY");
    expect(headerValue("X-Content-Type-Options")).toBe("nosniff");
    expect(headerValue("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  it("Permissions-Policy 關掉用不到的鏡頭 / 麥克風 / 定位等;剪貼簿、通知不在清單內(複製網址、推播照常)", () => {
    const value = headerValue("Permissions-Policy") ?? "";
    for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
      expect(value).toContain(feature);
    }
    expect(value).not.toMatch(/clipboard|notifications|push/);
  });

  it("原本的 SPA 轉址規則還在", () => {
    expect(config.rewrites).toEqual([{ source: "/(.*)", destination: "/index.html" }]);
  });
});
