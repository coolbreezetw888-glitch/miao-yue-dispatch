// 客戶端第 3 批(C3-G02):公開函式超過呼叫上限 ⇒ P0001 + hint rate_limited ⇒ 單獨一類(畫面顯示「操作太頻繁」)。
import { describe, expect, it, vi } from "vitest";

const rpcResult = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: async () => rpcResult.value },
}));

const { fetchPublicBookingPage, PublicBookingError, PUBLIC_RATE_LIMITED_MESSAGE } =
  await import("./api");

describe("callRpc 錯誤分類", () => {
  it("P0001 + rate_limited ⇒ kind rate_limited", async () => {
    rpcResult.value = {
      data: null,
      error: { code: "P0001", hint: "rate_limited", message: "操作太頻繁，請稍後再試" },
    };
    await expect(fetchPublicBookingPage("shop")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(PUBLIC_RATE_LIMITED_MESSAGE).toBe("操作太頻繁，請稍後再試");
  });

  it("其他 P0001 仍是 network;22023 是 rejected", async () => {
    rpcResult.value = { data: null, error: { code: "P0001", hint: null } };
    await expect(fetchPublicBookingPage("shop")).rejects.toMatchObject({ kind: "network" });
    rpcResult.value = { data: null, error: { code: "22023", hint: "invalid_items" } };
    const err = await fetchPublicBookingPage("shop").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicBookingError);
    expect((err as InstanceType<typeof PublicBookingError>).kind).toBe("rejected");
  });
});
