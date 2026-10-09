// 客戶端第 5 批 5-A(C5-M01 / M02):⑧ 加好友提示卡、⑪-1「LINE 通知」區塊(主要 / 第二聯絡人、有 / 沒加好友、
// 切換成功 / 失敗退回)。資料庫函式用假的頂著(真的接口在 e2e-local c5a-line-notify 驗)。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  prefs: null as unknown,
  setResult: null as unknown,
  setError: false,
  setCalls: [] as unknown[],
  toasts: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: Object.assign((msg: string) => state.toasts.push(msg), {
    success: (msg: string) => state.toasts.push(msg),
    error: (msg: string) => state.toasts.push(msg),
  }),
}));

vi.mock("./lineNotifyApi", async () => {
  const actual = await vi.importActual<typeof import("./lineNotifyApi")>("./lineNotifyApi");
  const logic = await vi.importActual<typeof import("./lineNotifyLogic")>("./lineNotifyLogic");
  return {
    ...actual,
    fetchMyNotifyPrefs: vi.fn(async () => logic.parseMemberNotifyPrefs(state.prefs)),
    setMyNotifyPrefs: vi.fn(async (_slug: string, patch: unknown) => {
      state.setCalls.push(patch);
      if (state.setError) throw new Error("network");
      return logic.parseMemberNotifyPrefs(state.setResult);
    }),
  };
});

const { MemberAddFriendCard, MemberLineNotifySection } = await import("./MemberLineNotify");
const { addFriendDismissKey } = await import("./lineNotifyLogic");

const URL_OK = "https://line.me/R/ti/p/%40abc1234";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  state.prefs = null;
  state.setResult = null;
  state.setError = false;
  state.setCalls = [];
  state.toasts = [];
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("C5-M01 ⑧ 加好友提示卡", () => {
  const ln = {
    available: true,
    notifyBooking: true,
    friendStatus: "unknown" as const,
    addFriendUrl: URL_OK,
  };

  it("顯示:標題、說明、綠色「加入好友」外部連結(新分頁)、文字按鈕「稍後再說」", async () => {
    wrap(<MemberAddFriendCard slug="demo" merchantName="涼風工匠" lineNotify={ln} />);
    const card = screen.getByTestId("member-home-add-friend");
    expect(card).toHaveTextContent("加入「涼風工匠」LINE 好友");
    expect(card).toHaveTextContent("預約確認、改時間等消息都會用 LINE 通知你。");
    const go = within(card).getByRole("link", { name: /加入好友/ });
    expect(go).toHaveAttribute("href", URL_OK);
    expect(go).toHaveAttribute("target", "_blank");
    expect(go.getAttribute("rel")).toContain("noopener");
    expect(go.className).toContain("bg-[#06C755]");
    await userEvent.click(go);
    expect(screen.getByTestId("member-home-add-friend-after")).toHaveTextContent(
      "加好友後回到這裡重新整理就好。",
    );
  });

  it("稍後再說 ⇒ 卡片消失,記在瀏覽器(7 天)", async () => {
    wrap(<MemberAddFriendCard slug="demo" merchantName="涼風工匠" lineNotify={ln} />);
    await userEvent.click(screen.getByTestId("member-home-add-friend-later"));
    expect(screen.queryByTestId("member-home-add-friend")).toBeNull();
    expect(window.localStorage.getItem(addFriendDismissKey("demo"))).not.toBeNull();
  });

  it.each([
    ["已加好友", { friendStatus: "friend" as const }],
    ["店家不能用", { available: false }],
    ["關掉預約通知", { notifyBooking: false }],
    ["沒有網址", { addFriendUrl: null }],
  ])("%s ⇒ 不顯示", (_name, over) => {
    wrap(
      <MemberAddFriendCard slug="demo" merchantName="涼風工匠" lineNotify={{ ...ln, ...over }} />,
    );
    expect(screen.queryByTestId("member-home-add-friend")).toBeNull();
  });
});

describe("C5-M02 ⑪-1「LINE 通知」區塊", () => {
  const ok = (over: Record<string, unknown> = {}) => ({
    state: "ok",
    available: true,
    notify_booking: true,
    notify_promo: true,
    friend_status: "unknown",
    add_friend_url: URL_OK,
    ...over,
  });

  it("店家不能用 LINE 通知 ⇒ 整塊不顯示", async () => {
    state.prefs = ok({ available: false });
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={() => undefined} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId("member-line-notify")).toBeNull();
    expect(document.body.textContent).not.toContain("LINE 通知");
  });

  it("主要 / 第二聯絡人都一樣:「預約通知」「優惠通知」兩個開關(5-B);不確定 ⇒ 沒有黃色 !", async () => {
    state.prefs = ok({ notify_promo: false });
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={() => undefined} />);
    const section = await screen.findByTestId("member-line-notify");
    expect(section).toHaveTextContent("LINE 通知");
    expect(section).toHaveTextContent("預約通知");
    expect(section).toHaveTextContent("預約成立、確認、改時間、取消等通知，以及聯絡人申請。");
    expect(section).toHaveTextContent("優惠通知");
    expect(section).toHaveTextContent("店家的優惠活動與生日禮通知。");
    expect(within(section).getAllByRole("switch")).toHaveLength(2);
    expect(within(section).getByRole("switch", { name: "預約通知" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(section).getByRole("switch", { name: "優惠通知" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.queryByTestId("member-line-notify-not-friend")).toBeNull();
  });

  it("切「優惠通知」⇒ 只送 notifyPromo;「預約通知」不受影響", async () => {
    state.prefs = ok();
    state.setResult = ok({ notify_promo: false });
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={() => undefined} />);
    const section = await screen.findByTestId("member-line-notify");
    const promo = within(section).getByRole("switch", { name: "優惠通知" });
    await userEvent.click(promo);
    await waitFor(() => expect(promo).toHaveAttribute("aria-checked", "false"));
    expect(state.setCalls).toEqual([{ notifyPromo: false }]);
    expect(within(section).getByRole("switch", { name: "預約通知" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("確定沒加好友 ⇒ 常駐黃色 ! + 加入好友連結", async () => {
    state.prefs = ok({ friend_status: "not_friend" });
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={() => undefined} />);
    const note = await screen.findByTestId("member-line-notify-not-friend");
    expect(note).toHaveTextContent("你還沒有加入店家的 LINE 好友，開著也收不到通知。");
    expect(within(note).getByRole("link", { name: "加入好友" })).toHaveAttribute("href", URL_OK);
  });

  it("切換成功 ⇒ 只送自己改的那個開關(另一個 null)、畫面用伺服器回的值", async () => {
    state.prefs = ok();
    state.setResult = ok({ notify_booking: false });
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={() => undefined} />);
    const sw = within(await screen.findByTestId("member-line-notify")).getByRole("switch", {
      name: "預約通知",
    });
    await userEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(state.setCalls).toEqual([{ notifyBooking: false }]);
    expect(sw).not.toBeDisabled();
    expect(state.toasts).toEqual([]);
  });

  it("切換失敗 ⇒ 退回原狀態 + toast「儲存失敗，請稍後再試」", async () => {
    state.prefs = ok();
    state.setError = true;
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={() => undefined} />);
    const sw = within(await screen.findByTestId("member-line-notify")).getByRole("switch", {
      name: "預約通知",
    });
    await userEvent.click(sw);
    await waitFor(() => expect(state.toasts).toEqual(["儲存失敗，請稍後再試"]));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("登入失效(not_linked)⇒ 交給外框登出", async () => {
    state.prefs = { state: "not_linked" };
    const lost = vi.fn();
    // parseMemberNotifyPrefs 對 not_linked 回 null;真的 API 會回 gate ⇒ 這裡直接模擬 gate。
    const api = await import("./lineNotifyApi");
    vi.mocked(api.fetchMyNotifyPrefs).mockResolvedValueOnce({ state: "not_linked" });
    wrap(<MemberLineNotifySection slug="demo" onSessionLost={lost} />);
    await waitFor(() => expect(lost).toHaveBeenCalled());
    expect(screen.queryByTestId("member-line-notify")).toBeNull();
  });
});
