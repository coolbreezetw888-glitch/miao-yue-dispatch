// 客戶端第 1 批(C1):公開預約頁元件測試(資料庫函式用假資料頂著,真函式的驗證在 e2e-local)。
//   C1-A01 找不到 / 暫停(停用的店不顯示店名)
//   C1-A02 主題色 + 分頁標題,離開時還原
//   C1-A03 / A04 店家首頁、聯絡按鈕
//   C1-A05~A09 一路走到 ⑤、上一步保留已選、⑤ 的停用按鈕、到府 / 到店的地址欄位
//   C1-A10 讀取失敗:中文訊息 + 重新整理,不顯示原始錯誤字串
//   C1-F04 商家簡介含 <script> 字樣時照原字串顯示

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicAvailableSlots, PublicBookingPage, PublicBookingPageOk } from "./types";

const state = vi.hoisted(() => ({
  page: null as unknown,
  pageError: null as unknown,
  slots: null as unknown,
  slotsCalls: [] as unknown[],
}));

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    fetchPublicBookingPage: vi.fn(async () => {
      if (state.pageError) throw state.pageError;
      return state.page;
    }),
    fetchPublicAvailableSlots: vi.fn(async (params: unknown) => {
      state.slotsCalls.push(params);
      return state.slots;
    }),
  };
});

const { default: PublicBookingPage } = await import("./PublicBookingPage");
const { PublicBookingError } = await import("./api");
const { taipeiToday, addDays } = await import("./publicBookingLogic");

function makePage(
  overrides: Partial<PublicBookingPageOk["merchant"]> = {},
  extra: Partial<PublicBookingPageOk> = {},
): PublicBookingPage {
  return {
    status: "ok",
    merchant: {
      name: "涼風工匠",
      industry_type: "on_site_dispatch",
      logo_url: null,
      address: "台北市大安區復興南路一段 100 號",
      phone: "02-1234-5678",
      intro: "專做家用冷氣清洗十年。",
      theme_preset: null,
      theme_custom_color: "#FF7A30",
      announcement: "十月起週日公休。",
      line_friend_url: "https://lin.ee/abc",
      ...overrides,
    },
    booking_settings: {
      allow_guest_booking: true,
      is_on_site: (overrides.industry_type ?? "on_site_dispatch") === "on_site_dispatch",
      line_login_enabled: false,
      customer_cancel_deadline_hours: 24,
    },
    member_policy: { enabled: false, content: null },
    categories: [{ id: "split", name: "分離式冷氣" }],
    service_items: [
      {
        id: "indoor",
        category_id: "split",
        name: "室內機清洗",
        description: "拆洗濾網",
        price: 2500,
        duration_minutes: 90,
        item_type: "primary",
      },
      {
        id: "outdoor",
        category_id: "split",
        name: "室外機清洗",
        description: null,
        price: 1200,
        duration_minutes: 60,
        item_type: "primary",
      },
      {
        id: "coat",
        category_id: null,
        name: "抗菌塗層",
        description: null,
        price: 300,
        duration_minutes: 15,
        item_type: "addon",
      },
    ],
    staff: [
      {
        id: "s-ming",
        display_name: "阿明",
        avatar_url: null,
        intro: "資歷 8 年",
        primary_service_item_ids: null,
      },
      {
        id: "s-chen",
        display_name: "小陳",
        avatar_url: null,
        intro: null,
        primary_service_item_ids: ["outdoor"],
      },
    ],
    ...extra,
  };
}

function makeSlots(): PublicAvailableSlots {
  const today = taipeiToday();
  return {
    duration_minutes: 240,
    days: Array.from({ length: 7 }, (_, i) => {
      const date = addDays(today, i);
      if (i === 0) return { date, state: "out_of_range" as const, times: [] };
      if (i === 3) return { date, state: "closed" as const, times: [] };
      if (i === 4) return { date, state: "full" as const, times: [] };
      return { date, state: "open" as const, times: ["09:00", "10:00", "13:30", "18:30"] };
    }),
  };
}

let navigateRef: ReturnType<typeof useNavigate> | null = null;
function NavigateCapture() {
  navigateRef = useNavigate();
  return null;
}

function renderPage(path = "/booking/cool-shop") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app", path]} initialIndex={1}>
        <NavigateCapture />
        <Routes>
          <Route path="/booking/:slug" element={<PublicBookingPage />} />
          <Route path="/app" element={<p>後台</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.page = makePage();
  state.pageError = null;
  state.slots = makeSlots();
  state.slotsCalls = [];
  document.title = "秒約";
  document.documentElement.style.removeProperty("--brand");
});
afterEach(() => cleanup());

describe("C1-A01 / A10 狀態頁", () => {
  it("代碼不存在 ⇒ 中文訊息(不是英文 404)", async () => {
    state.page = { status: "not_found" };
    renderPage();
    expect(await screen.findByTestId("public-booking-not-found")).toHaveTextContent(
      "請向店家確認連結是否正確",
    );
    expect(document.body.textContent).not.toMatch(/404|not found/i);
  });

  it("停用商家 ⇒ 暫停訊息,畫面上沒有任何店家資料", async () => {
    state.page = { status: "unavailable" };
    renderPage();
    expect(await screen.findByText("這間店目前暫停線上預約")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("涼風工匠");
  });

  it("讀取失敗 ⇒「讀取失敗，請稍後再試」+ 重新整理;不顯示原始錯誤字串;按了會重抓", async () => {
    state.pageError = new PublicBookingError(
      "network",
      "PGRST301 relation merchants secret detail",
    );
    renderPage();
    const error = await screen.findByTestId("public-booking-error", {}, { timeout: 4000 });
    expect(error).toHaveTextContent("讀取失敗，請稍後再試");
    expect(document.body.textContent).not.toMatch(/PGRST|relation|secret|public-booking:/);
    state.pageError = null;
    await userEvent.setup().click(screen.getByRole("button", { name: "重新整理" }));
    expect(await screen.findByTestId("public-booking-shop-name")).toHaveTextContent("涼風工匠");
  });

  it("網址代碼大小寫:一律轉小寫查詢", async () => {
    const api = await import("./api");
    renderPage("/booking/Cool-SHOP");
    await screen.findByTestId("public-booking-shop-name");
    expect(api.fetchPublicBookingPage).toHaveBeenLastCalledWith("cool-shop");
  });
});

describe("C1-A02 / A03 / A04 店家首頁", () => {
  it("主題色、分頁標題 = 店名;離開時兩個都還原", async () => {
    renderPage();
    await screen.findByTestId("public-booking-shop-name");
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--brand")).toBe("#FF7A30"),
    );
    expect(document.title).toBe("涼風工匠");
    act(() => navigateRef!("/app"));
    expect(await screen.findByText("後台")).toBeInTheDocument();
    expect(document.documentElement.style.getPropertyValue("--brand")).toBe("");
    expect(document.title).toBe("秒約");
  });

  it("Logo 沒有圖 ⇒ 店名前兩個字;到府標籤、地址、簡介、公告、兩顆聯絡按鈕", async () => {
    renderPage();
    expect(await screen.findByTestId("public-booking-logo-text")).toHaveTextContent("涼風");
    expect(screen.getByText("到府服務")).toBeInTheDocument();
    expect(screen.getByTestId("public-booking-address")).toBeInTheDocument();
    expect(screen.getByTestId("public-booking-intro")).toBeInTheDocument();
    expect(screen.getByTestId("public-booking-announcement")).toHaveTextContent("十月起週日公休。");
    const line = screen.getByRole("link", { name: /LINE 聯絡店家/ });
    expect(line).toHaveAttribute("href", "https://lin.ee/abc");
    expect(line).toHaveAttribute("target", "_blank");
    expect(line).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: /撥打電話/ })).toHaveAttribute(
      "href",
      "tel:0212345678",
    );
    // 這批不顯示「會員中心」
    expect(screen.queryByText("會員中心")).toBeNull();
  });

  it("沒填地址 / 簡介 / 公告、也沒有聯絡方式 ⇒ 那幾塊整個不顯示(沒有空白標題)", async () => {
    state.page = makePage({
      address: null,
      intro: "  ",
      announcement: null,
      phone: null,
      line_friend_url: null,
    });
    renderPage();
    await screen.findByTestId("public-booking-shop-name");
    expect(screen.queryByTestId("public-booking-address")).toBeNull();
    expect(screen.queryByText("店家簡介")).toBeNull();
    expect(screen.queryByText("公告")).toBeNull();
    expect(screen.queryByTestId("public-booking-contacts")).toBeNull();
  });

  it("只有電話 ⇒ 只有撥打電話一顆", async () => {
    state.page = makePage({ line_friend_url: null });
    renderPage();
    await screen.findByTestId("public-booking-shop-name");
    expect(within(screen.getByTestId("public-booking-contacts")).getAllByRole("link")).toHaveLength(
      1,
    );
    expect(screen.queryByRole("link", { name: /LINE/ })).toBeNull();
  });

  it("C1-F04:簡介含 <script> 字樣時照原字串顯示(不解析 HTML)", async () => {
    state.page = makePage({ intro: "<script>alert('x')</script><b>粗體</b>" });
    renderPage();
    const intro = await screen.findByTestId("public-booking-intro");
    expect(intro).toHaveTextContent("<script>alert('x')</script><b>粗體</b>");
    expect(intro.querySelector("script")).toBeNull();
    expect(intro.querySelector("b")).toBeNull();
  });
});

describe("C1-A05~A09 預約流程", () => {
  it("沒有任何上架中的服務 ⇒ ② 顯示請直接聯絡店家,沒有下一步", async () => {
    state.page = makePage({}, { service_items: [] });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("public-booking-start"));
    expect(screen.getByTestId("public-booking-no-services")).toHaveTextContent(
      "店家還沒有開放線上預約的服務，請直接聯絡店家。",
    );
    expect(screen.queryByTestId("public-booking-next")).toBeNull();
  });

  it("一路走到 ⑤:時長 / 金額、只選加購擋下、上一步保留、⑤ 停用按鈕與摘要", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("public-booking-start"));
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent(/步驟 1／5\s*選服務/);

    // 只選加購 ⇒ 下一步停用 + 常駐說明
    await user.click(screen.getByRole("tab", { name: "加購項目" }));
    await user.click(screen.getByRole("checkbox", { name: /抗菌塗層/ }));
    expect(screen.getByTestId("public-booking-next")).toBeDisabled();
    expect(screen.getByTestId("public-booking-service-blocked")).toHaveTextContent(
      "請至少選一項主要服務。",
    );

    // 室內機 ×2 + 室外機 ×1 + 塗層 ×1
    await user.click(screen.getByRole("tab", { name: "分離式冷氣" }));
    await user.click(screen.getByRole("checkbox", { name: /室內機清洗/ }));
    await user.click(screen.getByRole("button", { name: "增加「室內機清洗」的數量" }));
    await user.click(screen.getByRole("checkbox", { name: /室外機清洗/ }));
    expect(screen.getByTestId("public-booking-total-duration")).toHaveTextContent(
      "大約 4 小時 15 分鐘",
    );
    expect(screen.getByTestId("public-booking-total-price")).toHaveTextContent("NT$ 6,500");
    expect(screen.getByTestId("public-booking-selected-count")).toHaveTextContent(
      "已選 3 項（共 4 份）",
    );
    await user.click(screen.getByTestId("public-booking-next"));

    // ③ 不指定預設選中;小陳只會室外機 ⇒ 不出現
    expect(screen.getByTestId("public-booking-staff-any")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("public-booking-staff-s-ming")).toBeInTheDocument();
    expect(screen.queryByTestId("public-booking-staff-s-chen")).toBeNull();
    await user.click(screen.getByTestId("public-booking-staff-s-ming"));
    await user.click(screen.getByTestId("public-booking-next"));

    // ④ 日期狀態 + 時間分組
    const today = taipeiToday();
    await screen.findByTestId("public-booking-times");
    expect(screen.getByTestId(`public-booking-day-${today}`)).toBeDisabled();
    expect(screen.getByTestId(`public-booking-day-${addDays(today, 3)}`)).toHaveTextContent("公休");
    expect(screen.getByTestId(`public-booking-day-${addDays(today, 4)}`)).toHaveTextContent("已滿");
    expect(screen.getByText("晚上")).toBeInTheDocument();
    expect(screen.getByTestId("public-booking-onsite-note")).toHaveTextContent(
      "預約時間為預計抵達時間，可能因交通稍有誤差，可與店家確認。",
    );
    expect(screen.getByTestId("public-booking-prev-week")).toBeDisabled();
    expect(state.slotsCalls.at(-1)).toEqual({
      slug: "cool-shop",
      items: [
        { service_item_id: "coat", quantity: 1 },
        { service_item_id: "indoor", quantity: 2 },
        { service_item_id: "outdoor", quantity: 1 },
      ],
      staffId: "s-ming",
      from: today,
      days: 7,
    });
    expect(screen.getByTestId("public-booking-next")).toBeDisabled();
    await user.click(screen.getByTestId("public-booking-time-10:00"));
    expect(screen.getByTestId("public-booking-slot-summary")).toHaveTextContent(
      "10:00 開始，預計 14:00 左右完成（共約 4 小時）。",
    );

    // 上一步回 ③:服務人員仍然被選著
    await user.click(screen.getByRole("button", { name: "回上一步" }));
    expect(screen.getByTestId("public-booking-staff-s-ming")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(await screen.findByTestId("public-booking-time-10:00"));
    await user.click(screen.getByTestId("public-booking-next"));

    // ⑤
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent(/步驟 4／5\s*填資料/);
    const summary = screen.getByTestId("public-booking-summary");
    expect(summary).toHaveTextContent("阿明");
    expect(summary).toHaveTextContent("抗菌塗層 ×1、室內機清洗 ×2、室外機清洗 ×1");
    expect(summary).toHaveTextContent("NT$ 6,500");
    // 客戶端第 3 批(C3-D01):沒有 LINE 登入、允許不登入 ⇒「確定預約」可以按(直接到 ⑥-4)。
    const submit = screen.getByTestId("public-booking-submit");
    expect(submit).toBeEnabled();
    expect(submit).toHaveTextContent("確定預約");
    expect(document.body.textContent).not.toContain("線上預約即將開放");
    expect(screen.getByLabelText(/服務地址/)).toBeInTheDocument();
    // 姓名空白離開欄位 ⇒ 中文提示
    await user.click(screen.getByLabelText(/姓名/));
    await user.tab();
    expect(screen.getByText("請填寫姓名。")).toBeInTheDocument();
    // 客人輸入當純文字
    await user.type(screen.getByLabelText(/備註/), "<img src=x>");
    expect(screen.getByLabelText(/備註/)).toHaveValue("<img src=x>");
  });

  it("回上一步改了服務 ⇒ 已選的時間清空;到店商家 ⑤ 沒有地址欄位", async () => {
    state.page = makePage({ industry_type: "in_store_beauty" });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("public-booking-start"));
    await user.click(screen.getByRole("checkbox", { name: /室內機清洗/ }));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(await screen.findByTestId("public-booking-time-09:00"));
    expect(screen.queryByTestId("public-booking-onsite-note")).toBeNull();
    // 回 ② 加一項 ⇒ 再到 ④ 時間要重選
    await user.click(screen.getByRole("button", { name: "回上一步" }));
    await user.click(screen.getByRole("button", { name: "回上一步" }));
    await user.click(screen.getByRole("checkbox", { name: /室外機清洗/ }));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(screen.getByTestId("public-booking-next"));
    await screen.findByTestId("public-booking-times");
    expect(screen.getByTestId("public-booking-time-09:00")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByTestId("public-booking-next")).toBeDisabled();
    await user.click(screen.getByTestId("public-booking-time-09:00"));
    await user.click(screen.getByTestId("public-booking-next"));
    expect(screen.queryByLabelText(/服務地址/)).toBeNull();
  });

  it("沒有會做這些服務的服務人員 ⇒ 不顯示不指定,改顯示說明 + 上一步", async () => {
    state.page = makePage(
      {},
      {
        staff: [
          {
            id: "s-chen",
            display_name: "小陳",
            avatar_url: null,
            intro: null,
            primary_service_item_ids: ["outdoor"],
          },
        ],
      },
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("public-booking-start"));
    await user.click(screen.getByRole("checkbox", { name: /室內機清洗/ }));
    await user.click(screen.getByTestId("public-booking-next"));
    expect(screen.getByTestId("public-booking-no-staff")).toHaveTextContent(
      "目前沒有可以預約這些服務的服務人員，請聯絡店家或改選其他服務。",
    );
    expect(screen.queryByTestId("public-booking-staff-any")).toBeNull();
    await user.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getByTestId("public-booking-step-label")).toHaveTextContent("步驟 1／5");
  });

  it("時段讀取失敗 ⇒ 中文錯誤 + 重新整理,不顯示原始錯誤", async () => {
    const api = await import("./api");
    // 會自動重試一次 ⇒ 兩次都失敗才會顯示錯誤畫面。
    vi.mocked(api.fetchPublicAvailableSlots).mockRejectedValueOnce(
      new PublicBookingError("network", "57014 canceling statement due to statement timeout"),
    );
    vi.mocked(api.fetchPublicAvailableSlots).mockRejectedValueOnce(
      new PublicBookingError("network", "57014 canceling statement due to statement timeout"),
    );
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByTestId("public-booking-start"));
    await user.click(screen.getByRole("checkbox", { name: /室內機清洗/ }));
    await user.click(screen.getByTestId("public-booking-next"));
    await user.click(screen.getByTestId("public-booking-next"));
    expect(
      await screen.findByTestId("public-booking-error", {}, { timeout: 4000 }),
    ).toHaveTextContent("讀取失敗，請稍後再試");
    expect(document.body.textContent).not.toMatch(/57014|statement timeout/);
    await user.click(screen.getByRole("button", { name: "重新整理" }));
    expect(await screen.findByTestId("public-booking-times")).toBeInTheDocument();
  });
});
