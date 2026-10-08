// 客戶端第 2 批(C2-A05 / C2-F01):LINE 登入設定卡元件測試(資料庫函式用假的頂著)。

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "SENTINELSECRET0123456789abcdef01";

const state = vi.hoisted(() => ({
  status: null as unknown,
  saveCalls: [] as unknown[][],
  enableCalls: [] as unknown[][],
  deleteCalls: 0,
}));

vi.mock("./lineLoginApi", async () => {
  const actual = await vi.importActual<typeof import("./lineLoginApi")>("./lineLoginApi");
  const { useQuery } = await import("@tanstack/react-query");
  return {
    ...actual,
    fetchMerchantLineLoginStatus: vi.fn(async () => state.status),
    useMerchantLineLoginStatus: (merchantId: string) => {
      return useQuery({
        queryKey: actual.lineLoginStatusQueryKey(merchantId),
        queryFn: async () => state.status,
      });
    },
    setMerchantLineLoginConfig: vi.fn(async (...args: unknown[]) => {
      state.saveCalls.push(args);
      state.status = {
        configured: true,
        channelId: String(args[1]),
        channelSecretMasked: "••••ef01",
        enabled: false,
        lastLoginSucceededAt: null,
        linkedOaStatus: null,
        callbackUrl: "https://miao-yue-dispatch.vercel.app/auth/line/callback",
      };
    }),
    setMerchantLineLoginEnabled: vi.fn(async (...args: unknown[]) => {
      state.enableCalls.push(args);
    }),
    deleteMerchantLineLoginConfig: vi.fn(async () => {
      state.deleteCalls += 1;
    }),
  };
});

const { LineLoginSettingsCard } = await import("./LineLoginSettingsCard");

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LineLoginSettingsCard merchantId="m1" />
    </QueryClientProvider>,
  );
}

const EMPTY = {
  configured: false,
  channelId: null,
  channelSecretMasked: null,
  enabled: false,
  lastLoginSucceededAt: null,
  linkedOaStatus: null,
  callbackUrl: "https://miao-yue-dispatch.vercel.app/auth/line/callback",
};

beforeEach(() => {
  state.status = EMPTY;
  state.saveCalls = [];
  state.enableCalls = [];
  state.deleteCalls = 0;
});
afterEach(() => cleanup());

describe("C2-A05 LINE 登入設定卡", () => {
  it("尚未設定:狀態、Callback URL、開關停用 + 原因;沒填 secret 擋下", async () => {
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByTestId("line-login-status")).toHaveTextContent("尚未設定");
    expect(screen.getByTestId("line-login-callback-url")).toHaveValue(
      "https://miao-yue-dispatch.vercel.app/auth/line/callback",
    );
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.getByTestId("line-login-enable-blocked")).toHaveTextContent(
      "請先儲存 Channel ID 與 Channel Secret，才能啟用。",
    );
    expect(screen.queryByTestId("line-login-delete")).toBeNull();
    await user.type(screen.getByTestId("line-login-channel-id"), "1234567890");
    await user.click(screen.getByTestId("line-login-save"));
    expect(screen.getByText("請填 Channel Secret。")).toBeInTheDocument();
    expect(state.saveCalls).toEqual([]);
  });

  it("C2-F01:存完 secret 輸入框清空,畫面只剩遮罩,DOM 搜不到 secret 原文", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.type(await screen.findByTestId("line-login-channel-id"), "1234567890");
    await user.type(screen.getByTestId("line-login-channel-secret"), SECRET);
    await user.click(screen.getByTestId("line-login-save"));
    await waitFor(() => expect(state.saveCalls).toEqual([["m1", "1234567890", SECRET]]));
    expect(await screen.findByTestId("line-login-secret-masked")).toHaveTextContent("••••ef01");
    expect(screen.getByTestId("line-login-status")).toHaveTextContent("已設定，尚未啟用");
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const input of Array.from(document.querySelectorAll("input"))) {
      expect(input.value).not.toContain(SECRET);
    }
  });

  it("已設定:只改 Channel ID 不重送 secret;重新輸入才出現輸入框", async () => {
    state.status = {
      ...EMPTY,
      configured: true,
      channelId: "1234567890",
      channelSecretMasked: "••••ab12",
    };
    const user = userEvent.setup();
    renderCard();
    const id = await screen.findByTestId("line-login-channel-id");
    await waitFor(() => expect(id).toHaveValue("1234567890"));
    await user.clear(id);
    await user.type(id, "2234567890");
    await user.click(screen.getByTestId("line-login-save"));
    await waitFor(() => expect(state.saveCalls).toEqual([["m1", "2234567890", ""]]));
    await user.click(screen.getByTestId("line-login-secret-reenter"));
    expect(screen.getByTestId("line-login-channel-secret")).toHaveAttribute("type", "password");
  });

  it("已啟用但沒人成功登入過、沒連結官方帳號 ⇒ 兩條常駐黃色提示;刪除要確認", async () => {
    state.status = {
      ...EMPTY,
      configured: true,
      channelId: "1234567890",
      channelSecretMasked: "••••ab12",
      enabled: true,
      linkedOaStatus: "not_linked",
    };
    const user = userEvent.setup();
    renderCard();
    expect(await screen.findByTestId("line-login-never-succeeded")).toHaveTextContent(
      "還沒有人成功用 LINE 登入過",
    );
    expect(screen.getByTestId("line-login-oa-not-linked")).toHaveTextContent(
      "客人登入後收不到 LINE 通知",
    );
    expect(screen.getByTestId("line-login-status")).toHaveTextContent("已啟用");
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(state.enableCalls).toEqual([["m1", false]]));

    await user.click(screen.getByTestId("line-login-delete"));
    await user.click(await screen.findByRole("button", { name: "確定刪除" }));
    await waitFor(() => expect(state.deleteCalls).toBe(1));
  });

  it("設定步驟說明:點了才展開", async () => {
    const user = userEvent.setup();
    renderCard();
    await screen.findByTestId("line-login-status");
    expect(screen.queryByTestId("line-login-steps")).toBeNull();
    await user.click(screen.getByTestId("line-login-steps-toggle"));
    expect(screen.getByTestId("line-login-steps")).toHaveTextContent("同一個 Provider");
  });
});
