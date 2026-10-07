// SPECS-INDEX #1005(第 14 批):行事曆時間軸預約卡片 ——「時間標籤 / 虛線 / 名字」,半小時卡片一行。
// 商家端(DraggableBookingBlock)與服務人員端(MyCalendarTimelineView)共用同一個元件與同一支白底樣式。
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BookingBlockContent } from "./BookingBlockContent";
import {
  BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX,
  bookingBlockLayout,
  whiteBookingBlockStyle,
} from "./bookingBlockLayout";

afterEach(cleanup);

describe("bookingBlockLayout(#1005 高度門檻)", () => {
  it("門檻是 44px:半小時(30px)一行;45 分鐘、一小時以上三層", () => {
    expect(BOOKING_BLOCK_STACKED_MIN_HEIGHT_PX).toBe(44);
    expect(bookingBlockLayout(15)).toBe("inline");
    expect(bookingBlockLayout(30)).toBe("inline");
    expect(bookingBlockLayout(43)).toBe("inline");
    expect(bookingBlockLayout(44)).toBe("stacked");
    expect(bookingBlockLayout(45)).toBe("stacked");
    expect(bookingBlockLayout(60)).toBe("stacked");
  });
  it("高度不明 ⇒ 當成放得下(三層)", () => {
    expect(bookingBlockLayout(undefined)).toBe("stacked");
    expect(bookingBlockLayout(Number.NaN)).toBe("stacked");
  });
});

describe("whiteBookingBlockStyle(兩端共用的白底卡片)", () => {
  it("背景換成卡片底色、左邊 4px 用狀態實色、其他邊維持原本的框色", () => {
    expect(
      whiteBookingBlockStyle({
        backgroundColor: "rgba(1,2,3,0.16)",
        color: "#123456",
        borderColor: "rgba(1,2,3,0.4)",
      }),
    ).toEqual({
      color: "#123456",
      borderColor: "rgba(1,2,3,0.4)",
      borderLeftColor: "#123456",
      borderLeftWidth: 4,
      backgroundColor: "var(--card)",
    });
  });
});

describe("BookingBlockContent", () => {
  // 2036-03-12 10:00 台北 = 02:00 UTC
  const START = "2036-03-12T02:00:00+00:00";

  it("一小時卡片:上面時間標籤(台北時間)、中間虛線、下面名字", () => {
    const { container } = render(<BookingBlockContent startAt={START} name="李思賢" height={60} />);
    const root = container.querySelector("[data-booking-block-layout]");
    expect(root?.getAttribute("data-booking-block-layout")).toBe("stacked");
    const children = Array.from(root!.children);
    expect(children[0]!.textContent).toBe("10:00");
    expect(children[1]!.hasAttribute("data-booking-block-divider")).toBe(true);
    expect(children[1]!.className).toContain("border-dashed");
    expect(children[2]!.textContent).toBe("李思賢");
  });

  it("半小時卡片:時間與名字同一行,不畫虛線", () => {
    const { container } = render(
      <BookingBlockContent startAt={START} name="李思賢(協助)" height={30} />,
    );
    expect(
      container
        .querySelector("[data-booking-block-layout]")
        ?.getAttribute("data-booking-block-layout"),
    ).toBe("inline");
    expect(container.querySelector("[data-booking-block-divider]")).toBeNull();
    expect(screen.getByText("10:00")).toBeTruthy();
    expect(screen.getByText("李思賢(協助)")).toBeTruthy();
  });
});
