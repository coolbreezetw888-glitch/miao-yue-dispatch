// #1035 追加 QA L2:服務人員端「查上個月有沒有獎金方案」那支查詢失敗時不重試,
// 立刻照舊預設(本月 1 號到今天),不要卡骨架好幾秒。用真的 useStaffBonusByRange + react-query
//(QueryClient 預設 retry 3 次),只把 supabase.rpc 換成會失敗的替身,數它被打了幾次。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { rpc: (...args: unknown[]) => rpcMock(...args) },
}));

import { useStaffBonusByRange } from "@/modules/payroll/api";

function wrapper({ children }: { children: ReactNode }) {
  // 不覆寫 retry:用 react-query 預設(3 次),才看得出 retry:false 有沒有生效。
  const client = new QueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useStaffBonusByRange 的 retry 選項", () => {
  it("retry:false ⇒ 失敗只打 1 次、立刻 isError", async () => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(
      () => useStaffBonusByRange("s-1", "2026-09-01", "2026-09-30", { retry: false }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 500 });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it("不傳 options ⇒ 照舊用預設重試(第一次失敗後還沒進 isError)", async () => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ data: null, error: { message: "boom" } });
    const { result } = renderHook(() => useStaffBonusByRange("s-1", "2026-09-01", "2026-09-30"), {
      wrapper,
    });
    await waitFor(() => expect(rpcMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(result.current.isError).toBe(false);
  });
});
