// SPECS-INDEX #1005(第 14 批):行事曆時間軸預約卡片 ——「時間標籤 / 虛線 / 名字」,半小時卡片一行。
// SPECS-INDEX #1012(第 18 批):整張填滿狀態色 + 白字;時間標籤固定半透明白底深色字;姓名粗體置中;
//   卡片之間留間隔(左右各 3px、上下共 3px)。
// 商家端(DraggableBookingBlock)與服務人員端(MyCalendarTimelineView)共用同一個元件與同一支樣式。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookingBlockContent } from "./BookingBlockContent";
import {
  BOOKING_BLOCK_GAP_BOTTOM_PX,
  BOOKING_BLOCK_GAP_TOP_PX,
  BOOKING_BLOCK_INSET_X_PX,
  BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX,
  bookingBlockLayout,
  bookingBlockVerticalBox,
  filledBookingBlockStyle,
  lightenHex,
  sanitizeHexColor,
} from "./bookingBlockLayout";
import { DEFAULT_BOOKING_STATUS_COLORS, type BookingStatusColorMap } from "./types";

afterEach(cleanup);

describe("bookingBlockLayout(#1005 / #1012 高度門檻)", () => {
  it("門檻是 41px(畫出來的高度):半小時(27px)一行;45 分鐘(42px)、一小時(57px)以上三層", () => {
    expect(BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX).toBe(41);
    expect(bookingBlockLayout(12)).toBe("inline");
    expect(bookingBlockLayout(27)).toBe("inline");
    expect(bookingBlockLayout(40)).toBe("inline");
    expect(bookingBlockLayout(41)).toBe("stacked");
    expect(bookingBlockLayout(bookingBlockVerticalBox(0, 45).height)).toBe("stacked");
    expect(bookingBlockLayout(bookingBlockVerticalBox(0, 30).height)).toBe("inline");
    expect(bookingBlockLayout(bookingBlockVerticalBox(0, 60).height)).toBe("stacked");
  });
  it("高度不明 ⇒ 當成放得下(三層)", () => {
    expect(bookingBlockLayout(undefined)).toBe("stacked");
    expect(bookingBlockLayout(Number.NaN)).toBe("stacked");
  });
});

describe("bookingBlockVerticalBox(#1012 追加:卡片之間的上下間隔)", () => {
  it("上緣往下 1px、下緣往上 2px ⇒ 前後相連的兩張卡片之間空 3px", () => {
    expect(BOOKING_BLOCK_GAP_TOP_PX + BOOKING_BLOCK_GAP_BOTTOM_PX).toBe(3);
    const a = bookingBlockVerticalBox(0, 60);
    const b = bookingBlockVerticalBox(60, 30);
    expect(a).toEqual({ top: 1, height: 57 });
    expect(b).toEqual({ top: 61, height: 27 });
    expect(b.top - (a.top + a.height)).toBe(3);
  });
  it("左右各內縮 3px ⇒ 相鄰兩位服務人員的卡片之間 6px(+ 1px 欄線)", () => {
    expect(BOOKING_BLOCK_INSET_X_PX * 2).toBe(6);
  });
  it("極短的卡片高度不會變成 0 或負數", () => {
    expect(bookingBlockVerticalBox(0, 2).height).toBe(1);
  });
});

describe("sanitizeHexColor(#1012 資安:只接受合法色碼)", () => {
  it("#RRGGBB / #RGB ⇒ 小寫 6 碼", () => {
    expect(sanitizeHexColor("#1C6FD2", "#000000")).toBe("#1c6fd2");
    expect(sanitizeHexColor("  #abc ", "#000000")).toBe("#aabbcc");
  });
  it("其他字串一律改用 fallback,不原樣輸出", () => {
    for (const bad of [
      "red",
      "rgb(1,2,3)",
      "#12345",
      "#1234567",
      "1c6fd2",
      "#1c6fd2; background-image:url(https://evil.example/x)",
      "url(javascript:alert(1))",
      "",
      null,
      undefined,
    ]) {
      expect(sanitizeHexColor(bad, "#ebaa2d")).toBe("#ebaa2d");
    }
  });
});

describe("filledBookingBlockStyle(#1012 整張填色 + 白字)", () => {
  it("底色 = 狀態色原色、白字、左邊 4px 色條與外框 = 往白調亮 45%", () => {
    expect(lightenHex("#1c6fd2", 0.45)).toBe("#82b0e6");
    expect(filledBookingBlockStyle(DEFAULT_BOOKING_STATUS_COLORS, "accepted")).toEqual({
      backgroundColor: "#1c6fd2",
      color: "#ffffff",
      borderColor: "#82b0e6",
      borderLeftColor: "#82b0e6",
      borderLeftWidth: 4,
    });
  });
  it("讀商家自訂色;不合法的色碼退回該狀態的系統預設色", () => {
    const colors: BookingStatusColorMap = {
      ...DEFAULT_BOOKING_STATUS_COLORS,
      completed: "#E83FB8",
      cancelled: "tomato;color:red",
    };
    expect(filledBookingBlockStyle(colors, "completed").backgroundColor).toBe("#e83fb8");
    expect(filledBookingBlockStyle(colors, "cancelled").backgroundColor).toBe(
      DEFAULT_BOOKING_STATUS_COLORS.cancelled,
    );
  });
  it("字色一律白色,不因為底色淺而自動換深色字(使用者裁決)", () => {
    for (const status of ["pending_confirmation", "accepted", "completed", "cancelled"] as const) {
      expect(filledBookingBlockStyle(DEFAULT_BOOKING_STATUS_COLORS, status).color).toBe("#ffffff");
    }
    const pale = { ...DEFAULT_BOOKING_STATUS_COLORS, accepted: "#fffdf5" };
    expect(filledBookingBlockStyle(pale, "accepted").color).toBe("#ffffff");
  });
});

describe("BookingBlockContent", () => {
  // 2036-03-12 10:00 台北 = 02:00 UTC
  const START = "2036-03-12T02:00:00+00:00";

  it("一小時卡片(#1017):上半左上時間標籤、正中間白色虛線、下半粗體名字置中;上下兩半等分", () => {
    const { container } = render(<BookingBlockContent startAt={START} name="李思賢" height={57} />);
    const root = container.querySelector("[data-booking-block-layout]");
    expect(root?.getAttribute("data-booking-block-layout")).toBe("stacked");
    const children = Array.from(root!.children);
    expect(children).toHaveLength(3);
    // 上半部:時間標籤靠左上
    expect(children[0]!.hasAttribute("data-booking-block-top")).toBe(true);
    expect(children[0]!.textContent).toBe("10:00");
    expect(children[0]!.className).toContain("items-start");
    // 中間虛線:不留上下 margin(否則中心會偏)
    expect(children[1]!.hasAttribute("data-booking-block-divider")).toBe(true);
    expect(children[1]!.className).toContain("border-dashed");
    expect(children[1]!.className).toContain("border-[rgba(255,255,255,0.6)]");
    expect(children[1]!.className).not.toMatch(/\bm[ty]?-/);
    // 下半部:姓名上下左右置中
    expect(children[2]!.hasAttribute("data-booking-block-bottom")).toBe(true);
    expect(children[2]!.textContent).toBe("李思賢");
    expect(children[2]!.className).toContain("items-center");
    expect(children[2]!.className).toContain("justify-center");
    // 上下兩半等分(flex-1 + basis-0)⇒ 虛線落在正中間
    for (const half of [children[0]!, children[2]!]) {
      expect(half.className).toContain("flex-1");
      expect(half.className).toContain("basis-0");
    }
    // 上半部不准縮到比時間標籤矮(放不下時寧可把虛線往下推,也不裁切標籤)
    expect(children[0]!.className).not.toContain("min-h-0");
    expect(children[0]!.className).not.toContain("overflow-hidden");
    const name = container.querySelector("[data-booking-block-name]")!;
    expect(name.className).toContain("font-bold");
    expect(name.className).toContain("truncate");
  });

  it("時間標籤固定半透明白底 + 深色字(不跟狀態色走)", () => {
    const { container } = render(<BookingBlockContent startAt={START} name="李思賢" height={57} />);
    const label = container.querySelector("[data-booking-block-time]")!;
    expect(label.className).toContain("bg-[rgba(255,255,255,0.75)]");
    expect(label.className).toContain("text-[#111827]");
    expect(label.className).not.toContain("current");
  });

  it("半小時卡片:時間與名字同一行(名字在剩下空間置中、粗體),不畫虛線", () => {
    const { container } = render(
      <BookingBlockContent startAt={START} name="李思賢(協助)" height={27} />,
    );
    expect(
      container
        .querySelector("[data-booking-block-layout]")
        ?.getAttribute("data-booking-block-layout"),
    ).toBe("inline");
    expect(container.querySelector("[data-booking-block-divider]")).toBeNull();
    expect(screen.getByText("10:00")).toBeTruthy();
    const name = screen.getByText("李思賢(協助)");
    expect(name.className).toContain("font-bold");
    expect(name.parentElement!.className).toContain("justify-center");
    expect(name.parentElement!.className).toContain("flex-1");
  });
});
