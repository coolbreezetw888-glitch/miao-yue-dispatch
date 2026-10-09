// SPECS-INDEX #1025 功能開關 FG1-T03:hasFeature 的判斷(featureStatus 純函式)+ 全專案文字守門。
//
//   1. 讀取中 / 讀取失敗(rows 還沒有)⇒ undefined(還不知道,呼叫端顯示骨架)
//   2. 開 ⇒ true;關 ⇒ false
//   3. 細部功能、主功能關 ⇒ false(資料庫算好的 effective 已經是 false,前端照抄,不自己重算)
//   4. 清單裡沒有的 key ⇒ false(跟資料庫 fail closed 一致)
//   5. 守門:畫面文字不再出現「此功能尚未開通」(F3=A 取消上鎖頁與這句文案)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { featureStatus, type MerchantFeatureRow } from "./features";

function row(partial: Partial<MerchantFeatureRow> & { feature_key: string }): MerchantFeatureRow {
  return {
    name: partial.feature_key,
    description: "",
    off_impact: "",
    parent_key: null,
    sort_order: 0,
    granted: true,
    effective: true,
    preset_enabled: true,
    ...partial,
  };
}

describe("featureStatus(hasFeature 的判斷)", () => {
  it("讀取中 / 讀取失敗(沒有 rows)⇒ undefined", () => {
    expect(featureStatus(undefined, "data_import")).toBeUndefined();
  });

  it("開 ⇒ true;關 ⇒ false", () => {
    const rows = [
      row({ feature_key: "data_import", granted: true, effective: true }),
      row({ feature_key: "report_export", granted: false, effective: false }),
    ];
    expect(featureStatus(rows, "data_import")).toBe(true);
    expect(featureStatus(rows, "report_export")).toBe(false);
  });

  it("細部功能自己開著、但主功能關 ⇒ 照資料庫的 effective(false)", () => {
    const rows = [
      row({ feature_key: "parent_x", granted: false, effective: false }),
      row({ feature_key: "child_x", parent_key: "parent_x", granted: true, effective: false }),
    ];
    expect(featureStatus(rows, "child_x")).toBe(false);
  });

  it("清單裡沒有的 key ⇒ false(fail closed)", () => {
    expect(featureStatus([row({ feature_key: "data_import" })], "no_such_feature")).toBe(false);
    expect(featureStatus([], "data_import")).toBe(false);
  });
});

describe("守門:不再有「尚未開通」上鎖文案(F3=A)", () => {
  function findProjectRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 6; i += 1) {
      try {
        statSync(join(dir, "package.json"));
        statSync(join(dir, "src"));
        return dir;
      } catch {
        dir = join(dir, "..");
      }
    }
    throw new Error("找不到專案根目錄");
  }

  function listSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (name === "node_modules") continue;
        out.push(...listSourceFiles(full));
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("src/ 底下(測試檔以外)沒有「此功能尚未開通」", () => {
    const root = findProjectRoot();
    const hits = listSourceFiles(join(root, "src"))
      .filter((file) => readFileSync(file, "utf8").includes("此功能尚未開通"))
      .map((file) => relative(root, file));
    expect(hits).toEqual([]);
  });
});
