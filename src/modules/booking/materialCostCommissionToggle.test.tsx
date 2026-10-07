// SPECS-INDEX #985 第 8 批:料錢成本管理頁「料錢影響服務人員抽成」開關(8-1 / 8-2)
// + 抽成與薪資設定頁改唯讀一行(8-3)+ 文案守門。
//
// 把元件真的 render 起來,api 全部 mock,驗:
//   ・開關值來自資料庫(開 = 扣料錢),不是反過來
//   ・料錢成本功能關閉 ⇒ 開關變灰 + `!`;沒有修改權限 ⇒ 開關變灰 + `!`
//   ・讀取失敗 ⇒ ErrorState,不顯示開關(不能顯示預設值讓人誤以為是自己的設定)
//   ・切換先跳確認窗;取消不送;確定才送;失敗 toast 錯誤、開關停在原值
//   ・抽成與薪資設定頁:二選一不見了、只剩唯讀一行;連結只給進得去料錢成本管理頁的人

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchSetting: vi.fn(),
  setAffects: vi.fn(),
  getFeatureFlag: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  payrollSettings: {
    current: {
      data: { commission_basis_type: "gross" } as { commission_basis_type: string } | undefined,
      isLoading: false,
      isError: false,
    },
  },
  role: { current: "admin" as "admin" | "agent" },
  materialPermission: { current: null as boolean | null },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchMaterialCostCommissionSetting: mocks.fetchSetting,
    setMaterialCostAffectsCommission: mocks.setAffects,
  };
});

vi.mock("@/modules/merchant/api", () => ({
  getFeatureFlag: mocks.getFeatureFlag,
  setFeatureFlag: vi.fn(),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試商家" }, isLoading: false }),
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: mocks.role.current, isLoading: false }),
  useAgentPermission: () => ({ data: mocks.materialPermission.current, isLoading: false }),
  useMerchantStaffList: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/modules/payroll/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/payroll/api")>();
  return {
    ...actual,
    useMerchantPayrollSettings: () => ({ ...mocks.payrollSettings.current, refetch: vi.fn() }),
  };
});

import { MaterialCostCommissionToggle } from "./MaterialCostsPage";
import { MATERIAL_COST_COMMISSION_COPY } from "./materialCostCommissionCopy";
import { parseMaterialCostCommissionSetting } from "./api";
import { MerchantPayrollSettingsCard } from "@/modules/payroll/PayrollSettingsPage";

function renderWithProviders(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

async function findSwitch() {
  return screen.findByRole("switch", { name: MATERIAL_COST_COMMISSION_COPY.title });
}

beforeEach(() => {
  mocks.fetchSetting.mockResolvedValue({ affectsCommission: false, canEdit: true });
  mocks.setAffects.mockResolvedValue(true);
  mocks.getFeatureFlag.mockResolvedValue(true);
  mocks.role.current = "admin";
  mocks.materialPermission.current = null;
  mocks.payrollSettings.current = {
    data: { commission_basis_type: "gross" },
    isLoading: false,
    isError: false,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("料錢影響服務人員抽成開關(8-1 / 8-2)", () => {
  it("開關值跟資料庫一致:affects_commission = true ⇒ 開;false ⇒ 關", async () => {
    mocks.fetchSetting.mockResolvedValue({ affectsCommission: true, canEdit: true });
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    const sw = await findSwitch();
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(sw).not.toBeDisabled();
    expect(screen.getByText(MATERIAL_COST_COMMISSION_COPY.description)).toBeInTheDocument();
  });

  it("料錢成本功能關閉 ⇒ 開關變灰(不可操作)+ `!` 說明,值保留", async () => {
    mocks.getFeatureFlag.mockResolvedValue(false);
    mocks.fetchSetting.mockResolvedValue({ affectsCommission: true, canEdit: true });
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    const sw = await findSwitch();
    await waitFor(() => expect(sw).toBeDisabled());
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(MATERIAL_COST_COMMISSION_COPY.featureOffNote)).toBeInTheDocument();
  });

  it("沒有修改權限(can_edit = false)⇒ 看得到狀態但不能操作 + `!` 說明", async () => {
    mocks.fetchSetting.mockResolvedValue({ affectsCommission: false, canEdit: false });
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    const sw = await findSwitch();
    expect(sw).toBeDisabled();
    expect(screen.getByText(MATERIAL_COST_COMMISSION_COPY.noPermissionNote)).toBeInTheDocument();
  });

  it("讀取失敗 ⇒ ErrorState,完全不顯示開關", async () => {
    mocks.fetchSetting.mockRejectedValue(new Error("network"));
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    expect(await screen.findByText("讀不到料錢影響抽成的設定")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("切換 ⇒ 先跳確認窗(文案照規格);按取消不送出、開關停在原值", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    await user.click(await findSwitch());
    expect(await screen.findByText("確定要開啟料錢影響抽成？")).toBeInTheDocument();
    expect(screen.getByText(MATERIAL_COST_COMMISSION_COPY.confirmBody(true))).toBeInTheDocument();
    expect(MATERIAL_COST_COMMISSION_COPY.confirmBody(true)).toContain("先扣料錢");
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(mocks.setAffects).not.toHaveBeenCalled();
    expect(await findSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("按確定 ⇒ 送出(開 = true)、toast「已更新」、重新讀取", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    await user.click(await findSwitch());
    mocks.fetchSetting.mockResolvedValue({ affectsCommission: true, canEdit: true });
    await user.click(await screen.findByRole("button", { name: "確定" }));
    await waitFor(() => expect(mocks.setAffects).toHaveBeenCalledWith("m1", true));
    await waitFor(() => expect(mocks.toast.success).toHaveBeenCalledWith("已更新"));
    await waitFor(async () => expect(await findSwitch()).toHaveAttribute("aria-checked", "true"));
  });

  it("關閉方向:確認窗標題寫「關閉」、內文寫「不扣料錢」、送出 false", async () => {
    mocks.fetchSetting.mockResolvedValue({ affectsCommission: true, canEdit: true });
    const user = userEvent.setup();
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    await user.click(await findSwitch());
    expect(await screen.findByText("確定要關閉料錢影響抽成？")).toBeInTheDocument();
    expect(screen.getByText(MATERIAL_COST_COMMISSION_COPY.confirmBody(false))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "確定" }));
    await waitFor(() => expect(mocks.setAffects).toHaveBeenCalledWith("m1", false));
  });

  it("送出失敗 ⇒ toast 錯誤、開關回到原值", async () => {
    mocks.setAffects.mockRejectedValue(
      new Error("只有商家管理員或有「抽成與薪資設定」權限的人可以修改這個開關"),
    );
    const user = userEvent.setup();
    renderWithProviders(<MaterialCostCommissionToggle merchantId="m1" />);
    await user.click(await findSwitch());
    await user.click(await screen.findByRole("button", { name: "確定" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(await findSwitch()).toHaveAttribute("aria-checked", "false");
  });

  it("回應格式不對 ⇒ 丟錯(不把「不知道」猜成「關閉」)", () => {
    expect(() => parseMaterialCostCommissionSetting(null)).toThrow();
    expect(() =>
      parseMaterialCostCommissionSetting({ affects_commission: "true", can_edit: true }),
    ).toThrow();
    expect(
      parseMaterialCostCommissionSetting({ affects_commission: true, can_edit: false }),
    ).toEqual({
      affectsCommission: true,
      canEdit: false,
    });
  });
});

describe("抽成與薪資設定頁改唯讀一行(8-3)", () => {
  it("二選一與儲存按鈕都不見了;顯示目前狀態 + 連結(管理員)", () => {
    mocks.payrollSettings.current = {
      data: { commission_basis_type: "net_of_material_cost" },
      isLoading: false,
      isError: false,
    };
    renderWithProviders(<MerchantPayrollSettingsCard merchantId="m1" />);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "儲存" })).not.toBeInTheDocument();
    const line = screen.getByTestId("payroll-material-commission-readonly");
    expect(line.textContent).toBe("料錢影響抽成：目前開啟。要修改請到「料錢成本管理」。");
    expect(screen.getByRole("link", { name: "「料錢成本管理」" })).toHaveAttribute(
      "href",
      "/app/material-costs",
    );
  });

  it("沒有料錢成本管理權限的客服 ⇒ 只有文字、沒有連結;查無設定 ⇒ 關閉", () => {
    mocks.role.current = "agent";
    mocks.materialPermission.current = false;
    renderWithProviders(<MerchantPayrollSettingsCard merchantId="m1" />);
    const line = screen.getByTestId("payroll-material-commission-readonly");
    expect(line.textContent).toBe("料錢影響抽成：目前關閉。要修改請到「料錢成本管理」。");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("讀不到設定 ⇒ ErrorState,不顯示開或關", () => {
    mocks.payrollSettings.current = { data: undefined, isLoading: false, isError: true };
    renderWithProviders(<MerchantPayrollSettingsCard merchantId="m1" />);
    expect(screen.getByText("讀不到商家層級的抽成設定")).toBeInTheDocument();
    expect(screen.queryByTestId("payroll-material-commission-readonly")).not.toBeInTheDocument();
  });
});

describe("文案守門", () => {
  const texts = [
    MATERIAL_COST_COMMISSION_COPY.title,
    MATERIAL_COST_COMMISSION_COPY.description,
    MATERIAL_COST_COMMISSION_COPY.help,
    MATERIAL_COST_COMMISSION_COPY.featureOffNote,
    MATERIAL_COST_COMMISSION_COPY.noPermissionNote,
    MATERIAL_COST_COMMISSION_COPY.confirmTitle(true),
    MATERIAL_COST_COMMISSION_COPY.confirmTitle(false),
    MATERIAL_COST_COMMISSION_COPY.confirmBody(true),
    MATERIAL_COST_COMMISSION_COPY.confirmBody(false),
  ];
  it("不出現內部用語、半形逗號冒號;用語是「服務人員」不是「師傅」", () => {
    for (const t of texts) {
      expect(t).not.toMatch(/gross|net_of_material_cost|commission_basis/);
      expect(t).not.toMatch(/[,:]/);
      expect(t).not.toContain("師傅");
    }
    expect(MATERIAL_COST_COMMISSION_COPY.title).toContain("服務人員");
  });

  // #996 第 11 批 K-9:重算抽成開放給有「抽成與薪資設定」的客服 ⇒ 確認窗後半句跟著改。
  it("K-9:確認窗寫「管理員或有「抽成與薪資設定」權限的客服可以…重新計算抽成」", () => {
    for (const next of [true, false]) {
      expect(MATERIAL_COST_COMMISSION_COPY.confirmBody(next)).toContain(
        "如果要讓某幾筆舊訂單套用新設定，管理員或有「抽成與薪資設定」權限的客服可以在該訂單詳情按「重新計算抽成」。",
      );
    }
  });
});
