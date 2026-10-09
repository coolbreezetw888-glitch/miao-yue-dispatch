// SPECS-INDEX #1025 功能開關 FG1-T03 / FG1-U06 第 4 點:客服權限頁 × 平台功能開關。
//
//   1. 報表匯出中心沒開通 ⇒「報表匯出中心」那一列整列不顯示,其他列照常
//   2. 值保留(T9):頁面不會因為藏起來就去改那一列的權限(不呼叫 setAgentPermissions)
//   3. 開通 ⇒ 那一列照常顯示

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { visibleAgentPermissionSections } from "./types";

const fetchMerchantAgentsMock = vi.fn();
const fetchAgentPermissionsMock = vi.fn();
const setAgentPermissionsMock = vi.fn();
const f = vi.hoisted(() => ({ reportExport: false as boolean | undefined }));

vi.mock("./api", () => ({
  fetchMerchantAgents: (...args: unknown[]) => fetchMerchantAgentsMock(...args),
  fetchAgentPermissions: (...args: unknown[]) => fetchAgentPermissionsMock(...args),
  setAgentPermissions: (...args: unknown[]) => setAgentPermissionsMock(...args),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1" }, isLoading: false }),
}));
vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: {
    onlineBooking: "online_booking",
    dataImport: "data_import",
    reportExport: "report_export",
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => (key === "report_export" ? f.reportExport : true),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./RequireMerchantAdmin", () => ({
  RequireMerchantAdmin: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import AgentPermissionsPage from "./AgentPermissionsPage";

beforeAll(() => {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/agents/agent-1/permissions"]}>
        <Routes>
          <Route path="/app/agents/:agentId/permissions" element={<AgentPermissionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findAllByTestId("permission-switch-title");
  return view;
}

const SECTIONS = visibleAgentPermissionSections();
const REPORT_LABEL = SECTIONS.find((sec) => sec.key === "report_export")!.label;

beforeEach(() => {
  fetchMerchantAgentsMock.mockReset().mockResolvedValue([{ id: "agent-1", name: "小美" }]);
  // 這位客服原本就有報表匯出權限 —— 藏起來之後值要保留。
  fetchAgentPermissionsMock
    .mockReset()
    .mockResolvedValue([{ section_key: "report_export", granted: true }]);
  setAgentPermissionsMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  f.reportExport = false;
});

describe("客服權限頁 × 報表匯出中心功能開關(#1025)", () => {
  it("沒開通 ⇒ 沒有「報表匯出中心」那一列,其他列照常;也不會去改它的值", async () => {
    f.reportExport = false;
    const { container } = await renderPage();
    const titles = screen.getAllByTestId("permission-switch-title").map((el) => el.textContent);
    expect(titles).not.toContain(REPORT_LABEL);
    expect(container.querySelectorAll("main ul > li")).toHaveLength(SECTIONS.length - 1);
    expect(container.querySelector("#agent-permission-switch-report_export")).toBeNull();
    expect(setAgentPermissionsMock).not.toHaveBeenCalled();
  });

  it("讀取中(還不知道)⇒ 那一列也先不顯示", async () => {
    f.reportExport = undefined;
    await renderPage();
    const titles = screen.getAllByTestId("permission-switch-title").map((el) => el.textContent);
    expect(titles).not.toContain(REPORT_LABEL);
  });

  it("開通 ⇒ 那一列照常顯示,而且是原本的值(開)", async () => {
    f.reportExport = true;
    const { container } = await renderPage();
    const titles = screen.getAllByTestId("permission-switch-title").map((el) => el.textContent);
    expect(titles).toContain(REPORT_LABEL);
    expect(container.querySelectorAll("main ul > li")).toHaveLength(SECTIONS.length);
    expect(
      container.querySelector("#agent-permission-switch-report_export")?.getAttribute("data-state"),
    ).toBe("checked");
  });
});
