// 客戶端第 4 批 4-B(C4-K03,c4-contract B6-3):會員列表搜尋也比對「第二聯絡人自己的電話」。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rpcCalls: [] as unknown[],
  rpcResult: { data: [] as unknown, error: null as unknown },
  inIds: null as string[] | null,
}));

function row(id: string, name: string, phone: string) {
  return {
    id,
    name,
    phone,
    referral_code: "R",
    points_balance: 0,
    status: "active",
    tier_id: null,
    is_blacklisted: false,
    identity_verified_at: null,
  };
}

vi.mock("@/integrations/supabase/client", () => {
  function builder() {
    let ids: string[] | null = null;
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "order", "or", "range"]) b[m] = () => b;
    b["in"] = (_col: string, v: string[]) => {
      ids = v;
      state.inIds = v;
      return b;
    };
    b["then"] = (resolve: (v: unknown) => unknown) =>
      resolve(
        ids
          ? { data: ids.map((id) => row(id, "某某公司", "0227001234")), error: null }
          : { data: [row("m1", "王小明", "0933111999")], error: null },
      );
    return b;
  }
  return {
    supabase: {
      from: () => builder(),
      rpc: async (fn: string, args: unknown) => {
        state.rpcCalls.push([fn, args]);
        return state.rpcResult;
      },
    },
  };
});

const { contactPhoneSearchDigits, fetchMerchantMembersList } = await import("./api");

beforeEach(() => {
  state.rpcCalls = [];
  state.rpcResult = { data: [], error: null };
  state.inIds = null;
});

describe("會員列表搜尋聯絡人電話", () => {
  it("數字 4 碼以上才比對", () => {
    expect(contactPhoneSearchDigits("王小明")).toBeNull();
    expect(contactPhoneSearchDigits("093")).toBeNull();
    expect(contactPhoneSearchDigits("0933-111")).toBe("0933111");
  });

  it("比對到的會員補進名單,列上「聯絡人電話」;原本就在名單的也標出", async () => {
    state.rpcResult = {
      data: [
        { member_id: "m-co", contact_phone: "0933111222" },
        { member_id: "m1", contact_phone: "0933111000" },
      ],
      error: null,
    };
    const list = await fetchMerchantMembersList("mer", "0933111");
    expect(state.rpcCalls).toEqual([
      ["search_members_by_contact_phone", { p_merchant_id: "mer", p_term: "0933111" }],
    ]);
    expect(state.inIds).toEqual(["m-co"]);
    expect(list.map((m) => [m.id, m.matchedContactPhone])).toEqual([
      ["m1", "0933111000"],
      ["m-co", "0933111222"],
    ]);
  });

  it("比對聯絡人電話失敗 ⇒ 不擋名單(照舊列出)", async () => {
    state.rpcResult = { data: null, error: { message: "boom" } };
    const list = await fetchMerchantMembersList("mer", "0933111");
    expect(list.map((m) => m.id)).toEqual(["m1"]);
    expect(list[0]!.matchedContactPhone).toBeUndefined();
  });

  it("沒有搜尋字 ⇒ 不比對", async () => {
    await fetchMerchantMembersList("mer");
    expect(state.rpcCalls).toEqual([]);
  });
});
