// #804:「執行條數守門」純邏輯的 Vitest 測試。重點是證明三種情況會被**分開**辨識,
// 訊息不會混在一起——「新增了測試所以變多」跟「測試靜默沒跑」是兩件完全不同的事。
import { describe, expect, it } from "vitest";

import {
  compareWithBaseline,
  describeUnexecuted,
  summarizeRun,
  UPDATE_COMMAND,
  type TestLike,
} from "./test-count-gate";

const LABEL = "e2e/test-count-baseline.json";

function fakeTest(overrides: Partial<TestLike> & { outcome: TestLike["outcome"] }): TestLike {
  return {
    title: "某條測試",
    location: { file: "D:/repo/e2e/a.spec.ts", line: 10 },
    expectedStatus: "passed",
    results: [{ status: "passed" }],
    ...overrides,
  };
}

describe("compareWithBaseline:收錄條數 vs 基準", () => {
  it("條數與檔數都一致 → null(通過)", () => {
    expect(
      compareWithBaseline({ tests: 114, files: 21 }, { tests: 114, files: 21 }, LABEL),
    ).toBeNull();
  });

  it("比基準少 → 🔴 訊息講的是「靜默消失」,而且明講不可以直接更新基準", () => {
    const msg = compareWithBaseline({ tests: 112, files: 21 }, { tests: 114, files: 21 }, LABEL);
    expect(msg).not.toBeNull();
    expect(msg).toContain("🔴");
    expect(msg).toContain("少");
    expect(msg).toContain("靜默消失");
    expect(msg).toContain("-2");
    expect(msg).toContain("只有在確定是刻意刪除測試時");
  });

  it("檔數少了(即使條數相同)也算少 → 🔴", () => {
    const msg = compareWithBaseline({ tests: 114, files: 20 }, { tests: 114, files: 21 }, LABEL);
    expect(msg).toContain("🔴");
    expect(msg).toContain("靜默消失");
  });

  it("比基準多 → 🟡 訊息講的是「新增了測試」,並給出更新基準的指令", () => {
    const msg = compareWithBaseline({ tests: 117, files: 22 }, { tests: 114, files: 21 }, LABEL);
    expect(msg).not.toBeNull();
    expect(msg).toContain("🟡");
    expect(msg).toContain("多");
    expect(msg).toContain("+3");
    expect(msg).toContain(UPDATE_COMMAND);
    expect(msg).not.toContain("靜默消失");
  });

  it("沒有基準檔 → 🔴 要求先建立基準", () => {
    const msg = compareWithBaseline({ tests: 114, files: 21 }, null, LABEL);
    expect(msg).toContain("找不到");
    expect(msg).toContain(UPDATE_COMMAND);
  });
});

describe("summarizeRun:逐條分類(對齊 Playwright 自己的 did not run 定義)", () => {
  it("全部通過 → executed = collected,didNotRun = 0", () => {
    const summary = summarizeRun([
      fakeTest({ outcome: () => "expected" }),
      fakeTest({ outcome: () => "expected", location: { file: "D:/repo/e2e/b.spec.ts", line: 3 } }),
    ]);
    expect(summary.collected).toBe(2);
    expect(summary.files).toBe(2);
    expect(summary.executed).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.didNotRun).toBe(0);
    expect(describeUnexecuted(summary)).toBeNull();
  });

  it("沒有任何 result 的測試(worker 當掉後的 serial 連坐)→ didNotRun,executed 不計", () => {
    const summary = summarizeRun([
      fakeTest({ outcome: () => "unexpected", results: [{ status: "failed" }], title: "當掉那條" }),
      fakeTest({
        outcome: () => "skipped",
        results: [],
        title: "被連坐 1",
        location: { file: "x.spec.ts", line: 20 },
      }),
      fakeTest({
        outcome: () => "skipped",
        results: [],
        title: "被連坐 2",
        location: { file: "x.spec.ts", line: 30 },
      }),
    ]);
    expect(summary.collected).toBe(3);
    expect(summary.executed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.didNotRun).toBe(2);
    expect(summary.didNotRunTitles).toEqual(["x.spec.ts:20 › 被連坐 1", "x.spec.ts:30 › 被連坐 2"]);
    const msg = describeUnexecuted(summary);
    expect(msg).toContain("🔴");
    expect(msg).toContain("2 條測試**沒有跑到**");
    expect(msg).toContain("收錄 3 條,實際執行 1 條");
    expect(msg).toContain("x.spec.ts:20 › 被連坐 1");
  });

  it("刻意 test.skip()(expectedStatus = skipped 且有 skipped result)→ 算 skipped,不算沒跑到", () => {
    const summary = summarizeRun([
      fakeTest({
        outcome: () => "skipped",
        expectedStatus: "skipped",
        results: [{ status: "skipped" }],
      }),
    ]);
    expect(summary.skipped).toBe(1);
    expect(summary.didNotRun).toBe(0);
    expect(summary.executed).toBe(1);
  });

  it("result 是 skipped 但 expectedStatus 不是 skipped → 算沒跑到(這正是 Playwright 的 did not run)", () => {
    const summary = summarizeRun([
      fakeTest({
        outcome: () => "skipped",
        expectedStatus: "passed",
        results: [{ status: "skipped" }],
      }),
    ]);
    expect(summary.didNotRun).toBe(1);
    expect(summary.skipped).toBe(0);
  });

  it("被中斷(interrupted)→ 分開計,不混進 didNotRun", () => {
    const summary = summarizeRun([
      fakeTest({ outcome: () => "skipped", results: [{ status: "interrupted" }] }),
    ]);
    expect(summary.interrupted).toBe(1);
    expect(summary.didNotRun).toBe(0);
  });

  it("超過 20 條沒跑到時,清單只列前 20 條並註明還有幾條", () => {
    const tests = Array.from({ length: 25 }, (_, i) =>
      fakeTest({
        outcome: () => "skipped",
        results: [],
        title: `t${i}`,
        location: { file: "y.spec.ts", line: i + 1 },
      }),
    );
    const msg = describeUnexecuted(summarizeRun(tests));
    expect(msg).toContain("25 條測試**沒有跑到**");
    expect(msg).toContain("…還有 5 條");
  });
});
