// SPECS-INDEX #1052 H2-12:上傳圖片的副檔名由 MIME 決定,不抄原檔名。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { imageExtensionForMime } from "./imageUploadExtension";

describe("imageExtensionForMime", () => {
  it("png / jpeg / webp 對應到固定副檔名", () => {
    expect(imageExtensionForMime("image/png")).toBe("png");
    expect(imageExtensionForMime("image/jpeg")).toBe("jpg");
    expect(imageExtensionForMime("image/webp")).toBe("webp");
  });

  it("其他類型一律擋下", () => {
    expect(() => imageExtensionForMime("image/svg+xml")).toThrow(
      "只能上傳 PNG、JPG 或 WEBP 格式的圖片",
    );
    expect(() => imageExtensionForMime("text/html")).toThrow();
    expect(() => imageExtensionForMime("")).toThrow();
  });

  it("三支上傳函式都不再從原檔名取副檔名", () => {
    for (const file of [
      "src/modules/merchant/api.ts",
      "src/modules/staff-agent/api.ts",
      "src/modules/staff-portal/api.ts",
    ]) {
      const src = readFileSync(resolve(__dirname, "../..", file), "utf8");
      expect(src, file).not.toMatch(/file\.name\.split\(/);
      expect(src, file).toContain("imageExtensionForMime(file.type)");
    }
  });
});
