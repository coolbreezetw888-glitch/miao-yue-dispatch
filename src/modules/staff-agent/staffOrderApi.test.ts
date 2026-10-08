// 客戶端第 3 批(C3-H02 / H03):fetchMerchantStaff 改依順位排序、move_merchant_staff_order 呼叫格式。
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { method: string; args: unknown[] }[] = [];
const rpcMock = vi.fn();

function builder(result: unknown) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order"]) {
    b[m] = (...args: unknown[]) => {
      calls.push({ method: m, args });
      return b;
    };
  }
  b["then"] = (resolve: (v: unknown) => void) => resolve(result);
  return b;
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => builder({ data: [], error: null }),
    rpc: (...args: unknown[]) => rpcMock(...args),
    functions: { invoke: vi.fn() },
    storage: { from: vi.fn() },
  },
}));

const { fetchMerchantStaff, moveMerchantStaffOrder } = await import("./api");
const { useMerchantStaffList } = await import("./context");

beforeEach(() => {
  calls.length = 0;
  rpcMock.mockReset();
});

describe("C3-H03 fetchMerchantStaff 排序", () => {
  it("display_order → created_at → id(跟預約頁 / 行事曆同一套)", async () => {
    await fetchMerchantStaff("m1");
    expect(calls.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual([
      "display_order",
      "created_at",
      "id",
    ]);
  });
});

describe("C3-H02 moveMerchantStaffOrder", () => {
  it("送 p_staff_id / p_direction;edge 不是錯誤", async () => {
    rpcMock.mockResolvedValueOnce({ data: { state: "moved" }, error: null });
    await expect(moveMerchantStaffOrder("s1", "up")).resolves.toBe("moved");
    expect(rpcMock).toHaveBeenCalledWith("move_merchant_staff_order", {
      p_staff_id: "s1",
      p_direction: "up",
    });
    rpcMock.mockResolvedValueOnce({ data: { state: "edge" }, error: null });
    await expect(moveMerchantStaffOrder("s1", "down")).resolves.toBe("edge");
  });

  it("權限錯誤照丟(畫面 toast)", async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: "沒有權限", code: "42501" } });
    await expect(moveMerchantStaffOrder("s1", "up")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("使用者 Q3-c:useMerchantStaffList(後台各處服務人員下拉)也依順位", () => {
  it("只取在職、依 display_order → created_at → id(不再依姓名)", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useMerchantStaffList("m1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls.filter((c) => c.method === "eq").map((c) => c.args)).toEqual([
      ["merchant_id", "m1"],
      ["status", "active"],
    ]);
    expect(calls.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual([
      "display_order",
      "created_at",
      "id",
    ]);
  });
});
