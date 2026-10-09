// SPECS-INDEX #1025 功能開關 FG1-T03:超級管理員畫面(FG1-U01 / U02 / U03 / U05 / U07)。
//
//   IndustryPresetsPage(功能開關頁):標題「功能開關」;功能 × 兩產業開關;切換即存 + toast;沒有「新增」「刪除」
//   MerchantFeatureGrantsCard(商家詳情):打開直接存;關掉先跳小卡窗、內文 = off_impact、可填備註;
//     「跟產業預設不同」標籤;細部功能在主功能關時「主功能關閉中」+ 開關不能切;最近變更紀錄
//   MerchantsOverviewPage:產業篩選顯示「到店服務」,不再有「美業到店」
//   featureDisplay 純函式

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { MerchantFeatureRow } from "@/modules/merchant/features";

const a = vi.hoisted(() => ({
  fetchPlatformFeatures: vi.fn(),
  fetchIndustryFeaturePresets: vi.fn(),
  upsertIndustryFeaturePreset: vi.fn(),
  platformFetchMerchantFeatures: vi.fn(),
  platformSetMerchantFeature: vi.fn(),
  platformListMerchantFeatureLogs: vi.fn(),
  platformFetchAllMerchants: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("./api", () => a);
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/modules/merchant/api", () => ({ disableMerchant: vi.fn(), enableMerchant: vi.fn() }));

const { default: IndustryPresetsPage } = await import("./IndustryPresetsPage");
const { MerchantFeatureGrantsCard } = await import("./MerchantFeatureGrantsCard");
const { default: MerchantsOverviewPage } = await import("./MerchantsOverviewPage");
const { differsFromPreset, featureLogChangeText, isParentOff, orderFeaturesForDisplay } =
  await import("./featureDisplay");

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto["hasPointerCapture"] ??= () => false;
  proto["releasePointerCapture"] ??= () => undefined;
  proto["scrollIntoView"] ??= () => undefined;
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function wrap(children: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const FEATURES = [
  {
    key: "online_booking",
    name: "客戶線上預約",
    description: "客人用預約網址自己看服務、選時間、送出預約。",
    off_impact: "客人打開預約網址會看到「這間店目前暫停線上預約」。",
    parent_key: null,
    sort_order: 10,
    default_enabled: true,
  },
  {
    key: "data_import",
    name: "資料匯入",
    description: "用檔案一次匯入會員、歷史訂單。",
    off_impact: "商家後台看不到「資料匯入」和「匯入紀錄」。",
    parent_key: null,
    sort_order: 20,
    default_enabled: true,
  },
];

function mrow(
  p: Partial<MerchantFeatureRow> & { feature_key: string; name: string },
): MerchantFeatureRow {
  return {
    description: `${p.name}的說明`,
    off_impact: `關掉${p.name}的影響。`,
    parent_key: null,
    sort_order: 0,
    granted: true,
    effective: true,
    preset_enabled: true,
    ...p,
  };
}

beforeEach(() => {
  for (const fn of Object.values(a)) fn.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

afterEach(() => cleanup());

describe("功能開關頁(IndustryPresetsPage,FG1-U01 / U02)", () => {
  beforeEach(() => {
    a.fetchPlatformFeatures.mockResolvedValue(FEATURES);
    a.fetchIndustryFeaturePresets.mockResolvedValue([
      {
        id: "p1",
        industry_type: "on_site_dispatch",
        feature_key: "online_booking",
        default_enabled: true,
      },
      {
        id: "p2",
        industry_type: "in_store_beauty",
        feature_key: "online_booking",
        default_enabled: false,
      },
      // data_import 兩個產業都沒有列 ⇒ 顯示功能清單預設(開)
    ]);
    a.upsertIndustryFeaturePreset.mockResolvedValue(undefined);
  });

  it("標題與導覽都叫「功能開關」;每個功能兩個開關(值正確);沒有「新增」「刪除」", async () => {
    render(wrap(<IndustryPresetsPage />));
    expect(screen.getByRole("heading", { name: "功能開關" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "功能開關" })).toHaveAttribute(
      "href",
      "/platform-admin/industry-presets",
    );
    await screen.findByTestId("feature-preset-row-online_booking");
    expect(
      screen.getByTestId("feature-preset-switch-on_site_dispatch-online_booking"),
    ).toHaveAttribute("data-state", "checked");
    expect(
      screen.getByTestId("feature-preset-switch-in_store_beauty-online_booking"),
    ).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByTestId("feature-preset-switch-in_store_beauty-data_import")).toHaveAttribute(
      "data-state",
      "checked",
    );
    expect(screen.queryByRole("button", { name: /新增/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /刪除/ })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.body.textContent).not.toMatch(/產業預設功能組合|方案|價格|加購/);
  });

  it("切換即存:upsert 正確的產業 / 功能 / 值,成功 toast「已更新預設值。」", async () => {
    const user = userEvent.setup();
    render(wrap(<IndustryPresetsPage />));
    await user.click(
      await screen.findByTestId("feature-preset-switch-in_store_beauty-online_booking"),
    );
    await waitFor(() =>
      expect(a.upsertIndustryFeaturePreset).toHaveBeenCalledWith({
        industryType: "in_store_beauty",
        featureKey: "online_booking",
        defaultEnabled: true,
      }),
    );
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("已更新預設值。"));
  });
});

describe("商家詳情「功能開關」卡(MerchantFeatureGrantsCard,FG1-U03 / U05)", () => {
  beforeEach(() => {
    a.platformFetchMerchantFeatures.mockResolvedValue([
      mrow({ feature_key: "online_booking", name: "客戶線上預約", sort_order: 10 }),
      mrow({
        feature_key: "data_import",
        name: "資料匯入",
        sort_order: 20,
        granted: false,
        effective: false,
        preset_enabled: true,
      }),
      mrow({
        feature_key: "data_import_child",
        name: "測試細部功能",
        parent_key: "data_import",
        sort_order: 21,
        granted: true,
        effective: false,
      }),
    ]);
    a.platformSetMerchantFeature.mockResolvedValue(undefined);
    a.platformListMerchantFeatureLogs.mockResolvedValue([]);
  });

  it("標籤:跟產業預設不同 / 主功能關閉中(細部開關不能切)", async () => {
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await screen.findByTestId("merchant-feature-row-data_import");
    expect(screen.getByTestId("merchant-feature-differs-data_import")).toHaveTextContent(
      "跟產業預設不同",
    );
    expect(screen.queryByTestId("merchant-feature-differs-online_booking")).toBeNull();
    expect(screen.getByTestId("merchant-feature-parent-off-data_import_child")).toHaveTextContent(
      "主功能關閉中",
    );
    expect(screen.getByTestId("merchant-feature-switch-data_import_child")).toBeDisabled();
  });

  it("打開 ⇒ 直接存,toast「已開啟「資料匯入」。」", async () => {
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-switch-data_import"));
    await waitFor(() =>
      expect(a.platformSetMerchantFeature).toHaveBeenCalledWith({
        merchantId: "m-1",
        featureKey: "data_import",
        enabled: true,
        note: null,
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("已開啟「資料匯入」。");
  });

  it("關掉 ⇒ 先跳小卡窗(標題、內文 = off_impact),填備註後按「關閉功能」才存", async () => {
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-switch-online_booking"));
    const dialog = await screen.findByTestId("merchant-feature-close-dialog");
    expect(within(dialog).getByText("確定要關閉「客戶線上預約」？")).toBeInTheDocument();
    expect(within(dialog).getByText("關掉客戶線上預約的影響。")).toBeInTheDocument();
    expect(a.platformSetMerchantFeature).not.toHaveBeenCalled();
    await user.type(within(dialog).getByPlaceholderText("例如：試用到期"), "朋友試用到期");
    await user.click(within(dialog).getByTestId("merchant-feature-close-confirm"));
    await waitFor(() =>
      expect(a.platformSetMerchantFeature).toHaveBeenCalledWith({
        merchantId: "m-1",
        featureKey: "online_booking",
        enabled: false,
        note: "朋友試用到期",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("已關閉「客戶線上預約」。");
  });

  it("主功能有細部功能 ⇒ 關閉小卡窗多一句「底下的細部功能也會一起停用。」;按取消不存", async () => {
    a.platformFetchMerchantFeatures.mockResolvedValue([
      mrow({ feature_key: "data_import", name: "資料匯入", sort_order: 20 }),
      mrow({ feature_key: "data_import_child", name: "測試細部功能", parent_key: "data_import" }),
    ]);
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-switch-data_import"));
    const dialog = await screen.findByTestId("merchant-feature-close-dialog");
    expect(dialog).toHaveTextContent("底下的細部功能也會一起停用。");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("merchant-feature-close-dialog")).toBeNull());
    expect(a.platformSetMerchantFeature).not.toHaveBeenCalled();
  });

  it("最近變更紀錄:展開才讀;沒有紀錄 ⇒「還沒有變更紀錄。」;批次列有「批次」標籤", async () => {
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await screen.findByTestId("merchant-feature-row-data_import");
    expect(a.platformListMerchantFeatureLogs).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("merchant-feature-logs-toggle"));
    expect(await screen.findByText("還沒有變更紀錄。")).toBeInTheDocument();
    expect(a.platformListMerchantFeatureLogs).toHaveBeenCalledWith("m-1", 20);
  });

  it("最近變更紀錄:時間、功能、開→關、改的人、備註、批次標籤", async () => {
    a.platformListMerchantFeatureLogs.mockResolvedValue([
      {
        created_at: "2026-10-09T03:04:00Z",
        feature_key: "data_import",
        feature_name: "資料匯入",
        old_enabled: true,
        new_enabled: false,
        note: "試用到期",
        is_bulk: true,
        changed_by_email: "platform@test.local",
      },
    ]);
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-logs-toggle"));
    const logs = await screen.findByTestId("merchant-feature-logs");
    await waitFor(() => expect(logs).toHaveTextContent("開→關"));
    expect(logs).toHaveTextContent("資料匯入");
    expect(logs).toHaveTextContent("platform@test.local");
    expect(logs).toHaveTextContent("備註：試用到期");
    expect(logs).toHaveTextContent("批次");
    expect(logs).toHaveTextContent("2026/10/09 11:04");
  });
});

describe("集團與商家 產業篩選(FG1-U07 ⚠️3)", () => {
  it("選單是「到府派工」「到店服務」,不再有「美業到店」", async () => {
    a.platformFetchAllMerchants.mockResolvedValue([]);
    const user = userEvent.setup();
    render(wrap(<MerchantsOverviewPage />));
    const triggers = await screen.findAllByRole("combobox");
    const industryTrigger = triggers.find((t) => t.textContent?.includes("全部產業"))!;
    await user.click(industryTrigger);
    const options = (await screen.findAllByRole("option")).map((o) => o.textContent);
    expect(options).toEqual(["全部產業", "到府派工", "到店服務"]);
  });
});

describe("featureDisplay 純函式", () => {
  it("orderFeaturesForDisplay:細部功能緊跟在主功能後面", () => {
    const rows = [
      { ...FEATURES[1]!, key: "b", sort_order: 20 },
      { ...FEATURES[1]!, key: "a_child", parent_key: "a", sort_order: 5 },
      { ...FEATURES[0]!, key: "a", sort_order: 10 },
    ];
    expect(orderFeaturesForDisplay(rows).map((r) => r.key)).toEqual(["a", "a_child", "b"]);
  });

  it("differsFromPreset / isParentOff / featureLogChangeText", () => {
    const parent = mrow({ feature_key: "p", name: "主", effective: false, granted: false });
    const child = mrow({ feature_key: "c", name: "細", parent_key: "p", effective: false });
    expect(differsFromPreset(parent)).toBe(true);
    expect(differsFromPreset(mrow({ feature_key: "x", name: "x", preset_enabled: null }))).toBe(
      false,
    );
    expect(isParentOff(child, [parent, child])).toBe(true);
    expect(isParentOff(parent, [parent, child])).toBe(false);
    expect(featureLogChangeText(true, false)).toBe("開→關");
    expect(featureLogChangeText(false, true)).toBe("關→開");
    expect(featureLogChangeText(null, false)).toBe("設為關");
  });
});
