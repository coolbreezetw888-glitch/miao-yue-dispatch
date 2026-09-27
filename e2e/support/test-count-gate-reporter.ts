// #804(SPECS-INDEX):Playwright 自訂 reporter——「執行條數守門」。
// 掛在 playwright.config.ts 的 reporter 清單裡(跟 list reporter 並列),每次 e2e 跑完最後多印一段核對:
//
//   [e2e 條數守門] 收錄 114 條/21 檔(基準 114 條/21 檔 ✓)| 實際執行 114 | 通過 110 | 失敗 0 | 跳過 4 | 沒跑到 0 ✓
//
// 並在下列情況把整次 run 的結果**改判成 failed**(exit code 1),不讓它安靜通過:
//   A. 有測試「沒有跑到」(did not run)——worker 當掉、serial 連坐(#804 的主要目標)
//   B. 整套跑(沒有指定檔案/--grep/--shard)時,收錄條數 ≠ e2e/test-count-baseline.json 的基準
//      (少了 = 測試靜默消失,#714 家族;多了 = 新增測試忘了更新基準)
//
// 也支援 `npx playwright test --list` 模式:只做 B 的核對,不會啟動瀏覽器、不會建立任何測試資料
// (scripts/e2e-test-count.mjs 就是靠這個做 `npm run test:e2e:count` / `:update`)。
//
// 判定邏輯全部在 ./test-count-gate.ts(純函式,有 Vitest 測試),這個檔案只負責接 Playwright 的事件、
// 讀寫基準檔、判斷「這次是不是整套跑」。
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig, FullResult, Reporter, Suite, TestCase } from "@playwright/test/reporter";

import {
  compareWithBaseline,
  describeUnexecuted,
  summarizeRun,
  type TestCountBaseline,
} from "./test-count-gate";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 基準檔位置:e2e/test-count-baseline.json(跟 spec 放同一層,新增測試的人一定看得到它)。 */
export const BASELINE_PATH = resolve(__dirname, "../test-count-baseline.json");
const BASELINE_LABEL = "e2e/test-count-baseline.json";

/** 設成任意非空字串,reporter 會把這次收錄到的數字**寫回**基準檔(只給 scripts/e2e-test-count.mjs update 用)。 */
export const UPDATE_BASELINE_ENV = "E2E_TEST_COUNT_UPDATE_BASELINE";

/**
 * 跟 playwright.config.ts 的 `testMatch: "**\/*.spec.ts"` 對齊——用來數「磁碟上總共有幾個 spec 檔」,
 * 判斷這次 run 是整套跑還是只跑了幾支。⚠️ 改 testMatch 時這裡要一起改。
 */
const SPEC_FILE_PATTERN = /\.spec\.ts$/;

const TAG = "[e2e 條數守門]";

function readBaseline(): TestCountBaseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Partial<TestCountBaseline>;
  if (typeof parsed.tests !== "number" || typeof parsed.files !== "number") {
    throw new Error(`${BASELINE_LABEL} 格式不對:需要數字欄位 tests 與 files。`);
  }
  return parsed as TestCountBaseline;
}

function writeBaseline(next: { tests: number; files: number }): void {
  const previous = readBaseline();
  const content: TestCountBaseline = {
    comment:
      previous?.comment ??
      "Playwright e2e「應該有幾條測試」的基準值(#804)。由 npm run test:e2e:count:update 自動產生,不要手改。" +
        "npm run test:e2e 開跑前與跑完後都會拿實際數字對照這裡:數字變少 = 測試靜默消失(#714/#804),要查;" +
        "新增測試後數字變多 = 重跑 update 更新即可。",
    updatedAt: localDateKey(new Date()),
    tests: next.tests,
    files: next.files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(content, null, 2)}\n`, "utf-8");
}

/** 本機時區的 YYYY-MM-DD(不用 toISOString:那是 UTC,台灣凌晨跑會寫成前一天)。 */
function localDateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 列出 testDir 底下所有 spec 檔的絕對路徑(遞迴)。 */
function listSpecFilesOnDisk(testDir: string): string[] {
  if (!existsSync(testDir)) return [];
  return readdirSync(testDir, { recursive: true, encoding: "utf-8" })
    .filter((rel) => SPEC_FILE_PATTERN.test(rel))
    .map((rel) => resolve(testDir, rel));
}

function normalizePath(p: string): string {
  // Windows 路徑大小寫不敏感、分隔符號可能混用,統一之後再比對。
  return resolve(p).replace(/\\/g, "/").toLowerCase();
}

/**
 * 回傳 null 代表「這次是整套跑」,基準核對才有意義;否則回傳一句原因(部分執行時只印出來,不核對基準)。
 * 只跑一支 spec、--grep、--shard、--repeat-each 都不是整套,拿去對基準一定對不上,那不是故障。
 */
function describePartialRun(config: FullConfig, filesInRun: ReadonlySet<string>): string | null {
  if (config.shard) return `使用了 --shard(${config.shard.current}/${config.shard.total})`;
  const repeatEach = Math.max(...config.projects.map((p) => p.repeatEach ?? 1));
  if (repeatEach > 1) return `使用了 --repeat-each=${repeatEach}`;
  const grep = config.grep;
  const grepIsDefault = !Array.isArray(grep) && grep.source === ".*";
  if (!grepIsDefault) return "使用了 --grep";
  if (config.grepInvert) return "使用了 --grep-invert";

  const onDisk = new Set(
    config.projects.flatMap((p) => listSpecFilesOnDisk(p.testDir)).map(normalizePath),
  );
  const inRun = new Set([...filesInRun].map(normalizePath));
  const missing = [...onDisk].filter((f) => !inRun.has(f));
  if (missing.length > 0) {
    return `只跑了 ${inRun.size}/${onDisk.size} 個 spec 檔`;
  }
  return null;
}

class TestCountGateReporter implements Reporter {
  private config!: FullConfig;
  private suite!: Suite;
  private readonly isListMode = process.argv.includes("--list");

  onBegin(config: FullConfig, suite: Suite): void {
    this.config = config;
    this.suite = suite;
  }

  printsToStdio(): boolean {
    return true;
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | void> {
    const tests: TestCase[] = this.suite.allTests();
    const summary = summarizeRun(tests);
    const filesInRun = new Set(tests.map((t) => t.location.file));
    const actual = { tests: summary.collected, files: summary.files };
    const problems: string[] = [];
    const lines: string[] = [];

    // ── B. 收錄條數 vs 基準(整套跑或 --list 時才核對)────────────────────────────────
    const partialReason = describePartialRun(this.config, filesInRun);
    if (process.env[UPDATE_BASELINE_ENV]) {
      if (partialReason) {
        problems.push(
          `🔴 拒絕更新基準:這次不是整套執行(${partialReason}),寫進去的數字會是錯的。` +
            `請不帶任何檔名/篩選條件重跑 npm run test:e2e:count:update。`,
        );
      } else {
        const before = readBaseline();
        writeBaseline(actual);
        lines.push(
          `${TAG} 已更新基準 ${BASELINE_LABEL}:` +
            `${before ? `${before.tests} 條/${before.files} 檔 → ` : ""}${actual.tests} 條/${actual.files} 檔。` +
            `請把這個檔案跟你的測試一起 commit。`,
        );
      }
    } else if (partialReason) {
      lines.push(
        `${TAG} 收錄 ${actual.tests} 條/${actual.files} 檔(部分執行:${partialReason},略過基準核對;` +
          `整套的基準核對交給 npm run test:e2e:count)`,
      );
    } else {
      const baseline = readBaseline();
      const problem = compareWithBaseline(actual, baseline, BASELINE_LABEL);
      if (problem) {
        problems.push(problem);
      } else {
        lines.push(
          `${TAG} 收錄 ${actual.tests} 條/${actual.files} 檔(基準 ${baseline!.tests} 條/${baseline!.files} 檔 ✓)`,
        );
      }
    }

    // ── A. 實際執行 vs 收錄(--list 沒有執行任何測試,不核對)──────────────────────────
    if (!this.isListMode) {
      lines.push(
        `${TAG} 實際執行 ${summary.executed}/${summary.collected} | 通過 ${summary.passed} | 失敗 ${summary.failed}` +
          ` | 不穩定 ${summary.flaky} | 刻意跳過 ${summary.skipped} | 被中斷 ${summary.interrupted}` +
          ` | 沒跑到 ${summary.didNotRun}${summary.didNotRun === 0 ? " ✓" : " ✗"}`,
      );
      const unexecuted = describeUnexecuted(summary);
      if (unexecuted) problems.push(unexecuted);
    }

    console.log("");
    for (const line of lines) console.log(line);
    if (problems.length > 0) {
      console.log(`${TAG} 🔴 守門未通過,這次結果改判為 failed:`);
      for (const problem of problems) console.log(problem);
      console.log("");
      return { status: "failed" };
    }
    console.log(`${TAG} 守門通過。`);
    console.log("");
    // 不改判:維持 Playwright 原本的結果(passed/failed/…)。
    void result;
  }
}

export default TestCountGateReporter;
