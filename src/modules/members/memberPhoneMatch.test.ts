// SPECS-INDEX #915 / #936(規格書 §12.2、§12.6):建單面板三種狀態的判斷 + 點選候選時三欄帶入。
import { describe, expect, it } from "vitest";

import {
  applyCandidatePrefill,
  derivePhoneMatchPanelState,
  normalizeCustomerPhone,
} from "./memberPhoneMatch";
import type { MemberPhoneMatchCandidate } from "./types";

function candidate(overrides: Partial<MemberPhoneMatchCandidate> = {}): MemberPhoneMatchCandidate {
  return {
    memberId: "m-1",
    name: "王小明",
    phone: "0912345678",
    lastBookingDate: null,
    isBlacklisted: false,
    blacklistReason: null,
    lastBookingAddress: null,
    ...overrides,
  };
}

describe("normalizeCustomerPhone —— 逐字對應後端 private.normalize_phone", () => {
  it.each([
    ["0912-345-678", "0912345678"],
    ["(09)12345678", "0912345678"],
    [" 0912 345 678 ", "0912345678"],
    ["02-1234-5678#123", "0212345678"], // 分機不參與比對(在 # 處截斷)
    ["#123", null], // 只有分機、沒有號碼 ⇒ 不比對
    ["", null],
    ["abc", null],
  ])("%s → %s", (input, expected) => {
    expect(normalizeCustomerPhone(input)).toBe(expected);
  });

  it("null / undefined → null", () => {
    expect(normalizeCustomerPhone(null)).toBeNull();
    expect(normalizeCustomerPhone(undefined)).toBeNull();
  });
});

describe("derivePhoneMatchPanelState —— 面板三種狀態(§12.2)", () => {
  it("A:沒有候選(含查詢中 undefined、不足 4 位時後端回的空陣列)⇒ hidden", () => {
    expect(derivePhoneMatchPanelState("0912", [])).toEqual({ kind: "hidden" });
    expect(derivePhoneMatchPanelState("0912", undefined)).toEqual({ kind: "hidden" });
    expect(derivePhoneMatchPanelState("", null)).toEqual({ kind: "hidden" });
  });

  it("B:有候選但沒有任何一位電話完全相等 ⇒ prefix,候選全部列出", () => {
    const list = [
      candidate({ memberId: "a", phone: "0903111111" }),
      candidate({ memberId: "b", phone: "0903222222" }),
    ];
    const state = derivePhoneMatchPanelState("0903", list);
    expect(state.kind).toBe("prefix");
    expect(state.kind === "prefix" && state.candidates.map((c) => c.memberId)).toEqual(["a", "b"]);
  });

  it("C:候選中有一位電話完全相等 ⇒ exact,只回那一位", () => {
    const list = [
      candidate({ memberId: "exact", name: "李小華", phone: "0903111111" }),
      candidate({ memberId: "other", phone: "09031111119" }),
    ];
    const state = derivePhoneMatchPanelState("0903111111", list);
    expect(state).toEqual({ kind: "exact", match: list[0] });
  });

  it("C:完全相等用正規化後比對(分隔符號、分機不影響),而且不假設它排在第一筆", () => {
    const list = [
      candidate({ memberId: "prefix-only", phone: "0212345678999" }),
      candidate({ memberId: "exact", phone: "02-1234-5678" }),
    ];
    const state = derivePhoneMatchPanelState("(02)1234 5678#12", list);
    expect(state.kind === "exact" && state.match.memberId).toBe("exact");
  });

  it("候選的電話是 null 時不會被當成完全相等", () => {
    const state = derivePhoneMatchPanelState("0912345678", [candidate({ phone: null })]);
    expect(state.kind).toBe("prefix");
  });
});

describe("applyCandidatePrefill —— 點選候選時三欄帶入(#936)", () => {
  const typed = {
    customerPhone: "0903",
    customerName: "客服先打的名字",
    customerAddress: "先打的地址",
  };

  it("需要地址的產業:電話、姓名、地址三欄都帶入,而且會覆蓋原本打的字", () => {
    const next = applyCandidatePrefill(
      typed,
      candidate({ phone: "0903111111", name: "李小華", lastBookingAddress: "台北市信義路 1 號" }),
      true,
    );
    expect(next).toEqual({
      customerPhone: "0903111111",
      customerName: "李小華",
      customerAddress: "台北市信義路 1 號",
    });
  });

  it("不需要地址的產業(到店服務):地址欄原封不動,即使會員有地址", () => {
    const next = applyCandidatePrefill(
      typed,
      candidate({ phone: "0903111111", name: "李小華", lastBookingAddress: "台北市信義路 1 號" }),
      false,
    );
    expect(next.customerAddress).toBe("先打的地址");
    expect(next.customerName).toBe("李小華");
    expect(next.customerPhone).toBe("0903111111");
  });

  it("需要地址的產業但會員沒有地址(null / 空白)⇒ 不動地址欄", () => {
    expect(
      applyCandidatePrefill(typed, candidate({ lastBookingAddress: null }), true).customerAddress,
    ).toBe("先打的地址");
    expect(
      applyCandidatePrefill(typed, candidate({ lastBookingAddress: "   " }), true).customerAddress,
    ).toBe("先打的地址");
  });

  it("會員電話萬一是空的 ⇒ 保留欄位原本的電話,不清空", () => {
    expect(applyCandidatePrefill(typed, candidate({ phone: null }), false).customerPhone).toBe(
      "0903",
    );
  });
});
