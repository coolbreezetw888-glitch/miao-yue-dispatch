// 測試用:掃 src/ 原始碼裡「會被編譯進畫面的字」(字串常值、JSX 文字),註解一律排除。
//
// 跟 src/lib/terminologyGuard.test.ts 同一套做法(逐字元掃描把註解換成等長空白,行號對得上),
// 抽成共用小工具給 SPECS-INDEX #974/#976 的「改名後舊名稱不可再出現」守門測試用。
// 📌 刻意不去改 terminologyGuard.test.ts 讓它也改用這份 —— 那支是既有的守門員,這一批只動文字,不動它。
//
// 掃描範圍:src/ 底下的 .ts / .tsx;排除測試檔、src/test/、Supabase 自動產生的型別。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

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

export const PROJECT_ROOT = findProjectRoot();

function shouldSkip(relPath: string): boolean {
  const p = relPath.split("\\").join("/");
  if (/\.test\.tsx?$/.test(p)) return true;
  if (p.startsWith("src/test/")) return true;
  if (p === "src/integrations/supabase/types.ts") return true;
  if (p.includes("node_modules/")) return true;
  return false;
}

/** 把 `//`、`/* *\/`(含 JSX 的 `{/* *\/}`)註解換成等長空白,保留換行;字串與樣板字串原樣保留。 */
export function stripComments(source: string): string {
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
      if (c === "'" || c === '"' || c === "`") mode = c;
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

export interface ScannedLine {
  /** 相對專案根目錄、用 `/` 分隔的路徑。 */
  file: string;
  line: number;
  /** 已去掉註解的那一行。 */
  text: string;
}

/** src/ 底下所有要掃的原始碼,逐行(已去註解)回傳。 */
export function scanSourceLines(): ScannedLine[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(PROJECT_ROOT, full);
      if (shouldSkip(rel)) continue;
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  walk(join(PROJECT_ROOT, "src"));
  const result: ScannedLine[] = [];
  for (const file of files) {
    const rel = relative(PROJECT_ROOT, file).split("\\").join("/");
    stripComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((text, index) => result.push({ file: rel, line: index + 1, text }));
  }
  return result;
}

/** 讀某一個原始碼檔(相對專案根目錄),已去掉註解。 */
export function readSourceWithoutComments(relPath: string): string {
  return stripComments(readFileSync(join(PROJECT_ROOT, relPath), "utf8"));
}
