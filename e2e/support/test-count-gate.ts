// #804(SPECS-INDEX):Playwright「執行條數守門」的純邏輯(不碰 Playwright 執行環境,方便用 Vitest 秒測)。
// 真正掛進 Playwright 的 reporter 在 ./test-count-gate-reporter.ts,這裡只放「怎麼算、怎麼判、怎麼說」。
//
// 要解決的問題(跟 #714 同一家族:**不是變紅,是「沒有跑」**):
//   1. worker 行程整個當掉(#804 實際遇到 Windows 0xC0000409)時,同一個 serial 群組後面的測試會被標成
//      `did not run`,畫面上只是一行黃字,CI 上很容易被當成通過。
//   2. testMatch 被改壞、檔案被誤刪、`.test.ts` 混進 `e2e/`(#714)時,整套測試會靜默變少甚至歸零,
//      沒有任何紅字。
// 兩種都靠「把應該有幾條測試寫成機器可核對的基準值,每次跑都對照」來抓,對照結果分成三種、各自不同的話:
//   - 收錄條數 < 基準  → 🔴 測試靜默消失,要查(不可以直接更新基準把它蓋掉)
//   - 收錄條數 > 基準  → 🟡 新增了測試但基準沒更新,跑 `npm run test:e2e:count:update` 即可
//   - 收錄條數 = 基準,但實際執行 < 收錄 → 🔴 有測試沒跑到(worker 當掉/serial 連坐),結果不能採信

/** 基準檔(e2e/test-count-baseline.json)的內容。 */
export interface TestCountBaseline {
  /** 說明文字,只給人看,程式不使用。 */
  comment?: string;
  /** 上次更新基準的日期(YYYY-MM-DD),只給人看。 */
  updatedAt?: string;
  /** 全套 e2e 應該收錄到的測試條數(等同 `npx playwright test --list` 的 Total 條數)。 */
  tests: number;
  /** 全套 e2e 應該收錄到的 spec 檔數。 */
  files: number;
}

export interface TestCountActual {
  tests: number;
  files: number;
}

/** 這是 Playwright TestCase 的最小子集——reporter 傳真的 TestCase 進來,單元測試傳假物件進來。 */
export interface TestLike {
  title: string;
  location: { file: string; line: number };
  expectedStatus: string;
  results: ReadonlyArray<{ status: string }>;
  outcome(): "skipped" | "expected" | "unexpected" | "flaky";
}

export interface RunSummary {
  /** 收錄進這次 run 的測試條數(不管有沒有跑)。 */
  collected: number;
  /** 收錄進這次 run 的 spec 檔數。 */
  files: number;
  /** 實際有執行到(至少跑過一次 attempt,且結果不是「沒跑」)的條數。 */
  executed: number;
  passed: number;
  failed: number;
  flaky: number;
  /** 靜態或動態 `test.skip()` 刻意跳過的。 */
  skipped: number;
  /** 被 Ctrl+C / SIGINT 中斷的。 */
  interrupted: number;
  /** **沒有跑到**的:worker 當掉、serial 群組連坐、跑到一半程序結束……Playwright 自己標成 `did not run` 的那些。 */
  didNotRun: number;
  /** 沒跑到的測試清單(給人看),格式 `檔名:行號 › 標題`。 */
  didNotRunTitles: string[];
}

/**
 * 逐條分類這次 run 的結果。分類規則**逐字對齊 Playwright 自己 list reporter 的 generateSummary()**
 * (node_modules/playwright/lib/runner/index.js),所以這裡數出來的 `didNotRun` 跟終端機最後那行
 * 「N did not run」永遠是同一個數字,不會有兩套定義。
 */
export function summarizeRun(tests: ReadonlyArray<TestLike>): RunSummary {
  const summary: RunSummary = {
    collected: tests.length,
    files: new Set(tests.map((t) => t.location.file)).size,
    executed: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    didNotRun: 0,
    didNotRunTitles: [],
  };
  for (const test of tests) {
    switch (test.outcome()) {
      case "skipped": {
        if (test.results.some((r) => r.status === "interrupted")) {
          summary.interrupted += 1;
        } else if (test.results.length === 0 || test.expectedStatus !== "skipped") {
          summary.didNotRun += 1;
          summary.didNotRunTitles.push(
            `${basename(test.location.file)}:${test.location.line} › ${test.title}`,
          );
        } else {
          summary.skipped += 1;
          summary.executed += 1;
        }
        break;
      }
      case "expected":
        summary.passed += 1;
        summary.executed += 1;
        break;
      case "unexpected":
        summary.failed += 1;
        summary.executed += 1;
        break;
      case "flaky":
        summary.flaky += 1;
        summary.executed += 1;
        break;
    }
  }
  return summary;
}

function basename(file: string): string {
  const idx = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return idx >= 0 ? file.slice(idx + 1) : file;
}

export const UPDATE_COMMAND = "npm run test:e2e:count:update";

/**
 * 「收錄條數」對「基準值」的判定。回傳 null 代表一致;否則回傳一段要印給人看的訊息。
 * 三種情況的訊息**刻意長得不一樣**(少了/多了/沒基準),看第一個字就分得出來該做什麼。
 */
export function compareWithBaseline(
  actual: TestCountActual,
  baseline: TestCountBaseline | null,
  baselineLabel: string,
): string | null {
  if (!baseline) {
    return (
      `🔴 找不到 e2e 測試條數的基準檔(${baselineLabel})。` +
      `沒有基準就沒辦法分辨「測試變少」跟「本來就這麼多」,請先跑 ${UPDATE_COMMAND} 建立基準,並把它 commit。`
    );
  }
  if (actual.tests === baseline.tests && actual.files === baseline.files) return null;

  const diffTests = actual.tests - baseline.tests;
  const diffFiles = actual.files - baseline.files;
  const describe = `基準 ${baseline.tests} 條/${baseline.files} 檔,這次收錄到 ${actual.tests} 條/${actual.files} 檔`;

  if (diffTests < 0 || diffFiles < 0) {
    return (
      `🔴 收錄的 e2e 測試比基準**少**(${describe};條數 ${fmt(diffTests)}、檔數 ${fmt(diffFiles)})。\n` +
      `   這是「測試靜默消失」的徵兆(#714/#804 家族,不會有紅字,只會變少):常見原因是 testMatch 被改、\n` +
      `   spec 檔被誤刪/改名、\`.test.ts\` 混進 e2e/、或留了 test.only / --grep 把測試濾掉。\n` +
      `   先找出少掉的是哪幾條;**只有在確定是刻意刪除測試時**,才跑 ${UPDATE_COMMAND} 更新基準。`
    );
  }
  return (
    `🟡 收錄的 e2e 測試比基準**多**(${describe};條數 ${fmt(diffTests)}、檔數 ${fmt(diffFiles)})。\n` +
    `   看起來是新增了測試但基準還沒更新。請跑 ${UPDATE_COMMAND}(會把新數字寫進 ${baselineLabel}),\n` +
    `   然後把那個檔案跟你的測試一起 commit。`
  );
}

/** 「實際執行條數」對「收錄條數」的判定。回傳 null 代表全部都有跑到。 */
export function describeUnexecuted(summary: RunSummary): string | null {
  if (summary.didNotRun === 0) return null;
  const preview = summary.didNotRunTitles.slice(0, 20).map((t) => `     - ${t}`);
  if (summary.didNotRunTitles.length > 20) {
    preview.push(`     …還有 ${summary.didNotRunTitles.length - 20} 條`);
  }
  return (
    `🔴 有 ${summary.didNotRun} 條測試**沒有跑到**(did not run):收錄 ${summary.collected} 條,實際執行 ${summary.executed} 條` +
    (summary.interrupted ? `,另有 ${summary.interrupted} 條被中斷` : "") +
    `。\n` +
    `   典型原因:worker 行程整個當掉(#804 實際遇過 Windows 0xC0000409)、或 serial 群組前面失敗把後面連坐。\n` +
    `   這批結果**不能當成通過**——沒跑到的測試什麼都沒驗到。請重跑下列 spec 確認:\n` +
    preview.join("\n")
  );
}

function fmt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
