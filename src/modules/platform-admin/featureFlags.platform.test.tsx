// SPECS-INDEX #1025 功能開關 FG1-T03:超級管理員畫面(FG1-U01 / U02 / U03 / U05 / U07)。
//
//   IndustryPresetsPage(功能開關頁):標題「功能開關」;功能 × 兩產業開關 + 已開好的商家統計與全部開啟／關閉(U08);
//     第三輪:先調整、按儲存才生效(確認窗寫會影響幾間);細部功能縮排在主功能下、主功能開時細部跟著開、主功能關時變灰
//   MerchantFeatureGrantsCard(商家詳情):第三輪改成先調整、按儲存才生效;儲存小卡窗列出變更、off_impact、可填備註;
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
  platformSetMerchantFeatures: vi.fn(),
  platformFetchFeatureUsageSummary: vi.fn(),
  platformSaveFeatureSettings: vi.fn(),
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

const STAFF_FEATURES = [
  {
    key: "staff_portal",
    name: "服務人員登入端",
    description: "服務人員用自己的帳號登入。",
    off_impact: "服務人員登入後只會看到一句話。",
    parent_key: null,
    sort_order: 40,
    default_enabled: true,
  },
  {
    key: "staff_self_payroll",
    name: "服務人員查看自己的抽成薪資",
    description: "服務人員查自己的抽成。",
    off_impact: "服務人員看不到自己的抽成薪資頁。",
    parent_key: "staff_portal",
    sort_order: 43,
    default_enabled: true,
  },
];

describe("功能開關頁(IndustryPresetsPage,FG1-U01 / U02 / U08 + 第三輪)", () => {
  beforeEach(() => {
    a.fetchPlatformFeatures.mockResolvedValue([...FEATURES, ...STAFF_FEATURES]);
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
      {
        id: "p3",
        industry_type: "on_site_dispatch",
        feature_key: "staff_portal",
        default_enabled: false,
      },
    ]);
    a.platformFetchFeatureUsageSummary.mockResolvedValue([
      { feature_key: "online_booking", enabled_count: 256, disabled_count: 207 },
      { feature_key: "data_import", enabled_count: 463, disabled_count: 0 },
      { feature_key: "staff_portal", enabled_count: 400, disabled_count: 63 },
      { feature_key: "staff_self_payroll", enabled_count: 390, disabled_count: 73 },
    ]);
    a.platformSaveFeatureSettings.mockResolvedValue({
      presets_changed: 1,
      merchants_changed: { online_booking: 256 },
    });
  });

  it("標題、說明;每列有新開商家預設兩個開關 + 已開好的商家統計與全部開啟／關閉;細部功能縮排在主功能下", async () => {
    render(wrap(<IndustryPresetsPage />));
    expect(screen.getByRole("heading", { name: "功能開關" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "功能開關" })).toHaveAttribute(
      "href",
      "/platform-admin/industry-presets",
    );
    expect(screen.getByTestId("feature-presets-intro")).toHaveTextContent(
      "這裡可以一次調整所有商家，也可以設定新開商家的預設；要只調整某一間，請到「集團與商家」點進那間商家。",
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
    expect(await screen.findByTestId("feature-usage-online_booking")).toHaveTextContent(
      "已開好的商家：目前 256 間開、207 間關",
    );
    expect(screen.getByTestId("feature-bulk-on-online_booking")).toHaveTextContent("全部開啟");
    expect(screen.getByTestId("feature-bulk-off-online_booking")).toHaveTextContent("全部關閉");
    // 細部功能排在主功能後面
    const rows = screen.getAllByTestId(/^feature-preset-row-/).map((r) => r.dataset["testid"]);
    expect(rows.indexOf("feature-preset-row-staff_self_payroll")).toBe(
      rows.indexOf("feature-preset-row-staff_portal") + 1,
    );
    // 到府派工的登入端預設是關 ⇒ 底下細部功能那一格變灰不能操作
    expect(
      screen.getByTestId("feature-preset-switch-on_site_dispatch-staff_self_payroll"),
    ).toBeDisabled();
    expect(
      screen.getByTestId("feature-preset-switch-in_store_beauty-staff_self_payroll"),
    ).not.toBeDisabled();
    expect(screen.queryByRole("button", { name: /新增|刪除/ })).toBeNull();
    expect(screen.queryByTestId("feature-presets-unsaved")).toBeNull();
    expect(document.body.textContent).not.toMatch(/產業預設功能組合|方案|價格|加購/);
  });

  it("切開關不會馬上存;出現「尚未儲存變更」;主功能打開 ⇒ 細部功能預設跟著打開;放棄變更 ⇒ 回到原值", async () => {
    const user = userEvent.setup();
    render(wrap(<IndustryPresetsPage />));
    const payroll = await screen.findByTestId(
      "feature-preset-switch-on_site_dispatch-staff_self_payroll",
    );
    await user.click(screen.getByTestId("feature-preset-switch-on_site_dispatch-staff_portal"));
    expect(a.platformSaveFeatureSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("feature-presets-unsaved")).toHaveTextContent("尚未儲存變更");
    expect(payroll).not.toBeDisabled();
    expect(payroll).toHaveAttribute("data-state", "checked");
    await user.click(screen.getByRole("button", { name: "放棄變更" }));
    expect(screen.queryByTestId("feature-presets-unsaved")).toBeNull();
    expect(
      screen.getByTestId("feature-preset-switch-on_site_dispatch-staff_portal"),
    ).toHaveAttribute("data-state", "unchecked");
  });

  it("全部關閉 ⇒ 排進草稿(同列預設一起改)→ 儲存 ⇒ 確認窗寫會影響幾間 + off_impact + 備註 → 一次送出", async () => {
    const user = userEvent.setup();
    render(wrap(<IndustryPresetsPage />));
    await user.click(await screen.findByTestId("feature-bulk-off-online_booking"));
    expect(screen.getByTestId("feature-bulk-staged-online_booking")).toHaveTextContent(
      "儲存後全部關閉",
    );
    expect(
      screen.getByTestId("feature-preset-switch-on_site_dispatch-online_booking"),
    ).toHaveAttribute("data-state", "unchecked");
    expect(a.platformSaveFeatureSettings).not.toHaveBeenCalled();
    await user.click(screen.getByTestId("feature-presets-save"));
    const dialog = await screen.findByTestId("feature-presets-confirm");
    expect(dialog).toHaveTextContent("所有商家的「客戶線上預約」都關閉");
    expect(dialog).toHaveTextContent("會影響 463 間商家，其中 256 間目前是開的。");
    expect(dialog).toHaveTextContent("客人打開預約網址會看到「這間店目前暫停線上預約」。");
    expect(dialog).toHaveTextContent("到府派工「客戶線上預約」改成關");
    await user.type(within(dialog).getByPlaceholderText("例如：先藏起來，之後統一打開"), "先藏");
    await user.click(within(dialog).getByTestId("feature-presets-confirm-save"));
    await waitFor(() =>
      expect(a.platformSaveFeatureSettings).toHaveBeenCalledWith({
        presets: [
          {
            industry_type: "on_site_dispatch",
            feature_key: "online_booking",
            default_enabled: false,
          },
        ],
        bulk: [{ feature_key: "online_booking", enabled: false }],
        note: "先藏",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("已儲存，共更新 256 間商家的開關。");
  });

  it("#1052 H2-06:有細部功能的大項全部關閉 ⇒ 確認窗加「底下的細部功能也會一起停用。」;沒有細部功能的不加", async () => {
    const user = userEvent.setup();
    render(wrap(<IndustryPresetsPage />));
    await user.click(await screen.findByTestId("feature-bulk-off-staff_portal"));
    await user.click(screen.getByTestId("feature-bulk-off-online_booking"));
    await user.click(screen.getByTestId("feature-presets-save"));
    const dialog = await screen.findByTestId("feature-presets-confirm");
    const items = within(within(dialog).getByTestId("feature-presets-confirm-list"))
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    const portal = items.find((t) => t.includes("「服務人員登入端」都關閉"));
    const booking = items.find((t) => t.includes("「客戶線上預約」都關閉"));
    expect(portal).toContain("服務人員登入後只會看到一句話。底下的細部功能也會一起停用。");
    expect(booking).toBeDefined();
    expect(booking).not.toContain("底下的細部功能也會一起停用。");
  });

  it("主功能全部開啟 ⇒ 細部功能也排「全部開啟」;主功能全部關閉 ⇒ 細部功能的批次按鈕不能按", async () => {
    const user = userEvent.setup();
    render(wrap(<IndustryPresetsPage />));
    await user.click(await screen.findByTestId("feature-bulk-on-staff_portal"));
    expect(screen.getByTestId("feature-bulk-staged-staff_self_payroll")).toHaveTextContent(
      "儲存後全部開啟",
    );
    await user.click(screen.getByTestId("feature-bulk-undo-staff_portal"));
    expect(screen.queryByTestId("feature-bulk-staged-staff_self_payroll")).toBeNull();
    await user.click(screen.getByTestId("feature-bulk-off-staff_portal"));
    expect(screen.getByTestId("feature-bulk-on-staff_self_payroll")).toBeDisabled();
    expect(screen.getByTestId("feature-bulk-off-staff_self_payroll")).toBeDisabled();
  });
});

describe("商家詳情「功能開關」卡(MerchantFeatureGrantsCard,FG1-U03 / U05 + 第三輪)", () => {
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
        granted: false,
        effective: false,
      }),
    ]);
    a.platformSetMerchantFeatures.mockResolvedValue(1);
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

  it("切開關不會馬上存;主功能打開 ⇒ 細部功能預設跟著打開、可以再個別關;放棄變更 ⇒ 回原值", async () => {
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-switch-data_import"));
    expect(a.platformSetMerchantFeatures).not.toHaveBeenCalled();
    const child = screen.getByTestId("merchant-feature-switch-data_import_child");
    expect(child).not.toBeDisabled();
    expect(child).toHaveAttribute("data-state", "checked");
    await user.click(child);
    expect(child).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByTestId("merchant-feature-unsaved")).toHaveTextContent("尚未儲存變更");
    await user.click(screen.getByRole("button", { name: "放棄變更" }));
    expect(screen.queryByTestId("merchant-feature-unsaved")).toBeNull();
    expect(screen.getByTestId("merchant-feature-switch-data_import")).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("儲存 ⇒ 小卡窗列出變更(關掉的附 off_impact、主功能關附「底下的細部功能也會一起停用。」)+ 備註 ⇒ 一次送出", async () => {
    a.platformFetchMerchantFeatures.mockResolvedValue([
      mrow({ feature_key: "online_booking", name: "客戶線上預約", sort_order: 10 }),
      mrow({ feature_key: "data_import", name: "資料匯入", sort_order: 20 }),
      mrow({ feature_key: "data_import_child", name: "測試細部功能", parent_key: "data_import" }),
    ]);
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-switch-data_import"));
    await user.click(screen.getByTestId("merchant-feature-switch-online_booking"));
    await user.click(screen.getByTestId("merchant-feature-save"));
    const dialog = await screen.findByTestId("merchant-feature-save-dialog");
    expect(dialog).toHaveTextContent("關閉「客戶線上預約」");
    expect(dialog).toHaveTextContent("關掉客戶線上預約的影響。");
    expect(dialog).toHaveTextContent("關閉「資料匯入」");
    expect(dialog).toHaveTextContent("底下的細部功能也會一起停用。");
    expect(a.platformSetMerchantFeatures).not.toHaveBeenCalled();
    await user.type(within(dialog).getByPlaceholderText("例如：試用到期"), "朋友試用到期");
    await user.click(within(dialog).getByTestId("merchant-feature-save-confirm"));
    await waitFor(() =>
      expect(a.platformSetMerchantFeatures).toHaveBeenCalledWith({
        merchantId: "m-1",
        changes: [
          { feature_key: "online_booking", enabled: false },
          { feature_key: "data_import", enabled: false },
        ],
        note: "朋友試用到期",
      }),
    );
    expect(toastMock.success).toHaveBeenCalledWith("已儲存功能開關。");
  });

  it("儲存小卡窗按取消 ⇒ 不送出,草稿還在", async () => {
    const user = userEvent.setup();
    render(wrap(<MerchantFeatureGrantsCard merchantId="m-1" />));
    await user.click(await screen.findByTestId("merchant-feature-switch-data_import"));
    await user.click(screen.getByTestId("merchant-feature-save"));
    const dialog = await screen.findByTestId("merchant-feature-save-dialog");
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByTestId("merchant-feature-save-dialog")).toBeNull());
    expect(a.platformSetMerchantFeatures).not.toHaveBeenCalled();
    expect(screen.getByTestId("merchant-feature-unsaved")).toBeInTheDocument();
  });

  it("有未儲存變更時點站內連結 ⇒ 先問「確定放棄這次的變更？」", async () => {
    const user = userEvent.setup();
    render(
      wrap(
        <>
          <a href="/platform-admin">集團與商家</a>
          <MerchantFeatureGrantsCard merchantId="m-1" />
        </>,
      ),
    );
    await user.click(await screen.findByTestId("merchant-feature-switch-data_import"));
    await user.click(screen.getByRole("link", { name: "集團與商家" }));
    expect(await screen.findByTestId("feature-leave-guard")).toHaveTextContent(
      "確定放棄這次的變更？",
    );
  });

  it("最近變更紀錄:展開才讀;沒有紀錄 ⇒「還沒有變更紀錄。」", async () => {
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
