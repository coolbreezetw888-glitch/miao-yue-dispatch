// 客服權限設定頁(SPECS-INDEX #990,第 11 批 C 項):每項說明收進名稱旁的「?」。
//
// 驗證(規格書 .project/specs/改掛會員與預設文案全形-第11批.md §3.1~§3.4、§5.2):
//   1. 每一列只剩名稱 + `?` + 開關,說明不常駐;`?` 的 aria-label =「說明：{名稱}」。
//   2. 點 `?` 跳出的說明 = types.ts 的說明全文(已改半形括號 / 斜線)。
//   3. 🔴 點 `?` 不會呼叫 setAgentPermissions(不會順便切換開關)。
//      (第 11 批 E 起本頁寫入改走 setAgentPermissions,下面「第 11 批 E」段落另有完整相依權限測試)
//   4. 每個開關的無障礙名稱 = 名稱(改版前 Switch 沒有 label)。
//   5. 保留 `main ul > li` 結構(e2e 用它數列數)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { visibleAgentPermissionSections } from "./types";

const fetchMerchantAgentsMock = vi.fn();
const fetchAgentPermissionsMock = vi.fn();
const setAgentPermissionsMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock("./api", () => ({
  fetchMerchantAgents: (...args: unknown[]) => fetchMerchantAgentsMock(...args),
  fetchAgentPermissions: (...args: unknown[]) => fetchAgentPermissionsMock(...args),
  setAgentPermissions: (...args: unknown[]) => setAgentPermissionsMock(...args),
}));

vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastErrorMock(...args), success: vi.fn() },
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1" }, isLoading: false }),
}));

// SPECS-INDEX #1025:平台功能開關。這支測的不是開關本身 ⇒ 一律當作全開(開關關掉的情況另有 features 相關測試)。
vi.mock("@/modules/merchant/features", () => ({
  MERCHANT_FEATURE_KEYS: {
    onlineBooking: "online_booking",
    dataImport: "data_import",
    reportExport: "report_export",
  },
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: () => true,
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

describe("AgentPermissionsPage 說明收進「?」(#990)", () => {
  beforeEach(() => {
    fetchMerchantAgentsMock.mockReset().mockResolvedValue([{ id: "agent-1", name: "小美" }]);
    fetchAgentPermissionsMock
      .mockReset()
      .mockResolvedValue([{ section_key: "orders", granted: true }]);
    setAgentPermissionsMock.mockReset().mockResolvedValue(undefined);
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

    expect(setAgentPermissionsMock).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: orders.label })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("點開關本身仍會送出權限變更", async () => {
    const user = userEvent.setup();
    await renderPage();
    // 第 11 批 E:會員管理有相依(紅利點數)會先跳小卡窗 ⇒ 改用沒有相依的「店家報表」驗「點開關會送出」。
    const billing = SECTIONS.find((s) => s.key === "billing")!;
    await user.click(screen.getByRole("switch", { name: billing.label }));
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "billing", granted: true },
    ]);
  });
});

// ===========================================================================
// 第 11 批 E(#992,2026-10-07):相依權限「打開時提示、按確定就一併開啟」。
// 規格書 .project/specs/改掛會員與預設文案全形-第11批.md §11.4~§11.8、§11.10 vitest ①~⑬。
// ===========================================================================

type Perm = { section_key: string; granted: boolean };
type Change = { sectionKey: string; granted: boolean };

function perms(on: string[]): Perm[] {
  return on.map((k) => ({ section_key: k, granted: true }));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// hidden: true —— 小卡窗開著時 Radix 會把背景標成 aria-hidden,仍要能讀到開關目前的狀態。
const sw = (label: string) => screen.getByRole("switch", { name: label, hidden: true });
const dialog = () => screen.queryByTestId("agent-permission-dependency-confirm");
const THREE = ["料錢成本管理", "抽成與薪資設定", "月薪人員假別設定"];

describe("第 11 批 E:相依權限小卡窗", () => {
  let dbState: Perm[] = [];

  function applyToDb(changes: Change[]) {
    for (const c of changes) {
      const row = dbState.find((p) => p.section_key === c.sectionKey);
      if (row) row.granted = c.granted;
      else dbState.push({ section_key: c.sectionKey, granted: c.granted });
    }
  }

  beforeEach(() => {
    dbState = [];
    fetchMerchantAgentsMock.mockReset().mockResolvedValue([{ id: "agent-1", name: "小美" }]);
    // 每次重抓都回傳「目前的資料庫狀態」;setAgentPermissions 成功時更新它(模擬真的寫進去)。
    fetchAgentPermissionsMock
      .mockReset()
      .mockImplementation(async () => dbState.map((p) => ({ ...p })));
    setAgentPermissionsMock
      .mockReset()
      .mockImplementation(async (_agentId: string, changes: Change[]) => applyToDb(changes));
    toastErrorMock.mockReset();
  });

  afterEach(() => cleanup());

  it("① 全關,點「料錢成本管理」⇒ 跳小卡窗,恰好 2 項;開關仍是關的、API 沒被呼叫", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(sw("料錢成本管理"));
    const d = await screen.findByTestId("agent-permission-dependency-confirm");
    expect(within(d).getByText("要一起開啟 2 個相關權限嗎？")).toBeInTheDocument();
    expect(d.querySelectorAll("[data-testid^='agent-permission-dependency-item-']")).toHaveLength(
      2,
    );
    expect(
      within(d).getByTestId("agent-permission-dependency-item-commission_settings"),
    ).toHaveTextContent("抽成與薪資設定");
    expect(within(d).getByTestId("agent-permission-dependency-item-team_leave")).toHaveTextContent(
      "月薪人員假別設定",
    );
    expect(d).toHaveTextContent("月薪金額與抽成比例");
    expect(sw("料錢成本管理")).toHaveAttribute("aria-checked", "false");
    expect(setAgentPermissionsMock).not.toHaveBeenCalled();
  });

  it("② 按「取消」⇒ 小卡窗關、三個開關都關、API 沒被呼叫;按 Esc 同結果", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(sw("料錢成本管理"));
    await user.click(within(dialog()!).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog()).toBeNull());
    for (const label of THREE) expect(sw(label)).toHaveAttribute("aria-checked", "false");
    await user.click(sw("料錢成本管理"));
    expect(dialog()).not.toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
    for (const label of THREE) expect(sw(label)).toHaveAttribute("aria-checked", "false");
    expect(setAgentPermissionsMock).not.toHaveBeenCalled();
  });

  it("③「一起開啟」⇒ API 只呼叫 1 次、3 筆;resolve 前 3 個開關就亮、整頁開關 disabled", async () => {
    const user = userEvent.setup();
    const gate = deferred();
    setAgentPermissionsMock
      .mockReset()
      .mockImplementation(async (_a: string, changes: Change[]) => {
        await gate.promise;
        applyToDb(changes);
      });
    await renderPage();
    await user.click(sw("料錢成本管理"));
    await user.click(within(dialog()!).getByRole("button", { name: "一起開啟" }));
    expect(setAgentPermissionsMock).toHaveBeenCalledTimes(1);
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "material_costs", granted: true },
      { sectionKey: "team_leave", granted: true },
      { sectionKey: "commission_settings", granted: true },
    ]);
    for (const label of THREE) expect(sw(label)).toHaveAttribute("aria-checked", "true");
    for (const s of screen.getAllByRole("switch")) expect(s).toBeDisabled();
    await act(async () => gate.resolve());
    await waitFor(() => expect(sw("訂單管理")).not.toBeDisabled());
    for (const label of THREE) expect(sw(label)).toHaveAttribute("aria-checked", "true");
    expect(setAgentPermissionsMock).toHaveBeenCalledTimes(1);
  });

  it("④ API reject ⇒ 3 個開關全部回到關、toast「設定失敗」、disabled 解除", async () => {
    const user = userEvent.setup();
    setAgentPermissionsMock.mockReset().mockRejectedValue(new Error("網路斷了"));
    await renderPage();
    await user.click(sw("料錢成本管理"));
    await user.click(within(dialog()!).getByRole("button", { name: "一起開啟" }));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls[0]![0]).toBe("設定失敗");
    const opts = toastErrorMock.mock.calls[0]![1] as { description: string };
    expect(opts.description).toMatch(/^這次的變更都沒有套用。/);
    await waitFor(() => expect(sw("料錢成本管理")).not.toBeDisabled());
    for (const label of THREE) expect(sw(label)).toHaveAttribute("aria-checked", "false");
  });

  it("⑤ 抽成與薪資設定已開 ⇒ 清單只剩還沒開的;假別也開著 ⇒ 不跳窗,直接存 1 筆", async () => {
    const user = userEvent.setup();
    dbState = perms(["commission_settings"]);
    await renderPage();
    await user.click(sw("料錢成本管理"));
    const d = await screen.findByTestId("agent-permission-dependency-confirm");
    expect(d.querySelectorAll("[data-testid^='agent-permission-dependency-item-']")).toHaveLength(
      1,
    );
    expect(
      within(d).getByTestId("agent-permission-dependency-item-team_leave"),
    ).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog()).toBeNull());
    cleanup();

    dbState = perms(["commission_settings", "team_leave"]);
    await renderPage();
    await user.click(sw("料錢成本管理"));
    expect(dialog()).toBeNull();
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "material_costs", granted: true },
    ]);
  });

  it("⑥ 三個都開,關「月薪人員假別設定」⇒「一起關閉」列 2 項;確定 ⇒ 1 次呼叫 3 筆 false", async () => {
    const user = userEvent.setup();
    dbState = perms(["material_costs", "commission_settings", "team_leave"]);
    await renderPage();
    await user.click(sw("月薪人員假別設定"));
    const d = await screen.findByTestId("agent-permission-dependency-confirm");
    expect(within(d).getByText("要一起關閉 2 個相關權限嗎？")).toBeInTheDocument();
    expect(d.querySelectorAll("[data-testid^='agent-permission-dependency-item-']")).toHaveLength(
      2,
    );
    expect(d).toHaveTextContent("不能再查看、修改服務人員的月薪與抽成比例。");
    await user.click(within(d).getByRole("button", { name: "一起關閉" }));
    expect(setAgentPermissionsMock).toHaveBeenCalledTimes(1);
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "team_leave", granted: false },
      { sectionKey: "material_costs", granted: false },
      { sectionKey: "commission_settings", granted: false },
    ]);
    await waitFor(() => expect(sw("料錢成本管理")).toHaveAttribute("aria-checked", "false"));
  });

  it("⑦ 舊資料:會員管理開、紅利點數關 ⇒ 會員管理底下黃色 E-4;打開紅利點數(不跳窗)後消失", async () => {
    const user = userEvent.setup();
    dbState = perms(["members"]);
    await renderPage();
    const note = screen.getByTestId("permission-dependency-note-members");
    expect(note).toHaveAttribute("role", "note");
    expect(note.className).toContain("bg-warn-soft");
    expect(note.className).not.toContain("destructive");
    expect(note).toHaveTextContent(
      "「紅利點數」頁目前只看得到頁面、看不到規則設定，要查看或修改紅利規則，需要同時開啟「紅利點數」權限。",
    );
    expect(note.closest("li")).toContainElement(sw("會員管理"));
    await user.click(sw("紅利點數"));
    expect(dialog()).toBeNull();
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "member_points", granted: true },
    ]);
    await waitFor(() =>
      expect(screen.queryByTestId("permission-dependency-note-members")).toBeNull(),
    );
  });

  it("⑧ 點 `?` 不會切換開關、不會跳相依小卡窗", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole("button", { name: "說明：料錢成本管理" }));
    expect(await screen.findByTestId("permission-help-popover")).toBeInTheDocument();
    expect(dialog()).toBeNull();
    expect(sw("料錢成本管理")).toHaveAttribute("aria-checked", "false");
    expect(setAgentPermissionsMock).not.toHaveBeenCalled();
  });

  it("⑨ 單一切換(訂單管理)⇒ 不跳窗,呼叫 setAgentPermissions 1 筆", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(sw("訂單管理"));
    expect(dialog()).toBeNull();
    expect(setAgentPermissionsMock).toHaveBeenCalledTimes(1);
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "orders", granted: true },
    ]);
  });

  it("⑩ 全關,點料錢成本管理 →「只開這一個」⇒ 只有 1 筆;另外兩把仍關;料錢成本管理下方 E-1", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(sw("料錢成本管理"));
    await user.click(screen.getByTestId("agent-permission-dependency-only-this"));
    expect(setAgentPermissionsMock).toHaveBeenCalledTimes(1);
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "material_costs", granted: true },
    ]);
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(sw("料錢成本管理")).not.toBeDisabled());
    expect(sw("料錢成本管理")).toHaveAttribute("aria-checked", "true");
    expect(sw("抽成與薪資設定")).toHaveAttribute("aria-checked", "false");
    expect(sw("月薪人員假別設定")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("permission-dependency-note-material_costs")).toHaveTextContent(
      "「料錢影響服務人員抽成」開關目前改不了，需要同時開啟「抽成與薪資設定」權限。",
    );
  });

  it("⑪ 三把都開,關假別 →「只關這一個」⇒ 1 筆 false;只有抽成與薪資設定下方 E-3", async () => {
    const user = userEvent.setup();
    dbState = perms(["material_costs", "commission_settings", "team_leave"]);
    await renderPage();
    await user.click(sw("月薪人員假別設定"));
    const onlyThis = await screen.findByTestId("agent-permission-dependency-only-this");
    expect(onlyThis).toHaveTextContent("只關這一個");
    await user.click(onlyThis);
    expect(setAgentPermissionsMock).toHaveBeenCalledWith("agent-1", [
      { sectionKey: "team_leave", granted: false },
    ]);
    await waitFor(() => expect(sw("料錢成本管理")).not.toBeDisabled());
    expect(sw("月薪人員假別設定")).toHaveAttribute("aria-checked", "false");
    expect(sw("料錢成本管理")).toHaveAttribute("aria-checked", "true");
    expect(sw("抽成與薪資設定")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("permission-dependency-note-commission_settings")).toHaveTextContent(
      "假別扣款規則在「月薪人員假別設定」頁，目前進不去，需要同時開啟「月薪人員假別設定」權限。",
    );
    expect(screen.queryByTestId("permission-dependency-note-material_costs")).toBeNull();
  });

  it("⑫「只開這一個」API reject ⇒ 開關回到關、黃色 `!` 不出現、toast「設定失敗」", async () => {
    const user = userEvent.setup();
    setAgentPermissionsMock.mockReset().mockRejectedValue(new Error("網路斷了"));
    await renderPage();
    await user.click(sw("料錢成本管理"));
    await user.click(screen.getByTestId("agent-permission-dependency-only-this"));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls[0]![0]).toBe("設定失敗");
    await waitFor(() => expect(sw("料錢成本管理")).not.toBeDisabled());
    expect(sw("料錢成本管理")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByTestId("permission-dependency-note-material_costs")).toBeNull();
  });

  it("⑬ 三顆按鈕的文字與 DOM 順序(開啟版 / 關閉版)+ footer 直排 class", async () => {
    const user = userEvent.setup();
    dbState = perms(["members", "member_points"]);
    await renderPage();
    await user.click(sw("料錢成本管理"));
    let d = await screen.findByTestId("agent-permission-dependency-confirm");
    expect(
      within(d)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["取消", "只開這一個", "一起開啟"]);
    const footer = within(d).getByTestId("agent-permission-dependency-only-this").parentElement!;
    const classes = footer.className.split(/\s+/);
    expect(classes).toContain("flex-col-reverse");
    expect(classes).toContain("items-stretch");
    expect(classes).toContain("sm:[&>*]:flex-1");
    expect(classes).toContain("[&>*]:flex-none");
    expect(classes).not.toContain("[&>*]:flex-1");
    expect(classes).not.toContain("sm:[&>*]:flex-none");
    expect(classes).not.toContain("items-center");
    await user.click(within(d).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(dialog()).toBeNull());

    await user.click(sw("紅利點數"));
    d = await screen.findByTestId("agent-permission-dependency-confirm");
    expect(within(d).getByText("要一起關閉 1 個相關權限嗎？")).toBeInTheDocument();
    expect(
      within(d)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["取消", "只關這一個", "一起關閉"]);
  });

  it("權限清單讀取失敗 ⇒ 不顯示相依提醒、不開小卡窗(沿用頁面既有行為)", async () => {
    const user = userEvent.setup();
    fetchAgentPermissionsMock.mockReset().mockRejectedValue(new Error("讀不到"));
    await renderPage();
    await waitFor(() => expect(fetchAgentPermissionsMock).toHaveBeenCalled());
    expect(screen.queryByTestId(/^permission-dependency-note-/)).toBeNull();
    await user.click(sw("料錢成本管理"));
    expect(dialog()).toBeNull();
  });
});
