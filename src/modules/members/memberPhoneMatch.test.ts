// SPECS-INDEX #915 / #936(規格書 §12.2、§12.6):建單面板三種狀態的判斷 + 點選候選時三欄帶入。
import { describe, expect, it } from "vitest";

import {
  applyCandidatePrefill,
  deriveEditLinkedPanelState,
  derivePhoneMatchPanelState,
  normalizeCustomerPhone,
  relinkConsequenceText,
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

// SPECS-INDEX #939(第 11 批 A,規格書 §1.7):已連結會員的編輯單,面板五種狀態。
describe("deriveEditLinkedPanelState(#939 E0~E4)", () => {
  const base = { originalPhone: "0912345678", linkedMemberId: "m-orig" };
  const other = candidate({ memberId: "m-other", name: "李小華", phone: "0933111222" });
  const self = candidate({ memberId: "m-orig", name: "王小明", phone: "0955000111" });

  it("E0:電話沒改,或只改格式 ⇒ unchanged", () => {
    for (const phone of ["0912345678", "0912-345-678", "0912 345 678"]) {
      expect(
        deriveEditLinkedPanelState({ ...base, phone, phoneComplete: true, candidates: undefined }),
      ).toEqual({ kind: "unchanged" });
    }
  });

  it("E1:改了但還沒填完整 ⇒ 有候選列 typing,沒候選 hidden", () => {
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "0933",
        phoneComplete: false,
        candidates: [other],
      }),
    ).toEqual({ kind: "typing", candidates: [other] });
    expect(
      deriveEditLinkedPanelState({ ...base, phone: "0933", phoneComplete: false, candidates: [] }),
    ).toEqual({ kind: "hidden" });
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "",
        phoneComplete: false,
        candidates: undefined,
      }),
    ).toEqual({ kind: "hidden" });
  });

  it("E2:完整電話完全相等另一位會員 ⇒ relink", () => {
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "0933-111-222",
        phoneComplete: true,
        candidates: [other],
      }),
    ).toEqual({ kind: "relink", match: other });
  });

  it("E3:完全相等的那位就是原會員 ⇒ unchanged", () => {
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "0955000111",
        phoneComplete: true,
        candidates: [self],
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("E4:完整電話、沒有完全相等的會員(只有開頭相符也算沒有)⇒ create", () => {
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "0933111000",
        phoneComplete: true,
        candidates: [],
      }),
    ).toEqual({ kind: "create" });
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "0933111000",
        phoneComplete: true,
        candidates: [other],
      }),
    ).toEqual({ kind: "create" });
  });

  it("完整電話但候選還沒查回來 ⇒ hidden(不先講「建立新會員」再跳成「改掛」)", () => {
    expect(
      deriveEditLinkedPanelState({
        ...base,
        phone: "0933111222",
        phoneComplete: true,
        candidates: undefined,
      }),
    ).toEqual({ kind: "hidden" });
  });
});

describe("relinkConsequenceText(#939 後果 `!` 文案逐字)", () => {
  it("原單有折抵", () => {
    expect(relinkConsequenceText("王小明", 30)).toBe(
      "儲存後，這筆訂單的紅利改算給新的會員。原會員「王小明」的紅利折抵 30 點會全部退回給他，派點依新會員重新計算。",
    );
  });
  it("原單沒折抵", () => {
    expect(relinkConsequenceText("王小明", 0)).toBe(
      "儲存後，這筆訂單的紅利改算給新的會員，派點依新會員重新計算。",
    );
  });
});
