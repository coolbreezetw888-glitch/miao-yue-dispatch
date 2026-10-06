// #986 第 9 批(9-7 / 9-8 / 9-9):服務項目「描述」欄位。
//   ・服務項目頁:新增 / 編輯多一格「項目描述(選填)」、字數 n / 200、超過 200 字擋送出 + 欄位錯誤、空白送 null;
//     列表卡片有描述才顯示一行小字(line-clamp-2)
//   ・建單「選擇項目」整頁:名稱下方顯示描述(保留換行);沒描述不留空白
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  addServiceItem: vi.fn(),
  updateServiceItem: vi.fn(),
  fetchMerchantServiceItemsAll: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: m.toast }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({}), rpc: () => ({}), channel: () => ({}) },
}));
vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "m1", name: "測試商家" }, isLoading: false }),
}));
vi.mock("./RequireServiceItemsAccess", () => ({
  RequireServiceItemsAccess: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("./api", () => ({
  addServiceCategory: vi.fn(),
  addServiceItem: m.addServiceItem,
  deleteServiceCategory: vi.fn(),
  fetchMerchantServiceItemsAll: m.fetchMerchantServiceItemsAll,
  fetchServiceCategories: vi.fn(async () => []),
  reactivateServiceItem: vi.fn(),
  removeServiceItem: vi.fn(),
  renameServiceCategory: vi.fn(),
  updateServiceItem: m.updateServiceItem,
}));

import ServiceItemsPage from "./ServiceItemsPage";
import { normalizeServiceItemDescription, serviceItemDescriptionError } from "./types";
import { ServiceItemPickerPage } from "@/modules/booking/ServiceItemPickerPage";

function item(over: Record<string, unknown>) {
  return {
    id: "i1",
    merchant_id: "m1",
    name: "冷氣清洗",
    price: 1000,
    item_type: "primary",
    duration_minutes: 60,
    category_id: null,
    status: "active",
    description: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ServiceItemsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  m.addServiceItem.mockResolvedValue(item({}));
  m.updateServiceItem.mockResolvedValue(undefined);
  m.fetchMerchantServiceItemsAll.mockResolvedValue([
    item({ id: "i1", name: "冷氣清洗", description: "含室內機與室外機\n約需 1 小時" }),
    item({ id: "i2", name: "加購濾網", description: null }),
  ]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("純函式", () => {
  it("normalizeServiceItemDescription:去頭尾空白,空白 / 沒帶 ⇒ null", () => {
    expect(normalizeServiceItemDescription("  含清洗  ")).toBe("含清洗");
    expect(normalizeServiceItemDescription("   ")).toBeNull();
    expect(normalizeServiceItemDescription("")).toBeNull();
    expect(normalizeServiceItemDescription(undefined)).toBeNull();
    expect(normalizeServiceItemDescription(null)).toBeNull();
  });
  it("serviceItemDescriptionError:200 字可以、201 字擋(以字計算,emoji 算一個字)", () => {
    expect(serviceItemDescriptionError("字".repeat(200))).toBeNull();
    expect(serviceItemDescriptionError("字".repeat(201))).toBe("項目描述最多 200 個字");
    expect(serviceItemDescriptionError("😀".repeat(200))).toBeNull();
  });
});

describe("服務項目頁(9-8)", () => {
  it("列表卡片:有描述才顯示一行小字(兩行截斷),沒描述不顯示", async () => {
    renderPage();
    const desc = await screen.findByTestId("service-item-description-i1");
    expect(desc).toHaveTextContent("含室內機與室外機");
    expect(desc.className).toContain("line-clamp-2");
    expect(screen.queryByTestId("service-item-description-i2")).toBeNull();
  });

  it("新增:描述欄位 + 字數計數;201 字 ⇒ 欄位錯誤、不送出;改成 200 字 ⇒ 送出帶描述", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "新增服務項目" }));
    const textarea = (await screen.findByLabelText(/項目描述\(選填\)/)) as HTMLTextAreaElement;
    expect(textarea.tagName).toBe("TEXTAREA");
    fireEvent.change(document.getElementById("item-name") as HTMLElement, {
      target: { value: "新項目" },
    });
    fireEvent.change(document.getElementById("item-price") as HTMLElement, {
      target: { value: "500" },
    });
    fireEvent.change(textarea, { target: { value: "字".repeat(201) } });
    expect(screen.getByText("201 / 200")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    expect(await screen.findByText("項目描述最多 200 個字")).toBeInTheDocument();
    expect(m.addServiceItem).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "字".repeat(200) } });
    expect(screen.queryByText("項目描述最多 200 個字")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(m.addServiceItem).toHaveBeenCalledTimes(1));
    expect(m.addServiceItem.mock.calls[0]?.[1]).toMatchObject({ description: "字".repeat(200) });
  });

  it("編輯:帶入現有描述;清成空白送出 ⇒ api 收到空白(api 層 normalize 成 null)", async () => {
    renderPage();
    const card = (await screen.findByTestId("service-item-description-i1")).closest(
      "li",
    ) as HTMLElement;
    fireEvent.click(within(card).getByRole("button", { name: "編輯" }));
    const textarea = (await screen.findByLabelText(/項目描述\(選填\)/)) as HTMLTextAreaElement;
    expect(textarea.value).toBe("含室內機與室外機\n約需 1 小時");
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(m.updateServiceItem).toHaveBeenCalledTimes(1));
    const sent = m.updateServiceItem.mock.calls[0]?.[1] as { description: string };
    expect(normalizeServiceItemDescription(sent.description)).toBeNull();
  });
});

describe("選擇項目整頁(9-9)", () => {
  function renderPicker(items: { id: string; description?: string | null }[]) {
    return render(
      <ServiceItemPickerPage
        items={items.map((i) => ({
          id: i.id,
          name: `項目${i.id}`,
          price: 500,
          duration_minutes: 30,
          category_id: null,
          description: i.description ?? null,
        }))}
        categories={[]}
        uncategorizedLabel="未分類"
        serviceItemIds={[]}
        itemQuantities={{}}
        itemUnitPrices={{}}
        baselinePrice={() => null}
        onConfirm={() => {}}
        onBack={() => {}}
      />,
    );
  }

  it("有描述 ⇒ 名稱下方顯示(保留換行、不截斷);沒描述 ⇒ 不留空白", () => {
    renderPicker([
      { id: "a", description: "第一行\n第二行" },
      { id: "b", description: null },
      { id: "c", description: "   " },
    ]);
    const desc = screen.getByTestId("picker-item-description-a");
    expect(desc).toHaveTextContent("第一行");
    expect(desc.className).toContain("whitespace-pre-line");
    expect(desc.className).not.toContain("line-clamp");
    expect(screen.queryByTestId("picker-item-description-b")).toBeNull();
    expect(screen.queryByTestId("picker-item-description-c")).toBeNull();
  });
});
