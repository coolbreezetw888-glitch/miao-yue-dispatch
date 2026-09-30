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

// ═══════════════════════════════════════════════════════════════════════════════
// 用語守門(延伸範圍):supabase/migrations/ 的 SQL
//
// 🔴 為什麼要延伸(2026-09-30,SPECS-INDEX #878)
// 上面那一段只掃 `src/` 跟 `supabase/functions/`,**掃不到資料庫函式的內容**。結果是
// `raise exception '沒有權限查詢這間商家的師傅報表'` 這句在 migration 裡活了 10 天、
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
 */
function stripSqlComments(source: string): string {
  const out: string[] = [];
  let i = 0;
  type SqlMode = "code" | "line" | "block" | "str";
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
      if (c === "'") {
        mode = "str";
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

    // 字串常值:原樣保留(這就是要檢查的內容)。SQL 用兩個連續單引號表示一個引號,
    // 這裡的處理是「離開字串 → 下一個字元立刻又進入字串」,對偵測註解起點的結果完全一樣。
    if (c === "'") mode = "code";
    out.push(c);
    i += 1;
  }

  return out.join("");
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

function findMigrationViolations(): SqlViolation[] {
  const violations: SqlViolation[] = [];
  for (const file of listMigrationFiles()) {
    const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8").split("\r\n").join("\n");
    stripSqlComments(raw)
      .split("\n")
      .forEach((line, index) => {
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

/** 例外清單的每一條都要指定理由;理由文字集中在這裡,不要同一段話抄 23 次。 */
const MIGRATION_LEGACY_REASONS = {
  supersededRaise:
    "已被後續 migration 覆蓋掉的舊版函式本體。正式庫現在跑的是 " +
    "20260930030000_req878_payroll_reports_terminology_fix.sql 的版本(已用 md5(pg_proc.prosrc) " +
    "指紋驗證),這幾處只是歷史紀錄,不會影響任何人看到的畫面。歷史 migration 一旦套用就不回頭改。",
  developerComment:
    "comment on table / comment on function 的資料庫註解,只有開發者用 psql 或 pg_get_functiondef " +
    "看得到,使用者在畫面上永遠看不到。歷史 migration 不回頭改;如果之後因為別的需求重建了那支函式," +
    "請在新 migration 裡順手把註解一起改成「服務人員」,並把這裡對應的那一行刪掉。",
} as const;

/**
 * 🔒 既有例外清單(2026-09-30 #878 當下的完整盤點,共 23 條)。
 *
 * **要往這份清單加東西之前請先停一下**:如果是 `raise exception` 這一類使用者看得到的訊息,
 * 正確做法永遠是「新開一支 migration 把字改掉」,不是加進這份清單。這份清單只是在承認
 * 「已套用的歷史檔案不可變」這個事實,不是給新的違規開後門。
 */
const MIGRATION_LEGACY_ALLOWLIST: readonly (readonly [
  string,
  keyof typeof MIGRATION_LEGACY_REASONS,
])[] = [
  // ── ① 已被後續 migration 覆蓋掉的舊版函式本體裡的 raise exception(10 條)──────
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
  // ── ② 資料庫註解(comment on …),只有開發者看得到(13 條)──────────────────────
  ["20260916100000_staff_agent_schema.sql:48", "developerComment"],
  ["20260920120100_payroll_billing_functions.sql:81", "developerComment"],
  ["20260920120400_payroll_reports.sql:208", "developerComment"],
  ["20260920120400_payroll_reports.sql:244", "developerComment"],
  ["20260921130000_staff_portal_payroll_overlay.sql:78", "developerComment"],
  ["20260921130000_staff_portal_payroll_overlay.sql:110", "developerComment"],
  ["20260922130300_req580_581_payroll_by_range_functions.sql:190", "developerComment"],
  ["20260922130300_req580_581_payroll_by_range_functions.sql:290", "developerComment"],
  ["20260924020100_merchant_staff_identity_columns_guard.sql:131", "developerComment"],
  ["20260924020200_merchants_group_id_guard.sql:73", "developerComment"],
  ["20260924020400_fix_update_booking_material_cost_snapshot.sql:243", "developerComment"],
  ["20260924030100_merchant_staff_identity_columns_insert_guard.sql:150", "developerComment"],
  ["20260925020000_staff_commission_summary_completion_time_basis.sql:293", "developerComment"],
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
});
