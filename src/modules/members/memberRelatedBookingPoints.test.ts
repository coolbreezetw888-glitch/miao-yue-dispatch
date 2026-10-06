// 紅利系統重構 批次 7(§4.8):會員詳情頁「相關訂單」的紅利標籤 + 點數異動新類型標籤。
import { describe, expect, it } from "vitest";

import { describeRelatedBookingPointsTags } from "./memberRelatedBookingPoints";
import { MEMBER_POINT_TRANSACTION_TYPE_LABELS, memberPointTransactionTypeLabel } from "./types";

describe("describeRelatedBookingPointsTags(預定 / 已入帳 / 折抵)", () => {
  const base = {
    status: "completed",
    pointsPlanned: 50,
    pointsPlannedOverridden: false,
    earnedPoints: 50,
    reversedPoints: 0,
    pointsRedeemed: 100,
  };

  it("三種都有", () => {
    expect(describeRelatedBookingPointsTags(base)).toEqual([
      "預定 50 點",
      "已入帳 50 點",
      "折抵 100 點",
    ]);
  });

  it("人工設定標出來;人工設定成 0 點也要顯示(那是客服刻意的決定)", () => {
    expect(
      describeRelatedBookingPointsTags({
        ...base,
        pointsPlanned: 0,
        pointsPlannedOverridden: true,
        earnedPoints: null,
        pointsRedeemed: 0,
      }),
    ).toEqual(["預定 0 點(人工設定)"]);
  });

  it("什麼都沒有 ⇒ 「未派點」(不留空白)", () => {
    expect(
      describeRelatedBookingPointsTags({
        ...base,
        pointsPlanned: 0,
        earnedPoints: null,
        pointsRedeemed: 0,
      }),
    ).toEqual(["未派點"]);
  });

  // #844 §4.8:earned_points 現在是本單本會員的有效入帳、reversed_points 是收回數。
  it("#844 完成 → 還原 → 再完成:「已入帳 50 點(曾收回 50 點)」", () => {
    expect(
      describeRelatedBookingPointsTags({
        ...base,
        earnedPoints: 50,
        reversedPoints: 50,
        pointsRedeemed: 0,
      }),
    ).toEqual(["預定 50 點", "已入帳 50 點(曾收回 50 點)"]);
  });

  it("#844 還原後(已確認)/ 取消後(已取消):講已收回與差額,不再寫「已入帳 50 點」", () => {
    expect(
      describeRelatedBookingPointsTags({
        ...base,
        status: "accepted",
        earnedPoints: 0,
        reversedPoints: 50,
        pointsRedeemed: 0,
      }),
    ).toEqual(["預定 50 點", "已收回 50 點"]);
    expect(
      describeRelatedBookingPointsTags({
        ...base,
        status: "cancelled",
        earnedPoints: 40,
        reversedPoints: 10,
        pointsRedeemed: 0,
      }),
    ).toEqual(["預定 50 點", "已取消，已收回 10 點，差額 40 點未收回"]);
  });
});

describe("點數異動類型標籤(§1.5 / §4.8:十種)", () => {
  it("五種新類型的中文標籤照規格書 §1.5(redeem_booking_refund 依 v2.4 裁決 22 L5 改)", () => {
    expect(MEMBER_POINT_TRANSACTION_TYPE_LABELS).toMatchObject({
      referral_bonus: "推薦獎勵(首次)",
      referral_repeat_bonus: "推薦獎勵(後續)",
      redeem_booking: "訂單折抵",
      redeem_booking_refund: "訂單折抵退回",
      earn_booking_reversal: "訂單收回點數",
      referral_bonus_reversal: "推薦獎勵回收",
    });
    expect(Object.keys(MEMBER_POINT_TRANSACTION_TYPE_LABELS)).toHaveLength(10);
  });

  it("不認得的類型顯示原始代碼,不顯示空白", () => {
    expect(memberPointTransactionTypeLabel("something_new")).toBe("something_new");
    expect(memberPointTransactionTypeLabel("redeem_booking")).toBe("訂單折抵");
  });
});
