// 服務人員權限設定頁的畫面測試。
//
// 這支測試釘住 SPECS-INDEX #877 與 #879 的行為,兩條都是「畫面上的字跟實際行為不一致」的問題:
//
// 🔴 #877(使用者裁決 B):四筆 merchant_staff_permissions 紀錄是服務人員「第一次登入成功」那一刻
//    才由 seed_default_staff_permissions 建立,而且一律建成「開」;但這頁的 Switch 是
//    `grantedMap.get(key) ?? false`,查不到紀錄就顯示「關」。
//    ⇒ 對還沒完成登入的人,這頁顯示的「四項全關」是假的,必須用常駐 `!`(AlertNote)講清楚。
//    刻意**不改** `?? false`(那個方向是安全的),只補提示 —— 所以這裡同時釘住
//    「開關仍然顯示關」+「提示有出現」兩件事,避免之後有人把判斷改成「沒紀錄當成開」。
//
// 🔴 #879 ①:原本 CardDescription 寫「只影響……自己的資料」是錯的,「行事曆檢視」開放的預約明細
//    裡有**客戶**的姓名/電話/地址/備註。這支測試擋住那句錯的話回來。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MerchantStaff } from "./types";

const fetchMerchantStaffMock = vi.fn();
const fetchStaffPermissionsMock = vi.fn();
const setStaffPermissionMock = vi.fn();

// SPECS-INDEX #1025 FG-3:平台功能開關全開(這支測試不測開關;開關的行為見 staffFeatureGates.test.tsx)。
vi.mock("@/modules/merchant/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/merchant/features")>()),
  useMerchantFeatures: () => ({
    features: [],
    hasFeature: () => true,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("./api", () => ({
  fetchMerchantStaff: (...args: unknown[]) => fetchMerchantStaffMock(...args),
}));

vi.mock("@/modules/staff-portal/api", () => ({
  fetchStaffPermissions: (...args: unknown[]) => fetchStaffPermissionsMock(...args),
  setStaffPermission: (...args: unknown[]) => setStaffPermissionMock(...args),
}));

vi.mock("@/modules/merchant/context", () => ({
  useCurrentMerchant: () => ({ merchant: { id: "merchant-1" }, isLoading: false }),
}));

// 守衛本身有自己的測試,這頁只測內容,所以讓守衛直接放行。
vi.mock("./RequireMerchantAdmin", () => ({
  RequireMerchantAdmin: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import StaffPermissionsPage from "./StaffPermissionsPage";

function makeStaff(loginStatus: "not_invited" | "invited" | "active"): MerchantStaff {
  return {
    id: "staff-1",
    merchant_id: "merchant-1",
    name: "阿哲",
    login_status: loginStatus,
    status: "active",
    compensation_type: "piece_rate",
  } as unknown as MerchantStaff;
}

async function renderPage(loginStatus: "not_invited" | "invited" | "active") {
  fetchMerchantStaffMock.mockResolvedValue([makeStaff(loginStatus)]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/app/staff/staff-1/permissions"]}>
        <Routes>
          <Route path="/app/staff/:staffId/permissions" element={<StaffPermissionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // 四個開關要等 fetchStaffPermissions 回來、骨架換成清單之後才進 DOM。
  await screen.findByText("行事曆檢視");
}

const NOT_LOGGED_IN_HINT = /還沒完成登入/;

describe("StaffPermissionsPage(#877 / #879)", () => {
  beforeEach(() => {
    fetchMerchantStaffMock.mockReset();
    fetchStaffPermissionsMock.mockReset().mockResolvedValue([]);
    setStaffPermissionMock.mockReset().mockResolvedValue(undefined);
  });

  // 這個專案的 vitest 沒有開 globals,@testing-library/react 的自動 cleanup 不會生效。
  afterEach(() => {
    cleanup();
  });

  it("#877:還沒開通登入(not_invited)時,權限卡上有常駐提示說明四項會在第一次登入時全開", async () => {
    await renderPage("not_invited");

    const note = screen.getByText(NOT_LOGGED_IN_HINT);
    expect(note).toBeInTheDocument();
    expect(note.textContent).toContain("四項權限會在他第一次登入時預設全部開啟");
  });

  it("#877:已寄出邀請但還沒完成登入(invited)時,提示同樣要出現", async () => {
    await renderPage("invited");

    expect(screen.getByText(NOT_LOGGED_IN_HINT)).toBeInTheDocument();
  });

  it("#877:已完成登入(active)時不顯示這則提示", async () => {
    await renderPage("active");

    expect(screen.queryByText(NOT_LOGGED_IN_HINT)).toBeNull();
  });

  it("#877:提示用的是常駐 `!`(AlertNote,role=note),不是要點開的 `?` 按鈕", async () => {
    await renderPage("not_invited");

    const notes = screen.getAllByRole("note");
    expect(notes.some((n) => NOT_LOGGED_IN_HINT.test(n.textContent ?? ""))).toBe(true);
    // 這則提示不可以是可收合的問號鈕(ui-overlay-patterns 二之三)。
    expect(screen.queryByRole("button", { name: /說明/ })).toBeNull();
  });

  it("#877:刻意不改 `?? false` —— 查不到權限紀錄時四個開關仍然顯示「關」", async () => {
    await renderPage("not_invited");

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    for (const s of switches) {
      expect(s).toHaveAttribute("aria-checked", "false");
    }
  });

  it("#879 ①:卡片說明要講明行事曆檢視會看到客戶個資,不能再寫成「只影響自己的資料」", async () => {
    await renderPage("active");

    // ⚠️ 這裡刻意用「卡片說明專屬的開頭那句」定位,不用 getByText(/客戶的姓名…/) —— #882 之後
    // 「行事曆檢視」那一列的逐項說明也有同一串字,全畫面搜尋會同時命中兩個元素而爆掉。
    // 兩邊各自都要有這段話是**刻意的**(#882 的理由:管理員看的是開關旁邊那一行),不是重複贅字。
    const cardDescription = screen.getByText(/這四項決定這位服務人員登入服務人員端後/);
    expect(cardDescription.textContent).toContain("客戶的姓名、電話、地址與備註");
    expect(cardDescription.textContent).not.toContain(
      "只影響這位服務人員自己能不能看到/操作自己的資料",
    );
  });

  it("#879 ②:抽成/薪資報表的說明要寫「自訂起訖日期區間」,不是「某個月」", async () => {
    await renderPage("active");

    const payrollRow = screen.getByText("抽成/薪資報表檢視").closest("li");
    expect(payrollRow?.textContent).toContain("自訂起訖日期");
    expect(payrollRow?.textContent).toContain("最長查一年");
    expect(payrollRow?.textContent).not.toContain("某個月");
  });

  it("#879 ③:個人資料編輯的說明要寫出電話必填 + 09 開頭 10 碼", async () => {
    await renderPage("active");

    const profileRow = screen.getByText("個人資料編輯").closest("li");
    expect(profileRow?.textContent).toContain("電話是必填");
    expect(profileRow?.textContent).toContain("09 開頭的 10 碼");
  });

  // 🔴 #882:#879 ① 只改了卡片標題下方那段說明,但管理員實際撥開關時看的是**開關旁邊那一行**。
  // 所以「行事曆檢視」自己的逐項說明也必須講到客戶個資,否則等於只補了一半。
  it("#882:「行事曆檢視」開關旁邊那一行自己就要講到客戶個資,不能只靠卡片說明", async () => {
    await renderPage("active");

    const calendarRow = screen.getByText("行事曆檢視").closest("li");
    // 🔴 #928:原本斷言的是「客戶的姓名、電話、地址、備註」,但那個寫法把兩個**有條件**的欄位
    // 講成無條件的(地址看產業、內部備註可逐單隱藏),所以文案與斷言一起改成條件式說法。
    // 這裡只驗「有講到客戶個資」這件事本身,條件的部分交給下面 #928 那條專門驗。
    // #977 第 3 批(2026-10-06):電話、地址改成要同時開「服務人員是否顯示會員資料」才顯示,說明改寫成
    // 「客戶姓名、客戶備註」+ 下面 #977 那條驗的條件句;這裡驗的「有講到客戶個資」本身不變。
    expect(calendarRow?.textContent).toContain("客戶姓名、客戶備註");
    // 舊說法只講「查看自己的行事曆/預約排程」就結束,不能再回來。
    expect(calendarRow?.textContent).toContain("接觸客戶個資");
  });

  // 🔴 #928(QA 抓到 #882 的需求原文不夠精確,主腦裁決要修):「地址」和「備註」都是有條件的 ——
  // 地址只有「到府派工」產業的商家才顯示(in_store_beauty 不顯示),內部備註受 #851 逐單控制。
  // 說明寫得太絕對,商家會以為 #851 那個「這一筆不讓服務人員看到內部備註」的開關沒用。
  // ⚠️ 方向是「講清楚條件」,不是把地址刪掉 —— customer_address 照樣會送到服務人員的裝置上。
  it("#928:「行事曆檢視」要寫出地址看產業、內部備註可逐單隱藏這兩個條件", async () => {
    await renderPage("active");

    const calendarRow = screen.getByText("行事曆檢視").closest("li");
    // ① 地址要標明是「到府派工」才有,不能無條件寫「地址」。
    // #977 第 3 批:句子改成「地址只有到府派工類型的商家才會顯示」(條件本身沒變)。
    expect(calendarRow?.textContent).toContain("地址只有到府派工類型的商家才會顯示");
    // ② 兩種備註要分開:客戶備註一律有、內部備註可逐單隱藏。
    expect(calendarRow?.textContent).toContain("內部備註可以逐單另外隱藏");
    // 🔴 不能退回成無條件的「地址、備註」並列寫法(那正是 #928 要修掉的說法)。
    expect(calendarRow?.textContent).not.toContain("客戶的姓名、電話、地址、備註");
  });

  // 🔴 #883 ②:會員資料(含紅利點數)是 merchant_staff.show_member_info「顯示會員資料」那個
  // **獨立開關**控制的,不是這一項。沒有這句指路,管理員會以為開了行事曆檢視就會看到會員點數。
  it("#883 ②:「行事曆檢視」要指路到「顯示會員資料」那個獨立開關", async () => {
    await renderPage("active");

    const calendarRow = screen.getByText("行事曆檢視").closest("li");
    expect(calendarRow?.textContent).toContain("顯示會員資料");
    expect(calendarRow?.textContent).toContain("紅利點數餘額");
    // 🔴 不可以反過來變成「這一項會給點數」的暗示 —— 必須明講要另外開那個開關。
    // #977 第 3 批:句子改成「同樣要開啟「服務人員是否顯示會員資料」才看得到」。
    expect(calendarRow?.textContent).toContain("同樣要開啟「服務人員是否顯示會員資料」才看得到");
  });

  // 🔴 #977 第 3 批(2026-10-06,使用者裁決 H-13):「服務人員是否顯示會員資料」關閉時,電話、地址在後端就不回傳。
  // 管理員撥「行事曆檢視」時要知道:只開這一項,服務人員看不到客戶電話、地址。
  it("#977:「行事曆檢視」說明寫出客戶電話、地址要同時開「服務人員是否顯示會員資料」", async () => {
    await renderPage("active");

    const calendarRow = screen.getByText("行事曆檢視").closest("li");
    expect(calendarRow?.textContent).toContain(
      "客戶電話、地址需同時開啟「服務人員是否顯示會員資料」才會顯示",
    );
    // 新文字一律全形標點:這段說明不可再出現半形逗號、冒號、括號。
    const section = calendarRow?.textContent ?? "";
    expect(section).not.toMatch(/[,:()]/);
  });

  it("#882 順手盤點:「可預約時段/休假自助調整」要寫出時段排休(不只是整天)", async () => {
    await renderPage("active");

    const availabilityRow = screen.getByText("可預約時段/休假自助調整").closest("li");
    expect(availabilityRow?.textContent).toContain("單一半小時時段");
    // 既有的「僅抽成制可用」那句不能因為改寫而掉了。
    expect(availabilityRow?.textContent).toContain("僅抽成制服務人員可以使用");
  });

  it("#882 順手盤點:抽成報表也會看到客戶姓名,說明要寫出來(並講明範圍比行事曆小)", async () => {
    await renderPage("active");

    const payrollRow = screen.getByText("抽成/薪資報表檢視").closest("li");
    expect(payrollRow?.textContent).toContain("顯示客戶姓名");
    expect(payrollRow?.textContent).toContain("不含電話、地址與備註");
  });
});
