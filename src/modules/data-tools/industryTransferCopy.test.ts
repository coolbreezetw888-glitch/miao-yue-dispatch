// SPECS-INDEX #1025 FG1-U06 第 3 點(QA L1):產業轉移精靈「選會員」空狀態說明 × 資料匯入功能開關。

import { describe, expect, it } from "vitest";

import { emptyActiveMembersDescription } from "./industryTransferCopy";

describe("emptyActiveMembersDescription", () => {
  it("資料匯入開通 ⇒ 照舊提到資料匯入", () => {
    expect(emptyActiveMembersDescription(true)).toBe(
      "只有「上架中」的會員可以搬到新商家。要先在會員管理把會員上架，或是先用資料匯入把客戶匯進來。",
    );
  });

  it("資料匯入沒開通 / 還不知道 ⇒ 沒有「資料匯入」那半句", () => {
    const text = emptyActiveMembersDescription(false);
    expect(text).toBe("只有「上架中」的會員可以搬到新商家。要先在會員管理把會員上架。");
    expect(text).not.toContain("資料匯入");
  });
});
