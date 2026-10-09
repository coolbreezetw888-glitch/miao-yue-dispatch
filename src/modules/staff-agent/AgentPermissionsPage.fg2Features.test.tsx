// SPECS-INDEX #1025 功能開關 第 2 批 FG2-U01:客服權限頁 × LINE 通知 / 再行銷通知 / 手機推播通知。
//
//   1. LINE 通知關(再行銷跟著關)⇒「LINE 通知設定」「再行銷通知」兩列不顯示;推播那列照常
//   2. 只關再行銷 ⇒ 只有「再行銷通知」那列不顯示
//   3. 手機推播關 ⇒「推播通知設定」那列不顯示
//   4. 值保留(T9):藏起來不會去改權限(不呼叫 setAgentPermissions)
//   5. 全開 ⇒ 全部照常,而且是原本的值

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { visibleAgentPermissionSections } from "./types";

const fetchMerchantAgentsMock = vi.fn();
const fetchAgentPermissionsMock = vi.fn();
const setAgentPermissionsMock = vi.fn();
const f = vi.hoisted(() => ({ features: {} as Record<string, boolean | undefined> }));

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
    lineNotifications: "line_notifications",
    lineMarketing: "line_marketing",
    pushNotifications: "push_notifications",
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: (key: string) => f.features[key],
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
const labelOf = (key: string) => SECTIONS.find((sec) => sec.key === key)!.label;
const LINE_LABEL = labelOf("line_notification");
const MARKETING_LABEL = labelOf("line_marketing");
const PUSH_LABEL = labelOf("push_notification");

const ALL_ON = {
  online_booking: true,
  data_import: true,
  report_export: true,
  line_notifications: true,
  line_marketing: true,
  push_notifications: true,
};

beforeEach(() => {
  fetchMerchantAgentsMock.mockReset().mockResolvedValue([{ id: "agent-1", name: "小美" }]);
  // 這位客服原本三把鑰匙都開著 —— 藏起來之後值要保留。
  fetchAgentPermissionsMock.mockReset().mockResolvedValue([
    { section_key: "line_notification", granted: true },
    { section_key: "line_marketing", granted: true },
    { section_key: "push_notification", granted: true },
  ]);
  setAgentPermissionsMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  f.features = {};
});

function titles(): (string | null)[] {
  return screen.getAllByTestId("permission-switch-title").map((el) => el.textContent);
}

describe("客服權限頁 × LINE / 再行銷 / 推播功能開關(#1025 FG2)", () => {
  it("LINE 通知關(再行銷跟著關)⇒ 兩列不顯示,推播照常;不改值", async () => {
    f.features = { ...ALL_ON, line_notifications: false, line_marketing: false };
    const { container } = await renderPage();
    expect(titles()).not.toContain(LINE_LABEL);
    expect(titles()).not.toContain(MARKETING_LABEL);
    expect(titles()).toContain(PUSH_LABEL);
    expect(container.querySelectorAll("main ul > li")).toHaveLength(SECTIONS.length - 2);
    expect(setAgentPermissionsMock).not.toHaveBeenCalled();
  });

  it("只關再行銷 ⇒ 只有那一列不顯示", async () => {
    f.features = { ...ALL_ON, line_marketing: false };
    const { container } = await renderPage();
    expect(titles()).toContain(LINE_LABEL);
    expect(titles()).not.toContain(MARKETING_LABEL);
    expect(container.querySelectorAll("main ul > li")).toHaveLength(SECTIONS.length - 1);
  });

  it("手機推播關 ⇒「推播通知設定」那一列不顯示", async () => {
    f.features = { ...ALL_ON, push_notifications: false };
    await renderPage();
    expect(titles()).not.toContain(PUSH_LABEL);
    expect(titles()).toContain(LINE_LABEL);
  });

  it("全開 ⇒ 三列照常顯示,而且是原本的值(開)", async () => {
    f.features = { ...ALL_ON };
    const { container } = await renderPage();
    expect(container.querySelectorAll("main ul > li")).toHaveLength(SECTIONS.length);
    for (const key of ["line_notification", "line_marketing", "push_notification"]) {
      expect(
        container.querySelector(`#agent-permission-switch-${key}`)?.getAttribute("data-state"),
      ).toBe("checked");
    }
  });
});
