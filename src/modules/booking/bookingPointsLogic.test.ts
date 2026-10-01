// 紅利系統重構 批次 7(§4.6 / §4.7):bookingPointsLogic.ts 的純函式測試。
// 整張表單掛起來的情境在 bookingFormPoints.test.tsx;這裡逐條釘住規則本身。
import { describe, expect, it } from "vitest";

import {
  blockShowsPoints,
  buildCreatePointsParams,
  buildUpdatePointsParams,
  describeBookingDetailPoints,
  describeEarnedPoints,
  describeEditPointsChange,
  describeIneligibleReason,
  isPointsSubmitBlockedByStalePreview,
  minimumPointsForOneDollar,
  needsPointsReviewConfirm,
  parseBookingPointsPreview,
  POINTS_OVERRIDE_MAX_ERROR,
  previewMemberKey,
  redeemPointsToAmount,
  resolveBookingPointsBlockView,
  shouldResetRedeemOnMemberChange,
  validatePointsOverride,
  validateRedeemPoints,
  type OriginalBookingPoints,
  type PointsFormState,
  type PointsRedeemInfo,
} from "./bookingPointsLogic";

function rawPreview(overrides: Record<string, unknown> = {}) {
  return {
    feature_enabled: true,
    member: { resolution: "existing", member_id: "m-1", name: "王小明", balance: 120 },
    rules_configured: true,
    earn_mode: "basic",
    auto_points: 10,
    review_required: false,
    eligible: true,
    ineligible_reason: null,
    reward_condition_mode: null,
    breakdown: [],
    redeem: {
      enabled: true,
      points_unit: 100,
      amount_unit: 10,
      max_ratio_percent: 50,
      payable: 1000,
      available_points: 120,
      max_points: 120,
      max_amount: 12,
      cap_amount: 500,
    },
    ...overrides,
  };
}

const redeemInfo: PointsRedeemInfo = {
  enabled: true,
  pointsUnit: 100,
  amountUnit: 10,
  maxRatioPercent: 50,
  payable: 1000,
  availablePoints: 6000,
  maxPoints: 5000,
  maxAmount: 500,
  capAmount: 500,
};

describe("parseBookingPointsPreview + resolveBookingPointsBlockView(§3.2 / §4.6 顯示條件)", () => {
  it("功能關閉 ⇒ hidden", () => {
    const preview = parseBookingPointsPreview({ feature_enabled: false });
    expect(preview).toEqual({ featureEnabled: false });
    expect(resolveBookingPointsBlockView(preview)).toBe("hidden");
  });

  it("🔴 v2.4 裁決 8 ④:{error} 原樣保留 ⇒ error 狀態(不是 0 點)", () => {
    const preview = parseBookingPointsPreview({
      feature_enabled: true,
      error: "請至少選擇一個服務項目",
    });
    expect(preview).toEqual({ featureEnabled: true, error: "請至少選擇一個服務項目" });
    expect(resolveBookingPointsBlockView(preview)).toBe("error");
  });

  it("回傳格式不認得(缺 auto_points)⇒ 當成錯誤,不是當成 0 點", () => {
    const preview = parseBookingPointsPreview({
      feature_enabled: true,
      member: { resolution: "existing" },
    });
    expect(resolveBookingPointsBlockView(preview)).toBe("error");
    expect(resolveBookingPointsBlockView(parseBookingPointsPreview(null))).toBe("error");
  });

  it("六種 resolution 對到五種區塊狀態", () => {
    const view = (resolution: string) =>
      resolveBookingPointsBlockView(
        parseBookingPointsPreview(
          rawPreview({ member: { resolution, member_id: null, name: null, balance: null } }),
        ),
      );
    expect(view("existing")).toBe("member");
    expect(view("given")).toBe("member");
    expect(view("new")).toBe("new_member");
    expect(view("none")).toBe("no_member");
    expect(view("ambiguous")).toBe("no_member");
    expect(view("phone_incomplete")).toBe("phone_incomplete");
  });

  it("還沒回來 ⇒ loading;呼叫失敗 ⇒ error", () => {
    expect(resolveBookingPointsBlockView(undefined)).toBe("loading");
    expect(resolveBookingPointsBlockView(undefined, { fetchFailed: true })).toBe("error");
  });

  it("只有 member / new_member 會派點", () => {
    expect(blockShowsPoints("member")).toBe(true);
    expect(blockShowsPoints("new_member")).toBe(true);
    for (const v of ["loading", "hidden", "error", "phone_incomplete", "no_member"] as const) {
      expect(blockShowsPoints(v)).toBe(false);
    }
  });

  it("數字欄位、cap_amount、reward_condition_mode 都解析得到", () => {
    const preview = parseBookingPointsPreview(
      rawPreview({
        eligible: false,
        ineligible_reason: "reward_condition",
        reward_condition_mode: "line_bound",
      }),
    );
    if (!preview.featureEnabled || preview.error !== null) throw new Error("應該是成功的預覽");
    expect(preview.redeem.capAmount).toBe(500);
    expect(preview.redeem.maxAmount).toBe(12);
    expect(preview.rewardConditionMode).toBe("line_bound");
  });
});

describe("describeIneligibleReason(§4.6 第 1 點)", () => {
  it("reward_condition:既有會員寫出需要的條件;新客戶改寫成「新客戶尚未完成驗證…」", () => {
    expect(describeIneligibleReason("reward_condition", "existing", "line_bound")).toBe(
      "此會員未符合商家設定的核發資格條件(需 LINE 已綁定)",
    );
    expect(describeIneligibleReason("reward_condition", "given", "both")).toBe(
      "此會員未符合商家設定的核發資格條件(需 電話已驗證且 LINE 已綁定)",
    );
    expect(describeIneligibleReason("reward_condition", "new", "line_bound")).toBe(
      "新客戶尚未完成驗證,依商家設定這筆訂單不派點",
    );
    expect(describeIneligibleReason("reward_condition", "existing", null)).toBe(
      "此會員未符合商家設定的核發資格條件",
    );
  });

  it("推薦開關兩種", () => {
    expect(describeIneligibleReason("inviter_earning_disabled", "existing", null)).toBe(
      "商家設定推薦者不累積紅利",
    );
    expect(describeIneligibleReason("invitee_earning_disabled", "existing", null)).toBe(
      "商家設定被推薦者不累積紅利",
    );
  });

  it("其他代碼(no_member / feature_disabled / null)⇒ 不顯示原因", () => {
    expect(describeIneligibleReason("no_member", "none", null)).toBeNull();
    expect(describeIneligibleReason(null, "existing", null)).toBeNull();
  });
});

describe("validatePointsOverride(第 13 題:0 ~ 100,000 整數)", () => {
  it("0 與 100,000 通過;100,001 擋下並給白話錯誤", () => {
    expect(validatePointsOverride("0")).toEqual({ ok: true, value: 0 });
    expect(validatePointsOverride("100000")).toEqual({ ok: true, value: 100000 });
    expect(validatePointsOverride("100001")).toEqual({
      ok: false,
      error: POINTS_OVERRIDE_MAX_ERROR,
    });
  });

  it("負數、小數、空白、科學記號都擋下", () => {
    expect(validatePointsOverride("-1").ok).toBe(false);
    expect(validatePointsOverride("1.5").ok).toBe(false);
    expect(validatePointsOverride("").ok).toBe(false);
    expect(validatePointsOverride("1e3").ok).toBe(false);
  });
});

describe("redeemPointsToAmount(第 17 題:無條件捨去到整數元,跟後端同一個算式)", () => {
  it("100 點 = 10 元:55 點 ⇒ 5 元;5000 點 ⇒ 500 元", () => {
    expect(redeemPointsToAmount(55, 100, 10)).toBe(5);
    expect(redeemPointsToAmount(5000, 100, 10)).toBe(500);
    expect(redeemPointsToAmount(9, 100, 10)).toBe(0);
  });

  it("7 點 = 3 元:768 點 ⇒ 329 元(v2.4 裁決 9 的例子)", () => {
    expect(redeemPointsToAmount(768, 7, 3)).toBe(329);
  });

  it("金額單位是小數時不被浮點數誤差少算一元(3 點 = 0.3 元 ⇒ 10 點 = 1 元)", () => {
    // 10 × 0.3 / 3 用浮點數算是 0.9999999999999999 ⇒ floor 會變 0;後端 numeric 算是 1。
    expect(redeemPointsToAmount(10, 3, 0.3)).toBe(1);
  });

  it("比例沒設、點數 <= 0 ⇒ 0", () => {
    expect(redeemPointsToAmount(100, null, 10)).toBe(0);
    expect(redeemPointsToAmount(0, 100, 10)).toBe(0);
  });

  it("至少要幾點才折得到 1 元", () => {
    expect(minimumPointsForOneDollar(100, 10)).toBe(10);
    expect(minimumPointsForOneDollar(7, 3)).toBe(3);
  });
});

describe("validateRedeemPoints(v2.4 裁決 8 ③ / 12)", () => {
  it("合法:回金額;不是點數單位的整數倍 ⇒ 輔助提示(不擋)", () => {
    expect(validateRedeemPoints("55", redeemInfo)).toEqual({
      points: 55,
      amount: 5,
      error: null,
      hint: "以 100 點為單位可折得最划算",
    });
    expect(validateRedeemPoints("500", redeemInfo).hint).toBeNull();
  });

  it("🔴 裁決 12:max_points 不是硬上限 —— 5009 點(> 建議的 5000)換算 500 元 ≤ 上限,照收", () => {
    const result = validateRedeemPoints("5009", redeemInfo);
    expect(result.error).toBeNull();
    expect(result.amount).toBe(500);
  });

  it("換算金額超過比例上限 ⇒ 擋(5100 點 = 510 元 > 500)", () => {
    expect(validateRedeemPoints("5100", redeemInfo).error).toMatch(/本單最多可折抵 \$500/);
  });

  it("超過可用點數 ⇒ 擋", () => {
    expect(validateRedeemPoints("6001", redeemInfo).error).toBe(
      "這位會員目前只有 6000 點,無法折抵 6001 點",
    );
  });

  it("裁決 8 ③:換算不到 1 元 ⇒ 擋,並告訴客服最少要幾點", () => {
    expect(validateRedeemPoints("9", redeemInfo).error).toBe(
      "折抵 9 點換算後不到 1 元(目前 100 點 = 10 元),至少要使用 10 點才折得到 1 元",
    );
  });

  it("0 點 ⇒ 不折抵、沒有錯誤;亂打 ⇒ 錯誤", () => {
    expect(validateRedeemPoints("0", redeemInfo)).toEqual({
      points: 0,
      amount: 0,
      error: null,
      hint: null,
    });
    expect(validateRedeemPoints("abc", redeemInfo).error).not.toBeNull();
  });
});

describe("判斷 24:會員變了 ⇒ 折抵歸零", () => {
  it("同一位 ⇒ 不重設;換人 / 從既有會員變新客戶 ⇒ 重設", () => {
    expect(shouldResetRedeemOnMemberChange("existing:m-1", "existing:m-1", true)).toBe(false);
    expect(shouldResetRedeemOnMemberChange("existing:m-1", "existing:m-2", true)).toBe(true);
    expect(shouldResetRedeemOnMemberChange("existing:m-1", "new:", true)).toBe(true);
  });

  it("第一次載入(編輯單一打開就有原折抵)⇒ 不重設;沒開折抵 ⇒ 不用重設", () => {
    expect(shouldResetRedeemOnMemberChange(null, "given:m-1", true)).toBe(false);
    expect(shouldResetRedeemOnMemberChange("existing:m-1", "existing:m-2", false)).toBe(false);
  });

  it("previewMemberKey:錯誤 / 關閉時不判斷", () => {
    expect(previewMemberKey(parseBookingPointsPreview({ feature_enabled: false }))).toBeNull();
    expect(
      previewMemberKey(parseBookingPointsPreview({ feature_enabled: true, error: "x" })),
    ).toBeNull();
    expect(previewMemberKey(parseBookingPointsPreview(rawPreview()))).toBe("existing:m-1");
  });
});

const original: OriginalBookingPoints = {
  planned: 50,
  plannedAuto: 10,
  overridden: true,
  redeemed: 100,
  redeemAmount: 10,
};

describe("describeEditPointsChange(§2.4 裁決 11 / 第 6 題)", () => {
  it("未人工設定、建議值變了 ⇒ 「派點數已從 A 點變成 B 點」;沒變 ⇒ 不提示", () => {
    const auto = { ...original, planned: 10, overridden: false };
    expect(describeEditPointsChange(auto, 25)).toEqual({
      kind: "auto_changed",
      text: "派點數已從 10 點變成 25 點",
    });
    expect(describeEditPointsChange(auto, 10)).toBeNull();
  });

  it("已人工設定、建議值變了 ⇒ 「系統建議值已從 A 變成 B,目前人工設定為 C」", () => {
    expect(describeEditPointsChange(original, 25)).toEqual({
      kind: "override_kept",
      text: "系統建議值已從 10 點變成 25 點,目前人工設定為 50 點",
    });
    expect(describeEditPointsChange(original, 10)).toBeNull();
  });
});

function formState(overrides: Partial<PointsFormState> = {}): PointsFormState {
  return {
    view: "member",
    overrideEnabled: false,
    overrideValue: null,
    redeemAvailable: true,
    redeemEnabled: false,
    redeemPoints: 0,
    redeemMemberId: "m-1",
    ...overrides,
  };
}

describe("buildCreatePointsParams(§3.3 第 6 步)", () => {
  it("預設:不覆寫、折抵 0", () => {
    expect(buildCreatePointsParams(formState())).toEqual({
      pointsOverride: null,
      pointsRedeemed: 0,
      pointsRedeemMemberId: null,
    });
  });

  it("🔴 v2.4 裁決 22 ①:有折抵 ⇒ 一定帶「要扣誰」(預覽對到的會員);沒折抵 ⇒ null", () => {
    expect(
      buildCreatePointsParams(formState({ redeemEnabled: true, redeemPoints: 55 })),
    ).toMatchObject({ pointsRedeemed: 55, pointsRedeemMemberId: "m-1" });
    expect(buildCreatePointsParams(formState()).pointsRedeemMemberId).toBeNull();
  });

  it("手動修改 0 點也要帶(0 是合法值)", () => {
    expect(
      buildCreatePointsParams(formState({ overrideEnabled: true, overrideValue: 0 }))
        .pointsOverride,
    ).toBe(0);
  });

  it("折抵開著 ⇒ 帶點數;新客戶 / 功能關閉 / 出錯 ⇒ 一律不覆寫、不折抵", () => {
    expect(
      buildCreatePointsParams(formState({ redeemEnabled: true, redeemPoints: 55 })).pointsRedeemed,
    ).toBe(55);
    for (const view of ["hidden", "error", "loading", "no_member", "phone_incomplete"] as const) {
      expect(
        buildCreatePointsParams(
          formState({
            view,
            overrideEnabled: true,
            overrideValue: 30,
            redeemEnabled: true,
            redeemPoints: 55,
          }),
        ),
      ).toEqual({ pointsOverride: null, pointsRedeemed: 0, pointsRedeemMemberId: null });
    }
    expect(
      buildCreatePointsParams(
        formState({ view: "new_member", redeemEnabled: true, redeemPoints: 55 }),
      ).pointsRedeemed,
    ).toBe(0);
  });
});

describe("buildUpdatePointsParams(派工單提醒 1)", () => {
  const notOverridden = { ...original, planned: 10, overridden: false };

  it("🔴 功能關閉 / 預覽出錯 ⇒ 全部「維持」:override null、reset false、redeemed null", () => {
    for (const view of ["hidden", "error", "loading"] as const) {
      expect(
        buildUpdatePointsParams(formState({ view, redeemAvailable: false }), original),
      ).toEqual({
        pointsOverride: null,
        pointsOverrideReset: false,
        pointsRedeemed: null,
        pointsRedeemMemberId: null,
      });
    }
  });

  it("沒改任何東西 ⇒ override null,redeemed 帶表單值(= 原值)", () => {
    expect(
      buildUpdatePointsParams(
        formState({
          overrideEnabled: true,
          overrideValue: 50,
          redeemEnabled: true,
          redeemPoints: 100,
        }),
        original,
      ),
    ).toEqual({
      pointsOverride: null,
      pointsOverrideReset: false,
      pointsRedeemed: 100,
      pointsRedeemMemberId: "m-1",
    });
  });

  it("已人工設定、改了數字 ⇒ 帶新 override", () => {
    expect(
      buildUpdatePointsParams(formState({ overrideEnabled: true, overrideValue: 60 }), original)
        .pointsOverride,
    ).toBe(60);
  });

  it("原本自動、這次開手動修改(就算數字跟原本一樣)⇒ 帶 override", () => {
    expect(
      buildUpdatePointsParams(
        formState({ overrideEnabled: true, overrideValue: 10 }),
        notOverridden,
      ).pointsOverride,
    ).toBe(10);
  });

  it("原本人工設定、這次關掉手動修改(或按「改用建議值」)⇒ reset true、override null", () => {
    expect(buildUpdatePointsParams(formState({ overrideEnabled: false }), original)).toMatchObject({
      pointsOverride: null,
      pointsOverrideReset: true,
    });
  });

  it("折抵開關關掉 ⇒ 0(= 退回);折抵開關沒出現(會員已下架 / 沒會員)⇒ null(= 維持)", () => {
    expect(
      buildUpdatePointsParams(formState({ redeemEnabled: false }), original).pointsRedeemed,
    ).toBe(0);
    expect(
      buildUpdatePointsParams(formState({ redeemAvailable: false }), original).pointsRedeemed,
    ).toBeNull();
    expect(
      buildUpdatePointsParams(formState({ view: "no_member", redeemAvailable: false }), original)
        .pointsRedeemed,
    ).toBeNull();
  });
});

describe("isPointsSubmitBlockedByStalePreview(v2.4 裁決 22 ① (b))", () => {
  const base = {
    previewStale: true,
    view: "member" as const,
    overrideEnabled: false,
    redeemActive: false,
    reviewConfirmNeeded: false,
  };
  it("預覽不是最新 + 折抵開 / 手動派點開 / 要人工確認 ⇒ 擋", () => {
    expect(isPointsSubmitBlockedByStalePreview({ ...base, redeemActive: true })).toBe(true);
    expect(isPointsSubmitBlockedByStalePreview({ ...base, overrideEnabled: true })).toBe(true);
    expect(isPointsSubmitBlockedByStalePreview({ ...base, reviewConfirmNeeded: true })).toBe(true);
  });
  it("沒用到預覽的數字 ⇒ 不擋;預覽已是最新 ⇒ 不擋", () => {
    expect(isPointsSubmitBlockedByStalePreview(base)).toBe(false);
    expect(
      isPointsSubmitBlockedByStalePreview({ ...base, previewStale: false, redeemActive: true }),
    ).toBe(false);
    expect(
      isPointsSubmitBlockedByStalePreview({ ...base, view: "hidden", overrideEnabled: true }),
    ).toBe(false);
  });
});

describe("點數欄位錯誤文案(v2.4 裁決 22 L3)", () => {
  it("小數 / 文字 / 科學記號 ⇒ 「只能填整數」", () => {
    for (const raw of ["1.5", "abc", "1e3"]) {
      expect(validatePointsOverride(raw)).toEqual({ ok: false, error: "只能填整數" });
      expect(validateRedeemPoints(raw, redeemInfo).error).toBe("只能填整數");
    }
  });
});

describe("needsPointsReviewConfirm(§2.5 第 2 點)", () => {
  it("有折扣或自訂總金額、而且區塊在派點 ⇒ 要確認", () => {
    expect(
      needsPointsReviewConfirm({
        view: "member",
        customTotalAmountEnabled: false,
        discountEnabled: true,
      }),
    ).toBe(true);
    expect(
      needsPointsReviewConfirm({
        view: "new_member",
        customTotalAmountEnabled: true,
        discountEnabled: false,
      }),
    ).toBe(true);
    expect(
      needsPointsReviewConfirm({
        view: "member",
        customTotalAmountEnabled: false,
        discountEnabled: false,
      }),
    ).toBe(false);
    expect(
      needsPointsReviewConfirm({
        view: "hidden",
        customTotalAmountEnabled: true,
        discountEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("describeBookingDetailPoints(§4.7 訂單詳情)", () => {
  const booking = {
    status: "completed",
    points_planned: 50,
    points_planned_overridden: true,
    points_redeemed: 100,
    points_redeem_amount_snapshot: "10.00",
    final_amount_snapshot: "1000.00",
  };

  it("預定派點(人工設定)、折抵、實付 = 最終金額 − 折抵", () => {
    const view = describeBookingDetailPoints(booking, null);
    expect(view.show).toBe(true);
    expect(view.plannedText).toBe("50 點(人工設定)");
    expect(view.redeemText).toBe("100 點(−$10)");
    expect(view.paidAmount).toBe(990);
    expect(view.earnedText).toBeNull();
  });

  // #844 §4.8 改寫:文字改由 describeEarnedPoints 產生 ——「已收回」→「已收回 N 點」、
  // 「(已收回 N 點)」→「(曾收回 N 點)」(規格書 §4.8 第 3 點的定稿文字)。
  it("已完成:有效入帳 > 0 ⇒ 「已入帳 N 點」;曾收回 ⇒ 加「(曾收回 N 點)」;有效 0 ⇒ 「已收回 N 點」", () => {
    expect(
      describeBookingDetailPoints(booking, {
        earnedPoints: 50,
        effectivePoints: 50,
        reversedPoints: 0,
      }).earnedText,
    ).toBe("已入帳 50 點");
    expect(
      describeBookingDetailPoints(booking, {
        earnedPoints: 50,
        effectivePoints: 0,
        reversedPoints: 50,
      }).earnedText,
    ).toBe("已收回 50 點");
    expect(
      describeBookingDetailPoints(booking, {
        earnedPoints: 100,
        effectivePoints: 50,
        reversedPoints: 50,
      }).earnedText,
    ).toBe("已入帳 50 點(曾收回 50 點)");
  });

  it("v2.4 裁決 22 L2:從未入帳的已取消單 ⇒ 「已取消,不入帳」(查詢前、查到從未入帳都一樣)", () => {
    expect(describeBookingDetailPoints({ ...booking, status: "cancelled" }, null).earnedText).toBe(
      "已取消,不入帳",
    );
    expect(
      describeBookingDetailPoints(
        { ...booking, status: "cancelled" },
        { earnedPoints: null, effectivePoints: null, reversedPoints: 0 },
      ).earnedText,
    ).toBe("已取消,不入帳");
  });

  it("#844:取消已完成訂單後 ⇒ 「已取消,已收回 N 點」(不再說「不入帳」);有差額再講差額", () => {
    expect(
      describeBookingDetailPoints(
        { ...booking, status: "cancelled" },
        { earnedPoints: 50, effectivePoints: 0, reversedPoints: 50 },
      ).earnedText,
    ).toBe("已取消,已收回 50 點");
    expect(
      describeBookingDetailPoints(
        { ...booking, status: "cancelled" },
        { earnedPoints: 50, effectivePoints: 40, reversedPoints: 10 },
      ).earnedText,
    ).toBe("已取消,已收回 10 點,差額 40 點未收回");
  });

  it("#844:還原後的已確認單 ⇒ 「已收回 N 點」;從未入帳的已確認單 ⇒ 不顯示", () => {
    expect(
      describeBookingDetailPoints(
        { ...booking, status: "accepted" },
        { earnedPoints: 50, effectivePoints: 0, reversedPoints: 50 },
      ).earnedText,
    ).toBe("已收回 50 點");
    expect(
      describeBookingDetailPoints(
        { ...booking, status: "accepted" },
        { earnedPoints: null, effectivePoints: null, reversedPoints: 0 },
      ).earnedText,
    ).toBeNull();
  });

  it("沒派點也沒折抵 ⇒ 不顯示;未完成的單不顯示入帳", () => {
    const empty = {
      ...booking,
      points_planned: 0,
      points_planned_overridden: false,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
    };
    expect(describeBookingDetailPoints(empty, null).show).toBe(false);
    // #844 改寫:原本斷言「accepted + 有效入帳 50 ⇒ 不顯示」。#844 起 accepted 的單若有入帳紀錄,
    // 一定是「完成後被還原」的(會員餘額 0、一點都沒收回):要講清楚「已收回 0 點,差額 50 點未收回」,
    // 不能什麼都不說。從未入帳的已確認單仍不顯示(上一個 it)。
    expect(
      describeBookingDetailPoints(
        { ...booking, status: "accepted" },
        { earnedPoints: 50, effectivePoints: 50, reversedPoints: 0 },
      ).earnedText,
    ).toBe("已收回 0 點,差額 50 點未收回");
    expect(
      describeBookingDetailPoints({ ...booking, status: "accepted" }, null).earnedText,
    ).toBeNull();
  });

  it("#844 批次 4(批次 3 QA 觀察 ①):還原後改單把派點改成 0,仍顯示這一組與舊的收回 / 差額", () => {
    const zeroPlanned = {
      ...booking,
      status: "accepted",
      points_planned: 0,
      points_planned_overridden: false,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
    };
    const view = describeBookingDetailPoints(zeroPlanned, {
      earnedPoints: 50,
      effectivePoints: 40,
      reversedPoints: 10,
    });
    expect(view.show).toBe(true);
    expect(view.plannedText).toBe("0 點");
    expect(view.earnedText).toBe("已收回 10 點,差額 40 點未收回");
    // 從未入帳的派點 0 單:維持不顯示
    expect(
      describeBookingDetailPoints(zeroPlanned, {
        earnedPoints: null,
        effectivePoints: null,
        reversedPoints: 0,
      }).show,
    ).toBe(false);
  });
});

describe("describeEarnedPoints(#844 §4.8 已入帳看淨額)", () => {
  it("從未入帳 ⇒ null(各狀態都一樣)", () => {
    for (const status of ["pending_confirmation", "accepted", "completed", "cancelled"]) {
      expect(
        describeEarnedPoints({ status, earned: null, reversed: 0, effective: null }),
      ).toBeNull();
    }
  });

  it("已完成", () => {
    expect(
      describeEarnedPoints({ status: "completed", earned: 50, reversed: 0, effective: 50 }),
    ).toBe("已入帳 50 點");
    // 完成 → 還原 → 再完成(全額收回後再入帳 50):有效 50、曾收回 50
    expect(
      describeEarnedPoints({ status: "completed", earned: 100, reversed: 50, effective: 50 }),
    ).toBe("已入帳 50 點(曾收回 50 點)");
    // Q11 A 補差額:入帳 50 + 10、收回 10 ⇒ 有效 50(不是最後一筆的 10)
    expect(
      describeEarnedPoints({ status: "completed", earned: 60, reversed: 10, effective: 50 }),
    ).toBe("已入帳 50 點(曾收回 10 點)");
  });

  it("還原後的已確認", () => {
    expect(
      describeEarnedPoints({ status: "accepted", earned: 50, reversed: 50, effective: 0 }),
    ).toBe("已收回 50 點");
    expect(
      describeEarnedPoints({ status: "accepted", earned: 50, reversed: 10, effective: 40 }),
    ).toBe("已收回 10 點,差額 40 點未收回");
  });

  it("取消後的已取消", () => {
    expect(
      describeEarnedPoints({ status: "cancelled", earned: 50, reversed: 50, effective: 0 }),
    ).toBe("已取消,已收回 50 點");
    expect(
      describeEarnedPoints({ status: "cancelled", earned: 50, reversed: 10, effective: 40 }),
    ).toBe("已取消,已收回 10 點,差額 40 點未收回");
  });

  it("有效入帳為 null 或負數時當成 0(防呆,不會顯示「差額 -5 點」)", () => {
    expect(
      describeEarnedPoints({ status: "accepted", earned: 50, reversed: 50, effective: null }),
    ).toBe("已收回 50 點");
    expect(
      describeEarnedPoints({ status: "accepted", earned: 50, reversed: 55, effective: -5 }),
    ).toBe("已收回 55 點");
  });
});
