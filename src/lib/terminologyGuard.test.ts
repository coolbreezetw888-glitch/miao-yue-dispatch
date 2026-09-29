// 用語守門測試:全系統「使用者看得到的字」都不可以出現特定產業的稱呼。
//
// 🔴 為什麼要有這一支(2026-09-30,SPECS-INDEX #832 收尾批)
// 2026-09-24 全系統把「師傅」改成「服務人員」之後,**已經第三次**在使用者看得到的地方抓到殘留:
//   ① ui-v1-full 第 3 批:資料匯入精靈的「歷史訂單 CSV 模板」示範列寫「王師傅」。
//   ② 收尾批:行銷首頁(src/routes/index.tsx)「服務人員端」那段的手機模擬畫面寫「阿哲師傅」
//      —— 而且就在一句「服務人員端不用下載 App」的正下方。
//   ③(加上原本 2026-09-24 那批本身漏掉的幾處)
//
// 原本的守門測試(src/modules/platform-admin/personDisplay.test.ts)只斷言幾個**用語標籤常數**
// (STAFF_LOGIN_STATUS_LABELS / AGENT_STATUS_LABELS…),掃不到「示範資料」「CSV 模板」
// 「通知訊息範本的範例值」「行銷首頁的假畫面」這些同樣是使用者看得到的字。所以這裡改成
// **直接掃原始碼**:凡是會被編譯進畫面的字(字串常值、JSX 文字),一律不准出現那些詞。
//
// 🔴 程式碼註解要排除在外。註解裡本來就會寫歷史沿革(「2026-09-24 把師傅改成服務人員」)、
//    寫這次踩的坑 —— 那是**脈絡**,不是用語,把它一起禁掉的話,以後沒有人能在程式碼裡
//    解釋「為什麼不能用這個詞」,規則本身就失傳了。所以下面 stripComments() 會先把
//    `//` 行註解、`/* */` 區塊註解(含 JSX 的 `{/* */}`)整段換成空白,只留字串與 JSX 文字。
//
// 📌 測試檔案(*.test.ts / *.test.tsx)不在掃描範圍內:
//    那些是「商家自己打進資料庫的值」的測試資料(例:adminDisplay.test.ts 驗證
//    job_title 填「店長」會原樣顯示 —— 商家自己要填什麼職稱是他的自由,系統不該改他的字)。
//    這支測試禁的是「**系統自己寫死的用語**」,不是使用者填的內容。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LINE_MARKETING_TEMPLATE_PREVIEW_SAMPLE_VALUES,
  LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES,
} from "@/modules/line-notifications/templateVariables";
import { PUSH_TEMPLATE_PREVIEW_SAMPLE_VALUES } from "@/modules/push-notifications/templateVariables";

/**
 * 🔴 禁用的特定產業稱呼。要新增的話直接加在這裡。
 *
 * 一律用「服務人員」。理由(skill 二之二):使用者本人做冷氣,會不自覺講「師傅」,但這套系統
 * 要賣給美甲、美容、寵物美容、到府清潔各行各業 —— 美甲師看到「師傅」會覺得這套系統不是給他用的。
 */
const FORBIDDEN_TERMS = ["師傅", "店長", "技師", "美容師"];

/**
 * 專案根目錄。刻意不用 `import.meta.url`:Vite / Vitest 給的 `import.meta.url` 不保證是
 * `file://` scheme(實測會噴 `TypeError: The URL must be of scheme file`),所以從
 * `process.cwd()` 往上找到有 `package.json` 的那一層,不管測試從哪個目錄被啟動都找得到。
 */
function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到專案根目錄(從 ${process.cwd()} 往上找 package.json + src/ 都沒有)`);
}

const PROJECT_ROOT = findProjectRoot();

/**
 * 要掃的範圍。
 * - `src`:前端全部的畫面文字、示範資料、CSV 模板、通知範本範例值。
 * - `supabase/functions`:Edge Function 組出來的 LINE / 推播訊息內文,使用者在手機上直接看到。
 */
const SCAN_ROOTS = ["src", join("supabase", "functions")];

/** 掃不到的東西:測試資料、自動產生的型別、第三方套件。 */
function shouldSkip(relPath: string): boolean {
  const p = relPath.split("\\").join("/");
  if (/\.test\.tsx?$/.test(p)) return true; // 測試資料 = 商家自己填的值,不是系統用語
  if (p.startsWith("src/test/")) return true; // 測試環境設定
  if (p === "src/integrations/supabase/types.ts") return true; // Supabase CLI 自動產生
  if (p.includes("node_modules/")) return true;
  return false;
}

/**
 * 把註解換成等長的空白(保留換行,所以回報的行號跟原始檔完全對得上)。
 *
 * 用逐字元掃描而不是正則:正則沒辦法分辨「真的註解」跟「字串裡剛好有 `//`」
 * (例如 `"https://example.com"`)—— 用正則會把網址後面整行吃掉,漏掉真正的違規字。
 */
function stripComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";
  let mode: Mode = "code";

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        out.push("  ");
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        mode = c;
        out.push(c);
        i += 1;
        continue;
      }
      out.push(c);
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out.push("\n");
      } else {
        out.push(" ");
      }
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        out.push("  ");
        i += 2;
        continue;
      }
      out.push(c === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }

    // 字串 / 樣板字串:原樣保留(這些就是要檢查的內容),只處理轉義與結束引號。
    if (c === "\\") {
      out.push(c, next ?? "");
      i += 2;
      continue;
    }
    if (c === mode) mode = "code";
    out.push(c);
    i += 1;
  }

  return out.join("");
}

function listSourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // 目錄不存在(例如還沒 deno cache 的環境)就跳過,不讓測試因此變紅
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const rel = relative(PROJECT_ROOT, full);
      if (shouldSkip(rel)) continue;
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };
  for (const root of SCAN_ROOTS) walk(join(PROJECT_ROOT, root));
  return found;
}

interface Violation {
  file: string;
  line: number;
  term: string;
  text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const file of listSourceFiles()) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((text, index) => {
      for (const term of FORBIDDEN_TERMS) {
        if (text.includes(term)) {
          violations.push({
            file: relative(PROJECT_ROOT, file).split("\\").join("/"),
            line: index + 1,
            term,
            text: text.trim().slice(0, 120),
          });
        }
      }
    });
  }
  return violations;
}

describe("用語守門:使用者看得到的字不可以出現特定產業稱呼", () => {
  // 先確認掃描機制本身有效 —— 如果 walk() 哪天壞掉回傳 0 個檔案,上面那條「沒有違規」
  // 會假性通過,這支守門測試就變成永遠綠燈的裝飾品。
  it("掃描範圍有抓到檔案(防止掃描機制壞掉造成假性通過)", () => {
    const files = listSourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith("ImportWizardPage.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("index.tsx"))).toBe(true);
  });

  it("註解會被排除、字串與 JSX 文字會被保留", () => {
    const sample = [
      "// 2026-09-24 把師傅改成服務人員(這是歷史沿革,不算用語,不可以被判違規)",
      "/* 區塊註解裡的師傅也一樣不算 */",
      'const url = "https://example.com/a"; const bad = "王師傅";',
      "const ok = `模板字串裡的店長要抓到`;",
    ].join("\n");
    const stripped = stripComments(sample);
    // 註解那兩行被清成空白
    expect(stripped.split("\n")[0]!.trim()).toBe("");
    expect(stripped.split("\n")[1]!.trim()).toBe("");
    // 🔴 關鍵:`https://` 後面的 `"王師傅"` 不可以被當成行註解一起吃掉
    expect(stripped.split("\n")[2]).toContain("王師傅");
    expect(stripped.split("\n")[3]).toContain("店長");
  });

  it("全系統(src + supabase/functions,排除註解與測試資料)沒有任何違規用語", () => {
    const violations = findViolations();
    const message = violations
      .map((v) => `  ${v.file}:${v.line} 出現「${v.term}」→ ${v.text}`)
      .join("\n");
    expect(
      violations,
      `以下位置出現了特定產業的稱呼,一律改成「服務人員」(skill ui-overlay-patterns 二之二):\n${message}\n` +
        `如果這裡是「商家自己填進資料庫的值」而不是系統寫死的用語,請把它移到測試檔案或改成不寫死的字串。`,
    ).toEqual([]);
  });
});

describe("用語守門:通知訊息範本的範例值", () => {
  // 這幾份是商家在「LINE 事件設定」「推播事件設定」「行銷通知」頁面上,
  // 三欄說明表的「範例值」那一欄 + 下方預覽框裡實際看到的假資料。
  const sampleValueSets: [string, Record<string, string>][] = [
    ["LINE 事件通知", LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES],
    ["LINE 行銷通知", LINE_MARKETING_TEMPLATE_PREVIEW_SAMPLE_VALUES],
    ["推播通知", PUSH_TEMPLATE_PREVIEW_SAMPLE_VALUES],
  ];

  it.each(sampleValueSets)("%s 的範例值不含特定產業稱呼", (_name, values) => {
    const joined = Object.values(values).join("|");
    for (const term of FORBIDDEN_TERMS) {
      expect(joined, `範例值裡出現「${term}」`).not.toContain(term);
    }
  });

  it("服務人員姓名那一格真的有值(空的話上面那條會假性通過)", () => {
    expect(LINE_TEMPLATE_PREVIEW_SAMPLE_VALUES["staff_name"]).toBeTruthy();
  });
});
