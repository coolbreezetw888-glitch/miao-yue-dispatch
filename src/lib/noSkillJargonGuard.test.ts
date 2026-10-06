// #986 第 9 批(9-14,使用者裁決 8):畫面文字不可以出現「skill」這種工程內部用語。
//
// 起因:主題配色說明曾經寫著「(skill 一：元件不寫死品牌色，一律跟著這裡走)」—— 那是寫給工程師看的
// 設計規範代號,商家看不懂。這支守門掃 src/ 底下「會被編譯進畫面的字」(字串常值、樣板字串文字片段、
// JSX 文字),出現 skill(不分大小寫)就擋。
//   - 程式註解不掃(註解本來就常引用 skill 規範,那是給工程師看的脈絡)。
//   - 測試檔不掃。console.* 的參數不掃。
//   - 實際掃描結果(2026-10-07):改掉主題配色那一句之後,畫面文字裡一處都沒有,所以不用另外縮小成只掃
//     help= / description= 這類說明屬性。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const JARGON = /skill/i;

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
  throw new Error("找不到專案根目錄(有 package.json 和 src 的那一層)");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function isInsideConsoleCall(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) return true;
    p = p.parent;
  }
  return false;
}

function scanSource(file: string, source: string): { file: string; line: number; text: string }[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: { file: string; line: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      node.kind === ts.SyntaxKind.JsxText;
    if (isText) {
      const text = (node as ts.LiteralLikeNode).text;
      if (JARGON.test(text) && !isInsideConsoleCall(node)) {
        hits.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          text: text.trim().replace(/\s+/g, " "),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("畫面文字不可以出現工程用語「skill」(#986 第 9 批)", () => {
  // 掃描放在 describe 本體(跟 punctuationGuard 一樣),不吃單一測試的 5 秒逾時(全套平行跑時會變慢)。
  const root = findProjectRoot();
  const hits = listSourceFiles(join(root, "src")).flatMap((full) => {
    const rel = relative(root, full).split("\\").join("/");
    return scanSource(rel, readFileSync(full, "utf8"));
  });

  it("src/ 底下的畫面文字沒有 skill", () => {
    expect(
      hits.map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 80)}`),
      "畫面文字裡出現了 skill(工程內部的設計規範代號),商家看不懂,請改成白話說明或刪掉",
    ).toEqual([]);
  });

  describe("偵測邏輯自我檢查", () => {
    it("說明文字裡夾 skill ⇒ 抓到;註解、console 不抓", () => {
      expect(
        scanSource("x.tsx", 'const a = <F help="套用到全站(skill 一：不寫死)" />;'),
      ).toHaveLength(1);
      expect(scanSource("x.tsx", "const a = <p>依 Skill 規範</p>;")).toHaveLength(1);
      expect(scanSource("x.ts", "// skill 二之七\nconst a = 1;")).toEqual([]);
      expect(scanSource("x.ts", 'console.log("skill");')).toEqual([]);
    });
  });
});
