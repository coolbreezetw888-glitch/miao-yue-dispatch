// Edge Function 回傳訊息標點守門(SPECS-INDEX #987 第 10 批 10-7)。
//
// 🔴 為什麼要有這一支
// 第 10 批把 Edge Function 回傳給畫面的中文錯誤訊息(jsonResponse({ error }), errorDetail, error_detail 等)
// 從半形 , : ; ! ? 改成全形。前端守門(punctuationGuard.test.ts)只掃 src/,
// 資料庫守門(supabase/tests/database/req987_04_backend_punctuation_guard.sql)只掃 pg_proc,
// Edge Function 夾在中間沒人管,之後新寫的訊息很容易又打成半形。
//
// 📌 判斷規則(跟前端守門一致):
//   掃 supabase/functions/ 底下非測試的 .ts(含 _shared/),用 TypeScript 編譯器的語法樹找字串常值、
//   樣板字串片段;註解、console.* 的參數不掃(只進伺服器 log,使用者看不到)。
//   ① 中文字緊接半形 , : ; ! ?  ② 半形 , : ; ! ? 緊接中文字
//   ③ 半形 ) ] 後面接半形標點再接中文字  ④ 樣板字串中段 / 尾段開頭是「半形標點 + 空白 + 中文」
//
// 📌 放行清單(每一條寫理由;下方有一條測試專抓「死掉的放行條目」)。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const CJK = "[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]";
const HALF_WIDTH_NEXT_TO_CJK = new RegExp(`${CJK}[,:;!?]|[,:;!?]${CJK}|[)\\]][,:;!?]\\s*${CJK}`);
const TEMPLATE_FRAGMENT_LEADING_HALF_WIDTH = new RegExp(`^[,:;!?]\\s+${CJK}`);

const ALLOWLIST: { file: string; snippet: string; reason: string }[] = [
  {
    file: "supabase/functions/line-webhook/index.ts",
    snippet: "綁定成功,之後這個 LINE 帳號會收到通知",
    reason: "回覆進使用者 LINE 聊天室的訊息(LINE 文案,不是畫面錯誤訊息);第 10 批範圍外,列待決定",
  },
  {
    file: "supabase/functions/line-webhook/index.ts",
    snippet: "代碼無效或已過期,請重新產生",
    reason: "回覆進使用者 LINE 聊天室的訊息(LINE 文案,不是畫面錯誤訊息);第 10 批範圍外,列待決定",
  },
  {
    file: "supabase/functions/push-send-test/index.ts",
    snippet: "看得到這則訊息,代表通知有送到這台裝置",
    reason: "送到手機上的測試推播內文(推播文案,比照第 5 批 changeSummary.ts 推播文案不改);列待決定",
  },
  {
    file: "supabase/functions/_shared/pushDispatchCore.ts",
    snippet: "這筆預約已改派給其他服務人員,已從你的行程移除",
    reason: "送到服務人員手機上的推播內文(推播文案,比照第 5 批不改);列待決定",
  },
  {
    file: "supabase/functions/_shared/pushDispatchCore.ts",
    snippet: "負責,已從你的行程移除",
    reason: "同上一條的點名版本(推播文案);列待決定",
  },
];

function findProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    try {
      statSync(join(dir, "package.json"));
      statSync(join(dir, "supabase", "functions"));
      return dir;
    } catch {
      dir = join(dir, "..");
    }
  }
  throw new Error("找不到專案根目錄(有 package.json 和 supabase/functions 的那一層)");
}

const PROJECT_ROOT = findProjectRoot();

function listEdgeSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...listEdgeSourceFiles(full));
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function isInsideConsoleCall(node: ts.Node): boolean {
  let p: ts.Node | undefined = node.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) return true;
    p = p.parent;
  }
  return false;
}

function scanSource(file: string, source: string): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: Hit[] = [];
  const visit = (node: ts.Node) => {
    const isText =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isText) {
      const text = (node as ts.LiteralLikeNode).text;
      const isFragment = ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      const violates =
        HALF_WIDTH_NEXT_TO_CJK.test(text) ||
        (isFragment && TEMPLATE_FRAGMENT_LEADING_HALF_WIDTH.test(text));
      if (violates && !isInsideConsoleCall(node)) {
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

function scanEdgeFunctions(): Hit[] {
  const files = listEdgeSourceFiles(join(PROJECT_ROOT, "supabase", "functions"));
  return files.flatMap((full) => {
    const rel = relative(PROJECT_ROOT, full).split("\\").join("/");
    return scanSource(rel, readFileSync(full, "utf8"));
  });
}

const isAllowlisted = (h: Hit) =>
  ALLOWLIST.some((a) => a.file === h.file && h.text.includes(a.snippet));

describe("Edge Function 回傳訊息標點守門(#987 第 10 批):中文句子用全形標點", () => {
  const allHits = scanEdgeFunctions();

  it("確實有掃到 Edge Function 原始碼(不是掃了空資料夾)", () => {
    expect(listEdgeSourceFiles(join(PROJECT_ROOT, "supabase", "functions")).length).toBeGreaterThan(
      10,
    );
  });

  it("supabase/functions/ 的字串,中文旁邊不可以出現半形 , : ; ! ?", () => {
    const violations = allHits.filter((h) => !isAllowlisted(h));
    const report = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text.slice(0, 80)}`)
      .join("\n");
    expect(
      violations,
      `下面這些 Edge Function 字串的中文旁邊用了半形標點,請改成全形「，」「：」「；」「！」「？」。\n` +
        `(如果真的不該改,加進 edgeFunctionPunctuationGuard.test.ts 的 ALLOWLIST 並寫清楚理由)\n${report}`,
    ).toEqual([]);
  });

  it("白名單不可以有死項目", () => {
    const dead = ALLOWLIST.filter(
      (a) => !allHits.some((h) => h.file === a.file && h.text.includes(a.snippet)),
    );
    expect(dead.map((d) => `${d.file}「${d.snippet}」`)).toEqual([]);
  });

  describe("偵測邏輯自我檢查(故障注入)", () => {
    it("jsonResponse 的 error、errorDetail、樣板字串 ⇒ 抓到", () => {
      expect(scanSource("x.ts", 'jsonResponse({ error: "請稍後,再試" }, 500);')).toHaveLength(1);
      expect(scanSource("x.ts", 'const r = { errorDetail: "文案是空白,沒有發送" };')).toHaveLength(
        1,
      );
      expect(scanSource("x.ts", "const m = `寄送失敗:${e}`;")).toHaveLength(1);
      expect(scanSource("x.ts", "const m = `再試(${e}),請確認`;")).toHaveLength(1);
      expect(scanSource("x.ts", 'const m = "確定嗎?";')).toHaveLength(1);
    });
    it("全形、英文、註解、console ⇒ 不抓", () => {
      const ok = [
        'jsonResponse({ error: "請稍後，再試" }, 500);',
        'const a = "Method not allowed, use POST";',
        "// 註解裡的半形,沒關係\nconst b = 1;",
        'console.error("[x] 寫入失敗,略過", e);',
        'const c = "金額 NT$ 1,200，時間 10:00";',
      ];
      for (const src of ok) expect(scanSource("x.ts", src), src).toEqual([]);
    });
  });
});
