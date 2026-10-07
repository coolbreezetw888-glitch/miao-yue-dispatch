// SPECS-INDEX #999(第 11 批):服務人員編輯頁 order-switch-confirm 小卡窗每次打開都要重新掛載。
// 真實滑鼠 + 時間差的重現在 e2e-local/b11-999-order-switch-reopen.spec.ts;這裡是原始碼守門,
// 防止之後有人把 key 拿掉、或打開小卡窗時忘了先 +1(兩者少一個,「取消後很快再點」遮罩就會蓋住按鈕)。
import { describe, expect, it } from "vitest";

import { readSourceWithoutComments } from "@/test/sourceScan";

describe("#999:order-switch-confirm 每次打開重新掛載(比照第 11 批 E)", () => {
  const src = readSourceWithoutComments("src/modules/staff-agent/StaffListPage.tsx");

  it("包住 order-switch-confirm 的 CardAlertDialog 以 orderSwitchDialogSeq 當 key", () => {
    const content = src.indexOf('data-testid="order-switch-confirm"');
    expect(content).toBeGreaterThan(-1);
    // 往前找最近的根元件開頭 `<CardAlertDialog` + 空白(不是 `<CardAlertDialogContent`)。
    const roots = [...src.slice(0, content).matchAll(/<CardAlertDialog\s/g)];
    expect(roots.length).toBeGreaterThan(0);
    const rootTag = src.slice(roots[roots.length - 1]!.index, content);
    expect(rootTag).toContain("key={orderSwitchDialogSeq}");
    expect(rootTag).toContain("open={orderSwitchConfirm !== null}");
  });

  it("打開小卡窗(setOrderSwitchConfirm(decision.kind))之前先把 orderSwitchDialogSeq +1", () => {
    const open = src.indexOf("setOrderSwitchConfirm(decision.kind)");
    expect(open).toBeGreaterThan(-1);
    const before = src.slice(src.lastIndexOf("else {", open), open);
    expect(before).toContain("setOrderSwitchDialogSeq((n) => n + 1)");
  });
});
