// 標點守門測試(SPECS-INDEX #975,第 5 批):畫面上的中文句子,逗號、冒號一律用全形「，」「：」。
//
// 🔴 為什麼要有這一支
// 使用者 2026-10-02、2026-10-06 兩次提醒:中文句子裡夾半形「,」「:」看起來像沒排版好。
// 第 5 批一次把前端 106 個檔案改成全形,但之後新寫的畫面文字很容易又順手打成半形 ——
// 沒有守門的話,同樣的問題會一批一批慢慢長回來。
//
// 📌 判斷規則(跟規格書 `.project/specs/全站標點全形化-第5批.md` 第一節一致):
//   「中文字緊接半形 , 或 :」或「半形 , 或 : 緊接中文字」⇒ 違規。
//   - 只看「會被編譯進畫面的字」:字串常值、樣板字串的文字片段、JSX 文字。
//     程式註解不掃(註解是給工程師看的脈絡,不是畫面文字)。
//   - 用 TypeScript 編譯器自己的語法樹找字串,不用正則硬切:正則分不出「字串裡的 //」跟註解,
//     也分不出 JSX 文字跟屬性名稱。
//   - 「中文字」包含 CJK 標點與全形字元(例如「」、）),所以「」,」這種也會被抓到。
//   - 金額千分位(NT$ 2,200)、時間(10:00)、比例(100:10)前後都是數字,本來就不會被抓到,
//     不需要另外放行。
//
// 📌 不掃的範圍:
//   - 測試檔(*.test.ts/tsx):裡面很多是資料庫 / Edge Function 原樣回傳的訊息(那些不歸前端改)。
//   - console.* 的參數:開發者主控台訊息,不是畫面文字。
//   - 下方 ALLOWLIST 列出的幾處(每一條都寫了理由)。白名單越短越好,新增前先想清楚是不是真的不該改。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/** 中文字(含 CJK 標點、全形字元)。 */
const CJK = "[\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef]";
/**
 * 違規的三種樣子:
 *   ① 中文字緊接半形 , :          例:「請稍後,再試」
 *   ② 半形 , : 緊接中文字          例:「」,下一句」
 *   ③ 半形 ) ] 後面緊接半形 , :,再往後(可隔空白或換行)是中文字
 *      例:「(客人消費、生日都不發),\n 建單表單…」—— 括號是半形(這批刻意不改),
 *      所以 ①② 都抓不到它,QA 第 5 批複驗時就在兩處漏網(MemberPointsPage、MembersListPage)。
 */
// #986 第 9 批(9-13,使用者裁決 5):字元集從 , : 擴成 , : ; ! ?(括號、斜線維持半形,裁決 6)。
const HALF_WIDTH_NEXT_TO_CJK = new RegExp(`${CJK}[,:;!?]|[,:;!?]${CJK}|[)\\]][,:;!?]\\s*${CJK}`);
/**
 * #986 第 9 批(9-13、9-15):④ 樣板字串「${...} 後面那一段」開頭就是半形標點 + 空白 + 中文。
 *   例:`${head}: 數量 × ${points}點` —— 冒號左邊是 ${head}(不是中文字)、右邊隔了一個空白,①②③ 都抓不到,
 *   紅利公式預覽就是這樣漏網的。只套用在樣板字串的中段 / 尾段(TemplateMiddle / TemplateTail)。
 */
const TEMPLATE_FRAGMENT_LEADING_HALF_WIDTH = new RegExp(`^[,:;!?]\\s+${CJK}`);

/**
 * 整個資料夾先不掃。
 * #986 第 9 批(使用者裁決 4):超級管理員頁也要改全形 ⇒ 原本那一條(src/modules/platform-admin/)刪掉,
 * 目前是空陣列;結構留著,真的有整個資料夾不該掃的情況再加(每一條都要寫理由)。
 */
const ALLOWLIST_DIRS: { dir: string; reason: string }[] = [];

/**
 * 個別放行的字串:用「檔案 + 字串裡的一小段原文」定位(不用行號,改了上下文也不會失效)。
 * 每一條都必須真的還對得到(下面有一條測試專抓「死掉的白名單」)。
 */
const ALLOWLIST: { file: string; snippet: string; reason: string }[] = [
  {
    file: "src/modules/members/types.ts",
    snippet: "點紅利,祝您有美好的一天",
    reason:
      "生日 LINE 文案的資料庫預設值,逐字照 migration 20261001020000;LINE 預設文案這批不改(規格書第二節第 4 點)",
  },
  {
    file: "src/modules/push-notifications/changeSummary.ts",
    snippet: "您的預約內容已更新,請至系統查看最新內容",
    reason: "手機推播內文(送到服務人員手機上的通知),推播文案這批不改(規格書第二節第 4 點)",
  },
  {
    file: "src/modules/booking/bookingDragMove.ts",
    snippet: "的回傳缺少 assistant_staff_id,無法建立復原輸入",
    reason: "內部防呆錯誤訊息,內容是程式欄位名稱(英文代碼混中文),列進待確認清單",
  },
];

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

const PROJECT_ROOT = findProjectRoot();

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

export interface PunctuationHit {
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

/** 掃一段原始碼,回傳所有「中文旁邊有半形 , :」的畫面文字。 */
function scanSource(file: string, source: string): PunctuationHit[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: PunctuationHit[] = [];
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
      const isTemplateFragment = ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
      const violates =
        HALF_WIDTH_NEXT_TO_CJK.test(text) ||
        (isTemplateFragment && TEMPLATE_FRAGMENT_LEADING_HALF_WIDTH.test(text));
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

function isAllowlisted(hit: PunctuationHit): boolean {
  if (ALLOWLIST_DIRS.some((d) => hit.file.startsWith(d.dir))) return true;
  return ALLOWLIST.some((a) => a.file === hit.file && hit.text.includes(a.snippet));
}

function scanProject(): PunctuationHit[] {
  const files = listSourceFiles(join(PROJECT_ROOT, "src"));
  return files.flatMap((full) => {
    const rel = relative(PROJECT_ROOT, full).split("\\").join("/");
    return scanSource(rel, readFileSync(full, "utf8"));
  });
}

describe("畫面文字標點守門(#975):中文句子用全形「，」「：」", () => {
  const allHits = scanProject();

  it("src/ 底下的畫面文字,中文旁邊不可以出現半形逗號、冒號", () => {
    const violations = allHits.filter((h) => !isAllowlisted(h));
    const report = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text.slice(0, 80)}`)
      .join("\n");
    expect(
      violations,
      `下面這些畫面文字的中文旁邊用了半形「,」或「:」,請改成全形「，」「：」。\n` +
        `(金額千分位、時間這種前後是數字的不會被抓;如果真的不該改,加進 punctuationGuard.test.ts 的 ALLOWLIST 並寫清楚理由)\n${report}`,
    ).toEqual([]);
  });

  it("白名單不可以有死項目(對不到任何字串的放行條目要刪掉)", () => {
    const dead = ALLOWLIST.filter(
      (a) => !allHits.some((h) => h.file === a.file && h.text.includes(a.snippet)),
    );
    expect(
      dead.map((d) => `${d.file}「${d.snippet}」`),
      "這些白名單條目已經對不到任何字串了(可能已經改成全形,或文字改了),請從 ALLOWLIST 刪掉",
    ).toEqual([]);
  });

  describe("偵測邏輯自我檢查(故障注入:確認守門真的會擋)", () => {
    it("中文後面接半形逗號 ⇒ 抓到", () => {
      expect(scanSource("x.ts", 'const a = "請稍後,再試一次";')).toHaveLength(1);
    });
    it("半形冒號後面接中文 ⇒ 抓到(含 JSX 文字與樣板字串)", () => {
      expect(scanSource("x.tsx", "const a = <p>原因:{reason}</p>;")).toHaveLength(1);
      expect(scanSource("x.ts", "const a = `會員:${name}`;")).toHaveLength(1);
      expect(scanSource("x.ts", 'const a = "」,下一句";')).toHaveLength(1);
    });
    it("半形 ) ] 後面接半形 , : 再接中文(可隔空白、換行)⇒ 抓到", () => {
      expect(scanSource("x.ts", 'const a = "(選填),請填寫";')).toHaveLength(1);
      expect(scanSource("x.ts", 'const a = "[附註]: 說明";')).toHaveLength(1);
      expect(
        scanSource("x.tsx", "const a = <p>(生日都不發),\n          建單表單也不顯示</p>;"),
      ).toHaveLength(1);
    });
    it("半形 ) ] 後面接 , : 但後面不是中文 ⇒ 不抓(英文、數字、程式樣子)", () => {
      const ok = [
        'const a = "f(a), g(b)";',
        'const b = "(NT$ 1,200), 2026-10-06";',
        'const c = "arr[0]: value";',
        'const d = "說明(選填)，請填寫";',
      ];
      for (const src of ok) expect(scanSource("x.tsx", src), src).toEqual([]);
    });
    // #986 第 9 批(9-13):擴充到 ; ! ?,以及樣板字串片段開頭的半形標點。
    it("中文旁邊的半形 ; ! ? ⇒ 抓到", () => {
      expect(scanSource("x.ts", 'const a = "請稍後再試?";')).toHaveLength(1);
      expect(scanSource("x.tsx", "const a = <p>要移除嗎?</p>;")).toHaveLength(1);
      expect(scanSource("x.ts", 'const a = "歡迎加入!";')).toHaveLength(1);
      expect(scanSource("x.ts", 'const a = "可能是網路斷了;現在先不顯示";')).toHaveLength(1);
      expect(scanSource("x.ts", 'const a = "(例如 0912345678);市話";')).toHaveLength(1);
    });
    it("樣板字串片段開頭是半形標點 + 空白 + 中文 ⇒ 抓到(紅利公式預覽那種漏網寫法)", () => {
      expect(scanSource("x.ts", "const a = `${head}: 數量 × ${points}點`;")).toHaveLength(1);
      expect(scanSource("x.ts", "const a = `${a}; 下一句`;")).toHaveLength(1);
      // 對照:全形冒號、或片段開頭不是標點 ⇒ 不抓
      expect(scanSource("x.ts", "const a = `${head}：數量 × ${points}點`;")).toEqual([]);
      expect(scanSource("x.ts", "const a = `${a} 點`;")).toEqual([]);
    });
    it("程式碼的 ? :、英文的 ! ?、括號裡的電話分機 ⇒ 不抓", () => {
      const ok = [
        'const a = flag ? "是" : "否";',
        'const b = "Hello! Are you there?";',
        'const c = "(例如 02-1234-5678#123)";',
        'const d = "/app/calendar?date=2026-10-07";',
        'const e = "確定要移除嗎？";',
      ];
      for (const src of ok) expect(scanSource("x.tsx", src), src).toEqual([]);
    });
    it("全形標點、金額千分位、時間、比例、純英文、註解 ⇒ 不抓", () => {
      const ok = [
        'const a = "請稍後，再試一次：好";',
        'const b = "NT$ 2,200 元";',
        'const c = "每天 00:05 自動發放，09:10 發送";',
        'const d = "範例：100:10 代表 100 點";',
        'const e = "Hello, world: ok";',
        "// 註解裡的半形,不管:沒關係\nconst f = 1;",
        'console.warn("主控台訊息,不是畫面文字");',
      ];
      for (const src of ok) expect(scanSource("x.tsx", src), src).toEqual([]);
    });
  });
});
