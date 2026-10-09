// 紅利系統重構 批次 6(規格書 §4.1~§4.5、§2.8、§3.14):紅利點數管理頁的元件測試。
//
// 本機開發伺服器連的是正式庫,不能開起來實機看(批次 6 派工單),所以畫面行為改用元件測試釘住:
//   1. 分頁顯示條件:功能開 / 關、沒有紅利點數管理鑰匙、讀不到設定
//   2. 模式切換:進階開 ⇒ 基本三欄「隱藏」(不是灰掉)、公式出現;關回來基本設定的值還在
//   3. 「每滿額累計」開 ⇒ 標籤即時改名
//   4. 公式表單驗證:名稱空白 ⇒ 儲存鈕不能按 + 常駐 `!` 說原因
//   5. 儲存只送這個分頁自己的欄位(局部 patch,§3.14 —— 不會把別的分頁寫回預設值)
//   6. 未儲存就切換分頁 ⇒ 小卡窗
//   7. 生日分頁:7 種 LINE 狀態標籤、空狀態文字、LINE 未連線提示、商家文案純文字渲染(不吃 HTML)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BirthdayBonusGrant, MemberSettingsView, MerchantPointFormula } from "./types";

const MERCHANT_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => ({
  role: "admin" as "admin" | "agent" | null,
  agentPointsPermission: false,
  settings: undefined as unknown,
  settingsError: false,
  formulas: [] as unknown[],
  grants: [] as unknown[],
  lineConnected: true,
  saveMock: vi.fn(),
  upsertFormulasMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
  // #1037(C1-E02):「推薦系統」分頁的隱藏開關。正式值是 true(藏起來);
  // 原本驗推薦系統分頁的測試改成「開關打開(false)時才顯示」,不刪測試。
  referralHidden: true,
}));

vi.mock("./referralVisibility", () => ({
  get REFERRAL_UI_HIDDEN() {
    return state.referralHidden;
  },
}));

vi.mock("sonner", () => ({ toast: state.toastMock }));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: MERCHANT_ID, name: "測試商家" } }),
}));

vi.mock("@/modules/staff-agent/context", () => ({
  useCurrentMerchantRole: () => ({ data: state.role }),
  useAgentPermission: () => ({ data: state.agentPointsPermission }),
}));

vi.mock("./RequireMemberPointsAccess", () => ({
  RequireMemberPointsAccess: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/modules/line-notifications/api", () => ({
  useMerchantLineBotPublicInfo: () => ({
    data: { isConnected: state.lineConnected, displayName: null, lineBotBasicId: null },
  }),
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    useMerchantMemberSettings: () => ({
      data: state.settingsError ? undefined : state.settings,
      isLoading: false,
      isError: state.settingsError,
      refetch: vi.fn(),
    }),
    saveMerchantMemberSettings: state.saveMock,
    upsertMemberPointFormulas: state.upsertFormulasMock,
    useMerchantPointFormulas: () => ({
      data: state.formulas,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    usePointFormulaServiceItems: () => ({
      data: [
        { id: "item-ac", name: "冷氣安裝", price: 2200, status: "active" },
        { id: "item-wash", name: "清洗", price: 800, status: "active" },
      ],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useBirthdayBonusGrants: () => ({
      data: state.grants,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
  };
});

// 動態 import:上面的 vi.mock 會被 hoist,這裡 import 的已經是 mock 過的模組。
const { default: MemberPointsPage } = await import("./MemberPointsPage");
const { DEFAULT_MERCHANT_MEMBER_SETTINGS } = await import("./types");

function makeSettings(overrides: Partial<MemberSettingsView> = {}): MemberSettingsView {
  return { ...DEFAULT_MERCHANT_MEMBER_SETTINGS, ...overrides };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <MemberPointsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.referralHidden = true;
  state.role = "admin";
  state.agentPointsPermission = false;
  state.settings = makeSettings({ basic_points_per_order: 3, basic_min_amount: 500 });
  state.settingsError = false;
  state.formulas = [];
  state.grants = [];
  state.lineConnected = true;
  state.saveMock.mockReset().mockResolvedValue(undefined);
  state.upsertFormulasMock.mockReset().mockResolvedValue([]);
  state.toastMock.success.mockReset();
  state.toastMock.error.mockReset();
});

afterEach(() => cleanup());

const TAB_NAMES = ["紅利計算", "點數使用", "推薦系統", "生日獎勵"];

describe("§4.1 分頁顯示條件", () => {
  it("#1037:推薦系統隱藏開關打開(正式值)⇒ 只有三個分頁,看不到推薦系統", () => {
    renderPage();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "紅利計算",
      "點數使用",
      "生日獎勵",
    ]);
    expect(screen.queryByRole("tab", { name: "推薦系統" })).toBeNull();
    expect(screen.queryByText("推薦者消費是否累積紅利")).toBeNull();
  });

  it("管理員 + 功能開啟 + 推薦系統開關關掉(恢復顯示)⇒ 啟用開關獨立區塊 + 四個分頁", () => {
    state.referralHidden = false;
    renderPage();
    expect(screen.getByRole("switch", { name: "啟用紅利點數功能" })).toBeChecked();
    for (const name of TAB_NAMES) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    // 舊的「點數設定」卡片與「消費點數比例」欄位已整個移除。
    expect(screen.queryByText("點數設定")).toBeNull();
    expect(screen.queryByText(/消費點數比例/)).toBeNull();
  });

  it("功能關閉 ⇒ 四個分頁整組不渲染,只剩常駐提醒", () => {
    state.settings = makeSettings({ points_feature_enabled: false });
    renderPage();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText("目前紅利點數功能已關閉")).toBeInTheDocument();
  });

  it("§2.8:只有會員管理、沒有紅利點數管理鑰匙的客服 ⇒ 看不到開關也看不到分頁", () => {
    state.role = "agent";
    state.agentPointsPermission = false;
    renderPage();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("switch", { name: "啟用紅利點數功能" })).toBeNull();
    expect(screen.getByText("你目前的權限看不到這頁的規則設定")).toBeInTheDocument();
  });

  it("§2.8:有紅利點數管理鑰匙的客服 ⇒ 看得到分頁(不放寬也不收緊)", () => {
    state.role = "agent";
    state.agentPointsPermission = true;
    renderPage();
    expect(screen.getByRole("tab", { name: "紅利計算" })).toBeInTheDocument();
  });

  it("讀不到設定 ⇒ 不顯示分頁(不拿預設值猜功能是開著的)", () => {
    state.settingsError = true;
    renderPage();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByText("讀不到紅利點數的設定")).toBeInTheDocument();
  });

  // 第 6 批(#849,QA D-2「假成功」收尾):讀不到設定時**不可以有任何可編輯的欄位**,
  // 否則商家會把預設值當成自己的設定、按了以為存好了。
  it("讀不到設定 ⇒ 開關、資格條件下拉、儲存鈕全部不出現;重新載入按鈕在", () => {
    state.settingsError = true;
    renderPage();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /儲存/ })).toBeNull();
    expect(screen.getByRole("button", { name: /重新載入|再試一次|重試/ })).toBeInTheDocument();
    expect(state.toastMock.success).not.toHaveBeenCalled();
  });

  it("沒有在載入、也沒有錯誤,但就是沒拿到設定 ⇒ 一樣當成讀不到,不顯示可編輯表單", () => {
    state.settings = undefined;
    renderPage();
    expect(screen.getByText("讀不到紅利點數的設定")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("負向對照:讀得到設定時開關與下拉都在(上面兩條不是因為畫面整個沒渲染才過)", () => {
    renderPage();
    expect(screen.getByRole("switch", { name: "啟用紅利點數功能" })).toBeInTheDocument();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });

  it("切換開關時儲存失敗 ⇒ 只跳錯誤,不跳「已停用/已啟用」", async () => {
    state.saveMock.mockReset().mockRejectedValue(new Error("網路斷了"));
    renderPage();
    await userEvent.click(screen.getByRole("switch", { name: "啟用紅利點數功能" }));
    await waitFor(() => expect(state.toastMock.error).toHaveBeenCalled());
    expect(state.toastMock.success).not.toHaveBeenCalled();
  });
});

describe("§4.2 紅利計算", () => {
  it("進階開 ⇒ 基本三欄隱藏(不是灰掉);關回來基本設定的值還在", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByLabelText("每筆訂單獲得")).toHaveValue("3");
    await user.clear(screen.getByLabelText("每筆訂單獲得"));
    await user.type(screen.getByLabelText("每筆訂單獲得"), "7");

    await user.click(screen.getByRole("switch", { name: "進階設定" }));
    expect(screen.queryByTestId("basic-settings")).toBeNull();
    expect(screen.queryByLabelText("每筆訂單獲得")).toBeNull();
    expect(screen.getByText("還沒有任何公式")).toBeInTheDocument();

    await user.click(screen.getByRole("switch", { name: "進階設定" }));
    expect(screen.getByLabelText("每筆訂單獲得")).toHaveValue("7");
  });

  it("每滿額累計開 ⇒ 兩個欄位標籤即時改名", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(screen.getByLabelText("最低消費金額")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "每滿額累計贈點" }));
    expect(screen.getByLabelText("每滿額獲得")).toBeInTheDocument();
    expect(screen.getByLabelText("每滿額消費金額")).toBeInTheDocument();
    expect(screen.queryByLabelText("最低消費金額")).toBeNull();
  });

  it("基本試算:NT$1,000 的訂單(門檻 500、每筆 3 點)⇒ 3 點", () => {
    renderPage();
    expect(screen.getByText(/範例試算/).textContent).toContain("可獲得 3 點");
  });

  it("新增公式:「全部服務項目」那條有常駐 `!` 逐字文案、一句話預覽正確", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("switch", { name: "進階設定" }));
    await user.click(screen.getByRole("button", { name: "新增公式" }));
    const card = screen.getByTestId("formula-card");
    expect(within(card).getByLabelText("公式名稱")).toHaveValue("公式 1");
    expect(card.textContent).toContain(
      "這條套用在還沒有自己公式的服務項目。已經單獨設過公式的項目，吃它自己那條，不會兩邊都拿。",
    );
    expect(within(card).getByTestId("formula-preview")).toHaveTextContent(
      "全部服務項目：數量 × 1點",
    );
  });

  it("公式名稱空白 ⇒ 欄位標紅 + 儲存鈕不能按 + 常駐 `!` 說明原因", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("switch", { name: "進階設定" }));
    await user.click(screen.getByRole("button", { name: "新增公式" }));
    await user.clear(screen.getByLabelText("公式名稱"));
    expect(screen.getByText("請填公式名稱")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "儲存設定" })).toBeDisabled();
    expect(screen.getByText(/上面有公式的欄位填錯了/)).toBeInTheDocument();
  });

  it("個別公式 + 全部並存 ⇒ 個別卡片顯示 (b) 小字與停用後的補充說明", () => {
    state.settings = makeSettings({ earn_mode: "advanced" });
    state.formulas = [
      formula({ id: "f1", name: "全部", service_item_id: null }),
      formula({ id: "f2", name: "冷氣", service_item_id: "item-ac" }),
    ];
    renderPage();
    const cards = screen.getAllByTestId("formula-card");
    expect(cards[1]!.textContent).toContain("這個項目有自己的公式，不吃『全部服務項目』那條。");
    expect(cards[1]!.textContent).toContain(
      "把這條公式關掉後，這個項目會改吃『全部服務項目』那條。",
    );
    expect(cards[0]!.textContent).not.toContain("這個項目有自己的公式");
  });

  it("儲存:先存公式,再只送紅利計算的四個欄位(不碰別的分頁)", async () => {
    const user = userEvent.setup();
    state.settings = makeSettings({ earn_mode: "advanced" });
    state.formulas = [
      formula({ id: "f1", name: "全部", service_item_id: null, points_per_unit: 2 }),
    ];
    renderPage();
    await user.click(screen.getByRole("button", { name: "儲存設定" }));
    await waitFor(() => expect(state.saveMock).toHaveBeenCalledTimes(1));
    expect(state.upsertFormulasMock).toHaveBeenCalledWith(MERCHANT_ID, [
      {
        id: "f1",
        name: "全部",
        enabled: true,
        serviceItemId: null,
        minUnitPrice: 0,
        pointsPerUnit: 2,
        sortOrder: 1,
      },
    ]);
    expect(state.saveMock).toHaveBeenCalledWith(MERCHANT_ID, {
      earnMode: "advanced",
      basicPointsPerOrder: 0,
      basicMinAmount: 0,
      basicTieredEnabled: false,
    });
    expect(state.upsertFormulasMock.mock.invocationCallOrder[0]!).toBeLessThan(
      state.saveMock.mock.invocationCallOrder[0]!,
    );
  });
});

describe("§4.1 未儲存切換分頁", () => {
  it("改了點數使用沒存就切換 ⇒ 小卡窗;留下來改動還在", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "點數使用" }));
    const ratio = screen.getByLabelText("單次最大使用比例");
    await user.clear(ratio);
    await user.type(ratio, "40");
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    expect(await screen.findByText("這個分頁還有改動沒有儲存")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "留下來繼續編輯" }));
    expect(screen.getByLabelText("單次最大使用比例")).toHaveValue("40");
  });

  it("沒有改動 ⇒ 直接切換,不跳窗(推薦系統開關關掉時)", async () => {
    state.referralHidden = false;
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "推薦系統" }));
    expect(screen.queryByText("這個分頁還有改動沒有儲存")).toBeNull();
    expect(screen.getByRole("switch", { name: "推薦者消費是否累積紅利" })).toBeInTheDocument();
  });
});

describe("§4.3 / §4.4", () => {
  it("點數使用:即時範例 + 儲存只送三個欄位", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "點數使用" }));
    await user.type(screen.getByLabelText("兌換比例：點數"), "{Control>}a{/Control}100");
    await user.type(screen.getByLabelText("兌換比例：金額"), "{Control>}a{/Control}10");
    await user.type(screen.getByLabelText("單次最大使用比例"), "{Control>}a{/Control}50");
    expect(screen.getByTestId("redeem-example").textContent).toContain("5000");
    await user.click(screen.getByRole("button", { name: "儲存設定" }));
    await waitFor(() =>
      expect(state.saveMock).toHaveBeenCalledWith(MERCHANT_ID, {
        redeemPointsUnit: 100,
        redeemAmountUnit: 10,
        redeemMaxRatioPercent: 50,
      }),
    );
  });

  it("點數使用:只填點數不填金額 ⇒ 擋下並說明兩個要一起填", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "點數使用" }));
    await user.type(screen.getByLabelText("兌換比例：點數"), "{Control>}a{/Control}100");
    expect(screen.getByRole("button", { name: "儲存設定" })).toBeDisabled();
    expect(screen.getAllByText(/要一起填/).length).toBeGreaterThan(0);
  });

  it("推薦系統(隱藏開關關掉時):開關 1 關閉 ⇒ 兩個數字欄位隱藏,儲存時也不送那兩個值", async () => {
    state.referralHidden = false;
    const user = userEvent.setup();
    state.settings = makeSettings({
      referral_inviter_reward_enabled: true,
      referral_bonus_points: 20,
    });
    renderPage();
    await user.click(screen.getByRole("tab", { name: "推薦系統" }));
    expect(screen.getByLabelText("首次推薦獎勵獲得")).toHaveValue("20");
    await user.click(screen.getByRole("switch", { name: "推薦者邀請是否累積紅利" }));
    expect(screen.queryByTestId("referral-reward-fields")).toBeNull();
    await user.click(screen.getByRole("button", { name: "儲存設定" }));
    await waitFor(() =>
      expect(state.saveMock).toHaveBeenCalledWith(MERCHANT_ID, {
        referralInviterRewardEnabled: false,
        referralInviterEarningEnabled: true,
        referralInviteeEarningEnabled: true,
      }),
    );
  });
});

describe("§4.5 生日獎勵", () => {
  const ALL_STATUSES = [
    ["pending", "待發送"],
    ["sent", "已發送"],
    ["failed", "發送失敗"],
    ["skipped_not_bound", "未綁定略過"],
    ["skipped_not_connected", "商家未連線略過"],
    ["skipped_member_removed", "會員已下架，未發送"],
    ["skipped_merchant_disabled", "商家已停用，未發送"],
    ["skipped_opted_out", "未發送（客人關閉優惠通知）"],
  ] as const;

  it("發送紀錄:8 種 LINE 狀態都顯示對應中文標籤", async () => {
    const user = userEvent.setup();
    state.grants = ALL_STATUSES.map(([status], i) => grant({ id: `g${i}`, lineStatus: status }));
    renderPage();
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    const list = screen.getByTestId("birthday-grants");
    for (const [, label] of ALL_STATUSES) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
    expect(within(list).getAllByRole("listitem")).toHaveLength(ALL_STATUSES.length);
  });

  it("沒有紀錄 ⇒ 空狀態文字", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    expect(screen.getByText("目前尚無生日紅利紀錄")).toBeInTheDocument();
    expect(screen.getByText("最近 50 筆")).toBeInTheDocument();
  });

  it("LINE 未連線 ⇒ 常駐提示;已連線 ⇒ 不顯示", async () => {
    const user = userEvent.setup();
    state.lineConnected = false;
    renderPage();
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    expect(
      screen.getByText("目前尚未完成 LINE 串接，訊息不會發送，點數仍會照發。"),
    ).toBeInTheDocument();
    cleanup();
    state.lineConnected = true;
    renderPage();
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    expect(screen.queryByText(/目前尚未完成 LINE 串接/)).toBeNull();
  });

  it("字數計數 + 變數三欄說明 + 會員實際會收到;商家文案當純文字(不吃 HTML)", async () => {
    const user = userEvent.setup();
    state.settings = makeSettings({
      birthday_bonus_points: 66,
      birthday_line_message: "<b>{{member_name}}</b> 生日快樂 {{points}} 點",
    });
    state.grants = [grant({ id: "g1", memberName: "<img src=x onerror=alert(1)>" })];
    renderPage();
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    expect(screen.getByText("40 / 1000")).toBeInTheDocument();
    expect(screen.getByText("會員實際會收到")).toBeInTheDocument();
    expect(screen.getByText("{{merchant_name}}")).toBeInTheDocument();
    expect(screen.getByText("<b>王小明</b> 生日快樂 66 點")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText(/未綁定 LINE 的會員仍會收到點數/)).toBeInTheDocument();
  });

  it("超過 1000 字 ⇒ 儲存鈕不能按", async () => {
    const user = userEvent.setup();
    state.settings = makeSettings({ birthday_line_message: "字".repeat(1001) });
    renderPage();
    await user.click(screen.getByRole("tab", { name: "生日獎勵" }));
    expect(screen.getByRole("button", { name: "儲存設定" })).toBeDisabled();
    expect(screen.getByText(/最多 1000 個字，目前 1001 個字/)).toBeInTheDocument();
  });
});

function formula(partial: Partial<MerchantPointFormula>): MerchantPointFormula {
  return {
    id: "f",
    merchant_id: MERCHANT_ID,
    name: "公式",
    enabled: true,
    service_item_id: null,
    min_unit_price: 0,
    points_per_unit: 1,
    sort_order: 1,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...partial,
  };
}

function grant(partial: Partial<BirthdayBonusGrant>): BirthdayBonusGrant {
  return {
    id: "g",
    memberName: "王小明",
    points: 50,
    bonusYear: 2026,
    anchorDate: "2026-10-01",
    lineStatus: "sent",
    lineError: null,
    grantedAt: "2026-09-30T16:05:00Z",
    lineAttemptedAt: null,
    ...partial,
  };
}

// 第 11 批 D(#991,2026-10-07):人工電話驗證標記退場 ⇒ 核發獎勵資格條件只剩 2 個選項,
// 「電話已驗證只是客服人工標記」那則常駐 `!` 一併拿掉(說的東西已不存在)。
describe("第 11 批 D:核發獎勵資格條件只剩 2 個選項", () => {
  function stubRadixPointerApis() {
    // jsdom 沒有這幾個 API,Radix Select 打開時會呼叫。
    const proto = Element.prototype as unknown as Record<string, unknown>;
    proto["hasPointerCapture"] ??= () => false;
    proto["releasePointerCapture"] ??= () => undefined;
    proto["scrollIntoView"] ??= () => undefined;
  }

  it("下拉打開只有「不限制」「只看 LINE 已綁定」兩個選項", async () => {
    stubRadixPointerApis();
    renderPage();
    await userEvent.click(screen.getByRole("combobox", { name: "資格條件" }));
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["不限制", "只看 LINE 已綁定"]);
  });

  it("選「只看 LINE 已綁定」⇒ 存 line_bound", async () => {
    stubRadixPointerApis();
    renderPage();
    await userEvent.click(screen.getByRole("combobox", { name: "資格條件" }));
    await userEvent.click(await screen.findByRole("option", { name: "只看 LINE 已綁定" }));
    await waitFor(() =>
      expect(state.saveMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ rewardConditionMode: "line_bound" }),
      ),
    );
  });

  it("不再出現「電話已驗證只是客服人工標記」的提醒,畫面上也沒有任何「電話已驗證」", () => {
    renderPage();
    expect(screen.queryByText(/客服人工標記/)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/電話已驗證/);
  });

  it("D-4:資料庫若讀到已退場的舊值(理論上被 CHECK 擋住)⇒ 頁面照樣渲染不崩潰", () => {
    state.settings = makeSettings({ reward_condition_mode: "either" });
    renderPage();
    expect(screen.getByRole("combobox", { name: "資格條件" })).toBeInTheDocument();
    expect(screen.getByText("核發獎勵資格條件")).toBeInTheDocument();
  });
});
