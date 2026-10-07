// 客服權限設定頁(SPECS-INDEX #990,第 11 批 C 項):每項說明收進名稱旁的「?」。
//
// 驗證(規格書 .project/specs/改掛會員與預設文案全形-第11批.md §3.1~§3.4、§5.2):
//   1. 每一列只剩名稱 + `?` + 開關,說明不常駐;`?` 的 aria-label =「說明：{名稱}」。
//   2. 點 `?` 跳出的說明 = types.ts 的說明全文(已改半形括號 / 斜線)。
//   3. 🔴 點 `?` 不會呼叫 setAgentPermission(不會順便切換開關)。
//   4. 每個開關的無障礙名稱 = 名稱(改版前 Switch 沒有 label)。
//   5. 保留 `main ul > li` 結構(e2e 用它數列數)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { visibleAgentPermissionSections } from "./types";

const fetchMerchantAgentsMock = vi.fn();
const fetchAgentPermissionsMock = vi.fn();
const setAgentPermissionMock = vi.fn();

vi.mock("./api", () => ({
  fetchMerchantAgents: (...args: unknown[]) => fetchMerchantAgentsMock(...args),
  fetchAgentPermissions: (...args: unknown[]) => fetchAgentPermissionsMock(...args),
  setAgentPermission: (...args: unknown[]) => setAgentPermissionMock(...args),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1" }, isLoading: false }),
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

describe("AgentPermissionsPage 說明收進「?」(#990)", () => {
  beforeEach(() => {
    fetchMerchantAgentsMock.mockReset().mockResolvedValue([{ id: "agent-1", name: "小美" }]);
    fetchAgentPermissionsMock
      .mockReset()
      .mockResolvedValue([{ section_key: "orders", granted: true }]);
    setAgentPermissionMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  it("每一列:名稱 + `?` + 開關;說明不常駐;開關的無障礙名稱 = 名稱", async () => {
    const { container } = await renderPage();
    const rows = container.querySelectorAll("main ul > li");
    expect(rows).toHaveLength(SECTIONS.length);
    expect(screen.getAllByTestId("permission-switch-title").map((el) => el.textContent)).toEqual(
      SECTIONS.map((s) => s.label),
    );
    for (const s of SECTIONS) {
      expect(screen.queryByText(s.description)).toBeNull();
      const trigger = screen.getByRole("button", { name: `說明：${s.label}` });
      expect(trigger).toHaveAttribute("data-testid", `permission-help-trigger-${s.key}`);
      expect(screen.getByRole("switch", { name: s.label })).toBeInTheDocument();
    }
    expect(screen.getByRole("switch", { name: "訂單管理" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("點 `?` 跳出完整說明(半形括號);🔴 不會切換開關", async () => {
    const user = userEvent.setup();
    await renderPage();
    const orders = SECTIONS.find((s) => s.key === "orders")!;
    await user.click(screen.getByRole("button", { name: `說明：${orders.label}` }));
    const popover = await screen.findByTestId("permission-help-popover");
    expect(popover).toHaveTextContent(orders.description);
    expect(
      within(popover).getByText(/使用會員點數折抵\(紅利點數功能開啟時\)。/),
    ).toBeInTheDocument();
    await user.click(popover);

    expect(setAgentPermissionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: orders.label })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("點開關本身仍會送出權限變更", async () => {
    const user = userEvent.setup();
    await renderPage();
    const members = SECTIONS.find((s) => s.key === "members")!;
    await user.click(screen.getByRole("switch", { name: members.label }));
    expect(setAgentPermissionMock).toHaveBeenCalledWith("agent-1", "members", true);
  });
});
