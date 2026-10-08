// SPECS-INDEX #977 第 4 批(2026-10-06):服務人員接單確認相關的畫面文字守門。
// 規格書 .project/specs/服務人員接單確認-第4批.md 第四節第 4、5 點、第五節第 1 點、第六節(文案守門,全形標點)。
import { describe, expect, it } from "vitest";

import { buildBookingCreatedToast } from "@/modules/booking/bookingCreatedFeedback";
import { STAFF_BOOLEAN_PERMISSION_FIELDS } from "@/modules/staff-agent/types";
import { readSourceWithoutComments } from "@/test/sourceScan";

/** 半形 , : ( ) ;(金額千分位、時間冒號不在這幾段文字裡,所以直接全擋)。 */
const HALF_WIDTH = /[,:();]/;

describe("#977 第 4 批 文案", () => {
  it("建單表單說明逐字(全形標點)", () => {
    const src = readSourceWithoutComments("src/modules/booking/CalendarPage.tsx");
    const text =
      "建立後的狀態依服務人員設定：需要服務人員確認的是「待確認」，設定「商家後台確認後直接接單」的會直接是「已確認」。";
    expect(src).toContain(`"${text}"`);
    expect(HALF_WIDTH.test(text)).toBe(false);
    expect(src).not.toContain("建立後狀態是「待確認」");
  });

  it("建單成功提示的標題依實際狀態(全形括號)", () => {
    const base = {
      member_auto_created: false,
      member_id: null,
      member_name_snapshot: null,
      final_amount_snapshot: 100,
      points_planned: 0,
      points_redeemed: 0,
      points_redeem_amount_snapshot: 0,
    };
    const pending = buildBookingCreatedToast({ ...base, status: "pending_confirmation" }).title;
    const accepted = buildBookingCreatedToast({ ...base, status: "accepted" }).title;
    expect([pending, accepted]).toEqual(["已送出訂單（待確認）", "已送出訂單（已確認）"]);
    expect([pending, accepted].some((t) => HALF_WIDTH.test(t))).toBe(false);
  });

  it("「商家後台確認後直接接單」:拿掉「即將推出」,說明符合新行為、全形標點、沒有內部用語", () => {
    const field = STAFF_BOOLEAN_PERMISSION_FIELDS.find(
      (f) => f.key === "direct_accept_after_merchant_confirm",
    );
    expect(field?.comingSoon).toBeFalsy();
    expect(field?.description).toBe(
      "開啟後，商家管理員或客服在後台建立訂單、指派這位服務人員為主要服務人員時，訂單會直接成為「已確認」，不用他再按確認。關閉時，新訂單是「待確認」，要等他在自己的行事曆按「確認接單」。",
    );
    expect(HALF_WIDTH.test(field?.description ?? "")).toBe(false);
    expect(field?.description).not.toMatch(/模組|規格書|accepted|pending|師傅/);
  });

  it("「客戶預約自動接受」:客戶端第 3 批(C3-E02)起生效,拿掉即將推出", () => {
    expect(
      STAFF_BOOLEAN_PERMISSION_FIELDS.find((f) => f.key === "auto_accept_booking")?.comingSoon,
    ).toBeFalsy();
  });

  it("報表匯出中心訂單狀態篩選:「已確認」,不再有「已接受」", () => {
    const src = readSourceWithoutComments("src/modules/data-tools/ReportExportCenterPage.tsx");
    expect(src).toContain('{ value: "accepted", label: "已確認" }');
    expect(src).not.toContain("已接受");
  });

  it("服務人員端詳情按鈕與提示文字", () => {
    const src = readSourceWithoutComments("src/modules/staff-portal/MyBookingDetailDialog.tsx");
    expect(src).toContain("確認接單");
    expect(src).toContain('"已確認接單"');
    expect(src).toContain('"確認接單失敗"');
  });
});
