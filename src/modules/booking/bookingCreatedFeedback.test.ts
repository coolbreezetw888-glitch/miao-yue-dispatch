// SPECS-INDEX #915 / #916(規格書 §12.1、§12.3、§12.6):新增模式 memberId 一律 null、
// 建單成功提示框兩種會員行文案。
import { describe, expect, it } from "vitest";

import {
  BOOKING_CREATED_TOAST_DURATION_MS,
  buildBookingCreatedToast,
  resolveSubmitMemberId,
} from "./bookingCreatedFeedback";

describe("resolveSubmitMemberId(§12.1 + §12.7)", () => {
  const lee = {
    id: "member-lee",
    name: "李小華",
    phone: "0903-111-111",
    isBlacklisted: false,
    blacklistReason: null,
  };

  it("🔴 新增模式一律 null —— 就算有已連結 / 點選過的會員也不送(會員連結只由送出當下的電話決定)", () => {
    expect(
      resolveSubmitMemberId({
        isEdit: false,
        linkedMember: { id: "member-1" },
        pendingAttachMember: lee,
        customerPhone: "0903111111",
      }),
    ).toBeNull();
  });

  it("① 編輯、已連結 → 原 id(跟改版前 member?.id ?? null 相同)", () => {
    expect(
      resolveSubmitMemberId({
        isEdit: true,
        linkedMember: { id: "member-1" },
        pendingAttachMember: null,
        customerPhone: "0912345678",
      }),
    ).toBe("member-1");
  });

  it("② 編輯、未連結、沒點選 → null(電話完全相符也不會自動補掛)", () => {
    expect(
      resolveSubmitMemberId({
        isEdit: true,
        linkedMember: null,
        pendingAttachMember: null,
        customerPhone: "0903111111",
      }),
    ).toBeNull();
  });

  it("③ 編輯、未連結、點選後電話一致(正規化後比對)→ 該會員 id", () => {
    expect(
      resolveSubmitMemberId({
        isEdit: true,
        linkedMember: null,
        pendingAttachMember: lee,
        customerPhone: "(0903)111 111",
      }),
    ).toBe("member-lee");
  });

  it("④ 🔴 編輯、未連結、點選後又改了電話 → null(不可以把 A 的會員掛到電話是 B 的訂單上)", () => {
    expect(
      resolveSubmitMemberId({
        isEdit: true,
        linkedMember: null,
        pendingAttachMember: lee,
        customerPhone: "0903222222",
      }),
    ).toBeNull();
  });

  it("點選的會員沒有電話 → 不補掛", () => {
    expect(
      resolveSubmitMemberId({
        isEdit: true,
        linkedMember: null,
        pendingAttachMember: { ...lee, phone: null },
        customerPhone: "",
      }),
    ).toBeNull();
  });
});

describe("buildBookingCreatedToast(#916;紅利行見下一組)", () => {
  // 紅利系統重構 批次 7:型別多了三個紅利快照欄位。這一組全部帶 0 = 「這筆沒有派點、沒有折抵」,
  // 原本的斷言(只有會員行 + 金額行)維持不變 —— 0 點時本來就不該出現紅利行。
  const base = {
    final_amount_snapshot: 1200,
    points_planned: 0,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
  };

  it("自動建立會員:標題 + 「已自動建立會員:{會員姓名}」+ 金額", () => {
    expect(
      buildBookingCreatedToast({
        ...base,
        member_auto_created: true,
        member_id: "m-1",
        member_name_snapshot: "王小明",
      }),
    ).toEqual({
      title: "已送出訂單(待確認)",
      lines: ["已自動建立會員:王小明", "訂單金額 $1,200"],
    });
  });

  it("連結既有會員:用**會員的姓名**(快照),不是訂單這次填的姓名", () => {
    const content = buildBookingCreatedToast({
      ...base,
      member_auto_created: false,
      member_id: "m-2",
      member_name_snapshot: "李小華(會員原本的名字)",
    });
    expect(content.lines).toEqual(["已連結既有會員:李小華(會員原本的名字)", "訂單金額 $1,200"]);
  });

  it("沒有會員(理論上新流程不會發生)⇒ 只有金額那一行,不捏造會員行", () => {
    expect(
      buildBookingCreatedToast({
        ...base,
        member_auto_created: false,
        member_id: null,
        member_name_snapshot: null,
      }).lines,
    ).toEqual(["訂單金額 $1,200"]);
  });

  it("金額用 formatAmount(四捨五入、千分位);0 點、沒折抵時整則沒有任何紅利 / 點數字樣", () => {
    const content = buildBookingCreatedToast({
      ...base,
      final_amount_snapshot: 12345.6,
      member_auto_created: true,
      member_id: "m-1",
      member_name_snapshot: "王小明",
    });
    expect(content.lines).toContain("訂單金額 $12,346");
    expect(JSON.stringify(content)).not.toMatch(/紅利|點數|計算中/);
  });

  it("秒數是 6 秒", () => {
    expect(BOOKING_CREATED_TOAST_DURATION_MS).toBe(6000);
  });
});

describe("buildBookingCreatedToast 紅利行(紅利系統重構 §4.11)", () => {
  const base = {
    final_amount_snapshot: 1000,
    member_auto_created: false,
    member_id: "m-1",
    member_name_snapshot: "王小明",
    points_planned: 0,
    points_redeemed: 0,
    points_redeem_amount_snapshot: 0,
  };

  it("points_planned = 0 ⇒ 不出現第 3 行", () => {
    expect(buildBookingCreatedToast(base).lines).toEqual([
      "已連結既有會員:王小明",
      "訂單金額 $1,000",
    ]);
  });

  it("points_planned > 0 ⇒ 第 3 行,而且一定帶「(訂單完成後入帳)」", () => {
    const lines = buildBookingCreatedToast({ ...base, points_planned: 12 }).lines;
    expect(lines).toEqual([
      "已連結既有會員:王小明",
      "訂單金額 $1,000",
      "紅利點數 12 點(訂單完成後入帳)",
    ]);
  });

  it("有折抵 ⇒ 第 4 行,實付 = 最終金額 − 折抵金額;「訂單金額」那一行仍是折抵前金額", () => {
    const lines = buildBookingCreatedToast({
      ...base,
      points_planned: 50,
      points_redeemed: 55,
      points_redeem_amount_snapshot: 5,
    }).lines;
    expect(lines).toEqual([
      "已連結既有會員:王小明",
      "訂單金額 $1,000",
      "紅利點數 50 點(訂單完成後入帳)",
      "紅利折抵 55 點(−$5),實付 $995",
    ]);
  });

  it("有折抵但派 0 點 ⇒ 只有第 4 行,不出現第 3 行", () => {
    const lines = buildBookingCreatedToast({
      ...base,
      points_redeemed: 100,
      points_redeem_amount_snapshot: 10,
    }).lines;
    expect(lines).toEqual([
      "已連結既有會員:王小明",
      "訂單金額 $1,000",
      "紅利折抵 100 點(−$10),實付 $990",
    ]);
  });

  it("沒有會員 ⇒ 第 1 行照舊不出現(紅利行只看快照)", () => {
    const lines = buildBookingCreatedToast({
      ...base,
      member_id: null,
      member_name_snapshot: null,
    }).lines;
    expect(lines).toEqual(["訂單金額 $1,000"]);
  });
});
