// SPECS-INDEX #1052 H2-05:LINE 通知 / 再行銷關閉時,會員相關畫面的選項與文字。
import { describe, expect, it } from "vitest";

import { membersListFirstMemberHint, rewardConditionModeOptions } from "./memberLineFeatureCopy";

describe("核發獎勵資格條件下拉(#1052 H2-05)", () => {
  it("LINE 通知開 ⇒ 兩個選項都列", () => {
    expect(rewardConditionModeOptions(true, "none")).toEqual(["none", "line_bound"]);
  });

  it("LINE 通知關(或讀取中)⇒ 不列「只看 LINE 已綁定」", () => {
    expect(rewardConditionModeOptions(false, "none")).toEqual(["none"]);
  });

  it("LINE 通知關,但目前存的就是「只看 LINE 已綁定」⇒ 照樣列出,值不被洗掉", () => {
    expect(rewardConditionModeOptions(false, "line_bound")).toEqual(["none", "line_bound"]);
  });
});

describe("會員名單空白狀態說明(#1052 H2-05)", () => {
  it("再行銷開 ⇒ 提到 LINE 再行銷通知", () => {
    expect(membersListFirstMemberHint(true)).toContain("LINE 再行銷通知");
  });

  it("再行銷沒開 ⇒ 完全不提 LINE", () => {
    const text = membersListFirstMemberHint(false);
    expect(text).not.toContain("LINE");
    expect(text.endsWith("。")).toBe(true);
  });
});
