// #844 批次 4:已完成訂單取消/還原 —— 純邏輯(規格書 §3.3、§3.8、§3.12、§3.13、§5.2~5.4、§十 Vitest)。
// 畫面整合(按鈕顯示條件、送出參數、成功後重抓、差額小卡窗)在 completedBookingReversalDialog.test.tsx。

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  AGENT_CANNOT_REVERSE_NOTE,
  REVERSAL_EXPLANATIONS,
  REVERSAL_EXPLANATION_SEGMENTS,
  REVERSAL_REASON_MAX,
  buildCompletedBookingReversalView,
  completedBookingReversalInvalidationKeys,
  crossMonthWarningSegments,
  formatReportMonth,
  invalidateAfterCompletedBookingReversal,
  isReversalStateChangedError,
  normalizeReversalReason,
  reversalConfirmDisabledReason,
  reversalReasonError,
  reversalReasonLength,
  reversalShortfallNotice,
  segmentsToText,
} from "./completedBookingReversal";
import type { CompletedBookingReversalPreview } from "./types";

const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

function preview(
  overrides: Partial<CompletedBookingReversalPreview> = {},
): CompletedBookingReversalPreview {
  return {
    booking_id: "b-1",
    status: "completed",
    source: "manual",
    can_revert: true,
    can_cancel: true,
    blocked_reasons: [],
    staff: { id: "s-1", name: "服務人員甲", status: "active", compensation_type_now: "piece_rate" },
    commission: {
      exists: true,
      amount: "300.00",
      recalculated: false,
      computed_at: "2026-09-30T06:00:00Z",
    },
    completed_at: "2026-09-30T06:00:00Z",
    report_month: "2026-09",
    is_cross_month: false,
    months_ago: 0,
    revenue_amount: "1500.00",
    member: { id: "m-1", name: "王小美", status: "active", balance: 10 },
    points: {
      members: [
        {
          member_id: "m-1",
          name: "王小美",
          status: "active",
          balance: 10,
          due_expected: 50,
          frozen_refund_expected: 30,
          shortfall_if_revert: 40,
          shortfall_if_cancel: 10,
        },
      ],
      points_due_expected: 50,
      frozen_points: 30,
      referral: null,
    },
    warnings: [],
    ...overrides,
  };
}

describe("原因(§3.3):字數與空白規則跟後端 btrim + char_length 一致", () => {
  it("去頭尾半形空白、tab、換行、全形空白;中間的空白保留", () => {
    expect(
      normalizeReversalReason(`  \t\n${IDEOGRAPHIC_SPACE}誤按 完成${IDEOGRAPHIC_SPACE}\r\n `),
    ).toBe("誤按 完成");
  });

  it("空白 / 只有空白(含全形空白、只有換行)⇒ 請先填寫原因", () => {
    expect(reversalReasonError("")).toBe("請先填寫原因");
    expect(reversalReasonError("   ")).toBe("請先填寫原因");
    expect(reversalReasonError(`${IDEOGRAPHIC_SPACE}${IDEOGRAPHIC_SPACE}`)).toBe("請先填寫原因");
    expect(reversalReasonError("\n\n\t")).toBe("請先填寫原因");
    expect(reversalReasonError("誤按")).toBeNull();
  });

  it("剛好 500 字可以;501 字擋下,訊息跟後端同句型", () => {
    expect(reversalReasonError("字".repeat(REVERSAL_REASON_MAX))).toBeNull();
    expect(reversalReasonError("字".repeat(REVERSAL_REASON_MAX + 1))).toBe(
      "原因最多 500 個字，目前是 501 個字，請精簡後再送出",
    );
  });

  it("頭尾空白不算字數(後端先 btrim 再算)", () => {
    expect(reversalReasonError(`  ${"字".repeat(500)}\n${IDEOGRAPHIC_SPACE}`)).toBeNull();
    expect(reversalReasonLength(`  ${"字".repeat(500)}\n`)).toBe(500);
  });

  it("emoji 算 1 個字(後端 char_length 數 code point;JS .length 會算成 2)", () => {
    const emoji = "😀";
    expect(emoji.length).toBe(2);
    expect(reversalReasonLength(emoji.repeat(500))).toBe(500);
    expect(reversalReasonError(emoji.repeat(500))).toBeNull();
    expect(reversalReasonError(emoji.repeat(501))).not.toBeNull();
  });
});

describe("跨月(§3.8 / §5.3)", () => {
  it("formatReportMonth:'2026-09' → '2026 年 9 月'", () => {
    expect(formatReportMonth("2026-09")).toBe("2026 年 9 月");
    expect(formatReportMonth("2024-12")).toBe("2024 年 12 月");
  });

  it("取消 + 有抽成:文案逐字對照規格,月份 / 月數 / 金額加粗", () => {
    const segments = crossMonthWarningSegments(
      preview({ is_cross_month: true, months_ago: 1 }),
      "cancel",
    );
    expect(segmentsToText(segments)).toBe(
      "這張單是 2026 年 9 月 完成的，已經是 1 個月前。那個月的薪資與店家報表可能已經結算發放。取消之後，2026 年 9 月的服務人員抽成會少 $300、營收會少 $1,500，報表數字會跟當時不一樣。請先確認財務端是否需要同步調整。",
    );
    expect(segments.filter((s) => s.strong).map((s) => s.text)).toEqual([
      "2026 年 9 月",
      "1 個月前",
      "可能已經結算發放",
      "2026 年 9 月",
      "$300",
      "$1,500",
    ]);
  });

  it("還原 + 沒有抽成(月薪制):用「還原」,不講「抽成會少 $0」", () => {
    const text = segmentsToText(
      crossMonthWarningSegments(
        preview({
          is_cross_month: true,
          months_ago: 31,
          report_month: "2024-03",
          commission: { exists: false, amount: 0, recalculated: false, computed_at: null },
        }),
        "revert",
      ),
    );
    expect(text).toContain("已經是 31 個月前");
    expect(text).toContain("還原之後，2024 年 3 月的營收會少 $1,500");
    expect(text).not.toContain("抽成");
  });

  it("寫「可能已經結算」,不替商家斷言「已經結算」(系統沒有發薪紀錄)", () => {
    const text = segmentsToText(
      crossMonthWarningSegments(preview({ is_cross_month: true, months_ago: 1 }), "cancel"),
    );
    expect(text).toContain("可能已經結算");
  });
});

describe("§3.12 文案守門:帳務會更新 vs 退款不處理是兩件事", () => {
  it("取消路徑同時含「抽成」「報表」「退款」", () => {
    for (const word of ["抽成", "報表", "退款"]) {
      expect(REVERSAL_EXPLANATIONS.cancel).toContain(word);
    }
  });

  it("任何文案都不准寫「不影響帳務」「帳務不會變動」", () => {
    for (const text of [
      REVERSAL_EXPLANATIONS.cancel,
      REVERSAL_EXPLANATIONS.revert,
      AGENT_CANNOT_REVERSE_NOTE,
    ]) {
      expect(text).not.toMatch(/不影響帳務|帳務不會變動/);
    }
  });

  it("規格標粗的字用 segments 加粗;純文字版字面不變", () => {
    const bold = (a: "revert" | "cancel") =>
      REVERSAL_EXPLANATION_SEGMENTS[a].filter((x) => x.strong).map((x) => x.text);
    expect(bold("revert")).toEqual(["當時"]);
    expect(bold("cancel")).toEqual(["無法再復原", "但實際退款要另外處理"]);
    expect(REVERSAL_EXPLANATIONS.cancel).toBe(
      "這張單會變成「已取消」，無法再復原。系統會自動更新服務人員抽成與店家報表。但實際退款要另外處理——系統沒有退款功能，請自行與客人結清。",
    );
    expect(REVERSAL_EXPLANATIONS.revert).toBe(
      "這張單會退回「已確認」，可以繼續編輯，之後要再按一次「標記完成」。服務人員抽成與會員紅利會先收回，重新完成時依當時的設定重新計算。",
    );
  });

  it("取消路徑講「無法再復原」;還原路徑講「依當時的設定重新計算」", () => {
    expect(REVERSAL_EXPLANATIONS.cancel).toContain("無法再復原");
    expect(REVERSAL_EXPLANATIONS.revert).toContain("依當時的設定重新計算");
  });

  it("用語:一律「服務人員」", () => {
    for (const text of [REVERSAL_EXPLANATIONS.cancel, REVERSAL_EXPLANATIONS.revert]) {
      expect(text).toContain("服務人員");
      expect(text).not.toContain("師" + "傅");
    }
  });
});

describe("預覽 → 畫面資料(§5.2)", () => {
  it("連帶影響清單:抽成 / 會員紅利 / 折抵(取消 = 退回)/ 報表月份 / 完成時間", () => {
    const view = buildCompletedBookingReversalView(preview(), "cancel");
    expect(view.impactRows.map((r) => [r.label, r.value])).toEqual([
      ["服務人員抽成", "服務人員甲 −$300"],
      ["會員紅利", "王小美 預計收回 50 點(目前餘額 10 點)"],
      ["折抵點數", "退回 30 點給 王小美"],
      ["影響報表月份", "2026 年 9 月(服務人員報表、店家報表)"],
      ["完成時間", "2026/9/30 14:00:00"],
    ]);
  });

  it("還原路徑:折抵「維持不變」(單子還活著,不退凍結)", () => {
    const view = buildCompletedBookingReversalView(preview(), "revert");
    expect(view.impactRows.find((r) => r.key === "redeem")?.value).toBe("折抵 30 點維持不變");
  });

  it("沒有抽成 ⇒「無(月薪制/未產生抽成)」;沒有點數 ⇒ 會員紅利 / 折抵整列不顯示", () => {
    const view = buildCompletedBookingReversalView(
      preview({
        commission: { exists: false, amount: 0, recalculated: false, computed_at: null },
        points: null,
        member: null,
      }),
      "cancel",
    );
    expect(view.impactRows.find((r) => r.key === "commission")?.value).toBe(
      "無(月薪制/未產生抽成)",
    );
    expect(view.impactRows.some((r) => r.label === "會員紅利")).toBe(false);
    expect(view.impactRows.some((r) => r.key === "redeem")).toBe(false);
    expect(view.expectedShortfall).toBe(0);
  });

  it("邊界 19:兩位會員各一列;推薦人一列", () => {
    const base = preview();
    const view = buildCompletedBookingReversalView(
      preview({
        points: {
          ...base.points!,
          members: [
            base.points!.members[0]!,
            {
              member_id: "m-2",
              name: "李新會員",
              status: "active",
              balance: 0,
              due_expected: 20,
              frozen_refund_expected: 0,
              shortfall_if_revert: 20,
              shortfall_if_cancel: 20,
            },
          ],
          referral: {
            referrer_member_id: "r-1",
            referrer_name: "推薦人陳",
            referrer_balance: 3,
            due_expected: 5,
            shortfall_expected: 2,
            shortfall_if_revert: 2,
            shortfall_if_cancel: 2,
          },
        },
      }),
      "revert",
    );
    expect(view.impactRows.filter((r) => r.label === "會員紅利").map((r) => r.value)).toEqual([
      "王小美 預計收回 50 點(目前餘額 10 點)",
      "李新會員 預計收回 20 點(目前餘額 0 點)",
    ]);
    expect(view.impactRows.find((r) => r.key === "referral")?.value).toBe(
      "推薦人陳 預計收回 5 點(目前餘額 3 點)",
    );
    // 還原:40 + 20 + 推薦 2
    expect(view.expectedShortfall).toBe(62);
  });

  it("預計差額選對路徑的欄位:還原看 shortfall_if_revert、取消看 shortfall_if_cancel", () => {
    expect(buildCompletedBookingReversalView(preview(), "revert").expectedShortfall).toBe(40);
    expect(buildCompletedBookingReversalView(preview(), "cancel").expectedShortfall).toBe(10);
  });

  it("同月:沒有跨月警告;確定鈕「確定還原」(主要)/「確定取消訂單」(危險)", () => {
    const revert = buildCompletedBookingReversalView(preview(), "revert");
    expect(revert.crossMonthSegments).toBeNull();
    expect(revert.confirmLabel).toBe("確定還原");
    expect(revert.confirmVariant).toBe("primary");
    const cancel = buildCompletedBookingReversalView(preview(), "cancel");
    expect(cancel.confirmLabel).toBe("確定取消訂單");
    expect(cancel.confirmVariant).toBe("danger");
  });

  it("跨月:有紅色警告;按鈕文字改「我了解影響,確定{還原/取消}」", () => {
    const p = preview({ is_cross_month: true, months_ago: 1 });
    expect(buildCompletedBookingReversalView(p, "revert").confirmLabel).toBe(
      "我了解影響，確定還原",
    );
    expect(buildCompletedBookingReversalView(p, "cancel").confirmLabel).toBe(
      "我了解影響，確定取消",
    );
    expect(buildCompletedBookingReversalView(p, "cancel").crossMonthSegments).not.toBeNull();
  });

  it("§3.13 匯入單:還原被擋(顯示原因),取消不受影響", () => {
    const p = preview({
      source: "import",
      can_revert: false,
      blocked_reasons: [
        { code: "import_cannot_revert", message: "匯入的歷史訂單不能還原,只能取消。" },
      ],
    });
    const revert = buildCompletedBookingReversalView(p, "revert");
    expect(revert.allowed).toBe(false);
    expect(revert.blockedReasons.map((b) => b.code)).toEqual(["import_cannot_revert"]);
    const cancel = buildCompletedBookingReversalView(p, "cancel");
    expect(cancel.allowed).toBe(true);
    expect(cancel.blockedReasons).toEqual([]);
  });

  it("warnings 原樣帶過去(後端已白話)", () => {
    const view = buildCompletedBookingReversalView(
      preview({ warnings: [{ code: "staff_removed", message: "服務人員「甲」已經移除。" }] }),
      "revert",
    );
    expect(view.warnings).toEqual([{ code: "staff_removed", message: "服務人員「甲」已經移除。" }]);
  });
});

describe("確定鈕為什麼不能按(skill 二之三)", () => {
  it("預覽還沒好 ⇒ 請稍候;被擋 ⇒ 擋下原因優先;原因空白 ⇒ 請先填寫原因;都好 ⇒ null", () => {
    expect(reversalConfirmDisabledReason(null, "誤按")).toBe("正在計算連帶影響，請稍候");
    const blocked = buildCompletedBookingReversalView(
      preview({
        can_revert: false,
        blocked_reasons: [{ code: "import_cannot_revert", message: "匯入的歷史訂單不能還原" }],
      }),
      "revert",
    );
    expect(reversalConfirmDisabledReason(blocked, "")).toBe("匯入的歷史訂單不能還原");
    const ok = buildCompletedBookingReversalView(preview(), "revert");
    expect(reversalConfirmDisabledReason(ok, " ")).toBe("請先填寫原因");
    expect(reversalConfirmDisabledReason(ok, "誤按完成")).toBeNull();
  });
});

describe("執行結果(§5.4)", () => {
  const zero = {
    points_due: 10,
    points_recovered: 10,
    points_shortfall: 0,
    referral_due: 0,
    referral_recovered: 0,
    referral_shortfall: 0,
    referrer_member_id: null,
    shortfall_hint: null,
    frozen_points_refunded: 0,
  };

  it("沒有差額 ⇒ 不跳小卡窗", () => {
    expect(reversalShortfallNotice({ points: zero })).toBeNull();
  });

  it("有差額 ⇒ 標題講合計(會員 + 推薦人),內文是 shortfall_hint 原文(不改寫、不解析)", () => {
    const hint =
      "應收回 50 點，會員目前只有 10 點。這 40 點是在訂單「2026/09/30 14:00 <b>王小美</b>」折抵掉的。";
    const notice = reversalShortfallNotice({
      points: { ...zero, points_shortfall: 40, referral_shortfall: 3, shortfall_hint: hint },
    });
    expect(notice).toEqual({ points: 43, title: "有 43 點未能收回", hint });
  });

  it("萬一後端沒給提示,仍用數字講一句(不會出現空白小卡窗)", () => {
    const notice = reversalShortfallNotice({ points: { ...zero, points_shortfall: 5 } });
    expect(notice?.hint).toContain("5 點");
    expect(notice?.hint).toContain("手動調整點數");
  });

  it("「狀態已經改變」錯誤辨識", () => {
    expect(isReversalStateChangedError("這筆訂單的狀態已經改變，請重新整理後再試")).toBe(true);
    expect(isReversalStateChangedError("請填寫還原/取消的原因")).toBe(false);
  });
});

describe("成功後重抓(否則畫面停在舊數字)", () => {
  it("清單涵蓋:訂單紅利分類帳、訂單詳情、操作紀錄、會員頁相關訂單、會員餘額、薪資 / 帳務", () => {
    const keys = completedBookingReversalInvalidationKeys("b-1").map((k) => JSON.stringify(k));
    expect(keys).toContain(JSON.stringify(["booking-module", "points-ledger", "b-1"]));
    expect(keys).toContain(JSON.stringify(["booking-module"]));
    expect(keys).toContain(JSON.stringify(["members-module", "related-bookings"]));
    expect(keys).toContain(JSON.stringify(["members-module", "member-detail"]));
    expect(keys).toContain(JSON.stringify(["payroll-module"]));
  });

  it("用真的 QueryClient:相關查詢都被標成過期;預覽本身不重抓(這張單已不是已完成)", async () => {
    const client = new QueryClient();
    const seeded: unknown[][] = [
      ["booking-module", "points-ledger", "b-1"],
      ["booking-module", "booking-detail", "b-1"],
      ["booking-module", "bookings-list", "merchant-1", {}],
      ["booking-module", "day-schedule", "merchant-1", "2026-10-01"],
      ["booking-module", "booking-status-change-logs", "b-1"],
      ["members-module", "related-bookings", "m-1"],
      ["members-module", "member-detail", "m-2"],
      ["members-module", "point-history", "m-1"],
      ["members-module", "members-list", "merchant-1", "", false],
      ["payroll-module", "staff-commission-summary", "s-1", 2026, 9],
      ["payroll-module", "merchant-billing-summary", "merchant-1", 2026, 9],
      ["booking-module", "completed-reversal-preview", "b-1"],
      ["service-items-module", "service-categories", "merchant-1"],
    ];
    for (const key of seeded) client.setQueryData(key, { seeded: true });

    await invalidateAfterCompletedBookingReversal(client, "b-1");

    const invalidated = (key: unknown[]) => client.getQueryState(key)?.isInvalidated ?? false;
    for (const key of seeded.slice(0, 11)) {
      expect({ key, invalidated: invalidated(key) }).toEqual({ key, invalidated: true });
    }
    expect(invalidated(["booking-module", "completed-reversal-preview", "b-1"])).toBe(false);
    expect(invalidated(["service-items-module", "service-categories", "merchant-1"])).toBe(false);
  });
});
