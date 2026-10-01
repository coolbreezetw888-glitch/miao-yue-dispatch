// 用語守門測試:全系統「使用者看得到的字」都不可以出現特定產業的稱呼。
//
// 🔴 為什麼要有這一支(2026-09-30,SPECS-INDEX #832 收尾批)
// 2026-09-24 全系統把冷氣業舊稱(FORBIDDEN_TERMS 第一個詞)改成「服務人員」之後,**已經第三次**在使用者看得到的地方抓到殘留:
//   ① ui-v1-full 第 3 批:資料匯入精靈的「歷史訂單 CSV 模板」示範列的服務人員姓名帶著舊稱。
//   ② 收尾批:行銷首頁(src/routes/index.tsx)「服務人員端」那段的手機模擬畫面,示範姓名帶著舊稱
//      —— 而且就在一句「服務人員端不用下載 App」的正下方。
//   ③(加上原本 2026-09-24 那批本身漏掉的幾處)
//
// 原本的守門測試(src/modules/platform-admin/personDisplay.test.ts)只斷言幾個**用語標籤常數**
// (STAFF_LOGIN_STATUS_LABELS / AGENT_STATUS_LABELS…),掃不到「示範資料」「CSV 模板」
// 「通知訊息範本的範例值」「行銷首頁的假畫面」這些同樣是使用者看得到的字。所以這裡改成
// **直接掃原始碼**:凡是會被編譯進畫面的字(字串常值、JSX 文字),一律不准出現那些詞。
//
// 🔴 程式碼註解要排除在外。註解裡本來就會寫歷史沿革(「2026-09-24 把舊稱改成服務人員」)、
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
 * 一律用「服務人員」。理由(skill 二之二):使用者本人做冷氣,會不自覺講冷氣業的舊稱(下面清單第一個詞),
 * 但這套系統要賣給美甲、美容、寵物美容、到府清潔各行各業 —— 美甲師看到那個舊稱會覺得這套系統不是給他用的。
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
    // 🔴 關鍵:`https://` 後面那個含禁用詞的字串常值,不可以被當成行註解一起吃掉
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

// ═══════════════════════════════════════════════════════════════════════════════
// 用語守門(延伸範圍):supabase/migrations/ 的 SQL
//
// 🔴 為什麼要延伸(2026-09-30,SPECS-INDEX #878)
// 上面那一段只掃 `src/` 跟 `supabase/functions/`,**掃不到資料庫函式的內容**。結果是
// `raise exception '沒有權限查詢這間商家的(舊稱)報表'` 這句在 migration 裡活了 10 天、
// 散在 8 個檔案裡沒有人發現 —— 而那是服務人員/客服被擋下來時,**畫面上直接跳出來的紅字**。
// 守門網有洞就等於沒有守門網,所以這一段把範圍延伸到 migration。
//
// 🔴 這裡用的分類方式跟前端不同,因為 SQL 裡「使用者看得到的字」比前端難分辨:
//   ① `raise exception '…'` 的訊息 → **使用者看得到**,零容忍。
//   ② `comment on table / function … is '…'` → 只有開發者看得到(資料庫註解),優先度低。
//   ③ `--` 行註解 / 區塊註解 → 寫歷史沿革與踩坑脈絡的地方,**本來就該允許**
//      (同前端 stripComments 的理由:把脈絡一起禁掉,規則本身就失傳了)。
// 所以下面先把 ③ 整段清成空白,再把剩下的字串常值分成「raise 訊息」與「其他」兩類。
//
// 🔴 為什麼是「既有例外清單」,而不是「整個資料夾跳過」或「只掃新檔案」
// 已經套用到正式庫的 migration **不可以回頭改檔案內容** —— 改了對正式庫毫無作用(函式早就
// 以舊版的樣子躺在 pg_proc 裡了),還會讓 repo 跟 supabase_migrations 帳本不一致。正確做法是
// 往後疊加一支新 migration 覆蓋掉(#878 就是 20260930030000_req878_…)。
// 所以歷史檔案裡的命中沒辦法「修掉」,只能列成例外。但這份例外清單是**逐行釘死**的:
//   ・歷史 migration 是不可變的 ⇒ 行號永遠不會飄 ⇒ 釘行號是安全的,而且是最嚴格的做法。
//   ・任何**沒有列在清單裡**的命中(不管在新檔案還是舊檔案)都會讓測試轉紅。
//   ・清單裡的項目失效(那一行被修掉了)也會轉紅,強迫一起把清單縮短,
//     不讓死項目長期殘留、變成將來漏網的縫隙。
// ═══════════════════════════════════════════════════════════════════════════════

const MIGRATIONS_DIR = join(PROJECT_ROOT, "supabase", "migrations");

/** `raise exception` / `raise notice` … 這一類「訊息會被丟回呼叫端」的敘述。 */
const SQL_RAISE_STATEMENT = /\braise\s+(exception|notice|warning|info|log|debug)\b/i;

/**
 * 把 SQL 的行註解與區塊註解換成等長空白(保留換行,所以行號跟原始檔完全對得上)。
 *
 * 逐字元掃描而不是用正則,理由跟上面 stripComments() 一樣:要能分辨「真的註解」跟
 * 「字串裡剛好有兩個減號」。這裡同時追蹤單引號字串狀態,所以
 * `comment on … is '路徑 a--b'` 裡的兩個減號不會被誤判成註解起點。
 *
 * 📌 刻意不處理 dollar-quoting:函式本體裡面本來就是 SQL,用同一套規則掃
 *    (本體裡的行註解該清掉、本體裡的 `'…'` 該保留)剛好就是我們要的行為。
 *
 * 🔴 字串邊界一旦判斷錯,字串裡的 `--` 會被當成註解起點,把後面**真正的違規字**一起清掉
 *    (例:`select E'\''; raise exception '-- 師傅';` 曾經漏抓)。所以(QA 2026-10-01):
 *   ・`E'…'` / `e'…'`(前一個字元不是識別字字元)是跳脫字串,`\` 連同下一個字元一起跳過;
 *     字串邊界統一交給 findSqlStringEnd(),跟 maskNonTopLevelSql() 用同一套規則。
 *   ・雙引號識別字 `"…"`(`""` 是跳脫後的雙引號)原樣保留,裡面的 `--`、`'` 都不算數。
 *   ・字串或識別字**沒閉合**(結構沒讀懂)→ 從那裡到檔尾全部原樣保留、不再清任何註解。
 *     寧可把註解裡的歷史沿革也一起掃進來(多報),也不要因為錯位清掉真正的違規字(漏抓)。
 */
function stripSqlComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type SqlMode = "code" | "line" | "block";
  let mode: SqlMode = "code";

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (mode === "code") {
      if (c === "-" && next === "-") {
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
      if (c === "'" || c === '"') {
        const end =
          c === "'"
            ? findSqlStringEnd(source, i, isSqlEscapeStringStart(source, i))
            : findSqlQuotedIdentifierEnd(source, i);
        if (end === -1) {
          out.push(source.slice(i)); // 沒閉合:剩下的原樣保留,不再清任何東西
          break;
        }
        out.push(source.slice(i, end + 1));
        i = end + 1;
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

    // mode === "block"
    if (c === "*" && next === "/") {
      mode = "code";
      out.push("  ");
      i += 2;
      continue;
    }
    out.push(c === "\n" ? "\n" : " ");
    i += 1;
  }

  return out.join("");
}

/** `quoteAt` 這個單引號是不是 `E'…'` / `e'…'` 跳脫字串的開頭(前一個字元是 E/e,再前一個不是識別字字元)。 */
function isSqlEscapeStringStart(source: string, quoteAt: number): boolean {
  const prev = source[quoteAt - 1];
  const prevPrev = source[quoteAt - 2];
  return (
    (prev === "E" || prev === "e") && !(prevPrev !== undefined && /[A-Za-z0-9_$]/.test(prevPrev))
  );
}

/** 從 `quoteAt`(雙引號的位置)往後找到識別字結尾;`""` 是跳脫後的雙引號。沒閉合回傳 -1。 */
function findSqlQuotedIdentifierEnd(source: string, quoteAt: number): number {
  let i = quoteAt + 1;
  while (i < source.length) {
    if (source[i] === '"') {
      if (source[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

function listMigrationFiles(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(MIGRATIONS_DIR);
  } catch {
    return []; // 目錄不存在時回空陣列,由下面「掃到的檔案數 > 100」那條斷言負責轉紅
  }
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

interface SqlViolation {
  /** `<檔名>:<行號>`,就是例外清單的鍵。 */
  at: string;
  term: string;
  /** "raise" = 使用者看得到的訊息;"string" = 其他字串常值(實務上幾乎都是 comment on)。 */
  kind: "raise" | "string";
  text: string;
}

/** 一個 migration 檔案:檔名 + 已經清掉 SQL 註解的內容(行號與原檔一致)。 */
interface StrippedSqlSource {
  file: string;
  stripped: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 資料庫註解(comment on … is '…')的「現役版本」判斷(2026-10-01,SPECS-INDEX #927)
//
// 🔴 為什麼需要這一段
// 資料庫註解跟函式本體不一樣:同一個物件可以被後面的 migration 再 `comment on` 一次,
// 新的那句會**直接取代**舊的;物件被 `drop` 之後,舊註解也跟著消失。
// 所以歷史 migration 檔案裡「被後面覆蓋掉的舊註解」在資料庫裡早就不存在了 ——
// 跟上面「已被覆蓋的舊版 raise」是同一個道理,但註解可以用「最後一句是誰」機械式判斷,
// 不用一條一條手動列例外。#927 用一支只有 COMMENT ON 的 migration 把現役註解全改成
// 「服務人員」之後,原本例外清單裡 13 條 developerComment 全部變成「已被覆蓋」,
// 清單因此從 23 條縮到 10 條(只剩 raise 那 10 條)。
//
// 🔴 判斷規則(偏嚴格:看不懂的寫法一律「不算被覆蓋」,寧可轉紅也不要假性通過)
//   ・同一個物件(物件種類 + 名稱 + 參數型別)只有**最後一次出現**的 comment on 算現役。
//   ・之後若出現 `drop function/table/view … <同一個物件>`,前面所有註解都算已覆蓋。
//   ・現役註解裡有禁用詞 → 照樣轉紅(而且不能加例外,直接改字)。
//   ・物件名稱比對前會正規化:沒加雙引號的部分轉小寫、去空白、沒寫 schema 的補 public.、
//     常見型別別名統一(integer/int4→int、boolean→bool…);**加了雙引號的識別字保留大小寫**
//     (Postgres 本來就這樣:"Merchant_Staff" 跟 merchant_staff 是兩個不同物件)。
//     正規化認不出來的寫法(例如參數名稱寫在簽章裡)只會讓舊註解「不被當成已覆蓋」
//     → 測試轉紅,不會漏抓。
//   ・只認 migration **頂層**的 comment on / drop:字串常值裡的、函式本體或 DO 區塊
//     ($$ … $$ / $tag$ … $tag$)裡的一律不算 —— 那些不是 migration 套用當下確定會執行的敘述
//     (QA 2026-10-01 打回的 L1~L3)。
//   ・物件只要被 `alter … rename to` / `alter … set schema` 過,它在那之前的註解會跟著
//     搬到新名字底下繼續存在 ⇒ 那之前的註解一律不算被覆蓋(QA 打回的 L5)。
// ─────────────────────────────────────────────────────────────────────────────

const SQL_COMMENT_ON =
  /\bcomment\s+on\s+(table|column|function|procedure|view|materialized\s+view|schema|type|index|sequence|trigger|policy|constraint)\s+([^;']*?)\s+is\s+(?='|null\b)/gi;
const SQL_DROP_OBJECT =
  /\bdrop\s+(function|procedure|table|view|materialized\s+view)\s+(?:if\s+exists\s+)?([^;']*?)\s*(?:\bcascade\b|\brestrict\b)?\s*;/gi;
const SQL_RENAME_OBJECT =
  /\balter\s+(function|procedure|table|view|materialized\s+view)\s+(?:if\s+exists\s+)?([^;']*?)\s+(?:rename\s+to|set\s+schema)\b[^;]*;/gi;

/**
 * 只留下 migration「頂層」的程式碼:單引號字串的**內容**換成空白(引號本身保留,
 * 讓 `is '…'` 的位置還找得到),`$$ … $$` / `$tag$ … $tag$` 整段(含分隔符號)換成空白。
 * 長度與換行完全不變,所以算出來的位置可以直接拿回原文使用。
 *
 * 🔴 `E'…'`(跳脫字串,QA 2026-10-01 第二輪打回):裡面的 `\'` 是跳脫後的引號、不是字串結尾。
 *    沒認出來的話字串邊界會整個錯位,後面字串裡的 `comment on …` 會被當成頂層敘述。
 *    所以 `E'` / `e'`(前一個字元不是識別字字元)開頭的字串,反斜線連同下一個字元一起跳過。
 *
 * 🔴 `uncertain`:只要有任何字串或 dollar-quote 沒有閉合,代表這個檔案的結構我們沒有讀懂,
 *    呼叫端就不從這個檔案產生任何覆蓋 / 刪除 / 改名事件(寧可多報,不可漏抓)。
 */
function maskNonTopLevelSql(source: string): { masked: string; uncertain: boolean } {
  const out = source.split("");
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const isIdentChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
  let uncertain = false;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"') {
      // 雙引號識別字:原樣保留(正規化物件名稱要用),但裡面的 ' 或 $ 不可以被當成字串 / dollar-quote 起點
      const end = findSqlQuotedIdentifierEnd(source, i);
      if (end === -1) {
        uncertain = true;
        break;
      }
      i = end + 1;
      continue;
    }
    if (c === "'") {
      const end = findSqlStringEnd(source, i, isSqlEscapeStringStart(source, i));
      if (end === -1) {
        uncertain = true;
        blank(i + 1, source.length);
        break;
      }
      blank(i + 1, end); // 保留頭尾兩個引號
      i = end + 1;
      continue;
    }
    if (c === "$" && !isIdentChar(source[i - 1])) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(source.slice(i, i + 64));
      if (tag) {
        const close = source.indexOf(tag[0], i + tag[0].length);
        if (close === -1) {
          uncertain = true;
          blank(i, source.length);
          break;
        }
        const end = close + tag[0].length;
        blank(i, end);
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return { masked: out.join(""), uncertain };
}

function normalizeSqlObjectKey(objectKind: string, target: string): string {
  // 依雙引號切段:偶數段是沒加引號的部分(轉小寫、統一型別別名),奇數段是加了引號的識別字(原樣保留)
  let t = target
    .split('"')
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .toLowerCase()
            .replace(/\btimestamp\s+with\s+time\s+zone\b/g, "timestamptz")
            .replace(/\bcharacter\s+varying\b/g, "varchar")
            .replace(/\bdouble\s+precision\b/g, "float8")
            .replace(/\b(integer|int4)\b/g, "int")
            .replace(/\bint8\b/g, "bigint")
            .replace(/\bboolean\b/g, "bool")
            .replace(/\s+/g, ""),
    )
    .join("");
  const parenAt = t.indexOf("(");
  const name = parenAt === -1 ? t : t.slice(0, parenAt);
  if (!name.includes(".")) t = `public.${t}`;
  return `${objectKind.toLowerCase().replace(/\s+/g, " ")}:${t}`;
}

/**
 * 從 `quoteAt`(單引號的位置)往後找到字串結尾,找不到(沒閉合)回傳 -1。
 * SQL 的 `''` 是跳脫後的單引號;`backslashEscapes`(E'…' 字串)時 `\` 連同下一個字元一起跳過。
 */
function findSqlStringEnd(source: string, quoteAt: number, backslashEscapes = false): number {
  let i = quoteAt + 1;
  while (i < source.length) {
    const ch = source[i];
    if (backslashEscapes && ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'") {
      if (source[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * 回傳每個檔案裡「已被後續 migration 覆蓋掉的舊註解」整句的字元範圍 [起, 迄](含迄)。
 * 用字元範圍而不是整行,是為了同一行如果還有別的敘述,別的敘述照樣會被掃到。
 * 檔案順序 = 陣列順序(呼叫端要先依檔名排好,跟 supabase 套用 migration 的順序一致)。
 */
function findSupersededCommentRanges(
  sources: readonly StrippedSqlSource[],
): Map<string, [number, number][]> {
  type CommentEvent = {
    kind: "comment" | "drop" | "rename";
    key: string;
    file: string;
    range: [number, number];
  };
  const events: CommentEvent[] = [];

  for (const { file, stripped } of sources) {
    const found: { at: number; event: CommentEvent }[] = [];
    // 事件只從「頂層」找(字串內容、$$ 本體都已遮掉);註解的字元範圍則回原文 stripped 算
    const { masked: topLevel, uncertain } = maskNonTopLevelSql(stripped);
    // 結構沒讀懂的檔案:不產生任何覆蓋/刪除/改名事件(它前面的舊註解都不算被覆蓋,
    // 它自己的註解也照常被掃)—— 寧可多報。
    if (uncertain) continue;

    for (const m of topLevel.matchAll(SQL_COMMENT_ON)) {
      const start = m.index ?? 0;
      const valueAt = start + m[0].length;
      const end = stripped[valueAt] === "'" ? findSqlStringEnd(stripped, valueAt) : valueAt;
      if (end === -1) continue; // 理論上不會發生(上面 uncertain 已攔下),保險起見不當成事件
      found.push({
        at: start,
        event: {
          kind: "comment",
          key: normalizeSqlObjectKey(m[1]!, m[2]!),
          file,
          range: [start, end],
        },
      });
    }

    for (const [regex, kind] of [
      [SQL_DROP_OBJECT, "drop"],
      [SQL_RENAME_OBJECT, "rename"],
    ] as const) {
      for (const m of topLevel.matchAll(regex)) {
        const at = m.index ?? 0;
        found.push({
          at,
          event: { kind, key: normalizeSqlObjectKey(m[1]!, m[2]!), file, range: [at, at] },
        });
      }
    }

    found.sort((a, b) => a.at - b.at).forEach(({ event }) => events.push(event));
  }

  // drop function 會讓同名 comment on function 失效;drop table/view 同理 → 用「種類:名稱」配對。
  // comment on 的種類跟 drop 的種類用同一套字(function / table / view …),直接共用 key。
  const lastIndexByKey = new Map<string, number>();
  const lastRenameIndexByKey = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.kind === "rename") lastRenameIndexByKey.set(event.key, index);
    else lastIndexByKey.set(event.key, index);
  });

  const superseded = new Map<string, [number, number][]>();
  events.forEach((event, index) => {
    if (event.kind !== "comment") return;
    if (lastIndexByKey.get(event.key) === index) return; // 現役版本
    // 這句註解之後物件被改名/搬 schema 過 → 註解跟著物件走了,不能當成被覆蓋
    if ((lastRenameIndexByKey.get(event.key) ?? -1) > index) return;
    const list = superseded.get(event.file) ?? [];
    list.push(event.range);
    superseded.set(event.file, list);
  });
  return superseded;
}

/** 把指定字元範圍換成空白(保留換行,行號不變)。 */
function blankRanges(source: string, ranges: readonly [number, number][]): string {
  if (ranges.length === 0) return source;
  const chars = source.split("");
  for (const [start, end] of ranges) {
    for (let i = start; i <= end && i < chars.length; i += 1) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }
  return chars.join("");
}

function findViolationsInSources(sources: readonly StrippedSqlSource[]): SqlViolation[] {
  const superseded = findSupersededCommentRanges(sources);
  const violations: SqlViolation[] = [];
  for (const { file, stripped } of sources) {
    // 已被後續 comment on / drop 覆蓋的舊註解整句清成空白 —— 資料庫裡已經不存在了
    const live = blankRanges(stripped, superseded.get(file) ?? []);
    live.split("\n").forEach((line, index) => {
      for (const term of FORBIDDEN_TERMS) {
        if (!line.includes(term)) continue;
        violations.push({
          at: `${file}:${index + 1}`,
          term,
          kind: SQL_RAISE_STATEMENT.test(line) ? "raise" : "string",
          text: line.trim().slice(0, 120),
        });
      }
    });
  }
  return violations;
}

function loadStrippedMigrations(): StrippedSqlSource[] {
  return listMigrationFiles().map((file) => ({
    file,
    stripped: stripSqlComments(
      readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("\r\n").join("\n"),
    ),
  }));
}

function findMigrationViolations(): SqlViolation[] {
  return findViolationsInSources(loadStrippedMigrations());
}

/** 例外清單的每一條都要指定理由;理由文字集中在這裡,不要同一段話抄 10 次。 */
const MIGRATION_LEGACY_REASONS = {
  supersededRaise:
    "已被後續 migration 覆蓋掉的舊版函式本體。正式庫現在跑的是 " +
    "20260930030000_req878_payroll_reports_terminology_fix.sql 的版本(已用 md5(pg_proc.prosrc) " +
    "指紋驗證),這幾處只是歷史紀錄,不會影響任何人看到的畫面。歷史 migration 一旦套用就不回頭改。",
} as const;

/**
 * 🔒 既有例外清單(#878 當下盤點 23 條;2026-10-01 #927 縮成 10 條)。
 *
 * 📌 #927 之前這裡還有 13 條 `developerComment`(comment on 的資料庫註解)。#927 用一支只有
 *    COMMENT ON 的 migration(20261001130000_req927_…)把正式庫現役的註解全改掉,
 *    再加上 findSupersededCommentRanges() 能自動認出「已被後續 comment on / drop 覆蓋的舊註解」,
 *    那 13 條就不需要再手動列了,`developerComment` 這個理由代碼也一併移除 ——
 *    **之後資料庫註解出現禁用詞,一律新開 migration 用 COMMENT ON 改字,沒有例外可加。**
 *
 * **要往這份清單加東西之前請先停一下**:如果是 `raise exception` 這一類使用者看得到的訊息,
 * 正確做法永遠是「新開一支 migration 把字改掉」,不是加進這份清單。這份清單只是在承認
 * 「已套用的歷史檔案不可變」這個事實,不是給新的違規開後門。
 */
const MIGRATION_LEGACY_ALLOWLIST: readonly (readonly [
  string,
  keyof typeof MIGRATION_LEGACY_REASONS,
])[] = [
  // ── 已被後續 migration 覆蓋掉的舊版函式本體裡的 raise exception(10 條)──────────
  ["20260920120400_payroll_reports.sql:166", "supersededRaise"],
  ["20260920120400_payroll_reports.sql:237", "supersededRaise"],
  ["20260921130000_staff_portal_payroll_overlay.sql:36", "supersededRaise"],
  ["20260921130000_staff_portal_payroll_overlay.sql:103", "supersededRaise"],
  ["20260922111100_req2_get_staff_commission_summary_item_breakdown.sql:26", "supersededRaise"],
  ["20260922120200_get_staff_commission_summary_total_amount.sql:40", "supersededRaise"],
  ["20260922130300_req580_581_payroll_by_range_functions.sql:183", "supersededRaise"],
  ["20260922130300_req580_581_payroll_by_range_functions.sql:227", "supersededRaise"],
  ["20260925020000_staff_commission_summary_completion_time_basis.sql:116", "supersededRaise"],
  ["20260925020000_staff_commission_summary_completion_time_basis.sql:224", "supersededRaise"],
];

const MIGRATION_ALLOWED_AT = new Set(MIGRATION_LEGACY_ALLOWLIST.map(([at]) => at));

describe("用語守門:supabase/migrations 的 SQL(#878 延伸)", () => {
  it("掃描範圍有抓到 migration 檔案(防止掃描機制壞掉造成假性通過)", () => {
    const files = listMigrationFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("20260930030000_req878_payroll_reports_terminology_fix.sql");
  });

  it("SQL 註解會被排除、字串常值會被保留", () => {
    const sample = [
      "-- 2026-09-24 把師傅改成服務人員(歷史沿革,不算違規)",
      "/* 區塊註解裡的師傅也一樣不算 */",
      "comment on function f() is '路徑 a--b 後面的字要留著,店長要抓到';",
      "    raise exception '沒有權限查詢這間商家的師傅報表' using errcode = '42501';",
    ].join("\n");
    const lines = stripSqlComments(sample).split("\n");
    // 前兩行整段被清成空白
    expect(lines[0]!.trim()).toBe("");
    expect(lines[1]!.trim()).toBe("");
    // 🔴 關鍵:字串常值裡的兩個減號不可以被當成行註解,把後面的違規字一起吃掉
    expect(lines[2]).toContain("店長");
    // raise 那一行原樣保留,而且會被分類成 "raise"
    expect(lines[3]).toContain("師傅");
    expect(SQL_RAISE_STATEMENT.test(lines[3]!)).toBe(true);
    // 反向:comment on 那一行不會被誤判成 raise
    expect(SQL_RAISE_STATEMENT.test(lines[2]!)).toBe(false);
  });

  it("raise exception 等使用者看得到的訊息:清單之外一律不接受", () => {
    const offenders = findMigrationViolations().filter(
      (v) => v.kind === "raise" && !MIGRATION_ALLOWED_AT.has(v.at),
    );
    const message = offenders.map((v) => `  ${v.at} 出現「${v.term}」→ ${v.text}`).join("\n");
    expect(
      offenders,
      `以下 raise 訊息會原封不動出現在使用者畫面上,一律改成「服務人員」:\n${message}\n` +
        "🔴 不要把它加進 MIGRATION_LEGACY_ALLOWLIST —— 那份清單只給「已套用、不可回頭改」的歷史檔案用," +
        "你正在寫的新 migration 直接把字改掉就好。",
    ).toEqual([]);
  });

  it("所有 migration 的違規位置必須完全落在既有例外清單內", () => {
    const offenders = findMigrationViolations().filter((v) => !MIGRATION_ALLOWED_AT.has(v.at));
    const message = offenders
      .map((v) => `  [${v.kind}] ${v.at} 出現「${v.term}」→ ${v.text}`)
      .join("\n");
    expect(
      offenders,
      `supabase/migrations 出現了新的特定產業稱呼,一律改成「服務人員」:\n${message}\n` +
        "如果那句話是在寫歷史沿革,把它放進 `--` 註解(註解不在掃描範圍內);" +
        "如果是 comment on 的資料庫註解,直接把字改掉,不要加例外。",
    ).toEqual([]);
  });

  it("既有例外清單裡沒有失效的項目(修掉了就要從清單移除)", () => {
    const actual = new Set(findMigrationViolations().map((v) => v.at));
    const stale = MIGRATION_LEGACY_ALLOWLIST.map(([at]) => at).filter((at) => !actual.has(at));
    expect(
      stale,
      "這些位置已經沒有違規用語了,請把它們從 MIGRATION_LEGACY_ALLOWLIST 刪掉。\n" +
        "留著死項目的話,哪天剛好有新的違規落在同一個檔名+行號上,就會被這份清單放過去:\n" +
        stale.map((at) => `  ${at}`).join("\n"),
    ).toEqual([]);
  });

  it("每一條例外都指定了有效的理由,而且沒有重複項目", () => {
    for (const [at, reason] of MIGRATION_LEGACY_ALLOWLIST) {
      expect(MIGRATION_LEGACY_REASONS[reason], `${at} 的理由代碼無效`).toBeTruthy();
    }
    expect(MIGRATION_LEGACY_ALLOWLIST.length).toBe(MIGRATION_ALLOWED_AT.size);
  });

  // ── #927:資料庫註解只看「現役版本」──────────────────────────────────────────────
  const src = (file: string, ...lines: string[]): StrippedSqlSource => ({
    file,
    stripped: stripSqlComments(lines.join("\n")),
  });

  it("資料庫註解(comment on):現役版本零容忍,不接受任何例外", () => {
    const offenders = findMigrationViolations().filter((v) => v.kind === "string");
    expect(
      offenders,
      "資料庫註解的現役版本出現特定產業稱呼。新開一支 migration 用 `comment on … is '…'` 把字改掉" +
        "(不用重建函式),不要加例外:\n" +
        offenders.map((v) => `  ${v.at} 出現「${v.term}」→ ${v.text}`).join("\n"),
    ).toEqual([]);
  });

  it("被後面 comment on 覆蓋的舊註解不算違規;型別別名、大小寫、空白、schema 省略都要認得是同一個物件", () => {
    const violations = findViolationsInSources([
      src(
        "001.sql",
        "comment on function public.f(uuid, integer, boolean) is '舊版:師傅報表';",
        "comment on table merchant_staff is '舊版:店長';",
      ),
      src(
        "002.sql",
        "COMMENT ON FUNCTION f(uuid,int,bool) IS '新版:服務人員報表';",
        "comment on table public.merchant_staff is '新版:商家管理員';",
      ),
    ]);
    expect(violations).toEqual([]);
  });

  it("drop 之後舊註解跟著消失,不算違規", () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on function public.g(uuid) is '師傅';"),
      src("002.sql", "drop function if exists public.g(uuid);"),
    ]);
    expect(violations).toEqual([]);
  });

  it("故障注入:最後一版註解含禁用詞 → 抓得到(不管前面有沒有乾淨的版本)", () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on function public.f(uuid) is '服務人員';"),
      src("002.sql", "comment on function public.f(uuid) is '改回師傅';"),
      src("003.sql", "comment on function public.h(uuid) is '店長';"),
    ]);
    expect(violations.map((v) => `${v.at}:${v.term}`)).toEqual([
      "002.sql:1:師傅",
      "003.sql:1:店長",
    ]);
  });

  it("多行 comment on(update_booking 那種長簽章):舊版整句都算被覆蓋;現役版中間行的禁用詞照抓", () => {
    const violations = findViolationsInSources([
      src(
        "001.sql",
        "comment on function public.k(",
        "  uuid, integer",
        ") is '舊版第一行",
        "舊版第二行寫到師傅';",
      ),
      src(
        "002.sql",
        "comment on function public.k(uuid, int) is '新版第一行",
        "新版第二行寫到店長';",
      ),
    ]);
    expect(violations.map((v) => `${v.at}:${v.term}`)).toEqual(["002.sql:2:店長"]);
  });

  it("簽章不同(不同 overload)不算覆蓋 → 舊的照樣抓", () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on function public.f(uuid) is '師傅';"),
      src("002.sql", "comment on function public.f(uuid, text) is '服務人員';"),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });

  it("同一行如果還有別的敘述,只清掉被覆蓋的那一句,別的敘述照樣掃", () => {
    const violations = findViolationsInSources([
      src(
        "001.sql",
        "comment on function public.f(uuid) is '師傅'; comment on function public.z() is '店長';",
      ),
      src("002.sql", "comment on function public.f(uuid) is '服務人員';"),
    ]);
    expect(violations.map((v) => `${v.at}:${v.term}`)).toEqual(["001.sql:1:店長"]);
  });
  // ── QA 打回(2026-10-01):以下 5 種「看起來像覆蓋、其實沒有」的寫法,舊註解都要照抓 ──────
  const INJECTED = "comment on table public.merchant_staff is '師傅注入';";

  it("L1:寫在字串常值裡的 comment on 不算覆蓋", () => {
    const violations = findViolationsInSources([
      src("001.sql", INJECTED),
      src("002.sql", "select 'comment on table public.merchant_staff is ''ok''';"),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });

  it("L2:寫在函式本體($$ … $$)裡的 comment on 不算覆蓋(那是呼叫時才執行,不是 migration 當下)", () => {
    const violations = findViolationsInSources([
      src("001.sql", INJECTED),
      src(
        "002.sql",
        "create function public.qa_x() returns void language plpgsql as $$",
        "begin comment on table public.merchant_staff is 'ok'; end $$;",
      ),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });

  it("L3:DO 區塊($tag$ … $tag$)裡的 drop 不算覆蓋(可能根本沒執行)", () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on function private.can_view_staff_report(uuid) is '師傅注入';"),
      src(
        "002.sql",
        "do $body$ begin if false then drop function private.can_view_staff_report(uuid); end if; end $body$;",
      ),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });

  it('L4:帶雙引號的識別字保留大小寫,"Merchant_Staff" 跟 merchant_staff 是不同物件', () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on table public.\"Merchant_Staff\" is '師傅注入';"),
      src("002.sql", "comment on table public.merchant_staff is 'ok';"),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
    // 反向:不分大小寫的未加引號寫法、或加了引號但全小寫,都要認得是同一個物件
    expect(
      findViolationsInSources([
        src("001.sql", "comment on table public.\"merchant_staff\" is '師傅';"),
        src("002.sql", "comment on table PUBLIC.Merchant_Staff is 'ok';"),
      ]),
    ).toEqual([]);
  });

  it("L5:物件被 alter … rename 過,先前的註解跟著新名字還活著 → 一律不算被覆蓋", () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on function private.qa_f(uuid) is '師傅注入';"),
      src("002.sql", "alter function private.qa_f(uuid) rename to qa_g;"),
      src("003.sql", "comment on function private.qa_f(uuid) is 'ok';"),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });
  // ── QA 第二輪打回(2026-10-01):E'…' 跳脫字串 + 結構沒讀懂時走保守 ─────────────────────
  it("E 字串:QA 重現案例 —— E 字串裡出現反斜線跳脫的引號之後,字串裡的 comment on 不可以被當成頂層覆蓋", () => {
    const violations = findViolationsInSources([
      src("001.sql", INJECTED),
      src(
        "002.sql",
        String.raw`select E'a\'b'; select 'comment on table public.merchant_staff is ''ok''';`,
      ),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });

  it("E 字串:正常情況下,E 字串後面真正頂層的 comment on 照樣算覆蓋(小寫 e 也認得)", () => {
    for (const prefix of ["E", "e"]) {
      const violations = findViolationsInSources([
        src("001.sql", INJECTED),
        src(
          "002.sql",
          String.raw`select ${prefix}'it\'s \\ fine'; comment on table public.merchant_staff is 'ok';`,
        ),
      ]);
      expect(violations, `${prefix}'…'`).toEqual([]);
    }
  });

  it("E 字串:識別字結尾剛好是 e 的普通字串(例如 type'…')不可以被當成 E 字串", () => {
    // `type'a\'` 是普通字串 'a\'(反斜線不跳脫),後面那句頂層 comment on 要照常算覆蓋
    const violations = findViolationsInSources([
      src("001.sql", INJECTED),
      src("002.sql", String.raw`select type'a\'; comment on table public.merchant_staff is 'ok';`),
    ]);
    expect(violations).toEqual([]);
  });

  it("結構沒讀懂(字串沒閉合)→ 整個檔案不產生任何覆蓋事件,前面的舊註解照抓", () => {
    const violations = findViolationsInSources([
      src("001.sql", INJECTED),
      src("002.sql", "comment on table public.merchant_staff is 'ok'; select 'oops;"),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1"]);
  });

  it("結構沒讀懂(dollar-quote 沒閉合)→ 同樣走保守,連 drop 也不算", () => {
    const violations = findViolationsInSources([
      src("001.sql", "comment on function private.qa_f(uuid) is '師傅注入';", INJECTED),
      src(
        "002.sql",
        "drop function private.qa_f(uuid); comment on table public.merchant_staff is 'ok';",
        "do $x$ begin perform 1;",
      ),
    ]);
    expect(violations.map((v) => v.at)).toEqual(["001.sql:1", "001.sql:2"]);
  });
  // ── QA 第三輪(2026-10-01):stripSqlComments() 的字串邊界也要套同一套規則 ──────────────
  it("清註解:E 字串裡跳脫的引號不可以讓後面字串裡的 -- 被當成註解,把違規字清掉", () => {
    const violations = findViolationsInSources([
      src("001.sql", String.raw`select E'\''; raise exception '-- 師傅';`),
    ]);
    expect(violations.map((v) => `${v.at}:${v.kind}`)).toEqual(["001.sql:1:raise"]);
  });

  it("清註解:雙引號識別字裡的 -- 或 ' 都不算數,後面的違規字照抓", () => {
    const violations = findViolationsInSources([
      src("001.sql", `select "x--y", '師傅';`),
      src("002.sql", `select "it's", '-- ok'; raise exception '店長';`),
    ]);
    expect(violations.map((v) => `${v.at}:${v.term}`)).toEqual([
      "001.sql:1:師傅",
      "002.sql:1:店長",
    ]);
  });

  it("清註解:字串沒閉合 → 從那裡到檔尾原樣保留(連註解也不清),寧可多報", () => {
    const stripped = stripSqlComments(["select 'oops;", "-- 師傅(本來是註解)"].join("\n"));
    expect(stripped).toContain("師傅");
    const identifier = stripSqlComments(['select "oops;', "-- 店長(本來是註解)"].join("\n"));
    expect(identifier).toContain("店長");
  });

  it("清註解:正常的 E 字串與註解照常處理(不可以因為新規則把該清的註解留下來)", () => {
    const stripped = stripSqlComments(
      [
        String.raw`select E'a\'b -- 字串裡', 1; -- 這是註解:師傅`,
        "select 2; /* 區塊註解:店長 */",
      ].join("\n"),
    );
    const lines = stripped.split("\n");
    expect(lines[0]).toContain("-- 字串裡");
    expect(lines[0]).not.toContain("師傅");
    expect(lines[1]).not.toContain("店長");
  });
});
