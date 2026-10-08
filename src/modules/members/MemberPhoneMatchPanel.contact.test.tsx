// 客戶端第 4 批 4-B(C4-K03):建單「客戶電話」打的是第二聯絡人電話 ⇒ 面板常駐 ! 請客服點選那位會員。
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemberPhoneMatchCandidate } from "./types";

const COMPANY: MemberPhoneMatchCandidate = {
  memberId: "m-co",
  name: "某某公司",
  phone: "0227001234",
  lastBookingDate: null,
  isBlacklisted: false,
  blacklistReason: null,
  lastBookingAddress: null,
  matchedContactPhone: "0933111222",
};

vi.mock("./api", () => ({
  useMembersByPhone: () => ({ data: [COMPANY] }),
}));

const { MemberPhoneMatchPanel } = await import("./MemberPhoneMatchPanel");

afterEach(() => cleanup());

describe("MemberPhoneMatchPanel 聯絡人電話", () => {
  it("新增模式:常駐 ! + 只列那位會員(小字「聯絡人電話」);點了帶入", async () => {
    const onApply = vi.fn();
    render(
      <MemberPhoneMatchPanel
        merchantId="mer"
        phone="0933111222"
        mode="create"
        linkedMember={null}
        pendingAttachMember={null}
        onApplyCandidate={onApply}
      />,
    );
    const panel = screen.getByTestId("member-phone-match-contact");
    expect(panel).toHaveTextContent(
      "這支電話是會員「某某公司」的聯絡人電話，請在下方點選這位會員，不要另外建立新會員。",
    );
    expect(screen.getByTestId("member-phone-match-contact-phone")).toHaveTextContent(
      "聯絡人電話 0933111222",
    );
    expect(panel).not.toHaveTextContent("將連結既有客戶");
    await userEvent.setup().click(screen.getByRole("button", { name: /某某公司/ }));
    expect(onApply).toHaveBeenCalledWith(COMPANY);
  });
});
